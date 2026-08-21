/**
 * 一次 trial —— 评测的最小单位。
 *
 * ## 为什么复用 bench 的 `runTurnInChildProcess`
 *
 * 评的是**整个 agent**(模型 + harness + 工具 + 提示词),所以执行路径必须与用户真用的
 * 那条一模一样:同一个 `createKernelHost` 装配、同一套投影器与自动压缩、同一份会话落盘。
 * 自己再搭一条"评测专用"的执行链,评出来的分数就只对那条链成立。
 *
 * 一 trial 一进程的理由与 bench 一字不差:yoma 的探针租约 / gdb 会话表 / log 采集器
 * 都是模块级全局,进程边界 = 免费且可靠的清理。
 *
 * ## 四态怎么定
 *
 * `error` 是**基础设施**问题,不计入 pass 率:子进程崩、硬超时、provider 一路失败
 * (`stopReason` 非空)、会话文件读不到。文章把"把 API 抖了记成 agent 笨"叫
 * correlated failures —— 它会让同一时段跑的所有题一起变差,而你以为是模型退化了。
 *
 * `fail` 只留给一件事:agent 真的跑完了,但产出不对。
 */

import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"

import { runTurnInChildProcess, type FauxScript, type Job, type TurnInput, type TurnResult } from "@yoma-desktop/bench"
import type { Tokens } from "@yoma-desktop/kernel"

import { extractLastJsonFence, type AnswerExtraction } from "./answer.ts"
import { createGrader, type GraderVerdict } from "./graders/index.ts"
import { findRepoRoot } from "./repo.ts"
import { readTranscript, type Transcript } from "./session.ts"
import { DEFAULT_TASK_TIMEOUT_MS, type Task } from "./task.ts"

export type TrialStatus = "pass" | "fail" | "error" | "skip"

export interface TrialMetrics {
  /** assistant 消息数。工具循环里同一轮会有很多条 —— 这就是"107 条消息"的那个计数。 */
  turns: number
  toolCalls: number
  /** 按工具名计数。看得见"它到底在反复调什么"。 */
  toolsUsed: Record<string, number>
  toolErrors: number
  tokens: Tokens
  cost: number
  elapsedMs: number
  stopReason?: string
  errors: string[]
}

export interface TrialRecord {
  runID: string
  taskID: string
  tags: string[]
  /** 第几次(0 起)。 */
  trial: number
  /** `provider/model`;没钉模型时是 undefined(由内核按本机凭据挑)。 */
  model?: string
  status: TrialStatus
  /** 通过的 grader 比例(部分分)。skip / error 是 0。 */
  score: number
  graders: GraderVerdict[]
  answer: AnswerExtraction
  metrics: TrialMetrics
  sessionID?: string
  sessionFile?: string
  workspace?: string
  inputFile?: string
  outputFile?: string
  startedAt: string
  finishedAt: string
  /** 只有 error / skip 才有:这一条到底出了什么事。 */
  error?: string
}

export interface TrialOptions {
  task: Task
  /** 第几次(0 起)。 */
  index: number
  runID: string
  /** `runs/<stamp>`。workspace 落在 `<runDir>/trials/<task>/<n>/`。 */
  runDir: string
  sessionsRoot: string
  /** `provider/model`。不给则由内核按本机凭据挑(与 bench 同一规则)。 */
  model?: string
  thinking?: string
  enginesDir?: string
  /** 凭据/技能/上下文;selftest 传临时目录隔离,run 不传则用 ~/.yoma。 */
  configDir?: string
  /** 假模型剧本(selftest)。有它则不联网、不要 key,其余全真。 */
  faux?: FauxScript
  repoRoot?: string
  /** 轮次静默判定窗口;只有测试会调小它。 */
  settleMs?: number
  onProgress?: (line: string) => void
}

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

export const emptyMetrics = (): TrialMetrics => ({
  turns: 0,
  toolCalls: 0,
  toolsUsed: {},
  toolErrors: 0,
  tokens: zeroTokens(),
  cost: 0,
  elapsedMs: 0,
  errors: [],
})

/** `provider/model` → JobModel。模型 id 里可以再带斜杠(openrouter 那种),只切第一刀。 */
export function parseModelRef(ref: string | undefined): { providerID?: string; modelID?: string } {
  if (!ref) return {}
  const cut = ref.indexOf("/")
  if (cut <= 0 || cut === ref.length - 1) return {}
  return { providerID: ref.slice(0, cut), modelID: ref.slice(cut + 1) }
}

/**
 * bench 把 turn 的输入/输出写在哪里 —— **必须与 `runner.ts` 的 stamp 公式一致**。
 *
 * 抄一份是因为 `runTurnInChildProcess` 不返回这两个路径,而 evals 要把它们记进
 * results.jsonl(出了事可以直接拿 input.json 重放一轮)。公式漂了不会报错,
 * 只会让报告里的路径指向不存在的文件 —— 所以这里留了指针,改 runner 时一起改。
 */
export function turnFilesFor(
  workspace: string,
  jobID: string,
  promptLength: number,
): { input: string; output: string } {
  const dir = path.join(workspace, ".yoma", "bench", "turns")
  const stamp = `${jobID}-${promptLength}`
  return { input: path.join(dir, `turn-${stamp}.json`), output: path.join(dir, `turn-${stamp}.result.json`) }
}

function tally(transcript: Transcript | undefined, result: TurnResult | undefined): TrialMetrics {
  const metrics = emptyMetrics()
  if (result) {
    metrics.tokens = result.usage.tokens
    metrics.cost = result.usage.cost
    metrics.elapsedMs = result.elapsedMs
    metrics.stopReason = result.stopReason
    metrics.errors = result.errors
  }
  if (transcript) {
    metrics.turns = transcript.assistantCount
    metrics.toolCalls = transcript.toolCalls.length
    for (const call of transcript.toolCalls) {
      metrics.toolsUsed[call.name] = (metrics.toolsUsed[call.name] ?? 0) + 1
      if (call.status === "error") metrics.toolErrors += 1
    }
  }
  return metrics
}

/** `requires` 不满足时的记录。runTrial 不会被调到 —— 一次模型花费都不该发生。 */
export function skippedTrial(task: Task, index: number, runID: string, reason: string): TrialRecord {
  const now = new Date().toISOString()
  return {
    runID,
    taskID: task.id,
    tags: task.tags,
    trial: index,
    status: "skip",
    score: 0,
    graders: [],
    answer: { raw: "", error: "未运行" },
    metrics: emptyMetrics(),
    startedAt: now,
    finishedAt: now,
    error: reason,
  }
}

/** 按 `setup.files` 铺夹具。**不带 `.git`** —— 文章里 Anthropic 撞过 agent 翻上个 trial 的 git history。 */
async function stageFixtures(task: Task, workspace: string, repoRoot: string): Promise<void> {
  for (const entry of task.setup.files) {
    const from = path.resolve(repoRoot, entry.from)
    const to = path.resolve(workspace, entry.to)
    await mkdir(path.dirname(to), { recursive: true })
    try {
      await copyFile(from, to)
    } catch (error) {
      throw new Error(`夹具 ${entry.from} 复制失败(${(error as Error).message});题目:${task.id}`)
    }
  }
}

export async function runTrial(options: TrialOptions): Promise<TrialRecord> {
  const { task, index, runID } = options
  const startedAt = new Date().toISOString()
  const trialDir = path.join(options.runDir, "trials", task.id, String(index))
  const workspace = path.join(trialDir, "workspace")
  const repoRoot = options.repoRoot ?? findRepoRoot()

  const model = parseModelRef(options.model)
  const job: Job = {
    id: task.id,
    title: task.title,
    repo: {},
    bench: {},
    task: task.prompt,
    model: { ...model, thinking: options.thinking },
  }
  const turnFiles = turnFilesFor(workspace, job.id, task.prompt.length)

  const base = {
    runID,
    taskID: task.id,
    tags: task.tags,
    trial: index,
    model: options.model,
    workspace,
    inputFile: turnFiles.input,
    outputFile: turnFiles.output,
    startedAt,
  }

  const failed = (error: string, result?: TurnResult, transcript?: Transcript): TrialRecord => ({
    ...base,
    status: "error",
    score: 0,
    graders: [],
    answer: result ? extractLastJsonFence(result.text) : { raw: "", error: "没有产出" },
    metrics: tally(transcript, result),
    sessionID: result?.sessionID,
    sessionFile: transcript?.file,
    finishedAt: new Date().toISOString(),
    error,
  })

  let result: TurnResult
  try {
    await mkdir(workspace, { recursive: true })
    await stageFixtures(task, workspace, repoRoot)

    const input: TurnInput = {
      job,
      workspace,
      sessionsRoot: options.sessionsRoot,
      stateDir: path.join(trialDir, "state"),
      enginesDir: options.enginesDir,
      prompt: task.prompt,
      configDir: options.configDir,
      faux: options.faux,
      settleMs: options.settleMs,
      // 每 trial 的硬上限。**不是预算** —— 它防的是"事件流永不静默"把进程吊死。
      hardTimeoutMs: task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    }
    result = await runTurnInChildProcess(input, { onProgress: options.onProgress })
  } catch (error) {
    return failed(`子进程没有跑完:${(error as Error).message}`)
  }

  let transcript: Transcript
  try {
    transcript = await readTranscript(options.sessionsRoot, result.sessionID)
  } catch (error) {
    return failed(`读不到会话记录:${(error as Error).message}`, result)
  }

  const answer = extractLastJsonFence(result.text)
  const metrics = tally(transcript, result)

  // provider 一路失败到最后 / 硬超时:这一次没有"产出"可判,记 error 而不是 fail。
  if (result.stopReason) return failed(`轮次被中断:${result.stopReason}`, result, transcript)
  // 没拿到答案**而且**这一轮报过错 —— 大概率是基础设施而不是能力。只有一样时仍算 fail:
  // 报了错但答对了不该扣分,答不出来也不报错就是它自己的问题。
  if (answer.parsed === undefined && metrics.errors.length > 0) {
    return failed(`没有产出最终答案,且本轮有错误:${metrics.errors.join(";")}`, result, transcript)
  }

  const verdicts: GraderVerdict[] = task.graders.map((spec) =>
    createGrader(spec).grade({ task, result, transcript, answer }),
  )
  const passed = verdicts.filter((verdict) => verdict.pass).length

  return {
    ...base,
    status: passed === verdicts.length ? "pass" : "fail",
    score: verdicts.length ? passed / verdicts.length : 0,
    graders: verdicts,
    answer,
    metrics,
    sessionID: result.sessionID,
    sessionFile: transcript.file,
    finishedAt: new Date().toISOString(),
  }
}
