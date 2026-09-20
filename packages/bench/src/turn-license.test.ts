/**
 * `runTurn` 这一侧的授权:**被拒时不是异常、不是业务失败,而是结果里的一个字段**。
 *
 * 检查本身在内核(`session.prompt` 第一行)—— 这里验的是调试台怎么消费它:
 * 空正文、零工具调用、零错误、`licenseBlocked` 带着结构化原因,于是守护能把这一步
 * 变成"暂停"而不是往信箱里回填一个失败结果(那会让研发端的模型去分析一个不存在的故障)。
 *
 * 还有一条**后门闸门**:授权策略只能作为函数参数(`TurnSeams`)从代码里进来。
 * `turn-entry.ts` 是把一个 JSON 文件整个展开进 `TurnOptions` 的,所以 options 上、
 * `TurnInput` 里、`MailboxHostConfig` 里都不许有授权字段 —— 否则正式包就多了一个
 * "改配置文件关掉检查"的入口。用例按源码扫这一条。
 */

import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Model } from "@earendil-works/pi-ai"
import { LicenseService, type LicensePolicy } from "@yoma-desktop/kernel/host"

import { generateSigningKey, issueLicense, loadPrivateKey } from "../../../scripts/license/lib.ts"
import { parseJob, type Job } from "./job.ts"
import { runTurn, type TurnOptions } from "./turn.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const DAY = 24 * 3_600_000
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

const KEY = (() => {
  const generated = generateSigningKey("bench-turn-key")
  return { keyId: generated.keyId, privateKey: loadPrivateKey(generated.privateKeyPem), trusted: generated.trusted }
})()
/** "这台机器装的是商业包"那份编译期策略。测试经 TurnSeams 传,生产没有任何入口传它。 */
const COMMERCIAL: LicensePolicy = { edition: "commercial", trustedKeys: [KEY.trusted] }

/**
 * 往 configDir 里装一份授权。走**内核自己的导入路径**(文件格式与落点只有那一份实现),
 * 所以 `atMs` 要落在这份授权的有效期内 —— 导入一份已经过期的文件本来就该被拒。
 * "已经过期"的状态由**检查时的时钟**造出来(`licenseNow`),这也正是真实世界里发生的事。
 */
function writeLicense(configDir: string, period: { notBefore: string; expiresAt: string }, atMs = T0): void {
  const text = issueLicense({
    privateKey: KEY.privateKey,
    keyId: KEY.keyId,
    licenseId: "ORD-2026-0001",
    customerLabel: "测试客户",
    issuedAt: iso(T0 - DAY),
    ...period,
  }).text
  new LicenseService({ configDir, policy: COMMERCIAL, now: () => atMs }).importText(text)
}

let fauxCount = 0
function models(steps: unknown[]) {
  return async () => {
    const registry = createModels()
    const faux = fauxProvider({ provider: `faux-license-${++fauxCount}`, models: [{ id: "faux" }] })
    registry.setProvider(faux.provider)
    faux.setResponses(steps as never)
    return { models: registry, model: faux.getModel() as Model<string> }
  }
}

function job(workspace: string): Job {
  return parseJob({
    id: "j-license",
    title: "授权测试",
    task: "看一眼",
    repo: { directory: workspace },
    bench: {},
  })
}

const MARKER = "紫色的大象在跳舞"

function turnOptions(workspace: string, configDir: string): TurnOptions {
  return {
    job: job(workspace),
    workspace,
    sessionsRoot: tempDir("bench-license-sessions-"),
    stateDir: tempDir("bench-license-state-"),
    configDir,
    prompt: `开始:${MARKER}`,
    resolveModels: models([fauxAssistantMessage([fauxText("看过了")])]),
    settleMs: 120,
  }
}

/** 会话目录里所有文件的全文 —— 用来断言"这一轮的用户消息压根没落盘"。 */
function sessionsText(root: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : [readFileSync(full, "utf8")]
    })
  return walk(root).join("\n")
}

describe("runTurn · 授权", () => {
  test("商业策略 + 无授权:licenseBlocked 有值,errors 空、text 空、用户消息没有落盘", async () => {
    const workspace = tempDir("bench-license-ws-")
    const options = turnOptions(workspace, tempDir("bench-license-config-"))
    const result = await runTurn(options, { licensePolicy: COMMERCIAL, licenseNow: () => T0 })

    expect(result.licenseBlocked?._tag).toBe("LicenseRequiredError")
    expect(result.licenseBlocked?.state).toBe("missing")
    expect(result.licenseBlocked?.execution).toBe("session.prompt")
    // 不是业务失败:没有错误、没有正文、没有工具调用、没有用量。
    expect(result.errors).toEqual([])
    expect(result.text).toBe("")
    expect(result.toolCalls).toEqual([])
    expect(result.usage.tokens.input).toBe(0)
    expect(result.stopReason).toBeUndefined()
    // 模型没被问过,用户那句话也没进任何会话文件(内核在 prompt 第一行就拒了)。
    expect(sessionsText(options.sessionsRoot)).not.toContain(MARKER)
  })

  test("过期与未生效各自如实报出到期/生效时间", async () => {
    const workspace = tempDir("bench-license-ws-")
    // 装的时候还有效,检查的时候已经是两天后 —— 真实世界里就是这么过期的。
    const expiredDir = tempDir("bench-license-config-")
    writeLicense(expiredDir, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + DAY) })
    const expired = await runTurn(turnOptions(workspace, expiredDir), {
      licensePolicy: COMMERCIAL,
      licenseNow: () => T0 + 2 * DAY,
    })
    expect(expired.licenseBlocked?.state).toBe("expired")
    expect(expired.licenseBlocked?.expiresAt).toBe(iso(T0 + DAY))

    const future = tempDir("bench-license-config-")
    writeLicense(future, { notBefore: iso(T0 + DAY), expiresAt: iso(T0 + 30 * DAY) })
    const notYet = await runTurn(turnOptions(workspace, future), {
      licensePolicy: COMMERCIAL,
      licenseNow: () => T0,
    })
    expect(notYet.licenseBlocked?.state).toBe("not-yet-valid")
    expect(notYet.licenseBlocked?.notBefore).toBe(iso(T0 + DAY))
  })

  test("有效授权:照常跑完,licenseBlocked 为空", async () => {
    const workspace = tempDir("bench-license-ws-")
    const configDir = tempDir("bench-license-config-")
    writeLicense(configDir, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 30 * DAY) })

    const result = await runTurn(turnOptions(workspace, configDir), {
      licensePolicy: COMMERCIAL,
      licenseNow: () => T0,
    })
    expect(result.licenseBlocked).toBeUndefined()
    expect(result.text).toContain("看过了")
  })

  test("社区 / 开发构建不受影响(不传 seams 就是编译期策略)", async () => {
    const workspace = tempDir("bench-license-ws-")
    const result = await runTurn(turnOptions(workspace, tempDir("bench-license-config-")))
    expect(result.licenseBlocked).toBeUndefined()
    expect(result.text).toContain("看过了")
  })

  test("后门:options 里混进 licensePolicy(模拟 JSON 输入里多写一个键)一律无效", async () => {
    const workspace = tempDir("bench-license-ws-")
    // turn-entry 是 `runTurn({ ...读进来的 JSON })`。假设有人在那份 JSON 里写了这两个键:
    const smuggled = {
      ...turnOptions(workspace, tempDir("bench-license-config-")),
      licensePolicy: { edition: "community", trustedKeys: [] },
      licenseNow: () => T0,
      license: { edition: "community" },
    } as unknown as TurnOptions

    const result = await runTurn(smuggled, { licensePolicy: COMMERCIAL, licenseNow: () => T0 })
    // 仍然被拦下:runTurn 逐字段构造 KernelHostOptions,options 上的东西到不了内核。
    expect(result.licenseBlocked?.state).toBe("missing")
  })
})

describe("授权字段不许出现在任何从 JSON 读进来的结构里", () => {
  const sourceOf = (relative: string) => readFileSync(path.join(import.meta.dirname, relative), "utf8")

  /** `export interface X {` 到行首 `}` 之间的原文。 */
  function interfaceBody(source: string, name: string): string {
    const head = source.indexOf(`export interface ${name} {`)
    expect(head, `${name} 没找到`).toBeGreaterThanOrEqual(0)
    const end = source.indexOf("\n}", head)
    expect(end, `${name} 的结尾没找到`).toBeGreaterThan(head)
    return source.slice(head, end)
  }

  test("TurnInput(轮次子进程的 JSON 输入)里没有授权字段", () => {
    expect(interfaceBody(sourceOf("runner.ts"), "TurnInput").toLowerCase()).not.toContain("license")
  })

  test("MailboxHostConfig(守护的 JSON 配置)里没有授权字段", () => {
    expect(interfaceBody(sourceOf("mailbox/host.ts"), "MailboxHostConfig").toLowerCase()).not.toContain("license")
  })

  test("turn-entry 整个文件都不提授权 —— 它只把 JSON 展开进 runTurn,不传第二个参数", () => {
    const source = sourceOf("turn-entry.ts")
    expect(source.toLowerCase()).not.toContain("license")
    // 也不从环境变量取:产物里没有任何运行时开关。
    expect(source).not.toContain("process.env")
  })

  test("bench 里没有任何地方从环境变量读授权", () => {
    for (const file of ["turn.ts", "cli.ts", "mailbox/license.ts", "mailbox/host.ts", "mailbox/runner.ts", "mailbox/mother.ts"]) {
      const source = sourceOf(file)
      const envReads = [...source.matchAll(/process\.env(?:\.(\w+)|\[["'](\w+)["']\])/g)].map((m) => m[1] ?? m[2] ?? "")
      for (const name of envReads) expect(name.toUpperCase(), `${file} 的 ${name}`).not.toContain("LICENSE")
    }
  })
})
