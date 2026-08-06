/**
 * job spec:一个文件即一个任务。
 *
 * 校验是手写的而不是 zod —— bench 直接跑源码不打包,少一个依赖少一处 install graph 的
 * 风险;而且这里要的不只是"类型对",是**把人能犯的错在开跑前说清楚**(判据写错、
 * 预算填 0、板卡漏了 chip),错误消息要指名道姓到字段路径。
 *
 * 设计要点:
 * - `success.checks` 是这份 spec 的心脏。runner 只认自己跑出来的检查结果,
 *   agent 说"修好了"不算数(见 grader.ts)。没有 checks 的 job 不允许跑 ——
 *   那等于让模型给自己判卷。
 * - `bench.knownGoodElf` 在 unattended 策略下必填:失败要能回刷,否则板子留在
 *   半烧状态,下一个任务开局就是坏的。
 * - 预算三个上限都有默认值,但 **maxIterations 没有无限档** —— 无界迭代是烧钱和
 *   变砖的组合。
 */

export interface JobRepo {
  /** 仓库工作树所在目录(P0 用已检出的目录;P2 起支持 url 由工位机自 clone)。 */
  directory: string
  /** 起始 ref。给了就在准备阶段 checkout,不给就用当前 HEAD。 */
  ref?: string
  /** agent 的工作分支名,默认 `agent/<jobId>`。 */
  branch?: string
}

export interface JobBench {
  /** 板卡标识,只用于报告与工位匹配。 */
  board?: string
  /** probe-rs 的芯片名,如 STM32G474RE。flash/log 都要。 */
  chip?: string
  /** 探针选择器 "VID:PID" 或 "VID:PID:Serial"。多探针工位必填。 */
  probe?: string
  /** 已知能跑的固件(相对仓库根)。失败或超预算时回刷它。 */
  knownGoodElf?: string
  /** 本任务产出的 ELF(相对仓库根),log 判据要用它找 RTT 控制块。 */
  elf?: string
}

export type JobCheck =
  | { type: "build"; command: string; timeoutS?: number }
  | { type: "bash"; command: string; timeoutS?: number; expectExitCode?: number }
  | { type: "log_wait"; pattern: string; timeoutS?: number; source?: JobLogSource }
  | { type: "log_absent"; pattern: string; windowS?: number; source?: JobLogSource }

/** 日志来源。rtt 走 probe-rs attach(要 chip+elf);command 是任意 argv(串口等)。 */
export type JobLogSource = { kind: "rtt" } | { kind: "command"; command: string }

export interface JobSuccess {
  /** 每轮判据之前先跑的构建命令。非零退出直接判失败,不进后面的检查。 */
  build?: string
  buildTimeoutS?: number
  checks: JobCheck[]
  /** 全部检查连续通过几次才算成功。竞态类 bug 设 3 即 pass^3。parseJob 保证有值(缺省 1)。 */
  repeat: number
}

export interface JobBudget {
  maxIterations: number
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
  /** 交给 agent 的任务描述:现象、复现步骤、期望行为。 */
  task: string
  success: JobSuccess
  budget: JobBudget
  /** 权限策略档位。见 policy.ts。 */
  policy: PolicyName
  /** 追加放行的 bash 命令前缀(策略白名单之外的项目特有命令)。 */
  allowCommands?: string[]
  /** 永远不许 agent 碰的路径 glob(bootloader、ota 等)。 */
  protectedPaths?: string[]
  /** 单次改动超过这么多行就升级给人。 */
  maxDiffLines?: number
  deliver?: JobDeliver
  model?: { providerID?: string; modelID?: string }
}

export type PolicyName = "unattended" | "supervised" | "readonly"

export const POLICY_NAMES: readonly PolicyName[] = ["unattended", "supervised", "readonly"]

export const DEFAULT_BUDGET: JobBudget = { maxIterations: 8, maxTokens: 2_000_000, wallClockMin: 90 }

/** 判据默认超时:构建慢、日志等待短。 */
export const DEFAULT_BUILD_TIMEOUT_S = 600
export const DEFAULT_CHECK_TIMEOUT_S = 120
export const DEFAULT_LOG_WINDOW_S = 30

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

/** 解析并校验 job spec。**不** 碰文件系统 —— 路径是否存在由 runner 在准备阶段查(带上下文更好报错)。 */
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
  const directory = repoRaw ? str(repoRaw.directory) : undefined
  if (!directory) issues.push("repo.directory 必填(仓库工作树所在目录)")

  const benchRaw = isObject(raw.bench) ? raw.bench : {}
  const bench: JobBench = {
    board: str(benchRaw.board),
    chip: str(benchRaw.chip),
    probe: str(benchRaw.probe),
    knownGoodElf: str(benchRaw.knownGoodElf),
    elf: str(benchRaw.elf),
  }

  const policyRaw = str(raw.policy) ?? "supervised"
  if (!POLICY_NAMES.includes(policyRaw as PolicyName)) {
    issues.push(`policy "${policyRaw}" 不认识,可选:${POLICY_NAMES.join(" / ")}`)
  }
  const policy = policyRaw as PolicyName

  const successRaw = isObject(raw.success) ? raw.success : undefined
  if (!successRaw) issues.push("success 必填 —— 没有判据的任务等于让模型给自己判卷")
  const checksRaw = Array.isArray(successRaw?.checks) ? successRaw.checks : []
  const checks: JobCheck[] = []
  for (const [index, item] of checksRaw.entries()) {
    const at = `success.checks[${index}]`
    if (!isObject(item)) {
      issues.push(`${at} 必须是对象`)
      continue
    }
    const type = str(item.type)
    switch (type) {
      case "build":
      case "bash": {
        const command = str(item.command)
        if (!command) issues.push(`${at}.command 必填`)
        else
          checks.push({
            type,
            command,
            timeoutS: num(item.timeoutS),
            ...(type === "bash" ? { expectExitCode: num(item.expectExitCode) } : {}),
          } as JobCheck)
        break
      }
      case "log_wait":
      case "log_absent": {
        const pattern = str(item.pattern)
        if (!pattern) issues.push(`${at}.pattern 必填(正则)`)
        else if (!safeRegex(pattern)) issues.push(`${at}.pattern 不是合法正则:${pattern}`)
        else {
          const source = parseLogSource(item.source, at, issues)
          if (source.kind === "rtt" && !bench.chip) {
            issues.push(`${at} 用 RTT 采集,但 bench.chip 没填 —— probe-rs attach 要芯片名`)
          }
          checks.push(
            type === "log_wait"
              ? { type, pattern, timeoutS: num(item.timeoutS), source }
              : { type, pattern, windowS: num(item.windowS), source },
          )
        }
        break
      }
      default:
        issues.push(`${at}.type "${type ?? ""}" 不认识,可选:build / bash / log_wait / log_absent`)
    }
  }
  if (successRaw && checks.length === 0 && issues.length === 0) {
    issues.push("success.checks 至少要有一条 —— runner 只认自己跑出来的判据")
  }

  const repeat = num(successRaw?.repeat) ?? 1
  if (repeat < 1) issues.push("success.repeat 至少为 1")

  const budgetRaw = isObject(raw.budget) ? raw.budget : {}
  const budget: JobBudget = {
    maxIterations: num(budgetRaw.maxIterations) ?? DEFAULT_BUDGET.maxIterations,
    maxTokens: num(budgetRaw.maxTokens) ?? DEFAULT_BUDGET.maxTokens,
    wallClockMin: num(budgetRaw.wallClockMin) ?? DEFAULT_BUDGET.wallClockMin,
  }
  if (budget.maxIterations < 1) issues.push("budget.maxIterations 至少为 1(无界迭代是烧钱和变砖的组合)")
  if (budget.maxTokens < 1) issues.push("budget.maxTokens 至少为 1")
  if (budget.wallClockMin < 1) issues.push("budget.wallClockMin 至少为 1")

  // unattended 的额外硬要求:会烧板子就必须有回滚路径。
  // 判据是 bench.chip 而不是 policy 本身 —— 没有芯片就不会烧录,也就没有半烧状态要收拾
  // (纯软件任务、只跑单测的任务都属于这一类,不该被逼着编一个 ELF 路径出来)。
  if (policy === "unattended" && bench.chip && !bench.knownGoodElf) {
    issues.push("无人值守跑硬件任务(bench.chip 已声明)时 bench.knownGoodElf 必填 —— 失败要能自动回刷,否则板子留在半烧状态")
  }

  if (issues.length) throw new JobSpecError(issues)

  const deliverRaw = isObject(raw.deliver) ? raw.deliver : {}
  const modelRaw = isObject(raw.model) ? raw.model : undefined

  return {
    id: id!,
    title,
    repo: {
      directory: directory!,
      ref: str(repoRaw?.ref),
      branch: str(repoRaw?.branch) ?? `agent/${id}`,
    },
    bench,
    task: task!,
    success: {
      build: str(successRaw?.build),
      buildTimeoutS: num(successRaw?.buildTimeoutS),
      checks,
      repeat,
    },
    budget,
    policy,
    allowCommands: strList(raw.allowCommands),
    protectedPaths: strList(raw.protectedPaths),
    maxDiffLines: num(raw.maxDiffLines),
    deliver: {
      push: deliverRaw.push === true,
      mr: deliverRaw.mr === true,
      remote: str(deliverRaw.remote) ?? "origin",
    },
    model: modelRaw ? { providerID: str(modelRaw.providerID), modelID: str(modelRaw.modelID) } : undefined,
  }
}

function parseLogSource(raw: unknown, at: string, issues: string[]): JobLogSource {
  if (raw === undefined) return { kind: "rtt" }
  if (!isObject(raw)) {
    issues.push(`${at}.source 必须是对象`)
    return { kind: "rtt" }
  }
  const kind = str(raw.kind) ?? "rtt"
  if (kind === "rtt") return { kind: "rtt" }
  if (kind === "command") {
    const command = str(raw.command)
    if (!command) {
      issues.push(`${at}.source.command 必填(kind 为 command 时)`)
      return { kind: "rtt" }
    }
    return { kind: "command", command }
  }
  issues.push(`${at}.source.kind "${kind}" 不认识,可选:rtt / command`)
  return { kind: "rtt" }
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
  return out.length ? out : undefined
}

function safeRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

export async function loadJob(file: string): Promise<Job> {
  const raw = await Bun.file(file).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new JobSpecError([`${file} 不是合法 JSON:${(error as Error).message}`])
  }
  return parseJob(parsed)
}
