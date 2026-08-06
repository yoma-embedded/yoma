import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { GradeResult } from "./grader.ts"
import { parseJob, type Job } from "./job.ts"
import { runJob, type TurnInput } from "./runner.ts"
import type { TurnResult } from "./turn.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function job(overrides: Record<string, unknown> = {}): Job {
  return parseJob({
    id: "j-1",
    title: "测试",
    task: "修 bug",
    repo: { directory: "/tmp/ws" },
    bench: { chip: "STM32G474RE", knownGoodElf: "good.elf" },
    success: { checks: [{ type: "bash", command: "true" }] },
    policy: "unattended",
    budget: { maxIterations: 3, maxTokens: 100_000, wallClockMin: 60 },
    ...overrides,
  })
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionID: "ses-1",
    text: "改好了",
    toolCalls: [],
    usage: { tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 },
    decisions: [],
    errors: [],
    elapsedMs: 1000,
    ...overrides,
  }
}

function gradeResult(passed: boolean, overrides: Partial<GradeResult> = {}): GradeResult {
  return {
    passed,
    checks: [
      {
        check: { type: "bash", command: "true" },
        outcome: passed ? "pass" : "fail",
        summary: passed ? "通过" : "退出码 1",
        evidence: passed ? "" : "assertion failed at main.c:42",
        elapsedMs: 10,
      },
    ],
    hasEnvironmentError: false,
    ...overrides,
  }
}

function options(overrides: Record<string, unknown> = {}) {
  const workspace = tempDir("bench-run-")
  return {
    job: job(),
    workspace,
    sessionsRoot: tempDir("bench-sessions-"),
    stateDir: tempDir("bench-state-"),
    // 默认不真的回刷固件。
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    ...overrides,
  }
}

describe("runJob · 闭环", () => {
  test("第一轮就通过判据 → passed", async () => {
    const prompts: string[] = []
    const result = await runJob(
      options({
        runTurnInProcess: async (input: TurnInput) => (prompts.push(input.prompt), turn()),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )

    expect(result.outcome).toBe("passed")
    expect(result.iterations.length).toBe(1)
    expect(prompts[0]).toContain("这一轮只做一件事:复现")
  })

  test("失败的判据证据回填到下一轮提示词", async () => {
    const prompts: string[] = []
    let round = 0
    await runJob(
      options({
        runTurnInProcess: async (input: TurnInput) => (prompts.push(input.prompt), turn()),
        gradeOnce: async () => {
          round += 1
          return round === 1
            ? { passed: false, rounds: [gradeResult(false)] }
            : { passed: true, rounds: [gradeResult(true)] }
        },
      }),
    )

    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain("assertion failed at main.c:42")
    expect(prompts[1]).toContain("一次只验证一个假设")
  })

  test("迭代预算用尽 → failed,不再多跑一轮", async () => {
    let turns = 0
    const result = await runJob(
      options({
        job: job({ budget: { maxIterations: 2, maxTokens: 100_000, wallClockMin: 60 } }),
        runTurnInProcess: async () => (turns += 1, turn()),
        gradeOnce: async () => ({ passed: false, rounds: [gradeResult(false)] }),
      }),
    )

    expect(turns).toBe(2)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toContain("迭代预算 2 轮用尽")
  })

  test("token 预算耗尽后不再开新一轮", async () => {
    let turns = 0
    const result = await runJob(
      options({
        job: job({ budget: { maxIterations: 5, maxTokens: 200, wallClockMin: 60 } }),
        runTurnInProcess: async () => {
          turns += 1
          return turn({
            usage: { tokens: { input: 150, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.1 },
          })
        },
        gradeOnce: async () => ({ passed: false, rounds: [gradeResult(false)] }),
      }),
    )

    expect(turns).toBe(1)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toContain("token 预算")
  })

  test("墙钟预算到点即停", async () => {
    let clock = 0
    const result = await runJob(
      options({
        job: job({ budget: { maxIterations: 5, maxTokens: 100_000, wallClockMin: 1 } }),
        now: () => (clock += 40_000),
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => ({ passed: false, rounds: [gradeResult(false)] }),
      }),
    )

    expect(result.reason).toContain("墙钟预算")
    expect(result.outcome).toBe("failed")
  })

  test("轮内 stopReason(预算看门狗)直接终止 job", async () => {
    const result = await runJob(
      options({
        runTurnInProcess: async () => turn({ stopReason: "token 预算 100000 耗尽" }),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )

    expect(result.outcome).toBe("failed")
    expect(result.reason).toContain("token 预算")
  })

  test("环境错误 → parked,不消耗剩余迭代去改代码", async () => {
    let turns = 0
    const result = await runJob(
      options({
        runTurnInProcess: async () => (turns += 1, turn()),
        gradeOnce: async () => ({
          passed: false,
          rounds: [
            gradeResult(false, {
              hasEnvironmentError: true,
              checks: [
                {
                  check: { type: "log_wait", pattern: "PASS" },
                  outcome: "error",
                  summary: "日志采集起不来:probe-rs 不存在 —— 检查探针/串口,不是代码问题",
                  evidence: "",
                  elapsedMs: 5,
                },
              ],
            }),
          ],
        }),
      }),
    )

    expect(result.outcome).toBe("parked")
    expect(turns).toBe(1)
    expect(result.reason).toContain("环境问题")
  })

  test("被策略拦下的动作写进下一轮提示词 —— 别原地重试", async () => {
    const prompts: string[] = []
    let round = 0
    await runJob(
      options({
        runTurnInProcess: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return turn({
            decisions: [
              {
                time: 1,
                sessionID: "ses-1",
                callID: "c1",
                tool: "bash",
                title: "执行命令:rm -rf build",
                verdict: "deny",
                by: "policy",
                rule: "bash.not-allowed",
                elapsedMs: 1,
              },
            ],
          })
        },
        gradeOnce: async () => {
          round += 1
          return round === 1
            ? { passed: false, rounds: [gradeResult(false)] }
            : { passed: true, rounds: [gradeResult(true)] }
        },
      }),
    )

    expect(prompts[1]).toContain("权限策略拦下")
    expect(prompts[1]).toContain("rm -rf build")
  })

  test("没有 onEscalation 时把 unattended 传给子进程 —— 否则审计会伪造出一个裁决者", async () => {
    const flags: boolean[] = []
    await runJob(
      options({
        runTurnInProcess: async (input: TurnInput) => (flags.push(input.unattended), turn()),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )
    expect(flags).toEqual([true])

    const withHuman: boolean[] = []
    await runJob(
      options({
        onEscalation: async () => "reject" as const,
        runTurnInProcess: async (input: TurnInput) => (withHuman.push(input.unattended), turn()),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )
    expect(withHuman).toEqual([false])
  })

  test("会话在轮之间续用", async () => {
    const seen: (string | undefined)[] = []
    let round = 0
    await runJob(
      options({
        runTurnInProcess: async (input: TurnInput) => {
          seen.push(input.sessionID)
          return turn({ sessionID: "ses-42" })
        },
        gradeOnce: async () => {
          round += 1
          return round < 2 ? { passed: false, rounds: [gradeResult(false)] } : { passed: true, rounds: [gradeResult(true)] }
        },
      }),
    )

    expect(seen).toEqual([undefined, "ses-42"])
  })
})

describe("runJob · 善后", () => {
  test("失败时回刷 known-good 固件", async () => {
    const commands: string[] = []
    const result = await runJob(
      options({
        job: job({ budget: { maxIterations: 1, maxTokens: 100_000, wallClockMin: 60 } }),
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => ({ passed: false, rounds: [gradeResult(false)] }),
        runCommand: async (command: string) => {
          commands.push(command)
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
        },
      }),
    )

    expect(result.restored).toBe(true)
    expect(commands.some((c) => c.includes("download") && c.includes("good.elf"))).toBe(true)
  })

  test("通过时不回刷 —— 板子上应该留着修好的固件", async () => {
    const commands: string[] = []
    const result = await runJob(
      options({
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
        runCommand: async (command: string) => (commands.push(command), { exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      }),
    )

    expect(result.restored).toBeUndefined()
    expect(commands).toEqual([])
  })

  test("回刷失败不改变结论,只记录", async () => {
    const result = await runJob(
      options({
        job: job({ budget: { maxIterations: 1, maxTokens: 100_000, wallClockMin: 60 } }),
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => ({ passed: false, rounds: [gradeResult(false)] }),
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "探针没插", timedOut: false }),
      }),
    )

    expect(result.outcome).toBe("failed")
    expect(result.restored).toBe(false)
  })

  test("权限决策写进 .bench/decisions.jsonl", async () => {
    const workspace = tempDir("bench-run-")
    await runJob(
      options({
        workspace,
        runTurnInProcess: async () =>
          turn({
            decisions: [
              {
                time: 1,
                sessionID: "s",
                callID: "c",
                tool: "flash",
                title: "烧录固件",
                verdict: "allow",
                by: "policy",
                rule: "flash.download",
                elapsedMs: 2,
              },
            ],
          }),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )

    const log = await Bun.file(path.join(workspace, ".bench", "decisions.jsonl")).text()
    const entry = JSON.parse(log.trim())
    expect(entry).toMatchObject({ iteration: 1, tool: "flash", verdict: "allow", rule: "flash.download" })
  })

  test(".bench/ 自带 .gitignore —— 运行产物不能混进研发要看的 diff", async () => {
    const workspace = tempDir("bench-run-")
    await runJob(
      options({
        workspace,
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => ({ passed: true, rounds: [gradeResult(true)] }),
      }),
    )

    const ignore = await Bun.file(path.join(workspace, ".bench", ".gitignore")).text()
    expect(ignore).toContain("*")
  })

  test("统计口径:token 与耗时累加", async () => {
    let round = 0
    const result = await runJob(
      options({
        runTurnInProcess: async () => turn(),
        gradeOnce: async () => {
          round += 1
          return round < 2 ? { passed: false, rounds: [gradeResult(false)] } : { passed: true, rounds: [gradeResult(true)] }
        },
      }),
    )

    expect(result.totalTokens).toBe(300)
    expect(result.iterations.length).toBe(2)
  })
})
