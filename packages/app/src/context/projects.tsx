import { createSimpleContext } from "@yoma-desktop/ui/context"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { LOCAL_SCOPE } from "@/utils/scoped-key"

export type StoredProject = { worktree: string; expanded: boolean }

/**
 * 侧边栏 / 首页的"已打开项目"列表。
 *
 * 这是从 `context/server.tsx` 里**唯一需要活下来**的东西。多服务器的部分
 * (ServerConnection、健康检查、当前服务器)全删了,但这份列表是纯本地持久化,
 * 和后端一点关系都没有 —— 删了它用户重启后首页会全空,看起来就像白屏。
 *
 * 两个不能动的细节:
 *
 *  1. **persist key 还是 `server` / `server.v3`。** 换 key = 老用户的项目列表消失。
 *  2. **仍然是 `Record<scope, …>` 的分桶结构,桶名固定 `"local"`。**
 *     以前 scope 是 ServerConnection 的 key(内置 sidecar 恰好映射成 `"local"`),
 *     所以固定成 `"local"` 读到的正是老数据。远程服务器那些桶就此成为孤儿,
 *     不读也不写,留在 localStorage 里无害。
 *
 * `gate: true` 也必须保留:整棵树要等这份持久化就绪,否则首帧会画出一个空首页
 * 然后闪一下才补上。
 */
export const { use: useProjects, provider: ProjectsProvider } = createSimpleContext({
  name: "Projects",
  gate: true,
  init: () => {
    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const current = () => store.projects[LOCAL_SCOPE] ?? []
    const list = createMemo(current)

    return {
      ready,
      list,
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
        return store.lastProject[LOCAL_SCOPE]
      },
      touch(directory: string) {
        setStore("lastProject", LOCAL_SCOPE, directory)
      },
    }
  },
})

export type ProjectsContext = ReturnType<typeof useProjects>
