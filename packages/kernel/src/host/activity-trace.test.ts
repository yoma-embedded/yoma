/**
 * 状态行与调试轨迹的端到端(docs/调试留痕-规划-20260924.md §2.2、§3):faux 模型真跑一轮,
 * 核 `session.status` 里的 activity 序列与 trace.jsonl 的事件序列。
 *
 * 直接开 SessionManager 而不是整个 host:它的 emit 不经 StreamSink,相邻的两条 busy 不会被合并,阶段序列是确定的
 * (合并本身在 stream.test.ts 里单测)。faux 不走 fetch,所以这里没有 http.* 行 —— 那一层在 test/model-probe.test.ts。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai"

import { SessionManager } from "./session-manager.ts"
import { parseSession, parseTrace, renderReport } from "./trace/report.ts"
import { createTrace } from "./trace/sink.ts"
import type { KernelEvent } from "../protocol.ts"
import type { SessionActivity, SessionStatus } from "../types.ts"
import { patient } from "../../test/patience.ts"

beforeAll(() => {
  // 确认门那条会碰到探针命令(拒掉,不真跑);照 host.test.ts 隔离跨进程的探针锁。
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

let fauxCount = 0
function makeManager(steps: unknown[], options: { confirmTools?: boolean; tokensPerSecond?: number } = {}) {
  // 开发机上设过这两个变量也不许影响断言
  vi.stubEnv("YOMA_TRACE", "")
  vi.stubEnv("YOMA_TRACE_FILE", "")
  const events: KernelEvent[] = []
  const traceFile = path.join(tempDir("yoma-trace-"), "trace.jsonl")
  const trace = createTrace({ file: traceFile })
  const provider = `faux-activity-${++fauxCount}`
  const sessionsRoot = tempDir("yoma-sessions-")
  const manager = new SessionManager({
    sessionsRoot,
    configDir: tempDir("yoma-config-"),
    defaultThinkingLevel: "high",
    confirmTools: options.confirmTools,
    trace,
    emit: (batch) => events.push(...batch),
    resolveModels: async () => {
      const models = createModels()
      const faux = fauxProvider({
        provider,
        models: [{ id: "thinker", reasoning: true }],
        ...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
      })
      models.setProvider(faux.provider)
      faux.setResponses(steps as never)
      return { models, model: faux.getModel() as Model<string> }
    },
  })
  return { manager, events, trace, traceFile, sessionsRoot, workspace: tempDir("yoma-ws-") }
}

/** 会话文件:上游 repo 按 `<sessionsRoot>/<工程目录编码>/<时间>_<id>.jsonl` 放。 */
function sessionFileOf(sessionsRoot: string, id: string): string {
  for (const project of readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, project)
    const name = readdirSync(dir).find((file) => file.endsWith(`_${id}.jsonl`))
    if (name) return path.join(dir, name)
  }
  throw new Error(`会话文件不在 ${sessionsRoot}`)
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(timeoutMs)) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function statuses(events: KernelEvent[], sessionID: string): SessionStatus[] {
  return events.flatMap((event) =>
    event.type === "session.status" && event.sessionID === sessionID ? [event.status] : [],
  )
}

/** busy 写成它的阶段,其余写 type。 */
function phases(events: KernelEvent[], sessionID: string): string[] {
  return statuses(events, sessionID).map((status) =>
    status.type === "busy" ? (status.activity?.phase ?? "busy") : status.type,
  )
}

function activities(events: KernelEvent[], sessionID: string): SessionActivity[] {
  return statuses(events, sessionID).flatMap((status) =>
    status.type === "busy" && status.activity ? [status.activity] : [],
  )
}

function traceLines(file: string): Array<Record<string, unknown> & { ev: string }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const thinkThenList = () => [
  fauxAssistantMessage([fauxThinking("先列一下目录"), fauxToolCall("ls", { path: "." })]),
  fauxAssistantMessage([fauxText("目录是空的")]),
]

// 回复底下的耗时 = 最后一条回复的 time.completed − 用户消息的时刻。从前 completed 是回复开始请求的时刻,单步回复恒为「0秒」。
describe("回复写完的时刻", () => {
  test("live:回复的 time.completed 是 message_end 那一刻,不是开始请求的时刻", async () => {
    // 慢慢吐字:四百个字按每秒两百 token 流完要半秒上下
    const { manager, events, workspace } = makeManager([fauxAssistantMessage([fauxText("好".repeat(400))])], {
      tokensPerSecond: 200,
    })
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "说句话" })
      await waitFor(() => phases(events, session.id).at(-1) === "idle")
      const reply = events
        .flatMap((event) =>
          event.type === "message.updated" && event.message.sessionID === session.id && event.message.role === "assistant"
            ? [event.message]
            : [],
        )
        .at(-1)!
      expect(reply.time.completed).toBeDefined()
      expect(reply.time.completed! - reply.time.created).toBeGreaterThanOrEqual(200)
    } finally {
      await manager.disposeAll()
    }
  }, 20_000)
})

describe("状态行:session.status 里的 activity", () => {
  test("一轮的阶段序列:等模型 → 思考 → 写调用 → 跑工具 → 等模型 → 正文 → 空闲", async () => {
    const { manager, events, workspace } = makeManager(thinkThenList())
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "看看目录" })
      await waitFor(() => phases(events, session.id).at(-1) === "idle")

      expect(phases(events, session.id)).toEqual(["waiting", "thinking", "calling", "tools", "waiting", "writing", "idle"])
      const all = activities(events, session.id)
      expect(all[2]).toMatchObject({ phase: "calling", tool: "ls" })
      expect(all[3]).toMatchObject({ phase: "tools", tools: ["ls"] })
      // since 只往前走(界面按它走表,倒退就是负的时长)
      for (let i = 1; i < all.length; i++) expect(all[i]!.since).toBeGreaterThanOrEqual(all[i - 1]!.since)
      // 空闲时 status 不带 activity;RPC 问现状也是
      expect(await manager.status(session.id)).toEqual({ type: "idle" })
    } finally {
      await manager.disposeAll()
    }
  }, 20_000)

  test("确认条挂起时阶段是 confirm;拒绝后回到等模型,被拒的调用以错误收场", async () => {
    const command = "openocd -f interface/stlink.cfg -c 'init; exit'"
    const { manager, events, workspace } = makeManager(
      [fauxAssistantMessage([fauxToolCall("bash", { command })]), fauxAssistantMessage([fauxText("好,不跑")])],
      { confirmTools: true },
    )
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "连一下探针" })
      await waitFor(() => manager.pendingConfirms(session.id).length > 0)
      expect(activities(events, session.id).at(-1)).toMatchObject({ phase: "confirm", tool: "bash" })

      expect(manager.replyConfirm(manager.pendingConfirms(session.id)[0]!.id, false)).toBe(true)
      await waitFor(() => phases(events, session.id).at(-1) === "idle")
      // 被拒的调用发动机照样发 tool_start / tool_end(拒绝理由就是它的结果),所以确认之后有一段极短的 tools。
      expect(phases(events, session.id)).toEqual([
        "waiting",
        "calling",
        "confirm",
        "waiting",
        "tools",
        "waiting",
        "writing",
        "idle",
      ])
    } finally {
      await manager.disposeAll()
    }
  }, 20_000)
})

describe("调试轨迹:trace.jsonl", () => {
  test("一轮的事件序列与字段(会话、请求、首字、工具、收尾),不记正文", async () => {
    const { manager, events, trace, traceFile, workspace } = makeManager(thinkThenList())
    let sessionID = ""
    try {
      const session = await manager.create(workspace)
      sessionID = session.id
      await manager.prompt(session.id, { text: "看看目录" })
      await waitFor(() => phases(events, session.id).at(-1) === "idle")
    } finally {
      await manager.disposeAll()
      await trace.close()
    }

    const lines = traceLines(traceFile).filter((line) => line.s === sessionID)
    expect(lines.map((line) => line.ev)).toEqual([
      "session.open",
      "run.start",
      "llm.start",
      "llm.first",
      "llm.end",
      "tool.start",
      "tool.end",
      "llm.start",
      "llm.first",
      "llm.end",
      "run.end",
    ])
    const of = (ev: string) => lines.filter((line) => line.ev === ev)
    expect(of("session.open")[0]).toMatchObject({ thinking: "high" })
    expect(String(of("session.open")[0]!.model)).toMatch(/^faux-activity-\d+\/thinker$/)
    expect(of("llm.first").map((line) => line.kind)).toEqual(["thinking", "text"])
    expect(of("llm.start")[0]!.wait_ms).toEqual(expect.any(Number))
    // stop_reason 是供应商给的原值(faux 带工具调用的消息给 "stop",真供应商给 "toolUse"),这里不钉
    expect(of("llm.end")[0]).toMatchObject({ stop_reason: expect.any(String), tools: ["ls"], thinking_chars: 6, text_chars: 0 })
    expect(of("llm.end")[1]).toMatchObject({ stop_reason: "stop", text_chars: "目录是空的".length })
    expect(of("llm.end")[1]!.tools).toBeUndefined()
    expect(of("tool.start")[0]).toMatchObject({ tool: "ls", summary: expect.any(String) })
    expect(of("tool.end")[0]).toMatchObject({ tool: "ls", error: false, ms: expect.any(Number) })
    expect(of("run.end")[0]).toMatchObject({ status: "completed", ms: expect.any(Number) })
    // 同一轮的行都带着同一个 run id
    expect(new Set(lines.filter((line) => line.run).map((line) => line.run)).size).toBe(1)
    // 只记元数据:对话正文与推理原文都不在文件里
    const raw = readFileSync(traceFile, "utf8")
    expect(raw).not.toContain("目录是空的")
    expect(raw).not.toContain("先列一下目录")
    expect(raw).not.toContain("看看目录")
  }, 20_000)

  test("npm run trace 的报告读得懂真会话与真轨迹(上游一改会话格式这条先红)", async () => {
    const { manager, events, trace, traceFile, sessionsRoot, workspace } = makeManager(thinkThenList())
    let sessionID = ""
    try {
      const session = await manager.create(workspace)
      sessionID = session.id
      await manager.prompt(session.id, { text: "看看目录" })
      await waitFor(() => phases(events, session.id).at(-1) === "idle")
    } finally {
      await manager.disposeAll()
      await trace.close()
    }
    const parsed = parseSession(readFileSync(sessionFileOf(sessionsRoot, sessionID), "utf8"))
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.session).toMatchObject({ id: sessionID, thinking: "high" })
    expect(parsed.session.users.map((user) => user.text)).toEqual(["看看目录"])
    expect(parsed.session.assistants).toHaveLength(2)
    expect(parsed.session.assistants[0]).toMatchObject({ thinkingChars: 6, calls: [{ name: "ls" }] })
    expect(parsed.session.tools).toEqual([expect.objectContaining({ name: "ls", isError: false, summary: "." })])
    expect(parsed.session.runs).toEqual([expect.objectContaining({ status: "completed" })])

    const report = renderReport(parsed.session, parseTrace(readFileSync(traceFile, "utf8")))
    expect(report).toContain(`会话 ${sessionID}`)
    expect(report).toContain("用户    看看目录")
    expect(report).toMatch(/首字 \d+\.\d s\(thinking\)/)
    const lsRow = report.split("\n").find((line) => line.includes("工具") && line.includes("  ls  "))!
    // 轨迹里有 tool.start:起点是真开跑时刻,不是估的
    expect(lsRow).not.toContain("起点按回复落盘时刻估")
    expect(report).toContain("没有超过 20.0 s 的步骤")
  }, 20_000)

  test("确认条:confirm.wait 带工具与摘要,confirm.done 记结局与等了多久", async () => {
    const command = "openocd -f interface/stlink.cfg -c 'init; exit'"
    const { manager, events, trace, traceFile, workspace } = makeManager(
      [fauxAssistantMessage([fauxToolCall("bash", { command })]), fauxAssistantMessage([fauxText("好,不跑")])],
      { confirmTools: true },
    )
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "连一下探针" })
      await waitFor(() => manager.pendingConfirms(session.id).length > 0)
      manager.replyConfirm(manager.pendingConfirms(session.id)[0]!.id, false)
      await waitFor(() => phases(events, session.id).at(-1) === "idle")
    } finally {
      await manager.disposeAll()
      await trace.close()
    }
    const lines = traceLines(traceFile)
    expect(lines.find((line) => line.ev === "confirm.wait")).toMatchObject({ tool: "bash", summary: command })
    expect(lines.find((line) => line.ev === "confirm.done")).toMatchObject({ outcome: "denied", ms: expect.any(Number) })
    // 被拒的调用以错误收场,排在 confirm.done 之后
    const order = lines.map((line) => line.ev)
    expect(order.indexOf("confirm.done")).toBeLessThan(order.indexOf("tool.end"))
    expect(lines.find((line) => line.ev === "tool.end")).toMatchObject({ tool: "bash", error: true })
  }, 20_000)
})
