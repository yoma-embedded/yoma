/**
 * 模型流的空闲看门狗(host/stream-guard.ts)。
 * 2026-09-17:DeepSeek 的流静默断掉后内核等了 15 分钟;三层(SDK timeout、node fetch、harness)都不管正文空闲。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isRetryableAssistantError } from "@earendil-works/pi-ai"
import { guardedFetch, StreamIdleError, streamIdleMsFromEnv, withStreamGuard } from "../src/host/stream-guard.ts"

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const handlers = new Map<string, Handler>()
let server: http.Server
let base = ""

beforeAll(async () => {
  server = http.createServer((req, res) => {
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
const sockets = new Set<import("node:net").Socket>()

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let text = ""
  for await (const chunk of body) text += Buffer.from(chunk).toString()
  return text
}

describe("模型流空闲看门狗", () => {
  it("正文发了一段就沉默:idleMs 后流置错,错误文本带 timeout(pi 认成可重试)", async () => {
    handlers.set("/silent", (req, res) => {
      sockets.add(req.socket)
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"id":"1"}\n\n')
      // 然后什么都不发,socket 一直开着
    })
    const fetch = guardedFetch({ idleMs: 200 })
    const started = Date.now()
    const response = await fetch(`${base}/silent`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.url).toBe(`${base}/silent`)
    let text = ""
    let error: unknown
    try {
      for await (const chunk of response.body!) text += Buffer.from(chunk).toString()
    } catch (e) {
      error = e
    }
    expect(text).toContain('"id":"1"')
    expect(error).toBeInstanceOf(StreamIdleError)
    expect(String((error as Error).message)).toMatch(/timeout/i)
    expect(Date.now() - started).toBeLessThan(2000)
    // 发动机按错误文本分类:这条要落进可重试那一档,harness 才会自己重发,而不是把会话停在错误上
    expect(isRetryableAssistantError({ stopReason: "error", errorMessage: (error as Error).message } as never)).toBe(
      true,
    )
  })

  it("正常的流:块与块之间不超过 idleMs 就一个不少地送到,末尾正常关闭", async () => {
    handlers.set("/stream", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      let i = 0
      const timer = setInterval(() => {
        res.write(`data: ${i++}\n\n`)
        if (i === 3) {
          clearInterval(timer)
          res.end()
        }
      }, 30)
    })
    const response = await guardedFetch({ idleMs: 500 })(`${base}/stream`)
    expect(await readAll(response.body!)).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n")
  })

  it("非流式响应:json() 照常,状态与头都在", async () => {
    handlers.set("/json", (_req, res) => {
      res.writeHead(201, { "content-type": "application/json", "x-request-id": "r1" })
      res.end(JSON.stringify({ ok: true }))
    })
    const response = await guardedFetch({ idleMs: 500 })(`${base}/json`)
    expect(response.status).toBe(201)
    expect(response.headers.get("x-request-id")).toBe("r1")
    expect(await response.json()).toEqual({ ok: true })
  })

  it("idleMs 为 0 关掉看门狗:原样返回被包的 fetch", () => {
    const inner = (async () => new Response("x")) as unknown as typeof globalThis.fetch
    expect(guardedFetch({ idleMs: 0, fetch: inner })).toBe(inner)
    expect(streamIdleMsFromEnv({ YOMA_STREAM_IDLE_MS: "0" })).toBe(0)
    expect(streamIdleMsFromEnv({ YOMA_STREAM_IDLE_MS: "12000" })).toBe(12000)
    expect(streamIdleMsFromEnv({ YOMA_STREAM_IDLE_MS: "abc" })).toBe(90_000)
    expect(streamIdleMsFromEnv({})).toBe(90_000)
  })

  it("withStreamGuard:streamSimple / completeSimple 默认带看门狗 fetch,调用方自己传的 fetch 优先,其余方法原样转发", () => {
    const seen: unknown[] = []
    const fake = {
      secret: 7,
      streamSimple(_m: unknown, _c: unknown, o?: { fetch?: unknown }) {
        seen.push(o?.fetch)
        return "stream"
      },
      completeSimple(_m: unknown, _c: unknown, o?: { fetch?: unknown }) {
        seen.push(o?.fetch)
        return "complete"
      },
      getProviders() {
        return this.secret
      },
    }
    const guarded = withStreamGuard(fake as never, { idleMs: 100 }) as unknown as typeof fake
    expect(guarded.streamSimple({}, {})).toBe("stream")
    expect(guarded.completeSimple({}, {}, { fetch: "mine" })).toBe("complete")
    expect(typeof seen[0]).toBe("function")
    expect(seen[1]).toBe("mine")
    expect(guarded.getProviders()).toBe(7)
  })
})
