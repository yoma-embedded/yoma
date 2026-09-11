import { For } from "solid-js"
import { debug, type Instrument, type Transport } from "./debug-data"
import { LaBody } from "./la-waveform"
import "./debug-panel.css"

const TRANSPORT_LABEL: Record<Transport, string> = {
  usb: "USB",
  scpi: "SCPI",
  lan: "LAN",
  gdb: "GDB",
  serial: "UART",
  api: "API",
}

// ------------------------------------------------------------ instrument window

function InstrumentWindow(props: { ins: Instrument }) {
  return (
    <section class="ydbg-win" data-st={props.ins.status}>
      <header class="ydbg-win-h">
        <span class="ydbg-led" />
        <span class="ydbg-win-name">{props.ins.name}</span>
        <span class="ydbg-tp">{TRANSPORT_LABEL[props.ins.transport]}</span>
        <span class="ydbg-win-detail ydbg-mono">{props.ins.detail}</span>
      </header>
      <div class="ydbg-win-b">
        <LaBody />
      </div>
    </section>
  )
}

// ------------------------------------------------------------ exports

/** 调试模式主体：每台仪器一个大显示窗口，纵向堆叠 */
export function DebugContent() {
  return (
    <div class="ydbg-wins">
      <For each={debug.instruments}>{(ins) => <InstrumentWindow ins={ins} />}</For>
    </div>
  )
}
