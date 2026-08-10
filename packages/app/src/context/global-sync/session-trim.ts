import type { Session } from "@yoma-desktop/kernel"
import { cmp } from "./utils"
import { SESSION_RECENT_LIMIT, SESSION_RECENT_WINDOW } from "./types"

export function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

export function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

export function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (sessionUpdatedAt(session) <= cutoff) continue
    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

/**
 * 裁剪目录 store 里保留的会话。
 *
 * 内核里会话之间没有父子关系(树在单个 session 内部),所以原来的 root/child 两段逻辑
 * 塌成一段:按最近活动取 limit 条,再补一批最近窗口内的。
 */
export function trimSessions(input: Session[], options: { limit: number; now?: number }) {
  const limit = Math.max(0, options.limit)
  const cutoff = (options.now ?? Date.now()) - SESSION_RECENT_WINDOW
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))
  const ordered = all.slice().sort(compareSessionRecent)
  const base = ordered.slice(0, limit)
  const recent = takeRecentSessions(ordered.slice(limit), SESSION_RECENT_LIMIT, cutoff)
  const keep = [...base, ...recent]
  return keep.sort((a, b) => cmp(a.id, b.id))
}
