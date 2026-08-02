import type { Message, Part, PermissionRequest, SessionStatus } from "@yoma-desktop/kernel"

export const SESSION_CACHE_LIMIT = 40

/**
 * 每会话的缓存分片。
 *
 * 相对 opencode 少了三格,都是内核没有的东西:
 *   session_diff  没有文件快照,也就没有"这轮改了哪些文件"的会话级 diff
 *   todo          没有 todo 工具
 *   question      没有 ask 工具/问答请求
 */
type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const key of Object.keys(store.part)) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
    for (const part of parts) {
      delete store.part_text_accum_delta[part.id]
    }
    delete store.part[key]
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
