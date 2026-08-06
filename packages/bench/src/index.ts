/**
 * 无人值守调试台。
 *
 * 一句话:把 job spec 交给内核跑到底,**判据由 runner 亲自验**,产出分支与报告。
 *
 * ```
 * prepare ─→ (agent 轮 ─→ grade)* ─→ commit ─→ report ─→ push/MR
 *                 ↑            │
 *                 └── 证据回填 ─┘
 * ```
 *
 * 模块地图:
 *   job.ts      job spec 与校验(判据是必填项 —— 没有判据等于让模型自己判卷)
 *   policy.ts   每任务权限策略(allow/deny/escalate,判不出来一律 escalate)
 *   turn.ts     一轮 agent 执行(嵌 createKernelHost,权限门/压缩/投影器白得)
 *   turn-entry.ts  轮次的子进程入口(进程边界 = 免费且可靠的探针清理)
 *   grader.ts   判据执行(runner 自己起采集,不复用 agent 写的日志)
 *   runner.ts   迭代状态机与预算强制
 *   report.ts   给研发看的报告(证据与"agent 自述"分开摆)
 *   git.ts      交付(永远开分支,绝不动主干)
 */

export { loadJob, parseJob, JobSpecError, POLICY_NAMES, DEFAULT_BUDGET } from "./job.ts"
export type { Job, JobCheck, JobBudget, JobBench, JobLogSource, PolicyName } from "./job.ts"

export { createPolicy, createPolicyDecider, matchGlob, matchProtected } from "./policy.ts"
export type { ExplainedDecision, PolicyContext } from "./policy.ts"

export { runTurn } from "./turn.ts"
export type { TurnOptions, TurnResult, TurnToolCall, TurnUsage } from "./turn.ts"

export { grade, gradeRepeated, runCommandReal, captureLogReal, splitArgv } from "./grader.ts"
export type { CheckResult, CheckOutcome, GradeResult, GradeOptions, RunCommand, CaptureLog } from "./grader.ts"

export { runJob } from "./runner.ts"
export type { RunnerOptions, RunnerResult, Iteration, JobOutcome, TurnInput } from "./runner.ts"

export { renderReport, mrTitle } from "./report.ts"
export type { ReportInput } from "./report.ts"

export { firstPrompt, retryPrompt, blockedPrompt, describeChecks } from "./prompts.ts"

export * as git from "./git.ts"
