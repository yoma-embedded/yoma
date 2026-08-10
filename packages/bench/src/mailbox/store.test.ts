import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  attachArtifacts,
  roundArtifactsDir,
  roundDir,
  scanMailbox,
  sumMotherTokens,
  writeDecision,
  writeInstruction,
  writeJson,
  writeRoundResult,
  writeVerdict,
  JOB_FILE,
  type RoundResultFile,
} from "./store.ts"
import { rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

function result(round: number, overrides: Partial<RoundResultFile> = {}): RoundResultFile {
  return { round, spentTokens: 150, at: new Date(0).toISOString(), elapsedMs: 5, ...overrides }
}

describe("mailbox store", () => {
  test("状态由文件存在性推断:empty → kickoff → awaiting-runner → awaiting-mother → done", async () => {
    const root = temp.dir("store-")
    expect((await scanMailbox(root)).state.kind).toBe("empty")

    // job.json 到位而零轮次 = 等研发端开第一轮(init 不再写死第一轮指令)。
    await writeJson(path.join(root, JOB_FILE), rawMailboxJob())
    expect((await scanMailbox(root)).state.kind).toBe("kickoff")

    await writeInstruction(root, { round: 1, prompt: "复现", issuedBy: "mother", at: new Date(0).toISOString() })
    const awaitingRunner = await scanMailbox(root)
    expect(awaitingRunner.state.kind).toBe("awaiting-runner")
    if (awaitingRunner.state.kind === "awaiting-runner") expect(awaitingRunner.state.round).toBe(1)

    await writeRoundResult(root, result(1))
    const awaitingMother = await scanMailbox(root)
    expect(awaitingMother.state.kind).toBe("awaiting-mother")

    await writeVerdict(root, {
      outcome: "failed",
      reason: "预算耗尽",
      rounds: 1,
      totalRunnerTokens: 150,
      totalMotherTokens: 0,
      decidedBy: "policy",
      at: new Date(0).toISOString(),
    })
    const done = await scanMailbox(root)
    expect(done.state.kind).toBe("done")
    if (done.state.kind === "done") expect(done.state.verdict.outcome).toBe("failed")
  })

  test("状态永远看最大的轮 —— 下发第 2 轮后回到 awaiting-runner", async () => {
    const root = temp.dir("store-")
    await writeJson(path.join(root, JOB_FILE), rawMailboxJob())
    await writeInstruction(root, { round: 1, prompt: "复现", issuedBy: "init", at: new Date(0).toISOString() })
    await writeRoundResult(root, result(1))
    await writeInstruction(root, { round: 2, prompt: "改 A 处", issuedBy: "mother", at: new Date(0).toISOString() })
    const state = (await scanMailbox(root)).state
    expect(state.kind).toBe("awaiting-runner")
    if (state.kind === "awaiting-runner") {
      expect(state.round).toBe(2)
      expect(state.instruction.issuedBy).toBe("mother")
    }
  })

  test("损坏要报 corrupt 并说清哪里坏 —— 不抛异常打死轮询循环", async () => {
    const root = temp.dir("store-")
    await writeJson(path.join(root, JOB_FILE), rawMailboxJob())
    await writeInstruction(root, { round: 1, prompt: "复现", issuedBy: "init", at: new Date(0).toISOString() })
    mkdirSync(path.join(root, "rounds", "002"), { recursive: true })
    const noInstruction = await scanMailbox(root)
    expect(noInstruction.state.kind).toBe("corrupt")
    if (noInstruction.state.kind === "corrupt") expect(noInstruction.state.detail).toContain("instruction.json")

    writeFileSync(path.join(root, JOB_FILE), "{ 这不是 json")
    const badJob = await scanMailbox(root)
    expect(badJob.state.kind).toBe("corrupt")
    if (badJob.state.kind === "corrupt") expect(badJob.state.detail).toContain("job.json")
  })

  test("一轮的输入是一整包:指令 + patch + 附件同住一个轮目录", async () => {
    const root = temp.dir("store-")
    const workspace = temp.dir("ws-")
    writeFileSync(path.join(workspace, "fw.elf"), "ELF-BYTES")

    const attached = await attachArtifacts(
      root,
      2,
      [{ source: path.join(workspace, "fw.elf"), name: "fw.elf", from: "build/fw.elf" }],
      1024 * 1024,
    )
    expect(attached.ok).toBe(true)
    if (attached.ok) expect(attached.artifacts[0]).toEqual({ name: "fw.elf", bytes: 9, from: "build/fw.elf" })

    await writeInstruction(
      root,
      { round: 2, prompt: "烧进去", issuedBy: "mother", at: new Date(0).toISOString() },
      { patch: "diff --git a/x b/x" },
    )
    expect(await Bun.file(path.join(roundDir(root, 2), "patch.diff")).text()).toContain("diff --git")
    expect(await Bun.file(path.join(roundArtifactsDir(root, 2), "fw.elf")).text()).toBe("ELF-BYTES")

    await writeRoundResult(root, result(2))
    expect(((await Bun.file(path.join(roundDir(root, 2), "result.json")).json()) as RoundResultFile).round).toBe(2)
  })

  test("附件超上限直接拒 —— 信箱是个 git 仓,塞进去就永远瘦不回来", async () => {
    const root = temp.dir("store-")
    const workspace = temp.dir("ws-")
    writeFileSync(path.join(workspace, "big.bin"), "x".repeat(2048))
    const attached = await attachArtifacts(
      root,
      1,
      [{ source: path.join(workspace, "big.bin"), name: "big.bin", from: "build/big.bin" }],
      1024,
    )
    expect(attached.ok).toBe(false)
    if (!attached.ok) expect(attached.error).toContain("上限")
  })

  test("附件声明了但文件不在 —— 报错要指名道姓,不能留个空目录", async () => {
    const root = temp.dir("store-")
    const attached = await attachArtifacts(
      root,
      1,
      [{ source: path.join(temp.dir("ws-"), "nope.elf"), name: "nope.elf", from: "build/nope.elf" }],
      1024,
    )
    expect(attached.ok).toBe(false)
    if (!attached.ok) expect(attached.error).toContain("build/nope.elf")
  })

  test("sumMotherTokens 只数 decision 里的用量", async () => {
    const root = temp.dir("store-")
    await writeInstruction(root, { round: 1, prompt: "a", issuedBy: "init", at: new Date(0).toISOString() })
    await writeDecision(root, {
      round: 1,
      by: "mother",
      decision: "continue",
      usage: usage(1000, 200),
      at: new Date(0).toISOString(),
    })
    await writeInstruction(root, { round: 2, prompt: "b", issuedBy: "mother", at: new Date(0).toISOString() })
    await writeDecision(root, { round: 2, by: "policy", decision: "fail", at: new Date(0).toISOString() })
    const snapshot = await scanMailbox(root)
    expect(sumMotherTokens(snapshot.rounds)).toBe(1200)
  })
})
