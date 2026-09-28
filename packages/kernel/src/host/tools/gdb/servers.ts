/**
 * gdb server 那一侧:三种能起的 server(OpenOCD / J-Link / QEMU)的 argv、就绪判据、能力表,以及
 * "attach 到一个已经在听的 server"要用的地址解析与端口分配。
 *
 * 能力表只放三样东西:argv 怎么拼、就绪怎么判、能力有哪些。能力不是装饰:QEMU 的观察点实测 Z2/Z3/Z4 返回
 * OK、命中后 100% CPU 永久空转 —— 不把这类事实写进表里,模型就会对着一个永远不会命中的观察点推理半小时。
 * rttHint 同理:RTT 从 server 自己的 TCP 口读(J-Link 的 19021 / OpenOCD 的 rtt server),不写进 attach
 * 报告模型就不知道日志从哪来。
 */

import { type ChildProcess, spawn } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import net from "node:net"
import path from "node:path"

import { appendProbeOccupationHint, exe, killOnHostExit, killTree, unrefStream } from "../../domain/engines.ts"
import { pathType } from "../../domain/toolchain/entries.ts"
import { readLedger } from "../../domain/toolchain/ledger.ts"
import { type LocationTable, wellKnownCandidates } from "../../domain/toolchain/locations.ts"
import type { GdbServerKind } from "./contract.ts"

/** server 输出留几行用于报错 —— 连接失败时 gdb 只会说 "Connection refused",信息全在 server 那边。 */
const SERVER_TAIL_LINES = 20
const TCP_POLL_MS = 100

export interface ServerCaps {
  /** 观察点:hw 表示可用,none 表示这个 server 根本不支持,要当场拒绝。 */
  watchpoints: "hw" | "none"
  resetHalt?: string
  resetRun?: string
  /** attach 报告里的一句话:这个 server 的 RTT 从哪拿。没有(qemu/external)就不提。 */
  rttHint?: string
  /** 就绪判据。没有的(qemu)只能靠 TCP 轮询。 */
  readyRe?: RegExp
}

export const SERVER_CAPS: Record<GdbServerKind, ServerCaps> = {
  // OpenOCD 的这条是唯一可信的就绪线:它在 target examine 成功之后才打印。
  // 4444/6666 在适配器初始化之前就绑上了,拿它们判断会在目标没连上时误判成功。
  openocd: {
    watchpoints: "hw",
    resetHalt: "monitor reset halt",
    resetRun: "monitor reset run",
    rttHint:
      'RTT: gdb eval (write: true) `monitor rtt setup <ctrl-block-addr> <size> "SEGGER RTT"`, `monitor rtt start`, `monitor rtt server start <port> 0`, then `log start tcp:"localhost:<port>"`',
    readyRe: /Listening on port \d+ for gdb connections/,
  },
  jlink: {
    watchpoints: "hw",
    resetHalt: "monitor reset",
    resetRun: "monitor go",
    // log 的 rtt 源自己起一个 J-Link server 读 RTT;两个 RTT 读者会把字节流劈成两半(2026-09-24 实测)。
    rttHint:
      'RTT: JLinkGDBServer already serves it — `log start tcp:"localhost:19021"`, unless a `log start rtt` capture is already running (two RTT readers split the stream)',
    // Listening 出现在连接目标之前;这一行才表示目标初始化已结束。
    readyRe: /Waiting for GDB connection/,
  },
  // QEMU 成功时 stdout/stderr 都是空的(实测),只能轮询端口。
  qemu: {
    // 实测:Z2/Z3/Z4 返回 OK,一旦命中 QEMU 100% CPU 永久空转。
    watchpoints: "none",
  },
  external: {
    watchpoints: "hw",
  },
}

/**
 * attach 报告里那句 RTT 提示。J-Link 的静态那句叫模型去连 19021;可这个内核里若已经有一个 `log start rtt` 在读
 * (多半在别的会话,模型在这边看不见它),再连 19021 就是第二个 RTT 读者,字节流被劈成两半、各拿一部分。
 * 那时改口指给它那份采集。rttReader 由调用方从 log 的采集器登记处取(这个文件不 import log,免得成环)。
 */
export function rttHintFor(kind: GdbServerKind, rttReader?: { label: string; file: string }): string | undefined {
  if (kind !== "jlink" || !rttReader) return SERVER_CAPS[kind].rttHint
  return (
    `RTT: already being read by a log capture (${rttReader.label}, full log: ${rttReader.file}) — use that capture ` +
    `(log wait / read in its session, or grep its log file); do NOT also \`log start tcp:"localhost:19021"\`: ` +
    `two RTT readers split the stream and each sees only part of the bytes`
  )
}

/**
 * 各 server 的可执行文件候选名,PATH 上按序找第一个;一个都没有就用第一个名字去 spawn,让 ENOENT 说话。
 * J-Link 的 GDB server 在 macOS / Linux 上有 GUI 版(`JLinkGDBServer`)与命令行版(`JLinkGDBServerCLExe`),
 * Windows 上是 `JLinkGDBServerCL.exe`;`-nogui` 对 GUI 版也有效,但命令行版才是无人值守的正解。
 */
const SERVER_BINARIES: Record<Exclude<GdbServerKind, "external">, readonly string[]> = {
  openocd: ["openocd"],
  jlink: ["JLinkGDBServerCLExe", "JLinkGDBServerCL", "JLinkGDBServer"],
  qemu: ["qemu-system-arm"],
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const binary = exe(name)
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path")
  for (const dir of ((pathKey && env[pathKey]) || "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, binary)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function serverBinary(kind: Exclude<GdbServerKind, "external">, env: NodeJS.ProcessEnv = process.env): string {
  const names = SERVER_BINARIES[kind]
  for (const name of names) {
    const found = findOnPath(name, env)
    if (found) return found
  }
  return names[0]!
}

/**
 * PATH 上没有 J-Link GDB server 时还去哪找。SEGGER 的 Windows 安装器**不往 PATH 里加自己**,而会话的 PATH 只前置
 * Yoma 装的与账本里 by:"user" 的目录(machinePathDirs)—— 设置页 / toolchain check 自动探到的 J-Link 记的是
 * by:"auto",不上 PATH。于是默认安装的新电脑上 `log start rtt` 与 `gdb server:"jlink"` 都说找不到,而工具链那一层
 * 明明知道它在哪(2026-09-25 审稿实测:resolveToolchain 报 jlink ok,serverBinary 给回裸名字)。
 * 只查账本与已知安装位置:都是读文件、不起进程 —— 注册表那一档要 spawn reg.exe,不放进每次 start 的路上;
 * 装在别处、只有注册表知道的,设置页 / toolchain check 探到一次就进了账本,下次这里就看得见。
 */
export interface JlinkLookup {
  /** 工具链账本所在目录(`<configDir>/toolchains.json`):记下的 jlink 不论 by 都算。不给就不读账本。 */
  configDir?: string
  /** 已知安装位置表;缺省是工具链的 WELL_KNOWN_LOCATIONS。测试注入临时目录 —— 别让开发机上真装着的 J-Link 被找到。 */
  locations?: LocationTable
}

/**
 * J-Link GDB server 的可执行文件:先 PATH(同 serverBinary),再账本里记下的 J-Link 目录,再 SEGGER 的缺省安装目录。
 * GDB server 与 JLink.exe 装在同一个目录里,所以账本记的是目录就看这个目录、记的是文件就看它所在的目录。
 * 不给 lookup 就只看 PATH;一个都没找到时同 serverBinary 给回裸名字。
 */
export async function jlinkServerBinary(env: NodeJS.ProcessEnv = process.env, lookup?: JlinkLookup): Promise<string> {
  const onPath = serverBinary("jlink", env)
  if (path.isAbsolute(onPath) || !lookup) return onPath
  const dirs: string[] = []
  if (lookup.configDir) {
    const recorded = (await readLedger(lookup.configDir)).entries.jlink?.bin ?? {}
    for (const value of Object.values(recorded)) {
      const type = pathType(value)
      if (type === "dir") dirs.push(value)
      else if (type === "file") dirs.push(path.dirname(value))
    }
  }
  // 展开结果按名字排过序:倒过来先试版本号大的那一份(JLink_V958 排在 JLink_V794 之前)。
  dirs.push(...wellKnownCandidates("jlink", process.platform, { table: lookup.locations }).reverse())
  const known = { PATH: dirs.join(path.delimiter) }
  for (const name of SERVER_BINARIES.jlink) {
    const found = findOnPath(name, known)
    if (found) return found
  }
  return onPath
}

export interface ServerArgvInput {
  server: GdbServerKind
  port: number
  chip?: string
  elfPath?: string
  config?: string[]
  machine?: string
}

/** 纯 argv 构造(argv[0] 是裸名字,spawn 前经 serverBinary 换成绝对路径)。external 不起进程。 */
export function buildServerArgv(input: ServerArgvInput): string[] {
  const { server, port } = input
  switch (server) {
    case "external":
      return []
    case "openocd": {
      const cfgs = input.config ?? []
      if (cfgs.length === 0) {
        throw new Error(
          'gdb start with server:"openocd" needs config, e.g. config:["interface/stlink.cfg","target/stm32g4x.cfg"]',
        )
      }
      const argv = ["openocd"]
      for (const c of cfgs) argv.push("-f", c)
      argv.push("-c", `gdb_port ${port}`)
      return argv
    }
    case "jlink": {
      if (!input.chip) throw new Error('gdb start with server:"jlink" needs chip, e.g. chip:"STM32G431CB"')
      return [
        "JLinkGDBServer",
        "-device",
        input.chip,
        "-if",
        "SWD",
        "-speed",
        "4000",
        "-port",
        String(port),
        "-nogui",
        "-nosilent",
        // DLL 的退出清理会摘掉 FPB 断点。Windows 强杀不能代替正常退出。
        "-singlerun",
      ]
    }
    case "qemu": {
      if (!input.machine) {
        throw new Error(
          'gdb start with server:"qemu" needs machine, e.g. machine:"netduinoplus2" (STM32F405, Cortex-M4F)',
        )
      }
      if (!input.elfPath) throw new Error('gdb start with server:"qemu" needs elfPath')
      return [
        "qemu-system-arm",
        "-machine",
        input.machine,
        "-kernel",
        input.elfPath,
        "-semihosting-config",
        "enable=on,target=native",
        "-nographic",
        "-serial",
        "none",
        "-monitor",
        "none",
        "-S",
        "-gdb",
        `tcp::${port}`,
      ]
    }
  }
}

/**
 * "host:port" / ":port" / "port" 都收。冒号跟着 host 走:阁楼那版把冒号写成可选,
 * 于是 "9090" 被贪婪匹配成 host "909" + port 0(log 工具的 parseTcpTarget 同一个坑)。
 */
export function parseConnect(value: string): { host: string; port: number } {
  const m = /^(?:([A-Za-z0-9_.-]+)?:)?(\d{1,5})$/.exec(value.trim())
  const port = m ? Number(m[2]) : 0
  if (!m || port < 1 || port > 65535) {
    throw new Error(`gdb start: could not parse connect "${value}" — use "host:port", e.g. "localhost:3333"`)
  }
  return { host: m[1] || "localhost", port }
}

/** 让内核挑一个空闲端口。默认端口撞车是必然的(OpenOCD 3333 / J-Link 2331 / QEMU 1234)。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))))
    })
  })
}

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1_000, () => done(false))
  })
}

export interface ServerProcess {
  child: ChildProcess
  port: number
  argv: string[]
  /** 最近若干行合并输出 —— 连接失败时全部有用信息都在这里。 */
  tail: string[]
  /** 保留跨 chunk 的原始尾部,用于就绪判据。 */
  outputTail: string
  /** 全量输出落在这里(QEMU 上固件的 semihosting 打印只有这一条路)。 */
  logFile?: string
  exited?: { code: number | null; signal: NodeJS.Signals | null }
  killNow(): void
}

/**
 * 在飞的 server(跨所有工具实例):宿主退出要带走它们。只挂 gdb 不挂 server 的话,宿主一退 gdb 死了、
 * openocd / JLinkGDBServer 还活着攥着探针(审稿实测:SIGTERM 宿主之后 qemu 被 launchd 接管继续跑)。
 */
const liveServers = new Set<ServerProcess>()

export function spawnServer(
  argv: string[],
  port: number,
  cwd: string,
  logFile?: string,
  env?: NodeJS.ProcessEnv,
): ServerProcess {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  })
  const server: ServerProcess = {
    child,
    port,
    argv,
    tail: [],
    outputTail: "",
    logFile,
    killNow: () => {
      if (!server.exited) killTree(child, "SIGKILL")
    },
  }
  liveServers.add(server)
  killOnHostExit(liveServers)
  /**
   * 没等到换行的半行,按流分开攒(stdout / stderr 各一份)。管道按任意字节边界切 chunk:逐 chunk 切行的话
   * 报错里贴出来的是 "Target endian: l" / "ittle" 这种碎片(2026-09-24 J-Link 器件名写错时实测)。
   */
  const partial = { stdout: "", stderr: "" }
  const pushLine = (line: string) => {
    const t = line.trimEnd()
    if (!t) return
    server.tail.push(t)
    if (server.tail.length > SERVER_TAIL_LINES) server.tail.shift()
  }
  const push = (stream: "stdout" | "stderr", chunk: string) => {
    server.outputTail = (server.outputTail + chunk).slice(-8192)
    if (logFile) {
      try {
        appendFileSync(logFile, chunk)
      } catch {
        // 日志目录没了不该拖垮会话;尾巴照样留在内存里。
      }
    }
    const lines = (partial[stream] + chunk).split("\n")
    partial[stream] = lines.pop() ?? ""
    // 一直不换行的输出(进度条之类)别让半行无限长:超过一屏就当一行收下。
    if (partial[stream].length > 4096) {
      lines.push(partial[stream])
      partial[stream] = ""
    }
    for (const line of lines) pushLine(line)
  }
  /** 流结束时最后那半行也算一行 —— 退出前的最后一句往往没有换行,而它正是原因。 */
  const flush = (stream: "stdout" | "stderr") => {
    pushLine(partial[stream])
    partial[stream] = ""
  }
  // OpenOCD / pyOCD 打 stderr,J-Link 打 stdout —— 两个都得收,只读 stdout 会在 OpenOCD 上永远等不到就绪串。
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => push("stdout", chunk))
  child.stderr?.on("data", (chunk: string) => push("stderr", chunk))
  child.stdout?.once("end", () => flush("stdout"))
  child.stderr?.once("end", () => flush("stderr"))
  child.once("exit", (code, signal) => {
    server.exited = { code, signal }
    liveServers.delete(server)
  })
  child.once("error", (error) => {
    server.exited = { code: null, signal: null }
    liveServers.delete(server)
    push("stderr", `[spawn] ${error.message}\n`)
  })
  child.unref()
  unrefStream(child.stdout)
  unrefStream(child.stderr)
  return server
}

/**
 * 常规后端等 TCP 可连;J-Link single-run 只等目标初始化后的输出,不能用一次假连接探测它。
 *
 * 轮询的只有 **gdb 端口**,因为 OpenOCD 的 4444/6666 在适配器初始化之前就绑上了,拿它们判断会在目标根本
 * 没连上时误判成功。
 */
export async function waitForServerReady(
  server: ServerProcess,
  readyRe: RegExp | undefined,
  deadlineMs: number,
  signal?: AbortSignal,
  outputOnly = false,
): Promise<{ sawPattern: boolean }> {
  const started = Date.now()
  let sawPattern = false
  while (Date.now() - started < deadlineMs) {
    if (signal?.aborted) throw new Error("gdb start was aborted while waiting for the server")
    if (server.exited) {
      const { code, signal: sig } = server.exited
      throw new Error(
        appendProbeOccupationHint(
          `the gdb server exited before it was ready (${sig ? `signal ${sig}` : `code ${code}`}).\n` +
            `Command: ${server.argv.join(" ")}\n` +
            `Its last output:\n${server.tail.join("\n") || "(nothing)"}`,
          server.tail.join("\n"),
        ),
      )
    }
    if (readyRe && !sawPattern && readyRe.test(server.outputTail)) sawPattern = true
    // single-run 的一次 TCP 探测就是一次客户端连接:断开会让服务器退出。
    if (outputOnly ? sawPattern : await tcpProbe("127.0.0.1", server.port)) return { sawPattern }
    await new Promise((r) => {
      const t = setTimeout(r, TCP_POLL_MS)
      t.unref?.()
    })
  }
  throw new Error(
    appendProbeOccupationHint(
      `the gdb server did not ${outputOnly ? "finish target initialization" : `open port ${server.port}`} within ${deadlineMs} ms.\n` +
        `Command: ${server.argv.join(" ")}\n` +
        `Its output so far:\n${server.tail.join("\n") || "(nothing)"}`,
      server.tail.join("\n"),
    ),
  )
}

function waitForServerExit(server: ServerProcess, ms: number): Promise<boolean> {
  if (server.exited) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      server.child.off("exit", done)
      resolve(Boolean(server.exited))
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    server.child.once("exit", done)
  })
}

/** 关闭完成才交还探针。J-Link single-run 在 GDB 断开后自己清理;其余后端先收 SIGTERM。 */
export async function stopServer(server: ServerProcess, waitForNaturalExit: boolean): Promise<{ forced: boolean }> {
  if (waitForNaturalExit && (await waitForServerExit(server, 3000))) return { forced: false }
  if (!server.exited) killTree(server.child, "SIGTERM")
  if (await waitForServerExit(server, 3000)) return { forced: true }
  server.killNow()
  if (!(await waitForServerExit(server, 3000))) {
    throw new Error(`gdb server pid ${server.child.pid} did not exit; the debug probe has not been released`)
  }
  return { forced: true }
}
