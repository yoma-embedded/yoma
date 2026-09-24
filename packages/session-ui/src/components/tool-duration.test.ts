import { describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { formatToolDuration, toolElapsed, useSecondTicker } from "./tool-duration"

describe("工具行右边的耗时", () => {
  test("不到 0.1 秒不画;十秒以内一位小数(向下取),一分钟以内整秒,再往上分秒", () => {
    expect(formatToolDuration(0)).toBe("")
    expect(formatToolDuration(99)).toBe("")
    expect(formatToolDuration(100)).toBe("0.1s")
    expect(formatToolDuration(420)).toBe("0.4s")
    expect(formatToolDuration(9_999)).toBe("9.9s")
    expect(formatToolDuration(12_700)).toBe("12s")
    expect(formatToolDuration(65_000)).toBe("1m 5s")
  })

  // 旧版本重放出来的开始时间是重放那一刻,end - start 是负数:给空,卡片上不画一个错的数。
  test("负数与 NaN 给空串", () => {
    expect(formatToolDuration(-5)).toBe("")
    expect(formatToolDuration(Number.NaN)).toBe("")
  })

  test("结束了用 end,还在跑用 now,没有开始时间给 undefined", () => {
    expect(toolElapsed({ start: 1_000, end: 3_500 }, 99_000)).toBe(2_500)
    expect(toolElapsed({ start: 1_000 }, 4_000)).toBe(3_000)
    expect(toolElapsed(undefined, 4_000)).toBeUndefined()
    expect(toolElapsed({ start: 0 }, 4_000)).toBeUndefined()
  })

  test("秒表有人订才转(两个订户共用一个定时器),最后一个退订就停", () => {
    vi.useFakeTimers()
    try {
      const before = vi.getTimerCount()
      let first!: () => void
      let second!: () => void
      const a = createRoot((dispose) => {
        first = dispose
        return useSecondTicker()
      })
      const b = createRoot((dispose) => {
        second = dispose
        return useSecondTicker()
      })
      expect(a).toBe(b)
      expect(vi.getTimerCount()).toBe(before + 1)
      const start = a()
      vi.advanceTimersByTime(1_000)
      expect(a()).toBeGreaterThanOrEqual(start)
      first()
      expect(vi.getTimerCount()).toBe(before + 1)
      second()
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
