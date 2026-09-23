/**
 * 右栏的「按需仪器页」—— 示波器、逻辑分析仪,以及调试器的家。
 *
 * 一次只摊开一台:**点名要的那一台**(`consoleUI.rail()`,由左侧栏的「仪器」、状态栏的格子、
 * 时间线卡片上的「在面板中打开」决定)。
 *
 * 从前这里自己还有一排页签和底部的「+ 仪器」:页签按"本会话用过 ∪ 磁盘上有采集 ∪ 钉住"露面,于是
 * 工程里存过示波器采集,示波器就自己挂在上面 —— 用户没开过,却占着一行(2026-09-23 用户指出)。
 * 左侧栏已经列着全部仪器、带着灯和"有新东西"的点,这里再列一遍只是重复,删掉了。
 * 当前是哪一台写在右栏顶上那一行的模式按钮里(session-side-panel.tsx)。
 */
import { createMemo, Show, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { useBench } from "../bench/bench-context"
import { visibleOnSurface, type InstrumentDef } from "../bench/instruments"
import { consoleUI } from "./console-state"
import { useMarkSeen } from "./evidence-view"
import "./console.css"

export function InstrumentRail() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const bench = useBench()

  const visible = createMemo(() => visibleOnSurface("wave", bench.ctx()))

  // 只显示点名要的那一台。没有记录、或者那台这会儿不该露面,就是空态,
  // 不拿登记序里的第一台顶上 —— 打开日志不该把调试器或示波器一起打开。
  const active = createMemo<InstrumentDef | undefined>(() => {
    const want = consoleUI.rail()
    return want ? visible().find((instrument) => instrument.id === want) : undefined
  })

  // 提示点:这一页开着就算看过了(这个组件只在右栏展开且停在「仪器」档时才挂上,
  // 所以"右栏收着的时候证据继续积累"是白得的)。
  useMarkSeen(() => active()?.id)

  return (
    <div class="ybench" data-component="instrument-rail">
      <Show
        when={active()}
        fallback={
          <div data-slot="empty">
            <div data-component="bench-empty">
              {t("session.rail.empty")}
              <span data-slot="hint">{t("session.rail.emptyHint")}</span>
            </div>
          </div>
        }
      >
        {(instrument) => (
          <div data-slot="body" role="region" aria-label={t(instrument().labelKey)}>
            <Suspense fallback={<div data-slot="pending">{t("session.bench.loading")}</div>}>
              <Dynamic component={instrument().component} />
            </Suspense>
          </div>
        )}
      </Show>
    </div>
  )
}
