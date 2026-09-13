/**
 * ToolProgressThrottle:前沿立即、尾沿补发、间隔内合并、settle 取消尾沿。用假时钟钉时序。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ToolProgressThrottle } from "./tool-progress.ts"

function snapshot(text: string) {
  return { content: [{ type: "text", text }] }
}

describe("ToolProgressThrottle", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("第一块立即发;间隔内的合并成最后一份在尾沿发;间隔过了又能立即发", () => {
    const flushed: Array<[string, string]> = []
    const throttle = new ToolProgressThrottle((id, partial) => flushed.push([id, partial.content[0]!.text!]), 100)
    throttle.push("c1", snapshot("a"))
    expect(flushed).toEqual([["c1", "a"]])
    throttle.push("c1", snapshot("ab"))
    throttle.push("c1", snapshot("abc"))
    expect(flushed).toHaveLength(1)
    vi.advanceTimersByTime(99)
    expect(flushed).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(flushed).toEqual([
      ["c1", "a"],
      ["c1", "abc"],
    ])
    vi.advanceTimersByTime(100)
    throttle.push("c1", snapshot("abcd"))
    expect(flushed).toHaveLength(3)
  })

  it("两个工具调用互不节流", () => {
    const flushed: string[] = []
    const throttle = new ToolProgressThrottle((id) => flushed.push(id), 100)
    throttle.push("c1", snapshot("a"))
    throttle.push("c2", snapshot("b"))
    expect(flushed).toEqual(["c1", "c2"])
  })

  it("settle 取消尾沿:tool_end 之后晚到的那一拍不再发", () => {
    const flushed: string[] = []
    const throttle = new ToolProgressThrottle((_id, partial) => flushed.push(partial.content[0]!.text!), 100)
    throttle.push("c1", snapshot("a"))
    throttle.push("c1", snapshot("ab"))
    throttle.settle("c1")
    vi.advanceTimersByTime(500)
    expect(flushed).toEqual(["a"])
    // settle 之后同一个 id 再来算新的一轮:立即发。
    throttle.push("c1", snapshot("x"))
    expect(flushed).toEqual(["a", "x"])
  })

  it("dispose 之后没有任何计时器会再触发", () => {
    const flushed: string[] = []
    const throttle = new ToolProgressThrottle((id) => flushed.push(id), 100)
    throttle.push("c1", snapshot("a"))
    throttle.push("c1", snapshot("b"))
    throttle.dispose()
    vi.advanceTimersByTime(1000)
    expect(flushed).toEqual(["c1"])
    expect(vi.getTimerCount()).toBe(0)
  })
})
