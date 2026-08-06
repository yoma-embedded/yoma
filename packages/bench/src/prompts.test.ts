import { describe, expect, test } from "bun:test"

import type { GradeResult } from "./grader.ts"
import { parseJob } from "./job.ts"
import { blockedPrompt, firstPrompt, retryPrompt } from "./prompts.ts"

const job = parseJob({
  id: "j-1",
  title: "自检失败",
  task: "跑 ./check.sh 会失败",
  repo: { directory: "/tmp/ws" },
  bench: { board: "nucleo-g474", chip: "STM32G474RE", knownGoodElf: "g.elf" },
  success: {
    build: "make",
    checks: [
      { type: "bash", command: "./check.sh" },
      { type: "log_wait", pattern: "SELFTEST PASS" },
      { type: "log_absent", pattern: "HardFault" },
    ],
  },
  policy: "unattended",
})

describe("firstPrompt", () => {
  test("第一轮明确禁止改代码 —— 先复现再修", () => {
    const prompt = firstPrompt(job)
    expect(prompt).toContain("先别改任何代码")
    expect(prompt).toContain("亲眼看到问题发生")
  })

  test("判据原样告知,并说清不由 agent 自己判", () => {
    const prompt = firstPrompt(job)
    expect(prompt).toContain("你说\"修好了\"不算数")
    expect(prompt).toContain("./check.sh")
    expect(prompt).toContain("/SELFTEST PASS/")
    expect(prompt).toContain("不能出现 /HardFault/")
  })

  test("工具约束前置 —— 省掉模型撞串联防护的那几轮", () => {
    const prompt = firstPrompt(job)
    expect(prompt).toContain("一次只能跑一条命令")
    expect(prompt).toContain("不需要 `cd`")
  })

  test("硬件信息带进去", () => {
    const prompt = firstPrompt(job)
    expect(prompt).toContain("nucleo-g474")
    expect(prompt).toContain("STM32G474RE")
  })

  test("复现不出来是合法结论,不许碰运气改代码", () => {
    expect(firstPrompt(job)).toContain("别去改代码碰运气")
  })
})

describe("retryPrompt", () => {
  const grade: GradeResult = {
    passed: false,
    checks: [
      {
        check: { type: "bash", command: "./check.sh" },
        outcome: "fail",
        summary: "退出码 1(期望 0)",
        evidence: "SELFTEST FAIL: priority=2",
        elapsedMs: 10,
      },
    ],
    hasEnvironmentError: false,
  }

  test("把判据证据原样回填", () => {
    const prompt = retryPrompt(job, grade, 2)
    expect(prompt).toContain("SELFTEST FAIL: priority=2")
    expect(prompt).toContain("第 2 轮")
  })

  test("一轮一个假设的纪律写在里面", () => {
    expect(retryPrompt(job, grade, 2)).toContain("一次只验证一个假设")
  })

  test("环境错误要单独提醒:别去改代码迁就它", () => {
    const withEnvError: GradeResult = {
      ...grade,
      hasEnvironmentError: true,
      checks: [{ ...grade.checks[0]!, outcome: "error", summary: "probe-rs 不存在" }],
    }
    const prompt = retryPrompt(job, withEnvError, 3)
    expect(prompt).toContain("环境问题")
    expect(prompt).toContain("不要去改代码迁就它")
  })
})

describe("blockedPrompt", () => {
  test("列出被拦的动作并要求别原地重试", () => {
    const prompt = blockedPrompt([{ tool: "bash", title: "执行命令:rm -rf build", why: "bash.not-allowed" }])
    expect(prompt).toContain("rm -rf build")
    expect(prompt).toContain("别重试同一个动作")
  })
})
