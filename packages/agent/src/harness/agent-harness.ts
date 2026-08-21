// M7 大节点 A:setters 落树(Step 3)+ 挂起写入(Step 4)+ turn 快照(Step 5)
// + prompt()/skill()/promptFromTemplate() 完整闭环(Step 6),外加队列/hooks/abort
// (原计划 Step 7-9,因管线本来就要就位,一并完成)。
// compact() 与 navigateTree() 两个自包含侧枝已随 M8 落地(见下方"结构性会话操作"一节),
// 但都还没有针对 harness 方法本身的测试 —— compaction.test.ts 测的是 compaction.ts 里的
// 自由函数,不经过这里的相位守卫与 hook 分支。
// 参考 pi-minimal harness/agent-harness.ts(1029 行)。
//
// 心智模型:harness 没有自己的循环,它只是 runAgentLoop 的一个高级调用者。
// 它管四类状态 —— harness 配置(随时可改)/ turn 快照(冻结)/ session(落盘即历史)/
// 挂起写入(忙时排队)—— 并保证它们永不互相污染。

/**
 * ── 这个文件是什么 ───────────────────────────────────────────────────────
 *
 * AgentHarness =「会话外壳」:一个 harness 实例 = 一个 session = 一个在飞的轮次。
 * 它把 agent-loop.ts 那个无状态的双层 while 包成一个可长期持有的对象,只负责四件事:
 *   1. 相位机(phase machine):忙的时候同步抛 busy,绝不排队;
 *   2. turn 快照:进一轮时冻结 messages / 模型 / 思考档位 / 工具,本轮请求只读它;
 *   3. 事件回流:loop 吐出的 AgentEvent 先落盘(session)再转发给订阅者;
 *   4. 挂起写入:轮内产生的会话写入排进 FIFO,轮末串行落盘 —— 这是全仓
 *      「同一时刻只有一个写者」的唯一保证。
 *
 * 在全景链路上的位置(docs/learn/00-内核全景.md §4):
 *   宿主 harness.prompt()(阶段 1 第 1 步)→ 本文件的相位守卫 + createTurnState
 *   冻结快照(第 3 步)→ createLoopConfig / createStreamFn 把六个回调和一个 StreamFn
 *   交给 runAgentLoop(第 7-9 步,循环本体在 agent-loop.ts)→ 事件从 handleAgentEvent
 *   回流、先 session.appendMessage 落盘再 emitAny 转发(第 26 步)→ 订阅者
 *   (桌面端投影器 / ACP 适配器)。阶段 1 与阶段 6 收尾几乎全部实现在这个文件里。
 *
 * 不存在会怎样:裸 loop 仍然能跑,但没有会话历史、没有相位保护、没有 hook,
 * 也没有人保证事件被落盘 —— 桌面端与 ACP 都是直接 new 这个类,不碰 agent.ts 的 Agent。
 *
 * 对应学习文档:docs/learn/agent/harness_agent-harness.md
 *
 * 分节索引:
 *   §1  文件头与依赖
 *   §2  模块级工具函数(消息合成 / streamOptions 克隆与补丁)
 *   §3  错误归一化与 handler 表
 *   §4  turn 快照类型、类字段与构造函数
 *   §5  事件分发三路:emitOwn / emitAny / emitHook
 *   §6  运行承诺与 turn 快照:startRunPromise / createTurnState / createContext
 *   §7  StreamFn 装配:createStreamFn
 *   §8  队列排空与 loop 配置:drainQueuedMessages / createLoopConfig
 *   §9  名字校验与挂起写入:validateToolNames / flushPendingSessionWrites
 *   §10 事件回流:handleAgentEvent / emitRunFailure
 *   §11 一轮的运行机:executeTurn / runLoopToCompletion
 *   §12 四条入口:prompt / skill / promptFromTemplate / retryLastTurn
 *   §13 队列入口与 appendMessage
 *   §14 结构性侧枝:compact / navigateTree
 *   §15 配置 getters / setters
 *   §16 abort / waitForIdle / subscribe / on
 */

// ── §1 文件头与依赖 ────────────────────────────────────────────────────────
// 全是类型与纯函数,没有一处碰 node:* —— harness 要能被打进浏览器包,
// 「碰真实机器」的能力只经 ExecutionEnv 这一个注入口进来(env 字段)。
import type { AssistantMessage, ImageContent, Model, Models, UserMessage } from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "../agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import type { Session } from "./session/session.ts";
import { formatSkillInvocation } from "./skills.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessPromptOptions,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Skill,
} from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

// ── §2 模块级工具函数 ──────────────────────────────────────────────────────

/**
 * 把一句文本(可选带图片)包成 pi-ai 的 UserMessage。
 * 四条入口(prompt / skill / promptFromTemplate)与三个队列(steer / followUp /
 * nextTurn)共用它,所以「一条用户消息长什么样」在本文件里只有这一处定义。
 * content 永远写成数组而不用 pi-ai 允许的裸字符串简写 —— 这样图片能无条件 push 进去。
 */
function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	// 顺序刻意:文本在前、图片在后,与「先打字再贴图」的输入顺序一致。
	// 这里不做去重、不校验大小,那是调用方的事。
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

// loop 机器自身炸掉时合成的错误 assistant 消息 —— 失败也是一条普通 transcript 条目。
/**
 * loop 机器本身炸掉(注意:不是 provider 请求失败)时合成的 assistant 消息。
 * 参数 model 只用来抄 api / provider / model 三个身份字段;aborted 决定 stopReason
 * 是 "aborted" 还是 "error";error 的文案落进 errorMessage。
 * 返回一条 content 只有空文本块、usage 全 0 的 AssistantMessage,永不抛异常。
 *
 * 为什么要合成而不是直接把异常抛给调用方:整套内核的契约是「失败是数据不是异常」
 * (全景篇 §3)。有了这条消息,订阅者照常收得到 message_end / turn_end / agent_end,
 * 会话文件里留得下失败痕迹,retryLastTurn() 之后也才有东西可摘。
 */
function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		// usage 是 AssistantMessage 的必填字段(ai/src/types.ts:383),而这条消息
		// 没有真实 token 账,只能全填 0 —— 让计费聚合方求和时得到 0 而不是崩在 undefined。
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/**
 * streamOptions 的「一层深拷」:顶层字段浅拷,headers / metadata 两个对象各复制一份。
 * 只深到这一层就够 —— AgentHarnessStreamOptions 里只有这两个字段是可变对象。
 * 全类到处调它,目的是让「调用方手里的对象」与「harness 内部的对象」永不共享引用:
 * getStreamOptions() 拿到的副本被外部改掉,不会悄悄改变下一次请求。
 */
function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

/**
 * 找出数组里出现一次以上的名字,返回去重后的重复项。
 * 只服务于「工具名不许重名」这一条校验:工具是按名字进 Map 的,重名会静默覆盖,
 * 于是模型看到的工具表和你以为装配的那张表不是同一张 —— 必须在构造期就炸掉。
 */
function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

// 补丁语义:Object.hasOwn 区分"没提供"和"显式 undefined"(后者表示清空)。
/**
 * 把 before_provider_request hook 返回的补丁叠到当前 streamOptions 上,返回新对象。
 * base 不被修改(先 cloneStreamOptions),所以多个 hook 能串成链:第 n 个 hook 看到的
 * 是前 n-1 个叠加之后的结果(test/harness/agent-harness-stream.test.ts 的
 * "chains provider request patches" 钉住了这条链式语义)。
 *
 * 三层 undefined 语义别记混:
 *   · 补丁里没有这个键              → 保持原值(靠 Object.hasOwn 判定)
 *   · patch.headers === undefined   → 整个 headers 清空
 *   · patch.headers.foo === undefined → 只删 foo 这一个键
 * 用 `in` 或真值判断都区分不出前两者,这就是必须写 Object.hasOwn 的原因。
 */
function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;


	// headers 与 metadata 走的是「逐键合并」而不是整体替换:hook 想加一个 header
	// 不该顺手把别的 hook 加的删掉。下面两段逻辑完全同构,只是字段不同。
	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			// 键被删光时整个塌回 undefined,而不是留一个空对象:这样「有没有自定义 header」
			// 全程只有一种判法(=== undefined),下一个 hook 与 provider 都不用再区分空对象。
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

// ── §3 错误归一化与 handler 表 ────────────────────────────────────────────

// 订阅者(subscribe)全部挂在 "*" 这一个桶里,on() 注册的 hook 按事件类型分桶,
// 两者共用同一张 handlers Map,只靠 key 区分。这就是「emitOwn 的事件用 on() 收不到」
// 那个坑的根源:emitOwn 只遍历 "*" 桶,从不去查 event.type 那个桶(见 §5)。
const SUBSCRIBER_EVENT_TYPE = "*";

// hook(on,返回值被消费)与 listener(subscribe,纯观察)共用这张表;"*" 是 listener 桶。
type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

/**
 * 把任意异常收敛成 AgentHarnessError,让调用方永远只需要 catch 一种错误、
 * 只需要 switch 一个 code。
 * 参数 fallbackCode:认不出来源时用哪个 code(prompt 用 "unknown"、appendMessage
 * 用 "session"、setTools 用 "invalid_argument")。
 * 顺序是刻意的:已经是 AgentHarnessError 就原样透传 —— 再包一层会把它原本精确的
 * code 冲成 fallbackCode;其余三种下层错误各自映射到对应 code,剩下的才用兜底。
 */
function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

// hook / listener 抛出来的一律记成 code "hook":调用方据此区分
//「内核自己坏了」和「你注册的观察者坏了」——后者不该被当成内核 bug 去排查。
function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

// ── §4 turn 快照类型、类字段与构造函数 ────────────────────────────────────

// turn 快照:本轮请求只读它;setter 改的是 harness 配置,下次 createTurnState 才被看见。
/**
 * 一轮的冻结快照。进入一轮时由 createTurnState() 造一份,本轮每一次 provider 请求
 * 都只读它;setter(setModel / setThinkingLevel / setTools / setResources)改的是
 * harness 的配置字段,不动这份快照。
 * 于是「说到一半换模型」这一轮不生效,要等下一个 save point 由 prepareNextTurn()
 * 重建快照才被看见 —— 这就是「turn 快照冻结」这条不变式的全部实现。
 *
 * 三个泛型参数(TSkill / TPromptTemplate / TTool)从类上一路透传下来,
 * 为的是让宿主自己的技能 / 工具类型在 getTools()、事件载荷里不被擦成基类型。
 * 这个接口不导出:它是 harness 的内部形状,不属于对外契约。
 */
interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	// messages 是 session.buildContext() 投影之后的结果(已应用路径上最后一条
	// compaction),不是磁盘上的全量历史 ——「压缩只改投影、不改历史」在这里兑现。
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	// sessionId 下发给 provider 做会话级缓存 / 路由,取自会话元数据,不是 leaf id。
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	// tools 是全量工具表,activeTools 是按 activeToolNames 过滤后真正发给模型的那份。
	// 注意:全类没有一处读 turnState.tools(createContext 用的是 activeTools),
	// 这个字段目前是快照里的死字段。
	tools: TTool[];
	activeTools: TTool[];
}

/**
 * 会话外壳本体。一个实例 = 一个 session = 一个在飞的轮次。
 * 宿主在建会话时 new 一次(全景篇 §4 阶段 0 的 0.8 步),之后整条会话复用同一个实例。
 * models 是 readonly —— 注册表建好就换不掉,所以装配时必须一次把全部有凭据的
 * provider 注册齐。
 */
export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	readonly models: Models;
	// 相位机的全部状态就是这一个字段。它不是锁:忙的时候确定性抛 busy,不排队。
	// 五个取值里 turn / retry 由 loop 驱动,compaction / branch_summary 是两条自包含侧枝。
	private phase: AgentHarnessPhase = "idle";
	// 本轮的 AbortController。它在 runLoopToCompletion(§11)里才被赋值,而 prompt()
	// 在那之前要先 await createTurnState()(会做 session I/O)—— abort 恰好落在
	// 这个窗口时什么也打断不了(见文档 §5)。
	private runAbortController?: AbortController;
	// waitForIdle() 等的就是它:由 startRunPromise() 建、由入口方法的 finally 解开。
	// 只有跑轮次的四条入口会建它,compact() / navigateTree() 不建 ——
	// 所以压缩期间调 waitForIdle() 是立刻返回的。
	private runPromise?: Promise<void>;
	// 轮内(phase !== idle)产生的会话写入排在这里,轮末由 flushPendingSessionWrites
	// 串行落盘。它同时是全仓「同一时刻只有一个写者」的唯一保证(§9)。
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	// 工具按名字进 Map:模型只用名字点工具,重名等于静默覆盖,所以构造期就查重。
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	// 三个队列的差别只在「谁来拉、什么时候拉」:
	//   steer    飞行中插话,loop 每个 turn_end 之后拉一次(当前这轮的工具照常执行);
	//   followUp 将停时续摊,loop 内层循环退出后才拉,拉到就再来一整轮;
	//   nextTurn 排给下一次 prompt(),由 executeTurn 自己 splice 走,不经 loop 的回调。
	private steerQueue: UserMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: UserMessage[] = [];
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	// hook(on)与 listener(subscribe)共用这张表,key 见 §3。
	private handlers = new Map<string, Set<AgentHarnessHandler>>();

	/**
	 * 装配。除 env / session / models / model 四个必填项外都有默认值:resources 缺省
	 * 为空对象、thinkingLevel 落到 "off"、两个队列模式默认 one-at-a-time、
	 * activeToolNames 缺省 = 全部工具(按声明顺序)。
	 * 失败方式只有一种形状:工具重名 / 激活名重复 / 激活名不在工具表里,三者都同步抛
	 * AgentHarnessError("invalid_argument")—— 装配期就炸,不留到第一次 prompt 才发现。
	 */
	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.models = options.models;
		this.resources = options.resources ?? {};
		// 深拷一层:调用方后续改自己那份 options,不该影响已经建好的 harness。
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		// 先查重再入 Map:Map 自己会静默覆盖,查重必须发生在写入之前才有意义。
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		// 默认 "off",而 "off" 会让 createLoopConfig 把 reasoning 整个设成 undefined(§8)。
		// 对 reasoning 模型这等于「最强的那一档默认关掉,且没有任何地方提示」——
		// 桌面端与 bench 因此各自注入 defaultThinkingLevel(见仓库根 CLAUDE.md)。
		this.thinkingLevel = options.thinkingLevel ?? "off";
		// 不传 activeToolNames = 全部工具都激活,顺序按 options.tools 的声明顺序;
		// 传了就只激活这个子集,且每个名字都必须是已注册的工具(下一行校验)。
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	// ── §5 事件分发三路:emitOwn / emitAny / emitHook ──────────────────────
	// ---- 事件分发 -----------------------------------------------------------

	// 取某一类事件的 handler 集合。"*" 是订阅者桶,其余键是 on() 注册的 hook 桶。
	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	/**
	 * 发一条 harness 自有事件(save_point / settled / abort / queue_update / …)。
	 *
	 * 【与 CLAUDE.md 一致的坑】它的函数体与下面的 emitAny 逐字节相同:两者都只遍历
	 * "*" 订阅者桶,谁也没去查 this.handlers.get(event.type)。后果是走 emitOwn 的
	 * 11 种事件用 on() 注册**永远不会触发**,只能靠 subscribe() 收(名单见 §16 的 on())。
	 * 要改成「on() 也能收」只需在这里多遍历一次 getHandlers(event.type);之所以没改,
	 * 是因为这些事件的结果类型全是 undefined —— 它们本来就不是给你改行为用的。
	 */
	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		// 逐个 await 而不是 Promise.all:订阅者可以是异步的,而且必须按注册顺序、
		// 一个跑完再跑下一个 —— 桌面端投影器依赖「事件被顺序处理完」才能维持它的不变式。
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				// 订阅者抛错不吞:包成 code "hook" 往上抛。turn_end 那一路会先把错暂存、
				// 等 flush 完再抛(§10),其余路径直接冒到入口方法的 catch。
				throw normalizeHookError(error);
			}
		}
	}

	/**
	 * 发一条「任意事件」:loop 的 10 种 AgentEvent 都经这里转给订阅者。
	 * 与 emitOwn 的唯一差别是入参类型更宽(AgentHarnessEvent = AgentEvent ∪ 自有事件),
	 * 运行时行为完全相同 —— 两个方法并存是类型分工,不是行为分工。
	 */
	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	// 类型化 hook 分发:多个 handler 依次执行,最后一个非 undefined 的返回值胜出。
	/**
	 * 发一条**有返回值**的 hook,并把结果交回调用方。这条路才是活的 on() 通道。
	 * 参数 event 是自有事件里那些「结果类型不是 undefined」的几种:before_agent_start /
	 * context / tool_call / tool_result / session_before_compact / session_before_tree
	 * (另两个 provider hook 因为要链式叠加,各有专用发射器,见下)。
	 * 返回:最后一个返回了非 undefined 的 handler 的结果;一个 handler 都没有则 undefined。
	 * 失败:任一 handler 抛错,整条链中断并抛 code "hook"(于是整轮走失败路径)。
	 */
	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		// 没人注册就直接返回,省掉一次循环与一次 await —— 这是每轮、每个工具都会走的热路径。
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		// 「最后一个非 undefined 胜出」而不是「第一个胜出」:后注册的 hook 覆盖先注册的,
		// 但只在它真的表态时 —— 返回 undefined 等于弃权,不会把前面的结果抹掉。
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	/**
	 * before_provider_request 的专用发射器。它不能走 emitHook,因为语义不同:
	 * emitHook 是「所有 handler 看同一份输入、最后一个胜出」,这里是「上一个 handler
	 * 的结果叠给下一个」。
	 * 参数 streamOptions 来自本轮快照;返回叠加完补丁的新对象,只喂给这一次请求。
	 * 每个 handler 拿到的 streamOptions 都是**副本**,就地改它无效,必须通过返回值
	 * 里的 patch 表达修改(patch 语义见 §2 的 applyStreamOptionsPatch)。
	 */
	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					// 只认 result.streamOptions 这一个字段;返回别的东西等于弃权。
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	/**
	 * before_provider_payload 的专用发射器,同样是链式的:上一个 handler 改完的 payload
	 * 交给下一个。payload 是已经翻成厂商形状的请求体(类型是 unknown —— 这一层不认识它),
	 * 给的是「发出去之前最后一次改字节」的机会。
	 * 注意判的是 result !== undefined、取的是 result.payload:类型上 payload 是必填的,
	 * 但运行时若 handler 返回一个没有 payload 的对象,整个请求体会被抹成 undefined。
	 */
	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	/**
	 * 三个队列任何一次变动之后发的通知。三份数组都是**副本**,订阅者拿到的是快照,
	 * 改它不会影响真实队列。
	 * 它走 emitOwn,所以只有 subscribe() 收得到;而且它会抛错(订阅者炸了就炸),
	 * 这正是 drainQueuedMessages 与 executeTurn 需要回滚队列的原因(§8 / §11)。
	 */
	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	// ── §6 运行承诺与 turn 快照 ───────────────────────────────────────────

	/**
	 * 建一个「本次运行还没结束」的 Promise 存进 this.runPromise,返回解开它的函数。
	 * waitForIdle() 就是 await 这个 Promise。
	 * 返回的 finish 必须在入口方法的 finally 里调,否则一次异常就会让 waitForIdle()
	 * (以及 await 它的 abort())永久挂住。
	 * finish 里先清 runPromise 再 resolve:被唤醒的代码看到的一定是「没有在飞的运行」。
	 */
	private startRunPromise(): () => void {
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			finish();
		};
	}

	// ---- turn 快照(Step 5)-------------------------------------------------

	/**
	 * 冻结一份 turn 快照 —— 全景篇 §4 的第 3 步,也是每个 save point 的一半
	 * (prepareNextTurn 会再调一次,见 §8)。
	 * 返回一个全新的 AgentHarnessTurnState,不改任何 harness 状态(纯读)。
	 * 失败:session I/O 出错会抛,由入口方法的 catch 归一并把相位拨回 idle。
	 */
	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		// 这里拿到的是**投影**后的消息(路径上最后一条 compaction 已应用),不是磁盘全量历史。
		// 注意 buildContext 顺带推导出来的 model / thinkingLevel / activeToolNames 三个字段
		// 在这里被**丢弃**了 —— harness 只信自己的配置字段。所以「重开一个历史会话要恢复
		// 当时的模型与档位」是宿主的活儿,harness 不会替你做。
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		// 按 activeToolNames 的顺序取工具,取不到的静默跳过。正常路径下不会有取不到的:
		// 构造函数、setTools、setActiveTools 三处都过了 validateToolNames。
		// 这个 filter 是类型收窄用的兜底,不是业务分支。
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		// 系统提示词三种形态:没配 → 一句兜底;字符串 → 直用;函数 → 现场调一次。
		// 函数形态每轮(以及每个 save point)都会被重新调用,所以它可以把「当前模型 /
		// 当前激活工具 / 当前技能清单」写进提示词,而不需要宿主手动刷新。
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		// streamOptions 在这里再深拷一层:本轮请求读的是快照,轮内 setStreamOptions()
		// 改的是配置字段,要下一轮才生效(agent-harness-stream.test.ts 的
		// "uses updated stream options for save-point snapshots" 钉住了这条)。
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	/**
	 * 把 turn 快照摊成 loop 要的 AgentContext(只有 systemPrompt / messages / tools 三个字段)。
	 * 参数 systemPrompt:before_agent_start hook 覆盖本轮提示词时从这里塞进来。
	 * 两个 slice() 是要害:loop 会**就地** push 流式消息与工具结果进 context.messages,
	 * 不复制的话它写的就是快照里那个数组,下一次 createTurnState 的对比基准会被污染。
	 */
	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	// ── §7 StreamFn 装配 ──────────────────────────────────────────────────

	// streamFn 不在 AgentLoopConfig 里,单独造、作为第 6 个参数传给 runAgentLoop。
	/**
	 * 造 StreamFn —— loop 每要发一次 provider 请求就调它一次(全景篇 §4 第 8 步)。
	 * 参数 getTurnState 是取值函数而不是快照值:prepareNextTurn 换过快照之后,后续请求
	 * 必须读到**新的** streamOptions / sessionId,所以这里必须晚绑定。
	 * 三个 hook 位:before_provider_request(改请求选项)、onPayload →
	 * before_provider_payload(改请求体)、onResponse → after_provider_response(纯观察,
	 * 走 emitOwn 所以 on() 收不到)。
	 * 失败:自己不抛 —— models.streamSimple 把失败编码进流(全景篇 §3「失败是数据」)。
	 */
	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		// 第三个参数 streamOptions 是 **loop 把 AgentLoopConfig 展开之后**的那份
		// (agent-loop.ts 的 streamAssistantResponse:`{...config, apiKey, signal}`),
		// 不是 harness 的 streamOptions。下面只从它里面取 reasoning 和 signal 两样。
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			// harness 侧的请求选项来自快照,与 loop 的 config 完全分家。
			const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			// 逐字段显式列举而不是整体展开:loop config 里的 temperature / maxTokens /
			// apiKey / thinkingBudgets **不会**被转发。也就是说走 harness 这条路时,凭据只
			// 可能来自 models 注册表里 provider 自己的 auth —— AgentLoopConfig.apiKey 与
			// getApiKey 在这条路上是死路。
			return this.models.streamSimple(model, context, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				// 这里用的 signal 是 loop 那个(streamOptions?.signal),
				// 不是 requestOptions —— 请求选项里根本没有 signal 字段。
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				// reasoning 由 loop 的 config 决定(createLoopConfig 落定、prepareNextTurn 可换),
				// 不从快照里读 —— 免得快照与 loop 各持一份档位而不同步。
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
			});
		};
	}

	// ── §8 队列排空与 loop 配置 ───────────────────────────────────────────

	/**
	 * 从 steer / followUp 队列取一批消息,并通知订阅者队列变了。
	 * 参数 mode:"all" 清空队列,"one-at-a-time" 只取最老的一条(默认)。
	 * 返回取出的消息;队列空时直接返回,**不发** queue_update —— 否则每个 turn_end
	 * 都要刷一条没有信息量的事件。
	 * 失败:emitQueueUpdate 抛错时把消息 unshift 回队头再抛。全文件只有两处这种
	 * 「hook 抛错要回滚」的写法(这里与 §11 的 executeTurn),改动时别漏。
	 */
	// hook 抛错时 unshift 回滚 —— 消息不能因为观察者炸了而丢失。
	private async drainQueuedMessages(queue: AgentMessage[], mode: QueueMode): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	/**
	 * 把 harness 的手伸进 loop 的那六个回调,外加 model / reasoning / convertToLlm
	 * (全景篇 §4 第 7 步)。
	 * **harness 全类没有一行 while/for 在驱动轮次** —— 多轮、工具批、队列轮询全在
	 * agent-loop.ts 里,harness 只通过这张配置表参与。
	 * 参数 getTurnState / setTurnState 是同一份闭包变量的读写口:prepareNextTurn 换快照
	 * 就是通过 setTurnState 让 createStreamFn 也跟着看到新值。
	 * 返回的配置对象**只在开跑时造一次**;之后 loop 自己用 {...config} 叠加
	 * prepareNextTurn 返回的 model / thinkingLevel。
	 */
	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
	): AgentLoopConfig {
		// 这里取的是**开跑那一刻**的快照:下面 model / reasoning 两个字段是值不是取值函数,
		// 所以它们只代表第一轮;之后换模型全靠 prepareNextTurn 的返回值。
		const turnState = getTurnState();
		return {
			model: turnState.model,
			// "off" → undefined:把 reasoning 整个从请求选项里摘掉,而不是发一个 "off"
			// 字符串给 provider。这就是「默认档位 off 等于关掉思考」的落点。
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm,
			// context hook:能改「这一次请求发什么消息」,但返回值**只喂给本次请求**,
			// 不写回 context.messages。想让裁剪持久生效必须走 prepareNextTurn。
			// 传给 hook 的是数组副本([...messages]),就地改它不会影响 loop 手里那份。
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			// tool_call hook:返回 {block:true, reason} 可以挡下这次调用。
			// 注意 hook 拿到的 input 是**校验之后的参数对象本体**,就地改它不会重新校验
			// (agent-loop.test.ts 专门钉住了这个行为)——要拦就返回 block,别改参数。
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				// 显式挑字段而不是原样透传:hook 返回的多余字段不该漏进 loop 的契约。
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			// tool_result hook:可改写回给模型的 content、给 UI 的 details、isError,
			// 以及 terminate。loop 侧用 `afterResult.terminate ?? result.terminate` 合并,
			// 所以这里只能把 undefined 补成 true/false,抹不掉工具自己表过的态。
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
			// save point 的一半:flush 挂起写入 → 重建快照 → 更新闭包 → 换 loop 的运行时状态。
			// (承上)对应全景篇 §4 第 38 步。三步顺序不能换:先 flush 挂起写入
			// (让本轮 setter 真正落进树)→ 再 createTurnState 重建快照(此时才读得到刚落的
			// 那几条)→ 最后把新的 context / model / 档位交还给 loop。
			// 它也是桌面端自动压缩换 context 的落点:压缩条目写进 session 之后,这里重建的
			// 快照自然带上了压缩后的投影。
			prepareNextTurn: async () => {
				await this.flushPendingSessionWrites();
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState),
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
			// 两个队列各自的 mode 各管各的:steering 默认一次一条,于是用户连发三条插话会
			// 分摊到三个 turn,而不是一股脑挤进同一次请求。
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode),
		};
	}

	// ── §9 名字校验与挂起写入 ─────────────────────────────────────────────

	// 重名即抛 invalid_argument;message 参数只是错误文案的前缀。
	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	/**
	 * 校验一组「要激活的工具名」:不许重名,而且每个名字都必须在工具表里。
	 * 参数 tools 默认取当前工具表;setTools() 传的是**将要生效的新表** —— 这样
	 * 「换工具表 + 换激活集」能在真正改字段之前一起校验掉,失败时状态不会半生不熟。
	 */
	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	// ---- 挂起写入(Step 4)---------------------------------------------------

	// FIFO;peek 队头 → 写入成功 → 才 shift。失败的写留在队头,队列不会烂在半路。
	/**
	 * 把挂起写入队列排空,按 FIFO 逐条落进会话树。
	 * 四个调用点:turn_end / agent_end / prepareNextTurn,加 runLoopToCompletion 的
	 * finally 兜底。
	 * 失败:某一条写失败就整体抛出,而**失败的那条仍留在队头**(先写成功再 shift),
	 * 下一次 flush 会重试它 —— 队列不会烂在半路,也不会跳过一条继续写下一条
	 * (跳过会让树上出现顺序错乱的父子关系)。
	 */
	private async flushPendingSessionWrites(): Promise<void> {
		// 用「读队头 → 写 → shift」而不是 for-of:每次 await 期间队列还可能被追加
		// (订阅者在 message_end 回调里调 appendMessage 就会),按索引遍历会漏掉新来的。
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "active_tools_change") {
				await this.session.appendActiveToolsChange(write.activeToolNames);
			// 下面这五个分支(custom / custom_message / label / session_info / leaf)在本文件里
			// **没有生产者** —— 全类 push 进队列的只有 message / model_change /
			// thinking_level_change / active_tools_change 四种。它们是跟着
			// PendingSessionWrite(从 SessionTreeEntry 派生的类型)一起来的,属于未来预留。
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			// 写成功之后才出队 —— 这一行的位置就是「失败留在队头」那条保证本身。
			this.pendingSessionWrites.shift();
		}
	}

	// ── §10 事件回流:handleAgentEvent / emitRunFailure ────────────────────
	// ---- 事件处理:先落盘再通知;turn_end = save point(Step 6 心脏之一)------

	/**
	 * loop 吐出的每一条 AgentEvent 都从这里过。10 种事件里只有三种有特殊处理,其余七种
	 * (agent_start / turn_start / message_start / message_update / tool_execution_start /
	 * _update / _end)直接原样转发给订阅者。
	 * 参数 signal 是本轮的 abort 信号,透传给订阅者(它们可以据此提前收手)。
	 * 失败:订阅者抛错会一路冒回 loop,进而让整轮走 emitRunFailure 那条路(§11)。
	 */
	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		// **先落盘再通知**:订阅者看到一条消息时,它已经在会话文件里了。顺序反过来的话,
		// 订阅者里发起的重载有可能读到一份还缺最后一条消息的历史。
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
			await this.emitAny(event, signal);
			return;
		}
		// turn_end = save point。下面三步的顺序是契约(全景篇 §4 第 37 步)。
		if (event.type === "turn_end") {
			// 顺序即契约:先 emit(错误暂存不吞)→ flush → 再抛订阅者的错 → 都没错才发 save_point。
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			// 先记下「本轮有没有攒下写入」再 flush —— flush 完队列就空了,
			// save_point 事件里那个标志位就只能是 false。
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			// 暂存的订阅者错误在 flush **之后**才抛:写反了的话,一个订阅者炸掉就会把本轮
			// 攒下的会话写入全部丢掉 —— 那才是真正不可逆的损失。
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		// agent_end:最后一次 flush → 把相位拨回 idle → 才通知订阅者。
		// 相位在 emitAny 之前就 idle 了,所以订阅者在 agent_end 回调里发起新的 prompt()
		// 不会撞 busy;但此时 runPromise 还没解开,waitForIdle() 仍在等 ——
		// 「phase === idle」并不等于「这次运行彻底 settled」。
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			await this.emitAny(event, signal);
			// settled 带上 nextTurn 队列长度:宿主据此决定要不要立刻再发一轮。
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
		// 其余七种事件的默认路径:不落盘,只转发。
		await this.emitAny(event, signal);
	}

	// loop 机器炸了也要补发完整的事件尾巴 —— 订阅者永远看到 agent_end。
	/**
	 * loop 机器自己炸了(不是 provider 失败)时,合成一条失败 assistant 消息,并**照着
	 * 正常轮次的形状**补发 message_start → message_end → turn_end → agent_end 四连,
	 * 让订阅者永远看得到 agent_end(否则 UI 会永远停在「正在生成」)。
	 * 因为走的是 handleAgentEvent,这条失败消息同样会落盘、turn_end 同样会 flush、
	 * agent_end 同样会把相位拨回 idle —— 一次事故的善后与一次正常收尾完全同构。
	 * 返回一个只含这条消息的数组,冒充 loop 的返回值交给下游去找「最后一条 assistant」。
	 */
	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
	}

	// ── §11 一轮的运行机:executeTurn / runLoopToCompletion ────────────────
	// ---- prompt() 闭环(Step 6)---------------------------------------------

	/**
	 * 组装首批消息并开跑一轮(全景篇 §4 第 4-5 步)。prompt / skill / promptFromTemplate
	 * 三条入口都汇到这里。
	 * 参数 turnState 是**调用方已经冻结好**的快照 —— skill() 得先读快照里的 resources
	 * 才能找到技能,所以冻结发生在入口方法里而不是这里。
	 * 返回本轮最后一条 assistant 消息。
	 */
	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: AgentHarnessPromptOptions,
	): Promise<AssistantMessage> {
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		// nextTurn 队列**前置**在用户消息之前:它们是「上一轮结束后排给下一轮的话」,
		// 语义上早于这一次输入。emitQueueUpdate 抛错时 unshift 回滚(第二处回滚,见 §8)。
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
			messages = [...queuedMessages, messages[0]!];
		}
		// before_agent_start 是唯一能在开跑前整体改写「提示词 + 首批消息」的 hook。
		// 它返回的 messages 追加在**后面**(与 nextTurn 的前置正好相反),返回的
		// systemPrompt 覆盖本轮快照里那份,而且只覆盖这一轮。
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		return await this.runLoopToCompletion(
			turnState,
			this.createContext(turnState, beforeResult?.systemPrompt),
			// 这一层 lambda 存在的唯一理由:让 runLoopToCompletion 能同时服务
			// runAgentLoop(带首批消息开跑)与 runAgentLoopContinue(从尾巴续跑)。
			(context, config, emit, signal, streamFn) => runAgentLoop(messages, context, config, emit, signal, streamFn),
		);
	}

	// executeTurn / retryLastTurn 共享的运行机:装 abort、跑 loop、炸了合成错误尾巴、
	// 提取最后一条 assistant、finally 里 flush 挂起写入。
	/**
	 * 一次运行的通用外壳:装 abort → 跑 loop → 炸了就补失败尾巴 → 挑出最后一条
	 * assistant → finally 里再 flush 一次并清掉 AbortController。
	 * 参数 startLoop 是「怎么起这一跑」的策略(runAgentLoop / runAgentLoopContinue),
	 * 由调用方注入 —— 这是本文件里 runAgentLoop 与 runAgentLoopContinue 各自唯一的调用点。
	 * 失败:loop 抛错 → 走 emitRunFailure,于是 prompt() 拿到的是一条 stopReason:"error"
	 * 的消息而**不是** reject(test/harness/agent-harness.test.ts 的 "settles thrown hook
	 * failures" 钉住);连补尾巴都失败,才抛一个装着两条错误的 AggregateError。
	 */
	private async runLoopToCompletion(
		initialTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		context: AgentContext,
		startLoop: (
			context: AgentContext,
			config: AgentLoopConfig,
			emit: (event: AgentEvent) => Promise<void>,
			signal: AbortSignal,
			streamFn: StreamFn,
		) => Promise<AgentMessage[]>,
	): Promise<AssistantMessage> {
		// 闭包变量 + 一读一写两个函数:createStreamFn 与 createLoopConfig 拿到的是同一份
		// 「当前快照」的视图,prepareNextTurn 一换,两边同时看到新值。
		let activeTurnState = initialTurnState;
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		const abortController = new AbortController();
		// abort() 就是靠这个字段找到在飞的运行。它到这一行才被赋值 —— prompt() 里
		// createTurnState() 那段 session I/O 期间,abort() 抓不到任何东西(文档 §5)。
		this.runAbortController = abortController;
		// 立即执行的 async 函数:把「跑 loop + 失败兜底」整个收成一个 Promise,
		// 让下面的 try/finally 只负责取结果与善后,两件事不互相纠缠。
		const runResultPromise = (async () => {
			try {
				return await startLoop(
					context,
					this.createLoopConfig(getTurnState, setTurnState),
					(event) => this.handleAgentEvent(event, abortController.signal),
					abortController.signal,
					this.createStreamFn(getTurnState),
				);
			} catch (error) {
				// 补失败尾巴本身也可能炸(订阅者在 agent_end 回调里再抛一次)。那时把两条错误
				// 一起装进 AggregateError —— 丢掉任何一条都会让排查变成猜谜:原始故障与善后
				// 故障往往根本不是一回事。
				try {
					return await this.emitRunFailure(
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			// 从尾往前找最后一条 assistant:一轮的返回值定义为「模型最后说的那句话」,
			// 而 newMessages 的尾部通常还跟着一批 toolResult 消息。
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			// 一条 assistant 都没有 = loop 既没跑起来又没走失败路径,属于不该发生的状态。
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			// 兜底 flush:正常路径上 agent_end 已经排空过队列,这里管的是「loop 中途抛错、
			// agent_end 那一步没走到」的情形。
			// 内层 finally 保证即使 flush 再炸,runAbortController 也一定被清掉 ——
			// 否则下一次 abort() 会去 abort 一个早就结束的 controller。
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.runAbortController = undefined;
			}
		}
	}

	// ── §12 四条入口:prompt / skill / promptFromTemplate / retryLastTurn ──

	/**
	 * 发一句话,跑到模型不再要求调工具为止,返回最后一条 assistant 消息。
	 * 这是宿主用得最多的方法,全景篇 §4 阶段 1 的第 1 步。
	 * 失败:相位非 idle 时**同步**抛 busy(不排队);其余异常经 normalizeHarnessError 归一。
	 * 被 abort 时是 **resolve 而不是 reject** —— 中断是数据不是异常,要区分「取消」和
	 * 「完成」只能自己拿着 AbortController 对照。
	 */
	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		// 相位守卫必须在第一个 await 之前同步生效 —— 这就是"相位机而非锁"。
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		// 从这一行到 finally 之间,任何路径都必须保证相位最终回到 idle:
		// 正常路径由 handleAgentEvent 处理 agent_end 时拨回,异常路径由下面的 catch 拨回。
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			// 冻结快照放在 executeTurn 之外,是为了和 skill() / promptFromTemplate() 共用
			// 同一个「先冻结、再拿快照里的资源查名字」的顺序。
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			// 只有异常路径需要在这里拨相位(正常路径 agent_end 已经拨过了)。漏掉这一句,
			// 一次 createTurnState 失败就会让 harness 永久卡在 turn,之后每次 prompt 都报 busy。
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			// finishRunPromise 必须在 finally 里:漏掉的话 waitForIdle() 与 await 它的 abort()
			// 会永久挂住。
			finishRunPromise();
		}
	}

	/**
	 * 按名字调用一条技能(skill):把技能内容格式化成一段用户消息,再走同一条 executeTurn。
	 * 技能来自 resources.skills,而 resources 是**快照式**的(建会话时读一次),
	 * 改了技能文件要重开会话,或者由宿主自己 setResources()。
	 * 失败:名字不在清单里抛 invalid_argument —— 注意这次失败发生在冻结快照**之后**,
	 * 所以 catch 里那句 phase = "idle" 是必需的,不是复制粘贴的样板。
	 */
	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	/**
	 * 按名字套用一个提示词模板(prompt template),参数以字符串数组传入。
	 * 【现状】AgentHarnessResources.promptTemplates 全仓无人填写,prompt-templates.ts 的
	 * 磁盘加载器也没实现 —— 所以这条入口在当前形态下必然抛 Unknown prompt template。
	 * 它是给宿主预留的机制,不是死代码。
	 */
	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	/**
	 * 重跑上一条失败的助手回合,不追加新的用户消息。
	 *
	 * 机制对齐 pi 的官方重试挂载点:失败的 assistant 消息从本次运行的循环上下文里
	 * 被摘掉(会话树保留它 —— 同压缩,"改的是投影,不是历史"),然后从上一条可续
	 * 消息处 runAgentLoopContinue。若运行中途经过 save point,重建的快照会重新包含
	 * 这些失败条目(彼时已在上下文中段)—— 与 pi 恢复历史会话时中段错误上电线的
	 * 语义一致,provider 侧可以容忍。
	 *
	 * 何时重试、重试几次、退避多久,是应用层的策略;内核只提供机制,同 compact() 的分工。
	 */
	/**
	 * (上面那段 JSDoc 是原作者写的,这里补机制细节。)
	 * 相位用的是 "retry" 而不是 "turn":宿主据此区分「用户发的轮」和「系统补的轮」。
	 * 失败:transcript 尾部不是失败的 assistant 消息 → invalid_state;摘完之后上下文空了
	 * → 也是 invalid_state(没有可续的消息就没法 continue)。
	 * 谁来决定重试几次、退避多久,是应用层的事(桌面端在 kernel/src/host/retry.ts)。
	 */
	async retryLastTurn(): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "retry";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			// slice 一份再改:快照里的 messages 数组不能被就地 pop —— 它是 buildContext 的
			// 产物,还会被 createContext 等处读到。
			const messages = turnState.messages.slice();
			// 连续重试失败会在尾部堆多条 error assistant,一并摘掉。
			let stripped = 0;
			// 只认 stopReason === "error";"aborted" 的消息**不摘** —— 用户主动取消不该被
			// 自动重试当成故障重来一遍。
			while (messages.length > 0) {
				const last = messages[messages.length - 1]!;
				if (last.role === "assistant" && last.stopReason === "error") {
					messages.pop();
					stripped++;
					continue;
				}
				break;
			}
			if (stripped === 0) {
				throw new AgentHarnessError(
					"invalid_state",
					"retryLastTurn requires the transcript to end with a failed assistant message",
				);
			}
			if (messages.length === 0) {
				throw new AgentHarnessError(
					"invalid_state",
					"Nothing to retry: transcript is empty besides failed assistant messages",
				);
			}
			// 只换 messages 字段,model / 档位 / 工具 / systemPrompt 全部沿用原快照:
			// 重试的是「同一份现场」,换了配置就不叫重试了。
			const retryTurnState = { ...turnState, messages };
			return await this.runLoopToCompletion(
				retryTurnState,
				this.createContext(retryTurnState),
				// runAgentLoopContinue:从上下文最后一条可续消息接着跑,不追加新的用户消息。
				// 【要注意】它内部用的是 {...context},messages 数组**没有复制**,循环会直接往
				// 调用方的数组里 push;这里之所以安全,是因为 createContext 已经 slice 过一份。
				(context, config, emit, signal, streamFn) => runAgentLoopContinue(context, config, emit, signal, streamFn),
			);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	// ── §13 队列入口与 appendMessage ──────────────────────────────────────
	// ---- 队列操作:只在忙时有意义(nextTurn 例外,随时可排)-------------------

	/**
	 * 飞行中插话(steering):排进 steer 队列,loop 在下一个 turn_end 之后拉走。
	 * 当前这一轮的工具照常执行,不会被跳过 —— 插的是「下一次请求」的队,不是这一轮的。
	 * 失败:idle 时抛 invalid_state(没有在飞的运行,插话没有插的对象;想给下一轮留话
	 * 请用 nextTurn())。这是与 prompt 系列**方向相反**的相位守卫。
	 */
	async steer(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.steerQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	/**
	 * 将停时续摊(follow-up):只有在 agent 本来就要停下来的那一刻才被拉走,拉到就等于
	 * 「再来一整轮」。与 steer 的差别**只有拉取时机**,数据形状完全一样。
	 */
	async followUp(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.followUpQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	/**
	 * 排给下一次 prompt():**任何相位都能排**(与 steer / followUp 相反)。
	 * 它由 executeTurn 自己 splice 走,不经 loop 的任何回调;abort() 也**不清空**它 ——
	 * 用户在中断之前排的话应该留到下一轮。
	 */
	async nextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	// ---- 会话写入(Step 3/4:idle 直写,忙时入队)-----------------------------

	/**
	 * 往会话里追加一条消息(通常是宿主或订阅者合成的自定义消息)。
	 * idle 时直写,忙时排进挂起写入队列 —— 于是订阅者在 message_end 回调里写的东西
	 * 一定排在 agent 自己那条消息**之后**,不会插队(agent-harness.test.ts 的
	 * "orders pending listener session writes after agent-emitted messages" 钉住)。
	 * 失败:统一归一成 code "session"。
	 */
	async appendMessage(message: AgentMessage): Promise<void> {
		try {
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
			} else {
				this.pendingSessionWrites.push({ type: "message", message });
			}
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	// ── §14 结构性侧枝:compact / navigateTree ────────────────────────────
	// ---- 结构性会话操作:compact / navigateTree(M8)--------------------------
	// 两者都是 idle-only,**不走挂起写入队列**,直接写持久 session;各自占用一个相位,
	// finally 里归位。它们与 turn 循环没有交集 —— 是两条自包含的侧枝。

	/**
	 * 压缩上下文:把历史前半段交给模型总结成一段摘要,作为一条 compaction 条目追加进
	 * 会话树。之后 buildContext() 的投影就从这条摘要开始 —— **磁盘上一个字节都没删**。
	 * 参数 customInstructions 会拼进总结提示词。
	 * 返回 {summary, firstKeptEntryId, tokensBefore, details}。
	 * 失败:非 idle 抛 busy;没东西可压 / hook 取消 / 模型出错都抛 code "compaction"。
	 *
	 * 【分工】什么时候压是**应用层**的事(桌面端在 kernel/src/host/compaction.ts 里按
	 * contextWindow 阈值判);内核只提供这个机制 —— 与 retryLastTurn 同一种分工。
	 */
	async compact(
		customInstructions?: string,
	): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			// 压缩看的是**当前分支的全部条目**(root→leaf 的完整路径),不是 buildContext
			// 投影后的消息 —— 摘要要落到具体的条目 id 上(firstKeptEntryId)。
			const branchEntries = await this.session.getBranch();
			// prepareCompaction 是纯函数:定切点、算 tokensBefore、攒文件清单,不碰模型也
			// 不碰磁盘,失败以 Result 返回而不是抛异常。
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			// hook 可以取消压缩,或直接提供现成的摘要(自己调别的模型/走缓存)。
			// 注意 signal 传的是一个**刚 new 出来、永远不会 abort** 的 controller 的 signal。
			// 也就是说这条侧枝根本不可中断:harness.abort() 只作用于 runAbortController(轮次),
			// 对压缩无效(见文档 §5)。
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions,
				signal: new AbortController().signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			// 有 hook 给的现成摘要就不调模型;真调模型时第 5 个参数(signal)传的是 undefined,
			// 同上 —— 摘要那次请求同样不可中断。
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(preparation, this.models, model, customInstructions, undefined, this.thinkingLevel);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			// 到这一步才落盘:摘要生成途中失败的话,树分毫未动。
			// 最后一个参数 fromHook:标记这条摘要是 hook 给的还是模型生成的。hook 给的
			// details 是任意形状,下游不能假定里面有 readFiles / modifiedFiles。
			const entryId = await this.session.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				provided !== undefined,
			);
			// 读回条目只为了发事件;读不到或类型不对就静默跳过发事件 ——
			// 压缩本身**已经成功**了,返回值照常给,不能因为一条通知失败就报错。
			const entry = await this.session.getEntry(entryId);
			if (entry?.type === "compaction") {
				await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
			}
			return result;
		} catch (error) {
			throw normalizeHarnessError(error, "compaction");
		} finally {
			this.phase = "idle";
		}
	}

	/**
	 * 在会话树上跳到另一个条目(切分支 / 回到某句话之前),可选地把「被抛下的那条分支」
	 * 总结成一条 branch_summary 挂到新 leaf 下。
	 * 参数:targetId 目标条目;summarize 要不要总结;customInstructions /
	 * replaceInstructions 调总结提示词;label 给新 leaf 打标签。
	 * 返回 {cancelled, editorText?, summaryEntry?}。
	 * 失败:非 idle 抛 busy;目标不存在抛 invalid_argument;摘要失败抛 branch_summary。
	 */
	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.phase = "branch_summary";
		try {
			const oldLeafId = await this.session.getLeafId();
			// 已经站在目标上就是空操作:不发事件、不写树,也不算 cancelled。
			if (oldLeafId === targetId) return { cancelled: false };
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			// 求旧 leaf 与目标的最近公共祖先(LCA),被抛下的那一段就是「要总结的条目」。
			// 跳到同一条链上的祖先时这一段是空的,于是下面根本不会调模型。
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			};
			// 又一个永不 abort 的 signal —— 与 compact() 同样的限制。
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
			if (hookResult?.cancel) return { cancelled: true };
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: unknown = hookResult?.summary?.details;
			// 三个条件缺一不可:hook 没给现成摘要、调用方确实要摘要、而且真有东西可摘。
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const branchSummary = await generateBranchSummary(entries, {
					models: this.models,
					model,
					signal: new AbortController().signal,
					customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
					replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
				});
				if (!branchSummary.ok) {
					// 「被中断」当成用户取消而不是错误。因为上面那个 signal 永不 abort,
					// 这一支只可能由 provider 自己报 stopReason 为 aborted 触发。
					if (branchSummary.error.code === "aborted") return { cancelled: true };
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			// 目标是一条 user 消息 = "回到发这句话之前":leaf 落到它的父节点,
			// 原文交还给应用编辑后重发(这就是 CLI 里"编辑上一条消息重试"的实现)。
			let editorText: string | undefined;
			let newLeafId: string | null;
			// 三分支:目标是 user 消息或 custom_message 时,leaf 落到它的**父节点**并把原文
			// 交还给应用(editorText);其余类型的条目就停在它自己身上。
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				const content = targetEntry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}
			// moveTo 先追加一条 leaf 条目,带 summary 时再追加一条 branch_summary ——
			// 于是最终 leaf 是**摘要条目**而不是 newLeafId。想知道真实 leaf 得重新
			// getLeafId()(下面发事件时正是这么做的)。
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? { summary: summaryText, details: summaryDetails, fromHook: hookResult?.summary !== undefined }
					: undefined,
			);
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromHook: hookResult?.summary !== undefined,
			});
			return { cancelled: false, editorText, summaryEntry };
		} catch (error) {
			throw normalizeHarnessError(error, "branch_summary");
		} finally {
			this.phase = "idle";
		}
	}

	// ── §15 配置 getters / setters ────────────────────────────────────────
	// ---- 配置 getters/setters(Step 2/3)------------------------------------

	getModel(): Model<any> {
		return this.model;
	}

	/**
	 * 换模型。三步:写会话(idle 直写 / 忙时入队)→ 改配置字段 → 发事件。
	 * **本轮不生效**:在飞的那一轮读的是 turn 快照,要等下一个 save point 由
	 * prepareNextTurn 重建快照才被看见。
	 * 顺序刻意:先写会话再改字段 —— 写失败时字段不动,内存状态与磁盘不会分家。
	 */
	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
			}
			this.model = model;
			await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	/**
	 * 换思考档位,与 setModel 同构。注意 off 会让下一轮的 reasoning 变成 undefined(§8),
	 * 对 reasoning 模型等于关掉思考。
	 * 这里**不做**「这个模型支不支持这一档」的钳制 —— 钳制在 pi-ai 的 clampThinkingLevel
	 * 里、发请求时才做,所以传一个模型没有的档位是安全的。
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			if (this.phase === "idle") {
				await this.session.appendThinkingLevelChange(level);
			} else {
				this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
			}
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	/**
	 * 整体换掉工具表,可选地同时换激活集。
	 * 校验全部做在改字段之前(重名 / 激活名不在新表里 → invalid_argument),失败时
	 * harness 的状态一动不动。
	 * 只有激活集会写进会话(appendActiveToolsChange)—— 工具的**实现**没法序列化,
	 * 会话里记得下的只有名字。
	 */
	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			// 不传 activeToolNames 就沿用当前的:于是「换一批同名工具的新实现」不会顺手把
			// 激活集清空。
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(nextActiveToolNames);
			} else {
				this.pendingSessionWrites.push({ type: "active_tools_change", activeToolNames: [...nextActiveToolNames] });
			}
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	// 这里的非空断言是安全的:activeToolNames 的每一次赋值都过了 validateToolNames。
	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	/**
	 * 只换激活集,不动工具表。名字必须都在表里,否则 invalid_argument。
	 * 典型用法:同一批工具按会话阶段开合(比如先只给 read,确认方案后再放开 write)。
	 */
	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(toolNames);
			} else {
				this.pendingSessionWrites.push({ type: "active_tools_change", activeToolNames: [...toolNames] });
			}
			this.activeToolNames = [...toolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	// 【同名 setter,行为分两类】setSteeringMode / setFollowUpMode / setStreamOptions
	// 这三个**既不写会话也不发事件**,纯改内存;而 setModel / setThinkingLevel /
	// setTools / setActiveTools 都会写会话并发事件。别按名字想当然。
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpQueueMode = mode;
	}

	/**
	 * 返回资源的**副本**(两个数组各 slice 一份),外部改它不会影响 harness。
	 * createTurnState 也调它,所以每轮快照里的 resources 同样是独立副本。
	 */
	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	/**
	 * 换掉技能 / 提示词模板清单。资源是**快照式**的:harness 自己不去磁盘找,
	 * 加载与重载是宿主的事(全景篇 §4 阶段 0 的 0.4 步)。
	 * 它发的 resources_update 走 emitOwn,所以 on() 收不到。
	 */
	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	// 进出都拷贝一份,理由同 getResources。
	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	// ── §16 abort / waitForIdle / subscribe / on ──────────────────────────
	// ---- abort / waitForIdle -------------------------------------------------

	/**
	 * 中断在飞的轮次:清空 steer 与 followUp 两个队列(nextTurn 队列**保留**)、abort 掉
	 * 本轮的 AbortController,然后**等到运行真的结束**才返回。
	 * 返回被清掉的两个队列,方便宿主把它们回填进输入框。
	 * 失败:三段里任何一段抛错都不中断后面两段,最后汇总成 AggregateError 抛出 ——
	 * 「中断」这个动作本身不能因为一个观察者炸了就半途而废。
	 *
	 * 两条容易记反的事实:
	 *   · 它内部**已经** await 了 waitForIdle(),所以单独 await harness.abort() 就够;
	 *     真正的坑是**不 await** 就去看 phase —— 那时它还是 turn。
	 *   · 对 compact() / navigateTree() 无效:那两条侧枝不注册 runAbortController。
	 */
	async abort(): Promise<AbortResult> {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		// 清队列与 abort 之间没有 await,两件事在同一个微任务里完成,loop 没有插进来
		// 把刚清掉的队列又拉走的机会。
		this.runAbortController?.abort();
		const errors: Error[] = [];
		// 三段各自 try/catch 收集错误,而不是让第一个错误短路:队列已经清了、controller
		// 已经 abort 了,剩下的通知与等待必须照做完,否则 harness 会停在一个半中断的状态。
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	/**
	 * 等到当前运行彻底结束(包括所有被 await 的订阅者跑完)。
	 * 没有在飞的运行时 runPromise 是 undefined,await 一个 undefined 立刻返回。
	 * 【注意】compact() / navigateTree() 不建 runPromise,压缩期间调它也是立刻返回的。
	 */
	async waitForIdle(): Promise<void> {
		await this.runPromise;
	}

	// ---- 订阅(listener)与 hook 注册 ----------------------------------------

	/**
	 * 订阅**全部**事件(loop 的 10 种 AgentEvent + harness 自有的 19 种),挂进星号桶。
	 * 返回取消订阅的函数。
	 * 这是宿主真正该用的通道:桌面端投影器与 ACP 适配器都挂在这里。
	 * listener 抛错不会被吞 —— 会一路冒进轮次,把整轮变成一次失败运行。
	 */
	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	/**
	 * 注册一个**有返回值**的 hook,按事件类型分桶。返回取消注册的函数。
	 * 【关键】只有走 emitHook / emitBeforeProviderRequest / emitBeforeProviderPayload 的
	 * 8 种是活的:before_agent_start / context / tool_call / tool_result /
	 * session_before_compact / session_before_tree / before_provider_request /
	 * before_provider_payload。
	 * 其余 11 种(queue_update / save_point / abort / settled / after_provider_response /
	 * session_compact / session_tree / model_update / thinking_level_update /
	 * resources_update / tools_update)走 emitOwn,**注册了也永远不会触发**,
	 * 要收它们只能用 subscribe()。
	 * 类型系统在这里帮不上忙:AgentHarnessEventResultMap 把 19 种全列进去了。
	 */
	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}
}
