import { For, Match, Show, Switch, createMemo } from "solid-js"
import {
  debug,
  type Instrument,
  type Transport,
  type WaveformDisplay,
  type TimeseriesDisplay,
  type ScalarDisplay,
  type StatusDisplay,
  type OfflineDisplay,
} from "./debug-data"
import "./debug-panel.css"

const TRANSPORT_LABEL: Record<Transport, string> = {
  usb: "USB",
  scpi: "SCPI",
  lan: "LAN",
  gdb: "GDB",
  serial: "UART",
  api: "API",
}

// ------------------------------------------------------------ display bodies
// 渲染注册表：每种 display.kind 一个渲染器。新增仪器类别 = 补一个 Match，窗口壳不变。

function WaveformBody(props: { d: WaveformDisplay }) {
  return (
    <>
      <div class="ydbg-win-meta">
        <span class="ydbg-mono">{props.d.meta}</span>
        <Show when={props.d.flag}>
          <span class="ydbg-flag">⚠ {props.d.flag}</span>
        </Show>
      </div>
      {/* 注意：SVG presentation attribute 不解析 var()，主题色必须走内联 style/CSS */}
      <svg class="ydbg-wave" viewBox="0 0 320 96" preserveAspectRatio="none" aria-label="logic capture">
        {/* NACK 异常区高亮（跨两条泳道） */}
        <rect x="246" y="6" width="34" height="84" style={{ fill: "var(--d-fail-bg)" }} />
        <line
          x1="246"
          y1="6"
          x2="246"
          y2="90"
          stroke-width="1"
          stroke-dasharray="3 2"
          style={{ stroke: "var(--d-fail)" }}
        />
        {/* SCL */}
        <text x="4" y="14" class="ydbg-wave-label">
          SCL
        </text>
        <polyline
          fill="none"
          stroke-width="1.6"
          style={{ stroke: "var(--d-accent)" }}
          points="0,38 8,38 8,20 22,20 22,38 36,38 36,20 50,20 50,38 64,38 64,20 78,20 78,38 92,38 92,20 106,20 106,38 120,38 120,20 134,20 134,38 148,38 148,20 162,20 162,38 176,38 176,20 190,20 190,38 204,38 204,20 218,20 218,38 232,38 232,20 246,20 246,38 260,38 260,20 274,20 274,38 320,38"
        />
        {/* SDA */}
        <text x="4" y="62" class="ydbg-wave-label">
          SDA
        </text>
        <polyline
          fill="none"
          stroke-width="1.6"
          style={{ stroke: "var(--d-ink)" }}
          points="0,68 22,68 22,86 50,86 50,68 78,68 78,86 106,86 106,68 134,68 134,86 162,86 162,68 190,68 218,68 218,86 246,86 246,68 320,68"
        />
        <text
          x="263"
          y="60"
          font-size="10"
          text-anchor="middle"
          font-family="ui-monospace"
          style={{ fill: "var(--d-fail)" }}
        >
          NACK
        </text>
      </svg>
      <Show when={props.d.caption}>
        <div class="ydbg-win-caption">{props.d.caption}</div>
      </Show>
    </>
  )
}

function TimeseriesBody(props: { d: TimeseriesDisplay }) {
  const line = createMemo(() => {
    const pts = props.d.points
    if (pts.length < 2) return ""
    const min = Math.min(...pts)
    const max = Math.max(...pts)
    const span = max - min || 1
    return pts
      .map((p, i) => {
        const x = (i / (pts.length - 1)) * 320
        const y = 86 - ((p - min) / span) * 72
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(" ")
  })
  return (
    <>
      <svg class="ydbg-ts" viewBox="0 0 320 96" preserveAspectRatio="none" aria-label="timeseries">
        <polygon style={{ fill: "var(--d-accent-tint)" }} points={`0,96 ${line()} 320,96`} />
        <polyline fill="none" stroke-width="1.6" style={{ stroke: "var(--d-accent)" }} points={line()} />
      </svg>
      <div class="ydbg-win-caption ydbg-mono">{props.d.summary}</div>
    </>
  )
}

function ScalarBody(props: { d: ScalarDisplay }) {
  return (
    <div class="ydbg-big">
      <div>
        <span class="ydbg-big-v ydbg-mono">{props.d.value}</span>
        <span class="ydbg-big-u">{props.d.unit}</span>
      </div>
      <Show when={props.d.sub}>
        <div class="ydbg-big-sub">{props.d.sub}</div>
      </Show>
    </div>
  )
}

function StatusBody(props: { d: StatusDisplay }) {
  return (
    <div class="ydbg-big">
      <div class="ydbg-big-v">{props.d.primary}</div>
      <Show when={props.d.secondary}>
        <div class="ydbg-big-sub">{props.d.secondary}</div>
      </Show>
    </div>
  )
}

function OfflineBody(props: { d: OfflineDisplay }) {
  return (
    <div class="ydbg-big ydbg-off">
      <div class="ydbg-big-v">离线</div>
      <Show when={props.d.hint}>
        <div class="ydbg-big-sub">{props.d.hint}</div>
      </Show>
    </div>
  )
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
        <Switch>
          <Match when={props.ins.display.kind === "waveform"}>
            <WaveformBody d={props.ins.display as WaveformDisplay} />
          </Match>
          <Match when={props.ins.display.kind === "timeseries"}>
            <TimeseriesBody d={props.ins.display as TimeseriesDisplay} />
          </Match>
          <Match when={props.ins.display.kind === "scalar"}>
            <ScalarBody d={props.ins.display as ScalarDisplay} />
          </Match>
          <Match when={props.ins.display.kind === "status"}>
            <StatusBody d={props.ins.display as StatusDisplay} />
          </Match>
          <Match when={props.ins.display.kind === "offline"}>
            <OfflineBody d={props.ins.display as OfflineDisplay} />
          </Match>
        </Switch>
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

/** cmd 模式的模拟终端输出 —— 真实终端 (node-pty) 接入后替换 */
export function CmdMock() {
  return (
    <>
      <div class="ydbg-console">
        <div>
          <span class="p">$</span> make flash
        </div>
        <div class="o">[build] arm-none-eabi-gcc -O2 main.c drivers/i2c.c … ✓</div>
        <div class="o">[flash] J-Link: 48 KB @ 0x08000000 … ✓</div>
        <div>
          <span class="p">$</span> <span class="ydbg-cur" />
        </div>
      </div>
      <div class="ydbg-filehint">模拟输出 —— 真实终端 (node-pty) 接入后替换</div>
    </>
  )
}
