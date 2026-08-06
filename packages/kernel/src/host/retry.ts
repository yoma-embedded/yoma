/**
 * 轮级自动重试策略。
 *
 * 内核把 provider 失败当**数据**:请求挂了不抛异常,而是变成一条
 * `stopReason: "error"` 的 assistant 消息进 transcript。于是"要不要再试一次"是
 * 应用层的决定 —— 和自动压缩同构(见 compaction.ts),harness 只提供
 * `retryLastTurn()` 这个机制。
 *
 * my-pi 的 ACP 适配器有自己的一份(`acp/agent.ts` 的 shouldAutoRetry),我们不 import
 * 它:那个文件会把整个 ACP 适配器和 `@agentclientprotocol/sdk` 拖进 bundle。这里是
 * **同一套参数的第二份实现**,数值故意抄一致(3 次 / 2s 起指数退避)—— 两边行为分叉
 * 会变成"Zed 里能自愈、桌面端不能"这种极难归因的差异。
 *
 * ## 不重试的三种情况
 *
 * 1. 次数用尽;
 * 2. **上下文溢出** —— 该压缩,重试同一个请求只会再溢出一次;
 * 3. `isRetryableAssistantError` 判定不可重试的(认证失败、参数错误、用户中止):
 *    重试只是把同一个错误再买一遍。
 *
 * ## 为什么重试期间状态必须保持 busy
 *
 * 失败的那一轮结束时 harness 照常发 `agent_end`,如果这时把会话置为 idle,
 * 2 秒退避窗口里就会出现一个"看起来跑完了"的会话 —— 桌面端 UI 闪一下无所谓,
 * 但 bench 会当真:它在 idle 静默后就去跑判据,而 agent 正要重试,两边同时动板子。
 * 所以 SessionManager 在决定要重试时**压住 idle 不发**,整段重试是一个连续的 busy。
 */

import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai"

export const RETRY_MAX_ATTEMPTS = 3
export const RETRY_BASE_DELAY_MS = 2000

/** 指数退避:2s / 4s / 8s。attempt 从 1 开始。 */
export function retryDelayMs(attempt: number, baseDelayMs: number = RETRY_BASE_DELAY_MS): number {
  return baseDelayMs * 2 ** (attempt - 1)
}

/**
 * 这条 assistant 消息该不该触发自动重试。
 *
 * @param attempt 已经重试过的次数(第一次判断时为 0)
 */
export function shouldAutoRetry(message: AssistantMessage, contextWindow: number | undefined, attempt: number): boolean {
  if (message.stopReason !== "error") return false
  if (attempt >= RETRY_MAX_ATTEMPTS) return false
  if (isContextOverflow(message, contextWindow)) return false
  return isRetryableAssistantError(message)
}

/** 可中断的退避等待:abort 时提前 resolve(不是 reject),调用方查 signal 决定去留。 */
export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    ;(timer as { unref?: () => void }).unref?.()
    signal?.addEventListener("abort", done, { once: true })
  })
}
