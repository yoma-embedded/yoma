/**
 * 会话管理:一个 sessionID ↔ 一个 AgentHarness ↔ 一条 lane ↔ 一个投影器。
 *
 * ## 为什么整个 app 只能有一个内核进程
 *
 * JsonlSessionRepo 假定**一个进程独占一个会话文件**(repo.open 对已打开的会话直接抛)。
 * 按窗口或按目录分片 fork 内核,两个进程就会各自以为自己在写同一条 JSONL。
 * 这个类是进程内单例。
 *
 * ## 内核的三个必须知道的行为
 *
 * 1. 一条 lane 同时只有一个操作。有在飞操作时 `accept()` 返回 `LaneBusy`(不抛、不排队),
 *    所以"发新一轮"前要先 requestAbort + waitForIdle。
 * 2. 失败、重试、自动压缩都在内核里:`drive({ waitForRetry: true })` 把整段退避留在
 *    这一次调用里,于是整段重试对外是**一个连续的 busy**。
 * 3. `accept()` 只落盘不执行,`drive()` 才真的跑。两者分开正是"RPC 立刻返回、
 *    结果走事件流"的接缝:accept 的事件(run_start + 用户消息)在它 resolve 前就送达了。
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSkillInvocation,
  value,
  type AgentLane,
  type AgentMessage,
  type Branch,
  type Context,
  type ExecutionToolContext,
  type JsonlSessionMetadata,
  type LaneQueuedItem,
  type OperationAdmissionResult,
  type OperationRequest,
  type Session as PiSession,
  type Skill,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { BUILTIN_AGENTS, DEFAULT_AGENT_TYPE } from "./domain/agents/builtin.ts"
import { loadAgentProfiles } from "./domain/agents/load.ts"
import { TASK_NOTIFICATION_TYPE } from "./domain/agents/notification.ts"
import type { AgentProfile } from "./domain/agents/profile.ts"
import { describeAgentTools, resolveAgentTools, SUBAGENT_TOOL_NAMES } from "./domain/agents/select.ts"
import type { StopOutcome } from "./domain/agents/task-host.ts"
import { TaskManager, type ChildSpec, type SubagentMeta, type TaskPort } from "./tasks.ts"
import { bindExecutionEnv } from "./domain/execution-env.ts"
import { inspectStm32Availability, type Stm32Availability } from "./domain/stm32/availability.ts"
import {
  findEnvKey,
  machinePathDirs,
  promptSectionFor,
  readLedger,
  resolveToolchain,
  shellEnvFor,
  withMachineOnPath,
  type InstallRegistry,
  type ToolchainResolution,
} from "./domain/toolchain/index.ts"
import { installProgressEvent } from "./toolchain.ts"
import { buildSystemPrompt } from "./system-prompt.ts"
import { ConfirmDesk } from "./confirm.ts"
import { ToolProgressThrottle } from "./tool-progress.ts"
import { confirmNeeded } from "./tools/contracts.ts"
import { processImage } from "./domain/image/process.ts"
import { createRegisteredTools, type RegisteredTool, type RegisteredToolOptions } from "./tools/index.ts"
import { configurableProviders, resolveModel } from "./models.ts"
import { discoverSkills, loadContextFiles } from "./resources.ts"
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AuthContext,
  type ImageContent,
  type Model,
  type Models,
} from "@earendil-works/pi-ai"

import type { KernelEvent, PromptInput } from "../protocol.ts"
import type {
  AgentInfo,
  ProviderInfo,
  QueuedItemView,
  Session as ViewSession,
  SessionStatus,
  TaskView,
  ToolConfirmView,
} from "../types.ts"
import { Identifier } from "../ids.ts"
import { pickThinkingLevel } from "../thinking.ts"
import { sessionNotFound, subagentSession } from "../types.ts"
import { MANUAL_COMPACTION_ENTRY, removalEvents, SessionProjection } from "./projector.ts"
import { migrateLegacyPiAuth, yomaConfigDir, removeAuthKey, writeAuthKey } from "./auth.ts"

/** 同时活着的 harness 上限。淘汰只是丢弃内存态,重开就是 repo.open + 重放,很便宜。钉住的(子 agent 任务在用)不算。 */
const MAX_LIVE_SESSIONS = 8

/** 子会话的会话级值(docs/子agent-设计方案-v0.4-20260918.md §4.6):续跑与重启后重建任务都靠它。 */
const SUBAGENT_META = value<SubagentMeta>("yoma", "subagent")

/** 同时在跑的子 agent 缺省上限(CC 的 CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 缺省也是 10)。 */
const DEFAULT_MAX_CONCURRENT_AGENTS = 10

/** 正整数环境变量;没设、不是数就是 undefined(0 算数:自动转后台用 0 表示关)。 */
function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

/** 本地日期 YYYY-MM-DD(子 agent 的 env 块;CC getLocalISODate 同款,不是 UTC)。 */
function localDate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

/**
 * 内核 Result 错误的 _tag → 一句中文。
 *
 * 内核的错误消息是英文的(`Lane "main" has nothing to compact`),而这些错误会原样
 * 跨进程摆到用户眼前。原文用破折号接在后面 —— 用户看得懂前半句,排错的人还留着后半句。
 */
const LANE_ERROR_TEXT: Record<string, string> = {
  LaneBusy: "这个会话还有一轮没跑完",
  NothingToCompact: "当前没有可压缩的内容",
  NothingToResume: "没有可恢复的操作",
  OperationMismatch: "这一轮已经结束了",
  NoActiveOperation: "没有正在进行的操作",
  NoActiveRun: "没有正在进行的轮次",
  InvalidMessage: "消息内容内核不接受",
  InvalidNavigation: "不能回到这个位置",
  InvalidLane: "会话通道名不合法",
  UnknownSkill: "没有这个技能",
  UnknownTemplate: "没有这个提示词模板",
  UnknownTarget: "目标消息不在这个会话的历史里",
  Closed: "会话已经关闭,请重新打开",
  HarnessClosed: "会话已经关闭,请重新打开",
  HarnessFault: "内核故障,请重新打开这个会话",
}

function laneErrorMessage(error: { _tag?: string; name?: string; message?: string }): string {
  const text = LANE_ERROR_TEXT[error._tag ?? error.name ?? ""]
  // 认不出的就原样交出去 —— 硬翻成"内核操作失败"只会把唯一一条线索盖掉。
  if (!text) return error.message ?? "内核操作失败"
  return error.message ? `${text} —— ${error.message}` : text
}

function laneError(error: { _tag?: string; name?: string; message?: string }): Error {
  return new Error(laneErrorMessage(error))
}

/** drive 带着 waiting 回来时报给用户的话。两个 poll 开关都开了还 waiting 就是真跑不下去了。 */
const WAITING_TEXT: Record<"retry" | "deferred", string> = {
  retry: "这一轮停在等待重试上,没能跑完",
  deferred: "这一轮停在等待 provider 异步出结果上,没能跑完",
}

/**
 * 这个 entry 现在能直接用吗。
 *
 * `lane` 有值还不够:dispose 一启动(closing)这条 lane 就在被拆,交出去只会让调用方
 * 撞上 HarnessClosed。所有"开没开"的判断都走这里。
 */
function isOpen(entry: Entry): boolean {
  return Boolean(entry.lane) && !entry.closing
}

/**
 * 装配面的真源:内核自带的四件套 + host/tools 下的硬件工具,顺序与 `TOOL_NAMES` 一致。
 *
 * 嵌入式那一套(flash/gdb/la/scope/…)2026-09-10 归零,旧实现留在 kernel/attic/tools
 * 作重写参考;2026-09-11 起按 host/tools/<名字>/ 的样板逐个回来。host 自检也走这里。
 */
export function createAgentTools(
  options: RegisteredToolOptions & { invocationEnv?: () => NodeExecutionEnv } = {},
): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    // 图片走 host/domain/image:大图先压到供应商的内嵌上限以内,BMP 之类先转成 PNG。不接这个钩子的话,
    // 发动机对 BMP 直接回一句"配个 imageProcessor",对十几 MB 的照片则原样发出去 —— 而超限不是"这张图没了",
    // 是整段对话被拒。
    createReadTool({
      imageProcessor: (bytes, mimeType, options) => processImage(bytes, mimeType, options),
    }),
    // 内核的 bash 不管 Python 的编码:Windows 的 GBK 控制台会把例程脚本的 UTF-8 输出
    // 变成乱码,而乱码到了模型眼里就是"脚本坏了"。每条命令都前置这两个变量。
    createBashTool({
      prepare: (execution) => {
        execution.env.PYTHONIOENCODING = "utf-8"
        execution.env.PYTHONUTF8 = "1"
      },
    }),
    createEditTool(),
    createWriteTool(),
    ...createRegisteredTools(options),
  ]
  if (!options.invocationEnv) return tools
  // Upstream resolves toolContext once per batch. Refresh it here for every invocation so a
  // toolchain setting completed by an earlier call is visible to the next call in that batch.
  return tools.map((tool) => ({
    ...tool,
    execute: (id, params, onUpdate, context, invocation, ctx) =>
      tool.execute(id, params, onUpdate, { ...context, env: options.invocationEnv!() }, invocation, ctx),
  }))
}

/**
 * 这一轮真正交给模型的工具名。两道筛:本机没有 STM32 资源时 stm32config 不激活;子 agent 四件只在宿主注入了
 * TaskHost 的会话里激活(它们照常登记,TOOL_NAMES 平台无关;模型看得见却用不了的工具只会让它空转一次)。
 * 开会话与"下一轮前重核本机资源"两处必须同解。
 */
export function activeToolNames(tools: readonly RegisteredTool[], stm32Available: boolean, subagents = false): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => stm32Available || name !== "stm32config")
    .filter((name) => subagents || !SUBAGENT_TOOL_NAMES.includes(name))
}

/**
 * 把 engines/bin 前置进 PATH —— agent 的 bash 工具靠它拿到 rg(例程语料 grep 的
 * 依赖,Windows 没有内置 grep)。与 shellEnvFor 的工具链目录同一条纪律:前置不
 * 替换、写回原来的键(Windows 上可能叫 "Path",另开一个 "PATH" 会得到两个键,
 * 子进程认哪个是未定义行为)。enginesDir 未注入或 bin/ 不存在时原样返回 ——
 * 打包产物必有 engines,这条静默跳过只该发生在测试里。
 */
function withEnginesOnPath(env: NodeJS.ProcessEnv, enginesDir?: string): NodeJS.ProcessEnv {
  if (!enginesDir) return env
  const bin = path.join(enginesDir, "bin")
  if (!existsSync(bin)) return env
  const pathKey = findEnvKey(env, "PATH") ?? "PATH"
  const current = env[pathKey] ?? ""
  const dirs = current.split(path.delimiter).filter(Boolean)
  if (dirs[0] === bin) return env
  const out: NodeJS.ProcessEnv = { ...env }
  out[pathKey] = [bin, ...dirs.filter((dir) => dir !== bin)].join(path.delimiter)
  return out
}

interface Entry {
  id: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  meta: JsonlSessionMetadata
  session?: PiSession<JsonlSessionMetadata>
  harness?: AgentHarness<ExecutionToolContext>
  lane?: AgentLane
  projection?: SessionProjection
  unsubscribes?: Array<() => void>
  /** 确认钩子的取消函数。单独放:它必须活到 stop() 之后才能摘(见 closeEntry)。 */
  unhook?: () => void
  /** 这个会话的装配面。留着是为了关会话时收长驻工具(log 的采集器握着串口)。 */
  tools?: RegisteredTool[]
  /**
   * prompt() 在 accept 之前的准备期(压缩附件图片,可能要几秒)。这段时间 lane 还是 idle,
   * stop() 找不到任何在飞的操作 —— 没有这个标记,用户按下的"停止"会被整个吞掉。
   */
  preparing?: { cancelled: boolean; controller: AbortController }
  activeToolNames?: string[]
  stm32Availability?: Stm32Availability
  /**
   * 正在打开。**每个调用方都 await 这同一个 Promise** —— 两个并发的 ensureOpen 各自
   * 去 repo.open 的话,其中一个必然撞上内核的 `Session is already open`,而另一种时序
   * 下第二个调用方会拿到 projection 还没装好的 entry(messages/navigate 直接 TypeError,
   * prompt 静默丢事件)。
   */
  opening?: Promise<Entry>
  /** 正在关闭。设了就算"没开",ensureOpen 必须等它收完再干净地重开。 */
  closing?: Promise<void>
  /** 本会话 bash 的基础环境。refreshMachineEnv 换掉它,下一轮的 env 按新的造。 */
  shellEnv?: NodeJS.ProcessEnv
  /** 当前的执行环境(工具每轮取一次)。dispose 时 cleanup 收掉遗留子进程。 */
  env?: NodeExecutionEnv
  /**
   * 被 refreshMachineEnv 换下来的执行环境。**硬件安全**:它们可能还拖着子进程(一条
   * 正在跑的烧录命令),必须等这一轮结束 / 会话销毁时 cleanup,不能直接丢引用。
   */
  retiredEnvs?: NodeExecutionEnv[]
  /** 开会话时的工具链解析结果;刷新 PATH 时重算。 */
  toolchain?: ToolchainResolution
  status: SessionStatus
  /** 上一次被使用的时刻,LRU 用。 */
  touched: number
  /** 在飞操作的 operationId —— requestAbort 要按它 fence。 */
  operationId?: string
  /** run 是否在飞。压缩结束后回 busy 还是 idle 看它(轮内压缩是 run 的一段)。 */
  running?: boolean
  model?: { providerID: string; modelID: string; thinking?: string }
  /**
   * renderer 乐观插入用户消息时铸的 id,等**这条**用户消息落盘时复用。带着原文是因为 accept 会把收件箱里
   * 排着的消息收在本次 prompt **之前**:只认"下一条 user 消息"的话,排队的那条会抢走这个 id。
   */
  pendingUser?: { id: string; text: string }
  /** 子 agent 的会话:派它的主会话(repo 的 parentSessionId)。有它的会话不接用户的 prompt。 */
  parentID?: string
  /** 子会话怎么装配:agent 类型、profile、模型入参。进程重启后由 openEntry 从 yoma/subagent 值补齐。 */
  child?: { agent: string; profile?: AgentProfile; model?: string }
  /** 主会话打开时读到的 agent 定义快照:agent 工具的描述由它拼,会话内不变。 */
  profiles?: AgentProfile[]
  /** 子 agent 任务排队中 / 运行中:LRU 不许淘汰它(docs/子agent-设计方案-v0.4-20260918.md §6.7)。 */
  pinned?: boolean
  /** 收件箱现状(queue_update):忙时发的消息、子 agent 的通知。 */
  queued?: LaneQueuedItem[]
  /**
   * "决定起一轮还是排队"的串行链:prompt() 与 wake() 都在它上面排队。准备期(压缩图片)里又来一条,
   * 后来的那条等前一条 accept 完再判断忙闲 —— 否则两条都以为自己该起一轮,后一条撞 LaneBusy。
   */
  admission?: Promise<void>
  /** 本会话发现的技能:子 agent 首轮按 profile.skills 预加载要用。 */
  skills?: Skill[]
  /** 子会话的 maxTurns:runId → 已开始的 assistant 轮数;命中上限的 runId(§6.6)。 */
  turnCounts?: Map<string, number>
  maxTurnsHit?: Set<string>
  /** yoma/subagent 值的读—改—写串行链:通知与落定几乎同时写它。 */
  metaWrites?: Promise<void>
}

export interface SessionManagerOptions {
  sessionsRoot: string
  enginesDir?: string
  emit(events: KernelEvent[]): void
  /**
   * 上下文文件与技能的全局目录,默认 `~/.yoma`。测试用它隔离开发机上的真实目录。
   */
  configDir?: string
  /** 本机资源探测边界;测试注入以隔离真实安装。 */
  inspectStm32Availability?: typeof inspectStm32Availability
  /**
   * 模型目录的来源。默认复用 yoma 的 resolveModel()(读 `<configDir>/auth.json`)。
   * 可注入是为了两件事:测试用 pi-ai 的 faux provider 跑完整一轮而不需要网络和 key;
   * 以及 P6 换成我们自己的凭据管理(Electron safeStorage)时不用改这里。
   */
  resolveModels?: () => Promise<{ models: Models; model: Model<string> }>
  /**
   * 凭据解析看哪个环境(pi-ai 的 AuthContext:环境变量 + 文件存在性)。**测试接缝**,生产不传。
   * 目录有 40 家 provider,开发机上一个 ANTHROPIC_API_KEY 或一份 ~/.aws/credentials 就能让
   * "首跑没有任何 key"的测试说谎;测试传 yoma 的 NO_AMBIENT_AUTH,只认 auth.json。
   */
  authContext?: AuthContext
  /**
   * 没人选档时用哪一档。不传则内核落到 `"off"`。
   * 桌面端与 bench 都传 `max`;`setModel` 的显式选择压过它。
   */
  defaultThinkingLevel?: string
  /**
   * 工具链清单按哪一侧筛(清单里每条工具的 `side` 字段)。**不传就是 `"mother"`**,
   * 桌面端与信箱研发端都属于这一侧。
   *
   * 信箱的**工位端必须传 `"runner"`**:那台机器上只有板子,核它有没有 cmake /
   * arm-gcc 毫无意义,而清单里那几条会一路报 MISSING —— 纯噪音,还会盖住真正缺的
   * 那条(jlink / python)。
   */
  toolchainSide?: "mother" | "runner"
  /**
   * 工具链清单的原文,绕开"从 projectDir 读 `.yoma/toolchain.json`"这一步。
   *
   * 存在的理由只有一个:**工位端没有项目检出**。它的 cwd 是一次性目录,清单文件不在
   * 那儿,于是解析静默短路(`tools: []`),这一侧对"该有什么、缺了怎么装"一无所知 ——
   * 表现是 agent 照着指令跑脚本,撞一个 ModuleNotFoundError,把它当成"脚本坏了"报回去,
   * 研发端拿到一条误导性证据。清单经信箱送过来,从这里灌进去。
   *
   * 注意它只替掉"读清单"这一步:`toolchain.local.json`(本机覆盖)与账本仍按
   * projectDir / configDir 读 —— 那两样本来就是本机事实,不该跟着信箱走。
   */
  toolchainManifestText?: string
  /**
   * 契约说要问的工具(今天只有 flash)跑之前先问用户。**不传 = 不挂钩子 = 谁都不问**。
   *
   * 桌面端传 true;bench 与信箱工位端**不能传** —— 那两个宿主无人值守,挂起只会一路等到
   * 确认台的十分钟超时,而 bench 判一轮结束看的是 idle 700ms,中间这十分钟没有任何人在看。
   */
  confirmTools?: boolean
  /**
   * 工具链安装的在飞注册表,与设置页的 `toolchain.install` RPC 共用同一个 —— agent 自己装和用户点着装
   * 是两条调用路径,同一个包同时跑两路会往同一棵目录树里解压。**不传 = 两边各装各的**,所以桌面端必须传。
   */
  installRegistry?: InstallRegistry
  /** 子 agent(docs/子agent-设计方案-v0.4-20260918.md)。不传就是缺省:能后台、并发 10、不自动转后台。 */
  subagents?: {
    /**
     * false = 一律前台,`run_in_background` 从 schema 里摘掉(CC 的 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)。
     * **bench 与信箱工位端必须传 false**:它们按"idle 静默"判一轮结束,后台子 agent 在跑时主会话是 idle 的,
     * 这个判据就说谎了;而且它们一轮一个子进程,后台任务本来也活不过这一轮。
     */
    background?: boolean
    /** 同时在跑的子 agent 上限,超出的排 pending。缺省 `YOMA_MAX_CONCURRENT_AGENTS` 或 10。 */
    maxConcurrent?: number
    /** 前台子 agent 跑满这么久自动转后台;0 = 关。缺省 `YOMA_AUTO_BACKGROUND_MS` 或 0(CC 缺省关)。 */
    autoBackgroundMs?: number
    /** output_file 的根,缺省 `<系统临时目录>/yoma`。测试注入。 */
    outputRoot?: string
    /** 项目 agent 定义沿祖先链找到哪为止(不含),缺省 home。测试必须注入,理由同 loadAgentProfiles。 */
    homeDir?: string
  }
}

export class SessionManager {
  private readonly env: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  /** 每份注册表自动联网一次;凭据变化重建注册表时重置。 */
  private modelRefreshStarted = false
  private readonly entries = new Map<string, Entry>()
  private envRefreshGeneration = 0
  private readonly options: SessionManagerOptions
  /** 凭据、技能、上下文文件共用的一个目录。 */
  private readonly configDir: string
  /**
   * 所有内核调用的 Context。宿主没有"取消一次 RPC"这回事 —— 轮次的取消走
   * lane.requestAbort(那是**落盘的**取消事实),不靠 signal。
   */
  private readonly context: Context = BACKGROUND_CONTEXT

  private models?: Models
  private modelsPending?: Promise<{ models: Models; model: Model<string> }>
  private defaultModel?: Model<string>
  private modelError?: string

  /**
   * 确认台。只有 confirmTools 开着才有人往里放东西(钩子在 openEntry 里挂),
   * 所以关着的宿主连事件都不会多一条。
   */
  private readonly desk: ConfirmDesk

  /** 子 agent 的任务注册表与调度(host/tasks.ts)。它经 taskPort() 这个窄接口用我们,不碰 harness。 */
  private readonly taskManager: TaskManager

  /**
   * 仓库目录操作(create / list / delete)的串行链。上游 JsonlSessionRepo 在同一进程里并发不安全:create 先列目录查
   * id 有没有被占(assertSessionIdAvailable),新会话文件则先写 `.jsonl.tmp` 再改名 —— 另一个 create / list 正好
   * 列到那个 tmp、再去 lstat 时它已被改名,整个调用以 ENOENT 失败(2026-09-19 实测:一条消息并行派 3 个子 agent,
   * 时不时少建一个)。上游锁定不能改,在这里排队。
   */
  private repoQueue: Promise<void> = Promise.resolve()

  private repoLocked<T>(task: () => Promise<T>): Promise<T> {
    const run = this.repoQueue.then(task)
    this.repoQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.desk = new ConfirmDesk({ emit: (confirm) => options.emit([{ type: "tool.confirm", confirm }]) })
    this.configDir = options.configDir ?? yomaConfigDir()
    this.env = new NodeExecutionEnv({ cwd: process.cwd() })
    this.repo = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot: options.sessionsRoot })
    const subagents = options.subagents ?? {}
    this.taskManager = new TaskManager({
      port: this.taskPort(),
      background: subagents.background ?? true,
      maxConcurrent: Math.max(
        1,
        subagents.maxConcurrent ?? envNumber("YOMA_MAX_CONCURRENT_AGENTS") ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      ),
      autoBackgroundMs: subagents.autoBackgroundMs ?? envNumber("YOMA_AUTO_BACKGROUND_MS") ?? 0,
      outputRoot: subagents.outputRoot ?? path.join(tmpdir(), "yoma"),
    })
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  /**
   * 延迟解析模型目录。
   *
   * 复用 yoma 自己的 resolveModel() —— 它读 `<configDir>/auth.json`,也就是用户配 Zed
   * 时已经填好的凭据,于是桌面端零配置就能开跑。**不在构造时解析**:没有 key 时它会抛,
   * 那不该让整个内核进程起不来 —— 前端还得能显示会话列表并引导去配置。
   */
  private async ensureModels(): Promise<{ models: Models; model: Model<string> }> {
    if (this.models && this.defaultModel) return { models: this.models, model: this.defaultModel }
    if (this.modelsPending) return this.modelsPending
    // 首屏多处并发读目录必须共用同一次解析。否则后台刷 A,后来的 B 盖掉 A,
    // 远端目录只存进磁盘、界面仍读旧 B,表现为第二次启动才出现新模型。
    const pending = Promise.resolve()
      .then(async () => {
        // 老用户的 key 还在 ~/.pi/agent/auth.json 里,搬一次(幂等,不删旧文件)。
        // 放在解析之前:不搬的话升级一次 app 就是"key 不见了",而用户什么都没做。
        //
        // **只在没注入 configDir 时搬**:注入的调用方(测试、隔离跑的 bench)显然是在
        // 隔离,那就不该反手去读真实 HOME 里的老凭据 —— 否则隔离是假的,而且会把用户
        // 真实的 key 复制进一个临时目录(写这条测试时就是这么发现的)。
        if (!this.options.resolveModels && !this.options.configDir) migrateLegacyPiAuth(this.configDir)
        const resolved = this.options.resolveModels
          ? await this.options.resolveModels()
          : ((await resolveModel(this.configDir, { authContext: this.options.authContext })) as {
              models: Models
              model: Model<string>
            })
        return { models: resolved.models, model: resolved.model as Model<string> }
      })
      .then(
        (resolved) => {
          // 解析期间改了凭据:旧结果不能覆盖新注册表,等待新的一份。
          if (this.modelsPending !== pending) return this.ensureModels()
          this.models = resolved.models
          this.defaultModel = resolved.model
          this.modelError = undefined
          return resolved
        },
        (error) => {
          if (this.modelsPending !== pending) return this.ensureModels()
          this.modelError = (error as Error).message
          throw error
        },
      )
      .finally(() => {
        if (this.modelsPending === pending) this.modelsPending = undefined
      })
    this.modelsPending = pending
    return pending
  }

  modelStatus(): { ready: boolean; error?: string } {
    return { ready: Boolean(this.models), error: this.modelError }
  }

  /**
   * 模型目录。
   *
   * thinkingLevels 必须走 pi-ai 的 getSupportedThinkingLevels(model) 去问,不能自己编 ——
   * 每个模型的 thinkingLevelMap 不同,编错的直接后果是档位在 UI 上能选但发不出去。
   * 解析失败不抛:返回空列表,让前端去引导配置凭据,而不是白屏。
   */
  async providers(): Promise<ProviderInfo[]> {
    // 只要一个 key 就能连的 provider(yoma 按 pi-ai 的 login 流程推导)。没配的也要列出来
    // (空模型表 + authenticated: false),用户才能从连接对话框里给它加 key。
    const configurable = await configurableProviders()
    let models: Models
    try {
      models = (await this.ensureModels()).models
    } catch {
      // 一个 key 都没配时 resolveModel() 直接抛,注册表是空的。这时必须交出
      // 可配置目录(authenticated: false),否则连接对话框无物可列,首跑用户被锁死。
      return configurable.map((spec) => ({ id: spec.id, name: spec.name, authenticated: false, models: [] }))
    }

    // resolveModel() 的不变式:注册 == 已配置(没凭据的它不注册),所以注册表里的一律 authenticated。
    const out: ProviderInfo[] = []
    for (const provider of models.getProviders()) {
      out.push({
        id: provider.id,
        name: provider.name,
        authenticated: true,
        models: provider.getModels().map((model) => ({
          id: model.id,
          providerID: provider.id,
          name: model.name ?? model.id,
          thinkingLevels: getSupportedThinkingLevels(model) as string[],
          contextWindow: model.contextWindow,
          maxOutput: model.maxTokens,
          cost: model.cost
            ? {
                input: model.cost.input,
                output: model.cost.output,
                cacheRead: model.cost.cacheRead,
                cacheWrite: model.cost.cacheWrite,
              }
            : undefined,
        })),
      })
    }
    for (const spec of configurable) {
      if (!out.some((provider) => provider.id === spec.id))
        out.push({ id: spec.id, name: spec.name, authenticated: false, models: [] })
    }
    this.kickModelCatalogRefresh(out)
    return out
  }

  /**
   * 联网刷新模型目录,刷完的结果落进 `<configDir>/models-store.json`(FileModelsStore)。
   *
   * **这是整个内核里唯一一条主动碰模型目录网络的路。** 开会话那条只恢复磁盘缓存(见 models.ts),
   * 所以断网、机场、厂商挂了都不影响开会话 —— 代价只是模型列表停在上一次刷新。
   *
   * 单个 provider 失败不算整次失败:一家的目录接口挂了,不该让别家的新模型也拿不到。失败逐条发
   * kernel.error 诊断,列表照常返回。
   */
  async refreshModels(options: { force?: boolean } = {}): Promise<ProviderInfo[]> {
    try {
      const { models } = await this.ensureModels()
      const result = await models.refresh({ allowNetwork: true, force: options.force ?? true })
      if (this.models !== models) return this.providers()
      for (const [providerID, error] of result.errors) {
        this.options.emit([
          { type: "kernel.error", message: `刷新 ${providerID} 的模型目录失败:${error?.message ?? String(error)}` },
        ])
      }
    } catch {
      // 一个 key 都没配时 ensureModels() 抛 —— 那时本来也没有 provider 可刷,
      // 下面的 providers() 会走"未配置"那条路,交出可连接的目录。
    }
    return this.providers()
  }

  /** 名称、档位、上下文和价格变化也要通知界面。 */
  private static signatureOf(providers: ProviderInfo[]): string {
    return JSON.stringify(providers)
  }

  /**
   * 首次有人问模型列表时,在后台联网刷一次。
   *
   * 放在这里而不是开会话时:开会话在关键路径上,而"看一眼模型下拉"不是。fire-and-forget,
   * 刷完只有**真的变了**才推事件 —— 每次开界面都推一次空更新,只会让前端白重渲染。
   */
  private kickModelCatalogRefresh(current: ProviderInfo[]): void {
    if (this.modelRefreshStarted) return
    this.modelRefreshStarted = true
    const before = SessionManager.signatureOf(current)
    void (async () => {
      const after = await this.refreshModels({ force: false }).catch(() => undefined)
      if (!after || SessionManager.signatureOf(after) === before) return
      this.options.emit([{ type: "model.updated", providers: after }])
    })()
  }

  // -------------------------------------------------------------------------
  // 凭据
  // -------------------------------------------------------------------------

  /**
   * 写入一个 provider 的 API key(落到 yoma 读的那份 `<configDir>/auth.json`)。
   *
   * 写完必须丢弃已解析的模型目录:resolveModel() 只注册写入当时有 key 的 provider,
   * 不重解析的话新 key 要等重启进程才生效。注意 **已经开着的会话拿的还是旧注册表**
   * (harness 的 models 建好之后换不掉),新开/重开的会话才能用新 provider ——
   * 首跑场景(一个会话都没有)不受影响。
   *
   * key 本身不做网络验证:注册 provider 时不发请求,错 key 的暴露点是第一次
   * prompt 的 API 401,那条错误会走正常的会话错误通道显示出来。
   */
  async setAuth(providerID: string, apiKey: string): Promise<ProviderInfo[]> {
    const trimmed = apiKey.trim()
    if (!trimmed) throw new Error("API key 不能为空")
    const configurable = await configurableProviders()
    if (!configurable.some((spec) => spec.id === providerID))
      throw new Error(`未知 provider ${providerID}。可配置:${configurable.map((spec) => spec.id).join(", ")}`)
    await writeAuthKey(providerID, trimmed, this.configDir)
    this.invalidateModels()
    return this.providers()
  }

  /** 移除一个 provider 的 key。同样丢弃模型目录缓存。 */
  async removeAuth(providerID: string): Promise<ProviderInfo[]> {
    await removeAuthKey(providerID, this.configDir)
    this.invalidateModels()
    return this.providers()
  }

  private invalidateModels(): void {
    this.modelsPending = undefined
    this.modelRefreshStarted = false
    this.models = undefined
    this.defaultModel = undefined
    this.modelError = undefined
  }

  /**
   * 换模型 / 换 thinking 档位。
   *
   * 跨 provider 切换只有在所有 provider 都提前注册好的前提下才成立 —— harness 的
   * models 建好之后换不掉,而未注册的 provider 要等真正发请求时才报错。
   * resolveModel() 已经把 auth.json 里每个有 key 的 provider 都注册了,所以这里安全。
   */
  async setModel(sessionID: string, providerID: string, modelID: string, thinking?: string): Promise<ViewSession> {
    const entry = await this.ensureOpen(sessionID)
    const lane = entry.lane!
    const { models } = await this.ensureModels()
    const model = models.getModel(providerID, modelID)
    if (!model) throw new Error(`未知模型 ${providerID}/${modelID}`)

    await lane.setModel({ provider: providerID, modelId: modelID }, this.context)
    // 钳一下:模型不支持的档位直接设进去会等到发请求时才炸。
    //
    // 没给 thinking 时也要钳 —— 当前这一档是按**换之前那个模型**的支持表定的。
    // 不重钳就会拿着旧模型的档位去发新模型的请求。对桌面端这是恒等变换:
    // 它没选过档位时当前值就是 "off",clamp("off") 在任何模型上都还是 "off"。
    const level = thinking ?? (await lane.getThinkingLevel(this.context))
    await lane.setThinkingLevel(clampThinkingLevel(model, level as never), this.context)
    entry.updatedAt = Date.now()
    const view = toView(entry)
    this.options.emit([{ type: "session.updated", session: view }])
    return view
  }

  // -------------------------------------------------------------------------
  // 列表 / 创建 / 删除
  // -------------------------------------------------------------------------

  async list(directory?: string): Promise<ViewSession[]> {
    const metas = await this.repoLocked(() => this.repo.list(directory ? { cwd: directory } : {}, this.context))
    const out: ViewSession[] = []
    for (const meta of metas) {
      const existing = this.entries.get(meta.id)
      if (existing) {
        out.push(toView(existing))
        continue
      }
      const entry: Entry = {
        id: meta.id,
        cwd: meta.cwd,
        // 标题懒加载:repo.list() 只读 JSONL 的头一行,拿不到后来写进去的会话名。
        // 真名在 open() 时补上,列表先用占位,避免为了画一个列表把每个会话文件全读一遍。
        title: "",
        createdAt: meta.createdAt,
        updatedAt: meta.modifiedAt,
        meta,
        status: { type: "idle" },
        touched: 0,
        // 父子关系在会话文件头里(repo.create 的 parentSessionId),不开会话就知道。
        ...(meta.parentSessionId ? { parentID: meta.parentSessionId } : {}),
      }
      this.entries.set(meta.id, entry)
      out.push(toView(entry))
    }
    return out.sort((a, b) => b.time.updated - a.time.updated)
  }

  async create(directory: string, title?: string): Promise<ViewSession> {
    const session = await this.repoLocked(() => this.repo.create({ cwd: directory }, this.context))
    const meta = session.metadata
    const entry: Entry = {
      id: meta.id,
      cwd: meta.cwd,
      title: title ?? "",
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      meta,
      session,
      status: { type: "idle" },
      touched: Date.now(),
    }
    this.entries.set(entry.id, entry)
    if (title) await session.setName(title, this.context)
    const view = toView(entry)
    this.options.emit([{ type: "session.created", session: view }])
    return view
  }

  /**
   * 删会话。主会话连它的子会话一起删(先停掉它的任务,再逐个删子会话、发 session.deleted);
   * 子会话被单独删时,它的任务一并停掉、从注册表拿掉。
   */
  async delete(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry) return
    if (entry.parentID) await this.taskManager.forgetTask(sessionID)
    else {
      await this.taskManager.forgetParent(sessionID)
      // 子会话与父同一个 cwd;list 把还没进内存的也补进 entries。
      await this.list(entry.cwd)
      const children = [...this.entries.values()].filter((item) => item.parentID === sessionID)
      for (const child of children) await this.deleteEntry(child)
    }
    await this.deleteEntry(entry)
  }

  private async deleteEntry(entry: Entry): Promise<void> {
    await this.dispose(entry)
    await this.repoLocked(() => this.repo.delete(entry.meta, this.context))
    this.entries.delete(entry.id)
    this.options.emit([{ type: "session.deleted", sessionID: entry.id }])
  }

  /** 标题写回 JSONL(会话名是内核的绑定值),不是只存在内存里。 */
  async rename(sessionID: string, title: string): Promise<ViewSession> {
    const entry = await this.ensureOpen(sessionID)
    await entry.harness!.setName(title, this.context)
    entry.title = title
    entry.updatedAt = Date.now()
    const view = toView(entry)
    this.options.emit([{ type: "session.updated", session: view }])
    return view
  }

  get(sessionID: string): ViewSession {
    const entry = this.entries.get(sessionID)
    if (!entry) throw sessionNotFound(sessionID)
    return toView(entry)
  }

  status(sessionID: string): SessionStatus {
    return this.entries.get(sessionID)?.status ?? { type: "idle" }
  }

  // -------------------------------------------------------------------------
  // 打开 / 重放
  // -------------------------------------------------------------------------

  /**
   * 打开(或复用)一个会话。readOnly 只加载历史,执行操作才装配 harness。
   *
   * 三条纪律,每条都对应过一次真实故障:
   *
   * 1. **同一个会话同时只装配一次**。两个并发调用各自去 repo.open,其中一个必然撞上内核的
   *    `Session is already open`;所以装配过程记在 entry.opening 上,后来的调用方都等它。
   * 2. **装配完成是一个原子时刻**。lane/projection/订阅在最后一起挂上去,中间全用局部变量。
   *    否则第二个调用方可能拿到一个 lane 有了、projection 还没有的 entry —— messages()
   *    和 navigate() 直接 TypeError,prompt() 则静默丢掉整轮事件。
   * 3. **半路失败要关干净**。harness/session 不关掉的话 entry 会永远带着一条死 lane,
   *    而 repo 也不让这个会话再开第二次。
   */
  private async ensureOpen(sessionID: string, readOnly = false): Promise<Entry> {
    let found = this.entries.get(sessionID)
    if (!found) {
      await this.list()
      found = this.entries.get(sessionID)
    }
    if (!found) throw sessionNotFound(sessionID)
    // 闭包(toolContext)要一个确定非空的引用,所以先定住。
    const entry = found
    entry.touched = Date.now()
    // 正在销毁:它会把 lane/projection 逐个清掉,这中间交出去的 entry 是半关的。
    if (entry.closing) await entry.closing.catch(() => {})
    if (entry.opening) {
      const preparation = entry.preparing
      try {
        await entry.opening
      } catch (error) {
        // A new prompt/history read may arrive while an aborted first probe is still closing.
        // Wait for that cleanup, then reopen; genuine opening failures still reach the caller.
        if (!readOnly || !preparation?.cancelled) throw error
      }
    }
    if (isOpen(entry) || (readOnly && entry.projection)) return entry
    entry.opening ??= (readOnly ? this.readEntry(entry) : this.openEntry(entry)).finally(() => {
      entry.opening = undefined
    })
    return entry.opening
  }

  /** 查看历史只读会话文件,不装配模型、工具或执行环境。与装配共用 opening 锁。 */
  private async readEntry(entry: Entry): Promise<Entry> {
    const session = entry.session ?? (await this.repo.open(entry.meta, this.context))
    entry.session = session
    await this.fillListed(entry, session)
    const projection = this.newProjection(entry)
    const branch = await session.branch("main", this.context)
    if (branch) await this.replay(branch, projection)
    entry.projection = projection
    return entry
  }

  private async openEntry(entry: Entry): Promise<Entry> {
    const preparationSignal = entry.preparing?.controller.signal
    // 工具链解析必须在造 NodeExecutionEnv **之前**拿到结果:shellEnv 只能通过构造参数
    // 一次性灌进去(私有字段,没有 setter),而子进程认的是造 env 那一刻的环境 ——
    // 运行时再对着已经造好的 env 补 PATH 不会生效(根 CLAUDE.md「会咬人的地方」第一条)。
    //
    // 不能像 loadContextFiles/discoverSkills 那样并进它们那个 Promise.all —— 那两个
    // 的入参正是 env,而 env 本身要等这次解析完才能造出来,凑一起就是循环依赖。
    // 真正同类(不依赖 env、建会话时只读一次的快照)又能安全并发的是 ensureModels()。
    const baseEnv = this.baseShellEnv(await this.machineDirs())
    const [{ models, model }, toolchain] = await Promise.all([
      this.ensureModels(),
      this.resolveToolchainSafe(entry, baseEnv),
    ])

    const session = entry.session ?? (await this.repo.open(entry.meta, this.context))
    entry.session = session
    await this.fillListed(entry, session)
    entry.toolchain = toolchain
    // engines/bin 前置进 PATH:bash 工具里要有 rg(在例程语料里 grep 全靠它,Windows
    // 没有内置 grep)。机器级目录(Yoma 装的 + 用户手指的)夹在中间:项目清单解析到的
    // 赢过它们,它们赢过 process.env 里原有的。
    entry.shellEnv = this.sessionShellEnv(toolchain, baseEnv)
    const env = this.toolEnv(entry)
    let harness: AgentHarness<ExecutionToolContext> | undefined
    try {
      // 资源发现:项目的 AGENTS.md/CLAUDE.md(全局 + 祖先链)与技能(全局 + .agents/skills)。
      // 走 host/resources.ts,不重写:"从哪些目录找"是产品决策,抄一份的结果
      // 会是"某一端读得到项目上下文、另一端读不到"这种极难归因的差异。
      // 快照式:会话创建时读一次,改了技能文件重开会话即生效,不做热重载。
      const [contextFiles, discovered] = await Promise.all([
        loadContextFiles(env, { cwd: entry.cwd, globalDir: this.configDir }),
        discoverSkills(env, { cwd: entry.cwd, globalDir: this.configDir }),
      ])
      for (const diagnostic of discovered.diagnostics) {
        this.options.emit([
          {
            type: "kernel.error",
            sessionID: entry.id,
            message: `技能 ${diagnostic.code} ${diagnostic.path}:${diagnostic.message}`,
          },
        ])
      }

      // 子 agent 的会话按自己的 profile 装配(docs/子agent-设计方案-v0.4-20260918.md §4、§5.3、§6.8);
      // 主会话读 agent 定义的快照(会话内不变,agent 工具的描述因此字节稳定)、拿 TaskHost 门面。
      const profile = entry.parentID ? await this.childProfile(entry, session) : undefined
      if (!profile) {
        const loaded = await loadAgentProfiles({
          cwd: entry.cwd,
          configDir: this.configDir,
          homeDir: this.options.subagents?.homeDir,
        })
        for (const diagnostic of loaded.diagnostics) {
          this.options.emit([
            { type: "kernel.error", sessionID: entry.id, message: `agent 定义 ${diagnostic.path}:${diagnostic.message}` },
          ])
        }
        entry.profiles = loaded.profiles
      }
      entry.skills = discovered.skills

      // 工具链状态并进系统提示词:追加一条 contextFiles,不新增专门字段 ——
      // 不给 BuildSystemPromptOptions 加专门字段:系统提示词的形状是产品决定,追加上下文文件是既有通道。
      // path 给一个不会真实存在的假名,模型才看得出这不是一份项目文件。promptSectionFor
      // 对"没有清单"和"清单存在但全部 ok"都返回 undefined,所以绝大多数项目不追加任何
      // 东西,系统提示词字节不变。

      const allTools = createAgentTools({
        enginesDir: this.options.enginesDir,
        configDir: this.configDir,
        invocationEnv: () => this.toolEnv(entry),
        toolchain: {
          configDir: this.configDir,
          side: this.options.toolchainSide ?? "mother",
          manifestText: this.options.toolchainManifestText,
          // agent 装的和用户在设置页点着装的走同一条进度事件,于是 UI 上长得一样、注册表也拦得住对方。
          onInstallProgress: (progress) => this.options.emit([installProgressEvent(progress)]),
          onInstalled: () => this.refreshMachineEnv(),
          installRegistry: this.options.installRegistry,
        },
        // 手册服务器地址从同一个 configDir 的 .env 解析:设置页、手册库页、agent 说同一个地址。
        datasheet: { configDir: this.configDir },
        // 子 agent 四件的宿主门面,绑定本会话 id。子会话不给:四件在子会话里由硬黑名单裁掉(§5.3)。
        ...(profile
          ? {}
          : { agents: { host: this.taskManager.hostFor(entry.id, () => entry.profiles ?? []), canReadOutputFile: true } }),
      })
      entry.stm32Availability = await this.inspectStm32(entry, preparationSignal)
      preparationSignal?.throwIfAborted()
      const tools = profile ? this.childTools(entry, profile, allTools) : allTools
      entry.activeToolNames = profile
        ? tools.map((tool) => tool.name)
        : activeToolNames(tools, entry.stm32Availability!.available, true)
      // 新 lane 的种子。子 agent:模型按 env > 入参 > profile > 继承主会话,思考缺省 off(CC 同款,§4.5);
      // 主会话:宿主不表态就交给内核(off)。重开旧会话时用的是 lane 自己存下来的那一组。
      const seed = profile
        ? this.childSeed(entry, profile, models, model)
        : {
            model,
            thinkingLevel: this.options.defaultThinkingLevel
              ? (pickThinkingLevel(
                  getSupportedThinkingLevels(model) as string[],
                  this.options.defaultThinkingLevel,
                ) as ThinkingLevel)
              : undefined,
          }
      const created = await AgentHarness.create<ExecutionToolContext>(
        {
          session,
          models,
          model: seed.model,
          ...(seed.thinkingLevel ? { thinkingLevel: seed.thinkingLevel } : {}),
          tools,
          activeToolNames: entry.activeToolNames,
          // 函数形态:每轮重新解析一次,于是 refreshMachineEnv 换掉 shellEnv 之后
          // 下一条 bash 命令就看得见新 PATH,不用重开会话。
          toolContext: () => ({ env: this.toolEnv(entry) }),
          systemPrompt: () => {
            const toolchainSection = promptSectionFor(entry.toolchain ?? toolchain)
            const stm32Note = entry.stm32Availability?.available
              ? undefined
              : `STM32 configuration is unavailable on this machine: ${entry.stm32Availability?.reason ?? "local CubeMX resources are unavailable"}. Do not call stm32config or use netlist with part, and do not bypass this unavailable capability by invoking its engine or pretending handwritten initialization came from stm32config. Ordinary firmware coding remains allowed. Explain the missing local resource only when relevant; do not install or configure CubeMX just to enable this tool. Existing source settings can enable it on the next user turn. Netlist without part and other tools remain available.`
            if (profile) {
              // 子 agent(§4.2):agent 正文 + CC 的四条 Notes + 工具清单与守则 + env 块;omitContextFiles 的
              // 不给项目上下文(CC omitClaudeMd)。工具链那一段是这台机器的事实,不算项目上下文,照给。
              return buildSystemPrompt({
                cwd: entry.cwd,
                agentPrompt: profile.prompt,
                selectedTools: entry.activeToolNames,
                contextFiles: [
                  ...(profile.omitContextFiles ? [] : contextFiles),
                  ...(toolchainSection ? [{ path: "<toolchain>", content: toolchainSection }] : []),
                ],
                skills: discovered.skills,
                // 那句 STM32 的话只对手上有 netlist / stm32config 的 agent 有意义。
                appendSystemPrompt: entry.activeToolNames?.some((name) => name === "netlist" || name === "stm32config")
                  ? stm32Note
                  : undefined,
                environment: {
                  platform: process.platform,
                  date: localDate(),
                  ...(entry.model ? { model: `${entry.model.providerID}/${entry.model.modelID}` } : {}),
                },
              })
            }
            return buildSystemPrompt({
              cwd: entry.cwd,
              selectedTools: entry.activeToolNames,
              contextFiles: toolchainSection
                ? [...contextFiles, { path: "<toolchain>", content: toolchainSection }]
                : contextFiles,
              skills: discovered.skills,
              appendSystemPrompt: stm32Note,
            })
          },
          // lane.skill() 从这里查技能。
          resources: { skills: discovered.skills },
        },
        this.context,
      )
      harness = created.harness
      const lane = await harness.lane("main", this.context)

      // **硬件安全**:上个进程没跑完的操作绝不自动续跑(那可能是一条烧录或 gdb 命令)。
      // 先把它落成 aborted,再把会话交给前端。订阅在这之后装,所以这一串收尾事件
      // 不会冒到 UI 上,重放会如实显示那一轮被中断了。
      if (created.open.some((operation) => operation.lane === lane.name)) {
        const aborted = await lane.abort(this.context)
        if (!aborted.ok && aborted.error._tag !== "NoActiveOperation") {
          this.options.emit([
            {
              type: "kernel.error",
              sessionID: entry.id,
              message: `收尾上次未完成的操作失败:${laneErrorMessage(aborted.error)}`,
            },
          ])
        }
      }
      // 持久化旧会话可能保留旧工具名单;本机实际能力优先于历史配置。
      preparationSignal?.throwIfAborted()
      await lane.setActiveTools(entry.activeToolNames, this.context)

      // 模型与档位是 lane 存下来的(上面那组种子只给新 lane 用)。但存下来的那个可能已经
      // 不在注册表里了(用户撤了 key、或者注入的目录换了一套)—— getModel 这时返回
      // undefined,而内核要等到真的发请求才报"配置错误",于是每一轮都在同一处失败、
      // 用户无从下手。这里静默落回本次解析出的默认模型,与换内核之前一致(那时模型不落盘)。
      if (!(await lane.getModel(this.context))) {
        await lane.setModel({ provider: model.provider, modelId: model.id }, this.context)
        await lane.setThinkingLevel(clampThinkingLevel(model, await lane.getThinkingLevel(this.context)), this.context)
      }
      const configured = (await lane.inspectExecution(this.context)).configuredModel
      entry.model = {
        providerID: configured.provider,
        modelID: configured.modelId,
        thinking: await lane.getThinkingLevel(this.context),
      }

      // 重放历史。走的是和 live 完全相同的 applyMessage(),所以 id 与事件序列可复现。
      // 在挂上去之前放完:挂上去那一刻 entry 就算"开着的",交出去的投影必须是完整的。
      const projection = this.newProjection(entry)
      await this.replay(lane, projection)

      // 这几行之间**不能有 await** —— 它们一起构成"这个会话开好了"这一个事实。
      entry.harness = harness
      entry.projection = projection
      entry.tools = tools
      entry.unsubscribes = [
        ...this.subscribe(entry, harness),
        ...(profile?.maxTurns ? this.maxTurnsHooks(entry, harness, profile.maxTurns) : []),
      ]
      // 确认钩子**不**并进 unsubscribes:closeEntry 先摘订阅再 stop,而 desk.cancel 结算掉第一条之后,
      // 同一批里的第二条工具会立刻轮到 before_tool —— 钩子已摘,它就无人确认地起跑了。所以钩子
      // 要活到 stop() 之后,由 closeEntry 单独摘。子会话的 before_tool 还兼管 maxTurns 的兜底拦截,所以总是挂。
      if (profile) {
        entry.unhook = harness.hooks.on("before_tool", (event, context) =>
          this.childBeforeTool(entry, profile, event, context),
        )
      } else if (this.options.confirmTools) {
        entry.unhook = harness.hooks.on("before_tool", (event, context) => this.beforeTool(entry, event, context))
      }
      entry.lane = lane
    } catch (error) {
      // 关干净再把错抛出去:留着半开的 harness,repo 不让这个会话再开第二次,
      // 于是这个会话在这个进程里就永久打不开了。
      entry.lane = undefined
      entry.projection = undefined
      for (const unsubscribe of entry.unsubscribes ?? []) unsubscribe()
      entry.unsubscribes = undefined
      await env.cleanup(this.context).catch(() => {})
      if (harness) await harness.close(this.context).catch(() => {})
      else await session.close(this.context).catch(() => {})
      entry.harness = undefined
      entry.session = undefined
      entry.env = undefined
      entry.shellEnv = undefined
      entry.toolchain = undefined
      throw error
    }

    this.evictIdle()
    // 收件箱里可能躺着上个进程没来得及取走的东西(通知 steer 进来就崩了,§12 (j)):主会话一打开就叫醒一次。
    // 收件箱是空的时候这一下是 InvalidMessage(empty),没有副作用。子会话不叫:它们的续跑由 TaskManager 起,
    // 没有任务认领的一轮只会让结果无处可去。
    if (!entry.parentID) this.wake(entry)
    return entry
  }

  /**
   * 列表里的会话是懒的:标题是占位(repo.list 只读文件头,拿不到后来写进去的会话名),子会话的类型要读了会话值
   * 才知道。第一次把会话读出来(只读看历史,或者装配)时补上;有变化就推一条 session.updated —— 不推的话界面
   * 一直停在占位上(子会话页的标题就是任务描述,占位却是工程目录名)。
   */
  private async fillListed(entry: Entry, session: PiSession<JsonlSessionMetadata>): Promise<void> {
    const listed = toView(entry)
    // 读不出来就留着占位:这一步只关乎显示,不能挡住打开(openEntry 在这之后才进 try,抛出去会留下半开的会话)。
    try {
      entry.title = (await session.getName(this.context)) ?? entry.title
      if (entry.parentID && !entry.child) {
        const agent = (await session.getValue(SUBAGENT_META, this.context))?.value?.agent
        if (agent) entry.child = { agent }
      }
    } catch {
      return
    }
    const view = toView(entry)
    if (view.title !== listed.title || view.agent !== listed.agent) {
      this.options.emit([{ type: "session.updated", session: view }])
    }
  }

  // -------------------------------------------------------------------------
  // 子会话的装配(docs/子agent-设计方案-v0.4-20260918.md §4、§5.3、§6.6)
  // -------------------------------------------------------------------------

  /**
   * 这个子会话按哪个 profile 装配。本进程派出的子会话在 entry.child 上带着;进程重启过的从会话值 `yoma/subagent`
   * 读出 agent 类型,在父会话的快照(或重新加载的定义)里找。定义已经被删了就落回 general-purpose 并说一声 ——
   * 续跑一个找不到定义的子会话,好过让它永远打不开。
   */
  private async childProfile(entry: Entry, session: PiSession<JsonlSessionMetadata>): Promise<AgentProfile> {
    if (entry.child?.profile) return entry.child.profile
    const meta = (await session.getValue(SUBAGENT_META, this.context))?.value
    const agent = entry.child?.agent ?? meta?.agent ?? DEFAULT_AGENT_TYPE
    const parent = entry.parentID ? this.entries.get(entry.parentID) : undefined
    let profile = parent?.profiles?.find((item) => item.name === agent)
    if (!profile) {
      const loaded = await loadAgentProfiles({
        cwd: entry.cwd,
        configDir: this.configDir,
        homeDir: this.options.subagents?.homeDir,
      })
      profile = loaded.profiles.find((item) => item.name === agent)
    }
    if (!profile) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID: entry.id,
          message: `子 agent 的类型 ${agent} 已经没有定义了,改按 ${DEFAULT_AGENT_TYPE} 装配`,
        },
      ])
      profile = BUILTIN_AGENTS.find((item) => item.name === DEFAULT_AGENT_TYPE)!
    }
    entry.child = { ...entry.child, agent, profile }
    return profile
  }

  /**
   * 子 agent 的工具(§5.3):从这个会话自己装出的一整份里按 profile 重新筛 —— 硬黑名单(子 agent 四件)、硬件五件、
   * profile 的黑白名单,再加宿主的可用性裁剪(stm32config 看本机资源)。筛掉的**根本不注册**,不只是不激活;
   * 它们是新造的实例、没人用过,就地收掉。
   */
  private childTools(entry: Entry, profile: AgentProfile, all: RegisteredTool[]): RegisteredTool[] {
    const names = all.map((tool) => tool.name)
    const available = activeToolNames(all, entry.stm32Availability?.available ?? false)
    const kept = new Set(resolveAgentTools(available, profile).tools)
    const unknown = resolveAgentTools(names, profile).unknown
    if (unknown.length > 0) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID: entry.id,
          message: `agent ${profile.name} 的 tools 里点了这个宿主没有的工具:${unknown.join(", ")}`,
        },
      ])
    }
    for (const tool of all) if (!kept.has(tool.name)) void tool.dispose?.().catch(() => {})
    return all.filter((tool) => kept.has(tool.name))
  }

  /**
   * 子 agent 新 lane 的模型与思考种子(§4.5)。模型:`YOMA_SUBAGENT_MODEL` > agent 入参 > profile > 继承主会话当前的
   * 模型;点了名却不在注册表里(provider 没配 key)→ 回落继承并说一声,派生照常。思考:profile 写了就用,
   * 不写 = off(CC:普通子 agent 一律关思考以控制输出 token),再按模型实际支持的档位钳一下。
   */
  private childSeed(
    entry: Entry,
    profile: AgentProfile,
    models: Models,
    fallback: Model<string>,
  ): { model: Model<string>; thinkingLevel: ThinkingLevel } {
    const parent = entry.parentID ? this.entries.get(entry.parentID) : undefined
    const inherited = parent?.model ? (models.getModel(parent.model.providerID, parent.model.modelID) as Model<string> | undefined) : undefined
    const requested = [process.env.YOMA_SUBAGENT_MODEL, entry.child?.model, profile.model]
      .map((spec) => spec?.trim())
      .find((spec): spec is string => Boolean(spec) && spec !== "inherit")
    let model = inherited ?? fallback
    if (requested) {
      const slash = requested.indexOf("/")
      const found =
        slash > 0 ? (models.getModel(requested.slice(0, slash), requested.slice(slash + 1)) as Model<string> | undefined) : undefined
      if (found) model = found
      else {
        this.options.emit([
          {
            type: "kernel.error",
            sessionID: entry.id,
            message: `子 agent 要的模型 ${requested} 不可用(没配 key 或名字不对),改用主会话的模型`,
          },
        ])
      }
    }
    return { model, thinkingLevel: clampThinkingLevel(model, profile.thinkingLevel ?? "off") }
  }

  /**
   * maxTurns(§6.6,宿主 hook,不改内核):before_request 按 runId 数 assistant 轮(只数首次请求,重试不算);
   * 第 N 轮的工具跑完 after_tool 回 terminate —— v2 要求同一批**每个**调用都带 terminate 才停(P0 实测),
   * 所以对这一批每一个都回;兜底的 before_tool 拦截在 childBeforeTool 里。
   */
  private maxTurnsHooks(entry: Entry, harness: AgentHarness<ExecutionToolContext>, max: number): Array<() => void> {
    const counts = (entry.turnCounts = new Map())
    const hit = (entry.maxTurnsHit = new Set())
    return [
      harness.hooks.on("before_request", (event) => {
        if (event.step === "assistant" && event.attempt === 1) counts.set(event.runId, (counts.get(event.runId) ?? 0) + 1)
        return undefined
      }),
      harness.hooks.on("after_tool", (event) => {
        if ((counts.get(event.runId) ?? 0) < max) return undefined
        hit.add(event.runId)
        return { terminate: true }
      }),
    ]
  }

  /** 子会话的 before_tool:先是 maxTurns 的兜底(超额的调用拦下并收工),再是确认门(只在有人看屏幕的宿主)。 */
  private async childBeforeTool(
    entry: Entry,
    profile: AgentProfile,
    event: { toolCallId: string; toolName: string; args: Record<string, unknown>; runId: string },
    context: Context,
  ): Promise<{ block: { reason: string; terminate?: boolean } } | undefined> {
    if (profile.maxTurns && (entry.turnCounts?.get(event.runId) ?? 0) > profile.maxTurns) {
      entry.maxTurnsHit?.add(event.runId)
      return { block: { reason: "max turns reached", terminate: true } }
    }
    if (!this.options.confirmTools) return undefined
    return this.beforeTool(entry, event, context)
  }

  /**
   * 新投影器。`previous` 给的是"重建"而不是"新开":活下来的消息沿用它已经铸过的 id,
   * 否则 navigate 之后整条 transcript 在前端看来是全删了一遍(见 ProjectionOptions.reuseIDs)。
   */
  private newProjection(entry: Entry, previous?: SessionProjection): SessionProjection {
    return new SessionProjection({
      sessionID: entry.id,
      providerID: entry.model?.providerID,
      modelID: entry.model?.modelID,
      ...(previous ? { reuseIDs: previous.knownIDs() } : {}),
    })
  }

  /**
   * 把一条 lane 的整条历史投影进一个投影器(不发事件 —— 前端用 session.messages 取快照)。
   *
   * 收的是 lane 与 projection 而不是 entry:openEntry 要在**挂上去之前**把历史放完,
   * 那时候 entry 上还什么都没有。
   */
  private async replay(lane: Pick<Branch, "findEntries">, projection: SessionProjection): Promise<void> {
    for (const item of await lane.findEntries({ order: "oldestFirst" }, this.context)) {
      if (item.type === "message") projection.applyMessage(item.message, { entryId: item.id })
      else if (item.type === "compaction" || item.type === "branch_summary") projection.applySummary(item)
      // 自定义 entry(现在只有 yoma/compaction)必须和 live 走同一条路,否则手动压缩
      // 重放出来就变成自动压缩。
      else if (item.type === "custom") projection.applyCustomEntry(item)
    }
  }

  /**
   * 机器级目录:Yoma 装进 `<configDir>/toolchains/` 的 + 用户在设置页手指的(账本
   * by:"user"),见 domain/toolchain/install.ts 的 machinePathDirs。每次都重新扫 —— 这是
   * 会话开启 / 安装完成时才调的东西,不在热路径上。
   */
  private async machineDirs(): Promise<string[]> {
    const ledger = await readLedger(this.configDir)
    return machinePathDirs({ configDir: this.configDir, ledger })
  }

  /**
   * 一个会话所有执行器的环境:engines/bin ⊕ 项目清单目录 ⊕ 机器级目录 ⊕ process.env。
   * 宿主环境不修改:另一个项目和已经启动的进程不会随本会话的配置变化。
   */
  private baseShellEnv(machineDirs: string[]): NodeJS.ProcessEnv {
    return withEnginesOnPath(withMachineOnPath({ ...process.env }, machineDirs), this.options.enginesDir)
  }

  private sessionShellEnv(toolchain: ToolchainResolution, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return withEnginesOnPath(shellEnvFor(toolchain, baseEnv), this.options.enginesDir)
  }

  /** 会话当前的执行环境。shellEnv 换过之后(refreshMachineEnv)这里会重建一个。 */
  private toolEnv(entry: Entry): NodeExecutionEnv {
    if (!entry.env) {
      const shellEnv = { ...(entry.shellEnv ?? process.env) }
      entry.env = bindExecutionEnv(new NodeExecutionEnv({ cwd: entry.cwd, shellEnv }), shellEnv)
    }
    return entry.env
  }

  private inspectStm32(entry: Entry, signal?: AbortSignal): Promise<Stm32Availability> {
    return (this.options.inspectStm32Availability ?? inspectStm32Availability)({
      enginesDir: this.options.enginesDir,
      configDir: this.configDir,
      projectDir: entry.cwd,
      env: entry.shellEnv,
      signal,
    })
  }

  private async refreshAvailability(entry: Entry, signal: AbortSignal): Promise<void> {
    // 子会话的工具集是派生时按 profile 定的(而且它不接用户的 prompt,走不到这里)。
    if (entry.parentID) return
    const availability = await this.inspectStm32(entry, signal)
    signal.throwIfAborted()
    const names = activeToolNames(entry.tools!, availability.available, true)
    await entry.lane!.setActiveTools(names, this.context)
    entry.stm32Availability = availability
    entry.activeToolNames = names
  }

  /**
   * 工具链装好之后调:重算每个**活着的**会话的 bash 环境,让下一条命令就看得见新目录,
   * 不用重开会话。清单解析也重跑一遍 —— 刚装的可能正是
   * 清单里 MISSING 的那个。被 LRU 淘汰的会话 dispose 时清掉了 env,这里不会为它们
   * 白起 --version 子进程。
   */
  async refreshMachineEnv(): Promise<void> {
    const generation = ++this.envRefreshGeneration
    const baseEnv = this.baseShellEnv(await this.machineDirs())
    for (const entry of this.entries.values()) {
      if (!isOpen(entry)) continue
      const toolchain = await this.resolveToolchainSafe(entry, baseEnv)
      if (generation !== this.envRefreshGeneration) return
      if (!isOpen(entry)) continue
      // Publish the resolution and its environment together; a slower old refresh cannot
      // overwrite a newer settings change after its probe finally exits.
      entry.toolchain = toolchain
      entry.shellEnv = this.sessionShellEnv(toolchain, baseEnv)
      // 下一轮的 toolContext 会按新 shellEnv 造一个。在飞的那个还拿着旧环境 ——
      // 它可能正有子进程在跑,不能就地替;但也不能直接丢引用,否则那些子进程会活过
      // 整个会话(**硬件安全**:可能是一条烧录命令)。退役存起来,这一轮结束或
      // dispose 时 cleanup。
      if (entry.env) (entry.retiredEnvs ??= []).push(entry.env)
      entry.env = undefined
    }
  }

  /**
   * 工具链清单解析失败(清单文件在,但内容坏了——`schema` 不对/JSON 损坏/写了绝对
   * 路径等,见 domain/toolchain 的 parseManifest)绝不能让会话开不起来:会话开不起来
   * 比工具链没配好严重得多。resolveToolchain() 本身对"项目根本没有清单文件"已经是
   * 静默返回一个空结果;这里只是把"清单存在但解析炸了"这一种情况也吞掉异常、发一条
   * kernel.error 诊断,折叠回同一种空结果 —— 调用方(shellEnvFor / promptSectionFor)
   * 因此不用关心"没有清单"和"清单解析失败"是两回事。
   */
  private async resolveToolchainSafe(entry: Entry, env: NodeJS.ProcessEnv): Promise<ToolchainResolution> {
    const side = this.options.toolchainSide ?? "mother"
    try {
      return await resolveToolchain({
        projectDir: entry.cwd,
        configDir: this.configDir,
        side,
        manifestText: this.options.toolchainManifestText,
        env,
      })
    } catch (error) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID: entry.id,
          message: `工具链清单解析失败:${(error as Error)?.message ?? String(error)}`,
        },
      ])
      return { manifestPath: undefined, manifest: undefined, side, tools: [], ok: true, needsAttention: [] }
    }
  }

  // -------------------------------------------------------------------------
  // 内核事件 → 前端事件
  // -------------------------------------------------------------------------

  /**
   * 订阅。内核的事件总线是 **按类型** 订阅的(没有通配),所以这里逐条列出来 ——
   * 漏一条的表现不是报错,是 UI 上少一块东西。
   *
   * 状态机只用三个事实:run_start/run_end 划出 busy,compaction_start/end 划出
   * compacting。轮内压缩(阈值/溢出)是 run 的一段,压完要回到 busy 而不是 idle ——
   * 中间漏一个 idle,bench 就会当真去跑判据,而 agent 正要接着说话。
   */
  private subscribe(entry: Entry, harness: AgentHarness<ExecutionToolContext>): Array<() => void> {
    const emit = (events: KernelEvent[]) => {
      if (events.length) this.options.emit(events)
    }
    const apply = (project: (projection: SessionProjection) => KernelEvent[]) => {
      const projection = entry.projection
      if (projection) emit(project(projection))
    }
    // 工具进度:每块输出投影一整张卡片,所以按调用节流(前沿立即、之后每 100ms 一次、尾沿补发)。
    const progress = new ToolProgressThrottle((toolCallId, partial) =>
      apply((projection) => projection.updateToolProgress(toolCallId, partial)),
    )
    return [
      () => progress.dispose(),
      harness.events.on("run_start", (event) => {
        entry.running = true
        entry.operationId = event.runId
        emit(this.setStatus(entry, { type: "busy" }))
        if (entry.parentID) this.taskManager.onRunStart(entry.id)
      }),
      harness.events.on("run_end", (event) => {
        this.desk.cancel(entry.id)
        entry.running = false
        entry.operationId = undefined
        entry.updatedAt = Date.now()
        emit([...this.setStatus(entry, { type: "idle" }), { type: "session.updated", session: toView(entry) }])
        // 这一轮结束了,refreshMachineEnv 退役掉的旧环境现在可以安全收子进程了。
        void this.cleanupRetiredEnvs(entry)
        if (entry.parentID) {
          const maxTurnsReached = entry.maxTurnsHit?.has(event.runId) === true
          entry.turnCounts?.delete(event.runId)
          entry.maxTurnsHit?.delete(event.runId)
          this.taskManager.onRunEnd(entry.id, {
            status: event.status,
            ...(event.status === "failed" ? { error: event.error.message } : {}),
            fromTipId: event.fromTipId,
            maxTurnsReached,
          })
        }
        // 收件箱里还有东西(steer 落在这一轮的结束提交之后,§6.4 第 5 步):起下一轮把它取走。
        if (entry.queued?.length) this.wake(entry)
      }),
      harness.events.on("turn_start", () => {
        if (entry.parentID) this.taskManager.onTurn(entry.id)
      }),
      harness.events.on("queue_update", (event) => {
        entry.queued = event.queues
        emit([{ type: "session.queue", sessionID: entry.id, items: queueView(event.queues) }])
        // 空闲时收件箱变成非空:排队消息的 steer 恰好落在一轮收尾之后(§6.9 竞态)。叫醒一次,多叫无害。
        if (event.queues.length > 0 && !this.isRunning(entry)) this.wake(entry)
      }),
      harness.events.on("retry_scheduled", (event) => {
        // Summary retries have their own compacting state; this is model generation only.
        if (entry.status.type !== "busy") return
        emit(
          this.setStatus(entry, {
            type: "busy",
            retry: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              notBefore: event.notBefore,
              error: event.errorMessage,
              providerID: entry.model?.providerID ?? "unknown",
            },
          }),
        )
      }),
      harness.events.on("retry_end", () => {
        if (entry.status.type === "busy" && entry.status.retry) emit(this.setStatus(entry, { type: "busy" }))
      }),
      harness.events.on("message_start", (event) => {
        const message = event.message
        if (message.role !== "assistant") return
        apply((projection) => projection.startAssistant(message))
      }),
      harness.events.on("message_update", (event) => {
        const message = event.message
        if (message.role !== "assistant") return
        apply((projection) => projection.applyStreamEvent(event.event, message))
      }),
      // 消息在 message_end 才投影:那一刻 entryId 已经有了(navigate 要靠它),
      // 而用户/工具结果消息的 start 与 end 是同一批发出来的,不会晚。
      harness.events.on("message_end", (event) => {
        const message = event.message
        // renderer 乐观插入过一条,id 要复用。pendingUser 由 prompt() 放进来,按原文认领 ——
        // 收件箱里排着的消息会在它前面落盘,不能让排队的那条抢走这个 id。
        const pending = entry.pendingUser
        const given =
          message.role === "user" && pending && textOf(message.content) === pending.text ? pending.id : undefined
        if (given) entry.pendingUser = undefined
        if (entry.parentID && message.role === "assistant") this.taskManager.onAssistant(entry.id, message)
        apply((projection) =>
          projection.applyMessage(message, {
            ...(event.entryId ? { entryId: event.entryId } : {}),
            ...(given ? { messageID: given } : {}),
          }),
        )
      }),
      harness.events.on("tool_start", (event) => {
        if (entry.parentID) this.taskManager.onTool(entry.id, event.toolName, event.args)
        apply((projection) => projection.markToolRunning(event.toolCallId))
      }),
      harness.events.on("tool_update", (event) => {
        // 空快照(内核 bash 开跑先发一条 {content:[]})不进节流器:它会白白花掉前沿,真正的第一块输出
        // 就得等尾沿,每条 bash 的第一个字都晚一个间隔。
        const partial = event.partialResult
        if (partial.content.length === 0 && (partial.details === undefined || partial.details === null)) return
        progress.push(event.toolCallId, partial)
      }),
      // 终态由 message_end 的工具结果消息投影;这里只把还没发的尾沿丢掉。
      harness.events.on("tool_end", (event) => progress.settle(event.toolCallId)),
      harness.events.on("entry_added", (event) => {
        entry.updatedAt = Date.now()
        const added = event.entry
        // 压缩/分支摘要没有对应的消息事件,只能从 entry 投影。
        if (added.type === "compaction" || added.type === "branch_summary") {
          apply((projection) => projection.applySummary(added))
        } else if (added.type === "custom") {
          // yoma/compaction:把对应那条压缩分隔线翻成手动。live 与重放同一个函数,
          // 所以同一段历史两条路得到的 auto 一定相同。
          apply((projection) => projection.applyCustomEntry(added))
        }
      }),
      harness.events.on("compaction_start", () => {
        emit(this.setStatus(entry, { type: "compacting" }))
      }),
      harness.events.on("compaction_end", () => {
        emit(this.setStatus(entry, entry.running ? { type: "busy" } : { type: "idle" }))
        // 手动压缩期间排进来的:压缩不是一轮,不会有 run_end 替它们叫醒。
        if (!entry.running && entry.queued?.length) this.wake(entry)
      }),
      harness.events.on("config_update", (event) => {
        if (event.property === "model") {
          entry.model = { ...entry.model, providerID: event.value.provider, modelID: event.value.modelId }
          entry.projection?.setModel(event.value.provider, event.value.modelId)
        } else if (event.property === "thinkingLevel" && entry.model) {
          entry.model = { ...entry.model, thinking: event.value }
        }
      }),
      harness.events.on("fault", (event) => {
        this.fail(entry, `内核故障 ${event.code}:${event.message}`)
        // fault 把每条 lane 都封死、总线也关了(runtime/harness.ts 的 fault())。留着这个
        // entry 的话之后每一次 prompt 都会失败到重启为止 —— 销毁掉,下一次调用自己重开。
        void this.dispose(entry).catch(() => {})
      }),
      // handler_error 说的是"某个监听器抛了",**它对这一轮什么都没说**。这里曾经调
      // fail():于是 renderer 抛一次异常就把会话状态硬改成 idle,而 drive 还在跑,
      // 下一条 prompt 撞 LaneBusy。只报错误,不碰状态。
      harness.events.on("handler_error", (event) =>
        this.options.emit([
          {
            type: "kernel.error",
            sessionID: entry.id,
            message: `内核事件处理失败(${event.kind}):${event.error}`,
          },
        ]),
      ),
    ]
  }

  // -------------------------------------------------------------------------
  // 工具确认
  // -------------------------------------------------------------------------

  /**
   * before_tool 钩子:契约说要问的工具跑之前挂起等人。不用问的工具一步都不绕。
   *
   * **绝不 throw**。钩子抛出去的异常会被内核先转成一条错误上报、再当作拒绝
   * (harness/hooks.ts 的 beforeTool catch 分支),于是用户点一下"拒绝"屏幕上多一条"内核出错";
   * 超时与会话关闭同理。所以四种拒绝全都走 `return { block }`。
   *
   * 挂起期间唯一的取消通道是内核交给钩子的 `context.abortSignal`(lane 的 abort 会点它),
   * 原样传给确认台 —— 少传的后果是"点停止没反应"。
   */
  private async beforeTool(
    entry: Entry,
    event: { toolCallId: string; toolName: string; args: Record<string, unknown> },
    context: Context,
  ): Promise<{ block: { reason: string } } | undefined> {
    const contract = confirmNeeded(event.toolName, event.args)
    if (!contract) return undefined
    const summary = contract.summary(event.args)
    // 这段话原样进模型的工具结果,几种结局要说清是哪一种:拒绝必须带上"别在问过用户之前重试",
    // 否则模型会立刻同样再调一次,用户得连点好几次;超时若也说成"用户拒绝",模型会换招绕开,
    // 而用户只是没看屏幕。
    // 每一段都要堵死绕行:只禁 flash 的话,模型会改用 bash 起同一条 openocd —— bash 不过这道门。
    // 措辞必须**对所有会问的工具都成立**:被拒的可能是烧录(改用 bash 起 openocd),也可能是
    // toolchain install(改用 bash curl | tar 把同一个包拉下来)。写死"探针命令"就只堵住了前一种。
    const what = `${event.toolName}: ${summary}`
    const noBypass =
      "Do not work around this with bash or any other tool — that includes running an equivalent command yourself."
    // 子 agent(§6.5):后台的问不了用户(CC 的 shouldAvoidPermissionPrompts),直接拒,让它报回去由主 agent 去问;
    // 前台的照常问,但询问**显示在主会话**(用户看着的是那里),带上是哪个子 agent 在问。
    const task = entry.parentID ? this.taskManager.task(entry.id) : undefined
    const backgroundReason = `Background sub-agents cannot ask the user for confirmation, so ${what} did not run. Report back that it needs to run and let the main agent ask. ${noBypass}`
    if (task?.background) return { block: { reason: backgroundReason } }
    const agent = task?.agent ?? entry.child?.agent
    const settled = await this.desk.ask(
      {
        id: Identifier.ascending("confirm"),
        sessionID: entry.parentID ?? entry.id,
        toolCallId: event.toolCallId,
        tool: event.toolName,
        label: contract.label,
        summary,
        input: event.args,
        askedAt: Date.now(),
        ...(entry.parentID ? { ...(agent ? { agent } : {}), taskID: entry.id } : {}),
      },
      context.abortSignal,
      entry.id,
    )
    if (settled === "allowed") return undefined
    // 挂着的时候被转了后台:询问已撤,理由照后台说。
    if (settled === "cancelled" && entry.parentID && this.taskManager.task(entry.id)?.background) {
      return { block: { reason: `${what} was not approved before the sub-agent moved to the background; ${backgroundReason}` } }
    }
    const reason =
      settled === "denied"
        ? `The user declined to run ${what}. Do not retry without asking the user first. ${noBypass}`
        : settled === "expired"
          ? `The confirmation request for ${what} timed out after 10 minutes; nobody approved it. Ask the user before retrying. ${noBypass}`
          : `The session was stopped before ${what} was approved; it did not run. ${noBypass}`
    return { block: { reason } }
  }

  /** 未决的确认。`tool.confirm` 事件不重放,首屏与 resync 都靠这个问现状。 */
  pendingConfirms(sessionID?: string): ToolConfirmView[] {
    return this.desk.pending(sessionID)
  }

  /** 前端的回答。false = 这条询问已经不在了(超时 / 会话关了),不是错误。 */
  replyConfirm(id: string, allow: boolean): boolean {
    return this.desk.reply(id, allow)
  }

  private setStatus(entry: Entry, status: SessionStatus): KernelEvent[] {
    if (
      entry.status.type === status.type &&
      (entry.status.type !== "busy" || status.type !== "busy" || entry.status.retry === status.retry)
    )
      return []
    entry.status = status
    return [{ type: "session.status", sessionID: entry.id, status }]
  }

  /**
   * 这一轮彻底失败了:报出去并把状态归位。
   *
   * 三个来源 —— drive 自己炸了、drive 带着 waiting 回来(没人再驱动它)、harness 报 fault。
   * **不包括 handler_error**:那条只说某个监听器抛了,对这一轮什么都没说。
   */
  private fail(entry: Entry, message: string): void {
    // 状态回 idle 与确认台清空必须是同一个事实:界面显示空闲却顶着一条确认,用户点"允许"会让
    // 一条已宣告失败的轮次真的去烧板。
    this.desk.cancel(entry.id)
    entry.running = false
    entry.operationId = undefined
    this.options.emit([
      { type: "kernel.error", sessionID: entry.id, message },
      ...this.setStatus(entry, { type: "idle" }),
    ])
    // 子会话的这一轮没有 run_end 可等了:任务按失败落定(已经落定过的,TaskManager 自己认得)。
    if (entry.parentID) this.taskManager.onRunEnd(entry.id, { status: "failed", error: message })
  }

  // -------------------------------------------------------------------------
  // 一轮对话
  // -------------------------------------------------------------------------

  /**
   * 用户发一句话。空闲时起一轮;**正忙时排队**(docs/子agent-设计方案-v0.4-20260918.md §6.9,照 CC):steer 进收件箱,
   * 在下一个工具轮次结束、下一次请求之前插进去,返回 `queued: true`。想打断当前轮要按停止(abort)。
   * 子 agent 的会话不接用户的话(CC:子 agent 永远看不到用户的输入流),续跑走主 agent 的 send_message。
   */
  async prompt(sessionID: string, input: PromptInput): Promise<{ messageID: string; queued?: boolean }> {
    // 先只打开历史,把耗时的初始资源探测也纳入可取消的准备期。
    const entry = await this.ensureOpen(sessionID, true)
    if (entry.parentID) throw subagentSession(sessionID)
    return this.admit(entry, () => this.admitPrompt(entry, sessionID, input))
  }

  private async admitPrompt(
    entry: Entry,
    sessionID: string,
    input: PromptInput,
  ): Promise<{ messageID: string; queued?: boolean }> {
    // 手动压缩这类结构性操作还在飞(它不是一轮对话,不会在工具边界取收件箱):照旧先停再发。
    if (!this.isRunning(entry) && entry.status.type !== "idle") await this.stop(entry)

    const messageID = input.messageID ?? Identifier.ascending("message")

    // 贴进来的图同样要过压缩:截图与手机照片动辄十几 MB,原样发出去整轮会被供应商拒掉。
    // file:// 的提及件在这里跳过 —— 它的路径已经在正文里,agent 自己会用 read 去读(那条路也过同一道压缩)。
    const images: ImageContent[] = []
    const notes: string[] = []
    const omitted: string[] = []
    // 这一段要花秒级时间,而 lane 还没有操作可中断:给它一个可取消的标记(见 Entry.preparing 与 stop)。
    const preparing = { cancelled: false, controller: new AbortController() }
    entry.preparing = preparing
    try {
      const alreadyOpen = isOpen(entry)
      await this.ensureOpen(sessionID)
      // 正在跑的那一轮用的是它开跑时的工具集;排队的消息不去动它。
      if (!preparing.cancelled && alreadyOpen && !this.isRunning(entry)) {
        await this.refreshAvailability(entry, preparing.controller.signal)
      }
      for (const file of input.files ?? []) {
        if (preparing.cancelled) break
        if (!file.mime.startsWith("image/")) continue
        const base64 = /^data:[^;]+;base64,(.*)$/s.exec(file.url)?.[1]
        if (base64 === undefined) continue
        const processed = await processImage(Buffer.from(base64, "base64"), file.mime)
        if (preparing.cancelled) break
        if (!processed.ok) {
          notes.push(processed.message)
          omitted.push(`${file.filename ?? file.mime}:${processed.message}`)
          continue
        }
        // 说明**跟着消息进模型**,不只弹个界面提示:缩过的图坐标全变了,而模型看不到原图。
        // 少了这句,"复位键在哪个像素"这类问题会得到一个按缩略图算出来、乘回去才对的答案。
        notes.push(...processed.hints)
        images.push({ type: "image", data: processed.data, mimeType: processed.mimeType })
      }
    } catch (error) {
      if (!preparing.cancelled) throw error
    } finally {
      if (entry.preparing === preparing) entry.preparing = undefined
    }
    // 准备期里用户按了停止:这一轮就此作罢,别让它在"已经点过停止"之后才开跑。
    if (preparing.cancelled) return { messageID }
    if (omitted.length > 0) {
      this.options.emit([{ type: "kernel.error", sessionID, message: `图片没能送达模型 —— ${omitted.join(";")}` }])
    }
    const text = notes.length > 0 ? `${input.text}\n\n${notes.join("\n")}` : input.text

    // 一轮只收 images,别的附件送不进模型。曾经的事故形态:UI 把 PDF 显示成附件、
    // 这里静默丢掉,两边都不吭声,用户以为模型看过了。UI 侧已按能力分流(有本机路径的
    // PDF/文本转 @ 提及,无路径的 PDF 拒收),这里是防回归的哨兵 —— 只盯 data: URL 的
    // 内容型附件;file:// 的提及件路径已在正文里、agent 自己会去读,丢掉 part 是预期行为。
    const dropped = (input.files ?? []).filter(
      (file) => !file.mime.startsWith("image/") && file.url.startsWith("data:"),
    )
    if (dropped.length > 0) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID,
          message: `附件 ${dropped.map((f) => f.filename ?? f.mime).join("、")} 不是图片,当前无法送达模型,已忽略`,
        },
      ])
    }

    // 忙着(准备期结束时再判断一次 —— 那几秒里这一轮可能已经收工):排进收件箱,不打断。
    // 不做乐观插入:它被取走时才随 message_end 落在 transcript 里的真实位置(当前工具轮次的结果之后)。
    if (this.isRunning(entry)) {
      const queued = await entry.lane!.steer(text, images.length ? images : undefined, this.context)
      if (!queued.ok) throw laneError(queued.error)
      // steer 恰好落在这一轮的结束提交之后:收件箱里躺着一条而没人驱动。queue_update 那条会叫醒,这里再兜一次。
      if (!this.isRunning(entry)) this.wake(entry)
      return { messageID, queued: true }
    }

    const request: OperationRequest = images.length
      ? { kind: "prompt", prompt: text, images }
      : { kind: "prompt", prompt: text }
    entry.pendingUser = { id: messageID, text }
    const accepted = await this.runOperation(entry, request)
    // accept 的事件(含这条用户消息的 message_end)在它 resolve 之前就送达了;没认领上的也别留到下一轮。
    entry.pendingUser = undefined
    if (!accepted.ok) throw laneError(accepted.error)
    return { messageID }
  }

  /** 这个会话有一轮在飞(accept 过、run_end 还没来)。手动压缩不算:它不是一轮,不在工具边界取收件箱。 */
  private isRunning(entry: Entry): boolean {
    return entry.running === true || entry.operationId !== undefined
  }

  /**
   * 起一轮:accept 只落盘,drive 才执行。prompt()、wake()、子 agent 的每一轮(首轮、续跑)共用这一条。
   *
   * 不 await drive:一轮可能跑几分钟,调用方必须立刻返回,结果全部走事件流。
   * waitForRetry 把内核的退避留在这一次 drive 里,于是整段重试是一个连续的 busy ——
   * 退避窗口里漏出 idle,bench 会当真去回填结果,而 agent 正要重试。
   * pollDeferred 同理管 provider 侧的异步生成:漏了它 drive 会带着
   * kind:"waiting" 提前回来,而 run_end 永远不来,状态就永久钉在 busy。
   */
  private async runOperation(entry: Entry, request: OperationRequest): Promise<OperationAdmissionResult> {
    const lane = entry.lane!
    const accepted = await lane.accept(request, this.context)
    if (!accepted.ok) return accepted
    const operationId = accepted.value.operationId
    entry.operationId = operationId
    void lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, this.context).then(
      (driven) => {
        if (!driven.ok) this.fail(entry, laneErrorMessage(driven.error))
        // 两个开关都开了还 waiting,说明这一轮没人会再驱动它 —— 当失败处理,
        // 否则状态停在 busy,用户只能重启。
        else if (driven.value.kind === "waiting") this.fail(entry, WAITING_TEXT[driven.value.reason])
      },
      (error: unknown) => this.fail(entry, laneErrorMessage(error as Error)),
    )
    return accepted
  }

  /**
   * "决定起一轮还是排队"按会话串行(Entry.admission)。只串到 accept 为止,不等这一轮跑完。
   */
  private admit<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const run = (entry.admission ?? Promise.resolve()).then(task)
    entry.admission = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 会话空闲而收件箱非空时起一轮,把排着的东西取走(子 agent 的通知、收尾之后才到的排队消息)——
   * 与用户发消息同一条路,只是少一条用户消息(accept 空 prompt)。回 LaneBusy = 已经有一轮在跑,它会在
   * 边界上取走;回 InvalidMessage(empty) = 早被取走了。两者都不是错误,多叫一次无害(§6.4)。
   */
  private wake(entry: Entry): void {
    void this.admit(entry, async () => {
      if (!isOpen(entry) || this.isRunning(entry) || entry.status.type === "compacting") return
      const woken = await this.runOperation(entry, { kind: "prompt", prompt: [] })
      if (!woken.ok && woken.error._tag !== "LaneBusy" && woken.error._tag !== "InvalidMessage") {
        throw laneError(woken.error)
      }
    }).catch((error: unknown) => {
      this.options.emit([
        { type: "kernel.error", sessionID: entry.id, message: `唤醒会话失败:${(error as Error)?.message ?? String(error)}` },
      ])
    })
  }

  /**
   * 撤回一条还没被取走的排队消息(§6.9):原文与图片交回,让用户改了再发。`already_consumed` = 它刚被这一轮取走。
   */
  async cancelQueued(
    sessionID: string,
    entryId: string,
  ): Promise<{ kind: "cancelled" | "already_consumed" | "not_found"; text?: string; files?: Array<{ mime: string; url: string }> }> {
    const entry = this.entries.get(sessionID)
    if (!entry || !isOpen(entry)) return { kind: "not_found" }
    const item = entry.queued?.find((queued) => queued.entryId === entryId)
    const result = await entry.lane!.cancelQueued(entryId, this.context)
    if (!result.ok) throw laneError(result.error)
    if (result.value.kind !== "cancelled") return { kind: result.value.kind }
    const message = item?.type === "message" && item.message.role === "user" ? item.message : undefined
    if (!message) return { kind: "cancelled" }
    const files =
      typeof message.content === "string"
        ? []
        : message.content.flatMap((block) =>
            block.type === "image" ? [{ mime: block.mimeType, url: `data:${block.mimeType};base64,${block.data}` }] : [],
          )
    return { kind: "cancelled", text: textOf(message.content), ...(files.length ? { files } : {}) }
  }

  // -------------------------------------------------------------------------
  // 子 agent(docs/子agent-设计方案-v0.4-20260918.md §6)
  // -------------------------------------------------------------------------

  /** 这个主会话派出的任务(任务面板;task.list RPC)。 */
  /** 这个会话派出去的任务;它自己是子会话时再带上它自己那条(子会话页的横幅要状态,事件不重放)。 */
  tasks(sessionID: string): TaskView[] {
    const own = this.taskManager.get(sessionID)
    const spawned = this.taskManager.list(sessionID)
    return own ? [own, ...spawned] : spawned
  }

  /**
   * 这个目录下能派的 agent(agent.list RPC)。现读现算,与会话打开时的快照同一个加载器 —— 开着的会话里 agent 工具
   * 的描述仍是它打开那一刻的快照(改了 md 重开会话生效),界面列的是磁盘现状。
   */
  async agents(directory: string): Promise<AgentInfo[]> {
    const loaded = await loadAgentProfiles({
      cwd: directory,
      configDir: this.configDir,
      homeDir: this.options.subagents?.homeDir,
    })
    return loaded.profiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      source: profile.source,
      tools: describeAgentTools(profile),
      ...(profile.model && profile.model !== "inherit" ? { model: profile.model } : {}),
      ...(profile.background ? { background: true } : {}),
    }))
  }

  /** 界面上的停止键(task.stop RPC)。后台任务照常带着部分结果发 killed 通知(CC 同款)。 */
  stopTask(taskID: string): Promise<StopOutcome> {
    return this.taskManager.stop(taskID)
  }

  /** 卡片上的"转后台"(task.background RPC)。false = 已经在后台 / 已经结束 / 这个宿主不能后台。 */
  backgroundTask(taskID: string): boolean {
    return this.taskManager.moveToBackground(taskID)
  }

  /** TaskManager 用我们的全部接口。它不碰 harness,不跨 await 留 lane 引用 —— 每次现取。 */
  private taskPort(): TaskPort {
    return {
      createChild: (parentID, spec) => this.createChild(parentID, spec),
      run: (childID, input) => this.runChild(childID, input),
      steer: async (childID, text) => {
        const entry = await this.ensureOpen(childID)
        const queued = await entry.lane!.steer(text, undefined, this.context)
        if (!queued.ok) throw laneError(queued.error)
      },
      abort: (childID) => this.requestStop(childID),
      lastText: (childID, fromTipId) => this.lastAssistantText(childID, fromTipId),
      deliver: (parentID, message) => this.deliver(parentID, message),
      pin: (childID, pinned) => {
        const entry = this.entries.get(childID)
        if (entry) entry.pinned = pinned
      },
      cancelConfirms: (childID) => this.desk.cancel(childID),
      recordMeta: (childID, patch) => this.recordMeta(childID, patch),
      childMeta: (parentID, childID) => this.childMeta(parentID, childID),
      emit: (events) => this.options.emit(events),
    }
  }

  /**
   * 建子会话(§6.2 第 3、4 步):文件头带 parentSessionId、会话名 = description、写 yoma/subagent 值、发 session.created,
   * 再打开并**钉住** —— 钉住要早于打开:openEntry 的末尾就会跑一次 LRU,十几个同时派出的兄弟会话正是在那一刻互相淘汰。
   */
  private async createChild(parentID: string, spec: ChildSpec): Promise<string> {
    const parent = this.entries.get(parentID)
    if (!parent) throw sessionNotFound(parentID)
    const session = await this.repoLocked(() =>
      this.repo.create({ cwd: parent.cwd, parentSessionId: parentID }, this.context),
    )
    const meta = session.metadata
    const entry: Entry = {
      id: meta.id,
      cwd: meta.cwd,
      title: spec.description,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      meta,
      session,
      status: { type: "idle" },
      touched: Date.now(),
      parentID,
      child: {
        agent: spec.agent,
        ...(parent.profiles?.find((profile) => profile.name === spec.agent)
          ? { profile: parent.profiles.find((profile) => profile.name === spec.agent)! }
          : {}),
        ...(spec.model ? { model: spec.model } : {}),
      },
      pinned: true,
    }
    this.entries.set(entry.id, entry)
    await session.setName(spec.description, this.context)
    await session.setValue(
      SUBAGENT_META,
      {
        agent: spec.agent,
        parentSessionId: parentID,
        toolCallId: spec.toolCallId,
        description: spec.description,
        background: spec.background,
        createdAt: Date.now(),
        notified: false,
      },
      this.context,
    )
    this.options.emit([{ type: "session.created", session: toView(entry) }])
    try {
      await this.ensureOpen(entry.id)
    } catch (error) {
      entry.pinned = false
      throw error
    }
    return entry.id
  }

  /**
   * 在子会话上起一轮(首轮或续跑)。首轮照 CC:每个预加载的技能一条 user 消息在前,然后是任务书
   * (profile.initialPrompt 拼在前面);排队时攒下的 send_message 接在最后。
   */
  private async runChild(childID: string, input: { prompt: string; first: boolean; extra: string[] }): Promise<void> {
    const entry = await this.ensureOpen(childID)
    await this.admit(entry, async () => {
      const messages = input.first ? this.firstMessages(entry, input.prompt) : [userMessage(input.prompt)]
      messages.push(...input.extra.map(userMessage))
      const started = await this.runOperation(entry, { kind: "prompt", prompt: messages })
      if (started.ok) return
      // 已经有一轮在跑(收件箱唤醒抢先起了一轮):那就排进它的收件箱,效果相同。
      if (started.error._tag === "LaneBusy") {
        for (const message of messages) {
          const queued = await entry.lane!.steer(message, undefined, this.context)
          if (!queued.ok) throw laneError(queued.error)
        }
        return
      }
      throw laneError(started.error)
    })
  }

  private firstMessages(entry: Entry, prompt: string): AgentMessage[] {
    const profile = entry.child?.profile
    const messages: AgentMessage[] = []
    for (const name of profile?.skills ?? []) {
      const skill = entry.skills?.find((item) => item.name === name)
      if (skill) messages.push(userMessage(formatSkillInvocation(skill)))
      else {
        this.options.emit([
          { type: "kernel.error", sessionID: entry.id, message: `agent ${profile?.name} 要预加载的技能 ${name} 没找到,跳过` },
        ])
      }
    }
    messages.push(userMessage(profile?.initialPrompt ? `${profile.initialPrompt}\n\n${prompt}` : prompt))
    return messages
  }

  /** 请求停掉子会话在飞的那一轮,不等它落定(落定走 run_end → TaskManager)。 */
  private async requestStop(childID: string): Promise<void> {
    const entry = this.entries.get(childID)
    if (!entry) return
    if (entry.preparing) {
      entry.preparing.cancelled = true
      entry.preparing.controller.abort()
    }
    this.desk.cancel(entry.id)
    const lane = entry.lane
    const operationId = entry.operationId
    if (!lane || !operationId) return
    const requested = await lane.requestAbort(operationId, this.context)
    if (!requested.ok && requested.error._tag !== "OperationMismatch") throw laneError(requested.error)
  }

  /** 这一轮(fromTipId 之后)最后一段 assistant 文字;没给 fromTipId 就看整条历史。完成与被停(部分结果)同一个算法。 */
  private async lastAssistantText(childID: string, fromTipId: string | null | undefined): Promise<string | undefined> {
    const entry = await this.ensureOpen(childID, true)
    const branch: Pick<Branch, "findEntries"> | undefined = entry.lane ?? (await entry.session?.branch("main", this.context))
    if (!branch) return undefined
    const newest = await branch.findEntries(
      { order: "newestFirst", ...(fromTipId ? { stopAtId: fromTipId } : {}) },
      this.context,
    )
    for (const item of newest) {
      if (fromTipId && item.id === fromTipId) break
      if (item.type !== "message" || item.message.role !== "assistant") continue
      // 同 domain/agents/finalize.ts:多个 text 块按行拼;纯工具调用的那条跳过,往前找。
      const body = item.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim()
      if (body) return body
    }
    return undefined
  }

  /** 通知投递(§6.4 第 2–4 步):父被 LRU 关了就重开,steer 进收件箱(持久化),父空闲就叫醒。 */
  private async deliver(parentID: string, message: AgentMessage): Promise<void> {
    const entry = await this.ensureOpen(parentID)
    const queued = await entry.lane!.steer(message, undefined, this.context)
    if (!queued.ok) throw laneError(queued.error)
    this.wake(entry)
  }

  private async recordMeta(childID: string, patch: Partial<SubagentMeta>): Promise<void> {
    const entry = this.entries.get(childID)
    if (!entry) return
    const write = async () => {
      const opened = await this.ensureOpen(childID, true)
      const session = opened.session
      if (!session) return
      const current = (await session.getValue(SUBAGENT_META, this.context))?.value
      if (current) await session.setValue(SUBAGENT_META, { ...current, ...patch }, this.context)
    }
    const next = (entry.metaWrites ?? Promise.resolve()).then(write)
    entry.metaWrites = next.catch(() => {})
    await next
  }

  private async childMeta(parentID: string, childID: string): Promise<SubagentMeta | undefined> {
    let entry = this.entries.get(childID)
    if (!entry) {
      await this.list()
      entry = this.entries.get(childID)
    }
    if (!entry || entry.parentID !== parentID) return undefined
    const opened = await this.ensureOpen(childID, true)
    return (await opened.session?.getValue(SUBAGENT_META, this.context))?.value
  }

  /**
   * 请求中断并等到 lane 真的空下来。idle 状态由 run_end 发出去。
   *
   * requestAbort **只落盘一个取消标记**,落定要有人 drive。所以还得问一遍有没有在飞的
   * 操作:重开会话带进来的、或者 deferred 挂着的那种没有本地 drive,少这一步
   * waitForIdle 就会永远停在那里(cli 的 abort() 是同一套动作)。
   */
  private async stop(entry: Entry): Promise<void> {
    // 还在准备期(压缩附件)的那一轮:lane 上什么都没有,只能靠这个标记让它别再开跑。
    if (entry.preparing) {
      entry.preparing.cancelled = true
      entry.preparing.controller.abort()
    }
    // **先结算未决的确认**:挂起中的钩子占着这一轮的 drive,requestAbort 与 waitForIdle 都要等它
    // 先回来。顺序反了的表现是"点停止没反应",一直到确认台十分钟超时才动。
    this.desk.cancel(entry.id)
    const lane = entry.lane
    if (!lane) return
    const operationId = entry.operationId
    if (operationId) {
      // OperationMismatch = 那个操作已经自己结束了,不是错误。
      const requested = await lane.requestAbort(operationId, this.context)
      if (!requested.ok && requested.error._tag !== "OperationMismatch") throw laneError(requested.error)
    }
    const pending = (await lane.inspectExecution(this.context)).current
    if (pending) {
      // NoActiveOperation = 刚才那一瞬间它自己落定了,不是错误。
      const aborted = await lane.abort(this.context)
      if (!aborted.ok && aborted.error._tag !== "NoActiveOperation") throw laneError(aborted.error)
    }
    await lane.waitForIdle(this.context)
  }

  async abort(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry || (!isOpen(entry) && !entry.preparing)) return
    await this.stop(entry)
    this.options.emit(this.setStatus(entry, { type: "idle" }))
  }

  /** 手动压缩。状态(compacting → idle)由 compaction_start/end 事件发出去。 */
  async compact(sessionID: string): Promise<void> {
    const entry = await this.ensureOpen(sessionID)
    const lane = entry.lane!
    // 和 prompt() 同一条规矩:一条 lane 同时只有一个操作,忙着就先中断 ——
    // 直接压会拿到 LaneBusy,而用户点"压缩"的意思本来就是"这轮别跑了,清上下文"。
    if (entry.status.type !== "idle") await this.stop(entry)
    const result = await lane.compact(undefined, this.context)
    if (!result.ok) throw laneError(result.error)

    // CompactionEntry 没有"为什么压缩"这个字段,而 live 与重放必须给出同一个 auto。
    // 所以自己补一条 custom entry 当这条事实的载体:结构性操作结束时 tip 正落在刚写进去
    // 的那条压缩 entry 上(runtime/drive/structural.ts),指的就是它。
    const compactionEntryId = result.value.compaction.tipId
    if (compactionEntryId) {
      await lane.appendCustomEntry(MANUAL_COMPACTION_ENTRY, { compactionEntryId, manual: true }, this.context)
    }
  }

  /**
   * 顶替 opencode 的 revert。
   *
   * 只能把 lane 的 tip 挪回某条消息,**不还原文件**。所以这不是"回滚",是"改上一条重发"
   * —— UI 上绝不能叫回滚,否则在 agent 改过固件源码之后,用户会以为文件也回去了。
   */
  async navigate(sessionID: string, messageID: string): Promise<{ editorText: string }> {
    const entry = await this.ensureOpen(sessionID)
    const entryId = entry.projection!.entryIdOf(messageID)
    if (!entryId) throw new Error(`消息 ${messageID} 不在这个会话的历史里`)

    // 目标是一条 user 消息 = "回到发这句话之前":tip 落到它的父节点,原文交还给输入框
    // 让用户改完重发。别的类型就停在那条 entry 上。
    const target = await entry.session!.getEntry(entryId, this.context)
    let tipId: string | null = entryId
    let editorText = ""
    if (target?.type === "message" && target.message.role === "user") {
      tipId = target.parentId
      editorText = textOf(target.message.content)
    }
    // 重建投影之前先留一份快照:被抛下那条分支的消息要逐条报 removed。
    const before = entry.projection!.snapshot()
    const result = await entry.lane!.navigateTree(tipId, undefined, this.context)
    if (!result.ok) throw laneError(result.error)

    // 树变了:投影器必须重建,否则它还记着被抛下那条分支的消息。活下来的那些沿用原 id。
    const projection = this.newProjection(entry, entry.projection)
    await this.replay(entry.lane!, projection)
    entry.projection = projection
    entry.updatedAt = Date.now()
    // removed 必须排在 session.updated 之前:前端的消息集合只增不减,只发
    // session.updated 它不会重拉,被抛下那半条 transcript 会一直留在屏幕上。
    this.options.emit([
      ...removalEvents(entry.id, before, projection.snapshot()),
      { type: "session.updated", session: toView(entry) },
    ])
    return { editorText }
  }

  async messages(sessionID: string) {
    const entry = await this.ensureOpen(sessionID, true)
    return { items: entry.projection!.snapshot() }
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 淘汰空闲最久的会话。只丢内存态,不丢磁盘,重开很便宜。 */
  private evictIdle(): void {
    // 正在装配的不算"活着的":它还没有 lane,淘汰它只会把自己那次 open 拆掉。
    // 钉住的也不算:子 agent 任务排队中 / 刚打开还没 accept / 两轮之间都是 idle,关掉它等于把任务拆了(§6.7)。
    const live = [...this.entries.values()].filter(
      (e) => isOpen(e) && !e.opening && !e.pinned && e.status.type === "idle",
    )
    if (live.length <= MAX_LIVE_SESSIONS) return
    live.sort((a, b) => a.touched - b.touched)
    for (const entry of live.slice(0, live.length - MAX_LIVE_SESSIONS)) void this.dispose(entry).catch(() => {})
  }

  /**
   * 销毁内存态。**关的过程本身要可见** —— 记在 entry.closing 上,ensureOpen 据此等它收完
   * 再重开;否则并发进来的调用会拿到一个订阅已经摘掉、lane 马上要被清空的半关 entry。
   */
  private dispose(entry: Entry): Promise<void> {
    entry.closing ??= this.closeEntry(entry).finally(() => {
      entry.closing = undefined
    })
    return entry.closing
  }

  private async closeEntry(entry: Entry): Promise<void> {
    // 先结算未决的确认:下面摘订阅并不会结算已在飞的 ask,而 stop 被 `if (entry.lane)` 挡住时
    // 确认台会一直挂到十分钟超时。
    this.desk.cancel(entry.id)
    // 装配还在飞就先等它:不等的话那次 open 会在我们关完之后把 lane 又挂回去。
    if (entry.opening) await entry.opening.catch(() => {})
    for (const unsubscribe of entry.unsubscribes ?? []) unsubscribe()
    entry.unsubscribes = undefined
    // 在飞轮次先中断:**硬件安全**优先,别把板子停在半条命令上。
    if (entry.lane) await this.stop(entry).catch(() => {})
    // 钩子在 stop 之后才摘:中断落地前再挂起的询问仍要过门,它们会被 stop 的取消信号结算掉。
    entry.unhook?.()
    entry.unhook = undefined
    // harness.close() 连会话一起关 —— 必须关,repo 不允许同一个会话开两次。
    if (entry.harness) await entry.harness.close(this.context).catch(() => {})
    else if (entry.session) await entry.session.close(this.context).catch(() => {})
    // 长驻工具先收:log 的采集器握着串口,会话关了它就该还回去,不能等到内核进程退出。
    for (const tool of entry.tools ?? []) await tool.dispose?.().catch(() => {})
    entry.tools = undefined
    // 当前的和 refreshMachineEnv 退役掉的一起收:遗留子进程一个都不许活过会话。
    await this.cleanupRetiredEnvs(entry)
    await entry.env?.cleanup(this.context).catch(() => {})
    entry.harness = undefined
    entry.lane = undefined
    entry.projection = undefined
    entry.session = undefined
    entry.env = undefined
    entry.shellEnv = undefined
    entry.toolchain = undefined
    entry.running = false
    entry.operationId = undefined
    // 收件箱在 JSONL 里(持久化),重开时从那里接着来;内存里这份副本随会话一起丢。
    entry.queued = undefined
    entry.turnCounts = undefined
    entry.maxTurnsHit = undefined
  }

  /** 收掉 refreshMachineEnv 退役下来的执行环境(它们可能还拖着子进程)。 */
  private async cleanupRetiredEnvs(entry: Entry): Promise<void> {
    const retired = entry.retiredEnvs
    if (!retired?.length) return
    entry.retiredEnvs = undefined
    for (const env of retired) await env.cleanup(this.context).catch(() => {})
  }

  async disposeAll(): Promise<void> {
    // 不再派生、不再投通知;排队中的任务直接落定。
    this.taskManager.shutdown()
    // 主会话先关:它们的停止顺着前台 agent 调用的中止停掉子 agent。反过来的话子 agent 先被停,主会话拿着
    // "子 agent 被停"的工具结果会再请求一次模型 —— 退出途中多跑一轮,而那一轮可能是一条烧录。
    const entries = [...this.entries.values()]
    for (const entry of entries.filter((item) => !item.parentID)) await this.dispose(entry)
    for (const entry of entries.filter((item) => item.parentID)) await this.dispose(entry)
  }
}

/** 收件箱 → `session.queue` 的视图:用户排队的消息给原文,子 agent 的通知只给个记号。 */
function queueView(items: readonly LaneQueuedItem[]): QueuedItemView[] {
  return items.flatMap((item): QueuedItemView[] => {
    if (item.type !== "message") return []
    const message = item.message
    if (message.role === "user") {
      const images = typeof message.content === "string" ? 0 : message.content.filter((block) => block.type === "image").length
      return [{ kind: "prompt", entryId: item.entryId, text: textOf(message.content), images }]
    }
    if (message.role === "custom" && message.customType === TASK_NOTIFICATION_TYPE) {
      const taskID = (message.details as { taskID?: unknown } | undefined)?.taskID
      return [{ kind: "notification", entryId: item.entryId, ...(typeof taskID === "string" ? { taskID } : {}) }]
    }
    return []
  })
}

// ---------------------------------------------------------------------------

function toView(entry: Entry): ViewSession {
  return {
    id: entry.id,
    directory: entry.cwd,
    title: entry.title || defaultTitle(entry),
    time: { created: entry.createdAt, updated: entry.updatedAt },
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.parentID ? { parentID: entry.parentID } : {}),
    ...(entry.child?.agent ? { agent: entry.child.agent } : {}),
  }
}

function defaultTitle(entry: Entry): string {
  const name = entry.cwd.split("/").filter(Boolean).at(-1) ?? "会话"
  return name
}

/** 用户消息的正文(图片块丢掉)—— navigate 把它交还给输入框。 */
function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content
  return content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("")
}
