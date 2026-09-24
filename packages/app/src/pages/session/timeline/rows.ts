import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { AssistantMessage, ModelRetry, Part, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import { groupParts, PartGroup, renderable } from "@yoma-desktop/session-ui/message-part"
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
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }> {}
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
    const assistantItems =
      interrupted && !compaction
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

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
        }),
      )
      assistantGroupIndex += 1
    })

    if (isActive && status === "busy" && !activeRetry && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => read.reasoningHeading(part))
        .find((value): value is string => !!value)

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
