import { describe, expect, test } from "vitest"
import type { AssistantMessage, ModelRetry, Part, UserMessage } from "@yoma-desktop/kernel"
import { groupRefs } from "@yoma-desktop/session-ui/message-part"
import { Timeline, TimelineRow } from "./rows"

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
  // 这一组测的是分组本身:跑完的轮次会收成「处理详情」,这里让段都开着,好看清里面的组。
  const build = (parts: Record<string, Part[]>, messages: AssistantMessage[], showReasoning = true) =>
    Timeline.constructMessageRows(
      user,
      (id) => parts[id] ?? [],
      messages,
      0,
      showReasoning,
      "idle",
      false,
      undefined,
      undefined,
      () => true,
    ).flatMap((row) => (row._tag === "AssistantPart" ? [row.group] : []))
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

describe("处理详情:跑完的一轮把过程收成一行,回答留在外面", () => {
  const tool = (id: string, messageID: string, name: string, input: Record<string, unknown> = {}): Part =>
    ({
      id,
      sessionID: "session",
      messageID,
      callID: `call_${id}`,
      type: "tool",
      tool: name,
      state: { status: "completed", input, output: "", title: name, metadata: {}, time: { start: 1, end: 2 } },
    }) as Part
  const text = (id: string, messageID: string, value = "说明"): Part => ({
    id,
    sessionID: "session",
    messageID,
    type: "text",
    text: value,
  })
  const reasoning = (id: string, messageID: string): Part =>
    ({ id, sessionID: "session", messageID, type: "reasoning", text: "想一下", time: { start: 1 } }) as Part
  // 内核只给收尾那一条 time.completed(toolUse 的回复没有)。
  const step = (id: string, extra: Partial<AssistantMessage> = {}) => assistant(id, { time: { created: 2 }, ...extra })
  const build = (
    parts: Record<string, Part[]>,
    messages: AssistantMessage[],
    options: {
      status?: "busy" | "idle" | "compacting"
      active?: boolean
      open?: Record<string, boolean>
      showReasoning?: boolean
    } = {},
  ) =>
    Timeline.constructMessageRows(
      user,
      (id) => parts[id] ?? [],
      messages,
      0,
      options.showReasoning ?? true,
      options.status ?? "idle",
      options.active ?? false,
      undefined,
      undefined,
      (key) => options.open?.[key],
    )
  /** 行的样子:`[a,b]` = 收着的「处理详情」(`+` = 开着),`x@` = 在点开的段里,别的行按 tag。 */
  const shape = (rows: ReturnType<typeof build>) =>
    rows.map((row) => {
      if (row._tag === "ProcessGroup")
        return `[${row.groups.flatMap((group) => groupRefs(group).map((ref) => ref.partID)).join(",")}]${row.open ? "+" : ""}`
      if (row._tag !== "AssistantPart") return row._tag
      const id = groupRefs(row.group)
        .map((ref) => ref.partID)
        .join("+")
      return row.process ? `${id}@` : id
    })

  const plain = {
    a: [text("t1", "a", "我先看看"), tool("p1", "a", "bash")],
    b: [tool("p2", "b", "read"), tool("p3", "b", "read")],
    c: [text("p4", "c", "结论")],
  }
  const plainMessages = [step("a"), step("b"), assistant("c")]

  test("没有硬件调用:说明、工具、「已探索」全收进一行,回答在外面", () => {
    const rows = build(plain, plainMessages)
    expect(shape(rows)).toEqual(["UserMessage", "[t1,p1,p2,p3]", "p4"])
    expect(rows.find((row) => row._tag === "ProcessGroup")).toMatchObject({ key: "process:a:t1", open: false })
  })

  test("点开:标题下面照旧是逐行(带 process,「已探索」照旧是一组);回答那一行与跑着时同一个 key", () => {
    const opened = build(plain, plainMessages, { open: { "process:a:t1": true } })
    expect(shape(opened)).toEqual(["UserMessage", "[t1,p1,p2,p3]+", "t1@", "p1@", "p2+p3@", "p4"])
    const running = build(plain, plainMessages, { status: "busy", active: true })
    const answerKey = (rows: ReturnType<typeof build>) =>
      rows.filter((row) => row._tag === "AssistantPart").map((row) => TimelineRow.key(row)).at(-1)
    expect(answerKey(opened)).toBe(answerKey(running))
  })

  test("正在跑的那一轮平铺,跑完(idle)才收;压缩中也算在跑", () => {
    // 最后那一行是「此刻在干什么」(activity.ts),这一轮在跑就在。
    expect(shape(build(plain, plainMessages, { status: "busy", active: true }))).toEqual([
      "UserMessage",
      "t1",
      "p1",
      "p2+p3",
      "p4",
      "Thinking",
    ])
    expect(shape(build(plain, plainMessages, { status: "compacting", active: true }))).not.toContain("[t1,p1,p2,p3]")
    expect(shape(build(plain, plainMessages, { status: "idle", active: true }))).toContain("[t1,p1,p2,p3]")
    // 别的轮次在跑,这一轮早就跑完了。
    expect(shape(build(plain, plainMessages, { status: "busy", active: false }))).toContain("[t1,p1,p2,p3]")
  })

  test("硬件卡不动:它把段切开、自己原样留在原位;子 agent 卡同理", () => {
    const parts = {
      a: [tool("p1", "a", "bash")],
      b: [tool("f1", "b", "flash")],
      c: [tool("p2", "c", "bash"), tool("p3", "c", "grep")],
      d: [tool("s1", "d", "scope"), tool("g1", "d", "agent")],
      e: [text("p4", "e", "波形正常")],
    }
    const messages = [step("a"), step("b"), step("c"), step("d"), assistant("e")]
    expect(shape(build(parts, messages))).toEqual(["UserMessage", "[p1]", "f1", "[p2,p3]", "s1", "g1", "p4"])
  })

  test("只有说明文字、没有工具调用的段不收(烧录卡前面那句话原样在)", () => {
    const parts = { a: [text("t1", "a", "我先烧一下"), tool("f1", "a", "flash")], b: [text("p2", "b", "烧好了")] }
    expect(shape(build(parts, [step("a"), assistant("b")]))).toEqual(["UserMessage", "t1", "f1", "p2"])
  })

  test("回答 = 最后一条消息里最后一个非文字 part 之后的文字;同一条里前面的思考收进去", () => {
    const parts = { a: [tool("p1", "a", "bash")], b: [reasoning("r1", "b"), text("p2", "b", "结论")] }
    const messages = [step("a"), assistant("b")]
    expect(shape(build(parts, messages))).toEqual(["UserMessage", "[p1,r1]", "p2"])
    // 不展示思考时思考段本来就不画。
    expect(shape(build(parts, messages, { showReasoning: false }))).toEqual(["UserMessage", "[p1]", "p2"])
  })

  // 后台子 agent 的通知、排队的用户消息在工具边界插进来,另起一轮:前半截以工具调用收尾,回答在后面那一轮里。
  // 审查抓到的:只认有回答的轮次时,这种前半截永远不收 —— 而后台子 agent 与排队都是缺省开的,长任务常常这样。
  test("以工具调用收尾(被下一轮切断)也收:整段收起,外面没有回答;硬件卡照旧在外", () => {
    const cut = { a: [tool("p1", "a", "bash")], b: [tool("f1", "b", "flash"), tool("p2", "b", "read")] }
    expect(shape(build(cut, [step("a"), step("b")]))).toEqual(["UserMessage", "[p1]", "f1", "[p2]"])
  })

  test("报错收场、被打断的不收", () => {
    const failed = { a: [tool("p1", "a", "bash")], b: [text("p2", "b", "写到一半")] }
    const error = assistant("b", { error: { name: "UnknownError", data: { message: "503" } } })
    expect(shape(build(failed, [step("a"), error]))).toEqual(["UserMessage", "p1", "p2", "ModelRequest"])
    const stopped = step("a", { error: { name: "MessageAbortedError", data: { message: "Stopped" } } })
    expect(shape(build({ a: [tool("p1", "a", "bash"), text("p2", "a")] }, [stopped]))).toEqual([
      "UserMessage",
      "p1",
      "p2",
      "TurnDivider",
    ])
    // 重试耗尽:失败的那条没有可画的 part,最后一条有 part 的是以工具调用收尾的那条 —— 照样不收。
    const exhausted = failure("b")
    expect(shape(build({ a: [tool("p1", "a", "bash")] }, [step("a"), exhausted]))).toEqual([
      "UserMessage",
      "p1",
      "ModelRequest",
    ])
  })

  test("段的 key 不跟着「显示思考」变:开关它,开着的段还开着", () => {
    const parts = { a: [reasoning("r1", "a"), tool("p1", "a", "bash")], b: [text("p2", "b", "结论")] }
    const messages = [step("a"), assistant("b")]
    const keyOf = (showReasoning: boolean) =>
      build(parts, messages, { showReasoning }).flatMap((row) => (row._tag === "ProcessGroup" ? [row.key] : []))
    expect(keyOf(true)).toEqual(["process:a:p1"])
    expect(keyOf(false)).toEqual(["process:a:p1"])
  })

  test("synthetic 消息(压缩摘要)不算回答,也不收进去,原样平铺", () => {
    const parts = {
      a: [tool("p1", "a", "bash")],
      b: [text("p2", "b", "结论")],
      c: [
        { id: "x1", sessionID: "session", messageID: "c", type: "compaction", auto: true } as Part,
        text("x2", "c", "摘要"),
      ],
    }
    expect(shape(build(parts, [step("a"), assistant("b"), assistant("c", { synthetic: true })]))).toEqual([
      "UserMessage",
      "[p1]",
      "p2",
      "x1",
      "x2",
    ])
    // 一轮里撞到阈值、压缩摘要夹在过程中间:它把段切开,摘要正文原样平铺,不并进后面那一段。
    const middle = {
      a: [tool("p1", "a", "bash")],
      c: [
        { id: "x1", sessionID: "session", messageID: "c", type: "compaction", auto: true } as Part,
        text("x2", "c", "摘要"),
      ],
      d: [tool("p3", "d", "bash")],
      e: [text("p4", "e", "结论")],
    }
    const messages = [step("a"), assistant("c", { synthetic: true }), step("d"), assistant("e")]
    expect(shape(build(middle, messages))).toEqual(["UserMessage", "[p1]", "x1", "x2", "[p3]", "p4"])
  })

  test("只有回答的轮次没有这一行;「本轮改动」照旧排在回答后面", () => {
    expect(shape(build({ a: [text("p1", "a", "你好")] }, [assistant("a")]))).toEqual(["UserMessage", "p1"])
    const parts = { a: [tool("p1", "a", "write", { path: "docs/a.md", content: "# a" })], b: [text("p2", "b", "写好了")] }
    expect(shape(build(parts, [step("a"), assistant("b")]))).toEqual(["UserMessage", "[p1]", "p2", "TurnChanges"])
  })
})

describe("压缩上下文的那段时间", () => {
  const tags = (status: "busy" | "idle" | "compacting", active: boolean) =>
    rows([assistant("a")], status, active).map((row) => row._tag)

  test("正在压缩的那一轮底下有一行「压缩中」,而不是「思考中」", () => {
    expect(tags("compacting", true)).toEqual(["UserMessage", "Compacting"])
  })

  test("别的轮次、别的状态都没有这一行", () => {
    expect(tags("compacting", false)).toEqual(["UserMessage"])
    expect(tags("busy", true)).not.toContain("Compacting")
    expect(tags("idle", false)).not.toContain("Compacting")
  })
})

describe("本轮改动那一行", () => {
  const change = (id: string, messageID: string, tool: string, status = "completed"): Part =>
    ({
      id,
      sessionID: "session",
      messageID,
      callID: `call_${id}`,
      type: "tool",
      tool,
      state:
        status === "completed"
          ? { status, input: { path: "src/main.c" }, output: "", title: tool, metadata: {}, time: { start: 1, end: 2 } }
          : { status, input: { path: "src/main.c" }, error: "boom", metadata: {}, time: { start: 1, end: 2 } },
    }) as Part
  const build = (
    parts: Record<string, Part[]>,
    messages: AssistantMessage[],
    status: "busy" | "idle" | "compacting" = "idle",
    active = false,
  ) => Timeline.constructMessageRows(user, (id) => parts[id] ?? [], messages, 0, true, status, active)
  const changes = (rows: ReturnType<typeof build>) => rows.flatMap((row) => (row._tag === "TurnChanges" ? [row] : []))

  test("跨多条 assistant 消息收齐这一轮的 edit / write,排在工具卡(这里已收成「处理详情」)之后", () => {
    const built = build(
      { a: [change("p1", "a", "edit"), change("p2", "a", "read")], b: [change("p3", "b", "write")] },
      [assistant("a"), assistant("b")],
    )
    expect(built.map((row) => row._tag)).toEqual(["UserMessage", "ProcessGroup", "TurnChanges"])
    expect(changes(built)[0]!.refs).toEqual([
      { messageID: "a", partID: "p1" },
      { messageID: "b", partID: "p3" },
    ])
  })

  test("没动过文件的轮次没有这一行;失败的 edit 不算", () => {
    expect(changes(build({ a: [change("p1", "a", "read")] }, [assistant("a")]))).toEqual([])
    expect(changes(build({ a: [change("p1", "a", "edit", "error")] }, [assistant("a")]))).toEqual([])
  })

  test("跑着的那一轮不出,跑完(idle)才出;已经不是当前轮的照出", () => {
    const parts = { a: [change("p1", "a", "edit")] }
    expect(changes(build(parts, [assistant("a")], "busy", true))).toEqual([])
    expect(changes(build(parts, [assistant("a")], "compacting", true))).toEqual([])
    expect(changes(build(parts, [assistant("a")], "idle", true))).toHaveLength(1)
    expect(changes(build(parts, [assistant("a")], "busy", false))).toHaveLength(1)
  })

  test("被打断的轮次照样出 —— 文件确实改了", () => {
    const aborted = assistant("a", { error: { name: "MessageAbortedError", data: { message: "aborted" } } })
    expect(changes(build({ a: [change("p1", "a", "edit")] }, [aborted]))).toHaveLength(1)
  })
})
