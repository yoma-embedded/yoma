/** GDB control surface and separately labelled saved conversation evidence. */
import { GdbControls } from "./gdb-controls"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useBenchStatus } from "./use-bench-status"
import { gdbEnded, gdbStateLabel, type GdbStatus } from "./bench-status"

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

/** 停止报告 + 本次会话的停止历史。没有名牌 —— 容器自带(控制台的页签行)或由 `GdbPanel` 加。 */
export function GdbBody() {
  const language = useLanguage()
  const status = useBenchStatus()
  const gdb = () => status().gdb

  return (
    <div data-component="bench-gdb-panel" data-chrome="bare">
      <GdbControls />
      <Show when={gdb() && (gdb()!.state !== "none" || gdbEnded(gdb()))}>
        <details data-slot="saved-stops">
          <summary>{language.t("session.gdbControl.history")}</summary>
          <Show
            when={gdb() && (gdb()!.state !== "none" || gdbEnded(gdb()))}
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
                    {(line) => <span data-kind={line.kind}>{line.text || " "}</span>}
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
        </details>
      </Show>
    </div>
  )
}

/** 注册表的缺省装配:名牌 + 正文。 */
export function GdbPanel() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const status = useBenchStatus()
  const gdb = () => status().gdb

  return (
    <div data-component="bench-gdb-panel">
      {/* 细头:左边是目标状态(一个词),右边是停在哪与连的是谁。
          仪器名在外层窗口的名牌上,这里不重复。 */}
      <div data-component="bench-panel-head" data-state={gdbLedState(gdb())}>
        <span data-slot="title">{gdbStateLabel(gdb(), t)}</span>
        <span data-slot="rule" />
        <span data-slot="meta" title={gdb()?.path}>
          {[gdb()?.location, gdb()?.connection].filter(Boolean).join(" · ")}
        </span>
      </div>
      <GdbBody />
    </div>
  )
}

/** 灯的四档。与 `instruments.ts` 里 gdb 那条 `status()` 同解 —— 面板自己也要用。 */
function gdbLedState(gdb: GdbStatus | undefined) {
  if (!gdb || gdb.state === "none") return "offline"
  if (gdb.fault) return "attention"
  if (gdb.state === "running") return "active"
  if (gdb.state === "exited" || gdb.state === "connection-lost") return "offline"
  return "idle"
}
