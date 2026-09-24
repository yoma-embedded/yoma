/**
 * 模型请求的 HTTP 探针(host/trace/model-probe.ts;docs/调试留痕-规划-20260924.md §3.3)。
 *
 * 用本地 http 服务说 SSE(与 stream-guard.test.ts 同一个做法):正常流、DeepSeek 式的 keep-alive 排队、非 2xx、
 * 响应头之前中止;以及**探针与看门狗叠在一起时看门狗仍然生效** —— 顺序反了看门狗就不注入,流静默断掉时又回到
 * "内核等 15 分钟",这条必须钉住。
 */
import http from "node:http"
import type { AddressInfo, Socket } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { guardModels } from "../src/host/models.ts"
import { StreamIdleError } from "../src/host/stream-guard.ts"
import { sessionOfRequest, tracedFetch, withModelTrace } from "../src/host/trace/model-probe.ts"
import { NOOP_TRACE, type Trace, type TraceFields } from "../src/host/trace/sink.ts"

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const handlers = new Map<string, Handler>()
const sockets = new Set<Socket>()
let server: http.Server
let base = ""

beforeAll(async () => {
  server = http.createServer((req, res) => {
    sockets.add(req.socket)
    const handler = handlers.get(req.url ?? "")
    if (handler) handler(req, res)
    else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 记在内存里的轨迹。 */
function memoryTrace() {
  const lines: Array<{ ev: string } & TraceFields> = []
  const trace: Trace = {
    enabled: true,
    write: (ev, fields) => void lines.push({ ev, ...fields }),
    flush: async () => {},
    close: async () => {},
  }
  return { trace, lines, of: (ev: string) => lines.filter((line) => line.ev === ev) }
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let text = ""
  for await (const chunk of body) text += Buffer.from(chunk).toString()
  return text
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("tracedFetch", () => {
  it("正常的 SSE:正文原样透传;发出 / 响应头 / 收尾三行,带状态码、请求 id、字节与首个 data: 的时刻", async () => {
    handlers.set("/ok", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "rid-1" })
      let i = 0
      const timer = setInterval(() => {
        res.write(`data: {"i":${i++}}\n\n`)
        if (i === 3) {
          clearInterval(timer)
          res.write("data: [DONE]\n\n")
          res.end()
        }
      }, 20)
    })
    const { trace, lines, of } = memoryTrace()
    const fetch = tracedFetch(globalThis.fetch, trace, { session: "S1", model: "deepseek/deepseek-flash" })
    const response = await fetch(`${base}/ok`, { method: "POST", body: JSON.stringify({ hello: "世界" }) })
    expect(response.status).toBe(200)
    expect(response.url).toBe(`${base}/ok`)
    expect(await readAll(response.body!)).toBe('data: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\ndata: [DONE]\n\n')

    expect(lines.map((line) => line.ev)).toEqual(["http.req", "http.res", "http.end"])
    const [req] = of("http.req")
    expect(req).toMatchObject({ s: "S1", model: "deepseek/deepseek-flash", host: base.slice(7), path: "/ok" })
    expect(req!.bytes).toBe(Buffer.byteLength(JSON.stringify({ hello: "世界" })))
    expect(of("http.res")[0]).toMatchObject({ status_code: 200, request_id: "rid-1", content_type: "text/event-stream" })
    const end = of("http.end")[0]!
    expect(end).toMatchObject({ outcome: "done", keepalives: 0, req: req!.req })
    expect(end.bytes).toBe(Buffer.byteLength('data: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\ndata: [DONE]\n\n'))
    expect(end.chunk_count).toBeGreaterThanOrEqual(1)
    expect(typeof end.first_data_ms).toBe("number")
    expect(end.max_gap_ms).toBeGreaterThanOrEqual(0)
  })

  it("DeepSeek 式排队:响应头先到、接着只有 `: keep-alive`;还没有 data: 时就写 http.wait,收尾数得出 keep-alive 行数", async () => {
    handlers.set("/queued", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      let n = 0
      const timer = setInterval(() => {
        res.write(": keep-alive\n\n")
        if (++n === 6) {
          clearInterval(timer)
          res.write('data: {"ok":true}\n\n')
          res.end()
        }
      }, 25)
    })
    const { trace, of } = memoryTrace()
    const fetch = tracedFetch(globalThis.fetch, trace, { waitFirstMs: 60, waitRepeatMs: 50 })
    const response = await fetch(`${base}/queued`)
    await readAll(response.body!)
    const waits = of("http.wait")
    expect(waits.length).toBeGreaterThanOrEqual(1)
    expect(waits[0]!.keepalives).toBeGreaterThanOrEqual(1)
    const end = of("http.end")[0]!
    expect(end.keepalives).toBe(6)
    expect(end.first_data_ms as number).toBeGreaterThanOrEqual(100)
  })

  it("非 2xx 也照记:状态码进 http.res,正文照常读得出来", async () => {
    handlers.set("/limited", (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "rate limited" }))
    })
    const { trace, of } = memoryTrace()
    const response = await tracedFetch(globalThis.fetch, trace)(`${base}/limited`)
    expect(await response.json()).toEqual({ error: "rate limited" })
    expect(of("http.res")[0]).toMatchObject({ status_code: 429, content_type: "application/json" })
    expect(of("http.end")[0]).toMatchObject({ outcome: "done", keepalives: 0 })
    expect(of("http.end")[0]!.first_data_ms).toBeUndefined()
  })

  it("响应头之前就中止:一行 http.end,outcome 是 aborted,错误照样抛给调用方", async () => {
    handlers.set("/hang", () => {
      // 永远不回响应头
    })
    const { trace, of } = memoryTrace()
    const controller = new AbortController()
    const pending = tracedFetch(globalThis.fetch, trace)(`${base}/hang`, { signal: controller.signal })
    await delay(30)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(of("http.res")).toEqual([])
    expect(of("http.end")[0]).toMatchObject({ outcome: "aborted" })
  })

  it("读到一半被调用方取消(用户按停止):outcome 是 cancelled", async () => {
    handlers.set("/long", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: 1\n\n")
    })
    const { trace, of } = memoryTrace()
    const response = await tracedFetch(globalThis.fetch, trace)(`${base}/long`)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel("stop")
    expect(of("http.end")[0]).toMatchObject({ outcome: "cancelled" })
  })
})

describe("guardModels:探针在里、看门狗在外", () => {
  /** 一个假的 Models:streamSimple 拿 options.fetch 发请求、读完正文,把结果或错误交回来。 */
  function fakeModels(url: string) {
    const seen: Array<{ sessionId?: string }> = []
    return {
      seen,
      models: {
        streamSimple(_model: unknown, _context: unknown, o?: { fetch?: typeof fetch; sessionId?: string }) {
          seen.push({ sessionId: o?.sessionId })
          return (async () => {
            const response = await o!.fetch!(url)
            return readAll(response.body!)
          })()
        },
        completeSimple() {
          return "complete"
        },
        getProviders() {
          return ["p"]
        },
      },
    }
  }

  it("流静默断掉:看门狗照样在 idleMs 掐断(错误是 StreamIdleError),探针把它记成 outcome error", async () => {
    handlers.set("/silent", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"id":"1"}\n\n')
      // 两秒之后才正常结束:看门狗不在的话这一次会"成功"读完,断言就红
      setTimeout(() => res.end(), 2_000)
    })
    const { trace, of } = memoryTrace()
    const { models } = fakeModels(`${base}/silent`)
    const wrapped = guardModels(models as never, { trace, idleMs: 200 }) as unknown as typeof models
    const started = Date.now()
    const error = await (wrapped.streamSimple({ provider: "deepseek", id: "deepseek-flash" }, {}, {
      sessionId: "S9:main",
    }) as Promise<string>).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StreamIdleError)
    expect(Date.now() - started).toBeLessThan(1_500)
    const end = of("http.end")[0]!
    expect(end).toMatchObject({ outcome: "error", s: "S9" })
    expect(String(end.error)).toMatch(/idle timeout/)
    expect(of("http.req")[0]).toMatchObject({ s: "S9", model: "deepseek/deepseek-flash" })
  })

  it("轨迹关着时探针整层不在;其余方法原样转发", () => {
    const { models } = fakeModels(`${base}/ok`)
    expect(withModelTrace(models as never, NOOP_TRACE)).toBe(models)
    const wrapped = guardModels(models as never, { trace: memoryTrace().trace, idleMs: 100 }) as unknown as typeof models
    expect(wrapped.getProviders()).toEqual(["p"])
  })
})

describe("sessionOfRequest", () => {
  it("剥掉 lane 后缀;没有就原样;空的给 undefined", () => {
    expect(sessionOfRequest("01a0d233-e461-7107-9408-2284891e1018:main")).toBe("01a0d233-e461-7107-9408-2284891e1018")
    expect(sessionOfRequest("abc")).toBe("abc")
    expect(sessionOfRequest(undefined)).toBeUndefined()
    expect(sessionOfRequest("")).toBeUndefined()
  })
})
