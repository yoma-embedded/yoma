/**
 * agent 工具的厨房那一半(docs/子agent-设计方案-v0.4-20260918.md §5.1)。
 *
 * 工具自己不会开会话:开子会话、跑一轮、转后台、投递通知都是宿主的事(边界规则 2 不许工具碰 session-manager),
 * 它只认注入的 TaskHost。这里做的是三件事:核对 agent 类型、把父这次调用的中止信号与进度口交给宿主、把结果
 * 按 CC 的原话写成模型看到的工具结果(`tools/AgentTool/AgentTool.tsx` 的 mapToolResultToToolResultBlockParam)。
 *
 * 结果文本是模型已经学会的信号,**逐字**照 CC,只把 SendMessage 换成 send_message、Read / Bash 换成 read / bash。
 */

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { type TSchema, Type } from "typebox"

import { DEFAULT_AGENT_TYPE } from "../../domain/agents/builtin.ts"
import { EMPTY_RESULT_MARKER } from "../../domain/agents/finalize.ts"
import type { SpawnOutcome, TaskHost, TaskSnapshot } from "../../domain/agents/task-host.ts"
import { AGENT_CONTRACT, type AgentDetails, type AgentInput } from "./contract.ts"
import { agentToolDescription } from "./description.ts"

export interface AgentToolOptions {
  /** 宿主注入;不给 = 这个宿主不支持子 agent —— 工具照常登记(TOOL_NAMES 平台无关),execute 报错,宿主也不激活它。 */
  host?: TaskHost
  /** 父手上有没有 read / bash 去看 output_file(CC 的 canReadOutputFile);主 agent 恒有。 */
  canReadOutputFile?: boolean
}

export const SUBAGENTS_UNAVAILABLE = "Sub-agents are not available in this host."

export type AgentTool = AgentHarnessTool<ExecutionToolContext, TSchema, AgentDetails>

export function createAgentTool(options: AgentToolOptions = {}): AgentTool {
  const host = options.host
  const background = host?.backgroundAllowed() ?? true
  // CC 同款:不能后台时从 schema 里摘掉,模型根本看不见这个参数(分析 §3.1)。
  const parameters: TSchema = background
    ? AGENT_CONTRACT.parameters
    : Type.Omit(AGENT_CONTRACT.parameters, ["run_in_background"])
  return {
    name: AGENT_CONTRACT.name,
    label: AGENT_CONTRACT.label,
    description: host ? agentToolDescription(host.profiles(), { background }) : AGENT_CONTRACT.description,
    parameters,
    async execute(toolCallId, params, onUpdate, _toolContext, _invocation, context) {
      if (!host) throw new Error(SUBAGENTS_UNAVAILABLE)
      const input = params as AgentInput
      const agent = input.subagent_type?.trim() || DEFAULT_AGENT_TYPE
      const names = host.profiles().map((profile) => profile.name)
      if (!names.includes(agent)) throw new Error(`Agent type '${agent}' not found. Available agents: ${names.join(", ")}`)
      const outcome = await host.spawn(
        {
          agent,
          description: input.description,
          prompt: input.prompt,
          model: input.model?.trim() || undefined,
          // 宿主不能后台时 schema 里没有这个参数;模型硬塞进来的也不认。
          runInBackground: background && input.run_in_background === true,
        },
        {
          toolCallId,
          signal: context.abortSignal,
          onProgress: (task) => onUpdate({ content: [{ type: "text", text: progressLine(task) }], details: detailsOf(task) }),
        },
      )
      return formatAgentResult(outcome, options.canReadOutputFile ?? true)
    },
  }
}

export function detailsOf(task: TaskSnapshot): AgentDetails {
  return {
    taskID: task.taskID,
    agent: task.agent,
    description: task.description,
    status: task.status,
    background: task.background,
    turns: task.turns,
    ...(task.lastTool ? { lastTool: task.lastTool } : {}),
    usage: { ...task.usage },
    outputFile: task.outputFile,
    ...(task.maxTurnsReached ? { maxTurnsReached: true } : {}),
  }
}

/** 进度那一拍的正文:卡片主要看 details,这一行给万能卡与重放用。 */
export function progressLine(task: TaskSnapshot): string {
  const parts = [`${task.turns} turns`, `${task.usage.toolUses} tool uses`]
  if (task.lastTool) parts.push(`last: ${task.lastTool}`)
  return parts.join(" · ")
}

/** 前台结果的尾巴(CC 原话):告诉模型怎么续跑,附三个用量数。 */
export function continueTrailer(task: TaskSnapshot): string {
  return `agentId: ${task.taskID} (use send_message with to: '${task.taskID}' to continue this agent)
<usage>total_tokens: ${task.usage.totalTokens}
tool_uses: ${task.usage.toolUses}
duration_ms: ${task.usage.durationMs}</usage>`
}

/** 后台派出去 / 前台转后台时模型看到的话(CC 原话)。 */
export function asyncLaunchedText(task: TaskSnapshot, canReadOutputFile: boolean): string {
  const prefix = `Async agent launched successfully.
agentId: ${task.taskID} (internal ID - do not mention to user. Use send_message with to: '${task.taskID}' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.`
  const instructions = canReadOutputFile
    ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.
output_file: ${task.outputFile}
If asked, you can check progress before completion by using read or bash tail on the output file.`
    : "Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message."
  return `${prefix}\n${instructions}`
}

/** 前台被停 / 失败:作为工具错误交回,带上部分结果与续跑的办法。 */
export function stoppedText(outcome: Extract<SpawnOutcome, { kind: "stopped" }>): string {
  const task = outcome.task
  const head =
    outcome.reason === "failed"
      ? `Agent "${task.description}" failed: ${outcome.error || "Unknown error"}`
      : `Agent "${task.description}" was stopped before it finished.`
  const partial = outcome.partial?.trim()
  const body = partial ? `Partial result:\n${partial}` : "It produced no output before it stopped."
  return `${head}\n\n${body}\n\nagentId: ${task.taskID} (use send_message with to: '${task.taskID}' to continue this agent)`
}

export function formatAgentResult(outcome: SpawnOutcome, canReadOutputFile: boolean): AgentToolResult<AgentDetails> {
  switch (outcome.kind) {
    case "completed": {
      // CC:只剩 agentId / usage 尾巴时,有的模型把它读成"没什么可做的"而直接结束这一轮,所以空结果要明说。
      const text = outcome.text?.trim() ? outcome.text : EMPTY_RESULT_MARKER
      const content: AgentToolResult<AgentDetails>["content"] = [{ type: "text", text }]
      // CC:一次性的内建 agent 永远不会被续跑,尾巴是纯浪费(135 字符 × 每周 3400 万次 Explore)。
      if (!outcome.oneShot) content.push({ type: "text", text: continueTrailer(outcome.task) })
      return { content, details: detailsOf(outcome.task) }
    }
    case "async_launched":
      return {
        content: [{ type: "text", text: asyncLaunchedText(outcome.task, canReadOutputFile) }],
        details: detailsOf(outcome.task),
      }
    case "stopped":
      throw new Error(stoppedText(outcome))
  }
}
