/**
 * 会话级日志采集器:子进程、环形缓冲、落盘文件都归它,工具的五个动作只是对它发指令。
 *
 * 【为什么不是"再来一个 bash"】
 * 日志源是长驻、有状态、主动吐数据的,和一次性 spawn 的引擎工具(runEngine)正相反。
 * 采集器活在工具实例的闭包里 —— 一个会话一个日志源,不做全局注册表,也不做多端口。
 *
 * 【两种源,同一个采集器】
 * child 是一个往 stdout 吐字节的子进程(串口是 serial.ts 给的 argv:POSIX 上是 cat 读继承来的 fd,
 * Windows 上是 PowerShell;command 是模型自己写的 argv);tcp 是 gdb server 吐 RTT/日志的端口
 * (node:net,进程内,没有子进程)。两者都只是"一个往缓冲吐字节的流",所以缓冲、折叠、wait 只有一份。
 *
 * 【进程纪律】(评审确认过的两个真坑;只适用于子进程源)
 * - detached + kill(-pid):`sh -c "…"` 这类源里真正握着设备的是孙子进程,只杀 shell 会留下孤儿
 *   一直占着串口。与 runEngine 同一份 killTree。
 * - unref:采集中的子进程和它的管道绝不能拖住事件循环,否则内核进程退出时不肯死。
 *
 * 【上下文纪律】全量永远落盘(<cwd>/.yoma/logs/hw-*.log),给模型的永远是节选(excerpt.ts);
 * 查历史复用 read/grep 工具,不在这里造检索。wait 没命中时**不推游标**—— 预览是预览,证据不能
 * 因为看了一眼就消失。
 *
 * 落盘用 node:fs 的 WriteStream 而不是 env.writeFile:后者是一次性读写,这里要的是行速率的追加。
 */

import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, createWriteStream, type WriteStream } from "node:fs"
import net from "node:net"
import { SerialOutput } from "./serial-output.ts"

import { killOnHostExit, killTree, unrefStream } from "../../domain/engines.ts"
import {
  charBudgetFor,
  compilePattern,
  type DisplayRow,
  foldLines,
  type LogLine,
  renderLine,
  renderRows,
  sanitizeText,
  selectForDisplay,
  splitChunk,
} from "./excerpt.ts"

/** 环形缓冲上限:两条一起兜住"行多"和"行长"两种撑爆方式。 */
const DEFAULT_BUFFER_LINES = 5000
const DEFAULT_BUFFER_BYTES = 512 * 1024
/** wait 没命中时的预览行数。 */
export const PREVIEW_ROWS = 12
/** wait 命中时前后各带几行上下文。 */
const CONTEXT_ROWS = 3
const FORCE_KILL_GRACE_MS = 3_000
export const EXIT_WAIT_MS = 5_000
/**
 * 直接子进程早就退了、管道还被孙进程握着时 stop 等 'close' 的宽限:组杀够得着它就几毫秒内到;
 * 够不着(setsid / nohup / Windows 没有进程组)等多久都不会来 —— 不该让每次 stop 都白等 5 秒。
 */
const ORPHAN_FLUSH_GRACE_MS = 1_000

/** 进程退出时兜底杀掉还活着的采集子进程 —— 否则它会一直握着串口/管道。 */
const liveCaptures = new Set<LogCapture>()

export type LogSource =
  | {
      kind: "child"
      argv: string[]
      /**
       * 已经打开好的设备 fd,作为子进程的 **stdin** 传下去(串口就走这条路,见 serial.ts:
       * 读进程自己 open 那个 tty 会把它变成控制终端,然后 SIGTERM 杀不掉)。
       * **所有权从构造那一刻起就归 LogCapture**,调用方不要再自己 close。
       */
      hold?: number
      serial?: { port: string; baud: number }
      writeFd?: number
    }
  /** gdb server 的 RTT/telnet 口这类 TCP 流:进程内 net.Socket,没有子进程要杀。 */
  | { kind: "tcp"; host: string; port: number }

export interface LogCaptureOptions {
  maxBufferLines?: number
  env?: NodeJS.ProcessEnv
}

export interface WaitOutcome {
  kind: "matched" | "timeout" | "exited" | "aborted"
  line?: LogLine
  rows: DisplayRow[]
  /** 本次等待期间新到的行数。 */
  newLines: number
  /** 命中时:命中行之前被跳过的未读行数。 */
  skippedBefore?: number
  /** 命中时:重看这些行的起点。 */
  resumeFrom?: number
}

export interface ReadResult {
  text: string
  from: number
  /** 窗口里的原始行数。 */
  rawTotal: number
  /** 过滤后剩下的原始行数(无 pattern 时等于 rawTotal)。 */
  matchedLines: number
  /** 折叠后的组数。 */
  groups: number
  omittedLines: number
  lost: number
}

export class LogCapture {
  readonly source: LogSource
  readonly label: string
  readonly file: string
  readonly cwd: string
  private readonly env: NodeJS.ProcessEnv

  private child?: ChildProcess
  private socket?: net.Socket
  private stream?: WriteStream
  private pendingOut = ""
  private pendingErr = ""
  private readonly maxBufferLines: number
  private hold?: number
  private serialOutput?: SerialOutput
  private protocolBuffer = ""
  private waiters = new Set<() => void>()
  private ended = false
  private forced = false

  lines: LogLine[] = []
  nextSeq = 0
  bufferedBytes = 0
  totalLines = 0
  dropped = 0
  cursor = 0
  startedAt = 0
  /** 直接子进程的终态(退出码 / 信号)。TCP 源断开时也落一份(code null)。 */
  exited?: { code: number | null; signal: string | null; at: number }
  /** 采集真正结束的时刻(finish 那一拍):status 的时长按它算,而不是按直接子进程退出的时刻。 */
  endedAt?: number

  constructor(source: LogSource, label: string, file: string, cwd: string, options?: LogCaptureOptions) {
    if (source.kind === "child" && source.argv.length === 0) throw new Error("log start needs a command to run")
    this.source = source
    this.label = label
    this.file = file
    this.cwd = cwd
    this.env = { ...(options?.env ?? process.env) }
    this.maxBufferLines = options?.maxBufferLines ?? DEFAULT_BUFFER_LINES
    this.hold = source.kind === "child" ? source.hold : undefined
    if (source.kind === "child" && source.serial) this.serialOutput = new SerialOutput(source.writeFd)
  }

  /** 子进程已经把 fd 复制走了(fork 那一刻),父进程这一份立刻还回去。 */
  private releaseHold(): void {
    const fd = this.hold
    this.hold = undefined
    if (fd !== undefined) closeSync(fd)
  }

  /**
   * 还在采吗。按 **finished**('close':stdio 流都关了)判,不按 **exited**('exit':直接子进程死了)判 ——
   * `sh -c "reader &"` 这类源里 shell 一退 'exit' 就来了,而真正吐字节的是孙进程,它握着管道,行还在来。
   * 按 exited 判的后果(2026-09-14 审稿实测):status 说 "exited" 但行数还在长;`log start` 的"已在采"
   * 门放第二个源进来,旧采集器被顶掉却还活着 —— dispose 只收当前那个,串口一直被那个孙进程占着。
   */
  get running(): boolean {
    return (!!this.child || !!this.socket) && !this.ended
  }

  /** 采集结束了(stop / 源自己退 / spawn 失败三条路都汇到 finish)。 */
  get finished(): boolean {
    return this.ended
  }

  /**
   * stop 等不到 'close'、是 finish 硬收的场:说明有读进程逃出了进程组(setsid / nohup / Windows),
   * 它可能还握着设备。给模型看的"设备可能还占着"按它判,不按 exited 判 —— 直接子进程退没退说明不了孙进程。
   */
  get forcedEnd(): boolean {
    return this.forced
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** 起源并等到它真的活了 —— 二进制不存在 / 端口不通这类错误要在 start 就报出来。 */
  async start(): Promise<void> {
    this.startedAt = Date.now()
    this.stream = createWriteStream(this.file, { flags: "a" })
    // 落盘失败(磁盘满/权限)不该把会话打死:记一行进缓冲,继续采集。
    this.stream.on("error", (error) => {
      this.push(`log file write failed: ${String(error)}`, true)
      this.stream = undefined
    })
    if (this.source.kind === "tcp") await this.startTcp(this.source)
    else await this.startChild(this.source.argv)
    if (!this.finished) liveCaptures.add(this)
    // 让位:宿主自己处理了信号就不接管(见 killOnHostExit)。
    killOnHostExit(liveCaptures, { yieldToHost: true })
  }

  private async startChild(argv: string[]): Promise<void> {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: this.cwd,
        env: this.env,
        stdio: [this.hold ?? (this.serialOutput ? "pipe" : "ignore"), "pipe", "pipe"],
        // 自成进程组,stop 才能连孙子进程一起收掉(见 killTree)。
        detached: process.platform !== "win32",
        // 桌面端是 GUI 进程:PowerShell 等源起来时不要闪一个控制台窗口。
        windowsHide: true,
      })
    } finally {
      this.releaseHold()
    }
    this.child = child
    if (this.serialOutput && child.stdin) this.serialOutput.attach(child.stdin)

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", (error) => {
        // spawn 失败(二进制不存在等)不会有 'exit' 事件 —— 手动落一个终态,
        // 否则 running 会永远返回 true。
        this.exited = { code: null, signal: null, at: Date.now() }
        this.finish()
        reject(new Error(`failed to start log source \`${argv.join(" ")}\`: ${String(error)}`))
      })
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.consume(chunk, false))
    child.stderr?.on("data", (chunk: string) => {
      if (!this.serialOutput || this.source.kind !== "child" || this.source.writeFd !== undefined) { this.consume(chunk, true); return }
      this.protocolBuffer += chunk
      let newline: number
      while ((newline = this.protocolBuffer.indexOf("\n")) >= 0) {
        const line = this.protocolBuffer.slice(0, newline).replace(/\r$/, "")
        this.protocolBuffer = this.protocolBuffer.slice(newline + 1)
        if (!this.serialOutput.acknowledge(line)) this.consume(line + "\n", true)
      }
    })
    child.on("exit", (code, signal) => {
      this.exited = { code, signal, at: Date.now() }
      this.flushPending()
      this.notify()
    })
    child.on("close", () => this.finish())

    // 采集绝不能拖住事件循环:宿主该退出时就退出(退出钩子负责收尸)。
    // 等待期间由 waitForChange 自己的定时器把循环撑住。
    child.unref()
    unrefStream(child.stdout)
    unrefStream(child.stderr)
    unrefStream(child.stdin)
    if (this.serialOutput) await this.serialOutput.waitReady()
  }

  private async startTcp(source: { host: string; port: number }): Promise<void> {
    const socket = net.connect({ host: source.host, port: source.port })
    this.socket = socket
    socket.setEncoding("utf8")

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onError)
        resolve()
      }
      const onError = (error: Error) => {
        socket.off("connect", onConnect)
        this.exited = { code: null, signal: null, at: Date.now() }
        this.finish()
        reject(
          new Error(
            `failed to connect log source ${source.host}:${source.port}: ${String(error)} — is the gdb server running and its RTT/telnet port open?`,
          ),
        )
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
    })

    socket.on("data", (chunk: string) => this.consume(chunk, false))
    // 连接后的错误(对端重置等)等价于"源退出";'close' 必随其后,终态在那里落。
    socket.on("error", () => {})
    socket.once("close", () => {
      this.exited ??= { code: null, signal: null, at: Date.now() }
      this.flushPending()
      this.notify()
      this.finish()
    })
    // 与子进程同一条纪律:采集绝不能拖住事件循环。
    socket.unref()
  }

  private consume(chunk: string, err: boolean): void {
    const pending = err ? this.pendingErr : this.pendingOut
    const split = splitChunk(pending, chunk)
    if (err) this.pendingErr = split.pending
    else this.pendingOut = split.pending
    for (const text of split.lines) this.push(text, err)
    if (split.lines.length > 0) this.notify()
  }

  /** 进程结束时把没等到换行的残余也算作一行,不然最后一句话会消失。 */
  private flushPending(): void {
    for (const [text, err] of [
      [this.pendingOut, false],
      [this.pendingErr, true],
    ] as const) {
      const clean = sanitizeText(text).trim()
      if (clean) this.push(clean, err)
    }
    this.pendingOut = ""
    this.pendingErr = ""
  }

  private push(text: string, err: boolean): void {
    const line: LogLine = { seq: this.nextSeq++, t: Date.now() - this.startedAt, text, ...(err ? { err: true } : {}) }
    this.lines.push(line)
    this.totalLines++
    this.bufferedBytes += text.length + 1
    this.stream?.write(`${renderLine(line)}\n`)
    this.trim()
  }

  /** 环形缓冲:超限从头丢,丢掉的只在文件里,dropped 必须显式告诉模型。 */
  private trim(): void {
    let drop = 0
    while (
      this.lines.length - drop > this.maxBufferLines ||
      (this.bufferedBytes > DEFAULT_BUFFER_BYTES && this.lines.length - drop > 1)
    ) {
      this.bufferedBytes -= this.lines[drop]!.text.length + 1
      drop++
    }
    if (drop > 0) {
      this.lines.splice(0, drop)
      this.dropped += drop
    }
  }

  private notify(): void {
    for (const wake of this.waiters) wake()
  }

  /** 有新行 / 进程退出 / 超时 / 中断,四者任一即返回。 */
  private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this.waiters.delete(wake)
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const wake = () => done()
      const timer = setTimeout(done, Math.max(0, timeoutMs))
      this.waiters.add(wake)
      signal?.addEventListener("abort", done, { once: true })
    })
  }

  /** waitForChange 也会被"来了新行"叫醒,所以这里必须循环等到条件成立或到点。 */
  private async waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!done() && Date.now() < deadline) {
      await this.waitForChange(deadline - Date.now())
    }
  }

  /** 自 seq 起的行(游标落在已丢弃区间时从最老的一行开始)。 */
  linesSince(seq: number): { lines: LogLine[]; lost: number } {
    const oldest = this.lines[0]?.seq ?? this.nextSeq
    const lost = Math.max(0, Math.min(oldest, this.nextSeq) - seq)
    return { lines: this.lines.filter((line) => line.seq >= seq), lost }
  }

  /** 最近若干行的节选,用于 wait 的预览和流式更新 —— 同样走折叠 + 骨架采样。 */
  previewRows(fromSeq: number, maxRows: number, maxChars: number): DisplayRow[] {
    const { lines } = this.linesSince(fromSeq)
    return selectForDisplay(foldLines(lines), maxRows, maxChars).rows
  }

  read(options: { since?: number; pattern?: string; maxLines: number }): ReadResult {
    const from = options.since ?? this.cursor
    const { lines, lost } = this.linesSince(from)
    const filter = options.pattern ? compilePattern(options.pattern) : undefined
    const selected = filter ? lines.filter((line) => filter.test(line.text)) : lines
    const folded = foldLines(selected)
    const display = selectForDisplay(folded, options.maxLines, charBudgetFor(options.maxLines))
    // pattern 是查询而不是消费:过滤读不推游标,否则没匹配上的行就被悄悄跳过了。
    if (!filter && lines.length > 0) this.cursor = this.nextSeq
    return {
      text: renderRows(display.rows),
      from,
      rawTotal: lines.length,
      matchedLines: selected.length,
      groups: folded.length,
      omittedLines: display.omittedLines,
      lost,
    }
  }

  /**
   * 等到有新行命中 pattern。先查已缓冲的行 —— 板子往往在模型调用 wait 之前就已经打完了。
   * 命中才推游标;超时/退出/中断只给预览,游标原样保留(证据不能因为看了一眼就消失)。
   */
  async wait(options: {
    pattern: string
    timeoutMs: number
    signal?: AbortSignal
    onTick?: () => void
  }): Promise<WaitOutcome> {
    const re = compilePattern(options.pattern)
    const startCursor = this.cursor
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      const { lines } = this.linesSince(this.cursor)
      const hit = lines.find((line) => re.test(line.text))
      if (hit) {
        // 上下文从整个缓冲里取,而不是只从未读窗口 —— 读过一轮之后命中,
        // 前文照样要给,否则模型看到的是一条没有来龙去脉的孤行。
        const index = this.lines.findIndex((line) => line.seq === hit.seq)
        const before = this.lines.slice(Math.max(0, index - CONTEXT_ROWS), index)
        const after = this.lines.slice(index + 1, index + CONTEXT_ROWS + 1)
        // 命中点要一路交到渲染:超长行从行首裁的话,裁掉的正好是命中的那一段。
        // re 没有 g 标志,exec 不带 lastIndex 状态,与上面那句 test 共用一个对象是安全的。
        const matchAt = re.exec(hit.text)?.index
        // 命中行**单独成行**,前后各自折叠:折叠组只显示首行,命中的若是 `count=42` 而前一行是 `count=41`,
        // 整段就折成 "count=41 ×3" —— 工具一边说 matched 一边给一份没有那行的节选(2026-09-14 审稿实测)。
        const asRows = (group: LogLine[]): DisplayRow[] => foldLines(group).map((row) => ({ type: "line", row }))
        const rows: DisplayRow[] = [
          ...asRows(before),
          { type: "line", row: { line: hit, count: 1, lastT: hit.t }, marked: true, matchAt },
          ...asRows(after),
        ]
        const last = after[after.length - 1] ?? hit
        const skippedBefore = Math.max(0, (before[0] ?? hit).seq - startCursor)
        this.cursor = Math.max(this.cursor, last.seq + 1)
        return {
          kind: "matched",
          line: hit,
          rows,
          newLines: this.nextSeq - startCursor,
          skippedBefore,
          resumeFrom: startCursor,
        }
      }
      const preview = () => ({
        rows: this.previewRows(this.cursor, PREVIEW_ROWS, charBudgetFor(PREVIEW_ROWS)),
        newLines: this.nextSeq - startCursor,
      })
      if (options.signal?.aborted) return { kind: "aborted", ...preview() }
      // 按 finished 判而不是 exited:'close' 在 stdio 流都关了之后才来,最后一段 stdout 一定已经进了缓冲,
      // 不必再排干;而 'exit' 之后管道可能还被孙进程握着、行还在来 —— 那不是"源退了"。
      if (this.ended) return { kind: "exited", ...preview() }
      if (Date.now() >= deadline) return { kind: "timeout", ...preview() }
      await this.waitForChange(deadline - Date.now(), options.signal)
      options.onTick?.()
    }
  }

  /** 等源自己退出,或者到点 —— 给"它到底起来了没"一个有界的答案。 */
  async settle(timeoutMs: number): Promise<void> {
    await this.waitUntil(() => !!this.exited, timeoutMs)
  }

  async stop(): Promise<void> {
    this.serialOutput?.close()
    // TCP 源:destroy 触发 'close',终态与 finish 都在那个处理器里落。
    if (this.socket && !this.ended) {
      this.socket.destroy()
      await this.waitUntil(() => this.ended, EXIT_WAIT_MS)
    }
    const child = this.child
    // 按 ended 判而不是 exited:直接子进程死了、管道还被孙进程握着时,进程组还在,
    // kill(-pid) 照样够得着它 —— 这正是"真正握着串口的是孙进程"那条纪律要收的对象。
    if (child && !this.ended) {
      const alreadyExited = !!this.exited
      killTree(child, "SIGTERM")
      const force = setTimeout(() => {
        if (!this.ended) killTree(child, "SIGKILL")
      }, FORCE_KILL_GRACE_MS)
      force.unref()
      // 等的是 'close'(管道排干),最后几行才不会连同 finish() 一起被丢掉。
      await this.waitUntil(() => this.ended, alreadyExited ? ORPHAN_FLUSH_GRACE_MS : EXIT_WAIT_MS)
      clearTimeout(force)
    }
    if (!this.ended && (this.child || this.socket)) this.forced = true
    this.finish()
  }

  /** 同步、绝不抛:只给进程退出/信号钩子用。 */
  killNow(): void {
    try {
      this.socket?.destroy()
    } catch {
      // socket 可能已经关了。
    }
    if (!this.child) return
    killTree(this.child, "SIGKILL")
  }

  async writeSerial(data: Buffer): Promise<number> {
    if (!this.running || !this.serialOutput) throw new Error("Connect a serial port before sending (TCP and command logs are read-only)")
    return this.serialOutput.write(data)
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    this.endedAt = Date.now()
    // 采集结束 = 串口该还回去了。stop / 源自己退 / spawn 失败三条路都汇到这里。
    this.releaseHold()
    this.serialOutput?.close()
    if (this.protocolBuffer) { this.consume(this.protocolBuffer, true); this.protocolBuffer = "" }
    // 先断源再收尾:stop() 之后哪怕子进程还活着(比如被孤儿孙进程握着管道),
    // 也不能再往缓冲和文件里塞行 —— 否则 running=false 却还在长。
    this.child?.stdout?.removeAllListeners("data")
    this.child?.stderr?.removeAllListeners("data")
    this.socket?.removeAllListeners("data")
    this.flushPending()
    this.child?.stdout?.destroy()
    this.child?.stderr?.destroy()
    this.socket?.destroy()
    this.stream?.end()
    this.stream = undefined
    liveCaptures.delete(this)
    this.notify()
  }
}
