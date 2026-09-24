import type { AssistantMessage, Part, SessionActivity, ToolPart } from "@yoma-desktop/kernel"

/**
 * 正在跑的那一轮底下那一行此刻说什么(参照 pi-agent-desktop 的 `phaseLabel`)。
 *
 * - `thinking`:模型正在往外发思考内容。只有这时才说「思考中」。
 * - `tools`:有工具在跑,列出工具名(去重、按出现顺序)。
 * - `waiting`:还没有回复、回复还一个 part 都没有,或者这一批工具都已收尾、下一次请求还没出字。
 * - `confirm`:工具在等用户点确认条(只有内核说得出来,见下)。
 * - `undefined`:模型在写正文、在写工具调用的参数 —— 正文、闪着的工具行自己就说明了,这一行不出字。
 *
 * 从前这一行在会话忙的时候一直写着「思考中」,跑工具时也是(用户 2026-09-24 试用时指出)。
 *
 * 两个来源:内核在 busy 状态里带的 `activity`(`kernelActivity`,docs/调试留痕-规划-20260924.md §2.2)优先 —— 它带着这个阶段
 * 从什么时候开始(`since`),这一行才能走表,"卡住了还是在想"要靠这个数分;没有时(过渡的一瞬)按这一轮的 part 推断
 * (`turnActivity`),不走表。
 */
export type TurnActivity =
  | { kind: "thinking"; since?: number }
  | { kind: "tools"; names: string[]; since?: number }
  | { kind: "waiting"; since?: number }
  | { kind: "confirm"; tool: string; since?: number }

/** synthetic 的回复(压缩摘要)不算:它不是模型这一轮在干的活。 */
export function turnActivity(
  messages: readonly AssistantMessage[],
  partsOf: (messageID: string) => readonly Part[],
): TurnActivity | undefined {
  const last = messages.findLast((message) => !message.synthetic)
  if (!last) return { kind: "waiting" }
  const parts = partsOf(last.id)
  const tools = parts.filter((part): part is ToolPart => part.type === "tool")
  const running = tools.filter((part) => part.state.status === "running")
  if (running.length > 0) return { kind: "tools", names: [...new Set(running.map((part) => part.tool))] }
  const tail = parts.at(-1)
  if (!tail) return { kind: "waiting" }
  if (tail.type === "reasoning") return { kind: "thinking" }
  if (tail.type !== "tool") return
  // 最后一个 part 是工具调用:都收尾了就是在等下一次请求;还有 pending 的是参数还在写,或者在等开跑(确认条)。
  return tools.every((part) => part.state.status === "completed" || part.state.status === "error")
    ? { kind: "waiting" }
    : undefined
}

/**
 * 内核说的阶段 → 这一行。写正文、写工具调用参数不出字(同 `turnActivity`);等确认要说一句 —— 确认条在输入框上方,
 * 这一行在对话底部,用户盯着对话看时两处隔着一屏。
 */
export function kernelActivity(activity: SessionActivity): TurnActivity | undefined {
  switch (activity.phase) {
    case "waiting":
      return { kind: "waiting", since: activity.since }
    case "thinking":
      return { kind: "thinking", since: activity.since }
    case "tools":
      return { kind: "tools", names: [...new Set(activity.tools)], since: activity.since }
    case "confirm":
      return { kind: "confirm", tool: activity.tool, since: activity.since }
    case "writing":
    case "calling":
      return undefined
  }
}

/** 已过时长,一秒一跳:`45 s`、`2 min 05 s`(与子 agent 坞的计时同一个写法)。时钟回拨按 0 算。 */
export function formatActivityElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

/** 推理字数:`812`、`4.1k`、`39k`。它是"还在动"的证据,不是精确读数。 */
export function formatChars(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 10_000) return `${(Math.floor(count / 100) / 10).toFixed(1)}k`
  return `${Math.floor(count / 1_000)}k`
}
