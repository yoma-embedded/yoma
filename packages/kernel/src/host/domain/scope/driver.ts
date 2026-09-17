/**
 * 示波器驱动接口 —— 工具层(host/tools/scope)只认这一份形状,厂商驱动各自实现它。
 *
 * 分层(与 ngscopeclient 的 libscopehal 同一思路,但按 yoma 的工具动作反推,不照抄它的 150 个虚函数):
 *   tools/scope/{contract,session,evidence}  →  ScopeDriver(本文件)  →  厂商驱动(siglent.ts / demo.ts …)  →  ScpiTransport(scpi.ts)
 *
 * 三条不许破的约定:
 *  - 接口里只出现中性类型:通道号、伏/安、秒、int16 码;厂商私有的描述块(WAVEDESC)不许露出来。
 *  - **设了就读回**:每个 setter 返回仪器读回的真实状态 + 与请求不符的人话(`Applied<T>`);模型看不见屏幕,
 *    不说它就不知道仪器把值改了。
 *  - 合法取值向驱动问(`capabilities()`),不写死在工具或界面里;空数组表示"这台不支持 / 不知道",不是错误。
 *
 * 地址:`[driver@]transport`,transport 是 `usb[:serial]`、`host[:port]`,独立驱动(demo)用裸名字。
 * 不带 driver 的地址按 *IDN? 自动识别(registry.ts)。租约按传输部分(`scopeAddressKey`)算,
 * `siglent@usb:SN` 与 `usb:SN` 是同一台仪器。
 */
import { type ScpiAddress, type ScpiClient, formatScpiAddress, parseScpiAddress } from "./scpi.ts"
import type { TimeScale, VoltScale } from "./preamble.ts"

// ── 身份与状态 ────────────────────────────────────────────────────────────

export interface ScopeIdentity {
  vendor: string
  model: string
  serial: string
  firmware: string
}

export interface ChannelState {
  ch: number
  on: boolean
  label?: string
  /** 当前通道单位/div,含探头 */
  vdiv: number
  offset: number
  coupling: string
  probe: number
  bwlimit: string
  unit: string
}

export interface TimebaseState {
  scale: number
  delay: number
}

export interface TriggerState {
  mode: string
  type: string
  source: string
  level: number
  slope: string
  status: string
}

export interface AcquireState {
  sampleRate: number
  points: number
  mdepth: string
  management?: string
}

export interface ScopeStatus {
  idn: ScopeIdentity
  channels: ChannelState[]
  timebase: TimebaseState
  trigger: TriggerState
  acquire: AcquireState
}

// ── 设置请求 ──────────────────────────────────────────────────────────────

export interface ChannelSpec {
  ch: number
  on?: boolean
  unit?: "V" | "A"
  vdiv?: number
  offset?: number
  coupling?: string
  probe?: number
  bwlimit?: string
  label?: string
}

export interface TimebaseSpec {
  scale?: number
  delay?: number
}

/** 触发:今天只有边沿;`type` 与 `params` 是给以后脉宽/欠幅等类型留的口,默认 edge。 */
export interface TriggerSpec {
  type?: string
  mode?: string
  source?: string
  level?: number
  slope?: string
  params?: Record<string, string | number | boolean>
}

/** 一次 setter 的结果:仪器读回的状态 + 与请求不符的地方(人话)。 */
export interface Applied<T> {
  state: T
  mismatches: string[]
}

// ── 波形 ──────────────────────────────────────────────────────────────────

/** 厂商无关的波形:int16 码 + 换算参数 + 时间轴。厂商想带私货就 extends 它(SiglentWaveform 带 desc)。 */
export interface Waveform {
  ch: number
  codes: Int16Array
  scale: VoltScale
  time: TimeScale
  stride: number
  /** 采集采样率 */
  sampleRate: number
  /** 记录总长(采集点) */
  recordPoints: number
  unit: string
  probe: number
  /** 仪器自己记的采集时间(本地时间,未换算时区);仪器不给就没有 */
  acquiredAt?: string
}

export interface MeasureItem {
  type: string
  source: string
}

export interface MeasureResult extends MeasureItem {
  value: number | null
  /** 仪器自己的量测名(词表名映到的指令,或透传的原名);type 是词表名时才和它不同 */
  vendorType?: string
}

// ── 能力枚举 ──────────────────────────────────────────────────────────────

/**
 * 这台仪器现在能设什么。与 tools/scope/contract.ts 里给模型看的 `ScopeCapabilities` 同形(那边是菜单,
 * 不能反过来 import 工具间外的文件),改一边记得改另一边 —— session.ts 的赋值会在 typecheck 时把不一致抓出来。
 * 列表随当前状态变(存储深度随已开通道数缩),空数组 = 不支持或不知道。
 */
export interface ScopeCapabilities {
  driver: string
  model: string
  /** 这个型号是否在真机上跑过 yoma 的验收 */
  verified: boolean
  channels: number
  enabledChannels: number
  units: string[]
  couplings: string[]
  bwlimits: string[]
  probes: number[]
  /** 探头系数是否也接受 probes 之外的任意值(自定义电流探头、分流器) */
  customProbe: boolean
  timebase: { min: number; max: number; steps: string }
  triggerTypes: string[]
  triggerSources: string[]
  triggerSlopes: string[]
  triggerModes: string[]
  /** 当前已开通道数下合法的存储深度 */
  memoryDepths: string[]
  /** 当前已开通道数下合法的采样率(Sa/s) */
  sampleRates: number[]
  /** 这个驱动实现了的词表量测名(MEASUREMENT_NAMES 的子集) */
  measureTypes: string[]
  /** 仪器特有、原样透传的量测名(词表之外);没有就空 */
  vendorMeasureTypes: string[]
  externalTrigger: boolean
  screenshot: boolean
  measurements: boolean
}

// ── 驱动接口 ──────────────────────────────────────────────────────────────

export interface ReadWaveformOptions {
  maxPoints?: number
  stride?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ScopeDriver {
  /** 注册表里的名字(siglent / demo …) */
  readonly driver: string
  readonly address: ScopeAddress
  readonly identity: ScopeIdentity
  /** 人话地址(传输部分):usb:<serial> / host:port / demo */
  readonly label: string
  /** 连接时就该告诉模型的话:未验证的型号、假仪器等。每次结果都该带上,不只 connect */
  readonly warnings: readonly string[]
  close(): Promise<void>
  status(signal?: AbortSignal): Promise<ScopeStatus>
  channel(n: number, signal?: AbortSignal): Promise<ChannelState>
  trigger(signal?: AbortSignal): Promise<TriggerState>
  triggerStatus(signal?: AbortSignal): Promise<string>
  /** 按当前状态给合法取值;不传状态就按上次读到的 / 保守值给 */
  capabilities(status?: ScopeStatus): ScopeCapabilities
  setChannel(spec: ChannelSpec, signal?: AbortSignal): Promise<Applied<ChannelState>>
  setTimebase(spec: TimebaseSpec, signal?: AbortSignal): Promise<Applied<TimebaseState>>
  setMemoryDepth(mdepth: string, signal?: AbortSignal): Promise<Applied<AcquireState>>
  setTrigger(spec: TriggerSpec, signal?: AbortSignal): Promise<Applied<TriggerState>>
  autoset(signal?: AbortSignal): Promise<void>
  run(signal?: AbortSignal): Promise<void>
  stop(signal?: AbortSignal): Promise<void>
  /** 武装单次触发;返回后 triggerStatus 应当离开 Stop */
  single(signal?: AbortSignal): Promise<void>
  waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }>
  /** 读一个通道的冻结记录。stride 显式给了就照办,超预算要拒绝而不是悄悄改 */
  readWaveform(ch: number, options?: ReadWaveformOptions): Promise<Waveform>
  measure(items: MeasureItem[], signal?: AbortSignal): Promise<{ results: MeasureResult[]; mismatches: string[] }>
  readMeasurements(count: number, signal?: AbortSignal): Promise<(number | null)[]>
  /** 整幅 PNG;不支持就 reject */
  screenshot(signal?: AbortSignal): Promise<Uint8Array>
}

/** 触发状态词表(Siglent E11 的写法,其它驱动映射到同一套):比较前去掉大小写和标点。 */
export const TRIGGER_STATUSES = ["ARM", "READY", "AUTO", "TRIGD", "STOP", "ROLL", "FSTOP"] as const

export function normalizeTriggerStatus(status: string): string {
  return status.toUpperCase().replace(/[^A-Z]/g, "")
}

export function isKnownTriggerStatus(status: string): boolean {
  return (TRIGGER_STATUSES as readonly string[]).includes(normalizeTriggerStatus(status))
}

// ── 驱动注册项 ────────────────────────────────────────────────────────────

export interface ScopeOpenOptions {
  connectTimeoutMs?: number
  signal?: AbortSignal
}

export interface ScopeModelInfo {
  model: string
  transports: ("usb" | "tcp" | "none")[]
  example: string
  /** hardware = yoma 在真机上验过;fake = 只对着假仪器;untested = 按手册/别家驱动写的 */
  verified: "hardware" | "fake" | "untested"
  note?: string
}

export interface ScopeDriverSpec {
  readonly name: string
  readonly description: string
  /** USB 发现时要看的厂商 id */
  readonly usbVendorIds: readonly number[]
  /** 不需要传输的驱动(demo):地址就是驱动名 */
  readonly standalone?: boolean
  /** *IDN? 认不认这台 */
  supports(idn: ScopeIdentity): boolean
  /** 按显式地址打开(带 driver@ 前缀或独立驱动) */
  open(address: ScopeAddress, options?: ScopeOpenOptions): Promise<ScopeDriver>
  /** 接管一条已经问过 *IDN? 的连接(自动识别那条路);独立驱动可以不实现 */
  attach?(client: ScpiClient, address: ScopeAddress, idn: ScopeIdentity): Promise<ScopeDriver>
  models(): ScopeModelInfo[]
}

// ── 地址 ──────────────────────────────────────────────────────────────────

export type ScopeAddress = (ScpiAddress | { kind: "none" }) & { driver?: string }

/**
 * `[driver@]transport`。transport:`usb[:serial]` / `host[:port]` / `none`;裸名字在 standalone 名单里就是独立驱动。
 * 旧格式(不带前缀)原样能读:config.json 里的地址不会因为这次改动失效。
 */
export function parseScopeAddress(value: string, standalone: readonly string[] = []): ScopeAddress {
  const text = value.trim()
  if (!text) throw new Error("scope: empty address")
  const prefixed = /^([A-Za-z][A-Za-z0-9_-]*)@(.*)$/.exec(text)
  const driver = prefixed ? prefixed[1]!.toLowerCase() : undefined
  const rest = (prefixed ? prefixed[2]! : text).trim()
  if (!prefixed && standalone.includes(rest.toLowerCase())) return { kind: "none", driver: rest.toLowerCase() }
  if (rest === "" || /^none$/i.test(rest)) {
    if (!driver) throw new Error('scope: address "none" needs a driver name, e.g. demo')
    return { kind: "none", driver }
  }
  const transport = parseScpiAddress(rest)
  return driver ? { ...transport, driver } : transport
}

/** 传输部分的人话(租约键、日志、config 兼容):不带驱动前缀。 */
export function scopeAddressKey(a: ScopeAddress): string {
  return a.kind === "none" ? `none:${a.driver ?? ""}` : formatScpiAddress(a)
}

/** 完整形式:有驱动就带 `driver@`;独立驱动只写名字。 */
export function formatScopeAddress(a: ScopeAddress): string {
  if (a.kind === "none") return a.driver ?? "none"
  const body = formatScpiAddress(a)
  return a.driver ? `${a.driver}@${body}` : body
}

// ── 量测词表(厂商无关)──────────────────────────────────────────────────

/**
 * 量测名只有这一套是接口的一部分:模型、契约、证据、conformance 都说这些名字。厂商驱动把它映到自家指令
 * (Siglent 的 FREQ / PER / TOP…),`capabilities.measureTypes` 报的是这一套里它实现了的;仪器特有的量测走
 * `vendorMeasureTypes` 原样透传。常见别名(FREQ、PERIOD、HIGH、LOW、VPP…)在 measurementName() 里认,模型怎么写
 * 都落到同一个名字 —— 2026-09-17 真机验证里 agent 猜了 HIGH / LOW / PERIOD 三个名字,仪器一个都不认。
 */
export const MEASUREMENT_NAMES = [
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
  "pwidth",
  "nwidth",
  "overshoot",
  "undershoot",
] as const
export type MeasurementName = (typeof MEASUREMENT_NAMES)[number]

/** 量纲,决定结果单位;channel = 源通道自己的单位(V 或 A)。 */
export const MEASUREMENT_UNITS: Record<MeasurementName, "Hz" | "s" | "%" | "channel"> = {
  frequency: "Hz",
  period: "s",
  pkpk: "channel",
  amplitude: "channel",
  max: "channel",
  min: "channel",
  top: "channel",
  base: "channel",
  mean: "channel",
  rms: "channel",
  acrms: "channel",
  duty: "%",
  rise: "s",
  fall: "s",
  pwidth: "s",
  nwidth: "s",
  overshoot: "%",
  undershoot: "%",
}

const MEASUREMENT_ALIASES: Record<string, MeasurementName> = {
  FREQ: "frequency",
  PER: "period",
  VPP: "pkpk",
  PP: "pkpk",
  PEAKTOPEAK: "pkpk",
  AMPL: "amplitude",
  MAXIMUM: "max",
  VMAX: "max",
  MINIMUM: "min",
  VMIN: "min",
  HIGH: "top",
  VTOP: "top",
  LOW: "base",
  VBASE: "base",
  AVERAGE: "mean",
  AVG: "mean",
  VRMS: "rms",
  CRMS: "acrms",
  DUTYCYCLE: "duty",
  RISETIME: "rise",
  RTIME: "rise",
  FALLTIME: "fall",
  FTIME: "fall",
  PWID: "pwidth",
  POSITIVEWIDTH: "pwidth",
  NWID: "nwidth",
  NEGATIVEWIDTH: "nwidth",
  OVSP: "overshoot",
  OVSN: "undershoot",
}

/** 把模型写的量测名落到词表:大小写、下划线、空格不算;认不出返回 undefined(可能是仪器特有名,由驱动透传)。 */
export function measurementName(text: string): MeasurementName | undefined {
  const key = text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
  const lower = key.toLowerCase()
  if ((MEASUREMENT_NAMES as readonly string[]).includes(lower)) return lower as MeasurementName
  return MEASUREMENT_ALIASES[key]
}
