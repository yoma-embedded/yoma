/**
 * 签发端:`scripts/license/lib.ts` 的日期数学 + `scripts/license.ts` 命令行的端到端。
 *
 * 两半的失败形状不一样,所以分两半测:
 * - **日期数学**算错不会报错,只会让客户的有效期少一天或多一个月,而两边谁都不知道。纯函数,直接调。
 * - **命令行**的要害是那三条纪律(私钥只落仓库外、绝不覆盖、不上屏)。这些只有真起一个子进程才算数:
 *   `process.exit` 的码、stdout / stderr 上到底印了什么、盘上到底多了什么文件,在进程内都测不真。
 *
 * 所有密钥都是用例现场生成的,落点全在 `os.tmpdir()` 下的临时目录 —— 仓库里不存任何测试私钥。
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { verifyLicenseFile, type TrustedLicenseKey } from "../../packages/kernel/src/host/licensing/format.ts"
import {
  addCalendarMonths,
  daysInMonth,
  fingerprintOf,
  parseCalendarDate,
  parseTzOffset,
  periodBetween,
  periodFromMonths,
  renewalPeriod,
  type CalendarDate,
} from "../license/lib.ts"

const CN = 480 // +08:00
const IN = parseTzOffset("-05:30") // 负的半小时偏移

const date = (text: string): CalendarDate => parseCalendarDate(text)

describe("日期数学:按日历算,不按 30 天算", () => {
  it("periodFromMonths:9 月 20 日买一个月 = 9/20 00:00 到 10/20 24:00(= 10/21 00:00)", () => {
    const period = periodFromMonths(date("2026-09-20"), 1, CN)
    // +08:00 的 9/20 00:00 就是 UTC 的 9/19 16:00;10/21 00:00 就是 UTC 的 10/20 16:00。
    expect(period).toEqual({
      notBefore: "2026-09-19T16:00:00Z",
      expiresAt: "2026-10-20T16:00:00Z",
      human: "2026-09-20 00:00 至 2026-10-20 24:00(UTC+08:00)",
    })
    // 说给客户的最后一天必须真的被包含:那一天的 23:59 还在期内,再过一分钟就不在。
    expect(Date.parse("2026-10-20T15:59:00Z")).toBeLessThan(Date.parse(period.expiresAt))
    expect(Date.parse("2026-10-20T16:00:00Z")).toBe(Date.parse(period.expiresAt))
    // 一个月 = 31 天整(9/20 到 10/21),不是 30 天。
    expect((Date.parse(period.expiresAt) - Date.parse(period.notBefore)) / 86_400_000).toBe(31)
  })

  it("periodFromMonths:1 月 31 日 + 1 个月落到 2 月月末 —— 平年 28 日、闰年 29 日", () => {
    expect(daysInMonth(2027, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(addCalendarMonths(date("2027-01-31"), 1)).toEqual({ year: 2027, month: 2, day: 28 })
    expect(addCalendarMonths(date("2028-01-31"), 1)).toEqual({ year: 2028, month: 2, day: 29 })

    const common = periodFromMonths(date("2027-01-31"), 1, CN)
    expect(common).toEqual({
      notBefore: "2027-01-30T16:00:00Z",
      expiresAt: "2027-02-28T16:00:00Z",
      human: "2027-01-31 00:00 至 2027-02-28 24:00(UTC+08:00)",
    })

    const leap = periodFromMonths(date("2028-01-31"), 1, CN)
    expect(leap).toEqual({
      notBefore: "2028-01-30T16:00:00Z",
      expiresAt: "2028-02-29T16:00:00Z",
      human: "2028-01-31 00:00 至 2028-02-29 24:00(UTC+08:00)",
    })
  })

  it("periodFromMonths:12 个月跨年;1–120 之外的月数一律拒", () => {
    expect(periodFromMonths(date("2026-09-20"), 12, CN)).toEqual({
      notBefore: "2026-09-19T16:00:00Z",
      expiresAt: "2027-09-20T16:00:00Z",
      human: "2026-09-20 00:00 至 2027-09-20 24:00(UTC+08:00)",
    })
    // 12 月 31 日 + 1 个月要跨到下一年的 1 月。
    expect(addCalendarMonths(date("2026-12-31"), 1)).toEqual({ year: 2027, month: 1, day: 31 })
    expect(periodFromMonths(date("2026-09-20"), 120, CN).expiresAt).toBe("2036-09-20T16:00:00Z")

    for (const months of [0, -1, 121, 1.5, Number.NaN]) {
      expect(() => periodFromMonths(date("2026-09-20"), months, CN), String(months)).toThrow(/1–120/)
    }
  })

  it("periodFromMonths:负的半小时偏移(-05:30)也按那个时区的墙上时间算", () => {
    expect(IN).toBe(-330)
    expect(periodFromMonths(date("2026-09-20"), 1, IN)).toEqual({
      notBefore: "2026-09-20T05:30:00Z",
      expiresAt: "2026-10-21T05:30:00Z",
      human: "2026-09-20 00:00 至 2026-10-20 24:00(UTC-05:30)",
    })
  })

  it("periodBetween:同一天也成立(整 24 小时);结束早于开始就抛", () => {
    const oneDay = periodBetween(date("2026-09-20"), date("2026-09-20"), CN)
    expect(oneDay).toEqual({
      notBefore: "2026-09-19T16:00:00Z",
      expiresAt: "2026-09-20T16:00:00Z",
      human: "2026-09-20 00:00 至 2026-09-20 24:00(UTC+08:00)",
    })
    expect(() => periodBetween(date("2026-09-21"), date("2026-09-20"), CN)).toThrow(/结束早于开始/)
  })

  it("renewalPeriod 未到期:notBefore 沿用,到期日从旧的最后一天顺延 N 个日历月", () => {
    const previous = periodFromMonths(date("2026-09-20"), 1, CN)
    const renewed = renewalPeriod(previous, 1, CN, Date.parse("2026-10-01T00:00:00Z"))
    expect(renewed.notBefore).toBe(previous.notBefore)
    // 旧的最后一天是 10/20(到期时刻退 1 毫秒);顺延一个月到 11/20 24:00。
    expect(renewed.expiresAt).toBe("2026-11-20T16:00:00Z")
    expect(renewed.human).toBe("2026-09-20 00:00 至 2026-11-20 24:00(UTC+08:00),由旧到期日顺延 1 个月")
  })

  it("renewalPeriod 未到期:旧的最后一天是 1 月 31 日时,顺延一个月落到 2 月月末", () => {
    const previous = periodBetween(date("2027-01-01"), date("2027-01-31"), CN)
    expect(previous.expiresAt).toBe("2027-01-31T16:00:00Z")
    const renewed = renewalPeriod(previous, 1, CN, Date.parse("2027-01-15T00:00:00Z"))
    expect(renewed.expiresAt).toBe("2027-02-28T16:00:00Z")
    expect(renewed.human).toContain("至 2027-02-28 24:00")
  })

  it("renewalPeriod 已过期:从今天重起,断档那几天不补送", () => {
    const previous = periodFromMonths(date("2026-09-20"), 1, CN)
    const renewed = renewalPeriod(previous, 1, CN, Date.parse("2026-12-05T03:00:00Z"))
    // 2026-12-05T03:00Z 在 +08:00 是 12 月 5 日 11:00,所以从 12/5 00:00 起算。
    expect(renewed.notBefore).toBe("2026-12-04T16:00:00Z")
    expect(renewed.expiresAt).toBe("2027-01-05T16:00:00Z")
    expect(renewed.notBefore).not.toBe(previous.notBefore)
    expect(renewed.human).not.toContain("顺延")
  })

  it("renewalPeriod:到期那一刻算已过期(有效期是左闭右开),新周期正好从旧的到期时刻接上", () => {
    const previous = periodFromMonths(date("2026-09-20"), 1, CN)
    const atExpiry = renewalPeriod(previous, 1, CN, Date.parse(previous.expiresAt))
    expect(atExpiry.notBefore).toBe(previous.expiresAt)
    expect(atExpiry.expiresAt).toBe("2026-11-21T16:00:00Z")
    // 差 1 毫秒还没到期,走的就是"沿用 notBefore"那一支。
    const justBefore = renewalPeriod(previous, 1, CN, Date.parse(previous.expiresAt) - 1)
    expect(justBefore.notBefore).toBe(previous.notBefore)
  })

  it("renewalPeriod:旧授权的日期解析不出来就抛,不猜", () => {
    expect(() => renewalPeriod({ notBefore: "2026-09-20", expiresAt: "2026-10-20" }, 1, CN, 0)).toThrow(/解析不出来/)
    expect(() =>
      renewalPeriod({ notBefore: "2026-09-19T16:00:00+08:00", expiresAt: "2026-10-20T16:00:00Z" }, 1, CN, 0),
    ).toThrow(/解析不出来/)
  })

  it("parseTzOffset:只认 ±HH:MM / ±HHMM / Z,超范围的拒", () => {
    expect(parseTzOffset("Z")).toBe(0)
    expect(parseTzOffset("z")).toBe(0)
    expect(parseTzOffset("+08:00")).toBe(480)
    expect(parseTzOffset("+0800")).toBe(480)
    expect(parseTzOffset("+00:00")).toBe(0)
    expect(parseTzOffset("+14:00")).toBe(840)
    expect(parseTzOffset("-05:30")).toBe(-330)
    for (const bad of ["+8:00", "08:00", "+08", "+08:0", "", "UTC+08:00", "8", "+08:00:00"]) {
      expect(() => parseTzOffset(bad), JSON.stringify(bad)).toThrow(/写法不对/)
    }
    for (const bad of ["+15:00", "-15:00", "+08:60"]) {
      expect(() => parseTzOffset(bad), JSON.stringify(bad)).toThrow(/超出范围/)
    }
  })

  it("parseCalendarDate:只认 YYYY-MM-DD,而且那一天必须真的存在", () => {
    expect(parseCalendarDate("2026-09-20")).toEqual({ year: 2026, month: 9, day: 20 })
    expect(parseCalendarDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 })
    for (const bad of ["2026-9-20", "26-09-20", "2026/09/20", "", "2026-09-20T00:00:00Z", "2026-09-2"]) {
      expect(() => parseCalendarDate(bad), JSON.stringify(bad)).toThrow(/写法不对/)
    }
    for (const bad of ["2027-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-01-00", "2026-04-31"]) {
      expect(() => parseCalendarDate(bad), JSON.stringify(bad)).toThrow(/不存在/)
    }
  })
})

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const CLI = path.join(REPO_ROOT, "scripts", "license.ts")
const PASSPHRASE_ENV = "YOMA_LICENSE_KEY_PASSPHRASE"
/** 子进程用的**慷慨**期限:每一发都要付 node + tsx 的启动钱,CI 上的 4 核 runner 还要排队。 */
const CLI_TIMEOUT = 120_000

interface Run {
  status: number | null
  stdout: string
  stderr: string
  /** stdout + stderr:"私钥不上屏"这条要两个流一起看。 */
  output: string
}

function license(args: string[], options: { passphrase?: string } = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // 开发机上可能本来就设着口令。不显式摘掉的话,"没给口令"那几条用例的结论取决于跑测试的人的 shell。
  delete env[PASSPHRASE_ENV]
  if (options.passphrase !== undefined) env[PASSPHRASE_ENV] = options.passphrase
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  })
  if (result.error) throw result.error
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` }
}

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function trustEntries(file: string): TrustedLicenseKey[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { trustedKeys: TrustedLicenseKey[] }
  return parsed.trustedKeys
}

/** 改 payload 再装回去,签名原样 —— 拿一份被改过的旧授权去"续费"的那种手法。 */
function tamper(file: string): void {
  const envelope = JSON.parse(readFileSync(file, "utf8")) as { payload: string; signature: string }
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as Record<string, unknown>
  payload.customerLabel = "别人"
  writeFileSync(file, JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") }))
}

/**
 * 整段命令行测试共用一把钥匙(keygen 那几条各自现场再生成)。
 * 一次 keygen 一次 spawn,能省的都省 —— 这些用例慢在进程启动上。
 */
let keys: string
let keyFile: string
let trustFile: string
const KEY_ID = "acme-signing-1"

beforeAll(() => {
  keys = tempDir("yoma-license-keys-")
  const run = license(["keygen", "--key-id", KEY_ID, "--out-dir", keys])
  // 唯一预期的失败是 os.tmpdir() 本身落在某个 git 工作区里(keygen 会拒)—— 把工具的原话带出来,
  // 免得后面十几条用例各自报一句"文件不存在",看着像工具坏了。
  expect(run.status, `keygen 失败,后面的命令行用例全部依赖它:\n${run.output}`).toBe(0)
  keyFile = path.join(keys, `${KEY_ID}.private.pem`)
  trustFile = path.join(keys, `${KEY_ID}.trust.json`)
}, CLI_TIMEOUT)

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("license keygen", () => {
  it(
    "生成三个文件、私钥 0600,而且私钥内容一个字节都不上屏",
    () => {
      const dir = tempDir("yoma-license-keygen-")
      const keyId = "acme-fresh-1"
      const run = license(["keygen", "--key-id", keyId, "--out-dir", dir])
      expect(run.status, run.output).toBe(0)

      const privateFile = path.join(dir, `${keyId}.private.pem`)
      const publicFile = path.join(dir, `${keyId}.public.json`)
      const trust = path.join(dir, `${keyId}.trust.json`)
      for (const file of [privateFile, publicFile, trust]) expect(existsSync(file), file).toBe(true)

      const pem = readFileSync(privateFile, "utf8")
      expect(pem).toContain("-----BEGIN PRIVATE KEY-----")
      // Windows 没有 POSIX 权限位,那条纪律在那边由目录 ACL 承担。
      if (process.platform !== "win32") expect(statSync(privateFile).mode & 0o777).toBe(0o600)

      // **屏幕上不许出现私钥。** 连 base64 正文的任何一行都不许 —— 只查 "PRIVATE KEY" 会漏掉
      // "把 PEM 正文打出来但没打头尾" 这种写法。
      expect(run.output).not.toContain("PRIVATE KEY")
      const body = pem
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("-----"))
      expect(body.length).toBeGreaterThan(0)
      for (const line of body) expect(run.output, line.slice(0, 16)).not.toContain(line)

      // 公钥、指纹、路径这些是该印的。
      const entry = JSON.parse(readFileSync(publicFile, "utf8")) as TrustedLicenseKey & { fingerprint: string }
      expect(entry.id).toBe(keyId)
      expect(entry.fingerprint).toBe(fingerprintOf(entry.publicKey))
      expect(run.stdout).toContain(entry.fingerprint)
      expect(run.stdout).toContain(privateFile)
      expect(trustEntries(trust)).toEqual([{ id: keyId, publicKey: entry.publicKey }])
    },
    CLI_TIMEOUT,
  )

  it(
    "--out-dir 落在 git 工作区里:直接拒,而且什么都没写",
    () => {
      const inRepo = path.join(REPO_ROOT, "tmp-keys")
      expect(existsSync(inRepo), "用例开始前仓库里不该有这个目录").toBe(false)
      const run = license(["keygen", "--key-id", "acme-in-repo", "--out-dir", "tmp-keys"])
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("git 工作区")
      // 目录都没建起来 —— 拒绝发生在 mkdir 之前。
      expect(existsSync(inRepo)).toBe(false)
    },
    CLI_TIMEOUT,
  )

  it(
    "同一个 key-id 再跑一次:拒,原私钥字节不变",
    () => {
      const before = readFileSync(keyFile)
      const run = license(["keygen", "--key-id", KEY_ID, "--out-dir", keys])
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("绝不覆盖")
      expect(readFileSync(keyFile).equals(before)).toBe(true)
    },
    CLI_TIMEOUT,
  )

  it(
    "--encrypt 但没设口令环境变量:拒,不生成半份密钥",
    () => {
      const dir = tempDir("yoma-license-noenv-")
      const run = license(["keygen", "--key-id", "acme-noenv", "--out-dir", dir, "--encrypt"])
      expect(run.status).toBe(2)
      expect(run.stderr).toContain(PASSPHRASE_ENV)
      expect(existsSync(path.join(dir, "acme-noenv.private.pem"))).toBe(false)
    },
    CLI_TIMEOUT,
  )
})

describe("license trust", () => {
  it(
    "合并两份 public.json;编号重复被拒且不写文件;已存在的输出不覆盖",
    () => {
      const dir = tempDir("yoma-license-trust-")
      const alpha = tempDir("yoma-license-alpha-")
      const beta = tempDir("yoma-license-beta-")
      expect(license(["keygen", "--key-id", "acme-alpha", "--out-dir", alpha]).status).toBe(0)
      expect(license(["keygen", "--key-id", "acme-beta", "--out-dir", beta]).status).toBe(0)
      const alphaPublic = path.join(alpha, "acme-alpha.public.json")
      const betaPublic = path.join(beta, "acme-beta.public.json")

      const merged = path.join(dir, "merged.trust.json")
      const run = license(["trust", "--out", merged, alphaPublic, betaPublic])
      expect(run.status, run.output).toBe(0)
      const entries = trustEntries(merged)
      expect(entries.map((entry) => entry.id)).toEqual(["acme-alpha", "acme-beta"])
      for (const entry of entries) expect(run.stdout).toContain(fingerprintOf(entry.publicKey))
      // 合出来的文件真能验一份用其中一把钥匙签的授权。
      const out = path.join(dir, "alpha.yoma-license")
      expect(
        license([
          "issue",
          "--key",
          path.join(alpha, "acme-alpha.private.pem"),
          "--key-id",
          "acme-alpha",
          "--license-id",
          "ORD-TRUST-1",
          "--customer",
          "合并测试",
          "--from",
          "2026-09-20",
          "--months",
          "1",
          "--tz",
          "+08:00",
          "--out",
          out,
        ]).status,
      ).toBe(0)
      expect(verifyLicenseFile(readFileSync(out, "utf8"), entries).ok).toBe(true)

      const dup = path.join(dir, "dup.trust.json")
      const duplicate = license(["trust", "--out", dup, alphaPublic, alphaPublic])
      expect(duplicate.status).toBe(2)
      expect(duplicate.stderr).toContain("重复")
      expect(existsSync(dup)).toBe(false)

      const again = license(["trust", "--out", merged, alphaPublic])
      expect(again.status).toBe(2)
      expect(again.stderr).toContain("已存在")
      expect(trustEntries(merged).map((entry) => entry.id)).toEqual(["acme-alpha", "acme-beta"])
    },
    CLI_TIMEOUT,
  )
})

describe("license issue / inspect", () => {
  it(
    "签发的文件能被只持有公钥的客户端验过,inspect --trust 说它有效",
    () => {
      const dir = tempDir("yoma-license-issue-")
      const out = path.join(dir, "ORD-2026-0042.yoma-license")
      const run = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--license-id",
        "ORD-2026-0042",
        "--customer",
        "深圳某某科技 李工",
        "--from",
        "2026-09-20",
        "--months",
        "1",
        "--tz",
        "+08:00",
        "--out",
        out,
      ])
      expect(run.status, run.output).toBe(0)
      expect(run.stdout).toContain("2026-09-20 00:00 至 2026-10-20 24:00(UTC+08:00)")

      // 客户端那一半:只有 trust 文件里的公钥,没有私钥。
      const verified = verifyLicenseFile(readFileSync(out, "utf8"), trustEntries(trustFile))
      expect(verified.ok).toBe(true)
      if (!verified.ok) throw new Error(verified.code)
      expect(verified.license).toMatchObject({
        licenseId: "ORD-2026-0042",
        customerLabel: "深圳某某科技 李工",
        notBefore: "2026-09-19T16:00:00Z",
        expiresAt: "2026-10-20T16:00:00Z",
        signingKeyId: KEY_ID,
      })

      const inspected = license(["inspect", out, "--trust", trustFile])
      expect(inspected.status, inspected.output).toBe(0)
      expect(inspected.stdout).toContain("签名:✓ 有效")
      expect(inspected.stdout).toContain("ORD-2026-0042")

      // 没给 --trust 时必须说清楚"没验签",否则一份伪造的文件会被当成真的看。
      const unverified = license(["inspect", out])
      expect(unverified.status, unverified.output).toBe(0)
      expect(unverified.stdout).toContain("未验证")
      expect(unverified.stdout).not.toContain("✓ 有效")

      // 改过的文件:inspect 要报无效并以非零退出。
      const forged = path.join(dir, "forged.yoma-license")
      writeFileSync(forged, readFileSync(out))
      tamper(forged)
      const bad = license(["inspect", forged, "--trust", trustFile])
      expect(bad.status).toBe(1)
      expect(bad.stdout).toContain("bad-signature")
    },
    CLI_TIMEOUT,
  )

  it(
    "不带 --force 不覆盖已有输出;带 --force 才覆盖",
    () => {
      const dir = tempDir("yoma-license-force-")
      const out = path.join(dir, "ORD-FORCE.yoma-license")
      const base = [
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--license-id",
        "ORD-FORCE",
        "--from",
        "2026-09-20",
        "--months",
        "1",
        "--tz",
        "+08:00",
        "--out",
        out,
      ]
      expect(license([...base, "--customer", "第一位客户"]).status).toBe(0)
      const before = readFileSync(out)

      const refused = license([...base, "--customer", "第二位客户"])
      expect(refused.status).toBe(2)
      expect(refused.stderr).toContain("已存在")
      expect(readFileSync(out).equals(before)).toBe(true)

      const forced = license([...base, "--customer", "第二位客户", "--force"])
      expect(forced.status, forced.output).toBe(0)
      expect(readFileSync(out).equals(before)).toBe(false)
      const verified = verifyLicenseFile(readFileSync(out, "utf8"), trustEntries(trustFile))
      expect(verified.ok && verified.license.customerLabel).toBe("第二位客户")
    },
    CLI_TIMEOUT,
  )

  it(
    "--renew:沿用 licenseId、拒绝被改过的旧文件、拒绝换编号",
    () => {
      const dir = tempDir("yoma-license-renew-")
      const first = path.join(dir, "ORD-RENEW.yoma-license")
      expect(
        license([
          "issue",
          "--key",
          keyFile,
          "--key-id",
          KEY_ID,
          "--license-id",
          "ORD-RENEW",
          "--customer",
          "续费测试 王工",
          "--from",
          "2026-09-20",
          "--months",
          "1",
          "--tz",
          "+08:00",
          "--out",
          first,
        ]).status,
      ).toBe(0)

      const renewed = path.join(dir, "ORD-RENEW-2.yoma-license")
      const run = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--renew",
        first,
        "--months",
        "1",
        "--tz",
        "+08:00",
        "--out",
        renewed,
      ])
      expect(run.status, run.output).toBe(0)
      expect(run.stdout).toContain("续费,沿用")
      const before = verifyLicenseFile(readFileSync(first, "utf8"), trustEntries(trustFile))
      const after = verifyLicenseFile(readFileSync(renewed, "utf8"), trustEntries(trustFile))
      expect(before.ok && after.ok).toBe(true)
      if (!before.ok || !after.ok) throw new Error("签发的文件应当验得过")
      // 编号与购买人沿用,生效时间沿用,到期日顺延一个月。
      expect(after.license.licenseId).toBe(before.license.licenseId)
      expect(after.license.customerLabel).toBe(before.license.customerLabel)
      expect(after.license.notBefore).toBe(before.license.notBefore)
      expect(after.license.expiresAt).toBe("2026-11-20T16:00:00Z")

      // 拿一份被改过的旧文件来续,等于替别人洗出一份真授权:必须拒。
      const forged = path.join(dir, "forged.yoma-license")
      writeFileSync(forged, readFileSync(first))
      tamper(forged)
      const forgedOut = path.join(dir, "from-forged.yoma-license")
      const fromForged = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--renew",
        forged,
        "--months",
        "1",
        "--out",
        forgedOut,
      ])
      expect(fromForged.status).toBe(2)
      expect(fromForged.stderr).toContain("旧授权验不过")
      expect(existsSync(forgedOut)).toBe(false)

      // 换编号就不是续费了。
      const renumberedOut = path.join(dir, "renumbered.yoma-license")
      const renumbered = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--renew",
        first,
        "--license-id",
        "ORD-OTHER",
        "--months",
        "1",
        "--out",
        renumberedOut,
      ])
      expect(renumbered.status).toBe(2)
      expect(renumbered.stderr).toContain("沿用旧的 licenseId")
      expect(existsSync(renumberedOut)).toBe(false)

      // 续费必须给期限:少了 --months / --years 不许悄悄按一个默认值签。
      const noMonths = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--renew",
        first,
        "--out",
        path.join(dir, "no-months.yoma-license"),
      ])
      expect(noMonths.status).toBe(2)
      expect(noMonths.stderr).toContain("续费要给")
    },
    CLI_TIMEOUT,
  )

  it(
    "加密私钥:口令对了能签发,错了报错且不产出文件",
    () => {
      const dir = tempDir("yoma-license-enc-")
      const keyId = "acme-encrypted-1"
      const passphrase = "correct horse battery staple"
      const generated = license(["keygen", "--key-id", keyId, "--out-dir", dir, "--encrypt"], { passphrase })
      expect(generated.status, generated.output).toBe(0)
      const encryptedKey = path.join(dir, `${keyId}.private.pem`)
      expect(readFileSync(encryptedKey, "utf8")).toContain("-----BEGIN ENCRYPTED PRIVATE KEY-----")
      expect(generated.output).not.toContain(passphrase)

      const out = path.join(dir, "ORD-ENC.yoma-license")
      const args = [
        "issue",
        "--key",
        encryptedKey,
        "--key-id",
        keyId,
        "--license-id",
        "ORD-ENC",
        "--customer",
        "加密密钥客户",
        "--from",
        "2026-09-20",
        "--months",
        "1",
        "--tz",
        "+08:00",
        "--out",
        out,
      ]
      const signed = license(args, { passphrase })
      expect(signed.status, signed.output).toBe(0)
      expect(verifyLicenseFile(readFileSync(out, "utf8"), trustEntries(path.join(dir, `${keyId}.trust.json`))).ok).toBe(
        true,
      )

      const wrongOut = path.join(dir, "ORD-ENC-WRONG.yoma-license")
      const wrong = license([...args.slice(0, -1), wrongOut], { passphrase: "wrong passphrase" })
      expect(wrong.status).not.toBe(0)
      expect(existsSync(wrongOut)).toBe(false)

      const missing = license([...args.slice(0, -1), wrongOut])
      expect(missing.status).not.toBe(0)
      expect(existsSync(wrongOut)).toBe(false)
    },
    CLI_TIMEOUT,
  )

  it(
    "参数错了带用法、退出码 2:互斥的期限写法、不认识的命令、缺必填项",
    () => {
      const dir = tempDir("yoma-license-usage-")
      const out = path.join(dir, "x.yoma-license")
      const both = license([
        "issue",
        "--key",
        keyFile,
        "--key-id",
        KEY_ID,
        "--license-id",
        "ORD-USAGE",
        "--customer",
        "用法测试",
        "--from",
        "2026-09-20",
        "--months",
        "1",
        "--until",
        "2026-12-31",
        "--out",
        out,
      ])
      expect(both.status).toBe(2)
      expect(both.stderr).toContain("只能给一个")
      // UsageError 会把用法贴在后面,方便当场改命令。
      expect(both.stderr).toContain("keygen  --key-id")
      expect(existsSync(out)).toBe(false)

      const unknown = license(["frobnicate"])
      expect(unknown.status).toBe(2)
      expect(unknown.stderr).toContain("不认识的命令")

      const noKeyId = license(["keygen", "--out-dir", dir])
      expect(noKeyId.status).toBe(2)
      expect(noKeyId.stderr).toContain("缺少 --key-id")

      // help 是正常退出,而且不提任何私钥内容。
      const help = license(["help"])
      expect(help.status).toBe(0)
      expect(help.stdout).toContain("keygen")
      expect(help.stdout).toContain("inspect")
    },
    CLI_TIMEOUT,
  )
})

describe("license issue:--key-id 与私钥必须是同一把", () => {
  it(
    "编号拼错 / 拿错私钥 → 拒签,不产出文件;私钥旁边没有 public.json 时只能提醒人工核指纹",
    () => {
      const dir = tempDir("yoma-license-keyid-")
      const out = path.join(dir, "ORD-KEYID.yoma-license")
      const base = ["--license-id", "ORD-KEYID", "--customer", "编号核对", "--from", "2026-09-20", "--months", "1", "--tz", "+08:00"]

      // 拼错编号:这把私钥登记在 acme-signing-1 名下,用别的名字签出来客户端一律"授权无效"。
      const typo = license(["issue", "--key", keyFile, "--key-id", "acme-signing-2", ...base, "--out", out])
      expect(typo.status).toBe(2)
      expect(typo.stderr).toContain(KEY_ID)
      expect(existsSync(out)).toBe(false)

      // 拿错私钥:同目录里再生成一把,用 A 的编号配 B 的私钥。
      const other = license(["keygen", "--key-id", "acme-signing-9", "--out-dir", keys])
      expect(other.status, other.output).toBe(0)
      const swapped = license([
        "issue",
        "--key",
        path.join(keys, "acme-signing-9.private.pem"),
        "--key-id",
        KEY_ID,
        ...base,
        "--out",
        out,
      ])
      expect(swapped.status).toBe(2)
      expect(swapped.stderr).toContain("对不上")
      expect(existsSync(out)).toBe(false)

      // 私钥被单独挪走(旁边没有 public.json):核不了,照签,但要明说让人工核指纹。
      const lonely = tempDir("yoma-license-lonely-")
      const lonelyKey = path.join(lonely, "moved.private.pem")
      writeFileSync(lonelyKey, readFileSync(keyFile, "utf8"), { mode: 0o600 })
      const warned = license(["issue", "--key", lonelyKey, "--key-id", KEY_ID, ...base, "--out", out])
      expect(warned.status, warned.output).toBe(0)
      expect(warned.stdout).toContain("无法核对 --key-id")
      expect(existsSync(out)).toBe(true)
    },
    CLI_TIMEOUT,
  )

  it(
    "续费同样有 10 年上限:--renew … --years 100 被拒",
    () => {
      const dir = tempDir("yoma-license-cap-")
      const first = path.join(dir, "first.yoma-license")
      const issued = license([
        "issue", "--key", keyFile, "--key-id", KEY_ID, "--license-id", "ORD-CAP", "--customer", "上限",
        "--from", "2026-09-20", "--months", "1", "--tz", "+08:00", "--out", first,
      ])
      expect(issued.status, issued.output).toBe(0)
      const out = path.join(dir, "century.yoma-license")
      const century = license(["issue", "--key", keyFile, "--key-id", KEY_ID, "--renew", first, "--years", "100", "--out", out])
      expect(century.status).not.toBe(0)
      expect(century.stderr).toContain("1–120")
      expect(existsSync(out)).toBe(false)
    },
    CLI_TIMEOUT,
  )
})
