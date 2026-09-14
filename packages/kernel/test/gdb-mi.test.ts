/**
 * gdb 纯函数层(host/domain/gdb)的验收:MI3 分帧与解析、Cortex-M 寄存器解码、帧渲染、ELF 头。
 *
 * 三层,由假到真:
 * 1. 手写记录 —— 从 attic/test/gdb-mi.test.ts 原样移植,每条都是从前实测抓到过的形状(QEMU 上的
 *    *stopped、内联断点的 locations、--simple-values 只给 type 的聚合变量……)。
 * 2. 语料夹具 fixtures/gdb/mi-corpus.txt —— 2026-09-14 用 arm-none-eabi-gdb 16.3 对 fixture_f4.elf 发
 *    17 条带 token 的命令抓下来的**原始 stdout**(不接板子:断点、反汇编、符号表、BreakpointTable 都是
 *    静态的)。按几种块大小切开喂分帧器再逐条解析,断言每条记录的形状。CI 上没有 gdb 也跑。
 * 3. 真 gdb —— PATH 上有 arm-none-eabi-gdb / gdb-multiarch(或 `YOMA_GDB` 指定)时,把同一批命令对
 *    真进程再发一遍,按**真实 chunk 边界**分帧,跑与夹具同一组断言。没有就跳过并 warn,不假装测到了。
 *    这一层测的是"这台机器上的 gdb 今天还这么说话",夹具那层钉的是"解析器对已知语料的答案"。
 */

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path, { delimiter, join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  ARM_IMPLEMENTER,
  clip,
  decodeBreakpointUnits,
  decodeCpuid,
  decodeDfsr,
  decodeDhcsr,
  decodeException,
  decodeExcReturn,
  decodeFault,
  decodeStackedFrame,
  decodeWatchpointUnits,
  ELF_MACHINE,
  elfMachine,
  escapeCString,
  frameOf,
  splitRecords,
  hex,
  hexToWords,
  MAX_FRAMES,
  type MiRecord,
  type MiTuple,
  miNumber,
  miString,
  miTuple,
  parseMiValue,
  parseRecord,
  parseResults,
  preferredGdbNames,
  relFrame,
  renderFrame,
  renderFrames,
  SCB,
  shortenPath,
  unwrapList,
} from "../src/host/domain/gdb/index.ts"

const FIXTURES = join(import.meta.dirname, "fixtures", "gdb")
const FIXTURE_ELF = join(FIXTURES, "fixture_f4.elf")
const CORPUS = join(FIXTURES, "mi-corpus.txt")

// ─── 分帧 ────────────────────────────────────────────────────────────────────

describe("splitRecords", () => {
  it("按 \\n 切,残余留给下一段", () => {
    const a = splitRecords("", '^done,value="a"\n*stop')
    expect(a.lines).toEqual(['^done,value="a"'])
    expect(a.pending).toBe("*stop")
    expect(a.overflow).toBe(false)

    const b = splitRecords(a.pending, "ped\n(gdb) \n")
    expect(b.lines).toEqual(["*stopped", "(gdb) "])
    expect(b.pending).toBe("")
  })

  it("剥掉行尾的 \\r,但不动 record 内部的转义", () => {
    const r = splitRecords("", '~"a\\r\\nb"\r\n')
    expect(r.lines).toEqual(['~"a\\r\\nb"'])
  })

  it("逐字符喂也必须还原成同一条 record —— 转义中间断开是真实的分片位置", () => {
    const record = '^done,msg="he said \\"hi\\"\\n"'
    let pending = ""
    const lines: string[] = []
    for (const ch of `${record}\n`) {
      const r = splitRecords(pending, ch)
      pending = r.pending
      lines.push(...r.lines)
    }
    expect(lines).toEqual([record])
    expect(pending).toBe("")
  })

  it("不在几千字符处强切 —— 这正是 log 工具的分块不能复用的原因", () => {
    const long = `^done,symbols="${"x".repeat(60_000)}"`
    const r = splitRecords("", `${long}\n`)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]!.length).toBe(long.length)
  })

  it("残余超上限时报 overflow,而不是吐半条 record", () => {
    const r = splitRecords("", "x".repeat(200), 100)
    expect(r.overflow).toBe(true)
    expect(r.lines).toEqual([])
    expect(r.pending).toBe("")
  })

  it("没有换行就不产出任何 record", () => {
    const r = splitRecords("", "^done,val")
    expect(r.lines).toEqual([])
    expect(r.pending).toBe("^done,val")
  })
})

// ─── 记录分类 ────────────────────────────────────────────────────────────────

describe("parseRecord — 记录种类", () => {
  it("带 token 的结果记录", () => {
    const r = parseRecord("22^done")
    expect(r.kind).toBe("result")
    expect(r.token).toBe(22)
    expect(r.class).toBe("done")
    expect(r.results).toEqual({})
  })

  it("^error 带 msg 与 code", () => {
    const r = parseRecord('33^error,msg="Undefined MI command: no-such-command",code="undefined-command"')
    expect(r.kind).toBe("result")
    expect(r.token).toBe(33)
    expect(r.class).toBe("error")
    expect(miString(r.results?.msg)).toBe("Undefined MI command: no-such-command")
    expect(miString(r.results?.code)).toBe("undefined-command")
  })

  it("^connected 是独立的结果类,不能只认 done/error", () => {
    expect(parseRecord("20^connected").class).toBe("connected")
    expect(parseRecord("30^running").class).toBe("running")
    expect(parseRecord("50^exit").class).toBe("exit")
  })

  it("异步执行记录不带 token", () => {
    const r = parseRecord('*running,thread-id="all"')
    expect(r.kind).toBe("exec")
    expect(r.token).toBeUndefined()
    expect(r.class).toBe("running")
    expect(miString(r.results?.["thread-id"])).toBe("all")
  })

  it("通知记录", () => {
    const r = parseRecord('=thread-group-added,id="i1"')
    expect(r.kind).toBe("notify")
    expect(r.class).toBe("thread-group-added")
    expect(miString(r.results?.id)).toBe("i1")
  })

  it("进度记录", () => {
    const r = parseRecord('+download,{section=".text",section-size="6668",total-size="9880"}')
    expect(r.kind).toBe("status")
    expect(r.class).toBe("download")
  })

  it("三种流记录都要认 —— 只收 ~ 会把 monitor 的回复丢光", () => {
    expect(parseRecord('~"$1 = 2\\n"')).toMatchObject({ kind: "console", text: "$1 = 2\n" })
    expect(parseRecord('@"Resetting target\\n"')).toMatchObject({ kind: "target", text: "Resetting target\n" })
    expect(parseRecord('&"Cannot execute this command while the target is running.\\n"')).toMatchObject({
      kind: "log",
      text: "Cannot execute this command while the target is running.\n",
    })
  })

  it("提示符是噪声,不是信号", () => {
    expect(parseRecord("(gdb) ").kind).toBe("prompt")
    expect(parseRecord("(gdb)").kind).toBe("prompt")
    expect(parseRecord("").kind).toBe("prompt")
  })

  it("非 MI 的行退化成 foreign 而不是抛异常 —— pipe/shell 会往 stdout 裸写", () => {
    // 实测:`pipe print 1+1 | cat` 把这行裸写到 stdout,不在任何 record 里。
    expect(parseRecord("$1 = 2").kind).toBe("foreign")
    expect(parseRecord("r0             0x0                 0").kind).toBe("foreign")
    expect(parseRecord("^").kind).toBe("foreign")
    expect(parseRecord("~no-quote").kind).toBe("foreign")
    expect(parseRecord('~"unterminated').kind).toBe("foreign")
    expect(parseRecord("^done x").kind).toBe("foreign")
    expect(parseRecord("12").kind).toBe("foreign")
  })
})

// ─── c-string 转义 ───────────────────────────────────────────────────────────

describe("c-string 反转义", () => {
  const text = (line: string) => parseRecord(line).text

  it("常见转义", () => {
    expect(text('~"a\\tb\\nc\\\\d\\"e\\r"')).toBe('a\tb\nc\\d"e\r')
  })

  it("八进制:NUL 和高位字节", () => {
    expect(text('~"LED1\\000\\000"')).toBe("LED1\0\0")
    expect(text('~"\\007\\010"')).toBe("\x07\x08")
  })

  it("多字节 UTF-8 是逐字节转义的,必须按字节重组 —— 逐字符拼会得到乱码", () => {
    // gdb 把 "我" 发成三个八进制字节
    expect(text('~"\\346\\210\\221"')).toBe("我")
  })

  it("孤立的高位字节(gdb 打印 (char)0xff 就是这样)退化成 U+FFFD,绝不抛 —— 这里跑在 stdout 的回调里", () => {
    expect(text('~"\\377"')).toBe("\uFFFD")
    const r = parseRecord("^done,value=\"255 '\\377'\"")
    expect(r.kind).toBe("result")
    expect(miString(r.results?.value)).toBe("255 '\uFFFD'")
    // 三字节序列只到了两个字节
    expect(() => parseRecord('~"\\346\\210"')).not.toThrow()
    expect(text('~"\\346\\210"')).toBe("\uFFFD")
  })

  it("没转义的非 ASCII 与 BMP 之外的字符原样保留", () => {
    expect(text('~"我 😀"')).toBe("我 😀")
  })

  it("不认识的转义保留反斜杠后的那个字符,不吞", () => {
    expect(text('~"a\\qb"')).toBe("aqb")
  })

  it("嵌套引号与反斜杠(msg 里最常见)", () => {
    const r = parseRecord('^error,msg="No symbol \\"x\\" in current context."')
    expect(miString(r.results?.msg)).toBe('No symbol "x" in current context.')
  })

  it("反汇编里的制表符", () => {
    const v = parseMiValue('"ldr\\tr3, [r7, #4]"')
    expect(v).toBe("ldr\tr3, [r7, #4]")
  })

  it("escapeCString 是它的逆", () => {
    expect(escapeCString('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd')
    // 制表符单独钉:往返测试看不出它(readCString 收裸的 \t 也照样通过)
    expect(escapeCString("a\tb\r\n")).toBe("a\\tb\\r\\n")
    const original = 'path "with" back\\slash\ttab\r\n'
    expect(parseMiValue(`"${escapeCString(original)}"`)).toBe(original)
  })
})

// ─── 值语法 ──────────────────────────────────────────────────────────────────

describe("MI 值语法", () => {
  it("空 tuple / 空 list", () => {
    expect(parseMiValue("{}")).toEqual({})
    expect(parseMiValue("[]")).toEqual([])
  })

  it("嵌套 tuple", () => {
    const v = parseResults('bkpt={number="1",type="breakpoint",addr="0x08000066",line="31"}')
    const b = miTuple(v.bkpt)!
    expect(miString(b.number)).toBe("1")
    expect(miString(b.addr)).toBe("0x08000066")
  })

  it("list of const", () => {
    const v = parseResults('features=["frozen-varobjs","pending-breakpoints","thread-info"]')
    expect(v.features).toEqual(["frozen-varobjs", "pending-breakpoints", "thread-info"])
  })

  it("list 里重复的 key 绝不能塌成一项 —— stack=[frame=…,frame=…] 是最常见的形状", () => {
    const v = parseResults(
      'stack=[frame={level="0",addr="0x08001a3e",func="ring_push",file="uart.c",line="37"},' +
        'frame={level="1",addr="0x08001a10",func="uart_rx_isr",file="uart.c",line="142"},' +
        'frame={level="2",addr="0x08000f2a",func="main",file="main.c",line="57"}]',
    )
    const frames = unwrapList(v.stack, "frame")
    expect(frames).toHaveLength(3)
    expect(miString(frames[0]!.func)).toBe("ring_push")
    expect(miString(frames[2]!.func)).toBe("main")
  })

  it("tuple 里出现裸值时退化成数组,而不是解析失败", () => {
    // mi3 的 script 字段就是这个形状
    const v = parseResults('script={"print x","continue"}')
    expect(v.script).toEqual(["print x", "continue"])
  })

  it("memory / asm_insns 这类 list-of-tuple", () => {
    const mem = parseResults(
      'memory=[{begin="0x20000014",offset="0x00000000",end="0x20000024",contents="0a000000140000001e00000028000000"}]',
    )
    const cells = unwrapList(mem.memory)
    expect(cells).toHaveLength(1)
    expect(miString(cells[0]!.contents)).toBe("0a000000140000001e00000028000000")

    const asm = parseResults(
      'asm_insns=[{address="0x08000012",func-name="compute_delay",offset="10",inst="ldr\\tr3, [r7, #4]"},' +
        '{address="0x08000016",func-name="compute_delay",offset="14",inst="mul.w\\tr3, r2, r3"}]',
    )
    const insns = unwrapList(asm.asm_insns)
    expect(insns).toHaveLength(2)
    expect(miString(insns[1]!.inst)).toBe("mul.w\tr3, r2, r3")
  })

  it("三层嵌套:-symbol-info-functions 的形状", () => {
    const v = parseResults(
      'symbols={debug=[{filename="blink.c",fullname="/tmp/blink.c",' +
        'symbols=[{line="17",name="compute_delay",type="uint32_t (uint32_t, uint32_t)"}]}]}',
    )
    const files = unwrapList(miTuple(v.symbols)?.debug)
    expect(files).toHaveLength(1)
    const syms = unwrapList(files[0]!.symbols)
    expect(miString(syms[0]!.name)).toBe("compute_delay")
  })

  it("同一层重复 key 升级成数组", () => {
    const v = parseResults('a="1",a="2",b="3"')
    expect(v.a).toEqual(["1", "2"])
    expect(v.b).toBe("3")
    expect(parseResults('a="1",a="2",a="3"').a).toEqual(["1", "2", "3"])
  })

  it("嵌套结构体的字符串值原样保留(gdb 把整个结构体塞进一个 const)", () => {
    const v = parseResults('value="{mode = 1, speed = 3, pin = 13 \'\\r\', name = \\"LED1\\000\\000\\000\\"}"')
    expect(miString(v.value)).toBe("{mode = 1, speed = 3, pin = 13 '\r', name = \"LED1\0\0\0\"}")
  })

  it("吃不完整行时标 partial,而不是降级成 foreign —— 后者会让 promise 永远挂着", () => {
    const truncated = parseRecord('^done,bkpt={number="1"')
    expect(truncated.kind).toBe("result")
    expect(truncated.token).toBeUndefined()
    expect(truncated.partial).toBe(true)

    const bare = parseRecord('^done,"bare"')
    expect(bare.kind).toBe("result")
    expect(bare.partial).toBe(true)

    // 能吃完的不标
    expect(parseRecord('^done,value="1"').partial).toBeUndefined()
    expect(() => parseRecord('^done,a={b=[{c="1"')).not.toThrow()
  })

  it("partial 的记录仍带着吃到手的那部分", () => {
    const r = parseRecord('^done,value="1",broken=')
    expect(r.partial).toBe(true)
    expect(miString(r.results?.value)).toBe("1")
  })
})

describe("取值辅助", () => {
  it("miNumber 认十进制和十六进制", () => {
    expect(miNumber("31")).toBe(31)
    expect(miNumber("0x08000066")).toBe(0x08000066)
    expect(miNumber("0X10")).toBe(16)
    // gdb 打印指针会拖一个符号:`0x8000274 <main>`(-data-evaluate-expression "&main" 实测)。
    // 没有十六进制分支的话 Number() 会把它整个判成 NaN,指针求值静默变成 undefined。
    expect(miNumber("0x8000274 <main>")).toBe(0x8000274)
    expect(miNumber("{int (void)} 0x8000274 <main>")).toBeUndefined()
    expect(miNumber("nope")).toBeUndefined()
    expect(miNumber(undefined)).toBeUndefined()
    expect(miNumber({})).toBeUndefined()
  })

  it("miString / miTuple 只认自己那种形状", () => {
    expect(miString({})).toBeUndefined()
    expect(miString([])).toBeUndefined()
    expect(miTuple("x")).toBeUndefined()
    expect(miTuple(["x"])).toBeUndefined()
    expect(miTuple({ a: "1" })).toEqual({ a: "1" })
  })

  it("unwrapList 对单个 tuple 也成立,裸字符串被跳过", () => {
    const one: MiTuple = { frame: { func: "main" } }
    expect(unwrapList(one, "frame")).toEqual([{ func: "main" }])
    expect(unwrapList(["a", { b: "1" }])).toEqual([{ b: "1" }])
    expect(unwrapList(undefined)).toEqual([])
    // 不带 key 时单键包装原样留着;key 对不上也不脱
    expect(unwrapList([{ frame: { func: "main" } }])).toEqual([{ frame: { func: "main" } }])
    expect(unwrapList([{ frame: { func: "main" } }], "bkpt")).toEqual([{ frame: { func: "main" } }])
  })
})

// ─── 实测记录:从前抓到的那几条 ───────────────────────────────────────────────

describe("实测记录", () => {
  it("QEMU 上 attach 时的 *stopped(带 args=[] 与 fullname)", () => {
    const r = parseRecord(
      '*stopped,frame={addr="0x0000044c",func="Reset_Handler",args=[],file="main.c",' +
        'fullname="/tmp/fixture/main.c",line="287",arch="armv3m"},thread-id="1",stopped-threads="all"',
    )
    expect(r.kind).toBe("exec")
    expect(r.class).toBe("stopped")
    const f = frameOf(miTuple(r.results?.frame))!
    expect(f.func).toBe("Reset_Handler")
    expect(f.line).toBe("287")
    expect(f.fullname).toBe("/tmp/fixture/main.c")
    expect(f.args).toBeUndefined()
  })

  it("断点命中的 *stopped 带断点号和实参", () => {
    const r = parseRecord(
      '*stopped,reason="breakpoint-hit",disp="keep",bkptno="2",' +
        'frame={addr="0x08001a3e",func="ring_push",args=[{name="r",value="0x20000100"},{name="ch",value="65 \'A\'"}],' +
        'file="uart.c",fullname="/src/uart.c",line="37"},thread-id="1",stopped-threads="all",core="0"',
    )
    expect(miString(r.results?.reason)).toBe("breakpoint-hit")
    expect(miString(r.results?.bkptno)).toBe("2")
    const f = frameOf(miTuple(r.results?.frame))!
    expect(f.args).toEqual([
      { name: "r", value: "0x20000100" },
      { name: "ch", value: "65 'A'" },
    ])
    expect(renderFrame(f, 0)).toBe("#0 ring_push(r=0x20000100, ch=65 'A') at uart.c:37")
  })

  it("-break-insert 的回复:pending 断点在裸机上永远不会解析", () => {
    const ok = parseRecord(
      '^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x08000066",func="main",' +
        'file="blink.c",fullname="/tmp/blink.c",line="31",thread-groups=["i1"],times="0",original-location="blink.c:31"}',
    )
    expect(miString(miTuple(ok.results?.bkpt)?.addr)).toBe("0x08000066")

    const pending = parseRecord(
      '^done,bkpt={number="2",type="breakpoint",disp="keep",enabled="y",addr="<PENDING>",' +
        'pending="process_pkt",times="0",original-location="process_pkt"}',
    )
    expect(miString(miTuple(pending.results?.bkpt)?.addr)).toBe("<PENDING>")
  })

  it("多地址断点(内联/ICF)带 locations 列表 —— 每一项都吃一个硬件单元", () => {
    const r = parseRecord(
      '^done,bkpt={number="3",type="breakpoint",disp="keep",enabled="y",addr="<MULTIPLE>",times="0",' +
        'locations=[{number="3.1",enabled="y",addr="0x08000100",func="helper",file="a.c",line="9"},' +
        '{number="3.2",enabled="y",addr="0x08000240",func="helper",file="b.c",line="9"}]}',
    )
    const bkpt = miTuple(r.results?.bkpt)!
    expect(miString(bkpt.addr)).toBe("<MULTIPLE>")
    expect(unwrapList(bkpt.locations)).toHaveLength(2)
  })

  it("BreakpointTable 的 hdr + body", () => {
    const r = parseRecord(
      '^done,BreakpointTable={nr_rows="2",nr_cols="6",' +
        'hdr=[{width="3",alignment="-1",col_name="number",colhdr="Num"},{width="14",alignment="-1",col_name="type",colhdr="Type"}],' +
        'body=[bkpt={number="1",type="breakpoint",addr="0x08000066"},bkpt={number="2",type="hw watchpoint",what="g_state"}]}',
    )
    const table = miTuple(r.results?.BreakpointTable)!
    const body = unwrapList(table.body, "bkpt")
    expect(body).toHaveLength(2)
    expect(miString(body[1]!.type)).toBe("hw watchpoint")
  })

  it("target 退出:结果记录上会挂 reason —— 别假设 ^done 只有一个字段", () => {
    const r = parseRecord('40^done,reason="exited-normally",value="off"')
    expect(miString(r.results?.reason)).toBe("exited-normally")
    expect(miString(r.results?.value)).toBe("off")
  })

  it("-break-watch 的三种回复键:wpt / hw-awpt / hw-rwpt", () => {
    const w = parseRecord('^done,wpt={number="2",exp="g_state"}')
    expect(miString(miTuple(w.results?.wpt)?.exp)).toBe("g_state")
    const a = parseRecord('^done,hw-awpt={number="3",exp="g_state"}')
    expect(miNumber(miTuple(a.results?.["hw-awpt"])?.number)).toBe(3)
    const rd = parseRecord('^done,hw-rwpt={number="4",exp="*(int*)0x20000000"}')
    expect(miString(miTuple(rd.results?.["hw-rwpt"])?.exp)).toBe("*(int*)0x20000000")
  })
})

// ─── 语料回归:156 条真实抓包里挑出来会咬人的那几种 ─────────────────────────

describe("真实语料回归", () => {
  it("-stack-list-arguments 0 在 list 里放的是**裸 result**,不是 tuple", () => {
    // args=[name="n"] —— 和 --simple-values 的 args=[{name=..,value=..}] 形状不同
    const v = parseResults('stack-args=[frame={level="0",args=[name="n",name="acc"]}]')
    const frames = unwrapList(v["stack-args"], "frame")
    const args = unwrapList(frames[0]!.args)
    expect(args.map((a) => miString(a.name))).toEqual(["n", "acc"])
  })

  it('func="??" 是字符串而不是缺字段 —— `if (frame.func)` 会在垃圾上通过', () => {
    const r = parseRecord('*stopped,frame={level="0",addr="0x20000104",func="??",arch="armv7"},thread-id="1"')
    const f = frameOf(miTuple(r.results?.frame))!
    expect(f.func).toBe("??")
    expect(f.file).toBeUndefined()
    expect(renderFrame(f, 0)).toBe("#0 ??() at 0x20000104")
  })

  it("--simple-values 对聚合类型只给 type,不给 value —— 不能当成 <optimized out>", () => {
    const v = parseResults(
      'variables=[{name="i",value="3"},{name="cfg",type="gpio_cfg_t"},{name="p",value="<optimized out>"}]',
    )
    const vars = unwrapList(v.variables)
    expect(miString(vars[1]!.value)).toBeUndefined()
    expect(miString(vars[1]!.type)).toBe("gpio_cfg_t")
    expect(miString(vars[2]!.value)).toBe("<optimized out>")
  })

  it("token 是不透明的:前导零保留,而且可能超出 u32", () => {
    expect(parseRecord("007^done").token).toBe(7)
    expect(parseRecord("99999999999^done").token).toBe(99999999999)
  })

  it("同一层里 frame 深栈的每一帧都要留下,哪怕地址完全相同(递归)", () => {
    const frames = Array.from({ length: 14 }, (_, i) => `frame={level="${i}",addr="0x0000026a",func="rec"}`).join(",")
    const v = parseResults(`stack=[${frames}]`)
    const list = unwrapList(v.stack, "frame")
    expect(list).toHaveLength(14)
    expect(list.map((f) => miString(f.level))).toEqual(Array.from({ length: 14 }, (_, i) => String(i)))
  })

  it("反汇编里带前导制表符和 <UNDEFINED> 的指令", () => {
    const v = parseResults('asm_insns=[{address="0x000001f4",inst="\\t\\t@ <UNDEFINED> instruction: 0x000001f5"}]')
    expect(miString(unwrapList(v.asm_insns)[0]!.inst)).toBe("\t\t@ <UNDEFINED> instruction: 0x000001f5")
  })

  it("值是**显示串**,里面还有一层 C 转义 —— 反转义一次得到的是 gdb 的渲染,不是字节", () => {
    const v = parseResults('value="{a = 42, msg = \\"quote\\\\\\" tab\\\\t nl\\\\n end\\\\000\\"}"')
    // 第一层反转义之后,里面仍然是 \\" \\t \\n \\000 这些字面量
    expect(miString(v.value)).toBe('{a = 42, msg = "quote\\" tab\\t nl\\n end\\000"}')
  })

  it("目标退出走的是 =thread-group-exited,而且 exit-code 可能缺席 —— 这条路上没有 *stopped", () => {
    const withCode = parseRecord('=thread-group-exited,id="i1",exit-code="0"')
    expect(withCode.kind).toBe("notify")
    expect(miString(withCode.results?.["exit-code"])).toBe("0")
    const without = parseRecord('=thread-group-exited,id="i1"')
    expect(miString(without.results?.["exit-code"])).toBeUndefined()
  })
})

// ─── 语料夹具与真 gdb:同一组断言 ────────────────────────────────────────────
//
// 17 条命令(token 1..17),对 fixture_f4.elf、不接目标:
//   1 -gdb-version                      2 -list-features
//   3 -gdb-set mi-async on              4 -gdb-show mi-async
//   5 -data-evaluate-expression 1+1     6 -no-such-command
//   7 -interpreter-exec console "echo 我\n"
//   8 -file-exec-and-symbols "<elf>"    9 -break-insert main
//  10 -break-list                      11 -symbol-info-functions
//  12 -data-disassemble -s main -e "main+8" -- 0
//  13 -file-list-exec-source-files     14 -stack-list-frames(没有目标 → ^error)
//  15 -data-evaluate-expression "sizeof(int)"
//  16 -break-delete                    17 -gdb-exit

const CORPUS_COMMANDS = (elf: string): string[] => [
  "-gdb-version",
  "-list-features",
  "-gdb-set mi-async on",
  "-gdb-show mi-async",
  "-data-evaluate-expression 1+1",
  "-no-such-command",
  '-interpreter-exec console "echo 我\\n"',
  `-file-exec-and-symbols "${escapeCString(elf)}"`,
  "-break-insert main",
  "-break-list",
  "-symbol-info-functions",
  '-data-disassemble -s main -e "main+8" -- 0',
  "-file-list-exec-source-files",
  "-stack-list-frames",
  '-data-evaluate-expression "sizeof(int)"',
  "-break-delete",
  "-gdb-exit",
]

/** 把若干 chunk 依次喂给分帧器,返回全部 record 行(残余必须为空:最后一条 ^exit 带换行)。 */
function frameChunks(chunks: string[]): string[] {
  const lines: string[] = []
  let pending = ""
  for (const chunk of chunks) {
    const r = splitRecords(pending, chunk)
    expect(r.overflow).toBe(false)
    pending = r.pending
    lines.push(...r.lines)
  }
  expect(pending).toBe("")
  return lines
}

function byToken(records: MiRecord[]): Map<number, MiRecord> {
  const out = new Map<number, MiRecord>()
  for (const r of records) if (r.kind === "result" && r.token !== undefined) out.set(r.token, r)
  return out
}

/** 夹具与真 gdb 共用的断言:每条记录的形状,以及 17 个 token 按序各回来一次。 */
function assertCorpus(records: MiRecord[]): void {
  expect(records.length).toBeGreaterThan(30)
  expect(records.filter((r) => r.kind === "foreign")).toEqual([])
  expect(records.filter((r) => r.partial)).toEqual([])
  expect(records.some((r) => r.kind === "prompt")).toBe(true)

  // 起手是 =thread-group-added,然后是 -gdb-version 的一堆 ~ 控制台流。
  expect(records[0]).toMatchObject({ kind: "notify", class: "thread-group-added" })
  expect(miString(records[0]!.results?.id)).toBe("i1")
  const console = records.filter((r) => r.kind === "console")
  expect(console.some((r) => r.text?.includes("GNU gdb"))).toBe(true)
  // `echo 我` 从 gdb 出来是 \346\210\221 三个八进制字节 —— 按字节重组后必须是这个字。
  expect(console.some((r) => r.text === "我\n")).toBe(true)

  const results = records.filter((r) => r.kind === "result")
  expect(results.map((r) => r.token)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
  const t = byToken(records)
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 16]) expect(t.get(n)!.class).toBe("done")
  expect(t.get(6)).toMatchObject({ class: "error" })
  expect(miString(t.get(6)!.results?.code)).toBe("undefined-command")
  expect(t.get(14)!.class).toBe("error")
  expect(miString(t.get(14)!.results?.msg)).toBe("No registers.")
  expect(t.get(17)!.class).toBe("exit")

  expect(t.get(2)!.results?.features).toContain("data-read-memory-bytes")
  expect(miString(t.get(4)!.results?.value)).toBe("on")
  expect(miString(t.get(5)!.results?.value)).toBe("2")
  expect(miString(t.get(15)!.results?.value)).toBe("4")

  const bkpt = miTuple(t.get(9)!.results?.bkpt)!
  expect(miString(bkpt.number)).toBe("1")
  expect(miString(bkpt.addr)).toMatch(/^0x[0-9a-f]{8}$/)
  expect(miString(bkpt.func)).toBe("main")
  expect(miNumber(bkpt.line)).toBeGreaterThan(0)
  expect(bkpt["thread-groups"]).toEqual(["i1"])
  expect(miString(bkpt.fullname)?.endsWith("main.c")).toBe(true)

  const table = miTuple(t.get(10)!.results?.BreakpointTable)!
  expect(miString(table.nr_rows)).toBe("1")
  expect(unwrapList(table.hdr)).toHaveLength(6)
  const body = unwrapList(table.body, "bkpt")
  expect(body).toHaveLength(1)
  expect(miString(body[0]!.number)).toBe("1")
  expect(miString(body[0]!.addr)).toBe(miString(bkpt.addr))

  const files = unwrapList(miTuple(t.get(11)!.results?.symbols)?.debug)
  expect(files).toHaveLength(1)
  const symbols = unwrapList(files[0]!.symbols)
  const main = symbols.find((s) => miString(s.name) === "main")!
  expect(miString(main.type)).toBe("int (void)")
  expect(symbols.some((s) => miString(s.name) === "Default_Handler")).toBe(true)

  const insns = unwrapList(t.get(12)!.results?.asm_insns)
  expect(insns).toHaveLength(3)
  expect(miString(insns[0]!["func-name"])).toBe("main")
  expect(miString(insns[0]!.offset)).toBe("0")
  // 反汇编里助记符和操作数之间是真的 \t —— 从 "push\\t{r4, lr}" 反转义来的
  expect(miString(insns[0]!.inst)).toMatch(/^push\t\{/)
  expect(miString(insns[0]!.address)).toBe(miString(bkpt.addr))

  const sources = unwrapList(t.get(13)!.results?.files)
  expect(sources).toHaveLength(1)
  expect(path.isAbsolute(miString(sources[0]!.fullname)!)).toBe(true)
  expect(miString(sources[0]!["debug-fully-read"])).toBe("true")
}

describe("语料夹具(arm-none-eabi-gdb 16.3 对 fixture_f4.elf 的原始 stdout)", () => {
  const raw = readFileSync(CORPUS, "utf8")

  it.each([1, 7, 64, 1000, raw.length])("按 %i 字节一块喂分帧器,记录逐条成立", (size) => {
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size))
    const lines = frameChunks(chunks)
    expect(lines).toEqual(raw.split("\n").slice(0, -1))
    assertCorpus(lines.map(parseRecord))
  })

  it("逐字符喂、按 UTF-16 码元切在多字节字符中间也无妨 —— 语料是 gdb 转义过的纯 ASCII", () => {
    // 分帧器工作在字符串上;真实的字节级切分由 stdout 的 setEncoding 负责。这里钉住语料本身没有非 ASCII,
    // 否则上面"按 1 字节一块"那条就测不到它声称的东西(一个汉字会被 slice 切成两个码元)。
    expect([...raw].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true)
  })
})

function findGdb(): string | undefined {
  const explicit = process.env.YOMA_GDB
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const names = ["arm-none-eabi-gdb", "gdb-multiarch"].map((n) => (process.platform === "win32" ? `${n}.exe` : n))
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const GDB = findGdb()
if (!GDB) console.warn("[gdb-mi.test] PATH 上没有 arm-none-eabi-gdb / gdb-multiarch,跳过真 gdb 那一层")

describe.skipIf(!GDB)("真 gdb(本机 PATH 上的那个)", () => {
  it("同一批命令对真进程发一遍,按真实 chunk 边界分帧,与夹具同一组断言", async () => {
    const child = spawn(GDB!, ["--interpreter=mi3", "-nx", "-q"], { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: string[] = []
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => chunks.push(chunk))
    // stderr 不是 MI(gdb 自己的诊断走那儿,别家发行版起手会打 warning),读掉即可,不断言。
    child.stderr.resume()
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", () => resolve())
    })
    const script = CORPUS_COMMANDS(FIXTURE_ELF)
      .map((command, i) => `${i + 1}${command}\n`)
      .join("")
    child.stdin.end(script)
    await closed
    expect(chunks.length).toBeGreaterThan(0)
    const records = frameChunks(chunks).map(parseRecord)
    assertCorpus(records)
  }, 30_000)
})

// ─── Cortex-M 解码 ───────────────────────────────────────────────────────────

describe("decodeCpuid", () => {
  it("M4 有可配置故障寄存器", () => {
    const c = decodeCpuid(0x410fc241)
    expect(c.partno).toBe(0xc24)
    expect(c.name).toBe("Cortex-M4")
    expect(c.revision).toBe("r0p1")
    expect(c.hasConfigurableFaults).toBe(true)
    expect(c.implementer).toBe(ARM_IMPLEMENTER)
    // 别家 implementer(RISC-V 目标上读到的垃圾)不是 Cortex-M:调用方靠这个字段决定要不要解 SCB
    expect(decodeCpuid(0x000fc241).implementer).not.toBe(ARM_IMPLEMENTER)
  })

  it("M0+ 没有 —— 在它上面解 CFSR 等于解一堆零", () => {
    const c = decodeCpuid(0x410cc601)
    expect(c.name).toBe("Cortex-M0+")
    expect(c.hasConfigurableFaults).toBe(false)
  })

  it("PARTNO 表逐个钉住:名字与有没有可配置故障寄存器", () => {
    const table: [number, string, boolean][] = [
      [0xc20, "Cortex-M0", false],
      [0xc21, "Cortex-M1", false],
      [0xc23, "Cortex-M3", true],
      [0xc24, "Cortex-M4", true],
      [0xc27, "Cortex-M7", true],
      [0xc60, "Cortex-M0+", false],
      [0xd20, "Cortex-M23", false],
      [0xd21, "Cortex-M33", true],
      [0xd22, "Cortex-M55", true],
      [0xd23, "Cortex-M85", true],
      [0xd24, "Cortex-M52", true],
      [0xd31, "Cortex-M35P", true],
    ]
    for (const [partno, name, faults] of table) {
      const c = decodeCpuid(0x41000000 | (partno << 4))
      expect(c.name, name).toBe(name)
      expect(c.hasConfigurableFaults, name).toBe(faults)
    }
  })

  it("未知核不假装认识,但按 mainline 对待", () => {
    const c = decodeCpuid(0x410f0ff0)
    expect(c.name).toContain("unknown core")
    expect(c.hasConfigurableFaults).toBe(true)
  })

  it("SCB 地址表是 ARMv7-M 的私有外设总线", () => {
    expect(SCB).toEqual({
      CPUID: 0xe000ed00,
      ICSR: 0xe000ed04,
      VTOR: 0xe000ed08,
      AIRCR: 0xe000ed0c,
      SCR: 0xe000ed10,
      CCR: 0xe000ed14,
      SHCSR: 0xe000ed24,
      CFSR: 0xe000ed28,
      HFSR: 0xe000ed2c,
      DFSR: 0xe000ed30,
      MMFAR: 0xe000ed34,
      BFAR: 0xe000ed38,
      AFSR: 0xe000ed3c,
      DHCSR: 0xe000edf0,
      DEMCR: 0xe000edfc,
      FP_CTRL: 0xe0002000,
      DWT_CTRL: 0xe0001000,
    })
  })
})

/** 只给 CFSR 的简写:其余三个寄存器为 0。 */
const cfsrOnly = (cfsr: number) => decodeFault({ cfsr, hfsr: 0, mmfar: 0, bfar: 0 })

describe("decodeFault — 夹具固件实测出来的那几个 CFSR", () => {
  it("badptr:精确总线错误,BFAR 有效,地址标明来自 BFAR", () => {
    const d = decodeFault({ cfsr: 0x00008200, hfsr: 0x40000000, mmfar: 0, bfar: 0xf0000000 })
    expect(d.bfsr.map((f) => f.name)).toEqual(["PRECISERR", "BFARVALID"])
    expect(d.faultAddress).toBe(0xf0000000)
    expect(d.bfar).toBe(0xf0000000)
    expect(d.mmfar).toBeUndefined()
    expect(d.imprecise).toBe(false)
    expect(d.summary).toContain("PRECISERR")
    expect(d.summary).toContain("BFAR=0xf0000000")
    expect(d.summary).not.toContain("MMFAR")
  })

  it("stackovf:入栈时总线错误", () => {
    const d = decodeFault({ cfsr: 0x00009200, hfsr: 0x40000000, mmfar: 0, bfar: 0x1ffffff0 })
    expect(d.bfsr.map((f) => f.name)).toContain("STKERR")
    expect(d.summary).toContain("栈溢出")
  })

  it("ARMv8-M 的栈限检查(STKOF,CFSR bit 20):M33 上真正的栈溢出证据", () => {
    const d = decodeFault({ cfsr: 1 << 20, hfsr: 0x40000000, mmfar: 0, bfar: 0 })
    expect(d.ufsr.map((f) => f.name)).toEqual(["STKOF"])
    expect(d.summary).toContain("栈溢出")
    expect(d.summary).not.toContain("不认识的位")
  })

  it("nullcall:Thumb 位没置 1", () => {
    const d = decodeFault({ cfsr: 0x00020000, hfsr: 0x40000000, mmfar: 0, bfar: 0 })
    expect(d.ufsr.map((f) => f.name)).toEqual(["INVSTATE"])
    expect(d.faultAddress).toBeUndefined()
  })

  it("unaligned / divzero / undefined instruction", () => {
    expect(cfsrOnly(0x01000000).ufsr.map((f) => f.name)).toEqual(["UNALIGNED"])
    expect(cfsrOnly(0x02000000).ufsr.map((f) => f.name)).toEqual(["DIVBYZERO"])
    expect(cfsrOnly(0x00010000).ufsr.map((f) => f.name)).toEqual(["UNDEFINSTR"])
  })

  it("BFARVALID=0 时绝不返回 BFAR —— 那是陈旧值,会冤枉无辜代码", () => {
    const d = decodeFault({ cfsr: 0x00000200, hfsr: 0, mmfar: 0, bfar: 0xdeadbeef })
    expect(d.faultAddress).toBeUndefined()
    expect(d.bfar).toBeUndefined()
    expect(d.summary).not.toContain("deadbeef")
  })

  it("只有 IMPRECISERR:必须明说地址和 PC 都不可信", () => {
    const d = decodeFault({ cfsr: 0x00000400, hfsr: 0x40000000, mmfar: 0, bfar: 0 })
    expect(d.imprecise).toBe(true)
    expect(d.summary).toContain("都不可信")
  })

  it("PRECISERR 与 IMPRECISERR 同时置位(两次粘滞的故障):BFAR 属于精确那次,只有 PC 要打折", () => {
    const d = decodeFault({ cfsr: 0x00008600, hfsr: 0, mmfar: 0, bfar: 0xf0000000 })
    expect(d.imprecise).toBe(true)
    expect(d.faultAddress).toBe(0xf0000000)
    expect(d.summary).toContain("BFAR=0xf0000000")
    expect(d.summary).toContain("另有一次非精确")
    expect(d.summary).not.toContain("都不可信")
  })

  it("MPU 越权走 MMFAR,地址标明来自 MMFAR", () => {
    const d = decodeFault({ cfsr: 0x00000082, hfsr: 0, mmfar: 0x20008000, bfar: 0 })
    expect(d.mmfsr.map((f) => f.name)).toEqual(["DACCVIOL", "MMARVALID"])
    expect(d.faultAddress).toBe(0x20008000)
    expect(d.mmfar).toBe(0x20008000)
    expect(d.summary).toContain("MMFAR=0x20008000")
  })

  it("BFAR 与 MMFAR 同时有效:BFAR 当主地址,MMFAR 也要说出来;地址按无符号 32 位报", () => {
    const d = decodeFault({ cfsr: 0x00008282, hfsr: 0, mmfar: 0x20008000, bfar: -16 })
    expect(d.faultAddress).toBe(0xfffffff0)
    expect(d.bfar).toBe(0xfffffff0)
    expect(d.mmfar).toBe(0x20008000)
    expect(d.summary).toContain("BFAR=0xfffffff0")
    expect(d.summary).toContain("MMFAR=0x20008000 也有效")
  })

  it("HFSR.FORCED 不是答案:CFSR 空着时要说出'多半被清零了',而不是猜向量表", () => {
    const d = decodeFault({ cfsr: 0, hfsr: 0x40000000, mmfar: 0, bfar: 0 })
    expect(d.hfsr.map((f) => f.name)).toEqual(["FORCED"])
    expect(d.summary).toContain("FORCED")
    expect(d.summary).toContain("清零")
    expect(d.summary).not.toContain("向量表")
  })

  it("CFSR 里只有本表不认识的位时如实报原值,不说'CFSR 为 0'", () => {
    const d = decodeFault({ cfsr: 1 << 2, hfsr: 0x40000000, mmfar: 0, bfar: 0 })
    expect([...d.mmfsr, ...d.bfsr, ...d.ufsr]).toEqual([])
    expect(d.summary).toContain("CFSR=0x00000004")
    expect(d.summary).toContain("不认识的位")
    expect(d.summary).not.toContain("清零")
  })

  it("向量表读失败 / 调试事件:HFSR 自己的位各说各的话", () => {
    const vect = decodeFault({ cfsr: 0, hfsr: 0x00000002, mmfar: 0, bfar: 0 })
    expect(vect.hfsr.map((f) => f.name)).toEqual(["VECTTBL"])
    expect(vect.summary).toContain("VECTTBL")
    expect(vect.summary).toContain("VTOR")
    const dbg = decodeFault({ cfsr: 0, hfsr: 0x80000000, mmfar: 0, bfar: 0 })
    expect(dbg.hfsr.map((f) => f.name)).toEqual(["DEBUGEVT"])
    expect(dbg.summary).toContain("DEBUGEVT")
    expect(dbg.summary).not.toContain("VECTTBL")
  })

  it("全零不是故障", () => {
    expect(cfsrOnly(0).summary).toContain("不是故障")
  })

  it("每一位都钉住:MMFSR / BFSR / UFSR / HFSR 的位号与名字,保留位不出声", () => {
    const cfsrBits: [number, string, "mmfsr" | "bfsr" | "ufsr"][] = [
      [0, "IACCVIOL", "mmfsr"],
      [1, "DACCVIOL", "mmfsr"],
      [3, "MUNSTKERR", "mmfsr"],
      [4, "MSTKERR", "mmfsr"],
      [5, "MLSPERR", "mmfsr"],
      [7, "MMARVALID", "mmfsr"],
      [8, "IBUSERR", "bfsr"],
      [9, "PRECISERR", "bfsr"],
      [10, "IMPRECISERR", "bfsr"],
      [11, "UNSTKERR", "bfsr"],
      [12, "STKERR", "bfsr"],
      [13, "LSPERR", "bfsr"],
      [15, "BFARVALID", "bfsr"],
      [16, "UNDEFINSTR", "ufsr"],
      [17, "INVSTATE", "ufsr"],
      [18, "INVPC", "ufsr"],
      [19, "NOCP", "ufsr"],
      [20, "STKOF", "ufsr"],
      [24, "UNALIGNED", "ufsr"],
      [25, "DIVBYZERO", "ufsr"],
    ]
    for (const [bit, name, group] of cfsrBits) {
      const d = cfsrOnly(2 ** bit)
      expect(
        d[group].map((f) => f.name),
        name,
      ).toEqual([name])
      for (const other of (["mmfsr", "bfsr", "ufsr"] as const).filter((g) => g !== group)) {
        expect(d[other], `${name} leaked into ${other}`).toEqual([])
      }
    }
    for (const [bit, name] of [
      [1, "VECTTBL"],
      [30, "FORCED"],
      [31, "DEBUGEVT"],
    ] as const) {
      expect(decodeFault({ cfsr: 0, hfsr: 2 ** bit, mmfar: 0, bfar: 0 }).hfsr.map((f) => f.name)).toEqual([name])
    }
    const reserved = decodeFault({
      cfsr: (1 << 2) | (1 << 6) | (1 << 14) | (1 << 21) | (1 << 26) | (2 ** 31),
      hfsr: (1 << 0) | (1 << 2) | (1 << 29),
      mmfar: 0,
      bfar: 0,
    })
    expect([...reserved.mmfsr, ...reserved.bfsr, ...reserved.ufsr, ...reserved.hfsr]).toEqual([])
  })
})

describe("decodeDfsr / decodeDhcsr / decodeException", () => {
  it("DFSR / DHCSR 每一位的位号与名字", () => {
    for (const [bit, name] of [
      [0, "HALTED"],
      [1, "BKPT"],
      [2, "DWTTRAP"],
      [3, "VCATCH"],
      [4, "EXTERNAL"],
    ] as const) {
      expect(decodeDfsr(1 << bit).map((f) => f.name)).toEqual([name])
    }
    for (const [bit, name] of [
      [17, "S_HALT"],
      [18, "S_SLEEP"],
      [19, "S_LOCKUP"],
      [25, "S_RESET_ST"],
    ] as const) {
      expect(decodeDhcsr(1 << bit).map((f) => f.name)).toEqual([name])
    }
  })

  it("16 个内建异常号的名字", () => {
    const names: Record<number, string> = {
      0: "Thread mode",
      1: "Reset",
      2: "NMI",
      3: "HardFault",
      4: "MemManage",
      5: "BusFault",
      6: "UsageFault",
      7: "SecureFault",
      11: "SVCall",
      12: "DebugMonitor",
      14: "PendSV",
      15: "SysTick",
    }
    for (const [n, name] of Object.entries(names)) expect(decodeException(Number(n)).name).toBe(name)
    for (const n of [8, 9, 10, 13]) expect(decodeException(n).name).toBe(`reserved (${n})`)
    expect(decodeException(16).name).toBe("IRQ 0")
  })

  it("DFSR 区分断点、观察点和调试器暂停", () => {
    expect(decodeDfsr(0x2).map((f) => f.name)).toEqual(["BKPT"])
    expect(decodeDfsr(0x4).map((f) => f.name)).toEqual(["DWTTRAP"])
    expect(decodeDfsr(0x1).map((f) => f.name)).toEqual(["HALTED"])
    expect(decodeDfsr(0x18).map((f) => f.name)).toEqual(["VCATCH", "EXTERNAL"])
  })

  it("DHCSR 分得清 halted / 睡眠 / 锁死", () => {
    expect(decodeDhcsr(0x00030003).map((f) => f.name)).toEqual(["S_HALT"])
    expect(decodeDhcsr(0x00070003).map((f) => f.name)).toEqual(["S_HALT", "S_SLEEP"])
    expect(decodeDhcsr(0x000f0003).map((f) => f.name)).toContain("S_LOCKUP")
    expect(decodeDhcsr(0x02030003).map((f) => f.name)).toContain("S_RESET_ST")
    expect(decodeDhcsr(0x00010003)).toEqual([])
  })

  it("ICSR.VECTACTIVE 认异常号", () => {
    expect(decodeException(0)).toMatchObject({ name: "Thread mode", inHandler: false })
    expect(decodeException(3)).toMatchObject({ name: "HardFault", inHandler: true })
    expect(decodeException(15)).toMatchObject({ name: "SysTick", inHandler: true })
    expect(decodeException(16 + 37)).toMatchObject({ name: "IRQ 37", inHandler: true })
    expect(decodeException(8)).toMatchObject({ name: "reserved (8)", inHandler: true })
    // 只看低 9 位:ICSR 高位是 PENDSTSET 这类别的东西
    expect(decodeException(0x04400003).vectactive).toBe(3)
  })
})

describe("decodeExcReturn", () => {
  it("0xFFFFFFFD:线程模式 + PSP + 基本帧", () => {
    expect(decodeExcReturn(0xfffffffd)).toEqual({
      stackPointer: "PSP",
      mode: "Thread",
      extendedFrame: false,
      valid: true,
    })
  })

  it("0xFFFFFFF1:handler 模式 + MSP", () => {
    expect(decodeExcReturn(0xfffffff1)).toMatchObject({ stackPointer: "MSP", mode: "Handler" })
  })

  it("0xFFFFFFF9:线程模式 + MSP", () => {
    expect(decodeExcReturn(0xfffffff9)).toMatchObject({ stackPointer: "MSP", mode: "Thread" })
  })

  it("0xFFFFFFED:带浮点的扩展帧", () => {
    expect(decodeExcReturn(0xffffffed)).toMatchObject({ stackPointer: "PSP", extendedFrame: true })
  })

  it("非法 EXC_RETURN 要能识别出来;有符号写法的 -3 也当 0xFFFFFFFD", () => {
    expect(decodeExcReturn(0x08001a3e).valid).toBe(false)
    expect(decodeExcReturn(-3)).toMatchObject({ valid: true, stackPointer: "PSP" })
  })
})

describe("decodeStackedFrame", () => {
  it("八个字对号入座", () => {
    const f = decodeStackedFrame([1, 2, 3, 4, 12, 0x08001a11, 0x08001a3e, 0x61000000])!
    expect(f.pc).toBe(0x08001a3e)
    expect(f.lr).toBe(0x08001a11)
    expect(f.r12).toBe(12)
    expect(f.padded).toBe(false)
  })

  it("xPSR bit 9 说明入栈时补了 4 字节对齐", () => {
    expect(decodeStackedFrame([0, 0, 0, 0, 0, 0, 0, 0x61000200])!.padded).toBe(true)
  })

  it("字数不够就返回 undefined,不猜;多出来的(扩展帧)忽略", () => {
    expect(decodeStackedFrame([1, 2, 3])).toBeUndefined()
    expect(decodeStackedFrame(Array.from({ length: 26 }, (_, i) => i))!.xpsr).toBe(7)
  })
})

describe("断点/观察点预算", () => {
  it("FP_CTRL 的 NUM_CODE 是拆成两段的", () => {
    expect(decodeBreakpointUnits(0x00000061)).toEqual({ total: 6, enabled: true })
    expect(decodeBreakpointUnits(0x00000041)).toEqual({ total: 4, enabled: true })
    // NUM_CODE = 0x14 = 20:高 3 位在 [14:12],低 4 位在 [7:4]
    expect(decodeBreakpointUnits(0x00001041)).toEqual({ total: 20, enabled: true })
    expect(decodeBreakpointUnits(0x00000060).enabled).toBe(false)
  })

  it("DWT_CTRL 的 NUMCOMP 在最高四位", () => {
    expect(decodeWatchpointUnits(0x40000000)).toBe(4)
    expect(decodeWatchpointUnits(0x20000000)).toBe(2)
    expect(decodeWatchpointUnits(0xf0000000)).toBe(15)
  })
})

describe("hexToWords", () => {
  it("十六进制按小端拼字", () => {
    // 0a000000 14000000 → 10, 20 —— 实测从 .data 段读出来的样子
    expect(hexToWords("0a000000140000001e00000028000000")).toEqual([10, 20, 30, 40])
    expect(hexToWords("00000041")).toEqual([0x41000000])
  })

  it("最高位置位的字是无符号的;不足一个字的尾巴丢掉", () => {
    expect(hexToWords("ffffffff")).toEqual([0xffffffff])
    expect(hexToWords("0a00000014")).toEqual([10])
    expect(hexToWords("")).toEqual([])
  })
})

// ─── ELF 头 ──────────────────────────────────────────────────────────────────

describe("elfMachine", () => {
  it("从 ELF 头读 e_machine(小端)", () => {
    const arm = new Uint8Array(0x14)
    arm.set([0x7f, 0x45, 0x4c, 0x46, 1, 1])
    arm[0x12] = 0x28
    expect(elfMachine(arm)).toBe(ELF_MACHINE.ARM)
  })

  it("大端按 EI_DATA=2 读", () => {
    const be = new Uint8Array(0x14)
    be.set([0x7f, 0x45, 0x4c, 0x46, 1, 2])
    be[0x12] = 0x00
    be[0x13] = 0xf3
    expect(elfMachine(be)).toBe(ELF_MACHINE.RISCV)
  })

  it("不是 ELF 或头不够长就返回 undefined,不猜", () => {
    expect(elfMachine(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
    expect(elfMachine(new Uint8Array(0x14))).toBeUndefined()
    expect(elfMachine(new Uint8Array(0x13).fill(0x7f))).toBeUndefined()
  })

  it("真 ELF 上认出 ARM", () => {
    const head = readFileSync(FIXTURE_ELF).subarray(0, 0x14)
    expect(elfMachine(new Uint8Array(head))).toBe(ELF_MACHINE.ARM)
  })
})

describe("preferredGdbNames", () => {
  it("按架构排候选,认不出就只剩通用的两个;每组都以 gdb 兜底", () => {
    expect(preferredGdbNames(ELF_MACHINE.ARM)[0]).toBe("arm-none-eabi-gdb")
    expect(preferredGdbNames(ELF_MACHINE.RISCV)[0]).toContain("riscv")
    expect(preferredGdbNames(ELF_MACHINE.AARCH64)[0]).toContain("aarch64")
    expect(preferredGdbNames(undefined)).toEqual(["gdb-multiarch", "gdb"])
    expect(preferredGdbNames(0x1234)).toEqual(["gdb-multiarch", "gdb"])
    for (const machine of [ELF_MACHINE.ARM, ELF_MACHINE.RISCV, ELF_MACHINE.AARCH64, undefined]) {
      expect(preferredGdbNames(machine).at(-1)).toBe("gdb")
    }
  })
})

// ─── 渲染与预算 ──────────────────────────────────────────────────────────────

describe("渲染", () => {
  it("clip 一定标注截断,不做裸截断", () => {
    expect(clip("abc", 10)).toBe("abc")
    const c = clip("x".repeat(50), 10)
    expect(c.startsWith("x".repeat(10))).toBe(true)
    expect(c).toContain("共 50 字符")
    expect(clip("x".repeat(10), 10)).toBe("x".repeat(10))
  })

  it("clip 不切在代理对中间 —— 留下孤立的高位代理,这段文本就不再是合法的 UTF-16", () => {
    const c = clip("😀".repeat(4), 5)
    expect(/\p{Surrogate}/u.test(c)).toBe(false)
    expect(c.startsWith("😀😀…")).toBe(true)
    expect(c).toContain("已显示 4")
    // 切在整字上时照旧
    expect(clip("😀".repeat(4), 4).startsWith("😀😀…")).toBe(true)
  })

  it("hex 补齐宽度", () => {
    expect(hex(0x1a3e)).toBe("0x00001a3e")
    expect(hex(undefined)).toBe("?")
    expect(hex(0xffffffff)).toBe("0xffffffff")
    expect(hex(-1)).toBe("0xffffffff")
    expect(hex(0x1a, 2)).toBe("0x1a")
  })

  it("没有源码信息时退回地址;什么都没有就只剩函数", () => {
    expect(renderFrame({ func: "??", addr: "0x08000100" }, 3)).toBe("#3 ??() at 0x08000100")
    expect(renderFrame({})).toBe("??()")
    expect(renderFrame({ func: "f", args: [{ name: "a" }] })).toBe("f(a=?)")
  })

  it("栈太深时掐掉尾巴并说清楚还有多少", () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({ level: i, func: `f${i}`, file: "a.c", line: String(i) }))
    const out = renderFrames(frames)
    expect(out).toHaveLength(MAX_FRAMES + 1)
    expect(out[8]).toContain("还有 22 帧")
    expect(renderFrames(frames.slice(0, MAX_FRAMES))).toHaveLength(MAX_FRAMES)
  })

  it("帧号优先用 MI 给的 level,没有才用下标", () => {
    expect(renderFrames([{ level: 5, func: "a" }, { func: "b" }])).toEqual(["  #5 a()", "  #1 b()"])
  })

  it("shortenPath / relFrame 只剥工程根这个前缀,别的路径原样", () => {
    const root = path.resolve("/work/fw")
    const inside = path.join(root, "src", "main.c")
    const outside = path.resolve("/opt/toolchain/newlib.c")
    expect(shortenPath(inside, root)).toBe(path.join("src", "main.c"))
    expect(shortenPath(inside, root + path.sep)).toBe(path.join("src", "main.c"))
    expect(shortenPath(outside, root)).toBe(outside)
    expect(shortenPath(inside, undefined)).toBe(inside)
    expect(shortenPath(undefined, root)).toBeUndefined()
    // 前缀要按目录切:/work/fw-old 不是 /work/fw 底下的
    expect(shortenPath(path.resolve("/work/fw-old/a.c"), root)).toBe(path.resolve("/work/fw-old/a.c"))

    const frame = { func: "main", file: inside, line: "3", fullname: inside }
    const rel = relFrame(frame, root)
    expect(rel.file).toBe(path.join("src", "main.c"))
    expect(rel.fullname).toBe(inside)
    // 没剥到东西时返回同一个对象
    expect(relFrame(frame, undefined)).toBe(frame)
    expect(relFrame({ func: "f" }, root)).toEqual({ func: "f" })
  })

  it("Windows 风格:DWARF 用 / 而 cwd 用 \\、盘符大小写不同,照样剥;剥的是原串,分隔符保留 DWARF 写的那种", () => {
    const win = { caseInsensitive: true }
    expect(shortenPath("C:/Users/ben/fw/src/main.c", "C:\\Users\\ben\\fw", win)).toBe("src/main.c")
    expect(shortenPath("c:/users/ben/fw/src/main.c", "C:\\Users\\ben\\fw", win)).toBe("src/main.c")
    expect(shortenPath("C:\\Users\\ben\\fw\\src\\main.c", "C:/Users/ben/fw/", win)).toBe("src\\main.c")
    // MSYS 风格的 /c/Users 认不出:原样留着,不是错
    expect(shortenPath("/c/Users/ben/fw/a.c", "C:\\Users\\ben\\fw", win)).toBe("/c/Users/ben/fw/a.c")
    // 大小写敏感(POSIX 缺省)时不剥
    expect(shortenPath("/Work/fw/a.c", "/work/fw", { caseInsensitive: false })).toBe("/Work/fw/a.c")
    expect(shortenPath("/work/fw/a.c", "/work/fw", { caseInsensitive: false })).toBe("a.c")
    // 目录边界仍然成立
    expect(shortenPath("C:/Users/ben/fw-old/a.c", "C:\\Users\\ben\\fw", win)).toBe("C:/Users/ben/fw-old/a.c")
  })
})
