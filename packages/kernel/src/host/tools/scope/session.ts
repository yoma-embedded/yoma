/** One serialized session per instrument. Device ownership survives arm → collect. */
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { si } from "../../domain/scope/analyze.ts"
import {
  formatScopeAddress,
  scopeAddressKey,
  type ScopeAddress,
  type ScopeDriverSpec,
  type ScopeStatus,
} from "../../domain/scope/driver.ts"
import {
  discoverUsbScopes,
  openScope,
  parseRegisteredAddress,
  scopeCatalog,
  scopeDrivers,
} from "../../domain/scope/registry.ts"
import {
  ensureScopeDir,
  listCaptures,
  readScopeConfig,
  SCOPE_DIR,
  SCOPE_SCREENS_DIR,
  writeScopeConfig,
} from "../../domain/scope/store.ts"
import type { Static } from "typebox"
import { normalizeScopeArguments, SCOPE_CONTRACT, type ScopeDetails, type ScopeInput } from "./contract.ts"
import { acquisitionBudget, saveEvidence, savedSamples, type ScopeDevice } from "./evidence.ts"

export interface ScopeToolOptions {
  /** Test seam: replaces the registry's openScope. Production resolves the driver from the address or *IDN?. */
  open?: (address: ScopeAddress, signal?: AbortSignal) => Promise<ScopeDevice>
  listUsb?: () => Promise<{ serial?: string; product?: string; vendorId?: number }[]>
  /** Registry to use; default scopeDrivers() (siglent, plus demo when YOMA_SCOPE_DEMO is set). */
  drivers?: readonly ScopeDriverSpec[]
  idleCloseMs?: number
}
export type ScopeTool = AgentHarnessTool<ExecutionToolContext, typeof SCOPE_CONTRACT.parameters, ScopeDetails> & {
  dispose(): Promise<void>
}
type Result = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
  details: ScopeDetails
}
const textResult = (text: string, details: ScopeDetails): Result => ({ content: [{ type: "text", text }], details })
const leases = new Map<string, symbol>()
const offline = new Set(["samples", "list", "devices"])
const whileArmed = new Set(["collect", "status", "screenshot", "stop", "disconnect"])

function measurementUnit(type: string, channelUnit = "unknown"): string {
  if (/FREQ/i.test(type)) return "Hz"
  if (/AREA/i.test(type)) return `${channelUnit}·s`
  if (/SLOPE/i.test(type)) return `${channelUnit}/s`
  if (/PHA/i.test(type)) return "°"
  if (/DUTY|OVS|PRE/i.test(type)) return "%"
  if (/CYCLES|EDGES|PULSES/i.test(type)) return "count"
  if (/PER|WID|RISE|FALL|DELAY|TMAX|TMIN|TIMEL|SKEW|^F[RF][RF]$|^L[RF][RF]$|TS[RF]|TH[RF]|CCJ/i.test(type)) return "s"
  if (/^(PKPK|MAX|MIN|AMPL|TOP|BASE|LEVELX|CMEAN|MEAN|STDEV|VSTD|RMS|CRMS|MEDIAN|CMEDIAN|ULOW)/i.test(type))
    return channelUnit
  return "unknown"
}

export function createScopeTool(options: ScopeToolOptions = {}): ScopeTool {
  const drivers = options.drivers ?? scopeDrivers()
  const open = options.open ?? ((address, signal) => openScope(address, { signal, drivers }))
  const listUsb = options.listUsb ?? (() => discoverUsbScopes(drivers))
  const owner = Symbol("scope session")
  const keys = new Set<string>()
  const lastCaptures = new Map<string, string>()
  let scope: ScopeDevice | undefined
  let address: ScopeAddress | undefined
  let armed: { at: number; params: ScopeInput; before: ScopeStatus; cwd: string } | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let active: AbortController | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let epoch = 0
  // Only an acquisition this tool started and has not observed stopped needs cancellation on close.
  let needsStop = false

  function claim(key: string): void {
    // An instrument without a readable USB serial cannot be distinguished until *IDN?.
    if ([...leases].some(([held, holder]) => holder !== owner && (held === key || held === "usb" || key === "usb")))
      throw new Error(
        "scope: this instrument is owned by another session. Ask that session to collect/stop and disconnect first.",
      )
    leases.set(key, owner)
    keys.add(key)
  }
  function clearIdle(): void {
    if (idle) clearTimeout(idle)
    idle = undefined
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(run, run)
    queue = pending.catch(() => undefined)
    return pending
  }
  async function drop(): Promise<void> {
    clearIdle()
    const old = scope
    const stop = needsStop
    needsStop = false
    scope = undefined
    armed = undefined
    try {
      if (stop && old) await old.stop(AbortSignal.timeout(1000)).catch(() => undefined)
      if (old) await old.close().catch(() => undefined)
    } finally {
      for (const key of keys) if (leases.get(key) === owner) leases.delete(key)
      keys.clear()
    }
  }
  function scheduleIdle(): void {
    clearIdle()
    const ms = options.idleCloseMs ?? 90_000
    if (ms <= 0 || !scope || armed || disposed) return
    const current = scope
    idle = setTimeout(() => {
      void serialize(async () => {
        if (scope === current && !armed) await drop()
      })
    }, ms)
    idle.unref()
  }
  async function connect(cwd: string, requested?: string, signal?: AbortSignal): Promise<ScopeDevice> {
    signal?.throwIfAborted()
    let want = requested
      ? parseRegisteredAddress(requested, drivers)
      : (address ?? parseRegisteredAddress((await readScopeConfig(cwd))?.address ?? "usb", drivers))
    if (want.kind === "usb" && !want.serial) {
      const found = await listUsb()
      if (!found.length)
        throw new Error(
          "scope: no USB instrument found. Connect the rear USB Device port, power on the scope, and close EasyScopeX or other applications using it. LAN instruments take address=<ip>:5025.",
        )
      if (found.length > 1)
        throw new Error("scope: multiple USB instruments found; use devices and choose address=usb:<serial>")
      want = { ...want, serial: found[0]!.serial }
    }
    if (
      scope &&
      address &&
      scopeAddressKey(want) === scopeAddressKey(address) &&
      (!want.driver || want.driver === address.driver)
    )
      return scope
    if (armed) throw new Error("scope: cannot switch instruments while armed; stop or collect first")
    await drop()
    try {
      claim(scopeAddressKey(want))
      const device = await open(want, signal)
      scope = device
      signal?.throwIfAborted()
      if (device.identity.serial && device.address.kind !== "none") claim(`usb:${device.identity.serial}`)
      if (device.identity.serial && keys.has("usb")) {
        leases.delete("usb")
        keys.delete("usb")
      }
      address = device.address
      return device
    } catch (error) {
      await drop()
      throw error
    }
  }

  function details(action: ScopeInput["action"], s: ScopeDevice, st: ScopeStatus): ScopeDetails {
    return {
      action,
      address: s.label,
      driver: s.driver,
      ...(s.warnings.length ? { warnings: [...s.warnings] } : {}),
      model: st.idn.model,
      serial: st.idn.serial,
      firmware: st.idn.firmware,
      channels: st.channels,
      timebase: st.timebase,
      trigger: st.trigger,
      sampleRate: st.acquire.sampleRate,
      points: st.acquire.points,
      mdepth: st.acquire.mdepth,
      armed: !!armed,
    }
  }
  function describe(s: ScopeDevice, st: ScopeStatus): string {
    return [
      ...s.warnings.map((w) => `Warning: ${w}`),
      `${st.idn.model} SN ${st.idn.serial} via ${s.driver} driver at ${s.label}; ${si(st.timebase.scale, "s/div")}; ${st.acquire.points} points @ ${si(st.acquire.sampleRate, "Sa/s")}`,
      ...st.channels.map(
        (c) =>
          `C${c.ch} ${c.on ? "ON" : "OFF"} ${c.label ?? ""} ${si(c.vdiv, `${c.unit}/div`)} offset ${si(c.offset, c.unit)} ${c.coupling} probe ${c.probe}× BW ${c.bwlimit}`,
      ),
      `trigger ${st.trigger.type} ${st.trigger.source} ${st.trigger.slope} @ ${si(st.trigger.level, triggerUnit(st.trigger.source, st.channels))}, mode ${st.trigger.mode}, status ${st.trigger.status}`,
    ].join("\n")
  }
  function capabilityLines(
    s: ScopeDevice,
    st: ScopeStatus,
  ): { text: string; capabilities: ScopeDetails["capabilities"] } {
    const cap = s.capabilities(st)
    const text = [
      `capabilities (${cap.enabledChannels} channel(s) on${cap.verified ? "" : "; model not verified on hardware, tables are advisory"}): memory depths ${cap.memoryDepths.length ? cap.memoryDepths.join(" ") : "unknown"}; sample rates up to ${cap.sampleRates.length ? si(Math.max(...cap.sampleRates), "Sa/s") : "unknown"}; couplings ${cap.couplings.join("/")}; probes ${cap.probes.join(" ")}${cap.customProbe ? " (custom factors also accepted)" : ""}; trigger ${cap.triggerTypes.join("/")} from ${cap.triggerSources.join(" ")}; ${cap.measureTypes.length} measurement types (details.capabilities lists them).`,
    ].join("\n")
    return { text, capabilities: cap }
  }
  function triggerUnit(source: string, channels: ScopeStatus["channels"]): string {
    return channels.find((c) => `C${c.ch}` === source.toUpperCase())?.unit ?? "source units"
  }
  async function settings(s: ScopeDevice, p: ScopeInput, signal?: AbortSignal): Promise<string[]> {
    const lines: string[] = []
    if (p.autoset) {
      await s.autoset(signal)
      lines.push("Autoset applied; readback follows.")
    }
    for (const c of p.channels ?? [])
      if (Object.keys(c).length > 1) {
        const r = await s.setChannel(c, signal)
        lines.push(`C${c.ch} configured.`, ...r.mismatches.map((m) => `Mismatch: ${m}`))
      }
    if (p.timebase) {
      const r = await s.setTimebase(p.timebase, signal)
      lines.push("Timebase configured.", ...r.mismatches.map((m) => `Mismatch: ${m}`))
    }
    if (p.mdepth) {
      const r = await s.setMemoryDepth(p.mdepth, signal)
      lines.push("Memory configured.", ...r.mismatches.map((m) => `Mismatch: ${m}`))
    }
    if (p.trigger) {
      const r = await s.setTrigger(p.trigger, signal)
      lines.push("Trigger configured.", ...r.mismatches.map((m) => `Mismatch: ${m}`))
    }
    return lines
  }
  async function restore(
    s: ScopeDevice,
    before: ScopeStatus,
    resume: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (resume === false || /stop/i.test(before.trigger.status) || /sing|ftrig/i.test(before.trigger.mode)) return
    const restored = await s.setTrigger({ mode: /norm/i.test(before.trigger.mode) ? "normal" : "auto" }, signal)
    if (restored.mismatches.length) throw new Error(`scope resume: ${restored.mismatches.join("; ")}`)
    await s.run(signal)
    if (/stop/i.test(await s.triggerStatus(signal)))
      throw new Error("scope resume: instrument remains stopped after RUN")
  }
  async function finish(
    cwd: string,
    s: ScopeDevice,
    p: ScopeInput,
    before: ScopeStatus,
    signal?: AbortSignal,
  ): Promise<Result> {
    let out: Awaited<ReturnType<typeof saveEvidence>> | undefined
    try {
      out = await saveEvidence(cwd, p.action, s, p, signal)
      lastCaptures.set(cwd, out.details.captureId!)
      armed = undefined
    } finally {
      if (!signal?.aborted && (out || p.action === "capture")) {
        try {
          await restore(s, before, p.resume, signal)
        } catch (error) {
          if (out) out.text += `\nWaveform saved, but resume failed: ${String(error).slice(0, 300)}`
          await drop()
        }
      }
    }
    const result = textResult(out.text, out.details)
    if (out.image) result.content.push(out.image)
    // Failed screenshot queries can leave an unread USB response. Start the next action on a clean connection.
    if (out.screenshotFailed) await drop()
    return result
  }
  async function run(p: ScopeInput, cwd: string, signal?: AbortSignal): Promise<Result> {
    const action = p.action
    if (action === "devices") {
      const found = await listUsb()
      const catalog = scopeCatalog(drivers)
      const lines = [
        found.length
          ? `USB instruments:\n${found.map((d) => `  ${d.product ?? "instrument"}: usb:${d.serial ?? "(unknown serial)"}`).join("\n")}`
          : "No USB instrument found. Connect its rear USB Device port and power it on; close other control applications. LAN instruments take address=<ip>:5025.",
        "Drivers and example addresses:",
        ...catalog.map(
          (d) =>
            `  ${d.name}: ${d.description}\n${d.models.map((m) => `    ${m.model} (${m.transports.join("/")}; e.g. ${m.example}; ${m.verified === "hardware" ? "verified on hardware" : m.verified === "fake" ? "fake instrument" : "untested"}${m.note ? `; ${m.note}` : ""})`).join("\n")}`,
        ),
      ]
      return textResult(lines.join("\n"), { action, devices: found, drivers: catalog })
    }
    if (action === "list") {
      const all = await listCaptures(cwd)
      return textResult(
        all.length
          ? all
              .slice(0, 100)
              .map(
                (m) =>
                  `${m.id} ${m.model ?? ""} ${m.quality ?? "legacy"} ${m.channels.map((c) => `C${c.ch}:${c.points}pts`).join(" ")} ${new Date(m.createdAt).toISOString()}`,
              )
              .join("\n")
          : "No captures yet in this project; scope capture or arm/collect first.",
        { action, truncated: all.length > 100 },
      )
    }
    if (action === "samples") {
      const out = await savedSamples(cwd, p, lastCaptures.get(cwd))
      return textResult(out.text, out.details)
    }
    if (action === "disconnect") {
      await drop()
      return textResult("Disconnected; instrument ownership released.", { action, armed: false })
    }
    if (action === "stop") {
      if (scope) {
        needsStop = true
        await scope.stop(signal)
        needsStop = false
      }
      armed = undefined
      return textResult(
        "Stopped; armed capture discarded. Use disconnect to release the instrument to another session.",
        { action, armed: false },
      )
    }
    if (armed && !whileArmed.has(action))
      throw new Error("scope: already armed; collect or stop before changing settings or starting another capture")
    if (armed && armed.cwd !== cwd)
      throw new Error("scope: the armed capture belongs to another project directory; return there or stop first")
    if (action === "collect" && !armed) throw new Error("scope collect: nothing armed; use scope arm first")
    const s = await connect(cwd, p.address, signal)
    if (action === "connect" || action === "status") {
      const st = await s.status(signal)
      if (action === "connect") await writeScopeConfig(cwd, { address: formatScopeAddress(s.address) })
      const cap = capabilityLines(s, st)
      return textResult(`${describe(s, st)}\n${cap.text}`, {
        ...details(action, s, st),
        capabilities: cap.capabilities,
      })
    }
    if (action === "setup") {
      const lines = await settings(s, p, signal)
      if (p.run === "run") {
        await s.run(signal)
        lines.push("Acquisition RUN requested.")
      }
      if (p.run === "stop") {
        await s.stop(signal)
        lines.push("Acquisition STOP requested.")
      }
      if (!lines.length) throw new Error("scope setup: supply channels/timebase/trigger/mdepth/run/autoset")
      const st = await s.status(signal)
      return textResult([...lines, describe(s, st)].join("\n"), details(action, s, st))
    }
    if (action === "arm") {
      acquisitionBudget(p)
      const lines = await settings(s, p, signal)
      const before = await s.status(signal)
      const channels = p.channels?.map((c) => c.ch) ?? before.channels.filter((c) => c.on).map((c) => c.ch)
      if (!channels.length || channels.some((ch) => !before.channels.find((c) => c.ch === ch)?.on))
        throw new Error("scope arm: enable all capture channels before arming")
      needsStop = true
      await s.single(signal)
      const tr = await s.trigger(signal)
      armed = { at: Date.now(), params: p, before, cwd }
      return textResult(
        [
          ...lines,
          `Armed single trigger ${tr.source} ${tr.slope} @ ${si(tr.level, triggerUnit(tr.source, before.channels))} (status ${tr.status}). Now perform the flash/reset/physical action, then scope collect.`,
        ].join("\n"),
        { ...details(action, s, before), armed: true, trigger: tr },
      )
    }
    if (action === "capture") {
      acquisitionBudget(p)
      if (
        p.timebase ||
        p.trigger ||
        p.mdepth ||
        p.autoset ||
        p.run ||
        p.channels?.some((c) => Object.keys(c).length > 1)
      )
        throw new Error("scope capture: apply settings with setup first, or use arm with settings then collect")
      const before = await s.status(signal)
      if (p.mode === "single") {
        needsStop = true
        await s.single(signal)
      } else if (!/stop/i.test(before.trigger.status)) {
        needsStop = true
        await s.stop(signal)
        needsStop = false
      }
      const waited = await s.waitForStop(p.mode === "single" ? (p.timeoutMs ?? 30_000) : 3000, signal)
      if (!waited.ok) {
        needsStop = true
        await s.stop(signal)
        needsStop = false
        await restore(s, before, p.resume, signal)
        return textResult(
          `Capture timed out (status ${waited.status}); no waveform saved and no event absence can be inferred. Check wiring and trigger settings.`,
          { action, timedOut: true, address: s.label },
        )
      }
      needsStop = false
      return finish(cwd, s, { ...p, mode: p.mode ?? "current" }, before, signal)
    }
    if (action === "collect") {
      if (!armed) throw new Error("scope collect: nothing armed; use scope arm first")
      if (
        p.timebase ||
        p.trigger ||
        p.mdepth ||
        p.autoset ||
        p.run ||
        p.channels?.some((c) => Object.keys(c).length > 1)
      )
        throw new Error("scope collect: acquisition settings are frozen; stop and arm again to change settings")
      const a = armed
      const waited = await s.waitForStop(p.timeoutMs ?? 30_000, signal)
      if (!waited.ok)
        return textResult(
          `Still waiting for a trigger after ${Math.round((Date.now() - a.at) / 1000)}s; no waveform saved. Perform the event and collect again, or stop.`,
          { action, armed: true, timedOut: true, address: s.label },
        )
      needsStop = false
      return finish(cwd, s, { ...a.params, ...p, mode: "single" }, a.before, signal)
    }
    if (action === "measure") {
      if (!p.items?.length) throw new Error('scope measure needs items, e.g. [{type:"FREQ",source:"C1"}]')
      const first = await s.measure(p.items, signal)
      const units = new Map<string, string>()
      for (const source of new Set(first.results.map((r) => r.source))) {
        const channel = /^C([1-4])$/i.exec(source)
        if (channel) units.set(source, (await s.channel(Number(channel[1]), signal)).unit)
      }
      const series = first.results.map((r) => [r.value])
      const repeat = Math.min(100, Math.max(1, p.repeat ?? 1))
      for (let i = 1; i < repeat; i++) {
        await delay(p.intervalMs ?? 250, undefined, { signal })
        const values = await s.readMeasurements(first.results.length, signal)
        values.forEach((v, j) => series[j]!.push(v))
      }
      const measurements = first.results.map((r, i) => {
        const valid = series[i]!.filter((v): v is number => v !== null)
        return {
          ...r,
          unit: measurementUnit(r.type, units.get(r.source)),
          value: valid.at(-1) ?? null,
          n: valid.length,
          ...(valid.length
            ? {
                min: Math.min(...valid),
                max: Math.max(...valid),
                mean: valid.reduce((a, b) => a + b, 0) / valid.length,
              }
            : {}),
        }
      })
      return textResult(
        [
          ...s.warnings.map((w) => `Warning: ${w}`),
          ...measurements.map(
            (m) =>
              `${m.type} ${m.source}: ${m.value ?? "unavailable"} ${m.unit}; valid ${m.n}/${repeat}${m.n ? `, min ${m.min}, max ${m.max}, mean ${m.mean} ${m.unit}` : ""}`,
          ),
          ...first.mismatches.map((m) => `Mismatch: ${m}`),
        ].join("\n"),
        {
          action,
          address: s.label,
          driver: s.driver,
          ...(s.warnings.length ? { warnings: [...s.warnings] } : {}),
          measurements,
        },
      )
    }
    if (action === "screenshot") {
      const png = await s.screenshot(signal)
      await ensureScopeDir(cwd)
      const dir = path.join(cwd, SCOPE_DIR, SCOPE_SCREENS_DIR)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${randomUUID()}.png`)
      await writeFile(file, png)
      const content: Result["content"] = [
        {
          type: "text",
          text: `Live instrument screenshot saved: ${file}. This standalone screenshot is not a saved waveform capture.${s.warnings.length ? `\n${s.warnings.map((w) => `Warning: ${w}`).join("\n")}` : ""}`,
        },
      ]
      if (png.byteLength <= 4 * 1024 * 1024)
        content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" })
      return { content, details: { action, file, bytes: png.byteLength, address: s.label, driver: s.driver } }
    }
    throw new Error(`scope: unknown action ${action}`)
  }

  return {
    name: SCOPE_CONTRACT.name,
    label: SCOPE_CONTRACT.label,
    description: SCOPE_CONTRACT.description,
    parameters: SCOPE_CONTRACT.parameters,
    // 装配面(tools/index.ts)会把它包进带预校验的 prepareArguments;直接调 execute 的测试与脚本也在下面归一一次
    prepareArguments: normalizeScopeArguments as (args: unknown) => Static<typeof SCOPE_CONTRACT.parameters>,
    execute: async (_id, raw, _update, toolContext, _invocation, context) => {
      const p = normalizeScopeArguments(raw) as ScopeInput
      const cwd = toolContext.env.cwd
      const external = context.abortSignal
      if (!offline.has(p.action)) clearIdle()
      if (p.action === "stop" || p.action === "disconnect") {
        epoch++
        // Explicit stop also applies when a read-only action is being interrupted before the queued stop runs.
        if (p.action === "stop" && scope) needsStop = true
        active?.abort()
      }
      const submitted = epoch
      const guarded = async () => {
        if (disposed) throw new Error("scope: this session is closing")
        external?.throwIfAborted()
        if (submitted !== epoch) throw new Error("scope: operation superseded by stop/disconnect")
        if (offline.has(p.action)) return run(p, cwd, external)
        const controller = new AbortController()
        active = controller
        const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
        try {
          return await run(p, cwd, signal)
        } catch (error) {
          if (
            signal.aborted ||
            (needsStop && !armed) ||
            /closed|aborted|USB|EPIPE|ECONNRESET|timeout|timed out|not opened|No such device|acquisition (resumed|is no longer stopped)|out of sync/i.test(
              String(error),
            )
          )
            await drop()
          throw error
        } finally {
          active = undefined
          scheduleIdle()
        }
      }
      const result = await (offline.has(p.action) ? guarded() : serialize(guarded))
      return { ...result, details: { ...result.details, directory: cwd } }
    },
    dispose: async () => {
      disposed = true
      epoch++
      clearIdle()
      active?.abort()
      await queue
      await drop()
    },
  }
}
