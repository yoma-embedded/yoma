/**
 * task_output 工具的厨房那一半:参数缺省与钳位在这里,等待本身在宿主(TaskHost.output)。
 * 结果格式照 CC TaskOutputTool 的 mapToolResultToToolResultBlockParam:几段 XML 标签,空行隔开。
 */

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import type { TaskHost, TaskOutputView } from "../../domain/agents/task-host.ts"
import { SUBAGENTS_UNAVAILABLE } from "../agent/session.ts"
import {
  DEFAULT_TASK_OUTPUT_TIMEOUT_MS,
  MAX_TASK_OUTPUT_TIMEOUT_MS,
  TASK_OUTPUT_CONTRACT,
  type TaskOutputInput,
} from "./contract.ts"

export type TaskOutputTool = AgentHarnessTool<
  ExecutionToolContext,
  typeof TASK_OUTPUT_CONTRACT.parameters,
  TaskOutputView
>

/** 超时缺省 30 s、钳到 0..600 s;非数回落缺省。 */
export function taskOutputTimeout(timeout: number | undefined): number {
  if (timeout === undefined || !Number.isFinite(timeout)) return DEFAULT_TASK_OUTPUT_TIMEOUT_MS
  return Math.min(MAX_TASK_OUTPUT_TIMEOUT_MS, Math.max(0, Math.trunc(timeout)))
}

export function formatTaskOutput(view: TaskOutputView): string {
  const parts = [
    `<retrieval_status>${view.retrieval_status}</retrieval_status>`,
    `<task_id>${view.task.task_id}</task_id>`,
    `<task_type>${view.task.task_type}</task_type>`,
    `<status>${view.task.status}</status>`,
  ]
  if (view.task.output?.trim()) parts.push(`<output>\n${view.task.output.trimEnd()}\n</output>`)
  if (view.task.error) parts.push(`<error>${view.task.error}</error>`)
  return parts.join("\n\n")
}

export function createTaskOutputTool(options: { host?: TaskHost } = {}): TaskOutputTool {
  return {
    name: TASK_OUTPUT_CONTRACT.name,
    label: TASK_OUTPUT_CONTRACT.label,
    description: TASK_OUTPUT_CONTRACT.description,
    parameters: TASK_OUTPUT_CONTRACT.parameters,
    async execute(_toolCallId, params: TaskOutputInput, _onUpdate, _toolContext, _invocation, context) {
      if (!options.host) throw new Error(SUBAGENTS_UNAVAILABLE)
      const view = await options.host.output(params.task_id, {
        block: params.block ?? true,
        timeoutMs: taskOutputTimeout(params.timeout),
        signal: context.abortSignal,
      })
      // CC 的 validateInput 原话。
      if (!view) throw new Error(`No task found with ID: ${params.task_id}`)
      const result: AgentToolResult<TaskOutputView> = { content: [{ type: "text", text: formatTaskOutput(view) }], details: view }
      return result
    },
  }
}
