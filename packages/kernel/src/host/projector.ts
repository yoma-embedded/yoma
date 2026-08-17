/**
 * 投影器:把 yoma 的 AgentMessage / AgentEvent 变成前端认得的 Message / Part / KernelEvent。
 *
 * ## 一个函数,两条路
 *
 * live(流式)和 replay(重开会话)**必须走同一份投影逻辑**。yoma 自己的 ACP 适配器把这
 * 拆成了 pipeHarnessToAcp 和 replayUpdatesOf 两条独立实现,代价是 datasheet 图片只在重放
 * 时可见(acp/session.ts:270 有注释承认)。这里 live 和 replay 都调 `applyMessage()`,
 * 流式 delta 只是叠在它上面的一层增量,快照永远由同一个函数产出。
 *
 * ## id 是自己铸的,而且必须确定
 *
 * yoma 的消息没有 id,它的 entry id 又是 `uuidv7().slice(-8)`(随机尾部,不可排序)。
 * 所以这里从 (消息序号, 消息时间戳) 确定性地铸 id:同一段历史投影两次,结果逐字节相同。
 * 这条是可测的 —— live/replay 等价性测试就靠它。
 *
 * ## 工具调用与结果的配对
 *
 * yoma 里工具调用在 assistant.content[i](type:"toolCall"),结果是 **另一条**
 * role:"toolResult" 消息。前端要的是一个带 4 态机的 ToolPart。配对 **只能按 toolCallId**,
 * 绝不能按到达顺序 —— 并行工具时 tool_execution_end 按完成序发,而 transcript 是源序。
 */

import type { AssistantMessageEvent, ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai"
import type {
  AgentMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "@yoma/agent"
import { bashExecutionToText } from "@yoma/agent"

import type { KernelEvent } from "../protocol.ts"
import type {
  AssistantMessage as ViewAssistant,
  FilePart,
  Message as ViewMessage,
  MessageError,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolState,
  Tokens,
  UserMessage as ViewUser,
} from "../types.ts"

const COUNTER_BITS = 12n
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function hex12(value: bigint): string {
  let out = ""
  for (let i = 0; i < 6; i += 1) out += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  return out
}

/** 确定性的 base62 填充 —— 铸 id 时不能用随机数,否则 live/replay 对不上。 */
function base62(value: number, width: number): string {
  let n = Math.max(0, Math.trunc(value))
  let out = ""
  while (out.length < width) {
    out = BASE62[n % 62]! + out
    n = Math.floor(n / 62)
  }
  return out.slice(-width)
}

const ZERO_TOKENS = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

/** yoma 的 content block 里,哪些下标算"可见 part"。工具调用也占一个下标。 */
type AssistantBlock = TextContent | ThinkingContent | ToolCall

/**
 * 内核的四种自定义消息角色。前端的 Message 只有 user|assistant,所以它们要合成过去。
 * 这里显式列举而不是 `Exclude<AgentMessage, ...>` —— yoma 以后新增角色时,
 * 编译器会在 applyMessage 的 switch 上报 default 分支类型不匹配,提醒我们补投影。
 */
type SyntheticMessage = BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage

interface ToolRef {
  messageID: string
  partID: string
  index: number
  startedAt: number
}

export interface ProjectionOptions {
  sessionID: string
  providerID?: string
  modelID?: string
}

/**
 * 一个会话的投影状态。
 *
 * 有状态是必须的:工具结果要回填到前面某条 assistant 消息的 ToolPart 上,
 * assistant 消息要挂到当轮的用户消息 parentID 上,而 id 要跨消息保持单调。
 */
export class SessionProjection {
  readonly sessionID: string
  private providerID: string
  private modelID: string

  /** 已投影的消息总数,用来铸确定性 id。 */
  private messageCount = 0
  /** 上一条消息的排序键,保证严格递增(内核时间戳可能不单调)。 */
  private lastKey = 0n
  /** 当前轮的用户消息 id —— assistant 消息的 parentID。 */
  private turnParentID = ""
  /** toolCallId → 它在哪条消息的哪个 part 上。跨消息,所以必须是会话级的。 */
  private readonly toolRefs = new Map<string, ToolRef>()
  /** messageID → 该消息当前的投影结果,供增量更新时取回。 */
  private readonly messages = new Map<string, { info: ViewMessage; parts: Part[] }>()
  /** 正在流式的 assistant 消息 id。 */
  private streamingID = ""

  constructor(options: ProjectionOptions) {
    this.sessionID = options.sessionID
    this.providerID = options.providerID ?? "unknown"
    this.modelID = options.modelID ?? "unknown"
  }

  /** 当前完整快照,给 session.messages 分页接口用。 */
  snapshot(): Array<{ info: ViewMessage; parts: Part[] }> {
    return [...this.messages.values()]
  }

  setModel(providerID: string, modelID: string) {
    this.providerID = providerID
    this.modelID = modelID
  }

  // -------------------------------------------------------------------------
  // id 铸造 —— 确定性,可排序
  // -------------------------------------------------------------------------

  private nextMessageID(timestamp: number): string {
    const candidate = BigInt(Math.max(0, Math.trunc(timestamp))) << COUNTER_BITS
    const key = candidate > this.lastKey ? candidate : this.lastKey + 1n
    this.lastKey = key
    const index = this.messageCount++
    return `msg_${hex12(key)}${base62(index, 14)}`
  }

  /**
   * part id 从所属消息的 id 派生 + 下标。
   * 这样同一条消息内按 content 下标排序,跨消息按消息 id 排序,而且完全确定。
   */
  private partID(messageID: string, index: number): string {
    return `prt_${messageID.slice(4, 16)}${base62(index, 6)}`
  }

  // -------------------------------------------------------------------------
  // 主入口:投影一条 yoma 消息
  // -------------------------------------------------------------------------

  /**
   * 投影一条内核消息,返回要发给前端的事件。
   *
   * **发射顺序是硬约束**:父 message.updated 一定排在它的任何 part 事件之前 ——
   * 前端 reducer 会静默丢弃孤儿 part(server-session.ts:771-779),不报错。
   */
  applyMessage(message: AgentMessage, options?: { messageID?: string }): KernelEvent[] {
    switch (message.role) {
      case "user":
        return this.applyUser(message, options?.messageID)
      case "assistant":
        return this.applyAssistant(message, options?.messageID)
      case "toolResult":
        return this.applyToolResult(message)
      default:
        return this.applySynthetic(message as SyntheticMessage)
    }
  }

  // -------------------------------------------------------------------------

  private applyUser(message: Extract<AgentMessage, { role: "user" }>, givenID?: string): KernelEvent[] {
    // renderer 乐观插入时已经铸过 id,必须复用,否则同一条消息会渲染两遍。
    const id = givenID ?? this.nextMessageID(message.timestamp)
    if (givenID) this.messageCount++
    this.turnParentID = id

    const info: ViewUser = {
      id,
      sessionID: this.sessionID,
      role: "user",
      time: { created: message.timestamp },
      model: { providerID: this.providerID, modelID: this.modelID },
    }

    const parts: Part[] = []
    const content = message.content
    if (typeof content === "string") {
      parts.push(this.textPart(id, 0, content))
    } else {
      content.forEach((block, index) => {
        if (block.type === "text") parts.push(this.textPart(id, index, block.text))
        else if (block.type === "image") parts.push(this.filePart(id, index, block))
      })
    }

    this.messages.set(id, { info, parts })
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  private applyAssistant(message: Extract<AgentMessage, { role: "assistant" }>, givenID?: string): KernelEvent[] {
    const id = givenID ?? this.nextMessageID(message.timestamp)
    if (givenID) this.messageCount++
    this.streamingID = id

    const info = this.assistantInfo(id, message)
    const parts = this.assistantParts(id, message.content as AssistantBlock[])

    this.messages.set(id, { info, parts })
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  /**
   * 工具结果回填。
   *
   * yoma 把它作为独立消息发出,但前端要的是把它折进 assistant 那条 ToolPart 的 state。
   * 找不到对应的 ToolPart 就丢弃 —— 那只可能是流式乱序或历史损坏,凭空造一个 part
   * 只会让 transcript 出现无主的工具卡片。
   */
  private applyToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): KernelEvent[] {
    const ref = this.toolRefs.get(message.toolCallId)
    if (!ref) return []
    const entry = this.messages.get(ref.messageID)
    if (!entry) return []
    const part = entry.parts[ref.index]
    if (!part || part.type !== "tool") return []

    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
    const images = message.content.filter((block): block is ImageContent => block.type === "image")

    const attachments = images.map((image, i) => this.filePart(ref.messageID, ref.index * 100 + i + 1, image))

    const time = { start: ref.startedAt, end: message.timestamp }
    part.state = message.isError
      ? { status: "error", input: part.state.input, error: text || "tool failed", metadata: asDetails(message.details), time }
      : {
          status: "completed",
          input: part.state.input,
          output: text,
          title: part.tool,
          metadata: asDetails(message.details),
          time,
          ...(attachments.length ? { attachments } : {}),
        }

    return [partEvent(part)]
  }

  /**
   * yoma 的四种自定义消息角色 —— bashExecution / custom / compactionSummary / branchSummary。
   * 前端的 Message 只有 user|assistant 两种,所以合成一条 synthetic assistant 消息装它们。
   * 不投影的话这些内容会静默消失。
   */
  private applySynthetic(message: SyntheticMessage): KernelEvent[] {
    // custom 消息带 display 开关 —— 内核明说不给人看的,就别渲染。
    if (message.role === "custom" && message.display === false) return []

    const timestamp = Number(message.timestamp) || Date.now()
    const id = this.nextMessageID(timestamp)

    const info: ViewAssistant = {
      id,
      sessionID: this.sessionID,
      role: "assistant",
      parentID: this.turnParentID,
      time: { created: timestamp, completed: timestamp },
      providerID: this.providerID,
      modelID: this.modelID,
      cost: 0,
      tokens: ZERO_TOKENS(),
      synthetic: true,
    }

    const parts: Part[] = []
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      parts.push({
        id: this.partID(id, 0),
        sessionID: this.sessionID,
        messageID: id,
        type: "compaction",
        auto: message.role === "compactionSummary",
        branch: message.role === "branchSummary",
      })
      // 摘要正文单独给一个 text part —— opencode 的 CompactionPart 只画一条分隔线,
      // 不这样做的话压缩出来的内容就彻底看不见了。
      if (message.summary) parts.push({ ...this.textPart(id, 1, message.summary), synthetic: true })
    } else if (message.role === "bashExecution") {
      // 用内核自己的渲染函数,别重写 —— 它处理了 cancelled / exitCode / truncated 三种尾注。
      parts.push({ ...this.textPart(id, 0, bashExecutionToText(message)), synthetic: true })
    } else {
      const content = message.content
      if (typeof content === "string") {
        if (content) parts.push({ ...this.textPart(id, 0, content), synthetic: true })
      } else if (Array.isArray(content)) {
        content.forEach((block, index) => {
          if (block.type === "text") parts.push({ ...this.textPart(id, index, block.text), synthetic: true })
          else if (block.type === "image") parts.push(this.filePart(id, index, block))
        })
      }
    }

    if (!parts.length) return []
    this.messages.set(id, { info, parts })
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  // -------------------------------------------------------------------------
  // 流式增量
  // -------------------------------------------------------------------------

  /**
   * 把一条 pi-ai 的流式事件变成增量。
   *
   * 快照(`message.part.updated`)始终由 assistantParts() 从 `partial.content` 重算 ——
   * 与 replay 同源,所以"累积 delta 是快照的严格前缀"这条不变式天然成立。
   * 一旦这里改成自己拼字符串,就会出现"文本先截断再长回来"。
   */
  applyStreamEvent(event: AssistantMessageEvent, partial: Extract<AgentMessage, { role: "assistant" }>): KernelEvent[] {
    const id = this.streamingID
    if (!id) return []
    const entry = this.messages.get(id)
    if (!entry) return []

    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const partID = this.partID(id, event.contentIndex)
        const events: KernelEvent[] = []
        // part 必须先存在,delta 才不会被丢弃(server-session.ts:886)。
        if (!entry.parts[event.contentIndex]) {
          entry.parts = this.assistantParts(id, partial.content as AssistantBlock[])
          const created = entry.parts[event.contentIndex]
          if (created) events.push(partEvent(created))
        }
        events.push({
          type: "message.part.delta",
          sessionID: this.sessionID,
          messageID: id,
          partID,
          field: "text",
          delta: event.delta,
        })
        return events
      }
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "text_end":
      case "thinking_end":
      case "toolcall_end": {
        entry.parts = this.assistantParts(id, partial.content as AssistantBlock[])
        const part = entry.parts[event.contentIndex]
        return part ? [partEvent(part)] : []
      }
      case "done":
      case "error": {
        const final = event.type === "done" ? event.message : event.error
        entry.info = this.assistantInfo(id, final as Extract<AgentMessage, { role: "assistant" }>)
        entry.parts = this.assistantParts(id, final.content as AssistantBlock[])
        return [{ type: "message.updated", message: entry.info }, ...entry.parts.map(partEvent)]
      }
      default:
        return []
    }
  }

  // -------------------------------------------------------------------------
  // 构件
  // -------------------------------------------------------------------------

  private assistantInfo(id: string, message: Extract<AgentMessage, { role: "assistant" }>): ViewAssistant {
    const usage = message.usage
    return {
      id,
      sessionID: this.sessionID,
      role: "assistant",
      parentID: this.turnParentID,
      time: {
        created: message.timestamp,
        ...(message.stopReason && message.stopReason !== "toolUse" ? { completed: message.timestamp } : {}),
      },
      providerID: message.provider ?? this.providerID,
      modelID: message.model ?? this.modelID,
      cost: usage?.cost?.total ?? 0,
      tokens: {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        reasoning: usage?.reasoning ?? 0,
        cache: { read: usage?.cacheRead ?? 0, write: usage?.cacheWrite ?? 0 },
      },
      ...(errorOf(message) ? { error: errorOf(message)! } : {}),
    }
  }

  private assistantParts(messageID: string, content: AssistantBlock[]): Part[] {
    return content.map((block, index) => {
      if (block.type === "text") return this.textPart(messageID, index, block.text)
      if (block.type === "thinking") return this.reasoningPart(messageID, index, block.thinking)
      return this.toolPart(messageID, index, block)
    })
  }

  private textPart(messageID: string, index: number, text: string): TextPart {
    return {
      id: this.partID(messageID, index),
      sessionID: this.sessionID,
      messageID,
      type: "text",
      text,
    }
  }

  private reasoningPart(messageID: string, index: number, text: string): ReasoningPart {
    return {
      id: this.partID(messageID, index),
      sessionID: this.sessionID,
      messageID,
      type: "reasoning",
      text,
      time: { start: 0 },
    }
  }

  private toolPart(messageID: string, index: number, call: ToolCall): ToolPart {
    const partID = this.partID(messageID, index)
    const existing = this.messages.get(messageID)?.parts[index]
    // 已经有结果了就别把状态倒回去 —— 重算快照不该覆盖已完成的工具卡片。
    if (existing && existing.type === "tool" && existing.callID === call.id) {
      existing.state = mergeInput(existing.state, call.arguments)
      return existing
    }
    if (!this.toolRefs.has(call.id)) {
      this.toolRefs.set(call.id, { messageID, partID, index, startedAt: Date.now() })
    }
    return {
      id: partID,
      sessionID: this.sessionID,
      messageID,
      type: "tool",
      callID: call.id,
      tool: call.name,
      state: { status: "pending", input: (call.arguments ?? {}) as Record<string, unknown> },
    }
  }

  private filePart(messageID: string, index: number, image: ImageContent): FilePart {
    return {
      id: this.partID(messageID, index),
      sessionID: this.sessionID,
      messageID,
      type: "file",
      mime: image.mimeType ?? "image/png",
      url: `data:${image.mimeType ?? "image/png"};base64,${image.data}`,
    }
  }

  /**
   * 收尾当前这条流式 assistant 消息。
   *
   * 必须和 applyAssistant 分开:message_end 到达时那条消息 **已经有 id 了**,再走
   * applyAssistant 会铸一个新 id,transcript 上就多出一条重复回复。没有流式过
   * (非流式 provider、或历史重放)时退化成新建,所以两条路都安全。
   */
  finalizeAssistant(message: Extract<AgentMessage, { role: "assistant" }>): KernelEvent[] {
    const id = this.streamingID
    const entry = id ? this.messages.get(id) : undefined
    if (!id || !entry) return this.applyAssistant(message)

    entry.info = this.assistantInfo(id, message)
    entry.parts = this.assistantParts(id, message.content as AssistantBlock[])
    this.streamingID = ""
    return [{ type: "message.updated", message: entry.info }, ...entry.parts.map(partEvent)]
  }

  // -------------------------------------------------------------------------
  // 工具执行事件(来自 loop,而不是消息)
  // -------------------------------------------------------------------------

  /** tool_execution_start:pending → running。start 时间以这里为准,比消息时间戳准。 */
  markToolRunning(toolCallId: string): KernelEvent[] {
    const ref = this.toolRefs.get(toolCallId)
    if (!ref) return []
    const part = this.messages.get(ref.messageID)?.parts[ref.index]
    if (!part || part.type !== "tool") return []
    ref.startedAt = Date.now()
    if (part.state.status !== "pending") return []
    part.state = { status: "running", input: part.state.input, title: part.tool, time: { start: ref.startedAt } }
    return [partEvent(part)]
  }
}

// ---------------------------------------------------------------------------
// 纯辅助
// ---------------------------------------------------------------------------

function partEvent(part: Part): KernelEvent {
  return { type: "message.part.updated", part }
}

function mergeInput(state: ToolState, args: unknown): ToolState {
  if (state.status !== "pending") return state
  return { ...state, input: (args ?? {}) as Record<string, unknown> }
}

function asDetails(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" ? (details as Record<string, unknown>) : {}
}

/**
 * yoma 的内核对 provider 失败 **永不抛异常** —— 失败是一条 stopReason:"error" 的
 * assistant 消息。不把它投影成 error,UI 上就是一个空白轮次,用户完全不知道发生了什么。
 */
function errorOf(message: Extract<AgentMessage, { role: "assistant" }>): MessageError | undefined {
  if (message.stopReason === "aborted") {
    return { name: "MessageAbortedError", data: { message: message.errorMessage ?? "已中断" } }
  }
  if (message.stopReason === "error") {
    const text = message.errorMessage ?? "未知错误"
    if (/context|too long|token limit|maximum context/i.test(text)) {
      return { name: "ContextOverflowError", data: { message: text } }
    }
    if (/api key|unauthorized|401|403|credential/i.test(text)) {
      return { name: "ProviderAuthError", data: { providerID: message.provider ?? "unknown", message: text } }
    }
    return { name: "UnknownError", data: { message: text } }
  }
  return undefined
}

