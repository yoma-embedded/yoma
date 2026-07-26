// Core Agent
export * from "./agent.ts";
// Loop functions
export * from "./agent-loop.ts";
// Types
export * from "./types.ts";

// Harness / proxy — remaining commented modules are still empty stubs.
// Re-enable when those modules are implemented.
export * from "./harness/agent-harness.ts";
// 只导出具名清单:compaction 模块内部还定义了与 harness/types.ts 同名的类型,
// 用 export * 会产生歧义星号导出。
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
export {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
// export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/jsonl-storage.ts";
// export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/memory-storage.ts";
export * from "./harness/session/repo-utils.ts";
export * from "./harness/session/session.ts";
export { uuidv7 } from "./harness/session/uuid.ts";
export * from "./harness/skills.ts";
// export * from "./harness/system-prompt.ts";
export * from "./harness/types.ts";
// export * from "./harness/utils/shell-output.ts";
// export * from "./harness/utils/truncate.ts";
// export * from "./proxy.ts";
