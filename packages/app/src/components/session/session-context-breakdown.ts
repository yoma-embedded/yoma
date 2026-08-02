/**
 * 上下文用量的粗略拆分。
 *
 * 原来有 system 一段(来自 opencode 下发的 `UserMessage.system`)。内核不下发系统提示词 ——
 * 它是 host 侧拼的,不进 transcript —— 所以这一段整个删掉,剩下的差额都归到 other。
 */

import type { Message, Part } from "@yoma-desktop/kernel"

export type SessionContextBreakdownKey = "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

/**
 * 用户消息里只有 text 计入字符数。
 *
 * opencode 的 file / agent part 带 `source.text`(提及在原文里的那段字面量),内核的
 * FilePart 只有 `{ mime, url, filename }` —— 附件本身的 token 由 provider 计,前端估不出来,
 * 所以按 0 算而不是瞎猜一个数。
 */
const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return part.text.length
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: part.text.length, tool: 0 }
  if (part.type === "reasoning") return { assistant: part.text.length, tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  // pending 的 raw 是流式拼到一半的参数 JSON,可能还没开始拼。
  if (part.state.status === "pending") return { assistant: 0, tool: input + (part.state.raw?.length ?? 0) }
  if (part.state.status === "completed") return { assistant: 0, tool: input + part.state.output.length }
  if (part.state.status === "error") return { assistant: 0, tool: input + part.state.error.length }
  return { assistant: 0, tool: input }
}

const build = (tokens: { user: number; assistant: number; tool: number; other: number }, input: number) => {
  return [
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const user = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        return { ...acc, user: acc.user + user }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.user + scaled.assistant + scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
