/**
 * 子 agent 任务在 app 里的读法:状态栏的任务格与面板、子会话页的顶部条共用这一份(纯函数,没有 solid)。
 *
 * 数据是内核的 `TaskView`(`task.updated` 事件 + `task.list`,折在服务器级的会话 store 里)。
 * session-ui 的 agent 卡片有自己一份(它从工具调用出发,还要认工具结果),这里只从任务出发。
 */
import type { QueuedItemView, TaskView } from "@yoma-desktop/kernel"

/** 界面上的样子:内核的 status 之外多一档"后台在跑"。 */
export type TaskLook = "pending" | "running" | "background" | "completed" | "failed" | "killed"

export const taskLook = (task: TaskView): TaskLook =>
  task.status === "running" && task.background ? "background" : task.status

/** 还能停(停止键在不在)。 */
export const taskActive = (task: TaskView) => task.status === "pending" || task.status === "running"

/** 灯(bench.css 的 LED 档位)。后台在跑也是在跑 —— 面板说的是任务,不是那次工具调用。 */
export const TASK_LED: Record<TaskLook, "idle" | "active" | "ok" | "fail" | "warn"> = {
  pending: "idle",
  running: "active",
  background: "active",
  completed: "ok",
  failed: "fail",
  killed: "warn",
}

/** 一个会话派出去的任务:在跑的在前,其余按开始时间新的在前。 */
export function sessionTasks(tasks: Readonly<Record<string, TaskView>> | undefined, parentID: string): TaskView[] {
  return Object.values(tasks ?? {})
    .filter((task) => task.parentID === parentID)
    .sort(
      (a, b) => Number(taskActive(b)) - Number(taskActive(a)) || b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1),
    )
}

/** 已经跑了多久。在跑的按 `now` 现算(调用方给一个走着的钟),结束的按结束时刻;整秒,读数不闪。 */
export function taskElapsed(task: TaskView, now: number): string {
  const end = task.endedAt ?? (taskActive(task) ? now : task.startedAt + task.usage.durationMs)
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

/** 固定坞里的一行。`reporting` = 跑完了但通知还在收件箱里排着,主 agent 还没汇报。 */
export type DockTask = { task: TaskView; reporting: boolean }

/**
 * 输入框上方那条坞要画的行:这个会话**还没完事**的子 agent —— 排队中、在跑,以及跑完了但结论还没被主 agent
 * 取走的。完全结束(通知已经进 transcript)的不画:它就在对话里那条通知行上,坞不留旧账。
 */
export function dockTasks(
  tasks: Readonly<Record<string, TaskView>> | undefined,
  sessionID: string,
  queue: readonly QueuedItemView[] | undefined,
): DockTask[] {
  const pendingReport = new Set(
    (queue ?? []).flatMap((item) => (item.kind === "notification" && item.taskID ? [item.taskID] : [])),
  )
  return sessionTasks(tasks, sessionID).flatMap((task): DockTask[] => {
    if (taskActive(task)) return [{ task, reporting: false }]
    return pendingReport.has(task.id) ? [{ task, reporting: true }] : []
  })
}
