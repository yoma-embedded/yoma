import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, type Model } from "@earendil-works/pi-ai"
import { expect, test, vi } from "vitest"
import type { KernelEvent } from "../protocol.ts"
import { SessionManager } from "./session-manager.ts"

test("new credentials update an open harness while another session keeps running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-auth-live-"))
  const old = fauxProvider({ provider: "auth-old", models: [{ id: "old" }] })
  const added = fauxProvider({ provider: "auth-added", models: [{ id: "new" }] })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  old.setResponses([
    async () => {
      started = true
      await held
      return fauxAssistantMessage([fauxText("old finished")])
    },
  ])
  added.setResponses([fauxAssistantMessage([fauxText("new works")])])
  let configured = false
  const events: KernelEvent[] = []
  const manager = new SessionManager({
    sessionsRoot: path.join(dir, "sessions"),
    configDir: path.join(dir, "config"),
    inspectStm32Availability: async () => ({ available: false, reason: "test" }),
    subagents: { homeDir: dir },
    emit: (batch) => events.push(...batch),
    resolveModels: async () => {
      const models = createModels()
      models.setProvider(old.provider)
      if (configured) models.setProvider(added.provider)
      return { models, model: old.getModel() as Model<string> }
    },
  })
  try {
    const busy = await manager.create(dir)
    const idle = await manager.create(dir)
    await manager.setModel(idle.id, "auth-old", "old")
    await manager.prompt(busy.id, { text: "wait" })
    await vi.waitFor(() => expect(started).toBe(true))
    configured = true
    await manager.setAuth("deepseek", "test-key")
    expect(manager.status(busy.id).type).toBe("busy")
    await manager.setModel(idle.id, "auth-added", "new")
    await manager.prompt(idle.id, { text: "hello" })
    await vi.waitFor(() => expect(manager.status(idle.id).type).toBe("idle"))
    release()
    await vi.waitFor(() => expect(manager.status(busy.id).type).toBe("idle"))
    expect(events.filter((e) => e.type === "kernel.error")).toEqual([])
    const text = JSON.stringify(events)
    expect(text).toContain("new works")
    expect(text).toContain("old finished")
  } finally {
    release()
    await manager.disposeAll()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
