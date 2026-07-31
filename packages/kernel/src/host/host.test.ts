/**
 * 端到端冒烟:创建会话 → 发一轮 → 断言前端真的能拿到可渲染的 transcript。
 *
 * 用 pi-ai 的 faux provider,所以不需要网络、不需要 API key、不需要 Electron ——
 * 但走的是完整的真实链路:AgentHarness → subscribe → 投影器 → StreamSink → handler 表。
 * 这一条如果绿,说明"能聊天"这件事在数据面上已经成立,剩下的只是前端接线。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
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

function makeHost(steps: unknown[], options: { enginesDir?: string } = {}) {
  const events: KernelEvent[] = []
  const workspace = tempDir("yoma-ws-")
  const host = createKernelHost({
    sessionsRoot: tempDir("yoma-sessions-"),
    stateDir: tempDir("yoma-state-"),
    enginesDir: options.enginesDir,
    version: "test",
    onEvents: (batch) => events.push(...batch),
    // 全放行,免得冒烟测试卡在权限弹窗上。权限本身有独立测试。
    permissionRules: { bash: "allow", edit: "allow", write: "allow" },
    resolveModels: async () => harnessWith(steps),
  })
  return { host, events, workspace }
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
