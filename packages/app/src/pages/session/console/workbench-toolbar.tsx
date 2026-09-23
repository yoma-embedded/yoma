import { For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import { sidebarInstrumentSlot } from "@/pages/layout/sidebar-slot"
import { SIDEBAR_ROW, SIDEBAR_ROW_ACTIVE, SIDEBAR_ROW_IDLE } from "@/pages/layout/sidebar-row"
import { useBench } from "../bench/bench-context"
import { INSTRUMENTS } from "../bench/instruments"
import { instrumentShown, toggleInstrument } from "./reveal-instrument"
import { EvidenceDot } from "../bench/evidence-dot"
import { useUnseenSet } from "./evidence-view"
import "./workbench.css"

/**
 * 仪器入口,住在左侧栏「新对话 / 手册库 / 调试台」下面。
 *
 * 从前是会话页顶上单独一整行(「嵌入式工作台 | 串口 | GDB | 示波器 | 逻辑分析仪 … 直接操作仪器」),
 * 和右栏自己的仪器页签说的是同一件事,还白占一行高度。现在画进侧栏留的那一格(Portal,仪器上下文跟着页面走),
 * 右栏那排页签与「+ 仪器」也跟着删了(2026-09-23):挑哪一台只在这里挑。
 * 侧栏收起时这里跟着看不见,状态栏的格子、时间线卡片上的「在面板中打开」与命令面板照样打得开。
 * 灯只反映设备活动,入口本身永远都在。
 */
export function WorkbenchToolbar() {
  const language = useLanguage()
  const bench = useBench()
  // "有我还没看过的新证据"(新采集、新的 error 日志):从前挂在右栏页签上,页签删了之后挂在这里。
  const unseen = useUnseenSet()
  return (
    <Show when={sidebarInstrumentSlot()}>
      {(mount) => (
        <Portal mount={mount()}>
          <nav class="ybench" data-component="workbench-nav" aria-label={language.t("session.workbench.title")}>
            <div data-slot="heading">{language.t("session.workbench.instruments")}</div>
            <For each={INSTRUMENTS}>
              {(instrument) => {
                const selected = () => instrumentShown(instrument.id, bench.ctx())
                return (
                  <button
                    type="button"
                    class={`${SIDEBAR_ROW} ${selected() ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_IDLE}`}
                    data-instrument={instrument.id}
                    aria-pressed={selected()}
                    onClick={() => toggleInstrument(instrument.id, bench.ctx())}
                  >
                    <Icon name={instrument.icon} size="small" />
                    <span class="min-w-0 flex-1 truncate">
                      {language.t(instrument.labelKey as Parameters<typeof language.t>[0])}
                    </span>
                    <EvidenceDot when={unseen().has(instrument.id)} />
                    <span data-component="bench-led" data-state={instrument.status(bench.ctx())} />
                  </button>
                )
              }}
            </For>
          </nav>
        </Portal>
      )}
    </Show>
  )
}
