import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { runnerStep, type MailboxRunnerOptions } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import {
  attachArtifacts,
  writeDecision,
  writeInstruction,
  writeVerdict,
  type RoundArtifact,
  type RoundResultFile,
} from "./store.ts"
import { commitPush } from "./sync.ts"
import { fakeGrade, fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

async function fixture(jobOverrides: Record<string, unknown> = {}) {
  const target = await makeTargetRepo(temp)
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(jobOverrides))
  const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  expect(initialized.initialized).toBe(true)
  return { target, mailbox, mailboxJob }
}

/** 站在研发端下发一轮(init 不再写第一轮指令了 —— 那是研发端的活)。 */
async function issue(
  mailbox: { motherClone: string },
  round: number,
  prompt: string,
  artifacts?: RoundArtifact[],
): Promise<void> {
  await writeInstruction(mailbox.motherClone, {
    round,
    prompt,
    issuedBy: "mother",
    artifacts,
    at: new Date().toISOString(),
  })
  await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, `下发第 ${round} 轮`)
}

function options(
  clone: string,
  projectDir: string,
  overrides: Partial<MailboxRunnerOptions> = {},
): MailboxRunnerOptions {
  return {
    clone,
    // 工程目录是**本机配置**,不来自信箱里的任务书 —— 机器无关的支点。
    projectDir,
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => fakeTurn(),
    grade: async () => ({ passed: false, rounds: [fakeGrade(false)] }),
    ...overrides,
  }
}

describe("mailbox runner", () => {
  test("领第 1 轮指令 → 跑完 → 结果回填到远端;工位端不开分支不提交", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "先复现:上电看日志")
    const prompts: string[] = []

    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          expect(input.role).toBe("bench")
          return fakeTurn({ usage: usage(200, 100) })
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    // 会话首轮带角色说明,而且说清了"不改源码"。
    expect(prompts[0]).toContain("你是这个调试闭环的工位端")
    expect(prompts[0]).toContain("不改源码")
    expect(prompts[0]).toContain("先复现:上电看日志")
    expect(prompts[0]).not.toContain("上一轮判据结果")

    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.round).toBe(1)
    expect(result.grade?.passed).toBe(false)
    expect(result.spentTokens).toBe(300)
    expect(result.workspace?.dirty).toEqual([])

    // 工位端是纯粹的被测环境:不开 agent 分支、不提交。
    expect((await runGitReal(["rev-parse", "--abbrev-ref", "HEAD"], target)).stdout).toBe("main")
    expect((await runGitReal(["log", "--oneline"], target)).stdout.split("\n").length).toBe(1)

    const state = (await Bun.file(path.join(target, ".bench", "mailbox", "m-1", "state.json")).json()) as {
      sessionID: string
      spentTokens: number
    }
    expect(state.sessionID).toBe("ses-1")
    expect(state.spentTokens).toBe(300)
  })

  test("附件穿过信箱:落到 .bench/incoming/,路径写进提示词与 result", async () => {
    const { target, mailbox } = await fixture()
    // 研发端把构建产物塞进本轮目录(它那边由 attachArtifacts 做,这里直接复用)。
    const devBuild = temp.dir("dev-build-")
    writeFileSync(path.join(devBuild, "fw.elf"), "NEW-ELF")
    const attached = await attachArtifacts(
      mailbox.motherClone,
      1,
      [{ source: path.join(devBuild, "fw.elf"), name: "fw.elf", from: "build/fw.elf" }],
      1024 * 1024,
    )
    expect(attached.ok).toBe(true)
    await issue(mailbox, 1, "新固件在附件里,弄上板然后复现", attached.ok ? attached.artifacts : undefined)

    const prompts: string[] = []
    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    // 文件真的躺在工作区里,而且提示词里给的是那条路径。
    expect(await Bun.file(path.join(target, ".bench", "incoming", "fw.elf")).text()).toBe("NEW-ELF")
    expect(prompts[0]).toContain(".bench/incoming/fw.elf")
    // 怎么上板不由协议规定 —— 提示词只说"怎么用由你判断"。
    expect(prompts[0]).toContain("怎么用由你判断")

    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.incoming).toEqual([".bench/incoming/fw.elf"])

    // 附件落在 .bench 下,被 .bench/.gitignore 挡住 —— 不该弄脏被测仓库。
    expect((await runGitReal(["status", "--porcelain"], target)).stdout).toBe("")
  })

  test("结果已回填(等研发端)时空转,不重复跑", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    let turns = 0
    const opts = options(mailbox.runnerClone, target, {
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

  test("kickoff(零轮次)时空转 —— 第一轮归研发端出", async () => {
    const { target, mailbox } = await fixture()
    const outcome = await runnerStep(options(mailbox.runnerClone, target))
    expect(outcome.kind).toBe("idle")
    if (outcome.kind === "idle") expect(outcome.detail).toContain("研发端")
  })

  test("第 2 轮的提示词 = 研发端指令 + 上一轮判据证据,角色说明不重复", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const prompts: string[] = []
    const opts = options(mailbox.runnerClone, target, {
      runTurn: async (input: TurnInput) => {
        prompts.push(input.prompt)
        return fakeTurn()
      },
    })
    await runnerStep(opts)

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "验证假设:中断里丢了 ORE 清理")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(prompts[1]).toContain("验证假设:中断里丢了 ORE 清理")
    expect(prompts[1]).toContain("上一轮判据结果")
    expect(prompts[1]).toContain("assertion failed at main.c:42")
    // 会话延续,角色说明只在首轮说一次。
    expect(prompts[1]).not.toContain("你是这个调试闭环的工位端")
  })

  test("工位端改了源码:如实回填成证据,不静默吞掉", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
        runTurn: async () => {
          // 策略会拒 edit/write,但 bash 里 sed -i 这类路子挡不干净 —— 所以要留证据。
          writeFileSync(path.join(target, "main.c"), "int main(void){return 1;}\n")
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("ran")
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.workspace?.dirty).toEqual(["main.c"])
  })

  test("开轮前工作树就不干净:拒绝开轮,不烧模型 token", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    writeFileSync(path.join(target, "main.c"), "int main(void){return 2;}\n")
    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
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
    expect(result.error).toContain("工作树不干净")
  })

  test("本机没配工程目录:报人话,而不是在 undefined 目录里失败", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const outcome = await runnerStep({ ...options(mailbox.runnerClone, ""), projectDir: undefined })
    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") expect(outcome.detail).toContain("工程目录")
  })

  test("verdict 出现 → 收尾:失败时回刷 known-good,且只收尾一次", async () => {
    const { target, mailbox } = await fixture({
      bench: { chip: "STM32G431KB", knownGoodElf: "good.elf" },
    })
    writeFileSync(path.join(target, "good.elf"), "elf")
    await runGitReal(["add", "-A"], target)
    await runGitReal(["commit", "-q", "-m", "elf"], target)
    await issue(mailbox, 1, "复现")

    const restores: string[] = []
    const opts = options(mailbox.runnerClone, target, {
      runCommand: async (command) => {
        restores.push(command)
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
    })
    await runnerStep(opts) // 第 1 轮
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "policy",
      decision: "fail",
      at: new Date(0).toISOString(),
    })
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

  test("工位自检失败:不烧模型 token,error 直接回填", async () => {
    const { target, mailbox } = await fixture({ bench: { chip: "STM32G431KB", knownGoodElf: "不存在.elf" } })
    await issue(mailbox, 1, "复现")
    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
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
    await issue(mailbox, 1, "复现")
    mkdirSync(path.join(target, ".bench", "mailbox", "m-1"), { recursive: true })
    writeFileSync(path.join(target, ".bench", "mailbox", "m-1", "state.json"), JSON.stringify({ spentTokens: 100_000 }))
    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, target, {
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
    const outcome = await runnerStep(options(mailbox.runnerClone, temp.dir("ws-")))
    expect(outcome.kind).toBe("idle")
  })

  test("本地 state 丢了从信箱回垫:token 计数不归零", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const opts = options(mailbox.runnerClone, target, {
      runTurn: async () => fakeTurn({ usage: usage(200, 100) }),
    })
    await runnerStep(opts) // 轮 1:spentTokens=300

    // 模拟清理 .bench / 换工位机:本地 state 蒸发。
    await Bun.write(path.join(target, ".bench", "mailbox", "m-1", "state.json"), "{}")

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    await runnerStep(opts) // 轮 2:回垫后 300 + 300
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.spentTokens).toBe(600)
  })

  test("预算按两侧合计:研发端花掉的部分会让工位拒绝开轮", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    let turns = 0
    const opts = options(mailbox.runnerClone, target, {
      runTurn: async () => {
        turns += 1
        return fakeTurn({ usage: usage(40_000, 10_000) }) // 轮 1 花 5 万
      },
    })
    await runnerStep(opts)

    // 研发端的分析烧掉 6 万(记在 decision.usage),两侧合计 11 万 > 10 万预算。
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      usage: usage(50_000, 10_000),
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(1) // 轮 2 没真跑
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("研发端")
  })

  test("会话丢失可自愈:重开会话再试一次,而不是把闭环打成 park", async () => {
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const sessionIDs: (string | undefined)[] = []
    const prompts: string[] = []
    const opts = options(mailbox.runnerClone, target, {
      runTurn: async (input: TurnInput) => {
        sessionIDs.push(input.sessionID)
        prompts.push(input.prompt)
        if (input.sessionID) throw new Error("子进程没有产出结果(退出码 1)")
        return fakeTurn()
      },
    })
    await runnerStep(opts) // 轮 1:无 sessionID,正常

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    const outcome = await runnerStep(opts) // 轮 2:带旧 sessionID 失败 → 重开会话成功
    expect(outcome.kind).toBe("ran")
    expect(sessionIDs).toEqual([undefined, "ses-1", undefined])
    // 会话重开 = 新会话,角色说明必须重新带上,否则它不知道自己是工位端。
    expect(prompts[2]).toContain("你是这个调试闭环的工位端")
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toBeUndefined()
  })

  test("finalize 副作用失败不闩死:回刷失败报 blocked,修好后重试成功", async () => {
    const { target, mailbox } = await fixture({ bench: { chip: "STM32G431KB", knownGoodElf: "good.elf" } })
    writeFileSync(path.join(target, "good.elf"), "elf")
    await runGitReal(["add", "-A"], target)
    await runGitReal(["commit", "-q", "-m", "elf"], target)
    await issue(mailbox, 1, "复现")

    let restoreOk = false
    const opts = options(mailbox.runnerClone, target, {
      runCommand: async () => ({ exitCode: restoreOk ? 0 : 1, stdout: "", stderr: "探针抖了", timedOut: false }),
    })
    await runnerStep(opts) // 轮 1
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "policy",
      decision: "fail",
      at: new Date(0).toISOString(),
    })
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

describe("mailbox runner · 安全约束", () => {
  test("总任务书(含工位安全红线)必须到达工位端 —— 它不再从别处得到这些约束", async () => {
    const { target, mailbox } = await fixture({ task: "绝不能让电机转动:不发任何 CLI 命令。" })
    await issue(mailbox, 1, "上电看日志")
    const prompts: string[] = []
    await runnerStep(
      options(mailbox.runnerClone, target, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return fakeTurn()
        },
      }),
    )
    expect(prompts[0]).toContain("绝不能让电机转动")
  })
})

describe("分支不一致:必须在动板子之前就停", () => {
  test("停在 main 的克隆 + branch run-1 —— 不跑模型、不动硬件,直接 blocked", async () => {
    // 这是最危险的一种配错:`pullReset` 在 origin/run-1 还不存在时什么都不做(那是
    // 首推前的合法状态),于是工作树仍是 main 的内容 —— 扫描器读到的是**另一个任务**
    // 的 job.json 和待执行轮。没有闸门的话工位端会真的烧片、跑判据、回刷 known-good,
    // 跑完一整轮才在 push 那一下报 `src refspec run-1 does not match any`。
    const { target, mailbox } = await fixture()
    await issue(mailbox, 1, "别的任务的指令:把电机跑到 3000rpm")

    // 工位机手工 git clone —— 停在 main。
    const clone = await freshClone(temp, mailbox.bare)
    expect((await runGitReal(["branch", "--show-current"], clone)).stdout).toBe("main")

    const prompts: string[] = []
    const hardware: string[] = []
    const outcome = await runnerStep({
      clone,
      branch: "run-1",
      projectDir: target,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async (input: TurnInput) => {
        prompts.push(input.prompt)
        return fakeTurn()
      },
      grade: async () => ({ passed: false, rounds: [fakeGrade(false)] }),
      runCommand: async (command: string) => {
        hardware.push(command)
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
    } as MailboxRunnerOptions)

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") {
      expect(outcome.detail).toContain("停在分支 main")
      expect(outcome.detail).toContain("run-1")
    }
    // 闸门的意义全在这两条上:模型没被调用,板子没被碰。
    expect(prompts).toEqual([])
    expect(hardware).toEqual([])
  })
})
