import { For, Show, createMemo, type JSX } from "solid-js"
import {
  debug,
  type DebugView,
  type Transport,
  type WaveformData,
  type TimeseriesData,
  type ScalarData,
  type RegistersData,
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

// ------------------------------------------------------------ view renderers
// 渲染器注册表：面板按 view.kind 挑组件。加新仪器类别 = 加一个 case，排版不动。

function WaveformView(props: { data: WaveformData }) {
  return (
    <>
      <div class="ydbg-card">
        <div class="ydbg-card-h">
          <span class="ydbg-bus">{props.data.bus}</span>
          <span class="ydbg-meta">{props.data.meta}</span>
        </div>
        <div class="ydbg-wave">
          <div class="ydbg-lane">SCL</div>
          <svg viewBox="0 0 320 26" preserveAspectRatio="none" aria-label="SCL clock">
            <polyline
              fill="none"
              stroke="var(--d-accent)"
              stroke-width="1.6"
              points="0,22 8,22 8,5 22,5 22,22 36,22 36,5 50,5 50,22 64,22 64,5 78,5 78,22 92,22 92,5 106,5 106,22 120,22 120,5 134,5 134,22 148,22 148,5 162,5 162,22 176,22 176,5 190,5 190,22 204,22 204,5 218,5 218,22 232,22 232,5 246,5 246,22 260,22 260,5 274,5 274,22 320,22"
            />
          </svg>
          <div class="ydbg-lane">
            SDA <em>— 第 9 个时钟应被从机拉低 (ACK)，实际保持高</em>
          </div>
          <svg viewBox="0 0 320 30" preserveAspectRatio="none" aria-label="SDA data">
            <rect x="246" y="0" width="34" height="30" fill="var(--d-fail-bg)" />
            <line x1="246" y1="0" x2="246" y2="30" stroke="var(--d-fail)" stroke-width="1" stroke-dasharray="3 2" />
            <polyline
              fill="none"
              stroke="var(--d-ink)"
              stroke-width="1.6"
              points="0,6 22,6 22,24 50,24 50,6 78,6 78,24 106,24 106,6 134,6 134,24 162,24 162,6 190,6 218,6 218,24 246,24 246,6 320,6"
            />
            <text x="263" y="12" fill="var(--d-fail)" font-size="9" text-anchor="middle" font-family="ui-monospace">
              NACK
            </text>
          </svg>
        </div>
        <div class="ydbg-decode">
          <For each={props.data.decode}>
            {(b) => (
              <span class="ydbg-byte" data-bad={b.bad ? "true" : "false"} data-faint={b.faint ? "true" : "false"}>
                {b.text}
              </span>
            )}
          </For>
        </div>
      </div>
      <Show when={props.data.analysis}>
        <div class="ydbg-analysis">
          <b>信号完整性：</b>
          {props.data.analysis}
        </div>
      </Show>
    </>
  )
}

function TimeseriesView(props: { data: TimeseriesData }) {
  const path = createMemo(() => {
    const pts = props.data.points
    if (pts.length < 2) return ""
    const min = Math.min(...pts)
    const max = Math.max(...pts)
    const span = max - min || 1
    return pts
      .map((p, i) => {
        const x = (i / (pts.length - 1)) * 100
        const y = 40 - ((p - min) / span) * 34 - 3
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(" ")
  })
  return (
    <div class="ydbg-card">
      <div class="ydbg-card-h">
        <span class="ydbg-bus">功耗曲线</span>
        <span class="ydbg-meta">{props.data.unit}</span>
        <Show when={props.data.note}>
          <span class="ydbg-flag" data-tone="warn">
            ⚠ {props.data.note}
          </span>
        </Show>
      </div>
      <div class="ydbg-spark">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="power timeseries">
          <polyline fill="none" stroke="var(--d-accent)" stroke-width="1.4" points={path()} />
        </svg>
      </div>
      <div class="ydbg-stats">
        <For each={props.data.stats}>
          {(s) => (
            <div class="ydbg-stat">
              <div class="k">{s.label}</div>
              <div class="v">{s.value}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function ScalarView(props: { data: ScalarData }) {
  return (
    <div class="ydbg-card">
      <div class="ydbg-scalar">
        <div>
          <span class="big">{props.data.value}</span>
          <span class="unit">{props.data.unit}</span>
        </div>
        <div class="lb">
          {props.data.label}
          <Show when={props.data.sub}>
            <br />
            {props.data.sub}
          </Show>
        </div>
      </div>
    </div>
  )
}

function RegistersView(props: { data: RegistersData }) {
  return (
    <div class="ydbg-card">
      <table class="ydbg-regs">
        <tbody>
          <For each={props.data.rows}>
            {(r) => (
              <tr data-bad={r.bad ? "true" : "false"}>
                <td class="nm">{r.name}</td>
                <td>{r.addr}</td>
                <td class="val">{r.value}</td>
                <td class="note">{r.note ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function renderView(v: DebugView): JSX.Element {
  switch (v.kind) {
    case "waveform":
      return <WaveformView data={v.data as WaveformData} />
    case "timeseries":
      return <TimeseriesView data={v.data as TimeseriesData} />
    case "scalar":
      return <ScalarView data={v.data as ScalarData} />
    case "registers":
      return <RegistersView data={v.data as RegistersData} />
    default:
      return <div class="ydbg-placeholder">暂无 {v.kind} 渲染器</div>
  }
}

// ------------------------------------------------------------ fixed subpanes

function ConsoleView() {
  return (
    <div class="ydbg-console">
      <For each={debug.console}>
        {(l) => (
          <div data-lv={l.level}>
            <span class="t">[{l.t}]</span> <span class="m">{l.text}</span>
          </div>
        )}
      </For>
      <span class="ydbg-cur" />
    </div>
  )
}

function TestsView() {
  const icon = (st: string) => (st === "pass" ? "✓" : st === "fail" ? "✕" : "◠")
  return (
    <>
      <div class="ydbg-tests">
        <For each={debug.tests}>
          {(t) => (
            <div class="ydbg-trow" data-st={t.state}>
              <span class="ic">{icon(t.state)}</span>
              <span class="nm">{t.name}</span>
              <Show
                when={t.evidence}
                fallback={<span class="ms">{t.state === "run" ? "运行中…" : t.ms ? `${t.ms} ms` : ""}</span>}
              >
                <button class="ev" onClick={() => t.evidence && debug.setSubtab(t.evidence)}>
                  ↗ 波形证据
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={debug.tests.find((t) => t.note)}>
        {(t) => (
          <div class="ydbg-analysis" style={{ "margin-top": "10px" }}>
            <b>{t().name} 失败：</b>
            {t().note}。证据已链接到「波形」子标签与对话中的证据卡片。
          </div>
        )}
      </Show>
    </>
  )
}

// ------------------------------------------------------------ exports

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

/** 调试模式主体：硬件/仪器状态 + HIL 闭环 + 能力驱动子标签 */
export function DebugContent() {
  const subtabs = createMemo(() => ({
    views: debug.views.map((v) => ({ id: v.id, label: v.title, badge: v.badge })),
    pass: debug.tests.filter((t) => t.state === "pass").length,
    fail: debug.tests.filter((t) => t.state === "fail").length,
  }))

  return (
    <>
      {/* pinned: hardware / instruments */}
      <div class="ydbg-sumhead">
        <span class="ydbg-t">硬件 / 仪器</span>
        <button class="ydbg-run" data-running={debug.running() ? "true" : "false"} onClick={() => debug.runHil()}>
          ▶ 运行 HIL
        </button>
      </div>
      <div class="ydbg-hw">
        <For each={debug.instruments}>
          {(ins) => (
            <div class="ydbg-hwrow" data-st={ins.status}>
              <span class="ydbg-led" />
              <div>
                <div class="ydbg-nm">
                  {ins.name}
                  <span class="ydbg-tp">{TRANSPORT_LABEL[ins.transport]}</span>
                </div>
                <div class="ydbg-sub ydbg-mono">{ins.detail}</div>
              </div>
              <Show when={ins.readout}>
                {(r) => (
                  <div class="ydbg-val" data-st={ins.status}>
                    <b>{r().value}</b>
                    <Show when={r().sub}>
                      <small>{r().sub}</small>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>

      {/* HIL loop stepper */}
      <div class="ydbg-hil">
        <div class="ydbg-cap">
          <span>BUILD → FLASH → TEST → FIX 闭环</span>
          <span class="ydbg-mono">{debug.running() ? "运行中…" : "上次 12.4s"}</span>
        </div>
        <div class="ydbg-steps">
          <For each={debug.hil()}>
            {(s) => (
              <div class="ydbg-step" data-st={s.state}>
                <div class="ydbg-bub">
                  {s.state === "done" ? "✓" : s.state === "fail" ? "✕" : s.state === "run" ? "◠" : s.label[0]}
                </div>
                <div class="ydbg-lb">{s.label}</div>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* detail subtabs (capability-driven: 视图来自连接仪器 + 控制台 + 测试) */}
      <div class="ydbg-subtabs">
        <For each={subtabs().views}>
          {(t) => (
            <button
              class="ydbg-subtab"
              data-on={debug.subtab() === t.id ? "true" : "false"}
              onClick={() => debug.setSubtab(t.id)}
            >
              {t.label}
              <Show when={t.badge}>{(b) => <span class="ydbg-b r">{b().text}</span>}</Show>
            </button>
          )}
        </For>
        <button
          class="ydbg-subtab"
          data-on={debug.subtab() === "console" ? "true" : "false"}
          onClick={() => debug.setSubtab("console")}
        >
          控制台
        </button>
        <button
          class="ydbg-subtab"
          data-on={debug.subtab() === "tests" ? "true" : "false"}
          onClick={() => debug.setSubtab("tests")}
        >
          测试
          <span class="ydbg-b g">{subtabs().pass}</span>
          <span class="ydbg-b r">{subtabs().fail}</span>
        </button>
      </div>

      {/* subtab content */}
      <Show when={debug.subtab() === "console"}>
        <ConsoleView />
      </Show>
      <Show when={debug.subtab() === "tests"}>
        <TestsView />
      </Show>
      <Show when={debug.viewById(debug.subtab())} keyed>
        {(v) => renderView(v)}
      </Show>
    </>
  )
}
