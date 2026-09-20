/**
 * 授权核心:格式、验签、落盘、导入规则、执行资格检查。
 *
 * 密钥全部是用例现场生成的临时 Ed25519 密钥,configDir 全部是临时目录 ——
 * 仓库里没有任何测试私钥,也不读写开发机真实的 `~/.yoma`。
 */

import { generateKeyPairSync, sign } from "node:crypto"
import dns from "node:dns"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LICENSE_MAX_BYTES, LICENSE_PRODUCT } from "../../license-view.ts"
import { generateSigningKey, issueLicense, loadPrivateKey } from "../../../../../scripts/license/lib.ts"
import { yomaConfigDir } from "../auth.ts"
import {
  COMMUNITY_POLICY,
  LicenseImportError,
  LicenseRequiredError,
  LicenseService,
  buildLicensePolicy,
  defaultLicenseConfigDir,
  encodeLicenseFile,
  licenseFilePath,
  normalizeLicensePolicy,
  parseUtcIso,
  verifyLicenseFile,
  type LicensePolicy,
} from "./index.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0) // 2026-09-20T04:00:00Z

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

function signer(keyId = "unit-key-a") {
  const generated = generateSigningKey(keyId)
  const privateKey = loadPrivateKey(generated.privateKeyPem)
  return { keyId, privateKey, trusted: generated.trusted }
}

const KEY = signer()
const POLICY: LicensePolicy = { edition: "commercial", trustedKeys: [KEY.trusted] }

function license(overrides: Partial<Parameters<typeof issueLicense>[0]> = {}) {
  return issueLicense({
    privateKey: KEY.privateKey,
    keyId: KEY.keyId,
    licenseId: "ORD-2026-0001",
    customerLabel: "测试客户 张工",
    issuedAt: iso(T0 - HOUR),
    notBefore: iso(T0 - DAY),
    expiresAt: iso(T0 + 30 * DAY),
    ...overrides,
  })
}

/** 改 payload 再装回去,签名原样。 */
function tamper(text: string, mutate: (payload: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(text) as { payload: string; signature: string }
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as Record<string, unknown>
  mutate(payload)
  return JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })
}

let configDir: string
let now: number
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "yoma-license-"))
  now = T0
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

const service = (policy: LicensePolicy = POLICY, onChange?: (s: unknown) => void) =>
  new LicenseService({ configDir, policy, now: () => now, onChange })

describe("验签", () => {
  it("正确签发的授权通过,字段原样读出", () => {
    const verified = verifyLicenseFile(license().text, POLICY.trustedKeys)
    expect(verified).toMatchObject({
      ok: true,
      license: { licenseId: "ORD-2026-0001", customerLabel: "测试客户 张工", signingKeyId: KEY.keyId },
    })
  })

  it("签名覆盖的是 payload 的原始字节:同一个对象换一种 JSON 写法就验不过", () => {
    const text = license().text
    const envelope = JSON.parse(text) as { payload: string; signature: string }
    const original = Buffer.from(envelope.payload, "base64url").toString("utf8")
    // 语义完全相同,只是多了空白。重新序列化过的内容不再是被签名的那串字节。
    const respaced = JSON.stringify(JSON.parse(original), null, 1)
    expect(JSON.parse(respaced)).toEqual(JSON.parse(original))
    const forged = JSON.stringify({ ...envelope, payload: Buffer.from(respaced).toString("base64url") })
    expect(verifyLicenseFile(forged, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-signature" })
  })

  it("改任何一个字段都验不过", () => {
    const text = license().text
    for (const mutate of [
      (p: Record<string, unknown>) => (p.expiresAt = iso(T0 + 3650 * DAY)),
      (p: Record<string, unknown>) => (p.customerLabel = "别人"),
      (p: Record<string, unknown>) => (p.licenseId = "ORD-2026-9999"),
      (p: Record<string, unknown>) => (p.notBefore = iso(T0 - 365 * DAY)),
    ]) {
      expect(verifyLicenseFile(tamper(text, mutate), POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-signature" })
    }
  })

  it("签名被改一个比特验不过", () => {
    const envelope = JSON.parse(license().text) as { payload: string; signature: string }
    const bytes = Buffer.from(envelope.signature, "base64url")
    bytes[10] = bytes[10]! ^ 0x01
    const text = JSON.stringify({ ...envelope, signature: bytes.toString("base64url") })
    expect(verifyLicenseFile(text, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-signature" })
  })

  it("未知公钥:别人的钥匙签的、即便编号写成可信的那个,也不认", () => {
    const stranger = signer("stranger-key")
    const foreign = issueLicense({
      privateKey: stranger.privateKey,
      keyId: stranger.keyId,
      licenseId: "ORD-X",
      customerLabel: "x",
      notBefore: iso(T0 - DAY),
      expiresAt: iso(T0 + DAY),
      issuedAt: iso(T0 - DAY),
    })
    expect(verifyLicenseFile(foreign.text, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "unknown-key" })

    // 冒用可信编号:选到的是真公钥,签名自然对不上。
    const impersonated = issueLicense({
      privateKey: stranger.privateKey,
      keyId: KEY.keyId,
      licenseId: "ORD-X",
      customerLabel: "x",
      notBefore: iso(T0 - DAY),
      expiresAt: iso(T0 + DAY),
      issuedAt: iso(T0 - DAY),
      overrides: {},
    })
    expect(verifyLicenseFile(impersonated.text, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-signature" })
  })

  it("客户文件里自带公钥不会变成可信公钥", () => {
    const stranger = signer("stranger-key")
    const foreign = issueLicense({
      privateKey: stranger.privateKey,
      keyId: stranger.keyId,
      licenseId: "ORD-X",
      customerLabel: "x",
      notBefore: iso(T0 - DAY),
      expiresAt: iso(T0 + DAY),
      issuedAt: iso(T0 - DAY),
    })
    const envelope = JSON.parse(foreign.text) as Record<string, unknown>
    // 外层多塞一个公钥字段:外层结构是白名单,直接拒。
    const withKey = JSON.stringify({ ...envelope, publicKey: stranger.trusted.publicKey, trustedKeys: [stranger.trusted] })
    expect(verifyLicenseFile(withKey, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-envelope" })
  })

  it("错误产品、不认识的格式版本:验签通过之后按字段拒", () => {
    const wrongProduct = license({ overrides: { product: "someone-elses-app" } })
    expect(verifyLicenseFile(wrongProduct.text, POLICY.trustedKeys)).toMatchObject({ ok: false, code: "wrong-product" })
    const futureSchema = license({ overrides: { schemaVersion: 2 } })
    expect(verifyLicenseFile(futureSchema.text, POLICY.trustedKeys)).toMatchObject({
      ok: false,
      code: "unsupported-version",
    })
  })

  it("真签名但字段不合规的授权同样被拒(类型、多余字段、日期关系)", () => {
    const signed = (payload: Record<string, unknown>) => {
      const bytes = Buffer.from(JSON.stringify(payload))
      return encodeLicenseFile(bytes, sign(null, bytes, KEY.privateKey))
    }
    const good = {
      schemaVersion: 1,
      product: LICENSE_PRODUCT,
      licenseId: "ORD-1",
      customerLabel: "c",
      issuedAt: iso(T0),
      notBefore: iso(T0),
      expiresAt: iso(T0 + DAY),
      signingKeyId: KEY.keyId,
    }
    expect(verifyLicenseFile(signed(good), POLICY.trustedKeys).ok).toBe(true)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...good, expiresAt: Date.now() }, "bad-field"],
      [{ ...good, expiresAt: "2026-10-20" }, "bad-field"],
      [{ ...good, expiresAt: "2026-10-20T00:00:00+08:00" }, "bad-field"],
      [{ ...good, notBefore: "2026-02-30T00:00:00Z" }, "bad-field"],
      [{ ...good, licenseId: "" }, "bad-field"],
      [{ ...good, customerLabel: 42 }, "bad-field"],
      [{ ...good, isPaid: true }, "bad-field"],
      [{ ...good, schemaVersion: "1" }, "unsupported-version"],
      [{ ...good, notBefore: iso(T0 + DAY), expiresAt: iso(T0) }, "bad-dates"],
      [{ ...good, notBefore: iso(T0), expiresAt: iso(T0) }, "bad-dates"],
      [{ ...good, issuedAt: iso(T0 + 2 * DAY) }, "bad-dates"],
    ]
    for (const [payload, code] of cases) {
      expect(verifyLicenseFile(signed(payload), POLICY.trustedKeys), JSON.stringify(payload)).toMatchObject({ ok: false, code })
    }
    const { expiresAt: _dropped, ...missing } = good
    expect(verifyLicenseFile(signed(missing), POLICY.trustedKeys)).toMatchObject({ ok: false, code: "bad-field" })
  })

  it("损坏与恶意输入给出可理解的错误码,不抛", () => {
    const good = license().text
    const envelope = JSON.parse(good) as Record<string, unknown>
    const cases: Array<[string | Uint8Array, string]> = [
      ["", "empty"],
      ["   \n", "empty"],
      ["not json at all", "not-json"],
      [good.slice(0, good.length / 2), "not-json"],
      ["[]", "bad-envelope"],
      ["null", "bad-envelope"],
      ['{"format":"something-else","version":1,"payload":"a","signature":"b"}', "bad-envelope"],
      [JSON.stringify({ ...envelope, version: 2 }), "unsupported-version"],
      [JSON.stringify({ ...envelope, payload: 5 }), "bad-envelope"],
      [JSON.stringify({ ...envelope, payload: "@@@not-base64@@@" }), "bad-encoding"],
      [JSON.stringify({ ...envelope, signature: "AAAA" }), "bad-signature"],
      [JSON.stringify({ ...envelope, payload: Buffer.from("[1,2,3]").toString("base64url") }), "bad-payload"],
      [JSON.stringify({ ...envelope, payload: Buffer.from("{not json").toString("base64url") }), "bad-payload"],
      [JSON.stringify({ ...envelope, payload: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url") }), "bad-payload"],
      [JSON.stringify({ ...envelope, payload: Buffer.from("{}").toString("base64url") }), "bad-field"],
      [new Uint8Array([0xff, 0xfe, 0x00, 0x01]), "not-json"],
      ["x".repeat(LICENSE_MAX_BYTES + 1), "too-large"],
      [new Uint8Array(LICENSE_MAX_BYTES + 1), "too-large"],
    ]
    for (const [input, code] of cases) {
      const result = verifyLicenseFile(input, POLICY.trustedKeys)
      expect(result, typeof input === "string" ? input.slice(0, 60) : "bytes").toMatchObject({ ok: false, code })
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it("带 BOM 的文件照常能导入(聊天软件另存出来的常见形态)", () => {
    expect(verifyLicenseFile(`﻿${license().text}`, POLICY.trustedKeys).ok).toBe(true)
  })

  it("可信名单为空:什么都验不过,错误码点名是构建配置的问题", () => {
    expect(verifyLicenseFile(license().text, [])).toMatchObject({ ok: false, code: "no-trusted-keys" })
  })

  it("可信公钥不是 Ed25519(比如误填了 RSA / 乱码):按配置错误拒,不放行", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }) as Buffer
    for (const publicKey of [rsa.toString("base64"), "AAAA", ""]) {
      expect(verifyLicenseFile(license().text, [{ id: KEY.keyId, publicKey }])).toMatchObject({
        ok: false,
        code: "no-trusted-keys",
      })
    }
  })

  it("parseUtcIso 只认严格的 UTC 写法", () => {
    expect(parseUtcIso("2026-09-20T04:00:00Z")).toBe(T0)
    expect(parseUtcIso("2026-09-20T04:00:00.000Z")).toBe(T0)
    for (const bad of ["2026-09-20T04:00:00", "2026-09-20 04:00:00Z", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", 5, null]) {
      expect(parseUtcIso(bad)).toBeUndefined()
    }
  })
})

describe("构建期策略", () => {
  it("没经过打包(没有注入)就是社区版:不强制", () => {
    expect(buildLicensePolicy()).toEqual(COMMUNITY_POLICY)
    const status = service(buildLicensePolicy()).status()
    expect(status).toMatchObject({ edition: "community", enforced: false, state: "not-required" })
    expect(() => service(buildLicensePolicy()).assertCanExecute("session.prompt")).not.toThrow()
  })

  it("注入内容坏了按「商业版 + 零可信公钥」处理:一律拦,不放行", () => {
    for (const broken of [
      null,
      "commercial",
      {},
      { edition: "paid" },
      { edition: "commercial" },
      { edition: "commercial", trustedKeys: [{ id: "k", publicKey: "AAAA" }] },
      { edition: "commercial", trustedKeys: [{ id: KEY.keyId, publicKey: "not-a-key" }] },
      { edition: "commercial", trustedKeys: [KEY.trusted, KEY.trusted] },
    ]) {
      const policy = normalizeLicensePolicy(broken)
      expect(policy, JSON.stringify(broken)).toEqual({ edition: "commercial", trustedKeys: [] })
      const blocked = new LicenseService({ configDir, policy, now: () => now })
      expect(() => blocked.assertCanExecute("session.prompt")).toThrow(LicenseRequiredError)
    }
    expect(normalizeLicensePolicy({ edition: "commercial", trustedKeys: [KEY.trusted] })).toEqual(POLICY)
    expect(normalizeLicensePolicy({ edition: "community", trustedKeys: [KEY.trusted] })).toEqual(COMMUNITY_POLICY)
  })
})

describe("状态与执行资格", () => {
  it("未激活 → 导入 → 已激活 → 到期 → 续费导入立即恢复,全程同一个服务实例", () => {
    const changes: string[] = []
    const svc = service(POLICY, (status) => changes.push((status as { state: string }).state))

    expect(svc.status().state).toBe("missing")
    expect(() => svc.assertCanExecute("session.prompt")).toThrow(LicenseRequiredError)

    const first = license({ notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 30 * DAY) })
    expect(svc.importText(first.text)).toMatchObject({ state: "active", license: { licenseId: "ORD-2026-0001" } })
    expect(() => svc.assertCanExecute("session.prompt")).not.toThrow()

    // 到期时间是不含的端点:差 1 毫秒还有效,到点即失效。
    now = T0 + 30 * DAY - 1
    expect(svc.status().state).toBe("active")
    now = T0 + 30 * DAY
    expect(svc.status().state).toBe("expired")
    try {
      svc.assertCanExecute("session.compact")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LicenseRequiredError)
      expect((error as LicenseRequiredError).data).toMatchObject({
        _tag: "LicenseRequiredError",
        state: "expired",
        execution: "session.compact",
        expiresAt: iso(T0 + 30 * DAY),
      })
    }

    // 续费:沿用 licenseId,新的到期日。导入后不重建任何东西,下一次检查就过。
    const renewal = license({ notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 60 * DAY), issuedAt: iso(now) })
    expect(svc.importText(renewal.text)).toMatchObject({ state: "active", license: { licenseId: "ORD-2026-0001" } })
    expect(() => svc.assertCanExecute("session.prompt")).not.toThrow()
    expect(changes).toEqual(["active", "expired", "active"])
  })

  it("另一个进程写入的续费授权,下一次检查就看得见(不缓存)", () => {
    const paused = service()
    paused.importText(license({ expiresAt: iso(T0 + DAY) }).text)
    now = T0 + 2 * DAY
    expect(paused.check("bench.turn")).toMatchObject({ ok: false, data: { state: "expired" } })

    // 模拟桌面内核那个进程导入续费:另一个服务实例,同一个 configDir。
    new LicenseService({ configDir, policy: POLICY, now: () => now }).importText(
      license({ expiresAt: iso(T0 + 40 * DAY), issuedAt: iso(now) }).text,
    )
    expect(paused.check("bench.turn")).toEqual({ ok: true })
  })

  it("未来才生效的授权:状态是 not-yet-valid,不能执行,到点自动变有效", () => {
    const svc = service()
    svc.importText(license({ notBefore: iso(T0 + DAY), expiresAt: iso(T0 + 31 * DAY) }).text)
    expect(svc.status().state).toBe("not-yet-valid")
    expect(svc.check("session.prompt")).toMatchObject({ ok: false, data: { state: "not-yet-valid", notBefore: iso(T0 + DAY) } })
    now = T0 + DAY
    expect(svc.check("session.prompt")).toEqual({ ok: true })
  })

  it("盘上的授权文件被改坏 / 换成大文件 / 换成目录:状态是 invalid,执行被拦,不抛别的错", () => {
    const svc = service()
    svc.importText(license().text)
    const file = licenseFilePath(configDir)

    writeFileSync(file, tamper(readFileSync(file, "utf8"), (p) => (p.expiresAt = iso(T0 + 9999 * DAY))))
    expect(svc.status()).toMatchObject({ state: "invalid", error: { code: "bad-signature" } })
    expect(svc.check("session.prompt")).toMatchObject({ ok: false, data: { state: "invalid" } })

    writeFileSync(file, "x".repeat(LICENSE_MAX_BYTES * 4))
    expect(svc.status()).toMatchObject({ state: "invalid", error: { code: "too-large" } })

    writeFileSync(file, "")
    expect(svc.status()).toMatchObject({ state: "invalid", error: { code: "empty" } })
  })
})

describe("导入规则", () => {
  it("无效导入不覆盖原有有效授权:盘上字节不变,状态不变", () => {
    const svc = service()
    svc.importText(license().text)
    const file = licenseFilePath(configDir)
    const before = readFileSync(file)

    const stranger = signer("stranger-key")
    const rejected: Array<[string, string]> = [
      ["garbage", "not-json"],
      [tamper(license().text, (p) => (p.expiresAt = iso(T0 + 999 * DAY))), "bad-signature"],
      [license({ overrides: { product: "other" } }).text, "wrong-product"],
      [license({ notBefore: iso(T0 - 60 * DAY), expiresAt: iso(T0 - 30 * DAY), issuedAt: iso(T0 - 61 * DAY) }).text, "expired"],
      [license({ notBefore: iso(T0 + 10 * DAY), expiresAt: iso(T0 + 40 * DAY) }).text, "not-yet-valid"],
      [license({ expiresAt: iso(T0 + 5 * DAY) }).text, "older-than-current"],
      [
        issueLicense({
          privateKey: stranger.privateKey,
          keyId: stranger.keyId,
          licenseId: "ORD-X",
          customerLabel: "x",
          notBefore: iso(T0 - DAY),
          expiresAt: iso(T0 + 999 * DAY),
          issuedAt: iso(T0 - DAY),
        }).text,
        "unknown-key",
      ],
      ["x".repeat(LICENSE_MAX_BYTES + 1), "too-large"],
    ]
    for (const [text, code] of rejected) {
      try {
        svc.importText(text)
        expect.unreachable(`应当拒绝:${code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(LicenseImportError)
        expect((error as LicenseImportError).data).toEqual({ _tag: "LicenseImportError", code })
      }
      expect(readFileSync(file).equals(before), code).toBe(true)
      expect(svc.status().state).toBe("active")
    }
    // 没有留下临时文件。
    expect(readdirSync(configDir)).toEqual(["license.json"])
  })

  it("同一份文件重复导入是 no-op;没有有效授权时,未来生效的可以先放进去", () => {
    const svc = service()
    const text = license().text
    svc.importText(text)
    expect(svc.importText(text).state).toBe("active")

    const fresh = new LicenseService({ configDir: mkdtempSync(path.join(tmpdir(), "yoma-license-")), policy: POLICY, now: () => now })
    expect(fresh.importText(license({ notBefore: iso(T0 + DAY), expiresAt: iso(T0 + 31 * DAY) }).text).state).toBe("not-yet-valid")
  })

  it("过期之后导入续费授权:替换掉旧文件", () => {
    const svc = service()
    svc.importText(license({ expiresAt: iso(T0 + DAY) }).text)
    now = T0 + 3 * DAY
    const renewed = svc.importText(license({ expiresAt: iso(T0 + 33 * DAY), issuedAt: iso(now) }).text)
    expect(renewed).toMatchObject({ state: "active", license: { expiresAt: iso(T0 + 33 * DAY) } })
  })

  it("授权文件独立于 auth.json:导入不碰它,configDir 不存在时自己建", () => {
    const nested = path.join(configDir, "fresh", "dir")
    const svc = new LicenseService({ configDir: nested, policy: POLICY, now: () => now })
    writeFileSync(path.join(configDir, "auth.json"), '{"deepseek":{"type":"api_key","key":"sk-secret"}}')
    svc.importText(license().text)
    expect(existsSync(path.join(nested, "license.json"))).toBe(true)
    expect(readFileSync(path.join(configDir, "auth.json"), "utf8")).toContain("sk-secret")
    expect(readFileSync(path.join(nested, "license.json"), "utf8")).not.toContain("sk-secret")
  })

  it("社区版不收授权文件(没有可信公钥),说清楚原因", () => {
    expect(() => service(COMMUNITY_POLICY).importText(license().text)).toThrow(/社区/)
  })
})

describe("离线与边界", () => {
  it("验签、导入、检查全程不碰网络", () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("授权检查不该联网")
    })
    const lookup = vi.spyOn(dns, "lookup").mockImplementation((() => {
      throw new Error("授权检查不该解析域名")
    }) as never)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("授权检查不该 fetch")
    })
    try {
      const svc = service()
      expect(svc.importText(license().text).state).toBe("active")
      expect(svc.check("session.prompt")).toEqual({ ok: true })
      now = T0 + 400 * DAY
      expect(svc.check("session.prompt").ok).toBe(false)
      expect(connect).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
      lookup.mockRestore()
      fetchSpy.mockRestore()
    }
  })

  it("本目录是叶子模块:只依赖 node 内建与 license-view,没有签发能力", () => {
    const dir = import.meta.dirname
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
      const source = readFileSync(path.join(dir, name), "utf8")
      const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]!)
      for (const specifier of specifiers) {
        const allowed =
          /^node:(crypto|fs|os|path)$/.test(specifier) ||
          specifier === "../../license-view.ts" ||
          /^\.\/(format|policy|store|service)\.ts$/.test(specifier)
        expect(allowed, `${name} import 了 ${specifier}`).toBe(true)
      }
      // 产品代码里不许出现签名 / 造密钥的调用。
      expect(source, name).not.toMatch(/\bgenerateKeyPair(Sync)?\b|\bcreatePrivateKey\b|\bcreateSign\b/)
      expect(source.replace(/\bverify\(/g, ""), name).not.toMatch(/(^|[^A-Za-z.])sign\(/)
    }
  })

  it("默认目录与内核的 yomaConfigDir() 同解(副本防漂移)", () => {
    expect(defaultLicenseConfigDir()).toBe(yomaConfigDir())
  })

  it("诊断信息不含秘密:没有购买人称呼、没有 payload / signature 原文、没有 auth.json 的内容", () => {
    writeFileSync(path.join(configDir, "auth.json"), '{"deepseek":{"type":"api_key","key":"sk-very-secret"}}')
    const svc = service()
    const issued = license()
    svc.importText(issued.text)
    const envelope = JSON.parse(issued.text) as { payload: string; signature: string }
    const text = svc.diagnostics({ appVersion: "9.9.9" })
    expect(text).toContain("ORD-2026-0001")
    expect(text).toContain("9.9.9")
    expect(text).toContain("active")
    expect(text).not.toContain("sk-very-secret")
    expect(text).not.toContain("张工")
    expect(text).not.toContain(envelope.payload)
    expect(text).not.toContain(envelope.signature)
  })
})
