/**
 * 话术里唯一有算法的那部分:**工位端自述怎么进提示词**。
 *
 * 这块从前没有测试,而它出过一次真事故:上限只截头部,而汇总行、RESULT、结论全在
 * 末尾 —— 一次五轮的任务里每一轮都超限,第一轮丢掉 44%,丢的正好是结论那半。
 */

import { describe, expect, test } from "bun:test"

import { motherFollowUpPrompt, type MotherPromptInput } from "./prompts.ts"
import { parseMailboxJob } from "./spec.ts"
import { rawMailboxJob, usage } from "./testkit.ts"
import type { RoundResultFile } from "./store.ts"

function briefWith(text: string, overrides: Partial<MotherPromptInput> = {}): string {
  const result: RoundResultFile = {
    round: 1,
    turn: {
      text,
      toolCounts: {},
      toolErrors: [],
      usage: usage(10),
      errors: [],
      elapsedMs: 1,
    },
    spentTokens: 10,
    at: new Date(0).toISOString(),
    elapsedMs: 1,
  }
  return motherFollowUpPrompt({
    mailboxJob: parseMailboxJob(rawMailboxJob()),
    round: 1,
    instruction: { round: 1, prompt: "复现", issuedBy: "mother", at: new Date(0).toISOString() },
    result,
    rounds: [],
    ...overrides,
  })
}

describe("工位端自述进提示词", () => {
  test("没超额度就一个字不动", () => {
    const brief = briefWith("短短一句:5/5 PASS")
    expect(brief).toContain("5/5 PASS")
    expect(brief).not.toContain("中间省略")
  })

  test("超额度时头尾都留 —— 结论在末尾,不能被截掉", () => {
    const head = "开头:我先烧了固件\n"
    const middle = "中".repeat(40_000)
    const tail = "\nRESULT: 5/5 checks passed"
    const brief = briefWith(`${head}${middle}${tail}`)

    expect(brief).toContain("开头:我先烧了固件")
    expect(brief).toContain("RESULT: 5/5 checks passed")
    expect(brief).toContain("中间省略")
    // 省略的是中间那一大段,不是整篇搬进上下文。
    expect(brief.length).toBeLessThan(30_000)
  })

  test("截断时说清全文在哪 —— 只说'截断了'会让人以为剩下的没了", () => {
    const brief = briefWith("噪".repeat(40_000), {
      staged: { reportPath: ".yoma/back/001/bench-report.md" },
    })
    expect(brief).toContain(".yoma/back/001/bench-report.md")
  })

  test("回传件给的是本机相对路径,没送成的也要说", () => {
    const brief = briefWith("采完了", {
      staged: { files: [{ name: "capture/ch2.csv", bytes: 2048, localPath: ".yoma/back/001/capture/ch2.csv" }] },
      result: {
        round: 1,
        spentTokens: 10,
        at: new Date(0).toISOString(),
        elapsedMs: 1,
        backSkipped: [{ name: "raw.npz", bytes: 40 * 1024 * 1024, reason: "超过上限" }],
      },
    })
    expect(brief).toContain(".yoma/back/001/capture/ch2.csv")
    expect(brief).toContain("自己读、自己画、自己算")
    // 没送成的必须现身:静默丢弃会让它按一份不存在的证据继续推理。
    expect(brief).toContain("raw.npz")
    expect(brief).toContain("这些东西**你没有**")
  })

  test("工位端说需要人时,提示词直接给出两条岔路(别再下发一轮'请转达')", () => {
    const brief = briefWith("母线没电", {
      result: {
        round: 1,
        spentTokens: 10,
        at: new Date(0).toISOString(),
        elapsedMs: 1,
        needsHuman: "请把台架电源设为 24V",
      },
    })
    expect(brief).toContain("需要人动手")
    expect(brief).toContain("await-human")
    expect(brief).toContain("请转达")
  })

  test("回执进简报时把上一次的请求一起带上 —— 否则它看到的和挂起前一模一样", () => {
    const brief = briefWith("等着", {
      rounds: [
        {
          round: 1,
          decision: {
            round: 1,
            by: "mother",
            decision: "await-human",
            ask: "请把台架电源设为 24V",
            at: new Date(0).toISOString(),
          },
        },
      ],
      humanAck: { answer: "done", note: "已设 24V", at: new Date(0).toISOString() },
    })
    expect(brief).toContain("人已经做完了")
    expect(brief).toContain("已设 24V")
    expect(brief).toContain("你上一次请求的是")
  })
})
