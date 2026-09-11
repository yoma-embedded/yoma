import { createSimpleContext } from "@yoma-desktop/ui/context"
import { createStore, produce } from "solid-js/store"
import { startTransition } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { uuid } from "@/utils/uuid"
import { sessionHref } from "@/utils/session-href"
import { usePlatform } from "./platform"

/**
 * 草稿页（/new-session?draftId=…）的记录表。
 *
 * 它是 context/tabs.tsx 的遗产:标题栏那排浏览器式会话标签没了,但"还没发第一句话的
 * 草稿"仍然要有地方记住它开在哪个目录 —— 否则重启后桌面端记住的上次路由
 * (/new-session?draftId=…)就找不到目录,用户没发出去的话也就跟着丢了。
 *
 * 存储键仍是 `Persist.global("tabs")`(localStorage 里的 yoma.global.dat:tabs),字节不变:
 * 老记录里的草稿条目必须能原地读出来,这一条有 drafts.test.ts 钉着。老的会话标签条目
 * (type:"session")在 migrate 里丢掉 —— 那只是导航状态,没有用户数据。
 */
export type Draft = {
  draftID: string
  directory: string
  worktree?: string
}

/** 草稿最多留这么多条。以前关标签页会顺手删掉草稿,现在没有"关"这个动作了,靠上限兜住。 */
const MAX_DRAFTS = 20

/** 单独导出是为了让 drafts.test.ts 把键字节钉死 —— 改了它等于把用户没发出去的草稿丢掉。 */
export const DRAFTS_TARGET = Persist.global("tabs")

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

/**
 * 老的 `tabs` 记录是 (会话标签 | 草稿标签)[],草稿条目长
 * `{ type: "draft", draftID, directory, worktree?, server? }`。这里只留草稿,并把
 * `type` / `server` 两个没用的字段去掉。
 */
export function migrateDrafts(value: unknown) {
  if (!Array.isArray(value)) return value
  const out: Draft[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if ("type" in record && record.type !== "draft") continue
    const draftID = record.draftID
    const directory = record.directory
    if (typeof draftID !== "string" || typeof directory !== "string") continue
    const worktree = record.worktree
    out.push({ draftID, directory, ...(typeof worktree === "string" ? { worktree } : {}) })
  }
  return out
}

export const { use: useDrafts, provider: DraftsProvider } = createSimpleContext({
  name: "Drafts",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const navigate = useNavigate()
    const location = useLocation()
    const [store, setStore, _, ready] = persisted(
      { ...DRAFTS_TARGET, migrate: migrateDrafts },
      createStore<Draft[]>([]),
    )

    const forget = (draftID: string) => {
      for (const key of draftPersistedKeys()) removePersisted(Persist.draft(draftID, key), platform)
    }

    const get = (draftID: string) => store.find((draft) => draft.draftID === draftID)

    return {
      ready,
      get,
      create(draft: Omit<Draft, "draftID">, prompt?: string) {
        const draftID = uuid()
        const overflow = store.length + 1 - MAX_DRAFTS
        const dropped = overflow > 0 ? store.slice(0, overflow).map((item) => item.draftID) : []
        void startTransition(() => {
          setStore(
            produce((drafts) => {
              if (dropped.length) drafts.splice(0, dropped.length)
              drafts.push({ draftID, ...draft })
            }),
          )
          navigate(prompt ? `${draftHref(draftID)}&prompt=${encodeURIComponent(prompt)}` : draftHref(draftID))
        })
        for (const id of dropped) forget(id)
        return draftID
      },
      update(draftID: string, next: Partial<Omit<Draft, "draftID">>) {
        void startTransition(() => {
          setStore(
            (draft) => draft.draftID === draftID,
            produce((draft) => Object.assign(draft, next)),
          )
        })
      },
      /** 草稿发出第一句话、变成真会话:删记录、清掉草稿的本地状态,再把地址换成会话路由。 */
      promote(draftID: string, sessionID: string) {
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        void startTransition(() => {
          setStore(
            produce((drafts) => {
              const index = drafts.findIndex((draft) => draft.draftID === draftID)
              if (index !== -1) drafts.splice(index, 1)
            }),
          )
          if (active) navigate(sessionHref(sessionID))
        })
        forget(draftID)
      },
    }
  },
})
