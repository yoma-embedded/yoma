/**
 * 软件授权的浏览器安全视图:状态、错误码、跨进程的错误形状。
 *
 * 这里**只有类型与常量**。验签、读写授权文件、执行资格检查全在 Node 侧的
 * `host/licensing/`(那半边碰 `node:crypto` 与文件系统,菜单里不许有)。
 *
 * 界面拿到的 `LicenseStatusView` 只用于**显示**。能不能开始一轮由内核在执行入口自己判,
 * 不读 renderer 传来的任何"已付费"标志 —— 协议里也没有这样的参数。
 */

/** 授权文件里固定的产品标识:别的产品的授权不会被误用。 */
export const LICENSE_PRODUCT = "yoma-desktop"
/** 授权 payload 的格式版本。 */
export const LICENSE_SCHEMA_VERSION = 1
/** 客户拿到的授权文件的扩展名(界面的文件选择器按它过滤)。 */
export const LICENSE_FILE_EXTENSION = ".yoma-license"
/** 导入文件的大小上限(字节)。真实授权不到 1 KB;上限只为挡住误选的大文件与恶意输入。 */
export const LICENSE_MAX_BYTES = 16 * 1024

/**
 * - `not-required`:开发态(源码直跑、没注入可信公钥的本机构建),不检查授权。**不是一个产品形态**:
 *   这种构建打不成安装包,客户手里的软件永远不会是这个状态;
 * - `missing`:未激活(没有授权文件);
 * - `active`:已激活,在有效期内;
 * - `not-yet-valid`:授权有效,但还没到生效时间;
 * - `expired`:已到期;
 * - `invalid`:授权文件无效(损坏、被改过、不是这个产品的、签名公钥不受信任……)。
 */
export type LicenseState = "not-required" | "missing" | "active" | "not-yet-valid" | "expired" | "invalid"

/** 授权文件为什么不被接受。界面按 code 出文案,`message` 给排查。 */
export type LicenseErrorCode =
  /** 文件超过大小上限。 */
  | "too-large"
  /** 空文件。 */
  | "empty"
  /** 不是 JSON。 */
  | "not-json"
  /** 外层结构不对(不是 Yoma 授权文件)。 */
  | "bad-envelope"
  /** payload / signature 不是合法的 base64url。 */
  | "bad-encoding"
  /** payload 不是 JSON 对象。 */
  | "bad-payload"
  /** 签名用的公钥不在这个构建的可信名单里。 */
  | "unknown-key"
  /** 签名对不上(内容被改过,或不是用那把私钥签的)。 */
  | "bad-signature"
  /** 不是这个产品的授权。 */
  | "wrong-product"
  /** 授权格式版本这个客户端不认识。 */
  | "unsupported-version"
  /** 字段缺失或类型不对。 */
  | "bad-field"
  /** 日期关系不成立(生效不早于到期等)。 */
  | "bad-dates"
  /** 导入时已经过期。 */
  | "expired"
  /** 还没生效,而当前授权仍然有效 —— 导入它只会让现状变差。 */
  | "not-yet-valid"
  /** 当前授权的有效期不短于这份文件。 */
  | "older-than-current"
  /** 这个构建没有可信公钥(构建配置错误,或开发态;正常的出包流程会直接失败)。 */
  | "no-trusted-keys"
  /** 读写授权文件失败。 */
  | "io"

export interface LicenseInfoView {
  licenseId: string
  customerLabel: string
  /** 三个时间都是 UTC 的 ISO 8601(`…Z`)。界面显示时换成本机时区并**写明时区**。 */
  issuedAt: string
  notBefore: string
  expiresAt: string
  signingKeyId: string
}

export interface LicenseStatusView {
  /** 这个构建是否在执行入口强制检查授权。安装包恒为 true;false 只出现在开发态。 */
  enforced: boolean
  state: LicenseState
  /** 验签通过的授权内容。`invalid` / `missing` 时没有。 */
  license?: LicenseInfoView
  /** `invalid` 时的原因。 */
  error?: { code: LicenseErrorCode; message: string }
  /** 做出这次判断的时刻(UTC ISO)。 */
  checkedAt: string
  /** 授权文件在本机的位置(`<configDir>/license.json`),给排查用。 */
  file: string
  /** 这个构建信任的签名公钥编号(不是秘密)。 */
  trustedKeyIds: string[]
}

/** 哪一类执行被拦下了。 */
export type LicensedExecutionKind = "session.prompt" | "session.compact" | "bench.turn" | "mailbox.start"

/**
 * 没有有效授权时,执行入口抛出的结构化错误(跨 MessagePort / contextBridge 走 `error.data`)。
 * 前端认 `_tag` 出"去激活"的提示,而不是一条笼统的内核报错。
 */
export interface LicenseRequiredData {
  _tag: "LicenseRequiredError"
  state: Exclude<LicenseState, "active" | "not-required">
  execution: LicensedExecutionKind
  /** `expired` / `not-yet-valid` 时带上,界面好说清楚是哪一天。 */
  notBefore?: string
  expiresAt?: string
  [key: string]: unknown
}

/** 导入被拒时 `error.data` 的形状。 */
export interface LicenseImportErrorData {
  _tag: "LicenseImportError"
  code: LicenseErrorCode
  [key: string]: unknown
}

export function isLicenseRequiredData(value: unknown): value is LicenseRequiredData {
  return !!value && typeof value === "object" && (value as { _tag?: unknown })._tag === "LicenseRequiredError"
}

export function isLicenseImportErrorData(value: unknown): value is LicenseImportErrorData {
  return !!value && typeof value === "object" && (value as { _tag?: unknown })._tag === "LicenseImportError"
}
