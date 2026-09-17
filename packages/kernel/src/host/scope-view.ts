/** Read-only, bounded view of immutable scope evidence. Never opens an instrument. */
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import type { ScopeCaptureInfo, ScopeChannelInfo, ScopeViewParams, ScopeViewResult } from "../scope-view.ts"
import { codeToVolts, timeOfIndex } from "./domain/scope/preamble.ts"
import { pngComplete } from "./domain/scope/scpi.ts"
import { listCaptures, readCaptureMeta, readChannelCodes, type ScopeCaptureMeta } from "./domain/scope/store.ts"

export function captureInfo(meta: ScopeCaptureMeta, dir: string): ScopeCaptureInfo {
  const channels: ScopeChannelInfo[] = meta.channels.map((ch) => ({
    ch: ch.ch,
    label: ch.label,
    unit: ch.unit,
    probe: ch.probe,
    coupling: ch.coupling,
    vdiv: ch.vdiv,
    offset: ch.offset,
    points: ch.points,
    recordPoints: ch.recordPoints ?? meta.recordPoints,
    stride: ch.stride ?? meta.stride,
    interval: ch.time?.interval ?? meta.interval,
    t0: ch.time ? timeOfIndex(0, ch.time) : meta.timebase.delay - 5 * meta.timebase.scale,
    ...(ch.clipped ? { clipped: ch.clipped } : {}),
  }))
  return {
    id: meta.id,
    dir,
    createdAt: meta.createdAt,
    ...(meta.acquiredAt ? { acquiredAt: meta.acquiredAt } : {}),
    address: meta.address,
    ...(meta.driver ? { driver: meta.driver } : {}),
    model: meta.model,
    serial: meta.serial,
    mode: meta.mode,
    quality:
      meta.quality ?? (channels.every((ch) => ch.stride === 1 && ch.points === ch.recordPoints) ? "exact" : "overview"),
    trigger: meta.trigger,
    channels,
    from: Math.min(...channels.map((ch) => ch.t0)),
    // Half-open intervals keep a single-sample view nonempty and include the last stored point.
    to: Math.max(...channels.map((ch) => ch.t0 + ch.points * ch.interval)),
    screenshot: meta.screenshot ? { createdAt: meta.screenshot.createdAt } : undefined,
  }
}

export async function scopeCaptures(directory: string): Promise<ScopeCaptureInfo[]> {
  return (await listCaptures(directory)).map((meta) => captureInfo(meta, meta.dir))
}

export async function scopeView(params: ScopeViewParams): Promise<ScopeViewResult> {
  if (!Number.isFinite(params.columns) || params.columns < 1) throw new Error("scope.view: invalid columns")
  for (const value of [params.from, params.to]) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error("scope.view: invalid time window")
  }
  if (
    params.channels &&
    (!Array.isArray(params.channels) || params.channels.some((ch) => !Number.isInteger(ch) || ch < 1 || ch > 4))
  ) {
    throw new Error("scope.view: invalid channels")
  }
  const meta = await readCaptureMeta(params.dir)
  const capture = captureInfo(meta, params.dir)
  const columns = Math.min(4096, Math.floor(params.columns))
  const from = Math.max(capture.from, params.from ?? capture.from)
  const to = Math.min(capture.to, params.to ?? capture.to)
  if (to <= from) throw new Error("scope.view: time window does not intersect this capture")
  const channels: ScopeViewResult["channels"] = []
  for (const ch of meta.channels) {
    if (params.channels && !params.channels.includes(ch.ch)) continue
    const timing = capture.channels.find((item) => item.ch === ch.ch)!
    const codes = await readChannelCodes(params.dir, ch)
    const start = Math.max(0, Math.ceil((from - timing.t0) / timing.interval - 1e-7))
    const end = Math.min(codes.length, Math.ceil((to - timing.t0) / timing.interval - 1e-7))
    const exact = end - start <= columns
    const points: ScopeViewResult["channels"][number]["points"] = []
    const scale = { gain: ch.gain, offset: ch.rawOffset, codePerDiv: ch.codePerDiv, probe: ch.probe }
    if (exact) {
      for (let i = start; i < end; i++) {
        const value = codeToVolts(codes[i]!, scale)
        points.push({ t: timing.t0 + i * timing.interval, min: value, max: value })
      }
    } else {
      // Partition by sample index; every saved sample is included once, so narrow peaks survive.
      for (let col = 0; col < columns; col++) {
        const a = start + Math.floor(((end - start) * col) / columns)
        const b = start + Math.floor(((end - start) * (col + 1)) / columns)
        let min = Infinity
        let max = -Infinity
        for (let i = a; i < b; i++) {
          min = Math.min(min, codes[i]!)
          max = Math.max(max, codes[i]!)
        }
        if (b > a)
          points.push({
            t: timing.t0 + ((a + b - 1) / 2) * timing.interval,
            min: codeToVolts(min, scale),
            max: codeToVolts(max, scale),
          })
      }
    }
    channels.push({ ch: ch.ch, label: ch.label, unit: ch.unit, exact, points })
  }
  return { capture, from, to, columns, channels }
}

export async function scopeScreenshot(dir: string): Promise<{ url: string; createdAt: number } | undefined> {
  const meta = await readCaptureMeta(dir)
  if (!meta.screenshot) return undefined
  const file = path.join(dir, meta.screenshot.file)
  const info = await lstat(file)
  if (!info.isFile() || info.size > 12 * 1024 * 1024) throw new Error("scope: invalid saved screenshot")
  const data = await readFile(file)
  const end = pngComplete(data)
  // Older USB captures include the instrument's trailing line terminator after IEND.
  if (end === undefined || data.subarray(end).some((byte) => byte !== 10 && byte !== 13))
    throw new Error("scope: saved screenshot is incomplete PNG")
  return {
    url: `data:image/png;base64,${data.subarray(0, end).toString("base64")}`,
    createdAt: meta.screenshot.createdAt,
  }
}
