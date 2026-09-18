import { describe, expect, test } from "vitest"
import { fixture } from "./fixtures/hw-parts"
import { describeGdb, gdbConclusion } from "./gdb-card"
import { parseGdbReport, parseStopReport } from "./gdb-report"

describe("parseGdbReport · 真 QEMU + 真 gdb 的 BusFault", () => {
  const part = fixture("gdb", "exec")
  const report = parseGdbReport(part.output)

  test("横幅:状态、位置、连接", () => {
    expect(report.state).toBe("halted")
    expect(report.location).toBe("Core/Src/main.c:136")
    expect(report.connection).toBe("localhost:62169")
  })

  test("故障:类型 / 标志位 / 出事地址 / 出事的那一行", () => {
    expect(report.fault?.kind).toBe("BusFault")
    expect(report.fault?.flags).toContain("PRECISERR")
    expect(report.fault?.address).toBe("BFAR=0xf0000000")
    // 停在 main.c:136(HardFault 处理函数),真正出事的是 foc.c:45 —— 两者不是一回事
    expect(report.fault?.location).toBe("foc.c:45")
    expect(report.fault?.stack).toContain("PSP")
  })

  test("入栈寄存器拆成对", () => {
    const regs = Object.fromEntries((report.fault?.stacked ?? []).map((item) => [item.key, item.value]))
    expect(regs.r0).toBe("0xdeadbeef")
    expect(regs.r2).toBe("0xf0000000")
    expect(regs.xpsr).toBe("0x41000000(线程模式)")
  })

  test("调用栈:五帧,帧号与位置都在", () => {
    expect(report.frames.map((frame) => frame.n)).toEqual([0, 1, 2, 3, 4])
    expect(report.frames[0]).toMatchObject({ func: "hardfault_report()", short: "main.c:136" })
    expect(report.frames[2]).toMatchObject({ func: "foc_zero_isense()", short: "foc.c:45" })
    // `<signal handler called>() at 0xfffffffd` 不是"文件:行",不该编一个出来
    expect(report.frames[1].short).toBeUndefined()
    expect(report.frames[1].at).toBe("0xfffffffd")
  })

  test("show 表达式的值收进 values,旁白与 locals 不混进去", () => {
    const values = Object.fromEntries(report.values.map((item) => [item.key, item.value]))
    expect(values.g_boot_stage).toBe("6")
    expect(values.g_adc_dma).toBe("0xf0000000")
    expect(report.values.some((item) => item.key.includes("目标已暂停"))).toBe(false)
    expect(report.locals).toBe("f=0x2001f7c0, exc_return=4294967293")
  })

  test("停止编号与原因", () => {
    expect(report.stop).toEqual({ n: 2, reason: "breakpoint-hit breakpoint 1 (+0.002s)" })
  })
})

describe("parseGdbReport · 其余动作", () => {
  test("start:server、核信息、镜像校验都读得到", () => {
    const report = parseGdbReport(fixture("gdb", "start").output)
    expect(report.via).toBe("qemu")
    expect(report.state).toBe("halted")
    expect(report.stop).toEqual({ n: 1, reason: "halted (initial attach)" })
    const notes = Object.fromEntries(report.notes.map((item) => [item.key, item.value]))
    expect(notes.core).toContain("Cortex-M4")
    expect(notes.image).toContain("verified against the last flash")
    // start 没有故障
    expect(report.fault).toBeUndefined()
  })

  test("break:断点号 / 地址 / 位置", () => {
    const report = parseGdbReport(fixture("gdb", "break").output)
    expect(report.breakpoints[0]).toEqual({ n: "1", at: "0x08000334", where: "Core/Src/main.c:136" })
  })

  test("eval:`$1 = …` 进 values", () => {
    const report = parseGdbReport(fixture("gdb", "eval").output)
    expect(report.values).toEqual([{ key: "$1", value: "0xf0000000" }])
  })

  test("stop:什么都认不出来,但也不抛", () => {
    const report = parseGdbReport(fixture("gdb", "stop").output)
    expect(report.frames).toEqual([])
    expect(report.fault).toBeUndefined()
  })
})

describe("parseStopReport 与卡片读的是同一份文本", () => {
  test("面板那一份和卡片那一份说的是同一个出事位置", () => {
    const part = fixture("gdb", "exec")
    expect(parseStopReport(part.output).faultLocation).toBe(parseGdbReport(part.output).fault?.location)
    expect(parseStopReport(part.output).location).toBe(parseGdbReport(part.output).location)
  })
})

describe("describeGdb / gdbConclusion", () => {
  test("故障优先:折叠态那一句说的是 BusFault 与出事的函数", () => {
    const part = fixture("gdb", "exec")
    const card = describeGdb(part.input, part.metadata, part.output)!
    const line = gdbConclusion(card)!
    expect(line.tone).toBe("fail")
    expect(line.text).toContain("BusFault")
    expect(line.text).toContain("PRECISERR")
    expect(line.text).toContain("foc_zero_isense()")
    expect(line.text).toContain("foc.c:45")
  })

  test("details 的 path/line 压过横幅(它才是本机路径)", () => {
    const part = fixture("gdb", "exec")
    const card = describeGdb(part.input, part.metadata, part.output)!
    expect(card.location).toBe("main.c:136")
    expect(card.path).toBe("/work/f405-motor-ctrl/Core/Src/main.c")
    expect(card.line).toBe(136)
  })

  test("start 没故障时报的是 server + 状态 + 位置", () => {
    const part = fixture("gdb", "start")
    const line = gdbConclusion(describeGdb(part.input, part.metadata, part.output)!)!
    expect(line.tone).toBe("ok")
    expect(line.text).toBe("qemu · halted · main.c:177")
  })

  test("eval 报最后一个值", () => {
    const part = fixture("gdb", "eval")
    expect(gdbConclusion(describeGdb(part.input, part.metadata, part.output)!)!.text).toBe("$1 = 0xf0000000")
  })

  test("形状不对 → undefined(回落通用卡)", () => {
    expect(describeGdb({}, {}, "[gdb #1 halted @ main.c:1 localhost:1]")).toBeUndefined()
    expect(describeGdb(undefined, undefined, undefined)).toBeUndefined()
    expect(describeGdb({ action: "explode" }, { action: null }, "")).toBeUndefined()
  })

  test("metadata 里塞垃圾也不抛", () => {
    expect(() => describeGdb({ action: "exec" }, { action: "exec", epoch: "1", path: 9 } as never, "")).not.toThrow()
    expect(() => parseGdbReport(undefined as never)).not.toThrow()
  })

  test("一次调用里两次停止:后一次才是现状", () => {
    const report = parseGdbReport(
      [
        "[gdb #1 halted @ a.c:1 localhost:1]",
        "■ stopped#1: breakpoint-hit breakpoint 1",
        "  故障(HardFault):FORCED",
        "  #0 first() at a.c:1",
        "■ stopped#2: end-stepping-range",
        "  #0 second() at b.c:2",
      ].join("\n"),
    )
    expect(report.stop?.n).toBe(2)
    expect(report.fault).toBeUndefined()
    expect(report.frames).toEqual([{ n: 0, func: "second()", at: "b.c:2", short: "b.c:2" }])
  })
})
