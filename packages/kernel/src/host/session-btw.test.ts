/**
 * /btw 顺便问一句与"转成后台任务"(fork)走完整的 SessionManager(docs/btw顺便问-设计方案-20260924.md §5):真 harness、
 * 真 JSONL、真 TaskManager,只有模型是 faux。
 *
 * 最要紧的是**逐字对齐**:/btw 与 fork 的请求前缀必须和主轮最后一次请求一模一样,供应商的前缀缓存才会命中。
 * 这里拿发动机**真发出去的**请求去比 —— 上游哪天改了拼上下文的规则(host/btw.ts 抄的那一份就旧了),这几条先红。
 *
 * 所有会话共用一份 faux,每次请求交给同一个路由,按内容分流:最后一条是包好的顺便问 → btw;带 `<fork-boilerplate>` → fork;
 * 第一条 user 消息以 "CHILD:" 开头 → 普通子 agent;其余是主会话(含手动压缩的那次摘要请求)。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, test } from "vitest"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type FauxResponseFactory,
  type FauxResponseStep,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai"

import { SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import { RUNNING_TOOL_PLACEHOLDER } from "./btw.ts"
import type { KernelEvent } from "../protocol.ts"
import type { BtwView } from "../types.ts"
import { patient } from "../../test/patience.ts"

/** 这些用例要等主会话、/btw、子会话互相放行;真卡住是死锁,不是慢。 */
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

/** 等测试放行;中途被中止就提前放手(否则用例一失败,收尾就挂在永远不来的放行上)。 */
function hold(release: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  return Promise.race([release.then(() => undefined), untilAborted(signal)])
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block: { type: string; text?: string }) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("\n")
}

const text = (value: string) => fauxAssistantMessage([fauxText(value)])

function failed(errorMessage: string): AssistantMessage {
  return { ...text(""), content: [], stopReason: "error", errorMessage }
}

type Kind = "main" | "btw" | "fork" | "child"

function classify(context: TranscriptContext): Kind {
  const users = context.messages.filter((message) => message.role === "user")
  const last = context.messages.at(-1)
  if (last?.role === "user" && textOf(last).includes("This is a side question from the user")) return "btw"
  if (users.some((message) => textOf(message).includes("<fork-boilerplate>"))) return "fork"
  if (users[0] && textOf(users[0]).startsWith("CHILD:")) return "child"
  return "main"
}

interface Request {
  kind: Kind
  context: TranscriptContext
  options: SimpleStreamOptions | undefined
}

class Router {
  readonly requests: Request[] = []
  private readonly queues: Record<Kind, FauxResponseStep[]> = { main: [], btw: [], fork: [], child: [] }

  queue(kind: Kind, ...steps: FauxResponseStep[]): void {
    this.queues[kind].push(...steps)
  }

  of(kind: Kind): Request[] {
    return this.requests.filter((request) => request.kind === kind)
  }

  readonly step: FauxResponseFactory = (context, options, state, model) => {
    const kind = classify(context)
    // 留一份快照:上下文数组之后还会被发动机接着用。
    this.requests.push({ kind, context: { ...context, messages: [...context.messages] }, options })
    const next = this.queues[kind].shift()
    if (!next) return text(`(${kind} 的脚本已用完)`)
    return typeof next === "function" ? next(context, options, state, model) : (next as AssistantMessage)
  }
}

let providerCount = 0

function setup(extra: Partial<SessionManagerOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-btw-"))
  roots.push(root)
  const workspace = path.join(root, "ws")
  mkdirSync(workspace)
  writeFileSync(path.join(workspace, "main.c"), "int main(void) { return 0; }\n")
  const router = new Router()
  // 带思考档的模型:reasoning 这个请求选项也要和主轮一致(桌面端缺省 max,这里给 high)。
  const faux = fauxProvider({ provider: `btw-${++providerCount}`, models: [{ id: "thinker", reasoning: true }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 500 }, () => router.step))
  const model = faux.getModel() as Model<string>
  const events: KernelEvent[] = []
  const sessionsRoot = path.join(root, "sessions")
  const { subagents, ...rest } = extra
  const manager = new SessionManager({
    sessionsRoot,
    configDir: path.join(root, "config"),
    emit: (batch) => events.push(...batch),
    resolveModels: async () => ({ models, model }),
    inspectStm32Availability: async () => ({ available: false, reason: "test" }),
    // 祖先链止于 root:只认 <ws>/.yoma/agents,不会走到开发机真实的目录。
    subagents: { outputRoot: path.join(root, "tasks"), homeDir: root, ...subagents },
    defaultThinkingLevel: "high",
    ...rest,
  })
  cleanups.push(() => manager.disposeAll())
  return { manager, router, events, workspace, sessionsRoot }
}

const idle = (manager: SessionManager, sessionID: string) => manager.status(sessionID).type === "idle"

function btwEvents(events: KernelEvent[], btwID?: string): BtwView[] {
  return events.flatMap((event) =>
    event.type === "session.btw" && (!btwID || event.btw.id === btwID) ? [event.btw] : [],
  )
}

async function waitForBtw(events: KernelEvent[], btwID: string, status: BtwView["status"]): Promise<BtwView> {
  await waitFor(() => btwEvents(events, btwID).some((view) => view.status === status), 10_000, `/btw 到 ${status}`)
  return btwEvents(events, btwID).find((view) => view.status === status)!
}

/** 会话的 JSONL 文件(不管 repo 按什么目录布局放)。 */
function sessionFile(dir: string, sessionID: string): string {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      const found = sessionFileOrUndefined(full, sessionID)
      if (found) return found
    } else if (item.name.includes(sessionID) && item.name.endsWith(".jsonl")) return full
  }
  throw new Error(`找不到会话 ${sessionID} 的 JSONL`)
}

function sessionFileOrUndefined(dir: string, sessionID: string): string | undefined {
  try {
    return sessionFile(dir, sessionID)
  } catch {
    return undefined
  }
}

/** 1×1 的 PNG。 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("/btw:逐字对齐", () => {
  test(
    "系统提示词、工具、消息前缀与主轮最后一次请求一模一样,缓存路由键与思考档相同;问答不落盘、只发 session.btw",
    async () => {
      const { manager, router, events, workspace, sessionsRoot } = setup()
      router.queue(
        "main",
        fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]),
        text("main.c 只有一个空的 main"),
      )
      router.queue("btw", text("它是固件的入口"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "看看 main.c" })
      await waitFor(() => router.of("main").length === 2 && idle(manager, session.id), 15_000, "主轮收工")

      const file = sessionFile(sessionsRoot, session.id)
      const before = readFileSync(file)
      const mark = events.length
      const { btwID } = await manager.btw(session.id, { text: "main.c 是干嘛的" })
      const done = await waitForBtw(events, btwID, "done")
      expect(done).toMatchObject({ sessionID: session.id, question: "main.c 是干嘛的", text: "它是固件的入口" })

      const main = router.of("main").at(-1)!
      const btw = router.of("btw")[0]!
      // 主轮最后一次请求的整串(系统消息里带着系统提示词与工具定义)逐条相同。
      expect(btw.context.messages.slice(0, main.context.messages.length)).toEqual(main.context.messages)
      expect(getCurrentSystemPrompt(btw.context.messages)).toBe(getCurrentSystemPrompt(main.context.messages))
      expect(getCurrentTools(btw.context.messages)).toEqual(getCurrentTools(main.context.messages))
      // 接着是主轮的最后一条回复,最后是包好的问题。
      const rest = btw.context.messages.slice(main.context.messages.length)
      expect(rest.map((message) => message.role)).toEqual(["assistant", "user"])
      expect(textOf(rest[0])).toBe("main.c 只有一个空的 main")
      expect(textOf(rest[1])).toContain("This is a side question from the user")
      expect(textOf(rest[1]).endsWith("main.c 是干嘛的")).toBe(true)
      // 同一个缓存路由键、同一个思考档。
      expect(btw.options?.sessionId).toBe(`${session.id}:main`)
      expect(btw.options?.sessionId).toBe(main.options?.sessionId)
      expect(btw.options?.reasoning).toBeDefined()
      expect(btw.options?.reasoning).toBe(main.options?.reasoning)

      // 零写入;事件只有 session.btw(不发 message.*,不动会话状态与收件箱)。
      expect(readFileSync(file).equals(before)).toBe(true)
      expect(new Set(events.slice(mark).map((event) => event.type))).toEqual(new Set(["session.btw"]))
      expect(events.filter((event) => event.type === "kernel.error")).toEqual([])
      expect(idle(manager, session.id)).toBe(true)
    },
    SLOW,
  )

  test(
    "跑到一半:在跑的工具调用补「还在运行」而不是 No result provided;主轮照常跑完,拿到的是真结果;子会话不接 /btw",
    async () => {
      const { manager, router, events, workspace } = setup()
      const release = deferred()
      router.queue(
        "main",
        fauxAssistantMessage([
          fauxToolCall("agent", { description: "查一下", prompt: "CHILD: 查一下", run_in_background: false }),
        ]),
        text("收尾"),
      )
      router.queue("child", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("子 agent 的结论")
      })
      router.queue("btw", text("还在查"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "派一个去查" })
      await waitFor(() => router.of("child").length === 1, 15_000, "子 agent 开始跑")
      expect(idle(manager, session.id)).toBe(false)

      const { btwID } = await manager.btw(session.id, { text: "它在干嘛" })
      await waitForBtw(events, btwID, "done")
      const btw = router.of("btw")[0]!
      const results = btw.context.messages.filter((message) => message.role === "toolResult")
      expect(results.map(textOf)).toEqual([RUNNING_TOOL_PLACEHOLDER])
      expect((results[0] as { isError: boolean }).isError).toBe(false)
      expect(JSON.stringify(btw.context.messages)).not.toContain("No result provided")

      release.resolve()
      await waitFor(() => router.of("main").length === 2 && idle(manager, session.id), 15_000, "主轮收工")
      const second = router.of("main")[1]!
      expect(
        second.context.messages
          .filter((message) => message.role === "toolResult")
          .map(textOf)
          .join("\n"),
      ).toContain("子 agent 的结论")
      expect(JSON.stringify(second.context.messages)).not.toContain(RUNNING_TOOL_PLACEHOLDER)
      expect(JSON.stringify(second.context.messages)).not.toContain("side question")

      const child = events.flatMap((event) =>
        event.type === "session.created" && event.session.parentID === session.id ? [event.session] : [],
      )[0]!
      await expect(manager.btw(child.id, { text: "你在干嘛" })).rejects.toThrow()
    },
    SLOW,
  )

  test(
    "压缩之后:上下文从摘要开始,与压缩后那一轮的请求前缀一致",
    async () => {
      const { manager, router, events, workspace } = setup()
      router.queue("main", text("一"), text("## 摘要\n前面聊过一"), text("二"))
      router.queue("btw", text("摘要里说聊过一"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "第一轮" })
      await waitFor(() => router.of("main").length === 1 && idle(manager, session.id), 15_000, "第一轮")
      await manager.compact(session.id)
      await waitFor(() => router.of("main").length === 2 && idle(manager, session.id), 15_000, "压缩完")
      await manager.prompt(session.id, { text: "第二轮" })
      await waitFor(() => router.of("main").length === 3 && idle(manager, session.id), 15_000, "第二轮")

      const { btwID } = await manager.btw(session.id, { text: "之前聊过什么" })
      await waitForBtw(events, btwID, "done")
      const main = router.of("main").at(-1)!
      const btw = router.of("btw")[0]!
      expect(JSON.stringify(main.context.messages)).toContain("前面聊过一")
      expect(btw.context.messages.slice(0, main.context.messages.length)).toEqual(main.context.messages)
      expect(textOf(btw.context.messages[main.context.messages.length])).toBe("二")
    },
    SLOW,
  )
})

describe("/btw:附件、取消、失败", () => {
  test(
    "图片跟着问题进请求;非图片附件写进坞上的提示,不弹 kernel.error",
    async () => {
      const { manager, router, events, workspace } = setup()
      router.queue("main", text("好"))
      router.queue("btw", text("一个像素"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "你好" })
      await waitFor(() => idle(manager, session.id) && router.of("main").length === 1, 15_000, "主轮收工")

      const { btwID } = await manager.btw(session.id, {
        text: "图里是什么",
        files: [
          { mime: "image/png", url: `data:image/png;base64,${PNG}`, filename: "shot.png" },
          { mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=", filename: "manual.pdf" },
        ],
      })
      const done = await waitForBtw(events, btwID, "done")
      const last = router.of("btw")[0]!.context.messages.at(-1) as { content: Array<{ type: string }> }
      expect(last.content.filter((block) => block.type === "image")).toHaveLength(1)
      expect(done.notices).toEqual([expect.stringContaining("manual.pdf")])
      expect(done.question).toBe("图里是什么")
      expect(events.filter((event) => event.type === "kernel.error")).toEqual([])
    },
    SLOW,
  )

  test(
    "关掉就掐掉请求并推 cancelled;新的一条顶掉旧的,旧的先推 cancelled、晚到的结果不再推",
    async () => {
      const { manager, router, events, workspace } = setup()
      const signals: Array<AbortSignal | undefined> = []
      const waitAborted: FauxResponseFactory = async (_context, options) => {
        signals.push(options?.signal)
        await untilAborted(options?.signal)
        return text("晚到的答案")
      }
      router.queue("main", text("好"))
      router.queue("btw", waitAborted, waitAborted, text("第三条的答案"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "你好" })
      await waitFor(() => idle(manager, session.id), 15_000, "主轮收工")

      const first = await manager.btw(session.id, { text: "第一条" })
      await waitFor(() => signals.length === 1, 10_000, "第一条发出去")
      await manager.btwCancel(session.id, first.btwID)
      expect(signals[0]?.aborted).toBe(true)
      expect(btwEvents(events, first.btwID).at(-1)?.status).toBe("cancelled")

      await manager.btw(session.id, { text: "第二条" })
      await waitFor(() => signals.length === 2, 10_000, "第二条发出去")
      const third = await manager.btw(session.id, { text: "第三条" })
      expect(signals[1]?.aborted).toBe(true)
      await waitForBtw(events, third.btwID, "done")
      await sleep(50)

      // 事件顺序:第二条的 cancelled 在第三条的第一拍之前;晚到的答案一个字都没推出去。
      const order = btwEvents(events).map((view) => `${view.question}:${view.status}`)
      expect(order.indexOf("第二条:cancelled")).toBeLessThan(order.indexOf("第三条:thinking"))
      expect(JSON.stringify(btwEvents(events))).not.toContain("晚到的答案")
      expect(btwEvents(events, first.btwID).map((view) => view.status)).toEqual(["thinking", "cancelled"])
      // 对不上 id 的关掉什么都不做。
      await manager.btwCancel(session.id, first.btwID)
      expect(btwEvents(events, third.btwID).at(-1)?.status).toBe("done")
    },
    SLOW,
  )

  test(
    "供应商报错 → failed 带原话,不弹 kernel.error;模型想调工具 → 说一声、不执行;空问题直接拒",
    async () => {
      const { manager, router, events, workspace } = setup()
      router.queue("main", text("好"))
      router.queue(
        "btw",
        failed("503 Service Unavailable"),
        fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]),
      )
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "你好" })
      await waitFor(() => idle(manager, session.id), 15_000, "主轮收工")

      const broken = await manager.btw(session.id, { text: "会失败的" })
      const view = await waitForBtw(events, broken.btwID, "failed")
      expect(view.error).toContain("503")

      const mark = events.length
      const tooly = await manager.btw(session.id, { text: "去读一下" })
      const answered = await waitForBtw(events, tooly.btwID, "done")
      expect(answered).toMatchObject({ text: "", attemptedTool: "read" })
      // 工具没跑:没有任何工具卡片冒出来,主会话也没动。
      expect(new Set(events.slice(mark).map((event) => event.type))).toEqual(new Set(["session.btw"]))
      expect(events.filter((event) => event.type === "kernel.error")).toEqual([])

      await expect(manager.btw(session.id, { text: "   " })).rejects.toThrow(/问题/)
    },
    SLOW,
  )
})

describe("转成后台任务(fork)", () => {
  test(
    "继承主会话的上下文与问答,系统提示词与工具逐字相同;硬件与子 agent 工具被拦;跑完通知主会话",
    async () => {
      const { manager, router, events, workspace } = setup()
      router.queue("main", fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]), text("看完了"))
      router.queue("btw", text("它是入口函数"))
      router.queue(
        "fork",
        fauxAssistantMessage([
          fauxToolCall("log", { action: "ports" }),
          fauxToolCall("agent", { description: "再派一个", prompt: "CHILD: 不该派出去" }),
        ]),
        text("Scope: main.c\nResult: 入口函数,已核对"),
      )
      // 通知到了之后主会话被叫醒的那一轮。
      router.queue("main", text("收到后台任务的结论"))
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "看看 main.c" })
      await waitFor(() => router.of("main").length === 2 && idle(manager, session.id), 15_000, "主轮收工")

      const { btwID } = await manager.btw(session.id, { text: "main 是干嘛的" })
      await waitForBtw(events, btwID, "done")
      const { taskID } = await manager.btwFork(session.id, btwID)
      // 转出去之后这条顺便问就放掉了:坞上拿掉,不能再转第二次。
      expect(btwEvents(events, btwID).at(-1)?.status).toBe("cancelled")
      await expect(manager.btwFork(session.id, btwID)).rejects.toThrow()

      await waitFor(() => router.of("fork").length === 2, 15_000, "fork 跑完两次请求")
      await waitFor(() => router.of("main").length === 3 && idle(manager, session.id), 20_000, "主会话被通知叫醒并收工")

      // fork 的第一次请求:前缀就是主会话最后一次请求,系统提示词与工具逐字相同。
      const mainLast = router.of("main")[1]!
      const forkFirst = router.of("fork")[0]!
      expect(getCurrentSystemPrompt(forkFirst.context.messages)).toBe(getCurrentSystemPrompt(mainLast.context.messages))
      expect(getCurrentTools(forkFirst.context.messages)).toEqual(getCurrentTools(mainLast.context.messages))
      expect(forkFirst.context.messages.slice(0, mainLast.context.messages.length)).toEqual(mainLast.context.messages)
      const rest = forkFirst.context.messages.slice(mainLast.context.messages.length)
      expect(rest.map((message) => message.role)).toEqual(["assistant", "user", "assistant", "user"])
      expect(textOf(rest[1])).toBe("main 是干嘛的")
      expect(textOf(rest[1])).not.toContain("side question")
      expect(textOf(rest[2])).toBe("它是入口函数")
      expect(textOf(rest[3])).toContain("<fork-boilerplate>")
      expect(forkFirst.options?.reasoning).toBe(mainLast.options?.reasoning)

      // 硬件工具与子 agent 工具被拦下:结果是拒绝的话,工具没跑,也没派出新的子会话。(前面那条读 main.c 的
      // 结果是从主会话继承来的,只看 fork 自己这两次调用。)
      const forkSecond = router.of("fork")[1]!
      const results = forkSecond.context.messages
        .filter((message) => message.role === "toolResult")
        .map(textOf)
        .slice(-2)
      expect(results).toEqual([
        expect.stringContaining("cannot use hardware tools"),
        expect.stringContaining("cannot start or manage sub-agents"),
      ])
      expect(router.of("child")).toEqual([])

      // 任务:fork 类型、后台、跑完了;主会话被叫醒的那一轮里有它的通知。
      const task = manager.tasks(session.id).find((item) => item.id === taskID)!
      expect(task).toMatchObject({ agent: "fork", status: "completed", background: true })
      const woken = router.of("main")[2]!
      expect(JSON.stringify(woken.context.messages)).toContain("入口函数,已核对")
      const child = manager.get(taskID)
      expect(child).toMatchObject({ parentID: session.id, agent: "fork" })
    },
    SLOW,
  )

  test(
    "还没答完不能转;宿主不跑后台任务时不能转",
    async () => {
      const release = deferred()
      const busy = setup()
      busy.router.queue("main", text("好"))
      busy.router.queue("btw", async (_context, options) => {
        await hold(release.promise, options?.signal)
        return text("答完了")
      })
      const session = await busy.manager.create(busy.workspace)
      await busy.manager.prompt(session.id, { text: "你好" })
      await waitFor(() => idle(busy.manager, session.id), 15_000, "主轮收工")
      const pending = await busy.manager.btw(session.id, { text: "慢慢答" })
      await expect(busy.manager.btwFork(session.id, pending.btwID)).rejects.toThrow(/还没答完/)
      release.resolve()
      await waitForBtw(busy.events, pending.btwID, "done")

      const unattended = setup({ subagents: { background: false } })
      unattended.router.queue("main", text("好"))
      unattended.router.queue("btw", text("答了"))
      const other = await unattended.manager.create(unattended.workspace)
      await unattended.manager.prompt(other.id, { text: "你好" })
      await waitFor(() => idle(unattended.manager, other.id), 15_000, "主轮收工")
      const answered = await unattended.manager.btw(other.id, { text: "问一句" })
      await waitForBtw(unattended.events, answered.btwID, "done")
      await expect(unattended.manager.btwFork(other.id, answered.btwID)).rejects.toThrow(/后台/)
    },
    SLOW,
  )
})
