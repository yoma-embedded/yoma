import type { Session } from "@opencode-ai/sdk/v2/client"

/** Timestamp a session should be sorted/labelled by. */
export function sessionTime(session: Session) {
  return session.time.updated ?? session.time.created
}

/**
 * Compact relative time badge, e.g. "13 分" / "13m" — matches the Codex layout.
 * `locale` is the app locale key (e.g. "zh", "zht", "en").
 */
export function terseAgo(ms: number, locale: string) {
  const zh = locale.startsWith("zh")
  const seconds = Math.max(0, (Date.now() - ms) / 1000)
  if (seconds < 60) return zh ? "刚刚" : "now"

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return zh ? `${minutes} 分` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return zh ? `${hours} 时` : `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return zh ? `${days} 天` : `${days}d`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return zh ? `${weeks} 周` : `${weeks}w`

  const months = Math.floor(days / 30)
  if (months < 12) return zh ? `${months} 月` : `${months}mo`

  const years = Math.floor(days / 365)
  return zh ? `${years} 年` : `${years}y`
}
