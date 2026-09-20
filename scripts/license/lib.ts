/**
 * 授权**签发端**的库:密钥生成、签发、续期的日期计算。只给开发者工具(`scripts/license.ts`)与测试用。
 *
 * **它不在任何产物入口的依赖图上。** 产物里只有验签(`packages/kernel/src/host/licensing/`);
 * `ISSUER_MARKER` 这个字符串就是给 `verify-commercial-artifact` 查"签发工具有没有混进安装包"用的。
 *
 * 文件格式与校验规则只有一份真源 —— 这里从内核的 `format.ts` 拿,不另抄。
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto"

import { LICENSE_PRODUCT, LICENSE_SCHEMA_VERSION } from "../../packages/kernel/src/license-view.ts"
import {
  KEY_ID_PATTERN,
  LICENSE_ID_PATTERN,
  encodeLicenseFile,
  parseUtcIso,
  verifyLicenseFile,
  type LicensePayload,
  type TrustedLicenseKey,
} from "../../packages/kernel/src/host/licensing/format.ts"

/** 产物检查按这个字符串判"签发工具混进来了"。别删,别在产品代码里出现。 */
export const ISSUER_MARKER = "yoma-license-issuer-tool/v1"

/** 这些前缀的公钥编号一律视为测试用,商业构建拒收(`license-build.ts` 用同一张表)。 */
export const TEST_KEY_ID_PATTERN = /^(test|e2e|dev|demo|tmp|sample|example)([._-]|$)/

export interface GeneratedSigningKey {
  keyId: string
  /** PKCS#8 PEM。`passphrase` 给了就是加密的。**只该落到仓库外的文件里,不进日志。** */
  privateKeyPem: string
  trusted: TrustedLicenseKey
  fingerprint: string
}

export function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`公钥编号 ${JSON.stringify(keyId)} 不合法:小写字母或数字开头,3–64 位,只含 a-z 0-9 . _ -`)
  }
}

/** 公钥指纹:SPKI DER 的 SHA-256,十六进制。备份、构建日志、产物检查三处对的是同一个值。 */
export function fingerprintOf(publicKeySpkiB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeySpkiB64, "base64")).digest("hex")
}

function spkiB64(key: KeyObject): string {
  return (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64")
}

export function generateSigningKey(keyId: string, options: { passphrase?: string } = {}): GeneratedSigningKey {
  assertKeyId(keyId)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const privateKeyPem = (
    options.passphrase
      ? privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: options.passphrase })
      : privateKey.export({ format: "pem", type: "pkcs8" })
  ) as string
  const publicKeyB64 = spkiB64(publicKey)
  return {
    keyId,
    privateKeyPem,
    trusted: { id: keyId, publicKey: publicKeyB64 },
    fingerprint: fingerprintOf(publicKeyB64),
  }
}

export function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  const key = createPrivateKey(passphrase ? { key: pem, format: "pem", passphrase } : { key: pem, format: "pem" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("这不是 Ed25519 私钥")
  return key
}

export function trustedKeyOf(keyId: string, privateKey: KeyObject): TrustedLicenseKey {
  assertKeyId(keyId)
  return { id: keyId, publicKey: spkiB64(createPublicKey(privateKey)) }
}

// ---------------------------------------------------------------------------
// 有效期:按日历算,不按"30 天"算
// ---------------------------------------------------------------------------

export interface CalendarDate {
  year: number
  month: number
  day: number
}

/** `+08:00` / `-05:30` / `Z` → 相对 UTC 的分钟数。 */
export function parseTzOffset(text: string): number {
  if (text === "Z" || text === "z") return 0
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text)
  if (!match) throw new Error(`时区偏移 ${JSON.stringify(text)} 写法不对,应形如 +08:00`)
  const minutes = Number(match[2]) * 60 + Number(match[3])
  if (Number(match[2]) > 14 || Number(match[3]) > 59) throw new Error(`时区偏移 ${text} 超出范围`)
  return match[1] === "-" ? -minutes : minutes
}

export function formatTzOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+"
  const abs = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

export function parseCalendarDate(text: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) throw new Error(`日期 ${JSON.stringify(text)} 写法不对,应形如 2026-09-20`)
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new Error(`日期 ${text} 不存在`)
  }
  return date
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 加 N 个日历月;目标月没有这一天就落到月末(1 月 31 日 + 1 个月 = 2 月 28/29 日)。 */
export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() }
}

/** 某个时区里某一天的 00:00,换成 UTC 毫秒。 */
export function localMidnightUtcMs(date: CalendarDate, offsetMinutes: number): number {
  return Date.UTC(date.year, date.month - 1, date.day) - offsetMinutes * 60_000
}

/** UTC 毫秒落在某个时区里的哪一天。 */
export function calendarDateAt(utcMs: number, offsetMinutes: number): CalendarDate {
  const shifted = new Date(utcMs + offsetMinutes * 60_000)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
}

export function toUtcIso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z")
}

export interface LicensePeriod {
  notBefore: string
  expiresAt: string
  /** 给人看的一句话,带时区:`2026-09-20 00:00 至 2026-10-20 24:00(UTC+08:00)`。 */
  human: string
}

/**
 * 从某一天起 N 个日历月的有效期。
 *
 * 口径:**起始日 00:00 到"N 个月后的同一天"24:00**(含当日),都按给定时区的墙上时间。
 * 9 月 20 日买一个月 → 9 月 20 日 00:00 至 10 月 20 日 24:00。多给的这一天换来的是不必跟客户争
 * "20 号上午到底算不算到期"。
 */
/** 一次最多签 10 年。新签与续费共用:少了续费那一处,`--renew … --years 100` 会签出一份百年授权。 */
export function assertMonths(months: number): void {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("月数必须是 1–120 的整数")
}

export function periodFromMonths(from: CalendarDate, months: number, offsetMinutes: number): LicensePeriod {
  assertMonths(months)
  const lastDay = addCalendarMonths(from, months)
  return periodBetween(from, lastDay, offsetMinutes)
}

/** `from` 00:00 到 `lastDay` 24:00(含 lastDay 当日)。 */
export function periodBetween(from: CalendarDate, lastDay: CalendarDate, offsetMinutes: number): LicensePeriod {
  const notBeforeMs = localMidnightUtcMs(from, offsetMinutes)
  const expiresAtMs = localMidnightUtcMs(addCalendarDays(lastDay, 1), offsetMinutes)
  if (!(notBeforeMs < expiresAtMs)) throw new Error("有效期的结束早于开始")
  return {
    notBefore: toUtcIso(notBeforeMs),
    expiresAt: toUtcIso(expiresAtMs),
    human: `${formatCalendarDate(from)} 00:00 至 ${formatCalendarDate(lastDay)} 24:00(UTC${formatTzOffset(offsetMinutes)})`,
  }
}

/**
 * 续费:沿用旧授权,把到期日往后推 N 个日历月。
 *
 * - 旧授权还没到期:生效时间沿用旧的(客户看到的是一段连续的有效期),到期日 = 旧的最后一天 + N 个月;
 * - 旧授权已经过期:从今天重新起算(断档的那几天不补收也不补送)。
 */
export function renewalPeriod(
  previous: { notBefore: string; expiresAt: string },
  months: number,
  offsetMinutes: number,
  nowMs: number,
): LicensePeriod {
  assertMonths(months)
  const previousExpiry = parseUtcIso(previous.expiresAt)
  const previousStart = parseUtcIso(previous.notBefore)
  if (previousExpiry === undefined || previousStart === undefined) throw new Error("旧授权的日期解析不出来")
  if (previousExpiry <= nowMs) return periodFromMonths(calendarDateAt(nowMs, offsetMinutes), months, offsetMinutes)
  // 旧的到期时刻是"最后一天的 24:00",退 1 毫秒落回最后一天。
  const previousLastDay = calendarDateAt(previousExpiry - 1, offsetMinutes)
  const lastDay = addCalendarMonths(previousLastDay, months)
  const expiresAtMs = localMidnightUtcMs(addCalendarDays(lastDay, 1), offsetMinutes)
  return {
    notBefore: toUtcIso(previousStart),
    expiresAt: toUtcIso(expiresAtMs),
    human: `${formatCalendarDate(calendarDateAt(previousStart, offsetMinutes))} 00:00 至 ${formatCalendarDate(lastDay)} 24:00(UTC${formatTzOffset(offsetMinutes)}),由旧到期日顺延 ${months} 个月`,
  }
}

// ---------------------------------------------------------------------------
// 签发
// ---------------------------------------------------------------------------

export interface IssueLicenseInput {
  privateKey: KeyObject
  keyId: string
  licenseId: string
  customerLabel: string
  notBefore: string
  expiresAt: string
  /** 缺省为现在。 */
  issuedAt?: string
  /** 只给测试造"别的产品 / 别的版本"的授权用;工具的命令行不暴露。 */
  overrides?: Partial<Pick<LicensePayload, "product" | "schemaVersion">>
}

export interface IssuedLicense {
  /** 授权文件全文,直接写成 `.yoma-license`。 */
  text: string
  payload: LicensePayload
}

export function issueLicense(input: IssueLicenseInput): IssuedLicense {
  assertKeyId(input.keyId)
  if (!LICENSE_ID_PATTERN.test(input.licenseId)) {
    throw new Error(`授权编号 ${JSON.stringify(input.licenseId)} 不合法:字母或数字开头,3–64 位,只含字母 数字 . _ -`)
  }
  const customerLabel = input.customerLabel.trim()
  if (customerLabel.length === 0 || customerLabel.length > 200) throw new Error("购买人称呼为空或超过 200 字")
  const payload: LicensePayload = {
    schemaVersion: input.overrides?.schemaVersion ?? LICENSE_SCHEMA_VERSION,
    product: input.overrides?.product ?? LICENSE_PRODUCT,
    licenseId: input.licenseId,
    customerLabel,
    issuedAt: input.issuedAt ?? toUtcIso(Math.floor(Date.now() / 1000) * 1000),
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    signingKeyId: input.keyId,
  }
  // 签的就是下面这串字节;文件里存的也是这串字节的 base64url。客户端不重新序列化。
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8")
  const signature = sign(null, payloadBytes, input.privateKey)
  const text = encodeLicenseFile(payloadBytes, signature)

  // 自检:刚签出来的文件必须能被"只持有公钥的客户端"验过。测试造坏授权时跳过。
  if (!input.overrides) {
    const verified = verifyLicenseFile(text, [trustedKeyOf(input.keyId, input.privateKey)])
    if (!verified.ok) throw new Error(`签发自检失败(${verified.code}):${verified.message}`)
  }
  return { text, payload }
}
