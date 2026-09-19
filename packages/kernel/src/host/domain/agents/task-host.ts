/**
 * 四个子 agent 工具(agent / task_output / task_stop / send_message)与宿主之间的接口
 * (docs/子agent-设计方案-v0.4-20260918.md §5.4)。
 *
 * 为什么是注入的接口:边界规则 2(host/boundary.test.ts)不许工具间碰 session-manager,而开子会话、
 * 跑一轮、投递通知全是会话间的事。宿主(host/tasks.ts,P2)实现它,给每个主会话一个绑定了父会话 id 的门面;
 * 工具只认这里的类型。所有字段只放能 JSON 往返的东西 —— 任务快照原样成为卡片的 details。
 */

import type { AgentProfile } from "./profile.ts"

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed"

/** CC finalizeAgentTool 那三个数:结果尾巴与通知里的 <usage> 就是它们。 */
export interface TaskUsage {
  totalTokens: number
  toolUses: number
  durationMs: number
}

/** 一个任务此刻的样子:进度回调、工具结果的 details、task.updated 事件都用它。 */
export interface TaskSnapshot {
  /** = 子会话 id(CC 的 agentId);send_message / task_output / task_stop 都按它找。 */
  taskID: string
  agent: string
  description: string
  status: TaskStatus
  /** 结果走通知而不是工具结果。 */
  background: boolean
  /** 已经开始的 assistant 轮数。 */
  turns: number
  lastTool?: string
  usage: TaskUsage
  /** 可读的进度日志(不是 v2 的 JSONL:那里每个流事件一行)。 */
  outputFile: string
  /** CC 的 max_turns 算 completed 的一种。 */
  maxTurnsReached?: boolean
}

export interface SpawnRequest {
  /** 已经确认存在于 profiles() 里的 agent 名。 */
  agent: string
  description: string
  prompt: string
  /** "provider/modelId";缺省走 profile 与继承(v0.4 §4.5)。 */
  model?: string
  /** 模型给的 run_in_background;宿主再与 profile.background、自己能不能后台合起来定(CC shouldRunAsync)。 */
  runInBackground: boolean
}

export interface SpawnCall {
  toolCallId: string
  /** 父这次工具调用的中止信号。前台时宿主把它接到子 lane 上(CC:同步子 agent 随 ESC 一起死);转后台时解除。 */
  signal: AbortSignal | undefined
  /** 子 agent 每开一轮、每结束一个工具报一次;工具把它转成父 lane 上的 tool_update。 */
  onProgress(task: TaskSnapshot): void
}

export type SpawnOutcome =
  /** 前台跑完。text 是子 agent 最后一段文字(没有时 undefined,由工具换成占位句)。 */
  | { kind: "completed"; task: TaskSnapshot; text: string | undefined; oneShot: boolean }
  /** 后台派出去了,或前台跑到一半被转了后台。结果以后走 <task-notification>。 */
  | { kind: "async_launched"; task: TaskSnapshot }
  /** 前台被停或失败:工具以错误结果返回,带上部分结果。 */
  | { kind: "stopped"; task: TaskSnapshot; reason: "killed" | "failed"; error?: string; partial: string | undefined }

/** CC TaskOutputTool 的输出形状。 */
export interface TaskOutputView {
  retrieval_status: "success" | "timeout" | "not_ready"
  task: {
    task_id: string
    task_type: "local_agent"
    status: TaskStatus
    description: string
    prompt: string
    /** 结果文本;被停时是部分结果。 */
    output?: string
    error?: string
  }
}

export type StopOutcome =
  | { ok: true; task: TaskSnapshot }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_running"; status: TaskStatus }

export type SendOutcome =
  /** 子 agent 还在跑:排进它的收件箱,下一个工具轮次边界插入。 */
  | { kind: "queued"; task: TaskSnapshot }
  /** 已经结束 / 被停:后台续跑,完成后再通知。previousStatus 是续跑前的状态(CC 的回复里要说)。 */
  | { kind: "resumed"; task: TaskSnapshot; previousStatus: TaskStatus }
  /** 宿主不能后台时(bench / 信箱)前台续跑,结果直接作为工具结果。 */
  | { kind: "resumed_foreground"; outcome: SpawnOutcome }
  | { kind: "not_found" }

export interface TaskHost {
  /** 本会话打开时的快照:会话内不变,agent 工具的描述因此字节稳定。 */
  profiles(): readonly AgentProfile[]
  /** 无人值守的宿主(bench / 信箱)不能后台(CC 的 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)。 */
  backgroundAllowed(): boolean
  spawn(request: SpawnRequest, call: SpawnCall): Promise<SpawnOutcome>
  /** 找不到这个任务时返回 undefined。 */
  output(
    taskID: string,
    options: { block: boolean; timeoutMs: number; signal: AbortSignal | undefined },
  ): Promise<TaskOutputView | undefined>
  stop(taskID: string): Promise<StopOutcome>
  send(to: string, message: string, options: { summary?: string; signal: AbortSignal | undefined }): Promise<SendOutcome>
}
