import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { ToolPart } from "@yoma-desktop/kernel"

vi.mock("@yoma-desktop/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
import type { PartRef } from "@yoma-desktop/session-ui/message-part"
import { ContextGroupRow } from "@/pages/session/timeline/context-group-row"

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

const ref = (partID: string): PartRef => ({ messageID: "m", partID })
const tool = (id: string): ToolPart =>
  ({
    id,
    sessionID: "s",
    messageID: "m",
    callID: `call_${id}`,
    type: "tool",
    tool: "read",
    state: { status: "completed", input: {} },
  }) as ToolPart

function setup(initial: { refs: string[]; open?: Record<string, boolean> }) {
  const [state, setState] = createStore({
    refs: initial.refs.map(ref),
    open: { ...initial.open } as Record<string, boolean | undefined>,
  })
  const created: string[] = []
  const disposed: string[] = []
  dispose = render(
    () =>
      createComponent(ContextGroupRow, {
        groupKey: "context:m:p1",
        get refs() {
          return state.refs
        },
        get parts() {
          return state.refs.map((item) => tool(item.partID))
        },
        isOpen: (key) => state.open[key],
        onOpenChange: (key, open) => setState("open", key, open),
        // 一张「卡片」:记下自己被造了几次、被拆了几次,开着的时候带一段正文。
        renderCard: (item: Accessor<PartRef>) => {
          const id = item().partID
          created.push(id)
          onCleanup(() => disposed.push(id))
          const card = document.createElement("div")
          card.dataset.card = id
          return card
        },
      }),
    root,
  )
  const card = (id: string) => root.querySelector<HTMLElement>(`[data-card="${id}"]`)
  const header = () => root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
  return {
    state,
    created,
    disposed,
    card,
    header,
    arrive: (id: string) => setState("refs", (refs) => [...refs, ref(id)]),
    setOpen: (key: string, open: boolean) => setState("open", key, open),
  }
}

describe("ContextGroupRow", () => {
  // 审查发现的那个 bug:第二个 read 到的那一下,用户正开着的卡片被卸载、换成一个折叠着的组,内容当场消失。
  test("用户开着第一张卡片时第二个工具到了:卡片还是那一张、还在屏幕上,组接着开着", () => {
    const row = setup({ refs: ["p1"], open: { p1: true } })
    const before = row.card("p1")
    expect(before).not.toBeNull()
    expect(row.header()).toBeNull()

    row.arrive("p2")
    expect(row.header()).not.toBeNull()
    expect(row.card("p1")).toBe(before)
    expect(row.card("p2")).not.toBeNull()
    expect(row.disposed).toEqual([])
    expect(row.created).toEqual(["p1", "p2"])
  })

  test("第一张卡片关着时第二个到了:并成折叠着的一行,卡片不留在后台", () => {
    const row = setup({ refs: ["p1"] })
    expect(row.card("p1")).not.toBeNull()
    row.arrive("p2")
    expect(row.header()).not.toBeNull()
    expect(row.card("p1")).toBeNull()
    expect(row.card("p2")).toBeNull()
    // p2 那张会在同一拍里先被列表造出来、再随内容区一起拆掉(从没上过屏);要守的是造出来的都拆干净了。
    expect([...row.disposed].sort()).toEqual([...row.created].sort())
  })

  test("成形时定一次:之后里面的卡片各自开合,不牵动组", () => {
    const row = setup({ refs: ["p1"], open: { p1: true } })
    row.arrive("p2")
    const kept = row.card("p1")
    row.setOpen("p1", false)
    expect(row.card("p1")).toBe(kept)
    row.arrive("p3")
    expect(row.card("p3")).not.toBeNull()
    expect(row.disposed).toEqual([])
  })

  test("用户自己收起过组,以用户的为准;再展开是现造的卡片", () => {
    const row = setup({ refs: ["p1"], open: { p1: true } })
    row.arrive("p2")
    row.header()!.click()
    expect(row.state.open["context:m:p1"]).toBe(false)
    expect(row.card("p1")).toBeNull()
    row.arrive("p3")
    expect(row.card("p3")).toBeNull()
    row.header()!.click()
    expect(row.card("p1")).not.toBeNull()
    expect(row.card("p3")).not.toBeNull()
  })

  test("历史里一来就是好几个的组:折叠着,一张卡片都不造", () => {
    const row = setup({ refs: ["p1", "p2", "p3"] })
    expect(row.header()).not.toBeNull()
    expect(row.created).toEqual([])
  })

  test("历史里的组如果里面有卡片是开着的(切回这个标签页),组也开着", () => {
    const row = setup({ refs: ["p1", "p2"], open: { p2: true } })
    expect(row.card("p2")).not.toBeNull()
  })
})
