/**
 * agent 评测。
 *
 * 一句话:题(task)× 若干次(trial)交给**真的那个 agent** 跑,判分器(grader)只看
 * 产出与证据,汇总成 pass@1 / pass@k / pass^k 三个数和一张指标表。
 *
 * 术语抄 Anthropic 的《Demystifying evals for AI agents》:task / trial / grader /
 * transcript / outcome。执行核心复用 bench(`runTurnInChildProcess` → `turn-entry.ts`),
 * 所以投影器、自动压缩、工具装配、会话落盘与桌面端和调试台是同一套 —— 评的就是用户用的
 * 那个 agent,而不是一条评测专用的执行链。
 *
 * 模块地图:
 *   task.ts        题的 spec 与校验(手写,错误指名字段;id 必须等于目录名)
 *   answer.ts      最终答案的提取与归一化(只认最后一个 ```json 围栏)
 *   session.ts     会话 JSONL → transcript(工具的**输出**只在这儿)
 *   graders/       四个判分器 + 注册表(加类型不改 runner)
 *   faux-synth.ts  selftest 的两份剧本:参考解必须过,已知坏解必须不过
 *   trial.ts       一次 trial(一进程,四态判定)
 *   run.ts         task × k、requires 门控、并发池、逐条追加 results.jsonl
 *   report.ts      pass@1 / pass@k / pass^k 与指标表
 */

export {
  parseTask,
  loadTask,
  loadTasks,
  matchesFilter,
  TaskSpecError,
  DEFAULT_TASK_TIMEOUT_MS,
  ENV_KINDS,
  REQUIRE_KINDS,
} from "./task.ts"
export type { Task, TaskSetup, TaskSetupFile, TaskReference, TaskFaux, EnvKind, RequireKind } from "./task.ts"

export {
  extractLastJsonFence,
  readAnswerField,
  normalizeText,
  normalizeScalar,
  normalizeList,
  answerEquals,
  answerOneOf,
  answerMatches,
  describeAnswer,
} from "./answer.ts"
export type { AnswerExtraction } from "./answer.ts"

export { readTranscript, parseTranscript, findSessionFile } from "./session.ts"
export type { Transcript, TranscriptToolCall, ToolCallStatus } from "./session.ts"

export { createGrader, validateGraderSpec, GRADER_TYPES, needlesFromReference } from "./graders/index.ts"
export type {
  Grader,
  GraderContext,
  GraderSpec,
  GraderVerdict,
  AnswerGraderSpec,
  GroundedGraderSpec,
  ToolCalledGraderSpec,
  ToolForbiddenGraderSpec,
} from "./graders/index.ts"

export { synthesizeFaux, wrongAnswer, answerFence } from "./faux-synth.ts"
export type { SynthesizedFaux } from "./faux-synth.ts"

export { runTrial, skippedTrial, parseModelRef, turnFilesFor, emptyMetrics, zeroTokens } from "./trial.ts"
export type { TrialRecord, TrialOptions, TrialMetrics, TrialStatus } from "./trial.ts"

export { runEvals, runSelftest, unmetRequirement, runStamp, gitSha, summarize, DEFAULT_CONCURRENCY } from "./run.ts"
export type { RunMeta, RunOptions, RunOutcome, SelftestOptions, SelftestOutcome, SelftestCase } from "./run.ts"

export {
  renderReport,
  renderRunReport,
  readResults,
  readRunMeta,
  aggregateTasks,
  aggregateTags,
  passStats,
  averages,
  RESULTS_FILE,
  RUN_FILE,
  SUMMARY_FILE,
} from "./report.ts"
export type { TaskAggregate, TagAggregate, PassStats, Averages } from "./report.ts"

export { findRepoRoot, defaultTasksDir } from "./repo.ts"
