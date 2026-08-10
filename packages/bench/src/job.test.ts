import { describe, expect, test } from "bun:test"

import { JobSpecError, parseJob, resolveWorkspace } from "./job.ts"

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "j-1",
    title: "测试",
    task: "修 bug",
    repo: { directory: "/tmp/ws" },
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
    expect(job.deliver?.remote).toBe("origin")
  })

  test("id 会进分支名和路径,字符受限", () => {
    expect(issuesOf(base({ id: "j 1; rm -rf /" }))[0]).toContain("只能含字母数字")
  })

  test("task 必填 —— 它是 agent 唯一的任务来源", () => {
    expect(issuesOf(base({ task: "  " }))[0]).toContain("task 必填")
  })

  test("repo.directory 不再必填 —— 信箱模式下它是本机事实,由收件的机器提供", () => {
    const job = parseJob(base({ repo: {} }))
    expect(job.repo.directory).toBeUndefined()
    expect(job.repo.name).toBe("j-1")
    // 但真要用工作树时必须有人给,报错要说清去哪配。
    expect(() => resolveWorkspace(job)).toThrow(/工程目录/)
    expect(resolveWorkspace(job, "/tmp/ws")).toBe("/tmp/ws")
  })
})

describe("parseJob · 预算", () => {
})

describe("parseJob · 报错质量", () => {
  test("一次报出全部问题,而不是一次一个", () => {
    // id 非法 + task 缺失 —— 两处都要在同一次里报出来。
    const issues = issuesOf({ id: "bad id" })
    expect(issues.length).toBe(2)
  })

  test("错误消息里带字段名", () => {
    expect(issuesOf({ id: "j-1" }).join("\n")).toContain("task")
  })
})
