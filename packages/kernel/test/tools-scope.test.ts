import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import type {
  Applied,
  ChannelSpec,
  ChannelState,
  ScopeCapabilities,
  ScopeStatus,
  TimebaseSpec,
  TriggerSpec,
  Waveform,
} from "../src/host/domain/scope/driver.ts"
import { listCaptures, readCaptureMeta, readChannelCodes, readScopeConfig } from "../src/host/domain/scope/store.ts"
import { SCOPE_ACTIONS, SCOPE_CONTRACT, type ScopeInput } from "../src/host/tools/scope/contract.ts"
import { acquisitionBudget, type ScopeDevice } from "../src/host/tools/scope/evidence.ts"
import { createScopeTool, type ScopeTool } from "../src/host/tools/scope/session.ts"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=",
  "base64",
)
const invocation: AgentHarnessToolInvocation = {
  invocationId: "i",
  operationId: "o",
  turnId: "t",
  getMemo: async () => undefined,
  setMemo: async () => {},
}
let cwd: string
const tools: ScopeTool[] = []

class FakeScope implements ScopeDevice {
  driver = "fake"
  address = { kind: "usb" as const, serial: "SCOPE-1", driver: "fake" }
  identity = { vendor: "SIGLENT", model: "SDS824X HD", serial: "SCOPE-1", firmware: "test" }
  label = "usb:SCOPE-1"
  warnings: string[] = []
  closed = 0
  stopped = 0
  ran = 0
  singles = 0
  screenshotError = false
  readError = false
  runDuringRead = false
  waits: { ok: boolean; status: string }[] = []
  reads: { ch: number; maxPoints?: number; stride?: number }[] = []
  wait?: (signal?: AbortSignal) => Promise<{ ok: boolean; status: string }>
  startingSingle?: (signal?: AbortSignal) => Promise<void>
  st: ScopeStatus = {
    idn: this.identity,
    channels: [1, 2, 3, 4].map((ch) => ({
      ch,
      on: ch < 3,
      vdiv: 1,
      offset: 0,
      coupling: "DC",
      probe: 10,
      bwlimit: "FULL",
      unit: "V",
    })),
    timebase: { scale: 1e-3, delay: 0 },
    trigger: { type: "EDGE", source: "C1", mode: "AUTO", slope: "RISing", level: 1, status: "Auto" },
    acquire: { sampleRate: 3200, points: 32, mdepth: "32" },
  }
  async close() {
    this.closed++
  }
  async status() {
    return structuredClone(this.st)
  }
  async channel(ch: number) {
    return structuredClone(this.st.channels[ch - 1]!)
  }
  async trigger() {
    return structuredClone(this.st.trigger)
  }
  async triggerStatus() {
    return this.st.trigger.status
  }
  capabilities(status: ScopeStatus = this.st): ScopeCapabilities {
    return {
      driver: this.driver,
      model: this.identity.model,
      verified: true,
      channels: 4,
      enabledChannels: status.channels.filter((c) => c.on).length,
      units: ["V", "A"],
      couplings: ["DC", "AC", "GND"],
      bwlimits: ["FULL", "20M"],
      probes: [1, 10],
      customProbe: false,
      timebase: { min: 1e-9, max: 10, steps: "1-2-5" },
      triggerTypes: ["edge"],
      triggerSources: ["C1", "C2", "C3", "C4", "LINE"],
      triggerSlopes: ["rising", "falling"],
      triggerModes: ["auto", "normal", "single"],
      memoryDepths: status.channels.filter((c) => c.on).length > 1 ? ["32"] : ["32", "64"],
      sampleRates: [3200],
      measureTypes: ["FREQ", "RMS"],
      externalTrigger: false,
      screenshot: true,
      measurements: true,
    }
  }
  async setChannel(c: ChannelSpec): Promise<Applied<ChannelState>> {
    Object.assign(this.st.channels[c.ch - 1]!, c)
    return { state: await this.channel(c.ch), mismatches: c.vdiv === 3 ? ["vdiv requested 3, read back 2"] : [] }
  }
  async setTimebase(c: TimebaseSpec) {
    Object.assign(this.st.timebase, c)
    return { state: this.st.timebase, mismatches: [] }
  }
  async setMemoryDepth(mdepth: string) {
    this.st.acquire.mdepth = mdepth
    return { state: this.st.acquire, mismatches: [] }
  }
  async setTrigger(t: TriggerSpec) {
    Object.assign(this.st.trigger, t)
    return { state: this.st.trigger, mismatches: [] }
  }
  async autoset() {}
  async run() {
    this.ran++
    this.st.trigger.status = "Auto"
  }
  async stop() {
    this.stopped++
    this.st.trigger.status = "Stop"
  }
  async single(signal?: AbortSignal) {
    this.singles++
    this.st.trigger.status = "Ready"
    this.st.trigger.mode = "SINGle"
    await this.startingSingle?.(signal)
  }
  async waitForStop(_ms: number, signal?: AbortSignal) {
    if (this.wait) return this.wait(signal)
    const result = this.waits.shift() ?? { ok: true, status: "Stop" }
    this.st.trigger.status = result.status
    return result
  }
  async readWaveform(ch: number, options: { maxPoints?: number; stride?: number }): Promise<Waveform> {
    this.reads.push({ ch, ...options })
    if (this.readError) throw new Error("scope: USB read failed")
    if (this.runDuringRead) this.st.trigger.status = "Auto"
    const stride = options.stride ?? 2
    const count = Math.ceil(32 / stride)
    if (count > options.maxPoints!) throw new Error("scope: record exceeds budget; lower mdepth")
    return {
      ch,
      codes: Int16Array.from({ length: count }, (_, i) => (i % 8 < 4 ? 10 : -10)),
      scale: { gain: 1, offset: 0, codePerDiv: 100, probe: 10 },
      time: { interval: stride / 3200, tdiv: 1e-3, delay: (ch - 1) * 0.001, grid: 10 },
      stride,
      sampleRate: 3200,
      recordPoints: 32,
      unit: this.st.channels[ch - 1]!.unit,
      probe: 10,
    }
  }
  async measure(items: { type: string; source: string }[]) {
    return { results: items.map((i) => ({ ...i, value: 1000 })), mismatches: [] }
  }
  async readMeasurements(n: number) {
    return Array<number | null>(n).fill(1000)
  }
  async screenshot() {
    if (this.screenshotError) throw new Error("screenshot not supported")
    return PNG
  }
}

function fixture(device = new FakeScope(), idleCloseMs = 0) {
  let opens = 0
  const tool = createScopeTool({
    open: async () => {
      opens++
      return device
    },
    listUsb: async () => [{ serial: device.identity.serial, product: device.identity.model }],
    idleCloseMs,
  })
  tools.push(tool)
  const run = (params: ScopeInput, signal?: AbortSignal, directory = cwd) =>
    tool.execute(
      "call",
      params,
      () => {},
      { env: new NodeExecutionEnv({ cwd: directory }) },
      invocation,
      signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
    )
  return { tool, device, run, opens: () => opens }
}
const text = (result: Awaited<ReturnType<ReturnType<typeof fixture>["run"]>>) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "scope-tool-"))
})
afterEach(async () => {
  while (tools.length) await tools.pop()!.dispose()
  await rm(cwd, { recursive: true, force: true })
})

describe("scope contract and evidence", () => {
  it("standalone screenshot initializes artifact isolation without connect or capture", async () => {
    const f = fixture()
    const out = await f.run({ action: "screenshot" })
    expect(await readFile(path.join(cwd, ".yoma", "scope", ".gitignore"), "utf8")).toBe("*\n")
    expect(await readFile(out.details!.file!)).toEqual(PNG)
    expect(out.content.find((c) => c.type === "image")).toMatchObject({ data: PNG.toString("base64") })
    expect(await listCaptures(cwd)).toHaveLength(0)
  })
  it("has all actions, exact defaults and explicit human wiring guidance", () => {
    expect(SCOPE_CONTRACT.parameters.properties.action.anyOf.map((s) => s.const)).toEqual(SCOPE_ACTIONS)
    expect(acquisitionBudget({ action: "capture" })).toEqual({ quality: "exact", maxPoints: 2_000_000, stride: 1 })
    expect(() => acquisitionBudget({ action: "capture", stride: 2 })).toThrow(/exact/)
    expect(SCOPE_CONTRACT.guidelines.join(" ")).toContain("wait for their reply")
    expect(SCOPE_CONTRACT.guidelines.join(" ")).toContain("bandwidth is not a scaling factor")
    expect(SCOPE_CONTRACT.parameters.properties.channels.items.properties.unit.anyOf.map((u) => u.const)).toEqual([
      "V",
      "A",
    ])
    expect(SCOPE_CONTRACT.summary({})).toBe("")
  })
  it("persists exact original samples, per-channel time and the frozen screenshot", async () => {
    const f = fixture()
    const out = await f.run({ action: "capture" })
    expect(f.device.reads.map((r) => r.stride)).toEqual([1, 1])
    expect(f.device.ran).toBe(1)
    const meta = await readCaptureMeta(out.details!.dir!)
    expect(meta.quality).toBe("exact")
    expect(meta.channels[1]!.time!.delay).toBe(0.001)
    expect((await readChannelCodes(out.details!.dir!, meta.channels[0]!)).length).toBe(32)
    expect(await readFile(path.join(out.details!.dir!, meta.screenshot!.file))).toEqual(PNG)
    expect(out.content.find((c) => c.type === "image")).toMatchObject({
      data: PNG.toString("base64"),
      mimeType: "image/png",
    })
    expect(JSON.stringify(out.details).length).toBeLessThan(4000)
    expect(text(await f.run({ action: "samples", channel: 2, limit: 2 }))).toContain("-4 ms")
  })
  it("never turns a previously stopped instrument back on", async () => {
    const f = fixture()
    f.device.st.trigger.status = "Stop"
    await f.run({ action: "capture" })
    expect(f.device.ran).toBe(0)
  })
  it("retains successful waveform if optional screenshot fails", async () => {
    const f = fixture()
    f.device.screenshotError = true
    const out = await f.run({ action: "capture" })
    expect(text(out)).toContain("waveform evidence retained")
    expect(await listCaptures(cwd)).toHaveLength(1)
    expect((await readCaptureMeta(out.details!.dir!)).screenshot).toBeUndefined()
    expect(f.device.closed).toBe(1)
  })
  it("labels overview as decimated, including later offline samples", async () => {
    const f = fixture()
    const out = await f.run({ action: "capture", quality: "overview", stride: 2 })
    expect(out.details!.quality).toBe("overview")
    expect(text(out)).toContain("cannot prove")
    await f.run({ action: "disconnect" })
    expect(text(await f.run({ action: "samples" }))).toContain("omitted samples cannot be recovered")
  })
  it("classifies legacy samples using the selected channel's stored depth and stride", async () => {
    const f = fixture()
    const out = await f.run({ action: "capture" })
    const meta = await readCaptureMeta(out.details!.dir!)
    delete meta.quality
    meta.channels[0]!.recordPoints = 64 // A partial, un-decimated legacy record.
    await writeFile(path.join(out.details!.dir!, "capture.json"), JSON.stringify(meta))
    const partial = await f.run({ action: "samples", channel: 1 })
    expect(partial.details!.quality).toBe("overview")
    expect(text(partial)).toContain("32 stored points of a 64-point record")
    expect((await f.run({ action: "samples", channel: 2 })).details!.quality).toBe("exact")
    meta.channels[1]!.stride = 2 // Top-level stride is still 1; this channel was decimated.
    meta.channels[1]!.recordPoints = 64
    await writeFile(path.join(out.details!.dir!, "capture.json"), JSON.stringify(meta))
    const decimated = await f.run({ action: "samples", channel: 2 })
    expect(decimated.details!.quality).toBe("overview")
    expect(text(decimated)).toContain("Decimated acquisition")
  })
  it("preserves explicit overview quality even when the selected channel contains every point", async () => {
    const f = fixture()
    await f.run({ action: "capture", quality: "overview", stride: 1 })
    const out = await f.run({ action: "samples" })
    expect(out.details!.quality).toBe("overview")
    expect(text(out)).toContain("absence of a glitch is not established")
  })
  it("reports setup readback mismatches", async () => {
    const f = fixture()
    expect(text(await f.run({ action: "setup", channels: [{ ch: 1, vdiv: 3 }] }))).toContain(
      "Mismatch: vdiv requested 3",
    )
  })
  it("includes units and sample count with repeated instrument measurements", async () => {
    const f = fixture()
    const out = await f.run({ action: "measure", items: [{ type: "FREQ", source: "C1" }], repeat: 2, intervalMs: 20 })
    expect(out.details!.measurements![0]).toMatchObject({ unit: "Hz", value: 1000, n: 2, mean: 1000 })
    expect(text(out)).toContain("1000 Hz")
  })
  it("keeps cwd dynamic and never picks a capture from a previous project", async () => {
    const f = fixture()
    await f.run({ action: "capture" })
    const next = path.join(cwd, "other")
    expect(text(await f.run({ action: "list" }, undefined, next))).toContain("No captures")
    await expect(f.run({ action: "samples" }, undefined, next)).rejects.toThrow(/no capture/)
    const out = await f.run({ action: "capture" }, undefined, next)
    expect(out.details!.dir).toContain(path.join(next, ".yoma"))
  })
  it("does not save a partial USB transfer and releases ownership", async () => {
    const f = fixture()
    f.device.readError = true
    await expect(f.run({ action: "capture" })).rejects.toThrow(/USB read/)
    expect(await listCaptures(cwd)).toHaveLength(0)
    expect(f.device.closed).toBe(1)
    await fixture().run({ action: "connect" })
  })
  it("refuses to combine channels if acquisition resumes during transfer", async () => {
    const f = fixture()
    f.device.runDuringRead = true
    await expect(f.run({ action: "capture" })).rejects.toThrow(/resumed while reading/)
    expect(await listCaptures(cwd)).toHaveLength(0)
    expect(f.device.reads).toHaveLength(1)
  })
  it("uses the source channel unit for instrument amplitude measurements", async () => {
    const f = fixture()
    f.device.st.channels[0]!.unit = "A"
    const out = await f.run({ action: "measure", items: [{ type: "RMS", source: "C1" }] })
    expect(out.details!.measurements![0]!.unit).toBe("A")
  })
  it("uses the actual trigger-source unit in status and arm reports", async () => {
    const f = fixture()
    f.device.st.channels[0]!.unit = "A"
    expect(text(await f.run({ action: "status" }))).toContain("@ 1 A,")
    expect(text(await f.run({ action: "arm" }))).toContain("@ 1 A (status")
  })
  it("passes configured current units through setup and into saved text plots", async () => {
    const f = fixture()
    const setup = await f.run({ action: "setup", channels: [{ ch: 1, unit: "A", probe: 1 }] })
    expect(setup.details!.channels![0]).toMatchObject({ unit: "A", probe: 1 })
    const out = await f.run({ action: "capture", channels: [{ ch: 1 }], plot: true })
    expect(text(out)).toMatch(/A\s+│/)
    expect(text(out)).not.toMatch(/V\s+│/)
    expect((await readCaptureMeta(out.details!.dir!)).channels[0]!.unit).toBe("A")
  })
})

describe("scope lifecycle", () => {
  it("status followed by dispose leaves acquisition running", async () => {
    const f = fixture()
    await f.run({ action: "status" })
    await f.tool.dispose()
    expect(f.device.stopped).toBe(0)
    expect(f.device.st.trigger.status).toBe("Auto")
    expect(f.device.closed).toBe(1)
  })
  it("standalone screenshot followed by disconnect leaves acquisition running", async () => {
    const f = fixture()
    await f.run({ action: "screenshot" })
    await f.run({ action: "disconnect" })
    expect(f.device.stopped).toBe(0)
    expect(f.device.st.trigger.status).toBe("Auto")
  })
  it("capture resume=true is not undone when the session closes", async () => {
    const f = fixture()
    await f.run({ action: "capture", resume: true })
    expect(f.device.stopped).toBe(1)
    expect(f.device.ran).toBe(1)
    await f.tool.dispose()
    expect(f.device.stopped).toBe(1)
    expect(f.device.st.trigger.status).toBe("Auto")
  })
  it.each(["arm", "capture"] as const)("dispose stops %s while the single command has not resolved", async (action) => {
    const f = fixture()
    let started!: () => void
    const entered = new Promise<void>((r) => {
      started = r
    })
    f.device.startingSingle = (signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const pending = f.run({ action, mode: "single" }).catch((e: unknown) => String(e))
    await entered
    await f.tool.dispose()
    expect(await pending).toMatch(/aborted/)
    expect(f.device.stopped).toBe(1)
    expect(f.device.closed).toBe(1)
    expect(f.device.st.trigger.status).toBe("Stop")
  })
  it("reserves an unknown-serial USB device before the identification handshake", async () => {
    let opened!: () => void
    let proceed!: () => void
    const entered = new Promise<void>((r) => {
      opened = r
    })
    const handshake = new Promise<void>((r) => {
      proceed = r
    })
    const device = new FakeScope()
    const tool = createScopeTool({
      listUsb: async () => [{ product: "Siglent" }],
      open: async () => {
        opened()
        await handshake
        return device
      },
      idleCloseMs: 0,
    })
    tools.push(tool)
    const first = tool.execute(
      "call",
      { action: "connect" },
      () => {},
      { env: new NodeExecutionEnv({ cwd }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
    await entered
    const other = fixture()
    await expect(other.run({ action: "connect", address: "usb:SCOPE-1" })).rejects.toThrow(/another session/)
    expect(other.opens()).toBe(0)
    proceed()
    await first
  })
  it("a driver that refuses the instrument releases the provisional lease for the next session", async () => {
    let opens = 0
    const tool = createScopeTool({
      listUsb: async () => [{ product: "Siglent" }],
      open: async () => {
        opens++
        throw new Error("scope: Siglent Technologies SDG2042X is not a Siglent SDS oscilloscope")
      },
      idleCloseMs: 0,
    })
    tools.push(tool)
    await expect(
      tool.execute("call", { action: "connect" }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT),
    ).rejects.toThrow(/not a Siglent SDS/)
    expect(opens).toBe(1)
    await fixture().run({ action: "connect" })
  })
  it("connect and status return capabilities, the driver name and its warnings; config remembers driver@address", async () => {
    const device = new FakeScope()
    device.warnings = ["FakeScope: not hardware"]
    const f = fixture(device)
    const out = await f.run({ action: "connect" })
    expect(out.details!.driver).toBe("fake")
    expect(out.details!.warnings).toEqual(["FakeScope: not hardware"])
    expect(out.details!.capabilities).toMatchObject({ driver: "fake", verified: true, enabledChannels: 2, memoryDepths: ["32"] })
    expect(text(out)).toContain("Warning: FakeScope: not hardware")
    expect(text(out)).toContain("memory depths 32")
    expect((await readScopeConfig(cwd))?.address).toBe("fake@usb:SCOPE-1")
    device.st.channels[1]!.on = false
    const status = await f.run({ action: "status" })
    expect(status.details!.capabilities!.memoryDepths).toEqual(["32", "64"])
    const capture = await f.run({ action: "capture", channels: [{ ch: 1 }] })
    expect(capture.details!.capabilities).toBeUndefined()
    expect(capture.details!.warnings).toEqual(["FakeScope: not hardware"])
    expect((await readCaptureMeta(capture.details!.dir!)).driver).toBe("fake")
  })
  it("accepts a LAN address and a driver-prefixed address instead of insisting on USB", async () => {
    const seen: string[] = []
    const device = new FakeScope()
    const tool = createScopeTool({
      open: async (address) => {
        seen.push(JSON.stringify(address))
        return device
      },
      listUsb: async () => [],
      idleCloseMs: 0,
    })
    tools.push(tool)
    const run = (params: ScopeInput) =>
      tool.execute("call", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT)
    await run({ action: "connect", address: "192.168.1.20" })
    await run({ action: "disconnect" })
    await run({ action: "connect", address: "fake@usb:SCOPE-1" })
    expect(seen).toEqual([
      JSON.stringify({ kind: "tcp", host: "192.168.1.20", port: 5025 }),
      JSON.stringify({ kind: "usb", serial: "SCOPE-1", driver: "fake" }),
    ])
  })
  it("devices lists the driver catalog even when no USB instrument is present", async () => {
    const tool = createScopeTool({ listUsb: async () => [], idleCloseMs: 0 })
    tools.push(tool)
    const out = await tool.execute("call", { action: "devices" }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT)
    expect(out.details!.drivers!.map((d) => d.name)).toContain("siglent")
    expect(out.details!.drivers!.map((d) => d.name)).not.toContain("demo")
    expect(text(out)).toContain("SDS824X HD")
    expect(text(out)).toContain("verified on hardware")
  })
  it("collect without arm never opens hardware", async () => {
    const f = fixture()
    await expect(f.run({ action: "collect" })).rejects.toThrow(/nothing armed/)
    expect(f.opens()).toBe(0)
  })
  it("serializes parallel arm calls and rejects the second", async () => {
    const f = fixture()
    const result = await Promise.allSettled([f.run({ action: "arm" }), f.run({ action: "arm" })])
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected"])
    expect(f.device.singles).toBe(1)
  })
  it("holds the device through collect timeout; rejects other sessions until disconnect", async () => {
    const a = fixture()
    const b = fixture()
    await a.run({ action: "arm" })
    a.device.waits.push({ ok: false, status: "Ready" })
    const timed = await a.run({ action: "collect", timeoutMs: 100 })
    expect(timed.details).toMatchObject({ timedOut: true, armed: true })
    expect(await listCaptures(cwd)).toHaveLength(0)
    await expect(b.run({ action: "setup", channels: [{ ch: 1, vdiv: 2 }] })).rejects.toThrow(/another session/)
    expect(b.opens()).toBe(0)
    expect((await a.run({ action: "collect" })).details!.captureId).toBeTruthy()
    await a.run({ action: "disconnect" })
    await b.run({ action: "connect" })
    expect(b.opens()).toBe(1)
  })
  it("does not idle-close while armed", async () => {
    const f = fixture(new FakeScope(), 10)
    await f.run({ action: "arm" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.device.closed).toBe(0)
    await f.run({ action: "stop" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.device.closed).toBe(1)
  })
  it("failed collect budget keeps the frozen record armed for a corrected retry", async () => {
    const f = fixture()
    await f.run({ action: "arm", points: 16 })
    await expect(f.run({ action: "collect" })).rejects.toThrow(/budget/)
    expect(f.device.ran).toBe(0)
    expect((await f.run({ action: "status" })).details!.armed).toBe(true)
    await f.run({ action: "collect", points: 32 })
    expect(f.device.ran).toBe(1)
  })
  it("single timeout saves no false evidence and stops waiting", async () => {
    const f = fixture()
    f.device.waits.push({ ok: false, status: "Ready" })
    expect((await f.run({ action: "capture", mode: "single" })).details!.timedOut).toBe(true)
    expect(await listCaptures(cwd)).toHaveLength(0)
    expect(f.device.stopped).toBeGreaterThan(0)
  })
  it("dispose aborts an active collect, closes connection and rejects queued work", async () => {
    const f = fixture()
    await f.run({ action: "arm" })
    let started!: () => void
    const entered = new Promise<void>((r) => {
      started = r
    })
    f.device.wait = (signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const pending = f.run({ action: "collect" }).catch((e: unknown) => String(e))
    await entered
    const queued = f.run({ action: "arm" }).catch((e: unknown) => String(e))
    await f.tool.dispose()
    expect(await pending).toMatch(/aborted/)
    expect(await queued).toMatch(/closing/)
    expect(f.device.closed).toBe(1)
    expect(f.device.stopped).toBeGreaterThan(0)
    await fixture().run({ action: "connect" })
  })
  it("stop interrupts a collect immediately instead of waiting behind its trigger timeout", async () => {
    const f = fixture()
    await f.run({ action: "arm" })
    let started!: () => void
    const entered = new Promise<void>((r) => {
      started = r
    })
    f.device.wait = (signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const collecting = f.run({ action: "collect" }).catch((e: unknown) => String(e))
    await entered
    const queued = f.run({ action: "arm" }).catch((e: unknown) => String(e))
    await f.run({ action: "stop" })
    expect(await collecting).toMatch(/aborted/)
    expect(await queued).toMatch(/superseded/)
    expect(f.device.singles).toBe(1)
  })
  it("external cancellation drops a poisoned connection and keeps samples offline", async () => {
    const f = fixture()
    await f.run({ action: "arm" })
    let started!: () => void
    const entered = new Promise<void>((r) => {
      started = r
    })
    f.device.wait = (signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const abort = new AbortController()
    const collecting = f.run({ action: "collect" }, abort.signal).catch((e: unknown) => String(e))
    await entered
    abort.abort()
    expect(await collecting).toMatch(/aborted/)
    expect(f.device.closed).toBe(1)
    expect(await listCaptures(cwd)).toHaveLength(0)
    await fixture().run({ action: "connect" })
  })
  it("cannot retarget or reconfigure an armed acquisition", async () => {
    const f = fixture()
    await f.run({ action: "arm" })
    await expect(f.run({ action: "setup", timebase: { scale: 0.1 } })).rejects.toThrow(/already armed/)
    await expect(f.run({ action: "collect", address: "usb:OTHER" })).rejects.toThrow(/switch instruments/)
    await expect(f.run({ action: "collect" }, undefined, path.join(cwd, "elsewhere"))).rejects.toThrow(
      /another project/,
    )
  })
})
