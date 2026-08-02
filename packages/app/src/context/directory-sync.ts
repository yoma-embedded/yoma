import { Binary } from "@yoma-desktop/util/binary"
import type { Message, Part, Session } from "@yoma-desktop/kernel"
import { createMemo } from "solid-js"
import { produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type { createServerSdkContext } from "./server-sdk"
import type { createServerSyncContextInner } from "./server-sync"
import type { State } from "./global-sync/types"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
// 会话内容住在服务器级的 session store 里,目录 store 只持有会话列表。
// 删掉的 session_diff / todo / question:内核没有文件快照、没有 todo 工具、没有问答请求。
const sessionFields = new Set([
  "session_status",
  "session_working",
  "permission",
  "message",
  "part",
  "part_text_accum_delta",
])

export const createDirSyncContext = (
  directory: string,
  serverSync: ReturnType<typeof createServerSyncContextInner>,
  serverSDK: ReturnType<typeof createServerSdkContext>,
) => {
  const client = serverSDK.createClient()
  const current = createMemo(() => serverSync.child(directory))
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const data = new Proxy({} as State, {
    get(_, property: keyof State) {
      if (property === "session_working") return serverSync.session.data.session_working.bind(serverSync.session.data)
      if (sessionFields.has(property)) return serverSync.session.data[property as keyof typeof serverSync.session.data]
      return current()[0][property]
    },
  })
  const set = ((...input: unknown[]) => {
    if (typeof input[0] === "string" && sessionFields.has(input[0])) {
      return (serverSync.session.set as (...args: unknown[]) => unknown)(...input)
    }
    const result = (current()[1] as (...args: unknown[]) => unknown)(...input)
    if (input[0] === "session") current()[0].session.forEach(serverSync.session.remember)
    return result
  }) as SetStoreFunction<State>

  const index = (sessionID: string) => {
    const session = serverSync.session.get(sessionID)
    if (!session || session.directory !== directory) return
    const [store, setStore] = current()
    const result = Binary.search(store.session, session.id, (item) => item.id)
    if (result.found) {
      setStore("session", result.index, reconcile(session))
      return
    }
    setStore(
      "session",
      produce((draft) => void draft.splice(result.index, 0, session)),
    )
  }

  return {
    data,
    set,
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      // 项目没有服务端 id,它**就是**目录;而且项目列表按 lastOpened 排序,不能二分查找。
      const store = current()[0]
      return serverSync.data.project.find((project) => project.directory === store.project)
    },
    session: {
      remember(session: Session) {
        serverSync.session.remember(session)
        index(session.id)
      },
      get(sessionID: string) {
        const session = serverSync.session.get(sessionID)
        if (session?.directory === directory) return session
      },
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          serverSync.session.optimistic.add(input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          serverSync.session.optimistic.remove(input)
        },
      },
      async sync(sessionID: string, options?: { force?: boolean }) {
        await serverSync.session.sync(sessionID, options)
        index(sessionID)
      },
      // 删掉的 diff / todo:内核没有文件快照,也没有 todo 工具。
      history: serverSync.session.history,
      evict(sessionID: string) {
        serverSync.session.evict(sessionID)
      },
      fetch: async (count = 10) => {
        const [store, setStore] = current()
        setStore("limit", (value) => value + count)
        const sessions = (await client.session.list({ directory }))
          .filter((session) => !!session?.id)
          .sort((a, b) => cmp(a.id, b.id))
          .slice(0, store.limit)
        sessions.forEach(serverSync.session.remember)
        setStore("session", reconcile(sessions, { key: "id" }))
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      // 删掉的 archive:内核没有归档,会话只能删除(session.delete)。
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }
}
