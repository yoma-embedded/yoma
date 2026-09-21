/**
 * 产物的出厂检查:**打包之前**对着 out/(或已经打好的 .app / app.asar)逐条核,
 * 任何一条不过就非零退出,electron-builder 不会被执行。
 *
 * **每一次 `package:*` 都无条件跑它**:产品只有要授权的那一种,没有"这次出的是不检查授权的包,跳过"
 * 这条路。没注入可信公钥的 `out/`(开发构建)在第 1 条就红,于是打不成安装包。
 *
 * 它挡的不是"代码写错了",而是**发货事故**:
 *
 *   1. 四个 node 产物里有一个没吃到编译期注入 → 那一条就是绕过授权的路(守护、轮次子进程、
 *      内核、main 各自都能启动付费执行);
 *   2. 注入的公钥不是期望的那一把 → 发出去的包认的是别人的签名,或者客户拿到的授权谁都验不过;
 *   3. 测试前缀的公钥进了正式包 → 那是一把免费许可(测试私钥躺过临时目录、进过日志);
 *   4. 私钥 / 签发工具混进了安装包 → 任何一个客户都能自己签授权;
 *   5. 产物里有"读环境变量决定要不要检查授权"的痕迹 → 正式包能被一行 env 关掉。
 *
 * 前四条都发生过在别的产品上,而且共同点是:**发出去之前一个自动闸门都没有,发出去之后
 * 没有任何办法收回**(离线授权没有吊销)。所以这一步不是"最好有",是打包管线的一部分。
 *
 * 用法:
 *   npm run verify:commercial -w packages/desktop                       # 查 packages/desktop/out
 *   npm run verify:commercial -w packages/desktop -- --trust-file k.json # 再核公钥逐把一致
 *   npm run verify:commercial -w packages/desktop -- --app <目录|.app|app.asar>
 *
 * 不给 --trust-file 时,期望公钥从与构建同一套环境变量解析(YOMA_LICENSE_TRUST_FILE /
 * _JSON);两者都没有就只要求四个产物**互相一致**,并把指纹印出来让人核对。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { KEY_ID_PATTERN } from "../../kernel/src/host/licensing/format.ts"
import type { TrustedLicenseKey } from "../../kernel/src/host/licensing/format.ts"
import { ISSUER_MARKER, TEST_KEY_ID_PATTERN, fingerprintOf } from "../../../scripts/license/lib.ts"
import { TRUST_FILE_ENV, TRUST_JSON_ENV, missingTrustHelp, resolveLicenseBuild } from "./license-build.ts"

// ---------------------------------------------------------------------------
// 纯函数层:输入是"一堆已经读进内存的文件",不碰 fs
// ---------------------------------------------------------------------------

/** 一个被扫的文件。`path` 是展示用的相对路径,`text` 是全文(二进制文件不该进来)。 */
export interface ScannedFile {
  path: string
  text: string
}

/** 必须吃到编译期注入的四个 node 产物(相对 out/ 的路径,/ 分隔)。 */
export const REQUIRED_MAIN_ARTIFACTS = [
  "main/kernel.js",
  "main/index.js",
  "main/mailbox-host.mjs",
  "main/mailbox-turn-entry.mjs",
] as const

/**
 * Ed25519 的 SPKI DER 恒为 44 字节,base64 出来恒以这 16 个字符开头、总长 60。
 * 这是"把产物里的公钥一把不漏地抠出来"的锚:它不随打包器改写对象字面量的写法而变,
 * 也因此能发现**注入之外**多出来的那一把。
 */
const ED25519_SPKI_B64 = /MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42,44}={0,2}/g

/** `{id:"…",publicKey:"…"}` —— 引号风格由打包器决定,属性名可能带引号也可能不带。 */
const TRUSTED_KEY_PAIR =
  /["']?id["']?\s*:\s*["']([^"']+)["']\s*,\s*["']?publicKey["']?\s*:\s*["'](MCowBQYDK2VwAyEA[A-Za-z0-9+/=]+)["']/g

/** 信任名单的数组字面量:`trustedKeys:[` —— 注入的锚。`trustedKeys: keys` 这类非字面量不匹配。 */
const TRUSTED_KEYS_ARRAY = /["']?trustedKeys["']?\s*:\s*\[/g

/**
 * PEM 私钥块 —— 必须匹配**真的密钥体**。
 *
 * 只匹配标题的话,任何一个在字符串里出现过 "-----BEGIN PRIVATE KEY-----" 的加密库
 * 都会把检查打红,而红一次就会有人把这条检查关掉。所以要求标题后面真的跟着 base64 正文,
 * 正文里允许夹换行(PEM 本来就是折行的)。
 */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[ \t\r\n]*(?:[A-Za-z0-9+/=][ \t\r\n]*){60,}/

/**
 * 真的泄漏出去的私钥多半是**被塞进 JS / JSON 字符串**的,换行写成两个字符的 `\n`。
 * 先把转义换行还原成真换行再匹配,否则最可能的那种泄漏形态恰好躲过这条检查(写这条用例时实测)。
 */
function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r/g, "\n")
}

/** 签发库的特征函数名:产物里出现任何一个都意味着"客户能自己签授权"。 */
const ISSUER_SYMBOLS = ["generateSigningKey", "issueLicense", "renewalPeriod"] as const

/**
 * 不许出现在产物里的字符串。
 *
 * 前两个是"读环境变量决定信任谁":正式包一旦能被一行 env 改变行为,授权就等于没有。
 * `allowTestKeys` 是构建脚本的函数参数,产物里出现它意味着那个放行开关被带进了运行期。
 */
const FORBIDDEN_RUNTIME_SWITCHES = ["YOMA_LICENSE_TRUST", "YOMA_LICENSE_KEY_PASSPHRASE", "allowTestKeys"] as const

/** 执行入口的源码里不许出现的注入口(它们是测试的代码级接缝,生产装配面一个都不传)。 */
// 与 packages/kernel/src/host/license-entrypoints.test.ts 的那张表同一份:bench 侧的注入口叫
// `license`(一个 LicenseService),只认前两个名字的话 host-entry 里 new 一个出来传下去不会被抓到 ——
// 而发布流水线不跑 npm test,这道产物检查就是那条路上唯一的闸门。
const FORBIDDEN_ENTRY_SEAMS = ["licensePolicy", "licenseNow", "LicenseService", "trustedKeys"] as const

export interface InjectedPolicy {
  trustedKeys: TrustedLicenseKey[]
}

/** 相对 import / require 的说明符(静态与动态都算)。 */
const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g

/**
 * 入口 → 它自己 + 静态 import 到的所有文件,合并成一段文本。
 *
 * **必须这么做**:electron-vite 把 main 拆成共享 chunk,注入的策略实际落在
 * `out/main/chunks/<共享块>.js` 里,index.js 与 kernel.js 各自 import 它(实测)。
 * 只看入口文件本身的话,四条检查全都会因为"找不到注入"而红 —— 而产物其实是对的,
 * 于是这道闸门会被当成误报关掉。
 */
export function resolveEntryGraph(entry: string, files: ScannedFile[]): { text: string; parts: string[] } | undefined {
  const byPath = new Map(files.map((file) => [normalize(file.path), file.text]))
  const lookup = (wanted: string): string | undefined => {
    if (byPath.has(wanted)) return wanted
    for (const key of byPath.keys()) if (key === wanted || key.endsWith(`/${wanted}`)) return key
    return undefined
  }
  const start = lookup(entry)
  if (start === undefined) return undefined

  const parts: string[] = []
  const queue = [start]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    parts.push(current)
    const text = byPath.get(current)!
    const dir = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : ""
    for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
      const resolved = joinPosix(dir, match[1]!)
      const hit = lookup(resolved)
      if (hit !== undefined && !seen.has(hit)) queue.push(hit)
    }
  }
  return { text: parts.map((part) => byPath.get(part)!).join("\n"), parts }
}

/** 只处理 `a/b` + `./c` / `../c` 这一种:产物里的相对说明符就这两形。 */
function joinPosix(dir: string, specifier: string): string {
  const segments = dir ? dir.split("/") : []
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return segments.join("/")
}

/** 产物里出现过的所有 Ed25519 公钥(去重,保持出现顺序)。 */
export function findEd25519PublicKeys(source: string): string[] {
  const seen = new Set<string>()
  for (const match of source.matchAll(ED25519_SPKI_B64)) seen.add(match[0])
  return [...seen]
}

/**
 * 从产物文本里抠出注入的策略。
 *
 * 不做 JSON.parse:打包器会把 `{"trustedKeys":[…]}` 改写成 `{trustedKeys:[…]}`
 * (引号风格、空白都可能变),而 `typeof X === "undefined" ? … : X` 这一句会让同一份字面量
 * 出现一到两次。所以按属性名 + Ed25519 前缀锚定,字面量怎么写都认得出。
 *
 * 每一个 `trustedKeys:[…]` 数组字面量算一份候选(空数组也算 —— `policy.ts` 自己的源码里就有两个,
 * 调用方按"带公钥"筛)。
 */
export function extractInjectedPolicies(source: string): InjectedPolicy[] {
  const policies: InjectedPolicy[] = []
  for (const match of source.matchAll(TRUSTED_KEYS_ARRAY)) {
    const region = balancedArray(source, match.index + match[0].length - 1)
    if (region === undefined) continue
    const trustedKeys: TrustedLicenseKey[] = []
    for (const pair of region.matchAll(TRUSTED_KEY_PAIR)) trustedKeys.push({ id: pair[1]!, publicKey: pair[2]! })
    policies.push({ trustedKeys })
  }
  return policies
}

/** `start` 指着 `[`:按括号配平取到与它配对的 `]`(跳过字符串字面量)。 */
function balancedArray(source: string, start: number): string | undefined {
  if (source[start] !== "[") return undefined
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < source.length && index - start < 200_000; index += 1) {
    const char = source[index]!
    if (quote !== undefined) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "[") depth += 1
    else if (char === "]") {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

export interface VerifyOptions {
  /** 期望的可信公钥。不给就只要求四个产物互相一致。 */
  expectedKeys?: TrustedLicenseKey[]
  /** 期望公钥是从哪来的(报告里写清楚,免得"过了"其实没核过东西)。 */
  expectedKeysSource?: string
}

export interface CheckResult {
  name: string
  ok: boolean
  /** 逐条证据(过与不过都印:"过了"也要能被人复核)。 */
  evidence: string[]
}

export interface VerifyReport {
  ok: boolean
  checks: CheckResult[]
}

/**
 * 核心检查。`files` 要包含产物里所有**文本**文件;四个 node 产物按
 * `REQUIRED_MAIN_ARTIFACTS` 的相对路径查找(允许带前缀,例如 `out/main/kernel.js`)。
 */
export function verifyCommercialArtifact(files: ScannedFile[], options: VerifyOptions = {}): VerifyReport {
  const checks: CheckResult[] = []

  // ── a. 四个产物都吃到了注入,公钥集合一致 ─────────────────────────────────
  // 每个入口连着它 import 的 chunk 一起看(打包器会把共享代码拆出去)。
  const found = new Map<string, { text: string; parts: string[] }>()
  const missing: string[] = []
  for (const wanted of REQUIRED_MAIN_ARTIFACTS) {
    const graph = resolveEntryGraph(wanted, files)
    if (graph) found.set(wanted, graph)
    else missing.push(wanted)
  }

  const policyEvidence: string[] = []
  let policyOk = missing.length === 0
  for (const name of missing) policyEvidence.push(`✗ 找不到产物 ${name} —— 少一个入口吃到注入就等于留了一条绕过授权的路`)

  /** 每个产物抠出来的"这个产物信任谁"(按指纹比较,顺序无关)。 */
  const perArtifact = new Map<string, TrustedLicenseKey[]>()
  /** 根本没有注入的产物。"你忘了给公钥"那段补救话术只在**四个全是这种**时才说 —— 见下面 push 的地方。 */
  const noInjection: string[] = []
  for (const [name, graph] of found) {
    const where = graph.parts.length > 1 ? `(连同 ${graph.parts.length - 1} 个 chunk)` : ""
    // **按"带公钥"筛**,不能拿全部候选去比:`policy.ts` 自己的源码里就有两个同形的字面量
    // (`DEVELOPMENT_POLICY` 与 fail-closed 的 `{enforced:true,trustedKeys:[]}`),
    // 它们跟着代码进每一个产物。第一版没筛,于是真正带注入的产物会因为"两份不一样的信任名单"
    // 被误判不合格(实测,就是这一条救回来的)。
    // 带公钥的字面量只可能来自注入:源码里没有、也不该有任何硬编码的 Ed25519 公钥。
    const withKeys = extractInjectedPolicies(graph.text).filter((policy) => policy.trustedKeys.length > 0)
    if (withKeys.length === 0) {
      policyOk = false
      noInjection.push(name)
      policyEvidence.push(
        `✗ ${name}${where}:找不到"至少一把可信公钥"的注入 —— 这是开发构建的产物(构建时没给可信公钥,` +
          `不检查授权),或者 __YOMA_LICENSE_BUILD__ 没被 define 替换。这种产物不许打成安装包`,
      )
      continue
    }
    // 同一份字面量会出现两次(`typeof X === "undefined" ? … : X` 的两侧),两次必须说同一件事。
    const variants = new Set(withKeys.map((policy) => keyDigest(policy.trustedKeys)))
    if (variants.size !== 1) {
      policyOk = false
      policyEvidence.push(`✗ ${name}${where}:产物里有 ${variants.size} 份不一样的信任名单 —— 注入被改过?`)
      continue
    }
    const keys = withKeys[0]!.trustedKeys
    // 注入之外多出来的公钥:按 Ed25519 SPKI 前缀全文扫,和名单里的对数量。
    const all = findEd25519PublicKeys(graph.text)
    const extra = all.filter((key) => !keys.some((trusted) => trusted.publicKey === key))
    if (extra.length > 0) {
      policyOk = false
      policyEvidence.push(`✗ ${name}:信任名单之外还有 ${extra.length} 把 Ed25519 公钥(${extra[0]!.slice(0, 24)}…)`)
      continue
    }
    perArtifact.set(name, keys)
    policyEvidence.push(`✓ ${name}${where}:强制检查授权,信任 ${keys.length} 把公钥`)
  }

  // 四个产物互相一致(没给 --trust-file 时这是唯一的横向约束)。
  const digests = new Set([...perArtifact.values()].map(keyDigest))
  if (perArtifact.size === REQUIRED_MAIN_ARTIFACTS.length && digests.size !== 1) {
    policyOk = false
    policyEvidence.push("✗ 四个产物信任的公钥不是同一套 —— 构建期间信任配置变过(两次构建混在一个 out/ 里?)")
  }
  const sample = [...perArtifact.values()][0] ?? []
  for (const key of sample) policyEvidence.push(`  · ${key.id}  指纹 ${fingerprintOf(key.publicKey)}`)

  if (options.expectedKeys) {
    const expected = keyDigest(options.expectedKeys)
    for (const [name, keys] of perArtifact) {
      if (keyDigest(keys) === expected) continue
      policyOk = false
      policyEvidence.push(
        `✗ ${name} 信任的公钥与期望不符(期望来自 ${options.expectedKeysSource ?? "--trust-file"}):` +
          `\n      期望 ${describeKeys(options.expectedKeys)}` +
          `\n      实得 ${describeKeys(keys)}`,
      )
    }
    if (policyOk) policyEvidence.push(`✓ 四个产物的公钥与 ${options.expectedKeysSource ?? "--trust-file"} 逐把一致`)
  } else if (perArtifact.size > 0) {
    policyEvidence.push("! 没给 --trust-file:只核了四个产物互相一致,请人工核对上面的指纹")
  }
  // 只在"四个产物都没有注入"(= 开发构建)时才教人怎么给公钥。按"没抠出公钥"判会误伤:注入被改过、
  // 名单之外多出一把后门公钥,同样抠不出一份合格的名单 —— 那时维护者明明给了公钥,再叫他去设环境变量,
  // 等于在一次真告警上指错路(审查时实测出来的)。
  if (noInjection.length === REQUIRED_MAIN_ARTIFACTS.length) policyEvidence.push(missingTrustHelp())
  checks.push({ name: "编译期注入的授权策略(四个产物 · 公钥)", ok: policyOk, evidence: policyEvidence })

  // ── b. 公钥编号不是测试前缀 ────────────────────────────────────────────────
  const idEvidence: string[] = []
  let idsOk = true
  for (const [name, keys] of perArtifact) {
    for (const key of keys) {
      if (!KEY_ID_PATTERN.test(key.id)) {
        idsOk = false
        idEvidence.push(`✗ ${name}:公钥编号 ${JSON.stringify(key.id)} 不合规 —— 运行期策略会整份 fail-closed`)
      }
      if (TEST_KEY_ID_PATTERN.test(key.id)) {
        idsOk = false
        idEvidence.push(`✗ ${name}:公钥编号 ${JSON.stringify(key.id)} 是测试前缀 —— 测试私钥签的授权就是免费许可`)
      }
    }
  }
  if (idsOk) idEvidence.push(`✓ ${sample.length} 把公钥的编号都不是测试前缀(test / e2e / dev / demo / tmp / sample / example)`)
  checks.push({ name: "可信公钥编号不是测试密钥", ok: idsOk, evidence: idEvidence })

  // ── c. 没有 PEM 私钥 ──────────────────────────────────────────────────────
  const pemHits = files.filter((file) => PEM_PRIVATE_KEY.test(unescapeNewlines(file.text))).map((file) => file.path)
  checks.push({
    name: "产物里没有 PEM 私钥",
    ok: pemHits.length === 0,
    evidence:
      pemHits.length === 0
        ? [`✓ 扫了 ${files.length} 个文本文件,没有带正文的 PEM 私钥块`]
        : pemHits.map((hit) => `✗ ${hit} 里有 PEM 私钥块 —— 拿到安装包的人可以自己签授权`),
  })

  // ── d. 没有签发工具 ───────────────────────────────────────────────────────
  const issuerEvidence: string[] = []
  for (const file of files) {
    if (file.text.includes(ISSUER_MARKER)) issuerEvidence.push(`✗ ${file.path} 里有签发工具标记 ${ISSUER_MARKER}`)
    for (const symbol of ISSUER_SYMBOLS) {
      if (file.text.includes(symbol)) issuerEvidence.push(`✗ ${file.path} 里有签发库的 ${symbol} —— 签发能力不该进安装包`)
    }
  }
  const issuerOk = issuerEvidence.length === 0
  if (issuerOk) issuerEvidence.push(`✓ 没有 ${ISSUER_MARKER},也没有 ${ISSUER_SYMBOLS.join(" / ")}`)
  checks.push({ name: "产物里没有签发工具", ok: issuerOk, evidence: issuerEvidence })

  // ── e. 没有运行时开关 ─────────────────────────────────────────────────────
  const switchEvidence: string[] = []
  for (const [name, graph] of found) {
    for (const forbidden of FORBIDDEN_RUNTIME_SWITCHES) {
      if (graph.text.includes(forbidden)) {
        switchEvidence.push(`✗ ${name} 里出现了 ${forbidden} —— 正式包不该有任何"读环境变量决定要不要检查授权"的路`)
      }
    }
  }
  const switchOk = switchEvidence.length === 0
  if (switchOk) switchEvidence.push(`✓ 四个产物里都没有 ${FORBIDDEN_RUNTIME_SWITCHES.join(" / ")}`)
  checks.push({ name: "产物里没有关掉授权检查的开关", ok: switchOk, evidence: switchEvidence })

  return { ok: checks.every((check) => check.ok), checks }
}

/**
 * 源码级的第二道:执行入口的装配面**一个测试接缝都不许传**。
 *
 * `licensePolicy` / `licenseNow` 是 `LicenseService` 给测试留的代码级参数(policy.ts 顶部说明了
 * 为什么它们不能是配置)。产物里出现这两个名字是正常的(它们是函数参数名),所以这一条只能
 * 在源码上钉:`createKernelHost({…})` 的调用点一旦传了它们,拿到安装包的人就有可能够得着。
 */
export function verifyEntrySources(sources: ScannedFile[]): CheckResult {
  const evidence: string[] = []
  for (const source of sources) {
    for (const seam of FORBIDDEN_ENTRY_SEAMS) {
      if (source.text.includes(seam)) evidence.push(`✗ ${source.path} 里出现了 ${seam} —— 执行入口不许传授权的测试接缝`)
    }
  }
  const ok = evidence.length === 0
  if (ok) evidence.push(`✓ ${sources.length} 个执行入口的源码都没传 ${FORBIDDEN_ENTRY_SEAMS.join(" / ")}`)
  return { name: "执行入口没有授权的测试接缝(源码级)", ok, evidence }
}

function normalize(file: string): string {
  return file.split(path.sep).join("/")
}

function keyDigest(keys: TrustedLicenseKey[]): string {
  return [...keys]
    .map((key) => `${key.id}:${fingerprintOf(key.publicKey)}`)
    .sort()
    .join("|")
}

function describeKeys(keys: TrustedLicenseKey[]): string {
  if (keys.length === 0) return "(无)"
  return keys.map((key) => `${key.id}(${fingerprintOf(key.publicKey).slice(0, 16)}…)`).join(", ")
}

// ---------------------------------------------------------------------------
// 收集文件:目录 / .app / app.asar
// ---------------------------------------------------------------------------

/** 只读这些后缀(其余是图标、字体、原生二进制 —— 读成文本毫无意义还很慢)。 */
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".map", ".html", ".css", ".txt", ".yml", ".yaml", ".ts"])
/** 单个文件的读取上限:产物里最大的是 kernel.js(几 MB),超过这个的一定不是我们的代码。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024

export function collectTextFiles(root: string, prefix = ""): ScannedFile[] {
  const files: ScannedFile[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    const shown = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(full, shown))
      continue
    }
    if (!entry.isFile()) continue
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    if (statSync(full).size > MAX_FILE_BYTES) continue
    files.push({ path: shown, text: readFileSync(full, "utf8") })
  }
  return files
}

/** 解出 app.asar 里的文本文件。`@electron/asar` 缺席时优雅报出来(而不是把检查装成通过)。 */
async function collectFromAsar(asar: string): Promise<{ files?: ScannedFile[]; message?: string }> {
  let listPackage: (archive: string) => string[]
  let extractFile: (archive: string, file: string) => Buffer
  try {
    type AsarApi = {
      listPackage: (archive: string, options?: unknown) => string[]
      extractFile: (archive: string, file: string) => Buffer
    }
    const imported = (await import("@electron/asar")) as unknown as AsarApi & { default?: AsarApi }
    // CJS 包:命名导出可能没被探到,那时东西全在 default 上。
    const asarModule = typeof imported.listPackage === "function" ? imported : imported.default
    if (!asarModule) throw new Error("@electron/asar 没有 listPackage")
    listPackage = (archive) => asarModule.listPackage(archive, { isPack: false })
    extractFile = asarModule.extractFile
  } catch (error) {
    return { message: `装不出 @electron/asar(${(error as Error).message})—— 无法检查 asar,请改用 --app <解包目录> 或 out/` }
  }
  const files: ScannedFile[] = []
  for (const entry of listPackage(asar)) {
    // listPackage 给的是以 / 开头的绝对形式路径,目录也在其中。
    const relative = entry.replace(/^[/\\]+/, "")
    if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue
    try {
      files.push({ path: relative, text: extractFile(asar, relative).toString("utf8") })
    } catch {
      // 目录项或读不出来的条目:跳过,不让它冒充"检查过了"。
    }
  }
  return { files }
}

/** `--app` 指的东西 → 一组文本文件。目录 / .app / app.asar 三种都认。 */
async function collectTarget(target: string): Promise<{ files?: ScannedFile[]; message?: string; label: string }> {
  if (!existsSync(target)) return { message: `找不到 ${target}`, label: target }
  if (statSync(target).isFile()) {
    if (path.extname(target) !== ".asar") return { message: `${target} 不是目录也不是 .asar`, label: target }
    return { ...(await collectFromAsar(target)), label: target }
  }
  // .app:真正的代码在 Contents/Resources/app.asar(或 app/ 解包目录)里。
  const macAsar = path.join(target, "Contents", "Resources", "app.asar")
  if (existsSync(macAsar)) return { ...(await collectFromAsar(macAsar)), label: macAsar }
  const macUnpacked = path.join(target, "Contents", "Resources", "app")
  if (existsSync(macUnpacked)) return { files: collectTextFiles(macUnpacked), label: macUnpacked }
  const asar = path.join(target, "resources", "app.asar")
  if (existsSync(asar)) return { ...(await collectFromAsar(asar)), label: asar }
  const unpacked = path.join(target, "resources", "app")
  if (existsSync(unpacked)) return { files: collectTextFiles(unpacked), label: unpacked }
  return { files: collectTextFiles(target), label: target }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 执行入口的源码 —— 三处装配面,相对仓库根。 */
const ENTRY_SOURCES = [
  "packages/desktop/src/main/kernel-entry.ts",
  "packages/bench/src/turn-entry.ts",
  "packages/bench/src/mailbox/host-entry.ts",
]

async function main(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const desktopDir = path.resolve(import.meta.dirname, "..")
  const repoRoot = path.resolve(desktopDir, "..", "..")

  const target = flag("app") ?? path.join(desktopDir, "out")
  const collected = await collectTarget(target)

  if (!collected.files) {
    console.error(`✗ ${collected.message}`)
    return 1
  }
  console.log(`产物检查:${collected.label}(${collected.files.length} 个文本文件)`)

  // 期望公钥:--trust-file 优先,其次与构建同一套环境变量。
  let expectedKeys: TrustedLicenseKey[] | undefined
  let expectedKeysSource: string | undefined
  const trustFile = flag("trust-file")
  try {
    if (trustFile) {
      expectedKeys = resolveLicenseBuild(
        { [TRUST_FILE_ENV]: trustFile },
        // 检查端不该比构建端更宽松,也不该更严格:这里只是"把期望读出来"。
        // e2e 用测试公钥打的产物由 --trust-file 指同一份文件,所以要放行测试前缀 ——
        // 编号是不是测试前缀由上面的 b 条独立判,不靠这里。
        { allowTestKeys: true },
      )?.trustedKeys
      expectedKeysSource = `--trust-file ${trustFile}`
    } else if ((process.env[TRUST_FILE_ENV] ?? process.env[TRUST_JSON_ENV] ?? "").trim()) {
      expectedKeys = resolveLicenseBuild(process.env, { allowTestKeys: true })?.trustedKeys
      expectedKeysSource = process.env[TRUST_FILE_ENV]?.trim() ? `环境变量 ${TRUST_FILE_ENV}` : `环境变量 ${TRUST_JSON_ENV}`
    }
  } catch (error) {
    console.error(`✗ 期望的可信公钥读不出来:${(error as Error).message}`)
    return 1
  }

  const report = verifyCommercialArtifact(collected.files, expectedKeys ? { expectedKeys, expectedKeysSource } : {})
  const sources: ScannedFile[] = []
  for (const relative of ENTRY_SOURCES) {
    const full = path.join(repoRoot, relative)
    if (existsSync(full)) sources.push({ path: relative, text: readFileSync(full, "utf8") })
  }
  const entryCheck = sources.length === ENTRY_SOURCES.length
    ? verifyEntrySources(sources)
    : { name: "执行入口没有授权的测试接缝(源码级)", ok: false, evidence: [`✗ 只找到 ${sources.length}/${ENTRY_SOURCES.length} 个入口源码`] }
  const checks = [...report.checks, entryCheck]

  for (const check of checks) {
    console.log(`\n${check.ok ? "✓" : "✗"} ${check.name}`)
    for (const line of check.evidence) console.log(`    ${line}`)
  }
  const ok = checks.every((check) => check.ok)
  console.log(ok ? "\n✓ 产物检查全部通过" : "\n✗ 产物检查未通过 —— 不要发这个包")
  return ok ? 0 : 1
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  process.exit(await main(process.argv.slice(2)))
}
