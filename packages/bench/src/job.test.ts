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

describe("parseJob · 模型与思考档位", () => {
  test("model.thinking 解析出来", () => {
    const job = parseJob(base({ model: { providerID: "deepseek", modelID: "deepseek-v4-pro", thinking: "max" } }))
    expect(job.model?.thinking).toBe("max")
  })

  test("不填 thinking 不等于关掉 —— 落到调试台的默认,由 turn.ts 交给内核", () => {
    const job = parseJob(base({ model: { providerID: "deepseek", modelID: "deepseek-v4-pro" } }))
    expect(job.model?.thinking).toBeUndefined()
  })

  test("显式 off 是合法的 —— 要关得关得掉", () => {
    expect(parseJob(base({ model: { thinking: "off" } })).model?.thinking).toBe("off")
  })

  test("档位写错当场报,而不是悄悄落到别的档", () => {
    // 内核那边 pickThinkingLevel 会把不认识的值落到第一档,于是错字表现为
    // "我明明配了 max 却没生效" —— 最难归因的一类。所以这里必须拦住。
    const issues = issuesOf(base({ model: { thinking: "hight" } }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("model.thinking")
    expect(issues[0]).toContain("hight")
  })

  test("档位的问题和别的问题一起报出来", () => {
    expect(issuesOf({ id: "j-1", model: { thinking: "巨能想" } })).toHaveLength(2)
  })
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
