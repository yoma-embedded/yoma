/**
 * 日志的实时尾巴 —— `instrument.logTail` 拉回来的行怎么接到面板上已有的行后面。纯函数,测试直接调。
 *
 * 为什么要有这一层(而不是继续每 2 秒读盘):RTT 的日志是"打出来就想看见"的,读盘那条路最多晚 2 秒,
 * 而且文件一过 2 MB 读到的是开头(`file.read` 截头)。采集在跑时,内核内存里的环形缓冲就是同一份内容
 * (落盘文件与它逐行同形,都是 `renderLine` 出来的 `[+1.234] 正文`),按序号增量拉最便宜。
 *
 * 三条规矩:
 * 1. **行号就是文件里的行号**:每次采集是一个新的 `hw-*.log`,采集器每收一行写一行,所以序号 seq 的那一行
 *    就是文件第 seq + 1 行。读盘那条路也按文件行号编(`numberLogLines` 的 offset),采集一停退回读盘时
 *    行号、正文逐行相同,`<Index>` 什么都不用改 —— 画面是连着的。
 * 2. **不跨洞拼接**。内核说 `lost > 0`(两次拉取之间环形缓冲溢出了,或者超过 2000 行的上限被截)时,
 *    旧的行不再往前接,这一窗口从新来的行重新开始 —— 否则两段之间少了几百行,看上去却是连着的。
 * 3. **没变就原样返回同一个数组**。`<Index>` 上游的引用一变,用户正选中的那段栈回溯就被清掉(复制不走)。
 * 4. **没在跟随时窗口不往前滑**(`hold`)。窗口满了(2000 行 / 256 KB)之后每来一行就从头丢一行,而 `<Index>`
 *    按下标复用节点:丢掉 N 行 = 每个下标换成原来 i + N 那一行,2000 行的字全部重写一遍 —— 用户往上翻着看
 *    一段 HardFault、正选中它时,画面每 200 ms 往上爬几行,选区盖住的是别的字,复制出来是错的。所以 hold 时
 *    只往后接、不从头丢(接在后面的行不动已有的行与选区);上限放到 `LIVE_HOLD_FACTOR` 倍,停在那儿翻太久
 *    才又开始滑,内存有底。跟随一开,下一拍照常砍回 2000 行 —— 那时画面本来就在底部。
 * 5. **采集停了,最后接一次**。停的那一刻写下的几行(`! RTT disconnected …` 这种说明为什么停了的)只在内核的
 *    缓冲里有;文件过了 2 MB 时读盘读到的是开头,根本读不到它们。所以回复说没在跑、但还接得上游标(同一份
 *    文件)时照样并进来,由调用方落地之后再退回读盘。接不上的(没有游标、换过一次采集)照旧 idle。
 */
import type { LogTailView } from "@yoma-desktop/kernel"
import { classifyLogLine, LOG_TAIL_BYTES, LOG_TAIL_LINES, type LogLine } from "./log-lines"

/** 没在跟随时(规矩 4)窗口最多留到平时的几倍。 */
export const LIVE_HOLD_FACTOR = 3

/** 实时游标:上一次合并的是哪一份文件,下一次从哪个序号拉。 */
export interface LiveCursor {
  file: string
  since: number
}

export type LiveMerge =
  /** 没有在跑的采集(没 start 过、停了、源断了)且接不上游标:退回读盘。停了但接得上的见规矩 5。 */
  | { kind: "idle" }
  /** 游标对不上这次回复(换了一次采集、序号倒退):不带 since 重拉一次。 */
  | { kind: "reset" }
  | {
      kind: "lines"
      lines: LogLine[]
      /** 这一窗口之前、文件里还有多少行没显示。 */
      clipped: number
      /** false 时 `lines` 就是传进来的那个数组。 */
      changed: boolean
      cursor: LiveCursor
    }

/** 把一段原文行编成 LogLine,行号 = offset + 下标 + 1(offset 是这一段之前文件里的行数)。 */
export function numberLogLines(lines: readonly string[], offset: number): LogLine[] {
  return lines.map((text, index) => ({ no: offset + index + 1, text, level: classifyLogLine(text) }))
}

/** 游标还对得上这次回复吗:同一份文件,序号没有倒退。 */
export function liveCursorStale(cursor: LiveCursor | undefined, view: LogTailView): boolean {
  if (!cursor) return false
  return view.file !== cursor.file || view.nextSeq < cursor.since
}

/**
 * 与读盘那条路同一道闸:最多 `maxLines` 行、`maxBytes` 个 UTF-16 码元,从头丢。
 * **最后一行永远留着**(同 `tailLines`:一行就超预算时宁可超,也不给一屏空白)。什么都没丢时原样返回。
 */
export function capLogLines(lines: LogLine[], maxLines = LOG_TAIL_LINES, maxBytes = LOG_TAIL_BYTES): LogLine[] {
  let from = Math.max(0, lines.length - maxLines)
  let bytes = 0
  for (let i = lines.length - 1; i >= from; i--) {
    bytes += lines[i].text.length + 1
    if (bytes > maxBytes && i < lines.length - 1) {
      from = i + 1
      break
    }
  }
  return from === 0 ? lines : lines.slice(from)
}

/** 行号与正文逐行相同(级别由正文决定,不用比)。 */
export function sameLogLines(a: readonly LogLine[], b: readonly LogLine[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].no !== b[i].no || a[i].text !== b[i].text) return false
  return true
}

/**
 * 把一次 `logTail` 的回复并进面板上已有的行。
 *
 * `cursor` 是发这次请求时用的游标(`undefined` = 没带 since,要的是整个窗口);`prev` 是面板上现在的行
 * —— 可能是上一拍实时拉的,也可能是读盘读的(那时 cursor 一定是 undefined,整窗替换)。
 * `hold`:用户没在跟随(见规矩 4)。回复说没在跑时只有还接得上游标的才并(规矩 5),调用方看 `view.running`。
 */
export function mergeLiveTail(
  prev: LogLine[],
  cursor: LiveCursor | undefined,
  view: LogTailView,
  options: { hold?: boolean } = {},
): LiveMerge {
  if (!view.file) return { kind: "idle" }
  if (!view.running && (!cursor || liveCursorStale(cursor, view))) return { kind: "idle" }
  if (liveCursorStale(cursor, view)) return { kind: "reset" }

  const first = view.nextSeq - view.lines.length
  const next: LiveCursor = { file: view.file, since: view.nextSeq }
  const clippedOf = (lines: readonly LogLine[]) => (lines.length ? lines[0].no - 1 : 0)
  const last = prev[prev.length - 1]
  // 接得上:带着游标、中间没丢行、而且面板上最后一行正好是新来的第一行的前一行(读盘换过行就接不上)。
  const glue = !!cursor && view.lost === 0 && (!last || last.no === first)

  if (glue && view.lines.length === 0)
    return { kind: "lines", lines: prev, clipped: clippedOf(prev), changed: false, cursor: next }

  const incoming = numberLogLines(view.lines, first)
  // hold 只管接得上的那种:丢了行 / 接不上本来就是整窗替换,没有"已有的行"可保。
  const lines = !glue
    ? capLogLines(incoming)
    : options.hold
      ? capLogLines(prev.concat(incoming), LIVE_HOLD_FACTOR * LOG_TAIL_LINES, LIVE_HOLD_FACTOR * LOG_TAIL_BYTES)
      : capLogLines(prev.concat(incoming))
  // 整窗替换但内容一行不差(刚从读盘切过来,读的正是这份文件):留着旧数组。
  if (!glue && sameLogLines(prev, lines))
    return { kind: "lines", lines: prev, clipped: clippedOf(prev), changed: false, cursor: next }
  return { kind: "lines", lines, clipped: clippedOf(lines), changed: true, cursor: next }
}

/**
 * 内核给的是绝对路径(`<工程>/.yoma/logs/hw-*.log`);feed 的 `path` 是相对工程根的,能直接喂回 `file.read`。
 * 不在工程目录下(理论上不会)就原样给绝对路径 —— 那只用来显示。
 */
export function liveLogPath(directory: string, file: string): { name: string; path: string } {
  const slashed = file.replace(/\\/g, "/")
  const name = slashed.slice(slashed.lastIndexOf("/") + 1)
  const root = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  const windows = /^[A-Za-z]:\//.test(root)
  const inside =
    root && (windows ? slashed.toLowerCase().startsWith(`${root.toLowerCase()}/`) : slashed.startsWith(`${root}/`))
  return { name, path: inside ? slashed.slice(root.length + 1) : file }
}
