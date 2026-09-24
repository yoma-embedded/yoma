/**
 * powershell 工具的契约:菜单那一半。
 *
 * 为什么要有这个工具:Windows 上没有 stty、没有正经的 shell 内建,而每台 Win10/11 自带
 * Windows PowerShell 5.1(`Get-PnpDevice`、`System.IO.Ports`、WMI 这些"问机器状态"的路只有它有)。
 * bash 工具在 Windows 上要么没有,要么是 Git Bash ——它看不见 COM 口也看不见驱动。
 *
 * 为什么在**所有平台**都登记:TOOL_NAMES 与装配面被四处 diffToolNames 逐字同序钉着(单测、
 * desktop 自检、kernel-smoke 比对构建产物、bench check),按平台增删工具会让 macOS/Linux 上那四处
 * 直接红。于是清单恒定,"这台机器没装"是**运行期**的事:execute 抛
 * "PowerShell is not installed on this machine; use bash instead."。
 *
 * 门规同 flash(boundary.test.ts 第 3、5 条):这个文件只许 import typebox 与工具目录内的相对路径。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"
import { probeCommandIn } from "../flash/contract.ts"

const powershellParameters = Type.Object({
  command: Type.String({ description: "PowerShell command or script to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (default 120, clamped to 1-600). The process tree is killed on timeout.",
    }),
  ),
})

export type PowerShellInput = Static<typeof powershellParameters>

/**
 * 截断账单。为什么自己写一份而不是 import 内核的 TruncationResult:契约门只许 import typebox,
 * 而那个类型住在 `@earendil-works/pi-agent-core` —— Node 侧的包一旦被契约牵进来,餐厅就打不开了
 * (boundary.test.ts 第 5 条机器执行)。字段是 TruncationResult 的子集,所以 session.ts 可以
 * 直接把真账单赋过来;**故意少了 content** —— details 跨进程后原样成为卡片 metadata,再带一份
 * 正文等于把输出传两遍。
 */
export interface OutputTruncation {
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
}

export interface PowerShellDetails {
  /** 被信号杀掉时是 null(runEngine 的 EngineRunResult 就这么定义)。 */
  exitCode: number | null
  truncation?: OutputTruncation
  /** 截断时全文落的那个临时文件;卡片和尾部通知给的是同一个路径。 */
  fullOutputPath?: string
}

const POWERSHELL_DESCRIPTION = `Execute a PowerShell command in the current working directory. Returns stdout and stderr combined. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); when that happens the full output is written to a temp file and its path is appended. A non-zero exit is reported as an error, with the output attached.

- Windows-only in practice. On Windows this runs the inbox Windows PowerShell 5.1 (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe) by absolute path. On macOS and Linux it runs pwsh when PowerShell 7 happens to be installed, and otherwise fails telling you to use bash — so use bash there.
- The script is passed verbatim as a single -Command argument, so its quotes, semicolons and backslashes arrive intact. Before it runs, the working directory is set using -LiteralPath, progress records are suppressed, and both console output and native-program stdin use UTF-8.
- Windows PowerShell reconstructs its module search path at startup; it does not inherit a PowerShell 7 PSModulePath from the parent process. To use a custom module folder, add it to $env:PSModulePath inside this script or import its manifest by full path.
- Native programs still receive arguments through PowerShell 5.1's legacy quoting rules: a path containing spaces and ending in a backslash can lose that backslash. Prefer forward slashes or a trailing \\. for directory arguments; use a file for complex payloads containing embedded quotes.
- Use -LiteralPath for file operations and explicit -Encoding UTF8 for text files. PowerShell 5.1 needs UTF-8 with BOM for .ps1 files containing non-ASCII text. Scripts above ~30000 characters are rejected: save a .ps1 file with that encoding and invoke it with & 'path.ps1'.
- Cmdlet non-terminating errors do not necessarily produce a non-zero exit: set $ErrorActionPreference='Stop' when required. For a native program, check $LASTEXITCODE immediately and use exit $LASTEXITCODE to preserve its code; later successful commands can otherwise mask failure.
- GUI executables may return control before finishing when invoked with &: use Start-Process -Wait -PassThru -WindowStyle Hidden, then inspect the returned process's ExitCode. For a working directory containing brackets, pass -WorkingDirectory ([WildcardPattern]::Escape((Get-Location).Path)); use a redirection destination without brackets. Prefer command-line versions of build/debug tools.
- Each call is its own process. cd, $env: assignments and imported modules do not survive into the next call; put everything one task needs into a single script.
- Use the flash tool, never powershell, for commands that touch the debug probe.`

export const POWERSHELL_CONTRACT = {
  name: "powershell",
  label: "PowerShell",
  description: POWERSHELL_DESCRIPTION,
  parameters: powershellParameters,
  guidelines: [
    "Use powershell only on Windows; on macOS and Linux use bash.",
    // 分工照 CC 的 PowerShell 工具说明(git / npm / docker / cmdlet,不做文件操作):模型写 POSIX 命令更熟,5.1 又缺 && / ||、
    // 默认 UTF-16 写文件;真正要 PowerShell 的是 Windows 专属的那些事。
    "On Windows, run general commands with bash and use powershell for Windows-specific work (registry, services, network ports, devices, serial ports, .NET APIs). Neither is for reading or searching files: use read, grep, find and ls.",
    "Each powershell call is a fresh process — cd, $env: changes and imported modules do not carry over to the next call.",
  ],
  // 与 flash 同一道门:脚本里的命令位站着 openocd / JLink / STM32_Programmer_CLI 就先问用户。
  // 只认工具名的门在 2026-09-13 猎漏里被证明是假门 —— 模型改用 powershell 起同一条 openocd 就绕过去了。
  confirm: (input: PowerShellInput) => probeCommandIn(input.command) !== undefined,
  summary: powershellSummary,
} as const satisfies ToolContract<typeof powershellParameters>

/**
 * 确认条上那段:整段脚本,不只首行。用户点"允许"之前必须看得见 mass_erase 藏在第几行 ——
 * 确认条会换行、超高时滚动,不再靠省略号。
 */
export function powershellSummary(input: Partial<PowerShellInput>): string {
  return input.command?.trim() ?? ""
}
