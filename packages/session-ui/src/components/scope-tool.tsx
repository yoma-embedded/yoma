/**
 * scope 卡片 —— 模拟侧的证据。
 *
 * 折叠态:`● 示波器 capture exact C1,C2 · C1 C2 · 100k pts · 20 ns/pt`。
 * 展开态:量测排成读数表、通道设置一行一个、时基/触发读数、仪器截图。
 * 截图保存在工具结果里,所以实时与重放看到的是同一份证据。
 *
 * DEMO / 未验证型号的警告是**一条安静的 warn 标注**,不是一段大字 —— 它在连着的时候
 * 每一条结果都重复,做成横幅的话整张卡片就只剩它了。
 */
import { createMemo, For, Show } from "solid-js"
import { normalizeScopeArguments, SCOPE_CONTRACT } from "@yoma-desktop/kernel/tools/scope/contract"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { ImagePreview } from "@yoma-desktop/ui/image-preview"
import { GenericTool } from "./basic-tool"
import { scopeValue, shortPath } from "./hw-format"
import { HwNote, HwRaw, HwReadout, HwReadouts, HwSection, HwTool, type HwState } from "./hw-tool"
import { describeScope, scopeConclusion, type ScopeCard } from "./scope-card"
import type { ToolProps } from "./message-part"

/** `1 V/div · 0 V · DC · 10× · FULL` —— 一条通道的设置。 */
function channelLine(channel: ScopeCard["channels"][number]): string {
  return [
    channel.vdiv !== undefined ? `${scopeValue(channel.vdiv, channel.unit ?? "V")}/div` : undefined,
    channel.offset !== undefined ? scopeValue(channel.offset, channel.unit ?? "V") : undefined,
    channel.coupling,
    channel.probe !== undefined ? `${channel.probe}×` : undefined,
    channel.bwlimit,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * 契约的 `summary` 收的是**归一之后**的参数(`channels` 里只剩 `{ch}` 对象),而 part 上存的
 * `state.input` 是模型原样发来的那一份(`channels: [1, 2]`)—— 直接喂进去会拼出
 * `capture exact Cundefined,Cundefined`(实测)。归一的真源就在契约里,先过一道它。
 */
function scopeAction(input: Record<string, unknown> | undefined): string {
  try {
    return SCOPE_CONTRACT.summary(normalizeScopeArguments(input ?? {}) as Parameters<typeof SCOPE_CONTRACT.summary>[0])
  } catch {
    return ""
  }
}

export function ScopeTool(props: ToolProps) {
  const i18n = useI18n()
  const dialog = useDialog()
  const card = createMemo(() => describeScope(props.input, props.metadata, props.output))
  const running = () => props.status === "pending" || props.status === "running"
  const images = createMemo(() =>
    (props.attachments ?? []).filter(
      (file) => file.mime === "image/png" && file.url.startsWith("data:image/png;base64,"),
    ),
  )

  /** 有没有值得单开一块"读数"的东西 —— 只有一行地址时那一块是白占地方。 */
  const hasReadouts = (hit: ScopeCard) =>
    !!hit.timebase ||
    hit.sampleRate !== undefined ||
    hit.points !== undefined ||
    hit.interval !== undefined ||
    !!hit.mdepth ||
    !!hit.trigger ||
    !!hit.quality

  const state = (hit: ScopeCard): HwState => {
    if (running() || hit.armed) return "active"
    if (hit.timedOut) return "warn"
    if (hit.action === "disconnect") return "offline"
    if (hit.warnings.length > 0) return "warn"
    return hit.captureId || hit.measurements.length > 0 ? "ok" : "idle"
  }

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <HwTool
          {...props}
          trigger={{
            state: state(hit()),
            label: SCOPE_CONTRACT.label,
            action: scopeAction(props.input) || (hit().action ?? SCOPE_CONTRACT.name),
            conclusion: running() ? undefined : scopeConclusion(hit()),
          }}
        >
          <Show when={hit().measurements.length > 0}>
            <HwSection title={i18n.t("ui.tool.scope.measurements")}>
              <HwReadouts>
                <For each={hit().measurements}>
                  {(item) => (
                    <HwReadout
                      k={`${item.type} ${item.source}`.trim()}
                      // value 为 null 是"这一次量不出来",不是 0 —— 两者说的是相反的事。
                      v={item.value === null ? i18n.t("ui.tool.scope.unavailable") : scopeValue(item.value, item.unit ?? "")}
                      tone={item.value === null ? "warn" : undefined}
                    />
                  )}
                </For>
              </HwReadouts>
            </HwSection>
          </Show>

          <Show when={hit().channels.length > 0}>
            <HwSection title={i18n.t("ui.tool.scope.channels")}>
              <HwReadouts>
                <For each={hit().channels}>
                  {(channel) => (
                    <HwReadout
                      k={`C${channel.ch}${channel.label ? ` ${channel.label}` : ""}`}
                      v={channel.on ? channelLine(channel) : i18n.t("ui.tool.scope.off")}
                      tone={channel.on ? undefined : "offline"}
                    />
                  )}
                </For>
              </HwReadouts>
            </HwSection>
          </Show>

          <Show when={hasReadouts(hit())}>
          <HwSection
            title={i18n.t("ui.tool.hw.readout")}
            meta={[hit().model, hit().serial, hit().address].filter(Boolean).join(" · ") || undefined}
          >
            <HwReadouts>
              <Show when={hit().timebase}>
                <HwReadout k={i18n.t("ui.tool.scope.timebase")} v={`${scopeValue(hit().timebase!.scale, "s")}/div`} />
              </Show>
              <Show when={hit().sampleRate !== undefined}>
                <HwReadout k={i18n.t("ui.tool.scope.sampleRate")} v={`${scopeValue(hit().sampleRate!, "Sa/s")}`} />
              </Show>
              <Show when={hit().points !== undefined}>
                <HwReadout k={i18n.t("ui.tool.scope.points")} v={hit().points!.toLocaleString("en-US")} />
              </Show>
              <Show when={hit().interval !== undefined}>
                <HwReadout k={i18n.t("ui.tool.scope.interval")} v={`${scopeValue(hit().interval!, "s")}/pt`} />
              </Show>
              <Show when={hit().mdepth}>
                <HwReadout k={i18n.t("ui.tool.scope.mdepth")} v={hit().mdepth!} />
              </Show>
              <Show when={hit().trigger}>
                <HwReadout
                  wide
                  k={i18n.t("ui.tool.scope.trigger")}
                  v={[
                    hit().trigger!.source,
                    hit().trigger!.slope,
                    hit().trigger!.level !== undefined ? `@ ${scopeValue(hit().trigger!.level!, "V")}` : undefined,
                    hit().trigger!.mode,
                    hit().trigger!.status,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              </Show>
              <Show when={hit().quality}>
                <HwReadout
                  k={i18n.t("ui.tool.scope.quality")}
                  v={`${hit().quality}${hit().stride !== undefined ? ` · stride ${hit().stride}` : ""}`}
                  tone={hit().quality === "overview" ? "warn" : undefined}
                />
              </Show>
            </HwReadouts>
            <Show when={hit().dir}>
              <HwNote>
                {i18n.t("ui.tool.scope.saved")} {shortPath(hit().dir!, 3)}
              </HwNote>
            </Show>
          </HwSection>
          </Show>

          {/* 警告:安静的一行,不是横幅。它每一条结果都会重复。 */}
          <Show when={hit().warnings.length > 0}>
            <div data-component="hw-notes">
              <For each={hit().warnings}>{(warning) => <HwNote tone="warn">{warning}</HwNote>}</For>
            </div>
          </Show>

          <For each={images()}>
            {(file) => (
              <figure data-component="hw-figure">
                <button
                  type="button"
                  aria-label={i18n.t("ui.tool.scope.zoom")}
                  onClick={(event) => {
                    event.stopPropagation()
                    dialog.show(() => <ImagePreview src={file.url} alt={i18n.t("ui.tool.scope.screenshot")} />)
                  }}
                >
                  <img
                    src={file.url}
                    alt={file.filename ?? i18n.t("ui.tool.scope.screenshot")}
                    loading="lazy"
                    onLoad={() => props.onContentRendered?.()}
                  />
                </button>
                <figcaption>{i18n.t("ui.tool.scope.screenshotNote")}</figcaption>
              </figure>
            )}
          </For>

          <Show when={typeof props.output === "string" && props.output.length > 0}>
            <HwRaw
              text={props.output!}
              label={i18n.t("ui.tool.hw.output")}
              wrap
              open={hit().measurements.length === 0 && hit().channels.length === 0 && !hasReadouts(hit())}
            />
          </Show>
        </HwTool>
      )}
    </Show>
  )
}
