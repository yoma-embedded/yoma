/**
 * 上下文用量。
 *
 * provider 目录直接吃内核的 `ProviderInfo[]`(`models` 是数组,不是 opencode 的
 * `Record<id, Model>`),上下文上限从 `ModelInfo.contextWindow` 读 —— opencode 的
 * `model.limit.context` 没有了。模型不在目录里(比如凭据被移除)时 limit 为 undefined,
 * 用量退化成 null,UI 显示 "—"。
 */

import type { AssistantMessage, Message, ModelInfo, ProviderInfo, Session } from "@yoma-desktop/kernel"

type Context = {
  message: AssistantMessage
  provider?: ProviderInfo
  model?: ModelInfo
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  usage: number | null
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: ProviderInfo[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models.find((item) => item.id === message.modelID)
  const limit = model?.contextWindow
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: ProviderInfo[] = []) {
  return build(messages, providers)
}

export function getSessionTokenTotal(tokens: Session["tokens"] | undefined) {
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
