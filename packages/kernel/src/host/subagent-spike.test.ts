/**
 * P0 原型:子 agent 方案(docs/子agent-设计方案-v0.4-20260918.md §12)依赖的 v2 行为,逐条跑一遍。
 *
 * 只碰上游的公开接口(AgentHarness / AgentLane / JsonlSessionRepo / hooks / custom 消息),**不经过**
 * SessionManager —— 这里回答的是"v2 本身是不是这样",宿主怎么接是 P2 的事。结论写回设计文档 §12;
 * P2 时转成正式测试或删掉。每个 harness 一份 faux provider,并行的子 agent 回复不会串到别人的脚本里。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "vitest"
import { Type } from "typebox"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Context as LlmContext,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  createCustomMessage,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type LaneQueuedItem,
  type Session,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

const ctx = BACKGROUND_CONTEXT
/** 这些用例要等模型脚本与工具互相放行,给足 15 秒;真卡住就是死锁,不是慢。 */
const SLOW = 15_000

type SpikeTool = AgentHarnessTool<object | undefined>

const closers: Array<() => Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  // 先关 harness(连带会话文件句柄),再删目录 —— Windows 上开着的 JSONL 删不掉。
  for (const close of closers.splice(0).reverse()) await close().catch(() => {})
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

let providerCount = 0

/** 一个 harness 一份 faux:注册表与脚本都不共享(v0.2 说的"faux 共享队列"问题随之消失)。 */
function scripted(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ provider: `spike-${++providerCount}`, models: [{ id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(steps)
  return { faux, models, model: faux.getModel() }
}

type Script = ReturnType<typeof scripted>

/** 与 SessionManager 同一种仓库:JSONL 落在临时目录,文件系统走 NodeExecutionEnv。 */
function makeRepo() {
  const env = new NodeExecutionEnv({ cwd: process.cwd() })
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: tempDir("yoma-spike-sessions-") })
  return { repo, cwd: tempDir("yoma-spike-ws-") }
}

async function attach(session: Session, script: Script, tools: SpikeTool[] = []) {
  const { harness, open } = await AgentHarness.create<object | undefined>(
    { session, models: script.models, model: script.model, tools, activeToolNames: tools.map((tool) => tool.name) },
    ctx,
  )
  closers.push(() => harness.close(ctx))
  const lane = await harness.lane("main", ctx)
  return { harness, lane, open, script }
}

/** 宿主的"一轮":accept 只落盘,drive 才执行(选项与 session-manager.ts 的 prompt() 相同)。 */
async function drive(lane: AgentLane, operationId: string) {
  const driven = await lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, ctx)
  if (!driven.ok) throw driven.error
  if (driven.value.kind !== "settled") throw new Error(`drive 停在 ${driven.value.kind}`)
  return driven.value.outcome
}

async function accept(lane: AgentLane, prompt: string | AgentMessage[]): Promise<string> {
  const accepted = await lane.accept(
    typeof prompt === "string" ? { kind: "prompt", prompt } : { kind: "prompt", prompt },
    ctx,
  )
  if (!accepted.ok) throw accepted.error
  return accepted.value.operationId
}

async function runOnce(lane: AgentLane, prompt: string | AgentMessage[]) {
  return drive(lane, await accept(lane, prompt))
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((block: { type: string; text?: string }) => (block.type === "text" ? [block.text ?? ""] : [])).join("")
}

async function transcript(lane: AgentLane): Promise<AgentMessage[]> {
  const entries = await lane.findEntries({ order: "oldestFirst" }, ctx)
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
}

/** 与 CC 同形的通知(字段在 v0.4 §6.4;这里只放判断要用的两个)。 */
function note(taskID: string) {
  return createCustomMessage(
    "task-notification",
    `<task-notification>\n<task-id>${taskID}</task-id>\n<status>completed</status>\n</task-notification>`,
    true,
    { taskID },
    Date.now(),
  )
}

/** 会停住的工具:跑到一半等测试放行,用来把"父正在跑一批工具"这个时刻钉住。 */
function gateTool(name = "wait") {
  const started = deferred()
  const release = deferred()
  const tool: SpikeTool = {
    name,
    label: name,
    description: "Blocks until the test releases it.",
    parameters: Type.Object({}),
    execute: async () => {
      started.resolve()
      await release.promise
      return { content: [{ type: "text", text: "released" }], details: undefined }
    },
  }
  return { tool, started: started.promise, release: () => release.resolve() }
}

/** 什么都不做的工具;tag 让 after_tool 分得清同一批里的两个调用。 */
const noopTool: SpikeTool = {
  name: "noop",
  label: "noop",
  description: "Does nothing.",
  parameters: Type.Object({ tag: Type.Optional(Type.String()) }),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
}

describe("子 agent P0:v2 行为核实", () => {
  test(
    "(a) 子会话:parentSessionId 写进文件头,list 不开会话就拿得到;独立 harness 跑完一轮,取得到最后一条 assistant 文本",
    async () => {
      const { repo, cwd } = makeRepo()
      const parent = await repo.create({ cwd }, ctx)
      closers.push(() => parent.close(ctx))
      const child = await repo.create({ cwd, parentSessionId: parent.metadata.id }, ctx)
      const c = await attach(child, scripted([fauxAssistantMessage([fauxText("时钟树:HSE 8 MHz → PLL 168 MHz")])]))

      const outcome = await runOnce(c.lane, "查时钟树")
      expect(outcome.status).toBe("completed")

      const newest = await c.lane.findEntries({ order: "newestFirst", type: "message" }, ctx)
      const lastAssistant = newest.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])).find((m) => m.role === "assistant")
      expect(textOf(lastAssistant)).toBe("时钟树:HSE 8 MHz → PLL 168 MHz")

      const listed = await repo.list(undefined, ctx)
      expect(listed.find((meta) => meta.id === child.metadata.id)?.parentSessionId).toBe(parent.metadata.id)
      expect(listed.find((meta) => meta.id === parent.metadata.id)?.parentSessionId).toBeUndefined()
    },
    SLOW,
  )

  test(
    "(b) 父空闲:steer 一条 custom 通知不起轮;accept(prompt: []) 起一轮收走它,模型那边是 user 角色,transcript 里是 custom 条目;收件箱空时 InvalidMessage(empty)",
    async () => {
      const { repo, cwd } = makeRepo()
      let seen: LlmContext | undefined
      const p = await attach(
        await repo.create({ cwd }, ctx),
        scripted([
          async (context) => {
            seen = context
            return fauxAssistantMessage([fauxText("收到,子 agent 查完了")])
          },
        ]),
      )

      const empty = await p.lane.accept({ kind: "prompt", prompt: [] }, ctx)
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toMatchObject({ _tag: "InvalidMessage", reason: "empty" })

      const queued = await p.lane.steer(note("t1"), undefined, ctx)
      expect(queued.ok).toBe(true)
      expect((await p.lane.inspectExecution(ctx)).current).toBeNull()

      const outcome = await runOnce(p.lane, [])
      expect(outcome.status).toBe("completed")
      const lastSeen = seen!.messages.at(-1)!
      expect(lastSeen.role).toBe("user")
      expect(textOf(lastSeen)).toContain("<task-id>t1</task-id>")

      const messages = await transcript(p.lane)
      expect(messages.map((m) => m.role)).toEqual(["custom", "assistant"])
      expect((messages[0] as { customType?: string }).customType).toBe("task-notification")
    },
    SLOW,
  )

  test.each([
    ["custom 通知", () => note("t2") as AgentMessage | string],
    ["用户消息(§6.9 排队)", () => "顺便把 DMA 也看一下" as AgentMessage | string],
  ])(
    "(c1) 父在跑一批工具时 steer %s → 这批工具结束后的下一次请求就带上它,不多起一轮",
    async (_label, make) => {
      const { repo, cwd } = makeRepo()
      const gate = gateTool()
      let secondCall: LlmContext | undefined
      const p = await attach(
        await repo.create({ cwd }, ctx),
        scripted([
          fauxAssistantMessage([fauxToolCall("wait", {})]),
          async (context) => {
            secondCall = context
            return fauxAssistantMessage([fauxText("两件事都知道了")])
          },
        ]),
        [gate.tool],
      )

      const running = runOnce(p.lane, "开始")
      await gate.started
      const queued = await p.lane.steer(make(), undefined, ctx)
      expect(queued.ok).toBe(true)
      gate.release()

      const outcome = await running
      expect(outcome.status).toBe("completed")
      expect(p.script.faux.state.callCount).toBe(2)
      // 顺序:用户 prompt → assistant(toolCall)→ toolResult → steer 进来的那条(对模型是 user)
      expect(secondCall!.messages.map((m) => m.role).slice(-2)).toEqual(["toolResult", "user"])
    },
    SLOW,
  )

  test(
    "(c2) steer 落在最后一轮的模型请求期间 → 这一轮不结束、接着跑(finishRunBoundary 在同一次提交里重排收件箱),只有一个 run_end",
    async () => {
      const { repo, cwd } = makeRepo()
      let lane!: AgentLane
      let secondCall: LlmContext | undefined
      const p = await attach(
        await repo.create({ cwd }, ctx),
        scripted([
          async () => {
            // 模型正在生成"最后一段回答"(没有工具调用)时,通知到了。
            const queued = await lane.steer(note("t3"), undefined, ctx)
            if (!queued.ok) throw queued.error
            return fauxAssistantMessage([fauxText("第一段回答,没有工具调用")])
          },
          async (context) => {
            secondCall = context
            return fauxAssistantMessage([fauxText("看到了通知")])
          },
        ]),
      )
      lane = p.lane
      const runEnds: string[] = []
      p.harness.events.on("run_end", (event) => void runEnds.push(event.status))

      const outcome = await runOnce(p.lane, "说点什么")
      expect(outcome.status).toBe("completed")
      expect(p.script.faux.state.callCount).toBe(2)
      expect(runEnds).toEqual(["completed"])
      expect(textOf(secondCall!.messages.at(-1))).toContain("<task-id>t3</task-id>")
    },
    SLOW,
  )

  test(
    "(c3) steer 落在 run_end 之后 → lane 空闲、收件箱非空(queue_update 看得见),accept(prompt: []) 起一轮收走",
    async () => {
      const { repo, cwd } = makeRepo()
      const p = await attach(
        await repo.create({ cwd }, ctx),
        scripted([fauxAssistantMessage([fauxText("第一轮")]), fauxAssistantMessage([fauxText("第二轮:收到通知")])]),
      )
      let queues: LaneQueuedItem[] = []
      p.harness.events.on("queue_update", (event) => void (queues = event.queues))

      expect((await runOnce(p.lane, "第一轮")).status).toBe("completed")
      const queued = await p.lane.steer(note("t4"), undefined, ctx)
      expect(queued.ok).toBe(true)
      expect((await p.lane.inspectExecution(ctx)).current).toBeNull()
      expect(queues).toHaveLength(1)
      expect(queues[0]).toMatchObject({ kind: "steer", type: "message" })

      expect((await runOnce(p.lane, [])).status).toBe("completed")
      expect(queues).toEqual([])
      expect((await transcript(p.lane)).map((m) => m.role)).toEqual(["user", "assistant", "custom", "assistant"])
    },
    SLOW,
  )

  test(
    "(d) 父 requestAbort → 父工具的 context.abortSignal 触发 → 工具里停掉子 lane;父子两轮都以 aborted 落定",
    async () => {
      const { repo, cwd } = makeRepo()
      const parentSession = await repo.create({ cwd }, ctx)
      const childStarted = deferred()
      const childSettled = deferred<string>()
      const childScript = scripted([
        async (_context, options) => {
          childStarted.resolve()
          // 子 agent 的模型请求一直挂着,直到中止信号到达(真模型的流也是这样被掐断的)。
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve()
            options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          return fauxAssistantMessage([fauxText("(被打断前的半截)")])
        },
      ])
      const spawn: SpikeTool = {
        name: "spawn",
        label: "spawn",
        description: "Run a child agent in its own session.",
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_toolCallId, params, _onUpdate, _toolContext, _invocation, context) => {
          const child = await repo.create({ cwd, parentSessionId: parentSession.metadata.id }, ctx)
          const c = await attach(child, childScript)
          const operationId = await accept(c.lane, (params as { prompt: string }).prompt)
          // 前台:把父这次工具调用的中止接到子 lane 上(v0.4 §5.1 "中止挂接")。
          const onAbort = () => void c.lane.requestAbort(operationId, ctx)
          if (context.abortSignal?.aborted) onAbort()
          context.abortSignal?.addEventListener("abort", onAbort, { once: true })
          try {
            const outcome = await drive(c.lane, operationId)
            childSettled.resolve(outcome.status)
            return { content: [{ type: "text", text: `child ${outcome.status}` }], details: undefined }
          } finally {
            context.abortSignal?.removeEventListener("abort", onAbort)
          }
        },
      }
      const p = await attach(
        parentSession,
        scripted([fauxAssistantMessage([fauxToolCall("spawn", { prompt: "查中断向量" })]), fauxAssistantMessage([fauxText("不该走到这")])]),
        [spawn],
      )

      const operationId = await accept(p.lane, "派一个子 agent")
      const parentOutcome = drive(p.lane, operationId)
      await childStarted.promise
      const requested = await p.lane.requestAbort(operationId, ctx)
      expect(requested.ok).toBe(true)

      expect(await childSettled.promise).toBe("aborted")
      expect((await parentOutcome).status).toBe("aborted")
      expect(p.script.faux.state.callCount).toBe(1)
    },
    SLOW,
  )

  /** v0.4 §6.6:before_request 按 runId 计 assistant 轮数;after_tool 满额回 terminate;before_tool 超额兜底拦下。 */
  function maxTurns(harness: Awaited<ReturnType<typeof attach>>["harness"], max: number, terminate = (_tag: unknown) => true) {
    const turns = new Map<string, number>()
    harness.hooks.on("before_request", (event) => {
      if (event.step === "assistant" && event.attempt === 1) turns.set(event.runId, (turns.get(event.runId) ?? 0) + 1)
      return undefined
    })
    harness.hooks.on("after_tool", (event) =>
      (turns.get(event.runId) ?? 0) >= max && terminate(event.args.tag) ? { terminate: true } : undefined,
    )
    harness.hooks.on("before_tool", (event) =>
      (turns.get(event.runId) ?? 0) > max ? { block: { reason: "max turns reached", terminate: true } } : undefined,
    )
  }

  test(
    "(e1) maxTurns = 2:第 2 轮的工具(同一批两个)跑完就不再请求模型,run 以 completed 结束",
    async () => {
      const { repo, cwd } = makeRepo()
      const c = await attach(
        await repo.create({ cwd }, ctx),
        scripted([
          fauxAssistantMessage([fauxToolCall("noop", { tag: "1" })]),
          fauxAssistantMessage([fauxToolCall("noop", { tag: "a" }), fauxToolCall("noop", { tag: "b" })]),
          fauxAssistantMessage([fauxText("第 3 轮不该被请求")]),
        ]),
        [noopTool],
      )
      maxTurns(c.harness, 2)

      const outcome = await runOnce(c.lane, "干活")
      expect(outcome.status).toBe("completed")
      expect(c.script.faux.state.callCount).toBe(2)
      expect((await transcript(c.lane)).at(-1)?.role).toBe("toolResult")
    },
    SLOW,
  )

  test(
    "(e2) 同一批只有部分调用带 terminate → 不停,接着请求模型(v2 要求整批都带)",
    async () => {
      const { repo, cwd } = makeRepo()
      const c = await attach(
        await repo.create({ cwd }, ctx),
        scripted([
          fauxAssistantMessage([fauxToolCall("noop", { tag: "a" }), fauxToolCall("noop", { tag: "b" })]),
          fauxAssistantMessage([fauxText("第 2 轮照常来了")]),
        ]),
        [noopTool],
      )
      maxTurns(c.harness, 1, (tag) => tag === "a")

      const outcome = await runOnce(c.lane, "干活")
      expect(outcome.status).toBe("completed")
      expect(c.script.faux.state.callCount).toBe(2)
    },
    SLOW,
  )

  test(
    "(f) 子会话带着在飞操作被关掉再打开 → open 里有它、lane 回 LaneBusy;abort 之后 lane 照常可用",
    async () => {
      const { repo, cwd } = makeRepo()
      const child = await repo.create({ cwd, parentSessionId: "parent-x" }, ctx)
      const meta = child.metadata
      const script = scripted([fauxAssistantMessage([fauxText("重开之后的这一轮")])])

      const first = await AgentHarness.create({ session: child, models: script.models, model: script.model }, ctx)
      const firstLane = await first.harness.lane("main", ctx)
      const stale = await accept(firstLane, "跑到一半内核就没了") // 只落盘不 drive = 上个进程留下的在飞操作
      await first.harness.close(ctx)

      const reopened = await repo.open(meta, ctx)
      const second = await AgentHarness.create({ session: reopened, models: script.models, model: script.model }, ctx)
      closers.push(() => second.harness.close(ctx))
      expect(second.open).toEqual([expect.objectContaining({ lane: "main", operationId: stale, kind: "run" })])

      const lane = await second.harness.lane("main", ctx)
      const busy = await lane.accept({ kind: "prompt", prompt: "新的一轮" }, ctx)
      expect(busy.ok).toBe(false)
      if (!busy.ok) expect(busy.error).toMatchObject({ _tag: "LaneBusy" })

      const aborted = await lane.abort(ctx)
      expect(aborted.ok).toBe(true)
      expect((await runOnce(lane, "新的一轮")).status).toBe("completed")
    },
    SLOW,
  )

  test(
    "(g) 事实核对:requestAbort 把收件箱里排着的 steer 一并摘下交回 —— 停止键丢排队项的根(v0.4 §14,本期不处理)",
    async () => {
      const { repo, cwd } = makeRepo()
      const gate = gateTool()
      const p = await attach(
        await repo.create({ cwd }, ctx),
        scripted([fauxAssistantMessage([fauxToolCall("wait", {})]), fauxAssistantMessage([fauxText("不该走到这")])]),
        [gate.tool],
      )

      const operationId = await accept(p.lane, "开始")
      const outcome = drive(p.lane, operationId)
      await gate.started
      expect((await p.lane.steer(note("t5"), undefined, ctx)).ok).toBe(true)
      expect((await p.lane.steer("排着的用户消息", undefined, ctx)).ok).toBe(true)

      const requested = await p.lane.requestAbort(operationId, ctx)
      gate.release()
      expect(requested.ok).toBe(true)
      if (requested.ok) {
        expect(requested.value.steer.map((m) => m.role)).toEqual(["custom", "user"])
      }
      expect((await outcome).status).toBe("aborted")

      // 收件箱已经空了:这两条不在任何地方了。
      const empty = await p.lane.accept({ kind: "prompt", prompt: [] }, ctx)
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toMatchObject({ _tag: "InvalidMessage", reason: "empty" })
    },
    SLOW,
  )
})
