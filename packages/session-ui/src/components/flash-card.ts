/**
 * flash 卡片的纯函数层 —— `details` + 输出文本 → 一张排好版的烧录记录。
 *
 * 形状对着 `host/tools/flash/contract.ts` 的 `FlashDetails`:
 * `{ command: string[]; exitCode: number | null; recordedElf?: string }`。
 * 除此之外全在给模型看的输出里(OpenOCD / J-Link / CubeProgrammer 各说各的话),
 * 所以"成没成"以 **exitCode** 为准,输出里只挑几行做证据 —— 反过来按文本判会被
 * J-Link 那种"失败也退 0"的工具骗,也会被一句 `** Programming Finished **` 骗。
 */
import { fileName } from "./hw-format"

export interface FlashCard {
  ok: boolean
  exitCode: number | null
  /** 整条命令,**不截断** —— 确认条那边吃过 "mass_erase 藏在省略号后面" 的亏。 */
  command: string
  /** 烧的是哪一份镜像(`build/f405-motor-ctrl.elf`);命令里认不出来时没有。 */
  image?: string
  /** 记进 flash-state.json 的镜像绝对路径(只有 exit 0 且调用时给了 elfPath 才有)。 */
  recordedElf?: string
  /** 输出里值得高亮的几行(Programming Finished / Verified OK / Error)。 */
  highlights: { text: string; tone: "ok" | "fail" | "warn" }[]
  /** `wrote 16384 bytes … in 0.681733s` 里那个秒数。 */
  programSeconds?: number
  verifySeconds?: number
  /** `wrote 16384 bytes from file …` 里的字节数。 */
  wroteBytes?: number
  /**
   * 烧写 + 校验的秒数(烧录器自己报的)。
   *
   * **不用卡片的 `state.time`**:那是整次工具调用的墙钟(含探针握手、复位),而且 2026-09-24 之前重放一段旧会话时
   * projector 的 `time.start` 是"现在"、相减是负数(现在重放取 entry 的落盘时间,见 `projector.applyMessage`)。
   * 烧录器打在输出里的这两个秒数是随证据一起存下来的,只算烧写与校验,重放照样对。
   */
  totalSeconds?: number
}

/** 常见烧录器都会打的"成了"与"砸了"。词表按行匹配,认不出的行不进高亮。 */
const OK_LINE = /(\*\* (?:Programming Finished|Verified OK|Verify Started|Programming Started|Resetting Target) \*\*|^verified \d|^wrote \d|Erasing done|Download verified successfully|File download complete|Verifying \.\.\. OK|RESET done)/i
const FAIL_LINE = /^\s*(?:Error|error|ERROR)\b|\*\* (?:Programming Failed|Verify Failed) \*\*|failed|Cannot|could not|No such file|refus/
const WARN_LINE = /^\s*Warn\s*:|^\s*WARNING\b/

const WROTE = /^wrote\s+(\d+)\s+bytes\s+from\s+file\s+(\S+)\s+in\s+([\d.]+)s/im
const VERIFIED = /^verified\s+\d+\s+bytes\s+in\s+([\d.]+)s/im

/** 命令里最像镜像的那个参数:`.elf` / `.hex` / `.bin`,或者 OpenOCD `program <file>` 里的那个。 */
function imageOf(command: readonly string[]): string | undefined {
  for (const arg of command) {
    const program = /\bprogram\s+(\S+)/.exec(arg)
    if (program) return program[1]
  }
  const hit = command.find((arg) => /\.(elf|hex|bin|axf|srec|s19)$/i.test(arg))
  return hit
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === "string")
  return out.length > 0 ? out : undefined
}

/** argv → 一行。与契约的 `flashSummary` 同一种拼法(带空白的参数加引号)。 */
export function joinCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")
}

const MAX_HIGHLIGHTS = 6

/**
 * `undefined` = 这次调用连命令都读不出来,回落到通用卡。
 * 命令是 flash 唯一的必需参数,连它都没有说明这份 metadata 不是 flash 的形状。
 */
export function describeFlash(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined,
): FlashCard | undefined {
  const command = strArray(metadata?.command) ?? strArray(input?.command)
  if (!command) return undefined

  const exitCode = num(metadata?.exitCode) ?? (metadata?.exitCode === null ? null : undefined)
  const text = typeof output === "string" ? output : ""

  const candidates: { text: string; tone: "ok" | "fail" | "warn"; at: number }[] = []
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tone = FAIL_LINE.test(trimmed) ? "fail" : OK_LINE.test(trimmed) ? "ok" : WARN_LINE.test(line) ? "warn" : undefined
    if (!tone) continue
    if (candidates.some((item) => item.text === trimmed)) continue
    candidates.push({ text: trimmed, tone, at: index })
  }
  // **挑**按要紧程度,**排**按时间顺序。一条 Error 或一句 "** Verified OK **" 被五条
  // "** … Started **" 挤出上限就等于没显示;而挑完了再按原序摆,读起来才还是一次烧录。
  const highlights = candidates
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.at - b.at)
    .slice(0, MAX_HIGHLIGHTS)
    .sort((a, b) => a.at - b.at)
    .map(({ text, tone }) => ({ text, tone }))

  const wrote = WROTE.exec(text)
  const verified = VERIFIED.exec(text)
  const recordedElf = typeof metadata?.recordedElf === "string" ? metadata.recordedElf : undefined

  return {
    ok: exitCode === 0,
    exitCode: exitCode ?? null,
    command: joinCommand(command),
    image: imageOf(command) ?? (recordedElf ? fileName(recordedElf) : undefined),
    recordedElf,
    highlights,
    wroteBytes: wrote ? Number(wrote[1]) : undefined,
    programSeconds: wrote ? Number(wrote[3]) : undefined,
    verifySeconds: verified ? Number(verified[1]) : undefined,
    totalSeconds: wrote || verified ? (wrote ? Number(wrote[3]) : 0) + (verified ? Number(verified[1]) : 0) : undefined,
  }
}

/**
 * 挑高亮行的优先级。**定论行**(Finished / Verified OK / wrote / verified)排在
 * 过程行(… Started / Resetting)前面 —— 后者多而且不说明任何事。
 */
const CONCLUSIVE = /Programming Finished|Verified OK|^verified \d|^wrote \d|Download verified|File download complete|Verifying \.\.\. OK/i

function rank(item: { text: string; tone: "ok" | "fail" | "warn" }): number {
  if (item.tone === "fail") return 0
  if (item.tone === "warn") return 1
  return CONCLUSIVE.test(item.text) ? 2 : 3
}
