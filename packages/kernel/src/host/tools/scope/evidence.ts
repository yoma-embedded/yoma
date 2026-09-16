/** Acquisition evidence: samples stay on disk; the tool and UI share capture.json. */
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { asciiPlot, findEdges, si, waveStats } from "../../domain/scope/analyze.ts"
import { codeToVolts, indexOfTime, timeOfIndex, type TimeScale, type VoltScale } from "../../domain/scope/preamble.ts"
import type { SiglentScope } from "../../domain/scope/siglent.ts"
import {
  listCaptures,
  readChannelCodes,
  SCOPE_DIR,
  writeCapture,
  type ScopeCaptureMeta,
  type StoredChannel,
} from "../../domain/scope/store.ts"
import { MAX_SCOPE_POINTS, type ScopeAction, type ScopeDetails, type ScopeInput } from "./contract.ts"

export type ScopeDevice = Pick<
  SiglentScope,
  | "address"
  | "identity"
  | "label"
  | "client"
  | "close"
  | "status"
  | "channel"
  | "trigger"
  | "triggerStatus"
  | "setChannel"
  | "setTimebase"
  | "setMemoryDepth"
  | "setTrigger"
  | "autoset"
  | "run"
  | "stop"
  | "single"
  | "waitForStop"
  | "readWaveform"
  | "measure"
  | "readMeasurements"
  | "screenshot"
>

export function acquisitionBudget(params: ScopeInput): {
  quality: "exact" | "overview"
  maxPoints: number
  stride?: number
} {
  const quality = params.quality ?? "exact"
  const maxPoints = params.points ?? (quality === "exact" ? MAX_SCOPE_POINTS : 4000)
  if (!Number.isInteger(maxPoints) || maxPoints < 16 || maxPoints > MAX_SCOPE_POINTS)
    throw new Error(`scope: points must be an integer from 16 to ${MAX_SCOPE_POINTS}`)
  if (params.stride !== undefined && (!Number.isInteger(params.stride) || params.stride < 1))
    throw new Error("scope: stride must be a positive integer")
  if (quality === "exact" && params.stride !== undefined && params.stride !== 1)
    throw new Error("scope: exact capture requires stride=1; use quality=overview to request decimation")
  return { quality, maxPoints, stride: quality === "exact" ? 1 : params.stride }
}

export async function saveEvidence(
  cwd: string,
  action: ScopeAction,
  s: ScopeDevice,
  params: ScopeInput,
  signal?: AbortSignal,
): Promise<{
  text: string
  details: ScopeDetails
  screenshotFailed?: boolean
  image?: { type: "image"; data: string; mimeType: string }
}> {
  const budget = acquisitionBudget(params)
  const status = await s.status(signal)
  if (!/stop/i.test(status.trigger.status))
    throw new Error("scope: acquisition is no longer stopped; refusing a mixed-frame capture")
  const channels = params.channels?.map((c) => c.ch) ?? status.channels.filter((c) => c.on).map((c) => c.ch)
  if (!channels.length) throw new Error("scope capture: no channel is on — enable a channel with scope setup first")
  if (new Set(channels).size !== channels.length) throw new Error("scope: duplicate capture channel")
  const waves = []
  for (const ch of channels) {
    if (!status.channels.find((c) => c.ch === ch)?.on) throw new Error(`scope: C${ch} is off; enable it before capture`)
    waves.push(await s.readWaveform(ch, { ...budget, signal }))
    if (!/stop/i.test(await s.triggerStatus(signal)))
      throw new Error("scope: acquisition resumed while reading channels; no coherent capture saved")
  }
  signal?.throwIfAborted()
  const first = waves[0]!
  const id = `scope-${randomUUID()}`
  const dir = path.join(cwd, SCOPE_DIR, id)
  const samples = new Map<number, Int16Array>()
  const stored: StoredChannel[] = []
  const details: ScopeDetails = {
    action,
    captureId: id,
    dir,
    address: s.label,
    model: s.identity.model,
    serial: s.identity.serial,
    sampleRate: first.sampleRate,
    interval: first.time.interval,
    points: first.codes.length,
    stride: first.stride,
    quality: budget.quality,
    timebase: { scale: first.time.tdiv, delay: first.time.delay },
    trigger: status.trigger,
    channels: [],
  }
  const lines = [
    `capture ${id}: ${budget.quality}; ${waves.length} channel(s), ${first.codes.length} points on C${first.ch}; interval ${si(first.time.interval, "s")}, stride ${first.stride}.`,
  ]
  let image: { type: "image"; data: string; mimeType: string } | undefined
  let screenshotFailed = false
  if (budget.quality === "overview")
    lines.push("OVERVIEW: decimated data may omit narrow pulses. This capture cannot prove that glitches are absent.")
  for (const wave of waves) {
    const state = status.channels.find((c) => c.ch === wave.ch)!
    const stats = waveStats(wave.codes, wave.scale, wave.time.interval)
    samples.set(wave.ch, wave.codes)
    stored.push({
      ch: wave.ch,
      label: state.label,
      file: `c${wave.ch}.i16`,
      points: wave.codes.length,
      vdiv: state.vdiv,
      offset: state.offset,
      coupling: state.coupling,
      probe: wave.probe,
      unit: wave.unit,
      bwlimit: state.bwlimit,
      gain: wave.scale.gain,
      rawOffset: wave.scale.offset,
      codePerDiv: wave.scale.codePerDiv,
      time: wave.time,
      stride: wave.stride,
      recordPoints: wave.recordPoints,
      sampleRate: wave.sampleRate,
    })
    details.channels!.push({ ...state, points: wave.codes.length, interval: wave.time.interval, stats })
    lines.push(
      `C${wave.ch}${state.label ? ` (${state.label})` : ""}: min ${si(stats.min, wave.unit)}, max ${si(stats.max, wave.unit)}, pp ${si(stats.pp, wave.unit)}, mean ${si(stats.mean, wave.unit)}, rms ${si(stats.rms, wave.unit)}${stats.freq ? `, crossing frequency estimate ${si(stats.freq, "Hz")}` : ""}; probe ${wave.probe}×, ${si(wave.time.interval, "s")}/point.`,
    )
    if (stats.pp < state.vdiv * 0.2)
      lines.push(`C${wave.ch}: small signal relative to range; check wiring and vdiv before trusting frequency/duty.`)
    if (params.plot) lines.push(asciiPlot(wave.codes, wave.scale, wave.time, { label: `C${wave.ch}`, unit: wave.unit }))
  }
  const meta: ScopeCaptureMeta = {
    id,
    createdAt: Date.now(),
    address: s.label,
    model: s.identity.model,
    serial: s.identity.serial,
    firmware: s.identity.firmware,
    mode: params.mode ?? "single",
    quality: budget.quality,
    timebase: details.timebase!,
    sampleRate: first.sampleRate,
    interval: first.time.interval,
    stride: first.stride,
    recordPoints: first.recordPoints,
    mdepth: status.acquire.mdepth,
    trigger: status.trigger,
    channels: stored,
  }
  if (params.screenshot !== false) {
    try {
      const png = await s.screenshot(signal)
      if (!/stop/i.test(await s.triggerStatus(signal)))
        throw new Error("scope: acquisition resumed before the screenshot completed")
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "screen.png"), png)
      meta.screenshot = { file: "screen.png", createdAt: Date.now() }
      if (png.byteLength <= 4 * 1024 * 1024)
        image = { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }
      else
        lines.push(
          `Screenshot exceeds the image attachment budget; saved at ${path.join(dir, "screen.png")}. Read that file to inspect it.`,
        )
    } catch (error) {
      signal?.throwIfAborted()
      screenshotFailed = true
      lines.push(`Screenshot unavailable; waveform evidence retained: ${String(error).slice(0, 300)}`)
    }
  }
  signal?.throwIfAborted()
  await writeCapture(dir, meta, samples)
  lines.push(`Saved: ${dir}. scope samples reads bounded windows; the front end opens this same capture.`)
  return { text: lines.join("\n"), details, image, screenshotFailed }
}

export async function savedSamples(
  cwd: string,
  params: ScopeInput,
  lastId?: string,
): Promise<{ text: string; details: ScopeDetails }> {
  const all = await listCaptures(cwd)
  const id = params.capture ?? lastId ?? all[0]?.id
  const meta = all.find((m) => m.id === id)
  if (!meta) throw new Error(`scope samples: no capture ${id ?? "yet"}; use scope list or capture first`)
  const stored = meta.channels.find((c) => c.ch === (params.channel ?? meta.channels[0]?.ch))
  if (!stored) throw new Error("scope samples: requested channel is not in this capture")
  const codes = await readChannelCodes(meta.dir, stored)
  const scale: VoltScale = {
    gain: stored.gain,
    offset: stored.rawOffset,
    codePerDiv: stored.codePerDiv,
    probe: stored.probe,
  }
  const time: TimeScale = stored.time ?? {
    delay: meta.timebase.delay,
    tdiv: meta.timebase.scale,
    interval: meta.interval,
    grid: 10,
  }
  const from = params.fromUs === undefined ? 0 : Math.max(0, Math.floor(indexOfTime(params.fromUs * 1e-6, time)))
  const to =
    params.toUs === undefined
      ? codes.length
      : Math.min(codes.length, Math.ceil(indexOfTime(params.toUs * 1e-6, time)) + 1)
  if (to <= from) throw new Error("scope samples: empty window; times are microseconds relative to trigger")
  const win = codes.subarray(from, to)
  const limit = Math.min(1000, Math.max(1, Math.floor(params.limit ?? 200)))
  const stride = stored.stride ?? meta.stride
  const recordPoints = stored.recordPoints ?? meta.recordPoints
  const quality = meta.quality ?? (stride === 1 && stored.points === recordPoints ? "exact" : "overview")
  const lines = [`${meta.id} C${stored.ch}: ${win.length} samples, ${si(time.interval, "s")}/point; ${quality}.`]
  let truncated = false
  if (stride > 1)
    lines.push("Decimated acquisition; omitted samples cannot be recovered, absence of a glitch is not established.")
  else if (quality === "overview")
    lines.push(
      `Overview acquisition: ${stored.points} stored points of a ${recordPoints}-point record; absence of a glitch is not established.`,
    )
  if (params.edges) {
    const stats = waveStats(win, scale, time.interval)
    const threshold = params.threshold ?? (stats.min + stats.max) / 2
    const level = ((threshold / scale.probe + scale.offset) * scale.codePerDiv) / scale.gain
    const hysteresis = Math.max(2, (((stats.pp * 0.1) / scale.probe) * scale.codePerDiv) / scale.gain)
    const edges = findEdges(win, level, hysteresis, limit + 1)
    truncated = edges.length > limit
    lines.push(`Crossings at ${si(threshold, stored.unit)} (hysteresis); time, direction, time to next edge:`)
    for (const [i, edge] of edges.slice(0, limit).entries())
      lines.push(
        `${si(timeOfIndex(from + edge.index, time), "s")} ${edge.rising ? "rising" : "falling"} ${edges[i + 1] ? si((edges[i + 1]!.index - edge.index) * time.interval, "s") : "-"}`,
      )
  } else {
    const every = Math.max(1, Math.floor(params.every ?? Math.ceil(win.length / limit)))
    truncated = Math.ceil(win.length / every) > limit
    lines.push(`Showing every ${every} stored sample; time, ${stored.unit}:`)
    for (let i = 0, row = 0; i < win.length && row < limit; i += every, row++)
      lines.push(`${si(timeOfIndex(from + i, time), "s")} ${si(codeToVolts(win[i]!, scale), stored.unit)}`)
  }
  return {
    text: lines.join("\n"),
    details: {
      action: "samples",
      captureId: meta.id,
      dir: meta.dir,
      points: win.length,
      interval: time.interval,
      truncated,
      quality,
      channels: [{ ch: stored.ch, unit: stored.unit, probe: stored.probe }],
    },
  }
}
