/**
 * 授权闸门在**内核的执行入口**上,不在界面上。
 *
 * 所以这个文件里一条 UI 都不碰:每一次都是 `host.handle("session.prompt", …)` —— 正是一个改过
 * renderer、或者直接拿 kernel.js 当库用的人能发出的请求。闸门如果只长在设置页的按钮上,这些用例
 * 会全绿而软件实际上是免费的。
 *
 * 时钟是注入的(`licenseNow`),所以"到期"在这里是一个赋值,不是等 30 天;策略也是注入的
 * (`licensePolicy`),所以能在一个社区构建的仓库里跑商业版的行为。密钥每次现场生成,
 * 仓库里没有测试私钥。
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest"

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai"

import { createKernelHost, type KernelHost } from "./index.ts"
import { licenseFilePath, type LicensePolicy } from "./licensing/index.ts"
import type { KernelEvent } from "../protocol.ts"
import type { Part, ToolPart } from "../types.ts"
import type { LicenseStatusView } from "../license-view.ts"
import { isLicenseRequiredData } from "../license-view.ts"
import { generateSigningKey, issueLicense, loadPrivateKey } from "../../../../scripts/license/lib.ts"
import { patient } from "../../test/patience.ts"

// 这个文件里有用例会真跑 flash(拿一条什么都不干的 node 命令当"慢硬件"),而 flash 要先拿探针租约,
// 租约除了进程内那份还落一把**跨进程**的锁。不隔离的话 vitest 分给别的 worker 进程的用例文件与这里
// 共用机器上同一把锁:两边一重叠,后到的 flash 拿不到租约、工具回 "探针被占"(error 而不是 completed),
// 等"工具跑完"的那几处就永远等不到。它还会误伤开发机上正开着的 Yoma。理由详见 host.test.ts 同一段。
beforeAll(() => {
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 所有用例的"现在"。固定时刻,断言里出现的每一个日期都由它算出来。 */
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0)
const EXPIRY = T0 + 30 * DAY
const RENEWED_EXPIRY = T0 + 60 * DAY

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

/** 现场生成的签名密钥:仓库里不存私钥,这把钥匙活在这个进程里。 */
const KEY = (() => {
  const generated = generateSigningKey("gate-key-a")
  return { keyId: generated.keyId, privateKey: loadPrivateKey(generated.privateKeyPem), trusted: generated.trusted }
})()

/** 注入给 host 的商业策略。生产里这份东西是编译期常量,没有任何运行时入口能换掉它。 */
const COMMERCIAL: LicensePolicy = { edition: "commercial", trustedKeys: [KEY.trusted] }

function licenseText(overrides: Partial<Parameters<typeof issueLicense>[0]> = {}): string {
  return issueLicense({
    privateKey: KEY.privateKey,
    keyId: KEY.keyId,
    licenseId: "ORD-GATE-0001",
    customerLabel: "闸门测试客户 张工",
    issuedAt: iso(T0 - DAY),
    notBefore: iso(T0 - DAY),
    expiresAt: iso(EXPIRY),
    ...overrides,
  }).text
}

/** 改 payload 再装回去,签名原样 —— 客户把到期日改远的那种手法。 */
function tamper(text: string, mutate: (payload: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(text) as { payload: string; signature: string }
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as Record<string, unknown>
  mutate(payload)
  return JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") })
}

let fauxCount = 0

/** 一个 faux provider 一个 id:同一进程里多个 host 并存时不会互相路由错。 */
function harnessWith(steps: unknown[], providerID: string) {
  const models = createModels()
  const faux = fauxProvider({ provider: providerID, models: [{ id: "plain" }] })
  models.setProvider(faux.provider)
  faux.setResponses(steps as never)
  return { models, model: faux.getModel() as Model<string> }
}

interface Rig {
  host: KernelHost
  events: KernelEvent[]
  workspace: string
  configDir: string
  /** 可写的"现在"。改它就等于让时间流过去,不必真等。 */
  clock: { now: number }
}

function makeHost(steps: unknown[], options: { licensePolicy?: LicensePolicy } = {}): Rig {
  const events: KernelEvent[] = []
  const workspace = tempDir("yoma-lic-ws-")
  // 隔离开发机真实的 ~/.yoma:license.json、auth.json、技能与上下文文件都在这里面。
  const configDir = tempDir("yoma-lic-config-")
  const clock = { now: T0 }
  const providerID = `faux-lic-${++fauxCount}`
  const host = createKernelHost({
    sessionsRoot: tempDir("yoma-lic-sessions-"),
    stateDir: tempDir("yoma-lic-state-"),
    configDir,
    version: "test",
    licensePolicy: options.licensePolicy,
    licenseNow: () => clock.now,
    onEvents: (batch) => events.push(...batch),
    resolveModels: async () => harnessWith(steps, providerID),
  })
  return { host, events, workspace, configDir, clock }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(timeoutMs)) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 被拒时抛出来的那个错(handler 直接往上抛,`data` 是跨进程唯一能带过去的结构化信息)。 */
interface Thrown extends Error {
  data?: unknown
}

async function rejection(run: () => Promise<unknown>): Promise<Thrown> {
  try {
    await run()
  } catch (error) {
    return error as Thrown
  }
  throw new Error("本该被拒,却通过了")
}

const toolParts = (events: KernelEvent[]): ToolPart[] =>
  events.flatMap((event) =>
    event.type === "message.part.updated" && event.part.type === "tool" ? [event.part as ToolPart] : [],
  )

const statusesOf = (events: KernelEvent[]): string[] =>
  events.flatMap((event) => (event.type === "session.status" ? [event.status.type] : []))

const textsOf = (events: KernelEvent[]): string[] =>
  events.flatMap((event) =>
    event.type === "message.part.updated" && event.part.type === "text" ? [event.part.text] : [],
  )

const licenseUpdates = (events: KernelEvent[]): LicenseStatusView[] =>
  events.flatMap((event) => (event.type === "license.updated" ? [event.status] : []))

/** 一条跑得完但不瞬间结束的"硬件"命令:flash 真起子进程、真攥探针租约,只是什么都不干。 */
const slowFlashCall = (ms: number) =>
  fauxAssistantMessage([fauxToolCall("flash", { command: [process.execPath, "-e", `setTimeout(() => {}, ${ms})`] })])

async function newSession(rig: Rig): Promise<string> {
  const session = await rig.host.handle("session.create", { directory: rig.workspace })
  return session.id
}

describe("商业构建 + 没有授权", () => {
  test("绕过界面直接对内核发 session.prompt:被拒,且一个副作用都没有", async () => {
    const rig = makeHost([fauxAssistantMessage([fauxText("这一步不该跑到")])], { licensePolicy: COMMERCIAL })
    try {
      const sessionID = await newSession(rig)

      const error = await rejection(() =>
        rig.host.handle("session.prompt", { sessionID, input: { text: "开始调试" } }),
      )
      expect(error.name).toBe("LicenseRequiredError")
      expect(isLicenseRequiredData(error.data)).toBe(true)
      // 形状逐字钉住:前端认 `_tag` 出"去激活",认 state 出文案。
      expect(error.data).toEqual({ _tag: "LicenseRequiredError", state: "missing", execution: "session.prompt" })
      expect(error.message).toContain("尚未激活")

      // 检查排在 stop() 与 ensureOpen() 之前,所以一条状态变化都不该有。
      expect(statusesOf(rig.events)).toEqual([])
      // transcript 里没有多出用户消息 —— 被拒的一轮不留痕。
      const page = await rig.host.handle("session.messages", { sessionID })
      expect(page.items).toEqual([])

      const compactError = await rejection(() => rig.host.handle("session.compact", { sessionID }))
      expect(compactError.data).toEqual({
        _tag: "LicenseRequiredError",
        state: "missing",
        execution: "session.compact",
      })
      expect(statusesOf(rig.events)).toEqual([])
      expect((await rig.host.handle("session.messages", { sessionID })).items).toEqual([])
    } finally {
      await rig.host.dispose()
    }
  }, 30_000)

  test("这些始终可用:读历史、列会话、改名、删、停止、模型目录、配 key、授权那三条、项目、app.info", async () => {
    const rig = makeHost([], { licensePolicy: COMMERCIAL })
    /** 跑一条 RPC,断言它**不是**被授权闸门拦下的。别的错原样冒出去 —— 这个用例不该掩盖真故障。 */
    async function allowed<T>(label: string, run: () => Promise<T>): Promise<T> {
      try {
        return await run()
      } catch (error) {
        const thrown = error as Thrown
        expect(thrown.name, label).not.toBe("LicenseRequiredError")
        expect(isLicenseRequiredData(thrown.data), label).toBe(false)
        throw error
      }
    }
    try {
      const sessionID = await allowed("session.create", () => newSession(rig))

      const listed = await allowed("session.list", () => rig.host.handle("session.list", { directory: rig.workspace }))
      expect(listed.map((item) => item.id)).toEqual([sessionID])

      expect((await allowed("session.messages", () => rig.host.handle("session.messages", { sessionID }))).items).toEqual(
        [],
      )

      // 停止在没有授权时也必须可用:否则一轮跑着时到期,用户连停都停不下来。
      await allowed("session.abort", () => rig.host.handle("session.abort", { sessionID }))
      expect(await rig.host.handle("session.status", { sessionID })).toEqual({ type: "idle" })

      await allowed("session.rename", () => rig.host.handle("session.rename", { sessionID, title: "改过名字" }))
      expect((await rig.host.handle("session.get", { sessionID }))?.title).toBe("改过名字")

      const providers = await allowed("model.list", () => rig.host.handle("model.list", undefined))
      expect(providers.some((provider) => provider.id.startsWith("faux-lic-"))).toBe(true)

      // 配凭据:没激活的软件也得能先把 key 填上(否则激活之后还要再折腾一遍)。
      const afterAuth = await allowed("auth.set", () =>
        rig.host.handle("auth.set", { providerID: "deepseek", apiKey: "sk-gate-test-not-a-real-key" }),
      )
      expect(afterAuth.some((provider) => provider.id === "deepseek")).toBe(true)
      expect(readFileSync(path.join(rig.configDir, "auth.json"), "utf8")).toContain("sk-gate-test-not-a-real-key")

      const status = await allowed("license.status", () => rig.host.handle("license.status", undefined))
      expect(status).toMatchObject({ edition: "commercial", enforced: true, state: "missing" })
      expect(status.file).toBe(licenseFilePath(rig.configDir))

      const diagnostics = await allowed("license.diagnostics", () => rig.host.handle("license.diagnostics", undefined))
      expect(diagnostics.text).toContain("授权状态: missing")
      expect(diagnostics.text).toContain("应用版本: test")

      expect(await allowed("project.list", () => rig.host.handle("project.list", undefined))).toEqual([])
      expect(await allowed("app.info", () => rig.host.handle("app.info", undefined))).toMatchObject({ version: "test" })

      await allowed("session.delete", () => rig.host.handle("session.delete", { sessionID }))
      expect(await rig.host.handle("session.list", { directory: rig.workspace })).toEqual([])
    } finally {
      await rig.host.dispose()
    }
  }, 40_000)
})

describe("导入、到期、续费", () => {
  test("经 RPC 导入有效授权之后,一整轮跑到 idle", async () => {
    const rig = makeHost([fauxAssistantMessage([fauxText("已连上板子")])], { licensePolicy: COMMERCIAL })
    try {
      const sessionID = await newSession(rig)
      const imported = await rig.host.handle("license.import", { text: licenseText() })
      expect(imported).toMatchObject({
        state: "active",
        license: { licenseId: "ORD-GATE-0001", expiresAt: iso(EXPIRY) },
      })

      await rig.host.handle("session.prompt", { sessionID, input: { text: "看看板子" } })
      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 20_000)
      expect(statusesOf(rig.events)).toEqual(["busy", "idle"])
      expect(textsOf(rig.events).some((text) => text.includes("已连上板子"))).toBe(true)
      expect(rig.events.filter((event) => event.type === "kernel.error")).toEqual([])
    } finally {
      await rig.host.dispose()
    }
  }, 30_000)

  test("到期 → 新一轮被拒 → 经 RPC 导入续费 → 同一个 host 不重启,下一轮立刻能跑", async () => {
    const rig = makeHost(
      [fauxAssistantMessage([fauxText("第一轮")]), fauxAssistantMessage([fauxText("续费之后的一轮")])],
      { licensePolicy: COMMERCIAL },
    )
    try {
      const sessionID = await newSession(rig)
      await rig.host.handle("license.import", { text: licenseText() })
      await rig.host.handle("session.prompt", { sessionID, input: { text: "第一轮" } })
      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 20_000)

      // 时间走到到期之后。授权文件一个字节都没动,变的只有"现在"。
      rig.clock.now = EXPIRY + HOUR
      const error = await rejection(() => rig.host.handle("session.prompt", { sessionID, input: { text: "第二轮" } }))
      expect(error.data).toEqual({
        _tag: "LicenseRequiredError",
        state: "expired",
        execution: "session.prompt",
        notBefore: iso(T0 - DAY),
        expiresAt: iso(EXPIRY),
      })
      expect(error.message).toContain(iso(EXPIRY))
      // 被拒的那一次没有开跑:状态序列还是上一轮结束时的样子。
      expect(statusesOf(rig.events)).toEqual(["busy", "idle"])

      // 续费:同一个 licenseId,更晚的到期日。经 RPC 进来,不碰文件系统、不重启内核。
      const renewed = await rig.host.handle("license.import", {
        text: licenseText({ expiresAt: iso(RENEWED_EXPIRY), issuedAt: iso(rig.clock.now) }),
      })
      expect(renewed).toMatchObject({
        state: "active",
        license: { licenseId: "ORD-GATE-0001", expiresAt: iso(RENEWED_EXPIRY) },
      })

      await rig.host.handle("session.prompt", { sessionID, input: { text: "第二轮" } })
      await waitFor(() => statusesOf(rig.events).filter((status) => status === "idle").length >= 2, 20_000)
      expect(textsOf(rig.events).some((text) => text.includes("续费之后的一轮"))).toBe(true)

      // 状态变化推成了事件:设置页不轮询也能跟上"到期了"和"续上了"。
      await waitFor(() => licenseUpdates(rig.events).length >= 2, 10_000)
      const states = licenseUpdates(rig.events).map((status) => status.state)
      expect(states).toContain("expired")
      expect(states.at(-1)).toBe("active")
      expect(licenseUpdates(rig.events).at(-1)?.license?.expiresAt).toBe(iso(RENEWED_EXPIRY))
    } finally {
      await rig.host.dispose()
    }
  }, 40_000)

  test("导入被拒的形状经 RPC 出来:篡改过的文件 → LicenseImportError,原有授权仍然 active", async () => {
    const rig = makeHost([], { licensePolicy: COMMERCIAL })
    try {
      await rig.host.handle("license.import", { text: licenseText() })
      const before = readFileSync(licenseFilePath(rig.configDir))

      const forged = tamper(licenseText(), (payload) => (payload.expiresAt = iso(T0 + 9999 * DAY)))
      const error = await rejection(() => rig.host.handle("license.import", { text: forged }))
      expect(error.name).toBe("LicenseImportError")
      expect(error.data).toEqual({ _tag: "LicenseImportError", code: "bad-signature" })

      // 盘上字节没动,状态没变差。
      expect(readFileSync(licenseFilePath(rig.configDir)).equals(before)).toBe(true)
      expect(await rig.host.handle("license.status", undefined)).toMatchObject({
        state: "active",
        license: { expiresAt: iso(EXPIRY) },
      })
    } finally {
      await rig.host.dispose()
    }
  }, 30_000)
})

describe("到期不回头查已接受的轮次", () => {
  test("工具跑着时到期:工具照样 completed、这一轮正常到 idle;之后的新一轮才被拒", async () => {
    const rig = makeHost([slowFlashCall(1500), fauxAssistantMessage([fauxText("烧完了")])], {
      licensePolicy: COMMERCIAL,
    })
    try {
      const sessionID = await newSession(rig)
      await rig.host.handle("license.import", { text: licenseText() })
      await rig.host.handle("session.prompt", { sessionID, input: { text: "烧进去" } })

      // 等到工具真的在跑(子进程已经起来了),再让时间跨过到期日。
      await waitFor(() => toolParts(rig.events).some((part) => part.state.status === "running"), 20_000)
      rig.clock.now = EXPIRY + HOUR
      expect(await rig.host.handle("license.status", undefined)).toMatchObject({ state: "expired" })

      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 30_000)
      const flash = toolParts(rig.events).filter((part) => part.tool === "flash")
      expect(flash.length).toBeGreaterThan(0)
      // 到期没有把跑到一半的烧录杀掉。
      expect(flash.every((part) => part.state.status !== "error")).toBe(true)
      expect(flash.some((part) => part.state.status === "completed")).toBe(true)
      // 这一轮跑完了它该跑的:工具之后模型还说了话。
      expect(textsOf(rig.events).some((text) => text.includes("烧完了"))).toBe(true)
      expect(statusesOf(rig.events)).toEqual(["busy", "idle"])
      expect(rig.events.filter((event) => event.type === "kernel.error")).toEqual([])

      // 已接受的那一轮不受影响,但**新的**一轮要看授权。
      const error = await rejection(() => rig.host.handle("session.prompt", { sessionID, input: { text: "再烧一次" } }))
      expect(error.data).toMatchObject({ _tag: "LicenseRequiredError", state: "expired" })
    } finally {
      await rig.host.dispose()
    }
  }, 60_000)

  test("到期之后停止仍然可用:长工具跑着,session.abort 收得住,状态回 idle", async () => {
    const rig = makeHost([slowFlashCall(10_000), fauxAssistantMessage([fauxText("不该到这一步")])], {
      licensePolicy: COMMERCIAL,
    })
    try {
      const sessionID = await newSession(rig)
      await rig.host.handle("license.import", { text: licenseText() })
      await rig.host.handle("session.prompt", { sessionID, input: { text: "烧一个很久的" } })
      await waitFor(() => toolParts(rig.events).some((part) => part.state.status === "running"), 20_000)

      rig.clock.now = EXPIRY + HOUR
      // 停止不经过授权检查 —— 这是"到期之后用户至少还能把手上的活停下来"那条产品承诺。
      await rig.host.handle("session.abort", { sessionID })
      expect(await rig.host.handle("session.status", { sessionID })).toEqual({ type: "idle" })
      // 事件走 StreamSink 的 16ms 合并窗口,所以 RPC 已经回 idle 时最后一条事件可能还没出去。
      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 10_000)
      // 真的被收住了:那 10 秒的子进程没跑完,工具之后的那一步模型也没说上话。
      expect(textsOf(rig.events).some((text) => text.includes("不该到这一步"))).toBe(false)
    } finally {
      await rig.host.dispose()
    }
  }, 60_000)

  test("没授权的新请求打不断在飞的轮次:检查排在 stop() 之前", async () => {
    const rig = makeHost([slowFlashCall(2000), fauxAssistantMessage([fauxText("烧完了")])], {
      licensePolicy: COMMERCIAL,
    })
    try {
      const sessionID = await newSession(rig)
      await rig.host.handle("license.import", { text: licenseText() })
      await rig.host.handle("session.prompt", { sessionID, input: { text: "烧进去" } })
      await waitFor(() => toolParts(rig.events).some((part) => part.state.status === "running"), 20_000)

      rig.clock.now = EXPIRY + HOUR
      // 这一句如果排在 prompt() 的 stop() 之后,它就会先把上面那一轮中断掉,再报授权不足 ——
      // 也就是"没付费的请求有本事打断一次正在烧录的执行"。
      const error = await rejection(() => rig.host.handle("session.prompt", { sessionID, input: { text: "插一句" } }))
      expect(error.data).toMatchObject({ _tag: "LicenseRequiredError", state: "expired" })

      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 30_000)
      const flash = toolParts(rig.events).filter((part) => part.tool === "flash")
      expect(flash.every((part) => part.state.status !== "error")).toBe(true)
      expect(flash.some((part) => part.state.status === "completed")).toBe(true)
      expect(textsOf(rig.events).some((text) => text.includes("烧完了"))).toBe(true)
      // 中断过的话这里会多出一段 busy → idle → busy。
      expect(statusesOf(rig.events)).toEqual(["busy", "idle"])
      // 被拒的那一次没有往 transcript 里写用户消息。
      const page = await rig.host.handle("session.messages", { sessionID })
      const userTexts = page.items
        .filter((item) => item.info.role === "user")
        .flatMap((item) => item.parts.filter((part: Part) => part.type === "text").map((part) => part.text))
      expect(userTexts.some((text) => text.includes("插一句"))).toBe(false)
    } finally {
      await rig.host.dispose()
    }
  }, 60_000)
})

describe("社区构建", () => {
  test("不传策略 = 社区版:没有授权文件也照样跑完一轮,状态是 not-required", async () => {
    const rig = makeHost([fauxAssistantMessage([fauxText("社区版照跑")])])
    try {
      const status = await rig.host.handle("license.status", undefined)
      expect(status).toMatchObject({ edition: "community", enforced: false, state: "not-required" })
      expect(status.license).toBeUndefined()
      expect(status.trustedKeyIds).toEqual([])

      const sessionID = await newSession(rig)
      await rig.host.handle("session.prompt", { sessionID, input: { text: "问一句" } })
      await waitFor(() => statusesOf(rig.events).at(-1) === "idle", 20_000)
      expect(textsOf(rig.events).some((text) => text.includes("社区版照跑"))).toBe(true)
      expect(rig.events.filter((event) => event.type === "kernel.error")).toEqual([])

      // 社区版收不了授权文件(也没有可信公钥可验),但说得出为什么。
      const error = await rejection(() => rig.host.handle("license.import", { text: licenseText() }))
      expect(error.name).toBe("LicenseImportError")
      expect(error.message).toContain("社区")
      expect(await rig.host.handle("license.status", undefined)).toMatchObject({ state: "not-required" })
    } finally {
      await rig.host.dispose()
    }
  }, 30_000)
})
