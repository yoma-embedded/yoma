/**
 * 全协议舞步:init → runner 轮 1(判据未过)→ mother continue → runner 轮 2(判据过)
 * → 守卫终局 passed → runner 收尾。两侧各拿各的克隆,只通过裸仓说话 —— 模型与硬件
 * 全走注入位,git 全真。这是"跨机器闭环在协议层真的能转起来"的证据。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { motherStep } from "./mother.ts"
import { runnerStep } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { scanMailbox } from "./store.ts"
import { fakeGrade, fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

describe("mailbox 闭环", () => {
  test("两轮修复剧本从头走到尾", async () => {
    const target = await makeTargetRepo(temp)
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob(target))

    // ── init:任务入箱,第 1 轮(复现)下发 ──
    const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    expect(initialized.initialized).toBe(true)

    // runner 侧的剧本:轮 1 只观察(判据未过),轮 2 修好(判据过)。
    const runnerPrompts: string[] = []
    let round = 0
    const runnerOptions = {
      clone: mailbox.runnerClone,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async (input: TurnInput) => {
        runnerPrompts.push(input.prompt)
        round += 1
        if (round === 2) writeFileSync(path.join(target, "usart.c"), "// 清 ORE 后重试接收\n")
        return fakeTurn({
          sessionID: "ses-debug",
          text: round === 1 ? "复现了:日志停在 RX overrun" : "已在中断里先清 ORE",
          usage: usage(1000, 200),
        })
      },
      grade: async () => {
        const grade = fakeGrade(round >= 2)
        return { passed: grade.passed, rounds: [grade] }
      },
    }

    // mother 侧:第 1 轮证据 → continue 并给出具体指令。
    const motherOptions = {
      clone: mailbox.motherClone,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async () =>
        fakeTurn({
          sessionID: "ses-mother",
          text: '证据链成立。\n```json\n{"decision":"continue","analysis":"RX overrun 与 ORE 未清吻合","instruction":"在 usart 中断里先清 ORE 再重试接收,烧录后用日志确认 overrun 消失"}\n```',
          usage: usage(3000, 400),
        }),
    }

    // ── 舞步 ──
    expect((await runnerStep(runnerOptions)).kind).toBe("ran") // 轮 1
    expect((await motherStep(motherOptions)).kind).toBe("decided") // continue → 轮 2 下发
    expect((await runnerStep(runnerOptions)).kind).toBe("ran") // 轮 2,判据过
    const done = await motherStep(motherOptions) // 守卫终局
    expect(done.kind).toBe("done")
    if (done.kind === "done") {
      expect(done.verdict.outcome).toBe("passed")
      expect(done.verdict.rounds).toBe(2)
      expect(done.verdict.totalRunnerTokens).toBe(2400) // 两轮 (1000+200)×2
      expect(done.verdict.totalMotherTokens).toBe(3400) // 一次分析 3000+400
      expect(done.verdict.decidedBy).toBe("policy")
    }
    expect((await runnerStep(runnerOptions)).kind).toBe("finalized") // runner 看到 verdict 收尾退场

    // ── 远端真相(全新克隆,不信任何工作副本) ──
    const verify = await freshClone(temp, mailbox.bare)
    const snapshot = await scanMailbox(verify)
    expect(snapshot.state.kind).toBe("done")
    expect(snapshot.rounds.length).toBe(2)
    expect(snapshot.rounds[0]!.decision?.decision).toBe("continue")
    expect(snapshot.rounds[0]!.decision?.by).toBe("mother")
    expect(snapshot.rounds[1]!.decision?.decision).toBe("success")
    expect(snapshot.rounds[1]!.decision?.by).toBe("policy")

    // 轮 2 的提示词确实是"母 agent 指令 + 上一轮证据"。
    expect(runnerPrompts[1]).toContain("先清 ORE 再重试接收")
    expect(runnerPrompts[1]).toContain("上一轮判据结果")

    // 终报讲的是决策链,两个会话都可回放。
    const report = await Bun.file(path.join(verify, "report.md")).text()
    expect(report).toContain("决策链")
    expect(report).toContain("ses-debug")
    expect(report).toContain("ses-mother")
  })
})
