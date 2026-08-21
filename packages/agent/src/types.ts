/**
 * 职责:packages/agent 的契约文件 —— 裸循环、会话外壳与工具层之间所有共享形状的
 * 唯一定义处。整个文件零运行时代码(只有 type / interface,编译后不产生任何 JS),
 * 但每个字段的语义就是行为规范:agent-loop.ts 是这些契约的唯一实现者,
 * harness 与 coding-agent 是它们的唯一填写者。
 *
 * 全景位置:它不在「一次 prompt」的执行路径上,而是那条路径的**词汇表**。
 * 全景篇(docs/learn/00-内核全景.md)§4 的每一步都在读写这里的某个形状:
 *   - 阶段 1 第 7 步 createLoopConfig 填的是 §6 的 AgentLoopConfig;
 *   - 阶段 1 第 8 步 createStreamFn 造的是 §2 的 StreamFn;
 *   - 阶段 3 第 15 步过 LLM 边界的是 §8 的 AgentMessage → pi-ai Message;
 *   - 阶段 5 第 31-35 步两个工具钩子的入参出参全在 §4;
 *   - 阶段 6 第 38-39 步 prepareNextTurn / shouldStopAfterTurn 的入参出参在 §5;
 *   - 订阅者(桌面端投影器 / ACP)看到的十种事件在 §12。
 * 删掉这个文件,agent-loop.ts / agent.ts / harness/* / coding-agent 的工具层会同时
 * 失去共同语言 —— 它是「ai 不知道有 agent、agent 不知道有 read/write/gdb」这两条
 * 包边界的书面形式。
 *
 * 一条贯穿全文的设计:**失败是数据不是异常**(全景篇 §3 第一组)。
 * StreamFn 与 AgentLoopConfig 里几乎每个回调都写着 must-not-throw,原因很物理:
 * agentLoop() 里是 `void runAgentLoop(...).then(...)`,**没有 .catch**;
 * 回调一抛,得到的是一个未处理的 Promise rejection 加一个永远不 end() 的
 * EventStream,`await stream.result()` 直接挂死。Agent 类与 harness 各自补了兜底,
 * 裸 loop 没有 —— 所以这些契约是靠约定维持的,不是靠类型系统。
 *
 * 对应学习文档:docs/learn/agent/types.md
 *
 * 分节索引:
 *   §1  导入 —— 从 pi-ai 借来的十二个形状,加 typebox 的两个
 *   §2  StreamFn —— 循环与 provider 之间唯一的插槽
 *   §3  两个模式开关 —— ToolExecutionMode / QueueMode
 *   §4  工具钩子的入参与出参 —— AgentToolCall 与 Before-/AfterToolCall{Result,Context}
 *   §5  轮末钩子的入参与出参 —— ShouldStopAfterTurnContext / AgentLoopTurnUpdate
 *   §6  AgentLoopConfig —— 裸循环的全部可注入面
 *   §7  ThinkingLevel —— 含 off 的七档,与 pi-ai 的 ThinkingLevel 不是同一个类型
 *   §8  CustomAgentMessages / AgentMessage —— 声明合并撑开的消息联合
 *   §9  AgentState —— 长命状态(Agent 类持有,harness 不实现)
 *   §10 工具契约 —— AgentToolResult / AgentToolUpdateCallback / AgentTool
 *   §11 AgentContext —— 一次运行的输入快照
 *   §12 AgentEvent —— 十种事件,run / turn / message / tool 四级节奏
 */
// ── §1 导入:从 pi-ai 借来的形状 ──────────────────────────────────────────
// 全部是 `import type`,一个值都不导入 —— 这保证本文件编译后是空的,
// 不会给包根入口(浏览器安全的 index.ts)引入任何副作用或体积。
// 借来的十二个形状分三类:
//   1. 消息与内容块:Message / AssistantMessage / ToolResultMessage /
//      TextContent / ImageContent
//   2. 请求的输入与流式输出协议:Context / Model / Api / SimpleStreamOptions /
//      AssistantMessageEvent / AssistantMessageEventStream
//   3. 工具的最小形状:Tool(只有 name / description / parameters 三个字段)
// 反方向一个也没有:pi-ai 不 import 本包的任何东西。这条单向依赖就是
// 「ai 不知道有 agent」这条边界的物理形式(全景篇 §0)。
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
// typebox 的两个:TSchema 是「一份 JSON Schema」的类型,Static<T> 把它反解成对应的
// TS 类型 —— §10 的 AgentTool 靠这一对做到「schema 写一次,execute 的 params 类型
// 自动跟着走」。typebox 是本包 package.json 里的**直接依赖**,不是从 pi-ai 转手拿的,
// 两个包各自 import 同一个版本(版本对不上时 TSchema 会名义不兼容,typecheck 变红)。
import type { Static, TSchema } from "typebox";

// ── §2 StreamFn:循环与 provider 之间唯一的插槽 ───────────────────────────
// 它是 runAgentLoop 的**第 6 个参数**,刻意不放进 AgentLoopConfig —— 因为它管的是
// 「怎么跟模型说话」,而 config 管的是「循环怎么跑」。两个填写者:
//   - harness 的 createStreamFn:在这里插入三个 provider 钩子
//     (before_provider_request / before_provider_payload / after_provider_response),
//     所以它是 async 的;
//   - Agent 类:直接把 models.streamSimple 塞进来。
// 与 pi-ai 的 StreamFunction 相比只放宽了一处:允许返回 Promise<流>,harness 那个
// 要先 await 钩子的实现才写得出来。循环侧统一用 `await streamFunction(...)` 吃下两种。
// 不传时会落到 agent-loop.ts 的 noStreamFnConfigured,那是全文件唯一一处刻意**同步
// throw** 的地方 —— 因为「忘了接模型」是装配错误,不是运行时失败,不该被编码成
// 一条 stopReason:"error" 的消息混进 transcript。
/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

// ── §3 两个模式开关:ToolExecutionMode / QueueMode ────────────────────────
// ToolExecutionMode 有两个落点,语义不同:
//   1. AgentLoopConfig.toolExecution —— 整个 run 的默认模式;
//   2. AgentTool.executionMode(§10)—— 单个工具自己的声明。
// 合流规则在 agent-loop.ts:executeToolCalls:这一批 toolCall 里**只要有一个**工具
// 声明了 "sequential",整批(包括同批的 read / bash)就退成串行。也就是说它是
// **批级传染**的,而且**只能单向升级** —— 把某个工具标成 "parallel" 并不能把
// config 的 sequential 拉回并行。
// 这是嵌入式工具防止两条 gdb / flash 同时抢探针、文件工具防止并发覆盖的唯一手段:
// 本仓 write / edit / gdb / log 四个工具声明了 sequential。
// 注意 harness 的 createLoopConfig **从不填** toolExecution,所以桌面端与 ACP 上
// 这个字段永远是 undefined,实际默认走并行分支。
/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

// QueueMode 只被 Agent 类与 harness 用来决定「一次 drain 取几条」,**裸循环看不见
// 它** —— 循环只调 getSteeringMessages() / getFollowUpMessages(),取多少条完全是
// 实现方的事。两个队列各有各的模式,两边默认都是 "one-at-a-time"。
// "one-at-a-time" 的意义:用户连打三句话时,agent 一个 turn 消化一句,中间还能被
// 工具执行与 prepareNextTurn 打断;"all" 则会把三句一次性拼进同一次请求。
/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

// ── §4 工具钩子的入参与出参 ──────────────────────────────────────────────
// 这一节五个形状全部服务于两个钩子:beforeToolCall(执行前,可拦)与 afterToolCall
// (执行后,可改写),对应全景篇 §4 的第 32 步与第 35 步。harness 把它们翻译成
// emitHook("tool_call") / emitHook("tool_result") 两个可被宿主订阅的钩子。
// AgentToolCall 不是新类型,而是从 AssistantMessage.content 这个三元联合
// (TextContent | ThinkingContent | ToolCall)里 Extract 出 type === "toolCall" 的
// 那一支,等价于 pi-ai 的 ToolCall{id, name, arguments, thoughtSignature?}。
// 用 Extract 而不是直接 import ToolCall 的好处:pi-ai 哪天往 assistant 内容块里加了
// 新形状,这里自动跟着走,不会出现「本包认得的 toolCall 和 provider 发的不是同一个
// 东西」。循环就是靠这个类型作为守卫从 message.content 里筛出工具调用的。
/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

// BeforeToolCallResult:钩子唯一能表达的意图就是「拦不拦」。
// 两个字段都可选,于是 undefined、{}、{block:false} 三者等价于放行。
// 拦下时循环**不抛错也不跳过**这次调用,而是造一条 isError 的正常工具结果顶上,
// reason 成为结果文本(省略时用默认的 "Tool execution was blocked")。
// 这是「失败是数据」在工具层的兑现:transcript 里 toolCall 与 toolResult 永远配对,
// 模型下一轮能读到理由并改口,而不是看到一个凭空消失的调用。
/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

// AfterToolCallResult:执行完之后的**部分覆盖补丁**,四个字段各自独立。
// 合并写在 agent-loop.ts:finalizeExecutedToolCall,用的是 `补丁字段 ?? 原值`:
//   - 省略字段 = 保留工具原本的值;
//   - 给了字段 = 整个替换,content 与 details 都**没有深合并**;
//   - 给 details: null 会因为 ?? 落回原值,想清空得给一个空对象。
// 还有一个刻意不在这个类型里的字段:addedToolNames(§10)。合并用的是
// `{ ...result, ... }`,所以工具自己声明的 addedToolNames 一定被保留,钩子改不掉。
/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	// terminate 的合并同样是 `补丁.terminate ?? 原结果.terminate`,判空的是**补丁侧**:
	// 钩子返回 terminate:false 会把工具原本的 true 抹掉。
	// (全景篇 §4 第 35 步写的「只能补 undefined 不能抹 true」把两个操作数记反了,
	//  以代码为准 —— 见 agent-loop.ts:finalizeExecutedToolCall。)
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

// BeforeToolCallContext:钩子拿到的现场。四个字段全是**活引用**而不是快照,
// 就地改动会真的影响后续执行 —— 这既是它的能力,也是它最容易伤到自己的地方。
/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	// args 是 validateToolArguments 校验并 Value.Convert 强转**之后**的对象本体。
	// 就地改它会真的改掉传给 execute 的参数,而且**不会重新校验**:
	// agent-loop.test.ts 的 "should execute mutated beforeToolCall args without
	// revalidation" 专门钉住了这个行为(改成数字也照跑)。
	// 要挡就返回 {block:true},不要靠改 args 来「修正」模型的输入。
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	// context 是 loop 正在就地修改的那个 AgentContext(§11),不是拷贝:
	// 此刻 messages 里已经有本轮的 assistant 消息,但还没有任何 toolResult。
	// 往里 push 东西会直接影响下一次请求 —— 能做,但没有任何地方为它兜底。
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

// AfterToolCallContext 比 Before 多两个字段:result(已执行出的结果)与 isError。
// isError 只有两个来源:工具 throw 被 catch 成错误结果时为 true,正常返回时为 false。
// 所以工具**不该**把错误编进 content 再正常返回 —— 那样 isError 是 false,
// 前端会画成成功卡片,这个钩子也拿不到「失败」这个信号。
/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	// result 是 afterToolCall 覆盖生效**之前**的那份。补丁与它合并之后才会 emit
	// tool_execution_end、才会造 ToolResultMessage:钩子看到的是「工具说了什么」,
	// 订阅者看到的是「合并之后说了什么」,两者可以不同。
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

// ── §5 轮末钩子的入参与出参 ──────────────────────────────────────────────
// 一个 turn(= 一条 assistant 消息 + 它那批工具调用与结果)跑完、turn_end 发出之后,
// 循环连着问两个问题:先 prepareNextTurn(要不要换现场?),再 shouldStopAfterTurn
// (要不要收工?)。**次序不能反** —— shouldStopAfterTurn 拿到的 context 是
// prepareNextTurn 换过之后的那一份,「该不该停」要看新上下文的大小,而不是旧的。
// 见全景篇 §4 第 38-39 步。
// ShouldStopAfterTurnContext 同时也是 PrepareNextTurnContext 的基类(见本节末尾),
// 两个钩子拿到的入参形状完全相同,只有返回值不同。
// 除了本文件 shouldStopAfterTurn 的签名,全仓再没有第二处按名字引用这个 interface:
// 循环是就地用字面量构造它的(agent.ts 引用的是它的子类型 PrepareNextTurnContext)。
// 它的价值只是给实现方一个可以 import 的名字。
/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	// newMessages 是「本次 loop 调用最终会返回给调用方」的那个数组**本体**(不是拷贝),
	// 循环还在往里 push。两个入口的含义不同:runAgentLoop 从 [...prompts] 起步,
	// 所以包含本次的用户消息;runAgentLoopContinue 从 [] 起步,续跑之前就存在的
	// 上下文消息一条都不在里面。宿主拿它做「这一轮新产生了什么」的依据时要分清。
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

// AgentLoopTurnUpdate 是 prepareNextTurn 的**返回**形状:三个字段全可选,给谁换谁,
// 整个返回 undefined 表示什么都不动。循环把它应用到 currentContext 与 config 上,
// 而且 config 是**浅拷贝一份**再改,不会污染调用方手里的那个对象。
// 这是「说话中途换模型 / 换档位 / 换上下文」唯一真正生效的入口:harness 的
// setModel / setThinkingLevel 改的是配置字段而不是本轮的冻结快照,要到下一个
// save point 由 prepareNextTurn 重建快照才被看见(全景篇 §3「turn 快照」)。
// 桌面端的自动压缩也落在这里 —— 在 prepareNextTurn 里换上压缩后的 context,
// 而不是在下一次请求里临时裁剪(临时裁剪是 transformContext 的活,它不持久)。
/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	// thinkingLevel 会被翻译成 config.reasoning,三分支:
	//   undefined → 保持原样;"off" → 把 reasoning 整个设成 undefined(等于把
	//   reasoning 从请求选项里摘掉);其余六档 → 原样传下去。
	// **undefined ≠ "off"** 是本文件最容易读错的一处三元。对 reasoning 模型来说,
	// "off" 意味着最强的那一档被关掉,而且请求体里看不出任何痕迹。
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

// 空 extends 的别名:入参与 shouldStopAfterTurn 完全一致,单独起个名字只是为了让
// 实现方的签名读起来对得上钩子名。改其中一个钩子的入参时另一个自动跟着变 ——
// 这是有意的,两个钩子必须看到同一个现场,否则「先换再判」的次序就失去意义。
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

// ── §6 AgentLoopConfig:裸循环的全部可注入面 ──────────────────────────────
// 本文件最重要的一个形状:runAgentLoop 的第 3 个参数,循环所有「不由自己决定」的
// 行为都从这里进来。它 extends pi-ai 的 SimpleStreamOptions,于是同时带着那 18 个
// **流选项**(StreamOptions 的 16 个 + SimpleStreamOptions 自己加的 reasoning /
// thinkingBudgets):temperature / maxTokens / signal / apiKey / transport /
// cacheRetention / sessionId / onPayload / onResponse / headers / timeoutMs /
// websocketConnectTimeoutMs / maxRetries / maxRetryDelayMs / metadata / env。
// 一个容易忽略的后果:agent-loop.ts:streamAssistantResponse 是
// `streamFunction(config.model, llmContext, { ...config, apiKey, signal })` ——
// 整个 config **原样摊进流选项**,convertToLlm / prepareNextTurn 这些回调也一并
// 被交给了 provider。provider 只读自己认识的字段所以无害,但在 onPayload 钩子里
// 看到它们不要惊讶。
// 自有字段一共十一个,只有 model 与 convertToLlm 必填。harness 的 createLoopConfig
// 填其中八个:model / convertToLlm / transformContext / beforeToolCall /
// afterToolCall / prepareNextTurn / getSteeringMessages / getFollowUpMessages,
// **没填** toolExecution / shouldStopAfterTurn / getApiKey;它另外还填了一个继承来的
// 流选项 reasoning(由 turnState.thinkingLevel 翻译而来,"off" → undefined)。
export interface AgentLoopConfig extends SimpleStreamOptions {
	// 唯一必填的非函数字段。写成 `Model<any>` 而不是 `Model<Api>`:注册表里取出来的
	// 模型一律退化成宽类型,要恢复精确的 api 类型得用 pi-ai 的 hasApi() 守卫。
	// 它可以被 prepareNextTurn 中途换掉(§5),换的是 config 浅拷贝里的这一项。
	model: Model<any>;

	// convertToLlm 是**整个内核唯一的 LLM 边界**(全景篇读图要点 2):
	// AgentMessage[](可以含自定义角色)→ pi-ai Message[](只有 user/assistant/
	// toolResult 三种角色)。本仓唯一的实现是 harness/messages.ts:convertToLlm,
	// 四个自定义角色在那里被投影成 user 消息或直接丢弃。
	// 它必填,因为循环无法猜测「一个自定义角色该怎么变成模型看得懂的东西」;
	// 只有原生三种消息的调用方也得写一个恒等函数(测试里就是这么干的)。
	// 返回值只喂给本次请求,**不写回 context.messages** —— 转换是纯投影。
	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	// transformContext 与 convertToLlm 的分工:前者在 AgentMessage 层面动(裁剪、
	// 注入),后者只做降维。执行顺序是 transformContext → convertToLlm。
	// **它的返回值同样不写回 context.messages**,所以拿它做上下文压缩等于「每一轮
	// 重算一遍」,想让裁剪持久生效必须走 prepareNextTurn(§5)。
	// harness 把它接到 emitHook("context") 上,hook 没返回时原样返回入参。
	// 它是本节唯一收 signal 的非工具类回调 —— 因为它可能要跑一次真实的模型调用。
	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	// getApiKey 与继承来的 apiKey 是「动态优先于静态」的关系:循环里是
	// `(await getApiKey(provider)) || config.apiKey`,用的是 ||(不是 ??),
	// 所以返回空字符串也会落回静态 apiKey。
	// 本仓两个宿主都没填它:桌面端与 ACP 的凭据由 pi-ai 注册表在 resolveProviderAuth
	// 里解析,根本不走这条路。它是给 OAuth 短时令牌留的口子 —— 长工具阶段可能把
	// 一小时前拿到的 token 熬过期,而 Context 是每轮现拼的,正好每轮问一次。
	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	// shouldStopAfterTurn 在本仓**没有任何生产者**:harness 不填,Agent 类也不填,
	// 全仓唯一的引用就是循环里那一次调用。它是留给宿主做「优雅收工」的口子
	// (例如上下文快满了就停在这一轮),桌面端选择了另一条路 —— 在 prepareNextTurn
	// 里压缩而不是停下来,于是用户看不到「被系统叫停」这种体验。
	// 语义要点:返回 true 时循环 emit agent_end 就 return,**两个队列都不拉** ——
	// 已经排队的 steering / follow-up 消息会留在队列里等下一次 prompt。
	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	// prepareNextTurn 是 harness 所谓 save point 的一半:flush 挂起写入 →
	// createTurnState() 重建冻结快照 → setTurnState() 更新闭包 → 把新的
	// context / model / thinkingLevel 交还给循环。它比 shouldStopAfterTurn 先跑,
	// 次序的理由见 §5。
	// 返回类型允许同步值也允许 Promise,而 shouldStopAfterTurn 也是如此 ——
	// 循环两处都写了 await,同步实现不会多花一个微任务以外的代价。
	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	// steering(插话)与 follow-up(续摊)的差别只有一处:**被拉取的时机**。
	// steering 在 run 开局拉一次、以及每个 turn_end 之后(过了 prepareNextTurn 与
	// shouldStopAfterTurn)再拉一次;follow-up 只在内层 while 已经退出、agent 本来
	// 就要停下来的那一刻拉一次。一句话:steering 是插队,follow-up 是续摊。
	// 关键细节:插话**不会跳过当前这轮的工具执行** —— 拉取点在工具跑完之后,
	// 所以「用户中途改主意」不会让已经发出的 flash / gdb 半途而废。
	// 返回 [] 是「没有」的正确表达方式;抛错没有兜底(见文件头)。
	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	// follow-up 非空时循环 `continue` 回外层 while,hasMoreToolCalls 被重置成 true,
	// 于是又是一轮完整的 turn;空则 break 走到 agent_end。
	// 因为它在 agent「本来要停」的那一刻才被问,所以一条 follow-up 消息永远不会
	// 打断正在执行的工具批次 —— 这正是它与 steering 分成两个队列的全部理由。
	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	// 注意「Default: parallel」是**由缺省实现的**,不是由默认值实现的:循环里只检查
	// `config.toolExecution === "sequential"`,任何别的值(含 undefined)都落到并行
	// 分支。Agent 类另外写了 `options.toolExecution ?? "parallel"` 把它显式化,
	// harness 干脆不填 —— 三处写法不同,行为一致。
	// 并行模式下有两条同时存在的顺序,别混:tool_execution_end 按**完成序**发
	// (谁先跑完谁先出,UI 能第一时间画卡片),而工具结果消息按 assistant 消息里
	// toolCall 块的**源序**发(很多 provider 对此有要求)。见 §12 末尾。
	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	// 两个工具钩子都收第二个参数 signal,而且注释明确写着「钩子自己负责响应它」——
	// 循环不会替钩子做超时。不过循环在钩子返回之后**会**再查一次 signal.aborted,
	// 命中就把这次调用变成一条 "Operation aborted" 的错误结果,而不是继续执行。
	// 顺序也要记住:prepareArguments → validateToolArguments → beforeToolCall。
	// 钩子拿到的是校验后的 args,所以它挡不住「schema 都过不了」的调用 —— 那种
	// 在更早的一步就已经被翻成错误结果了。
	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	// afterToolCall 与上面的 beforeToolCall 是本文件仅有的两个**抛错会被吞掉**的回调:
	// 两处都被 try/catch 罩着(finalizeExecutedToolCall / prepareToolCall),抛出的
	// 异常被翻译成一条 isError 的工具结果。代价不对称:beforeToolCall 抛只是让这次
	// 调用变成一条错误结果(工具本来就没跑),afterToolCall 抛却会把**已经跑成功**的
	// 工具结果整个换成错误文本 —— 工具白跑了,而且模型看不出这是钩子的锅。
	// 其余回调(convertToLlm / transformContext / prepareNextTurn / shouldStopAfterTurn /
	// 两个队列)抛错则没有任何兜底,见文件头那段 must-not-throw 的说明。
	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

// ── §7 ThinkingLevel:含 off 的七档 ───────────────────────────────────────
// **这里有两个同名类型,必须分清**:
//   - pi-ai 的 ThinkingLevel 是六档,**不含 off**;
//   - 本文件这个是七档,**含 off**,逐字等于 pi-ai 的 ModelThinkingLevel。
// 但本文件是**手抄一份**而不是 re-export(顶部 import 列表里没有它),所以上游哪天
// 加一档,这里不会自动跟上,只会在赋值处才炸。
// 落地路径:AgentState.thinkingLevel(§9)与 AgentLoopTurnUpdate.thinkingLevel(§5)
// 用这个七档类型;进 AgentLoopConfig.reasoning(继承自 SimpleStreamOptions,六档)
// 时由循环负责把 "off" 翻译成 undefined。
// 桌面端还有第三份同解实现(kernel/src/thinking.ts),因为 renderer 只拿得到字符串
// 数组而不是 Model 对象。三份必须同解 —— 漂移的后果是「档位在 UI 里能选但发不出去」。
/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @earendil-works/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ── §8 CustomAgentMessages / AgentMessage:声明合并撑开的消息联合 ─────────
// 这是全文件唯一一个「空着就是为了被别人填」的形状。TypeScript 的 declare module 会
// 把外部声明的字段合并进这个 interface,于是下面那个联合类型**全局变宽** ——
// 应用不需要给自定义消息包一层 wrapper 就能与 pi-ai 的原生消息同列在一个数组里。
// 本仓唯一的注册点是 harness/messages.ts 的 `declare module "../types.ts"`,
// 塞进四个角色:bashExecution / custom / branchSummary / compactionSummary。
// 两个代价必须记住:
//   1. 任何拿 AgentMessage 做 switch 的地方都必须有 default 分支 —— 联合的成员
//      取决于编译单元,穷举检查在这里不可靠;
//   2. **只 import 类型也会触发合并**,于是「AgentMessage 到底有哪几个 role」取决于
//      哪些模块被编译进来。messages.ts 因此是一个有编译期副作用的类型模块。
/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

// `CustomAgentMessages[keyof CustomAgentMessages]` 是「取这个 interface 全部值类型的
// 联合」。一个都没注册时 keyof 是 never、索引结果也是 never,联合退化成纯 pi-ai 的
// Message —— 所以空 interface 是无害的,不会把 AgentMessage 变成 unknown。
/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ── §9 AgentState:长命状态 ───────────────────────────────────────────────
// 与 §11 的 AgentContext 是一对容易混的兄弟,寿命完全不同:
//   AgentContext = **一次运行的输入快照**,跑完就扔,被循环就地修改;
//   AgentState   = **长命状态**,除了模型/档位/工具/transcript,还有 isStreaming、
//                  streamingMessage、pendingToolCalls、errorMessage 这些 UI 要看的
//                  实时字段。
// 开跑时从 State 复制出 Context,跑的过程中靠事件把变化折算回 State ——
// **两边不是同一个数组,这是刻意的**:循环把流式半成品 push 进 Context 时,
// State 那份不该跟着抖。
// 本仓唯一的实现是 agent.ts 的 createMutableAgentState。**harness 不实现这个接口**,
// 它把同样的信息摊在自己的字段里。也就是说桌面端与 ACP 跑的路径上,AgentState
// 一次都不会被构造出来 —— 它是给「裸 loop 该怎么被有状态地包起来」当参考实现的。
/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	// tools 与 messages 用 set/get 访问器而不是普通属性,是为了在**类型上声明**
	// 「赋值时会拷贝」。实现里 setter 是 `tools = nextTools.slice()`。
	// 拷的只是顶层数组,元素还是同一批对象引用 —— 改 tools[0].description 依然穿透。
	// 少了这层拷贝的后果:调用方手上那个数组之后再 push,会静默改掉 agent 的工具集,
	// 而且改的时机完全不受控。
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	// isStreaming 的落回时机比直觉晚:要等 agent_end 的**订阅者**都 settle 之后才变
	// false。理由是订阅者可能还在写盘(harness 的 flushPendingSessionWrites 就挂在
	// agent_end 上),这时候对外说「空闲了」会让宿主立刻发下一个 prompt,撞上还没
	// 写完的会话文件。
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	// pendingToolCalls 是 ReadonlySet 而不是数组:UI 要问的是「这个 id 还在跑吗」,
	// 而不是「第几个在跑」。实现侧持有的是可变 Set,只在类型上收窄成只读。
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

// ── §10 工具契约:AgentToolResult / AgentToolUpdateCallback / AgentTool ───
// 这三个形状是 agent 与 coding-agent 之间那条边界的全部内容(全景篇 §0:
// 「agent 不知道有 read/write/gdb」)。coding-agent 的 ToolDefinition 比 AgentTool 多
// 两个提示词字段(promptSnippet / promptGuidelines),装配时由 wrapToolDefinition
// 丢掉 —— 提示词是产品决策,循环不该看见。
/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	// content 与 details 的分工是这个类型的全部要点:
	//   content —— **回给模型**看的(text 与 image 两种块;ToolResultMessage 允许
	//              图片,datasheet 的看图工具靠这条把图直接塞进上下文);
	//   details —— **给日志与 UI**的结构化数据,不进模型上下文,桌面端与 Zed 的工具
	//              卡片全靠它。
	// 两者不要互相塞:content 里堆 JSON 等于花 token 讲给人听,details 里放长文本
	// 等于模型永远看不到。注意 details 是必填的(泛型 T 没有默认值),没有结构化
	// 数据的工具也要给一个 {}。
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	// addedToolNames 是 pi-ai 的「延迟工具」(deferred tools)机制:一条工具结果可以
	// 宣布「从这个 transcript 位置之后,这几个工具才算可用」,pi-ai 的
	// splitDeferredTools 据此把 Context.tools 切成立即可见与延迟加载两半。
	// 循环只做搬运:非空时才写进 ToolResultMessage(空数组与 undefined 一样被忽略),
	// 而且 afterToolCall 的补丁改不到它。
	// 本仓的工具目前**一个都没有用**这个字段 —— 它是上游能力,不是本仓机制。
	/** Names of tools introduced by this result and available from this transcript point onward. */
	addedToolNames?: string[];
	// terminate 的判定是**全票通过**:`finalizedCalls.length > 0 &&
	// every(f => f.result.terminate === true)`。必须整批每一个都为 true,只要有一个
	// 工具没表态(undefined)循环就照常继续。
	// 这是刻意的:模型常在一条消息里既调 exit_plan_mode 又调别的工具,少数派不该替
	// 多数派叫停。顺带一个推论 —— 内核造的错误结果(工具不存在、校验失败、被 block、
	// abort、length 截断)都不带 terminate,所以一批里只要有一个失败,这批就一定不会
	// 终止,循环必然再跑一轮让模型自己收拾。
	// 补一句现状:exit_plan_mode 是上游 pi 的例子,不是本仓的工具 —— coding-agent
	// 的工具目前**一个都没有**填过 terminate。所以在本仓,一批工具能不能提前终止
	// 完全取决于宿主有没有在 afterToolCall 里补 terminate,默认永远是「不终止」。
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

// onUpdate 的作用域被钉死在**本次 execute 调用**上:循环用一个 acceptingUpdates
// 布尔守着,工具的 promise 一 settle 就置 false,之后再调这个回调静默无效 ——
// 挡的是「工具留了个定时器、跑完还在推进度」这种把 UI 卡片写坏的情况。
// 推出去的 partialResult 只用来 emit tool_execution_update 事件喂 UI,
// **不进 transcript、不进会话文件**,模型永远看不到它。
// 循环还会把这些 emit 的 Promise 收集起来一并 await,保证「进度事件全部送达」早于
// 「这个工具的最终结果」—— 否则 UI 会先收到完成、再收到迟到的进度。
/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// AgentTool extends pi-ai 的 Tool<TParameters>,也就是在 {name, description,
// parameters} 三个字段上再加四个。两个泛型槽:TParameters 是 typebox schema,
// TDetails 是 details 的形状(默认 any;coding-agent 每个工具都钉死自己的
// *ToolDetails,桌面端再结构化复制一份用来画工具卡片,漂移由编译期断言兜住)。
// 一个容易忽略的事实:循环把 AgentTool[] **原样**放进 pi-ai 的 Context.tools ——
// label / execute / prepareArguments / executionMode 这些多出来的字段会跟着进
// Context,只是 provider 只读 name / description / parameters,不会被发到网络上。
/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// label 是必填的,但**全仓没有任何一处读它** —— 桌面端与 ACP 的工具卡片用的是
	// ToolResultMessage.toolName。它是上游 pi 的 TUI 渲染留下来的字段,my-pi 没有
	// TUI。保留它几乎没有代价(每个工具多一行),删掉它要动 coding-agent 全部工具
	// 定义,所以就这么留着了。
	/** Human-readable label for UI display. */
	label: string;
	// prepareArguments 是 schema 校验**之前**唯一的入参整形钩子,专治「模型把参数写成
	// 另一种合法形状」。本仓唯一的使用者是 edit 工具:把 JSON 字符串形式的 edits
	// 解析回数组、把旧的单条 oldText/newText 折进数组。
	// 循环用**引用相等**判断它有没有真的改动:原样返回入参时连 toolCall 对象都不
	// 重建,省掉一次拷贝。所以想让改动生效必须返回新对象,就地改再返回同一个引用
	// 也能生效(改的就是那个对象),但返回一个「看起来一样」的新对象会白拷贝一次。
	// 它是同步的、而且**跑在 try 里**:抛错会被翻成一条 isError 的工具结果。
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	// execute 的契约里最容易违反的一条:**失败要 throw,不要把错误编进 content**。
	// 循环会 catch 住并造一条 isError 的结果;自己返回一个「看起来像错误」的正常
	// 结果会让 isError 为 false,前端画成成功卡片,宿主的自动重试逻辑也不认。
	// 四个参数里 signal 与 onUpdate 都可选。循环**永远不会打断已经启动的 execute**,
	// 它只在工具之间查 signal,所以工具不响应 signal = 这次调用一定跑到底。
	// 两种模式下「剩下那些」的命运不同:串行是当前这个收尾之后 break,余下的调用连
	// 结果消息都不造(留下悬空批次);并行是准备阶段 break,但已经入列的 thunk 仍会被
	// Promise.all 全部跑掉 —— 它们拿到的是已经 abort 的 signal,认不认由工具自己决定。
	// toolCallId 传进来是给工具做「一次调用一个资源」的键用的(log / gdb 的会话表)。
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	// 这里的「If omitted, the default execution mode applies」要连着 §3 读:
	// 省略等于**不表态**,而不是等于 "parallel"。同一批里只要别人标了 sequential,
	// 没表态的工具也会被拖去串行 —— 这是设计意图,因为「谁跟谁能并行」是批级性质,
	// 不是单个工具能单独决定的。
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

// ── §11 AgentContext:一次运行的输入快照 ──────────────────────────────────
// 三个字段,小到可以背下来 —— 但它有一条不写在类型里的性质:**循环会就地修改它**。
// 流式 assistant 消息、每条工具结果、每条插话消息都被 push 进 context.messages。
// 所以调用方传进来的对象跑完之后不是原样,而是长出了这一轮的全部消息。
// 两个入口的所有权语义**不对称**:runAgentLoop 建的是新数组
// (`messages: [...context.messages, ...prompts]`),而 runAgentLoopContinue 只做
// `{ ...context }` —— messages 数组没有复制,循环直接往调用方的数组里 push。
// 实践中安全只是因为 harness 与 Agent 都提前 slice 了一份。
// 与 pi-ai 的 Context 的区别只有两处:messages 装的是 AgentMessage(可以有自定义
// 角色),systemPrompt 是**必填**而不是可选。
/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	// messages 是 AgentMessage[] 而不是 Message[]:自定义角色可以直接躺在这里,
	// 到 §6 的 convertToLlm 那一跳才被投影成模型看得懂的形状。这是「进 transcript」
	// 与「进 LLM」两件事在类型上的分离点。
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	// tools 可选,而且循环是按**名字**在这个数组里线性查找的。名字重复时先出现的
	// 那个胜出,循环本身不查重 —— 查重发生在 harness 的 validateToolNames 里,
	// 直接用裸 loop 的调用方要自己保证。
	// 数组为空或 undefined 时,模型发来的任何 toolCall 都会得到 "Tool xxx not found"
	// 的错误结果,而不是抛异常 —— 又一次「失败是数据」。
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

// ── §12 AgentEvent:十种事件 ──────────────────────────────────────────────
// 严格对应 run / turn / message / tool 四级节奏(全景篇 §3 第二组):
//   run     agent_start … agent_end                     一次 prompt 的全程
//   turn    turn_start … turn_end                       一条 assistant 消息 + 那批工具
//   message message_start / message_update / message_end
//   tool    tool_execution_start / _update / _end
// **十种,不是十一种**(全景篇 §6.0 专门修正过这个口径)。harness 自有的那批事件
// (save_point / settled / model_update / …)定义在 harness/types.ts 的
// AgentHarnessOwnEvent 里,subscribe() 听到的 AgentHarnessEvent 是两者的并集。
// 循环发事件用的是 `await emit(event)`:**每一个事件都被 await**。两个后果:
// 订阅者慢会把整个循环拖慢;订阅者抛错会把循环打断。这正是 harness 在 turn_end
// 那里要把订阅者的异常**暂存**、先 flush 挂起写入再抛的原因。
/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	// agent_end 是这个流的**终结事件**:createAgentStream 把 isComplete 钉在
	// "agent_end" 上、把 extractResult 钉在它的 messages 上。两个后果:
	//   1. agent_end 一被推入,EventStream 就 done,之后再 push 的事件全部静默消失;
	//   2. 循环必须保证任何路径上都发得出 agent_end(错误早退、shouldStopAfterTurn
	//      提前收工、正常结束三条路各发一次),否则 `await stream.result()` 会**永久
	//      pending** —— 不是 reject,是挂死。
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	// turn_end 的 message 字段类型写的是 AgentMessage,但循环实际发出去的**永远是
	// 一条 AssistantMessage** —— 类型比现实宽。消费方想取 stopReason 或 usage 时
	// 必须自己收窄。message_start / message_end 则是真的三种消息都会发。
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// message_update 是唯一带 assistantMessageEvent 的事件:除了「现在的消息长什么
	// 样」,还把 pi-ai 那条原始 delta 事件原样透出来。桌面端投影器靠这两者的分工做到
	// 「快照始终从 partial.content 重算、delta 只是叠在上面的增量」。
	// 注意 message 是 `{ ...partialMessage }` 的**浅拷贝**:顶层字段是新的,content
	// 数组仍是同一个引用,而 pi-ai 的 partial 是一路被就地改写的同一个对象 ——
	// 想留快照必须自己深拷。
	// 还有一个坑:循环所有 delta 分支都在 `if (partialMessage)` 里,某个 provider 的
	// 流若没发 start 就开始发 delta,**一条 message_update 都不会产生**,UI 表现为
	// 一直转圈直到最后一次性出全文。
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 三个 tool_execution_* 事件的载荷都是 any(args / partialResult / result),
	// 这是本文件类型最松的一处:订阅者拿不到任何编译期保证。桌面端因此在
	// kernel/src/host/details-check.ts 用约束式断言另外兜了一道工具 details 的漂移。
	// 另外 tool_execution_start 在「循环处理到的」每个调用上一定会发,即使它最终没有
	// 真的执行 —— 工具不存在、参数校验失败、被 beforeToolCall 拦下、length 截断,
	// 四种情况都是先发 start 再发一条 isError 的 end,UI 卡片的形状因此永远一致。
	// 唯一的例外是 abort:两个执行器都在 break 的那一刻停止推进,后面的 toolCall
	// 连 start 都不会发,前端只能靠 assistant 消息里的 toolCall 块自己收尾。
	// 还有一个易错点:start 带的 args 是**模型吐出来的原始参数**,不是校验/转换后的
	// 那份 —— UI 显示的是「模型说它要干什么」,与 execute 真正收到的对象可以不同。
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	// tool_execution_end 与它对应的工具结果消息的**顺序在并行模式下是分开的**:
	// 每个工具跑完就地 emit tool_execution_end(完成序),而工具结果的 message_start /
	// message_end 那一对要等 Promise.all 全部落定之后,才按 assistant 消息里 toolCall
	// 块的原始顺序逐条发出(源序)。UI 因此能第一时间画出已完成的卡片,而 transcript
	// 的顺序仍然是 provider 要求的那个。串行模式下两者一致。
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
