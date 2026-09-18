/**
 * 底部控制台 —— 文本流仪器(日志 / GDB,将来的上位机控制台)的家。
 *
 * 为什么在底下:这些东西是**一行一行往下滚的文本**,要的是宽度。压进一条 480px 的右栏里,
 * 一条 `0x080004a2 <foc_zero_isense+10>` 就折三行,而串口与调试控制台恰恰是嵌入式工程师
 * 一天到晚盯着的两样 —— IDE 把它们放在底下不是审美,是行宽。
 *
 * 页签里有哪几台**不写死**:问注册表要 `surface === "text"` 且此刻该露面的那些
 * (核心 ∪ 本会话用过 ∪ 磁盘上有数据 ∪ 钉住)。所以加一台"上位机控制台"= 注册表加一条,
 * 这个文件一个字都不用改。
 */
import { createEffect, createMemo, For, on, Show, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@yoma-desktop/ui/icon"
import { ResizeHandle } from "@yoma-desktop/ui/resize-handle"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useBench } from "../bench/bench-context"
import { benchPins, hiddenOnSurface, visibleOnSurface, type InstrumentDef } from "../bench/instruments"
import { CONSOLE_MAX_FRACTION, CONSOLE_MIN_HEIGHT, consoleUI } from "./console-state"
import { handleTablistKeys } from "./tablist-keys"
import "./console.css"

export function SessionConsole() {
  const language = useLanguage()
  const command = useCommand()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const bench = useBench()

  const tabs = createMemo(() => visibleOnSurface("text", bench.ctx()))
  const hidden = createMemo(() => hiddenOnSurface("text", bench.ctx()))

  /** 选中的那一台。存着的那个可能已经不该露面了(换了会话),回落到第一台。 */
  const active = createMemo<InstrumentDef | undefined>(() => {
    const list = tabs()
    return list.find((instrument) => instrument.id === consoleUI.tab()) ?? list[0]
  })

  let root: HTMLElement | undefined
  /** 拖高的上限:这一块可用高度的六成(CSS 里的 max-height 是同一个数,管窗口变矮那条路)。 */
  const maxHeight = () => {
    const available = root?.parentElement?.clientHeight ?? (typeof window === "undefined" ? 800 : window.innerHeight)
    return Math.max(CONSOLE_MIN_HEIGHT + 40, Math.round(available * CONSOLE_MAX_FRACTION))
  }

  // 选中的那一台被藏起来了(比如取消钉住)时把页签挪到还在的那一台上,
  // 免得控制台开着却是一片空白。
  createEffect(
    on(active, (instrument) => {
      if (instrument && instrument.id !== consoleUI.tab()) consoleUI.setTab(instrument.id)
    }),
  )

  const toggleKey = () => command.keybind("console.toggle")

  return (
    <Show when={consoleUI.opened()}>
      <section
        class="ybench"
        data-component="session-console"
        data-maximized={consoleUI.maximized() ? "true" : "false"}
        aria-label={t("session.console.title")}
        ref={(element: HTMLElement) => (root = element)}
        style={{ height: consoleUI.maximized() ? undefined : `${consoleUI.height()}px` }}
      >
        <Show when={!consoleUI.maximized()}>
          <ResizeHandle
            direction="vertical"
            edge="start"
            size={consoleUI.height()}
            min={CONSOLE_MIN_HEIGHT}
            max={maxHeight()}
            onResize={(height) => consoleUI.resize(height)}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("session.console.resize")}
            title={t("session.console.resize")}
          />
        </Show>

        <div data-slot="head">
          <div data-slot="tablist" role="tablist" aria-label={t("session.console.title")} onKeyDown={handleTablistKeys}>
            <For each={tabs()}>
              {(instrument) => (
                <button
                  type="button"
                  role="tab"
                  data-slot="tab"
                  data-instrument={instrument.id}
                  aria-selected={active()?.id === instrument.id ? "true" : "false"}
                  // roving tabindex:Tab 键只停在选中的那一格,格与格之间用左右键 —— 页签行
                  // 是一个控件,不是 N 个。
                  tabIndex={active()?.id === instrument.id ? 0 : -1}
                  onClick={() => consoleUI.setTab(instrument.id)}
                >
                  <span data-component="bench-led" data-state={instrument.status(bench.ctx())} />
                  <Icon name={instrument.icon} size="small" />
                  {t(instrument.labelKey)}
                </button>
              )}
            </For>
            {/* 藏着的文本仪器(通常是还没连过的调试器):给一个显式的入口,而不是让它凭空冒出来。 */}
            <For each={hidden()}>
              {(instrument) => (
                <button
                  type="button"
                  data-slot="add"
                  data-instrument={instrument.id}
                  title={t("session.bench.add")}
                  onClick={() => {
                    benchPins.pin(instrument.id)
                    consoleUI.setTab(instrument.id)
                  }}
                >
                  + {t(instrument.labelKey)}
                </button>
              )}
            </For>
          </div>

          <Show when={active()?.headline?.(bench.ctx(), t)}>
            {(headline) => (
              <span data-slot="headline" title={headline()}>
                {headline()}
              </span>
            )}
          </Show>

          <span data-slot="rule" />

          <Show when={active()?.controls} keyed>
            {(controls) => (
              <div data-slot="controls">
                <Suspense>
                  <Dynamic component={controls} />
                </Suspense>
              </div>
            )}
          </Show>

          <div data-slot="actions">
            <button
              type="button"
              aria-label={consoleUI.maximized() ? t("session.console.restore") : t("session.console.maximize")}
              title={consoleUI.maximized() ? t("session.console.restore") : t("session.console.maximize")}
              aria-pressed={consoleUI.maximized() ? "true" : "false"}
              onClick={() => consoleUI.toggleMaximized()}
            >
              <Icon name={consoleUI.maximized() ? "collapse" : "expand"} size="small" />
            </button>
            <button
              type="button"
              aria-label={t("session.console.close")}
              title={[t("session.console.close"), toggleKey()].filter(Boolean).join(" ")}
              onClick={() => consoleUI.close()}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        </div>

        <div data-slot="body" role="tabpanel">
          <Show when={active()} keyed>
            {(instrument) => (
              <Suspense fallback={<div data-slot="pending">{t("session.bench.loading")}</div>}>
                <Dynamic component={instrument.compact ?? instrument.component} />
              </Suspense>
            )}
          </Show>
        </div>
      </section>
    </Show>
  )
}
