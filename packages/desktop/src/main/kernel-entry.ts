/**
 * 内核进程的入口。electron-vite 把它编成 out/main/kernel.js,作为 main 的第三个 rollup 入口。
 *
 * my-pi 的源码在这一步被 esbuild 整个 inline 进来:它只发 raw `.ts`,而 Electron 的
 * strip-only 加载器既吃不下 TS 参数属性(gdb.ts:485、acp/agent.ts:209),也拒绝 strip
 * node_modules 下的 `.ts`。打包一步同时解掉这两个,而 my-pi 一个字节都不用改。
 *
 * 进程模型是刻意的单例 —— my-pi 的 probe 租约和 gdb session 表是模块级全局,
 * 分片 fork 会让两个进程各自以为独占探针。所以整个 app 只 fork 这一个。
 */

import { createKernelHost, kernelSelfCheck, type KernelHost } from "@yoma-desktop/kernel/host"
import type { KernelEvent, KernelFrame } from "@yoma-desktop/kernel"

type StartCommand = {
  type: "start"
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  version?: string
}

type ParentPort = {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown; ports?: MessagePortLike[] }) => void): void
}

type MessagePortLike = {
  postMessage(message: unknown): void
  on?(event: "message", listener: (event: { data: unknown }) => void): void
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

/** 每开一个窗口就挂一个端口。事件广播给所有端口,请求各回各的。 */
const ports = new Set<MessagePortLike>()
let host: KernelHost | undefined

function broadcast(events: KernelEvent[]): void {
  const frame: KernelFrame = { kind: "push", events }
  for (const port of ports) {
    try {
      port.postMessage(frame)
    } catch {
      // 窗口已经关了。下一次 attach 会重建,这里不该把整个内核拖垮。
      ports.delete(port)
    }
  }
}

/**
 * host 就绪的闸门。
 *
 * `attach` 可能早于 `start` 到达(两条独立的 postMessage,顺序不由我们决定)。
 * 早期版本这里写的是 `host?.handle(...)` —— host 还不存在时它 **静默 resolve 成
 * undefined**,renderer 拿到一个空结果却以为成功了,比直接报错糟得多。
 * 现在改成等 host 起来再处理,请求最多是慢一点,不会变成假答案。
 */
let hostReady: (() => void) | undefined
const whenHostReady = new Promise<void>((resolve) => {
  hostReady = resolve
})

function attach(port: MessagePortLike): void {
  const onMessage = (event: { data: unknown }) => {
    const frame = event.data as KernelFrame | undefined
    if (!frame || frame.kind !== "request") return
    const { id, method, params } = frame
    whenHostReady
      .then(() => {
        if (!host) throw new Error("内核 host 未初始化")
        return host.handle(method as never, params as never)
      })
      .then(
        (result) => port.postMessage({ kind: "response", id, result } satisfies KernelFrame),
        (error: unknown) =>
          port.postMessage({
            kind: "response",
            id,
            error: {
              message: (error as Error)?.message ?? String(error),
              stack: (error as Error)?.stack,
              // 结构化信息必须一起过去 —— 跨进程之后 Error 只剩字符串,前端就分不清
              // "会话不存在"(删掉失效标签页即可)和真正的致命错误。
              data: (error as { data?: Record<string, unknown> })?.data,
            },
          } satisfies KernelFrame),
      )
  }

  if (port.on) port.on("message", onMessage)
  else port.addEventListener?.("message", onMessage)
  port.start?.()
  ports.add(port)

  // 新端口挂上就重同步:重推未决权限请求,否则关掉窗口再开就是一个永久卡住的会话。
  host?.resync()
}

const parentPort = process.parentPort as unknown as ParentPort | undefined

if (parentPort) {
  parentPort.on("message", (event) => {
    const data = event.data as { type?: string } | undefined
    if (data?.type === "start") {
      const command = data as StartCommand
      host = createKernelHost({
        sessionsRoot: command.sessionsRoot,
        stateDir: command.stateDir,
        enginesDir: command.enginesDir,
        version: command.version,
        onEvents: broadcast,
      })
      hostReady?.()
      parentPort.postMessage({ type: "ready" })
      // start 可能晚于 attach 到达 —— 那些先挂上的端口现在才等到 host,补一次 resync。
      host.resync()
      return
    }
    if (data?.type === "attach") {
      const port = event.ports?.[0]
      if (port) attach(port)
      return
    }
    if (data?.type === "stop") {
      void host?.dispose().finally(() => process.exit(0))
    }
  })
}

// 开发期自检:直接跑构建产物就能确认整个 my-pi 依赖图在当前 runtime 下加载得起来。
//   YOMA_KERNEL_SELFCHECK=1 ELECTRON_RUN_AS_NODE=1 electron out/main/kernel.js
if (process.env.YOMA_KERNEL_SELFCHECK === "1") {
  const report = kernelSelfCheck({ enginesDir: process.env.YOMA_ENGINES_DIR })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.tools.length === 11 ? 0 : 1)
}
