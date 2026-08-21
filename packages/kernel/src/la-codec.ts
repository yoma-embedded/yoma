/**
 * 逻辑分析仪的线格式编解码与格式化 —— 纯数据、无 DOM,卡片(session-ui)、面板(app)、host 三方共用;
 * 画法与主题读取在 session-ui 的 la-preview.ts(那边才有 DOM)。
 *
 * 列位图:每列 2 bit,bit0 = 该列内出现过高电平、bit1 = 出现过低电平;4 列一字节(列 c 在
 * 字节 c>>2 的第 (c&3)*2 位)。写入端在 coding-agent 的 columnBits;这里是唯一的读法 ——
 * 解错不会报错,只会画出一张看起来很合理的假波形,所以读法不许有第二份。
 */

export const LA_COLUMN_HIGH = 1
export const LA_COLUMN_LOW = 2
export const LA_COLUMN_EDGE = 3

/** base64 → 每列一个 0..3 的掩码(长度 = columns)。 */
export function decodeColumns(base64: string, columns: number): Uint8Array {
  const out = new Uint8Array(columns)
  if (!base64 || columns <= 0) return out
  const bin = atob(base64)
  for (let col = 0; col < columns; col++) {
    const byte = bin.charCodeAt(col >> 2)
    if (Number.isNaN(byte)) break
    out[col] = (byte >> ((col & 3) * 2)) & 3
  }
  return out
}

/** 把 columns 列折到 width 像素:落在同一像素的列掩码按位或(高低都出现过 → 有跳变)。 */
export function foldColumns(masks: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, width))
  if (width <= 0 || masks.length === 0) return out
  for (let col = 0; col < masks.length; col++) {
    const px = Math.min(width - 1, Math.floor((col * width) / masks.length))
    out[px] = out[px]! | masks[col]!
  }
  return out
}

export function formatFreq(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "—"
  if (hz >= 1e9) return `${trim(hz / 1e9)} GHz`
  if (hz >= 1e6) return `${trim(hz / 1e6)} MHz`
  if (hz >= 1e3) return `${trim(hz / 1e3)} kHz`
  return `${trim(hz)} Hz`
}

/** 秒 → 按量级选单位。 */
export function formatTime(seconds: number): string {
  const sign = seconds < 0 ? "-" : ""
  const v = Math.abs(seconds)
  if (v === 0) return "0"
  if (v < 1e-6) return `${sign}${(v * 1e9).toFixed(1)} ns`
  if (v < 1e-3) return `${sign}${(v * 1e6).toFixed(v < 1e-5 ? 3 : 2)} µs`
  if (v < 1) return `${sign}${(v * 1e3).toFixed(v < 1e-2 ? 4 : 3)} ms`
  return `${sign}${v.toFixed(v < 10 ? 4 : 2)} s`
}

export function formatSamples(n: number): string {
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}k`
  return String(n)
}

/** 去掉无意义的尾零:25 → "25",25.5 → "25.5",1.234567 → "1.235"。 */
function trim(v: number): string {
  return Number.parseFloat(v.toFixed(3)).toString()
}
