/**
 * `npm run trace` 的分析(report.ts):会话 JSONL + 轨迹 → 时间线与判断。这里用手搓的记录钉住判断的几条分支;
 * 读真会话格式的那条(上游一改格式它先红)在 activity-trace.test.ts,用 faux 真跑一段再读回来。
 */

import { describe, expect, it } from "vitest"

import { parseSession, parseTrace, renderReport, traceFor } from "./report.ts"

const T0 = 1_790_000_000_000
const S = "01a0d233-e461-7107-9408-2284891e1018"

/** 按上游 JsonlStorage 的 v4 形状拼一个会话文件。 */
function sessionFile(): string {
  const lines: unknown[] = [
    { v: 4, kind: "header", id: S, storageVersion: 1, createdAt: T0, cwd: "D:\\proj" },
    [
      {
        kind: "value",
        op: "set",
        seq: 1,
        namespace: "pi.lane.config",
        key: "main",
        value: { model: { provider: "deepseek", modelId: "deepseek-flash" }, thinkingLevel: "max" },
      },
    ],
    { kind: "value", op: "set", seq: 2, namespace: "pi.session.name", key: "", value: "看目录" },
    {
      kind: "entry",
      id: "u1",
      type: "message",
      seq: 3,
      timestamp: T0 + 100,
      message: { role: "user", content: [{ type: "text", text: "通读代码" }], timestamp: T0 + 100 },
    },
    // 第一条回复:推理后调 bash(一个递归扫描)
    {
      kind: "entry",
      id: "a1",
      type: "message",
      seq: 4,
      timestamp: T0 + 3_000,
      message: {
        role: "assistant",
        timestamp: T0 + 200,
        stopReason: "toolUse",
        usage: { input: 10, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 300 },
        content: [
          { type: "thinking", thinking: "x".repeat(1_000) },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "cd /d/proj && du -sh */ | sort -h" } },
        ],
      },
    },
    // 工具结果:三分钟之后才回来(被中止)
    {
      kind: "entry",
      id: "t1",
      type: "message",
      seq: 5,
      timestamp: T0 + 183_000,
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        isError: true,
        timestamp: T0 + 183_000,
        content: [{ type: "text", text: "Command aborted" }],
      },
    },
    // 第二条回复:等了很久才有字(供应商排队)
    {
      kind: "entry",
      id: "a2",
      type: "message",
      seq: 6,
      timestamp: T0 + 230_000,
      message: {
        role: "assistant",
        timestamp: T0 + 184_000,
        stopReason: "stop",
        usage: { input: 10, output: 40, cacheRead: 0, cacheWrite: 0 },
        content: [{ type: "text", text: "好了" }],
      },
    },
    {
      kind: "value",
      op: "set",
      seq: 7,
      namespace: "pi.result",
      key: "op1",
      value: { operationId: "op1", kind: "run", status: "aborted", startedAt: T0 + 100, endedAt: T0 + 231_000 },
    },
  ]
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"kind":"entry","torn`
}

/** 同一段时间的轨迹:bash 真开跑的时刻、忙时心跳、第二次请求的 HTTP 排队、内核被堵一次。 */
function traceText(): string {
  const lines = [
    // 真开跑比回复落盘晚 27 s(那段时间在等确认):报告要用这个起点,而不是按回复落盘估的
    { t: T0 + 30_000, ev: "tool.start", s: S, tc: "call_1", tool: "bash", summary: "cd /d/proj && du -sh */ | sort -h" },
    { t: T0 + 90_000, ev: "busy", s: S, phase: "tools", phase_ms: 60_000, tools: [{ tc: "call_1", tool: "bash", ms: 60_000, quiet_ms: 60_000 }] },
    { t: T0 + 183_000, ev: "tool.end", s: S, tc: "call_1", tool: "bash", ms: 153_000, error: true },
    { t: T0 + 184_010, ev: "http.req", s: S, req: 7, host: "api.deepseek.com", path: "/chat/completions" },
    { t: T0 + 184_400, ev: "http.res", s: S, req: 7, status_code: 200, ms: 390 },
    { t: T0 + 214_400, ev: "http.wait", s: S, req: 7, ms: 30_390, keepalives: 29 },
    { t: T0 + 184_450, ev: "llm.start", s: S, wait_ms: 1_450 },
    { t: T0 + 229_000, ev: "llm.first", s: S, kind: "text", time_to_first_chunk_ms: 44_550 },
    { t: T0 + 230_000, ev: "http.end", s: S, req: 7, outcome: "done", keepalives: 44, first_data_ms: 44_990, ms: 45_990 },
    { t: T0 + 230_005, ev: "llm.end", s: S, stop_reason: "stop" },
    { t: T0 + 100_000, ev: "kernel.lag", ms: 2_500 },
    { t: T0 + 100_000, ev: "run.start", s: "another-session", run: "x" },
  ]
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

describe("parseSession", () => {
  it("读出头、模型与档位、名字、用户消息、回复、工具结果(起点按回复落盘时刻估)、轮次;尾行撕裂跳过", () => {
    const parsed = parseSession(sessionFile())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const session = parsed.session
    expect(session).toMatchObject({ id: S, cwd: "D:\\proj", model: "deepseek/deepseek-flash", thinking: "max", name: "看目录" })
    expect(session.users).toEqual([{ at: T0 + 100, text: "通读代码" }])
    expect(session.assistants[0]).toMatchObject({ at: T0 + 200, end: T0 + 3_000, thinkingChars: 1_000, outputTokens: 500 })
    expect(session.assistants[0]!.calls).toEqual([{ id: "call_1", name: "bash" }])
    expect(session.tools[0]).toMatchObject({ id: "call_1", name: "bash", start: T0 + 3_000, end: T0 + 183_000, isError: true })
    expect(session.tools[0]!.summary).toContain("du -sh")
    expect(session.runs).toEqual([{ status: "aborted", startedAt: T0 + 100, endedAt: T0 + 231_000, error: undefined }])
  })

  it("v3 等不是 v4 的文件:说清楚不支持,不抛", () => {
    expect(parseSession('{"type":"session","version":3,"id":"x"}\n')).toEqual({
      ok: false,
      reason: expect.stringContaining("v4"),
    })
    expect(parseSession("").ok).toBe(false)
  })
})

describe("renderReport", () => {
  it("没有轨迹也能判断:慢工具点出递归扫描与被中止", () => {
    const parsed = parseSession(sessionFile())
    if (!parsed.ok) throw new Error(parsed.reason)
    const report = renderReport(parsed.session, [], { slowMs: 20_000 })
    expect(report).toContain("没有轨迹")
    expect(report).toContain("⚠ 工具  3 min 00 s  bash")
    expect(report).toMatch(/工具 bash 3 min 00 s:像是递归扫大目录/)
    expect(report).toContain("被中止")
    expect(report).toContain("中止 1")
  })

  it("有轨迹:工具用真开跑时刻与心跳里的没出字时长、HTTP 排队的判断、内核被堵;别的会话的行不混进来", () => {
    const parsed = parseSession(sessionFile())
    if (!parsed.ok) throw new Error(parsed.reason)
    const lines = parseTrace(traceText())
    expect(traceFor(lines, parsed.session).some((line) => line.s === "another-session")).toBe(false)
    const report = renderReport(parsed.session, lines, { slowMs: 20_000 })
    const bashRow = report.split("\n").find((line) => line.includes("工具") && line.includes("bash"))!
    // 起点换成 tool.start 的真时刻(153 s,而不是按回复落盘估的 180 s),不再标"估";心跳里那一分钟没出字也写上
    expect(bashRow).toContain("2 min 33 s")
    expect(bashRow).not.toContain("起点按回复落盘时刻估")
    expect(bashRow).toContain("最后 1 min 00 s 没出字")
    // 第二次请求:响应头 0.4 s 就到了,之后只有 keep-alive —— 排队,不是我们卡
    expect(report).toContain("首字 45.0 s(text)")
    expect(report).toContain("HTTP 200 响应头 0.4 s keep-alive 44 行")
    expect(report).toMatch(/模型 46\.0 s:响应头 0\.4 s 就到了,之后 44\.6 s 只有 keep-alive —— 供应商在排队/)
    // 内核被堵(不分会话,按会话的时间段收)
    expect(report).toContain("内核事件循环被堵 2.5 s")
    expect(report).toContain("内核被堵 1 次")
  })

  it("最后一次忙时心跳之后没有收尾:这一轮是卡着被关掉的", () => {
    const parsed = parseSession(sessionFile())
    if (!parsed.ok) throw new Error(parsed.reason)
    const busy = parseTrace(
      JSON.stringify({
        t: T0 + 400_000,
        ev: "busy",
        s: S,
        phase: "tools",
        phase_ms: 300_000,
        tools: [{ tc: "call_9", tool: "bash", ms: 300_000, quiet_ms: 290_000 }],
      }),
    )
    expect(renderReport(parsed.session, busy)).toContain(
      "最后一次忙时心跳之后没有收尾:阶段 tools 已 5 min 00 s;bash 已跑 5 min 00 s、4 min 50 s 没出字",
    )
  })
})
