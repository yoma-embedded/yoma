// 可续传、会重试、sha256 校验的文件下载。手册库的快照 zip(1.8 GB)和每本手册的产物都走这里。
//
// 为什么单独成模块:manuals.ts 依赖 electron,bun test 跑不了;这里只用 node 内建,
// 把"断了从哪接上、什么时候放弃、什么错不该重试"这些最容易出错的判断放进单测。
//
// 与 rag_yoma server deliver() 的契约:
//   - 半截文件留在 <dest>.part;下一次(不管是同一轮重试还是用户再点一次)从它的长度
//     发 `Range: bytes=N-`。
//   - 服务器答 206 且 Content-Range 从 N 起 → 接着写;答 200 → 服务器不认 Range,从头来;
//     答 416 → .part 比服务器上的文件还长(过期或损坏),删掉从头来。
//   - 连接被掐、一段时间没字节、提前 EOF 都算可重试;4xx 与 sha256 不匹配不重试。
//   - 下完整体 sha256 对不上:如果这次用过 .part,丢掉它再全新下一次(那些字节可能来自
//     上一版文件);还不对才报错。
//
// 服务器不在(yoma1 掉线)时 fetch 只会给一句 "fetch failed",真正的原因藏在 error.cause 里,
// describeError() 把整条 cause 链拼出来,报错里才看得出是"连接被关"还是"超时"。

import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs"
import path from "node:path"

export type RetryInfo = {
  /** 刚失败的是第几次尝试(从 1 起) */
  attempt: number
  maxAttempts: number
  /** 下一次从多少字节接着下(0 = 从头) */
  resumeFrom: number
  waitMs: number
  error: string
}

export type DownloadOptions = {
  sha256?: string
  onBytes?: (bytes: number, total: number | null) => void
  onRetry?: (info: RetryInfo) => void
  /** 总尝试次数(含第一次),默认 15 */
  maxAttempts?: number
  /** 连上之后多久没收到任何字节就掐断重试,默认 60 s */
  stallMs?: number
  /** 等响应头的上限,默认 60 s(内置默认地址意味着每台机器都会去碰一台可能挂掉的服务器) */
  headersTimeoutMs?: number
  /** 重试间隔从 3 s 起翻倍,封顶默认 30 s */
  maxBackoffMs?: number
  /** 测试注入 */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export type DownloadResult = {
  bytes: number
  sha256: string
  /** 一共尝试了几次(1 = 一次成功) */
  attempts: number
  /** 开始时 .part 里已有多少字节(0 = 全新下载) */
  resumedFrom: number
}

/** 4xx:服务器明确说不行,重试没有意义 */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = "HttpError"
  }
}

/** 内部信号:丢掉 .part 立刻从头再来(不等退避) */
class RestartFromScratch extends Error {}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

/** 把 error 及其 cause 链拼成一句话:`fetch failed(原因:other side closed [UND_ERR_SOCKET])` */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let cur: unknown = error
  for (let depth = 0; cur != null && depth < 6; depth++) {
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown; address?: unknown; port?: unknown }
    let text = typeof cur === "string" ? cur : String(e.message ?? cur)
    if (typeof e.code === "string" && e.code && !text.includes(e.code)) text += ` [${e.code}]`
    if (typeof e.address === "string" && e.address) text += ` ${e.address}${e.port ? `:${e.port}` : ""}`
    if (text && !parts.includes(text)) parts.push(text)
    cur = e.cause
  }
  if (parts.length === 0) return String(error)
  return parts.length === 1 ? parts[0] : `${parts[0]}(原因:${parts.slice(1).join(" / ")})`
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

async function hashInto(hash: ReturnType<typeof createHash>, file: string): Promise<void> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
}

function partSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

async function closeSink(sink: WriteStream | undefined): Promise<void> {
  if (!sink) return
  sink.destroy()
  // 等 fd 真正关掉再去量 .part 的长度,否则还在飞的那次写入会让"从哪接上"算错。
  if (!sink.closed) {
    await Promise.race([once(sink, "close").catch(() => undefined), new Promise((r) => setTimeout(r, 2000))])
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500
  return !(error instanceof Error && error.message === "sha256 不匹配")
}

/**
 * 下载 url 到 dest(经 dest.part,校验通过才 rename 到位)。失败会重试并从 .part 续传;
 * 放弃时 .part 保留,下次调用接着下。
 */
export async function fetchToFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const fetchImpl = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 15)
  const stallMs = opts.stallMs ?? 60_000
  const headersTimeoutMs = opts.headersTimeoutMs ?? 60_000
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000

  mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = dest + ".part"
  const resumedFrom = partSize(tmp)
  let attempts = 0
  let usedPart = resumedFrom > 0
  let fullRestartUsed = false

  while (true) {
    attempts++
    let offset = partSize(tmp)
    let hash = createHash("sha256")
    if (offset > 0) {
      usedPart = true
      await hashInto(hash, tmp)
    }
    let received = offset
    let total: number | null = null
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number, why: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => ac.abort(new Error(why)), ms)
    }
    let sink: WriteStream | undefined
    let sinkError: Error | undefined
    try {
      arm(headersTimeoutMs, `${Math.round(headersTimeoutMs / 1000)} 秒内没有收到响应`)
      const res = await fetchImpl(url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal: ac.signal,
      })
      if (offset > 0 && res.status === 416) {
        await res.body?.cancel().catch(() => undefined)
        throw new RestartFromScratch(".part 比服务器上的文件还长")
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new HttpError(res.status)
      }
      let append = false
      if (offset > 0) {
        if (res.status === 206) {
          const m = CONTENT_RANGE_RE.exec(res.headers.get("content-range") ?? "")
          if (!m || Number(m[1]) !== offset) {
            await res.body?.cancel().catch(() => undefined)
            throw new RestartFromScratch(`服务器的 Content-Range(${res.headers.get("content-range")})与续传位置 ${offset} 不符`)
          }
          if (m[3] !== "*") total = Number(m[3])
          append = true
        } else {
          // 200:服务器不认 Range,整个文件重新来。
          offset = 0
          received = 0
          hash = createHash("sha256")
        }
      }
      if (total === null) {
        const len = res.headers.get("content-length")
        if (len !== null && /^\d+$/.test(len)) total = offset + Number(len)
      }
      if (!res.body) throw new Error("响应没有内容")

      sink = append ? createWriteStream(tmp, { flags: "r+", start: offset }) : createWriteStream(tmp, { flags: "w" })
      sink.on("error", (error) => {
        sinkError = error
        ac.abort(error)
      })
      arm(stallMs, `${Math.round(stallMs / 1000)} 秒没有收到数据`)
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm(stallMs, `${Math.round(stallMs / 1000)} 秒没有收到数据`)
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        hash.update(buf)
        received += buf.byteLength
        opts.onBytes?.(received, total)
        if (!sink.write(buf)) await once(sink, "drain")
      }
      clearTimeout(timer)
      if (sinkError) throw sinkError
      await new Promise<void>((resolve, reject) => {
        sink!.once("error", reject)
        sink!.end(resolve)
      })
      sink = undefined
      if (total !== null && received < total) throw new Error(`连接提前结束(${received}/${total} 字节)`)

      const digest = hash.digest("hex")
      if (opts.sha256 && digest !== opts.sha256) {
        rmSync(tmp, { force: true })
        if (usedPart && !fullRestartUsed && attempts < maxAttempts) {
          // 续传拼出来的文件不对:.part 可能是上一版的残留,丢掉全新下一次再下结论。
          fullRestartUsed = true
          continue
        }
        throw new Error("sha256 不匹配")
      }
      renameSync(tmp, dest)
      return { bytes: received, sha256: digest, attempts, resumedFrom }
    } catch (error) {
      clearTimeout(timer)
      await closeSink(sink)
      if (sinkError) {
        rmSync(tmp, { force: true })
        throw new Error(`写入 ${tmp} 失败:${describeError(sinkError)}`)
      }
      if (error instanceof RestartFromScratch) {
        rmSync(tmp, { force: true })
        if (attempts >= maxAttempts) throw new Error(`下载失败(已尝试 ${attempts} 次):${error.message}`)
        continue
      }
      if (!isRetryable(error)) throw error
      if (attempts >= maxAttempts) {
        throw new Error(`下载失败(已重试 ${attempts - 1} 次,半截文件保留在 .part 供下次续传):${describeError(error)}`)
      }
      const waitMs = Math.min(maxBackoffMs, 3000 * 2 ** (attempts - 1))
      usedPart = usedPart || partSize(tmp) > 0
      opts.onRetry?.({ attempt: attempts, maxAttempts, resumeFrom: partSize(tmp), waitMs, error: describeError(error) })
      await sleep(waitMs)
    }
  }
}

/** 删掉 dir 下 `<name>.part` 里 name 匹配 pattern 且不等于 keepFile 的(快照换代后过期的半截文件) */
export function pruneStaleParts(dir: string, keepFile: string, pattern: RegExp): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === keepFile + ".part") continue
    if (name.endsWith(".part") && pattern.test(name.slice(0, -".part".length))) {
      try {
        rmSync(path.join(dir, name), { force: true })
      } catch {}
    }
  }
}
