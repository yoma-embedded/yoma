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
import { useScopeCopy } from "./scope-copy"

const stamp = (time: number) => new Date(time).toLocaleString()

/** Disk-backed history, deliberately independent of the current USB connection. */
export function ScopeBody() {
  const t = useScopeCopy()
  const modeLabel = (mode: string) => t(mode === "single" ? "single" : mode === "current" ? "current" : "saved")
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
      if (!image || !image.url.startsWith("data:image/png;base64,")) throw new Error(t("noReadableScreenshot"))
      setS({ image, imageLoading: false })
    } catch (error) {
      if (disposed || mine !== imageSeq) return
      setS({ image: undefined, imageLoading: false, imageError: error instanceof Error ? error.message : String(error) })
    }
  }
  const label = (capture: ScopeCaptureInfo) => `${capture.model ?? t("instrument")} · ${stamp(capture.createdAt)}`

  return (
    <div data-component="scope-body">
      <div class="ydbg-win-meta" data-slot="history-toolbar">
        <span data-slot="read-only" title={t("history")}>{t("readOnly")}</span>
        <select ref={(element) => { picker = element }} aria-label={t("select")} value={s.picked?.dir ?? ""} onChange={(event) => setS("picked", s.captures.find((capture) => capture.dir === event.currentTarget.value))} disabled={!s.captures.length && !s.picked}>
          <Show when={missing()}><option value={s.picked?.dir} selected>{s.picked?.id} ({t("missingOption")})</option></Show>
          <For each={s.captures}>{(capture) => <option value={capture.dir} selected={capture.dir === s.picked?.dir}>{label(capture)}</option>}</For>
        </select>
        <button type="button" onClick={() => void refresh()} disabled={s.loading}>{t("refresh")}</button>
      </div>
      <Show when={s.error}><div data-slot="error" role="alert">{t("listError")}: {s.error}</div></Show>
      <Show when={s.picked} fallback={<div data-slot="empty"><strong>{t("emptyTitle")}</strong><p>{s.loading ? t("reading") : t("empty")}</p><span>{t("emptyHelp")}</span></div>}>
        {(capture) => (
          <>
            <Show when={capture().quality === "overview"}><div data-slot="quality-warning">{t("overview")}</div></Show>
            <Show when={!missing()} fallback={<div data-slot="error" role="alert">{t("missing")}: {capture().dir}。{t("restore")}</div>}>
              <ScopeWaveform capture={capture()} />
              <details data-slot="capture-details">
                <summary>{t("history")} · {t("sampling")}</summary>
                <div data-slot="identity"><strong>{capture().model ?? t("instrument")}</strong><span>{capture().serial ? `SN ${capture().serial}` : ""}</span></div>
                <div data-slot="acquisition">
                  <span data-slot="quality" data-quality={capture().quality}>{t(capture().quality === "overview" ? "overview" : "exact")}</span>
                  <span>{modeLabel(capture().mode)}</span>
                  <span>{t("trigger")}{capture().trigger?.status ?? t("unknown")}</span>
                  <Show when={capture().trigger?.source}><span>{capture().trigger?.source} · {capture().trigger?.slope ?? ""}</span></Show>
                </div>
                <div data-slot="sampling" class="ydbg-mono"><For each={capture().channels}>{(channel) => (
                  <div><strong style={{ color: `var(--bench-ch${Math.max(1, Math.min(4, channel.ch))})` }}>CH{channel.ch}</strong>
                    <span>{t("stored")} {channel.points.toLocaleString()} / {t("record")} {channel.recordPoints.toLocaleString()} {t("points")}</span>
                    <span>{scopeValue(channel.interval, "s")}/{t("points")} · {scopeValue(1 / channel.interval, "Hz")}</span>
                    <span>{channel.stride === 1 ? t("unthinned") : t("stride", { stride: channel.stride })}</span>
                    <span>{t("captureScale")} {scopeValue(channel.vdiv, channel.unit)}/div · {channel.coupling ?? "—"} · ×{channel.probe}</span>
                    <Show when={channel.clipped && (channel.clipped.low > 0 || channel.clipped.high > 0)}><span data-slot="clipped">{t("clipping")}</span></Show>
                  </div>
                )}</For></div>
              </details>
              <Show when={capture().screenshot} fallback={<div class="ydbg-win-caption">{t("noScreenshot")}</div>}>
                <div data-slot="screen">
                  <button type="button" onClick={() => void readImage()} disabled={s.imageLoading}>{s.imageLoading ? t("readingScreenshot") : s.image ? t("rereadScreenshot") : t("readScreenshot")}</button>
                  <Show when={s.image}>{(image) => (
                    <figure>
                      <button type="button" class="scope-screen-image" onClick={() => dialog.show(() => <ImagePreview src={image().url} alt={t("screenshot")} />)} aria-label={t("enlargeScreenshot")}>
                        <img src={image().url} alt={t("screenshot")} onError={() => setS({ image: undefined, imageError: t("screenshotError") })} />
                      </button>
                      <figcaption>{t("screenshotTime")} {stamp(image().createdAt)}。{t("screenshotHint")}</figcaption>
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
