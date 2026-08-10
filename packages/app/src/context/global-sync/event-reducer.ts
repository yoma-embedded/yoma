import { Binary } from "@yoma-desktop/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { KernelEvent, Session } from "@yoma-desktop/kernel"
import type { State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"

/**
 * 只在"这个目录当前不渲染会话内容"时才跳过的事件。
 *
 * 相对 opencode 少了 session.diff / todo.updated / question.*,原因同 State:内核没有
 * 文件快照、没有 todo 工具、没有问答请求。
 */
const SESSION_CONTENT_EVENTS = new Set<KernelEvent["type"]>([
  "session.status",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
])

export function applyGlobalEvent(input: { event: KernelEvent; refresh: () => void }) {
  // 删掉的:project.updated —— 内核不推项目事件,而且项目列表按 lastOpened 排序,
  // 原来那套按 id 二分插入的 upsert 已经不成立。项目变更走 refresh 重新拉。
  //
  // 原来的 global.disposed / server.connected 合并成了 kernel.connected —— host 首次
  // 就绪和重连成功推的是同一条事件。
  if (input.event.type === "kernel.connected") {
    input.refresh()
  }
}

function cleanupSessionCaches(setStore: SetStoreFunction<State>, sessionID: string) {
  if (!sessionID) return
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

/**
 * 把一条内核事件归约进某个目录的 store。
 *
 * `event` 是 KernelEvent 本身,**不是** opencode 那层 `{ type, properties }` 信封 ——
 * 内核事件的字段是平铺的(`event.session` / `event.message` / `event.part`),而且判别
 * 联合让 switch 自动收窄,所以这里一个 cast 都不需要。信封没了是有意的:之前那版按
 * `event.properties.info` 取值,在内核事件上全是 undefined,静默什么都不做。
 */
export function applyDirectoryEvent(input: {
  event: KernelEvent
  store: Store<State>
  setStore: SetStoreFunction<State>
  directory: string
  vcsCache?: VcsCache
  retainedLimit?: number
  sessionContent?: boolean
}) {
  const event = input.event
  if (input.sessionContent === false && SESSION_CONTENT_EVENTS.has(event.type)) return
  const limit = Math.max(input.store.limit, input.retainedLimit ?? 0)
  switch (event.type) {
    case "session.created": {
      const info = event.session
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed)
      input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = event.session
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found) {
          // 已经归档过就什么都别做,否则 sessionTotal 会被重复减。
          if (input.store.session[result.index]!.time.archived === info.time.archived) break
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
          input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        }
        cleanupSessionCaches(input.setStore, info.id)
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed)
      break
    }
    case "session.deleted": {
      // 内核只推 id,不回带整个 Session —— 那条记录在 host 侧已经没了。
      const result = Binary.search(input.store.session, event.sessionID, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      }
      cleanupSessionCaches(input.setStore, event.sessionID)
      break
    }
    case "session.status": {
      input.setStore("session_status", event.sessionID, reconcile(event.status))
      break
    }
    case "message.updated": {
      const info = event.message
      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }
    case "message.removed": {
      const { sessionID, messageID } = event
      input.setStore(
        produce((draft) => {
          const messages = draft.message[sessionID]
          if (messages) {
            const result = Binary.search(messages, messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          const parts = draft.part[messageID]
          if (parts) {
            for (const part of parts) {
              delete draft.part_text_accum_delta[part.id]
            }
          }
          delete draft.part[messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = event.part
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[part.id]
        }),
      )
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const { messageID, partID } = event
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[partID]
        }),
      )
      const parts = input.store.part[messageID]
      if (!parts) break
      const result = Binary.search(parts, partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[messageID]
            if (!list) return
            const next = Binary.search(list, partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      // 内核只对 text 发增量(field 的类型就是字面量 "text"),所以这里不再按任意字段名
      // 动态索引 —— 非文本 part 收到 delta 直接丢弃。
      const parts = input.store.part[event.messageID]
      if (!parts) break
      const result = Binary.search(parts, event.partID, (p) => p.id)
      if (!result.found) break
      const target = parts[result.index]
      if (!target || !("text" in target)) break
      const current = target.text
      input.setStore(
        "part_text_accum_delta",
        event.partID,
        (existing) => (existing ?? current ?? "") + event.delta,
      )
      input.setStore(
        "part",
        event.messageID,
        produce((draft) => {
          const part = draft[result.index]
          if (!part || !("text" in part)) return
          part.text = (part.text ?? "") + event.delta
        }),
      )
      break
    }
    // 原来是 vcs.branch.updated(只带一个分支名)。内核推的是完整的 VcsInfo,
    // 于是这里整块替换而不是打补丁 —— 不用再为缺的 dirty 字段编一个默认值。
    case "vcs.updated": {
      if (!event.info) break
      input.setStore("vcs", reconcile(event.info))
      if (input.vcsCache) input.vcsCache.setStore("value", event.info)
      break
    }
  }
  // 删掉的 case,以及原因:
  //   session.diff / todo.updated          内核没有文件快照,也没有 todo 工具
  //   question.asked / replied / rejected  内核没有问答请求
  //   lsp.updated / reference.updated      内核没有 LSP,也没有 references
  //   server.instance.disposed             内核没有 per-directory 实例;host 重连推的是
  //                                        kernel.connected,server-sync 收到后统一把所有
  //                                        已打开目录重新入队,不再需要这里的 push 回调
}
