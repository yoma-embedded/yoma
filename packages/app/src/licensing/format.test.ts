import { describe, expect, test } from "vitest"
import {
  formatByteLimit,
  formatInstant,
  formatValidityRange,
  licenseCountdown,
  licenseCountdownKey,
  licenseCountdownVars,
  licenseErrorKey,
  licenseRequiredDescriptionKey,
  licenseRequiredInstant,
  licenseRequiredState,
  licenseRequiredTitleKey,
  licenseStateDetailKey,
  licenseStateKey,
  MAX_TIMEOUT_MS,
  nextLicenseCheckDelay,
  zoneOffsetText,
  zoneText,
} from "./format"
import type { LicenseStatusView } from "@yoma-desktop/kernel"

/**
 * 时区一律**显式注入** —— CI 是 UTC,开发机是 +08:00。不注入的断言是"在谁的机器上跑"
 * 的函数,而这正是这一族函数存在的理由。
 */
const SH = "Asia/Shanghai"
const NY = "America/New_York"

const status = (over: Partial<LicenseStatusView>): LicenseStatusView => ({
  edition: "commercial",
  enforced: true,
  state: "active",
  checkedAt: "2026-09-20T00:00:00.000Z",
  file: "/home/u/.yoma/license.json",
  trustedKeyIds: ["k1"],
  ...over,
})

const info = (notBefore: string, expiresAt: string) => ({
  licenseId: "L-1",
  customerLabel: "某某电子",
  issuedAt: notBefore,
  notBefore,
  expiresAt,
  signingKeyId: "k1",
})

describe("时区与时刻", () => {
  test("偏移按时区算出来,不依赖 timeZoneName", () => {
    const at = new Date("2026-09-20T00:00:00.000Z")
    expect(zoneOffsetText(at, SH)).toBe("UTC+08:00")
    expect(zoneOffsetText(at, "UTC")).toBe("UTC+00:00")
    expect(zoneOffsetText(at, NY)).toBe("UTC-04:00")
    // 半小时偏移的时区(印度)不能被舍成整小时。
    expect(zoneOffsetText(at, "Asia/Kolkata")).toBe("UTC+05:30")
  })

  test("夏令时按那一刻算,不按今天算", () => {
    expect(zoneOffsetText(new Date("2026-01-15T12:00:00.000Z"), NY)).toBe("UTC-05:00")
    expect(zoneOffsetText(new Date("2026-07-15T12:00:00.000Z"), NY)).toBe("UTC-04:00")
  })

  test("时区那一段带时区名,UTC 不重复写", () => {
    const at = new Date("2026-09-20T00:00:00.000Z")
    expect(zoneText(at, SH)).toBe("Asia/Shanghai,UTC+08:00")
    expect(zoneText(at, "UTC")).toBe("UTC+00:00")
    expect(zoneText(at, "Etc/UTC")).toBe("UTC+00:00")
  })

  test("单个时刻换算到本机时区", () => {
    expect(formatInstant("2026-09-19T16:00:00.000Z", SH)).toBe("2026-09-20 00:00")
    expect(formatInstant("2026-09-19T16:00:00.000Z", "UTC")).toBe("2026-09-19 16:00")
  })

  test("不可解析的时间原样回显,不抛也不给 Invalid Date", () => {
    expect(formatInstant("not-a-date", SH)).toBe("not-a-date")
  })
})

describe("有效期区间", () => {
  test("起止都显示,带时区名与偏移", () => {
    const range = formatValidityRange({
      notBefore: "2026-09-19T16:00:00.000Z",
      expiresAt: "2026-10-20T16:00:00.000Z",
      timeZone: SH,
    })
    expect(range.start).toBe("2026-09-20 00:00")
    expect(range.zone).toBe("Asia/Shanghai,UTC+08:00")
  })

  /**
   * 到期时刻**不含端点**:落在本地 00:00 时渲染成前一天的 24:00。
   * 写成"到 2026-10-21 00:00"会被读成 10 月 21 日整天都能用 —— 差一整天。
   */
  test("到期时刻正好本地午夜 → 前一天 24:00 + 最后一天", () => {
    const range = formatValidityRange({
      notBefore: "2026-09-19T16:00:00.000Z",
      expiresAt: "2026-10-20T16:00:00.000Z", // = 2026-10-21 00:00 +08:00
      timeZone: SH,
    })
    expect(range.endAtMidnight).toBe(true)
    expect(range.end).toBe("2026-10-20 24:00")
    expect(range.lastDay).toBe("2026-10-20")
  })

  test("月初午夜要回退到上一个月的最后一天", () => {
    const range = formatValidityRange({
      notBefore: "2026-08-31T16:00:00.000Z",
      expiresAt: "2026-09-30T16:00:00.000Z", // = 2026-10-01 00:00 +08:00
      timeZone: SH,
    })
    expect(range.end).toBe("2026-09-30 24:00")
    expect(range.lastDay).toBe("2026-09-30")
  })

  test("不是午夜的到期时刻照原样显示,没有最后一天那一行", () => {
    const range = formatValidityRange({
      notBefore: "2026-09-19T16:00:00.000Z",
      expiresAt: "2026-10-21T01:30:00.000Z", // = 2026-10-21 09:30 +08:00
      timeZone: SH,
    })
    expect(range.endAtMidnight).toBe(false)
    expect(range.end).toBe("2026-10-21 09:30")
    expect(range.lastDay).toBeUndefined()
  })

  test("同一个时刻在另一个时区不是午夜 —— 24:00 那条规则按本机时区判", () => {
    const range = formatValidityRange({
      notBefore: "2026-09-19T16:00:00.000Z",
      expiresAt: "2026-10-20T16:00:00.000Z",
      timeZone: NY,
    })
    expect(range.endAtMidnight).toBe(false)
    expect(range.end).toBe("2026-10-20 12:00")
  })

  test("坏时间原样回显,不炸", () => {
    const range = formatValidityRange({ notBefore: "x", expiresAt: "y", timeZone: SH })
    expect(range.start).toBe("x")
    expect(range.end).toBe("y")
    expect(range.lastDay).toBeUndefined()
  })
})

describe("剩余 / 已过期", () => {
  const at = Date.parse("2026-10-21T00:00:00.000Z")

  test("还有整天数", () => {
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at - 10 * 86_400_000)).toEqual({
      kind: "remaining-days",
      days: 10,
    })
  })

  test("不到一天按小时说,并且至少 1 小时(不说「还有 0 小时」)", () => {
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at - 5 * 3_600_000)).toEqual({
      kind: "remaining-hours",
      hours: 5,
    })
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at - 1_000)).toEqual({ kind: "remaining-hours", hours: 1 })
  })

  test("刚过期算「今天到期」,过了一天以上才数天", () => {
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at)).toEqual({ kind: "expired-today" })
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at + 3_600_000)).toEqual({ kind: "expired-today" })
    expect(licenseCountdown("2026-10-21T00:00:00.000Z", at + 3 * 86_400_000)).toEqual({
      kind: "expired-days",
      days: 3,
    })
  })

  test("坏时间没有倒计时可说", () => {
    expect(licenseCountdown("nope", at)).toBeUndefined()
  })

  test("每一种都有键与变量", () => {
    expect(licenseCountdownKey({ kind: "remaining-days", days: 2 })).toBe("settings.license.countdown.remainingDays")
    expect(licenseCountdownVars({ kind: "remaining-days", days: 2 })).toEqual({ days: "2" })
    expect(licenseCountdownKey({ kind: "remaining-hours", hours: 2 })).toBe("settings.license.countdown.remainingHours")
    expect(licenseCountdownVars({ kind: "remaining-hours", hours: 2 })).toEqual({ hours: "2" })
    expect(licenseCountdownKey({ kind: "expired-days", days: 2 })).toBe("settings.license.countdown.expiredDays")
    expect(licenseCountdownKey({ kind: "expired-today" })).toBe("settings.license.countdown.expiredToday")
    expect(licenseCountdownVars({ kind: "expired-today" })).toEqual({})
  })
})

describe("键的选择", () => {
  test("状态键按状态拼", () => {
    expect(licenseStateKey("not-required")).toBe("settings.license.state.not-required")
    expect(licenseStateDetailKey("expired")).toBe("settings.license.stateDetail.expired")
  })

  test("已知错误码给键,未知错误码给 undefined(调用点回落到内核的 message)", () => {
    expect(licenseErrorKey("bad-signature")).toBe("settings.license.error.bad-signature")
    expect(licenseErrorKey("io")).toBe("settings.license.error.io")
    expect(licenseErrorKey("brand-new-code")).toBeUndefined()
  })

  test("被拦下的状态:未知值夹到 invalid,不让界面渲染出 undefined", () => {
    expect(licenseRequiredState("expired")).toBe("expired")
    expect(licenseRequiredState("something-else")).toBe("invalid")
    expect(licenseRequiredTitleKey("missing")).toBe("license.required.missing.title")
    expect(licenseRequiredDescriptionKey("weird")).toBe("license.required.invalid.description")
  })

  test("说哪一天:到期说到期日,未生效说生效日,其余不说", () => {
    const dates = { expiresAt: "2026-10-21T00:00:00.000Z", notBefore: "2026-09-20T00:00:00.000Z" }
    expect(licenseRequiredInstant({ state: "expired", ...dates })).toBe(dates.expiresAt)
    expect(licenseRequiredInstant({ state: "not-yet-valid", ...dates })).toBe(dates.notBefore)
    expect(licenseRequiredInstant({ state: "missing", ...dates })).toBeUndefined()
    expect(licenseRequiredInstant({ state: "invalid", ...dates })).toBeUndefined()
  })
})

describe("到点重查", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z")

  test("active 排到到期那一刻(+1 秒,免得早醒一毫秒后再也不排)", () => {
    const view = status({ state: "active", license: info("2026-09-01T00:00:00.000Z", "2026-10-01T00:10:00.000Z") })
    expect(nextLicenseCheckDelay(view, now)).toBe(10 * 60_000 + 1_000)
  })

  test("not-yet-valid 排到生效那一刻", () => {
    const view = status({
      state: "not-yet-valid",
      license: info("2026-10-01T00:05:00.000Z", "2026-11-01T00:00:00.000Z"),
    })
    expect(nextLicenseCheckDelay(view, now)).toBe(5 * 60_000 + 1_000)
  })

  test("超过 setTimeout 上限时截断 —— 不截断的话会被当成 0 立刻开火", () => {
    const view = status({ state: "active", license: info("2026-09-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z") })
    expect(nextLicenseCheckDelay(view, now)).toBe(MAX_TIMEOUT_MS)
  })

  test("已经过期 / 无授权 / 已到期状态不再排", () => {
    expect(nextLicenseCheckDelay(status({ state: "missing" }), now)).toBeUndefined()
    expect(
      nextLicenseCheckDelay(
        status({ state: "expired", license: info("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z") }),
        now,
      ),
    ).toBeUndefined()
    // active 但到期时刻已经过去(时钟被拨过):不排一个负延迟。
    expect(
      nextLicenseCheckDelay(
        status({ state: "active", license: info("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z") }),
        now,
      ),
    ).toBeUndefined()
    expect(nextLicenseCheckDelay(undefined, now)).toBeUndefined()
  })
})

describe("杂项", () => {
  test("字节上限说成人话", () => {
    expect(formatByteLimit(16 * 1024)).toBe("16 KB")
    expect(formatByteLimit(3 * 1024 * 1024)).toBe("3 MB")
    expect(formatByteLimit(512)).toBe("512 B")
  })
})
