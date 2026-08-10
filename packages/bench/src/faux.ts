/**
 * 假模型 —— 本机演练与打包冒烟的执行核心。
 *
 * 走的是 pi-ai 自带的 fauxProvider(turn.test.ts / kernel host.test.ts 同款):
 * 除了模型是预排好的响应队列,**其余全是真的** —— 真 harness、真工具
 * (write/read 会真动文件系统)、真会话落盘。所以一次 faux 演练验证的是整条装配,
 * 只省了钱和网络。
 *
 * 脚本是纯 JSON 数据(不是代码):TurnInput 要穿越子进程边界,守护配置要穿越
 * spawn 边界,两处都只能带数据。一个元素 = 一次 provider 响应;带 tool 的响应
 * 之后 harness 会真的执行该工具,再发起下一次请求(消费下一个元素)。
 * 队列耗尽时 pi-ai 会产出 stopReason:"error" 的轮 —— 演练脚本写短了不会挂死,
 * 会如实变成一轮可见的失败。
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai"

export type FauxPart = { text: string } | { tool: string; input: Record<string, unknown> }

/** 一次 provider 响应的内容(一条 assistant 消息的 parts)。 */
export type FauxMessage = FauxPart[]

/** 一段脚本 = 按请求次序消费的响应队列。 */
export type FauxScript = FauxMessage[]

type Resolved = { models: ReturnType<typeof createModels>; model: Model<string> }

/**
 * 把脚本变成 createKernelHost 的 resolveModels 注入。
 *
 * 队列状态在**工厂闭包**里:mother 侧同一个守护进程会为多次分析轮反复建 host,
 * 每次 resolveModels 都返回同一个注册表,脚本从而跨轮连续消费 —— 这正是
 * "第 1 轮裁 continue、第 2 轮不再被问"的演练形态。runner 侧一轮一个子进程,
 * 每个进程各拿各的脚本,天然隔离。
 */
export function fauxResolveModels(script: FauxScript): () => Promise<Resolved> {
  let cached: Resolved | undefined
  return async () => {
    if (!cached) {
      const models = createModels()
      const faux = fauxProvider({ provider: "faux-bench" })
      models.setProvider(faux.provider)
      faux.setResponses(
        script.map((message) =>
          fauxAssistantMessage(
            message.map((part) => ("text" in part ? fauxText(part.text) : fauxToolCall(part.tool, part.input))),
          ),
        ) as never,
      )
      cached = { models, model: faux.getModel() as Model<string> }
    }
    return cached
  }
}
