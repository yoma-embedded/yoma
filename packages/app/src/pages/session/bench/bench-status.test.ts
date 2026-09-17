/**
 * 夹具是照着契约造的(`host/tools/<名字>/contract.ts` 的 `*Details` 接口 + session.ts 的
 * 实际输出文本),不是照着这个解析器造的 —— 反过来写的测试只能证明代码没变。
 */
import { describe, expect, test } from "vitest"
import type { ToolPart } from "@yoma-desktop/kernel"
import {
  deriveBenchStatus,
  formatCommand,
  gdbEnded,
  gdbHeadline,
  logHeadline,
  parseLogSource,
  parseStopReport,
} from "./bench-status"

let seq = 0
function completed(tool: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown>, at = 1_000): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "completed", input, output, title: tool, metadata, time: { start: at - 10, end: at } },
  }
}
function errored(tool: string, input: Record<string, unknown>, error: string, at = 1_000): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "error", input, error, metadata: {}, time: { start: at - 10, end: at } },
  }
}
function running(tool: string, input: Record<string, unknown>, at = 1_000): ToolPart {
  seq++
  return {
    id: `prt${seq}`,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: { status: "running", input, time: { start: at } },
  }
}

// ---------------------------------------------------------------- flash

describe("flash", () => {
  const argv = ["openocd", "-f", "interface/stlink.cfg", "-c", "program build/app.elf verify reset exit"]

  test("exit 0 的烧录是成功,并带上记进 flash-state 的镜像", () => {
    const status = deriveBenchStatus([
      completed(
        "flash",
        { command: argv, elfPath: "/w/build/app.elf" },
        "** Programming Finished **\nrecorded /w/build/app.elf as the image on the target — gdb start will verify against it.",
        { command: argv, exitCode: 0, recordedElf: "/w/build/app.elf" },
        1_700_000_000_000,
      ),
    ])
    expect(status.flash).toEqual({
      ok: true,
      exitCode: 0,
      command: `openocd -f interface/stlink.cfg -c "program build/app.elf verify reset exit"`,
      image: "/w/build/app.elf",
      at: 1_700_000_000_000,
      error: undefined,
    })
  })

  test("非零退出是 completed 结果而不是 error —— 不能只看 status", () => {
    const status = deriveBenchStatus([
      completed("flash", { command: argv }, "flash `openocd` failed (exit 1):\nError: open failed", { command: argv, exitCode: 1 }),
    ])
    expect(status.flash?.ok).toBe(false)
    expect(status.flash?.exitCode).toBe(1)
  })

  test("工具抛错(超时 / 探针被占)时 metadata 是空的,退出码按未知算", () => {
    const status = deriveBenchStatus([errored("flash", { command: argv }, "探针被占用")])
    expect(status.flash?.ok).toBe(false)
    expect(status.flash?.exitCode).toBeNull()
    expect(status.flash?.error).toBe("探针被占用")
    // 命令行从 input 里捞 —— 这条路上 details 一个字都没有。
    expect(status.flash?.command).toContain("openocd")
  })

  test("末次为准", () => {
    const status = deriveBenchStatus([
      completed("flash", { command: argv }, "", { command: argv, exitCode: 1 }, 100),
      completed("flash", { command: argv }, "", { command: argv, exitCode: 0 }, 200),
    ])
    expect(status.flash?.ok).toBe(true)
    expect(status.flash?.at).toBe(200)
  })

  test("烧录不是仪器,所以不进 used;但在跑时进 busy", () => {
    const status = deriveBenchStatus([running("flash", { command: argv })])
    expect([...status.used]).toEqual([])
    expect(status.busy.has("flash")).toBe(true)
  })
})

// ---------------------------------------------------------------- log

describe("log", () => {
  const started = {
    action: "start",
    running: true,
    cursor: 0,
    totalLines: 0,
    dropped: 0,
    source: "serial /dev/cu.usbmodem1103 @ 115200 8N1",
    file: "/w/.yoma/logs/hw-20260918-101112345.log",
  }

  test("start 之后是采集中,来源解析成设备与波特率", () => {
    const status = deriveBenchStatus([completed("log", { action: "start", port: "/dev/cu.usbmodem1103" }, "", started, 500)])
    expect(status.log).toMatchObject({
      capturing: true,
      kind: "serial",
      port: "/dev/cu.usbmodem1103",
      baud: 115200,
      file: "/w/.yoma/logs/hw-20260918-101112345.log",
      at: 500,
    })
    expect(status.used.has("log")).toBe(true)
  })

  test("stop 之后是已停止,并带上来源的退出码", () => {
    const status = deriveBenchStatus([
      completed("log", { action: "start" }, "", started),
      completed("log", { action: "stop" }, "", { ...started, action: "stop", running: false, totalLines: 1024, exitCode: 0 }),
    ])
    expect(status.log?.capturing).toBe(false)
    expect(status.log?.totalLines).toBe(1024)
    expect(status.log?.exitCode).toBe(0)
  })

  test("采集器收掉之后 details 不再带 source,但界面仍要说得出刚才听的是哪个口", () => {
    const status = deriveBenchStatus([
      completed("log", { action: "start" }, "", started),
      // 真实形状:capture 已经没了,于是 source / file 整个不在 details 里,只剩 running:false。
      completed("log", { action: "status" }, "", { action: "status", running: false, cursor: 0, totalLines: 0, dropped: 0 }),
    ])
    expect(status.log?.capturing).toBe(false)
    expect(status.log?.port).toBe("/dev/cu.usbmodem1103")
    expect(status.log?.file).toBe("/w/.yoma/logs/hw-20260918-101112345.log")
  })

  test("一次抛错(metadata 空)不能被读成「采集停了」", () => {
    const status = deriveBenchStatus([
      completed("log", { action: "start" }, "", started),
      errored("log", { action: "start" }, "already capturing"),
    ])
    expect(status.log?.capturing).toBe(true)
  })

  test("`log ports`(还没 start 过)不许伪造一格「已停止」", () => {
    // detailsOf 在没有采集器时给的就是这一坨:running:false,零计数,没有 source / file。
    const status = deriveBenchStatus([
      completed("log", { action: "ports" }, "", { action: "ports", running: false, cursor: 0, totalLines: 0, dropped: 0 }),
    ])
    expect(status.log).toBeUndefined()
    // 碰过就算碰过 —— 只是不该冒出一次不存在的采集。
    expect(status.used.has("log")).toBe(true)
  })

  test("已经有采集之后,ports 照样只更新不清空", () => {
    const status = deriveBenchStatus([
      completed("log", { action: "start" }, "", started),
      completed("log", { action: "ports" }, "", { action: "ports", running: true, cursor: 0, totalLines: 0, dropped: 0 }),
    ])
    expect(status.log?.capturing).toBe(true)
    expect(status.log?.port).toBe("/dev/cu.usbmodem1103")
  })

  test("tcp 与 command 两种来源", () => {
    expect(parseLogSource("tcp localhost:19021")).toEqual({ kind: "tcp", port: "localhost:19021" })
    expect(parseLogSource("python3 tools/monitor.py --port 5")).toEqual({ kind: "command" })
  })

  test("logHeadline 只给设备名不给整条路径", () => {
    expect(logHeadline({ capturing: true, kind: "serial", port: "/dev/cu.usbmodem1103", baud: 115200, totalLines: 0, dropped: 0, at: 0 })).toBe(
      "cu.usbmodem1103 115200",
    )
  })
})

// ---------------------------------------------------------------- gdb

const STOP_OUTPUT = `[gdb #1 halted @ main.c:200 bp=1/6 localhost:3333]
■ stopped#1: breakpoint-hit breakpoint 2 (+0.153s)
  #0 main(argc=1) at src/main.c:200
  locals: i=3
breakpoints:
  2 break main.c:200 @ 0x080003c6`

const FAULT_OUTPUT = `[gdb #1 halted @ main.c:200 bp=1/6 localhost:3333]
■ stopped#2: signal-received SIGTRAP (+2.010s)
  故障(HardFault):强制进入,子故障在 CFSR 的 BusFault 段(PRECISERR),出错地址 0x00000000
  DFSR:BKPT HALTED
  出事 PC 0x080003c6 = main + 0x2e (src/main.c:200)
  #0 HardFault_Handler() at src/fault.c:24`

describe("gdb", () => {
  test("停在断点:状态、位置、报告、历史各就各位", () => {
    const status = deriveBenchStatus([
      completed(
        "gdb",
        { action: "exec", op: "continue" },
        STOP_OUTPUT,
        { action: "exec", state: "halted", epoch: 1, stopId: 1, connection: "localhost:3333", path: "/w/src/main.c", line: 200 },
        900,
      ),
    ])
    expect(status.gdb?.state).toBe("halted")
    expect(status.gdb?.location).toBe("main.c:200")
    expect(status.gdb?.path).toBe("/w/src/main.c")
    expect(status.gdb?.line).toBe(200)
    expect(status.gdb?.connection).toBe("localhost:3333")
    expect(status.gdb?.fault).toBeUndefined()
    expect(status.gdb?.report?.startsWith("■ stopped#1:")).toBe(true)
    expect(status.gdb?.stops).toHaveLength(1)
    expect(status.gdb?.stops[0]).toMatchObject({ n: 1, reason: "breakpoint-hit breakpoint 2 (+0.153s)" })
  })

  test("故障摘要只在输出文本里 —— details 一个故障字段都没有", () => {
    const status = deriveBenchStatus([
      completed("gdb", { action: "exec" }, FAULT_OUTPUT, { action: "exec", state: "halted", epoch: 1, stopId: 2 }),
    ])
    expect(status.gdb?.fault).toContain("HardFault")
    expect(status.gdb?.stops.at(-1)?.fault).toContain("HardFault")
    // 出事的那一行(main.c:200),不是现在停着的 HardFault 处理函数(fault.c:24)。
    expect(status.gdb?.faultLocation).toBe("main.c:200")
    expect(
      parseStopReport("■ stopped#2: breakpoint-hit\n  故障(BusFault):PRECISERR\n  出事 PC 0x080004b6 = foc_zero_isense + 10 in section .text (Core/Src/foc.c:45)")
        .faultLocation,
    ).toBe("foc.c:45")
  })

  test("同一次停止被 exec 与 status 各报一遍,历史里只留一条", () => {
    const meta = { action: "exec", state: "halted", epoch: 1, stopId: 1 }
    const status = deriveBenchStatus([
      completed("gdb", { action: "exec" }, STOP_OUTPUT, meta),
      completed("gdb", { action: "status" }, STOP_OUTPUT, { ...meta, action: "status" }),
    ])
    expect(status.gdb?.stops).toHaveLength(1)
  })

  test("跨 epoch(复位 / 重连)把旧现场整个作废", () => {
    const status = deriveBenchStatus([
      completed("gdb", { action: "exec" }, FAULT_OUTPUT, { action: "exec", state: "halted", epoch: 1, stopId: 2 }),
      completed("gdb", { action: "exec", op: "reset-halt" }, "[gdb #2 halted]", { action: "exec", state: "halted", epoch: 2, stopId: 0 }),
    ])
    expect(status.gdb?.epoch).toBe(2)
    expect(status.gdb?.fault).toBeUndefined()
    expect(status.gdb?.stops).toHaveLength(0)
  })

  test("掉线之后重新 attach:epoch 还是 1,但停止历史必须换成新目标的", () => {
    // MiSession 每次新建都从 epoch=1 / stopCount=0 起,所以光比 epoch 看不出换了目标。
    const halted = { action: "exec", state: "halted", epoch: 1, stopId: 1 }
    const status = deriveBenchStatus([
      completed("gdb", { action: "start" }, "", { action: "start", state: "halted", epoch: 1, stopId: 0 }, 10),
      completed("gdb", { action: "exec" }, STOP_OUTPUT, halted, 20),
      completed("gdb", { action: "status" }, "", { action: "status", state: "connection-lost", epoch: 1, stopId: 1 }, 30),
      completed("gdb", { action: "start" }, "", { action: "start", state: "halted", epoch: 1, stopId: 0 }, 40),
      completed(
        "gdb",
        { action: "exec" },
        `[gdb #1 halted @ blink.c:42 bp=1/6]\n■ stopped#1: breakpoint-hit breakpoint 1 (+0.010s)\n  #0 blink() at src/blink.c:42`,
        halted,
        50,
      ),
    ])
    expect(status.gdb?.location).toBe("blink.c:42")
    expect(status.gdb?.stops).toHaveLength(1)
    expect(status.gdb?.stops[0]).toMatchObject({ n: 1, location: "blink.c:42", at: 50 })
  })

  test("目标又跑起来之后不再显示旧位置,故障也一并作废", () => {
    const status = deriveBenchStatus([
      completed("gdb", { action: "exec" }, FAULT_OUTPUT, { action: "exec", state: "halted", epoch: 1, stopId: 2, path: "/w/src/main.c", line: 200 }),
      completed("gdb", { action: "exec" }, "[gdb #1 running]", { action: "exec", state: "running", epoch: 1, stopId: 2 }),
    ])
    expect(status.gdb?.state).toBe("running")
    expect(status.gdb?.location).toBeUndefined()
    // 一句早就处理完的故障不该一直挂在状态条上。
    expect(status.gdb?.fault).toBeUndefined()
  })

  test("没有 ■ 停止报告的输出里提到「故障」,不许凭空冒出一条没有现场的故障", () => {
    const parsed = parseStopReport("[gdb #1 halted]\n断点 2 装好了;命中时会打印 故障(HardFault) 相关寄存器")
    expect(parsed.stops).toHaveLength(0)
    expect(parsed.fault).toBeUndefined()
    expect(parsed.report).toBeUndefined()
  })

  test("no-session 翻成 none;一次抛错不改状态", () => {
    const attached = completed("gdb", { action: "start" }, "", { action: "start", state: "halted", epoch: 1, stopId: 0 })
    expect(deriveBenchStatus([attached, errored("gdb", { action: "eval" }, "no gdb session")]).gdb?.state).toBe("halted")
    const stopped = completed("gdb", { action: "stop" }, "", { action: "stop", state: "no-session", epoch: 0, stopId: 0 })
    expect(deriveBenchStatus([attached, stopped]).gdb?.state).toBe("none")
  })

  test("stop 收掉会话之后,故障现场与停止历史还在(details 的 epoch 归零不算换目标)", () => {
    // 真实形状:演示会话里 `gdb stop` 的 details 就是 { state: "no-session", epoch: 0, stopId: 0 }。
    const status = deriveBenchStatus([
      completed("gdb", { action: "exec" }, FAULT_OUTPUT, { action: "exec", state: "halted", epoch: 1, stopId: 2 }),
      completed("gdb", { action: "stop" }, "gdb session stopped", { action: "stop", state: "no-session", epoch: 0, stopId: 0 }),
    ])
    expect(status.gdb?.state).toBe("none")
    expect(status.gdb?.fault).toContain("HardFault")
    expect(status.gdb?.report?.startsWith("■ stopped#2:")).toBe(true)
    expect(status.gdb?.stops).toHaveLength(1)
    expect(gdbEnded(status.gdb)).toBe(true)
    expect(gdbHeadline(status.gdb)).toBe("ended main.c:200")
    // 从没停过的会话收掉之后,不算"已结束的现场" —— 面板回到空态。
    const bare = deriveBenchStatus([
      completed("gdb", { action: "stop" }, "", { action: "stop", state: "no-session", epoch: 0, stopId: 0 }),
    ])
    expect(gdbEnded(bare.gdb)).toBe(false)
    expect(gdbHeadline(bare.gdb)).toBeUndefined()
  })

  test("start 跑成了但 metadata 说不出状态时,落到 attached 而不是 none", () => {
    const status = deriveBenchStatus([completed("gdb", { action: "start" }, "", { action: "start" })])
    expect(status.gdb?.state).toBe("attached")
  })

  test("parseStopReport 只认最后一次停止之后的故障行", () => {
    const parsed = parseStopReport(`■ stopped#1: breakpoint-hit\n  故障(HardFault):旧的\n■ stopped#2: end-stepping-range\n  #0 main()`)
    expect(parsed.stops.map((stop) => stop.n)).toEqual([1, 2])
    expect(parsed.fault).toBeUndefined()
    expect(parsed.report?.startsWith("■ stopped#2:")).toBe(true)
  })

  test("gdbHeadline", () => {
    expect(gdbHeadline({ state: "halted", location: "main.c:200", epoch: 1, stops: [], at: 0 })).toBe("halted main.c:200")
    expect(gdbHeadline({ state: "connection-lost", epoch: 1, stops: [], at: 0 })).toBe("connection lost")
    expect(gdbHeadline(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------- la / scope

describe("la 与 scope", () => {
  test("末次采集的 id 与目录", () => {
    const status = deriveBenchStatus([
      completed("la", { action: "capture" }, "", { action: "capture", captureId: "la-20260918-101112345", dir: "/w/.yoma/la/la-20260918-101112345" }, 10),
      completed("la", { action: "summary" }, "", { action: "summary", captureId: "la-20260918-101112345", dir: "/w/.yoma/la/la-20260918-101112345" }, 20),
      completed("scope", { action: "capture" }, "", { action: "capture", captureId: "scope-abc", dir: "/w/.yoma/scope/scope-abc", directory: "/w" }, 30),
    ])
    expect(status.la).toEqual({ id: "la-20260918-101112345", dir: "/w/.yoma/la/la-20260918-101112345", at: 20 })
    expect(status.scope).toEqual({ id: "scope-abc", dir: "/w/.yoma/scope/scope-abc", at: 30 })
    expect([...status.used].sort()).toEqual(["la", "scope"])
  })

  test("没有 captureId 的动作(devices / list / decoders)不动这一格", () => {
    const status = deriveBenchStatus([
      completed("la", { action: "capture" }, "", { action: "capture", captureId: "la-1", dir: "/w/.yoma/la/la-1" }, 10),
      completed("la", { action: "devices" }, "", { action: "devices", device: { model: "DSLogic Plus" } }, 20),
    ])
    expect(status.la?.id).toBe("la-1")
  })

  test("scope 的 directory 是工程根,不能被当成采集目录", () => {
    const status = deriveBenchStatus([completed("scope", { action: "list" }, "", { action: "list", directory: "/w", truncated: false })])
    expect(status.scope).toBeUndefined()
    expect(status.used.has("scope")).toBe(true)
  })
})

// ---------------------------------------------------------------- 杂项

describe("防御式读取", () => {
  test("畸形的 metadata 不抛,只是这一格没有值", () => {
    const junk = completed("gdb", {}, "", { state: 42, epoch: "一", stopId: null, path: 7 })
    const status = deriveBenchStatus([junk, completed("log", {}, "", { running: "yes" }), completed("la", {}, "", { captureId: 9 })])
    expect(status.gdb?.state).toBe("none")
    expect(status.gdb?.path).toBeUndefined()
    expect(status.log).toBeUndefined()
    expect(status.la).toBeUndefined()
  })

  test("不是工作台工具的卡片一概不看", () => {
    const status = deriveBenchStatus([completed("bash", { command: "ls" }, "a\nb", { exitCode: 0 })])
    expect(status.used.size).toBe(0)
    expect(status.busy.size).toBe(0)
  })

  test("formatCommand 给带空白的参数加引号", () => {
    expect(formatCommand(["a", "b c", "d"])).toBe(`a "b c" d`)
  })
})
