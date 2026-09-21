import { describe, expect, it } from "vitest"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
import { getBehaviorCase } from "./cases.ts"
import { gradeBehavior, runBehavior } from "./run.ts"

const item = getBehaviorCase("empty-log")
function setup(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "fixture", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(steps)
  return { models, model: faux.getModel(), faux }
}
const observation = () => fauxAssistantMessage(fauxToolCall("log", { action: "read" }), { stopReason: "toolUse" })
const answer = () => fauxAssistantMessage('{"has_samples":false,"max_accel":null}')

describe("behavior evaluation", () => {
  it("keeps simulated log state consistent and requires reading the evidence", () => {
    const positive = getBehaviorCase("observed-motion")
    expect(positive.respond("log", { action: "ports" }, [])).not.toContain("868")
    expect(positive.respond("log", { action: "status" }, [])).toContain("buffered log")
    expect(positive.respond("log", { action: "read" }, [])).toContain("868")
    const calls = [{ name: "log", input: { action: "read" }, output: "record", error: false }]
    expect(positive.respond("log", { action: "read" }, calls)).toContain("no new lines")
    expect(positive.respond("log", { action: "read", since: 0 }, calls)).toContain("868")
    expect(
      gradeBehavior(positive, '{"motor_running":true}', [{ ...calls[0]!, input: { action: "ports" } }]),
    ).toHaveLength(1)
  })

  it("does not accept a correct guess without the required observation, or a fabricated measurement", () => {
    expect(gradeBehavior(item, '{"has_samples":false,"max_accel":null}', [])).toHaveLength(1)
    const calls = [{ name: "log", input: { action: "read" }, output: "0 samples", error: false }]
    expect(gradeBehavior(item, '{"has_samples":false,"max_accel":0}', calls)).toHaveLength(1)
    expect(gradeBehavior(item, '```json\n{"has_samples":false,"max_accel":null}\n```', calls)).toEqual([])
    expect(gradeBehavior(item, "null", calls)).toHaveLength(1)
  })

  it("runs production schemas through the real loop and forwards the output token cap", async () => {
    const options = setup([
      observation(),
      (_context, streamOptions, _state, requestModel) => {
        expect(streamOptions?.maxTokens).toBe(128)
        expect(requestModel.maxTokens).toBe(128)
        expect(streamOptions?.maxRetries).toBe(0)
        return answer()
      },
    ])
    const result = await runBehavior({ ...options, item, limits: { maxOutputTokens: 128 } })
    expect(result.status).toBe("passed")
    expect(result.requests).toBe(2)
    expect(result.calls).toMatchObject([{ name: "log", input: { action: "read" }, error: false }])
    expect(result.usage.totalTokens).toBeGreaterThan(0)
    expect(result.trace).toHaveLength(3) // Two completed assistant messages + one tool result, no stream double-counting.
  })

  it("blocks dispatch before exceeding the request cap", async () => {
    const options = setup([observation(), observation(), answer()])
    const result = await runBehavior({ ...options, item, limits: { maxRequests: 1 } })
    expect(result.status).toBe("limited")
    expect(result.requests).toBe(1)
    expect(options.faux.state.callCount).toBe(1)
    expect(result.failures).toContain("Trial request limit")
  })

  it("reserves estimated uncached input and maximum output before any paid request", async () => {
    const options = setup([answer()])
    const result = await runBehavior({ ...options, item, limits: { maxCost: 0.000001 } })
    expect(result.status).toBe("limited")
    expect(result.requests).toBe(0)
    expect(options.faux.state.callCount).toBe(0)
  })

  it("reserves for every allowed transport attempt, even when billing usage is absent", async () => {
    const once = await runBehavior({ ...setup([answer()]), item })
    const retried = await runBehavior({ ...setup([answer()]), item, providerRetries: 2 })
    expect(retried.reservedCostUsd).toBeCloseTo(once.reservedCostUsd * 3)
    expect(retried.requests).toBe(1) // Logical generations, not HTTP attempts.
  })

  it("aborts an in-flight provider at the time limit and reports it separately", async () => {
    const options = setup([
      (_context, streamOptions) =>
        new Promise((resolve) => {
          const finish = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }))
          if (streamOptions?.signal?.aborted) finish()
          else streamOptions?.signal?.addEventListener("abort", finish, { once: true })
        }),
    ])
    const result = await runBehavior({ ...options, item, limits: { timeoutMs: 100 } })
    expect(result.status).toBe("limited")
    expect(result.failures).toContain("Trial time limit")
    expect(result.requests).toBe(1)
  })

  it("records provider failures separately, with no automatic retry", async () => {
    const options = setup([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service unavailable" }),
      answer(),
    ])
    const result = await runBehavior({ ...options, item })
    expect(result.status).toBe("provider_error")
    expect(result.requests).toBe(1)
    expect(options.faux.state.callCount).toBe(1)
  })

  it("rejects invalid budgets before starting", async () => {
    await expect(runBehavior({ ...setup([]), item, limits: { maxCost: NaN } })).rejects.toThrow("Invalid maxCost")
  })
})
