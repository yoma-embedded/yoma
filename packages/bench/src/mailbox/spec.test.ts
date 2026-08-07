import { describe, expect, test } from "bun:test"

import { JobSpecError } from "../job.ts"
import { parseMailboxJob, DEFAULT_MOTHER_ANALYSIS_TOKENS, DEFAULT_POLL_SECONDS } from "./spec.ts"
import { rawMailboxJob } from "./testkit.ts"

describe("mailbox spec", () => {
  test("没有 mailbox 段也能解析 —— 缺省全部落位", () => {
    const raw = rawMailboxJob("/tmp/ws")
    delete raw.mailbox
    const parsed = parseMailboxJob(raw)
    expect(parsed.mailbox.maxRounds).toBe(3) // = budget.maxIterations
    expect(parsed.mailbox.pollSeconds).toBe(DEFAULT_POLL_SECONDS)
    expect(parsed.mailbox.mother.maxTokensPerAnalysis).toBe(DEFAULT_MOTHER_ANALYSIS_TOKENS)
  })

  test("mailbox 段显式值优先于缺省", () => {
    const parsed = parseMailboxJob(
      rawMailboxJob("/tmp/ws", {
        mailbox: {
          maxRounds: 7,
          pollSeconds: 5,
          mother: { maxTokensPerAnalysis: 12345, model: { providerID: "deepseek", modelID: "deepseek-chat" } },
        },
      }),
    )
    expect(parsed.mailbox.maxRounds).toBe(7)
    expect(parsed.mailbox.pollSeconds).toBe(5)
    expect(parsed.mailbox.mother.maxTokensPerAnalysis).toBe(12345)
    expect(parsed.mailbox.mother.model).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
  })

  test("非法值指名道姓", () => {
    expect(() => parseMailboxJob(rawMailboxJob("/tmp/ws", { mailbox: { maxRounds: 0 } }))).toThrow(JobSpecError)
    expect(() =>
      parseMailboxJob(rawMailboxJob("/tmp/ws", { mailbox: { mother: { maxTokensPerAnalysis: 0 } } })),
    ).toThrow(/maxTokensPerAnalysis/)
  })

  test("job 部分的校验一个不少(判据必填等)", () => {
    const raw = rawMailboxJob("/tmp/ws")
    delete raw.success
    expect(() => parseMailboxJob(raw)).toThrow(/success/)
  })
})
