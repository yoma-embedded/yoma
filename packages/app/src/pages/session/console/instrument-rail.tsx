/**
 * 右栏的「按需仪器页」—— 波形类仪器(逻辑分析仪、示波器,将来的功耗曲线)的家。
 *
 * 与 foundation 那份 `BenchPanel` 的三点不同:
 * 1. **只收 `surface === "wave"` 的那些。** 文本流去了底部控制台 —— 一条 480px 宽的右栏对
 *    日志和 gdb 报告来说太窄,对一张横轴是时间的图来说却正合适。
 * 2. **不堆叠。** 两台以上时用页内小页签换,而不是上下顶着 —— 堆叠的代价是每台都只剩半屏,
 *    而你同时只看得懂一张波形。
 * 3. **一台都不该露面时是安静的空态**,不是两个不亮的大窗口。露面的规则仍是注册表那一条
 *    (核心 ∪ 本会话用过 ∪ 磁盘上有数据 ∪ 钉住),这里一个字都没重写。
 */
import { createEffect, createMemo, For, on, Show, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import { useBench } from "../bench/bench-context"
import { benchPins, hiddenOnSurface, visibleOnSurface, type InstrumentDef } from "../bench/instruments"
import { consoleUI } from "./console-state"
import "./console.css"

export function InstrumentRail() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const bench = useBench()

  const visible = createMemo(() => visibleOnSurface("wave", bench.ctx()))
  const hidden = createMemo(() => hiddenOnSurface("wave", bench.ctx()))

  const active = createMemo<InstrumentDef | undefined>(() => {
    const list = visible()
    return list.find((instrument) => instrument.id === consoleUI.rail()) ?? list[0]
  })

  // 存着的那台不在了(换了会话 / 取消了钉住)就把选择挪到还在的那台上。
  createEffect(
    on(active, (instrument) => {
      if (instrument && instrument.id !== consoleUI.rail()) consoleUI.setRail(instrument.id)
    }),
  )

  return (
    <div class="ybench" data-component="instrument-rail">
      {/* 一台的时候不出页签行 —— 一个孤零零的页签只是噪声,名字在仪器自己的名牌上。 */}
      <Show when={visible().length > 1}>
        <div data-slot="tablist" role="tablist" aria-label={t("session.rail.label")}>
          <For each={visible()}>
            {(instrument) => (
              <button
                type="button"
                role="tab"
                data-slot="tab"
                data-instrument={instrument.id}
                aria-selected={active()?.id === instrument.id ? "true" : "false"}
                onClick={() => consoleUI.setRail(instrument.id)}
              >
                <span data-component="bench-led" data-state={instrument.status(bench.ctx())} />
                <Icon name={instrument.icon} size="small" />
                {t(instrument.labelKey)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={active()}
        fallback={
          <div data-slot="empty">
            <div data-component="bench-empty">
              {t("session.rail.empty")}
              <span data-slot="hint">{t("session.rail.emptyHint")}</span>
            </div>
            <Picker instruments={hidden()} />
          </div>
        }
      >
        {(instrument) => (
          <>
            <div data-slot="body" role="tabpanel">
              <Suspense fallback={<div data-slot="pending">{t("session.bench.loading")}</div>}>
                <Dynamic component={instrument().component} />
              </Suspense>
            </div>
            <Show when={hidden().length > 0}>
              <div data-slot="footer">
                <Picker instruments={hidden()} />
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

/** 「+ 仪器」。钉住之后顺手切过去 —— 点了它却什么都没变才是最让人困惑的。 */
function Picker(props: { instruments: InstrumentDef[] }) {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  return (
    <Show when={props.instruments.length > 0}>
      <div data-component="bench-instrument-picker">
        <span>{t("session.bench.add")}</span>
        <For each={props.instruments}>
          {(instrument) => (
            <button
              type="button"
              data-instrument={instrument.id}
              onClick={() => {
                benchPins.pin(instrument.id)
                consoleUI.setRail(instrument.id)
              }}
            >
              {t(instrument.labelKey)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
