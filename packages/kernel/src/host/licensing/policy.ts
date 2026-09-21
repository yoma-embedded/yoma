/**
 * 这个构建的授权策略:执行入口强不强制检查、信任哪些签名公钥。
 *
 * ## 它是编译期常量,不是运行时配置
 *
 * 打包脚本用 esbuild / vite 的 `define` 把 `__YOMA_LICENSE_BUILD__` 整个替换成一个对象字面量
 * (`packages/desktop/scripts/license-build.ts` 是唯一的生成处)。产物里没有任何一处读环境变量或
 * 配置文件来决定"要不要检查授权、信任谁" —— 正式包因此关不掉检查,客户也没法给自己加一把可信公钥。
 *
 * ## 产品只有一种:要授权的那一种
 *
 * 注入的形状里**没有"不检查"这个选项**:只要注入了,就是强制检查。不强制只剩一种情形 ——
 * 这个标识符根本不存在,也就是没经过带公钥的构建:tsx、vitest、`npm run dev:desktop`、以及没给可信公钥的
 * 本机 `build`(CI 的冒烟与 e2e 跑的就是它)。那是**开发态**,不是一个产品:`package:*` 在
 * electron-builder 之前无条件跑产物检查,没注入公钥的 `out/` 打不成安装包。
 *
 * ## 测试怎么注入
 *
 * 测试把 `LicensePolicy` 对象**当函数参数**传给 `createKernelHost({ licensePolicy })` 这一类代码级接缝。
 * 这些接缝不从 JSON 配置、命令行、环境变量取值(bench 的 TurnInput / 守护配置文件里**没有**这个字段),
 * 所以拿到一份正式安装包的人够不着它们。
 */

import { KEY_ID_PATTERN, parseTrustedKey, type TrustedLicenseKey } from "./format.ts"

export interface LicensePolicy {
  /** 执行入口是否强制检查授权。`false` 只属于开发态(见文件头),任何注入都给不出它。 */
  enforced: boolean
  trustedKeys: readonly TrustedLicenseKey[]
}

/** `define` 注进来的形状。 */
export interface LicenseBuildConfig {
  trustedKeys: TrustedLicenseKey[]
}

declare const __YOMA_LICENSE_BUILD__: LicenseBuildConfig | undefined

/** 开发态:没经过带公钥的构建。不强制,也没有可信公钥。 */
export const DEVELOPMENT_POLICY: LicensePolicy = Object.freeze({ enforced: false, trustedKeys: Object.freeze([]) })

/**
 * 读编译期注入的策略。
 *
 * 注入了但形状不对(公钥解析不了、编号不合规、重复)时**按强制检查且零可信公钥**处理 —— 也就是
 * 什么授权都验不过、一律拦下。配置坏了宁可拦住也不放行;正常的构建流程在构建期就会因此失败,
 * 走不到这里。
 */
export function buildLicensePolicy(): LicensePolicy {
  const baked = typeof __YOMA_LICENSE_BUILD__ === "undefined" ? undefined : __YOMA_LICENSE_BUILD__
  if (baked === undefined) return DEVELOPMENT_POLICY
  return normalizeLicensePolicy(baked)
}

/** 注入值 → 策略。**返回值恒为强制检查**:注入的内容决定的只是信任谁,决定不了查不查。 */
export function normalizeLicensePolicy(config: unknown): LicensePolicy {
  const failClosed: LicensePolicy = { enforced: true, trustedKeys: [] }
  if (!config || typeof config !== "object") return failClosed
  const { trustedKeys } = config as { trustedKeys?: unknown }
  if (!Array.isArray(trustedKeys)) return failClosed
  const keys: TrustedLicenseKey[] = []
  for (const entry of trustedKeys) {
    const key = entry as Partial<TrustedLicenseKey> | undefined
    if (!key || typeof key.id !== "string" || typeof key.publicKey !== "string") return failClosed
    if (!KEY_ID_PATTERN.test(key.id) || !parseTrustedKey({ id: key.id, publicKey: key.publicKey })) return failClosed
    if (keys.some((existing) => existing.id === key.id)) return failClosed
    keys.push({ id: key.id, publicKey: key.publicKey })
  }
  return { enforced: true, trustedKeys: keys }
}
