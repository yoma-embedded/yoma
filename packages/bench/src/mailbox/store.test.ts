import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  attachArtifacts,
  collectBack,
  readToolchainManifest,
  roundArtifactsDir,
  roundBackDir,
  roundDir,
  scanMailbox,
  sumMotherTokens,
  syncToolchainManifest,
  writeDecision,
  writeHumanAck,
  writeInstruction,
  writeJson,
  writeRoundResult,
  writeVerdict,
  JOB_FILE,
  TOOLCHAIN_FILE,
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

  test("挂起等人:裁决在而回执没来 → awaiting-human;回执一到 → 回到 awaiting-mother", async () => {
    const root = temp.dir("store-")
    await writeJson(path.join(root, JOB_FILE), rawMailboxJob())
    await writeInstruction(root, { round: 1, prompt: "复现", issuedBy: "mother", at: new Date(0).toISOString() })
    await writeRoundResult(root, result(1, { needsHuman: "请把台架电源设为 24V" }))
    await writeDecision(root, {
      round: 1,
      by: "mother",
      decision: "await-human",
      ask: "请把台架电源设为 24V 并接到母线",
      at: new Date(0).toISOString(),
    })

    const parked = await scanMailbox(root)
    expect(parked.state.kind).toBe("awaiting-human")
    if (parked.state.kind === "awaiting-human") {
      expect(parked.state.round).toBe(1)
      // ask 随状态走:通知与横幅要拿它,不该逼界面自己去翻轮次文件。
      expect(parked.state.ask).toContain("24V")
    }

    // 回执落地 = 唤醒。没有别的机制:状态自己滑回"等研发端裁决",它拿着回执重裁同一轮。
    await writeHumanAck(root, 1, { answer: "done", note: "已设 24V", at: new Date(0).toISOString() })
    const resumed = await scanMailbox(root)
    expect(resumed.state.kind).toBe("awaiting-mother")
    expect(resumed.rounds[0]?.humanAck?.note).toBe("已设 24V")
  })

  test("回传件:超限的跳过并记账,不因为一个大文件把整轮毙掉", async () => {
    const root = temp.dir("store-")
    const bench = temp.dir("bench-out-")
    writeFileSync(path.join(bench, "small.csv"), "t,iq\n0,0.1\n")
    writeFileSync(path.join(bench, "huge.npz"), "x".repeat(4096))

    const collected = await collectBack(
      root,
      1,
      [
        { source: path.join(bench, "small.csv"), name: "small.csv" },
        { source: path.join(bench, "huge.npz"), name: "capture/huge.npz" },
        { source: path.join(bench, "没有这个文件"), name: "missing.bin" },
      ],
      1024,
    )
    expect(collected.back.map((item) => item.name)).toEqual(["small.csv"])
    expect(collected.skipped.map((item) => item.name)).toEqual(["capture/huge.npz", "missing.bin"])
    expect(collected.skipped[0]!.reason).toContain("上限")
    // 收下的是真拷过去了(子目录也保得住形状)。
    expect(await Bun.file(path.join(roundBackDir(root, 1), "small.csv")).text()).toContain("t,iq")
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

  describe("工具链清单副本", () => {
    /** 研发端的检出:清单住在 `<工程>/.yoma/toolchain.json`。 */
    function workspaceWithManifest(temp: Temp, text: string): string {
      const dir = temp.dir("ws-")
      mkdirSync(path.join(dir, ".yoma"), { recursive: true })
      writeFileSync(path.join(dir, ".yoma", "toolchain.json"), text)
      return dir
    }

    test("研发端有清单:原样复制进信箱根,工位端读得到同一份", async () => {
      const root = temp.dir("store-")
      const text = '{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","side":"runner"}]}\n'
      expect(await syncToolchainManifest(root, workspaceWithManifest(temp, text))).toBe(true)
      expect(await readToolchainManifest(root)).toBe(text)
    })

    test("项目没有清单:静默不写,读到 undefined", async () => {
      const root = temp.dir("store-")
      expect(await syncToolchainManifest(root, temp.dir("ws-empty-"))).toBe(false)
      expect(await readToolchainManifest(root)).toBeUndefined()
    })

    test("清单这轮读不到时**不删**信箱里已有的那份", async () => {
      // 删了等于让工位端在某一轮突然失明,而"读不到"更可能是研发端工作树的临时状态,
      // 不是"这个项目不再需要工具了"。
      const root = temp.dir("store-")
      const text = '{"schema":"yoma/toolchain@1","tools":[]}\n'
      await syncToolchainManifest(root, workspaceWithManifest(temp, text))
      expect(await syncToolchainManifest(root, temp.dir("ws-gone-"))).toBe(false)
      expect(await readToolchainManifest(root)).toBe(text)
    })

    test("刷新会覆盖:研发端中途给清单加一条工具,下一轮对面就看得到", async () => {
      const root = temp.dir("store-")
      await syncToolchainManifest(root, workspaceWithManifest(temp, '{"tools":[]}'))
      await syncToolchainManifest(root, workspaceWithManifest(temp, '{"tools":["new"]}'))
      expect(await readToolchainManifest(root)).toBe('{"tools":["new"]}')
    })

    test("落点是信箱根的 toolchain.json,不是某一轮下面", async () => {
      const root = temp.dir("store-")
      await syncToolchainManifest(root, workspaceWithManifest(temp, "{}"))
      expect(await Bun.file(path.join(root, TOOLCHAIN_FILE)).text()).toBe("{}")
    })
  })
})
