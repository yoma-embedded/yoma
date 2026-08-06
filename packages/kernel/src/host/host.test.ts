/**
 * 端到端冒烟:创建会话 → 发一轮 → 断言前端真的能拿到可渲染的 transcript。
 *
 * 用 pi-ai 的 faux provider,所以不需要网络、不需要 API key、不需要 Electron ——
 * 但走的是完整的真实链路:AgentHarness → subscribe → 投影器 → StreamSink → handler 表。
 * 这一条如果绿,说明"能聊天"这件事在数据面上已经成立,剩下的只是前端接线。
 */
import { afterEach, describe, expect, test } from "bun:test"
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

import { createKernelHost } from "./index.ts"
import type { KernelEvent } from "../protocol.ts"
import type { AssistantMessage, Part, Session, ToolPart } from "../types.ts"

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

function harnessWith(steps: unknown[]) {
  const models = createModels()
  // 每个 faux provider 用不同 id —— 同一进程里多个测试并存时不会互相路由错。
  const faux = fauxProvider({ provider: `faux-${++fauxCount}` })
  models.setProvider(faux.provider)
  faux.setResponses(steps as never)
  return { models, model: faux.getModel() as Model<string> }
}

function makeHost(steps: unknown[], options: { enginesDir?: string; workspace?: string } = {}) {
  const events: KernelEvent[] = []
  const workspace = options.workspace ?? tempDir("yoma-ws-")
  const host = createKernelHost({
    sessionsRoot: tempDir("yoma-sessions-"),
    stateDir: tempDir("yoma-state-"),
    enginesDir: options.enginesDir,
    // 隔离掉开发机真实的 ~/.my-pi:不传的话技能与上下文文件发现会去读它,
    // 测试结果就取决于跑测试的人机器上装了什么技能。
    configDir: tempDir("yoma-config-"),
    version: "test",
    onEvents: (batch) => events.push(...batch),
    // 全放行,免得冒烟测试卡在权限弹窗上。权限本身有独立测试。
    permissionRules: { bash: "allow", edit: "allow", write: "allow" },
    resolveModels: async () => harnessWith(steps),
  })
  return { host, events, workspace }
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
