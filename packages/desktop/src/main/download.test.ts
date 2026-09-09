import { afterEach, describe, expect, test } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import { describeError, fetchToFile, HttpError, pruneStaleParts } from "./download"

const DATA = randomBytes(300 * 1024)
const SHA = createHash("sha256").update(DATA).digest("hex")

type ServeOptions = { ignoreRange?: boolean; cutAfter?: number; cutDelayMs?: number; stallAfter?: number }

/** 一个懂 `bytes=N-` 的最小文件服务器,可以按需装死:发 cutAfter 字节后掐线,或发 stallAfter 字节后不吭声 */
function sendFile(req: IncomingMessage, res: ServerResponse, data: Buffer, opts: ServeOptions = {}) {
  const range = opts.ignoreRange ? undefined : req.headers.range
  let start = 0
  if (range) {
    const m = /^bytes=(\d+)-$/.exec(range)
    start = Number(m?.[1] ?? 0)
    if (start >= data.length) {
      res.writeHead(416, { "Content-Range": `bytes */${data.length}` })
      res.end()
      return
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}`,
      "Content-Length": String(data.length - start),
      "Accept-Ranges": "bytes",
    })
  } else {
    res.writeHead(200, { "Content-Length": String(data.length), "Accept-Ranges": "bytes" })
  }
  const body = data.subarray(start)
  if (opts.cutAfter !== undefined) {
    // 先让字节到达客户端,再掐线;不留间隔时整个响应可能挤在一个包里,fetch 会直接拒绝而不是先给出 body
    res.write(body.subarray(0, opts.cutAfter), () => setTimeout(() => res.socket?.destroy(), opts.cutDelayMs ?? 0))
    return
  }
  if (opts.stallAfter !== undefined) {
    res.write(body.subarray(0, opts.stallAfter))
    return
  }
  res.end(body)
}

type Behaviour = (req: IncomingMessage, res: ServerResponse, n: number) => void

let servers: Server[] = []
let dirs: string[] = []

afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function serve(behaviour: Behaviour) {
  const requests: IncomingMessage["headers"][] = []
  let n = 0
  const server = createServer((req, res) => {
    requests.push({ ...req.headers })
    behaviour(req, res, ++n)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/file.bin`, requests }
}

function tmpDest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "yoma-dl-"))
  dirs.push(dir)
  return path.join(dir, "file.bin")
}

const fast = { sleep: async () => {} }

describe("fetchToFile", () => {
  test("downloads, verifies sha256, leaves no .part", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA))
    const dest = tmpDest()
    const result = await fetchToFile(url, dest, { sha256: SHA, ...fast })
    expect(result).toMatchObject({ bytes: DATA.length, sha256: SHA, attempts: 1, resumedFrom: 0 })
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    expect(existsSync(dest + ".part")).toBe(false)
    expect(requests[0].range).toBeUndefined()
  })

  test("resumes with Range after the connection is cut mid-body", async () => {
    const { url, requests } = await serve((req, res, n) => sendFile(req, res, DATA, n === 1 ? { cutAfter: 100 * 1024 } : {}))
    const dest = tmpDest()
    const seen: number[] = []
    const result = await fetchToFile(url, dest, { sha256: SHA, onBytes: (b) => seen.push(b), ...fast })
    expect(result.attempts).toBe(2)
    expect(requests.length).toBe(2)
    const m = /^bytes=(\d+)-$/.exec(requests[1].range ?? "")
    expect(m).not.toBeNull()
    const resumeFrom = Number(m![1])
    expect(resumeFrom).toBeGreaterThan(0)
    expect(resumeFrom).toBeLessThanOrEqual(100 * 1024)
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    // 进度是累计字节,续传后不会从 0 重来
    expect(seen[seen.length - 1]).toBe(DATA.length)
    expect(Math.min(...seen.slice(seen.findIndex((b) => b >= resumeFrom)))).toBeGreaterThanOrEqual(resumeFrom)
  })

  test("continues an existing .part from a previous run", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA))
    const dest = tmpDest()
    writeFileSync(dest + ".part", DATA.subarray(0, 50_000))
    const result = await fetchToFile(url, dest, { sha256: SHA, ...fast })
    expect(requests[0].range).toBe("bytes=50000-")
    expect(result).toMatchObject({ attempts: 1, resumedFrom: 50_000, bytes: DATA.length })
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  test("starts over when the server ignores Range (200 instead of 206)", async () => {
    const { url } = await serve((req, res) => sendFile(req, res, DATA, { ignoreRange: true }))
    const dest = tmpDest()
    writeFileSync(dest + ".part", randomBytes(50_000)) // 垃圾前缀,服务器不认 Range 就必须被整个盖掉
    const result = await fetchToFile(url, dest, { sha256: SHA, ...fast })
    expect(result.attempts).toBe(1)
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  test("discards an oversized .part on 416 and restarts", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA))
    const dest = tmpDest()
    writeFileSync(dest + ".part", Buffer.concat([DATA, randomBytes(10)]))
    const result = await fetchToFile(url, dest, { sha256: SHA, ...fast })
    expect(requests[0].range).toBe(`bytes=${DATA.length + 10}-`)
    expect(requests[1].range).toBeUndefined()
    expect(result.attempts).toBe(2)
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  test("a stale .part that hashes wrong gets one clean full retry", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA))
    const dest = tmpDest()
    writeFileSync(dest + ".part", randomBytes(50_000)) // 上一版文件的残留:服务器认 Range,拼出来 sha 却不对
    const result = await fetchToFile(url, dest, { sha256: SHA, ...fast })
    expect(requests[0].range).toBe("bytes=50000-")
    expect(requests[1].range).toBeUndefined()
    expect(result.attempts).toBe(2)
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  test("does not retry a 4xx", async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(404)
      res.end("nope")
    })
    const dest = tmpDest()
    const error = await fetchToFile(url, dest, { sha256: SHA, ...fast }).catch((e) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(404)
    expect(requests.length).toBe(1)
    expect(existsSync(dest + ".part")).toBe(false)
  })

  test("rejects a sha256 mismatch on a fresh download without retrying", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA))
    const dest = tmpDest()
    const error = await fetchToFile(url, dest, { sha256: "0".repeat(64), ...fast }).catch((e) => e)
    expect(String(error?.message)).toBe("sha256 不匹配")
    expect(requests.length).toBe(1)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(dest + ".part")).toBe(false)
  })

  test("aborts a stalled connection and resumes from the bytes it got", async () => {
    const { url, requests } = await serve((req, res, n) => sendFile(req, res, DATA, n === 1 ? { stallAfter: 20_000 } : {}))
    const dest = tmpDest()
    const result = await fetchToFile(url, dest, { sha256: SHA, stallMs: 300, ...fast })
    expect(result.attempts).toBe(2)
    expect(requests[1].range).toBe("bytes=20000-")
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  test("gives up after maxAttempts, keeps the .part and reports every retry", async () => {
    const { url, requests } = await serve((req, res) => sendFile(req, res, DATA, { cutAfter: 64 * 1024, cutDelayMs: 50 }))
    const dest = tmpDest()
    const retries: number[] = []
    const error = await fetchToFile(url, dest, {
      sha256: SHA,
      maxAttempts: 3,
      onRetry: (info) => retries.push(info.attempt),
      ...fast,
    }).catch((e) => e)
    expect(String(error?.message)).toMatch(/下载失败\(已重试 2 次/)
    expect(requests.length).toBe(3)
    expect(retries).toEqual([1, 2])
    expect(existsSync(dest)).toBe(false)
    expect(statSync(dest + ".part").size).toBeGreaterThan(0)
  })
})

describe("describeError", () => {
  test("flattens the cause chain undici hides behind 'fetch failed'", () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    const error = new TypeError("fetch failed", { cause })
    expect(describeError(error)).toBe("fetch failed(原因:other side closed [UND_ERR_SOCKET])")
  })

  test("includes address and code from system errors", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:8301"), {
      code: "ECONNREFUSED",
      address: "1.2.3.4",
      port: 8301,
    })
    expect(describeError(new TypeError("fetch failed", { cause: error }))).toBe(
      "fetch failed(原因:connect ECONNREFUSED 1.2.3.4:8301 1.2.3.4:8301)",
    )
  })

  test("plain errors and strings pass through", () => {
    expect(describeError(new Error("boom"))).toBe("boom")
    expect(describeError("text")).toBe("text")
  })
})

describe("pruneStaleParts", () => {
  test("removes other snapshots' .part files and keeps the current one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yoma-prune-"))
    dirs.push(dir)
    for (const name of ["index-v6.zip.part", "index-v7.zip.part", "other.part", "index-v7.zip"]) {
      writeFileSync(path.join(dir, name), "x")
    }
    pruneStaleParts(dir, "index-v7.zip", /^index-v\d+\.zip$/)
    expect(existsSync(path.join(dir, "index-v6.zip.part"))).toBe(false)
    expect(existsSync(path.join(dir, "index-v7.zip.part"))).toBe(true)
    expect(existsSync(path.join(dir, "other.part"))).toBe(true)
    expect(existsSync(path.join(dir, "index-v7.zip"))).toBe(true)
  })
})
