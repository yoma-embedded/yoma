/**
 * Cortex-M 的寄存器语义:CPUID、故障状态、EXC_RETURN、异常入栈帧、断点/观察点预算。
 *
 * 这一段是"板子为什么死了"的答案。做成纯函数有两个理由:一是它零硬件可单测,
 * 二是模型自己解码这些位是**已知会错**的 —— 拿 handler 自己的 $pc 当崩溃点、
 * 把 HFSR=0x40000000 当答案、BFARVALID=0 了还信 BFAR。这些错误一旦进了上下文
 * 就会被当成事实继续推理,所以宁可工具替它算。
 *
 * 数值全部按无符号 32 位处理(`>>> 0`):JS 的按位运算结果是有符号 32 位,
 * 0xfffffffd & 0xffffff00 直接比较会得到 -256。
 */

/** 系统控制块与调试寄存器的地址(ARMv7-M 私有外设总线,所有 Cortex-M 相同)。 */
export const SCB = {
  CPUID: 0xe000ed00,
  ICSR: 0xe000ed04,
  VTOR: 0xe000ed08,
  AIRCR: 0xe000ed0c,
  SCR: 0xe000ed10,
  CCR: 0xe000ed14,
  SHCSR: 0xe000ed24,
  CFSR: 0xe000ed28,
  HFSR: 0xe000ed2c,
  DFSR: 0xe000ed30,
  MMFAR: 0xe000ed34,
  BFAR: 0xe000ed38,
  AFSR: 0xe000ed3c,
  DHCSR: 0xe000edf0,
  DEMCR: 0xe000edfc,
  FP_CTRL: 0xe0002000,
  DWT_CTRL: 0xe0001000,
} as const

/** 从 -data-read-memory-bytes 回来的十六进制字节串按内存顺序拼成 32 位字;Cortex-M 是小端。 */
export function hexToWords(contents: string): number[] {
  const words: number[] = []
  for (let i = 0; i + 8 <= contents.length; i += 8) {
    const b = [0, 1, 2, 3].map((k) => Number.parseInt(contents.slice(i + k * 2, i + k * 2 + 2), 16))
    words.push(((b[3]! << 24) | (b[2]! << 16) | (b[1]! << 8) | b[0]!) >>> 0)
  }
  return words
}

export interface CoreId {
  /** CPUID[31:24]。只有 ARM_IMPLEMENTER 的才该按下面的表解;别家(RISC-V 目标上读到的垃圾)不是 Cortex-M。 */
  implementer: number
  partno: number
  name: string
  /**
   * ARMv6-M(M0/M0+/M1)与 ARMv8-M baseline(M23)没有 CFSR/HFSR/MMFAR/BFAR —— 那几个寄存器属于
   * ARMv8-M 的 Main Extension,baseline 核不带,读出来是零,不能去解码零。
   */
  hasConfigurableFaults: boolean
  revision: string
}

const PARTNO_NAMES: Record<number, string> = {
  0xc20: "Cortex-M0",
  0xc21: "Cortex-M1",
  0xc23: "Cortex-M3",
  0xc24: "Cortex-M4",
  0xc27: "Cortex-M7",
  0xc60: "Cortex-M0+",
  0xd20: "Cortex-M23",
  0xd21: "Cortex-M33",
  0xd22: "Cortex-M55",
  0xd23: "Cortex-M85",
  0xd24: "Cortex-M52",
  0xd31: "Cortex-M35P",
}

/** ARMv6-M / ARMv8-M baseline:没有可配置故障寄存器。没列进表的核一律按 mainline 对待(M35P / M52 都是)。 */
const BASELINE_PARTNOS = new Set([0xc20, 0xc21, 0xc60, 0xd20])

/** CPUID[31:24] = 0x41 是 ARM。 */
export const ARM_IMPLEMENTER = 0x41

export function decodeCpuid(cpuid: number): CoreId {
  const partno = (cpuid >>> 4) & 0xfff
  return {
    implementer: cpuid >>> 24,
    partno,
    name: PARTNO_NAMES[partno] ?? `unknown core (PARTNO 0x${partno.toString(16)})`,
    hasConfigurableFaults: !BASELINE_PARTNOS.has(partno),
    revision: `r${(cpuid >>> 20) & 0xf}p${cpuid & 0xf}`,
  }
}

export interface Flag {
  bit: number
  name: string
  meaning: string
}

function flags(value: number, table: Flag[]): Flag[] {
  return table.filter((f) => (value >>> f.bit) & 1)
}

const MMFSR_FLAGS: Flag[] = [
  { bit: 0, name: "IACCVIOL", meaning: "取指越权(MPU 禁止执行这块地址)" },
  { bit: 1, name: "DACCVIOL", meaning: "数据访问越权(MPU 拒绝)" },
  { bit: 3, name: "MUNSTKERR", meaning: "异常返回出栈时越权" },
  { bit: 4, name: "MSTKERR", meaning: "异常入栈时越权 —— 多半是栈指针跑飞了" },
  { bit: 5, name: "MLSPERR", meaning: "浮点惰性入栈时越权" },
  { bit: 7, name: "MMARVALID", meaning: "MMFAR 里的地址有效" },
]

const BFSR_FLAGS: Flag[] = [
  { bit: 8, name: "IBUSERR", meaning: "取指总线错误(跳到了不存在的地址)" },
  { bit: 9, name: "PRECISERR", meaning: "精确数据总线错误 —— BFAR 就是出事地址" },
  // 可信与否按组合定(见 decodeFault 的尾句):单独出现时地址与 PC 都不可信,与 PRECISERR 并存时 BFAR 属于精确那次。
  { bit: 10, name: "IMPRECISERR", meaning: "非精确总线错误 —— 写缓冲延迟命中,入栈的 PC 不是出事那条指令" },
  { bit: 11, name: "UNSTKERR", meaning: "异常返回出栈时总线错误" },
  { bit: 12, name: "STKERR", meaning: "异常入栈时总线错误 —— 典型的栈溢出" },
  { bit: 13, name: "LSPERR", meaning: "浮点惰性入栈时总线错误" },
  { bit: 15, name: "BFARVALID", meaning: "BFAR 里的地址有效" },
]

const UFSR_FLAGS: Flag[] = [
  { bit: 16, name: "UNDEFINSTR", meaning: "未定义指令 —— 多半是跳进了数据区" },
  { bit: 17, name: "INVSTATE", meaning: "非法状态 —— 函数指针的 Thumb 位没置 1(常见:空指针调用)" },
  { bit: 18, name: "INVPC", meaning: "非法 EXC_RETURN,异常返回被破坏" },
  { bit: 19, name: "NOCP", meaning: "协处理器不可用 —— 用了浮点但没使能 FPU(CPACR)" },
  // ARMv8-M 独有(ARMv7-M 上这一位恒为 0):MSPLIM / PSPLIM 栈限检查失败 —— 硬件层面的栈溢出证据。
  { bit: 20, name: "STKOF", meaning: "栈越过 PSPLIM/MSPLIM(ARMv8-M 栈限检查)—— 栈溢出" },
  { bit: 24, name: "UNALIGNED", meaning: "非对齐访问(CCR.UNALIGN_TRP 打开时才报)" },
  { bit: 25, name: "DIVBYZERO", meaning: "除零(CCR.DIV_0_TRP 打开时才报)" },
]

const HFSR_FLAGS: Flag[] = [
  { bit: 1, name: "VECTTBL", meaning: "读向量表时总线错误 —— VTOR 指错了地方" },
  { bit: 30, name: "FORCED", meaning: "由可配置故障升级而来 —— 真正的原因在 CFSR" },
  { bit: 31, name: "DEBUGEVT", meaning: "调试事件" },
]

const DFSR_FLAGS: Flag[] = [
  { bit: 0, name: "HALTED", meaning: "调试器主动暂停" },
  { bit: 1, name: "BKPT", meaning: "断点(FPB 命中,或固件里的 BKPT 指令 / 半主机调用)" },
  { bit: 2, name: "DWTTRAP", meaning: "DWT 观察点命中" },
  { bit: 3, name: "VCATCH", meaning: "向量捕获" },
  { bit: 4, name: "EXTERNAL", meaning: "外部调试请求" },
]

const DHCSR_FLAGS: Flag[] = [
  { bit: 17, name: "S_HALT", meaning: "内核已暂停" },
  { bit: 18, name: "S_SLEEP", meaning: "内核在睡眠(WFI/WFE)" },
  { bit: 19, name: "S_LOCKUP", meaning: "内核锁死 —— 故障处理里又故障了,$pc 读出来是 0xEFFFFFFE" },
  { bit: 25, name: "S_RESET_ST", meaning: "上次读之后发生过复位(粘滞位)" },
]

export interface FaultDecode {
  /** 一句话结论,给模型读的。 */
  summary: string
  mmfsr: Flag[]
  bfsr: Flag[]
  ufsr: Flag[]
  hfsr: Flag[]
  /** 出事地址;没有有效地址时是 undefined —— BFARVALID=0 时**绝不**返回 BFAR。两个都有效时取 BFAR。 */
  faultAddress?: number
  /** BFARVALID=1 时的 BFAR。 */
  bfar?: number
  /** MMARVALID=1 时的 MMFAR。 */
  mmfar?: number
  /** 有非精确总线错误:入栈的 PC 不能当作出事那条指令,不能据此报源码行。 */
  imprecise: boolean
}

/** decodeFault 的输入按寄存器名传,四个 u32 按位置传的话,MMFAR / BFAR 换个位置类型系统看不出来。 */
export interface FaultRegisters {
  cfsr: number
  hfsr: number
  mmfar: number
  bfar: number
}

const hex32 = (n: number): string => `0x${(n >>> 0).toString(16).padStart(8, "0")}`

/**
 * CFSR + HFSR 解码。baseline 核上这两个寄存器不存在,调用方要先看 CoreId。
 * 四条不能省的纪律:
 * - HFSR.FORCED 不是答案,只是"去看 CFSR"的指针;CFSR 里什么都没有时要说出"多半已经被清零"这层意思;
 * - BFARVALID / MMARVALID 为 0 时 BFAR/MMFAR 是陈旧值,报出去会冤枉无辜代码;
 * - 地址要带上是哪个寄存器给的,两个都有效时两个都说(那是两次粘滞的故障);
 * - IMPRECISERR 置位时入栈的 PC 不可信(写缓冲延迟命中):只有它一个时地址与 PC 都不可信;和 PRECISERR
 *   同时置位时 BFAR 属于精确的那一次(规范:非精确错误不写 BFAR),只有 PC 要打折。
 */
export function decodeFault(regs: FaultRegisters): FaultDecode {
  const { cfsr, hfsr } = regs
  const mmfsr = flags(cfsr, MMFSR_FLAGS)
  const bfsr = flags(cfsr, BFSR_FLAGS)
  const ufsr = flags(cfsr, UFSR_FLAGS)
  const hf = flags(hfsr, HFSR_FLAGS)

  const precise = ((cfsr >>> 9) & 1) === 1
  const imprecise = ((cfsr >>> 10) & 1) === 1
  const bfar = ((cfsr >>> 15) & 1) === 1 ? regs.bfar >>> 0 : undefined
  const mmfar = ((cfsr >>> 7) & 1) === 1 ? regs.mmfar >>> 0 : undefined
  const faultAddress = bfar ?? mmfar

  const named = [...mmfsr, ...bfsr, ...ufsr].filter((f) => f.name !== "BFARVALID" && f.name !== "MMARVALID")
  const describe = (list: Flag[]) => list.map((f) => `${f.name}(${f.meaning})`).join("; ")
  let summary: string
  if (named.length === 0) {
    if (cfsr === 0 && hfsr === 0) {
      summary = "没有故障位置位 —— 这次停止不是故障(检查 DFSR:断点/单步/调试器暂停)"
    } else {
      const parts: string[] = []
      if (hf.length > 0) parts.push(`HFSR:${describe(hf)}`)
      else if (hfsr !== 0) parts.push(`HFSR=${hex32(hfsr)} 里只有本表不认识的位`)
      if (cfsr !== 0) parts.push(`CFSR=${hex32(cfsr)} 里只有本表不认识的位`)
      else if (hf.some((f) => f.name === "FORCED")) {
        parts.push(
          "可配置故障升级成了 HardFault,但 CFSR 里已经没有故障位 —— 多半被处理代码写 1 清零了,读到的是清零之后的现场",
        )
      }
      summary = parts.join(";")
    }
  } else {
    summary = describe(named)
    if (bfar !== undefined) summary += `;出事地址 BFAR=${hex32(bfar)}`
    if (mmfar !== undefined) {
      summary += bfar !== undefined ? `(MMFAR=${hex32(mmfar)} 也有效)` : `;出事地址 MMFAR=${hex32(mmfar)}`
    }
    if (imprecise) {
      summary += precise
        ? ";另有一次非精确总线错误:它没有记录地址,入栈的 PC 不一定是它的现场"
        : ";⚠ 非精确 —— 出事地址与 PC 都不可信,别据此定位源码行"
    }
  }
  return { summary, mmfsr, bfsr, ufsr, hfsr: hf, faultAddress, bfar, mmfar, imprecise }
}

export function decodeDfsr(dfsr: number): Flag[] {
  return flags(dfsr, DFSR_FLAGS)
}

export function decodeDhcsr(dhcsr: number): Flag[] {
  return flags(dhcsr, DHCSR_FLAGS)
}

/** ICSR.VECTACTIVE:0=线程模式,2=NMI,3=HardFault,…,≥16 是外设中断。 */
export function decodeException(icsr: number): { vectactive: number; name: string; inHandler: boolean } {
  const v = icsr & 0x1ff
  const builtin: Record<number, string> = {
    0: "Thread mode",
    1: "Reset",
    2: "NMI",
    3: "HardFault",
    4: "MemManage",
    5: "BusFault",
    6: "UsageFault",
    7: "SecureFault",
    11: "SVCall",
    12: "DebugMonitor",
    14: "PendSV",
    15: "SysTick",
  }
  const name = builtin[v] ?? (v >= 16 ? `IRQ ${v - 16}` : `reserved (${v})`)
  return { vectactive: v, name, inHandler: v !== 0 }
}

export interface ExcReturnInfo {
  /** 入栈用的是 PSP 还是 MSP —— 读错栈就等于读了一堆无关的字。 */
  stackPointer: "MSP" | "PSP"
  mode: "Handler" | "Thread"
  /** 扩展帧多压 18 个字(S0-S15 + FPSCR + 保留)。 */
  extendedFrame: boolean
  valid: boolean
}

/**
 * EXC_RETURN(异常里的 LR)解码。ARMv7-M:
 *   bit 2 = SPSEL(1→PSP)  bit 3 = Mode(1→Thread)  bit 4 = 0 表示带浮点的扩展帧
 */
export function decodeExcReturn(lr: number): ExcReturnInfo {
  const v = lr >>> 0
  return {
    stackPointer: (v & 0x4) !== 0 ? "PSP" : "MSP",
    mode: (v & 0x8) !== 0 ? "Thread" : "Handler",
    extendedFrame: (v & 0x10) === 0,
    valid: (v & 0xffffff00) >>> 0 === 0xffffff00,
  }
}

export interface StackedFrame {
  r0: number
  r1: number
  r2: number
  r3: number
  r12: number
  lr: number
  pc: number
  xpsr: number
  /** xPSR bit 9:入栈时为了 8 字节对齐多塞了 4 字节。 */
  padded: boolean
}

/**
 * 从 8 个字还原异常入栈帧。**这是整个故障分析的关键一步**:
 * handler 自己的 $pc/$sp 指的是 handler,出事的现场在这个帧里。
 */
export function decodeStackedFrame(words: number[]): StackedFrame | undefined {
  if (words.length < 8) return undefined
  const [r0, r1, r2, r3, r12, lr, pc, xpsr] = words as [number, number, number, number, number, number, number, number]
  return {
    r0: r0 >>> 0,
    r1: r1 >>> 0,
    r2: r2 >>> 0,
    r3: r3 >>> 0,
    r12: r12 >>> 0,
    lr: lr >>> 0,
    pc: pc >>> 0,
    xpsr: xpsr >>> 0,
    padded: ((xpsr >>> 9) & 1) === 1,
  }
}

/**
 * FP_CTRL.NUM_CODE 是拆成两段的:[14:12] 是高 3 位,[7:4] 是低 4 位。
 *
 * total 为 0 不是"预算是零"而是"不知道":QEMU 不模拟 FPB,这个寄存器读出来整个是 0(实测),而规范里
 * NUM_CODE=0 又确实合法(没有比较器)。调用方拿到 0 就别按预算拒断点,让 gdb 的 Z0 回复说了算。
 */
export function decodeBreakpointUnits(fpCtrl: number): { total: number; enabled: boolean } {
  const total = (((fpCtrl >>> 12) & 0x7) << 4) | ((fpCtrl >>> 4) & 0xf)
  return { total, enabled: (fpCtrl & 1) === 1 }
}

/** DWT_CTRL.NUMCOMP:[31:28]。M3/M4/M7 一般 4 个,M0+/M23 是 2 个。0 同上:当"不知道"而不是"没有"。 */
export function decodeWatchpointUnits(dwtCtrl: number): number {
  return (dwtCtrl >>> 28) & 0xf
}
