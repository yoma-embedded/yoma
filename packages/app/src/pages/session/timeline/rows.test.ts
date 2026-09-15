import { describe, expect, test } from "vitest"
import type { AssistantMessage, ModelRetry, UserMessage } from "@yoma-desktop/kernel"
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
