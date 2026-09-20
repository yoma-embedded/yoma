import { describe, expect, test } from "vitest"
import type { TaskView } from "@yoma-desktop/kernel"
import { agentResultText, describeAgent } from "./agent-card"

const input = { description: "查时钟树", prompt: "读 RCC 配置,报 SYSCLK", subagent_type: "Explore" }

/** 工具交回时的 details(host/tools/agent/session.ts 的 detailsOf 同形)。 */
function details(extra: Record<string, unknown> = {}) {
  return {
    taskID: "task-1",
    agent: "Explore",
    description: "查时钟树",
    status: "completed",
    background: false,
    turns: 3,
    lastTool: "grep",
    usage: { totalTokens: 1234, toolUses: 5, durationMs: 4200 },
    outputFile: "/tmp/yoma/ses/tasks/task-1.output",
    ...extra,
  }
}

function live(extra: Partial<TaskView> = {}): TaskView {
  return {
    id: "task-1",
    parentID: "ses",
    agent: "Explore",
    description: "查时钟树",
    status: "running",
    background: true,
    startedAt: 1,
    turns: 7,
    lastTool: "read",
    usage: { totalTokens: 9000, toolUses: 12, durationMs: 60_000 },
    outputFile: "/tmp/yoma/ses/tasks/task-1.output",
    ...extra,
  }
}

const TRAILER =
  "agentId: task-1 (use send_message with to: 'task-1' to continue this agent)\n<usage>total_tokens: 1234\ntool_uses: 5\nduration_ms: 4200</usage>"

describe("describeAgent", () => {
  test("前台跑完:结果正文剥掉给模型的尾巴,读数取 details", () => {
    const card = describeAgent(input, details(), `SYSCLK = 168 MHz(HSE 8 MHz × PLL)\n${TRAILER}`, "completed")!
    expect(card).toMatchObject({
      agent: "Explore",
      description: "查时钟树",
      prompt: "读 RCC 配置,报 SYSCLK",
      state: "completed",
      background: false,
      taskID: "task-1",
      turns: 3,
      toolUses: 5,
      lastTool: "grep",
      durationMs: 4200,
      totalTokens: 1234,
      result: "SYSCLK = 168 MHz(HSE 8 MHz × PLL)",
    })
  })

  test("一次性 agent 没有尾巴;跑完一个字没说的占位句单独标出来", () => {
    expect(describeAgent(input, details(), "只有正文", "completed")!.result).toBe("只有正文")
    const empty = describeAgent(
      input,
      details(),
      `(Subagent completed but returned no output.)\n${TRAILER}`,
      "completed",
    )!
    expect(empty.result).toBeUndefined()
    expect(empty.emptyResult).toBe(true)
  })

  test("参数还在拼:只有入参,状态 launching", () => {
    const card = describeAgent({ description: "查时钟树" }, undefined, undefined, "pending")!
    expect(card).toMatchObject({ state: "launching", description: "查时钟树", agent: "general-purpose" })
    expect(card.taskID).toBeUndefined()
  })

  test("前台跑着:进度那一拍的 details 决定状态", () => {
    const card = describeAgent(
      input,
      details({ status: "running", usage: { totalTokens: 0, toolUses: 2, durationMs: 900 } }),
      "",
      "running",
    )!
    expect(card).toMatchObject({ state: "running", toolUses: 2, durationMs: 900 })
    expect(card.totalTokens).toBeUndefined()
  })

  test("后台派出:有实时任务就跟着它走;没有就不假装知道它还在跑", () => {
    const launched = "Async agent launched successfully.\nagentId: task-1 (internal ID - …)"
    const meta = details({ status: "running", background: true })
    expect(describeAgent(input, meta, launched, "completed", live())).toMatchObject({
      state: "running",
      background: true,
      turns: 7,
      toolUses: 12,
      lastTool: "read",
    })
    expect(describeAgent(input, meta, launched, "completed", live({ status: "completed" }))!.state).toBe("completed")
    const detached = describeAgent(input, meta, launched, "completed")!
    expect(detached.state).toBe("background")
    expect(detached.result).toBeUndefined()
  })

  test("认不出的调用(没有描述、也不在拼参数)回落到通用卡", () => {
    expect(describeAgent({}, {}, "x", "completed")).toBeUndefined()
  })
})

describe("agentResultText", () => {
  test("后台派出的回复没有正文", () => {
    expect(agentResultText("Async agent launched successfully.\nagentId: x")).toEqual({})
    expect(agentResultText(undefined)).toEqual({})
  })
})
