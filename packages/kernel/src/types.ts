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
 *   snapshot / patch          没有文件快照 —— "回滚"只是 navigateTree() 把会话树的 tip 挪回去
 *   subtask                   没有子代理
 *   agent                     只有一个系统提示词,没有 persona,也没有 @agent 提及的偏移量
 *   retry                     重试在内核里(retry_* 事件),不落 transcript —— 失败仍是一条带 error 的 assistant 消息
 *
 * 本文件必须保持 **浏览器安全**:不 import yoma、不 import node:*。
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
   * 内核的 ToolCall.id。工具调用和结果 **必须按它配对,绝不按到达顺序** ——
   * 并行工具时 tool_end 按完成序发,而 transcript 是源序。
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
  /** 工具的结构化结果。UI 不解释它。 */
  metadata: ToolDetails
  time: { start: number; end: number }
  /** 工具结果里的图片(read 读一张图就是这条路)。 */
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
// 工具名与工具链 / la 的 RPC 视图模型
// ---------------------------------------------------------------------------

/**
 * host 真正装配出来的工具名,逐字相同(host/tool-names.test.ts 钉住)。
 *
 * 嵌入式那一套(flash/gdb/la/scope/…)已于 2026-09-10 归零,只剩内核自带的四件套。
 * 退役的名字**不必**留在这里:界面按任意工具名走万能卡,旧会话重放照样画得出来。
 */
export const TOOL_NAMES = ["read", "bash", "edit", "write"] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * resolveToolchain() 对单个声明工具的判定,从 coding-agent 的 ResolvedTool 结构化
 * 复制(公共契约见 core/toolchain/resolve.ts)。还没有专门的工具卡片消费它 —— 现在
 * 只是渲染成一段文本追加进系统提示词(session-manager.ts 的 promptSectionFor) ——
 * 提前钉住这份形状是为了 P1 补渲染器时不用回头核对字段。
 */
export interface ToolchainResolvedTool {
  id: string
  status: "ok" | "version-mismatch" | "ambiguous" | "missing"
  optional: boolean
  bin: Record<string, string>
  version?: string
  wanted?: string
  candidates?: string[]
  /** "managed" = Yoma 自己装进 ~/.yoma/toolchains 的(coding-agent 的 install.ts)。 */
  source?: "local" | "ledger" | "managed" | "env" | "path" | "well-known" | "registry"
  hint?: string
  why?: string
  /** 非 ok 且目录(catalog.ts)对这台机器有包时给出 —— 设置页的"安装"按钮看它。 */
  installable?: ToolchainInstallableView
}

/** coding-agent `Installable` 的结构化复制:能自动装什么、多大。 */
export interface ToolchainInstallableView {
  packageId: string
  title: string
  version: string
  bytes: number
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

/** coding-agent `InstallPhase` 的结构化复制(install.ts)。 */
export type ToolchainInstallPhaseView =
  | "resolve"
  | "download"
  | "verify"
  | "extract"
  | "record"
  | "done"
  | "error"
  | "cancelled"

/**
 * `toolchain.install` RPC 的结果:装到了哪里 + 装完后的机器级核账。`status` 是**第一个**
 * 声明了这个工具 id 的预设平台的核账(cmake 在三个平台里都有,拿到的是 STM32 那份;工具 id 不在
 * 任何预设里时 tools 为空)—— 设置页若开着别的平台,要按自己的平台再拉一次 familyStatus,
 * 不能拿它直接 mutate 当前列表。
 */
export interface ToolchainInstallResultView {
  id: string
  packageId: string
  version: string
  dir: string
  binDir: string
  /** 已经装好且校验和相同,没有重新下载。 */
  reused: boolean
  status: ToolchainStatusView
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

export type ToolDetails = Record<string, unknown>

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
  /** 被 gitignore 忽略:文件树照样列出来,只是灰显(和 VS Code 资源管理器一致)。不在仓库里时没有这个字段。 */
  ignored?: boolean
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

/** VS Code 源代码管理视图的四个分组,顺序也照它:合并冲突、暂存的更改、更改、未跟踪。 */
export type VcsGroup = "conflict" | "staged" | "changes" | "untracked"

export interface FileDiff {
  path: string
  added: number
  removed: number
  status: "added" | "modified" | "deleted" | "renamed"
  patch?: string
  /** 所属分组。同一文件既暂存又有未暂存改动时只列一次,归"更改"(VS Code 会列两次,我们的面板按路径去重)。 */
  group?: VcsGroup
  /** VS Code 的单字母状态:M / A / D / R / T / C / U(未跟踪)/ !(冲突)。 */
  letter?: string
  /** 改名时的旧路径(相对仓库根)。 */
  origPath?: string
}

/** 版本控制里单个文件的改动。和 FileDiff 同形,保留这个名字是因为调用点按它命名。 */
export type VcsFileDiff = FileDiff

export interface VcsInfo {
  root?: string
  branch?: string
  dirty: boolean
  /** 是 git 仓库但一次提交都没有(刚 git init):没有 HEAD 可比,审查页要提示"先做一次提交",不能说"暂无改动"。 */
  empty?: boolean
}
