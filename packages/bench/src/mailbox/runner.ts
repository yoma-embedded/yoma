/**
 * 工位端 —— 板子所在那台机器上的常驻执行者。
 *
 * 每次轮询一步:同步信箱 → 推断状态 → 该干活就干一轮 → 结果回填并推送。
 *
 * ## 这一侧没有项目代码
 *
 * 工作目录是一个**一次性目录**,内容全部来自信箱:研发端每轮附过来的固件、脚本、
 * 数据落在这里,别的什么都没有。工位端读不到源码,它需要的背景由研发端写进指令
 * (见 prompts.ts 的两条话术纪律)。
 *
 * 于是这一侧不需要 git、不需要构建工具链、不需要工作树干净 —— 它就是一台连着板子的
 * 机器加一个信箱克隆。**工作目录必须在克隆之外**:`pullReset` 的 `clean -fd` 会把
 * 克隆里的一切非跟踪文件清掉,附件放在里面等于每轮被自己删一次。
 *
 * ## 一轮做什么
 *
 * 领指令与附件 → 调试台把附件落进工作目录(确定性动作,不经模型)→ 组提示词
 * (角色说明 + 附件清单 + 研发端指令)→ 子进程跑一轮 agent(探针清理靠进程边界)→
 * result 回填信箱。
 *
 * **怎么把新固件弄上板由 agent 自己定** —— 附件 + 一句人话就是全部机制。
 *
 * ## 本地状态
 *
 * `<workRoot>/<jobId>/session.json`:会话指针 + token 账本。
 *
 * 账本的持久副本是信箱里每轮 result 的 `spentTokens`(累计值),换台工位机续跑不会归零;
 * 但本地这份**先于推送**写下,补的是另一个洞:push 失败而 fetch 正常时(远端只读、
 * 凭据过期),下一次同步的 `pullReset` 会 `reset --hard` 掉本地那条 result 提交,
 * 于是这一轮的花费从账目蒸发、板子却真的动过了。预算守卫取两本账的最大值。
 */

import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { FauxScript } from "../faux.ts"
import { fileExists, readJsonFile } from "../fsx.ts"
import type * as git from "../git.ts"
import { acquireRoleLock, backoffSeconds } from "./daemon.ts"
import { runTurnInChildProcess, type TurnInput } from "../runner.ts"
import type { TurnResult } from "../turn.ts"
import { benchRolePrompt, runnerRoundPrompt } from "./prompts.ts"
import {
  roundArtifactsDir,
  scanMailbox,
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
   * 工位端一次性工作目录的根。缺省是克隆的**兄弟**目录 —— 绝不能落在克隆里面,
   * `pullReset` 的 `clean -fd` 会把附件连同本地状态一起清掉。
   */
  workRoot?: string
  enginesDir?: string
  /** 打包态的 turn 子进程入口(见 TurnInput.turnEntry)。bun 开发态可缺省。 */
  turnEntry?: string
  /** 技能/上下文/凭据全局目录;演练与测试传临时目录隔离,生产缺省 ~/.my-pi。 */
  configDir?: string
  /** 本机演练的假模型脚本,按轮取 `fauxTurns[round-1]`。生产不传。 */
  fauxTurns?: FauxScript[]
  onProgress?: (message: string) => void
  /** 测试注入:替换子进程轮。 */
  runTurn?: (input: TurnInput, handlers: { onProgress?: (message: string) => void }) => Promise<TurnResult>
  gitRun?: git.GitRunner
  now?: () => number
}

export type RunnerStepOutcome =
  | { kind: "idle"; detail: string }
  | { kind: "ran"; round: number; error?: string }
  | { kind: "finalized"; verdict: MailboxVerdict }
  | { kind: "blocked"; detail: string }

const RUNNER_AUTHOR = { name: "yoma-mailbox-runner", email: "bench@yoma.local" }

function syncContext(options: MailboxRunnerOptions): MailboxSyncContext {
  return { clone: options.clone, branch: options.branch, author: RUNNER_AUTHOR, run: options.gitRun }
}

/** 工位端这个任务的私有目录:工作区 + 会话指针。在信箱克隆之外。 */
function jobRoot(options: MailboxRunnerOptions, jobId: string): string {
  return path.join(options.workRoot ?? path.join(path.dirname(options.clone), "work"), jobId)
}


interface RunnerLocalState {
  sessionID?: string
  spentTokens?: number
}

async function readLocalState(root: string): Promise<RunnerLocalState> {
  const file = path.join(root, "session.json")
  if (!(await fileExists(file))) return {}
  return (await readJsonFile<RunnerLocalState>(file).catch(() => undefined)) ?? {}
}

async function saveLocalState(root: string, state: RunnerLocalState): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "session.json"), JSON.stringify(state, null, 2) + "\n")
}

/**
 * 把本轮附件从信箱拷进工作目录。
 *
 * **不清空目录**:某一轮没带附件不代表旧固件失效 —— 板子上跑的还是它。同名覆盖即可,
 * 那才是"新版本替换旧版本"的语义。
 */
async function stageIncoming(clone: string, round: number, workspace: string): Promise<string[]> {
  const source = roundArtifactsDir(clone, round)
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile())
  if (!files.length) return []
  await mkdir(workspace, { recursive: true })
  const staged: string[] = []
  for (const file of files) {
    await copyFile(path.join(source, file.name), path.join(workspace, file.name))
    staged.push(file.name)
  }
  return staged
}

/** 工位端跨轮累计的 token —— 真相在信箱里(每轮 result 存的是累计值)。 */
function runnerTokensSoFar(rounds: RoundFiles[]): number {
  for (const entry of [...rounds].reverse()) {
    if (entry.result) return entry.result.spentTokens
  }
  return 0
}

/** mother 跨轮累计花费。 */
function motherTokensSoFar(rounds: RoundFiles[]): number {
  let total = 0
  for (const { decision } of rounds) {
    if (!decision?.usage) continue
    total += decision.usage.tokens.input + decision.usage.tokens.output
  }
  return total
}

/** 轮询一步。守护进程就是"这个函数 → 睡一觉"的循环。 */
export async function runnerStep(options: MailboxRunnerOptions): Promise<RunnerStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)

  // 同步失败要走 blocked 而不是裸抛:守护对 blocked 有指数退避,而未捕获的异常会一路
  // 冒到守护循环外面。"克隆停在别的分支""远端只读""网断了"都是这一类。
  try {
    await flushThenPullReset(syncContext(options))
  } catch (error) {
    return { kind: "blocked", detail: (error as Error).message }
  }
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }
  if (snapshot.state.kind === "kickoff") return { kind: "idle", detail: "等研发端下发第一轮指令" }
  if (snapshot.state.kind === "done") return { kind: "finalized", verdict: snapshot.state.verdict }
  if (snapshot.state.kind === "awaiting-mother") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮结果已回填,等研发端处理` }
  }

  return runRound(options, snapshot.job, snapshot.state.instruction, snapshot.rounds, progress)
}

async function runRound(
  options: MailboxRunnerOptions,
  mailboxJob: MailboxJob,
  instruction: RoundInstruction,
  rounds: RoundFiles[],
  progress: (message: string) => void,
): Promise<RunnerStepOutcome> {
  const job = mailboxJob.job
  const now = options.now ?? Date.now
  const started = now()
  const sync = syncContext(options)
  const round = instruction.round
  const root = jobRoot(options, job.id)
  const workspace = path.join(root, "work")
  const local = await readLocalState(root)
  let sessionID = local.sessionID
  // 两本账取大 —— 理由见文件头"本地状态"。
  const spentBefore = Math.max(runnerTokensSoFar(rounds), local.spentTokens ?? 0)

  progress(`─── 信箱轮 ${round}/${job.budget.maxRounds} ───`)

  const finishWithError = async (error: string): Promise<RunnerStepOutcome> => {
    await writeRoundResult(options.clone, {
      round,
      sessionID,
      spentTokens: spentBefore,
      error,
      at: new Date(started).toISOString(),
      elapsedMs: now() - started,
    })
    const pushed = await commitPush(sync, `round ${round}: 工位端失败回填 —— ${error.slice(0, 80)}`)
    if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
    return { kind: "ran", round, error }
  }

  // 预算按**两侧合计**算 —— 研发端的分析也是这份预算花出去的钱。
  const spentCombined = spentBefore + motherTokensSoFar(rounds)
  if (spentCombined >= job.budget.maxTokens) {
    return finishWithError(`token 预算 ${job.budget.maxTokens} 已耗尽(合计 ${spentCombined})`)
  }

  await mkdir(workspace, { recursive: true })
  const incoming = await stageIncoming(options.clone, round, workspace)
  if (incoming.length) progress(`本轮附件已就位:${incoming.join("、")}`)

  const input: TurnInput = {
    job,
    workspace,
    sessionsRoot: options.sessionsRoot,
    stateDir: path.join(root, "state"),
    enginesDir: options.enginesDir,
    sessionID,
    prompt: runnerRoundPrompt(instruction, {
      role: sessionID ? undefined : benchRolePrompt(job, workspace),
      incoming,
    }),
    maxTokens: job.budget.maxTokens,
    // 轮内看门狗也按两侧合计:研发端花掉的部分同样压缩本轮的可用余量。
    spentTokens: spentCombined,
    turnEntry: options.turnEntry,
    configDir: options.configDir,
    faux: options.fauxTurns?.[round - 1],
  }

  let turn: TurnResult
  try {
    turn = await (options.runTurn ?? runTurnInChildProcess)(input, { onProgress: progress })
  } catch (error) {
    // 会话可能已不在(sessionsRoot 被清、桌面端删了会话)。丢掉延续指针,下一轮重开。
    await saveLocalState(root, { spentTokens: spentBefore })
    return finishWithError(`agent 轮执行失败:${(error as Error).message}`)
  }

  sessionID = turn.sessionID
  const spentAfter = spentBefore + turn.usage.tokens.input + turn.usage.tokens.output
  // 先记账再推送:推不上去时这一轮会被 pullReset 丢掉重跑,花费不能跟着蒸发。
  await saveLocalState(root, { sessionID, spentTokens: spentAfter })

  const result: RoundResultFile = {
    round,
    sessionID,
    turn: {
      text: turn.text,
      toolCounts: countTools(turn),
      toolErrors: turn.toolCalls.filter((call) => call.error).map((call) => `${call.tool}: ${call.error}`),
      usage: turn.usage,
      stopReason: turn.stopReason,
      errors: turn.errors,
      elapsedMs: turn.elapsedMs,
    },
    incoming: incoming.length ? incoming : undefined,
    spentTokens: spentAfter,
    at: new Date(started).toISOString(),
    elapsedMs: now() - started,
  }

  await writeRoundResult(options.clone, result)
  const pushed = await commitPush(sync, `round ${round}: ${turn.stopReason ?? "工位端已回填"}`)
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
  return { kind: "ran", round }
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

/** 给宿主(桌面端/CLI)用:这个任务在本机的工作目录。会话回放的路由要它。 */
export function runnerWorkspaceFor(clone: string, workRoot: string | undefined, jobId: string): string {
  return path.join(workRoot ?? path.join(path.dirname(clone), "work"), jobId, "work")
}
