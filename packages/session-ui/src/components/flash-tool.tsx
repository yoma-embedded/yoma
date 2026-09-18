/**
 * flash 卡片 —— "这一版到底烧进去了没有"。
 *
 * 折叠态:`● 烧录 f405-motor-ctrl.elf · ✓ 已烧录 · 0.73 s`。
 * 展开态:整条命令(**不截断**)、关键输出行、写入/校验读数、记进 flash-state 的镜像。
 */
import { createMemo, For, Show } from "solid-js"
import { FLASH_CONTRACT } from "@yoma-desktop/kernel/tools/flash/contract"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { GenericTool } from "./basic-tool"
import { describeFlash, type FlashCard } from "./flash-card"
import { formatCount, formatElapsed, shortPath } from "./hw-format"
import { HwMono, HwNote, HwRaw, HwReadout, HwReadouts, HwSection, HwTool } from "./hw-tool"
import type { ToolProps } from "./message-part"

export function FlashTool(props: ToolProps) {
  const i18n = useI18n()
  const card = createMemo(() => describeFlash(props.input, props.metadata, props.output))
  const running = () => props.status === "pending" || props.status === "running"
  /** 烧录器自己报的秒数 —— 重放一段旧会话时它照样对(见 FlashCard.totalSeconds)。 */
  const elapsed = createMemo(() => {
    const total = card()?.totalSeconds
    return total === undefined ? undefined : formatElapsed(total * 1000)
  })

  const conclusion = (hit: FlashCard) => {
    if (!hit.ok) {
      return hit.exitCode === null
        ? `✗ ${i18n.t("ui.tool.flash.aborted")}`
        : `✗ ${i18n.t("ui.tool.flash.exit", { code: hit.exitCode })}`
    }
    return [`✓ ${i18n.t("ui.tool.flash.done")}`, elapsed()].filter(Boolean).join(" · ")
  }

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <HwTool
          {...props}
          trigger={{
            state: running() ? "active" : hit().ok ? "ok" : "fail",
            label: FLASH_CONTRACT.label,
            action: hit().image ?? FLASH_CONTRACT.name,
            conclusion: running() ? undefined : conclusion(hit()),
          }}
        >
          <HwSection title={i18n.t("ui.tool.flash.command")}>
            {/* 整段显示、不 truncate:mass_erase 藏在省略号后面的代价这个仓库付过。 */}
            <HwMono text={hit().command} wrap />
          </HwSection>

          <Show when={hit().highlights.length > 0}>
            <HwSection title={i18n.t("ui.tool.flash.evidence")}>
              <ul data-component="hw-evidence">
                <For each={hit().highlights}>{(line) => <li data-tone={line.tone}>{line.text}</li>}</For>
              </ul>
            </HwSection>
          </Show>

          <HwSection title={i18n.t("ui.tool.hw.readout")}>
            <HwReadouts>
              <HwReadout
                k={i18n.t("ui.tool.exitCode")}
                v={hit().exitCode === null ? "—" : String(hit().exitCode)}
                tone={hit().ok ? "ok" : "fail"}
              />
              <Show when={hit().wroteBytes !== undefined}>
                <HwReadout k={i18n.t("ui.tool.flash.wrote")} v={`${formatCount(hit().wroteBytes!)} B`} />
              </Show>
              <Show when={hit().programSeconds !== undefined}>
                <HwReadout k={i18n.t("ui.tool.flash.program")} v={formatElapsed(hit().programSeconds! * 1000) ?? "—"} />
              </Show>
              <Show when={hit().verifySeconds !== undefined}>
                <HwReadout k={i18n.t("ui.tool.flash.verify")} v={formatElapsed(hit().verifySeconds! * 1000) ?? "—"} />
              </Show>
            </HwReadouts>
            {/* 镜像 sha 不在 details 里(FlashDetails 只有 recordedElf),所以这里说的是路径不是指纹。 */}
            <Show when={hit().recordedElf}>
              <HwNote>
                {i18n.t("ui.tool.flash.recorded")} {shortPath(hit().recordedElf!, 4)}
              </HwNote>
            </Show>
          </HwSection>

          <Show when={typeof props.output === "string" && props.output.length > 0}>
            <HwRaw text={props.output!} label={i18n.t("ui.tool.hw.output")} open={hit().highlights.length === 0} />
          </Show>
        </HwTool>
      )}
    </Show>
  )
}
