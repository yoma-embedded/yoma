/**
 * 后台子 agent 落定后回注父会话的通知(docs/子agent-设计方案-v0.4-20260918.md §6.4)。
 *
 * XML 与 CC 逐字段同形(`tasks/LocalAgentTask/LocalAgentTask.tsx` 的 enqueueAgentNotification):模型对这个形状有先验,
 * 工具描述里 "Don't race" 那段说的"以 user 消息到达的通知"就是它。宿主把它包成 customType 为
 * `task-notification` 的 custom 消息,v2 在模型边界把 custom 投成 user 角色。
 */

import type { TaskUsage } from "./task-host.ts"

export const TASK_NOTIFICATION_TYPE = "task-notification"

export type NotificationStatus = "completed" | "failed" | "killed"

export interface TaskNotification {
  taskID: string
  /** 派生它的那次 agent 工具调用;续跑出来的通知没有。 */
  toolCallID?: string
  outputFile: string
  status: NotificationStatus
  description: string
  error?: string
  /** 最终文字;被停时是部分结果。 */
  result?: string
  usage?: TaskUsage
}

/** CC 的 summary 三种说法。 */
export function notificationSummary(status: NotificationStatus, description: string, error?: string): string {
  if (status === "completed") return `Agent "${description}" completed`
  if (status === "failed") return `Agent "${description}" failed: ${error || "Unknown error"}`
  return `Agent "${description}" was stopped`
}

export function formatTaskNotification(notification: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `<task-id>${notification.taskID}</task-id>`,
    ...(notification.toolCallID ? [`<tool-use-id>${notification.toolCallID}</tool-use-id>`] : []),
    `<output-file>${notification.outputFile}</output-file>`,
    `<status>${notification.status}</status>`,
    `<summary>${notificationSummary(notification.status, notification.description, notification.error)}</summary>`,
    ...(notification.result ? [`<result>${notification.result}</result>`] : []),
    ...(notification.usage
      ? [
          `<usage><total_tokens>${notification.usage.totalTokens}</total_tokens><tool_uses>${notification.usage.toolUses}</tool_uses><duration_ms>${notification.usage.durationMs}</duration_ms></usage>`,
        ]
      : []),
    "</task-notification>",
  ]
  return lines.join("\n")
}
