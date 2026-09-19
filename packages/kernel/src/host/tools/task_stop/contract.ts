/**
 * task_stop 工具的契约(CC 的 TaskStop,`tools/TaskStopTool/TaskStopTool.ts`)。
 *
 * 停掉的 agent **照样发通知**并带部分结果:CC 的 stopTask 只压 bash 任务的通知,agent 任务不压
 * ("the AbortError catch sends a notification carrying extractPartialResult, which is the payload not noise",
 * `tasks/stopTask.ts`)。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const taskStopParameters = Type.Object({
  task_id: Type.String({ description: "The ID of the background agent to stop (the agentId from the agent tool result)" }),
})

export type TaskStopInput = Static<typeof taskStopParameters>

export interface TaskStopDetails {
  task_id: string
  task_type: "local_agent"
  description: string
}

export const TASK_STOP_CONTRACT = {
  name: "task_stop",
  label: "停止任务",
  description:
    "Stop a running background agent by ID. Its partial result still arrives as a <task-notification>, so do not wait on it with task_output afterwards.",
  parameters: taskStopParameters,
  guidelines: [],
  summary: (input: Partial<TaskStopInput>) => input.task_id ?? "",
} as const satisfies ToolContract<typeof taskStopParameters>
