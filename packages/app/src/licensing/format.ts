/**
 * 授权信息的**纯函数**层:时区格式化、剩余天数、错误码 / 状态 → i18n 键。
 *
 * 三条刻意的规矩:
 *
 * 1. **时区必须写出来。** 内核给的三个时间都是 UTC ISO(`…Z`),用户看到的是本机时区的
 *    墙上时钟 —— 不写时区名与偏移,跨时区的客户会拿着"9 月 20 日到期"去和开发者对账,
 *    而两边说的不是同一个时刻。偏移**自己算**(从同一时刻在该时区的墙上时钟反推),
 *    不依赖 `timeZoneName: "longOffset"` —— 裁过 ICU 的环境里那个选项会静默退化成 "GMT"。
 *
 * 2. **到期时刻不含端点。** 内核判的是 `now < expiresAt`,所以 `expiresAt` 落在本地 00:00 时
 *    "到 10-21 00:00"会被读成"10 月 21 日还能用一天"。这一类一律渲染成前一天的 `24:00`,
 *    并另给一句"最后一天 10-20"。
 *
 * 3. **每一个会被拼出来的 i18n 键都在这里列成数组**,并用类型断言钉住它穷尽了联合
 *    (`LicenseErrorCode` / `LicenseState` 是类型,运行时枚举不出来)。solid 的 translator
 *    对缺键返回 `undefined`,漏一条的表现是界面上出现 `undefined` 而不是报错。
 */

import type { LicenseErrorCode, LicenseRequiredData, LicenseState, LicenseStatusView } from "@yoma-desktop/kernel"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** `setTimeout` 的上限:超过 2^31-1 毫秒会被当成 0 立刻开火。 */
export const MAX_TIMEOUT_MS = 2_147_483_647

// ── 键表(运行时可枚举,类型上穷尽)────────────────────────────────────────────

export const LICENSE_ERROR_CODES = [
  "too-large",
  "empty",
  "not-json",
  "bad-envelope",
  "bad-encoding",
  "bad-payload",
  "unknown-key",
  "bad-signature",
  "wrong-product",
  "unsupported-version",
  "bad-field",
  "bad-dates",
  "expired",
  "not-yet-valid",
  "older-than-current",
  "no-trusted-keys",
  "io",
] as const satisfies readonly LicenseErrorCode[]

export const LICENSE_STATES = [
  "not-required",
  "missing",
  "active",
  "not-yet-valid",
  "expired",
  "invalid",
] as const satisfies readonly LicenseState[]

/** 被执行入口拦下时可能的状态(内核的 `LicenseRequiredData["state"]`)。 */
export const LICENSE_REQUIRED_STATES = ["missing", "not-yet-valid", "expired", "invalid"] as const satisfies readonly LicenseRequiredData["state"][]

export type LicenseRequiredState = (typeof LICENSE_REQUIRED_STATES)[number]

/**
 * 上面三张表必须**反向也穷尽**:`satisfies` 只保证数组里的值都属于联合,不保证联合里的
 * 每个值都在数组里。内核往联合里加一个新值而这里忘了跟,下面三行就编译不过 —— 这正是
 * 它们存在的全部理由。
 *
 * 写成 `const x: Missing[] = []` 是**无效的**(空数组对任何数组类型都成立,实测不报错);
 * 必须让那个差集本身去撞 `extends never` 这道约束。
 */
type AssertNever<T extends never> = T
export type ExhaustiveErrorCodes = AssertNever<Exclude<LicenseErrorCode, (typeof LICENSE_ERROR_CODES)[number]>>
export type ExhaustiveStates = AssertNever<Exclude<LicenseState, (typeof LICENSE_STATES)[number]>>
export type ExhaustiveRequiredStates = AssertNever<Exclude<LicenseRequiredData["state"], LicenseRequiredState>>

/** 状态徽标的短名。 */
export function licenseStateKey(state: LicenseState) {
  return `settings.license.state.${state}`
}

/** 状态的一句话解释。 */
export function licenseStateDetailKey(state: LicenseState) {
  return `settings.license.stateDetail.${state}`
}

/**
 * 导入被拒 / 现有授权无效时那一句人话的键。
 *
 * 未知 code(内核加了新的而这里还没跟)返回 `undefined` —— 调用点据此回落到内核给的
 * `message`(它本身就是中文人话),而不是渲染一条 `settings.license.error.<新码>` 的
 * 缺键,那在界面上会变成 `undefined`。
 */
export function licenseErrorKey(code: string) {
  const known = (LICENSE_ERROR_CODES as readonly string[]).includes(code)
  return known ? `settings.license.error.${code}` : undefined
}

/** 执行被拦下时的状态:内核以后加了新值也不会让界面渲染出 `undefined`。 */
export function licenseRequiredState(state: string): LicenseRequiredState {
  return (LICENSE_REQUIRED_STATES as readonly string[]).includes(state) ? (state as LicenseRequiredState) : "invalid"
}

export function licenseRequiredTitleKey(state: string) {
  return `license.required.${licenseRequiredState(state)}.title`
}

export function licenseRequiredDescriptionKey(state: string) {
  return `license.required.${licenseRequiredState(state)}.description`
}

/** 提示里该说哪一天:到期说到期日,未生效说生效日,其余没有日期可说。 */
export function licenseRequiredInstant(data: Pick<LicenseRequiredData, "state" | "expiresAt" | "notBefore">) {
  const state = licenseRequiredState(data.state)
  if (state === "expired") return data.expiresAt
  if (state === "not-yet-valid") return data.notBefore
  return undefined
}

// ── 时区与时刻 ────────────────────────────────────────────────────────────────

/** 本机时区;拿不到(测试环境裁过 Intl)时用 UTC,而不是抛。 */
export function resolveTimeZone(timeZone?: string) {
  if (timeZone) return timeZone
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

/** 某个时刻在某个时区的墙上时钟。`hourCycle: "h23"` 是承重的:h24 会把午夜给成 24 点。 */
function wallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date)
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0")
  return { year: pick("year"), month: pick("month"), day: pick("day"), hour: pick("hour"), minute: pick("minute") }
}

const dateText = (clock: WallClock) => `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`
const clockText = (clock: WallClock) => `${dateText(clock)} ${pad(clock.hour)}:${pad(clock.minute)}`

/**
 * 时区偏移 `UTC+08:00`。从"同一时刻的墙上时钟"反推,不问 `timeZoneName` ——
 * 那个选项在裁过 ICU 的环境里给的是 "GMT",偏移就丢了。
 */
export function zoneOffsetText(date: Date, timeZone: string) {
  const clock = wallClock(date, timeZone)
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute)
  // 墙上时钟只到分钟,所以先把原时刻也截到分钟再比,否则秒会渗进偏移。
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000
  const minutes = Math.round((asUtc - truncated) / 60_000)
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 时区那一段:`Asia/Shanghai,UTC+08:00`;时区名本身就是 UTC 时不重复。 */
export function zoneText(date: Date, timeZone: string) {
  const offset = zoneOffsetText(date, timeZone)
  if (!timeZone || timeZone === "UTC" || timeZone === "Etc/UTC") return offset
  return `${timeZone},${offset}`
}

/** 单个时刻(签发时间、上次检查)。 */
export function formatInstant(iso: string, timeZone?: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const zone = resolveTimeZone(timeZone)
  return clockText(wallClock(date, zone))
}

export interface ValidityRangeText {
  /** `2026-09-20 00:00` */
  start: string
  /** `2026-10-20 24:00`(到期时刻落在本地午夜)或 `2026-10-21 09:30`。 */
  end: string
  /** 到期时刻正好是本地 00:00 —— end 已按前一天 24:00 渲染。 */
  endAtMidnight: boolean
  /** `endAtMidnight` 时的最后一天 `2026-10-20`。 */
  lastDay?: string
  /** `Asia/Shanghai,UTC+08:00` */
  zone: string
}

/**
 * 有效期起止。`expiresAt` **不含端点**,所以它落在本地午夜时渲染成前一天的 24:00 ——
 * "到 10-21 00:00"会被读成 10 月 21 日整天都能用。
 */
export function formatValidityRange(input: { notBefore: string; expiresAt: string; timeZone?: string }) {
  const zone = resolveTimeZone(input.timeZone)
  const from = new Date(input.notBefore)
  const to = new Date(input.expiresAt)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return {
      start: input.notBefore,
      end: input.expiresAt,
      endAtMidnight: false,
      zone: zoneText(new Date(), zone),
    } satisfies ValidityRangeText
  }
  const startClock = wallClock(from, zone)
  const endClock = wallClock(to, zone)
  const endAtMidnight = endClock.hour === 0 && endClock.minute === 0
  // 往回一分钟得到"最后一分钟"所在的那一天 —— 跨月 / 跨年 / 夏令时都不用自己算。
  const lastMinute = endAtMidnight ? wallClock(new Date(to.getTime() - 60_000), zone) : undefined
  return {
    start: clockText(startClock),
    end: lastMinute ? `${dateText(lastMinute)} 24:00` : clockText(endClock),
    endAtMidnight,
    lastDay: lastMinute ? dateText(lastMinute) : undefined,
    zone: zoneText(to, zone),
  } satisfies ValidityRangeText
}

// ── 剩余 / 已过期 ─────────────────────────────────────────────────────────────

export type LicenseCountdown =
  | { kind: "remaining-days"; days: number }
  | { kind: "remaining-hours"; hours: number }
  | { kind: "expired-today" }
  | { kind: "expired-days"; days: number }

/** 剩多久 / 过期多久。不可解析的时间返回 undefined(界面就不显示这一行)。 */
export function licenseCountdown(expiresAt: string, now: number): LicenseCountdown | undefined {
  const end = Date.parse(expiresAt)
  if (!Number.isFinite(end)) return undefined
  const left = end - now
  if (left > 0) {
    const days = Math.floor(left / DAY_MS)
    if (days >= 1) return { kind: "remaining-days", days }
    return { kind: "remaining-hours", hours: Math.max(1, Math.ceil(left / HOUR_MS)) }
  }
  const gone = Math.floor(-left / DAY_MS)
  return gone >= 1 ? { kind: "expired-days", days: gone } : { kind: "expired-today" }
}

export function licenseCountdownKey(countdown: LicenseCountdown) {
  switch (countdown.kind) {
    case "remaining-days":
      return "settings.license.countdown.remainingDays"
    case "remaining-hours":
      return "settings.license.countdown.remainingHours"
    case "expired-days":
      return "settings.license.countdown.expiredDays"
    case "expired-today":
      return "settings.license.countdown.expiredToday"
  }
}

export function licenseCountdownVars(countdown: LicenseCountdown): Record<string, string> {
  if (countdown.kind === "remaining-days" || countdown.kind === "expired-days") return { days: String(countdown.days) }
  if (countdown.kind === "remaining-hours") return { hours: String(countdown.hours) }
  return {}
}

// ── 到点重查 ─────────────────────────────────────────────────────────────────

/**
 * 下一次该重新问内核状态的延迟。页面开着不动的时候,`active` 会在 `expiresAt` 变成
 * `expired`、`not-yet-valid` 会在 `notBefore` 变成 `active` —— 没有这只定时器,
 * 徽标会一直停在打开页面那一刻的答案上。
 *
 * 超过 `setTimeout` 上限就先睡到上限(回来再算一次),否则 2^31 以上的延迟会被当成 0
 * 立刻开火,变成一个每 tick 都在打 RPC 的循环。
 */
export function nextLicenseCheckDelay(status: LicenseStatusView | undefined, now: number) {
  const license = status?.license
  if (!license) return undefined
  const target =
    status?.state === "active" ? license.expiresAt : status?.state === "not-yet-valid" ? license.notBefore : undefined
  if (!target) return undefined
  const at = Date.parse(target)
  if (!Number.isFinite(at)) return undefined
  const delay = at - now
  if (delay <= 0) return undefined
  // +1s:定时器早一毫秒醒来会拿到同一个状态,然后再也不重排。
  return Math.min(delay + 1_000, MAX_TIMEOUT_MS)
}

// ── 杂项 ─────────────────────────────────────────────────────────────────────

/** 文件大小上限那句话里的 "16 KB"。 */
export function formatByteLimit(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
