import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@yoma/agent"
import { overflowAction, shouldAutoCompact } from "./compaction.ts"
import type { AssistantMessage } from "@earendil-works/pi-ai"

const T0 = 1_800_000_000_000

function assistant(tokens: number, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(200) }],
    api: "anthropic-messages",
    provider: "faux",
    model: "m",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage
}

describe("自动压缩的两个 guard", () => {
  test("没有 usage 数据时绝不压 —— 否则新会话一开口就先被压一次", () => {
    const decision = shouldAutoCompact([user("你好", T0)], 100)
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe("no_usage")
  })

  test("刚压缩过时绝不再压 —— 否则会一路压到没东西可压", () => {
    // 幸存消息带的是压缩前那个更大上下文的 usage,时间戳早于压缩点。
    const messages = [user("a", T0), assistant(999_999, T0 + 1)]
    const decision = shouldAutoCompact(messages, 1000, T0 + 100)
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe("just_compacted")
  })

  test("压缩点之后产生的 usage 可以正常触发", () => {
    const messages = [user("a", T0), assistant(999_999, T0 + 200)]
    const decision = shouldAutoCompact(messages, 1000, T0 + 100)
    expect(decision.compact).toBe(true)
    expect(decision.reason).toBe("over_threshold")
  })

  test("上下文还很空时不压", () => {
    const messages = [user("a", T0), assistant(10, T0 + 1)]
    expect(shouldAutoCompact(messages, 1_000_000).compact).toBe(false)
  })

  test("模型没报 contextWindow 时不压 —— 编一个窗口只会在错误的时候压", () => {
    const messages = [user("a", T0), assistant(999_999, T0 + 1)]
    expect(shouldAutoCompact(messages, undefined).compact).toBe(false)
    expect(shouldAutoCompact(messages, 0).compact).toBe(false)
  })
})

describe("溢出处理", () => {
  const model = { provider: "p", id: "m", contextWindow: 1000 }
  const usage = (input: number) => ({
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })
  const msg = (over: Partial<AssistantMessage>): AssistantMessage =>
    ({
      role: "assistant",
      content: [],
      api: "x",
      provider: "p",
      model: "m",
      stopReason: "stop",
      timestamp: 1,
      usage: usage(10),
      ...over,
    }) as AssistantMessage

  test("溢出错误:压缩后重试一次,第二次不再", () => {
    const error = msg({ stopReason: "error", errorMessage: "prompt is too long: 2000 tokens > 1000 maximum" })
    expect(overflowAction(error, model, false)).toBe("compact_and_retry")
    expect(overflowAction(error, model, true)).toBe("none")
  })

  test("回答完成但 usage 超窗:只压缩", () => {
    expect(overflowAction(msg({ usage: usage(5000) }), model, false)).toBe("compact")
    expect(overflowAction(msg({ usage: usage(5000) }), model, true)).toBe("compact")
  })

  test("换过模型的旧消息、普通错误、没有消息:都不算", () => {
    const error = msg({ stopReason: "error", errorMessage: "prompt is too long" })
    expect(overflowAction(error, { ...model, id: "bigger" }, false)).toBe("none")
    expect(overflowAction(msg({ stopReason: "error", errorMessage: "503" }), model, false)).toBe("none")
    expect(overflowAction(undefined, model, false)).toBe("none")
    expect(overflowAction(msg({}), model, false)).toBe("none")
  })
})
