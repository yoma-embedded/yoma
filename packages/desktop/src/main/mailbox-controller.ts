/**
 * 信箱调试台的任务控制器 —— main 侧纯逻辑,不 import electron。
 *
 * updater-controller 同款分层:spawn / 杀树 / 硬件锁 / 广播 / 持久化全部注入,
 * 单测直接跑。控制器管四件事:
 *
 * 1. **一次一个任务**:一个信箱一个任务、每角色单实例是协议前提(引擎有 pid 锁,
 *    这里是产品层的第一道闸 —— 用户连点"开跑"不该走到锁冲突那么深)。
 * 2. **崩溃重启带退避**,但只对常驻角色(runner/mother):它们的协议天然可续。
 *    锁冲突(退出码 3)不重启 —— 活着的持有者在别处,轮询式抢锁只会刷屏。
 * 3. **探针互斥的生命周期**:runner 任务活跃(含重启间隙)= 交互内核的硬件工具
 *    锁着;终局/停止才撤。sim(本机演练)是假模型,不碰硬件,不锁。
 * 4. **事件转发**:守护的 @@event 原样广播(全是普通对象,能过 contextBridge),
 *    快照与终局缓存在 status 里,renderer 随时拉得到当前真相。
 */

import type { MailboxHostConfig, MailboxHostEvent, MailboxUiSnapshot, MailboxVerdict } from "@yoma-desktop/bench"

export type MailboxRole = "runner" | "mother"
export type MailboxTaskKind = MailboxRole | "sim" | "init"

export interface MailboxSettings {
  /** 信箱 git 远端(私有仓 URL 或本地裸仓路径)。凭据走系统 git,桌面端不代管。 */
  remote: string
  /** 本机角色:工位(连板子)或决策(跑母 agent)。 */
  role: MailboxRole
  branch?: string
  pollSeconds?: number
}

export interface MailboxTaskRequest {
  kind: MailboxTaskKind
  /** init 必填;sim 缺省用接线层生成的内置演练任务(假模型,不碰硬件不花钱)。 */
  jobFile?: string
  /** sim:清掉上次演练从头来。 */
  fresh?: boolean
}

export interface MailboxStatus {
  settings?: MailboxSettings
  phase: "idle" | "running" | "stopping" | "done" | "error"
  task?: { kind: MailboxTaskKind; startedAt: number; restarts: number; pid?: number }
  snapshot?: MailboxUiSnapshot
  done?: { exitCode: number; detail: string; verdict?: MailboxVerdict }
  /** 给人看的一句话(锁冲突、崩溃重启中……)。 */
  message?: string
}

export type MailboxPublicEvent = { type: "host"; event: MailboxHostEvent } | { type: "status"; status: MailboxStatus }

export interface MailboxLaunchHandle {
  pid?: number
}

export interface MailboxControllerDeps {
  /** 起守护进程(写配置文件 + spawn),行与退出通过回调回来。 */
  launch(
    config: MailboxHostConfig,
    io: { onLine(line: string): void; onExit(code: number | null): void },
  ): MailboxLaunchHandle
  /** 停守护:必须是**整棵进程树**的语义(Windows 上 taskkill /T)。 */
  stopProcess(handle: MailboxLaunchHandle, force: boolean): void
  /** 探针互斥开关(驱动交互内核的 mailbox.setActive)。 */
  setHardwareLock(active: boolean): void
  broadcast(event: MailboxPublicEvent): void
  persistence: { get(): MailboxSettings | undefined; set(settings: MailboxSettings): void }
  /** 把任务请求补全成守护配置(clone 目录、bundle 路径这些只有接线层知道)。 */
  buildConfig(settings: MailboxSettings, task: MailboxTaskRequest): MailboxHostConfig
  now?(): number
  /** 定时器注入(测试拨快钟)。返回取消函数。 */
  schedule?(fn: () => void, ms: number): () => void
}

/** 崩溃重启退避:5s 起步,翻倍,封顶 60s。 */
export function restartDelayMs(restarts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, restarts - 1), 60_000)
}

interface ActiveTask {
  kind: MailboxTaskKind
  request: MailboxTaskRequest
  startedAt: number
  restarts: number
  handle?: MailboxLaunchHandle
  userStopped: boolean
  done?: { exitCode: number; detail: string; verdict?: MailboxVerdict }
  cancelRestart?: () => void
}

export class MailboxController {
  private readonly deps: MailboxControllerDeps
  private settings?: MailboxSettings
  private task?: ActiveTask
  private phase: MailboxStatus["phase"] = "idle"
  private snapshot?: MailboxUiSnapshot
  private message?: string
  private lockActive = false

  constructor(deps: MailboxControllerDeps) {
    this.deps = deps
    this.settings = deps.persistence.get()
  }

  status(): MailboxStatus {
    return {
      settings: this.settings,
      phase: this.phase,
      task: this.task
        ? { kind: this.task.kind, startedAt: this.task.startedAt, restarts: this.task.restarts, pid: this.task.handle?.pid }
        : undefined,
      snapshot: this.snapshot,
      done: this.task?.done,
      message: this.message,
    }
  }

  /** 探针互斥当前该不该锁着 —— 内核进程重启后接线层用它重申。 */
  hardwareLockActive(): boolean {
    return this.lockActive
  }

  configure(settings: MailboxSettings): { ok: true } | { ok: false; message: string } {
    if (!settings.remote?.trim()) return { ok: false, message: "信箱远端不能为空" }
    if (settings.role !== "runner" && settings.role !== "mother") return { ok: false, message: `角色不认识:${String(settings.role)}` }
    if (this.phase === "running" || this.phase === "stopping") {
      return { ok: false, message: "任务进行中,先停止再改配置 —— 换信箱等于换任务" }
    }
    this.settings = { ...settings, remote: settings.remote.trim() }
    this.deps.persistence.set(this.settings)
    this.pushStatus()
    return { ok: true }
  }

  start(request: MailboxTaskRequest): { ok: true } | { ok: false; message: string } {
    if (!this.settings && request.kind !== "sim") return { ok: false, message: "先配置信箱远端与角色" }
    if (this.phase === "running" || this.phase === "stopping") {
      return { ok: false, message: "已有任务在跑 —— 一个信箱同一时间只有一个任务" }
    }
    if (request.kind === "init" && !request.jobFile) {
      return { ok: false, message: "init 需要任务书(jobFile)" }
    }
    const settings = this.settings ?? { remote: "", role: "runner" }
    this.task = {
      kind: request.kind,
      request,
      startedAt: (this.deps.now ?? Date.now)(),
      restarts: 0,
      userStopped: false,
    }
    this.snapshot = undefined
    this.message = undefined
    this.phase = "running"
    // 探针互斥只跟 runner 走:工位任务真的会占探针;mother/init 不碰硬件,
    // sim 是假模型演练。锁在重启间隙保持 —— 孙进程可能还活着。
    this.setLock(request.kind === "runner")
    this.spawn()
    this.pushStatus()
    return { ok: true }
  }

  stop(): { ok: true } | { ok: false; message: string } {
    const task = this.task
    if (!task || (this.phase !== "running" && this.phase !== "stopping")) return { ok: false, message: "没有在跑的任务" }
    task.userStopped = true
    task.cancelRestart?.()
    this.phase = "stopping"
    this.pushStatus()
    if (task.handle) this.deps.stopProcess(task.handle, false)
    else this.finishStopped()
    return { ok: true }
  }

  private spawn(): void {
    const task = this.task!
    const config = this.deps.buildConfig(this.settings ?? { remote: "", role: "runner" }, task.request)
    task.done = undefined
    task.handle = this.deps.launch(config, {
      onLine: (line) => this.handleLine(task, line),
      onExit: (code) => this.handleExit(task, code),
    })
  }

  private handleLine(task: ActiveTask, line: string): void {
    if (this.task !== task) return
    if (!line.startsWith("@@event ")) return
    let event: MailboxHostEvent
    try {
      event = JSON.parse(line.slice("@@event ".length)) as MailboxHostEvent
    } catch {
      return
    }
    // sim 的 child 事件里也有快照 —— 展开一层,进度页不用关心事件来自哪层进程。
    const effective = event.type === "child" ? event.event : event
    if (effective.type === "snapshot") this.snapshot = effective.snapshot
    if (effective.type === "done" && event.type !== "child") task.done = effective
    this.deps.broadcast({ type: "host", event })
    if (effective.type === "snapshot" || effective.type === "done") this.pushStatus()
  }

  private handleExit(task: ActiveTask, code: number | null): void {
    if (this.task !== task) return
    task.handle = undefined

    if (task.userStopped) {
      this.finishStopped()
      return
    }
    const done = task.done
    if (done?.verdict) {
      // 正常终局(passed/failed/parked)。runner 的收尾(回刷/交付)已经做完才有 verdict。
      this.phase = "done"
      this.message = undefined
      this.setLock(false)
      this.pushStatus()
      return
    }
    if (done && done.exitCode === 3) {
      // 单实例锁冲突:活着的持有者在别的进程/别的 Yoma 实例。轮询抢锁只会刷屏。
      this.phase = "error"
      this.message = `另一个 Yoma 实例正在跑这个信箱(${done.detail})—— 关掉那边或等它结束`
      this.setLock(false)
      this.pushStatus()
      return
    }
    if (task.kind === "init" || task.kind === "sim") {
      // 一次性任务:退出即终局,失败如实报,不自动重跑。
      this.phase = done && done.exitCode === 0 ? "done" : "error"
      this.message = done?.detail ?? `守护进程异常退出(code ${code ?? "?"})`
      this.setLock(false)
      this.pushStatus()
      return
    }
    // 常驻角色异常退出:退避重启。协议可续(状态在信箱与本地 ignored 目录里),
    // 重启就是"重新执行同一条命令"。
    task.restarts += 1
    const delay = restartDelayMs(task.restarts)
    this.message = `守护进程异常退出(code ${code ?? "?"}),${Math.round(delay / 1000)}s 后重启(第 ${task.restarts} 次)`
    this.pushStatus()
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
    task.cancelRestart = schedule(() => {
      if (this.task !== task || task.userStopped) return
      this.message = undefined
      this.spawn()
      this.pushStatus()
    }, delay)
  }

  private finishStopped(): void {
    this.phase = "idle"
    this.message = "已停止"
    this.setLock(false)
    this.task = undefined
    this.pushStatus()
  }

  private setLock(active: boolean): void {
    if (this.lockActive === active) return
    this.lockActive = active
    this.deps.setHardwareLock(active)
  }

  private pushStatus(): void {
    this.deps.broadcast({ type: "status", status: this.status() })
  }
}
