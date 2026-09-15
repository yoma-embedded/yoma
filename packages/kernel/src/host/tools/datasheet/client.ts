/**
 * 数据手册服务器的网络那一半:带超时的 fetch、错误翻成人话、/api/search 的一次调用、芯片索引的进程内缓存。
 *
 * 【每个请求都带超时】内置默认地址意味着所有安装都会去碰同一台可能挂掉的机器;没有超时的话,一个只接连接
 * 不回包的主机会把整轮吊死到用户手动中止。超时信号覆盖整个请求:响应头到了之后 body 卡住,超时会从
 * `res.text()/json()/arrayBuffer()` 里抛出来 —— 所以 body 读取也要过同一道人话转换,不然模型拿到的是一句
 * 裸 TimeoutError,而不是"手册查不了、别凭记忆编"。
 *
 * 【错误码分别翻】404 = 没有 /api/search(旧服务器),503 = 索引没发布,422 = 名字不合法;只有连不上 / 超时 /
 * 别的非 2xx 才是 "DATASHEET LOOKUP UNAVAILABLE"。把 422 翻成"服务器挂了"会让模型从此不查手册。
 *
 * 【命中整条归一】服务器(rag_yoma/query.py)保证 11 个字段都在,但反代的错误页、半迁移的服务器、被改过的
 * 索引都可能少字段;`score.toFixed` 在 undefined 上会把整个工具调用炸成一个裸 TypeError。每个字段给默认值,
 * 不是对象的项丢掉。
 *
 * 【芯片索引缓存是模块级的】manifest 现在 4.3 MB / 757 本(带每本的产物清单),一个内核进程拉一次够了,
 * 所有会话共用;给 TTL 是因为语料会长(2026-09-01 一次就从 96 本涨到 352 本)。单飞:两条 search 同时第一次
 * 落空时只拉一份。拉取不绑任何一次调用的 abortSignal —— 用户按停止时那一次调用立刻返回,下载在后台走完
 * 进缓存,下一次就有了;绑上去的话按一次停止就把别的会话正在等的那份也废掉。
 */

import {
  DATASHEET_SERVER_ENV,
  DEFAULT_DATASHEET_SERVER,
  type DatasheetServerResolution,
} from "../../datasheet-server.ts"
import {
  buildChipIndex,
  type ChipFamily,
  encodeRel,
  type ManifestEntry,
  type SearchHit,
} from "../../domain/datasheet/index.ts"

/** API 调用(search)的超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000
/** 产物(parsed markdown / 图片)与 manifest 的超时:都是几百 KB 到几 MB 的下载,慢链路上 20 s 不够。 */
export const DEFAULT_ARTIFACT_TIMEOUT_MS = 60_000
export const CHIP_INDEX_TTL_MS = 10 * 60 * 1000

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

export class DatasheetUnreachableError extends Error {
  readonly datasheetUnreachable = true as const
}

export function isUnreachable(error: unknown): error is DatasheetUnreachableError {
  return error instanceof DatasheetUnreachableError
}

export interface DatasheetClientOptions {
  configuration?: DatasheetServerResolution
  timeoutMs?: number
  artifactTimeoutMs?: number
  /** 这一次工具调用的中止信号;中止时原样抛出(不翻成"服务器不可达")。 */
  signal?: AbortSignal
}

export type SearchOutcome = { hits: SearchHit[] } | { failed: string }

export interface DatasheetClient {
  readonly server: string
  /** search / 小 JSON 端点:API 超时。 */
  fetchApi(path: string, init?: RequestInit): Promise<Response>
  /** /artifacts/<rel>:产物超时。 */
  fetchArtifact(rel: string): Promise<Response>
  text(res: Response): Promise<string>
  bytes(res: Response): Promise<Buffer>
  /** 一次 POST /api/search;非 2xx 翻成给模型的话(failed),网络失败抛 DatasheetUnreachableError。 */
  search(query: string, chip: string, rev: string | undefined, topK: number): Promise<SearchOutcome>
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
  const errorBody = async (res: Response): Promise<string> => {
    try {
      return (await res.text()).slice(0, 300)
    } catch (error) {
      if (signal?.aborted) throw error
      return ""
    }
  }

  const search = async (query: string, chip: string, rev: string | undefined, topK: number): Promise<SearchOutcome> => {
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
    fetchApi,
    fetchArtifact,
    text: (res) => readBody(() => res.text(), artifactTimeoutMs),
    bytes: async (res) => Buffer.from(await readBody(() => res.arrayBuffer(), artifactTimeoutMs)),
    search,
    chipIndex,
    chipIndexQuietly,
  }
}
