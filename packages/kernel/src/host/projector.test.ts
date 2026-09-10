/**
 * 投影器的不变式测试。
 *
 * 这里测的每一条,出错时在 UI 上都是 **静默** 的:顺序错乱不报错、孤儿 part 被默默丢弃、
 * 流式文本先截断再长回来看起来像"网络抖动"。所以必须在这一层钉死。
 */
import { describe, expect, test } from "vitest"
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { AgentMessage, BranchSummaryEntry, CompactionEntry, CustomEntry } from "@earendil-works/pi-agent-core"

import { removalEvents, SessionProjection } from "./projector.ts"
import type { KernelEvent } from "../protocol.ts"
import { sortKeyOf } from "../ids.ts"
import type { Part, ToolPart, ToolStateCompleted } from "../types.ts"

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

/** 一条压缩 entry(内核 CompactionEntry 的最小形状)。 */
function compaction(summary: string, extra: Partial<CompactionEntry> = {}, timestamp = T0 + 4): CompactionEntry {
  return {
    id: "entry-compaction",
    parentId: null,
    seq: 1,
    timestamp,
    type: "compaction",
    summary,
    retainedTail: [],
    tokensBefore: 90_000,
    fromHook: false,
    ...extra,
  }
}

/** host 在手动压缩之后补的那条自定义 entry。 */
function manualCompaction(compactionEntryId: string, timestamp = T0 + 5): CustomEntry {
  return {
    id: "entry-custom",
    parentId: null,
    seq: 3,
    timestamp,
    type: "custom",
    customType: "yoma/compaction",
    data: { compactionEntryId, manual: true },
  }
}

/**
 * renderer 乐观铸出来的 id。`counter` 是**对方进程**的同毫秒计数器 —— host 看不见它,
 * 所以 host 自己的时钟必须按这个 id 往前对。
 */
function optimisticID(timestamp: number, counter: number): string {
  const key = ((BigInt(timestamp) << 12n) + BigInt(counter)) & ((1n << 48n) - 1n)
  return `msg_${key.toString(16).padStart(12, "0")}Qdq3ABCDEFGHIJ`
}

function branchSummary(summary: string, timestamp = T0 + 6): BranchSummaryEntry {
  return {
    id: "entry-branch",
    parentId: null,
    seq: 2,
    timestamp,
    type: "branch_summary",
    fromId: null,
    summary,
    fromHook: false,
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
    p.startAssistant(partial)

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

    // 收尾走的是 message_end(applyMessage)—— 内核不转发 done/error 流式事件,
    // 它们在 isUpdateEvent 那一关就被筛掉了。
    const final = assistant([{ type: "text", text: accumulated }])
    p.applyMessage(final)

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
    live.startAssistant(streaming)
    const final = assistant([{ type: "text", text: "完整回答" }])
    live.applyMessage(final)

    const replayed = projection()
    replayed.applyMessage(user("你好"))
    replayed.applyMessage(final)

    expect(JSON.stringify(live.snapshot())).toBe(JSON.stringify(replayed.snapshot()))
  })

  test("message_end 收尾的是流式那一条,不会多出一条重复回复", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    const streaming = assistant([{ type: "text", text: "" }], { stopReason: "toolUse" })
    p.startAssistant(streaming)
    p.applyMessage(assistant([{ type: "text", text: "说完了" }]))
    // 紧接着的下一轮必须是**新的**一条 —— 收尾过的消息不再是"流式中的那条"。
    p.applyMessage(assistant([{ type: "text", text: "再说一句" }], {}, T0 + 2))

    const texts = p.snapshot().map((item) => item.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    expect(texts).toEqual(["你好", "说完了", "再说一句"])
  })
})

describe("entryId 映射", () => {
  test("落盘的消息记下 entryId,navigate 据此翻译", () => {
    const p = projection()
    const events = p.applyMessage(user("你好"), { entryId: "entry-7" })
    const id = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message.id
    expect(p.entryIdOf(id)).toBe("entry-7")
    expect(p.entryIdOf("msg_unknown")).toBeUndefined()
  })

  test("renderer 乐观铸的 id 被复用,而且也绑到 entryId 上", () => {
    const p = projection()
    const events = p.applyMessage(user("你好"), { entryId: "entry-9", messageID: "msg_optimistic" })
    const info = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message
    expect(info.id).toBe("msg_optimistic")
    expect(p.entryIdOf("msg_optimistic")).toBe("entry-9")
  })

  test("复用乐观 id 时排序时钟也要跟上 —— 否则同毫秒的回复排在提问前面", () => {
    // 真实形态:renderer 在 host 之后铸 id,两个进程的同毫秒计数器互相看不见。
    // 不把 lastKey 顶到这条 id 上,紧接着铸出的 assistant 回复字典序会更小。
    const p = projection()
    const given = optimisticID(T0 + 5, 9)
    p.applyMessage(user("问题", T0), { messageID: given })
    const events = p.applyMessage(assistant([{ type: "text", text: "回答" }], {}, T0))
    const id = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message.id

    expect(sortKeyOf(id) > sortKeyOf(given)).toBe(true)
    expect(id > given).toBe(true) // 前端就是按整个字符串二分的
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
    expect((a.state as ToolStateCompleted).metadata.path).toBe("/a")
  })

  test("工具结果里的图片变成 attachments,不会消失", () => {
    const p = projection()
    p.applyMessage(user("看图"))
    p.applyMessage(
      assistant([{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "/a.png" } }], {
        stopReason: "toolUse",
      }),
    )
    p.applyMessage({
      role: "toolResult",
      toolCallId: "call_img",
      toolName: "read",
      content: [
        { type: "text", text: "a.png" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      details: { mimeType: "image/png" },
      isError: false,
      timestamp: T0 + 9,
    })

    const part = (p.snapshot().at(-1)!.parts as ToolPart[]).find((x) => x.callID === "call_img")!
    expect(part.state.status).toBe("completed")
    const attachments = (part.state as { attachments?: Array<{ url: string; mime: string }> }).attachments
    expect(attachments?.length).toBe(1)
    expect(attachments![0]!.url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("附件的 part id 不撞同一条消息里下一个 content block", () => {
    // 曾经是 index * 100 + i + 1:工具在 0、文本在 1,第一张附件也算出 1 —— 撞了
    // 之后前端按 part id 去重,少画一块,而且不报错。
    const p = projection()
    p.applyMessage(user("看图"))
    p.applyMessage(
      assistant(
        [
          { type: "toolCall", id: "call_img", name: "read", arguments: { path: "/a.png" } },
          { type: "text", text: "看完了" },
        ],
        { stopReason: "toolUse" },
      ),
    )
    p.applyMessage({
      role: "toolResult",
      toolCallId: "call_img",
      toolName: "read",
      content: [
        { type: "text", text: "a.png" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: T0 + 9,
    })

    const parts = p.snapshot().at(-1)!.parts
    const tool = parts.find((part) => part.type === "tool") as ToolPart
    const attachments = (tool.state as { attachments?: Array<{ id: string }> }).attachments!
    const ids = [...parts.map((part) => part.id), ...attachments.map((part) => part.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("找不到对应调用的结果被丢弃,不凭空造无主卡片", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    expect(p.applyMessage(toolResult("call_ghost", "野结果"))).toEqual([])
  })

  test("tool_start 把卡片推到 running", () => {
    const p = projection()
    p.applyMessage(user("读文件"))
    p.applyMessage(
      assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }], { stopReason: "toolUse" }),
    )
    const events = p.markToolRunning("c1")
    expect(partsOf(events).map((part) => (part.type === "tool" ? part.state.status : part.type))).toEqual(["running"])
    // 不认识的 toolCallId 是 no-op,不凭空造卡片。
    expect(p.markToolRunning("nope")).toEqual([])
  })

  test("重算快照不会把已完成的工具倒回 pending", () => {
    const p = projection()
    p.applyMessage(user("读文件"))
    const call = assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }], {
      stopReason: "toolUse",
    })
    p.startAssistant(call)
    p.applyMessage(toolResult("c1", "内容"))
    // 流式事件会触发快照重算 —— 不能因此把状态机倒回去。
    p.applyStreamEvent({ type: "toolcall_end", contentIndex: 0, toolCall: call.content[0] as never, partial: call }, call)
    const part = (p.snapshot().at(-1)!.parts as ToolPart[])[0]!
    expect(part.state.status).toBe("completed")
  })
})

describe("错误", () => {
  test("流式中途 provider 失败:错误在 message_end 那一条上 —— 没有 done/error 流式事件这回事", () => {
    // 内核只转发 start 与 start/done/error 之外的事件(execution/assistant.ts 的
    // isUpdateEvent),所以失败只能从收尾那条消息的 stopReason 读出来。
    const p = projection()
    p.applyMessage(user("你好"))
    const streaming = assistant([{ type: "text", text: "" }], { stopReason: "toolUse" })
    p.startAssistant(streaming)
    const failed = assistant([{ type: "text", text: "半句" }], { stopReason: "error", errorMessage: "socket hang up" })
    const events = p.applyMessage(failed)

    const info = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message
    expect((info as { error?: { name: string } }).error?.name).toBe("UnknownError")
    // 收尾的是流式那一条,没有多出一条重复回复。
    expect(p.snapshot().length).toBe(2)
  })

  test("stopReason error/aborted 必须投影成 MessageError,不能变成空白轮次", () => {
    // 内核对 provider 失败永不抛异常,失败就是一条消息。漏投影 = UI 上什么都没有。
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

describe("压缩与分支摘要", () => {
  test("压缩 entry 既画分隔线,也保住摘要正文", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    const parts = partsOf(p.applySummary(compaction("前面聊了 STM32 时钟树配置")))
    expect(parts.map((part) => part.type)).toEqual(["compaction", "text"])
    expect((parts[0] as { auto: boolean }).auto).toBe(true)
    expect((parts[1] as { text: string }).text).toContain("时钟树")
  })

  test("手动压缩:yoma/compaction entry 把分隔线翻成 auto:false,live 与重放同一条路", () => {
    // 压缩 entry 自己记不下"是谁按的",所以 host 额外落一条自定义 entry。投影器两条路
    // (live 的 entry_added / 重放)都从它读,同一段历史才不会一边 auto 一边手动。
    const p = projection()
    p.applyMessage(user("你好"))
    const parts = partsOf(p.applySummary(compaction("摘要")))
    expect((parts[0] as { auto: boolean }).auto).toBe(true)

    const flipped = partsOf(p.applyCustomEntry(manualCompaction("entry-compaction")))
    expect(flipped.map((part) => part.id)).toEqual([parts[0]!.id])
    expect((flipped[0] as { auto: boolean }).auto).toBe(false)
    expect((p.snapshot().at(-1)!.parts[0] as { auto: boolean }).auto).toBe(false)

    // 指向不认识的 entry、或者别的 customType,都是 no-op。
    expect(p.applyCustomEntry(manualCompaction("entry-nope"))).toEqual([])
    expect(p.applyCustomEntry({ ...manualCompaction("entry-compaction"), customType: "别的" })).toEqual([])
  })

  test("分支摘要画的是 branch 分隔线", () => {
    const p = projection()
    const parts = partsOf(p.applySummary(branchSummary("那条支线试了 DMA,没成")))
    expect((parts[0] as { auto: boolean; branch?: boolean }).branch).toBe(true)
    expect((parts[0] as { auto: boolean }).auto).toBe(false)
    expect((parts[1] as { text: string }).text).toContain("DMA")
  })

  test("摘要自带的 usage 记到合成消息的 cost/tokens 上", () => {
    const p = projection()
    p.applyMessage(user("你好"))
    const events = p.applySummary(
      compaction("摘要", {
        usage: {
          input: 1000,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1200,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
      }),
    )
    const info = events.find((e) => e.type === "message.updated")!.message as {
      cost: number
      tokens: { input: number; output: number }
      synthetic?: boolean
    }
    expect(info.cost).toBe(0.003)
    expect(info.tokens).toMatchObject({ input: 1000, output: 200 })
    expect(info.synthetic).toBe(true)
  })

  test("摘要 entry 也进 entryId 映射 —— navigate 能落到它身上", () => {
    const p = projection()
    const events = p.applySummary(compaction("摘要"))
    const id = (events[0] as Extract<KernelEvent, { type: "message.updated" }>).message.id
    expect(p.entryIdOf(id)).toBe("entry-compaction")
  })
})

describe("removalEvents", () => {
  /** 只要 id 与 parts,别的字段 removalEvents 不看。 */
  function snap(id: string, ...partIDs: string[]) {
    return {
      info: { id } as never,
      parts: partIDs.map((partID) => ({ id: partID }) as never) as Part[],
    }
  }

  test("消失的消息报 message.removed,活下来的消息里消失的 part 报 message.part.removed", () => {
    const before = [snap("msg_a", "prt_a0", "prt_a1"), snap("msg_b", "prt_b0")]
    const after = [snap("msg_a", "prt_a0")]
    expect(removalEvents("ses_1", before, after)).toEqual([
      { type: "message.part.removed", sessionID: "ses_1", messageID: "msg_a", partID: "prt_a1" },
      { type: "message.removed", sessionID: "ses_1", messageID: "msg_b" },
    ])
  })

  test("什么都没变就一条事件都不发", () => {
    const same = [snap("msg_a", "prt_a0")]
    expect(removalEvents("ses_1", same, same)).toEqual([])
  })
})
