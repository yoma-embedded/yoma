import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { FileDiffMetadata } from "@pierre/diffs"
import type { Part } from "@yoma-desktop/kernel"

// 文案按键名渲染(带参数时拼上参数),断言不依赖中英任何一份词典。
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}))

import { FileComponentProvider } from "@yoma-desktop/ui/context/file"
import { TurnChangesRow } from "@/pages/session/timeline/turn-changes-row"

// 上游 edit 工具的真实 patch:+2 −2,两个 hunk(同 session-ui 的 turn-changes.test.ts)。
const EDIT_PATCH =
  "--- src/main.c\n+++ src/main.c\n@@ -1,9 +1,10 @@\n line 1\n line 2\n line 3\n line 4\n-line 5\n+line five\n+line 5b\n line 6\n line 7\n line 8\n line 9\n@@ -21,9 +22,8 @@\n line 21\n line 22\n line 23\n line 24\n-line 25\n line 26\n line 27\n line 28\n line 29\n"

let seq = 0
const tool = (name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}): Part => {
  seq += 1
  return {
    id: `p${seq}`,
    sessionID: "s",
    messageID: "m",
    callID: `c${seq}`,
    type: "tool",
    tool: name,
    state: { status: "completed", input, output: "", title: name, metadata, time: { start: 1, end: 2 } },
  } as Part
}

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

// diff 视图的替身:把收到的那份 diff 的逐 hunk 行数写出来。真的那个要 shiki + worker,不是这个测试要管的。
function FakeFile(props: { mode: string; fileDiff: FileDiffMetadata }) {
  const el = document.createElement("div")
  el.dataset.fakeDiff = props.mode
  el.textContent = props.fileDiff.hunks.map((hunk) => `+${hunk.additionLines}-${hunk.deletionLines}`).join(" ")
  return el
}

function setup(parts: Part[], open: Record<string, boolean | undefined> = {}) {
  const [state, setState] = createStore({ open: { ...open } })
  const mount = () => {
    dispose = render(
      () =>
        createComponent(FileComponentProvider, {
          component: FakeFile,
          get children() {
            return createComponent(TurnChangesRow, {
              rowKey: "turn-changes:u1",
              parts,
              directory: "/work/fw",
              isOpen: (key) => state.open[key],
              onOpenChange: (key, value) => setState("open", key, value),
            })
          },
        }),
      root,
    )
  }
  mount()
  const item = (file: string) => root.querySelector<HTMLElement>(`[data-slot="accordion-item"][data-file="${file}"]`)
  return {
    state,
    mount,
    item,
    label: () => root.querySelector('[data-slot="session-turn-diffs-label"]')?.textContent,
    items: () =>
      Array.from(root.querySelectorAll<HTMLElement>('[data-slot="accordion-item"]')).map((el) => el.dataset.file),
    trigger: (file: string) => item(file)!.querySelector<HTMLElement>('[data-slot="accordion-trigger"]')!,
    diffs: (file: string) => item(file)!.querySelectorAll("[data-fake-diff]").length,
  }
}

describe("TurnChangesRow", () => {
  test("标题说改了几个文件;每个文件一行,缺省都收着、不解析出 diff 视图", () => {
    const h = setup([
      tool("edit", { path: "src/main.c" }, { patch: EDIT_PATCH }),
      tool("write", { path: "README.md", content: "# fw\n" }, { before: null }),
    ])
    expect(h.label()).toBe('session.turnChanges.title.other{"count":2}')
    expect(h.items()).toEqual(["src/main.c", "README.md"])
    expect(root.querySelectorAll("[data-fake-diff]")).toHaveLength(0)
    expect(h.item("README.md")!.textContent).toContain("session.turnChanges.created")
    expect(h.item("src/main.c")!.textContent).not.toContain("session.turnChanges.created")
  })

  test("点开一个文件画出它的 diff,状态记到外面;再点收起", () => {
    const h = setup([tool("edit", { path: "src/main.c" }, { patch: EDIT_PATCH })])
    expect(h.label()).toBe('session.turnChanges.title.one{"count":1}')
    h.trigger("src/main.c").click()
    expect(h.state.open["turn-changes:u1:/work/fw/src/main.c"]).toBe(true)
    expect(h.diffs("src/main.c")).toBe(1)
    expect(h.item("src/main.c")!.querySelector("[data-fake-diff]")!.textContent).toBe("+2-1 +0-1")
    h.trigger("src/main.c").click()
    expect(h.state.open["turn-changes:u1:/work/fw/src/main.c"]).toBe(false)
    expect(h.diffs("src/main.c")).toBe(0)
  })

  // 时间线是虚拟列表:这一行滚出去就卸载,滚回来重新挂。展开状态在外面,回来时应当原样开着。
  test("卸载再挂上,之前点开的文件还开着", () => {
    const h = setup([tool("edit", { path: "src/main.c" }, { patch: EDIT_PATCH })])
    h.trigger("src/main.c").click()
    dispose?.()
    root.replaceChildren()
    h.mount()
    expect(h.diffs("src/main.c")).toBe(1)
  })

  test("同一个文件一轮里改了两次:一行,点开是两份 diff、各带一行「第几次」", () => {
    const h = setup(
      [
        tool("write", { path: "cfg.h", content: "#define A 1\n" }, { before: null }),
        tool("write", { path: "/work/fw/cfg.h", content: "#define A 2\n" }, { before: "#define A 1\n" }),
      ],
      { "turn-changes:u1:/work/fw/cfg.h": true },
    )
    expect(h.items()).toEqual(["cfg.h"])
    expect(h.diffs("cfg.h")).toBe(2)
    const steps = Array.from(h.item("cfg.h")!.querySelectorAll('[data-slot="session-turn-diff-step"]'))
    expect(steps.map((el) => el.textContent)).toEqual([
      'session.turnChanges.step{"index":1,"total":2}',
      'session.turnChanges.step{"index":2,"total":2}',
    ])
  })

  test("没记下内容的 write(旧会话):文件照列,标明未记录,点不开", () => {
    const h = setup([tool("write", { path: "legacy.c", content: "x\n" })])
    expect(h.item("legacy.c")!.textContent).toContain("session.turnChanges.opaque")
    h.trigger("legacy.c").click()
    expect(h.state.open["turn-changes:u1:/work/fw/legacy.c"]).toBeUndefined()
    expect(h.diffs("legacy.c")).toBe(0)
  })

  test("超过 10 个文件先列 10 个,「还有 N 个」点开列全", () => {
    const h = setup(
      Array.from({ length: 12 }, (_, i) => tool("write", { path: `f${i}.c`, content: "x\n" }, { before: null })),
    )
    expect(h.items()).toHaveLength(10)
    const more = root.querySelector<HTMLElement>('[data-slot="session-turn-diffs-more"]')!
    expect(more.textContent).toBe('session.turnChanges.more{"count":2}')
    more.click()
    expect(h.items()).toHaveLength(12)
  })
})
