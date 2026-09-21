/**
 * task_stop 工具的厨房那一半。结果照 CC:JSON 形状的 { message, task_id, task_type, command }。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import type { TaskHost } from "../../domain/agents/task-host.ts"
import { SUBAGENTS_UNAVAILABLE } from "../agent/session.ts"
import { TASK_STOP_CONTRACT, type TaskStopDetails, type TaskStopInput } from "./contract.ts"

export type TaskStopTool = AgentHarnessTool<ExecutionToolContext, typeof TASK_STOP_CONTRACT.parameters, TaskStopDetails>

export function createTaskStopTool(options: { host?: TaskHost } = {}): TaskStopTool {
  return {
    name: TASK_STOP_CONTRACT.name,
    label: TASK_STOP_CONTRACT.label,
    description: TASK_STOP_CONTRACT.description,
    parameters: TASK_STOP_CONTRACT.parameters,
    async execute(_toolCallId, params: TaskStopInput) {
      if (!options.host) throw new Error(SUBAGENTS_UNAVAILABLE)
      const outcome = await options.host.stop(params.task_id)
      if (!outcome.ok) {
        if (outcome.reason === "not_found") throw new Error(`No task found with ID: ${params.task_id}`)
        throw new Error(`Task ${params.task_id} is not running (status: ${outcome.status})`)
      }
      const details: TaskStopDetails = {
        task_id: outcome.task.taskID,
        task_type: "local_agent",
        description: outcome.task.description,
      }
      const text = JSON.stringify({
        message: `Successfully stopped task: ${outcome.task.taskID} (${outcome.task.description})`,
        task_id: details.task_id,
        task_type: details.task_type,
        command: details.description,
      })
      return { content: [{ type: "text", text }], details }
    },
  }
}
