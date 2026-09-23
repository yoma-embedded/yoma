/**
 * 目标内省与停止报告:认核、故障现场、停止快照、源码路径映射、镜像校验、gdb 二进制定位。
 * 这里的每一段都替模型做一件它**已知会做错**的事,然后把结论渲染成有界的人话。
 */

import { existsSync, statSync } from "node:fs"
import { open as openFile } from "node:fs/promises"
import path from "node:path"

import {
  ARM_IMPLEMENTER,
  clip,
  decodeBreakpointUnits,
  decodeCpuid,
  decodeDfsr,
  decodeDhcsr,
  decodeException,
  decodeExcReturn,
  decodeFault,
  decodeStackedFrame,
  decodeWatchpointUnits,
  ELF_HEADER_BYTES,
  elfMachine,
  escapeCString,
  type Frame,
  frameOf,
  hex,
  hexToWords,
  framesOf,
  localsOf,
  clipDetail,
  asmLinesOf,
  expressionWrites,
  expressionCalls,
  exceptionOf,
  sourceFilesOf,
  miNumber,
  miString,
  miTuple,
  pickRegisters,
  preferredGdbNames,
  registerNamesOf,
  registerValuesOf,
  relFrame,
  renderFrame,
  renderFrames,
  SCB,
  shortenPath,
  unwrapList,
} from "../../domain/gdb/index.ts"
import { readFlashState, sha256File } from "../flash/session.ts"
import type { GdbInspect } from "./contract.ts"
import type { GdbSession } from "./mi-session.ts"
import { findOnPath } from "./servers.ts"

/** -exec-interrupt 只表示"中断已发出",不表示停了。每一级都要有界。 */
export const INTERRUPT_GRACE_MS = 2_000

// ─── 内存读取 ────────────────────────────────────────────────────────────────

export async function readWords(session: GdbSession, addr: number, count: number): Promise<number[] | undefined> {
  const r = await session.send(`-data-read-memory-bytes ${hex(addr)} ${count * 4}`).catch(() => undefined)
  if (!r || r.class !== "done") return undefined
  const cell = unwrapList(r.results?.memory)[0]
  const contents = miString(cell?.contents)
  return contents ? hexToWords(contents) : undefined
}

export async function evalNumber(session: GdbSession, expr: string): Promise<number | undefined> {
  const r = await session.send(`-data-evaluate-expression "${escapeCString(expr)}"`).catch(() => undefined)
  if (!r || r.class !== "done") return undefined
  return miNumber(r.results?.value)
}

// ─── 认核 ────────────────────────────────────────────────────────────────────

export interface CoreProbe {
  core?: ReturnType<typeof decodeCpuid>
  /** FP_CTRL 真读出来的硬件断点数(M4 一般 6);读不到或读到 0(QEMU 不模拟 FPB)就是 undefined —— 不猜。 */
  breakpointUnits?: number
  /** DWT_CTRL 的 NUMCOMP,同上。 */
  watchpointUnits?: number
}

/**
 * 一次性认核。读不到 CPUID、或 implementer 不是 ARM(RISC-V、ESP32-C3 这类没有 PPB 的目标)就把整套
 * Cortex-M 逻辑关掉,而不是对着零解码出一堆假故障。
 */
export async function probeCore(session: GdbSession): Promise<CoreProbe> {
  const words = await readWords(session, SCB.CPUID, 1)
  const cpuid = words?.[0]
  if (cpuid === undefined) return {}
  const core = decodeCpuid(cpuid)
  if (core.implementer !== ARM_IMPLEMENTER) return {}
  const probe: CoreProbe = { core }

  const fp = await readWords(session, SCB.FP_CTRL, 1)
  if (fp?.[0] !== undefined) {
    const units = decodeBreakpointUnits(fp[0])
    if (units.total > 0) probe.breakpointUnits = units.total
  }
  const dwt = await readWords(session, SCB.DWT_CTRL, 1)
  if (dwt?.[0] !== undefined) {
    const total = decodeWatchpointUnits(dwt[0])
    if (total > 0) probe.watchpointUnits = total
  }
  return probe
}

// ─── 故障现场 ────────────────────────────────────────────────────────────────

export interface FaultReport {
  lines: string[]
  /** 非精确故障时不给源码位置 —— 给了就是冤枉无辜代码。 */
  trustworthyLocation: boolean
}

/**
 * 停在 handler 里的时候,backtrace 是垃圾:真正的现场在异常入栈帧里。这一段替模型做四件它**已知会做错**的事:
 * 选 MSP 还是 PSP、读栈上的 PC 而不是 handler 自己的 $pc、BFARVALID=0 时不信 BFAR、IMPRECISERR 时不报位置。
 */
export async function analyseFault(
  session: GdbSession,
  core: CoreProbe,
  root?: string,
): Promise<FaultReport | undefined> {
  if (!core.core?.hasConfigurableFaults) return undefined
  const scb = await readWords(session, SCB.CPUID, 16)
  if (!scb || scb.length < 16) return undefined

  const icsr = scb[1]!
  const cfsr = scb[10]!
  const hfsr = scb[11]!
  const dfsr = scb[12]!
  const mmfar = scb[13]!
  const bfar = scb[14]!
  const exception = decodeException(icsr)
  const faulting = exception.vectactive >= 3 && exception.vectactive <= 6
  if (!faulting && cfsr === 0 && (hfsr & 0x40000002) === 0) return undefined

  const lines: string[] = []
  const fault = decodeFault({ cfsr, hfsr, mmfar, bfar })
  lines.push(`  故障(${exception.name}):${fault.summary}`)
  const dfsrFlags = decodeDfsr(dfsr)
  if (dfsrFlags.length) lines.push(`  DFSR:${dfsrFlags.map((f) => f.name).join(" ")}`)

  // EXC_RETURN 在异常里的 LR 上 —— 但 handler 一旦调用过别的函数,LR 就被覆盖了。
  // 这时候栈帧位置无法从这里确定,老实说出来,别猜。
  const lr = await evalNumber(session, "(unsigned long)$lr")
  const exc = lr === undefined ? undefined : decodeExcReturn(lr)
  if (!exc?.valid) {
    lines.push(
      `  ⚠ $lr = ${hex(lr)} 不是合法的 EXC_RETURN,说明 handler 已经调用过别的函数;` +
        `异常入栈帧的位置无法从这里确定 —— 在 handler 入口下断点重来一次。`,
    )
    return { lines, trustworthyLocation: false }
  }

  const spExpr = exc.stackPointer === "PSP" ? "(unsigned long)$psp" : "(unsigned long)$msp"
  const sp = (await evalNumber(session, spExpr)) ?? (await evalNumber(session, "(unsigned long)$sp"))
  const words = sp === undefined ? undefined : await readWords(session, sp, 8)
  const stacked = words && decodeStackedFrame(words)
  if (!stacked) {
    lines.push(`  ⚠ 读不到 ${exc.stackPointer}(${hex(sp)})上的异常帧 —— 栈指针本身可能已经跑飞(典型的栈溢出)`)
    return { lines, trustworthyLocation: false }
  }

  lines.push(`  异常帧在 ${exc.stackPointer}(EXC_RETURN=${hex(lr)},${exc.extendedFrame ? "带浮点的扩展帧" : "基本帧"})`)
  if (fault.imprecise) {
    lines.push(`  ⚠ 非精确总线错误:入栈的 PC ${hex(stacked.pc)} 只是"出事附近",不是出事那条指令`)
  } else {
    const symbol = await session.console(`info symbol ${hex(stacked.pc)}`).catch(() => undefined)
    const where = symbol?.output.trim().split("\n")[0]
    // `info line *<pc>` 给源码行:`Line 200 of "/path/main.c" starts at address …`。有就贴,没有就只报符号。
    const line = await session.console(`info line *${hex(stacked.pc)}`).catch(() => undefined)
    const at = /Line (\d+) of "([^"]+)"/.exec(line?.output ?? "")
    const source = at ? ` (${shortenPath(at[2]!, root)}:${at[1]})` : ""
    lines.push(`  出事 PC ${hex(stacked.pc)}${where && !where.startsWith("No symbol") ? ` = ${where}` : ""}${source}`)
  }
  // xPSR 是现场的另一半:IPSR 说出事时在哪个异常里,T 位为 0 就是跳到了非 Thumb 地址(空函数指针的典型样子)。
  const ipsr = decodeException(stacked.xpsr & 0x1ff)
  const thumb = ((stacked.xpsr >>> 24) & 1) === 1
  lines.push(
    `  入栈寄存器:r0=${hex(stacked.r0)} r1=${hex(stacked.r1)} r2=${hex(stacked.r2)} r3=${hex(stacked.r3)} ` +
      `r12=${hex(stacked.r12)} lr=${hex(stacked.lr)} xpsr=${hex(stacked.xpsr)}` +
      `(${ipsr.inHandler ? `在 ${ipsr.name} 里` : "线程模式"}${thumb ? "" : ";⚠ T 位为 0 —— 跳到了非 Thumb 地址,典型的空函数指针调用"})`,
  )
  return { lines, trustworthyLocation: !fault.imprecise }
}

/**
 * 中断也没落地时,读 DHCSR 说清楚到底是哪一种 —— 目标在正常跑、进了 WFI 睡着、还是锁死了,对应三条完全不同的
 * 下一步。糊成"没停下来"等于把诊断丢给模型去猜。
 */
export async function describeStuck(session: GdbSession, core: CoreProbe, waitMs: number): Promise<string> {
  const head = `nothing stopped within ${waitMs} ms and -exec-interrupt did not land within ${INTERRUPT_GRACE_MS} ms either. `
  const words = core.core ? await readWords(session, SCB.DHCSR, 1).catch(() => undefined) : undefined
  const dhcsr = words?.[0]
  if (dhcsr === undefined) {
    return `${head}DHCSR is unreadable, so the debug connection itself is probably gone (probe unplugged, target unpowered, or SWD lost sync). Run gdb stop and reattach.`
  }
  const flags = decodeDhcsr(dhcsr).map((f) => f.name)
  if (flags.includes("S_LOCKUP")) {
    return `${head}DHCSR.S_LOCKUP is set: the core is locked up (a fault inside the fault handler). $pc reads 0xEFFFFFFE and is meaningless. Only a reset recovers — gdb exec op:"reset-halt".`
  }
  if (flags.includes("S_SLEEP")) {
    return `${head}DHCSR.S_SLEEP is set: the core is in WFI/WFE and the debug clock is gated, so it cannot be halted. Set DBGMCU_CR.DBG_SLEEP before entering low power, or reset with gdb exec op:"reset-halt".`
  }
  if (flags.includes("S_HALT")) {
    return `${head}but DHCSR.S_HALT is actually set — the core IS halted and gdb missed the notification. Run gdb status to resynchronise.`
  }
  return `${head}DHCSR says the core is still executing normally (S_HALT=0, S_SLEEP=0). The firmware is running, not wedged — either it never reaches your breakpoint, or the breakpoint did not get inserted.`
}

// ─── 停止报告 ────────────────────────────────────────────────────────────────

export function renderBanner(
  session: GdbSession | undefined,
  core: CoreProbe,
  connection?: string,
  root?: string,
): string {
  if (!session) return "[gdb no session]"
  const bp = core.breakpointUnits ? ` bp=${session.usedUnits("break")}/${core.breakpointUnits}` : ""
  const wp = core.watchpointUnits ? ` wp=${session.usedUnits("watch")}/${core.watchpointUnits}` : ""
  const frame = session.lastStop?.frame ? displayFrame(session.lastStop.frame, root) : undefined
  const at = frame ? ` @ ${frame.file && frame.line ? `${frame.file}:${frame.line}` : (frame.func ?? "?")}` : ""
  const conn = connection ? ` ${connection}` : ""
  return `[gdb #${session.epoch} ${session.state}${at}${bp}${wp}${conn}]`
}

/**
 * 报告里的文件名:优先 fullname —— `set substitute-path` 映射之后它才是本机路径,能剥掉工程根;
 * `file` 是编译机上写的那个名字(常常是另一台机器的绝对路径),剥不掉就退回它。
 */
export function displayFrame(frame: Frame, root?: string): Frame {
  const local = frame.fullname ? shortenPath(frame.fullname, root) : undefined
  if (local !== undefined && local !== frame.fullname) return { ...frame, file: local }
  return relFrame(frame, root)
}

export function renderBreakpoints(session: GdbSession, core: CoreProbe): string {
  if (session.breakpoints.size === 0) return "breakpoints: none armed"
  const rows = [...session.breakpoints.entries()].map(
    ([n, b]) => `  ${n} ${b.kind === "watch" ? "watch" : "break"} ${b.location}${b.addr ? ` @ ${b.addr}` : ""}`,
  )
  const budget = [
    core.breakpointUnits ? `hw breakpoints ${session.usedUnits("break")}/${core.breakpointUnits}` : "",
    core.watchpointUnits ? `watchpoints ${session.usedUnits("watch")}/${core.watchpointUnits}` : "",
  ]
    .filter(Boolean)
    .join(", ")
  return `breakpoints:\n${rows.join("\n")}${budget ? `\n  (${budget})` : ""}`
}

/**
 * 停止之后的规范快照。一次调用回答 90% 的问题,而不是让模型再发五条命令去拼。
 * 停在异常里的时候自动接上故障解码 —— "板子为什么死了"是打开调试器的首要原因,不该让模型自己去记 CFSR 的地址。
 */
export async function renderStopReport(
  session: GdbSession,
  core: CoreProbe,
  options: { show?: string[]; buildNote?: string; relativeTo?: string } = {},
): Promise<string> {
  const stop = session.lastStop
  const lines: string[] = []
  if (!stop) return "target is halted (no stop event recorded yet)"

  const elapsed = stop.sinceResumeMs !== undefined ? ` (+${(stop.sinceResumeMs / 1000).toFixed(3)}s)` : ""
  const which = stop.bkptno ? ` breakpoint ${stop.bkptno}` : ""
  // finish 停下来时函数的返回值就在停止记录上,不贴出来模型还得再 `p $` 一次。
  const returned =
    stop.returnValue !== undefined ? ` returned ${stop.returnValue}${stop.resultVar ? ` (${stop.resultVar})` : ""}` : ""
  // 连接时的第一次停止没有 reason 字段;"unknown" 会让模型以为出了什么事。
  const reason = stop.reason === "unknown" ? "halted (initial attach)" : stop.reason
  lines.push(`■ stopped#${stop.n}: ${reason}${which}${returned}${elapsed}`)

  const fault = await analyseFault(session, core, options.relativeTo).catch(() => undefined)
  if (fault) lines.push(...fault.lines)

  const frames = await session.send("-stack-list-frames 0 7").catch(() => undefined)
  const list = frames && frames.class === "done" ? unwrapList(frames.results?.stack, "frame").map(frameOf) : []
  const usable = list.filter((f): f is Frame => f !== undefined).map((f) => displayFrame(f, options.relativeTo))
  if (usable.length) lines.push(...renderFrames(usable))
  else if (stop.frame) lines.push(`  ${renderFrame(displayFrame(stop.frame, options.relativeTo), 0)}`)

  const locals = await session.send("-stack-list-variables --simple-values").catch(() => undefined)
  if (locals?.class === "done") {
    const vars = unwrapList(locals.results?.variables)
    let optimisedOut = 0
    const rendered = vars.map((v) => {
      const name = miString(v.name) ?? "?"
      const value = miString(v.value)
      if (value !== undefined) {
        if (value === "<optimized out>") optimisedOut++
        return `${name}=${value}`
      }
      // --simple-values 对聚合类型**只给 type,不给 value**。把它当 <optimized out> 会让模型断定"这个变量被
      // 优化掉了",而它其实只是个结构体 —— 两个结论引出的下一步完全不同。
      const type = miString(v.type)
      return type ? `${name}: ${type}(用 eval "p ${name}" 展开)` : name
    })
    if (rendered.length) {
      lines.push(`  locals: ${clip(rendered.join(", "), 400)}`)
      if (optimisedOut > 0) {
        lines.push(`  (${optimisedOut} 个局部变量是 <optimized out> —— 不要把它当作"没赋值"或"没执行到")`)
      }
    }
  }

  for (const expr of options.show ?? []) {
    const r = await session.send(`-data-evaluate-expression "${escapeCString(expr)}"`).catch(() => undefined)
    const value = r?.class === "done" ? miString(r.results?.value) : `<${miString(r?.results?.msg) ?? "error"}>`
    lines.push(`  ${expr} = ${clip(value ?? "?", 200)}`)
  }

  if (options.buildNote) lines.push(`  ${options.buildNote}`)
  // 停下来之后固件当然不再打日志。不说这一句,模型会去问 log 然后断定固件死了。
  if (session.state === "halted") lines.push("  (目标已暂停 —— 在 exec continue 之前它不会再产生任何日志输出)")
  return lines.join("\n")
}

// ─── 源码路径与镜像 ──────────────────────────────────────────────────────────

/**
 * 源码路径映射。DWARF 里存的是**编译那台机器上的绝对路径**;项目挪过窝、在 CI 里编的、或者容器里编的,这个路径
 * 在本机根本不存在,于是每次停止的"源码行"都是空的,而模型会由此断定 ELF 没有调试信息,然后跑去查构建系统。
 */
export async function fixSourcePaths(session: GdbSession, cwd: string): Promise<string | undefined> {
  const r = await session.send("-file-list-exec-source-files").catch(() => undefined)
  if (!r || r.class !== "done") return undefined
  const files = unwrapList(r.results?.files)
    .map((f) => miString(f.fullname))
    .filter((f): f is string => !!f && path.isAbsolute(f))
    .slice(0, 40)
  if (files.length === 0) return undefined

  const missingFiles = files.filter((full) => !existsSync(full))
  const missing = missingFiles.length
  if (!missing) return undefined

  // 从最短的后缀开始往回试:找到工作区里同名同层级的那个文件,前缀差就是映射。第一个能映射上的就定案。
  let mapped: { from: string; to: string } | undefined
  for (const full of missingFiles) {
    if (mapped) break
    const parts = full.split(/[\\/]/).filter(Boolean)
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = path.join(cwd, ...parts.slice(i))
      if (existsSync(candidate)) {
        const sep = full.includes("\\") && !full.includes("/") ? "\\" : "/"
        const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? ""
        mapped = { from: `${drive}${sep}${parts.slice(drive ? 1 : 0, i).join(sep)}`, to: cwd }
        break
      }
    }
  }
  if (mapped) {
    await session.console(`set substitute-path ${mapped.from} ${mapped.to}`).catch(() => undefined)
    return `source paths: ${missing} of ${files.length} compile-time paths do not exist here; mapped ${mapped.from} → ${mapped.to}`
  }
  return `⚠ source paths: ${missing} of ${files.length} compile-time paths do not exist on this machine and could not be mapped — line numbers cannot be verified against local sources`
}

/** ELF 与片子里的镜像对不上,是整套工具里最贵、而且**没有任何错误文本**的失败。 */
export async function verifyImage(cwd: string, elf: string): Promise<{ ok: boolean; note: string }> {
  const state = await readFlashState(cwd)
  if (!state) {
    return {
      ok: true,
      note: "image: UNVERIFIED — no flash record from this workspace; if you did not just flash this ELF, line numbers and values may describe code that is not running",
    }
  }
  const sha = await sha256File(elf).catch(() => undefined)
  const age = Math.round((Date.now() - state.at) / 60_000)
  if (sha && sha === state.sha256) return { ok: true, note: `image: verified against the last flash (${age} min ago)` }
  return {
    ok: false,
    note:
      `image: MISMATCH — .yoma/flash-state.json records ${state.elfPath} flashed ${age} min ago, ` +
      "which is not this ELF. Every line number, local and backtrace below would describe code that is not running. " +
      "Re-flash this ELF (flash tool, with elfPath), or pass allowUnverified: true if you know the difference does not matter.",
  }
}

// ─── gdb 二进制定位 ──────────────────────────────────────────────────────────

/** 只读 ELF 头的 0x14 字节:整读会为一个带调试信息的 ELF 拉起几十 MB 的临时 buffer。读不到就按未知架构。 */
export async function elfMachineOf(elf: string): Promise<number | undefined> {
  const head = new Uint8Array(ELF_HEADER_BYTES)
  try {
    const fh = await openFile(elf, "r")
    try {
      await fh.read(head, 0, ELF_HEADER_BYTES, 0)
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
  return elfMachine(head)
}

export interface ResolveGdbResult {
  gdbPath: string
  tried: string[]
}

/**
 * 按 ELF 的架构挑 gdb:显式路径 > `YOMA_GDB` > 按架构排的候选名在 PATH 上找。
 * 找不到时的报错要点名试过哪几个,并给出安装指引,而不是一个裸的 spawn 错误。
 */
export function resolveGdbPath(
  machine: number | undefined,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolveGdbResult {
  if (override) return { gdbPath: override, tried: [override] }
  const fromEnv = env.YOMA_GDB?.trim()
  if (fromEnv) return { gdbPath: fromEnv, tried: [fromEnv] }
  const tried = preferredGdbNames(machine)
  for (const name of tried) {
    const found = findOnPath(name, env)
    if (found) return { gdbPath: found, tried }
  }
  throw new Error(
    `no usable gdb found (tried ${tried.join(", ")} on PATH). Install the Arm GNU Toolchain ` +
      '(toolchain install id:"arm-gdb", or brew install --cask gcc-arm-embedded) or pass gdbPath. ' +
      "Do NOT run `npm run engines:build` — gdb is a toolchain binary, not an engine.",
  )
}

/** 停在有源码的位置时给编辑器用。文件在本机不存在就**不填**(见 fixSourcePaths)。 */
export function locationOf(frame: Frame | undefined): { path: string; line: number } | undefined {
  if (!frame?.fullname || !frame.line) return undefined
  const line = Number(frame.line)
  if (!Number.isFinite(line)) return undefined
  try {
    if (!statSync(frame.fullname).isFile()) return undefined
  } catch {
    return undefined
  }
  return { path: frame.fullname, line }
}

/** `struct x *` / `foo_t *`(不含 char / void / 函数指针):值是地址,展开的是它指向的东西。 */
function isAggregatePointer(type: string | undefined): boolean {
  if (!type || !/\*\s*$/.test(type) || /\*\s*\*\s*$/.test(type)) return false
  if (/\(/.test(type)) return false
  return !/^(const\s+)?(volatile\s+)?(unsigned\s+|signed\s+)?(char|void|u?int\d*_t|short|int|long|float|double|bool|_Bool|u8|u16|u32|i8|i16|i32)\b/.test(type)
}

/**
 * 这个指针能不能自动解引用。**只在认出是 Cortex-M 时**,且只认代码 / SRAM(0x0000_0001–0x3FFF_FFFF)与
 * 外部存储器(0x6000_0000–0x9FFF_FFFF):外设区 0x4000_0000–0x5FFF_FFFF 与 0xA000_0000 以上的系统区一律不碰。
 * 读外设寄存器不是无害的 —— USART 先读 SR 再读 DR 会清掉 RXNE / ORE、丢掉收到的字节,SPI 读 DR 会弹出
 * RX FIFO;没初始化的指针局部变量里的旧栈值也可能指向外设区,时钟没开的外设在一些芯片上会把调试口读挂。
 * 而这件事每次停住都会发生,用户什么都没点。
 */
export function safeToDereference(value: string | undefined, cortexM: boolean): boolean {
  if (!cortexM || !value) return false
  const match = /^(0x[0-9a-f]+)\b/i.exec(value.trim())
  if (!match) return false
  const addr = Number(match[1])
  if (!Number.isFinite(addr) || addr === 0) return false
  return addr < 0x4000_0000 || (addr >= 0x6000_0000 && addr < 0xa000_0000)
}

/** 监视表达式最多几条、每条多长:界面的监视列表,不是脚本入口。 */
export const WATCH_LIMIT = 20
const WATCH_EXPR_LIMIT = 200

type HaltedReadings = Omit<GdbInspect, "breakpoints" | "breakpointBudget" | "sources">

/**
 * 手动调试界面要的快照。目标没停时只回断点表,不发 MI —— status 在 continue 等停止的
 * 那几十秒里必须立刻回来,而 send 是串行的,多一条命令就会排到那次 resume 后面。
 *
 * 停住时的读数按 (epoch, 第几次停止, inspectVersion, 帧, 监视列表) 缓存:界面每 2.5 秒轮询一次,
 * 目标停着不动时第二次起一条 MI 都不发 —— 否则每次几十条命令,真探针上慢,会话日志(模型要读的那份)
 * 被刷满。任何非 status 的动作(agent 的也算)都会让 inspectVersion 变,缓存随之作废。
 */
export async function captureInspect(
  session: GdbSession,
  core: CoreProbe,
  frame?: number,
  watch: readonly string[] = [],
): Promise<GdbInspect> {
  const breakpoints = [...session.breakpoints.entries()].map(([number, bp]) => ({
    number,
    kind: bp.kind,
    location: bp.location,
    ...(bp.addr ? { addr: bp.addr } : {}),
    ...(bp.file ? { file: bp.file } : {}),
    ...(bp.line ? { line: bp.line } : {}),
    enabled: true,
  }))
  const breakpointBudget = {
    used: session.usedUnits("break"),
    ...(core.breakpointUnits ? { total: core.breakpointUnits } : {}),
  }
  const cachedSources = () => (session.sourceFiles ? { sources: session.sourceFiles } : {})
  if (session.state !== "halted") {
    return { frames: [], locals: [], selectedFrame: 0, breakpoints, registers: [], breakpointBudget, ...cachedSources() }
  }
  if (!session.sourceFiles) {
    const reply = await session.send("-file-list-exec-source-files").catch(() => undefined)
    if (reply?.class === "done") session.sourceFiles = sourceFilesOf(unwrapList(reply.results?.files), existsSync)
  }

  const list = watch
    .slice(0, WATCH_LIMIT)
    .map((item) => item.trim().slice(0, WATCH_EXPR_LIMIT))
    .filter(Boolean)
  const key = JSON.stringify([session.epoch, session.stopCount, session.inspectVersion, frame ?? null, list])
  let readings = session.inspectCache?.key === key ? (session.inspectCache.value as HaltedReadings) : undefined
  if (!readings) {
    const version = session.inspectVersion
    readings = await readHalted(session, core, frame, list)
    // 读的这几十毫秒里有别的动作插进来(status 不排队)的话,这一份可能半新半旧:不缓存。
    if (version === session.inspectVersion) session.inspectCache = { key, value: readings }
  }
  return { ...readings, breakpoints, breakpointBudget, ...cachedSources() }
}

async function readHalted(
  session: GdbSession,
  core: CoreProbe,
  frame: number | undefined,
  watch: readonly string[],
): Promise<HaltedReadings> {
  // 不 `-stack-select-frame`:选中帧是 gdb 全局的,和 agent 共用。界面点了第 1 帧,agent 下一句
  // `p local_sq` 就会在 main 里找 —— QEMU 实测报 "No symbol in current context"。所以只读,
  // 用 `--thread/--frame` 逐条指定;status 不排队,这样每条命令也各自原子,不怕和 exec 交错。
  const threads = await session.send("-thread-info").catch(() => undefined)
  const thread = threads?.class === "done" ? miString(threads.results?.["current-thread-id"]) : undefined
  const info = await session.send("-stack-info-frame").catch(() => undefined)
  const current = miNumber(miTuple(info?.results?.frame)?.level) ?? 0

  const framesReply = await session.send("-stack-list-frames 0 7").catch(() => undefined)
  const raw =
    framesReply?.class === "done"
      ? unwrapList(framesReply.results?.stack, "frame")
          .map(frameOf)
          .filter((item): item is Frame => item !== undefined)
      : []
  const frames = framesOf(raw).map((item) => {
    const at = locationOf({ fullname: item.fullname, line: item.line !== undefined ? String(item.line) : undefined })
    return {
      level: item.level,
      ...(item.func ? { func: item.func } : {}),
      ...(item.file ? { file: item.file } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      ...(item.addr ? { addr: item.addr } : {}),
      ...(at ? { path: at.path } : {}),
    }
  })

  const wanted = frame !== undefined && thread && frames.some((item) => item.level === frame) ? frame : undefined
  const selected = wanted ?? current
  const scope = wanted !== undefined ? ` --thread ${thread} --frame ${wanted}` : ""

  const localsReply = await session.send(`-stack-list-variables${scope} --simple-values`).catch(() => undefined)
  const locals = localsReply?.class === "done" ? localsOf(unwrapList(localsReply.results?.variables)) : []
  // --simple-values 只给结构体 / 数组一个类型名。逐个求一次整段值,界面拆成可展开的树。
  // 最多 8 个:一次停止多几条 MI,几毫秒;再多就该用 -var-create 按需展开了。
  // 指向结构体的指针(`struct frame *`)同样值得展开:求 `*p` —— 但只在指针落在内存区时(见 safeToDereference)。
  const cortexM = !!core.core
  const expandable = locals
    .filter((item) => item.value === undefined || (isAggregatePointer(item.type) && safeToDereference(item.value, cortexM)))
    .slice(0, 8)
  for (const local of expandable) {
    const expr = local.value === undefined ? local.name : `*${local.name}`
    const reply = await session
      .send(`-data-evaluate-expression${scope} "${escapeCString(expr)}"`)
      .catch(() => undefined)
    const text = reply?.class === "done" ? miString(reply.results?.value) : undefined
    if (text) local.detail = clipDetail(text)
  }

  const namesReply = await session.send("-data-list-register-names").catch(() => undefined)
  const valuesReply = await session.send(`-data-list-register-values${scope} x`).catch(() => undefined)
  const names = namesReply?.class === "done" ? registerNamesOf(namesReply.results?.["register-names"]) : []
  const values =
    valuesReply?.class === "done" ? registerValuesOf(unwrapList(valuesReply.results?.["register-values"])) : new Map()

  const registers = pickRegisters(names, values)
  const exception = exceptionOf(registers)

  // 选中帧所在函数的反汇编。-a 取整个函数;地址不在任何符号里(异常入口、坏 PC)时退回按地址窗口取。
  const pc = frames.find((item) => item.level === selected)?.addr
  let disassembly: ReturnType<typeof asmLinesOf> = []
  if (pc && Number(pc) < 0xf0000000) {
    let reply = await session.send(`-data-disassemble -a ${pc} -- 0`).catch(() => undefined)
    if (reply?.class !== "done") {
      reply = await session.send(`-data-disassemble -s ${pc}-32 -e ${pc}+96 -- 0`).catch(() => undefined)
    }
    if (reply?.class === "done") disassembly = asmLinesOf(unwrapList(reply.results?.asm_insns), pc)
  }

  const watches: { expr: string; value?: string; error?: string }[] = []
  for (const expr of watch) {
    if (expressionWrites(expr)) {
      watches.push({ expr, error: "writes the target — not evaluated" })
      continue
    }
    // 函数调用会在目标上真的执行(inferior call):卡住就拖死整个会话,撞上断点就留下一次停止。
    if (expressionCalls(expr)) {
      watches.push({ expr, error: "calls a function on the target — not evaluated" })
      continue
    }
    const reply = await session
      .send(`-data-evaluate-expression${scope} "${escapeCString(expr)}"`)
      .catch(() => undefined)
    if (reply?.class === "done") watches.push({ expr, value: clipDetail(miString(reply.results?.value) ?? "") })
    else watches.push({ expr, error: miString(reply?.results?.msg) ?? "no value" })
  }

  // gdb 13 之前(mi/20684 修掉之前)`--frame N` 会把选中帧永久留在 N:读完挪回去,新 gdb 上这一条是空操作。
  if (wanted !== undefined && wanted !== current) {
    await session.send(`-stack-select-frame ${current}`).catch(() => undefined)
  }

  return {
    frames,
    locals,
    selectedFrame: selected,
    registers,
    ...(exception ? { exception } : {}),
    ...(pc ? { pc } : {}),
    ...(disassembly.length ? { disassembly } : {}),
    ...(watch.length ? { watches } : {}),
  }
}
