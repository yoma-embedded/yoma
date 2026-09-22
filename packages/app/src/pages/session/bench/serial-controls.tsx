import { createEffect, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { SerialPortView } from "@yoma-desktop/kernel"
import { DEFAULT_BAUD, type LogInput } from "@yoma-desktop/kernel/tools/log/contract"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { executeInstrument } from "./instrument-state"
import { createInstrumentSession } from "./instrument-session"
import { serialCopy } from "./serial-copy"
import "./serial-controls.css"

const BAUDS = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600, 1000000, 2000000,
]
const PREFS = "yoma.serial.preferences.v1"
type Encoding = "text" | "hex"
type Ending = "none" | "lf" | "cr" | "crlf"

/** Editable value plus an explicit native preset picker: custom ports/rates never disappear on blur. */
function SerialChoice(props: {
  label: string
  pickerLabel: string
  value: string
  placeholder?: string
  disabled: boolean
  numeric?: boolean
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const id = createUniqueId()
  return (
    <>
      <label for={id}>{props.label}</label>
      <div data-component="serial-choice">
        <input
          id={id}
          aria-label={props.label}
          value={props.value}
          placeholder={props.placeholder}
          inputmode={props.numeric ? "numeric" : "text"}
          disabled={props.disabled}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
        <select
          aria-label={props.pickerLabel}
          title={props.pickerLabel}
          value=""
          disabled={props.disabled || !props.options.length}
          onChange={(event) => {
            const value = event.currentTarget.value
            event.currentTarget.value = ""
            if (value) props.onChange(value)
          }}
        >
          {/* 空白项必须能被选中。禁用的占位项在 macOS 上会被跳过，选择框就会画出第一档（波特率变成 300）。 */}
          <option value="" hidden />
          <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
        </select>
      </div>
    </>
  )
}

export function SerialControls(props: { onChange?: () => void; children?: JSX.Element }) {
  const language = useLanguage()
  const sdk = useSDK()
  const copy = () => serialCopy[language.locale()]
  const instrument = createInstrumentSession()
  const [state, setState] = createStore({
    ports: [] as SerialPortView[],
    port: "",
    baud: String(DEFAULT_BAUD),
    ending: "none" as Ending,
    encoding: "text" as Encoding,
    data: "",
    history: [] as string[],
    historyIndex: -1,
    draft: "",
    source: "",
    running: false,
    writable: false,
    totalLines: 0,
    loadingPorts: false,
    pending: false,
    sending: false,
    error: "",
    statusError: "",
    sendError: "",
    sent: "",
    checked: false,
  })
  let disposed = false
  let querying = false
  let revision = 0
  let input: HTMLInputElement | undefined
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const save = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS) ?? "{}")
      const entries = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
      const next = Object.fromEntries(
        Object.entries(entries)
          .filter(([key]) => key !== sdk().directory)
          .slice(-15),
      )
      next[sdk().directory] = { port: state.port, baud: state.baud, ending: state.ending, encoding: state.encoding }
      localStorage.setItem(PREFS, JSON.stringify(next))
    } catch {
      /* Preferences must never prevent device use. */
    }
  }
  createEffect(
    on(
      () => sdk().directory,
      (directory) => {
        let prefs: Record<string, unknown> = {}
        try {
          prefs = JSON.parse(localStorage.getItem(PREFS) ?? "{}")[directory] ?? {}
        } catch {}
        setState({
          port: typeof prefs.port === "string" ? prefs.port : "",
          baud: typeof prefs.baud === "string" ? prefs.baud : String(DEFAULT_BAUD),
          ending: ["none", "lf", "cr", "crlf"].includes(String(prefs.ending)) ? (prefs.ending as Ending) : "none",
          encoding: prefs.encoding === "hex" ? "hex" : "text",
          data: "",
          history: [],
          historyIndex: -1,
        })
      },
    ),
  )
  const refreshPorts = async () => {
    if (state.loadingPorts) return
    setState({ loadingPorts: true, error: "" })
    try {
      const ports = await kernel.instrument.ports()
      if (!disposed) setState({ ports, port: state.port || ports[0]?.path || "" })
    } catch (error) {
      if (!disposed) setState("error", message(error))
    } finally {
      if (!disposed) setState("loadingPorts", false)
    }
  }
  const apply = (details: Record<string, unknown> | undefined) => {
    if (!details || disposed) return
    const serial = details.serial as { port?: unknown; baud?: unknown } | undefined
    setState({
      running: details.running === true,
      writable: details.writable === true,
      source: typeof details.source === "string" ? details.source : "",
      totalLines: typeof details.totalLines === "number" ? details.totalLines : 0,
      checked: true,
      statusError: "",
      ...(details.running && typeof serial?.port === "string" ? { port: serial.port } : {}),
      ...(details.running && typeof serial?.baud === "number" ? { baud: String(serial.baud) } : {}),
    })
  }
  const status = async () => {
    const sessionID = instrument.id()
    if (!sessionID || querying || state.pending || state.sending || !kernelAvailable()) return
    querying = true
    const request = revision
    try {
      const result = await executeInstrument({ sessionID, tool: "log", input: { action: "status" } })
      if (request === revision && sessionID === instrument.id()) apply(result.details)
    } catch (error) {
      if (!disposed && request === revision) setState("statusError", message(error))
    } finally {
      querying = false
    }
  }
  const connect = async () => {
    if (state.pending) return
    const baud = Number(state.baud)
    if (!state.running && (!state.port.trim() || !Number.isInteger(baud) || baud < 50 || baud > 12000000)) {
      setState("error", copy().invalid)
      return
    }
    const request = ++revision
    save()
    setState({ pending: true, sending: false, error: "", sent: "", sendError: "" })
    try {
      const result = await instrument.run(
        "log",
        state.running ? { action: "stop" } : { action: "start", port: state.port.trim(), baud },
      )
      if (request === revision) {
        apply(result.details)
        props.onChange?.()
      }
    } catch (error) {
      if (!disposed && request === revision) setState("error", message(error))
    } finally {
      if (!disposed && request === revision) {
        setState("pending", false)
        void status()
      }
    }
  }
  const canSend = () => state.running && state.writable && !state.pending && !state.sending
  const send = async (control?: string) => {
    if (!canSend()) return
    const sessionID = instrument.id()
    if (!sessionID) return
    const data = control ?? state.data
    const encoding = control ? "hex" : state.encoding
    const lineEnding = control ? "none" : state.ending
    const hex = data.replace(/\s/g, "")
    if (encoding === "hex" && !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
      setState("sendError", copy().invalidHex)
      return
    }
    const count =
      (encoding === "hex" ? hex.length / 2 : new TextEncoder().encode(data).length) +
      { none: 0, lf: 1, cr: 1, crlf: 2 }[lineEnding]
    if (!count || count > 4096) {
      setState("sendError", copy().invalidSize)
      return
    }
    const request = ++revision
    setState({ sending: true, sendError: "", sent: "" })
    try {
      const result = await executeInstrument({
        sessionID,
        tool: "log",
        input: { action: "write", data, encoding, lineEnding } satisfies LogInput,
      })
      if (disposed || request !== revision || sessionID !== instrument.id()) return
      apply(result.details)
      setState("sent", `${copy().sent} ${result.details?.bytesSent ?? count} B${control ? " · Ctrl+C" : ""}`)
      if (!control) {
        setState({
          history: [...state.history.filter((entry) => entry !== data), data].slice(-50),
          historyIndex: -1,
          data: "",
        })
      }
      input?.focus()
      props.onChange?.()
    } catch (error) {
      if (!disposed && request === revision) setState("sendError", message(error))
    } finally {
      if (!disposed && request === revision) {
        setState("sending", false)
        void status()
      }
    }
  }
  const recall = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      state.encoding !== "text" ||
      !["ArrowUp", "ArrowDown"].includes(event.key) ||
      !state.history.length
    )
      return
    event.preventDefault()
    if (state.historyIndex < 0) setState("draft", state.data)
    const current = state.historyIndex < 0 ? state.history.length : state.historyIndex
    const next = Math.max(0, Math.min(state.history.length, current + (event.key === "ArrowUp" ? -1 : 1)))
    setState({ historyIndex: next, data: next === state.history.length ? state.draft : state.history[next] })
  }
  createEffect(
    on(
      () => instrument.id(),
      () => {
        revision++
        setState({
          running: false,
          writable: false,
          source: "",
          totalLines: 0,
          pending: false,
          sending: false,
          error: "",
          statusError: "",
          sendError: "",
          sent: "",
          checked: false,
          data: "",
          history: [],
          historyIndex: -1,
        })
        void status()
      },
    ),
  )
  onMount(() => {
    if (kernelAvailable()) void refreshPorts()
    const timer = setInterval(() => {
      void status()
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => {
    disposed = true
    revision++
  })

  return (
    <div data-component="serial-controls">
      <div data-slot="monitor-header">
        <form
          data-slot="connection"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <div data-slot="port-field">
            <SerialChoice
              label={copy().port}
              pickerLabel={copy().portPresets}
              value={state.port}
              placeholder={state.ports.length ? copy().selectPort : copy().noPorts}
              disabled={state.running || state.pending}
              options={state.ports.map((port) => ({
                value: port.path,
                label: port.description ? `${port.path} — ${port.description}` : port.path,
              }))}
              onChange={(value) => {
                setState("port", value)
                save()
              }}
            />
            <button
              type="button"
              data-slot="scan"
              disabled={state.loadingPorts || state.pending}
              aria-label={copy().scan}
              title={copy().scan}
              onClick={() => void refreshPorts()}
            >
              ↻
            </button>
          </div>
          <div data-slot="baud-field">
            <SerialChoice
              label={copy().baud}
              pickerLabel={copy().baudPresets}
              value={state.baud}
              numeric
              disabled={state.running || state.pending}
              options={BAUDS.map((baud) => ({ value: String(baud), label: String(baud) }))}
              onChange={(value) => {
                setState("baud", value)
                save()
              }}
            />
          </div>
          <label data-slot="ending-field">
            {copy().lineEnding}
            <select
              aria-label={copy().lineEnding}
              value={state.ending}
              onChange={(event) => {
                setState("ending", event.currentTarget.value as Ending)
                save()
              }}
            >
              <option value="none">None</option>
              <option value="lf">LF (\n)</option>
              <option value="cr">CR (\r)</option>
              <option value="crlf">CRLF (\r\n)</option>
            </select>
          </label>
          <span data-slot="format" title={copy().format}>
            8N1
          </span>
          <button
            type="submit"
            data-slot="connect"
            data-running={state.running}
            disabled={state.pending || (!state.running && !state.port.trim())}
          >
            {state.pending ? copy().working : state.running ? copy().disconnect : copy().connect}
          </button>
        </form>
        <div data-slot="connection-status" role="status">
          <span data-slot="state" data-running={state.running}>
            <i />
            {state.running ? copy().connected : copy().disconnected}
          </span>
          <span data-slot="source" title={state.source}>
            {state.source || copy().readyHint}
          </span>
          <Show when={state.checked && state.source}>
            <span data-slot="count">
              RX {state.totalLines.toLocaleString()} {copy().lines}
            </span>
          </Show>
          <Show when={state.sent}>
            <span data-slot="sent">TX {state.sent}</span>
          </Show>
        </div>
        <Show when={state.error || state.statusError}>
          <div data-slot="connection-error" role="alert">
            {state.error || state.statusError}
          </div>
        </Show>
      </div>
      <div data-slot="monitor-output">{props.children}</div>
      <div data-slot="send-bar">
        <form
          data-slot="send-form"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <span data-slot="tx-label">TX</span>
          <input
            ref={(element) => (input = element)}
            data-slot="send-input"
            aria-label={copy().sendPlaceholder}
            value={state.data}
            disabled={state.sending}
            placeholder={state.encoding === "hex" ? "01 A0 FF 0D 0A" : copy().sendPlaceholder}
            maxLength={12288}
            autocomplete="off"
            spellcheck={false}
            onInput={(event) =>
              setState({ data: event.currentTarget.value, historyIndex: -1, sendError: "", sent: "" })
            }
            onKeyDown={recall}
          />
          <select
            aria-label={copy().sendMode}
            value={state.encoding}
            disabled={state.sending}
            onChange={(event) => {
              setState("encoding", event.currentTarget.value as Encoding)
              setState("sendError", "")
              save()
            }}
          >
            <option value="text">{copy().text}</option>
            <option value="hex">Hex</option>
          </select>
          <button
            type="submit"
            data-slot="send"
            disabled={!canSend() || (!state.data && state.ending === "none")}
            title={copy().enterSend}
          >
            {state.sending ? copy().sending : copy().send}
          </button>
        </form>
        <button
          type="button"
          data-slot="ctrl-c"
          disabled={!canSend()}
          onClick={() => void send("03")}
          title={copy().ctrlHint}
        >
          Ctrl+C
        </button>
      </div>
      <Show when={state.sendError}>
        <div data-slot="send-error" role="alert">
          {state.sendError}
        </div>
      </Show>
      <Show when={state.running && !state.writable}>
        <div data-slot="send-notice">{copy().readOnlySource}</div>
      </Show>
    </div>
  )
}
