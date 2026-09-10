/**
 * 投影器:把内核的 AgentMessage / Entry 变成前端认得的 Message / Part / KernelEvent。
 *
 * ## 一个函数,两条路
 *
 * live(流式)和 replay(重开会话)**必须走同一份投影逻辑**。已删除的 ACP 适配器曾把这
 * 拆成两条独立实现(pipeHarnessToAcp 与 replayUpdatesOf),代价是工具图片只在重放时
 * 可见。这个教训别再犯。这里 live 和 replay 都调 `applyMessage()`,流式 delta 只是叠在
 * 它上面的一层增量,快照永远由同一个函数产出。
 *
 * ## id 是自己铸的,而且必须确定
 *
 * 内核的消息没有 id,entry id 是 uuidv7(不是前端那套 26 位可比较格式)。所以这里从
 * (消息序号, 消息时间戳) 确定性地铸 id:同一段历史投影两次,结果逐字节相同。
 * 这条是可测的 —— live/replay 等价性测试就靠它。
 *
 * 两个例外,都是"外面已经有一个 id 了,必须沿用":renderer 乐观插入用户消息时铸的那个
 * (applyMessage 的 options.messageID),以及 navigate 重建投影时活下来的那些
 * (ProjectionOptions.reuseIDs)。沿用时排序时钟要跟着走,见 reuseID()。
 *
 * ## 工具调用与结果的配对
 *
 * 内核里工具调用在 assistant.content[i](type:"toolCall"),结果是 **另一条**
 * role:"toolResult" 消息。前端要的是一个带 4 态机的 ToolPart。配对 **只能按 toolCallId**,
 * 绝不能按到达顺序 —— 并行工具时 tool_end 按完成序发,而 transcript 是源序。
 *
 * ## entryId ↔ messageID
 *
 * 前端只认自己铸的 messageID,而 `session.navigate` 要交给内核一个 entryId。消息落盘时
 * (message_end / 重放)把两者记在一起,navigate 据此翻译。
 */

import type { AssistantMessageEvent, ImageContent, TextContent, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai"
import { bashExecutionToText } from "@earendil-works/pi-agent-core"
import type { AgentMessage, BranchSummaryEntry, CompactionEntry, CustomEntry } from "@earendil-works/pi-agent-core"

import type { KernelEvent } from "../protocol.ts"
import { sortKeyOf } from "../ids.ts"
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
/** id 只写时间戳的低 48 位(与 opencode 的 6 字节一致),所以排序键也必须在这个空间里比。 */
const KEY_MASK = (1n << 48n) - 1n
/**
 * 工具结果附件的 part 下标号段。不挪开的话 `index * 100 + i + 1` 会撞上同一条消息里
 * 下一个 content block 的 part id(工具在 0、文本在 1,附件也算出 1)—— 前端按 part id
 * 去重,撞了就是少画一块,而且不报错。
 */
const ATTACHMENT_INDEX_BASE = 1_000_000
/** 手动压缩的事实载体:CompactionEntry 自己没有"为什么压缩"这个字段。见 session-manager 的 compact()。 */
export const MANUAL_COMPACTION_ENTRY = "yoma/compaction"

type AssistantBody = Extract<AgentMessage, { role: "assistant" }>
type UserBody = Extract<AgentMessage, { role: "user" }>
type ToolResultBody = Extract<AgentMessage, { role: "toolResult" }>

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

function costAndTokens(usage: Usage | undefined): { cost: number; tokens: Tokens } {
  return {
    cost: usage?.cost?.total ?? 0,
    tokens: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      reasoning: usage?.reasoning ?? 0,
      cache: { read: usage?.cacheRead ?? 0, write: usage?.cacheWrite ?? 0 },
    },
  }
}

/** 内核的 content block 里,哪些下标算"可见 part"。工具调用也占一个下标。 */
type AssistantBlock = TextContent | ThinkingContent | ToolCall

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
  /**
   * entryId → 上一份投影给这条 entry 铸过的 messageID。
   *
   * navigate 砍掉一条分支后必须重建投影。不沿用这些 id 的话,**活下来的消息也会换 id**
   * (live 复用过 renderer 的乐观 id,重放是按序号铸的,两条路的时钟对不上)——
   * 前端按 id 维护集合,于是整条 transcript 会先被判定成"全删了"。
   */
  reuseIDs?: ReadonlyMap<string, string>
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
  /** 最近投影出来的那条消息的 id,绑定 entryId 用。 */
  private lastID = ""
  /** toolCallId → 它在哪条消息的哪个 part 上。跨消息,所以必须是会话级的。 */
  private readonly toolRefs = new Map<string, ToolRef>()
  /** messageID → 该消息当前的投影结果,供增量更新时取回。 */
  private readonly messages = new Map<string, { info: ViewMessage; parts: Part[] }>()
  /** messageID → 内核 entryId。 */
  private readonly entryIDs = new Map<string, string>()
  /** 反向:内核 entryId → messageID。自定义 entry 要按它找回自己指的那条消息。 */
  private readonly messageIDs = new Map<string, string>()
  /** 正在流式的 assistant 消息 id。 */
  private streamingID = ""
  /** 重建投影时沿用的 entryId → messageID。见 ProjectionOptions.reuseIDs。 */
  private readonly reuseIDs?: ReadonlyMap<string, string>

  constructor(options: ProjectionOptions) {
    this.sessionID = options.sessionID
    this.providerID = options.providerID ?? "unknown"
    this.modelID = options.modelID ?? "unknown"
    this.reuseIDs = options.reuseIDs
  }

  /** 当前完整快照,给 session.messages 分页接口用。 */
  snapshot(): Array<{ info: ViewMessage; parts: Part[] }> {
    return [...this.messages.values()]
  }

  setModel(providerID: string, modelID: string) {
    this.providerID = providerID
    this.modelID = modelID
  }

  /** 前端的 messageID → 内核 entryId。还在流式、没落盘的消息没有。 */
  entryIdOf(messageID: string): string | undefined {
    return this.entryIDs.get(messageID)
  }

  /** entryId → messageID 的全量映射,交给下一份投影沿用(见 ProjectionOptions.reuseIDs)。 */
  knownIDs(): ReadonlyMap<string, string> {
    return this.messageIDs
  }

  // -------------------------------------------------------------------------
  // id 铸造 —— 确定性,可排序
  // -------------------------------------------------------------------------

  private nextMessageID(timestamp: number): string {
    const candidate = (BigInt(Math.max(0, Math.trunc(timestamp))) << COUNTER_BITS) & KEY_MASK
    const key = candidate > this.lastKey ? candidate : this.lastKey + 1n
    this.lastKey = key
    const index = this.messageCount++
    return `msg_${hex12(key)}${base62(index, 14)}`
  }

  /**
   * 复用 renderer 乐观铸出的 id。
   *
   * 计数要走,**排序时钟也要跟上**:两个进程的同毫秒计数器互相看不见,renderer 铸的 id
   * 可能已经跑在 host 的时钟前面。不把 lastKey 顶上去,同一毫秒里铸出的 assistant 回复
   * 就会排在这条提问之前(前端按 id 字符串二分,错了不报错,只是顺序反了)。
   */
  private reuseID(id: string): void {
    this.messageCount++
    // id 是 renderer 给的,不保证是那套 26 位格式 —— 解不出排序键就只当计数,
    // 绝不能在这里抛(这是事件处理器里,抛了就变成 handler_error)。
    if (!/^msg_[0-9a-f]{12}/.test(id)) return
    const key = sortKeyOf(id)
    if (key > this.lastKey) this.lastKey = key
  }

  /** 铸一条消息的 id。有要沿用的就沿用(renderer 的乐观 id、或者重建投影时的旧 id)。 */
  private mintID(timestamp: number, given?: string): string {
    if (!given) return this.nextMessageID(timestamp)
    this.reuseID(given)
    return given
  }

  /** 这条 entry 上一份投影铸过的 id。 */
  private seededID(entryId: string | undefined): string | undefined {
    return entryId ? this.reuseIDs?.get(entryId) : undefined
  }

  /** messageID ↔ entryId 双向登记。navigate 要正向,自定义 entry 要反向。 */
  private bindEntry(messageID: string, entryId: string): void {
    this.entryIDs.set(messageID, entryId)
    this.messageIDs.set(entryId, messageID)
  }

  /**
   * part id 从所属消息的 id 派生 + 下标。
   * 这样同一条消息内按 content 下标排序,跨消息按消息 id 排序,而且完全确定。
   */
  private partID(messageID: string, index: number): string {
    return `prt_${messageID.slice(4, 16)}${base62(index, 6)}`
  }

  // -------------------------------------------------------------------------
  // 主入口:投影一条消息
  // -------------------------------------------------------------------------

  /**
   * 投影一条**已落盘**的消息(message_end 或重放),返回要发给前端的事件。
   *
   * assistant 走 finalize:流式那一条已经铸过 id,再铸一个就是 transcript 上多一条重复
   * 回复;没流式过(非流式 provider、重放)时 finalize 退化成新建,两条路都安全。
   *
   * **发射顺序是硬约束**:父 message.updated 一定排在它的任何 part 事件之前 ——
   * 前端 reducer 会静默丢弃孤儿 part(server-session.ts:771-779),不报错。
   */
  applyMessage(message: AgentMessage, options?: { entryId?: string; messageID?: string }): KernelEvent[] {
    if (message.role === "toolResult") return this.applyToolResult(message)
    // 每条路自己认领 lastID;先清掉,免得"这条没投影出消息"时 entryId 绑到上一条身上。
    this.lastID = ""
    // renderer 的乐观 id 优先,其次是重建投影时这条 entry 上一次的 id。
    const given = options?.messageID ?? this.seededID(options?.entryId)
    const events =
      message.role === "assistant"
        ? this.finalizeAssistant(message, given)
        : message.role === "user"
          ? this.applyUser(message, given)
          : this.applySynthetic(message, given)
    if (options?.entryId && this.lastID) this.bindEntry(this.lastID, options.entryId)
    return events
  }

  /** message_start:开一条流式 assistant 消息。 */
  startAssistant(message: AssistantBody, givenID?: string): KernelEvent[] {
    const id = this.mintID(message.timestamp, givenID)
    this.streamingID = id
    this.lastID = id

    const info = this.assistantInfo(id, message)
    const parts = this.assistantParts(id, message.content as AssistantBlock[])

    this.messages.set(id, { info, parts })
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  /**
   * 压缩 / 分支摘要 entry。
   *
   * 前端的 Message 只有 user|assistant,所以合成一条 synthetic assistant 消息装它:
   * 一条 CompactionPart(只画分隔线)+ 一条文本 part 装摘要正文。不投影的话,压缩出来的
   * 内容就彻底看不见了。
   *
   * **压缩一律先当自动**:CompactionEntry 没有记"为什么压缩",而 live 与重放必须逐字节
   * 一致,所以这里不收"是谁触发的"这种只有 live 才知道的参数。手动由 applyCustomEntry
   * 按落盘的 yoma/compaction entry 翻过来,两条路因此同源。
   */
  applySummary(entry: CompactionEntry | BranchSummaryEntry): KernelEvent[] {
    const timestamp = Number(entry.timestamp) || Date.now()
    const id = this.mintID(timestamp, this.seededID(entry.id))
    this.lastID = id

    const info: ViewAssistant = {
      id,
      sessionID: this.sessionID,
      role: "assistant",
      parentID: this.turnParentID,
      time: { created: timestamp, completed: timestamp },
      providerID: this.providerID,
      modelID: this.modelID,
      // 摘要请求自己花的钱记在这条合成消息上,账本才不漏。
      ...costAndTokens(entry.usage),
      synthetic: true,
    }

    const parts: Part[] = [
      {
        id: this.partID(id, 0),
        sessionID: this.sessionID,
        messageID: id,
        type: "compaction",
        auto: entry.type === "compaction",
        branch: entry.type === "branch_summary",
      },
    ]
    // 摘要正文单独给一个 text part —— CompactionPart 只画一条分隔线。
    if (entry.summary) parts.push({ ...this.textPart(id, 1, entry.summary), synthetic: true })

    this.messages.set(id, { info, parts })
    this.bindEntry(id, entry.id)
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  /**
   * 自定义 entry。现在只认一种:`yoma/compaction` 指着某条压缩 entry 说"这是人手动按的"。
   *
   * live(entry_added)与重放都走这里,所以同一段历史两条路得到的 auto 一定相同 ——
   * 这正是以前 live 传 auto:false、重放什么都不传导致同一个 part 两副面孔的那个洞。
   */
  applyCustomEntry(entry: CustomEntry): KernelEvent[] {
    if (entry.customType !== MANUAL_COMPACTION_ENTRY) return []
    const data = entry.data as { compactionEntryId?: string; manual?: boolean } | undefined
    if (data?.manual !== true || !data.compactionEntryId) return []
    const messageID = this.messageIDs.get(data.compactionEntryId)
    const part = messageID ? this.messages.get(messageID)?.parts[0] : undefined
    if (!part || part.type !== "compaction" || !part.auto) return []
    part.auto = false
    return [partEvent(part)]
  }

  // -------------------------------------------------------------------------

  private applyUser(message: UserBody, givenID?: string): KernelEvent[] {
    // renderer 乐观插入时已经铸过 id,必须复用,否则同一条消息会渲染两遍。
    const id = this.mintID(message.timestamp, givenID)
    this.turnParentID = id
    this.lastID = id

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

  /**
   * 旧格式(v3)会话里才有的自定义消息角色。
   *
   * 内核把 v3 的 `custom_message` 规范化成 role:"custom" 的消息,旧会话的历史里因此还躺着
   * 它们(新会话不再产出)。不投影的话这些内容会在重放时静默消失。
   *
   * 摘要消息(compactionSummary / branchSummary)只出现在"喂给模型的上下文"里,从不落
   * entry —— transcript 上与它们对应的是 compaction / branch_summary entry,见 applySummary。
   */
  private applySynthetic(
    message: Exclude<AgentMessage, UserBody | AssistantBody | ToolResultBody>,
    givenID?: string,
  ): KernelEvent[] {
    if (message.role === "compactionSummary" || message.role === "branchSummary") return []
    // custom 消息带 display 开关 —— 内核明说不给人看的,就别渲染。
    if (message.role === "custom" && message.display === false) return []

    const timestamp = Number(message.timestamp) || Date.now()
    const id = this.mintID(timestamp, givenID)
    this.lastID = id

    const info: ViewAssistant = {
      id,
      sessionID: this.sessionID,
      role: "assistant",
      parentID: this.turnParentID,
      time: { created: timestamp, completed: timestamp },
      providerID: this.providerID,
      modelID: this.modelID,
      ...costAndTokens(undefined),
      synthetic: true,
    }

    const parts: Part[] = []
    if (message.role === "bashExecution") {
      // 用内核自己的渲染函数,别重写 —— 它处理了 cancelled / exitCode / truncated 三种尾注。
      parts.push({ ...this.textPart(id, 0, bashExecutionToText(message)), synthetic: true })
    } else {
      const content = message.content
      if (typeof content === "string") {
        if (content) parts.push({ ...this.textPart(id, 0, content), synthetic: true })
      } else {
        content.forEach((block, index) => {
          if (block.type === "text") parts.push({ ...this.textPart(id, index, block.text), synthetic: true })
          else if (block.type === "image") parts.push(this.filePart(id, index, block))
        })
      }
    }

    if (!parts.length) {
      this.lastID = ""
      return []
    }
    this.messages.set(id, { info, parts })
    return [{ type: "message.updated", message: info }, ...parts.map(partEvent)]
  }

  /**
   * 工具结果回填。
   *
   * 内核把它作为独立消息发出,但前端要的是把它折进 assistant 那条 ToolPart 的 state。
   * 找不到对应的 ToolPart 就丢弃 —— 那只可能是流式乱序或历史损坏,凭空造一个 part
   * 只会让 transcript 出现无主的工具卡片。
   */
  private applyToolResult(message: ToolResultBody): KernelEvent[] {
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

    const attachments = images.map((image, i) =>
      this.filePart(ref.messageID, ATTACHMENT_INDEX_BASE + ref.index * 1000 + i, image),
    )

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
  applyStreamEvent(event: AssistantMessageEvent, partial: AssistantBody): KernelEvent[] {
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
      // done / error 不会到这里:内核只把 start 与 start/done/error 之外的事件转成
      // message_update(agent/harness/execution/assistant.ts 的 isUpdateEvent),收尾一律走
      // message_end。想改这里前先看那个判定。
      default:
        return []
    }
  }

  // -------------------------------------------------------------------------
  // 构件
  // -------------------------------------------------------------------------

  private assistantInfo(id: string, message: AssistantBody): ViewAssistant {
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
      ...costAndTokens(usage),
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
   * 必须和 startAssistant 分开:message_end 到达时那条消息 **已经有 id 了**,再走
   * startAssistant 会铸一个新 id,transcript 上就多出一条重复回复。
   */
  private finalizeAssistant(message: AssistantBody, givenID?: string): KernelEvent[] {
    const id = this.streamingID
    const entry = id ? this.messages.get(id) : undefined
    // 没流式过(非流式 provider、重放)就新建;建完立刻清掉流式标记,否则紧跟着的
    // 下一条 assistant 消息会被"收尾"到这一条上,transcript 里就少一条回复。
    if (!id || !entry) {
      const events = this.startAssistant(message, givenID)
      this.streamingID = ""
      return events
    }

    this.lastID = id
    entry.info = this.assistantInfo(id, message)
    entry.parts = this.assistantParts(id, message.content as AssistantBlock[])
    this.streamingID = ""
    return [{ type: "message.updated", message: entry.info }, ...entry.parts.map(partEvent)]
  }

  // -------------------------------------------------------------------------
  // 工具执行事件(来自 lane,而不是消息)
  // -------------------------------------------------------------------------

  /** tool_start:pending → running。start 时间以这里为准,比消息时间戳准。 */
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

/**
 * 两次投影之间消失的消息与 part。
 *
 * navigate 砍掉一条分支后必须把它们报出去:前端的消息集合是**只增的**(按 id 二分维护),
 * 不发 removed 就只是 session.updated,而 renderer 不会因此重拉 —— 被抛下那半条
 * transcript 会一直留在屏幕上,用户以为自己还在那条分支里。
 */
export function removalEvents(
  sessionID: string,
  before: Array<{ info: ViewMessage; parts: Part[] }>,
  after: Array<{ info: ViewMessage; parts: Part[] }>,
): KernelEvent[] {
  const survivors = new Map(after.map((item) => [item.info.id, item]))
  const events: KernelEvent[] = []
  for (const item of before) {
    const next = survivors.get(item.info.id)
    if (!next) {
      events.push({ type: "message.removed", sessionID, messageID: item.info.id })
      continue
    }
    const kept = new Set(next.parts.map((part) => part.id))
    for (const part of item.parts) {
      if (!kept.has(part.id))
        events.push({ type: "message.part.removed", sessionID, messageID: item.info.id, partID: part.id })
    }
  }
  return events
}

function mergeInput(state: ToolState, args: unknown): ToolState {
  if (state.status !== "pending") return state
  return { ...state, input: (args ?? {}) as Record<string, unknown> }
}

function asDetails(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" ? (details as Record<string, unknown>) : {}
}

/**
 * 内核对 provider 失败 **永不抛异常** —— 它自己重试耗尽之后,失败是一条
 * stopReason:"error" 的 assistant 消息。不把它投影成 error,UI 上就是一个空白轮次,
 * 用户完全不知道发生了什么。
 */
function errorOf(message: AssistantBody): MessageError | undefined {
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
