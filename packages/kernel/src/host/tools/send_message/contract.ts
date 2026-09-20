/**
 * send_message 工具的契约(CC 的 SendMessage 里"发给子 agent"那一支,`tools/SendMessageTool/SendMessageTool.ts`)。
 *
 * CC 对外部用户要开 agent teams 才有这个工具,但它自己的 Agent 描述也在教模型用它续跑;续跑是核心用例,
 * yoma 缺省开(docs/子agent-设计方案-v0.4-20260918.md §10 #15)。只做子 agent 这一支:没有 teammate、没有广播。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const sendMessageParameters = Type.Object({
  to: Type.String({ description: "The agentId from the agent tool result" }),
  message: Type.String({ description: "The message for the agent" }),
  summary: Type.Optional(Type.String({ description: "A 5-10 word summary shown as a preview in the UI" })),
})

export type SendMessageInput = Static<typeof sendMessageParameters>

export interface SendMessageDetails {
  to: string
  success: boolean
  delivery?: "queued" | "resumed" | "resumed_foreground"
}

export const SEND_MESSAGE_CONTRACT = {
  name: "send_message",
  label: "发给子 agent",
  description: `Send a message to an agent you launched with the agent tool.

- If the agent is still running, the message is queued and delivered at its next tool round.
- If the agent has finished or was stopped, it resumes with its full context plus your message, and you are notified when it finishes again.
- Refer to the agent by the agentId from the agent tool result.`,
  parameters: sendMessageParameters,
  guidelines: [],
  summary: (input: Partial<SendMessageInput>) => input.summary?.trim() || input.to || "",
} as const satisfies ToolContract<typeof sendMessageParameters>
