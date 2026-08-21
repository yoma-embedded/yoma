/**
 * Agent loop — Step 1–5 reference:
 * - Step 1: one LLM turn
 * - Step 2: sequential tool execution
 * - Step 3: if tools ran, call LLM again (multi-turn)
 * - Step 4: steering (mid-run inject) + follow-up (after would-stop)
 * - Step 5: parallel tools + fail tools when stopReason is "length"
 */

/**
 * ── 本文件在做什么 ──────────────────────────────────────────────────────
 * agent 循环(agent loop)本体。它把「用户的一次 prompt」变成「N 轮:发一次 LLM
 * 请求 + 执行模型点名的工具」,直到模型不再要工具、也没有人插话为止。
 *
 * 三个必须先建立的心智:
 * 1. 这是整套内核里唯一的状态机。harness 没有循环、宿主也没有,所有「多轮」都
 *    发生在 §3 runLoop 的那两层 while 里。
 * 2. 这里的函数是无状态纯函数:跑完返回一个消息数组,自己不留任何东西。
 *    「一个能长期用的会话对象」是 harness 的事(harness/agent-harness.ts)。
 * 3. 失败是数据不是异常(errors as data)。provider 报错、网络断了、被 abort,
 *    都不会 throw,而是变成一条 stopReason 为 error / aborted 的 assistant 消息。
 *    于是循环永远只有一条正常路径:拿到消息 → 看 stopReason → 决定下一步。
 *
 * ── 在全景链路上的位置 ──
 * 宿主 → AgentHarness.prompt() → executeTurn() → runLoopToCompletion() → 本文件
 *   → config.convertToLlm()(LLM 边界)→ streamFn → pi-ai 的 models.streamSimple()
 *   → 厂商协议 HTTP → 事件流回程 → 本文件 emit 出 AgentEvent
 *   → harness.handleAgentEvent() 落盘并转发给订阅者(桌面端投影器 / ACP)。
 * 对应全景篇 §4 生命周期的第 9-42 步。
 *
 * 对应学习文档:docs/learn/agent/agent-loop.md
 *
 * ── 分节索引 ──
 * §1 契约导入与两个基础件(AgentEventSink / streamFn 缺省哨兵)
 * §2 四个入口与流工厂(agentLoop / agentLoopContinue / runAgentLoop / runAgentLoopContinue)
 * §3 runLoop:双层 while 状态机(整个文件的心脏)
 * §4 streamAssistantResponse:发一次请求并消费回程事件流
 * §5 工具执行的类型层与批级 terminate 判定
 * §6 三条工具执行路径:模式选择 / length-失败 / 串行 / 并行
 * §7 单次工具调用的三段:prepare → execute → finalize
 * §8 收尾小函数:入参整形、错误结果、事件与消息构造
 */

// ── §1 契约导入与两个基础件 ────────────────────────────────────────────

// 从 pi-ai 只拿四样东西:两个消息形状(AssistantMessage / ToolResultMessage)、
// 事件流类(EventStream)、工具入参校验器(validateToolArguments),外加一次请求的
// 输入形状 Context。这个 import 列表就是「agent 包对 LLM 协议层的全部依赖」。
import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
// 本包自己的契约全在 types.ts,零实现纯类型。读这个文件时最常回查的是
// AgentLoopConfig(model + 九个回调 + toolExecution;harness 只填六个)与 AgentEvent(10 种事件)。
// 注意 AgentMessage 是靠 declare module 声明合并变宽的联合类型,
// 本仓在 harness/messages.ts 往里注册了 4 个自定义角色。
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

/**
 * 事件汇(sink):循环把 10 种 AgentEvent 全部交给它,自己不关心谁在听。
 *
 * 返回值可以是 Promise —— 循环对每一次 emit 都 await,所以订阅者是背压点:
 * 慢的监听器会真的把循环拖慢。harness 正是靠这个同步性做到「message_end 先落盘、
 * 再转发给订阅者」的。反过来,监听器抛异常会把整个循环炸掉(见 §2 的 agentLoop
 * 没有 catch 这条坑)。
 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// 没传 streamFn 时的哨兵:调用时才抛,而不是在入口处提前校验。
// 这样「只想跑一遍事件流形状」的测试可以不给 streamFn,直到真要发请求才失败,
// 而且错误消息里直接写好了正确写法。注意它是同步 throw,会从
// streamAssistantResponse 一路冒到 runLoop 之外 —— 属于「配置错误」而不是
// 「请求失败」,所以刻意不走 errors-as-data 那条路。
const noStreamFnConfigured: StreamFn = () => {
	throw new Error(
		"no streamFn configured. Pass streamFn, e.g. (model, ctx, opts) => models.streamSimple(model, ctx, opts).",
	);
};

// ── §2 四个入口与流工厂 ────────────────────────────────────────────────
//
// 同一套逻辑对外有两种调用形态:
//   · agentLoop / agentLoopContinue    → 返回一个 EventStream,调用方 for await
//   · runAgentLoop / runAgentLoopContinue → 收一个 emit 回调,返回 Promise
// 后一对是前一对的内核。harness(本仓唯一的生产调用方)用的是后一对,
// 因为它要在 emit 里做落盘;测试用的是前一对,因为流更好断言。
//
// 另一维差别是「从哪儿开跑」:带 prompts 的从一批新消息开跑,Continue 版从
// 已有上下文的最后一条可续消息接着跑(retryLastTurn 用它)。

// 流形态入口:把新 prompt 消息接上循环,返回一个可 for await 的事件流。
// 返回的流以 agent_end 事件为终结(见 createAgentStream),
// await stream.result() 拿到的就是本次运行新产生的全部消息。
/**
 * Start an agent loop with new prompt messages.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	// 先建流再起循环:循环第一件事就是 emit agent_start,流必须已经存在。
	const stream = createAgentStream();

	// 坑:这里是 void + .then,没有 .catch。任何回调(convertToLlm / prepareNextTurn /
	// 订阅者……)抛异常都会变成一个未处理的 Promise rejection,而且流永远不会 end()
	// —— 消费方的 for await 与 await stream.result() 会静静挂死,没有任何报错。
	// 这就是 types.ts 里几乎每个回调都写着 must-not-throw 的原因;Agent 类和
	// harness 各自补了兜底,裸 loop 没有。
	void runAgentLoop(prompts, context, config, async (event) => {
		stream.push(event);
	}, signal, streamFn).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

// 流形态入口的第二种:不追加新 prompt,直接从当前上下文的尾巴续跑。
// 典型用途是「上一轮 provider 报错,把错误消息摘掉之后重发」——
// harness.retryLastTurn() 走的就是这条语义(只是它调的是 runAgentLoopContinue)。
/**
 * Continue from current context without adding a new prompt.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	// 两条前置校验:空上下文、或最后一条是 assistant,都没法续。
	// 注意这里是同步 throw(函数不是 async),调用方 try/catch 得到的是异常而不是
	// rejected promise;而下面 §2 的 runAgentLoopContinue 是 async 函数,同样两条校验
	// 在那边变成 reject。同一份规则,两种失败形态。
	const last = context.messages.at(-1);
	if (!last) {
		throw new Error("Cannot continue: no messages in context");
	}
	// 为什么 assistant 结尾不能续:模型已经说完了话,再发一次请求等于让它对着自己的
	// 上一句自言自语。可续的尾巴是 user 消息、toolResult 消息,或任何自定义角色
	// (自定义角色能不能续是调用方的责任,测试里专门钉了这条)。
	if (last.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(context, config, async (event) => {
		stream.push(event);
	}, signal, streamFn).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 循环的主入口(回调形态):从一批新 prompt 消息开跑。
 *
 * @param prompts   本次要追加的新消息。它们会被 emit 成 message_start/message_end,
 *                  也会出现在返回值里。
 * @param context   一次运行的输入快照 {systemPrompt, messages, tools}。
 *                  注意循环会就地修改 context.messages(往里 push 流式消息与工具结果)。
 * @param config    AgentLoopConfig:模型、九个回调、工具执行模式,以及它从
 *                  SimpleStreamOptions 继承来的全部请求参数(reasoning / maxTokens…)。
 * @param emit      事件汇,循环对每一次 emit 都 await。
 * @param signal    中断信号。循环不主动早退,而是让 streamFn 返回一条 aborted 消息。
 * @param streamFn  发请求的函数;不传则在第一次请求时抛哨兵错误。
 * @returns 本次运行新产生的全部消息(含 prompts、assistant 消息、工具结果、插话)。
 *
 * 失败时:回调抛异常会原样冒出去(这个函数不 catch),由调用方兜底
 * ——harness 的 runLoopToCompletion 会把它翻成一条合成的错误尾巴。
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	// 返回给调用方的账本。runAgentLoop 把 prompts 也算进「新产生的消息」,
	// 这样 harness 拿到的就是「本轮从头到尾发生了什么」的完整清单。
	const newMessages: AgentMessage[] = [...prompts];
	// 给模型看的上下文:整个对象浅拷一层,messages 换成一个新数组。
	// 这一行是两个入口最重要的差别 —— 这里复制了数组,所以循环往里 push 不会污染
	// 调用方传进来的 context.messages;而 runAgentLoopContinue 用的是 {...context},
	// 数组是共享的(见下面那个函数的同名行)。
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	// 事件顺序是协议的一部分:agent_start 一定先于 turn_start,
	// turn_start 又先于本轮的任何消息事件。前端投影器就是照这个节奏建卡片的。
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	// prompt 消息立刻走完 start/end 两拍(它们不是流式产物,没有中间态)。
	// harness 在 message_end 上做 session.appendMessage —— 所以「用户说的话」是在
	// 这里落盘的,而不是在 prompt() 里。
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	// 真正的循环在 runLoop 里。注意 currentContext 与 newMessages 都是引用传进去的,
	// runLoop 一路往里 push,返回时这两个数组已经被填满。
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 循环的第二个入口(回调形态):不追加新消息,从当前上下文尾部续跑。
 *
 * 与 runAgentLoop 的三处差别:
 * 1. 有前置校验(空上下文 / assistant 结尾直接 reject);
 * 2. newMessages 从空数组开始 —— 返回值里不含已有的历史;
 * 3. currentContext 共享调用方的 messages 数组(见下方行注释)。
 *
 * 事件上仍然会发 agent_start + turn_start,但不发任何 message_start/message_end
 * ——「没有新 prompt」正是这个入口的定义。
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	// 与 agentLoopContinue 里那两条校验逐字重复。区别是这里在 async 函数体内,
	// 所以是 reject 而不是同步 throw。改其中一处时另一处必须跟着改。
	const last = context.messages.at(-1);
	if (!last) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (last.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	// 空数组:续跑不把已有历史算成「本次新产生的消息」。
	// harness.retryLastTurn 依赖这一点来判断「这次重试到底产出了什么」。
	const newMessages: AgentMessage[] = [];
	// 坑:只浅拷了一层对象,messages 数组没有复制 —— 循环会直接往调用方的数组里 push。
	// 与 runAgentLoop 的所有权语义不对称。实践中安全,只是因为两个生产调用方
	// (harness 与 Agent 类)在传进来之前都自己 slice 了一份。
	const currentContext: AgentContext = { ...context };

	// 即使没有新消息也照发 turn_start:一次「运行」总要有至少一个 turn 的外壳,
	// 否则前端的 turn 卡片会缺一层父节点。
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 造事件流:把通用的 EventStream 参数化成「agent 侧」的语义。
 *
 * EventStream 是一个推拉合一的队列(ai/src/utils/event-stream.ts,88 行),构造时要
 * 回答两个问题:哪个事件算终结、从终结事件里怎么取最终结果。pi-ai 侧的答案是
 * done/error;agent 侧的答案就是下面这两行。
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		// 终结判据:agent_end。一旦推入,EventStream 内部 done 置真 ——
		// 坑:之后再 push 的事件全部被静默丢弃,不报错也不入队。
		(event: AgentEvent) => event.type === "agent_end",
		// 取结果:agent_end 带着 messages;其余情况返回空数组(实际到不了这一支,
		// 因为只有 agent_end 会被判为终结)。
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// ── §3 runLoop:双层 while 状态机 ──────────────────────────────────────
//
// 整个内核唯一的状态机,也是最该在纸上画一遍时序的一段(去掉注释是 130 行代码)。两层循环各管一件事:
//
//   外层 while(true)  —— follow-up「续摊」:agent 本来要停了,但队列里还有话,
//                        那就重开一整轮(hasMoreToolCalls 被重置为 true)。
//   内层 while         —— 工具多轮 + steering「插队」:模型要工具就再发一次请求,
//                        有人插话也再发一次请求。
//
// 一句话记住两个队列的差别:steering 是插队(飞行中注入),follow-up 是续摊
// (将停时追加)。差别只在被拉取的时机,不在数据形状。
/**
 * Shared loop (Step 3 + 4):
 *   Inner: stream → tools → (optional steering inject) → maybe stream again
 *   Outer: when tools/steering settle, drain follow-ups and continue if any
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	// prepareNextTurn may replace context/model/thinking between turns
	// 两个会在轮次之间被换掉的局部变量。prepareNextTurn 可以整个替换 context,
	// 也可以换模型与思考档位 —— 后两样落在 config 的浅拷贝里,不是独立变量。
	let currentContext = initialContext;
	let config = initialConfig;
	// 首轮的 turn_start 已经由 runAgentLoop / runAgentLoopContinue 发过了,
	// 内层循环第一次进来时必须跳过,否则前端会收到两个 turn_start 而多画一张卡片。
	let firstTurn = true;
	// Step 4: steering queued before / during the run (e.g. user typed while waiting)
	// 开跑前先拉一次插话队列:用户可能在上一轮还没结束时就敲了下一句。
	// 这是 steering 的第一次拉取点(第二次在每个 turn 末尾,见本函数末段)。
	// 队列为空时 getSteeringMessages 返回 [],|| [] 兜的是「回调根本没配」。
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer: continue when follow-up messages arrive after the agent would stop
	// 外层:唯一的出口是下面的 break(follow-up 队列空)与两处 return(早退 / 主动停)。
	while (true) {
		// 每次重进外层都置 true —— 保证 follow-up 续摊时至少还能完整跑一轮请求。
		let hasMoreToolCalls = true;

		// Inner: tool multi-turn + steering injection
		// 内层的进入条件是「还有活干」:要么上一轮留下了待执行的工具(hasMoreToolCalls),
		// 要么有人插话(pendingMessages)。两者都空就掉出内层,去外层问 follow-up。
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// 与入口发的那一次配对:一次 run 里 turn_start 的总数正好等于实际轮数。
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Inject steering messages before the next assistant response
			// 注入插话:必须发生在下一次请求之前,这样模型在同一次请求里就能看到新指令。
			// 注意当前这一轮的工具照常执行、不会被跳过 —— 插话不是取消。
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					// 两个数组都要 push:currentContext.messages 是给模型看的,
					// newMessages 是给调用方的账本。漏掉任何一个都会造成「模型看到了但会话文件里没有」
					// 或者反过来的历史断裂。
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// 发一次请求并把整条流消费完,拿到终态的 assistant 消息(见 §4)。
			// 这个调用是整个循环里唯一会碰网络的地方。
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			// 早退分支:errors-as-data 的兑现处。provider 失败或被 abort 时,消息本身已经
			// 带着 stopReason 与 errorMessage 进了 transcript,循环这里只负责收摊:
			// 发一个空 toolResults 的 turn_end,再发 agent_end,然后 return。
			// 注意:两个队列一个都不拉 —— 排在队里的插话不会被这一轮消费掉,留给下一次 prompt。
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 从 assistant 消息里筛出 toolCall 内容块。一条消息里的全部 toolCall 就是一个
			// 「批」(tool batch),它们要么一起串行、要么一起并行,不会跨消息混批。
			const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			// 默认这一轮之后就停:只有真的执行了工具、而且没被 terminate 叫停,才翻回 true。
			hasMoreToolCalls = false;

			// 没有工具调用时整段跳过,toolResults 保持空数组,循环随后靠 hasMoreToolCalls
			// 为 false 掉出内层。「模型说完了话」就是这条路径。
			if (toolCalls.length > 0) {
				// Step 5: truncated output → arguments may be incomplete; fail instead of execute.
				// length 分叉:输出被 maxTokens 截断时,最后那个 toolCall 的 JSON 参数很可能只写了
				// 一半,而流式 JSON 解析器照样能给出一个结构合法的对象 —— 直接执行等于拿残缺参数
				// 去改文件、动板子。所以这里换成「一律不执行,造错误结果让模型重发」。
				// 反面:被截断的消息里如果没有工具调用,循环不做任何补救,按正常结束处理。
				const batch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
				toolResults.push(...batch.messages);
				// terminate 是「全票通过」才为真(见 §5 的 shouldTerminateToolBatch),
				// 所以只要批里有一个工具没表态,循环就照常再来一轮。这是刻意的:模型常在一条
				// 消息里既调 exit_plan_mode(上游 pi 的例子)又调别的工具,少数派不该替多数派叫停。
				hasMoreToolCalls = !batch.terminate;

				// 工具结果同样要同时进上下文与账本。顺序即 transcript 顺序:
				// 并行模式下它同样是源序(Promise.all 保留输入顺序,没有额外的排序步骤),
				// 因为不少 provider 要求 toolResult 与 toolCall 一一对应且同序。
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			// turn_end 的载荷是「这一轮发生了什么」的完整快照:一条 assistant 消息 +
			// 它引发的那批工具结果。harness 收到它会 flush 挂起的会话写入并打一个 save point。
			await emit({ type: "turn_end", message, toolResults });

			// Note: no early return on signal.aborted here. Abort resolves on the next
			// stream call, which must return an assistant message with stopReason "aborted".

			// 次序不能反:prepareNextTurn 先跑,它拿到的是「刚跑完这一轮」的现场;
			// shouldStopAfterTurn 后跑,它的入参 context 是替换之后的那份 —— 判断该不该停
			// 要看新上下文有多大。注意本仓生产代码从不填 shouldStopAfterTurn(只有测试用)。
			const nextTurnSnapshot = await config.prepareNextTurn?.({
				message,
				toolResults,
				context: currentContext,
				newMessages,
			});
			// 返回 undefined 表示「什么都不用动」,这是绝大多数轮次的情形。
			if (nextTurnSnapshot) {
				// 换上下文:此后所有 push 都落进新数组。想让改动跨轮「持久生效」只有这一条路 ——
				// 对比 §4 的 transformContext,那个的返回值只喂给本次请求、不写回。
				currentContext = nextTurnSnapshot.context ?? currentContext;
				// 整个换掉 config 对象而不是就地改字段:...config 保留其余回调与流选项,
				// 只覆盖 model 与 reasoning。就地改会污染调用方传进来的那个对象。
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					// 三态而不是两态,读的时候容易看漏:
					//   undefined       → 钩子没提要求,保持当前 reasoning 不动
					//   "off"           → 把 reasoning 整个摘掉(请求里不带 reasoning 参数)
					//   其余档位字符串   → 直接替换
					// 「off 等于摘掉」这一条对 reasoning 模型影响很大:最强的一档被默认关掉且没有提示,
					// 这就是桌面端要额外注入 defaultThinkingLevel 的原因。
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			// 主动停:返回 true 就直接 agent_end 并 return,两个队列都不拉。
			// 与上面的 error/aborted 早退不同,这条路径是「正常收工」——
			// 本轮的 assistant 回答与工具执行都已经完整跑完了。
			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Poll steering again after each turn (user may have steered mid-run)
			// steering 的第二个拉取点,在 prepareNextTurn 与 shouldStopAfterTurn 之后。
			// 位置决定语义:只要 agent 还在干活,插话就一定会在下一次请求前进入上下文。
			// 这里重新赋值(不是追加)是安全的,因为上面注入循环已经把数组清空了。
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Would stop here — Step 4 follow-up: only run if agent has nothing else to do
		// 走到这里说明 agent 本来就要停了:没有待执行工具,也没有插话。
		// follow-up 是给「等它忙完再说」的消息准备的最后一次机会。
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		// 有货就塞进 pendingMessages 并 continue —— 回到外层顶端,hasMoreToolCalls
		// 被重置为 true,于是又是一整轮完整的 turn(turn_start → 请求 → 工具 → turn_end)。
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		// 队列空,真的结束。break 出外层去发最后那条 agent_end。
		break;
	}

	// 全文件一共三处 agent_end:error/aborted 早退、shouldStopAfterTurn 主动停,
	// 以及这里的自然结束。任何一条路径都必须发到它,否则订阅者永远等不到运行结束
	// (EventStream 也不会终结,await result() 直接挂死)。
	await emit({ type: "agent_end", messages: newMessages });
}

// ── §4 streamAssistantResponse:发一次请求并消费回程事件流 ─────────────

/**
 * 发一次 LLM 请求,把整条事件流消费完,返回终态的 assistant 消息。
 *
 * 四段:transformContext(本轮临时裁剪)→ convertToLlm(LLM 边界)→ streamFn
 * (真正发请求)→ for await 消费 12 类事件并翻译成 3 种 AgentEvent。
 *
 * 契约:这个函数不为「请求失败」抛异常 —— streamFn 保证失败会编码成流里的 error
 * 事件加一条 stopReason 为 error/aborted 的消息。它只在 streamFn 本身没配置
 * (哨兵)或调用方回调抛异常时才向上冒。
 */
/**
 * Stream one assistant response from the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// 没配 transformContext 时,这一行就是本次请求消息的最终来源。
	let messages = context.messages;
	// transformContext 是「本轮临时裁剪」的钩子(harness 把它接到 context hook 上)。
	// 坑:返回值只赋给局部变量 messages,不写回 context.messages ——
	// 想让裁剪持久生效必须走 §3 的 prepareNextTurn,而不是这里。
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// LLM 边界,整个内核唯一的一处:AgentMessage[](内部形状,可以有自定义角色)
	// 降维成 pi-ai 的 Message[](能发给模型的形状)。本仓的实现在 harness/messages.ts,
	// 它把 bashExecution / custom / branchSummary / compactionSummary 投影成 user 消息,
	// 或者直接丢弃。想知道「什么进 LLM、什么只进 transcript」,只需要读那一个函数。
	const llmMessages = await config.convertToLlm(messages);
	// Context 只有三个字段,而且是每一轮现场拼出来的 —— 它不是长期存活的状态。
	// systemPrompt 与 tools 直接取自 context(所以 prepareNextTurn 换上下文时,
	// 换掉的不只是消息,还包括系统提示词与工具集)。
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// 哨兵兜底:没传 streamFn 时,这里拿到的是那个一调就抛的函数(见 §1)。
	const streamFunction = streamFn || noStreamFnConfigured;
	// apiKey 的两级来源:动态解析器优先于静态字段。getApiKey 存在的理由是短寿命
	// OAuth token(比如 GitHub Copilot)可能在漫长的工具执行阶段过期,
	// 必须每次请求前重新取一遍,而不是整轮复用一个开跑时解出来的值。
	// 注意 || 而不是 ??:getApiKey 返回空字符串时也会回落到 config.apiKey。
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// ...config 把整个 AgentLoopConfig 摊平当请求选项用 —— 这是合法的,因为
	// AgentLoopConfig extends SimpleStreamOptions,reasoning / maxTokens / sessionId
	// 这些字段本来就在里面;多出来的 model、convertToLlm 等字段对协议层是无害的冗余。
	// signal 放在最后覆盖,保证中断信号不会被 config 里的同名字段顶掉。
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	// 流式过程中「当前这条半成品消息」的引用。
	// 关键性质:pi-ai 每个事件带的 partial 始终是同一个 output 对象的引用,不是快照
	// —— 消费者要么立刻读、要么自己拷贝。
	let partialMessage: AssistantMessage | null = null;
	// 是否已经把半成品塞进 context.messages。这个布尔量决定收尾时是「替换末位」
	// 还是「追加一条」,也决定要不要补发 message_start。
	let addedPartial = false;

	// 消费流。12 类事件在这里被折成 3 种 AgentEvent:message_start / message_update /
	// message_end。注意事件流是有严格时序的:start → 若干 *_start/_delta/_end → done|error。
	for await (const event of response) {
		switch (event.type) {
			// start:模型开始说话。把半成品直接 push 进上下文 —— 于是「正在流式输出的这条消息」
			// 从第一刻起就在 context.messages 里,后续 delta 只是原地替换末位。
			case "start":
				partialMessage = event.partial;
				// 就地进上下文,而不是等说完再进。这样即使中途被 abort,已经吐出来的半截话
				// 也留在 transcript 里。
				context.messages.push(partialMessage);
				addedPartial = true;
				// 浅拷一层再 emit:partial 是会被 pi-ai 持续原地修改的同一个对象,
				// 拷一层至少能冻住 role / stopReason / usage 这些顶层字段。
				// 但要清楚它只是浅拷 —— content 数组仍然是同一个引用,订阅者读到的内容块
				// 依然会随着流继续变。桌面端投影器因此始终从 partial.content 整体重算快照。
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			// 九类增量事件走同一段代码:文本、思考、工具调用三组各自的 start/delta/end。
			// 循环并不区分它们,原样把事件塞进 message_update 的 assistantMessageEvent 字段
			// 交给上层 —— 前端要区分「这是文本还是工具参数」就读那个字段。
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// 坑:所有增量分支都被这个 if 罩着。某个 provider 的流若没发 start 就直接发 delta,
				// 一条 message_update 都不会产生 —— UI 表现为「一直转圈,最后一次性出全文」。
				if (partialMessage) {
					partialMessage = event.partial;
					// 替换末位而不是再 push:半成品在 start 那一刻已经占了最后一格。
					// 这一行其实是自赋值(partial 一直是同一个引用),留着是为了让「末位永远是当前
					// 这条消息」这个不变式在代码里显式成立。
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			// done 与 error 走同一段收尾代码 —— 这正是 errors-as-data:失败不是异常路径,
			// 只是 stopReason 不同的另一条正常返回。
			case "done":
			case "error": {
				// 终态消息由流自己提供:EventStream 的 extractResult 从 done 取 message、
				// 从 error 取 error(两者都是 AssistantMessage)。它与 partial 通常是同一个对象,
				// 但契约上只保证「这是最终形状」,所以必须以它为准写回上下文。
				const finalMessage = await response.result();
				// 覆盖末位那条半成品。终态与半成品的差别在于:临时字段(partialArgs 等)已被删除、
				// usage 与 stopReason 已经填好 —— 会话文件里必须存的是这一份。
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				// 没收到过 start 事件(比如 setup 阶段就失败了)时补发 message_start,
				// 保证订阅者看到的永远是完整的 start→end 配对,不用为「失败得太早」写特例。
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				// message_end 发的是 finalMessage 本身而不是拷贝 —— harness 就是在这个事件上
				// 调 session.appendMessage() 落盘的,拷贝反而会让「落盘的」与「转发的」不是同一个对象。
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 兜底路径:流被 end() 结束却从没推过 done/error。正常的 provider 实现不会走到这里。
	// 坑:EventStream 的 result() 在「end() 没带结果且从未推过终结事件」时是永久 pending
	// (不是 reject),所以这一行有可能永远不返回。
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	// 与上面的分支等价的收尾:替换或追加、必要时补 message_start、发 message_end。
	// 两段代码刻意重复而不是抽函数,因为 for-await 内部要 return 出去。
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

// ── §5 工具执行的类型层与批级 terminate 判定 ───────────────────────────
// --- Step 2 + 5: tool execution (sequential / parallel / length-fail) ---

// 一批工具执行完的产物:要回灌进 transcript 的结果消息,以及「是否该收工」。
// terminate 是批级的(不是单个工具级的),判定规则见下面的 shouldTerminateToolBatch。
type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

// 准备成功:参数已校验、beforeToolCall 也放行,可以真的去 execute。
// 携带 tool 引用是为了避免第二次按名字查表。
type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};
// 准备阶段就已经出结果、不需要 execute 的情形,一共四种:
// 工具不存在、参数校验失败、被 beforeToolCall 挡下(block)、准备期间被 abort。
// 把它们和「已准备好」做成判别联合,调用方一个 kind 判断就能分流。

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

// execute 跑完的原始产物(还没过 afterToolCall)。
// isError 为 true 只有一种来源:tool.execute 抛了异常。
type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

// 定稿:过完 afterToolCall、可以拿去造事件与消息的最终形态。
type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

// 并行模式的关键类型:数组里混着两种东西 —— 已经定稿的结果(immediate 分支),
// 和「还没开始跑」的 thunk。做成 thunk 而不是直接起 Promise,是为了让准备阶段
// 保持严格串行(见 §6 的并行实现),真正的并发要等到 Promise.all 那一行才发生。
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 批级早停判定:全票通过制。
 *
 * 必须整批每一个结果都把 terminate 标成 true 才算数;空批一律返回 false
 * (length > 0 这个条件挡的就是空批,否则 every 对空数组恒为 true,
 * 会让「没有工具可执行」被误判成「工具要求收工」)。
 *
 * 为什么要全票:模型经常在一条消息里既调 exit_plan_mode(想停)又调别的工具(还想干活),
 * 少数派不该替多数派叫停。exit_plan_mode 是上游 pi 的例子 —— 本仓工具一个都没填过 terminate。
 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}

// ── §6 三条工具执行路径:模式选择 / length-失败 / 串行 / 并行 ──────────

/**
 * 分派器:决定这一批工具是串行跑还是并行跑。
 *
 * 两条规则:
 * 1. 批级传染 —— 只要批里有任何一个工具标了 executionMode: "sequential",
 *    整批(包括同批的 read / bash)都退成串行;
 * 2. 只能单向升级 —— 把工具标成 "parallel" 并不能把 config 配置的 sequential
 *    拉成并行。
 * 这是探针类工具(gdb / log / flash)防止并发抢板子、文件类工具防止并发覆盖的
 * 唯一手段,所以刻意做成「保守方向说了算」。
 */
/** Step 5: choose sequential vs parallel (any tool marked sequential forces sequential). */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 按 toolCall.name 反查工具定义再读 executionMode。查不到工具时 ?. 让整条表达式
	// 为 undefined,也就是「不算 sequential」—— 不存在的工具会在 prepareToolCall 里
	// 变成一条错误结果,不影响这里的模式选择。
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	// 两个条件任一命中就串行:配置层要求,或批里有工具要求。
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * length 失败路径:被输出上限截断的消息里的工具调用,一个都不执行。
 *
 * 为什么不能执行:stopReason 为 "length" 说明模型的输出被 maxTokens 砍断了,
 * 最后那个 toolCall 的参数 JSON 很可能只写了一半;而流式解析器有三级兜底,
 * 半截 JSON 照样能解出一个结构合法的对象。拿它去 edit 文件或者烧板子,
 * 后果是静默的错误动作。
 *
 * 注意它不查工具是否存在、也不看 signal —— 这一批注定全部失败,没有分支必要。
 */
/** Step 5: do not execute tools from a length-truncated assistant message. */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 每个调用照样产出一条结果消息,数量与 toolCall 一一对应。
	// 少一条就会留下没有 toolResult 的孤儿 toolCall,重放这段历史时可能被 provider 拒收。
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		// 照常发 tool_execution_start:UI 的工具卡片形状不变,只是内容变成一条错误。
		// 少发这个事件的话前端会收到一个没有开头的 tool_execution_end。
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		// 错误文案是写给模型看的,三件事一次说清:没执行、为什么(触到输出上限)、
		// 怎么办(带完整参数重发)。改这段文案等于改模型的自愈行为。
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	// terminate 固定 false —— 保证 hasMoreToolCalls 变成 true,循环必然再跑一轮,
	// 让模型有机会重发那些被截断的调用。写成 true 会让整轮就此停死。
	return { messages, terminate: false };
}

/**
 * 串行执行:一个工具完整跑完(准备 → 执行 → 定稿 → 发事件 → 造消息)才开始下一个。
 *
 * 与并行版最容易被忽略的差别不在速度,而在事件时序:这里第 N+1 个工具的
 * tool_execution_start 要等第 N 个彻底结束之后才发,所以前端卡片是一张一张出现的;
 * 并行版则是一开始就把全批的 start 事件一次性发完。
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 两个平行数组:finalizedCalls 只用来算 terminate,messages 是要回灌 transcript 的。
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	// 严格顺序执行,所以完成序天然等于源序,不需要像并行版那样把收尾挪到 Promise.all 之后。
	for (const toolCall of toolCalls) {
		// args 发的是模型吐出来的原始参数,不是校验/转换之后的 —— 前端展示的是
		// 「模型说它要干什么」。校验后的对象只交给 execute 与两个 hook。
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		// 准备阶段:查工具 → prepareArguments 整形 → 校验 → beforeToolCall。
		// 它永远不抛,失败一律编码成 kind: "immediate" 的错误结果(见 §7)。
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		// 准备阶段就出结果:跳过 execute,也跳过 afterToolCall —— 这意味着 hook 看不到
		// 「工具不存在」「参数不合法」「被 block」这三类失败。
		if (preparation.kind === "immediate") {
			finalized = { toolCall, result: preparation.result, isError: preparation.isError };
		} else {
			// 真跑:execute 负责流式回报,finalize 负责跑 afterToolCall 并合并覆盖。
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		// 三连收尾的顺序是协议:先 tool_execution_end(给 UI 更新卡片),
		// 再造 ToolResultMessage 并发 message_start/message_end(给 transcript 与落盘)。
		// 反过来会让前端先看到一条完整消息、再收到「工具刚结束」的通知。
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		// 坑:中断时直接 break,剩下的 toolCall 一条结果消息都不造。
		// 于是 transcript 里会留下「有 toolCall 却没有对应 toolResult」的 assistant 消息
		// (悬空批次),而 convertToLlm 不做补齐。能不能重放取决于 provider 的宽容度
		// ——pi-ai 的 transformMessages 会给孤儿调用补一条合成结果,算第二道防线。
		// 注意这个检查在收尾之后:当前这个工具的结果一定会被完整记下来。
		if (signal?.aborted) {
			break;
		}
	}

	// terminate 只看真正定稿的那些结果;被 break 跳过的调用不参与投票。
	return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

// 并行执行。三段时序是这个函数的全部要点,读的时候按段对号入座:
//   1) 准备阶段串行 await —— 校验与 beforeToolCall 逐个跑完,期间没有任何 execute 启动;
//   2) 执行阶段并发     —— Promise.all 那一行同步调用全部 thunk,并发从这里开始;
//   3) 收尾阶段按源序   —— 全部落定之后,按 assistant 消息里 toolCall 的原始顺序造消息。
// 于是同一批工具存在两条不同的顺序:tool_execution_end 是完成序(谁先跑完谁先出,
// UI 因此能第一时间画出已完成的卡片),ToolResultMessage 是源序(provider 的要求)。
/**
 * Step 5 parallel:
 * - prepare sequentially (validation / beforeToolCall)
 * - execute allowed tools concurrently
 * - tool_execution_end in completion order; toolResult messages in assistant source order
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 混合数组:immediate 的结果已经定稿直接入列,prepared 的入列的是一个还没跑的 thunk。
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	// 准备阶段:这个 for 里的每一步都是 await,所以全批的校验与 beforeToolCall
	// 是严格串行的。带来的一个重要性质是「某个 hook 决定 block 时,别的工具还没开跑」。
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		// 与串行版共用同一个准备函数,行为完全一致。
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		// immediate 的分支立刻定稿并发 tool_execution_end —— 于是「工具不存在 / 参数不合法 /
		// 被 block」这类失败的结束事件会早于任何真工具跑完,前端要能接受这个顺序。
		if (preparation.kind === "immediate") {
			const finalized: FinalizedToolCallOutcome = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			// 准备期间被中断:已经入列的 thunk 仍然会被下面的 Promise.all 跑掉(它们拿到的是
			// 已 abort 的 signal,由工具自己识别),但还没准备的调用直接放弃 —— 同样留下悬空批次。
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		// 推的是 thunk 不是 Promise:此刻并不启动,execute 要等 Promise.all 那一行才发生。
		// 这正是「准备串行、执行并发」的实现手法。
		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			// 完成序 emit:每个工具一跑完就地发自己的 tool_execution_end,不等同批的其他人。
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});

		// 与上面那个 aborted 检查成对:prepared 分支走到底也要复查一次。
		if (signal?.aborted) {
			break;
		}
	}

	// 并发真正开始的一行。map 是同步的,所以全部 thunk 在这一刻被依次调用、各自跑到
	// 第一个 await 就让出;已经定稿的条目用 Promise.resolve 包一层混进来占位。
	// Promise.all 保留输入顺序,所以结果数组天然回到源序。
	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);

	// 收尾阶段:按源序逐条造 ToolResultMessage 并发消息事件。
	// 这一段刻意放在 Promise.all 之后而不是塞进 thunk 里 —— 塞进去就会变成完成序,
	// 而不少 provider 要求 toolResult 与 assistant 消息里的 toolCall 同序。
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	// 投票名单包含 immediate 的失败结果,而它们的 terminate 是 undefined,
	// 所以「批里有任何失败」就一定不会早停。这是全票制的自然推论。
	return { messages, terminate: shouldTerminateToolBatch(orderedFinalizedCalls) };
}

// ── §7 单次工具调用的三段:prepare → execute → finalize ────────────────

/**
 * 第一段:准备。查工具 → 整形入参 → 校验 → 跑 beforeToolCall。
 *
 * 返回判别联合:kind 为 "prepared" 表示可以执行,"immediate" 表示已经有结果了。
 * 这个函数永远不向外抛异常 —— 四种失败(工具不存在、整形/校验抛错、被 block、
 * 被中断)全部编码成 immediate 结果,这样调用方(串行/并行两条路径)不需要 try。
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 按名字线性查表。tools 是可选的,没有工具时 ?. 直接给 undefined。
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	// 从这里到 catch 之间的任何异常都会变成一条错误工具结果:
	// prepareArguments 抛、校验失败抛、beforeToolCall 抛,三类一视同仁。
	try {
		// 校验之前唯一的入参整形钩子。edit 工具用它把「edits 是一个 JSON 字符串」
		// 或者旧版单条 oldText/newText 的写法折算成标准数组。
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		// 校验 + 强制类型转换:内部先 structuredClone 一份参数(所以返回的是副本,
		// 不是 toolCall.arguments 本体),再跑 Value.Convert 做 "3"→3 这类强转,
		// 最后用编译好的 typebox 校验器 Check。schema 不是 TypeBox 产物时还会额外跑一遍
		// 手写的 JSON Schema 递归强转兜底。失败时抛出带字段路径的详细错误。
		const validatedArgs = validateToolArguments(tool, preparedToolCall);

		// beforeToolCall:执行前的最后一道闸门。它拿到的 args 就是上面那份校验后的对象本体,
		// 就地修改它会直接影响 execute 拿到的参数,而且不会重新校验(测试专门钉了这个行为:
		// 把字符串改成数字也照跑)。要挡下调用请返回 { block: true },不要靠改参数。
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{ assistantMessage, toolCall, args: validatedArgs, context: currentContext },
				signal,
			);
			// hook 可能是个耗时的异步操作(比如弹权限框),回来之后必须先复查中断,
			// 否则会在用户已经点了停止之后还把工具跑起来。
			if (signal?.aborted) {
				return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
			}
			// block 的语义是「不执行,但要给模型一条说明」。reason 直接变成模型看到的文本,
			// 缺省文案是那句 Tool execution was blocked。
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}

		// 第二次复查:覆盖「没配 beforeToolCall,但校验期间用户按了停止」这条路径。
		// 两处检查都必须留着 —— 删掉任何一处都会留下一个能把工具跑起来的窗口。
		if (signal?.aborted) {
			return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
		}

		// 走到这里表示可以执行。args 是校验后的副本,tool 是已经查好的定义。
		return { kind: "prepared", toolCall, tool, args: validatedArgs };
	// 统一的失败出口:异常消息原样交给模型。Error 之外的抛出物(字符串、对象)
	// 用 String() 兜住,保证不会因为「抛了个不是 Error 的东西」而让循环崩掉。
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 第二段:执行。调 tool.execute,把它的流式部分结果转成 tool_execution_update 事件。
 *
 * 工具的契约是「失败要 throw,不要把错误编进 content」——这个函数负责把 throw
 * 接住并翻成一条 isError 的结果,于是循环上层永远看不到异常。
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	// 攒住所有 update 事件的 Promise。不在回调里直接 await 的原因是 onUpdate 是同步
	// 回调(签名返回 void),工具那边没法等;所以先收集,回来之后统一 await。
	const updateEvents: Promise<void>[] = [];
	// onUpdate 的作用域只限本次 execute。工具在 promise 落定之后再调它(常见于忘了
	// 清定时器的长驻工具)会被这个标志静默忽略,避免往已经结束的工具卡片上补事件。
	let acceptingUpdates = true;

	try {
		// 四个参数的顺序是 AgentTool 的公开契约:id、校验后的参数、中断信号、更新回调。
		// as never 是为了绕开泛型:这里的 tool 是 AgentTool<any>,参数的具体形状已经在
		// 校验那一步保证过了。
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			// 流式部分结果:bash 每 100ms 推一次尾巴,log 推 20 行窗口。
			// 这些事件只喂 UI,不进 transcript,也不影响最终的工具结果。
			(partialResult) => {
				// 迟到的 update 直接丢弃,不排队也不报错。
				if (!acceptingUpdates) return;
				// 把 emit 的返回值包成 Promise 收进数组。emit 可能是同步的(返回 void),
				// Promise.resolve 统一形状。
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// 成功路径:先关掉更新窗口,再等所有 update 事件送达。
		acceptingUpdates = false;
		// 这一句 await 是必要的:emit 是异步的,不等它就可能出现
		// 「tool_execution_end 先于最后一条 tool_execution_update 到达订阅者」的乱序。
		await Promise.all(updateEvents);
		return { result, isError: false };
	// 工具抛异常的正常处理路径 —— 这是契约的一部分,不是意外。
	// 注意失败路径同样要 await 掉已经发出的 update 事件,顺序保证与成功路径一致。
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	// finally 是兜底:成功与失败两支都已经置过 false,这里防的是将来有人新增 return 分支。
	} finally {
		acceptingUpdates = false;
	}
}

/**
 * 第三段:定稿。跑 afterToolCall,把它的返回值逐字段合并进结果。
 *
 * 合并语义是「逐字段替换,不做深合并」:给了就整个换掉,没给就保留原值。
 * 这个函数也不抛 —— hook 自己抛异常时,结果被整个替换成一条错误结果。
 */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	// 先拷成局部变量,后面可能被 hook 覆盖。
	let result = executed.result;
	let isError = executed.isError;

	// 没配 hook 时整段跳过,执行结果原样定稿。
	if (config.afterToolCall) {
		try {
			// hook 能看到的东西比 beforeToolCall 多两样:执行结果 result 与当前的 isError,
			// 于是它可以做「把成功改判成失败」或者「重写给模型看的内容」这类事。
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			// 返回 undefined 表示「不改」,这是绝大多数情况。
			if (afterResult) {
				// 逐字段 ?? 合并。注意 terminate 用的也是 ??:hook 只能把 undefined 补成 true,
				// 不能把工具已经标好的 true 抹回 false —— 想撤销早停请求在当前接口下做不到。
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				// isError 单独一行,因为它不在 result 对象里而是外挂的标志位。
				isError = afterResult.isError ?? isError;
			}
		// hook 抛异常的代价很重:整条结果(哪怕工具本来跑成功了)被替换成错误结果。
		// 这是刻意的保守选择 —— hook 炸了说明后置处理没做完,把半成品交给模型更危险。
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	// 定稿产物同时带上 toolCall,后面造事件和造消息都要用到 id 与 name。
	return { toolCall: prepared.toolCall, result, isError };
}

// ── §8 收尾小函数:入参整形、错误结果、事件与消息构造 ───────────────────

/**
 * 校验之前唯一的入参整形钩子的调用壳。
 *
 * 关键约定:钩子返回同一个引用时,toolCall 原样返回、不重建对象。
 * 这让「就地改写参数」与「返回新对象」两种写法都能工作 —— edit 工具的
 * prepareEditArguments 两条路径正好各用一种。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	// 绝大多数工具没有这个钩子,直接短路。
	if (!tool.prepareArguments) {
		return toolCall;
	}
	// 传给钩子的是 toolCall.arguments 本体,所以钩子可以选择就地改写它。
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	// 引用相等 = 钩子选择了就地改写(或者什么都没做),这时重建对象没有意义。
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	// 引用不同才浅拷一层换掉 arguments,原 toolCall 对象保持不动 ——
	// 它还挂在 assistant 消息的 content 里,改它就等于改历史。
	return { ...toolCall, arguments: preparedArguments as Record<string, any> };
}

/**
 * 造一条错误工具结果。
 *
 * 坑:details 恒为空对象。所有内核侧产生的错误(工具不存在、校验失败、被 block、
 * 被中断、length 截断、afterToolCall 抛错)都长这样,前端别指望从 details 里读到
 * 结构化信息 —— 唯一的信息载体是 content 里那句文本。
 * 另外注意它不设 isError,错误标记由调用方在 FinalizedToolCallOutcome 上单独带。
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * 发 tool_execution_end。串行路径在收尾时调,并行路径在每个 thunk 内部调 ——
 * 后者正是「完成序」的来源。
 */
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

/**
 * 把定稿结果翻成一条 ToolResultMessage —— 这是工具执行结果进入 transcript 的
 * 唯一形态,也是回灌给模型的东西。
 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// content 兜一个空数组:工具理论上可以返回没有 content 的结果,
		// 而 ToolResultMessage.content 是必填的。
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		// 条件展开:只有真的有 addedToolNames 时才写这个字段。
		// 无脑写 undefined 会让这个键出现在 JSON 里、进到会话文件,增加无谓的噪声,
		// 也会让「这条消息有没有引入新工具」的判断从「有没有这个键」退化成「值是不是空」。
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		// 时间戳在这里现取。三种 Message 都有 timestamp,是会话回放排序的依据。
		timestamp: Date.now(),
	};
}

/**
 * 工具结果也走 message_start / message_end 两拍。
 *
 * 为什么要发这两个事件而不是只发 tool_execution_end:harness 是在 message_end
 * 上做 session.appendMessage() 的,不发这一对,工具结果就永远不会落盘。
 * 两个事件之间没有 message_update —— 工具结果不是流式产物。
 */
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
