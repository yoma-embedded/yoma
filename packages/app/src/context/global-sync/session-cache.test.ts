import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, SessionStatus } from "@yoma-desktop/kernel"
import { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

type CacheShape = {
  session_status: Record<string, SessionStatus | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

const msg = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    model: { providerID: "openai", modelID: "gpt" },
  }) satisfies Message

const part = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) satisfies Part

describe("app session cache", () => {
  test("dropSessionCaches clears orphaned parts without message rows", () => {
    const store: CacheShape = {
      session_status: { ses_1: { type: "busy" } },
      message: {},
      part: { msg_1: [part("prt_1", "ses_1", "msg_1")] },
      permission: { ses_1: [] },
      part_text_accum_delta: { prt_1: "streamed text" },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.part_text_accum_delta.prt_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears message-backed parts", () => {
    const m = msg("msg_1", "ses_1")
    const store: CacheShape = {
      session_status: {},
      message: { ses_1: [m] },
      part: { [m.id]: [part("prt_1", "ses_1", m.id)] },
      permission: {},
      part_text_accum_delta: {},
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[m.id]).toBeUndefined()
  })

  test("pickSessionCacheEvictions preserves requested sessions", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])

    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 2,
      preserve: ["ses_1"],
    })

    expect(stale).toEqual(["ses_2", "ses_3"])
    expect([...seen]).toEqual(["ses_1", "ses_4"])
  })
})
