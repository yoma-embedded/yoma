/**
 * 内核事件循环被堵的检测(docs/调试留痕-规划-20260924.md §3.4)。
 *
 * 内核是一个进程伺候所有会话和界面的 RPC:谁在事件循环里同步干重活(大 JSON、spawnSync、同步读大文件),
 * 所有会话的流式输出、工具进度、界面请求就一起停住 —— 从外面看和"模型卡住了"一模一样。这里 1 秒一拍,
 * 比预期晚到的部分就是被堵的时长,≥ 阈值写一行 `kernel.lag`。
 *
 * 只能在恢复之后写(堵着的时候计时器也跑不了);内核整个卡死、再也不恢复的情形由 main 那边的心跳兜
 * (desktop 的 `main/kernel-heartbeat.ts`)。
 */

import { performance } from "node:perf_hooks"

import type { Trace } from "./sink.ts"

export interface LagMonitorOptions {
  intervalMs?: number
  /** 晚到超过这么多才记,缺省 1 秒。 */
  thresholdMs?: number
  now?: () => number
}

export function startLagMonitor(trace: Trace, options: LagMonitorOptions = {}): () => void {
  if (!trace.enabled) return () => {}
  const intervalMs = options.intervalMs ?? 1_000
  const thresholdMs = options.thresholdMs ?? 1_000
  const now = options.now ?? (() => performance.now())
  let last = now()
  const timer = setInterval(() => {
    const current = now()
    const lag = current - last - intervalMs
    last = current
    if (lag >= thresholdMs) trace.write("kernel.lag", { ms: Math.round(lag) })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
