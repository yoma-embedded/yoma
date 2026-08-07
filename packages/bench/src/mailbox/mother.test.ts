import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"

import type { TurnOptions } from "../turn.ts"
import { initMailbox } from "./init.ts"
import { motherStep, parseMotherDecision, type MailboxMotherOptions } from "./mother.ts"
import { runnerStep } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { scanMailbox, type RoundDecision, type RoundInstruction } from "./store.ts"
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
})

/** 布景:init + runner 跑完第 1 轮(注入的 turn/grade),留下 awaiting-mother 的信箱。 */
async function fixtureAfterRound(overrides: {
  job?: Record<string, unknown>
  grade?: ReturnType<typeof fakeGrade>
  turn?: ReturnType<typeof fakeTurn>
}) {
  const target = await makeTargetRepo(temp)
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(target, overrides.job ?? {}))
  await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  const ran = await runnerStep({
    clone: mailbox.runnerClone,
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

function motherOptions(clone: string, overrides: Partial<MailboxMotherOptions> = {}): MailboxMotherOptions {
  return { clone, sessionsRoot: temp.dir("sessions-"), ...overrides }
}

describe("mailbox mother", () => {
  test("判据全过 → 守卫直接终局 passed,不问模型", async () => {
    const { mailbox } = await fixtureAfterRound({ grade: fakeGrade(true) })
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, {
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

  test("mother 裁决 continue → decision + 第 2 轮指令同一次提交", async () => {
    const { mailbox } = await fixtureAfterRound({})
    const prompts: string[] = []
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, {
        runTurn: async (options: TurnOptions) => {
          prompts.push(options.prompt)
          expect(options.job.policy).toBe("readonly")
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
    expect(prompts[0]).toContain("母 agent")
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
    const { mailbox } = await fixtureAfterRound({})
    const prompts: string[] = []
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, {
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
      expect(outcome.verdict.reason).toContain("母 agent 未能给出合法决定")
    }
    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("policy")
    // 两次白跑的花费必须入账 —— 烧掉的钱不因为没产出就消失。
    expect(decision.usage?.tokens.input).toBe(200)
  })

  test("轮数用尽 → 守卫终局 failed", async () => {
    const { mailbox } = await fixtureAfterRound({ job: { mailbox: { maxRounds: 1, mother: {} } } })
    const outcome = await motherStep(motherOptions(mailbox.motherClone))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("failed")
      expect(outcome.verdict.reason).toContain("轮数预算")
    }
  })

  test("轮级失败(工位自检没过等)→ 守卫挂起", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob(target, { bench: { chip: "STM32G431KB", knownGoodElf: "无.elf" } }))
    await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    await runnerStep({ clone: mailbox.runnerClone, sessionsRoot: temp.dir("sessions-") })

    const outcome = await motherStep(motherOptions(mailbox.motherClone))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("parked")
      expect(outcome.verdict.reason).toContain("known-good")
    }
  })

  test("provider 级空转轮(text 空、无工具、errors 非空)→ 守卫挂起,不让 mother 对空轮 continue", async () => {
    const { mailbox } = await fixtureAfterRound({
      turn: fakeTurn({ text: "", toolCalls: [], errors: ["API Error: 401 Unauthorized"], usage: usage(0, 0) }),
    })
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, {
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
    const { mailbox } = await fixtureAfterRound({
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
    const outcome = await motherStep(motherOptions(mailbox.motherClone))
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") expect(outcome.verdict.outcome).toBe("parked")
  })

  test("等 runner 时空转", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    await initMailbox({ clone: mailbox.motherClone, mailboxJob: parseMailboxJob(rawMailboxJob(target)) })
    const outcome = await motherStep(motherOptions(mailbox.motherClone))
    expect(outcome.kind).toBe("idle")
  })

  test("push 持续失败不无界烧钱:花费先落本地账本,预算守卫看得见", async () => {
    const { mailbox } = await fixtureAfterRound({})
    const { runGitReal } = await import("../git.ts")
    // 远端可读不可写:push 一律失败,其余照常。
    const readOnly: typeof runGitReal = (args, cwd) =>
      args[0] === "push"
        ? Promise.resolve({ ok: false, stdout: "", stderr: "403 只读" })
        : runGitReal(args, cwd)

    let analyses = 0
    const opts = motherOptions(mailbox.motherClone, {
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
    // 加上 runner 侧的 150,尚未超预算 —— 会再烧一次(7+7=14 万 > 10 万)。
    const second = await motherStep(opts)
    expect(second.kind).toBe("blocked")
    expect(analyses).toBe(2)

    // 第三个轮询:两本账取大 → 14 万 > 10 万,预算守卫直接终局,不再碰模型。
    const third = await motherStep(opts)
    expect(third.kind).toBe("blocked") // 终局也推不上去,但……
    expect(analyses).toBe(2) // ……模型没有被再叫起来,烧钱收敛了
  })

  test("墙钟从第 1 轮指令起算,耗尽即终局 failed", async () => {
    const { mailbox, mailboxJob } = await fixtureAfterRound({})
    const wallClockMs = mailboxJob.job.budget.wallClockMin * 60 * 1000
    let asked = 0
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, {
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
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob(target))
    const { runGitReal } = await import("../git.ts")

    // 第一次 init:push 那一下断网。
    const pushBroken: typeof runGitReal = (args, cwd) =>
      args[0] === "push"
        ? Promise.resolve({ ok: false, stdout: "", stderr: "网断了" })
        : runGitReal(args, cwd)
    const first = await initMailbox({ clone: mailbox.motherClone, mailboxJob, gitRun: pushBroken })
    expect(first.initialized).toBe(false)

    // 网络恢复,同一克隆重试:远端还没有分支,本地非空只是残骸 —— 必须成功而不是拒绝。
    const second = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    expect(second.initialized).toBe(true)

    const verify = await freshClone(temp, mailbox.bare)
    expect(await Bun.file(path.join(verify, "job.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(verify, "rounds", "001", "instruction.json")).exists()).toBe(true)
  })
})
