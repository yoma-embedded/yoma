type TimeKey =
  | "common.time.justNow"
  | "common.time.minutesAgo.short"
  | "common.time.hoursAgo.short"
  | "common.time.daysAgo.short"

type Translate = (key: TimeKey, params?: Record<string, string | number>) => string

export function getRelativeTime(dateString: string, t: Translate): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return t("common.time.justNow")
  if (diffMinutes < 60) return t("common.time.minutesAgo.short", { count: diffMinutes })
  if (diffHours < 24) return t("common.time.hoursAgo.short", { count: diffHours })
  return t("common.time.daysAgo.short", { count: diffDays })
}

const relativeSteps = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
] as const

// 加整月,日子超出目标月份就夹到月底(3 月 31 日加一个月是 4 月 30 日)。
function addMonths(date: Date, months: number) {
  const next = new Date(date)
  next.setDate(1)
  next.setMonth(date.getMonth() + months)
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(date.getDate(), last))
  return next
}

// 从 from 走到 to 经过的整月数(to 早于 from 时为负),按本地日历算:较早的那头加上这么多个月不超过较晚的那头。
function wholeMonths(from: Date, to: Date) {
  const sign = to < from ? -1 : 1
  const [a, b] = sign < 0 ? [to, from] : [from, to]
  const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
  return sign * Math.max(0, addMonths(a, months) > b ? months - 1 : months)
}

/**
 * 「3 天前」这类整句相对时间,措辞交给 `Intl.RelativeTimeFormat`。规矩照从前用的 luxon `toRelative()`:
 * 年 / 月 / 日 / 时 / 分 / 秒里取第一个满 1 的单位,向零取整;不满 1 秒说「0 秒前」。
 */
export function formatRelative(value: number, locale: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" })
  const months = wholeMonths(new Date(now), new Date(value))
  if (Math.abs(months) >= 12) return format.format(Math.trunc(months / 12), "year")
  if (Math.abs(months) >= 1) return format.format(months, "month")
  const diff = value - now
  for (const [unit, ms] of relativeSteps) {
    if (Math.abs(diff) >= ms) return format.format(Math.trunc(diff / ms), unit)
  }
  return format.format(diff < 0 ? -0 : 0, "second")
}

// 本地时区的日历日,压成一个可以直接比的数。
function localDay(date: Date) {
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate()
}

/** 这个时刻落在本地日历的今天、昨天,还是更早(明天以后也算 older)。 */
export function dayBucket(value: number, now = new Date()): "today" | "yesterday" | "older" {
  const day = localDay(new Date(value))
  if (day === localDay(now)) return "today"
  if (day === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "yesterday"
  return "older"
}
