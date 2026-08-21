// M8 核心:上下文压缩。**纯函数管线**,没有任何自动触发 ——
//   shouldCompact(要不要压) → prepareCompaction(切在哪、要摘要什么) → compact(调模型出摘要)
// 三段各自可测;失败发生在落盘之前,所以"摘要生成炸了"不会留下半截历史。
//
// 记住咒语:**压缩改的是投影,不是历史**。本文件只产出一条 compaction 条目的数据,
// 原始条目一条不删 —— buildContext 看到 compaction 条目后才把它之前的条目从投影里隐去。
//
// 全文最值得琢磨的是 findCutPoint:切点只能落在"用户可见消息"上,绝不落在 toolResult 前面,
// 否则 provider 会收到孤儿工具结果(example/03 的痛点 2)。
/**
 * 上下文压缩(compaction)的**全部算法**都在这个文件里:token 怎么估、什么时候该压、
 * 从哪里下刀、拿什么提示词让模型写摘要。它是纯函数 + 一次(或两次)模型调用,
 * 不碰磁盘、不碰相位机、不做任何自动触发 —— 谁来调、什么时候调,是 harness 与宿主的事。
 *
 * 名词(第一次出现先解释):
 * - **compaction(压缩)**:上下文快撑满模型窗口时,把靠前的一段对话交给模型写成一份
 *   结构化摘要,后续请求只带「摘要 + 最近这一段原文」。
 * - **投影(projection)**:会话是一棵只追加、永不删改的条目树;压缩只往树上追加一条
 *   compaction 条目,`buildSessionContext` 读的时候才把摘要之前的条目**隐去**。
 *   磁盘上的 .jsonl 一个字节都没少 —— 这就是「压缩改的是投影,不是历史」。
 * - **切点(cut point)**:被保留的原文从哪一条条目开始。`firstKeptEntryId` 记的就是它。
 * - **split turn(切在轮中间)**:切点没落在 user 消息上,说明一轮对话被拦腰截断,
 *   这一轮的前半段要单独再摘要一次。
 *
 * 在全景链路上的位置(docs/learn/00-内核全景.md §4):
 *   步骤 47「自动压缩」—— 宿主 kernel/src/host/compaction.ts 用本文件的
 *   estimateContextTokens + shouldCompact 判断要不要压 → harness.compact()
 *   (agent-harness.ts:1291,AgentHarness.compact)调本文件的 prepareCompaction → compact →
 *   **成功之后才** session.appendCompaction 落盘;
 *   步骤 48「下一次 buildContext 生效」—— session/session.ts 的
 *   defaultContextEntryTransform 看到新条目,把它之前的历史从投影里隐去。
 *
 * 对应学习文档:docs/learn/agent/harness_compaction_compaction.md
 *
 * 分节索引:
 *   §1  文件头与依赖
 *   §2  文件清单继承与条目 → 消息
 *   §3  结果类型与默认设置
 *   §4  token 估算三件套(权威 usage + 尾部估算)
 *   §5  阈值判断 shouldCompact
 *   §6  单条消息的字符启发式 estimateTokens
 *   §7  切点搜索:合法切点 / 轮起点 / findCutPoint
 *   §8  三份摘要提示词
 *   §9  generateSummary:一次模型调用
 *   §10 prepareCompaction:切在哪、要摘要什么
 *   §11 轮前缀提示词与再导出
 *   §12 compact:一次或两次模型调用,拼出最终摘要
 *   §13 generateTurnPrefixSummary:split turn 的第二次调用
 */

// ── §1 文件头与依赖 ──────────────────────────────────────────
// 只从 pi-ai 拿类型不拿实现;本文件唯一的副作用是 models.completeSimple 那一次网络调用。
import type { AssistantMessage, ImageContent, Model, Models, TextContent, Usage } from "@earendil-works/pi-ai";
// AgentMessage = pi-ai 的三角色 ∪ 本仓在 harness/messages.ts 里注册的四种自定义角色
// (bashExecution / custom / branchSummary / compactionSummary)。只 import 类型也会触发
// declare module 合并,所以下面 estimateTokens 的 switch 必须把七种 role 全覆盖。
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
// convertToLlm 是 LLM 边界投影:自定义角色在这里被折成 user 消息。摘要模型看到的是
// 一段**文本**,不是一段带工具调用的真对话 —— 它因此不会顺手接着去调工具。
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
// 只用来算 tokensBefore:要的是「压之前这次上下文有多大」,也就是**投影之后**的消息。
import { buildSessionContext } from "../session/session.ts";
// CompactionPreparation / CompactionSettings / FileOperations 都定义在 harness/types.ts,
// 本文件不重复定义(参考实现曾在两处各留一份,这里只认一份)。
import type {
	CompactionEntry,
	CompactionPreparation,
	CompactionSettings,
	FileOperations,
	Result,
	SessionTreeEntry,
} from "../types.ts";
import { CompactionError, err, ok } from "../types.ts";
// 与 branch-summarization.ts 共用的纯函数:文件操作抽取 + 对话序列化。
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

// ── §2 文件清单继承与条目 → 消息 ────────────────────────────
// 这一节全是给 §10 prepareCompaction 打下手的:把「压掉的这段里读过 / 改过哪些文件」
// 攒起来,以及把会话条目还原成能喂给摘要模型的 AgentMessage。

// 这个形状会被原样写进 compaction 条目的 details 字段,**下一次**压缩再读回来继承。
// 改字段名 = 老会话的清单继承静默失效(读到 undefined,Array.isArray 判假,直接跳过)。
/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}

/**
 * JSON.stringify 遇到循环引用会抛,遇到 undefined / 函数会返回 undefined。
 * 这里只是为了**量字符数**,所以宁可给个占位串,也不能让一次估算把整轮压缩带崩。
 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

// 上一次压缩记录的文件清单要继承过来,否则连续压缩会逐渐"忘记"更早动过的文件。
/**
 * 把「这段历史里读过 / 改过哪些文件」攒成一个累加器。
 * @param messages 本次要摘要的消息(只有 assistant 的 toolCall 会被识别)
 * @param entries 完整路径条目,只用来回读上一条 compaction 的 details
 * @param prevCompactionIndex 上一条 compaction 在 entries 里的下标,-1 表示没有
 * @returns read / written / edited 三个 Set。不会失败,也不会抛。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionTreeEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	// -1 = 本会话第一次压缩,没有可继承的清单。
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		// fromHook 的摘要是应用层塞进来的,details 是任意形状 —— 不能假定它有 readFiles/modifiedFiles。
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			// details 来自磁盘上的老会话文件,类型是断言来的,运行时必须自己验形状。
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			// 注意去向:上一次的 modifiedFiles 统一并进 edited 桶。computeFileLists 最后会把
			// edited ∪ written 合成 modifiedFiles,所以并到哪个桶不影响最终清单。
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	// 先继承、后叠加本次的。都是 Set,顺序其实无所谓,这样写只是更像「累加」。
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

/**
 * 会话条目 → AgentMessage。条目树里除 message 之外还有三种能变成消息的类型,
 * 各自用 messages.ts 的构造器还原(与 session.ts 的 sessionEntryToContextMessages 同源)。
 * 配置类条目(model_change / thinking_level_change / label / leaf …)返回 undefined,
 * 也就是「不进摘要输入」—— 它们本来就不是对话内容。
 */
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content as string | (TextContent | ImageContent)[],
			entry.display,
			entry.details,
			entry.timestamp,
		);
	}
	// 分支摘要要留:模型需要知道「你在另一条路上探索过什么」。
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	// 这一支在本文件里**不可达** —— 唯一的调用方是下面的 …ForCompaction,它先把 compaction
	// 拦掉了。留着是为了这个函数本身完整(branch-summarization.ts 有一份同名的姊妹实现)。
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

// 压缩自己的输入里不能再包含旧的 compaction 摘要消息(它走 previousSummary 通道)。
/**
 * 压缩输入专用的包装:**旧的 compaction 摘要消息不进本次摘要输入**。
 * 理由是它走 previousSummary 通道(§9 会因此换成 UPDATE 提示词,让模型「更新」而不是
 * 「重写」)。两条路都带一遍等于让模型看见同一份摘要两次,更容易把它当成对话内容复述出来。
 */
function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

// ── §3 结果类型与默认设置 ────────────────────────────────────

// 这三个必填字段就是 harness 落盘时写进 compaction 条目的全部内容:
// session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)。
/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

// 三个数的来历:
// - reserveTokens 16384 —— 留给「摘要本身 + 下一轮回答」的余量,阈值就是
//   contextWindow - 16384(§5)。它同时是摘要输出预算的基数(§9 取 0.8,§13 取 0.5)。
// - keepRecentTokens 20000 —— 切点从最新往回累到这个数才停(§7),保证压完之后模型
//   手里还有足够近的**原文**,而不是只剩一份摘要。
// - enabled —— 只影响 shouldCompact 的返回值;prepareCompaction / compact 不看它
//   (手动 /compact 应该无视自动压缩的开关)。
// 宿主 kernel/src/host/compaction.ts 与 coding-agent/src/acp/agent.ts 都直接用这一份常量,
// 所以改这里等于同时改桌面端和 Zed。
/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ── §4 token 估算三件套(权威 usage + 尾部估算)──────────────
// 三件套:calculateContextTokens(权威)/ estimateTokens(启发式,§6)/
// estimateContextTokens(混合)。为什么要混:provider 报的 usage 是唯一算得准的数
// (它看得见系统提示词、工具 schema、缓存写入),但它只覆盖到「最后一条 assistant 消息」为止。

// totalTokens 为 0 / 缺失时才回落到四项相加 —— 有的 provider 不填 totalTokens。
// cacheRead + cacheWrite 必须算进去:它们同样占窗口,漏掉会系统性低估。
/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 取一条消息上「可信的」usage。三重过滤,缺一不可:
 * 1. stopReason 是 aborted / error 的那次请求根本没走完,报的数字不可信;
 * 2. usage 字段可能压根不存在(自定义角色的消息、老会话);
 * 3. 算出来必须 > 0 —— 流式中断留下的半截消息 usage 常常全是 0。
 * 缺了这层过滤,一次网络失败就会让整段估算塌回 0,于是本该压缩的会话一路撑到撞窗口。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

// 倒着扫:要的是「最近一次可信的窗口占用」,不是历史上最大的那次。
/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

// lastUsageIndex 是给**宿主**用的信号位:它 === null 说明这个会话还没有任何真实 usage,
// 宿主的 Guard 1(host/compaction.ts)据此「不猜、不压」,否则新会话一开口就先被压一次。
/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

/**
 * 与 getLastAssistantUsage 的唯一区别:连下标一起返回。
 * 因为「usage 之后又新增了哪些消息」需要下标才切得出来。
 */
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]!);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

// 返回值 tokens = usageTokens + trailingTokens;lastUsageIndex === null 表示全靠估算。
// 这个函数不失败也不抛:上下文估算在任何路径上都必须给得出一个数,不然宿主没法决策。
/**
 * Estimate context tokens for messages using provider usage when available.
 *
 * provider 报的 usage 是权威值,但它只覆盖到"最后一条 assistant 消息"为止;
 * 之后新增的消息(工具结果、下一条 user)只能用字符启发式估算,两者相加才是当前上下文。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	// 一条可信 usage 都没有(全新会话 / 全是失败轮次):整段只能靠字符估算。
	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	// 权威值只覆盖到 usageInfo.index 这条 assistant 消息为止。
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	// 它之后新增的(工具结果、下一条 user、还没报 usage 的半截 assistant)只能逐条估。
	// 从 index + 1 开始:index 那条本身已经被 usage 算进去了,再估一次就是重复计费。
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]!);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

// ── §5 阈值判断 shouldCompact ───────────────────────────────

// 唯一的阈值判断,一行公式:contextTokens > contextWindow - reserveTokens。
// 严格大于:恰好等于阈值时不压。
// 它**不认识** contextWindow 为 0 / undefined 的情况 —— 那会让阈值变成负数,于是任何
// 会话都「超阈值」。挡这一发的 guard 在宿主(host/compaction.ts 的 no_context_window
// 分支),不在这里。
/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ── §6 单条消息的字符启发式 estimateTokens ─────────────────
// 全套估算的底座。粗糙是有意的:它只在「没有权威 usage」时兜底,以及给 §7 的切点搜索
// 当尺子 —— 那里要的是相对大小,不是绝对精度。

// 图片按固定 4800 字符 ≈ 1200 token 记账。真实值随分辨率变(几十到几千),这里取一个
// 偏大的常数:估多了最多早压一次,估少了会撞窗口。
const ESTIMATED_IMAGE_CHARS = 4800;

/** 数 content 数组的字符:text 按长度,image 按常数,其余块型(如 toolCall)不计。 */
function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

// 「保守」指的是分母:chars / 4 是英文的经验值,中文一个字往往就要 0.6~1 token,
// 于是中文会话会被**低估**,压得偏晚。这也是 reserveTokens 留到 16384 的原因之一。
/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	// 按 role 分派。七种 role 一个都不能少:漏一种就静默返回 0,那条消息在预算里等于不存在。
	switch (message.role) {
		case "user": {
			// user 的 content 可能是裸字符串,也可能是块数组;这个 cast 是为了同时吃下两种。
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			// assistant 只有三种块型算数:text / thinking / toolCall(名字 + 参数 JSON)。
			// 工具的**返回**是另一条 toolResult 消息,不在这里。
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					// 参数可能带不可序列化的值,所以走 safeJsonStringify 而不是裸 JSON.stringify。
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		// 工具结果里的图片(截图、datasheet 配图)靠 ESTIMATED_IMAGE_CHARS 记账;
		// 少了这一支,一次带图的工具返回会被估成几乎零成本。
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		// 命令本身也要算:长 pipeline 加上输出,一条 bashExecution 就能顶几千 token。
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	// 未知 role(老会话、别的应用注册的自定义角色)记 0 —— 宁可低估也不要抛。
	// 删掉这一行,TypeScript 的穷举检查一旦被绕过就会返回 undefined,预算算式直接变 NaN。
	return 0;
}

// ── §7 切点搜索:合法切点 / 轮起点 / findCutPoint ────────────
// 全文最值得琢磨的一节。要回答的问题只有一个:**从哪一条条目开始保留原文**。
// 合法切点 = 用户可见的消息条目。**toolResult 被显式排除** —— 切在它前面就会
// 让上一条 assistant 的 toolCall 失去应答,provider 直接拒收。
/**
 * 列出 [startIndex, endIndex) 区间里所有**合法切点**的下标。
 * 合法 = 用户可见的消息条目:user / assistant / bashExecution / custom / branchSummary /
 * compactionSummary 六种 role,外加 branch_summary、custom_message 两种条目类型。
 * 写成穷举 switch 而不是「排除 toolResult」是故意的:新增条目类型时 TypeScript 会在这里
 * 报缺分支,逼你想清楚它算不算切点。
 */
function findValidCutPoints(entries: SessionTreeEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i]!;
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					// 这一支的空 break 就是整个函数存在的理由。切在 toolResult 前面 = 上一条 assistant 的
					// toolCall 失去应答,provider 收到孤儿工具结果直接拒收整个请求。别「顺手」把它并进上面。
					case "toolResult":
						break;
				}
				break;
			}
			// 配置类条目本身不是切点;但 findCutPoint 会把切点往前拽过它们,
			// 好让「换模型 / 换思考档位」这些声明留在被保留的一侧。
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
			case "leaf":
				break;
		}
		// 补一刀:上面的 switch 对这两种条目类型走的是空 break,真正的 push 在这里。
		// 分成两处写没有语义理由,是历史;要合并的话小心别把 message 分支的 role 判断丢了。
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

// 「轮(turn)」的起点 = 一条 user 消息,或 bashExecution / branch_summary / custom_message
// 这类同样由用户侧发起的条目。往回找它是为了在 split turn 时把 [轮起点, 切点) 单独摘要,
// 让被保留的后半段不至于「不知道自己在回答什么问题」。
// 找不到返回 -1,调用方据此判定「其实没被切开」。
/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i]!;
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		// assistant / toolResult 都不算轮起点:它们是这一轮的**回应**,不是发起。
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

// isSplitTurn 与 turnStartIndex 是一对:turnStartIndex === -1 时 isSplitTurn 必为 false。
/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

// 四步:① 列出所有合法切点 → ② 从最新往回累加 token 直到攒够 keepRecentTokens →
// ③ 取该位置**之后**的第一个合法切点 → ④ 把切点往前拽过配置类条目。
// startIndex / endIndex 圈定 [start, end):上一次压缩之前的历史不参与。
// keepRecentTokens 是「想保留多少最近的原文」(默认 20000)。
/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionTreeEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	// 一个合法切点都没有(整段只有 toolResult / 配置条目):退回 startIndex,也就是
	// 「几乎什么都不压」。宁可不压,也不能切出孤儿工具结果。
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	// 兜底切点取**最早**的那个合法位置。下面的累加循环一次都没攒够 keepRecentTokens 时
	// (整段总量还不到预算)就用它,含义是「这一段整个都该保留」。
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]!;

	// 从最新往回累加,直到攒够 keepRecentTokens,再取该位置之后的第一个合法切点。
	// 只有 message 条目参与累加(下一行的 continue),于是 branch_summary / custom_message
	// 的体量对这个预算是**不可见**的 —— 它们能当切点,却不占额度。
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		// 攒够了:i 是「最近这一段」的起点。往后找第一个 >= i 的合法切点 —— 只能往后不能往前,
		// 否则就会切在 toolResult 上。代价是实际保留量通常略少于预算,所以 JSDoc 写的是
		// approximately。所有合法切点都比 i 早时不改 cutIndex,保持上面的兜底值。
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c]! >= i) {
					cutIndex = cutPoints[c]!;
					break;
				}
			}
			break;
		}
	}
	// 往前拽的收益:让 model_change / thinking_level_change / label 这些**声明**落在被保留
	// 的一侧(它们不产生消息,换模型的状态本来也由 deriveSessionContextState 扫完整路径推导)。
	// 但判的是「既不是 message、也不是 compaction」,所以 branch_summary / custom_message /
	// custom 这三种**会**投影成消息的条目同样会被拽过 —— 它们只是从「被摘要」挪到「按原文
	// 保留」,内容不丢。遇到 message 就停:再往前一步就可能停在 toolResult 上(孤儿工具结果);
	// 遇到 compaction 也停:上一条摘要条目是本次区间的左边界,越过去没有意义。
	// **副作用值得记住**:拽完之后 cutEntry 很可能不再是 user 消息,于是下面 isUserMessage
	// 判假、走 split-turn 分支 —— 一个本来干净的轮边界会被当成「切在轮中间」,用错提示词
	// (把一整轮完整对话当成「某轮的前缀」去摘要);详见学习文档 §5 第 1 条。
	// 把切点往前拽过配置类条目(model_change 等),让它们留在被保留的一侧。
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1]!;
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	// 只有「切点恰好是一条 user 消息」才算干净的轮边界。
	const cutEntry = entries[cutIndex]!;
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	// 切点不是 user 消息 = 切在了一轮的中间,该轮的前缀要单独摘要一次。
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ── §8 三份摘要提示词 ──────────────────────────────────────
// 三份:系统提示词(禁止续写对话)、首次摘要、更新式摘要。第四份(轮前缀)在 §11。
// **模板字符串内部一律不能插注释** —— 那会改变发给模型的字节。

// 两句 Do NOT 是防「摘要模型把对话接着往下演」:输入里全是对话,不明确禁止的话,
// 模型很容易直接去回答里面最后那个问题,于是你拿到的不是摘要而是一段续写。
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// 首次摘要的提示词。固定六段式(Goal / Constraints & Preferences / Progress / Key Decisions /
// Next Steps / Critical Context)不是为了好看:下一次压缩要在**同一套小节**上做增量更新
// (见下面的 UPDATE 版),格式漂了就没法「更新」,只能重写。
// 结尾那句 Preserve exact file paths, function names, and error messages 是硬要求 ——
// 压缩最常见的损失就是把路径和符号名摘成了「那个文件」。
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// 更新式提示词:输入是「新消息 + <previous-summary>」,要求 PRESERVE 既有信息、把
// In Progress 挪进 Done。连续压缩靠它对抗逐次遗忘 —— 每次都重新总结的话,第三次压缩时
// 模型看到的「历史」只剩一份摘要的摘要。
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// ── §9 generateSummary:一次模型调用 ──────────────────────

// 参数多但都必要:models + model 是往哪发,reserveTokens 定输出预算,signal 给中断,
// customInstructions 是用户 /compact 后面跟的那句话,previousSummary 决定用哪份提示词,
// thinkingLevel 只对 reasoning 模型有意义。
// 失败**不抛**:返回 Result,错误码只有 aborted / summarization_failed 两种。
/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<string, CompactionError>> {
	// 输出预算 = reserveTokens 的 80%,再被模型自己的 maxTokens 钳住。留 20% 是给「摘要
	// 之后还要接着说话」的余量;model.maxTokens 为 0(未知)时用 Infinity 让 Math.min 退化
	// 成只看前者 —— 写成 0 的话预算就是 0,一个字都出不来。
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	// 已有摘要时用"更新"提示词而不是重新总结 —— 连续压缩才不会丢失更早的信息。
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	// 用户的额外要求**追加**在提示词末尾而不是替换:上面那套格式约定必须保住。
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	// 先投影到 LLM 边界(自定义角色 → user 消息),再压成纯文本。摘要模型看到的是一段文本,
	// 里面的工具调用只是 name(args) 的字面描述,不会触发它去接着调工具。
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);
	// <conversation> / <previous-summary> 两个标签是给模型划边界的。顺序固定:先对话、
	// 再旧摘要、最后才是指令 —— 指令放最后离生成位置最近,最不容易被长对话淹掉。
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	// 整段塞进**一条 user 消息**:摘要是一次性的无状态调用,不需要多轮结构。
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// reasoning 只在「模型支持 && 档位不是 off」时才带。带给不支持的模型会被 provider 拒;
	// off 档必须把这个字段整个摘掉,不能传 off 这个字符串(pi-ai 的语义,见 CLAUDE.md)。
	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };

	// completeSimple 走 pi-ai 的统一简单接口。它**不会 reject** —— 连 provider 解析失败都会
	// 被编码成一条 stopReason 为 error 的 assistant 消息(ai/src/api/lazy.ts 的 lazyStream),
	// 所以下面靠 stopReason 分流,而不是 try / catch。
	const response = await models.completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
	);
	// aborted 与 error 分成两个错误码:调用方(harness / 宿主)要能区分「用户按了停止」和
	// 「摘要真的失败了」—— 前者不该在 transcript 里报错。
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	// 只取 text 块。reasoning 模型会先吐 thinking 块,那是它的草稿,不进摘要正文。
	// 注意这里**不校验空串**:模型返回零个 text 块时会得到一份空摘要,而调用方照样落盘。
	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return ok(textContent);
}

// ── §10 prepareCompaction:切在哪、要摘要什么 ────────────────
// 纯函数、不调模型、不落盘。它的产物 CompactionPreparation 会先交给 harness 的
// session_before_compact hook,hook 可以取消压缩,也可以直接给一份现成摘要。

// 返回 ok(undefined) 表示「没什么可压的」,这不是错误 —— 调用方(harness)据此抛
// 「Nothing to compact」,而不是报故障。
/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	// 两种「没得压」:空会话;以及**最后一条就是 compaction**(刚压完,还没说过话)。
	// 后者是防连续压缩空转的第一道闸;宿主那边还有一道基于时间戳的 Guard 2。
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1]!.type === "compaction") {
		return ok(undefined);
	}

	// 只压缩"上一次压缩之后"的区间 —— 更早的历史已经被上一条摘要代表了。
	let prevCompactionIndex = -1;
	// 倒着找最近的一条 compaction。只认**最后一条** —— 与 session.ts 的
	// defaultContextEntryTransform 保持同一条规则,两边不一致会让区间对不上。
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i]!.type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	// 有上一条压缩:区间左边界不是「上一条 compaction 的位置」,而是它记的 firstKeptEntryId
	// —— 那才是当前投影里真正带着原文的第一条条目。
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		// findIndex 扫的是整条路径。firstKeptEntryId 通常在 prevCompactionIndex **之前**,这不
		// 矛盾:投影 = [摘要, firstKept..compaction 之间, compaction 之后的一切]。
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		// 找不到(条目属于另一条分支、或 fork 时丢了):退回 compaction 之后一位。这是静默降级,
		// 代价是 [firstKept, compaction) 那段原文这次不会被重新摘要。
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	// 右边界永远是路径末尾:最新的消息也要参与「往回累加」的预算计算。
	const boundaryEnd = pathEntries.length;

	// tokensBefore 用的是 buildSessionContext 之后的**投影**消息,含义是「压之前这次上下文
	// 有多大」,不是「这个会话历史一共多大」。它只作展示 / 记账,不参与任何判断。
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	// 切点搜索(§7)。传的是 keepRecentTokens 而不是 reserveTokens:两个数管的是不同的事 ——
	// 一个是保留多少原文,一个是留多少输出余量。
	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	// 没有 id 的条目来自更早的会话格式。这里硬失败而不是猜一个:压缩的效果完全由
	// firstKeptEntryId 兑现,猜错等于把一段历史静默丢掉。
	if (!firstKeptEntry?.id) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}
	const firstKeptEntryId = firstKeptEntry.id;

	// 历史区间的右端:split turn 时收到轮起点(那一轮的前缀单独摘要),否则就是切点本身。
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	// 条目 → 消息;返回 undefined 的(配置类条目、旧 compaction)自然被跳过。
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]!);
		if (msg) messagesToSummarize.push(msg);
	}
	// 非 split 时这个数组保持为空,compact() 据此走单次调用分支。
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]!);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	// 文件清单:先按历史消息攒(顺带继承上一条压缩的 details)……
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	// ……再把轮前缀里的工具调用补进去。少了这一步,被切走的那半轮里改过的文件会从清单里消失。
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	// 返回的全是**数据**,没有任何副作用。真正的落盘发生在 harness 拿到 compact() 的结果之后。
	return ok({
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

// ── §11 轮前缀提示词与再导出 ────────────────────────────────

// 轮前缀专用提示词:三段式,比历史摘要短得多。它的读者是「被保留下来的后半轮」,只需要
// 交代「这一轮原本要干什么、前半段干了什么」,不需要完整的 Progress / Next Steps。
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// 再导出 serializeConversation:实现在 ./utils.ts,但 index.ts 的具名白名单是从**本文件**
// 导出它的。删掉这一行,包根的 serializeConversation 就没了。
export { serializeConversation } from "./utils.ts";

// ── §12 compact:一次或两次模型调用,拼出最终摘要 ─────────────

// 管线的第三段,也是唯一会发网络请求的一段。它**不落盘、不改会话树** —— 返回的
// CompactionResult 由 harness 决定要不要写进树(agent-harness.ts:compact)。
// 于是「摘要生成炸了」不会留下半截历史,这正是三段式拆分的全部意义。
/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<any>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<CompactionResult, CompactionError>> {
	// preparation 是 §10 的产物,原样解构。注意 settings 也在里面 —— 输出预算要用它,
	// 而 compact() 的签名里并没有 settings 参数。
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// 再验一次 firstKeptEntryId:preparation 可能来自 hook 或调用方手搓,不能只信 §10 验过。
	if (!firstKeptEntryId) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}

	let summary: string;

	// 切点落在轮中间时要 **两次** 模型调用:历史摘要 + 该轮前缀摘要。
	// 条件里的 turnPrefixMessages.length > 0 是必要的:少了它,isSplitTurn 为真而前缀为空的
	// 情形(轮起点恰好等于切点)会走进两次调用,第二次等于拿一段空对话去问模型。
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// 历史为空时不发请求,直接给一句占位文本 —— 省一次调用,也省一份「空对话摘要」。
		// 注意:下面 else 分支的单次调用**没有**这个短路,messagesToSummarize 为空时照发不误。
		const historyResult =
			messagesToSummarize.length > 0
				? await generateSummary(
						messagesToSummarize,
						models,
						model,
						settings.reserveTokens,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
					)
				: ok<string, CompactionError>("No prior history.");
		// 任一段失败就整体失败:宁可这次不压,也不要留下一份只讲了一半的摘要。
		if (!historyResult.ok) return err(historyResult.error);
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			models,
			model,
			settings.reserveTokens,
			signal,
			thinkingLevel,
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		// 两段用 --- 和一个显式小标题拼起来,让后续读到这份摘要的模型知道:下面这段讲的是
		// 「我正在进行的这一轮」的前半截,而不是更早的历史。
		summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
	} else {
		const summaryResult = await generateSummary(
			messagesToSummarize,
			models,
			model,
			settings.reserveTokens,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value;
	}

	// 文件清单落在摘要**正文之后**,以 <read-files> / <modified-files> 标签形态附加
	// (utils.ts 的 formatFileOperations)。既给模型看,也给下一次压缩继承。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	// details 原样进 compaction 条目;下一次压缩的 extractFileOperations 会把它读回来。
	// 字段名必须与 CompactionDetails 一致,否则继承静默失效(读到 undefined 就跳过)。
	return ok({
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}

// ── §13 generateTurnPrefixSummary:split turn 的第二次调用 ──

/**
 * 轮前缀摘要。与 §9 的 generateSummary 有意保持三处不同:
 * 1. 预算是 reserveTokens 的 **0.5**(不是 0.8)—— 它只是给保留下来的后半轮做铺垫;
 * 2. 没有 previousSummary / customInstructions 通道 —— 前缀摘要不参与「更新式」链条;
 * 3. 用 TURN_PREFIX_SUMMARIZATION_PROMPT。
 * 系统提示词与错误码复用同一套,只有错误文案加了 Turn prefix 前缀方便定位。
 * 不导出:调用方只有 compact() 一个。
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<string, CompactionError>> {
	// 0.5 而不是 0.8:同一次压缩里这已经是第二次调用,两份摘要加起来才该占满 reserveTokens。
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	// 与 §9 同样的序列化路径,只是少了 <previous-summary> 那一段。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// 与 §9 唯一的写法差异:options 直接写在调用参数里,没有中间变量。行为完全一致。
	const response = await models.completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal },
	);
	// 错误文案带 Turn prefix 前缀 —— 两次调用的错误码相同,不加前缀就没法从日志里分辨
	// 是历史摘要炸了还是前缀摘要炸了。
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	// 同样只取 text 块,同样不校验空串。
	return ok(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n"),
	);
}
