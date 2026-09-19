/**
 * 子 agent 的定义(CC 的 AgentDefinition,docs/子agent-设计方案-v0.4-20260918.md §4.1)。
 *
 * 字段名照 CC 的 frontmatter(name / description / tools / disallowedTools / model / maxTurns / background /
 * skills / initialPrompt / color),模型对这套名字有先验;`thinking` 是 yoma 的扩展(CC 的普通子 agent
 * 一律关思考,另有 effort 可调)。`omitContextFiles` 与 `oneShot` 只给内建 agent 用,md 里不开放。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core"

export type AgentSource = "built-in" | "user" | "project"

export interface AgentProfile {
  /** CC 的 agentType;`subagent_type` 的取值。 */
  name: string
  /** CC 的 whenToUse;拼进 agent 工具的描述,主 agent 靠它挑人。 */
  description: string
  /** md 正文 = 子 agent 系统提示词的正文。 */
  prompt: string
  /** 白名单;undefined 或 ["*"] = 全集(过完硬黑名单与硬件层)。 */
  tools?: string[]
  /** 黑名单,优先于白名单。 */
  disallowedTools?: string[]
  /** "inherit"(缺省)或 "<provider>/<modelId>"。 */
  model?: string
  /** 缺省 "off"(CC:普通子 agent 关思考,runAgent.ts:681-684)。 */
  thinkingLevel?: ThinkingLevel
  maxTurns?: number
  /** true = 每次派生都后台。 */
  background?: boolean
  /** CC 的 omitClaudeMd:不灌项目上下文文件。只给内建 agent 用。 */
  omitContextFiles?: boolean
  /** 首轮之前预加载的技能名。 */
  skills?: string[]
  /** 拼在首轮 user 消息之前。 */
  initialPrompt?: string
  /** CC 的 ONE_SHOT_BUILTIN_AGENT_TYPES:不会被 send_message 续跑,结果省掉 agentId + usage 尾巴。只给内建 agent 用。 */
  oneShot?: boolean
  color?: string
  source: AgentSource
  /** 来自 md 文件时是那个文件的绝对路径。 */
  filePath?: string
}

/** 加载 agent 定义时的问题:一个字段写错只忽略那个字段,不拒载整个 agent(CC loadAgentsDir 同款)。 */
export interface AgentDiagnostic {
  path: string
  message: string
}
