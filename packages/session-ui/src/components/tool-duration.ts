import { createSignal, onCleanup } from "solid-js"

/**
 * 工具卡片右边的耗时:`0.4s` / `12s` / `1m 5s`。它是读数(同用量那一类),不翻译。
 * 不到 0.1 秒不画(read / ls 这种一眨眼的,一排「0.0s」只是噪声;pi-agent-desktop 同样不画不足一秒的)。
 * 给不出(负数、NaN —— 旧版本重放出来的开始时间是重放那一刻)也是空串:不画一个错的数。
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 100) return ""
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** 一次工具调用的耗时:结束了用 end - start;还在跑就拿 `now` 现算;没有开始时间给 undefined。 */
export function toolElapsed(time: { start?: number; end?: number } | undefined, now: number): number | undefined {
  const start = time?.start
  if (typeof start !== "number" || start <= 0) return
  const end = typeof time?.end === "number" && time.end > 0 ? time.end : now
  return end - start
}

const [now, setNow] = createSignal(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let users = 0

/**
 * 全局一个秒表,正在跑的工具卡片订它、每秒走一格。有人订才转,最后一个退订就停 —— 平时(没有工具在跑)
 * 一个定时器都没有。必须在组件(或别的有 owner 的作用域)里调:退订挂在 onCleanup 上。
 */
export function useSecondTicker(): () => number {
  users += 1
  if (!timer) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), 1000)
  }
  onCleanup(() => {
    users -= 1
    if (users > 0 || !timer) return
    clearInterval(timer)
    timer = undefined
  })
  return now
}
