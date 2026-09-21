/**
 * 授权服务:当前状态、导入、**执行资格检查**。内核、调试台守护、桌面 main 共用这一份规则。
 *
 * ## 每次都重新读盘
 *
 * `status()` 不缓存:授权文件不到 1 KB,读一次 + 一次 Ed25519 验签是几十微秒的事。换来的是
 * "续费导入后不用重启":桌面内核导入新授权,**另一个进程**里因为到期而暂停的调试台守护下一次轮询
 * 就看得见;到期也一样 —— 不需要任何进程间通知。
 *
 * ## 检查发生在哪
 *
 * 只在**开始一次新的付费执行**的那一刻(`assertCanExecute`)。已经接受的轮次不再回头查:
 * 到期不会在烧录写到一半时把程序杀掉。停止、取消、释放设备、读历史、改设置、导出,一律不经过这里。
 *
 * ## 不做的事
 *
 * 不联网、不绑硬件、不防时钟回拨、不能即时吊销。首版接受这些限制(见实施文档)。
 */

import {
  type LicenseErrorCode,
  type LicenseImportErrorData,
  type LicenseRequiredData,
  type LicenseState,
  type LicenseStatusView,
  type LicensedExecutionKind,
} from "../../license-view.ts"
import { parseLicenseEnvelope, parseUtcIso, verifyLicenseFile, type LicenseVerification } from "./format.ts"
import { buildLicensePolicy, type LicensePolicy } from "./policy.ts"
import { defaultLicenseConfigDir, licenseFilePath, readStoredLicense, writeStoredLicenseAtomic } from "./store.ts"

/** 没有有效授权时执行入口抛的错。`data` 跨进程原样过去(kernel-entry 的响应帧带 `error.data`)。 */
export class LicenseRequiredError extends Error {
  readonly data: LicenseRequiredData
  constructor(message: string, data: LicenseRequiredData) {
    super(message)
    this.name = "LicenseRequiredError"
    this.data = data
  }
}

/** 导入被拒。原有授权文件一个字节都没动。 */
export class LicenseImportError extends Error {
  readonly code: LicenseErrorCode
  readonly data: LicenseImportErrorData
  constructor(code: LicenseErrorCode, message: string) {
    super(message)
    this.name = "LicenseImportError"
    this.code = code
    this.data = { _tag: "LicenseImportError", code }
  }
}

export interface LicenseServiceOptions {
  /** 授权文件所在目录,默认 `~/.yoma`。**测试必须传**隔离目录。 */
  configDir?: string
  /** 不传 = 这个构建编译期注入的策略。测试的代码级接缝;产物里没有任何配置能够到它。 */
  policy?: LicensePolicy
  /** 时钟。测试接缝;生产不传。 */
  now?: () => number
  /** 状态(state / 授权编号 / 到期时间)变了就叫一声。内核据此推 `license.updated`。 */
  onChange?: (status: LicenseStatusView) => void
}

export type LicenseCheck = { ok: true } | { ok: false; message: string; data: LicenseRequiredData }

export class LicenseService {
  private readonly configDir: string
  private readonly policy: LicensePolicy
  private readonly now: () => number
  private readonly onChange?: (status: LicenseStatusView) => void
  private lastFingerprint?: string

  constructor(options: LicenseServiceOptions = {}) {
    this.configDir = options.configDir ?? defaultLicenseConfigDir()
    this.policy = options.policy ?? buildLicensePolicy()
    this.now = options.now ?? Date.now
    this.onChange = options.onChange
  }

  get enforced(): boolean {
    return this.policy.enforced
  }

  /** 当前状态。每次重新读盘、重新验签、对着此刻的时钟判。 */
  status(): LicenseStatusView {
    const status = this.compute().view
    const fingerprint = `${status.state}|${status.license?.licenseId ?? ""}|${status.license?.expiresAt ?? ""}|${status.error?.code ?? ""}`
    if (this.lastFingerprint !== undefined && this.lastFingerprint !== fingerprint) this.onChange?.(status)
    this.lastFingerprint = fingerprint
    return status
  }

  private compute(): { view: LicenseStatusView; verified?: Extract<LicenseVerification, { ok: true }> } {
    const nowMs = this.now()
    const base = {
      enforced: this.enforced,
      checkedAt: new Date(nowMs).toISOString(),
      file: licenseFilePath(this.configDir),
      trustedKeyIds: this.policy.trustedKeys.map((key) => key.id),
    }
    if (!this.enforced) return { view: { ...base, state: "not-required" } }

    const stored = readStoredLicense(this.configDir)
    if (stored.kind === "missing") return { view: { ...base, state: "missing" } }
    if (stored.kind === "too-large") {
      return {
        view: { ...base, state: "invalid", error: { code: "too-large", message: `授权文件 ${stored.bytes} 字节,超过上限` } },
      }
    }
    if (stored.kind === "unreadable") {
      return { view: { ...base, state: "invalid", error: { code: "io", message: stored.message } } }
    }

    const verified = verifyLicenseFile(stored.text, this.policy.trustedKeys)
    if (!verified.ok) {
      return { view: { ...base, state: "invalid", error: { code: verified.code, message: verified.message } } }
    }
    return { view: { ...base, state: stateAt(verified, nowMs), license: verified.license }, verified }
  }

  /** 开始一次付费执行之前调用。不满足就抛 `LicenseRequiredError`,**在任何副作用之前**。 */
  assertCanExecute(execution: LicensedExecutionKind): void {
    const check = this.check(execution)
    if (!check.ok) throw new LicenseRequiredError(check.message, check.data)
  }

  /** 同上,但不抛:守护循环要的是"暂停"这个结果,不是异常。 */
  check(execution: LicensedExecutionKind): LicenseCheck {
    const status = this.status()
    if (status.state === "not-required" || status.state === "active") return { ok: true }
    const data: LicenseRequiredData = {
      _tag: "LicenseRequiredError",
      state: status.state,
      execution,
      notBefore: status.license?.notBefore,
      expiresAt: status.license?.expiresAt,
    }
    return { ok: false, message: blockedMessage(status), data }
  }

  /**
   * 导入一份授权文件的**文本**。通过才落盘;任何一种不通过都抛 `LicenseImportError`,盘上原样不动。
   *
   * 除了验签与字段校验,还有一条"**导入不能让现状变差**":
   * - 已经过期的文件不收(它永远不可能再有用);
   * - 当前授权有效时,不收还没生效的、也不收到期更早的 —— 多半是客户点错了旧文件,
   *   收下它等于把一个能用的软件变成不能用的。
   */
  importText(text: string): LicenseStatusView {
    if (!this.enforced) {
      throw new LicenseImportError(
        "no-trusted-keys",
        "这是开发态运行(构建时没有注入可信公钥):不检查授权,也验不了任何授权文件。要验证导入,请用带公钥的构建",
      )
    }
    if (typeof text !== "string") throw new LicenseImportError("bad-envelope", "导入内容不是文本")
    const incoming = verifyLicenseFile(text, this.policy.trustedKeys)
    if (!incoming.ok) throw new LicenseImportError(incoming.code, incoming.message)

    const nowMs = this.now()
    const incomingState = stateAt(incoming, nowMs)
    if (incomingState === "expired") {
      throw new LicenseImportError("expired", `这份授权已于 ${incoming.license.expiresAt}(UTC)到期。续费后请导入新签发的文件`)
    }

    const current = this.compute()
    if (current.view.state === "active" && current.verified) {
      // 同一份文件再导一次:什么都不用做,也不算错。
      if (current.verified.payloadB64 === incoming.payloadB64) return this.status()
      if (incomingState === "not-yet-valid") {
        throw new LicenseImportError(
          "not-yet-valid",
          `这份授权要到 ${incoming.license.notBefore}(UTC)才生效,而当前授权仍然有效 —— 现在导入会让软件在那之前无法使用。请到时再导入,或联系开发者签发与当前有效期衔接的授权`,
        )
      }
      const currentExpiry = parseUtcIso(current.verified.license.expiresAt) ?? 0
      const incomingExpiry = parseUtcIso(incoming.license.expiresAt) ?? 0
      if (incomingExpiry < currentExpiry) {
        throw new LicenseImportError(
          "older-than-current",
          `当前授权有效至 ${current.verified.license.expiresAt}(UTC),比这份文件(${incoming.license.expiresAt})更晚,无需导入`,
        )
      }
    }

    // 存盘的是归一过的外层(只有四个字段)。payload 是 base64url,重新序列化外层不碰被签名的字节。
    const parsed = parseLicenseEnvelope(text)
    if (!parsed.ok) throw new LicenseImportError(parsed.code, parsed.message)
    try {
      writeStoredLicenseAtomic(`${JSON.stringify(parsed.envelope, null, 2)}\n`, this.configDir)
    } catch (error) {
      throw new LicenseImportError("io", `授权文件写入失败:${(error as Error).message}`)
    }
    const after = this.status()
    if (after.state === "invalid") {
      // 写进去又读不回同一个结论:盘有问题。如实说,不假装成功。
      throw new LicenseImportError("io", `授权文件已写入但读回校验失败:${after.error?.message ?? "未知原因"}`)
    }
    return after
  }

  /**
   * 给客户"复制诊断信息"用的纯文本。**只含授权与环境事实**:没有 API key、没有 auth.json 的任何内容、
   * 没有授权文件的 payload / signature 原文,也不含购买人称呼。
   */
  diagnostics(extra: { appVersion?: string } = {}): string {
    const status = this.status()
    const offsetMinutes = -new Date(this.now()).getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? "+" : "-"
    const abs = Math.abs(offsetMinutes)
    const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
    const lines = [
      "Yoma 授权诊断信息",
      `应用版本: ${extra.appVersion ?? "未知"}`,
      `授权检查: ${status.enforced ? "强制" : "未启用(开发态,没有注入可信公钥)"}`,
      `系统: ${process.platform} ${process.arch} · Node ${process.versions.node}`,
      `本机时间: ${status.checkedAt}(UTC) · 时区 ${offset}`,
      `授权状态: ${status.state}`,
      `授权编号: ${status.license?.licenseId ?? "—"}`,
      `生效时间: ${status.license?.notBefore ?? "—"}`,
      `到期时间: ${status.license?.expiresAt ?? "—"}`,
      `签发时间: ${status.license?.issuedAt ?? "—"}`,
      `签名公钥编号: ${status.license?.signingKeyId ?? "—"}`,
      `此版本信任的公钥编号: ${status.trustedKeyIds.length > 0 ? status.trustedKeyIds.join(", ") : "(无)"}`,
      `错误: ${status.error ? `${status.error.code} — ${status.error.message}` : "—"}`,
      `授权文件位置: ${status.file}`,
    ]
    return `${lines.join("\n")}\n`
  }
}

function stateAt(verified: Extract<LicenseVerification, { ok: true }>, nowMs: number): LicenseState {
  const notBefore = parseUtcIso(verified.license.notBefore)
  const expiresAt = parseUtcIso(verified.license.expiresAt)
  // 验签通过的授权日期一定解析得出来;解析不出来只可能是内部错误,按无效处理而不是放行。
  if (notBefore === undefined || expiresAt === undefined) return "invalid"
  if (nowMs < notBefore) return "not-yet-valid"
  // 到期时间是**不含**的端点:有效期是 [notBefore, expiresAt)。
  if (nowMs >= expiresAt) return "expired"
  return "active"
}

function blockedMessage(status: LicenseStatusView): string {
  const tail = "历史记录、设置、停止与导出不受影响。"
  switch (status.state) {
    case "missing":
      return `软件尚未激活:请在「设置 → 授权」导入授权文件后再开始任务。${tail}`
    case "expired":
      return `软件授权已于 ${status.license?.expiresAt ?? "?"}(UTC)到期:续费并在「设置 → 授权」导入新的授权文件后即可继续。${tail}`
    case "not-yet-valid":
      return `软件授权要到 ${status.license?.notBefore ?? "?"}(UTC)才生效,在那之前不能开始新任务。${tail}`
    default:
      return `授权文件无效(${status.error?.code ?? "unknown"}:${status.error?.message ?? ""}):请在「设置 → 授权」重新导入开发者发给你的授权文件。${tail}`
  }
}
