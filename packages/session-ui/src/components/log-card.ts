/**
 * log 卡片的纯函数层 —— 六个动作(start / read / wait / status / stop / ports)各说各的结论。
 *
 * `details` 的形状对着 `host/tools/log/contract.ts` 的 `LogDetails`:
 * `{ action; running; cursor; totalLines; dropped; source?; file?; matched?; exitCode? }`。
 * 节选本身只在给模型看的文本里,而那段文本的排版是有意义的(工具自己折过重复行、
 * 标了 `← match`、末尾一条 `cursor: … | source: … | full log: …` 的汇总),所以这里
 * **只切分不重排**:说明行 / 日志行 / 汇总行三段,日志行照 LogPanel 那套上色。
 */
import { classifyLogLine, type LogLevel } from "./log-lines"

export type LogAction = "start" | "read" | "wait" | "status" | "stop" | "ports"

export interface LogCardLine {
  text: string
  level: LogLevel
  /** 工具自己标的 `← match` 那一行。 */
  hit: boolean
  /** 行首的 `[+1.710]` —— 弱化显示。 */
  lead?: string
}

export interface LogCard {
  action: LogAction | undefined
  capturing: boolean
  source?: string
  file?: string
  cursor?: number
  totalLines?: number
  dropped?: number
  matched?: boolean
  exitCode?: number | null
  /** 工具输出里"不是日志行"的那几句(matched /…/ at seq 8 (+1.710s)、N earlier lines skipped…)。 */
  notes: string[]
  /** 日志节选。 */
  lines: LogCardLine[]
  /** 末尾那条 `cursor: … | source: … | full log: …`。 */
  footer?: string
}

/** `[+1.710] *** HARDFAULT (stage 6) ***   ← match` —— 前导的相对时间戳。 */
const LEAD_STAMP = /^(\[[+-]?[\d.]+\]|\[\d{2}:\d{2}:\d{2}[.\d]*\])\s?/
/** 工具在命中行尾加的记号(log/excerpt.ts)。 */
const MATCH_MARK = /\s*←\s*match\s*$/
/** 汇总行:`cursor: 9 | source: running | full log: /…` */
const FOOTER = /^cursor:\s*\d+\s*\|/
/** 说明句(全是 ASCII 开头的英文句子,工具自己写的)。 */
const NOTE_PREFIX =
  /^(matched\s|no new lines\b|no match\b|\d+ earlier unread lines\b|Capturing\b|Full log:|stopped\b|source exited\b|timed out\b|Next:|waiting\b|\d+ serial ports?\b|no serial ports\b|capture is not running\b|not capturing\b)/i

const MAX_LINES = 60

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function actionOf(value: unknown): LogAction | undefined {
  const actions: readonly string[] = ["start", "read", "wait", "status", "stop", "ports"]
  return typeof value === "string" && actions.includes(value) ? (value as LogAction) : undefined
}

/**
 * `undefined` = 这条不像 log 的结果(metadata 里连 action 和 running 都没有),回落到通用卡。
 * 只要有 action 就认:`ports` 的 details 里没有 running。
 */
export function describeLog(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined,
): LogCard | undefined {
  const action = actionOf(metadata?.action) ?? actionOf(input?.action)
  if (!action) return undefined

  const text = typeof output === "string" ? output : ""
  const notes: string[] = []
  const lines: LogCardLine[] = []
  let footer: string | undefined

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue
    if (FOOTER.test(raw)) {
      footer = raw.trim()
      continue
    }
    if (lines.length === 0 && NOTE_PREFIX.test(raw.trim())) {
      notes.push(raw.trim())
      continue
    }
    const hit = MATCH_MARK.test(raw)
    const body = raw.replace(MATCH_MARK, "")
    const lead = LEAD_STAMP.exec(body)?.[1]
    lines.push({
      text: lead ? body.slice(lead.length).replace(/^\s/, "") : body,
      lead,
      hit,
      level: classifyLogLine(body),
    })
  }

  // `ports` 与 `status` 的输出不是日志行而是一张表;没有一行带时间戳时就别假装它是日志。
  const looksLikeLog = lines.some((line) => line.lead !== undefined) || action === "read" || action === "wait"
  if (!looksLikeLog && lines.length > 0) {
    notes.push(...lines.map((line) => (line.lead ? `${line.lead} ${line.text}` : line.text)))
    lines.length = 0
  }

  return {
    action,
    capturing: metadata?.running === true,
    source: str(metadata?.source) ?? str(input?.command) ?? str(input?.port) ?? str(input?.tcp),
    file: str(metadata?.file),
    cursor: num(metadata?.cursor),
    totalLines: num(metadata?.totalLines),
    dropped: num(metadata?.dropped),
    matched: typeof metadata?.matched === "boolean" ? metadata.matched : undefined,
    exitCode: typeof metadata?.exitCode === "number" ? metadata.exitCode : metadata?.exitCode === null ? null : undefined,
    notes,
    // 卡片是窗口不是记录:全文永远在 `details.file` 指的那个日志文件里。
    lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines,
    footer,
  }
}

/** `matched /HARDFAULT/ at seq 8 (+1.710s)` 里的那个偏移 —— 卡片折叠态那一句要它。 */
export function matchOffset(notes: readonly string[]): string | undefined {
  for (const note of notes) {
    const hit = /\(([+-][\d.]+s)\)\s*$/.exec(note)
    if (hit) return hit[1]
  }
  return undefined
}

/** 被节选掉的行数:`5 earlier unread lines were skipped`。 */
export function skippedLines(notes: readonly string[]): number | undefined {
  for (const note of notes) {
    const hit = /^(\d+)\s+earlier unread lines/.exec(note)
    if (hit) return Number(hit[1])
  }
  return undefined
}
