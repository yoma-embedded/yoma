/** GDB control surface and separately labelled saved conversation evidence. */
import { GdbControls } from "./gdb-controls"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useBenchStatus } from "./use-bench-status"
import { gdbEnded } from "./bench-status"

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
/**
 * 正文:手动调试器,agent 保存的停止现场收在它右侧最后一个分区「停止记录」里(缺省收着)。
 * 从前这里上面还有一条细头(状态 · 位置 · 连接),与调试器自己的状态行说的是同一件事,去掉了。
 */
export function GdbBody() {
  const language = useLanguage()
  const status = useBenchStatus()
  const gdb = () => status().gdb
  const history = () => (
    <Show
      when={gdb() && (gdb()!.state !== "none" || gdbEnded(gdb())) ? gdb() : undefined}
      fallback={
        <div data-component="bench-empty">
          {language.t("session.bench.gdb.empty")}
          <span data-slot="hint">{language.t("session.bench.gdb.emptyHint")}</span>
        </div>
      }
    >
      {(status) => (
        <>
          <Show
            when={status().report}
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
          <Show when={status().stops.length > 1}>
            <ul data-slot="history">
              {/* 最近的排最上面 —— 往下是越来越旧的现场。 */}
              <For each={[...status().stops].reverse()}>
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
        </>
      )}
    </Show>
  )

  // 建一次:里面的 Show 自己跟着数据走;每次条件翻转都重建会把用户展开着的报告收回去。
  const historyView = history()
  const hasHistory = () => !!gdb() && (gdb()!.state !== "none" || gdbEnded(gdb()))

  return (
    <div data-component="bench-gdb-panel" data-chrome="bare">
      <GdbControls history={hasHistory() ? historyView : undefined} />
    </div>
  )
}

/** 注册表的缺省装配。仪器名在外层窗口的名牌上,状态在调试器自己的状态行上,这里不再加一条细头。 */
export function GdbPanel() {
  return <GdbBody />
}
