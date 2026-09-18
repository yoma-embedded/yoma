/**
 * 仪器通道色的唯一真源。
 *
 * 为什么要一份 JS 常量而不是只有 CSS 变量:波形是 Canvas2D 画的,`ctx.strokeStyle` 读不到
 * `--bench-ch1`(canvas 里没有 CSS 级联)。所以两边各存一份 —— CSS 里给界面元素用,
 * 这里给画笔用 —— 而"两份没分叉"由 `instruments.test.ts` 逐字节钉住。
 *
 * 取色沿用示波器的老规矩(1 黄 2 蓝 3 品红 4 绿)。**不改现有波形的颜色**:
 * `debug/scope-waveform-data.ts` 的 `SCOPE_COLORS` 现在就是从这里取的,统一之后一个像素都没变。
 */
export const BENCH_CHANNEL_COLORS = ["#b99a00", "#347fe2", "#cf4b86", "#389562"] as const

/** CSS 变量名,与 bench.css 的 `--bench-ch1..ch4` 对应。 */
export const BENCH_CHANNEL_VARS = ["--bench-ch1", "--bench-ch2", "--bench-ch3", "--bench-ch4"] as const

/** 第 n 条通道(从 1 起)的颜色,超出四条就循环。 */
export function benchChannelColor(channel: number): string {
  const index = (Math.max(1, Math.trunc(channel)) - 1) % BENCH_CHANNEL_COLORS.length
  return BENCH_CHANNEL_COLORS[index]
}
