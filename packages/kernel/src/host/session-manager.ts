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
import path from "node:path"

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentLane,
  type Context,
  type ExecutionToolContext,
  type JsonlSessionMetadata,
  type OperationRequest,
  type Session as PiSession,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import {
  findEnvKey,
  machinePathDirs,
  promptSectionFor,
  readLedger,
  resolveToolchain,
  shellEnvFor,
  withMachineOnPath,
  type ToolchainResolution,
} from "@yoma/coding-agent"
import { buildSystemPrompt } from "@yoma/coding-agent/system-prompt"
import { configurableProviders, resolveModel } from "@yoma/coding-agent/models"
import { discoverSkills, loadContextFiles } from "@yoma/coding-agent/resources"
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AuthContext,
  type ImageContent,
  type Model,
  type Models,
} from "@earendil-works/pi-ai"

import type { KernelEvent, PromptInput } from "../protocol.ts"
import type { ProviderInfo, Session as ViewSession, SessionStatus } from "../types.ts"
import { Identifier } from "../ids.ts"
import { pickThinkingLevel } from "../thinking.ts"
import { sessionNotFound } from "../types.ts"
import { MANUAL_COMPACTION_ENTRY, removalEvents, SessionProjection } from "./projector.ts"
import { migrateLegacyPiAuth, yomaConfigDir, removeAuthKey, writeAuthKey } from "./auth.ts"

/** 同时活着的 harness 上限。淘汰只是丢弃内存态,重开就是 repo.open + 重放,很便宜。 */
const MAX_LIVE_SESSIONS = 8

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
 * 装配面的真源:内核自带的四件套,别的一个都不加。
 *
 * 嵌入式那一套(flash/gdb/la/scope/…)已于 2026-09-10 归零,旧实现留在
 * coding-agent/attic/tools 作重写参考。`TOOL_NAMES` 与 host 自检都按这里核对。
 */
export function createAgentTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return [
    createReadTool(),
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
  ]
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
  if (current.split(path.delimiter).includes(bin)) return env
  const out: NodeJS.ProcessEnv = { ...env }
  out[pathKey] = [bin, current].filter(Boolean).join(path.delimiter)
  return out
}

/**
 * 把机器级目录前置进**内核进程自己的** PATH。幂等(已在的不重复);写回原键(Windows 的
 * "Path")。只此一处改 process.env —— 理由见 sessionShellEnv。
 */
export function applyMachinePathToProcess(dirs: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (dirs.length === 0) return
  const next = withMachineOnPath(env, dirs)
  if (next === env) return
  const pathKey = findEnvKey(env, "PATH") ?? "PATH"
  env[pathKey] = next[pathKey]
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
  /** renderer 乐观插入用户消息时铸的 id,等用户消息落盘时复用。 */
  pendingUserID?: string
}

export interface SessionManagerOptions {
  sessionsRoot: string
  enginesDir?: string
  emit(events: KernelEvent[]): void
  /**
   * 上下文文件与技能的全局目录,默认 `~/.yoma`。测试用它隔离开发机上的真实目录。
   */
  configDir?: string
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
}

export class SessionManager {
  private readonly env: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  private readonly entries = new Map<string, Entry>()
  private readonly options: SessionManagerOptions
  /** 凭据、技能、上下文文件共用的一个目录。 */
  private readonly configDir: string
  /**
   * 所有内核调用的 Context。宿主没有"取消一次 RPC"这回事 —— 轮次的取消走
   * lane.requestAbort(那是**落盘的**取消事实),不靠 signal。
   */
  private readonly context: Context = BACKGROUND_CONTEXT

  private models?: Models
  private defaultModel?: Model<string>
  private modelError?: string

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.configDir = options.configDir ?? yomaConfigDir()
    this.env = new NodeExecutionEnv({ cwd: process.cwd() })
    this.repo = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot: options.sessionsRoot })
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
    try {
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
      this.models = resolved.models
      this.defaultModel = resolved.model as Model<string>
      this.modelError = undefined
      return { models: this.models, model: this.defaultModel }
    } catch (error) {
      this.modelError = (error as Error).message
      throw error
    }
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
    return out
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
    const metas = await this.repo.list(directory ? { cwd: directory } : {}, this.context)
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
      }
      this.entries.set(meta.id, entry)
      out.push(toView(entry))
    }
    return out.sort((a, b) => b.time.updated - a.time.updated)
  }

  async create(directory: string, title?: string): Promise<ViewSession> {
    const session = await this.repo.create({ cwd: directory }, this.context)
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

  async delete(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry) return
    await this.dispose(entry)
    await this.repo.delete(entry.meta, this.context)
    this.entries.delete(sessionID)
    this.options.emit([{ type: "session.deleted", sessionID }])
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
   * 打开(或复用)一个会话。
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
  private async ensureOpen(sessionID: string): Promise<Entry> {
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
    if (isOpen(entry)) return entry
    entry.opening ??= this.openEntry(entry).finally(() => {
      entry.opening = undefined
    })
    return entry.opening
  }

  private async openEntry(entry: Entry): Promise<Entry> {
    // 工具链解析必须在造 NodeExecutionEnv **之前**拿到结果:shellEnv 只能通过构造参数
    // 一次性灌进去(私有字段,没有 setter),而子进程认的是造 env 那一刻的环境 ——
    // 运行时再对着已经造好的 env 补 PATH 不会生效(根 CLAUDE.md「会咬人的地方」第一条)。
    //
    // 不能像 loadContextFiles/discoverSkills 那样并进它们那个 Promise.all —— 那两个
    // 的入参正是 env,而 env 本身要等这次解析完才能造出来,凑一起就是循环依赖。
    // 真正同类(不依赖 env、建会话时只读一次的快照)又能安全并发的是 ensureModels()。
    const [{ models, model }, toolchain] = await Promise.all([this.ensureModels(), this.resolveToolchainSafe(entry)])

    const session = entry.session ?? (await this.repo.open(entry.meta, this.context))
    entry.session = session
    entry.toolchain = toolchain
    // engines/bin 前置进 PATH:bash 工具里要有 rg(在例程语料里 grep 全靠它,Windows
    // 没有内置 grep)。机器级目录(Yoma 装的 + 用户手指的)夹在中间:项目清单解析到的
    // 赢过它们,它们赢过 process.env 里原有的。
    entry.shellEnv = await this.sessionShellEnv(toolchain)
    const env = this.toolEnv(entry)
    let harness: AgentHarness<ExecutionToolContext> | undefined
    try {
      // 资源发现:项目的 AGENTS.md/CLAUDE.md(全局 + 祖先链)与技能(全局 + .agents/skills)。
      // 走 coding-agent 的 resources.ts,不重写:"从哪些目录找"是产品决策,抄一份的结果
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

      // 工具链状态并进系统提示词:追加一条 contextFiles,不新增专门字段 ——
      // BuildSystemPromptOptions 定义在 packages/coding-agent,加字段等于越界改别的包。
      // path 给一个不会真实存在的假名,模型才看得出这不是一份项目文件。promptSectionFor
      // 对"没有清单"和"清单存在但全部 ok"都返回 undefined,所以绝大多数项目不追加任何
      // 东西,系统提示词字节不变。
      const toolchainSection = promptSectionFor(toolchain)
      const contextFilesWithToolchain = toolchainSection
        ? [...contextFiles, { path: "<toolchain>", content: toolchainSection }]
        : contextFiles

      const tools = createAgentTools()
      const created = await AgentHarness.create<ExecutionToolContext>(
        {
          session,
          models,
          model,
          // 不传则内核落到 "off"。setModel 的显式选择压过这里。注意这只是**新 lane 的种子**:
          // 重开一个旧会话时用的是它自己存下来的那一档。
          ...(this.options.defaultThinkingLevel
            ? {
                thinkingLevel: pickThinkingLevel(
                  getSupportedThinkingLevels(model) as string[],
                  this.options.defaultThinkingLevel,
                ) as ThinkingLevel,
              }
            : {}),
          tools,
          activeToolNames: tools.map((tool) => tool.name),
          // 函数形态:每轮重新解析一次,于是 refreshMachineEnv 换掉 shellEnv 之后
          // 下一条 bash 命令就看得见新 PATH,不用重开会话。
          toolContext: () => ({ env: this.toolEnv(entry) }),
          systemPrompt: buildSystemPrompt({
            cwd: entry.cwd,
            selectedTools: tools.map((tool) => tool.name),
            contextFiles: contextFilesWithToolchain,
            skills: discovered.skills,
          }),
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
      entry.title = (await harness.getName(this.context)) ?? entry.title

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
      entry.unsubscribes = this.subscribe(entry, harness)
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
    return entry
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
  private async replay(lane: AgentLane, projection: SessionProjection): Promise<void> {
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
   * by:"user"),见 coding-agent install.ts 的 machinePathDirs。每次都重新扫 —— 这是
   * 会话开启 / 安装完成时才调的东西,不在热路径上。
   */
  private async machineDirs(): Promise<string[]> {
    const ledger = await readLedger(this.configDir)
    return machinePathDirs({ configDir: this.configDir, ledger })
  }

  /**
   * 一个会话的 bash 基础环境:engines/bin ⊕ 项目清单解析到的目录 ⊕ 机器级目录 ⊕ process.env。
   * 顺带把机器级目录也前置进内核进程自己的 PATH —— host 侧自己起子进程时用的是
   * process.env,不是会话的 shellEnv。
   */
  private async sessionShellEnv(toolchain: ToolchainResolution, dirs?: string[]): Promise<NodeJS.ProcessEnv> {
    const machine = dirs ?? (await this.machineDirs())
    applyMachinePathToProcess(machine)
    return withEnginesOnPath(withMachineOnPath(shellEnvFor(toolchain, process.env), machine), this.options.enginesDir)
  }

  /** 会话当前的执行环境。shellEnv 换过之后(refreshMachineEnv)这里会重建一个。 */
  private toolEnv(entry: Entry): NodeExecutionEnv {
    entry.env ??= new NodeExecutionEnv({ cwd: entry.cwd, ...(entry.shellEnv ? { shellEnv: entry.shellEnv } : {}) })
    return entry.env
  }

  /**
   * 工具链装好之后调:重算每个**活着的**会话的 bash 环境,让下一条命令就看得见新目录,
   * 不用重开会话;同时更新内核进程自己的 PATH。清单解析也重跑一遍 —— 刚装的可能正是
   * 清单里 MISSING 的那个。被 LRU 淘汰的会话 dispose 时清掉了 env,这里不会为它们
   * 白起 --version 子进程。
   */
  async refreshMachineEnv(): Promise<void> {
    const dirs = await this.machineDirs()
    for (const entry of this.entries.values()) {
      if (!isOpen(entry)) continue
      const toolchain = await this.resolveToolchainSafe(entry)
      entry.toolchain = toolchain
      entry.shellEnv = await this.sessionShellEnv(toolchain, dirs)
      // 下一轮的 toolContext 会按新 shellEnv 造一个。在飞的那个还拿着旧环境 ——
      // 它可能正有子进程在跑,不能就地替;但也不能直接丢引用,否则那些子进程会活过
      // 整个会话(**硬件安全**:可能是一条烧录命令)。退役存起来,这一轮结束或
      // dispose 时 cleanup。
      if (entry.env) (entry.retiredEnvs ??= []).push(entry.env)
      entry.env = undefined
    }
    // 内核进程自己的 PATH 无条件刷一次(幂等):没有开着的会话时上面的循环不会碰它。
    applyMachinePathToProcess(dirs)
  }

  /**
   * 工具链清单解析失败(清单文件在,但内容坏了——`schema` 不对/JSON 损坏/写了绝对
   * 路径等,见 coding-agent 的 parseManifest)绝不能让会话开不起来:会话开不起来
   * 比工具链没配好严重得多。resolveToolchain() 本身对"项目根本没有清单文件"已经是
   * 静默返回一个空结果;这里只是把"清单存在但解析炸了"这一种情况也吞掉异常、发一条
   * kernel.error 诊断,折叠回同一种空结果 —— 调用方(shellEnvFor / promptSectionFor)
   * 因此不用关心"没有清单"和"清单解析失败"是两回事。
   */
  private async resolveToolchainSafe(entry: Entry): Promise<ToolchainResolution> {
    const side = this.options.toolchainSide ?? "mother"
    try {
      return await resolveToolchain({
        projectDir: entry.cwd,
        configDir: this.configDir,
        side,
        manifestText: this.options.toolchainManifestText,
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
    return [
      harness.events.on("run_start", (event) => {
        entry.running = true
        entry.operationId = event.runId
        emit(this.setStatus(entry, { type: "busy" }))
      }),
      harness.events.on("run_end", () => {
        entry.running = false
        entry.operationId = undefined
        entry.updatedAt = Date.now()
        emit([...this.setStatus(entry, { type: "idle" }), { type: "session.updated", session: toView(entry) }])
        // 这一轮结束了,refreshMachineEnv 退役掉的旧环境现在可以安全收子进程了。
        void this.cleanupRetiredEnvs(entry)
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
        // renderer 乐观插入过一条,id 要复用。pendingUserID 由 prompt() 放进来。
        const given = message.role === "user" ? entry.pendingUserID : undefined
        if (given) entry.pendingUserID = undefined
        apply((projection) =>
          projection.applyMessage(message, {
            ...(event.entryId ? { entryId: event.entryId } : {}),
            ...(given ? { messageID: given } : {}),
          }),
        )
      }),
      harness.events.on("tool_start", (event) => apply((projection) => projection.markToolRunning(event.toolCallId))),
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

  private setStatus(entry: Entry, status: SessionStatus): KernelEvent[] {
    if (entry.status.type === status.type) return []
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
    entry.running = false
    entry.operationId = undefined
    this.options.emit([
      { type: "kernel.error", sessionID: entry.id, message },
      ...this.setStatus(entry, { type: "idle" }),
    ])
  }

  // -------------------------------------------------------------------------
  // 一轮对话
  // -------------------------------------------------------------------------

  async prompt(sessionID: string, input: PromptInput): Promise<{ messageID: string }> {
    const entry = await this.ensureOpen(sessionID)
    const lane = entry.lane!

    // 一条 lane 同时只有一个操作:忙的时候 accept 回 LaneBusy。先中断,再等真的回到 idle。
    if (entry.status.type !== "idle") await this.stop(entry)

    const messageID = input.messageID ?? Identifier.ascending("message")
    entry.pendingUserID = messageID

    const images: ImageContent[] = (input.files ?? [])
      .filter((file) => file.mime.startsWith("image/"))
      .map((file) => ({
        type: "image" as const,
        data: file.url.replace(/^data:[^;]+;base64,/, ""),
        mimeType: file.mime,
      }))

    // 一轮只收 images,别的附件送不进模型。曾经的事故形态:UI 把 PDF 显示成附件、
    // 这里静默丢掉,两边都不吭声,用户以为模型看过了。UI 侧已按能力分流(有本机路径的
    // PDF/文本转 @ 提及,无路径的 PDF 拒收),这里是防回归的哨兵 —— 只盯 data: URL 的
    // 内容型附件;file:// 的提及件路径已在正文里、agent 自己会去读,丢掉 part 是预期行为。
    const dropped = (input.files ?? []).filter((file) => !file.mime.startsWith("image/") && file.url.startsWith("data:"))
    if (dropped.length > 0) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID,
          message: `附件 ${dropped.map((f) => f.filename ?? f.mime).join("、")} 不是图片,当前无法送达模型,已忽略`,
        },
      ])
    }

    const request: OperationRequest = images.length
      ? { kind: "prompt", prompt: input.text, images }
      : { kind: "prompt", prompt: input.text }
    const accepted = await lane.accept(request, this.context)
    if (!accepted.ok) {
      entry.pendingUserID = undefined
      throw laneError(accepted.error)
    }
    const operationId = accepted.value.operationId
    entry.operationId = operationId

    // 不 await:一轮可能跑几分钟,请求必须立刻返回,结果全部走事件流。
    // waitForRetry 把内核的退避留在这一次 drive 里,于是整段重试是一个连续的 busy ——
    // 退避窗口里漏出 idle,bench 会当真去回填结果,而 agent 正要重试。
    // pollDeferred 同理管 provider 侧的异步生成:漏了它 drive 会带着
    // kind:"waiting" 提前回来,而 run_end 永远不来,状态就永久钉在 busy。
    void lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, this.context).then(
      (driven) => {
        if (!driven.ok) this.fail(entry, laneErrorMessage(driven.error))
        // 两个开关都开了还 waiting,说明这一轮没人会再驱动它 —— 当失败处理,
        // 否则状态停在 busy,用户只能重启。
        else if (driven.value.kind === "waiting") this.fail(entry, WAITING_TEXT[driven.value.reason])
      },
      (error: unknown) => this.fail(entry, laneErrorMessage(error as Error)),
    )

    return { messageID }
  }

  /**
   * 请求中断并等到 lane 真的空下来。idle 状态由 run_end 发出去。
   *
   * requestAbort **只落盘一个取消标记**,落定要有人 drive。所以还得问一遍有没有在飞的
   * 操作:重开会话带进来的、或者 deferred 挂着的那种没有本地 drive,少这一步
   * waitForIdle 就会永远停在那里(cli 的 abort() 是同一套动作)。
   */
  private async stop(entry: Entry): Promise<void> {
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
    if (!entry || !isOpen(entry)) return
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
    const entry = await this.ensureOpen(sessionID)
    return { items: entry.projection!.snapshot() }
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 淘汰空闲最久的会话。只丢内存态,不丢磁盘,重开很便宜。 */
  private evictIdle(): void {
    // 正在装配的不算"活着的":它还没有 lane,淘汰它只会把自己那次 open 拆掉。
    const live = [...this.entries.values()].filter((e) => isOpen(e) && !e.opening && e.status.type === "idle")
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
    // 装配还在飞就先等它:不等的话那次 open 会在我们关完之后把 lane 又挂回去。
    if (entry.opening) await entry.opening.catch(() => {})
    for (const unsubscribe of entry.unsubscribes ?? []) unsubscribe()
    entry.unsubscribes = undefined
    // 在飞轮次先中断:**硬件安全**优先,别把板子停在半条命令上。
    if (entry.lane) await this.stop(entry).catch(() => {})
    // harness.close() 连会话一起关 —— 必须关,repo 不允许同一个会话开两次。
    if (entry.harness) await entry.harness.close(this.context).catch(() => {})
    else if (entry.session) await entry.session.close(this.context).catch(() => {})
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
  }

  /** 收掉 refreshMachineEnv 退役下来的执行环境(它们可能还拖着子进程)。 */
  private async cleanupRetiredEnvs(entry: Entry): Promise<void> {
    const retired = entry.retiredEnvs
    if (!retired?.length) return
    entry.retiredEnvs = undefined
    for (const env of retired) await env.cleanup(this.context).catch(() => {})
  }

  async disposeAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.dispose(entry)
  }
}

// ---------------------------------------------------------------------------

function toView(entry: Entry): ViewSession {
  return {
    id: entry.id,
    directory: entry.cwd,
    title: entry.title || defaultTitle(entry),
    time: { created: entry.createdAt, updated: entry.updatedAt },
    ...(entry.model ? { model: entry.model } : {}),
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
