/**
 * 授权 e2e 三条腿共用的小工具:计划文件、时间线打印、现场签发。
 *
 * ## 为什么签发发生在**运行期**
 *
 * 这套 e2e 的判据是"真的短有效期",不注入时钟(单测那一层已经用注入时钟覆盖过了)。所以授权文件
 * 必须在跑的时候按 `Date.now()` 算出 `expiresAt` 再签 —— 甚至要能在守护已经跑起来之后,按"刚看到
 * 第 2 轮开跑"这个事件把到期时刻钉在那一轮的中间。仓库里因此没有任何预生成的授权文件,也不需要。
 *
 * ## 导入用的私钥
 *
 * 自带模式现场 `generateSigningKey`,只落到 `os.tmpdir()` 下的临时目录,跑完删掉;对现成商业构建
 * 那一模式由 `--key` 指一个仓库外的私钥。两种都不进仓库,也不进日志(只印公钥编号)。
 *
 * ## 导入一律用相对路径
 *
 * 与 `license-build.ts` 同一条理由的延伸:这个模块会被 esbuild 打进 Electron 入口
 * (`e2e-license-electron.ts`),相对路径一起被打进产物,不留运行期解析。
 * `packages/desktop/scripts/` 不在 boundary.test.ts 的扫描范围里,`license-build.ts` 早有先例。
 */

import { readFileSync } from "node:fs"

import { LICENSE_MAX_BYTES } from "../../kernel/src/license-view.ts"
import {
  generateSigningKey,
  issueLicense,
  loadPrivateKey,
  toUtcIso,
  trustedKeyOf,
  type IssuedLicense,
} from "../../../scripts/license/lib.ts"

/** 编排器写给两个被 spawn 的腿的"这次跑什么"。经环境变量 `YOMA_E2E_LICENSE_PLAN` 传路径。 */
export interface LicensePlan {
  /** 被测的 desktop 目录:里面要有 `out/main/kernel.js` 与 `out/preload/index.js`。 */
  desktopDir: string
  /** 签发私钥(PKCS#8 PEM,未加密)的文件路径。 */
  keyPemFile: string
  /** 那把私钥对应的公钥编号 —— 必须与被测产物里烧进去的那把一致。 */
  keyId: string
  /** 这一次跑的临时根:HOME / sessions / state 全在它下面。 */
  tmpRoot: string
  enginesDir?: string
  /** 只跑其中几条腿(调试用)。 */
  legs: number[]
}

export const PLAN_ENV = "YOMA_E2E_LICENSE_PLAN"

export function loadPlan(): LicensePlan {
  const file = process.env[PLAN_ENV]
  if (!file) throw new Error(`没有 ${PLAN_ENV} —— 这个入口只由 e2e-license.ts 启动`)
  return JSON.parse(readFileSync(file, "utf8")) as LicensePlan
}

// ---------------------------------------------------------------------------
// 时间线 + 断言
// ---------------------------------------------------------------------------

/**
 * 一条腿的记录器。**边跑边打印**:这套 e2e 里最长的等待有二十几秒,攒到最后再吐的话,
 * 挂住的时候看不出它停在哪一步 —— 而"停在哪一步"正是这份证据的全部价值。
 */
export class Leg {
  readonly title: string
  private readonly t0 = Date.now()
  private failures = 0
  private checks = 0

  constructor(title: string) {
    this.title = title
    console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`)
  }

  /** 相对这条腿开始的秒数。 */
  get elapsed(): string {
    return `+${((Date.now() - this.t0) / 1000).toFixed(1)}s`.padStart(8)
  }

  /** 时间线上的一件事(不是断言)。 */
  note(message: string): void {
    console.log(`${this.elapsed}  ·    ${message}`)
  }

  /** 一条断言。返回它自己的结果,方便 `if (!leg.check(...)) return`。 */
  check(name: string, ok: boolean, detail?: string): boolean {
    this.checks += 1
    if (!ok) this.failures += 1
    console.log(`${this.elapsed}  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`)
    return ok
  }

  /** 跑挂了(异常),按一条失败记。 */
  crashed(error: unknown): void {
    this.check("这条腿跑完没有异常", false, (error as Error)?.stack ?? String(error))
  }

  get failed(): number {
    return this.failures
  }

  summary(): string {
    const passed = this.checks - this.failures
    return `${this.title}:${passed}/${this.checks} 通过${this.failures ? `,${this.failures} 项失败` : ""}`
  }
}

// ---------------------------------------------------------------------------
// 轮询等待:条件 + 明确总期限。**绝不写死 sleep 去"等它应该好了"。**
// ---------------------------------------------------------------------------

export interface WaitOptions {
  /** 总期限(毫秒)。 */
  timeoutMs: number
  /** 轮询间隔(毫秒),缺省 200。 */
  everyMs?: number
}

/** 轮询到 `probe` 返回非 undefined 为止;超时返回 undefined(调用方负责把时间线打出来再报错)。 */
export async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  options: WaitOptions,
): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await sleep(options.everyMs ?? 200)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 关掉内核里唯一两处会主动出网的东西:模型目录与数据手册服务器。**三条腿都要设**。
 *
 * 不设的代价不是"多发一个请求":内置的手册地址是一个裸 IP,模型目录是公网 HTTPS,任何一处
 * 连不通都会把一次轮次拖到分钟级。实测踩过 —— 腿 3 有一次 `sleep 8` 的那一轮整整跑了 249 秒
 * (腿 1、2 从一开始就设了这两个,没见过这种事)。授权本身不联网,这条由单测
 * (`licensing.test.ts`「验签、导入、检查全程不碰网络」,spy 住 fetch)钉着;这里只管别让**别的**
 * 网络请求把时间线搅浑。
 */
export const OFFLINE_ENV: Record<string, string> = {
  YOMA_MODEL_CATALOG_URL: "off",
  YOMA_DATASHEET_SERVER: "off",
}

// ---------------------------------------------------------------------------
// 现场签发
// ---------------------------------------------------------------------------

export interface Issued extends IssuedLicense {
  /** 到期的墙钟毫秒 —— 腿 1 靠它算"还要等几秒"。 */
  expiresAtMs: number
}

export interface IssueOptions {
  licenseId?: string
  customerLabel?: string
  /** 相对现在的秒数,缺省 -60(一分钟前就生效了)。 */
  notBeforeSec?: number
  /** 相对现在的秒数 —— **真的这么多秒后到期**,不注入时钟。 */
  expiresInSec: number
  /**
   * 签发时刻(相对现在的秒数),缺省就是现在。造"签发时就已过期"那份坏文件时必须一起往前挪:
   * 日期校验要求 issuedAt 早于 expiresAt,否则连签发自检都过不了(这条是实测撞出来的)。
   */
  issuedAtSec?: number
}

export interface Issuer {
  keyId: string
  /**
   * 这把私钥对应的公钥(SPKI DER 的 base64)。腿 3 要拿它拼一份"与被测产物同一把公钥"的
   * 商业策略去导入 —— 不这么做就会出现"导进去了、内核却不认"这种自己骗自己的绿。
   */
  publicKeySpkiB64: string
  issue(options: IssueOptions): Issued
}

export function makeIssuer(keyPemFile: string, keyId: string): Issuer {
  return issuerFromPem(readFileSync(keyPemFile, "utf8"), keyId)
}

function issuerFromPem(pem: string, keyId: string, selfCheck = true): Issuer {
  const privateKey = loadPrivateKey(pem)
  return {
    keyId,
    publicKeySpkiB64: trustedKeyOf(keyId, privateKey).publicKey,
    issue(options) {
      const now = Date.now()
      const notBeforeMs = now + (options.notBeforeSec ?? -60) * 1000
      const expiresAtMs = now + options.expiresInSec * 1000
      const issued = issueLicense({
        privateKey,
        keyId,
        licenseId: options.licenseId ?? "e2e-live",
        customerLabel: options.customerLabel ?? "授权 e2e(临时密钥)",
        notBefore: toUtcIso(notBeforeMs),
        expiresAt: toUtcIso(expiresAtMs),
        ...(options.issuedAtSec === undefined ? {} : { issuedAt: toUtcIso(now + options.issuedAtSec * 1000) }),
        // 传了 overrides(哪怕是空对象)就跳过 issueLicense 的签发自检。造"冒用编号"
        // 那种坏文件时必须跳过:自检拿的是这把私钥自己的公钥,而我们要的正是一份验不过的。
        ...(selfCheck ? {} : { overrides: {} }),
      })
      return { ...issued, expiresAtMs }
    },
  }
}

// ---------------------------------------------------------------------------
// 一批"必须被拒"的授权文件。**全是真的坏文件**,不是手编的字符串冒充。
// ---------------------------------------------------------------------------

export interface BadLicense {
  what: string
  text: string
  /** 期望的 LicenseErrorCode。 */
  code: string
}

export function badLicenses(good: Issued, trustedKeyId: string): BadLicense[] {
  const envelope = JSON.parse(good.text) as { format: string; version: number; payload: string; signature: string }
  const stranger = strangerIssuer(`e2e-stranger-${randomSuffix()}`)
  const impersonator = strangerIssuer(trustedKeyId)

  return [
    {
      // **改一个字节,而且是最要紧的那个**:把到期年份 2026 改成 2036。JSON 依旧合法、字段依旧齐全,
      // 唯一能挡住它的就是验签。(第一版改的是 payload 末位的 base64url 字符 —— 那一位编码的是
      // 补齐位,改掉之后解出来的 JSON 直接坏掉,拿到的是 bad-payload,验签那道门根本没被走到。)
      what: "篡改一个字节(把到期年份往后挪十年)",
      text: JSON.stringify({ ...envelope, payload: extendExpiryByteHack(envelope.payload) }, null, 2),
      code: "bad-signature",
    },
    {
      what: "别的密钥签的,用它自己的编号(不在信任名单里)",
      text: stranger.issue({ licenseId: "e2e-stranger", expiresInSec: 3600 }).text,
      code: "unknown-key",
    },
    {
      what: "别的密钥签的,却冒用受信编号",
      text: impersonator.issue({ licenseId: "e2e-impersonated", expiresInSec: 3600 }).text,
      code: "bad-signature",
    },
    { what: "空对象 {}", text: "{}", code: "bad-envelope" },
    {
      what: `超过 ${LICENSE_MAX_BYTES} 字节上限`,
      text: JSON.stringify({ ...envelope, junk: "x".repeat(LICENSE_MAX_BYTES + 512) }),
      code: "too-large",
    },
  ]
}

/**
 * 在 payload 的**原始字节**里把 `"expiresAt":"20X6…` 的十位数字 +1(2026 → 2036),再重新编回 base64url。
 * 改动恰好一个字节,签名那 64 字节一个 bit 都没动 —— 这正是"客户自己改到期日"的那个攻击。
 */
function extendExpiryByteHack(payloadB64Url: string): string {
  const bytes = Buffer.from(payloadB64Url.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  const marker = Buffer.from('"expiresAt":"', "utf8")
  const at = bytes.indexOf(marker)
  if (at < 0) throw new Error("payload 里没有 expiresAt —— 授权格式变了,这条坏文件用例要跟着改")
  // "expiresAt":"2026-…" 的第 3 位数字(十位)。
  const digit = at + marker.length + 2
  bytes[digit] = bytes[digit]! + 1
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * 一把**不在信任名单里**的现场私钥。`claimKeyId` 是它在授权文件里自称的编号:
 * 写自己的 → `unknown-key`;写受信的那个 → 编号找得到公钥但验签失败,`bad-signature`。
 */
export function strangerIssuer(claimKeyId: string): Issuer {
  // generateSigningKey 的编号规则比授权文件里的 signingKeyId 严格不了 —— 两处用的是同一个
  // KEY_ID_PATTERN,所以受信编号(yoma-…)也能直接拿来生成。
  const generated = generateSigningKey(claimKeyId)
  return issuerFromPem(generated.privateKeyPem, claimKeyId, false)
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
