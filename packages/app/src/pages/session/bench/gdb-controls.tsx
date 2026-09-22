import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { GdbInput, GdbServerKind, GdbDetails, ExecOp } from "@yoma-desktop/kernel/tools/gdb/contract"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { executeInstrument } from "./instrument-state"
import { createInstrumentSession } from "./instrument-session"
import { useBenchToolParts } from "./use-bench-status"
import "./gdb-controls.css"

/** Manual controls use the same session-owned debugger as the agent, without prompting a model. */
export function GdbControls() {
  const language = useLanguage()
  const sync = useSync()
  const { params } = useSessionKey()
  const instrument = createInstrumentSession()
  const evidence = useBenchToolParts()
  const t = (key: string) => language.t(`session.gdbControl.${key}` as Parameters<typeof language.t>[0])
  const [state, setState] = createStore({
    server: "external" as GdbServerKind,
    endpoint: "localhost:3333",
    elf: "",
    config: "",
    chip: "",
    machine: "",
    gdbPath: "",
    allowUnverified: false,
    breakpoint: "",
    expression: "",
    pending: false,
    error: "",
    statusError: "",
    output: "",
    live: undefined as GdbDetails | undefined,
  })
  let generation = 0
  let disposed = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const agentBusy = () => {
    const status = sync().data.session_status[params.id ?? ""]
    return !!status && status.type !== "idle"
  }
  const connected = () => !!state.live && state.live.state !== "no-session"
  const halted = () => state.live?.state === "halted"
  const running = () => state.live?.state === "running"
  const disabled = () => state.pending || agentBusy()
  const canConnect = createMemo(
    () =>
      !!state.elf.trim() &&
      !!(state.server === "external"
        ? state.endpoint.trim()
        : state.server === "openocd"
          ? state.config.trim()
          : state.server === "jlink"
            ? state.chip.trim()
            : state.machine.trim()),
  )
  const readDetails = (details: Record<string, unknown> | undefined) => {
    if (details && typeof details.state === "string") setState("live", reconcile(details as unknown as GdbDetails))
  }
  const refresh = async () => {
    clearTimeout(timer)
    const id = params.id
    if (!id || disposed || polling) return
    if (disabled()) {
      timer = setTimeout(() => void refresh(), 2000)
      return
    }
    const mine = generation
    polling = true
    try {
      const result = await executeInstrument({ sessionID: id, tool: "gdb", input: { action: "status" } })
      if (disposed || generation !== mine) return
      const changed = state.live?.stopId !== result.details?.stopId || state.live?.epoch !== result.details?.epoch ||
        state.live?.state !== result.details?.state || state.live?.connection !== result.details?.connection
      readDetails(result.details)
      setState("statusError", "")
      if (changed && connected()) setState("output", result.text)
    } catch (error) {
      if (!disposed && generation === mine) setState("statusError", error instanceof Error ? error.message : String(error))
    } finally {
      polling = false
      if (!disposed && (generation !== mine || connected())) timer = setTimeout(() => void refresh(), 2500)
    }
  }
  createEffect(
    on(
      () => params.id,
      () => {
        generation++
        setState({ live: undefined, output: "", error: "", statusError: "", pending: false })
        void refresh()
      },
    ),
  )
  createEffect(
    on(
      () =>
        [
          evidence()
            .filter((part) => part.tool === "gdb")
            .map((part) => part.state.status)
            .join("|"),
          agentBusy(),
        ] as const,
      () => void refresh(),
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    generation++
    clearTimeout(timer)
  })

  const run = async (input: GdbInput) => {
    if (disabled()) return
    const mine = generation
    setState({ pending: true, error: "" })
    try {
      const result = await instrument.run("gdb", input)
      if (disposed || generation !== mine) return
      readDetails(result.details)
      setState("output", result.text)
    } catch (error) {
      if (!disposed && generation === mine) setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (!disposed && generation === mine) {
        setState("pending", false)
        timer = setTimeout(() => void refresh(), 100)
      }
    }
  }
  const connect = (event: SubmitEvent) => {
    event.preventDefault()
    if (!canConnect()) return
    void run({
      action: "start",
      server: state.server,
      elfPath: state.elf.trim(),
      ...(state.server === "external" ? { connect: state.endpoint.trim() } : {}),
      ...(state.server === "openocd"
        ? {
            config: state.config
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      ...(state.server === "jlink" ? { chip: state.chip.trim() } : {}),
      ...(state.server === "qemu" ? { machine: state.machine.trim() } : {}),
      ...(state.gdbPath.trim() ? { gdbPath: state.gdbPath.trim() } : {}),
      allowUnverified: state.allowUnverified,
    })
  }
  const exec = (op: ExecOp) =>
    void run({ action: "exec", op, waitMs: 100, onTimeout: "leave-running", expectRunning: op === "continue" })

  return (
    <section data-component="gdb-controls" aria-label={t("title")}>
      <div data-slot="status">
        <span data-component="bench-led" data-state={running() ? "active" : halted() ? "idle" : "offline"} />
        <strong>{state.pending ? t("working") : t(state.live?.state ?? "no-session")}</strong>
        <span data-slot="connection">{state.live?.connection}</span>
        <Show when={agentBusy()}>
          <span>{t("agentBusy")}</span>
        </Show>
      </div>
      <Show when={!connected() || state.live?.state === "connection-lost" || state.live?.state === "exited"}>
        <form onSubmit={connect} data-slot="connect">
          <label>
            {t("server")}
            <select
              value={state.server}
              disabled={disabled()}
              onChange={(e) => setState("server", e.currentTarget.value as GdbServerKind)}
            >
              <option value="external">{t("external")}</option>
              <option value="openocd">OpenOCD</option>
              <option value="jlink">J-Link</option>
              <option value="qemu">QEMU</option>
            </select>
          </label>
          <label data-slot="elf">
            ELF
            <input
              required
              placeholder="build/firmware.elf"
              value={state.elf}
              disabled={disabled()}
              onInput={(e) => setState("elf", e.currentTarget.value)}
            />
          </label>
          <Show when={state.server === "external"}>
            <label>
              {t("endpoint")}
              <input
                required
                value={state.endpoint}
                disabled={disabled()}
                onInput={(e) => setState("endpoint", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "openocd"}>
            <label data-slot="config">
              {t("config")}
              <input
                required
                placeholder="interface/stlink.cfg, target/stm32f4x.cfg"
                value={state.config}
                disabled={disabled()}
                onInput={(e) => setState("config", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "jlink"}>
            <label>
              {t("chip")}
              <input
                required
                placeholder="STM32G431CB"
                value={state.chip}
                disabled={disabled()}
                onInput={(e) => setState("chip", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "qemu"}>
            <label>
              {t("machine")}
              <input
                required
                placeholder="netduinoplus2"
                value={state.machine}
                disabled={disabled()}
                onInput={(e) => setState("machine", e.currentTarget.value)}
              />
            </label>
          </Show>
          <button type="submit" data-primary disabled={disabled() || !canConnect()}>
            {t("connect")}
          </button>
          <details data-slot="advanced">
            <summary>{t("advanced")}</summary>
            <label>
              GDB
              <input
                placeholder="arm-none-eabi-gdb"
                value={state.gdbPath}
                onInput={(e) => setState("gdbPath", e.currentTarget.value)}
              />
            </label>
            <label data-slot="check">
              <input
                type="checkbox"
                checked={state.allowUnverified}
                onChange={(e) => setState("allowUnverified", e.currentTarget.checked)}
              />
              {t("unverified")}
            </label>
          </details>
        </form>
      </Show>
      <Show when={connected()}>
        <div data-slot="run-controls">
          <button type="button" disabled={disabled() || !halted()} onClick={() => exec("continue")}>
            ▶ {t("continue")}
          </button>
          <button type="button" disabled={disabled() || !running()} onClick={() => exec("interrupt")}>
            Ⅱ {t("pause")}
          </button>
          <button type="button" disabled={disabled() || !halted()} onClick={() => exec("next")}>
            {t("next")}
          </button>
          <button type="button" disabled={disabled() || !halted()} onClick={() => exec("step")}>
            {t("step")}
          </button>
          <button type="button" disabled={disabled() || !halted()} onClick={() => exec("finish")}>
            {t("finish")}
          </button>
          <button type="button" disabled={disabled()} onClick={() => void run({ action: "status" })}>
            {t("refresh")}
          </button>
          <button type="button" disabled={disabled()} onClick={() => void run({ action: "stop" })}>
            {t("disconnect")}
          </button>
        </div>
        <div data-slot="commands">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (state.breakpoint.trim()) void run({ action: "break", at: state.breakpoint.trim() })
            }}
          >
            <input
              aria-label={t("breakpoint")}
              placeholder="main / file.c:42"
              value={state.breakpoint}
              onInput={(e) => setState("breakpoint", e.currentTarget.value)}
            />
            <button type="submit" disabled={disabled() || !halted() || !state.breakpoint.trim()}>
              {t("breakpoint")}
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (state.expression.trim()) void run({ action: "eval", command: state.expression.trim() })
            }}
          >
            <input
              aria-label={t("evaluate")}
              placeholder="p counter / info registers"
              value={state.expression}
              onInput={(e) => setState("expression", e.currentTarget.value)}
            />
            <button type="submit" disabled={disabled() || !halted() || !state.expression.trim()}>
              {t("evaluate")}
            </button>
          </form>
        </div>
      </Show>
      <Show when={state.error || state.statusError}>
        <div role="alert" data-slot="error">
          {state.error || state.statusError}
        </div>
      </Show>
      <Show when={state.output}>
        <pre data-slot="output" aria-label={t("output")}>
          {state.output}
        </pre>
      </Show>
    </section>
  )
}
