/**
 * log 工具的契约:菜单那一半。
 *
 * 把板子的运行日志接进会话 —— UART 串口、J-Link RTT(工具自己起一个只管 RTT 的 J-Link GDB server)、
 * TCP 流(别的 gdb server 的 RTT/telnet 口),或者任意往 stdout 吐日志的命令。七个动作(start/read/write/wait/status/stop/ports)合成一个工具:日志源是长驻、有状态的,
 * 与一次性 spawn 的引擎工具正相反,所以厨房那半(session.ts)持有一个会话级采集器,各个动作只是对它
 * 发指令。
 *
 * 门规同 flash(boundary.test.ts 第 3、5 条):界面只许走 `@yoma-desktop/kernel/tools/log/contract`,
 * 而这个文件只许 import typebox 与工具目录内的相对路径(不含 session.ts)。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"
import { probeCommandIn } from "../flash/contract.ts"

/** 绝大多数板子的出厂速率;真值由调用方给,这只是 baud 缺省。 */
export const DEFAULT_BAUD = 115_200
export const DEFAULT_WAIT_MS = 10_000
export const MAX_WAIT_MS = 120_000
export const DEFAULT_MAX_LINES = 80
/** RTT 走 SWD 的缺省时钟(kHz)。J-Link 自己的缺省也是 4000;长线 / 飞线上调低。 */
export const DEFAULT_RTT_SPEED_KHZ = 4000
export const MIN_RTT_SPEED_KHZ = 5
export const MAX_RTT_SPEED_KHZ = 50_000

export const LOG_ACTIONS = ["start", "read", "wait", "status", "stop", "ports", "write"] as const
export type LogAction = (typeof LOG_ACTIONS)[number]

const logParameters = Type.Object({
  // 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
  action: Type.Union(
    [
      Type.Literal("start"),
      Type.Literal("read"),
      Type.Literal("wait"),
      Type.Literal("status"),
      Type.Literal("stop"),
      Type.Literal("ports"),
      Type.Literal("write"),
    ],
    { description: "start | read | wait | status | stop | ports | write" },
  ),
  data: Type.Optional(
    Type.String({
      maxLength: 12288,
      description:
        "write: text or hex bytes to the connected serial port or RTT down channel 0 (max 4096 encoded bytes).",
    }),
  ),
  encoding: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("hex")])),
  lineEnding: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("lf"), Type.Literal("cr"), Type.Literal("crlf")])),
  tcp: Type.Optional(
    Type.String({
      description:
        'start from a TCP log/RTT stream: "host:port" — e.g. "localhost:19021" (J-Link GDBServer serves RTT there) or the port you opened with OpenOCD\'s "rtt server start". The gdb server holds the probe; this only reads the stream.',
    }),
  ),
  rtt: Type.Optional(
    Type.String({
      description:
        'start from SEGGER RTT through a J-Link probe: the J-Link target device name, e.g. "STM32G473RC". CubeMX / ordering codes ("STM32G473RCTx", "STM32F103C8T6") are shortened for you; a CubeMX family like "STM32G473R(B-C-E)Tx" is refused — pass the exact part. Starts a J-Link GDB server in RTT-only mode (does not halt, reset or flash the target).',
    }),
  ),
  rttSpeed: Type.Optional(
    Type.Number({
      description: `rtt: SWD clock in kHz (default ${DEFAULT_RTT_SPEED_KHZ}); lower it (e.g. 1000) on long or flying wires.`,
    }),
  ),
  port: Type.Optional(
    Type.String({
      description:
        'start over UART/USB serial: the port — "/dev/cu.usbmodem1103" (macOS), "/dev/ttyUSB0" or "/dev/ttyACM0" (Linux), "COM5" (Windows). Run action:"ports" to list them.',
    }),
  ),
  baud: Type.Optional(
    Type.Number({
      description: `serial baud rate, 8N1 no flow control (default ${DEFAULT_BAUD}). Linux can only set the standard rates.`,
    }),
  ),
  command: Type.Optional(
    Type.String({
      description:
        "start from any other source: a command line whose stdout is the log (no shell unless you spawn one yourself).",
    }),
  ),
  pattern: Type.Optional(
    Type.String({ description: "wait: regex to wait for (case-insensitive). read: only show matching lines." }),
  ),
  timeoutMs: Type.Optional(Type.Number({ description: `wait: give up after this long (default ${DEFAULT_WAIT_MS}).` })),
  since: Type.Optional(
    Type.Number({
      description:
        "read: start from this seq instead of the cursor. wait: only match lines from this seq on — pass the seq a flash or gdb reset/load reported to ignore output from before it.",
    }),
  ),
  maxLines: Type.Optional(Type.Number({ description: `read: max lines to show (default ${DEFAULT_MAX_LINES}).` })),
})

export type LogInput = Static<typeof logParameters>

export interface LogDetails {
  action: LogAction
  running: boolean
  cursor: number
  totalLines: number
  dropped: number
  /** 采集着什么:`serial /dev/… @ 115200 8N1` / `rtt STM32G473RC via J-Link SWD 4000 kHz` / `tcp host:port` / 命令行。没 start 过就没有。 */
  source?: string
  file?: string
  /** wait 专有:是否命中。 */
  matched?: boolean
  exitCode?: number | null
  serial?: { port: string; baud: number }
  /** RTT 源:J-Link 的器件名(归一过的)、SWD 时钟 kHz、本机 RTT telnet 口(工具自己起的 J-Link GDB server 在听)。 */
  rtt?: { device: string; speed: number; port: number }
  /** 串口与 RTT 采集在跑时为 true(write 能发);TCP / command 源恒为 false。 */
  writable?: boolean
  bytesSent?: number
}

const LOG_DESCRIPTION = `Captures the running board's log output — a UART/USB serial port, SEGGER RTT through a J-Link probe, a TCP stream (RTT from a gdb server you already run), or any command that prints to stdout — so you can see what the firmware actually did instead of guessing from the source.

Actions:
- start (port, rtt, tcp, or command): begin capturing. Exactly one source:
  - UART / USB serial: port (plus baud, default ${DEFAULT_BAUD}; 8N1, no flow control). Same call on macOS, Linux and Windows — the port name is the only difference. Run ports first if you do not know it.
  - RTT through a J-Link: rtt "<device>" — the J-Link device name, e.g. "STM32G473RC" (CubeMX names such as "STM32G473RCTx" are shortened for you) — plus rttSpeed (SWD kHz, default ${DEFAULT_RTT_SPEED_KHZ}). This starts SEGGER's J-Link GDB server in RTT-only mode: it attaches over SWD WITHOUT halting, resetting or flashing the target and reads RTT up channel 0 as text. It needs the SEGGER J-Link software (JLinkGDBServerCL; found on PATH, next to a J-Link the toolchain ledger knows, or in SEGGER's default install folder); if start says it is not found, run toolchain check — if that lists jlink with a folder, record it with toolchain set id=jlink path=<that folder> and start again; only if jlink is missing ask the user to install it or tell you where it is. ST-Link / OpenOCD / other probes: start RTT in that gdb server and use tcp.
  - RTT / any TCP log stream from a server that is already running: tcp "host:port". A J-Link GDB server started by gdb serves RTT on telnet port 19021 automatically; with OpenOCD run \`monitor rtt setup <addr> <size> "SEGGER RTT"\`, \`monitor rtt start\`, \`monitor rtt server start <port> 0\`, then read that port here.
  - Anything else: command — an argv line (a decoder script, a vendor CLI, …); no shell unless you spawn one yourself.
- write (data, [encoding: text|hex], [lineEnding: none|lf|cr|crlf]): send up to 4096 bytes to the active serial port, or to RTT down channel 0 of an rtt capture (usually the firmware's shell — e.g. data "help", lineEnding "lf"). Text uses UTF-8. No shell evaluation or automatic retry. Success means accepted by the serial driver / J-Link, not acknowledged by the device: wait for its reply in the log. Only serial and rtt captures can be written; tcp/command sources cannot.
- ports: list the serial ports on this machine, with the OS's own description where it has one. Opens nothing, takes nothing — safe to call any time, including while a capture is running.
- wait (pattern, [timeoutMs], [since]): block until a line matches the regex, the source exits, or the timeout expires. THIS IS THE MAIN ACTION — one call turns "did it boot / did it crash" into a definite answer and returns only the matched line plus a few lines of context. It searches unread lines first, so it can match a line that was already buffered before the call — the result says when the matched line arrived. A wait that does not match leaves the cursor untouched, so nothing is lost: follow it with read.
- read ([since], [pattern], [maxLines]): the tail of whatever arrived since the last read, then advances the cursor. With pattern it only shows matching lines and does not move the cursor (it is a query, not a consumption).
- status: whether the source is still running, how many lines were captured, where the full log file is.
- stop: end the capture, releasing the serial port (a tcp capture just disconnects; an rtt capture also closes the J-Link GDB server it started). The log file stays. The capture also ends when the session is closed.

Rules:
- Every line is written to a log file under .yoma/logs; this tool only ever returns a bounded excerpt (tail, folded repeats, "N lines omitted"). To search history, grep the log file path it reports — do not ask this tool for a bigger excerpt.
- Repeated lines are folded ("×137"); lines that differ only in numbers fold too, showing the first and the last of the run. Exact values are in the log file.
- Prefer wait over read: read costs tokens and gives you a wall of text, wait costs one call and gives you a conclusion.
- This tool never takes the debug-probe lease, so flash and gdb keep working while a capture runs. A tcp capture reads from a gdb server that owns the probe — stopping that server ends the stream (source shows "disconnected"). An rtt capture opens its own J-Link connection beside the others (J-Link allows several at once): flashing, gdb, a reset or a reboot do not end it, and the reboot's boot log arrives on the same stream. But only ONE RTT reader at a time: a second reader (another rtt capture, or tcp on a gdb server's RTT port 19021) splits the stream and each sees only part of the bytes — stop one first (a second rtt start anywhere in Yoma, even from another chat, is refused and names the capture that is already reading). A serial port IS exclusive, but only macOS and Windows enforce it — on Linux a second reader silently splits the byte stream with the first. A successful start is not proof that nothing else is on the port. Flashing over SWD while the serial capture runs is fine (the VCP is a separate USB interface); a reset by the flasher simply shows up in the log.
- flash, and gdb's reset / load, write a marker line ("── flash (openocd) started ──") into a running capture and report its seq. Lines before a marker come from before that event — to check the reprogrammed or reset target, wait with since=<that seq>.
- The first lines after start may be old: USB-serial adapters (ST-Link VCP and others) and RTT buffers replay what they held while nothing was reading. The result flags such a burst; do not treat it as output of the firmware you just flashed.
- Serial gives you the bytes the firmware sends, nothing else: a wrong baud looks like garbage, and a firmware that speaks a binary protocol looks like garbage too. For those, run a decoder that opens the port itself as a command source. The log file holds the same sanitized text you see here, not the raw bytes.
- RTT only produces output while the target is running and only if the firmware writes to it (rtt reads channel 0, text only). A core halted at a gdb breakpoint is silent. Silence is not proof of a crash — check status and the flash/reset results too.
- Never claim the firmware printed, booted, or crashed unless a log line here shows it.`

export const LOG_CONTRACT = {
  name: "log",
  label: "日志",
  description: LOG_DESCRIPTION,
  parameters: logParameters,
  guidelines: [
    "Never claim firmware booted, printed, or crashed without a log line proving it; use log wait rather than dumping the log.",
  ],
  // 与 bash / powershell 同一道门:command 源的命令位站着探针程序(openocd / JLink / …)就先问用户。
  // 串口与 TCP 源不问:开一个串口、连一个已经在跑的 gdb server,都碰不到探针。
  // rtt 源也不问:它起的 J-Link GDB server 带 -nohalt,只读 RTT,从不停核、复位、烧录(见 rtt.ts)。
  confirm: (input: LogInput) =>
    input.action === "start" && typeof input.command === "string" && probeCommandIn(input.command) !== undefined,
  summary: logSummary,
} as const satisfies ToolContract<typeof logParameters>

/** 卡片副标题 / 确认条那一行:动作 + 它作用的对象。参数可能还在流式拼,缺什么就少说什么。 */
export function logSummary(input: Partial<LogInput>): string {
  switch (input.action) {
    case "start": {
      if (input.port) return `start serial ${input.port.trim()} @ ${input.baud ?? DEFAULT_BAUD}`
      if (input.rtt) return `start rtt ${input.rtt.trim()}`
      if (input.tcp) return `start tcp ${input.tcp.trim()}`
      if (input.command) return `start ${input.command.trim()}`
      return "start"
    }
    case "wait":
      return input.pattern ? `wait /${input.pattern}/` : "wait"
    case "read":
      return input.pattern ? `read /${input.pattern}/` : "read"
    case "status":
    case "stop":
    case "ports":
      return input.action
    case "write":
      return `send ${input.encoding === "hex" ? "hex" : "text"}`
    default:
      return ""
  }
}

/**
 * STM32 订货号 = 器件名 + 封装字母 + 温度档(CubeMX 写 x)+ 可选尾巴(TR 卷带、Q 带 SMPS…)。
 * 器件名 = 系列 + 产品线 + "引脚数字母 + Flash 容量码"。**产品线的长度是定死的**,切点靠它而不是靠"第一个
 * 像封装 + 温度的地方":单字母系列(F/G/L/H/U/C/N)是一个数字加两位(G473、L4R5、G0B1、H7S7、N657),
 * W 系列(WB/WL/WBA)是系列名之后两位(WB55、WB5M、WLE5、WBA52)。
 * 从前用懒惰匹配找第一个成立的切点:H7R/H7S 的产品线是"字母 + 数字"(S7、R3)而容量码是数字 8,
 * `STM32H7S7L8` 被切成 `STM32H7S7`,J-Link 不认,整个系列的 RTT 都起不来(2026-09-25 审稿)。
 * 对不上这个形状的(`STM32H745ZI_M7`、已经是 J-Link 写法的、MP1)原样交出去。
 */
const STM32_ORDERING_CODE = /^(STM32(?:W[BL]A?[0-9A-Z]{2}|[A-Z][0-9][0-9A-Z]{2})[A-Z][0-9A-Z])[A-Z][0-9X][0-9A-Z]*$/

/**
 * 把用户 / 工程档案里的芯片名变成 J-Link 认的器件名。纯函数,菜单与厨房共用(界面可以拿它给 RTT 表单预填)。
 *
 * J-Link 对 STM32 只认到 Flash 容量码为止(`STM32G473RC`),而工程里能拿到的往往是 CubeMX 的
 * `Mcu.UserName=STM32G473RCTx` 或订货号 `STM32G473RCT6` —— 原样交给 J-Link 就是一句
 * "Failed to get index for device name",看起来像探针没接好。非 STM32 的名字(nRF52840_xxAA、ATSAMD21G18)
 * 原样返回:它们的写法各家不同,猜错比不猜更糟。CubeMX 的家族名(`STM32G473R(B-C-E)Tx`)说不出是哪一颗,拒掉。
 */
export function jlinkDeviceName(input: string): string {
  const name = input.trim()
  if (!name) throw new Error('rtt needs the J-Link device name of the target, e.g. rtt:"STM32G473RC"')
  if (/[()]/.test(name)) {
    throw new Error(
      `"${name}" is a CubeMX family name, not one chip — J-Link needs the exact part (e.g. STM32G473RC). Ask the user or read Mcu.UserName / Mcu.CPN in the .ioc.`,
    )
  }
  if (!/^STM32/i.test(name)) return name
  const upper = name.toUpperCase()
  const match = STM32_ORDERING_CODE.exec(upper)
  return match ? match[1]! : upper
}
