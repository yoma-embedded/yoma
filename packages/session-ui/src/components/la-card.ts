/**
 * la 卡片的纯函数层。
 *
 * `LaDetails` 里已经是结构化的(采样率 / 样本数 / 通道 / 1024 列 × 2bit 的预览),所以这一层
 * 基本不解析文本 —— 只把 13 个动作折成"一句结论",再挑出要画的通道。
 *
 * **预览的读法不在这里**:`la-preview.ts` 是唯一一份(卡片与右栏面板共用),写第二份的后果
 * 是画出一张看起来很合理的假波形。
 */
import { formatFreq, formatSamples, type LaChannel, type LaPreview } from "./la-preview"

export type LaAction =
  | "devices"
  | "capture"
  | "arm"
  | "collect"
  | "stop"
  | "import"
  | "list"
  | "decoders"
  | "summary"
  | "decode"
  | "events"
  | "timing"
  | "expect"

const ACTIONS: readonly string[] = [
  "devices",
  "capture",
  "arm",
  "collect",
  "stop",
  "import",
  "list",
  "decoders",
  "summary",
  "decode",
  "events",
  "timing",
  "expect",
]

export interface LaCard {
  action: LaAction | undefined
  captureId?: string
  dir?: string
  samplerate?: number
  samples?: number
  durationMs?: number
  triggerPos?: number
  channels: LaChannel[]
  /** 有名字的那些通道(`D2` 这种自动名不算)。折叠态只报这些。 */
  named: LaChannel[]
  preview?: LaPreview
  decoders: { key: string; id: string; annotations: number }[]
  window?: { from: number; to: number }
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
  issues?: number
  device?: { model?: string; pid?: string; hdl?: number }
}

function actionOf(value: unknown): LaAction | undefined {
  return typeof value === "string" && ACTIONS.includes(value) ? (value as LaAction) : undefined
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** `{index, name}` 的数组;形状不对就当没有通道(不抛)。 */
function channelsOf(value: unknown): LaChannel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const index = num((item as Record<string, unknown>).index)
    if (index === undefined) return []
    const name = str((item as Record<string, unknown>).name) ?? String(index)
    const edges = num((item as Record<string, unknown>).edges)
    return [{ index, name, edges }]
  })
}

/** `preview` 必须是 `{columns, from, to, rows:{"0": base64}}`,少一样就不画。 */
function previewOf(value: unknown): LaPreview | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const columns = num(raw.columns)
  const rows = raw.rows
  if (!columns || columns <= 0 || !rows || typeof rows !== "object") return undefined
  const entries = Object.entries(rows as Record<string, unknown>).flatMap(([key, item]) =>
    typeof item === "string" ? [[key, item] as const] : [],
  )
  if (entries.length === 0) return undefined
  return {
    columns,
    from: num(raw.from) ?? 0,
    to: num(raw.to) ?? 0,
    rows: Object.fromEntries(entries),
  }
}

function decodersOf(value: unknown): LaCard["decoders"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const raw = item as Record<string, unknown>
    const key = str(raw.key)
    const id = str(raw.id)
    if (!key || !id) return []
    return [{ key, id, annotations: num(raw.annotations) ?? 0 }]
  })
}

/** 通道名是自动生成的序号(`2`、`10`)时不算"有名字"。 */
function isNamed(channel: LaChannel): boolean {
  return channel.name !== String(channel.index)
}

/** `undefined` = 连 action 都读不出来,回落到通用卡。 */
export function describeLa(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  _output: string | undefined,
): LaCard | undefined {
  const action = actionOf(metadata?.action) ?? actionOf(input?.action)
  if (!action) return undefined

  const channels = channelsOf(metadata?.channels)
  const window = metadata?.window
  return {
    action,
    captureId: str(metadata?.captureId),
    dir: str(metadata?.dir),
    samplerate: num(metadata?.samplerate),
    samples: num(metadata?.samples),
    durationMs: num(metadata?.durationMs),
    triggerPos: num(metadata?.triggerPos),
    channels,
    named: channels.filter(isNamed),
    preview: previewOf(metadata?.preview),
    decoders: decodersOf(metadata?.decoders),
    window:
      window && typeof window === "object"
        ? { from: num((window as Record<string, unknown>).from) ?? 0, to: num((window as Record<string, unknown>).to) ?? 0 }
        : undefined,
    armed: bool(metadata?.armed),
    timedOut: bool(metadata?.timedOut),
    truncated: bool(metadata?.truncated),
    issues: num(metadata?.issues),
    device:
      metadata?.device && typeof metadata.device === "object"
        ? {
            model: str((metadata.device as Record<string, unknown>).model),
            pid: str((metadata.device as Record<string, unknown>).pid),
            hdl: num((metadata.device as Record<string, unknown>).hdl),
          }
        : undefined,
  }
}

/** 折叠态那一句:`131k 采样 @ 25 MHz · 16 通道`。 */
export function laConclusion(card: LaCard): string | undefined {
  const bits: string[] = []
  if (card.timedOut) bits.push("timed out")
  if (card.armed) bits.push("armed")
  if (card.samples !== undefined) {
    bits.push(card.samplerate ? `${formatSamples(card.samples)} @ ${formatFreq(card.samplerate)}` : formatSamples(card.samples))
  }
  // 时长不进折叠态那一行:它在读数里,而这一行要留给"多少点 @ 多快 · 几通道"——
  // 右栏开着时中间那一栏只有 900 px,再加一段就把结论挤掉了(实测被截成 "16 …")。
  if (card.channels.length > 0) bits.push(`${card.channels.length} ch`)
  if (card.decoders.length > 0) {
    const total = card.decoders.reduce((sum, item) => sum + item.annotations, 0)
    bits.push(`${card.decoders.map((item) => item.id).join(" ")} ${total}`)
  }
  if (card.issues !== undefined) bits.push(`${card.issues} issue(s)`)
  if (bits.length === 0 && card.captureId) bits.push(card.captureId)
  return bits.length > 0 ? bits.join(" · ") : undefined
}
