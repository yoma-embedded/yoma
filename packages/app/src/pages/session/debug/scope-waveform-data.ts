import type { ScopeViewResult } from "@yoma-desktop/kernel"
import { BENCH_CHANNEL_COLORS } from "../bench/bench-theme"

export type ScopeTrace = ScopeViewResult["channels"][number]
/** 通道色的真源在 `bench/bench-theme.ts`(CSS 那份是 `--bench-ch1..ch4`,同解由测试钉住)。 */
export const SCOPE_COLORS: readonly string[] = BENCH_CHANNEL_COLORS

/** Times stay relative to the trigger, including negative pre-trigger windows. */
export function scopeWindow(from: number, to: number, fullFrom: number, fullTo: number, minSpan: number) {
  const fullSpan = fullTo - fullFrom
  const span = Math.min(fullSpan, Math.max(minSpan, to - from))
  const start = Math.max(fullFrom, Math.min(fullTo - span, from))
  return { from: start, to: start + span }
}

export function scopeValue(value: number, unit = "V"): string {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return `0 ${unit}`
  const magnitude = Math.abs(value)
  const scales = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]] as const
  const [scale, prefix] = scales.find(([s]) => magnitude >= s) ?? scales[scales.length - 1]
  return `${Number((value / scale).toPrecision(4))} ${prefix}${unit}`
}

/** Envelope columns are ranges, never a made-up midpoint voltage. */
export function scopeCursor(trace: ScopeTrace, time: number | undefined, from: number, to: number) {
  if (time === undefined || time < from || time > to || !trace.points.length) return undefined
  let lo = 0
  let hi = trace.points.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (trace.points[mid].t < time) lo = mid + 1
    else hi = mid
  }
  const right = trace.points[Math.min(lo, trace.points.length - 1)]
  const left = trace.points[Math.max(0, lo - 1)]
  return Math.abs(left.t - time) <= Math.abs(right.t - time) ? left : right
}

/** One voltage axis for compatible channels; no per-channel auto-scale disguising amplitude. */
export function scopeVoltageRange(channels: ScopeTrace[]) {
  let low = Infinity
  let high = -Infinity
  for (const channel of channels) for (const point of channel.points) {
    low = Math.min(low, point.min)
    high = Math.max(high, point.max)
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: -1, max: 1 }
  const pad = Math.max((high - low) * 0.1, Math.abs(high) * 0.005, 1e-6)
  return { min: low - pad, max: high + pad }
}

export function scopeTicks(from: number, to: number, count: number): number[] {
  const target = (to - from) / Math.max(1, count)
  if (!(target > 0)) return []
  const power = 10 ** Math.floor(Math.log10(target))
  const step = ([1, 2, 5, 10].find((factor) => factor * power >= target) ?? 10) * power
  const values: number[] = []
  for (let value = Math.ceil(from / step) * step; value <= to && values.length < 64; value += step) values.push(value)
  return values
}
