/**
 * 停住之后给界面用的结构化快照:栈、局部变量、通用寄存器、断点落在哪一行。
 * 纯函数,不起进程。人话报告仍由 render.ts 拼,这里不改那份给模型看的文本。
 */

import type { Frame } from "./render.ts"
import { decodeException } from "./cortex-m.ts"
import { miNumber, miString, type MiTuple, type MiValue } from "./mi.ts"

export interface InspectFrame {
  level: number
  func?: string
  file?: string
  line?: number
  addr?: string
  fullname?: string
}

export interface InspectLocal {
  name: string
  value?: string
  type?: string
  detail?: string
}

const LOCAL_LIMIT = 40
const REGISTER_LIMIT = 28
const VALUE_LIMIT = 120

/**
 * 通用寄存器 + Cortex-M 的特殊寄存器(PRIMASK / BASEPRI / FAULTMASK / CONTROL:查"中断为什么没进来"
 * 全靠它们)。有它们时丢掉浮点 s0–s31 / d0–d15 和厂商扩展,侧栏放不下整张表。
 */
const GENERAL_REGISTER =
  /^(r\d{1,2}|sp|lr|pc|xpsr|cpsr|msp|psp|msp_ns|psp_ns|msplim|psplim|primask|basepri|faultmask|control|fpscr)$/i

export function clipInspect(text: string, max = VALUE_LIMIT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** `"file.c:42"` / `"C:/proj/main.c:42"` → 文件与行。函数名和 `*addr` 对不上。 */
export function sourcePoint(location: string | undefined): { file?: string; line?: number } {
  if (!location) return {}
  const match = /^(.*):(\d+)$/.exec(location.trim())
  if (!match) return {}
  const file = match[1]
  if (!file || file.startsWith("*")) return {}
  const line = Number(match[2])
  if (!Number.isInteger(line) || line < 1) return {}
  return { file, line }
}

export function framesOf(frames: Frame[]): InspectFrame[] {
  return frames.slice(0, 8).map((frame, index) => {
    const line = frame.line !== undefined ? Number(frame.line) : undefined
    return {
      level: frame.level ?? index,
      ...(frame.func ? { func: frame.func } : {}),
      ...(frame.file ? { file: frame.file } : {}),
      ...(line !== undefined && Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(frame.addr ? { addr: frame.addr } : {}),
      ...(frame.fullname ? { fullname: frame.fullname } : {}),
    }
  })
}

/**
 * `--simple-values`:标量有 value,结构体只有 type。两者都要留下。
 * `<optimized out>` 是 value,不是空 —— 界面靠这个字判断,不能改写成别的。
 */
export function localsOf(rows: MiTuple[]): InspectLocal[] {
  const out: InspectLocal[] = []
  for (const row of rows) {
    if (out.length >= LOCAL_LIMIT) break
    const name = miString(row.name)
    if (!name) continue
    const value = miString(row.value)
    const type = miString(row.type)
    out.push({
      name,
      ...(value !== undefined ? { value: clipInspect(value) } : {}),
      ...(type ? { type: clipInspect(type, 80) } : {}),
    })
  }
  return out
}

/**
 * 按位置保留,空名字也占一格:`-data-list-register-values` 按**编号**回值,而 Cortex-M 的目标描述在
 * pc 与 xpsr 之间留着一串 `""`(QEMU 实测:xpsr 是 25 号)。丢掉空名字,后面的名字就全错位 ——
 * xpsr / msp / psp 消失,换一个目标就是把值挂到别的寄存器名下。
 */
export function registerNamesOf(value: MiValue | undefined): string[] {
  if (value === undefined) return []
  const items = Array.isArray(value) ? value : [value]
  return items.map((item) => miString(item) ?? "")
}

export function registerValuesOf(rows: MiTuple[]): Map<number, string> {
  const values = new Map<number, string>()
  for (const row of rows) {
    const index = miNumber(row.number)
    const value = miString(row.value)
    if (index === undefined || value === undefined) continue
    values.set(index, clipInspect(value, 80))
  }
  return values
}

export function pickRegisters(names: string[], values: Map<number, string>): { name: string; value: string }[] {
  const pairs = names.flatMap((name, index) => {
    const value = values.get(index)
    return name && value !== undefined ? [{ name, value }] : []
  })
  const general = pairs.filter((row) => GENERAL_REGISTER.test(row.name))
  return (general.length ? general : pairs.slice(0, 16)).slice(0, REGISTER_LIMIT)
}

const SOURCE_LIMIT = 2000
const DETAIL_LIMIT = 4000

/**
 * `-file-list-exec-source-files` 的 files 列表 → 本机存在的 C/C++/汇编源文件,去重、排序。
 * 头文件留着(内联函数常在 .h 里);`exists` 注入,测试不碰磁盘。
 */
export function sourceFilesOf(rows: MiTuple[], exists: (path: string) => boolean): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    const full = miString(row.fullname)
    if (!full || seen.has(full)) continue
    if (!/\.(c|cc|cpp|cxx|h|hh|hpp|s|S|asm)$/.test(full)) continue
    if (!exists(full)) continue
    seen.add(full)
    if (seen.size >= SOURCE_LIMIT) break
  }
  return [...seen].sort()
}

export function clipDetail(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`
}

/** xPSR 的低 9 位就是 IPSR。认不出 xpsr 就不报。 */
export function exceptionOf(registers: { name: string; value: string }[]): { number: number; name: string } | undefined {
  const row = registers.find((item) => /^(xpsr|cpsr)$/i.test(item.name))
  if (!row || row.name.toLowerCase() !== "xpsr") return undefined
  const value = Number(row.value)
  if (!Number.isFinite(value)) return undefined
  const decoded = decodeException(value >>> 0)
  return { number: decoded.vectactive, name: decoded.name }
}

export interface InspectAsm {
  address: string
  func?: string
  offset?: number
  inst: string
}

const ASM_BEFORE = 24
const ASM_AFTER = 40

/** 地址字符串统一成小写、去前导零后比较:gdb 在不同命令里给 `0x080004ac` 和 `0x80004ac` 两种写法。 */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const na = Number(a)
  const nb = Number(b)
  return Number.isFinite(na) && na === nb
}

/**
 * `-data-disassemble … -- 0` 的 asm_insns → 以 pc 为中心的一段(前 24 条、后 40 条)。
 * tab 换成空格:界面按等宽排,gdb 用 tab 分助记符与操作数。
 */
export function asmLinesOf(rows: MiTuple[], pc: string | undefined): InspectAsm[] {
  const all: InspectAsm[] = []
  for (const row of rows) {
    const address = miString(row.address)
    const inst = miString(row.inst)
    if (!address || inst === undefined) continue
    const func = miString(row["func-name"])
    const offset = miNumber(row.offset)
    all.push({
      address,
      ...(func ? { func } : {}),
      ...(offset !== undefined ? { offset } : {}),
      inst: inst.replace(/\t/g, " "),
    })
  }
  const at = all.findIndex((row) => sameAddress(row.address, pc))
  if (at < 0) return all.slice(0, ASM_BEFORE + ASM_AFTER)
  return all.slice(Math.max(0, at - ASM_BEFORE), at + ASM_AFTER)
}
