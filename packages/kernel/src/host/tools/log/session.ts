/**
 * log 工具的厨房那一半:一个会话级采集器(capture.ts)+ 六个对它发指令的动作。
 *
 * 一个工具实例 = 一个会话 = 一个日志源。采集器活在闭包里,不做全局注册表;会话关掉时 session-manager
 * 调 `dispose()` 把它收掉 —— 桌面内核是长驻进程,只靠进程退出收尸的话,会话关了串口还被占着,下一个
 * 会话 `log start port` 只会得到一句"busy",看起来像别的程序在占口。
 *
 * 与 attic 版不同的三处(同 flash):env 每次 execute 从 toolContext 拿(cwd 每轮重解析);中止走
 * context.abortSignal;日志目录直接 node:fs mkdir(这条路径本来就是本机的)。
 */

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { clamp, stamp } from "../../domain/engines.ts"
import { EXIT_WAIT_MS, LogCapture, type LogSource } from "./capture.ts"
import {
  DEFAULT_MAX_LINES,
  DEFAULT_WAIT_MS,
  LOG_CONTRACT,
  type LogAction,
  type LogDetails,
  type LogInput,
  MAX_WAIT_MS,
} from "./contract.ts"
import { formatElapsed, MAX_MAX_LINES, renderRow, renderRows, splitArgv } from "./excerpt.ts"
import {
  DEFAULT_BAUD,
  listSerialPorts,
  MAX_BAUD,
  MIN_BAUD,
  normalizeSerialPort,
  prepareSerial,
  serialArgv,
  serialPowershellExe,
  serialLabel,
  serialOpenConfirmMs,
} from "./serial.ts"

/** 流式推给 UI 的窗口(不进 transcript)。 */
const UPDATE_ROWS = 20
const UPDATE_CHARS = 4_000
/** 工具内的 tick 节流:只为省 previewRows 的计算,上屏的节拍由内核的 ToolProgressThrottle 管。 */
const UPDATE_THROTTLE_MS = 100

/** 装配面上的工具:比发动机的 AgentHarnessTool 多一个会话关闭时的收尾口。 */
export type LogTool = AgentHarnessTool<ExecutionToolContext, typeof LOG_CONTRACT.parameters, LogDetails> & {
  /** 会话关闭:停掉采集器、还回串口。没 start 过就是 no-op;绝不抛。 */
  dispose(): Promise<void>
}

/**
 * `host:port`,只给 port 时 host 是 localhost。冒号跟着 host 走:attic 那版把冒号写成可选,
 * 于是 "9090" 被贪婪匹配成 host "909" + port 0。
 */
export function parseTcpTarget(value: string): { host: string; port: number } {
  const m = /^(?:([A-Za-z0-9_.-]+):)?(\d+)$/.exec(value.trim())
  if (!m) throw new Error(`log start: could not parse tcp "${value}" — use "host:port", e.g. "localhost:19021"`)
  return { host: m[1] || "localhost", port: Number(m[2]) }
}

function logFileName(now = new Date()): string {
  return `hw-${stamp(now)}.log`
}

/**
 * 串口那条路的失败十有八九是"名字写成了别的样子"或者"口不在了",而 errno 本身指不出下一步动作。
 * 抛出去之前把这台机器上真实存在的口贴上 —— 否则模型会去查线。
 */
async function portHint(env: NodeJS.ProcessEnv): Promise<string> {
  const ports = await listSerialPorts(process.platform, env).catch(() => [])
  return ports.length > 0 ? ` — ports on this machine: ${ports.map((entry) => entry.path).join(", ")}` : ""
}

async function withPortHints<T>(run: () => T, env: NodeJS.ProcessEnv): Promise<T> {
  try {
    return run()
  } catch (error) {
    throw new Error(`log start: ${error instanceof Error ? error.message : String(error)}${await portHint(env)}`)
  }
}

function sourceState(capture: LogCapture): string {
  if (capture.running) return "running"
  // stop 等不到 'close' 硬收的场:有读进程逃出了进程组,别拿直接子进程的退出码冒充"干净退出"。
  if (capture.forcedEnd) return "stopped (exit not confirmed)"
  if (!capture.exited) return "not started"
  // TCP 没有退出码,"exited (code null)"只会让模型去猜进程语义。
  if (capture.source.kind === "tcp") return "disconnected"
  const { code, signal } = capture.exited
  return `exited (${signal ? `signal ${signal}` : `code ${code}`})`
}

/**
 * 每条结果的尾行。日志文件路径很长,只在模型可能需要 grep 时才给(有省略/有丢弃),
 * 否则每次调用白烧几十个 token。
 */
function footer(capture: LogCapture, needsFile: boolean): string {
  const dropped = capture.dropped > 0 ? ` | ${capture.dropped} dropped from the buffer` : ""
  const file = needsFile || capture.dropped > 0 ? ` | full log: ${capture.file}` : ""
  return `cursor: ${capture.cursor} | source: ${sourceState(capture)}${dropped}${file}`
}

export function createLogTool(): LogTool {
  let capture: LogCapture | undefined
  /** dispose 之后这个工具就没有会话了:排在队里、或正卡在 spawn 里的 start 一律拒掉并收掉自己起的源。 */
  let disposed = false

  /**
   * 这个工具的调用之间**串行**。发动机的 AgentHarness 不读工具上的 executionMode(那是老 agent-loop 的字段),
   * 同一条助手消息里的两个 log 调用是并行跑的 —— 两个 start 并行会各起一个采集器,只有后写进 `capture` 的
   * 那个还找得到,另一个握着串口活到内核退出;start + wait 并行则 wait 先跑到,抛 "no log capture"
   * (2026-09-14 审稿实测)。所以顺序在这里自己排:每次 execute 都排在上一次之后。
   */
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const requireCapture = (action: LogAction): LogCapture => {
    if (!capture) throw new Error(`no log capture — run \`log start\` (${action} needs a running source)`)
    return capture
  }

  const detailsOf = (action: LogAction, extra?: Partial<LogDetails>): LogDetails => ({
    action,
    running: capture?.running ?? false,
    cursor: capture?.cursor ?? 0,
    totalLines: capture?.totalLines ?? 0,
    dropped: capture?.dropped ?? 0,
    ...(capture ? { source: capture.label, file: capture.file } : {}),
    ...(capture?.exited ? { exitCode: capture.exited.code } : {}),
    ...extra,
  })

  return {
    name: LOG_CONTRACT.name,
    label: LOG_CONTRACT.label,
    description: LOG_CONTRACT.description,
    parameters: LOG_CONTRACT.parameters,
    // 只是给人看的意图声明:AgentHarness 不读它,真正的串行在上面的 serialize 里。
    executionMode: "sequential",
    async dispose() {
      // 不排队:closeEntry 先 stop 掉这一轮(wait 会被中止信号叫醒),这里直接收采集器就行;
      // 排队的话一条还没被中止的 wait 会把关会话拖住两分钟。正在 spawn 途中的 start 靠 disposed 旗兜住。
      disposed = true
      const active = capture
      if (!active) return
      await active.stop().catch(() => {})
    },
    execute: (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const env = executionEnvSnapshot(toolContext.env)
      return serialize(() => executeAction(params, onUpdate, toolContext.env.cwd, context.abortSignal, env))
    },
  }

  async function executeAction(
    params: LogInput,
    onUpdate: Parameters<LogTool["execute"]>[2],
    cwd: string,
    abortSignal: AbortSignal | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<AgentToolResult<LogDetails>> {
    {
      switch (params.action) {
        case "start": {
          if (disposed) throw new Error("log start: the session was closed")
          // running 按 'close' 判(见 capture.running):shell 退了、孙进程还握着管道的源仍算在采,
          // 不放第二个源进来 —— 否则旧采集器被顶掉却还活着,dispose 收不到它。
          if (capture?.running) {
            throw new Error(
              `already capturing ${capture.label} (${capture.totalLines} lines so far). Run \`log stop\` first.`,
            )
          }
          // 已经结束的旧采集器再 stop 一次是 no-op;这一句是保险,让"被顶掉的采集器还活着"永远不可能。
          if (capture) await capture.stop().catch(() => {})
          // 这一轮已经被用户停掉:一个源都别起。
          if (abortSignal?.aborted) throw new Error("log start was aborted")
          let source: LogSource
          let label: string
          /** 串口:留到最后一步再真开设备(见下面 prepareSerial 那一句)。 */
          let serial: { device: string; baud: number } | undefined
          // 三个源互斥。给了两个就是拿不准,而默默挑一个的代价是"它以为在读串口,其实在读 TCP",
          // 两边都长得像"板子没输出"。
          const sources = [params.port && "port", params.tcp && "tcp", params.command && "command"].filter(
            (name): name is string => typeof name === "string",
          )
          if (sources.length > 1) throw new Error(`log start: pass exactly one source, got ${sources.join(" + ")}`)
          if (params.port) {
            const device = await withPortHints(() => normalizeSerialPort(params.port!), env)
            serial = { device, baud: clamp(params.baud, DEFAULT_BAUD, MIN_BAUD, MAX_BAUD) }
            const baud = serial.baud
            // Windows 上这一步会因为找不到 PowerShell 5.1 而抛:与其余串口步骤同形,带 `log start:` 前缀与端口清单。
            source = {
              kind: "child",
              argv: await withPortHints(
                () => serialArgv(device, baud, process.platform, serialPowershellExe(undefined, env)),
                env,
              ),
            }
            label = serialLabel(device, serial.baud)
          } else if (params.command) {
            const argv = splitArgv(params.command)
            if (argv.length === 0) throw new Error("log start: command is empty")
            source = { kind: "child", argv }
            label = argv.join(" ")
          } else if (params.tcp) {
            const parsed = parseTcpTarget(params.tcp)
            source = { kind: "tcp", host: parsed.host, port: parsed.port }
            label = `tcp ${parsed.host}:${parsed.port}`
          } else {
            throw new Error('log start: pass exactly one source — port (serial), tcp ("host:port"), or command')
          }

          const file = path.join(cwd, ".yoma", "logs", logFileName())
          try {
            await mkdir(path.dirname(file), { recursive: true })
          } catch (error) {
            throw new Error(
              `could not create the log directory: ${error instanceof Error ? error.message : String(error)}`,
            )
          }

          // 串口在这里才真打开:前面任何一步抛错都不该留下一个开着的设备。
          // 拿到的 fd 立刻交给 LogCapture,从此由它负责关(见 LogSource 的 hold)。
          const opening = serial
          const hold = opening
            ? await withPortHints(() => prepareSerial(opening.device, opening.baud, process.platform, env), env)
            : undefined
          if (hold !== undefined && source.kind === "child") source = { ...source, hold }
          const started = new LogCapture(source, label, file, cwd, { env })
          try {
            await started.start()
          } catch (error) {
            // 起不来也要把串口还回去(fd 的所有权已在 LogCapture 手里,stop 会收)。
            await started.stop()
            throw error
          }
          // 有的系统上 spawn 成功并不代表口开成了(等多久由 serial.ts 说了算,它才认识平台)。
          // 真当场死了就把它自己那句话报出来 —— 否则模型拿着一句 "Capturing …" 去等一份永远不来的日志。
          const confirmMs = serial ? serialOpenConfirmMs() : 0
          if (confirmMs > 0) {
            await started.settle(confirmMs)
            if (started.exited) {
              const said = started.lines
                .map((line) => line.text)
                .join("; ")
                .trim()
              await started.stop()
              throw new Error(`log start: could not open ${label}${said ? `: ${said}` : ""}${await portHint(env)}`)
            }
          }

          // spawn 途中会话被关了(dispose 看到的 capture 还是 undefined):把自己起的源收掉,别让它活过会话。
          if (disposed) {
            await started.stop().catch(() => {})
            throw new Error("log start: the session was closed")
          }
          capture = started
          const text = `Capturing ${label}${started.pid ? ` (pid ${started.pid})` : ""}.
Full log: ${file}
Next: \`log wait\` with a pattern (e.g. "boot|fault|error") — it blocks until something matches instead of dumping the log.`
          return { content: [{ type: "text", text }], details: detailsOf("start") }
        }

        case "read": {
          const active = requireCapture("read")
          const maxLines = clamp(params.maxLines, DEFAULT_MAX_LINES, 1, MAX_MAX_LINES)
          const result = active.read({ since: params.since, pattern: params.pattern, maxLines })

          let header: string
          if (params.pattern) {
            header = `${result.matchedLines} of ${result.rawTotal} lines since seq ${result.from} match /${params.pattern}/`
            if (result.omittedLines > 0) header += ` — showing the newest, ${result.omittedLines} omitted`
          } else if (result.rawTotal === 0) {
            header = `no new lines since seq ${result.from}`
          } else {
            header = `+${result.rawTotal} new lines since seq ${result.from}`
            const notes: string[] = []
            if (result.groups !== result.rawTotal) notes.push(`folded to ${result.groups} groups`)
            if (result.omittedLines > 0) notes.push(`${result.omittedLines} lines omitted from this excerpt`)
            if (notes.length > 0) header += ` (${notes.join("; ")})`
          }
          const lost =
            result.lost > 0
              ? `\n${result.lost} older lines already fell out of the buffer — grep the log file for them.`
              : ""
          const body = result.text ? `\n\n${result.text}\n` : "\n"
          const needsFile = result.omittedLines > 0 || result.lost > 0
          return {
            content: [{ type: "text", text: `${header}${lost}${body}\n${footer(active, needsFile)}` }],
            details: detailsOf("read"),
          }
        }

        case "wait": {
          const active = requireCapture("wait")
          if (!params.pattern) throw new Error("log wait requires pattern (a regex to wait for)")
          const timeoutMs = clamp(params.timeoutMs, DEFAULT_WAIT_MS, 100, MAX_WAIT_MS)

          // 等待期间把新行流式推给 UI(不进 transcript)—— 这就是"日志窗口"。
          // 没有行就不发:内核只丢 content 为空的快照,一条空文本会白花节流器的前沿。
          let lastUpdate = 0
          const tick = () => {
            const now = Date.now()
            if (now - lastUpdate < UPDATE_THROTTLE_MS) return
            lastUpdate = now
            const rows = active.previewRows(Math.max(0, active.nextSeq - UPDATE_ROWS), UPDATE_ROWS, UPDATE_CHARS)
            if (rows.length === 0) return
            onUpdate({ content: [{ type: "text", text: renderRows(rows) }], details: detailsOf("wait") })
          }
          tick()

          const outcome = await active.wait({ pattern: params.pattern, timeoutMs, signal: abortSignal, onTick: tick })
          const body = outcome.rows.length > 0 ? `\n\n${renderRows(outcome.rows)}\n` : "\n"
          let header: string
          switch (outcome.kind) {
            case "matched": {
              header = `matched /${params.pattern}/ at seq ${outcome.line!.seq} (${formatElapsed(outcome.line!.t)}s)`
              if (outcome.skippedBefore! > 0) {
                header += `\n${outcome.skippedBefore} earlier unread lines were skipped — \`log read since=${outcome.resumeFrom}\` or grep the log file for them.`
              }
              break
            }
            case "exited":
              header =
                `source ${sourceState(active)} before /${params.pattern}/ matched ` +
                `(${outcome.newLines} new lines; cursor unchanged, \`log read\` for all of them)`
              break
            case "aborted":
              header = `aborted while waiting for /${params.pattern}/ (cursor unchanged)`
              break
            default:
              header =
                `timed out after ${timeoutMs} ms without matching /${params.pattern}/ ` +
                `(${outcome.newLines} new lines; cursor unchanged, \`log read\` for all of them). ` +
                `The target may be halted, silent, or not writing to this source.`
          }
          const needsFile = outcome.kind !== "matched" || (outcome.skippedBefore ?? 0) > 0
          return {
            content: [{ type: "text", text: `${header}${body}\n${footer(active, needsFile)}` }],
            details: detailsOf("wait", { matched: outcome.kind === "matched" }),
          }
        }

        case "status": {
          const active = requireCapture("status")
          const uptime = ((active.endedAt ?? Date.now()) - active.startedAt) / 1000
          const last = active.lines[active.lines.length - 1]
          const unread = active.nextSeq - active.cursor
          const text = [
            `source: ${sourceState(active)}${active.pid ? ` (pid ${active.pid})` : ""} — ${active.label}`,
            `${active.totalLines} lines in ${uptime.toFixed(1)}s | ${active.lines.length} buffered | ${active.dropped} dropped | ${unread} unread`,
            last
              ? `last line: ${renderRow({ type: "line", row: { line: last, count: 1, lastT: last.t } })}`
              : "no output yet",
            footer(active, true),
          ].join("\n")
          return { content: [{ type: "text", text }], details: detailsOf("status") }
        }

        case "stop": {
          const active = requireCapture("stop")
          await active.stop()
          const uptime = ((active.endedAt ?? Date.now()) - active.startedAt) / 1000
          // 没能确认退出就别说"停了"—— 模型据此判断串口是否已经放开。按 forcedEnd 判而不是 exited:
          // `sh -c "reader &"` 的 shell 早就退了(exited 有值),真正握着设备的孙进程可能逃出了进程组。
          const survived = active.forcedEnd
            ? `\n⚠️ the source did not confirm exit within ${EXIT_WAIT_MS} ms; the process tree was killed, but a reader that escaped it may still hold the device. Verify the device is free before opening it again.`
            : ""
          const text =
            `stopped ${active.label} after ${uptime.toFixed(1)}s and ${active.totalLines} lines.${survived}\n` +
            `Full log: ${active.file}`
          return { content: [{ type: "text", text }], details: detailsOf("stop") }
        }

        case "ports": {
          const ports = await listSerialPorts(process.platform, env)
          if (ports.length === 0) {
            const text =
              `no serial ports on this machine (${process.platform}). ` +
              `Plug the board in — if it is already plugged in, the USB-serial driver did not enumerate it, which is a host problem, not a firmware one.`
            return { content: [{ type: "text", text }], details: detailsOf("ports") }
          }
          const text = [
            `${ports.length} serial port${ports.length > 1 ? "s" : ""}:`,
            ...ports.map((entry) => `  ${entry.path}${entry.description ? `   ${entry.description}` : ""}`),
            "",
            // 不替模型挑口:第一个未必是板子(Windows 上常常是主板自带的 COM1,它能打开、但永远不吐字节 ——
            // 于是 wait 超时,看起来像固件哑了)。
            `Then: \`log start\` with the port that is your board, plus the firmware's baud rate.`,
          ].join("\n")
          return { content: [{ type: "text", text }], details: detailsOf("ports") }
        }
      }
    }
  }
}
