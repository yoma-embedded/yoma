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

/** 通知 XML 里读回来的东西(投影器用)。result 取第一个 `<result>` 到**最后一个** `</result>` —— 子 agent 的原话里可能自己带着这个标签。 */
export interface ParsedTaskNotification {
  taskID?: string
  toolCallID?: string
  outputFile?: string
  status?: NotificationStatus
  summary?: string
  result?: string
  usage?: TaskUsage
}

const STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "killed"])

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^\\n]*?)</${name}>`).exec(xml)
  return match?.[1]
}

/**
 * formatTaskNotification 的逆。只认自己写出的形状;认不出的字段留空,调用方回落到消息的 details。
 */
export function parseTaskNotification(xml: string): ParsedTaskNotification {
  const out: ParsedTaskNotification = {}
  // 按 result 切成头、尾两段:头上的字段排在 result 之前,usage 排在它之后 —— 各在各的段里找,
  // result 正文里碰巧出现的同名标签就不会被当真。
  const open = xml.indexOf("<result>")
  const close = xml.lastIndexOf("</result>")
  const hasResult = open >= 0 && close > open
  const head = hasResult ? xml.slice(0, open) : xml
  const tail = hasResult ? xml.slice(close) : xml
  if (hasResult) out.result = xml.slice(open + "<result>".length, close)
  const taskID = tag(head, "task-id")
  if (taskID) out.taskID = taskID
  const toolCallID = tag(head, "tool-use-id")
  if (toolCallID) out.toolCallID = toolCallID
  const outputFile = tag(head, "output-file")
  if (outputFile) out.outputFile = outputFile
  const status = tag(head, "status")
  if (status && STATUSES.has(status)) out.status = status as NotificationStatus
  const summary = tag(head, "summary")
  if (summary) out.summary = summary
  const totalTokens = tag(tail, "total_tokens")
  const toolUses = tag(tail, "tool_uses")
  const durationMs = tag(tail, "duration_ms")
  if (totalTokens !== undefined && toolUses !== undefined && durationMs !== undefined) {
    out.usage = {
      totalTokens: Number(totalTokens) || 0,
      toolUses: Number(toolUses) || 0,
      durationMs: Number(durationMs) || 0,
    }
  }
  return out
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
