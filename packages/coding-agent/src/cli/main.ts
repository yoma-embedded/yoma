import { parseCliArgs, CLI_HELP } from "./args.ts"
import { openCliSession, type CliSessionDependencies } from "./session.ts"
import { createCliOutput, runInteractive, type CliIO } from "./terminal.ts"

/** 可注入假模型和流；生产与离线端到端测试共用同一个入口。 */
export async function runCli(args: string[], io: CliIO, dependencies: CliSessionDependencies = {}): Promise<number> {
  const options = parseCliArgs(args)
  if (options.help) {
    io.output.write(CLI_HELP)
    return 0
  }
  if (!options.print && !io.terminal) throw new Error('非交互输入请使用 -p，例如：bun run cli -p "检查工程"')
  let prompt = options.prompt
  if (options.print && !io.terminal) {
    // 一次解码完整 stdin，不能逐 Buffer.toString() 劈断中文字符。
    const chunks: Buffer[] = []
    for await (const chunk of io.input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    prompt = [prompt, Buffer.concat(chunks).toString("utf8")].filter(Boolean).join("\n\n")
  }
  if (options.print && !prompt.trim()) throw new Error("-p 需要提示词或非空 stdin")
  const output = createCliOutput(io)
  const session = await openCliSession(options, {
    ...dependencies,
    onDiagnostic: (message) => {
      output.info(message)
      dependencies.onDiagnostic?.(message)
    },
    onEvent: (event) => {
      output.event(event)
      dependencies.onEvent?.(event)
    },
  })
  try {
    output.info(session.status())
    output.info("当前 CLI：四个编码工具；手动 /compact、/retry；历史恢复不自动重跑工具。")
    if (!options.print) {
      output.info("输入 /help 查看命令；Ctrl+C 忙时停止、空闲时退出。")
      await runInteractive(session, io, output, prompt)
      return 0
    }
    let signalExit: number | undefined
    const stop = (code: number) => {
      signalExit ??= code
      void session.abort().catch((error: unknown) => output.info(String(error)))
    }
    const interrupt = () => stop(130)
    const terminate = () => stop(143)
    io.signals.on("SIGINT", interrupt)
    io.signals.on("SIGTERM", terminate)
    try {
      const result = await session.prompt(prompt)
      const code = output.outcome(result)
      return signalExit ?? code
    } finally {
      io.signals.off("SIGINT", interrupt)
      io.signals.off("SIGTERM", terminate)
    }
  } finally {
    await session.close()
  }
}
