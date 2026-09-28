/**
 * log 工具的 J-Link RTT 源(host/tools/log/rtt.ts + capture.ts 的 rtt 分支)与界面实时尾巴(LogTool.tail)。
 *
 * 不碰真硬件:假的 JLinkGDBServerCL 是一段 JS(fixtures/fake-exe.ts 包成可直接启动的可执行文件),照 2026-09-24
 * 在 J-Link V9.58 + STM32G473RC 上实测的样子说话 —— 就绪三行、按 -RTTTelnetPort 听、连上先发三行横幅
 * (故意切在两次 write 之间)、再发 "[4] E: ..." 格式的日志;收到的每一行回 "echo: <行>"。模式由环境变量选:
 * ok / slow(迟迟不就绪)/ bad-device / no-target / dies(采集中途退出)/ hangup(关掉 RTT 连接、server 不退)。
 *
 * **PATH 只留假货所在的目录**:开发机的 PATH 上可能真有 J-Link(而且板子插着),找到真的就是一次真连接。
 * Windows 的 process.env 里键是 "Path" —— 只加一个 "PATH" 的话 findOnPath 先认到的是旧的那个,所以先删掉
 * 所有大小写变体再设。
 *
 * "server 被收掉了"一律用完成标记断言(CLAUDE.md 的 la 第 9 条):假货活过 MARKER_MS 就写一个文件,
 * 断言窗口比 MARKER_MS 长,于是"杀掉了"和"还没到点"分得开;另有一条对照用例证明假货活着时标记真的会出现。
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { bindExecutionEnv } from "../src/host/domain/execution-env.ts"
import { jlinkDeviceName, type LogDetails, type LogInput, logSummary } from "../src/host/tools/log/contract.ts"
import { RttBannerFilter } from "../src/host/tools/log/rtt.ts"
import { createLogTool, type LogTool } from "../src/host/tools/log/session.ts"
import { writeFakeExe } from "./fixtures/fake-exe.ts"
import { patient } from "./patience.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const openTools: LogTool[] = []

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-rtt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const tool of openTools.splice(0)) await tool.dispose()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-rtt",
  operationId: "op-rtt",
  turnId: "turn-rtt",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

const BANNER =
  "SEGGER J-Link V9.58 - Real time terminal output\r\nSEGGER J-Link V11.0, SN=941000024\r\nProcess: JLinkGDBServerCL.exe\r\n"
const FAULT_LINE = "[4] E: [SAFETY] undervoltage: vbus=801mV (limit=248000mV)"

/** 假的 J-Link GDB server。只认 log 工具会传的那几个参数。 */
const FAKE_JLINK = String.raw`
import net from "node:net"
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.findIndex((a) => a.toLowerCase() === name.toLowerCase())
  return i >= 0 ? args[i + 1] : undefined
}
const env = process.env
const mode = env.FAKE_JLINK_MODE || "ok"
if (env.FAKE_JLINK_ARGV) writeFileSync(env.FAKE_JLINK_ARGV, JSON.stringify(args))
if (env.FAKE_JLINK_STARTED) writeFileSync(env.FAKE_JLINK_STARTED, String(process.pid))
const markerMs = Number(env.FAKE_JLINK_MARKER_MS || 0)
if (env.FAKE_JLINK_MARKER && markerMs > 0) setTimeout(() => writeFileSync(env.FAKE_JLINK_MARKER, "alive"), markerMs)
const device = arg("-device") || "Unspecified"

console.log("SEGGER J-Link GDB Server V9.58 Command Line Version")
console.log("")
if (mode === "bad-device-split") {
  // 管道把一行切在两次 write 之间(真 J-Link 实测会这样):报错里贴出来的得是一整行。
  process.stdout.write("Target endian:                 l")
  setTimeout(() => {
    process.stdout.write("ittle\nConnecting to J-Link...\n")
    console.log("Failed to get index for device name '" + device + "'.GDBServer will be closed...")
    process.stdout.write("Shutting down...")
    process.exitCode = 3
  }, 60)
} else if (mode === "bad-device") {
  console.log("Failed to get index for device name '" + device + "'.GDBServer will be closed...")
  console.log("Could not connect to target. Please check power, connection and settings.")
  process.exitCode = 3
} else if (mode === "no-target") {
  console.log("Connecting to J-Link...")
  console.log("J-Link is connected.")
  console.log("Connecting to target...")
  console.log("ERROR: Could not connect to target.")
  console.log("Target connection failed. GDBServer will be closed...")
  process.exitCode = 2
} else {
  console.log("Connecting to J-Link...")
  console.log("J-Link is connected.")
  console.log("Connecting to target...")
  const ready = () => {
    console.log("Connected to target")
    console.log("Waiting for GDB connection...")
    // RTT 口比就绪行晚一点点开:逼采集器走一次连接重试。
    setTimeout(() => {
      const server = net.createServer((socket) => {
        const connectedAt = Date.now()
        socket.on("error", () => {})
        socket.write(${JSON.stringify(BANNER.slice(0, 70))})
        setTimeout(() => {
          socket.write(${JSON.stringify(BANNER.slice(70))})
          // quiet:目标一句话都不说(控制块找到之前写的字节会被真 J-Link 丢掉,见 capture.ts 的 RTT_WRITE_SETTLE_MS)。
          if (mode !== "quiet") socket.write(${JSON.stringify(FAULT_LINE + "\r\n")} + "[5] I: boot done\r\n")
          // dies:日志发完之后才报错、退出 —— 按**连接**计时,不按进程起来的时刻计时。按进程计时的话采集器
          // 连上得晚一点(CI 上慢 4–8 倍)假货就先退了,FAULT_LINE 根本没发出去,用例测的就成了墙钟赛跑。
          if (mode === "dies") {
            setTimeout(() => {
              console.log("ERROR: Communication timed out: Requested 4 bytes, received 0 bytes !")
              setTimeout(() => process.exit(7), 150)
            }, 100)
          }
          // hangup:J-Link 关掉 RTT 连接,server 自己却一直活着(被我们收掉为止)。
          if (mode === "hangup") setTimeout(() => socket.destroy(), 100)
        }, 40)
        let pending = ""
        let heard = false
        socket.setEncoding("utf8")
        socket.on("data", (chunk) => {
          if (!heard && env.FAKE_JLINK_RX_DELAY) writeFileSync(env.FAKE_JLINK_RX_DELAY, String(Date.now() - connectedAt))
          heard = true
          pending += chunk
          let nl
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl).replace(/\r$/, "")
            pending = pending.slice(nl + 1)
            socket.write("echo: " + line + "\r\n")
          }
        })
      })
      server.listen(Number(arg("-RTTTelnetPort")), "127.0.0.1")
    }, 150)
  }
  if (mode === "slow") setTimeout(ready, 30000)
  else ready()
  // 保险丝:用例出错也不留一个一直活着的假货。
  setTimeout(() => process.exit(0), 60000)
}
`

interface Fake {
  dir: string
  argvFile: string
  startedFile: string
  markerFile: string
  /** 假货第一次收到字节时写:距 RTT 连接建立过了多少毫秒。 */
  rxDelayFile: string
}

/**
 * 起一个只认假货的工具:PATH 只有假货所在的目录,其余环境原样。`offPath`:假货装进一个"SEGGER 缺省安装目录"
 * (注入的位置表指着它),PATH 上什么都没有 —— 验证 PATH 之外的那条找法。
 */
function makeRttTool(mode = "ok", markerMs = 0, options: { withFake?: boolean; offPath?: boolean } = {}) {
  const cwd = createTempDir()
  const install = options.offPath ? join(createTempDir(), "SEGGER") : undefined
  const dir = install ? join(install, "JLink_V999") : createTempDir()
  const fake: Fake = {
    dir,
    argvFile: join(dir, "argv.json"),
    startedFile: join(dir, "started.pid"),
    markerFile: join(dir, "still-alive.marker"),
    rxDelayFile: join(dir, "rx-delay.txt"),
  }
  if (options.withFake !== false) writeFakeExe(dir, "JLinkGDBServerCL", FAKE_JLINK)
  const variables: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(variables)) if (key.toLowerCase() === "path") delete variables[key]
  variables.PATH = install ? createTempDir() : dir
  variables.FAKE_JLINK_MODE = mode
  variables.FAKE_JLINK_ARGV = fake.argvFile
  variables.FAKE_JLINK_STARTED = fake.startedFile
  variables.FAKE_JLINK_MARKER = fake.markerFile
  variables.FAKE_JLINK_RX_DELAY = fake.rxDelayFile
  variables.FAKE_JLINK_MARKER_MS = String(markerMs)
  const toolContext = { env: bindExecutionEnv(new NodeExecutionEnv({ cwd, shellEnv: variables }), variables) }
  // 位置表一律注入(不在 PATH 上的那种指向假货的安装目录,其余是空表):缺省表会认到开发机上真装着的 J-Link。
  const locations = { jlink: install ? { [process.platform]: [join(install, "JLink*")] } : {} }
  const tool = createLogTool({ jlink: { configDir: createTempDir(), locations } })
  openTools.push(tool)
  const run = (params: LogInput, context: Context = BACKGROUND_CONTEXT): Promise<AgentToolResult<LogDetails>> =>
    tool.execute("c1", params, () => {}, toolContext, invocation, context)
  return { tool, run, cwd, fake }
}

function textOf(result: AgentToolResult<LogDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + patient(timeoutMs)
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for condition")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 信号 0 只查存在不杀(Windows 上 libuv 同样支持)。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("jlinkDeviceName", () => {
  it.each([
    ["STM32G473RCTx", "STM32G473RC"],
    ["STM32G473RCT6", "STM32G473RC"],
    ["STM32F103C8T6", "STM32F103C8"],
    ["STM32L4R5ZIT6", "STM32L4R5ZI"],
    ["STM32WB55RGV6", "STM32WB55RG"],
    ["STM32H743ZIT6", "STM32H743ZI"],
    ["STM32G0B1RET6", "STM32G0B1RE"],
    ["STM32F103RCT6TR", "STM32F103RC"],
    ["  stm32g473rctx  ", "STM32G473RC"],
    ["STM32G473RC", "STM32G473RC"],
    ["STM32F103C8", "STM32F103C8"],
    ["STM32L4R5ZI", "STM32L4R5ZI"],
    ["nRF52840_xxAA", "nRF52840_xxAA"],
    ["ATSAMD21G18", "ATSAMD21G18"],
    ["STM32H745ZI_M7", "STM32H745ZI_M7"],
    // 产品线是"字母 + 数字"、容量码是数字的系列(H7R/H7S):从前被切在产品线里,J-Link 名字本身也被切短。
    ["STM32H7S7L8", "STM32H7S7L8"],
    ["STM32H7S7L8H6H", "STM32H7S7L8"],
    ["STM32H7R3Z8T6", "STM32H7R3Z8"],
    ["STM32H7S3L8H6", "STM32H7S3L8"],
    ["STM32WLE5JCI6", "STM32WLE5JC"],
    ["STM32WBA52CGU6", "STM32WBA52CG"],
    ["STM32WB5MMGH6", "STM32WB5MMG"],
    ["STM32N657X0H3Q", "STM32N657X0"],
    ["STM32U5A9NJH6Q", "STM32U5A9NJ"],
    ["STM32G031K8T6", "STM32G031K8"],
    ["STM32C011F6P6", "STM32C011F6"],
  ])("%s → %s", (input, expected) => {
    expect(jlinkDeviceName(input)).toBe(expected)
  })

  it("CubeMX 的家族名说不出是哪一颗:拒掉并要确切型号", () => {
    expect(() => jlinkDeviceName("STM32G473R(B-C-E)Tx")).toThrow(/CubeMX family name.*exact part/)
    expect(() => jlinkDeviceName("   ")).toThrow(/needs the J-Link device name/)
  })

  it("卡片副标题:start rtt <device>", () => {
    expect(logSummary({ action: "start", rtt: " STM32G473RCTx " })).toBe("start rtt STM32G473RCTx")
  })
})

describe("RttBannerFilter", () => {
  const body = `${FAULT_LINE}\r\n[5] I: boot done\r\n`

  it("横幅切在任意位置都只剥开头那三行", () => {
    const stream = BANNER + body
    for (let cut = 0; cut <= stream.length; cut++) {
      const filter = new RttBannerFilter()
      const out = filter.push(stream.slice(0, cut)) + filter.push(stream.slice(cut)) + filter.flush()
      expect(out, `cut at ${cut}`).toBe(body)
    }
  })

  it("逐字节喂也一样", () => {
    const filter = new RttBannerFilter()
    let out = ""
    for (const ch of BANNER + body) out += filter.push(ch)
    expect(out + filter.flush()).toBe(body)
  })

  it("没有横幅就原样放行;横幅之后再出现的同样字样不剥", () => {
    const plain = new RttBannerFilter()
    expect(plain.push("[0] I: hello\n") + plain.flush()).toBe("[0] I: hello\n")
    const later = new RttBannerFilter()
    const tail = "SEGGER J-Link V9.58 - Real time terminal output\r\nProcess: x\r\n"
    expect(later.push(BANNER + body + tail) + later.flush()).toBe(body + tail)
  })

  it("第一行像横幅、第二行不像:从第二行起全放行", () => {
    const filter = new RttBannerFilter()
    expect(filter.push("SEGGER J-Link V9.58 - Real time terminal output\r\n[1] I: x\n") + filter.flush()).toBe(
      "[1] I: x\n",
    )
  })
})

// ─── 工具:RTT 源 ─────────────────────────────────────────────────────────────

describe("log start rtt(假 J-Link GDB server)", () => {
  it("起 server、剥横幅、读行、写 down channel、状态与收场;不停核的参数一个不少", async () => {
    const { tool, run, fake } = makeRttTool("ok", 300)
    const started = await run({ action: "start", rtt: "STM32G473RCTx", rttSpeed: 1000 })
    const startText = textOf(started)
    expect(startText).toContain("Capturing rtt STM32G473RC via J-Link SWD 1000 kHz")
    expect(startText).toContain("not halted or reset")
    expect(started.details!.running).toBe(true)
    expect(started.details!.writable).toBe(true)
    expect(started.details!.source).toBe("rtt STM32G473RC via J-Link SWD 1000 kHz")
    expect(started.details!.rtt).toMatchObject({ device: "STM32G473RC", speed: 1000 })

    // 参数:器件名归一过、SWD、四个互不相同的端口、-nohalt;RTT 口就是 details 里报的那个。
    const argv = JSON.parse(readFileSync(fake.argvFile, "utf8")) as string[]
    const value = (flag: string) => argv[argv.indexOf(flag) + 1]
    expect(value("-device")).toBe("STM32G473RC")
    expect(value("-if")).toBe("SWD")
    expect(value("-speed")).toBe("1000")
    expect(argv).toEqual(expect.arrayContaining(["-nohalt", "-nogui", "-noir", "-localhostonly"]))
    expect(argv).not.toContain("-singlerun")
    const ports = ["-port", "-swoport", "-telnetport", "-RTTTelnetPort"].map((flag) => Number(value(flag)))
    expect(new Set(ports).size).toBe(4)
    expect(Number(value("-RTTTelnetPort"))).toBe(started.details!.rtt!.port)

    const waited = await run({ action: "wait", pattern: "undervoltage", timeoutMs: patient(5000) })
    expect(waited.details!.matched).toBe(true)
    const read = await run({ action: "read", since: 0 })
    const readText = textOf(read)
    expect(readText).toContain(FAULT_LINE)
    expect(readText).toContain("[5] I: boot done")
    expect(readText).not.toContain("SEGGER")
    expect(readText).not.toContain("Process:")

    // 手动控件走的两条快路(executeInstrument 的 status / write)在 RTT 上同样成立。
    expect(tool.snapshot()).toMatchObject({ running: true, writable: true, rtt: { device: "STM32G473RC" } })
    const sent = await tool.sendSerial({ action: "write", data: "help", lineEnding: "lf" })
    expect(sent.details!.bytesSent).toBe(5)
    expect(textOf(sent)).toContain("rtt STM32G473RC")
    const hexSent = await run({ action: "write", data: "73 74 61 74 75 73 0a", encoding: "hex" })
    expect(hexSent.details!.bytesSent).toBe(7)
    const echoed = await run({ action: "wait", pattern: "echo: status", timeoutMs: patient(5000) })
    expect(echoed.details!.matched).toBe(true)
    expect(textOf(await run({ action: "read", since: 0 }))).toContain("echo: help")

    // 对照:假货活着时完成标记真的会出现 —— 下面"收掉了"那条用例的"没出现"才有意义。
    await waitFor(() => existsSync(fake.markerFile))

    const status = await run({ action: "status" })
    expect(textOf(status)).toContain("source: running")
    const stopped = await run({ action: "stop" })
    expect(textOf(stopped)).toContain("stopped rtt STM32G473RC")
    expect(textOf(stopped)).not.toContain("did not confirm exit")
    expect(stopped.details!.running).toBe(false)
    expect(stopped.details!.writable).toBe(false)
    expect(textOf(await run({ action: "status" }))).toContain("source: stopped")
    await expect(run({ action: "write", data: "x" })).rejects.toThrow(/RTT capture is not running/)
    // 自己收的场不是意外:日志里没有"server 退了"这一行。
    expect(readFileSync(started.details!.file!, "utf8")).not.toContain("J-Link GDB server exited")
  }, 30_000)

  it("stop 收掉 server:假货活不到写完成标记的那一刻", async () => {
    const markerMs = 1500
    const { run, fake } = makeRttTool("ok", markerMs)
    const t0 = Date.now()
    await run({ action: "start", rtt: "STM32G473RC" })
    expect(existsSync(fake.startedFile)).toBe(true)
    await run({ action: "stop" })
    // 窗口必须比假货自己写标记的时刻长,否则"杀掉了"和"还没到点"长得一样。
    await sleep(Math.max(0, t0 + markerMs + 1200 - Date.now()))
    expect(existsSync(fake.markerFile)).toBe(false)
  }, 20_000)

  it("会话关闭(dispose)同样收掉 server", async () => {
    const markerMs = 1500
    const { tool, run, fake } = makeRttTool("ok", markerMs)
    const t0 = Date.now()
    await run({ action: "start", rtt: "STM32G473RC" })
    await tool.dispose()
    await sleep(Math.max(0, t0 + markerMs + 1200 - Date.now()))
    expect(existsSync(fake.markerFile)).toBe(false)
  }, 20_000)

  it("起到一半被中止(停止按钮):start 报中止,server 不留下", async () => {
    const markerMs = 1500
    const { tool, run, fake } = makeRttTool("slow", markerMs)
    const controller = new AbortController()
    const t0 = Date.now()
    const starting = run(
      { action: "start", rtt: "STM32G473RC" },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    const outcome = starting.then(
      () => "started",
      (error: Error) => error.message,
    )
    await waitFor(() => existsSync(fake.startedFile))
    controller.abort()
    expect(await outcome).toMatch(/aborted/)
    expect(tool.snapshot().running).toBe(false)
    await sleep(Math.max(0, t0 + markerMs + 1200 - Date.now()))
    expect(existsSync(fake.markerFile)).toBe(false)
  }, 20_000)

  it("起到一半被界面断开(stopCapture):start 报被停,server 不留下", async () => {
    const markerMs = 1500
    const { tool, run, fake } = makeRttTool("slow", markerMs)
    const t0 = Date.now()
    const outcome = run({ action: "start", rtt: "STM32G473RC" }).then(
      () => "started",
      (error: Error) => error.message,
    )
    await waitFor(() => existsSync(fake.startedFile))
    await tool.stopCapture()
    expect(await outcome).toMatch(/stopped/)
    expect(tool.snapshot().source).toBeUndefined()
    await sleep(Math.max(0, t0 + markerMs + 1200 - Date.now()))
    expect(existsSync(fake.markerFile)).toBe(false)
  }, 20_000)

  it("器件名 J-Link 不认:报 J-Link 要的写法,并带上 server 自己的话", async () => {
    const { tool, run } = makeRttTool("bad-device")
    const error = await run({ action: "start", rtt: "STM32F999XX" }).then(
      () => undefined,
      (e: Error) => e.message,
    )
    expect(error).toContain('J-Link does not know the device name "STM32F999XX"')
    expect(error).toContain("STM32G473RC")
    expect(error).toContain("Failed to get index for device name 'STM32F999XX'")
    expect(error).not.toMatch(/check that the board is powered/)
    expect(tool.snapshot().running).toBe(false)
  }, 20_000)

  it("起不来的 start 不留下空的 hw-*.log(界面按文件名挑最新一份,空文件会把日志窗口刷成白板)", async () => {
    const logFiles = (cwd: string) => {
      const dir = join(cwd, ".yoma", "logs")
      return existsSync(dir) ? readdirSync(dir).filter((name) => /^hw-.*\.log$/.test(name)) : []
    }
    for (const [mode, withFake] of [
      ["bad-device", true],
      ["ok", false],
    ] as const) {
      const { run, cwd } = makeRttTool(mode, 0, { withFake })
      await expect(run({ action: "start", rtt: "STM32F999XX" })).rejects.toThrow()
      // 先让文件真的建出来(createWriteStream 的 open 是异步的),否则"没有文件"可能只是还没建。
      await sleep(200)
      await waitFor(() => logFiles(cwd).length === 0)
    }
  }, 20_000)

  it("连不上目标:让人查供电与 SWD 接线", async () => {
    const { run } = makeRttTool("no-target")
    await expect(run({ action: "start", rtt: "STM32G473RC" })).rejects.toThrow(
      /could not connect to the target over SWD[\s\S]*powered/,
    )
  }, 20_000)

  it("CubeMX 家族名在起 server 之前就拒", async () => {
    const { run, fake } = makeRttTool("ok")
    await expect(run({ action: "start", rtt: "STM32G473R(B-C-E)Tx" })).rejects.toThrow(/log start: .*CubeMX family/)
    expect(existsSync(fake.startedFile)).toBe(false)
  })

  it("找不到 J-Link GDB server:说查过哪儿、先 toolchain check 再 toolchain set,真没装才装包,而不是一句 ENOENT", async () => {
    const { run } = makeRttTool("ok", 0, { withFake: false })
    const error = await run({ action: "start", rtt: "STM32G473RC" }).then(
      () => "",
      (e: Error) => e.message,
    )
    expect(error).toMatch(/J-Link GDB server not found .*not on PATH.*toolchain ledger.*default install folders/)
    expect(error).toMatch(/toolchain check[\s\S]*toolchain set id=jlink path=[\s\S]*Settings → Toolchain/)
    expect(error).toContain("J-Link Software and Documentation Pack")
    // 第一步不再是"问用户":工具链那一层多半已经知道它在哪。
    expect(error).not.toMatch(/ask the user/)
  })

  it("J-Link 装在 SEGGER 的缺省目录、不在 PATH 上(Windows 安装器不加 PATH):照样找得到、起得来", async () => {
    const { run, fake } = makeRttTool("ok", 0, { offPath: true })
    const started = await run({ action: "start", rtt: "STM32G473RC" })
    expect(textOf(started)).toContain("Capturing rtt STM32G473RC")
    expect(existsSync(fake.startedFile)).toBe(true)
    expect((await run({ action: "wait", pattern: "undervoltage", timeoutMs: patient(5000) })).details!.matched).toBe(
      true,
    )
  }, 20_000)

  it("同一个内核里第二个 RTT 读者(别的会话)当场拒掉并说出第一个是谁;第一个照常跑,停了之后第二个才起得来", async () => {
    const first = makeRttTool("ok")
    const second = makeRttTool("ok")
    await first.run({ action: "start", rtt: "STM32G473RC" })
    const refused = await second.run({ action: "start", rtt: "STM32G473RC" }).then(
      () => "",
      (e: Error) => e.message,
    )
    expect(refused).toMatch(/another RTT capture in Yoma is already reading the J-Link: rtt STM32G473RC via J-Link SWD/)
    expect(refused).toContain(first.cwd)
    expect(refused).toMatch(/split the stream/)
    // 没起第二个 server,第一个也没被打扰。
    expect(existsSync(second.fake.startedFile)).toBe(false)
    expect(first.tool.snapshot().running).toBe(true)
    expect(
      (await first.run({ action: "wait", pattern: "undervoltage", timeoutMs: patient(5000) })).details!.matched,
    ).toBe(true)
    await first.run({ action: "stop" })
    expect(textOf(await second.run({ action: "start", rtt: "STM32G473RC" }))).toContain("Capturing rtt STM32G473RC")
  }, 30_000)

  it("采集中 server 自己退了:采集结束,源状态与日志说清是 server 退出(带退出码与它最后一句话)", async () => {
    const { run } = makeRttTool("dies")
    await run({ action: "start", rtt: "STM32G473RC" })
    let status = ""
    const deadline = Date.now() + patient(8000)
    while (Date.now() < deadline) {
      const result = await run({ action: "status" })
      status = textOf(result)
      if (!result.details!.running) break
      await sleep(50)
    }
    expect(status).toContain("source: J-Link GDB server exited (code 7)")
    const read = textOf(await run({ action: "read", since: 0 }))
    expect(read).toContain(FAULT_LINE)
    expect(read).toMatch(
      /! ERROR: J-Link GDB server exited \(code 7\) — last server output: ERROR: Communication timed out/,
    )
    const waited = await run({ action: "wait", pattern: "never-printed", timeoutMs: 2000 })
    expect(textOf(waited)).toContain("source J-Link GDB server exited (code 7) before")
    expect(waited.details!.writable).toBe(false)
  }, 20_000)

  it("J-Link 关掉 RTT 连接而 server 还活着:收掉 server 之后源状态仍说 disconnected,不把我们杀出来的退出码当成 server 自己退了", async () => {
    const { tool, run } = makeRttTool("hangup")
    const started = await run({ action: "start", rtt: "STM32G473RC" })
    const serverPid = Number(/\(pid (\d+)\)/.exec(textOf(started))?.[1])
    expect(serverPid).toBeGreaterThan(0)
    // socket 关 → 宽限 RTT_SERVER_EXIT_GRACE_MS → endRtt → finish 收掉 server。
    await waitFor(() => !tool.snapshot().running, 8000)
    // 等 server 真的被收掉:它的退出事件正是从前被记成 "J-Link GDB server exited (code 1)" 的那一下。
    await waitFor(() => !processAlive(serverPid), 8000)
    await sleep(300)
    const status = textOf(await run({ action: "status" }))
    expect(status).toContain("source: disconnected (the J-Link GDB server closed the RTT connection)")
    expect(status).not.toMatch(/exited \(/)
    const read = textOf(await run({ action: "read", since: 0 }))
    expect(read).toContain(FAULT_LINE)
    expect(read).toContain("! ERROR: the J-Link GDB server closed the RTT connection")
    const waited = textOf(await run({ action: "wait", pattern: "never-printed", timeoutMs: 500 }))
    expect(waited).toContain("source disconnected (the J-Link GDB server closed the RTT connection) before")
  }, 30_000)

  it("刚连上就写:等到 J-Link 能收(目标还一句没说时补足 RTT_WRITE_SETTLE_MS),字节不会被丢", async () => {
    // 真 J-Link 实测:连上后 0 ms 写的 "status" 三次丢两次,50 ms 起才稳。start 一返回模型就可能立刻 write。
    const { run, fake } = makeRttTool("quiet")
    await run({ action: "start", rtt: "STM32G473RC" })
    const sent = await run({ action: "write", data: "status", lineEnding: "lf" })
    expect(sent.details!.bytesSent).toBe(7)
    await waitFor(() => existsSync(fake.rxDelayFile))
    expect(Number(readFileSync(fake.rxDelayFile, "utf8"))).toBeGreaterThanOrEqual(250)
    expect((await run({ action: "wait", pattern: "echo: status", timeoutMs: patient(5000) })).details!.matched).toBe(
      true,
    )
  }, 20_000)

  it("server 的输出被管道切在行中间:报错里贴出来的仍是整行", async () => {
    const { run } = makeRttTool("bad-device-split")
    const error = await run({ action: "start", rtt: "STM32F999XX" }).then(
      () => "",
      (e: Error) => e.message,
    )
    expect(error).toContain('J-Link does not know the device name "STM32F999XX"')
    expect(error).toMatch(/^Target endian: +little$/m)
    expect(error).not.toMatch(/^ittle$/m)
  }, 20_000)
})

// ─── 界面的断开(stopCapture)──────────────────────────────────────────────────

describe("LogTool.stopCapture", () => {
  it("排在队列里、断开之前发出的 start 一律作废:不能在界面说 Disconnected 之后自己连上", async () => {
    const cwd = createTempDir()
    const scripts = createTempDir()
    const holder = join(scripts, "holder.mjs")
    writeFileSync(holder, `console.log("BOOT ready"); setInterval(() => {}, 1000)`)
    const late = join(scripts, "late.mjs")
    const lateRan = join(scripts, "late-ran.txt")
    writeFileSync(
      late,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(lateRan)}, "ran"); setInterval(() => {}, 1000)`,
    )
    const tool = createLogTool()
    openTools.push(tool)
    const context = { env: new NodeExecutionEnv({ cwd }) }
    const run = (params: LogInput) => tool.execute("c1", params, () => {}, context, invocation, BACKGROUND_CONTEXT)
    await run({ action: "start", command: `"${process.execPath}" "${holder}"` })
    // 一条长 wait 占着工具的队列(真实里是 agent 的 wait / ports,或者 agent 自己那次还在起的 start)。
    const waiting = run({ action: "wait", pattern: "never", timeoutMs: 30_000 })
    const queued = run({ action: "start", command: `"${process.execPath}" "${late}"` }).then(
      (result) => textOf(result),
      (e: Error) => e.message,
    )
    await sleep(50)
    await tool.stopCapture()
    await waiting
    expect(await queued).toMatch(/stopped before it finished starting/)
    expect(tool.snapshot().running).toBe(false)
    await sleep(500)
    expect(existsSync(lateRan)).toBe(false)
    // 断开之后发出的 start 照常。
    expect(textOf(await run({ action: "start", command: `"${process.execPath}" "${holder}"` }))).toContain("Capturing")
  }, 20_000)
})

// ─── 界面的实时尾巴 ───────────────────────────────────────────────────────────

describe("LogTool.tail", () => {
  it("没有采集器:空视图", () => {
    const tool = createLogTool()
    openTools.push(tool)
    expect(tool.tail()).toEqual({ running: false, writable: false, nextSeq: 0, lost: 0, lines: [] })
  })

  it("行与日志文件逐行相同;since / 上限 / lost 都对;不消费 agent 的游标", async () => {
    const cwd = createTempDir()
    const script = join(createTempDir(), "burst.mjs")
    // 6000 行:环形缓冲留 5000,再按 2000 行上限截。最后一行是 stderr,尾巴里要带 "! "。
    writeFileSync(
      script,
      `let out = ""; for (let i = 0; i < 5999; i++) out += "line " + i + "\\n"; process.stdout.write(out, () => { console.error("fault at end"); setTimeout(() => {}, 30000) })`,
    )
    const tool = createLogTool()
    openTools.push(tool)
    const context = { env: new NodeExecutionEnv({ cwd }) }
    const run = (params: LogInput) => tool.execute("c1", params, () => {}, context, invocation, BACKGROUND_CONTEXT)
    const started = await run({ action: "start", command: `"${process.execPath}" "${script}"` })
    const file = started.details!.file!
    await waitFor(() => tool.tail().nextSeq >= 6000, 10_000)
    await waitFor(() => readFileSync(file, "utf8").split("\n").filter(Boolean).length >= 6000, 10_000)

    const all = tool.tail()
    expect(all.running).toBe(true)
    expect(all.writable).toBe(false)
    expect(all.source).toBe(started.details!.source)
    expect(all.file).toBe(file)
    expect(all.nextSeq).toBe(6000)
    expect(all.lines).toHaveLength(2000)
    // 不给 since:区间从缓冲里最老的一行起(seq 1000),截掉的 3000 行记进 lost。
    expect(all.lost).toBe(3000)
    const fileLines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    expect(all.lines).toEqual(fileLines.slice(-2000))
    expect(all.lines.at(-1)).toMatch(/^\[\+\d+\.\d{3}\] ! fault at end$/)
    expect(all.lines.at(-2)).toMatch(/^\[\+\d+\.\d{3}\] line 5998$/)

    // since = 0:前 1000 行掉出了环形缓冲,再加上截掉的 3000。
    expect(tool.tail(0).lost).toBe(4000)
    const recent = tool.tail(5990)
    expect(recent.lines).toEqual(fileLines.slice(5990))
    expect(recent.lost).toBe(0)
    expect(tool.tail(all.nextSeq)).toMatchObject({ lines: [], lost: 0, nextSeq: 6000 })

    // 只读:agent 的游标还在 0,read 照样从头给(掉出缓冲的那 1000 行照常提示去翻文件)。
    const read = textOf(await run({ action: "read" }))
    expect(read).toContain("+5000 new lines since seq 0")
    expect(read).toContain("1000 older lines already fell out of the buffer")
  }, 30_000)

  it("RTT 采集:尾巴里是剥过横幅的行,writable 为 true", async () => {
    const { tool, run } = makeRttTool("ok")
    await run({ action: "start", rtt: "STM32G473RC" })
    await waitFor(() => tool.tail().lines.length >= 2)
    const view = tool.tail()
    expect(view).toMatchObject({ running: true, writable: true, lost: 0 })
    expect(view.source).toBe("rtt STM32G473RC via J-Link SWD 4000 kHz")
    expect(view.lines[0]).toMatch(new RegExp(`^\\[\\+\\d+\\.\\d{3}\\] ${FAULT_LINE.replace(/[[\]().]/g, "\\$&")}$`))
    expect(view.lines.join("\n")).not.toContain("SEGGER")
    // 尾巴不推游标:agent 的 read 仍然拿得到这两行。
    expect(textOf(await run({ action: "read" }))).toContain(FAULT_LINE)
  }, 20_000)
})
