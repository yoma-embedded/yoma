import { describe, expect, test } from "bun:test"

import { JobSpecError } from "../job.ts"
import { parseMailboxJob, DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MOTHER_ANALYSIS_TOKENS, DEFAULT_POLL_SECONDS } from "./spec.ts"
import { rawMailboxJob } from "./testkit.ts"

describe("mailbox spec", () => {
  test("没有 mailbox 段也能解析 —— 缺省全部落位", () => {
    const raw = rawMailboxJob()
    delete raw.mailbox
    const parsed = parseMailboxJob(raw)
    expect(parsed.job.budget.maxRounds).toBe(3) // 轮数上限住在 job.budget 里,两侧共用
    expect(parsed.mailbox.pollSeconds).toBe(DEFAULT_POLL_SECONDS)
    expect(parsed.mailbox.mother.maxTokensPerAnalysis).toBe(DEFAULT_MOTHER_ANALYSIS_TOKENS)
    expect(parsed.mailbox.maxArtifactBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES)
  })

  test("信箱里的任务书不带绝对路径 —— 工程目录是本机事实", () => {
    const parsed = parseMailboxJob(rawMailboxJob())
    expect(parsed.job.repo.directory).toBeUndefined()
    expect(parsed.job.repo.name).toBe("m-1")
  })

  test("mailbox 段显式值优先于缺省", () => {
    const parsed = parseMailboxJob(
      rawMailboxJob({
        mailbox: {
          pollSeconds: 5,
          mother: { maxTokensPerAnalysis: 12345, model: { providerID: "deepseek", modelID: "deepseek-chat" } },
        },
      }),
    )
    expect(parsed.mailbox.pollSeconds).toBe(5)
    expect(parsed.mailbox.mother.maxTokensPerAnalysis).toBe(12345)
    expect(parsed.mailbox.mother.model).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
  })

  test("非法值指名道姓", () => {
    expect(() => parseMailboxJob(rawMailboxJob({ mailbox: { pollSeconds: 0 } }))).toThrow(JobSpecError)
    expect(() =>
      parseMailboxJob(rawMailboxJob({ mailbox: { mother: { maxTokensPerAnalysis: 0 } } })),
    ).toThrow(/maxTokensPerAnalysis/)
  })

  test("job 部分的校验一个不少(task 必填等)", () => {
    const raw = rawMailboxJob()
    delete raw.task
    expect(() => parseMailboxJob(raw)).toThrow(/task/)
  })
})
