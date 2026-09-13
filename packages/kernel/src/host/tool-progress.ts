/**
 * 工具进度的节流器:发动机的 `tool_update` 每收到一小块输出就来一次,而每一次投影出去的都是
 * **整张卡片**(part 带着到目前为止的全部输出)—— 不节流的话一条吐一万行的 bash 会把 O(n²) 的
 * 字节推过 IPC,渲染进程忙着 diff 一张越来越大的卡片,输入框跟着卡。
 *
 * 前沿立即发(第一块输出零延迟上屏),之后每 intervalMs 最多一次,尾沿把最后那份快照补出去
 * (工具结束前最后一块输出不能丢)。`settle` 在 tool_end 时取消尾沿:终态由消息投影给出,
 * 晚到的那一拍不该再把卡片碰一下 —— 投影器那边对非 running 态也是 no-op,两道保险。
 */

export interface ToolProgressSnapshot {
  content: Array<{ type: string; text?: string }>
  details?: unknown
}

export class ToolProgressThrottle {
  private readonly latest = new Map<string, ToolProgressSnapshot>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastFlushAt = new Map<string, number>()

  constructor(
    private readonly flush: (toolCallId: string, partial: ToolProgressSnapshot) => void,
    private readonly intervalMs = 100,
  ) {}

  push(toolCallId: string, partial: ToolProgressSnapshot): void {
    const now = Date.now()
    const last = this.lastFlushAt.get(toolCallId) ?? Number.NEGATIVE_INFINITY
    if (!this.timers.has(toolCallId) && now - last >= this.intervalMs) {
      this.lastFlushAt.set(toolCallId, now)
      this.flush(toolCallId, partial)
      return
    }
    this.latest.set(toolCallId, partial)
    if (this.timers.has(toolCallId)) return
    const timer = setTimeout(
      () => {
        this.timers.delete(toolCallId)
        const pending = this.latest.get(toolCallId)
        this.latest.delete(toolCallId)
        if (!pending) return
        this.lastFlushAt.set(toolCallId, Date.now())
        this.flush(toolCallId, pending)
      },
      Math.max(0, this.intervalMs - (now - last)),
    )
    timer.unref?.()
    this.timers.set(toolCallId, timer)
  }

  /** 这次调用结束了:丢掉还没发的尾沿,终态由消息投影给。 */
  settle(toolCallId: string): void {
    const timer = this.timers.get(toolCallId)
    if (timer) clearTimeout(timer)
    this.timers.delete(toolCallId)
    this.latest.delete(toolCallId)
    this.lastFlushAt.delete(toolCallId)
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.latest.clear()
    this.lastFlushAt.clear()
  }
}
