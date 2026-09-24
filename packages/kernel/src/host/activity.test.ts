/**
 * ActivityTracker:harness 事件 → 六个阶段。只在阶段变化时返回 true(一个 step 五到十次,不是逐 delta),
 * since 的取法按"用户在等什么"算。时间用假时钟。
 */

import { describe, expect, it } from "vitest"

import { ActivityTracker, contentKindOf } from "./activity.ts"

function tracker() {
  let now = 1_000
  const t = new ActivityTracker(() => now)
  return {
    t,
    tick(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
  }
}

describe("ActivityTracker", () => {
  it("一轮的典型序列:等模型 → 思考 → 写调用 → 跑工具 → 等模型 → 正文 → 结束", () => {
    const { t, tick } = tracker()
    expect(t.runStart()).toBe(true)
    expect(t.activity).toEqual({ phase: "waiting", since: 1_000 })

    // 流打开(响应头到了):还在等第一个字,since 不动 —— 用户等的是"请求发出之后"
    tick(800)
    expect(t.llmStart()).toBe(false)
    expect(t.activity).toEqual({ phase: "waiting", since: 1_000 })

    tick(200)
    expect(t.content("thinking")).toBe(true)
    expect(t.activity).toEqual({ phase: "thinking", since: 2_000 })
    // 同一阶段的后续 delta 不算变化
    tick(50)
    expect(t.content("thinking")).toBe(false)

    tick(950)
    expect(t.content("toolcall", "bash")).toBe(true)
    expect(t.activity).toEqual({ phase: "calling", since: 3_000, tool: "bash" })
    expect(t.content("toolcall", "bash")).toBe(false)
    // 同一条回复里接着写第二个调用
    tick(100)
    expect(t.content("toolcall", "read")).toBe(true)
    expect(t.activity).toEqual({ phase: "calling", since: 3_100, tool: "read" })

    tick(100)
    expect(t.toolStart("c1", "bash")).toBe(true)
    tick(10)
    expect(t.toolStart("c2", "read")).toBe(true)
    // since 是这一批最早开跑的那个
    expect(t.activity).toEqual({ phase: "tools", since: 3_200, tools: ["bash", "read"] })

    tick(40)
    expect(t.toolEnd("c2")).toBe(true)
    expect(t.activity).toEqual({ phase: "tools", since: 3_200, tools: ["bash"] })
    tick(5_000)
    expect(t.toolEnd("c1")).toBe(true)
    expect(t.activity).toEqual({ phase: "waiting", since: 8_250 })

    tick(300)
    expect(t.llmStart()).toBe(false)
    expect(t.content("text")).toBe(true)
    expect(t.activity).toEqual({ phase: "writing", since: 8_550 })

    expect(t.runEnd()).toBe(true)
    expect(t.activity).toBeUndefined()
    expect(t.runEnd()).toBe(false)
  })

  it("每次变化换一个新对象、没变保持同一个引用(调用方按引用判等去重)", () => {
    const { t, tick } = tracker()
    t.runStart()
    const waiting = t.activity
    tick(10)
    t.llmStart()
    expect(t.activity).toBe(waiting)
    t.content("text")
    expect(t.activity).not.toBe(waiting)
  })

  it("工具的输出只记时刻,不改阶段;未知的 tool_end 不算变化", () => {
    const { t, tick } = tracker()
    t.runStart()
    t.toolStart("c1", "bash")
    const before = t.activity
    tick(1_000)
    t.toolOutput("c1")
    expect(t.activity).toBe(before)
    expect(t.runningTools()).toEqual([{ toolCallId: "c1", tool: "bash", since: 1_000, lastOutput: 2_000 }])
    expect(t.toolEnd("nope")).toBe(false)
  })

  it("确认条:挂起时是 confirm;结算后有别的工具在跑回到 tools,否则回到等模型;不在 confirm 时结算无动作", () => {
    const { t, tick } = tracker()
    t.runStart()
    expect(t.confirmDone()).toBe(false)
    tick(100)
    expect(t.confirmWait("flash")).toBe(true)
    expect(t.activity).toEqual({ phase: "confirm", since: 1_100, tool: "flash" })
    tick(4_000)
    expect(t.confirmDone()).toBe(true)
    expect(t.activity).toEqual({ phase: "waiting", since: 5_100 })

    t.toolStart("c1", "grep")
    t.confirmWait("flash")
    expect(t.confirmDone()).toBe(true)
    expect(t.activity).toMatchObject({ phase: "tools", tools: ["grep"] })
  })

  it("重试的下一次尝试 / 轮中压缩做完:回到等模型;已经在等的不动 since", () => {
    const { t, tick } = tracker()
    t.runStart()
    t.content("thinking")
    tick(500)
    expect(t.awaitModel()).toBe(true)
    expect(t.activity).toEqual({ phase: "waiting", since: 1_500 })
    tick(500)
    expect(t.awaitModel()).toBe(false)
    expect(t.activity).toEqual({ phase: "waiting", since: 1_500 })
  })

  it("新的一轮清掉上一轮残留的在跑工具(被中止的一轮不一定有 tool_end)", () => {
    const { t } = tracker()
    t.runStart()
    t.toolStart("c1", "bash")
    t.runEnd()
    t.runStart()
    expect(t.runningTools()).toEqual([])
    expect(t.activity?.phase).toBe("waiting")
  })

  it("contentKindOf:按 pi-ai 流式事件的前缀分类,收尾事件不算内容", () => {
    expect(contentKindOf("thinking_delta")).toBe("thinking")
    expect(contentKindOf("thinking_start")).toBe("thinking")
    expect(contentKindOf("text_delta")).toBe("text")
    expect(contentKindOf("toolcall_start")).toBe("toolcall")
    expect(contentKindOf("done")).toBeUndefined()
    expect(contentKindOf("error")).toBeUndefined()
    expect(contentKindOf("start")).toBeUndefined()
  })
})
