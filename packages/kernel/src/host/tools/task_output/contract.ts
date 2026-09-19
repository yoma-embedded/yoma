/**
 * task_output 工具的契约(CC 的 TaskOutput,`tools/TaskOutputTool/TaskOutputTool.tsx`)。
 *
 * CC 2.1.88 已把 TaskOutput 标成 DEPRECATED、推荐 Read 任务的 output_file;yoma 保留它,因为 yoma 的
 * output_file 是派生的进度日志,权威结果在宿主内存与子会话里,这个工具取的正是权威那份
 * (docs/子agent-设计方案-v0.4-20260918.md §10 #14)。描述用 CC 弃用前的那一版。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

export const MAX_TASK_OUTPUT_TIMEOUT_MS = 600_000
export const DEFAULT_TASK_OUTPUT_TIMEOUT_MS = 30_000

const taskOutputParameters = Type.Object({
  task_id: Type.String({ description: "The task ID to get output from (the agentId from the agent tool result)" }),
  block: Type.Optional(Type.Boolean({ description: "Whether to wait for completion (default: true)" })),
  timeout: Type.Optional(
    Type.Number({ minimum: 0, maximum: MAX_TASK_OUTPUT_TIMEOUT_MS, description: "Max wait time in ms (default: 30000)" }),
  ),
})

export type TaskOutputInput = Static<typeof taskOutputParameters>

const TASK_OUTPUT_DESCRIPTION = `- Retrieves output from a running or completed background agent
- Takes a task_id parameter identifying the task (the agentId from the agent tool result)
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- You are notified automatically when a background agent finishes; prefer that notification over polling`

export const TASK_OUTPUT_CONTRACT = {
  name: "task_output",
  label: "任务结果",
  description: TASK_OUTPUT_DESCRIPTION,
  parameters: taskOutputParameters,
  guidelines: [],
  summary: (input: Partial<TaskOutputInput>) => (input.block === false ? `${input.task_id ?? ""} · 不等待` : (input.task_id ?? "")),
} as const satisfies ToolContract<typeof taskOutputParameters>
