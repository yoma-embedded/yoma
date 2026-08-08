/**
 * 工位端 —— 板子所在那台机器上的常驻执行者。
 *
 * 每次轮询一步:同步信箱 → 推断状态 → 该干活就干一轮 → 结果回填并推送。
 *
 * ## 一轮做什么
 *
 * 领指令与附件 → 调试台把附件落到 `.bench/incoming/`(确定性动作,不经模型)→ 组提示词
 * (角色说明 + 附件清单 + 研发端指令 + 上一轮判据证据)→ 子进程跑一轮 agent(探针清理
 * 靠进程边界,与单机模式同一条不变式)→ 判据亲跑 → result 回填信箱。
 *
 * **怎么把新固件弄上板由 agent 自己定** —— `flash` 烧、跑工程里的 OTA 脚本、别的路子,
 * 协议不预设机制。调试台只保证东西真的躺在那儿、路径写在提示词里。
 *
 * ## 这一侧不改代码
 *
 * 代码归研发端。`edit`/`write` 由 `role: "bench"` 直接拒(见 policy.ts),这边也
 * 不开分支、不提交、不推交付分支 —— 它是纯粹的被测环境。工作树因此必须**干净**:
 * 判据是在这棵树上跑的,树被动过判据就不再说明"已提交的那份代码行不行"。开轮前查一次
 * 挡住烧 token,轮结束再查一次当证据。
 *
 * ## 与单机 runJob 的两个刻意差别
 *
 * 1. **失败不立即回刷 known-good。** 单机模式一个 job 跑完就该把板子还原;信箱模式
 *    的轮与轮之间是**延续**关系(下一轮从这一轮的状态接着调),每轮失败都回刷等于
 *    每轮都白烧一次片。回刷挪到终局:verdict 非 passed 时收尾一次。
 * 2. **判据没过不在本地重试。** 下一步归研发端决定 —— 这正是信箱模式存在的理由。
 *
 * ## 本地状态
 *
 * `<workspace>/.bench/mailbox/<jobId>/state.json` 存 sessionID / spentTokens / finalized。
 * 它是**工位机私有**的(会话在工位机的盘上,token 计数是这一侧的事实),不进信箱;
 * 丢了也只是重开会话,协议状态不受影响。
 */

import { appendFile, copyFile, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { PermissionRequest } from "@yoma-desktop/kernel"

import type { FauxScript } from "../faux.ts"
import { fileExists, readJsonFile } from "../fsx.ts"
import * as git from "../git.ts"
import { acquireRoleLock, backoffSeconds } from "./daemon.ts"
import { gradeRepeated, type GradeResult, type RunCommand } from "../grader.ts"
import { resolveWorkspace, type Job } from "../job.ts"
import { ensureBenchDir, ensureMyPiIgnore, restoreKnownGood, runTurnInChildProcess, type TurnInput } from "../runner.ts"
import type { TurnResult } from "../turn.ts"
import { benchRolePrompt, runnerRoundPrompt } from "./prompts.ts"
import {
  roundArtifactsDir,
  scanMailbox,
  summarizeDenied,
  sumMotherTokens,
  writeJson,
  writeRoundResult,
  type MailboxVerdict,
  type RoundFiles,
  type RoundInstruction,
  type RoundResultFile,
} from "./store.ts"
import { commitPush, flushThenPullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"

export interface MailboxRunnerOptions {
  /** 信箱克隆目录。 */
  clone: string
  branch?: string
  sessionsRoot: string
  /**
   * **这台机器上**的工程目录。信箱里的任务书不带绝对路径(它在别人机器上没意义),
   * 工位机在哪儿检出这个工程是本机事实,由本机配置提供。
   */
  projectDir?: string
  enginesDir?: string
  /** 打包态的 turn 子进程入口(见 TurnInput.turnEntry)。bun 开发态可缺省。 */
  turnEntry?: string
  /** 技能/上下文/凭据全局目录;演练与测试传临时目录隔离,生产缺省 ~/.my-pi。 */
  configDir?: string
  /** 本机演练的假模型脚本,按轮取 `fauxTurns[round-1]`。生产不传。 */
  fauxTurns?: FauxScript[]
  onProgress?: (message: string) => void
  /** 有人守着工位时接管升级;不传 = 真无人值守,escalate 由策略转 deny。 */
  onEscalation?: (request: PermissionRequest) => Promise<"once" | "always" | "reject">
  /** 测试注入:替换子进程轮。 */
  runTurn?: (
    input: TurnInput,
    handlers: { onEscalation?: MailboxRunnerOptions["onEscalation"]; onProgress?: (message: string) => void },
  ) => Promise<TurnResult>
  /** 测试注入:替换判据执行。 */
  grade?: (job: Job, workspace: string) => Promise<{ passed: boolean; rounds: GradeResult[] }>
  runCommand?: RunCommand
  gitRun?: git.GitRunner
  now?: () => number
}

export type RunnerStepOutcome =
  | { kind: "idle"; detail: string }
  | { kind: "ran"; round: number; error?: string }
  | { kind: "finalized"; verdict: MailboxVerdict }
  | { kind: "blocked"; detail: string }

interface RunnerLocalState {
  sessionID?: string
  spentTokens: number
  finalized?: boolean
}

const RUNNER_AUTHOR = { name: "yoma-mailbox-runner", email: "bench@yoma.local" }

/**
 * 附件在工位机上的落点,相对工程根。job 里的 `bench.elf` 通常就指这儿。
 *
 * 用正斜杠写死:这个字符串会进提示词、进 result.json、被另一台机器读。Windows 上
 * `path.join` 会给出 `.bench\incoming`,于是同一个任务在两台机器上留下两种写法 ——
 * 而 Node 在 Windows 上照样认正斜杠,没有理由让它漂。
 */
export const INCOMING_DIR = ".bench/incoming"

function syncContext(options: MailboxRunnerOptions): MailboxSyncContext {
  return { clone: options.clone, branch: options.branch, author: RUNNER_AUTHOR, run: options.gitRun }
}

function localStateFile(workspace: string, jobId: string): string {
  return path.join(workspace, ".bench", "mailbox", jobId, "state.json")
}

async function readLocalState(workspace: string, jobId: string): Promise<RunnerLocalState> {
  const file = localStateFile(workspace, jobId)
  if (!(await fileExists(file))) return { spentTokens: 0 }
  try {
    const parsed = await readJsonFile<Partial<RunnerLocalState>>(file)
    // spentTokens 必须落成数字:残缺文件里的 undefined 一旦进了比较和加法,
    // 会一路变成 NaN 把预算守卫和账本同时打瞎(测试逮住过)。
    return { ...parsed, spentTokens: typeof parsed.spentTokens === "number" ? parsed.spentTokens : 0 }
  } catch {
    // 状态文件坏了不是致命伤:token 计数会从信箱里的持久副本回垫(见 runRound)。
    return { spentTokens: 0 }
  }
}

async function saveLocalState(workspace: string, jobId: string, state: RunnerLocalState): Promise<void> {
  const file = localStateFile(workspace, jobId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2) + "\n")
}

/**
 * 把本轮附件从信箱拷进工作区的 `.bench/incoming/`。
 *
 * **不清空目录**:某一轮没带附件不代表旧固件失效 —— 板子上跑的还是它,`bench.elf`
 * 也还要靠那份 ELF 找 RTT 控制块。同名覆盖即可,那才是"新版本替换旧版本"的语义。
 */
async function stageIncoming(clone: string, round: number, workspace: string): Promise<string[]> {
  const source = roundArtifactsDir(clone, round)
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile())
  if (!files.length) return []
  const target = path.join(workspace, INCOMING_DIR)
  await mkdir(target, { recursive: true })
  const staged: string[] = []
  for (const file of files) {
    await copyFile(path.join(source, file.name), path.join(target, file.name))
    staged.push(`${INCOMING_DIR}/${file.name}`)
  }
  return staged
}

/** 轮询一步。守护进程就是"pullReset → 这个函数 → 睡一觉"的循环。 */
export async function runnerStep(options: MailboxRunnerOptions): Promise<RunnerStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)
  const sync = syncContext(options)

  await flushThenPullReset(sync)
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }
  if (snapshot.state.kind === "kickoff") return { kind: "idle", detail: "等研发端下发第一轮指令" }

  const mailboxJob = snapshot.job
  const job = mailboxJob.job
  let workspace: string
  try {
    workspace = resolveWorkspace(job, options.projectDir)
  } catch (error) {
    return { kind: "blocked", detail: (error as Error).message }
  }
  const state = await readLocalState(workspace, job.id)

  if (snapshot.state.kind === "done") {
    if (state.finalized) return { kind: "finalized", verdict: snapshot.state.verdict }
    const finalized = await finalize(options, mailboxJob, workspace, snapshot.state.verdict, progress)
    if (!finalized.ok) {
      // 收尾的副作用(回刷)失败不能闩死 —— 它幂等,交给退避循环重试。闩死的代价是
      // "板子留在半烧状态、没人再回刷"(正是回刷要防的事)。
      return { kind: "blocked", detail: `终局收尾未完成:${finalized.detail}` }
    }
    state.finalized = true
    await saveLocalState(workspace, job.id, state)
    return { kind: "finalized", verdict: snapshot.state.verdict }
  }

  if (snapshot.state.kind === "awaiting-mother") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮结果已回填,等研发端处理` }
  }

  return runRound(options, mailboxJob, workspace, state, snapshot.state.instruction, snapshot.rounds, progress)
}

async function runRound(
  options: MailboxRunnerOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  state: RunnerLocalState,
  instruction: RoundInstruction,
  rounds: RoundFiles[],
  progress: (message: string) => void,
): Promise<RunnerStepOutcome> {
  const job = mailboxJob.job
  const now = options.now ?? Date.now
  const started = now()
  const sync = syncContext(options)
  const round = instruction.round
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }

  progress(`─── 信箱轮 ${round}/${mailboxJob.mailbox.maxRounds} ───`)

  const finishWithError = async (error: string): Promise<RunnerStepOutcome> => {
    const result: RoundResultFile = {
      round,
      sessionID: state.sessionID,
      denied: [],
      spentTokens: state.spentTokens,
      error,
      at: new Date(started).toISOString(),
      elapsedMs: now() - started,
    }
    await writeRoundResult(options.clone, result)
    const pushed = await commitPush(sync, `round ${round}: 工位端失败回填 —— ${error.slice(0, 80)}`)
    if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
    return { kind: "ran", round, error }
  }

  // 本地 state 是缓存不是真相:token 计数的持久副本随每轮 result 存进信箱。本地丢了
  // (清理 .bench、换工位机续跑)就从信箱回垫 —— 预算强制不能因为换了台机器就归零
  // 重来(实测:不回垫的话一次丢失可以让实际花费翻倍)。
  const lastResult = [...rounds].reverse().find((entry) => entry.result)?.result
  if (lastResult && lastResult.spentTokens > state.spentTokens) state.spentTokens = lastResult.spentTokens

  // 协议防线:研发端不该发出超上限的轮;真出现就如实回报,让它自己收到证据。
  if (round > mailboxJob.mailbox.maxRounds) {
    return finishWithError(`第 ${round} 轮超出 mailbox.maxRounds=${mailboxJob.mailbox.maxRounds},拒绝执行`)
  }
  // 预算按**两侧合计**算 —— 研发端的分析也是这份预算花出去的钱。只算自己的话,
  // 全任务实际花费会超出 maxTokens 一整个"研发端累计"(与研发端守卫口径一致)。
  const motherTokens = sumMotherTokens(rounds)
  const spentCombined = state.spentTokens + motherTokens
  if (spentCombined >= job.budget.maxTokens) {
    return finishWithError(
      `token 预算 ${job.budget.maxTokens} 已耗尽(工位 ${state.spentTokens} + 研发端 ${motherTokens})`,
    )
  }

  // 环境自检每轮都做:工位机的状态会在轮与轮之间变(有人拔了探针、有人动了工作树)。
  const issue = await workspaceIssue(job, workspace, options.enginesDir, gitContext)
  if (issue) return finishWithError(`工位自检未过:${issue}`)

  await ensureBenchDir(path.join(workspace, ".bench"))
  await ensureMyPiIgnore(workspace)
  const incoming = await stageIncoming(options.clone, round, workspace)
  if (incoming.length) progress(`本轮附件已就位:${incoming.join("、")}`)

  // 组提示词:角色说明(仅会话首轮)+ 附件清单(代码列的)+ 研发端指令 +
  // 上一轮判据证据(取自调试台自己的 grade,不信转述)。
  const previous = rounds.find((entry) => entry.round === round - 1)?.result
  const prompt = runnerRoundPrompt(instruction, {
    role: state.sessionID ? undefined : benchRolePrompt(job, INCOMING_DIR),
    incoming,
    previous: previous ? { grade: previous.grade, denied: previous.denied } : undefined,
  })

  const input: TurnInput = {
    job,
    workspace,
    sessionsRoot: options.sessionsRoot,
    stateDir: path.join(workspace, ".bench", "state"),
    enginesDir: options.enginesDir,
    sessionID: state.sessionID,
    prompt,
    maxTokens: job.budget.maxTokens,
    // 轮内看门狗也按两侧合计:研发端花掉的部分同样压缩本轮的可用余量。
    spentTokens: spentCombined,
    unattended: !options.onEscalation,
    turnEntry: options.turnEntry,
    configDir: options.configDir,
    faux: options.fauxTurns?.[round - 1],
    role: "bench",
  }

  const executeTurn = (turnInput: TurnInput) =>
    options.runTurn
      ? options.runTurn(turnInput, { onEscalation: options.onEscalation, onProgress: progress })
      : runTurnInChildProcess(turnInput, { onEscalation: options.onEscalation, onProgress: progress })

  let turn: TurnResult
  try {
    turn = await executeTurn(input)
  } catch (error) {
    if (!input.sessionID) return finishWithError(`agent 轮执行失败:${(error as Error).message}`)
    // 会话可能已不在(sessionsRoot 被清、桌面端删了会话)—— 这是可自愈的状态,
    // 与研发端同一套回退:丢掉延续重开会话再试一次,仍失败才算真失败。
    // 不回退的话,一个丢了的会话会把整个闭环打成无解释的 park(补审逮住过)。
    progress(`会话 ${input.sessionID} 打不开,重开会话再试一次`)
    state.sessionID = undefined
    await saveLocalState(workspace, job.id, state)
    try {
      // 会话重开 = 角色说明要重新带上,否则新会话不知道自己是工位端。
      turn = await executeTurn({
        ...input,
        sessionID: undefined,
        prompt: `${benchRolePrompt(job, INCOMING_DIR)}\n\n${input.prompt}`,
      })
    } catch (retryError) {
      return finishWithError(`agent 轮执行失败(重开会话后仍失败):${(retryError as Error).message}`)
    }
  }

  state.sessionID = turn.sessionID
  state.spentTokens += turn.usage.tokens.input + turn.usage.tokens.output
  await saveLocalState(workspace, job.id, state)

  // 完整决策日志与单机模式同款落盘 —— 信箱里只带被拒清单(研发端要的),
  // 每一次 allow 的完整审计留在工位机(事后核"某条命令怎么被放行的"就靠它)。
  if (turn.decisions.length) {
    const decisionsLog = path.join(workspace, ".bench", "mailbox", job.id, "decisions.jsonl")
    await appendFile(decisionsLog, turn.decisions.map((d) => JSON.stringify({ round, ...d })).join("\n") + "\n").catch(
      () => {},
    )
  }

  // 工作树在轮结束时也要干净:agent 改了源码的话,接下来的判据跑的就不是研发端
  // 提交的那份代码 —— 这是"考生自己填答题卡"的另一条路径,必须留下证据。
  const dirty = await git.dirtyTrackedFiles(gitContext)

  // 判据:轮被中断(token 耗尽/超时)就不跑 —— stopReason 本身就是研发端的证据。
  let grade: GradeResult | undefined
  if (!turn.stopReason) {
    progress("判据执行中(由调试台独立跑,不经模型)")
    const graded = options.grade
      ? await options.grade(job, workspace)
      : await gradeRepeated({ job, workspace, enginesDir: options.enginesDir, onProgress: progress })
    grade = graded.rounds[graded.rounds.length - 1]
  }

  const result: RoundResultFile = {
    round,
    sessionID: turn.sessionID,
    turn: {
      text: turn.text,
      toolCounts: countTools(turn),
      toolErrors: turn.toolCalls.filter((call) => call.error).map((call) => `${call.tool}: ${call.error}`),
      usage: turn.usage,
      stopReason: turn.stopReason,
      errors: turn.errors,
      elapsedMs: turn.elapsedMs,
    },
    grade,
    denied: summarizeDenied(turn.decisions),
    incoming: incoming.length ? incoming : undefined,
    workspace: { head: await git.headCommit(gitContext), dirty },
    spentTokens: state.spentTokens,
    at: new Date(started).toISOString(),
    elapsedMs: now() - started,
  }
  if (dirty.length) progress(`⚠ 工作树被改动了(${dirty.length} 个已跟踪文件)—— 已作为证据回填`)

  await writeRoundResult(options.clone, result)
  const pushed = await commitPush(
    sync,
    `round ${round}: ${grade ? (grade.passed ? "判据全过" : "判据未过") : (turn.stopReason ?? "轮被中断")}`,
  )
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
  return { kind: "ran", round }
}

/**
 * 终局收尾 —— 硬件动作只发生在工位机,所以回刷 known-good 在这里(交付 push 归研发端,
 * 代码在它那儿)。动作幂等;失败如实返回,由守护循环退避重试,绝不"失败也算收完"。
 * 收尾结果作为 finalize.json 推回信箱 —— 审计里"板子回没回到已知状态"不能只活在
 * 一闪而过的 stderr 上。
 */
async function finalize(
  options: MailboxRunnerOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  verdict: MailboxVerdict,
  progress: (message: string) => void,
): Promise<{ ok: boolean; detail?: string }> {
  const job = mailboxJob.job
  const record: { at: string; outcome: MailboxVerdict["outcome"]; restored?: boolean } = {
    at: new Date().toISOString(),
    outcome: verdict.outcome,
  }

  if (verdict.outcome !== "passed" && job.bench.knownGoodElf && job.bench.chip) {
    progress(`终局 ${verdict.outcome},回刷 known-good 固件:${job.bench.knownGoodElf}`)
    const restored = await restoreKnownGood(job, workspace, {
      enginesDir: options.enginesDir,
      runCommand: options.runCommand,
    })
    progress(restored ? "已回刷" : "⚠ 回刷失败,板子状态未知")
    if (!restored) return { ok: false, detail: "回刷 known-good 失败,板子状态未知" }
    record.restored = true
  }

  await writeJson(path.join(options.clone, "finalize.json"), record)
  const pushed = await commitPush(syncContext(options), `finalize: ${verdict.outcome} 收尾完成`)
  if (!pushed.pushed && pushed.detail) return { ok: false, detail: `收尾审计推不上去:${pushed.detail}` }
  return { ok: true }
}

/** 与 cli 的 checkEnvironment 同一组事实,但只查文件/git 状态不加载内核 —— 热路径上的守门。 */
async function workspaceIssue(
  job: Job,
  workspace: string,
  enginesDir: string | undefined,
  gitContext: git.GitContext,
): Promise<string | undefined> {
  if (!(await fileExists(path.join(workspace, ".git/HEAD")))) {
    const isWorktree = await fileExists(path.join(workspace, ".git"))
    if (!isWorktree) return `${workspace} 不是 git 仓库`
  }
  // 工作树必须等于已提交的真相:判据在这棵树上跑,树被动过判据就不再说明代码行不行。
  const dirty = await git.dirtyTrackedFiles(gitContext)
  if (dirty.length) {
    return `工作树不干净(${dirty.slice(0, 5).join("、")}${dirty.length > 5 ? " 等" : ""})—— 判据要在已提交的代码上跑才有意义。先 \`git checkout .\` 或提交掉`
  }
  if (job.bench.knownGoodElf) {
    const elf = path.resolve(workspace, job.bench.knownGoodElf)
    if (!(await fileExists(elf))) return `known-good 固件不存在:${elf}(失败时无法回刷)`
  }
  const needsProbe = job.success.checks.some(
    (check) => (check.type === "log_wait" || check.type === "log_absent") && (check.source?.kind ?? "rtt") === "rtt",
  )
  if (needsProbe && enginesDir) {
    const probeRs = path.join(enginesDir, "bin", process.platform === "win32" ? "probe-rs.exe" : "probe-rs")
    if (!(await fileExists(probeRs))) {
      return `判据要用 RTT 采日志,但 ${probeRs} 不在 —— 先跑 \`bun engines/build.ts\``
    }
  }
  return undefined
}

function countTools(turn: TurnResult): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const call of turn.toolCalls) counts[call.tool] = (counts[call.tool] ?? 0) + 1
  return counts
}

/** 常驻循环。`once` 给测试和 cron 场景(锁保证 cron 重叠时后来者干净退出)。 */
export async function runMailboxRunner(
  options: MailboxRunnerOptions & {
    pollSeconds: number
    once?: boolean
    /** 每步之后回调一次(含终局那步)。桌面端守护入口靠它发结构化事件。 */
    onStep?: (outcome: RunnerStepOutcome) => void
  },
): Promise<RunnerStepOutcome> {
  const lock = await acquireRoleLock(options.clone, "runner")
  if (!lock.ok) return { kind: "blocked", detail: lock.detail }
  let blockedStreak = 0
  try {
    for (;;) {
      let outcome: RunnerStepOutcome
      try {
        outcome = await runnerStep(options)
      } catch (error) {
        outcome = { kind: "blocked", detail: (error as Error).message }
      }
      options.onStep?.(outcome)
      if (outcome.kind === "idle") options.onProgress?.(`(空闲)${outcome.detail}`)
      if (outcome.kind === "finalized" || options.once) return outcome
      blockedStreak = outcome.kind === "blocked" ? blockedStreak + 1 : 0
      const delay = backoffSeconds(options.pollSeconds, blockedStreak)
      if (outcome.kind === "blocked") options.onProgress?.(`⚠ ${outcome.detail}(${delay}s 后重试)`)
      await new Promise((resolve) => setTimeout(resolve, delay * 1000))
    }
  } finally {
    await lock.release()
  }
}
