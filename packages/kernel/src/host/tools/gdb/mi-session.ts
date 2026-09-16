/**
 * 一个 gdb 子进程 + 它的状态机:MI 收发、token 派发、停止等待、落盘、关闭。
 *
 * 【三条实测事实,决定了下面的骨架】
 * 1. `mi-async` 默认 **off**,而 off 的时候第一条 `-exec-continue` 之后 gdb 就不再读 stdin —— 后续所有命令
 *    (包括 interrupt、包括 stop)石沉大海,只能 SIGKILL。所以启动握手里它是硬性开关,而且必须回读校验。
 * 2. 结果记录在它引起的异步记录**之后**到(实测 `*stopped` 先于 `20^connected`)。所以等停止的 waiter 必须在
 *    **发命令之前**装好,否则会漏掉已经到达的停止。
 * 3. 单条 MI record 能有 5 万甚至 65 万字符,而且 `(gdb) ` 在异步停止后不发。分帧只按 \n,派发只认 `^`。
 *    细节见 domain/gdb/mi.ts。
 *
 * 【上下文纪律】同 log:全量落盘,进上下文的一律有界且**截断必须标注**。落两份:session-*.log 是解码后的
 * 可读转录(模型 grep / 人 tail -f),session-*.mi 是原始对话(只给调工具用,不告诉模型)。stops-*.jsonl
 * 每次停止一行,让"我们之前停在哪"在自动压缩之后还能查得到。
 *
 * 【进程纪律】gdb 子进程 detached 自成进程组、unref。关闭顺序是先 `-gdb-exit` 再关 server —— 反过来 gdb 会
 * 卡在 remote 等待里。孤儿 gdbserver 攥着探针,下次的失败长得和硬件坏了一模一样,而拔插 USB 能"修好",
 * 于是错误假设被确认、泄漏永远找不到。
 */

import { type ChildProcess, spawn } from "node:child_process"
import { appendFileSync, createWriteStream, type WriteStream } from "node:fs"
import { finished as streamFinished } from "node:stream/promises"

import { killOnHostExit, killTree, unrefStream } from "../../domain/engines.ts"
import {
  clip,
  escapeCString,
  type Frame,
  frameOf,
  type MiRecord,
  miNumber,
  miString,
  miTuple,
  parseRecord,
  renderFrame,
  splitRecords,
  unwrapList,
} from "../../domain/gdb/index.ts"
import type { GdbTargetState } from "./contract.ts"

/** 单条 MI 命令的默认上限。gdb 卡住是常态(探针掉了、目标进 WFI),每条都要有界。 */
export const COMMAND_TIMEOUT_MS = 20_000
const FORCE_KILL_GRACE_MS = 3_000
const EXIT_WAIT_MS = 5_000
const GDB_EXIT_TIMEOUT_MS = 3_000

export interface StopInfo {
  n: number
  epoch: number
  /** 相对会话启动的毫秒。 */
  t: number
  reason: string
  bkptno?: string
  frame?: Frame
  /** 从 resume 到停止的耗时 —— "秒停"和"跑了 4 秒才停"是两个完全不同的诊断。 */
  sinceResumeMs?: number
  /** `finish` 停下来时 gdb 给的返回值(`return-value`)与它存进的便利变量(`gdb-result-var`,如 `$1`)。 */
  returnValue?: string
  resultVar?: string
}

interface Pending {
  token: number
  resolve: (r: MiRecord) => void
  reject: (e: Error) => void
  stream: string[]
  timer: ReturnType<typeof setTimeout>
}

/** 在飞的会话(跨所有工具实例):宿主退出要带走它们。killOnHostExit 只认 Set。 */
const liveSessions = new Set<GdbSession>()

export interface GdbSessionOptions {
  gdbPath: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /** 解码后的可读转录,给模型 grep、给人 tail -f。 */
  logFile: string
  /** 原始 MI,只给调工具用。 */
  miFile: string
  stopsFile: string
}

export type MiReply = MiRecord & { output: string }

export interface TrackedBreakpoint {
  kind: "break" | "watch"
  location: string
  addr?: string
  /** 占几个硬件单元:`<MULTIPLE>` 的每个 location 各算一个。 */
  units: number
}

/**
 * 命令严格串行:gdb 是个 REPL。串行让"流记录归属哪条命令"这件事不需要猜。token 仍然发,用来发现失同步。
 */
export class GdbSession {
  private child?: ChildProcess
  private pendingOut = ""
  private pending?: Pending
  /** 串行闸:上一条命令没落地就不发下一条。 */
  private queue: Promise<unknown> = Promise.resolve()
  private stopWaiters: ((r: MiRecord) => void)[] = []
  private miStream?: WriteStream
  private stopsStream?: WriteStream
  private nextToken = 1
  private lastResumeAt?: number
  private finished = false

  readonly startedAt = Date.now()
  /** 复位/意外停止/重连都 +1。缓存的断点号和地址在跨 epoch 之后一律作废。 */
  epoch = 1
  stopCount = 0
  state: GdbTargetState = "halted"
  lastStop?: StopInfo
  exited?: { code: number | null; signal: NodeJS.Signals | null }
  /**
   * 工具自己记的断点表。gdb 也记,但两件事只有这边能做:一是把 `<MULTIPLE>` 的每个 location 都算成一个硬件
   * 单元(一条 `break helper` 在 -O2 内联之后可能一口气吃掉三个),二是在**下断点的时候**就拒绝超预算,
   * 而不是等 continue 时 gdb 报 "Cannot insert breakpoint" 并且不 resume —— 那时候错误挂在错误的命令上,
   * 模型会以为目标跑起来了。
   */
  readonly breakpoints = new Map<number, TrackedBreakpoint>()

  constructor(private readonly options: GdbSessionOptions) {}

  usedUnits(kind: "break" | "watch"): number {
    let n = 0
    for (const b of this.breakpoints.values()) if (b.kind === kind) n += b.units
    return n
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get running(): boolean {
    return this.child !== undefined && this.exited === undefined
  }

  get file(): string {
    return this.options.logFile
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async spawnGdb(): Promise<void> {
    this.miStream = createWriteStream(this.options.miFile, { flags: "a" })
    this.stopsStream = createWriteStream(this.options.stopsFile, { flags: "a" })

    const child = spawn(this.options.gdbPath, ["--interpreter=mi3", "-nx", "-q"], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    this.child = child
    liveSessions.add(this)
    // 不让位:攥着探针的 gdbserver 太贵,宿主自己装了信号处理也照样要收掉它。
    killOnHostExit(liveSessions)

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError)
        resolve()
      }
      const onError = (error: Error) => {
        child.off("spawn", onSpawn)
        this.exited = { code: null, signal: null }
        liveSessions.delete(this)
        reject(new Error(`could not start ${this.options.gdbPath}: ${error.message}`))
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.consume(chunk))
    // gdb 自己的诊断走 stderr,不是 MI —— 只落盘,不解析。
    child.stderr?.on("data", (chunk: string) => this.writeLog(`[gdb stderr] ${chunk.trimEnd()}`))
    child.once("exit", (code, signal) => {
      this.exited = { code, signal }
      this.state = "exited"
      this.failPending(new Error(`gdb exited (${signal ? `signal ${signal}` : `code ${code}`})`))
    })
    // spawn 之后的错误(比如 stdin 断了)也不能变成没人接的 'error' 事件。
    child.on("error", (error) => this.writeLog(`[gdb error] ${error.message}`))
    child.stdin?.on("error", (error) => this.writeLog(`[gdb stdin] ${error.message}`))

    // 子进程绝不能拖住事件循环,否则宿主退出时进程不肯死。
    child.unref()
    unrefStream(child.stdout)
    unrefStream(child.stderr)
    unrefStream(child.stdin)
  }

  /**
   * 启动握手。每一条都是有理由的,不是抄来的模板:
   * mi-async 决定会话活不活;print elements/repeats 的默认值会在**你的预算生效之前**就把值截断,
   * 而且截断标记在值内部;backtrace limit 挡的是栈损坏时打上千帧。
   */
  async hygiene(): Promise<void> {
    const settings = [
      ["confirm", "off"],
      ["pagination", "off"],
      ["height", "0"],
      ["width", "0"],
      ["print pretty", "on"],
      ["print elements", "0"],
      ["print repeats", "0"],
      ["print null-stop", "off"],
      ["print frame-arguments", "all"],
      ["max-value-size", "65536"],
      ["backtrace limit", "200"],
      // 裸机没有共享库:pending 断点永远不会解析,静默不命中比报错糟得多。
      ["breakpoint pending", "off"],
      // 默认就是 off(停止时摘、resume 时装),显式写死,免得复位后断点被认为还在硬件里。
      ["breakpoint always-inserted", "off"],
      ["non-stop", "off"],
      ["mi-async", "on"],
      ["remotetimeout", "10"],
      ["tcp auto-retry", "off"],
    ]
    for (const [name, value] of settings) {
      await this.send(`-gdb-set ${name} ${value}`)
    }
    const check = await this.send("-gdb-show mi-async")
    if (miString(check.results?.value) !== "on") {
      throw new Error(
        "gdb refused `set mi-async on`. Without it the first continue makes gdb stop reading stdin and the session cannot be recovered — refusing to start.",
      )
    }
  }

  // ── MI 收发 ───────────────────────────────────────────────────────────────

  private consume(chunk: string): void {
    const framed = splitRecords(this.pendingOut, chunk)
    this.pendingOut = framed.pending
    if (framed.overflow) {
      this.failPending(new Error("MI stream lost sync (record over 4 MB) — the session must be restarted"))
      return
    }
    for (const line of framed.lines) this.dispatch(line)
  }

  private dispatch(line: string): void {
    this.miStream?.write(`${line}\n`)
    const record = parseRecord(line)
    switch (record.kind) {
      case "prompt":
        return
      case "foreign":
        // `pipe`/`shell` 会造出这种。记下来,绝不抛 —— 这里是 stdout 的 data 回调。
        this.writeLog(`[foreign] ${clip(line, 400)}`)
        return
      case "console":
      case "target":
        if (record.text) {
          this.pending?.stream.push(record.text)
          this.writeLog(record.text.replace(/\n$/, ""))
        }
        return
      case "log":
        if (record.text) this.writeLog(`[gdb] ${record.text.replace(/\n$/, "")}`)
        return
      case "notify":
        this.onNotify(record)
        return
      case "status":
        return
      case "exec":
        this.onExec(record)
        return
      case "result":
        this.onResult(record)
        return
    }
  }

  private onResult(record: MiRecord): void {
    const pending = this.pending
    if (!pending) {
      this.writeLog(`[unmatched result] ${clip(record.raw, 400)}`)
      return
    }
    // 一个 token 可能收到两条 `^`(^running 之后再来 ^error,"Command aborted.")。resolve-once,多出来的记进文件后丢弃。
    if (record.token !== undefined && record.token !== pending.token) {
      this.writeLog(`[token mismatch] expected ${pending.token}, got ${record.token}: ${clip(record.raw, 200)}`)
      return
    }
    if (record.partial) this.writeLog(`[partial record] ${clip(record.raw, 400)}`)
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(record)
  }

  private onExec(record: MiRecord): void {
    if (record.class === "running") {
      this.state = "running"
      this.lastResumeAt = Date.now()
      return
    }
    if (record.class !== "stopped") return

    const reason = miString(record.results?.reason) ?? "unknown"
    this.state = reason.startsWith("exited") ? "exited" : "halted"
    const info = this.recordStop(reason, {
      bkptno: miString(record.results?.bkptno),
      frame: frameOf(miTuple(record.results?.frame)),
      returnValue: miString(record.results?.["return-value"]),
      resultVar: miString(record.results?.["gdb-result-var"]),
    })
    this.writeLog(`■ stopped#${info.n} ${reason}${info.frame ? ` @ ${renderFrame(info.frame)}` : ""}`)
    this.wakeStopWaiters(record)
  }

  /**
   * 一次停止的记账:计数、StopInfo、清 lastResumeAt、落盘。onExec(有 `*stopped`)与 onNotify(目标跑完退出,
   * 压根没有 `*stopped`)两条路共用。落盘的理由:自动压缩会把"我们之前停在哪"从上下文里删掉,而原始 MI 没法 grep。
   */
  private recordStop(
    reason: string,
    extra?: { bkptno?: string; frame?: Frame; returnValue?: string; resultVar?: string },
  ): StopInfo {
    this.stopCount += 1
    const info: StopInfo = {
      n: this.stopCount,
      epoch: this.epoch,
      t: Date.now() - this.startedAt,
      reason,
      bkptno: extra?.bkptno,
      frame: extra?.frame,
      returnValue: extra?.returnValue,
      resultVar: extra?.resultVar,
      sinceResumeMs: this.lastResumeAt ? Date.now() - this.lastResumeAt : undefined,
    }
    this.lastStop = info
    this.lastResumeAt = undefined
    this.stopsStream?.write(
      `${JSON.stringify({
        n: info.n,
        epoch: info.epoch,
        t: info.t,
        reason: info.reason,
        bkptno: info.bkptno,
        func: info.frame?.func,
        file: info.frame?.file,
        line: info.frame?.line,
        addr: info.frame?.addr,
      })}\n`,
    )
    return info
  }

  /**
   * 通知记录。实测抓到、直觉一定会漏的形状:**目标跑完退出时根本没有 `*stopped`**,只有 `=thread-exited` +
   * `=thread-group-exited`(而且 exit-code 有时候还缺席)。不在这里唤醒等停的一方,一次跑到结束的 continue
   * 就会一直等到超时,然后被报成"目标卡死了" —— 而它其实是正常退出了。
   */
  private onNotify(record: MiRecord): void {
    this.writeLog(`[${record.class}]`)
    // 断点表要跟着 gdb 走:临时断点命中后 gdb 自己删掉它并发 =breakpoint-deleted(审稿实测),不跟的话
    // 预算表里留着幽灵单元,而"没断点别 continue"那道门也会被幽灵放行。
    if (record.class === "breakpoint-deleted") {
      const id = miNumber(record.results?.id)
      if (id !== undefined) this.breakpoints.delete(id)
      return
    }
    if (record.class === "breakpoint-modified") {
      const bkpt = miTuple(record.results?.bkpt)
      const number = miNumber(bkpt?.number)
      const tracked = number === undefined ? undefined : this.breakpoints.get(number)
      if (bkpt && tracked && tracked.kind === "break") {
        // <MULTIPLE> 重解析之后单元数可能变(内联体被加载 / 卸载)。
        const locations = unwrapList(bkpt.locations).length
        this.breakpoints.set(number!, {
          ...tracked,
          addr: miString(bkpt.addr) ?? tracked.addr,
          units: Math.max(1, locations),
        })
      }
      return
    }
    if (record.class === "thread-group-exited") {
      const code = miString(record.results?.["exit-code"])
      this.state = "exited"
      this.recordStop(code === undefined ? "exited (no exit code reported)" : `exited with code ${code}`)
      this.wakeStopWaiters(record)
      return
    }
    if (record.class === "target-disconnected") {
      this.state = "connection-lost"
      this.wakeStopWaiters(record)
    }
  }

  private wakeStopWaiters(record: MiRecord): void {
    const waiters = this.stopWaiters
    this.stopWaiters = []
    for (const w of waiters) w(record)
  }

  private failPending(error: Error): void {
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    const waiters = this.stopWaiters
    this.stopWaiters = []
    // 等停止的一方不该收到异常:交给上层当"没等到"处理,它比异常更可控。
    for (const w of waiters) w({ kind: "exec", class: "stopped", results: { reason: "connection-lost" }, raw: "" })
  }

  private writeLog(text: string): void {
    // 同步落盘:假 gdb 集成测试在 send() resolve 后立刻 readFileSync,WriteStream 缓冲会让 [foreign] 行还没刷到磁盘。
    try {
      appendFileSync(this.options.logFile, `${text}\n`, "utf8")
    } catch {
      // 日志目录没了(工程被删)不该拖垮会话。
    }
  }

  /**
   * 发一条 MI 命令。上一条没落地就**排队**,不报错(串行的理由见类 doc)。
   * resolve 的是该 token 的 `^` 记录,output 是这条命令在飞期间收到的 ~/@ 流文本。
   */
  send(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<MiReply> {
    const next = this.queue.then(
      () => this.sendNow(command, timeoutMs),
      () => this.sendNow(command, timeoutMs),
    )
    // 队列本身不能因为某条命令失败就断掉。
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private sendNow(command: string, timeoutMs: number): Promise<MiReply> {
    if (!this.child || this.exited) return Promise.reject(new Error("gdb is not running"))
    const token = this.nextToken++
    this.writeLog(`> ${command}`)
    const stream: string[] = []
    return new Promise<MiReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.token !== token) return
        this.pending = undefined
        reject(new Error(`gdb did not answer \`${command}\` within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending = {
        token,
        stream,
        timer,
        resolve: (r) => resolve({ ...r, output: stream.join("") }),
        reject,
      }
      this.miStream?.write(`< ${token}${command}\n`)
      this.child?.stdin?.write(`${token}${command}\n`)
    })
  }

  /** 走 console 通道跑一条普通 gdb 命令,输出从 ~/@ 流里收。 */
  console(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<MiReply> {
    return this.send(`-interpreter-exec console "${escapeCString(command)}"`, timeoutMs)
  }

  /**
   * 装一个"下一次停止"的 waiter。**必须在发 resume 命令之前调用** —— 实测 `*stopped` 会先于该命令的
   * 结果记录到达。
   */
  expectStop(): Promise<MiRecord | undefined> {
    return new Promise<MiRecord | undefined>((resolve) => {
      this.stopWaiters.push(resolve)
    })
  }

  // ── 关闭 ──────────────────────────────────────────────────────────────────

  killNow(): void {
    if (this.child && !this.exited) killTree(this.child, "SIGKILL")
  }

  async stop(): Promise<void> {
    if (!this.child || this.finished) return
    // ^exit 只表示接受退出请求,detach / remote 清理在它之后。Windows 的 SIGTERM 是硬杀,
    // 收到 ^exit 就杀会截断清理。先等进程自然退出,失去响应才升级到杀树。
    try {
      await this.send("-gdb-exit", GDB_EXIT_TIMEOUT_MS)
      await this.waitForExit(EXIT_WAIT_MS)
    } catch {
      // gdb 可能已经死了或者不理会;下面照杀。
    }
    if (!this.exited) {
      killTree(this.child, "SIGTERM")
      const forced = setTimeout(() => this.killNow(), FORCE_KILL_GRACE_MS)
      forced.unref?.()
      await this.waitForExit(EXIT_WAIT_MS)
      clearTimeout(forced)
      if (!this.exited) {
        this.killNow()
        await this.waitForExit(EXIT_WAIT_MS)
      }
      if (!this.exited) throw new Error(`gdb pid ${this.child.pid} did not exit; the session is still owned`)
    }
    // A graceful GDB exit can leave helpers in its process group. The group outlives its leader.
    if (process.platform !== "win32") killTree(this.child, "SIGKILL")
    await this.finish()
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.child?.off("exit", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      this.child?.once("exit", done)
    })
  }

  private async finish(): Promise<void> {
    this.finished = true
    liveSessions.delete(this)
    this.failPending(new Error("gdb session closed"))
    this.child?.stdout?.removeAllListeners("data")
    this.child?.stderr?.removeAllListeners("data")
    this.child?.stdout?.destroy()
    this.child?.stderr?.destroy()
    // end() 只是请求刷盘;Windows 下未关闭的句柄会让随后的清理报 EPERM。
    const streams = [this.miStream, this.stopsStream].filter((s): s is WriteStream => s !== undefined)
    this.miStream = undefined
    this.stopsStream = undefined
    await Promise.all(
      streams.map(async (stream) => {
        const closed = streamFinished(stream)
        stream.end()
        await closed
      }),
    )
  }
}
