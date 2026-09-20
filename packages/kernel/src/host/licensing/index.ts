/**
 * 授权子系统的门:`@yoma-desktop/kernel/host/licensing`(**叶子门**)。
 *
 * 本目录只依赖 `node:crypto` / `node:fs` / `node:os` / `node:path` 与浏览器安全的 `license-view.ts`,
 * 不碰会话间、发动机、工具间。所以 desktop 的 main 与 bench 可以直接 import 它,而不会把整个 host
 * inline 进自己的产物(与 `./host/datasheet-server` 同一个道理)。`licensing.test.ts` 钉着这条。
 *
 * **这里没有签发能力**:私钥、签名、密钥生成都在仓库根的 `scripts/license/`,那是开发者工具,
 * 不在任何产物入口的依赖图上(`verify-commercial-artifact` 会查)。
 */

export {
  KEY_ID_PATTERN,
  LICENSE_ENVELOPE_FORMAT,
  LICENSE_ENVELOPE_VERSION,
  LICENSE_ID_PATTERN,
  encodeLicenseFile,
  fromBase64UrlStrict,
  parseLicenseEnvelope,
  parseTrustedKey,
  parseUtcIso,
  toBase64Url,
  verifyLicenseFile,
} from "./format.ts"
export type { LicenseEnvelope, LicensePayload, LicenseVerification, TrustedLicenseKey } from "./format.ts"
export { COMMUNITY_POLICY, buildLicensePolicy, normalizeLicensePolicy } from "./policy.ts"
export type { LicenseBuildConfig, LicensePolicy } from "./policy.ts"
export { LICENSE_FILE_NAME, defaultLicenseConfigDir, licenseFilePath, readStoredLicense } from "./store.ts"
export { LicenseImportError, LicenseRequiredError, LicenseService } from "./service.ts"
export type { LicenseCheck, LicenseServiceOptions } from "./service.ts"
