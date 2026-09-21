import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { render } from "solid-js/web"
import type { Part } from "@yoma-desktop/kernel"

// 文案按键名渲染,断言不依赖中英任何一份词典。
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))

import { TimelineSearch } from "@/pages/session/timeline/timeline-search"
import { SEARCH_ACTIVE, SEARCH_HIT } from "@/pages/session/timeline/search"

// 测试环境没有 CSS Custom Highlight API:装一个只记账的替身,看组件往里放了什么。
const painted = new Map<string, Set<Range>>()
beforeAll(() => {
  vi.stubGlobal("Highlight", class extends Set<Range> {})
  vi.stubGlobal("CSS", {
    ...globalThis.CSS,
    highlights: {
      set: (name: string, value: Set<Range>) => painted.set(name, value),
      delete: (name: string) => painted.delete(name),
    },
  })
})

let dispose: (() => void) | undefined
const host = document.createElement("div")
const timeline = document.createElement("div")
document.body.append(host, timeline)
afterEach(() => {
  dispose?.()
  dispose = undefined
  host.replaceChildren()
  timeline.replaceChildren()
  painted.clear()
})

const text = (id: string, value: string): Part => ({ id, sessionID: "s", messageID: "m", type: "text", text: value })
const settle = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

/** 时间线的替身:每个 part 画成一个带 id 的块,字就是它的正文。rows 里没列的 part 算"在屏幕外",不画。 */
function setup(initial: Part[], options: { rendered?: string[]; firstVisibleRow?: number } = {}) {
  const [state, setState] = createStore({ parts: initial, tick: 0 })
  const revealed: string[] = []
  let closed = 0
  const draw = () => {
    timeline.replaceChildren(
      ...state.parts
        .filter((part) => !options.rendered || options.rendered.includes(part.id))
        .map((part) => {
          const el = document.createElement("div")
          el.dataset.timelinePartId = part.id
          el.textContent = part.type === "text" ? part.text : ""
          return el
        }),
    )
  }
  draw()
  dispose = render(
    () =>
      createComponent(TimelineSearch, {
        get parts() {
          return state.parts
        },
        rowOf: (partID) => state.parts.findIndex((part) => part.id === partID),
        firstVisibleRow: () => options.firstVisibleRow ?? 0,
        showReasoning: true,
        root: timeline,
        partial: false,
        get focusTick() {
          return state.tick
        },
        onReveal: (partID) => revealed.push(partID),
        onClose: () => (closed += 1),
      }),
    host,
  )
  const input = host.querySelector<HTMLInputElement>('[data-slot="timeline-search-input"]')!
  return {
    state,
    setState,
    draw,
    revealed,
    closed: () => closed,
    input,
    type: (value: string) => {
      input.value = value
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    },
    key: (key: string, init: KeyboardEventInit = {}) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })),
    count: () => host.querySelector('[data-slot="timeline-search-count"]')?.textContent,
    hits: () => [...(painted.get(SEARCH_HIT) ?? [])].map((range) => range.toString()),
    active: () =>
      [...(painted.get(SEARCH_ACTIVE) ?? [])].map(
        (range) => range.startContainer.parentElement?.dataset.timelinePartId,
      ),
  }
}

describe("TimelineSearch", () => {
  test("打字停下来才搜;计数是整个会话的,当前那一处被带去显示并单独上色", async () => {
    const h = setup([text("p1", "UART overrun"), text("p2", "no match here"), text("p3", "uart again, UART twice")])
    expect(document.activeElement).toBe(h.input)
    h.type("uart")
    expect(h.count()).toBeUndefined()
    await settle()
    expect(h.count()).toBe("1/3")
    expect(h.revealed).toEqual(["p1"])
    expect(h.active()).toEqual(["p1"])
    expect(h.hits()).toEqual(["uart", "UART"])
  })

  test("回车下一处、Shift+回车上一处,到头绕回去;每一下都把那一处带去显示", async () => {
    const h = setup([text("p1", "spi"), text("p2", "spi spi")])
    h.type("spi")
    await settle()
    h.key("Enter")
    expect(h.count()).toBe("2/3")
    h.key("Enter")
    expect(h.count()).toBe("3/3")
    h.key("Enter")
    expect(h.count()).toBe("1/3")
    h.key("Enter", { shiftKey: true })
    expect(h.count()).toBe("3/3")
    expect(h.revealed).toEqual(["p1", "p2", "p2", "p1", "p2"])
  })

  test("从眼前找起:视口在第 2 行,第一下落在第 2 行及以后的第一处,不是会话开头", async () => {
    const h = setup([text("p0", "can"), text("p1", "can"), text("p2", "can"), text("p3", "can")], {
      firstVisibleRow: 2,
    })
    h.type("can")
    await settle()
    expect(h.count()).toBe("3/4")
    expect(h.revealed).toEqual(["p2"])
  })

  test("还在防抖里就按回车:先把词落下去,不是在旧词的结果里跳", async () => {
    const h = setup([text("p1", "i2c nack"), text("p2", "i2c ack")])
    h.type("nack")
    h.key("Enter")
    expect(h.count()).toBe("1/1")
    expect(h.revealed).toEqual(["p1"])
  })

  test("流式输出时计数跟着长,当前停在哪一处不变", async () => {
    const h = setup([text("p1", "fault"), text("p2", "streaming")])
    h.type("fault")
    await settle()
    expect(h.count()).toBe("1/1")
    h.setState(
      produce((draft) => {
        ;(draft.parts[1] as { text: string }).text = "streaming ... HardFault then BusFault"
      }),
    )
    expect(h.count()).toBe("1/3")
  })

  test("屏幕外的命中照样计数;画出来之后(虚拟列表换了行)高亮自己补上", async () => {
    const h = setup([text("p1", "dma"), text("far", "dma dma")], { rendered: ["p1"] })
    h.type("dma")
    await settle()
    expect(h.count()).toBe("1/3")
    expect(h.hits()).toEqual([])
    h.key("Enter")
    expect(h.revealed.at(-1)).toBe("far")
    const el = document.createElement("div")
    el.dataset.timelinePartId = "far"
    el.textContent = "dma dma"
    timeline.append(el)
    await frame()
    await frame()
    expect(h.active()).toEqual(["far"])
    expect(h.hits()).toEqual(["dma", "dma"])
  })

  test("没有结果说没有结果,上一处 / 下一处按不动", async () => {
    const h = setup([text("p1", "nothing")])
    h.type("zzz")
    await settle()
    expect(h.count()).toBe("session.search.noResults")
    expect(h.revealed).toEqual([])
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="timeline-search-button"]')]
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, false])
  })

  test("Esc 关掉;卸载时把高亮清干净", async () => {
    const h = setup([text("p1", "pwm pwm")])
    h.type("pwm")
    await settle()
    expect(painted.has(SEARCH_HIT)).toBe(true)
    h.key("Escape")
    expect(h.closed()).toBe(1)
    dispose?.()
    dispose = undefined
    expect(painted.has(SEARCH_HIT)).toBe(false)
    expect(painted.has(SEARCH_ACTIVE)).toBe(false)
  })

  test("再按一次 cmd+F:焦点回到输入框并全选", async () => {
    const h = setup([text("p1", "adc")])
    h.type("adc")
    h.input.blur()
    h.setState("tick", 1)
    expect(document.activeElement).toBe(h.input)
    expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([0, 3])
  })
})
