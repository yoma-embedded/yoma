import { describe, expect, test } from "bun:test"

import { JobSpecError, parseJob } from "./job.ts"

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "j-1",
    title: "测试",
    task: "修 bug",
    repo: { directory: "/tmp/ws" },
    success: { checks: [{ type: "bash", command: "true" }] },
    policy: "supervised",
    ...overrides,
  }
}

function issuesOf(raw: unknown): string[] {
  try {
    parseJob(raw)
    return []
  } catch (error) {
    if (error instanceof JobSpecError) return error.issues
    throw error
  }
}

describe("parseJob · 必填", () => {
  test("最小合法 job 能解析,缺省值就位", () => {
    const job = parseJob(base())
    expect(job.repo.branch).toBe("agent/j-1")
    expect(job.success.repeat).toBe(1)
    expect(job.budget.maxIterations).toBeGreaterThan(0)
    expect(job.deliver?.remote).toBe("origin")
  })

  test("没有判据直接拒 —— 那等于让模型自己判卷", () => {
    expect(issuesOf(base({ success: { checks: [] } }))[0]).toContain("至少要有一条")
    expect(issuesOf(base({ success: undefined }))[0]).toContain("success 必填")
  })

  test("id 会进分支名和路径,字符受限", () => {
    expect(issuesOf(base({ id: "j 1; rm -rf /" }))[0]).toContain("只能含字母数字")
  })

  test("task 与 repo.directory 必填", () => {
    expect(issuesOf(base({ task: "  " }))[0]).toContain("task 必填")
    expect(issuesOf(base({ repo: {} }))[0]).toContain("repo.directory 必填")
  })
})

describe("parseJob · 判据", () => {
  test("认识四种检查类型", () => {
    const job = parseJob(
      base({
        bench: { chip: "STM32G474RE", knownGoodElf: "g.elf" },
        success: {
          build: "make",
          checks: [
            { type: "bash", command: "ctest" },
            { type: "log_wait", pattern: "PASS" },
            { type: "log_absent", pattern: "HardFault", windowS: 5 },
            { type: "build", command: "make flash" },
          ],
        },
      }),
    )
    expect(job.success.checks.map((c) => c.type)).toEqual(["bash", "log_wait", "log_absent", "build"])
  })

  test("非法正则要在开跑前说清楚,而不是跑到一半炸", () => {
    expect(issuesOf(base({ success: { checks: [{ type: "log_wait", pattern: "[unclosed" }] } }))[0]).toContain("不是合法正则")
  })

  test("RTT 判据要求声明 chip —— probe-rs attach 没芯片名跑不了", () => {
    const issues = issuesOf(base({ success: { checks: [{ type: "log_wait", pattern: "PASS" }] } }))
    expect(issues[0]).toContain("bench.chip 没填")
  })

  test("command 来源的日志判据不需要 chip", () => {
    const job = parseJob(
      base({
        success: {
          checks: [{ type: "log_wait", pattern: "PASS", source: { kind: "command", command: "cat /dev/ttyUSB0" } }],
        },
      }),
    )
    expect(job.success.checks[0]).toMatchObject({ source: { kind: "command" } })
  })

  test("不认识的检查类型点名报错", () => {
    expect(issuesOf(base({ success: { checks: [{ type: "vibes" }] } }))[0]).toContain("不认识")
  })
})

describe("parseJob · 预算与策略", () => {
  test("预算不接受 0 或负数 —— 无界迭代是烧钱和变砖的组合", () => {
    expect(issuesOf(base({ budget: { maxIterations: 0 } }))[0]).toContain("至少为 1")
  })

  test("不认识的策略档名点名报错", () => {
    expect(issuesOf(base({ policy: "yolo" }))[0]).toContain("不认识")
  })

  test("无人值守 + 有芯片 → 必须有 known-good 固件", () => {
    const issues = issuesOf(
      base({ policy: "unattended", bench: { chip: "STM32G474RE" }, success: { checks: [{ type: "bash", command: "true" }] } }),
    )
    expect(issues[0]).toContain("knownGoodElf 必填")
  })

  test("无人值守但不碰硬件 → 不强求 known-good 固件", () => {
    const job = parseJob(base({ policy: "unattended" }))
    expect(job.policy).toBe("unattended")
    expect(job.bench.knownGoodElf).toBeUndefined()
  })
})

describe("parseJob · 报错质量", () => {
  test("一次报出全部问题,而不是一次一个", () => {
    const issues = issuesOf({ id: "bad id", success: { checks: [] } })
    expect(issues.length).toBeGreaterThan(2)
  })

  test("错误消息里带字段路径", () => {
    const issues = issuesOf(base({ success: { checks: [{ type: "bash" }] } }))
    expect(issues[0]).toContain("success.checks[0].command")
  })
})
