// M8 的另一半:分支摘要。navigateTree 把 leaf 移到别处时,被"抛下"的那条分支
// 不会消失(树里一条不删),但它会离开投影 —— 于是先给它做一份摘要挂在新 leaf 下,
// 让模型知道"你刚才在另一条路上探索过什么"。
//
// collectEntriesForBranchSummary 的核心是求两条路径的最深公共祖先(LCA):
// 从旧 leaf 往上走到 LCA 为止的那段,就是"被放弃的分支"。
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { Session } from "../session/session.ts";
import type { BranchSummaryResult, FileOperations, Result, SessionTreeEntry } from "../types.ts";
import { BranchSummaryError, err, ok, SessionError } from "../types.ts";
import { estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated branch summary entries. */
export interface BranchSummaryDetails {
	/** Files read while exploring the summarized branch. */
	readFiles: string[];
	/** Files modified while exploring the summarized branch. */
	modifiedFiles: string[];
}

/** Prepared branch content for summarization. */
export interface BranchPreparation {
	/** Messages selected for the branch summary. */
	messages: AgentMessage[];
	/** File operations extracted from the branch. */
	fileOps: FileOperations;
	/** Estimated token count for selected messages. */
	totalTokens: number;
}

/** Entries selected for branch summarization. */
export interface CollectEntriesResult {
	/** Entries to summarize in chronological order. */
	entries: SessionTreeEntry[];
	/** Deepest common ancestor between the previous leaf and target entry. */
	commonAncestorId: string | null;
}

/** Options for generating a branch summary. */
export interface GenerateBranchSummaryOptions {
	/** Provider collection the summarization request goes through; owns auth resolution. */
	models: Models;
	/** Model used for summarization. */
	model: Model<any>;
	/** Abort signal for the summarization request. */
	signal: AbortSignal;
	/** Optional instructions appended to or replacing the default prompt. */
	customInstructions?: string;
	/** Replace the default prompt with custom instructions instead of appending them. */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt and model output. Defaults to 16384. */
	reserveTokens?: number;
}

/** Collect entries that should be summarized before navigating to a different session tree entry. */
export async function collectEntriesForBranchSummary(
	session: Session,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}
	// 最深公共祖先:目标路径从后往前,第一个也出现在旧路径里的条目。
	const oldPath = new Set((await session.getBranch(oldLeafId)).map((e) => e.id));
	const targetPath = await session.getBranch(targetId);
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i]!.id)) {
			commonAncestorId = targetPath[i]!.id;
			break;
		}
	}
	const entries: SessionTreeEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = await session.getEntry(current);
		if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
		entries.push(entry as SessionTreeEntry);
		current = entry.parentId;
	}
	entries.reverse();

	return { entries, commonAncestorId };
}

function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 分支摘要不带 toolResult:它只在配对的 toolCall 旁边才有意义。
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "thinking_level_change":
		case "model_change":
		case "active_tools_change":
		case "custom":
		case "label":
		case "session_info":
		case "leaf":
			return undefined;
	}
}

/** Prepare branch entries for summarization within an optional token budget. */
export function prepareBranchEntries(entries: SessionTreeEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;
	// 继承分支上更早的摘要条目记录过的文件清单。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}
	// 从最新往回填,预算耗尽即停 —— 越近的内容越值得带进摘要。
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要类条目信息密度高,预算还剩一成时破例带上。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate a summary for abandoned branch entries. */
export async function generateBranchSummary(
	entries: SessionTreeEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const { models, model, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];
	const response = await models.completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ signal, maxTokens: 2048 },
	);
	if (response.stopReason === "aborted") {
		return err(new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new BranchSummaryError(
				"summarization_failed",
				`Branch summary failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	});
}
