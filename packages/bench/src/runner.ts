/**
 * 迭代状态机 —— job 的一生。
 *
 * ```
 * prepare ─→ (agent 轮 ─→ grade)* ─→ deliver / park
 *                 ↑            │
 *                 └── 证据回填 ─┘
 * ```
 *
 * ## 三条不变式
 *
 * 1. **判据由 runner 跑,agent 只看结果。** 见 grader.ts 的文件头。
 * 2. **预算是硬上限,不是建议。** 迭代数、token、墙钟三个,任何一个到顶立刻停;
 *    token 上限在轮内也生效(shouldStop 注入进 turn),否则一轮跑飞就能吃光预算。
 * 3. **失败要回到已知状态。** unattended 任务失败/超预算时回刷 knownGoodElf,
 *    否则板子留在半烧状态,下一个任务开局就是坏的 —— 而且那种坏法看起来像"新 bug"。
 *
 * ## 为什么 agent 轮跑在子进程里
 *
 * my-pi 的探针租约、gdb 会话表、log 采集器都是模块级全局并挂着退出钩子。
 * 进程边界 = 免费且可靠的清理:agent 轮一结束,探针/串口/gdbserver 一定被收干净,
 * grade 阶段去烧录采日志时不会撞上"探针被占着"。会话是落盘 JSONL,换进程不丢历史。
 * 注入 runTurnInProcess 可以在测试里跳过子进程。
 */

import { spawn } from "node:child_process"
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { PermissionRequest } from "@yoma-desktop/kernel"
import type { PermissionDecision } from "@yoma-desktop/kernel/host"

import type { FauxScript } from "./faux.ts"
import { fileExists, readJsonFile, readTextFile } from "./fsx.ts"
import { exe, gradeRepeated, runCommandReal, type GradeResult, type RunCommand } from "./grader.ts"
import type { Job } from "./job.ts"
import { blockedPrompt, firstPrompt, retryPrompt } from "./prompts.ts"
import type { TurnResult } from "./turn.ts"

export type JobOutcome = "passed" | "failed" | "parked" | "error"

export interface Iteration {
  index: number
  turn: TurnResult
  grade?: GradeResult
  startedAt: number
  endedAt: number
}

export interface RunnerResult {
  job: Job
  outcome: JobOutcome
  /** 停下来的原因:预算耗尽、判据通过、环境错误、人拒绝了…… */
  reason: string
  sessionID?: string
  iterations: Iteration[]
  decisions: PermissionDecision[]
  totalTokens: number
  totalCost: number
  elapsedMs: number
  /** 失败时是否成功回刷了 known-good 固件。 */
  restored?: boolean
}

export interface RunnerOptions {
  job: Job
  workspace: string
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  /** 审计与产物目录,默认 `<workspace>/.bench`。 */
  benchDir?: string
  onProgress?: (message: string) => void
  /**
   * 权限升级的处理者。返回 reject 表示这条路不通(会写进下一轮提示词);
   * 无人值守且没人接时不传 —— 一律拒绝,任务照跑,失败会写清楚是被策略挡的。
   */
  onEscalation?: (request: PermissionRequest) => Promise<"once" | "always" | "reject">
  /** 测试注入:跳过子进程直接在进程内跑一轮。 */
  runTurnInProcess?: (input: TurnInput) => Promise<TurnResult>
  runCommand?: RunCommand
  /** 测试注入:替换 grader。 */
  gradeOnce?: (iteration: number) => Promise<{ passed: boolean; rounds: GradeResult[] }>
  now?: () => number
}

/** 子进程入口收到的全部输入。序列化成 JSON 走 argv 指向的文件。 */
export interface TurnInput {
  job: Job
  workspace: string
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  sessionID?: string
  prompt: string
  maxTokens: number
  spentTokens: number
  /**
   * 没有人接管(`--yes` 或夜间跑)。子进程据此把策略的 escalate 直接转成 deny,
   * 而不是发出一个注定被自动拒绝的 ask —— 差别全在审计:走 ask 流的拒绝会记成
   * `by: "human"`,而当时根本没有人。责任人记错比记漏更糟。
   */
  unattended: boolean
  /**
   * 打包态的子进程入口(esbuild 产物 mailbox-turn-entry.mjs 的绝对路径),由宿主
   * 显式传入,**不猜**。缺省只在 bun 运行时合法(直跑 turn-entry.ts 源码);
   * exe 里 process.execPath 是 Electron,不给入口就是配置错误,如实抛。
   */
  turnEntry?: string
  /** 技能/上下文/凭据的全局目录。生产不传(默认 ~/.my-pi);演练与测试传临时目录隔离。 */
  configDir?: string
  /** 假模型脚本(本机演练/打包冒烟)。有它则子进程不联网、不要 key,其余全真。 */
  faux?: FauxScript
}

export async function runJob(options: RunnerOptions): Promise<RunnerResult> {
  const { job, workspace } = options
  const now = options.now ?? Date.now
  const started = now()
  const benchDir = options.benchDir ?? path.join(workspace, ".bench")
  const decisionsLog = path.join(benchDir, "decisions.jsonl")
  await ensureBenchDir(benchDir)

  await ensureMyPiIgnore(workspace)
  const iterations: Iteration[] = []
  const decisions: PermissionDecision[] = []
  let sessionID: string | undefined
  let totalTokens = 0
  let totalCost = 0
  let outcome: JobOutcome = "failed"
  let reason = ""

  const deadline = started + job.budget.wallClockMin * 60 * 1000
  const progress = (message: string) => options.onProgress?.(message)

  let prompt = firstPrompt(job)

  for (let index = 1; index <= job.budget.maxIterations; index += 1) {
    if (now() >= deadline) {
      outcome = "failed"
      reason = `墙钟预算 ${job.budget.wallClockMin} 分钟耗尽`
      break
    }
    if (totalTokens >= job.budget.maxTokens) {
      outcome = "failed"
      reason = `token 预算 ${job.budget.maxTokens} 耗尽`
      break
    }

    progress(`─── 第 ${index}/${job.budget.maxIterations} 轮 ───`)
    const iterationStarted = now()
    const input: TurnInput = {
      job,
      workspace,
      sessionsRoot: options.sessionsRoot,
      stateDir: options.stateDir,
      enginesDir: options.enginesDir,
      sessionID,
      prompt,
      maxTokens: job.budget.maxTokens,
      spentTokens: totalTokens,
      unattended: !options.onEscalation,
    }

    let turn: TurnResult
    try {
      turn = options.runTurnInProcess
        ? await options.runTurnInProcess(input)
        : await runTurnInChildProcess(input, { onEscalation: options.onEscalation, onProgress: progress })
    } catch (error) {
      outcome = "error"
      reason = `agent 轮执行失败:${(error as Error).message}`
      break
    }

    sessionID = turn.sessionID
    totalTokens += turn.usage.tokens.input + turn.usage.tokens.output
    totalCost += turn.usage.cost
    decisions.push(...turn.decisions)
    if (turn.decisions.length) {
      await appendFile(
        decisionsLog,
        turn.decisions.map((decision) => JSON.stringify({ iteration: index, ...decision })).join("\n") + "\n",
      ).catch(() => {})
    }

    const iteration: Iteration = { index, turn, startedAt: iterationStarted, endedAt: now() }
    iterations.push(iteration)

    if (turn.stopReason) {
      outcome = "failed"
      reason = turn.stopReason
      break
    }

    progress("判据执行中(由调试台独立跑,不经模型)")
    const graded = options.gradeOnce
      ? await options.gradeOnce(index)
      : await gradeRepeated({
          job,
          workspace,
          enginesDir: options.enginesDir,
          onProgress: progress,
          runCommand: options.runCommand,
        })
    const last = graded.rounds[graded.rounds.length - 1]
    iteration.grade = last

    if (graded.passed) {
      outcome = "passed"
      reason = `第 ${index} 轮判据全部通过`
      break
    }

    // 环境错误不该消耗迭代预算去"修代码" —— 挂起给人看更诚实。
    if (last?.hasEnvironmentError) {
      outcome = "parked"
      reason = "判据没跑成(环境问题):" + (last.checks.find((c) => c.outcome === "error")?.summary ?? "")
      break
    }

    if (index === job.budget.maxIterations) {
      outcome = "failed"
      reason = `迭代预算 ${job.budget.maxIterations} 轮用尽,判据仍未通过`
      break
    }

    const blocked = turn.decisions
      .filter((decision) => decision.verdict === "deny")
      .map((decision) => ({ tool: decision.tool, title: decision.title, why: decision.rule }))
    prompt = last ? retryPrompt(job, last, index + 1) : prompt
    if (blocked.length) prompt = `${blockedPrompt(blocked)}\n\n${prompt}`
  }

  // 失败/挂起要回到已知状态。烧录本身可能失败(探针拔了),那不改变结论,只记进报告。
  let restored: boolean | undefined
  if (outcome !== "passed" && job.bench.knownGoodElf && job.bench.chip) {
    progress(`回刷 known-good 固件:${job.bench.knownGoodElf}`)
    restored = await restoreKnownGood(job, workspace, options)
  }

  return {
    job,
    outcome,
    reason: reason || "未知",
    sessionID,
    iterations,
    decisions,
    totalTokens,
    totalCost,
    elapsedMs: now() - started,
    restored,
  }
}

/**
 * 建 .bench/ 并让 git 忽略它的**运行产物**。
 *
 * 不忽略的话,轮次输入输出、决策日志会被 `git add -A` 卷进提交 —— 研发打开 diff
 * 看到的是五个 bench 内部文件加一处真改动,审阅体验直接毁掉(实测第一次真跑就中了)。
 * 忽略文件放在目录内部而不是改仓库的 .gitignore:那是用户的文件,调试台不该动它。
 *
 * 但**不能忽略整个目录**:项目模板与判据脚本也住在这里,它们是项目配置,必须跟着
 * 仓库走 —— 否则跨机器就断了:工位机克隆下来没有判据脚本,判据一律"命令起不来"
 * (旧版本的 `*` 正是这样,实测 `.bench` 下零个文件被跟踪)。known-good 固件同理
 * 放行,提不提交由项目自己定。
 */
// 注意:**不要**写 `!.gitignore` 把它自己放出来。它是调试台自己生成的文件,
// 露出来就是一个未跟踪又不被忽略的文件 —— 工作树因此永远"不干净",而 prepareBranch
// 的第一道检查正是"工作树必须干净"(实测:加了那一行,每一轮开局就被自己挡死)。
// 被忽略不影响它生效:git 读 .gitignore 与它是否被跟踪无关。
const BENCH_IGNORE = `# 调试台的**运行产物**不进版本库;模板与判据脚本是项目配置,要跟着仓库走。
*
!mailbox.template.json
!checks/
!checks/**
!known-good/
!known-good/**
`
/** 旧版整目录忽略的原文。只有内容与它逐字相同才升级 —— 用户改过就不动。 */
const LEGACY_BENCH_IGNORE = "# 调试台的运行产物,不进版本库(含自身)\n*\n"

export async function ensureBenchDir(benchDir: string): Promise<void> {
  await mkdir(benchDir, { recursive: true })
  const ignore = path.join(benchDir, ".gitignore")
  if (!(await fileExists(ignore))) {
    await writeFile(ignore, BENCH_IGNORE)
    return
  }
  const current = await readTextFile(ignore).catch(() => "")
  if (current === LEGACY_BENCH_IGNORE) await writeFile(ignore, BENCH_IGNORE)
}

/**
 * 让 my-pi 工具的运行产物(gdb 会话日志、烧录状态、采集日志)不进版本库。
 *
 * 与 `.bench` 同一个教训的第二次上演:第一次真跑信箱闭环,agent 分支的 diff 里
 * 17 个文件有 16 个是 `.my-pi/gdb/*.mi` 这类工具日志,真正的代码改动只有 1 个文件。
 * 只忽略**运行产物**而不是整个目录 —— `.my-pi/` 里还可能住着用户自己提交的
 * 项目技能与上下文;已有 .gitignore 时不动它(那是用户的文件)。
 */
export async function ensureMyPiIgnore(workspace: string): Promise<void> {
  const dir = path.join(workspace, ".my-pi")
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!(await fileExists(ignore))) {
    await writeFile(ignore, "# yoma 调试工具的运行产物,不进版本库(技能等用户文件不受影响)\ngdb/\nlogs/\nflash-state.json\n")
  }
}

/** 回刷 known-good 固件。信箱模式的收尾也用它,所以第三参收窄成真正需要的两个注入位。 */
export async function restoreKnownGood(
  job: Job,
  workspace: string,
  options: { enginesDir?: string; runCommand?: RunCommand },
): Promise<boolean> {
  const run = options.runCommand ?? runCommandReal
  // 必须过 exe():Windows 上少了 .exe 就 spawn 不起来 —— 而这里是**失败兜底路径**,
  // 它坏掉的时机正好是"别的都已经出错了",板子留在半烧状态没人回刷。
  const probeRs = options.enginesDir ? path.join(options.enginesDir, "bin", exe("probe-rs")) : exe("probe-rs")
  const argv = [probeRs, "download", "--chip", job.bench.chip!, job.bench.knownGoodElf!]
  if (job.bench.probe) argv.push("--probe", job.bench.probe)
  const outcome = await run(argv.map(quoteIfNeeded).join(" "), { cwd: workspace, timeoutMs: 3 * 60 * 1000 })
  return outcome.exitCode === 0
}

function quoteIfNeeded(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part
}

/**
 * 在飞的 turn-entry 子进程登记表 + 信号转杀。
 *
 * 没有它,SIGTERM/SIGINT 只杀得死 runner 本体,正在跑的 agent 轮变成孤儿继续
 * 烧录/gdb/采日志 —— 无判据、无回填、无人监督地驱动硬件(实测复现过:sim 超时
 * 杀掉 runner 后,孙进程把整轮跑完才放手)。收到信号先把孩子带走,再按约定退出。
 */
const activeTurnChildren = new Set<ReturnType<typeof spawn>>()
let signalHandlersInstalled = false

function installTurnSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const child of activeTurnChildren) child.kill("SIGTERM")
      // 立即退出而不是等孩子:孩子的默认信号处置就是死,拖着只会让上层收尸超时。
      process.exit(signal === "SIGINT" ? 130 : 143)
    })
  }
}

/**
 * 起一个子进程跑一轮。
 *
 * 协议刻意做得又小又蠢:输入是一个 JSON 文件,输出是另一个 JSON 文件,
 * stderr 是给人看的进度,stdout 上的 `@@escalate` 行是唯一的双向通道
 * (子进程问、父进程答到 stdin)。这样出了事可以直接拿输入文件重放一轮。
 *
 * 导出给信箱模式复用:那边每个信箱轮就是一次本调用,进程边界的探针清理同样成立。
 */
export async function runTurnInChildProcess(
  input: TurnInput,
  handlers: {
    onEscalation?: (request: PermissionRequest) => Promise<"once" | "always" | "reject">
    onProgress?: (message: string) => void
  },
): Promise<TurnResult> {
  const dir = path.join(input.workspace, ".bench", "turns")
  await mkdir(dir, { recursive: true })
  const stamp = `${input.job.id}-${input.spentTokens}-${input.prompt.length}`
  const inputFile = path.join(dir, `turn-${stamp}.json`)
  const outputFile = path.join(dir, `turn-${stamp}.result.json`)
  await writeFile(inputFile, JSON.stringify(input, null, 2))
  // stamp 可能与上次运行撞名(同 job 重新入箱时首轮必撞)。旧结果文件不清掉的话,
  // 本次子进程崩溃没写输出时,父进程会把**上次的结果**当本轮结果回填 —— 静默错账。
  await rm(outputFile, { force: true })

  // 双态入口:显式传入的打包产物优先;bun 运行时可退到直跑源码。两者都不满足是
  // 配置错误(exe 里 execPath 是 Electron 本体,盲目 spawn 会把整个 app 再起一遍)。
  const entry =
    input.turnEntry ?? (process.versions.bun ? path.join(path.dirname(fileURLToPath(import.meta.url)), "turn-entry.ts") : undefined)
  if (!entry) throw new Error("非 bun 运行时必须显式传 TurnInput.turnEntry(esbuild 打包的子进程入口)")
  installTurnSignalHandlers()
  const child = spawn(process.execPath, [entry, inputFile, outputFile], {
    cwd: input.workspace,
    stdio: ["pipe", "pipe", "inherit"],
    // Electron 看到它就以纯 node 面目运行;bun 与真 node 无视它,统一设不分叉。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  activeTurnChildren.add(child)
  child.on("close", () => activeTurnChildren.delete(child))

  let pending = ""
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) void handleLine(line)
  })

  async function handleLine(line: string) {
    if (!line.startsWith("@@escalate ")) {
      if (line.trim()) handlers.onProgress?.(line.trimEnd())
      return
    }
    const request = JSON.parse(line.slice("@@escalate ".length)) as PermissionRequest
    const response = handlers.onEscalation ? await handlers.onEscalation(request).catch(() => "reject" as const) : "reject"
    child.stdin.write(`${JSON.stringify({ id: request.id, response })}\n`)
  }

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null))
    child.on("close", resolve)
  })

  const result = await readJsonFile<TurnResult>(outputFile).catch(() => undefined)
  if (!result) throw new Error(`子进程没有产出结果(退出码 ${code});输入留在 ${inputFile}`)
  return result as TurnResult
}
