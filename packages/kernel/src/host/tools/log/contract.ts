/**
 * log 工具的契约:菜单那一半。
 *
 * 把板子的运行日志接进会话 —— UART 串口、TCP 流(gdb server 的 RTT/telnet 口),或者任意往 stdout
 * 吐日志的命令。六个动作(start/read/wait/status/stop/ports)合成一个工具:日志源是长驻、有状态的,
 * 与一次性 spawn 的引擎工具正相反,所以厨房那半(session.ts)持有一个会话级采集器,五个动作只是对它
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

export const LOG_ACTIONS = ["start", "read", "wait", "status", "stop", "ports"] as const
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
    ],
    { description: "start | read | wait | status | stop | ports" },
  ),
  tcp: Type.Optional(
    Type.String({
      description:
        'start from a TCP log/RTT stream: "host:port" — e.g. "localhost:19021" (J-Link GDBServer serves RTT there) or the port you opened with OpenOCD\'s "rtt server start". The gdb server holds the probe; this only reads the stream.',
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
  since: Type.Optional(Type.Number({ description: "read: start from this cursor instead of the last one." })),
  maxLines: Type.Optional(Type.Number({ description: `read: max lines to show (default ${DEFAULT_MAX_LINES}).` })),
})

export type LogInput = Static<typeof logParameters>

export interface LogDetails {
  action: LogAction
  running: boolean
  cursor: number
  totalLines: number
  dropped: number
  /** 采集着什么:`serial /dev/… @ 115200 8N1` / `tcp host:port` / 命令行。没 start 过就没有。 */
  source?: string
  file?: string
  /** wait 专有:是否命中。 */
  matched?: boolean
  exitCode?: number | null
}

const LOG_DESCRIPTION = `Captures the running board's log output — a UART/USB serial port, a TCP stream (RTT from your gdb server), or any command that prints to stdout — so you can see what the firmware actually did instead of guessing from the source.

Actions:
- start (port, tcp, or command): begin capturing. Exactly one source:
  - UART / USB serial: port (plus baud, default ${DEFAULT_BAUD}; 8N1, no flow control). Same call on macOS, Linux and Windows — the port name is the only difference. Run ports first if you do not know it.
  - RTT / any TCP log stream: tcp "host:port". RTT comes from the gdb server that is already holding the probe: J-Link GDBServer serves it on telnet port 19021 automatically; with OpenOCD run \`monitor rtt setup <addr> <size> "SEGGER RTT"\`, \`monitor rtt start\`, \`monitor rtt server start <port> 0\`, then read that port here.
  - Anything else: command — an argv line (a decoder script, a vendor CLI, …); no shell unless you spawn one yourself.
- ports: list the serial ports on this machine, with the OS's own description where it has one. Opens nothing, takes nothing — safe to call any time, including while a capture is running.
- wait (pattern, [timeoutMs]): block until a new line matches the regex, the source exits, or the timeout expires. THIS IS THE MAIN ACTION — one call turns "did it boot / did it crash" into a definite answer and returns only the matched line plus a few lines of context. A wait that does not match leaves the cursor untouched, so nothing is lost: follow it with read.
- read ([since], [pattern], [maxLines]): the tail of whatever arrived since the last read, then advances the cursor. With pattern it only shows matching lines and does not move the cursor (it is a query, not a consumption).
- status: whether the source is still running, how many lines were captured, where the full log file is.
- stop: end the capture, releasing the serial port (a TCP capture just disconnects). The log file stays. The capture also ends when the session is closed.

Rules:
- Every line is written to a log file under .yoma/logs; this tool only ever returns a bounded excerpt (tail, folded repeats, "N lines omitted"). To search history, grep the log file path it reports — do not ask this tool for a bigger excerpt.
- Repeated lines are folded ("×137"); lines that differ only in numbers fold too, showing the first and the last of the run. Exact values are in the log file.
- Prefer wait over read: read costs tokens and gives you a wall of text, wait costs one call and gives you a conclusion.
- This tool never holds the debug probe: a tcp capture reads from the gdb server, which owns the probe — stopping that server ends the stream (source shows "disconnected"). A serial port IS exclusive, but only macOS and Windows enforce it — on Linux a second reader silently splits the byte stream with the first. A successful start is not proof that nothing else is on the port. Flashing over SWD while the serial capture runs is fine (the VCP is a separate USB interface); a reset by the flasher simply shows up in the log.
- Serial gives you the bytes the firmware sends, nothing else: a wrong baud looks like garbage, and a firmware that speaks a binary protocol looks like garbage too. For those, run a decoder that opens the port itself as a command source. The log file holds the same sanitized text you see here, not the raw bytes.
- RTT only produces output while the target is running and only if the firmware writes to it. Silence is not proof of a crash — check status and the flash/reset results too.
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
  confirm: (input: LogInput) =>
    input.action === "start" && typeof input.command === "string" && probeCommandIn(input.command) !== undefined,
  summary: logSummary,
} as const satisfies ToolContract<typeof logParameters>

/** 卡片副标题 / 确认条那一行:动作 + 它作用的对象。参数可能还在流式拼,缺什么就少说什么。 */
export function logSummary(input: Partial<LogInput>): string {
  switch (input.action) {
    case "start": {
      if (input.port) return `start serial ${input.port.trim()} @ ${input.baud ?? DEFAULT_BAUD}`
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
    default:
      return ""
  }
}
