/**
 * la(逻辑分析仪 / DreamSourceLab DSLogic)工具卡片。
 *
 * 内核的 details 只带**摘要与句柄**:原始样本永远在 `<工程>/.yoma/la/<id>/` 的文件里,
 * 卡片能拿到的波形只有 `preview` —— columns 列 × 每通道 2 bit 的缩略图
 * (bit0 = 该列出现过高电平,bit1 = 出现过低电平;01 全高、10 全低、11 该列翻转过)。
 * 于是旧会话重放时波形仍画得出来,即便 `.yoma/la/` 已经被清理。
 *
 * 三条纪律:
 *  - **画布不存模块级状态**。解码、折叠与绘制都在 `./la-preview`(dock 里那台真仪器用的是
 *    同一份),是 (数据, 尺寸, 颜色) → 像素的纯函数,虚拟列表随时卸载/重挂都能原样重画。
 *  - **颜色只能在画的那一刻从主题 token 读**(`getComputedStyle`)。canvas 里没有 CSS,
 *    换主题不会自动重绘 —— 所以还要盯 documentElement 的 `data-color-scheme`。
 *  - **通道名走 DOM 而不是 canvas**:字要跟着系统字体与缩放走,画进位图就糊了,也选不中。
 *
 * 卡片本身没有缩放/平移 —— 那是 dock"调试"档里那台真仪器的事,这里只做缩略图。
 */
import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { LaAction, LaToolDetails } from "@yoma-desktop/kernel"
import { useI18n, type UiI18nKey } from "@yoma-desktop/ui/context/i18n"
import { BasicTool } from "./basic-tool"
import {
  cssTokenReader,
  foldedPreviewRows,
  formatFreq,
  formatSamples,
  formatTime,
  LA_LANE_HEIGHT,
  observeColorScheme,
  paintLanes,
  previewChannels,
  sizeCanvas,
  type LaChannel,
  type LaPreview,
} from "./la-preview"
import { Markdown } from "./markdown"
import type { ToolProps } from "./message-part"

/** 写成 `Record<LaAction, …>`:内核加一个动作而这里没跟上是编译期失败,不是卡片上一行英文原文。 */
export const LA_ACTION_KEYS: Record<LaAction, UiI18nKey> = {
  devices: "ui.tool.la.action.devices",
  capture: "ui.tool.la.action.capture",
  arm: "ui.tool.la.action.arm",
  collect: "ui.tool.la.action.collect",
  stop: "ui.tool.la.action.stop",
  import: "ui.tool.la.action.import",
  list: "ui.tool.la.action.list",
  decoders: "ui.tool.la.action.decoders",
  summary: "ui.tool.la.action.summary",
  decode: "ui.tool.la.action.decode",
  events: "ui.tool.la.action.events",
  timing: "ui.tool.la.action.timing",
  expect: "ui.tool.la.action.expect",
}

export function LaWaveform(props: { preview?: LaPreview; channels: readonly LaChannel[] }) {
  const [state, setState] = createStore({ width: 0, revision: 0 })
  let host: HTMLDivElement | undefined
  let surface: HTMLCanvasElement | undefined

  const height = createMemo(() => Math.max(LA_LANE_HEIGHT, props.channels.length * LA_LANE_HEIGHT))

  const measure = () => {
    if (!host) return
    const width = Math.round(host.clientWidth)
    if (width === state.width) return
    setState("width", width)
  }

  onMount(() => {
    measure()
    onCleanup(observeColorScheme(() => setState("revision", (value) => value + 1)))
  })

  createResizeObserver(
    () => host,
    () => measure(),
  )

  createEffect(
    on(
      () => [state.width, state.revision, props.preview, props.channels] as const,
      () => {
        if (!surface || state.width <= 0) return
        const width = state.width
        const ctx = sizeCanvas(surface, width, height())
        if (!ctx) return
        const token = cssTokenReader(surface)
        paintLanes(ctx, foldedPreviewRows(props.preview, props.channels, width), {
          x: 0,
          y: 0,
          width,
          laneHeight: LA_LANE_HEIGHT,
          pad: 3,
          trace: token("--icon-diff-add-base", "#4c9f70"),
          separator: token("--v2-border-border-base", "#3a3a3a"),
        })
      },
    ),
  )

  return (
    <div data-component="la-waveform">
      <div data-slot="la-waveform-labels">
        <For each={props.channels}>
          {(channel) => (
            <span data-slot="la-waveform-label" style={{ height: `${LA_LANE_HEIGHT}px` }}>
              {channel.name || `D${channel.index}`}
            </span>
          )}
        </For>
      </div>
      <div ref={host} data-slot="la-waveform-surface" style={{ height: `${height()}px` }}>
        <canvas ref={surface} data-slot="la-waveform-canvas" />
      </div>
    </div>
  )
}

interface LaInputView {
  action?: string
  capture?: string
  samplerate?: string
  decoder?: string
  decoders?: { key?: string; id?: string }[]
}

export function LaTool(props: ToolProps) {
  const i18n = useI18n()
  const metadata = () => props.metadata as Partial<LaToolDetails>
  const input = () => props.input as LaInputView

  const action = createMemo(() => metadata().action ?? input().action ?? "")
  const actionLabel = createMemo(() => {
    const value = action()
    const key = LA_ACTION_KEYS[value as LaAction]
    return key ? i18n.t(key) : value
  })
  const captureId = createMemo(() => metadata().captureId ?? input().capture ?? "")
  const channels = createMemo(() => previewChannels(metadata()))
  const decoders = createMemo(() => metadata().decoders ?? [])
  const preview = createMemo(() => metadata().preview)
  const issues = createMemo(() => metadata().issues ?? 0)
  // 0 与 undefined 一样当"没有这一项":KV 行是 `Show when={…}`,写一句 "0 µs" 只是噪声。
  const samplerate = createMemo(() => {
    const hz = metadata().samplerate
    return typeof hz === "number" && hz > 0 ? formatFreq(hz) : ""
  })
  const samples = createMemo(() => {
    const count = metadata().samples
    return typeof count === "number" && count > 0 ? formatSamples(count) : ""
  })
  const duration = createMemo(() => {
    const ms = metadata().durationMs
    return typeof ms === "number" && ms > 0 ? formatTime(ms / 1000) : ""
  })
  const subtitle = createMemo(() => [actionLabel(), captureId()].filter(Boolean).join(" · "))

  const badge = createMemo<{ label: string; tone?: "positive" | "warning" }>(() => {
    if (metadata().timedOut) return { label: i18n.t("ui.tool.la.timedOut"), tone: "warning" }
    if (metadata().armed) return { label: i18n.t("ui.tool.la.armed"), tone: "positive" }
    return { label: "" }
  })

  return (
    <div data-component="la-tool">
      <BasicTool
        {...props}
        icon="sliders"
        defer={props.deferContent !== false}
        trigger={{
          title: i18n.t("ui.tool.la"),
          subtitle: subtitle(),
          action: (
            <Show when={badge().label}>
              <span data-component="tool-badge" data-tone={badge().tone}>
                {badge().label}
              </span>
            </Show>
          ),
        }}
      >
        <div data-component="tool-kv">
          <Show when={captureId()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.capture")}</span>
              <span data-slot="tool-kv-value">{captureId()}</span>
            </div>
          </Show>
          <Show when={samplerate()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.samplerate")}</span>
              <span data-slot="tool-kv-value">{samplerate()}</span>
            </div>
          </Show>
          <Show when={samples()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.samples")}</span>
              <span data-slot="tool-kv-value">{samples()}</span>
            </div>
          </Show>
          <Show when={duration()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.duration")}</span>
              <span data-slot="tool-kv-value">{duration()}</span>
            </div>
          </Show>
          <Show when={channels().length > 0}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.channels")}</span>
              <span data-slot="tool-kv-value">{channels().length}</span>
            </div>
          </Show>
          <Show when={decoders().length > 0}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.decoders")}</span>
              <span data-slot="tool-kv-value">{decoders().length}</span>
            </div>
            <For each={decoders()}>
              {(decoder) => (
                <div data-slot="tool-kv-row" data-scope="la-decoder">
                  <span data-slot="tool-kv-label">{decoder.key || decoder.id}</span>
                  <span data-slot="tool-kv-value">
                    {[decoder.id, i18n.t("ui.tool.la.annotations", { count: decoder.annotations })]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}
            </For>
          </Show>
          <Show when={issues() > 0}>
            <div data-slot="tool-kv-row" data-tone="warning">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.issues")}</span>
              <span data-slot="tool-kv-value">{issues()}</span>
            </div>
          </Show>
          {/* 触发超时只挂在 trigger 的徽章上:KV 里再来一行是同一件事说两遍。 */}
          <Show when={metadata().truncated}>
            <div data-slot="tool-kv-row" data-tone="warning">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.la.truncated")}</span>
              <span data-slot="tool-kv-value" />
            </div>
          </Show>
        </div>
        <Show when={preview() && channels().length > 0}>
          <LaWaveform preview={preview()} channels={channels()} />
        </Show>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    </div>
  )
}
