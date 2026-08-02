import type { UserMessage } from "@yoma-desktop/kernel"

/**
 * 只声明这里真正用到的那一小片 local context —— my-pi 的 UserMessage 上只有
 * sessionID + model（没有 agent、没有 variant），所以这层适配把消息收窄成
 * local.session.restore 需要的最小形状。
 */
type Local = {
  session: {
    reset(): void
    restore(msg: { sessionID: string; model: { providerID: string; modelID: string } }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  local.session.restore({ sessionID: msg.sessionID, model: msg.model })
}
