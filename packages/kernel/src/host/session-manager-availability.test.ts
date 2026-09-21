import { afterEach, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
} from "@earendil-works/pi-ai"
import type { KernelEvent } from "../protocol.ts"
import { createAgentTools, SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import { patient } from "../../test/patience.ts"

const roots: string[] = []
const managers: SessionManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()))
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-availability-"))
  roots.push(dir)
  return dir
}
async function waitFor(check: () => boolean): Promise<void> {
  for (let n = 0; n < patient(1000); n++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("availability test timed out")
}
let sequence = 0
type Observed = { tools: string[]; prompt: string }
function makeManager(inspect: NonNullable<SessionManagerOptions["inspectStm32Availability"]>, sessionsRoot = temp()) {
  const observed: Observed[] = []
  const events: KernelEvent[] = []
  const models = createModels()
  const faux = fauxProvider({ provider: `availability-${++sequence}`, models: [{ id: "plain" }] })
  models.setProvider(faux.provider)
  faux.setResponses(
    Array.from({ length: 5 }, () => (context) => {
      observed.push({
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
        prompt: getCurrentSystemPrompt(context.messages),
      })
      return fauxAssistantMessage([fauxText("done")])
    }),
  )
  const manager = new SessionManager({
    sessionsRoot,
    configDir: temp(),
    inspectStm32Availability: inspect,
    emit: (batch) => events.push(...batch),
    resolveModels: async () => ({ models, model: faux.getModel() as Model<string> }),
  })
  managers.push(manager)
  const turn = async (id: string) => {
    const count = observed.length
    await manager.prompt(id, { text: "hello" })
    await waitFor(
      () =>
        observed.length === count + 1 &&
        events.filter((event) => event.type === "session.status").at(-1)?.status.type === "idle",
    )
  }
  return { manager, observed, turn, events }
}

test("static catalog stays complete; a live session removes/restores stm32config before each new turn", async () => {
  expect(createAgentTools().map((tool) => tool.name)).toContain("stm32config")
  let available = false
  let probes = 0
  const { manager, observed, turn } = makeManager(async () => {
    probes++
    return { available, reason: available ? undefined : "CubeMX source missing" }
  })
  const session = await manager.create(temp())
  await turn(session.id)
  expect(probes).toBe(1)
  expect(observed[0]!.tools).not.toContain("stm32config")
  expect(observed[0]!.tools).toContain("netlist")
  expect(observed[0]!.prompt).toContain("CubeMX source missing")
  expect(observed[0]!.prompt).toContain("do not install or configure CubeMX")
  available = true
  await turn(session.id)
  expect(observed[1]!.tools).toContain("stm32config")
  expect(observed[1]!.prompt).not.toContain("STM32 configuration is unavailable")
  available = false
  await turn(session.id)
  expect(observed[2]!.tools).not.toContain("stm32config")
  expect(probes).toBe(3)
})

test("reopening persisted active tools applies current machine availability before the model request", async () => {
  const sessionsRoot = temp()
  const initial = makeManager(async () => ({ available: true }), sessionsRoot)
  const session = await initial.manager.create(temp())
  await initial.turn(session.id)
  expect(initial.observed[0]!.tools).toContain("stm32config")
  await initial.manager.disposeAll()
  const reopened = makeManager(async () => ({ available: false, reason: "source removed" }), sessionsRoot)
  await reopened.turn(session.id)
  expect(reopened.observed[0]!.tools).not.toContain("stm32config")
  expect(reopened.observed[0]!.prompt).toContain("source removed")
})

test("a new prompt waits for cancelled opening cleanup and starts without inheriting its AbortError", async () => {
  let pending: AbortSignal | undefined
  let finishCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve
  })
  let first = true
  const { manager, observed, events } = makeManager(async ({ signal }) => {
    if (!first) return { available: true }
    first = false
    pending = signal
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
    await cleanup
    signal!.throwIfAborted()
    return { available: true }
  })
  const session = await manager.create(temp())
  const cancelled = manager.prompt(session.id, { text: "cancelled" })
  await waitFor(() => pending !== undefined)
  await manager.abort(session.id)
  const replacement = manager.prompt(session.id, { text: "replacement" })
  finishCleanup()
  await Promise.all([cancelled, replacement])
  await waitFor(
    () =>
      observed.length === 1 && events.filter((event) => event.type === "session.status").at(-1)?.status.type === "idle",
  )
  const messages = (await manager.messages(session.id)).items
  const texts = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
  expect(texts).toContain("replacement")
  expect(texts).not.toContain("cancelled")
  expect(observed[0]!.tools).toContain("stm32config")
})

test.each([false, true])(
  "stop during availability preparation cancels the turn (already open: %s)",
  async (alreadyOpen) => {
    let block = !alreadyOpen
    let pending: AbortSignal | undefined
    const { manager, observed, turn, events } = makeManager(async ({ signal }) => {
      if (!block) return { available: true }
      pending = signal
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      return { available: false }
    })
    const session = await manager.create(temp())
    if (alreadyOpen) await turn(session.id)
    const before = observed.length
    const messageCount = (await manager.messages(session.id)).items.length
    block = true
    const request = manager.prompt(session.id, { text: "cancel me" })
    await waitFor(() => pending !== undefined)
    await manager.abort(session.id)
    await request
    expect(pending!.aborted).toBe(true)
    expect(observed).toHaveLength(before)
    expect((await manager.messages(session.id)).items).toHaveLength(messageCount)
    expect(events.filter((event) => event.type === "kernel.error")).toEqual([])
    block = false
    await turn(session.id)
    expect(observed).toHaveLength(before + 1)
    expect(observed.at(-1)!.tools).toContain("stm32config")
  },
)
