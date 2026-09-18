/**
 * 硬件读数的格式化 —— 纯函数,时间线里的卡片与右栏的仪器面板共用。
 *
 * `scopeValue` 原来住在 app 的 `pages/session/debug/scope-waveform-data.ts`;卡片在 session-ui,
 * 够不到 app,所以实现搬到这里、那边转出去。**同一个电压在面板上和卡片上必须是同一串字**。
 */

/** 工程记数:`0.0005 V` → `500 µV`,`5945.66e-10 s` → `594.6 ns`。 */
export function scopeValue(value: number, unit = "V"): string {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return `0 ${unit}`
  const magnitude = Math.abs(value)
  const scales = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
  ] as const
  const [scale, prefix] = scales.find(([s]) => magnitude >= s) ?? scales[scales.length - 1]
  return `${Number((value / scale).toPrecision(4))} ${prefix}${unit}`
}

/** 毫秒 → 卡片上那一句耗时。`820` → `0.82 s`,`93_000` → `1 分 33 秒`。 */
export function formatElapsed(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`
}

/** 千分位。跨 locale 会变(`Intl` 跟着系统走),读数里要的是稳定的那一种。 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 只要文件名。正反斜杠都认(Windows 的 details 里是 `\`)。 */
export function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/**
 * 长路径 → 末尾几段。卡片上一条绝对路径能吃掉整行,而人要看的永远是尾巴
 * (`…/f405-motor-ctrl/.yoma/logs/hw-20260918-011554425.log`)。
 */
export function shortPath(filePath: string, segments = 3): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return filePath
  return `…/${parts.slice(-segments).join("/")}`
}

/** 首字母大写的短英文动作名不翻译:`start` / `wait` 是工具自己的词表,不是界面文案。 */
export function actionWord(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]+$/.test(value) ? value : undefined
}

/**
 * 这条读数要不要占满整行(`HwReadout` 的 `data-wide`)。
 *
 * 读数板在 `@container (min-width: 520px)` 之后是两列,一格约 250px,而值只拿得到 70% 的宽 ——
 * 二十几个等宽字符就开始折行。多数读数是格式化过的短串(`1,024 B`、`halted`、`20 ns/点`),
 * 摆两列正合适;但有几处的值**长度不受我们控制**:gdb 报告里 `p/x` 的结构体、`session log:`
 * 后面那条绝对路径、断点的 `at + where`。它们在半格里折四五行,而旁边那条短读数的点线
 * 孤零零吊在中间 —— 实拍见 `35-light-card-gdb-hover`(`目标 ⋯ no-session` 旁边是一条
 * 折了五行的 `/Users/…/.yoma/gdb/session-….log`)。
 *
 * 所以长值自动整行,而不是等每个调用点想起来写 `wide`:下一个把工具原文喂进读数的卡片
 * 不会再踩一遍。一列布局下 `grid-column: 1 / -1` 与不写等价,窄窗口一个像素都不变。
 */
export const READOUT_WIDE_CHARS = 24

export function readoutIsWide(value: unknown, wide?: boolean): boolean {
  if (wide) return true
  return typeof value === "string" && value.length > READOUT_WIDE_CHARS
}
