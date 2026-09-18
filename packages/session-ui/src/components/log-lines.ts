/**
 * 日志行的纯函数层 —— 挑文件、切尾巴、认级别。
 *
 * 单独一个文件是因为这三样是 `log-feed.ts` 里唯一值得钉死的部分:轮询与 RPC 那半靠肉眼看,
 * 而"哪一条算 error"错了不会报错,只会让一屏日志里真正的那一条不红。
 *
 * 这里不 import 任何 solid / kernel 的东西,测试直接调。
 */

/** 一行日志在界面上的分级。`info` 是缺省 —— 认不出来的行不该被涂色。 */
export type LogLevel = "error" | "warn" | "info" | "debug"

export interface LogLine {
  /** 从 1 起的行号,按本次读到的窗口算(不是文件里的绝对行号,文件可能被截过头)。 */
  no: number
  text: string
  level: LogLevel
}

/** 一屏最多留这么多行。log 工具自己的环形缓冲是 5000 行 / 512 KB,界面比它更克制。 */
export const LOG_TAIL_LINES = 2000
/**
 * 尾巴的长度上限。按 **UTF-16 码元**数,不是真字节 —— 中文日志实际能到三倍,
 * 这是一道防喷吐的粗闸门,不是配额。单行几十 KB 的二进制喷吐是真事。
 */
export const LOG_TAIL_BYTES = 256 * 1024

/** log 工具落盘的名字:`hw-<YYYYMMDD-HHMMSSmmm>.log`(host/tools/log/capture.ts)。 */
export function isLogFileName(name: string): boolean {
  return /^hw-.+\.log$/i.test(name)
}

/**
 * 挑"最新的那一份" hw-*.log。
 *
 * `file.list` 给的 FileEntry 没有 mtime,只有名字 —— 而 log 工具落盘的名字里带时间戳
 * (`hw-<时间戳>.log`),所以按名字倒序就是按时间倒序。名字里没有时间戳的(用户手放的)
 * 一样参与排序,只是排在哪儿由字典序说了算;这比"随便挑一个"好,也不会抛。
 *
 * 只认 `.log` 结尾、`hw-` 开头的普通文件 —— 采集器写的就是这一种,别把用户丢进来的
 * `notes.txt` 当成硬件日志喂给面板。
 */
export function pickNewestLogFile(entries: readonly { name: string; type?: string }[]): string | undefined {
  const names = entries
    .filter((entry) => entry.type !== "directory")
    .map((entry) => entry.name)
    .filter(isLogFileName)
  if (names.length === 0) return undefined
  // localeCompare 在不同 ICU 下对 `-`/`_` 的权重不一样,时间戳文件名会排错;按码位比。
  return names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]
}

/**
 * 把一段文本切成尾部若干行。
 *
 * 两条有代价的细节:
 * 1. **`file.read` 截的是头不是尾**(host/services.ts:读前 2 MB)。所以 `truncated` 为真时
 *    我们手上这段的末尾多半是半行 —— 它是被字节数切断的,不是文件真的到此为止。这里不管这件事,
 *    由调用方按 `truncated` 决定要不要丢掉最后一行(`dropLastPartial`)。
 * 2. 先按行砍,再按字节砍:一行几十 KB 的喷吐能让 2000 行远超字节上限,而按字节先砍会把
 *    行号算错。
 */
export function tailLines(
  content: string,
  options: { maxLines?: number; maxBytes?: number; dropLastPartial?: boolean } = {},
): string[] {
  const maxLines = options.maxLines ?? LOG_TAIL_LINES
  const maxBytes = options.maxBytes ?? LOG_TAIL_BYTES

  // \r\n 与裸 \r 都见过(Windows 串口、某些 RTT 实现)。
  let lines = content.split(/\r\n|\n|\r/)
  // 文件以换行收尾时 split 会多出一个空串,那不是一行。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (options.dropLastPartial && lines.length > 0) lines.pop()

  if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines)

  let bytes = 0
  let from = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += lines[i].length + 1
    // **最后一行永远留着**:一行就超预算(几十 KB 的二进制喷吐,正是这条限额要防的东西)时
    // 直接 break 会让 from 停在 lines.length,slice 出来是空数组 —— 一屏空白看着像面板坏了,
    // 而不是像日志太肥。宁可超一次预算,也要让人看见那一行。
    if (bytes > maxBytes && i < lines.length - 1) break
    from = i
  }
  return from === 0 ? lines : lines.slice(from)
}

// ---------------------------------------------------------------- 级别识别

/**
 * 按常见嵌入式日志形态认级别。
 *
 * 覆盖的写法(都是真见过的):
 * - ESP-IDF:`E (1234) wifi: ...` / `W (12) ...` / `I (12) ...` / `D (12) ...` / `V (12) ...`
 * - 方括号:`[ERR]` `[ERROR]` `[E]` `[WRN]` `[WARN]` `[W]` `[INF]` `[DBG]`
 * - Zephyr:`<err>` `<wrn>` `<inf>` `<dbg>`
 * - 裸词:行首 `ERROR:` `WARN:` `FATAL` `PANIC`
 * - Cortex-M 事故:`HardFault` `BusFault` `UsageFault` `MemManage` `ASSERT` `assert_failed`
 *   `Stack overflow` —— 这些不带级别前缀,但它们**就是**这块板子上最要紧的一行。
 *
 * 判定顺序是"先事故、再显式级别":`I (12) app: HardFault handler installed` 这种
 * 属于正常信息,所以事故词要求**词边界 + 不在明确的 info/debug 前缀之后**。
 */
const FAULT_WORDS =
  /\b(?:hard\s?fault|bus\s?fault|usage\s?fault|mem\s?manage|memmanage|stack\s+overflow|stack\s+smashing|kernel\s+oops|assert(?:ion)?\s+fail|assert_failed)\b/i
/** `panic` / `ASSERT` 太常见(`no panic detected` 就是一句好消息),要求它们站在行首那一段。 */
const FAULT_LEAD = /^[\s*[\]<>()|-]*(?:panic|ASSERT)\b/i

const BRACKET_LEVEL =
  /(?:^|[\s\])>])[[<(](e|err|error|f|fatal|crit|critical|w|wrn|warn|warning|i|inf|info|d|dbg|debug|v|vrb|verbose|trace)[\]>)]/i
/** ESP-IDF 的 `E (1234)` —— 单字母级别 + 空格 + 括号里的毫秒数,几乎不会误命中。 */
const IDF_LEVEL = /^\s*([EWIDV])\s*\(\s*\d+\s*\)/
/** 行首裸词:`ERROR:` `WARN -` `FATAL` 等。 */
const BARE_LEVEL = /^\s*(fatal|error|err|critical|crit|warning|warn|notice|info|debug|trace|verbose)\b\s*[:\-|\]]?/i

function normalizeLevelWord(word: string): LogLevel | undefined {
  const w = word.toLowerCase()
  if (w === "e" || w === "err" || w === "error" || w === "f" || w === "fatal" || w === "crit" || w === "critical")
    return "error"
  if (w === "w" || w === "wrn" || w === "warn" || w === "warning") return "warn"
  if (w === "i" || w === "inf" || w === "info" || w === "notice") return "info"
  if (w === "d" || w === "dbg" || w === "debug" || w === "v" || w === "vrb" || w === "verbose" || w === "trace")
    return "debug"
  return undefined
}

export function classifyLogLine(line: string): LogLevel {
  const idf = IDF_LEVEL.exec(line)
  if (idf) {
    const level = normalizeLevelWord(idf[1])
    if (level) return level
  }

  const bracket = BRACKET_LEVEL.exec(line)
  if (bracket) {
    const level = normalizeLevelWord(bracket[1])
    if (level) return level
  }

  const bare = BARE_LEVEL.exec(line)
  if (bare) {
    const level = normalizeLevelWord(bare[1])
    if (level) return level
  }

  // 没有任何级别标记的行:事故词自己就是级别。带级别标记的行上面已经返回了,
  // 所以 `I (12) ... HardFault handler installed` 不会走到这里。
  if (FAULT_WORDS.test(line) || FAULT_LEAD.test(line)) return "error"

  return "info"
}

/** 把一段尾巴变成带行号与级别的行。行号从 1 起,按这一窗口算。 */
export function toLogLines(lines: readonly string[]): LogLine[] {
  return lines.map((text, index) => ({ no: index + 1, text, level: classifyLogLine(text) }))
}

/** 过滤框:大小写不敏感的纯子串匹配。空串 = 不过滤(不是"全都不要")。 */
export function filterLogLines(lines: readonly LogLine[], query: string): LogLine[] {
  const q = query.trim().toLowerCase()
  if (!q) return lines as LogLine[]
  return lines.filter((line) => line.text.toLowerCase().includes(q))
}
