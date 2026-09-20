/**
 * 授权文件的格式与验签。纯函数,不读盘、不联网、不看时钟(时间由调用方传进来)。
 *
 * ## 文件长什么样
 *
 * ```json
 * { "format": "yoma-license", "version": 1, "payload": "<base64url>", "signature": "<base64url>" }
 * ```
 *
 * `payload` 是签发那一刻写下的 **UTF-8 JSON 原始字节**的 base64url,`signature` 是 Ed25519 对
 * **那一串字节**的签名。验签验的是解码出来的字节本身 —— 两边都不重新序列化 JSON,于是键序、
 * 空白、数字写法、Unicode 转义这些"同一个对象的不同写法"根本进不了签名的讨论范围。
 *
 * ## 顺序
 *
 * 大小上限 → 外层结构 → base64url 解码 → 从(尚不可信的)payload 里**只取 signingKeyId 去选公钥**
 * → 验签 → 验签通过之后才对字段、产品、格式版本、日期关系做严格校验。
 * 选公钥那一步读了未验签的内容,但它只被当成"可信名单里的查找键":名单之外的一律 `unknown-key`,
 * 客户文件里**不携带**公钥,也就不存在"自带公钥自证"这条路。
 *
 * 密码学只用 `node:crypto` 的 Ed25519(`crypto.verify(null, data, key, signature)`),不自己设计算法。
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto"

import {
  LICENSE_MAX_BYTES,
  LICENSE_PRODUCT,
  LICENSE_SCHEMA_VERSION,
  type LicenseErrorCode,
  type LicenseInfoView,
} from "../../license-view.ts"

export const LICENSE_ENVELOPE_FORMAT = "yoma-license"
export const LICENSE_ENVELOPE_VERSION = 1

/** Ed25519 签名恒为 64 字节。 */
const ED25519_SIGNATURE_BYTES = 64

/** 一把可信公钥:编号 + SPKI DER 的 base64(`openssl pkey -pubout -outform DER | base64` 的那种)。 */
export interface TrustedLicenseKey {
  id: string
  publicKey: string
}

/** 签名覆盖的内容。字段名与实施文档一致。 */
export interface LicensePayload {
  schemaVersion: number
  product: string
  licenseId: string
  customerLabel: string
  issuedAt: string
  notBefore: string
  expiresAt: string
  signingKeyId: string
}

export interface LicenseEnvelope {
  format: string
  version: number
  payload: string
  signature: string
}

export type LicenseVerification =
  | {
      ok: true
      license: LicenseInfoView
      /** 验过签的 payload 原始字节的 base64url:两份授权"是不是同一份"按它比。 */
      payloadB64: string
    }
  | { ok: false; code: LicenseErrorCode; message: string }

const reject = (code: LicenseErrorCode, message: string): LicenseVerification => ({ ok: false, code, message })

/** 编号的写法:小写字母数字开头,3–64 位,只含 `a-z 0-9 . _ -`。签发端与构建端共用。 */
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/
/** 授权编号:同上但允许大写(订单号常带大写)。 */
export const LICENSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
/** 严格的 UTC 时间写法。只收 `Z` 结尾 —— 带偏移的写法在签发端就换算掉,文件里永远只有一种。 */
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const CUSTOMER_LABEL_MAX = 200

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/**
 * 严格 base64url 解码:字符集不对、或解码再编码对不回原串(多余的尾位)一律拒绝。
 * Node 的 `Buffer.from(x, "base64url")` 对非法字符是**静默跳过**,不能直接信。
 */
export function fromBase64UrlStrict(text: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(text)) return undefined
  const bytes = Buffer.from(text, "base64url")
  return bytes.toString("base64url") === text ? bytes : undefined
}

/** 解析一把可信公钥;不是 Ed25519 的 SPKI 公钥就返回 undefined。 */
export function parseTrustedKey(key: TrustedLicenseKey): KeyObject | undefined {
  try {
    if (typeof key.publicKey !== "string" || key.publicKey.length === 0) return undefined
    const der = Buffer.from(key.publicKey, "base64")
    // 同上:base64 解码会静默吞掉非法字符,对回去才算数。
    if (der.toString("base64").replace(/=+$/, "") !== key.publicKey.replace(/=+$/, "")) return undefined
    const object = createPublicKey({ key: der, format: "der", type: "spki" })
    return object.asymmetricKeyType === "ed25519" ? object : undefined
  } catch {
    return undefined
  }
}

/** UTC ISO 串 → 毫秒;写法不严格或不是真实日期(2 月 30 日)返回 undefined。 */
export function parseUtcIso(text: unknown): number | undefined {
  if (typeof text !== "string" || !UTC_ISO_PATTERN.test(text)) return undefined
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return undefined
  // Date.parse 会把 02-30 滚成 03-02;对回去,滚过的就不认。
  const normalized = new Date(ms).toISOString()
  const canonical = text.length === 20 ? normalized.replace(".000Z", "Z") : normalized
  return canonical === text ? ms : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 第一步:大小、JSON、外层结构。 */
export function parseLicenseEnvelope(
  input: string | Uint8Array,
): { ok: true; envelope: LicenseEnvelope } | { ok: false; code: LicenseErrorCode; message: string } {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength
  if (bytes > LICENSE_MAX_BYTES) {
    return { ok: false, code: "too-large", message: `授权文件 ${bytes} 字节,超过上限 ${LICENSE_MAX_BYTES} 字节` }
  }
  let text: string
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input)
  } catch {
    return { ok: false, code: "not-json", message: "授权文件不是 UTF-8 文本" }
  }
  // 从邮件 / 聊天软件另存出来的文件常带 BOM。
  text = text.replace(/^﻿/, "").trim()
  if (text.length === 0) return { ok: false, code: "empty", message: "授权文件是空的" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: "not-json", message: "授权文件不是合法的 JSON" }
  }
  if (!isPlainObject(parsed)) return { ok: false, code: "bad-envelope", message: "授权文件的最外层不是对象" }
  if (parsed.format !== LICENSE_ENVELOPE_FORMAT) {
    return { ok: false, code: "bad-envelope", message: "这不是 Yoma 的授权文件(format 不符)" }
  }
  if (parsed.version !== LICENSE_ENVELOPE_VERSION) {
    return {
      ok: false,
      code: "unsupported-version",
      message: `授权文件的外层版本是 ${JSON.stringify(parsed.version)},这个客户端只认 ${LICENSE_ENVELOPE_VERSION}`,
    }
  }
  if (typeof parsed.payload !== "string" || typeof parsed.signature !== "string") {
    return { ok: false, code: "bad-envelope", message: "授权文件缺 payload 或 signature" }
  }
  const extra = Object.keys(parsed).filter((key) => !["format", "version", "payload", "signature"].includes(key))
  if (extra.length > 0) {
    return { ok: false, code: "bad-envelope", message: `授权文件外层有不认识的字段:${extra.join("、")}` }
  }
  return {
    ok: true,
    envelope: {
      format: LICENSE_ENVELOPE_FORMAT,
      version: LICENSE_ENVELOPE_VERSION,
      payload: parsed.payload,
      signature: parsed.signature,
    },
  }
}

/** 验签通过之后的严格字段校验。 */
function validatePayload(payload: Record<string, unknown>): LicenseVerification | LicensePayload {
  const expected = [
    "schemaVersion",
    "product",
    "licenseId",
    "customerLabel",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "signingKeyId",
  ]
  const missing = expected.filter((key) => !(key in payload))
  if (missing.length > 0) return reject("bad-field", `授权缺少字段:${missing.join("、")}`)
  const extra = Object.keys(payload).filter((key) => !expected.includes(key))
  if (extra.length > 0) return reject("bad-field", `授权里有这个客户端不认识的字段:${extra.join("、")}`)

  if (payload.product !== LICENSE_PRODUCT) {
    return reject("wrong-product", `这份授权是给 ${JSON.stringify(payload.product)} 的,不是 ${LICENSE_PRODUCT}`)
  }
  if (payload.schemaVersion !== LICENSE_SCHEMA_VERSION) {
    return reject(
      "unsupported-version",
      `授权格式版本是 ${JSON.stringify(payload.schemaVersion)},这个客户端只认 ${LICENSE_SCHEMA_VERSION}`,
    )
  }
  if (typeof payload.licenseId !== "string" || !LICENSE_ID_PATTERN.test(payload.licenseId)) {
    return reject("bad-field", "licenseId 不是合法的授权编号")
  }
  if (
    typeof payload.customerLabel !== "string" ||
    payload.customerLabel.trim().length === 0 ||
    payload.customerLabel.length > CUSTOMER_LABEL_MAX
  ) {
    return reject("bad-field", "customerLabel 为空或过长")
  }
  if (typeof payload.signingKeyId !== "string" || !KEY_ID_PATTERN.test(payload.signingKeyId)) {
    return reject("bad-field", "signingKeyId 不是合法的公钥编号")
  }
  const issuedAt = parseUtcIso(payload.issuedAt)
  const notBefore = parseUtcIso(payload.notBefore)
  const expiresAt = parseUtcIso(payload.expiresAt)
  if (issuedAt === undefined || notBefore === undefined || expiresAt === undefined) {
    return reject("bad-field", "issuedAt / notBefore / expiresAt 必须是 UTC 的 ISO 8601 时间(以 Z 结尾)")
  }
  if (!(notBefore < expiresAt)) return reject("bad-dates", "生效时间不早于到期时间")
  // 续费可以在周期开始之后补签,所以 issuedAt 不要求早于 notBefore;但不可能在到期之后才签出来。
  if (!(issuedAt < expiresAt)) return reject("bad-dates", "签发时间不早于到期时间")

  return {
    schemaVersion: LICENSE_SCHEMA_VERSION,
    product: LICENSE_PRODUCT,
    licenseId: payload.licenseId,
    customerLabel: payload.customerLabel,
    issuedAt: payload.issuedAt as string,
    notBefore: payload.notBefore as string,
    expiresAt: payload.expiresAt as string,
    signingKeyId: payload.signingKeyId,
  }
}

/**
 * 验一份授权文件。**不看时钟**:过没过期由调用方拿 `license.notBefore / expiresAt` 对着自己的"现在"判,
 * 这样同一份存盘的授权在到期前后得到的是两个状态,而不是两次不同的"验签结果"。
 */
export function verifyLicenseFile(
  input: string | Uint8Array,
  trustedKeys: readonly TrustedLicenseKey[],
): LicenseVerification {
  const parsed = parseLicenseEnvelope(input)
  if (!parsed.ok) return parsed
  const { envelope } = parsed

  const payloadBytes = fromBase64UrlStrict(envelope.payload)
  const signature = fromBase64UrlStrict(envelope.signature)
  if (!payloadBytes || !signature) return reject("bad-encoding", "payload 或 signature 不是合法的 base64url")
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return reject("bad-signature", "签名长度不对(Ed25519 签名恒为 64 字节)")
  }

  let untrusted: unknown
  try {
    untrusted = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes))
  } catch {
    return reject("bad-payload", "payload 不是合法的 UTF-8 JSON")
  }
  if (!isPlainObject(untrusted)) return reject("bad-payload", "payload 不是 JSON 对象")

  // 只拿它当查找键。名单里没有 = 不受信任,不管文件里还写了什么。
  const keyId = untrusted.signingKeyId
  if (typeof keyId !== "string") return reject("bad-field", "payload 里没有 signingKeyId")
  if (trustedKeys.length === 0) return reject("no-trusted-keys", "这个构建没有配置可信公钥,无法验证任何授权")
  const trusted = trustedKeys.find((key) => key.id === keyId)
  if (!trusted) return reject("unknown-key", `签名公钥 ${JSON.stringify(keyId)} 不在这个版本的可信名单里`)
  const publicKey = parseTrustedKey(trusted)
  if (!publicKey) return reject("no-trusted-keys", `可信公钥 ${trusted.id} 本身不是合法的 Ed25519 公钥(构建配置错误)`)

  let verified = false
  try {
    verified = verify(null, payloadBytes, publicKey, signature)
  } catch {
    verified = false
  }
  if (!verified) return reject("bad-signature", "签名校验失败:授权内容被改过,或不是用对应私钥签发的")

  const validated = validatePayload(untrusted)
  if ("ok" in validated) return validated
  return {
    ok: true,
    payloadB64: envelope.payload,
    license: {
      licenseId: validated.licenseId,
      customerLabel: validated.customerLabel,
      issuedAt: validated.issuedAt,
      notBefore: validated.notBefore,
      expiresAt: validated.expiresAt,
      signingKeyId: validated.signingKeyId,
    },
  }
}

/** 把"payload 字节 + 签名"装成授权文件文本。签发工具用;客户端只在测试里用到。 */
export function encodeLicenseFile(payloadBytes: Uint8Array, signature: Uint8Array): string {
  const envelope: LicenseEnvelope = {
    format: LICENSE_ENVELOPE_FORMAT,
    version: LICENSE_ENVELOPE_VERSION,
    payload: toBase64Url(payloadBytes),
    signature: toBase64Url(signature),
  }
  return `${JSON.stringify(envelope, null, 2)}\n`
}
