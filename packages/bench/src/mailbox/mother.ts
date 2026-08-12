/**
 * 研发端 —— 闭环里**改代码的那一半**。
 *
 * 它在研发机上,手里是工程的完整检出和构建环境;板子不在这儿。每一轮它读工位端回填的
 * 证据,动手改代码、构建,把产物当附件塞进下一轮,再用大白话写指令。硬件动作全部
 * 委托给工位端(板子根本不在这台机器上)。
 *
 * ## 谁裁决
 *
 * **全归模型**:它读工位端的自述,决定 continue / done / fail —— 包括什么时候停。
 * 没有轮数/token/墙钟上限。代码只在一种情况下越过它:决定 JSON 连着两次读不出来,
 * 那时终局 `fail` 并记 `by: "policy"` —— 那不是裁决,是"没法把它的话变成动作"。
 * 要提前收工就在桌面端按停止。
 *
 * ## 附件由代码拷,不由 agent 写
 *
 * agent 只在决定里声明 `artifacts: ["build/xxx.elf"]`,拷贝与边界检查在这里做。
 * 工位端**没有项目检出**,附件是它拿到任何东西的唯一通道 —— 声明了但文件不存在
 * 是一个能被逮住的错误,不是一个空目录。
 *
 * ## 为什么研发端的轮不进子进程
 *
 * 工位端"一轮一个子进程"的理由是探针/gdb/日志采集的模块级全局 —— 研发端碰不到这些
 * 工具,进程边界在这里没有要清理的东西;runTurn 每次建 host、用完 dispose,进程内
 * 已经是干净的生命周期。
 *
 * ## 解析失败为什么只重试一次
 *
 * 重试走同一会话,错误信息就是新提示词(见 analyse);再读不出来就按上面那条终局。
 * 守护进程的轮询循环里没有"这次不算"—— 每次重试都是真实的模型花费,烧钱等不来正确性。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { fileExists, readJsonFile } from "../fsx.ts"
import * as git from "../git.ts"
import { resolveWorkspace, type Job, type JobModel } from "../job.ts"
import { ensureYomaDir } from "../runner.ts"
import { addUsage, runTurn, zeroUsage, type TurnOptions, type TurnResult, type TurnUsage } from "../turn.ts"
import { runRoleDaemon } from "./daemon.ts"
import { renderMailboxReport } from "./report.ts"
import {
  motherFollowUpPrompt,
  motherKickoffPrompt,
  motherPrompt,
  motherRetryPrompt,
  type MotherPromptInput,
} from "./prompts.ts"
import {
  attachArtifacts,
  readRound,
  scanMailbox,
  sumMotherTokens,
  writeDecision,
  writeJson,
  writeInstruction,
  writeVerdict,
  type DecisionKind,
  type MailboxState,
  type MailboxVerdict,
  type RoundArtifact,
  type RoundDecision,
  type RoundFiles,
  type RoundGit,
} from "./store.ts"
import { commitPush, flushThenPullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"

export interface MailboxMotherOptions {
  /** 信箱克隆目录。 */
  clone: string
  branch?: string
  sessionsRoot: string
  /**
   * **这台机器上**的工程目录。信箱里的任务书不带绝对路径(它在别人机器上没意义),
   * 研发端在哪儿检出这个工程是本机事实,由本机配置提供。
   */
  projectDir?: string
  enginesDir?: string
  /** 技能/上下文/凭据全局目录;演练与测试传临时目录隔离,生产缺省 ~/.my-pi。 */
  configDir?: string
  /** 假模型注入(本机演练):跨分析轮共享同一条响应队列。生产不传。 */
  resolveModels?: TurnOptions["resolveModels"]
  onProgress?: (message: string) => void
  /** 测试注入:替换真实的内核轮。 */
  runTurn?: (options: TurnOptions) => Promise<TurnResult>
  gitRun?: MailboxSyncContext["run"]
  now?: () => number
}

export type MotherStepOutcome =
  | { kind: "idle"; detail: string }
  | { kind: "decided"; round: number; decision: DecisionKind }
  | { kind: "done"; verdict: MailboxVerdict }
  | { kind: "blocked"; detail: string }

export interface MotherDecisionPayload {
  decision: DecisionKind
  analysis?: string
  instruction?: string
  reason?: string
  /** 要穿过信箱交给工位端的文件,相对工程根。 */
  artifacts?: string[]
}

const MOTHER_AUTHOR = { name: "yoma-mailbox-mother", email: "bench@yoma.local" }

/** 四处开轮/收尾都要它,而且字段与值完全一致 —— 换错 author 不报错,这正是它危险的地方。 */
function syncContext(options: MailboxMotherOptions): MailboxSyncContext {
  return { clone: options.clone, branch: options.branch, author: MOTHER_AUTHOR, run: options.gitRun }
}
const DEV_COMMIT_AUTHOR = { name: "yoma-bench", email: "bench@yoma.local" }

interface MotherLocalState {
  sessionID?: string
  /** 项目仓上的任务基线。第一次开轮时定,之后每轮的 patch 都相对它。 */
  baseCommit?: string
  /** 终局收尾(交付 push)是否已做过。 */
  finalized?: boolean
}

function localDir(clone: string): string {
  return path.join(clone, ".mother")
}

/**
 * 研发端的本地目录要自带 .gitignore:pullReset 会 `clean -fd`,没有忽略规则的话
 * 每次同步都会把会话指针清掉(clean 不删被 ignore 的文件,这正是护身符)。
 */
async function ensureLocalDir(clone: string): Promise<void> {
  const dir = localDir(clone)
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!(await fileExists(ignore))) {
    await writeFile(ignore, "# 研发端的本地状态,不进信箱(含自身)\n*\n")
  }
}

async function readLocalState(clone: string): Promise<MotherLocalState> {
  const file = path.join(localDir(clone), "state.json")
  if (!(await fileExists(file))) return {}
  try {
    return await readJsonFile<MotherLocalState>(file)
  } catch {
    return {}
  }
}

async function saveLocalState(clone: string, state: MotherLocalState): Promise<void> {
  // ensureLocalDir 不能省:它写的 .gitignore 才是 pullReset 的 clean -fd 下的护身符,
  // 只靠 writeJson 的 mkdir 会让会话指针每轮被静默清掉。
  await ensureLocalDir(clone)
  await writeJson(path.join(localDir(clone), "state.json"), state)
}

/**
 * 从自由文本里取出决定。只认**最后一个** ```json 围栏 —— 模型常在正文里引用示例,
 * 最后一个才是"落笔"。
 */
export function parseMotherDecision(
  text: string,
): { ok: true; payload: MotherDecisionPayload } | { ok: false; error: string } {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  if (!fences.length) return { ok: false, error: "回复里没有 ```json 围栏" }
  const raw = fences[fences.length - 1]![1]!
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `围栏内容不是合法 JSON:${(error as Error).message}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "围栏里必须是一个 JSON 对象" }
  }
  const record = parsed as Record<string, unknown>
  const decision = record.decision
  if (decision !== "continue" && decision !== "done" && decision !== "fail") {
    return { ok: false, error: `decision "${String(decision)}" 不认识,可选:continue / done / fail` }
  }
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).trim() !== ""
      ? (record[key] as string).trim()
      : undefined
  const instruction = str("instruction")
  const reason = str("reason")
  if (decision === "continue" && !instruction) {
    return { ok: false, error: "decision 为 continue 时 instruction 必填,而且要具体到下一轮做什么" }
  }
  if (decision !== "continue" && !reason) {
    return { ok: false, error: `decision 为 ${decision} 时 reason 必填` }
  }

  const artifactsRaw = record.artifacts
  let artifacts: string[] | undefined
  if (artifactsRaw !== undefined && artifactsRaw !== null) {
    if (!Array.isArray(artifactsRaw))
      return { ok: false, error: "artifacts 必须是一个字符串数组(相对工程根的文件路径)" }
    artifacts = artifactsRaw
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim())
    if (artifacts.length !== artifactsRaw.length) return { ok: false, error: "artifacts 里有不是字符串(或为空)的项" }
    if (!artifacts.length) artifacts = undefined
  }

  return { ok: true, payload: { decision, analysis: str("analysis"), instruction, reason, artifacts } }
}

/**
 * 研发端这一侧最终用的模型。
 *
 * 模型要么齐(providerID+modelID 都在),要么回落到 `job.model` —— 后者在 parseJob 里
 * 已经落定(任务书没写就是调试台的 `DEFAULT_MODEL`),所以研发端与工位端天然同一个默认。
 * 半拉子的 mother.model 不去补另一半:补出来的组合会在 setModel 上报未知模型。
 *
 * `thinking` 不受"要么齐要么不填"约束:它不参与上面那个跳过判断(那是 providerID+modelID
 * 的事),而"同一个模型上让研发端想得更狠"是常见需求。
 *
 * 导出是给 `yoma-bench check` 用的 —— 印出来的和真跑的必须是同一套算法。
 */
export function resolveMotherModel(mailboxJob: MailboxJob): JobModel | undefined {
  const mother = mailboxJob.mailbox.mother.model
  const base = mother?.providerID && mother?.modelID ? mother : mailboxJob.job.model
  const thinking = mother?.thinking ?? base?.thinking
  return base || thinking ? { ...base, thinking } : undefined // (base || thinking) ? … —— || 优先于 ?:
}

/**
 * 研发端跑内核轮所用的合成 job:工作区是**项目仓**。分支沿用 job 声明的那条 ——
 * 代码归研发端写,交付的就是这条分支。
 */
function motherTurnJob(mailboxJob: MailboxJob, workspace: string): Job {
  const job = mailboxJob.job
  return { ...job, repo: { ...job.repo, directory: workspace }, model: resolveMotherModel(mailboxJob) }
}

/** 把 agent 声明的相对路径变成可拷贝的附件条目;边界与重名在这里挡掉。 */
function planArtifacts(
  declared: string[],
  workspace: string,
): { ok: true; entries: { source: string; name: string; from: string }[] } | { ok: false; error: string } {
  const entries: { source: string; name: string; from: string }[] = []
  const seen = new Set<string>()
  for (const item of declared) {
    if (path.isAbsolute(item)) {
      return { ok: false, error: `artifacts 里的 ${item} 是绝对路径 —— 要写相对工程根的路径` }
    }
    const source = path.resolve(workspace, item)
    const relative = path.relative(workspace, source)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, error: `artifacts 里的 ${item} 落在工程目录之外` }
    }
    const name = path.basename(source)
    if (seen.has(name)) {
      return { ok: false, error: `两个附件的文件名都叫 ${name} —— 信箱里它们会互相覆盖,改个名或只附一个` }
    }
    seen.add(name)
    entries.push({ source, name, from: relative })
  }
  return { ok: true, entries }
}

export async function motherStep(options: MailboxMotherOptions): Promise<MotherStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)
  const sync = syncContext(options)

  // 与 runnerStep 同一条纪律:同步失败走 blocked(守护对它有退避),不裸抛。
  try {
    await flushThenPullReset(sync)
  } catch (error) {
    return { kind: "blocked", detail: (error as Error).message }
  }
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }

  let workspace: string
  try {
    workspace = resolveWorkspace(snapshot.job.job, options.projectDir)
  } catch (error) {
    return { kind: "blocked", detail: (error as Error).message }
  }

  if (snapshot.state.kind === "done") {
    return ensureFinalized(options, snapshot.job, workspace, snapshot.state.verdict, progress)
  }
  if (snapshot.state.kind === "awaiting-runner") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮指令已下发,等工位端执行` }
  }

  const outcome =
    snapshot.state.kind === "kickoff"
      ? await kickoff(options, snapshot.job, workspace, progress)
      : await decide(options, snapshot.job, workspace, snapshot.state, snapshot.rounds, progress)
  // 刚写下终局的那一步也要收尾 —— 守护循环见到 done 就返回退出,不在这里做的话
  // 交付分支永远推不出去(测试逮住过:verdict 是 passed,远端却没有那条分支)。
  if (outcome.kind === "done") {
    return ensureFinalized(options, snapshot.job, workspace, outcome.verdict, progress)
  }
  return outcome
}

/** 终局收尾一次就够,幂等由本地状态钉住。收尾失败按 blocked 交给退避循环重试。 */
async function ensureFinalized(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  verdict: MailboxVerdict,
  progress: (message: string) => void,
): Promise<MotherStepOutcome> {
  const local = await readLocalState(options.clone)
  if (local.finalized) return { kind: "done", verdict }
  const finalized = await finalize(options, mailboxJob, workspace, verdict, progress)
  if (!finalized.ok) return { kind: "blocked", detail: `终局收尾未完成:${finalized.detail}` }
  await saveLocalState(options.clone, { ...(await readLocalState(options.clone)), finalized: true })
  return { kind: "done", verdict }
}

/** 开局:信箱里零轮次,由研发端出第一轮指令(可能先改代码、先构建、先附产物)。 */
async function kickoff(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  progress: (message: string) => void,
): Promise<MotherStepOutcome> {
  const now = options.now ?? Date.now
  const sync = syncContext(options)
  progress("研发端开局:读任务书,决定第一轮")

  const prepared = await prepareProjectBranch(options, mailboxJob, workspace)
  if (!prepared.ok) return { kind: "blocked", detail: prepared.error }

  const analysed = await analyse(options, mailboxJob, workspace, undefined)
  if (!analysed.ok) {
    const reason = `研发端开局未能给出合法决定:${analysed.error}`
    const decision: RoundDecision = {
      round: 0,
      by: "policy",
      decision: "fail",
      reason,
      usage: analysed.usage,
      motherSessionID: analysed.sessionID,
      at: new Date(now()).toISOString(),
    }
    return settleTerminal(options, mailboxJob, [], decision, "failed", reason, 0, 0)
  }

  const payload = analysed.payload
  if (payload.decision !== "continue") {
    const reason = payload.reason!
    const decision: RoundDecision = {
      round: 0,
      by: "mother",
      decision: payload.decision,
      analysis: payload.analysis,
      reason,
      usage: analysed.usage,
      motherSessionID: analysed.sessionID,
      at: new Date(now()).toISOString(),
    }
    progress(`研发端开局就终止:${payload.decision} —— ${reason}`)
    return settleTerminal(options, mailboxJob, [], decision, payload.decision === "done" ? "passed" : "failed", reason, 0, 0)
  }

  const issued = await issueInstruction(options, mailboxJob, workspace, 1, payload, progress)
  if (!issued.ok) return { kind: "blocked", detail: issued.error }

  const pushed = await commitPush(
    sync,
    `round 1: 研发端开局下发第 1 轮${issued.artifacts.length ? `(附 ${issued.artifacts.length} 件)` : ""}`,
  )
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "第一轮指令推不上去" }
  return { kind: "decided", round: 0, decision: "continue" }
}

/** 分析一轮回填的结果并决定下一步。 */
async function decide(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  state: Extract<MailboxState, { kind: "awaiting-mother" }>,
  allRounds: RoundFiles[],
  progress: (message: string) => void,
): Promise<MotherStepOutcome> {
  const { round, instruction, result } = state
  const now = options.now ?? Date.now
  const sync = syncContext(options)

  // 只进终报,不做任何门限判断。
  const motherTokensBefore = sumMotherTokens(allRounds)

  const policyDecision = (decision: DecisionKind, reason: string): RoundDecision => ({
    round,
    by: "policy",
    decision,
    reason,
    at: new Date(now()).toISOString(),
  })
  const terminal = (decision: RoundDecision, outcome: MailboxVerdict["outcome"], reason: string) =>
    settleTerminal(options, mailboxJob, allRounds, decision, outcome, reason, result.spentTokens, motherTokensBefore)

  // 全是模型的判断:做完了没有、下一步改哪儿、还是认输。
  progress(`第 ${round} 轮结果已回填,研发端处理中…`)
  const prepared = await prepareProjectBranch(options, mailboxJob, workspace)
  if (!prepared.ok) return { kind: "blocked", detail: prepared.error }

  const analysed = await analyse(options, mailboxJob, workspace, {
    mailboxJob,
    round,
    instruction,
    result,
    rounds: allRounds,
  })
  const usage = analysed.usage
  if (!analysed.ok) {
    const reason = `研发端未能给出合法决定:${analysed.error}`
    const decision: RoundDecision = { ...policyDecision("fail", reason), usage, motherSessionID: analysed.sessionID }
    return terminal(decision, "failed", reason)
  }

  const payload = analysed.payload
  const decision: RoundDecision = {
    round,
    by: "mother",
    decision: payload.decision,
    analysis: payload.analysis,
    reason: payload.reason,
    usage,
    motherSessionID: analysed.sessionID,
    at: new Date(now()).toISOString(),
  }
  progress(`研发端裁决:${payload.decision}${payload.analysis ? ` —— ${payload.analysis.slice(0, 100)}` : ""}`)

  if (payload.decision !== "continue") {
    return terminal(decision, payload.decision === "done" ? "passed" : "failed", payload.reason!)
  }

  const issued = await issueInstruction(options, mailboxJob, workspace, round + 1, payload, progress)
  if (!issued.ok) return { kind: "blocked", detail: issued.error }
  decision.git = issued.git

  await writeDecision(options.clone, decision)
  const pushed = await commitPush(
    sync,
    `round ${round}: continue(mother)→ 下发第 ${round + 1} 轮${issued.artifacts.length ? `(附 ${issued.artifacts.length} 件)` : ""}`,
  )
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "裁决推不上去" }
  return { kind: "decided", round, decision: "continue" }
}

/**
 * 提交研发端本轮的代码改动、拷附件、写指令。
 *
 * 顺序有讲究:**先提交再拷附件**。附件是从工作树里拿的,提交之后工作树等于 HEAD,
 * 于是"附过去的二进制"和"信箱里的 patch.diff"说的一定是同一个版本。反过来的话,
 * 一个未提交的改动能让工位端烧的固件和研发端记录的补丁对不上,而这种错在证据里
 * 完全看不出来。
 */
async function issueInstruction(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  round: number,
  payload: MotherDecisionPayload,
  progress: (message: string) => void,
): Promise<{ ok: true; artifacts: RoundArtifact[]; git?: RoundGit } | { ok: false; error: string }> {
  const job = mailboxJob.job
  const now = options.now ?? Date.now
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }
  const state = await readLocalState(options.clone)

  const committed = await git.commitAll(gitContext, {
    message: `wip: ${job.title} · 信箱轮 ${round}\n\n任务 ${job.id}(信箱闭环,研发端改动)`,
    author: DEV_COMMIT_AUTHOR,
  })
  if (!committed.committed && committed.message !== "没有改动可提交") {
    return { ok: false, error: `项目仓提交失败,改动证据不可信:${committed.message}` }
  }
  if (committed.committed) progress(`项目仓已提交 ${committed.commit?.slice(0, 8)}`)

  const base = state.baseCommit
  const git_: RoundGit | undefined = base
    ? {
        baseCommit: base,
        headCommit: await git.headCommit(gitContext),
        diffStat: await git.diffStat(gitContext, base),
        changedFiles: await git.diffNameStatus(gitContext, base),
        commits: await git.logSince(gitContext, base),
      }
    : undefined

  let artifacts: RoundArtifact[] = []
  if (payload.artifacts?.length) {
    const planned = planArtifacts(payload.artifacts, workspace)
    if (!planned.ok) return { ok: false, error: planned.error }
    const attached = await attachArtifacts(options.clone, round, planned.entries, mailboxJob.mailbox.maxArtifactBytes)
    if (!attached.ok) return { ok: false, error: attached.error }
    artifacts = attached.artifacts
    progress(`附件 ${artifacts.map((item) => item.name).join("、")}`)
  }

  await writeInstruction(
    options.clone,
    {
      round,
      prompt: payload.instruction!,
      issuedBy: "mother",
      artifacts: artifacts.length ? artifacts : undefined,
      at: new Date(now()).toISOString(),
    },
    { patch: base ? await git.diffPatch(gitContext, base) : undefined },
  )
  return { ok: true, artifacts, git: git_ }
}

/** 写裁决 + 终局 + 终报,一次推送。 */
async function settleTerminal(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  allRounds: RoundFiles[],
  decision: RoundDecision,
  outcome: MailboxVerdict["outcome"],
  reason: string,
  runnerTokens: number,
  motherTokensBefore: number,
): Promise<MotherStepOutcome> {
  const now = options.now ?? Date.now
  const sync = syncContext(options)
  await writeDecision(options.clone, decision)
  const verdict: MailboxVerdict = {
    outcome,
    reason,
    rounds: decision.round,
    totalRunnerTokens: runnerTokens,
    totalMotherTokens: motherTokensBefore + usageTokens(decision.usage),
    decidedBy: decision.by,
    at: new Date(now()).toISOString(),
  }
  // 终报要包含本轮裁决 —— 重读一遍本轮(decision 刚落盘),别用扫描时的旧快照。
  // 本轮永远是最后一轮:listRoundNumbers 升序,而 awaiting-mother 取的就是末尾那条,
  // 所以摘掉再追加不会打乱顺序。round 0 是开局轮,没有 rounds/000。
  const rounds = allRounds.filter((entry) => entry.round !== decision.round)
  if (decision.round > 0) rounds.push(await readRound(options.clone, decision.round))
  const report = renderMailboxReport({ mailboxJob, verdict, rounds, sessionsRoot: options.sessionsRoot })
  await writeVerdict(options.clone, verdict, report)
  const pushed = await commitPush(sync, `verdict: ${verdict.outcome}(${decision.by})—— ${verdict.reason.slice(0, 60)}`)
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "终局推不上去" }
  return { kind: "done", verdict }
}

/**
 * 准备项目仓的工作分支。第一次开轮时建并记下基线,之后每轮确认还在这条分支上
 * (人手动切走时要能自己回来)。
 */
async function prepareProjectBranch(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const job = mailboxJob.job
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }
  const branch = job.repo.branch ?? `agent/${job.id}`
  const state = await readLocalState(options.clone)

  // 忽略文件要**先于**干净性检查就位:它们是调试台自己生成的,不忽略就成了
  // "未跟踪又不被忽略"的条目,prepareBranch 的第一道检查会被自己挡死。
  await ensureYomaDir(workspace)

  if (!state.baseCommit) {
    if (!(await git.isRepo(gitContext)))
      return { ok: false, error: `${workspace} 不是 git 仓库 —— 研发端要在分支上提交改动` }
    const prepared = await git.prepareBranch(gitContext, { branch, ref: job.repo.ref })
    if (!prepared.ok) return { ok: false, error: `准备工作分支失败:${prepared.message}` }
    await saveLocalState(options.clone, { ...state, baseCommit: prepared.baseCommit })
    return { ok: true }
  }
  if ((await git.currentBranch(gitContext)) !== branch) {
    const prepared = await git.prepareBranch(gitContext, { branch })
    if (!prepared.ok) return { ok: false, error: `回到工作分支失败:${prepared.message}` }
  }
  return { ok: true }
}

/**
 * 终局收尾 —— 代码在研发端,所以交付 push 在这里。幂等,失败如实返回交给退避循环重试。
 */
async function finalize(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  verdict: MailboxVerdict,
  progress: (message: string) => void,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const job = mailboxJob.job
  if (verdict.outcome !== "passed" || !job.deliver?.push) return { ok: true }
  const gitContext: git.GitContext = { cwd: workspace, run: options.gitRun }
  const branch = job.repo.branch ?? `agent/${job.id}`
  const pushed = await git.pushBranch(gitContext, { branch, remote: job.deliver.remote ?? "origin" })
  progress(pushed.ok ? pushed.message : `⚠ ${pushed.message}`)
  return pushed.ok ? { ok: true } : { ok: false, detail: `交付分支推送失败:${pushed.message}` }
}

type AnalyseResult =
  | { ok: true; payload: MotherDecisionPayload; usage: TurnUsage; sessionID?: string }
  | { ok: false; error: string; usage: TurnUsage; sessionID?: string }

/**
 * 跑一轮研发端的内核会话。`input` 为空表示开局轮(信箱里还没有任何结果)。
 */
async function analyse(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  workspace: string,
  input: MotherPromptInput | undefined,
): Promise<AnalyseResult> {
  const run = options.runTurn ?? runTurn
  const state = await readLocalState(options.clone)
  const job = motherTurnJob(mailboxJob, workspace)

  const turnOnce = async (prompt: string, sessionID?: string): Promise<TurnResult> =>
    run({
      job,
      workspace,
      sessionsRoot: options.sessionsRoot,
      stateDir: path.join(localDir(options.clone), "state"),
      enginesDir: options.enginesDir,
      configDir: options.configDir,
      resolveModels: options.resolveModels,
      sessionID,
      prompt,
    })

  await ensureLocalDir(options.clone)
  let usage = zeroUsage()
  let sessionID = state.sessionID
  const book = async (turnUsage: TurnUsage) => {
    usage = addUsage(usage, turnUsage)
    await saveLocalState(options.clone, { ...(await readLocalState(options.clone)), sessionID })
  }

  let turn: TurnResult
  try {
    turn = await turnOnce(
      // input 为空 = 开局轮(两种会话状态都用开局提示词);有 input 时才分首轮/跟进。
      input ? (sessionID ? motherFollowUpPrompt(input) : motherPrompt(input)) : motherKickoffPrompt(mailboxJob),
      sessionID,
    )
  } catch (error) {
    // 会话可能已不在(sessionsRoot 换了、文件被清)。丢掉延续指针,下次轮询重开。
    await saveLocalState(options.clone, { ...(await readLocalState(options.clone)), sessionID: undefined })
    return { ok: false, error: `研发端轮执行失败:${(error as Error).message}`, usage }
  }
  sessionID = turn.sessionID
  await book(turn.usage)

  let parsed = parseMotherDecision(turn.text)
  if (!parsed.ok) {
    if (turn.stopReason) {
      return { ok: false, error: `研发端轮被中断(${turn.stopReason}),没有产出决定`, usage, sessionID }
    }
    // 重试一次,同一会话:错误信息就是新提示词。
    let retry: TurnResult
    try {
      retry = await turnOnce(motherRetryPrompt(parsed.error), sessionID)
    } catch (error) {
      return { ok: false, error: `${parsed.error};重试轮执行失败:${(error as Error).message}`, usage, sessionID }
    }
    await book(retry.usage)
    parsed = parseMotherDecision(retry.text)
    if (!parsed.ok) return { ok: false, error: `重试后仍然:${parsed.error}`, usage, sessionID }
  }
  return { ok: true, payload: parsed.payload, usage, sessionID }
}

function usageTokens(usage?: TurnUsage): number {
  if (!usage) return 0
  return usage.tokens.input + usage.tokens.output
}

/** 常驻循环(锁 / 退避 / 轮询骨架都在 runRoleDaemon);终局 done 即退出。 */
export async function runMailboxMother(
  options: MailboxMotherOptions & {
    pollSeconds: number
    once?: boolean
    /** 每步之后回调一次(含终局那步)。桌面端守护入口靠它发结构化事件。 */
    onStep?: (outcome: MotherStepOutcome) => void
  },
): Promise<MotherStepOutcome> {
  return runRoleDaemon<MotherStepOutcome>({
    clone: options.clone,
    role: "mother",
    pollSeconds: options.pollSeconds,
    once: options.once,
    step: () => motherStep(options),
    blocked: (detail) => ({ kind: "blocked", detail }),
    terminalKind: "done",
    onStep: options.onStep,
    onProgress: options.onProgress,
  })
}
