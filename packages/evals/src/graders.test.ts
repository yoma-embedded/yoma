/**
 * 四个 grader 的正反用例。
 *
 * 每个 grader **都要有一条红的**。一个只测通过路径的判分器测试证明不了它会红,
 * 而永远亮绿的闸门比没有闸门更坏(它让人以为自己有防线)——`details-check.ts` 上
 * 已经踩过一次那种形状的错误。
 *
 * context 是手造的:grader 是纯函数,不需要起进程、不需要真会话。
 */

import { describe, expect, test } from "bun:test"

import type { TurnResult } from "@yoma-desktop/bench"

import { extractLastJsonFence } from "./answer.ts"
import { createGrader, type GraderContext, type GraderSpec } from "./graders/index.ts"
import type { TranscriptToolCall } from "./session.ts"
import type { Task } from "./task.ts"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    title: "题",
    tags: ["netlist"],
    requires: [],
    env: { kind: "none" },
    setup: { files: [] },
    prompt: "…```json…",
    reference: { answer: "U3" },
    graders: [],
    dir: "/tasks/t",
    file: "/tasks/t/task.json",
    ...overrides,
  }
}

function call(overrides: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return { id: "c1", name: "netlist", input: {}, output: "", isError: false, status: "completed", ...overrides }
}

const emptyResult: TurnResult = {
  sessionID: "s",
  text: "",
  toolCalls: [],
  usage: { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
  errors: [],
  elapsedMs: 0,
}

function context(options: { text?: string; calls?: TranscriptToolCall[]; task?: Task }): GraderContext {
  const text = options.text ?? ""
  return {
    task: options.task ?? task(),
    result: { ...emptyResult, text },
    transcript: { file: "/sessions/x.jsonl", assistantCount: 1, toolCalls: options.calls ?? [] },
    answer: extractLastJsonFence(text),
  }
}

const grade = (spec: GraderSpec, ctx: GraderContext) => createGrader(spec).grade(ctx)

const fence = (value: unknown, field = "answer") => `\`\`\`json\n${JSON.stringify({ [field]: value })}\n\`\`\``

describe("answer", () => {
  test("equals 对上就过", () => {
    const verdict = grade({ type: "answer", equals: "U3" }, context({ text: fence("U3") }))
    expect(verdict.pass).toBe(true)
    expect(verdict.detail).toContain("U3")
  })

  test("答错时 detail 说清实得与应得", () => {
    const verdict = grade({ type: "answer", equals: "U3" }, context({ text: fence("U1") }))
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toContain("U1")
    expect(verdict.detail).toContain("应为 U3")
  })

  test("没有围栏时把提取错误原样报出来 —— 不是'答错了'而是'没作答'", () => {
    const verdict = grade({ type: "answer", equals: "U3" }, context({ text: "主控是 U3" }))
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toContain("围栏")
  })

  test("oneOf / matches / 自定义字段", () => {
    expect(grade({ type: "answer", oneOf: ["U3", "U4"] }, context({ text: fence("u4") })).pass).toBe(true)
    expect(grade({ type: "answer", oneOf: ["U3", "U4"] }, context({ text: fence("U9") })).pass).toBe(false)
    expect(grade({ type: "answer", matches: "U\\d+" }, context({ text: fence("U12") })).pass).toBe(true)
    expect(grade({ type: "answer", matches: "U\\d+" }, context({ text: fence("R12") })).pass).toBe(false)
    const spec: GraderSpec = { type: "answer", field: "controller", equals: "U3" }
    expect(grade(spec, context({ text: fence("U3", "controller") })).pass).toBe(true)
  })

  test("数组默认按集合比,顺序无关", () => {
    const spec: GraderSpec = { type: "answer", equals: ["U3", "U4"] }
    expect(grade(spec, context({ text: fence(["U4", "U3"]) })).pass).toBe(true)
    expect(grade({ ...spec, unordered: false }, context({ text: fence(["U4", "U3"]) })).pass).toBe(false)
  })
})

describe("grounded", () => {
  test("参考答案出现在某次已完成工具的输出里", () => {
    const verdict = grade(
      { type: "grounded" },
      context({ text: fence("U3"), calls: [call({ output: "Ref U3 value RP2040" })] }),
    )
    expect(verdict.pass).toBe(true)
    expect(verdict.detail).toContain("netlist")
  })

  test("答对了但一次工具都没调 —— 这就是'没量就猜'", () => {
    const verdict = grade({ type: "grounded" }, context({ text: fence("U3"), calls: [] }))
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toContain("没有任何已完成的工具调用")
  })

  test("只在报错的那次输出里出现不算 —— 那是从错误信息里读答案", () => {
    const errored = call({ output: "boom: U3 not parsed", isError: true, status: "error" })
    expect(grade({ type: "grounded" }, context({ text: fence("U3"), calls: [errored] })).pass).toBe(false)
  })

  test("显式 needles + mode", () => {
    const calls = [call({ output: "只有 alpha" })]
    const both: GraderSpec = { type: "grounded", needles: ["alpha", "beta"] }
    expect(grade(both, context({ calls })).pass).toBe(false)
    expect(grade({ ...both, mode: "any" }, context({ calls })).pass).toBe(true)
  })

  test("大小写不敏感;数组参考答案逐元素查", () => {
    const calls = [call({ output: "u3 与 u4 都在这儿" })]
    const ctx = context({ calls, task: task({ reference: { answer: ["U3", "U4"] } }) })
    expect(grade({ type: "grounded" }, ctx).pass).toBe(true)
  })
})

describe("tool-called", () => {
  test("调过就过;没调时 detail 列出它实际用了什么", () => {
    const calls = [call({ name: "netlist" }), call({ id: "c2", name: "read" })]
    expect(grade({ type: "tool-called", tool: "netlist" }, context({ calls })).pass).toBe(true)
    const missed = grade({ type: "tool-called", tool: "gdb" }, context({ calls }))
    expect(missed.pass).toBe(false)
    expect(missed.detail).toContain("netlist")
  })

  test("minCount 与 status", () => {
    const calls = [call({ id: "a" }), call({ id: "b", isError: true, status: "error" })]
    expect(grade({ type: "tool-called", tool: "netlist", minCount: 2 }, context({ calls })).pass).toBe(true)
    const spec: GraderSpec = { type: "tool-called", tool: "netlist", minCount: 2, status: "completed" }
    expect(grade(spec, context({ calls })).pass).toBe(false)
  })
})

describe("tool-forbidden", () => {
  test("一次都没碰就过", () => {
    const calls = [call({ name: "read" })]
    const verdict = grade({ type: "tool-forbidden", tools: ["flash", "gdb"] }, context({ calls }))
    expect(verdict.pass).toBe(true)
  })

  test("调了就越线,失败的那次也算 —— 越线的是意图", () => {
    const calls = [call({ name: "flash", isError: true, status: "error" })]
    const verdict = grade({ type: "tool-forbidden", tools: ["flash", "gdb"] }, context({ calls }))
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toContain("flash×1")
  })
})
