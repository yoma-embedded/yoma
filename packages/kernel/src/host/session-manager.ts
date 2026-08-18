/**
 * 会话管理:一个 sessionID ↔ 一个 AgentHarness ↔ 一个投影器。
 *
 * ## 为什么整个 app 只能有一个内核进程
 *
 * yoma 的 probe 租约(claimProbe/releaseProbe)、gdb session 表、log capture 都是
 * **模块级全局**(coding-agent/src/core/tools/engines.ts:63-113),还挂了进程退出的
 * SIGKILL 钩子。所以绝不能按窗口或按目录分片 fork 内核 —— 否则两个进程会各自以为
 * 自己独占探针。这个类是进程内单例。
 *
 * ## harness 的三个必须知道的行为
 *
 * 1. 一个 harness = 一个 session = 一个在飞轮次。phase 非 idle 时 `prompt()` **同步抛**
 *    AgentHarnessError("busy"),它不排队。
 * 2. `abort()` 之后 phase 不会立刻清,必须 `await abort(); await waitForIdle()`。
 * 3. `prompt()` 在 abort 之后是 **resolve 而不是 reject**(中断是数据不是异常),
 *    所以要区分"取消"和"正常完成"只能自己拿 AbortController。
 */

import { homedir } from "node:os"
import path from "node:path"

import { AgentHarness, JsonlSessionRepo, type AgentMessage, type Session as PiSession } from "@yoma/agent"
import type { AgentHarnessEvent, JsonlSessionMetadata } from "@yoma/agent"
import { NodeExecutionEnv } from "@yoma/agent/node"
import {
  createCodingToolDefinitions,
  createDatasheetToolDefinition,
  createFlashToolDefinition,
  createGdbToolDefinition,
  createLogToolDefinition,
  createNetlistToolDefinition,
  createStm32ConfigToolDefinition,
  promptSectionFor,
  resolveToolchain,
  shellEnvFor,
  wrapToolDefinitions,
  type ToolchainResolution,
  type ToolDef,
} from "@yoma/coding-agent"
import { buildSystemPrompt, collectToolPromptData } from "@yoma/coding-agent/system-prompt"
import { resolveModel } from "@yoma/coding-agent/models"
import { discoverSkills, loadContextFiles } from "@yoma/coding-agent/resources"
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Model,
  type Models,
} from "@earendil-works/pi-ai"

import type { KernelEvent, PromptInput } from "../protocol.ts"
import type {
  ProviderInfo,
  Session as ViewSession,
  SessionStatus,
} from "../types.ts"
import { Identifier } from "../ids.ts"
import { pickThinkingLevel } from "../thinking.ts"
import { sessionNotFound } from "../types.ts"
import { SessionProjection } from "./projector.ts"
import { shouldAutoCompact } from "./compaction.ts"
import { retryDelayMs, retrySleep, shouldAutoRetry } from "./retry.ts"
import { CONFIGURABLE_PROVIDERS, migrateLegacyPiAuth, yomaConfigDir, removeAuthKey, writeAuthKey } from "./auth.ts"

/** 同时活着的 harness 上限。淘汰只是丢弃内存态,重开就是 repo.open + buildContext,很便宜。 */
const MAX_LIVE_SESSIONS = 8

/**
 * 嵌入式六件套的显式装配,顺序照抄 yoma 的流水线(netlist → datasheet → stm32config
 * → flash → log → gdb)。yoma 2026-08 的精简删掉了聚合 Options 的工厂参数
 * (createEmbeddedToolDefinitions 只收 env),而 enginesDir 必须显式传
 * (它的向上查找会认下一个没有 bin/ 的空壳)—— 所以按"单工具工厂 + options"自行装配,
 * yoma 的 tools/index.ts 注释明说这是特殊装配的预期用法。
 */
export function createEmbeddedTools(env: NodeExecutionEnv, enginesDir?: string): ToolDef[] {
  const engines = enginesDir ? { enginesDir } : undefined
  return [
    createNetlistToolDefinition(env, engines),
    createDatasheetToolDefinition(env),
    createStm32ConfigToolDefinition(env, engines),
    // flash/log/gdb 自 2026-08 起不吃 enginesDir:烧录命令模型自带,RTT 走 TCP,
    // gdb server 从 PATH 起 —— 引擎目录只剩上面两个还要。
    createFlashToolDefinition(env),
    createLogToolDefinition(env),
    createGdbToolDefinition(env),
  ]
}

interface Entry {
  id: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  meta: JsonlSessionMetadata
  session?: PiSession<JsonlSessionMetadata>
  harness?: AgentHarness
  projection?: SessionProjection
  unsubscribe?: () => void
  status: SessionStatus
  /** 上一次被使用的时刻,LRU 用。 */
  touched: number
  /** 本轮的 AbortController —— harness.prompt() 在 abort 后 resolve,靠它区分取消。 */
  aborter?: AbortController
  model?: { providerID: string; modelID: string; thinking?: string }
  /** 正在自动压缩。防止 turn_end 连发时重入。 */
  compacting?: boolean
  /** 这一轮以可重试的错误收场,idle 要压住 —— 见 project() 与 maybeAutoRetry()。 */
  retryPending?: boolean
  /** 本次 prompt 已经重试过几次。prompt() 开始时清零。 */
  retryAttempt?: number
}

export interface SessionManagerOptions {
  sessionsRoot: string
  enginesDir?: string
  emit(events: KernelEvent[]): void
  /**
   * 上下文文件与技能的全局目录,默认 `~/.yoma` —— 与 yoma 的 ACP 适配器同一份,
   * 于是同一份技能在 Zed 和桌面端都生效。测试用它隔离开发机上的真实目录
   * (**注意** bun 的 homedir() 在进程启动时定死,改 process.env.HOME 无效)。
   */
  configDir?: string
  /**
   * 模型目录的来源。默认复用 yoma 的 resolveModel()(读 ~/.pi/agent/auth.json)。
   * 可注入是为了两件事:测试用 pi-ai 的 faux provider 跑完整一轮而不需要网络和 key;
   * 以及 P6 换成我们自己的凭据管理(Electron safeStorage)时不用改这里。
   */
  resolveModels?: () => Promise<{ models: Models; model: Model<string> }>
  /**
   * 没人选档时用哪一档。不传则 harness 落到 `"off"`。
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
  /** 凭据、技能、上下文文件共用的一个目录,与 yoma ACP 的 CONFIG_DIR 同义。 */
  private readonly configDir: string

  private models?: Models
  private defaultModel?: Model<string>
  private modelError?: string

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.configDir = options.configDir ?? yomaConfigDir()
    this.env = new NodeExecutionEnv({ cwd: process.cwd() })
    this.repo = new JsonlSessionRepo({ fs: this.env, sessionsRoot: options.sessionsRoot })
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  /**
   * 延迟解析模型目录。
   *
   * 复用 yoma 自己的 resolveModel() —— 它读 ~/.pi/agent/auth.json,也就是用户配 pi/Zed
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
        : ((await resolveModel(this.configDir)) as { models: Models; model: Model<string> })
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
    let models: Models
    try {
      models = (await this.ensureModels()).models
    } catch {
      // 一个 key 都没配时 resolveModel() 直接抛,注册表是空的。这时必须交出
      // 可配置目录(authenticated: false),否则连接对话框无物可列,首跑用户被锁死。
      return CONFIGURABLE_PROVIDERS.map((spec) => ({ id: spec.id, name: spec.name, authenticated: false, models: [] }))
    }

    const out: ProviderInfo[] = []
    for (const provider of models.getProviders()) {
      const list = provider.getModels()
      // 没配凭据的 provider 也要列出来,否则用户不知道还能选什么。
      let authenticated = false
      try {
        authenticated = list.length > 0 && Boolean(await models.getAuth(list[0]!))
      } catch {
        authenticated = false
      }
      out.push({
        id: provider.id,
        name: provider.name,
        authenticated,
        models: list.map((model) => ({
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
    // resolveModel() 只注册 auth.json 里有 key 的 provider。没配的也要列出来
    // (空模型表 + authenticated: false),用户才能从连接对话框里给它加 key。
    for (const spec of CONFIGURABLE_PROVIDERS) {
      if (!out.some((provider) => provider.id === spec.id))
        out.push({ id: spec.id, name: spec.name, authenticated: false, models: [] })
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 凭据
  // -------------------------------------------------------------------------

  /**
   * 写入一个 provider 的 API key(落到 yoma 读的那份 ~/.pi/agent/auth.json)。
   *
   * 写完必须丢弃已解析的模型目录:resolveModel() 只注册写入当时有 key 的 provider,
   * 不重解析的话新 key 要等重启进程才生效。注意 **已经开着的会话拿的还是旧注册表**
   * (AgentHarness.models 是 readonly,建好之后换不掉),新开/重开的会话才能用新 provider ——
   * 首跑场景(一个会话都没有)不受影响。
   *
   * key 本身不做网络验证:yoma 注册 provider 时不发请求,错 key 的暴露点是第一次
   * prompt 的 API 401,那条错误会走正常的会话错误通道显示出来。
   */
  async setAuth(providerID: string, apiKey: string): Promise<ProviderInfo[]> {
    const trimmed = apiKey.trim()
    if (!trimmed) throw new Error("API key 不能为空")
    if (!CONFIGURABLE_PROVIDERS.some((spec) => spec.id === providerID))
      throw new Error(
        `未知 provider ${providerID}。可配置:${CONFIGURABLE_PROVIDERS.map((spec) => spec.id).join(", ")}`,
      )
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
   * 跨 provider 切换只有在所有 provider 都提前注册好的前提下才成立 ——
   * AgentHarness.models 是 readonly,建好之后换不掉,而 ModelsImpl.requireProvider
   * 对未注册的 provider 会等到真正发请求时才抛 Unknown provider。resolveModel() 已经把
   * auth.json 里每个有 key 的 provider 都注册了,所以这里安全。
   */
  async setModel(sessionID: string, providerID: string, modelID: string, thinking?: string): Promise<ViewSession> {
    const entry = await this.ensureOpen(sessionID)
    const { models } = await this.ensureModels()
    const model = models.getModel(providerID, modelID)
    if (!model) throw new Error(`未知模型 ${providerID}/${modelID}`)

    await entry.harness!.setModel(model)
    // 钳一下:模型不支持的档位直接设进去会等到发请求时才炸。
    //
    // 没给 thinking 时也要钳 —— 当前这一档是按**换之前那个模型**的支持表定的
    // (构造期用的是 ensureModels 的默认模型,而调用方这一刻正要换成别的)。
    // 不重钳就会拿着旧模型的档位去发新模型的请求。对桌面端这是恒等变换:
    // 它没选过档位时当前值就是 "off",clamp("off") 在任何模型上都还是 "off"。
    const level = thinking ?? entry.harness!.getThinkingLevel()
    await entry.harness!.setThinkingLevel(clampThinkingLevel(model, level as never))
    entry.model = { providerID, modelID, thinking }
    entry.projection?.setModel(providerID, modelID)
    entry.updatedAt = Date.now()
    const view = toView(entry)
    this.options.emit([{ type: "session.updated", session: view }])
    return view
  }

  // -------------------------------------------------------------------------
  // 列表 / 创建 / 删除
  // -------------------------------------------------------------------------

  async list(directory?: string): Promise<ViewSession[]> {
    const metas = await this.repo.list(directory ? { cwd: directory } : {})
    const out: ViewSession[] = []
    for (const meta of metas) {
      const existing = this.entries.get(meta.id)
      if (existing) {
        out.push(toView(existing))
        continue
      }
      const createdAt = toMillis(meta.createdAt)
      const entry: Entry = {
        id: meta.id,
        cwd: meta.cwd,
        // 标题懒加载:repo.list() 只读 JSONL 的头一行,拿不到 appendSessionName 写进去的名字。
        // 真名在 open() 时补上,列表先用占位,避免为了画一个列表把每个会话文件全读一遍。
        title: "",
        createdAt,
        updatedAt: createdAt,
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
    const session = await this.repo.create({ cwd: directory })
    const meta = await session.getMetadata()
    const entry: Entry = {
      id: meta.id,
      cwd: directory,
      title: title ?? "",
      createdAt: toMillis(meta.createdAt),
      updatedAt: Date.now(),
      meta,
      session,
      status: { type: "idle" },
      touched: Date.now(),
    }
    this.entries.set(entry.id, entry)
    if (title) await session.appendSessionName(title)
    const view = toView(entry)
    this.options.emit([{ type: "session.created", session: view }])
    return view
  }

  async delete(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry) return
    await this.dispose(entry)
    await this.repo.delete(entry.meta)
    this.entries.delete(sessionID)
    this.options.emit([{ type: "session.deleted", sessionID }])
  }

  /** 标题写回 JSONL(appendSessionName 是内核的公开 API),不是只存在内存里。 */
  async rename(sessionID: string, title: string): Promise<ViewSession> {
    const entry = await this.ensureOpen(sessionID)
    await entry.session!.appendSessionName(title)
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

  private async ensureOpen(sessionID: string): Promise<Entry> {
    let entry = this.entries.get(sessionID)
    if (!entry) {
      await this.list()
      entry = this.entries.get(sessionID)
    }
    if (!entry) throw sessionNotFound(sessionID)
    entry.touched = Date.now()
    if (entry.harness) return entry

    // 工具链解析必须在 `new NodeExecutionEnv` **之前**拿到结果:shellEnv 只能通过
    // 构造参数一次性灌进去(私有字段,建好之后没有 setter),而 bun 的 spawn 省略
    // env 参数时认的是进程启动那一刻的 PATH——运行时再对着已经造好的 env 补 PATH
    // 不会生效(根 CLAUDE.md「会咬人的地方」第一条,coding-agent/src/core/tools/
    // serial.ts:176 是同一道疤)。
    //
    // 不能像 loadContextFiles/discoverSkills 那样并进它们那个 Promise.all——那两个
    // 的入参正是 env,而 env 本身要等这次解析完才能造出来,凑一起就是循环依赖。
    // 真正同类(不依赖 env、建会话时只读一次的快照)又能安全并发的是 ensureModels()。
    const [{ models, model }, toolchain] = await Promise.all([this.ensureModels(), this.resolveToolchainSafe(entry)])

    const session = entry.session ?? (await this.repo.open(entry.meta))
    entry.session = session
    entry.title = (await session.getSessionName()) ?? entry.title

    const env = new NodeExecutionEnv({ cwd: entry.cwd, shellEnv: shellEnvFor(toolchain, process.env) })

    // 资源发现:项目的 AGENTS.md/CLAUDE.md(全局 + 祖先链)与技能(全局 + .agents/skills)。
    // 走 yoma 自己的 resources.ts,不重写:"从哪些目录找"是内核那边定的产品决策,
    // 抄一份的结果会是"Zed 读得到项目上下文、桌面端读不到"这种极难归因的差异。
    // 全局目录与 ACP 一致(~/.yoma),于是同一份技能在 Zed 和桌面端都生效。
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

    // 工具链状态并进系统提示词:追加一条 contextFiles,不新增专门字段——
    // BuildSystemPromptOptions 定义在 packages/coding-agent(yoma 那侧),这次改动
    // 范围只有 packages/kernel,加字段等于越界改别的包。path 给一个不会真实存在的
    // 假名,模型才看得出这不是一份项目文件。promptSectionFor 对"没有清单"和"清单
    // 存在但全部 ok(没有需要留意的工具)"都返回 undefined,所以绝大多数项目(没有
    // .yoma/toolchain.json)不追加任何东西,系统提示词字节不变。
    const toolchainSection = promptSectionFor(toolchain)
    const contextFilesWithToolchain = toolchainSection
      ? [...contextFiles, { path: "<toolchain>", content: toolchainSection }]
      : contextFiles

    // 工具定义必须过 wrapToolDefinitions 才能交给 harness;系统提示词由工具集反推
    // (collectToolPromptData 会把每个工具的使用指导拼进去)。这两步照抄 yoma 自己的
    // ACP 适配器 acp/agent.ts:351-359 —— 系统提示词编码了嵌入式工具的用法,自己重写
    // 等于产品行为分叉。
    const toolDefinitions = [
      // toolchain 工具必须拿到和 resolveToolchainSafe 同一组答案(configDir / side /
      // manifestText),否则系统提示词与 agent 自己跑 toolchain check 会自相矛盾 ——
      // 工位端(没有项目检出,清单经信箱注入)那侧 check 会直接报"没有清单"。
      ...createCodingToolDefinitions(env, {
        toolchain: {
          configDir: this.configDir,
          side: this.options.toolchainSide,
          manifestText: this.options.toolchainManifestText,
        },
      }),
      ...createEmbeddedTools(env, this.options.enginesDir),
    ]
    const harness = new AgentHarness({
      env,
      session,
      models,
      model,
      // 不传则 harness 落到 "off"。setModel 的显式选择压过这里。
      thinkingLevel: this.options.defaultThinkingLevel
        ? (pickThinkingLevel(getSupportedThinkingLevels(model) as string[], this.options.defaultThinkingLevel) as never)
        : undefined,
      tools: wrapToolDefinitions(toolDefinitions),
      systemPrompt: buildSystemPrompt({
        cwd: entry.cwd,
        ...collectToolPromptData(toolDefinitions),
        contextFiles: contextFilesWithToolchain,
        skills: discovered.skills,
      }),
      // harness.skill() 从 turn 快照的 resources 里查技能。
      resources: { skills: discovered.skills },
    })
    entry.harness = harness

    const projection = new SessionProjection({
      sessionID: entry.id,
      providerID: model.provider,
      modelID: model.id,
    })
    entry.projection = projection

    entry.unsubscribe = harness.subscribe((event) => {
      this.options.emit(this.project(entry!, event))
    })

    // 重放历史。走的是和 live 完全相同的 applyMessage(),所以 id 与事件序列可复现。
    const context = await session.buildContext()
    for (const message of context.messages as AgentMessage[]) projection.applyMessage(message)

    this.evictIdle()
    return entry
  }

  /**
   * 工具链清单解析失败(清单文件在,但内容坏了——`schema` 不对/JSON 损坏/写了绝对
   * 路径等,见 coding-agent 的 parseManifest)绝不能让会话开不起来:会话开不起来
   * 比工具链没配好严重得多。resolveToolchain() 本身对"项目根本没有清单文件"已经是
   * 静默返回一个空结果(tools: [], manifest: undefined);这里只是把"清单存在但解析
   * 炸了"这一种情况也吞掉异常、发一条 kernel.error 诊断,折叠回同一种空结果——调用方
   * (shellEnvFor / promptSectionFor)因此不用关心"没有清单"和"清单解析失败"是两回事,
   * 统一按"当作没有清单"处理。
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

  /**
   * 内核事件 → 前端事件。
   *
   * 只用 subscribe() 拿观察事件 —— **别用 on()**:agent-harness.ts:230-248 的 emitOwn 和
   * emitAny 字节相同,都只遍历订阅者桶,所以 on("save_point"/"settled"/"abort"/
   * "session_compact"/"model_update"/"tools_update"/"queue_update"/"session_tree"/
   * "thinking_level_update"/"after_provider_response") 这十个类型永远不会触发。
   * 只有走 emitHook 的 tool_call / tool_result / context / before_agent_start /
   * session_before_compact / session_before_tree / before_provider_* 才是活的。
   */
  private project(entry: Entry, event: AgentHarnessEvent): KernelEvent[] {
    const projection = entry.projection
    if (!projection) return []

    switch (event.type) {
      case "message_start": {
        const message = event.message
        if (message.role === "assistant") return projection.applyMessage(message)
        if (message.role === "user") {
          // renderer 乐观插入过一条,id 要复用。pendingUserID 由 prompt() 放进来。
          const given = entry.pendingUserID
          entry.pendingUserID = undefined
          return projection.applyMessage(message, given ? { messageID: given } : undefined)
        }
        return []
      }
      case "message_update":
        if (event.message.role !== "assistant") return []
        return projection.applyStreamEvent(event.assistantMessageEvent, event.message)
      case "message_end": {
        const message = event.message
        if (message.role === "assistant") {
          // 在这里判"要不要重试",因为 agent_end 到达时已经来不及压住 idle 了
          // (事件是同步派发的,而 prompt() 的 promise 要等到之后才 resolve)。
          entry.retryPending = shouldAutoRetry(message, entry.harness?.getModel().contextWindow, entry.retryAttempt ?? 0)
          return projection.finalizeAssistant(message)
        }
        if (message.role === "user") return []
        return projection.applyMessage(message)
      }
      case "tool_execution_start":
        return projection.markToolRunning(event.toolCallId)
      case "turn_start":
        return this.setStatus(entry, { type: "busy" })
      case "turn_end":
      case "settled":
      case "agent_end":
        // 要重试就压住 idle:整段重试(含 2s/4s/8s 退避)必须是一个连续的 busy,
        // 否则退避窗口里会出现一个"看起来跑完了"的会话 —— bench 会当真去回填结果,
        // 而 agent 正要重试,两边同时动板子。压缩也一并推迟到重试真正结束之后。
        if (entry.retryPending) return []
        // 一轮结束后按阈值自动压缩。内核不做这件事,不补就是聊长了直接撞上下文窗口。
        void this.maybeAutoCompact(entry)
        return this.setStatus(entry, { type: "idle" })
      case "session_compact":
        return this.setStatus(entry, { type: "idle" })
      case "save_point":
        entry.updatedAt = Date.now()
        return [{ type: "session.updated", session: toView(entry) }]
      default:
        return []
    }
  }

  /**
   * 一轮结束后按阈值自动压缩。
   *
   * 任何失败都只发一条 kernel.error,**绝不让这一轮失败** —— 压缩是善后动作,
   * 它挂了不该把用户已经拿到的回答一起废掉。
   */
  private async maybeAutoCompact(entry: Entry): Promise<void> {
    if (!entry.harness || !entry.session || entry.compacting) return
    // 只有真的压过才需要把状态收回 idle。以前的写法在 finally 里无条件发 idle,
    // 而一轮结束会连着来 turn_end / settled / agent_end 三个事件 —— 于是每轮多发三条
    // 完全相同的 idle。UI 端幂等看不出来,但它把"状态序列"这条最有用的诊断信号冲掉了
    // (查重试为什么不生效时,满屏 idle 让人以为是抑制没起作用)。
    let compactionStarted = false
    try {
      const model = entry.harness.getModel()
      const context = await entry.session.buildContext()
      const compactions = await entry.session.getStorage().findEntries("compaction")
      const last = compactions[compactions.length - 1]
      const decision = shouldAutoCompact(
        context.messages as AgentMessage[],
        model.contextWindow,
        last ? new Date(last.timestamp).getTime() : undefined,
      )
      if (!decision.compact) return

      entry.compacting = true
      compactionStarted = true
      entry.status = { type: "compacting" }
      this.options.emit([{ type: "session.status", sessionID: entry.id, status: entry.status }])
      await entry.harness.compact()
    } catch (error) {
      this.options.emit([
        {
          type: "kernel.error",
          sessionID: entry.id,
          message: `自动压缩失败:${(error as Error)?.message ?? String(error)}`,
        },
      ])
    } finally {
      if (compactionStarted) {
        entry.compacting = false
        entry.status = { type: "idle" }
        this.options.emit([{ type: "session.status", sessionID: entry.id, status: { type: "idle" } }])
      }
    }
  }

  private setStatus(entry: Entry, status: SessionStatus): KernelEvent[] {
    if (entry.status.type === status.type) return []
    entry.status = status
    return [{ type: "session.status", sessionID: entry.id, status }]
  }

  // -------------------------------------------------------------------------
  // 一轮对话
  // -------------------------------------------------------------------------

  async prompt(sessionID: string, input: PromptInput): Promise<{ messageID: string }> {
    const entry = await this.ensureOpen(sessionID)
    const harness = entry.harness!

    // harness 不排队:忙的时候 prompt() 同步抛 busy。先中断,再等真的回到 idle。
    if (entry.status.type !== "idle") {
      await harness.abort()
      await harness.waitForIdle()
    }

    const messageID = input.messageID ?? Identifier.ascending("message")
    entry.pendingUserID = messageID
    entry.aborter = new AbortController()
    entry.retryAttempt = 0
    entry.retryPending = false

    const images = (input.files ?? [])
      .filter((file) => file.mime.startsWith("image/"))
      .map((file) => ({
        type: "image" as const,
        data: file.url.replace(/^data:[^;]+;base64,/, ""),
        mimeType: file.mime,
      }))

    // harness.prompt 只收 images,别的附件送不进模型。曾经的事故形态:UI 把 PDF 显示
    // 成附件、这里静默丢掉,两边都不吭声,用户以为模型看过了。UI 侧已按能力分流
    // (app 的 attachments:有本机路径的 PDF/文本转 @ 提及,无路径的 PDF 拒收),
    // 这里是防回归的哨兵 —— 只盯
    // data: URL 的内容型附件;file:// 的提及件路径已在正文里、agent 自己会去读,
    // 丢掉 part 是预期行为,不该报。
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

    // 不 await:一轮可能跑几分钟,请求必须立刻返回,结果全部走事件流。
    harness
      .prompt(input.text, images.length ? { images } : undefined)
      // 失败也是数据(stopReason:"error" 的 assistant 消息),所以自动重试挂在
      // resolve 路径上,不是 catch 里。
      .then((message) => this.maybeAutoRetry(entry, message))
      .catch((error: unknown) => {
        entry.retryPending = false
        this.options.emit([
          { type: "kernel.error", sessionID, message: (error as Error)?.message ?? String(error) },
          { type: "session.status", sessionID, status: { type: "idle" } },
        ])
        entry.status = { type: "idle" }
      })

    return { messageID }
  }

  /**
   * 一轮以可重试的错误收场时自动再试。
   *
   * 内核对 provider 失败**永不抛异常**,所以判断点在 resolve 路径上。整段重试是一个
   * 连续的 busy:失败那一轮的 idle 已经被 project() 压住(entry.retryPending),
   * 这里负责在真正结束时把它补上,并把推迟掉的自动压缩跑起来。
   *
   * 用户中途 abort 就停:刚按了停止,不该紧接着又发起一次模型调用。
   */
  private async maybeAutoRetry(entry: Entry, lastMessage: AssistantMessage): Promise<void> {
    const signal = entry.aborter?.signal
    let message = lastMessage
    try {
      while (entry.retryPending && !signal?.aborted) {
        const attempt = (entry.retryAttempt ?? 0) + 1
        entry.retryAttempt = attempt
        await retrySleep(retryDelayMs(attempt), signal)
        if (signal?.aborted) return
        try {
          message = await entry.harness!.retryLastTurn()
        } catch (error) {
          this.options.emit([
            {
              type: "kernel.error",
              sessionID: entry.id,
              message: `自动重试失败:${(error as Error)?.message ?? String(error)}`,
            },
          ])
          return
        }
        // retryLastTurn 的事件同样流经 project(),retryPending 由那里重新裁决:
        // 还能重试就继续转,不能了就落到下面的收尾。
        void message
      }
    } finally {
      const attempted = (entry.retryAttempt ?? 0) > 0
      const stillPending = entry.retryPending === true
      entry.retryPending = false
      // 只在"确实压过 idle"时补收尾:要么中途放弃(abort/重试失败)时它还挂着,
      // 要么重试成功过 —— 成功路径上最后那一轮的 turn_end 已经把 idle 发过了,
      // 所以只有 stillPending 才需要这里补,否则会多发一条。
      if (stillPending || (attempted && entry.status.type !== "idle")) {
        void this.maybeAutoCompact(entry)
        entry.status = { type: "idle" }
        this.options.emit([{ type: "session.status", sessionID: entry.id, status: { type: "idle" } }])
      }
    }
  }

  async abort(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry?.harness) return
    entry.aborter?.abort()
    await entry.harness.abort()
    await entry.harness.waitForIdle()
    entry.status = { type: "idle" }
    this.options.emit([{ type: "session.status", sessionID, status: { type: "idle" } }])
  }

  async compact(sessionID: string): Promise<void> {
    const entry = await this.ensureOpen(sessionID)
    entry.status = { type: "compacting" }
    this.options.emit([{ type: "session.status", sessionID, status: { type: "compacting" } }])
    try {
      await entry.harness!.compact()
    } finally {
      entry.status = { type: "idle" }
      this.options.emit([{ type: "session.status", sessionID, status: { type: "idle" } }])
    }
  }

  /**
   * 顶替 opencode 的 revert。
   *
   * yoma 只能把会话树的 leaf 挪回某条消息,**不还原文件**。所以这不是"回滚",
   * 是"改上一条重发" —— UI 上绝不能叫回滚,否则在 agent 改过固件源码之后,
   * 用户会以为文件也回去了。
   */
  async navigate(sessionID: string, messageID: string): Promise<{ editorText: string }> {
    const entry = await this.ensureOpen(sessionID)
    const result = await entry.harness!.navigateTree(messageID)
    const editorText = (result as { editorText?: string })?.editorText ?? ""
    // 树变了,整条 transcript 要重取。
    this.options.emit([{ type: "session.updated", session: toView(entry) }])
    return { editorText }
  }

  async messages(sessionID: string) {
    const entry = await this.ensureOpen(sessionID)
    return { items: entry.projection!.snapshot() }
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 淘汰空闲最久的 harness。只丢内存态,不丢磁盘,重开很便宜。 */
  private evictIdle(): void {
    const live = [...this.entries.values()].filter((e) => e.harness && e.status.type === "idle")
    if (live.length <= MAX_LIVE_SESSIONS) return
    live.sort((a, b) => a.touched - b.touched)
    for (const entry of live.slice(0, live.length - MAX_LIVE_SESSIONS)) void this.dispose(entry)
  }

  private async dispose(entry: Entry): Promise<void> {
    entry.unsubscribe?.()
    entry.unsubscribe = undefined
    if (entry.harness) await entry.harness.abort().catch(() => {})
    entry.harness = undefined
    entry.projection = undefined
    entry.session = undefined
  }

  async disposeAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.dispose(entry)
  }
}

// ---------------------------------------------------------------------------

interface Entry {
  /** renderer 乐观插入用户消息时铸的 id,等 message_start 到达时复用。 */
  pendingUserID?: string
}

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

function toMillis(value: string | number | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

