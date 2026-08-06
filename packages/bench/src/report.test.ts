import { describe, expect, test } from "bun:test"

import type { GradeResult } from "./grader.ts"
import { parseJob } from "./job.ts"
import { mrTitle, renderReport } from "./report.ts"
import type { RunnerResult } from "./runner.ts"

const job = parseJob({
  id: "j-1",
  title: "修复 CAN 掉帧",
  task: "掉帧",
  repo: { directory: "/tmp/ws" },
  bench: { board: "nucleo-g474", chip: "STM32G474RE", knownGoodElf: "good.elf" },
  success: { checks: [{ type: "log_wait", pattern: "SELFTEST PASS" }] },
  policy: "unattended",
})

const grade: GradeResult = {
  passed: false,
  checks: [
    {
      check: { type: "log_wait", pattern: "SELFTEST PASS" },
      outcome: "fail",
      summary: "60s 内没有等到 /SELFTEST PASS/",
      evidence: "boot\nCAN init\nRX overrun at t=12",
      elapsedMs: 60_000,
    },
  ],
  hasEnvironmentError: false,
}

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    job,
    outcome: "failed",
    reason: "迭代预算 3 轮用尽,判据仍未通过",
    sessionID: "019fd634-382a-792b-9f29-2e1c5421725f",
    iterations: [
      {
        index: 1,
        startedAt: 0,
        endedAt: 1000,
        turn: {
          sessionID: "s",
          text: "根因是 RX FIFO 没开中断",
          toolCalls: [
            { tool: "read", status: "completed", input: {} },
            { tool: "read", status: "completed", input: {} },
            { tool: "flash", status: "completed", input: {} },
          ],
          usage: { tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.02 },
          decisions: [],
          errors: [],
          elapsedMs: 95_000,
        },
        grade,
      },
    ],
    decisions: [
      {
        time: 1,
        sessionID: "s",
        callID: "c",
        tool: "bash",
        title: "执行命令:rm -rf build",
        verdict: "deny",
        by: "policy",
        rule: "bash.not-allowed",
        elapsedMs: 1,
      },
    ],
    totalTokens: 1500,
    totalCost: 0.02,
    elapsedMs: 120_000,
    restored: true,
    ...overrides,
  }
}

describe("renderReport", () => {
  test("结论在第一屏,含任务/分支/预算摘要", () => {
    const report = renderReport({ result: result(), branch: "agent/j-1" })
    const head = report.slice(0, 600)
    expect(head).toContain("# 调试报告:修复 CAN 掉帧")
    expect(head).toContain("未能通过判据")
    expect(head).toContain("迭代预算 3 轮用尽")
    expect(report).toContain("`agent/j-1`")
    expect(report).toContain("1,500 tokens")
  })

  test("证据段标明是调试台独立执行的,并带日志摘录", () => {
    const report = renderReport({ result: result() })
    expect(report).toContain("由调试台独立执行,不经模型")
    expect(report).toContain("RX overrun at t=12")
  })

  test("agent 自述被明确标注为未经验证 —— 和证据分开摆", () => {
    const report = renderReport({ result: result() })
    expect(report).toContain("根因分析(agent 自述,未经独立验证)")
    expect(report).toContain("> 根因是 RX FIFO 没开中断")
  })

  test("被拒的动作进审计段", () => {
    const report = renderReport({ result: result() })
    expect(report).toContain("权限与审计")
    expect(report).toContain("rm -rf build")
    expect(report).toContain("bash.not-allowed")
  })

  test("过程表按轮列出工具调用与判据结论", () => {
    const report = renderReport({ result: result() })
    expect(report).toContain("| 1 | read×2 flash |")
    expect(report).toContain("1 项未过")
  })

  test("回刷失败要在摘要里显眼 —— 板子状态未知是最危险的收尾", () => {
    const report = renderReport({ result: result({ restored: false }) })
    expect(report).toContain("**回刷失败,板子状态未知**")
  })

  test("通过时给出复核路径与会话回放", () => {
    const report = renderReport({
      result: result({ outcome: "passed", reason: "第 1 轮判据全部通过" }),
      diffStat: " main.c | 2 +-",
      changedFiles: ["M\tmain.c"],
      commits: ["abc1234 fix: 修复 CAN 掉帧"],
    })
    expect(report).toContain("判据全部通过")
    expect(report).toContain("main.c")
    expect(report).toContain("回放完整过程")
    expect(report).toContain("yoma-bench grade")
  })

  test("没有代码改动时说清楚,而不是留空", () => {
    const report = renderReport({ result: result() })
    expect(report).toContain("没有代码改动")
  })
})

describe("mrTitle", () => {
  test("未通过时带前缀,通过时干净", () => {
    expect(mrTitle(result())).toContain("[未通过]")
    expect(mrTitle(result({ outcome: "passed" }))).toBe("修复 CAN 掉帧 (agent j-1)")
  })
})
