import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, Session, VcsInfo } from "@yoma-desktop/kernel"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"

const session = (input: { id: string; archived?: number }) =>
  ({
    id: input.id,
    directory: "/tmp",
    title: input.id,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) satisfies Session

const userMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    model: { providerID: "openai", modelID: "gpt" },
  }) satisfies Message

const assistantMessage = (id: string, sessionID: string, parentID: string) =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: 1 },
    providerID: "openai",
    modelID: "gpt",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) satisfies AssistantMessage

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) satisfies Part

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } satisfies State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working: () => false,
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("handles kernel.connected by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "kernel.connected", version: "test" },
      refresh: () => {
        refreshCount += 1
      },
    })

    expect(refreshCount).toBe(1)
  })

  test("ignores unrelated global events", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "session.created", session: session({ id: "a" }) },
      refresh: () => {
        refreshCount += 1
      },
    })

    expect(refreshCount).toBe(0)
  })
})

describe("applyDirectoryEvent", () => {
  test("initializes text delta accumulation from the current part text", () => {
    const part = { ...textPart("part", "session", "message"), text: "existing" }
    const [store, setStore] = createStore(baseState({ part: { message: [part] } }))

    applyDirectoryEvent({
      event: {
        type: "message.part.delta",
        sessionID: "session",
        messageID: "message",
        partID: "part",
        field: "text",
        delta: " appended",
      },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.part_text_accum_delta.part).toBe("existing appended")
    const updated = store.part.message?.[0]
    expect(updated && "text" in updated ? updated.text : undefined).toBe("existing appended")
  })

  test("preserves a Home-specific retained session limit", () => {
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })],
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", session: session({ id: "d" }) },
      store,
      setStore,
      directory: "/tmp",
      retainedLimit: 3,
    })

    expect(store.session).toHaveLength(3)
  })

  test("inserts sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [session({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", session: session({ id: "a" }) },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", session: session({ id: "c" }) },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(store.sessionTotal).toBe(3)
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [session({ id: "ses_1" }), session({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", session: session({ id: "ses_1", archived: 10 }) },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("cleans session caches and decrements the total when deleted", () => {
    for (const id of ["ses_1", "ses_2"]) {
      const message = userMessage("msg_1", id)
      const [store, setStore] = createStore(
        baseState({
          session: [session({ id: "ses_1" }), session({ id: "ses_2" }), session({ id: "ses_3" })],
          sessionTotal: 3,
          message: { [id]: [message] },
          part: { [message.id]: [textPart("prt_1", id, message.id)] },
          session_status: { [id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", sessionID: id },
        store,
        setStore,
          directory: "/tmp",
      })

      expect(store.session.find((x) => x.id === id)).toBeUndefined()
      expect(store.sessionTotal).toBe(2)
      expect(store.message[id]).toBeUndefined()
      expect(store.part[message.id]).toBeUndefined()
      expect(store.session_status[id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed sessions on session.created", () => {
    const dropped = session({ id: "ses_b" })
    const kept = session({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", session: kept },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.message[dropped.id]).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
  })

  test("cleanupDroppedSessionCaches clears part-only orphan state", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [session({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session)

    expect(store.part.msg_1).toBeUndefined()
  })

  test("upserts and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", message: userMessage("msg_2", sessionID) },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        message: assistantMessage("msg_2", sessionID, "msg_1"),
      },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", sessionID, messageID: "msg_2" },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", part: textPart("prt_2", sessionID, messageID) },
      store,
      setStore,
      directory: "/tmp",
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        part: {
          ...textPart("prt_2", sessionID, messageID),
          text: "changed",
        } satisfies Part,
      },
      store,
      setStore,
      directory: "/tmp",
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: { type: "message.part.removed", sessionID, messageID, partID: "prt_1" },
      store,
      setStore,
      directory: "/tmp",
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", sessionID, messageID, partID: "prt_2" },
      store,
      setStore,
      directory: "/tmp",
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", sessionID, messageID, partID: "prt_3" },
      store,
      setStore,
      directory: "/tmp",
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("replaces vcs info in store and cache", () => {
    const initial: VcsInfo = { root: "/tmp", branch: "main", dirty: false }
    const [store, setStore] = createStore(baseState({ vcs: initial }))
    const [cacheStore, setCacheStore] = createStore({ value: initial as VcsInfo | undefined })

    const next: VcsInfo = { root: "/tmp", branch: "feature/test", dirty: true }
    applyDirectoryEvent({
      event: { type: "vcs.updated", directory: "/tmp", info: next },
      store,
      setStore,
      directory: "/tmp",
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual(next)
    expect(cacheStore.value).toEqual(next)
  })
})
