/**
 * 子 agent 的任务注册表与调度(docs/子agent-设计方案-v0.4-20260918.md §6)。
 *
 * 进程级,由 SessionManager 持有。它**不碰 harness**:开子会话、起一轮、中止、往父会话投递通知都经窄接口
 * TaskPort 交给 SessionManager —— 同一套 accept + drive、同一套 fail 处理、同一套 LRU 钉住。它自己管的是:
 * 任务状态机、并发闸、前台等待(race 完成 / 转后台)、通知的原子去重与逐父串行投递、output_file。
 *
 * 子会话的运行靠事件回报(onRunStart / onRunEnd …,由 SessionManager 的订阅转过来),不靠自己 await drive ——
 * 因为有的运行不是这里起的:send_message 的 steer 恰好落在子会话 run_end 之后,是宿主"收件箱非空就叫醒"
 * 那条路把它接住、起的新一轮(onRunStart 见到落定过的任务就当续跑处理)。
 *
 * 每任务副作用登记表(CC finally 清单的对应物,分析 §7.5、§14.1)。**加一项就在 settle / moveToBackground 里加一行**:
 * | 占用                          | 在哪                  | 谁收                          |
 * | 子会话 Entry 的钉住           | SessionManager        | settle                         |
 * | 并发槽位                      | this.running          | settle(放行下一个 pending)   |
 * | 父工具 abortSignal 的监听     | task.releases         | settle / 转后台                |
 * | 自动转后台计时器              | task.releases         | settle / 转后台                |
 * | 前台的进度回调                | task.progress         | settle / 转后台                |
 * | 挂着的确认                    | ConfirmDesk           | 转后台(子会话停 / 关时 SessionManager 自己撤) |
 * | output_file 的写队列          | task.writes           | 每次写完自己结                 |
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { createCustomMessage, type AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"

import type { KernelEvent } from "../protocol.ts"
import type { TaskView } from "../types.ts"
import { formatTaskNotification, TASK_NOTIFICATION_TYPE } from "./domain/agents/notification.ts"
import type { AgentProfile } from "./domain/agents/profile.ts"
import type {
  SendOutcome,
  SpawnCall,
  SpawnOutcome,
  SpawnRequest,
  StopOutcome,
  TaskHost,
  TaskOutputView,
  TaskSnapshot,
  TaskStatus,
} from "./domain/agents/task-host.ts"
import { toolContract } from "./tools/contracts.ts"

/** 子会话的会话级值 `yoma/subagent`:续跑时靠它知道自己是哪种 agent、属于谁(CC writeAgentMetadata 同理)。 */
export interface SubagentMeta {
  agent: string
  parentSessionId: string
  toolCallId: string
  description: string
  background: boolean
  createdAt: number
  /** 这次运行的结果已经以通知送出(或作为前台结果交回)。 */
  notified: boolean
  /** 最近一次落定的状态;进程在运行中死掉时不会有(重开时那一轮已被 abort,按 killed 算)。 */
  status?: TaskStatus
}

export interface ChildSpec {
  agent: string
  description: string
  toolCallId: string
  background: boolean
  /** agent 工具的 model 入参("provider/modelId")。 */
  model?: string
}

/** TaskManager 对 SessionManager 的全部要求。 */
export interface TaskPort {
  /** 建子会话、写元数据、发 session.created、打开并**钉住**(钉住要早于打开:打开的末尾就会跑一次 LRU)。 */
  createChild(parentID: string, spec: ChildSpec): Promise<string>
  /** 在子会话上起一轮:开会话(被淘汰了就重开)、组装输入、accept + 不等的 drive。 */
  run(childID: string, input: { prompt: string; first: boolean; extra: string[] }): Promise<void>
  /** 排进子会话的收件箱(send_message 到运行中的子 agent)。 */
  steer(childID: string, text: string): Promise<void>
  /** 中止子会话在飞的那一轮,不等它落定。 */
  abort(childID: string): Promise<void>
  /** 最后一段 assistant 文字;给了 fromTipId 就只看这一轮(它之后的)。 */
  lastText(childID: string, fromTipId: string | null | undefined): Promise<string | undefined>
  /** 往父会话的收件箱里放一条通知,父空闲就叫醒它。 */
  deliver(parentID: string, message: AgentMessage): Promise<void>
  pin(childID: string, pinned: boolean): void
  /** 撤掉子会话挂着的确认(转后台时:后台问不了用户)。 */
  cancelConfirms(childID: string): void
  recordMeta(childID: string, patch: Partial<SubagentMeta>): Promise<void>
  /** 注册表里没有的任务(进程重启过)从磁盘重建:不是这个父的子会话就给 undefined。 */
  childMeta(parentID: string, childID: string): Promise<SubagentMeta | undefined>
  emit(events: KernelEvent[]): void
}

export interface TaskManagerOptions {
  port: TaskPort
  /** false = 一律前台(bench / 信箱:后台子 agent 会让"idle"说谎)。 */
  background: boolean
  maxConcurrent: number
  /** 前台任务跑满这么久自动转后台;0 = 关(CC 缺省关)。 */
  autoBackgroundMs: number
  /** output_file 的根:`<root>/<父会话>/tasks/<任务>.output`。 */
  outputRoot: string
}

interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
  settled: boolean
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const out: Deferred<T> = {
    promise: new Promise<T>((done) => (resolve = done)),
    resolve: (value) => {
      out.settled = true
      resolve(value)
    },
    settled: false,
  }
  return out
}

type Terminal = Extract<TaskStatus, "completed" | "failed" | "killed">

interface RunEnd {
  status: Terminal
  error?: string
  /** 这一轮开始前的 tip:结果只从它之后找。 */
  fromTipId?: string | null
  maxTurnsReached?: boolean
  /** 根本没跑起来(排队时就被停了):没有"这一轮"可取结果。 */
  noRun?: boolean
}

interface TaskState {
  id: string
  parentID: string
  toolCallID?: string
  agent: string
  description: string
  /** 最近一次交给它的输入(任务书或续跑消息);task_output 原样回。 */
  prompt: string
  oneShot: boolean
  status: TaskStatus
  background: boolean
  /** 第几次运行;落定后的收尾(取结果、通知)按它认领,续跑之后晚到的收尾不许写进新一轮。 */
  run: number
  /** 这一轮是续跑(通知里不带 tool-use-id)。 */
  resumed: boolean
  startedAt: number
  endedAt?: number
  turns: number
  toolUses: number
  lastTool?: string
  totalTokens: number
  maxTurnsReached?: boolean
  result?: string
  error?: string
  notified: boolean
  outputFile: string
  done: Deferred
  backgrounded: Deferred
  /** 排队时先攒着的 send_message,开跑时接在输入后面。 */
  extra: string[]
  next?: { prompt: string; first: boolean }
  /** 当前占着一个并发槽。 */
  slot: boolean
  /** 有人要停它(task_stop、界面、父中止)。 */
  stopping: boolean
  releases: Array<() => void>
  progress?: (task: TaskSnapshot) => void
  writes: Promise<void>
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set(["pending", "running"])

function isActive(status: TaskStatus): boolean {
  return ACTIVE.has(status)
}

/** 工具那一行摘要:契约有 summary 用契约的(bash 没契约,取命令本身),压成一行、截到 160 字。 */
function toolSummary(name: string, args: unknown): string {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>
  let summary: string
  try {
    summary = toolContract(name)?.summary(input as never) ?? (typeof input.command === "string" ? input.command : JSON.stringify(input))
  } catch {
    summary = ""
  }
  const line = summary.replace(/\s+/g, " ").trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
}

export class TaskManager {
  private readonly options: TaskManagerOptions
  private readonly port: TaskPort
  private readonly tasks = new Map<string, TaskState>()
  /** 排着等并发槽的,先来先跑。 */
  private readonly waiting: TaskState[] = []
  private running = 0
  private closing = false
  /** 每个父会话一条串行的投递队列:同一个父的通知按落定顺序进收件箱。 */
  private readonly deliveries = new Map<string, Promise<void>>()

  constructor(options: TaskManagerOptions) {
    this.options = options
    this.port = options.port
  }

  // -------------------------------------------------------------------------
  // 给工具的门面
  // -------------------------------------------------------------------------

  /** 绑定一个父会话的 TaskHost。profiles 是父会话打开时的快照(agent 工具的描述因此字节稳定)。 */
  hostFor(parentID: string, profiles: () => readonly AgentProfile[]): TaskHost {
    return {
      profiles,
      backgroundAllowed: () => this.options.background,
      spawn: (request, call) => this.spawn(parentID, profiles(), request, call),
      output: (taskID, options) => this.output(parentID, taskID, options, profiles()),
      stop: (taskID) => this.stopFor(parentID, taskID, profiles()),
      send: (to, message, options) => this.send(parentID, to, message, options, profiles()),
    }
  }

  // -------------------------------------------------------------------------
  // 查询(RPC / 确认钩子)
  // -------------------------------------------------------------------------

  list(parentID: string): TaskView[] {
    return [...this.tasks.values()].filter((task) => task.parentID === parentID).map((task) => this.view(task))
  }

  get(taskID: string): TaskView | undefined {
    const task = this.tasks.get(taskID)
    return task ? this.view(task) : undefined
  }

  /** 确认钩子要知道:这个子会话此刻是前台(能问)还是后台(不能问)。不认识的子会话 = undefined。 */
  task(childID: string): { agent: string; description: string; background: boolean } | undefined {
    const task = this.tasks.get(childID)
    return task ? { agent: task.agent, description: task.description, background: task.background } : undefined
  }

  // -------------------------------------------------------------------------
  // 派生
  // -------------------------------------------------------------------------

  private async spawn(
    parentID: string,
    profiles: readonly AgentProfile[],
    request: SpawnRequest,
    call: SpawnCall,
  ): Promise<SpawnOutcome> {
    if (this.closing) throw new Error("The host is shutting down; no new sub-agents can be started.")
    const profile = profiles.find((item) => item.name === request.agent)
    if (!profile) {
      throw new Error(`Agent type '${request.agent}' not found. Available agents: ${profiles.map((item) => item.name).join(", ")}`)
    }
    // CC shouldRunAsync:入参或定义要后台,且宿主允许。
    const background = this.options.background && (request.runInBackground || profile.background === true)
    const childID = await this.port.createChild(parentID, {
      agent: profile.name,
      description: request.description,
      toolCallId: call.toolCallId,
      background,
      ...(request.model ? { model: request.model } : {}),
    })
    const task = this.register({
      id: childID,
      parentID,
      toolCallID: call.toolCallId,
      agent: profile.name,
      description: request.description,
      prompt: request.prompt,
      oneShot: profile.oneShot === true,
      background,
    })
    await this.prepareOutput(task)
    if (!background) this.attachForeground(task, call.signal, call.onProgress)
    this.schedule(task, { prompt: request.prompt, first: true })
    if (background) return { kind: "async_launched", task: this.snapshot(task) }
    return this.awaitForeground(task)
  }

  private register(init: {
    id: string
    parentID: string
    toolCallID?: string
    agent: string
    description: string
    prompt: string
    oneShot: boolean
    background: boolean
    status?: TaskStatus
    notified?: boolean
  }): TaskState {
    const task: TaskState = {
      id: init.id,
      parentID: init.parentID,
      ...(init.toolCallID ? { toolCallID: init.toolCallID } : {}),
      agent: init.agent,
      description: init.description,
      prompt: init.prompt,
      oneShot: init.oneShot,
      status: init.status ?? "pending",
      background: init.background,
      run: 0,
      resumed: false,
      startedAt: Date.now(),
      turns: 0,
      toolUses: 0,
      totalTokens: 0,
      notified: init.notified ?? false,
      outputFile: path.join(this.options.outputRoot, init.parentID, "tasks", `${init.id}.output`),
      done: deferred(),
      backgrounded: deferred(),
      extra: [],
      slot: false,
      stopping: false,
      releases: [],
      writes: Promise.resolve(),
    }
    this.tasks.set(task.id, task)
    return task
  }

  /**
   * 前台:父这次工具调用被中止(停止键 / Esc)就停掉子 agent —— CC 同款,同步子 agent 随 ESC 一起死。
   * 自动转后台的计时器也挂在这里。两样都进 releases,落定或转后台时一起摘。
   */
  private attachForeground(
    task: TaskState,
    signal: AbortSignal | undefined,
    progress: ((task: TaskSnapshot) => void) | undefined,
  ): void {
    task.progress = progress
    if (signal) {
      const onAbort = () => void this.kill(task)
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener("abort", onAbort, { once: true })
        task.releases.push(() => signal.removeEventListener("abort", onAbort))
      }
    }
    if (this.options.background && this.options.autoBackgroundMs > 0) {
      const timer = setTimeout(() => this.moveToBackground(task), this.options.autoBackgroundMs)
      ;(timer as { unref?: () => void }).unref?.()
      task.releases.push(() => clearTimeout(timer))
    }
  }

  private async awaitForeground(task: TaskState): Promise<SpawnOutcome> {
    const { done, backgrounded } = task
    await Promise.race([done.promise, backgrounded.promise])
    // 转后台发生在落定之前(moveToBackground 不收落定的任务),结果以后走通知。
    if (backgrounded.settled && task.background) return { kind: "async_launched", task: this.snapshot(task) }
    if (task.status === "completed") {
      return { kind: "completed", task: this.snapshot(task), text: task.result, oneShot: task.oneShot }
    }
    return {
      kind: "stopped",
      task: this.snapshot(task),
      reason: task.status === "failed" ? "failed" : "killed",
      ...(task.error ? { error: task.error } : {}),
      partial: task.result,
    }
  }

  // -------------------------------------------------------------------------
  // 并发闸与运行
  // -------------------------------------------------------------------------

  private schedule(task: TaskState, input: { prompt: string; first: boolean }): void {
    task.status = "pending"
    task.next = input
    task.prompt = input.prompt
    this.waiting.push(task)
    this.emit(task)
    this.pump()
  }

  private pump(): void {
    while (!this.closing && this.running < this.options.maxConcurrent && this.waiting.length > 0) {
      const task = this.waiting.shift()!
      this.running += 1
      task.slot = true
      void this.start(task)
    }
  }

  private async start(task: TaskState): Promise<void> {
    const input = task.next ?? { prompt: task.prompt, first: false }
    task.next = undefined
    const extra = task.extra.splice(0)
    this.beginRun(task)
    this.log(
      task,
      input.first
        ? `# ${task.agent} · ${task.description}\n\n${input.prompt}\n\n`
        : `\n--- message ---\n${input.prompt}\n\n`,
    )
    try {
      await this.port.run(task.id, { prompt: input.prompt, first: input.first, extra })
    } catch (error) {
      this.settle(task, { status: "failed", error: (error as Error)?.message ?? String(error), noRun: true })
      return
    }
    // 起跑与停止撞在一起:accept 之前来的中止找不到操作可停,这里补一刀。
    if (task.stopping && task.status === "running") await this.port.abort(task.id).catch(() => {})
  }

  /** 一次运行的起点:计数清零、钉住。自己起的与"收件箱叫醒"起的(续跑)共用。 */
  private beginRun(task: TaskState): void {
    task.run += 1
    task.status = "running"
    task.startedAt = Date.now()
    task.endedAt = undefined
    task.turns = 0
    task.toolUses = 0
    task.lastTool = undefined
    task.maxTurnsReached = undefined
    task.result = undefined
    task.error = undefined
    this.port.pin(task.id, true)
    this.emit(task)
  }

  // -------------------------------------------------------------------------
  // 子会话的事件(SessionManager 转过来)
  // -------------------------------------------------------------------------

  onRunStart(childID: string): void {
    const task = this.tasks.get(childID)
    if (!task || isActive(task.status)) return
    // 不是这里起的一轮:send_message 的 steer 恰好落在 run_end 之后,被宿主的收件箱唤醒接住了。按后台续跑处理 ——
    // 派它的那次工具调用早就交回了结果,这一轮的结果只能走通知。
    if (this.closing) return
    this.prepareResume(task)
    this.running += 1
    task.slot = true
    this.beginRun(task)
    this.log(task, "\n--- message ---\n(queued message)\n\n")
  }

  onTurn(childID: string): void {
    const task = this.running_(childID)
    if (!task) return
    task.turns += 1
    this.progress(task)
  }

  onTool(childID: string, name: string, args: unknown): void {
    const task = this.running_(childID)
    if (!task) return
    task.toolUses += 1
    task.lastTool = name
    this.log(task, `→ ${name}: ${toolSummary(name, args)}\n`)
    this.progress(task)
  }

  onAssistant(childID: string, message: AssistantMessage): void {
    const task = this.running_(childID)
    if (!task) return
    // CC finalizeAgentTool 的 total_tokens 取最后一条 assistant 的用量(大致是此刻的上下文大小)。
    if (message.usage?.totalTokens) task.totalTokens = message.usage.totalTokens
    const body = assistantText(message)
    if (body) this.log(task, `${body}\n\n`)
  }

  onRunEnd(
    childID: string,
    end: { status: "completed" | "aborted" | "failed"; error?: string; fromTipId?: string | null; maxTurnsReached?: boolean },
  ): void {
    const task = this.running_(childID)
    if (!task) return
    this.settle(task, {
      status: end.status === "completed" ? "completed" : end.status === "aborted" ? "killed" : "failed",
      ...(end.error ? { error: end.error } : {}),
      fromTipId: end.fromTipId,
      ...(end.maxTurnsReached ? { maxTurnsReached: true } : {}),
    })
  }

  private running_(childID: string): TaskState | undefined {
    const task = this.tasks.get(childID)
    return task?.status === "running" ? task : undefined
  }

  private progress(task: TaskState): void {
    task.progress?.(this.snapshot(task))
    this.emit(task)
  }

  // -------------------------------------------------------------------------
  // 落定
  // -------------------------------------------------------------------------

  /**
   * 状态**先**落定,再做会慢的收尾(取结果、写日志、通知)—— CC gh-20236:task_output(block) 要立刻解锁,
   * 会挂住的点缀不许挡在状态转换前面。重复调用无害(onRunEnd 与 fail 两条路都会到)。
   */
  private settle(task: TaskState, end: RunEnd): void {
    if (!isActive(task.status)) return
    task.status = end.status
    task.endedAt = Date.now()
    if (end.error) task.error = end.error
    if (end.maxTurnsReached) task.maxTurnsReached = true
    const waitingAt = this.waiting.indexOf(task)
    if (waitingAt >= 0) this.waiting.splice(waitingAt, 1)
    if (task.slot) {
      task.slot = false
      this.running -= 1
    }
    for (const release of task.releases.splice(0)) release()
    task.progress = undefined
    task.stopping = false
    this.port.pin(task.id, false)
    this.pump()
    void this.finish(task, task.run, task.done, end)
  }

  private async finish(task: TaskState, run: number, done: Deferred, end: RunEnd): Promise<void> {
    const result = end.noRun ? undefined : await this.port.lastText(task.id, end.fromTipId).catch(() => undefined)
    // 收尾期间又续跑了:这份结果属于上一轮,不许写进新一轮。
    if (task.run !== run) return done.resolve()
    task.result = result
    this.log(task, `\n[${task.status}]${task.error ? ` ${task.error}` : ""}\n`)
    void this.port.recordMeta(task.id, { status: task.status }).catch(() => {})
    this.emit(task)
    done.resolve()
    if (task.background) await this.notify(task)
    // 前台:结果作为工具结果交回了,不再通知(CC 同款)。
    else task.notified = true
  }

  /**
   * 通知(§6.4)。原子地查并置 notified(CC 同款去重),再按父会话串行投递:steer 进收件箱(持久化,从这一刻起
   * 内核崩了也不丢),父空闲就叫醒它。
   */
  private async notify(task: TaskState): Promise<void> {
    if (task.notified || this.closing) return
    task.notified = true
    void this.port.recordMeta(task.id, { notified: true }).catch(() => {})
    const status = task.status as Terminal
    const usage = this.usage(task)
    const message = createCustomMessage(
      TASK_NOTIFICATION_TYPE,
      formatTaskNotification({
        taskID: task.id,
        ...(task.toolCallID && !task.resumed ? { toolCallID: task.toolCallID } : {}),
        outputFile: task.outputFile,
        status,
        description: task.description,
        ...(task.error ? { error: task.error } : {}),
        ...(task.result ? { result: task.result } : {}),
        usage,
      }),
      true,
      { taskID: task.id, agent: task.agent, description: task.description, status, usage },
      Date.now(),
    )
    const parentID = task.parentID
    const previous = this.deliveries.get(parentID) ?? Promise.resolve()
    const next = previous.then(() => this.port.deliver(parentID, message))
    const tail = next.catch((error: unknown) => {
      this.port.emit([
        {
          type: "kernel.error",
          sessionID: parentID,
          message: `子 agent「${task.description}」的结果没能送回主会话:${(error as Error)?.message ?? String(error)}`,
        },
      ])
    })
    this.deliveries.set(parentID, tail)
    await tail
    if (this.deliveries.get(parentID) === tail) this.deliveries.delete(parentID)
  }

  // -------------------------------------------------------------------------
  // 停止 / 转后台 / 续跑 / 查结果
  // -------------------------------------------------------------------------

  /** 停掉一个任务:排队中的直接落定为 killed;在跑的请求中止,落定走子会话的 run_end。 */
  private async kill(task: TaskState): Promise<void> {
    if (task.status === "pending") {
      this.settle(task, { status: "killed", noRun: true })
      return
    }
    if (task.status !== "running") return
    task.stopping = true
    await this.port.abort(task.id).catch(() => {})
  }

  /** 界面的停止键(task.stop RPC):不限父会话。 */
  async stop(taskID: string): Promise<StopOutcome> {
    const task = this.tasks.get(taskID)
    if (!task) return { ok: false, reason: "not_found" }
    return this.stopTask(task)
  }

  private async stopFor(parentID: string, taskID: string, profiles: readonly AgentProfile[]): Promise<StopOutcome> {
    const task = await this.lookup(parentID, taskID, profiles)
    if (!task) return { ok: false, reason: "not_found" }
    return this.stopTask(task)
  }

  private async stopTask(task: TaskState): Promise<StopOutcome> {
    if (!isActive(task.status)) return { ok: false, reason: "not_running", status: task.status }
    // CC stopTask.ts:65-68:停 agent 任务不压通知 —— 后台的照常带着部分结果发 killed。
    await this.kill(task)
    return { ok: true, task: this.snapshot(task) }
  }

  /**
   * 转后台(卡片上的按钮 / 自动转后台):解除父的中止挂接,前台那次 agent 调用立刻以 async_launched 返回;
   * 子会话不停、不重跑(CC 要重跑 runAgent,yoma 的子 agent 本来就是独立会话)。挂着的确认撤掉 —— 后台问不了用户。
   */
  moveToBackground(taskOrID: TaskState | string): boolean {
    const task = typeof taskOrID === "string" ? this.tasks.get(taskOrID) : taskOrID
    if (!task || !this.options.background || task.background || !isActive(task.status)) return false
    task.background = true
    for (const release of task.releases.splice(0)) release()
    task.progress = undefined
    this.port.cancelConfirms(task.id)
    task.backgrounded.resolve()
    void this.port.recordMeta(task.id, { background: true }).catch(() => {})
    this.emit(task)
    return true
  }

  private prepareResume(task: TaskState): void {
    task.resumed = true
    task.background = this.options.background
    task.notified = false
    task.stopping = false
    task.done = deferred()
    task.backgrounded = deferred()
  }

  private async send(
    parentID: string,
    to: string,
    message: string,
    options: { summary?: string; signal: AbortSignal | undefined },
    profiles: readonly AgentProfile[],
  ): Promise<SendOutcome> {
    const task = await this.lookup(parentID, to, profiles)
    if (!task) return { kind: "not_found" }
    if (task.status === "pending") {
      // 还没开跑:不往它的收件箱里放 —— 下一次 accept 会把收件箱排在任务书**之前**。攒着,开跑时接在后面。
      task.extra.push(message)
      this.log(task, `\n--- message (queued) ---\n${message}\n\n`)
      return { kind: "queued", task: this.snapshot(task) }
    }
    if (task.status === "running") {
      await this.port.steer(task.id, message)
      this.log(task, `\n--- message (queued) ---\n${message}\n\n`)
      return { kind: "queued", task: this.snapshot(task) }
    }
    // 已经结束 / 被停:续跑。一律后台(CC 同款);宿主不能后台时前台跑完、结果直接交回。
    const previousStatus = task.status
    this.prepareResume(task)
    if (!this.options.background) this.attachForeground(task, options.signal, undefined)
    this.schedule(task, { prompt: message, first: false })
    if (this.options.background) return { kind: "resumed", task: this.snapshot(task), previousStatus }
    return { kind: "resumed_foreground", outcome: await this.awaitForeground(task) }
  }

  private async output(
    parentID: string,
    taskID: string,
    options: { block: boolean; timeoutMs: number; signal: AbortSignal | undefined },
    profiles: readonly AgentProfile[],
  ): Promise<TaskOutputView | undefined> {
    const task = await this.lookup(parentID, taskID, profiles)
    if (!task) return undefined
    if (isActive(task.status) && options.block) await this.waitDone(task, options.timeoutMs, options.signal)
    // 已落定但结果还在取(settle 与 finish 之间):等那一小段,别交出一个空结果。
    if (!isActive(task.status) && !task.done.settled) await task.done.promise
    if (!isActive(task.status) && task.result === undefined) {
      task.result = await this.port.lastText(task.id, undefined).catch(() => undefined)
    }
    const active = isActive(task.status)
    return {
      retrieval_status: active ? (options.block ? "timeout" : "not_ready") : "success",
      task: {
        task_id: task.id,
        task_type: "local_agent",
        status: task.status,
        description: task.description,
        prompt: task.prompt,
        ...(task.result !== undefined ? { output: task.result } : {}),
        ...(task.error ? { error: task.error } : {}),
      },
    }
  }

  private waitDone(task: TaskState, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, timeoutMs)
      const onAbort = () => finish()
      function finish() {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      if (signal?.aborted) return finish()
      signal?.addEventListener("abort", onAbort, { once: true })
      void task.done.promise.then(finish)
    })
  }

  /**
   * 按 id 找这个父会话的任务。注册表里没有(进程重启过)就从子会话自己的元数据重建 —— CC 同理:任务从内存淘汰后
   * 从磁盘 transcript 恢复。重建出来的任务已落定;进程死在运行中的那一轮在重开时被 abort 了,按 killed 算。
   */
  private async lookup(parentID: string, taskID: string, profiles: readonly AgentProfile[]): Promise<TaskState | undefined> {
    const known = this.tasks.get(taskID)
    if (known) return known.parentID === parentID ? known : undefined
    const meta = await this.port.childMeta(parentID, taskID).catch(() => undefined)
    if (!meta || this.tasks.has(taskID)) return this.tasks.get(taskID)
    const task = this.register({
      id: taskID,
      parentID,
      toolCallID: meta.toolCallId,
      agent: meta.agent,
      description: meta.description,
      prompt: "",
      oneShot: profiles.find((profile) => profile.name === meta.agent)?.oneShot === true,
      background: meta.background,
      status: meta.status && !isActive(meta.status) ? meta.status : "killed",
      notified: true,
    })
    task.done.resolve()
    return task
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 父会话被删:先停掉它的任务,再从注册表里拿掉(子会话由 SessionManager 级联删)。 */
  async forgetParent(parentID: string): Promise<void> {
    const owned = [...this.tasks.values()].filter((task) => task.parentID === parentID)
    for (const task of owned) {
      // 删会话不该再往一个要删掉的父会话里投通知。
      task.notified = true
      await this.kill(task)
    }
    for (const task of owned) this.tasks.delete(task.id)
    this.deliveries.delete(parentID)
  }

  /** 子会话被单独删掉。 */
  async forgetTask(childID: string): Promise<void> {
    const task = this.tasks.get(childID)
    if (!task) return
    task.notified = true
    await this.kill(task)
    this.tasks.delete(childID)
  }

  /** 进程要退:不再派生、不再投通知;排队中的直接落定。在跑的由会话的销毁去停。 */
  shutdown(): void {
    this.closing = true
    // 先整体摘下再逐个落定:settle 自己也会从 waiting 里删,边遍历边删会漏掉一半。
    for (const task of this.waiting.splice(0)) this.settle(task, { status: "killed", noRun: true })
  }

  // -------------------------------------------------------------------------
  // 视图与日志
  // -------------------------------------------------------------------------

  private usage(task: TaskState): TaskSnapshot["usage"] {
    return {
      totalTokens: task.totalTokens,
      toolUses: task.toolUses,
      durationMs: Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt),
    }
  }

  private snapshot(task: TaskState): TaskSnapshot {
    return {
      taskID: task.id,
      agent: task.agent,
      description: task.description,
      status: task.status,
      background: task.background,
      turns: task.turns,
      ...(task.lastTool ? { lastTool: task.lastTool } : {}),
      usage: this.usage(task),
      outputFile: task.outputFile,
      ...(task.maxTurnsReached ? { maxTurnsReached: true } : {}),
    }
  }

  private view(task: TaskState): TaskView {
    return {
      id: task.id,
      parentID: task.parentID,
      agent: task.agent,
      description: task.description,
      status: task.status,
      background: task.background,
      startedAt: task.startedAt,
      ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
      turns: task.turns,
      ...(task.lastTool ? { lastTool: task.lastTool } : {}),
      usage: this.usage(task),
      outputFile: task.outputFile,
      ...(task.maxTurnsReached ? { maxTurnsReached: true } : {}),
      ...(task.error ? { error: task.error } : {}),
    }
  }

  private emit(task: TaskState): void {
    this.port.emit([{ type: "task.updated", task: this.view(task) }])
  }

  private async prepareOutput(task: TaskState): Promise<void> {
    try {
      await mkdir(path.dirname(task.outputFile), { recursive: true })
      await writeFile(task.outputFile, "", "utf8")
    } catch {
      // 日志只是给人和模型看进度的;写不了不该挡住派生。
    }
  }

  /** 追写 output_file。一条任务一条写队列,顺序即事件顺序;写失败不影响任务本身。 */
  private log(task: TaskState, text: string): void {
    task.writes = task.writes.then(() => appendFile(task.outputFile, text, "utf8")).catch(() => {})
  }
}
