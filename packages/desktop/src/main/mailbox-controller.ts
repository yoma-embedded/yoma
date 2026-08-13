/**
 * 信箱调试台的任务控制器 —— main 侧纯逻辑,不 import electron。
 *
 * updater-controller 同款分层:spawn / 杀树 / 广播 / 持久化全部注入,
 * 单测直接跑。控制器管三件事:
 *
 * 1. **一次一个任务**:一个信箱一个任务、每角色单实例是协议前提(引擎有 pid 锁,
 *    这里是产品层的第一道闸 —— 用户连点"开跑"不该走到锁冲突那么深)。
 * 2. **崩溃重启带退避**,但只对常驻角色(runner/mother):它们的协议天然可续。
 *    锁冲突(退出码 3)不重启 —— 活着的持有者在别处,轮询式抢锁只会刷屏。
 * 3. **事件转发**:守护的 @@event 原样广播(全是普通对象,能过 contextBridge),
 *    快照与终局缓存在 status 里,renderer 随时拉得到当前真相。
 */

import type { MailboxHostConfig, MailboxHostEvent, MailboxUiSnapshot, MailboxVerdict } from "@yoma-desktop/bench"

export type MailboxRole = "runner" | "mother"
export type MailboxTaskKind = MailboxRole | "sim" | "init"

export interface MailboxSettings {
  /** 信箱 git 远端(私有仓 URL 或本地裸仓路径)。凭据走系统 git,桌面端不代管。 */
  remote: string
  /** 本机角色:工位端(连板子、只观察)或研发端(改代码、出指令)。 */
  role: MailboxRole
  branch?: string
  pollSeconds?: number
  /**
   * **这台机器上**的工程检出目录。信箱里的任务书不带绝对路径(它在别人机器上没
   * 意义),两侧各自配自己的位置 —— 这是"同一份任务书跨 Mac/Windows"的支点。
   */
  projectDir?: string
}

export interface MailboxTaskRequest {
  kind: MailboxTaskKind
  /** init 必填;sim 缺省用接线层生成的内置演练任务(假模型,不碰硬件不花钱)。 */
  jobFile?: string
  /** sim:清掉上次演练从头来。 */
  fresh?: boolean
  /**
   * init 终局后自动接起本机常驻角色(任务页"入箱并开跑"的后半程)。
   *
   * 接力**必须由 main 持有**:它原来住在页面组件的 store 里,而 init 是 clone+push,
   * 慢网络下能跑几分钟 —— 期间用户点去别的页面(或 reload 窗口)组件就卸载了,
   * 接力随之蒸发,任务停在"已入箱但没人执行",界面上还什么都不说。
   *
   * 角色取**已保存的** settings.role,不由调用方指定:renderer 的表单可能是改了
   * 没保存的中间状态,照它起守护会得到一个与配置不符的角色。
   */
  thenStart?: boolean
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
  broadcast(event: MailboxPublicEvent): void
  persistence: { get(): MailboxSettings | undefined; set(settings: MailboxSettings): void }
  /** 把任务请求补全成守护配置(clone 目录、bundle 路径这些只有接线层知道)。 */
  buildConfig(settings: MailboxSettings, task: MailboxTaskRequest): MailboxHostConfig
  /**
   * 本机工程目录的**实际取值**(接线层的口径:已保存的配置 → composeJob 推导的
   * 项目根)。开跑前的护栏要问它而不是直接读 settings —— 出题的机器往往没手填过
   * 这一项,而它有推导出来的兜底,拿 settings 判就会把主路拦死。
   */
  projectDir?(settings: MailboxSettings): string | undefined
  now?(): number
  /** 定时器注入(测试拨快钟)。返回取消函数。 */
  schedule?(fn: () => void, ms: number): () => void
  /**
   * 系统通知。只用在**闭环挂起等人**这一件事上:那一刻没人再推进任何东西,
   * 而要动手的人多半没盯着这个窗口 —— 不主动喊一声,挂起就等于卡死。
   */
  notify?(payload: { title: string; body: string }): void
}

/** 崩溃重启退避:5s 起步,翻倍,封顶 60s。 */
export function restartDelayMs(restarts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, restarts - 1), 60_000)
}

/**
 * 连续这么多次"起来就死"之后放弃重启。
 *
 * 退避重启假设故障是瞬时的(网络、远端抽风);产物缺失、node 加载失败这类
 * **永久性**故障永远重试不好,而重试期间 phase 一直是 running,
 * 屏幕上只有一句 code 1 —— 用户看到的是"任务在跑",实际什么都没发生。
 */
const MAX_RESTARTS = 5

/** 守护活过这么久才算"真的跑起来过",据此把重启计数清零。 */
const HEALTHY_MS = 60_000

interface ActiveTask {
  kind: MailboxTaskKind
  request: MailboxTaskRequest
  startedAt: number
  restarts: number
  handle?: MailboxLaunchHandle
  userStopped: boolean
  done?: { exitCode: number; detail: string; verdict?: MailboxVerdict }
  cancelRestart?: () => void
  /** 本次 spawn 的时刻 —— 用来区分"跑了一阵才崩"和"起来就死"。 */
  spawnedAt: number
}

export class MailboxController {
  private readonly deps: MailboxControllerDeps
  private settings?: MailboxSettings
  private task?: ActiveTask
  private phase: MailboxStatus["phase"] = "idle"
  private snapshot?: MailboxUiSnapshot
  /** 已经为哪一轮的挂起喊过人(快照会重发,同一次挂起只响一下)。 */
  private announcedPark?: number
  private message?: string

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

  /** 本机工程目录的实际取值。没注入解析器时就是已保存的那一项。 */
  private effectiveProjectDir(): string | undefined {
    const settings = this.settings
    if (!settings) return undefined
    return (this.deps.projectDir?.(settings) ?? settings.projectDir)?.trim() || undefined
  }

  configure(settings: MailboxSettings): { ok: true } | { ok: false; message: string } {
    if (!settings.remote?.trim()) return { ok: false, message: "信箱远端不能为空" }
    if (settings.role !== "runner" && settings.role !== "mother") return { ok: false, message: `角色不认识:${String(settings.role)}` }
    if (this.phase === "running" || this.phase === "stopping") {
      return { ok: false, message: "任务进行中,先停止再改配置 —— 换信箱等于换任务" }
    }
    // projectDir **不在这里拦**:保存设置是个随手动作(先填远端、回头再填目录),
    // 拦在这一步等于逼人一次填全。真正需要它的时刻是开跑,护栏压在 start()。
    this.settings = { ...settings, remote: settings.remote.trim(), projectDir: settings.projectDir?.trim() || undefined }
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
    // 角色必须与配置一致:工位机上误起研发端守护(或反过来)会得到一个对着同一个
    // 信箱说错话的进程,而症状是"任务一直没人执行"这种很难归因的安静失败。
    if ((request.kind === "runner" || request.kind === "mother") && this.settings && this.settings.role !== request.kind) {
      const label = (role: MailboxRole) => (role === "runner" ? "工位端" : "研发端")
      return {
        ok: false,
        message: `本机角色是${label(this.settings.role)},不能起${label(request.kind)}守护 —— 去配置页改角色再来`,
      }
    }
    // 研发端要在**本机**的工程检出上改代码,而任务书里没有路径。缺了就在这里说
    // 人话:不然守护起得来、轮询也在跑,直到第一轮才在守护日志里报"没配工程目录"。
    // 工位端不需要 —— 它没有项目检出,拿到的东西全是信箱附件。
    if (request.kind === "mother" && !this.effectiveProjectDir()) {
      return {
        ok: false,
        message:
          "研发端要在本机的工程检出上改代码,但还没配工程目录 —— 去配置页填「工程目录(仅研发端)」。信箱里的任务书不带绝对路径,它在别人机器上没意义,所以每台机器各配各的",
      }
    }
    const now = (this.deps.now ?? Date.now)()
    this.task = {
      kind: request.kind,
      request,
      startedAt: now,
      spawnedAt: now,
      restarts: 0,
      userStopped: false,
    }
    this.snapshot = undefined
    this.message = undefined
    this.phase = "running"
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
    task.spawnedAt = (this.deps.now ?? Date.now)()
    try {
      task.handle = this.deps.launch(config, {
        onLine: (line) => this.handleLine(task, line),
        onExit: (code) => this.handleExit(task, code),
      })
    } catch (error) {
      // launch 同步抛(产物路径不可写、spawn 参数非法)时不会有 onExit,
      // 不接住就是 phase 永远卡在 running。
      this.phase = "error"
      this.message = `守护进程起不来:${(error as Error).message}`
      this.task = undefined
      this.pushStatus()
    }
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
    if (effective.type === "snapshot") {
      this.snapshot = effective.snapshot
      this.announceIfParked(effective.snapshot)
    }
    if (effective.type === "done" && event.type !== "child") task.done = effective
    this.deps.broadcast({ type: "host", event })
    if (effective.type === "snapshot" || effective.type === "done") this.pushStatus()
  }

  /**
   * 挂起时喊一声人。
   *
   * 按轮次去重:快照每几秒重发一次,而同一次挂起只该响一下。回执落地后状态会滑回
   * awaiting-mother,这里的记号跟着清掉 —— 下一次挂起(哪怕还是这一轮)照样会响。
   */
  private announceIfParked(snapshot: MailboxUiSnapshot): void {
    const state = snapshot.state
    if (state.kind !== "awaiting-human") {
      this.announcedPark = undefined
      return
    }
    if (this.announcedPark === state.round) return
    this.announcedPark = state.round
    this.deps.notify?.({
      title: `信箱闭环挂起:第 ${state.round} 轮等人动手`,
      body: state.ask.split("\n")[0]!.slice(0, 200),
    })
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
      this.pushStatus()
      return
    }
    // init 成功 → 自动接起本机常驻角色。接力在 main 手里,与 UI 是否还开着无关。
    if (task.kind === "init" && done?.exitCode === 0 && task.request.thenStart && this.settings) {
      const role = this.settings.role
      this.phase = "idle"
      this.task = undefined
      const started = this.start({ kind: role })
      if (!started.ok) {
        this.phase = "error"
        this.message = `任务已入箱,但守护没起来:${started.message}`
        this.pushStatus()
      }
      return
    }
    if (done && done.exitCode === 3) {
      // 单实例锁冲突:活着的持有者在别的进程/别的 Yoma 实例。轮询抢锁只会刷屏。
      this.phase = "error"
      this.message = `另一个 Yoma 实例正在跑这个信箱(${done.detail})—— 关掉那边或等它结束`
      this.pushStatus()
      return
    }
    if (task.kind === "init" || task.kind === "sim") {
      // 一次性任务:退出即终局,失败如实报,不自动重跑。
      this.phase = done && done.exitCode === 0 ? "done" : "error"
      this.message = done?.detail ?? `守护进程异常退出(code ${code ?? "?"})`
      this.pushStatus()
      return
    }
    // 常驻角色异常退出:退避重启。协议可续(状态在信箱与本地 ignored 目录里),
    // 重启就是"重新执行同一条命令"。
    // 活过一分钟才崩的算"跑起来过",计数清零 —— 长跑任务不该被历史崩溃拖进上限。
    const now = (this.deps.now ?? Date.now)()
    task.restarts = now - task.spawnedAt >= HEALTHY_MS ? 1 : task.restarts + 1
    if (task.restarts > MAX_RESTARTS) {
      // 起来就死重复这么多次,故障是永久性的(产物缺失、node 加载失败……),
      // 继续退避只是把 phase 一直显示成 running。
      this.phase = "error"
      this.message = `守护进程连续 ${MAX_RESTARTS} 次起来就退出(最后一次 code ${code ?? "?"})—— 不再重试。${
        done?.detail ?? "看日志:userData/logs"
      }`
      this.pushStatus()
      return
    }
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
    this.task = undefined
    this.pushStatus()
  }

  private pushStatus(): void {
    this.deps.broadcast({ type: "status", status: this.status() })
  }
}
