/**
 * 信箱 runner —— 工位机上的常驻执行者。
 *
 * 每次轮询一步:同步信箱 → 推断状态 → 该干活就干一轮 → 结果回填并推送。
 *
 * ## 一轮做什么(与单机 bench 的一轮同构)
 *
 * 领指令 → 组提示词(母 agent 指令 + 上一轮判据证据,证据取自 runner 自己跑出的
 * grade,不信任 mother 转述)→ 子进程跑一轮 agent(探针清理靠进程边界,与单机模式
 * 同一条不变式)→ 判据亲跑 → 目标仓提交(审计点)→ result/patch 回填信箱。
 *
 * ## 与单机 runJob 的两个刻意差别
 *
 * 1. **失败不立即回刷 known-good。** 单机模式一个 job 跑完就该把板子还原;信箱模式
 *    的轮与轮之间是**延续**关系(下一轮从这一轮的状态接着调),每轮失败都回刷等于
 *    每轮都白烧一次片。回刷挪到终局:verdict 非 passed 时收尾一次。
 * 2. **判据没过不在本地重试。** 下一步归 mother 决定 —— 这正是信箱模式存在的理由。
 *
 * ## 本地状态
 *
 * `<workspace>/.bench/mailbox/<jobId>/state.json` 存 sessionID / baseCommit /
 * spentTokens / finalized。它是**工位机私有**的(会话在工位机的盘上,token 计数是
 * runner 侧的事实),不进信箱;丢了也只是重开会话,协议状态不受影响。
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { PermissionRequest } from "@yoma-desktop/kernel"

import type { FauxScript } from "../faux.ts"
import { fileExists, readJsonFile } from "../fsx.ts"
import * as git from "../git.ts"
import { acquireRoleLock, backoffSeconds } from "./daemon.ts"
import { gradeRepeated, type GradeResult, type RunCommand } from "../grader.ts"
import type { Job } from "../job.ts"
import { ensureBenchDir, ensureMyPiIgnore, restoreKnownGood, runTurnInChildProcess, type TurnInput } from "../runner.ts"
import type { TurnResult } from "../turn.ts"
import { runnerRoundPrompt } from "./prompts.ts"
import {
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
  baseCommit?: string
  spentTokens: number
  finalized?: boolean
}

const RUNNER_AUTHOR = { name: "yoma-mailbox-runner", email: "bench@yoma.local" }

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

/** 轮询一步。守护进程就是"pullReset → 这个函数 → 睡一觉"的循环。 */
export async function runnerStep(options: MailboxRunnerOptions): Promise<RunnerStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)
  const sync = syncContext(options)

  await flushThenPullReset(sync)
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }

  const mailboxJob = snapshot.job
  const job = mailboxJob.job
  const workspace = path.resolve(job.repo.directory)
  const state = await readLocalState(workspace, job.id)

  if (snapshot.state.kind === "done") {
    if (state.finalized) return { kind: "finalized", verdict: snapshot.state.verdict }
    const finalized = await finalize(options, mailboxJob, workspace, snapshot.state.verdict, progress)
    if (!finalized.ok) {
      // 收尾的副作用(回刷/交付推送)失败不能闩死 —— 它们都幂等,交给退避循环重试。
      // 闩死的代价是"板子留在半烧状态、没人再回刷"(正是回刷要防的事)。
      return { kind: "blocked", detail: `终局收尾未完成:${finalized.detail}` }
    }
    state.finalized = true
    await saveLocalState(workspace, job.id, state)
    return { kind: "finalized", verdict: snapshot.state.verdict }
  }

  if (snapshot.state.kind === "awaiting-mother") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮结果已回填,等母 agent 裁决` }
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
    const pushed = await commitPush(sync, `round ${round}: runner 失败回填 —— ${error.slice(0, 80)}`)
    if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
    return { kind: "ran", round, error }
  }

  // 本地 state 是缓存不是真相:token 计数与基线的持久副本随每轮 result 存进信箱。
  // 本地丢了(清理 .bench、换工位机续跑)就从信箱回垫 —— 预算强制不能因为换了台机器
  // 就归零重来(实测:不回垫的话一次丢失可以让实际花费翻倍)。
  const hadLocalBase = Boolean(state.baseCommit)
  const lastResult = [...rounds].reverse().find((entry) => entry.result)?.result
  if (lastResult) {
    if (lastResult.spentTokens > state.spentTokens) state.spentTokens = lastResult.spentTokens
    if (!state.baseCommit && lastResult.git?.baseCommit) state.baseCommit = lastResult.git.baseCommit
  }

  // 协议防线:mother 不该发出超上限的轮;真出现就如实回报,让它自己收到证据。
  if (round > mailboxJob.mailbox.maxRounds) {
    return finishWithError(`第 ${round} 轮超出 mailbox.maxRounds=${mailboxJob.mailbox.maxRounds},拒绝执行`)
  }
  // 预算按**两侧合计**算 —— mother 的分析也是这份预算花出去的钱。只算自己的话,
  // 全任务实际花费会超出 maxTokens 一整个"mother 累计"(与 mother 侧守卫口径一致)。
  const motherTokens = sumMotherTokens(rounds)
  const spentCombined = state.spentTokens + motherTokens
  if (spentCombined >= job.budget.maxTokens) {
    return finishWithError(
      `token 预算 ${job.budget.maxTokens} 已耗尽(工位 ${state.spentTokens} + 母 agent ${motherTokens})`,
    )
  }

  // 准备工作分支:第一轮建,后续轮确认还在(有人手动切走时要能自己回来)。
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }
  const branchName = job.repo.branch ?? `agent/${job.id}`
  if (!hadLocalBase) {
    // 本地没有历史(首轮,或换机/清理后的续跑):先过工位自检 —— 环境残缺时一轮
    // 模型 token 都别烧,直接把问题回填给 mother。
    const issue = await workspaceIssue(job, workspace, options.enginesDir)
    if (issue) return finishWithError(`工位自检未过:${issue}`)
    // 换机续跑的防线:信箱记着上一轮的头提交,本地必须真的有它。没有就说明这台机器
    // 的目标仓没带着 agent 分支的历史 —— 静默"复用分支"实际是从当前 HEAD 重建,
    // 前几轮已提交的修复会凭空蒸发,mother 会对着自相矛盾的证据继续烧预算(补审逮住过)。
    if (lastResult?.git?.headCommit && !(await git.hasCommit(gitContext, lastResult.git.headCommit))) {
      return finishWithError(
        `目标仓里没有上一轮的提交 ${lastResult.git.headCommit.slice(0, 8)} —— 换机续跑要先把 ${branchName} 分支同步到这台工位机`,
      )
    }
  }
  if (!state.baseCommit) {
    const prepared = await git.prepareBranch(gitContext, { branch: branchName, ref: job.repo.ref })
    if (!prepared.ok) return finishWithError(`准备工作分支失败:${prepared.message}`)
    state.baseCommit = prepared.baseCommit
    await saveLocalState(workspace, job.id, state)
    progress(prepared.message)
  } else if ((await git.currentBranch(gitContext)) !== branchName) {
    const prepared = await git.prepareBranch(gitContext, { branch: branchName })
    if (!prepared.ok) return finishWithError(`回到工作分支失败:${prepared.message}`)
  }

  // 组提示词:mother 指令 + 上一轮判据证据(取自 runner 自己的 grade,不信转述)。
  const previous = rounds.find((entry) => entry.round === round - 1)?.result
  const prompt = runnerRoundPrompt(
    instruction,
    previous ? { grade: previous.grade, denied: previous.denied } : undefined,
  )

  await ensureBenchDir(path.join(workspace, ".bench"))
  await ensureMyPiIgnore(workspace)
  const input: TurnInput = {
    job,
    workspace,
    sessionsRoot: options.sessionsRoot,
    stateDir: path.join(workspace, ".bench", "state"),
    enginesDir: options.enginesDir,
    sessionID: state.sessionID,
    prompt,
    maxTokens: job.budget.maxTokens,
    // 轮内看门狗也按两侧合计:mother 花掉的部分同样压缩本轮的可用余量。
    spentTokens: spentCombined,
    unattended: !options.onEscalation,
    turnEntry: options.turnEntry,
    configDir: options.configDir,
    faux: options.fauxTurns?.[round - 1],
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
    // 与 mother 侧同一套回退:丢掉延续重开会话再试一次,仍失败才算真失败。
    // 不回退的话,一个丢了的会话会把整个闭环打成无解释的 park(补审逮住过)。
    progress(`会话 ${input.sessionID} 打不开,重开会话再试一次`)
    state.sessionID = undefined
    await saveLocalState(workspace, job.id, state)
    try {
      turn = await executeTurn({ ...input, sessionID: undefined })
    } catch (retryError) {
      return finishWithError(`agent 轮执行失败(重开会话后仍失败):${(retryError as Error).message}`)
    }
  }

  state.sessionID = turn.sessionID
  state.spentTokens += turn.usage.tokens.input + turn.usage.tokens.output
  await saveLocalState(workspace, job.id, state)

  // 完整决策日志与单机模式同款落盘 —— 信箱里只带被拒清单(mother 要的),
  // 每一次 allow 的完整审计留在工位机(事后核"某条命令怎么被放行的"就靠它)。
  if (turn.decisions.length) {
    const decisionsLog = path.join(workspace, ".bench", "mailbox", job.id, "decisions.jsonl")
    await appendFile(decisionsLog, turn.decisions.map((d) => JSON.stringify({ round, ...d })).join("\n") + "\n").catch(
      () => {},
    )
  }

  // 判据:轮被中断(token 耗尽/超时)就不跑 —— stopReason 本身就是 mother 的证据。
  let grade: GradeResult | undefined
  if (!turn.stopReason) {
    progress("判据执行中(由调试台独立跑,不经模型)")
    const graded = options.grade
      ? await options.grade(job, workspace)
      : await gradeRepeated({ job, workspace, enginesDir: options.enginesDir, onProgress: progress })
    grade = graded.rounds[graded.rounds.length - 1]
  }

  // 目标仓提交:每轮一个审计点,过没过都提交(演进过程正是 review 的价值所在)。
  const committed = await git.commitAll(gitContext, {
    message: `${grade?.passed ? "fix" : "wip"}: ${job.title} · 信箱轮 ${round}\n\n任务 ${job.id}(信箱闭环,指令来自 ${instruction.issuedBy})`,
    author: { name: "yoma-bench", email: "bench@yoma.local" },
  })
  if (committed.committed) progress(`目标仓已提交 ${committed.commit?.slice(0, 8)}`)
  // commit 本身坏了(gpgsign 无 pinentry、钩子缺依赖)时,diff/patch 全按已提交算,
  // 证据链会静默退化成"没有代码改动" —— mother 会依据错误证据裁决。如实标成轮级
  // 失败(turn/grade 仍附上,给人看),让它挂起等人修工位。
  const commitBroken =
    !committed.committed && committed.message !== "没有改动可提交"
      ? `目标仓提交失败,改动证据不可信:${committed.message}`
      : undefined

  const base = state.baseCommit!
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
    git: {
      baseCommit: base,
      headCommit: await git.headCommit(gitContext),
      diffStat: await git.diffStat(gitContext, base),
      changedFiles: await git.diffNameStatus(gitContext, base),
      commits: await git.logSince(gitContext, base),
    },
    spentTokens: state.spentTokens,
    error: commitBroken,
    at: new Date(started).toISOString(),
    elapsedMs: now() - started,
  }

  await writeRoundResult(options.clone, result, { patch: await git.diffPatch(gitContext, base) })
  const pushed = await commitPush(
    sync,
    `round ${round}: ${grade ? (grade.passed ? "判据全过" : "判据未过") : (turn.stopReason ?? "轮被中断")}`,
  )
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
  return { kind: "ran", round }
}

/**
 * 终局收尾 —— 硬件动作只发生在工位机,所以 push 交付分支和回刷 known-good 都在这里,
 * 而不是在写 verdict 的 mother 侧。全部动作幂等;任何一步失败都如实返回,由守护循环
 * 退避重试,绝不"失败也算收完"。收尾结果作为 finalize.json 推回信箱 —— 审计里
 * "板子回没回到已知状态、交付分支推没推出去"不能只活在一闪而过的 stderr 上。
 */
async function finalize(
  options: MailboxRunnerOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  verdict: MailboxVerdict,
  progress: (message: string) => void,
): Promise<{ ok: boolean; detail?: string }> {
  const job = mailboxJob.job
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }
  const branchName = job.repo.branch ?? `agent/${job.id}`
  const record: { at: string; outcome: MailboxVerdict["outcome"]; delivered?: boolean; restored?: boolean } = {
    at: new Date().toISOString(),
    outcome: verdict.outcome,
  }

  if (verdict.outcome === "passed" && job.deliver?.push) {
    const pushed = await git.pushBranch(gitContext, { branch: branchName, remote: job.deliver.remote ?? "origin" })
    progress(pushed.ok ? pushed.message : `⚠ ${pushed.message}`)
    if (!pushed.ok) return { ok: false, detail: `交付分支推送失败:${pushed.message}` }
    record.delivered = true
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

/** 与 cli 的 checkEnvironment 同一组事实,但只查文件不加载内核 —— 这是热路径上的守门。 */
async function workspaceIssue(job: Job, workspace: string, enginesDir?: string): Promise<string | undefined> {
  if (!(await fileExists(path.join(workspace, ".git/HEAD")))) {
    const isWorktree = await fileExists(path.join(workspace, ".git"))
    if (!isWorktree) return `${workspace} 不是 git 仓库(交付要开分支提交)`
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
