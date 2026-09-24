import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { GdbSession } from "../../tools/gdb/mi-session.ts"
import { captureInspect } from "../../tools/gdb/target.ts"
import {
  asmLinesOf,
  exceptionOf,
  framesOf,
  localsOf,
  pickRegisters,
  registerNamesOf,
  sourceFilesOf,
  sourcePoint,
} from "./inspect.ts"
import type { MiTuple } from "./mi.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function reply(results: Record<string, unknown> = {}) {
  return { class: "done" as const, results, output: "" }
}

describe("inspect parsers", () => {
  it("reads a file:line and rejects addresses and bare names", () => {
    expect(sourcePoint("C:/a/b.c:12")).toEqual({ file: "C:/a/b.c", line: 12 })
    expect(sourcePoint("*0x10")).toEqual({})
    expect(sourcePoint("main")).toEqual({})
    expect(sourcePoint("file.c:0")).toEqual({})
  })

  it("keeps scalar values, aggregate types, and optimized-out text", () => {
    expect(
      localsOf([
        { name: "i", value: "3" },
        { name: "cfg", type: "gpio_cfg_t" },
        { name: "p", value: "<optimized out>" },
      ]),
    ).toEqual([
      { name: "i", value: "3" },
      { name: "cfg", type: "gpio_cfg_t" },
      { name: "p", value: "<optimized out>" },
    ])
  })

  it("keeps general registers and drops the rest when any general name is present", () => {
    const values = new Map([
      [0, "0x1"],
      [1, "0x2"],
      [2, "0x3"],
    ])
    expect(pickRegisters(["r0", "sp", "s0"], values).map((row) => row.name)).toEqual(["r0", "sp"])
    // QEMU 的 Cortex-M 目标描述:pc 之后是一串空名字,xpsr 是 25 号。空名字必须占位,否则后面全部错位。
    const names = registerNamesOf(["r0", "pc", "", "", "xpsr", "", "msp", "psp"])
    expect(names).toEqual(["r0", "pc", "", "", "xpsr", "", "msp", "psp"])
    const byNumber = new Map([
      [0, "0x1"],
      [1, "0x248"],
      [4, "0x81000000"],
      [6, "0x20001ff8"],
      [7, "0x20001bf0"],
    ])
    expect(pickRegisters(names, byNumber)).toEqual([
      { name: "r0", value: "0x1" },
      { name: "pc", value: "0x248" },
      { name: "xpsr", value: "0x81000000" },
      { name: "msp", value: "0x20001ff8" },
      { name: "psp", value: "0x20001bf0" },
    ])
    expect(framesOf([{ level: 0, func: "main", file: "main.c", line: "4", addr: "0x10" }])).toEqual([
      { level: 0, func: "main", file: "main.c", line: 4, addr: "0x10" },
    ])
  })
})

describe("source list and exception", () => {
  it("keeps local sources once, sorted, and drops files that are not on this machine", () => {
    const rows: MiTuple[] = [
      { file: "Core/Src/main.c", fullname: "/p/Core/Src/main.c" },
      { file: "main.c", fullname: "/p/Core/Src/main.c" },
      { file: "startup.s", fullname: "/p/startup.s" },
      { file: "foo.c", fullname: "/build-machine/foo.c" },
      { file: "<built-in>", fullname: "/p/<built-in>" },
      { file: "a.c" },
    ]
    const here = new Set(["/p/Core/Src/main.c", "/p/startup.s", "/p/<built-in>"])
    expect(sourceFilesOf(rows, (path) => here.has(path))).toEqual(["/p/Core/Src/main.c", "/p/startup.s"])
  })

  it("reads IPSR out of xpsr: thread mode, HardFault, an IRQ", () => {
    expect(exceptionOf([{ name: "xpsr", value: "0x81000000" }])).toEqual({ number: 0, name: "Thread mode" })
    expect(exceptionOf([{ name: "xpsr", value: "0x21000003" }])).toEqual({ number: 3, name: "HardFault" })
    expect(exceptionOf([{ name: "xpsr", value: "0x01000025" }])).toEqual({ number: 37, name: "IRQ 21" })
    // A 型核的 cpsr 不是 xpsr:低位是模式位,不能按 IPSR 读。
    expect(exceptionOf([{ name: "cpsr", value: "0x600001d3" }])).toBeUndefined()
    expect(exceptionOf([{ name: "r0", value: "0x3" }])).toBeUndefined()
  })
})

describe("disassembly window", () => {
  it("centres on pc even when gdb writes the address with a leading zero, and turns tabs into spaces", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      address: `0x0800${(0x400 + i * 2).toString(16).padStart(4, "0")}`,
      "func-name": "big",
      offset: String(i * 2),
      inst: "movs\tr3, #0",
    }))
    const pc = "0x8000464" // 第 50 条,写法少一个前导零
    const lines = asmLinesOf(rows, pc)
    expect(lines).toHaveLength(64)
    expect(lines[24]?.address).toBe("0x08000464")
    expect(lines[0]).toEqual({ address: "0x08000434", func: "big", offset: 52, inst: "movs r3, #0" })
    // pc 不在里面(比如函数外的地址窗口):从头给,不丢
    expect(asmLinesOf(rows.slice(0, 3), "0x1")).toHaveLength(3)
  })
})

describe("captureInspect", () => {
  it("sends nothing while the target is running", async () => {
    const sent: string[] = []
    const session = {
      state: "running",
      breakpoints: new Map([[1, { kind: "break", location: "main.c:4", units: 1, file: "main.c", line: 4 }]]),
      usedUnits: () => 1,
      send: async (command: string) => {
        sent.push(command)
        return reply()
      },
    } as unknown as GdbSession
    const inspect = await captureInspect(session, { breakpointUnits: 6 })
    expect(sent).toEqual([])
    expect(inspect.frames).toEqual([])
    expect(inspect.registers).toEqual([])
    expect(inspect.breakpoints).toEqual([
      { number: 1, kind: "break", location: "main.c:4", file: "main.c", line: 4, enabled: true },
    ])
    expect(inspect.breakpointBudget).toEqual({ used: 1, total: 6 })
  })

  it("reads the selected frame, locals, and registers, and only keeps a path that exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yoma-gdb-inspect-"))
    dirs.push(dir)
    const file = join(dir, "main.c")
    writeFileSync(file, "int main(void) { return 0; }\n")
    const sent: string[] = []
    const answers: Record<string, { class: "done" | "error"; results: Record<string, unknown>; output: string }> = {
      "-file-list-exec-source-files": reply({ files: [{ file: "main.c", fullname: file }] }),
      "-thread-info": reply({ "current-thread-id": "1" }),
      "-stack-info-frame": reply({ frame: { level: "0" } }),
      "-stack-list-frames 0 7": reply({
        stack: [{ frame: { level: "0", func: "main", file: "main.c", fullname: file, line: "4", addr: "0x10" } }],
      }),
      "-stack-list-variables --thread 1 --frame 0 --simple-values": reply({
        variables: [
          { name: "i", value: "3" },
          { name: "cfg", type: "gpio_cfg_t" },
          { name: "p", value: "<optimized out>" },
        ],
      }),
      "-data-evaluate-expression --thread 1 --frame 0 \"cfg\"": reply({ value: "{pin = 5, mode = 1}" }),
      "-data-disassemble -a 0x10 -- 0": reply({
        asm_insns: [{ address: "0x00000010", "func-name": "main", offset: "0", inst: "push\t{r7, lr}" }],
      }),
      "-data-evaluate-expression --thread 1 --frame 0 \"g_mode\"": reply({ value: "2" }),
      "-data-evaluate-expression --thread 1 --frame 0 \"nosuch\"": {
        class: "error",
        results: { msg: 'No symbol "nosuch" in current context.' },
        output: "",
      },
      "-data-list-register-names": reply({ "register-names": ["r0", "sp", "s0"] }),
      "-data-list-register-values --thread 1 --frame 0 x": reply({
        "register-values": [
          { number: "0", value: "0x1" },
          { number: "1", value: "0x2" },
          { number: "2", value: "0x3" },
        ],
      }),
    }
    const session = {
      state: "halted",
      epoch: 1,
      stopCount: 3,
      inspectVersion: 0,
      breakpoints: new Map([[1, { kind: "break", location: "main.c:4", units: 1, file, line: 4 }]]),
      usedUnits: () => 1,
      send: async (command: string) => {
        sent.push(command)
        return answers[command] ?? reply()
      },
    } as unknown as GdbSession
    const inspect = await captureInspect(session, { breakpointUnits: 6 }, 0, ["g_mode", "g_mode = 3", "reset_board()", "nosuch"])
    // 选中帧是和 agent 共用的:界面读哪一帧都不许动它。
    expect(sent).toEqual([
      "-file-list-exec-source-files",
      "-thread-info",
      "-stack-info-frame",
      "-stack-list-frames 0 7",
      "-stack-list-variables --thread 1 --frame 0 --simple-values",
      "-data-evaluate-expression --thread 1 --frame 0 \"cfg\"",
      "-data-list-register-names",
      "-data-list-register-values --thread 1 --frame 0 x",
      "-data-disassemble -a 0x10 -- 0",
      "-data-evaluate-expression --thread 1 --frame 0 \"g_mode\"",
      // 写目标的、调函数的那两条不发:闸门同 eval,外加 inferior call
      "-data-evaluate-expression --thread 1 --frame 0 \"nosuch\"",
    ])

    // 停着不动时再问一次:整份读数来自缓存,一条 MI 都不发(界面每 2.5 秒轮询一次)。
    sent.length = 0
    const again = await captureInspect(session, { breakpointUnits: 6 }, 0, ["g_mode", "g_mode = 3", "reset_board()", "nosuch"])
    expect(sent).toEqual([])
    expect(again.watches).toEqual(inspect.watches)
    // 任何非 status 的动作都会动 inspectVersion(`set var` 不产生新停止,值却变了):缓存作废。
    ;(session as unknown as { inspectVersion: number }).inspectVersion++
    await captureInspect(session, { breakpointUnits: 6 }, 0, ["g_mode"])
    expect(sent).toContain("-stack-list-frames 0 7")
    expect(inspect.pc).toBe("0x10")
    expect(inspect.disassembly).toEqual([{ address: "0x00000010", func: "main", offset: 0, inst: "push {r7, lr}" }])
    expect(inspect.watches).toEqual([
      { expr: "g_mode", value: "2" },
      { expr: "g_mode = 3", error: "writes the target — not evaluated" },
      { expr: "reset_board()", error: "calls a function on the target — not evaluated" },
      { expr: "nosuch", error: 'No symbol "nosuch" in current context.' },
    ])
    expect(sent.some((command) => command.startsWith("-stack-select-frame"))).toBe(false)
    expect(inspect.selectedFrame).toBe(0)
    expect(inspect.frames[0]).toMatchObject({ func: "main", file: "main.c", line: 4, path: file })
    expect(inspect.frames[0]).not.toHaveProperty("fullname")
    expect(inspect.locals.map((item) => item.name)).toEqual(["i", "cfg", "p"])
    // cfg 只有类型:再求一次整段值给界面展开。有 value 的(含 <optimized out>)不再多问。
    expect(inspect.locals.find((item) => item.name === "cfg")?.detail).toBe("{pin = 5, mode = 1}")
    expect(inspect.sources).toEqual([file])
    expect(inspect.registers.map((item) => item.name)).toEqual(["r0", "sp"])
    expect(inspect.breakpointBudget).toEqual({ used: 1, total: 6 })
  })
})
