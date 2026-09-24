/**
 * 内核心跳的看门人(docs/调试留痕-规划-20260924.md §3.4)。
 *
 * 内核进程(utilityProcess)每 5 s 发一次心跳;main 这边定时看一眼,超过 20 s 没收到就在 kernel.log 记一笔
 * "内核没响应",恢复时再记一条带时长的。内核自己的事件循环检测(kernel 的 `host/trace/lag.ts`)只能在恢复之后写 ——
 * 整个卡死、再也不恢复的情形只有这边看得见,而那正是用户会直接关掉 app 的时候,证据得在关之前落盘。
 *
 * main 自己也可能被堵(同步写大文件、调试器停住):这一次检查比预期晚到超过一个间隔时不算 —— 心跳多半正在
 * 消息队列里排着,这时判"内核没响应"是冤枉它。纯逻辑,时间注入,计时器由调用方起。
 */

export interface HeartbeatWatchOptions {
  now?: () => number
  /** 调用方多久调一次 check,缺省 5 s。 */
  checkMs?: number
  /** 多久没心跳算没响应,缺省 20 s。 */
  silentMs?: number
  onSilent(silentMs: number): void
  onRecovered(stalledMs: number): void
}

export interface HeartbeatWatch {
  beat(): void
  check(): void
}

export function createHeartbeatWatch(options: HeartbeatWatchOptions): HeartbeatWatch {
  const now = options.now ?? Date.now
  const checkMs = options.checkMs ?? 5_000
  const silentMs = options.silentMs ?? 20_000
  let lastBeat = now()
  let lastCheck = now()
  let silent = false
  return {
    beat() {
      const at = now()
      if (silent) options.onRecovered(at - lastBeat)
      silent = false
      lastBeat = at
    },
    check() {
      const at = now()
      const late = at - lastCheck - checkMs
      lastCheck = at
      // main 自己被堵过:这一拍不算,心跳可能正在队列里等着被处理
      if (late > checkMs) return
      if (!silent && at - lastBeat >= silentMs) {
        silent = true
        options.onSilent(at - lastBeat)
      }
    },
  }
}
