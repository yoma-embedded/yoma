import { createInterface } from "node:readline"
import { stripVTControlCharacters } from "node:util"
import type { EventEmitter } from "node:events"
import type { Readable, Writable } from "node:stream"
import type { AgentHarnessEvent, AgentMessage, AgentToolResult } from "@yoma/agent"
import { CLI_HELP } from "./args.ts"
import type { CliOutcome, CliSession } from "./session.ts"

export interface CliIO {
  input: Readable
  output: Writable
  error: Writable
  terminal: boolean
  signals: Pick<EventEmitter, "on" | "off">
}

/** 工具输出和模型文本不是终端控制指令；特别不能执行 OSC 剪贴板序列。 */
export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex -- 故意过滤控制字符，仅保留换行和 tab。
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}

export function messageText(message: AgentMessage): string {
  if (!("content" in message)) return ""
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

/** stdout 只写助手正文；工具进度、状态与错误去 stderr，便于 -p 重定向。 */
export function createCliOutput(io: Pick<CliIO, "output" | "error">) {
  let streamed = ""
  let thinking = false
  const info = (text: string) => {
    io.error.write(`${terminalText(text)}\n`)
  }
  return {
    info,
    event(event: AgentHarnessEvent) {
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamed = ""
        thinking = false
      }
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent
        if (delta.type === "text_delta") {
          streamed += delta.delta
          io.output.write(terminalText(delta.delta))
        }
        if (delta.type === "thinking_delta" && !thinking) {
          thinking = true
          info("[思考中]")
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = messageText(event.message)
        // provider 可能只发终态而没有 text_delta；仍然显示回答。
        if (text.startsWith(streamed)) io.output.write(terminalText(text.slice(streamed.length)))
        else if (!streamed) io.output.write(terminalText(text))
        if (text || streamed) io.output.write("\n")
      }
      if (event.type === "tool_execution_start") {
        info(`→ ${event.toolName} ${JSON.stringify(event.args).slice(0, 240)}`)
      }
      if (event.type === "tool_execution_end") {
        const result: AgentToolResult<unknown> = event.result
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        info(
          `← ${event.toolName} ${event.isError ? "失败" : "完成"}${text ? `\n${text.slice(0, 1200)}${text.length > 1200 ? "\n[显示已截断；完整工具结果在会话文件中]" : ""}` : ""}`,
        )
      }
    },
    outcome(result: CliOutcome): number {
      if (result.status === "aborted") {
        info("[已停止]")
        return 130
      }
      if (result.status === "failed") {
        info(`[失败] ${result.error}`)
        return 1
      }
      return 0
    },
  }
}

export type CliOutput = ReturnType<typeof createCliOutput>

/** 逐行 REPL，不是第二个调度器：忙时拒绝新任务，停止/退出仍即时可用。 */
export async function runInteractive(
  session: CliSession,
  io: CliIO,
  output: CliOutput,
  initialPrompt = "",
): Promise<void> {
  const reader = createInterface({ input: io.input, output: io.error, terminal: io.terminal, crlfDelay: Infinity })
  reader.setPrompt("你 > ")
  let active: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let done!: () => void
  const finished = new Promise<void>((resolve) => {
    done = resolve
  })
  const report = (error: unknown) => output.info(`[错误] ${error instanceof Error ? error.message : String(error)}`)
  const prompt = () => {
    if (!stopping && !active) reader.prompt()
  }

  function stop() {
    if (stopping) return
    stopping = (async () => {
      try {
        await session.close()
      } catch (error) {
        report(error)
      }
      await active
      reader.close()
      done()
    })()
  }
  function interrupt() {
    if (active) {
      output.info("[正在停止…]")
      void session.abort().catch(report)
    } else stop()
  }
  async function execute(line: string) {
    if (!line.startsWith("/")) {
      output.outcome(await session.prompt(line))
      return
    }
    const match = /^(\S+)\s*([\s\S]*)$/.exec(line)!
    const [, command, argument] = match
    switch (command) {
      case "/help":
        output.info(CLI_HELP)
        break
      case "/status":
        output.info(session.status())
        break
      case "/models":
        output.info(session.models().join("\n"))
        break
      case "/model":
        if (argument) output.outcome(await session.setModel(argument))
        output.info(session.status())
        break
      case "/thinking":
        if (argument) output.outcome(await session.setThinking(argument))
        output.info(session.status())
        break
      case "/history":
        for (const message of await session.messages()) {
          if (message.role !== "user" && message.role !== "assistant") continue
          const text = messageText(message)
          if (text) output.info(`${message.role === "user" ? "你" : "agent"} > ${text}`)
        }
        break
      case "/compact":
        output.info("[压缩中]")
        if (output.outcome(await session.compact(argument || undefined)) === 0) output.info("[压缩完成]")
        break
      case "/retry":
        output.outcome(await session.retry())
        break
      default:
        throw new Error(`未知命令 ${command}；输入 /help 查看命令`)
    }
  }
  function submit(raw: string) {
    if (stopping) return
    const line = raw.trim()
    if (line === "/quit") {
      stop()
      return
    }
    if (line === "/abort") {
      void session.abort().catch(report)
      prompt()
      return
    }
    if (active) {
      output.info("正在执行；用 /abort 或 Ctrl+C 停止，待本轮结束后再输入。")
      return
    }
    if (!line) {
      prompt()
      return
    }
    active = execute(line)
      .catch(report)
      .finally(() => {
        active = undefined
        prompt()
      })
  }
  reader.on("line", submit)
  reader.on("SIGINT", interrupt)
  reader.on("close", stop)
  reader.on("error", (error) => {
    report(error)
    stop()
  })
  io.signals.on("SIGINT", interrupt)
  io.signals.on("SIGTERM", stop)
  try {
    if (initialPrompt.trim()) submit(initialPrompt)
    else prompt()
    await finished
  } finally {
    io.signals.off("SIGINT", interrupt)
    io.signals.off("SIGTERM", stop)
    reader.removeListener("line", submit)
    reader.close()
  }
}
