import { createSimpleContext } from "@yoma-desktop/ui/context"
import { createMemo } from "solid-js"
import { createProjectsStore } from "./projects"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import type { LocalProject } from "./layout"

/**
 * 进程里唯一那套内核上下文:SDK(事件流)+ sync(store)+ 工程名单。
 *
 * 原来这里是一张 `Map<ServerConnection.Key, ServerCtx>`:每台服务器一个 createRoot、
 * 一套 SDK/sync、一个自己的 QueryClient,还要跟着 `server.list` 增删。yoma 只有一个
 * 进程内内核(`utils/server.ts` 的 client 本来就是单例),那张表永远只有一行 ——
 * 于是整张表塌成这一份,QueryClient 也回到 app.tsx 那一个。
 */
export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  gate: true,
  init: () => {
    const ctx = createServerCtx()
    // 工程名单从磁盘回水之前不渲染,否则首页会先画一帧空白再补上(原 ServerProvider 的门)。
    return { ctx, ready: ctx.projects.ready }
  },
})

function createServerCtx() {
  const projects = createProjectsStore()
  const sdk = createServerSdkContext()
  const sync = createServerSyncContext(sdk)

  // 项目就是目录本身:没有服务端 id,按目录匹配。图标只有 per-workspace 的本地覆盖
  // (childStore.icon)—— 内核的项目记录里没有图标字段。
  function enrich(project: { worktree: string; expanded: boolean }): LocalProject {
    const [childStore] = sync.child(project.worktree, { bootstrap: false })
    const metadata = sync.data.project.find((x) => x.directory === project.worktree)
    const base = { ...metadata, ...project }
    if (childStore.icon) return { ...base, icon: { override: childStore.icon } }
    return base
  }

  const projectsList = createMemo(() => projects.list().map(enrich))

  return {
    sdk,
    sync,
    projects: {
      ...projects,
      list: projectsList,
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>
