/**
 * 目标身份的纯函数。
 *
 * 为什么值得单独钉:目标卡顶上那一行是**给人看的事实**,写错了不会报错,只会让用户拿着一个
 * 猜来的型号去查手册。所以断言的形状都是"没说就是没有":命令里没有目标名 → 空;
 * 输出里没有目标名 → 空;两边都没有 → 只剩工程目录名。
 *
 * 语料**逐字取自演示会话**(`_ui-lab/demo` 里那段真 openocd + 真 gdb/QEMU 的 HardFault 调试),
 * 不是照着解析器编的 —— 反过来写的测试只能证明代码没变。
 */
import { describe, expect, test } from "vitest"
import type { ToolPart } from "@yoma-desktop/kernel"
import {
  chipFromFlashCommand,
  deriveTargetIdentity,
  parseFlashOutput,
  parseGdbIdentity,
  projectNameOf,
  targetSpec,
} from "./target-identity"

/** 真 openocd 的输出(取自演示会话的 flash 卡片,逐字)。 */
const OPENOCD_OUTPUT = [
  "Open On-Chip Debugger 0.12.0 (2026-04-11-09:22)",
  'Info : auto-selecting first available session transport "hla_swd".',
  "Info : clock speed 1800 kHz",
  "Info : STLINK V3J13M4 (API v3) VID:PID 0483:374F",
  "Info : Target voltage: 3.243000",
  "Info : [stm32f4x.cpu] Cortex-M4 r0p1 processor detected",
  "Info : [stm32f4x.cpu] target has 6 breakpoints, 4 watchpoints",
  "** Programming Finished **",
].join("\n")

/** 真 gdb start 的回执(同一份演示会话)。 */
const GDB_START_OUTPUT = [
  "[gdb #1 halted @ Core/Src/main.c:177 localhost:62169]",
  "attached to localhost:62169 via qemu, gdb /Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin/arm-none-eabi-gdb",
  "core: Cortex-M4 r0p0 (breakpoint budget unknown — the FPB did not report one; gdb's own reply decides)",
  "note: qemu does not support watchpoints at all",
  "■ stopped#1: halted (initial attach)",
  "  #0 Reset_Handler() at Core/Src/main.c:177",
].join("\n")

/** 演示会话里那条烧录命令,逐字。 */
const FLASH_ARGV = ["sh", "tools/flash-openocd.sh", "build/f405-motor-ctrl.elf"]

let seq = 0
function completed(tool: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "completed", input, output, title: tool, metadata, time: { start: 990, end: 1_000 } },
  }
}
function running(tool: string, input: Record<string, unknown>, output?: string): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "running", input, output, time: { start: 990 } },
  }
}
function errored(tool: string, input: Record<string, unknown>): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "error", input, error: "probe busy", metadata: {}, time: { start: 990, end: 1_000 } },
  }
}

describe("烧录输出里的目标身份", () => {
  test("认得出 openocd 的目标名、内核与探针", () => {
    expect(parseFlashOutput(OPENOCD_OUTPUT)).toEqual({
      target: "stm32f4x",
      core: "Cortex-M4",
      probe: "STLINK V3J13M4",
    })
  })

  test("探针型号到型号为止,不把 VID:PID 一起拖进来", () => {
    expect(parseFlashOutput(OPENOCD_OUTPUT).probe).not.toContain("0483")
  })

  test("没说就是没有 —— 不从任何别的行里凑一个出来", () => {
    expect(parseFlashOutput("wrote 16384 bytes from file build/x.elf\n** Verified OK **")).toEqual({})
    expect(parseFlashOutput("")).toEqual({})
  })

  test("J-Link / CMSIS-DAP 也认", () => {
    expect(parseFlashOutput("Connected to J-Link V11 compiled Mar 2026").probe).toBe("J-Link V11")
    expect(parseFlashOutput("Using CMSIS-DAP v2 interface").probe).toBe("CMSIS-DAP")
  })
})

describe("烧录命令行里的目标", () => {
  test("openocd 的 target/*.cfg", () => {
    expect(
      chipFromFlashCommand([
        "openocd",
        "-f",
        "interface/stlink.cfg",
        "-f",
        "target/stm32f4x.cfg",
        "-c",
        "program x.elf",
      ]),
    ).toBe("stm32f4x")
  })

  test("interface/*.cfg 不是目标 —— 那是探针", () => {
    expect(chipFromFlashCommand(["openocd", "-f", "interface/stlink.cfg"])).toBeUndefined()
  })

  test("厂商 CLI 的 -device / --device= 两种写法", () => {
    expect(chipFromFlashCommand(["JLinkExe", "-device", "STM32F405RG", "-if", "SWD"])).toBe("STM32F405RG")
    expect(chipFromFlashCommand(["probe-rs", "download", "--device=STM32F405RG"])).toBe("STM32F405RG")
  })

  test("下一个参数是另一个开关时不当成型号", () => {
    expect(chipFromFlashCommand(["JLinkExe", "-device", "-if", "SWD"])).toBeUndefined()
  })

  test("命令是一个脚本时什么都认不出来(演示工程就是这种)", () => {
    expect(chipFromFlashCommand(FLASH_ARGV)).toBeUndefined()
  })
})

describe("gdb 回执里的核与 server", () => {
  test("core: 那行剥掉括号说明", () => {
    const parsed = parseGdbIdentity(GDB_START_OUTPUT)
    expect(parsed.core).toBe("Cortex-M4 r0p0")
    expect(parsed.via).toBe("qemu")
  })

  test("括号里只有说明时不会把它当成核名的一部分", () => {
    expect(parseGdbIdentity("core: Cortex-M33 (no FPB)").core).toBe("Cortex-M33")
  })

  test("没有认核那行就是没有", () => {
    expect(parseGdbIdentity("■ stopped#2: breakpoint-hit breakpoint 1")).toEqual({})
  })
})

describe("projectNameOf", () => {
  test("目录末尾的斜杠不算一层,反斜杠也认", () => {
    expect(projectNameOf("/Users/ben/ws/f405-motor-ctrl")).toBe("f405-motor-ctrl")
    expect(projectNameOf("/Users/ben/ws/f405-motor-ctrl/")).toBe("f405-motor-ctrl")
    expect(projectNameOf("D:\\ws\\blinky")).toBe("blinky")
  })
})

describe("deriveTargetIdentity", () => {
  test("什么都没发生过时只剩工程目录名", () => {
    expect(deriveTargetIdentity([], "/Users/ben/ws/f405-motor-ctrl")).toEqual({
      project: "f405-motor-ctrl",
      chip: undefined,
      core: undefined,
      probe: undefined,
      via: undefined,
      sources: [],
    })
  })

  test("演示会话那两张卡片:芯片与探针来自烧录,核与 server 来自 gdb", () => {
    const identity = deriveTargetIdentity(
      [
        completed("flash", { command: FLASH_ARGV }, OPENOCD_OUTPUT, { command: FLASH_ARGV, exitCode: 0 }),
        completed("gdb", { action: "start" }, GDB_START_OUTPUT, { action: "start", state: "halted" }),
      ],
      "/Users/ben/ws/f405-motor-ctrl",
    )
    expect(identity.chip).toBe("stm32f4x")
    expect(identity.probe).toBe("STLINK V3J13M4")
    // gdb 是从 CPUID 读的,比烧录输出里那句 `Cortex-M4` 细一档,它压过后者。
    expect(identity.core).toBe("Cortex-M4 r0p0")
    expect(identity.via).toBe("qemu")
    expect(identity.sources).toEqual(["flash", "gdb"])
    expect(targetSpec(identity)).toBe("stm32f4x · Cortex-M4 r0p0 · STLINK V3J13M4")
  })

  test("命令行里写明的目标压过输出里认出来的(换了一块板时命令先变)", () => {
    const identity = deriveTargetIdentity(
      [
        completed(
          "flash",
          {},
          OPENOCD_OUTPUT,
          { command: ["JLinkExe", "-device", "STM32F405RG"], exitCode: 0 },
        ),
      ],
      "/ws/x",
    )
    expect(identity.chip).toBe("STM32F405RG")
  })

  test("只有 gdb 说过话时 sources 只记 gdb,芯片仍然是空的", () => {
    const identity = deriveTargetIdentity(
      [completed("gdb", { action: "start" }, "attached to localhost:3333 via openocd\ncore: Cortex-M33")],
      "/ws/blinky",
    )
    expect(identity.sources).toEqual(["gdb"])
    expect(identity.core).toBe("Cortex-M33")
    expect(identity.chip).toBeUndefined()
  })

  test("只认出探针也算 flash 说过话(不然 tooltip 会说这一行没有出处)", () => {
    const identity = deriveTargetIdentity([completed("flash", {}, "Connected to J-Link V11")], "/ws/x")
    expect(identity.probe).toBe("J-Link V11")
    expect(identity.sources).toEqual(["flash"])
  })

  test("第二次烧录认不出目标时**不沿用**上一次的(可能换了一块板)", () => {
    const identity = deriveTargetIdentity(
      [
        completed("flash", {}, OPENOCD_OUTPUT),
        completed("flash", {}, "wrote 16384 bytes from file build/x.elf\n** Verified OK **"),
      ],
      "/ws/x",
    )
    expect(identity.chip).toBeUndefined()
    expect(identity.probe).toBeUndefined()
    expect(identity.sources).toEqual([])
  })

  test("烧录还在跑时只合并,不否定上一次的结论(活尾巴还没说完)", () => {
    const identity = deriveTargetIdentity(
      [completed("flash", {}, OPENOCD_OUTPUT), running("flash", {}, "Open On-Chip Debugger 0.12.0")],
      "/ws/x",
    )
    expect(identity.chip).toBe("stm32f4x")
    expect(identity.probe).toBe("STLINK V3J13M4")
  })

  test("烧录抛错(探针被占)是一次真的终局:身份跟着清空", () => {
    const identity = deriveTargetIdentity([completed("flash", {}, OPENOCD_OUTPUT), errored("flash", {})], "/ws/x")
    expect(identity.chip).toBeUndefined()
  })

  test("gdb 的核与 server 沿用 —— 那两句只在 start 的回执里说一次", () => {
    const identity = deriveTargetIdentity(
      [
        completed("gdb", { action: "start" }, GDB_START_OUTPUT),
        completed("gdb", { action: "exec" }, "■ stopped#7: breakpoint-hit breakpoint 2 (+0.153s)"),
      ],
      "/ws/x",
    )
    expect(identity.core).toBe("Cortex-M4 r0p0")
    expect(identity.via).toBe("qemu")
  })

  test("别的工具一个字都不看(bash 里 grep 一句 openocd 日志不该点亮目标)", () => {
    const identity = deriveTargetIdentity([completed("bash", {}, OPENOCD_OUTPUT)], "/ws/x")
    expect(identity).toEqual({
      project: "x",
      chip: undefined,
      core: undefined,
      probe: undefined,
      via: undefined,
      sources: [],
    })
  })
})
