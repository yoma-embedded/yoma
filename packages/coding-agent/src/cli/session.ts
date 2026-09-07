import { open, realpath, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { clampThinkingLevel, type AssistantMessage } from "@earendil-works/pi-ai"
import { AgentHarness, JsonlSessionRepo, type AgentHarnessEvent, type ThinkingLevel } from "@yoma/agent"
import { NodeExecutionEnv } from "@yoma/agent/node"
import { resolveModel } from "../acp/models.ts"
import { discoverSkills, loadContextFiles } from "../core/resources.ts"
import { buildSystemPrompt, collectToolPromptData } from "../core/system-prompt.ts"
// 不经过包根的聚合出口：不加载 ACP 适配器、USB 或硬件工具。
import { createBashToolDefinition } from "../core/tools/bash.ts"
import { createEditToolDefinition } from "../core/tools/edit.ts"
import { createReadToolDefinition } from "../core/tools/read.ts"
import { createWriteToolDefinition } from "../core/tools/write.ts"
import { wrapToolDefinitions } from "../core/tools/types.ts"
import { modelIdentity, thinkingLevel } from "./args.ts"

export interface CliSessionOptions {
  cwd?: string
  configDir?: string
  sessionsRoot?: string
  resume?: string
  model?: string
  thinking?: ThinkingLevel
}

export interface CliSessionDependencies {
  resolveModels?: typeof resolveModel
  /** 测试隔离 ~/.agents/skills；不通过修改 HOME 冒充隔离。 */
  homeDir?: string
  onEvent?: (event: AgentHarnessEvent) => void
  onDiagnostic?: (message: string) => void
}

export type CliOutcome = { status: "completed" | "aborted" | "failed"; error?: string }

/** 当前存储没有跨进程写互斥。只锁 CLI 会话文件，不是工具权限门或探针锁。 */
async function lockSession(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.cli-lock`
  const handle = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
    throw new Error(
      `会话正被另一个 CLI 使用，或上次异常退出留下了锁：${lockPath}\n` +
        "请先关闭另一 CLI；若确认没有进程使用此会话，再手动删除该锁文件。",
    )
  })
  try {
    await handle.writeFile(`pid=${process.pid}\n`)
  } catch (error) {
    await handle.close()
    await unlink(lockPath)
    throw error
  }
  return async () => {
    await handle.close()
    await unlink(lockPath)
  }
}

/** 只做现有 Harness 的装配与生命周期适配，不实现另一套 agent 循环。 */
export async function openCliSession(options: CliSessionOptions = {}, dependencies: CliSessionDependencies = {}) {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()))
  if (!(await stat(cwd)).isDirectory()) throw new Error(`工程目录不是目录：${cwd}`)
  const configDir = resolve(options.configDir ?? join(homedir(), ".yoma"))
  const sessionsRoot = resolve(options.sessionsRoot ?? join(configDir, "cli", "sessions"))
  const env = new NodeExecutionEnv({ cwd })
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot })
  let unlock: (() => Promise<void>) | undefined
  try {
    // 再核 cwd，避免仓库的 cwd 文件名编码碰撞导致跨工程恢复。
    const candidates = options.resume ? (await repo.list({ cwd })).filter((meta) => meta.cwd === cwd) : []
    const sorted = await Promise.all(candidates.map(async (meta) => ({ meta, mtime: (await stat(meta.path)).mtimeMs })))
    sorted.sort(
      (a, b) =>
        b.mtime - a.mtime || b.meta.createdAt.localeCompare(a.meta.createdAt) || b.meta.id.localeCompare(a.meta.id),
    )
    const matches =
      options.resume === "latest"
        ? sorted.slice(0, 1)
        : sorted.filter(({ meta }) => meta.id === options.resume || meta.id.startsWith(options.resume!))
    if (options.resume && matches.length !== 1) {
      throw new Error(matches.length > 1 ? "会话 ID 前缀不唯一，请使用完整 ID" : `该工程没有匹配的 CLI 会话：${cwd}`)
    }
    const metadata = matches[0]?.meta
    if (metadata) unlock = await lockSession(metadata.path)
    const restored = metadata ? await repo.open(metadata) : undefined
    const context = await restored?.buildContext()
    const selection = options.model ? modelIdentity(options.model) : (context?.model ?? undefined)
    const { models, model } = await (dependencies.resolveModels ?? resolveModel)(configDir, selection)
    const thinking = clampThinkingLevel(
      model,
      options.thinking ?? (context ? thinkingLevel(context.thinkingLevel) : "max"),
    )
    const [contextFiles, discovered] = await Promise.all([
      loadContextFiles(env, { cwd, globalDir: configDir }),
      discoverSkills(env, { cwd, globalDir: configDir, homeDir: dependencies.homeDir }),
    ])
    for (const diagnostic of discovered.diagnostics) {
      dependencies.onDiagnostic?.(`技能 ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
    }
    const session = restored ?? (await repo.create({ cwd }))
    const meta = await session.getMetadata()
    unlock ??= await lockSession(meta.path)
    const definitions = [
      createReadToolDefinition(env),
      createBashToolDefinition(env),
      createEditToolDefinition(env),
      createWriteToolDefinition(env),
    ]
    const harness = new AgentHarness({
      env,
      session,
      models,
      model,
      thinkingLevel: thinking,
      tools: wrapToolDefinitions(definitions),
      resources: { skills: discovered.skills },
      systemPrompt: buildSystemPrompt({
        cwd,
        ...collectToolPromptData(definitions),
        contextFiles,
        skills: discovered.skills,
      }),
    })
    // 构造函数不会保存初始配置；必须落树，否则第一次恢复会悄悄掉回 off。
    if (!context || context.model?.provider !== model.provider || context.model.modelId !== model.id) {
      await harness.setModel(model)
    }
    if (!context || context.thinkingLevel !== thinking) await harness.setThinkingLevel(thinking)
    if (!context || context.activeToolNames?.join(",") !== definitions.map((tool) => tool.name).join(",")) {
      await harness.setActiveTools(definitions.map((tool) => tool.name))
    }
    const unsubscribe = harness.subscribe((event) => dependencies.onEvent?.(event))
    let active: Promise<CliOutcome> | undefined
    let cancelled = false
    let closed = false
    let closing: Promise<void> | undefined
    // 当前 Harness 在异步准备结束后才装 runAbortController。
    // 若用户在这个窗口停止，阻止下一次请求，而不是让“停止”后才开始调用模型。
    harness.on("before_provider_request", () => {
      if (cancelled || closed) throw new Error("本轮已取消")
      return undefined
    })

    function assertIdle() {
      if (closed) throw new Error("CLI 会话已关闭")
      if (active) throw new Error("正在执行；请先 /abort，或等待本轮结束")
    }
    function run(action: () => Promise<AssistantMessage | void>): Promise<CliOutcome> {
      assertIdle()
      cancelled = false
      const task = (async (): Promise<CliOutcome> => {
        try {
          const response = await action()
          if (cancelled || response?.stopReason === "aborted") return { status: "aborted" }
          if (response?.stopReason === "error")
            return { status: "failed", error: response.errorMessage ?? "模型请求失败" }
          return { status: "completed" }
        } catch (error) {
          if (cancelled) return { status: "aborted" }
          throw error
        }
      })()
      active = task.finally(() => {
        active = undefined
      })
      return active
    }
    async function abort(): Promise<void> {
      if (!active) return
      cancelled = true
      const running = active
      await harness.abort()
      await running
    }
    return {
      metadata: meta,
      get busy() {
        return active !== undefined
      },
      status() {
        const current = harness.getModel()
        return `工程：${cwd}\n模型：${current.provider}/${current.id}\n思考：${harness.getThinkingLevel()}\n工具：read, bash, edit, write\n会话：${meta.id}\n文件：${meta.path}`
      },
      messages: async () => (await session.buildContext()).messages,
      models: () => models.getModels().map((item) => `${item.provider}/${item.id}`),
      prompt: (text: string) => run(() => harness.prompt(text)),
      retry: () => run(() => harness.retryLastTurn()),
      compact: (instructions?: string) =>
        run(async () => {
          await harness.compact(instructions)
        }),
      setModel: (name: string) =>
        run(async () => {
          const identity = modelIdentity(name)
          const next = models.getModel(identity.provider, identity.modelId)
          if (!next) throw new Error(`模型不可用：${name}；用 /models 查看已配置模型`)
          await harness.setModel(next)
          await harness.setThinkingLevel(clampThinkingLevel(next, harness.getThinkingLevel()))
        }),
      setThinking: (value: string) =>
        run(async () => {
          await harness.setThinkingLevel(clampThinkingLevel(harness.getModel(), thinkingLevel(value)))
        }),
      abort,
      close(): Promise<void> {
        if (closing) return closing
        closed = true
        closing = (async () => {
          try {
            await abort()
          } finally {
            unsubscribe()
            try {
              await env.cleanup()
            } finally {
              await unlock!()
            }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    try {
      await env.cleanup()
    } finally {
      await unlock?.()
    }
    throw error
  }
}

export type CliSession = Awaited<ReturnType<typeof openCliSession>>
