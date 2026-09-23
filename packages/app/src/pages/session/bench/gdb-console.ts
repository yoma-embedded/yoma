/**
 * 调试控制台:一行 gdb 习惯写法 → 工具的一次调用;工具回给模型的长报告 → 控制台里的几行。纯函数。
 *
 * 为什么不把整行原样交给 eval:断点、单步、继续要走工具自己的动作,工具才记得住断点表、
 * 等得到停止、算得出新的停止现场。eval 里的 `continue` 会被闸门拒掉(它不等停止)。
 */
import type { GdbInput } from "@yoma-desktop/kernel/tools/gdb/contract"

/** 按钮与控制台共用:继续之后 100 ms 就回,停下来由轮询接住(同 VS Code:继续不阻塞界面)。 */
export const RESUME = { waitMs: 100, onTimeout: "leave-running" } as const

const STEP_OPS: Record<string, "next" | "step" | "stepi" | "finish"> = {
  n: "next",
  next: "next",
  s: "step",
  step: "step",
  si: "stepi",
  stepi: "stepi",
  fin: "finish",
  finish: "finish",
}

/**
 * 控制台一行命令的去处:
 * - `tool`:交给工具(运行控制、断点走工具自己的动作,其余交给 eval,人亲手敲的带 write);
 * - `frame`:只换面板上看的那一帧(`up` / `down` / `frame N`),**不发给 gdb** —— gdb 的选中帧是和 agent 共用的,
 *   敲一句 `up` 之后 agent 的下一句 `p local` / `next` 就在另一帧里跑了;
 * - `refuse`:会改掉共用状态、面板里又没有对应做法的(`thread N`),直接说不。
 */
export type ConsoleAction =
  | { kind: "tool"; input: GdbInput }
  | { kind: "frame"; level?: number; delta?: number }
  | { kind: "refuse"; reason: "thread" }

/** 一行命令 → 去处。空行返回 undefined。 */
export function parseConsole(line: string): ConsoleAction | undefined {
  const text = line.trim()
  if (!text) return undefined
  const [head = "", ...rest] = text.split(/\s+/)
  const word = head.toLowerCase()
  const arg = rest.join(" ").trim()
  if (word === "up" || word === "down") {
    const count = arg ? Number(arg) : 1
    if (Number.isInteger(count) && count > 0) return { kind: "frame", delta: word === "up" ? count : -count }
  }
  if ((word === "frame" || word === "f" || word === "select-frame") && /^\d+$/.test(arg)) {
    return { kind: "frame", level: Number(arg) }
  }
  if (word === "thread" && arg && !/^(apply|find|name)\b/i.test(arg)) return { kind: "refuse", reason: "thread" }
  const input = parseConsoleCommand(text)
  return input ? { kind: "tool", input } : undefined
}

/** 一行命令 → 工具输入。空行返回 undefined。认不出的一律当 gdb 命令交给 eval(人亲手敲的,带 write)。 */
export function parseConsoleCommand(line: string): GdbInput | undefined {
  const text = line.trim()
  if (!text) return undefined
  const [head = "", ...rest] = text.split(/\s+/)
  const word = head.toLowerCase()
  const arg = rest.join(" ").trim()

  if (word === "c" || word === "cont" || word === "continue") {
    return { action: "exec", op: "continue", expectRunning: true, ...RESUME }
  }
  if (word === "interrupt") return { action: "exec", op: "interrupt", waitMs: 3000 }
  const step = STEP_OPS[word]
  if (step) {
    const count = Number(arg)
    return {
      action: "exec",
      op: step,
      ...RESUME,
      ...(step !== "finish" && Number.isInteger(count) && count > 1 ? { count } : {}),
    }
  }
  if ((word === "b" || word === "br" || word === "break" || word === "tb" || word === "tbreak") && arg) {
    const temporary = word === "tb" || word === "tbreak"
    // `b foo if x > 3`:gdb 的条件写法,拆给 condition。
    const cond = /^(.*?)\s+if\s+(.+)$/.exec(arg)
    return {
      action: "break",
      at: cond ? cond[1]!.trim() : arg,
      ...(cond ? { condition: cond[2]!.trim() } : {}),
      ...(temporary ? { temporary } : {}),
    }
  }
  if (word === "d" || word === "delete") {
    if (!arg) return { action: "break", remove: "all" }
    if (/^\d+$/.test(arg)) return { action: "break", remove: arg }
  }
  if ((word === "watch" || word === "rwatch" || word === "awatch") && arg) {
    return { action: "break", watch: arg, mode: word === "rwatch" ? "r" : word === "awatch" ? "rw" : "w" }
  }
  return { action: "eval", command: text, write: true }
}

/** 按钮对应的那行命令:控制台里照 gdb 的写法记一笔,和手敲的读起来一样。 */
export function commandLineOf(input: GdbInput): string {
  switch (input.action) {
    case "exec":
      return input.count ? `${input.op} ${input.count}` : (input.op ?? "exec")
    case "break":
      if (input.remove) return input.remove === "all" ? "delete" : `delete ${input.remove}`
      if (input.watch) return `${input.mode === "r" ? "rwatch" : input.mode === "rw" ? "awatch" : "watch"} ${input.watch}`
      return `${input.temporary ? "tbreak" : "break"} ${input.at ?? ""}${input.condition ? ` if ${input.condition}` : ""}`
    case "eval":
      return input.command ?? ""
    case "start":
      return `target ${input.server ?? "external"} ${input.elfPath ?? ""}`.trim()
    case "stop":
      return "disconnect"
    default:
      return input.action
  }
}

/** 给模型看、对人是噪音的行:横幅、日志路径、括号里的提示语。 */
const NOISE = [
  /^\[gdb #\d+ /,
  /^(session|server) log:/,
  /^server: /,
  /^Session log:/,
  /^elf: /,
  /^\s*\((?:目标|[0-9]+ 个局部变量|the target|target is)/,
]

/** 工具的回复 → 控制台里的几行。eval 的输出原样(那就是 gdb 的回答),其余去噪、限行。 */
export function condenseOutput(input: GdbInput, text: string, maxLines = 14): string {
  const lines = text.replace(/\s+$/, "").split("\n")
  if (input.action === "eval") {
    const body = lines.filter((line) => !/^\[gdb #\d+ /.test(line))
    return body.join("\n").trim() || "(no output)"
  }
  const kept = lines.filter((line) => !NOISE.some((re) => re.test(line)))
  const trimmed = kept.length > maxLines ? [...kept.slice(0, maxLines), `… (+${kept.length - maxLines})`] : kept
  return trimmed.join("\n").trim()
}

/**
 * status 的全文里只取停止那一段(`■ stopped#…` 起,到栈与局部变量为止):轮询发现了一次新停止
 * (continue 之后停在断点上、agent 让它停的)时,控制台像 TUI 一样补一行 "Breakpoint 2, foo () at …"。
 */
export function stopBlockOf(text: string): string | undefined {
  const lines = text.split("\n")
  const at = lines.findIndex((line) => line.startsWith("■ "))
  if (at < 0) return undefined
  const out: string[] = [lines[at]!]
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break
    if (NOISE.some((re) => re.test(line))) continue
    out.push(line)
  }
  return out.join("\n")
}
