import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { AssistantMessage, ModelRetry, Part, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import { groupParts, groupRefs, isProcessFoldable, PartGroup, renderable } from "@yoma-desktop/session-ui/message-part"
import { isFileChange } from "@yoma-desktop/session-ui/turn-changes"
import { Data, Equal } from "effect"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    /** 这一行在一段点开了的「处理详情」里(值是那一段的 key):画左边那根竖线。 */
    process?: string
  }
  /** 「处理详情」那一行:一轮跑完以后,连着的可折叠 part 收成一段(见 `Timeline.constructMessageRows`)。 */
  ProcessGroup: {
    userMessageID: string
    /** `process:<第一个 part 的 messageID>:<partID>`;开合状态按它记在时间线的 toolOpen 里。 */
    key: string
    /** 这一段的组(「已探索」组照旧是一组):计数、会话内查找都从这里拿。 */
    groups: PartGroup[]
    open: boolean
    previousAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Compacting: { userMessageID: string }
  TurnChanges: { userMessageID: string; refs: TurnChangeRef[] }
  ModelRequest: {
    userMessageID: string
    state: "retrying" | "recovered" | "failed"
    providerID: string
    text: string
    attempt?: number
    maxAttempts?: number
  }
}

/** 指向一次 edit / write。行里只放指针:patch 和文件内容留在 store 里,行画出来时才去读、去解析。 */
export type TurnChangeRef = { messageID: string; partID: string }

type AssistantPartRef = { messageID: string; messageIndex: number; part: Part }

/** 一轮 assistant 那一侧摊成的条目:一个组(可能在一段点开的「处理详情」里)、打断分隔线,或「处理详情」那一行。 */
type AssistantItem =
  | { type: "part"; group: PartGroup; process?: string }
  | { type: "interrupted" }
  | { type: "process"; key: string; groups: PartGroup[]; open: boolean }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<TimelineRowMap["AssistantPart"]> {}
  export class ProcessGroup extends Data.TaggedClass("ProcessGroup")<TimelineRowMap["ProcessGroup"]> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
  }> {}
  /** 正在压缩上下文。压完内核补一条 compaction part,那是「会话已压缩」的分隔线;这一行只管压的那一段时间。 */
  export class Compacting extends Data.TaggedClass("Compacting")<{
    userMessageID: string
  }> {}
  /** 这一轮里 edit / write 改了哪些文件(turn-changes.ts)。轮次跑完才出,跑着的时候看逐张工具卡。 */
  export class TurnChanges extends Data.TaggedClass("TurnChanges")<{
    userMessageID: string
    refs: TurnChangeRef[]
  }> {}
  export class ModelRequest extends Data.TaggedClass("ModelRequest")<TimelineRowMap["ModelRequest"]> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | ProcessGroup
    | Thinking
    | Compacting
    | TurnChanges
    | ModelRequest

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "ProcessGroup":
        return `process-group:${row.userMessageID}:${row.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "Compacting":
        return `compacting:${row.userMessageID}`
      case "TurnChanges":
        return `turn-changes:${row.userMessageID}`
      case "ModelRequest":
        return `model-request:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}

export namespace Timeline {
  /**
   * 行的结构要从 part 上读的两样东西。缺省直接读 part;投影层换成按 part 记忆过的版本
   * (`projection.ts`)—— 直接读 `part.text` 的话,每一批流式增量都会把这一轮的行整个重建一遍。
   */
  export type PartReader = {
    renderable(part: Part, showReasoning: boolean): boolean
    reasoningHeading(part: Part): string | undefined
  }

  export const directPartReader: PartReader = {
    renderable,
    reasoningHeading: (part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined),
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    retry?: ModelRetry,
    read: PartReader = directPartReader,
    /** 「处理详情」各段的开合(按段的 key);缺省收着。时间线把它接到自己的 toolOpen 上。 */
    processOpen: (key: string) => boolean | undefined = () => undefined,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const errorIndex = assistantMessages.findLastIndex(
      (m) => !m.synthetic && m.error && m.error.name !== "MessageAbortedError",
    )
    const failed = assistantMessages[errorIndex]
    const recovered =
      errorIndex !== -1 &&
      assistantMessages
        .slice(errorIndex + 1)
        .some((m) => !m.synthetic && !m.error && typeof m.time.completed === "number")
    const cancelled =
      errorIndex !== -1 && assistantMessages.slice(errorIndex + 1).some((m) => m.error?.name === "MessageAbortedError")
    const activeRetry = isActive && status === "busy" ? retry : undefined
    const terminalError = failed?.error && !recovered && !cancelled && (!isActive || status === "idle")

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => read.renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const settled = !isActive || status === "idle"
    // 报错收场、被打断的轮次不折:出了什么事都该摆在眼前。
    const folded =
      settled && !interrupted && !terminalError
        ? foldProcess(assistantMessages, assistantPartRefs, processOpen)
        : undefined
    const assistantItems: AssistantItem[] = folded
      ? folded
      : interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    let assistantGroupIndex = 0
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      if (item.type === "process") {
        rows.push(
          new TimelineRow.ProcessGroup({
            userMessageID: userMessage.id,
            key: item.key,
            groups: item.groups,
            open: item.open,
            previousAssistantPart: assistantGroupIndex > 0,
          }),
        )
        assistantGroupIndex += 1
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          ...(item.process ? { process: item.process } : {}),
        }),
      )
      assistantGroupIndex += 1
    })

    // 这一轮在跑就有这一行;它此刻说什么(思考中 / 正在运行 … / 等待模型 / 不出字)由组件按 activity.ts 现算 ——
    // 那要读工具状态,不能进行的 memo(规矩 1)。从前「显示思考」打开时第一段内容出来就收掉,跑工具时什么都看不到。
    if (isActive && status === "busy" && !activeRetry) {
      // 「思考中」后面跟的标题取最近那段思考的:这一行只在模型正在出思考时说「思考中」,说的就是正在出的那一段。
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => read.reasoningHeading(part))
        .findLast((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    // 压缩(手动 /compact,或一轮里撞到阈值 / 溢出)要让模型写一段摘要,几秒到几十秒。这段时间状态是
    // compacting 而不是 busy,上面那行「思考中」不出 —— 不补这一行的话,屏幕上什么都不动,像卡死了。
    if (isActive && status === "compacting") rows.push(new TimelineRow.Compacting({ userMessageID: userMessage.id }))

    // 每轮的改动汇总。opencode 的这一行读 UserMessage.summary.diffs(文件快照的产物),内核没有快照,
    // 这里从 edit / write 的工具结果合成。只在这一轮不再跑的时候出:跑着的时候 part 的状态一直在变,
    // 在行的 memo 里读它们等于每一步都重建这一轮的行;被打断、失败的轮次照样出 —— 文件确实改了。
    if (!isActive || status === "idle") {
      const refs = assistantMessages.flatMap((message) =>
        getMessageParts(message.id)
          .filter(isFileChange)
          .map((part) => ({ messageID: message.id, partID: part.id })),
      )
      if (refs.length > 0) rows.push(new TimelineRow.TurnChanges({ userMessageID: userMessage.id, refs }))
    }

    // Replayed history contains the failed attempts too. A later completed model response
    // proves recovery; merely starting a stream (or executing a tool) does not.
    if (activeRetry || recovered || terminalError) {
      const data = activeRetry?.error ?? failed?.error?.data.message
      rows.push(
        new TimelineRow.ModelRequest({
          userMessageID: userMessage.id,
          state: activeRetry ? "retrying" : recovered ? "recovered" : "failed",
          providerID: activeRetry?.providerID ?? failed?.providerID ?? "unknown",
          ...(activeRetry ? { attempt: activeRetry.attempt, maxAttempts: activeRetry.maxAttempts } : {}),
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  /**
   * 跑完的一轮切成「过程」与「最终回答」,过程里连着的可折叠 part 收成「处理详情」(照 pi-agent-desktop)。
   * 报错收场与被打断的轮次调用方就不送进来(平铺)。
   *
   * - **最终回答**:最后一条有可画 part 的非 synthetic assistant 消息里,排在它最后一个非文字 part 之后的那几段文字
   *   (pi-agent-desktop 的 `splitFinalAssistantBlocks`)。这条消息报了错就不折(返回 undefined)。
   * - **没有最终回答也折**(这一轮以工具调用收尾):多半是后台子 agent 的完成通知或排队的用户消息在工具边界插了进来、
   *   另起了一轮,回答在后面那一轮里。整段收起,外面没有回答。审查抓到的:只认有回答的轮次时,默认开着后台子 agent
   *   与排队的长任务前半截永远不收。
   * - **分段**:过程照旧先过 `groupParts`(「已探索」组照旧),连着的可折叠组合成一段;有专用卡的工具(硬件五件、
   *   子 agent)与 synthetic 消息(压缩摘要)里的 part 把段切开,自己原样留在原位 —— 用户定的「硬件卡不动」。
   * - 一段**至少有一次工具调用**才折;只有说明 / 思考的原样平铺(比如烧录卡前面那句「我先烧一下」)。
   * - 段的 key 取段里第一个不是思考的 part(同「已探索」组取第一个):开关「显示思考」不改 key,开合状态不丢。
   *   开着时段里的组照旧出行,带上 `process`。
   *
   * 只看结构:part 的类型、工具名、消息的 synthetic / error(文字空不空已经由 PartReader 记成按 part 的 memo)。
   * 不读正文、不读工具状态 —— 时间线规矩 1。
   */
  function foldProcess(
    messages: AssistantMessage[],
    refs: AssistantPartRef[],
    processOpen: (key: string) => boolean | undefined,
  ): AssistantItem[] | undefined {
    const final = messages.findLastIndex(
      (message, index) => !message.synthetic && refs.some((ref) => ref.messageIndex === index),
    )
    if (final === -1 || messages[final]!.error) return
    const own = refs.filter((ref) => ref.messageIndex === final)
    const answer = own.slice(own.findLastIndex((ref) => ref.part.type !== "text") + 1)
    const end = refs.indexOf(own.at(-1)!) + 1
    const process = refs.slice(0, end - answer.length)
    // 回答之后还有的(罕见:synthetic 的压缩摘要落在了回答后面)照旧平铺在回答后面。
    const tail = refs.slice(end)

    const byPart = new Map(refs.map((ref) => [ref.part.id, ref] as const))
    const foldable = (group: PartGroup) => {
      if (group.type === "context") return true
      const ref = byPart.get(group.ref.partID)
      return !!ref && !messages[ref.messageIndex]!.synthetic && isProcessFoldable(ref.part)
    }
    const hasTool = (group: PartGroup) =>
      group.type === "context" || byPart.get(group.ref.partID)?.part.type === "tool"

    const items: AssistantItem[] = []
    let run: PartGroup[] = []
    const flush = () => {
      if (run.length === 0) return
      if (run.some(hasTool)) {
        const refsInRun = run.flatMap(groupRefs)
        const first = refsInRun.find((ref) => byPart.get(ref.partID)?.part.type !== "reasoning") ?? refsInRun[0]!
        const key = `process:${first.messageID}:${first.partID}`
        const open = processOpen(key) ?? false
        items.push({ type: "process", key, groups: run, open })
        if (open) for (const group of run) items.push({ type: "part", group, process: key })
      } else {
        for (const group of run) items.push({ type: "part", group })
      }
      run = []
    }
    for (const group of groupParts(process)) {
      if (foldable(group)) {
        run.push(group)
        continue
      }
      flush()
      items.push({ type: "part", group })
    }
    flush()
    for (const group of groupParts(answer)) items.push({ type: "part", group })
    for (const group of groupParts(tail)) items.push({ type: "part", group })
    return items
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
