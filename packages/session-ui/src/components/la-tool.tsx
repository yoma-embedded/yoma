/**
 * la 卡片 —— "总线上到底跑了什么"。
 *
 * 折叠态:`● 逻辑分析仪 import captures/imu-i2c.dsl · 131k @ 25 MHz · 16 ch`。
 * 展开态:details 里那份 1024 列 × 2bit 的预览画成缩略波形 + 采集读数 + 通道表。
 *
 * **画法是共用的**(`la-preview.ts` 的 `paintLanes` / `foldedPreviewRows`)—— 右栏的
 * 波形面板走的是同一个函数。读法有第二份的后果不是报错,是一张看起来很合理的假波形。
 */
import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { LA_CONTRACT } from "@yoma-desktop/kernel/tools/la/contract"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { GenericTool } from "./basic-tool"
import { formatCount, shortPath } from "./hw-format"
import { HwNote, HwRaw, HwReadout, HwReadouts, HwSection, HwTool, type HwState } from "./hw-tool"
import { describeLa, laConclusion, type LaCard } from "./la-card"
import {
  cssTokenReader,
  foldedPreviewRows,
  formatFreq,
  formatSamples,
  formatTime,
  observeColorScheme,
  paintLanes,
  sizeCanvas,
  type LaChannel,
} from "./la-preview"
import type { ToolProps } from "./message-part"

/** 一条泳道 11px:卡片是缩略图,16 通道要能一眼看完而不是变成一堵墙。 */
const LANE_H = 11
/** 通道名那一栏。 */
const LABEL_W = 56
/** 缩略图最多画这么多通道,其余在通道表里列。 */
const MAX_LANES = 16

function Thumbnail(props: { card: LaCard; onRendered?: () => void }) {
  let canvas: HTMLCanvasElement | undefined
  let host: HTMLDivElement | undefined
  let width = 0

  const lanes = createMemo(() => props.card.channels.slice(0, MAX_LANES))
  const height = () => Math.max(LANE_H, lanes().length * LANE_H)

  const draw = () => {
    const preview = props.card.preview
    if (!canvas || !host || !preview) return
    const w = Math.max(1, Math.floor(host.clientWidth - LABEL_W))
    if (w <= 1) return
    const changed = w !== width
    width = w
    const ctx = sizeCanvas(canvas, w, height())
    if (!ctx) return
    // 主题色只能在画的那一刻读:canvas 的像素不参与 CSS 级联。
    const token = cssTokenReader(host)
    const trace = token("--bench-active", "#37a8b6")
    const line = token("--bench-line", "#ccc")
    paintLanes(ctx, foldedPreviewRows(preview, lanes(), w), {
      x: 0,
      y: 0,
      width: w,
      laneHeight: LANE_H,
      pad: 3,
      trace,
      lineWidth: 1.2,
      separator: line,
    })
    if (changed) props.onRendered?.()
  }

  onMount(() => {
    draw()
    // 卡片刚展开时容器宽度可能还是 0(动画在跑),补一帧。
    const frame = requestAnimationFrame(draw)
    onCleanup(() => cancelAnimationFrame(frame))
    if (typeof ResizeObserver === "function" && host) {
      const observer = new ResizeObserver(() => draw())
      observer.observe(host)
      onCleanup(() => observer.disconnect())
    }
  })
  createEffect(draw)
  onCleanup(observeColorScheme(() => draw()))

  return (
    <div data-component="hw-la-preview" ref={host}>
      <div data-slot="names" style={{ width: `${LABEL_W}px` }}>
        <For each={lanes()}>
          {(channel: LaChannel) => (
            <span data-slot="name" style={{ height: `${LANE_H}px` }}>
              <span data-slot="d">D{channel.index}</span>
              {channel.name !== String(channel.index) ? channel.name : ""}
            </span>
          )}
        </For>
      </div>
      <canvas ref={canvas} data-slot="canvas" aria-label="logic analyzer preview" />
    </div>
  )
}

export function LaTool(props: ToolProps) {
  const i18n = useI18n()
  const card = createMemo(() => describeLa(props.input, props.metadata, props.output))
  const running = () => props.status === "pending" || props.status === "running"

  const state = (hit: LaCard): HwState => {
    if (running() || hit.armed) return "active"
    if (hit.timedOut) return "warn"
    if (hit.issues) return "attention"
    return hit.captureId ? "ok" : "idle"
  }

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <HwTool
          {...props}
          trigger={{
            state: state(hit()),
            label: LA_CONTRACT.label,
            action: LA_CONTRACT.summary(props.input ?? {}) || (hit().action ?? LA_CONTRACT.name),
            conclusion: running() ? undefined : laConclusion(hit()),
          }}
        >
          <Show when={hit().preview && hit().channels.length > 0}>
            <HwSection
              title={i18n.t("ui.tool.la.preview")}
              meta={hit().durationMs !== undefined ? formatTime(hit().durationMs! / 1000) : undefined}
            >
              <Thumbnail card={hit()} onRendered={props.onContentRendered} />
              <HwNote>{i18n.t("ui.tool.la.previewNote")}</HwNote>
            </HwSection>
          </Show>

          <HwSection title={i18n.t("ui.tool.hw.readout")} meta={hit().captureId}>
            <HwReadouts>
              <Show when={hit().samplerate !== undefined}>
                <HwReadout k={i18n.t("ui.tool.la.samplerate")} v={formatFreq(hit().samplerate!)} />
              </Show>
              <Show when={hit().samples !== undefined}>
                <HwReadout
                  k={i18n.t("ui.tool.la.samples")}
                  v={`${formatSamples(hit().samples!)}  (${formatCount(hit().samples!)})`}
                />
              </Show>
              <Show when={hit().durationMs !== undefined}>
                {/* 毫秒级的采集窗口要按仪器的量级说话:5.2429 ms,不是"5 ms" */}
                <HwReadout k={i18n.t("ui.tool.la.duration")} v={formatTime(hit().durationMs! / 1000)} />
              </Show>
              <Show when={hit().channels.length > 0}>
                <HwReadout k={i18n.t("ui.tool.la.channels")} v={String(hit().channels.length)} />
              </Show>
              <Show when={hit().triggerPos !== undefined}>
                <HwReadout k={i18n.t("ui.tool.la.trigger")} v={formatCount(hit().triggerPos!)} />
              </Show>
              <Show when={hit().window}>
                <HwReadout
                  k={i18n.t("ui.tool.la.window")}
                  v={`${formatCount(hit().window!.from)} … ${formatCount(hit().window!.to)}`}
                />
              </Show>
              <For each={hit().decoders}>
                {(decoder) => (
                  <HwReadout
                    k={`${decoder.key} = ${decoder.id}`}
                    v={i18n.t("ui.tool.la.annotations", { count: formatCount(decoder.annotations) })}
                  />
                )}
              </For>
              <Show when={hit().device?.model}>
                <HwReadout k={i18n.t("ui.tool.la.device")} v={hit().device!.model!} />
              </Show>
            </HwReadouts>
            <Show when={hit().named.length > 0}>
              <HwNote>
                {hit()
                  .named.map((channel) => `D${channel.index} ${channel.name}`)
                  .join("   ")}
              </HwNote>
            </Show>
            {/* 原始样本永远在这个目录里,卡片只带摘要 + 预览。 */}
            <Show when={hit().dir}>
              <HwNote>
                {i18n.t("ui.tool.la.saved")} {shortPath(hit().dir!, 3)}
              </HwNote>
            </Show>
          </HwSection>

          {/* la 的输出是一张对齐的表(每通道一行),所以不换行 —— 换行会把列打散。 */}
          <Show when={typeof props.output === "string" && props.output.length > 0}>
            <HwRaw text={props.output!} label={i18n.t("ui.tool.hw.output")} open={!hit().preview} />
          </Show>
        </HwTool>
      )}
    </Show>
  )
}
