/**
 * 内核事件的入口。
 *
 * 这个文件原来是一整套 SSE 客户端:fetch 事件流、心跳超时、断线重连、按帧攒 delta、
 * 按目录分频道。**全部删掉了**,因为它解决的问题在进程内内核下都不存在:
 *
 *   - 没有网络,就没有断线重连和心跳。传输是 MessagePort,host 挂了整个 utilityProcess
 *     就没了,那是 desktop 层的事,不是这里能重试回来的。
 *   - 合并已经在 host 的 StreamSink 做完(同 part 的快照折叠 + 连续 delta 拼接,
 *     每 ~16ms 推一批)。越早合并跨进程的数据越少,前端再合一遍纯属浪费。
 *   - 目录分流没有了。opencode 的每条事件带 directory,这里按目录开频道;yoma 的
 *     事件只带 sessionID,目录归属由下游拿 session 表自己查。
 *
 * 剩下的职责就一件:把 host 推来的一批事件,在**一个** solid `batch()` 里分发完 ——
 * 一批事件只触发一次渲染,这是整个流式渲染的性能地基。
 */

import type { KernelEvent } from "@yoma-desktop/kernel"
import { createSimpleContext } from "@yoma-desktop/ui/context"
import { type Accessor, batch, createMemo, onCleanup } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { kernelAvailable } from "@/utils/kernel"
import { useLanguage } from "./language"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"

export type KernelEventHandler = (event: KernelEvent) => void

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope) {
  const client = createSdkForServer()
  const handlers = new Set<KernelEventHandler>()

  // web host(dev:web)和单测里没有 window.api.kernel。那里没有事件流,但其余 API 表
  // 仍然要能构造出来,所以订阅是可选的,不是构造前提。
  if (kernelAvailable()) {
    const unsubscribe = client.subscribe((events) => {
      batch(() => {
        for (const event of events) {
          for (const handler of handlers) handler(event)
        }
      })
    })
    onCleanup(unsubscribe)
  }

  return {
    server,
    scope,
    url: server.http.url,
    client,
    event: {
      listen(handler: KernelEventHandler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      /**
       * 保留成空实现:订阅在构造时就建立了,没有"开始拉流"这一步。调用点还在 onMount 里
       * 延后调用它,删掉只会让那些地方变成一堆无意义的 if。
       */
      start() {},
    },
    createClient(_opts?: unknown) {
      // 进程内内核是单例,没有 baseUrl / directory / throwOnError 可配。
      return client
    },
  }
}

type ServerSDKBase = ReturnType<typeof createServerSdkContextBase>
export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sdk
    })
  },
})

/**
 * 目录作用域的 SDK。
 *
 * 只剩"记住自己是哪个目录"这一件事了 —— 客户端是同一个内核单例,而按目录分流的
 * 事件频道(原来的 `event` emitter)随 SSE 一起删掉了:内核事件不带 directory。
 * 需要按目录过滤的调用点,自己用 sessionID 查 session 表。
 */
function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  return {
    scope: serverSDK.scope,
    directory,
    client: serverSDK.client,
    get url() {
      return serverSDK.url
    },
    createClient(opts?: unknown) {
      return serverSDK.createClient(opts)
    },
  }
}
