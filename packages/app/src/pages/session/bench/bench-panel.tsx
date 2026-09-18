/**
 * 调试工作台的默认装配 —— 状态条 + 注册表驱动的仪器窗口堆叠 + "+ 仪器"。
 *
 * 这是**一种**摆法,不是唯一一种:四个布局变体各自拿 `useBenchStatus()` / `useBenchDisk()` /
 * `visibleInstruments()` / `<TargetStrip>` 重新摆一遍即可,这个文件可以整个不要。
 * 真正共用的是它下面那四样,不是这里的 flex 列。
 */
import { createMemo, For, Show, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import type { InstrumentId } from "./bench-status"
import { useBenchStatus } from "./use-bench-status"
import { useBenchDisk } from "./bench-disk"
import {
  benchPins,
  hiddenInstruments,
  instrumentById,
  isVisible,
  visibleInstruments,
  type InstrumentContext,
  type InstrumentDef,
} from "./instruments"
import { TargetStrip } from "./target-strip"
// bench.css 住在 session-ui(时间线里的硬件工具卡片与这些面板共用同一套原语),
// 经 `@yoma-desktop/session-ui/styles` 进样式表 —— app 的 index.css 已经 import 了那一份。

export function BenchPanel() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const status = useBenchStatus()

  // 重探磁盘的时机:碰过的仪器多了一台,或者 la / scope / log 出了新东西。
  // 不轮询 —— 新证据一定先经工具卡片进 transcript,那条路已经把这里叫醒了。
  const disk = useBenchDisk(() =>
    [status().used.size, status().la?.id, status().scope?.id, status().log?.file].join("|"),
  )

  const ctx = createMemo<InstrumentContext>(() => ({ status: status(), disk: disk(), pinned: benchPins.all() }))
  const visible = createMemo(() => visibleInstruments(ctx()))
  const hidden = createMemo(() => hiddenInstruments(ctx()))

  /** 状态条点一格 = 滚到那台仪器。抽屉 / 标签页那几种摆法在自己的变体里换掉这个回调。 */
  const reveal = (id: InstrumentId) => {
    // 只在它此刻**藏着**时才钉 —— 点一下已经在屏幕上的那台不该往 localStorage 里留一条永久记录。
    const instrument = instrumentById(id)
    if (instrument && !isVisible(instrument, ctx())) benchPins.pin(id)
    queueMicrotask(() => {
      document
        .querySelector(`[data-component="bench-window"][data-instrument="${id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  }

  return (
    <div class="ybench" data-component="bench-panel">
      <TargetStrip status={status()} onSelect={reveal} emptyHint={t("session.bench.strip.empty")} />

      <div data-slot="windows">
        <For each={visible()}>{(instrument) => <InstrumentWindow def={instrument} ctx={ctx()} />}</For>
      </div>

      <Show when={hidden().length > 0}>
        <div data-component="bench-instrument-picker">
          <span>{t("session.bench.add")}</span>
          <For each={hidden()}>
            {(instrument) => (
              <button type="button" data-instrument={instrument.id} onClick={() => benchPins.pin(instrument.id)}>
                {t(instrument.labelKey)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function InstrumentWindow(props: { def: InstrumentDef; ctx: InstrumentContext }) {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const state = () => props.def.status(props.ctx)
  /**
   * 只有"纯靠钉住才在这儿"的窗口给收起按钮 —— 核心仪器、用过的、有数据的,
   * 收起来也会立刻回来,那个按钮是骗人的。
   */
  const canUnpin = () =>
    props.ctx.pinned.has(props.def.id) &&
    props.def.tier !== "core" &&
    !props.ctx.status.used.has(props.def.id) &&
    !props.def.hasData(props.ctx)

  return (
    <section data-component="bench-window" data-instrument={props.def.id} data-state={state()}>
      <div data-component="bench-panel-head">
        <span data-slot="title">
          <span data-component="bench-led" data-state={state()} />
          <Icon name={props.def.icon} size="small" />
          {t(props.def.labelKey)}
        </span>
        <span data-slot="rule" />
        <Show when={canUnpin()}>
          <span data-slot="actions">
            <button
              type="button"
              data-slot="unpin"
              aria-label={t("session.bench.unpin")}
              title={t("session.bench.unpin")}
              onClick={() => benchPins.unpin(props.def.id)}
            >
              ×
            </button>
          </span>
        </Show>
      </div>
      <div data-slot="body">
        <Suspense fallback={<div data-slot="pending">{t("session.bench.loading")}</div>}>
          <Dynamic component={props.def.component} />
        </Suspense>
      </div>
    </section>
  )
}
