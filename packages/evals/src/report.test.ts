/**
 * 汇总口径。
 *
 * 三个 pass 指标算错不会有人发现 —— 报告照样是一张漂亮的表。所以这里用手造的记录把
 * 口径钉死,尤其是 **error 不进分母** 那一条:混进 fail 会把"API 抖了"记成"agent 笨"。
 */

import { describe, expect, test } from "bun:test"

import { aggregateTags, aggregateTasks, passStats, renderReport } from "./report.ts"
import { emptyMetrics, type TrialRecord, type TrialStatus } from "./trial.ts"

function record(taskID: string, trial: number, status: TrialStatus, tags = ["netlist", "L1"]): TrialRecord {
  const metrics = emptyMetrics()
  metrics.turns = 4
  metrics.tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }
  metrics.elapsedMs = 2000
  return {
    runID: "r",
    taskID,
    tags,
    trial,
    status,
    score: status === "pass" ? 1 : 0,
    graders: [
      { type: "answer", pass: status === "pass", detail: status === "pass" ? "answer = U3" : "answer = U1,但应为 U3" },
    ],
    answer: { raw: '{"answer": "U1"}' },
    metrics,
    sessionFile: "/sessions/x.jsonl",
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:02.000Z",
    ...(status === "error" ? { error: "子进程没有跑完" } : {}),
    ...(status === "skip" ? { error: "需要 board" } : {}),
  }
}

describe("passStats", () => {
  test("k=3 里过 2 次:pass@1 = 2/3,pass@k = 1,pass^k = 0", () => {
    const stats = passStats([record("a", 0, "pass"), record("a", 1, "pass"), record("a", 2, "fail")])
    expect(stats.n).toBe(3)
    expect(stats.pass1).toBeCloseTo(2 / 3)
    expect(stats.passK).toBe(1)
    expect(stats.passPowK).toBe(0)
  })

  test("全过:三个都是 1", () => {
    const stats = passStats([record("a", 0, "pass"), record("a", 1, "pass")])
    expect(stats.pass1).toBe(1)
    expect(stats.passK).toBe(1)
    expect(stats.passPowK).toBe(1)
  })

  test("全不过:pass@k 是 0(能力缺口),不是 undefined", () => {
    const stats = passStats([record("a", 0, "fail"), record("a", 1, "fail")])
    expect(stats.pass1).toBe(0)
    expect(stats.passK).toBe(0)
  })

  test("error 不进分母 —— 3 次里 1 次 error、2 次 pass 就是 100%", () => {
    const stats = passStats([record("a", 0, "pass"), record("a", 1, "pass"), record("a", 2, "error")])
    expect(stats.n).toBe(2)
    expect(stats.pass1).toBe(1)
    expect(stats.errors).toBe(1)
    expect(stats.passPowK).toBe(1)
  })

  test("全是 error / skip 时三个指标都是 undefined —— 报告印 `—`,与 0% 是两回事", () => {
    const stats = passStats([record("a", 0, "error"), record("a", 1, "skip")])
    expect(stats.n).toBe(0)
    expect(stats.pass1).toBeUndefined()
    expect(stats.passK).toBeUndefined()
    expect(stats.errors).toBe(1)
    expect(stats.skips).toBe(1)
  })
})

describe("aggregateTasks", () => {
  const records = [
    record("a", 0, "pass"),
    record("a", 1, "fail"),
    record("b", 0, "pass"),
    record("b", 1, "pass"),
    record("c", 0, "skip", ["gdb", "L3"]),
  ]

  test("按题分组,各算各的", () => {
    const tasks = aggregateTasks(records)
    expect(tasks.map((task) => task.taskID)).toEqual(["a", "b", "c"])
    expect(tasks[0]!.pass1).toBe(0.5)
    expect(tasks[0]!.passPowK).toBe(0)
    expect(tasks[1]!.passPowK).toBe(1)
    expect(tasks[2]!.pass1).toBeUndefined()
  })

  test("平均值的分母不含 skip —— 它从来没启动过", () => {
    const tasks = aggregateTasks(records)
    expect(tasks[0]!.averages.turns).toBe(4)
    expect(tasks[0]!.averages.tokensReasoning).toBe(5)
    expect(tasks[2]!.averages.turns).toBe(0)
  })
})

describe("aggregateTags", () => {
  test("一条 trial 有几个 tag 就进几个桶;pass@k 在 tag 这一级按题平均", () => {
    const tags = aggregateTags([
      record("a", 0, "pass"),
      record("a", 1, "fail"),
      record("b", 0, "fail"),
      record("b", 1, "fail"),
    ])
    const netlist = tags.find((tag) => tag.tag === "netlist")!
    expect(netlist.tasks).toBe(2)
    expect(netlist.pass1).toBe(0.25)
    // a 够得着(1),b 够不着(0) → 按题平均 0.5。把两题的 trial 混一个池子问
    // "至少一次通过"会得到 1,那没有意义。
    expect(netlist.passK).toBe(0.5)
    expect(tags.map((tag) => tag.tag)).toEqual(["L1", "netlist"])
  })
})

describe("renderReport", () => {
  const markdown = renderReport([
    record("a", 0, "pass"),
    record("a", 1, "fail"),
    record("b", 0, "error"),
    record("c", 0, "skip", ["L3"]),
  ])

  test("三张表齐全,error / skip 单列", () => {
    expect(markdown).toContain("## 按题")
    expect(markdown).toContain("## 按 tag")
    expect(markdown).toContain("## 基础设施错误(不计入 pass 率)")
    expect(markdown).toContain("## 跳过")
  })

  test("失败清单带 grader 的 detail 与会话文件 —— 没有它没法判断是不是冤枉了合法解法", () => {
    expect(markdown).toContain("### a #1")
    expect(markdown).toContain("但应为 U3")
    expect(markdown).toContain("/sessions/x.jsonl")
  })

  test("reasoning 单列 —— 2026-08-11 那次 107 条消息 0 reasoning 就是这么才看得见的", () => {
    expect(markdown).toContain("reasoning")
  })
})
