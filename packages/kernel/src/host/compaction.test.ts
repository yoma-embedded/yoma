import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@yoma/my-pi"
import { shouldAutoCompact } from "./compaction.ts"

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
