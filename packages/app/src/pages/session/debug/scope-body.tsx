import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ScopeCaptureInfo } from "@yoma-desktop/kernel"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { ImagePreview } from "@yoma-desktop/ui/image-preview"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { kernel } from "@/utils/kernel"
import { ScopeWaveform } from "./scope-waveform"
import { scopeValue } from "./scope-waveform-data"

const stamp = (time: number) => new Date(time).toLocaleString()
const modeLabel = (mode: string) => mode === "single" ? "单次触发采集" : mode === "current" ? "读取当前记录" : "保存的记录"

/** Disk-backed history, deliberately independent of the current USB connection. */
export function ScopeBody() {
  const sdk = useSDK()
  const server = useServerSDK()
  const dialog = useDialog()
  const [s, setS] = createStore<{
    captures: ScopeCaptureInfo[]; picked?: ScopeCaptureInfo; loading: boolean; error?: string
    image?: { url: string; createdAt: number }; imageLoading: boolean; imageError?: string
  }>({ captures: [], loading: false, imageLoading: false })
  let seq = 0
  let imageSeq = 0
  let disposed = false
  let picker: HTMLSelectElement | undefined
  const completed = new Set<string>()

  const refresh = async () => {
    const directory = sdk().directory
    if (!directory) return
    const mine = ++seq
    setS({ loading: true, error: undefined })
    try {
      const captures = await kernel.scope.captures(directory)
      if (disposed || mine !== seq) return
      // Retain a missing selection so deleting a historical file never silently substitutes new evidence.
      const picked = s.picked ? captures.find((capture) => capture.dir === s.picked?.dir) ?? s.picked : captures[0]
      setS({ captures, picked, loading: false })
    } catch (error) {
      if (disposed || mine !== seq) return
      setS({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  createEffect(on(() => sdk().directory, () => {
    completed.clear()
    setS({ captures: [], picked: undefined, image: undefined, error: undefined })
    void refresh()
  }))
  onCleanup(server().event.listen((event) => {
    if (event.type !== "message.part.updated" || event.part.type !== "tool") return
    const part = event.part
    if (part.tool !== "scope" || part.state.status !== "completed") return
    if (part.state.metadata.directory !== sdk().directory || completed.has(part.id)) return
    if (!["capture", "collect", "screenshot"].includes(String(part.state.input.action))) return
    completed.add(part.id)
    if (completed.size > 1000) completed.delete(completed.values().next().value!)
    void refresh()
  }))
  createEffect(on(() => s.picked?.dir, () => {
    imageSeq++
    setS({ image: undefined, imageLoading: false, imageError: undefined })
  }))
  onCleanup(() => { disposed = true; seq++; imageSeq++ })

  const missing = createMemo(() => !!s.picked && !s.captures.some((capture) => capture.dir === s.picked!.dir))
  // Replacing option nodes can make the browser select its first option even if picked.dir is unchanged.
  createEffect(on(() => [s.captures, s.picked?.dir], () => {
    queueMicrotask(() => { if (!disposed && picker) picker.value = s.picked?.dir ?? "" })
  }))
  const readImage = async () => {
    const dir = s.picked?.dir
    if (!dir) return
    const mine = ++imageSeq
    setS({ imageLoading: true, imageError: undefined })
    try {
      const image = await kernel.scope.screenshot(dir)
      if (disposed || mine !== imageSeq) return
      if (!image || !image.url.startsWith("data:image/png;base64,")) throw new Error("这份采集没有可读取的截图")
      setS({ image, imageLoading: false })
    } catch (error) {
      if (disposed || mine !== imageSeq) return
      setS({ image: undefined, imageLoading: false, imageError: error instanceof Error ? error.message : String(error) })
    }
  }
  const label = (capture: ScopeCaptureInfo) => `${stamp(capture.createdAt)} · ${capture.id}`

  return (
    <div data-component="scope-body">
      <div class="ydbg-win-meta">
        <select ref={(element) => { picker = element }} aria-label="选择示波器历史采集" value={s.picked?.dir ?? ""} onChange={(event) => setS("picked", s.captures.find((capture) => capture.dir === event.currentTarget.value))} disabled={!s.captures.length && !s.picked}>
          <Show when={missing()}><option value={s.picked?.dir} selected>{s.picked?.id}（文件已缺失）</option></Show>
          <For each={s.captures}>{(capture) => <option value={capture.dir} selected={capture.dir === s.picked?.dir}>{label(capture)}</option>}</For>
        </select>
        <button type="button" onClick={() => void refresh()} disabled={s.loading}>刷新历史</button>
      </div>
      <Show when={s.error}><div data-slot="error" role="alert">采集列表读取失败：{s.error}</div></Show>
      <Show when={s.picked} fallback={<div class="ydbg-win-caption">{s.loading ? "读取保存的采集…" : "还没有示波器采集。让 agent 使用 scope 连接仪器并采集；已有波形保存后，拔掉 USB 也能在这里查看。"}</div>}>
        {(capture) => (
          <>
            <div data-slot="identity">{capture().model ?? "示波器"}{capture().serial ? ` · SN ${capture().serial}` : ""} · 历史采集 {stamp(capture().createdAt)}</div>
            <div data-slot="acquisition">
              <span>{modeLabel(capture().mode)}</span>
              <span>触发状态（采集时）{capture().trigger?.status ?? "未记录"}</span>
              <span>{capture().quality === "overview" ? "概览抽样：不能排除采样间的毛刺" : "保存了所取时窗的连续采样点"}</span>
            </div>
            <div data-slot="sampling" class="ydbg-mono"><For each={capture().channels}>{(channel) => (
              <span>C{channel.ch} · 已存 {channel.points.toLocaleString()} / 记录 {channel.recordPoints.toLocaleString()} 点 · {scopeValue(channel.interval, "s")}/点 · {channel.stride === 1 ? "未抽样" : `每 ${channel.stride} 点取 1 点`}</span>
            )}</For></div>
            <Show when={!missing()} fallback={<div data-slot="error" role="alert">这份历史采集的文件已缺失或损坏：{capture().dir}。请选择另一份采集，或恢复原始文件。</div>}>
              <ScopeWaveform capture={capture()} />
              <Show when={capture().screenshot} fallback={<div class="ydbg-win-caption">这份采集未关联仪器截图。</div>}>
                <div data-slot="screen">
                  <button type="button" onClick={() => void readImage()} disabled={s.imageLoading}>{s.imageLoading ? "读取截图…" : s.image ? "重新读取截图" : "查看仪器截图"}</button>
                  <Show when={s.image}>{(image) => (
                    <figure>
                      <button type="button" class="scope-screen-image" onClick={() => dialog.show(() => <ImagePreview src={image().url} alt="示波器仪器截图" />)} aria-label="放大仪器截图">
                        <img src={image().url} alt="示波器仪器截图" onError={() => setS({ image: undefined, imageError: "截图文件无法显示" })} />
                      </button>
                      <figcaption>截图时间 {stamp(image().createdAt)}。截图是仪器屏幕图像；上方波形来自保存的采样数据。</figcaption>
                    </figure>
                  )}</Show>
                  <Show when={s.imageError}><div data-slot="error" role="alert">{s.imageError}</div></Show>
                </div>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
