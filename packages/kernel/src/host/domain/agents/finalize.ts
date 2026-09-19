/**
 * 从子 agent 的消息里取结果(CC `agentToolUtils.ts` 的 finalizeAgentTool / extractPartialResult)。
 *
 * 取最后一条 assistant 的文字;它若是纯工具调用(运行在工具那一步收场,比如命中 maxTurns),往前找最近一条带文字的。
 * 都没有就交 undefined,由调用方换成占位句 —— CC 的注释:只剩 agentId / usage 尾巴时,有的模型把它读成
 * "没什么可做的"而直接结束这一轮。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core"

export const EMPTY_RESULT_MARKER = "(Subagent completed but returned no output.)"

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return ""
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
}

/** 最后一段有文字的 assistant 回复;完成与被停(部分结果)同一个算法。 */
export function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = assistantText(messages[index]!)
    if (text) return text
  }
  return undefined
}
