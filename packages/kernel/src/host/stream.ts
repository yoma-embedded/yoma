/**
 * 事件流:合并 + 成批推送。
 *
 * 内核在一次流式回答里能发出几千条事件。逐条过 IPC 会把 renderer 的调度打爆,
 * 所以这里做两件事:把同一个 part 的重复快照折叠成最后一条、把连续的 delta 串起来,
 * 然后按帧(~16ms)推一批。这份逻辑原先在前端 server-sdk.tsx:20-72,现在下沉到 host ——
 * 越早合并,跨进程的数据越少。
 *
 * ## 合并绝不能打乱顺序
 *
 * 只折叠 **同一个 key 的相邻同类事件**,不做跨类型重排。因为前端 reducer 依赖:
 *   - 父 message.updated 早于它的任何 part 事件(否则孤儿 part 被静默丢弃);
 *   - part 的 message.part.updated 早于该 part 的 delta(否则 delta 被静默丢弃)。
 * 一旦这里按 key 分桶再拼接,上面两条就会被破坏,而且不报错。
 */

import type { KernelEvent } from "../protocol.ts"

export interface StreamSinkOptions {
  /** 推一批出去。 */
  flush(events: KernelEvent[]): void
  /** 合并窗口,毫秒。默认一帧。 */
  intervalMs?: number
  /** 单批上限 —— 超过就立刻推,避免一次巨量回答攒出一个几十 MB 的批。 */
  maxBatch?: number
}

export class StreamSink {
  private readonly options: Required<StreamSinkOptions>
  private queue: KernelEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(options: StreamSinkOptions) {
    this.options = {
      intervalMs: options.intervalMs ?? 16,
      maxBatch: options.maxBatch ?? 2000,
      flush: options.flush,
    }
  }

  push(events: KernelEvent | KernelEvent[]): void {
    if (this.closed) return
    if (Array.isArray(events)) {
      if (!events.length) return
      for (const event of events) this.enqueue(event)
    } else {
      this.enqueue(events)
    }
    if (this.queue.length >= this.options.maxBatch) {
      this.flushNow()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flushNow()
      }, this.options.intervalMs)
      // 别让这个定时器把 utilityProcess 吊住不退出。
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  /**
   * 入队时就地合并。只看队尾一条,所以严格保序 —— 中间隔了别的事件就不合并。
   */
  private enqueue(event: KernelEvent): void {
    const tail = this.queue[this.queue.length - 1]
    if (tail) {
      // 同一个 part 的连续快照:后一条已经包含前一条的全部信息。
      if (
        tail.type === "message.part.updated" &&
        event.type === "message.part.updated" &&
        tail.part.id === event.part.id
      ) {
        this.queue[this.queue.length - 1] = event
        return
      }
      // 同一个 part 的连续 delta:直接拼字符串,少发几百条。
      if (
        tail.type === "message.part.delta" &&
        event.type === "message.part.delta" &&
        tail.partID === event.partID &&
        tail.field === event.field
      ) {
        this.queue[this.queue.length - 1] = { ...tail, delta: tail.delta + event.delta }
        return
      }
      // 同一条消息的连续 message.updated(usage 逐步填充时会连发)。
      if (tail.type === "message.updated" && event.type === "message.updated" && tail.message.id === event.message.id) {
        this.queue[this.queue.length - 1] = event
        return
      }
    }
    this.queue.push(event)
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.queue.length) return
    const batch = this.queue
    this.queue = []
    this.options.flush(batch)
  }

  close(): void {
    this.flushNow()
    this.closed = true
  }
}
