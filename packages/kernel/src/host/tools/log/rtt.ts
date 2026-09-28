/**
 * log 的 RTT 源:工具自己起一个**只管 RTT** 的 J-Link GDB server,再从它的 RTT telnet 口读字节。
 *
 * 【为什么不是让模型先 gdb start 再 log start tcp】
 * 那条路要求 gdb 会话一直开着,而 gdb 起的 J-Link server 是 -singlerun、会停核,断点一停 RTT 就哑了;
 * 用户只想"看日志"时,为此开一个调试会话代价太大。这里的 server 带 -nohalt:连上目标不停核、不复位、
 * 不烧录,从不接 GDB 客户端,纯粹当一根 RTT 管子用。
 *
 * 【为什么用 JLinkGDBServerCL 而不是 JLink.exe(Commander)】(2026-09-24 实测,J-Link V9.58 + V11 + STM32G473RC)
 * - GDB server 的就绪行不缓冲:管道上 ~110 ms 内就给出 "Connecting to target..." / "Connected to target" /
 *   "Waiting for GDB connection...";器件名写错时 ~240 ms 内打印 "Failed to get index for device name 'X'" 并退出。
 * - Commander 的 stdout 接管道时整段缓冲到退出才吐;器件名写错时挂了 67 秒才退 —— 没法拿它判就绪。
 *
 * 【为什么不占探针租约】(同一天实测)
 * J-Link 允许多个会话同时连一个探针:另开一个 GDB server、或用 JLink.exe 停核 / 复位,这条 RTT 流都不断;
 * 固件重启后 boot 日志照样从同一个 socket 来。烧录 / gdb 走它们自己的会话,不必等这条 RTT 停下。
 * 唯一的冲突是**两个 RTT 读者**:同时读(另一个 server 的 RTT 口也被人连着)会把字节流劈成两半,
 * 各拿一部分。同一个内核里的第二个 `log start rtt`(哪怕在别的会话)由 capture.ts 的 rttReaders 当场拒掉,
 * gdb 的 attach 报告也据此改口(servers.ts 的 rttHintFor);别的进程拦不住,写进了工具描述,由模型避免。
 * 另:经 J-Link 停核 600 ms 没有触发 35 ms 的 IWDG(J-Link 停核时冻结了它),所以别的会话停核不会让板子复位。
 *
 * 进程纪律同 gdb 的 server(spawnServer:detached / windowsHide / unref / 宿主退出时收尸);
 * 起不来、被中止、socket 连不上,都由 LogCapture 负责把 server 收掉,不留孤儿。
 */

import net from "node:net"
import path from "node:path"

import { pickFreePort, type ServerProcess } from "../gdb/servers.ts"

/** 就绪上限:正常 ~110 ms;慢的是 J-Link 固件更新提示、USB 枚举这类一次性开销。 */
export const RTT_READY_MS = 15_000
/** "Waiting for GDB connection" 之后 RTT telnet 口一般已经在听;留一点余量给慢机器。 */
export const RTT_CONNECT_MS = 2_000
const POLL_MS = 50
const RTT_READY_RE = /Waiting for GDB connection/

export interface RttPorts {
  gdb: number
  swo: number
  telnet: number
  rtt: number
}

/** 四个互不相同的空闲本机端口。J-Link 缺省的 2331/2332/2333/19021 会和 gdb 工具起的那个 server 撞车。 */
export async function pickRttPorts(): Promise<RttPorts> {
  const ports = new Set<number>()
  // pickFreePort 放掉端口再返回,连着要四个可能拿到同一个:去重,给有限次机会。
  for (let attempt = 0; ports.size < 4 && attempt < 20; attempt++) ports.add(await pickFreePort())
  if (ports.size < 4) throw new Error("could not allocate four free local ports for the J-Link GDB server")
  const [gdb, swo, telnet, rtt] = [...ports] as [number, number, number, number]
  return { gdb, swo, telnet, rtt }
}

/**
 * 只管 RTT 的 J-Link GDB server 命令行(argv[0] 是可执行文件)。参数顺序照实测那一条:`-localhostonly`
 * 与 `-nohalt` 都是开关,`-nohalt` 让连接目标时不停核(实测没有警告,目标一直在跑)。
 */
export function jlinkRttArgv(binary: string, device: string, speed: number, ports: RttPorts): string[] {
  return [
    binary,
    "-device",
    device,
    "-if",
    "SWD",
    "-speed",
    String(speed),
    "-port",
    String(ports.gdb),
    "-swoport",
    String(ports.swo),
    "-telnetport",
    String(ports.telnet),
    "-RTTTelnetPort",
    String(ports.rtt),
    "-nogui",
    "-noir",
    "-localhostonly",
    "-nohalt",
  ]
}

export function rttLabel(device: string, speed: number): string {
  return `rtt ${device} via J-Link SWD ${speed} kHz`
}

/**
 * 这台机器上找不到 J-Link GDB server 时的话:说清查过哪儿,指出下一步动作,而不是一个 ENOENT。
 * 第一步不是"问用户":PATH、账本、SEGGER 的缺省安装目录都查过了还没有,多半是装在别处 —— 那时 `toolchain check`
 * 往往已经知道(注册表那一档),模型自己记下就行;界面上的人走设置页。真没装才是装包。
 */
export function rttServerMissing(binary: string): string {
  const name = process.platform === "win32" ? "JLinkGDBServerCL.exe" : "JLinkGDBServerCLExe / JLinkGDBServer"
  const where = path.isAbsolute(binary)
    ? ` at ${binary}`
    : ": not on PATH, not beside a J-Link recorded in the toolchain ledger, not in SEGGER's default install folders"
  return (
    `J-Link GDB server not found (${name}${where}). ` +
    `If J-Link is installed somewhere else, record its folder and start again — the agent: run \`toolchain check\` ` +
    `(it may already list jlink with its folder), then \`toolchain set id=jlink path=<J-Link folder>\`; in the app: ` +
    `Settings → Toolchain. If it is not installed, install SEGGER's "J-Link Software and Documentation Pack".`
  )
}

/**
 * server 输出里认得出的失败行 → 给模型的话。认不出返回 undefined(交给退出码 / 超时那两句)。
 * 器件名那条排在最前:器件名错时 J-Link 也会接着打 "Could not connect to target",按后者说就会让人去查线。
 */
export function describeRttFailure(output: string, device: string): string | undefined {
  const unknown = /Failed to get index for device name '([^']*)'/.exec(output)
  if (unknown) {
    return (
      `J-Link does not know the device name "${unknown[1] || device}". Pass the name J-Link uses — for STM32 the part number ` +
      `without the package/temperature suffix (e.g. "STM32G473RC", not "STM32G473RCT6" or a CubeMX family such as ` +
      `"STM32G473R(B-C-E)Tx"). J-Link Commander's \`ExpDevList\` or SEGGER's supported-device list has the exact spelling.`
    )
  }
  if (/Connecting to J-Link failed|Cannot connect to J-Link|No J-Link found/i.test(output)) {
    return "the J-Link GDB server found no J-Link probe — is it plugged in over USB, and not held exclusively by another program (e.g. an Ozone or J-Flash session with exclusive access)?"
  }
  if (/Could not connect to target/i.test(output)) {
    return (
      `J-Link reached the probe but could not connect to the target over SWD. Check that the board is powered, ` +
      `SWDIO / SWCLK / GND are wired to the J-Link and nothing holds the core in reset; on long or flying wires ` +
      `try a lower rttSpeed (e.g. 1000).`
    )
  }
  return undefined
}

export function lastOutput(server: ServerProcess, lines = 8): string {
  return server.tail.slice(-lines).join("\n") || "(nothing)"
}

function describeExit(exit: { code: number | null; signal: string | null }): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`
}

export function describeServerExit(exit: { code: number | null; signal: string | null }): string {
  return `J-Link GDB server exited (${describeExit(exit)})`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface RttWaitOptions {
  device: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 采集器已经在收场(stop / dispose):别再等了。 */
  cancelled: () => boolean
}

/** 等 server 说出就绪行;失败行、提前退出、中止、超时各有一句能指出下一步的话。 */
export async function waitForRttServer(server: ServerProcess, options: RttWaitOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RTT_READY_MS
  const started = Date.now()
  while (true) {
    if (options.cancelled()) throw new Error("the RTT capture was stopped before the J-Link GDB server was ready")
    if (options.signal?.aborted) throw new Error("log start was aborted while the J-Link GDB server was starting")
    const output = server.outputTail
    const failure = describeRttFailure(output, options.device)
    if (failure) throw new Error(`${failure}\nJ-Link GDB server said:\n${lastOutput(server)}`)
    if (RTT_READY_RE.test(output)) return
    if (server.exited) {
      if (/ENOENT/.test(output)) throw new Error(rttServerMissing(server.argv[0] ?? ""))
      throw new Error(
        `the J-Link GDB server exited before it was ready (${describeExit(server.exited)}).\n` +
          `Command: ${server.argv.join(" ")}\nIts last output:\n${lastOutput(server)}`,
      )
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `the J-Link GDB server did not report ready ("Waiting for GDB connection") within ${timeoutMs} ms.\n` +
          `Command: ${server.argv.join(" ")}\nIts output so far:\n${lastOutput(server)}`,
      )
    }
    await sleep(POLL_MS)
  }
}

/**
 * 连 RTT telnet 口;server 刚就绪时口可能还差几十毫秒,拒绝就重试到期限。
 * `giveUp` 返回一句话就停手并抛它(采集器在收场、server 已经退了):等满期限只会换来一句不相干的 ECONNREFUSED。
 */
export async function connectRtt(
  port: number,
  options: { timeoutMs?: number; signal?: AbortSignal; giveUp: () => string | undefined },
): Promise<net.Socket> {
  const deadline = Date.now() + (options.timeoutMs ?? RTT_CONNECT_MS)
  let lastError = ""
  while (true) {
    const reason = options.giveUp()
    if (reason) throw new Error(reason)
    if (options.signal?.aborted) throw new Error("log start was aborted while connecting to the RTT port")
    const attempt = await new Promise<net.Socket | Error>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port })
      const onConnect = () => {
        socket.off("error", onError)
        resolve(socket)
      }
      const onError = (error: Error) => {
        socket.off("connect", onConnect)
        socket.destroy()
        resolve(error)
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
    })
    if (!(attempt instanceof Error)) {
      // 连上的这一刻恰好被 stop / 中止:别把一个没人收的 socket 交出去。
      if (options.giveUp() || options.signal?.aborted) {
        attempt.destroy()
        continue
      }
      return attempt
    }
    lastError = attempt.message
    if (Date.now() >= deadline) {
      throw new Error(
        `the J-Link GDB server is up but its RTT port 127.0.0.1:${port} did not accept a connection (${lastError})`,
      )
    }
    await sleep(100)
  }
}

/**
 * RTT telnet 口一连上,J-Link 先发三行自报家门,然后才是目标的字节:
 *   SEGGER J-Link V9.58 - Real time terminal output
 *   SEGGER J-Link V11.0, SN=941000024
 *   Process: JLinkGDBServerCL.exe
 * 只在**流的最开头**剥,而且逐行核对形状:第一行不像就整段放行(老版本可能不发),之后的行一律不碰。
 * 三行可能被切在任意 chunk 边界上,所以没见到换行之前、只要还可能是横幅的前缀就先攒着。
 */
const BANNER: readonly RegExp[] = [/^SEGGER J-Link\b.*Real time terminal/i, /^SEGGER J-Link\b/i, /^Process:\s/i]
const BANNER_PREFIX: readonly string[] = ["SEGGER J-Link", "SEGGER J-Link", "Process:"]
/** 一行横幅不会比这长;攒到这么长还没换行就不是横幅。 */
const MAX_BANNER_LINE = 256

export class RttBannerFilter {
  private index = 0
  private pending = ""
  private done = false

  /** 喂一段收到的文本,返回该交给采集器的部分(可能是空串)。 */
  push(chunk: string): string {
    if (this.done) return chunk
    this.pending += chunk
    while (!this.done) {
      const nl = this.pending.indexOf("\n")
      if (nl < 0) {
        const prefix = BANNER_PREFIX[this.index]!
        const partial = this.pending.replace(/^\r/, "")
        const couldBeBanner =
          partial.length <= MAX_BANNER_LINE &&
          (prefix.toLowerCase().startsWith(partial.toLowerCase()) ||
            partial.toLowerCase().startsWith(prefix.toLowerCase()))
        if (couldBeBanner) return ""
        return this.release()
      }
      const line = this.pending.slice(0, nl).replace(/\r$/, "")
      if (!BANNER[this.index]!.test(line)) return this.release()
      this.pending = this.pending.slice(nl + 1)
      this.index++
      if (this.index >= BANNER.length) return this.release()
    }
    return ""
  }

  /** 流结束时:攒着没放出去的残余照样交出去(只剩半行横幅也算,宁可多一行也不丢字节)。 */
  flush(): string {
    return this.release()
  }

  private release(): string {
    this.done = true
    const out = this.pending
    this.pending = ""
    return out
  }
}
