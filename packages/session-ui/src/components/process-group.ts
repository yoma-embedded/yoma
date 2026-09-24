import type { Part } from "@yoma-desktop/kernel"

export type ProcessSummary = {
  /** 工具调用次数(「已探索」组里的每一次都算)。说明文字与思考段不算。 */
  tools: number
  /** 其中报错的。折叠着也要看得见:一次失败往往就是模型接下来走偏的原因(同「已探索」)。 */
  failed: number
  /**
   * 其中没有结果的(还停在 pending / running)。「处理详情」只出现在不再跑的轮次里,所以这些都不会再有结果了
   * (被停止、工具跑到一半 app 关了);逐张卡片上它们画成「未完成」,折叠着也得看得见。
   */
  unfinished: number
}

/** 「处理详情」那一行的计数。 */
export function processSummary(parts: readonly Part[]): ProcessSummary {
  let tools = 0
  let failed = 0
  let unfinished = 0
  for (const part of parts) {
    if (part.type !== "tool") continue
    tools += 1
    if (part.state.status === "error") failed += 1
    if (part.state.status === "pending" || part.state.status === "running") unfinished += 1
  }
  return { tools, failed, unfinished }
}
