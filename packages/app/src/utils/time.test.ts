import { describe, expect, test } from "vitest"
import { dayBucket, formatRelative } from "./time"

const at = (iso: string) => new Date(iso).getTime()

describe("formatRelative", () => {
  const now = at("2026-09-21T12:00:00")

  test("取第一个满 1 的单位,向零取整", () => {
    expect(formatRelative(now - 500, "en", now)).toBe("0 seconds ago")
    expect(formatRelative(now - 59_000, "en", now)).toBe("59 seconds ago")
    expect(formatRelative(now - 90_000, "en", now)).toBe("1 minute ago")
    expect(formatRelative(now - 3 * 3_600_000 - 59 * 60_000, "en", now)).toBe("3 hours ago")
    expect(formatRelative(at("2026-09-18T13:00:00"), "en", now)).toBe("2 days ago")
    expect(formatRelative(at("2026-08-22T12:00:00"), "en", now)).toBe("30 days ago")
    expect(formatRelative(at("2026-08-21T12:00:00"), "en", now)).toBe("1 month ago")
    expect(formatRelative(at("2025-10-01T00:00:00"), "en", now)).toBe("11 months ago")
    expect(formatRelative(at("2024-09-21T12:00:00"), "en", now)).toBe("2 years ago")
  })

  test("将来的时刻", () => {
    expect(formatRelative(now + 2 * 3_600_000, "en", now)).toBe("in 2 hours")
    expect(formatRelative(at("2026-11-21T12:00:00"), "en", now)).toBe("in 2 months")
  })

  test("措辞跟着 locale", () => {
    expect(formatRelative(at("2026-09-18T11:00:00"), "zh-CN", now)).toBe("3天前")
  })

  // 换掉 luxon 时拿它的 toRelative 做过差分(五个基准时刻 × 六万多个偏移,零差异);下面是当时最容易错的几处。
  test("月底夹取与恰好相等", () => {
    expect(formatRelative(now, "en", now)).toBe("in 0 seconds")
    const marchEnd = at("2026-03-31T23:30:00")
    expect(formatRelative(at("2026-04-30T23:30:00"), "en", marchEnd)).toBe("in 1 month")
    expect(formatRelative(at("2026-04-30T23:29:59"), "en", marchEnd)).toBe("in 29 days")
    const leapDay = at("2024-02-29T10:00:00")
    expect(formatRelative(at("2024-01-29T10:00:00"), "en", leapDay)).toBe("1 month ago")
    expect(formatRelative(at("2026-02-28T10:00:00"), "en", leapDay)).toBe("in 2 years")
  })
})

describe("dayBucket", () => {
  const now = new Date("2026-09-21T00:30:00")

  test("按本地日历日分,不按 24 小时", () => {
    expect(dayBucket(at("2026-09-21T00:00:00"), now)).toBe("today")
    expect(dayBucket(at("2026-09-21T23:59:59"), now)).toBe("today")
    expect(dayBucket(at("2026-09-20T23:59:59"), now)).toBe("yesterday")
    expect(dayBucket(at("2026-09-20T00:00:00"), now)).toBe("yesterday")
    expect(dayBucket(at("2026-09-19T23:59:59"), now)).toBe("older")
  })

  test("跨月跨年的昨天", () => {
    expect(dayBucket(at("2025-12-31T08:00:00"), new Date("2026-01-01T09:00:00"))).toBe("yesterday")
    expect(dayBucket(at("2026-02-28T08:00:00"), new Date("2026-03-01T09:00:00"))).toBe("yesterday")
  })

  test("明天以后不算今天", () => {
    expect(dayBucket(at("2026-09-22T08:00:00"), now)).toBe("older")
  })
})
