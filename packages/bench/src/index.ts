/**
 * 无人值守调试台。
 *
 * 一句话:把 job spec 交给内核跑到底,产出分支与报告。
 *
 * 主形态是**信箱闭环** —— 两台机器、两个 agent、一个 git 仓当邮路:
 *
 * ```
 * 研发端(有代码与构建环境)  ──指令 + 附件──▶  工位端(有板子,没有代码)
 *          ▲                                          │
 *          └──────────── 观察到的现象 ─────────────────┘
 * ```
 *
 * 模块地图:
 *   job.ts         job spec 与校验(task 是心脏 —— agent 唯一的任务来源)
 *   turn.ts        一轮 agent 执行(嵌 createKernelHost,压缩/投影器/工具装配白得)
 *   turn-entry.ts  轮次的子进程入口(进程边界 = 免费且可靠的探针清理)
 *   runner.ts      轮次子进程 + 研发端工作区杂务
 *   git.ts         交付(永远开分支,绝不动主干)
 *   mailbox/       信箱闭环:协议、两侧守护、同步、话术、终报
 */

export { loadJob, parseJob, JobSpecError, resolveWorkspace } from "./job.ts"
export type { Job, JobBench, JobRepo, JobDeliver } from "./job.ts"

export { runTurn } from "./turn.ts"
export type { TurnOptions, TurnResult, TurnToolCall, TurnUsage } from "./turn.ts"

export { ensureBenchDir, ensureMyPiIgnore, runTurnInChildProcess } from "./runner.ts"
export type { TurnInput } from "./runner.ts"

export * as git from "./git.ts"

// ─── 信箱闭环(跨机器多轮:研发端决策 ↔ 工位端执行,git 仓当信箱) ────────────────
export { parseMailboxJob, loadMailboxJob } from "./mailbox/spec.ts"
export type { MailboxJob, MailboxConfig } from "./mailbox/spec.ts"
export { scanMailbox, roundDir, sumMotherTokens } from "./mailbox/store.ts"
export type {
  MailboxState,
  MailboxSnapshot,
  MailboxVerdict,
  RoundInstruction,
  RoundResultFile,
  RoundDecision,
  RoundFiles,
  DecisionKind,
} from "./mailbox/store.ts"
export { initBareMailbox, cloneMailbox, pullReset, commitPush } from "./mailbox/sync.ts"
export { initMailbox, serializeMailboxJob } from "./mailbox/init.ts"
export { runnerStep, runMailboxRunner, runnerWorkspaceFor } from "./mailbox/runner.ts"
export type { MailboxRunnerOptions, RunnerStepOutcome } from "./mailbox/runner.ts"
export { motherStep, runMailboxMother, parseMotherDecision } from "./mailbox/mother.ts"
export type { MailboxMotherOptions, MotherStepOutcome, MotherDecisionPayload } from "./mailbox/mother.ts"
export { renderMailboxReport } from "./mailbox/report.ts"
export { runSim } from "./mailbox/sim.ts"
export type { SimOptions, SimResult, SimSpawnContext } from "./mailbox/sim.ts"
export { runMailboxHost } from "./mailbox/host.ts"
export type {
  MailboxHostConfig,
  MailboxHostEvent,
  MailboxHostRole,
  MailboxUiSnapshot,
  MailboxUiState,
  EmitMailboxEvent,
} from "./mailbox/host.ts"
export { fauxResolveModels } from "./faux.ts"
export type { FauxScript, FauxMessage, FauxPart } from "./faux.ts"
