/**
 * agent 工具的契约:菜单那一半(docs/子agent-设计方案-v0.4-20260918.md §5.1)。
 *
 * 参数与描述照 CC 的 Agent 工具(`tools/AgentTool/AgentTool.tsx` 的 baseInputSchema、`prompt.ts`)。这里只放
 * 静态的那部分;描述里的 agent 列表是会话级快照,由 session.ts 装配时拼上(同 stm32config 在 session.ts 里追加
 * 覆盖范围 —— 契约是浏览器安全的菜单,读不到 agent 定义)。宿主不能后台时 run_in_background 从 schema 里摘掉,
 * 同样在 session.ts 做。
 *
 * 没有 confirm:CC 的 Agent 工具 `isReadOnly: true`,问不问下放给子 agent 自己调的那些工具。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const agentParameters = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform" }),
  subagent_type: Type.Optional(
    Type.String({ description: "The type of specialized agent to use for this task (default: general-purpose)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override as "<provider>/<modelId>". If omitted, the agent definition\'s model is used, otherwise your current model.',
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description: "Set to true to run this agent in the background. You will be notified when it completes.",
    }),
  ),
})

export type AgentInput = Static<typeof agentParameters>

/** 前台结果、转后台结果与进度快照共用的卡片数据;字段来自宿主的 TaskSnapshot,只放能 JSON 往返的。 */
export interface AgentDetails {
  taskID: string
  agent: string
  description: string
  status: "pending" | "running" | "completed" | "failed" | "killed"
  background: boolean
  turns: number
  lastTool?: string
  usage: { totalTokens: number; toolUses: number; durationMs: number }
  outputFile: string
  maxTurnsReached?: boolean
}

export const AGENT_CONTRACT = {
  name: "agent",
  label: "子 agent",
  description:
    "Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.",
  parameters: agentParameters,
  guidelines: [],
  summary: agentSummary,
} as const satisfies ToolContract<typeof agentParameters>

/** 卡片副标题:派的是谁、干什么。参数可能还在流式拼。 */
export function agentSummary(input: Partial<AgentInput>): string {
  const type = input.subagent_type?.trim() || "general-purpose"
  const description = input.description?.trim()
  return description ? `${type} · ${description}` : type
}
