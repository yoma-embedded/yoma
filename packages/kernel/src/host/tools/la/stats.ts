/**
 * la 工具里不碰硬件、不碰磁盘的那几段:脉宽统计、窗口换算、采集参数校验。
 *
 * 单独成文件是为了**本机就能测**:逻辑分析仪的引擎(`engines/bin/yoma-la`)要 MSYS2 / glib / libusb
 * 才编得出来,开发机上常常没有;而这几段恰恰是最容易算错又最没人看得出算错的地方 ——
 * 时序结论(“时钟是 400 kHz”“有 3 个毛刺”)错了不会报错,只会让模型自信地给出错误的根因。
 */

import { fmtTime } from "../../domain/la/annotations.ts"
import { parseSizeString } from "../../domain/la/dsl.ts"
import type { CaptureSpec } from "../../domain/la/engine.ts"
import { clamp } from "../../domain/engines.ts"
import { DEFAULT_CAPTURE_TIMEOUT_MS, DEFAULT_SAMPLERATE, DEFAULT_SAMPLES, type LaInput } from "./contract.ts"

const MIN_CAPTURE_TIMEOUT_MS = 1_000
const MAX_CAPTURE_TIMEOUT_MS = 60 * 60_000

export interface PulseStat {
  min: number
  max: number
  mean: number
  median: number
}

export interface PulseStats {
  high?: PulseStat
  low?: PulseStat
  period?: PulseStat
  /** ≤ 2 个采样的脉冲:要么是真毛刺,要么是采样率不够 —— 两种都必须让模型知道。 */
  glitches: number
}

/**
 * 一趟算完脉宽统计。中位数要排序,用 TypedArray 原地排,不拷一份 number[] ——
 * 一次真实采集几万到几百万个边沿,拷贝是实打实的内存。
 *
 * `levelAfterFirst` 是**第一个边沿之后**的电平(0/1):边沿列表只记翻转点,电平要从初始值推。
 */
export function pulseStats(edges: Uint32Array | readonly number[], levelAfterFirst: 0 | 1): PulseStats {
  const at = (i: number): number => (edges as readonly number[])[i] as number
  const n = edges.length - 1
  if (n <= 0) return { glitches: 0 }
  const widths = new Uint32Array(n)
  let highs = 0
  let lows = 0
  for (let i = 0; i < n; i++) widths[i] = at(i + 1) - at(i)
  let level = levelAfterFirst
  for (let i = 0; i < n; i++) {
    if (level) highs++
    else lows++
    level = (level ^ 1) as 0 | 1
  }
  const high = new Uint32Array(highs)
  const low = new Uint32Array(lows)
  level = levelAfterFirst
  for (let i = 0, h = 0, l = 0; i < n; i++) {
    if (level) high[h++] = widths[i]!
    else low[l++] = widths[i]!
    level = (level ^ 1) as 0 | 1
  }
  const periods = new Uint32Array(Math.max(0, Math.floor((edges.length - 1) / 2)))
  for (let i = 2, k = 0; i < edges.length; i += 2) periods[k++] = at(i) - at(i - 2)
  let glitches = 0
  for (let i = 0; i < n; i++) if (widths[i]! <= 2) glitches++
  return { high: summarize(high), low: summarize(low), period: summarize(periods), glitches }
}

function summarize(values: Uint32Array): PulseStat | undefined {
  if (values.length === 0) return undefined
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]!
  // TypedArray 的 sort 是数值序(Array 的默认 sort 是字典序 —— 那会让中位数完全错掉)。
  values.sort()
  return {
    min: values[0]!,
    max: values[values.length - 1]!,
    mean: sum / values.length,
    median: values[values.length >> 1]!,
  }
}

export interface CaptureWindow {
  from: number
  to: number
}

/** 毫秒窗口 → 采样号窗口,钳在采集范围内。空窗口直接抛:静默返回 0 条会被当成"总线上什么都没有"。 */
export function windowOf(
  meta: { samplerate: number; samples: number; durationMs: number },
  fromMs: number | undefined,
  toMs: number | undefined,
): CaptureWindow {
  const rate = meta.samplerate
  const from = fromMs !== undefined ? Math.max(0, Math.floor((fromMs / 1e3) * rate)) : 0
  const to = toMs !== undefined ? Math.min(meta.samples, Math.ceil((toMs / 1e3) * rate)) : meta.samples
  if (to <= from) {
    // fmtTime 而不是裸毫秒:一小时的采集会写成 "0..3600000.000 ms",人和模型都要停下来数零。
    throw new Error(
      `la: empty window (fromMs=${fromMs}, toMs=${toMs}); this capture spans 0..${fmtTime(meta.durationMs / 1e3)}`,
    )
  }
  return { from, to }
}

/**
 * 参数 → 引擎的采集规格,顺带把三样写错了才发现的东西提前拦下:采样数 / 采样率的写法、触发符。
 * 引擎那边对这三样的报错是 libsigrok 的原话,模型看不懂也改不对。
 */
export function captureSpecOf(params: Partial<LaInput>): CaptureSpec {
  const spec: CaptureSpec = {
    device: params.device,
    samplerate: params.samplerate ?? DEFAULT_SAMPLERATE,
    samples: params.samples ?? (params.durationMs ? undefined : DEFAULT_SAMPLES),
    durationMs: params.samples ? undefined : params.durationMs,
    channels: params.channels,
    trigger: params.trigger,
    triggerPositionPct: params.triggerPositionPct,
    mode: params.mode,
    vth: params.vth,
    timeoutMs: clamp(params.timeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS, MIN_CAPTURE_TIMEOUT_MS, MAX_CAPTURE_TIMEOUT_MS),
  }
  if (spec.samples !== undefined && parseSizeString(spec.samples) === undefined) {
    throw new Error(`la: samples "${spec.samples}" — write it like "1M" or "200k" (decimal)`)
  }
  if (spec.samplerate !== undefined && parseSizeString(spec.samplerate) === undefined) {
    throw new Error(`la: samplerate "${spec.samplerate}" — write it like "25M" or "500k"`)
  }
  for (const [channel, edge] of Object.entries(spec.trigger ?? {})) {
    if (!/^[01rfcx]$/i.test(edge)) throw new Error(`la: trigger["${channel}"]="${edge}" — use r / f / c / 0 / 1 / x`)
  }
  return spec
}
