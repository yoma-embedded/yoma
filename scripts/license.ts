/**
 * 授权签发工具(**只给开发者用**,不进任何安装包)。
 *
 *   npm run license -- keygen  --key-id <编号> --out-dir <仓库外的目录> [--encrypt]
 *   npm run license -- trust   --out <trust.json> <a.public.json> [<b.public.json> …]
 *   npm run license -- issue   --key <私钥.pem> --key-id <编号> --license-id <授权编号> --customer <称呼>
 *                              --from <YYYY-MM-DD> (--months N | --years N | --until <YYYY-MM-DD>)
 *                              [--tz +08:00] --out <文件.yoma-license>
 *   npm run license -- issue   --key … --key-id … --renew <旧授权.yoma-license> (--months N | --years N) --out <新文件>
 *   npm run license -- inspect <文件.yoma-license> [--trust <trust.json>]
 *
 * 三条纪律:
 * 1. **私钥只落在仓库外**:`keygen` 的输出目录若在任何 git 工作区里,直接拒绝;已存在的文件绝不覆盖。
 * 2. **私钥内容不上屏**:工具只打印公钥、指纹与文件路径。
 * 3. 加密私钥的口令只从环境变量 `YOMA_LICENSE_KEY_PASSPHRASE` 读,不走命令行参数(参数会进 shell 历史)。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { verifyLicenseFile, type TrustedLicenseKey } from "../packages/kernel/src/host/licensing/format.ts"
import {
  ISSUER_MARKER,
  TEST_KEY_ID_PATTERN,
  assertKeyId,
  calendarDateAt,
  fingerprintOf,
  formatCalendarDate,
  formatTzOffset,
  generateSigningKey,
  issueLicense,
  loadPrivateKey,
  parseCalendarDate,
  parseTzOffset,
  periodBetween,
  periodFromMonths,
  renewalPeriod,
  trustedKeyOf,
  type LicensePeriod,
} from "./license/lib.ts"

const PASSPHRASE_ENV = "YOMA_LICENSE_KEY_PASSPHRASE"

class UsageError extends Error {}

interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
}

const BOOLEAN_FLAGS = new Set(["encrypt", "force", "help"])

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true)
      continue
    }
    const value = inline ?? argv[(index += 1)]
    if (value === undefined) throw new UsageError(`--${name} 需要一个值`)
    flags.set(name, value)
  }
  return { flags, positional }
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name)
  if (typeof value !== "string" || value.length === 0) throw new UsageError(`缺少 --${name}`)
  return value
}

function optional(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function say(line = ""): void {
  process.stdout.write(`${line}\n`)
}

/** 目录(或它最近的已存在祖先)是否落在某个 git 工作区里。 */
export function insideGitWorkTree(dir: string): boolean {
  let current = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function localOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

function commandKeygen(parsed: Parsed): void {
  const keyId = required(parsed, "key-id")
  assertKeyId(keyId)
  const outDir = path.resolve(required(parsed, "out-dir"))
  if (insideGitWorkTree(outDir)) {
    throw new UsageError(`${outDir} 在一个 git 工作区里。签名私钥必须放在仓库外(例如 ~/yoma-license-keys)`)
  }
  const encrypt = parsed.flags.get("encrypt") === true
  const passphrase = process.env[PASSPHRASE_ENV]
  if (encrypt && !passphrase) throw new UsageError(`--encrypt 需要先设置环境变量 ${PASSPHRASE_ENV}`)

  const privateFile = path.join(outDir, `${keyId}.private.pem`)
  const publicFile = path.join(outDir, `${keyId}.public.json`)
  const trustFile = path.join(outDir, `${keyId}.trust.json`)
  for (const file of [privateFile, publicFile, trustFile]) {
    if (existsSync(file)) throw new UsageError(`${file} 已存在。密钥绝不覆盖 —— 换一个 --key-id,或先自己把旧文件挪走`)
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const generated = generateSigningKey(keyId, { passphrase: encrypt ? passphrase : undefined })
  // wx:即便上面的检查和这里之间被人抢先建了文件,也是失败而不是覆盖。
  writeFileSync(privateFile, generated.privateKeyPem, { flag: "wx", mode: 0o600 })
  chmodSync(privateFile, 0o600)
  const publicEntry = { ...generated.trusted, fingerprint: generated.fingerprint, createdAt: new Date().toISOString() }
  writeFileSync(publicFile, `${JSON.stringify(publicEntry, null, 2)}\n`, { flag: "wx" })
  writeFileSync(trustFile, `${JSON.stringify({ trustedKeys: [generated.trusted] }, null, 2)}\n`, { flag: "wx" })

  say(`✓ 已生成 Ed25519 签名密钥 ${keyId}`)
  say(`  私钥(${encrypt ? "已用口令加密" : "未加密"},权限 0600):${privateFile}`)
  say(`  公钥:${publicFile}`)
  say(`  构建用的信任文件:${trustFile}`)
  say(`  公钥指纹(SHA-256):${generated.fingerprint}`)
  if (TEST_KEY_ID_PATTERN.test(keyId)) say("  注意:这个编号是测试前缀,商业构建会拒绝信任它。")
  say()
  say("私钥没有第二份。现在就把它备份到至少两处离线介质(加密 U 盘 / 密码管理器的安全附件),")
  say("不要放进任何 git 仓库、网盘同步目录、聊天记录或安装包。丢了就只能换新密钥并重新发版。")
}

function readTrustEntries(file: string): TrustedLicenseKey[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  const list = Array.isArray((parsed as { trustedKeys?: unknown })?.trustedKeys)
    ? (parsed as { trustedKeys: unknown[] }).trustedKeys
    : [parsed]
  return list.map((entry) => {
    const key = entry as Partial<TrustedLicenseKey>
    if (typeof key?.id !== "string" || typeof key.publicKey !== "string") {
      throw new UsageError(`${file} 里不是公钥条目(需要 id 与 publicKey)`)
    }
    return { id: key.id, publicKey: key.publicKey }
  })
}

function commandTrust(parsed: Parsed): void {
  const out = path.resolve(required(parsed, "out"))
  if (parsed.positional.length === 0) throw new UsageError("至少给一个 <编号>.public.json")
  if (existsSync(out) && parsed.flags.get("force") !== true) throw new UsageError(`${out} 已存在(要覆盖加 --force)`)
  const keys: TrustedLicenseKey[] = []
  for (const file of parsed.positional) {
    for (const key of readTrustEntries(path.resolve(file))) {
      if (keys.some((existing) => existing.id === key.id)) throw new UsageError(`公钥编号 ${key.id} 重复`)
      keys.push(key)
    }
  }
  writeFileSync(out, `${JSON.stringify({ trustedKeys: keys }, null, 2)}\n`)
  say(`✓ 信任文件:${out}`)
  for (const key of keys) say(`  ${key.id}  ${fingerprintOf(key.publicKey)}`)
}

function commandIssue(parsed: Parsed): void {
  const keyFile = path.resolve(required(parsed, "key"))
  const keyId = required(parsed, "key-id")
  const out = path.resolve(required(parsed, "out"))
  if (existsSync(out) && parsed.flags.get("force") !== true) throw new UsageError(`${out} 已存在(要覆盖加 --force)`)
  if (process.platform !== "win32" && (statSync(keyFile).mode & 0o077) !== 0) {
    say(`⚠ ${keyFile} 的权限对其他用户可读,建议 chmod 600`)
  }
  const privateKey = loadPrivateKey(readFileSync(keyFile, "utf8"), process.env[PASSPHRASE_ENV])
  const trusted = trustedKeyOf(keyId, privateKey)

  const offset = parseTzOffset(optional(parsed, "tz") ?? formatTzOffset(localOffsetMinutes()))
  const months = monthsOf(parsed)
  const renewFile = optional(parsed, "renew")

  let licenseId: string
  let customerLabel: string
  let period: LicensePeriod
  if (renewFile) {
    // 旧文件必须是**这把钥匙**签的真授权:拿一份被改过的文件来续,等于替别人洗出一份真授权。
    const previous = verifyLicenseFile(readFileSync(path.resolve(renewFile), "utf8"), [trusted])
    if (!previous.ok) throw new UsageError(`旧授权验不过(${previous.code}):${previous.message}`)
    if (months === undefined) throw new UsageError("续费要给 --months 或 --years")
    licenseId = optional(parsed, "license-id") ?? previous.license.licenseId
    if (licenseId !== previous.license.licenseId) throw new UsageError("续费必须沿用旧的 licenseId(要换编号就当新订单签发)")
    customerLabel = optional(parsed, "customer") ?? previous.license.customerLabel
    period = renewalPeriod(previous.license, months, offset, Date.now())
  } else {
    licenseId = required(parsed, "license-id")
    customerLabel = required(parsed, "customer")
    const from = parseCalendarDate(optional(parsed, "from") ?? formatCalendarDate(calendarDateAt(Date.now(), offset)))
    const until = optional(parsed, "until")
    if (until && months !== undefined) throw new UsageError("--until 与 --months / --years 只能给一个")
    if (until) period = periodBetween(from, parseCalendarDate(until), offset)
    else if (months !== undefined) period = periodFromMonths(from, months, offset)
    else throw new UsageError("要给 --months、--years 或 --until 之一")
  }

  const issued = issueLicense({ privateKey, keyId, licenseId, customerLabel, ...period })
  writeFileSync(out, issued.text, { flag: parsed.flags.get("force") === true ? "w" : "wx" })

  say(`✓ 已签发:${out}`)
  say(`  授权编号:${issued.payload.licenseId}${renewFile ? "(续费,沿用)" : ""}`)
  say(`  购买人:${issued.payload.customerLabel}`)
  say(`  有效期:${period.human}`)
  say(`  文件内(UTC):${issued.payload.notBefore} → ${issued.payload.expiresAt}`)
  say(`  签名公钥:${keyId}  指纹 ${fingerprintOf(trusted.publicKey)}`)
  say()
  say("把这个 .yoma-license 文件发给客户即可。私钥、公钥文件、信任文件都不要发。")
}

function monthsOf(parsed: Parsed): number | undefined {
  const months = optional(parsed, "months")
  const years = optional(parsed, "years")
  if (months !== undefined && years !== undefined) throw new UsageError("--months 与 --years 只能给一个")
  const raw = months ?? years
  if (raw === undefined) return undefined
  if (!/^\d{1,3}$/.test(raw)) throw new UsageError(`${months !== undefined ? "--months" : "--years"} 必须是正整数`)
  return Number(raw) * (years !== undefined ? 12 : 1)
}

function commandInspect(parsed: Parsed): void {
  const file = parsed.positional[0]
  if (!file) throw new UsageError("要给一个授权文件")
  const text = readFileSync(path.resolve(file), "utf8")
  const trustFile = optional(parsed, "trust")

  // 没给信任文件也能看内容 —— 但要明说**没验签**,免得把一份伪造的文件看成真的。
  const envelope = JSON.parse(text) as { payload?: string }
  const payload = JSON.parse(Buffer.from(String(envelope.payload ?? ""), "base64url").toString("utf8")) as Record<string, unknown>
  say(`文件:${path.resolve(file)}`)
  for (const [key, value] of Object.entries(payload)) say(`  ${key}: ${JSON.stringify(value)}`)

  if (!trustFile) {
    say("签名:未验证(没给 --trust)")
    return
  }
  const verified = verifyLicenseFile(text, readTrustEntries(path.resolve(trustFile)))
  if (!verified.ok) {
    say(`签名:✗ 无效(${verified.code})—— ${verified.message}`)
    process.exitCode = 1
    return
  }
  const now = Date.now()
  const state =
    now < Date.parse(verified.license.notBefore) ? "尚未生效" : now >= Date.parse(verified.license.expiresAt) ? "已到期" : "有效期内"
  const offset = localOffsetMinutes()
  const lastDay = formatCalendarDate(calendarDateAt(Date.parse(verified.license.expiresAt) - 1, offset))
  say(`签名:✓ 有效(公钥 ${verified.license.signingKeyId})`)
  say(`此刻:${state};本机时区(UTC${formatTzOffset(offset)})下最后一天是 ${lastDay}`)
}

const USAGE = `授权签发工具(${ISSUER_MARKER})

  keygen  --key-id <编号> --out-dir <仓库外的目录> [--encrypt]
  trust   --out <trust.json> <a.public.json> [<b.public.json> …] [--force]
  issue   --key <私钥.pem> --key-id <编号> --license-id <授权编号> --customer <称呼>
          [--from <YYYY-MM-DD>] (--months N | --years N | --until <YYYY-MM-DD>) [--tz +08:00] --out <文件> [--force]
  issue   --key <私钥.pem> --key-id <编号> --renew <旧授权> (--months N | --years N) --out <文件>
  inspect <文件.yoma-license> [--trust <trust.json>]

加密私钥的口令从环境变量 ${PASSPHRASE_ENV} 读。`

export function main(argv: string[]): void {
  const [command, ...rest] = argv
  const parsed = parseArgs(rest)
  if (!command || command === "help" || parsed.flags.get("help") === true) {
    say(USAGE)
    return
  }
  if (command === "keygen") commandKeygen(parsed)
  else if (command === "trust") commandTrust(parsed)
  else if (command === "issue") commandIssue(parsed)
  else if (command === "inspect") commandInspect(parsed)
  else throw new UsageError(`不认识的命令 ${command}`)
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`✗ ${(error as Error).message}\n`)
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`)
    process.exit(error instanceof UsageError ? 2 : 1)
  }
}
