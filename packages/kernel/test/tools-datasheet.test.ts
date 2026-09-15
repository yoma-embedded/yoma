/**
 * datasheet 工具(host/tools/datasheet/{contract,client,session}.ts)的验收。纯函数层在 datasheet-domain.test.ts,
 * 这里是有网络的那一半,三层由假到真:
 *
 * 1. 契约:四个动作、没有确认门、summary、description 里的数字与常量同源。
 * 2. **假服务器**(test/fixtures/fetch-server.ts 上跑 /api/search + /api/manifest + /artifacts/):manifest 是从真服务器
 *    切下来的一片(fixtures/datasheet/manifest-slice.json,57 条:分卷、封面型号字符串、GENERAL 都是线上的形状);
 *    search 按真服务器的语义过滤 —— 名字不合法 422、给了 rev 只按 rev(不折 GENERAL)、没给 rev 时目标家族空集就只剩
 *    GENERAL、top_k 夹到 1..20 —— 这样"猜错 chip 没有任何报错信号"、"分卷基名一条都不回"、"GENERAL 分数压过本家"
 *    三种无声失败都能复现。再加两种坏服务器:接了连接不回包的(超时与中止),发了响应头就卡住 body 的
 *    (body 读取的超时与中止,审稿抓的 13 个存活变异大半在这)。
 * 3. **真服务器**(只在 YOMA_DATASHEET_LIVE=1 时跑,别让 CI 依赖公网):对内置默认地址做 chips / search /
 *    型号解析 / 分卷 / read_section / view_figure 各一次。
 *
 * 地址一律显式注入 env + configDir(mkdtemp):不注入的话开发机上真配的 YOMA_DATASHEET_SERVER 或真实的
 * ~/.yoma/.env 会决定断言(根 CLAUDE.md 的隔离纪律)。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { DEFAULT_DATASHEET_SERVER } from "../src/host/datasheet-server.ts"
import { encodeRel, type ManifestEntry, type SearchHit } from "../src/host/domain/datasheet/index.ts"
import { loadPhoton } from "../src/host/domain/image/photon.ts"
import { confirmNeeded, toolContract } from "../src/host/tools/contracts.ts"
import {
  createDatasheetClient,
  expireChipIndexCache,
  normalizeHit,
  resetChipIndexCache,
} from "../src/host/tools/datasheet/client.ts"
import {
  DATASHEET_ACTIONS,
  DATASHEET_CONTRACT,
  type DatasheetDetails,
  type DatasheetInput,
  datasheetSummary,
  DEFAULT_MAX_CHARS,
  DEFAULT_TOP_K,
  MAX_MAX_CHARS,
  MAX_TOP_K,
  MIN_MAX_CHARS,
} from "../src/host/tools/datasheet/contract.ts"
import { createDatasheetTool, type DatasheetToolOptions, serverUrl } from "../src/host/tools/datasheet/session.ts"
import { serveFetch } from "./fixtures/fetch-server.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const servers: { stop(): void }[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoma-datasheet-"))
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

/** 地址显式注入:env 里只放这一个变量,configDir 是空的临时目录。 */
function makeTool(server: string | undefined, options: DatasheetToolOptions = {}) {
  const dir = createTempDir()
  const tool = createDatasheetTool({
    configDir: dir,
    env: server === undefined ? {} : { YOMA_DATASHEET_SERVER: server },
    ...options,
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

/** typebox 的 Optional 把 description 藏在里层。 */
const descriptionOf = (schema: unknown): string => String((schema as { description?: string }).description ?? "")

/** 一个中止信号包成 harness 的 Context。 */
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

/** 现造一张 RGB PNG(每行一个过滤字节 0),尺寸按用例定。 */
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

function pngSize(base64: string): { width: number; height: number } {
  const buffer = Buffer.from(base64, "base64")
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ─── 假服务器 ─────────────────────────────────────────────────────────────────

/** 真服务器的 manifest 切片:AT32F(3)、AT32WB(2)、ESP32-P4(1 + TRM 10 卷)、GENERAL(3)、STM32F1(3 + RM0041 2 卷)、STM32F4(4 本 14 卷)、STM32G0(19,带封面型号)。 */
const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "datasheet", "manifest-slice.json"), "utf8"),
) as ManifestEntry[]

const MANUAL = [
  "# 1 Overview",
  "intro text",
  "## 1.2 Clocks and startup",
  "clock body",
  "# 2 Registers",
  "reg body",
].join("\n")
/** 真手册的形状:全 ##、转义、位域行提成标题、几百个编号节。 */
const BIG_MANUAL = [
  ...Array.from({ length: 400 }, (_, i) => [
    `## ${Math.floor(i / 10) + 1}.${(i % 10) + 1} Section number ${i + 1}`,
    `body of section ${i + 1}`,
  ]).flat(),
  "## 41.1 Baud rate register (USART\\_BRR)",
  "Note:",
  "Address offset: 0x08",
  "## Reset value: 0x0000 0000",
  "## Bits 15:4 DIV\\_Mantissa[11:0]: mantissa of USARTDIV",
  "mantissa text with the needle phrase here inside",
  "## Bits 3:0 DIV\\_Fraction[3:0]: fraction of USARTDIV",
  "fraction text",
  "## 41.2 Control register 1 (USART\\_CR1)",
  "cr1 text " + "x".repeat(3000),
].join("\n")
const PARSED_REL = "parsed/STM32F1/PM0063.md"
const SPACED_REL = "parsed/STM32 F1/PM 0063.md"
const BIG_REL = "parsed/STM32F4/RM0386_p801-1200.md"
const FIGURE_REL = "figures/STM32F1/PM0063/f1.png"
const BIG_FIGURE_REL = "figures/STM32F1/PM0063/big.png"
const HUGE_FIGURE_REL = "figures/STM32F1/PM0063/huge.png"
const TINY_PNG = makePng(1, 1)
const BIG_PNG = makePng(3000, 40)

const hit = (over: Partial<SearchHit>): SearchHit => ({
  text: "chunk text",
  manual_name: "PM0063",
  chip: "STM32F1",
  rev: "PM0063",
  page: 100,
  headings: "a > b",
  score: 0.5,
  kind: "",
  source_pdf: "",
  parsed_path: "",
  image_path: "",
  ...over,
})

const SAMPLE_HIT = hit({
  text: "USART baud rate chunk",
  page: 793,
  headings: "27 USART > 27.3.4 Fractional baud rate generation",
  score: 0.71,
  source_pdf: "source/STM32F1/PM0063.pdf",
  parsed_path: PARSED_REL,
})

// 目标家族一条都没中的时候真服务器返回的东西:跨芯片 GENERAL 语料,200,分数还不低。
const GENERAL_HITS: SearchHit[] = [
  ["PM0253", "The Cortex-M7 processor is a high performance 32-bit processor.", 0.6],
  ["PM0214", "The Cortex-M4 processor is a high performance 32-bit processor.", 0.58],
  ["PM0056", "The Cortex-M3 processor is a high performance 32-bit processor.", 0.56],
  ["PM0214", "NVIC priority grouping.", 0.55],
  ["PM0214", "SysTick calibration.", 0.54],
  ["PM0056", "Memory protection unit.", 0.53],
  ["PM0253", "Floating point unit.", 0.52],
].map(([rev, text, score]) =>
  hit({
    text: String(text),
    manual_name: `${rev}_Cortex`,
    chip: "GENERAL",
    rev: String(rev),
    page: 13,
    headings: "1.3 About the processor",
    score: Number(score),
    kind: "reference",
    source_pdf: `source/GENERAL/${rev}.pdf`,
    parsed_path: `parsed/GENERAL/${rev}.md`,
  }),
)

const AT32_HIT = hit({
  text: "AT32F011 flash 64 KB",
  manual_name: "雅特力 AT32F011 数据手册",
  chip: "AT32F",
  rev: "AT32F011_DS",
  page: 9,
  headings: "1 规格说明",
  score: 0.72,
  kind: "datasheet",
  source_pdf: "source/AT32F/AT32F011_DS.pdf",
  parsed_path: "parsed/AT32F/AT32F011_DS.md",
})
const ESP_HIT = hit({
  text: "ESP32-P4 GPIO matrix",
  manual_name: "ESP32-P4 DS",
  chip: "ESP32-P4",
  rev: "ESP32-P4_DS",
  page: 3,
  score: 0.66,
})
// STM32G0:本家四条分数都低于 GENERAL —— "GENERAL 压过本家"的场景
const G0_HITS: SearchHit[] = [0.3, 0.29, 0.28, 0.27].map((score, i) =>
  hit({
    text: `STM32G0 USART prescaler ${i + 1}`,
    manual_name: "RM0444",
    chip: "STM32G0",
    rev: "RM0444_p801-1200",
    page: 900 + i,
    score,
  }),
)
// STM32F4:RM0390 三卷各一条(第四卷 p1201-1321 没有),外加一条 RM0386
const F4_HITS: SearchHit[] = [
  hit({
    text: "RM0390 part 1 chunk",
    manual_name: "RM0390 (1–400)",
    chip: "STM32F4",
    rev: "RM0390_p1-400",
    page: 50,
    score: 0.6,
  }),
  hit({
    text: "RM0390 part 2 chunk",
    manual_name: "RM0390 (401–800)",
    chip: "STM32F4",
    rev: "RM0390_p401-800",
    page: 500,
    score: 0.8,
  }),
  hit({
    text: "RM0390 part 3 chunk",
    manual_name: "RM0390 (801–1200)",
    chip: "STM32F4",
    rev: "RM0390_p801-1200",
    page: 900,
    score: 0.7,
  }),
  hit({
    text: "RM0386 chunk",
    manual_name: "RM0386 (1–400)",
    chip: "STM32F4",
    rev: "RM0386_p1-400",
    page: 10,
    score: 0.65,
  }),
]

/** 各家族(无 rev 时)的本家命中池。 */
const POOLS: Record<string, SearchHit[]> = {
  STM32F1: [SAMPLE_HIT],
  AT32F: [AT32_HIT],
  AT32WB: [],
  STM32F4: F4_HITS,
  STM32G0: G0_HITS,
  "ESP32-P4": [ESP_HIT],
}

type Recorded = { method: string; path: string; body?: Record<string, unknown> }

interface FakeOptions {
  searchStatus?: number
  manifestStatus?: number
  /** manifest 永远不回(复现"索引拉不下来时按停止")。 */
  manifestHangs?: boolean
  /** manifest 回一个空数组(旧服务器 / 空索引)。 */
  manifestEmpty?: boolean
  /** /artifacts/ 一律回这个状态码。 */
  artifactStatus?: number
  /** /api/search 原样回这份 hits(不过滤、不夹 top_k)—— 复现坏字段 / 不理 top_k 的服务器。 */
  rawHits?: unknown[]
}

/**
 * 假数据手册服务器:/api/search + /api/manifest + /artifacts/。search 与真服务器同解:名字不合法 422;
 * 给了 rev 就只按 chip+rev 过滤(不折 GENERAL);没给 rev 时 chip 的池 + GENERAL 池,按分数取前 top_k(夹到 1..20)。
 */
async function fakeServer(options: FakeOptions = {}) {
  const requests: Recorded[] = []
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  const server = await serveFetch(async (req) => {
    const { pathname } = new URL(req.url)
    const entry: Recorded = { method: req.method, path: pathname }
    if (req.method === "POST") {
      entry.body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined
    }
    requests.push(entry)
    if (pathname === "/api/manifest") {
      if (options.manifestHangs) return new Promise<Response>(() => {})
      if (options.manifestStatus) return new Response("nope", { status: options.manifestStatus })
      return Response.json(options.manifestEmpty ? [] : MANIFEST)
    }
    if (pathname === "/api/search" && req.method === "POST") {
      if (options.searchStatus === 404) return new Response("not found", { status: 404 })
      if (options.searchStatus) return new Response("boom", { status: options.searchStatus })
      if (options.rawHits) return Response.json({ hits: options.rawHits })
      const body = entry.body ?? {}
      const chip = String(body.chip ?? "")
      const rev = body.rev === undefined ? undefined : String(body.rev)
      if (!body.query || !chip) return Response.json({ detail: "query and chip are required" }, { status: 422 })
      if (!NAME_RE.test(chip) || (rev !== undefined && !NAME_RE.test(rev))) {
        return Response.json({ detail: `invalid name` }, { status: 422 })
      }
      const k = Math.max(1, Math.min(20, Number(body.top_k) || 6))
      const own = POOLS[chip] ?? []
      const pool = rev !== undefined ? own.filter((h) => h.rev === rev) : [...own, ...GENERAL_HITS]
      return Response.json({ hits: pool.sort((a, b) => b.score - a.score).slice(0, k) })
    }
    if (pathname.startsWith("/artifacts/")) {
      if (options.artifactStatus) return new Response("boom", { status: options.artifactStatus })
      if (pathname === `/artifacts/${encodeRel(PARSED_REL)}` || pathname === `/artifacts/${encodeRel(SPACED_REL)}`) {
        return new Response(MANUAL)
      }
      if (pathname === `/artifacts/${encodeRel(BIG_REL)}`) return new Response(BIG_MANUAL)
      if (pathname === `/artifacts/${encodeRel(FIGURE_REL)}`) {
        return new Response(TINY_PNG, { headers: { "Content-Type": "image/png" } })
      }
      if (pathname === `/artifacts/${encodeRel(BIG_FIGURE_REL)}`) {
        return new Response(BIG_PNG, {
          headers: { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) },
        })
      }
      if (pathname === `/artifacts/${encodeRel(HUGE_FIGURE_REL)}`) {
        // 声明 99 MB:工具看一眼 content-length 就该拒,不该去读
        return new Response(TINY_PNG, { headers: { "Content-Type": "image/png", "Content-Length": "99000000" } })
      }
    }
    return new Response("nope", { status: 404 })
  })
  servers.push(server)
  return { url: server.url, requests, paths: () => requests.map((r) => r.path) }
}

/** 接了连接就再也不回包的服务器 —— 复现"默认地址那台机器挂了"的最坏形态。 */
async function deadServer() {
  const server = await serveFetch(() => new Promise<Response>(() => {}))
  servers.push(server)
  return server.url
}

/**
 * 裸 node:http 服务器:发了响应头(和一截 body)就卡住,或者直接掐断连接 —— serveFetch 给不出这两种形态。
 * handler 返回 true 表示已经处理;否则 404。
 */
async function rawServer(handler: (req: IncomingMessage, res: ServerResponse) => boolean | void): Promise<string> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404)
      res.end("nope")
    }
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  servers.push({
    stop() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  })
  return `http://127.0.0.1:${port}`
}

/** 每个端点都发头 + 半截 body,永远不 end。 */
const stallingServer = (status = 200) =>
  rawServer((req, res) => {
    const json = req.url === "/api/search" || req.url === "/api/manifest"
    res.writeHead(status, { "Content-Type": json ? "application/json" : "text/plain" })
    res.write(json ? '{"hits":[{"text":"partial' : "## 1 Overview\npartial")
    return true
  })

// ─── 1. 契约 ──────────────────────────────────────────────────────────────────

describe("datasheet contract", () => {
  it("has the four actions, no confirm gate, and is registered in the contract table", () => {
    expect(DATASHEET_ACTIONS).toEqual(["search", "read_section", "view_figure", "chips"])
    expect(toolContract("datasheet")).toBe(DATASHEET_CONTRACT)
    expect(DATASHEET_CONTRACT.label).toBe("数据手册")
    for (const action of DATASHEET_ACTIONS) {
      expect(confirmNeeded("datasheet", { action, chip: "STM32F4", query: "q" })).toBeUndefined()
    }
    expect(DATASHEET_CONTRACT.guidelines).toHaveLength(2)
  })

  it("keeps the clamp numbers in the parameter descriptions in sync with the constants, and uses real example revs", () => {
    const schema = DATASHEET_CONTRACT.parameters.properties
    expect(descriptionOf(schema.topK)).toContain(`default ${DEFAULT_TOP_K}, clamped 1..${MAX_TOP_K}`)
    expect(descriptionOf(schema.maxChars)).toContain(
      `default ${DEFAULT_MAX_CHARS}, clamped ${MIN_MAX_CHARS}..${MAX_MAX_CHARS}`,
    )
    expect(DEFAULT_TOP_K).toBe(6)
    expect(MAX_TOP_K).toBe(20) // 服务器 search_api 自己也夹到 20
    expect(DATASHEET_CONTRACT.description).not.toMatch(/confirm|ask the user before/i)
    // 例子里的 rev 得真的在索引里:RM0090 是 ST 的文档号,但语料里只有 RM0390 那几本
    expect(DATASHEET_CONTRACT.description).not.toContain("RM0090")
    expect(descriptionOf(schema.rev)).not.toContain("RM0090")
    expect(MANIFEST.some((e) => e.rev.startsWith("RM0390"))).toBe(true)
  })

  it("summary says what will be searched / read, and tolerates half-streamed input", () => {
    expect(datasheetSummary({ action: "search", chip: "STM32F4", rev: "RM0390", query: "USART baud rate" })).toBe(
      'search STM32F4/RM0390 "USART baud rate"',
    )
    expect(datasheetSummary({ action: "search", chip: "STM32F4", query: "x".repeat(80) })).toBe(
      `search STM32F4 "${"x".repeat(57)}…"`,
    )
    expect(datasheetSummary({ action: "search" })).toBe("search")
    expect(datasheetSummary({ action: "chips" })).toBe("chips")
    expect(datasheetSummary({ action: "chips", chip: "AT32F" })).toBe("chips AT32F")
    expect(datasheetSummary({ action: "read_section", parsedPath: PARSED_REL, heading: "1.2 Clocks" })).toBe(
      `read_section ${PARSED_REL} › 1.2 Clocks`,
    )
    expect(datasheetSummary({ action: "view_figure", imagePath: FIGURE_REL })).toBe(`view_figure ${FIGURE_REL}`)
    expect(datasheetSummary({})).toBe("")
  })
})

// ─── 2. 地址 ──────────────────────────────────────────────────────────────────

describe("datasheet server address", () => {
  it("nothing configured resolves to the built-in default — install and query, no address to type", () => {
    expect(serverUrl({ env: {}, configDir: createTempDir() })).toBe(DEFAULT_DATASHEET_SERVER)
  })

  it("the configDir's .env is honoured and options.server wins over everything", () => {
    const dir = createTempDir()
    writeFileSync(join(dir, ".env"), "YOMA_DATASHEET_SERVER=http://from-dotenv/\n")
    expect(serverUrl({ env: {}, configDir: dir })).toBe("http://from-dotenv")
    expect(serverUrl({ env: { YOMA_DATASHEET_SERVER: "http://from-env" }, configDir: dir })).toBe("http://from-env")
    expect(
      serverUrl({ server: "http://from-option", env: { YOMA_DATASHEET_SERVER: "http://from-env" }, configDir: dir }),
    ).toBe("http://from-option")
  })

  it("says how to re-enable lookup when it is switched off, and forbids inventing chip facts", async () => {
    const { run } = makeTool("off")
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("YOMA_DATASHEET_SERVER=off")
    expect(text).toContain("Do not invent")
    expect(textOf(await run({ action: "chips" }))).toContain("DATASHEET LOOKUP UNAVAILABLE")
  })

  it("builtIn:null reproduces the unconfigured path without touching the environment", async () => {
    const { run } = makeTool(undefined, { builtIn: null })
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("YOMA_DATASHEET_SERVER")
  })

  it("the tool actually reads <configDir>/.env (the session manager passes configDir)", async () => {
    const fake = await fakeServer()
    const dir = createTempDir()
    writeFileSync(join(dir, ".env"), `YOMA_DATASHEET_SERVER=${fake.url}\n`)
    const tool = createDatasheetTool({ configDir: dir, env: {} })
    const result = await tool.execute(
      "c1",
      { action: "search", query: "usart", chip: "STM32F1" },
      () => {},
      { env: new NodeExecutionEnv({ cwd: dir }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
    expect(textOf(result)).toContain("USART baud rate chunk")
  })
})

// ─── 3. search ────────────────────────────────────────────────────────────────

describe("datasheet search", () => {
  it("posts to /api/search and formats citations", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "usart baud", chip: "STM32F1", topK: 3 })
    const text = textOf(result)
    expect(text).toContain("[#1] PM0063 (STM32F1) p.793")
    expect(text).toContain("USART baud rate chunk")
    expect(text).toContain('action "read_section"')
    expect(result.details).toMatchObject({ action: "search", chip: "STM32F1", topK: 3 })
    expect(result.details.resolvedChip).toBeUndefined()
    // 真服务器无 rev 时把 GENERAL 折进来:本家一条 + GENERAL 两条凑满 top_k 3,本家分数高排第一。
    expect(result.details.hits!.map((h) => h.chip)).toEqual(["STM32F1", "GENERAL", "GENERAL"])
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/search",
      body: { query: "usart baud", chip: "STM32F1", top_k: 3 },
    })
    expect(fake.requests[0]!.body).not.toHaveProperty("rev")
    expect(fake.paths()).toEqual(["/api/search"]) // chip 对了就不为 manifest 付钱
  })

  it("clamps topK to the server's range and requires query and chip", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    await run({ action: "search", query: "q", chip: "STM32F1", topK: 99 })
    expect(fake.requests[0]!.body).toMatchObject({ top_k: 20 })
    await run({ action: "search", query: "q", chip: "STM32F1", topK: 0 })
    expect(fake.requests[1]!.body).toMatchObject({ top_k: 1 })
    await run({ action: "search", query: "q", chip: "STM32F1" })
    expect(fake.requests[2]!.body).toMatchObject({ top_k: 6 })
    await expect(run({ action: "search", chip: "STM32F1" })).rejects.toThrow(/search requires query/)
    await expect(run({ action: "search", query: "q" })).rejects.toThrow(/search requires chip/)
    await expect(run({ action: "search", query: "  ", chip: "STM32F1" })).rejects.toThrow(/search requires query/)
  })

  it("never returns more than topK even when the server ignores top_k, and survives hits with missing or odd fields", async () => {
    const raw: unknown[] = [
      { text: "no score", manual_name: "M", chip: "STM32F1", rev: "PM0063", page: 1, headings: "h" },
      "not an object",
      { text: null, chip: null, score: "0.4", page: "7" },
      ...Array.from({ length: 30 }, (_, i) => hit({ text: `flood ${i}`, score: 0.3 })),
    ]
    const fake = await fakeServer({ rawHits: raw })
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32F1", topK: 4 })
    expect(result.details.hits).toHaveLength(4)
    const text = textOf(result)
    expect(text).toContain("(score 0.00)") // score 缺了不炸
    expect(text).not.toContain("undefined")
    expect(normalizeHit({ chip: null, score: "0.4", page: "7" })).toMatchObject({
      chip: "",
      score: 0.4,
      page: 7,
      text: "",
    })
    expect(normalizeHit("x")).toBeUndefined()
  })

  it("a hit with a blank chip cannot fake a family hit: it is treated as off-target and triggers resolution", async () => {
    const fake = await fakeServer({ rawHits: [{ text: "blank chip", chip: "", score: 0.9, rev: "" }] })
    const { run } = makeTool(fake.url)
    await run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    expect(fake.paths()).toContain("/api/manifest")
  })

  // ── chip 猜错:真会话里 11 次 search 全落空、模型据此说"没收录"的那条路 ──────

  it("resolves a part number to its indexed family and re-runs the query", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "flash size", chip: "AT32F011C8T7", topK: 5 })
    const text = textOf(result)
    expect(text).toContain('Searched "AT32F" instead')
    expect(text).toContain("[#1] 雅特力 AT32F011 数据手册") // 改对名字之后本家排第一;GENERAL 照常折在后面
    expect(result.details.hits![0]!.chip).toBe("AT32F")
    expect(result.details.resolvedChip).toBe("AT32F")
    // 一次落空的搜索 + 一次 manifest + 一次改对了的搜索。
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest", "/api/search"])
    expect(fake.requests[2]!.body).toMatchObject({ chip: "AT32F", top_k: 5 })
  })

  it("caches the chip index across calls and tools (one manifest per process) until it expires", async () => {
    const fake = await fakeServer()
    await makeTool(fake.url).run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    await makeTool(fake.url).run({ action: "search", query: "q", chip: "AT32F402" })
    await makeTool(fake.url).run({ action: "chips" })
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(1)
    expireChipIndexCache()
    await makeTool(fake.url).run({ action: "chips" })
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(2)
  })

  it("fetches the manifest once even when two first-time searches race", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    await Promise.all([
      run({ action: "search", query: "q", chip: "AT32F011C8T7" }),
      run({ action: "search", query: "q", chip: "AT32F402" }),
    ])
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(1)
  })

  it("refuses to answer from GENERAL prose when the chip is not indexed at all", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "touch threshold", chip: "TTP233" })
    const text = textOf(result)
    expect(text).toContain("NO SEARCH PERFORMED")
    expect(text).toContain("nothing indexed looks like it. Indexed families (7)")
    expect(text).not.toContain("Cortex-M7 processor")
    expect(result.details.hits).toBeUndefined()
    expect(fake.paths().filter((p) => p === "/api/search")).toHaveLength(1) // 解析不出来就不再多打一枪
    const near = textOf(await run({ action: "search", query: "q", chip: "STM32H7" }))
    expect(near).toContain("Closest index names: STM32F1, STM32F4, STM32G0.")
  })

  it("reports ambiguity with the candidates instead of guessing a family", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "AT32" }))
    expect(text).toContain("matches several indexed families — pick one: AT32F, AT32WB")
    expect(fake.paths().filter((p) => p === "/api/search")).toHaveLength(1)
  })

  it("digs the family's own chunks out when GENERAL outscores them, within the topK budget, counting honestly", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const three = await run({ action: "search", query: "USART prescaler", chip: "STM32G0", topK: 3 })
    expect(textOf(three)).toContain('NOTE: 7 cross-chip [GENERAL] chunk(s) outscored the best "STM32G0" chunk')
    expect(textOf(three)).toContain('the 3 best "STM32G0" chunk(s) are listed first.')
    expect(three.details.hits!.map((h) => h.chip)).toEqual(["STM32G0", "STM32G0", "STM32G0"])
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest", "/api/search"])
    expect(fake.requests[2]!.body).toMatchObject({ chip: "STM32G0", top_k: 20 })

    const six = await run({ action: "search", query: "USART prescaler", chip: "STM32G0", topK: 6 })
    expect(six.details.hits!.map((h) => h.chip)).toEqual([
      "STM32G0",
      "STM32G0",
      "STM32G0",
      "STM32G0",
      "GENERAL",
      "GENERAL",
    ])
    expect(textOf(six)).toContain("then the top 2 GENERAL")
    expect(textOf(six).indexOf("STM32G0 USART prescaler 1")).toBeLessThan(textOf(six).indexOf("Cortex-M7 processor"))
  })

  it("with topK 20 the first search already carries the family's chunks, so nothing extra is fetched", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32G0", topK: 20 })
    const chips = result.details.hits!.map((h) => h.chip)
    expect(chips).toHaveLength(11)
    expect(chips.filter((c) => c === "STM32G0")).toHaveLength(4)
    expect(fake.paths()).toEqual(["/api/search"])
  })

  it("says so when the chip IS indexed but nothing in it shows up even in the top 20", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "AT32WB" })
    const text = textOf(result)
    expect(text).toContain('chip "AT32WB" IS indexed (2 manual(s))')
    expect(text).toContain("cross-chip GENERAL corpus")
    expect(text).toContain('rev "AT32WB415_DS"')
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest", "/api/search"])
  })

  it("without a readable manifest an all-GENERAL reply is still flagged as a miss (old servers, network trouble)", async () => {
    const fake = await fakeServer({ manifestStatus: 404 })
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    const text = textOf(result)
    expect(text).toContain("Treat this as a MISS")
    expect(text).toContain("manifest could not be read")
    expect(text).toContain("PM0253_Cortex") // 命中仍原样给,让模型自己看
    expect(result.details.resolvedChip).toBeUndefined()
    // 端点不在也缓存:第二次不再打 manifest。
    await run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(1)
  })

  it("a manifest whose connection drops does not block the search, is flagged, and is not cached as a failure", async () => {
    let manifestCalls = 0
    const url = await rawServer((req, res) => {
      if (req.url === "/api/manifest") {
        manifestCalls++
        req.socket.destroy()
        return true
      }
      if (req.url === "/api/search") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ hits: GENERAL_HITS.slice(0, 2) }))
        return true
      }
    })
    const { run } = makeTool(url)
    const first = await run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    expect(textOf(first)).toContain("Treat this as a MISS")
    expect(first.details.hits).toHaveLength(2)
    await run({ action: "search", query: "q", chip: "AT32F011C8T7" })
    expect(manifestCalls).toBe(2) // 失败不缓存
    expect(textOf(await run({ action: "chips" }))).toContain("DATASHEET LOOKUP UNAVAILABLE")
  })

  // ── 名字不合法:服务器会 422,而 422 不该被翻成"服务器挂了" ──────────────────

  it("resolves an invalid spelling through the index instead of letting the server 422", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "gpio matrix", chip: "esp32 p4" })
    const text = textOf(result)
    expect(text).toContain('the index name is "ESP32-P4"')
    expect(text).toContain("ESP32-P4 GPIO matrix")
    expect(text).not.toContain("UNAVAILABLE")
    expect(result.details.resolvedChip).toBe("ESP32-P4")
    expect(fake.paths()).toEqual(["/api/manifest", "/api/search"])
  })

  it("explains an invalid spelling when there is no manifest to resolve it with", async () => {
    const fake = await fakeServer({ manifestStatus: 404 })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "esp32 p4" }))
    expect(text).toContain("is not a valid index name")
    expect(fake.paths()).toEqual(["/api/manifest"])
  })

  it("translates a server-side 422 into 'fix the name', not 'server down'", async () => {
    const fake = await fakeServer({ searchStatus: 422 })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("rejected the chip / rev name (HTTP 422: boom)")
    expect(text).not.toContain("UNAVAILABLE")
  })

  // ── rev:分卷、拼法、不存在 ─────────────────────────────────────────────────

  it("a split manual's base rev is answered from one family-wide query when that already holds enough of its parts", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32F4", rev: "RM0390", topK: 2 })
    const text = textOf(result)
    expect(text).toContain(
      "stored as 4 page-range parts on the server (RM0390_p1-400, RM0390_p401-800, RM0390_p801-1200, RM0390_p1201-1321)",
    )
    expect(text).toContain("one family-wide query already held enough chunks from them")
    expect(result.details.hits!.map((h) => h.rev)).toEqual(["RM0390_p401-800", "RM0390_p801-1200"])
    expect(result.details.searchedRevs).toEqual([
      "RM0390_p1-400",
      "RM0390_p401-800",
      "RM0390_p801-1200",
      "RM0390_p1201-1321",
    ])
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest", "/api/search"])
    expect(fake.requests[2]!.body).toMatchObject({ chip: "STM32F4", top_k: 20 })
    expect(fake.requests[2]!.body).not.toHaveProperty("rev")
  })

  it("… and falls back to one query per part, merged by score, when the family-wide query is not enough", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32F4", rev: "rm0390", topK: 4 })
    const text = textOf(result)
    expect(text).toContain("each part was queried (4 queries) and the results merged by score")
    expect(result.details.hits!.map((h) => h.rev)).toEqual(["RM0390_p401-800", "RM0390_p801-1200", "RM0390_p1-400"])
    // 第一枪(rev 原样)+ manifest + 家族一枪 + 四卷各一枪;并发发出,落地顺序不定,比集合。
    expect(fake.paths().filter((p) => p === "/api/search")).toHaveLength(6)
    expect(
      fake.requests
        .slice(3)
        .map((r) => r.body!.rev)
        .sort(),
    ).toEqual(["RM0390_p1-400", "RM0390_p1201-1321", "RM0390_p401-800", "RM0390_p801-1200"])
  })

  it("re-spells a rev given in the wrong case", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32F1", rev: "pm0063" })
    expect(textOf(result)).toContain('rev "pm0063" is spelled "PM0063" in the index')
    expect(textOf(result)).toContain("USART baud rate chunk")
    expect(result.details.searchedRevs).toEqual(["PM0063"])
  })

  it("an exact chip + exact rev is searched once; an empty answer says the manual exists but did not match", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "STM32F1", rev: "PM0068" })
    const text = textOf(result)
    expect(text).toContain('chip "STM32F1" is indexed and rev "PM0068" exists, but nothing in that manual matched')
    expect(text).toContain("(no matching datasheet chunks found)")
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest"])
  })

  it("flags a rev that does not exist for the family and lists the ones that do", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "AT32F011", rev: "RM_AT32F011" }))
    expect(text).toContain('no manual with rev "RM_AT32F011" exists for chip "AT32F"')
    expect(text).toContain('rev "AT32F011_DS"')
    expect(text).toContain("(no matching datasheet chunks found)")
  })

  it("resolves a part number AND a pinned rev together", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "q", chip: "AT32F011C8T7", rev: "AT32F011_DS" })
    expect(textOf(result)).toContain('Searched "AT32F" instead')
    expect(textOf(result)).toContain("雅特力 AT32F011 数据手册")
    expect(fake.paths()).toEqual(["/api/search", "/api/manifest", "/api/search"])
    expect(fake.requests[2]!.body).toMatchObject({ chip: "AT32F", rev: "AT32F011_DS" })
  })

  it("points a part number at the manuals whose cover lists it (real cover strings with x wildcards)", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "USART prescaler", chip: "STM32G081RB" }))
    expect(text).toContain('Manuals whose cover lists STM32G081RB: rev "DS12231"')
    expect(text).toContain('rev "RM0444"')
    expect(text).toContain("4 parts")
  })

  it("searches GENERAL itself when asked for it", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "search", query: "NVIC", chip: "GENERAL", topK: 2 })
    expect(result.details.hits!.map((h) => h.chip)).toEqual(["GENERAL", "GENERAL"])
    expect(fake.paths()).toEqual(["/api/search"])
  })

  // ── 服务器出错 ───────────────────────────────────────────────────────────────

  it("explains the missing endpoint when the server has no /api/search", async () => {
    const fake = await fakeServer({ searchStatus: 404 })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("does not expose POST /api/search")
    expect(text).toContain("read_section and view_figure still work")
  })

  it("explains an unpublished index (503) without calling the server unreachable", async () => {
    const fake = await fakeServer({ searchStatus: 503 })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("no search index published yet (HTTP 503: boom)")
    expect(text).not.toContain("Could not reach")
  })

  it("degrades instead of throwing on a real server error", async () => {
    const fake = await fakeServer({ searchStatus: 500 })
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("HTTP 500")
  })

  it("degrades when the server is unreachable, and forbids inventing chip facts", async () => {
    const { run } = makeTool("http://127.0.0.1:1")
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("Do not invent")
    expect(text).toContain("http://127.0.0.1:1")
    expect(text).toContain("environment variable YOMA_DATASHEET_SERVER")
    expect(text).toContain("users do not need to host a server")
    expect(text).toContain(DEFAULT_DATASHEET_SERVER)
  })
})

// ─── 4. chips ─────────────────────────────────────────────────────────────────

describe("datasheet chips", () => {
  it("lists the indexed families with document counts, and one family's manuals with parts grouped", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const all = await run({ action: "chips" })
    expect(textOf(all)).toContain("7 indexed chip families, 32 manuals (57 page-range parts)")
    expect(textOf(all)).toContain("AT32F (3)")
    expect(textOf(all)).toContain("STM32F4 (4)")
    expect(textOf(all)).toContain("GENERAL (3, shared cross-chip bucket")
    expect(all.details).toMatchObject({ action: "chips", families: 7, manuals: 32 })

    const one = await run({ action: "chips", chip: "AT32F011C8T7" })
    expect(textOf(one)).toContain('chip "AT32F" (resolved from "AT32F011C8T7") — 3 manual(s) indexed')
    expect(textOf(one)).toContain('rev "AT32F011_DS" [datasheet]')
    expect(one.details).toMatchObject({ chip: "AT32F", manuals: 3 })

    const split = await run({ action: "chips", chip: "STM32F4" })
    expect(textOf(split)).toContain('chip "STM32F4" — 4 manual(s) (14 page-range parts) indexed')
    expect(textOf(split)).toMatch(
      /rev "RM0390" \[datasheet\] — .*\(split into 4 parts: p1-400, p401-800, p801-1200, p1201-1321; "RM0390" searches all of them, "RM0390_p1-400" one\)/,
    )
    expect(split.details).toMatchObject({ manuals: 4 })

    const covered = await run({ action: "chips", chip: "STM32G070RB" })
    expect(textOf(covered)).toContain('Manuals whose cover lists STM32G070RB: rev "DS12766"')
    expect(textOf(covered)).toContain('rev "RM0454"')
  })

  it("describes GENERAL as the shared bucket instead of telling the model to search it", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const text = textOf(await run({ action: "chips", chip: "GENERAL" }))
    expect(text).toContain("shared cross-chip bucket")
    expect(text).toContain('rev "PM0214"')
    expect(text).not.toContain("Search it with")
  })

  it("lists candidates for an unknown or ambiguous chip, and explains a server without a manifest (or with an empty one)", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const unknown = await run({ action: "chips", chip: "TTP233" })
    expect(textOf(unknown)).toContain("not an indexed chip family")
    expect(unknown.details).toMatchObject({ chip: "TTP233", families: 7 })
    expect(textOf(await run({ action: "chips", chip: "AT32" }))).toContain("pick one: AT32F, AT32WB")

    const old = await fakeServer({ manifestStatus: 404 })
    expect(textOf(await makeTool(old.url).run({ action: "chips" }))).toContain("does not expose GET /api/manifest")
    resetChipIndexCache()
    const empty = await fakeServer({ manifestEmpty: true })
    expect(textOf(await makeTool(empty.url).run({ action: "chips" }))).toContain(
      "does not expose GET /api/manifest (or it is empty)",
    )
  })
})

// ─── 5. read_section ──────────────────────────────────────────────────────────

describe("datasheet read_section", () => {
  it("returns the whole file when it fits", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const full = await run({ action: "read_section", parsedPath: PARSED_REL })
    expect(textOf(full)).toBe(MANUAL)
    expect(full.details).toMatchObject({ mode: "full", sections: 3, chars: MANUAL.length })
    const spaced = await run({ action: "read_section", parsedPath: SPACED_REL }) // 路径按段编码
    expect(textOf(spaced)).toBe(MANUAL)
  })

  it("returns a ToC of numbered sections, capped by maxChars, when the file does not fit", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const toc = await run({ action: "read_section", parsedPath: BIG_REL, maxChars: 1000 })
    expect(toc.details).toMatchObject({ mode: "toc", sections: 405, truncated: true })
    const text = textOf(toc)
    expect(text.length).toBeLessThan(1400)
    expect(text).toContain("# Sections\n  1.1 Section number 1\n") // 编号深度 2,缩进两格
    expect(text).toContain("[truncated at 1000 chars")
    const wide = await run({ action: "read_section", parsedPath: BIG_REL }) // 默认 12000:整本放不下,目录放得下
    expect(textOf(wide)).toContain("… (+102 more headings)") // 402 个编号节,目录列 300
    expect(textOf(wide)).toContain("(3 unnumbered headings — bit fields, notes, figure captions — not listed")
    expect(textOf(wide)).not.toContain("Reset value")
  })

  it("extracts one section by breadcrumb, with 1-based line numbers", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({
      action: "read_section",
      parsedPath: PARSED_REL,
      heading: "1 Overview > 1.2 Clocks and startup",
    })
    expect(textOf(result)).toBe("## 1.2 Clocks and startup\nclock body")
    expect(result.details).toMatchObject({
      mode: "section",
      heading: "1.2 Clocks and startup",
      level: 2,
      lines: [3, 4],
    })
  })

  it("a register section from a real hit's breadcrumb comes back whole: escapes resolved, bit-field lines included", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({
      action: "read_section",
      parsedPath: BIG_REL,
      heading: "41 USART > 41.1 Baud rate register (USART_BRR)",
    })
    const text = textOf(result)
    expect(result.details).toMatchObject({
      mode: "section",
      heading: "41.1 Baud rate register (USART\\_BRR)",
      truncated: false,
    })
    expect(text).toContain("Bits 15:4 DIV\\_Mantissa")
    expect(text).toContain("Bits 3:0 DIV\\_Fraction")
    expect(text).not.toContain("USART\\_CR1")
    expect(text).not.toContain("Closest heading")
  })

  it("names the heading it actually matched when it is not the one asked for", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "read_section", parsedPath: PARSED_REL, heading: "1.2 Clocks" })
    expect(textOf(result)).toContain('(Closest heading to "1.2 Clocks": "1.2 Clocks and startup")')
    expect(result.details.heading).toBe("1.2 Clocks and startup")
  })

  it("falls back to a text window (with a truncation marker when cut), then to the ToC", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const window = await run({ action: "read_section", parsedPath: PARSED_REL, heading: "clock body" })
    expect(window.details).toMatchObject({ mode: "window", truncated: false })
    expect(textOf(window)).toContain("showing a text window")
    const cut = await run({
      action: "read_section",
      parsedPath: BIG_REL,
      heading: "needle phrase here",
      maxChars: 1000,
    })
    expect(cut.details).toMatchObject({ mode: "window", truncated: true, chars: 1000 })
    expect(textOf(cut)).toContain("needle phrase here")
    expect(textOf(cut)).toContain("[truncated at 1000 chars")
    const toc = await run({ action: "read_section", parsedPath: PARSED_REL, heading: "zzz nothing" })
    expect(toc.details.mode).toBe("toc")
    expect(textOf(toc)).toContain("## 1.2 Clocks and startup")
  })

  it("reports a manual missing from the server (404) or unreadable (500) as guidance, and refuses non-artifact paths without a request", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    expect(textOf(await run({ action: "read_section", parsedPath: "parsed/NOPE/X.md" }))).toContain(
      "Parsed manual not on the server",
    )
    const before = fake.requests.length
    expect(textOf(await run({ action: "read_section", parsedPath: "../etc/passwd" }))).toContain("Not a parsed_path")
    expect(textOf(await run({ action: "read_section", parsedPath: "/parsed/x.md" }))).toContain("Not a parsed_path")
    expect(fake.requests.length).toBe(before)
    await expect(run({ action: "read_section" })).rejects.toThrow(/requires parsedPath/)
    const broken = await fakeServer({ artifactStatus: 500 })
    const text = textOf(await makeTool(broken.url).run({ action: "read_section", parsedPath: PARSED_REL }))
    expect(text).toContain("HTTP 500")
    expect(text).toContain("Rely on search chunks")
  })
})

// ─── 6. view_figure ───────────────────────────────────────────────────────────

describe("datasheet view_figure", () => {
  it("returns the caption text plus the image content block", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "view_figure", imagePath: FIGURE_REL, caption: "Figure 2." })
    expect(textOf(result)).toContain("Figure (attached below): Figure 2.")
    const image = imageOf(result)!
    expect(image.mimeType).toBe("image/png")
    expect(image.data).toBe(TINY_PNG.toString("base64"))
    expect(result.details).toMatchObject({
      action: "view_figure",
      imagePath: FIGURE_REL,
      mime: "image/png",
      bytes: TINY_PNG.length,
    })
  })

  it("shrinks a figure wider than the provider limit before attaching it (when the image backend is present)", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "view_figure", imagePath: BIG_FIGURE_REL })
    const image = imageOf(result)!
    expect(image.mimeType).toBe("image/png")
    if (loadPhoton()) {
      expect(pngSize(image.data).width).toBeLessThanOrEqual(2000)
      expect(textOf(result)).toContain("[Image: original 3000x40")
    } else {
      expect(image.data).toBe(BIG_PNG.toString("base64"))
    }
    expect(result.details.bytes).toBe(BIG_PNG.length)
  })

  it("refuses to download a figure whose declared size is over the cap, in MiB", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    const result = await run({ action: "view_figure", imagePath: HUGE_FIGURE_REL })
    expect(textOf(result)).toBe(`Figure ${HUGE_FIGURE_REL} is 94.4 MiB (cap 16.0 MiB); not downloading it.`)
    expect(imageOf(result)).toBeUndefined()
    expect(result.details.bytes).toBe(99000000)
  })

  it("rejects unsupported extensions and bad paths without touching the server, and reports a 404 as guidance", async () => {
    const fake = await fakeServer()
    const { run } = makeTool(fake.url)
    expect(textOf(await run({ action: "view_figure", imagePath: "figures/F1/RM0008/f1.svg" }))).toContain(
      "Not a supported figure image path",
    )
    expect(textOf(await run({ action: "view_figure", imagePath: "figures/../f1.png" }))).toContain("Not an image_path")
    expect(fake.requests).toHaveLength(0)
    expect(textOf(await run({ action: "view_figure", imagePath: "figures/NOPE/X/f.png" }))).toContain(
      "Figure not on the server",
    )
    await expect(run({ action: "view_figure" })).rejects.toThrow(/requires imagePath/)
  })
})

// ─── 7. 超时与中止 ────────────────────────────────────────────────────────────

describe("datasheet timeouts and abort", () => {
  it("a server that accepts the connection but never answers times out instead of hanging the turn", async () => {
    const url = await deadServer()
    const { run } = makeTool(url, { timeoutMs: 300 })
    const started = Date.now()
    const text = textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))
    expect(text).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(text).toContain("timed out after 0 s")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("a server that sends headers and then stalls the body times out on the body read, with the right budget per action", async () => {
    const url = await stallingServer()
    const { run } = makeTool(url, { timeoutMs: 300, artifactTimeoutMs: 30_000 })
    const started = Date.now()
    expect(textOf(await run({ action: "search", query: "q", chip: "STM32F1" }))).toContain("timed out after 0 s")
    expect(Date.now() - started).toBeLessThan(2000)

    const slowArtifacts = makeTool(url, { timeoutMs: 30_000, artifactTimeoutMs: 300 })
    const again = Date.now()
    expect(textOf(await slowArtifacts.run({ action: "read_section", parsedPath: PARSED_REL }))).toContain(
      "timed out after 0 s",
    )
    expect(textOf(await slowArtifacts.run({ action: "view_figure", imagePath: FIGURE_REL }))).toContain(
      "timed out after 0 s",
    )
    expect(textOf(await slowArtifacts.run({ action: "chips" }))).toContain("timed out after 0 s")
    expect(Date.now() - again).toBeLessThan(3000)
  })

  it("the tool-call AbortSignal surfaces as an abort — while waiting for headers, mid-body, and on a stalled error body", async () => {
    const dead = await deadServer()
    await expect(
      makeTool(dead, { timeoutMs: 30_000 }).run({ action: "search", query: "q", chip: "STM32F1" }, abortAfter(50)),
    ).rejects.toThrow()

    const stalled = await stallingServer()
    const tool = makeTool(stalled, { timeoutMs: 30_000, artifactTimeoutMs: 30_000 })
    for (const params of [
      { action: "search", query: "q", chip: "STM32F1" },
      { action: "read_section", parsedPath: PARSED_REL },
      { action: "view_figure", imagePath: FIGURE_REL },
      { action: "chips" },
    ] as DatasheetInput[]) {
      const started = Date.now()
      await expect(tool.run(params, abortAfter(50))).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1500)
    }

    const stalledError = await stallingServer(500)
    const erroring = makeTool(stalledError, { timeoutMs: 30_000 })
    await expect(erroring.run({ action: "search", query: "q", chip: "STM32F1" }, abortAfter(50))).rejects.toThrow()
  })

  it("stopping a call that is waiting for the manifest returns at once; the shared download is not poisoned", async () => {
    const fake = await fakeServer({ manifestHangs: true })
    const { run } = makeTool(fake.url, { artifactTimeoutMs: 400 })
    const started = Date.now()
    await expect(run({ action: "search", query: "q", chip: "AT32F011C8T7" }, abortAfter(50))).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(300)
    // 中止只放开了这一次调用;后台那份下载还在单飞里,紧接着的 chips 挂在它上面,不会多拉一份。
    const pending = run({ action: "chips" })
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(1)
    // 它在 400 ms 超时后失败,失败不缓存:两次调用都得到"不可达",再来一次会重新拉。
    expect(textOf(await pending)).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(textOf(await run({ action: "chips" }))).toContain("DATASHEET LOOKUP UNAVAILABLE")
    expect(fake.paths().filter((p) => p === "/api/manifest")).toHaveLength(2)
  })

  it("the client caches a missing endpoint but never a failure", async () => {
    const fake = await fakeServer({ manifestStatus: 404 })
    const client = createDatasheetClient(fake.url)
    expect(await client.chipIndex()).toBeUndefined()
    expect(await client.chipIndex()).toBeUndefined()
    expect(fake.paths()).toEqual(["/api/manifest"])
  })
})

// ─── 8. 真服务器(YOMA_DATASHEET_LIVE=1) ───────────────────────────────────────

const live = process.env.YOMA_DATASHEET_LIVE === "1"

describe.skipIf(!live)("datasheet against the built-in public server (YOMA_DATASHEET_LIVE=1)", () => {
  const liveTool = () => makeTool(undefined, { server: DEFAULT_DATASHEET_SERVER })

  it("chips lists dozens of families and STM32F4's split reference manuals, counted as documents", async () => {
    const { run } = liveTool()
    const all = await run({ action: "chips" })
    expect(all.details.families!).toBeGreaterThan(50)
    expect(textOf(all)).toMatch(/\d+ indexed chip families, \d+ manuals \(\d+ page-range parts\)/)
    const f4 = await run({ action: "chips", chip: "STM32F407VGT6" })
    expect(textOf(f4)).toMatch(
      /chip "STM32F4" \(resolved from "STM32F407VGT6"\) — \d+ manual\(s\) \(\d+ page-range parts\)/,
    )
    expect(textOf(f4)).toMatch(/rev "RM0390" \[datasheet\] — .*split into \d+ parts/)
    const g0 = await run({ action: "chips", chip: "STM32G081RB" })
    expect(textOf(g0)).toContain('Manuals whose cover lists STM32G081RB: rev "DS12231"')
  }, 90_000)

  it("search hits the family's own manuals and resolves a part number", async () => {
    const { run } = liveTool()
    const direct = await run({ action: "search", query: "USART baud rate register", chip: "STM32F4", topK: 3 })
    expect(direct.details.hits!.some((h) => h.chip === "STM32F4")).toBe(true)
    expect(direct.details.resolvedChip).toBeUndefined()
    const part = await run({ action: "search", query: "flash size", chip: "AT32F421C8T7", topK: 3 })
    expect(part.details.resolvedChip).toBe("AT32F")
    expect(part.details.hits!.some((h) => h.chip === "AT32F")).toBe(true)
  }, 90_000)

  it("a split manual's base rev searches all its parts, and the GENERAL rescue stays within topK", async () => {
    const { run } = liveTool()
    const result = await run({
      action: "search",
      query: "USART baud rate register",
      chip: "STM32F4",
      rev: "RM0390",
      topK: 4,
    })
    expect(result.details.searchedRevs!.length).toBeGreaterThan(1)
    expect(result.details.hits!.every((h) => h.rev.startsWith("RM0390_p"))).toBe(true)
    expect(textOf(result)).toContain("page-range parts")
    const core = await run({ action: "search", query: "NVIC priority grouping", chip: "STM32F4", topK: 6 })
    expect(core.details.hits!.length).toBeLessThanOrEqual(6)
  }, 120_000)

  it("read_section returns a ToC for a real parsed manual and a whole register section by its hit breadcrumb", async () => {
    const { run } = liveTool()
    const toc = await run({ action: "read_section", parsedPath: "parsed/STM32F4/RM0390_p401-800.md" })
    expect(toc.details.mode).toBe("toc")
    expect(toc.details.sections!).toBeGreaterThan(100)
    expect(textOf(toc)).not.toContain("Reset value")
    const section = await run({
      action: "read_section",
      parsedPath: "parsed/STM32F4/RM0390_p401-800.md",
      heading: "14.3.9 Triangle-wave generation",
    })
    expect(section.details.mode).toBe("section")
    expect(textOf(section)).toContain("triangle")
    const brr = await run({
      action: "read_section",
      parsedPath: "parsed/STM32F4/RM0386_p801-1200.md",
      heading: "30.6.3 Baud rate register (USART_BRR)",
    })
    expect(brr.details.mode).toBe("section")
    expect(textOf(brr)).toContain("DIV")
  }, 120_000)

  it("view_figure attaches a real figure", async () => {
    const { run } = liveTool()
    const result = await run({
      action: "view_figure",
      imagePath: "figures/APM32F/APM32F035x8_M3514x8_DS_EN/APM32F035x8_M3514x8_DS_EN-F1.png",
      caption: "Figure 1",
    })
    expect(imageOf(result)?.mimeType).toBe("image/png")
    expect(result.details.bytes!).toBeGreaterThan(1000)
  }, 120_000)
})
