/**
 * flash 工具的契约:菜单那一半。
 *
 * 一个工具两个文件,分工是餐厅/厨房:contract.ts 是菜单(叫什么、收什么参数、结果长什么形状、
 * 卡片副标题怎么写),session.ts 是厨房(真去起烧录器、攥探针、杀进程树)。界面要画 flash 的专用
 * 卡片,就得知道参数与 details 的字段名 —— 但界面跑在浏览器里,不能顺带把 Node 拖进 bundle。
 *
 * 两条门规(boundary.test.ts 第 3、5 条机器执行):
 * - 谁能 import 它:界面包只许走 `@yoma-desktop/kernel/tools/flash/contract` 这道契约门,
 *   不许相对路径钻进 kernel/src。
 * - 它能 import 什么:只有 typebox 和工具间内部的相对路径(不含 session.ts)。不许 node:*、electron、
 *   `@earendil-works/*`、发动机(host/domain/engines.ts),也不许 ../../types.ts 或任何 `@yoma-desktop/*`
 *   —— 契约门一旦牵进 Node,餐厅就打不开了。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const flashParameters = Type.Object({
  command: Type.Array(Type.String(), {
    minItems: 1,
    description:
      'The flasher argv (no shell), e.g. ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"].',
  }),
  elfPath: Type.Optional(
    Type.String({
      description:
        "The image this command flashes. On success its hash is recorded so gdb start can verify the chip runs exactly this build. Pass it whenever the command programs firmware.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Kill the command after this long (default 120000, clamped to 5000–600000). Flashing normally takes seconds; a hung flasher keeps the probe hostage.",
    }),
  ),
})

export type FlashInput = Static<typeof flashParameters>

export interface FlashDetails {
  command: string[]
  exitCode: number | null
  /** elfPath 给了且 exit 0 时:已写进 flash-state.json 的镜像绝对路径。 */
  recordedElf?: string
}

const FLASH_DESCRIPTION = `Runs a flashing or probe-control command (OpenOCD, J-Link Commander, STM32CubeProgrammer CLI, pyocd, west, esptool, ...) with exclusive access to the debug probe.

- Use this instead of bash for ANY command that touches the debug probe (flash, erase, reset, option bytes). The probe lease lives here: a concurrent gdb or log session is told who holds the probe instead of a fake "no probe found", and a hung flasher is killed with its whole process tree instead of keeping the probe hostage.
- command is an argv array; it runs without a shell. Typical recipes:
  - OpenOCD: ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"]
  - J-Link: write a command file first (r / loadfile build/fw.hex / r / g / qc), then ["JLink","-Device","STM32G431CB","-If","SWD","-Speed","4000","-AutoConnect","1","-CommanderScript","flash.jlink"] (the binary is JLinkExe on macOS/Linux). J-Link Commander can exit 0 even when it failed — read the output, never trust its exit code alone.
  - STM32CubeProgrammer: ["STM32_Programmer_CLI","-c","port=SWD","-w","build/fw.elf","-v","-rst"]
- Always pass elfPath (the image the command flashes) when programming firmware: on success its hash is recorded, and gdb start verifies the chip is running exactly this build — the guard against debugging stale firmware.
- A non-zero exit comes back as data, not an error. It usually means no probe connected, a vendor-driver mismatch, or the probe is held by another process — read the output and the appended hint.
- There is no built-in probe enumeration; use bash for that (J-Link's ShowEmuList, lsusb, Get-PnpDevice) or the vendor tool itself.
- Make sure the firmware actually starts afterwards: include a reset in the command (OpenOCD "reset", J-Link "r" then "g", CubeProgrammer "-rst") or reset through gdb. Never claim firmware is running on hardware unless flashing and a reset both succeeded.`

/**
 * confirm 是给"烧录前先问用户"那一刀(before_tool 钩子)的元数据:这一刀只声明,谁都还没消费它。
 * 放在契约里而不是 session 里,是因为确认 UI 长在餐厅那边 —— 它不该为了问一句话去 import 厨房。
 * 烧录每一次都问:命令是模型自带的,工具分不清 erase 和 program。
 *
 * guidelines 进系统提示词的 "Tool-specific rules"(host/system-prompt.ts 按装配出的工具名收集)。
 * 这两句是行为防线不是文档:落不进提示词,模型就会继续用 bash 起 openocd,而 bash 起的进程在
 * 探针租约体系里是隐形的,整套跨进程分诊白做。
 */
export const FLASH_CONTRACT = {
  name: "flash",
  label: "烧录",
  description: FLASH_DESCRIPTION,
  parameters: flashParameters,
  confirm: (_input: FlashInput) => true,
  guidelines: [
    "Run every command that touches the debug probe through the flash tool, not bash — the probe lease and hung-flasher cleanup live there.",
    "Never claim firmware is running on hardware unless flashing and a reset both succeeded.",
  ],
  summary: flashSummary,
} as const satisfies ToolContract<typeof flashParameters>

/**
 * 会碰调试探针的程序名:小写、不带路径、不带 .exe / .py,SEGGER 那族再去掉尾巴上的 Exe
 * (`JLinkExe` / `JLinkGDBServerCLExe` / `JFlashExe` 是 macOS / Linux 上的真实文件名)。
 *
 * 这份清单是 bash / powershell 那两道门的纱窗:确认门原本只认工具名叫 flash,模型改用 bash 起同一条
 * openocd 就一个字都不问(2026-09-13 猎漏确认)。纱窗不是墙 —— 它拦的是模型顺手写的那种命令行,
 * 故意绕的写法(把程序名拼进变量再执行、-EncodedCommand、-File 指向一个 .ps1)拦不住,那一层靠
 * guidelines 里的规矩。
 */
export const PROBE_COMMANDS = [
  "openocd",
  "pyocd",
  "jlink",
  "jlinkgdbserver",
  "jlinkgdbservercl",
  "jflash",
  "stm32_programmer_cli",
  "st-flash",
  "st-util",
  "st-info",
  "esptool",
  "probe-rs",
  "nrfjprog",
  "dfu-util",
  "avrdude",
  "bossac",
  "stm32flash",
  "picotool",
  "mspdebug",
  "lm4flash",
  "teensy_loader_cli",
] as const

/**
 * 程序本身无害、带上某个子命令才碰探针的。子命令在各家语法里的位置不同,所以是四种定位而不是一张表:
 * - first:程序后第一个位置参数(`cargo embed`、`west flash`;`cargo build --features embed` 不算);
 * - positional:任一位置参数,但不能是某个开关的值(`idf.py -p COM3 flash`);
 * - target:`-t` / `--target` 的值(`pio run -t upload`);
 * - any:任一个词(`make -j8 flash`、`npm run flash` —— Makefile / package.json 的 flash 目标是嵌入式工程
 *   最常见的烧录入口,目标名本身就是意图)。
 */
const PROBE_SUBCOMMANDS: Readonly<
  Record<string, { where: "first" | "positional" | "target" | "any"; names: readonly string[] }>
> = {
  west: { where: "first", names: ["flash", "debug", "attach", "debugserver"] },
  cargo: { where: "first", names: ["flash", "embed"] },
  // programName 剥掉了 .py,所以键是 idf 不是 idf.py。
  idf: { where: "positional", names: ["flash", "erase-flash", "erase_flash", "monitor"] },
  pio: { where: "target", names: ["upload"] },
  platformio: { where: "target", names: ["upload"] },
  make: { where: "any", names: ["flash", "erase", "program", "upload"] },
  npm: { where: "any", names: ["flash", "erase"] },
  pnpm: { where: "any", names: ["flash", "erase"] },
  yarn: { where: "any", names: ["flash", "erase"] },
  bun: { where: "any", names: ["flash", "erase"] },
}

/**
 * 站在命令位前面的包装:`sudo openocd`、`& openocd`、`python -m esptool`、`Start-Process -FilePath openocd`。
 * 见到包装之后**整段都扫**而不是只看下一个词 —— 包装自己的开关(`sudo -E`、`start /wait`、`-FilePath`)
 * 会站在程序名前面,只看下一个词就漏了(2026-09-13 审稿实测)。
 */
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "nohup",
  "time",
  "timeout",
  "exec",
  "env",
  "&",
  "start",
  "start-process",
  "python",
  "python3",
  "py",
  "uv",
  "uvx",
  "pipx",
  "npx",
  "poetry",
  "call",
])

/** 把某个词当成一整条命令行再看一遍的开关:`bash -c "…"`(也含 -lc / -xc)、`cmd /c "…"`、`pwsh -Command "…"`。 */
const NESTED_COMMAND_FLAGS = new Set(["/c", "/k", "-command"])
const NESTED_COMMAND_VERBS = new Set(["invoke-expression", "iex"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "cmd", "powershell", "pwsh"])

/**
 * 先按引号分词,再在词流上切段:`;`、`&&`、`||`、`|`、换行与花括号是段界。先切段再分词的话引号里的 `;`
 * 会把 `bash -c "openocd …; exit"` 从中间剪断,而 `sed 's|openocd|pyocd|'` 会被剪出一个假命令位。
 * 花括号算段界是为了 PowerShell 的脚本块:`Start-Job { openocd … }`、`if ($x) { openocd }`、
 * `foreach ($f in $files) { STM32_Programmer_CLI -w $f }` 里程序名站在块的第一个位置 —— 把块当一段,
 * 它就回到命令位上(2026-09-13 审稿实测这些全漏)。bash 的 `*.{c,h}` 被切出的碎段里没有程序名,无害。
 */
function tokenizeSegments(line: string): string[][] {
  const segments: string[][] = [[]]
  const re = /"([^"]*)"|'([^']*)'|(&&|\|\||[|;{}]|\r?\n)|([^\s;|{}"']+)/g
  for (const match of line.matchAll(re)) {
    if (match[3] !== undefined) {
      segments.push([])
      continue
    }
    const token = match[1] ?? match[2] ?? match[4] ?? ""
    if (token === "") continue
    segments[segments.length - 1]!.push(token)
  }
  return segments.filter((segment) => segment.length > 0)
}

/** 一个词的程序名:剥引号、剥子 shell 的括号、剥路径、剥 .exe / .py,SEGGER 那族再剥尾巴上的 Exe,小写。 */
function programName(token: string): string {
  const stripped = token.replace(/^["'$(`{]+/, "").replace(/["')}`]+$/, "").replace(/^\.[\\/]/, "")
  const base = stripped.split(/[\\/]/).pop() ?? ""
  const name = base.replace(/\.(exe|py)$/i, "").toLowerCase()
  return /^(jlink|jflash)/.test(name) ? name.replace(/exe$/, "") : name
}

function isFlag(token: string): boolean {
  return token.startsWith("-") || token.startsWith("/") || token.startsWith("+")
}

/** 从某个词起当命令位看:它本身是探针程序,或者是"程序 + 子命令"里的程序。 */
function probeAt(tokens: string[], at: number): string | undefined {
  const name = programName(tokens[at]!)
  if ((PROBE_COMMANDS as readonly string[]).includes(name)) return name
  const rule = PROBE_SUBCOMMANDS[name]
  if (!rule) return undefined
  const rest = tokens.slice(at + 1)
  const lower = rest.map((token) => token.toLowerCase())
  let hit: string | undefined
  if (rule.where === "first") {
    const first = lower.find((token) => !isFlag(token))
    hit = first !== undefined && rule.names.includes(first) ? first : undefined
  } else if (rule.where === "positional") {
    hit = lower.find((token, index) => rule.names.includes(token) && (index === 0 || !isFlag(lower[index - 1]!)))
  } else if (rule.where === "any") {
    hit = lower.find((token) => rule.names.includes(token))
  } else {
    hit = lower.find((token, index) => rule.names.includes(token) && index > 0 && /^(-t|--target)$/.test(lower[index - 1]!))
  }
  return hit ? `${name} ${hit}` : undefined
}

/**
 * 这条命令行会不会碰调试探针;会就给出那个程序名,不会给 undefined。
 *
 * 只看每一段的**命令位**,不扫参数:`grep openocd log.txt` 与 `cat openocd.cfg` 都不该问,问多了用户
 * 会习惯性点允许,门就白立了。命令位前面站着包装(sudo / & / python -m / Start-Process)时扫完整段;
 * `bash -c "…"` 这种把命令藏在字符串里的写法,把那段字符串再看一遍。
 */
export function probeCommandIn(commandLine: string, depth = 0): string | undefined {
  if (depth > 3) return undefined
  for (const tokens of tokenizeSegments(commandLine)) {
    let index = 0
    let wrapped = false
    // PowerShell 的赋值 `$p = Start-Process openocd -PassThru`(拿进程对象以便稍后停掉 gdbserver,是惯用
    // 写法不是绕门):跳过 `$名字 =` 或 `$名字=…`,后面照常看命令位。
    if (index + 1 < tokens.length && /^\$[A-Za-z_][\w:]*$/.test(tokens[index]!) && tokens[index + 1] === "=") index += 2
    else if (/^\$[A-Za-z_][\w:]*=/.test(tokens[index] ?? "")) index += 1
    while (index < tokens.length) {
      const lower = tokens[index]!.toLowerCase()
      if (COMMAND_WRAPPERS.has(lower) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) {
        wrapped = true
        index++
        continue
      }
      if (wrapped && lower === "-m") {
        index++
        continue
      }
      break
    }
    if (index >= tokens.length) continue
    const head = programName(tokens[index]!)
    if (SHELLS.has(head) || NESTED_COMMAND_VERBS.has(head)) {
      // 开关后面的**全部**再看一遍,不只下一个词:`cmd.exe /c start openocd` 的程序名在第二个词上。
      const nestedAt = NESTED_COMMAND_VERBS.has(head)
        ? index
        : tokens.findIndex((token, at) => at > index && (NESTED_COMMAND_FLAGS.has(token.toLowerCase()) || /^-[A-Za-z]*c$/i.test(token)))
      const nested = nestedAt >= 0 ? tokens.slice(nestedAt + 1).join(" ") : ""
      if (nested) {
        const inner = probeCommandIn(nested, depth + 1)
        if (inner) return inner
      }
      continue
    }
    if (!wrapped) {
      const hit = probeAt(tokens, index)
      if (hit) return hit
      continue
    }
    for (let at = index; at < tokens.length; at++) {
      if (isFlag(tokens[at]!)) continue
      const hit = probeAt(tokens, at)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * 卡片副标题:把 argv 拼回一行人能读的命令。含空格的参数加双引号 —— 不加的话
 * `-c "program fw.elf verify reset exit"` 在卡片上会散成五个词,看着像五个参数。
 * 这是给人看的展示串,不是能回放的 shell 命令(不转义引号本身)。
 */
export function flashSummary(input: Partial<FlashInput>): string {
  const command = input.command
  if (!command || command.length === 0) return ""
  return command.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")
}
