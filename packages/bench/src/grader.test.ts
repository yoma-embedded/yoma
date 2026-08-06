import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { grade, gradeRepeated, runCommandReal, splitArgv, type CaptureLog, type RunCommand } from "./grader.ts"
import { parseJob, type Job } from "./job.ts"

function job(success: Record<string, unknown>): Job {
  return parseJob({
    id: "j-1",
    title: "t",
    task: "修 bug",
    repo: { directory: "/tmp/ws" },
    bench: { chip: "STM32G474RE", elf: "build/main.elf", knownGoodElf: "good.elf" },
    success,
    policy: "unattended",
  })
}

const okRun: RunCommand = async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })
const failRun: RunCommand = async () => ({ exitCode: 1, stdout: "", stderr: "error: undefined reference", timedOut: false })

function captureThat(result: Partial<Awaited<ReturnType<CaptureLog>>>): CaptureLog {
  return async () => ({ tail: "", timedOut: false, ...result })
}

describe("grade · 命令判据", () => {
  test("退出码 0 通过", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "bash", command: "true" }] }),
      workspace: "/tmp/ws",
      runCommand: okRun,
    })
    expect(result.passed).toBe(true)
    expect(result.checks[0]!.outcome).toBe("pass")
  })

  test("非零退出判 fail,证据带 stderr", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "bash", command: "make test" }] }),
      workspace: "/tmp/ws",
      runCommand: failRun,
    })
    expect(result.passed).toBe(false)
    expect(result.checks[0]!.outcome).toBe("fail")
    expect(result.checks[0]!.evidence).toContain("undefined reference")
  })

  test("命令起不来判 error 而不是 fail —— 环境问题不该让 agent 去改代码", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "bash", command: "nonexistent-tool" }] }),
      workspace: "/tmp/ws",
      runCommand: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }),
    })
    expect(result.checks[0]!.outcome).toBe("error")
    expect(result.hasEnvironmentError).toBe(true)
    expect(result.checks[0]!.summary).toContain("环境问题")
  })

  test("超时判 error", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "bash", command: "sleep 999", timeoutS: 1 }] }),
      workspace: "/tmp/ws",
      runCommand: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
    })
    expect(result.checks[0]!.outcome).toBe("error")
  })

  test("expectExitCode 可以要求非零 —— 有些判据就是要命令失败", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "bash", command: "grep -q panic log.txt", expectExitCode: 1 }] }),
      workspace: "/tmp/ws",
      runCommand: failRun,
    })
    expect(result.checks[0]!.outcome).toBe("pass")
  })
})

describe("grade · 构建门", () => {
  test("构建失败时后面的检查全部 skip", async () => {
    const result = await grade({
      job: job({ build: "make", checks: [{ type: "bash", command: "true" }, { type: "log_wait", pattern: "PASS" }] }),
      workspace: "/tmp/ws",
      runCommand: failRun,
    })
    expect(result.passed).toBe(false)
    expect(result.build!.outcome).toBe("fail")
    expect(result.checks.map((c) => c.outcome)).toEqual(["skip", "skip"])
  })

  test("构建通过后才跑检查", async () => {
    let builds = 0
    const result = await grade({
      job: job({ build: "make", checks: [{ type: "bash", command: "true" }] }),
      workspace: "/tmp/ws",
      runCommand: async (command) => {
        if (command === "make") builds += 1
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
      },
    })
    expect(builds).toBe(1)
    expect(result.passed).toBe(true)
  })
})

describe("grade · 日志判据", () => {
  test("log_wait 命中即通过", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "log_wait", pattern: "SELFTEST PASS" }] }),
      workspace: "/tmp/ws",
      captureLog: captureThat({ matchedLine: "[t=12] SELFTEST PASS", tail: "…" }),
    })
    expect(result.checks[0]!.outcome).toBe("pass")
    expect(result.checks[0]!.summary).toContain("SELFTEST PASS")
  })

  test("log_wait 没命中判 fail,证据是日志尾巴", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "log_wait", pattern: "SELFTEST PASS", timeoutS: 5 }] }),
      workspace: "/tmp/ws",
      captureLog: captureThat({ timedOut: true, tail: "boot\ninit\nADC calib fail" }),
    })
    expect(result.checks[0]!.outcome).toBe("fail")
    expect(result.checks[0]!.evidence).toContain("ADC calib fail")
  })

  test("log_absent 出现即 fail", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "log_absent", pattern: "HardFault" }] }),
      workspace: "/tmp/ws",
      captureLog: captureThat({ matchedLine: "HardFault at 0x0800123c", tail: "…" }),
    })
    expect(result.checks[0]!.outcome).toBe("fail")
    expect(result.checks[0]!.summary).toContain("不该出现")
  })

  test("log_absent 没出现即通过", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "log_absent", pattern: "HardFault", windowS: 3 }] }),
      workspace: "/tmp/ws",
      captureLog: captureThat({ timedOut: true, tail: "一切正常" }),
    })
    expect(result.checks[0]!.outcome).toBe("pass")
  })

  test("采集起不来判 error,提示指向探针而不是代码", async () => {
    const result = await grade({
      job: job({ checks: [{ type: "log_wait", pattern: "PASS" }] }),
      workspace: "/tmp/ws",
      captureLog: captureThat({ spawnError: "probe-rs 不存在" }),
    })
    expect(result.checks[0]!.outcome).toBe("error")
    expect(result.checks[0]!.summary).toContain("探针")
  })

  test("wait 用 timeoutS,absent 用 windowS", async () => {
    const seen: number[] = []
    await grade({
      job: job({
        checks: [
          { type: "log_wait", pattern: "A", timeoutS: 7 },
          { type: "log_absent", pattern: "B", windowS: 3 },
        ],
      }),
      workspace: "/tmp/ws",
      captureLog: async ({ timeoutMs }) => (seen.push(timeoutMs), { tail: "", timedOut: true }),
    })
    expect(seen).toEqual([7000, 3000])
  })
})

describe("gradeRepeated", () => {
  test("repeat=3 时全部通过才算过", async () => {
    let rounds = 0
    const result = await gradeRepeated({
      job: job({ checks: [{ type: "bash", command: "true" }], repeat: 3 }),
      workspace: "/tmp/ws",
      runCommand: async () => (rounds += 1, { exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    })
    expect(result.passed).toBe(true)
    expect(rounds).toBe(3)
  })

  test("任何一轮失败立刻停 —— 竞态 bug 不给第二次机会", async () => {
    let rounds = 0
    const result = await gradeRepeated({
      job: job({ checks: [{ type: "bash", command: "flaky" }], repeat: 5 }),
      workspace: "/tmp/ws",
      runCommand: async () => {
        rounds += 1
        return { exitCode: rounds === 2 ? 1 : 0, stdout: "", stderr: "", timedOut: false }
      },
    })
    expect(result.passed).toBe(false)
    expect(rounds).toBe(2)
    expect(result.rounds.length).toBe(2)
  })
})

describe("真实执行", () => {
  test("runCommandReal 跑真进程,argv 不过 shell", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grader-"))
    try {
      writeFileSync(path.join(dir, "hello.txt"), "hi\n")
      const ok = await runCommandReal("ls hello.txt", { cwd: dir, timeoutMs: 5000 })
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toContain("hello.txt")

      // 过 shell 的话这里会创建 pwned 文件;不过 shell 就只是 ls 一个怪名字失败。
      const chained = await runCommandReal("ls hello.txt && touch pwned", { cwd: dir, timeoutMs: 5000 })
      expect(chained.exitCode).not.toBe(0)
      expect(await Bun.file(path.join(dir, "pwned")).exists()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("命令不存在时给 spawnError 而不是抛", async () => {
    const outcome = await runCommandReal("definitely-not-a-real-binary-xyz", { cwd: tmpdir(), timeoutMs: 3000 })
    expect(outcome.spawnError).toBeDefined()
  })

  test("超时会杀掉进程并标记 timedOut", async () => {
    const outcome = await runCommandReal("sleep 30", { cwd: tmpdir(), timeoutMs: 300 })
    expect(outcome.timedOut).toBe(true)
  })
})

describe("splitArgv", () => {
  test("引号内的空格不切", () => {
    expect(splitArgv(`cmd "a b" 'c d' e`)).toEqual(["cmd", "a b", "c d", "e"])
  })

  test("空字符串参数保留", () => {
    expect(splitArgv(`cmd "" x`)).toEqual(["cmd", "", "x"])
  })
})
