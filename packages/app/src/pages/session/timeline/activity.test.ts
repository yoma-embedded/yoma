import { describe, expect, test } from "vitest"
import type { AssistantMessage, Part } from "@yoma-desktop/kernel"
import { formatActivityElapsed, formatChars, kernelActivity, turnActivity } from "./activity"

const message = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  sessionID: "s",
  role: "assistant",
  parentID: "u",
  time: { created: 1 },
  providerID: "p",
  modelID: "m",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
})
const text = (id: string): Part => ({ id, sessionID: "s", messageID: "m", type: "text", text: "好" })
const reasoning = (id: string): Part =>
  ({ id, sessionID: "s", messageID: "m", type: "reasoning", text: "", time: { start: 1 } }) as Part
const tool = (id: string, name: string, status: "pending" | "running" | "completed" | "error"): Part =>
  ({
    id,
    sessionID: "s",
    messageID: "m",
    callID: `call_${id}`,
    type: "tool",
    tool: name,
    state:
      status === "pending"
        ? { status, input: {} }
        : status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : status === "error"
            ? { status, input: {}, error: "x", metadata: {}, time: { start: 1, end: 2 } }
            : { status, input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
  }) as Part
const activity = (parts: Record<string, Part[]>, messages = Object.keys(parts).map((id) => message(id))) =>
  turnActivity(messages, (id) => parts[id] ?? [])

describe("正在跑的那一轮底下那一行", () => {
  test("刚发出去、回复还没有 part:等模型", () => {
    expect(turnActivity([], () => [])).toEqual({ kind: "waiting" })
    expect(activity({ a: [] })).toEqual({ kind: "waiting" })
  })

  // 用户 2026-09-24:只有模型真的在往外发思考内容时才显示「思考中」。
  test("最新那条回复的最后一个 part 是思考段:思考中;思考完开始写正文就不说了", () => {
    expect(activity({ a: [reasoning("r1")] })).toEqual({ kind: "thinking" })
    expect(activity({ a: [reasoning("r1"), text("t1")] })).toBeUndefined()
  })

  test("有工具在跑:列工具名(去重、按出现顺序),不说「思考中」", () => {
    const parts = { a: [tool("p1", "bash", "running"), tool("p2", "ls", "completed"), tool("p3", "bash", "running")] }
    expect(activity(parts)).toEqual({ kind: "tools", names: ["bash"] })
    expect(activity({ a: [tool("p1", "grep", "running"), tool("p2", "ls", "running")] })).toEqual({
      kind: "tools",
      names: ["grep", "ls"],
    })
  })

  test("这一批工具都收尾了:等下一次请求;还有没开跑的(参数在写 / 在等确认):不出字", () => {
    expect(activity({ a: [tool("p1", "bash", "completed"), tool("p2", "read", "error")] })).toEqual({ kind: "waiting" })
    expect(activity({ a: [tool("p1", "bash", "completed"), tool("p2", "flash", "pending")] })).toBeUndefined()
  })

  test("看的是最新那条回复;synthetic 的(压缩摘要)不算", () => {
    const parts = { a: [tool("p1", "bash", "completed")], b: [reasoning("r1")], c: [text("x")] }
    const messages = [message("a"), message("b"), message("c", { synthetic: true })]
    expect(activity(parts, messages)).toEqual({ kind: "thinking" })
  })
})

describe("内核说的阶段", () => {
  test("等模型 / 思考 / 跑工具 / 等确认各带起点;工具名去重", () => {
    expect(kernelActivity({ phase: "waiting", since: 5 })).toEqual({ kind: "waiting", since: 5 })
    expect(kernelActivity({ phase: "thinking", since: 6 })).toEqual({ kind: "thinking", since: 6 })
    expect(kernelActivity({ phase: "tools", since: 7, tools: ["bash", "grep", "bash"] })).toEqual({
      kind: "tools",
      names: ["bash", "grep"],
      since: 7,
    })
    expect(kernelActivity({ phase: "confirm", since: 8, tool: "flash" })).toEqual({ kind: "confirm", tool: "flash", since: 8 })
  })

  test("写正文、写工具调用参数:不出字(正文与工具行自己在动)", () => {
    expect(kernelActivity({ phase: "writing", since: 1 })).toBeUndefined()
    expect(kernelActivity({ phase: "calling", since: 1, tool: "write" })).toBeUndefined()
  })
})

describe("formatActivityElapsed", () => {
  test("一分钟以内整秒;以上 min + 两位秒;时钟回拨按 0", () => {
    expect(formatActivityElapsed(0)).toBe("0 s")
    expect(formatActivityElapsed(45_900)).toBe("45 s")
    expect(formatActivityElapsed(167_600)).toBe("2 min 47 s")
    expect(formatActivityElapsed(1_896_000)).toBe("31 min 36 s")
    expect(formatActivityElapsed(-3_000)).toBe("0 s")
  })
})

describe("formatChars", () => {
  test("千以内原样;一万以内一位小数的 k;以上整数 k", () => {
    expect(formatChars(812)).toBe("812")
    expect(formatChars(4_130)).toBe("4.1k")
    expect(formatChars(39_316)).toBe("39k")
  })
})
