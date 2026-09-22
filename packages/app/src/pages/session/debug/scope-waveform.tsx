import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { ScopeCaptureInfo, ScopeViewResult } from "@yoma-desktop/kernel"
import { cssTokenReader, observeColorScheme, sizeCanvas } from "@yoma-desktop/session-ui/la-preview"
import { kernel } from "@/utils/kernel"
import { SCOPE_COLORS, scopeCursor, scopeValue, scopeVoltageAxis, scopeWindow } from "./scope-waveform-data"
import { useScopeCopy } from "./scope-copy"

const LEFT = 68
const RIGHT = 18
const TOP = 25
const BOTTOM = 30
const SETTLE_MS = 140

/** All gestures operate on saved samples. Only a settled viewport reads more data from disk. */
export function ScopeWaveform(props: { capture: ScopeCaptureInfo }) {
  const t = useScopeCopy()
  const [s, setS] = createStore<{
    width: number; plotHeight?: number; from?: number; to?: number; data?: ScopeViewResult; overview?: ScopeViewResult; loading: boolean; error?: string
    hidden: number[]; unit: string; cursorA?: number; cursorB?: number; cursor: "A" | "B"; dragging: boolean
  }>({ width: 0, loading: false, hidden: [], unit: "", cursor: "A", dragging: false })
  let container!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let seq = 0
  let disposed = false
  const units = createMemo(() => [...new Set(props.capture.channels.map((channel) => channel.unit))])
  const unit = () => units().includes(s.unit) ? s.unit : units()[0] ?? "V"
  const from = () => s.from ?? props.capture.from
  const to = () => s.to ?? props.capture.to
  const span = () => to() - from()
  const plotWidth = () => Math.max(1, s.width - LEFT - RIGHT)
  const preferredHeight = (width: number) => Math.max(250, Math.min(360, Math.round(width * 0.48)))
  const height = () => s.plotHeight ?? preferredHeight(s.width)
  const visible = (data?: ScopeViewResult) => (data?.channels ?? []).filter((channel) => !s.hidden.includes(channel.ch) && channel.unit === unit())
  // The whole-record envelope fills newly exposed regions while detailed samples load.
  const source = createMemo(() => s.data && from() >= s.data.from && to() <= s.data.to ? s.data : s.overview ?? s.data)
  const traces = createMemo(() => visible(source()))
  // Keep a stable shared voltage scale while navigating so amplitude never jumps under the pointer.
  const axis = createMemo(() => scopeVoltageAxis(visible(s.overview ?? s.data)))
  const preview = () => source()?.from !== from() || source()?.to !== to()

  const invalidate = () => {
    seq++
    clearTimeout(timer)
    setS("loading", false)
  }
  const request = (delay = 0, initial = false) => {
    invalidate()
    const mine = seq
    const dir = props.capture.dir
    const window = { from: from(), to: to() }
    timer = setTimeout(async () => {
      setS({ loading: true, error: undefined })
      try {
        const data = await kernel.scope.view({ dir, ...window, columns: Math.min(4096, Math.max(16, Math.floor(plotWidth()))) })
        if (disposed || mine !== seq) return
        const full = data.from <= props.capture.from && data.to >= props.capture.to
        setS({ data, loading: false, ...(full ? { overview: data } : {}), ...(initial ? { from: data.from, to: data.to } : {}) })
      } catch (error) {
        if (disposed || mine !== seq) return
        setS({ loading: false, error: `${t("waveformError")}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }, delay)
  }

  createEffect(on(() => props.capture.dir, () => {
    setS({ from: props.capture.from, to: props.capture.to, data: undefined, overview: undefined, cursorA: undefined, cursorB: undefined, hidden: [], unit: "", error: undefined })
    request(0, true)
  }))
  const scrollViewport = () => {
    for (let parent = container?.parentElement; parent; parent = parent.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent
    }
  }
  createResizeObserver(() => [container, scrollViewport()], () => {
    const width = Math.floor(container.clientWidth)
    const viewport = scrollViewport()
    if (viewport && canvas && viewport.clientHeight > 0) {
      // Use the unscrolled content offset: scrolling must not resize the waveform.
      const top = canvas.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientTop
      const available = Math.floor(viewport.clientHeight - top - 10)
      setS("plotHeight", Math.max(150, Math.min(preferredHeight(width), available)))
    } else setS("plotHeight", undefined)
    if (width === s.width || width <= 0) return
    setS("width", width)
    if (!s.dragging) request(SETTLE_MS)
  })

  const draw = () => {
    if (!canvas || s.width <= 0) return
    const ctx = sizeCanvas(canvas, s.width, height())
    if (!ctx || !source()) return
    const channels = traces()
    const yRange = axis()
    const width = plotWidth()
    const plotHeight = height() - TOP - BOTTOM
    const xOf = (time: number) => LEFT + (time - from()) / span() * width
    const yOf = (volts: number) => TOP + (yRange.max - volts) / (yRange.max - yRange.min) * plotHeight
    const token = cssTokenReader(container)
    const muted = token("--d-muted", "#888")
    const line = token("--d-line", "#bbb")
    const ink = token("--d-ink", "#333")
    const accent = token("--d-accent", "#2c78bf")
    ctx.font = `11px ${token("--d-mono", "monospace")}`
    ctx.lineWidth = 1
    ctx.fillStyle = muted
    ctx.strokeStyle = line
    // Eight vertical and ten horizontal divisions match the scale readouts.
    for (let division = 0; division <= 8; division++) {
      const value = yRange.min + division * yRange.division
      const y = yOf(value)
      ctx.globalAlpha = division === 4 ? 0.85 : 0.45
      ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + width, y); ctx.stroke()
      ctx.globalAlpha = 1
      ctx.textAlign = "right"; ctx.fillText(scopeValue(value, unit()), LEFT - 8, y + 3)
    }
    ctx.textAlign = "center"
    for (let division = 0; division <= 10; division++) {
      const time = from() + division / 10 * span()
      const x = xOf(time)
      ctx.globalAlpha = division === 5 ? 0.85 : 0.45
      ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, TOP + plotHeight); ctx.stroke()
      ctx.globalAlpha = 1
      if (division % 2 === 0) ctx.fillText(scopeValue(time, "s"), x, height() - 10)
    }
    ctx.save()
    ctx.beginPath(); ctx.rect(LEFT, TOP, width, plotHeight); ctx.clip()
    if (yRange.min <= 0 && yRange.max >= 0) {
      ctx.strokeStyle = muted; ctx.globalAlpha = 0.5
      ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(LEFT, yOf(0)); ctx.lineTo(LEFT + width, yOf(0)); ctx.stroke(); ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    for (const channel of channels) {
      ctx.strokeStyle = SCOPE_COLORS[(channel.ch - 1) % SCOPE_COLORS.length]
      ctx.lineWidth = 1.5
      // Subpixel min/max ranges still need a visible mark; never invent a midpoint.
      ctx.lineCap = "round"
      ctx.beginPath()
      let started = false
      for (let index = 0; index < channel.points.length; index++) {
        const point = channel.points[index]
        // Include one neighboring point so exact traces meet both viewport edges.
        if (point.t < from() && channel.points[index + 1]?.t < from()) continue
        if (point.t > to() && channel.points[index - 1]?.t > to()) break
        const x = xOf(point.t)
        if (channel.exact) {
          if (started) ctx.lineTo(x, yOf(point.min))
          else ctx.moveTo(x, yOf(point.min))
          started = true
        } else {
          // Min/max columns preserve narrow glitches; never draw an invented midpoint.
          ctx.moveTo(x, yOf(point.min)); ctx.lineTo(x, yOf(point.max))
          if (point.min === point.max) ctx.lineTo(x + 1, yOf(point.max))
        }
      }
      ctx.stroke()
      if (channel.exact && channel.points.length < 100) {
        ctx.fillStyle = ctx.strokeStyle
        for (const point of channel.points) ctx.fillRect(xOf(point.t) - 1.5, yOf(point.min) - 1.5, 3, 3)
      }
    }
    ctx.restore()
    ctx.textAlign = "left"
    if (from() <= 0 && to() >= 0) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(xOf(0), TOP); ctx.lineTo(xOf(0), TOP + plotHeight); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = muted; ctx.fillText("T=0", Math.min(xOf(0) + 4, LEFT + width - 25), TOP - 8)
    }
    for (const [name, time] of [["A", s.cursorA], ["B", s.cursorB]] as const) {
      if (time === undefined || time < from() || time > to()) continue
      const color = name === "A" ? accent : ink
      ctx.strokeStyle = color; ctx.setLineDash(name === "B" ? [5, 3] : [])
      ctx.beginPath(); ctx.moveTo(xOf(time), TOP); ctx.lineTo(xOf(time), TOP + plotHeight); ctx.stroke(); ctx.setLineDash([])
      const x = Math.min(xOf(time) + 3, LEFT + width - 17)
      ctx.fillStyle = color; ctx.fillRect(x, TOP + 4, 15, 17)
      ctx.fillStyle = token("--d-panel", "#fff"); ctx.fillText(name, x + 4, TOP + 16)
    }
  }
  const repaint = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => { frame = undefined; if (!disposed) draw() })
  }
  createEffect(() => {
    void s.width; void height(); void s.cursorA; void s.cursorB; void traces(); void unit(); void axis(); void from(); void to()
    repaint()
  })
  onCleanup(observeColorScheme(repaint))
  onCleanup(() => {
    disposed = true; seq++; clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  const changeWindow = (start: number, end: number, settle: number | false = 0) => {
    const c = props.capture
    const minSpan = Math.min(...c.channels.map((ch) => ch.interval)) * 2
    const window = scopeWindow(start, end, c.from, c.to, minSpan)
    invalidate()
    setS(window)
    if (settle !== false) request(settle)
  }
  const xFraction = (clientX: number) => Math.max(0, Math.min(1, (clientX - canvas.getBoundingClientRect().left - LEFT) / plotWidth()))
  const zoom = (factor: number, fraction = 0.5, settle = 0) => {
    if (!s.data) return
    const anchor = from() + fraction * span()
    const next = span() * factor
    changeWindow(anchor - fraction * next, anchor + (1 - fraction) * next, settle)
  }
  const pan = (fraction: number, settle = 0) => {
    if (!s.data) return
    const delta = span() * fraction
    changeWindow(from() + delta, to() + delta, settle)
  }
  const fit = () => changeWindow(props.capture.from, props.capture.to)
  const pointers = new Map<number, number>()
  let drag: { x: number; from: number; to: number; moved: boolean; distance?: number } | undefined
  const beginDrag = (moved = false) => {
    const points = [...pointers.values()]
    if (!points.length) { drag = undefined; return }
    drag = { x: points.reduce((sum, point) => sum + point, 0) / points.length, from: from(), to: to(), moved, distance: points.length > 1 ? Math.max(1, Math.abs(points[1] - points[0])) : undefined }
  }
  const pointerDown = (event: PointerEvent) => {
    if (!s.data || event.button !== 0) return
    canvas.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, event.clientX)
    beginDrag(pointers.size > 1)
  }
  const pointerMove = (event: PointerEvent) => {
    if (!drag || !pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, event.clientX)
    const points = [...pointers.values()]
    const center = points.reduce((sum, point) => sum + point, 0) / points.length
    const dx = center - drag.x
    if (Math.abs(dx) > 3 || points.length > 1) drag.moved = true
    if (!drag.moved) return
    setS("dragging", true)
    const oldSpan = drag.to - drag.from
    const nextSpan = drag.distance && points.length > 1 ? oldSpan * drag.distance / Math.max(1, Math.abs(points[1] - points[0])) : oldSpan
    const anchor = drag.from + xFraction(drag.x) * oldSpan
    const start = anchor - xFraction(center) * nextSpan
    changeWindow(start, start + nextSpan, false)
  }
  const pointerUp = (event: PointerEvent) => {
    if (!drag || !pointers.has(event.pointerId)) return
    const moved = drag.moved
    pointers.delete(event.pointerId)
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    if (pointers.size) { beginDrag(true); return }
    drag = undefined
    setS("dragging", false)
    if (moved) { request(); return }
    if (event.type === "pointercancel") return
    setS(event.shiftKey || s.cursor === "B" ? "cursorB" : "cursorA", from() + xFraction(event.clientX) * span())
  }
  const readCursor = (channel: ScopeViewResult["channels"][number], time?: number) => {
    const meta = props.capture.channels.find((entry) => entry.ch === channel.ch)
    if (!meta || time === undefined || time < meta.t0 || time >= meta.t0 + meta.points * meta.interval) return undefined
    return scopeCursor(channel, time, source()?.from ?? 0, source()?.to ?? 0)
  }
  const cursorText = (channel: ScopeViewResult["channels"][number], time?: number) => {
    const point = readCursor(channel, time)
    if (!point) return "—"
    if (!channel.exact) return `${scopeValue(point.min, channel.unit)} … ${scopeValue(point.max, channel.unit)} (${t("range")})`
    return `${scopeValue(point.min, channel.unit)} @ ${scopeValue(point.t, "s")}`
  }

  return (
    <div data-component="scope-waveform" ref={(element) => { container = element }}>
      <div data-slot="scale-strip" class="ydbg-mono">
        <div><span>{t("horizontal")}</span><strong>{scopeValue(span() / 10, "s")}<small>/div</small></strong></div>
        <div><span>{t("vertical")}</span><strong>{scopeValue(axis().division, unit())}<small>/div</small></strong></div>
        <span data-slot="resolution">{preview() ? t("preview") : traces().some((channel) => !channel.exact) ? t("envelope") : t("samples")}</span>
      </div>
      <div data-slot="plot" aria-busy={s.loading} data-dragging={s.dragging}>
        <canvas ref={(element) => { canvas = element }} aria-label={t("canvas")} style={{ height: `${height()}px` }} tabIndex={0}
          onWheel={(e) => {
            e.preventDefault()
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) { pan(e.deltaX / plotWidth(), SETTLE_MS); return }
            const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height() : 1)
            zoom(Math.exp(Math.max(-0.6, Math.min(0.6, delta * 0.003))), xFraction(e.clientX), SETTLE_MS)
          }}
          onKeyDown={(e) => {
            if (e.key === "+" || e.key === "=") zoom(0.5)
            else if (e.key === "-") zoom(2)
            else if (e.key === "ArrowLeft") pan(-0.15)
            else if (e.key === "ArrowRight") pan(0.15)
            else if (e.key === "Home") fit()
            else return
            e.preventDefault()
          }}
          onDblClick={fit} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />
        <Show when={s.loading}><span data-slot="loading">{t("loading")}</span></Show>
        <Show when={s.data && !traces().length}><span data-slot="loading">{t("chooseChannel")}</span></Show>
      </div>
      <div data-slot="controls">
        <div data-slot="actions">
          <button type="button" onClick={() => pan(-0.3)} disabled={!s.data} aria-label={t("panLeft")} title={t("panLeft")}>←</button>
          <button type="button" onClick={() => pan(0.3)} disabled={!s.data} aria-label={t("panRight")} title={t("panRight")}>→</button>
          <button type="button" onClick={() => zoom(0.5)} disabled={!s.data} aria-label={t("zoomIn")} title={t("zoomIn")}>+</button>
          <button type="button" onClick={() => zoom(2)} disabled={!s.data} aria-label={t("zoomOut")} title={t("zoomOut")}>−</button>
          <button type="button" onClick={fit} disabled={!s.data}>{t("fit")}</button>
        </div>
        <div data-slot="actions">
          <button type="button" aria-pressed={s.cursor === "A"} onClick={() => setS("cursor", "A")}>{t("cursorA")}</button>
          <button type="button" aria-pressed={s.cursor === "B"} onClick={() => setS("cursor", "B")}>{t("cursorB")}</button>
          <button type="button" disabled={s.cursorA === undefined && s.cursorB === undefined} onClick={() => setS({ cursorA: undefined, cursorB: undefined })}>{t("clear")}</button>
        </div>
      </div>
      <div data-slot="channels">
        <For each={props.capture.channels}>{(channel) => (
          <label style={{ "--scope-channel": SCOPE_COLORS[(channel.ch - 1) % SCOPE_COLORS.length] }} data-hidden={s.hidden.includes(channel.ch)}>
            <input type="checkbox" checked={!s.hidden.includes(channel.ch)} onChange={(e) => setS("hidden", e.currentTarget.checked ? s.hidden.filter((ch) => ch !== channel.ch) : [...s.hidden, channel.ch])} />
            <strong>CH{channel.ch}</strong><span>{channel.label || `${scopeValue(channel.vdiv, channel.unit)}/div`}</span>
            <small title={t("captureScale")}>×{channel.probe} · {channel.coupling ?? "—"}</small>
          </label>
        )}</For>
        <Show when={units().length > 1}>
          <label>{t("axisUnit")} <select value={unit()} onChange={(e) => setS("unit", e.currentTarget.value)}><For each={units()}>{(value) => <option value={value}>{value}</option>}</For></select></label>
        </Show>
      </div>
      <Show when={s.error}><div data-slot="error" role="alert">{s.error}</div></Show>
      <div data-slot="readout" class="ydbg-mono">
        <span data-cursor="A">A <strong>{s.cursorA === undefined ? "—" : scopeValue(s.cursorA, "s")}</strong></span>
        <span data-cursor="B">B <strong>{s.cursorB === undefined ? "—" : scopeValue(s.cursorB, "s")}</strong></span>
        <span>Δt <strong>{s.cursorA === undefined || s.cursorB === undefined ? "—" : scopeValue(s.cursorB - s.cursorA, "s")}</strong></span>
        <Show when={s.cursorA !== undefined && s.cursorB !== undefined && s.cursorA !== s.cursorB}><span>1/|Δt| <strong>{scopeValue(1 / Math.abs(s.cursorB! - s.cursorA!), "Hz")}</strong></span></Show>
      </div>
      <Show when={s.cursorA !== undefined || s.cursorB !== undefined}>
        <div data-slot="cursor-table" role="region" aria-label={t("cursorReadings")} tabIndex={0}><table><thead><tr><th>{t("channel")}</th><th>A</th><th>B</th><th>{t("delta")}</th></tr></thead><tbody>
          <For each={traces()}>{(channel) => {
            const delta = () => {
              const a = readCursor(channel, s.cursorA)
              const b = readCursor(channel, s.cursorB)
              if (!a || !b) return "—"
              return channel.exact ? `${scopeValue(b.min - a.min, channel.unit)} / ${scopeValue(b.t - a.t, "s")}` : t("zoomForDelta")
            }
            return <tr><th style={{ color: SCOPE_COLORS[(channel.ch - 1) % SCOPE_COLORS.length] }}>CH{channel.ch}</th><td>{cursorText(channel, s.cursorA)}</td><td>{cursorText(channel, s.cursorB)}</td><td>{delta()}</td></tr>
          }}</For>
        </tbody></table></div>
      </Show>
      <div data-slot="view-range" class="ydbg-mono"><span>{t("view")}</span><strong>{scopeValue(from(), "s")} … {scopeValue(to(), "s")}</strong></div>
      <div data-slot="gesture-hint"><span>{t("navigationHint")}</span><span>{t("cursorHint")}</span></div>
    </div>
  )
}
