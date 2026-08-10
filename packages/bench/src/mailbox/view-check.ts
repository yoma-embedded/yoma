/**
 * 浏览器侧视图模型的编译期漂移闸门。
 *
 * `@yoma-desktop/kernel` 的 mailbox-view.ts 是从本包结构化 **复制** 的(kernel 的
 * 浏览器安全入口不能 import 纯 Node 的 bench)。复制的代价是漂移,这里对冲:
 * bench 改名 / 删字段 / 改字段类型 → 对应断言立刻编译失败;新增字段是兼容的,不误报。
 *
 * 断言必须是 **约束式** `Expect<T extends true>`(details-check.ts 的教训:
 * `const _: Check = true as never` 是一个不会响的闸门)。
 *
 * 本文件只有类型,没有运行时产物。
 */

import type {
  MailboxDecisionView,
  MailboxEventView,
  MailboxHostEventView,
  MailboxInstructionView,
  MailboxRoundGitView,
  MailboxRoundResultView,
  MailboxRoundView,
  MailboxSnapshotView,
  MailboxTurnSummaryView,
  MailboxUiStateView,
  MailboxUsageView,
  MailboxVerdictView,
} from "@yoma-desktop/kernel"

import type { TurnUsage } from "../turn.ts"
import type { MailboxHostEvent, MailboxUiSnapshot, MailboxUiState } from "./host.ts"
import type {
  MailboxVerdict,
  RoundDecision,
  RoundFiles,
  RoundGit,
  RoundInstruction,
  RoundResultFile,
  RoundTurnSummary,
} from "./store.ts"

type Expect<_T extends true> = void

/** `Assignable<From, To>` 只在 From 能赋给 To 时为 true。 */
type Assignable<From, To> = [From] extends [To] ? true : false

export type Check_usage = Expect<Assignable<TurnUsage, MailboxUsageView>>
export type Check_instruction = Expect<Assignable<RoundInstruction, MailboxInstructionView>>
export type Check_turnSummary = Expect<Assignable<RoundTurnSummary, MailboxTurnSummaryView>>
export type Check_git = Expect<Assignable<RoundGit, MailboxRoundGitView>>
export type Check_result = Expect<Assignable<RoundResultFile, MailboxRoundResultView>>
export type Check_decision = Expect<Assignable<RoundDecision, MailboxDecisionView>>
export type Check_verdict = Expect<Assignable<MailboxVerdict, MailboxVerdictView>>
export type Check_round = Expect<Assignable<RoundFiles, MailboxRoundView>>
export type Check_uiState = Expect<Assignable<MailboxUiState, MailboxUiStateView>>
export type Check_snapshot = Expect<Assignable<MailboxUiSnapshot, MailboxSnapshotView>>
export type Check_hostEvent = Expect<Assignable<MailboxHostEvent, MailboxHostEventView>>

/**
 * desktop main 的 status/事件包装(mailbox-controller.ts)也照 View 的形状发。
 * 这里只能钉引擎侧的两半;controller 的形状由 desktop 自己的 typecheck 钉
 * (它同时 import 两边,不一致直接红)。
 */
export type Check_event_host = Expect<Assignable<{ type: "host"; event: MailboxHostEvent }, MailboxEventView>>
