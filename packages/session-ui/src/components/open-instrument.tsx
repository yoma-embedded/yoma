/**
 * 时间线里硬件卡片右上角的「在面板中打开」。
 *
 * 为什么要有它:v5 的卡片把**这一次**动作的结论说清楚了(`● 逻辑分析仪 import … · 131k @ 25 MHz`),
 * 但看波形、翻整份日志、读完整条调用栈要的是面板。从卡片直接跳过去,比"记得右栏有第三档、
 * 再去里面找那台仪器"少两步,而且落点是**看的这一条证据**对应的那台仪器。
 *
 * 三条规矩:
 * 1. **宿主不给回调就一个像素都不渲染。** 打不打得开面板是布局的事:v2-console 有底部控制台
 *    和右栏,别的宿主(将来的 web、storybook)可能什么都没有。
 * 2. **只有有面板的仪器才有按钮。** flash 是动作不是仪器,它没有面板 —— 给它一个点了没反应的
 *    按钮比没有按钮糟得多。清单就是 `InstrumentTool` 那四个。
 * 3. **跟折叠箭头同一套出现规矩**:平时透明(而且 `pointer-events: none`,见 open-instrument.css),
 *    悬停 / 聚焦 / 卡片展开时才现身。一屏五张 log 卡片上不该永远挂着五个按钮。
 *
 * 位置是绝对定位在卡片右上角(折叠行那一行的右端),不是排在折叠行里面 ——
 * 折叠行整个是一个 `<button>`(Kobalte 的 Collapsible.Trigger),按钮不能套按钮。
 * 因此 `stopPropagation` 是承重的:它压在折叠触发器上面,不拦的话点它会顺手把卡片折起来。
 */
import { Show } from "solid-js"
import type { ToolPart } from "@yoma-desktop/kernel"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { Icon } from "@yoma-desktop/ui/icon"
import { useData } from "../context"
import type { InstrumentTool } from "../context/data"

/** 有面板的工具。与 `InstrumentTool` 同一套词,加一台仪器时这里加一条。 */
const INSTRUMENT_TOOLS: readonly InstrumentTool[] = ["log", "gdb", "la", "scope"]

/**
 * 这个工具名对应哪台仪器 —— 不是仪器(flash / bash / read …)时返回 undefined。
 * 纯函数,单测直接喂字符串。
 */
export function instrumentOfTool(tool: string): InstrumentTool | undefined {
  return INSTRUMENT_TOOLS.find((id) => id === tool)
}

export function OpenInstrumentButton(props: { part: ToolPart }) {
  const data = useData()
  const i18n = useI18n()
  const target = () => {
    const open = data.openInstrument
    const id = instrumentOfTool(props.part.tool)
    return open && id ? { open, id } : undefined
  }

  return (
    <Show when={target()}>
      {(hit) => (
        <button
          type="button"
          data-component="bench-card-open"
          data-instrument={hit().id}
          aria-label={i18n.t("ui.tool.openInPanel")}
          title={i18n.t("ui.tool.openInPanel")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            hit().open(hit().id, props.part)
          }}
        >
          <Icon name="square-arrow-top-right" size="small" />
          <span data-slot="text">{i18n.t("ui.tool.openInPanel")}</span>
        </button>
      )}
    </Show>
  )
}
