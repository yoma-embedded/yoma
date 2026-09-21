import { describe, expect, test } from "vitest"
import type { AssistantMessage, ModelRetry, Part, UserMessage } from "@yoma-desktop/kernel"
import { Timeline } from "./rows"

const user: UserMessage = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  model: { providerID: "deepseek", modelID: "flash" },
}
const assistant = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  sessionID: "session",
  role: "assistant",
  parentID: user.id,
  time: { created: 2, completed: 3 },
  providerID: "deepseek",
  modelID: "flash",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
})
const failure = (id: string, text = "Connection error.") =>
  assistant(id, { error: { name: "UnknownError", data: { message: text } } })
const retry: ModelRetry = {
  attempt: 2,
  maxAttempts: 4,
  notBefore: 1234,
  error: "Connection error.",
  providerID: "deepseek",
}
const rows = (
  messages: AssistantMessage[],
  status: "busy" | "idle" | "compacting" = "idle",
  active = false,
  pending?: ModelRetry,
) => Timeline.constructMessageRows(user, () => [], messages, 0, true, status, active, pending)
const requests = (
  messages: AssistantMessage[],
  status: "busy" | "idle" | "compacting" = "idle",
  active = false,
  pending?: ModelRetry,
) => rows(messages, status, active, pending).filter((row) => row._tag === "ModelRequest")

describe("model request status", () => {
  test("shows explicit retry progress instead of a terminal error or thinking row", () => {
    const current = rows([failure("a")], "busy", true, retry)
    expect(current.map((row) => row._tag)).toEqual(["UserMessage", "ModelRequest"])
    expect(current.at(-1)).toMatchObject({ state: "retrying", attempt: 2, maxAttempts: 4, providerID: "deepseek" })
  })

  test.each(["busy", "idle"] as const)("shows recovery after a successful response, status=%s", (status) => {
    expect(requests([failure("a"), failure("b"), assistant("c")], status, status === "busy")).toMatchObject([
      { state: "recovered" },
    ])
  })

  test("does not call a newly started stream recovered", () => {
    expect(requests([failure("a"), assistant("b", { time: { created: 4 } })], "busy", true)).toEqual([])
  })

  test("does not mistake synthetic content for a recovered model response", () => {
    expect(requests([failure("a"), assistant("b", { synthetic: true })])).toMatchObject([{ state: "failed" }])
  })

  test("shows the latest failure after an earlier recovery", () => {
    expect(requests([failure("a"), assistant("b"), failure("c", "503 Service Unavailable")])).toMatchObject([
      { state: "failed", text: "503 Service Unavailable" },
    ])
  })

  test("does not show a terminal error while the kernel handles an interruption", () => {
    expect(requests([failure("a")], "busy", true)).toEqual([])
    expect(requests([failure("a")], "compacting", true)).toEqual([])
  })

  test("keeps old failed turns separate from the active retry", () => {
    expect(requests([failure("a")], "busy", false, retry)).toMatchObject([{ state: "failed" }])
  })

  test("keeps an explicit cancellation as interrupted instead of failed", () => {
    const messages = [
      failure("a"),
      assistant("b", { error: { name: "MessageAbortedError", data: { message: "Stopped" } } }),
    ]
    expect(requests(messages)).toEqual([])
    expect(rows(messages)).toContainEqual(expect.objectContaining({ _tag: "TurnDivider", label: "interrupted" }))
  })

  test("reports authentication failure without inventing retries", () => {
    const message = assistant("a", {
      error: { name: "ProviderAuthError", data: { providerID: "deepseek", message: "401 invalid api key" } },
    })
    expect(requests([message])).toMatchObject([
      { state: "failed", providerID: "deepseek", text: "401 invalid api key" },
    ])
  })
})

describe("连着的「找东西」工具并成一行", () => {
  const toolPart = (id: string, messageID: string, tool: string): Part =>
    ({
      id,
      sessionID: "session",
      messageID,
      callID: `call_${id}`,
      type: "tool",
      tool,
      state: { status: "completed", input: {}, output: "", title: tool, metadata: {}, time: { start: 1, end: 2 } },
    }) as Part
  const textPart = (id: string, messageID: string, text: string): Part => ({
    id,
    sessionID: "session",
    messageID,
    type: "text",
    text,
  })
  const reasoningPart = (id: string, messageID: string, text: string): Part =>
    ({ id, sessionID: "session", messageID, type: "reasoning", text, time: { start: 1 } }) as Part
  const build = (parts: Record<string, Part[]>, messages: AssistantMessage[], showReasoning = true) =>
    Timeline.constructMessageRows(user, (id) => parts[id] ?? [], messages, 0, showReasoning, "idle", false).flatMap(
      (row) => (row._tag === "AssistantPart" ? [row.group] : []),
    )
  const shape = (groups: ReturnType<typeof build>) =>
    groups.map((group) => (group.type === "context" ? group.refs.map((ref) => ref.partID) : group.ref.partID))

  test("同一条消息里连着的并成一组,中间隔了别的就断开", () => {
    const groups = build(
      {
        a: [
          toolPart("p1", "a", "read"),
          toolPart("p2", "a", "grep"),
          toolPart("p3", "a", "flash"),
          toolPart("p4", "a", "ls"),
          textPart("p5", "a", "看完了"),
          toolPart("p6", "a", "find"),
        ],
      },
      [assistant("a")],
    )
    expect(shape(groups)).toEqual([["p1", "p2"], "p3", ["p4"], "p5", ["p6"]])
  })

  // 内核每一步一条 assistant 消息:一轮里「读一个、想一下、再读一个」落在好几条消息上。
  test("跨消息照样并;思考段展示时隔开它们,不展示时不隔", () => {
    const parts = {
      a: [reasoningPart("r1", "a", "先看启动文件"), toolPart("p1", "a", "read")],
      b: [reasoningPart("r2", "b", "再看链接脚本"), toolPart("p2", "b", "read")],
      c: [toolPart("p3", "c", "grep")],
    }
    const messages = [assistant("a"), assistant("b"), assistant("c")]
    expect(shape(build(parts, messages, true))).toEqual(["r1", ["p1"], "r2", ["p2", "p3"]])
    expect(shape(build(parts, messages, false))).toEqual([["p1", "p2", "p3"]])
  })

  test("组的 key 取第一个 part:后面再来多少个,这一行还是这一行", () => {
    const one = build({ a: [toolPart("p1", "a", "read")] }, [assistant("a")])
    const three = build(
      { a: [toolPart("p1", "a", "read")], b: [toolPart("p2", "b", "read"), toolPart("p3", "b", "ls")] },
      [assistant("a"), assistant("b")],
    )
    expect(one.map((group) => group.key)).toEqual(["context:a:p1"])
    expect(three.map((group) => group.key)).toEqual(["context:a:p1"])
  })

  test("打断的分隔线两边不并到一起", () => {
    const groups = Timeline.constructMessageRows(
      user,
      (id) => ({ a: [toolPart("p1", "a", "read")], b: [toolPart("p2", "b", "read")] })[id] ?? [],
      [assistant("a", { error: { name: "MessageAbortedError", data: { message: "Stopped" } } }), assistant("b")],
      0,
      true,
      "idle",
      false,
    ).map((row) => (row._tag === "AssistantPart" ? shape([row.group])[0] : row._tag))
    expect(groups).toEqual(["UserMessage", ["p1"], "TurnDivider", ["p2"]])
  })
})
