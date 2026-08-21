/**
 * Agent (step 1–5): stateful wrapper around agent-loop.
 * Step 4: steer() / followUp() queues + continue().
 * Step 5: default toolExecution is "parallel" (loop also supports sequential + length-fail).
 */

/**
 * 补充说明(对应学习文档:docs/learn/agent/agent.md):
 * 一句话职责:Agent 类是 agent-loop.ts 里裸函数 runAgentLoop/runAgentLoopContinue 的
 * 有状态包装 —— 把「一次调用返回一批消息」的纯函数,包成一个可以订阅、可以排队插话、
 * 可以查询当前状态的长期对象。
 * 在全景篇的链路上:它与 harness/agent-harness.ts 是同一层级的两种实现,但**本仓生产
 * 代码不走这里** —— 桌面端与 ACP 都直接用 AgentHarness。这个文件的价值是「参考实现」:
 * harness 里的相位机、turn 快照、事件转发,这里都有一个更小的原型。
 * 分节索引:
 *   §1 模块级辅助 —— 默认值、未配置 streamFn 时的占位符、convertToLlm 默认实现
 *   §2 MutableAgentState —— 内部可变状态与 tools/messages 的访问器包装
 *   §3 PendingMessageQueue —— steer/followUp 共用的队列实现,drain 模式二选一
 *   §4 AgentOptions / ActiveRun —— 公开配置契约与单飞行运行态
 *   §5 Agent 类:构造、订阅、只读访问器、队列操作
 *   §6 prompt() / continue() —— 两条外部入口与它们各自的内部转发路径
 *   §7 运行时生命周期 —— runWithLifecycle 单飞行守卫、失败兜底、finishRun 收尾
 *   §8 processEvents —— 事件驱动状态机的唯一落点,状态回灌 + 监听器分发
 */

import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

// ── §1 模块级辅助:默认值、未配置 streamFn 时的占位符、convertToLlm 默认实现 ──────────────────────────────
// streamFn 是 Agent 真正发起 LLM 调用的地方,构造时不强制传入(方便先搭骨架再接真实模型)。
// 不传时不是静默什么都不做,而是每次真正尝试调用时才炸出一个可读的报错,
// 指名道姓地告诉调用方该传什么 —— 比「undefined is not a function」这种运行时报错好定位得多。
const noStreamFnConfigured: StreamFn = () => {
	throw new Error(
		"no streamFn configured. Pass streamFn, e.g. (model, ctx, opts) => models.streamSimple(model, ctx, opts).",
	);
};

/**
 * convertToLlm 的默认实现:只保留 LLM 认得的三种角色(user/assistant/toolResult),
 * 过滤掉应用层可能通过 CustomAgentMessages 声明合并塞进来的自定义消息类型
 * (例如 UI 专用的通知消息)。调用方可以通过 AgentOptions.convertToLlm 整个换掉这个函数。
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

// 失败兜底消息(见 §7 handleRunFailure)要满足 AgentMessage 的类型约束,
// 必须带一个 usage 字段 —— 全零是因为这一条从没真的问过模型,没有真实用量可报。
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// 构造 Agent 时不传 initialState.model 也能用 —— 用这个占位 Model 兜底,
// 好让类型系统上没有可选的 model,同时把「还没选模型」变成一个显式可辨认的值
// (id/name/provider 全是 "unknown")而不是 undefined。真正发请求前必须换成真实模型。
const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

// ── §2 MutableAgentState:内部可变状态与 tools/messages 的访问器包装 ──────────────────────────────
// AgentState(types.ts)对外是只读快照;Agent 内部需要一个可写版本。
// isStreaming/streamingMessage/errorMessage 在公开类型里是 readonly,这里去掉 readonly 好让
// processEvents(§8)能直接赋值;pendingToolCalls 额外要求是 Set(公开类型只承诺 ReadonlySet)。
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/**
 * 造一份初始的 MutableAgentState。
 * tools/messages 用闭包变量 + getter/setter 实现「赋值即拷贝」:
 * AgentState 的接口注释写明「assigning a new array copies the top-level array」,
 * 这里就是这条契约的落地 —— 调用方把自己手上的数组赋给 state.tools 之后,
 * 再改自己那份数组不会悄悄改到 Agent 内部持有的那份。
 */
function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

// ── §3 PendingMessageQueue:steer/followUp 共用的队列实现,drain 模式二选一 ──────────────────────────────
// Agent 有两条独立队列(steeringQueue / followUpQueue,见 §5 构造函数),都用这一个类实现,
// 区别只在 mode:"all" 一次性倒空,"one-at-a-time" 每次只吐最老的一条、其余留到下次 drain。
// "one-at-a-time" 存在的理由:插话如果一次性全灌进去,模型可能在同一轮里把后面几条也
// 当成当前这条的补充一并回应,而不是像用户期望的那样分轮处理。
/** Queue of messages drained by the loop via getSteeringMessages / getFollowUpMessages. */
class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	// "one-at-a-time" 分支返回的是长度至多为 1 的数组(而不是单个消息),
	// 是为了让 getSteeringMessages/getFollowUpMessages 两种 mode 下调用方拿到的形状一致,
	// 不用在 createLoopConfig(§6)里为两种 mode 分别处理。
	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

// ── §4 AgentOptions / ActiveRun:公开配置契约与单飞行运行态 ──────────────────────────────
/**
 * 构造 Agent 时可传的全部选项。多数字段直接透传给 agent-loop 的 AgentLoopConfig
 * (见 types.ts 里对应字段的注释,契约是共享的);steeringMode/followUpMode 是本文件
 * 独有的,决定两条队列各自用哪种 drain 策略。
 */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Legacy variant: only receives the run's abort signal. Ignored when `prepareNextTurnWithContext` is set. */
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Session identifier forwarded to providers for cache-aware backends. */
	sessionId?: string;
	toolExecution?: ToolExecutionMode;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

// 单飞行守卫的载体:Agent 同一时间只允许一次 prompt/continue 在跑,activeRun 是否存在
// 就是这个「正在跑」标志本身。promise 给 waitForIdle() 用,resolve 由 finishRun()(§7)调用,
// abortController 是这一次运行专属的(不是复用同一个),每次运行都是一个全新的信号源。
type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

// ── §5 Agent 类:构造、订阅、只读访问器、队列操作 ──────────────────────────────
/**
 * Stateful wrapper around the low-level agent loop.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	/** Legacy variant: only receives the run's abort signal. Ignored when `prepareNextTurnWithContext` is set. */
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	public toolExecution: ToolExecutionMode;
	private activeRun?: ActiveRun;

	/**
	 * 只做装配,不发起任何调用。每个可选钩子字段落一个默认值或原样保留 undefined,
	 * toolExecution 默认 "parallel"(与全景篇 §2.2 提到的"裸循环默认并行"一致,
	 * agent-loop.ts 本身对 sequential/length-fail 两条路也都支持,只是不是这里的默认)。
	 */
	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? noStreamFnConfigured;
		this.getApiKey = options.getApiKey;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
		this.sessionId = options.sessionId;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get state(): AgentState {
		return this._state;
	}

	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Inject after the current assistant turn finishes (during an active run). */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	// 只有在 activeRun 存在期间才有值 —— 用来给外部钩子(beforeToolCall 等)转发
	// "这次运行的中断信号",空闲时没有意义,返回 undefined 而不是造一个假信号。
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** 只发出中断请求,不等它生效 —— phase 真正落定要等 waitForIdle()。*/
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	// 没有 activeRun 时直接给一个已 resolve 的 Promise —— 调用方不用先判断"是不是在跑"
	// 再决定要不要 await,永远可以无条件 await waitForIdle()。
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** 清空全部状态与队列。不检查是否正在运行 —— 调用方要自己保证空闲期调用。*/
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearAllQueues();
	}

	// ── §6 prompt() / continue():两条外部入口与它们各自的内部转发路径 ──────────────────────────────
	/**
	 * 发起一轮新对话。重载支持三种输入:纯字符串(+可选图片)、单条 AgentMessage、
	 * 或一批 AgentMessage 一次性作为本轮开局消息。
	 * 单飞行守卫在这里生效:已有 activeRun 时同步抛错,不排队 —— 与 harness 的
	 * "busy 就抛,不排队"是同一条设计(见仓库 CLAUDE.md「harness 的三个行为」),
	 * 想追加消息应该用 steer()/followUp() 而不是再调一次 prompt()。
	 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/**
	 * Continue from the current transcript.
	 * If last message is assistant, drains steering then follow-up instead of erroring when queued.
	 */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages.at(-1);
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				// Already drained — skip the loop's first steering poll so we don't double-drain.
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	/**
	 * 把 prompt() 三种重载的输入统一成 AgentMessage[]。
	 * 字符串输入会现造一条 user 消息:content 先放文本块,再在有图片时追加图片块
	 * (顺序固定为「文本在前、图片在后」,不是模型强制要求,只是这里的既定行为)。
	 */
	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	/**
	 * prompt() 与 continue() 里"有排队消息要注入"两条路径的共同落点:
	 * 包一层 runWithLifecycle(§7)拿到守卫好的 signal,再把 messages 连同当前上下文
	 * 一起交给裸函数 runAgentLoop。skipInitialSteeringPoll 只在 continue() 已经手动
	 * drain 过 steeringQueue 时为 true,防止 loop 开局又 drain 一次导致同一批消息被处理两遍。
	 */
	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	/**
	 * continue() 在最后一条消息不是 assistant、且两条队列都空时走这里 ——
	 * 对应"上一轮被中断/出错,想不带新消息地把当前上下文再喂一次模型"的场景,
	 * 调用的是裸函数 runAgentLoopContinue 而不是 runAgentLoop(不追加 prompts)。
	 */
	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	// 每次运行都现造一份快照(.slice() 拷贝数组),不直接把 _state 的引用交给 loop ——
	// loop 跑在这份快照上,而 _state.messages 在运行期间还会被 processEvents(§8)持续追加,
	// 两者必须是不同的数组,否则边跑边改会互相踩。
	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	/**
	 * 把 Agent 实例上的可选钩子/状态,组装成裸循环认得的 AgentLoopConfig。
	 * reasoning 字段在这里落定:thinkingLevel === "off" 时传 undefined 而不是 "off" 本身 ——
	 * 与仓库 CLAUDE.md 记录的 harness 那份同一条规则(off 会把 reasoning 整个从请求里摘掉)。
	 */
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		// 闭包变量而不是 options 上的字段:第一次调用 getSteeringMessages 之后立刻翻转,
		// 保证"跳过开局那一次 poll"只生效一次,同一个 config 后续任何轮次仍正常 drain。
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			// 两个 prepareNextTurn 变体只留一个会被真正调用:有 WithContext 版本就优先用它
			// (拿得到完整 ShouldStopAfterTurnContext),legacy 版本只在没有前者时才 fallback,
			// 且 legacy 版本只收到 signal,拿不到 context —— 这是它被标为 legacy 的原因。
			// 两者都没配置时,整个 prepareNextTurn 字段是 undefined(不传一个空函数),
			// 好让裸循环内部可以用「有没有这个字段」做判断而不是「调了会不会返回 undefined」。
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context: PrepareNextTurnContext) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			// 只有开局这一次可能被跳过,翻转标志之后后续每次调用都正常 drain ——
			// 呼应 continue() 里 "Already drained — skip the loop's first steering poll" 那条注释。
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	// ── §7 运行时生命周期:runWithLifecycle 单飞行守卫、失败兜底、finishRun 收尾 ──────────────────────────────
	/**
	 * prompt()/continue() 最终都汇入这里。职责三件事:
	 * (1) 再次确认单飞行(双重保险 —— prompt()/continue() 已经各自查过一次 activeRun,
	 *     这里是 runPromptMessages/runContinuation 共同的收口,保证不管谁调都受同一道闸门管);
	 * (2) 建 AbortController 与可等待的 promise,写进 activeRun;
	 * (3) 跑 executor,失败时转交 handleRunFailure 而不是直接把异常甩给调用方 ——
	 *     这样调用方总能通过订阅的 agent_end 事件感知到"这轮结束了",不用额外包 try/catch。
	 */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	/**
	 * executor 抛出时的兜底路径:合成一条 stopReason 为 "error" 或 "aborted" 的空 assistant
	 * 消息,依次补发 message_start/message_end/turn_end/agent_end 四个事件 —— 让订阅者看到
	 * 的事件序列形状与"正常跑完一轮"一致,不用为"抛异常"单独写一套处理逻辑。
	 * aborted 由 signal.aborted 判定,不是靠 error 的类型分辨 —— abort() 触发的中断
	 * 在 agent-loop 内部也是当成数据处理,不是异常路径。
	 */
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? ("aborted" as const) : ("error" as const),
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	/**
	 * runWithLifecycle 的 finally 分支,不管成功失败都会跑。
	 * 顺序要点:先复位状态,再 resolve activeRun.promise(唤醒 waitForIdle 的等待方),
	 * 最后才把 this.activeRun 置 undefined —— resolve 必须在清空引用之前调用,
	 * 否则闭包里已经拿不到那个 resolve 函数了。
	 */
	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	// ── §8 processEvents:事件驱动状态机的唯一落点,状态回灌 + 监听器分发 ──────────────────────────────
	/**
	 * agent-loop 发出的每个 AgentEvent 都先过这里,再转发给外部订阅者。
	 * 两件事分两步做:先按事件类型把 _state 更新到位(下面的 switch),
	 * 再无条件遍历 listeners 通知出去 —— 保证外部监听者读到的 state 永远是"更新之后"的。
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			// 每次都新建一个 Set 而不是原地 add/delete —— 与 tools/messages 的拷贝语义一致,
			// 好让外部把 state.pendingToolCalls 存下来的旧引用不会被后续变更悄悄改掉。
			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			// errorMessage 只在这里被设置、且从不主动清空 —— 下一轮成功跑完也不会重置它,
			// 调用方要判断"当前是不是还带着错误"得自己在下一次 prompt() 前处理,
			// 或者依赖 isStreaming/turn_end 的时序自行判断这条错误是不是"新鲜"的。
			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		// 理论上不会发生:processEvents 只在 runWithLifecycle 建好 activeRun 之后
		// 才会被当作 emit 回调传给 runAgentLoop,这里的检查是防御性的最后一道断言。
		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
