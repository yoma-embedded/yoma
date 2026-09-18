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

/**
 * 实现搬到了 session-ui 的 `hw-format.ts` —— 时间线里的 scope 卡片要用同一份,而它够不到 app。
 * 同一个电压在面板上和卡片上必须是同一串字。
 */
export { scopeValue } from "@yoma-desktop/session-ui/hw-format"

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
