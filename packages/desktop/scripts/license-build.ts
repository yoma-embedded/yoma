/**
 * 构建期把「这个构建信任哪些签名公钥」烧成常量 —— **唯一的生成处**。
 *
 * 产物里没有任何一处读环境变量或配置文件来决定"要不要检查授权、信任谁":
 * `packages/kernel/src/host/licensing/policy.ts` 探的是编译期标识符 `__YOMA_LICENSE_BUILD__`,
 * 而它只在这里被 `define` 替换成一个对象字面量。正式包因此关不掉检查,客户也没法给自己加一把可信公钥。
 *
 * 四个吃得到这份 define 的产物:
 *   out/main/index.js               electron-vite,main 入口(调试台守护的启动护栏在这一侧)
 *   out/main/kernel.js              electron-vite,内核 utilityProcess
 *   out/main/mailbox-host.mjs       esbuild(build-mailbox.ts),调试台守护
 *   out/main/mailbox-turn-entry.mjs esbuild(build-mailbox.ts),轮次子进程
 * 少一个就等于留了一条绕过去的路,所以 `verify-commercial-artifact.ts` 四个一起核。
 *
 * ## 产品只有一种,开发构建打不成包
 *
 * 给了可信公钥 → 注入,产物在执行入口强制检查授权。**没有"不检查"的注入形状**,也没有版本开关。
 * 没给 → 不注入,产物是**开发构建**(不检查授权):CI 的冒烟 / e2e 与本机调试跑的就是它。
 * 它不是一个产品:`package:*` 在 electron-builder 之前无条件跑 `verify-commercial-artifact.ts`,
 * 没注入公钥的 `out/` 在那里非零退出 —— 出安装包缺公钥时唯一的结局是失败,不是放行。
 *
 * 给了但不对(不是 Ed25519、编号不合规、重复、测试前缀、两个来源同时给)一律**构建失败**:
 * `normalizeLicensePolicy` 的兜底(强制 + 零可信公钥 = 一律拦)是给"注入被改坏"准备的最后一道,
 * 不该是正常流程的出口 —— 那样出的包谁都激活不了,而错误只会在客户机器上显形。
 *
 * ## 导入一律用相对路径
 *
 * 这个模块被 `electron.vite.config.ts` import,而 vite 的配置加载会把**裸说明符**外部化
 * (交给 node 在运行期解析)。kernel 只发 raw TypeScript,那条路上的加载器行为是这个仓库反复踩过的坑。
 * 相对路径会被 esbuild 一起打进配置产物,不留运行期解析 —— 所以这里的 import 不许改成
 * `@yoma-desktop/kernel/host/licensing`。(`packages/desktop/scripts/` 不在 boundary.test.ts 的
 * 扫描范围里,kernel-smoke.ts 早有同样的先例;`src/main` 那一侧必须走叶子门。)
 */

import { readFileSync } from "node:fs"

import { KEY_ID_PATTERN, parseTrustedKey } from "../../kernel/src/host/licensing/format.ts"
import type { TrustedLicenseKey } from "../../kernel/src/host/licensing/format.ts"
import type { LicenseBuildConfig } from "../../kernel/src/host/licensing/policy.ts"
import { TEST_KEY_ID_PATTERN, fingerprintOf } from "../../../scripts/license/lib.ts"

export type { LicenseBuildConfig }

/** 被 `define` 替换掉的标识符。`policy.ts` 用 `typeof` 探的就是它。 */
export const LICENSE_BUILD_DEFINE_NAME = "__YOMA_LICENSE_BUILD__"

/** 可信公钥文件(`npm run license -- keygen` 产出的 `<id>.trust.json`)。 */
export const TRUST_FILE_ENV = "YOMA_LICENSE_TRUST_FILE"
/** 同上的内联 JSON —— 给 CI 的 repository variable 用(公钥不是秘密)。 */
export const TRUST_JSON_ENV = "YOMA_LICENSE_TRUST_JSON"

/** 出错时指给人看的操作文档。 */
const DOC = "docs/licensing.md"
const KEYGEN_HINT = `npm run license -- keygen --key-id <编号> --out-dir <仓库外的目录>`

export interface ResolveLicenseBuildOptions {
  /**
   * 放行测试前缀的公钥编号(`test` / `e2e` / `dev` / `demo` / `tmp` / `sample` / `example`)。
   *
   * **只是函数参数,没有任何环境变量能打开它。** 唯一的使用者是 e2e 脚本:它要往临时目录打一份
   * 带一次性公钥的商业产物。正式打包管线走的是 `resolveLicenseBuild(process.env)`,拿不到这个开关。
   */
  allowTestKeys?: boolean
  /** 读文件的注入口(测试用)。缺省 `readFileSync`。 */
  readTextFile?: (file: string) => string
}

/**
 * 从环境变量解析出这个构建的授权策略。**任何一处不对就抛** —— 调用方(prebuild / vite 配置 /
 * build-mailbox)不接,于是构建以非零退出结束。
 *
 * 返回 `undefined` = 两个来源都没给 = 开发构建,不注入(空串与未设同解:CI 里没配 repository variable 时
 * `${{ vars.… }}` 展开出来正是空串)。
 */
export function resolveLicenseBuild(
  env: Record<string, string | undefined>,
  options: ResolveLicenseBuildOptions = {},
): LicenseBuildConfig | undefined {
  const file = trimmed(env[TRUST_FILE_ENV])
  const inline = trimmed(env[TRUST_JSON_ENV])

  if (file !== undefined && inline !== undefined) {
    throw new Error(
      `${TRUST_FILE_ENV} 与 ${TRUST_JSON_ENV} 同时给了 —— 两者是同一件事的两种写法(前者给本机构建,` +
        `后者给 CI 的 repository variable),同时给说明其中一份是忘记清掉的旧配置,而"用了哪一份"` +
        `会决定这个包信任谁。只留一个再来。见 ${DOC}`,
    )
  }

  if (file === undefined && inline === undefined) return undefined

  const source = file !== undefined ? `可信公钥文件 ${file}` : `环境变量 ${TRUST_JSON_ENV}`
  const raw = file !== undefined ? readTrustFile(file, options.readTextFile) : inline!
  const trustedKeys = parseTrustedKeys(raw, source, options.allowTestKeys === true)
  return { trustedKeys }
}

/** 出安装包却没有可信公钥时给人看的话(产物检查与文档共用这一份说法)。 */
export function missingTrustHelp(): string {
  return (
    `出安装包必须给可信公钥,否则打出来的包不检查授权。` +
    `\n  · 本机构建:${TRUST_FILE_ENV}=<那个 trust.json 的路径> npm run build -w packages/desktop` +
    `\n  · CI:把 trust.json 的内容放进 repository variable ${TRUST_JSON_ENV}(公钥不是秘密)` +
    `\n  · 还没有密钥:${KEYGEN_HINT}(私钥只落仓库外,备份好;丢了就没法给老客户续期)` +
    `\n见 ${DOC}`
  )
}

function trimmed(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value ? value : undefined
}

function readTrustFile(file: string, readTextFile?: (file: string) => string): string {
  try {
    return (readTextFile ?? ((target: string) => readFileSync(target, "utf8")))(file)
  } catch (error) {
    throw new Error(
      `${TRUST_FILE_ENV} 指的文件读不出来(${file}):${(error as Error).message}。` +
        `它应该是 \`${KEYGEN_HINT}\` 产出的 <编号>.trust.json。见 ${DOC}`,
    )
  }
}

/**
 * 解析并逐把校验可信公钥。
 *
 * 校验的每一条都对应一个"不做就会出事"的结局:编号不合规 → `normalizeLicensePolicy` 在运行期
 * 整份策略 fail-closed(包谁都激活不了);不是 Ed25519 → 同上;重复 → 说明配置是拼接出来的,
 * 哪一把生效说不清;测试前缀 → 测试私钥往往在仓库里或在临时目录里躺过,拿它签的授权等于免费许可。
 */
function parseTrustedKeys(raw: string, source: string, allowTestKeys: boolean): TrustedLicenseKey[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${source} 不是合法 JSON:${(error as Error).message}。期望的形状是 ` +
        `{"trustedKeys":[{"id":"<编号>","publicKey":"<Ed25519 SPKI DER 的 base64>"}]}。见 ${DOC}`,
    )
  }
  const entries = (parsed as { trustedKeys?: unknown } | null)?.trustedKeys
  if (!Array.isArray(entries)) {
    throw new Error(
      `${source} 里没有 trustedKeys 数组。期望的形状是 ` +
        `{"trustedKeys":[{"id":"<编号>","publicKey":"<Ed25519 SPKI DER 的 base64>"}]};` +
        `\`${KEYGEN_HINT}\` 产出的 <编号>.trust.json 就是这个形状(多余字段会被忽略)。见 ${DOC}`,
    )
  }
  if (entries.length === 0) {
    throw new Error(`${source} 里的 trustedKeys 是空数组 —— 至少要一把公钥,否则打出来的包谁都激活不了。见 ${DOC}`)
  }

  const keys: TrustedLicenseKey[] = []
  for (const [index, entry] of entries.entries()) {
    const at = `${source} 的第 ${index + 1} 把公钥`
    const candidate = entry as { id?: unknown; publicKey?: unknown } | null
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || typeof candidate.publicKey !== "string") {
      throw new Error(`${at} 缺 id 或 publicKey(都得是字符串)。见 ${DOC}`)
    }
    const id = candidate.id.trim()
    const publicKey = candidate.publicKey.trim()
    if (!KEY_ID_PATTERN.test(id)) {
      throw new Error(
        `${at} 的编号 ${JSON.stringify(candidate.id)} 不合法:小写字母或数字开头,3–64 位,只含 a-z 0-9 . _ -。` +
          `运行期的策略校验用的是同一条规则,不合法就会让整份策略 fail-closed。见 ${DOC}`,
      )
    }
    if (!allowTestKeys && TEST_KEY_ID_PATTERN.test(id)) {
      throw new Error(
        `${at} 的编号 ${JSON.stringify(id)} 是测试前缀(test / e2e / dev / demo / tmp / sample / example)——` +
          `测试私钥不进正式信任配置:它们躺过临时目录、进过日志、常常跟着测试代码走,` +
          `拿它签出来的授权就是一把免费许可。给正式密钥换一个编号(例如 yoma-official-<年月日>)。见 ${DOC}`,
      )
    }
    if (!parseTrustedKey({ id, publicKey })) {
      throw new Error(
        `${at}(${id})不是合法的 Ed25519 公钥 —— publicKey 要是 **SPKI DER 的 base64**` +
          `(Ed25519 的那一串固定以 MCowBQYDK2VwAyEA 开头,共 60 个字符),不是 PEM、不是原始 32 字节、` +
          `也不是 RSA。照 \`${KEYGEN_HINT}\` 产出的 trust.json 原样用。见 ${DOC}`,
      )
    }
    if (keys.some((existing) => existing.id === id)) {
      throw new Error(
        `${at} 的编号 ${JSON.stringify(id)} 重复了 —— 信任名单按编号选公钥(授权文件里的 signingKeyId),` +
          `重复意味着"哪一把生效"说不清。多半是把两份 trust.json 拼在一起时带进了同一把。见 ${DOC}`,
      )
    }
    // 只取这两个字段:trust.json 里的 fingerprint 之类是给人核对的,不进产物。
    // 顺序固定 id → publicKey:产物检查按 `{id:…,publicKey:…}` 这个相邻关系抠回来。
    keys.push({ id, publicKey })
  }
  return keys
}

/**
 * → esbuild / vite 的 `define` 映射。
 *
 * 开发构建(`undefined`)**什么都不注入**:`policy.ts` 靠"标识符不存在"认出开发态。注入的形状里只有
 * 公钥 —— 没有任何一种写法能注入出"不检查"。
 */
export function licenseDefine(config: LicenseBuildConfig | undefined): Record<string, string> {
  if (config === undefined) return {}
  const canonical = {
    trustedKeys: config.trustedKeys.map((key) => ({ id: key.id, publicKey: key.publicKey })),
  }
  return { [LICENSE_BUILD_DEFINE_NAME]: JSON.stringify(canonical) }
}

/** 构建日志里的一段话:每把公钥的编号与指纹(拿去和签发端的备份核对)。 */
export function describeLicenseBuild(config: LicenseBuildConfig | undefined): string {
  if (config === undefined) {
    return (
      `授权:开发构建 —— 没给 ${TRUST_FILE_ENV} / ${TRUST_JSON_ENV},不注入可信公钥、不检查授权。` +
      `这份 out/ 只能拿来调试与跑冒烟,**打不成安装包**`
    )
  }
  const lines = [`授权:执行入口强制检查授权,信任 ${config.trustedKeys.length} 把公钥`]
  for (const key of config.trustedKeys) lines.push(`  · ${key.id}  指纹 ${fingerprintOf(key.publicKey)}`)
  return lines.join("\n")
}
