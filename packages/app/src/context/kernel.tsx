/**
 * 内核事件源。顶替 `context/server-sdk.tsx`。
 *
 * 被删掉的东西比留下的多,而且都是**故意**的 —— 它们已经下沉到 host:
 *
 *   - **SSE 重连循环**:没有 HTTP 流可断。传输是进程内 MessagePort,窗口 reload
 *     导致端口失效时由 main 的 `did-finish-load` 重新牵线(外加下面的 `reattach()`)。
 *   - **心跳**:MessagePort 不会"静默死掉",没有需要探活的中间设备。
 *   - **16ms 帧合并 / `message.part.delta` 拼接**:host 每 ~16ms 推一批已经合并好的事件
 *     (`KernelPush`)。**renderer 绝不能再合并一次** —— 二次合并会破坏
 *     protocol.ts:131-136 那条"累积快照必须是 delta 的严格前缀扩展"的不变式,
 *     表现为流式文本先截断再长回来。
 *   - **按 directory 分发**:内核事件不带 directory 维度(只有 `vcs.updated` 例外),
 *     订阅者自己按 `sessionID` 反查。所以这里的 emitter 按**事件类型**分桶,
 *     不再按目录。
 *
 * 于是整个文件只剩一件事:把 `window.api.kernel.subscribe` 推来的每一批,
 * 在一个 `batch()` 里逐条派发出去。
 */

import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createSimpleContext } from "@yoma-desktop/ui/context"
import type { KernelClient, KernelEvent, KernelEventType } from "@yoma-desktop/kernel"
import { batch, createSignal, onCleanup } from "solid-js"
import { kernel, kernelAvailable } from "@/utils/kernel"

/** 按事件类型分桶,让 `event.on("session.status", …)` 拿到收窄后的 payload。 */
type KernelEventMap = { [K in KernelEventType]: Extract<KernelEvent, { type: K }> }

/**
 * 窗口 reload 之后 renderer 那端的 MessagePort 会失效。main 挂在 `did-finish-load` 上
 * 会自动重牵一次,但那个时机和 renderer 挂载的先后没有保证 —— 如果 host 的第一条
 * `kernel.connected` 早于我们 subscribe,它就没人接,bootstrap 永远不会开始(白屏)。
 * 所以这里主动再要一次:preload 的 `reattach()` 会让内核重发 `kernel.connected`。
 *
 * 代价是启动时可能收到两条 `kernel.connected` —— 订阅侧本来就要对它去抖(见
 * server-sync 的 1500ms `recent` 判定),重复一条是安全的;漏掉一条不是。
 *
 * 不走 `utils/kernel.ts` 的 transport:`KernelTransport` 只有 request/subscribe,
 * `reattach` 是 preload 额外挂的桌面端能力,web host 上不存在。
 */
function reattach() {
  const api = (globalThis as { api?: { kernel?: { reattach?(): Promise<void> } } }).api?.kernel
  return api?.reattach?.()
}

export function createKernelContext(client: KernelClient = kernel) {
  const emitter = createGlobalEmitter<KernelEventMap>()
  const [connected, setConnected] = createSignal(false)
  const [version, setVersion] = createSignal<string>()

  if (kernelAvailable()) {
    // host 已经把这一批合并好了:一批 = 一次 IPC 往返 = 一个 batch。
    const unsubscribe = client.subscribe((events) => {
      batch(() => {
        for (const event of events) {
          if (event.type === "kernel.connected") {
            setVersion(event.version)
            setConnected(true)
          }
          emitter.emit(event.type, event)
        }
      })
    })
    onCleanup(unsubscribe)
    // subscribe 是同步注册的,已经生效;这次 invoke 只是补一条 connected,失败不影响别的。
    void reattach()?.catch((error: unknown) => {
      console.error("[kernel] reattach failed", error)
    })
  }

  return {
    /** 全应用唯一的内核客户端(`utils/kernel.ts` 的模块级单例)。 */
    client,
    event: {
      /** 订阅单一类型,payload 已按类型收窄。 */
      on: emitter.on,
      /**
       * 订阅全部事件。给的是**扁平的 `KernelEvent`**(不是 emitter 的 `{name, details}`)——
       * `KernelEvent` 自己就是按 `type` 判别的联合,reducer 可以直接 switch。
       */
      listen: (handler: (event: KernelEvent) => void) => emitter.listen((payload) => handler(payload.details)),
    },
    /** 收到过 `kernel.connected` 没有。顶替原来 `global.health()` 轮询那个连接闸门。 */
    get connected() {
      return connected()
    },
    /** host 报的内核版本,`kernel.connected` 带来的。 */
    get version() {
      return version()
    },
  }
}

export type KernelContext = ReturnType<typeof createKernelContext>

export const { use: useKernel, provider: KernelProvider } = createSimpleContext({
  name: "Kernel",
  // 不 gate:连接闸门由消费方读 `connected` 自己决定怎么画,不在这里挂起整棵树。
  gate: false,
  init: () => createKernelContext(),
})
