/**
 * 服务器级的同步上下文:全局 store(项目列表 + provider 目录)+ 每目录子 store + 事件分发。
 *
 * 相对 opencode 删掉的几块,以及原因:
 *   mcp / mcpResources / lsp / references  内核完全没有这些概念,连查询都不存在
 *   config(读+写)                          内核没有配置服务,`Config` 收窄成空对象占位
 *   agents                                  只有一个系统提示词,没有 persona
 *   path                                    目录前端自己知道,不必往内核要
 *   会话分页的 roots/limit 参数              内核的 session.list 一次给全,没有游标
 */

import { showToast } from "@/utils/toast"
import { getFilename } from "@yoma-desktop/util/path"
import type { KernelEvent } from "@yoma-desktop/kernel"
import { type Accessor, batch, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadProjectsQuery,
  loadProvidersQuery,
  type Project,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { trimSessions } from "./global-sync/session-trim"
import type { Config, Path, ProjectMeta } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@yoma-desktop/ui/context"
import { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import type { ServerScope } from "@/utils/server-scope"
import type { Sdk } from "@/utils/server"
import { persisted } from "@/utils/persist"
import { createServerSession } from "./server-session"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function makeQueryOptionsApi(scope: ServerScope, serverSDK: () => Sdk, sdkFor: (dir: PathKey) => Sdk) {
  return {
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, Sdk>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient()
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const providerQuery = useQuery(() => queryOptionsApi.providers(null))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    // 内核没有 path 服务;全局层面没有"当前目录"这回事,目录由每个子 store 自己持有。
    path: { directory: "" },
    // 内核没有配置服务。留一个空对象是为了让 bootstrap 的 store 形状对得上。
    config: {},
    reload: undefined,
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
  })

  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

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
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
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
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const session = createServerSession(serverSDK.client)

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
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
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
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

    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        // 内核的 session.list 没有 roots / limit / 游标 —— 一个目录的会话一次给全,
        // 于是原来的"带 limit 试一次、失败再不带 limit 试一次"的回退整块删掉。
        queryFn: () =>
          serverSDK.client.session
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
                // 拿到的就是全部,不用再估算总数。
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
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
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
   * 事件归属的目录。
   *
   * 内核事件不带 directory(只有 vcs.updated 带),因为一个 session 就是一个 cwd ——
   * 目录靠 session 表反查。必须在 `session.apply` **之前**算,否则 session.deleted
   * 会先把那条记录抹掉,查不到目录。
   */
  const eventDirectory = (event: KernelEvent): string | undefined => {
    switch (event.type) {
      case "vcs.updated":
        return event.directory
      case "session.created":
      case "session.updated":
        return event.session.directory
      case "session.deleted":
      case "session.status":
      case "message.removed":
      case "message.part.removed":
      case "message.part.delta":
        return session.get(event.sessionID)?.directory
      case "message.updated":
        return session.get(event.message.sessionID)?.directory
      case "message.part.updated":
        return session.get(event.part.sessionID)?.directory
      case "permission.asked":
        return session.get(event.request.sessionID)?.directory
    }
  }

  const unsub = serverSDK.event.listen((event) => {
    const recent = bootingRoot || Date.now() - bootedAt < 1500
    const directory = eventDirectory(event)

    session.apply(event)

    applyGlobalEvent({
      event,
      refresh: () => {
        if (recent) return
        bootstrap.refetch()
      },
    })

    // host 重连(或首次就绪)后,已经打开的目录全部重新拉一遍。
    if (event.type === "kernel.connected") {
      if (recent) return
      for (const directory of Object.keys(children.children)) {
        queue.push(directory)
      }
      return
    }

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

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
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
    child: children.child,
    peek: children.peek,
    queryOptions: queryOptionsApi,
    project: projectApi,
    session,
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap((dir) => createDirSyncContext(dir, inner, serverSDK), undefined, directoryKey),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
