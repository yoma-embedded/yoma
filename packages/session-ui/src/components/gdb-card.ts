/**
 * gdb 卡片的纯函数层 —— `details` + 停止报告文本 → 一句结论。
 *
 * 文本的读法在 `gdb-report.ts`(与右栏那两个面板同一份正则,见那个文件的头)。
 * 这一层只做"六个动作各自该说什么"。
 *
 * `GdbDetails`:`{ action; state; epoch; stopId; connection?; file?; path?; line? }`。
 * 故障不在 details 里,只在文本里 —— 所以 `fault` 一律来自 `parseGdbReport`。
 */
import { basename, parseGdbReport, type GdbReport } from "./gdb-report"

export type GdbAction = "start" | "break" | "exec" | "eval" | "status" | "stop"

export interface GdbCard {
  action: GdbAction | undefined
  /** details 的 state(`halted` / `running` / `exited` / `connection-lost` / `no-session`)。 */
  state?: string
  /** 现在停在哪(details 的 path:line 优先,它带的是本机路径)。 */
  location?: string
  /** 本机存在的源码绝对路径;不存在时 details 里就没有,别拿去开编辑器。 */
  path?: string
  line?: number
  connection?: string
  epoch?: number
  stopId?: number
  /** 会话转录的落盘路径。 */
  file?: string
  report: GdbReport
}

const ACTIONS: readonly string[] = ["start", "break", "exec", "eval", "status", "stop"]

function actionOf(value: unknown): GdbAction | undefined {
  return typeof value === "string" && ACTIONS.includes(value) ? (value as GdbAction) : undefined
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** `undefined` = 连 action 都读不出来,回落到通用卡。 */
export function describeGdb(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined,
): GdbCard | undefined {
  const action = actionOf(metadata?.action) ?? actionOf(input?.action)
  if (!action) return undefined

  const report = parseGdbReport(typeof output === "string" ? output : "")
  const path = str(metadata?.path)
  const line = num(metadata?.line)

  return {
    action,
    state: str(metadata?.state) ?? report.state,
    // details 的 path/line 是本机路径,横幅里那个是 gdb 说的 —— 两个都有时以 details 为准。
    location: path ? (line ? `${basename(path)}:${line}` : basename(path)) : shorten(report.location),
    path,
    line,
    connection: str(metadata?.connection) ?? report.connection,
    epoch: num(metadata?.epoch),
    stopId: num(metadata?.stopId),
    file: str(metadata?.file),
    report,
  }
}

function shorten(location: string | undefined): string | undefined {
  if (!location) return undefined
  const cut = location.lastIndexOf(":")
  if (cut <= 0 || !/^\d+$/.test(location.slice(cut + 1))) return basename(location)
  return `${basename(location.slice(0, cut))}:${location.slice(cut + 1)}`
}

/**
 * 折叠态那一句。故障优先 —— 它是整场调试里最值钱的一行。
 *
 * `undefined` = 说不出结论,调用方就只显示动作。
 */
export function gdbConclusion(card: GdbCard): { text: string; tone: "fail" | "attention" | "ok" | "idle" } | undefined {
  const { report } = card
  if (report.fault) {
    const where = report.fault.location ?? card.location
    const head = [report.fault.kind, report.fault.flags[0]].filter(Boolean).join(" ")
    const frame = report.frames.find((item) => item.short === where)
    return { text: [head, frame ? `${frame.func} ${where}` : where].filter(Boolean).join(" · "), tone: "fail" }
  }
  switch (card.action) {
    case "start": {
      const via = report.via ? `${report.via}` : undefined
      const where = card.location
      return { text: [via, card.state ?? "attached", where].filter(Boolean).join(" · "), tone: "ok" }
    }
    case "break": {
      const first = report.breakpoints[0]
      if (!first) return undefined
      return { text: `#${first.n} @ ${first.at}${first.where ? ` ${shorten(first.where)}` : ""}`, tone: "ok" }
    }
    case "exec": {
      if (!report.stop) return card.state ? { text: card.state, tone: "idle" } : undefined
      return { text: [report.stop.reason, card.location].filter(Boolean).join(" · "), tone: "attention" }
    }
    case "eval": {
      const last = report.values[report.values.length - 1]
      if (!last) return undefined
      return { text: `${last.key} = ${last.value}`, tone: "ok" }
    }
    case "status":
      return card.state ? { text: [card.state, card.location].filter(Boolean).join(" · "), tone: "idle" } : undefined
    case "stop":
      return { text: card.state === "no-session" ? "closed" : (card.state ?? "closed"), tone: "idle" }
    default:
      return undefined
  }
}
