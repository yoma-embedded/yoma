/**
 * 子 agent 的宿主场景(docs/子agent-设计方案-v0.4-20260918.md §12 P2 的 (a)–(q),(o) 暂缓;(r)–(u) 是变异验证后补的;
 * (v) 懒打开补会话名是 P3 撞出来的;(w) 是"缺省后台"那次产品决定)。
 *
 * **缺省后台之后**(用户 2026-09-20 定):测前台语义的场景都显式写 `run_in_background: false` —— 不写就是后台,
 * 那些"结果回到工具调用"的断言会全部落空。
 *
 * 走完整的 SessionManager:主会话、子会话、TaskManager、通知投递、排队、确认冒泡都是真的,只有模型是 faux。
 * 所有会话共用一份 faux(SessionManager 只解析一次模型目录),所以每一步都交给同一个"路由"工厂:按这次请求里
 * **第一条 user 消息**分发到各自的脚本 —— 主会话是用户发的第一句,子会话是任务书(prompt)。并行的子 agent
 * 因此不会串到别人的脚本里,各自的请求上下文也都留了底(script.contexts)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, test } from "vitest"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext as LlmContext,
  type FauxResponseFactory,
  type FauxResponseStep,
  type Model,
} from "@earendil-works/pi-ai"
import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo, createCustomMessage } from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import type { Trace } from "./trace/sink.ts"
import type { KernelEvent } from "../protocol.ts"
import type { Session, ToolPart } from "../types.ts"
import { patient } from "../../test/patience.ts"

const ctx = BACKGROUND_CONTEXT
/** 这些用例要等好几个会话互相放行;真卡住是死锁,不是慢。 */
const SLOW = 30_000

beforeAll(() => {
  // 同 host.test.ts:真 ~/.yoma/probe.lock 归用户。
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const cleanups: Array<() => Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  // 先关会话(连带 JSONL 句柄),再删目录 —— Windows 上开着的文件删不掉。
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 10_000, what = "条件"): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(timeoutMs)) throw new Error(`等待超时:${what}`)
    await sleep(10)
  }
}

/** 一直挂到中止信号来(真模型的流也是这样被掐断的)。 */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

/**
 * 等测试放行;中途被中止就提前放手。只等放行的话,用例一旦失败,收尾(disposeAll 会中止在跑的子 agent)就挂在
 * 这个永远不来的放行上,整个文件卡到 hook 超时 —— 变异验证时每条这样的失败都白等了四分钟。
 */
function hold(release: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  return Promise.race([release.then(() => undefined), untilAborted(signal)])
}

/** n 个参与者都到了才一起放行;到不齐说明它们不是并行的。 */
function barrier(n: number, timeoutMs = 5000) {
  let arrived = 0
  const all = deferred()
  return {
    arrive(): Promise<void> {
      if (++arrived === n) all.resolve()
      return Promise.race([
        all.promise,
        sleep(patient(timeoutMs)).then(() => {
          throw new Error(`只到了 ${arrived}/${n} 个:没有并行`)
        }),
      ])
    },
  }
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((block: { type: string; text?: string }) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n")
}

const text = (value: string) => fauxAssistantMessage([fauxText(value)])

/** 只收 `stop.request` 的轨迹(调试留痕:事后要分得出是谁停的 —— 界面、主 agent 的 task_stop,还是父中止)。 */
function stopTrace(): { trace: Trace; stops: Array<Record<string, unknown>> } {
  const stops: Array<Record<string, unknown>> = []
  const trace: Trace = {
    enabled: true,
    write: (ev, fields) => {
      if (ev === "stop.request") stops.push({ ...fields })
    },
    flush: async () => {},
    close: async () => {},
  }
  return { trace, stops }
}

/** 父这一轮里 agent 工具交回的 agentId(后台派出与前台结果的尾巴里都有)。 */
function agentIdIn(context: LlmContext, nth = 0): string {
  const ids = context.messages.flatMap((message) =>
    message.role === "toolResult" ? [...textOf(message).matchAll(/agentId: ([^\s(]+)/g)].map((match) => match[1]!) : [],
  )
  const id = ids[nth]
  if (!id) throw new Error("上下文里没有 agentId")
  return id
}

function notificationsIn(context: LlmContext, taskID?: string): string[] {
  return context.messages.flatMap((message) => {
    const body = textOf(message)
    if (message.role !== "user" || !body.startsWith("<task-notification>")) return []
    return taskID === undefined || body.includes(`<task-id>${taskID}</task-id>`) ? [body] : []
  })
}

/**
 * 按"第一条 user 消息"分发的脚本。路由表里某条脚本用完了还被请求,回一句显眼的话 ——
 * 断言会在那句话上失败,而不是等到超时。
 */
class Script {
  private readonly routes = new Map<string, FauxResponseStep[]>()
  readonly contexts = new Map<string, LlmContext[]>()

  route(key: string, ...steps: FauxResponseStep[]): void {
    this.routes.set(key, [...(this.routes.get(key) ?? []), ...steps])
  }

  count(key: string): number {
    return this.contexts.get(key)?.length ?? 0
  }

  last(key: string): LlmContext {
    const list = this.contexts.get(key)
    if (!list?.length) throw new Error(`路由 ${key} 还没被请求过`)
    return list.at(-1)!
  }

  readonly step: FauxResponseFactory = (context, options, state, model) => {
    const first = context.messages.find((message) => message.role === "user")
    const key = textOf(first)
    const seen = this.contexts.get(key) ?? []
    // 留一份快照:上下文数组之后还会被发动机接着用。
    seen.push({ ...context, messages: [...context.messages] })
    this.contexts.set(key, seen)
    const next = this.routes.get(key)?.shift()
    if (!next) return text(`(脚本 ${JSON.stringify(key.slice(0, 40))} 已用完)`)
    return typeof next === "function" ? next(context, options, state, model) : (next as AssistantMessage)
  }
}

let providerCount = 0

function setup(subagents: SessionManagerOptions["subagents"] = {}, extra: Partial<SessionManagerOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-sub-"))
  roots.push(root)
  const workspace = path.join(root, "ws")
  mkdirSync(workspace)
  const script = new Script()
  const faux = fauxProvider({ provider: `sub-${++providerCount}`, models: [{ id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 2000 }, () => script.step))
  const model = faux.getModel() as Model<string>
  const events: KernelEvent[] = []
  const sessionsRoot = path.join(root, "sessions")
  const open = () => {
    const manager = new SessionManager({
      sessionsRoot,
      configDir: path.join(root, "config"),
      emit: (batch) => events.push(...batch),
      resolveModels: async () => ({ models, model }),
      // 本机有没有 CubeMX 不该改变子 agent 的工具清单。
      inspectStm32Availability: async () => ({ available: false, reason: "test" }),
      // 祖先链止于 root:只认 <ws>/.yoma/agents,不会走到开发机真实的目录。
      subagents: { outputRoot: path.join(root, "tasks"), homeDir: root, ...subagents },
      ...extra,
    })
    cleanups.push(() => manager.disposeAll())
    return manager
  }
  return { manager: open(), reopen: open, events, script, workspace, sessionsRoot, models, model }
}

function childrenOf(events: KernelEvent[], parentID: string): Session[] {
  return events.flatMap((event) =>
    event.type === "session.created" && event.session.parentID === parentID ? [event.session] : [],
  )
}

async function toolCards(manager: SessionManager, sessionID: string, tool: string): Promise<ToolPart[]> {
  const page = await manager.messages(sessionID)
  return page.items.flatMap((item) => item.parts).filter((part): part is ToolPart => part.type === "tool" && part.tool === tool)
}

const idle = (manager: SessionManager, sessionID: string) => manager.status(sessionID).type === "idle"

describe("子 agent 宿主(P2)", () => {
  test(
    "(a) 一条消息派 3 个 Explore:真的并行,各自一个带 parentID 的子会话,结果按调用顺序回到父的下一次请求",
    async () => {
      const { manager, events, script, workspace } = setup()
      const together = barrier(3)
      const answers: Array<[string, string]> = [
        ["查时钟树", "时钟:HSE 8 MHz → PLL 168 MHz"],
        ["查 DMA", "DMA:DMA2 Stream7 → USART1_TX"],
        ["查中断", "中断:EXTI0 优先级 5"],
      ]
      for (const [prompt, answer] of answers) {
        script.route(prompt, async () => {
          await together.arrive()
          return text(answer)
        })
      }
      script.route(
        "派三个",
        fauxAssistantMessage(
          answers.map(([prompt]) => fauxToolCall("agent", { description: prompt, prompt, subagent_type: "Explore", run_in_background: false })),
        ),
        text("三路结果都齐了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派三个" })
      await waitFor(() => script.count("派三个") === 2 && idle(manager, parent.id), 15_000, "父收工")

      const children = childrenOf(events, parent.id)
      expect(children).toHaveLength(3)
      expect(children.every((child) => child.agent === "Explore")).toBe(true)
      // Explore 是一次性 agent:结果不带 agentId / usage 尾巴(CC ONE_SHOT_BUILTIN_AGENT_TYPES)。
      const results = script.last("派三个").messages.filter((message) => message.role === "toolResult")
      expect(results.map(textOf)).toEqual(answers.map(([, answer]) => answer))
      expect(manager.tasks(parent.id).map((task) => task.status)).toEqual(["completed", "completed", "completed"])
      expect((await toolCards(manager, parent.id, "agent")).map((card) => card.state.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ])
      expect(events.filter((event) => event.type === "kernel.error")).toEqual([])
    },
    SLOW,
  )

  test(
    "(b) run_in_background:父这一轮先收工;子完成后通知进父的收件箱,父被叫醒起新一轮,模型那边是 user 角色",
    async () => {
      const { manager, script, workspace } = setup()
      const release = deferred()
      script.route("后台查手册", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("SPI1 时钟上限 42 MHz(RM0090 28.3 节)")
      })
      script.route(
        "派后台",
        fauxAssistantMessage([fauxToolCall("agent", { description: "查手册", prompt: "后台查手册", run_in_background: true })]),
        text("已经派出去了"),
        text("手册查到了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派后台" })
      await waitFor(() => script.count("派后台") === 2 && idle(manager, parent.id), 10_000, "父这一轮收工")
      expect(textOf(script.last("派后台").messages.at(-1))).toContain("Async agent launched successfully.")
      const [task] = manager.tasks(parent.id)
      expect(task).toMatchObject({ status: "running", background: true })
      // 子会话页问 task.list 拿的是它自己那条(横幅要状态;事件不重放)。
      expect(manager.tasks(task!.id).map((own) => own.id)).toEqual([task!.id])

      release.resolve()
      await waitFor(() => script.count("派后台") === 3 && idle(manager, parent.id), 10_000, "父被叫醒又收工")
      const woken = script.last("派后台").messages.at(-1)!
      expect(woken.role).toBe("user")
      const body = textOf(woken)
      expect(body).toContain(`<task-id>${task!.id}</task-id>`)
      expect(body).toContain("<status>completed</status>")
      expect(body).toContain('<summary>Agent "查手册" completed</summary>')
      expect(body).toContain("<result>SPI1 时钟上限 42 MHz(RM0090 28.3 节)</result>")
      expect(manager.tasks(parent.id)[0]!.status).toBe("completed")
    },
    SLOW,
  )

  test(
    "(c) 父正忙时后台子 agent 完成:通知在下一个工具边界插进去,父不多起一轮",
    async () => {
      const { manager, events, script, workspace } = setup()
      const release = deferred()
      script.route("后台短活", text("短活结果"))
      script.route("前台长活", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("长活结果")
      })
      script.route(
        "一起派",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "短活", prompt: "后台短活", run_in_background: true }),
          fauxToolCall("agent", { description: "长活", prompt: "前台长活", run_in_background: false }),
        ]),
        text("都知道了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "一起派" })
      // 等通知真的排进了父的收件箱(父还卡在前台那个 agent 调用上),再放行前台。
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "session.queue" &&
              event.sessionID === parent.id &&
              event.items.some((item) => item.kind === "notification"),
          ),
        10_000,
        "通知排进父的收件箱",
      )
      expect(idle(manager, parent.id)).toBe(false)
      release.resolve()
      await waitFor(() => script.count("一起派") === 2 && idle(manager, parent.id), 10_000, "父收工")
      await sleep(200)
      expect(script.count("一起派")).toBe(2)
      const messages = script.last("一起派").messages
      expect(messages.map((message) => message.role).slice(-3)).toEqual(["toolResult", "toolResult", "user"])
      expect(textOf(messages.at(-1))).toContain('<summary>Agent "短活" completed</summary>')
    },
    SLOW,
  )

  test(
    "(d) task_stop:被停的后台子 agent 发 killed 通知,带部分结果,只来一次",
    async () => {
      const { trace, stops } = stopTrace()
      const { manager, script, workspace } = setup({}, { trace })
      const blocked = deferred()
      script.route(
        "长任务",
        fauxAssistantMessage([fauxText("阶段一:PLL 配置查完了"), fauxToolCall("ls", { path: "." })]),
        async (_context, options) => {
          blocked.resolve()
          await untilAborted(options?.signal)
          return fauxAssistantMessage([])
        },
      )
      let stopResult = ""
      script.route(
        "派长任务",
        fauxAssistantMessage([fauxToolCall("agent", { description: "长任务", prompt: "长任务", run_in_background: true })]),
        text("派出去了"),
        (context) => fauxAssistantMessage([fauxToolCall("task_stop", { task_id: agentIdIn(context) })]),
        (context) => {
          // killed 通知可能正好排在这条工具结果后面进来,所以按工具名找,不取最后一条。
          stopResult = textOf(
            [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "task_stop"),
          )
          return text("停了")
        },
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派长任务" })
      await blocked.promise
      await waitFor(() => idle(manager, parent.id), 10_000, "父第一轮收工")
      const [task] = manager.tasks(parent.id)

      await manager.prompt(parent.id, { text: "停掉它" })
      await waitFor(() => manager.tasks(parent.id)[0]!.status === "killed", 10_000, "任务被停")
      await waitFor(() => idle(manager, parent.id) && script.count("派长任务") >= 4, 10_000, "父收工")
      await sleep(300)
      await waitFor(() => idle(manager, parent.id), 10_000, "通知处理完")

      expect(JSON.parse(stopResult)).toMatchObject({
        message: `Successfully stopped task: ${task!.id} (长任务)`,
        task_id: task!.id,
        task_type: "local_agent",
      })
      const final = script.last("派长任务")
      const notes = notificationsIn(final, task!.id)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("<status>killed</status>")
      expect(notes[0]).toContain('<summary>Agent "长任务" was stopped</summary>')
      expect(notes[0]).toContain("<result>阶段一:PLL 配置查完了</result>")
      // 轨迹里记着是主 agent 停的(落在子会话名下,带着父会话)
      expect(stops).toEqual([{ s: task!.id, parent: parent.id, by: "agent" }])
    },
    SLOW,
  )

  test(
    "(d2) 界面上停:停子 agent(task.stop)与停主会话(session.abort)在轨迹里各记一笔 by ui",
    async () => {
      const { trace, stops } = stopTrace()
      const { manager, script, workspace } = setup({}, { trace })
      const blocked = deferred()
      const parentHeld = deferred()
      script.route(
        "长任务",
        fauxAssistantMessage([fauxText("阶段一"), fauxToolCall("ls", { path: "." })]),
        async (_context, options) => {
          blocked.resolve()
          await untilAborted(options?.signal)
          return fauxAssistantMessage([])
        },
      )
      script.route(
        "派长任务",
        fauxAssistantMessage([fauxToolCall("agent", { description: "长任务", prompt: "长任务", run_in_background: true })]),
        text("派出去了"),
        // killed 通知叫醒的那一轮:挂住,等界面按停止
        async (_context, options) => {
          parentHeld.resolve()
          await untilAborted(options?.signal)
          return fauxAssistantMessage([])
        },
        text("收到"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派长任务" })
      await blocked.promise
      await waitFor(() => idle(manager, parent.id), 10_000, "父第一轮收工")
      const [task] = manager.tasks(parent.id)

      await manager.stopTask(task!.id)
      await waitFor(() => manager.tasks(parent.id)[0]!.status === "killed", 10_000, "任务被停")
      await parentHeld.promise
      await manager.abort(parent.id)
      await waitFor(() => idle(manager, parent.id), 10_000, "父停下")

      expect(stops).toEqual([
        { s: task!.id, parent: parent.id, by: "ui" },
        { s: parent.id, by: "ui" },
      ])
    },
    SLOW,
  )

  test(
    "(e) send_message:运行中 → 排进子的收件箱、下一次请求就看得到;已结束 → 后台续跑,完了再通知一次",
    async () => {
      const { manager, script, workspace } = setup()
      const first = deferred()
      const second = deferred()
      let childSaw = ""
      script.route(
        "查外设",
        async (_context, options) => {
          await hold(first.promise, options?.signal)
          return text("USART1 查完")
        },
        (context) => {
          childSaw = textOf(context.messages.at(-1))
          return text(`补充:${childSaw}`)
        },
        async (context, options) => {
          await hold(second.promise, options?.signal)
          return text(`续跑:${textOf(context.messages.at(-1))}`)
        },
      )
      let queuedReply = ""
      let resumedReply = ""
      script.route(
        "派查外设",
        fauxAssistantMessage([fauxToolCall("agent", { description: "查外设", prompt: "查外设", run_in_background: true })]),
        text("派了"),
        (context) => fauxAssistantMessage([fauxToolCall("send_message", { to: agentIdIn(context), message: "顺便看 DMA" })]),
        (context) => {
          queuedReply = textOf(context.messages.at(-1))
          return text("消息发了")
        },
        text("收到第一次"),
        (context) => fauxAssistantMessage([fauxToolCall("send_message", { to: agentIdIn(context), message: "再看中断" })]),
        (context) => {
          resumedReply = textOf(context.messages.at(-1))
          return text("续跑了")
        },
        text("收到第二次"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派查外设" })
      await waitFor(() => script.count("派查外设") === 2 && idle(manager, parent.id), 10_000, "派出")
      const [task] = manager.tasks(parent.id)

      await manager.prompt(parent.id, { text: "补充一句" })
      await waitFor(() => script.count("派查外设") === 4 && idle(manager, parent.id), 10_000, "消息发出")
      expect(JSON.parse(queuedReply)).toEqual({
        success: true,
        message: `Message queued for delivery to ${task!.id} at its next tool round.`,
      })

      first.resolve()
      await waitFor(() => script.count("派查外设") === 5 && idle(manager, parent.id), 10_000, "第一次通知")
      expect(childSaw).toBe("顺便看 DMA")
      expect(notificationsIn(script.last("派查外设"), task!.id).at(-1)).toContain("<result>补充:顺便看 DMA</result>")

      await manager.prompt(parent.id, { text: "再让它看" })
      await waitFor(() => script.count("派查外设") === 7 && idle(manager, parent.id), 10_000, "续跑发出")
      expect(JSON.parse(resumedReply).message).toBe(
        `Agent "${task!.id}" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task!.outputFile}`,
      )
      expect(manager.tasks(parent.id)[0]!.status).toBe("running")

      second.resolve()
      await waitFor(() => script.count("派查外设") === 8 && idle(manager, parent.id), 10_000, "第二次通知")
      const notes = notificationsIn(script.last("派查外设"), task!.id)
      expect(notes).toHaveLength(2)
      expect(notes[1]).toContain("<result>续跑:再看中断</result>")
    },
    SLOW,
  )

  test(
    "(f) maxTurns: 2:第 2 轮的工具跑完就收工,任务 completed 且记 maxTurnsReached",
    async () => {
      const { manager, script, workspace } = setup()
      mkdirSync(path.join(workspace, ".yoma", "agents"), { recursive: true })
      writeFileSync(
        path.join(workspace, ".yoma", "agents", "limited.md"),
        "---\nname: limited\ndescription: 最多两轮\nmaxTurns: 2\ntools: [ls, read]\n---\n只看目录。\n",
      )
      script.route(
        "看目录",
        fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
        fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
        text("第三轮不该来"),
      )
      script.route(
        "派有限",
        fauxAssistantMessage([fauxToolCall("agent", { description: "有限", prompt: "看目录", subagent_type: "limited", run_in_background: false })]),
        text("好"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派有限" })
      await waitFor(() => script.count("派有限") === 2 && idle(manager, parent.id), 10_000, "父收工")

      expect(script.count("看目录")).toBe(2)
      const [task] = manager.tasks(parent.id)
      expect(task).toMatchObject({ status: "completed", maxTurnsReached: true })
      const result = textOf(script.last("派有限").messages.at(-1))
      expect(result).toContain("(Subagent completed but returned no output.)")
      expect(result).toContain(`agentId: ${task!.id} (use send_message with to: '${task!.id}' to continue this agent)`)
      const [card] = await toolCards(manager, parent.id, "agent")
      expect(card!.state.status === "completed" && card!.state.metadata).toMatchObject({ maxTurnsReached: true })
    },
    SLOW,
  )

  test(
    "(g) 并发上限 2:第三个排 pending,前面有一个结束它才开跑",
    async () => {
      const { manager, script, workspace } = setup({ maxConcurrent: 2 })
      const names = ["活一", "活二", "活三"]
      const releases = new Map(names.map((name) => [name, deferred()]))
      const started: string[] = []
      for (const name of names) {
        script.route(name, async (_context, options) => {
          started.push(name)
          await hold(releases.get(name)!.promise, options?.signal)
          return text(`${name}完`)
        })
      }
      script.route(
        "派三个后台",
        fauxAssistantMessage(
          names.map((name) => fauxToolCall("agent", { description: name, prompt: name, run_in_background: true })),
        ),
        text("派了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派三个后台" })
      await waitFor(() => started.length === 2 && idle(manager, parent.id), 10_000, "两个开跑")
      await sleep(200)
      expect(started).toHaveLength(2)
      const waiting = manager.tasks(parent.id).filter((task) => task.status === "pending")
      expect(waiting).toHaveLength(1)
      expect(started).not.toContain(waiting[0]!.description)

      releases.get(started[0]!)!.resolve()
      await waitFor(() => started.length === 3, 10_000, "第三个开跑")
      expect(started[2]).toBe(waiting[0]!.description)
      for (const release of releases.values()) release.resolve()
      await waitFor(
        () => manager.tasks(parent.id).every((task) => task.status === "completed") && idle(manager, parent.id),
        10_000,
        "全部完成",
      )
    },
    SLOW,
  )

  test(
    "(h) 子会话的工具是 profile 的子集:没有硬件五件,也没有子 agent 四件;系统提示词换成 agent 正文 + Notes",
    async () => {
      const { manager, script, workspace } = setup()
      script.route("看看工具", text("ok"))
      script.route("看看只读工具", text("ok"))
      script.route(
        "派两个看工具",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "通用", prompt: "看看工具", run_in_background: false }),
          fauxToolCall("agent", { description: "只读", prompt: "看看只读工具", subagent_type: "Explore", run_in_background: false }),
        ]),
        text("好"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派两个看工具" })
      await waitFor(() => script.count("派两个看工具") === 2 && idle(manager, parent.id), 10_000, "父收工")

      const names = (context: LlmContext) => getCurrentTools(context.messages).map((tool) => tool.name)
      expect(names(script.last("派两个看工具"))).toEqual(
        expect.arrayContaining(["agent", "task_output", "task_stop", "send_message", "flash", "gdb"]),
      )
      expect(names(script.last("看看工具"))).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "powershell",
        "toolchain",
        "project",
        "datasheet",
        "netlist",
      ])
      expect(names(script.last("看看只读工具"))).toEqual(["read", "bash", "grep", "find", "ls", "powershell", "datasheet", "netlist"])

      const prompt = getCurrentSystemPrompt(script.last("看看工具").messages)
      expect(prompt.startsWith("You are an agent for Yoma")).toBe(true)
      expect(prompt).toContain("Notes:\n- Agent threads always have their cwd reset between bash calls")
      expect(prompt).not.toContain("You are Yoma, a coding and embedded-development agent.")
      expect(prompt).toContain("<env>")

      // bash 的描述(shell-guidance.ts):主会话与子 agent 都带"别在 shell 里递归扫";缺省 120 秒超时只给子 agent,
      // 参数说明跟着改 —— 上游原文写的是"没有缺省超时"。
      const bashOf = (context: LlmContext) => getCurrentTools(context.messages).find((tool) => tool.name === "bash")
      const parentBash = bashOf(script.last("派两个看工具"))
      const childBash = bashOf(script.last("看看只读工具"))
      expect(parentBash?.description).toContain("Do not run recursive file searches or listings with this tool")
      expect(parentBash?.description).toContain("use the grep, find, ls tools instead")
      expect(parentBash?.description).not.toContain("stopped after 120 seconds")
      expect(childBash?.description).toContain("Do not run recursive file searches or listings with this tool")
      expect(childBash?.description).toContain("commands without a timeout are stopped after 120 seconds")
      expect(JSON.stringify(childBash?.parameters)).toContain("Timeout in seconds (default 120 in this agent)")
    },
    SLOW,
  )

  test(
    "(i) 前台子 agent 跑到一半整个宿主关掉:父那次 agent 调用不再挂着,重开后父能接着发、子的操作已收尾",
    async () => {
      const { manager, reopen, events, script, workspace } = setup()
      const started = deferred()
      script.route("慢慢查", async (_context, options) => {
        started.resolve()
        await untilAborted(options?.signal)
        return fauxAssistantMessage([])
      })
      script.route("派前台", fauxAssistantMessage([fauxToolCall("agent", { description: "慢慢查", prompt: "慢慢查", run_in_background: false })]))

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派前台" })
      await started.promise
      const [child] = childrenOf(events, parent.id)
      await manager.disposeAll()

      const again = reopen()
      const [card] = await toolCards(again, parent.id, "agent")
      expect(card?.state.status).not.toBe("running")
      expect(card?.state.status).not.toBe("pending")
      const listed = await again.list(workspace)
      expect(listed.find((session) => session.id === child!.id)?.parentID).toBe(parent.id)

      script.route("派前台", text("接着来"))
      await again.prompt(parent.id, { text: "继续" })
      await waitFor(() => idle(again, parent.id) && textOf(script.last("派前台").messages.at(-1)) === "继续", 10_000, "父接着跑")
      await expect(again.prompt(child!.id, { text: "直接跟子会话说话" })).rejects.toMatchObject({
        data: { _tag: "SubagentSessionError", sessionID: child!.id },
      })
    },
    SLOW,
  )

  test(
    "(j) 通知已排进父的收件箱还没被取走时重启:重开父会话后被唤醒消费",
    async () => {
      const { manager, reopen, script, workspace, sessionsRoot, models, model } = setup()
      const parent = await manager.create(workspace)
      await manager.disposeAll()

      // 模拟上个进程:steer 了一条通知就崩了,还没来得及起一轮。
      const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: workspace }), sessionsRoot })
      const meta = (await repo.list(undefined, ctx)).find((item) => item.id === parent.id)!
      const { harness } = await AgentHarness.create({ session: await repo.open(meta, ctx), models, model }, ctx)
      const lane = await harness.lane("main", ctx)
      const xml = "<task-notification>\n<task-id>t-lost</task-id>\n<status>completed</status>\n</task-notification>"
      expect((await lane.steer(createCustomMessage("task-notification", xml, true, { taskID: "t-lost" }, Date.now()), undefined, ctx)).ok).toBe(true)
      await harness.close(ctx)
      script.route(xml, text("补收到了"))

      const again = reopen()
      // 任何一次"打开执行态"都行;rename 是最轻的那一个。
      await again.rename(parent.id, "重开")
      await waitFor(() => script.count(xml) === 1 && idle(again, parent.id), 10_000, "被唤醒消费")
      expect(textOf(script.last(xml).messages.at(-1))).toContain("<task-id>t-lost</task-id>")
    },
    SLOW,
  )

  test(
    "(k) LRU:父 + 12 个子(10 个排队),排队中 / 运行中的子会话一个都不被淘汰",
    async () => {
      const original = AgentHarness.create
      let created = 0
      AgentHarness.create = (async (...args: Parameters<typeof original>) => {
        created += 1
        return original(...args)
      }) as typeof original
      cleanups.push(async () => {
        AgentHarness.create = original
      })

      const { manager, script, workspace, events } = setup({ maxConcurrent: 2 })
      // 子 agent 全卡在闸门上:2 个在跑、10 个排队(已打开、空闲)。子 agent 秒完成的话,淘汰总是先挑已经
      // 完成的(最久没碰),排队中的从来轮不到 —— 那样的用例拿掉钉住照样绿(变异验证时漏过一次)。
      const gate = deferred()
      const names = Array.from({ length: 12 }, (_, index) => `子任务${String(index + 1).padStart(2, "0")}`)
      for (const name of names) {
        script.route(name, async (_context, options) => {
          await hold(gate.promise, options?.signal)
          return text(`${name}完`)
        })
      }
      script.route(
        "派十二个",
        fauxAssistantMessage(names.map((name) => fauxToolCall("agent", { description: name, prompt: name, run_in_background: true }))),
        text("派了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派十二个" })
      await waitFor(
        () =>
          manager.tasks(parent.id).length === 12 &&
          manager.tasks(parent.id).filter((task) => task.status === "running").length === 2 &&
          idle(manager, parent.id),
        20_000,
        "十二个派出、两个在跑",
      )
      gate.resolve()
      await waitFor(
        () => manager.tasks(parent.id).every((task) => task.status === "completed"),
        20_000,
        "十二个全部完成",
      )
      await waitFor(() => idle(manager, parent.id), 10_000, "父收工")
      // 父一个 + 子各一个:没有哪个排队中的子会话被淘汰后又重开。
      expect(created).toBe(13)
      expect(events.filter((event) => event.type === "kernel.error")).toEqual([])
    },
    SLOW,
  )

  test(
    "(l) 删父会话:子会话跟着删,逐个发 session.deleted",
    async () => {
      const { manager, events, script, workspace } = setup()
      script.route("子甲", text("甲完"))
      script.route("子乙", text("乙完"))
      script.route(
        "派两个",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "甲", prompt: "子甲", run_in_background: false }),
          fauxToolCall("agent", { description: "乙", prompt: "子乙", run_in_background: false }),
        ]),
        text("好"),
      )
      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派两个" })
      await waitFor(() => script.count("派两个") === 2 && idle(manager, parent.id), 10_000, "父收工")
      const children = childrenOf(events, parent.id).map((child) => child.id)
      expect(children).toHaveLength(2)

      await manager.delete(parent.id)
      const deleted = events.flatMap((event) => (event.type === "session.deleted" ? [event.sessionID] : []))
      expect(deleted).toEqual(expect.arrayContaining([...children, parent.id]))
      expect((await manager.list(workspace)).map((session) => session.id)).toEqual([])
      expect(manager.tasks(parent.id)).toEqual([])
    },
    SLOW,
  )

  test(
    "(m) 确认门:前台子 agent 的询问显示在父会话、带上 agent 与任务;后台子 agent 直接被拒,理由逐字",
    async () => {
      const { manager, events, script, workspace } = setup({}, { confirmTools: true })
      let foregroundSaw = ""
      let backgroundSaw = ""
      script.route(
        "前台烧录",
        fauxAssistantMessage([fauxToolCall("bash", { command: "openocd -v" })]),
        (context) => {
          foregroundSaw = textOf(context.messages.at(-1))
          return text("用户没让烧")
        },
      )
      script.route(
        "后台烧录",
        fauxAssistantMessage([fauxToolCall("bash", { command: "openocd -v" })]),
        (context) => {
          backgroundSaw = textOf(context.messages.at(-1))
          return text("后台问不了")
        },
      )
      script.route(
        "派烧录",
        fauxAssistantMessage([fauxToolCall("agent", { description: "前台烧", prompt: "前台烧录", run_in_background: false })]),
        text("好"),
      )
      script.route(
        "派后台烧录",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "后台烧", prompt: "后台烧录", run_in_background: true }),
        ]),
        text("派了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派烧录" })
      await waitFor(() => manager.pendingConfirms(parent.id).length === 1, 10_000, "询问出现在父会话")
      const [asked] = manager.pendingConfirms(parent.id)
      const [task] = manager.tasks(parent.id)
      expect(asked).toMatchObject({ sessionID: parent.id, tool: "bash", summary: "openocd -v", agent: "general-purpose", taskID: task!.id })
      expect(manager.replyConfirm(asked!.id, false)).toBe(true)
      await waitFor(() => script.count("派烧录") === 2 && idle(manager, parent.id), 10_000, "父收工")
      expect(foregroundSaw).toContain("The user declined to run bash: openocd -v.")

      const other = await manager.create(workspace)
      await manager.prompt(other.id, { text: "派后台烧录" })
      await waitFor(() => backgroundSaw !== "", 10_000, "后台子 agent 被拒")
      expect(backgroundSaw).toBe(
        "Background sub-agents cannot ask the user for confirmation, so bash: openocd -v did not run. Report back that it needs to run and let the main agent ask. Do not work around this with bash or any other tool — that includes running an equivalent command yourself.",
      )
      expect(
        events.filter((event) => event.type === "tool.confirm" && event.confirm.status === "pending"),
      ).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "(n) 前台子 agent 在跑时往父会话发新消息:排队、子 agent 照常跑完,父在这次 agent 调用之后的下一次请求里看到它",
    async () => {
      const { manager, events, script, workspace } = setup()
      // 前台与后台分开放行:后台的通知若赶在父的下一次请求之前排进来,插话与通知谁先谁后就说不准了。
      const release = deferred()
      const releaseBackground = deferred()
      script.route("前台慢活", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("慢活结果")
      })
      script.route("后台陪跑", async (_context, options) => {
        await hold(releaseBackground.promise, options?.signal)
        return text("陪跑结果")
      })
      script.route(
        "派慢活",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "陪跑", prompt: "后台陪跑", run_in_background: true }),
          fauxToolCall("agent", { description: "慢活", prompt: "前台慢活", run_in_background: false }),
        ]),
        text("看到插话了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派慢活" })
      await waitFor(() => script.count("前台慢活") === 1 && script.count("后台陪跑") === 1, 10_000, "子 agent 开跑")
      const queued = await manager.prompt(parent.id, { text: "插一句:顺便看看 BOOT0" })
      expect(queued.queued).toBe(true)
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "session.queue" &&
              event.sessionID === parent.id &&
              event.items.some((item) => item.kind === "prompt" && item.text === "插一句:顺便看看 BOOT0"),
          ),
        5000,
        "排队中那一栏",
      )
      expect(manager.tasks(parent.id).map((task) => task.status)).toEqual(["running", "running"])

      release.resolve()
      await waitFor(() => script.count("派慢活") === 2, 10_000, "父的下一次请求")
      const roles = script.last("派慢活").messages.map((message) => message.role)
      expect(roles.slice(-3)).toEqual(["toolResult", "toolResult", "user"])
      expect(textOf(script.last("派慢活").messages.at(-1))).toBe("插一句:顺便看看 BOOT0")
      // 插话没有误伤同时在跑的后台任务。
      expect(manager.tasks(parent.id).find((task) => task.description === "陪跑")?.status).toBe("running")
      releaseBackground.resolve()
      await waitFor(
        () => manager.tasks(parent.id).every((task) => task.status === "completed") && idle(manager, parent.id),
        10_000,
        "都完成",
      )
    },
    SLOW,
  )

  test(
    "(p) 排队消息恰好撞上一轮收尾:要么这一轮接着跑,要么收工后被叫醒 —— 总之不丢",
    async () => {
      for (let round = 0; round < 5; round++) {
        const { manager, script, workspace } = setup()
        const key = `收尾第${round}次`
        let parentID = ""
        script.route(key, () => {
          // 模型正在生成最后一段回答时,用户又发了一句;不等它,直接交回答案。
          void manager.prompt(parentID, { text: `尾巴${round}` })
          return text("第一段")
        })
        const parent = await manager.create(workspace)
        parentID = parent.id
        await manager.prompt(parent.id, { text: key })
        await waitFor(
          () =>
            idle(manager, parent.id) &&
            (script.contexts.get(key) ?? []).some((context) => textOf(context.messages.at(-1)) === `尾巴${round}`),
          10_000,
          "排队消息被取走",
        )
      }
    },
    SLOW,
  )

  test(
    "(r) 一轮失败收场时收件箱里还排着消息:失败的收尾不取收件箱,收工后由宿主叫醒,消息不丢",
    async () => {
      const { manager, script, workspace } = setup()
      let parentID = ""
      let queued: boolean | undefined
      script.route(
        "会失败的一轮",
        async () => {
          // 模型请求进行中用户又发了一句,排进收件箱;然后这次请求以不可重试的错误收场(认证错)。
          queued = (await manager.prompt(parentID, { text: "失败之后看这句" })).queued
          return fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })
        },
        text("看到了排队的那句"),
      )
      const parent = await manager.create(workspace)
      parentID = parent.id
      await manager.prompt(parent.id, { text: "会失败的一轮" })
      await waitFor(() => script.count("会失败的一轮") === 2 && idle(manager, parent.id), 10_000, "失败后被叫醒")
      expect(queued).toBe(true)
      expect(textOf(script.last("会失败的一轮").messages.at(-1))).toBe("失败之后看这句")
    },
    SLOW,
  )

  test(
    "(s) 转后台:前台那次 agent 调用立刻以 async_launched 交回,子 agent 不停,完成后照常通知",
    async () => {
      const { manager, script, workspace } = setup()
      const release = deferred()
      script.route("慢活转后台", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("转后台之后做完了")
      })
      script.route(
        "派前台慢活",
        fauxAssistantMessage([fauxToolCall("agent", { description: "慢活", prompt: "慢活转后台", run_in_background: false })]),
        text("先干别的"),
        text("收到"),
      )
      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派前台慢活" })
      await waitFor(() => script.count("慢活转后台") === 1, 10_000, "子 agent 开跑")
      const [task] = manager.tasks(parent.id)
      expect(task!.background).toBe(false)

      expect(manager.backgroundTask(task!.id)).toBe(true)
      await waitFor(() => script.count("派前台慢活") === 2 && idle(manager, parent.id), 10_000, "父先往下走")
      expect(textOf(script.last("派前台慢活").messages.at(-1))).toContain("Async agent launched successfully.")
      expect(manager.tasks(parent.id)[0]).toMatchObject({ status: "running", background: true })

      release.resolve()
      await waitFor(() => script.count("派前台慢活") === 3 && idle(manager, parent.id), 10_000, "通知叫醒父")
      const notes = notificationsIn(script.last("派前台慢活"), task!.id)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("<result>转后台之后做完了</result>")
      expect(manager.backgroundTask(task!.id)).toBe(false)
    },
    SLOW,
  )

  test(
    "(s2) 自动转后台:前台子 agent 跑满 autoBackgroundMs 就自己转后台",
    async () => {
      const { manager, script, workspace } = setup({ autoBackgroundMs: 300 })
      const release = deferred()
      script.route("跑得久", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("久活完了")
      })
      script.route(
        "派久活",
        fauxAssistantMessage([fauxToolCall("agent", { description: "久活", prompt: "跑得久", run_in_background: false })]),
        text("先回来了"),
      )
      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派久活" })
      await waitFor(() => script.count("派久活") === 2 && idle(manager, parent.id), 10_000, "到点转后台")
      expect(textOf(script.last("派久活").messages.at(-1))).toContain("Async agent launched successfully.")
      expect(manager.tasks(parent.id)[0]).toMatchObject({ status: "running", background: true })
      release.resolve()
      await waitFor(() => manager.tasks(parent.id)[0]!.status === "completed", 10_000, "完成")
    },
    SLOW,
  )

  test(
    "(t) 宿主不许后台(bench / 信箱):schema 里没有 run_in_background、硬塞也按前台跑;send_message 续跑也是前台",
    async () => {
      const { manager, script, workspace } = setup({ background: false })
      script.route("无人值守的活", text("第一遍结果"), (context) => text(`续跑:${textOf(context.messages.at(-1))}`))
      let schema = ""
      let first = ""
      let second = ""
      script.route(
        "派无人值守",
        (context) => {
          schema = JSON.stringify(getCurrentTools(context.messages).find((tool) => tool.name === "agent")?.parameters)
          return fauxAssistantMessage([
            fauxToolCall("agent", { description: "无人值守", prompt: "无人值守的活", run_in_background: true }),
          ])
        },
        (context) => {
          first = textOf(context.messages.at(-1))
          return fauxAssistantMessage([fauxToolCall("send_message", { to: agentIdIn(context), message: "再来一遍" })])
        },
        (context) => {
          second = textOf(context.messages.at(-1))
          return text("好")
        },
      )
      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派无人值守" })
      await waitFor(() => script.count("派无人值守") === 3 && idle(manager, parent.id), 10_000, "父收工")

      expect(schema).not.toContain("run_in_background")
      expect(first).toContain("第一遍结果")
      expect(second).toContain("续跑:再来一遍")
      expect(manager.tasks(parent.id)[0]).toMatchObject({ status: "completed", background: false })
    },
    SLOW,
  )

  test(
    "(u) task_output:没完成时等到超时回 timeout,完成后回 success 带结果",
    async () => {
      const { manager, script, workspace } = setup()
      const release = deferred()
      script.route("等着取结果", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("结果在这")
      })
      const lastOutput = (context: LlmContext) =>
        textOf([...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "task_output"))
      let early = ""
      let late = ""
      script.route(
        "派了再取",
        fauxAssistantMessage([fauxToolCall("agent", { description: "取结果", prompt: "等着取结果", run_in_background: true })]),
        (context) => fauxAssistantMessage([fauxToolCall("task_output", { task_id: agentIdIn(context), timeout: 200 })]),
        (context) => {
          early = lastOutput(context)
          release.resolve()
          return fauxAssistantMessage([fauxToolCall("task_output", { task_id: agentIdIn(context), timeout: 5000 })])
        },
        (context) => {
          late = lastOutput(context)
          return text("拿到了")
        },
      )
      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派了再取" })
      await waitFor(() => script.count("派了再取") >= 4 && idle(manager, parent.id), 10_000, "父收工")

      expect(early).toContain("<retrieval_status>timeout</retrieval_status>")
      expect(early).toContain("<status>running</status>")
      expect(late).toContain("<retrieval_status>success</retrieval_status>")
      expect(late).toContain("<status>completed</status>")
      expect(late).toContain("<output>\n结果在这\n</output>")
    },
    SLOW,
  )

  test(
    "(q) 撤回排队消息:还没被取走 → 原文交回、不再进 transcript;已被取走 → already_consumed",
    async () => {
      const { manager, events, script, workspace } = setup()
      const release = deferred()
      script.route("前台卡住", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("放行了")
      })
      script.route(
        "派卡住",
        fauxAssistantMessage([fauxToolCall("agent", { description: "卡住", prompt: "前台卡住", run_in_background: false })]),
        text("第二次请求"),
      )
      const queueItem = (wanted: string) => {
        for (const event of [...events].reverse()) {
          if (event.type !== "session.queue") continue
          const item = event.items.find((entry) => entry.kind === "prompt" && entry.text === wanted)
          if (item) return item.entryId
        }
        return undefined
      }

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派卡住" })
      await waitFor(() => script.count("前台卡住") === 1, 10_000, "子 agent 开跑")

      expect((await manager.prompt(parent.id, { text: "算了不问了" })).queued).toBe(true)
      await waitFor(() => queueItem("算了不问了") !== undefined, 5000, "排上队")
      expect(await manager.cancelQueued(parent.id, queueItem("算了不问了")!)).toEqual({ kind: "cancelled", text: "算了不问了" })

      expect((await manager.prompt(parent.id, { text: "这句要留着" })).queued).toBe(true)
      await waitFor(() => queueItem("这句要留着") !== undefined, 5000, "排上队")
      const kept = queueItem("这句要留着")!
      release.resolve()
      await waitFor(() => script.count("派卡住") === 2 && idle(manager, parent.id), 10_000, "父收工")
      const seen = script.last("派卡住").messages.map(textOf)
      expect(seen).toContain("这句要留着")
      expect(seen).not.toContain("算了不问了")
      expect(await manager.cancelQueued(parent.id, kept)).toEqual({ kind: "already_consumed" })
    },
    SLOW,
  )

  test(
    "(v) 重开进程后列表里的子会话是懒的(占位标题,还不知道类型),打开时推一条 session.updated 补上真名与类型;主会话在列表里就有真名",
    async () => {
      const { manager, reopen, events, script, workspace } = setup()
      script.route("查手册", text("查到了"))
      script.route(
        "派一个",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "查手册", prompt: "查手册", subagent_type: "Explore", run_in_background: false }),
        ]),
        text("好了"),
      )
      const parent = await manager.create(workspace, "派子 agent 的会话")
      await manager.prompt(parent.id, { text: "派一个" })
      await waitFor(() => script.count("派一个") === 2 && idle(manager, parent.id), 10_000, "父收工")
      const [child] = childrenOf(events, parent.id)
      await manager.disposeAll()

      const again = reopen()
      const listed = await again.list(workspace)
      const lazy = listed.find((session) => session.id === child!.id)
      expect(lazy?.title).not.toBe("查手册")
      expect(lazy?.agent).toBeUndefined()
      // 主会话的名字 list() 就从 JSONL 里读出来了(host/session-names.ts),不用等打开 —— 打开时也就没有变化可推。
      expect(listed.find((session) => session.id === parent.id)?.title).toBe("派子 agent 的会话")

      const mark = events.length
      await again.messages(child!.id)
      await again.messages(parent.id)
      const updated = events.slice(mark).flatMap((event) => (event.type === "session.updated" ? [event.session] : []))
      expect(updated.find((session) => session.id === child!.id)).toMatchObject({
        title: "查手册",
        agent: "Explore",
        parentID: parent.id,
      })
      expect(updated.find((session) => session.id === parent.id)).toBeUndefined()

      // 已经开着的再读一次不重复推。
      const settled = events.length
      await again.messages(child!.id)
      expect(events.slice(settled).filter((event) => event.type === "session.updated")).toEqual([])
    },
    SLOW,
  )

  test(
    "(w) 缺省后台:不写 run_in_background 就是后台 —— 这一轮的工具结果是\"已派出\",父先收工,结论随通知回来",
    async () => {
      const { manager, script, workspace } = setup()
      const release = deferred()
      script.route("查时钟树", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("HSE 8 MHz → PLL 168 MHz")
      })
      script.route(
        "派一个",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "查时钟", prompt: "查时钟树", subagent_type: "Explore" }),
        ]),
        text("已经派出去了,查到就告诉你"),
        text("时钟树查完了"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派一个" })
      // 子 agent 还卡在闸门上,父已经收工:说明那次调用立刻交回了。
      await waitFor(() => script.count("派一个") === 2 && idle(manager, parent.id), 10_000, "父这一轮先收工")
      expect(textOf(script.last("派一个").messages.at(-1))).toContain("Async agent launched successfully.")
      expect(manager.tasks(parent.id)[0]).toMatchObject({ status: "running", background: true })

      release.resolve()
      await waitFor(() => script.count("派一个") === 3 && idle(manager, parent.id), 10_000, "通知把父叫醒")
      const notes = notificationsIn(script.last("派一个"))
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("HSE 8 MHz")
    },
    SLOW,
  )

  test(
    "(x) 按停止:排着的用户消息交回调用方,子 agent 的通知留在收件箱、下一轮被取走",
    async () => {
      const { manager, script, workspace, events } = setup()
      const holdForeground = deferred()
      const queuedKinds = () => {
        for (const event of [...events].reverse()) {
          if (event.type === "session.queue" && event.sessionID) return event.items.map((item) => item.kind)
        }
        return []
      }
      script.route("后台干活", text("后台的结论"))
      script.route("前台卡住", async (_context, options) => {
        await hold(holdForeground.promise, options?.signal)
        return text("前台跑完了")
      })
      script.route(
        "派两个",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "后台", prompt: "后台干活" }),
          fauxToolCall("agent", { description: "前台", prompt: "前台卡住", run_in_background: false }),
        ]),
        text("停下之后再说"),
      )

      const parent = await manager.create(workspace)
      await manager.prompt(parent.id, { text: "派两个" })
      // 后台那个已经跑完、通知排进了收件箱;前台那个还卡着,所以父一直忙。
      await waitFor(() => queuedKinds().includes("notification"), 10_000, "通知进收件箱")
      expect((await manager.prompt(parent.id, { text: "排着的那句" })).queued).toBe(true)
      await waitFor(() => queuedKinds().includes("prompt"), 5000, "用户消息也排上队")

      const stopped = await manager.abort(parent.id)
      expect(stopped.returned).toEqual([{ text: "排着的那句" }])

      // 通知没丢:放回收件箱之后被叫醒的那一轮取走它;用户那句话不在里面(已经交回输入框)。
      await waitFor(() => script.count("派两个") === 2 && idle(manager, parent.id), 10_000, "通知被取走")
      const asked = script.last("派两个")
      expect(notificationsIn(asked)).toHaveLength(1)
      expect(notificationsIn(asked)[0]).toContain("后台的结论")
      expect(asked.messages.map(textOf)).not.toContain("排着的那句")
    },
    SLOW,
  )
})
