/**
 * datasheet v2 的**真实联调**用例。默认跳过,只有同时设置下面两个环境变量才会发网络请求:
 *
 *   YOMA_DATASHEET_V2_LIVE=1
 *   YOMA_DATASHEET_V2_LIVE_URL=http://127.0.0.1:8309   # 未来的 SSH 本地隧道 / 隔离 8309
 *
 * 纪律(见 reports/m2-client-live-task.md):
 * - **绝不**回落到内置公共服务或 YOMA_DATASHEET_SERVER:显式 server + apiVersion:"v2",env 传空对象。
 * - 普通 search 至少间隔 1.05 s(服务端默认 60 次/分钟、burst 10;GET docs/resolve 不扣这桶)。
 * - 429 / 413 只在最后的 raw HTTP 探针里验证,和工具层解码分开,不声称"真工具经历了这些码";
 *   429 探针只发无效空 query,不产生模型开销。
 * - 取消用**已中止**的 AbortSignal 做确定性验证,不依赖慢网络。
 * - 不打印凭据、请求头、图片 base64;不读任何新验收题。
 * - view_figure 找不到真实 image_path 时显式 skip,不算通过。
 *
 * 运行(等 Codex 给出 URL 后):
 *   YOMA_DATASHEET_V2_LIVE=1 YOMA_DATASHEET_V2_LIVE_URL=http://127.0.0.1:8309 \
 *     npx vitest run --project kernel-domain packages/kernel/test/datasheet-v2-live.test.ts
 *
 * 先建隧道(本轮不执行):
 *   ssh -N -L 8309:127.0.0.1:8309 <yoma1>
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { lastSegment } from "../src/host/domain/datasheet/index.ts"
import { createDatasheetClient, type DatasheetClientOptions } from "../src/host/tools/datasheet/client.ts"
import { type DatasheetDetails, type DatasheetInput } from "../src/host/tools/datasheet/contract.ts"
import { createDatasheetTool, type DatasheetToolOptions } from "../src/host/tools/datasheet/session.ts"

const LIVE = process.env.YOMA_DATASHEET_V2_LIVE === "1"
const LIVE_URL = (process.env.YOMA_DATASHEET_V2_LIVE_URL ?? "").trim().replace(/\/+$/, "")
const live = LIVE && LIVE_URL.length > 0

if (LIVE && !LIVE_URL.length) {
  // 设置了一半不静默:跳过时留下原因,但绝不回落到内置地址。
  console.warn("[datasheet-v2-live] YOMA_DATASHEET_V2_LIVE=1 but YOMA_DATASHEET_V2_LIVE_URL is empty; skipping")
}

/** 普通 search 的最小间隔:服务端 60/min、burst 10,1.05 s 留一点余量。 */
const SEARCH_GAP_MS = 1_050
let lastSearchAt = 0

async function searchSlot(): Promise<void> {
  const wait = lastSearchAt + SEARCH_GAP_MS - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastSearchAt = Date.now()
}

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoma-datasheet-v2-live-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-live",
  operationId: "op-live",
  turnId: "turn-live",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

/** 真实工具:显式 URL + 强制 v2 + 空 env,绝不碰内置地址 / 环境里的 YOMA_DATASHEET_SERVER。 */
function makeLiveTool(options: DatasheetToolOptions = {}) {
  const dir = createTempDir()
  const tool = createDatasheetTool({
    server: LIVE_URL,
    configDir: dir,
    env: {},
    apiVersion: "v2",
    timeoutMs: 30_000,
    artifactTimeoutMs: 60_000,
    ...options,
  })
  const run = (params: DatasheetInput, context: Context = BACKGROUND_CONTEXT) =>
    tool.execute("live", params, () => {}, { env: new NodeExecutionEnv({ cwd: dir }) }, invocation, context)
  return { tool, run, dir }
}

function makeLiveClient(options: DatasheetClientOptions = {}) {
  return createDatasheetClient(LIVE_URL, { apiVersion: "v2", timeoutMs: 30_000, ...options })
}

function textOf(result: AgentToolResult<DatasheetDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/** 已中止的信号:确定性地验证工具把取消传下去,不依赖网络慢。 */
function abortedContext(): Context {
  const controller = new AbortController()
  controller.abort()
  return withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
}

describe.skipIf(!live)("datasheet v2 live (YOMA_DATASHEET_V2_LIVE=1)", () => {
  // ── 1. targets/resolve:真实成功与真实失败都是 200 ────────────────────────────

  it("resolves a real part number to targets / ancestors / doc count", async () => {
    const client = makeLiveClient()
    const outcome = await client.resolveTarget("STM32F407VG")
    if (!outcome.ok) throw new Error(`resolve failed: HTTP ${outcome.status} ${outcome.message.slice(0, 300)}`)
    expect(outcome.resolved.length).toBeGreaterThan(0)
    expect(outcome.resolved.some((code) => /stm32f4|stm32f407/i.test(code))).toBe(true)
    expect(outcome.docs).toBeGreaterThan(0)
    expect(outcome.candidates).toEqual([])
  }, 60_000)

  it("returns 200 resolved=false with candidate codes for an unresolved query (not 422)", async () => {
    const client = makeLiveClient()
    const outcome = await client.resolveTarget("STM3F407")
    if (!outcome.ok) throw new Error(`resolve failed: HTTP ${outcome.status} ${outcome.message.slice(0, 300)}`)
    // 服务端真实行为:resolve 失败仍是 200,resolved=false;只有 search/docs 的 scope 解析失败才 422。
    expect(outcome.resolved).toEqual([])
    expect(outcome.candidates.length).toBeGreaterThan(0)
    expect(outcome.candidates.some((code) => /stm32/i.test(code))).toBe(true)
  }, 60_000)

  // ── 2. search:具体型号 + 英文关键词 ──────────────────────────────────────────

  it("searches STM32F407VG with English keywords and exposes v2 scope / reasons / links", async () => {
    const { run } = makeLiveTool()
    await searchSlot()
    const result = await run({
      action: "search",
      query: "USART 波特率分频 USARTDIV 怎么算",
      keywords: "USART baud rate USARTDIV BRR mantissa fraction",
      chip: "STM32F407VG",
      topK: 5,
    })
    const text = textOf(result)
    expect(result.details.apiVersion).toBe("v2")
    expect(result.details.keywords).toBe("USART baud rate USARTDIV BRR mantissa fraction")
    expect(result.details.scope).toBeDefined()
    expect(result.details.scope!.targets.length).toBeGreaterThan(0)
    expect(result.details.generation).toBeTypeOf("number")
    expect(result.details.hits!.length).toBeGreaterThan(0)
    expect(text).toContain("Scope actually used by the server")
    expect(text).toContain("why:")
    const first = result.details.hits![0]!
    expect(first.score).toBeTypeOf("number")
    expect(first.reasons?.length).toBeGreaterThan(0)
    // 至少有一条命中能追溯到 parsed_path;没有的话 read_section 那组会显式 skip。
    expect(result.details.hits!.some((hit) => !!hit.parsed_path)).toBe(true)
    // 具体型号被服务端解析到了 STM32 范围(不要求某个精确祖先代码)。
    expect(
      result.details.scope!.targets.some((target) => /stm32/i.test(target)) ||
        result.details.hits!.some((hit) => hit.targets?.some((target) => /stm32/i.test(target))),
    ).toBe(true)
  }, 120_000)

  it("turns a real unresolved search scope into candidate codes and never falls back", async () => {
    const { run } = makeLiveTool()
    await searchSlot()
    const result = await run({
      action: "search",
      query: "USART baud rate",
      keywords: "USART baud rate",
      chip: "STM3F407",
    })
    const text = textOf(result)
    expect(result.details.apiVersion).toBe("v2")
    expect(result.details.errorCode).toBe("scope_unresolved")
    expect(result.details.candidates?.length).toBeGreaterThan(0)
    expect(result.details.candidates!.some((code) => /stm32/i.test(code))).toBe(true)
    expect(text).toContain("NO SEARCH PERFORMED")
    expect(text).toContain("scope_unresolved")
    expect(text).toContain("Candidates:")
    // 真实候选对象是 {code,...};若解码漏了 code,这里会是空的 "Candidates:"。
    for (const code of result.details.candidates!) expect(text).toContain(code)
    expect(text).not.toContain("legacy POST /api/search")
    expect(text).not.toContain("does not expose the v2 API")
  }, 120_000)

  it("returns a real scope_conflict for a cross-family pinned doc and never falls back", async (ctx) => {
    const { run } = makeLiveTool()
    await searchSlot()
    const result = await run({
      action: "search",
      query: "USART baud rate",
      keywords: "USART baud rate",
      chip: "STM32F1",
      rev: "RM0390", // STM32F4 手册,与 STM32F1 同厂商但不同家族 → hard 文档范围冲突
      topK: 3,
    })
    const text = textOf(result)
    if (!text.includes("scope_conflict")) {
      // 语料里没有这本 / 这个家族时,失败的是夹具而不是客户端;显式 skip 并说明原因。
      if (/不在当前文档目录里|invalid_request|scope_unresolved/.test(text)) {
        ctx.skip(`live corpus does not provide the conflict fixture: ${text.slice(0, 240)}`)
      }
    }
    expect(result.details.apiVersion).toBe("v2")
    expect(result.details.errorCode).toBe("scope_conflict")
    expect(text).toContain("scope_conflict")
    expect(text).toContain("scope.docs 与 scope.targets 冲突")
    // 强制 v2:422 不应该被翻译成"旧服务器",也不应该出现 v1 回落说明。
    expect(text).not.toContain("legacy POST /api/search")
    expect(text).not.toContain("does not expose the v2 API")
    expect(text).not.toContain("No v1 fallback was attempted")
  }, 120_000)

  // ── 3. chips / docs ──────────────────────────────────────────────────────────

  it("lists a real part number's documents through /api/v2/docs, and the full family list", async () => {
    const { run } = makeLiveTool()
    const one = await run({ action: "chips", chip: "STM32F407VG" })
    const oneText = textOf(one)
    expect(one.details.apiVersion).toBe("v2")
    expect(one.details.manuals).toBeGreaterThan(0)
    expect(oneText).toMatch(/chip "stm32/i) // target_resolved / legacy_chip 落到 STM32 范围
    expect(oneText).toMatch(/rev "[^"]+"/) // 真实文档号(任何可回传的 doc_id 都算)
    expect(oneText).not.toContain("does not expose the v2 API")

    const all = await run({ action: "chips" })
    const allText = textOf(all)
    expect(all.details.apiVersion).toBe("v2")
    expect(all.details.families).toBeGreaterThan(0)
    expect(all.details.manuals).toBeGreaterThanOrEqual(all.details.families!)
    expect(allText).toContain("indexed chip families")
  }, 120_000)

  it("turns a real unknown docs target into candidate codes, not a generic failure", async () => {
    const { run } = makeLiveTool()
    const result = await run({ action: "chips", chip: "STM3F407" })
    const text = textOf(result)
    expect(result.details.apiVersion).toBe("v2")
    expect(result.details.errorCode).toBe("scope_unresolved")
    expect(result.details.candidates?.length).toBeGreaterThan(0)
    for (const code of result.details.candidates!) expect(text).toContain(code)
    expect(text).toContain("could not resolve chip")
    expect(text).not.toContain("does not expose the v2 API")
  }, 60_000)

  // ── 4. read_section / view_figure 用真实 links ───────────────────────────────

  it("reads a section from the parsed_path returned by a real v2 hit", async (ctx) => {
    const { run } = makeLiveTool()
    await searchSlot()
    const search = await run({
      action: "search",
      query: "USART baud rate register",
      keywords: "USART baud rate USARTDIV BRR mantissa fraction",
      chip: "STM32F407VG",
      topK: 8,
    })
    const hit = search.details.hits?.find((candidate) => !!candidate.parsed_path && !!candidate.headings)
    if (!hit) {
      ctx.skip("no live hit carried both parsed_path and headings")
      return
    }
    const section = await run({
      action: "read_section",
      parsedPath: hit.parsed_path,
      heading: lastSegment(hit.headings),
      maxChars: 20_000,
    })
    const text = textOf(section)
    if (text.includes("Parsed manual not on the server")) {
      ctx.skip(`parsed artifact is not served for ${hit.parsed_path}`)
      return
    }
    expect(section.details.action).toBe("read_section")
    expect(section.details.parsedPath).toBe(hit.parsed_path)
    expect(["section", "window", "toc"]).toContain(section.details.mode)
    expect(text.length).toBeGreaterThan(0)
    if (section.details.mode === "section") expect(text.length).toBeGreaterThan(100)
    // 不能把整节 / 图片数据写进日志;这里只断言长度与模式。
  }, 120_000)

  it("views a figure when a real hit carries an image_path (content type only, never the data)", async (ctx) => {
    const { run } = makeLiveTool()
    await searchSlot()
    const search = await run({
      action: "search",
      query: "STM32F4 clock tree block diagram",
      keywords: "clock tree block diagram RCC STM32F4",
      chip: "STM32F407VG",
      topK: 20,
    })
    const hit = search.details.hits?.find((candidate) => !!candidate.image_path)
    if (!hit) {
      ctx.skip("no live search hit carried an image_path in the top 20")
      return
    }
    const figure = await run({ action: "view_figure", imagePath: hit.image_path!, caption: hit.headings })
    const text = textOf(figure)
    if (
      text.includes("Figure not on the server") ||
      text.includes("Not a supported figure image path") ||
      text.includes("could not be attached") ||
      text.includes("not attaching") ||
      text.includes("not downloading it")
    ) {
      ctx.skip(`figure artifact is not usable for ${hit.image_path}: ${text.slice(0, 160)}`)
      return
    }
    const image = figure.content.find((part) => part.type === "image")
    expect(image).toBeDefined()
    if (image && image.type === "image") {
      expect(image.mimeType).toMatch(/^image\//)
      expect(image.data.length).toBeGreaterThan(0) // 只断言非空,不打印 base64
    }
    expect(figure.details.action).toBe("view_figure")
    expect(figure.details.bytes).toBeGreaterThan(0)
  }, 180_000)

  // ── 5. 取消:已中止信号,确定性,不依赖慢网络 ─────────────────────────────────

  it("honors an already-aborted signal without waiting on the network", async () => {
    const { run } = makeLiveTool()
    const started = Date.now()
    await expect(
      run(
        { action: "search", query: "USART baud rate", keywords: "USART baud rate", chip: "STM32F407VG" },
        abortedContext(),
      ),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
    const readStarted = Date.now()
    await expect(
      run({ action: "read_section", parsedPath: "parsed/STM32F4/RM0390.md" }, abortedContext()),
    ).rejects.toThrow()
    expect(Date.now() - readStarted).toBeLessThan(2_000)
  }, 20_000)

  // ── 6. raw HTTP 边界探针(不是工具调用;放在最后,429 会耗尽本机桶) ──────────

  it("raw HTTP probe: rejects an oversized body with 413 payload_too_large", async () => {
    const body = JSON.stringify({ query: "x".repeat(70_000) })
    const response = await fetch(`${LIVE_URL}/api/v2/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    const json = (await response.json()) as { error?: { code?: string } }
    expect(response.status).toBe(413)
    expect(json.error?.code).toBe("payload_too_large")
  }, 60_000)

  it("raw HTTP probe: rate-limits a bounded burst of invalid queries with 429 + Retry-After", async () => {
    // 只发空 query:invalid_request 422,不会触发 embedding / 检索;限流在解析前扣桶。
    // capacity 10,连发 14 次足够触发 429。有界、不循环等待。
    const statuses: number[] = []
    let retryAfter: string | null = null
    let rateLimitedCode: string | undefined
    for (let i = 0; i < 14; i++) {
      const response = await fetch(`${LIVE_URL}/api/v2/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "", scope: { targets: [], docs: [], doc_types: [] } }),
      })
      statuses.push(response.status)
      const text = await response.text()
      if (response.status === 429) {
        retryAfter = response.headers.get("retry-after")
        try {
          rateLimitedCode = (JSON.parse(text) as { error?: { code?: string } }).error?.code
        } catch {
          rateLimitedCode = undefined
        }
      }
    }
    expect(statuses).toContain(429)
    expect(retryAfter).toBeTruthy()
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
    expect(rateLimitedCode).toBe("rate_limited")
  }, 60_000)
})
