/**
 * 构建期注入的闸门测试。
 *
 * 这里钉的全是"不这么做就会出一个坏包"的规矩:商业构建没公钥必须**失败**而不是放行;
 * 测试密钥不许进正式信任配置;社区构建给了信任来源要当成配置错误说出来。
 * 最后一条反过来钉:正常路径注入出去的东西,`normalizeLicensePolicy` 读回来必须是同一份策略 ——
 * 注入与消费两侧任何一边改了形状,这条就红。
 */

import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"

import { normalizeLicensePolicy } from "../../kernel/src/host/licensing/policy.ts"
import { fingerprintOf } from "../../../scripts/license/lib.ts"
import {
  EDITION_ENV,
  LICENSE_BUILD_DEFINE_NAME,
  TRUST_FILE_ENV,
  TRUST_JSON_ENV,
  describeLicenseBuild,
  licenseDefine,
  resolveLicenseBuild,
} from "./license-build.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ed25519PublicKeyB64(): string {
  const { publicKey } = generateKeyPairSync("ed25519")
  return (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64")
}

function rsaPublicKeyB64(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64")
}

/** 写一份 trust.json 到临时目录,返回路径。 */
function trustFile(body: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-license-build-"))
  dirs.push(dir)
  const file = path.join(dir, "keys.trust.json")
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
  return file
}

const KEY_ID = "yoma-official-20260920"

// ---------------------------------------------------------------------------
// edition
// ---------------------------------------------------------------------------

test("未设 / 空串 / community 都是社区构建,不检查授权", () => {
  for (const raw of [undefined, "", "   ", "community"]) {
    // CI 里没配 repository variable 时 `${{ vars.YOMA_EDITION }}` 展开出来正是空串 ——
    // 它必须与"未设"同解,否则加一行 workflow env 就把所有社区构建打红了。
    expect(resolveLicenseBuild({ [EDITION_ENV]: raw })).toEqual({ edition: "community", trustedKeys: [] })
  }
})

test("认不出的 edition 直接抛,不猜", () => {
  expect(() => resolveLicenseBuild({ [EDITION_ENV]: "pro" })).toThrow(/不认识/)
  // 大小写不当成同义:YOMA_EDITION=Commercial 若被当成商业版,少给公钥时的报错会指向别处。
  expect(() => resolveLicenseBuild({ [EDITION_ENV]: "Commercial" })).toThrow(/不认识/)
})

// ---------------------------------------------------------------------------
// 商业构建的硬要求
// ---------------------------------------------------------------------------

test("商业构建没有可信公钥 → 构建失败,而且话里带着怎么做", () => {
  let message = ""
  try {
    resolveLicenseBuild({ [EDITION_ENV]: "commercial" })
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toContain(TRUST_FILE_ENV)
  expect(message).toContain(TRUST_JSON_ENV)
  expect(message).toContain("license -- keygen")
  expect(message).toContain("docs/licensing.md")
})

test("公钥可以来自文件,也可以来自内联 JSON;多余字段忽略", () => {
  const publicKey = ed25519PublicKeyB64()
  const body = { trustedKeys: [{ id: KEY_ID, publicKey, fingerprint: fingerprintOf(publicKey), note: "备份在保险箱" }] }

  const fromFile = resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_FILE_ENV]: trustFile(body) })
  const fromJson = resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_JSON_ENV]: JSON.stringify(body) })

  expect(fromFile).toEqual({ edition: "commercial", trustedKeys: [{ id: KEY_ID, publicKey }] })
  expect(fromJson).toEqual(fromFile)
})

test("文件与内联 JSON 同时给 → 抛(其中一份必然是忘了清的旧配置)", () => {
  const publicKey = ed25519PublicKeyB64()
  const body = { trustedKeys: [{ id: KEY_ID, publicKey }] }
  expect(() =>
    resolveLicenseBuild({
      [EDITION_ENV]: "commercial",
      [TRUST_FILE_ENV]: trustFile(body),
      [TRUST_JSON_ENV]: JSON.stringify(body),
    }),
  ).toThrow(/同时给/)
})

test("社区构建却给了信任来源 → 抛,不静默忽略", () => {
  const body = JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey: ed25519PublicKeyB64() }] })
  // 忘了 YOMA_EDITION=commercial 是最容易犯的一次错,而它的静默后果是"打出一个谁都能用的商业包"。
  expect(() => resolveLicenseBuild({ [TRUST_JSON_ENV]: body })).toThrow(/忘了 YOMA_EDITION=commercial/)
  expect(() => resolveLicenseBuild({ [EDITION_ENV]: "community", [TRUST_FILE_ENV]: trustFile(JSON.parse(body)) })).toThrow(
    /忘了 YOMA_EDITION=commercial/,
  )
})

// ---------------------------------------------------------------------------
// 逐把公钥的校验
// ---------------------------------------------------------------------------

test("测试前缀的公钥编号不进正式信任配置;allowTestKeys 只是函数参数", () => {
  for (const id of ["test-key", "e2e.sign", "dev_key1", "demo-2026", "tmp-key", "sample-key", "example-key"]) {
    const env = { [EDITION_ENV]: "commercial", [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id, publicKey: ed25519PublicKeyB64() }] }) }
    expect(() => resolveLicenseBuild(env)).toThrow(/测试前缀/)
    // e2e 往临时目录打商业产物时靠这个参数放行 —— 它没有对应的环境变量,
    // 正式打包管线走 resolveLicenseBuild(process.env) 拿不到它。
    expect(resolveLicenseBuild(env, { allowTestKeys: true }).trustedKeys[0]!.id).toBe(id)
  }
})

test("编号不合规、RSA 公钥、乱码、空数组、缺字段 → 全抛", () => {
  const commercial = (trustedKeys: unknown) => ({
    [EDITION_ENV]: "commercial",
    [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys }),
  })
  const publicKey = ed25519PublicKeyB64()

  expect(() => resolveLicenseBuild(commercial([{ id: "YOMA-OFFICIAL", publicKey }]))).toThrow(/不合法/)
  expect(() => resolveLicenseBuild(commercial([{ id: "ab", publicKey }]))).toThrow(/不合法/)
  // RSA 能过 base64 与 SPKI 解析,只有"是不是 Ed25519"这一关拦得住它。
  expect(() => resolveLicenseBuild(commercial([{ id: KEY_ID, publicKey: rsaPublicKeyB64() }]))).toThrow(/Ed25519/)
  expect(() => resolveLicenseBuild(commercial([{ id: KEY_ID, publicKey: "这不是 base64" }]))).toThrow(/Ed25519/)
  expect(() => resolveLicenseBuild(commercial([{ id: KEY_ID, publicKey: "" }]))).toThrow(/Ed25519/)
  expect(() => resolveLicenseBuild(commercial([{ id: KEY_ID }]))).toThrow(/缺 id 或 publicKey/)
  expect(() => resolveLicenseBuild(commercial([]))).toThrow(/空数组/)
  expect(() => resolveLicenseBuild(commercial("nope"))).toThrow(/trustedKeys/)
  expect(() =>
    resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_JSON_ENV]: "{not json" }),
  ).toThrow(/不是合法 JSON/)
  expect(() =>
    resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_FILE_ENV]: path.join(tmpdir(), "yoma-no-such.trust.json") }),
  ).toThrow(/读不出来/)
})

test("重复编号 → 抛(按编号选公钥,重复了说不清哪一把生效)", () => {
  const first = ed25519PublicKeyB64()
  const second = ed25519PublicKeyB64()
  expect(() =>
    resolveLicenseBuild({
      [EDITION_ENV]: "commercial",
      [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey: first }, { id: KEY_ID, publicKey: second }] }),
    }),
  ).toThrow(/重复/)
})

test("多把不同编号的公钥可以共存 —— 换签名密钥期间两把都要认", () => {
  const keys = [
    { id: "yoma-official-20260920", publicKey: ed25519PublicKeyB64() },
    { id: "yoma-official-20270101", publicKey: ed25519PublicKeyB64() },
  ]
  const resolved = resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: keys }) })
  expect(resolved.trustedKeys).toEqual(keys)
})

// ---------------------------------------------------------------------------
// define 与消费侧同解
// ---------------------------------------------------------------------------

test("注入出去的 define 能被 normalizeLicensePolicy 读回同一份策略", () => {
  const keys = [
    { id: "yoma-official-20260920", publicKey: ed25519PublicKeyB64() },
    { id: "yoma-official-20270101", publicKey: ed25519PublicKeyB64() },
  ]
  const config = resolveLicenseBuild({ [EDITION_ENV]: "commercial", [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: keys }) })
  const define = licenseDefine(config)

  expect(Object.keys(define)).toEqual([LICENSE_BUILD_DEFINE_NAME])
  // 产物里 `__YOMA_LICENSE_BUILD__` 被替换成的就是这一串;运行期 policy.ts 拿到它。
  const policy = normalizeLicensePolicy(JSON.parse(define[LICENSE_BUILD_DEFINE_NAME]!))
  expect(policy).toEqual({ edition: "commercial", trustedKeys: keys })

  // 顺序固定 id → publicKey:产物检查按 `{id:…,publicKey:…}` 这个相邻关系把公钥抠回来。
  expect(define[LICENSE_BUILD_DEFINE_NAME]).toContain(`{"id":"${keys[0]!.id}","publicKey":"${keys[0]!.publicKey}"}`)
})

test("社区构建也注入,而且与「根本没注入」同解", () => {
  const define = licenseDefine(resolveLicenseBuild({}))
  const policy = normalizeLicensePolicy(JSON.parse(define[LICENSE_BUILD_DEFINE_NAME]!))
  // COMMUNITY_POLICY 的形状:不强制,零可信公钥。
  expect(policy).toEqual({ edition: "community", trustedKeys: [] })
})

test("构建日志印出版本与每把公钥的指纹(拿去和签发端的备份核对)", () => {
  const publicKey = ed25519PublicKeyB64()
  const commercial = resolveLicenseBuild({
    [EDITION_ENV]: "commercial",
    [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey }] }),
  })
  const described = describeLicenseBuild(commercial)
  expect(described).toContain("商业构建")
  expect(described).toContain(KEY_ID)
  expect(described).toContain(fingerprintOf(publicKey))
  // 指纹是 SPKI DER 的 SHA-256,不是公钥本身 —— 印错了核对就是空转。
  expect(fingerprintOf(publicKey)).toMatch(/^[0-9a-f]{64}$/)

  expect(describeLicenseBuild(resolveLicenseBuild({}))).toContain("不检查授权")
})
