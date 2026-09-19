import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import type { TaskView } from "@yoma-desktop/kernel"

// 文案按键名渲染(带参数时拼上参数),断言不依赖中英任何一份词典。
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}))

const [store, setStore] = createStore<{ task: Record<string, TaskView> }>({ task: {} })
vi.mock("@/context/sync", () => ({
  useSync: () => () => ({ data: store, session: { get: () => undefined } }),
}))
vi.mock("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ params: { id: "main" } }) }))

const actions = { navigateToSession: vi.fn(), stopTask: vi.fn() }
vi.mock("@yoma-desktop/session-ui/context", () => ({ useData: () => actions }))

import { SessionConfirmDock } from "../src/pages/session/composer/session-confirm-dock"
import { SessionQueueDock } from "../src/pages/session/composer/session-queue-dock"
import { TaskSlot } from "../src/pages/session/subagent/task-slot"
import { SubagentStatus } from "../src/pages/session/subagent/subagent-header"

const task = (id: string, input: Partial<TaskView> = {}): TaskView => ({
  id,
  parentID: "main",
  agent: "Explore",
  description: `描述 ${id}`,
  status: "running",
  background: false,
  startedAt: Date.now() - 5_000,
  turns: 2,
  usage: { totalTokens: 0, toolUses: 3, durationMs: 5_000 },
  outputFile: `/tmp/${id}.log`,
  ...input,
})

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
// setStore(路径, 对象) 是合并;要整份换掉得 reconcile。
const setTasks = (tasks: Record<string, TaskView>) => setStore("task", reconcile(tasks))
beforeEach(() => {
  setTasks({})
  actions.navigateToSession.mockReset()
  actions.stopTask.mockReset()
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
})

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((el) => (el.textContent ?? "").trim() === text) as
    | HTMLButtonElement
    | undefined

describe("排队中一栏", () => {
  test("每条只画第一行正文与图片数;撤回按那一条的 entryId,正在撤的那条按钮锁住", () => {
    const onRetract = vi.fn()
    const [props, setProps] = createStore({
      items: [
        { entryId: "e1", text: "\n  先别烧录\n再看看时钟", images: 0 },
        { entryId: "e2", text: "", images: 2 },
      ],
      retracting: [] as string[],
      onRetract,
      attached: true,
    })
    dispose = render(() => createComponent(SessionQueueDock, props), root)

    const rows = [...root.querySelectorAll('[data-slot="queue-item"]')]
    expect(rows.map((row) => row.textContent)).toEqual([
      "先别烧录session.queueDock.retract",
      'session.queueDock.imageOnlysession.queueDock.images{"count":2}session.queueDock.retract',
    ])
    button(rows[1]!, "session.queueDock.retract")!.click()
    expect(onRetract).toHaveBeenCalledWith("e2")

    setProps("retracting", ["e1"])
    expect(button(rows[0]!, "session.queueDock.retract")!.disabled).toBe(true)
    expect(button(rows[1]!, "session.queueDock.retract")!.disabled).toBe(false)
  })
})

describe("状态栏的「子 agent」格", () => {
  test("没派过就不出;有在跑的说几个在跑;点开是面板,打开进子会话、停止只给还在跑的", () => {
    dispose = render(() => createComponent(TaskSlot, {}), root)
    expect(root.querySelector('[data-component="subagent-task-slot"]')).toBeNull()

    setTasks({
      live: task("live"),
      done: task("done", { status: "completed", startedAt: Date.now() - 60_000, endedAt: Date.now() - 50_000 }),
      other: task("other", { parentID: "another-main" }),
    })
    const slot = root.querySelector<HTMLButtonElement>('[data-component="subagent-task-slot"]')!
    expect(slot.textContent).toContain('session.subagent.slot.active{"count":1}')

    slot.click()
    const panel = document.querySelector('[data-component="subagent-task-panel"]')!
    const rows = [...panel.querySelectorAll('[data-slot="task"]')]
    expect(rows.map((row) => row.getAttribute("data-look"))).toEqual(["running", "completed"])
    expect(button(rows[1]!, "session.subagent.stop")).toBeUndefined()

    button(rows[0]!, "session.subagent.stop")!.click()
    expect(actions.stopTask).toHaveBeenCalledWith("live")
    button(rows[1]!, "session.subagent.open")!.click()
    expect(actions.navigateToSession).toHaveBeenCalledWith("done")
    expect(document.querySelector('[data-component="subagent-task-panel"]')).toBeNull()
  })

  test("都结束了:灯不亮,说总数", () => {
    setTasks({ done: task("done", { status: "killed", endedAt: Date.now() }) })
    dispose = render(() => createComponent(TaskSlot, {}), root)
    const slot = root.querySelector('[data-component="subagent-task-slot"]')!
    expect(slot.querySelector('[data-component="bench-led"]')?.getAttribute("data-state")).toBe("idle")
    expect(slot.textContent).toContain('session.subagent.slot.total{"count":1}')
  })
})

describe("子会话页顶部条的状态", () => {
  test("在跑:状态 + 停止;结束之后停止键消失;没有任务视图(内核重启过)就整块不出", () => {
    dispose = render(() => createComponent(SubagentStatus, { sessionID: "child" }), root)
    expect(root.querySelector('[data-component="subagent-status"]')).toBeNull()

    setTasks({ child: task("child") })
    expect(root.querySelector('[data-component="subagent-status"]')?.textContent).toContain(
      "session.subagent.state.running",
    )
    button(root, "session.subagent.stop")!.click()
    expect(actions.stopTask).toHaveBeenCalledWith("child")

    setStore("task", "child", { status: "failed", endedAt: Date.now() })
    expect(root.querySelector('[data-component="subagent-status"]')?.textContent).toContain(
      "session.subagent.state.failed",
    )
    expect(button(root, "session.subagent.stop")).toBeUndefined()
  })
})

describe("确认条", () => {
  test("前台子 agent 冒上来的询问写明是哪个子 agent;主会话自己的照旧", () => {
    const item = {
      id: "c1",
      sessionID: "main",
      toolCallId: "t1",
      tool: "flash",
      label: "烧录",
      summary: "openocd -f board.cfg",
      input: {},
      askedAt: 1,
      status: "pending" as const,
    }
    dispose = render(
      () =>
        createComponent(SessionConfirmDock, {
          items: [
            { ...item, agent: "general-purpose", taskID: "child" },
            { ...item, id: "c2" },
          ],
          onReply: () => {},
          attached: true,
        }),
      root,
    )
    // 假翻译对无参的键原样返回键名,确认条把这当成"缺键",回落到工具名。
    const text = root.textContent ?? ""
    expect(text).toContain('session.confirmDock.agentWants{"agent":"general-purpose","tool":"flash"}')
    expect(text).toContain('session.confirmDock.wants{"tool":"flash"}')
  })
})
