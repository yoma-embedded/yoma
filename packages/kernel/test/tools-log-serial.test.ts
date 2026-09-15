/**
 * log 工具的串口源(host/tools/log/serial.ts):三平台的端口名、stty 参数、Windows 脚本、枚举,
 * 以及一条走真 tty 的端到端(python3 的 pty,没有 python3 就跳过)。移植自 attic/test/serial.test.ts。
 */

import { afterEach, describe, expect, it } from "vitest"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import type { LogDetails, LogInput } from "../src/host/tools/log/contract.ts"
import {
  buildSttyArgs,
  DEFAULT_BAUD,
  listSerialPorts,
  normalizeSerialPort,
  parsePortLines,
  prepareSerial,
  serialArgv,
  serialOpenConfirmMs,
  serialPowershellArgv,
  serialPowershellExe,
  unsupportedBaud,
  windowsReaderScript,
} from "../src/host/tools/log/serial.ts"
import { createLogTool, type LogTool } from "../src/host/tools/log/session.ts"
import { POWERSHELL_FLAGS, PS_NO_PROGRESS } from "../src/host/tools/powershell/session.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const openTools: LogTool[] = []
const fakeDevices: ChildProcess[] = []

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-serial-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

function makeTool() {
  const cwd = createTempDir()
  const tool = createLogTool()
  openTools.push(tool)
  const run = (params: LogInput): Promise<AgentToolResult<LogDetails>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT)
  return { run, cwd }
}

function textOf(result: AgentToolResult<LogDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/**
 * 假串口:一个真的 pty(字符设备 + 真 termios),由 python3 的 stdlib 造。
 * 打印从设备路径,然后按节奏往主设备写行 —— 于是 open/stty/cat 这条真实链路可以在没有硬件的机器上
 * 跑完整,而不是拿一个 shell 脚本冒充串口。
 */
const PTY_SOURCE = `
import os, pty, sys, time
master, slave = pty.openpty()
sys.stdout.write(os.ttyname(slave) + "\\n")
sys.stdout.flush()
for i in range(200):
    os.write(master, b"HardFault at 0x08001234\\n" if i == 4 else b"boot: tick %d\\n" % i)
    time.sleep(0.05)
`

/** python3 不在就跳过 —— 这个用例要的是真 tty,没有替代品。 */
function havePython(): boolean {
  try {
    return spawnSync("python3", ["-c", "import pty"]).status === 0
  } catch {
    // Windows 上找不到可执行文件时 spawnSync 直接抛,不是回非零退出码;那里也没有 pty 可用。
    return false
  }
}

async function startFakeDevice(): Promise<string> {
  const child = spawn("python3", ["-c", PTY_SOURCE], { stdio: ["ignore", "pipe", "pipe"] })
  fakeDevices.push(child)
  return await new Promise<string>((resolve, reject) => {
    let out = ""
    const timer = setTimeout(() => reject(new Error("fake serial device did not report its path")), 5000)
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      out += chunk
      const nl = out.indexOf("\n")
      if (nl < 0) return
      clearTimeout(timer)
      resolve(out.slice(0, nl).trim())
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

afterEach(async () => {
  for (const tool of openTools.splice(0)) await tool.dispose()
  for (const child of fakeDevices.splice(0)) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGKILL")
    // 收尸只是为了让测试输出干净,不值得为它挂住 —— 已经退了的进程不会再发 'exit'。
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))])
  }
  // WriteStream.end() 异步关闭文件;同步 rm 重试会阻塞关闭回调,Windows 因句柄仍打开而报 EPERM。
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("normalizeSerialPort", () => {
  it("posix 上补全 /dev,已经是路径的原样放过", () => {
    expect(normalizeSerialPort("cu.usbmodem1103", "darwin")).toBe("/dev/cu.usbmodem1103")
    expect(normalizeSerialPort("/dev/ttyUSB0", "linux")).toBe("/dev/ttyUSB0")
    expect(normalizeSerialPort("  ttyACM0 ", "linux")).toBe("/dev/ttyACM0")
  })

  it("windows 上归一成 COMn,认 \\\\.\\COM12 这种大号口的写法", () => {
    expect(normalizeSerialPort("com3", "win32")).toBe("COM3")
    expect(normalizeSerialPort("\\\\.\\COM12", "win32")).toBe("COM12")
    expect(() => normalizeSerialPort("/dev/ttyUSB0", "win32")).toThrow(/is not a Windows serial port/)
  })

  it("认出写错平台的名字并说清楚", () => {
    expect(() => normalizeSerialPort("COM5", "darwin")).toThrow(/Windows port name/)
    expect(() => normalizeSerialPort("", "linux")).toThrow(/port is empty/)
  })
})

describe("buildSttyArgs", () => {
  it("带上波特率、8N1、无流控,以及 clocal,raw -echo 在最后", () => {
    const args = buildSttyArgs(921600)
    expect(args[0]).toBe("921600")
    expect(args).toContain("cs8")
    expect(args).toContain("-parenb")
    expect(args).toContain("-cstopb")
    expect(args).toContain("-crtscts")
    expect(args).toContain("clocal")
    expect(args.slice(-2)).toEqual(["raw", "-echo"])
  })
})

describe("unsupportedBaud", () => {
  it("Linux 上只认标准速率,并给出最近的两档", () => {
    expect(unsupportedBaud(115200, "linux")).toBeUndefined()
    const message = unsupportedBaud(250000, "linux")
    expect(message).toContain("250000 is not one of them")
    expect(message).toContain("230400 or 460800")
  })

  it("macOS / Windows 不查表", () => {
    expect(unsupportedBaud(250000, "darwin")).toBeUndefined()
    expect(unsupportedBaud(250000, "win32")).toBeUndefined()
  })
})

describe("serialArgv", () => {
  it("posix 上是不带参数的 cat —— 设备靠继承来的 fd 进去", () => {
    expect(serialArgv("/dev/ttyUSB0", 115200, "linux")).toEqual(["cat"])
    expect(serialArgv("/dev/cu.usbmodem1", 921600, "darwin")).toEqual(["cat"])
  })

  it("windows 上是 powershell 的固定开关 + -EncodedCommand,解回来就是那段读串口的脚本", () => {
    const argv = serialArgv("COM4", 115200, "win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(argv[0]).toMatch(/powershell\.exe$/)
    expect(argv.slice(1, 1 + POWERSHELL_FLAGS.length)).toEqual([...POWERSHELL_FLAGS])
    expect(argv[1 + POWERSHELL_FLAGS.length]).toBe("-EncodedCommand")
    const script = Buffer.from(argv[argv.length - 1]!, "base64").toString("utf16le")
    expect(script.split("\n")[0]).toBe(PS_NO_PROGRESS)
    expect(script).toContain("System.IO.Ports.SerialPort -ArgumentList 'COM4',115200,'None',8,'One'")
    expect(script).toContain("$p.DtrEnable=$true")
    expect(script).toContain("[Text.Encoding]::UTF8.GetBytes($_.Exception.Message)")
  })

  it("Windows 脚本只收 COMn:端口名是拼进脚本文本的,前面必须有正则", () => {
    expect(() => windowsReaderScript("COM3'; Remove-Item -Recurse C:\\", 115200)).toThrow(
      /is not a Windows serial port name/,
    )
    expect(() => serialPowershellArgv("Write-Output hi", undefined)).toThrow(/powershell\.exe/)
  })

  it("串口只认 Windows PowerShell 5.1:PATH 上只有 pwsh 也不用它(PowerShell 7 没有 System.IO.Ports)", () => {
    const dir = createTempDir()
    writeFileSync(join(dir, "pwsh.exe"), "")
    writeFileSync(join(dir, "pwsh"), "")
    const resolved = serialPowershellExe(dir)
    // 没装 5.1 的机器上是 undefined;Windows CI 上是 System32 里那个 —— 两种都不许是 pwsh。
    expect(resolved === undefined || /powershell\.exe$/i.test(resolved)).toBe(true)
    expect(resolved ?? "").not.toMatch(/pwsh/)
  })
})

describe("serialOpenConfirmMs", () => {
  it("只有 Windows 需要再确认一次口真开成了", () => {
    expect(serialOpenConfirmMs("win32")).toBeGreaterThan(0)
    expect(serialOpenConfirmMs("darwin")).toBe(0)
    expect(serialOpenConfirmMs("linux")).toBe(0)
  })
})

describe("parsePortLines", () => {
  it("`名字<TAB>说明`,说明可以没有", () => {
    expect(parsePortLines("COM1\t\r\nCOM4\tUSB 串行设备 (COM4)\r\n\n")).toEqual([
      { path: "COM1" },
      { path: "COM4", description: "USB 串行设备 (COM4)" },
    ])
  })
})

describe("listSerialPorts", () => {
  it.skipIf(process.platform === "win32")("只报这个平台真实的端口名,不报系统自带的假串口", async () => {
    const ports = await listSerialPorts()
    for (const entry of ports) {
      expect(entry.path.startsWith("/dev/")).toBe(true)
      expect(entry.path).not.toMatch(/Bluetooth-Incoming-Port|debug-console|wlan-debug/)
    }
  })
})

describe("prepareSerial", () => {
  it.skipIf(process.platform === "win32")("普通文件不是串口 —— 挡住写错的路径,也挡住拿它读任意文件", () => {
    const file = join(createTempDir(), "not-a-tty")
    writeFileSync(file, "secret\n")
    expect(() => prepareSerial(file, 115200)).toThrow(/is not a serial device/)
  })

  it.skipIf(process.platform === "win32")("不存在的设备给的是下一步动作,不是 errno", () => {
    expect(() => prepareSerial(join(createTempDir(), "missing"), 115200)).toThrow(/does not exist — run `log ports`/)
  })

  it("windows 上没有可押的 fd", () => {
    expect(prepareSerial("COM3", 115200, "win32")).toBeUndefined()
  })
})

// ─── 工具 ────────────────────────────────────────────────────────────────────

describe("log start port", () => {
  it.skipIf(!havePython())(
    "从一个真串口设备采到行,wait 能命中,stop 不用等强杀",
    async () => {
      const device = await startFakeDevice()
      const { run } = makeTool()

      const started = await run({ action: "start", port: device, baud: 115200 })
      expect(textOf(started)).toContain(`serial ${device} @ 115200 8N1`)

      const waited = await run({ action: "wait", pattern: "hardfault", timeoutMs: 8000 })
      const text = textOf(waited)
      expect(text).toContain("matched /hardfault/")
      expect(text).toContain("HardFault at 0x08001234")
      // 命中行前后要有上下文,不然模型看到的是一条没有来龙去脉的孤行。
      expect(text).toContain("boot: tick")

      const stopped = await run({ action: "stop" })
      expect(textOf(stopped)).toContain("stopped serial")
      // 这一条钉的是 serial.ts 文件头第 4 条:读进程一旦把设备变成自己的控制终端,SIGTERM 就杀不动它,
      // stop 要等满 5 秒再强杀,并告诉模型"设备可能还占着"。
      expect(textOf(stopped)).not.toContain("did not confirm exit")
    },
    20_000,
  )

  it("三个源互斥 —— 给两个不默默挑一个", async () => {
    const { run } = makeTool()
    await expect(run({ action: "start", port: "/dev/ttyUSB0", command: "cat /dev/ttyUSB0" })).rejects.toThrow(
      /exactly one source, got port \+ command/,
    )
    await expect(run({ action: "start", port: "/dev/ttyUSB0", tcp: "localhost:19021" })).rejects.toThrow(
      /exactly one source/,
    )
  })

  // 两个方向都要当场认出来 —— 报"打不开"会让人去查线。输入按本机平台挑:写死 COM5 的
  // 那一版在 Windows 上是红的(COM5 在那儿是合法名字,只是这台机器上没有)。
  // Windows 上这两条会真起 PowerShell 5.1 跑一次 WMI 枚举(withPortHints 在报错前也会):给足时间,别让慢跑机把断言失败变成超时。
  it("端口名写成了另一个系统的样子时当场说清,而不是报打不开", async () => {
    const { run } = makeTool()
    const [wrong, expected] =
      process.platform === "win32"
        ? (["/dev/ttyUSB0", /is not a Windows serial port/] as const)
        : (["COM5", /Windows port name/] as const)
    await expect(run({ action: "start", port: wrong })).rejects.toThrow(expected)
  }, 20_000)

  it("ports 不需要先 start,也不会打开任何设备", async () => {
    const { run } = makeTool()
    const text = textOf(await run({ action: "ports" }))
    expect(text).toMatch(/serial ports?:|no serial ports/)
  }, 20_000)

  it.skipIf(process.platform === "win32")(
    "没有 Windows PowerShell 5.1 时串口 argv 报的是下一步动作,不是一句 undefined",
    () => {
      expect(() => serialArgv("COM4", 115200, "win32")).toThrow(/powershell\.exe.*pyserial/)
    },
  )

  it("默认波特率是 115200", () => {
    expect(DEFAULT_BAUD).toBe(115_200)
  })
})
