import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, ToolPart } from "@yoma-desktop/kernel"

vi.mock("@yoma-desktop/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
// 「在面板中打开」读 Data 上下文的可选回调:不给,它一个像素都不渲染。
vi.mock("@yoma-desktop/session-ui/context", () => ({ useData: () => ({ store: {} }) }))
import { Part } from "@yoma-desktop/session-ui/message-part"

const message: AssistantMessage = {
  id: "m",
  sessionID: "s",
  role: "assistant",
  parentID: "u",
  time: { created: 1 },
  providerID: "p",
  modelID: "x",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const call = (state: ToolPart["state"], tool = "bash"): ToolPart => ({
  id: "p1",
  sessionID: "s",
  messageID: "m",
  callID: "c1",
  type: "tool",
  tool,
  state,
})

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

function mount(part: ToolPart, settled = false) {
  const [state, setState] = createStore({ part, settled })
  dispose = render(
    () =>
      createComponent(Part, {
        get part() {
          return state.part
        },
        message,
        get settled() {
          return state.settled
        },
      }),
    root,
  )
  return setState
}

const row = () => root.querySelector<HTMLElement>("[data-tool-row]")
// TextShimmer 把字画两份(底字 + 扫光层),只读底字那一份。
const title = () =>
  root.querySelector('[data-slot="basic-tool-tool-title"] [data-slot="text-shimmer-char-base"]')?.textContent
const shimmering = () =>
  root.querySelector('[data-slot="basic-tool-tool-title"] [data-component="text-shimmer"]')?.getAttribute("data-active")
const subtitle = () => root.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent
const duration = () => root.querySelector('[data-slot="tool-row-duration"]')?.textContent
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

describe("紧凑工具行(通用卡)", () => {
  // 用户报的 bug:工具那一行常常只剩一个「bash」、一个「ls」,像卡住了。跑着的时候命令整个藏起来了。
  test("跑着的 bash:标题是工具名、命令就在旁边,右边的耗时在走", () => {
    mount(call({ status: "running", input: { command: "make -j8" }, time: { start: Date.now() - 3_000 } }))
    expect(title()).toBe("bash")
    expect(shimmering()).toBe("true")
    expect(subtitle()).toBe("make -j8")
    expect(row()?.dataset.tone).toBe("running")
    expect(duration()).toMatch(/^3\.\ds$/)
  })

  test("参数写完、还没开跑(pending)也显示命令", () => {
    mount(call({ status: "pending", input: { command: "git log --oneline -5" } }))
    expect(subtitle()).toBe("git log --oneline -5")
    expect(duration()).toBeUndefined()
  })

  test("ls 不带 path 也有摘要(契约给 \".\"),grep 带了 path 仍显示 pattern", () => {
    const done = { output: "", title: "", metadata: {}, time: { start: 1, end: 2 } }
    const set = mount(call({ status: "completed", input: {}, ...done }, "ls"))
    expect(subtitle()).toBe(".")
    set("part", call({ status: "completed", input: { pattern: "HAL_Init", path: "Core" }, ...done }, "grep"))
    expect(subtitle()).toBe("HAL_Init")
  })

  test("这一轮结束了它还没结果:画成「未完成」,不闪、能点开,命令照样在", async () => {
    mount(call({ status: "running", input: { command: "sleep 100" }, time: { start: 1 } }), true)
    expect(row()?.dataset.tone).toBe("interrupted")
    expect(shimmering()).toBe("false")
    expect(subtitle()).toBe("sleep 100")
    expect(root.querySelector('[data-slot="tool-row-flag"]')).not.toBeNull()
    root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    await frame()
    expect(root.querySelector('[data-slot="tool-row-note"]')).not.toBeNull()
    expect(root.querySelector('[data-slot="tool-row-command"]')?.textContent).toBe("sleep 100")
  })

  test("没收尾的时候照旧是进行中(settled 只在这一轮不再跑时才给)", () => {
    const set = mount(call({ status: "pending", input: { command: "make" } }))
    expect(row()?.dataset.tone).toBe("pending")
    set("settled", true)
    expect(row()?.dataset.tone).toBe("interrupted")
  })

  test("失败的通用工具也是这一行(红),命令照样看得见;展开是报错全文", async () => {
    mount(
      call({
        status: "error",
        input: { command: "git status" },
        error: "fatal: not a git repository\n\nCommand exited with code 128",
        metadata: {},
        time: { start: 1_000, end: 3_000 },
      }),
    )
    expect(root.querySelector('[data-kind="tool-error-card"]')).toBeNull()
    expect(row()?.dataset.tone).toBe("error")
    expect(subtitle()).toBe("git status")
    expect(duration()).toBe("2.0s")
    root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    await frame()
    expect(root.querySelector('[data-slot="tool-row-error"]')?.textContent).toContain("Command exited with code 128")
  })

  test("硬件卡不动:硬件工具失败照旧走错误卡,不是紧凑行", () => {
    mount(
      call(
        { status: "error", input: { command: ["openocd"] }, error: "probe busy", metadata: {}, time: { start: 1, end: 2 } },
        "flash",
      ),
    )
    expect(root.querySelector('[data-kind="tool-error-card"]')).not.toBeNull()
    expect(row()).toBeNull()
  })
})
