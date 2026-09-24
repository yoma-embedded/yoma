import { afterEach, describe, expect, test, vi } from "vitest"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssistantMessage, Part, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import type { Sdk } from "@/utils/kernel"
import { createServerSession } from "@/context/server-session"
import { createTimelineProjection } from "@/pages/session/timeline/projection"
import { Timeline, TimelineRow } from "@/pages/session/timeline/rows"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  model: { providerID: "test", modelID: "test" },
})

const assistant = (id: string, parentID: string): AssistantMessage => ({
  id,
  parentID,
  sessionID: "s",
  role: "assistant",
  time: { created: 2 },
  providerID: "test",
  modelID: "test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

function setup(showReasoning: boolean) {
  const store = createServerSession({} as Sdk)
  store.apply({
    type: "session.created",
    session: { id: "s", directory: "/test", title: "test", time: { created: 1, updated: 1 } },
  })
  const status = (value: SessionStatus) => store.apply({ type: "session.status", sessionID: "s", status: value })
  const part = (value: Part) => store.apply({ type: "message.part.updated", part: value })
  const delta = (messageID: string, partID: string, text: string) =>
    store.apply({ type: "message.part.delta", sessionID: "s", messageID, partID, field: "text", delta: text })
  store.apply({ type: "message.updated", message: user("msg_0") })
  store.apply({ type: "message.updated", message: assistant("msg_1", "msg_0") })
  status({ type: "busy" })
  const users = createMemo(() => store.data.message.s.filter((item): item is UserMessage => item.role === "user"))
  const timeline = createTimelineProjection({
    messages: () => store.data.message.s,
    userMessages: users,
    parts: (id) => store.data.part[id] ?? [],
    status: () => store.data.session_status.s,
    showReasoningSummaries: () => showReasoning,
  })
  const tags = () => timeline.rows().map((row) => row._tag)
  return { store, status, part, delta, timeline, tags }
}

const builds = () => vi.spyOn(Timeline, "constructMessageRows")

afterEach(() => vi.restoreAllMocks())

describe("timeline projection:处理详情", () => {
  const bash = (id: string, messageID: string): Part =>
    ({
      id,
      messageID,
      sessionID: "s",
      type: "tool",
      callID: `call_${id}`,
      tool: "bash",
      state: { status: "completed", input: { command: "make" }, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
    }) as Part

  /** 两轮,每轮一次 bash + 一句回答;`busy` 时第二轮还在跑。 */
  function setup(busy = false) {
    const store = createServerSession({} as Sdk)
    store.apply({
      type: "session.created",
      session: { id: "s", directory: "/test", title: "test", time: { created: 1, updated: 1 } },
    })
    const status = (value: SessionStatus) => store.apply({ type: "session.status", sessionID: "s", status: value })
    const [open, setOpen] = createStore<Record<string, boolean | undefined>>({})
    for (const turn of [0, 1]) {
      store.apply({ type: "message.updated", message: user(`msg_${turn}0`) })
      store.apply({ type: "message.updated", message: assistant(`msg_${turn}1`, `msg_${turn}0`) })
      store.apply({
        type: "message.updated",
        message: { ...assistant(`msg_${turn}2`, `msg_${turn}0`), time: { created: 3, completed: 4 } },
      })
      store.apply({ type: "message.part.updated", part: bash(`prt_${turn}1`, `msg_${turn}1`) })
      store.apply({
        type: "message.part.updated",
        part: { id: `prt_${turn}2`, messageID: `msg_${turn}2`, sessionID: "s", type: "text", text: "结论" },
      })
    }
    status({ type: busy ? "busy" : "idle" })
    const users = createMemo(() => store.data.message.s.filter((item): item is UserMessage => item.role === "user"))
    const timeline = createTimelineProjection({
      messages: () => store.data.message.s,
      userMessages: users,
      parts: (id) => store.data.part[id] ?? [],
      status: () => store.data.session_status.s,
      showReasoningSummaries: () => false,
      processOpen: (key) => open[key],
    })
    const tags = () => timeline.rows().map((row) => row._tag)
    return { timeline, tags, setOpen, status }
  }

  test("开合一段只重建那一轮,别的轮次一次都不重建", () => {
    createRoot((dispose) => {
      try {
        const { timeline, tags, setOpen } = setup()
        const folded = ["UserMessage", "ProcessGroup", "AssistantPart"]
        expect(tags()).toEqual([...folded, "TurnGap", ...folded])
        const second = timeline.rows().slice(4)
        const spy = builds()
        setOpen("process:msg_01:prt_01", true)
        expect(tags()).toEqual([...folded.slice(0, 2), "AssistantPart", "AssistantPart", "TurnGap", ...folded])
        expect(spy.mock.calls.map((call) => call[0].id)).toEqual(["msg_00"])
        // 第二轮的行原样复用:是同一批对象,不是长得一样的新对象。
        const reused = timeline.rows().slice(5)
        expect(reused).toHaveLength(second.length)
        reused.forEach((row, index) => expect(row).toBe(second[index]))
        setOpen("process:msg_01:prt_01", false)
        expect(tags()).toEqual([...folded, "TurnGap", ...folded])
      } finally {
        dispose()
      }
    })
  })

  test("在跑的那一轮平铺,跑完那一下收起来(每轮只重建一次,之后不再重建);回答那一行 key 不变", () => {
    createRoot((dispose) => {
      try {
        const { timeline, tags, status } = setup(true)
        expect(tags().slice(4)).toEqual(["UserMessage", "AssistantPart", "AssistantPart", "Thinking"])
        const answer = () => TimelineRow.key(timeline.rows().filter((row) => row._tag === "AssistantPart").at(-1)!)
        const before = answer()
        const spy = builds()
        status({ type: "idle" })
        expect(tags().slice(4)).toEqual(["UserMessage", "ProcessGroup", "AssistantPart"])
        expect(answer()).toBe(before)
        // 每一轮的 memo 都订阅会话状态(改之前就是这样),所以两轮各重建一次;收起不多花一次。
        expect(spy.mock.calls.map((call) => call[0].id).sort()).toEqual(["msg_00", "msg_10"])
        for (let index = 0; index < 20; index++) timeline.rows()
        expect(spy.mock.calls).toHaveLength(2)
      } finally {
        dispose()
      }
    })
  })
})

describe("timeline projection: 流式增量", () => {
  // 行的结构只取决于一段文本「空 / 非空」,不取决于它现在有多长。增量每 16 ms 一批地来,
  // 每批都把当前这一轮的行重建一遍(遍历全部 part、逐行造对象再逐行比)是白干。
  test("文本增量只在空 → 非空那一下重建行", () => {
    createRoot((dispose) => {
      try {
        const { part, delta, timeline, tags } = setup(true)
        part({ id: "prt_1", messageID: "msg_1", sessionID: "s", type: "text", text: "" })
        expect(tags()).toEqual(["UserMessage", "Thinking"])

        const spy = builds()
        delta("msg_1", "prt_1", "第")
        expect(tags()).toEqual(["UserMessage", "AssistantPart", "Thinking"])
        const afterFirst = spy.mock.calls.length
        const rows = timeline.rows()

        for (let index = 0; index < 200; index++) {
          delta("msg_1", "prt_1", "字")
          timeline.rows()
        }
        expect(spy.mock.calls.length - afterFirst).toBe(0)
        expect(timeline.rows()).toBe(rows)
      } finally {
        dispose()
      }
    })
  })

  // 忙时的阶段变化(内核在 busy 里带的 activity,docs/调试留痕-规划-20260924.md §2.2)只给底部那一行的组件读,
  // 一个 step 五到十次;行的 memo 只订 status 的 type 与 retry —— 阶段怎么变都不该重建这一轮的行。
  test("只变 activity 的 busy:一行都不重建", () => {
    createRoot((dispose) => {
      try {
        const { status, timeline, tags } = setup(false)
        expect(tags()).toEqual(["UserMessage", "Thinking"])
        const rows = timeline.rows()
        const spy = builds()
        const phases: SessionStatus[] = [
          { type: "busy", activity: { phase: "waiting", since: 1 } },
          { type: "busy", activity: { phase: "thinking", since: 2 } },
          { type: "busy", activity: { phase: "calling", since: 3, tool: "bash" } },
          { type: "busy", activity: { phase: "tools", since: 4, tools: ["bash"] } },
          { type: "busy", activity: { phase: "tools", since: 4, tools: ["bash", "grep"] } },
          { type: "busy", activity: { phase: "waiting", since: 5 } },
        ]
        for (const next of phases) {
          status(next)
          timeline.rows()
        }
        expect(spy.mock.calls.length).toBe(0)
        expect(timeline.rows()).toBe(rows)
      } finally {
        dispose()
      }
    })
  })

  test("空白增量不会提前亮出一行,真正的字一到就亮", () => {
    createRoot((dispose) => {
      try {
        const { part, delta, tags } = setup(true)
        part({ id: "prt_1", messageID: "msg_1", sessionID: "s", type: "text", text: "" })
        delta("msg_1", "prt_1", "\n  ")
        expect(tags()).toEqual(["UserMessage", "Thinking"])
        delta("msg_1", "prt_1", "好")
        expect(tags()).toEqual(["UserMessage", "AssistantPart", "Thinking"])
      } finally {
        dispose()
      }
    })
  })

  test("思考增量:展示思考时只重建一次;不展示时只有标题变了才重建", () => {
    createRoot((dispose) => {
      try {
        const shown = setup(true)
        shown.part({ id: "prt_1", messageID: "msg_1", sessionID: "s", type: "reasoning", text: "", time: { start: 1 } })
        const spy = builds()
        for (let index = 0; index < 100; index++) {
          shown.delta("msg_1", "prt_1", "想")
          shown.timeline.rows()
        }
        expect(shown.tags()).toEqual(["UserMessage", "AssistantPart", "Thinking"])
        expect(spy.mock.calls.length).toBe(1)
      } finally {
        dispose()
      }
    })

    createRoot((dispose) => {
      try {
        const hidden = setup(false)
        hidden.part({
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "s",
          type: "reasoning",
          text: "",
          time: { start: 1 },
        })
        const spy = builds()
        hidden.delta("msg_1", "prt_1", "**先看时钟树**\n")
        const thinking = () => hidden.timeline.rows().find((row) => row._tag === "Thinking")
        expect(thinking()).toMatchObject({ reasoningHeading: "先看时钟树" })
        const afterHeading = spy.mock.calls.length
        for (let index = 0; index < 100; index++) {
          hidden.delta("msg_1", "prt_1", "HSE 8 MHz,PLL 倍到 168。")
          hidden.timeline.rows()
        }
        expect(spy.mock.calls.length - afterHeading).toBe(0)
        expect(thinking()).toMatchObject({ reasoningHeading: "先看时钟树" })
      } finally {
        dispose()
      }
    })
  })

  test("工具卡片的进度不重建行(reconcile 原地更新,结构没变)", () => {
    createRoot((dispose) => {
      try {
        const { part, timeline } = setup(true)
        const tool = (output: string): Part => ({
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "s",
          type: "tool",
          callID: "call_1",
          tool: "bash",
          state: { status: "running", input: { command: "make" }, output, time: { start: 1 } },
        })
        part(tool(""))
        timeline.rows()
        const spy = builds()
        for (let index = 0; index < 50; index++) {
          part(tool("line\n".repeat(index + 1)))
          timeline.rows()
        }
        expect(spy.mock.calls.length).toBe(0)
      } finally {
        dispose()
      }
    })
  })

  test("第二个 read 到的时候,那一行原地长大:key 不变、别的行原样复用", () => {
    createRoot((dispose) => {
      try {
        const { part, timeline } = setup(true)
        const read = (id: string, status: "running" | "completed"): Part =>
          ({
            id,
            messageID: "msg_1",
            sessionID: "s",
            type: "tool",
            callID: `call_${id}`,
            tool: "read",
            state:
              status === "running"
                ? { status, input: { path: "startup.s" }, time: { start: 1 } }
                : {
                    status,
                    input: { path: "startup.s" },
                    output: "",
                    title: "",
                    metadata: {},
                    time: { start: 1, end: 2 },
                  },
          }) as Part
        const assistantRows = () => timeline.rows().filter((row) => row._tag === "AssistantPart")

        part(read("prt_1", "completed"))
        const [first] = assistantRows()
        const userRow = timeline.rows()[0]
        expect(first!.group).toEqual({
          key: "context:msg_1:prt_1",
          type: "context",
          refs: [{ messageID: "msg_1", partID: "prt_1" }],
        })

        part(read("prt_2", "running"))
        const [grown, ...rest] = assistantRows()
        expect(rest).toEqual([])
        expect(TimelineRow.key(grown!)).toBe(TimelineRow.key(first!))
        expect(grown!.group.type === "context" && grown!.group.refs.map((ref) => ref.partID)).toEqual([
          "prt_1",
          "prt_2",
        ])
        expect(timeline.rows()[0]).toBe(userRow)

        // 跑完只是卡片内容变了,行的结构没变。
        const spy = builds()
        part(read("prt_2", "completed"))
        expect(assistantRows()[0]).toBe(grown)
        expect(spy.mock.calls.length).toBe(0)
      } finally {
        dispose()
      }
    })
  })
})
