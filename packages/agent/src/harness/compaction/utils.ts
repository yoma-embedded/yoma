// M8 前置:compaction 与 branch-summarization 共用的纯函数。
// 两件事:① 从工具调用里抽"读了哪些文件/改了哪些文件"(摘要要把这些原样带过去,
// 否则压缩后模型会忘记自己动过什么);② 把消息序列化成喂给摘要模型的纯文本。
// 与 types.ts 的 FileOperations 是同一个类型(参考实现在两处各定义了一份,这里只留一份)。
/**
 * compaction(纵向压缩)与 branch-summarization(横向分支摘要)共用的**纯函数**工具箱:
 * 不做 I/O、不碰模型、不碰会话树,给什么算什么。两组共 5 个导出 ——
 * 文件操作清单(§2–§5)与对话序列化(§7)。
 *
 * 在全景链路上的位置:全景篇 §4「阶段 7 · 第 47 步」自动压缩。harness.compact() 之后:
 *   1. prepareCompaction() → extractFileOperations() 调 createFileOps / extractFileOpsFromMessage,
 *      把「这段要压掉的历史里读过/改过哪些文件」攒成累加器;
 *   2. generateSummary() 调 serializeConversation 把那段历史拍平成纯文本,
 *      包进 <conversation> 标签发给摘要模型(compaction.ts 的 generateSummary);
 *   3. compact() 收尾时调 computeFileLists / formatFileOperations,把清单当尾巴接在摘要正文后面,
 *      同一份清单还原样存进 compaction 条目的 details —— 下一次压缩靠它继承(compaction.ts 的 compact() 尾部)。
 * branch-summarization.ts 走的是同一组函数,只是触发时机换成 navigateTree(全景篇 §5.2)。
 *
 * 不存在会怎样:摘要里不再有 <read-files>/<modified-files>,连续压几次之后模型就不知道
 * 自己两小时前动过哪些文件;而没有 serializeConversation,摘要模型根本没有输入。
 *
 * 对应学习文档:docs/learn/agent/harness_compaction_utils.md
 *
 * 分节索引:
 *   §1 imports —— 三个纯类型,运行时零依赖
 *   §2 createFileOps —— 空累加器
 *   §3 extractFileOpsFromMessage —— 从 assistant 的 toolCall 里认 read/write/edit
 *   §4 computeFileLists —— read 减去 modified,两侧各自排序
 *   §5 formatFileOperations —— 拼成 <read-files>/<modified-files> 尾巴
 *   §6 序列化的三个私有件 —— 2000 字上限 / 安全 JSON / 带痕截断
 *   §7 serializeConversation —— Message[] → 摘要提示词里的纯文本
 */

// ── §1 imports:三个纯类型,运行时零依赖 ──────────────────────────────────
// Message 是 pi-ai 侧的 **LLM 边界**类型,只有 user / assistant / toolResult 三种角色
// (pi-ai 的 types.ts 里 Message 就是这三者的闭合联合)。§7 收的是它而不是 AgentMessage —— 调用方一律先过
// harness/messages.ts 的 convertToLlm() 把四个自定义角色投影掉。
import type { Message } from "@earendil-works/pi-ai";
// AgentMessage = Message ∪ 四个自定义角色(bashExecution / custom / branchSummary /
// compactionSummary,注册处在 harness/messages.ts 的 declare module)。§3 收的是这个更宽的
// 类型,因为它跑在 convertToLlm **之前**:prepareCompaction 攒的是 AgentMessage[]。
import type { AgentMessage } from "../../types.ts";
// FileOperations 定义在 harness/types.ts,三个 Set<string>。上面头注释说的
// 「参考实现在两处各定义了一份」指的就是它 —— 这里只 import,不再本地重声明一份。
import type { FileOperations } from "../types.ts";

// ── §2 createFileOps:空累加器 ────────────────────────────────────────────
/**
 * 造一个空的文件操作累加器。
 * @returns 三个空 Set(read / written / edited)。
 * 用 Set 而不是数组:同一个文件在长调试会话里会被反复读写几十次,Set 天然去重,
 * §4 才能直接排序输出。返回的对象由调用方一路 mutate —— §3 是**原地修改**、无返回值。
 */
/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

// ── §3 extractFileOpsFromMessage:从 assistant 的 toolCall 里认 read/write/edit ──
/**
 * 把一条消息里的文件操作累加进 fileOps。
 * @param message 任意 AgentMessage;只有 assistant 角色带 toolCall,其余直接返回。
 * @param fileOps §2 造的空累加器,或继承了上一次压缩清单的那个(compaction.ts 的 extractFileOperations)。
 * @returns void —— **原地修改** fileOps。
 * 失败时怎样:**永不抛、永不报错**。任何形状不认识的 block 一律 continue 跳过。
 * 这是压缩链路上的取材步骤,取不到只会让摘要少一行文件清单,不该让整次压缩失败。
 */
/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	// 只有 assistant 消息带 toolCall。user / toolResult 与四个自定义角色都没有工具调用,
	// 顺带把 bashExecution 也挡在门外 —— 模型用 bash 的 sed / cat 改的文件不进清单。
	if (message.role !== "assistant") return;
	// 类型上 AssistantMessage.content 必然是数组,这一行是**运行时**防线:消息可以是从磁盘
	// .jsonl 重放回来的(jsonl-storage 直接 JSON.parse,不做 schema 校验),老版本或被手工
	// 改过的会话文件里 content 可以是任何东西。删掉它,坏文件会让整次压缩抛在这里。
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		// 下面三条守卫是同一件事:逐层确认这个 block 真是 toolCall 形状。少一层就可能在一个
		// 不是对象的值上读属性而抛。注意 typeof null === "object",所以 null 要单独排掉。
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		// 断言而不是校验:arguments 的具体形状由各工具自己的 JSON schema 决定,内核这一层
		// 不认识任何具体工具,只能当成 Record 去摸一个字段。
		const args = block.arguments as Record<string, unknown> | undefined;
		// 模型可以发出零参数的工具调用,那时 arguments 可能是 undefined —— 类型上不该发生,
		// 但它是 provider 解析出来的值,与上面几条守卫同一个理由。
		if (!args) continue;

		// **参数字段名必须叫 path**。这是与 coding-agent 三个工具的口头约定,不是类型约束:
		// 换成 filePath / file 之类的名字,这里就静默取不到,清单少一条且没有任何提示。
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// 补充:这就是全景篇 §6.1 记的「约定优于配置」。datasheet / flash / gdb / netlist 这些
		// 嵌入式工具动过的文件一律不进清单 —— 它们的参数名和语义各不相同,内核不认。想让一个
		// 新工具被算进来,要么把它命名成 read/write/edit 且参数叫 path,要么改下面这个 switch
		// (改了要同步看 compaction.ts 的 extractFileOperations 与 branch-summarization.ts 的
		// prepareBranchEntries 两处继承逻辑)。
		// 约定优于配置:工具名叫 read/write/edit 才被识别 —— 内核不认识具体工具。
		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			// write 与 edit 分成两个集合,但 §4 立刻把它们并成同一个 modified —— 当前语义上等价,
			// 分开存只是给「新建 vs 修改」留位置。别以为摘要里能看出这两者的区别。
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

// ── §4 computeFileLists:read 减去 modified,两侧各自排序 ──────────────────
/**
 * 把累加器折算成摘要里要写的两份清单。
 * @param fileOps §3 攒好的累加器。
 * @returns readFiles = 只读过、没动过的;modifiedFiles = 写过或改过的(两者并集)。
 * 一个文件先 read 后 edit 时**只出现在 modifiedFiles**:告诉模型「这个文件你改过」比
 * 「你读过」信息量大,同时出现在两处纯属噪音,还白占摘要长度。
 */
/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// written ∪ edited = 「动过」。§3 分开累加的两个集合在这里合流 —— 这正是全景篇 §6.1 说的
	// 「继承上次清单时 modifiedFiles 被塞进 edited 而不是 written,结果仍然正确」的原因。
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	// 差集:read 里凡是也被动过的一律剔掉。sort() 用默认的 UTF-16 码元序而不是本地化排序 ——
	// 要的只是「稳定且可复现」:清单要原样进 .jsonl 的 details,顺序抖动会让每次压缩的落盘
	// 内容无谓地不同,连续压缩时还会让模型觉得文件清单变了。
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

// ── §5 formatFileOperations:拼成摘要尾巴上的两个 XML 标签 ─────────────────
/**
 * 把两份清单格式化成贴在摘要正文**后面**的一段文本。
 * @param readFiles 只读清单 / @param modifiedFiles 改动清单(都是 §4 排好序的返回值)。
 * @returns 两份都空时返回**空字符串**;否则是以 `\n\n` 开头的一段文本。
 * 调用方一律写成 `summary += formatFileOperations(...)`(compaction.ts 的 compact()、
 * branch-summarization.ts 的 generateBranchSummary),所以返回值的首尾空白就是最终摘要的排版。
 * 用 XML 风格标签而不是 markdown 列表:摘要正文本身是 markdown,标签能让下一轮的模型
 * 一眼把「元数据」和「叙述」分开。
 */
/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	// 一份清单一个块,块内一行一个路径。**不做 XML 转义** —— 路径理论上可以含 `<`,
	// 真出现时标签会被撑坏;内核在这里选了「不为极小概率付出 &lt; 噪音」,而同一个包的
	// formatSkillsForSystemPrompt 是转义的。两处纪律不一致,别以为这里也转义了。
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	// 两份都空时返回空串而不是 "\n\n":调用方是 `summary += ...`,返回换行会在摘要末尾留下
	// 两个空行,而这份摘要正文是要原样进下一轮上下文、被模型读的。
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ── §6 序列化的三个私有件:上限 / 安全 JSON / 带痕截断 ────────────────────
// 每条工具结果在序列化时最多留 2000 个字符。这是**整条压缩链路上唯一的输入预算控制**:
// prepareCompaction 把 boundaryStart(上一条 compaction 记的 firstKeptEntryId 处,首压时是 0)到切点之间的历史全部拿走(更早的原文已由上一条摘要代表,不会再进来),但这一段之内 messagesToSummarize 的条数没有上限,而工具
// 结果恰恰是长会话里最占地方的东西(一次 read 就可能是几万字符)。调大它,摘要请求本身
// 就有撞窗口的风险;调小,摘要会丢掉「工具到底看见了什么」。
// 注意它是**每条**的上限,不是总量 —— 50 条工具结果仍然可以贡献 10 万字符。
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * JSON.stringify 的不抛版本,只给 §7 拼工具参数用(不导出)。
 * @returns 正常时是 JSON 串;value 是 undefined / 函数 / symbol 时 stringify 返回 undefined,
 *          用 `?? "undefined"` 兜成字面量;循环引用或 BigInt 会抛,兜成 "[unserializable]"。
 * 为什么要这层兜底:它跑在 harness.compact() 的 try 里,抛出去会被 normalizeHarnessError
 * 包成 AgentHarnessError("compaction") —— 表现是「这次压缩失败了」,而上下文继续涨,下一轮
 * 直接撞窗口。为一个参数打印不出来赔掉整次压缩不划算。
 * 顺带:compaction.ts 里有一份**字节相同的同名副本**(那边给 estimateTokens 算字符数用),
 * 两处都不导出。改这里记得看那边。
 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/**
 * 按字符数截断,并在尾部注明砍掉了多少(不导出)。
 * @returns 未超限时**原样返回同一个字符串**;超限时返回前 maxChars 个码元 +
 *          一行 `[... N more characters truncated]`。
 * 截断必须留痕:裸截断会让摘要模型把半截输出当成完整输出,那是「自信地错」——
 * 与 harness/utils/truncate.ts 的同一条纪律(全景篇 §3「截断」一节)。
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	// length 与 slice 都按 UTF-16 码元算,不是按字符。中文一字一码元没问题,emoji / 生僻字是
	// 代理对,slice 可能从中间劈开留下一个孤立代理项 —— truncate.ts 的 truncateTail 专门处理了
	// 这件事(0xd800..0xdbff 判定 + U+FFFD 替换),这里没有。见学习文档 §5。
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

// ── §7 serializeConversation:Message[] → 摘要提示词里的纯文本 ─────────────
/**
 * 把一段 LLM 消息序列拍平成给摘要模型看的纯文本,也就是 <conversation> 标签里的全部内容。
 * @param messages 必须已经过 convertToLlm() —— 四个自定义角色在那里被投影成 user 消息,
 *                 所以本函数只需处理 user / assistant / toolResult 三种。
 * @returns 各段用空行(`\n\n`)分隔的纯文本;messages 为空或每条都被跳过时返回空字符串。
 * 三处调用:compaction.ts 的 generateSummary(历史摘要)与 generateTurnPrefixSummary
 * (split turn 的前缀摘要)、branch-summarization.ts 的 generateBranchSummary。
 * 它还是 @yoma/my-pi 的**公开导出**(agent 包 index.ts 的具名白名单,经 compaction.ts 再导出)。
 */
/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
	// 先攒段落再 join,而不是一路 += 拼串:内容为空的消息要能**整段跳过**(下面多处 `if (content)`)。
	// 用数组表达「这条不产出任何段落」比事后清理多余的分隔符干净。
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			// user 分支。content 可以是纯字符串,也可以是 (TextContent | ImageContent)[] —— pi-ai 的
			// UserMessage 两种形状都合法,所以要先归一。filter 只留 text,**图片被整个丢掉**:
			// 摘要模型未必是多模态的,而且一张 base64 图能顶掉整个提示词。代价见学习文档 §5。
			// join("") 无分隔符 —— 相邻两个 text block 会被直接粘在一起。
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			// 空字符串不产段落(纯图片的 user 消息于是彻底消失)。另外:经 convertToLlm 投影过来的
			// bashExecution / branchSummary / compactionSummary 在这里也走 user 分支 —— 摘要模型看到的
			// `[User]:` 里混着「用户的真实指令」和「上一次的压缩摘要」,它分不出来。见学习文档 §5。
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			// 三个桶,而不是按原顺序输出。一条 assistant 消息里 text / thinking / toolCall 可以交错出现,
			// 这里按**种类**重排,于是原始交错顺序丢失。对摘要来说「它想了什么、说了什么、调了什么」
			// 分三行读更清楚,代价是时序信息没了(比如「先说要读 A、再改口读 B」看不出来)。
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					// arguments 拍成 `k=json, k=json`,而不是整块 JSON.stringify —— 这样长参数(比如 write 的
					// content)在文本里仍然一眼认得出键名。注意参数值**不截断**:§6 的 2000 字上限只作用于
					// 工具结果。写一个大文件时,整份文件内容会原样进摘要提示词。
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			// 输出顺序固定 thinking → text → toolCall,与上面攒桶的先后无关。三个桶的 join 分隔符
			// 也不同:thinking / text 用换行(同一段话的多个片段),toolCall 用 `; `(并列的几次调用)。
			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			// toolResult 分支。这里**不写 toolName、也不看 isError** —— 摘要模型只看到一段
			// `[Tool result]:`,不知道它来自哪个工具、是不是一次失败;配对全靠它紧跟在上一行
			// `[Assistant tool calls]:` 后面这个位置关系。同样只留 text,图片丢弃。
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				// 全函数唯一施加长度上限的地方,见 §6。工具结果之外的一切(user 文本、assistant 文本、
				// thinking、工具参数)都不截断。
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	// 空行分段:整段文本会被包进 <conversation> 标签发出去,空行是模型区分「上一条消息结束了」
	// 的唯一线索 —— 换成单个换行就会和 text 内部的换行混淆。
	return parts.join("\n\n");
}
