/**
 * /btw 顺便问一句的坞(pages/session/composer/session-btw-dock.tsx,docs/btw顺便问-设计方案-20260924.md §4.8)。
 * 数据是内核的 `session.btw` 整条快照;这里钉的是每种状态下画什么、哪些按钮在、点了调谁。
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import type { BtwView } from "@yoma-desktop/kernel"

// 文案按键名渲染(带参数时拼上参数),断言不依赖中英任何一份词典。
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}))

// 真的 Markdown 要 session-ui 的 marked / i18n 上下文;这里只关心交给它的正文与是不是流式。
vi.mock("@yoma-desktop/session-ui/markdown", async () => {
  const { createEffect } = await import("solid-js")
  return {
    Markdown: (props: { text: string; streaming?: boolean }) => {
      const div = document.createElement("div")
      div.setAttribute("data-testid", "markdown")
      createEffect(() => {
        div.textContent = props.text
        div.setAttribute("data-streaming", String(!!props.streaming))
      })
      return div
    },
  }
})

import { SessionBtwDock } from "../src/pages/session/composer/session-btw-dock"

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)

afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

const view = (input: Partial<BtwView> = {}): BtwView => ({
  id: "btw_1",
  sessionID: "main",
  question: "这个寄存器是干嘛的",
  status: "thinking",
  text: "",
  startedAt: 100,
  ...input,
})

/** 按可访问名找按钮:文字按钮看正文,图标按钮看 aria-label。 */
const button = (text: string) =>
  [...root.querySelectorAll("button")].find(
    (el) => (el.textContent ?? "").trim() === text || el.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined

function mount(initial: BtwView) {
  const calls = { dismiss: vi.fn(), fork: vi.fn(), copy: vi.fn() }
  const [props, setProps] = createStore({
    view: initial,
    forking: false,
    onDismiss: calls.dismiss,
    onFork: calls.fork,
    onCopy: calls.copy,
    attached: true,
  })
  dispose = render(() => createComponent(SessionBtwDock, props), root)
  return { calls, setProps }
}

describe("/btw 的坞", () => {
  test("在想:问题摆在坞头,显示「思考中」;只能关,不能复制、不能转后台", () => {
    const { calls } = mount(view())
    expect(root.textContent).toContain("这个寄存器是干嘛的")
    expect(root.textContent).toContain("session.btwDock.thinking")
    expect(button("session.btwDock.copy")).toBeUndefined()
    expect(button("session.btwDock.fork")).toBeUndefined()
    button("session.btwDock.close")!.click()
    expect(calls.dismiss).toHaveBeenCalledTimes(1)
  })

  test("边想边出字:正文交给 Markdown、按流式画;答完了不再流式,能复制、能转后台", () => {
    const { calls, setProps } = mount(view({ status: "answering", text: "它是" }))
    const markdown = () => root.querySelector("[data-testid=markdown]")!
    expect(markdown().textContent).toBe("它是")
    expect(markdown().getAttribute("data-streaming")).toBe("true")

    setProps("view", reconcile(view({ status: "done", text: "它是 RCC 的基地址" })))
    expect(markdown().textContent).toBe("它是 RCC 的基地址")
    expect(markdown().getAttribute("data-streaming")).toBe("false")
    button("session.btwDock.copy")!.click()
    button("session.btwDock.fork")!.click()
    expect(calls.copy).toHaveBeenCalledTimes(1)
    expect(calls.fork).toHaveBeenCalledTimes(1)
    // 坞头三个都是图标按钮:没有文字,名字在 aria-label 上(用户定)。
    for (const name of ["session.btwDock.copy", "session.btwDock.fork", "session.btwDock.close"]) {
      expect(button(name)!.getAttribute("aria-label")).toBe(name)
      expect((button(name)!.textContent ?? "").trim()).toBe("")
    }

    // 正在转后台:按钮锁住,免得连点派出两个。
    setProps("forking", true)
    expect(button("session.btwDock.fork")!.disabled).toBe(true)
  })

  test("失败带原因;模型什么都没回;模型想调工具;附件提示", () => {
    const { setProps } = mount(view({ status: "failed", error: "503 Service Unavailable" }))
    expect(root.textContent).toContain('session.btwDock.failed{"error":"503 Service Unavailable"}')
    expect(button("session.btwDock.fork")).toBeUndefined()

    setProps("view", reconcile(view({ status: "failed" })))
    expect(root.textContent).toContain("session.btwDock.empty")

    setProps(
      "view",
      reconcile(view({ status: "done", text: "", attemptedTool: "read", notices: ["附件 manual.pdf 不是图片"] })),
    )
    expect(root.textContent).toContain('session.btwDock.attemptedTool{"tool":"read"}')
    expect(root.textContent).toContain("附件 manual.pdf 不是图片")
    // 没有正文就没有可复制的,但答完了照样能转后台。
    expect(button("session.btwDock.copy")).toBeUndefined()
    expect(button("session.btwDock.fork")).toBeDefined()
  })
})
