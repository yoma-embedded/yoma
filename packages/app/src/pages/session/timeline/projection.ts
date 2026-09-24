import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { Timeline, TimelineRow } from "./rows"

const emptyAssistantMessages: AssistantMessage[] = []

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  /**
   * 「处理详情」各段的开合(按段的 key,缺省收着)。每一轮的 memo 只订阅它自己那几段的键:开合一段只重建那一轮。
   */
  processOpen?: (key: string) => boolean | undefined
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  const activeMessageID = createMemo(() => {
    if (input.status().type === "idle") return
    // A session runs one turn at a time; queued drafts enter history only when sent.
    // Old toolUse responses have no time.completed, so they cannot identify the active turn.
    return input.messages().findLast((message) => message.role === "user")?.id
  })
  const modelRetry = createMemo(() => {
    const status = input.status()
    return status.type === "busy" ? status.retry : undefined
  })
  const messageRowMemos = createMemo(
    mapArray(input.userMessages, (userMessage, indexAccessor) => {
      const assistantMessages = () => assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages
      const isActive = createMemo(() => activeMessageID() === userMessage.id)
      const read = createPartReader(
        () => assistantMessages().flatMap((message) => input.parts(message.id).filter(isTextual)),
        isActive,
      )
      return createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
        reuseTimelineRows(
          previous,
          Timeline.constructMessageRows(
            userMessage,
            input.parts,
            assistantMessages(),
            indexAccessor(),
            input.showReasoningSummaries(),
            input.status().type,
            isActive(),
            modelRetry(),
            read,
            input.processOpen,
          ),
        ),
      )
    }),
  )
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(
      previous,
      messageRowMemos().flatMap((memo) => memo()),
    ),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  return {
    activeMessageID,
    assistantMessagesByParent,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}

type TextualPart = Extract<Part, { type: "text" | "reasoning" }>

const isTextual = (part: Part): part is TextualPart => part.type === "text" || part.type === "reasoning"

/**
 * 行的结构只取决于一段文本「空 / 非空」(思考行另看它的标题),不取决于它现在有多长。这两样各记成按 part 的
 * memo,行的 memo 订的是它们而不是 `part.text`:流式增量一批批地来,只有跨过空 → 非空、或标题变了的那一批
 * 才重建这一轮的行。part 对象照旧原样交给行,渲染时读到的仍是活的文本。
 */
function createPartReader(parts: Accessor<TextualPart[]>, isActive: Accessor<boolean>): Timeline.PartReader {
  const facts = mapArray(parts, (part) => ({
    part,
    visible: createMemo(() => !!part.text?.trim()),
    // 标题只有「思考中」那一行用,而那一行只出现在正在跑的这一轮;历史轮次不去扫正文。
    heading: createMemo(() => (isActive() ? Timeline.directPartReader.reasoningHeading(part) : undefined)),
  }))
  const byPart = createMemo(() => new Map(facts().map((fact) => [fact.part as Part, fact] as const)))
  return {
    renderable(part, showReasoning) {
      const fact = isTextual(part) ? byPart().get(part) : undefined
      if (!fact) return Timeline.directPartReader.renderable(part, showReasoning)
      return (part.type === "text" || showReasoning) && fact.visible()
    },
    reasoningHeading(part) {
      const fact = byPart().get(part)
      return fact ? fact.heading() : Timeline.directPartReader.reasoningHeading(part)
    },
  }
}

export function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const next = rows.map((row) => {
    const existing = byKey.get(TimelineRow.key(row))
    if (!existing) return row
    return TimelineRow.equals(existing, row) ? existing : row
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}
