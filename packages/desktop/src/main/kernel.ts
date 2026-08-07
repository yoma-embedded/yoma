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

const SERVICE_NAME = "yoma-kernel"

export interface KernelProcessOptions {
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  version?: string
  onStdout?(line: string): void
  onStderr?(line: string): void
  onExit?(code: number): void
}

export interface KernelProcess {
  /** 把一个窗口接到内核上。窗口 reload 之后需要重新调用。 */
  attach(window: BrowserWindow): void
  /**
   * 调试台探针互斥:任务活跃时把交互内核的硬件工具锁成 deny(kernel 协议
   * `mailbox.setActive`)。走控制通道而不是数据通道 —— 锁的持有者是 main
   * (任务生命周期归它管),renderer 不该有解锁能力。
   */
  setMailboxActive(active: boolean, reason?: string): void
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
  child.once("exit", (code) => options.onExit?.(code))

  let resolveReady: () => void
  let rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const timeout = setTimeout(() => rejectReady(new Error("内核进程启动超时")), 30_000)
  timeout.unref?.()

  child.on("message", (message: { type?: string; error?: { message?: string } }) => {
    if (message?.type === "ready") {
      clearTimeout(timeout)
      resolveReady()
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
  })

  return {
    ready,
    attach(window) {
      // 每个窗口一条独立通道:port1 给内核,port2 给 renderer。main 不在中间转发。
      const channel = new MessageChannelMain()
      child.postMessage({ type: "attach" }, [channel.port1])
      window.webContents.postMessage("kernel-port", null, [channel.port2])
    },
    setMailboxActive(active, reason) {
      child.postMessage({ type: "mailbox-active", active, reason })
    },
    async stop() {
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
