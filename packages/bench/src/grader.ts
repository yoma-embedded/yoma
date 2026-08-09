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

import { resolveScriptArgv } from "./interpreter.ts"
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

/**
 * `command` 始终是给人看的那一行(报告、证据、测试断言都认它);`argv` 在有的时候是
 * **权威的**执行形态。script 判据走这条路 —— 解释器与脚本路径由本机解析出来,
 * 再拼回字符串又切一次只会白白引入引号规则(路径带空格是常态)。
 */
export type RunCommand = (
  command: string,
  options: { cwd: string; timeoutMs: number; argv?: string[]; env?: Record<string, string> },
) => Promise<RunOutcome>

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

/**
 * 判据进程的环境契约。
 *
 * 判据脚本要跨机器跑,可它总得知道 probe-rs 在哪、烧的是哪块芯片、哪个 ELF ——
 * 而这些一半是本机事实(引擎路径),一半是任务事实(芯片/探针/固件)。写死在脚本里
 * 就是把出题人那台机器钉进了判据(实测:`PROBE_RS = "/Users/ben/.../engines/bin/probe-rs"`
 * 在 Windows 工位上必炸,而报错长得像"没插板子")。所以由调试台在**执行时**注入:
 *
 * | 变量 | 含义 |
 * |---|---|
 * | `YOMA_PROBE_RS` | probe-rs 可执行文件的完整路径(Windows 上已带 .exe) |
 * | `YOMA_ENGINES_DIR` | 引擎目录(别的引擎二进制在 `<它>/bin/` 下) |
 * | `YOMA_WORKSPACE` | 工程根的绝对路径(判据的 cwd 也是它) |
 * | `YOMA_CHIP` / `YOMA_PROBE` | job.bench 里声明的芯片名与探针选择器 |
 * | `YOMA_ELF` / `YOMA_KNOWN_GOOD_ELF` | 相对工程根的固件路径 |
 * | `PYTHONIOENCODING` / `PYTHONUTF8` | 钉死 UTF-8 输出 —— 见下 |
 *
 * 脚本读不到时该有自己的兜底(单独手跑也要能用),但**别把绝对路径写死**。
 */
function checkEnv(job: Job, workspace: string, enginesDir?: string): Record<string, string> {
  const env: Record<string, string> = {
    YOMA_WORKSPACE: workspace,
    // 判据的输出必须是 UTF-8 —— 我们按 UTF-8 解管道,而 Python 在 stdout 不是终端时
    // 用 `locale.getpreferredencoding()` 编码:中文 Windows 上那是 cp936(GBK)。
    // 于是判据打印的中文进到证据里就是一串 U+FFFD,**而且是不可逆的**(实测,双机
    // 首跑的三条判据证据全花了:`xTickCount@0x200002a8: 24920 -> 25665 (?=745)`)。
    // 退出码不受影响,所以裁决是对的 —— 坏掉的恰恰是这套系统的产品:证据。
    // PYTHONIOENCODING 管 stdio 编码,PYTHONUTF8 顺带把整个解释器切到 UTF-8 模式
    // (3.7+);两个都给,老版本也吃得下。
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  }
  if (enginesDir) {
    env.YOMA_ENGINES_DIR = enginesDir
    env.YOMA_PROBE_RS = path.join(enginesDir, "bin", exe("probe-rs"))
  }
  if (job.bench.chip) env.YOMA_CHIP = job.bench.chip
  if (job.bench.probe) env.YOMA_PROBE = job.bench.probe
  if (job.bench.elf) env.YOMA_ELF = job.bench.elf
  if (job.bench.knownGoodElf) env.YOMA_KNOWN_GOOD_ELF = job.bench.knownGoodElf
  return env
}

/**
 * 在飞的判据子进程登记表 + 信号转杀。
 *
 * 判据的进程是 **detached** 起的(为了能杀整棵树,见 killTree),这意味着它们在
 * 自己的进程组里:父进程收到 SIGTERM 时它们**收不到**,父进程默认处置一死,
 * `probe-rs attach` 这类采集就成了攥着探针的孤儿 —— 下一次运行报的是"设备忙",
 * 长得和"没插板子"一模一样。信箱守护被停止/超时杀掉时正好走这条路。
 */
const activeCheckChildren = new Set<ChildProcess>()
let checkSignalHandlersInstalled = false

function installCheckSignalHandlers(): void {
  if (checkSignalHandlersInstalled) return
  checkSignalHandlersInstalled = true
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const child of activeCheckChildren) killTree(child)
      process.exit(signal === "SIGINT" ? 130 : 143)
    })
  }
}

function trackCheckChild(child: ChildProcess): void {
  installCheckSignalHandlers()
  activeCheckChildren.add(child)
  child.on("close", () => activeCheckChildren.delete(child))
}

export async function grade(options: GradeOptions): Promise<GradeResult> {
  const { job, workspace } = options
  const run = options.runCommand ?? runCommandReal
  const capture = options.captureLog ?? captureLogReal
  const env = checkEnv(job, workspace, options.enginesDir)
  const checks: CheckResult[] = []
  let hasEnvironmentError = false

  let build: CheckResult | undefined
  if (job.success.build) {
    options.onProgress?.(`构建:${job.success.build}`)
    build = await runCommandCheck(
      { type: "build", command: job.success.build, timeoutS: job.success.buildTimeoutS },
      { run, workspace, env },
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
      check.type === "build" || check.type === "bash" || check.type === "script"
        ? await runCommandCheck(check, { run, workspace, env })
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
    case "script":
      return `检查:${[check.path, ...(check.args ?? [])].join(" ")}`
    case "log_wait":
      return `检查:等待日志 /${check.pattern}/`
    case "log_absent":
      return `检查:确认日志中没有 /${check.pattern}/`
  }
}

function skipped(check: JobCheck, why: string): CheckResult {
  return { check, outcome: "skip", summary: why, evidence: "", elapsedMs: 0 }
}

type CommandCheck = Extract<JobCheck, { type: "build" | "bash" | "script" }>

/**
 * script 判据的执行形态:解释器由**本机**解析(见 interpreter.ts),脚本路径必须
 * 落在工作树内 —— 判据是从信箱里来的,允许它指向工作树外等于把"跑什么"的决定
 * 交还给了出题的那台机器。
 */
function scriptPlan(
  check: Extract<JobCheck, { type: "script" }>,
  workspace: string,
): { ok: true; command: string; argv: string[] } | { ok: false; error: string } {
  const absolute = path.resolve(workspace, check.path)
  const relative = path.relative(workspace, absolute)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `判据脚本 ${check.path} 落在工作树之外` }
  }
  const resolved = resolveScriptArgv(absolute, check.args ?? [])
  if (!resolved.ok) return { ok: false, error: resolved.error }
  // 展示用的一行:相对路径,人一眼能对上 job 里写的那条。
  const shown = [
    ...resolved.argv.slice(0, resolved.argv.length - 1 - (check.args?.length ?? 0)),
    check.path,
    ...(check.args ?? []),
  ]
  return { ok: true, command: shown.join(" "), argv: resolved.argv }
}

async function runCommandCheck(
  check: CommandCheck,
  context: { run: RunCommand; workspace: string; env?: Record<string, string> },
): Promise<CheckResult> {
  const started = Date.now()
  const defaultTimeout = check.type === "build" ? DEFAULT_BUILD_TIMEOUT_S : DEFAULT_CHECK_TIMEOUT_S
  const timeoutMs = (check.timeoutS ?? defaultTimeout) * 1000

  let command: string
  let argv: string[] | undefined
  if (check.type === "script") {
    const plan = scriptPlan(check, context.workspace)
    if (!plan.ok) {
      // 解释器/脚本本身的问题是**环境**问题:回填给 mother 的话要指向这台机器,
      // 否则它会开始"修"一个根本不存在的代码 bug(文件头那三种失败的分野)。
      return { check, outcome: "error", summary: plan.error, evidence: "", elapsedMs: Date.now() - started }
    }
    command = plan.command
    argv = plan.argv
  } else {
    command = check.command
  }

  const outcome = await context.run(command, { cwd: context.workspace, timeoutMs, argv, env: context.env })
  const elapsedMs = Date.now() - started
  const evidence = clip(joinStreams(outcome))

  if (outcome.spawnError) {
    return {
      check,
      outcome: "error",
      summary: `命令起不来:${outcome.spawnError} —— 这是环境问题,不是代码问题${spawnHint(command)}`,
      evidence,
      elapsedMs,
    }
  }
  if (outcome.timedOut) {
    return { check, outcome: "error", summary: `命令超过 ${timeoutMs / 1000}s 未结束`, evidence, elapsedMs }
  }
  const expected = check.type === "build" ? 0 : (check.expectExitCode ?? 0)
  if (outcome.exitCode !== expected) {
    return {
      check,
      outcome: "fail",
      summary: `退出码 ${outcome.exitCode}(期望 ${expected}):${command}`,
      evidence,
      elapsedMs,
    }
  }
  return { check, outcome: "pass", summary: `通过:${command}`, evidence, elapsedMs }
}

async function logCheck(
  check: Extract<JobCheck, { type: "log_wait" | "log_absent" }>,
  context: { capture: CaptureLog; workspace: string; job: Job; enginesDir?: string },
): Promise<CheckResult> {
  const started = Date.now()
  const pattern = new RegExp(check.pattern)
  const isWait = check.type === "log_wait"
  const timeoutMs =
    ((isWait ? check.timeoutS : check.windowS) ?? (isWait ? DEFAULT_CHECK_TIMEOUT_S : DEFAULT_LOG_WINDOW_S)) * 1000

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
      ? {
          check,
          outcome: "pass",
          summary: `命中 /${check.pattern}/:${outcome.matchedLine.trim()}`,
          evidence,
          elapsedMs,
        }
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

/** Windows 上 .cmd/.bat 包装器最常见的 ENOENT。判据不过 shell,所以要显式套 cmd /c。 */
const WINDOWS_CMD_WRAPPERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "west", "idf", "platformio", "pio"])

function spawnHint(command: string): string {
  if (process.platform !== "win32") return ""
  const head = path.basename(command.trim().split(/\s+/)[0] ?? "").replace(/\.(exe|cmd|bat)$/i, "")
  if (!WINDOWS_CMD_WRAPPERS.has(head)) return ""
  // 判据故意不过 shell(见文件头),而 Windows 上这些命令是 .cmd 包装器,
  // 直接 spawn 一定 ENOENT。给出能照抄的改法,别让人对着 ENOENT 猜。
  return `。Windows 上 \`${head}\` 是 .cmd 包装器,判据不过 shell 起不来 —— 改写成 \`cmd /c ${command}\``
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
export const runCommandReal: RunCommand = async (command, { cwd, timeoutMs, argv: given, env }) => {
  const argv = given ?? splitArgv(command)
  if (!argv.length) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "命令为空" }

  return new Promise<RunOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: env ? { ...process.env, ...env } : process.env,
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: (error as Error).message })
      return
    }
    trackCheckChild(child)

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
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } catch (error) {
      resolve({ tail: "", timedOut: false, spawnError: (error as Error).message })
      return
    }
    trackCheckChild(child)

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
  const argv = [
    probeRs,
    "attach",
    job.bench.elf ?? "",
    "--chip",
    job.bench.chip ?? "",
    "--non-interactive",
    "--no-timestamps",
  ]
  if (job.bench.probe) argv.push("--probe", job.bench.probe)
  return argv.filter((item) => item !== "")
}

/** Windows 上引擎二进制带 .exe。回刷固件那条路也要用它,所以导出。 */
export function exe(name: string): string {
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
