/**
 * scope 卡片的纯函数层。
 *
 * `ScopeDetails` 已经是结构化的(通道设置、时基、触发、量测、采集元数据),所以这一层
 * 不解析输出文本 —— 只折出"一句结论"并把量测排成读数。
 *
 * 一条纪律:**DEMO / 未验证型号的警告要留着**,但它是一条安静的标注,不是一段大字
 * (`details.warnings` 在连着的时候每条结果都重复)。
 */
import { scopeValue } from "./hw-format"

export type ScopeAction =
  | "devices"
  | "connect"
  | "disconnect"
  | "status"
  | "setup"
  | "capture"
  | "arm"
  | "collect"
  | "stop"
  | "measure"
  | "screenshot"
  | "list"
  | "samples"

const ACTIONS: readonly string[] = [
  "devices",
  "connect",
  "disconnect",
  "status",
  "setup",
  "capture",
  "arm",
  "collect",
  "stop",
  "measure",
  "screenshot",
  "list",
  "samples",
]

export interface ScopeChannel {
  ch: number
  on: boolean
  label?: string
  vdiv?: number
  offset?: number
  coupling?: string
  probe?: number
  bwlimit?: string
  unit?: string
  points?: number
}

export interface ScopeMeasurement {
  type: string
  source: string
  value: number | null
  unit?: string
  n?: number
}

export interface ScopeCard {
  action: ScopeAction | undefined
  address?: string
  driver?: string
  model?: string
  serial?: string
  captureId?: string
  dir?: string
  sampleRate?: number
  interval?: number
  points?: number
  quality?: string
  stride?: number
  mdepth?: string
  timebase?: { scale: number; delay: number }
  trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string }
  channels: ScopeChannel[]
  /** 开着的那些通道。折叠态只报这些。 */
  on: ScopeChannel[]
  measurements: ScopeMeasurement[]
  warnings: string[]
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
}

function actionOf(value: unknown): ScopeAction | undefined {
  return typeof value === "string" && ACTIONS.includes(value) ? (value as ScopeAction) : undefined
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

function channelsOf(value: unknown): ScopeChannel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const raw = item as Record<string, unknown>
    const ch = num(raw.ch)
    if (ch === undefined) return []
    return [
      {
        ch,
        on: raw.on === true,
        label: str(raw.label),
        vdiv: num(raw.vdiv),
        offset: num(raw.offset),
        coupling: str(raw.coupling),
        probe: num(raw.probe),
        bwlimit: str(raw.bwlimit),
        unit: str(raw.unit),
        points: num(raw.points),
      },
    ]
  })
}

function measurementsOf(value: unknown): ScopeMeasurement[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const raw = item as Record<string, unknown>
    const type = str(raw.type)
    if (!type) return []
    return [
      {
        type,
        source: str(raw.source) ?? "",
        // `value: null` = 这一次量不出来(信号不够周期)。**不是 0** —— 两者说的是相反的事。
        value: typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : null,
        unit: str(raw.unit),
        n: num(raw.n),
      },
    ]
  })
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

/** `undefined` = 连 action 都读不出来,回落到通用卡。 */
export function describeScope(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  _output: string | undefined,
): ScopeCard | undefined {
  const action = actionOf(metadata?.action) ?? actionOf(input?.action)
  if (!action) return undefined

  const channels = channelsOf(metadata?.channels)
  const timebase = metadata?.timebase
  const trigger = metadata?.trigger
  return {
    action,
    address: str(metadata?.address),
    driver: str(metadata?.driver),
    model: str(metadata?.model),
    serial: str(metadata?.serial),
    captureId: str(metadata?.captureId),
    dir: str(metadata?.dir),
    sampleRate: num(metadata?.sampleRate),
    interval: num(metadata?.interval),
    points: num(metadata?.points),
    quality: str(metadata?.quality),
    stride: num(metadata?.stride),
    mdepth: str(metadata?.mdepth),
    timebase:
      timebase && typeof timebase === "object"
        ? {
            scale: num((timebase as Record<string, unknown>).scale) ?? 0,
            delay: num((timebase as Record<string, unknown>).delay) ?? 0,
          }
        : undefined,
    trigger:
      trigger && typeof trigger === "object"
        ? {
            mode: str((trigger as Record<string, unknown>).mode),
            source: str((trigger as Record<string, unknown>).source),
            level: num((trigger as Record<string, unknown>).level),
            slope: str((trigger as Record<string, unknown>).slope),
            status: str((trigger as Record<string, unknown>).status),
          }
        : undefined,
    channels,
    on: channels.filter((channel) => channel.on),
    measurements: measurementsOf(metadata?.measurements),
    warnings: stringsOf(metadata?.warnings),
    armed: bool(metadata?.armed),
    timedOut: bool(metadata?.timedOut),
    truncated: bool(metadata?.truncated),
  }
}

/** `C1 C2 · 100k 点 · 20 ns/点`。 */
export function scopeConclusion(card: ScopeCard): string | undefined {
  const bits: string[] = []
  switch (card.action) {
    case "measure": {
      const first = card.measurements[0]
      if (first) {
        const rest = card.measurements.length - 1
        bits.push(
          `${first.type} ${first.source} ${first.value === null ? "—" : scopeValue(first.value, first.unit ?? "")}`.trim(),
        )
        if (rest > 0) bits.push(`+${rest}`)
      }
      break
    }
    case "connect":
    case "status":
    case "setup": {
      if (card.model) bits.push(card.model)
      if (card.on.length > 0) bits.push(card.on.map((channel) => `C${channel.ch}`).join(" "))
      if (card.timebase) bits.push(`${scopeValue(card.timebase.scale, "s")}/div`)
      break
    }
    case "disconnect":
      bits.push("released")
      break
    default: {
      if (card.on.length > 0) bits.push(card.on.map((channel) => `C${channel.ch}`).join(" "))
      if (card.points !== undefined) bits.push(`${compact(card.points)} pts`)
      if (card.interval !== undefined) bits.push(`${scopeValue(card.interval, "s")}/pt`)
      if (card.quality) bits.push(card.quality)
    }
  }
  if (card.timedOut) bits.unshift("timed out")
  if (card.armed) bits.unshift("armed")
  return bits.length > 0 ? bits.join(" · ") : undefined
}

function compact(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(2))}M`
  if (n >= 1e3) return `${Number((n / 1e3).toFixed(1))}k`
  return String(n)
}

/** DEMO 仪器那条:它说的是"这不是硬件证据",必须留着。 */
export function isDemoWarning(warning: string): boolean {
  return /DEMO instrument|synthesi[sz]ed in software/i.test(warning)
}
