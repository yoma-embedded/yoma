import type { SetStoreFunction, Store } from "solid-js/store"
import { createStore } from "solid-js/store"
import { LOCAL_SCOPE } from "@/utils/scoped-key"
import { Persist, persisted } from "@/utils/persist"

/**
 * 侧栏/首页里"我打开着哪些工程目录"这份名单。
 *
 * 原来它挂在 `context/server.tsx` 的多服务器注册表下面,每台服务器一份;现在只有一个内核,
 * 名单也只有一份。**但存储形状一个字节都没动**:还是 `yoma.global.dat` 里的 `server` 键
 * (旧键 `server.v3`),里面还是 `{ projects: { local: [...] }, lastProject: { local: … } }`
 * 这种按 scope 分桶的样子 —— 桶名恒为 `"local"`。改了用户的工程列表就空了。
 */
export type StoredProject = { worktree: string; expanded: boolean }

type ProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
}

export function createProjectsStore() {
  const [store, setStore, , ready] = persisted(
    Persist.global("server", ["server.v3"]),
    createStore<ProjectState>({
      projects: {},
      lastProject: {},
    }),
  )
  return { ready, ...createProjects({ store, setStore }) }
}

/** 导出给单测用:不碰 localStorage,只测名单的增删改序。 */
export function createProjects<T extends ProjectState>(input: { store: Store<T>; setStore: SetStoreFunction<T> }) {
  const setStore = input.setStore as unknown as SetStoreFunction<ProjectState>
  const current = () => input.store.projects[LOCAL_SCOPE] ?? []
  return {
    list: current,
    open(directory: string) {
      if (current().some((project) => project.worktree === directory)) return
      setStore("projects", LOCAL_SCOPE, [{ worktree: directory, expanded: true }, ...current()])
    },
    close(directory: string) {
      setStore(
        "projects",
        LOCAL_SCOPE,
        current().filter((project) => project.worktree !== directory),
      )
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", LOCAL_SCOPE, index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", LOCAL_SCOPE, index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", LOCAL_SCOPE, next)
    },
    last() {
      return input.store.lastProject[LOCAL_SCOPE]
    },
    touch(directory: string) {
      setStore("lastProject", LOCAL_SCOPE, directory)
    },
  }
}
