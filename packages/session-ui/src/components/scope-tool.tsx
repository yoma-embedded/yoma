/**
 * scope(示波器 / Siglent SDS824X HD)工具卡片。
 *
 * 刻意是一张**纯 KV 卡**,没有画布 —— la 那张要画波形是因为它的 details 自带
 * 缩略位图;示波器这边原始样本永远在 `<工程>/.yoma/scope/<id>/` 的文件里,
 * details 只有摘要(时基/采样率/通道设置/统计量/测量项),照着 flash 那张
 * "KV 行 + Markdown 输出"渲染就够,动作徽章照 log 的写法。
 *
 * 截图走 `props.attachments`:工具把 PNG 当图片内容返回,投影器落成 FilePart,
 * 与 datasheet 的 view_figure 同一条路 —— 点开进 ImagePreview 对话框。
 */
import { createMemo, For, Show } from "solid-js"
import {
  formatFreq,
  formatTime,
  type ScopeAction,
  type ScopeChannelDetails,
  type ScopeToolDetails,
} from "@yoma-desktop/kernel"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useI18n, type UiI18nKey } from "@yoma-desktop/ui/context/i18n"
import { ImagePreview } from "@yoma-desktop/ui/image-preview"
import { BasicTool } from "./basic-tool"
import { Markdown } from "./markdown"
import type { ToolProps } from "./message-part"

/** 写成 `Record<ScopeAction, …>`:内核加一个动作而这里没跟上是编译期失败,不是卡片上一行英文原文。 */
export const SCOPE_ACTION_KEYS: Record<ScopeAction, UiI18nKey> = {
  connect: "ui.tool.scope.action.connect",
  status: "ui.tool.scope.action.status",
  setup: "ui.tool.scope.action.setup",
  capture: "ui.tool.scope.action.capture",
  arm: "ui.tool.scope.action.arm",
  collect: "ui.tool.scope.action.collect",
  measure: "ui.tool.scope.action.measure",
  samples: "ui.tool.scope.action.samples",
  screenshot: "ui.tool.scope.action.screenshot",
  list: "ui.tool.scope.action.list",
  raw: "ui.tool.scope.action.raw",
}

/** 去掉无意义的尾零:0.02 → "0.02",3.2999999 → "3.3"。 */
function num(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return Number.parseFloat(value.toPrecision(6)).toString()
}

interface ScopeInputView {
  action?: string
  address?: string
  capture?: string
}

export function ScopeTool(props: ToolProps) {
  const i18n = useI18n()
  const dialog = useDialog()
  const metadata = () => props.metadata as Partial<ScopeToolDetails>
  // details 在结果落地前是空的,入参兜底 —— 流式期卡片才有内容可显。
  const input = () => props.input as ScopeInputView

  const action = createMemo(() => metadata().action ?? input().action ?? "")
  const actionLabel = createMemo(() => {
    const value = action()
    const key = SCOPE_ACTION_KEYS[value as ScopeAction]
    return key ? i18n.t(key) : value
  })
  const address = createMemo(() => metadata().address ?? input().address ?? "")
  const captureId = createMemo(() => metadata().captureId ?? input().capture ?? "")
  const instrument = createMemo(() => [metadata().model, metadata().serial].filter(Boolean).join(" · "))
  const channels = createMemo(() => metadata().channels ?? [])
  const measurements = createMemo(() => metadata().measurements ?? [])
  const attachments = createMemo(() => props.attachments ?? [])

  // 0 与 undefined 一样当"没有这一项":KV 行是 `Show when={…}`,写一句 "0 Hz" 只是噪声。
  const timebase = createMemo(() => {
    const tb = metadata().timebase
    if (!tb || typeof tb.scale !== "number") return ""
    const delay = typeof tb.delay === "number" && tb.delay !== 0 ? formatTime(tb.delay) : ""
    return [`${formatTime(tb.scale)}/div`, delay].filter(Boolean).join(" · ")
  })
  const sampleRate = createMemo(() => {
    const hz = metadata().sampleRate
    return typeof hz === "number" && hz > 0 ? formatFreq(hz) : ""
  })
  const trigger = createMemo(() => {
    const tr = metadata().trigger
    if (!tr) return ""
    return [tr.mode, tr.source, typeof tr.level === "number" ? `${num(tr.level)} V` : "", tr.slope, tr.status]
      .filter(Boolean)
      .join(" · ")
  })

  const channelValue = (channel: ScopeChannelDetails) => {
    const setup = [
      typeof channel.vdiv === "number" ? `${num(channel.vdiv)}/div` : "",
      channel.coupling,
      typeof channel.probe === "number" ? `${num(channel.probe)}×` : "",
      channel.unit,
    ].filter(Boolean)
    const stats = channel.stats
    if (stats) {
      setup.push(`pp ${num(stats.pp)}`)
      setup.push(`mean ${num(stats.mean)}`)
      if (typeof stats.freq === "number" && stats.freq > 0) setup.push(formatFreq(stats.freq))
    }
    return setup.join(" · ")
  }

  const openImage = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  return (
    <div data-component="scope-tool">
      <BasicTool
        {...props}
        icon="status"
        trigger={{
          title: i18n.t("ui.tool.scope"),
          subtitle: captureId() || address(),
          action: (
            <Show when={actionLabel()}>
              <span data-component="tool-badge">{actionLabel()}</span>
            </Show>
          ),
        }}
      >
        <div data-component="tool-kv">
          <Show when={instrument()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.instrument")}</span>
              <span data-slot="tool-kv-value">
                {instrument()}
                <Show when={metadata().firmware}>
                  <span data-slot="scope-firmware"> {metadata().firmware}</span>
                </Show>
              </span>
            </div>
          </Show>
          <Show when={address()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.address")}</span>
              <span data-slot="tool-kv-value">{address()}</span>
            </div>
          </Show>
          <Show when={captureId()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.capture")}</span>
              <span data-slot="tool-kv-value">{captureId()}</span>
            </div>
          </Show>
          <Show when={timebase()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.timebase")}</span>
              <span data-slot="tool-kv-value">{timebase()}</span>
            </div>
          </Show>
          <Show when={sampleRate()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.sampleRate")}</span>
              <span data-slot="tool-kv-value">{sampleRate()}</span>
            </div>
          </Show>
          <Show when={typeof metadata().points === "number" && (metadata().points ?? 0) > 0}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.points")}</span>
              <span data-slot="tool-kv-value">{metadata().points}</span>
            </div>
          </Show>
          <Show when={metadata().mdepth}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.mdepth")}</span>
              <span data-slot="tool-kv-value">{metadata().mdepth}</span>
            </div>
          </Show>
          <Show when={trigger()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.trigger")}</span>
              <span data-slot="tool-kv-value">{trigger()}</span>
            </div>
          </Show>
          <Show when={channels().length > 0}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.channels")}</span>
              <span data-slot="tool-kv-value">{channels().length}</span>
            </div>
            <For each={channels()}>
              {(channel) => (
                <div data-slot="tool-kv-row" data-scope="scope-channel">
                  <span data-slot="tool-kv-label">{[`C${channel.ch}`, channel.label].filter(Boolean).join(" ")}</span>
                  <span data-slot="tool-kv-value">{channelValue(channel)}</span>
                </div>
              )}
            </For>
          </Show>
          <Show when={measurements().length > 0}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.measurements")}</span>
              <span data-slot="tool-kv-value">{measurements().length}</span>
            </div>
            <For each={measurements()}>
              {(measurement) => (
                <div data-slot="tool-kv-row" data-scope="scope-channel">
                  <span data-slot="tool-kv-label">
                    {[measurement.type, measurement.source].filter(Boolean).join(" ")}
                  </span>
                  <span data-slot="tool-kv-value">
                    {measurement.value === null
                      ? "—"
                      : [num(measurement.value), measurement.unit].filter(Boolean).join(" ")}
                  </span>
                </div>
              )}
            </For>
          </Show>
          <Show when={metadata().armed}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.armed")}</span>
              <span data-slot="tool-kv-value" />
            </div>
          </Show>
          <Show when={metadata().timedOut}>
            <div data-slot="tool-kv-row" data-tone="warning">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.timedOut")}</span>
              <span data-slot="tool-kv-value" />
            </div>
          </Show>
          <Show when={metadata().truncated}>
            <div data-slot="tool-kv-row" data-tone="warning">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.scope.truncated")}</span>
              <span data-slot="tool-kv-value" />
            </div>
          </Show>
        </div>
        <For each={attachments()}>
          {(file) => (
            <div data-component="scope-figure">
              <img
                data-slot="scope-figure-image"
                src={file.url}
                alt={file.filename ?? i18n.t("ui.tool.scope")}
                onClick={(event) => {
                  event.stopPropagation()
                  openImage(file.url, file.filename)
                }}
              />
              <Show when={typeof metadata().bytes === "number"}>
                <span data-slot="scope-figure-caption">
                  {file.mime} · {metadata().bytes} B
                </span>
              </Show>
            </div>
          )}
        </For>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    </div>
  )
}
