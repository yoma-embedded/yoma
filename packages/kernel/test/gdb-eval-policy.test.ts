/**
 * eval 闸门(host/domain/gdb/eval-policy.ts)的验收:阁楼 attic/test/gdb.test.ts 的 classifyEval 那组原样移植,
 * 再加上这一版新认的三类:经 gdb server 改写 flash 的 load / flash-erase、表达式里藏着的赋值、行首 `|` 管道。
 * 每一条 blocked / mutating 都对应一种实测能把会话弄坏或悄悄写目标的写法,不是风格偏好。
 */

import { describe, expect, it } from "vitest"

import { classifyEval, expressionWrites, RUN_CONTROL_OPS } from "../src/host/domain/gdb/eval-policy.ts"

describe("classifyEval", () => {
  it("会污染 MI 流的一律拒绝 —— 包括行首的 | (gdb 的 pipe 别名)", () => {
    for (const cmd of [
      "shell ls",
      "!ls",
      "pipe info registers | cat",
      "| p 1+1 | cat",
      "python print(1)",
      "py print(1)",
      "set logging on",
      "set logging redirect on",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("blocked")
    }
  })

  it("会接管会话的也拒绝", () => {
    for (const cmd of [
      "target remote :1234",
      "file /tmp/a.elf",
      "detach",
      "run",
      "start",
      "starti",
      "quit",
      "kill",
      "source cmds.gdb",
      "define hook-stop",
      "compile code x = 1",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("blocked")
    }
  })

  it("运行控制转发到 exec,带参数也转(`continue 3` 不许从这里跑起来)", () => {
    expect(classifyEval("continue")).toEqual({ kind: "reroute", op: "continue" })
    expect(classifyEval("c")).toEqual({ kind: "reroute", op: "continue" })
    expect(classifyEval("si")).toEqual({ kind: "reroute", op: "stepi" })
    expect(classifyEval("continue 3")).toEqual({ kind: "reroute", op: "continue" })
    expect(classifyEval("next 5")).toEqual({ kind: "reroute", op: "next" })
    expect(classifyEval("finish")).toEqual({ kind: "reroute", op: "finish" })
    for (const op of RUN_CONTROL_OPS) expect(classifyEval(op)).toEqual({ kind: "reroute", op })
  })

  it("exec 没有的运行控制动词(until / advance / nexti)不转发也不放行", () => {
    for (const cmd of ["until 42", "advance main", "ni", "nexti 3", "u"]) {
      const v = classifyEval(cmd)
      expect(v.kind, cmd).toBe("blocked")
      expect(v.kind === "blocked" && v.reason).toContain("gdb exec")
    }
  })

  it("断点从这里下会绕开预算表:指向 gdb break", () => {
    for (const cmd of ["break main", "b main.c:42", "tbreak foo", "watch g_state", "delete 2", "d", "hbreak *0x100"]) {
      const v = classifyEval(cmd)
      expect(v.kind, cmd).toBe("blocked")
      expect(v.kind === "blocked" && v.reason).toContain("gdb break")
    }
    // 不动单元数的断点操作照常放行
    expect(classifyEval("condition 1 x > 2").kind).toBe("read")
    expect(classifyEval("info breakpoints").kind).toBe("read")
  })

  it("写目标的要显式 write:true", () => {
    for (const cmd of [
      "set variable x = 1",
      "set var x = 1",
      "set $pc = 0x08000100",
      "set {int}0x20000000 = 1",
      "set{uint32_t}0xe000ed0c = 0x05fa0004",
      "monitor reset halt",
      "call foo()",
      "jump *0x100",
      "return 0",
      "restore dump.bin binary 0x20000000",
      "signal SIGINT",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("mutating")
    }
  })

  it("load / flash-erase 经 gdb server 改写 flash —— 和烧录一样贵,必须是 mutating", () => {
    expect(classifyEval("load").kind).toBe("mutating")
    expect(classifyEval("load build/fw.elf").kind).toBe("mutating")
    expect(classifyEval("flash-erase").kind).toBe("mutating")
  })

  it("藏在表达式里的赋值与 ++/-- 是写内存", () => {
    for (const cmd of [
      "p x = 5",
      "print g_scenario=6",
      "p i++",
      "p --i",
      "p arr[i] = 3",
      "p x=-1",
      "p (a = 1, b)",
      "output flags |= 4",
      "display *p += 1",
      'printf "%d\\n", i++',
      "p cfg->mode <<= 1",
    ]) {
      const v = classifyEval(cmd)
      expect(v.kind, cmd).toBe("mutating")
      expect(v.kind === "mutating" && v.reason).toContain("WRITING")
    }
  })

  it("比较、指针、负号、字符串里的 = 都不是写", () => {
    for (const cmd of [
      "p x == 1",
      "p a != b",
      "p a <= b",
      "p a >= b",
      "p a->b",
      "p -x",
      "p a - -b",
      "p !x",
      "p 'a'",
      "p '='",
      'printf "a=%d\\n", x',
      'p "x = 1"',
      "x/4xw &buf",
      "info line *0x08000100",
      "list main",
      "disassemble /s main",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("read")
    }
  })

  it("裸 set 一律拦下 —— gdb 认不出的设置名会被当表达式,静默写目标内存", () => {
    const v = classifyEval("set startup-with-shell off")
    expect(v.kind).toBe("blocked")
    expect(v.kind === "blocked" && v.reason).toContain("EXPRESSION")
    expect(classifyEval("set remotetimeout 5").kind).toBe("blocked")
  })

  it("只影响显示的设置放行(审稿实测:`set print pretty off` 被拒还说它'不是设置',理由是假的)", () => {
    for (const cmd of [
      "set print pretty off",
      "set print elements 200",
      "set listsize 20",
      "set disassembly-flavor intel",
      "set output-radix 16",
      "set language c",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("read")
    }
    // 工具自己拥有的仍然拦
    expect(classifyEval("set pagination on").kind).toBe("blocked")
    expect(classifyEval("set mi-async off").kind).toBe("blocked")
  })

  it("只读命令放行", () => {
    for (const cmd of [
      "p/x *cfg",
      "info registers",
      "x/16xw 0x20000000",
      "bt",
      "ptype struct foo",
      "info symbol 0x100",
      "frame 2",
      "up",
      "thread 1",
      "info sharedlibrary",
    ]) {
      expect(classifyEval(cmd).kind, cmd).toBe("read")
    }
  })

  it("空命令与多行命令不放行", () => {
    expect(classifyEval("   ").kind).toBe("blocked")
    expect(classifyEval("p 1\np 2").kind).toBe("blocked")
    expect(classifyEval("p 1\r\nshell ls").kind).toBe("blocked")
  })

  it("前缀匹配不误伤:`stepping` 不是 step,`fileno` 不是 file", () => {
    expect(classifyEval("p stepping").kind).toBe("read")
    expect(classifyEval("p fileno").kind).toBe("read")
    expect(classifyEval("p run_count").kind).toBe("read")
  })
})

describe("expressionWrites", () => {
  it("给 exec 的 show 表达式共用同一把尺", () => {
    expect(expressionWrites("g_tick_count")).toBe(false)
    expect(expressionWrites("g_tick_count == 0")).toBe(false)
    expect(expressionWrites("g_tick_count = 0")).toBe(true)
    expect(expressionWrites("g_tick_count++")).toBe(true)
    expect(expressionWrites("*(uint32_t*)0xe000ed28")).toBe(false)
    expect(expressionWrites("regs.ctrl &= ~1")).toBe(true)
    expect(expressionWrites('name == "a=b"')).toBe(false)
  })
})
