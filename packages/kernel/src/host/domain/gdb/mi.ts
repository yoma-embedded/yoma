/**
 * gdb/MI3 协议的纯函数层:分帧、记录解析、值语法、c-string 转义、取值辅助。
 * 零 I/O、零依赖 —— 这既是它单独成文件的理由,也是它的价值:gdb 工具里唯一
 * 100% 不需要硬件、不需要子进程就能测的部分全在这儿。
 *
 * 【为什么不复用 log 工具的分块】
 * 那边超过一定长度会强制断行 —— 对"永远不打换行的串口设备"是对的,对 MI 是灾难:
 * MI 一条 record 就是一行,实测一条 `-symbol-info-functions` 回复 54,231 字符,
 * 一个 nRF52833 的 ELF 上 659,751 字节。切断的后果是静默的:每一段都解析失败,
 * token 永不 resolve,模型看到的现象是"目标卡死了"。所以这里只按 \n 切,超上限当硬错误。
 *
 * 【MI 的三个反直觉之处 —— 都是实测的,别照直觉写】
 * 1. 结果记录在它引起的异步记录**之后**到:
 *      =thread-group-started / *stopped / 20^connected  ← ^connected 最后
 *    所以"收到 ^done 才算这条命令结束"是对的,"^done 之后才有异步"是错的。
 * 2. `(gdb) ` 提示符在异步停止之后**不发**。拿它当分帧/派发信号会死锁。
 * 3. 一个 token 可能收到两条 `^` 记录(`^running` 之后再来 `^error,"Command aborted."`)。
 *    派发表必须 resolve-once,多出来的记进文件后丢弃。
 *
 * 于是会话层的骨架是两条互不相干的通路:token → promise(只吃 `^`),
 * 无 token 的 `*running`/`*stopped` → 目标状态机。耦合它们就是自找死锁。
 */

// ─── 分帧 ────────────────────────────────────────────────────────────────────

/**
 * 单条 record 的字符上限。实测最长见过 659,751 字节,这里留一个数量级余量;
 * 到顶意味着流已经不同步了(比如 `pipe`/`shell` 往 stdout 裸写),
 * 不是"这条特别长",所以调用方应当重启 gdb 而不是截断后继续。
 */
export const MAX_RECORD_CHARS = 4 * 1024 * 1024

export interface SplitResult {
  /** 完整的 record 行(不含结尾换行)。 */
  lines: string[]
  /** 残余,作为下一段的前缀传回来。 */
  pending: string
  /** 残余超过上限:流已失同步,调用方必须重启会话,不能吐半条 record。 */
  overflow: boolean
}

/**
 * 把一段 chunk 切成完整的 MI record 行。只按 \n 切 —— 见文件头。
 * 纯函数:pending 由调用方持有,于是可以逐字节喂 fixture 做边界测试。
 */
export function splitRecords(pending: string, chunk: string, maxRecordChars = MAX_RECORD_CHARS): SplitResult {
  const lines: string[] = []
  let buffer = pending + chunk
  while (true) {
    const nl = buffer.indexOf("\n")
    if (nl < 0) break
    let line = buffer.slice(0, nl)
    // gdb 在 Windows 上会带 \r;record 内容里的 \r 是转义过的,所以只需剥结尾。
    if (line.endsWith("\r")) line = line.slice(0, -1)
    lines.push(line)
    buffer = buffer.slice(nl + 1)
  }
  if (buffer.length > maxRecordChars) return { lines, pending: "", overflow: true }
  return { lines, pending: buffer, overflow: false }
}

// ─── 记录解析 ────────────────────────────────────────────────────────────────

export type RecordKind =
  /** `^done` / `^error` / `^running` / `^connected` / `^exit` —— 唯一带 token 派发的。 */
  | "result"
  /** `*stopped` / `*running` —— 喂状态机。 */
  | "exec"
  /** `+` 进度。 */
  | "status"
  /** `=` 通知(=breakpoint-modified / =thread-group-exited / …)。 */
  | "notify"
  /** `~` 控制台输出 —— `-interpreter-exec console` 的回复走这条。 */
  | "console"
  /** `@` 目标输出 —— monitor 的回复走这条,只收 `~` 会把它丢光。 */
  | "target"
  /** `&` gdb 自己的日志(错误说明、remote 断连提示都在这)。 */
  | "log"
  /** `(gdb) ` —— 丢弃,永远不当信号。 */
  | "prompt"
  /** 不是 MI 的行。`pipe`/`shell` 会裸写 stdout 造出这种。记录后丢弃,绝不抛。 */
  | "foreign"

export interface MiRecord {
  kind: RecordKind
  /** `22^done` 里的 22。异步记录一般没有。 */
  token?: number
  /** result-class(done/error/running/connected/exit)或 async-class(stopped/running/…)。 */
  class?: string
  /** 逗号后的 key=value 列表。 */
  results?: MiTuple
  /** 流记录(~ @ &)反转义后的正文。 */
  text?: string
  /**
   * 值语法没能吃完整行。**不降级成 foreign**:那会让这条命令的 promise 永远挂着,
   * 比拿到不全的数据更糟。调用方照常 resolve,但要把 raw 记进文件并在结果里标注。
   */
  partial?: true
  raw: string
}

const RESULT_PREFIX: Record<string, RecordKind> = {
  "^": "result",
  "*": "exec",
  "+": "status",
  "=": "notify",
}

const STREAM_PREFIX: Record<string, RecordKind> = {
  "~": "console",
  "@": "target",
  "&": "log",
}

/** class 名允许的字符:`done`、`stopped`、`breakpoint-modified`、`thread-group-added`。 */
const CLASS_RE = /^[A-Za-z][A-Za-z0-9_-]*/

/**
 * 解析一行 MI。任何解析不了的行都退化成 `foreign`,绝不抛异常 ——
 * 这是在 stdout 的 data 回调里跑的,抛出去就是一个没人接的 rejection。
 */
export function parseRecord(line: string): MiRecord {
  if (line === "" || line === "(gdb)" || line === "(gdb) ") return { kind: "prompt", raw: line }

  // 可选的前导 token
  let i = 0
  while (i < line.length && line[i]! >= "0" && line[i]! <= "9") i++
  const token = i > 0 ? Number(line.slice(0, i)) : undefined
  const prefix = line[i]
  if (!prefix) return { kind: "foreign", raw: line }

  const streamKind = STREAM_PREFIX[prefix]
  if (streamKind) {
    // token 对流记录没有意义,但语法上允许,解析了就不要丢。
    const body = line.slice(i + 1)
    if (!body.startsWith('"')) return { kind: "foreign", raw: line }
    const parsed = readCString(body, 0)
    if (!parsed) return { kind: "foreign", raw: line }
    return { kind: streamKind, token, text: parsed.value, raw: line }
  }

  const recordKind = RESULT_PREFIX[prefix]
  if (!recordKind) return { kind: "foreign", raw: line }

  const rest = line.slice(i + 1)
  const m = CLASS_RE.exec(rest)
  if (!m) return { kind: "foreign", raw: line }
  const cls = m[0]
  const tail = rest.slice(cls.length)
  if (tail !== "" && !tail.startsWith(",")) return { kind: "foreign", raw: line }

  if (tail === "") return { kind: recordKind, token, class: cls, results: {}, raw: line }
  const parsed = parseResultsStrict(tail.slice(1))
  const record: MiRecord = { kind: recordKind, token, class: cls, results: parsed.results, raw: line }
  if (!parsed.complete) record.partial = true
  return record
}

// ─── MI 值语法 ───────────────────────────────────────────────────────────────
//
// value → const | tuple | list
// const → c-string;tuple → "{" result,… "}";list → "[" (value|result),… "]"
//
// 两处真实世界的偏离,规范里没写清楚但 gdb 真会发:
// - list 里的 key 会重复:`stack=[frame={…},frame={…}]`。塌成一个对象就丢数据,
//   所以 list 元素里的 `k=v` 一律包成单键 tuple,取用时走 unwrapList()。
// - tuple 里会出现裸值:mi3 的 `script={"print x","continue"}`。碰到就当 list 解析。

export interface MiTuple {
  [key: string]: MiValue
}
export type MiValue = string | MiTuple | MiValue[]

/** 解析 `k=v,k=v,…`(record 逗号之后的部分)。 */
export function parseResults(src: string): MiTuple {
  return parseResultsStrict(src).results
}

/** 同上,外加报告有没有把整段吃完 —— 没吃完说明语法有缺口,必须标注出来。 */
export function parseResultsStrict(src: string): { results: MiTuple; complete: boolean } {
  const out: MiTuple = {}
  let pos = 0
  while (pos < src.length) {
    const r = readResult(src, pos)
    if (!r) break
    mergeResult(out, r.key, r.value)
    pos = r.next
    if (src[pos] === ",") pos++
    else break
  }
  return { results: out, complete: pos === src.length }
}

/** 解析单个 value(测试直接喂 `{a="1"}` 这种片段用)。 */
export function parseMiValue(src: string): MiValue | undefined {
  const r = readValue(src, 0)
  return r?.value
}

/**
 * 同名 key 在同一层重复时保留全部:第二次出现就升级成数组。
 * `-break-info` 的 body 就是这个形状。
 */
function mergeResult(target: MiTuple, key: string, value: MiValue): void {
  if (!(key in target)) {
    target[key] = value
    return
  }
  const existing = target[key]!
  if (Array.isArray(existing)) existing.push(value)
  else target[key] = [existing, value]
}

interface Read<T> {
  value: T
  next: number
}

function readResult(src: string, pos: number): (Read<MiValue> & { key: string }) | undefined {
  let i = pos
  while (i < src.length && /[A-Za-z0-9_.-]/.test(src[i]!)) i++
  if (i === pos || src[i] !== "=") return undefined
  const key = src.slice(pos, i)
  const v = readValue(src, i + 1)
  if (!v) return undefined
  return { key, value: v.value, next: v.next }
}

function readValue(src: string, pos: number): Read<MiValue> | undefined {
  const c = src[pos]
  if (c === '"') return readCString(src, pos)
  if (c === "{") return readBraced(src, pos, "}")
  if (c === "[") return readBraced(src, pos, "]")
  return undefined
}

/**
 * `{…}` 与 `[…]` 走同一段代码:两者都可能装 result、也都可能装裸 value。
 * 返回值形状按内容定 —— 全是 result 且是 `{}` 就给 tuple,其余一律给数组,
 * 数组元素里的 result 包成单键 tuple(见上文"key 会重复")。
 */
function readBraced(src: string, pos: number, close: "}" | "]"): Read<MiValue> | undefined {
  let i = pos + 1
  if (src[i] === close) return { value: close === "}" ? {} : [], next: i + 1 }

  const items: MiValue[] = []
  const tuple: MiTuple = {}
  let sawBare = false
  let sawResult = false

  while (i < src.length) {
    const r = readResult(src, i)
    if (r) {
      sawResult = true
      mergeResult(tuple, r.key, r.value)
      items.push({ [r.key]: r.value })
      i = r.next
    } else {
      const v = readValue(src, i)
      if (!v) return undefined
      sawBare = true
      items.push(v.value)
      i = v.next
    }
    if (src[i] === ",") {
      i++
      continue
    }
    break
  }
  if (src[i] !== close) return undefined
  const next = i + 1
  if (close === "}" && sawResult && !sawBare) return { value: tuple, next }
  return { value: items, next }
}

/**
 * 单字符转义 → 字节。null 原型:e 是从输入串里切出来的,不能让它撞上 `constructor`
 * 这类原型键(它恒为单个 UTF-16 码元,撞不上,但表本身不该有那个面)。
 */
const SIMPLE_ESCAPES: Record<string, number> = Object.assign(Object.create(null), {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  v: 0x0b,
  e: 0x1b,
  "\\": 0x5c,
  '"': 0x22,
  "'": 0x27,
})

/**
 * 读 c-string。gdb 发的是**字节串**:非 ASCII 按 UTF-8 逐字节转义成 \\346 这种,
 * 所以必须先还原成字节再按 UTF-8 解一次,直接按字符拼会得到乱码。
 */
function readCString(src: string, pos: number): Read<string> | undefined {
  if (src[pos] !== '"') return undefined
  const bytes: number[] = []
  let i = pos + 1
  while (i < src.length) {
    const c = src[i]!
    if (c === '"') return { value: decodeUtf8(bytes), next: i + 1 }
    if (c !== "\\") {
      // BMP 之外的字符在 JS 里是代理对,charCodeAt 会拆开 —— 用码点重新编码。
      const cp = src.codePointAt(i)!
      if (cp < 0x80) bytes.push(cp)
      else pushUtf8(bytes, cp)
      i += cp > 0xffff ? 2 : 1
      continue
    }
    i++
    const e = src[i]
    if (e === undefined) return undefined
    const simple = SIMPLE_ESCAPES[e]
    if (simple !== undefined) {
      bytes.push(simple)
      i++
    } else if (e >= "0" && e <= "7") {
      // 八进制:i 此时正指向 e,最多吃 3 位。
      let oct = ""
      while (oct.length < 3 && src[i]! >= "0" && src[i]! <= "7") oct += src[i++]
      bytes.push(Number.parseInt(oct, 8) & 0xff)
    } else {
      // 不认识的转义:原样保留反斜杠后的那个字符,别吞。
      pushUtf8(bytes, src.codePointAt(i)!)
      i += src.codePointAt(i)! > 0xffff ? 2 : 1
    }
  }
  return undefined
}

function pushUtf8(bytes: number[], cp: number): void {
  if (cp < 0x80) bytes.push(cp)
  else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
  else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false })

function decodeUtf8(bytes: number[]): string {
  return UTF8_DECODER.decode(Uint8Array.from(bytes))
}

/** 把 MI 的 c-string 转义回去(拼 `-interpreter-exec console "…"` 用)。 */
export function escapeCString(text: string): string {
  return text.replace(/[\\"\n\r\t]/g, (c) => {
    if (c === "\n") return "\\n"
    if (c === "\r") return "\\r"
    if (c === "\t") return "\\t"
    return `\\${c}`
  })
}

// ─── 取值辅助 ────────────────────────────────────────────────────────────────

export function miString(v: MiValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined
}

export function miTuple(v: MiValue | undefined): MiTuple | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as MiTuple) : undefined
}

/**
 * 把 list 摊平成元素数组:`[frame={…},frame={…}]` → 两个 frame tuple。
 * 单键包装(见 readBraced)在这里脱掉;单个元素没被包成 list 时也当一个元素处理,
 * 因为 gdb 在只有一项时偶尔直接给 tuple。
 */
export function unwrapList(v: MiValue | undefined, key?: string): MiTuple[] {
  if (v === undefined) return []
  const items = Array.isArray(v) ? v : [v]
  const out: MiTuple[] = []
  for (const item of items) {
    const t = miTuple(item)
    if (!t) continue
    const keys = Object.keys(t)
    if (key && keys.length === 1 && keys[0] === key) {
      const inner = miTuple(t[key])
      if (inner) {
        out.push(inner)
        continue
      }
    }
    out.push(t)
  }
  return out
}

/** MI 的数字一律是字符串,而且十进制/十六进制混着来。 */
export function miNumber(v: MiValue | undefined): number | undefined {
  const s = miString(v)
  if (s === undefined) return undefined
  const n = s.startsWith("0x") || s.startsWith("0X") ? Number.parseInt(s, 16) : Number(s)
  return Number.isFinite(n) ? n : undefined
}
