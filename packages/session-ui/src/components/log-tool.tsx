/**
 * log 卡片 —— "板子刚才说了什么"。
 *
 * 折叠态:`● 日志 wait /HARDFAULT/ · 命中 +1.710s`。
 * 展开态:工具自己那几句说明 + 日志节选(与 LogPanel 同一套行样式:等宽、级别着色、
 * 时间戳弱化,命中那行高亮)+ 游标 / 来源 / 落盘文件的读数。
 */
import { createMemo, Show } from "solid-js"
import { LOG_CONTRACT } from "@yoma-desktop/kernel/tools/log/contract"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { GenericTool } from "./basic-tool"
import { formatCount, shortPath } from "./hw-format"
import { HwLines, HwNote, HwReadout, HwReadouts, HwSection, HwTool, type HwState } from "./hw-tool"
import { describeLog, matchOffset, skippedLines, type LogCard } from "./log-card"
import type { ToolProps } from "./message-part"

export function LogTool(props: ToolProps) {
  const i18n = useI18n()
  const card = createMemo(() => describeLog(props.input, props.metadata, props.output))
  const running = () => props.status === "pending" || props.status === "running"

  const action = (hit: LogCard) => {
    const summary = LOG_CONTRACT.summary(props.input ?? {})
    if (summary) return summary
    return hit.action ?? LOG_CONTRACT.name
  }

  /** 命中的那一行是不是事故行 —— 灯按"看到了什么"点,不按"动作成没成"点。 */
  const hitIsError = (hit: LogCard) => hit.lines.some((line) => line.hit && line.level === "error")

  const state = (hit: LogCard): HwState => {
    if (running()) return "active"
    if (hit.action === "wait") {
      if (!hit.matched) return "warn"
      return hitIsError(hit) ? "attention" : "ok"
    }
    if (hit.lines.some((line) => line.level === "error")) return "attention"
    if (hit.capturing) return "active"
    return "idle"
  }

  const conclusion = (hit: LogCard) => {
    const bits: string[] = []
    switch (hit.action) {
      case "wait":
        bits.push(
          hit.matched
            ? [i18n.t("ui.tool.log.matched"), matchOffset(hit.notes)].filter(Boolean).join(" ")
            : i18n.t("ui.tool.log.notMatched"),
        )
        break
      case "start":
        // 来源已经在动作那一段里(`start sh tools/uart-sim.sh`),别再说一遍
        bits.push(i18n.t("ui.tool.log.capturing"))
        break
      case "stop":
        bits.push(i18n.t("ui.tool.log.stopped"))
        if (hit.totalLines !== undefined) bits.push(i18n.t("ui.tool.log.lines", { count: formatCount(hit.totalLines) }))
        break
      case "ports":
        bits.push(hit.notes[0] ?? i18n.t("ui.tool.log.ports"))
        break
      case "status":
        bits.push(hit.capturing ? i18n.t("ui.tool.log.capturing") : i18n.t("ui.tool.log.stopped"))
        if (hit.totalLines !== undefined) bits.push(i18n.t("ui.tool.log.lines", { count: formatCount(hit.totalLines) }))
        break
      default:
        bits.push(
          hit.lines.length > 0
            ? i18n.t("ui.tool.log.lines", { count: formatCount(hit.lines.length) })
            : i18n.t("ui.tool.log.nothingNew"),
        )
    }
    return bits.filter(Boolean).join(" · ")
  }

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <HwTool
          {...props}
          trigger={{
            state: state(hit()),
            label: LOG_CONTRACT.label,
            action: action(hit()),
            conclusion: running() ? undefined : conclusion(hit()),
          }}
        >
          <Show when={hit().notes.length > 0}>
            <div data-component="hw-notes">
              {hit().notes.map((note) => (
                <HwNote tone={/^no match|timed out/i.test(note) ? "warn" : "muted"}>{note}</HwNote>
              ))}
            </div>
          </Show>

          <Show when={hit().lines.length > 0}>
            <HwSection
              title={i18n.t("ui.tool.log.excerpt")}
              meta={
                skippedLines(hit().notes) !== undefined
                  ? i18n.t("ui.tool.log.skipped", { count: skippedLines(hit().notes)! })
                  : undefined
              }
            >
              <HwLines lines={hit().lines} />
            </HwSection>
          </Show>

          <HwSection title={i18n.t("ui.tool.hw.readout")}>
            <HwReadouts>
              {/* 来源不上色:浅色主题里 active 是蓝的,一条路径长得像链接。"活着没有"归状态那一行说。 */}
              <HwReadout k={i18n.t("ui.tool.log.source")} v={hit().source ?? "—"} title={hit().source} wide />
              <HwReadout
                k={i18n.t("ui.tool.log.state")}
                v={hit().capturing ? i18n.t("ui.tool.log.capturing") : i18n.t("ui.tool.log.stopped")}
                tone={hit().capturing ? "active" : "idle"}
              />
              <Show when={hit().cursor !== undefined}>
                <HwReadout k={i18n.t("ui.tool.log.cursor")} v={formatCount(hit().cursor!)} />
              </Show>
              <Show when={hit().totalLines !== undefined}>
                <HwReadout k={i18n.t("ui.tool.log.totalLines")} v={formatCount(hit().totalLines!)} />
              </Show>
              <Show when={!!hit().dropped}>
                <HwReadout k={i18n.t("ui.tool.log.dropped")} v={formatCount(hit().dropped!)} tone="warn" />
              </Show>
              <Show when={hit().exitCode !== undefined && hit().exitCode !== null}>
                <HwReadout k={i18n.t("ui.tool.exitCode")} v={String(hit().exitCode)} />
              </Show>
            </HwReadouts>
            {/* 全文永远在这个文件里 —— 卡片是窗口不是记录。 */}
            <Show when={hit().file}>
              <HwNote>
                {i18n.t("ui.tool.log.fullLog")} {shortPath(hit().file!, 3)}
              </HwNote>
            </Show>
          </HwSection>
        </HwTool>
      )}
    </Show>
  )
}
