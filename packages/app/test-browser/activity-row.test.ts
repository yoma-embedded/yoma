/**
 * 正在跑的那一轮底下那一行(pages/session/timeline/activity-row.tsx;docs/调试留痕-规划-20260924.md §2.2)。
 * 钉的是:阶段带起点时按起点一秒一跳、思考时跟着推理字数涨、换阶段从新起点算;按 part 推断出来的(没有起点)只说阶段
 * 不走表;打开了「显示思考」时思考阶段不出字;卸载停表。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { TurnActivity } from "../src/pages/session/timeline/activity"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}))
// TextShimmer 会把字画两份(底字 + 扫光层);TextReveal 有动画。这里只关心交给它们的字。
vi.mock("@yoma-desktop/ui/text-shimmer", async () => {
  const { createEffect } = await import("solid-js")
  return {
    TextShimmer: (props: { text: string }) => {
      const span = document.createElement("span")
      span.setAttribute("data-testid", "label")
      createEffect(() => {
        span.textContent = props.text
      })
      return span
    },
  }
})
vi.mock("@yoma-desktop/ui/text-reveal", () => ({ TextReveal: () => null }))

import { TimelineActivityRow } from "../src/pages/session/timeline/activity-row"

let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-24T07:00:00Z"))
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.replaceChildren()
  vi.useRealTimers()
})

const detail = () => root.querySelector('[data-slot="session-turn-thinking-detail"]')?.textContent
const label = () => root.querySelector('[data-testid="label"]')?.textContent
const row = () => root.querySelector('[data-slot="session-turn-thinking"]')

function mount(activity: TurnActivity | undefined, options: { chars?: number; showReasoningSummaries?: boolean } = {}) {
  const [state, setState] = createStore({ activity, chars: options.chars ?? 0 })
  dispose = render(
    () =>
      createComponent(TimelineActivityRow, {
        showReasoningSummaries: options.showReasoningSummaries ?? false,
        get activity() {
          return state.activity
        },
        reasoningChars: () => state.chars,
      }),
    root,
  )
  return setState
}

describe("正在跑的那一轮底下那一行", () => {
  test("跑工具:说在跑什么、按起点一秒一跳", () => {
    mount({ kind: "tools", names: ["bash"], since: Date.now() - 167_000 })
    expect(row()?.getAttribute("data-activity")).toBe("tools")
    expect(label()).toBe('ui.sessionTurn.status.runningTools{"names":"bash"}')
    expect(detail()).toBe("2 min 47 s")
    vi.advanceTimersByTime(1_000)
    expect(detail()).toBe("2 min 48 s")
  })

  test("思考:已过时长后面跟着推理字数,流在动就一直涨", () => {
    const setState = mount({ kind: "thinking", since: Date.now() - 23_000 }, { chars: 812 })
    expect(label()).toBe("ui.sessionTurn.status.thinking")
    expect(detail()).toBe('23 s · ui.sessionTurn.status.thoughtChars{"chars":"812"}')
    setState("chars", 4_130)
    expect(detail()).toBe('23 s · ui.sessionTurn.status.thoughtChars{"chars":"4.1k"}')
  })

  test("换阶段:时长从新阶段的起点重新算,字数只在思考时出", () => {
    const setState = mount({ kind: "thinking", since: Date.now() - 30_000 }, { chars: 9_000 })
    setState("activity", { kind: "waiting", since: Date.now() })
    expect(row()?.getAttribute("data-activity")).toBe("waiting")
    expect(label()).toBe("ui.sessionTurn.status.waitingModel")
    expect(detail()).toBe("0 s")
  })

  test("等确认:说在等哪个工具的确认", () => {
    mount({ kind: "confirm", tool: "flash", since: Date.now() - 5_000 })
    expect(label()).toBe('ui.sessionTurn.status.waitingConfirm{"tool":"flash"}')
    expect(detail()).toBe("5 s")
  })

  test("按 part 推断出来的阶段(没有起点):只说阶段,不走表", () => {
    mount({ kind: "waiting" })
    expect(label()).toBe("ui.sessionTurn.status.waitingModel")
    expect(detail()).toBeUndefined()
  })

  test("不出字:写正文 / 写调用参数(没有阶段),以及打开了「显示思考」时的思考阶段", () => {
    mount(undefined)
    expect(row()).toBeNull()
    dispose?.()
    mount({ kind: "thinking", since: Date.now() }, { showReasoningSummaries: true })
    expect(row()).toBeNull()
  })

  test("卸载:计时器跟着停(不留一个空转的 setInterval)", () => {
    mount({ kind: "waiting", since: Date.now() })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    dispose?.()
    dispose = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})
