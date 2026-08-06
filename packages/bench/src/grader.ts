/**
 * 判据执行 —— runner 亲自跑,不经模型。
 *
 * ## 一条纪律:agent 说"修好了"不算数
 *
 * 每轮结束后由这里独立执行构建与检查。**日志判据自己起采集进程**,不复用 agent 写在
 * `.my-pi/logs/` 里的文件 —— 那是 agent 能写的东西,拿它当判据等于让考生自己填答题卡。
 * 同理,所有命令都用 argv 直接 spawn 不过 shell:判据不该被 `&&` 拼出第二个语义,
 * 而且 Windows 工位上没有 sh。
 *
 * ## 三种失败要分清
 *
 * - `fail`:判据跑了,结果不对(日志没出现、命令非零退出)→ 证据回填给下一轮 agent。
 * - `error`:判据自己没跑成(命令不存在、探针没插、超时)→ 这是环境问题,回填的
 *   提示要指向环境而不是代码,否则 agent 会开始"修"一个根本不存在的 bug。
 * - `skip`:前置失败(构建没过就不必采日志)→ 不算证据。
 *
 * ## 日志采集
 *
 * RTT 走 `probe-rs attach`(engines/bin 里的那个,不是 PATH 上的),命令模式走 argv。
 * 两者都是"起进程 → 读 stdout/stderr → 命中即停 / 到点即停 → 杀进程树"。杀进程树是
 * 必须的:真正攥着串口的常常是 `sh -c` 的孙子进程,只杀直接子进程会留下孤儿,
 * 下一轮采集就会撞上"设备忙",而那个报错长得和"没插板子"一模一样。
 */

import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

import {
  DEFAULT_BUILD_TIMEOUT_S,
  DEFAULT_CHECK_TIMEOUT_S,
  DEFAULT_LOG_WINDOW_S,
  type Job,
  type JobCheck,
  type JobLogSource,
} from "./job.ts"

export type CheckOutcome = "pass" | "fail" | "error" | "skip"

export interface CheckResult {
  check: JobCheck
  outcome: CheckOutcome
  /** 一句话结论,进报告标题行。 */
  summary: string
  /** 证据:命令输出或日志摘录,回填给下一轮 agent。已截断。 */
  evidence: string
  elapsedMs: number
}

export interface GradeResult {
  passed: boolean
  /** 构建单列 —— 它失败时后面的检查全部 skip。 */
  build?: CheckResult
  checks: CheckResult[]
  /** 判据自身没跑成(环境问题),与"代码不对"要分开报。 */
  hasEnvironmentError: boolean
}

export interface GradeOptions {
  job: Job
  workspace: string
  enginesDir?: string
  /** 进度回调,给 CLI 打印。 */
  onProgress?: (message: string) => void
  /** 测试注入:替换掉真实的进程执行。 */
  runCommand?: RunCommand
  /** 测试注入:替换掉真实的日志采集。 */
  captureLog?: CaptureLog
}

export interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 进程根本没起来(命令不存在等)。 */
  spawnError?: string
}

export type RunCommand = (command: string, options: { cwd: string; timeoutMs: number }) => Promise<RunOutcome>

export interface CaptureOutcome {
  /** 命中的那一行(log_wait 用)。 */
  matchedLine?: string
  /** 采集到的尾部日志,做证据。 */
  tail: string
  timedOut: boolean
  spawnError?: string
}

export type CaptureLog = (options: {
  source: JobLogSource
  pattern: RegExp
  /** wait:命中即停;window:采满时间窗再看有没有命中。 */
  mode: "wait" | "window"
  timeoutMs: number
  cwd: string
  job: Job
  enginesDir?: string
}) => Promise<CaptureOutcome>

/** 证据上限:够看清问题,又不至于把上下文吃光。 */
const EVIDENCE_CHARS = 4000

export async function grade(options: GradeOptions): Promise<GradeResult> {
  const { job, workspace } = options
  const run = options.runCommand ?? runCommandReal
  const capture = options.captureLog ?? captureLogReal
  const checks: CheckResult[] = []
  let hasEnvironmentError = false

  let build: CheckResult | undefined
  if (job.success.build) {
    options.onProgress?.(`构建:${job.success.build}`)
    build = await runCommandCheck(
      { type: "build", command: job.success.build, timeoutS: job.success.buildTimeoutS },
      { run, workspace },
    )
    if (build.outcome === "error") hasEnvironmentError = true
    if (build.outcome !== "pass") {
      return {
        passed: false,
        build,
        checks: job.success.checks.map((check) => skipped(check, "构建没过,后面的检查没跑")),
        hasEnvironmentError,
      }
    }
  }

  for (const check of job.success.checks) {
    options.onProgress?.(describeCheck(check))
    const result =
      check.type === "build" || check.type === "bash"
        ? await runCommandCheck(check, { run, workspace })
        : await logCheck(check, { capture, workspace, job, enginesDir: options.enginesDir })
    if (result.outcome === "error") hasEnvironmentError = true
    checks.push(result)
  }

  return {
    passed: build?.outcome !== "fail" && checks.every((result) => result.outcome === "pass"),
    build,
    checks,
    hasEnvironmentError,
  }
}

/** 全部判据连续通过 repeat 次才算成功。竞态类 bug 用它做 pass^k。 */
export async function gradeRepeated(options: GradeOptions): Promise<{ passed: boolean; rounds: GradeResult[] }> {
  const repeat = Math.max(1, options.job.success.repeat ?? 1)
  const rounds: GradeResult[] = []
  for (let round = 1; round <= repeat; round += 1) {
    if (repeat > 1) options.onProgress?.(`判据第 ${round}/${repeat} 轮`)
    const result = await grade(options)
    rounds.push(result)
    if (!result.passed) return { passed: false, rounds }
  }
  return { passed: true, rounds }
}

function describeCheck(check: JobCheck): string {
  switch (check.type) {
    case "build":
    case "bash":
      return `检查:${check.command}`
    case "log_wait":
      return `检查:等待日志 /${check.pattern}/`
    case "log_absent":
      return `检查:确认日志中没有 /${check.pattern}/`
  }
}

function skipped(check: JobCheck, why: string): CheckResult {
  return { check, outcome: "skip", summary: why, evidence: "", elapsedMs: 0 }
}

async function runCommandCheck(
  check: Extract<JobCheck, { type: "build" | "bash" }>,
  context: { run: RunCommand; workspace: string },
): Promise<CheckResult> {
  const started = Date.now()
  const defaultTimeout = check.type === "build" ? DEFAULT_BUILD_TIMEOUT_S : DEFAULT_CHECK_TIMEOUT_S
  const timeoutMs = (check.timeoutS ?? defaultTimeout) * 1000
  const outcome = await context.run(check.command, { cwd: context.workspace, timeoutMs })
  const elapsedMs = Date.now() - started
  const evidence = clip(joinStreams(outcome))

  if (outcome.spawnError) {
    return {
      check,
      outcome: "error",
      summary: `命令起不来:${outcome.spawnError} —— 这是环境问题,不是代码问题`,
      evidence,
      elapsedMs,
    }
  }
  if (outcome.timedOut) {
    return { check, outcome: "error", summary: `命令超过 ${timeoutMs / 1000}s 未结束`, evidence, elapsedMs }
  }
  const expected = check.type === "bash" ? (check.expectExitCode ?? 0) : 0
  if (outcome.exitCode !== expected) {
    return {
      check,
      outcome: "fail",
      summary: `退出码 ${outcome.exitCode}(期望 ${expected}):${check.command}`,
      evidence,
      elapsedMs,
    }
  }
  return { check, outcome: "pass", summary: `通过:${check.command}`, evidence, elapsedMs }
}

async function logCheck(
  check: Extract<JobCheck, { type: "log_wait" | "log_absent" }>,
  context: { capture: CaptureLog; workspace: string; job: Job; enginesDir?: string },
): Promise<CheckResult> {
  const started = Date.now()
  const pattern = new RegExp(check.pattern)
  const isWait = check.type === "log_wait"
  const timeoutMs = ((isWait ? check.timeoutS : check.windowS) ?? (isWait ? DEFAULT_CHECK_TIMEOUT_S : DEFAULT_LOG_WINDOW_S)) * 1000

  const outcome = await context.capture({
    source: check.source ?? { kind: "rtt" },
    pattern,
    mode: isWait ? "wait" : "window",
    timeoutMs,
    cwd: context.workspace,
    job: context.job,
    enginesDir: context.enginesDir,
  })
  const elapsedMs = Date.now() - started
  const evidence = clip(outcome.tail)

  if (outcome.spawnError) {
    return {
      check,
      outcome: "error",
      summary: `日志采集起不来:${outcome.spawnError} —— 检查探针/串口,不是代码问题`,
      evidence,
      elapsedMs,
    }
  }

  if (isWait) {
    return outcome.matchedLine
      ? { check, outcome: "pass", summary: `命中 /${check.pattern}/:${outcome.matchedLine.trim()}`, evidence, elapsedMs }
      : {
          check,
          outcome: "fail",
          summary: `${timeoutMs / 1000}s 内没有等到 /${check.pattern}/`,
          evidence,
          elapsedMs,
        }
  }
  return outcome.matchedLine
    ? {
        check,
        outcome: "fail",
        summary: `不该出现的 /${check.pattern}/ 出现了:${outcome.matchedLine.trim()}`,
        evidence,
        elapsedMs,
      }
    : { check, outcome: "pass", summary: `${timeoutMs / 1000}s 内没有出现 /${check.pattern}/`, evidence, elapsedMs }
}

function joinStreams(outcome: RunOutcome): string {
  const parts: string[] = []
  if (outcome.stdout.trim()) parts.push(outcome.stdout.trimEnd())
  if (outcome.stderr.trim()) parts.push(`--- stderr ---\n${outcome.stderr.trimEnd()}`)
  return parts.join("\n")
}

/** 取尾部 —— 编译错误和 panic 都在末尾,开头往往是几百行"正在编译"。 */
function clip(text: string, limit = EVIDENCE_CHARS): string {
  if (text.length <= limit) return text
  return `…(前 ${text.length - limit} 字符省略)\n${text.slice(-limit)}`
}

// ---------------------------------------------------------------------------
// 真实执行
// ---------------------------------------------------------------------------

/**
 * argv 直接 spawn,**不过 shell**。
 *
 * 判据里写 `make -j8` 是一条命令,不是一段脚本 —— 过 shell 就等于允许判据自己
 * 拼出第二个语义,而且 Windows 工位上没有 sh。要管道请写成一个脚本文件再调它。
 */
export const runCommandReal: RunCommand = async (command, { cwd, timeoutMs }) => {
  const argv = splitArgv(command)
  if (!argv.length) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "命令为空" }

  return new Promise<RunOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: (error as Error).message })
      return
    }

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const settle = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    child.on("error", (error) => settle({ exitCode: null, stdout, stderr, timedOut, spawnError: error.message }))
    child.on("close", (code) => settle({ exitCode: code, stdout, stderr, timedOut }))
  })
}

export const captureLogReal: CaptureLog = async ({ source, pattern, mode, timeoutMs, cwd, job, enginesDir }) => {
  const argv = source.kind === "command" ? splitArgv(source.command) : rttArgv(job, enginesDir)
  if (!argv.length) return { tail: "", timedOut: false, spawnError: "采集命令为空" }

  return new Promise<CaptureOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
    } catch (error) {
      resolve({ tail: "", timedOut: false, spawnError: (error as Error).message })
      return
    }

    const lines: string[] = []
    let matchedLine: string | undefined
    let pendingStdout = ""
    let pendingStderr = ""
    let settled = false

    const settle = (outcome: Omit<CaptureOutcome, "tail">) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      resolve({ ...outcome, tail: lines.slice(-200).join("\n") })
    }

    const consume = (chunk: string, buffer: "out" | "err") => {
      const pending = (buffer === "out" ? pendingStdout : pendingStderr) + chunk
      const parts = pending.split(/\r?\n/)
      const rest = parts.pop() ?? ""
      if (buffer === "out") pendingStdout = rest
      else pendingStderr = rest
      for (const line of parts) {
        lines.push(line)
        if (!matchedLine && pattern.test(line)) {
          matchedLine = line
          // wait 模式命中即停;window 模式要把时间窗走完(后面可能还有更糟的)。
          if (mode === "wait") settle({ matchedLine, timedOut: false })
        }
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => consume(chunk.toString(), "out"))
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk.toString(), "err"))

    const timer = setTimeout(() => settle({ matchedLine, timedOut: true }), timeoutMs)

    child.on("error", (error) => settle({ matchedLine, timedOut: false, spawnError: error.message }))
    child.on("close", () => settle({ matchedLine, timedOut: false }))
  })
}

/**
 * RTT 采集的 argv。用 engines/bin 里的 probe-rs 而不是 PATH 上的 ——
 * 工位上很可能装着另一个版本,判据必须和 agent 用的是同一个二进制。
 */
function rttArgv(job: Job, enginesDir?: string): string[] {
  const probeRs = enginesDir ? path.join(enginesDir, "bin", exe("probe-rs")) : exe("probe-rs")
  const argv = [probeRs, "attach", job.bench.elf ?? "", "--chip", job.bench.chip ?? "", "--non-interactive", "--no-timestamps"]
  if (job.bench.probe) argv.push("--probe", job.bench.probe)
  return argv.filter((item) => item !== "")
}

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

/**
 * 杀进程树。真正攥着串口/探针的往往是孙子进程,只杀直接子进程会留下孤儿,
 * 下一次采集失败的样子和"没插板子"一模一样。
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" })
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // 已经死了。
    }
  }
}

/** 极简 argv 切分:支持单双引号,不做变量展开(判据不该依赖 shell 语义)。 */
export function splitArgv(command: string): string[] {
  const argv: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let has = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      has = true
      continue
    }
    if (/\s/.test(char)) {
      if (has || current) argv.push(current)
      current = ""
      has = false
      continue
    }
    current += char
  }
  if (has || current) argv.push(current)
  return argv
}
