import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@yoma-desktop/kernel"
import { resetSessionModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message model through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }),
    )

    expect(calls).toEqual([
      { sessionID: "session", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})
