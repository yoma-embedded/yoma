import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { ToolPart } from "@yoma-desktop/kernel"

vi.mock("@yoma-desktop/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
import { ContextToolGroup } from "@yoma-desktop/session-ui/message-part"

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

const tool = (id: string, name: string, status: ToolPart["state"]["status"] = "completed"): ToolPart =>
  ({
    id,
    sessionID: "s",
    messageID: "m",
    callID: `call_${id}`,
    type: "tool",
    tool: name,
    state: { status, input: {} },
  }) as ToolPart

const mount = (props: { parts: ToolPart[]; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
  dispose = render(
    () =>
      createComponent(ContextToolGroup, {
        get parts() {
          return props.parts
        },
        get open() {
          return props.open
        },
        onOpenChange: props.onOpenChange,
        get children() {
          const item = document.createElement("div")
          item.dataset.testid = "cards"
          return item
        },
      }),
    root,
  )
  return root
}
// TextShimmer 把字画两份(底字 + 扫光层),只读底字那一份。
const title = () =>
  root.querySelector('[data-slot="basic-tool-tool-title"] [data-slot="text-shimmer-char-base"]')?.textContent
const subtitle = () => root.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent
const failed = () => root.querySelector('[data-slot="basic-tool-tool-arg"]')?.textContent
const group = () => root.querySelector<HTMLElement>('[data-component="context-tool-group"]')!

describe("ContextToolGroup", () => {
  test("折叠态一句话说完,逐张卡片不挂载", () => {
    mount({ parts: [tool("p1", "read"), tool("p2", "read"), tool("p3", "grep"), tool("p4", "ls")] })
    expect(title()).toBe("Explored")
    expect(subtitle()).toBe("2 reads · 1 search · 1 list")
    expect(failed()).toBeUndefined()
    expect(group().dataset.failed).toBeUndefined()
    expect(group().dataset.timelinePartIds).toBe("p1,p2,p3,p4")
    expect(root.querySelector('[data-testid="cards"]')).toBeNull()
  })

  test("有失败的,折叠着也看得见", () => {
    mount({ parts: [tool("p1", "read"), tool("p2", "read", "error")] })
    expect(subtitle()).toBe("2 reads")
    expect(failed()).toBe("1 failed")
    expect(group().dataset.failed).toBe("true")
  })

  test("还有没跑完的:标题换成进行时,计数先不出;跑完了再出", () => {
    const [state, setState] = createStore({ parts: [tool("p1", "read"), tool("p2", "grep", "running")] })
    mount(state)
    expect(title()).toBe("Exploring")
    expect(subtitle()).toBeUndefined()
    setState("parts", [tool("p1", "read"), tool("p2", "grep")])
    expect(title()).toBe("Explored")
    expect(subtitle()).toBe("1 read · 1 search")
  })

  test("展开状态归调用方管:点一下只回调,给了 open 才展开", () => {
    const onOpenChange = vi.fn()
    const [state, setState] = createStore({
      parts: [tool("p1", "read"), tool("p2", "read")],
      open: false,
      onOpenChange,
    })
    mount(state)
    root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(root.querySelector('[data-testid="cards"]')).toBeNull()
    setState("open", true)
    expect(root.querySelector('[data-slot="context-tool-group-list"] [data-testid="cards"]')).not.toBeNull()
  })
})
