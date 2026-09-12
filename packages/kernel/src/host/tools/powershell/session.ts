/**
 * powershell 工具的厨房那一半:自己组 argv,交 runEngine 跑。
 *
 * 为什么不复用内核 bash 那条路(env.exec):ExecutionEnv 的 shell 由构造参数定死
 * (NodeExecutionEnv 的 shellPath),ShellExecOptions 里没有 shell/argv 字段 —— 把 pwsh 塞进
 * shellPath 会得到 `pwsh -c <命令串>`:丢掉 -NoProfile / -NonInteractive / -EncodedCommand,
 * 而且会把同一个会话里**所有 bash 调用**一起改掉(工具拿到的是同一个 env 实例)。
 * 代价是丢掉 bash 那条流式 + 溢出文件 + 崩溃 checkpoint 的链路:这里是 runEngine 全量收完
 * 再 truncateTail,截断时自己落一个临时文件。
 *
 * 三道编码钉子,少一道就会得到"看起来像脚本写坏了"的乱码:
 * 1. `-EncodedCommand`(UTF-16LE base64):脚本里的引号、分号、反斜杠一律不参与命令行解析,
 *    也绕开了 Windows 命令行那层代码页。
 * 2. 脚本第一行 `$ProgressPreference='SilentlyContinue'`:PowerShell 5.1 一发现 stderr 被重定向,
 *    就把进度记录序列化成 `#< CLIXML` 写 stderr(attic/tools/serial.ts 的真机实测:482B→100B,
 *    `-OutputFormat Text` 无效)。它必须在用户脚本之前执行,所以是第一行而不是一个 argv 开关。
 * 3. 脚本第二行 `[Console]::OutputEncoding = UTF8`:runEngine 按 UTF-8 解 stdout,而 5.1 默认按
 *    控制台代码页写。包在 try 里 —— 没有控制台(服务里、重定向到管道)时这一句会抛,而它只是
 *    锦上添花,不该让整段脚本死掉。
 *
 * 第 2 条仍不足以保证 stderr 干净(模块自动加载等动作在我们那一行生效前就可能吐过一块),
 * 所以工具层还要剥一遍 CLIXML:那段 XML 不是噪声而是**假证据** —— 模型会把它当成脚本的输出读。
 */

import { accessSync, constants, existsSync, statSync } from "node:fs"
import path from "node:path"

import {
  type AgentHarnessTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExecutionToolContext,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-agent-core"

import { assertEngineSettled, clamp, runEngine } from "../../domain/engines.ts"
import { POWERSHELL_CONTRACT, type PowerShellDetails } from "./contract.ts"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

/** 非 Windows 上没装 PowerShell 7 时 execute 抛的那句;清单恒定,"装没装"是运行期的事。 */
export const POWERSHELL_MISSING = "PowerShell is not installed on this machine; use bash instead."

export const PS_NO_PROGRESS = "$ProgressPreference = 'SilentlyContinue'"
export const PS_UTF8_OUTPUT = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}"

/**
 * 固定开关。-NonInteractive 是承重的:交互提示(凭据框、`Read-Host`、确认)在没有 tty 的子进程里
 * 会一直等下去,而那次失败长成"超时",看不出是在等人输入。-ExecutionPolicy Bypass 只作用于这一个
 * 进程,不改机器的策略 —— 模型写的是临时脚本,没有签名。
 */
export const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] as const

/**
 * 编码后的脚本长度上限。Windows 的命令行总长约 32k 字符,超了的症状是 spawn 直接失败或者脚本
 * 被截断后以一个语法错误收场 —— 两种都看不出是"命令太长"。提前拒,并告诉模型出路。
 */
export const MAX_ENCODED_COMMAND_CHARS = 30_000

/** 在 PATH 上找一个可执行文件。engineBin 那套只认 engines/bin,PowerShell 不是我们装的。 */
export function findOnPath(name: string, pathEnv: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    // 只认可执行的普通文件:PATH 上一个叫 pwsh 的目录会让 spawn 报 "failed to run",而不是那句模型能照着做的"没装"。
    if (!isExecutableFile(candidate)) continue
    return candidate
  }
  return undefined
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== "win32") accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 PowerShell 可执行文件;找不到返回 undefined(由 execute 抛那句"没装")。
 *
 * Windows 上先用绝对路径找自带的 5.1,而不是靠 PATH:PATH 上的 powershell 可能被别的东西顶掉,
 * 而"问机器状态"那些路(Get-PnpDevice / System.IO.Ports / WMI)恰恰只有 inbox 5.1 一定有。
 * 非 Windows 只认 pwsh(PowerShell 7 跨平台),装了就用。
 */
export function powershellExe(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (process.platform !== "win32") return findOnPath("pwsh")
  const inbox = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  if (existsSync(inbox)) return inbox
  return findOnPath("powershell.exe") ?? findOnPath("pwsh.exe")
}

/** 真正跑的脚本:两行头 + 模型给的命令。顺序是契约,测试按"第一行/第二行"钉它。 */
export function powershellScript(command: string): string {
  return `${PS_NO_PROGRESS}\n${PS_UTF8_OUTPUT}\n${command}`
}

/** 完整 argv(不含可执行文件);超长在这里拒,调用方不必自己数长度。 */
export function powershellArgv(command: string): string[] {
  const encoded = Buffer.from(powershellScript(command), "utf16le").toString("base64")
  if (encoded.length > MAX_ENCODED_COMMAND_CHARS) {
    throw new Error("powershell: command too long — write it to a .ps1 file and run that with -File")
  }
  return [...POWERSHELL_FLAGS, "-EncodedCommand", encoded]
}

/**
 * 把 stderr 上的 CLIXML 块**解码**成人能读的文本,而不是整块删掉。
 *
 * PS 5.1 在 stderr 被重定向时,把进度记录**和错误记录**都序列化进同一个 `<Objs…</Objs>`:
 * Write-Error 是非终止错误、退出码 0,整块删掉就是"(no output)",模型认定成功 —— 2026-09-12 审稿实测。
 * 所以只丢进度,把 `<S S="Error">…</S>` 里的文本取出来(_x000D__x000A_ 还原成换行,XML 实体反转义)。
 * 只处理"标记行 + 紧跟其后的一整段",不剥到文末:块外还有脚本真正的报错;块没写完就被杀掉时只掉标记行。
 */
export function stripClixml(text: string): string {
  return text.replace(/#< CLIXML\r?\n?(<Objs\b[\s\S]*?<\/Objs>\r?\n?)?/g, (_whole, block: string | undefined) => {
    if (!block) return ""
    const messages: string[] = []
    for (const match of block.matchAll(/<S S="(?:Error|error|Warning|warning)">([\s\S]*?)<\/S>/g)) {
      const decoded = decodeClixmlText(match[1] ?? "").replace(/\s+$/, "")
      if (decoded) messages.push(decoded)
    }
    return messages.length > 0 ? `${messages.join("\n")}\n` : ""
  })
}

function decodeClixmlText(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/** 尾部空白收掉再合流:PowerShell 的每段输出都爱带一个收尾换行,两段拼起来就多一个空行。 */
function mergeOutput(stdout: string, stderr: string): string {
  return [stdout, stripClixml(stderr)]
    .map((part) => part.replace(/\s+$/, ""))
    .filter(Boolean)
    .join("\n")
}

export function createPowerShellTool(
  options: { enginesDir?: string; exe?: string } = {},
): AgentHarnessTool<ExecutionToolContext, typeof POWERSHELL_CONTRACT.parameters, PowerShellDetails> {
  // enginesDir 只为和别的工具同形(登记者统一传):PowerShell 不是我们打包的发动机,它在系统里。
  return {
    name: POWERSHELL_CONTRACT.name,
    label: POWERSHELL_CONTRACT.label,
    description: POWERSHELL_CONTRACT.description,
    parameters: POWERSHELL_CONTRACT.parameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const env = toolContext.env
      // 这一轮已经被用户停掉:不要再起一个进程。runEngine 要到 spawn 之后才看信号。
      if (context.abortSignal?.aborted) throw new Error("powershell was aborted")
      const exe = powershellExe(options.exe)
      if (!exe) throw new Error(POWERSHELL_MISSING)
      const argv = powershellArgv(params.command)

      const result = await runEngine(exe, argv, {
        cwd: env.cwd,
        signal: context.abortSignal,
        timeoutMs: clamp(
          params.timeout === undefined ? undefined : params.timeout * 1000,
          DEFAULT_TIMEOUT_MS,
          MIN_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
        ),
      })
      // 超时/中断先抛(文本带 "timed out" / "was aborted");非零退出的策略在下面,与内核 bash 一致。
      assertEngineSettled(result, "powershell")

      const raw = mergeOutput(result.stdout, result.stderr)
      const truncation = truncateTail(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
      let text = truncation.content
      const details: PowerShellDetails = { exitCode: result.exitCode }
      if (truncation.truncated) {
        // 逐格拷:TruncationResult 里还带着 content,整份塞进 details 等于同一段文本跨进程传两遍。
        details.truncation = {
          truncated: truncation.truncated,
          truncatedBy: truncation.truncatedBy,
          totalLines: truncation.totalLines,
          totalBytes: truncation.totalBytes,
          outputLines: truncation.outputLines,
          outputBytes: truncation.outputBytes,
        }
        // 全文落临时文件:被截掉的往往正是最前面那条真报错,只给尾巴等于让模型看不见根因。
        // 落盘失败不算这次调用失败(没权限、磁盘满),只是少一个路径。
        const spilled = await env.createTempFile({ prefix: "yoma-powershell-", suffix: ".log" }, context)
        let fullOutputPath: string | undefined
        if (spilled.ok) {
          const written = await env.writeFile(spilled.value, raw, context)
          if (written.ok) fullOutputPath = spilled.value
        }
        if (fullOutputPath) details.fullOutputPath = fullOutputPath
        text += `\n\n[${truncationNotice(truncation, fullOutputPath)}]`
      }
      if (result.exitCode !== 0) {
        // exitCode 为 null = 被信号杀掉而两面旗(超时 / 中止)都没举:别报成 "code null"。
        const why = result.exitCode === null ? "Command was killed by a signal" : `Command exited with code ${result.exitCode}`
        throw new Error(`${text ? `${text}\n\n` : ""}${why}`)
      }
      return { content: [{ type: "text", text: text || "(no output)" }], details }
    },
  }
}

/** 截断通知,形状照内核 bash(harness/tools/bash.ts):三种截法各有各的话。 */
function truncationNotice(truncation: ReturnType<typeof truncateTail>, fullOutputPath: string | undefined): string {
  const endLine = truncation.totalLines
  const startLine = truncation.totalLines - truncation.outputLines + 1
  const full = fullOutputPath ? `. Full output: ${fullOutputPath}` : ""
  if (truncation.lastLinePartial) {
    return `Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}${full}`
  }
  if (truncation.truncatedBy === "lines") {
    return `Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${full}`
  }
  return `Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${full}`
}
