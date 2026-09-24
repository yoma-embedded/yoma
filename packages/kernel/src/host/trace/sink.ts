/**
 * 调试轨迹的落盘(docs/调试留痕-规划-20260924.md §3.1)。
 *
 * 一行一个 JSON:`{"t":<毫秒时间戳>,"ev":"<事件>",...字段}`。只记元数据(时刻、耗时、字数、状态码、工具名与一行摘要),
 * 不记对话正文与工具输出 —— 这份文件会进 "Export logs" 的 zip,用户可能转给别人。
 *
 * 三条纪律:
 * 1. **绝不拖累 agent**。写是攒批异步的(缺省 250 ms 一次,计时器 unref,不拖住进程退出);写失败就停写并在 stderr
 *    说一句,绝不把异常抛回调用方 —— 调用方是 harness 的事件回调和模型请求的 fetch,抛出去就是一轮失败。
 * 2. **不无限长**。超过 maxBytes 把当前文件改名成 `<名>.1.jsonl`(覆盖上一份)再写新的。
 * 3. **关的时候冲干净**。`close()` 等在飞的那次追加写完,再把剩下的同步写掉(内核退出前 dispose 会 await 它)。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import path from "node:path"

export type TraceFields = Record<string, unknown>

export interface Trace {
  /** 关着的轨迹上 write 什么都不做;调用方可以据此省掉准备字段的功夫。 */
  readonly enabled: boolean
  write(ev: string, fields?: TraceFields): void
  /** 把攒着的写出去(测试与关之前用)。 */
  flush(): Promise<void>
  close(): Promise<void>
}

export const NOOP_TRACE: Trace = {
  enabled: false,
  write() {},
  flush: async () => {},
  close: async () => {},
}

export interface TraceOptions {
  /** 轨迹文件的路径。没有就是关着的轨迹。 */
  file?: string
  /** 超过这么多字节就轮转,缺省 20 MB。 */
  maxBytes?: number
  /** 攒批的间隔,缺省 250 ms。 */
  flushMs?: number
  now?: () => number
}

/** 缺省轮转阈值:20 MB。一天高强度使用实测几 MB(事件是粗粒度的,不逐 delta)。 */
export const TRACE_MAX_BYTES = 20 * 1024 * 1024

/** 字符串字段的上限:摘要、错误信息都够用;防止哪个调用方把一整段输出塞进来。 */
const MAX_STRING = 500

/**
 * 轨迹写到哪:`YOMA_TRACE=off|0|false|no` 关掉;`YOMA_TRACE_FILE` 显式指定(bench 与无头跑用);否则用宿主给的缺省
 * (桌面端是本次启动的日志目录)。
 */
export function traceFileFromEnv(env: NodeJS.ProcessEnv = process.env, fallback?: string): string | undefined {
  const switched = env.YOMA_TRACE?.trim().toLowerCase()
  if (switched === "off" || switched === "0" || switched === "false" || switched === "no") return undefined
  const explicit = env.YOMA_TRACE_FILE?.trim()
  return explicit || fallback
}

export function createTrace(options: TraceOptions = {}): Trace {
  if (!options.file) return NOOP_TRACE
  return new FileTrace(options.file, options)
}

/** 轮转后的旧文件名:`trace.jsonl` → `trace.1.jsonl`。 */
export function rotatedName(file: string): string {
  const ext = path.extname(file)
  return ext ? `${file.slice(0, -ext.length)}.1${ext}` : `${file}.1`
}

class FileTrace implements Trace {
  readonly enabled = true
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly flushMs: number
  private buffer: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private written: number | undefined
  private state: "open" | "closing" | "closed" | "broken" = "open"

  constructor(
    private readonly file: string,
    options: TraceOptions,
  ) {
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes ?? TRACE_MAX_BYTES
    this.flushMs = options.flushMs ?? 250
  }

  write(ev: string, fields?: TraceFields): void {
    if (this.state !== "open") return
    let line: string
    try {
      line = JSON.stringify({ t: this.now(), ev, ...clip(fields) })
    } catch {
      // 字段里混进了循环引用之类 —— 丢这一行,不丢整份轨迹
      return
    }
    this.buffer.push(line)
    this.schedule()
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const chunk = this.take()
    if (chunk) this.chain = this.chain.then(() => this.append(chunk))
    return this.chain
  }

  async close(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return this.chain
    if (this.state === "broken") return
    this.state = "closing"
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.chain
    const chunk = this.take()
    if (chunk) this.appendSync(chunk)
    this.state = "closed"
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.flushMs)
    this.timer.unref?.()
  }

  private take(): string {
    if (this.buffer.length === 0) return ""
    const chunk = `${this.buffer.join("\n")}\n`
    this.buffer = []
    return chunk
  }

  private prepare(bytes: number): void {
    if (this.written === undefined) {
      mkdirSync(path.dirname(this.file), { recursive: true })
      this.written = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0
    }
    if (this.written > 0 && this.written + bytes > this.maxBytes) {
      renameSync(this.file, rotatedName(this.file))
      this.written = 0
    }
    this.written += bytes
  }

  private async append(chunk: string): Promise<void> {
    if (this.state === "broken") return
    try {
      this.prepare(Buffer.byteLength(chunk))
      await appendFile(this.file, chunk)
    } catch (error) {
      this.fail(error)
    }
  }

  private appendSync(chunk: string): void {
    try {
      this.prepare(Buffer.byteLength(chunk))
      appendFileSync(this.file, chunk)
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    if (this.state === "broken") return
    this.state = "broken"
    this.buffer = []
    try {
      process.stderr.write(`yoma trace disabled (${this.file}): ${(error as Error)?.message ?? String(error)}\n`)
    } catch {
      // stderr 也写不了就算了
    }
  }
}

/** 字符串字段截到 MAX_STRING,undefined 的字段不写。 */
function clip(fields: TraceFields | undefined): TraceFields | undefined {
  if (!fields) return undefined
  const out: TraceFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    else out[key] = value
  }
  return out
}
