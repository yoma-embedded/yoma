import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { ScopeCaptureInfo, ScopeViewResult } from "@yoma-desktop/kernel"
import { cssTokenReader, observeColorScheme, sizeCanvas } from "@yoma-desktop/session-ui/la-preview"
import { kernel } from "@/utils/kernel"
import { SCOPE_COLORS, scopeCursor, scopeTicks, scopeValue, scopeVoltageRange, scopeWindow } from "./scope-waveform-data"

const LEFT = 72
const RIGHT = 16
const TOP = 24
const BOTTOM = 30
const HEIGHT = 280

/** Reads saved samples only. Zooming, panning and cursor movement never send instrument commands. */
export function ScopeWaveform(props: { capture: ScopeCaptureInfo }) {
  const [s, setS] = createStore<{
    width: number; from?: number; to?: number; data?: ScopeViewResult; loading: boolean; error?: string
    hidden: number[]; unit: string; cursorA?: number; cursorB?: number; cursor: "A" | "B"
  }>({ width: 0, loading: false, hidden: [], unit: "", cursor: "A" })
  let container!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let seq = 0
  let disposed = false
  const units = createMemo(() => [...new Set(props.capture.channels.map((channel) => channel.unit))])
  const unit = () => units().includes(s.unit) ? s.unit : units()[0] ?? "V"
  const traces = createMemo(() => (s.data?.channels ?? []).filter((channel) => !s.hidden.includes(channel.ch) && channel.unit === unit()))
  const plotWidth = () => Math.max(1, s.width - LEFT - RIGHT)

  const request = (from?: number, to?: number) => {
    const mine = ++seq
    const dir = props.capture.dir
    clearTimeout(timer)
    setS({ loading: true, error: undefined })
    timer = setTimeout(async () => {
      try {
        const data = await kernel.scope.view({ dir, from, to, columns: Math.min(4096, Math.max(16, Math.floor(plotWidth()))) })
        if (disposed || mine !== seq) return
        setS({ data, from: data.from, to: data.to, loading: false })
      } catch (error) {
        if (disposed || mine !== seq) return
        setS({ data: undefined, loading: false, error: `保存的波形无法读取：${error instanceof Error ? error.message : String(error)}` })
      }
    }, 30)
  }

  createEffect(on(() => props.capture.dir, () => {
    setS({ from: undefined, to: undefined, data: undefined, cursorA: undefined, cursorB: undefined, hidden: [], unit: "" })
    request()
  }))
  createResizeObserver(() => container, () => {
    const width = Math.floor(container.clientWidth)
    if (width === s.width || width <= 0) return
    setS("width", width)
    request(s.from, s.to)
  })

  const draw = () => {
    if (!canvas || s.width <= 0) return
    const ctx = sizeCanvas(canvas, s.width, HEIGHT)
    if (!ctx || !s.data) return
    const data = s.data
    const channels = traces()
    const yRange = scopeVoltageRange(channels)
    const width = plotWidth()
    const height = HEIGHT - TOP - BOTTOM
    const xOf = (time: number) => LEFT + (time - data.from) / (data.to - data.from) * width
    const yOf = (volts: number) => TOP + (yRange.max - volts) / (yRange.max - yRange.min) * height
    const token = cssTokenReader(container)
    const muted = token("--d-muted", "#888")
    const line = token("--d-line", "#bbb")
    const ink = token("--d-ink", "#333")
    ctx.font = `10px ${token("--d-mono", "monospace")}`
    ctx.lineWidth = 1
    ctx.fillStyle = muted
    ctx.strokeStyle = line
    for (const value of scopeTicks(yRange.min, yRange.max, 5)) {
      const y = yOf(value)
      ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + width, y); ctx.stroke()
      ctx.textAlign = "right"
      ctx.fillText(scopeValue(value, unit()), LEFT - 6, y + 3)
    }
    ctx.textAlign = "center"
    for (const time of scopeTicks(data.from, data.to, Math.max(2, width / 105))) {
      const x = xOf(time)
      ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, TOP + height); ctx.stroke()
      ctx.fillText(scopeValue(time, "s"), x, HEIGHT - 10)
    }
    ctx.save()
    ctx.beginPath(); ctx.rect(LEFT, TOP, width, height); ctx.clip()
    for (const channel of channels) {
      ctx.strokeStyle = SCOPE_COLORS[(channel.ch - 1) % SCOPE_COLORS.length]
      ctx.lineWidth = 1.3
      ctx.beginPath()
      let started = false
      for (const point of channel.points) {
        const x = xOf(point.t)
        if (channel.exact) {
          if (started) ctx.lineTo(x, yOf(point.min))
          else ctx.moveTo(x, yOf(point.min))
          started = true
        } else {
          // Each pixel column preserves its full min/max range, including single-sample glitches.
          ctx.moveTo(x, yOf(point.min))
          ctx.lineTo(x, yOf(point.max))
          if (point.min === point.max) ctx.lineTo(x + 1, yOf(point.max))
        }
      }
      ctx.stroke()
      if (channel.exact && channel.points.length === 1) {
        const point = channel.points[0]
        ctx.fillStyle = ctx.strokeStyle
        ctx.fillRect(xOf(point.t) - 1, yOf(point.min) - 1, 3, 3)
      }
    }
    ctx.restore()
    ctx.textAlign = "left"
    if (data.from <= 0 && data.to >= 0) {
      ctx.strokeStyle = muted
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(xOf(0), TOP); ctx.lineTo(xOf(0), TOP + height); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = muted
      ctx.fillText("T=0", xOf(0) + 3, TOP - 7)
    }
    for (const [name, time] of [["A", s.cursorA], ["B", s.cursorB]] as const) {
      if (time === undefined || time < data.from || time > data.to) continue
      ctx.strokeStyle = ink
      ctx.setLineDash(name === "B" ? [5, 3] : [])
      ctx.beginPath(); ctx.moveTo(xOf(time), TOP); ctx.lineTo(xOf(time), TOP + height); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = ink
      ctx.fillText(name, xOf(time) + 3, TOP + 12)
    }
  }
  const repaint = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { frame = undefined; if (!disposed) draw() })
  }
  createEffect(() => {
    void s.data; void s.width; void s.cursorA; void s.cursorB; void traces(); void unit()
    repaint()
  })
  onCleanup(observeColorScheme(repaint))
  onCleanup(() => {
    disposed = true; seq++; clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  const changeWindow = (from: number, to: number) => {
    const c = props.capture
    const minSpan = Math.min(...c.channels.map((ch) => ch.interval)) * 2
    const window = scopeWindow(from, to, c.from, c.to, minSpan)
    request(window.from, window.to)
  }
  const xFraction = (clientX: number) => Math.max(0, Math.min(1, (clientX - canvas.getBoundingClientRect().left - LEFT) / plotWidth()))
  const zoom = (factor: number, fraction = 0.5) => {
    if (!s.data) return
    const span = s.data.to - s.data.from
    const anchor = s.data.from + fraction * span
    const next = span * factor
    changeWindow(anchor - fraction * next, anchor + (1 - fraction) * next)
  }
  const pan = (fraction: number) => {
    if (!s.data) return
    const delta = (s.data.to - s.data.from) * fraction
    changeWindow(s.data.from + delta, s.data.to + delta)
  }
  let drag: { x: number; from: number; to: number; moved: boolean } | undefined
  const pointerDown = (event: PointerEvent) => {
    if (!s.data || event.button !== 0) return
    canvas.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, from: s.data.from, to: s.data.to, moved: false }
  }
  const pointerMove = (event: PointerEvent) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    if (!drag.moved) return
    const delta = dx / plotWidth() * (drag.to - drag.from)
    changeWindow(drag.from - delta, drag.to - delta)
  }
  const pointerUp = (event: PointerEvent) => {
    if (!drag || !s.data) return
    const moved = drag.moved
    drag = undefined
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    if (moved) return
    const time = s.data.from + xFraction(event.clientX) * (s.data.to - s.data.from)
    setS(event.shiftKey || s.cursor === "B" ? "cursorB" : "cursorA", time)
  }
  const cursorText = (channel: ScopeViewResult["channels"][number], time?: number) => {
    const point = readCursor(channel, time)
    if (!point) return "—"
    if (!channel.exact) return `${scopeValue(point.min, channel.unit)} … ${scopeValue(point.max, channel.unit)}（范围）`
    return `${scopeValue(point.min, channel.unit)} @ ${scopeValue(point.t, "s")}`
  }
  const readCursor = (channel: ScopeViewResult["channels"][number], time?: number) => {
    const meta = props.capture.channels.find((entry) => entry.ch === channel.ch)
    // Channels can have different stored time spans; never extend the last voltage into missing data.
    if (!meta || time === undefined || time < meta.t0 || time >= meta.t0 + meta.points * meta.interval) return undefined
    return scopeCursor(channel, time, s.data?.from ?? 0, s.data?.to ?? 0)
  }

  return (
    <div data-component="scope-waveform" ref={(element) => { container = element }}>
      <div data-slot="controls">
        <span class="ydbg-mono">{s.data ? `${scopeValue(s.data.from, "s")} … ${scopeValue(s.data.to, "s")}` : "保存的波形"}</span>
        <span data-slot="actions">
          <button type="button" onClick={() => pan(-0.3)} disabled={!s.data} aria-label="向前平移">←</button>
          <button type="button" onClick={() => pan(0.3)} disabled={!s.data} aria-label="向后平移">→</button>
          <button type="button" onClick={() => zoom(0.5)} disabled={!s.data} aria-label="放大波形">+</button>
          <button type="button" onClick={() => zoom(2)} disabled={!s.data} aria-label="缩小波形">−</button>
          <button type="button" onClick={() => request()}>全程</button>
          <button type="button" aria-pressed={s.cursor === "A"} onClick={() => setS("cursor", "A")}>游标 A</button>
          <button type="button" aria-pressed={s.cursor === "B"} onClick={() => setS("cursor", "B")}>游标 B</button>
          <button type="button" onClick={() => setS({ cursorA: undefined, cursorB: undefined })}>清游标</button>
        </span>
      </div>
      <div data-slot="channels">
        <For each={props.capture.channels}>{(channel) => (
          <label style={{ color: SCOPE_COLORS[(channel.ch - 1) % SCOPE_COLORS.length] }}>
            <input type="checkbox" checked={!s.hidden.includes(channel.ch)} onChange={(e) => setS("hidden", e.currentTarget.checked ? s.hidden.filter((ch) => ch !== channel.ch) : [...s.hidden, channel.ch])} />
            C{channel.ch}{channel.label ? ` ${channel.label}` : ""} · ×{channel.probe} · {channel.coupling ?? "—"}
          </label>
        )}</For>
        <Show when={units().length > 1}>
          <label>纵轴单位 <select value={unit()} onChange={(e) => setS("unit", e.currentTarget.value)}><For each={units()}>{(value) => <option value={value}>{value}</option>}</For></select></label>
        </Show>
      </div>
      <Show when={s.error}><div data-slot="error" role="alert">{s.error}</div></Show>
      <div data-slot="plot" aria-busy={s.loading}>
        <canvas ref={(element) => { canvas = element }} aria-label="示波器保存波形，横轴为触发相对时间，纵轴为通道标注单位" style={{ height: `${HEIGHT}px` }}
          onWheel={(e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.25 : 0.8, xFraction(e.clientX)) }}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag = undefined }} />
        <Show when={s.loading}><span data-slot="loading">读取保存数据…</span></Show>
        <Show when={s.data && !traces().length}><span data-slot="loading">请选择要查看的通道</span></Show>
      </div>
      <div data-slot="readout" class="ydbg-mono">
        <Show when={s.cursorA !== undefined}><span>A 位置 {scopeValue(s.cursorA!, "s")}</span></Show>
        <Show when={s.cursorB !== undefined}><span>B 位置 {scopeValue(s.cursorB!, "s")}</span></Show>
        <Show when={s.cursorA !== undefined && s.cursorB !== undefined}><span>Δt 位置 {scopeValue(s.cursorB! - s.cursorA!, "s")}</span></Show>
      </div>
      <Show when={s.cursorA !== undefined || s.cursorB !== undefined}>
        <div data-slot="cursor-table" role="region" aria-label="示波器游标读数" tabIndex={0}><table><thead><tr><th>通道</th><th>A</th><th>B</th><th>幅值差 / Δt 样本</th></tr></thead><tbody>
          <For each={traces()}>{(channel) => {
            const delta = () => {
              const a = readCursor(channel, s.cursorA)
              const b = readCursor(channel, s.cursorB)
              if (!a || !b) return "—"
              return channel.exact && a && b ? `${scopeValue(b.min - a.min, channel.unit)} / ${scopeValue(b.t - a.t, "s")}` : "放大到实际采样点后显示"
            }
            return <tr><th>C{channel.ch}</th><td>{cursorText(channel, s.cursorA)}</td><td>{cursorText(channel, s.cursorB)}</td><td>{delta()}</td></tr>
          }}</For>
        </tbody></table></div>
      </Show>
      <div class="ydbg-win-caption">点击放置所选游标，Shift+点击放 B；滚轮缩放，拖拽平移。缩小显示保峰包络，放大显示已保存采样点；这些操作不会控制仪器。</div>
    </div>
  )
}
