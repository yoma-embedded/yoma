/**
 * stm32config 工具(host/tools/stm32config/{contract,args,session}.ts)的验收,三层由假到真:
 *
 * 1. 契约与 argv 构造:七个命令、没有确认门、summary、`stm32kernel --help` 逐字对应的 argv。
 * 2. **假内核**(fixtures/fake-exe.ts 包成可执行文件):退出码分类学(0 / 1 诊断 / 2 用法 / 崩溃)、路径解析、
 *    配置文档预检、资源准备接线、schema 不要数据、中止、进度旁路和生成版本记录。
 * 3. **真内核**(仓库 engines/bin/stm32kernel 在时才跑):`schema` 不要数据;其余命令还要 irpack ——
 *    `engines/data/stm32` 里有就用它,没有就看 `YOMA_TEST_STM32_DATA`(指向一个装了 irpack 的目录),都没有就跳过。
 *    这层注入准备好的数据只验证工具与引擎协议;本机 CubeMX 的发现/转换/固件准备由资源模块测试独立验收。
 */

import {
  cpSync,
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
import { removeTempDir } from "./cleanup.ts"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { exe } from "../src/host/domain/engines.ts"
import * as engines from "../src/host/domain/engines.ts"
import { confirmNeeded, toolContract } from "../src/host/tools/contracts.ts"
import { buildStm32ConfigArgs, CONFIG_COMMANDS, needsDataDir } from "../src/host/tools/stm32config/args.ts"
import {
  STM32CONFIG_COMMANDS,
  STM32CONFIG_CONTRACT,
  type Stm32ConfigDetails,
  type Stm32ConfigInput,
  stm32ConfigSummary,
} from "../src/host/tools/stm32config/contract.ts"
import { createStm32ConfigTool, type Stm32ConfigToolOptions } from "../src/host/tools/stm32config/session.ts"
import { writeFakeExe } from "./fixtures/fake-exe.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")
const REAL_ENGINES = process.env.YOMA_TEST_ENGINES ?? join(REPO_ROOT, "engines")
const REAL_KERNEL = join(REAL_ENGINES, "bin", exe("stm32kernel"))

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoma-stm32config-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  // 被 abort 的假引擎在 Windows 上还会活一小会儿(taskkill 是 detached 的),它的 .exe 就在临时目录里;
  // rmSync 自带的重试并不真的等,见 ./cleanup.ts。
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir)
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

type Update = (partial: AgentToolResult<Stm32ConfigDetails>) => void

/** 测试夹具:bin/ 是假引擎,其余目录只供注入的资源准备函数使用,不是生产资源布局。 */
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

function makeTool(enginesDir: string, prepare?: Stm32ConfigToolOptions["prepare"]) {
  const cwd = createTempDir()
  const configDir = createTempDir()
  const prepareResources =
    prepare ??
    vi.fn(async () => {
      const dataDir = join(enginesDir, "data", "stm32")
      if (!existsSync(dataDir) || !readdirSync(dataDir).some((file) => file.endsWith(".irpack"))) {
        throw new Error("CubeMX database not configured (fixture)")
      }
      const manifestPath = join(enginesDir, "stm32-resources.json")
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, database: { hash: "fixture" } }))
      return { dataDir, fwDir: join(dataDir, "fw"), manifestPath, families: ["STM32F4"] }
    })
  const tool = createStm32ConfigTool({ enginesDir, configDir, prepare: prepareResources })
  const run = (params: Stm32ConfigInput, context: Context = BACKGROUND_CONTEXT, onUpdate: Update = () => {}) =>
    tool.execute("c1", params, onUpdate, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { tool, run, cwd, configDir, prepareResources }
}

function textOf(result: AgentToolResult<Stm32ConfigDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

const abortAfter = (ms: number): Context => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
}

const ECHO_ARGV_JS = `
import { mkdirSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "generate") mkdirSync(args[args.indexOf("--out") + 1], {recursive:true});
console.log(JSON.stringify({ argv: "argv: " + args.join(" ") }));`

// ─── 1. 契约与 argv ───────────────────────────────────────────────────────────

describe("stm32config contract", () => {
  it("has the seven commands, no confirm gate, and is registered in the contract table", () => {
    expect(STM32CONFIG_COMMANDS).toEqual([
      "list-mcus",
      "describe-mcu",
      "candidates",
      "solve-clock",
      "validate",
      "generate",
      "schema",
    ])
    expect(toolContract("stm32config")).toBe(STM32CONFIG_CONTRACT)
    expect(STM32CONFIG_CONTRACT.label).toBe("STM32 配置")
    for (const command of STM32CONFIG_COMMANDS) {
      expect(confirmNeeded("stm32config", { command, configPath: "b.json", out: "fw" })).toBeUndefined()
    }
    expect(STM32CONFIG_CONTRACT.guidelines).toHaveLength(2)
    // 守则里不写族名:那一行每轮都进系统提示词,压过工具描述,过时一次就把模型赶去手写寄存器。
    for (const line of STM32CONFIG_CONTRACT.guidelines) expect(line).not.toMatch(/STM32[A-Z]\d/)
    expect(STM32CONFIG_CONTRACT.description).not.toMatch(/confirm|ask the user before/i)
  })

  it("summary names the command and its subject", () => {
    expect(stm32ConfigSummary({ command: "list-mcus" })).toBe("list-mcus")
    expect(stm32ConfigSummary({ command: "list-mcus", family: "STM32F4", package: "LQFP64", minFlashKb: 512 })).toBe(
      "list-mcus STM32F4 LQFP64 ≥512KB",
    )
    expect(stm32ConfigSummary({ command: "describe-mcu", part: "STM32F405RGTx" })).toBe("describe-mcu STM32F405RGTx")
    expect(
      stm32ConfigSummary({ command: "candidates", peripheral: "USART1", signal: "TX", part: "STM32F405RGTx" }),
    ).toBe("candidates USART1 TX (STM32F405RGTx)")
    expect(stm32ConfigSummary({ command: "candidates", peripheral: "USART1", configPath: "board.json" })).toBe(
      "candidates USART1 (board.json)",
    )
    expect(stm32ConfigSummary({ command: "validate", configPath: "board.json" })).toBe("validate board.json")
    expect(stm32ConfigSummary({ command: "solve-clock" })).toBe("solve-clock")
    expect(stm32ConfigSummary({ command: "generate", configPath: "board.json", out: "fw" })).toBe(
      "generate board.json → fw",
    )
    expect(stm32ConfigSummary({ command: "schema" })).toBe("schema")
    expect(stm32ConfigSummary({})).toBe("")
  })
})

describe("stm32config buildArgs", () => {
  const dataDir = "/data"
  const fwDir = "/data/fw"

  it("schema needs no data dir; everything else does", () => {
    expect(buildStm32ConfigArgs({ command: "schema" }, dataDir, fwDir)).toEqual(["schema"])
    expect(needsDataDir("schema")).toBe(false)
    for (const command of STM32CONFIG_COMMANDS.filter((c) => c !== "schema")) expect(needsDataDir(command)).toBe(true)
    expect(CONFIG_COMMANDS).toEqual(["candidates", "solve-clock", "validate", "generate"])
  })

  it("builds list-mcus argv with filters", () => {
    expect(
      buildStm32ConfigArgs(
        { command: "list-mcus", family: "STM32F4", package: "LQFP64", minFlashKb: 512 },
        dataDir,
        fwDir,
      ),
    ).toEqual([
      "list-mcus",
      "--data-dir",
      dataDir,
      "--pretty",
      "--family",
      "STM32F4",
      "--package",
      "LQFP64",
      "--min-flash-kb",
      "512",
    ])
  })

  it("builds describe-mcu argv with part as a positional argument", () => {
    expect(buildStm32ConfigArgs({ command: "describe-mcu", part: "STM32F405RGTx" }, dataDir, fwDir)).toEqual([
      "describe-mcu",
      "STM32F405RGTx",
      "--data-dir",
      dataDir,
      "--pretty",
    ])
  })

  it("builds solve-clock / validate argv", () => {
    expect(buildStm32ConfigArgs({ command: "solve-clock", configPath: "/w/board.json" }, dataDir, fwDir)).toEqual([
      "solve-clock",
      "--config",
      "/w/board.json",
      "--data-dir",
      dataDir,
      "--pretty",
    ])
    expect(buildStm32ConfigArgs({ command: "validate", configPath: "/w/board.json" }, dataDir, fwDir)).toEqual([
      "validate",
      "--config",
      "/w/board.json",
      "--data-dir",
      dataDir,
      "--pretty",
    ])
  })

  it("builds generate argv with config, out and fw dir", () => {
    expect(
      buildStm32ConfigArgs({ command: "generate", configPath: "/w/board.json", out: "/w/fw" }, dataDir, fwDir),
    ).toEqual([
      "generate",
      "--config",
      "/w/board.json",
      "--out",
      "/w/fw",
      "--fw-dir",
      fwDir,
      "--data-dir",
      dataDir,
      "--pretty",
    ])
  })

  it("builds candidates argv from a config (with the optional signal) or from a part; config wins", () => {
    expect(
      buildStm32ConfigArgs(
        { command: "candidates", configPath: "/w/board.json", peripheral: "USART1", signal: "TX" },
        dataDir,
        fwDir,
      ),
    ).toEqual([
      "candidates",
      "--config",
      "/w/board.json",
      "--peripheral",
      "USART1",
      "--data-dir",
      dataDir,
      "--pretty",
      "--signal",
      "TX",
    ])
    expect(
      buildStm32ConfigArgs(
        { command: "candidates", part: "STM32F103C8Tx", peripheral: "ADC1", signal: "IN2" },
        dataDir,
        fwDir,
      ),
    ).toEqual([
      "candidates",
      "--part",
      "STM32F103C8Tx",
      "--peripheral",
      "ADC1",
      "--data-dir",
      dataDir,
      "--pretty",
      "--signal",
      "IN2",
    ])
    expect(
      buildStm32ConfigArgs(
        { command: "candidates", configPath: "/w/b.json", part: "STM32F103C8Tx", peripheral: "ADC1" },
        dataDir,
        fwDir,
      ).slice(0, 3),
    ).toEqual(["candidates", "--config", "/w/b.json"])
  })

  it("throws when a required field is missing", () => {
    expect(() => buildStm32ConfigArgs({ command: "describe-mcu" }, dataDir, fwDir)).toThrow(
      /describe-mcu requires part/,
    )
    expect(() => buildStm32ConfigArgs({ command: "validate" }, dataDir, fwDir)).toThrow(/validate requires configPath/)
    expect(() => buildStm32ConfigArgs({ command: "candidates", configPath: "/w/b.json" }, dataDir, fwDir)).toThrow(
      /candidates requires peripheral/,
    )
    expect(() => buildStm32ConfigArgs({ command: "candidates", peripheral: "ADC1" }, dataDir, fwDir)).toThrow(
      /candidates requires configPath or part/,
    )
    expect(() => buildStm32ConfigArgs({ command: "generate", configPath: "/w/b.json" }, dataDir, fwDir)).toThrow(
      /generate requires out/,
    )
  })

  it.each([-1, 0.5, Infinity, 0x100000000])("rejects invalid flash-size filter %s", (minFlashKb) => {
    expect(() => buildStm32ConfigArgs({ command: "list-mcus", minFlashKb }, dataDir, fwDir)).toThrow(
      "must be an integer",
    )
  })
})

// ─── 2. 假内核 ────────────────────────────────────────────────────────────────

describe("stm32config tool (fake kernel)", () => {
  it("prepares the config's MCU and firmware, forwards progress, and records versions only after generation succeeds", async () => {
    const source = createTempDir()
    const manifestPath = join(source, "manifest.json")
    const manifest = JSON.stringify({
      schemaVersion: 1,
      database: { hash: "db-version" },
      firmware: { version: "1.6.3" },
    })
    writeFileSync(manifestPath, manifest)
    const prepared = {
      dataDir: join(source, "devices"),
      fwDir: join(source, "firmware"),
      manifestPath,
      families: ["STM32G4"],
    }
    const prepare = vi.fn<NonNullable<Stm32ConfigToolOptions["prepare"]>>(async (options) => {
      options.onProgress?.("Preparing STM32G4 from local CubeMX")
      return prepared
    })
    const enginesDir = makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }, { noData: true })
    const { run, cwd, configDir } = makeTool(enginesDir, prepare)
    writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32G473RCTx" } }))
    const signal = new AbortController().signal
    const updates: string[] = []
    const spawn = vi.spyOn(engines, "runEngine")
    const result = await run(
      { command: "generate", configPath: "board.json", part: "STM32F405RGTx", out: "fw" },
      withAbortSignal(signal, BACKGROUND_CONTEXT),
      (partial) => updates.push(textOf(partial)),
    )
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        enginesDir,
        configDir,
        projectDir: cwd,
        part: "STM32G473RCTx",
        firmware: true,
        signal,
      }),
    )
    expect(prepare.mock.calls.map(([options]) => options.firmware)).toEqual([false, true])
    expect(spawn.mock.calls.map(([, args]) => args[0])).toEqual(["validate", "generate"])
    expect(updates).toContain("Preparing STM32G4 from local CubeMX\n")
    expect(JSON.parse(textOf(result).split("\n\n")[0]!).argv).toContain(
      `--fw-dir ${prepared.fwDir} --data-dir ${prepared.dataDir}`,
    )
    expect(result.details.resourceManifest).toBe(join(cwd, "fw", "stm32-resources.json"))
    expect(readFileSync(result.details.resourceManifest!, "utf8")).toBe(manifest)
  })

  it("does not replace a generated project's provenance when validation fails", async () => {
    const { run, cwd, prepareResources } = makeTool(
      makeEnginesDir({
        stm32kernel: `console.log('{"diagnostics":[{"code":"PIN_CONFLICT"}]}'); process.exitCode = 1;`,
      }),
    )
    writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32F405RGTx" } }))
    mkdirSync(join(cwd, "fw"))
    const manifestPath = join(cwd, "fw", "stm32-resources.json")
    writeFileSync(manifestPath, "previous generation")
    const result = await run({ command: "generate", configPath: "board.json", out: "fw" })
    expect(result.details.exitCode).toBe(1)
    expect(result.details.resourceManifest).toBeUndefined()
    expect(prepareResources).toHaveBeenCalledTimes(1)
    expect(prepareResources).toHaveBeenCalledWith(expect.objectContaining({ firmware: false }))
    expect(readFileSync(manifestPath, "utf8")).toBe("previous generation")
  })

  it("uses config-scoped query resources without requiring firmware and preserves malformed-config diagnostics", async () => {
    const { run, cwd, prepareResources } = makeTool(
      makeEnginesDir({
        stm32kernel: `console.log('{"diagnostics":[{"code":"DOC_PARSE"}]}'); process.exitCode = 1;`,
      }),
    )
    writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32G473RCTx" } }))
    await run({ command: "candidates", configPath: "board.json", part: "STM32F405RGTx", peripheral: "USART1" })
    expect(prepareResources).toHaveBeenLastCalledWith(
      expect.objectContaining({ part: "STM32G473RCTx", firmware: false }),
    )
    writeFileSync(join(cwd, "board.json"), "{")
    const malformed = await run({ command: "generate", configPath: "board.json", out: "fw" })
    expect(prepareResources).toHaveBeenLastCalledWith(expect.objectContaining({ part: undefined, firmware: false }))
    expect(textOf(malformed)).toContain("DOC_PARSE")
    expect(existsSync(join(cwd, "fw"))).toBe(false)
  })

  it("does not launch the engine when cancellation happens during resource preparation", async () => {
    const controller = new AbortController()
    const prepare = vi.fn<NonNullable<Stm32ConfigToolOptions["prepare"]>>(async () => {
      controller.abort()
      return { dataDir: "unused", manifestPath: "unused", families: [] }
    })
    const { run } = makeTool(makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }), prepare)
    const spawn = vi.spyOn(engines, "runEngine")
    await expect(run({ command: "list-mcus" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow(
      "was aborted",
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it("keeps the full describe-mcu result when the preview cannot fit all pads", async () => {
    const { run } = makeTool(
      makeEnginesDir({ stm32kernel: `console.log(JSON.stringify({ pads: "x".repeat(50000), lastPad: "PC15" }));` }),
    )
    const result = await run({ command: "describe-mcu", part: "STM32F429ZITx" })
    expect(textOf(result).length).toBeLessThan(25_000)
    expect(textOf(result)).toContain(`read ${result.details.outputFile}`)
    expect(JSON.parse(readFileSync(result.details.outputFile!, "utf8")).lastPad).toBe("PC15")
  })

  it("gives query guidance for candidates without inventing a config document", async () => {
    const { run } = makeTool(
      makeEnginesDir({
        stm32kernel: `console.log('{"diagnostics":[{"code":"PERIPH_UNKNOWN"}]}'); process.exitCode = 1;`,
      }),
    )
    const result = await run({ command: "candidates", part: "STM32F405RGTx", peripheral: "USART9" })
    expect(textOf(result)).toContain("correct the query parameters")
    expect(textOf(result)).not.toContain("Fix the config document")
  })

  it.each([
    [0, "panic"],
    [1, "{}"],
    [101, '{"error":"panic"}'],
    [1, ""],
  ])("rejects invalid success/diagnostic responses (exit %s, stdout %s)", async (code, output) => {
    const { run } = makeTool(
      makeEnginesDir({ stm32kernel: `console.log(${JSON.stringify(output)}); process.exitCode = ${code};` }),
    )
    await expect(run({ command: "list-mcus" })).rejects.toThrow(/invalid JSON|without diagnostic JSON|failed/)
  })

  it("bounds internal errors while retaining the final cause", async () => {
    const { run } = makeTool(
      makeEnginesDir({ stm32kernel: `console.error("x".repeat(100000) + "\\ncorrupt pack"); process.exitCode = 2;` }),
    )
    const error = await run({ command: "list-mcus" }).catch((error: Error) => error)
    expect((error as Error).message).toContain("corrupt pack")
    expect((error as Error).message.length).toBeLessThan(9_000)
  })

  it("rejects a directory config and propagates a resource preparation failure before running the engine", async () => {
    const root = makeEnginesDir({ stm32kernel: ECHO_ARGV_JS })
    const { run, cwd } = makeTool(root)
    await expect(run({ command: "validate", configPath: cwd })).rejects.toThrow("not a regular file")
    rmSync(join(root, "data", "stm32", "stm32f4.irpack"))
    await expect(run({ command: "list-mcus" })).rejects.toThrow("CubeMX database not configured (fixture)")
  })
  it("runs the kernel with prepared resources without freezing coverage in its description", async () => {
    const { tool, run } = makeTool(makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }))
    expect(tool.description).toBe(STM32CONFIG_CONTRACT.description)
    const result = await run({ command: "list-mcus" })
    expect(textOf(result)).toContain("argv: list-mcus --data-dir")
    expect(result.details).toEqual({ command: "list-mcus", exitCode: 0 })
  })

  it("resolves configPath and out against the session cwd, and refuses a missing config before spawning", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }))
    writeFileSync(join(cwd, "board.json"), "{}")
    const result = await run({ command: "validate", configPath: "board.json" })
    expect(JSON.parse(textOf(result)).argv).toContain(join(cwd, "board.json"))
    expect(result.details).toMatchObject({ configPath: join(cwd, "board.json") })
    await expect(run({ command: "validate", configPath: "missing.json" })).rejects.toThrow(
      `configPath not found or not a regular file: ${join(cwd, "missing.json")}`,
    )
    // describe-mcu 不要 config:一个不存在的 configPath 只是多余参数,不拦。
    await expect(run({ command: "describe-mcu", part: "STM32F4", configPath: "missing.json" })).resolves.toBeDefined()
  })

  it("treats exit 1 on config commands as a normal result with fix-it guidance", async () => {
    const { run, cwd } = makeTool(
      makeEnginesDir({ stm32kernel: `console.log('{"diagnostics":[{"severity":"error"}]}'); process.exitCode = 1;` }),
    )
    writeFileSync(join(cwd, "board.json"), "{}")
    const result = await run({ command: "validate", configPath: "board.json" })
    expect(textOf(result)).toContain('"diagnostics"')
    expect(textOf(result)).toContain("Exit code 1: the configuration has ERROR diagnostics")
    expect(result.details.exitCode).toBe(1)
  })

  it("treats exit 1 on describe-mcu as 'part not found' guidance, not a config error", async () => {
    const { run } = makeTool(
      makeEnginesDir({
        stm32kernel: `console.log('{"diagnostics":[{"code":"MCU_UNKNOWN","suggestion":"did you mean STM32F405RGTx?"}]}'); process.exitCode = 1;`,
      }),
    )
    const result = await run({ command: "describe-mcu", part: "STM32F405RGT6" })
    expect(textOf(result)).toContain("MCU_UNKNOWN")
    expect(textOf(result)).toContain("Exit code 1: read the diagnostics and correct the query parameters")
    expect(textOf(result)).not.toContain("the configuration has ERROR diagnostics")
  })

  it("appends build instructions with an explicit working directory after a successful generate", async () => {
    const { run, cwd } = makeTool(makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }))
    writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32F405RGTx" } }))
    const result = await run({ command: "generate", configPath: "board.json", out: "fw" })
    expect(textOf(result)).toContain(`Project generated at ${join(cwd, "fw")}`)
    expect(textOf(result)).toContain("change to that directory, then run:")
    expect(textOf(result)).toContain("cmake -G Ninja")
    expect(textOf(result)).toContain("cmake --build build")
    expect(result.details).toMatchObject({ command: "generate", exitCode: 0, out: join(cwd, "fw") })
  })

  it("throws on exit 2 (with stderr), on exit 2 even with JSON on stdout, and on a crash with empty stdout", async () => {
    const usage = makeTool(makeEnginesDir({ stm32kernel: `console.error("boom"); process.exitCode = 2;` }))
    await expect(usage.run({ command: "list-mcus" })).rejects.toThrow(/stm32kernel list-mcus failed \(exit 2\): boom/)
    // 真内核的 usage / 内部错误正是这个形态:stdout 上有 {"error":…},exit 2 —— 必须抛,不能当诊断回路。
    const json = makeTool(
      makeEnginesDir({
        stm32kernel: `console.log('{"error":"usage"}'); console.error("usage"); process.exitCode = 2;`,
      }),
    )
    await expect(json.run({ command: "list-mcus" })).rejects.toThrow(/failed \(exit 2\)/)
    const crash = makeTool(makeEnginesDir({ stm32kernel: `console.error("panic"); process.exitCode = 101;` }))
    await expect(crash.run({ command: "list-mcus" })).rejects.toThrow(/failed \(exit 101\): panic/)
  })

  it("schema never prepares resources; other commands preserve the resource module's actionable error", async () => {
    const { run, prepareResources } = makeTool(makeEnginesDir({ stm32kernel: ECHO_ARGV_JS }, { noData: true }))
    expect(textOf(await run({ command: "schema" }))).toContain("argv: schema")
    expect(prepareResources).not.toHaveBeenCalled()
    await expect(run({ command: "list-mcus" })).rejects.toThrow("CubeMX database not configured (fixture)")
    await expect(run({ command: "describe-mcu", part: "STM32F405RGTx" })).rejects.toThrow(
      "CubeMX database not configured (fixture)",
    )
  })

  it("does not spawn when the turn is already aborted, and aborts a running kernel with its label", async () => {
    const slow = makeTool(
      makeEnginesDir({ stm32kernel: `await new Promise((r) => setTimeout(r, 5000)); console.log("late");` }),
    )
    const spawn = vi.spyOn(engines, "runEngine")
    await expect(
      slow.run({ command: "list-mcus" }, withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)),
    ).rejects.toThrow("stm32kernel list-mcus was aborted")
    expect(spawn).not.toHaveBeenCalled()
    const started = Date.now()
    await expect(slow.run({ command: "list-mcus" }, abortAfter(100))).rejects.toThrow(
      "stm32kernel list-mcus was aborted",
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("streams the kernel's stderr progress to the card while it runs", async () => {
    const { run } = makeTool(
      makeEnginesDir({
        stm32kernel: `console.error("loaded pack STM32F4 (116 parts)"); await new Promise((r) => setTimeout(r, 50)); console.log("{}");`,
      }),
    )
    const updates: string[] = []
    const result = await run({ command: "list-mcus" }, BACKGROUND_CONTEXT, (partial) => {
      updates.push(textOf(partial))
      expect(partial.details).toEqual({ command: "list-mcus", exitCode: null })
    })
    expect(updates.some((u) => u.includes("loaded pack STM32F4"))).toBe(true)
    expect(textOf(result)).toBe("{}")
  })
})

// ─── 3. 真内核 ────────────────────────────────────────────────────────────────

/** 装了 irpack 的数据目录:仓库自己的 engines/data/stm32,或 YOMA_TEST_STM32_DATA;都没有就 undefined。 */
function realDataDir(): string | undefined {
  const candidates = [process.env.YOMA_TEST_STM32_DATA ?? "", join(REAL_ENGINES, "data", "stm32")].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).some((f) => f.endsWith(".irpack"))) return dir
    } catch {
      // 不在就下一个
    }
  }
  return undefined
}

/** 真 bin + 指定数据目录拼成一个 engines 根(软链)。 */
function realEnginesDir(dataDir?: string): string {
  const root = createTempDir()
  cpSync(join(REAL_ENGINES, "bin"), join(root, "bin"), { recursive: true, dereference: true })
  if (dataDir) {
    mkdirSync(join(root, "data"), { recursive: true })
    symlinkSync(dataDir, join(root, "data", "stm32"), process.platform === "win32" ? "junction" : "dir")
  }
  return root
}

const haveKernel = existsSync(REAL_KERNEL)
const dataDir = haveKernel ? realDataDir() : undefined

describe.skipIf(!haveKernel)("stm32config against the real stm32kernel", () => {
  it("schema prints the field reference without any device data", async () => {
    const { run } = makeTool(realEnginesDir())
    const result = await run({ command: "schema" })
    expect(textOf(result)).toContain("ConfigDoc")
    expect(result.details.exitCode).toBe(0)
  }, 30_000)

  describe.skipIf(!dataDir)("with device data packs", () => {
    it("generates the requested UART settings using database enum names", async () => {
      const { run, cwd } = makeTool(realEnginesDir(dataDir))
      writeFileSync(
        join(cwd, "uart.json"),
        JSON.stringify({
          schemaVersion: 1,
          mcu: { part: "STM32F405RGTx" },
          peripherals: {
            USART1: {
              mode: "Asynchronous",
              pins: { TX: "PA9", RX: "PA10" },
              params: { BaudRate: 9600, StopBits: "STOPBITS_2", WordLength: "WORDLENGTH_9B" },
            },
          },
        }),
      )
      const result = await run({ command: "generate", configPath: "uart.json", out: "generated uart" })
      expect(result.details.exitCode).toBe(0)
      const source = readFileSync(join(cwd, "generated uart", "Core", "Src", "usart.c"), "utf8")
      expect(source).toContain("huart1.Init.BaudRate = 9600;")
      expect(source).toContain("huart1.Init.StopBits = UART_STOPBITS_2;")
      expect(source).toContain("huart1.Init.WordLength = UART_WORDLENGTH_9B;")
    }, 60_000)
    it("list-mcus / describe-mcu / candidates answer from the packs; an orderable code is corrected", async () => {
      const { run } = makeTool(realEnginesDir(dataDir))
      const list = await run({ command: "list-mcus", family: "STM32F4", package: "LQFP64" })
      expect(textOf(list)).toContain("STM32F405RGTx")
      const describe = await run({ command: "describe-mcu", part: "STM32F405RGTx" })
      expect(textOf(describe)).toContain('"ipInstances"')
      expect(describe.details.exitCode).toBe(0)
      const orderable = await run({ command: "describe-mcu", part: "STM32F405RGT6" })
      expect(orderable.details.exitCode).toBe(1)
      expect(textOf(orderable)).toContain("MCU_UNKNOWN")
      expect(textOf(orderable)).toContain("STM32F405RGTx")
      expect(textOf(orderable)).toContain("Exit code 1: read the diagnostics")
      const candidates = await run({ command: "candidates", part: "STM32F405RGTx", peripheral: "USART1", signal: "TX" })
      expect(textOf(candidates)).toContain("PA9")
    }, 60_000)

    it("validate / solve-clock / generate run a minimal config end to end", async () => {
      const { run, cwd } = makeTool(realEnginesDir(dataDir))
      writeFileSync(
        join(cwd, "board.json"),
        JSON.stringify({
          schemaVersion: 1,
          mcu: { part: "STM32F405RGTx" },
          clock: { sources: { HSE: { kind: "crystal", freqHz: 8000000 } } },
        }),
      )
      const validate = await run({ command: "validate", configPath: "board.json" })
      expect(validate.details.exitCode).toBe(0)
      expect(textOf(validate)).toContain('"diagnostics": []')
      const clock = await run({ command: "solve-clock", configPath: "board.json" })
      expect(textOf(clock)).toContain('"freqs"')
      const generate = await run({ command: "generate", configPath: "board.json", out: "fw" })
      expect(generate.details.exitCode).toBe(0)
      expect(textOf(generate)).toContain(`Project generated at ${join(cwd, "fw")}`)
      expect(existsSync(join(cwd, "fw", "CMakeLists.txt"))).toBe(true)
      expect(existsSync(join(cwd, "fw", "cmake", "gcc-arm-none-eabi.cmake"))).toBe(true)
      const broken = await run({ command: "validate", configPath: "bad.json" }).catch((error: Error) => error.message)
      expect(broken).toContain("configPath not found")
      writeFileSync(join(cwd, "bad.json"), '{"mcu":{"part":"STM32F405RGTx"}}')
      const parse = await run({ command: "validate", configPath: "bad.json" })
      expect(parse.details.exitCode).toBe(1)
      expect(textOf(parse)).toContain("DOC_PARSE")
    }, 120_000)
  })
})
