import { describe, expect, test } from "vitest"
import { batch, createMemo, createRoot } from "solid-js"
import type { AssistantMessage, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import type { Sdk } from "@/utils/kernel"
import { createServerSession } from "@/context/server-session"
import { createTimelineProjection } from "@/pages/session/timeline/projection"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  model: { providerID: "test", modelID: "test" },
})

const assistant = (id: string, parentID: string, completed?: number): AssistantMessage => ({
  id,
  parentID,
  sessionID: "s",
  role: "assistant",
  time: { created: 2, ...(completed === undefined ? {} : { completed }) },
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
  const message = (value: UserMessage | AssistantMessage) => store.apply({ type: "message.updated", message: value })
  message(user("msg_0"))
  // The kernel deliberately omits time.completed for toolUse responses, even in finished turns.
  message(assistant("msg_1", "msg_0"))
  message(assistant("msg_2", "msg_0", 3))
  store.apply({
    type: "message.part.updated",
    part: { id: "part_2", messageID: "msg_2", sessionID: "s", type: "text", text: "上一轮已经回复完毕" },
  })
  status({ type: "idle" })
  const users = createMemo(() => store.data.message.s.filter((item): item is UserMessage => item.role === "user"))
  const timeline = createTimelineProjection({
    messages: () => store.data.message.s,
    userMessages: users,
    parts: (id) => store.data.part[id] ?? [],
    status: () => store.data.session_status.s,
    showReasoningSummaries: () => showReasoning,
  })
  const thinking = () =>
    timeline
      .rows()
      .filter((row) => row._tag === "Thinking")
      .map((row) => row.userMessageID)
  const compacting = () =>
    timeline
      .rows()
      .filter((row) => row._tag === "Compacting")
      .map((row) => row.userMessageID)
  const send = () =>
    batch(() => {
      status({ type: "busy" })
      store.optimistic.add({ sessionID: "s", message: user("msg_3"), parts: [] })
    })
  return { store, status, message, timeline, thinking, compacting, send }
}

describe("timeline active turn", () => {
  test.each([false, true])("keeps thinking below the newly sent message (reasoning=%s)", (showReasoning) => {
    createRoot((dispose) => {
      try {
        const { timeline, thinking, send, message, status } = setup(showReasoning)
        send()
        expect(timeline.activeMessageID()).toBe("msg_3")
        expect(thinking()).toEqual(["msg_3"])
        expect(
          timeline
            .rows()
            .slice(-2)
            .map((row) => [row._tag, row.userMessageID]),
        ).toEqual([
          ["UserMessage", "msg_3"],
          ["Thinking", "msg_3"],
        ])

        message(user("msg_3")) // Kernel confirms the optimistic user message, before its first response.
        expect(thinking()).toEqual(["msg_3"])
        message(assistant("msg_4", "msg_3"))
        expect(thinking()).toEqual(["msg_3"])
        message(assistant("msg_5", "msg_3", 4))
        expect(timeline.activeMessageID()).toBe("msg_3")
        status({ type: "idle" })
        expect(thinking()).toEqual([])
        expect(timeline.activeMessageID()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  test("idle history never has an active turn, even with tool responses lacking completion times", () => {
    createRoot((dispose) => {
      try {
        const { timeline, thinking } = setup(false)
        expect(timeline.activeMessageID()).toBeUndefined()
        expect(thinking()).toEqual([])
      } finally {
        dispose()
      }
    })
  })

  test("late updates from an older turn cannot take ownership of current retry or thinking status", () => {
    createRoot((dispose) => {
      try {
        const { timeline, thinking, compacting, send, message, status } = setup(false)
        send()
        message(assistant("msg_1", "msg_0"))
        expect(thinking()).toEqual(["msg_3"])
        status({
          type: "busy",
          retry: {
            attempt: 2,
            maxAttempts: 4,
            notBefore: 100,
            error: "Connection error.",
            providerID: "test",
          },
        })
        expect(thinking()).toEqual([])
        expect(
          timeline
            .rows()
            .filter((row) => row._tag === "ModelRequest")
            .map((row) => row.userMessageID),
        ).toEqual(["msg_3"])
        status({ type: "busy" })
        expect(thinking()).toEqual(["msg_3"])
        status({ type: "compacting" })
        expect(timeline.activeMessageID()).toBe("msg_3")
        expect(thinking()).toEqual([])
        expect(compacting()).toEqual(["msg_3"])
        // 轮内压缩压完回到 busy:「压缩中」收掉,「思考中」回来。
        status({ type: "busy" })
        expect(compacting()).toEqual([])
        expect(thinking()).toEqual(["msg_3"])
        status({ type: "idle" })
        expect(compacting()).toEqual([])
        expect(timeline.activeMessageID()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  // 手动 /compact:会话本来是空闲的,没有哪一轮在跑。「压缩中」挂在最后一轮底下,只此一行。
  test("manual compaction of an idle session shows one compacting row under the last turn", () => {
    createRoot((dispose) => {
      try {
        const { timeline, thinking, compacting, status } = setup(true)
        expect(compacting()).toEqual([])
        status({ type: "compacting" })
        expect(compacting()).toEqual(["msg_0"])
        expect(thinking()).toEqual([])
        expect(timeline.rows().at(-1)?._tag).toBe("Compacting")
        status({ type: "idle" })
        expect(compacting()).toEqual([])
      } finally {
        dispose()
      }
    })
  })
})
