/**
 * 会话级日志采集器:子进程、环形缓冲、落盘文件都归它,工具的五个动作只是对它发指令。
 *
 * 【为什么不是"再来一个 bash"】
 * 日志源是长驻、有状态、主动吐数据的,和一次性 spawn 的引擎工具(runEngine)正相反。
 * 采集器活在工具实例的闭包里 —— 一个会话一个日志源,不做全局注册表,也不做多端口。
 *
 * 【三种源,同一个采集器】
 * child 是一个往 stdout 吐字节的子进程(串口是 serial.ts 给的 argv:POSIX 上是 cat 读继承来的 fd,
 * Windows 上是 PowerShell;command 是模型自己写的 argv);tcp 是 gdb server 吐 RTT/日志的端口
 * (node:net,进程内,没有子进程);rtt 是 tcp 加一个自己起、自己收的 J-Link GDB server(rtt.ts)。
 * 三者都只是"一个往缓冲吐字节的流",所以缓冲、折叠、wait 只有一份。
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
import { rm, stat } from "node:fs/promises"
import net from "node:net"
import { SerialOutput } from "./serial-output.ts"

import path from "node:path"

import { killOnHostExit, killTree, unrefStream } from "../../domain/engines.ts"
import { type JlinkLookup, jlinkServerBinary, type ServerProcess, spawnServer, stopServer } from "../gdb/servers.ts"
import {
  connectRtt,
  describeServerExit,
  jlinkRttArgv,
  lastOutput,
  pickRttPorts,
  RttBannerFilter,
  rttServerMissing,
  waitForRttServer,
} from "./rtt.ts"
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

/**
 * RTT 连接被对端关掉、server 却还没退出时,给它这么久把退出码交出来 —— 源状态要说"server 退了(code N)"
 * 而不是含糊的"断开了";server 退出与 socket 关闭哪个先到是不确定的。
 */
const RTT_SERVER_EXIT_GRACE_MS = 1_000

/**
 * RTT 口刚连上就写的字节会被 J-Link 静默丢掉:它这时还没找到目标内存里的 RTT 控制块,没有 down buffer 可写。
 * 2026-09-24 实测(V9.58 + STM32G473RC,每档三次):连上后 0 ms 写,三次丢两次;50 ms 起三次都收到 shell 回应。
 * start 一返回模型 / 用户就可能立刻 write,所以写之前补足这段:连上后没满这么久、目标也还没吐过字节,就先等到点。
 * 取 300 ms 是给慢机器与大 RAM 搜索留的余量;目标先说了话就说明控制块已经找到,不必再等。
 */
const RTT_WRITE_SETTLE_MS = 300

/** 进程退出时兜底杀掉还活着的采集子进程 —— 否则它会一直握着串口/管道。 */
const liveCaptures = new Set<LogCapture>()

/**
 * 这个内核里正在读 RTT 的采集器(还在等 J-Link server 就绪的也算)。两个 RTT 读者会把字节流劈成两半、各拿一部分
 * (2026-09-24 实测),而另一个会话里的那个模型看不见(status 只报自己的),工具描述里的 "stop one first" 它照不了 ——
 * 所以同一个内核里的第二个在 startRtt 里就拒掉,并说出第一个是谁。别的进程(另开的 JLinkGDBServer、Ozone)拦不住,
 * 仍靠工具描述。源里没有探针序列号、argv 也不带 -select,所有 RTT 采集连的都是同一个缺省 J-Link,所以按"内核里任意一个"判。
 */
const rttReaders = new Set<LogCapture>()

/** 这个内核里另一个还没结束的 RTT 采集(第二个 rtt start 与 gdb 的 RTT 提示用)。 */
export function otherRttReader(self?: LogCapture): LogCapture | undefined {
  for (const reader of rttReaders) if (reader !== self && !reader.finished) return reader
  return undefined
}

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
  /**
   * J-Link RTT:采集器自己起一个只管 RTT 的 J-Link GDB server(可执行文件先按 env 的 PATH 找,再找账本与 SEGGER 的
   * 缺省安装目录,同 gdb 工具,见 jlinkServerBinary),
   * 再从它的 RTT telnet 口读。device 是 J-Link 认的器件名(调用方先过 jlinkDeviceName),speed 是 SWD kHz。
   */
  | { kind: "rtt"; device: string; speed: number }

export interface LogCaptureOptions {
  maxBufferLines?: number
  env?: NodeJS.ProcessEnv
  /** RTT 源:PATH 上没有 J-Link GDB server 时还去哪找(账本、SEGGER 的缺省安装目录,见 jlinkServerBinary)。 */
  jlink?: JlinkLookup
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

/**
 * 别的工具动了目标(烧录、复位、经 gdb load)时落进采集里的一条分界线。之后到的行才可能是新镜像 / 复位之后的输出;
 * 之前的是旧的 —— 模型分不清这两段,就会拿烧录前的旧行当成"新固件的现象"(2026-09-28 真跑实测)。
 */
export interface LogMark {
  seq: number
  /** 相对采集开始的毫秒数,与 LogLine.t 同一把尺。 */
  t: number
  text: string
  /**
   * 是不是"之前 / 之后"的分界(烧录开始、复位、load)。收尾类的标记("烧录结束""复位可能没成功")只是记一笔:
   * 拿它当 since 会把烧录期间就打出来的开机行关在线外 —— 目标在烧录器退出之前就已经复位开跑了。
   */
  boundary: boolean
}

/**
 * 源打开后到的第一块数据里就有好几行:USB 转串口(ST-Link VCP、J-Link VCOM、CP210x/FTDI)与 RTT 的上行缓冲,都会把
 * 没人读时攒下的输出在下一次打开时一口气交出来。这几行可能比这次采集早得多,甚至来自上一版固件
 * (2026-09-28 实测:ST-Link 把 25 分钟前的状态行在开口那一刻吐了出来,模型当成了现象)。只做标注不丢弃 ——
 * 板子在没人看时崩了,缓冲里那几行恰恰是唯一的证据。
 */
export interface OpenBurst {
  from: number
  to: number
  t: number
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
  private readonly jlink?: JlinkLookup

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
  /** stop() 已经开始:进行中的 start 看到它就收手,RTT 收尾时也不再把"server 退了"当成意外写进日志。 */
  private stopping = false
  /** RTT 源自己起的 J-Link GDB server。 */
  private server?: ServerProcess
  /** 就绪之后 server 又说的话(只留尾巴):它意外退出时,最后一句往往就是原因。 */
  private serverOutput = ""
  /** RTT socket 连上的时刻与目标是否已经吐过字节(见 RTT_WRITE_SETTLE_MS)。 */
  private rttConnectedAt = 0
  private rttHeard = false

  lines: LogLine[] = []
  /** 其他工具落下的分界线(见 LogMark),按 seq 递增。 */
  marks: LogMark[] = []
  /** 开口那一刻一次到齐的几行(见 OpenBurst);第一块数据只有零或一行时没有。 */
  openBurst?: OpenBurst
  /** 第一块设备数据已经到过(不管它有几行)。 */
  private firstChunkSeen = false
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
  /** RTT 源:本机 RTT telnet 口(start 之后才有)。 */
  rttPort?: number
  /** RTT 源:J-Link GDB server 的终态。server 退出与 RTT socket 关闭各自落,源状态按它说话。 */
  serverExit?: { code: number | null; signal: string | null; at: number }

  constructor(source: LogSource, label: string, file: string, cwd: string, options?: LogCaptureOptions) {
    if (source.kind === "child" && source.argv.length === 0) throw new Error("log start needs a command to run")
    this.source = source
    this.label = label
    this.file = file
    this.cwd = cwd
    this.env = { ...(options?.env ?? process.env) }
    this.jlink = options?.jlink
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
    return this.child?.pid ?? this.server?.child.pid
  }

  /** 是 stop() 收的场(而不是源自己退 / 断开)。源状态据此说 "stopped"。 */
  get stopRequested(): boolean {
    return this.stopping
  }

  /** 串口与 RTT 在采时能写;TCP / command 源只读。 */
  get writable(): boolean {
    return this.running && (!!this.serialOutput || this.source.kind === "rtt")
  }

  /**
   * 起源并等到它真的活了 —— 二进制不存在 / 端口不通这类错误要在 start 就报出来。
   * signal 只管起源这一段(RTT 要等 J-Link server 就绪,可能几秒):中止时起到一半的东西由这里收掉。
   */
  async start(signal?: AbortSignal): Promise<void> {
    this.startedAt = Date.now()
    const stream = createWriteStream(this.file, { flags: "a" })
    this.stream = stream
    // 落盘失败(磁盘满/权限)不该把会话打死:记一行进缓冲,继续采集。
    this.stream.on("error", (error) => {
      this.push(`log file write failed: ${String(error)}`, true)
      this.stream = undefined
    })
    try {
      if (this.source.kind === "tcp") await this.startTcp(this.source)
      else if (this.source.kind === "rtt") await this.startRtt(this.source, signal)
      else await this.startChild(this.source.argv)
    } catch (error) {
      // 起不来、一行都没写的采集不留一个空的 hw-*.log:界面的日志窗口按文件名挑最新的一份,空文件会把它
      // 刷成白板、把上一份真日志藏起来,而 RTT 起不来(器件名写错、板子没上电)是常事,每重试一次多一个。
      // 等 'close' 再删(finish 只 end 了,句柄还开着);删之前再看一眼大小,有内容的绝不动。
      if (this.totalLines === 0) {
        const drop = () =>
          void stat(this.file)
            .then((info) => (info.size === 0 ? rm(this.file, { force: true }) : undefined))
            .catch(() => {})
        if (stream.closed) drop()
        else stream.once("close", drop)
      }
      throw error
    }
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
      const settle = () => {
        socket.off("connect", onConnect)
        socket.off("error", onError)
        socket.off("close", onClose)
      }
      const onConnect = () => {
        settle()
        resolve()
      }
      const onError = (error: Error) => {
        settle()
        this.exited = { code: null, signal: null, at: Date.now() }
        this.finish()
        reject(
          new Error(
            `failed to connect log source ${source.host}:${source.port}: ${String(error)} — is the gdb server running and its RTT/telnet port open?`,
          ),
        )
      }
      // 连接途中被 stop()(界面的断开 / 会话关闭)destroy:只有 'close',没有 'error'。不听它的话这个 start
      // 永远挂着,而 log 工具的调用是排队的 —— 这个会话之后的每一次 log 调用都跟着卡死(审查实测)。
      const onClose = () => {
        settle()
        this.exited ??= { code: null, signal: null, at: Date.now() }
        this.finish()
        reject(new Error(`the connection to ${source.host}:${source.port} was closed before it was established`))
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
      socket.once("close", onClose)
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

  /**
   * RTT:起 J-Link GDB server(只管 RTT,不停核)→ 等它就绪 → 连它的 RTT telnet 口 → 剥掉开头的横幅,
   * 其余字节与 tcp 源走同一条 consume。任何一步失败 / 被中止 / 被 stop,server 都在这里收掉再抛,
   * 不指望调用方记得 —— 直接用 LogCapture 的人不一定会调 stop()。
   * 不占探针租约:J-Link 允许多会话并存,实测见 rtt.ts 文件头。
   */
  private async startRtt(source: { device: string; speed: number }, signal?: AbortSignal): Promise<void> {
    const cancelled = () => this.stopping || this.ended
    // 查与登记之间不许有 await:两个会话同时 start 时,不能两个都通过检查。
    const other = otherRttReader(this)
    if (other) {
      this.exited = { code: null, signal: null, at: Date.now() }
      this.finish()
      throw new Error(
        `another RTT capture in Yoma is already reading the J-Link: ${other.label} (project ${other.cwd}, full log: ${other.file}). ` +
          `Two RTT readers split the stream and each sees only part of the bytes — stop that capture first ` +
          `(Disconnect in that session's console, or \`log stop\` in that session), or read its log file.`,
      )
    }
    rttReaders.add(this)
    // 登记之后的每一步都得能把登记撤掉(finish 会删):漏掉一条抛错的路,内核里此后所有 RTT 启动都会被拒。
    let binary: string
    try {
      binary = await jlinkServerBinary(this.env, this.jlink)
    } catch (error) {
      this.exited = { code: null, signal: null, at: Date.now() }
      this.finish()
      throw error
    }
    // 哪儿都没找到时 jlinkServerBinary 给回裸名字:不必 spawn 一次来换一个 ENOENT。
    if (!path.isAbsolute(binary)) {
      this.exited = { code: null, signal: null, at: Date.now() }
      this.finish()
      throw new Error(rttServerMissing(binary))
    }
    let server: ServerProcess | undefined
    try {
      const ports = await pickRttPorts()
      if (cancelled()) throw new Error("the RTT capture was stopped before the J-Link GDB server started")
      if (signal?.aborted) throw new Error("log start was aborted before the J-Link GDB server started")
      const argv = jlinkRttArgv(binary, source.device, source.speed, ports)
      server = spawnServer(argv, ports.gdb, this.cwd, undefined, this.env)
      this.server = server
      this.rttPort = ports.rtt
      const started = server
      started.child.once("exit", (code, sig) => this.onServerGone({ code, signal: sig }))
      started.child.once("error", () => this.onServerGone({ code: null, signal: null }))

      await waitForRttServer(started, { device: source.device, signal, cancelled })
      const collect = (chunk: string) => {
        this.serverOutput = (this.serverOutput + chunk).slice(-2_000)
      }
      started.child.stdout?.on("data", collect)
      started.child.stderr?.on("data", collect)

      const socket = await connectRtt(ports.rtt, {
        signal,
        giveUp: () => {
          if (cancelled()) return "the RTT capture was stopped before its RTT connection opened"
          if (started.exited) {
            return `${describeServerExit(started.exited)} before its RTT port accepted a connection.\nIts last output:\n${lastOutput(started)}`
          }
          return undefined
        },
      })
      this.socket = socket
      this.rttConnectedAt = Date.now()
      socket.setEncoding("utf8")
      // shell 命令是一两个字节的小包:别让 Nagle 攒着。
      socket.setNoDelay(true)
      const banner = new RttBannerFilter()
      socket.on("data", (chunk: string) => {
        const text = banner.push(chunk)
        if (!text) return
        this.rttHeard = true
        this.consume(text, false)
      })
      // 连接后的错误等价于断开;'close' 必随其后。
      socket.on("error", () => {})
      socket.once("close", () => {
        // finish() 之后(server 先退、由 finish 销毁的 socket)不再往缓冲里塞东西:running=false 却还在长是老坑。
        if (this.ended) return
        const rest = banner.flush()
        if (rest) this.consume(rest, false)
        // server 还活着且不是我们在收:给它一点时间交出退出码(见 RTT_SERVER_EXIT_GRACE_MS),到点还活着就收掉。
        if (!this.stopping && !started.exited) {
          setTimeout(() => this.endRtt(), RTT_SERVER_EXIT_GRACE_MS).unref()
          return
        }
        this.endRtt()
      })
      socket.unref()
    } catch (error) {
      // 起不来:server 不能留下(它开着 J-Link 连接)。
      if (server && !server.exited) await stopServer(server, false).catch(() => (this.forced = true))
      this.exited ??= { code: server?.exited?.code ?? null, signal: server?.exited?.signal ?? null, at: Date.now() }
      this.finish()
      throw error
    }
  }

  /** server 退了。start 期间由等待循环自己报;采集中就是源结束。 */
  private onServerGone(exit: { code: number | null; signal: string | null }): void {
    // finish() 已经收场:之后到的退出是 finish 自己 killTree 出来的(对端关了 RTT、server 还活着那条路),
    // 不是 server 自己的话。记下来的话源状态会改口说 "exited (code 1)"(taskkill /F 的退出码,POSIX 上是
    // SIGTERM),与日志最后一行 "closed the RTT connection" 自相矛盾,模型据此以为 J-Link 崩了。
    if (this.ended) return
    this.serverExit ??= { ...exit, at: Date.now() }
    if (this.socket) this.endRtt()
  }

  /** RTT 采集收尾:不是 stop() 收的就在日志里写明为什么断了,模型读到的最后一行就是原因。 */
  private endRtt(): void {
    if (this.ended) return
    this.flushPending()
    if (!this.stopping) {
      const said = this.serverOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)
      const reason = this.serverExit
        ? describeServerExit(this.serverExit)
        : "the J-Link GDB server closed the RTT connection"
      // 行首的 "ERROR: " 是给界面的分级看的(log-lines 的 classifyLogLine 只认行首的级别词,`! ` 标记不算):
      // 这一行说的是 RTT 流为什么断了,它不上色、不进状态栏的错误计数,就淹在日志里。
      this.push(`ERROR: ${reason}${said ? ` — last server output: ${said}` : ""}`, true)
    }
    this.exited ??= { code: this.serverExit?.code ?? null, signal: this.serverExit?.signal ?? null, at: Date.now() }
    this.finish()
  }

  private consume(chunk: string, err: boolean): void {
    const pending = err ? this.pendingErr : this.pendingOut
    const split = splitChunk(pending, chunk)
    if (err) this.pendingErr = split.pending
    else this.pendingOut = split.pending
    const from = this.nextSeq
    for (const text of split.lines) this.push(text, err)
    // 只看设备流(串口、RTT、TCP)的第一块:command 源是模型自己起的程序,一次吐好几行是常态,不是缓存。
    const deviceStream = this.source.kind !== "child" || !!this.source.serial
    if (!err && deviceStream && !this.firstChunkSeen) this.noteFirstChunk(from, split.lines.length)
    if (split.lines.length > 0) this.notify()
  }

  private noteFirstChunk(from: number, lines: number): void {
    this.firstChunkSeen = true
    if (lines >= 2) this.openBurst = { from, to: from + lines - 1, t: this.lines.at(-1)?.t ?? 0 }
  }

  /**
   * 落一条分界线(别的工具要动目标时调)。在采才落,返回它的 seq —— 之后到的行才可能是那次动作之后的输出。
   * 走 push 的诊断行(`! ── … ──`):日志文件、界面尾巴、模型的节选里同一处都看得见它。
   */
  mark(text: string, boundary = true): LogMark | undefined {
    if (!this.running) return undefined
    const seq = this.nextSeq
    this.push(`── ${text} ──`, true)
    const mark = { seq, t: this.lines.at(-1)?.t ?? 0, text, boundary }
    this.marks.push(mark)
    this.notify()
    return mark
  }

  /** seq 之后落下的第一条分界线:一行比它早,就说明它来自那次烧录 / 复位之前。 */
  markAfter(seq: number): LogMark | undefined {
    return this.marks.find((mark) => mark.boundary && mark.seq > seq)
  }

  /** 最近一条分界线:给模型的"从这里起等"。 */
  get lastBoundary(): LogMark | undefined {
    return this.marks.findLast((mark) => mark.boundary)
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
    /** 从这个 seq 起找(而不是游标):烧录 / 复位报给模型的那条分界线,之前的旧行一概不算。 */
    since?: number
  }): Promise<WaitOutcome> {
    const re = compilePattern(options.pattern)
    const startCursor = options.since ?? this.cursor
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      // log 的调用是排队的,等待期间游标不会被别人推动:从起点一直找到底就行。
      const { lines } = this.linesSince(startCursor)
      // 分界线是我们自己写的字,不是目标说的话:等 "reset" 的模型不该等到一条 "gdb … reset" 的标记。
      const marked = new Set(this.marks.map((mark) => mark.seq))
      const hit = lines.find((line) => !marked.has(line.seq) && re.test(line.text))
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
        rows: this.previewRows(startCursor, PREVIEW_ROWS, charBudgetFor(PREVIEW_ROWS)),
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
    this.stopping = true
    this.serialOutput?.close()
    // TCP / RTT 源:destroy 触发 'close',终态与 finish 都在那个处理器里落。
    if (this.socket && !this.ended) {
      this.socket.destroy()
      await this.waitUntil(() => this.ended, EXIT_WAIT_MS)
    }
    // RTT 源自己起的 J-Link GDB server:等它真的退了再说"停了"(它开着一条 J-Link 连接)。
    // start 还没走完时也走这里 —— 那一边看到 stopping 会收手。
    const server = this.server
    if (server && !server.exited) {
      try {
        await stopServer(server, false)
      } catch {
        this.forced = true
      }
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
    this.server?.killNow()
    if (!this.child) return
    killTree(this.child, "SIGKILL")
  }

  /**
   * 往设备发字节:串口走 SerialOutput,RTT 写进 RTT telnet 口(J-Link 转给目标的 down channel 0)。
   * 成功只表示驱动 / J-Link 收下了,不表示固件读到了 —— 回应要在日志里等。
   */
  async write(data: Buffer): Promise<number> {
    if (this.source.kind === "rtt") {
      const socket = this.socket
      if (!this.running || !socket) throw new Error("The RTT capture is not running — start it again before sending")
      const settle = this.rttConnectedAt + RTT_WRITE_SETTLE_MS - Date.now()
      if (settle > 0 && !this.rttHeard) {
        await new Promise((resolve) => setTimeout(resolve, settle))
        if (!this.running || this.socket !== socket) {
          throw new Error("The RTT capture stopped before the bytes could be sent — nothing was written")
        }
      }
      return new Promise<number>((resolve, reject) => {
        socket.write(data, (error) => {
          if (error) reject(new Error(`RTT write failed: ${error.message}; not retried`))
          else resolve(data.length)
        })
      })
    }
    if (!this.running || !this.serialOutput) {
      throw new Error(
        "Only a serial port or an RTT capture can be written — start one before sending (TCP and command logs are read-only)",
      )
    }
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
    // RTT 采集结束 = 它起的 J-Link server 也该走(对端关了 RTT 连接、server 却还活着的那条路)。
    // stop() 已经等过它的退出;这里是同步兜底,不等。
    const server = this.server
    if (server && !server.exited) {
      killTree(server.child, "SIGTERM")
      setTimeout(() => server.killNow(), 3_000).unref()
    }
    this.stream?.end()
    this.stream = undefined
    liveCaptures.delete(this)
    rttReaders.delete(this)
    this.notify()
  }
}
