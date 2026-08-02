/**
 * 启动时的数据拉取。
 *
 * opencode 版本一口气拉十几样东西:config、providers、path、projects、agents、
 * session.status、project.current、vcs、command.list、references、permission.list、
 * question.list、mcp、mcp resources。my-pi 内核只有其中四样有对应物,其余要么是
 * opencode 特有的服务端概念(agent 定义、MCP、LSP、references),要么已经变成事件推送
 * (permission 由 host 在 resync 时重推,不需要轮询)。
 *
 * 所以这里剩下的很短。删掉的每一项在下面都写了原因 —— 别照着 git 历史"补回来"。
 */

import type { Session } from "@yoma-desktop/kernel"
import { retry } from "@yoma-desktop/util/retry"
import { getFilename } from "@yoma-desktop/util/path"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"

import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import type { Sdk } from "@/utils/server"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import type { Config, Path, State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import { cmp, normalizeProviderList } from "./utils"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

/** 一个"项目"就是一个最近打开过的目录 —— 没有 worktree、没有 sandbox、没有服务端 id。 */
export type Project = {
  directory: string
  name: string
  lastOpened: number
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

export const loadProjectsQuery = (scope: ServerScope, sdk: Sdk) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        sdk.project.list().then((list) =>
          list
            .map((item) => ({
              directory: item.directory,
              name: getFilename(item.directory) || item.directory,
              lastOpened: item.lastOpened,
            }))
            .sort((a, b) => b.lastOpened - a.lastOpened),
        ),
      ),
  })

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, sdk: Sdk) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: () => retry(() => sdk.model.list().then((list) => normalizeProviderList(list))),
  })

export async function bootstrapGlobal(input: {
  serverSDK: Sdk
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  await runAll([
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.serverSDK)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverSDK))
        .then((data) => input.setGlobalStore("project", data)),
  ])
  // 删掉的:config(内核没有配置服务)、path(目录前端自己知道,不必往内核要)。
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  sdk: Sdk
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  const loading = input.store.status !== "complete"
  input.setStore("path", { directory: input.directory })
  input.setStore("project", input.directory)
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  providerRev.set(revKey, (providerRev.get(revKey) ?? 0) + 1)
  ;(async () => {
    const slow: Array<() => Promise<unknown>> = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        retry(() =>
          input.sdk.vcs.info(input.directory).then((next) => {
            input.setStore("vcs", next)
            input.vcsCache.setStore("value", next)
          }),
        ),
      () =>
        input.queryClient.fetchQuery(loadProvidersQuery(input.scope, input.directory, input.sdk)).catch((err) => {
          showToast({
            variant: "error",
            title: input.translate("toast.project.reloadFailed.title", { project: getFilename(input.directory) }),
            description: formatServerError(err, input.translate),
          })
        }),
    ]

    // 删掉的,以及原因:
    //   agents        my-pi 只有一个由 buildSystemPrompt 出来的系统提示词,没有 persona
    //   config        内核没有配置服务;还需要的只有权限规则,走 kernel.permission.rules()
    //   session.status  状态由 session.status 事件推送,不再轮询
    //   project.current 项目就是目录本身,上面已经直接 set 了
    //   command.list  斜杠命令改由 host 读 <cwd>/.my-pi/commands/*.md(尚未接入)
    //   references / question / mcp / mcp resources  内核完全没有这些概念
    //   permission.list  改为 host 在 renderer 重连时重推未决请求,不需要拉

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project: getFilename(input.directory) }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}

export { groupBySession, mergeSession, produce, reconcile, cmp }
