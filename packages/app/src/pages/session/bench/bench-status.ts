/**
 * 调试工作台的状态视图模型 —— 从会话 transcript 的工具卡片里读出"板子现在是什么样"。
 *
 * 为什么在这里读:内核没有"目标状态"这个 RPC,也不该有 —— 真相已经在 transcript 里了
 * (agent 每跑一次 flash / gdb / log,结果都带着结构化的 `details` 进了 `state.metadata`)。
 * 这一层只做一件事:**按源序把它们折成一份现状**。
 *
 * 三条纪律:
 * 1. **纯函数**。`deriveBenchStatus(parts)` 不碰 solid、不碰 RPC、不碰时间。测试直接喂夹具。
 * 2. **防御着读 `metadata`**。它的类型是 `Record<string, unknown>`,跨进程来的;工具抛错时
 *    projector 给的是 `{}`(host/projector.ts 的 `asDetails`)。任何字段都可能不在、可能是别的类型,
 *    这里一律先验型再用,**绝不抛**。一个坏形状最多让这一格没有值,不该把整个右栏炸掉。
 * 3. **末值优先,但不覆盖已知值**。某一次调用抛了错(metadata 是空的)不代表"采集停了"——
 *    折叠时只更新这一次真的说了的字段。
 *
 * 形状的来源(全部逐字对过 contract.ts):
 * - flash `{ command: string[]; exitCode: number|null; recordedElf?: string }`
 * - log   `{ action; running; cursor; totalLines; dropped; source?; file?; matched?; exitCode? }`
 * - gdb   `{ action; state: "halted"|"running"|"exited"|"connection-lost"|"no-session"; epoch; stopId;
 *            connection?; file?; path?; line? }`
 * - la / scope `{ action; captureId?; dir?; … }`
 * 故障与停止现场**不在 details 里**,只在给模型的输出文本里(`■ stopped#N: …` / `故障(HardFault):…`),
 * 所以这一层也解析那几行 —— 见 `parseStopReport`。
 */
import type { ToolPart } from "@yoma-desktop/kernel"

/** 注册表里的仪器。将来加 power / host 时只改这一行和 instruments.ts 里那条记录。 */
export type InstrumentId = "log" | "gdb" | "la" | "scope"

/** 状态条上会出现的东西:仪器 + 烧录(烧录是动作不是仪器,所以它不在 InstrumentId 里)。 */
export type BenchToolId = InstrumentId | "flash"

export const INSTRUMENT_IDS: readonly InstrumentId[] = ["log", "gdb", "la", "scope"]
const BENCH_TOOLS: readonly BenchToolId[] = ["flash", "log", "gdb", "la", "scope"]

// ---------------------------------------------------------------- 视图模型

export interface FlashStatus {
  /** 退出码 0。工具抛错(超时/杀树)时是 false 且 `exitCode` 为 null。 */
  ok: boolean
  exitCode: number | null
  /** 烧录命令拼成的一行 —— 与确认条上那条同源(契约的 `flashSummary`)。 */
  command: string
  /** 记进 flash-state 的镜像绝对路径;只有 exit 0 且调用时给了 elfPath 才有。 */
  image?: string
  /** 完成时刻(epoch ms)。 */
  at: number
  /** 工具抛错时的原文。 */
  error?: string
}

/**
 * `attached` 是"有会话但说不出更细的" —— details 的 state 只有四个值加 no-session,
 * 所以它只在 metadata 缺失/畸形而 transcript 里确实起过 gdb 时出现。
 */
export type GdbState = "none" | "attached" | "halted" | "running" | "exited" | "connection-lost"

export interface GdbStop {
  /** 这次会话里第几次停止(gdb 的 stopId);复位换 epoch 之后会从头数。 */
  n: number
  epoch: number
  /** `breakpoint-hit` / `end-stepping-range` / `signal-received` … */
  reason: string
  /** `main.c:200`,没有源码位置时没有。 */
  location?: string
  /** 这次停止是故障时的那一句(`故障(HardFault):…`)。 */
  fault?: string
  at: number
}

export interface GdbStatus {
  state: GdbState
  /** 停在哪:`main.c:200`。 */
  location?: string
  /** 本机存在的源码绝对路径(details.path);不存在时没有,不要拿去开编辑器。 */
  path?: string
  line?: number
  /** `localhost:3333`。 */
  connection?: string
  epoch: number
  /** 最后一次停止报告的正文(从 `■` 那行起,截断过)。 */
  report?: string
  /** 最后一次停止是故障时的摘要行。 */
  fault?: string
  /** 故障发生处(`foc.c:45`);只在 `fault` 有值时才有。 */
  faultLocation?: string
  /** 本次会话里的停止历史,源序,最多 `MAX_STOPS` 条。 */
  stops: GdbStop[]
  at: number
}

export type LogSourceKind = "serial" | "tcp" | "command"

export interface LogStatus {
  /** 采集器还在跑(details.running,按子进程的 'close' 判,不是 'exit')。 */
  capturing: boolean
  /** 原样的来源串:`serial /dev/cu.usbmodem1103 @ 115200 8N1` / `tcp localhost:19021` / 命令行。 */
  source?: string
  kind?: LogSourceKind
  /** serial 的设备名 / tcp 的 `host:port`。 */
  port?: string
  baud?: number
  /** 落盘的全量日志绝对路径。 */
  file?: string
  totalLines: number
  dropped: number
  /** 来源已经退出时的退出码(TCP 没有)。 */
  exitCode?: number | null
  at: number
}

export interface CaptureStatus {
  id?: string
  /** 采集目录绝对路径(la.view / scope.view 用同一个)。 */
  dir?: string
  at: number
}

export interface BenchStatus {
  flash?: FlashStatus
  gdb?: GdbStatus
  log?: LogStatus
  la?: CaptureStatus
  scope?: CaptureStatus
  /** 这次会话里 agent 碰过的仪器(pending 也算 —— 它已经伸手了)。 */
  used: ReadonlySet<InstrumentId>
  /** 此刻卡片还是 pending / running 的。状态条据此点"正在动"的灯。 */
  busy: ReadonlySet<BenchToolId>
}

export const EMPTY_BENCH_STATUS: BenchStatus = {
  used: new Set<InstrumentId>(),
  busy: new Set<BenchToolId>(),
}

/** 停止历史留几条。多了没人看,而且每条都要在界面上占一行。 */
export const MAX_STOPS = 8
const MAX_REPORT_LINES = 40
const MAX_REPORT_CHARS = 4000

// ---------------------------------------------------------------- 防御式读取

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}
function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === "string")
  return out.length > 0 ? out : undefined
}

/** 卡片上那一格的时刻。running / pending 用 start,终态用 end。 */
function timeOf(part: ToolPart): number {
  const state = part.state
  if (state.status === "completed" || state.status === "error") return state.time.end || state.time.start || 0
  if (state.status === "running") return state.time.start || 0
  return 0
}

function metadataOf(part: ToolPart): Record<string, unknown> {
  const state = part.state
  if (state.status === "pending") return {}
  const meta = state.metadata
  return meta && typeof meta === "object" ? meta : {}
}

function outputOf(part: ToolPart): string {
  const state = part.state
  if (state.status === "completed") return typeof state.output === "string" ? state.output : ""
  if (state.status === "running") return typeof state.output === "string" ? state.output : ""
  return ""
}

// ---------------------------------------------------------------- gdb 文本解析

/** `■ stopped#7: breakpoint-hit breakpoint 2 (+0.153s)` —— target.ts 的 renderStopReport 第一行。 */
const STOP_LINE = /^■\s*stopped#(\d+):\s*(.*)$/
/** `[gdb #1 halted @ main.c:200 bp=1/6 localhost:3333]` 的位置那一段。 */
const BANNER_LOCATION = /^\[gdb #\d+ [a-z-]+ @ (\S+)/
/** `  故障(HardFault):栈上的 PC 指向 …` —— 冒号可能是全角(源码里就是全角)。 */
const FAULT_LINE = /^\s*故障[(（]([^)）]*)[)）]\s*[:：]?\s*(.*)$/
/** 没有中文那一行时的兜底:Cortex-M 的故障名出现在停止报告里。 */
/** `  出事 PC 0x080004b6 = foc_zero_isense + 10 in section .text (Core/Src/foc.c:45)` —— 真正出事的那一行源码。 */
const FAULT_PC_LINE = /^\s*出事\s*PC\b.*\(([^()\s]+:\d+)\)\s*$/
const FAULT_WORD = /\b(?:HardFault|BusFault|UsageFault|MemManage|NMI|hard\s?fault)\b/

export interface ParsedStopReport {
  /** 从 `■` 那行起的正文,已按行数与字数截断。 */
  report?: string
  /** 这份输出里出现过的全部停止(源序)。 */
  stops: { n: number; reason: string; fault?: string }[]
  /** 最后一次停止的故障摘要。 */
  fault?: string
  /**
   * 故障真正发生的源码位置(`foc.c:45`),来自报告里"出事 PC"那一行。停止位置(横幅 / details)
   * 指的是**现在停在哪** —— 出了故障时那是 HardFault 处理函数,不是人要看的那一行。
   */
  faultLocation?: string
  /** 横幅里的 `@ 位置`。 */
  location?: string
}

/**
 * 从一次 gdb 调用的输出里抠出停止现场。
 *
 * 注意**不要**按 details 判有没有故障:`GdbDetails` 里一个故障字段都没有,
 * decodeFault 的结果只进了给模型的文本(contract 的纪律是 details 只放能 JSON 往返的小字段)。
 */
export function parseStopReport(output: string): ParsedStopReport {
  const out: ParsedStopReport = { stops: [] }
  if (!output) return out

  const lines = output.split("\n")
  let reportFrom = -1
  for (const [index, line] of lines.entries()) {
    const stop = STOP_LINE.exec(line)
    if (stop) {
      out.stops.push({ n: Number(stop[1]), reason: stop[2].trim() || "halted" })
      reportFrom = index
      continue
    }
    const banner = BANNER_LOCATION.exec(line)
    if (banner) out.location = banner[1]
  }

  if (reportFrom >= 0) {
    const body = lines.slice(reportFrom, reportFrom + MAX_REPORT_LINES).join("\n")
    out.report = body.length > MAX_REPORT_CHARS ? `${body.slice(0, MAX_REPORT_CHARS)}\n…` : body
  }

  // 故障只从**停止报告**里认,而且只认最后一次停止之后的那一段:
  // 一次调用里出现两次停止时前一次的故障不该冒充现状;没有 ■ 那行时(比如 `break` 的回执
  // 里恰好提到"故障")更不该凭空冒出一条没有现场的故障。
  if (reportFrom >= 0) {
    const tail = lines.slice(reportFrom)
    for (const line of tail) {
      if (FAULT_LINE.test(line)) {
        out.fault = line.trim()
        break
      }
    }
    if (!out.fault) {
      const hit = tail.find((line) => FAULT_WORD.test(line))
      if (hit) out.fault = hit.trim()
    }
    if (out.fault) {
      for (const line of tail) {
        const pc = FAULT_PC_LINE.exec(line)
        if (!pc) continue
        const [file, lineNo] = [pc[1].slice(0, pc[1].lastIndexOf(":")), pc[1].slice(pc[1].lastIndexOf(":") + 1)]
        out.faultLocation = `${basename(file)}:${lineNo}`
        break
      }
    }
  }
  if (out.fault && out.stops.length > 0) out.stops[out.stops.length - 1].fault = out.fault

  return out
}

/** `serial /dev/cu.usbmodem1103 @ 115200 8N1` / `tcp localhost:19021` / 其它 = 命令行。 */
const SERIAL_SOURCE = /^serial\s+(\S+)\s+@\s+(\d+)\b/
const TCP_SOURCE = /^tcp\s+(\S+)$/

export function parseLogSource(source: string): { kind: LogSourceKind; port?: string; baud?: number } {
  const serial = SERIAL_SOURCE.exec(source)
  if (serial) return { kind: "serial", port: serial[1], baud: Number(serial[2]) }
  const tcp = TCP_SOURCE.exec(source)
  if (tcp) return { kind: "tcp", port: tcp[1] }
  return { kind: "command" }
}

// ---------------------------------------------------------------- 折叠

function isBenchTool(tool: string): tool is BenchToolId {
  return (BENCH_TOOLS as readonly string[]).includes(tool)
}

/**
 * details 的 `state` → 视图状态。
 *
 * `attached` 是兜底档:metadata 畸形或缺了 `state`,而这次调用本身是一次跑成了的 `start` ——
 * 那就确实接上了,只是说不出更细的。其余情况**保住已经知道的**:一次抛错(metadata 是 `{}`)
 * 不该被读成"目标没了"。
 */
function gdbStateOf(raw: unknown, previous: GdbState, attachedFallback: boolean): GdbState {
  switch (raw) {
    case "halted":
    case "running":
    case "exited":
    case "connection-lost":
      return raw
    case "no-session":
      return "none"
    default:
      if (attachedFallback && previous === "none") return "attached"
      return previous
  }
}

/**
 * 解析结果的按卡片缓存。
 *
 * `deriveBenchStatus` 每一拍都要重跑(工具进度 100ms 一拍),而 `parseStopReport` 要把
 * **每一条** gdb 输出整段 split + 扫一遍 —— 长会话里那是 O(全部 gdb 输出字节) × 每秒十拍。
 * 卡片对象是 store 的代理、跨 `reconcile` 稳定,所以按它做 WeakMap 键是安全的;
 * 输出变了就重算。三个面板各有一条 memo 链,它们共用这一份缓存。
 */
const STOP_CACHE = new WeakMap<object, { output: string; parsed: ParsedStopReport }>()
/** 连 `■` 和"故障"都没有的输出(绝大多数:break / eval / status 的回执)直接跳过分行。 */
const WORTH_PARSING = /■\s*stopped#|故障[(（]/

function stopReportOf(part: ToolPart, output: string): ParsedStopReport {
  const hit = STOP_CACHE.get(part)
  if (hit && hit.output === output) return hit.parsed
  const parsed = WORTH_PARSING.test(output) ? parseStopReport(output) : parseStopReport(bannerOnly(output))
  STOP_CACHE.set(part, { output, parsed })
  return parsed
}

/** 没有停止报告时仍然要拿横幅里的位置 —— 只看头几行就够,横幅永远在最前面。 */
function bannerOnly(output: string): string {
  const cut = output.indexOf("\n")
  return cut === -1 ? output : output.slice(0, cut)
}

/**
 * 把 transcript 里的工具卡片折成一份现状。**parts 必须是源序**
 * (消息顺序 → 每条消息内 part 顺序;`useBenchStatus` 已经按这个顺序摊平)。
 */
export function deriveBenchStatus(parts: readonly ToolPart[]): BenchStatus {
  const used = new Set<InstrumentId>()
  const busy = new Set<BenchToolId>()

  let flash: FlashStatus | undefined
  let log: LogStatus | undefined
  let la: CaptureStatus | undefined
  let scope: CaptureStatus | undefined

  let gdbState: GdbState = "none"
  let gdbSeen = false
  let gdbEpoch = 0
  let gdbAt = 0
  let gdbConnection: string | undefined
  let gdbPath: string | undefined
  let gdbLine: number | undefined
  let gdbLocation: string | undefined
  let gdbReport: string | undefined
  let gdbFault: string | undefined
  let gdbFaultLocation: string | undefined
  const stops: GdbStop[] = []
  const stopKeys = new Set<string>()

  for (const part of parts) {
    const tool = part.tool
    if (typeof tool !== "string" || !isBenchTool(tool)) continue

    if (tool !== "flash") used.add(tool)
    if (part.state.status === "pending" || part.state.status === "running") busy.add(tool)

    const meta = metadataOf(part)
    const at = timeOf(part)

    switch (tool) {
      case "flash": {
        if (part.state.status === "pending" || part.state.status === "running") break
        const input: Record<string, unknown> = part.state.input ?? {}
        const command = strArray(meta.command) ?? strArray(input.command)
        const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : null
        flash = {
          ok: part.state.status === "completed" && exitCode === 0,
          exitCode: part.state.status === "error" ? null : exitCode,
          command: command ? formatCommand(command) : "",
          image: str(meta.recordedElf),
          at,
          error: part.state.status === "error" ? part.state.error : undefined,
        }
        break
      }

      case "log": {
        const running = bool(meta.running)
        // metadata 空(抛错)时这一格什么都别动:"already capturing" 不等于"采集停了"。
        if (running === undefined) break
        // **`log ports` 常常是 agent 的第一条 log 调用**,而采集器不存在时 detailsOf 给的是
        // `running:false, cursor:0, totalLines:0, dropped:0` 且没有 source / file —— 照收的话
        // 状态条会凭空长出一格"日志 已停止",说的是一次从来没发生过的采集。
        if (!log && !str(meta.source) && !str(meta.file)) break
        // 采集器被收掉之后 details 里就没有 source / file 了(`...(capture ? {…} : {})`),
        // 但"刚才听的是哪个口"仍然是用户要看的 —— 缺了就沿用上一条已知的。
        const source = str(meta.source) ?? log?.source
        const parsed = source ? parseLogSource(source) : undefined
        log = {
          capturing: running,
          source,
          kind: parsed?.kind,
          port: parsed?.port,
          baud: parsed?.baud,
          file: str(meta.file) ?? log?.file,
          totalLines: num(meta.totalLines) ?? log?.totalLines ?? 0,
          dropped: num(meta.dropped) ?? log?.dropped ?? 0,
          exitCode: typeof meta.exitCode === "number" ? meta.exitCode : undefined,
          at,
        }
        break
      }

      case "gdb": {
        gdbSeen = true
        const startedOk = meta.action === "start" && part.state.status === "completed"
        const nextState = gdbStateOf(meta.state, gdbState, startedOk)
        // `stop` 之后的 no-session 不是"换了一条目标":details 里的 epoch 归零,照常比就会把刚拿到的
        // 故障现场连同停止历史一起清掉 —— 会话一收尾,面板上最值钱的那条证据就没了。
        const epoch = meta.state === "no-session" ? gdbEpoch : (num(meta.epoch) ?? gdbEpoch)
        /**
         * 边界有两种:
         * 1. **跨 epoch** —— 复位或重连,契约里写明旧地址与断点号一律作废。
         * 2. **重新 attach** —— `MiSession` 每次新建都从 `epoch = 1` / `stopCount = 0` 起
         *    (mi-session.ts),所以"掉线 → 再 start"两侧的 epoch 都是 1,光比 epoch 看不出来。
         *    不认这一种的话 `stopKeys` 里还留着上一条目标的 `1:1`,新目标的第一次停止会被
         *    当成重复丢掉 —— 表现是标题说停在 blink.c:42,历史里却只有上一块板的 main.c:200。
         *    对活着的会话发 `start` 报的是当前 stopCount(不是 0),所以这一条不会误伤。
         */
        const freshAttach =
          meta.action === "start" && part.state.status === "completed" && num(meta.stopId) === 0 && stops.length > 0
        if ((epoch !== gdbEpoch && gdbEpoch !== 0) || freshAttach) {
          stops.length = 0
          stopKeys.clear()
          gdbReport = undefined
          gdbFault = undefined
          gdbFaultLocation = undefined
          gdbLocation = undefined
          gdbPath = undefined
          gdbLine = undefined
        }
        gdbEpoch = epoch
        gdbState = nextState
        gdbAt = at || gdbAt
        gdbConnection = str(meta.connection) ?? gdbConnection

        const path = str(meta.path)
        const line = num(meta.line)
        if (path) {
          gdbPath = path
          gdbLine = line
          gdbLocation = line ? `${basename(path)}:${line}` : basename(path)
        }

        const parsed = stopReportOf(part, outputOf(part))
        if (parsed.location) gdbLocation = parsed.location
        if (parsed.report) gdbReport = parsed.report
        if (parsed.fault !== undefined) {
          gdbFault = parsed.fault
          gdbFaultLocation = parsed.faultLocation
        } else if (parsed.stops.length > 0) {
          gdbFault = undefined
          gdbFaultLocation = undefined
        }
        for (const stop of parsed.stops) {
          const key = `${epoch}:${stop.n}`
          if (stopKeys.has(key)) continue
          stopKeys.add(key)
          stops.push({
            n: stop.n,
            epoch,
            reason: stop.reason,
            location: parsed.location ?? gdbLocation,
            fault: stop.fault,
            at,
          })
          if (stops.length > MAX_STOPS) stops.shift()
        }
        // 目标又跑起来之后,"停在哪"与"上次是什么故障"都不再是现状 —— 留着它们会让状态条
        // 一直举着一个早就离开的位置和一句早就处理完的故障。
        if (nextState === "running") {
          gdbLocation = undefined
          gdbPath = undefined
          gdbLine = undefined
          gdbFault = undefined
          gdbFaultLocation = undefined
        }
        break
      }

      case "la": {
        const id = str(meta.captureId)
        const dir = str(meta.dir)
        if (!id && !dir) break
        la = { id, dir, at }
        break
      }

      case "scope": {
        const id = str(meta.captureId)
        const dir = str(meta.dir)
        if (!id && !dir) break
        scope = { id, dir, at }
        break
      }
    }
  }

  const status: BenchStatus = { used, busy }
  if (flash) status.flash = flash
  if (log) status.log = log
  if (la) status.la = la
  if (scope) status.scope = scope
  if (gdbSeen) {
    status.gdb = {
      state: gdbState,
      location: gdbLocation,
      path: gdbPath,
      line: gdbLine,
      connection: gdbConnection,
      epoch: gdbEpoch,
      report: gdbReport,
      fault: gdbFault,
      faultLocation: gdbFaultLocation,
      stops,
      at: gdbAt,
    }
  }
  return status
}

/** argv → 一行。带空白的参数加引号,与契约的 `flashSummary` 同一种拼法。 */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")
}

/** 只要文件名 —— 路径在 `main.c:200` 这种一行读数里没有位置。正反斜杠都认。 */
export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

// ---------------------------------------------------------------- 一行读数

/**
 * gdb 会话已经收了(`stop`),但这次对话里留着停止现场。面板与状态条据此说"已结束"并继续展示
 * 最后一次现场,而不是"没有会话" —— 对读对话的人来说,那份故障报告在会话结束之后才最有用。
 */
export function gdbEnded(gdb: GdbStatus | undefined): boolean {
  return !!gdb && gdb.state === "none" && (gdb.stops.length > 0 || !!gdb.report)
}

/** `已停 main.c:200` / `运行中` —— 状态条上 gdb 那一格的值。 */
export function gdbHeadline(gdb: GdbStatus | undefined): string | undefined {
  if (!gdb) return undefined
  switch (gdb.state) {
    case "halted":
      return gdb.location ? `halted ${gdb.location}` : "halted"
    case "running":
      return "running"
    case "exited":
      return "exited"
    case "connection-lost":
      return "connection lost"
    case "attached":
      return "attached"
    case "none":
      return gdbEnded(gdb) ? (gdb.location ? `ended ${gdb.location}` : "ended") : undefined
  }
}

/** `cu.usbmodem1103 115200` / `localhost:19021` / 命令行头一段。 */
export function logHeadline(log: LogStatus | undefined): string | undefined {
  if (!log) return undefined
  if (log.kind === "serial" && log.port) return `${basename(log.port)}${log.baud ? ` ${log.baud}` : ""}`
  if (log.kind === "tcp" && log.port) return log.port
  if (log.source) return log.source.length > 28 ? `${log.source.slice(0, 27)}…` : log.source
  return undefined
}
