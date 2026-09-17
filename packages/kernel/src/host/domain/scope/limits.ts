/**
 * Siglent 各家族的型号表:带宽、通道数、命令间隔、按已开通道数分档的存储深度与采样率。
 *
 * 表的来源是 ngscopeclient 的 SiglentSCPIOscilloscope.cpp(BSD-3,见 NOTICE)加 Siglent 数据手册;
 * **只有 SDS824X HD 在真机上跑过 yoma 的验收**(2026-09-16),其余型号按 `verified:false` 报给模型。
 * 表只用来给提示和能力枚举,不是权威:设置以读回为准,仪器说不行就是不行。
 *
 * SDS800X HD 的型号编码:SDS8<带宽><通道>X HD —— 第 5 个字符 0/1/2 → 70/100/200 MHz,第 6 个字符是通道数。
 */

export type SiglentFamilyName =
  | "SDS800X_HD"
  | "SDS1000X_HD"
  | "SDS2000X_PLUS"
  | "SDS2000X_HD"
  | "SDS3000X_HD"
  | "SDS5000X"
  | "SDS6000"
  | "SDS7000A"
  | "unknown"

export interface SiglentFamily {
  family: SiglentFamilyName
  /** 标称带宽;认不出型号时没有 */
  bandwidthMHz?: number
  channels: number
  /** 这个具体型号是否在真机上验过 */
  verified: boolean
  /** 相邻命令的最小间隔;E11 协议机型 5 ms,SDS2000X+ 与更老的要 50 ms(ngscopeclient 实测) */
  interCommandMs: number
  /** 按已开通道数给合法存储深度(手册写法:10k / 100k / 1M …);空 = 不知道 */
  memoryDepths(enabledChannels: number): string[]
  /** 按已开通道数给合法采样率(Sa/s);空 = 不知道 */
  sampleRates(enabledChannels: number): number[]
  /** 探头系数是否接受菜单之外的任意值(自定义电流探头、分流器要用) */
  customProbe: boolean
}

/** yoma 在真机上验收过的型号。 */
export const VERIFIED_MODELS = ["SDS824X HD"] as const

const DEPTHS_BASE = ["10k", "100k", "1M", "10M"]
const RATE_LADDER = [
  2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8,
  5e8, 1e9, 2e9,
]

function ratesUpTo(max: number): number[] {
  return RATE_LADDER.filter((r) => r <= max)
}

/** 单 / 双 / 多通道三档:1 → single,2 → dual,≥3 → multi(与 ngscopeclient 的 ChannelMode 同)。 */
function tier(enabled: number): 0 | 1 | 2 {
  return enabled <= 1 ? 0 : enabled === 2 ? 1 : 2
}

function sds800xhd(model: string): SiglentFamily {
  const bwCode = model[4]
  const bandwidthMHz = bwCode === "2" ? 200 : bwCode === "1" ? 100 : bwCode === "0" ? 70 : undefined
  const channels = model[5] === "2" ? 2 : 4
  const wide = bandwidthMHz !== undefined && bandwidthMHz >= 200
  // ngscopeclient SiglentSCPIOscilloscope.cpp:2929-2949:≥200 MHz 单 100M / 双 50M / 多 25M,以下各降一档
  const top = wide ? ["100M", "50M", "25M"] : ["50M", "25M", undefined]
  return {
    family: "SDS800X_HD",
    bandwidthMHz,
    channels,
    verified: (VERIFIED_MODELS as readonly string[]).includes(model),
    interCommandMs: 5,
    // SDS824X HD 实测(2026-09-17):`:CHANnel1:PROBe VALue,7` 照收,读回 7×,vdiv 跟着乘 7
    customProbe: true,
    memoryDepths: (enabled) => {
      const extra = top[tier(enabled)]
      return extra ? [...DEPTHS_BASE, extra] : [...DEPTHS_BASE]
    },
    sampleRates: (enabled) => ratesUpTo([2e9, 1e9, 5e8][tier(enabled)]!),
  }
}

function sds1000xhd(model: string): SiglentFamily {
  const channels = model[5] === "2" ? 2 : 4
  return {
    family: "SDS1000X_HD",
    channels,
    verified: false,
    interCommandMs: 5,
    customProbe: false,
    // ngscopeclient 把 SDS1000X HD 与 ≥200 MHz 的 SDS800X HD 放在同一张表
    memoryDepths: (enabled) => [...DEPTHS_BASE, ["100M", "50M", "25M"][tier(enabled)]!],
    sampleRates: (enabled) => ratesUpTo([2e9, 1e9, 5e8][tier(enabled)]!),
  }
}

function generic(family: SiglentFamilyName, model: string, interCommandMs: number): SiglentFamily {
  const m = /^SDS\d(\d)(\d)/.exec(model)
  const channels = m && m[2] === "2" ? 2 : 4
  return {
    family,
    channels,
    verified: false,
    interCommandMs,
    customProbe: false,
    memoryDepths: () => [],
    sampleRates: () => [],
  }
}

/** 从 *IDN? 的型号串认家族。认不出也给一份保守配置(50 ms 间隔、4 通道、没有表)。 */
export function siglentFamily(modelText: string): SiglentFamily {
  const model = modelText.trim().replace(/\s+/g, " ").toUpperCase()
  if (/^SDS8\d{2}X HD$/.test(model)) return sds800xhd(model)
  if (/^SDS1\d{3}X HD$/.test(model)) return sds1000xhd(model)
  if (/^SDS2\d{3}X\s*(PLUS|\+)$/.test(model)) return generic("SDS2000X_PLUS", model, 50)
  if (/^SDS2\d{3}X HD$/.test(model)) return generic("SDS2000X_HD", model, 5)
  if (/^SDS3\d{3}X HD$/.test(model)) return generic("SDS3000X_HD", model, 5)
  if (/^SDS5\d{3}X$/.test(model)) return generic("SDS5000X", model, 5)
  if (/^SDS6\d{3}/.test(model)) return generic("SDS6000", model, 5)
  if (/^SDS7\d{3}A$/.test(model)) return generic("SDS7000A", model, 5)
  return generic("unknown", model, 50)
}

/** 存储深度写法归一("10K" / "10k" / "10000" → "10k"),比较用。 */
export function canonicalDepth(text: string): string {
  const t = text.trim().toUpperCase()
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/.exec(t)
  if (!m) return t
  const n = Number(m[1]) * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : 1)
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`
  return String(n)
}
