/**
 * 内核进程的宿主端管理。
 *
 * 和被它取代的 server.ts 的关键差别:没有端口、没有密码、没有 CORS、没有健康轮询。
 * renderer 通过 MessagePort **直连** utilityProcess,main 只负责牵线,不在数据通路上 ——
 * 一次流式回答几千条事件,让它们逐条穿过 main 是纯粹的浪费。
 */

import { app, BrowserWindow, MessageChannelMain, utilityProcess, type UtilityProcess } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHeartbeatWatch } from "./kernel-heartbeat"

const SERVICE_NAME = "yoma-kernel"

export interface KernelProcessOptions {
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  version?: string
  /** 本次启动的日志目录:内核的调试轨迹写在这里的 trace.jsonl(docs/调试留痕-规划-20260924.md §3.1)。 */
  logDir?: string
  onStdout?(line: string): void
  onStderr?(line: string): void
  onExit?(code: number): void
  /** 内核 20 s 没心跳(事件循环整个卡死)。 */
  onUnresponsive?(silentMs: number): void
  /** 没心跳之后又回来了,带卡了多久。 */
  onResponsive?(stalledMs: number): void
}

/** 内核发心跳的间隔(kernel-entry.ts 同一个数)与 main 的检查间隔。 */
const HEARTBEAT_MS = 5_000

export interface KernelProcess {
  /** 把一个窗口接到内核上。窗口 reload 之后需要重新调用。 */
  attach(window: BrowserWindow): void
  stop(): Promise<void>
  readonly ready: Promise<void>
}

export function spawnKernel(options: KernelProcessOptions): KernelProcess {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "kernel.js")
  const child: UtilityProcess = utilityProcess.fork(entry, [], {
    cwd: process.cwd(),
    serviceName: SERVICE_NAME,
    stdio: "pipe",
    env: { ...process.env, YOMA_ENGINES_DIR: options.enginesDir ?? "" },
  })

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  // 内核整个卡死(事件循环再也不转)时,它自己什么都写不了 —— 由这边按心跳判,证据落 kernel.log。
  const heartbeat = createHeartbeatWatch({
    checkMs: HEARTBEAT_MS,
    onSilent: (ms) => options.onUnresponsive?.(ms),
    onRecovered: (ms) => options.onResponsive?.(ms),
  })
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  child.once("exit", (code) => {
    stopHeartbeat()
    options.onExit?.(code)
  })

  let resolveReady: () => void
  let rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const timeout = setTimeout(() => rejectReady(new Error("内核进程启动超时")), 30_000)
  timeout.unref?.()

  child.on("message", (message: { type?: string; error?: { message?: string } }) => {
    if (message?.type === "heartbeat") {
      heartbeat.beat()
      return
    }
    if (message?.type === "ready") {
      clearTimeout(timeout)
      resolveReady()
      heartbeat.beat()
      heartbeatTimer ??= setInterval(() => heartbeat.check(), HEARTBEAT_MS)
      heartbeatTimer.unref?.()
    }
    if (message?.type === "error") {
      clearTimeout(timeout)
      rejectReady(new Error(message.error?.message ?? "内核进程启动失败"))
    }
  })

  child.postMessage({
    type: "start",
    sessionsRoot: options.sessionsRoot,
    stateDir: options.stateDir,
    enginesDir: options.enginesDir,
    version: options.version ?? app.getVersion(),
    logDir: options.logDir,
  })

  return {
    ready,
    attach(window) {
      // 每个窗口一条独立通道:port1 给内核,port2 给 renderer。main 不在中间转发。
      const channel = new MessageChannelMain()
      child.postMessage({ type: "attach" }, [channel.port1])
      window.webContents.postMessage("kernel-port", null, [channel.port2])
    },
    async stop() {
      // 正在收尾(dispose 会等在飞的轮次与轨迹写完):这段时间不算"没响应"
      stopHeartbeat()
      child.postMessage({ type: "stop" })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill()
          resolve()
        }, 3_000)
        timer.unref?.()
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
