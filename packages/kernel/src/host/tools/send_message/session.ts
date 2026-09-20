/**
 * send_message 工具的厨房那一半。结果照 CC:JSON 形状的 { success, message },message 用 CC 的原话
 * (`tools/SendMessageTool/SendMessageTool.ts` 的子 agent 分支)。
 *
 * 宿主不能后台时(bench / 信箱)续跑改为前台跑完、结果直接作为这次调用的结果 —— 同 agent 工具的前台结果。
 */

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import type { TaskHost } from "../../domain/agents/task-host.ts"
import { formatAgentResult, SUBAGENTS_UNAVAILABLE } from "../agent/session.ts"
import { SEND_MESSAGE_CONTRACT, type SendMessageDetails, type SendMessageInput } from "./contract.ts"

export type SendMessageTool = AgentHarnessTool<
  ExecutionToolContext,
  typeof SEND_MESSAGE_CONTRACT.parameters,
  SendMessageDetails
>

function reply(details: SendMessageDetails, message: string): AgentToolResult<SendMessageDetails> {
  return { content: [{ type: "text", text: JSON.stringify({ success: details.success, message }) }], details }
}

export function createSendMessageTool(options: { host?: TaskHost; canReadOutputFile?: boolean } = {}): SendMessageTool {
  return {
    name: SEND_MESSAGE_CONTRACT.name,
    label: SEND_MESSAGE_CONTRACT.label,
    description: SEND_MESSAGE_CONTRACT.description,
    parameters: SEND_MESSAGE_CONTRACT.parameters,
    async execute(_toolCallId, params: SendMessageInput, _onUpdate, _toolContext, _invocation, context) {
      const host = options.host
      if (!host) throw new Error(SUBAGENTS_UNAVAILABLE)
      const outcome = await host.send(params.to, params.message, {
        summary: params.summary,
        signal: context.abortSignal,
      })
      switch (outcome.kind) {
        case "queued":
          return reply(
            { to: params.to, success: true, delivery: "queued" },
            `Message queued for delivery to ${params.to} at its next tool round.`,
          )
        case "resumed":
          return reply(
            { to: params.to, success: true, delivery: "resumed" },
            `Agent "${params.to}" was stopped (${outcome.previousStatus}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outcome.task.outputFile}`,
          )
        case "resumed_foreground": {
          const result = formatAgentResult(outcome.outcome, options.canReadOutputFile ?? true)
          return { content: result.content, details: { to: params.to, success: true, delivery: "resumed_foreground" } }
        }
        case "not_found":
          return reply(
            { to: params.to, success: false },
            `No agent with ID "${params.to}". Use the agentId from the agent tool result.`,
          )
      }
    },
  }
}
