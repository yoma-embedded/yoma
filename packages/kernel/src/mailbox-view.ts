/**
 * 信箱调试台的浏览器侧视图模型 —— 从 bench 结构化 **复制**,不是 import。
 *
 * 与 types.ts 的工具 details 同一个道理:本入口必须浏览器安全,而 bench 是纯 Node 包
 * (spawn、fs、git),app 不该为了几个字段类型把它拉进 typecheck。复制的漂移由
 * bench 侧的编译期闸门对冲(packages/bench/src/mailbox/view-check.ts,约束式
 * `Expect<T extends true>`)—— bench 改名/删字段/改类型,那边立刻编译失败。
 *
 * 命名约定:一律带 View 后缀,别和 host 侧真类型混用。
 */

import type { Tokens } from "./types.ts"

export type MailboxRoleView = "runner" | "mother"

export interface MailboxSettingsView {
  remote: string
  role: MailboxRoleView
  branch?: string
  pollSeconds?: number
  /**
   * **这台机器上**的工程目录。只有研发端(mother)需要 —— 代码在它那儿。
   * 信箱里的任务书不带绝对路径(它在别人机器上没意义),这是"同一份任务书跨
   * Mac/Windows"的支点。工位端没有项目检出,留空即可。
   */
  projectDir?: string
}

export interface MailboxTaskRequestView {
  kind: MailboxRoleView | "sim" | "init"
  jobFile?: string
  fresh?: boolean
  /** init 终局后由 main 自动接起本机常驻角色(角色取已保存的配置,不由前端指定)。 */
  thenStart?: boolean
}

export interface MailboxUsageView {
  tokens: Tokens
  cost: number
}

/** 随一轮指令穿过信箱的附件(新固件等)。内容在 `rounds/NNN/artifacts/` 下。 */
export interface MailboxArtifactView {
  name: string
  bytes: number
  from?: string
}

export interface MailboxInstructionView {
  round: number
  prompt: string
  issuedBy: "init" | "mother"
  artifacts?: MailboxArtifactView[]
  at: string
}

export interface MailboxTurnSummaryView {
  text: string
  toolCounts: Record<string, number>
  toolErrors: string[]
  usage: MailboxUsageView
  stopReason?: string
  errors: string[]
  elapsedMs: number
}

export interface MailboxRoundGitView {
  baseCommit: string
  headCommit: string
  diffStat: string
  changedFiles: string[]
  commits: string[]
}

export interface MailboxRoundResultView {
  round: number
  sessionID?: string
  turn?: MailboxTurnSummaryView
  /** 本轮附件在工位机上的落点(相对它那个一次性工作目录)。 */
  incoming?: string[]
  spentTokens: number
  error?: string
  at: string
  elapsedMs: number
}

export type MailboxDecisionKindView = "continue" | "done" | "fail"

export interface MailboxDecisionView {
  round: number
  by: "mother" | "policy"
  decision: MailboxDecisionKindView
  analysis?: string
  reason?: string
  usage?: MailboxUsageView
  motherSessionID?: string
  /** 研发端为下一轮做的代码改动(它自己提交的)。 */
  git?: MailboxRoundGitView
  at: string
}

export interface MailboxVerdictView {
  outcome: "passed" | "failed" | "parked"
  reason: string
  rounds: number
  totalRunnerTokens: number
  totalMotherTokens: number
  decidedBy: "mother" | "policy"
  at: string
}

export interface MailboxRoundView {
  round: number
  instruction?: MailboxInstructionView
  result?: MailboxRoundResultView
  decision?: MailboxDecisionView
}

export type MailboxUiStateView =
  | { kind: "empty" }
  | { kind: "corrupt"; detail: string }
  /** job.json 在,一个轮次都还没有 —— 等研发端开第一轮。 */
  | { kind: "kickoff" }
  | { kind: "awaiting-runner"; round: number }
  | { kind: "awaiting-mother"; round: number }
  | { kind: "done"; verdict: MailboxVerdictView }

export interface MailboxSnapshotView {
  state: MailboxUiStateView
  job?: { id: string; title: string; directory: string }
  rounds: MailboxRoundView[]
  /** 终局后附上的 report.md 原文(截断过)。 */
  report?: string
}

/** 守护 stdout 的结构化事件。step 的 outcome 只按松散形状消费。 */
export type MailboxHostEventView =
  | { type: "hello"; role: MailboxRoleView | "sim" | "init" | "status"; pid: number }
  | { type: "progress"; message: string }
  | { type: "step"; outcome: { kind: string; detail?: string; round?: number } }
  | { type: "snapshot"; snapshot: MailboxSnapshotView }
  | { type: "child"; role: MailboxRoleView; event: MailboxHostEventView }
  | { type: "done"; exitCode: number; detail: string; verdict?: MailboxVerdictView }

export interface MailboxStatusView {
  settings?: MailboxSettingsView
  phase: "idle" | "running" | "stopping" | "done" | "error"
  task?: { kind: MailboxTaskRequestView["kind"]; startedAt: number; restarts: number; pid?: number }
  snapshot?: MailboxSnapshotView
  done?: { exitCode: number; detail: string; verdict?: MailboxVerdictView }
  message?: string
}

export type MailboxEventView = { type: "host"; event: MailboxHostEventView } | { type: "status"; status: MailboxStatusView }

export interface MailboxComposeInputView {
  /** 项目模板(<项目>/.bench/mailbox.template.json)的绝对路径。 */
  templatePath: string
  /** 任务的自然语言描述 —— 进 job.task;硬件事实与安全约束来自模板,不由描述生成。 */
  description: string
  title?: string
}
