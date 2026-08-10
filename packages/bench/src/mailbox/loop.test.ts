/**
 * 全协议舞步:init → 研发端开局下发轮 1 → 工位端轮 1 → 研发端改代码+附产物 →
 * 工位端轮 2 → 研发端读证据裁 done → 终局 passed → 工位端收尾。两侧各拿各的克隆,
 * 只通过裸仓说话 —— 模型全走注入位,git 全真。这是"跨机器闭环在协议层真的能转起来"
 * 的证据。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { motherStep } from "./mother.ts"
import { runnerStep } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { scanMailbox } from "./store.ts"
import { fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

describe("mailbox 闭环", () => {
  test("两轮修复剧本从头走到尾", async () => {
    // 研发端有工程检出;工位端没有 —— 它只有一个一次性工作目录,内容全部来自附件。
    const target = await makeTargetRepo(temp)
    const workRoot = temp.dir("work-")
    const benchWorkspace = path.join(workRoot, "m-1", "work")
    const mailbox = await makeMailbox(temp)
    const mailboxJob = parseMailboxJob(rawMailboxJob())

    // ── init:只放任务书,第一轮归研发端 ──
    const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
    expect(initialized.initialized).toBe(true)

    // 工位端剧本:轮 1 只观察,轮 2 拿到新固件后复验。
    const runnerPrompts: string[] = []
    let round = 0
    const runnerOptions = {
      clone: mailbox.runnerClone,
      workRoot,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async (input: TurnInput) => {
        runnerPrompts.push(input.prompt)
        round += 1
        return fakeTurn({
          sessionID: "ses-debug",
          text: round === 1 ? "复现了:日志停在 RX overrun" : "烧了新固件,overrun 不再出现",
          usage: usage(1000, 200),
        })
      },
    }

    // 研发端剧本:开局只让复现;拿到证据后改代码、"构建"出固件、附上它;再拿到证据就收工。
    const motherPrompts: string[] = []
    let analyses = 0
    const motherOptions = {
      clone: mailbox.motherClone,
      projectDir: target,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async (options: { prompt: string }) => {
        motherPrompts.push(options.prompt)
        analyses += 1
        if (analyses === 1) {
          return fakeTurn({
            sessionID: "ses-mother",
            text: '先看现象。\n```json\n{"decision":"continue","analysis":"还没有任何证据,先复现","instruction":"上电跑起来,把串口日志贴回来"}\n```',
            usage: usage(3000, 400),
          })
        }
        if (analyses === 2) {
          // 改代码 + 构建产物(测试里就是写两个文件),然后附上固件。
          writeFileSync(path.join(target, "usart.c"), "// 清 ORE 后重试接收\n")
          writeFileSync(path.join(target, "fw.elf"), "NEW-ELF")
          return fakeTurn({
            sessionID: "ses-mother",
            text: '证据链成立。\n```json\n{"decision":"continue","analysis":"RX overrun 与 ORE 未清吻合","instruction":"新固件在附件里,弄上板,再复现一次看 overrun 还在不在","artifacts":["fw.elf"]}\n```',
            usage: usage(3000, 400),
          })
        }
        return fakeTurn({
          sessionID: "ses-mother",
          text: '工位端说 overrun 不再出现,证据够了。\n```json\n{"decision":"done","analysis":"新固件下 overrun 消失","reason":"工位端复现不出 RX overrun,与 ORE 清理的假设吻合"}\n```',
          usage: usage(3000, 400),
        })
      },
    }

    // ── 舞步 ──
    expect((await runnerStep(runnerOptions)).kind).toBe("idle") // 还没有指令,等研发端
    expect((await motherStep(motherOptions)).kind).toBe("decided") // 开局:下发轮 1
    expect((await runnerStep(runnerOptions)).kind).toBe("ran") // 轮 1
    expect((await motherStep(motherOptions)).kind).toBe("decided") // 改代码 + 附固件 → 轮 2
    expect((await runnerStep(runnerOptions)).kind).toBe("ran") // 轮 2
    const done = await motherStep(motherOptions) // 研发端读证据,裁 done
    expect(done.kind).toBe("done")
    if (done.kind === "done") {
      expect(done.verdict.outcome).toBe("passed")
      expect(done.verdict.rounds).toBe(2)
      expect(done.verdict.totalRunnerTokens).toBe(2400) // 两轮 (1000+200)×2
      // 三次分析:开局 + 轮 1 + 轮 2。开局那次不写 decision,只有本地账本记得它 ——
      // 账本正是为此存在(见 mother.ts 的 spentTokens),没有它这里会少算一整轮。
      expect(done.verdict.totalMotherTokens).toBe(10200) // (3000+400)×3
      expect(done.verdict.decidedBy).toBe("mother")
    }
    expect((await runnerStep(runnerOptions)).kind).toBe("finalized") // 工位端看到 verdict 收尾退场

    // ── 远端真相(全新克隆,不信任何工作副本) ──
    const verify = await freshClone(temp, mailbox.bare)
    const snapshot = await scanMailbox(verify)
    expect(snapshot.state.kind).toBe("done")
    expect(snapshot.rounds.length).toBe(2)
    expect(snapshot.rounds[0]!.decision?.decision).toBe("continue")
    expect(snapshot.rounds[0]!.decision?.by).toBe("mother")
    expect(snapshot.rounds[1]!.decision?.decision).toBe("done")
    expect(snapshot.rounds[1]!.decision?.by).toBe("mother")

    // 产物真的穿过了信箱,并落到工位端的一次性工作目录里。
    expect(snapshot.rounds[1]!.instruction?.artifacts?.[0]?.name).toBe("fw.elf")
    expect(await Bun.file(path.join(verify, "rounds", "002", "artifacts", "fw.elf")).text()).toBe("NEW-ELF")
    expect(snapshot.rounds[1]!.result?.incoming).toEqual(["fw.elf"])
    expect(await Bun.file(path.join(benchWorkspace, "fw.elf")).text()).toBe("NEW-ELF")

    // 代码改动是**研发端**做的,提交在 agent 分支上,补丁随轮 2 的指令走。
    expect(snapshot.rounds[1]!.decision?.git).toBeUndefined() // 终局那一裁不下发下一轮,不带改动
    expect(snapshot.rounds[0]!.decision?.git?.changedFiles.join()).toContain("usart.c")
    expect(await Bun.file(path.join(verify, "rounds", "002", "patch.diff")).text()).toContain("usart.c")
    expect((await runGitReal(["rev-parse", "--abbrev-ref", "HEAD"], target)).stdout).toBe("agent/m-1")

    // 轮 2 的提示词确实是"附件清单 + 研发端指令"。
    expect(runnerPrompts[1]).toContain("fw.elf")
    expect(runnerPrompts[1]).toContain("弄上板")

    // 终报讲的是决策链,两个会话都可回放。
    const report = await Bun.file(path.join(verify, "report.md")).text()
    expect(report).toContain("决策链")
    expect(report).toContain("ses-debug")
    expect(report).toContain("ses-mother")
  })
})
