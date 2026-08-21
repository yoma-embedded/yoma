// M8 的另一半:分支摘要。navigateTree 把 leaf 移到别处时,被"抛下"的那条分支
// 不会消失(树里一条不删),但它会离开投影 —— 于是先给它做一份摘要挂在新 leaf 下,
// 让模型知道"你刚才在另一条路上探索过什么"。
//
// collectEntriesForBranchSummary 的核心是求两条路径的最深公共祖先(LCA):
// 从旧 leaf 往上走到 LCA 为止的那段,就是"被放弃的分支"。
/**
 * 分支摘要:navigateTree 把 leaf 挪到树上另一处时,被"抛下"的旧分支离开投影
 * (不删除,但下一次读上下文再也看不到),这里把它收集起来、按 token 预算
 * 从最新往回裁剪,丢给模型生成一份结构化摘要,挂在新 leaf 下面。
 *
 * 在全景链路上的位置:不在"一次 prompt"的主链上,是与 compact() 并列的
 * idle-only 侧枝 —— 唯一调用方是 agent-harness.ts 的 navigateTree()。
 *
 * 对应学习文档:docs/learn/agent/harness_compaction_branch-summarization.md
 *
 * 分节索引:
 *   §1 依赖与类型定义
 *   §2 collectEntriesForBranchSummary —— 求 LCA,收集被抛下的分支
 *   §3 getMessageFromEntry —— 条目 → 消息投影(排除 toolResult)
 *   §4 prepareBranchEntries —— 预算内从最新往回填,继承文件清单
 *   §5 摘要提示词模板
 *   §6 generateBranchSummary —— 编排:估算预算、调模型、组装结果
 */
// ── §1 依赖与类型定义 ──────────────────────────────────────────────
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

// 这就是 BranchSummaryEntry.details 的具体形状(entry.type === "branch_summary"
// 时的 details 字段);下次这条分支再被摘要(嵌套 navigateTree)时,
// prepareBranchEntries 会把它当"继承来的文件清单"读回去,见 §4。
/** File-operation details stored on generated branch summary entries. */
export interface BranchSummaryDetails {
	/** Files read while exploring the summarized branch. */
	readFiles: string[];
	/** Files modified while exploring the summarized branch. */
	modifiedFiles: string[];
}

// totalTokens 是 estimateTokens 的字符启发式估算(见 compaction.ts),不是
// provider 报的真实 usage —— 这里没有"上一轮请求"可以拿真实数字,只能估。
/** Prepared branch content for summarization. */
export interface BranchPreparation {
	/** Messages selected for the branch summary. */
	messages: AgentMessage[];
	/** File operations extracted from the branch. */
	fileOps: FileOperations;
	/** Estimated token count for selected messages. */
	totalTokens: number;
}

// entries 是按时间正序(旧→新)排好的;commonAncestorId 只在 oldLeafId 本身
// 为 null 时才是 null(navigateTree 第一次被调用,没有"上一条分支"可言)——
// 只要 oldLeafId 非空,它与 targetId 必然同属一棵树,至少在根节点相遇。
/** Entries selected for branch summarization. */
export interface CollectEntriesResult {
	/** Entries to summarize in chronological order. */
	entries: SessionTreeEntry[];
	/** Deepest common ancestor between the previous leaf and target entry. */
	commonAncestorId: string | null;
}

// reserveTokens 默认 16384:与 compaction.ts 的预留语义同构(给系统提示词与
// 模型输出留够空间),但这里是硬编码默认值,不像压缩那边可配置 —— 分支摘要
// 不是常跑的路径,没必要暴露这一层旋钮。
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

// ── §2 collectEntriesForBranchSummary:求 LCA,收集被抛下的分支 ────────
/** Collect entries that should be summarized before navigating to a different session tree entry. */
export async function collectEntriesForBranchSummary(
	session: Session,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	// 没有"上一条分支"可言(navigateTree 第一次被调用,或会话刚建、还没跑过一轮):
	// 没有旧分支就没有东西要摘要,直接返回空结果,调用方不会再去请求模型。
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}
	// 最深公共祖先:目标路径从后往前,第一个也出现在旧路径里的条目。
	const oldPath = new Set((await session.getBranch(oldLeafId)).map((e) => e.id));
	const targetPath = await session.getBranch(targetId);
	let commonAncestorId: string | null = null;
	// getPathToRoot 按 root→leaf 顺序返回,所以从末尾(leaf 端)往前扫,
	// 第一个命中就是"离 target 最近"的公共节点 —— 这正是最深公共祖先。
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i]!.id)) {
			commonAncestorId = targetPath[i]!.id;
			break;
		}
	}
	const entries: SessionTreeEntry[] = [];
	let current: string | null = oldLeafId;

	// 从旧 leaf 沿 parentId 往上走,直到碰到 LCA(不含 LCA 本身)或走到根
	// (commonAncestorId 为 null 时一路收到根)—— 收集的就是"被抛下的那段"。
	while (current && current !== commonAncestorId) {
		const entry = await session.getEntry(current);
		if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
		entries.push(entry as SessionTreeEntry);
		current = entry.parentId;
	}
	// 上面的 push 顺序是"新→旧"(从 leaf 往根走),摘要与后续的 §4 都要按
	// 时间正序处理,所以这里反转成"旧→新"。
	entries.reverse();

	return { entries, commonAncestorId };
}

// ── §3 getMessageFromEntry:条目 → 消息投影(排除 toolResult)────────────
// 与 session.ts 的 sessionEntryToContextMessages 是同一种"条目不是消息,读的
// 时候才投影"的思路,但这里是分支摘要专用的窄投影:11 种条目类型里只有 4 种
// 产生消息,配置类条目(model_change / label / leaf / …)一律返回 undefined,
// 调用方(§4)据此静默跳过它们。
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

// ── §4 prepareBranchEntries:预算内从最新往回填,继承文件清单 ────────────
// tokenBudget 默认 0,配合下面 `tokenBudget > 0 &&` 的判断 —— 0 即"不设预算",
// 全部 entries 都会被塞进去(单测/无预算场景用)。
/** Prepare branch entries for summarization within an optional token budget. */
export function prepareBranchEntries(entries: SessionTreeEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;
	// 继承分支上更早的摘要条目记录过的文件清单。
	for (const entry of entries) {
		// !entry.fromHook 是关键守卫:fromHook 为 true 说明这条 branch_summary 是
		// session_before_tree 钩子塞进来的(见 agent-harness.ts:navigateTree),
		// details 形状是任意的、由钩子作者自定——不能假定它长得像
		// BranchSummaryDetails,读了就可能是垃圾数据。只有本函数自己生成的
		// (走 §6 generateBranchSummary 那条路)才敢这样强转着读。
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
			// 一旦某条(不满足上面例外)超出预算就整体收尾 —— 不会跳过它去试更早、
			// 可能更小的条目。代价:一条异常大的工具结果会提前砍掉它之前的一切,
			// 即便那些内容原本装得下;好处是保留下来的窗口始终是连续的一段时间,
			// 不会出现"中间挖空"的摘要。
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ── §5 摘要提示词模板 ──────────────────────────────────────────────
// PREAMBLE 不会发给模型——它是模型出结果*之后*拼在摘要前面的一句话,
// 说明"这是给谁看的":下一次读到这条摘要的不是这次生成它的模型,而是
// 挂在新 leaf 下、将来某一轮读上下文的模型,它需要知道这段文字的性质。
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

// 固定的六段式结构(Goal/Constraints/Progress/Key Decisions/Next Steps)是刻意
// 设计的:与 compaction.ts 里压缩摘要的提示词是两份独立的文案(不共用),
// 因为读者不同——压缩摘要要接得上"正在进行的这轮对话",分支摘要只是一段
// "旁支报告",更看重"这条分支做到哪了、下次回来接着干什么"。
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

// ── §6 generateBranchSummary:编排——估算预算、调模型、组装结果 ──────────
/** Generate a summary for abandoned branch entries. */
export async function generateBranchSummary(
	entries: SessionTreeEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const { models, model, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;
	// 128000 是"没有 contextWindow 信息时"的保守兜底(比如自定义/未知模型)。
	// tokenBudget 用 §4 的"从最新往回填"预算,不是给整个请求留的余量。
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	// 短路径:entries 里没有任何条目能投影成消息(比如 LCA 就是 oldLeafId 本身,
	// 或者中间全是被 getMessageFromEntry 过滤掉的配置类条目)。不调模型直接返回,
	// 省一次 API 调用,也避免拿空对话去问模型要"总结什么"。
	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}
	// convertToLlm 是全仓唯一的 AgentMessage → pi-ai Message 转换点(全景篇 §1
	// 的"只有一个 LLM 边界"),这里对一段挑出来的分支消息复用同一条转换路径,
	// 而不是另写一套——保证分支摘要看到的"assistant/user/tool 长什么样"与
	// 主循环发给模型的完全一致。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	// replaceInstructions 与 customInstructions 可能来自调用方(options 参数),
	// 也可能来自 navigateTree() 里 session_before_tree 钩子的返回值(见
	// agent-harness.ts:navigateTree,钩子优先)——这里只管三选一,不关心来源。
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
	// maxTokens 硬编码 2048,不像 compaction.ts 那边跟着 reserveTokens 走——
	// 分支摘要要的是"下次回来能看懂"的一段提要,不是详尽记录,故意卡死上限。
	// systemPrompt 复用 compaction.ts 的 SUMMARIZATION_SYSTEM_PROMPT(两处摘要
	// 共用同一套"你是摘要助手"系统提示词,只有 user 提示词 §5 是各自一份)。
	const response = await models.completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ signal, maxTokens: 2048 },
	);
	// 全文件只在这两处构造 BranchSummaryError,用的是 "aborted" /
	// "summarization_failed" 两种 code;类型里声明的第三种 "invalid_session"
	// 目前没有任何地方把它构造成 BranchSummaryError ——
	// §2 抛的是另一个类 SessionError(entry 找不到 / 断链),不是它。
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

	// response.content 可能混着 thinking/其它块(取决于模型是否开思考),
	// 这里只取 text 块拼起来——摘要正文不该带模型的内部推理过程。
	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	// PREAMBLE 在这里才拼上(§5 的注释),模型自己从未见过这句话。
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	// fileOps 是 §4 prepareBranchEntries 遍历这批消息时顺带抽出来的
	// (utils.ts 的 extractFileOpsFromMessage,只认 read/write/edit 三个工具名);
	// 这里把它转成 <read-files>/<modified-files> 标签追加在摘要尾部,
	// 与 compaction.ts 压缩摘要的做法完全一致,读者(下一次的模型)按同一种
	// 格式解析两种摘要。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	});
}
