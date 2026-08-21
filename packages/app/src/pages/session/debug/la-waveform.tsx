/**
 * 逻辑分析仪波形面板 —— dock"调试"档里的真仪器。
 *
 * 数据来自内核的 la.view RPC:Node 侧按视口列数做列聚合(每列 2bit:有高 / 有低)并按窗口裁注解,
 * 跨进程一次几十 KB;这里只负责画和交互。渲染是 Canvas2D 按列画(复杂度 = 视口像素宽 × 通道数,
 * 与采样总数无关),通道名 / 游标读数 / 工具条是 DOM。
 *
 * 纪律(CLAUDE.md「逻辑分析仪」):不走 file.read、不把样本塞 details;绘制是 (data, size, theme)
 * 的纯函数,组件被卸载重建照样能画回来;缩放 / 游标状态在 createStore 里。
 *
 * **线格式与画法不在这里**:2bit 列的解码在内核的 `la-codec.ts`(host 也要用),泳道画法与
 * 取色在 session-ui 的 `la-preview.ts` —— 卡片(transcript 里的 la 缩略图)与这台仪器共用同一份,
 * 否则同一份采集在两处会画成两个样子,而且只有人眼看得出来。
 */
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  decodeColumns,
  foldColumns,
  formatFreq,
  formatSamples,
  formatTime,
  type LaCaptureInfo,
  type LaViewLaneItem,
  type LaViewResult,
} from "@yoma-desktop/kernel"
import { cssTokenReader, observeColorScheme, paintLanes, sizeCanvas } from "@yoma-desktop/session-ui/la-preview"
import { kernel } from "@/utils/kernel"
import { useSDK } from "@/context/sdk"

const LANE_H = 20
const ANN_H = 18
const AXIS_H = 18
const LABEL_W = 64
const MIN_SPAN = 32

/** 注解里"这条不对劲"的判定。只在 la.view 结果落地时跑一次 —— 放进 draw 就是每次拖游标、
 *  每次换主题都把两条正则在几百条注解上重跑一遍。 */
const BAD_CLASS = /nack|err|warn|invalid|missing/i
const BAD_TEXT = /error|warning/i

interface LaneItemView extends LaViewLaneItem {
  bad: boolean
}
interface LaneView extends Omit<LaViewResult["lanes"][number], "items"> {
  items: LaneItemView[]
}
/** 画之前就摊平好的视图:掩码按通道解好(只跟 columns 有关),bad 标好。 */
interface ViewData extends Omit<LaViewResult, "lanes"> {
  lanes: LaneView[]
  masks: Uint8Array[]
}

function prepare(result: LaViewResult): ViewData {
  return {
    ...result,
    masks: result.channels.map((channel) => decodeColumns(channel.bits, result.columns)),
    lanes: result.lanes.map((lane) => ({
      ...lane,
      items: lane.items.map((item) => ({ ...item, bad: BAD_CLASS.test(item.cls) || BAD_TEXT.test(item.text) })),
    })),
  }
}

interface ViewState {
  width: number
  from: number
  to: number
  total: number
  sr: number
  data?: ViewData
  loading: boolean
  error?: string
  cursorA?: number
  cursorB?: number
  seq: number
}

/** 时间轴刻度:1-2-5 序列,目标间距 ~90px。 */
function ticks(from: number, to: number, sr: number, width: number): { x: number; label: string }[] {
  const spanS = (to - from) / sr
  const target = spanS / Math.max(1, width / 90)
  const pow = 10 ** Math.floor(Math.log10(target))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? pow * 10
  const out: { x: number; label: string }[] = []
  const startS = Math.ceil(from / sr / step) * step
  for (let t = startS; t <= to / sr; t += step) {
    const x = ((t * sr - from) / (to - from)) * width
    out.push({ x, label: formatTime(t) })
    if (out.length > 64) break
  }
  return out
}

export function LaWaveform(props: { dir: string }) {
  const [s, setS] = createStore<ViewState>({
    width: 0,
    from: 0,
    to: 0,
    total: 0,
    sr: 0,
    loading: false,
    seq: 0,
  })
  let container!: HTMLDivElement
  let canvas!: HTMLCanvasElement

  const height = createMemo(
    () => AXIS_H + (s.data?.channels.length ?? 0) * LANE_H + (s.data?.lanes.length ?? 0) * ANN_H + 4,
  )

  // ---- 取数 ----------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = (from: number | undefined, to: number | undefined) => {
    const dir = props.dir
    const columns = Math.max(16, Math.min(4096, Math.floor(s.width)))
    if (!dir || columns < 16) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const seq = s.seq + 1
      setS({ loading: true, seq })
      try {
        const result = await kernel.la.view({ dir, from, to, columns })
        if (seq !== s.seq) return
        setS({
          data: prepare(result),
          from: result.from,
          to: result.to,
          total: result.totalSamples,
          sr: result.samplerate,
          loading: false,
          error: undefined,
        })
      } catch (error) {
        if (seq !== s.seq) return
        setS({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    }, 30)
  }

  createEffect(() => {
    // 换采集 → 全程
    const dir = props.dir
    void dir
    setS({ cursorA: undefined, cursorB: undefined, data: undefined })
    request(undefined, undefined)
  })

  createResizeObserver(
    () => container,
    () => {
      const w = Math.floor(container.clientWidth - LABEL_W)
      if (w === s.width) return
      setS("width", w)
      request(s.to > s.from ? s.from : undefined, s.to > s.from ? s.to : undefined)
    },
  )

  // ---- 绘制 ----------------------------------------------------------------
  const draw = () => {
    const data = s.data
    if (!canvas || !data) return
    const w = s.width
    const h = height()
    const ctx = sizeCanvas(canvas, w, h)
    if (!ctx) return
    // 一次 getComputedStyle 读全部 token:一个 token 一次调用时,每次重绘都在强算样式。
    const token = cssTokenReader(container)
    const ink = token("--d-ink", "#222")
    const muted = token("--d-muted", "#888")
    const line = token("--d-line", "#ccc")
    const accent = token("--d-accent", "#37a8b6")
    const warn = token("--d-warn", "#c08a2e")
    const fail = token("--d-fail", "#d5544a")
    const panel2 = token("--d-panel-2", "#f3f3f3")
    const mono = token("--d-mono", "monospace")
    const span = data.to - data.from
    const xOf = (sample: number) => ((sample - data.from) / span) * w

    // 时间轴
    ctx.font = `10px ${mono}`
    ctx.fillStyle = muted
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    for (const t of ticks(data.from, data.to, data.samplerate, w)) {
      ctx.beginPath()
      ctx.moveTo(Math.round(t.x) + 0.5, AXIS_H - 4)
      ctx.lineTo(Math.round(t.x) + 0.5, h)
      ctx.globalAlpha = 0.35
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillText(t.label, t.x + 3, 11)
    }

    // 通道:列掩码折到像素之后交给共用画法(卡片缩略图走的是同一个函数)。
    paintLanes(
      ctx,
      data.masks.map((masks) => foldColumns(masks, w)),
      { x: 0, y: AXIS_H, width: w, laneHeight: LANE_H, pad: 4, trace: accent, lineWidth: 1.4, separator: line },
    )

    // 注解泳道
    let y = AXIS_H + data.channels.length * LANE_H
    ctx.font = `10px ${mono}`
    for (const lane of data.lanes) {
      ctx.fillStyle = panel2
      ctx.fillRect(0, y, w, ANN_H)
      for (const it of lane.items) {
        const x1 = Math.max(0, xOf(it.s))
        const x2 = Math.min(w, xOf(it.e + 1))
        const bw = Math.max(1, x2 - x1)
        ctx.fillStyle = it.bad ? fail : accent
        ctx.globalAlpha = it.bad ? 0.55 : 0.28
        ctx.fillRect(x1, y + 2, bw, ANN_H - 4)
        ctx.globalAlpha = 1
        if (bw > 14) {
          ctx.fillStyle = ink
          const label = bw > 60 ? it.text : it.short
          ctx.save()
          ctx.beginPath()
          ctx.rect(x1 + 1, y, bw - 2, ANN_H)
          ctx.clip()
          ctx.fillText(label, x1 + 3, y + ANN_H - 5)
          ctx.restore()
        }
      }
      if (lane.truncated) {
        ctx.fillStyle = warn
        ctx.fillText(`…${lane.total - lane.items.length} more`, w - 70, y + ANN_H - 5)
      }
      y += ANN_H
    }

    // 触发位置
    if (data.triggerPos !== undefined && data.triggerPos >= data.from && data.triggerPos < data.to) {
      ctx.strokeStyle = warn
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(Math.round(xOf(data.triggerPos)) + 0.5, 0)
      ctx.lineTo(Math.round(xOf(data.triggerPos)) + 0.5, h)
      ctx.stroke()
      ctx.setLineDash([])
    }
    // 游标
    for (const [c, color] of [
      [s.cursorA, ink],
      [s.cursorB, fail],
    ] as const) {
      if (c === undefined || c < data.from || c >= data.to) continue
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(xOf(c)) + 0.5, 0)
      ctx.lineTo(Math.round(xOf(c)) + 0.5, h)
      ctx.stroke()
    }
  }
  createEffect(() => {
    // 依赖:data / 游标 / 宽度
    void s.data
    void s.cursorA
    void s.cursorB
    void s.width
    requestAnimationFrame(draw)
  })
  // canvas 里没有 CSS 级联:换明暗必须自己重画。
  onCleanup(observeColorScheme(() => draw()))
  onCleanup(() => clearTimeout(timer))

  // ---- 交互 ----------------------------------------------------------------
  const sampleAt = (clientX: number) => {
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    return s.from + (x / Math.max(1, rect.width)) * (s.to - s.from)
  }
  const zoomAt = (clientX: number, factor: number) => {
    if (!s.data) return
    const rect = canvas.getBoundingClientRect()
    const fx = (clientX - rect.left) / Math.max(1, rect.width)
    const span = s.to - s.from
    let next = Math.round(span * factor)
    next = Math.max(MIN_SPAN, Math.min(s.total, next))
    const anchor = s.from + fx * span
    let from = Math.round(anchor - fx * next)
    from = Math.max(0, Math.min(s.total - next, from))
    request(from, from + next)
  }
  let drag: { x: number; from: number; to: number; moved: boolean } | undefined
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    zoomAt(e.clientX, e.deltaY > 0 ? 1.25 : 0.8)
  }
  const onPointerDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId)
    drag = { x: e.clientX, from: s.from, to: s.to, moved: false }
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!drag || !s.data) return
    const dx = e.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    if (!drag.moved) return
    const span = drag.to - drag.from
    const rect = canvas.getBoundingClientRect()
    let from = Math.round(drag.from - (dx / Math.max(1, rect.width)) * span)
    from = Math.max(0, Math.min(s.total - span, from))
    request(from, from + span)
  }
  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return
    const moved = drag.moved
    drag = undefined
    if (moved) return
    const at = Math.round(sampleAt(e.clientX))
    if (e.shiftKey) setS("cursorB", at)
    else setS("cursorA", at)
  }

  const delta = createMemo(() => {
    if (s.cursorA === undefined || s.cursorB === undefined || !s.sr) return undefined
    const d = Math.abs(s.cursorB - s.cursorA) / s.sr
    return { d, f: d > 0 ? 1 / d : 0 }
  })

  return (
    <div data-component="la-waveform" ref={container}>
      <div data-slot="bar">
        <span class="ydbg-mono" data-slot="range">
          {s.sr ? `${formatTime(s.from / s.sr)} … ${formatTime(s.to / s.sr)}  (${(s.to - s.from).toLocaleString()} / ${s.total.toLocaleString()} 采样 @ ${formatFreq(s.sr)})` : s.loading ? "读取中…" : ""}
        </span>
        <span data-slot="actions">
          <button type="button" onClick={() => zoomAt(canvas.getBoundingClientRect().left + s.width / 2, 0.5)} title="放大">+</button>
          <button type="button" onClick={() => zoomAt(canvas.getBoundingClientRect().left + s.width / 2, 2)} title="缩小">−</button>
          <button type="button" onClick={() => request(undefined, undefined)} title="全程">全程</button>
          <Show when={s.cursorA !== undefined || s.cursorB !== undefined}>
            <button type="button" onClick={() => setS({ cursorA: undefined, cursorB: undefined })} title="清除游标">
              清游标
            </button>
          </Show>
        </span>
      </div>
      <Show when={s.error}>
        <div data-slot="error">{s.error}</div>
      </Show>
      <div data-slot="plot" style={{ height: `${height()}px` }}>
        <div data-slot="labels" style={{ width: `${LABEL_W}px`, "padding-top": `${AXIS_H}px` }}>
          <For each={s.data?.channels ?? []}>{(ch) => <div data-slot="label" style={{ height: `${LANE_H}px` }} title={`D${ch.index} · ${ch.edges} 边沿`}>{ch.name || `D${ch.index}`}</div>}</For>
          <For each={s.data?.lanes ?? []}>{(lane) => <div data-slot="label" data-kind="lane" style={{ height: `${ANN_H}px` }} title={`${lane.decoderId} / ${lane.row}`}>{lane.key}{lane.row ? `·${lane.row}` : ""}</div>}</For>
        </div>
        <canvas
          ref={canvas}
          data-slot="canvas"
          style={{ left: `${LABEL_W}px` }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-label="logic analyzer waveform"
        />
      </div>
      <div data-slot="readout" class="ydbg-mono">
        <Show when={s.cursorA !== undefined} fallback={<span>单击放游标 A,Shift+单击放 B;滚轮缩放,拖拽平移</span>}>
          <span>A {formatTime((s.cursorA ?? 0) / (s.sr || 1))}</span>
        </Show>
        <Show when={s.cursorB !== undefined}>
          <span>B {formatTime((s.cursorB ?? 0) / (s.sr || 1))}</span>
        </Show>
        <Show when={delta()}>{(d) => <span>Δ {formatTime(d().d)} · {formatFreq(d().f)}</span>}</Show>
        <Show when={s.data && s.data.lanes.length === 0}>
          <span>这份采集还没解码,卡片里的 la decode 之后这里会出现注解泳道</span>
        </Show>
      </div>
    </div>
  )
}

/** 面板壳:列出工程 .yoma/la 下的采集(内核给的目录 + 元数据),默认最新;交给 LaWaveform 画。 */
export function LaBody() {
  const sdk = useSDK()
  const [s, setS] = createStore<{ captures: LaCaptureInfo[]; picked?: string; loading: boolean; error?: string }>({
    captures: [],
    loading: false,
  })

  // 序号不进 store:refresh 是从 createEffect 里同步调起来的,读 store 里的计数会把它
  // 变成自己的依赖 —— 一次刷新就是一个无限循环。
  let seq = 0
  const refresh = async () => {
    const directory = sdk().directory
    if (!directory) return
    const mine = ++seq
    setS({ loading: true, error: undefined })
    try {
      const captures = await kernel.la.captures(directory)
      if (mine !== seq) return
      setS({
        captures,
        loading: false,
        picked: s.picked && captures.some((c) => c.id === s.picked) ? s.picked : captures[0]?.id,
      })
    } catch (error) {
      if (mine !== seq) return
      setS({ captures: [], loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  createEffect(() => {
    void sdk().directory
    void refresh()
  })

  const picked = createMemo(() => s.captures.find((c) => c.id === s.picked))
  const label = (c: LaCaptureInfo) =>
    [`${c.id} · ${formatSamples(c.samples)} @ ${formatFreq(c.samplerate)}`, c.decoded.join(" ")].filter(Boolean).join(" · ")

  return (
    <div data-component="la-body">
      <div class="ydbg-win-meta">
        <select
          data-slot="pick"
          class="ydbg-mono"
          value={s.picked ?? ""}
          onChange={(e) => setS("picked", e.currentTarget.value)}
          disabled={s.captures.length === 0}
        >
          <For each={s.captures}>{(c) => <option value={c.id}>{label(c)}</option>}</For>
        </select>
        <button type="button" class="ydbg-mono" onClick={() => void refresh()} title="重新列出 .yoma/la">
          ↻
        </button>
      </div>
      <Show when={picked()} fallback={<div class="ydbg-win-caption">{s.loading ? "读取中…" : s.error ? s.error : "还没有采集。让 agent 跑 la capture,或 la import 一份 DSView 存的 .dsl。"}</div>}>
        {(c) => <LaWaveform dir={c().dir} />}
      </Show>
    </div>
  )
}
