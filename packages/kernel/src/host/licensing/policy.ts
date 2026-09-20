/**
 * 这个构建的授权策略:是哪个版本(商业 / 社区)、信任哪些签名公钥。
 *
 * ## 它是编译期常量,不是运行时配置
 *
 * 打包脚本用 esbuild / vite 的 `define` 把 `__YOMA_LICENSE_BUILD__` 整个替换成一个对象字面量
 * (`packages/desktop/scripts/license-build.ts` 是唯一的生成处)。产物里没有任何一处读环境变量或
 * 配置文件来决定"要不要检查授权、信任谁" —— 正式包因此关不掉检查,客户也没法给自己加一把可信公钥。
 *
 * 没经过打包的运行(tsx、vitest、`npm run dev:desktop` 且没设商业构建变量)里这个标识符不存在,
 * 落到社区版:不强制授权。源码是 MIT 的,自己构建本来就不受限;官方商业安装包是另一回事。
 *
 * ## 测试怎么注入
 *
 * 测试把 `LicensePolicy` 对象**当函数参数**传给 `createKernelHost({ licensePolicy })` 这一类代码级接缝。
 * 这些接缝不从 JSON 配置、命令行、环境变量取值(bench 的 TurnInput / 守护配置文件里**没有**这个字段),
 * 所以拿到一份正式安装包的人够不着它们。
 */

import type { LicenseEdition } from "../../license-view.ts"
import { KEY_ID_PATTERN, parseTrustedKey, type TrustedLicenseKey } from "./format.ts"

export interface LicensePolicy {
  edition: LicenseEdition
  /** 商业版才有意义;社区版留空。 */
  trustedKeys: readonly TrustedLicenseKey[]
}

/** `define` 注进来的形状。 */
export interface LicenseBuildConfig {
  edition: LicenseEdition
  trustedKeys: TrustedLicenseKey[]
}

declare const __YOMA_LICENSE_BUILD__: LicenseBuildConfig | undefined

export const COMMUNITY_POLICY: LicensePolicy = Object.freeze({ edition: "community", trustedKeys: Object.freeze([]) })

/**
 * 读编译期注入的策略。
 *
 * 注入了但形状不对(edition 不认识、公钥解析不了)时**按商业版且零可信公钥**处理 —— 也就是
 * 什么授权都验不过、一律拦下。配置坏了宁可拦住也不放行;正常的商业构建流程在构建期就会因此失败,
 * 走不到这里。
 */
export function buildLicensePolicy(): LicensePolicy {
  const baked = typeof __YOMA_LICENSE_BUILD__ === "undefined" ? undefined : __YOMA_LICENSE_BUILD__
  if (baked === undefined) return COMMUNITY_POLICY
  return normalizeLicensePolicy(baked)
}

export function normalizeLicensePolicy(config: unknown): LicensePolicy {
  const failClosed: LicensePolicy = { edition: "commercial", trustedKeys: [] }
  if (!config || typeof config !== "object") return failClosed
  const { edition, trustedKeys } = config as { edition?: unknown; trustedKeys?: unknown }
  if (edition === "community") return COMMUNITY_POLICY
  if (edition !== "commercial" || !Array.isArray(trustedKeys)) return failClosed
  const keys: TrustedLicenseKey[] = []
  for (const entry of trustedKeys) {
    const key = entry as Partial<TrustedLicenseKey> | undefined
    if (!key || typeof key.id !== "string" || typeof key.publicKey !== "string") return failClosed
    if (!KEY_ID_PATTERN.test(key.id) || !parseTrustedKey({ id: key.id, publicKey: key.publicKey })) return failClosed
    if (keys.some((existing) => existing.id === key.id)) return failClosed
    keys.push({ id: key.id, publicKey: key.publicKey })
  }
  return { edition: "commercial", trustedKeys: keys }
}
