/**
 * 左侧栏留给"当前页面"的一格:会话页 / 草稿页把自己的仪器入口(串口、GDB、示波器、逻辑分析仪)画进来。
 *
 * 为什么是一格而不是侧栏自己画:仪器的灯与"点一下打开哪里"都要这一会话的仪器上下文(BenchProvider),
 * 而侧栏在它外面。页面用 Portal 画进这一格,Portal 保留页面那边的上下文;离开会话页,这一格自然空着。
 */
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

// DOM 节点不是普通对象,store 不会去包它。
const [slot, setSlot] = createStore({ instruments: undefined as HTMLElement | undefined })

export const sidebarInstrumentSlot = () => slot.instruments

/** 侧栏挂上那一格时调(ref 里);侧栏卸载时自动收回。 */
export function registerSidebarInstrumentSlot(element: HTMLElement) {
  setSlot("instruments", element)
  onCleanup(() => {
    if (slot.instruments === element) setSlot("instruments", undefined)
  })
}
