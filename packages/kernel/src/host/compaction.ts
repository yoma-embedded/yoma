/**
 * 自动压缩。
 *
 * yoma 的 **内核不做这件事** —— harness 只提供 compact(),什么时候压是应用层的事
 * (它自己的 ACP 适配器把这段放在 acp/agent.ts:150-176)。不做的后果:聊长了直接撞
 * 上下文窗口,除非用户自己想起来敲 /compact。
 *
 * 对这个产品尤其致命:datasheet 章节动辄上万字符、flash 与 gdb 的输出成片,
 * 一次硬件调试会话烧 token 的速度比普通编码对话快得多。
 *
 * 这里不 import yoma 的 acp/agent.ts —— 那会把整个 @agentclientprotocol/sdk 拖进
 * bundle,而我们根本不说 ACP。逻辑用内核导出的原语重实现,**两个 guard 一个都不能少**,
 * 它们各自对应一种会把会话压垮的失败模式。
 */

import { DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, shouldCompact, type AgentMessage } from "@yoma/agent"

export type CompactionReason = "no_usage" | "just_compacted" | "no_context_window" | "under_threshold" | "over_threshold"

export interface CompactionDecision {
  compact: boolean
  tokens: number
  reason: CompactionReason
}

export function shouldAutoCompact(
  messages: AgentMessage[],
  contextWindow: number | undefined,
  lastCompactionAtMs?: number,
): CompactionDecision {
  const estimate = estimateContextTokens(messages)

  // Guard 1:没有任何真实 usage 数据时不猜。纯字符估算会把一个还没跑过一轮的会话
  // 误判成"该压了",于是新会话一开口就先被压一次。
  if (estimate.lastUsageIndex === null) return { compact: false, tokens: estimate.tokens, reason: "no_usage" }

  // Guard 2:刚压缩完时,幸存下来的消息带的仍然是压缩 **前**(更大)那个上下文的 usage。
  // 信了它就会压完立刻又触发,一路压到没东西可压为止。
  if (lastCompactionAtMs !== undefined) {
    const usageMessage = messages[estimate.lastUsageIndex] as { role?: string; timestamp?: number } | undefined
    if (
      usageMessage?.role === "assistant" &&
      typeof usageMessage.timestamp === "number" &&
      usageMessage.timestamp <= lastCompactionAtMs
    ) {
      return { compact: false, tokens: estimate.tokens, reason: "just_compacted" }
    }
  }

  // 模型没报 contextWindow 就不压 —— 拿一个编出来的窗口去判阈值,只会在错误的时候压。
  // 单独一个 reason:报成 under_threshold 会让人以为"算过了,没到线",而其实压根没算。
  if (!contextWindow || contextWindow <= 0) {
    return { compact: false, tokens: estimate.tokens, reason: "no_context_window" }
  }

  return shouldCompact(estimate.tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)
    ? { compact: true, tokens: estimate.tokens, reason: "over_threshold" }
    : { compact: false, tokens: estimate.tokens, reason: "under_threshold" }
}
