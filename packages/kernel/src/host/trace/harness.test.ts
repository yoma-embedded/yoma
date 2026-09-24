/**
 * 轨迹订阅器的忙时心跳(harness.ts):忙时每隔一段写一行 `busy`(阶段、在跑的工具与多久没出字,按调用 id 区分);
 * run_end 停;一轮没等到 run_end 就被判失败(SessionManager.fail 清掉阶段)时也停 —— 不能每 30 s 报一次"忙"直到会话关掉。
 * 用一个只会 `events.on` 的假 harness 与假时钟;真 harness 的整条链在 activity-trace.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ActivityTracker } from "../activity.ts"
import { traceHarness } from "./harness.ts"
import type { Trace, TraceFields } from "./sink.ts"

type Handler = (event: Record<string, unknown>) => void

function fakeHarness() {
  const handlers = new Map<string, Handler>()
  return {
    harness: {
      events: {
        on(type: string, handler: Handler) {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    },
    emit(type: string, event: Record<string, unknown>) {
      handlers.get(type)?.(event)
    },
    handlers,
  }
}

function memoryTrace() {
  const lines: Array<{ ev: string } & TraceFields> = []
  const trace: Trace = {
    enabled: true,
    write: (ev, fields) => void lines.push({ ev, ...fields }),
    flush: async () => {},
    close: async () => {},
  }
  return { trace, lines }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe("traceHarness 的忙时心跳", () => {
  it("忙时每隔一段一行:阶段、在跑的工具(按调用 id)与多久没出字;run_end 之后不再写", () => {
    const { harness, emit } = fakeHarness()
    const { trace, lines } = memoryTrace()
    const tracker = new ActivityTracker()
    const unsubscribe = traceHarness(harness as never, {
      trace,
      sessionID: "S",
      activity: () => tracker,
      heartbeatMs: 1_000,
    })
    tracker.runStart()
    emit("run_start", { runId: "R" })
    tracker.toolStart("c1", "bash")
    emit("tool_start", { runId: "R", toolCallId: "c1", toolName: "bash", args: { command: "du -sh ." } })
    vi.advanceTimersByTime(1_000)
    emit("tool_update", { runId: "R", toolCallId: "c1", toolName: "bash" })
    vi.advanceTimersByTime(1_500)

    const busy = lines.filter((line) => line.ev === "busy")
    expect(busy).toHaveLength(2)
    expect(busy[1]).toMatchObject({ s: "S", run: "R", phase: "tools", run_ms: 2_000 })
    expect(busy[1]!.tools).toEqual([{ tc: "c1", tool: "bash", ms: 2_000, quiet_ms: 1_000 }])
    expect(lines.find((line) => line.ev === "tool.start")).toMatchObject({ tool: "bash", summary: "du -sh ." })

    tracker.runEnd()
    emit("run_end", { runId: "R", status: "completed" })
    vi.advanceTimersByTime(5_000)
    expect(lines.filter((line) => line.ev === "busy")).toHaveLength(2)
    expect(lines.at(-1)).toMatchObject({ ev: "run.end", status: "completed", ms: 2_500 })
    for (const off of unsubscribe) off()
  })

  it("没等到 run_end 就判失败(阶段被清掉):下一拍发现就停,不会每 30 s 报一次忙", () => {
    const { harness, emit } = fakeHarness()
    const { trace, lines } = memoryTrace()
    const tracker = new ActivityTracker()
    traceHarness(harness as never, { trace, sessionID: "S", activity: () => tracker, heartbeatMs: 1_000 })
    tracker.runStart()
    emit("run_start", { runId: "R" })
    vi.advanceTimersByTime(1_000)
    expect(lines.filter((line) => line.ev === "busy")).toHaveLength(1)
    // SessionManager.fail:没有 run_end,只清阶段
    tracker.runEnd()
    vi.advanceTimersByTime(10_000)
    expect(lines.filter((line) => line.ev === "busy")).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("首字只记一次;这一批工具跑完后下一次请求的 wait_ms 从跑完那一刻算", () => {
    const { harness, emit } = fakeHarness()
    const { trace, lines } = memoryTrace()
    traceHarness(harness as never, { trace, sessionID: "S", heartbeatMs: 60_000 })
    const assistant = { role: "assistant", provider: "deepseek", model: "deepseek-flash", content: [] }
    emit("run_start", { runId: "R" })
    vi.advanceTimersByTime(300)
    emit("message_start", { runId: "R", message: assistant })
    vi.advanceTimersByTime(200)
    emit("message_update", { runId: "R", message: assistant, event: { type: "thinking_start" } })
    emit("message_update", { runId: "R", message: assistant, event: { type: "thinking_delta" } })
    emit("message_update", { runId: "R", message: assistant, event: { type: "text_delta" } })
    emit("tool_start", { runId: "R", toolCallId: "c1", toolName: "ls", args: { path: "." } })
    vi.advanceTimersByTime(1_000)
    emit("tool_end", { runId: "R", toolCallId: "c1", toolName: "ls", isError: false, result: { content: [{ type: "text", text: "a\nb" }] } })
    vi.advanceTimersByTime(700)
    emit("message_start", { runId: "R", message: assistant })

    expect(lines.filter((line) => line.ev === "llm.first")).toEqual([
      expect.objectContaining({ kind: "thinking", time_to_first_chunk_ms: 200 }),
    ])
    expect(lines.find((line) => line.ev === "tool.end")).toMatchObject({ ms: 1_000, error: false, out_chars: 3 })
    const starts = lines.filter((line) => line.ev === "llm.start")
    expect(starts.map((line) => line.wait_ms)).toEqual([300, 700])
    expect(starts[0]).toMatchObject({ model: "deepseek/deepseek-flash" })
  })

  it("轨迹关着时一个都不订", () => {
    const { harness, handlers } = fakeHarness()
    const off = traceHarness(harness as never, {
      trace: { enabled: false, write() {}, flush: async () => {}, close: async () => {} },
      sessionID: "S",
    })
    expect(off).toEqual([])
    expect(handlers.size).toBe(0)
  })
})
