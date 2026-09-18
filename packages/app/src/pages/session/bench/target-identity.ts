/**
 * 目标身份 —— 目标卡顶上那一行、状态栏最左那一格:**这是哪块板子**。
 *
 * **一个字都不编。** 工程名来自目录(那是本机事实);芯片 / 内核 / 探针 / 经哪个 server 接的,
 * 只在烧录器或 gdb **自己说过**的时候才有值 —— 认不出来时就只剩工程名,而不是摆一个猜来的型号。
 * 猜错型号的代价不是"不好看",是用户照着它去查错的那本手册。
 *
 * **为什么自己走一遍工具卡片,而不是往 `BenchStatus` 上加字段**(v3-bench 当初是那么做的):
 * `bench-status.ts` 是四个布局、三处消费者共用的热点,而身份只有状态栏这一处要。多一趟
 * memo(它只在工具卡片变了的时候重算)换那个文件一个字都不用动,这笔账划得来。
 *
 * 移植自 `ui/v3-bench` 的 `bench-status.ts`(`parseFlashOutput` / `chipFromFlashCommand` /
 * `deriveTargetIdentity`)与 `parseStopReport` 里认核那两条;正则逐字未改。
 */
import type { ToolPart } from "@yoma-desktop/kernel"
import { basename } from "./bench-status"

// ---------------------------------------------------------------- 烧录输出里的目标身份

/** openocd 每一行都带着目标名:`Info : [stm32f4x.cpu] Cortex-M4 r0p1 processor detected`。 */
const OOCD_TARGET = /\[([A-Za-z][A-Za-z0-9_.-]*)\.cpu\]/
/** `Cortex-M4` / `Cortex-M33` / `Cortex-M7`。只认这一种写法,别的芯片厂说法一律不猜。 */
const CORE_NAME = /\b(Cortex-[AMR]\d+[A-Za-z+]*)\b/
/** `STLINK V3J13M4` / `J-Link V11` / `CMSIS-DAP`。到型号为止,免得把 VID:PID 一起拖进来。 */
const PROBE_NAME = /\b(ST-?LINK[ -]?V\d[A-Za-z0-9]*|J-?Link[ -]?V?\d[A-Za-z0-9.]*|CMSIS-DAP|DAPLink)\b/i

export interface FlashProbeInfo {
  target?: string
  core?: string
  probe?: string
}

/** 从烧录输出里认目标。**只转述烧录器自己打出来的字**,一个字都不推断。 */
export function parseFlashOutput(output: string): FlashProbeInfo {
  const info: FlashProbeInfo = {}
  if (!output) return info
  const target = OOCD_TARGET.exec(output)
  if (target) info.target = target[1]
  const core = CORE_NAME.exec(output)
  if (core) info.core = core[1]
  const probe = PROBE_NAME.exec(output)
  if (probe) info.probe = probe[1]
  return info
}

/**
 * 从烧录命令行里认目标。openocd 的 `-f target/*.cfg`、厂商 CLI 的 `-device / --device / --part`。
 * 命令是一个脚本(`sh tools/flash-openocd.sh build/x.elf`)时什么都认不出来 —— 那就是空的,
 * 由输出那条兜(演示工程正是这种)。
 */
export function chipFromFlashCommand(argv: readonly string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    const cfg = /(?:^|[\\/])target[\\/]([A-Za-z0-9_.-]+)\.cfg$/.exec(arg)
    if (cfg) return cfg[1]
    if (arg === "-device" || arg === "--device" || arg === "--part") {
      const next = argv[index + 1]
      if (next && !next.startsWith("-")) return next
    }
    const inline = /^--?(?:device|part)=(.+)$/.exec(arg)
    if (inline) return inline[1]
  }
  return undefined
}

// ---------------------------------------------------------------- gdb 回执里的核与 server

/** `core: Cortex-M4 r0p0 (breakpoint budget unknown …)` —— gdb start 回执里认核那一行。 */
const GDB_CORE_LINE = /^core:\s*(.+)$/
/** `attached to localhost:3333 via openocd, gdb /…/arm-none-eabi-gdb` */
const GDB_VIA_LINE = /^attached to \S+ via ([A-Za-z0-9_-]+)/

export interface GdbIdentityInfo {
  /** `core:` 那行去掉括号说明之后的原话(`Cortex-M4 r0p0`)。 */
  core?: string
  /** `attached to … via <server>` 里的那个词(`openocd` / `qemu` / …)。 */
  via?: string
}

/**
 * 从一次 gdb 调用的输出里认核与 server。这两句**只在 `start` 的回执里说一次**,
 * 之后每一条 gdb 调用都不再重复 —— 所以折叠时要沿用,见 `deriveTargetIdentity`。
 */
export function parseGdbIdentity(output: string): GdbIdentityInfo {
  const info: GdbIdentityInfo = {}
  if (!output) return info
  for (const line of output.split("\n")) {
    const core = GDB_CORE_LINE.exec(line)
    // 括号里是"断点预算不明"这类说明,不是核名 —— 切掉再 trim,空的就当没说。
    if (core && !info.core) {
      const name = core[1].split(/[(（]/)[0].trim()
      if (name) info.core = name
    }
    const via = GDB_VIA_LINE.exec(line)
    if (via && !info.via) info.via = via[1]
  }
  return info
}

// ---------------------------------------------------------------- 目标身份

export interface TargetIdentity {
  /** 工程目录名。永远有。 */
  project: string
  /** 烧录命令 / 烧录输出里的目标名(`stm32f4x` / `STM32F405RG`)。 */
  chip?: string
  /** 内核(`Cortex-M4 r0p0`)。gdb 从 CPUID 读的优先于烧录输出里的那一句。 */
  core?: string
  /** 探针型号(`STLINK V3J13M4`)。 */
  probe?: string
  /** gdb 经哪个 server 接的(`openocd` / `qemu` / …)。 */
  via?: string
  /** 这些字是从哪儿来的 —— 给 tooltip 用,让人能追到证据。源序:flash 在前,gdb 在后。 */
  sources: ("flash" | "gdb")[]
}

/** 工程目录名而已,但 Windows 的反斜杠与末尾斜杠都要认。 */
export function projectNameOf(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "")
  return basename(trimmed) || trimmed || directory
}

/** 连目标名、核名、探针名一个都没有的输出直接跳过分行(绝大多数烧录输出都是)。 */
const FLASH_WORTH_PARSING = /\.cpu\]|Cortex-[AMR]\d|ST-?LINK|J-?Link|CMSIS-DAP|DAPLink/i
/** `core:` / `attached to` 只出现在 gdb `start` 的回执里,别的动作一律跳过。 */
const GDB_WORTH_PARSING = /(?:^|\n)core:\s|(?:^|\n)attached to\s/

/**
 * 解析结果按卡片缓存 —— 一次烧录的输出可以是几十 KB,而这条 memo 在任何一张工具卡片
 * 变化时都会重跑。`output` 一起存是因为 running 态的卡片会边跑边长。
 */
const FLASH_CACHE = new WeakMap<object, { output: string; parsed: FlashProbeInfo }>()
const GDB_CACHE = new WeakMap<object, { output: string; parsed: GdbIdentityInfo }>()

function flashProbeOf(part: ToolPart, output: string): FlashProbeInfo {
  const hit = FLASH_CACHE.get(part)
  if (hit && hit.output === output) return hit.parsed
  const parsed = FLASH_WORTH_PARSING.test(output) ? parseFlashOutput(output) : {}
  FLASH_CACHE.set(part, { output, parsed })
  return parsed
}

function gdbIdentityOf(part: ToolPart, output: string): GdbIdentityInfo {
  const hit = GDB_CACHE.get(part)
  if (hit && hit.output === output) return hit.parsed
  const parsed = GDB_WORTH_PARSING.test(output) ? parseGdbIdentity(output) : {}
  GDB_CACHE.set(part, { output, parsed })
  return parsed
}

function outputOf(part: ToolPart): string {
  const state = part.state
  if (state.status === "completed" || state.status === "running") {
    return typeof state.output === "string" ? state.output : ""
  }
  return ""
}

/** 烧录命令行:优先 metadata(工具自己记下来的那份),回落到模型给的入参。 */
function flashCommandOf(part: ToolPart): string[] | undefined {
  const state = part.state
  const meta = state.status === "pending" ? {} : ((state.metadata ?? {}) as Record<string, unknown>)
  const input = (state.input ?? {}) as Record<string, unknown>
  for (const value of [meta.command, input.command]) {
    if (!Array.isArray(value)) continue
    const argv = value.filter((item): item is string => typeof item === "string")
    if (argv.length > 0) return argv
  }
  return undefined
}

function settled(part: ToolPart): boolean {
  return part.state.status === "completed" || part.state.status === "error"
}

/**
 * 把 transcript 里的工具卡片折成一份身份。**parts 必须是源序**(`useBenchToolParts` 已经是)。
 *
 * 两条折叠规则,都是"换了一块板"这件事逼出来的:
 * - **烧录已结束时整份替换**(不是合并):上一条烧录认出来的芯片不往后沿用,`-device` 换了型号
 *   就该换,认不出来就该变回空。
 * - **烧录还在跑时只合并**:活尾巴里可能已经打出了探针型号,但它还没资格否定上一次的结论。
 * - **gdb 的核与 server 沿用**:那两句只在 `start` 的回执里说一次。
 */
export function deriveTargetIdentity(parts: readonly ToolPart[], directory: string): TargetIdentity {
  const project = projectNameOf(directory)
  let flash: FlashProbeInfo | undefined
  const gdb: GdbIdentityInfo = {}

  for (const part of parts) {
    if (part.tool === "flash") {
      const probe = flashProbeOf(part, outputOf(part))
      const argv = flashCommandOf(part)
      // 命令行里写明的目标优先于输出里认出来的:前者是人(或模型)的声明,后者是探针的回话。
      const next: FlashProbeInfo = { ...probe, target: (argv ? chipFromFlashCommand(argv) : undefined) ?? probe.target }
      flash = settled(part) ? next : { ...flash, ...definedOnly(next) }
      continue
    }
    if (part.tool === "gdb") {
      const parsed = gdbIdentityOf(part, outputOf(part))
      if (parsed.core) gdb.core = parsed.core
      if (parsed.via) gdb.via = parsed.via
    }
  }

  const chip = flash?.target
  const probe = flash?.probe
  const core = gdb.core ?? flash?.core
  const via = gdb.via
  const sources: ("flash" | "gdb")[] = []
  if (chip || probe || (!gdb.core && flash?.core)) sources.push("flash")
  if (gdb.core || via) sources.push("gdb")
  return { project, chip, core, probe, via, sources }
}

/** `{...a, ...b}` 会让 b 里的 undefined 把 a 的值抹掉 —— 合并时要的是"只盖说过的"。 */
function definedOnly(info: FlashProbeInfo): FlashProbeInfo {
  const out: FlashProbeInfo = {}
  if (info.target) out.target = info.target
  if (info.core) out.core = info.core
  if (info.probe) out.probe = info.probe
  return out
}

/** 目标卡上那一行铭牌:`stm32f4x · Cortex-M4 r0p0 · STLINK V3J13M4`。说得出几样说几样。 */
export function targetSpec(identity: TargetIdentity): string {
  return [identity.chip, identity.core, identity.probe].filter(Boolean).join(" · ")
}
