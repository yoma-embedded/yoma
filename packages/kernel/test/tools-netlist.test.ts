/**
 * netlist 工具(host/tools/netlist/{contract,session}.ts)的验收,三层由假到真:
 *
 * 1. 契约与纯函数:两种模式、没有确认门、summary、文件名词干、从 controller_map 的 JSON 里读主控。
 * 2. **假引擎**(fixtures/fake-exe.ts):controller_map / board_ir 的 argv、探测说明的透出、三个产物的内联与截断、
 *    非零退出抛错、没有器件数据时的话、中止、进度旁路。
 * 3. **真引擎**(仓库 engines/bin 里的 controller_map 在时才跑):对 engines/controller_map/tests/fixtures 里的
 *    真网表跑一遍(odrive 的 Altium .NET 与 nRF 的 pca10056);board_ir 还要 irpack(见 tools-stm32config.test.ts
 *    的说明),没有就跳过那一条。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { exe } from "../src/host/domain/engines.ts"
import * as engines from "../src/host/domain/engines.ts"
import { confirmNeeded, toolContract } from "../src/host/tools/contracts.ts"
import {
  DEFAULT_OUT_DIR,
  NETLIST_CONTRACT,
  type NetlistDetails,
  type NetlistInput,
  netlistSummary,
} from "../src/host/tools/netlist/contract.ts"
import {
  createNetlistTool,
  detectedController,
  RAW_MAP_MAX_CHARS,
  sanitizeStem,
} from "../src/host/tools/netlist/session.ts"
import { ECHO_ARGV_JS, writeFakeExe } from "./fixtures/fake-exe.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")
const REAL_ENGINES = join(REPO_ROOT, "engines")
const FIXTURES = join(REAL_ENGINES, "controller_map", "tests", "fixtures")

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoma-netlist-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

type Update = (partial: AgentToolResult<NetlistDetails>) => void

function makeEnginesDir(bins: Record<string, string>, options: { noData?: boolean } = {}): string {
  const root = createTempDir()
  mkdirSync(join(root, "bin"), { recursive: true })
  for (const [name, js] of Object.entries(bins)) writeFakeExe(join(root, "bin"), name, js)
  if (!options.noData) {
    mkdirSync(join(root, "data", "stm32", "fw"), { recursive: true })
    writeFileSync(join(root, "data", "stm32", "stm32f4.irpack"), "")
  }
  return root
}

function makeTool(enginesDir: string) {
  const cwd = createTempDir()
  const tool = createNetlistTool({ enginesDir })
  const run = (params: NetlistInput, context: Context = BACKGROUND_CONTEXT, onUpdate: Update = () => {}) =>
    tool.execute("c1", params, onUpdate, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { tool, run, cwd }
}

function textOf(result: AgentToolResult<NetlistDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

const abortAfter = (ms: number): Context => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
}

const ECHO_CONTROLLER_MAP = `
console.error("Detected main controller (auto): U2  (STM-LQFP64_N, 64 pins).\\nWarning: low-confidence controller detection");
console.log(JSON.stringify({ tool: "controller_map v0.1.0", controller: { ref: "U2", part: "" }, low_confidence: true, argv: process.argv.slice(2).join(" ") }));
`
// 假 board_ir:抓出 --out-dir/--stem,写下三个产物文件。argv 打到 stderr —— board_ir 分支按设计丢弃 stdout,
// 只有 stderr 会以 [detection] 透出。
const FAKE_BOARD_IR = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out-dir") + 1];
const stem = args[args.indexOf("--stem") + 1];
writeFileSync(join(out, stem + "_stm32_map.json"), '{"map":1}');
writeFileSync(join(out, stem + "_cfg_seed.json"), '{"seed":2}');
writeFileSync(join(out, stem + "_board_ir.json"), '{"ir":3}');
console.error("argv: " + args.join(" "));
`

// ─── 1. 契约与纯函数 ──────────────────────────────────────────────────────────

describe("netlist contract", () => {
  it("is registered, has no confirm gate, and summarises both modes", () => {
    expect(toolContract("netlist")).toBe(NETLIST_CONTRACT)
    expect(NETLIST_CONTRACT.label).toBe("网表")
    expect(confirmNeeded("netlist", { netlistPath: "board.NET", part: "STM32F405RGTx" })).toBeUndefined()
    expect(NETLIST_CONTRACT.guidelines).toHaveLength(1)
    expect(DEFAULT_OUT_DIR).toBe(".yoma/tool-output")
    expect(netlistSummary({ netlistPath: "board.NET" })).toBe("map board.NET")
    expect(netlistSummary({ netlistPath: "board.NET", part: "STM32F405RGTx", mainController: "U2" })).toBe(
      "board_ir STM32F405RGTx board.NET @U2",
    )
    expect(netlistSummary({})).toBe("map")
  })

  it("sanitizeStem strips the extension and replaces unsafe characters, keeping Unicode letters", () => {
    expect(sanitizeStem("/w/odrive_two_ax.NET")).toBe("odrive_two_ax")
    expect(sanitizeStem("my board (rev2).NET")).toBe("my_board_rev2_")
    expect(sanitizeStem("咖啡机.NET")).toBe("咖啡机")
    expect(sanitizeStem(".NET")).toBe("board")
  })

  it("detectedController reads the ref and confidence out of controller_map's JSON, tolerating anything else", () => {
    expect(detectedController('{"controller":{"ref":"U2"},"low_confidence":true}')).toEqual({
      controller: "U2",
      lowConfidence: true,
    })
    expect(detectedController('{"controller":{"ref":""}}')).toEqual({})
    expect(detectedController("not json")).toEqual({})
  })
})

// ─── 2. 假引擎 ────────────────────────────────────────────────────────────────

describe("netlist tool (fake engines)", () => {
  it("rejects directories and invalid engine output instead of reporting a parsed schematic", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ controller_map: `console.log("not JSON");` }))
    await expect(run({ netlistPath: cwd })).rejects.toThrow("not a regular file")
    writeFileSync(join(cwd, "board.NET"), "x")
    await expect(run({ netlistPath: "board.NET" })).rejects.toThrow("controller_map returned invalid JSON")
  })

  it("keeps simultaneous board IR results separate, including when an engine writes then lingers", async () => {
    const fake =
      FAKE_BOARD_IR.replace("'{\"map\":1}'", 'JSON.stringify({ part: args[args.indexOf("--part") + 1] })') +
      `await new Promise(r => setTimeout(r, 150));`
    const root = makeEnginesDir({ board_ir: fake, stm32kernel: ECHO_ARGV_JS })
    const { run, cwd } = makeTool(root)
    writeFileSync(join(cwd, "board.NET"), "x")
    const [first, second] = await Promise.all([
      run({ netlistPath: "board.NET", part: "STM32F405RGTx" }),
      run({ netlistPath: "board.NET", part: "STM32F103C8Tx" }),
    ])
    expect(first.details.files!.stm32Map).not.toBe(second.details.files!.stm32Map)
    for (const result of [first, second]) {
      expect(JSON.parse(readFileSync(result.details.files!.stm32Map, "utf8")).part).toBe(result.details.part)
      expect(textOf(result)).toContain(`"part":"${result.details.part}"`)
    }
    expect(readFileSync(join(cwd, ".yoma", "tool-output", ".gitignore"), "utf8")).toBe("*\n")
  })

  it.each(["board_ir", "stm32_map", "cfg_seed"])(
    "requires the current %s product even after an earlier successful run",
    async (missing) => {
      const root = makeEnginesDir({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGV_JS })
      const { run, cwd } = makeTool(root)
      writeFileSync(join(cwd, "board.NET"), "x")
      const first = await run({ netlistPath: "board.NET", part: "STM32F405RGTx" })
      const broken = FAKE_BOARD_IR.split("\n")
        .filter((line) => !line.includes(`_${missing}.json`))
        .join("\n")
      writeFakeExe(join(root, "bin"), "board_ir", broken)
      await expect(run({ netlistPath: "board.NET", part: "STM32F405RGTx" })).rejects.toThrow(
        "required output file is missing",
      )
      expect(existsSync(first.details.files!.boardIr)).toBe(true)
    },
  )

  it("rejects malformed products and explains non-STM32 part usage", async () => {
    const { run, cwd } = makeTool(
      makeEnginesDir({ board_ir: FAKE_BOARD_IR.replace('{"seed":2}', "garbage"), stm32kernel: ECHO_ARGV_JS }),
    )
    writeFileSync(join(cwd, "board.NET"), "x")
    await expect(run({ netlistPath: "board.NET", part: "STM32F405RGTx" })).rejects.toThrow("returned invalid JSON")
    await expect(run({ netlistPath: "board.NET", part: "nRF52840" })).rejects.toThrow(
      "omit part for the raw connection map",
    )
  })

  it("rejects an empty data directory before starting board_ir", async () => {
    const root = makeEnginesDir({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGV_JS })
    rmSync(join(root, "data", "stm32", "stm32f4.irpack"))
    const { run, cwd } = makeTool(root)
    writeFileSync(join(cwd, "board.NET"), "x")
    await expect(run({ netlistPath: "board.NET", part: "STM32F405RGTx" })).rejects.toThrow("none are installed")
    expect(existsSync(join(cwd, ".yoma"))).toBe(false)
  })

  it("bounds detection output and errors while preserving the error cause", async () => {
    const root = makeEnginesDir({ controller_map: ECHO_CONTROLLER_MAP + `console.error("x".repeat(100000));` })
    const { run, cwd } = makeTool(root)
    writeFileSync(join(cwd, "board.NET"), "x")
    const result = await run({ netlistPath: "board.NET" })
    expect(textOf(result).length).toBeLessThan(20_000)
    expect(textOf(result)).toContain("truncated")
    writeFakeExe(
      join(root, "bin"),
      "controller_map",
      `console.error("x".repeat(100000) + "\\nparse failed"); process.exitCode = 3;`,
    )
    const error = await run({ netlistPath: "board.NET" }).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("parse failed")
    expect((error as Error).message.length).toBeLessThan(9_000)
  })
  it("runs controller_map without part, prefixes detection notes, and reads the controller into details", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ controller_map: ECHO_CONTROLLER_MAP }))
    writeFileSync(join(cwd, "board.NET"), "netlist content")
    const result = await run({ netlistPath: "board.NET" })
    const text = textOf(result)
    expect(text).toContain("[detection]\nDetected main controller (auto): U2")
    expect(text).toContain(`"argv":"${join(cwd, "board.NET")}"`)
    expect(result.details).toEqual({
      mode: "map",
      netlist: join(cwd, "board.NET"),
      controller: "U2",
      lowConfidence: true,
    })
  })

  it("passes mainController through to controller_map", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ controller_map: ECHO_CONTROLLER_MAP }))
    writeFileSync(join(cwd, "board.NET"), "x")
    expect(textOf(await run({ netlistPath: "board.NET", mainController: "U2" }))).toContain("--main-controller U2")
  })

  it("truncates the raw map tighter than the general engine cap and says how to get the condensed IR", async () => {
    const { run, cwd } = makeTool(
      makeEnginesDir({
        controller_map: `console.log(JSON.stringify({ controller: { ref: "U1" }, pad: "x".repeat(30000) }));`,
      }),
    )
    writeFileSync(join(cwd, "board.NET"), "x")
    const result = await run({ netlistPath: "board.NET" })
    expect(textOf(result).length).toBeLessThan(RAW_MAP_MAX_CHARS + 700)
    expect(textOf(result)).toContain("re-run with `part` set to get the condensed board IR")
    expect(result.details.controller).toBe("U1") // 截断前先解析整份 stdout
    expect(JSON.parse(readFileSync(result.details.outputFile!, "utf8")).pad).toHaveLength(30000)
  })

  it("throws when the netlist file is missing or the engine is not built, and when controller_map exits non-zero", async () => {
    const ok = makeTool(makeEnginesDir({ controller_map: ECHO_CONTROLLER_MAP }))
    await expect(ok.run({ netlistPath: "nope.NET" })).rejects.toThrow(/netlist file not found/)
    const none = makeTool(makeEnginesDir({}))
    writeFileSync(join(none.cwd, "board.NET"), "x")
    await expect(none.run({ netlistPath: "board.NET" })).rejects.toThrow(/controller_map/)
    const bad = makeTool(makeEnginesDir({ controller_map: `console.error("parse error"); process.exitCode = 3;` }))
    writeFileSync(join(bad.cwd, "board.NET"), "x")
    await expect(bad.run({ netlistPath: "board.NET" })).rejects.toThrow(/controller_map failed \(exit 3\): parse error/)
  })

  it("runs board_ir with part, inlines stm32_map and cfg_seed, and reports the files", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGV_JS }))
    writeFileSync(join(cwd, "odrive.NET"), "x")
    const result = await run({ netlistPath: "odrive.NET", part: "STM32F405RGTx" })
    const text = textOf(result)
    expect(text).toContain("[detection]")
    expect(text).toContain("--part STM32F405RGTx")
    // board_ir 必须拿到内核与数据目录,否则外设建议无从谈起。
    expect(text).toContain("--stm32kernel ")
    expect(text).toContain("--data-dir ")
    expect(text).toContain(`Board IR files written to ${join(cwd, ".yoma", "tool-output")}`)
    expect(text).toContain('[stm32_map] peripheral suggestions with evidence/confidence:\n{"map":1}')
    expect(text).toContain('[cfg_seed] starter stm32config document (extend it, then validate):\n{"seed":2}')
    expect(result.details).toMatchObject({ mode: "board_ir", netlist: join(cwd, "odrive.NET"), part: "STM32F405RGTx" })
    expect(result.details.files!.boardIr).toContain(join(cwd, ".yoma", "tool-output", "netlist-"))
    for (const file of Object.values(result.details.files!)) expect(existsSync(file)).toBe(true)
  })

  it("honors a custom outDir and passes mainController through to board_ir", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGV_JS }))
    writeFileSync(join(cwd, "b.NET"), "x")
    const result = await run({
      netlistPath: "b.NET",
      part: "STM32F103C8Tx",
      outDir: "nested/ir-out",
      mainController: "U2",
    })
    expect(textOf(result)).toContain(`Board IR files written to ${join(cwd, "nested", "ir-out")}`)
    expect(textOf(result)).toContain("--main-controller U2")
    expect(existsSync(result.details.files!.stm32Map)).toBe(true)
  })

  it("throws when board_ir exits non-zero, and explains missing device data packs without spawning", async () => {
    const bad = makeTool(
      makeEnginesDir({ board_ir: `console.error("unknown part"); process.exitCode = 7;`, stm32kernel: ECHO_ARGV_JS }),
    )
    writeFileSync(join(bad.cwd, "b.NET"), "x")
    await expect(bad.run({ netlistPath: "b.NET", part: "STM32NOPE" })).rejects.toThrow(
      /board_ir failed \(exit 7\): unknown part/,
    )
    const noData = makeTool(makeEnginesDir({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGV_JS }, { noData: true }))
    writeFileSync(join(noData.cwd, "b.NET"), "x")
    await expect(noData.run({ netlistPath: "b.NET", part: "STM32F405RGTx" })).rejects.toThrow(
      /needs the STM32 device data packs .* Run netlist without `part`/,
    )
    expect(existsSync(join(noData.cwd, ".yoma", "b_board_ir.json"))).toBe(false)
  })

  it("does not spawn when the turn is already aborted, and aborts a running engine with its label", async () => {
    const slow = `await new Promise((r) => setTimeout(r, 5000)); console.log("{}");`
    const { run, cwd } = makeTool(makeEnginesDir({ controller_map: slow, board_ir: slow, stm32kernel: ECHO_ARGV_JS }))
    writeFileSync(join(cwd, "board.NET"), "x")
    const aborted = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)
    const spawn = vi.spyOn(engines, "runEngine")
    await expect(run({ netlistPath: "board.NET" }, aborted)).rejects.toThrow("controller_map was aborted")
    await expect(run({ netlistPath: "board.NET", part: "STM32F405RGTx" }, aborted)).rejects.toThrow(
      "board_ir was aborted",
    )
    expect(spawn).not.toHaveBeenCalled()
    const started = Date.now()
    await expect(run({ netlistPath: "board.NET" }, abortAfter(100))).rejects.toThrow("controller_map was aborted")
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("streams the engine's detection lines to the card while it runs", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ controller_map: ECHO_CONTROLLER_MAP }))
    writeFileSync(join(cwd, "board.NET"), "x")
    const updates: AgentToolResult<NetlistDetails>[] = []
    await run({ netlistPath: "board.NET" }, BACKGROUND_CONTEXT, (partial) => updates.push(partial))
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.some((u) => textOf(u).includes("Detected main controller"))).toBe(true)
    expect(updates[0]!.details).toEqual({ mode: "map", netlist: join(cwd, "board.NET") })
  })
})

// ─── 3. 真引擎 ────────────────────────────────────────────────────────────────

function realDataDir(): string | undefined {
  const candidates = [join(REAL_ENGINES, "data", "stm32"), process.env.YOMA_TEST_STM32_DATA ?? ""].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).some((f) => f.endsWith(".irpack"))) return dir
    } catch {
      // 不在就下一个
    }
  }
  return undefined
}

function realEnginesDir(dataDir?: string): string {
  const root = createTempDir()
  symlinkSync(join(REAL_ENGINES, "bin"), join(root, "bin"), "dir")
  if (dataDir) {
    mkdirSync(join(root, "data"), { recursive: true })
    symlinkSync(dataDir, join(root, "data", "stm32"), "dir")
  }
  return root
}

const haveEngines =
  process.platform !== "win32" &&
  existsSync(join(REAL_ENGINES, "bin", exe("controller_map"))) &&
  existsSync(join(REAL_ENGINES, "bin", exe("board_ir"))) &&
  existsSync(join(FIXTURES, "odrive_two_ax.NET"))
const dataDir = haveEngines ? realDataDir() : undefined

describe.skipIf(!haveEngines)("netlist against the real engines", () => {
  it.skipIf(!dataDir)(
    "keeps the kernel's MCU_UNKNOWN diagnostic when board_ir cannot resolve a part",
    async () => {
      const { run } = makeTool(realEnginesDir(dataDir))
      await expect(run({ netlistPath: join(FIXTURES, "odrive_two_ax.NET"), part: "STM32F999ZZZ" })).rejects.toThrow(
        "MCU_UNKNOWN",
      )
    },
    60_000,
  )
  it("maps the ODrive Altium netlist: U2 detected with low confidence, U4 as runner-up; mainController overrides", async () => {
    const { run } = makeTool(realEnginesDir())
    const result = await run({ netlistPath: join(FIXTURES, "odrive_two_ax.NET") })
    const text = textOf(result)
    expect(result.details).toMatchObject({ mode: "map", controller: "U2", lowConfidence: true })
    expect(text).toContain("[detection]\nDetected main controller (auto): U2")
    expect(text).toContain("Runner-up: U4")
    expect(text).toContain('"signal_pins"')
    expect(text).toContain("re-run with `part`") // 42 KB 的图被截到 10 000
    const forced = await run({ netlistPath: join(FIXTURES, "odrive_two_ax.NET"), mainController: "U4" })
    expect(forced.details.controller).toBe("U4")
  }, 60_000)

  it("maps a Nordic board (pca10056) — the raw map is MCU-agnostic", async () => {
    const { run } = makeTool(realEnginesDir())
    const result = await run({ netlistPath: join(FIXTURES, "pca10056.NET") })
    expect(textOf(result)).toContain("nRF5340")
    expect(result.details.controller).toBe("U2")
  }, 60_000)

  it.skipIf(!dataDir)(
    "board_ir on the ODrive with STM32F405RGT6 writes the three files with CAN/SPI suggestions",
    async () => {
      const { run, cwd } = makeTool(realEnginesDir(dataDir))
      const result = await run({ netlistPath: join(FIXTURES, "odrive_two_ax.NET"), part: "STM32F405RGT6" })
      const text = textOf(result)
      expect(result.details.mode).toBe("board_ir")
      expect(result.details.files!.stm32Map).toContain(join(cwd, ".yoma", "tool-output", "netlist-"))
      expect(existsSync(result.details.files!.boardIr)).toBe(true)
      expect(text).toContain('"part": "STM32F405RGTx"')
      expect(text).toContain('"instance": "CAN1"')
      expect(text).toContain("[cfg_seed] starter stm32config document")
      expect(text).toContain('"schemaVersion": 1')
    },
    120_000,
  )
})
