/**
 * 会话管理:一个 sessionID ↔ 一个 AgentHarness ↔ 一个投影器。
 *
 * ## 为什么整个 app 只能有一个内核进程
 *
 * my-pi 的 probe 租约(claimProbe/releaseProbe)、gdb session 表、log capture 都是
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

import { AgentHarness, JsonlSessionRepo, type AgentMessage, type Session as PiSession } from "@yoma/my-pi"
import type { AgentHarnessEvent, JsonlSessionMetadata } from "@yoma/my-pi"
import { NodeExecutionEnv } from "@yoma/my-pi/node"
import {
  createCodingToolDefinitions,
  createEmbeddedToolDefinitions,
  wrapToolDefinitions,
} from "@yoma/my-pi-coding-agent"
import { buildSystemPrompt, collectToolPromptData } from "@yoma/my-pi-coding-agent/system-prompt"
import { resolveModel } from "@yoma/my-pi-coding-agent/models"
import { clampThinkingLevel, getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai"

import type { KernelEvent, PromptInput } from "../protocol.ts"
import type {
  PermissionRequest,
  PermissionRules,
  ProviderInfo,
  Session as ViewSession,
  SessionStatus,
} from "../types.ts"
import { Identifier } from "../ids.ts"
import { sessionNotFound } from "../types.ts"
import { SessionProjection } from "./projector.ts"
import { PermissionGate } from "./permission.ts"
import { shouldAutoCompact } from "./compaction.ts"
import { CONFIGURABLE_PROVIDERS, removeAuthKey, writeAuthKey } from "./auth.ts"

/** 同时活着的 harness 上限。淘汰只是丢弃内存态,重开就是 repo.open + buildContext,很便宜。 */
const MAX_LIVE_SESSIONS = 8

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
}

export interface SessionManagerOptions {
  sessionsRoot: string
  enginesDir?: string
  emit(events: KernelEvent[]): void
  permissionRules?: PermissionRules
  /**
   * 模型目录的来源。默认复用 my-pi 的 resolveModel()(读 ~/.pi/agent/auth.json)。
   * 可注入是为了两件事:测试用 pi-ai 的 faux provider 跑完整一轮而不需要网络和 key;
   * 以及 P6 换成我们自己的凭据管理(Electron safeStorage)时不用改这里。
   */
  resolveModels?: () => Promise<{ models: Models; model: Model<string> }>
}

export class SessionManager {
  private readonly env: NodeExecutionEnv
  private readonly repo: JsonlSessionRepo
  private readonly entries = new Map<string, Entry>()
  private readonly options: SessionManagerOptions
  readonly permissions: PermissionGate

  private models?: Models
  private defaultModel?: Model<string>
  private modelError?: string

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.env = new NodeExecutionEnv({ cwd: process.cwd() })
    this.repo = new JsonlSessionRepo({ fs: this.env, sessionsRoot: options.sessionsRoot })
    this.permissions = new PermissionGate({
      rules: options.permissionRules,
      emit: (event) => options.emit([event]),
    })
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  /**
   * 延迟解析模型目录。
   *
   * 复用 my-pi 自己的 resolveModel() —— 它读 ~/.pi/agent/auth.json,也就是用户配 pi/Zed
   * 时已经填好的凭据,于是桌面端零配置就能开跑。**不在构造时解析**:没有 key 时它会抛,
   * 那不该让整个内核进程起不来 —— 前端还得能显示会话列表并引导去配置。
   */
  private async ensureModels(): Promise<{ models: Models; model: Model<string> }> {
    if (this.models && this.defaultModel) return { models: this.models, model: this.defaultModel }
    try {
      const resolved = this.options.resolveModels
        ? await this.options.resolveModels()
        : ((await resolveModel()) as { models: Models; model: Model<string> })
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
   * 写入一个 provider 的 API key(落到 my-pi 读的那份 ~/.pi/agent/auth.json)。
   *
   * 写完必须丢弃已解析的模型目录:resolveModel() 只注册写入当时有 key 的 provider,
   * 不重解析的话新 key 要等重启进程才生效。注意 **已经开着的会话拿的还是旧注册表**
   * (AgentHarness.models 是 readonly,建好之后换不掉),新开/重开的会话才能用新 provider ——
   * 首跑场景(一个会话都没有)不受影响。
   *
   * key 本身不做网络验证:my-pi 注册 provider 时不发请求,错 key 的暴露点是第一次
   * prompt 的 API 401,那条错误会走正常的会话错误通道显示出来。
   */
  async setAuth(providerID: string, apiKey: string): Promise<ProviderInfo[]> {
    const trimmed = apiKey.trim()
    if (!trimmed) throw new Error("API key 不能为空")
    if (!CONFIGURABLE_PROVIDERS.some((spec) => spec.id === providerID))
      throw new Error(
        `未知 provider ${providerID}。可配置:${CONFIGURABLE_PROVIDERS.map((spec) => spec.id).join(", ")}`,
      )
    writeAuthKey(providerID, trimmed)
    this.invalidateModels()
    return this.providers()
  }

  /** 移除一个 provider 的 key。同样丢弃模型目录缓存。 */
  async removeAuth(providerID: string): Promise<ProviderInfo[]> {
    removeAuthKey(providerID)
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
    if (thinking) {
      // 钳一下:模型不支持的档位直接设进去会等到发请求时才炸。
      await entry.harness!.setThinkingLevel(clampThinkingLevel(model, thinking as never))
    }
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

    const { models, model } = await this.ensureModels()
    const session = entry.session ?? (await this.repo.open(entry.meta))
    entry.session = session
    entry.title = (await session.getSessionName()) ?? entry.title

    const env = new NodeExecutionEnv({ cwd: entry.cwd })
    const engineOptions = this.options.enginesDir
      ? ({
          netlist: { enginesDir: this.options.enginesDir },
          stm32config: { enginesDir: this.options.enginesDir },
          flash: { enginesDir: this.options.enginesDir },
          log: { enginesDir: this.options.enginesDir },
          gdb: { enginesDir: this.options.enginesDir },
        } as never)
      : undefined

    // 工具定义必须过 wrapToolDefinitions 才能交给 harness;系统提示词由工具集反推
    // (collectToolPromptData 会把每个工具的使用指导拼进去)。这两步照抄 my-pi 自己的
    // ACP 适配器 acp/agent.ts:351-359 —— 系统提示词编码了嵌入式工具的用法,自己重写
    // 等于产品行为分叉。
    const toolDefinitions = [
      ...createCodingToolDefinitions(env),
      ...createEmbeddedToolDefinitions(env, engineOptions),
    ]
    const harness = new AgentHarness({
      env,
      session,
      models,
      model,
      tools: wrapToolDefinitions(toolDefinitions),
      systemPrompt: buildSystemPrompt({ cwd: entry.cwd, ...collectToolPromptData(toolDefinitions) }),
    })
    entry.harness = harness

    const projection = new SessionProjection({
      sessionID: entry.id,
      providerID: model.provider,
      modelID: model.id,
    })
    entry.projection = projection

    // 权限门。tool_call 是 emitHook,是 harness 上少数几个真的会触发的 on() 之一;
    // 返回 {block:true} 就能拦下 flash download / gdb / bash。
    this.permissions.attach(harness, entry.id, () => projection.snapshot().at(-1)?.info.id ?? "")

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
        if (message.role === "assistant") return projection.finalizeAssistant(message)
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
      entry.compacting = false
      entry.status = { type: "idle" }
      this.options.emit([{ type: "session.status", sessionID: entry.id, status: { type: "idle" } }])
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

    const images = (input.files ?? [])
      .filter((file) => file.mime.startsWith("image/"))
      .map((file) => ({
        type: "image" as const,
        data: file.url.replace(/^data:[^;]+;base64,/, ""),
        mimeType: file.mime,
      }))

    // 不 await:一轮可能跑几分钟,请求必须立刻返回,结果全部走事件流。
    harness
      .prompt(input.text, images.length ? { images } : undefined)
      .catch((error: unknown) => {
        this.options.emit([
          { type: "kernel.error", sessionID, message: (error as Error)?.message ?? String(error) },
          { type: "session.status", sessionID, status: { type: "idle" } },
        ])
        entry.status = { type: "idle" }
      })

    return { messageID }
  }

  async abort(sessionID: string): Promise<void> {
    const entry = this.entries.get(sessionID)
    if (!entry?.harness) return
    entry.aborter?.abort()
    await entry.harness.abort()
    await entry.harness.waitForIdle()
    this.permissions.rejectAllFor(sessionID, "会话已中断")
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
   * my-pi 只能把会话树的 leaf 挪回某条消息,**不还原文件**。所以这不是"回滚",
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
    if (entry.harness) {
      await entry.harness.abort().catch(() => {})
      this.permissions.detach(entry.id)
    }
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

export type { PermissionRequest }
