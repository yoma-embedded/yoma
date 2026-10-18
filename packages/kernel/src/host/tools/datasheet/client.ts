/**
 * 数据手册服务器的网络那一半:带超时的 fetch、错误翻成人话、v1 / v2 检索、/api/v2/docs 与 targets/resolve、
 * 芯片索引的进程内缓存。
 *
 * 【接口版本】DESIGN-v3 §7.5:客户端先走 v2,服务器没有 v2 接口(明确 404/405)才回落 v1。
 * - `auto`(缺省):POST /api/v2/search → 404/405 时用 /api/search,回复里明说用了旧接口;
 * - `v1` / `v2`:只用那一个(显式选项或 `YOMA_DATASHEET_API`),v2 缺接口时不回落。
 * **422/429/503 不是"旧服务器"**:那是 v2 在回答(范围解析不出来 / 限流 / 索引不可用),静默回落会把
 * 服务端已经给出的候选和降级信息一起吞掉,所以只在 404/405 上回落。
 *
 * 【每个请求都带超时】内置默认地址意味着所有安装都会去碰同一台可能挂掉的机器;没有超时的话,一个只接连接
 * 不回包的主机会把整轮吊死到用户手动中止。超时信号覆盖整个请求:响应头到了之后 body 卡住,超时会从
 * `res.text()/json()/arrayBuffer()` 里抛出来 —— 所以 body 读取也要过同一道人话转换,不然模型拿到的是一句
 * 裸 TimeoutError,而不是"手册查不了、别凭记忆编"。
 *
 * 【错误码分别翻】404/405 = 没有这个端点(可能回落);422 = 名字 / 范围不合法(附候选);429 = 限流;
 * 503 = 索引没发布 / 不可用;只有连不上 / 超时 / 别的非 2xx 才是 "DATASHEET LOOKUP UNAVAILABLE"。
 * 把 422 翻成"服务器挂了"会让模型从此不查手册;把 503 当旧接口会让它拿着 GENERAL 噪声当答案。
 *
 * 【命中整条归一】服务器保证字段齐全,但反代的错误页、半迁移的服务器、被改过的索引都可能少字段;
 * `score.toFixed` 在 undefined 上会把整个工具调用炸成一个裸 TypeError。每个字段给默认值,不是对象的项丢掉
 * (v1 的 `normalizeHit` 与 v2 的 `normalizeV2Hit` 同一套纪律)。
 *
 * 【芯片索引缓存是模块级的】manifest 现在 4.3 MB / 757 本(带每本的产物清单),一个内核进程拉一次够了,
 * 所有会话共用;给 TTL 是因为语料会长(2026-09-01 一次就从 96 本涨到 352 本)。单飞:两条 search 同时第一次
 * 落空时只拉一份。拉取不绑任何一次调用的 abortSignal —— 用户按停止时那一次调用立刻返回,下载在后台走完
 * 进缓存,下一次就有了;绑上去的话按一次停止就把别的会话正在等的那份也废掉。
 * v2 的 /api/v2/docs 不缓存:它本来就是替代 4.3 MB manifest 的轻量列表,按需读一次即可。
 */

import {
  DATASHEET_SERVER_ENV,
  DEFAULT_DATASHEET_SERVER,
  type DatasheetServerResolution,
} from "../../datasheet-server.ts"
import {
  buildChipIndex,
  buildV2SearchBody,
  type ChipFamily,
  type DatasheetApiVersion,
  encodeRel,
  formatCandidateList,
  isScopeUnresolved,
  type ManifestEntry,
  normalizeDocsResponse,
  normalizeResolveResponse,
  normalizeV2SearchResponse,
  parseV2Error,
  type SearchHit,
  type V2ApiError,
  type V2DocMeta,
  type V2SearchRequest,
  type V2SearchResult,
  type V2TargetResolved,
} from "../../domain/datasheet/index.ts"

/** API 调用(search)的超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000
/** 产物(parsed markdown / 图片)与 manifest 的超时:都是几百 KB 到几 MB 的下载,慢链路上 20 s 不够。 */
export const DEFAULT_ARTIFACT_TIMEOUT_MS = 60_000
export const CHIP_INDEX_TTL_MS = 10 * 60 * 1000

/** 接口版本的环境变量(进程环境;`.env` 仍只服务服务器地址)。 */
export const DATASHEET_API_ENV = "YOMA_DATASHEET_API"

/**
 * 接口版本:`auto`(缺省)先 v2、明确 404/405 才回落 v1;`v1` / `v2` 只用那一个。
 * 显式选项压过环境变量;非法值按 auto(不因为一个拼错的值把工具关死)。
 */
export function resolveDatasheetApiVersion(
  explicit?: DatasheetApiVersion,
  env?: NodeJS.ProcessEnv,
): DatasheetApiVersion {
  if (explicit === "auto" || explicit === "v1" || explicit === "v2") return explicit
  const raw = env?.[DATASHEET_API_ENV]?.trim().toLowerCase()
  if (raw === "v1" || raw === "1" || raw === "legacy") return "v1"
  if (raw === "v2" || raw === "2") return "v2"
  return "auto"
}

export const LOOKUP_UNAVAILABLE =
  "DATASHEET LOOKUP UNAVAILABLE. Do not invent register maps, electrical ratings, reset values, or peripheral behavior from memory. " +
  "Tell the user this lookup failed and report the server/configuration diagnostic below. Yoma includes a default remote datasheet service; users do not need to host a server."

/** 显式关掉(off)时的话:关掉是一个明确选择,文案要说清怎么关 / 怎么开回来。 */
export function noServerHelp(envFile: string): string {
  return (
    `${LOOKUP_UNAVAILABLE}\n` +
    `No datasheet server configured (lookup is switched off). Set ${DATASHEET_SERVER_ENV}=<http://server[:port]> in the environment or in ${envFile} to enable search/read_section/view_figure; ${DATASHEET_SERVER_ENV}=off keeps it disabled on purpose.`
  )
}

export function unreachableHelp(server: string, detail: string, configuration?: DatasheetServerResolution): string {
  const source = configuration?.source
  const origin =
    source === "file"
      ? `Configuration file: ${configuration?.file}. `
      : source === "env"
        ? `Configuration: environment variable ${DATASHEET_SERVER_ENV}. `
        : source === "explicit"
          ? "Configuration: explicit server option. "
          : ""
  const advice =
    server === DEFAULT_DATASHEET_SERVER
      ? "The built-in remote service is selected. Check network connectivity or service availability; no server setup is required."
      : `Remove the server override to use Yoma's built-in service (${DEFAULT_DATASHEET_SERVER}), or check the configured server's network/service.`
  return (
    `${LOOKUP_UNAVAILABLE}\n` +
    `Could not reach the datasheet server at ${server}: ${detail}. ` +
    `This is a configuration/network problem, not a missing chip fact. ${origin}${advice}`
  )
}

/** 服务器还没有 /api/search 时的引导(旧服务器 / 自建的文件服务器)。 */
export function searchUnavailableHelp(server: string): string {
  return (
    `The datasheet server at ${server} does not expose POST /api/search (HTTP 404). ` +
    `Server-side search (bge-m3 embedding + Lance query on the server) needs that endpoint — ` +
    `ask the datasheet-server maintainer to add POST /api/search ` +
    `({ query, chip, rev?, top_k } → { hits: [{ text, parsed_path, image_path, ... }] }). ` +
    `Meanwhile read_section and view_figure still work when you know a manual's parsed_path / image_path.`
  )
}

/** 服务器在,但索引还没建 / 没发布(它回 503)。 */
export function indexNotPublishedHelp(server: string, detail: string): string {
  return (
    `The datasheet server at ${server} has no search index published yet (HTTP 503${detail ? `: ${detail}` : ""}). ` +
    `Search will work once the maintainer publishes an index; read_section and view_figure still work for artifacts that exist. ` +
    `Do not invent chip facts meanwhile.`
  )
}

/** 服务器认为 chip / rev 不是合法名字(它回 422)。 */
export function badNameHelp(detail: string): string {
  return (
    `The datasheet server rejected the chip / rev name (HTTP 422${detail ? `: ${detail}` : ""}). ` +
    `Index names use letters, digits, ".", "_" and "-" only, spelled exactly as indexed — ` +
    `use action "chips" (optionally with \`chip\`) to see the exact names, then search again. The server itself is fine.`
  )
}

/** 服务器没有 v2 端点(明确 404/405):旧服务器,或 v2 被关掉。auto 模式会回落 v1。 */
export function v2UnavailableHelp(server: string, status: number): string {
  return (
    `The datasheet server at ${server} does not expose the v2 API (HTTP ${status}). ` +
    `It is an older v1 server, or v2 is disabled. With apiVersion "auto" the tool falls back to the legacy v1 endpoint ` +
    `automatically; with apiVersion "v2" it does not. Set ${DATASHEET_API_ENV}=auto (or v1) to allow the legacy path, ` +
    `or upgrade the server. Legacy v1 search ignores \`keywords\` and does no server-side scope resolution.`
  )
}

/**
 * v2 错误 → 给模型的话。422 / 429 / 503 都是**服务端在回答**,不是"旧接口"也不是"服务器不可达"。
 * 422 scope_unresolved 的候选必须原样给出来 —— 旧服务最坑的一条就是猜错 chip 也 200 返回 GENERAL,
 * v2 用这个 422 替代了那种无声失败。
 */
export function v2ErrorHelp(server: string, status: number, error: V2ApiError, retryAfter?: string | null): string {
  const code = error.code ? ` ${error.code}` : ""
  // 没有结构化 message 时,只有纯文本原文才当消息;JSON 原文(可能被截断)只留在 detail 里。
  const rawText = error.detail.trim()
  const message = error.message || (rawText && !rawText.startsWith("{") && !rawText.startsWith("[") ? rawText : "")
  const hint = error.hint ? `\nHint: ${error.hint}` : ""
  const candidates = error.candidates.length ? `\nCandidates: ${formatCandidateList(error.candidates)}` : ""
  if (status === 422 && isScopeUnresolved(error)) {
    return (
      `NO SEARCH PERFORMED — the datasheet server could not resolve the requested scope (HTTP 422${code}).` +
      (message ? `\nMessage: ${message}` : "") +
      hint +
      candidates +
      `\nThe v2 server resolves part numbers, device families, page-range parts and GENERAL fallback itself — do not guess a family name. ` +
      `Retry with one of the candidates as \`chip\`, or use action "chips" to read the actual index.`
    )
  }
  if (status === 422) {
    return (
      `The datasheet server rejected the search request (HTTP 422${code}).` +
      (message ? `\nMessage: ${message}` : "") +
      hint +
      candidates +
      `\nFix the arguments; the server itself is fine.`
    )
  }
  if (status === 429) {
    const wait = retryAfter?.trim() ? ` Retry after ${retryAfter.trim()} s.` : ""
    return (
      `The datasheet server rate-limited this search (HTTP 429${code}).` +
      (message ? `\nMessage: ${message}` : "") +
      hint +
      `\nWait and retry; the server is fine.${wait}`
    )
  }
  if (status === 413) {
    return (
      `The datasheet server rejected this request as too large (HTTP 413${code}).` +
      (message ? `\nMessage: ${message}` : "") +
      hint +
      `\nShorten \`query\` / \`keywords\`; the server itself is fine.`
    )
  }
  if (status === 503) {
    return (
      `The datasheet server's v2 search index is unavailable (HTTP 503${code}).` +
      (message ? `\nMessage: ${message}` : "") +
      hint +
      `\nThis is a server-side condition, not an old server and not a name problem. ` +
      `read_section and view_figure may still work for artifacts that exist. Do not invent chip facts meanwhile.`
    )
  }
  return unreachableHelp(server, `HTTP ${status}${message ? `: ${message}` : ""}`)
}

export class DatasheetUnreachableError extends Error {
  readonly datasheetUnreachable = true as const
}

export function isUnreachable(error: unknown): error is DatasheetUnreachableError {
  return error instanceof DatasheetUnreachableError
}

export interface V2Failure {
  ok: false
  status: number
  /** 明确 404/405:auto 模式可以回落 v1。其它错误一律 false。 */
  unavailable: boolean
  message: string
  code?: string
  /** 服务端错误体里的原话与提示(供需要自己拼回复的分支复用)。 */
  serverMessage?: string
  hint?: string
  candidates?: string[]
  detail?: string
}

export type V2SearchOutcome = { ok: true; result: V2SearchResult } | V2Failure
export type V2DocsOutcome =
  | { ok: true; docs: V2DocMeta[]; total?: number; generation?: number; targetResolved?: V2TargetResolved }
  | V2Failure
export type V2ResolveOutcome =
  | { ok: true; resolved: string[]; candidates: string[]; docs?: number; fields: Record<string, string | string[]> }
  | V2Failure

export interface DatasheetDocsQuery {
  target?: string
  vendor?: string
  type?: string
}

export interface DatasheetClientOptions {
  configuration?: DatasheetServerResolution
  timeoutMs?: number
  artifactTimeoutMs?: number
  /** `auto`(缺省)/ `v1` / `v2`;通常由 `resolveDatasheetApiVersion` 从选项 / 环境变量算出来。 */
  apiVersion?: DatasheetApiVersion
  /** 这一次工具调用的中止信号;中止时原样抛出(不翻成"服务器不可达")。 */
  signal?: AbortSignal
}

export type SearchOutcome = { hits: SearchHit[] } | { failed: string }

export interface DatasheetClient {
  readonly server: string
  /** 配置的接口版本(auto 是否回落由调用方决定)。 */
  readonly apiVersion: DatasheetApiVersion
  /** search / 小 JSON 端点:API 超时。 */
  fetchApi(path: string, init?: RequestInit): Promise<Response>
  /** /artifacts/<rel>:产物超时。 */
  fetchArtifact(rel: string): Promise<Response>
  text(res: Response): Promise<string>
  bytes(res: Response): Promise<Buffer>
  /** 旧接口 POST /api/search;非 2xx 翻成给模型的话(failed),网络失败抛 DatasheetUnreachableError。 */
  searchV1(query: string, chip: string, rev: string | undefined, topK: number): Promise<SearchOutcome>
  /** POST /api/v2/search。404/405 标成 unavailable(auto 模式据此回落),422/429/503 原样翻成人话。 */
  searchV2(request: V2SearchRequest): Promise<V2SearchOutcome>
  /** GET /api/v2/docs(替代 4.3 MB manifest 的轻量列表)。 */
  listDocs(query?: DatasheetDocsQuery): Promise<V2DocsOutcome>
  /** GET /api/v2/targets/resolve?q=。 */
  resolveTarget(q: string): Promise<V2ResolveOutcome>
  /** 同 resolveTarget,但网络失败返回 undefined(只用于"补充候选"的辅助路径,不能把主答案挡掉)。 */
  resolveTargetQuietly(q: string): Promise<V2ResolveOutcome | undefined>
  /** manifest → 家族索引。端点不在 / 空表(旧服务器)时 undefined;网络失败抛 DatasheetUnreachableError。 */
  chipIndex(): Promise<Map<string, ChipFamily> | undefined>
  /** search 的兜底路径用这一份:索引拿不到是我们自己的额外功课,绝不能反过来把搜索挡掉。 */
  chipIndexQuietly(): Promise<Map<string, ChipFamily> | undefined>
}

/** 工具调用的 AbortSignal 与超时二合一。 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}

/** 调用方的信号一响就放手:共享的下载继续在后台走,这一次调用不等它。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/** 服务器回的一条命中 → 11 个字段都有值的 SearchHit;不是对象的项丢掉。 */
export function normalizeHit(raw: unknown): SearchHit | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const h = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    text: str(h.text),
    manual_name: str(h.manual_name),
    chip: str(h.chip),
    rev: str(h.rev),
    page: num(h.page),
    headings: str(h.headings),
    score: num(h.score),
    kind: str(h.kind),
    source_pdf: str(h.source_pdf),
    parsed_path: str(h.parsed_path),
    image_path: str(h.image_path),
  }
}

let chipIndexCache: { server: string; at: number; index: Promise<Map<string, ChipFamily> | undefined> } | undefined

/** 测试用:清掉进程内的芯片索引缓存。 */
export function resetChipIndexCache(): void {
  chipIndexCache = undefined
}

/** 测试用:把缓存里那份标成已过期(下一次调用必须重拉)。 */
export function expireChipIndexCache(): void {
  if (chipIndexCache) chipIndexCache.at = Number.NEGATIVE_INFINITY
}

export function createDatasheetClient(server: string, options: DatasheetClientOptions = {}): DatasheetClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const artifactTimeoutMs = options.artifactTimeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS
  const signal = options.signal
  const apiVersion = options.apiVersion ?? "auto"

  const unreachable = (error: unknown, ms: number): DatasheetUnreachableError => {
    const detail = isTimeout(error)
      ? `timed out after ${Math.round(ms / 1000)} s`
      : error instanceof Error
        ? error.message
        : String(error)
    return new DatasheetUnreachableError(unreachableHelp(server, detail, options.configuration))
  }

  const fetchWith = async (url: string, ms: number, init?: RequestInit, own?: AbortSignal): Promise<Response> => {
    try {
      return await fetch(url, { ...init, signal: withTimeout(own, ms) })
    } catch (error) {
      if (own?.aborted) throw error
      throw unreachable(error, ms)
    }
  }

  const readBody = async <T>(read: () => Promise<T>, ms: number): Promise<T> => {
    try {
      return await read()
    } catch (error) {
      if (signal?.aborted) throw error
      throw unreachable(error, ms)
    }
  }

  const fetchApi = (path: string, init?: RequestInit) => fetchWith(`${server}${path}`, timeoutMs, init, signal)
  const fetchArtifact = (rel: string) =>
    fetchWith(`${server}/artifacts/${encodeRel(rel)}`, artifactTimeoutMs, undefined, signal)

  /** 非 2xx 的响应体只是给人看的补充:读不到就算了,但中止要原样抛。 */
  const errorBody = async (res: Response, limit = 300): Promise<string> => {
    try {
      return (await res.text()).slice(0, limit)
    } catch (error) {
      if (signal?.aborted) throw error
      return ""
    }
  }

  /** 404/405:端点不存在,auto 模式可以回落 v1。 */
  const missingEndpoint = (status: number): V2Failure => ({
    ok: false,
    status,
    unavailable: true,
    message: v2UnavailableHelp(server, status),
  })

  /** 其它非 2xx:422 / 429 / 503 是服务端在回答,原样翻成给模型的话,绝不标记成 unavailable。 */
  const failure = async (res: Response, limit = 8000): Promise<V2Failure> => {
    const body = await errorBody(res, limit)
    const error = parseV2Error(res.status, body)
    return {
      ok: false,
      status: res.status,
      unavailable: false,
      message: v2ErrorHelp(server, res.status, error, res.headers.get("retry-after")),
      ...(error.code ? { code: error.code } : {}),
      ...(error.message ? { serverMessage: error.message } : {}),
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.candidates.length ? { candidates: error.candidates } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    }
  }

  const searchV1 = async (
    query: string,
    chip: string,
    rev: string | undefined,
    topK: number,
  ): Promise<SearchOutcome> => {
    const res = await fetchApi("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, chip, ...(rev ? { rev } : {}), top_k: topK }),
    })
    if (res.status === 404) return { failed: searchUnavailableHelp(server) }
    if (!res.ok) {
      const body = await errorBody(res)
      if (res.status === 503) return { failed: indexNotPublishedHelp(server, body) }
      if (res.status === 422) return { failed: badNameHelp(body) }
      return {
        failed: unreachableHelp(
          server,
          `HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`,
          options.configuration,
        ),
      }
    }
    const json = await readBody(() => res.json() as Promise<unknown>, timeoutMs)
    const raw =
      json && typeof json === "object" && Array.isArray((json as { hits?: unknown }).hits)
        ? ((json as { hits: unknown[] }).hits as unknown[])
        : []
    // 服务器自己也夹 top_k;这里再夹一次是防它不夹 —— 一个不理 top_k 的服务器会把 200 条塞给模型。
    const hits = raw.map(normalizeHit).filter((h): h is SearchHit => h !== undefined)
    return { hits: hits.slice(0, topK) }
  }

  const searchV2 = async (request: V2SearchRequest): Promise<V2SearchOutcome> => {
    const res = await fetchApi("/api/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildV2SearchBody(request)),
    })
    if (res.status === 404 || res.status === 405) return missingEndpoint(res.status)
    if (!res.ok) return failure(res)
    const json = await readBody(() => res.json() as Promise<unknown>, timeoutMs)
    const result = normalizeV2SearchResponse(json)
    // 服务器自己也夹 top_k;这里再夹一次是防它不夹。
    return { ok: true, result: { ...result, hits: result.hits.slice(0, request.topK) } }
  }

  const listDocs = async (query: DatasheetDocsQuery = {}): Promise<V2DocsOutcome> => {
    const params = new URLSearchParams()
    if (query.target?.trim()) params.set("target", query.target.trim())
    if (query.vendor?.trim()) params.set("vendor", query.vendor.trim())
    if (query.type?.trim()) params.set("type", query.type.trim())
    const search = params.toString()
    const res = await fetchWith(
      `${server}/api/v2/docs${search ? `?${search}` : ""}`,
      artifactTimeoutMs,
      undefined,
      signal,
    )
    if (res.status === 404 || res.status === 405) return missingEndpoint(res.status)
    if (!res.ok) return failure(res)
    const json = await readBody(() => res.json() as Promise<unknown>, artifactTimeoutMs)
    const normalized = normalizeDocsResponse(json)
    return {
      ok: true,
      docs: normalized.docs,
      ...(normalized.total === undefined ? {} : { total: normalized.total }),
      ...(normalized.generation === undefined ? {} : { generation: normalized.generation }),
      ...(normalized.targetResolved === undefined ? {} : { targetResolved: normalized.targetResolved }),
    }
  }

  const resolveTarget = async (q: string): Promise<V2ResolveOutcome> => {
    const res = await fetchApi(`/api/v2/targets/resolve?q=${encodeURIComponent(q)}`)
    if (res.status === 404 || res.status === 405) return missingEndpoint(res.status)
    if (!res.ok) return failure(res)
    const json = await readBody(() => res.json() as Promise<unknown>, timeoutMs)
    const normalized = normalizeResolveResponse(json)
    return {
      ok: true,
      resolved: normalized.resolved,
      candidates: normalized.candidates,
      ...(normalized.docs === undefined ? {} : { docs: normalized.docs }),
      fields: normalized.fields,
    }
  }

  const resolveTargetQuietly = async (q: string): Promise<V2ResolveOutcome | undefined> => {
    try {
      return await resolveTarget(q)
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  // manifest 不绑调用方的信号(文件头):只有产物超时。
  const loadChipIndex = async (): Promise<Map<string, ChipFamily> | undefined> => {
    const res = await fetchWith(`${server}/api/manifest`, artifactTimeoutMs)
    if (!res.ok) return undefined
    let json: unknown
    try {
      json = await res.json()
    } catch (error) {
      if (isTimeout(error)) throw unreachable(error, artifactTimeoutMs)
      return undefined
    }
    if (!Array.isArray(json) || json.length === 0) return undefined
    return buildChipIndex(json as ManifestEntry[])
  }

  const chipIndex = (): Promise<Map<string, ChipFamily> | undefined> => {
    const now = Date.now()
    const cached = chipIndexCache
    if (cached && cached.server === server && now - cached.at < CHIP_INDEX_TTL_MS)
      return raceAbort(cached.index, signal)
    const entry = { server, at: now, index: loadChipIndex() }
    chipIndexCache = entry
    // 拉失败不缓存失败:下一次再试。`undefined`(端点不在)照常缓存,别对旧服务器每次都多打一枪。
    entry.index.catch(() => {
      if (chipIndexCache === entry) chipIndexCache = undefined
    })
    return raceAbort(entry.index, signal)
  }

  const chipIndexQuietly = async (): Promise<Map<string, ChipFamily> | undefined> => {
    try {
      return await chipIndex()
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  return {
    server,
    apiVersion,
    fetchApi,
    fetchArtifact,
    text: (res) => readBody(() => res.text(), artifactTimeoutMs),
    bytes: async (res) => Buffer.from(await readBody(() => res.arrayBuffer(), artifactTimeoutMs)),
    searchV1,
    searchV2,
    listDocs,
    resolveTarget,
    resolveTargetQuietly,
    chipIndex,
    chipIndexQuietly,
  }
}
