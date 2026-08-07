/**
 * 母 agent —— 闭环的决策侧。读轮结果,决定下一轮指令或终局。
 *
 * ## 决策分两层,层序即权力边界
 *
 * 1. **确定性守卫(代码)先裁。** 判据全过 → 终局 passed;预算(轮数/token)耗尽 →
 *    终局 failed;轮级失败与环境错误 → 挂起。这些不问模型 —— 判据与预算不归模型管,
 *    对调试 agent 如此,对母 agent 同样如此。守卫的裁决记 `by: "policy"`。
 * 2. **剩下的才是真判断**:判据没过、预算还有、环境正常 —— 继续哪个假设、还是认输、
 *    还是叫人。这一步跑一轮真的 yoma 内核会话(readonly 策略,工作区就是信箱克隆,
 *    可以用 read 工具细看轮次文件与补丁),决定必须落在结尾的 ```json 围栏里。
 *
 * ## 为什么母 agent 的轮不进子进程
 *
 * runner 侧"一轮一个子进程"的理由是探针/gdb/日志采集的模块级全局 —— 母 agent 的
 * readonly 策略根本碰不到硬件工具,进程边界在这里没有要清理的东西;runTurn 每次
 * 建 host、用完 dispose,进程内已经是干净的生命周期。
 *
 * ## 解析失败的终点是 parked,不是无限重试
 *
 * 决定 JSON 不合法时重试一次;再失败就把闭环挂起(by:"policy",理由写明)。守护
 * 进程的轮询循环里没有"这次不算"——每次重试都是真实的模型花费,烧钱等不来正确性。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { fileExists, readJsonFile } from "../fsx.ts"
import { runTurn, type TurnOptions, type TurnResult, type TurnUsage } from "../turn.ts"
import type { Job } from "../job.ts"
import { acquireRoleLock, backoffSeconds } from "./daemon.ts"
import { renderMailboxReport } from "./report.ts"
import { motherFollowUpPrompt, motherPrompt, motherRetryPrompt, type MotherPromptInput } from "./prompts.ts"
import {
  readRound,
  scanMailbox,
  sumMotherTokens,
  writeDecision,
  writeInstruction,
  writeVerdict,
  type DecisionKind,
  type MailboxVerdict,
  type RoundDecision,
  type RoundFiles,
} from "./store.ts"
import { commitPush, flushThenPullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"

export interface MailboxMotherOptions {
  /** 信箱克隆目录(也是母 agent 分析轮的工作区)。 */
  clone: string
  branch?: string
  sessionsRoot: string
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
}

const MOTHER_AUTHOR = { name: "yoma-mailbox-mother", email: "bench@yoma.local" }

interface MotherLocalState {
  sessionID?: string
  /**
   * mother 跨轮累计花费的本地账本。信箱里的 decision.usage 是它的持久副本,但那份
   * 只在 push 成功后存在 —— push 失败/中途崩溃时若只靠信箱账本,这笔花费会从一切
   * 账目蒸发,blocked 重试循环就成了无界烧钱(实测证据链见审查记录)。
   * 每次分析轮结束**先记账再推送**;预算守卫取两本账的最大值。
   */
  spentTokens?: number
}

function localDir(clone: string): string {
  return path.join(clone, ".mother")
}

/**
 * 母 agent 的本地目录要自带 .gitignore:pullReset 会 `clean -fd`,没有忽略规则的话
 * 每次同步都会把会话指针清掉(clean 不删被 ignore 的文件,这正是护身符)。
 */
async function ensureLocalDir(clone: string): Promise<void> {
  const dir = localDir(clone)
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!(await fileExists(ignore))) {
    await writeFile(ignore, "# 母 agent 的本地状态,不进信箱(含自身)\n*\n")
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
  await ensureLocalDir(clone)
  await writeFile(path.join(localDir(clone), "state.json"), JSON.stringify(state, null, 2) + "\n")
}

/**
 * 从自由文本里取出决定。只认**最后一个** ```json 围栏 —— 模型常在正文里引用示例,
 * 最后一个才是"落笔"。
 */
export function parseMotherDecision(text: string): { ok: true; payload: MotherDecisionPayload } | { ok: false; error: string } {
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
  if (decision === "success") {
    return { ok: false, error: `"success" 不是你能给的决定 —— 判据由工位机独立执行,全绿时闭环自动终止。可选:continue / fail / park` }
  }
  if (decision !== "continue" && decision !== "fail" && decision !== "park") {
    return { ok: false, error: `decision "${String(decision)}" 不认识,可选:continue / fail / park` }
  }
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).trim() !== "" ? (record[key] as string).trim() : undefined
  const instruction = str("instruction")
  const reason = str("reason")
  if (decision === "continue" && !instruction) {
    return { ok: false, error: "decision 为 continue 时 instruction 必填,而且要具体到下一轮做什么" }
  }
  if (decision !== "continue" && !reason) {
    return { ok: false, error: `decision 为 ${decision} 时 reason 必填` }
  }
  return { ok: true, payload: { decision, analysis: str("analysis"), instruction, reason } }
}

/** 母 agent 分析轮所用的合成 job:readonly 策略,工作区是信箱克隆。 */
function motherTurnJob(mailboxJob: MailboxJob, clone: string): Job {
  const job = mailboxJob.job
  // 模型要么齐(providerID+modelID 都在),要么回落到 job.model —— 半拉子的
  // mother.model 会让 setModel 被跳过,静默用内核默认模型,与 spec 承诺不符。
  const motherModel = mailboxJob.mailbox.mother.model
  const model = motherModel?.providerID && motherModel?.modelID ? motherModel : job.model
  return {
    id: `${job.id}-mother`,
    title: `母 agent · ${job.title}`,
    repo: { directory: clone, branch: `mother/${job.id}` },
    bench: {},
    task: job.task,
    success: { checks: [], repeat: 1 },
    budget: job.budget,
    policy: "readonly",
    model,
  }
}

export async function motherStep(options: MailboxMotherOptions): Promise<MotherStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)
  const sync: MailboxSyncContext = { clone: options.clone, branch: options.branch, author: MOTHER_AUTHOR, run: options.gitRun }

  await flushThenPullReset(sync)
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (snapshot.state.kind === "done") return { kind: "done", verdict: snapshot.state.verdict }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }
  if (snapshot.state.kind === "awaiting-runner") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮指令已下发,等工位机执行` }
  }

  const { round, instruction, result } = snapshot.state
  const mailboxJob = snapshot.job
  const job = mailboxJob.job
  const now = options.now ?? Date.now

  // 两本账取大:信箱里的 decision.usage(push 成功才有)与本地账本(push 前就记)。
  const local = await readLocalState(options.clone)
  const motherTokensBefore = Math.max(sumMotherTokens(snapshot.rounds), local.spentTokens ?? 0)
  const tokensTotal = result.spentTokens + motherTokensBefore
  const budget = {
    roundsUsed: round,
    maxRounds: mailboxJob.mailbox.maxRounds,
    tokensSpent: tokensTotal,
    maxTokens: job.budget.maxTokens,
  }

  const settle = async (
    decision: RoundDecision,
    next?: { instruction: string },
    verdictOutcome?: MailboxVerdict["outcome"],
    verdictReason?: string,
  ): Promise<MotherStepOutcome> => {
    await writeDecision(options.clone, decision)
    if (next) {
      await writeInstruction(options.clone, {
        round: round + 1,
        prompt: next.instruction,
        issuedBy: "mother",
        at: new Date(now()).toISOString(),
      })
      const pushed = await commitPush(sync, `round ${round}: ${decision.decision}(${decision.by}) → 下发第 ${round + 1} 轮`)
      if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "裁决推不上去" }
      return { kind: "decided", round, decision: decision.decision }
    }
    const verdict: MailboxVerdict = {
      outcome: verdictOutcome!,
      reason: verdictReason!,
      rounds: round,
      totalRunnerTokens: result.spentTokens,
      totalMotherTokens: motherTokensBefore + usageTokens(decision.usage),
      decidedBy: decision.by,
      at: new Date(now()).toISOString(),
    }
    // 终报要包含本轮裁决 —— 重新读一遍轮次(decision 刚落盘),别用扫描时的旧快照。
    const rounds: RoundFiles[] = []
    for (const entry of snapshot.rounds) rounds.push(entry.round === round ? await readRound(options.clone, round) : entry)
    const report = renderMailboxReport({ mailboxJob, verdict, rounds, sessionsRoot: options.sessionsRoot })
    await writeVerdict(options.clone, verdict, report)
    const pushed = await commitPush(sync, `verdict: ${verdict.outcome}(${decision.by})—— ${verdict.reason.slice(0, 60)}`)
    if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "终局推不上去" }
    return { kind: "done", verdict }
  }

  const policyDecision = (decision: DecisionKind, reason: string): RoundDecision => ({
    round,
    by: "policy",
    decision,
    reason,
    at: new Date(now()).toISOString(),
  })

  // ── 第一层:确定性守卫。判据与预算不归模型管。 ──────────────────────────────
  // 轮级失败先于"判据通过"判:commit 坏掉的轮判据可能照样绿,但改动证据不可信,
  // 这时宣布 success 会交付一个没有提交的"修复"。
  if (result.error) {
    if (tokensTotal >= job.budget.maxTokens) {
      const reason = `token 预算 ${job.budget.maxTokens} 耗尽(${result.error})`
      return settle(policyDecision("fail", reason), undefined, "failed", reason)
    }
    const reason = `第 ${round} 轮轮级失败:${result.error}`
    progress(`⚠ ${reason} —— 挂起给人`)
    return settle(policyDecision("park", reason), undefined, "parked", reason)
  }
  if (result.grade?.passed) {
    const reason = `第 ${round} 轮判据全部通过`
    progress(`✓ ${reason} —— 终局 passed(守卫裁决,不问模型)`)
    return settle(policyDecision("success", reason), undefined, "passed", reason)
  }
  if (result.turn?.stopReason) {
    if (tokensTotal >= job.budget.maxTokens) {
      const reason = `token 预算 ${job.budget.maxTokens} 耗尽`
      return settle(policyDecision("fail", reason), undefined, "failed", reason)
    }
    const reason = `第 ${round} 轮被中断:${result.turn.stopReason}`
    return settle(policyDecision("park", reason), undefined, "parked", reason)
  }
  // provider 级失败的轮长这样:text 空、没有工具调用、errors 非空 —— 内核把失败当
  // 数据,轮"正常"结束。不拦的话 mother 会对着"什么都没做"的轮持续 continue,
  // 空轮 token≈0,一路烧到轮数上限,终局理由还会写成"轮数用尽"(补审逮住过)。
  if (result.turn && !result.turn.text && Object.keys(result.turn.toolCounts).length === 0 && result.turn.errors.length) {
    const reason = `第 ${round} 轮空转(provider 级错误):${result.turn.errors[0]}`
    return settle(policyDecision("park", reason), undefined, "parked", reason)
  }
  if (result.grade?.hasEnvironmentError) {
    const summary = [result.grade.build, ...result.grade.checks].find((check) => check?.outcome === "error")?.summary ?? ""
    const reason = `判据没跑成(环境问题):${summary}`
    return settle(policyDecision("park", reason), undefined, "parked", reason)
  }
  if (round >= mailboxJob.mailbox.maxRounds) {
    const reason = `轮数预算 ${mailboxJob.mailbox.maxRounds} 用尽,判据仍未通过`
    return settle(policyDecision("fail", reason), undefined, "failed", reason)
  }
  if (tokensTotal >= job.budget.maxTokens) {
    const reason = `token 预算 ${job.budget.maxTokens} 耗尽(两侧合计 ${tokensTotal})`
    return settle(policyDecision("fail", reason), undefined, "failed", reason)
  }
  // 墙钟从第 1 轮指令下发时刻起算,粒度是"裁决点"—— 不是分钟级抢占(轮内自有
  // TURN_HARD_TIMEOUT 兜底),但保证闭环不会在无人看的机器上连跑十几个小时。
  const startedAt = Date.parse(snapshot.rounds[0]?.instruction?.at ?? "")
  if (Number.isFinite(startedAt) && now() - startedAt >= job.budget.wallClockMin * 60 * 1000) {
    const reason = `墙钟预算 ${job.budget.wallClockMin} 分钟耗尽`
    return settle(policyDecision("fail", reason), undefined, "failed", reason)
  }

  // ── 第二层:真判断,跑母 agent 的内核轮。 ────────────────────────────────────
  progress(`第 ${round} 轮判据未过,母 agent 分析中…`)
  const analysed = await analyse(options, mailboxJob, { round, instruction, result, rounds: snapshot.rounds, budget })

  const usage = analysed.usage
  if (!analysed.ok) {
    const reason = `母 agent 未能给出合法决定:${analysed.error}`
    const decision: RoundDecision = { ...policyDecision("park", reason), usage, motherSessionID: analysed.sessionID }
    return settle(decision, undefined, "parked", reason)
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
  progress(`母 agent 裁决:${payload.decision}${payload.analysis ? ` —— ${payload.analysis.slice(0, 100)}` : ""}`)

  if (payload.decision === "continue") return settle(decision, { instruction: payload.instruction! })
  return settle(decision, undefined, payload.decision === "fail" ? "failed" : "parked", payload.reason!)
}

type AnalyseResult =
  | { ok: true; payload: MotherDecisionPayload; usage: TurnUsage; sessionID?: string }
  | { ok: false; error: string; usage: TurnUsage; sessionID?: string }

async function analyse(
  options: MailboxMotherOptions,
  mailboxJob: MailboxJob,
  input: Omit<MotherPromptInput, "mailboxJob" | "patchPath">,
): Promise<AnalyseResult> {
  const run = options.runTurn ?? runTurn
  const state = await readLocalState(options.clone)
  const job = motherTurnJob(mailboxJob, options.clone)
  const maxTokens = mailboxJob.mailbox.mother.maxTokensPerAnalysis
  const patchRelative = path.join("rounds", String(input.round).padStart(3, "0"), "patch.diff")
  const hasPatch = await fileExists(path.join(options.clone, patchRelative))

  const promptInput: MotherPromptInput = { mailboxJob, patchPath: hasPatch ? patchRelative : undefined, ...input }
  const zero: TurnUsage = { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }

  const turnOnce = async (prompt: string, sessionID?: string): Promise<TurnResult> =>
    run({
      job,
      workspace: options.clone,
      sessionsRoot: options.sessionsRoot,
      stateDir: path.join(localDir(options.clone), "state"),
      configDir: options.configDir,
      resolveModels: options.resolveModels,
      sessionID,
      prompt,
      shouldStop: (usage) =>
        usage.tokens.input + usage.tokens.output >= maxTokens
          ? `母 agent 单次分析预算 ${maxTokens} tokens 耗尽`
          : undefined,
    })

  await ensureLocalDir(options.clone)
  let usage = zero
  let sessionID = state.sessionID
  /** 本地账本:每跑完一轮就记账,**先于**任何推送。花费不因产出没推上去而消失。 */
  let ledger = state.spentTokens ?? 0
  const book = async (turnUsage: TurnUsage) => {
    usage = addUsage(usage, turnUsage)
    ledger += turnUsage.tokens.input + turnUsage.tokens.output
    await saveLocalState(options.clone, { sessionID, spentTokens: ledger })
  }

  let turn: TurnResult
  try {
    turn = await turnOnce(sessionID ? motherFollowUpPrompt(promptInput) : motherPrompt(promptInput), sessionID)
  } catch (error) {
    if (!sessionID) return { ok: false, error: `分析轮执行失败:${(error as Error).message}`, usage }
    // 旧会话可能已不在(sessionsRoot 换了、文件被清)。丢掉延续,用完整提示词重来一次。
    sessionID = undefined
    try {
      turn = await turnOnce(motherPrompt(promptInput))
    } catch (retryError) {
      return { ok: false, error: `分析轮执行失败:${(retryError as Error).message}`, usage }
    }
  }
  sessionID = turn.sessionID
  await book(turn.usage)

  let parsed = parseMotherDecision(turn.text)
  if (!parsed.ok) {
    if (turn.stopReason) {
      return { ok: false, error: `分析轮被中断(${turn.stopReason}),没有产出决定`, usage, sessionID }
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

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cache: { read: a.tokens.cache.read + b.tokens.cache.read, write: a.tokens.cache.write + b.tokens.cache.write },
    },
    cost: a.cost + b.cost,
  }
}

function usageTokens(usage?: TurnUsage): number {
  if (!usage) return 0
  return usage.tokens.input + usage.tokens.output
}

/** 常驻循环,与 runner 侧同构;终局(done)即退出。 */
export async function runMailboxMother(
  options: MailboxMotherOptions & {
    pollSeconds: number
    once?: boolean
    /** 每步之后回调一次(含终局那步)。桌面端守护入口靠它发结构化事件。 */
    onStep?: (outcome: MotherStepOutcome) => void
  },
): Promise<MotherStepOutcome> {
  const lock = await acquireRoleLock(options.clone, "mother")
  if (!lock.ok) return { kind: "blocked", detail: lock.detail }
  let blockedStreak = 0
  try {
    for (;;) {
      let outcome: MotherStepOutcome
      try {
        outcome = await motherStep(options)
      } catch (error) {
        outcome = { kind: "blocked", detail: (error as Error).message }
      }
      options.onStep?.(outcome)
      if (outcome.kind === "idle") options.onProgress?.(`(空闲)${outcome.detail}`)
      if (outcome.kind === "done" || options.once) return outcome
      blockedStreak = outcome.kind === "blocked" ? blockedStreak + 1 : 0
      const delay = backoffSeconds(options.pollSeconds, blockedStreak)
      if (outcome.kind === "blocked") options.onProgress?.(`⚠ ${outcome.detail}(${delay}s 后重试)`)
      await new Promise((resolve) => setTimeout(resolve, delay * 1000))
    }
  } finally {
    await lock.release()
  }
}
