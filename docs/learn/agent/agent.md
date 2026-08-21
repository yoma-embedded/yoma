# packages/agent/src/agent.ts

> **档位** B(分段) · **行数** 669(加注释前 520)
> **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §2.2、§7 · **索引** [README](../README.md)

## 1. 一句话

`Agent` 类是裸循环(`agent-loop.ts` 的 `runAgentLoop` / `runAgentLoopContinue`)的**有状态包装**——把「一次调用返回一批消息」的纯函数,包成一个可以订阅事件、可以排队插话/跟进消息、可以随时查询当前状态的长期对象;但**本仓生产代码不走这里**,它是一份参考实现。

## 2. 它在全景里的位置

先说清一个反直觉的事实(全景篇 §2.2 原话):**这个文件里的 `Agent` 类在本仓库没有生产调用方。** 桌面端内核 host(`packages/kernel/src/host/session-manager.ts`)和 ACP 适配器(`coding-agent/src/acp/agent.ts`)都直接用 `agent/src/harness/agent-harness.ts` 里的 `AgentHarness`,而 `AgentHarness` 内部直接调 `runAgentLoop`,并不经过 `Agent` 类。所以在全景篇 §4「一次完整请求的生命周期」那条 48 步编号时间线上,你找不到任何一步落在这个文件里。

那它为什么还在仓库里、为什么值得读?因为 `AgentHarness`(1756 行)做的每一件「状态管理」的事——单飞行守卫(同一时间只能有一次 prompt 在跑)、把裸循环的事件流折算回一份可查询的 state、插话/跟进队列、abort 后如何收尾——在这个 520 行的文件里都有一个**更小、更直白**的原型。读 harness 之前先读这里,或者读 harness 卡壳时回头对照这里,都能显著降低理解成本:两者在"要解决的问题"上完全同构,只是 harness 还要多管会话树落盘、压缩、hook 分发这些这个文件完全不碰的东西。

具体到调用关系:`agent.ts` 只 import 同目录的 `agent-loop.ts`(两个入口函数)和 `types.ts`(几乎全部契约类型),不 import harness 目录下任何东西,也不碰 `node:*`——这也是它能待在包的浏览器安全主入口(`index.ts`)里被 `export *` 出去的原因。它自己也没有任何东西被 harness 反过来 import;两条实现路径完全并行、互不依赖,唯一的共同祖先是它们都调用 `runAgentLoop`。

`Agent` 类目前的实际用途是测试的被测对象:`agent/test/agent.test.ts`(19 处 `new Agent(...)`)与 `agent/test/e2e.test.ts`(10 处)都在实例化它,验证裸循环在"被有状态地包起来"之后,插话、跟进、中断、失败这些场景的行为是否符合预期——某种意义上,这个文件本身就是 `agent-loop.ts` 契约的一份可执行文档。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–95 | 文件头两段注释、类型 import、`export type { QueueMode }` 转发导出、`noStreamFnConfigured` 占位符、`defaultConvertToLlm`、`EMPTY_USAGE`、`DEFAULT_MODEL` |
| §2 | L96–142 | `MutableAgentState` 类型 + `createMutableAgentState()`:tools/messages 的「赋值即拷贝」访问器 |
| §3 | L143–187 | `PendingMessageQueue` 类:steer/followUp 共用的队列实现,`drain()` 按 mode 二选一 |
| §4 | L188–225 | `AgentOptions` 接口(构造选项契约)+ `ActiveRun` 类型(单飞行运行态载体) |
| §5 | L226–360 | `Agent` 类:构造函数、`subscribe`、只读访问器(`state`/`signal`)、队列操作(`steer`/`followUp`/`clear*`/`hasQueuedMessages`)、`abort`/`waitForIdle`/`reset` |
| §6 | L361–534 | `prompt()` / `continue()` 两条外部入口,及其私有转发路径:`normalizePromptInput`、`runPromptMessages`、`runContinuation`、`createContextSnapshot`、`createLoopConfig` |
| §7 | L535–607 | 运行时生命周期:`runWithLifecycle`(单飞行守卫 + try/catch/finally)、`handleRunFailure`(失败兜底)、`finishRun`(收尾) |
| §8 | L608–669 | `processEvents()`:裸循环事件 → state 回灌,再转发给全部订阅者 |

## 4. 逐节讲解

### §1 模块级辅助(L1–95)

```ts
const noStreamFnConfigured: StreamFn = () => {
	throw new Error(
		"no streamFn configured. Pass streamFn, e.g. (model, ctx, opts) => models.streamSimple(model, ctx, opts).",
	);
};
```

`streamFn` 是真正发起 LLM 请求的钩子,构造 `Agent` 时不强制传(方便先搭骨架)。不传时不是静默什么都不做,而是**第一次真正尝试调用时**才炸出这条指名道姓的报错——比 `undefined is not a function` 好定位得多。

```ts
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}
```

`convertToLlm` 的默认实现:`AgentMessage` 是 pi-ai 的 `Message` 联合再加上应用层可能通过 `CustomAgentMessages` 声明合并塞进来的自定义角色(全景篇 §3 提过这个类型)。默认实现只保留 LLM 认得的三种角色,把自定义消息整个过滤掉。调用方可以整个换掉这个函数(`AgentOptions.convertToLlm`)。

```ts
const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	...
} satisfies Model<any>;
```

不传 `initialState.model` 时的占位 `Model`。好处是类型系统上 `AgentState.model` 不需要是可选字段,同时把「还没选模型」变成一个显式可辨认的值(`id/name/provider` 全是 `"unknown"`),而不是 `undefined` 到处判空。

### §2 MutableAgentState(L96–142)

```ts
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};
```

`AgentState`(定义在 `types.ts`)对外是只读快照——`isStreaming`/`streamingMessage`/`errorMessage` 标了 `readonly`,`pendingToolCalls` 只承诺 `ReadonlySet`。`Agent` 内部要能写,于是 `Omit` 掉这四个字段再重新声明成可写版本,`pendingToolCalls` 额外收紧成具体的 `Set`(§8 的 `processEvents` 要调用 `.add()`/`.delete()`)。

```ts
function createMutableAgentState(initialState?: ...): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		...
		get tools() { return tools; },
		set tools(nextTools) { tools = nextTools.slice(); },
		get messages() { return messages; },
		set messages(nextMessages) { messages = nextMessages.slice(); },
		...
	};
}
```

`tools`/`messages` 用闭包变量 + getter/setter 实现「赋值即拷贝」。`AgentState` 接口文档写明「assigning a new array copies the top-level array」——这就是这条契约的落地:调用方把自己手上的数组赋给 `state.tools = myTools` 之后,再改 `myTools` 不会悄悄改到 `Agent` 内部持有的那份,反过来也一样(读出来的也是当时那份的引用,不会因外部后续修改而变)。这是一种浅拷贝防御,不是深拷贝——数组内的对象元素仍然共享。

### §3 PendingMessageQueue(L143–187)

`Agent` 有两条独立队列:`steeringQueue`(插话,运行期间生效)和 `followUpQueue`(跟进,agent 本要停下时才生效),都用这一个类实现,区别只在构造时传入的 `mode: QueueMode`(`"all" | "one-at-a-time"`,定义在 `types.ts`)。

```ts
drain(): AgentMessage[] {
	if (this.mode === "all") {
		const drained = this.messages.slice();
		this.messages = [];
		return drained;
	}

	const first = this.messages[0];
	if (!first) { return []; }
	this.messages = this.messages.slice(1);
	return [first];
}
```

`"all"` 一次性倒空整个队列;`"one-at-a-time"` 每次只吐最老的一条,其余留到下一次 drain 点。两种模式返回值形状都是数组(哪怕只有一条),是为了让调用方(§6 的 `createLoopConfig`)不用为两种模式分别处理返回值类型。

"one-at-a-time" 存在的产品理由:插话如果一次性全灌进上下文,模型很可能在同一轮响应里把后面几条消息也当成当前这条的补充一并处理掉,而不是像用户期望的那样——每条消息各自触发一轮独立的回应。

### §4 AgentOptions / ActiveRun(L188–225)

`AgentOptions` 是构造 `Agent` 时的全部可选项,多数字段(`convertToLlm`/`transformContext`/`streamFn`/`getApiKey`/`beforeToolCall`/`afterToolCall`/`prepareNextTurn*`/`toolExecution`)直接对应 `types.ts` 里 `AgentLoopConfig` 的同名字段——这些字段的行为契约在 `types.ts` 里已经写得很详细(每个都有「不能抛异常,失败要返回安全默认值」这条通用约束),`agent.ts` 只是原样透传,不重复定义语义。`steeringMode`/`followUpMode` 是本文件独有的两个选项,决定两条 `PendingMessageQueue` 各自的 drain 策略,默认都是 `"one-at-a-time"`。

```ts
type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};
```

单飞行守卫的载体。`Agent` 是否「正在跑」这件事,不是一个独立的 boolean 标志,而是直接看 `this.activeRun` 是否为 `undefined`——存在即忙碌。`promise` 给 `waitForIdle()` 用,`resolve` 在运行结束(§7 的 `finishRun`)时被调用来唤醒等待方。每次运行都会造一个全新的 `AbortController`,不复用上一次的。

### §5 Agent 类:构造、订阅、只读访问器、队列操作(L226–360)

构造函数(L266–280)只做装配,不发起任何调用:每个可选钩子落一个默认值或原样保留 `undefined`。值得记住的两个默认值:`toolExecution` 默认 `"parallel"`(全景篇 §2.2 提到这是裸循环的默认执行模式;`agent-loop.ts` 本身对 `"sequential"` 和长度失败三条路径都支持,只是不是这里的默认);`steeringMode`/`followUpMode` 默认都是 `"one-at-a-time"`。

`subscribe(listener)` 是外部拿到事件流的唯一方式,返回一个取消订阅函数。`state` getter 直接返回内部的 `MutableAgentState`(结构上兼容公开的 `AgentState` 接口,因为它是那个类型加了可写字段的超集)——**注意这不是一份快照拷贝**,是内部对象的直接引用,调用方拿到的 `state.tools`/`state.messages` 读到的永远是最新值。

队列相关的一组方法(`steer`/`followUp`/`clearSteeringQueue`/`clearFollowUpQueue`/`clearAllQueues`/`hasQueuedMessages`)都是对 §3 两个队列实例的薄封装,自身不含状态判断逻辑。`abort()` 只是调用 `this.activeRun?.abortController.abort()`——它只是发出中断请求,并不等待中断真正生效;想知道中断何时收尾,要 `await waitForIdle()`(这与仓库根 `CLAUDE.md` 记录的 harness 行为「`abort()` 之后必须 `await abort(); await waitForIdle()`」是同一条设计,`Agent` 类是它的简化原型)。`waitForIdle()` 在没有 `activeRun` 时直接返回一个已 resolve 的 `Promise`,让调用方不用先判断"是不是在跑"就能无条件 `await`。`reset()` 清空全部状态与队列,但**不检查是否正在运行**——在运行期间调用会和 `processEvents`(§8)的写入互相踩踏,调用方要自己保证只在空闲期调用。

### §6 prompt() / continue():两条外部入口(L361–534)

`prompt()` 有三个重载(纯字符串+可选图片、单条 `AgentMessage`、一批 `AgentMessage[]`),内部先做**同步**的单飞行检查:

```ts
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
	if (this.activeRun) {
		throw new Error(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);
	}
	const messages = this.normalizePromptInput(input, images);
	await this.runPromptMessages(messages);
}
```

已有 `activeRun` 时**同步抛错，不排队**——这与仓库 `CLAUDE.md`「harness 的三个行为」第一条完全同构:一个 `Agent` = 一次在飞轮次，`phase` 非空闲时 `prompt()` 同步抛而不是排队。想在运行期间追加消息，要用 `steer()`/`followUp()`。

`normalizePromptInput` 把三种输入形态统一成 `AgentMessage[]`：字符串输入会现造一条 `user` 消息，`content` 数组先放文本块，再在有图片时追加图片块（文本在前、图片在后是这里的既定顺序，不是模型强制要求）。

`continue()` 用来在最后一条消息不是 `assistant` 时把当前上下文原样再喂一次模型（`runContinuation` → `runAgentLoopContinue`，不追加任何新 prompt）。如果最后一条是 `assistant`，则依次尝试 drain 插话队列、再 drain 跟进队列，都为空才抛「不能从 assistant 消息继续」。drain 出插话队列后调用 `runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true })`——这个标志防止 `createLoopConfig` 里的 `getSteeringMessages` 在循环开局又 drain 一次，导致同一批消息被处理两遍（原作者已经在这行代码上方留了注释：「Already drained — skip the loop's first steering poll so we don't double-drain」）。

`createContextSnapshot()` 和 `createLoopConfig()` 是两条入口共用的装配步骤：前者把 `_state` 的 `systemPrompt`/`messages`/`tools` 现拷贝一份（`.slice()`），因为 loop 跑在这份快照上，而 `_state.messages` 在运行期间还会被 `processEvents`（§8）持续追加——两者必须是不同数组，否则边跑边改会互相踩；后者把 `Agent` 实例上的各个钩子字段组装成 `AgentLoopConfig`，其中 `reasoning` 字段的落定规则值得记住：`thinkingLevel === "off"` 时传 `undefined` 而不是字符串 `"off"`——与仓库 `CLAUDE.md` 记录的 harness 同一条规则（`"off"` 会把 `reasoning` 整个从请求里摘掉）。`prepareNextTurnWithContext` 与 legacy 的 `prepareNextTurn` 二选一时，**前者优先**：两者都配置了，只有 `prepareNextTurnWithContext` 会被真正调用。

### §7 运行时生命周期(L535–607)

`runWithLifecycle` 是 `runPromptMessages`/`runContinuation` 的共同收口，做三件事：再查一次单飞行（双重保险，§6 的 `prompt()` 已经查过一次，这里是给两条内部路径共用的第二道闸门）；建 `AbortController` 与可等待的 `promise`，写进 `this.activeRun`；跑传入的 `executor`，`catch` 到异常时转交 `handleRunFailure`，`finally` 里无条件调用 `finishRun`。

```ts
this._state.isStreaming = true;
this._state.streamingMessage = undefined;
this._state.errorMessage = undefined;
```

这三行(L556–558)在 `try` 之前执行——注意 `errorMessage` 在**每次新运行开始时**就被清空，不是只在成功结束时清。这意味着如果上一轮失败留下了 `errorMessage`，下一次 `prompt()`/`continue()` 一开始就会把它冲掉，哪怕这一轮还没真正跑出结果。

`handleRunFailure(error, aborted)` 合成一条 `stopReason` 为 `"error"` 或 `"aborted"` 的空 `assistant` 消息，依次补发 `message_start`/`message_end`/`turn_end`/`agent_end` 四个事件——让订阅者看到的事件序列形状和"正常跑完一轮"一致，不用为"抛异常"这条路单独写处理逻辑。`aborted` 由 `signal.aborted` 判定，不是靠 `error` 的类型分辨；这与仓库 `CLAUDE.md`「harness 的三个行为」第 3 条的原则一致：`prompt()` 在 abort 后是 resolve 而不是 reject，中断在内核里是**数据**，不是异常分类的依据。

`finishRun()` 复位 `isStreaming`/`streamingMessage`/`pendingToolCalls`，然后 `resolve()` 掉 `activeRun.promise`（唤醒 `waitForIdle()` 的等待方），最后才把 `this.activeRun` 置 `undefined`——顺序很关键：`resolve` 必须在清空引用之前调用，否则拿不到那个闭包里的 `resolve` 函数了。

### §8 processEvents(L608–669)

裸循环发出的每个 `AgentEvent` 都先经过这里，再转发给全部订阅者。函数体是一个 `switch`，按事件类型把 `_state` 更新到位，然后无条件遍历 `listeners` 并 `await` 每一个：

```ts
const signal = this.activeRun?.abortController.signal;
if (!signal) {
	throw new Error("Agent listener invoked outside active run");
}
for (const listener of this.listeners) {
	await listener(event, signal);
}
```

这个 `!signal` 检查理论上不会触发——`processEvents` 只在 `runWithLifecycle` 建好 `activeRun` 之后才会被当作 emit 回调传给 `runAgentLoop`，属于防御性的最后一道断言。`tool_execution_start`/`tool_execution_end` 两个分支每次都新建一个 `Set` 而不是原地 `add`/`delete`，与 §2 tools/messages 的拷贝语义一致，防止外部存下的旧引用被后续变更悄悄改掉。`turn_end` 分支只在 `event.message.errorMessage` 存在时写 `_state.errorMessage`，本身**从不清空**它——清空动作只发生在 §7 `runWithLifecycle` 每次新运行开始时。

## 5. 会咬人的地方

- **【失败兜底路径没有二次兜底】** L576–591(`handleRunFailure`)在 `runWithLifecycle` 的 `catch` 分支里被直接 `await` 调用，自身没有再包一层 `try/catch`。它内部会调用 4 次 `processEvents`，而 `processEvents` 会遍历并 `await` 全部订阅者的 listener——如果某个 listener 在这个失败兜底路径里再次抛出异常，这个异常不会被吞掉，会一路从 `runWithLifecycle` 抛出到 `prompt()`/`continue()` 的调用方（`finally` 里的 `finishRun()` 仍会按 JS 语义执行,但异常本身不受影响地传播）。这与 `AgentOptions` 里各个钩子"必须不抛异常"的约定形成反差:**这一条路径上,监听者抛出异常是没有安全网的。**
- **文件头注释是历史遗留,不必深究字面意思。** L1–5 的原作者注释写着「Agent (step 1–5)」「Step 4: …」「Step 5: …」,看起来像是按某种增量开发步骤编号的开发笔记,与当前代码结构没有直接对应关系(不存在标着 "step 1/2/3" 的代码段)。读者不必去找对应的 step 1-3 在哪。
- **这里没有 harness 的三大侧枝。** `AgentHarness` 提供的 `compact()`、`retryLastTurn()`、`navigateTree()`(自动压缩、轮级重试、会话树导航)在这个文件里完全不存在——`Agent` 只管"一次运行"的生命周期,不管长期会话的历史管理。想找压缩/重试相关代码,不要往这个文件里找。
- **`errorMessage` 的生命周期容易搞混。** L558(`runWithLifecycle` 开头)在每次新运行**开始时**清空它,而不是运行**结束**时才清。如果你想在 UI 上"运行中也能看见上一轮的错误提示",这个字段做不到——它在下一轮刚起步、结果还完全未知的时候就已经被冲掉了。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `agent/src/agent-loop.ts` | 唯二两个函数:`runAgentLoop`(`prompt()` 路径用)、`runAgentLoopContinue`(`continue()` 路径用) |
| 它 import | `agent/src/types.ts` | 几乎全部类型契约:`AgentContext`/`AgentEvent`/`AgentLoopConfig`/`AgentMessage`/`AgentState`/`AgentTool`/`StreamFn`/`ToolExecutionMode`/`QueueMode` 等 |
| import 它 | `agent/src/index.ts` | 包主入口用 `export *` 把它转发出去(浏览器安全) |
| import 它 | `agent/test/agent.test.ts`、`agent/test/e2e.test.ts` | 两个测试文件的被测对象(分别 19 处、10 处 `new Agent(...)`) |
| 同构对照 | `agent/src/harness/agent-harness.ts`(1756 行) | 生产实际使用的有状态包装,规模大得多,是这个文件的"完全体":多了会话树落盘、压缩、8 类可生效的 hook 分发(另有 11 类事件类型只经 `emitOwn`,永远触发不到订阅者,见仓库 `CLAUDE.md`「内核事件只能用 subscribe()」一节) |

## 7. 自测题

1. 如果调用方在 `prompt()` 还没跑完时又调用一次 `followUp(msg)`,`msg` 什么时候会真正被送进对话?

<details><summary>答案</summary>

不会立刻生效。`followUp` 只是把消息 `enqueue` 进 `followUpQueue`,不会打断当前正在跑的这一轮。要等 agent-loop 判断"没有更多工具调用要执行、也没有插话消息可 drain"、agent 本来要停下的那一刻,才会调用 `getFollowUpMessages()` 把它 drain 出来追加进对话、触发新的一轮。如果当前这轮里模型持续在调用工具、迟迟不停下来,`followUp` 排的消息可能要等很久。

</details>

2. 如果 `steeringMode` 设为 `"all"`(而不是默认的 `"one-at-a-time"`),在一次 `prompt()` 期间连续 `steer()` 三条消息,行为上有什么区别?

<details><summary>答案</summary>

`"one-at-a-time"` 时,loop 每到达一次 drain 点只会吐出最早排队的那一条,另外两条留到下一次工具批次结束后再被问一次(意味着可能要经过三轮独立的 drain 点才能全部注入,分别触发独立的回合)。`"all"` 时第一次 drain 点就会把三条一次性全部注入到上下文,模型很可能在同一轮响应里把三条一起当成一个整体来处理,而不是像用户期望的那样按各自独立的意图分别响应。

</details>

3. 同时给 `AgentOptions` 传了 `prepareNextTurn` 和 `prepareNextTurnWithContext`,哪个会被真正调用?

<details><summary>答案</summary>

`prepareNextTurnWithContext` 生效,`prepareNextTurn` 被完全忽略。`createLoopConfig()` 里的判断顺序是 `if (this.prepareNextTurnWithContext) { return await this.prepareNextTurnWithContext(...) } return await this.prepareNextTurn?.(...)`——前者只要存在就优先,后者只在前者不存在时才会被走到。

</details>

4. `waitForIdle()` 在 `Agent` 完全空闲(从未调用过 `prompt()`)时会发生什么?

<details><summary>答案</summary>

立刻返回一个已经 resolve 的 `Promise`(`Promise.resolve()`),不会挂起也不会抛错。这是为了让调用方可以无条件 `await agent.waitForIdle()`,不用先判断"现在是不是在跑"——不管当前是空闲还是忙碌,这一行代码永远合法且很快 settle。

</details>

5. 假设一轮 `prompt()` 因为网络错误在 `executor` 里抛出了异常,`handleRunFailure` 把这条错误转成事件广播给订阅者时,如果某个订阅者的 listener 自己也抛出了异常,最终会发生什么?

<details><summary>答案</summary>

这个异常不会被吞掉。`handleRunFailure` 自身没有 `try/catch` 包裹对 `processEvents` 的调用,而 `processEvents` 会 `await` 每一个订阅的 listener;listener 抛出的异常会一路从 `handleRunFailure` 传播到 `runWithLifecycle` 的 `catch` 分支,再从那里继续往外抛(`finally` 里的 `finishRun()` 仍会按 JS 的 try/finally 语义执行,但不会挡住异常继续传播),最终从 `prompt()`/`continue()` 的调用方看,原本预期"不会 reject"的这次调用会真的 reject。这是 §5 提到的"没有二次兜底"的具体后果。

</details>
