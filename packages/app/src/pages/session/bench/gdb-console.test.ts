import { describe, expect, test } from "vitest"
import { commandLineOf, condenseOutput, parseConsole, parseConsoleCommand, stopBlockOf } from "./gdb-console"

describe("控制台命令按 gdb 的习惯写法解析", () => {
  test("运行控制走 exec,继续不阻塞界面", () => {
    expect(parseConsoleCommand("c")).toEqual({
      action: "exec",
      op: "continue",
      expectRunning: true,
      waitMs: 100,
      onTimeout: "leave-running",
    })
    expect(parseConsoleCommand("n 3")).toMatchObject({ action: "exec", op: "next", count: 3 })
    expect(parseConsoleCommand("si")).toMatchObject({ action: "exec", op: "stepi" })
    expect(parseConsoleCommand("fin")).toMatchObject({ action: "exec", op: "finish" })
    expect(parseConsoleCommand("finish 2")).not.toHaveProperty("count")
  })

  test("断点、临时断点、条件断点、删除、观察点", () => {
    expect(parseConsoleCommand("b foc.c:45")).toEqual({ action: "break", at: "foc.c:45" })
    expect(parseConsoleCommand("tbreak main")).toEqual({ action: "break", at: "main", temporary: true })
    expect(parseConsoleCommand("b foc_update if g_foc.ticks > 100")).toEqual({
      action: "break",
      at: "foc_update",
      condition: "g_foc.ticks > 100",
    })
    expect(parseConsoleCommand("d 2")).toEqual({ action: "break", remove: "2" })
    expect(parseConsoleCommand("delete")).toEqual({ action: "break", remove: "all" })
    expect(parseConsoleCommand("rwatch g_adc_dma")).toEqual({ action: "break", watch: "g_adc_dma", mode: "r" })
  })

  test("其余原样交给 gdb,带 write(人亲手敲的);空行什么都不做", () => {
    expect(parseConsoleCommand("p/x g_foc")).toEqual({ action: "eval", command: "p/x g_foc", write: true })
    expect(parseConsoleCommand("set var g_adc_dma = 0")).toMatchObject({ action: "eval", write: true })
    // `b` 后面没东西不是断点命令:交给 gdb,由它回答
    expect(parseConsoleCommand("b")).toMatchObject({ action: "eval", command: "b" })
    expect(parseConsoleCommand("   ")).toBeUndefined()
  })

  test("按钮在控制台里记成同一行命令", () => {
    expect(commandLineOf({ action: "exec", op: "next" })).toBe("next")
    expect(commandLineOf({ action: "break", at: "foc.c:45", temporary: true })).toBe("tbreak foc.c:45")
    expect(commandLineOf({ action: "break", remove: "3" })).toBe("delete 3")
    expect(commandLineOf({ action: "stop" })).toBe("disconnect")
  })
})

describe("换帧只换面板,不碰和 agent 共用的 gdb 选中帧", () => {
  test("up / down / frame N 走面板", () => {
    expect(parseConsole("up")).toEqual({ kind: "frame", delta: 1 })
    expect(parseConsole("down 2")).toEqual({ kind: "frame", delta: -2 })
    expect(parseConsole("frame 3")).toEqual({ kind: "frame", level: 3 })
    expect(parseConsole("f 0")).toEqual({ kind: "frame", level: 0 })
    expect(parseConsole("select-frame 1")).toEqual({ kind: "frame", level: 1 })
  })

  test("只读的 frame / info frame 照常交给 gdb;thread N 拒", () => {
    expect(parseConsole("frame")).toEqual({ kind: "tool", input: { action: "eval", command: "frame", write: true } })
    expect(parseConsole("info frame")).toMatchObject({ kind: "tool", input: { action: "eval" } })
    expect(parseConsole("thread 2")).toEqual({ kind: "refuse", reason: "thread" })
    expect(parseConsole("thread")).toMatchObject({ kind: "tool" })
    expect(parseConsole("n")).toMatchObject({ kind: "tool", input: { op: "next" } })
  })
})

describe("回复压成控制台里的几行", () => {
  const exec = [
    "[gdb #1 halted @ Core/Src/foc.c:45 localhost:55968]",
    "■ stopped#3: breakpoint-hit breakpoint 2 (+0.003s)",
    "  #0 foc_zero_isense() at Core/Src/foc.c:45",
    "  #1 foc_start() at Core/Src/foc.c:64",
    "  locals: i=0",
    "  (目标已暂停 —— 在 exec continue 之前它不会再产生任何日志输出)",
  ].join("\n")

  test("去掉横幅与给模型的提示语,保留停止行、栈、局部变量", () => {
    expect(condenseOutput({ action: "exec", op: "continue" }, exec)).toBe(
      [
        "■ stopped#3: breakpoint-hit breakpoint 2 (+0.003s)",
        "  #0 foc_zero_isense() at Core/Src/foc.c:45",
        "  #1 foc_start() at Core/Src/foc.c:64",
        "  locals: i=0",
      ].join("\n"),
    )
  })

  test("eval 的回答原样给,只去横幅", () => {
    expect(condenseOutput({ action: "eval", command: "p x" }, "[gdb #1 halted @ a.c:1 x]\n$1 = 3")).toBe("$1 = 3")
  })

  test("从 status 全文里取出停止那一段", () => {
    const status = [
      "[gdb #1 halted @ Core/Src/foc.c:45 localhost:55968]",
      "elf: /x.elf",
      "core: Cortex-M4 r0p0",
      "breakpoints:",
      "  2 break foc.c:45 @ 0x080004b6",
      "■ stopped#3: breakpoint-hit breakpoint 2 (+0.003s)",
      "  #0 foc_zero_isense() at Core/Src/foc.c:45",
      "  (目标已暂停 —— 在 exec continue 之前它不会再产生任何日志输出)",
      "session log: /tmp/s.log",
    ].join("\n")
    expect(stopBlockOf(status)).toBe(
      "■ stopped#3: breakpoint-hit breakpoint 2 (+0.003s)\n  #0 foc_zero_isense() at Core/Src/foc.c:45",
    )
    expect(stopBlockOf("[gdb #1 running]")).toBeUndefined()
  })
})
