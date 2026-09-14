/**
 * 栈帧与预算的渲染:从 MI 的 frame tuple 取字段、拼成一行人能读的帧、掐尾巴。
 *
 * 纪律和 log 工具一致:全量在文件里,进上下文的一律有界、且**截断必须标注**。
 * 裸截断是最坏的失败形式 —— 它是自信地错,而不是可见地错。
 */

import { type MiTuple, miNumber, miString, unwrapList } from "./mi.ts"

export const MAX_FRAMES = 8

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  // 别切在代理对中间:留下一个孤立的高位代理,这段文本就不再是合法的 UTF-16。
  const last = text.charCodeAt(max - 1)
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return `${text.slice(0, cut)}… [截断:共 ${text.length} 字符,已显示 ${cut}]`
}

export function hex(n: number | undefined, width = 8): string {
  if (n === undefined) return "?"
  return `0x${(n >>> 0).toString(16).padStart(width, "0")}`
}

export interface Frame {
  level?: number
  addr?: string
  func?: string
  file?: string
  line?: string
  /** MI 给的编译期绝对路径。可能在本机不存在 —— 调用方要先 exists() 再当位置用。 */
  fullname?: string
  args?: { name: string; value?: string }[]
}

/** 从 MI 的 frame tuple 取字段。gdb 在不同命令里给的键是一致的,但可能缺项。 */
export function frameOf(t: MiTuple | undefined): Frame | undefined {
  if (!t) return undefined
  const args = unwrapList(t.args).map((a) => ({
    name: miString(a.name) ?? "?",
    value: miString(a.value),
  }))
  return {
    level: miNumber(t.level),
    addr: miString(t.addr),
    func: miString(t.func),
    file: miString(t.file),
    line: miString(t.line),
    fullname: miString(t.fullname),
    args: args.length ? args : undefined,
  }
}

export function renderFrame(f: Frame, index?: number): string {
  const head = index === undefined ? "" : `#${index} `
  const args = f.args?.length ? `(${f.args.map((a) => `${a.name}=${a.value ?? "?"}`).join(", ")})` : "()"
  const where = f.file && f.line ? ` at ${f.file}:${f.line}` : f.addr ? ` at ${f.addr}` : ""
  return `${head}${f.func ?? "??"}${args}${where}`
}

export function renderFrames(frames: Frame[], max = MAX_FRAMES): string[] {
  const shown = frames.slice(0, max)
  const out = shown.map((f, i) => `  ${renderFrame(f, f.level ?? i)}`)
  if (frames.length > max) out.push(`  … 还有 ${frames.length - max} 帧(eval "bt ${frames.length}" 看全部)`)
  return out
}

export interface ShortenPathOptions {
  /** 前缀比较忽略大小写。缺省按平台:Windows 的盘符与目录名大小写随写法漂,别的平台照实比。 */
  caseInsensitive?: boolean
}

/**
 * DWARF 存的是编译那台机器上的绝对路径。原样打进上下文既长又没信息量,
 * 而且长路径在栈里重复七遍就是几百个白烧的 token。root 通常是工程目录(cwd)。
 *
 * 分隔符两边各自归一成 `/` 再比:Windows 上 CMake / MinGW / Clang 写进 DWARF 的是 `C:/Users/…`,
 * 而内核的 cwd 是 `C:\Users\…`,按 path.sep 硬比永远对不上(审稿实测)。剥的是**原串**的前缀,
 * 所以返回值里的分隔符仍是 DWARF 自己写的那种。
 */
export function shortenPath(file: string | undefined, root?: string, options?: ShortenPathOptions): string | undefined {
  if (!file || !root) return file
  const caseInsensitive = options?.caseInsensitive ?? process.platform === "win32"
  const fold = (p: string) => {
    const slashed = p.replace(/\\/g, "/")
    return caseInsensitive ? slashed.toLowerCase() : slashed
  }
  const prefix = `${fold(root).replace(/\/+$/, "")}/`
  return fold(file).startsWith(prefix) ? file.slice(prefix.length) : file
}

export function relFrame(frame: Frame, root?: string): Frame {
  const file = shortenPath(frame.file, root)
  return file === frame.file ? frame : { ...frame, file }
}
