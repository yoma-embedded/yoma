/**
 * /btw 的纯函数(host/btw.ts,docs/btw顺便问-设计方案-20260924.md)。上下文拼法与主轮是否逐字相同,由走完整
 * SessionManager 的 session-btw.test.ts 对着发动机真发出去的请求比;这里钉的是每个函数自己的规矩。
 */
import { describe, expect, test } from "vitest"
import type { AgentMessage, Entry as SessionEntry } from "@earendil-works/pi-agent-core"
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai"

import {
  answerText,
  BTW_FORK_DIRECTIVE,
  contextMessages,
  FORK_BOILERPLATE_TAG,
  forkDirectiveOf,
  forkDirectiveText,
  forkSeed,
  requestOptions,
  requestTools,
  RUNNING_TOOL_PLACEHOLDER,
  settleAnswer,
  settleRunningToolCalls,
  userMessage,
  withNotes,
  wrapSideQuestion,
} from "./btw.ts"

let seq = 0
function entry<T extends SessionEntry["type"]>(type: T, fields: Record<string, unknown>): SessionEntry {
  seq++
  return { id: `e${seq}`, parentId: null, seq, timestamp: 1000 + seq, type, ...fields } as SessionEntry
}

const user = (text: string): AgentMessage => userMessage(text, [], 1)
const reply = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)])

function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  }
}

describe("contextMessages:照抄发动机的 buildSessionContext", () => {
  test("没有压缩:message 原样,出错 / 中止 / deferred 的 assistant 滤掉,custom 给空", () => {
    const ok = reply("好")
    const broken: AssistantMessage = { ...reply("半截"), stopReason: "error", errorMessage: "503" }
    const aborted: AssistantMessage = { ...reply("停了"), stopReason: "aborted" }
    const deferred: AssistantMessage = { ...reply("晚点"), stopReason: "deferred" }
    const messages = contextMessages([
      entry("message", { message: user("一") }),
      entry("message", { message: broken }),
      entry("message", { message: aborted }),
      entry("message", { message: deferred }),
      entry("custom", { customType: "yoma/compaction" }),
      entry("message", { message: ok }),
    ])
    expect(messages).toEqual([user("一"), ok])
  })

  test("有压缩:从最近一次压缩开始,摘要消息 + 保留的尾巴(尾巴里出错的也滤掉),之前的全不要", () => {
    const tail = reply("留着的")
    const broken: AssistantMessage = { ...reply("坏的"), stopReason: "error" }
    const messages = contextMessages([
      entry("message", { message: user("很早的") }),
      entry("compaction", { summary: "旧摘要", retainedTail: [], tokensBefore: 10, fromHook: false }),
      entry("message", { message: user("中间的") }),
      entry("compaction", { summary: "新摘要", retainedTail: [tail, broken], tokensBefore: 99, fromHook: false }),
      entry("message", { message: user("之后的") }),
    ])
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatchObject({ role: "compactionSummary", summary: "新摘要", tokensBefore: 99 })
    expect(messages[1]).toBe(tail)
    expect(messages[2]).toEqual(user("之后的"))
  })

  test("分支摘要:有字才进上下文", () => {
    const messages = contextMessages([
      entry("branch_summary", { summary: "", fromId: null, fromHook: false }),
      entry("branch_summary", { summary: "另一条路上干过的事", fromId: "e1", fromHook: false }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "branchSummary", summary: "另一条路上干过的事", fromId: "e1" })
  })
})

describe("settleRunningToolCalls:只给最后一条 assistant 里没结果的调用补占位", () => {
  test("在跑的调用紧跟在已有的结果后面补上,标成不是出错;后面的消息原样挪后", () => {
    const calling = fauxAssistantMessage([
      fauxToolCall("read", { path: "a" }, { id: "c1" }),
      fauxToolCall("grep", { pattern: "x" }, { id: "c2" }),
    ])
    const steered = user("插进来的一句")
    const settled = settleRunningToolCalls([user("开始"), calling, toolResult("c1", "a 的内容"), steered], 7)
    expect(settled.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"])
    expect(settled[3]).toEqual({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "grep",
      content: [{ type: "text", text: RUNNING_TOOL_PLACEHOLDER }],
      isError: false,
      timestamp: 7,
    })
    expect(settled[4]).toBe(steered)
  })

  test("历史中间悬空的调用不碰:主轮与 /btw 发出去时 pi-ai 补的是同一个东西,前缀照样相同", () => {
    const old = fauxAssistantMessage([fauxToolCall("read", { path: "旧" }, { id: "old" })])
    const messages = [user("一"), old, user("二"), reply("答了")]
    expect(settleRunningToolCalls(messages)).toEqual(messages)
  })

  test("调用都有结果、最后一条 assistant 不调工具、没有 assistant:原样", () => {
    const calling = fauxAssistantMessage([fauxToolCall("read", { path: "a" }, { id: "c1" })])
    const done = [user("一"), calling, toolResult("c1", "内容")]
    expect(settleRunningToolCalls(done)).toEqual(done)
    expect(settleRunningToolCalls([user("一"), reply("答")])).toEqual([user("一"), reply("答")])
    expect(settleRunningToolCalls([user("只有一句")])).toEqual([user("只有一句")])
  })
})

describe("问题与请求", () => {
  test("问题的包法是 CC 的原话,问题接在最后", () => {
    const wrapped = wrapSideQuestion("这个寄存器是干嘛的")
    expect(wrapped.startsWith("<system-reminder>This is a side question from the user.")).toBe(true)
    expect(wrapped).toContain("You have NO tools available")
    expect(wrapped.endsWith("</system-reminder>\n\n这个寄存器是干嘛的")).toBe(true)
  })

  test("user 消息:正文在前、图片在后;说明拼在正文后面", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" }
    expect(userMessage("看图", [image], 5)).toEqual({
      role: "user",
      content: [{ type: "text", text: "看图" }, image],
      timestamp: 5,
    })
    expect(withNotes("正文", [])).toBe("正文")
    expect(withNotes("正文", ["缩到了一半", "转成了 PNG"])).toBe("正文\n\n缩到了一半\n转成了 PNG")
  })

  test("工具:按激活名单的顺序,只取四个字段,不认识的名字跳过", () => {
    const parameters = { type: "object", properties: {} } as never
    const tools = [
      { name: "read", description: "读", parameters, execute: () => undefined },
      { name: "bash", description: "跑", parameters, constrainedSampling: false as const },
    ]
    expect(requestTools(tools, ["bash", "missing", "read"])).toEqual([
      { name: "bash", description: "跑", parameters, constrainedSampling: false },
      { name: "read", description: "读", parameters },
    ])
  })

  test("请求选项:照主轮的字段,思考 off 就不带 reasoning,sessionId 与 signal 照给,不给 deferred", () => {
    const signal = new AbortController().signal
    const streamOptions = { timeoutMs: 5, headers: { a: "1" }, cacheRetention: "long" as const, deferred: true }
    const on = requestOptions({ streamOptions, thinkingLevel: "high", sessionId: "s:main", signal })
    expect(on).toMatchObject({
      timeoutMs: 5,
      headers: { a: "1" },
      cacheRetention: "long",
      reasoning: "high",
      sessionId: "s:main",
    })
    expect(on.signal).toBe(signal)
    expect("deferred" in on).toBe(false)
    expect(
      "reasoning" in requestOptions({ streamOptions: {}, thinkingLevel: "off", sessionId: "s:main", signal }),
    ).toBe(false)
  })
})

describe("答案", () => {
  test("正文:text 块用空行拼,思考不要", () => {
    const message = fauxAssistantMessage([
      { type: "thinking", thinking: "想想" },
      fauxText("第一段"),
      fauxText("第二段 "),
    ])
    expect(answerText(message)).toBe("第一段\n\n第二段")
  })

  test("收场的四种样子", () => {
    expect(settleAnswer(reply("答案"))).toEqual({ status: "done", text: "答案" })
    expect(settleAnswer(fauxAssistantMessage([fauxToolCall("read", { path: "a" })]))).toEqual({
      status: "done",
      text: "",
      attemptedTool: "read",
    })
    expect(
      settleAnswer({ ...reply(""), content: [], stopReason: "error", errorMessage: "503 Service Unavailable" }),
    ).toEqual({
      status: "failed",
      text: "",
      error: "503 Service Unavailable",
    })
    expect(settleAnswer({ ...reply("半句"), stopReason: "aborted" })).toMatchObject({ status: "cancelled" })
    expect(settleAnswer(fauxAssistantMessage([]))).toEqual({ status: "failed", text: "" })
  })
})

describe("fork", () => {
  test("守则:CC 的格式,不许派子 agent、不许 commit,指令在最后", () => {
    const text = forkDirectiveText("查清楚")
    expect(text.startsWith(`<${FORK_BOILERPLATE_TAG}>`)).toBe(true)
    expect(text).toContain("Do NOT spawn sub-agents")
    expect(text).toContain("Do NOT commit.")
    expect(text).toContain('Your response MUST begin with "Scope:"')
    expect(text.endsWith("Your directive: 查清楚")).toBe(true)
    expect(forkDirectiveOf(text)).toBe("查清楚")
    expect(forkDirectiveOf("普通的一句话")).toBeUndefined()
  })

  test("种子:上下文 + 问题(不带 /btw 的包装)+ 答案(只留正文)+ 指令", () => {
    const answer: AssistantMessage = {
      ...fauxAssistantMessage([{ type: "thinking", thinking: "想", thinkingSignature: "sig" }, fauxText("答案")]),
      responseId: "resp_1",
    }
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" }
    const seed = forkSeed({ context: [user("主会话的话")], question: "这是什么", images: [image], answer, now: 9 })
    expect(seed).toHaveLength(4)
    expect(seed[0]).toEqual(user("主会话的话"))
    expect(seed[1]).toEqual({ role: "user", content: [{ type: "text", text: "这是什么" }, image], timestamp: 9 })
    expect(seed[2]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "答案" }], stopReason: "stop" })
    expect("responseId" in seed[2]!).toBe(false)
    expect(JSON.stringify(seed[1])).not.toContain("side question")
    const directive = (seed[3] as { content: Array<{ text: string }> }).content[0]!.text
    expect(forkDirectiveOf(directive)).toBe(BTW_FORK_DIRECTIVE)
  })
})
