/**
 * datasheet 工具的 v2 那一半:POST /api/v2/search、/api/v2/docs、targets/resolve、接口版本回落。
 * 纯函数在 datasheet-v2.test.ts,这里是有网络的那一半。
 *
 * 假服务器按 M2 服务端约定(DESIGN-v3 §6/§7.2)回包,并记录收到的请求体 —— 这一组用例要钉住:
 * - `chip` 原样进 scope.targets、`rev` 原样进 scope.docs(客户端不做家族推断);
 * - `keywords` 真的发给了 v2;v1 回落时不被发送;
 * - 422 scope_unresolved 的候选 / scope_resolved / degraded 都原样出现在回复里;
 * - 422 / 503 不触发 v1 回落,只有明确 404/405 才回落;
 * - v2 的 links 能被 read_section / view_figure 继续使用(这两条路不回归)。
 *
 * 地址一律显式注入 env + configDir(mkdtemp),不读开发机真实的 ~/.yoma 或外部服务器。
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { encodeRel } from "../src/host/domain/datasheet/index.ts"
import { resetChipIndexCache } from "../src/host/tools/datasheet/client.ts"
import { type DatasheetDetails, type DatasheetInput } from "../src/host/tools/datasheet/contract.ts"
import { createDatasheetTool, type DatasheetToolOptions } from "../src/host/tools/datasheet/session.ts"
import { serveFetch } from "./fixtures/fetch-server.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const servers: { stop(): void }[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoma-datasheet-v2-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  resetChipIndexCache() // 芯片索引缓存是模块级的,不清就会跨用例串味
  for (const server of servers.splice(0)) server.stop()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

/** 地址与额外环境变量显式注入;configDir 是空临时目录。默认 auto 模式。 */
function makeTool(server: string | undefined, options: DatasheetToolOptions = {}) {
  const dir = createTempDir()
  const { env: extraEnv, ...rest } = options
  const tool = createDatasheetTool({
    configDir: dir,
    env: { ...(server === undefined ? {} : { YOMA_DATASHEET_SERVER: server }), ...extraEnv },
    ...rest,
  })
  const run = (params: DatasheetInput, context: Context = BACKGROUND_CONTEXT) =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd: dir }) }, invocation, context)
  return { tool, run, dir }
}

function textOf(result: AgentToolResult<DatasheetDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

function imageOf(result: AgentToolResult<DatasheetDetails>): { data: string; mimeType: string } | undefined {
  const image = result.content.find((part) => part.type === "image")
  return image && image.type === "image" ? { data: image.data, mimeType: image.mimeType } : undefined
}

const abortAfter = (ms: number): Context => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
}

function pngChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(type, 4, "ascii")
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0)
  return Buffer.concat([header, body, checksum])
}

function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) raw[row + 1 + x * 3] = (x * 7 + y * 3) & 0xff
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

// ─── 假服务器 ─────────────────────────────────────────────────────────────────

const PARSED_REL = "parsed/STM32F4/RM0090_p801-1200.md"
const FIGURE_REL = "figures/STM32F4/RM0090/clock.png"
const TINY_PNG = makePng(2, 2)
const MANUAL = ["# 1 Overview", "intro text", "## 1.2 Clocks and startup", "clock body"].join("\n")

const DOC = {
  doc_uid: "st-rm0090",
  doc_id: "RM0090",
  doc_rev: "Rev 9",
  title: "STM32F4 reference manual",
  doc_type: "rm",
  vendor: "st",
  targets: ["stm32f4", "stm32"],
  legacy_chip: "STM32F4",
  legacy_name: "RM0090 (1–400)",
}

const V2_HIT = {
  rank: 1,
  doc: DOC,
  chunk: {
    id: "chunk-1",
    kind: "text",
    page: 985,
    section_id: "30.6.3",
    heading_path: "30 USART > 30.6.3 Baud rate register (USART_BRR)",
    text: "USARTDIV is programmed into USART_BRR.",
    shard: "RM0090_p801-1200",
    legacy_rev: "RM0090_p801-1200",
    ordinal: 3,
    text_truncated: false,
  },
  score: 0.92,
  reasons: ["芯片匹配 stm32f4", "向量第 2、关键词第 1", "重排第 1"],
  links: { parsed_path: PARSED_REL, image_path: "" },
}

const FIGURE_HIT = {
  ...V2_HIT,
  rank: 2,
  score: 0.81,
  chunk: {
    ...V2_HIT.chunk,
    id: "chunk-2",
    page: 120,
    heading_path: "3 Clock tree",
    text: "Clock tree figure caption.",
    section_id: "3",
    ordinal: 7,
    text_truncated: true,
  },
  reasons: ["芯片匹配 stm32f4", "重排第 2"],
  links: { parsed_path: "parsed/STM32F4/RM0090_p1-400.md", image_path: FIGURE_REL },
}

/** 服务端真实 scope_resolved:targets + ladder + matched + vendors(没有 docs)。 */
const V2_SEARCH = {
  hits: [V2_HIT, FIGURE_HIT],
  scope_resolved: {
    targets: ["stm32f407", "stm32f4", "stm32"],
    ladder: "family",
    matched: ["stm32f407"],
    vendors: ["st"],
  },
  degraded: ["rerank"],
  generation: 2,
}

const DOCS = [
  { ...DOC, status: "active", source_pages: 1200, chunks: 500, shards: 4 },
  {
    ...DOC,
    doc_uid: "st-rm0386",
    doc_id: "RM0386",
    doc_rev: "Rev 2",
    title: "STM32F4 reference manual (RM0386)",
    legacy_name: "RM0386 (1–400)",
    status: "active",
    source_pages: 800,
    chunks: 300,
    shards: 2,
  },
  {
    doc_uid: "at-ds",
    doc_id: "AT32F011_DS",
    doc_rev: "",
    title: "雅特力 AT32F011 数据手册",
    doc_type: "datasheet",
    vendor: "artery",
    targets: ["at32f"],
    legacy_chip: "AT32F",
    legacy_name: "雅特力 AT32F011 数据手册",
    status: "active",
    source_pages: 120,
    chunks: 90,
    shards: 1,
  },
  {
    doc_uid: "gen-1",
    doc_id: "PM0214",
    doc_rev: "",
    title: "Cortex-M4 programming manual",
    doc_type: "reference",
    vendor: "st",
    targets: ["general"],
    legacy_chip: "GENERAL",
    legacy_name: "PM0214",
    status: "active",
    source_pages: 300,
    chunks: 100,
    shards: 1,
  },
]

/** 服务端真实候选对象(V2Error.scopeUnresolved 顶层 candidates / resolve 的 matches)。 */
const CANDIDATES = [
  {
    code: "stm32f4",
    level: "family",
    vendor: "st",
    title: "STM32F4",
    pattern: "stm32f4",
    matched_by: "candidate",
    ancestors: ["stm32"],
  },
  {
    code: "stm32f1",
    level: "family",
    vendor: "st",
    title: "STM32F1",
    pattern: "stm32f1",
    matched_by: "candidate",
    ancestors: ["stm32"],
  },
  {
    code: "at32f",
    level: "family",
    vendor: "artery",
    title: "AT32F",
    pattern: "at32f",
    matched_by: "candidate",
    ancestors: [],
  },
]

function targetResolvedFor(target: string) {
  if (target.toUpperCase() === "EMPTY") {
    return {
      input: target,
      matched: "stm32f4",
      level: "family",
      matched_by: "prefix",
      ancestors: ["stm32"],
    }
  }
  return {
    input: target,
    matched: target.toUpperCase().startsWith("STM32") ? "stm32f4" : target.toLowerCase(),
    level: "family",
    matched_by: "exact",
    ancestors: ["stm32"],
  }
}

/** 服务端真实 /api/v2/targets/resolve 成功/失败形状。 */
function resolveBody(q: string) {
  if (q.toUpperCase() === "UNKNOWN" || q.toUpperCase() === "EMPTY_UNRESOLVED") {
    return {
      query: q,
      normalized: q.toLowerCase(),
      resolved: false,
      matches: [],
      ancestors: [],
      docs: 0,
      candidates: CANDIDATES,
    }
  }
  return {
    query: q,
    normalized: q.toLowerCase(),
    resolved: true,
    matches: [
      {
        code: "stm32f4",
        level: "family",
        vendor: "st",
        title: "STM32F4",
        legacy_bucket: "STM32F4",
        matched_by: "exact",
        pattern: "stm32f4",
        ancestors: ["stm32"],
      },
    ],
    ancestors: ["stm32"],
    docs: 2,
    candidates: [],
  }
}

const V1_HITS = [
  {
    text: "legacy vector chunk",
    manual_name: "PM0063",
    chip: "STM32F1",
    rev: "PM0063",
    page: 100,
    headings: "1 Overview",
    score: 0.5,
    kind: "",
    source_pdf: "",
    parsed_path: PARSED_REL,
    image_path: "",
  },
]

const MANIFEST = [{ chip: "STM32F1", rev: "PM0063", manual_name: "PM0063" }]

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type Recorded = { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }

interface FakeOptions {
  /** 非 0 / 非 200 时 v2 search 回这个状态(422 / 503 / 404 …)。 */
  v2SearchStatus?: number
  v2SearchBody?: unknown
  v2SearchHeaders?: Record<string, string>
  /** v2 docs 的状态与响应。 */
  v2DocsStatus?: number
  v2DocsBody?: unknown
  /** v2 targets/resolve 的状态与响应。 */
  v2ResolveStatus?: number
  v2ResolveBody?: unknown
  /** v1 /api/search 的状态与响应。 */
  v1SearchStatus?: number
  v1Hits?: unknown[]
  /** /api/manifest。 */
  manifest?: unknown[]
  v1ManifestStatus?: number
  /** 挂起响应:复现"服务器接了连接不回包"的超时 / 中止。 */
  hangV2Search?: boolean
  hangV2Docs?: boolean
  /** /artifacts/ 一律回这个状态码。 */
  artifactStatus?: number
}

function scopeMatches(doc: (typeof DOCS)[number], target: string): boolean {
  const wanted = target.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const family = doc.legacy_chip.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!wanted || !family) return false
  return family === wanted || wanted.startsWith(family) || family.startsWith(wanted)
}

async function fakeServer(options: FakeOptions = {}) {
  const requests: Recorded[] = []
  // 每条响应都带 Connection: close:上一个用例的挂起/中止会留下半死的 keep-alive 连接,
  // Windows 上端口号很快被复用,undici 复用到它时整条请求会 "fetch failed"(测试随机红)。
  const respond = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const entry: Recorded = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) }
    if (req.method === "POST") {
      entry.body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined
    }
    requests.push(entry)

    if (url.pathname === "/api/v2/search" && req.method === "POST") {
      if (options.hangV2Search) return new Promise<Response>(() => {})
      if (options.v2SearchStatus) {
        return Response.json(options.v2SearchBody ?? { error: { code: "server_error", message: "boom" } }, {
          status: options.v2SearchStatus,
          ...(options.v2SearchHeaders ? { headers: options.v2SearchHeaders } : {}),
        })
      }
      return Response.json(options.v2SearchBody ?? V2_SEARCH)
    }

    if (url.pathname === "/api/v2/docs") {
      if (options.hangV2Docs) return new Promise<Response>(() => {})
      if (options.v2DocsStatus) {
        return Response.json(
          options.v2DocsBody ?? { error: { code: "scope_unresolved", message: "no target" }, candidates: [] },
          {
            status: options.v2DocsStatus,
          },
        )
      }
      if (options.v2DocsBody) return Response.json(options.v2DocsBody)
      const target = url.searchParams.get("target")
      // 真实服务端在 target 解析不出来时回 422(V2ReadService.listDocs -> V2Error.scopeUnresolved),
      // 不是 200 空列表。候选在顶层,元素是带 code 的对象。
      if (target && target.toUpperCase() === "UNKNOWN") {
        return Response.json(
          {
            error: {
              code: "scope_unresolved",
              message: `认不出型号「${target}」对应的词表项，因此没有检索`,
              hint: "改用词表里的编号或文档号",
            },
            candidates: CANDIDATES,
            unresolved: [target],
          },
          { status: 422 },
        )
      }
      // EMPTY / EMPTY_UNRESOLVED 模拟"target 解析成功但本代没有文档"的 200 空列表。
      if (target && target.toUpperCase().startsWith("EMPTY")) {
        return Response.json({
          docs: [],
          total: 0,
          generation: 1,
          target_resolved: target.toUpperCase() === "EMPTY" ? targetResolvedFor(target) : null,
        })
      }
      const docs = target ? DOCS.filter((doc) => scopeMatches(doc, target)) : DOCS
      return Response.json({
        docs,
        total: docs.length,
        generation: 1,
        target_resolved: target ? targetResolvedFor(target) : null,
      })
    }

    if (url.pathname === "/api/v2/targets/resolve") {
      if (options.v2ResolveStatus) {
        return Response.json(options.v2ResolveBody ?? { error: { code: "invalid_request" } }, {
          status: options.v2ResolveStatus,
        })
      }
      if (options.v2ResolveBody) return Response.json(options.v2ResolveBody)
      const q = url.searchParams.get("q") ?? ""
      return Response.json(resolveBody(q))
    }

    if (url.pathname === "/api/search" && req.method === "POST") {
      if (options.v1SearchStatus) return new Response("v1 boom", { status: options.v1SearchStatus })
      const body = entry.body ?? {}
      const chip = String(body.chip ?? "")
      const rev = body.rev === undefined ? undefined : String(body.rev)
      if (!body.query || !chip) return Response.json({ detail: "query and chip are required" }, { status: 422 })
      if (!NAME_RE.test(chip) || (rev !== undefined && !NAME_RE.test(rev))) {
        return Response.json({ detail: "invalid name" }, { status: 422 })
      }
      return Response.json({ hits: options.v1Hits ?? V1_HITS })
    }

    if (url.pathname === "/api/manifest") {
      if (options.v1ManifestStatus) return new Response("no manifest", { status: options.v1ManifestStatus })
      return Response.json(options.manifest ?? MANIFEST)
    }

    if (url.pathname.startsWith("/artifacts/")) {
      if (options.artifactStatus) return new Response("boom", { status: options.artifactStatus })
      if (
        url.pathname === `/artifacts/${encodeRel(PARSED_REL)}` ||
        url.pathname === `/artifacts/${encodeRel("parsed/STM32F4/RM0090_p1-400.md")}`
      ) {
        return new Response(MANUAL)
      }
      if (url.pathname === `/artifacts/${encodeRel(FIGURE_REL)}`) {
        return new Response(TINY_PNG, { headers: { "Content-Type": "image/png" } })
      }
    }

    return new Response("nope", { status: 404 })
  }

  const server = await serveFetch(async (req) => {
    const response = await respond(req)
    response.headers.set("connection", "close")
    return response
  })
  servers.push(server)
  return { url: server.url, requests, paths: () => requests.map((request) => request.path) }
}

// ─── 1. v2 search ─────────────────────────────────────────────────────────────

describe("datasheet v2 search", () => {
  it("posts query + English keywords + verbatim chip/rev scope, and renders scope / degraded / reasons", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({
      action: "search",
      query: "USART 波特率分频怎么算",
      keywords: "USART baud rate USARTDIV BRR mantissa fraction",
      chip: "STM32F407VG",
      rev: "RM0090",
      topK: 3,
    })
    const text = textOf(result)

    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v2/search",
      body: {
        query: "USART 波特率分频怎么算",
        keywords: "USART baud rate USARTDIV BRR mantissa fraction",
        scope: { targets: ["STM32F407VG"], docs: ["RM0090"], doc_types: [] },
        top_k: 3,
        detail: "concise",
      },
    })
    expect(fake.paths()).toEqual(["/api/v2/search"]) // 没有回落、没有 manifest

    expect(text).toContain(
      "Scope actually used by the server: targets: stm32f407, stm32f4, stm32; ladder: family; matched: stm32f407; vendors: st.",
    )
    expect(text).toContain("rerank (reranking was unavailable")
    expect(text).toContain("[#1] RM0090 (1–400) (STM32F4) p.985")
    expect(text).toContain("USARTDIV is programmed into USART_BRR.")
    expect(text).toContain("why: 芯片匹配 stm32f4; 向量第 2、关键词第 1; 重排第 1")
    expect(text).toContain(`source: ${PARSED_REL}`)
    expect(text).toContain("comparable only within this response")
    expect(text).toContain("server truncated this chunk")
    expect(text).not.toContain("docs: RM0090") // 真实 scope_resolved 没有 docs 字段

    expect(result.details).toMatchObject({
      action: "search",
      apiVersion: "v2",
      chip: "STM32F407VG",
      rev: "RM0090",
      topK: 3,
      keywords: "USART baud rate USARTDIV BRR mantissa fraction",
      scope: {
        targets: ["stm32f407", "stm32f4", "stm32"],
        docs: [],
        ladder: "family",
        fields: { matched: ["stm32f407"], vendors: ["st"] },
      },
      degraded: ["rerank"],
      generation: 2,
    })
    expect(result.details.hits).toHaveLength(2)
    expect(result.details.hits![0]).toMatchObject({
      rank: 1,
      manual_name: "RM0090 (1–400)",
      chip: "STM32F4",
      rev: "RM0090",
      page: 985,
      headings: "30 USART > 30.6.3 Baud rate register (USART_BRR)",
      score: 0.92,
      parsed_path: PARSED_REL,
      doc_id: "RM0090",
      doc_uid: "st-rm0090",
      targets: ["stm32f4", "stm32"],
      legacyRev: "RM0090_p801-1200",
      reasons: ["芯片匹配 stm32f4", "向量第 2、关键词第 1", "重排第 1"],
    })
    expect(result.details.hits![1]!.image_path).toBe(FIGURE_REL)
    expect(result.details.hits![1]!.textTruncated).toBe(true)
  })

  it("does not send keywords when omitted, and does not rewrite a part number into a family", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    await run({ action: "search", query: "flash size", chip: "AT32F421C8T7", topK: 5 })
    expect(fake.requests[0]!.body).toEqual({
      query: "flash size",
      scope: { targets: ["AT32F421C8T7"], docs: [], doc_types: [] },
      top_k: 5,
      detail: "concise",
    })
    expect(fake.requests[0]!.body).not.toHaveProperty("keywords")
  })

  it("presents the real V2Error.scopeUnresolved shape with all top-level candidates, and never falls back to v1", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      code: `stm32f${i}`,
      level: "family",
      vendor: "st",
      title: `STM32F${i}`,
      pattern: `stm32f${i}`,
      matched_by: "candidate",
      ancestors: ["stm32"],
    }))
    const fake = await fakeServer({
      v2SearchStatus: 422,
      v2SearchBody: {
        error: {
          code: "scope_unresolved",
          message: "认不出型号「STM99」对应的词表项，因此没有检索",
          hint: "改用词表里的编号（例：STM32F4、AT32F421、GD32F303）或文档号（RM0090 这类走 scope.docs）",
        },
        candidates,
        unresolved: ["STM99"],
      },
    })
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM99", keywords: "USART" })
    const text = textOf(result)
    expect(text).toContain("NO SEARCH PERFORMED")
    expect(text).toContain("scope_unresolved")
    expect(text).toContain("认不出型号「STM99」对应的词表项，因此没有检索")
    expect(text).toContain("Hint: 改用词表里的编号")
    // 服务端 MAX_CANDIDATES=10;客户端上限 30,必须把 10 个 code 一个不落地摆给模型。
    expect(text).toContain(`Candidates: ${candidates.map((c) => c.code).join(", ")}`)
    expect(text).not.toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(fake.paths()).toEqual(["/api/v2/search"]) // 422 不回落
    expect(result.details).toMatchObject({
      action: "search",
      apiVersion: "v2",
      errorCode: "scope_unresolved",
      candidates: candidates.map((c) => c.code),
    })
  })

  it("treats a 503 as a v2 index condition, not as an old interface", async () => {
    const fake = await fakeServer({
      v2SearchStatus: 503,
      v2SearchBody: { error: { code: "index_unavailable", message: "generation 1 is not published" } },
    })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F4" }))
    expect(text).toContain("v2 search index is unavailable (HTTP 503 index_unavailable)")
    expect(text).toContain("generation 1 is not published")
    expect(text).not.toContain("does not expose the v2 API")
    expect(fake.paths()).toEqual(["/api/v2/search"])
  })

  it("surfaces 429 rate limiting with Retry-After and never falls back", async () => {
    const fake = await fakeServer({
      v2SearchStatus: 429,
      v2SearchBody: {
        error: {
          code: "rate_limited",
          message: "v2 搜索请求太频繁",
          hint: "每个来源默认 60 次/分钟、突发 10 次；稍后按 Retry-After 重试",
        },
      },
      v2SearchHeaders: { "Retry-After": "12" },
    })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F4" }))
    expect(text).toContain("rate-limited this search (HTTP 429 rate_limited)")
    expect(text).toContain("v2 搜索请求太频繁")
    expect(text).toContain("Retry after 12 s")
    expect(fake.paths()).toEqual(["/api/v2/search"])
  })

  it("times out a v2 call that connects but never answers, and surfaces an abort as an abort", async () => {
    const fake = await fakeServer({ hangV2Search: true })
    const slow = makeTool(fake.url, { timeoutMs: 300 })
    const started = Date.now()
    const text = textOf(await slow.run({ action: "search", query: "q", chip: "STM32F4" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("timed out after 0 s")
    expect(Date.now() - started).toBeLessThan(2000)

    const { run } = makeTool(fake.url, { timeoutMs: 30_000 })
    const aborted = Date.now()
    await expect(run({ action: "search", query: "q", chip: "STM32F4" }, abortAfter(50))).rejects.toThrow()
    expect(Date.now() - aborted).toBeLessThan(1500)
  })
})

// ─── 2. 接口版本与回落 ────────────────────────────────────────────────────────

describe("datasheet API version and v1 fallback", () => {
  it("auto mode falls back to v1 only on 404/405 and says so; keywords are not sent to v1", async () => {
    const fake = await fakeServer({ v2SearchStatus: 404 })
    const { run } = makeTool(fake.url)
    const result = await run({
      action: "search",
      query: "usart baud",
      keywords: "USART baud rate",
      chip: "STM32F1",
      topK: 3,
    })
    const text = textOf(result)
    expect(text).toContain("has no POST /api/v2/search (HTTP 404)")
    expect(text).toContain("the legacy POST /api/search was used instead")
    expect(text).toContain("ignores `keywords`")
    expect(text).toContain("legacy vector chunk")
    expect(text).toContain("[#1] PM0063 (STM32F1) p.100")
    expect(result.details).toMatchObject({
      action: "search",
      apiVersion: "v1",
      fallback: "v2-missing",
      chip: "STM32F1",
    })
    expect(fake.paths()).toEqual(["/api/v2/search", "/api/search"])
    const v1 = fake.requests[1]!
    expect(v1.body).toMatchObject({ query: "usart baud", chip: "STM32F1", top_k: 3 })
    expect(v1.body).not.toHaveProperty("keywords")
    expect(v1.body).not.toHaveProperty("rev")
  })

  it("forced v2 refuses a missing v2 endpoint instead of silently probing v1", async () => {
    const fake = await fakeServer({ v2SearchStatus: 404 })
    const { run } = makeTool(fake.url, { apiVersion: "v2" })
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("does not expose the v2 API (HTTP 404)")
    expect(text).toContain("No v1 fallback was attempted because apiVersion=v2 was selected explicitly")
    expect(fake.paths()).toEqual(["/api/v2/search"])
  })

  it("forced v1 never probes v2 and says that keywords were not sent", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url, { apiVersion: "v1" })
    const result = await run({ action: "search", query: "q", keywords: "USART baud", chip: "STM32F1" })
    expect(textOf(result)).toContain("apiVersion=v1 is in use, so `keywords` was not sent")
    expect(textOf(result)).toContain("legacy vector chunk")
    expect(result.details).toMatchObject({ apiVersion: "v1", keywords: "USART baud" })
    expect(fake.paths()).toEqual(["/api/search"])
    expect(fake.requests[0]!.body).not.toHaveProperty("keywords")
  })

  it("reads YOMA_DATASHEET_API=v1 from the injected environment", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url, { env: { YOMA_DATASHEET_API: "v1" } })
    await run({ action: "search", query: "q", chip: "STM32F1" })
    expect(fake.paths()).toEqual(["/api/search"])
  })

  it("chips in auto mode falls back from /api/v2/docs to the legacy manifest, with a note", async () => {
    const fake = await fakeServer({ v2DocsStatus: 404 })
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips" })
    expect(fake.paths()).toEqual(["/api/v2/docs", "/api/manifest"])
    expect(textOf(result)).toContain("has no GET /api/v2/docs (HTTP 404)")
    expect(textOf(result)).toContain("the legacy GET /api/manifest was used instead")
    expect(textOf(result)).toContain("STM32F1 (1)")
    expect(result.details).toMatchObject({ apiVersion: "v1", fallback: "v2-missing", families: 1, manuals: 1 })
  })
})

// ─── 3. chips via /api/v2/docs ────────────────────────────────────────────────

describe("datasheet chips via v2 docs", () => {
  it("groups documents by legacy family and counts manuals, without touching the manifest", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips" })
    const text = textOf(result)
    expect(fake.paths()).toEqual(["/api/v2/docs"])
    expect(text).toContain("3 indexed chip families, 4 manuals.")
    expect(text).toContain("AT32F (1)")
    expect(text).toContain("GENERAL (1, shared cross-chip bucket")
    expect(text).toContain("STM32F4 (2)")
    expect(result.details).toMatchObject({ action: "chips", apiVersion: "v2", families: 3, manuals: 4 })
  })

  it("lists one family's manuals with the document id to pass as rev", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips", chip: "STM32F4" })
    const text = textOf(result)
    expect(fake.requests[0]).toMatchObject({ path: "/api/v2/docs", query: { target: "STM32F4" } })
    expect(text).toContain('chip "STM32F4" — 2 manual(s) indexed')
    expect(text).toContain('rev "RM0090" [rm] — RM0090 (1–400) (revision Rev 9)')
    expect(text).toContain('rev "RM0386" [rm] — RM0386 (1–400) (revision Rev 2)')
    expect(fake.paths()).not.toContain("/api/manifest")
  })

  it("resolves a part number through the server's target filter", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "chips", chip: "AT32F421C8T7" }))
    expect(text).toContain('chip "AT32F" (resolved from "AT32F421C8T7") — 1 manual(s) indexed')
    expect(text).toContain('rev "AT32F011_DS" [datasheet] — 雅特力 AT32F011 数据手册')
  })

  it("uses the real docs-level 422 scope_unresolved shape with top-level candidate codes", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips", chip: "UNKNOWN" })
    const text = textOf(result)
    expect(fake.paths()).toEqual(["/api/v2/docs"])
    expect(text).toContain('could not resolve chip "UNKNOWN"')
    expect(text).toContain("认不出型号「UNKNOWN」对应的词表项")
    expect(text).toContain(`Candidates: ${CANDIDATES.map((c) => c.code).join(", ")}`)
    expect(text).not.toContain("does not expose the v2 API")
    expect(result.details).toMatchObject({
      action: "chips",
      apiVersion: "v2",
      errorCode: "scope_unresolved",
      candidates: CANDIDATES.map((c) => c.code),
    })
  })

  it("uses target_resolved from a 200 empty document list without an extra resolve call", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips", chip: "EMPTY" })
    expect(fake.paths()).toEqual(["/api/v2/docs"])
    expect(textOf(result)).toContain('No indexed documents matched chip "EMPTY". The server resolved it to: stm32f4.')
    expect(result.details).toMatchObject({ action: "chips", apiVersion: "v2", families: 0, manuals: 0 })
  })

  it("falls back to targets/resolve for candidates when an empty 200 has no target_resolved", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "chips", chip: "EMPTY_UNRESOLVED" })
    const text = textOf(result)
    expect(fake.paths()).toEqual(["/api/v2/docs", "/api/v2/targets/resolve"])
    expect(text).toContain('No indexed documents matched chip "EMPTY_UNRESOLVED"')
    expect(text).toContain(`Candidates: ${CANDIDATES.map((c) => c.code).join(", ")}`)
    expect(result.details).toMatchObject({ action: "chips", apiVersion: "v2", families: 0, manuals: 0 })
  })

  it("presents a docs-level 422 scope_unresolved with candidates instead of a generic failure", async () => {
    const fake = await fakeServer({
      v2DocsStatus: 422,
      v2DocsBody: {
        error: { code: "scope_unresolved", message: "no such target", hint: "pick a code" },
        candidates: CANDIDATES,
        unresolved: ["STM32F9"],
      },
    })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "chips", chip: "STM32F9" }))
    expect(text).toContain('could not resolve chip "STM32F9"')
    expect(text).toContain(`Candidates: ${CANDIDATES.map((c) => c.code).join(", ")}`)
    expect(text).not.toContain("does not expose the v2 API")
    expect(fake.paths()).toEqual(["/api/v2/docs"])
  })
})

// ─── 4. read_section / view_figure 不回归 ─────────────────────────────────────

describe("datasheet read_section and view_figure still follow v2 links", () => {
  it("reads a section from the parsed_path a v2 hit returned", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const search = await run({ action: "search", query: "clock", chip: "STM32F4" })
    const parsedPath = search.details.hits![0]!.parsed_path
    const result = await run({ action: "read_section", parsedPath, heading: "1.2 Clocks and startup" })
    expect(textOf(result)).toContain("## 1.2 Clocks and startup")
    expect(textOf(result)).toContain("clock body")
    expect(result.details).toMatchObject({ action: "read_section", mode: "section", heading: "1.2 Clocks and startup" })
  })

  it("attaches the figure a v2 hit's image_path points at", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const search = await run({ action: "search", query: "clock tree", chip: "STM32F4" })
    const imagePath = search.details.hits![1]!.image_path!
    const result = await run({ action: "view_figure", imagePath, caption: "Clock tree" })
    expect(textOf(result)).toContain("Figure (attached below): Clock tree")
    expect(imageOf(result)?.mimeType).toBe("image/png")
    expect(result.details).toMatchObject({ action: "view_figure", imagePath, mime: "image/png" })
    expect(result.details.bytes).toBe(TINY_PNG.length)
  })
})
