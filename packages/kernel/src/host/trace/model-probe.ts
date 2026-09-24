/**
 * 模型请求的 HTTP 探针(docs/调试留痕-规划-20260924.md §3.3)。
 *
 * "是模型慢还是我们卡"的分界线在传输层:请求什么时候发出去、响应头什么时候回来、第一行 `data:` 什么时候到、
 * 中间有没有排队。harness 的事件看不到这些 —— pi-ai 的 start 事件要等响应头到了才发,而 DeepSeek 高负载时
 * 会先回响应头、再一直发 SSE 注释 `: keep-alive` 排着队(字节在流,看门狗认为连接活着),界面上只是一行「思考中」。
 *
 * 做法与 stream-guard 同一个注入口:给 `streamSimple` / `completeSimple` 的 options 塞一个包过的 `fetch`。
 * **必须套在看门狗里面**(`withStreamGuard(withModelTrace(models))`):看门狗只在调用方没给 fetch 时注入,
 * 探针要是在外层先占住 `options.fetch`,看门狗就不注入了。链是 探针 → 看门狗 → 真 fetch,正文从真 fetch
 * 经看门狗到探针再到 SDK;看门狗掐断时探针看到的是一条带 "idle timeout" 的错误。
 *
 * 每次请求写四种行:`http.req`(发出)、`http.res`(响应头)、`http.wait`(响应头到了 30 s 还没有 `data:`,
 * 之后每 60 s 一行 —— 正排队的那一刻就留下证据,哪怕随后用户把 app 关了)、`http.end`(结束 / 出错 / 中止)。
 * 只记元数据:主机、路径、字节数、状态码、请求 id 头、各段耗时、keep-alive 行数,不记请求与响应的内容。
 */

import type { Models } from "@earendil-works/pi-ai"

import type { Trace } from "./sink.ts"

type SimpleOptions = Parameters<Models["streamSimple"]>[2]
type Fetch = typeof globalThis.fetch

export interface ModelProbeOptions {
  now?: () => number
  /** 响应头到了多久还没有 `data:` 就写第一行 http.wait,缺省 30 s;之后每 `waitRepeatMs` 一行,缺省 60 s。 */
  waitFirstMs?: number
  waitRepeatMs?: number
}

/** 进程内的请求序号:同一会话的 http.* 与 llm.* 按时间先后对得上,序号只用来把同一次请求的几行串起来。 */
let sequence = 0

/** 厂商给的请求 id 头:报障时对得上号。按这个顺序取第一个有的。 */
const REQUEST_ID_HEADERS = [
  "x-request-id",
  "request-id",
  "x-ds-request-id",
  "x-amzn-requestid",
  "apim-request-id",
  "x-trace-id",
  "cf-ray",
]

/** `streamSimple` 的 sessionId 是 `<会话 id>:<lane>`(发动机 drive/generation.ts 拼的),轨迹要的是会话 id。 */
export function sessionOfRequest(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const colon = sessionId.lastIndexOf(":")
  return colon > 0 ? sessionId.slice(0, colon) : sessionId
}

export function withModelTrace<T extends Models>(models: T, trace: Trace, options: ModelProbeOptions = {}): T {
  if (!trace.enabled) return models
  const inject = (model: { provider?: string; id?: string }, o: SimpleOptions): SimpleOptions => ({
    ...o,
    fetch: tracedFetch(o?.fetch ?? globalThis.fetch, trace, {
      ...options,
      session: sessionOfRequest(o?.sessionId),
      model: model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined,
    }),
  })
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple")
        return (
          model: Parameters<Models["streamSimple"]>[0],
          context: Parameters<Models["streamSimple"]>[1],
          o?: SimpleOptions,
        ) => target.streamSimple(model, context, inject(model, o))
      if (property === "completeSimple")
        return (
          model: Parameters<Models["completeSimple"]>[0],
          context: Parameters<Models["completeSimple"]>[1],
          o?: SimpleOptions,
        ) => target.completeSimple(model, context, inject(model, o))
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export interface TracedFetchMeta extends ModelProbeOptions {
  session?: string
  model?: string
}

/** 一次请求一个探针:记发出、响应头、正文的统计与收尾。 */
export function tracedFetch(inner: Fetch, trace: Trace, meta: TracedFetchMeta = {}): Fetch {
  const now = meta.now ?? Date.now
  return async (input, init) => {
    const req = ++sequence
    const started = now()
    const url = urlOf(input)
    trace.write("http.req", {
      req,
      s: meta.session,
      model: meta.model,
      host: url?.host,
      path: url?.pathname,
      bytes: bodyBytes(init?.body),
    })
    let response: Response
    try {
      response = await inner(input, init)
    } catch (error) {
      trace.write("http.end", {
        req,
        s: meta.session,
        outcome: isAbort(error, init) ? "aborted" : "error",
        ms: now() - started,
        error: messageOf(error),
      })
      throw error
    }
    trace.write("http.res", {
      req,
      s: meta.session,
      status_code: response.status,
      ms: now() - started,
      request_id: requestId(response.headers),
      content_type: response.headers.get("content-type") ?? undefined,
    })
    if (!response.body || response.bodyUsed) {
      trace.write("http.end", { req, s: meta.session, outcome: "done", ms: now() - started, bytes: 0 })
      return response
    }
    const observed = new Response(observeBody(response.body, trace, { ...meta, req, started, now }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    // Response 构造函数不接 url / redirected;SDK 的日志与错误信息会读它们(与 stream-guard 同一处理)
    Object.defineProperty(observed, "url", { value: response.url, configurable: true })
    Object.defineProperty(observed, "redirected", { value: response.redirected, configurable: true })
    return observed
  }
}

interface BodyMeta extends TracedFetchMeta {
  req: number
  started: number
  now: () => number
}

/** 正文原样透传,顺路数字节、块数、SSE 注释行(keep-alive)、第一行 data: 的时刻与最大块间隔。 */
function observeBody(body: ReadableStream<Uint8Array>, trace: Trace, meta: BodyMeta): ReadableStream<Uint8Array> {
  const { req, started, now } = meta
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const waitFirstMs = meta.waitFirstMs ?? 30_000
  const waitRepeatMs = meta.waitRepeatMs ?? 60_000
  let bytes = 0
  let chunks = 0
  let keepalives = 0
  let firstData: number | undefined
  let lastChunk = started
  let maxGap = 0
  /** 当前这一行的开头(最多 5 个字符):判断 ":"(SSE 注释)与 "data:" 只要这么多,不留整行。 */
  let head = ""
  let ended = false
  let waitTimer: ReturnType<typeof setTimeout> | undefined

  const clearWait = () => {
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = undefined
  }
  const scheduleWait = (delay: number) => {
    waitTimer = setTimeout(() => {
      waitTimer = undefined
      if (ended || firstData !== undefined) return
      trace.write("http.wait", { req, s: meta.session, ms: now() - started, keepalives, bytes })
      scheduleWait(waitRepeatMs)
    }, delay)
    waitTimer.unref?.()
  }
  scheduleWait(waitFirstMs)

  const scan = (text: string) => {
    for (const ch of text) {
      if (ch === "\n") {
        if (head.startsWith(":")) keepalives++
        head = ""
        continue
      }
      if (head.length >= 5) continue
      head += ch
      // 一行 data: 的开头一到就算"第一个事件到了",不等它的换行(一个大块可能被切在几次 read 里)
      if (firstData === undefined && head === "data:") {
        firstData = now()
        clearWait()
      }
    }
  }

  const finish = (outcome: "done" | "error" | "cancelled", error?: unknown) => {
    if (ended) return
    ended = true
    clearWait()
    trace.write("http.end", {
      req,
      s: meta.session,
      outcome,
      ms: now() - started,
      bytes,
      chunk_count: chunks,
      keepalives,
      first_data_ms: firstData === undefined ? undefined : firstData - started,
      max_gap_ms: maxGap,
      error: error === undefined ? undefined : messageOf(error),
    })
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finish("done")
          controller.close()
          return
        }
        const at = now()
        maxGap = Math.max(maxGap, at - lastChunk)
        lastChunk = at
        bytes += value.byteLength
        chunks++
        scan(decoder.decode(value, { stream: true }))
        controller.enqueue(value)
      } catch (error) {
        finish("error", error)
        controller.error(error)
      }
    },
    cancel(reason) {
      finish("cancelled", reason === undefined ? undefined : reason)
      return reader.cancel(reason)
    },
  })
}

function urlOf(input: Parameters<Fetch>[0]): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input)
    if (input instanceof URL) return input
    return new URL((input as Request).url)
  } catch {
    return undefined
  }
}

function bodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body)
  if (body instanceof Uint8Array) return body.byteLength
  if (body instanceof ArrayBuffer) return body.byteLength
  return undefined
}

function requestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)
    if (value) return value
  }
  return undefined
}

function isAbort(error: unknown, init: RequestInit | undefined): boolean {
  return init?.signal?.aborted === true || (error as { name?: string })?.name === "AbortError"
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : String(error)
}
