# packages/agent/src/agent-loop.ts

> **档位** A(逐行) · **行数** 1265(加注释前 744)
> **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §1 ④⑧⑨ · §3「第二组:agent 循环」 · §4 阶段 2–6 · §6.1 · **索引** [README](../README.md)

## 1. 一句话

这是 Yoma 内核里**唯一的状态机**:一个双层 `while`,把「用户的一次 prompt」变成「N 轮:发一次 LLM 请求 + 执行模型点名的工具」,直到模型不再要工具、也没有人插话为止。

---

## 2. 它在全景里的位置

先把三个术语钉住,后面全篇都在用:

- **harness**(会话外壳)—— `AgentHarness`,一个「能长期用下去的会话对象」。它管相位、管落盘、管快照,但**自己一行循环都没有**。
- **tool call**(工具调用)—— 模型在回答里吐出的一个内容块,意思是「我要你替我执行 `read`,参数是这些」。模型自己不会执行任何东西,执行是这个文件的活。
- **compaction**(上下文压缩)—— 历史太长塞不进模型的上下文窗口时,把旧的一段换成一条摘要。这个文件不做压缩,但它提供了压缩唯一的落点(`prepareNextTurn`)。

这个文件在链路上处在**第四跳**,对应全景篇 §1 分层图的 ④:

```
① 用户输入 → ② harness 相位守卫 + 冻结 turn 快照 → ③ 会话树读侧(投影)
   → ④ 本文件:runAgentLoop / runLoop  ←── 你在这里
      → ⑤ convertToLlm(LLM 边界)→ ⑥ pi-ai 注册表 → ⑦ 厂商协议 HTTP
      → ⑧ 事件流回程,本文件把它翻成 AgentEvent → harness 落盘 + 转发订阅者
      → ⑨ 工具执行(仍在本文件)→ ⑩ 工具实现(coding-agent)
      → ⑪ 结果回灌,回到 ④ 再发一次请求
```

对应全景篇 §4 的编号步骤:**第 9 步**(harness 的 `executeTurn` 调 `runAgentLoop`)进入本文件;**第 10–13 步**是入口的开局与双层 while 的第一圈;**第 14–16 步**是 `streamAssistantResponse` 的前半段(transformContext → convertToLlm → 拼 `Context` → 调 `streamFn`);**第 25、27 步**是流式事件回程与 error/aborted 早退;**第 28–36 步**整段是工具执行;**第 36–42 步**是轮末的 `prepareNextTurn` / `shouldStopAfterTurn` / 两个队列 / `agent_end`。

**谁调它:** 本仓库生产路径上只有一个调用方——`harness/agent-harness.ts`。`executeTurn`(:941)调 `runAgentLoop`(调用点在 :976),`retryLastTurn`(:1167)调 `runAgentLoopContinue`(调用点在 :1210),各一次,都经 `runLoopToCompletion` 统一包上 abort 与错误尾巴。另有一个非生产调用方 `agent.ts` 的 `Agent` 类(参考实现),以及 `test/agent-loop.test.ts` 的 20 个用例(用的是返回流的那一对入口)。

**它调谁:** 往下只有两条腿——`config.convertToLlm()` 与 `streamFn()`。前者是 `AgentMessage[]` 变成 pi-ai `Message[]` 的唯一转换点(实现在 `harness/messages.ts`),后者是发请求的唯一出口(harness 用 `createStreamFn` 把 provider 钩子包进去,最终落到 `models.streamSimple`)。工具那一侧它只认 `AgentTool.execute` 这个回调,完全不知道 read / bash / gdb 是什么。

**不存在会怎样:** 整个内核就没有「多轮」这个概念了。模型的第一条回答里带着工具调用,没人执行、没人把结果回灌、没人再发第二次请求——agent 会退化成一个只能说一句话的聊天框。全景篇那句「只有一个循环」不是修辞:harness 全类里没有任何 while/for 驱动轮次,宿主(桌面端 host / ACP / bench)也没有。

> ⚠️ 全景篇 §1 分层图给本文件标的三个行号锚点(`runLoop :131`、`streamAssistantResponse :266`、`executeToolCalls :356`)与代码对不上,详见 §5。对照阅读时**按符号名找,别按行号找**。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–42 | 上游原有的 Step 1–5 教学地图(L1–8)+ 新增的总述块与分节索引(L10–42) |
| §1 | L44–91 | 契约导入、`AgentEventSink`、`noStreamFnConfigured` 哨兵 |
| §2 | L92–288 | 四个入口(`agentLoop` / `agentLoopContinue` / `runAgentLoop` / `runAgentLoopContinue`)与流工厂 `createAgentStream` |
| §3 | L290–492 | `runLoop`:双层 while 状态机(整个文件的心脏) |
| §4 | L494–655 | `streamAssistantResponse`:发一次请求并消费回程事件流 |
| §5 | L657–716 | 工具执行的类型层与批级 `terminate` 判定:六个类型 + `shouldTerminateToolBatch` |
| §6 | L718–969 | 三条执行路径:模式选择 / length-失败 / 串行 / 并行 |
| §7 | L971–1176 | 单次工具调用的三段:`prepareToolCall` → `executePreparedToolCall` → `finalizeExecutedToolCall` |
| §8 | L1178–1265 | 收尾小函数:入参整形、错误结果、事件与消息构造 |

> 下面代码块里的行号是**加注释之后**的真实行号;为便于阅读,块内省去了新加的中文注释,只保留代码与上游原有的英文注释。

---

## 4. 逐节讲解

### §1 契约导入与两个基础件(L44–91)

`L79`

```ts
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

**事件汇**。循环把 10 种 `AgentEvent` 全交给它,自己完全不关心谁在听。两个性质要记住:

1. **它是背压点。** 循环对每一次 `emit` 都 `await`,所以慢的监听器会真的把循环拖慢。harness 正是靠这个同步性做到「`message_end` 先落盘、再转发给订阅者」的——见 `agent-harness.ts:handleAgentEvent`。
2. **它抛异常会把循环炸掉。** 循环自己不 catch;走 `runAgentLoop` 的调用方(harness)有兜底,走 `agentLoop` 的没有(见 §5 第 1 条)。

`L86–90`

```ts
const noStreamFnConfigured: StreamFn = () => {
	throw new Error(
		"no streamFn configured. Pass streamFn, e.g. (model, ctx, opts) => models.streamSimple(model, ctx, opts).",
	);
};
```

没传 `streamFn` 时的哨兵。注意它**不在入口处提前校验**,而是等到真要发请求那一刻才抛。这样「只想跑一遍事件流形状」的测试可以不给 `streamFn`。

还要注意它是**同步 throw**,会从 `streamAssistantResponse` 一路冒到 `runLoop` 之外——刻意不走 errors-as-data 那条路,因为这属于「配置错了」而不是「请求失败了」。

---

### §2 四个入口与流工厂(L92–288)

同一套逻辑对外有**两种调用形态 × 两种起跑点** = 四个入口:

| | 从新 prompt 开跑 | 从上下文尾部续跑 |
|---|---|---|
| **返回 EventStream** | `agentLoop` | `agentLoopContinue` |
| **收 emit 回调,返回 Promise** | `runAgentLoop` | `runAgentLoopContinue` |

后一行是前一行的内核。harness 用的是后一行(它要在 `emit` 里落盘),测试用的是前一行(流更好断言)。

#### 流形态:`agentLoop`(L109–131)

`L109–131`

```ts
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(prompts, context, config, async (event) => {
		stream.push(event);
	}, signal, streamFn).then((messages) => {
		stream.end(messages);
	});

	return stream;
}
```

先建流再起循环——循环第一件事就是 `emit({type:"agent_start"})`,流必须已经存在。

`void ... .then(...)` 这一句是**「起个后台任务,把事件源源不断喂进流」**的写法。函数同步返回流,调用方立刻可以 `for await`。

**这里没有 `.catch`**,是这个文件最锋利的一条坑,详见 §5 第 1 条。

#### 流形态:`agentLoopContinue`(L139–169)

`L149–158`

```ts
	const last = context.messages.at(-1);
	if (!last) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (last.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
```

两条前置校验。为什么 assistant 结尾不能续:模型已经说完了话,再发一次请求等于让它对着自己的上一句自言自语。可续的尾巴是 user 消息、toolResult 消息,或任何自定义角色(测试 `should allow custom message types as last message` 专门钉了最后这条,并注明「caller responsibility」)。

注意这里是**同步 throw**(函数不是 `async`),而 `runAgentLoopContinue`(L245–253)里逐字重复的同一份校验因为在 `async` 函数体内,变成了 **reject**。同一份规则,两种失败形态,调用方的 `try/catch` 写法不一样。

#### 回调形态:`runAgentLoop`(L188–225)

`L198–223`

```ts
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
```

三件事:

- **`newMessages` 是给调用方的账本。** 它把 `prompts` 也算进「本次新产生的消息」,于是 harness 拿到的是「这一轮从头到尾发生了什么」的完整清单。
- **`currentContext` 是给模型看的上下文。** 这里 `messages` 换成了一个**新数组**,所以循环往里 push 不会污染调用方传进来的 `context.messages`。这一行是两个入口最重要的差别(见下)。
- **事件顺序是协议。** `agent_start` 一定先于 `turn_start`,`turn_start` 又先于本轮任何消息事件。prompt 消息立刻走完 `message_start` / `message_end` 两拍——它们不是流式产物,没有中间态。harness 在 `message_end` 上做 `session.appendMessage()`,所以**「用户说的话」是在这里落盘的**,不是在 `prompt()` 里。

#### 回调形态:`runAgentLoopContinue`(L238–270)

`L257–266`

```ts
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
```

与上一个函数的三处差别:

1. `newMessages` 从**空数组**开始——续跑不把已有历史算成「本次新产生的消息」。`harness.retryLastTurn` 依赖这一点来判断「这次重试到底产出了什么」。
2. `{...context}` **只浅拷了一层对象,messages 数组没有复制**——循环会直接往调用方的数组里 push。见 §5 第 3 条。
3. 不发任何 `message_start` / `message_end`(没有新 prompt),但仍然发 `turn_start`:一次「运行」总要有至少一个 turn 的外壳,否则前端的 turn 卡片会缺一层父节点。测试 `should continue from existing context without emitting user message events` 钉的就是这条。

#### 流工厂:`createAgentStream`(L272–288)

`L279–288`

```ts
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}
```

`EventStream`(`ai/src/utils/event-stream.ts`,88 行)是一个**推拉合一的队列**:`push(e)` 时若有消费者正在 `await` 就直接把值交给它,否则进队列。构造时要回答两个问题——哪个事件算终结、从终结事件里怎么取最终结果。pi-ai 侧的答案是 `done`/`error`,agent 侧的答案就是上面这两行。

同一个类、两套参数化,是 §5 里两条挂死坑的共同来源。

---

### §3 `runLoop`:双层 while 状态机(L290–492)

**整个内核唯一的状态机,也是最该在纸上画一遍时序的一段。** 两层循环各管一件事:

```
外层 while(true)   ← follow-up「续摊」:agent 本来要停了,但队列里还有话,那就重开一整轮
  内层 while(...)  ← 工具多轮 + steering「插队」:模型要工具就再发一次请求,有人插话也再发一次
```

一句话记住两个队列的差别:**steering 是插队(飞行中注入),follow-up 是续摊(将停时追加)。** 差别只在**被拉取的时机**,不在数据形状——两边都是 `() => Promise<AgentMessage[]>`。

#### 开局:三个可变局部量 + 第一次拉 steering(L314–326)

`L314–326`

```ts
	// prepareNextTurn may replace context/model/thinking between turns
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Step 4: steering queued before / during the run (e.g. user typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
```

- `currentContext` 与 `config` 会在轮次之间被 `prepareNextTurn` 整个换掉(harness 的实现是 `flushPendingSessionWrites()` + `createTurnState()` 重建快照,于是会话里新出现的压缩投影从下一轮起被循环看见)。
- `firstTurn` 存在的唯一理由:首轮的 `turn_start` 已经由入口函数发过了,内层循环第一次进来必须跳过,否则前端会收到两个 `turn_start` 而多画一张卡片。
- **开跑前先拉一次插话队列**——用户可能在上一轮还没结束时就敲了下一句。这是 steering 的第一个拉取点(第二个在每轮末尾)。`|| []` 兜的是「回调根本没配」。

#### 两层循环的头(L330–359)

`L330–359`

```ts
	while (true) {
		let hasMoreToolCalls = true;

		// Inner: tool multi-turn + steering injection
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Inject steering messages before the next assistant response
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}
```

- `hasMoreToolCalls = true` 在**每次重进外层时**都会被重置——这保证 follow-up 续摊时至少还能完整跑一轮请求。
- 内层的进入条件是「还有活干」:要么上一轮留下了待执行的工具,要么有人插话。两者都空就掉出内层,去外层问 follow-up。
- 注入插话必须发生在**下一次请求之前**,这样模型在同一次请求里就能看到新指令。**当前这一轮的工具照常执行、不会被跳过**——插话不是取消。
- 每条消息都要同时 push 进 `currentContext.messages`(给模型看)和 `newMessages`(给调用方)。漏掉任何一个都会造成历史断裂。

#### 发请求与早退(L363–374)

`L363–374`

```ts
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
```

**errors-as-data 的兑现处。** provider 失败或被 abort 时,消息本身已经带着 `stopReason` 与 `errorMessage` 进了 transcript,循环这里只负责收摊:发一个空 `toolResults` 的 `turn_end`,再发 `agent_end`,`return`。

注意它**两个队列一个都不拉**——排在队列里的插话不会被这一轮消费掉,留给下一次 prompt。

#### 工具批次(L378–408)

`L378–408`

```ts
			const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;

			if (toolCalls.length > 0) {
				// Step 5: truncated output → arguments may be incomplete; fail instead of execute.
				const batch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
				toolResults.push(...batch.messages);
				hasMoreToolCalls = !batch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
```

一条 assistant 消息里的全部 `toolCall` 块就是一个 **tool batch**。它们要么一起串行、要么一起并行,**不会跨消息混批**。

- `hasMoreToolCalls` 先置 `false`:默认这一轮之后就停,只有真的执行了工具、而且没被 `terminate` 叫停,才翻回 `true`。
- **`length` 分叉**:`stopReason === "length"` 说明模型的输出被 `maxTokens` 砍断了,最后那个 `toolCall` 的参数 JSON 很可能只写了一半——而流式 JSON 解析器有三级兜底,半截 JSON 照样能解出一个**结构合法**的对象。拿它去 edit 文件或者烧板子,后果是静默的错误动作。所以这里换成「一律不执行,造错误结果让模型重发」。
  **反面**:被截断的消息里如果没有工具调用,循环不做任何补救,按正常结束处理。
- 没有工具调用时整段跳过,`toolResults` 保持空数组,循环随后靠 `hasMoreToolCalls` 为 `false` 掉出内层——「模型说完了话」就是这条路径。

#### 轮末四步(L412–470)

`L412`

```ts
			await emit({ type: "turn_end", message, toolResults });
```

`turn_end` 的载荷是「这一轮发生了什么」的完整快照。harness 收到它会先 `emitAny`(订阅者抛的错**暂存**不吞)→ 再 `flushPendingSessionWrites()` → 然后才抛暂存的错 → 都没错才发 `save_point`。

`L420–449`

```ts
			const nextTurnSnapshot = await config.prepareNextTurn?.({
				message,
				toolResults,
				context: currentContext,
				newMessages,
			});
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}
```

**次序不能反。** `prepareNextTurn` 先跑,它拿到的是「刚跑完这一轮」的现场;`shouldStopAfterTurn` 后跑,它的入参 `context` 是**替换之后**的那份——判断该不该停要看新上下文有多大。

> ⚠️ 别把这一对读成「桌面端自动压缩的实现」:`shouldStopAfterTurn` 在本仓**没有任何生产调用方**(全仓 grep 只命中 `agent-loop.test.ts`),而自动压缩是宿主在轮末调 `harness.compact()` 做的。`prepareNextTurn` 只负责把重建后的快照带回循环。详见 §5 第 18 条。

三处细节:

1. `currentContext = ...` 之后,所有 push 都落进**新数组**。压缩之所以能「持久生效」全靠这一行——对比 §4 的 `transformContext`,那个的返回值只喂给本次请求、不写回。
2. `config = {...config, ...}` 是**整个换掉对象**而不是就地改字段:`...config` 保留其余回调与流选项(`AgentLoopConfig` 一共 11 个自有字段:`model` + 九个回调 + `toolExecution`),只覆盖 `model` 与 `reasoning`;就地改会污染调用方传进来的那个对象。
3. `reasoning` 是**三态**而不是两态,读的时候最容易看漏:
   - `thinkingLevel === undefined` → 钩子没提要求,保持当前 `reasoning` 不动
   - `thinkingLevel === "off"` → 把 `reasoning` **整个摘掉**(请求里不带 reasoning 参数)
   - 其余档位字符串 → 直接替换

   「off 等于摘掉」对 reasoning 模型影响很大:最强的一档被默认关掉且没有任何提示,这就是桌面端要额外注入 `defaultThinkingLevel` 的原因(见根 `CLAUDE.md`)。

`L455–464`

```ts
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
```

主动停:返回 `true` 就直接 `agent_end` 并 `return`,**两个队列都不拉**。与上面的 error/aborted 早退不同,这条路径是「正常收工」——本轮的 assistant 回答与工具执行都已经完整跑完了。

`L470`

```ts
			pendingMessages = (await config.getSteeringMessages?.()) || [];
```

steering 的**第二个拉取点**,在 `prepareNextTurn` 与 `shouldStopAfterTurn` 之后。位置决定语义:只要 agent 还在干活,插话就一定会在下一次请求前进入上下文。这里重新赋值(不是追加)是安全的,因为上面的注入循环已经把数组清空了。

#### 外层的续摊与终局(L474–492)

`L473–491`

```ts
		// Would stop here — Step 4 follow-up: only run if agent has nothing else to do
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
```

走到这里说明 agent 本来就要停了:没有待执行工具,也没有插话。`getFollowUpMessages()` 是给「等它忙完再说」的消息准备的最后一次机会。

有货就 `continue` 回外层顶端,`hasMoreToolCalls` 被重置为 `true`,于是又是一整轮完整的 turn。

**全文件一共三处 `agent_end`**:error/aborted 早退、`shouldStopAfterTurn` 主动停、这里的自然结束。任何一条路径都必须发到它,否则订阅者永远等不到运行结束,`EventStream` 也不会终结,`await stream.result()` 直接挂死。

---

### §4 `streamAssistantResponse`:发一次请求并消费回程事件流(L494–655)

四段:`transformContext`(本轮临时裁剪)→ `convertToLlm`(LLM 边界)→ `streamFn`(真正发请求)→ `for await` 消费 **12 类**流事件并翻成 **3 种** `AgentEvent`。

#### 前半段:拼出一次请求(L517–556)

`L517–537`

```ts
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
```

- `transformContext` 是「本轮临时裁剪」的钩子(harness 把它接到 `context` hook 上)。**返回值只赋给局部变量,不写回 `context.messages`**——想让裁剪持久生效必须走 `prepareNextTurn`。
- `convertToLlm` 是**整个内核唯一的 LLM 边界**:`AgentMessage[]`(内部形状,可以有自定义角色)降维成 pi-ai 的 `Message[]`(能发给模型的形状)。本仓的实现在 `harness/messages.ts`,它把 `bashExecution` / `custom` / `branchSummary` / `compactionSummary` 投影成 user 消息,或者直接丢弃。想知道「什么进 LLM、什么只进 transcript」,只需要读那一个函数。
- `Context` **只有三个字段**,而且是每一轮现场拼出来的——它不是长期存活的状态。注意 `systemPrompt` 与 `tools` 直接取自 `context`,所以 `prepareNextTurn` 换上下文时换掉的不只是消息,还包括系统提示词与工具集。

`L540–556`

```ts
	const streamFunction = streamFn || noStreamFnConfigured;
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
```

- **apiKey 有两级来源**,动态解析器优先。`getApiKey` 存在的理由是短寿命 OAuth token(比如 GitHub Copilot)可能在漫长的工具执行阶段过期,必须每次请求前重新取一遍。注意是 `||` 而不是 `??`:返回空字符串时也会回落到 `config.apiKey`。
- `...config` 把整个 `AgentLoopConfig` 摊平当请求选项用。这是合法的——`AgentLoopConfig extends SimpleStreamOptions`,`reasoning` / `maxTokens` / `sessionId` 本来就在里面;多出来的 `model`、`convertToLlm` 等字段对协议层是无害的冗余。`signal` 放在最后覆盖(`StreamOptions` 里也有同名字段),保证中断信号不会被顶掉。

#### 后半段:消费流(L558–654)

`L561–564`

```ts
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
```

`partialMessage` 是「当前这条半成品消息」的引用。**关键性质:pi-ai 每个事件带的 `partial` 始终是同一个 `output` 对象的引用,不是快照**——消费者要么立刻读、要么自己拷贝。

`addedPartial` 决定收尾时是「替换末位」还是「追加一条」,也决定要不要补发 `message_start`。

`L572–583`

```ts
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;
```

`start` 一到就把半成品**直接 push 进上下文**——于是「正在流式输出的这条消息」从第一刻起就在 `context.messages` 里,后续 delta 只是原地替换末位。这样即使中途被 abort,已经吐出来的半截话也留在 transcript 里。

`{ ...partialMessage }` 是浅拷一层。它能冻住 `role` / `stopReason` / `usage` 这些顶层字段,但**`content` 数组仍然是同一个引用**,订阅者读到的内容块依然会随着流继续变。桌面端投影器因此始终从 `partial.content` 整体重算快照,而不是攒 delta。

`L588–611`

```ts
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;
```

**九类增量事件走同一段代码**:文本、思考、工具调用三组各自的 `_start` / `_delta` / `_end`。循环并不区分它们,原样把事件塞进 `message_update` 的 `assistantMessageEvent` 字段交给上层——前端要区分「这是正文还是工具参数」就读那个字段。

`context.messages[len-1] = partialMessage` 其实是自赋值(`partial` 一直是同一个引用),留着是为了让「末位永远是当前这条消息」这个不变式在代码里显式成立。

`if (partialMessage)` 这个守卫是一条坑,见 §5 第 7 条。

`L615–637`

```ts
			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
```

**`done` 与 `error` 走同一段收尾代码**——这正是 errors-as-data:失败不是异常路径,只是 `stopReason` 不同的另一条正常返回。

- 终态消息由流自己提供:`EventStream` 的 `extractResult` 从 `done` 取 `event.message`、从 `error` 取 `event.error`(两者都是 `AssistantMessage`)。它与 `partial` 通常是同一个对象,但契约上只保证「这是最终形状」,所以必须以它为准写回上下文。**终态与半成品的差别在于**:临时字段(`partialArgs` 等)已被删除、`usage` 与 `stopReason` 已经填好——会话文件里必须存的是这一份。
- `if (!addedPartial)` 补发 `message_start`:覆盖「从没收到过 `start` 事件」的情形(比如 setup 阶段就失败了),保证订阅者看到的永远是完整的 start→end 配对。
- `message_end` 发的是 **`finalMessage` 本身而不是拷贝**——harness 就是在这个事件上调 `session.appendMessage()` 落盘的,拷贝反而会让「落盘的」与「转发的」不是同一个对象。

`L644–654`

```ts
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
```

兜底路径:流被 `end()` 结束却从没推过 `done` / `error`。正常的 provider 实现不会走到这里。两段代码刻意重复而不是抽函数,因为 `for await` 内部要 `return` 出去。见 §5 第 9 条。

---

### §5 工具执行的类型层与批级 terminate 判定(L657–716)

六个类型,读的时候按「一次工具调用的三个阶段」对号入座:

| 类型 | 行号 | 含义 |
|---|---|---|
| `ExecutedToolCallBatch` | L662–665 | 一批执行完的产物:要回灌 transcript 的结果消息 + 是否收工 |
| `PreparedToolCall` | L669–674 | 准备成功,可以真的去 `execute`;带 `tool` 引用避免二次查表 |
| `ImmediateToolCallOutcome` | L679–683 | 准备阶段就出结果、不需要 execute 的四种情形 |
| `ExecutedToolCallOutcome` | L687–690 | `execute` 跑完的原始产物(还没过 `afterToolCall`) |
| `FinalizedToolCallOutcome` | L693–697 | 定稿:可以拿去造事件与消息的最终形态 |
| `FinalizedToolCallEntry` | L702 | **并行模式的关键**:已定稿的结果 ∪ 还没跑的 thunk |

`ImmediateToolCallOutcome` 的四种来源要记熟:**工具不存在、参数校验失败、被 `beforeToolCall` 挡下(block)、准备期间被 abort**。它们都跳过 `execute`,也跳过 `afterToolCall`——所以后置 hook **看不到**这三类失败。

`L702`

```ts
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);
```

做成 thunk(`() => Promise<...>`)而不是直接起 `Promise`,是为了让准备阶段保持严格串行——真正的并发要等到 §6 的 `Promise.all` 那一行才发生。

`L714–716`

```ts
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

**批级早停判定:全票通过制。**

- `length > 0` 挡的是空批——`every` 对空数组恒为 `true`,不挡的话「没有工具可执行」会被误判成「工具要求收工」。
- 为什么要全票:模型经常在一条消息里既调 `exit_plan_mode`(想停)又调别的工具(还想干活),少数派不该替多数派叫停。测试 `should continue after parallel tool calls when not all tool results terminate` 钉住了这条。

---

### §6 三条工具执行路径(L718–969)

#### 分派器 `executeToolCalls`(L732–751)

`L743–750`

```ts
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
```

两条规则:

1. **批级传染** —— 只要批里有任何一个工具标了 `executionMode: "sequential"`,整批(包括同批的 read / bash)都退成串行;
2. **只能单向升级** —— 把工具标成 `"parallel"` 并不能把 `config.toolExecution === "sequential"` 拉成并行(那个 `||` 短路在前)。

这是探针类工具(gdb / log / flash)防止并发抢板子、文件类工具防止并发覆盖的**唯一手段**,所以刻意做成「保守方向说了算」。默认值是 `"parallel"`(`config.toolExecution` 为 `undefined` 时落到最后一行)。

`?.` 让「工具查不到」等价于「不算 sequential」——不存在的工具会在 `prepareToolCall` 里变成一条错误结果,不影响这里的模式选择。

#### length 失败路径 `failToolCallsFromTruncatedMessage`(L764–797)

`L770–796`

```ts
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
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
	return { messages, terminate: false };
```

- **照常发 `tool_execution_start`**:UI 的工具卡片形状不变,只是内容变成一条错误。少发这个事件的话前端会收到一个没有开头的 `tool_execution_end`。
- 错误文案是**写给模型看的**,三件事一次说清:没执行、为什么(触到输出上限)、怎么办(带完整参数重发)。改这段文案等于改模型的自愈行为。
- **`terminate` 固定 `false`** —— 保证 `hasMoreToolCalls` 变成 `true`,循环必然再跑一轮,让模型有机会重发。写成 `true` 会让整轮就此停死。
- 这个函数**不查工具是否存在、也不看 `signal`**:这一批注定全部失败,没有分支必要。

测试 `should not execute tool calls from a length-truncated assistant message` 钉住了「工具 execute 一次都没被调用」这个事实。

#### 串行 `executeToolCallsSequential`(L806–871)

`L819–867`

```ts
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", /* ... */ });

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = { toolCall, result: preparation.result, isError: preparation.isError };
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(/* ... */);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}
```

与并行版最容易被忽略的差别**不在速度,而在事件时序**:这里第 N+1 个工具的 `tool_execution_start` 要等第 N 个彻底结束之后才发,所以前端卡片是一张一张出现的;并行版则是一开始就把全批的 start 事件一次性发完。

三连收尾的顺序是协议:先 `tool_execution_end`(给 UI 更新卡片),再造 `ToolResultMessage` 并发 `message_start` / `message_end`(给 transcript 与落盘)。反过来会让前端先看到一条完整消息、再收到「工具刚结束」的通知。

`if (signal?.aborted) break` 放在**收尾之后**:当前这个工具的结果一定会被完整记下来。但剩下的调用一条结果消息都不造——见 §5 第 10 条。

#### 并行 `executeToolCallsParallel`(L885–969)

三段时序是这个函数的全部要点:

```
1) 准备阶段串行 await —— 校验与 beforeToolCall 逐个跑完,期间没有任何 execute 启动
2) 执行阶段并发       —— Promise.all 那一行同步调用全部 thunk,并发从这里开始
3) 收尾阶段按源序     —— 全部落定之后,按 assistant 消息里 toolCall 的原始顺序造消息
```

于是同一批工具存在**两条不同的顺序**,别混:

- **完成序** —— `tool_execution_end` 谁先跑完谁先出,UI 因此能第一时间画出已完成的卡片;
- **源序** —— `ToolResultMessage` 按 assistant 消息里 `toolCall` 块的原始顺序推进 transcript(不少 provider 对此有要求)。

测试 `should emit tool_execution_end in completion order but persist tool results in source order` 就是钉这一条的。

`L898–947`

```ts
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", /* ... */ });

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized: FinalizedToolCallOutcome = { toolCall, result: preparation.result, isError: preparation.isError };
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(/* ... */);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});

		if (signal?.aborted) {
			break;
		}
	}
```

准备阶段这个 `for` 里的每一步都是 `await`,所以全批的校验与 `beforeToolCall` 是**严格串行**的。带来一个重要性质:**某个 hook 决定 block 时,别的工具还没开跑。**

`immediate` 分支立刻定稿并发 `tool_execution_end` —— 于是「工具不存在 / 参数不合法 / 被 block」这类失败的**结束事件会早于任何真工具跑完**,前端要能接受这个顺序。

`L952–964`

```ts
	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);

	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
```

**并发真正开始的一行。** `map` 是同步的,所以全部 thunk 在这一刻被依次调用、各自跑到第一个 `await` 就让出;已经定稿的条目用 `Promise.resolve` 包一层混进来占位。`Promise.all` 保留输入顺序,所以结果数组天然回到源序。

收尾那段**刻意放在 `Promise.all` 之后**而不是塞进 thunk 里——塞进去就变成完成序了。

最后 `shouldTerminateToolBatch(orderedFinalizedCalls)` 的投票名单**包含 immediate 的失败结果**,而它们的 `terminate` 是 `undefined`,所以「批里有任何失败」就一定不会早停。这是全票制的自然推论。

---

### §7 单次工具调用的三段(L971–1176)

#### 一段:`prepareToolCall`(L980–1050)

`L988–1049`

```ts
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);

		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{ assistantMessage, toolCall, args: validatedArgs, context: currentContext },
				signal,
			);
			if (signal?.aborted) {
				return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}

		if (signal?.aborted) {
			return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
		}

		return { kind: "prepared", toolCall, tool, args: validatedArgs };
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
```

**这个函数永远不向外抛异常**,四种失败全部编码成 `immediate` 结果,所以调用方(串行 / 并行两条路径)不需要写 `try`。

- `prepareToolCallArguments` 是**校验之前唯一的入参整形钩子**。edit 工具用它把「edits 是一个 JSON 字符串」或者旧版单条 `oldText`/`newText` 的写法折算成标准数组。
- `validateToolArguments`(pi-ai)内部先 `structuredClone` 一份参数(所以返回的是**副本**,不是 `toolCall.arguments` 本体),再跑 `Value.Convert` 做 `"3"→3` 这类强转,最后用编译好的 typebox 校验器 `Check`。schema 不是 TypeBox 产物时还会额外跑一遍手写的 JSON Schema 递归强转兜底。失败时抛出带字段路径的详细错误,被上面的 `catch` 接住。
- **两处 `signal?.aborted` 检查都必须留着**:第一处覆盖「hook 是个耗时的异步操作(比如弹权限框),回来时用户已经点了停止」;第二处覆盖「没配 `beforeToolCall`,但校验期间用户按了停止」。删掉任何一处都会留下一个能把工具跑起来的窗口。
- `block` 的语义是「不执行,但要给模型一条说明」。`reason` 直接变成模型看到的文本,缺省文案是 `Tool execution was blocked`。

#### 二段:`executePreparedToolCall`(L1058–1117)

`L1065–1116`

```ts
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(emit({ type: "tool_execution_update", /* ... */ partialResult })),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result: createErrorToolResult(/* ... */), isError: true };
	} finally {
		acceptingUpdates = false;
	}
```

工具的契约是「**失败要 throw,不要把错误编进 content**」——这个函数负责把 throw 接住并翻成一条 `isError` 的结果,于是循环上层永远看不到工具异常。

`updateEvents` 这个数组存在的理由:`onUpdate` 是**同步回调**(签名返回 `void`),工具那边没法 await 它;所以先把 emit 的 Promise 收集起来,`execute` 回来之后统一 `await Promise.all`。不这么做就会出现「`tool_execution_end` 先于最后一条 `tool_execution_update` 到达订阅者」的乱序。

`acceptingUpdates` 把 `onUpdate` 的作用域限定在本次 `execute` 内。工具在 promise 落定之后再调它(常见于忘了清定时器的长驻工具)会被静默忽略,避免往已经结束的工具卡片上补事件。三处都置 `false`,`finally` 是兜底。

#### 三段:`finalizeExecutedToolCall`(L1125–1176)

`L1138–1175`

```ts
	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall({ /* ... */ result, isError, context }, signal);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return { toolCall: prepared.toolCall, result, isError };
```

合并语义是「**逐字段替换,不做深合并**」:给了就整个换掉,没给就保留原值。

两条要记住:

- `terminate` 用的也是 `??`,所以 hook **只能把 `undefined` 补成 `true`,不能把工具已经标好的 `true` 抹回 `false`**——想撤销早停请求在当前接口下做不到。测试 `should allow afterToolCall to mark a tool batch as terminating` 覆盖的是补的那个方向。
- hook 自己抛异常的代价很重:整条结果(哪怕工具本来跑成功了)被替换成错误结果。这是刻意的保守选择——hook 炸了说明后置处理没做完,把半成品交给模型更危险。

---

### §8 收尾小函数(L1178–1265)

`L1187–1201`

```ts
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return { ...toolCall, arguments: preparedArguments as Record<string, any> };
}
```

关键约定:**钩子返回同一个引用时,`toolCall` 原样返回、不重建对象。** 这让「就地改写参数」与「返回新对象」两种写法都能工作——`coding-agent` 的 `prepareEditArguments` 两条路径正好各用一种。

引用不同才浅拷一层换掉 `arguments`,原 `toolCall` 对象保持不动——它还挂在 assistant 消息的 `content` 里,改它就等于改历史。

`L1211–1216`

```ts
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}
```

**`details` 恒为空对象。** 所有内核侧产生的错误(工具不存在、校验失败、被 block、被中断、length 截断、`afterToolCall` 抛错)都长这样,前端别指望从 `details` 里读到结构化信息——唯一的信息载体是 `content` 里那句文本。另外它**不设 `isError`**,错误标记由调用方在 `FinalizedToolCallOutcome` 上单独带。

`L1222–1230`

```ts
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}
```

四个调用点决定了两条顺序:length 失败路径(L789)、串行路径(L853)与并行路径的 `immediate` 分支(L916)都在自己的收尾里调,而**并行路径的 thunk 在自己内部调**(L939)——`tool_execution_end` 的**完成序**就是从这最后一处来的。注意它发的是 `finalized.result` 本体而不是拷贝,`isError` 也是外挂的那一个,不是从 `result` 里读的。

`L1236–1253`

```ts
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}
```

`addedToolNames` 用**条件展开**而不是无脑写 `undefined`:后者会让这个键出现在 JSON 里、进到会话文件,也会让「这条消息有没有引入新工具」的判断从「有没有这个键」退化成「值是不是空」。

`L1262–1265`

```ts
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
```

为什么工具结果也要发 `message_start` / `message_end` 而不是只发 `tool_execution_end`:**harness 是在 `message_end` 上做 `session.appendMessage()` 的**,不发这一对,工具结果就永远不会落盘。两个事件之间没有 `message_update`——工具结果不是流式产物。

---

## 5. 会咬人的地方

1. **`agentLoop` / `agentLoopContinue` 里的 `void ... .then()` 没有 `.catch`**(L124–128、L162–166)。任何回调(`convertToLlm` / `prepareNextTurn` / 订阅者……)抛异常,结果是**一个未处理的 Promise rejection + 一个永远不 `end()` 的 EventStream**——消费方的 `for await` 与 `await stream.result()` 会静静挂死,没有任何报错。这就是 `types.ts` 里几乎每个回调都写着 must-not-throw 的原因。`Agent` 类和 `AgentHarness` 各自补了兜底,**裸 loop 没有**。

2. **`EventStream` 的两条静默行为**(见 `ai/src/utils/event-stream.ts:21-48`,由 L279–288 的参数化触发):`agent_end` 一被 push 进去,内部 `done` 即为真,**之后再 push 的事件全部被静默丢弃**;而 `end()` 不传 result 且从未推过终结事件时,`result()` 的 Promise **永久 pending(不是 reject)**。

3. **两个入口的所有权语义不对称**:`runAgentLoop`(L203–206)给 `currentContext` 换了新数组,`runAgentLoopContinue`(L261)用的是 `{...context}`——**messages 数组没有复制,循环会直接往调用方的数组里 push**。实践中安全,只是因为 harness 与 `Agent` 类在传进来之前都自己 `slice` 了一份。

4. **同一份 continue 校验存在两份逐字副本**,失败形态不同:`agentLoopContinue`(L149–158)是同步 throw,`runAgentLoopContinue`(L247–253)是 reject。改一处必须跟着改另一处。

5. **error / aborted 早退不拉任何队列**(L370–374)。排在 steering / follow-up 队列里的消息不会被这一轮消费掉——它们留到下一次 `prompt()`。

6. **`transformContext` 的返回值不写回 `context.messages`**(L521–523),只喂给本次请求。想让裁剪持久生效必须走 `prepareNextTurn`(L420–449)。这两个钩子长得像,作用范围完全不同。

7. **所有 delta 分支都罩在 `if (partialMessage)` 里**(L599)。某个 provider 的流若没发 `start` 就直接发 delta,**一条 `message_update` 都不会产生**——UI 表现为「一直转圈,最后一次性出全文」,而且没有任何错误。

8. **`message_start` / `message_update` 发的是浅拷贝,`message_end` 发的是本体**(L582、L608、L635、L653)。浅拷贝只冻住顶层字段,**`content` 数组仍然是同一个引用**——订阅者读到的内容块依然会随着流继续变。桌面端投影器「快照始终从 `partial.content` 重算」的做法正是这条性质逼出来的。

9. **兜底路径的 `await response.result()`(L644)有可能永远不返回**:流被 `end()` 结束却从没推过 `done` / `error` 时,`result()` 永久 pending(见第 2 条)。正常 provider 走不到这里,自制的假 streamFn 很容易踩。

10. **中途 abort 会留下悬空的工具批次**。串行版在 L864 `break`,并行版在 L920 / L944 `break`——都是「已处理的有结果、剩下的一条 `ToolResultMessage` 都不造」。于是 transcript 里会出现**有 `toolCall` 却没有对应 `toolResult`** 的 assistant 消息,而 `convertToLlm` 不做补齐。能不能重放这段历史取决于 provider 的宽容度(pi-ai 的 `transformMessages` 会给孤儿调用补一条合成结果,算第二道防线)。
    另外注意:并行版 `break` 之后,**已经入列的 thunk 仍然会被 `Promise.all` 跑掉**(它们拿到的是已 abort 的 signal,由工具自己识别),`break` 只是不再准备新的。

11. **`beforeToolCall` 拿到的 `args` 是校验后的对象本体,就地改它不会重新校验**(L1007 产出、L1013 传入)。测试 `should execute mutated beforeToolCall args without revalidation`(`agent-loop.test.ts:383`)专门钉住了这个行为:把字符串字段改成数字也照跑。**要挡就返回 `{block:true}`,不要靠改参数。**

12. **`createErrorToolResult` 的 `details` 恒为 `{}`**(L1214)。六种内核侧错误全部如此,前端读不到任何结构化信息。

13. **`afterToolCall` 的 `terminate` 用 `??` 合并**(L1161):hook 只能把 `undefined` 补成 `true`,**不能把工具已经标好的 `true` 抹回 `false`**。

14. **`afterToolCall` 抛异常会把成功的结果整个替换成错误结果**(L1168–1171),工具白跑了。

15. **`thinkingLevel === "off"` 会把 `reasoning` 整个摘掉**(L442–447)。对 reasoning 模型这等于「最强的那一档被默认关掉,且没有任何地方提示」——根 `CLAUDE.md` 记过实测代价:107 条 assistant 消息、reasoning token **0**。

16. 【与全景篇不符】**全景篇 §1 分层图给本文件标的行号锚点有三处对不上代码**(以注释前的原始文件核对):
    | 全景篇写的 | 原始文件实际 |
    |---|---|
    | `runLoop() :131` | `async function runLoop(` 在 **:148** |
    | `streamAssistantResponse() :266` | 在 **:271**(:266 是 `runLoop` 的收尾大括号) |
    | `executeToolCalls() :356` | 在 **:398**(:356 是 `streamAssistantResponse` 里的一次 `emit`) |

    只有 §5.3 接线表里的 `agent-loop.ts:700 prepareToolCallArguments` 是对的。全景篇 §7 阅读顺序里的四段划分(`1-130` / `131-265` / `266-355` / `356-744`)也是照这套偏移写的。**对照阅读时按符号名找,别按行号找**;本篇文档给的行号是加注释之后的真实行号。

17. 【与注释不符(易误读)】**文件头那段 `Step 1–5` 英文注释是上游按「教学顺序」演进写的,不是当前行为的描述**。它写着 `Step 2: sequential tool execution`,而当前的默认执行模式是 **parallel**(`types.ts` 的 `toolExecution` 注释:`Default: "parallel"`,代码落点是 L750 那条 fallthrough);串行只在配置或工具显式要求时才发生。别把这段当行为说明看。

18. 【与全景篇不符】**「`prepareNextTurn` 是自动压缩的落点」这句话要打个折**。全景篇 §1 分层图与 §4 第 38 步都这么写,harness 侧读起来也像;但按代码走一遍是:桌面端 `kernel/src/host/session-manager.ts:maybeAutoCompact` 在 `turn_end` / `settled` / `agent_end` 上 `void` 调 `harness.compact()`,而 `compact()` 第一行就是 `if (this.phase !== "idle") throw busy` ——**压缩不可能发生在一轮跑到一半的时候**。所以本文件的 `prepareNextTurn` 实际做的是「flush 挂起写入 + 用 `session.buildContext()` 重建快照」,它是新投影**回到循环**的入口,不是触发压缩的地方。真要在轮间压缩,得由调用方自己在 `prepareNextTurn` 里返回一个压好的 `context`——接口支持,本仓没人这么用。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `@earendil-works/pi-ai`(`types.ts` / `utils/event-stream.ts` / `utils/validation.ts`) | 只拿 5 个符号:`AssistantMessage`、`Context`、`ToolResultMessage`、`EventStream`、`validateToolArguments`。这就是 agent 包对 LLM 协议层的全部依赖 |
| 它 import | `packages/agent/src/types.ts` | 全部契约(`AgentContext` / `AgentMessage` / `AgentTool` / `AgentEvent` / `AgentLoopConfig` / `StreamFn`),零实现纯类型 |
| 它调用(经 config) | `packages/agent/src/harness/messages.ts` | `convertToLlm` 的实现;唯一的 LLM 边界 |
| 它调用(经 streamFn) | `packages/ai/src/models.ts` `Models.streamSimple` | harness 的 `createStreamFn` 把三个 provider 钩子包进去后传进来 |
| 它调用(经 AgentTool) | `packages/coding-agent/src/core/tools/*.ts` | 只认 `execute(id, args, signal, onUpdate)` 这个回调,不知道 read / bash / gdb 是什么 |
| import 它 | `packages/agent/src/harness/agent-harness.ts` | **本仓唯一的生产调用方**:`executeTurn`(:941)→ `runAgentLoop`,`retryLastTurn`(:1167)→ `runAgentLoopContinue` |
| import 它 | `packages/agent/src/agent.ts` | `Agent` 类,裸 loop 的有状态包装;**本仓无生产调用方**,是参考实现与单测对象 |
| import 它 | `packages/agent/src/index.ts` | 包主入口 `export * from "./agent-loop.ts"`,宿主拿到 `runAgentLoop` 的正门 |
| import 它 | `packages/agent/test/agent-loop.test.ts` | 20 个用例,逐条钉住本文 §5 的每个边界条件;用的是返回流的 `agentLoop` / `agentLoopContinue` |
| 靠它的语义 | `packages/kernel/src/host/compaction.ts` + `session-manager.ts:maybeAutoCompact` | 阈值判定是纯函数,真正压缩是轮末在循环**外面**调 `harness.compact()`;`prepareNextTurn` 只是新投影回到循环的入口。内核只给 `compact()` 机制,什么时候压是应用层的事 |
| 靠它的语义 | `packages/kernel/src/host/retry.ts` | 依赖「provider 失败是一条 `stopReason:"error"` 的消息」这条 errors-as-data 契约 |

---

## 7. 自测题

**Q1.** 把 `runAgentLoopContinue` 的 `const currentContext: AgentContext = { ...context };`(L261)改成 `{ ...context, messages: [...context.messages] }`,现有的两个调用方(`AgentHarness.retryLastTurn` 与 `Agent.continue()`)行为会变吗?为什么?

<details><summary>答案</summary>

**不会变。** 因为两个调用方在传进来之前都自己 `slice()` 了一份消息数组(`Agent.createContextSnapshot()` 用 `this._state.messages.slice()`,harness 也是先造快照再传),所以循环往里 push 的本来就已经是一份副本。

改了之后**语义反而更安全**:它把「所有权不对称」这条坑抹平,让两个入口一致。真正会受影响的是那些直接把自己长期持有的数组传进来的调用方——现在他们的数组会被循环偷偷追加内容,改了之后就不会了。

顺带一提,这也说明这条坑目前是「潜在的」而不是「正在发生的」:改与不改都跑得通,但不改就得靠调用方的纪律。
</details>

**Q2.** 如果把 L420 的 `prepareNextTurn` 与 L454 的 `shouldStopAfterTurn` 调用次序对调,破坏的是什么契约?本仓现在会立刻出问题吗?

<details><summary>答案</summary>

`shouldStopAfterTurn` 会拿到**压缩之前**的那份 `currentContext`。

`shouldStopAfterTurn` 的典型用途是「上下文快满了,优雅收工」——它要看的是**新 context 有多大**。对调之后,刚被 `prepareNextTurn` 换小的上下文仍然会被按替换前的尺寸判定,于是循环在明明还能继续的情况下停下来;反过来,如果 `prepareNextTurn` 换上的是一个更大的 context(比如注入了外部资料),该停的时候反而不停。

**本仓现在不会立刻出问题。** `shouldStopAfterTurn` 在生产代码里**一个调用方都没有**(全仓 grep 只命中 `agent-loop.test.ts:1043`),harness 的 `createLoopConfig` 压根不填它。所以这个次序目前只是留给外部调用方的契约,而不是桌面端自动压缩的实现——后者是宿主在轮末事件里调 `harness.compact()`(它要求 `phase === "idle"`,所以实际落在两次 run 之间)。

更隐蔽的一点:`prepareNextTurn` 里 harness 会 `flushPendingSessionWrites()` 并重建 turn 快照。对调之后,`shouldStopAfterTurn` 返回 true 直接 `return` 的那条路径就**永远不会跑到 `prepareNextTurn`**,本轮的挂起写入会一直留在队列里,只能靠 `runLoopToCompletion` 的 `finally` 兜底。
</details>

**Q3.** 一批工具里,`gdb` 标了 `executionMode: "sequential"`,`read` 标了 `"parallel"`,`config.toolExecution` 没配。这一批怎么跑?如果 `config.toolExecution` 配成 `"sequential"` 而三个工具全标 `"parallel"` 呢?

<details><summary>答案</summary>

**第一种:整批串行。** `hasSequentialToolCall` 为 true(L743 的 `some` 命中 gdb),`||` 短路直接进 `executeToolCallsSequential`。`read` 标的 `"parallel"` 不起任何作用——**执行模式是批级的,而且只能单向升级到保守方向**。

**第二种:仍然整批串行。** `config.toolExecution === "sequential"` 是 `||` 的左操作数,直接命中,后面的工具标记根本不参与判断。

一句话:**`"parallel"` 这个标记永远只能表达「我不反对并行」,不能表达「我要求并行」。** 这是为了让探针类工具(gdb / log / flash)不可能因为同批里混进一个 read 就被拖进并发——两个进程同时抢一块板子的代价是 `0xe00002c5`,而错误长得和「没插板子」一模一样。
</details>

**Q4.** 把 `failToolCallsFromTruncatedMessage` 结尾的 `return { messages, terminate: false }`(L796)改成 `terminate: true`,用户会看到什么现象?

<details><summary>答案</summary>

**模型的回答会在被截断的地方永久停住,而且看起来像「它自己决定不干了」。**

链路是这样的:`terminate: true` → `hasMoreToolCalls = !batch.terminate` 变成 `false`(L399)→ 内层 while 条件不成立 → 掉出内层 → follow-up 队列空 → `break` → `agent_end`。

于是那条「本次未执行:响应触到输出 token 上限,请带完整参数重发」的错误结果**进了 transcript 却没有下一次请求**——模型根本没机会看到它、更没机会重发。用户看到的是一段说到一半的回答加一张红色工具卡片,然后一切静止。

`terminate: false` 保证循环必然再跑一轮,把那句话喂给模型,让它自己重发完整的工具调用。这是整个 length 分叉能自愈的唯一原因。
</details>

**Q5.** 把 `executeToolCallsParallel` 里 `createToolResultMessage` + `emitToolResultMessage` 那两句(L961–962)搬进 L928 的 thunk 内部,会破坏什么?

<details><summary>答案</summary>

**会把 `ToolResultMessage` 的顺序从源序变成完成序。**

现在的写法里,thunk 只负责 `execute` + `finalize` + 发 `tool_execution_end`(完成序),消息构造统一在 `Promise.all` 之后按数组顺序做——而 `Promise.all` 保留输入顺序,输入顺序就是 assistant 消息里 `toolCall` 块的原始顺序。

搬进 thunk 之后,谁先跑完谁先造消息、先 push 进 `messages`,于是回灌进 transcript 的 `toolResult` 顺序变成了「按耗时排序」。后果有两层:

1. **provider 层面**:不少厂商要求 `toolResult` 与前一条 assistant 消息里的 `toolCall` 一一对应且同序,乱序会被拒收或者被静默错配。
2. **回放层面**:会话文件里存的顺序也跟着乱,以后重开这个会话、把历史发回给模型时会一直带着这个错误。

而且这个 bug **在只有一个工具或者所有工具耗时接近时完全不会显形**——`agent-loop.test.ts` 里那条 `should emit tool_execution_end in completion order but persist tool results in source order` 专门用「故意让后面的工具先返回」的假工具来钉它。
</details>
