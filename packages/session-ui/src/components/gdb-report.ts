/**
 * gdb 停止报告的**唯一读法**。纯函数,不碰 DOM、不碰 solid。
 *
 * gdb 工具的结构化 `details`(`GdbDetails`)里**一个故障字段都没有** —— 契约的纪律是 details
 * 只放能 JSON 往返的小字段,而 `decodeFault` 的结果只进了给模型看的那段文本
 * (`host/tools/gdb/target.ts` 的 `renderStopReport`)。所以"停在哪、是什么故障、出事的是哪一行"
 * 只能从文本里读回来。
 *
 * 两个消费方,一份正则:
 * - `parseStopReport`(原来住在 app 的 `bench/bench-status.ts`)—— 右栏状态条 / GDB 面板要的
 *   "折成一份现状";
 * - `parseGdbReport` —— 时间线里那张 gdb 卡片要的"排好版的一份现场"。
 * 两份读法分叉的后果不会报错:面板说停在 foc.c:45、卡片说停在别处,而两边都看起来很合理。
 *
 * **解析不出就是解析不出**:每个字段都可选,调用方拿不到就原样等宽显示那段文本。
 * 这里绝不抛异常 —— 旧会话重放时文案可能是上一个版本的。
 */

/** `■ stopped#7: breakpoint-hit breakpoint 2 (+0.153s)` —— renderStopReport 的第一行。 */
const STOP_LINE = /^■\s*stopped#(\d+):\s*(.*)$/
/** `[gdb #1 halted @ main.c:200 bp=1/6 localhost:3333]` 的位置那一段。 */
const BANNER_LOCATION = /^\[gdb #\d+ [a-z-]+ @ (\S+)/
/** `  故障(HardFault):栈上的 PC 指向 …` —— 冒号可能是全角(源码里就是全角)。 */
const FAULT_LINE = /^\s*故障[(（]([^)）]*)[)）]\s*[:：]?\s*(.*)$/
/** `  出事 PC 0x080004b6 = foc_zero_isense + 10 in section .text (Core/Src/foc.c:45)` */
const FAULT_PC_LINE = /^\s*出事\s*PC\b.*\(([^()\s]+:\d+)\)\s*$/
/** 没有中文那一行时的兜底:Cortex-M 的故障名出现在停止报告里。 */
const FAULT_WORD = /\b(?:HardFault|BusFault|UsageFault|MemManage|NMI|hard\s?fault)\b/

const MAX_REPORT_LINES = 40
const MAX_REPORT_CHARS = 4000

export interface ParsedStopReport {
  /** 从 `■` 那行起的正文,已按行数与字数截断。 */
  report?: string
  /** 这份输出里出现过的全部停止(源序)。 */
  stops: { n: number; reason: string; fault?: string }[]
  /** 最后一次停止的故障摘要。 */
  fault?: string
  /**
   * 故障真正发生的源码位置(`foc.c:45`),来自报告里"出事 PC"那一行。停止位置(横幅 / details)
   * 指的是**现在停在哪** —— 出了故障时那是 HardFault 处理函数,不是人要看的那一行。
   */
  faultLocation?: string
  /** 横幅里的 `@ 位置`。 */
  location?: string
}

/**
 * 从一次 gdb 调用的输出里抠出停止现场(状态条 / 面板那一份)。
 *
 * 注意**不要**按 details 判有没有故障(见文件头)。
 */
export function parseStopReport(output: string): ParsedStopReport {
  const out: ParsedStopReport = { stops: [] }
  if (!output) return out

  const lines = output.split("\n")
  let reportFrom = -1
  for (const [index, line] of lines.entries()) {
    const stop = STOP_LINE.exec(line)
    if (stop) {
      out.stops.push({ n: Number(stop[1]), reason: stop[2].trim() || "halted" })
      reportFrom = index
      continue
    }
    const banner = BANNER_LOCATION.exec(line)
    if (banner) out.location = banner[1]
  }

  if (reportFrom >= 0) {
    const body = lines.slice(reportFrom, reportFrom + MAX_REPORT_LINES).join("\n")
    out.report = body.length > MAX_REPORT_CHARS ? `${body.slice(0, MAX_REPORT_CHARS)}\n…` : body
  }

  // 故障只从**停止报告**里认,而且只认最后一次停止之后的那一段:
  // 一次调用里出现两次停止时前一次的故障不该冒充现状;没有 ■ 那行时(比如 `break` 的回执
  // 里恰好提到"故障")更不该凭空冒出一条没有现场的故障。
  if (reportFrom >= 0) {
    const tail = lines.slice(reportFrom)
    for (const line of tail) {
      if (FAULT_LINE.test(line)) {
        out.fault = line.trim()
        break
      }
    }
    if (!out.fault) {
      const hit = tail.find((line) => FAULT_WORD.test(line))
      if (hit) out.fault = hit.trim()
    }
    if (out.fault) {
      for (const line of tail) {
        const pc = FAULT_PC_LINE.exec(line)
        if (!pc) continue
        const [file, lineNo] = [pc[1].slice(0, pc[1].lastIndexOf(":")), pc[1].slice(pc[1].lastIndexOf(":") + 1)]
        out.faultLocation = `${basename(file)}:${lineNo}`
        break
      }
    }
  }
  if (out.fault && out.stops.length > 0) out.stops[out.stops.length - 1].fault = out.fault

  return out
}

/** 只要文件名 —— 路径在 `main.c:200` 这种一行读数里没有位置。正反斜杠都认。 */
export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

// ================================================================ 卡片那一份

/** `  #2 foc_zero_isense() at Core/Src/foc.c:45` / `  #1 <signal handler called>() at 0xfffffffd` */
const FRAME_LINE = /^\s*#(\d+)\s+(.*?)\s+at\s+(\S+)\s*$/
/** `  异常帧在 PSP(EXC_RETURN=0xfffffffd,基本帧)` */
const EXC_FRAME_LINE = /^\s*异常帧在\s*(\S.*)$/
/** `  入栈寄存器:r0=0xdeadbeef r1=0x00000000 …` */
const STACKED_LINE = /^\s*入栈寄存器\s*[:：]\s*(.*)$/
/** `  locals: f=0x2001f7c0, exc_return=4294967293` */
const LOCALS_LINE = /^\s*locals:\s*(.*)$/
/** exec 的 `show` 回来的那几行:`  g_boot_stage = 6`。左边必须是个 C 标识符 / 表达式。 */
const SHOW_LINE = /^\s{2,}([A-Za-z_$][\w$.\->[\]() ]*?)\s=\s(.+)$/
/** `$1 = 0xf0000000` —— eval 的回执。 */
const VALUE_LINE = /^\s*(\$\d+)\s=\s(.+)$/
/** `breakpoint 1 at 0x08000334 — Core/Src/main.c:136` */
const BREAK_SET_LINE = /^\s*(?:breakpoint|watchpoint)\s+(\d+)\s+at\s+(\S+)(?:\s+[—-]\s+(\S+))?/
/** `attached to localhost:62169 via qemu, gdb /path/to/arm-none-eabi-gdb` */
const ATTACHED_LINE = /^attached to\s+(\S+)\s+via\s+(\S+?)[,\s]/
/** 报告里那几条 `key: value` 说明行(core / note / image / session log / server log)。 */
const NOTE_LINE = /^(core|note|image|session log|server log|warning)\s*:\s*(.*)$/i
/** 括号自成一行的旁白(`(目标已暂停 —— …)`),不进读数区。 */
const ASIDE_LINE = /^\s*[((].*[))]\s*$/

export interface GdbFrame {
  /** 帧号(`#0` 的 0)。 */
  n: number
  /** `foc_zero_isense()` / `<signal handler called>()` */
  func: string
  /** `Core/Src/foc.c:45` 或一个裸地址 `0xfffffffd`。 */
  at: string
  /** `foc.c:45`;`at` 不是"文件:行"时没有。 */
  short?: string
}

export interface GdbFault {
  /** `BusFault` / `HardFault` … */
  kind: string
  /** 冒号后面那一整句(标志位 + 出事地址)。 */
  detail: string
  /** 从 detail 里抠出的标志位:`PRECISERR`。 */
  flags: string[]
  /** `BFAR=0xf0000000`,只有报告里写了才有。 */
  address?: string
  /** 出事的那一行源码(`foc.c:45`)。 */
  location?: string
  /** 出事 PC 那一整行(带符号与 section)。 */
  pcLine?: string
  /** `PSP(EXC_RETURN=0xfffffffd,基本帧)` */
  stack?: string
  /** `r0=0xdeadbeef r1=0x00000000 …` 拆成对。 */
  stacked: { key: string; value: string }[]
}

export interface GdbReport {
  /** 横幅里的目标状态词(`halted` / `running` / `exited` / `connection-lost`)。 */
  state?: string
  /** 横幅里的 `@ 位置`(`Core/Src/main.c:136`)。 */
  location?: string
  /** 横幅里的连接串(`localhost:62169`)。 */
  connection?: string
  /** `start` 用的 gdb server(`qemu` / `openocd` / `jlink`)。 */
  via?: string
  /** 这次停止的编号与原因。 */
  stop?: { n: number; reason: string }
  fault?: GdbFault
  frames: GdbFrame[]
  locals?: string
  /** exec 的 `show` / eval 的 `$n`。 */
  values: { key: string; value: string }[]
  /** `core:` / `image:` / `note:` 这类说明行。 */
  notes: { key: string; value: string }[]
  /** break 的回执:`{ n: 1, at: "0x08000334", where: "Core/Src/main.c:136" }`。 */
  breakpoints: { n: string; at: string; where?: string }[]
}

/** `[gdb #1 halted @ Core/Src/main.c:136 localhost:62169]` 整条横幅。 */
const BANNER = /^\[gdb #\d+\s+([a-z-]+)(?:\s+@\s+(\S+))?(.*)\]\s*$/

/** 横幅尾巴里最后一段 `host:port` / 一个路径 —— 中间还可能有 `bp=1/6`。 */
function bannerConnection(tail: string): string | undefined {
  const words = tail.trim().split(/\s+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!
    if (word.includes("=")) continue
    return word
  }
  return undefined
}

/**
 * 一次 gdb 调用的输出 → 一份排好版的现场。
 *
 * 认不出来的行一律忽略(调用方还握着原文);一个字段都认不出来时返回的对象是空的,
 * 由调用方决定要不要回落到"原样等宽显示"。
 */
export function parseGdbReport(output: string): GdbReport {
  const out: GdbReport = { frames: [], values: [], notes: [], breakpoints: [] }
  if (typeof output !== "string" || output.length === 0) return out

  const lines = output.split("\n")
  let stopFrom = -1

  for (const [index, raw] of lines.entries()) {
    const banner = BANNER.exec(raw)
    if (banner) {
      out.state = banner[1]
      if (banner[2]) out.location = banner[2]
      out.connection = bannerConnection(banner[3] ?? "")
      continue
    }
    const stop = STOP_LINE.exec(raw)
    if (stop) {
      out.stop = { n: Number(stop[1]), reason: stop[2].trim() || "halted" }
      stopFrom = index
      // 一次调用里可以有两次停止,后一次才是现状:frames / 故障跟着最后一个 ■ 重来。
      out.frames = []
      out.fault = undefined
      out.locals = undefined
      continue
    }
    const attached = ATTACHED_LINE.exec(raw)
    if (attached) {
      out.connection = out.connection ?? attached[1]
      out.via = attached[2]
      continue
    }
    const note = NOTE_LINE.exec(raw)
    if (note && stopFrom < 0) {
      out.notes.push({ key: note[1].toLowerCase(), value: note[2].trim() })
      continue
    }
    const brk = BREAK_SET_LINE.exec(raw)
    if (brk) {
      out.breakpoints.push({ n: brk[1], at: brk[2], where: brk[3] })
      continue
    }
    const value = VALUE_LINE.exec(raw)
    if (value) {
      out.values.push({ key: value[1], value: value[2].trim() })
      continue
    }

    const frame = FRAME_LINE.exec(raw)
    if (frame) {
      const at = frame[3]
      out.frames.push({
        n: Number(frame[1]),
        func: frame[2].trim(),
        at,
        short: /:\d+$/.test(at) ? `${basename(at.slice(0, at.lastIndexOf(":")))}:${at.slice(at.lastIndexOf(":") + 1)}` : undefined,
      })
      continue
    }

    const locals = LOCALS_LINE.exec(raw)
    if (locals) {
      out.locals = locals[1].trim()
      continue
    }

    const fault = FAULT_LINE.exec(raw)
    if (fault && stopFrom >= 0) {
      out.fault = {
        kind: fault[1].trim() || "fault",
        detail: fault[2].trim(),
        flags: faultFlags(fault[2]),
        address: faultAddress(fault[2]),
        stacked: [],
      }
      continue
    }

    if (!out.fault) continue

    const exc = EXC_FRAME_LINE.exec(raw)
    if (exc) {
      out.fault.stack = exc[1].trim()
      continue
    }
    const pc = FAULT_PC_LINE.exec(raw)
    if (pc) {
      out.fault.pcLine = raw.trim()
      const where = pc[1]
      out.fault.location = `${basename(where.slice(0, where.lastIndexOf(":")))}:${where.slice(where.lastIndexOf(":") + 1)}`
      continue
    }
    const stacked = STACKED_LINE.exec(raw)
    if (stacked) {
      out.fault.stacked = stacked[1]
        .trim()
        .split(/\s+/)
        .flatMap((pair) => {
          const cut = pair.indexOf("=")
          if (cut <= 0) return []
          return [{ key: pair.slice(0, cut), value: pair.slice(cut + 1) }]
        })
      continue
    }
  }

  // `show` 的值行长得像普通句子,所以只在停止报告之后、且不是旁白 / 帧 / locals 时才认。
  if (stopFrom >= 0) {
    for (const raw of lines.slice(stopFrom + 1)) {
      if (ASIDE_LINE.test(raw)) continue
      if (FRAME_LINE.test(raw) || LOCALS_LINE.test(raw) || STACKED_LINE.test(raw)) continue
      const show = SHOW_LINE.exec(raw)
      if (!show) continue
      out.values.push({ key: show[1].trim(), value: show[2].trim() })
    }
  }

  return out
}

/** `PRECISERR(精确数据总线错误 …);出事地址 BFAR=0xf0000000` → `["PRECISERR"]`。 */
function faultFlags(detail: string): string[] {
  const out: string[] = []
  for (const hit of detail.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const word = hit[1]
    if (word === "BFAR" || word === "MMFAR" || word === "CFSR" || word === "HFSR") continue
    if (!out.includes(word)) out.push(word)
  }
  return out
}

/** `出事地址 BFAR=0xf0000000` → `BFAR=0xf0000000`。 */
function faultAddress(detail: string): string | undefined {
  const hit = /\b((?:BFAR|MMFAR)\s*=\s*0x[0-9a-fA-F]+)/.exec(detail)
  return hit ? hit[1].replace(/\s+/g, "") : undefined
}
