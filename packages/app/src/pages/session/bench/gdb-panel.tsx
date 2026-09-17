/**
 * GDB 面板 —— 只读的"目标现在停在哪"。
 *
 * 全部来自 transcript(`BenchStatus.gdb`):没有新的 RPC、没有第二个 gdb 会话、
 * 一个按钮都不给。**这里不能有运行控制** —— 探针是独占设备,界面和 agent 同时按
 * continue 的后果是两边抢同一个 MI 会话。要动目标就让 agent 动。
 *
 * 结构化只做一层:停在哪一行加粗、故障行标红、其余等宽原样。停止报告是 gdb 自己
 * 渲染的文本(`host/tools/gdb/target.ts` 的 renderStopReport),在这里**不重排版** ——
 * 它的缩进与顺序是有意义的。
 */
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useBenchStatus } from "./use-bench-status"
import type { GdbState } from "./bench-status"

const STATE_KEY: Record<GdbState, string> = {
  none: "session.bench.gdb.state.none",
  attached: "session.bench.gdb.state.attached",
  halted: "session.bench.gdb.state.halted",
  running: "session.bench.gdb.state.running",
  exited: "session.bench.gdb.state.exited",
  "connection-lost": "session.bench.gdb.state.lost",
}

/** `■ stopped#…` 是标题行,`故障(…)` 是要标红那行,其余照原样。 */
const LOCATION_LINE = /^■/
const FAULT_LINE = /^\s*(?:故障[(（]|⚠)/

type ReportLine = { kind: "location" | "fault" | "plain"; text: string }

/** 纯函数:把 gdb 的停止报告切成带类别的行。分出来是为了能测,也为了布局变体能自己重画。 */
export function splitStopReport(report: string): ReportLine[] {
  return report.split("\n").map((text) => ({
    kind: LOCATION_LINE.test(text) ? "location" : FAULT_LINE.test(text) ? "fault" : "plain",
    text,
  }))
}

const hhmmss = (at: number) => (at ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : "")

export function GdbPanel() {
  const language = useLanguage()
  const status = useBenchStatus()
  const gdb = () => status().gdb

  const ledState = () => {
    const g = gdb()
    if (!g || g.state === "none") return "offline"
    if (g.fault) return "attention"
    if (g.state === "running") return "active"
    if (g.state === "exited" || g.state === "connection-lost") return "offline"
    return "idle"
  }

  return (
    <div data-component="bench-gdb-panel">
      {/* 细头:左边是目标状态(一个词),右边是停在哪与连的是谁。
          仪器名在外层窗口的名牌上,这里不重复。 */}
      <div data-component="bench-panel-head" data-state={ledState()}>
        <span data-slot="title">
          {gdb()
            ? language.t(STATE_KEY[gdb()!.state] as Parameters<typeof language.t>[0])
            : language.t("session.bench.gdb.state.none")}
        </span>
        <span data-slot="rule" />
        <span data-slot="meta" title={gdb()?.path}>
          {[gdb()?.location, gdb()?.connection].filter(Boolean).join(" · ")}
        </span>
      </div>

      <Show
        when={gdb() && gdb()!.state !== "none"}
        fallback={
          <div data-component="bench-empty">
            {language.t("session.bench.gdb.empty")}
            <span data-slot="hint">{language.t("session.bench.gdb.emptyHint")}</span>
          </div>
        }
      >
        <Show
          when={gdb()!.report}
          fallback={
            <div data-component="bench-empty">
              {language.t("session.bench.gdb.noStop")}
              <span data-slot="hint">{language.t("session.bench.gdb.noStopHint")}</span>
            </div>
          }
        >
          {(report) => (
            <pre data-slot="report">
              <For each={splitStopReport(report())}>
                {(line) => (
                  <span data-kind={line.kind}>{line.text || " "}</span>
                )}
              </For>
            </pre>
          )}
        </Show>

        <Show when={gdb()!.stops.length > 1}>
          <div data-component="bench-panel-head">
            <span data-slot="title">{language.t("session.bench.gdb.history")}</span>
            <span data-slot="rule" />
          </div>
          <ul data-slot="history">
            {/* 最近的排最上面 —— 往下是越来越旧的现场。 */}
            <For each={[...gdb()!.stops].reverse()}>
              {(stop) => (
                <li data-fault={stop.fault ? "true" : "false"}>
                  <span data-slot="when">{hhmmss(stop.at)}</span>
                  <span data-slot="where" title={stop.fault ?? stop.reason}>
                    #{stop.n} {stop.reason}
                    {stop.location ? ` @ ${stop.location}` : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
