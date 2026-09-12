/**
 * 确认台:契约说要问的工具(今天只有 flash)跑之前,把"要不要跑"挂起交给人回答。
 *
 * 为什么单独一个文件而不是写在钩子里:挂起这件事有四种结局(允许 / 拒绝 / 会话被关 / 没人答),
 * 其中三种在真会话里要么得等十分钟,要么得先把板子跑起来 —— 放进这里它们就都是纯函数级的测试。
 * 这个文件一点 harness、一点 node:* 都不碰,钩子那边于是只剩一句 await。
 *
 * 两条容易静默出错的地方:
 * - **每一次结算都要 emit 一条视图**。前端的确认条按 id 加、按"status 不是 pending"删;漏发一条的
 *   表现不是报错,是输入框上永远挂着一条答不掉的确认(而模型那边早就收到拒绝走了)。
 * - **绝不抛**。这里的 Promise 永远 resolve(拒绝就是 false):钩子里抛出去的异常会被内核转成
 *   kernel.error 红字(harness/hooks.ts 的 beforeTool catch 分支),用户点了个"拒绝"却看到"内核出错"。
 */

import type { ToolConfirmStatus, ToolConfirmView } from "../types.ts"

/** 一次询问的全部事实;"怎么结算的"由确认台补上(ToolConfirmView.status)。 */
export type ToolConfirmRequest = Omit<ToolConfirmView, "status">

export interface ConfirmDeskOptions {
  /** 每条视图一次调用(pending 一条,结算再一条)。由会话管理器翻成 `tool.confirm` 事件。 */
  emit(view: ToolConfirmView): void
  /**
   * 没人答多久算拒绝。缺省 10 分钟 —— 比"去焊两根线再回来"长,比"今天不回来了"短。
   * 不设上限的代价是一条挂死的确认把整个会话钉在 busy 上,而屏幕上那条确认条可能早被 reload 刷掉了。
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export type SettledStatus = Exclude<ToolConfirmStatus, "pending">

interface Waiting {
  view: ToolConfirmView
  settle(status: SettledStatus): void
}

export class ConfirmDesk {
  private readonly options: ConfirmDeskOptions
  /** 未决的询问,按 id。插入序就是提问序 —— 前端把最早的那条摆在最上面。 */
  private readonly waiting = new Map<string, Waiting>()

  constructor(options: ConfirmDeskOptions) {
    this.options = options
  }

  /**
   * 挂起等人回答,解出结算状态:allowed / denied / cancelled(会话被关或被停)/ expired(没人答)。
   * 分开给是因为对模型要说不同的话:拒绝是"别再问之前重试",超时只是"没人看屏幕"。
   *
   * signal 与 cancel() 是两条路,各自成立:signal 是 harness 交给钩子的 gate 信号(lane 中止时点它);
   * cancel() 覆盖信号不会来的路径 —— fail() 把状态打回 idle、操作已经不在飞、会话被关。
   * 两条都接,漏一条的表现都是"点停止没反应",直到十分钟超时才动。
   */
  ask(request: ToolConfirmRequest, signal: AbortSignal | undefined): Promise<SettledStatus> {
    // 已经在中止了:不挂起也不发事件 —— 这条询问没有任何人见过,发一条结算只是噪音。
    if (signal?.aborted) return Promise.resolve("cancelled")
    const view: ToolConfirmView = { ...request, status: "pending" }
    return new Promise<SettledStatus>((resolve) => {
      let done = false
      const settle = (status: SettledStatus): void => {
        if (done) return
        done = true
        this.waiting.delete(view.id)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.options.emit({ ...view, status })
        resolve(status)
      }
      const onAbort = (): void => settle("cancelled")
      const timer = setTimeout(() => settle("expired"), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      // 内核跑在 utilityProcess 里:一条没人答的确认不能把进程吊住不退(同 host/stream.ts)。
      ;(timer as { unref?: () => void }).unref?.()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiting.set(view.id, { view, settle })
      // 登记完再 emit:emit 是同步的,万一调用方就地回了一句答案,也找得到这条。
      this.options.emit(view)
    })
  }

  /**
   * 前端的回答。未知 id 返回 false 而不抛 —— 那通常只是点慢了(已超时 / 会话已关),
   * 对用户来说是"这条确认条自己没了",不是错误。
   */
  reply(id: string, allow: boolean): boolean {
    const waiting = this.waiting.get(id)
    if (!waiting) return false
    waiting.settle(allow ? "allowed" : "denied")
    return true
  }

  /** 未决的询问。事件不重放,所以首屏与 resync 都得能问一遍现状。 */
  pending(sessionID?: string): ToolConfirmView[] {
    const views = [...this.waiting.values()].map((waiting) => waiting.view)
    return sessionID === undefined ? views : views.filter((view) => view.sessionID === sessionID)
  }

  /**
   * 这个会话的未决询问一律按 cancelled 结算。
   *
   * stop、closeEntry、fail、run_end 各自都调(与 gate 信号两条路各自成立,别互相指望):挂起中的
   * 钩子占着 drive,取消与 waitForIdle 都得等它先回来;而 fail 把状态打回 idle 之后若还挂着一条,
   * 用户点"允许"会让一条已宣告失败的轮次真的去烧板。
   */
  cancel(sessionID: string): void {
    // 先把 id 抄出来再结算:settle 会就地从未决表里删自己,边遍历边删是能跑但读不出对错的写法。
    for (const id of this.pending(sessionID).map((view) => view.id)) this.waiting.get(id)?.settle("cancelled")
  }
}
