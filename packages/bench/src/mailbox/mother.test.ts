import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnOptions } from "../turn.ts"
import { initMailbox } from "./init.ts"
import { motherStep, parseMotherDecision, type MailboxMotherOptions } from "./mother.ts"
import { runnerStep } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { scanMailbox, writeInstruction, type RoundDecision, type RoundInstruction } from "./store.ts"
import { commitPush } from "./sync.ts"
import { fakeGrade, fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

describe("parseMotherDecision", () => {
  test("只认最后一个 json 围栏", () => {
    const text = '示例:\n```json\n{"decision":"fail","reason":"示例"}\n```\n正式决定:\n```json\n{"decision":"continue","instruction":"改 A 处"}\n```'
    const parsed = parseMotherDecision(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.payload.decision).toBe("continue")
  })

  test("success 被明确拒绝 —— 判据不归模型管", () => {
    const parsed = parseMotherDecision('```json\n{"decision":"success"}\n```')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("判据")
  })

  test("continue 没有 instruction、fail 没有 reason 都不合法", () => {
    expect(parseMotherDecision('```json\n{"decision":"continue"}\n```').ok).toBe(false)
    expect(parseMotherDecision('```json\n{"decision":"fail"}\n```').ok).toBe(false)
    expect(parseMotherDecision('```json\n{"decision":"park","reason":"要人看"}\n```').ok).toBe(true)
  })

  test("没有围栏、不是 JSON、不是对象,报错各说各的", () => {
    expect(parseMotherDecision("我觉得应该继续").ok).toBe(false)
    expect(parseMotherDecision("```json\n{断掉的\n```").ok).toBe(false)
    expect(parseMotherDecision('```json\n["continue"]\n```').ok).toBe(false)
  })

  test("artifacts 收下字符串数组,形状不对就明确报错", () => {
    const good = parseMotherDecision('```json\n{"decision":"continue","instruction":"烧","artifacts":["build/fw.elf"]}\n```')
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.payload.artifacts).toEqual(["build/fw.elf"])

    const bad = parseMotherDecision('```json\n{"decision":"continue","instruction":"烧","artifacts":"build/fw.elf"}\n```')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("artifacts")
  })
})

/** 布景:init + 第 1 轮指令已下发 + 工位端跑完第 1 轮,留下 awaiting-mother 的信箱。 */
async function fixtureAfterRound(overrides: {
  job?: Record<string, unknown>
  grade?: ReturnType<typeof fakeGrade>
  turn?: ReturnType<typeof fakeTurn>
}) {
  const target = await makeTargetRepo(temp)
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(overrides.job ?? {}))
  await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  // 第 1 轮指令本该由研发端 kickoff 出;这些用例要测的是"拿到结果之后",直接摆好布景。
  await writeInstruction(mailbox.motherClone, {
    round: 1,
    prompt: "先复现取证",
    issuedBy: "mother",
    // 真实时间:墙钟守卫从第 1 轮指令算起,写成 1970 会让每个用例开局就"墙钟耗尽"。
    at: new Date().toISOString(),
  })
  await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "第 1 轮")

  const ran = await runnerStep({
    clone: mailbox.runnerClone,
    projectDir: target,
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => overrides.turn ?? fakeTurn(),
    grade: async () => {
      const grade = overrides.grade ?? fakeGrade(false)
      return { passed: grade.passed, rounds: [grade] }
    },
  })
  expect(ran.kind).toBe("ran")
  return { target, mailbox, mailboxJob }
}

function motherOptions(
  clone: string,
  projectDir: string,
  overrides: Partial<MailboxMotherOptions> = {},
): MailboxMotherOptions {
  return { clone, projectDir, sessionsRoot: temp.dir("sessions-"), ...overrides }
}

describe("mailbox mother · 开局", () => {
  test("零轮次时研发端出第一轮:可以先改代码、附上产物,指令与附件同一次提交", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    await initMailbox({ clone: mailbox.motherClone, mailboxJob: parseMailboxJob(rawMailboxJob()) })
    expect((await scanMailbox(mailbox.motherClone)).state.kind).toBe("kickoff")

    const prompts: string[] = []
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async (options: TurnOptions) => {
          prompts.push(options.prompt)
          // 研发端的工作区是**项目仓**,角色是 dev(硬件工具会被策略拒掉)。
          expect(options.workspace).toBe(target)
          expect(options.role).toBe("dev")
          writeFileSync(path.join(target, "fix.c"), "int fixed = 1;\n")
          writeFileSync(path.join(target, "fw.elf"), "ELF")
          return fakeTurn({
            sessionID: "ses-dev",
            text: '```json\n{"decision":"continue","analysis":"先加一条日志","instruction":"新固件在附件里,烧进去看串口","artifacts":["fw.elf"]}\n```',
            usage: usage(1000, 200),
          })
        },
      }),
    )
    expect(outcome.kind).toBe("decided")
    expect(prompts[0]).toContain("你是这个调试闭环的研发端")
    expect(prompts[0]).toContain("信箱里还没有任何轮次")

    const verify = await freshClone(temp, mailbox.bare)
    const instruction = (await Bun.file(path.join(verify, "rounds", "001", "instruction.json")).json()) as RoundInstruction
    expect(instruction.prompt).toContain("新固件在附件里")
    expect(instruction.artifacts).toEqual([{ name: "fw.elf", bytes: 3, from: "fw.elf" }])
    expect(await Bun.file(path.join(verify, "rounds", "001", "artifacts", "fw.elf")).text()).toBe("ELF")
    // 代码改动在研发端自己的仓里提交掉了,补丁随指令走。
    expect(await Bun.file(path.join(verify, "rounds", "001", "patch.diff")).text()).toContain("fix.c")
    expect((await runGitReal(["rev-parse", "--abbrev-ref", "HEAD"], target)).stdout).toBe("agent/m-1")
    expect((await runGitReal(["status", "--porcelain"], target)).stdout).toBe("")
    expect((await scanMailbox(verify)).state.kind).toBe("awaiting-runner")
  })

  test("声明的附件不存在:报错指名道姓,不留一个空 artifacts 目录", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    await initMailbox({ clone: mailbox.motherClone, mailboxJob: parseMailboxJob(rawMailboxJob()) })
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async () =>
          fakeTurn({
            text: '```json\n{"decision":"continue","instruction":"烧","artifacts":["build/没构建.elf"]}\n```',
          }),
      }),
    )
    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") expect(outcome.detail).toContain("build/没构建.elf")
  })

  test("本机没配工程目录:报人话", async () => {
    const mailbox = await makeMailbox(temp)
    await initMailbox({ clone: mailbox.motherClone, mailboxJob: parseMailboxJob(rawMailboxJob()) })
    const outcome = await motherStep({ clone: mailbox.motherClone, sessionsRoot: temp.dir("sessions-") })
    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") expect(outcome.detail).toContain("工程目录")
  })
})

describe("mailbox mother", () => {
  test("判据全过 → 守卫直接终局 passed,不问模型", async () => {
    const { target, mailbox } = await fixtureAfterRound({ grade: fakeGrade(true) })
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async () => {
          asked += 1
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") expect(outcome.verdict.outcome).toBe("passed")
    expect(asked).toBe(0)

    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("policy")
    expect(decision.decision).toBe("success")
    expect(await Bun.file(path.join(verify, "report.md")).text()).toContain("决策链")
  })

  test("通过后由研发端交付分支 —— 代码在它那儿,push 也归它", async () => {
    const target = await makeTargetRepo(temp)
    const upstream = temp.dir("upstream-")
    await runGitReal(["init", "-q", "--bare", "-b", "main"], upstream)
    await runGitReal(["remote", "add", "origin", upstream], target)

    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob({ deliver: { push: true } }))
    await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    await writeInstruction(mailbox.motherClone, { round: 1, prompt: "复现", issuedBy: "mother", at: new Date().toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "第 1 轮")
    await runnerStep({
      clone: mailbox.runnerClone,
      projectDir: target,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async () => fakeTurn(),
      grade: async () => ({ passed: true, rounds: [fakeGrade(true)] }),
    })
    // 研发端得先在分支上待过(交付推的是这条分支)。
    await runGitReal(["checkout", "-q", "-b", "agent/m-1"], target)

    const opts = motherOptions(mailbox.motherClone, target)
    const outcome = await motherStep(opts)
    expect(outcome.kind).toBe("done")
    expect((await runGitReal(["rev-parse", "--verify", "agent/m-1"], upstream)).ok).toBe(true)

    // 幂等:再走一步不会重复推(已 finalized)。
    expect((await motherStep(opts)).kind).toBe("done")
  })

  test("研发端裁决 continue → decision + 第 2 轮指令同一次提交", async () => {
    const { target, mailbox } = await fixtureAfterRound({})
    const prompts: string[] = []
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async (options: TurnOptions) => {
          prompts.push(options.prompt)
          expect(options.role).toBe("dev")
          return fakeTurn({
            sessionID: "ses-mother",
            text: '分析:日志显示 ORE 没清。\n```json\n{"decision":"continue","analysis":"ORE 未清导致接收停摆","instruction":"在 usart 中断里先清 ORE,再重试接收;用日志自证"}\n```',
            usage: usage(2000, 300),
          })
        },
      }),
    )
    expect(outcome.kind).toBe("decided")

    // 首轮分析带完整角色说明,且判据证据在场。
    expect(prompts[0]).toContain("研发端")
    expect(prompts[0]).toContain("assertion failed at main.c:42")

    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("mother")
    expect(decision.motherSessionID).toBe("ses-mother")
    expect(decision.usage?.tokens.input).toBe(2000)
    const instruction = (await Bun.file(
      path.join(verify, "rounds", "002", "instruction.json"),
    ).json()) as RoundInstruction
    expect(instruction.issuedBy).toBe("mother")
    expect(instruction.prompt).toContain("先清 ORE")

    // 信箱状态回到 awaiting-runner。
    expect((await scanMailbox(verify)).state.kind).toBe("awaiting-runner")
  })

  test("决定不合法:同一会话重试一次,第二次才认输挂起", async () => {
    const { target, mailbox } = await fixtureAfterRound({})
    const prompts: string[] = []
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async (options: TurnOptions) => {
          prompts.push(options.prompt)
          return fakeTurn({ text: "我觉得应该继续试试(没有围栏)" })
        },
      }),
    )
    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain("没法被机器读取")
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("parked")
      expect(outcome.verdict.reason).toContain("研发端未能给出合法决定")
    }
    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("policy")
    // 两次白跑的花费必须入账 —— 烧掉的钱不因为没产出就消失。
    expect(decision.usage?.tokens.input).toBe(200)
  })

  test("轮数用尽 → 守卫终局 failed", async () => {
    const { target, mailbox } = await fixtureAfterRound({ job: { mailbox: { maxRounds: 1, mother: {} } } })
    const outcome = await motherStep(motherOptions(mailbox.motherClone, target))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("failed")
      expect(outcome.verdict.reason).toContain("轮数预算")
    }
  })

  test("轮级失败(工位自检没过等)→ 守卫挂起", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob({ bench: { chip: "STM32G431KB", knownGoodElf: "无.elf" } }))
    await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    await writeInstruction(mailbox.motherClone, { round: 1, prompt: "复现", issuedBy: "mother", at: new Date().toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "第 1 轮")
    await runnerStep({ clone: mailbox.runnerClone, projectDir: target, sessionsRoot: temp.dir("sessions-") })

    const outcome = await motherStep(motherOptions(mailbox.motherClone, target))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("parked")
      expect(outcome.verdict.reason).toContain("known-good")
    }
  })

  test("provider 级空转轮(text 空、无工具、errors 非空)→ 守卫挂起,不让研发端对空轮 continue", async () => {
    const { target, mailbox } = await fixtureAfterRound({
      turn: fakeTurn({ text: "", toolCalls: [], errors: ["API Error: 401 Unauthorized"], usage: usage(0, 0) }),
    })
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async () => {
          asked += 1
          return fakeTurn()
        },
      }),
    )
    expect(asked).toBe(0)
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("parked")
      expect(outcome.verdict.reason).toContain("401")
    }
  })

  test("判据没跑成(环境错误)→ 守卫挂起而不是让模型瞎猜", async () => {
    const { target, mailbox } = await fixtureAfterRound({
      grade: fakeGrade(false, {
        hasEnvironmentError: true,
        checks: [
          {
            check: { type: "bash", command: "no-such" },
            outcome: "error",
            summary: "命令不存在",
            evidence: "",
            elapsedMs: 1,
          },
        ],
      }),
    })
    const outcome = await motherStep(motherOptions(mailbox.motherClone, target))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") expect(outcome.verdict.outcome).toBe("parked")
  })

  test("等工位端时空转", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    await initMailbox({ clone: mailbox.motherClone, mailboxJob: parseMailboxJob(rawMailboxJob()) })
    await writeInstruction(mailbox.motherClone, { round: 1, prompt: "复现", issuedBy: "mother", at: new Date().toISOString() })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "第 1 轮")
    const outcome = await motherStep(motherOptions(mailbox.motherClone, target))
    expect(outcome.kind).toBe("idle")
  })

  test("push 持续失败不无界烧钱:花费先落本地账本,预算守卫看得见", async () => {
    const { target, mailbox } = await fixtureAfterRound({})
    // 远端可读不可写:push 一律失败,其余照常。
    const readOnly: typeof runGitReal = (args, cwd) =>
      args[0] === "push" ? Promise.resolve({ ok: false, stdout: "", stderr: "403 只读" }) : runGitReal(args, cwd)

    let analyses = 0
    const opts = motherOptions(mailbox.motherClone, target, {
      gitRun: readOnly,
      runTurn: async () => {
        analyses += 1
        return fakeTurn({
          text: '```json\n{"decision":"continue","instruction":"继续"}\n```',
          usage: usage(60_000, 10_000), // 单次 7 万,预算 10 万
        })
      },
    })

    const first = await motherStep(opts)
    expect(first.kind).toBe("blocked")
    expect(analyses).toBe(1)

    // 第二个轮询:pullReset 丢掉没推上去的 decision,但本地账本记着 7 万;
    // 加上工位端的 150,尚未超预算 —— 会再烧一次(7+7=14 万 > 10 万)。
    const second = await motherStep(opts)
    expect(second.kind).toBe("blocked")
    expect(analyses).toBe(2)

    // 第三个轮询:两本账取大 → 14 万 > 10 万,预算守卫直接终局,不再碰模型。
    const third = await motherStep(opts)
    expect(third.kind).toBe("blocked") // 终局也推不上去,但……
    expect(analyses).toBe(2) // ……模型没有被再叫起来,烧钱收敛了
  })

  test("墙钟从第 1 轮指令起算,耗尽即终局 failed", async () => {
    const { target, mailbox, mailboxJob } = await fixtureAfterRound({})
    const wallClockMs = mailboxJob.job.budget.wallClockMin * 60 * 1000
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        now: () => Date.now() + wallClockMs + 60_000,
        runTurn: async () => {
          asked += 1
          return fakeTurn()
        },
      }),
    )
    expect(asked).toBe(0)
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("failed")
      expect(outcome.verdict.reason).toContain("墙钟")
    }
  })
})

describe("mailbox init 恢复", () => {
  test("首推失败留下的幽灵提交不会锁死信箱 —— 重试 init 把旧账推完", async () => {
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob())

    // 第一次 init:push 那一下断网。
    const pushBroken: typeof runGitReal = (args, cwd) =>
      args[0] === "push" ? Promise.resolve({ ok: false, stdout: "", stderr: "网断了" }) : runGitReal(args, cwd)
    const first = await initMailbox({ clone: mailbox.motherClone, mailboxJob, gitRun: pushBroken })
    expect(first.initialized).toBe(false)

    // 网络恢复,同一克隆重试:远端还没有分支,本地非空只是残骸 —— 必须成功而不是拒绝。
    const second = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    expect(second.initialized).toBe(true)

    const verify = await freshClone(temp, mailbox.bare)
    expect(await Bun.file(path.join(verify, "job.json")).exists()).toBe(true)
    // init 只放任务书,第一轮归研发端 —— 所以这时信箱是 kickoff。
    expect((await scanMailbox(verify)).state.kind).toBe("kickoff")
  })
})
