import { createSimpleContext } from "@yoma-desktop/ui/context"
import { useKernel } from "./kernel"
import { createKernelSyncContext } from "./kernel-sync"

/**
 * 全应用的根数据上下文。
 *
 * 以前这里是 `Map<ServerConnection.Key, ServerCtx>` —— 每个服务器一个
 * `createRoot`,各自带一个 QueryClient、一个 SDK ctx、一个 sync ctx,
 * 还要在 `server.list` 变化时 ensure / dispose。
 *
 * 现在一个 Electron 进程里只有**一个进程内内核**,那整套注册表就没有存在理由了:
 * Map、ensureServerCtx、per-server createRoot、settings.serverKey、健康检查轮询、
 * isLocal 判定 —— 全部删掉,塌成下面这一个对象。
 *
 * 注意 QueryClient 也不在这里建了。以前每个服务器一个 QueryClient(`createServerCtx`
 * 里 `new QueryClient(...)`),但 sync ctx 内部用的是 `useQueryClient()`,
 * 拿的其实是外层 `QueryProvider` 那个 —— per-server 的那个从来没被用过。
 */
export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  init: () => {
    const kernel = useKernel()
    const sync = createKernelSyncContext(kernel)
    return { kernel, sync }
  },
})

export type GlobalCtx = ReturnType<typeof useGlobal>
