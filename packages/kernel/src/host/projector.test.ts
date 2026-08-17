/**
 * 投影器的不变式测试。
 *
 * 这里测的每一条,出错时在 UI 上都是 **静默** 的:顺序错乱不报错、孤儿 part 被默默丢弃、
 * 流式文本先截断再长回来看起来像"网络抖动"。所以必须在这一层钉死。
 */
import { describe, expect, test } from "bun:test"
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { AgentMessage } from "@yoma/agent"

import { SessionProjection } from "./projector.ts"
import type { KernelEvent } from "../protocol.ts"
import { sortKeyOf } from "../ids.ts"
import type { Part, ToolPart } from "../types.ts"

const T0 = 1_800_000_000_000

function projection() {
  return new SessionProjection({ sessionID: "ses_test", providerID: "faux", modelID: "faux-1" })
}

function user(text: string, timestamp = T0): UserMessage {
  return { role: "user", content: text, timestamp }
}

function usage(input = 10, output = 20) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input + output,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  }
}

function assistant(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
  timestamp = T0 + 1,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as AssistantMessage["api"],
    provider: "faux" as AssistantMessage["provider"],
    model: "faux-1",
    usage: usage(),
    stopReason: "stop",
    timestamp,
    ...extra,
  }
}

function toolResult(toolCallId: string, text: string, details?: unknown, timestamp = T0 + 5): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp,
  }
}

function replay(messages: AgentMessage[]): KernelEvent[] {
  const p = projection()
  return messages.flatMap((m) => p.applyMessage(m))
}

function partsOf(events: KernelEvent[]): Part[] {
  return events.flatMap((e) => (e.type === "message.part.updated" ? [e.part] : []))
}

describe("确定性", () => {
  test("同一段历史投影两次,事件流逐字节相同", () => {
    const history: AgentMessage[] = [
      user("你好"),
      assistant([{ type: "text", text: "你好,我是 yoma" }]),
      user("再来一次", T0 + 10),
      assistant([{ type: "text", text: "好的" }], {}, T0 + 11),
    ]
    expect(JSON.stringify(replay(history))).toBe(JSON.stringify(replay(history)))
  })

  test("消息 id 严格递增,即使内核时间戳不单调", () => {
    // 时钟回拨:第三条的时间戳比第二条小。id 仍然必须递增,否则 transcript 会乱序。
    const history: AgentMessage[] = [
      user("a", T0 + 100),
      assistant([{ type: "text", text: "b" }], {}, T0 + 50),
      user("c", T0 + 10),
      assistant([{ type: "text", text: "d" }], {}, T0 + 5),
    ]
    const ids = replay(history)
      .filter((e) => e.type === "message.updated")
      .map((e) => (e as Extract<KernelEvent, { type: "message.updated" }>).message.id)

    expect(ids.length).toBe(4)
    for (let i = 1; i < ids.length; i += 1) {
      expect(sortKeyOf(ids[i]!) > sortKeyOf(ids[i - 1]!)).toBe(true)
      expect(ids[i]! > ids[i - 1]!).toBe(true) // 字符串序也必须对 —— 前端就是这么二分的
    }
  })

  test("1000 条消息下 id 仍然严格递增", () => {
    const history: AgentMessage[] = []
    for (let i = 0; i < 1000; i += 1) history.push(user(`m${i}`, T0 + (i % 7)))
    const ids = replay(history)
      .filter((e) => e.type === "message.updated")
      .map((e) => (e as Extract<KernelEvent, { type: "message.updated" }>).message.id)
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]! > ids[i - 1]!).toBe(true)
  })
})

describe("发射顺序", () => {
  test("父 message.updated 一定排在它的 part 之前", () => {
    // 前端 reducer 会静默丢弃孤儿 part,所以这条错了不会报错,只会少渲染。
    const events = replay([user("你好"), assistant([{ type: "text", text: "hi" }])])
    const seen = new Set<string>()
    for (const event of events) {
      if (event.type === "message.updated") seen.add(event.message.id)
      if (event.type === "message.part.updated") expect(seen.has(event.part.messageID)).toBe(true)
    }
  })
})

describe("流式", () => {
  test("累积的 delta 恰好等于最终快照 —— 不能先截断再长回来", () => {
    const p = projection()
    p.applyMessage(user("讲个笑话"))

    const chunks = ["从", "前", "有", "座", "山"]
    let partial = assistant([{ type: "text", text: "" }], { stopReason: "toolUse" })
    p.applyMessage(partial)

    let accumulated = ""
    let partID = ""
    for (const chunk of chunks) {
      accumulated += chunk
      partial = assistant([{ type: "text", text: accumulated }], { stopReason: "toolUse" })
      const event: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: chunk, partial }
      for (const out of p.applyStreamEvent(event, partial)) {
        if (out.type === "message.part.delta") partID = out.partID
      }
    }

    const final = assistant([{ type: "text", text: accumulated }])
    p.applyStreamEvent({ type: "done", reason: "stop", message: final }, final)

    const snapshot = p.snapshot().at(-1)!
    const textPart = snapshot.parts.find((part) => part.id === partID)
    expect(textPart?.type).toBe("text")
    expect((textPart as { text: string }).text).toBe(accumulated)
    expect((textPart as { text: string }).text.startsWith(chunks.join(""))).toBe(true)
  })

  test("live 的最终快照 == 直接 replay 同一条消息", () => {
    // 两条路必须同源。yoma 自己的 ACP 适配器就是在这里分了叉,导致图片只在重放时可见。
    const live = projection()
    live.applyMessage(user("你好"))
    const streaming = assistant([{ type: "text", text: "" }], { stopReason: "toolUse" })
    live.applyMessage(streaming)
    const final = assistant([{ type: "text", text: "完整回答" }])
    live.applyStreamEvent({ type: "done", reason: "stop", message: final }, final)

    const replayed = projection()
    replayed.applyMessage(user("你好"))
    replayed.applyMessage(final)

    expect(JSON.stringify(live.snapshot())).toBe(JSON.stringify(replayed.snapshot()))
  })
})

describe("工具", () => {
  test("并行工具的结果乱序到达,仍按 toolCallId 配对", () => {
    const p = projection()
    p.applyMessage(user("读两个文件"))
    p.applyMessage(
      assistant(
        [
          { type: "toolCall", id: "call_A", name: "read", arguments: { path: "/a" } },
          { type: "toolCall", id: "call_B", name: "read", arguments: { path: "/b" } },
        ],
        { stopReason: "toolUse" },
      ),
    )

    // 故意反序:B 先完成。按到达顺序配对的话,内容会互换 —— 而且没有任何报错。
    p.applyMessage(toolResult("call_B", "B 的内容", { path: "/b" }))
    p.applyMessage(toolResult("call_A", "A 的内容", { path: "/a" }))

    const parts = p.snapshot().at(-1)!.parts as ToolPart[]
    const a = parts.find((part) => part.callID === "call_A")!
    const b = parts.find((part) => part.callID === "call_B")!
    expect(a.state.status).toBe("completed")
    expect((a.state as { output: string }).output).toBe("A 的内容")
    expect((b.state as { output: string }).output).toBe("B 的内容")
    expect((a.state as { metadata: { path: string } }).metadata.path).toBe("/a")
  })

  test("工具结果里的图片变成 attachments,不会消失", () => {
    const p = projection()
    p.applyMessage(user("看图"))
    p.applyMessage(
      assistant([{ type: "toolCall", id: "call_img", name: "datasheet", arguments: {} }], { stopReason: "toolUse" }),
    )
    p.applyMessage({
      role: "toolResult",
      toolCallId: "call_img",
      toolName: "datasheet",
      content: [
        { type: "text", text: "figure 12" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      details: { action: "view_figure", mime: "image/png" },
      isError: false,
      timestamp: T0 + 9,
    } as AgentMessage)

    const part = (p.snapshot().at(-1)!.parts as ToolPart[]).find((x) => x.callID === "call_img")!
    expect(part.state.status).toBe("completed")
    const attachments = (part.state as { attachments?: Array<{ url: string; mime: string }> }).attachments
    expect(attachments?.length).toBe(1)
    expect(attachments![0]!.url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("找不到对应调用的结果被丢弃,不凭空造无主卡片", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    expect(p.applyMessage(toolResult("call_ghost", "野结果"))).toEqual([])
  })

  test("重算快照不会把已完成的工具倒回 pending", () => {
    const p = projection()
    p.applyMessage(user("读文件"))
    const call = assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }], {
      stopReason: "toolUse",
    })
    p.applyMessage(call)
    p.applyMessage(toolResult("c1", "内容"))
    // 流式事件会触发快照重算 —— 不能因此把状态机倒回去。
    p.applyStreamEvent({ type: "toolcall_end", contentIndex: 0, toolCall: call.content[0] as never, partial: call }, call)
    const part = (p.snapshot().at(-1)!.parts as ToolPart[])[0]!
    expect(part.state.status).toBe("completed")
  })
})

describe("错误", () => {
  test("stopReason error/aborted 必须投影成 MessageError,不能变成空白轮次", () => {
    // yoma 的内核对 provider 失败永不抛异常,失败就是一条消息。漏投影 = UI 上什么都没有。
    const cases: Array<[AssistantMessage["stopReason"], string, string]> = [
      ["aborted", "用户中断", "MessageAbortedError"],
      ["error", "context length exceeded", "ContextOverflowError"],
      ["error", "invalid api key", "ProviderAuthError"],
      ["error", "socket hang up", "UnknownError"],
    ]
    for (const [stopReason, errorMessage, expected] of cases) {
      const p = projection()
      p.applyMessage(user("你好"))
      const events = p.applyMessage(assistant([{ type: "text", text: "" }], { stopReason, errorMessage }))
      const info = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message
      expect(info.role).toBe("assistant")
      expect((info as { error?: { name: string } }).error?.name).toBe(expected)
    }
  })

  test("usage 投影成前端的 tokens/cost 形状", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    const events = p.applyMessage(assistant([{ type: "text", text: "hi" }], { usage: usage(111, 222) }))
    const info = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message as {
      tokens: { input: number; output: number }
      cost: number
    }
    expect(info.tokens.input).toBe(111)
    expect(info.tokens.output).toBe(222)
    expect(info.cost).toBe(0.3)
  })
})

describe("自定义角色", () => {
  test("bashExecution 用内核自己的渲染函数,不会消失", () => {
    const p = projection()
    p.applyMessage(user("跑一下"))
    const events = p.applyMessage({
      role: "bashExecution",
      command: "ls -la",
      output: "total 0",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: T0 + 3,
    } as AgentMessage)
    const parts = partsOf(events)
    expect(parts.length).toBe(1)
    expect((parts[0] as { text: string }).text).toContain("ls -la")
    expect((parts[0] as { text: string }).text).toContain("total 0")
  })

  test("compactionSummary 既画分隔线,也保住摘要正文", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    const parts = partsOf(
      p.applyMessage({
        role: "compactionSummary",
        summary: "前面聊了 STM32 时钟树配置",
        tokensBefore: 90_000,
        timestamp: T0 + 4,
      } as AgentMessage),
    )
    expect(parts.map((part) => part.type)).toEqual(["compaction", "text"])
    expect((parts[1] as { text: string }).text).toContain("时钟树")
  })

  test("display:false 的 custom 消息不渲染", () => {
    const p = projection()
    expect(
      p.applyMessage({
        role: "custom",
        customType: "internal",
        content: "不该出现",
        display: false,
        timestamp: T0,
      } as AgentMessage),
    ).toEqual([])
  })
})
