// @vitest-environment happy-dom
/**
 * 卡片上那个「在面板中打开」的闸门。
 *
 * 两条是这个按钮存在的全部理由,所以都要真渲染一遍而不是只测纯函数:
 * 1. **宿主没给回调时一个像素都不渲染** —— 它挂在**所有**工具卡片的外壳上,
 *    渲染出来就等于每张 log / gdb 卡右上角都多一个点了没反应的按钮。
 * 2. **点它带着仪器 id 与这一条 part 回调回去** —— 宿主要靠 part 认出这一次采集。
 *
 * session-ui 的 vitest 缺省跑在 node 上(其余用例都是纯函数),这一份用文件头的
 * `@vitest-environment` 单独要一个 DOM,不动共享的 vitest.config.ts。
 */
import { createComponent, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, describe, expect, test } from "vitest"
import type { ToolPart } from "@yoma-desktop/kernel"
import { DataProvider, type OpenInstrumentFn } from "../context/data"
import { instrumentOfTool, OpenInstrumentButton } from "./open-instrument"

function toolPart(tool: string): ToolPart {
  return {
    id: `prt_${tool}`,
    sessionID: "ses_demo",
    messageID: "msg_1",
    callID: `call_${tool}`,
    type: "tool",
    tool,
    state: {
      status: "completed",
      input: { action: "status" },
      output: "ok",
      title: tool,
      metadata: { action: "status", captureId: "la-0001" },
      time: { start: 1, end: 2 },
    },
  }
}

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length) disposers.pop()!()
  document.body.innerHTML = ""
})

/** 把按钮挂进一个真 DataProvider 底下,返回容器。 */
function mount(part: ToolPart, onOpenInstrument?: OpenInstrumentFn) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DataProvider, {
        data: { session: [], session_status: {}, message: {}, part: {} },
        directory: "/work/f405-motor-ctrl",
        onOpenInstrument,
        get children(): JSX.Element {
          return createComponent(OpenInstrumentButton, { part })
        },
      }),
    host,
  )
  disposers.push(dispose)
  return host
}

const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-component="bench-card-open"]')

describe("instrumentOfTool", () => {
  test("四台有面板的仪器各自认得出来", () => {
    expect(["log", "gdb", "la", "scope"].map(instrumentOfTool)).toEqual(["log", "gdb", "la", "scope"])
  })

  test("flash 不是仪器(它没有面板),别的工具也不是", () => {
    expect(instrumentOfTool("flash")).toBeUndefined()
    expect(instrumentOfTool("bash")).toBeUndefined()
    expect(instrumentOfTool("")).toBeUndefined()
  })
})

describe("OpenInstrumentButton", () => {
  test("宿主没给回调:一个节点都不渲染", () => {
    const host = mount(toolPart("gdb"))
    expect(button(host)).toBeNull()
    expect(host.textContent).toBe("")
  })

  test("有回调:渲染出按钮,带着仪器名与可读的标签", () => {
    const host = mount(toolPart("gdb"), () => {})
    const element = button(host)
    expect(element).not.toBeNull()
    expect(element!.dataset.instrument).toBe("gdb")
    // 不钉死某一种语言(没有 I18nProvider 时 `useI18n` 落到词典的缺省语言),钉的是
    // **两份词典里都有这一条** —— 缺键时 solid 的 translator 返回 undefined,
    // aria-label 会整个不见,而那正是这个断言要挡的事。
    const label = element!.getAttribute("aria-label")
    expect(label).toBeTruthy()
    expect(label).not.toBe("ui.tool.openInPanel")
    expect(element!.getAttribute("title")).toBe(label)
  })

  test("点它:带着仪器 id 与这一条 part 回调回去", () => {
    const calls: Array<[string, ToolPart]> = []
    const part = toolPart("la")
    const host = mount(part, (id, clicked) => calls.push([id, clicked]))
    button(host)!.click()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("la")
    // part 原样递过去:宿主要从 metadata 里认出是哪一次采集。
    expect(calls[0][1]).toBe(part)
    expect(calls[0][1].state.status === "completed" && calls[0][1].state.metadata.captureId).toBe("la-0001")
  })

  test("flash 有回调也不渲染 —— 它没有面板可打开", () => {
    const host = mount(toolPart("flash"), () => {})
    expect(button(host)).toBeNull()
  })

  test("别的工具(bash / read)不渲染", () => {
    expect(button(mount(toolPart("bash"), () => {}))).toBeNull()
    expect(button(mount(toolPart("read"), () => {}))).toBeNull()
  })
})
