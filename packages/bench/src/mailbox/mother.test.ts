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
import { fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

describe("parseMotherDecision", () => {
  test("只认最后一个 json 围栏", () => {
    const text = '示例:\n```json\n{"decision":"fail","reason":"示例"}\n```\n正式决定:\n```json\n{"decision":"continue","instruction":"改 A 处"}\n```'
    const parsed = parseMotherDecision(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.payload.decision).toBe("continue")
  })

  test("不认识的 decision 被点名拒绝,可选项写进错误里", () => {
    const parsed = parseMotherDecision('```json\n{"decision":"success"}\n```')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain("不认识")
      expect(parsed.error).toContain("continue / done / fail")
    }
  })

  test("continue 没有 instruction、fail 没有 reason 都不合法", () => {
    expect(parseMotherDecision('```json\n{"decision":"continue"}\n```').ok).toBe(false)
    expect(parseMotherDecision('```json\n{"decision":"fail"}\n```').ok).toBe(false)
    expect(parseMotherDecision('```json\n{"decision":"done","reason":"证据齐了"}\n```').ok).toBe(true)
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
async function fixtureAfterRound(overrides: { job?: Record<string, unknown>; turn?: ReturnType<typeof fakeTurn> }) {
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
    workRoot: temp.dir("work-"),
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => overrides.turn ?? fakeTurn(),
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
          // 研发端的工作区是**项目仓** —— 它改代码、构建,产物随下一轮的附件走。
          expect(options.workspace).toBe(target)
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
  test("研发端裁 done → 终局 passed,裁决者记 mother", async () => {
    const { target, mailbox } = await fixtureAfterRound({})
    const outcome = await motherStep(
      motherOptions(mailbox.motherClone, target, {
        runTurn: async () =>
          fakeTurn({
            text: '```json\n{"decision":"done","analysis":"版本指纹对上了","reason":"工位端读到的计数器已按新逻辑递增"}\n```',
          }),
      }),
    )
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") {
      expect(outcome.verdict.outcome).toBe("passed")
      expect(outcome.verdict.decidedBy).toBe("mother")
    }

    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("mother")
    expect(decision.decision).toBe("done")
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
      workRoot: temp.dir("work-"),
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async () => fakeTurn(),
    })

    const opts = motherOptions(mailbox.motherClone, target, {
      runTurn: async () => fakeTurn({ text: '```json\n{"decision":"done","reason":"证据够了"}\n```' }),
    })
    const outcome = await motherStep(opts)
    expect(outcome.kind).toBe("done")
    if (outcome.kind === "done") expect(outcome.verdict.outcome).toBe("passed")
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
          return fakeTurn({
            sessionID: "ses-mother",
            text: '分析:日志显示 ORE 没清。\n```json\n{"decision":"continue","analysis":"ORE 未清导致接收停摆","instruction":"在 usart 中断里先清 ORE,再重试接收;用日志自证"}\n```',
            usage: usage(2000, 300),
          })
        },
      }),
    )
    expect(outcome.kind).toBe("decided")

    // 首轮分析带完整角色说明,且工位端的自述在场。
    expect(prompts[0]).toContain("研发端")
    expect(prompts[0]).toContain("工位端的自述")

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

  test("决定不合法:同一会话重试一次,第二次才认输终局", async () => {
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
      expect(outcome.verdict.outcome).toBe("failed")
      expect(outcome.verdict.reason).toContain("研发端未能给出合法决定")
    }
    const verify = await freshClone(temp, mailbox.bare)
    const decision = (await Bun.file(path.join(verify, "rounds", "001", "decision.json")).json()) as RoundDecision
    expect(decision.by).toBe("policy")
    // 两次白跑的花费必须入账 —— 烧掉的钱不因为没产出就消失。
    expect(decision.usage?.tokens.input).toBe(200)
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
