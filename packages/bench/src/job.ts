/**
 * job spec:一个文件即一个任务。
 *
 * 校验是手写的而不是 zod —— bench 直接跑源码不打包,少一个依赖少一处 install graph 的
 * 风险;而且这里要的不只是"类型对",是**把人能犯的错在开跑前说清楚**(预算填 0、
 * 任务描述空着),错误消息要指名道姓到字段路径。
 *
 * `task` 是这份 spec 的心脏 —— 它是 agent 唯一的任务来源。通过与否由研发端 agent
 * 读工位端回填的证据来判断,没有独立的判据机制。
 *
 * 预算三个上限都有默认值,但 **maxRounds 没有无限档** —— 无界迭代是烧钱和变砖的组合。
 */

import path from "node:path"

import { readTextFile } from "./fsx.ts"

export interface JobRepo {
  /**
   * 仓库工作树所在目录 —— **研发端**的本机事实。
   *
   * 信箱模式下不该写进任务书:一份 job.json 要在两台机器上用,而出题那台机器的
   * `/Users/ben/…` 在别处不存在。研发端守护从本机配置拿工程目录
   * (`resolveWorkspace` 的 localDir)。工位端根本不需要检出。
   */
  directory?: string
  /** 工程名,给人看、也给本机配置对号入座。缺省取 job.id。 */
  name?: string
  /** 起始 ref。给了就在准备阶段 checkout,不给就用当前 HEAD。 */
  ref?: string
  /** agent 的工作分支名,默认 `agent/<jobId>`。 */
  branch?: string
}

export interface JobBench {
  /** 板卡标识,给人看、也进工位端的提示词。 */
  board?: string
  /** probe-rs 的芯片名,如 STM32G474RE。烧录与 gdb 都要,进工位端的提示词。 */
  chip?: string
  /** 探针选择器 "VID:PID" 或 "VID:PID:Serial"。多探针工位必填。 */
  probe?: string
}

export interface JobBudget {
  /** 轮数上限(一轮 = 一次指令 → 一次执行 → 一次裁决)。 */
  maxRounds: number
  /** 两侧合计的 token 上限。 */
  maxTokens: number
  wallClockMin: number
}

export interface JobDeliver {
  /** 通过后是否推分支。 */
  push?: boolean
  /** 是否建 MR/PR(需要 gh 或 glab)。 */
  mr?: boolean
  remote?: string
}

export interface Job {
  id: string
  title: string
  repo: JobRepo
  bench: JobBench
  /** 交给 agent 的任务描述:现象、复现步骤、期望行为、工位与安全约束。 */
  task: string
  budget: JobBudget
  deliver?: JobDeliver
  model?: { providerID?: string; modelID?: string }
}

export const DEFAULT_BUDGET: JobBudget = { maxRounds: 8, maxTokens: 2_000_000, wallClockMin: 90 }

export class JobSpecError extends Error {
  constructor(readonly issues: string[]) {
    super(`job spec 有 ${issues.length} 处问题:\n  - ${issues.join("\n  - ")}`)
    this.name = "JobSpecError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 解析并校验 job spec。**不** 碰文件系统 —— 路径是否存在由调用方在准备阶段查(带上下文更好报错)。 */
export function parseJob(raw: unknown): Job {
  const issues: string[] = []
  if (!isObject(raw)) throw new JobSpecError(["job 必须是一个 JSON 对象"])

  const id = str(raw.id)
  if (!id) issues.push("id 必填(用于分支名与工作目录,建议 j-<日期>-<序号>)")
  else if (!/^[A-Za-z0-9._-]+$/.test(id)) issues.push(`id "${id}" 只能含字母数字和 . _ -(它会进分支名和路径)`)

  const title = str(raw.title) ?? id ?? ""
  const task = str(raw.task)
  if (!task) issues.push("task 必填:把现象、复现步骤、期望行为讲清楚,这是 agent 唯一的任务来源")

  const repoRaw = isObject(raw.repo) ? raw.repo : undefined
  const benchRaw = isObject(raw.bench) ? raw.bench : {}

  const budgetRaw = isObject(raw.budget) ? raw.budget : {}
  const budget: JobBudget = {
    maxRounds: num(budgetRaw.maxRounds) ?? DEFAULT_BUDGET.maxRounds,
    maxTokens: num(budgetRaw.maxTokens) ?? DEFAULT_BUDGET.maxTokens,
    wallClockMin: num(budgetRaw.wallClockMin) ?? DEFAULT_BUDGET.wallClockMin,
  }
  if (budget.maxRounds < 1) issues.push("budget.maxRounds 至少为 1(无界迭代是烧钱和变砖的组合)")
  if (budget.maxTokens < 1) issues.push("budget.maxTokens 至少为 1")
  if (budget.wallClockMin < 1) issues.push("budget.wallClockMin 至少为 1")

  if (issues.length) throw new JobSpecError(issues)

  const deliverRaw = isObject(raw.deliver) ? raw.deliver : {}
  const modelRaw = isObject(raw.model) ? raw.model : undefined

  return {
    id: id!,
    title,
    repo: {
      directory: repoRaw ? str(repoRaw.directory) : undefined,
      name: str(repoRaw?.name) ?? id,
      ref: str(repoRaw?.ref),
      branch: str(repoRaw?.branch) ?? `agent/${id}`,
    },
    bench: {
      board: str(benchRaw.board),
      chip: str(benchRaw.chip),
      probe: str(benchRaw.probe),
    },
    task: task!,
    budget,
    deliver: {
      push: deliverRaw.push === true,
      mr: deliverRaw.mr === true,
      remote: str(deliverRaw.remote) ?? "origin",
    },
    model: modelRaw ? { providerID: str(modelRaw.providerID), modelID: str(modelRaw.modelID) } : undefined,
  }
}

/**
 * 定出**研发端**这台机器上的工作树。
 *
 * `localDir`(本机配置)优先于 job 里的 directory —— 这正是机器无关的支点:
 * 任务书跨机器传,路径由收件的机器说了算。两个都没有时报错,而且要说清楚该去哪配,
 * 否则用户看到的是后面某个 git 命令在 `undefined` 目录里失败。
 */
export function resolveWorkspace(job: Job, localDir?: string): string {
  const directory = localDir?.trim() || job.repo.directory
  if (!directory) {
    throw new JobSpecError([
      `这台机器上没有配 ${job.repo.name ?? job.id} 的工程目录 —— 信箱里的任务书不带绝对路径(它在别人机器上没意义)。` +
        `在本机的调试台设置里填"工程目录"`,
    ])
  }
  return path.resolve(directory)
}

export async function loadJob(file: string): Promise<Job> {
  const raw = await readTextFile(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new JobSpecError([`${file} 不是合法 JSON:${(error as Error).message}`])
  }
  return parseJob(parsed)
}
