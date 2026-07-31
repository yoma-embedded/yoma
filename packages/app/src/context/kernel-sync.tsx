import type { Config, Path, Project, ProviderAuthResponse } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { getFilename } from "@yoma-desktop/util/path"
import { batch, createMemo, getOwner, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import type { KernelContext } from "./kernel"
import { useGlobal } from "./global"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent } from "./global-sync/event-reducer"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { persisted } from "@/utils/persist"
import { createServerSession } from "./server-session"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

/**
 * 查询工厂。相比多服务器时代少了两样东西:
 *
 *  - **queryKey 里的 scope 段**没了。只有一个内核,所有键天然不冲突。
 *    (queryKey 只活在 TanStack 的内存缓存里,不落盘,改它不影响用户数据。)
 *  - **mcp / mcpResources / lsp / references / agents / globalConfig 六个查询**没了。
 *    内核协议里根本没有这些方法,留着只会在运行时 404。
 */
function makeQueryOptionsApi(client: KernelContext["client"]) {
  return {
    projects: () => loadProjectsQuery(client),
    providers: (directory: PathKey | null) => loadProvidersQuery(directory, client),
    sessions: (directory: PathKey) => ({ queryKey: [directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createKernelSyncContextInner(kernel: KernelContext) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("KernelSync must be created within owner")

  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  // 以前这里有一个 `sdkFor(directory)` 的 per-directory client 缓存。内核 client 是
  // 进程级单例,directory 只是每次调用的一个参数,所以缓存整块删掉了。
  const client = kernel.client
  const queryOptionsApi = makeQueryOptionsApi(client)

  const [providerQuery] = useQueries(() => ({
    queries: [queryOptionsApi.providers(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    config: {},
    reload: undefined,
  })

  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: ["bootstrap"] }),
    bootstrapInstance,
  })

  const session = createServerSession(client)

  const children = createChildStoreManager({
    owner,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      clearProviderRev(key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        // 内核的 session.list 没有 roots/limit 参数,也不分页 —— 一次性返回该目录
        // 全部会话,截断由前端的 trimSessions 负责。
        queryFn: () =>
          client.session
            .list({ directory })
            .then((list) => {
              const nonArchived = list
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const next = trimSessions(nonArchived, {
                limit,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore("sessionTotal", nonArchived.length)
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        client,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  /**
   * 内核事件不带 directory 维度(只有 `vcs.updated` 例外),所以目录靠 sessionID
   * 反查 —— session store 是全局的,`session.get(id).directory` 就是答案。
   *
   * `session.deleted` 有个陷阱:等 reducer 跑完 session 已经从 store 里没了,
   * 所以**必须在派发前先取 directory**,这就是这个函数在 apply 之前调用的原因。
   */
  function eventDirectory(event: Parameters<typeof session.apply>[0]): string | undefined {
    if (event.type === "vcs.updated") return event.directory
    const sessionID =
      "sessionID" in event
        ? event.sessionID
        : "session" in event
          ? event.session.id
          : "message" in event
            ? event.message.sessionID
            : "part" in event
              ? event.part.sessionID
              : "request" in event
                ? event.request.sessionID
                : undefined
    if (!sessionID) return
    return session.get(sessionID)?.directory
  }

  // host 每 ~16ms 推一批已经合并好的事件,`useKernel()` 已经在一个 batch() 里逐条
  // 派发过来了 —— 这里**不要**再合并/再 batch 一次。
  const unsub = kernel.event.listen((event) => {
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    // `kernel.connected` 一口气顶替了旧的 server.connected / global.disposed /
    // server.instance.disposed 三个事件。首次连接时 host 必发一条,所以保留
    // 原来那个 1500ms 去抖 —— 否则启动瞬间会多打一整轮全量 refetch。
    if (event.type === "kernel.connected") {
      if (recent) return
      bootstrap.refetch()
      for (const directory of Object.keys(children.children)) queue.push(directory)
      return
    }

    if (event.type === "kernel.error") return

    const directory = eventDirectory(event)
    session.apply(event)
    if (!directory) return

    const key = directoryKey(directory)
    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    queryOptions: queryOptionsApi,
    project: projectApi,
    session,
  }
}

export function createKernelSyncContext(kernel: KernelContext) {
  const inner = createKernelSyncContextInner(kernel)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap((dir) => createDirSyncContext(dir, inner), undefined, directoryKey),
  })
}

export type KernelSync = ReturnType<typeof createKernelSyncContext>

/**
 * sync ctx 是单例(建在 `GlobalProvider` 里),这里返回的 accessor 永远吐同一个对象。
 * 保留 accessor 形状纯粹是调用点的书写习惯 —— 以前它要跟着 `server.current` 变,
 * 现在不会变了,但 `sync().data.…` 这个读法在几十个文件里是一致的,没必要为了
 * 少一对括号去动它们。这里面**没有**多服务器的残留:没有 key,没有注册表,
 * 没有可切换的目标。
 */
export function useKernelSync(): () => KernelSync {
  const global = useGlobal()
  return () => global.sync
}

export function useQueryOptions() {
  const sync = useKernelSync()
  return createMemo(() => sync().queryOptions)
}
