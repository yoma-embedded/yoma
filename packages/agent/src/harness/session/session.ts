// Step 3:Session 门面 + buildContext 投影 —— M5 的智力核心。
// 两遍独立扫描:
//   遍 1 deriveSessionContextState:扫"完整"路径推导配置状态(model/thinking/activeTools)
//        —— 被压缩掉区域里的 model_change 依然生效;
//   遍 2 buildContextEntries → sessionEntryToContextMessages:应用最后一个 compaction
//        条目做投影(firstKeptEntryId 之前的条目消失,换成摘要),再把条目映射成消息。
// 记住:压缩改的是投影,不是历史。
/**
 * 会话树(session tree)的门面 + 上下文投影(context projection)。
 *
 * 三个名词先摆平,后面反复出现:
 * - **条目 entry**:会话不是一个消息数组,而是一棵只追加、永不删改的树;每个节点叫一条
 *   条目,统一带 {type, id, parentId, timestamp}。换模型、压缩、打标签都是往树上追加条目。
 * - **leaf**:树上唯一的游标,指向「当前对话」的末端。当前对话 = 从 leaf 沿 parentId 走到根。
 * - **投影 projection**:把这条路径上的条目「算」成一份能发给模型的 AgentMessage[]。算的时候
 *   可以隐去、重排、合成消息,但磁盘上的条目一个字节都不动 —— 这就是「压缩改的是投影,不是历史」。
 *
 * 在全景链路上的位置(全景篇《00-内核全景.md》):
 * - 读侧 = §4 阶段 1 的步骤 3a–3d。harness 每开一轮先 createTurnState()(agent-harness.ts:569),
 *   它的第一件事就是 session.buildContext(),拿到的 messages 就是本轮发给模型的全部历史。
 * - 写侧 = §1 分层图的第 ⑫ 跳。轮内所有落盘最终都落到本文件的 append* 上。
 * - 本文件不碰文件系统:读写全部委托给 SessionStorage 接口,所以同一套树语义在内存实现
 *   (memory-storage.ts)与 JSONL 实现(jsonl-storage.ts)上完全一致 —— 测试就是同一份用例
 *   参数化跑两遍存储(test/harness/session.test.ts)。
 *
 * 对应学习文档:docs/learn/agent/harness_session_session.md
 *
 * 分节索引:
 *   §1  文件头与导入
 *   §2  投影的三个可扩展点(变换 / 投影器 / 选项)
 *   §3  遍 1:deriveSessionContextState —— 扫完整路径推导配置状态
 *   §4  遍 2 第一步:defaultContextEntryTransform —— 压缩投影的兑现处
 *   §5  遍 2 第二步:buildContextEntries —— 默认变换 + 应用层变换链
 *   §6  遍 2 第三步:sessionEntryToContextMessages —— 条目 → 消息
 *   §7  buildSessionContext —— 两遍合流
 *   §8  Session 类:字段、构造与只读读取
 *   §9  实例侧上下文构建与选项合并
 *   §10 标签与会话名
 *   §11 追加即前进:appendTypedEntry 与九个 append*
 *   §12 moveTo —— 移动 leaf 与分支摘要
 */

// ── §1 文件头与导入 ──────────────────────────────────────────────────
// 值导入只有四个:messages.ts 的三个「合成消息」构造器 + SessionError。其余全是 type-only ——
// 这个文件对消息内部结构几乎无知,只负责在正确的位置调用正确的构造器。
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionInfoEntry,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

// ── §2 投影的三个可扩展点(变换 / 投影器 / 选项)──────────────────────
/**
 * 条目变换(entry transform):收一串条目、返回另一串条目。应用层用它在默认压缩投影**之后**
 * 再插一手(隐藏某类条目、做裁剪),而不必 fork 这个文件。
 * 入参与返回都是 readonly:变换必须产出新数组,不许原地改 storage 手上的那一份。
 */
export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];

/**
 * custom 条目的投影器(projector)。custom 条目默认**不进**模型上下文(见 §6),应用层注册一个
 * 同名 customType 的投影器,才把它翻译成消息。
 * 三个参数:条目本身、它在**投影后**列表里的下标、以及投影后的整串条目 —— 下标和数组都是
 * 变换链跑完之后的那一份,不是磁盘上的原始路径。
 */
export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;

/** buildContext 系列的可选项。两个字段都是「往默认行为上加」,没有关掉默认行为的开关。 */
export interface SessionContextBuildOptions {
	/** Additional entry transforms applied after the default compaction transform. */
	entryTransforms?: readonly ContextEntryTransform[];
	// custom_message 条目自带内容、默认就进上下文;custom 条目只是结构化数据,默认不进。
	// 名字只差一个词、语义相反,下面这行英文注释就是那条分界线。
	/** Optional custom-entry projectors. Custom entries are omitted from model context by default. */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

// ── §3 遍 1:deriveSessionContextState —— 扫完整路径推导配置状态 ───────
/**
 * 从**未经压缩投影**的完整路径里推导三样会话级配置:thinkingLevel / model / activeToolNames。
 * 规则就是顺序扫一遍、后写覆盖先写,拿到的是「路径末端时刻」的配置。
 *
 * 为什么必须扫完整路径而不是投影后的路径:被压缩隐去的那一段里可能有 model_change,那次换模型
 * 在语义上依然有效。这就是本文件顶部说的「两遍独立扫描」的全部理由 —— 遍 1 吃原始路径,
 * 遍 2 吃投影后的条目。
 *
 * 返回 Omit<SessionContext, "messages">:messages 由遍 2 负责,两遍在 §7 合流。
 */
function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
	// 默认 "off" = 「这条路径上从没出现过 thinking_level_change 条目」。要留意 "off" 在下游不是
	// 「低一档」而是**把 reasoning 参数整个从请求里摘掉**(agent-harness.ts 的 :729),所以对推理
	// 模型来说,没人设过档位 = 思考功能默认关闭。harness 构造期另有一份同值默认(:378)。
	let thinkingLevel = "off";
	// null 与「某个模型」是两种不同的答案:null = 这条路径上从没出现过模型信息,恢复会话的宿主
	// 据此回退到自己的默认模型(coding-agent/src/acp/agent.ts:380)。
	let model: { provider: string; modelId: string } | null = null;
	// 同理 null = 从没设过工具白名单,与空数组(「一个工具都不给」)不是一回事。
	let activeToolNames: string[] | null = null;

	// 顺序扫描、后写覆盖先写。没写成倒着扫 + 提前 break,是因为三个字段各自要取「最后一次」,
	// 倒着扫得给每个字段单独记一个「已定」标志,不划算 —— 路径长度是几百量级,扫一遍很便宜。
	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// 助手消息自带 provider/model,所以哪怕这条路径上一条 model_change 都没有(老会话、或者模型是
			// 构造 harness 时定的),也能从历史里反推出上次用的是谁。它与上面的 model_change 写同一个变量:
			// 谁在**路径上更靠后**谁说了算,与这里 else-if 的书写顺序无关。
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			// 拷一份再存:条目对象在内存存储里就是 storage 缓存里的那一个,直接把它的数组引用交出去,
			// 调用方随手一改就等于改写了历史。这个文件的出入口都守同一条纪律。
			activeToolNames = [...entry.activeToolNames];
		}
	}

	// 只回配置三件套。messages 不在这里算 —— 它要经过压缩投影,是遍 2 的事。
	return { thinkingLevel, model, activeToolNames };
}

// ── §4 遍 2 第一步:defaultContextEntryTransform —— 压缩投影 ───────────
/**
 * 把「最后一次压缩」落到投影上,结果 = [压缩摘要条目, firstKeptEntryId..压缩点之间的条目,
 * 压缩点之后的一切]。对应全景篇 §4 步骤 3c。
 *
 * 这是「压缩只改投影、不改历史」的**唯一兑现处**:appendCompaction 只往树上追加了一条
 * {summary, firstKeptEntryId, tokensBefore},真正「变短」发生在这里、发生在读的时候。
 * 删掉这个函数,压缩就完全失效 —— 条目照样在树上,上下文却一点都不会变短。
 *
 * 无论走哪条分支都返回**新数组**,不与传入的 pathEntries 共享。
 */
export function defaultContextEntryTransform(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	// 取路径上**最后一个** compaction:循环不 break,一路覆盖。多次压缩时只有最后一次定义投影;
	// 而被它保留下来的区间里若还有更早的 compaction 条目,那些会照常投影成摘要消息 —— 于是上下文里
	// 可能同时出现好几条压缩摘要。这是设计不是 bug。
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}
	// 从没压缩过:原样浅拷贝返回。拷贝而不是直接返回入参,是为了让两条分支的返回值可变性一致
	// (调用方 §5 拿到的永远是一个可以自由处置的数组)。
	if (!compaction) {
		return [...pathEntries];
	}

	// 投影 = [compaction 条目, firstKeptEntryId..compaction 之间的条目, compaction 之后的一切]
	// 摘要排在**最前面**。压缩条目在时间上是最晚追加的,投影却把它挪到队首 —— 因为发给模型的历史
	// 必须是「先读摘要、再读保留下来的近期对话」,顺序反了模型会以为摘要是最新进展。
	const entries: SessionTreeEntry[] = [compaction];
	// 用 id 再找一次下标,而不是在上面那个循环里顺手记下来:多一次遍历换取「找最后一个」和「定位」
	// 两件事互不纠缠。id 在一个会话内唯一,所以 findIndex 找到的必然就是那一条。
	const compactionIdx = pathEntries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	let foundFirstKept = false;
	// 收集区间 [firstKeptEntryId, compactionIdx):含 firstKeptEntryId 自己,不含 compaction 条目
	// (它已经在数组头上了)。firstKeptEntryId 由压缩算法挑出,语义是「从这条起原文保留」。
	for (let i = 0; i < compactionIdx; i++) {
		const entry = pathEntries[i]!;
		// 【坑】firstKeptEntryId 若不在压缩点之前的这段路径上(它属于另一条分支、或跨 fork 丢了),
		// foundFirstKept 就永远是 false,压缩点之前的条目会被**整段静默丢弃**,上下文里只剩一条摘要。
		// 没有告警、没有兜底,全景篇 §6 把它列成了会咬人的地方之一。
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) entries.push(entry);
	}
	// 压缩点之后的一切原样保留 —— 那些是压缩之后才发生的对话,谁也没资格动它们。
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
}

// ── §5 遍 2 第二步:buildContextEntries —— 变换链 ──────────────────────
/**
 * 条目级投影的总入口:先跑默认的压缩变换,再依次跑应用层注册的变换。
 * 返回的仍然是**条目**列表而不是消息列表 —— 想看「这一轮到底带了哪些条目进上下文」就调它;
 * 要消息则走 §7 的 buildSessionContext。
 */
export function buildContextEntries(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionTreeEntry[] {
	// 默认变换永远第一个跑,这是契约的一部分:应用层变换看到的第一条条目通常就是那条 compaction。
	// test/harness/session.test.ts 的 "applies context entry transforms after default compaction
	// selection" 用例专门断言了这个顺序。
	let entries = defaultContextEntryTransform(pathEntries);
	// 变换按注册顺序串联,前一个的输出是后一个的输入。?? [] 让「没配变换」和「配了空数组」同解。
	for (const transform of options.entryTransforms ?? []) {
		// 每一步都摊成新的可变数组:变换的返回类型是 readonly,不摊开就赋不回 entries;顺带也挡住了
		// 「某个变换偷懒返回了传进去的那个数组、后面被别人改掉」这类别扭的耦合。
		entries = [...transform(entries)];
	}
	return entries;
}

// ── §6 遍 2 第三步:sessionEntryToContextMessages —— 条目 → 消息 ───────
/**
 * 把**一条**条目翻译成 0..N 条 AgentMessage,对应全景篇 §4 步骤 3d。
 * 四类条目产出消息、custom 一类要看有没有投影器、其余产出空数组 —— 所以「条目列表」与
 * 「消息列表」从来不是一一对应的。
 *
 * index / entries 两个参数本函数自己一个都不用,纯粹是转交给 custom 投影器(见 §2)。
 */
export function sessionEntryToContextMessages(
	entry: SessionTreeEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	// message 条目直出,零加工。这里的 as 是历史遗留的冗余断言 —— MessageEntry.message 的声明类型
	// 本来就是 AgentMessage(harness/types.ts 与本文件 import 的是同一个 src/types.ts)。
	if (entry.type === "message") {
		return [entry.message as AgentMessage];
	}
	// custom_message = 应用自定义的一条**真消息**:有内容、能显示、默认进上下文
	// (messages.ts 的 convertToLlm 把 role:"custom" 原样翻成一条 user 消息)。
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				// 同样是冗余断言:CustomMessageEntry.content 的声明类型就是这个联合。
				entry.content as string | (TextContent | ImageContent)[],
				// display 只决定 UI 画不画它,**不影响它进不进模型上下文** —— convertToLlm 根本不看这个字段。
				entry.display,
				entry.details,
				// 用条目自己的时间戳而不是 new Date():重放同一个会话必须逐字节复现,宿主投影器铸消息 id
				// 用的正是(消息序号, 时间戳)这一对,时间一漂 id 就不稳。
				entry.timestamp,
			),
		];
	}
	// compaction 条目 → 一条 compactionSummary 角色的合成消息(真正发给模型时由 convertToLlm 包上
	// 前后缀变成 user 消息)。tokensBefore 只随消息带给 UI 展示,不参与任何计算、也不进模型。
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	// 【坑】summary 为空字符串时这个条件不成立,函数一路落到末尾的 return []:条目仍在
	// buildContextEntries() 的返回列表里,却不产出任何消息。这是「条目数 ≠ 消息数」最容易踩的一处。
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	// custom 条目装的是应用自定义的**结构化数据**(customType + data),本身不是消息。默认行为因此
	// 与上面的 custom_message 正好相反 —— 下面这行原作者的注释说的就是这件事。
	if (entry.type === "custom") {
		// custom 条目默认不进模型上下文,除非应用注册了对应 customType 的 projector。
		// 三个 ?. 连着:没配 entryProjectors、没注册这个 customType、投影器返回 undefined,三种情况都
		// 折叠成「不产出消息」。外面再摊成新数组,是把投影器返回的 readonly 收窄成可变。
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	// 兜底:配置类与元数据类条目(model_change / thinking_level_change / active_tools_change /
	// label / session_info,以及理论上不会出现在路径里的 leaf)都在这里归零 —— 它们携带的信息
	// 已经被 §3 那一遍吸收进 SessionContext 的配置字段,再变成消息就是重复。
	return []; // 配置类条目(model_change 等)不产生消息
}

// ── §7 buildSessionContext —— 两遍合流 ────────────────────────────────
/**
 * 自由函数版的 buildContext:给一条路径,产出完整的 SessionContext。
 * 做成自由函数(而不是只挂在 Session 上)是有调用方的:compaction.ts:831 直接拿一段 pathEntries
 * 调它来算 tokensBefore —— 那一刻它手上只有条目数组,没有 Session 实例。
 */
export function buildSessionContext(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	// 【看清入参】state 吃的是 pathEntries(**完整**路径),messages 吃的是 contextEntries(**投影后**)。
	// 两者写反的话,被压缩掉那段里的 model_change 就会丢,症状是「恢复老会话时模型莫名其妙变了」。
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	// flatMap:一条条目可以产 0 条(配置类)、1 条(常见)或多条(自定义投影器)消息。
	// 传给每条条目的 entries / index 都是投影后那一份,与磁盘上的原始下标无关。
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}

// ── §8 Session 类:字段、构造与只读读取 ───────────────────────────────
/**
 * 会话树的门面(facade):对上给 harness / 宿主一组语义清晰的方法,对下只依赖 SessionStorage
 * 一个接口。全景篇 §1 分层图里的第 ③ 跳(读)与第 ⑫ 跳(写)都是它。
 *
 * 它自己**不缓存任何会话状态** —— 没有条目数组、没有内存里的 leaf 变量,每次调用都现问 storage。
 * 于是「同一个会话被开了两个 Session 实例」不会产生两份互相打架的内存状态;真正的并发风险在
 * §11 那条 id/parentId 竞态上,与实例个数无关。
 *
 * 泛型 TMetadata 只是把 storage 的元数据类型透传出去(JSONL 版比内存版多 cwd / path 等字段)。
 */
export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	// 两个字段都是 private 且构造后不再变:storage = 数据从哪来,contextBuildOptions = 这个会话的
	// 「默认投影选项」,每次 buildContext 都会与调用点传的选项合并(§9)。
	private storage: SessionStorage<TMetadata>;
	private contextBuildOptions: SessionContextBuildOptions;

	/**
	 * @param storage 会话存储(内存或 JSONL),Session 的全部 I/O 都经它。
	 * @param contextBuildOptions 会话级默认投影选项,可省;与调用点选项的合并规则见 §9。
	 */
	constructor(storage: SessionStorage<TMetadata>, contextBuildOptions: SessionContextBuildOptions = {}) {
		this.storage = storage;
		this.contextBuildOptions = contextBuildOptions;
	}

	// 下面几个是纯转发(delegation),存在的意义是让调用方只认 Session 一个门面。返回 Promise 的四个
	// 都**没写** async —— 直接把 storage 的 Promise 递出去,少一层微任务包装;getStorage 则是同步的。
	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	// 逃生舱:setLeafId / findEntries 这类 Session 没有包装的能力,调用方直接问 storage 要。
	// harness 的 flushPendingSessionWrites 靠它写 leaf(agent-harness.ts:848),ACP 的自动压缩
	// 靠它 findEntries("compaction") 找上一次压缩的时间。
	getStorage(): SessionStorage<TMetadata> {
		return this.storage;
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	/** 当前对话 = leaf → root 的路径。 */
	/**
	 * 全景篇 §4 步骤 3a。上面那行注释里的「leaf → root」说的是**走法**(沿 parentId 往上爬);
	 * 返回数组的**顺序是 root → leaf** —— getPathToRoot 内部用 unshift 逐个前插,
	 * 所以拿到手可以直接当「从旧到新的一段对话」用。
	 * fromId 省略时用当前 leaf;显式传的场景只有分支摘要 —— branch-summarization.ts:112-113 要同时
	 * 拿旧 leaf 与新目标两条路径去求最深公共祖先。
	 * 【注意】回退走 ??(只认 null/undefined)而不是 ||:传空串不回退,直接进 getPathToRoot 抛 not_found。
	 */
	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}

	// ── §9 实例侧上下文构建与选项合并 ──────────────────────────────────
	/** 实例版的 §5:先取当前分支,再跑变换链。返回条目列表(不是消息),桌面端与测试用它做断言。 */
	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/**
	 * 全景篇 §4 步骤 3 的入口。harness 的 createTurnState()(agent-harness.ts:574)每轮开头调它,
	 * 但**只取 messages**;model / thinkingLevel 由 harness 自己的字段说了算。
	 * 那三个配置字段真正的消费者是「恢复会话」的宿主:coding-agent/src/acp/agent.ts:380-384 用
	 * context.model / context.thinkingLevel 复原用户上次的选择。activeToolNames 目前只有测试在读。
	 */
	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/**
	 * 合并会话级选项与调用点选项。两个字段的合并语义**不同**,记住这条:
	 * - entryTransforms:数组拼接,会话级排在前面 —— 两边都会跑,顺序是「先会话级、后调用点」。
	 * - entryProjectors:对象展开,调用点的**覆盖**同名 customType 的会话级投影器。
	 * 没有「关掉会话级选项」的开关;要临时不跑某个变换,只能另建一个不带它的 Session。
	 */
	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}

	// ── §10 标签与会话名 ──────────────────────────────────────────────
	/**
	 * 读一条条目的标签(书签)。标签由 label 条目累积,storage 侧维护成一张 id → label 的缓存表,
	 * 规则是「最后一条说了算」,空标签等于删除(memory-storage.ts 的 updateLabelCache)。
	 */
	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	/**
	 * 会话名。条目类型叫 session_info 是历史遗留,取的是**最后一条**的 name。
	 * 【注意】findEntries 扫的是整个会话文件的所有条目,**不限于当前分支** —— 切到另一条分支上
	 * 仍然读到同一个名字。这与 buildContext「只看当前路径」是两套语义,别混。
	 * 只有空白的名字经 trim 后被 || undefined 吃掉,不会返回空串。
	 */
	async getSessionName(): Promise<string | undefined> {
		const entries = await this.storage.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	// ── §11 追加即前进:appendTypedEntry 与九个 append* ────────────────
	// 所有 append*:id 由 storage.createEntryId() 分配,parentId = 当前 leaf ——
	// 这就是"追加即前进"的树语义;storage 只负责存,树的构造责任在这里。
	/**
	 * 所有 append* 的收口:把已经组装好的完整条目交给 storage,返回它的 id。
	 * 「追加即前进」是两边配合完成的:parentId(挂在谁下面)由上面的调用方定死,而「新条目成为新
	 * leaf」由 storage.appendEntry 内部完成(leafIdAfterEntry)—— 所以这里看不到任何 setLeafId。
	 * 失败时不接:storage 抛的 SessionError 一路冒到调用方,harness 的 FIFO 队列靠「写成功才出队」
	 * 保证失败的写留在队头、不会烂在半路。
	 */
	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}

	/** 追加一条真消息(user / assistant / toolResult / 自定义角色都走这里)。 */
	async appendMessage(message: AgentMessage): Promise<string> {
		// 下面这个对象字面量末尾用 satisfies 而不是 as:漏写一个字段会当场编译失败,而 as 会把这种错误
		// 咽下去。九个 append* 与 §12 的 moveTo 全部照抄这一套写法,这是它们唯一一处类型安全保证。
		return this.appendTypedEntry({
			type: "message",
			// 【竞态】createEntryId() 只是「查了一下没撞车」,**不预留**这个 id;而它与真正的 appendEntry
			// 之间还隔着下面这次 await getLeafId()。两个 append* 并发跑时,不但可能拿到同一个 id,而且
			// **一定**拿到同一个 parentId —— 结果是两条新条目并列挂在同一个父下,意外分叉而不是成链。
			// harness 用 FIFO 串行 flush 规避;直接用 Session 的调用方要自己保证串行。
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			// 条目的 timestamp 是**落盘时刻**,与消息体里那个业务时间戳是两回事,不要拿它做对话时序推断。
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	/**
	 * 换 thinking 档位。档位存的是**字符串**而不是枚举,因为「哪些档位合法」取决于当时选的模型;
	 * 恢复会话时由宿主再夹一次(acp/agent.ts:384 的 clampThinkingLevel)。
	 */
	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	/** 换模型。provider 与 modelId 分两段存,恢复时拿它们去注册表里找;找不到就回退宿主的默认模型。 */
	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	/**
	 * 换工具白名单。传空数组是合法的,意思是「一个工具都不给」—— 与 §3 里 null 的「从没设过」不同。
	 */
	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			// 拷一份再存:内存存储里条目对象就是这一份,共享引用等于调用方能事后改写已落盘的历史。
			activeToolNames: [...activeToolNames],
		} satisfies ActiveToolsChangeEntry);
	}

	/**
	 * 追加一条压缩条目 —— 全景篇 §4 步骤 47 的最后一步、也是 §4 那个投影函数的数据来源。
	 * @param summary 模型生成的摘要正文,投影时变成一条 compactionSummary 消息。
	 * @param firstKeptEntryId 从哪条条目起原文保留;§4 的投影就靠它切。
	 * @param tokensBefore 压缩前上下文的估算大小,纯展示用。
	 * @param details 应用层附加数据(读过/改过的文件清单等),原样存、原样取。
	 * @param fromHook 摘要是不是 session_before_compact hook 直接给的,而不是调模型生成的。
	 * 调用点在 agent-harness.ts:1331,**摘要真的生成成功之后才会走到这里** —— 中途失败时树分毫未动,
	 * 这就是「压缩失败不连坐」的实现方式。
	 */
	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	/**
	 * 追加一条 custom 条目:纯结构化数据,**默认不进**模型上下文(要进就注册 §2 的投影器)。
	 * 与下面的 appendCustomMessageEntry 只差一个词、语义相反,别记混。
	 */
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	/**
	 * 追加一条 custom_message 条目:自定义角色的真消息,**默认就进**模型上下文(§6)。
	 * @param display 只影响 UI 画不画,不影响它进不进上下文。
	 */
	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	/**
	 * 给某条条目打标签(书签 / 检查点)。label 传 undefined 或空白串 = 取消标签。
	 * 与其它 append* 不同,它先校验目标条目存在,不存在就抛 SessionError("not_found") —— 因为条目
	 * 只追加不删改,指向不存在 id 的标签是**永久性**脏数据,没有任何后续流程会来修它。
	 * 注意这条 label 条目自己挂在**当前 leaf** 下而不是挂在 targetId 下:它是一条旁注,不改变对话
	 * 的形状(投影时产出 0 条消息)。
	 */
	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.storage.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	/**
	 * 给会话起名。改名不覆盖旧名,只是再追加一条,读的时候取最后一条(§10)。桌面端的会话标题
	 * 就走这条路(kernel/src/host/session-manager.ts:413 / :431)。
	 */
	async appendSessionName(name: string): Promise<string> {
		// 换行必须先杀掉。倒不是怕劈开 JSONL 的行(JSON.stringify 会转义),而是这个名字要出现在标题栏
		// 和会话列表里,多行标题是纯粹的显示灾难。连续换行折成一个空格,再 trim 掉首尾。
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		} satisfies SessionInfoEntry);
	}

	// ── §12 moveTo —— 移动 leaf 与分支摘要 ────────────────────────────
	/** 移动 leaf(分支/回退);可选生成分支摘要条目,摘要挂在"新 leaf"下。 */
	/**
	 * 把 leaf 挪到树上另一个条目,可选地把「被抛下的那条分支」总结成一条 branch_summary 条目。
	 * 这是**分支产生的唯一途径**:挪完之后再 append,新条目挂在那个旧条目下,原来那条尾巴就成了
	 * 另一条分支 —— 一条都没被删。调用点是 harness 的 navigateTree()(agent-harness.ts:1446)。
	 * @param entryId 目标条目;传 null = 回到根(当前对话清空,但历史一条不少)。
	 * @param summary 分支摘要正文与附加数据;不传就只挪光标。
	 * @returns 摘要条目的 id;没要摘要时返回 undefined。
	 */
	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; fromHook?: boolean },
	): Promise<string | undefined> {
		// 先校验再动 leaf:leaf 一旦指到不存在的 id 上,之后每一次 getPathToRoot 都会抛,等于整个会话
		// 打不开。null 是合法值(根),所以要单独放行,不能写成 if (!entryId)。
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		// setLeafId 不是改一个内存变量,而是**追加一条 leaf 条目** —— JSONL 是追加日志,光标只有写成
		// 数据才能在重开文件时被逐行重放出来。推论:leaf 条目虽然进了文件,却永远不会出现在任何一条
		// getPathToRoot 路径上(storage 把游标设成 targetId 本身,没人会以 leaf 条目为父)。
		await this.storage.setLeafId(entryId);
		// 不要摘要就到此为止 —— 只有这条路径上,最终 leaf 才真的停在 entryId。
		if (!summary) return undefined;
		// 【坑】要摘要的话,最终 leaf **不是** entryId:摘要条目挂在 entryId 下面,而 appendEntry 又会把
		// 游标推到摘要条目上。想知道「到底挪到哪了」必须再问一次 getLeafId()(agent-harness.ts:1458
		// 就是这么做的),照着入参 entryId 推会错。
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.storage.createEntryId(),
			// parentId 显式写 entryId,而不是像别的 append* 那样再问一次 leaf。上一行的 setLeafId 已经把游标
			// 设成了 entryId,两者取值相同,但写死在这里把「摘要必须挂在目标条目下」这个意图钉住了,
			// 也省一次 I/O。entryId 为 null 时,这条摘要自己成为一个根节点。
			parentId: entryId,
			timestamp: new Date().toISOString(),
			// fromId 记的是「从哪儿分出来的」,给 UI 显示用;entryId 为 null 时退化成字符串 "root",
			// 因为消息构造器要的是 string 而不是 string | null。
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
	}
}
