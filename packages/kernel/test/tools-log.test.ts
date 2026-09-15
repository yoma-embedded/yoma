/**
 * log 工具(host/tools/log/)的验收:节选纯函数、采集器、TCP 源、六个动作。移植自 attic/test/log.test.ts,
 * 按新内核的六参 execute 重接,并补上新内核才有的两条:中止信号打断 wait、会话关闭时 dispose 收采集器。
 *
 * 假日志源是一段 JS,命令行写成 `"<node>" "<script.mjs>"`(splitArgv 认引号),三平台同构 —— 不造 .cmd
 * 启动器(Node≥20.12 无 shell 的 spawn 拒 .cmd)。串口那条路在 tools-log-serial.test.ts。
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { LogCapture } from "../src/host/tools/log/capture.ts"
import type { LogDetails, LogInput } from "../src/host/tools/log/contract.ts"
import {
  clipText,
  foldLines,
  type LogLine,
  renderRows,
  selectForDisplay,
  splitArgv,
  splitChunk,
} from "../src/host/tools/log/excerpt.ts"
import { createLogTool, type LogTool, parseTcpTarget } from "../src/host/tools/log/session.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const openCaptures: LogCapture[] = []
const openTools: LogTool[] = []

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-log-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

/** 假日志源:一段 JS 落成 .mjs,命令行是 `"<node>" "<脚本>"`。 */
function writeSource(js: string, name = "source"): string {
  const script = join(createTempDir(), `${name}.mjs`)
  writeFileSync(script, js)
  return `"${process.execPath}" "${script}"`
}

afterEach(async () => {
  for (const tool of openTools.splice(0)) await tool.dispose()
  for (const capture of openCaptures.splice(0)) await capture.stop()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

type Update = (partial: AgentToolResult<LogDetails>) => void

function makeTool() {
  const cwd = createTempDir()
  const tool = createLogTool()
  openTools.push(tool)
  const run = (
    params: LogInput,
    context: Context = BACKGROUND_CONTEXT,
    onUpdate: Update = () => {},
  ): Promise<AgentToolResult<LogDetails>> =>
    tool.execute("c1", params, onUpdate, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { tool, run, cwd }
}

function textOf(result: AgentToolResult<LogDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/** status 不动游标,所以可以拿它做"行到齐了没"的轮询同步。 */
async function waitForLines(run: ReturnType<typeof makeTool>["run"], count: number, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await run({ action: "status" })
    if (status.details!.totalLines >= count) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${count} lines`)
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for condition")
}

async function listenLocal(onSocket: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    // stop() closes the client while this fake source may still be writing.
    // Windows reports that expected disconnect as ECONNRESET on the server side.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error
    })
    onSocket(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  return { server, port }
}

function line(seq: number, text: string, t = seq * 10): LogLine {
  return { seq, t, text }
}

/** 互不相同、又不含数字的行 —— 数字会被折叠规则合并,那不是这些用例要测的。 */
function distinct(i: number): string {
  return `evt ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + (i % 7))}`
}

// 假源:立刻两行启动信息,0.2s 后一条 HardFault,然后退出。
const BOOT_THEN_FAULT = `
console.log("[boot] STM32F407VG @ 168 MHz");
console.log("[boot] HAL init ok");
setTimeout(() => console.log("[halt] HardFault - SIGTRAP (imu.c:192)"), 200);
`

const THREE_LINES_THEN_WAIT = `
console.log("line one");
console.log("line two");
console.log("line three");
setTimeout(() => {}, 5000);
`

const ALIVE_FOREVER = `
console.log("alive");
setTimeout(() => {}, 30000);
`

/** 40 行互不相同、不含数字的输出。 */
const FORTY_DISTINCT = `
for (const w of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]) {
  for (const x of ["one", "two", "three", "four"]) console.log(w + " " + x);
}
setTimeout(() => {}, 5000);
`

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("splitChunk", () => {
  it("切出完整行,没换行的尾巴留作 pending", () => {
    const first = splitChunk("", "boot ok\nloop 1\nlo")
    expect(first.lines).toEqual(["boot ok", "loop 1"])
    expect(first.pending).toBe("lo")
    const second = splitChunk(first.pending, "op 2\n")
    expect(second.lines).toEqual(["loop 2"])
    expect(second.pending).toBe("")
  })

  it("CRLF 与孤立 CR 都算换行", () => {
    expect(splitChunk("", "a\r\nb\rc\n").lines).toEqual(["a", "b", "c"])
  })

  it("剥掉 ANSI 转义与控制字符,tab 留下", () => {
    expect(splitChunk("", "\x1b[31mred\x1b[0m\ttab\x07\n").lines).toEqual(["red\ttab"])
  })

  it("一直不换行的流强制断行,pending 不会无限长", () => {
    const { lines, pending } = splitChunk("", "x".repeat(10), 4)
    expect(lines).toEqual(["xxxx", "xxxx"])
    expect(pending).toBe("xx")
  })
})

describe("splitArgv", () => {
  it('按空白切,引号里的空格不切,双引号里认 \\" 与 \\\\', () => {
    expect(splitArgv("cat /dev/ttyUSB0")).toEqual(["cat", "/dev/ttyUSB0"])
    expect(splitArgv(`python3 "my decoder.py" --port '/dev/tty USB0'`)).toEqual([
      "python3",
      "my decoder.py",
      "--port",
      "/dev/tty USB0",
    ])
    expect(splitArgv(`say "a \\"quoted\\" word"`)).toEqual(["say", 'a "quoted" word'])
    expect(splitArgv(`x ""`)).toEqual(["x", ""])
  })

  it("引号没配对就抛", () => {
    expect(() => splitArgv(`cat "unterminated`)).toThrow(/unbalanced/)
  })
})

describe("foldLines", () => {
  it("连续相同的行折成一组,记末行时间", () => {
    const rows = foldLines([line(0, "tick"), line(1, "tick"), line(2, "tick"), line(3, "boom")])
    expect(rows.map((row) => [row.line.text, row.count, row.lastT])).toEqual([
      ["tick", 3, 20],
      ["boom", 1, 30],
    ])
    expect(rows[0]!.lastText).toBeUndefined()
  })

  it("只有数字不同的行也折,并留住末行文本", () => {
    const rows = foldLines([line(0, "imu ax=128 ay=3"), line(1, "imu ax=131 ay=4"), line(2, "imu ax=140 ay=2")])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(3)
    expect(rows[0]!.lastText).toBe("imu ax=140 ay=2")
  })

  it("不同的行不折;stdout 与 stderr 不互折", () => {
    expect(foldLines([line(0, "a"), line(1, "b"), line(2, "a")])).toHaveLength(3)
    expect(foldLines([line(0, "same"), { ...line(1, "same"), err: true }])).toHaveLength(2)
  })
})

describe("selectForDisplay", () => {
  it("预算够就全给,没有省略", () => {
    const rows = foldLines([line(0, "a"), line(1, "b"), line(2, "c")])
    const picked = selectForDisplay(rows, 10)
    expect(picked.rows.map((row) => row.type)).toEqual(["line", "line", "line"])
    expect(picked.omittedLines).toBe(0)
  })

  it("超预算时留头、留中间要紧的行、留尾,中间插省略标记", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 100; i++) lines.push(line(i, i === 50 ? "HardFault at 0x08001234" : distinct(i)))
    const picked = selectForDisplay(foldLines(lines), 12)
    const texts = picked.rows.map((row) => (row.type === "gap" ? `gap:${row.count}` : row.row.line.text))
    expect(texts[0]).toBe(distinct(0))
    expect(texts).toContain("HardFault at 0x08001234")
    expect(texts[texts.length - 1]).toBe(distinct(99))
    expect(texts.filter((text) => text.startsWith("gap:")).length).toBeGreaterThan(0)
    expect(picked.omittedLines + picked.rows.filter((row) => row.type === "line").length).toBe(100)
  })

  it("省略计数按原始行数,不按折叠后的组数", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 30; i++) lines.push(line(i, "tick"))
    for (let i = 30; i < 60; i++) lines.push(line(i, distinct(i)))
    const picked = selectForDisplay(foldLines(lines), 5)
    expect(
      picked.omittedLines +
        picked.rows
          .filter((row) => row.type === "line")
          .reduce((n, row) => n + (row.type === "line" ? row.row.count : 0), 0),
    ).toBe(60)
  })

  it("字符预算与行数预算一起卡:一条 4 KB 的行冲不垮节选", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 20; i++) lines.push(line(i, "y".repeat(4000)))
    const picked = selectForDisplay(
      foldLines(lines.map((l, i) => ({ ...l, text: `${distinct(i)} ${l.text}` }))),
      20,
      1200,
    )
    expect(renderRows(picked.rows).length).toBeLessThan(1600)
    expect(picked.rows.filter((row) => row.type === "line").length).toBeLessThanOrEqual(3)
  })

  it("行很长时最新一行照样在、尾部的故障行照样在,节选永不为空(头部只能花 1/3 字符预算)", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 30; i++) lines.push(line(i, `${distinct(i)} ${"z".repeat(480)}`))
    lines[29] = line(29, `HardFault at 0x08001234 ${"z".repeat(470)}`)
    const rows = foldLines(lines)
    const kept = (maxLines: number, maxChars: number) =>
      selectForDisplay(rows, maxLines, maxChars)
        .rows.filter((row) => row.type === "line")
        .map((row) => (row.type === "line" ? row.row.line.seq : -1))
    // 预览预算(PREVIEW_ROWS 12 → 1920 字符):上一版只剩 seq 0-3,最新一行与故障行都丢了。
    expect(kept(12, 1920)).toContain(29)
    expect(kept(12, 1920).length).toBeGreaterThan(2)
    expect(kept(12, 1920).filter((seq) => seq < 5).length).toBeLessThanOrEqual(2)
    // 预算小到一行都装不下:最新一行仍然无条件保留。
    expect(kept(2, 400)).toEqual([29])
    expect(kept(1, 24_000)).toEqual([29])
  })

  it("最新一行自己就是一句 error 时,不占故障行的名额:中间的 HardFault 照样进预览", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 60; i++) lines.push(line(i, `state ${distinct(i)} ok`))
    lines[30] = line(30, "HardFault at 0x08001234 (imu.c:192)")
    lines[59] = line(59, "usb: error resetting endpoint")
    const picked = selectForDisplay(foldLines(lines), 12, 1920)
    const texts = picked.rows.map((row) => (row.type === "line" ? row.row.line.text : "gap"))
    expect(texts).toContain("HardFault at 0x08001234 (imu.c:192)")
    expect(texts[texts.length - 1]).toBe("usb: error resetting endpoint")
  })

  it("预算小到只有两三行时全给尾巴", () => {
    const lines: LogLine[] = []
    for (let i = 0; i < 20; i++) lines.push(line(i, distinct(i)))
    const picked = selectForDisplay(foldLines(lines), 2)
    const texts = picked.rows
      .filter((row) => row.type === "line")
      .map((row) => (row.type === "line" ? row.row.line.text : ""))
    expect(texts).toEqual([distinct(18), distinct(19)])
  })
})

describe("renderRows / clipText", () => {
  it("时间戳、折叠计数、省略与命中标记", () => {
    const rows = foldLines([line(0, "boot", 5), line(1, "tick 1", 10), line(2, "tick 2", 20), line(3, "fault", 2131)])
    const text = renderRows([
      { type: "line", row: rows[0]! },
      { type: "line", row: rows[1]! },
      { type: "gap", count: 7 },
      { type: "line", row: rows[2]!, marked: true },
    ])
    expect(text).toContain("[+0.005] boot")
    expect(text).toContain("[+0.010] tick 1 ×2 (numbers vary; last +0.020: tick 2)")
    expect(text).toContain("… 7 lines omitted (grep the full log for them) …")
    expect(text).toContain("[+2.131] fault   ← match")
  })

  it("stderr 的行带 ! 标记", () => {
    const rows = foldLines([{ ...line(0, "boom"), err: true }])
    expect(renderRows([{ type: "line", row: rows[0]! }])).toBe("[+0.000] ! boom")
  })

  it("超长行按命中点开窗裁,不是从行首裁", () => {
    const text = `${"U�".repeat(230)}initialized ok${"z".repeat(20)}`
    const at = text.indexOf("initialized")
    const clipped = clipText(text, 400, at)
    expect(clipped).toContain("initialized ok")
    expect(clipped).toMatch(/^…\(\+\d+ chars before\) /)
    expect(clipText("short")).toBe("short")
    expect(clipText("x".repeat(500), 400)).toMatch(/full line in the log file\)$/)
  })
})

describe("parseTcpTarget", () => {
  it("host:port,只给端口时 host 是 localhost", () => {
    expect(parseTcpTarget("localhost:19021")).toEqual({ host: "localhost", port: 19021 })
    expect(parseTcpTarget("9090")).toEqual({ host: "localhost", port: 9090 })
    expect(parseTcpTarget("10.0.0.5:4444")).toEqual({ host: "10.0.0.5", port: 4444 })
    expect(() => parseTcpTarget("not a port")).toThrow(/could not parse tcp/)
  })
})

// ─── 采集器 ──────────────────────────────────────────────────────────────────

describe("LogCapture", () => {
  it("环形缓冲从头丢,文件里一行不少,dropped 记账", async () => {
    const dir = createTempDir()
    const script = join(dir, "five.mjs")
    writeFileSync(script, `for (let i = 0; i < 5; i++) console.log("line " + i);`)
    const file = join(dir, "hw.log")
    const capture = new LogCapture({ kind: "child", argv: [process.execPath, script] }, "five", file, dir, {
      maxBufferLines: 3,
    })
    openCaptures.push(capture)
    await capture.start()
    await waitFor(() => !!capture.exited)
    await capture.stop()
    expect(capture.totalLines).toBe(5)
    expect(capture.lines.map((entry) => entry.text)).toEqual(["line 2", "line 3", "line 4"])
    expect(capture.dropped).toBe(2)
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().split("\n").length >= 5)
    const written = readFileSync(file, "utf8").trim().split("\n")
    expect(written).toHaveLength(5)
    expect(written[0]).toMatch(/^\[\+\d+\.\d{3}\] line 0$/)
  })

  it("源退出前没等到换行的那半句也算一行", async () => {
    const dir = createTempDir()
    const script = join(dir, "tail.mjs")
    writeFileSync(script, `process.stdout.write("boot ok\\nlast words without newline");`)
    const capture = new LogCapture(
      { kind: "child", argv: [process.execPath, script] },
      "tail",
      join(dir, "hw.log"),
      dir,
    )
    openCaptures.push(capture)
    await capture.start()
    await waitFor(() => !!capture.exited)
    await capture.stop()
    expect(capture.lines.map((entry) => entry.text)).toEqual(["boot ok", "last words without newline"])
  })

  it("stop 杀的是整个进程组:fork 出读进程的那层 shell 死了,孙进程也得死", async () => {
    const dir = createTempDir()
    const grandchild = join(dir, "grandchild.mjs")
    writeFileSync(grandchild, `console.log("grandchild " + process.pid); setInterval(() => {}, 1000);`)
    const parent = join(dir, "parent.mjs")
    writeFileSync(
      parent,
      `import { spawn } from "node:child_process";\nconsole.log("up");\nconst child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });\nchild.on("exit", (code) => process.exit(code ?? 0));`,
    )
    const capture = new LogCapture(
      { kind: "child", argv: [process.execPath, parent] },
      "tree",
      join(dir, "hw.log"),
      dir,
    )
    openCaptures.push(capture)
    await capture.start()
    await waitFor(() => capture.lines.some((entry) => entry.text.startsWith("grandchild ")))
    const pid = Number(capture.lines.find((entry) => entry.text.startsWith("grandchild "))!.text.split(" ")[1])
    await capture.stop()
    expect(capture.exited).toBeDefined()
    // 孙进程要么已经没了,要么正在退出:kill 0 探活,给它一点时间。
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 5000)
  })

  it("finish 之后缓冲不再长", async () => {
    const dir = createTempDir()
    const script = join(dir, "chatty.mjs")
    writeFileSync(script, `setInterval(() => console.log("tick"), 5);`)
    const capture = new LogCapture(
      { kind: "child", argv: [process.execPath, script] },
      "chatty",
      join(dir, "hw.log"),
      dir,
    )
    openCaptures.push(capture)
    await capture.start()
    await waitFor(() => capture.totalLines >= 3)
    await capture.stop()
    const frozen = capture.totalLines
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(capture.running).toBe(false)
    expect(capture.totalLines).toBe(frozen)
  })
})

describe("LogCapture tcp source", () => {
  it("从 TCP 服务读行;对端关闭是 disconnect(code null),不是崩溃", async () => {
    const { server, port } = await listenLocal((socket) => {
      socket.write("boot ok\r\nloop 1\n")
      setTimeout(() => socket.end("bye\n"), 30)
    })
    try {
      const dir = createTempDir()
      const capture = new LogCapture({ kind: "tcp", host: "127.0.0.1", port }, "tcp", join(dir, "hw.log"), dir)
      openCaptures.push(capture)
      await capture.start()
      await waitFor(() => !!capture.exited)
      expect(capture.lines.map((entry) => entry.text)).toEqual(["boot ok", "loop 1", "bye"])
      expect(capture.exited?.code).toBeNull()
      expect(capture.running).toBe(false)
    } finally {
      server.close()
    }
  })

  it("没人监听时 start 直接拒,而不是静默挂着", async () => {
    const { server, port } = await listenLocal(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const dir = createTempDir()
    const capture = new LogCapture({ kind: "tcp", host: "127.0.0.1", port }, "tcp", join(dir, "hw.log"), dir)
    openCaptures.push(capture)
    await expect(capture.start()).rejects.toThrow(/failed to connect log source 127\.0\.0\.1:\d+/)
    expect(capture.running).toBe(false)
  })

  it("stop 断开连接,缓冲不再长", async () => {
    let timer: ReturnType<typeof setInterval> | undefined
    const { server, port } = await listenLocal((socket) => {
      timer = setInterval(() => socket.write("tick\n"), 5)
      socket.on("close", () => clearInterval(timer))
    })
    try {
      const dir = createTempDir()
      const capture = new LogCapture({ kind: "tcp", host: "127.0.0.1", port }, "tcp", join(dir, "hw.log"), dir)
      openCaptures.push(capture)
      await capture.start()
      await waitFor(() => capture.totalLines >= 3)
      await capture.stop()
      const frozen = capture.totalLines
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(capture.totalLines).toBe(frozen)
      expect(capture.running).toBe(false)
    } finally {
      if (timer) clearInterval(timer)
      server.close()
    }
  })
})

// ─── 工具 ────────────────────────────────────────────────────────────────────

describe("log tool", () => {
  it("start tcp 采到流,wait 命中", async () => {
    const { server, port } = await listenLocal((socket) => {
      socket.write("boot done\n")
      setTimeout(() => socket.write("assert failed: overtemp\n"), 30)
    })
    try {
      const { run } = makeTool()
      const started = await run({ action: "start", tcp: `127.0.0.1:${port}` })
      expect(textOf(started)).toContain(`Capturing tcp 127.0.0.1:${port}`)
      expect(started.details!.source).toBe(`tcp 127.0.0.1:${port}`)
      const waited = await run({ action: "wait", pattern: "assert", timeoutMs: 5000 })
      expect(textOf(waited)).toContain("matched /assert/")
      const stopped = await run({ action: "stop" })
      expect(textOf(stopped)).toContain("stopped tcp 127.0.0.1:")
    } finally {
      server.close()
    }
  })

  it("tcp 解析不了时用 log 自己的话拒", async () => {
    const { run } = makeTool()
    await expect(run({ action: "start", tcp: "not a port" })).rejects.toThrow(/could not parse tcp/)
  })

  it("start 报日志文件位置;status / stop 往返", async () => {
    const { run, cwd } = makeTool()
    const started = await run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    expect(textOf(started)).toContain("Capturing")
    expect(textOf(started)).toContain(join(cwd, ".yoma", "logs"))
    expect(started.details!.running).toBe(true)
    expect(started.details!.file).toMatch(/hw-\d{8}-\d{9}\.log$/)

    await waitForLines(run, 1)
    const status = await run({ action: "status" })
    expect(textOf(status)).toContain("source: running")
    expect(textOf(status)).toContain("last line: [+")
    expect(textOf(status)).toContain("alive")

    const start = Date.now()
    const stopped = await run({ action: "stop" })
    expect(Date.now() - start).toBeLessThan(4000) // SIGTERM 就该收工,不用等 sleep 30
    expect(textOf(stopped)).toContain("stopped")
    expect(textOf(stopped)).not.toContain("did not confirm exit")
    expect(stopped.details!.running).toBe(false)
  })

  it("wait 命中:给命中行与上下文,推游标", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(BOOT_THEN_FAULT) })
    const waited = await run({ action: "wait", pattern: "hardfault", timeoutMs: 3000 })
    const text = textOf(waited)
    expect(text).toContain("matched /hardfault/")
    expect(text).toContain("← match")
    expect(text).toContain("HAL init ok") // 命中行前面的上下文
    expect(waited.details!.matched).toBe(true)
    expect(waited.details!.cursor).toBeGreaterThan(0)
  })

  it("前文已经被 read 消费过,命中时上下文照样给", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(BOOT_THEN_FAULT) })
    await waitForLines(run, 2)
    await run({ action: "read" })
    const waited = await run({ action: "wait", pattern: "hardfault", timeoutMs: 3000 })
    expect(textOf(waited)).toContain("HAL init ok")
  })

  it("wait 也命中调用之前就到了的行", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(THREE_LINES_THEN_WAIT) })
    await waitForLines(run, 3)
    const waited = await run({ action: "wait", pattern: "line two", timeoutMs: 1000 })
    expect(textOf(waited)).toContain("matched /line two/")
  })

  it("wait 超时:给预览,不消费证据,游标不动", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(THREE_LINES_THEN_WAIT) })
    await waitForLines(run, 3)
    const waited = await run({ action: "wait", pattern: "never", timeoutMs: 300 })
    const text = textOf(waited)
    expect(text).toContain("timed out after 300 ms")
    expect(text).toContain("line three")
    expect(waited.details!.matched).toBe(false)
    expect(waited.details!.cursor).toBe(0)
    const read = await run({ action: "read" })
    expect(textOf(read)).toContain("+3 new lines")
  })

  it("源退出就立刻回来,不等满超时", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(`console.log("bye")`) })
    const start = Date.now()
    const waited = await run({ action: "wait", pattern: "never", timeoutMs: 10_000 })
    expect(Date.now() - start).toBeLessThan(5000)
    expect(textOf(waited)).toMatch(/source exited \(code 0\) before \/never\/ matched/)
  })

  it("源退出前一刻打的那行也能命中", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(`console.log("boot"); console.log("ready to serve")`) })
    const waited = await run({ action: "wait", pattern: "ready", timeoutMs: 3000 })
    expect(textOf(waited)).toContain("matched /ready/")
  })

  it("read 给游标之后的增量,再读就是没有新行", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(THREE_LINES_THEN_WAIT) })
    await waitForLines(run, 3)
    const first = await run({ action: "read" })
    expect(textOf(first)).toContain("+3 new lines since seq 0")
    expect(textOf(first)).toContain("line three")
    expect(first.details!.cursor).toBe(3)
    const second = await run({ action: "read" })
    expect(textOf(second)).toContain("no new lines since seq 3")
  })

  it("read 带 pattern 只筛不消费", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(THREE_LINES_THEN_WAIT) })
    await waitForLines(run, 3)
    const filtered = await run({ action: "read", pattern: "two" })
    expect(textOf(filtered)).toContain("1 of 3 lines since seq 0 match /two/")
    expect(textOf(filtered)).toContain("line two")
    expect(textOf(filtered)).not.toContain("line one")
    expect(filtered.details!.cursor).toBe(0)
  })

  it("节选封顶并指向全文文件", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(FORTY_DISTINCT) })
    await waitForLines(run, 40)
    const read = await run({ action: "read", maxLines: 10 })
    const text = textOf(read)
    expect(text).toContain("lines omitted")
    expect(text).toContain("full log:")
    expect(text.split("\n").filter((row) => row.startsWith("[+"))).toHaveLength(10)
  })

  it("刷屏的传感器循环折成一行,而不是全倒出来", async () => {
    const { run } = makeTool()
    await run({
      action: "start",
      command: writeSource(`for (let i = 0; i < 50; i++) console.log("imu ax=" + (100 + i) + " ay=" + (i % 7));`),
    })
    await waitForLines(run, 50)
    const read = await run({ action: "read" })
    const text = textOf(read)
    expect(text).toContain("×50")
    expect(text).toContain("numbers vary")
    expect(text.split("\n").filter((row) => row.startsWith("[+"))).toHaveLength(1)
  })

  it("每行都是 4 KB 时一次 read 照样有界", async () => {
    const { run } = makeTool()
    await run({
      action: "start",
      command: writeSource(
        `const words = ["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel"]; for (const w of words) console.log(w + " " + "z".repeat(4000));`,
      ),
    })
    await waitForLines(run, 8)
    const read = await run({ action: "read", maxLines: 500 })
    expect(textOf(read).length).toBeLessThan(30_000)
  })

  it("已经在采时拒绝第二个 start", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    await expect(run({ action: "start", command: writeSource(ALIVE_FOREVER) })).rejects.toThrow(/already capturing/)
  })

  it("没 start 就 read / wait / stop:告诉模型先 start", async () => {
    const { run } = makeTool()
    await expect(run({ action: "read" })).rejects.toThrow(/no log capture — run `log start`/)
    await expect(run({ action: "stop" })).rejects.toThrow(/no log capture/)
  })

  it("起不来的源当场报,不留半个采集器", async () => {
    const { run } = makeTool()
    const missing = join(createTempDir(), "does-not-exist")
    await expect(run({ action: "start", command: `"${missing}" --flag` })).rejects.toThrow(/failed to start log source/)
    await expect(run({ action: "status" })).rejects.toThrow(/no log capture/)
  })

  it("三个源互斥;一个都没给也不行", async () => {
    const { run } = makeTool()
    await expect(run({ action: "start", tcp: "localhost:1", command: "cat" })).rejects.toThrow(
      /exactly one source, got tcp \+ command/,
    )
    await expect(run({ action: "start" })).rejects.toThrow(/exactly one source/)
  })

  it("wait 必须带 pattern,坏正则当场拒", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    await expect(run({ action: "wait" })).rejects.toThrow(/requires pattern/)
    await expect(run({ action: "wait", pattern: "(" })).rejects.toThrow(/invalid pattern/)
  })

  it("wait 期间把尾巴流式喂给 onUpdate,每拍都有界", async () => {
    const { run } = makeTool()
    const updates: string[] = []
    await run({ action: "start", command: writeSource(BOOT_THEN_FAULT) })
    await run({ action: "wait", pattern: "hardfault", timeoutMs: 3000 }, BACKGROUND_CONTEXT, (partial) => {
      updates.push(partial.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
    })
    expect(updates.length).toBeGreaterThan(0)
    for (const update of updates) {
      expect(update.length).toBeLessThan(4_500)
      // 没有行就不发:一条空文本会白花内核节流器的前沿。
      expect(update.length).toBeGreaterThan(0)
    }
  })

  it("用户按停止:wait 立刻以 aborted 收场,游标不动,采集器还活着", async () => {
    const { run } = makeTool()
    await run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    await waitForLines(run, 1)
    const controller = new AbortController()
    const waiting = run(
      { action: "wait", pattern: "never", timeoutMs: 30_000 },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    setTimeout(() => controller.abort(), 50)
    const start = Date.now()
    const waited = await waiting
    expect(Date.now() - start).toBeLessThan(3000)
    expect(textOf(waited)).toContain("aborted while waiting for /never/")
    expect(waited.details!.cursor).toBe(0)
    expect(waited.details!.running).toBe(true)
  })

  it("这一轮已经中止时 start 一个源都不起", async () => {
    const { run } = makeTool()
    await expect(
      run(
        { action: "start", command: writeSource(ALIVE_FOREVER) },
        withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow(/log start was aborted/)
    await expect(run({ action: "status" })).rejects.toThrow(/no log capture/)
  })

  it("会话关闭:dispose 停掉采集器;没 start 过也不抛;之后的 start 一律拒", async () => {
    const idle = makeTool()
    await idle.tool.dispose()
    await expect(idle.run({ action: "start", command: writeSource(ALIVE_FOREVER) })).rejects.toThrow(
      /session was closed/,
    )

    const { tool, run } = makeTool()
    await run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    await waitForLines(run, 1)
    await tool.dispose()
    const status = await run({ action: "status" })
    expect(status.details!.running).toBe(false)
    expect(textOf(status)).toMatch(/source: exited/)
    await tool.dispose()
  })

  it("start 卡在 spawn 途中时会话被关:自己起的源要收掉,不能活过会话", async () => {
    const { tool, run } = makeTool()
    const starting = run({ action: "start", command: writeSource(ALIVE_FOREVER) })
    await tool.dispose()
    await expect(starting).rejects.toThrow(/session was closed/)
    await expect(run({ action: "status" })).rejects.toThrow(/no log capture/)
  })

  it("采集器绝不拖住事件循环:一个只 start 不 stop 的进程照样能自己退出(高危回归)", async () => {
    const dir = createTempDir()
    const source = join(dir, "forever.mjs")
    writeFileSync(source, `setInterval(() => console.log("tick"), 10);`)
    const script = join(dir, "pin.mts")
    // 按测试文件自己的位置找源码与包目录:根上的 `npm test` 里 cwd 是仓库根,不是 packages/kernel。
    const kernelDir = fileURLToPath(new URL("..", import.meta.url))
    const captureModule = join(kernelDir, "src", "host", "tools", "log", "capture.ts")
    writeFileSync(
      script,
      [
        `import { LogCapture } from ${JSON.stringify(pathToFileURL(captureModule).href)}`,
        `const capture = new LogCapture({ kind: "child", argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(source)}] }, "forever", ${JSON.stringify(join(dir, "hw.log"))}, ${JSON.stringify(dir)})`,
        `await capture.start()`,
        `await new Promise((resolve) => setTimeout(resolve, 300))`,
        `console.log("lines " + capture.totalLines)`,
        // 故意不 stop:退出钩子(killOnHostExit)负责收尸,而进程必须能自己走到退出。
      ].join("\n"),
    )
    const { spawn } = await import("node:child_process")
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: kernelDir,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (out += chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => (out += chunk))
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(-1)
      }, 8000)
      child.once("exit", (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    expect(out, out).toMatch(/lines \d+/)
    expect(code, `process did not exit on its own: ${out}`).toBe(0)
  }, 15_000)

  it("同一批里两个 start 并行:只起一个采集器,另一个被拒;发动机不读 executionMode,顺序由工具自己排", async () => {
    const { tool, run } = makeTool()
    const results = await Promise.allSettled([
      run({ action: "start", command: writeSource(ALIVE_FOREVER, "a") }),
      run({ action: "start", command: writeSource(ALIVE_FOREVER, "b") }),
    ])
    const ok = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already capturing/)
    const pid = Number(
      /pid (\d+)/.exec(textOf((ok[0] as PromiseFulfilledResult<AgentToolResult<LogDetails>>).value))![1],
    )
    await tool.dispose()
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it("同一批里 start + wait 并行:wait 排在 start 之后,不会撞上 no log capture", async () => {
    const { run } = makeTool()
    const [, waited] = await Promise.all([
      run({ action: "start", command: writeSource(BOOT_THEN_FAULT) }),
      run({ action: "wait", pattern: "hardfault", timeoutMs: 3000 }),
    ])
    expect(textOf(waited)).toContain("matched /hardfault/")
  })

  // Inherited Node stdio survives its parent on POSIX; Windows does not guarantee this.
  // Windows tree cleanup and detached sources are exercised by the adjacent tests.
  it.skipIf(process.platform === "win32")("shell 退了、孙进程还握着管道:仍算在采,第二个 start 被拒,stop 连孙进程一起收", async () => {
    const dir = createTempDir()
    const grandchild = join(dir, "grandchild.mjs")
    writeFileSync(
      grandchild,
      `console.log("grandchild " + process.pid); setInterval(() => console.log("tick"), 20); process.send?.("ready");`,
    )
    const parent = join(dir, "parent.mjs")
    writeFileSync(
      parent,
      `import { spawn } from "node:child_process";\nconst child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });\nchild.once("message", () => process.exit(0));`,
    )
    const { run } = makeTool()
    await run({ action: "start", command: `"${process.execPath}" "${parent}"` })
    await waitForLines(run, 4)
    // 父进程已经退了(exit 事件到了),但 stdout 还被孙进程握着 —— 行还在来,这不是"源退了"。
    await new Promise((resolve) => setTimeout(resolve, 200))
    const status = await run({ action: "status" })
    expect(textOf(status)).toContain("source: running")
    expect(status.details!.running).toBe(true)
    const before = status.details!.totalLines
    await expect(run({ action: "start", command: writeSource(ALIVE_FOREVER) })).rejects.toThrow(/already capturing/)
    // 被拒之后旧采集器还在收行(孙进程每 20ms 一行)。
    await waitForLines(run, before + 1)
    const pid = Number(
      /grandchild (\d+)/.exec(textOf(await run({ action: "read", pattern: "grandchild", since: 0 })))![1],
    )
    const stopped = await run({ action: "stop" })
    expect(stopped.details!.running).toBe(false)
    if (process.platform !== "win32") {
      // POSIX 上 stop 杀的是进程组:shell 死了组还在,孙进程跟着走。Windows 没有进程组,这条兜不住。
      await waitFor(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
    } else {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // 已经没了。
      }
    }
  }, 20_000)

  it("读进程逃出了进程组(setsid / Windows):stop 等 1 秒冲刷就收场,并如实说设备可能还被占着", async () => {
    const dir = createTempDir()
    const grandchild = join(dir, "escaped.mjs")
    writeFileSync(grandchild, `console.log("escaped " + process.pid); setInterval(() => console.log("tick"), 20);`)
    const parent = join(dir, "parent.mjs")
    // detached:孙进程另起一个进程组,kill(-pid) 够不着它 —— 模型写 `sh -c "nohup reader &"` 就是这个形状。
    writeFileSync(
      parent,
      `import { spawn } from "node:child_process";\nconst c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });\nc.unref();\nsetTimeout(() => process.exit(0), 50);`,
    )
    const { run } = makeTool()
    await run({ action: "start", command: `"${process.execPath}" "${parent}"` })
    await waitForLines(run, 3)
    const pid = Number(/escaped (\d+)/.exec(textOf(await run({ action: "read", pattern: "escaped", since: 0 })))![1])
    try {
      const start = Date.now()
      const stopped = await run({ action: "stop" })
      expect(Date.now() - start).toBeLessThan(4000)
      expect(textOf(stopped)).toContain("did not confirm exit")
      expect(stopped.details!.running).toBe(false)
      expect(textOf(await run({ action: "status" }))).toContain("source: stopped (exit not confirmed)")
    } finally {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // 已经没了。
      }
      await waitFor(() => {
        try { process.kill(pid, 0); return false } catch { return true }
      })
    }
  }, 20_000)

  it("命中行落在折叠组中间也要显示出来:命中行单独成行,前后各自折叠", async () => {
    const { run } = makeTool()
    await run({
      action: "start",
      command: writeSource(`console.log("[boot] ready"); for (const n of [41, 42, 43, 44]) console.log("count=" + n);`),
    })
    // 先等行到齐:命中那一拍 count=43 可能还没打出来,后文就没得给。
    await waitForLines(run, 5)
    const waited = await run({ action: "wait", pattern: "count=42", timeoutMs: 3000 })
    const text = textOf(waited)
    expect(text).toContain("matched /count=42/")
    expect(text).toContain("count=42   ← match")
    expect(text).toContain("[boot] ready")
    expect(text).toContain("count=43")
  })
})
