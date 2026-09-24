import type { AssistantMessage, Part, ToolPart } from "@yoma-desktop/kernel"

/**
 * 正在跑的那一轮底下那一行此刻说什么(参照 pi-agent-desktop 的 `phaseLabel`)。
 *
 * - `thinking`:这一轮最新那条回复的最后一个 part 是思考段 —— 模型正在往外发思考内容。只有这时才说「思考中」。
 * - `tools`:有工具在跑,列出工具名(去重、按出现顺序)。
 * - `waiting`:还没有回复、回复还一个 part 都没有,或者这一批工具都已收尾、下一次请求还没出字。
 * - `undefined`:模型在写正文、在写工具调用的参数、工具在等确认(确认条)—— 正文、闪着的工具行、确认条自己就说明了,
 *   这一行不出字。
 *
 * 从前这一行在会话忙的时候一直写着「思考中」,跑工具时也是(用户 2026-09-24 试用时指出)。
 * synthetic 的回复(压缩摘要)不算:它不是模型这一轮在干的活。
 */
export type TurnActivity = { kind: "thinking" } | { kind: "tools"; names: string[] } | { kind: "waiting" }

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
