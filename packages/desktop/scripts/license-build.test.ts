/**
 * 构建期注入的闸门测试。
 *
 * 这里钉的全是"不这么做就会出一个坏包"的规矩:产品只有要授权的那一种 —— 给了公钥就强制检查,
 * 没有任何一种环境变量或注入形状能出一个"不检查"的包;没给公钥的是开发构建,什么都不注入
 * (它过不了打包前的产物检查,见 verify-commercial-artifact.test.ts);测试密钥不许进正式信任配置。
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
  LICENSE_BUILD_DEFINE_NAME,
  TRUST_FILE_ENV,
  TRUST_JSON_ENV,
  describeLicenseBuild,
  licenseDefine,
  missingTrustHelp,
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
// 没给公钥 = 开发构建
// ---------------------------------------------------------------------------

test("两个来源都没给(未设 / 空串)= 开发构建:什么都不注入", () => {
  for (const raw of [undefined, "", "   "]) {
    // CI 里没配 repository variable 时 `${{ vars.YOMA_LICENSE_TRUST_JSON }}` 展开出来正是空串 ——
    // 它必须与"未设"同解,否则 ci 岗(只 build 不出包)会被一行 workflow env 打红。
    const config = resolveLicenseBuild({ [TRUST_FILE_ENV]: raw, [TRUST_JSON_ENV]: raw })
    expect(config).toBeUndefined()
    expect(licenseDefine(config)).toEqual({})
  }
})

test("没有版本开关:YOMA_EDITION 之类的变量一个字都不读", () => {
  const body = JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey: ed25519PublicKeyB64() }] })
  // 给了公钥就是强制检查,写 community 也关不掉;
  expect(resolveLicenseBuild({ YOMA_EDITION: "community", [TRUST_JSON_ENV]: body })?.trustedKeys).toHaveLength(1)
  // 没给公钥就是开发构建,写 commercial 也变不出一份"零公钥的正式包"。
  expect(resolveLicenseBuild({ YOMA_EDITION: "commercial" })).toBeUndefined()
})

test("出包缺公钥时给人看的话里带着怎么做", () => {
  const message = missingTrustHelp()
  expect(message).toContain(TRUST_FILE_ENV)
  expect(message).toContain(TRUST_JSON_ENV)
  expect(message).toContain("license -- keygen")
  expect(message).toContain("docs/licensing.md")
})

test("公钥可以来自文件,也可以来自内联 JSON;多余字段忽略", () => {
  const publicKey = ed25519PublicKeyB64()
  const body = { trustedKeys: [{ id: KEY_ID, publicKey, fingerprint: fingerprintOf(publicKey), note: "备份在保险箱" }] }

  const fromFile = resolveLicenseBuild({ [TRUST_FILE_ENV]: trustFile(body) })
  const fromJson = resolveLicenseBuild({ [TRUST_JSON_ENV]: JSON.stringify(body) })

  expect(fromFile).toEqual({ trustedKeys: [{ id: KEY_ID, publicKey }] })
  expect(fromJson).toEqual(fromFile)
})

test("文件与内联 JSON 同时给 → 抛(其中一份必然是忘了清的旧配置)", () => {
  const publicKey = ed25519PublicKeyB64()
  const body = { trustedKeys: [{ id: KEY_ID, publicKey }] }
  expect(() =>
    resolveLicenseBuild({
      [TRUST_FILE_ENV]: trustFile(body),
      [TRUST_JSON_ENV]: JSON.stringify(body),
    }),
  ).toThrow(/同时给/)
})

// ---------------------------------------------------------------------------
// 逐把公钥的校验
// ---------------------------------------------------------------------------

test("测试前缀的公钥编号不进正式信任配置;allowTestKeys 只是函数参数", () => {
  for (const id of ["test-key", "e2e.sign", "dev_key1", "demo-2026", "tmp-key", "sample-key", "example-key"]) {
    const env = { [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id, publicKey: ed25519PublicKeyB64() }] }) }
    expect(() => resolveLicenseBuild(env)).toThrow(/测试前缀/)
    // e2e 往临时目录打商业产物时靠这个参数放行 —— 它没有对应的环境变量,
    // 正式打包管线走 resolveLicenseBuild(process.env) 拿不到它。
    expect(resolveLicenseBuild(env, { allowTestKeys: true })?.trustedKeys[0]!.id).toBe(id)
  }
})

test("编号不合规、RSA 公钥、乱码、空数组、缺字段 → 全抛", () => {
  const commercial = (trustedKeys: unknown) => ({
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
    resolveLicenseBuild({ [TRUST_JSON_ENV]: "{not json" }),
  ).toThrow(/不是合法 JSON/)
  expect(() =>
    resolveLicenseBuild({ [TRUST_FILE_ENV]: path.join(tmpdir(), "yoma-no-such.trust.json") }),
  ).toThrow(/读不出来/)
})

test("重复编号 → 抛(按编号选公钥,重复了说不清哪一把生效)", () => {
  const first = ed25519PublicKeyB64()
  const second = ed25519PublicKeyB64()
  expect(() =>
    resolveLicenseBuild({
      [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey: first }, { id: KEY_ID, publicKey: second }] }),
    }),
  ).toThrow(/重复/)
})

test("多把不同编号的公钥可以共存 —— 换签名密钥期间两把都要认", () => {
  const keys = [
    { id: "yoma-official-20260920", publicKey: ed25519PublicKeyB64() },
    { id: "yoma-official-20270101", publicKey: ed25519PublicKeyB64() },
  ]
  const resolved = resolveLicenseBuild({ [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: keys }) })
  expect(resolved?.trustedKeys).toEqual(keys)
})

// ---------------------------------------------------------------------------
// define 与消费侧同解
// ---------------------------------------------------------------------------

test("注入出去的 define 能被 normalizeLicensePolicy 读回同一份策略", () => {
  const keys = [
    { id: "yoma-official-20260920", publicKey: ed25519PublicKeyB64() },
    { id: "yoma-official-20270101", publicKey: ed25519PublicKeyB64() },
  ]
  const config = resolveLicenseBuild({ [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: keys }) })
  const define = licenseDefine(config)

  expect(Object.keys(define)).toEqual([LICENSE_BUILD_DEFINE_NAME])
  // 产物里 `__YOMA_LICENSE_BUILD__` 被替换成的就是这一串;运行期 policy.ts 拿到它。
  const policy = normalizeLicensePolicy(JSON.parse(define[LICENSE_BUILD_DEFINE_NAME]!))
  expect(policy).toEqual({ enforced: true, trustedKeys: keys })
  // 注入的形状里只有公钥:没有 edition、没有 enforced,也就没有可被改成"不检查"的那个字段。
  expect(Object.keys(JSON.parse(define[LICENSE_BUILD_DEFINE_NAME]!))).toEqual(["trustedKeys"])

  // 顺序固定 id → publicKey:产物检查按 `{id:…,publicKey:…}` 这个相邻关系把公钥抠回来。
  expect(define[LICENSE_BUILD_DEFINE_NAME]).toContain(`{"id":"${keys[0]!.id}","publicKey":"${keys[0]!.publicKey}"}`)
})

test("构建日志印出每把公钥的指纹(拿去和签发端的备份核对)", () => {
  const publicKey = ed25519PublicKeyB64()
  const enforced = resolveLicenseBuild({
    [TRUST_JSON_ENV]: JSON.stringify({ trustedKeys: [{ id: KEY_ID, publicKey }] }),
  })
  const described = describeLicenseBuild(enforced)
  expect(described).toContain("强制检查授权")
  expect(described).toContain(KEY_ID)
  expect(described).toContain(fingerprintOf(publicKey))
  // 指纹是 SPKI DER 的 SHA-256,不是公钥本身 —— 印错了核对就是空转。
  expect(fingerprintOf(publicKey)).toMatch(/^[0-9a-f]{64}$/)

  // 开发构建的那句话必须说清两件事:不检查授权、打不成安装包。
  const dev = describeLicenseBuild(resolveLicenseBuild({}))
  expect(dev).toContain("开发构建")
  expect(dev).toContain("不检查授权")
  expect(dev).toContain("打不成安装包")
})
