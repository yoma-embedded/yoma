import { createEffect, createUniqueId, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { SerialPortView } from "@yoma-desktop/kernel"
import type { LogInput } from "@yoma-desktop/kernel/tools/log/contract"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { executeInstrument } from "./instrument-state"
import { createInstrumentSession } from "./instrument-session"
import {
  checkRttDevice,
  DEFAULT_MONITOR_PREFS,
  MONITOR_PREFS_KEY,
  parseMonitorPrefs,
  parseRttSpeed,
  rttDevicePrefill,
  storeMonitorPrefs,
  type LineEnding,
  type LogSourceMode,
  type SendEncoding,
} from "./log-source"
import { serialCopy } from "./serial-copy"
import "./serial-controls.css"

const BAUDS = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 921600, 1000000, 2000000,
]
/** SWD 时钟(kHz)的常用档。J-Link 自己的缺省是 4000;长线 / 飞线往下调。 */
const SWD_SPEEDS = [100, 500, 1000, 2000, 4000, 8000, 12000, 20000, 50000]

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
      {/* 字面标签只留给读屏:一行工具条里"端口 / 波特率"四个字换来的是日志区少一截宽度,
          而框里的占位字与数值本身已经说得出它是什么(鼠标停一下有 title)。 */}
      <label for={id} data-slot="sr-only">
        {props.label}
      </label>
      <div data-component="serial-choice" title={props.label}>
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

/**
 * 日志监视器:连接行 + 日志区(children)+ 发送行。来源是串口,或者经 J-Link 的 RTT。
 *
 * **非日志的部分压到最少**(2026-09-23,用户:"本来要看日志的,其余部分倒占了很大一部分")。
 * 从前是四层:控制台自己的页签行 → 端口 / 波特率 / 换行符 / 8N1 / 连接一行 → 一行状态字 →
 * 一个虚线大空框,最底下还有一条永远在的发送行。现在:
 * - **一行工具条**:灯 · 来源(串口 / RTT)· 端口 · 波特率(RTT 时是器件名 · SWD 速率)· 连接 · 状态读数,
 *   右边接容器给的 `toolbar`(底部控制台把过滤 / 跟随 / 最大化 / 关闭放进来,它自己就不再有页签行)。
 * - **换行符挪进发送行**:它只管发出去的那一串,和连接没关系。8N1 是固定的,进了波特率框的 title。
 * - **发送行只在"连着一个能写的源"时出现**(串口,或 RTT 的下行通道 0):没连、或者连的是 agent 起的
 *   命令 / TCP 采集(只收不发)时,那一行全是灰的按钮,只占地方。
 * - 状态字(来源、RX 行数、刚发出去多少字节)并进工具条里的一段读数,挤不下打省略号,title 给全文。
 *
 * **RTT**(2026-09-24):内核的 log 工具自己起一个只管 RTT 的 J-Link GDB server(不停核、不复位、不烧录)。
 * 器件名的预填见 `log-source.ts` 的 `rttDevicePrefill`:存过的 > 烧录认出来的目标(`chip`)> 工程档案。
 * agent 自己用 log 工具起的 RTT 采集也会反映到这一行上(`apply` 按 details.rtt 把来源切过去)。
 * 起 RTT 要等 J-Link server 就绪(几秒到十几秒),这段时间连接按钮是「取消」。
 *
 * **实时**:采集在跑时把会话 id 经 `onLive` 交给容器(日志面板据此改成按 200 ms 拉内核的实时尾巴,
 * 见 `log-feed.ts`);停了、换会话、卸载时交回 `undefined`。
 */
export function SerialControls(props: {
  onChange?: () => void
  children?: JSX.Element
  /** 工具条右端,由容器决定放什么(过滤框、跟随、容器自己的最大化 / 关闭)。 */
  toolbar?: JSX.Element
  /** 没连着时读数那一段说什么(比如"已停止 sh tools/uart-sim.sh""磁盘上的上一次采集")。 */
  note?: string
  /** 这次会话里烧录 / gdb 认出来的目标芯片(给 RTT 器件名预填;说不准是哪一颗时只当占位提示)。 */
  chip?: string
  /** 有一个在跑的采集时给它的会话 id,没有时给 undefined。 */
  onLive?: (sessionID: string | undefined) => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const copy = () => serialCopy[language.locale()]
  const instrument = createInstrumentSession()
  const deviceID = createUniqueId()
  const [state, setState] = createStore({
    mode: DEFAULT_MONITOR_PREFS.mode as LogSourceMode,
    ports: [] as SerialPortView[],
    port: "",
    baud: DEFAULT_MONITOR_PREFS.baud,
    device: "",
    speed: DEFAULT_MONITOR_PREFS.speed,
    /** 用户动过器件名框(包括清空):之后不再自动预填,免得和人抢。 */
    deviceEdited: false,
    /** 说不准是哪一颗的候选(`STM32G473R(B-C-E)Tx`),只进占位字。 */
    deviceHint: "",
    /** 工程档案里的芯片(`project.context`),切到 RTT 且器件名空着时才去问一次。 */
    projectChip: "",
    ending: "none" as LineEnding,
    encoding: "text" as SendEncoding,
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
    /** pending 的是一次 start(RTT 可能要等十几秒):这时连接按钮是「取消」。 */
    starting: false,
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
  /** 哪个工程已经问过 `project.context` 了。 */
  let askedProject: string | undefined
  let input: HTMLInputElement | undefined
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const locked = () => state.running || state.pending
  const save = () => {
    try {
      localStorage.setItem(
        MONITOR_PREFS_KEY,
        storeMonitorPrefs(localStorage.getItem(MONITOR_PREFS_KEY), sdk().directory, {
          mode: state.mode,
          port: state.port,
          baud: state.baud,
          ending: state.ending,
          encoding: state.encoding,
          device: state.device,
          speed: state.speed,
        }),
      )
    } catch {
      /* Preferences must never prevent device use. */
    }
  }
  createEffect(
    on(
      () => sdk().directory,
      (directory) => {
        let prefs = DEFAULT_MONITOR_PREFS
        try {
          prefs = parseMonitorPrefs(localStorage.getItem(MONITOR_PREFS_KEY), directory)
        } catch {}
        setState({
          mode: prefs.mode,
          port: prefs.port,
          baud: prefs.baud,
          device: prefs.device,
          speed: prefs.speed,
          deviceEdited: false,
          deviceHint: "",
          projectChip: "",
          ending: prefs.ending,
          encoding: prefs.encoding,
          data: "",
          history: [],
          historyIndex: -1,
        })
      },
    ),
  )
  // RTT 器件名预填:器件名空着、用户没动过时,按"烧录认出来的 > 工程档案"填一个确切型号;
  // 说不准是哪一颗的只进占位字。有值(存过的、agent 那边带回来的)时 prefill 原样返回,这里什么都不改。
  createEffect(() => {
    if (state.mode !== "rtt" || state.deviceEdited) return
    const pick = rttDevicePrefill({ saved: state.device, target: props.chip, project: state.projectChip })
    setState({ device: pick.device, deviceHint: pick.hint ?? "" })
  })
  // 工程档案只在真用得上时问(切到 RTT、器件名空着),一个工程问一次。它会读 .ioc 这类描述文件,不便宜也不贵。
  createEffect(
    on(
      () => [state.mode, sdk().directory] as const,
      ([mode, directory]) => {
        if (mode !== "rtt" || askedProject === directory || untrack(() => state.device) || !kernelAvailable()) return
        askedProject = directory
        void (async () => {
          try {
            const view = await kernel.call("project.context", { directory })
            if (!disposed && directory === sdk().directory) setState("projectChip", view.profile?.chip ?? "")
          } catch {
            /* 问不到就没有预填,用户照样能自己填。 */
          }
        })()
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
    const rtt = details.rtt as { device?: unknown; speed?: unknown } | undefined
    setState({
      running: details.running === true,
      writable: details.writable === true,
      source: typeof details.source === "string" ? details.source : "",
      totalLines: typeof details.totalLines === "number" ? details.totalLines : 0,
      checked: true,
      statusError: "",
      ...(details.running && typeof serial?.port === "string" ? { mode: "serial" as const, port: serial.port } : {}),
      ...(details.running && typeof serial?.baud === "number" ? { baud: String(serial.baud) } : {}),
      // agent 起的 RTT 采集也要看得出来:来源切过去,器件名与速率照内核说的填(框在连着时是锁着的)。
      ...(details.running && typeof rtt?.device === "string" ? { mode: "rtt" as const, device: rtt.device } : {}),
      ...(details.running && typeof rtt?.speed === "number" ? { speed: String(rtt.speed) } : {}),
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
  /** 这一次 start / stop 的参数;本地校验不过时写好错误、返回 undefined。 */
  const operation = (): LogInput | undefined => {
    if (state.running) return { action: "stop" }
    if (state.mode === "rtt") {
      const device = checkRttDevice(state.device)
      if ("error" in device) {
        setState(
          "error",
          device.error === "empty" ? copy().invalidDevice : copy().familyDevice.replace("{chip}", state.device.trim()),
        )
        return undefined
      }
      const speed = parseRttSpeed(state.speed)
      if (speed === undefined) {
        setState("error", copy().invalidSpeed)
        return undefined
      }
      return { action: "start", rtt: device.device, rttSpeed: speed }
    }
    const baud = Number(state.baud)
    if (!state.port.trim() || !Number.isInteger(baud) || baud < 50 || baud > 12000000) {
      setState("error", copy().invalid)
      return undefined
    }
    return { action: "start", port: state.port.trim(), baud }
  }
  const connect = async () => {
    if (state.pending) {
      if (state.starting) void cancel()
      return
    }
    const input = operation()
    if (!input) return
    const request = ++revision
    save()
    setState({ pending: true, starting: input.action === "start", sending: false, error: "", sent: "", sendError: "" })
    try {
      const result = await instrument.run("log", input)
      if (request === revision) {
        apply(result.details)
        props.onChange?.()
      }
    } catch (error) {
      if (!disposed && request === revision) setState("error", message(error))
    } finally {
      if (!disposed && request === revision) {
        setState({ pending: false, starting: false })
        void status()
      }
    }
  }
  /**
   * 起到一半的 start 不要了(RTT 在等 J-Link server,可能要十几秒)。内核的 stop 会连同起到一半的采集
   * 与 server 一起收掉,那次 start 会以"被停了"失败 —— 它的结果按 revision 作废,不上错误条。
   */
  const cancel = async () => {
    const request = ++revision
    setState({ starting: false, error: "" })
    try {
      const result = await instrument.run("log", { action: "stop" })
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
  const setMode = (mode: LogSourceMode) => {
    if (locked() || mode === state.mode) return
    setState({ mode, error: "" })
    save()
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
          starting: false,
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
  // 实时尾巴的开关:有在跑的采集就把它的会话交出去。换会话时上面那条先把 running 清掉,这里跟着交回 undefined。
  createEffect(
    on(
      () => (state.running ? instrument.id() : undefined),
      (sessionID) => props.onLive?.(sessionID),
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
    props.onLive?.(undefined)
  })

  /** 工具条上那一段读数:连着时是来源 + 收发计数,没连着时是容器给的那句话(或上一次的来源)。 */
  const readout = () => {
    if (state.pending && state.starting) return copy().connecting
    if (state.running) {
      return [
        state.source || copy().connected,
        state.checked && state.source ? `RX ${state.totalLines.toLocaleString()} ${copy().lines}` : "",
        state.sent ? `TX ${state.sent}` : "",
        state.writable ? "" : copy().readOnly,
      ]
        .filter(Boolean)
        .join(" · ")
    }
    return props.note || (state.source ? `${copy().disconnected} · ${state.source}` : "")
  }
  const readoutTitle = () =>
    [readout(), state.running && !state.writable ? copy().readOnlySource : ""].filter(Boolean).join("\n")
  /** 连接按钮能不能按:起到一半时它是「取消」;没连着时要先填好这一种来源必需的那一格。 */
  const connectDisabled = () =>
    state.pending ? !state.starting : !state.running && !(state.mode === "rtt" ? state.device : state.port).trim()
  const devicePlaceholder = () =>
    state.deviceHint ? copy().deviceFamily.replace("{chip}", state.deviceHint) : copy().devicePlaceholder

  return (
    <div data-component="serial-controls" data-mode={state.mode}>
      <div data-slot="toolbar">
        <form
          data-slot="connection"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <span
            data-slot="state"
            data-running={state.running}
            role="status"
            aria-label={state.running ? copy().connected : copy().disconnected}
            title={state.running ? copy().connected : copy().disconnected}
          >
            <i />
          </span>
          {/* 来源开关。连着时锁住:换来源要先断开(同一时刻一个会话只有一个采集)。 */}
          <div data-slot="source-switch" role="group" aria-label={copy().source}>
            <button
              type="button"
              data-source="serial"
              aria-pressed={state.mode === "serial" ? "true" : "false"}
              disabled={locked()}
              title={copy().serialTitle}
              onClick={() => setMode("serial")}
            >
              {copy().serial}
            </button>
            <button
              type="button"
              data-source="rtt"
              aria-pressed={state.mode === "rtt" ? "true" : "false"}
              disabled={locked()}
              title={copy().rttTitle}
              onClick={() => setMode("rtt")}
            >
              {copy().rtt}
            </button>
          </div>
          <Show
            when={state.mode === "rtt"}
            fallback={
              <>
                <div data-slot="port-field">
                  <SerialChoice
                    label={copy().port}
                    pickerLabel={copy().portPresets}
                    value={state.port}
                    placeholder={state.ports.length ? copy().selectPort : copy().noPorts}
                    disabled={locked()}
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
                    label={`${copy().baud} · 8N1`}
                    pickerLabel={copy().baudPresets}
                    value={state.baud}
                    numeric
                    disabled={locked()}
                    options={BAUDS.map((baud) => ({ value: String(baud), label: String(baud) }))}
                    onChange={(value) => {
                      setState("baud", value)
                      save()
                    }}
                  />
                </div>
              </>
            }
          >
            <div data-slot="device-field" title={copy().deviceTitle}>
              <label for={deviceID} data-slot="sr-only">
                {copy().device}
              </label>
              <input
                id={deviceID}
                aria-label={copy().device}
                value={state.device}
                placeholder={devicePlaceholder()}
                autocomplete="off"
                spellcheck={false}
                disabled={locked()}
                onInput={(event) => {
                  setState({ device: event.currentTarget.value, deviceEdited: true, error: "" })
                  save()
                }}
              />
            </div>
            <div data-slot="speed-field">
              <SerialChoice
                label={copy().speed}
                pickerLabel={copy().speedPresets}
                value={state.speed}
                numeric
                disabled={locked()}
                options={SWD_SPEEDS.map((speed) => ({ value: String(speed), label: `${speed} kHz` }))}
                onChange={(value) => {
                  setState("speed", value)
                  save()
                }}
              />
            </div>
          </Show>
          <button
            type="submit"
            data-slot="connect"
            data-running={state.running}
            data-cancel={state.pending && state.starting ? "true" : undefined}
            disabled={connectDisabled()}
          >
            {state.pending
              ? state.starting
                ? copy().cancel
                : copy().working
              : state.running
                ? copy().disconnect
                : copy().connect}
          </button>
        </form>
        <span data-slot="readout" title={readoutTitle()}>
          {readout()}
        </span>
        <Show when={props.toolbar}>{(toolbar) => <div data-slot="toolbar-end">{toolbar()}</div>}</Show>
      </div>
      <Show when={state.error || state.statusError}>
        <div data-slot="connection-error" role="alert">
          {state.error || state.statusError}
        </div>
      </Show>
      <div data-slot="monitor-output">{props.children}</div>
      <Show when={state.running && state.writable}>
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
              aria-label={state.mode === "rtt" ? copy().sendPlaceholderRtt : copy().sendPlaceholder}
              value={state.data}
              disabled={state.sending}
              placeholder={
                state.encoding === "hex"
                  ? "01 A0 FF 0D 0A"
                  : state.mode === "rtt"
                    ? copy().sendPlaceholderRtt
                    : copy().sendPlaceholder
              }
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
              title={copy().sendMode}
              value={state.encoding}
              disabled={state.sending}
              onChange={(event) => {
                setState("encoding", event.currentTarget.value as SendEncoding)
                setState("sendError", "")
                save()
              }}
            >
              <option value="text">{copy().text}</option>
              <option value="hex">Hex</option>
            </select>
            <label data-slot="ending-field" title={copy().lineEnding}>
              <span data-slot="sr-only">{copy().lineEnding}</span>
              <select
                aria-label={copy().lineEnding}
                value={state.ending}
                onChange={(event) => {
                  setState("ending", event.currentTarget.value as LineEnding)
                  save()
                }}
              >
                <option value="none">{copy().noEnding}</option>
                <option value="lf">LF (\n)</option>
                <option value="cr">CR (\r)</option>
                <option value="crlf">CRLF (\r\n)</option>
              </select>
            </label>
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
      </Show>
      <Show when={state.sendError}>
        <div data-slot="send-error" role="alert">
          {state.sendError}
        </div>
      </Show>
    </div>
  )
}
