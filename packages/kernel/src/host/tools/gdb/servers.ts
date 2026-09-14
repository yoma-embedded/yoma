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
    rttHint: 'RTT: JLinkGDBServer already serves it — `log start tcp:"localhost:19021"`',
    readyRe: /Listening on TCP\/IP port \d+/,
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
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
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
        "-silent",
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

export function spawnServer(argv: string[], port: number, cwd: string, logFile?: string): ServerProcess {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  })
  const server: ServerProcess = {
    child,
    port,
    argv,
    tail: [],
    logFile,
    killNow: () => {
      if (!server.exited) killTree(child, "SIGKILL")
    },
  }
  liveServers.add(server)
  killOnHostExit(liveServers)
  const push = (chunk: string) => {
    if (logFile) {
      try {
        appendFileSync(logFile, chunk)
      } catch {
        // 日志目录没了不该拖垮会话;尾巴照样留在内存里。
      }
    }
    for (const line of chunk.split("\n")) {
      const t = line.trimEnd()
      if (!t) continue
      server.tail.push(t)
      if (server.tail.length > SERVER_TAIL_LINES) server.tail.shift()
    }
  }
  // OpenOCD / pyOCD 打 stderr,J-Link 打 stdout —— 两个都得收,只读 stdout 会在 OpenOCD 上永远等不到就绪串。
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", push)
  child.stderr?.on("data", push)
  child.once("exit", (code, signal) => {
    server.exited = { code, signal }
    liveServers.delete(server)
  })
  child.once("error", (error) => {
    server.exited = { code: null, signal: null }
    liveServers.delete(server)
    push(`[spawn] ${error.message}\n`)
  })
  child.unref()
  unrefStream(child.stdout)
  unrefStream(child.stderr)
  return server
}

/**
 * 就绪 = race(就绪正则, TCP 可连, server 退出),server 退出立刻获胜。
 *
 * 两条判据都要 —— 每个 server 各自的假阳/假阴写在 SERVER_CAPS 表里。这里只补一句表里放不下的:
 * 轮询的只有 **gdb 端口**,因为 OpenOCD 的 4444/6666 在适配器初始化之前就绑上了,拿它们判断会在目标根本
 * 没连上时误判成功。
 */
export async function waitForServerReady(
  server: ServerProcess,
  readyRe: RegExp | undefined,
  deadlineMs: number,
  signal?: AbortSignal,
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
    if (readyRe && !sawPattern && server.tail.some((l) => readyRe.test(l))) sawPattern = true
    if (await tcpProbe("127.0.0.1", server.port)) return { sawPattern }
    await new Promise((r) => {
      const t = setTimeout(r, TCP_POLL_MS)
      t.unref?.()
    })
  }
  throw new Error(
    appendProbeOccupationHint(
      `the gdb server did not open port ${server.port} within ${deadlineMs} ms.\n` +
        `Command: ${server.argv.join(" ")}\n` +
        `Its output so far:\n${server.tail.join("\n") || "(nothing)"}`,
      server.tail.join("\n"),
    ),
  )
}
