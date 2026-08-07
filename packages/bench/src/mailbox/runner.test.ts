import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { runnerStep, type MailboxRunnerOptions } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { writeDecision, writeVerdict, type RoundResultFile } from "./store.ts"
import { commitPush } from "./sync.ts"
import { fakeGrade, fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

async function fixture(jobOverrides: Record<string, unknown> = {}) {
  const target = await makeTargetRepo(temp)
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(target, jobOverrides))
  const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  expect(initialized.initialized).toBe(true)
  return { target, mailbox, mailboxJob }
}

function options(clone: string, overrides: Partial<MailboxRunnerOptions> = {}): MailboxRunnerOptions {
  return {
    clone,
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => fakeTurn(),
    grade: async () => ({ passed: false, rounds: [fakeGrade(false)] }),
    ...overrides,
  }
}

describe("mailbox runner", () => {
  test("领第 1 轮指令 → 跑完 → 结果与补丁回填到远端", async () => {
    const { target, mailbox } = await fixture()
    const prompts: string[] = []

    const outcome = await runnerStep(
      options(mailbox.runnerClone, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          // 模拟 agent 改了一处代码 —— 提交与补丁采集要能看见它。
          writeFileSync(path.join(target, "fix.c"), "int fixed = 1;\n")
          return fakeTurn({ usage: usage(200, 100) })
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    // 第 1 轮指令是复现纪律,不带"上一轮判据"。
    expect(prompts[0]).toContain("只做一件事:复现")
    expect(prompts[0]).not.toContain("上一轮判据结果")

    // 远端真相:result + patch 都在,git 事实齐全。
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.round).toBe(1)
    expect(result.grade?.passed).toBe(false)
    expect(result.spentTokens).toBe(300)
    expect(result.git?.changedFiles.join()).toContain("fix.c")
    expect(await Bun.file(path.join(verify, "rounds", "001", "patch.diff")).text()).toContain("fix.c")

    // 目标仓:在 agent 分支上,改动已提交。
    expect((await runGitReal(["rev-parse", "--abbrev-ref", "HEAD"], target)).stdout).toBe("agent/m-1")
    expect((await runGitReal(["status", "--porcelain"], target)).stdout).toBe("")

    // 本地状态:会话与花费落盘,下一轮延续。
    const state = (await Bun.file(path.join(target, ".bench", "mailbox", "m-1", "state.json")).json()) as {
      sessionID: string
      spentTokens: number
    }
    expect(state.sessionID).toBe("ses-1")
    expect(state.spentTokens).toBe(300)
  })

  test("结果已回填(等母 agent)时空转,不重复跑", async () => {
    const { mailbox } = await fixture()
    let turns = 0
    const opts = options(mailbox.runnerClone, {
      runTurn: async () => {
        turns += 1
        return fakeTurn()
      },
    })
    await runnerStep(opts)
    const second = await runnerStep(opts)
    expect(second.kind).toBe("idle")
    expect(turns).toBe(1)
  })

  test("第 2 轮的提示词 = 母 agent 指令 + 上一轮判据证据", async () => {
    const { mailbox } = await fixture()
    const prompts: string[] = []
    const opts = options(mailbox.runnerClone, {
      runTurn: async (input: TurnInput) => {
        prompts.push(input.prompt)
        return fakeTurn()
      },
    })
    await runnerStep(opts)

    // 模拟母 agent:裁决 continue 并下发第 2 轮。
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    const { writeInstruction } = await import("./store.ts")
    await writeInstruction(mailbox.motherClone, {
      round: 2,
      prompt: "验证假设:中断里丢了 ORE 清理",
      issuedBy: "mother",
      at: new Date(0).toISOString(),
    })
    await commitPush(
      { clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } },
      "round 1: continue → 下发第 2 轮",
    )

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(prompts[1]).toContain("验证假设:中断里丢了 ORE 清理")
    expect(prompts[1]).toContain("上一轮判据结果")
    expect(prompts[1]).toContain("assertion failed at main.c:42")
  })

  test("verdict 出现 → 收尾:失败时回刷 known-good,且只收尾一次", async () => {
    const { target, mailbox } = await fixture({
      bench: { chip: "STM32G431KB", knownGoodElf: "good.elf" },
    })
    writeFileSync(path.join(target, "good.elf"), "elf")
    await runGitReal(["add", "-A"], target)
    await runGitReal(["commit", "-q", "-m", "elf"], target)

    const restores: string[] = []
    const opts = options(mailbox.runnerClone, {
      runCommand: async (command) => {
        restores.push(command)
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
    })
    await runnerStep(opts) // 第 1 轮
    await writeDecision(mailbox.motherClone, { round: 1, by: "policy", decision: "fail", at: new Date(0).toISOString() })
    await writeVerdict(mailbox.motherClone, {
      outcome: "failed",
      reason: "测试终局",
      rounds: 1,
      totalRunnerTokens: 150,
      totalMotherTokens: 0,
      decidedBy: "policy",
      at: new Date(0).toISOString(),
    })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "verdict")

    const finalized = await runnerStep(opts)
    expect(finalized.kind).toBe("finalized")
    expect(restores.length).toBe(1)
    expect(restores[0]).toContain("probe-rs")
    expect(restores[0]).toContain("good.elf")

    const again = await runnerStep(opts)
    expect(again.kind).toBe("finalized")
    expect(restores.length).toBe(1) // 不重复回刷
  })

  test("首轮工位自检失败:不烧模型 token,error 直接回填", async () => {
    const { mailbox } = await fixture({ bench: { chip: "STM32G431KB", knownGoodElf: "不存在.elf" } })
    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, {
        runTurn: async () => {
          turns += 1
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(0)
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("known-good")
  })

  test("token 预算已耗尽:拒绝开轮,error 回填", async () => {
    const { target, mailbox } = await fixture()
    mkdirSync(path.join(target, ".bench", "mailbox", "m-1"), { recursive: true })
    writeFileSync(
      path.join(target, ".bench", "mailbox", "m-1", "state.json"),
      JSON.stringify({ spentTokens: 100_000, baseCommit: "x".repeat(40) }),
    )
    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, {
        runTurn: async () => {
          turns += 1
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(0)
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("预算")
  })

  test("信箱空着(还没 init)就空转", async () => {
    const mailbox = await makeMailbox(temp)
    const outcome = await runnerStep(options(mailbox.runnerClone))
    expect(outcome.kind).toBe("idle")
  })

  test("本地 state 丢了从信箱回垫:token 计数不归零、基线不漂移", async () => {
    const { target, mailbox } = await fixture()
    const opts = options(mailbox.runnerClone, {
      runTurn: async () => fakeTurn({ usage: usage(200, 100) }),
    })
    await runnerStep(opts) // 轮 1:spentTokens=300

    // 模拟清理 .bench / 换工位机:本地 state 蒸发。
    const stateFile = path.join(target, ".bench", "mailbox", "m-1", "state.json")
    const before = (await Bun.file(stateFile).json()) as { baseCommit: string }
    await Bun.write(stateFile, "{}")

    // mother 下发轮 2。
    await writeDecision(mailbox.motherClone, { round: 1, by: "mother", decision: "continue", at: new Date(0).toISOString() })
    const { writeInstruction } = await import("./store.ts")
    await writeInstruction(mailbox.motherClone, { round: 2, prompt: "继续", issuedBy: "mother", at: new Date(0).toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "轮 2")

    await runnerStep(opts) // 轮 2:回垫后 300 + 300
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.spentTokens).toBe(600)
    expect(result.git?.baseCommit).toBe(before.baseCommit)
  })

  test("预算按两侧合计:mother 花掉的部分会让工位拒绝开轮", async () => {
    const { mailbox } = await fixture()
    let turns = 0
    const opts = options(mailbox.runnerClone, {
      runTurn: async () => {
        turns += 1
        return fakeTurn({ usage: usage(40_000, 10_000) }) // 轮 1 花 5 万
      },
    })
    await runnerStep(opts)

    // mother 的分析烧掉 6 万(记在 decision.usage),两侧合计 11 万 > 10 万预算。
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      usage: usage(50_000, 10_000),
      at: new Date(0).toISOString(),
    })
    const { writeInstruction } = await import("./store.ts")
    await writeInstruction(mailbox.motherClone, { round: 2, prompt: "继续", issuedBy: "mother", at: new Date(0).toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "轮 2")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(1) // 轮 2 没真跑
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("母 agent")
  })

  test("换机续跑防线:目标仓没带 agent 分支历史时拒绝开轮,不静默从 main 重建", async () => {
    const { target, mailbox } = await fixture()
    const opts = options(mailbox.runnerClone, {
      runTurn: async () => {
        writeFileSync(path.join(target, "fix.c"), "int fixed = 1;\n")
        return fakeTurn()
      },
    })
    await runnerStep(opts) // 轮 1 提交了 fix.c

    await writeDecision(mailbox.motherClone, { round: 1, by: "mother", decision: "continue", at: new Date(0).toISOString() })
    const { writeInstruction } = await import("./store.ts")
    await writeInstruction(mailbox.motherClone, { round: 2, prompt: "继续", issuedBy: "mother", at: new Date(0).toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "轮 2")

    // 模拟换到一台没有 agent 分支历史的工位机:删分支、彻底清掉对象,再丢本地 state。
    await runGitReal(["checkout", "-q", "main"], target)
    await runGitReal(["branch", "-D", "agent/m-1"], target)
    await runGitReal(["reflog", "expire", "--expire=now", "--all"], target)
    await runGitReal(["gc", "--prune=now", "--quiet"], target)
    const { rmSync } = await import("node:fs")
    rmSync(path.join(target, ".bench", "mailbox"), { recursive: true, force: true })

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("同步")
  })

  test("会话丢失可自愈:重开会话再试一次,而不是把闭环打成 park", async () => {
    const { mailbox } = await fixture()
    const sessionIDs: (string | undefined)[] = []
    const opts = options(mailbox.runnerClone, {
      runTurn: async (input: TurnInput) => {
        sessionIDs.push(input.sessionID)
        if (input.sessionID) throw new Error("子进程没有产出结果(退出码 1)")
        return fakeTurn()
      },
    })
    await runnerStep(opts) // 轮 1:无 sessionID,正常

    await writeDecision(mailbox.motherClone, { round: 1, by: "mother", decision: "continue", at: new Date(0).toISOString() })
    const { writeInstruction } = await import("./store.ts")
    await writeInstruction(mailbox.motherClone, { round: 2, prompt: "继续", issuedBy: "mother", at: new Date(0).toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "轮 2")

    const outcome = await runnerStep(opts) // 轮 2:带旧 sessionID 失败 → 重开会话成功
    expect(outcome.kind).toBe("ran")
    expect(sessionIDs).toEqual([undefined, "ses-1", undefined])
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toBeUndefined()
  })

  test("目标仓 commit 坏掉时如实标轮级失败,不让证据链静默退化", async () => {
    const { target, mailbox } = await fixture()
    const { runGitReal: real } = await import("../git.ts")
    const opts = options(mailbox.runnerClone, {
      runTurn: async () => {
        writeFileSync(path.join(target, "fix.c"), "int fixed = 1;\n")
        return fakeTurn()
      },
      // 只坏目标仓的 commit(工位机 gpgsign/钩子问题的形态);信箱同步照常。
      gitRun: (args, cwd) =>
        cwd === target && args.includes("commit")
          ? Promise.resolve({ ok: false, stdout: "", stderr: "gpg: signing failed" })
          : real(args, cwd),
    })
    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("提交失败")
    expect(result.turn).toBeDefined() // 证据仍附上,给人看
    expect(result.grade).toBeDefined()
  })

  test("finalize 副作用失败不闩死:回刷失败报 blocked,修好后重试成功", async () => {
    const { target, mailbox } = await fixture({ bench: { chip: "STM32G431KB", knownGoodElf: "good.elf" } })
    writeFileSync(path.join(target, "good.elf"), "elf")
    await runGitReal(["add", "-A"], target)
    await runGitReal(["commit", "-q", "-m", "elf"], target)

    let restoreOk = false
    const opts = options(mailbox.runnerClone, {
      runCommand: async () => ({ exitCode: restoreOk ? 0 : 1, stdout: "", stderr: "探针抖了", timedOut: false }),
    })
    await runnerStep(opts) // 轮 1
    await writeDecision(mailbox.motherClone, { round: 1, by: "policy", decision: "fail", at: new Date(0).toISOString() })
    await writeVerdict(mailbox.motherClone, {
      outcome: "failed",
      reason: "测试终局",
      rounds: 1,
      totalRunnerTokens: 150,
      totalMotherTokens: 0,
      decidedBy: "policy",
      at: new Date(0).toISOString(),
    })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "verdict")

    const failed = await runnerStep(opts)
    expect(failed.kind).toBe("blocked")
    if (failed.kind === "blocked") expect(failed.detail).toContain("回刷")

    restoreOk = true
    const finalized = await runnerStep(opts)
    expect(finalized.kind).toBe("finalized")

    // 收尾审计要留在信箱里,不能只活在一闪而过的 stderr 上。
    const verify = await freshClone(temp, mailbox.bare)
    const record = (await Bun.file(path.join(verify, "finalize.json")).json()) as { restored?: boolean }
    expect(record.restored).toBe(true)
  })
})
