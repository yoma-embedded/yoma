import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai"
import { createKernelClient } from "../client.ts"
import { createKernelHost, SessionManager, type KernelHost } from "./index.ts"
import type { KernelEvent, KernelMethod } from "../protocol.ts"

const hosts: KernelHost[] = []
const roots: string[] = []
const servers: net.Server[] = []
const sockets = new Set<net.Socket>()
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function setup(
  resolveModels: NonNullable<Parameters<typeof createKernelHost>[0]["resolveModels"]> = vi.fn(async (): Promise<never> => { throw new Error("No model configured") }),
  inspectStm32Availability: NonNullable<Parameters<typeof createKernelHost>[0]["inspectStm32Availability"]> = async () => ({ available: false, reason: "isolated test" }),
) {
  const root = await mkdtemp(path.join(tmpdir(), "yoma-instruments-"))
  roots.push(root)
  const events: KernelEvent[] = []
  const host = createKernelHost({
    sessionsRoot: path.join(root, "sessions"), stateDir: path.join(root, "state"), configDir: path.join(root, "config"),
    resolveModels, onEvents: (batch) => events.push(...batch),
    inspectStm32Availability,
  })
  hosts.push(host)
  const client = createKernelClient({ request: (method, params) => host.handle(method as KernelMethod, params as never), subscribe: () => () => {} })
  const session = await client.session.create({ directory: root })
  return { root, client, session, resolveModels, events }
}

async function source() {
  let connected: net.Socket | undefined
  const server = net.createServer((socket) => {
    sockets.add(socket)
    connected = socket
    socket.on("close", () => sockets.delete(socket))
    // Disconnect can close before this fixture writes BOOT, which legitimately resets its peer.
    socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") throw error })
    socket.write("BOOT ready\n")
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  return { tcp: `127.0.0.1:${address.port}`, socket: () => connected }
}

describe("manual instruments", () => {
  it.skipIf(process.platform === "win32" || spawnSync("python3", ["-c", "import pty"]).status !== 0)("sends exact serial bytes while a log wait is pending, without a model or transcript", async () => {
    const { client, session, resolveModels } = await setup()
    const device = spawn("python3", ["-u", "-c", `
import os, pty
master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)
while True:
    data = os.read(master, 4096)
    print(data.hex(), flush=True)
    os.write(master, b"ACK " + data.hex().encode() + b"\\n")
`], { stdio: ["ignore", "pipe", "pipe"] })
    let received = ""
    device.stdout.setEncoding("utf8")
    device.stdout.on("data", (chunk) => { received += chunk })
    const run = (input: Record<string, unknown>) => client.instrument.execute({ sessionID: session.id, tool: "log", input })
    try {
      await vi.waitFor(() => expect(received).toContain("\n"))
      const port = received.split("\n")[0]!
      const started = await run({ action: "start", port, baud: 115200 })
      expect(started.details?.writable).toBe(true)
      const waiting = run({ action: "wait", pattern: "ACK", timeoutMs: 5000 })
      // Let the wait enter its queue before sending; TX must bypass that queue.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const sent = await run({ action: "write", data: "你好", lineEnding: "crlf" })
      expect(sent.details?.bytesSent).toBe(8)
      expect((await waiting).details?.matched).toBe(true)
      await run({ action: "write", data: "00 ff 03", encoding: "hex", lineEnding: "none" })
      await vi.waitFor(() => expect(received).toContain("00ff03"))
      expect(received).toContain("e4bda0e5a5bd0d0a")
      await expect(run({ action: "write", data: "f", encoding: "hex" })).rejects.toThrow(/byte pairs/)
      expect((await client.session.messages({ sessionID: session.id })).items).toEqual([])
      expect(resolveModels).not.toHaveBeenCalled()
      await run({ action: "stop" })
      await expect(run({ action: "write", data: "after disconnect" })).rejects.toThrow()
    } finally {
      await run({ action: "stop" }).catch(() => {})
      device.kill("SIGKILL")
    }
  })

  it("does not let instrument polling reopen a session during repository deletion, and failed deletion can retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yoma-instrument-delete-"))
    roots.push(root)
    const manager = new SessionManager({ sessionsRoot: path.join(root, "sessions"), configDir: path.join(root, "config"), emit: () => {} })
    const repo = (manager as unknown as { repo: { delete(...args: unknown[]): Promise<void> } }).repo
    const original = repo.delete.bind(repo)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      const session = await manager.create(root)
      await manager.executeInstrument({ sessionID: session.id, tool: "log", input: { action: "status" } })
      repo.delete = async (...args) => { entered(); await gate; return original(...args) }
      const deleting = manager.delete(session.id)
      await reached
      await expect(manager.executeInstrument({ sessionID: session.id, tool: "log", input: { action: "status" } })).rejects.toThrow()
      await expect(manager.messages(session.id)).rejects.toThrow()
      release()
      await deleting
      expect(await manager.list(root)).toEqual([])
      const second = await manager.create(root)
      repo.delete = async () => { throw new Error("fixture filesystem error") }
      await expect(manager.delete(second.id)).rejects.toThrow("fixture filesystem error")
      expect((await manager.executeInstrument({ sessionID: second.id, tool: "log", input: { action: "status" } })).details?.running).toBe(false)
      repo.delete = original
      await manager.delete(second.id)
    } finally { release?.(); await manager.disposeAll() }
  })

  it("disconnects while model initialization is pending and remains usable after it fails", async () => {
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { client, session } = await setup(async () => { entered(); await gate; throw new Error("fixture model unavailable") })
    const feed = await source()
    const run = (input: Record<string, unknown>) => client.instrument.execute({ sessionID: session.id, tool: "log", input })
    await run({ action: "start", tcp: feed.tcp })
    const prompt = client.session.prompt(session.id, { text: "Try model" }).then(() => "ok", (error: Error) => error.message)
    try {
      await reached
      const stopped = run({ action: "stop" })
      let result: Awaited<typeof stopped> | undefined
      void stopped.then((value) => { result = value })
      await vi.waitFor(() => expect(result?.details?.running).toBe(false), { timeout: 1000 })
      release()
      expect(await prompt).toContain("fixture model unavailable")
      expect((await run({ action: "status" })).details?.running).toBe(false)
    } finally { release(); await prompt }
  })

  it("preserves a manual capture started during harness initialization if that initialization fails", async () => {
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const models = createModels()
    const faux = fauxProvider({ provider: `manual-open-fail-${Date.now()}`, models: [{ id: "plain" }] })
    models.setProvider(faux.provider)
    const { client, session } = await setup(async () => ({ models, model: faux.getModel() as Model<string> }), async () => {
      entered(); await gate; throw new Error("fixture discovery failed")
    })
    const feed = await source()
    const prompt = client.session.prompt(session.id, { text: "Initialize" }).then(() => "ok", (error: Error) => error.message)
    try {
      await reached
      const started = await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "start", tcp: feed.tcp } })
      expect(started.details?.running).toBe(true)
      release()
      expect(await prompt).toContain("fixture discovery failed")
      expect((await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "status" } })).details?.running).toBe(true)
    } finally { release(); await prompt }
  })
  it("uses real capture without a model, a prompt, or transcript messages; deleting releases it", async () => {
    const { client, session, resolveModels, events } = await setup()
    const feed = await source()
    const run = (input: Record<string, unknown>) => client.instrument.execute({ sessionID: session.id, tool: "log", input })
    expect((await run({ action: "status" })).details?.running).toBe(false)
    const started = await run({ action: "start", tcp: feed.tcp })
    expect(started.details?.running).toBe(true)
    await vi.waitFor(async () => {
      expect((await run({ action: "read", since: 0 })).text).toContain("BOOT ready")
    })
    expect(await readFile(String(started.details?.file), "utf8")).toContain("BOOT ready")
    expect((await client.session.messages({ sessionID: session.id })).items).toEqual([])
    expect(resolveModels).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "message.updated")).toBe(false)
    await client.session.delete(session.id)
    await vi.waitFor(() => expect(feed.socket()?.destroyed).toBe(true))
  })

  it("serializes competing starts and validates arguments before touching an instrument", async () => {
    const { client, session, resolveModels } = await setup()
    const feed = await source()
    const run = (input: Record<string, unknown>) => client.instrument.execute({ sessionID: session.id, tool: "log", input })
    await expect(run({ action: "invented" })).rejects.toThrow("invalid arguments")
    const attempts = await Promise.allSettled([run({ action: "start", tcp: feed.tcp }), run({ action: "start", tcp: feed.tcp })])
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect((await run({ action: "stop" })).details?.running).toBe(false)
    const gdb = await client.instrument.execute({ sessionID: session.id, tool: "gdb", input: { action: "status" } })
    expect(gdb.details?.state).toBe("no-session")
    expect(resolveModels).not.toHaveBeenCalled()
  })

  it("hands the same running log to the agent and manual controls", async () => {
    const models = createModels()
    const faux = fauxProvider({ provider: `manual-${Date.now()}`, models: [{ id: "plain" }] })
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("log", { action: "status" })]),
      fauxAssistantMessage([fauxText("Capture verified")]),
    ])
    const resolveModels = vi.fn(async () => ({ models, model: faux.getModel() as Model<string> }))
    const { client, session } = await setup(resolveModels)
    const feed = await source()
    await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "start", tcp: feed.tcp } })
    expect(resolveModels).not.toHaveBeenCalled()
    await client.session.prompt(session.id, { text: "Read capture status" })
    await vi.waitFor(async () => {
      const page = await client.session.messages({ sessionID: session.id })
      const log = page.items.flatMap((item) => item.parts).find((part) => part.type === "tool" && part.tool === "log")
      expect(log?.type === "tool" && log.state.status === "completed" && log.state.output).toContain(feed.tcp)
    }, { timeout: 10000 })
    expect((await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "stop" } })).details?.running).toBe(false)
  })

  it("manual disconnect wakes a long waiter immediately and status remains readable", async () => {
    const { client, session } = await setup()
    const feed = await source()
    const run = (input: Record<string, unknown>) => client.instrument.execute({ sessionID: session.id, tool: "log", input })
    await run({ action: "start", tcp: feed.tcp })
    const waiting = run({ action: "wait", pattern: "never", timeoutMs: 120000 })
    expect((await run({ action: "status" })).details?.running).toBe(true)
    expect((await run({ action: "stop" })).details?.running).toBe(false)
    expect((await waiting).details?.matched).toBe(false)
  })

  it("stops the agent before awaiting a manual call queued behind the agent waiter", async () => {
    const models = createModels()
    const faux = fauxProvider({ provider: `manual-close-${Date.now()}`, models: [{ id: "plain" }] })
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("log", { action: "wait", pattern: "never", timeoutMs: 120000 })]),
      fauxAssistantMessage([fauxText("Finished")]),
    ])
    const { client, session, events } = await setup(async () => ({ models, model: faux.getModel() as Model<string> }))
    const feed = await source()
    await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "start", tcp: feed.tcp } })
    await client.session.prompt(session.id, { text: "Wait for log marker" })
    await vi.waitFor(() => expect(events.some((event) => event.type === "message.part.updated" &&
      event.part.type === "tool" && event.part.tool === "log" && event.part.state.status === "running")).toBe(true))
    const reading = client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "read" } })
      .then(() => "read", () => "closed")
    // Let the real RPC enter the tool's queue behind the ongoing agent wait.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await client.session.delete(session.id)
    await reading
    await vi.waitFor(() => expect(feed.socket()?.destroyed).toBe(true))
  })

  it("closing cancels a pending manual wait before disposing its source", async () => {
    const { client, session } = await setup()
    const feed = await source()
    await client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "start", tcp: feed.tcp } })
    const waiting = client.instrument.execute({ sessionID: session.id, tool: "log", input: { action: "wait", pattern: "never", timeoutMs: 120000 } })
    // Attach rejection handling before deletion aborts the waiter.
    const outcome = waiting.then((result) => result.text, () => "aborted")
    await client.session.delete(session.id)
    expect(await outcome).toContain("aborted")
    await vi.waitFor(() => expect(feed.socket()?.destroyed).toBe(true))
  })
})
