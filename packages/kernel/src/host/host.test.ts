/**
 * 端到端冒烟:创建会话 → 发一轮 → 断言前端真的能拿到可渲染的 transcript。
 *
 * 用 pi-ai 的 faux provider,所以不需要网络、不需要 API key、不需要 Electron ——
 * 但走的是完整的真实链路:AgentHarness → subscribe → 投影器 → StreamSink → handler 表。
 * 这一条如果绿,说明"能聊天"这件事在数据面上已经成立,剩下的只是前端接线。
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai"
import { AgentHarness } from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { createKernelHost, SessionManager } from "./index.ts"
import type { KernelEvent } from "../protocol.ts"
import type { AssistantMessage, CompactionPart, Part, Session, ToolPart } from "../types.ts"

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

let fauxCount = 0
/** 最近一次 makeHost 建的 faux provider id —— setModel 要按名字点它。 */
let currentFauxProvider = ""

/**
 * `reasoningModel` 决定 faux 的**默认模型**能不能思考:pi-ai 的
 * getSupportedThinkingLevels 对 `reasoning:false` 只给 `["off"]`,于是档位相关的
 * 断言必须挑对模型。两个模型都注册,是为了测"换模型之后档位要重新钳位"。
 */
function harnessWith(steps: unknown[], reasoningModel = false) {
  const models = createModels()
  // 每个 faux provider 用不同 id —— 同一进程里多个测试并存时不会互相路由错。
  const faux = fauxProvider({
    provider: currentFauxProvider,
    models: [
      reasoningModel ? { id: "thinker", reasoning: true } : { id: "plain" },
      reasoningModel ? { id: "plain" } : { id: "thinker", reasoning: true },
    ],
  })
  models.setProvider(faux.provider)
  faux.setResponses(steps as never)
  return { models, model: faux.getModel() as Model<string> }
}

function makeHost(
  steps: unknown[],
  options: { enginesDir?: string; workspace?: string; reasoningModel?: boolean; defaultThinkingLevel?: string } = {},
) {
  const events: KernelEvent[] = []
  const workspace = options.workspace ?? tempDir("yoma-ws-")
  currentFauxProvider = `faux-${++fauxCount}`
  const host = createKernelHost({
    sessionsRoot: tempDir("yoma-sessions-"),
    stateDir: tempDir("yoma-state-"),
    enginesDir: options.enginesDir,
    // 隔离掉开发机真实的 ~/.yoma:不传的话技能与上下文文件发现会去读它,
    // 测试结果就取决于跑测试的人机器上装了什么技能。
    configDir: tempDir("yoma-config-"),
    version: "test",
    defaultThinkingLevel: options.defaultThinkingLevel,
    onEvents: (batch) => events.push(...batch),
    // 全放行,免得冒烟测试卡在权限弹窗上。权限本身有独立测试。
    resolveModels: async () => harnessWith(steps, options.reasoningModel),
  })
  return { host, events, workspace }
}

/**
 * 直接开一个 SessionManager。
 *
 * 并发、销毁、执行环境回收这几条只能从这一层看:它们全在 RPC 表下面,而且要能在
 * 同一个实例上 disposeAll 完再把同一个会话重新打开(host 的 dispose 是一次性的)。
 */
function makeManager(steps: unknown[]) {
  const events: KernelEvent[] = []
  currentFauxProvider = `faux-${++fauxCount}`
  const manager = new SessionManager({
    sessionsRoot: tempDir("yoma-sessions-"),
    // 隔离开发机真实的 ~/.yoma —— 和 makeHost 同一条理由。
    configDir: tempDir("yoma-config-"),
    emit: (batch) => events.push(...batch),
    resolveModels: async () => harnessWith(steps),
  })
  return { manager, events, workspace: tempDir("yoma-ws-") }
}

/**
 * 数 harness 建了几个,并抓住 prompt() 真正递给 lane.drive 的选项。
 *
 * 为什么要数:同一个会话并发打开两次,表现不是报错而是两套 harness / 两条 lane 压在
 * 一个 entry 上,事件从此只走其中一条。为什么要看 drive 选项:pollDeferred 漏掉的话
 * deferred 操作会让 drive 提前带着 kind:"waiting" 回来,run_end 永远不来,状态永久 busy。
 */
function spyHarness() {
  const original = AgentHarness.create
  const created: unknown[] = []
  const driveOptions: Array<Record<string, unknown>> = []
  AgentHarness.create = (async (options: never, context: never) => {
    const result = await original(options, context)
    created.push(result.harness)
    const lane = result.harness.lane.bind(result.harness)
    ;(result.harness as { lane: unknown }).lane = async (name: never, laneContext: never) => {
      const got = await lane(name, laneContext)
      const drive = got.drive.bind(got)
      ;(got as { drive: unknown }).drive = (driven: Record<string, unknown>, driveContext: never) => {
        driveOptions.push(driven)
        return drive(driven as never, driveContext)
      }
      return got
    }
    return result
  }) as typeof AgentHarness.create
  return {
    count: () => created.length,
    driveOptions,
    reset: () => {
      created.length = 0
      driveOptions.length = 0
    },
    restore: () => {
      AgentHarness.create = original
    },
  }
}

/** 手搓一条可重试的失败响应 —— faux 的 step 可以直接是一条 AssistantMessage。 */
function fauxRetryableError(errorMessage = "503 Service Unavailable") {
  return {
    role: "assistant",
    content: [],
    api: "faux",
    provider: "faux",
    model: "faux",
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

/** transcript 里那条压缩分隔线(手动/自动的唯一可观测面)。 */
function compactionPartOf(page: { items: Array<{ parts: Part[] }> }): CompactionPart | undefined {
  return page.items.flatMap((item) => item.parts.filter((part) => part.type === "compaction"))[0] as
    | CompactionPart
    | undefined
}

/** 会话状态的时间序列。重试测试靠它断言"中间不能出现 idle"。 */
function statusesOf(events: KernelEvent[]): string[] {
  return events.flatMap((event) => (event.type === "session.status" ? [event.status.type] : []))
}

/** 等到某个条件成立或超时 —— 一轮对话是异步的,prompt() 立刻返回。 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("内核宿主端到端", () => {
  test("创建会话 → 发一轮 → 拿到可渲染的 transcript", async () => {
    const { host, events, workspace } = makeHost([fauxAssistantMessage([fauxText("4")])])

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    expect(session.directory).toBe(workspace)

    await host.handle("session.prompt", { sessionID: session.id, input: { text: "2+2 等于几?" } })

    await waitFor(() =>
      events.some((e) => e.type === "message.updated" && e.message.role === "assistant" && "error" in e.message === false),
    )
    await waitFor(() => {
      const parts = events.flatMap((e) => (e.type === "message.part.updated" ? [e.part] : []))
      return parts.some((part) => part.type === "text" && part.text.includes("4"))
    })

    const page = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: { role: string }; parts: Part[] }>
    }
    const roles = page.items.map((item) => item.info.role)
    expect(roles).toContain("user")
    expect(roles).toContain("assistant")

    // 顺序不变式:每个 part 的父消息必须先出现过。
    const seen = new Set<string>()
    for (const event of events) {
      if (event.type === "message.updated") seen.add(event.message.id)
      if (event.type === "message.part.updated") expect(seen.has(event.part.messageID)).toBe(true)
    }

    await host.dispose()
  }, 20_000)

  test("工具调用走完整状态机,结果落在同一个 ToolPart 上", async () => {
    const { host, events, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })]),
      fauxAssistantMessage([fauxText("读完了")]),
    ])

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "读一下 README" } })

    await waitFor(() => {
      const tools = events.flatMap((e) =>
        e.type === "message.part.updated" && e.part.type === "tool" ? [e.part as ToolPart] : [],
      )
      return tools.some((part) => part.state.status === "completed" || part.state.status === "error")
    }, 10_000)

    const tools = events.flatMap((e) =>
      e.type === "message.part.updated" && e.part.type === "tool" ? [e.part as ToolPart] : [],
    )
    // 同一个 callID 从头到尾只对应一个 part id —— 换了就说明配对逻辑漏了。
    const byCall = new Map<string, Set<string>>()
    for (const part of tools) {
      if (!byCall.has(part.callID)) byCall.set(part.callID, new Set())
      byCall.get(part.callID)!.add(part.id)
    }
    for (const ids of byCall.values()) expect(ids.size).toBe(1)

    await host.dispose()
  }, 20_000)

  test("一轮结束后 transcript 落盘且能再读回来", async () => {
    const { host, events, workspace } = makeHost([fauxAssistantMessage([fauxText("记住了")])])
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "记住:VDD 是 3.3V" } })

    await waitFor(() => events.some((e) => e.type === "message.updated" && e.message.role === "assistant"), 8000)

    const page = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    expect(page.items.length).toBeGreaterThanOrEqual(2)

    // 会话列表能看到它,而且目录对得上 —— 列表是懒加载标题的那条路径。
    const listed = (await host.handle("session.list", { directory: workspace })) as Session[]
    expect(listed.some((item) => item.id === session.id)).toBe(true)

    await host.dispose()
  }, 20_000)

  test("app.info 报告真实的 runtime 与 engines 位置", async () => {
    const { host } = makeHost([])
    const info = (await host.handle("app.info", undefined)) as { node: string; version: string }
    expect(info.node).toBe(process.versions.node)
    expect(info.version).toBe("test")
    await host.dispose()
  })
})

/**
 * 手动压缩与"改上一条重发"。
 *
 * 两条都是**只有内核的结构性操作能做到**的事(compaction entry / 挪会话树的 tip),
 * 而它们的状态与 transcript 都只经事件流到前端 —— 所以端到端钉住,不测内部字段。
 */
describe("结构性操作", () => {
  test("手动压缩:状态走 compacting → idle,transcript 上留下压缩分隔线", async () => {
    const { host, events, workspace } = makeHost([
      fauxAssistantMessage([fauxText("一")]),
      fauxAssistantMessage([fauxText("## 摘要\n前面聊过一")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "第一轮" } })
    await waitFor(() => statusesOf(events).at(-1) === "idle")
    events.length = 0

    await host.handle("session.compact", { sessionID: session.id })
    await waitFor(() => statusesOf(events).at(-1) === "idle")
    expect(statusesOf(events)).toEqual(["compacting", "idle"])

    const page = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    expect(page.items.flatMap((item) => item.parts.map((part) => part.type))).toContain("compaction")
    await host.dispose()
  }, 20_000)

  test("navigate:原文交还输入框,被抛下那半条 transcript 不再回来", async () => {
    const { host, events, workspace } = makeHost([
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "问题一" } })
    await waitFor(() => statusesOf(events).at(-1) === "idle")
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "问题二" } })
    await waitFor(
      () => events.some((e) => e.type === "message.part.updated" && e.part.type === "text" && e.part.text === "回答二"),
      10_000,
    )
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    const before = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    const second = before.items.find((item) =>
      item.parts.some((part) => part.type === "text" && part.text === "问题二"),
    )!
    const result = (await host.handle("session.navigate", {
      sessionID: session.id,
      messageID: second.info.id,
    })) as { editorText: string }
    expect(result.editorText).toBe("问题二")

    const after = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    expect(after.items.flatMap((item) => item.parts.map((part) => (part.type === "text" ? part.text : "")))).toEqual([
      "问题一",
      "回答一",
    ])
    await host.dispose()
  }, 20_000)
})

describe("会话不存在", () => {
  test("抛的是结构化错误,前端才分得清'删掉失效标签页'和'致命错误'", async () => {
    // 回归测试:换内核之后打开上个版本残留的标签页(opencode 的 id 是 ses_xxx,
    // 新内核是 UUID)曾经让整个 app 崩到错误页 —— 因为错误跨进程之后只剩一个字符串,
    // 前端的 isSessionNotFoundError() 按 _tag 匹配不上,只能当致命错误处理。
    const { host } = makeHost([])
    const stale = "ses_0782e21dcffeVJ7ABHrFJZUvCm"

    let caught: unknown
    try {
      await host.handle("session.get", { sessionID: stale })
    } catch (error) {
      caught = error
    }

    const data = (caught as { data?: { _tag?: string; sessionID?: string } })?.data
    expect(data?._tag).toBe("SessionNotFoundError")
    expect(data?.sessionID).toBe(stale)
    await host.dispose()
  })
})

describe("轮级自动重试", () => {
  test("可重试的 provider 失败会自己再试一次,且整段是一个连续的 busy", async () => {
    const { host, events, workspace } = makeHost([
      fauxRetryableError("503 Service Unavailable"),
      fauxAssistantMessage([fauxText("这次成了")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session

    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "message.part.updated" && e.part.type === "text" && e.part.text.includes("这次成了"),
        ),
      20_000,
    )
    await waitFor(() => statusesOf(events).at(-1) === "idle", 20_000)

    // 关键不变式:整段重试是**一个连续的 busy**。若退避窗口里漏出 idle,重试那一轮的
    // turn_start 会把状态推回 busy,序列里就会出现 idle→busy 的回跳 —— 而那正是
    // bench 判"这一轮跑完了"去跑判据、同时 agent 正要重试、两边同时动板子的时刻。
    const statuses = statusesOf(events)
    expect(statuses).toEqual(["busy", "idle"])
    await host.dispose()
  }, 30_000)

  test("上下文溢出:压缩后重试一次,中间不漏 idle", async () => {
    const { host, events, workspace } = makeHost([
      fauxAssistantMessage([fauxText("第一轮")]),
      fauxRetryableError("prompt is too long: 210000 tokens > 200000 maximum"),
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("恢复了")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session

    // 第一轮塞够内容,压缩才有东西可切。
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "x".repeat(120_000) } })
    await waitFor(() => statusesOf(events).at(-1) === "idle", 20_000)
    events.length = 0

    await host.handle("session.prompt", { sessionID: session.id, input: { text: "继续" } })
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "message.part.updated" && e.part.type === "text" && e.part.text.includes("恢复了"),
        ),
      20_000,
    )
    await waitFor(() => statusesOf(events).at(-1) === "idle", 20_000)

    expect(statusesOf(events)).toEqual(["busy", "compacting", "busy", "idle"])
    await host.dispose()
  }, 30_000)

  test("不可重试的失败(认证错)不重试,直接落 idle", async () => {
    const { host, events, workspace } = makeHost([fauxRetryableError("401 invalid api key")])
    const session = (await host.handle("session.create", { directory: workspace })) as Session

    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    // 只有一次模型调用:没有被重试。
    expect(statusesOf(events)).toEqual(["busy", "idle"])
    await host.dispose()
  })
})

describe("项目资源发现", () => {
  test("工作目录的 AGENTS.md 会进系统提示词 —— 与 Zed 里看到的是同一份项目上下文", async () => {
    const workspace = tempDir("yoma-ws-")
    writeFileSync(path.join(workspace, "AGENTS.md"), "本项目的板子是 STM32G474,烧录前必须先 make。")

    let systemPrompt = ""
    const { host } = makeHost(
      [
        (context: { systemPrompt?: string }) => {
          systemPrompt = context?.systemPrompt ?? ""
          return fauxAssistantMessage([fauxText("好")])
        },
      ],
      { workspace },
    )
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => systemPrompt !== "")

    expect(systemPrompt).toContain("STM32G474")
    await host.dispose()
  })

  test("<cwd>/.agents/skills 里的技能会被发现并列进系统提示词", async () => {
    const workspace = tempDir("yoma-ws-")
    mkdirSync(path.join(workspace, ".agents", "skills", "can-debug"), { recursive: true })
    writeFileSync(
      path.join(workspace, ".agents", "skills", "can-debug", "SKILL.md"),
      "---\nname: can-debug\ndescription: CAN 总线掉帧的排查步骤\n---\n\n先看 RX FIFO 溢出计数。\n",
    )

    let systemPrompt = ""
    const { host } = makeHost(
      [
        (context: { systemPrompt?: string }) => {
          systemPrompt = context?.systemPrompt ?? ""
          return fauxAssistantMessage([fauxText("好")])
        },
      ],
      { workspace },
    )
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => systemPrompt !== "")

    expect(systemPrompt).toContain("can-debug")
    expect(systemPrompt).toContain("CAN 总线掉帧")
    await host.dispose()
  })
})

/**
 * 思考档位。
 *
 * 钉的是**真的发出去的那个 reasoning 参数** —— 不是 harness 内部字段。yoma 把
 * `"off"` 翻译成"请求里不带 reasoning"(agent-harness.ts:429),所以只有从 provider
 * 这一侧看才知道模型到底思不思考。实测代价见 `../thinking.ts` 的头注释。
 */
describe("思考档位", () => {
  /** 抓住本轮真正传给 provider 的 reasoning 档位。 */
  function capturing(): { steps: unknown[]; seen: () => { called: boolean; reasoning?: string } } {
    let called = false
    let reasoning: string | undefined
    return {
      steps: [
        (_context: unknown, options: { reasoning?: string } | undefined) => {
          called = true
          reasoning = options?.reasoning
          return fauxAssistantMessage([fauxText("好")])
        },
      ],
      seen: () => ({ called, reasoning }),
    }
  }

  test("宿主不表态时保持 yoma 的默认(off)", async () => {
    const capture = capturing()
    const { host, workspace } = makeHost(capture.steps, { reasoningModel: true })
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => capture.seen().called)

    expect(capture.seen().reasoning).toBeUndefined()
    await host.dispose()
  })

  test("宿主给了默认档位 → reasoning 模型真的带着它发请求", async () => {
    const capture = capturing()
    const { host, workspace } = makeHost(capture.steps, { reasoningModel: true, defaultThinkingLevel: "high" })
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => capture.seen().called)

    expect(capture.seen().reasoning).toBe("high")
    await host.dispose()
  })

  test("非 reasoning 模型落回 off —— 默认档位不会被硬塞给不支持的模型", async () => {
    const capture = capturing()
    const { host, workspace } = makeHost(capture.steps, { defaultThinkingLevel: "high" })
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => capture.seen().called)

    expect(capture.seen().reasoning).toBeUndefined()
    await host.dispose()
  })

  test("setModel 换到不支持该档的模型时重新钳位 —— 构造期那次是按默认模型算的", async () => {
    // 这是 bench 的真实路径:harness 构造时用的是 ensureModels() 的默认模型(可能
    // 支持 high),紧接着 setModel 换成任务书钉的那个(可能一档都不支持)。不重钳
    // 就会拿着旧模型的档位去发新模型的请求,而报错要等到 provider 那边才出现。
    const capture = capturing()
    const { host, workspace } = makeHost(capture.steps, { reasoningModel: true, defaultThinkingLevel: "high" })
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.setModel", {
      sessionID: session.id,
      providerID: currentFauxProvider,
      modelID: "plain",
    })
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => capture.seen().called)

    expect(capture.seen().reasoning).toBeUndefined()
    await host.dispose()
  })

  test("显式档位压过宿主默认,包括显式关掉", async () => {
    const capture = capturing()
    const { host, workspace } = makeHost(capture.steps, { reasoningModel: true, defaultThinkingLevel: "high" })
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.setModel", {
      sessionID: session.id,
      providerID: currentFauxProvider,
      modelID: "thinker",
      thinking: "off",
    })
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "你好" } })
    await waitFor(() => capture.seen().called)

    expect(capture.seen().reasoning).toBeUndefined()
    await host.dispose()
  })
})

/**
 * 会话装配与销毁的并发。
 *
 * 这一组全是**静默**的故障:并发打开要么炸在内核的 `Session is already open`(前端看到
 * 一个英文异常),要么交出一个 projection 还没装好的会话(messages/navigate TypeError,
 * prompt 整轮事件丢光)。所以只能在这一层钉住。
 */
describe("并发装配与生命周期", () => {
  test("同一 tick 两次 messages():只开一个 harness,两边都拿得到投影", async () => {
    const spy = spyHarness()
    try {
      const { manager, events, workspace } = makeManager([fauxAssistantMessage([fauxText("好")])])
      const session = await manager.create(workspace)
      await manager.messages(session.id)
      // 让会话彻底变冷:下一次 ensureOpen 必须重新走 repo.open —— 那正是
      // 并发装配会撞上 `Session is already open` 的地方。
      await manager.disposeAll()
      spy.reset()

      const [first, second] = await Promise.all([manager.messages(session.id), manager.messages(session.id)])
      expect(spy.count()).toBe(1)
      expect(first.items).toEqual(second.items)

      // 装配真的完整:紧接着一轮对话,事件与 transcript 都只有一份。
      await manager.prompt(session.id, { text: "你好" })
      await waitFor(() => statusesOf(events).at(-1) === "idle")
      const page = await manager.messages(session.id)
      const ids = page.items.map((item) => item.info.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(page.items.map((item) => item.info.role)).toEqual(["user", "assistant"])

      await manager.disposeAll()
    } finally {
      spy.restore()
    }
  }, 20_000)

  test("dispose 还在收尾时 messages():等它关完再重开,拿不到半关的会话", async () => {
    const { manager, workspace } = makeManager([
      fauxAssistantMessage([fauxText("一")]),
      fauxAssistantMessage([fauxText("二")]),
    ])
    const session = await manager.create(workspace)
    // 一轮还在飞的时候销毁:dispose 要先中断它,这段时间足够让下一个调用挤进来。
    await manager.prompt(session.id, { text: "第一轮" })

    const order: string[] = []
    const closing = manager.disposeAll().then(() => order.push("closed"))
    const page = await manager.messages(session.id).then((value) => {
      order.push("reopened")
      return value
    })
    await closing

    // 关完才重开 —— 反过来的话交出去的 entry 订阅已经摘了、lane 马上被清空。
    expect(order).toEqual(["closed", "reopened"])
    expect(page.items.some((item) => item.info.role === "user")).toBe(true)
    // 重开之后照样能接着聊。
    await manager.prompt(session.id, { text: "第二轮" })
    await manager.disposeAll()
  }, 20_000)

  test("refreshMachineEnv 换下来的执行环境也会被 cleanup —— 装工具链之前起的子进程不许活过会话", async () => {
    const cleanup = vi.spyOn(NodeExecutionEnv.prototype, "cleanup")
    try {
      const { manager, events, workspace } = makeManager([
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo 一" })]),
        fauxAssistantMessage([fauxText("好")]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo 二" })]),
        fauxAssistantMessage([fauxText("好")]),
      ])
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "第一次" })
      await waitFor(() => statusesOf(events).at(-1) === "idle", 15_000)

      cleanup.mockClear()
      await manager.refreshMachineEnv()
      // 换过环境之后再跑一轮:这一轮用的是新造的那个 env。
      await manager.prompt(session.id, { text: "第二次" })
      await waitFor(() => statusesOf(events).filter((status) => status === "idle").length >= 2, 15_000)

      await manager.disposeAll()
      // 退役那个 + 当前那个,两个都要收。只收当前那个的话,刷新之前起的子进程会活下来。
      expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      cleanup.mockRestore()
    }
  }, 30_000)
})

describe("状态机不被旁路事件带偏", () => {
  test("监听器抛异常只报 kernel.error —— 不许把还在跑的这一轮说成 idle", async () => {
    // 真实形态:renderer 侧某个 reducer 抛了,内核回一条 handler_error。它对这一轮
    // 什么都没说,可这里曾经拿它当失败处理 → 状态硬改 idle,下一条 prompt 撞 LaneBusy。
    const events: KernelEvent[] = []
    let thrown = false
    currentFauxProvider = `faux-${++fauxCount}`
    const manager = new SessionManager({
      sessionsRoot: tempDir("yoma-sessions-"),
      configDir: tempDir("yoma-config-"),
      emit: (batch) => {
        events.push(...batch)
        if (!thrown && batch.some((event) => event.type === "message.part.updated" && event.part.type === "tool")) {
          thrown = true
          throw new Error("renderer 的 reducer 挂了")
        }
      },
      resolveModels: async () =>
        harnessWith([
          fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })]),
          fauxAssistantMessage([fauxText("读完了")]),
          fauxAssistantMessage([fauxText("第二轮")]),
        ]),
    })
    const workspace = tempDir("yoma-ws-")
    const session = await manager.create(workspace)

    await manager.prompt(session.id, { text: "读一下 README" })
    await waitFor(() => statusesOf(events).at(-1) === "idle", 15_000)

    expect(thrown).toBe(true)
    expect(events.some((event) => event.type === "kernel.error" && event.message.includes("事件处理失败"))).toBe(true)
    // idle 只能在这一轮真的说完之后出现。
    const idleAt = events.findIndex((event) => event.type === "session.status" && event.status.type === "idle")
    const doneAt = events.findIndex(
      (event) => event.type === "message.part.updated" && event.part.type === "text" && event.part.text.includes("读完了"),
    )
    expect(doneAt).toBeGreaterThanOrEqual(0)
    expect(idleAt).toBeGreaterThan(doneAt)
    expect(statusesOf(events)).toEqual(["busy", "idle"])

    // 最关键的一条:状态没被说谎,所以下一轮还发得出去。
    await manager.prompt(session.id, { text: "再来一轮" })
    await waitFor(() => statusesOf(events).filter((status) => status === "idle").length >= 2, 15_000)
    await manager.disposeAll()
  }, 30_000)

  test("prompt 的 drive 同时带 waitForRetry 与 pollDeferred;idle 上 abort 立刻返回", async () => {
    const spy = spyHarness()
    try {
      const { manager, events, workspace } = makeManager([fauxAssistantMessage([fauxText("好")])])
      const session = await manager.create(workspace)
      await manager.messages(session.id)
      // 空闲的 lane 上中断:requestAbort 之后没有在飞操作,waitForIdle 必须立刻回来。
      await manager.abort(session.id)

      await manager.prompt(session.id, { text: "你好" })
      await waitFor(() => statusesOf(events).at(-1) === "idle")
      expect(spy.driveOptions[0]).toMatchObject({ waitForRetry: true, pollDeferred: true })
      await manager.disposeAll()
    } finally {
      spy.restore()
    }
  }, 20_000)

  test("一轮跑着的时候 abort:回得来,状态落 idle", async () => {
    const { manager, events, workspace } = makeManager([
      fauxRetryableError("503 Service Unavailable"),
      fauxAssistantMessage([fauxText("这次成了")]),
    ])
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "你好" })
    await waitFor(() => statusesOf(events).at(-1) === "busy")

    await manager.abort(session.id)
    expect(manager.status(session.id)).toEqual({ type: "idle" })
    await manager.disposeAll()
  }, 20_000)
})

describe("压缩", () => {
  test("手动压缩的 auto 标记要落盘 —— live 与重放必须给出同一条分隔线", async () => {
    // CompactionEntry 没有"为什么压缩"这个字段,所以 host 自己补一条 yoma/compaction
    // entry。不补的话 live 是手动、重放变自动,同一个 part 两副面孔。
    const { manager, events, workspace } = makeManager([
      fauxAssistantMessage([fauxText("一")]),
      fauxAssistantMessage([fauxText("## 摘要\n前面聊过一")]),
    ])
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "第一轮" })
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    await manager.compact(session.id)
    await waitFor(() => statusesOf(events).at(-1) === "idle")
    const live = compactionPartOf(await manager.messages(session.id))
    expect(live?.auto).toBe(false)

    // 重开一次 —— 整条历史按重放那条路再投影一遍。
    await manager.disposeAll()
    const replayed = compactionPartOf(await manager.messages(session.id))
    expect(replayed?.auto).toBe(false)
    expect({ ...replayed, id: "", messageID: "" }).toEqual({ ...live, id: "", messageID: "" })
    await manager.disposeAll()
  }, 30_000)

  test("没东西可压时报的是中文 —— 内核的英文错误不许直接摆给用户", async () => {
    const { manager, workspace } = makeManager([])
    const session = await manager.create(workspace)
    await expect(manager.compact(session.id)).rejects.toThrow(/当前没有可压缩的内容/)
    await manager.disposeAll()
  }, 20_000)

  test("忙着的时候压缩:先中断这一轮再压,不是甩一个 LaneBusy 出来", async () => {
    const { manager, events, workspace } = makeManager([
      fauxAssistantMessage([fauxText("一")]),
      fauxRetryableError("503 Service Unavailable"),
      fauxAssistantMessage([fauxText("## 摘要\n前面聊过一")]),
    ])
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "第一轮" })
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    // 第二轮进退避(waitForRetry 把它留在一段连续的 busy 里),这时候点压缩。
    await manager.prompt(session.id, { text: "第二轮" })
    await waitFor(() => statusesOf(events).at(-1) === "busy")
    await manager.compact(session.id)
    await waitFor(() => statusesOf(events).at(-1) === "idle", 20_000)

    expect(compactionPartOf(await manager.messages(session.id))?.auto).toBe(false)
    expect(manager.status(session.id)).toEqual({ type: "idle" })
    await manager.disposeAll()
  }, 30_000)
})

describe("navigate 的 removed 事件", () => {
  test("被抛下那条分支逐条发 message.removed,而且排在 session.updated 之前", async () => {
    // 前端的消息集合只增不减(按 id 二分维护)。只发 session.updated 的话 renderer
    // 不会重拉,被抛下那半条 transcript 会一直留在屏幕上。
    const { host, events, workspace } = makeHost([
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "问题一" } })
    await waitFor(() => statusesOf(events).at(-1) === "idle")
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "问题二" } })
    await waitFor(
      () => events.some((e) => e.type === "message.part.updated" && e.part.type === "text" && e.part.text === "回答二"),
      10_000,
    )
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    const before = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    const second = before.items.find((item) => item.parts.some((part) => part.type === "text" && part.text === "问题二"))!
    const dropped = before.items.slice(before.items.indexOf(second)).map((item) => item.info.id)
    expect(dropped.length).toBe(2)

    events.length = 0
    await host.handle("session.navigate", { sessionID: session.id, messageID: second.info.id })
    // 事件走 StreamSink,按帧成批推 —— 等那一批真的到了再断言。
    await waitFor(() => events.some((event) => event.type === "session.updated"))

    const removed = events.flatMap((event) => (event.type === "message.removed" ? [event.messageID] : []))
    expect(removed.sort()).toEqual([...dropped].sort())
    const updatedAt = events.findIndex((event) => event.type === "session.updated")
    const lastRemovedAt = events.findLastIndex((event) => event.type === "message.removed")
    expect(updatedAt).toBeGreaterThan(lastRemovedAt)

    const after = (await host.handle("session.messages", { sessionID: session.id })) as {
      items: Array<{ info: AssistantMessage; parts: Part[] }>
    }
    expect(after.items.map((item) => item.info.id)).toEqual(before.items.slice(0, 2).map((item) => item.info.id))
    await host.dispose()
  }, 30_000)
})
