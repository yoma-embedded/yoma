/**
 * log 工具的文本纪律:把一条日志流变成模型看得起的节选。全是纯函数,采集器(capture.ts)与
 * 工具(session.ts)只是调它们;逐段喂 fixture 就能单测,不必起任何进程。
 *
 * 日志最容易淹没上下文,所以这里有四条规矩(与 attic/tools/log.ts 一脉相承):
 * 1. 节选有两道预算:行数(maxLines)和**字符数**—— 只卡行数拦不住 4 KB 一行的设备。
 * 2. 连续重复行折叠成 "×N";数字不同、其余相同的行(传感器刷屏)按"首行 + ×N + 末行"折叠。
 * 3. 超预算时按"头 + 命中关键字的行 + 尾"骨架采样:启动信息在头、最新状态在尾、异常在中间,三处都不能丢。
 * 4. 超长行按命中点开窗裁,不从行首裁:嵌入式串口上文本天然跟在二进制帧后面,从行首裁 400 字正好把
 *    证据裁掉(实测 B-G431B-ESC1 @ 921600,命中行 491 字符、"initialized" 在第 467 位)。
 */

/** 一直不吐换行的设备不该把内存吃光:到这个长度就强制断行。 */
export const MAX_LINE_CHARS = 4096

export const DEFAULT_MAX_LINES = 80
export const MAX_MAX_LINES = 500
/** 单行进上下文的上限,超出的部分只在日志文件里。 */
export const MAX_ROW_CHARS = 400
/** 每行的字符预算:maxLines 换算成字符预算的系数。 */
const CHARS_PER_ROW = 160
/** 一次节选的字符硬上限 —— 无论 maxLines 要多少,transcript 都不会被一次调用冲垮。 */
export const MAX_EXCERPT_CHARS = 24_000
/** 骨架采样保留的开头行数(启动信息)。 */
const HEAD_ROWS = 5

/** 超预算时优先保留的行:嵌入式日志里真正要紧的那几类。 */
const TRIPWIRE =
  /(hard\s?fault|bus\s?fault|mem\s?manage|usage\s?fault|panic|assert|fatal|exception|watchdog|stack overflow|\berrors?\b|\bwarn(ing)?\b|\bfail(ed|ure)?\b)/i

export interface LogLine {
  seq: number
  /** 相对采集启动的毫秒数。绝对时间对模型没用,相对时间才好推理。 */
  t: number
  text: string
  /** 来自 stderr(子进程源的诊断走这条;TCP 源没有 stderr)。 */
  err?: boolean
}

// 设备真的会吐控制字符,而 no-control-regex 不许把它们写进正则字面量:按码位拼出来。
const ESC = String.fromCharCode(0x1b)
const C0 = `${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const ANSI_ESC = new RegExp(`${ESC}[@-Z\\\\-_]`, "g")
const CONTROL_CHARS = new RegExp(`[${C0}]`, "g")

/** ANSI 转义 + 除 tab 外的控制字符:留在上下文里只会污染 diff 和 token。 */
export function sanitizeText(text: string): string {
  return text.replace(ANSI_CSI, "").replace(ANSI_ESC, "").replace(CONTROL_CHARS, "")
}

/**
 * 把一段 chunk 切成完整行,返回残余(下一段的前缀)。
 * 纯函数:状态(pending)由调用方持有,于是可以逐段喂 fixture 做单测。
 */
export function splitChunk(
  pending: string,
  chunk: string,
  maxLineChars = MAX_LINE_CHARS,
): { lines: string[]; pending: string } {
  const lines: string[] = []
  let buffer = pending + chunk.replace(/\r\n?/g, "\n")
  while (true) {
    const nl = buffer.indexOf("\n")
    if (nl >= 0) {
      lines.push(sanitizeText(buffer.slice(0, nl)))
      buffer = buffer.slice(nl + 1)
      continue
    }
    // 没有换行但已经超长 —— 强制断行,否则 pending 会无限增长。
    if (buffer.length > maxLineChars) {
      lines.push(sanitizeText(buffer.slice(0, maxLineChars)))
      buffer = buffer.slice(maxLineChars)
      continue
    }
    break
  }
  return { lines, pending: buffer }
}

/**
 * 命令行切 argv,认单双引号(转义只在双引号里认 \" 和 \\)。
 * 不经过 shell:参数里的空格/分号不会被二次解释。
 */
export function splitArgv(command: string): string[] {
  const argv: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === '"' && c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
      current += command[++i]
      started = true
      continue
    }
    if (quote) {
      if (c === quote) quote = undefined
      else current += c
      started = true
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) argv.push(current)
      current = ""
      started = false
      continue
    }
    current += c
    started = true
  }
  if (quote) throw new Error(`unbalanced ${quote} in command: ${command}`)
  if (started) argv.push(current)
  return argv
}

export interface FoldedRow {
  line: LogLine
  /** 折叠进来的原始行数(1 = 没折叠)。 */
  count: number
  /** 该组最后一行的相对时间。 */
  lastT: number
  /** 组内末行的文本,仅当它与首行不同(数字变化的刷屏)时才有。 */
  lastText?: string
}

/** 折叠比较用:把数字抹平,于是 "s=0413 ax=128" 和 "s=0459 ax=132" 属于同一类。 */
export function normalizeForFold(text: string): string {
  return text.replace(/\d+/g, "#")
}

/**
 * 连续同类的行折叠成一行。嵌入式日志的噪声大半是刷屏:
 * 完全相同 → "×N";只有数字在变 → 首行 + "×N" + 末行(数值漂移/饱和才看得出来)。
 */
export function foldLines(lines: LogLine[]): FoldedRow[] {
  const rows: FoldedRow[] = []
  for (const line of lines) {
    const last = rows[rows.length - 1]
    if (last && !!last.line.err === !!line.err && normalizeForFold(last.line.text) === normalizeForFold(line.text)) {
      last.count++
      last.lastT = line.t
      if (line.text !== last.line.text) last.lastText = line.text
      continue
    }
    rows.push({ line, count: 1, lastT: line.t })
  }
  return rows
}

export type DisplayRow =
  /** matchAt:命中在行内的字符下标 —— 超长行按它开窗裁(见 clipText)。 */
  | { type: "line"; row: FoldedRow; marked?: boolean; matchAt?: number }
  /** count 是省略掉的**原始行数**(不是折叠后的组数)。 */
  | { type: "gap"; count: number }

/** `+2.131` —— 秒 + 三位小数,比毫秒整数好读也好对齐。 */
export function formatElapsed(ms: number): string {
  return `+${(ms / 1000).toFixed(3)}`
}

/**
 * 单行的字符上限:超长行只留一段,全文在日志文件里。
 * `anchor` 是**必须留在窗口里**的位置(wait 的命中点);没有它就从行首裁。
 */
export function clipText(text: string, max = MAX_ROW_CHARS, anchor?: number): string {
  if (text.length <= max) return text
  // 窗口尽量把 anchor 摆在中间,再夹回 [0, length-max] —— 贴着行尾的命中就贴着行尾显示。
  const start = anchor === undefined ? 0 : Math.max(0, Math.min(anchor - Math.floor(max / 2), text.length - max))
  const after = text.length - start - max
  const before = start > 0 ? `…(+${start} chars before) ` : ""
  const tail = after > 0 ? `… (+${after} chars, full line in the log file)` : " (full line in the log file)"
  return `${before}${text.slice(start, start + max)}${tail}`
}

export function renderLine(line: LogLine): string {
  return `[${formatElapsed(line.t)}] ${line.err ? "! " : ""}${line.text}`
}

/** 渲染一条展示行。字符预算按它的返回值算,渲染与计价必须走同一个函数。 */
export function renderRow(entry: DisplayRow): string {
  if (entry.type === "gap") return `… ${entry.count} lines omitted (grep the full log for them) …`
  const { row, marked, matchAt } = entry
  const body = clipText(row.line.text, MAX_ROW_CHARS, matchAt)
  let text = `[${formatElapsed(row.line.t)}] ${row.line.err ? "! " : ""}${body}`
  if (row.count > 1) {
    text += ` ×${row.count}`
    text += row.lastText
      ? ` (numbers vary; last ${formatElapsed(row.lastT)}: ${clipText(row.lastText, 120)})`
      : ` (last ${formatElapsed(row.lastT)})`
  }
  return marked ? `${text}   ← match` : text
}

export function renderRows(rows: DisplayRow[]): string {
  return rows.map(renderRow).join("\n")
}

export interface SelectionResult {
  rows: DisplayRow[]
  /** 被省略的原始行数。 */
  omittedLines: number
}

/**
 * 骨架采样:超预算时保留 头 + 中间命中 TRIPWIRE 的行 + 尾。
 * 两道预算一起卡 —— 行数管"多",字符数管"长"。
 */
export function selectForDisplay(rows: FoldedRow[], maxLines: number, maxChars = MAX_EXCERPT_CHARS): SelectionResult {
  const budget = Math.max(1, Math.trunc(maxLines))
  const charBudget = Math.max(MAX_ROW_CHARS, Math.trunc(maxChars))
  const cost = (index: number) => renderRow({ type: "line", row: rows[index]! }).length + 1

  // 先按优先级把要保留的下标放进集合(集合天然去重,预算不会被重复计数),
  // 最后按下标顺序输出并在断裂处插省略标记。
  const keep = new Set<number>()
  let chars = 0
  const take = (index: number, cap = charBudget): boolean => {
    if (keep.has(index)) return true
    const next = cost(index)
    if (keep.size >= budget || chars + next > cap) return false
    keep.add(index)
    chars += next
    return true
  }

  // 最新一行**无条件**保留,预算再小也不能让节选空掉或者没有最新状态 —— 它最多让节选超预算一行的长度。
  // 顺序也是承重的:头部先花预算的话,行长(≥400 字符)时五行头就把 1920 字符的预览预算吃光,
  // 尾部与故障行一条都进不来(2026-09-14 审稿实测:30 行 500 字符,maxLines 12 只剩 seq 0-3)。
  const last = rows.length - 1
  if (last >= 0) {
    keep.add(last)
    chars += cost(last)
  }

  // 头部(启动信息):预算小到只够几行时全给尾巴;行数之外再限它只能花字符预算的 1/3。
  const headN = budget >= 4 ? Math.min(HEAD_ROWS, budget - 1) : 0
  const headCap = Math.min(charBudget, chars + Math.floor(charBudget / 3))
  for (let i = 0; i < Math.min(headN, last); i++) {
    if (!take(i, headCap)) break
  }

  // 中间要紧的行:从后往前找,只留最新的几条 —— 越靠近故障现场越有用。
  const midBudget = Math.max(0, Math.min(Math.floor((budget - headN) / 4), budget - headN - 1))
  for (let i = rows.length - 1, found = 0; i >= headN && found < midBudget; i--) {
    // 已经保留的行(最新那一行)不占名额:预览只有一个名额,被一句 "usb: error …" 的尾行白占掉,中间的 HardFault 就进不来。
    if (keep.has(i)) continue
    if (TRIPWIRE.test(rows[i]!.line.text) && take(i)) found++
  }

  // 预算剩下的部分从尾部往前填 —— 最新状态优先。第一条塞不下就收手,
  // 免得跳过一条长行、却把更旧的短行拉进来(顺序会变得莫名其妙)。
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!take(i)) break
  }

  const indices = [...keep].sort((a, b) => a - b)
  const out: DisplayRow[] = []
  let previous = -1
  let omittedLines = 0
  const gapBefore = (index: number) => {
    let lines = 0
    for (let i = previous + 1; i < index; i++) lines += rows[i]!.count
    if (lines > 0) {
      out.push({ type: "gap", count: lines })
      omittedLines += lines
    }
  }
  for (const index of indices) {
    gapBefore(index)
    out.push({ type: "line", row: rows[index]! })
    previous = index
  }
  gapBefore(rows.length)
  return { rows: out, omittedLines }
}

export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i")
  } catch (error) {
    throw new Error(`invalid pattern /${pattern}/: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** maxLines 换算出的字符预算,封顶 MAX_EXCERPT_CHARS。 */
export function charBudgetFor(maxLines: number): number {
  return Math.min(MAX_EXCERPT_CHARS, maxLines * CHARS_PER_ROW)
}
