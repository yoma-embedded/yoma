/**
 * DemoScope —— 不需要硬件的示波器驱动,信号在软件里合成。用途:没有仪器的机器上开发工具契约、
 * 界面和分析算法;一致性测试(test/scope-conformance.ts)拿它和 Siglent 假机各跑一遍。
 *
 * 它**不是证据**:identity.model 是 "DEMO",warnings 里写明,capture.json 的 model 字段也会是 DEMO。
 * 缺省不进注册表,`YOMA_SCOPE_DEMO=1` 才有(registry.ts),免得普通用户的 agent 拿假波形当真。
 *
 * 四路固定信号(时间 0 对齐触发,单位是通道显示单位):
 *  - C1:1 kHz 正弦,2 Vpp,直流 +0.5 V,叠 5 mV 噪声
 *  - C2:1 kHz 3.3 V 逻辑方波,占空 30%,RC 边沿(τ 0.3 µs),约 8% 过冲振铃 —— 给 base/top、rise、duty、overshoot 用
 *  - C3:1 kHz 三角波 ±1 V(没有稳态电平,直方图 base/top 应当放弃)
 *  - C4:1.8 V 直流 + 20 mV 噪声,t = +1.2345 ms 处一个 200 ns 掉到 0 V 的毛刺 —— 给"能不能证明没毛刺"用
 * 码域与 Siglent HD 同(7680 码/格,int16),量程外自然削波,所以 vdiv 设小了 clipped 会响。
 */
import { deflateSync } from "node:zlib"
import { waveStats } from "./analyze.ts"
import {
  type AcquireState,
  type Applied,
  type ChannelSpec,
  type ChannelState,
  type MeasureItem,
  type MeasureResult,
  type ReadWaveformOptions,
  type ScopeAddress,
  type ScopeCapabilities,
  type ScopeDriver,
  type ScopeDriverSpec,
  type ScopeIdentity,
  type ScopeStatus,
  type TimebaseSpec,
  type TimebaseState,
  type TriggerSpec,
  type TriggerState,
  type Waveform,
  type MeasurementName,
  measurementName,
} from "./driver.ts"
import { codeToVolts, type VoltScale } from "./preamble.ts"

const CODE_PER_DIV = 7680
const PROBES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
const DEPTHS = ["1k", "10k", "100k", "1M"]
/** 词表里这台假仪器算得出来的那些(脉宽两项 analyze.ts 还没有) */
const MEASURES: readonly MeasurementName[] = [
  "frequency",
  "period",
  "pkpk",
  "amplitude",
  "max",
  "min",
  "top",
  "base",
  "mean",
  "rms",
  "acrms",
  "duty",
  "rise",
  "fall",
  "overshoot",
  "undershoot",
]
const MAX_RATE = 2e9
const CHANNEL_COLORS = ["#ffff00", "#ff6abc", "#00ffff", "#00c100"]

function snap125(v: number, min: number, max: number): number {
  if (!(v > 0)) return min
  const clamped = Math.min(Math.max(v, min), max)
  let best = min
  for (let decade = -13; decade <= 4; decade++) {
    for (const step of [1, 2, 5]) {
      const candidate = step * 10 ** decade
      if (candidate < min * (1 - 1e-9) || candidate > max * (1 + 1e-9)) continue
      if (candidate <= clamped * (1 + 1e-9)) best = candidate
    }
  }
  return best
}

function depthPoints(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(text.trim())
  if (!m) return undefined
  return Number(m[1]) * (m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : 1)
}

/** 确定性噪声:同一帧同一点永远同一个值,测试才能对答案。 */
function noise(seed: number, i: number): number {
  let x = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(i + 1, 0xc2b2ae35)) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x2c1b3c6d) >>> 0
  x ^= x >>> 12
  return (x >>> 8) / 0x1000000 - 0.5 // -0.5..0.5
}

/** 各通道在时刻 t(秒,相对触发)的显示值。 */
export function demoSignal(ch: number, t: number, frame: number, i: number): number {
  switch (ch) {
    case 1:
      return 0.5 + Math.sin(2 * Math.PI * 1000 * t) + 0.005 * noise(frame, i)
    case 2: {
      const period = 1e-3
      const phase = ((t % period) + period) % period
      const high = phase < 0.3 * period
      const since = high ? phase : phase - 0.3 * period
      // τ 0.3 µs 的 RC 边沿(10–90% 约 0.66 µs),边沿过后 400 kHz 振铃、峰值约 8%(过冲 ≈ 0.15 V)、τ 4 µs 衰减
      const tau = 0.3e-6
      const target = high ? 3.3 : 0
      const from = high ? 0 : 3.3
      const edge = from + (target - from) * (1 - Math.exp(-since / tau))
      const late = since - 0.5e-6
      const ring = late > 0 ? 0.08 * 3.3 * Math.exp(-late / 4e-6) * Math.sin(2 * Math.PI * 400e3 * late) : 0
      return edge + (high ? ring : -ring) + 0.003 * noise(frame, i)
    }
    case 3: {
      const period = 1e-3
      const phase = ((t % period) + period) % period
      const x = phase / period
      return x < 0.5 ? -1 + 4 * x : 3 - 4 * x
    }
    default: {
      const glitchAt = 1.2345e-3
      const inGlitch = t >= glitchAt && t < glitchAt + 200e-9
      return inGlitch ? 0 : 1.8 + 0.02 * noise(frame, i)
    }
  }
}

export interface DemoOptions {
  /** 覆盖信号(测试用);缺省 demoSignal */
  signal?: (ch: number, t: number, frame: number, i: number) => number
  /** 单次触发后多久变成 Stop(ms),缺省 30 */
  triggerDelayMs?: number
}

export class DemoScope implements ScopeDriver {
  readonly driver = "demo"
  readonly address: ScopeAddress = { kind: "none", driver: "demo" }
  readonly identity: ScopeIdentity = { vendor: "YOMA", model: "DEMO", serial: "DEMO-0001", firmware: "0.1" }
  readonly label = "demo"
  readonly warnings: readonly string[] = [
    "DEMO instrument: signals are synthesized in software. Nothing captured here is hardware evidence.",
  ]
  private readonly signal: NonNullable<DemoOptions["signal"]>
  private readonly triggerDelayMs: number
  private frame = 1
  private closed = false
  private measured: MeasureItem[] = []
  private triggerAt?: number
  readonly st: {
    channels: ChannelState[]
    timebase: TimebaseState
    trigger: TriggerState
    mdepth: string
  }

  constructor(options: DemoOptions = {}) {
    this.signal = options.signal ?? demoSignal
    this.triggerDelayMs = options.triggerDelayMs ?? 30
    this.st = {
      channels: [1, 2, 3, 4].map((ch) => ({
        ch,
        on: ch <= 2,
        vdiv: 1,
        offset: 0,
        coupling: "DC",
        probe: 1,
        bwlimit: "FULL",
        unit: "V",
      })),
      timebase: { scale: 200e-6, delay: 0 },
      trigger: { mode: "AUTO", type: "EDGE", source: "C2", level: 1.65, slope: "RISING", status: "Trig'd" },
      mdepth: "10k",
    }
  }

  private guard(signal?: AbortSignal): void {
    if (this.closed) throw new Error("scope: demo instrument is closed")
    signal?.throwIfAborted()
  }

  private settle(): void {
    if (this.triggerAt !== undefined && Date.now() >= this.triggerAt) {
      this.triggerAt = undefined
      this.st.trigger.status = "Stop"
      this.frame++
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async status(signal?: AbortSignal): Promise<ScopeStatus> {
    this.guard(signal)
    this.settle()
    return {
      idn: this.identity,
      channels: this.st.channels.map((c) => ({ ...c })),
      timebase: { ...this.st.timebase },
      trigger: { ...this.st.trigger },
      acquire: this.acquire(),
    }
  }

  private recordPoints(): number {
    return depthPoints(this.st.mdepth) ?? 10_000
  }

  private sampleRate(): number {
    return Math.min(MAX_RATE, this.recordPoints() / (10 * this.st.timebase.scale))
  }

  private acquire(): AcquireState {
    return { sampleRate: this.sampleRate(), points: this.recordPoints(), mdepth: this.st.mdepth, management: "FMDEPTH" }
  }

  async channel(n: number, signal?: AbortSignal): Promise<ChannelState> {
    this.guard(signal)
    const c = this.st.channels[n - 1]
    if (!c) throw new Error(`scope: channel "${n}" — use 1..4`)
    return { ...c }
  }

  async trigger(signal?: AbortSignal): Promise<TriggerState> {
    this.guard(signal)
    this.settle()
    return { ...this.st.trigger }
  }

  async triggerStatus(signal?: AbortSignal): Promise<string> {
    this.guard(signal)
    this.settle()
    return this.st.trigger.status
  }

  capabilities(): ScopeCapabilities {
    return {
      driver: this.driver,
      model: this.identity.model,
      verified: false,
      channels: 4,
      enabledChannels: this.st.channels.filter((c) => c.on).length,
      units: ["V", "A"],
      couplings: ["DC", "AC", "GND"],
      bwlimits: ["FULL", "20M"],
      probes: [...PROBES],
      customProbe: false,
      timebase: { min: 1e-9, max: 10, steps: "1-2-5" },
      triggerTypes: ["edge"],
      triggerSources: ["C1", "C2", "C3", "C4", "LINE"],
      triggerSlopes: ["rising", "falling", "alternate"],
      triggerModes: ["auto", "normal", "single"],
      memoryDepths: [...DEPTHS],
      sampleRates: [1e6, 1e7, 1e8, 1e9, 2e9].filter((r) => r <= MAX_RATE),
      measureTypes: [...MEASURES],
      vendorMeasureTypes: [],
      externalTrigger: false,
      screenshot: true,
      measurements: true,
    }
  }

  async setChannel(spec: ChannelSpec, signal?: AbortSignal): Promise<Applied<ChannelState>> {
    this.guard(signal)
    const c = this.st.channels[spec.ch - 1]
    if (!c) throw new Error(`scope: channel "${spec.ch}" — use 1..4`)
    if (spec.on !== undefined) c.on = spec.on
    if (spec.unit !== undefined) {
      if (spec.unit !== "V" && spec.unit !== "A") throw new Error("scope: unit must be V or A")
      c.unit = spec.unit
    }
    if (spec.probe !== undefined && PROBES.some((p) => Math.abs(p - spec.probe!) < 1e-9)) {
      c.vdiv = (c.vdiv / c.probe) * spec.probe
      c.probe = spec.probe
    }
    if (spec.coupling !== undefined && /^(DC|AC|GND)$/i.test(spec.coupling)) c.coupling = spec.coupling.toUpperCase()
    if (spec.bwlimit !== undefined && /^(FULL|20M)$/i.test(spec.bwlimit)) c.bwlimit = spec.bwlimit.toUpperCase()
    if (spec.vdiv !== undefined) c.vdiv = snap125(spec.vdiv, 500e-6 * c.probe, 10 * c.probe)
    if (spec.offset !== undefined && Number.isFinite(spec.offset)) c.offset = spec.offset
    if (spec.label !== undefined) c.label = spec.label.slice(0, 20) || undefined
    const state = { ...c }
    const mismatches: string[] = []
    if (spec.probe !== undefined && Math.abs(state.probe - spec.probe) > 1e-9)
      mismatches.push(
        `C${spec.ch} probe: asked ${spec.probe}×, scope reports ${state.probe}× (valid values are the probe menu's: ${PROBES.join(" ")})`,
      )
    if (spec.vdiv !== undefined && Math.abs(state.vdiv - spec.vdiv) > 1e-9 * spec.vdiv)
      mismatches.push(
        `C${spec.ch} vdiv: asked ${spec.vdiv}, scope reports ${state.vdiv} ${state.unit}/div (1-2-5 steps)`,
      )
    if (spec.coupling !== undefined && state.coupling !== spec.coupling.toUpperCase())
      mismatches.push(`C${spec.ch} coupling: asked ${spec.coupling}, scope reports ${state.coupling}`)
    if (spec.bwlimit !== undefined && state.bwlimit !== spec.bwlimit.toUpperCase())
      mismatches.push(`C${spec.ch} bwlimit: asked ${spec.bwlimit}, scope reports ${state.bwlimit}`)
    return { state, mismatches }
  }

  async setTimebase(spec: TimebaseSpec, signal?: AbortSignal): Promise<Applied<TimebaseState>> {
    this.guard(signal)
    if (spec.scale !== undefined) this.st.timebase.scale = snap125(spec.scale, 1e-9, 10)
    if (spec.delay !== undefined && Number.isFinite(spec.delay)) this.st.timebase.delay = spec.delay
    const state = { ...this.st.timebase }
    const mismatches: string[] = []
    if (spec.scale !== undefined && Math.abs(state.scale - spec.scale) > 1e-9 * spec.scale)
      mismatches.push(
        `timebase: asked ${spec.scale} s/div, scope reports ${state.scale} s/div (1-2-5 steps, 1 ns..10 s)`,
      )
    return { state, mismatches }
  }

  async setMemoryDepth(mdepth: string, signal?: AbortSignal): Promise<Applied<AcquireState>> {
    this.guard(signal)
    const want = depthPoints(mdepth)
    const match = DEPTHS.find((d) => depthPoints(d) === want)
    if (match) this.st.mdepth = match
    const state = this.acquire()
    const mismatches = match
      ? []
      : [`memory depth: asked ${mdepth}, scope reports ${state.mdepth} — this model accepts ${DEPTHS.join(" ")}`]
    return { state, mismatches }
  }

  async setTrigger(spec: TriggerSpec, signal?: AbortSignal): Promise<Applied<TriggerState>> {
    this.guard(signal)
    if (spec.type !== undefined && !/^edge$/i.test(spec.type))
      throw new Error(`scope: trigger type "${spec.type}" is not supported (edge only)`)
    const t = this.st.trigger
    const mismatches: string[] = []
    if (spec.source !== undefined) {
      const s = spec.source.trim().toUpperCase().replace(/^CH/, "C")
      if (!/^(C[1-4]|LINE)$/.test(s)) throw new Error(`scope: trigger source "${spec.source}" — use C1..C4 or LINE`)
      const n = /^C([1-4])$/.exec(s)
      t.source = n && !this.st.channels[Number(n[1]) - 1]!.on ? "LINE" : s
      if (t.source !== s)
        mismatches.push(
          `trigger source: asked ${s}, scope reports LINE — the scope falls back to LINE when the channel is switched OFF; turn the channel on first`,
        )
    }
    if (spec.level !== undefined && Number.isFinite(spec.level)) t.level = spec.level
    if (spec.slope !== undefined) {
      const slope = /^(rising|rise)$/i.test(spec.slope)
        ? "RISING"
        : /^(falling|fall)$/i.test(spec.slope)
          ? "FALLING"
          : "ALTERNATE"
      t.slope = slope
    }
    if (spec.mode !== undefined) {
      const mode = /^auto/i.test(spec.mode)
        ? "AUTO"
        : /^norm/i.test(spec.mode)
          ? "NORMAL"
          : /^sing/i.test(spec.mode)
            ? "SINGLE"
            : undefined
      if (mode) t.mode = mode
      else mismatches.push(`trigger mode: asked ${spec.mode}, scope reports ${t.mode}`)
      if (mode === "SINGLE") this.arm()
    }
    return { state: { ...t }, mismatches }
  }

  private arm(): void {
    this.st.trigger.status = "Ready"
    this.triggerAt = Date.now() + this.triggerDelayMs
  }

  async autoset(signal?: AbortSignal): Promise<void> {
    this.guard(signal)
    for (const c of this.st.channels) {
      if (!c.on) continue
      const s = this.stats(c.ch)
      c.vdiv = snap125(Math.max(s.pp / 6, 500e-6 * c.probe), 500e-6 * c.probe, 10 * c.probe)
      c.offset = -s.mean
    }
    this.st.timebase.scale = 200e-6
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.guard(signal)
    this.triggerAt = undefined
    this.st.trigger.status = "Trig'd"
  }

  async stop(signal?: AbortSignal): Promise<void> {
    this.guard(signal)
    this.triggerAt = undefined
    this.st.trigger.status = "Stop"
  }

  async single(signal?: AbortSignal): Promise<void> {
    this.guard(signal)
    this.st.trigger.mode = "SINGLE"
    this.arm()
  }

  async waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
    this.guard(signal)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.settle()
      if (/stop/i.test(this.st.trigger.status)) return { ok: true, status: this.st.trigger.status }
      if (Date.now() >= deadline) return { ok: false, status: this.st.trigger.status }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            signal?.removeEventListener("abort", abort)
            resolve()
          },
          Math.min(10, Math.max(0, deadline - Date.now())),
        )
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason ?? new Error("scope: aborted"))
        }
        signal?.addEventListener("abort", abort, { once: true })
      })
    }
  }

  private scaleOf(c: ChannelState): VoltScale {
    return { gain: c.vdiv / c.probe, offset: c.offset / c.probe, codePerDiv: CODE_PER_DIV, probe: c.probe }
  }

  /** 生成一路的码:显示值 → BNC 值 → 码,超出 int16 就削波(和真 ADC 一样)。 */
  private codes(c: ChannelState, count: number, stride: number): Int16Array {
    const interval = 1 / this.sampleRate()
    const t0 = this.st.timebase.delay - 5 * this.st.timebase.scale
    const s = this.scaleOf(c)
    const out = new Int16Array(count)
    for (let i = 0; i < count; i++) {
      const src = i * stride
      const v = this.signal(c.ch, t0 + src * interval, this.frame, src)
      const code = Math.round((v / c.probe + s.offset) / (s.gain / s.codePerDiv))
      out[i] = Math.max(-32768, Math.min(32767, code))
    }
    return out
  }

  async readWaveform(ch: number, options: ReadWaveformOptions = {}): Promise<Waveform> {
    this.guard(options.signal)
    const c = this.st.channels[ch - 1]
    if (!c) throw new Error(`scope: channel "${ch}" — use 1..4`)
    if (!c.on) throw new Error(`scope: C${ch} returned no samples — is the channel on?`)
    if (options.maxPoints !== undefined && !(Number.isSafeInteger(options.maxPoints) && options.maxPoints > 0))
      throw new Error("scope: maxPoints must be a positive integer")
    if (options.stride !== undefined && !(Number.isSafeInteger(options.stride) && options.stride > 0))
      throw new Error("scope: stride must be a positive integer")
    const recordPoints = this.recordPoints()
    let stride = options.stride ?? 1
    if (options.stride === undefined) {
      if (options.maxPoints && recordPoints > options.maxPoints) stride = Math.ceil(recordPoints / options.maxPoints)
    } else if (options.maxPoints && Math.floor(recordPoints / stride) > options.maxPoints) {
      throw new Error(
        `scope: stride ${stride} over a ${recordPoints.toLocaleString()}-point record is ${Math.floor(recordPoints / stride).toLocaleString()} points, more than the ${options.maxPoints.toLocaleString()} limit — raise stride, shorten the timebase, or lower the memory depth (scope setup mdepth)`,
      )
    }
    const count = Math.floor(recordPoints / stride)
    const interval = stride / this.sampleRate()
    return {
      ch,
      codes: this.codes(c, count, stride),
      scale: this.scaleOf(c),
      time: { delay: this.st.timebase.delay, tdiv: this.st.timebase.scale, interval, grid: 10 },
      stride,
      sampleRate: this.sampleRate(),
      recordPoints,
      unit: c.unit,
      probe: c.probe,
    }
  }

  private stats(ch: number) {
    const c = this.st.channels[ch - 1]!
    const codes = this.codes(
      c,
      Math.min(this.recordPoints(), 100_000),
      Math.max(1, Math.floor(this.recordPoints() / 100_000)),
    )
    return waveStats(codes, this.scaleOf(c), Math.max(1, Math.floor(this.recordPoints() / 100_000)) / this.sampleRate())
  }

  private measureOne(item: MeasureItem): MeasureResult & { known: boolean } {
    const neutral = measurementName(item.type)
    const source = item.source.trim().toUpperCase().replace(/^CH/, "C")
    const n = /^C([1-4])$/.exec(source)
    if (!n) throw new Error("scope: measurement source must be C1..C4; LINE is a trigger source")
    if (!neutral || !MEASURES.includes(neutral))
      return { type: item.type.trim().toUpperCase(), source, value: null, known: false }
    const type = neutral
    const c = this.st.channels[Number(n[1]) - 1]!
    if (!c.on) return { type, source, value: null, known: true }
    const s = this.stats(c.ch)
    const pick = (): number | undefined => {
      switch (type) {
        case "pkpk":
          return s.pp
        case "max":
          return s.max
        case "min":
          return s.min
        case "mean":
          return s.mean
        case "rms":
          return s.rms
        case "acrms":
          return s.acRms
        case "top":
          return s.top
        case "base":
          return s.base
        case "amplitude":
          return s.top !== undefined && s.base !== undefined ? s.top - s.base : undefined
        case "overshoot":
          return s.overshoot !== undefined && s.top !== undefined && s.base !== undefined
            ? (100 * s.overshoot) / (s.top - s.base)
            : undefined
        case "undershoot":
          return s.undershoot !== undefined && s.top !== undefined && s.base !== undefined
            ? (100 * s.undershoot) / (s.top - s.base)
            : undefined
        case "frequency":
          return s.freq
        case "period":
          return s.period
        case "duty":
          return s.duty !== undefined ? s.duty * 100 : undefined
        case "rise":
          return s.rise
        case "fall":
          return s.fall
        default:
          return undefined
      }
    }
    const value = pick()
    return { type, source, value: value === undefined || !Number.isFinite(value) ? null : value, known: true }
  }

  async measure(
    items: MeasureItem[],
    signal?: AbortSignal,
  ): Promise<{ results: MeasureResult[]; mismatches: string[] }> {
    this.guard(signal)
    if (items.length === 0) throw new Error('scope measure: give items, e.g. [{type:"FREQ",source:"C1"}]')
    if (items.length > 12) throw new Error("scope measure: at most 12 items at once")
    const mismatches: string[] = []
    const results = items.map((item, i) => {
      const r = this.measureOne(item)
      if (!r.known)
        mismatches.push(
          `P${i + 1}: asked type ${r.type}, this instrument does not know it (see capabilities.measureTypes)`,
        )
      return { type: r.type, source: r.source, value: r.value }
    })
    this.measured = items
    return { results, mismatches }
  }

  async readMeasurements(count: number, signal?: AbortSignal): Promise<(number | null)[]> {
    this.guard(signal)
    return this.measured.slice(0, count).map((item) => this.measureOne(item).value)
  }

  async screenshot(signal?: AbortSignal): Promise<Uint8Array> {
    this.guard(signal)
    const width = 480
    const height = 270
    const rgb = new Uint8Array(width * height * 3)
    rgb.fill(16)
    const px = (x: number, y: number, color: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return
      const o = (y * width + x) * 3
      rgb[o] = color[0]
      rgb[o + 1] = color[1]
      rgb[o + 2] = color[2]
    }
    for (let g = 0; g <= 10; g++)
      for (let y = 0; y < height; y++) px(Math.round((g * (width - 1)) / 10), y, [48, 48, 48])
    for (let g = 0; g <= 8; g++) for (let x = 0; x < width; x++) px(x, Math.round((g * (height - 1)) / 8), [48, 48, 48])
    for (const c of this.st.channels) {
      if (!c.on) continue
      const hex = CHANNEL_COLORS[c.ch - 1]!
      const color: [number, number, number] = [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ]
      const codes = this.codes(c, width, Math.max(1, Math.floor(this.recordPoints() / width)))
      let prev: number | undefined
      for (let x = 0; x < width; x++) {
        const v = codeToVolts(codes[x]!, this.scaleOf(c))
        const y = Math.round((height - 1) / 2 - ((v + c.offset) / c.vdiv) * ((height - 1) / 8))
        if (prev !== undefined) {
          const [a, b] = prev < y ? [prev, y] : [y, prev]
          for (let yy = a; yy <= b; yy++) px(x, yy, color)
        } else px(x, y, color)
        prev = y
      }
    }
    return encodePng(width, height, rgb)
  }
}

// ── PNG(只依赖 node:zlib) ────────────────────────────────────────────────

let crcTable: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false)
  return out
}

/** 8 位 RGB 无滤波的最小 PNG 编码器。 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) throw new Error("encodePng: rgb size mismatch")
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width, false)
  dv.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 2
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export const DEMO_DRIVER: ScopeDriverSpec = {
  name: "demo",
  description: "Synthetic instrument for development without hardware; enabled by YOMA_SCOPE_DEMO=1",
  usbVendorIds: [],
  standalone: true,
  supports: (idn) => idn.vendor === "YOMA" && idn.model === "DEMO",
  open: async () => new DemoScope(),
  models: () => [
    {
      model: "DEMO",
      transports: ["none"],
      example: "demo",
      verified: "fake",
      note: "software-generated signals, not evidence",
    },
  ],
}
