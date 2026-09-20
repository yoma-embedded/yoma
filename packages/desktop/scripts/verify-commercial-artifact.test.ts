/**
 * 产物检查的闸门测试 —— 用临时目录里的**假产物**逐条钉。
 *
 * 为什么要有这些用例:这个脚本自己就是一道闸门,而闸门最危险的失效方式是"永远通过"。
 * 每一条都造一份真的会出事的产物(社区包、混进私钥、公钥换成别人的、少一个入口、
 * 编号是测试前缀),断言它**被抓住**;再造一份干净的,断言它过。
 */

import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"

import { licenseDefine } from "./license-build.ts"
import {
  REQUIRED_MAIN_ARTIFACTS,
  collectTextFiles,
  extractInjectedPolicies,
  findEd25519PublicKeys,
  resolveEntryGraph,
  verifyCommercialArtifact,
  verifyEntrySources,
  type ScannedFile,
} from "./verify-commercial-artifact.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function key(id: string): { id: string; publicKey: string } {
  const { publicKey } = generateKeyPairSync("ed25519")
  return { id, publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64") }
}

const OFFICIAL = key("yoma-official-20260920")

/** 产物里 `__YOMA_LICENSE_BUILD__` 被替换之后长什么样(两次出现,typeof 那一句的两侧)。 */
function bakedSource(keys: { id: string; publicKey: string }[], edition: "commercial" | "community" = "commercial"): string {
  const literal = licenseDefine({ edition, trustedKeys: keys })["__YOMA_LICENSE_BUILD__"]!
  return `var baked = typeof ${literal} === "undefined" ? void 0 : ${literal};\nfunction run(){return baked}\n`
}

function artifacts(keys = [OFFICIAL], edition: "commercial" | "community" = "commercial"): ScannedFile[] {
  return REQUIRED_MAIN_ARTIFACTS.map((name) => ({ path: `out/${name}`, text: bakedSource(keys, edition) }))
}

const CLEAN_ENTRIES: ScannedFile[] = [
  { path: "kernel-entry.ts", text: "createKernelHost({ sessionsRoot, confirmTools: true })" },
  { path: "turn-entry.ts", text: "await runTurn(input)" },
  { path: "host-entry.ts", text: "await runMailboxHost(config, emit)" },
]

// ---------------------------------------------------------------------------
// 抠注入
// ---------------------------------------------------------------------------

test("打包器怎么改写字面量都抠得出来:带引号、不带引号、单引号", () => {
  const quoted = `{"edition":"commercial","trustedKeys":[{"id":"${OFFICIAL.id}","publicKey":"${OFFICIAL.publicKey}"}]}`
  const bare = `{edition:"commercial",trustedKeys:[{id:"${OFFICIAL.id}",publicKey:"${OFFICIAL.publicKey}"}]}`
  const single = `{edition:'commercial',trustedKeys:[{id:'${OFFICIAL.id}',publicKey:'${OFFICIAL.publicKey}'}]}`
  for (const literal of [quoted, bare, single]) {
    const policies = extractInjectedPolicies(`var x = ${literal};`)
    expect(policies).toHaveLength(1)
    expect(policies[0]).toEqual({ edition: "commercial", trustedKeys: [OFFICIAL] })
  }
})

test("Ed25519 公钥按 SPKI 前缀全文抠,所以名单之外多出来的那一把也躲不掉", () => {
  const stray = key("whoever")
  const source = `${bakedSource([OFFICIAL])}\nvar backdoor = "${stray.publicKey}";`
  expect(findEd25519PublicKeys(source).sort()).toEqual([OFFICIAL.publicKey, stray.publicKey].sort())

  const files = REQUIRED_MAIN_ARTIFACTS.map((name) => ({ path: `out/${name}`, text: name === "main/kernel.js" ? source : bakedSource([OFFICIAL]) }))
  const report = verifyCommercialArtifact(files, { expectedKeys: [OFFICIAL] })
  expect(report.ok).toBe(false)
  expect(evidenceOf(report)).toMatch(/信任名单之外还有 1 把 Ed25519 公钥/)
})

// ---------------------------------------------------------------------------
// 入口 + chunk
// ---------------------------------------------------------------------------

test("注入落在共享 chunk 里也算数 —— 真实构建就是这样(electron-vite 拆 chunk)", () => {
  // out/main/index.js 与 kernel.js 都只 import 那个共享块,策略的字面量在块里。
  const chunk = { path: "main/chunks/shared-abc123.js", text: bakedSource([OFFICIAL]) }
  const files: ScannedFile[] = [
    { path: "main/index.js", text: 'import { run } from "./chunks/shared-abc123.js";\nrun();' },
    { path: "main/kernel.js", text: 'import { run } from "./chunks/shared-abc123.js";\nrun();' },
    { path: "main/mailbox-host.mjs", text: bakedSource([OFFICIAL]) },
    { path: "main/mailbox-turn-entry.mjs", text: bakedSource([OFFICIAL]) },
    chunk,
  ]
  const graph = resolveEntryGraph("main/index.js", files)
  expect(graph?.parts).toEqual(["main/index.js", "main/chunks/shared-abc123.js"])

  const report = verifyCommercialArtifact(files, { expectedKeys: [OFFICIAL] })
  expect(evidenceOf(report)).toContain("连同 1 个 chunk")
  expect(report.ok).toBe(true)

  // 而 chunk 不在的时候(入口没吃到注入)照样红 —— 图解析不是"反正能找到就算过"。
  const withoutChunk = files.filter((file) => file !== chunk)
  expect(verifyCommercialArtifact(withoutChunk, { expectedKeys: [OFFICIAL] }).ok).toBe(false)
})

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test("四个产物、commercial、公钥与 trust-file 逐把一致 → 通过", () => {
  const report = verifyCommercialArtifact(artifacts(), { expectedKeys: [OFFICIAL], expectedKeysSource: "--trust-file k.json" })
  expect(report.ok).toBe(true)
  expect(evidenceOf(report)).toContain("逐把一致")
  // 指纹要印出来:没给 trust-file 的时候人工核对靠的就是这几行。
  expect(evidenceOf(report)).toMatch(/指纹 [0-9a-f]{64}/)
})

test("没给期望公钥时只核四个产物互相一致,并说清「这次没核过公钥」", () => {
  const report = verifyCommercialArtifact(artifacts())
  expect(report.ok).toBe(true)
  expect(evidenceOf(report)).toContain("没给 --trust-file")

  // 其中一个产物换成另一把公钥 —— 横向一致这一条抓得住。
  const mixed = artifacts()
  mixed[2] = { path: mixed[2]!.path, text: bakedSource([key("yoma-official-20270101")]) }
  const broken = verifyCommercialArtifact(mixed)
  expect(broken.ok).toBe(false)
  expect(evidenceOf(broken)).toMatch(/不是同一套/)
})

// ---------------------------------------------------------------------------
// 每一条不合格的产物
// ---------------------------------------------------------------------------

test("社区产物被判不合格", () => {
  const report = verifyCommercialArtifact(artifacts([], "community"))
  expect(report.ok).toBe(false)
  expect(evidenceOf(report)).toMatch(/这是社区构建的产物/)
})

test("policy.ts 自己源码里的同形字面量不算注入(否则真商业产物会被误判)", () => {
  // 真产物里一定有这两段:COMMUNITY_POLICY 与 fail-closed 的那一份,都是"带 edition、不带公钥"。
  const sourceLiterals =
    'var COMMUNITY_POLICY = Object.freeze({ edition: "community", trustedKeys: Object.freeze([]) });\n' +
    'function normalize(c){ const failClosed = { edition: "commercial", trustedKeys: [] }; return failClosed }\n'
  const files = REQUIRED_MAIN_ARTIFACTS.map((name) => ({ path: `out/${name}`, text: sourceLiterals + bakedSource([OFFICIAL]) }))
  const report = verifyCommercialArtifact(files, { expectedKeys: [OFFICIAL] })
  expect(report.ok).toBe(true)

  // 反过来:只有那两段源码字面量、没有注入 → 社区构建,判不合格。
  const community = REQUIRED_MAIN_ARTIFACTS.map((name) => ({ path: `out/${name}`, text: sourceLiterals }))
  expect(verifyCommercialArtifact(community).ok).toBe(false)
})

test("少一个入口吃到注入就不合格 —— 少的那一个就是绕过授权的路", () => {
  const report = verifyCommercialArtifact(artifacts().slice(0, 3), { expectedKeys: [OFFICIAL] })
  expect(report.ok).toBe(false)
  expect(evidenceOf(report)).toMatch(/找不到产物 main\/mailbox-turn-entry\.mjs/)

  // 文件在,但里面没有注入(define 没接上那个入口)。
  const noDefine = artifacts()
  noDefine[1] = { path: noDefine[1]!.path, text: "console.log('hello')" }
  const report2 = verifyCommercialArtifact(noDefine, { expectedKeys: [OFFICIAL] })
  expect(report2.ok).toBe(false)
  expect(evidenceOf(report2)).toMatch(/main\/index\.js:找不到/)
})

test("公钥与 trust-file 不符 → 抓住,而且把期望与实得都印出来", () => {
  const theirs = key("someone-else")
  const report = verifyCommercialArtifact(artifacts([theirs]), {
    expectedKeys: [OFFICIAL],
    expectedKeysSource: "--trust-file official.json",
  })
  expect(report.ok).toBe(false)
  const evidence = evidenceOf(report)
  expect(evidence).toMatch(/与期望不符/)
  expect(evidence).toContain(OFFICIAL.id)
  expect(evidence).toContain(theirs.id)
})

test("测试前缀的公钥编号进了正式包 → 抓住(哪怕它与 trust-file 一致)", () => {
  const testKey = key("e2e-signing")
  const report = verifyCommercialArtifact(artifacts([testKey]), { expectedKeys: [testKey] })
  expect(report.ok).toBe(false)
  expect(evidenceOf(report)).toMatch(/测试前缀/)
})

test("混进 PEM 私钥被抓(裸 PEM 与塞进 JS 字符串的都算);只出现标题字符串的加密库不算", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string
  // 两种形态都要抓:落地成 .pem 的裸文本,和被 bundler 塞进字符串、换行写成 \n 的那种
  // —— 后者才是真正会发生的泄漏形态,第一版的正则恰好漏掉了它。
  for (const [name, text] of [
    ["out/main/oops.pem", pem],
    ["out/main/oops.json", JSON.stringify({ key: pem })],
    ["out/main/leak.js", `const KEY = ${JSON.stringify(pem)};`],
  ] as const) {
    const caught = verifyCommercialArtifact([...artifacts(), { path: name, text }], { expectedKeys: [OFFICIAL] })
    expect(caught.ok, name).toBe(false)
    expect(evidenceOf(caught)).toContain(`${name} 里有 PEM 私钥块`)
  }

  // 库里那种"只有标题、没有正文"的字符串不该报:PEM_PRIVATE_KEY 要求跟着 base64 正文。
  const benign = [...artifacts(), { path: "out/main/crypto-lib.js", text: 'const HEADER = "-----BEGIN PRIVATE KEY-----";\nexport { HEADER };\n' }]
  expect(verifyCommercialArtifact(benign, { expectedKeys: [OFFICIAL] }).ok).toBe(true)
})

test("签发工具的标记与特征函数名混进产物 → 抓住", () => {
  for (const poison of ["yoma-license-issuer-tool/v1", "function generateSigningKey(", "issueLicense(input)", "renewalPeriod(prev"]) {
    const files = [...artifacts(), { path: "out/main/leak.js", text: poison }]
    const report = verifyCommercialArtifact(files, { expectedKeys: [OFFICIAL] })
    expect(report.ok, poison).toBe(false)
  }
})

test("产物里出现关掉授权的开关 → 抓住", () => {
  // 期望报出来的那一段(TRUST_FILE / TRUST_JSON 共用 YOMA_LICENSE_TRUST 这个前缀)。
  for (const [poison, reported] of [
    ["YOMA_EDITION", "YOMA_EDITION"],
    ["YOMA_LICENSE_TRUST_JSON", "YOMA_LICENSE_TRUST"],
    ["YOMA_LICENSE_TRUST_FILE", "YOMA_LICENSE_TRUST"],
    ["YOMA_LICENSE_KEY_PASSPHRASE", "YOMA_LICENSE_KEY_PASSPHRASE"],
    ["allowTestKeys", "allowTestKeys"],
  ] as const) {
    const files = artifacts()
    files[0] = { path: files[0]!.path, text: `${files[0]!.text}\nif (process.env.${poison}) skip();` }
    const report = verifyCommercialArtifact(files, { expectedKeys: [OFFICIAL] })
    expect(report.ok, poison).toBe(false)
    expect(evidenceOf(report)).toContain(reported)
  }
})

// ---------------------------------------------------------------------------
// 源码级:执行入口没有测试接缝
// ---------------------------------------------------------------------------

test("执行入口里出现任何一个授权注入口的名字(含 bench 侧的 LicenseService)→ 抓住", () => {
  expect(verifyEntrySources(CLEAN_ENTRIES).ok).toBe(true)
  for (const seam of ["licensePolicy", "licenseNow", "LicenseService", "trustedKeys"]) {
    const dirty = [...CLEAN_ENTRIES.slice(1), { path: "kernel-entry.ts", text: `createKernelHost({ ${seam}: fromEnv() })` }]
    const check = verifyEntrySources(dirty)
    expect(check.ok, seam).toBe(false)
    expect(check.evidence.join("\n")).toContain(seam)
  }
})

// ---------------------------------------------------------------------------
// 文件收集
// ---------------------------------------------------------------------------

test("collectTextFiles 递归收文本、跳过二进制后缀,路径是相对的", () => {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-verify-"))
  dirs.push(root)
  mkdirSync(path.join(root, "main"), { recursive: true })
  writeFileSync(path.join(root, "main", "index.js"), "code")
  writeFileSync(path.join(root, "main", "kernel.js"), "code")
  writeFileSync(path.join(root, "main", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const files = collectTextFiles(root)
  expect(files.map((file) => file.path).sort()).toEqual(["main/index.js", "main/kernel.js"])
})

function evidenceOf(report: { checks: { evidence: string[] }[] }): string {
  return report.checks.flatMap((check) => check.evidence).join("\n")
}
