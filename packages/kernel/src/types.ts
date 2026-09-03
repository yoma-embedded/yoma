/**
 * 视图模型 —— 前端看到的会话数据形状。
 *
 * 刻意保留 opencode SDK 的类型 **名字**(Message/Part/ToolPart/ToolState/Session…),
 * 只把 body 换成 yoma 能真实产出的东西。这样 packages/session-ui 的 transcript 渲染
 * 和 packages/app 里有单测的 store reducer 基本原样存活,迁移变成"改 import 说明符 +
 * 让编译器逐字段报错",而不是重写。
 *
 * 相对 opencode 删掉的 Part 变体,以及原因:
 *   step-start / step-finish  yoma 的每轮状态是 turn_start/turn_end 事件,不落 transcript
 *   snapshot / patch          yoma 没有文件快照 —— 它的回滚是 Session.moveTo() 挪 leaf 指针
 *   subtask                   没有子代理
 *   agent                     只有一个系统提示词,没有 persona,也没有 @agent 提及的偏移量
 *   retry                     内核对 provider 失败不重试,失败就是一条带 error 的 assistant 消息
 *
 * 本文件必须保持 **浏览器安全**:不 import yoma、不 import node:*。
 * 工具 details 的形状是从 yoma 结构化复制过来的,漂移由 host/details-check.ts 在编译期兜住。
 */

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface Session {
  id: string
  /** 会话的工作目录(绝对路径)。yoma 里一个 session 就是一个 cwd,没有 project/worktree 层级。 */
  directory: string
  title: string
  time: {
    created: number
    updated: number
    /** 正在压缩时置位,用来在 UI 上显示压缩中。 */
    compacting?: number
    archived?: number
  }
  model?: {
    providerID: string
    modelID: string
    /** yoma 的 thinking level(off/minimal/low/medium/high…),内核真有这个能力,opencode 没有。 */
    thinking?: string
  }
  cost?: number
  tokens?: Tokens
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "compacting" }

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/**
 * 错误按 opencode 的判别名保留 —— session-ui 已经按 name 分支渲染。
 * yoma 的内核对 provider 失败 **永不抛异常**:失败是一条 stopReason:"error" 的 assistant
 * 消息。不投影成这个,UI 上就是一个空白轮次。
 */
export type MessageError =
  | { name: "MessageAbortedError"; data: { message: string } }
  | { name: "ContextOverflowError"; data: { message: string } }
  | { name: "ProviderAuthError"; data: { providerID: string; message: string } }
  | { name: "UnknownError"; data: { message: string } }

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  model: {
    providerID: string
    modelID: string
  }
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  /** 触发这一轮的用户消息 id。session-ui 用它把一轮的消息归组。 */
  parentID: string
  time: {
    created: number
    completed?: number
  }
  error?: MessageError
  providerID: string
  modelID: string
  cost: number
  tokens: Tokens
  /** 这条 assistant 消息是压缩/分支摘要合成出来的,不是模型直接说的。 */
  synthetic?: boolean
}

export type Message = UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Part
// ---------------------------------------------------------------------------

interface PartBase {
  id: string
  sessionID: string
  messageID: string
}

export interface TextPart extends PartBase {
  type: "text"
  text: string
  /** 不是模型说的(bash 执行回显、自定义消息、压缩摘要正文)。 */
  synthetic?: boolean
  time?: { start: number; end?: number }
}

export interface ReasoningPart extends PartBase {
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export interface FilePart extends PartBase {
  type: "file"
  mime: string
  filename?: string
  /** data: URL 或 file: URL。yoma 的 ImageContent 是 base64,投影成 data: URL。 */
  url: string
}

export interface CompactionPart extends PartBase {
  type: "compaction"
  /** 自动压缩 vs 用户手动触发。 */
  auto: boolean
  /** 分支摘要(从一条支线回到主干)而不是上下文压缩。 */
  branch?: boolean
}

export interface ToolPart extends PartBase {
  type: "tool"
  /**
   * yoma 的 ToolCall.id。工具调用和结果 **必须按它配对,绝不按到达顺序** ——
   * 并行工具时 tool_execution_end 按完成序发,而 transcript 是源序。
   */
  callID: string
  tool: ToolName | (string & {})
  state: ToolState
}

export type Part = TextPart | ReasoningPart | FilePart | ToolPart | CompactionPart

export type PartType = Part["type"]

// ---------------------------------------------------------------------------
// 工具状态机
// ---------------------------------------------------------------------------

export interface ToolStatePending {
  status: "pending"
  input: Record<string, unknown>
  /** 参数还在流式拼接时的原始 JSON 片段。 */
  raw?: string
}

export interface ToolStateRunning {
  status: "running"
  input: Record<string, unknown>
  title?: string
  time: { start: number }
}

export interface ToolStateCompleted {
  status: "completed"
  input: Record<string, unknown>
  /** 给模型看的文本输出。 */
  output: string
  title: string
  /** 结构化结果。这是硬件工具卡片的全部信息来源。 */
  metadata: ToolDetails
  time: { start: number; end: number }
  /** 工具返回的图片(datasheet view_figure)。 */
  attachments?: FilePart[]
}

export interface ToolStateError {
  status: "error"
  input: Record<string, unknown>
  error: string
  metadata?: ToolDetails
  time: { start: number; end: number }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

// ---------------------------------------------------------------------------
// 工具 details —— 从 yoma 结构化复制,漂移由 host/details-check.ts 编译期兜住
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "toolchain",
  "examples",
  "grep",
  "stm32config",
  "netlist",
  "flash",
  "datasheet",
  "log",
  "gdb",
  "la",
  "scope",
] as const

/**
 * 已从内核退役、但必须留在视图词汇表里的工具:旧会话的 JSONL 里还有它们的 part,
 * 重放时 session-ui 要认得。grep 于 yoma 2026-08 的装配面精简中删除(依赖外部 ripgrep)。
 * 活工具集 = TOOL_NAMES − RETIRED_TOOL_NAMES,由 host/tool-names.test.ts 钉住 yoma 装配面。
 */
export const RETIRED_TOOL_NAMES = ["grep"] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export interface TruncationInfo {
  content: string
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  totalLines: number
  totalBytes: number
  outputLines: number
}

export interface ReadToolDetails {
  truncation?: TruncationInfo
  path?: string
}

export interface BashToolDetails {
  truncation?: TruncationInfo
  fullOutputPath?: string
}

export interface GrepToolDetails {
  truncation?: TruncationInfo
  matchLimitReached?: number
  linesTruncated?: boolean
}

/** edit 和 write 都带前后全文 + unified patch —— 比 opencode 的还全,Pierre diff 直接能用。 */
export interface EditToolDetails {
  path: string
  oldContent: string
  newContent: string
  patch: string
  firstChangedLine?: number
}

export interface WriteToolDetails {
  path: string
  bytes: number
  created: boolean
  oldContent: string | null
  newContent: string
}

/**
 * resolveToolchain() 对单个声明工具的判定,从 coding-agent 的 ResolvedTool 结构化
 * 复制(公共契约见 core/toolchain/resolve.ts)。还没有专门的工具卡片消费它 —— 现在
 * 只是渲染成一段文本追加进系统提示词(session-manager.ts 的 promptSectionFor) ——
 * 提前钉住这份形状是为了 P1 补渲染器时不用回头核对字段,漂移仍由 details-check.ts 兜底。
 */
export interface ToolchainResolvedTool {
  id: string
  status: "ok" | "version-mismatch" | "ambiguous" | "missing"
  optional: boolean
  bin: Record<string, string>
  version?: string
  wanted?: string
  candidates?: string[]
  source?: "local" | "ledger" | "env" | "path" | "well-known" | "registry"
  hint?: string
  why?: string
}

export interface ToolchainToolDetails {
  action: "check" | "resolve" | "set"
  ok: boolean
  side?: "mother" | "runner"
  /** check / resolve 才有:每个声明工具的完整解析结果。 */
  tools?: ToolchainResolvedTool[]
  /** set 才有:被记录的工具 id。 */
  id?: string
}

/**
 * `toolchain.status` / `toolchain.set` RPC 的结果:一个项目的工具链核账快照。
 * 设置页的"工具链"标签消费它。三种形态,靠 declared/error 区分:
 *   - declared:false 且无 error —— 项目根本没声明清单(绝大多数项目),UI 给引导文案;
 *   - declared:false 且有 error —— 清单文件在但内容坏了,这必须被看见(host 侧与
 *     会话开启一样不抛,折叠成这份带 error 的结果 —— 设置页正是排查它的地方);
 *   - declared:true —— tools 逐条给判定,ok 表示所有非 optional 的都解析成功。
 */
export interface ToolchainStatusView {
  declared: boolean
  manifestPath?: string
  side: "mother" | "runner"
  ok: boolean
  tools: ToolchainResolvedTool[]
  error?: string
}

/**
 * 芯片平台预设目录里单个工具的浏览器安全视图,从 coding-agent 的
 * ToolchainFamilyTool 结构化复制(只取 UI 要的四个字段 —— bin/install/env 那些
 * 探测细节留在内核侧,核账结果里的 ResolvedTool 已经带回 UI 需要的部分)。
 */
export interface ToolchainFamilyToolView {
  id: string
  /** 行标题,专有名词(Arm GNU Toolchain / ESP-IDF / …),中英一致,不进 i18n。 */
  title: string
  optional: boolean
  /** 手填路径的形态:exe = 可执行文件(记账要验版本),dir = 安装目录(只验存在)。 */
  pathKind: "exe" | "dir"
}

export interface ToolchainFamilyView {
  id: string
  name: string
  tools: ToolchainFamilyToolView[]
}

/**
 * `toolchain.families` RPC 的结果:预设目录 + 机器账本(<configDir>/toolchains.json)
 * 里已有记录的工具 id。recordedIds 给"这台机器还没配置过任何工具链"的首跑提醒判断
 * 用 —— 空数组即从没配置过(不管是手填还是重新探测都会让它非空)。
 */
export interface ToolchainFamiliesView {
  families: ToolchainFamilyView[]
  recordedIds: string[]
}

/**
 * examples(例程库)工具的 details,从 coding-agent 的 ExamplesToolDetails 结构化
 * 复制(公共契约见 core/tools/examples.ts)。暂无专门卡片消费它(GenericTool 兜底,
 * 与 toolchain 同一先例),提前钉住形状,漂移由 details-check.ts 兜底。
 */
export interface ExamplesToolDetails {
  action: "search" | "info" | "seed" | "preflight" | "sync"
  /** search 才有:命中数与命中 id。 */
  count?: number
  hitIds?: string[]
  /** info / seed 才有。 */
  id?: string
  corpus?: string
  /** seed 才有:落进工作区的绝对路径。 */
  seededTo?: string
  /** preflight 才有:参与条目(底盘在前)与重叠条数。 */
  ids?: string[]
  conflicts?: number
  /** sync 才有:目标语料与(代码同步后的)字节数。 */
  corpusId?: string
  archiveBytes?: number
}

export interface NetlistToolDetails {
  mode: "map" | "board_ir"
  part?: string
  files?: { boardIr: string; stm32Map: string; cfgSeed: string }
}

export interface DatasheetSearchHit {
  manual_name?: string
  page?: number
  /** 单个字符串,不是数组 —— 内核里就是一条已经拼好的标题路径。别对它 join()。 */
  headings?: string
  score?: number
  parsed_path?: string
  image_path?: string
  source_pdf?: string
}

export interface DatasheetToolDetails {
  action: "search" | "read_section" | "view_figure" | "chips"
  chip?: string
  /** search:入参 chip 是型号时,实际搜的那个家族索引名(相等时不填)。 */
  resolvedChip?: string
  rev?: string
  topK?: number
  /** chips:索引里的家族数 / 手册数。 */
  families?: number
  manuals?: number
  hits?: DatasheetSearchHit[]
  parsedPath?: string
  mode?: string
  heading?: string
  level?: number
  lines?: number[]
  chars?: number
  sections?: number
  truncated?: boolean
  imagePath?: string
  mime?: string
  bytes?: number
}

export interface Stm32ConfigToolDetails {
  command: string
  exitCode: number | null
}

export interface FlashToolDetails {
  command: string[]
  exitCode: number | null
  /** elfPath 给了且 exit 0 时:已落进 flash-state.json 的镜像绝对路径。 */
  recordedElf?: string
}

export type LogAction = "start" | "read" | "wait" | "status" | "stop" | "ports"

export interface LogToolDetails {
  action: LogAction
  running: boolean
  cursor: number
  totalLines: number
  dropped: number
  file?: string
  matched?: boolean
  exitCode?: number | null
}

export type GdbAction = "start" | "break" | "exec" | "eval" | "status" | "stop"
export type GdbTargetState = "halted" | "running" | "exited" | "connection-lost"

export interface GdbToolDetails {
  action: GdbAction
  state: GdbTargetState | "no-session"
  epoch: number
  stopId: number
  connection?: string
  file?: string
  /** 停在有源码的位置时才有 —— 文件在本机不存在时内核 **不填**,别拿它去开文件。 */
  path?: string
  firstChangedLine?: number
}

export type LaAction =
  | "devices"
  | "capture"
  | "arm"
  | "collect"
  | "stop"
  | "import"
  | "list"
  | "decoders"
  | "summary"
  | "decode"
  | "events"
  | "timing"
  | "expect"

/**
 * 逻辑分析仪工具。只放摘要与句柄:原始样本永远在 <工程>/.yoma/la/<id>/ 的文件里(details
 * 进会话 JSONL、开会话整批重传、不可回收)。preview 是 1024 列 × 每通道 2bit 的缩略图,
 * 让旧会话重放时卡片仍能画出波形,即便 .yoma/la/ 已被清理。
 */
export interface LaToolDetails {
  action: LaAction
  captureId?: string
  dir?: string
  file?: string
  samplerate?: number
  samples?: number
  durationMs?: number
  triggerPos?: number
  channels?: { index: number; name: string; edges?: number }[]
  /** bit0 该列出现过高电平、bit1 出现过低电平;4 列一字节;每通道一个 base64 */
  preview?: { columns: number; from: number; to: number; rows: Record<string, string> }
  decoders?: { key: string; id: string; annotations: number }[]
  window?: { from: number; to: number }
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
  issues?: number
  device?: { model?: string; pid?: string; hdl?: number }
}

/** la.captures 的每一条:<工程>/.yoma/la/<id>/capture.json 的内容 + 解码状态。 */
export interface LaCaptureInfo {
  id: string
  /** 采集目录绝对路径,la.view 用它 */
  dir: string
  samplerate: number
  samples: number
  durationMs: number
  channels: { index: number; name: string }[]
  triggerPos?: number
  source: "capture" | "import" | "demo"
  createdAt: number
  /** 最近一次解码的实例名;空 = 没解码过 */
  decoded: string[]
}

/** la.view 的入参:一次采集目录(来自 la.captures)+ 采样窗口 + 视口列数。 */
export interface LaViewParams {
  dir: string
  from?: number
  to?: number
  /** 视口像素列数(≤ 4096) */
  columns: number
}

export interface LaViewLaneItem {
  s: number
  e: number
  /** 类 id(如 address-write)与可读文本(`{$}` 已替换) */
  cls: string
  text: string
  /** 短文本(密集时用) */
  short: string
}

export interface LaViewResult {
  samplerate: number
  totalSamples: number
  triggerPos?: number
  from: number
  to: number
  columns: number
  /** 每通道一条:2bit/列(bit0 有高、bit1 有低),4 列一字节,base64 */
  channels: { index: number; name: string; edges: number; bits: string }[]
  /** 每个解码器实例 × 每个注解行一条泳道,位级行不回(面板放大到位级再单独要) */
  lanes: { key: string; decoderId: string; row: string; items: LaViewLaneItem[]; total: number; truncated: boolean }[]
}

export type ScopeAction =
  | "connect"
  | "status"
  | "setup"
  | "capture"
  | "arm"
  | "collect"
  | "measure"
  | "samples"
  | "screenshot"
  | "list"
  | "raw"

/** 一个通道在本次采集上的统计量。都是引擎侧算好的,前端只格式化。 */
export interface ScopeChannelStats {
  min: number
  max: number
  pp: number
  mean: number
  rms: number
  freq?: number
  period?: number
  duty?: number
  rise?: number
  fall?: number
  edges?: number
}

/** 一路模拟通道的设置与统计。ch 是 1..4。 */
export interface ScopeChannelDetails {
  /** 1..4 */
  ch: number
  on?: boolean
  label?: string
  /** V/div,已含探头衰减 */
  vdiv?: number
  offset?: number
  coupling?: string
  probe?: number
  unit?: string
  bwlimit?: string
  /** 本次采集落盘的样本数 */
  points?: number
  stats?: ScopeChannelStats
}

/** 示波器自带的一条测量项。 */
export interface ScopeMeasurement {
  type: string
  source: string
  /** null = 示波器报 "****"(无法测量) */
  value: number | null
  unit?: string
  n?: number
  min?: number
  max?: number
  mean?: number
}

/**
 * 示波器工具(Siglent SDS824X HD,USBTMC 或 TCP/SCPI)。与 la 同一条纪律:details
 * 只放摘要与句柄,原始波形与截图落在 <工程>/.yoma/scope/ 的文件里。
 */
export interface ScopeToolDetails {
  action: ScopeAction
  /** "usb:<serial>" 或 "host:port" */
  address?: string
  model?: string
  serial?: string
  firmware?: string
  captureId?: string
  dir?: string
  /** 截图/采集文件的绝对路径 */
  file?: string
  sampleRate?: number
  interval?: number
  points?: number
  mdepth?: string
  timebase?: { scale: number; delay: number }
  trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string }
  channels?: ScopeChannelDetails[]
  measurements?: ScopeMeasurement[]
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
  /** 截图字节数 */
  bytes?: number
}

/**
 * 按工具名判别的 details。渲染器拿到 ToolPart 之后先 narrow 工具名,再读 metadata,
 * 全程有编译期类型 —— 这是 opencode 那边 `metadata: {[k:string]: unknown}` 给不了的。
 */
export interface ToolDetailsMap {
  read: ReadToolDetails
  bash: BashToolDetails
  edit: EditToolDetails
  write: WriteToolDetails
  toolchain: ToolchainToolDetails
  examples: ExamplesToolDetails
  grep: GrepToolDetails
  stm32config: Stm32ConfigToolDetails
  netlist: NetlistToolDetails
  flash: FlashToolDetails
  datasheet: DatasheetToolDetails
  log: LogToolDetails
  gdb: GdbToolDetails
  la: LaToolDetails
  scope: ScopeToolDetails
}

export type ToolDetails = ToolDetailsMap[ToolName] | Record<string, unknown>

/** 渲染器用:`if (isTool(part, "flash")) part.state.metadata.chip` 就有类型了。 */
export function isTool<K extends ToolName>(
  part: Part,
  tool: K,
): part is ToolPart & { tool: K; state: ToolState & { metadata?: ToolDetailsMap[K] } } {
  return part.type === "tool" && part.tool === tool
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 会话不存在。
 *
 * 必须是 **结构化** 的:前端 isSessionNotFoundError() 按 `_tag` + `sessionID` 匹配,
 * 匹配上就静静地把失效标签页删掉,匹配不上就当成致命错误弹错误页。跨进程传输会把
 * Error 压成一个字符串,所以这个形状要顺着协议的 error.data 走。
 *
 * 最常见的触发场景:换内核之后打开一个上个版本残留的标签页(opencode 的 id 是
 * `ses_xxx`,yoma 的是 UUID)。
 */
export interface SessionNotFoundError {
  _tag: "SessionNotFoundError"
  sessionID: string
  message: string
}

export function sessionNotFound(sessionID: string): Error & { data: SessionNotFoundError } {
  const error = new Error(`未知会话 ${sessionID}`) as Error & { data: SessionNotFoundError }
  error.data = { _tag: "SessionNotFoundError", sessionID, message: error.message }
  return error
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  providerID: string
  name: string
  /** 该模型支持的 thinking 档位,来自 pi-ai 的 getSupportedThinkingLevels。 */
  thinkingLevels: string[]
  contextWindow?: number
  maxOutput?: number
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface ProviderInfo {
  id: string
  name: string
  /** 凭据是否已配置。没有的话前端要引导去填 API key。 */
  authenticated: boolean
  models: ModelInfo[]
}

// ---------------------------------------------------------------------------
// 文件 / 版本控制(host 侧的纯 Node 服务,和内核无关)
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string
  name: string
  type: "file" | "directory"
}

/** 文件树节点。children 只在展开过的目录上有值。 */
export interface FileNode extends FileEntry {
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content: string
  mime: string
  truncated: boolean
}

/**
 * 一个"项目"就是一个最近打开过的工作目录。
 *
 * 顶替 opencode 的 project + worktree 两层结构 —— yoma 里一个会话就是一个 cwd,
 * 没有 git worktree 感知,也没有服务端的项目注册表。
 */
export interface Project {
  directory: string
  name: string
  lastOpened: number
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  status: "added" | "modified" | "deleted" | "renamed"
  patch?: string
}

/** 版本控制里单个文件的改动。和 FileDiff 同形,保留这个名字是因为调用点按它命名。 */
export type VcsFileDiff = FileDiff

export interface VcsInfo {
  root?: string
  branch?: string
  dirty: boolean
}
