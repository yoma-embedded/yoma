/**
 * fork:把一条 /btw 顺便问转成后台子 agent 时用的合成 agent(docs/btw顺便问-设计方案-20260924.md §4.6)。
 *
 * 照 CC 的 fork(2.1.88 `tools/AgentTool/forkSubagent.ts` 的 `FORK_AGENT` + 文档里 v2.1.206 起的规则):继承主会话的
 * 上下文、主会话此刻的系统提示词原字符串、同一份工具定义、同一个模型与思考档位,一律后台。它**不进
 * `BUILTIN_AGENTS`**:agent 工具的 `subagent_type` 选不到它,agent 列表里也不出现。
 *
 * yoma 的两条子 agent 规矩照留:不能再派子 agent(没有嵌套的任务树)、不能碰硬件工具(探针与采集设备是进程级独占的)。
 * 为了缓存,这两类工具的**定义照带**(少一个,fork 的第一次请求就和主会话的前缀对不上),调用时由 `forkBlockReason` 拦下。
 */

import type { AgentProfile } from "./profile.ts"
import { HARDWARE_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from "./select.ts"

export const FORK_AGENT_TYPE = "fork"

/** CC 的 `FORK_AGENT`:工具全给、模型继承、maxTurns 200、一律后台。系统提示词不用这里的 prompt,用主会话的原字符串。 */
export const FORK_PROFILE: AgentProfile = {
  name: FORK_AGENT_TYPE,
  description: "Forked from a /btw side question: inherits the main conversation and keeps working in the background.",
  prompt: "",
  tools: ["*"],
  model: "inherit",
  maxTurns: 200,
  background: true,
  source: "built-in",
}

const BLOCKED = new Set([...SUBAGENT_TOOL_NAMES, ...HARDWARE_TOOL_NAMES])

/** fork 调这个工具时回给模型的话;不拦就是 undefined。 */
export function forkBlockReason(toolName: string): string | undefined {
  if (!BLOCKED.has(toolName)) return undefined
  return SUBAGENT_TOOL_NAMES.includes(toolName)
    ? `A forked agent cannot start or manage sub-agents; ${toolName} is not available here. Do the work directly with your other tools.`
    : `A forked agent cannot use hardware tools; ${toolName} is not available here (the probe and capture devices belong to the main conversation). Report what needs to be run on the board instead.`
}
