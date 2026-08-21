# packages/agent/src/harness/agent-harness.ts

> **档位** A(逐行) · **行数** 1757(加注释前 1155) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §1 ② ⑧ ⑫ · §2.2 · §3「第三组:会话外壳与会话树」 · §4 阶段 1 与阶段 6 · §6.1 · **索引** [README](../README.md)

## 1. 一句话

这是 **会话外壳(harness)**:它把 `agent-loop.ts` 那个无状态的双层 `while` 包成一个可长期持有的会话对象,负责相位守卫、turn 快照冻结、事件先落盘再转发、以及轮内会话写入的排队落盘 —— 但它自己**一行循环都没有**。

---

## 2. 它在全景里的位置

先钉住四个术语,全篇都在用:

- **harness(外壳)** —— 就是这个文件里的 `AgentHarness` 类。「一个 harness = 一个 session = 一个在飞的轮次」。
- **turn(轮)** —— 一条 assistant 消息 + 它点名的那批工具调用及其结果。一次 `prompt()` 可能跑很多个 turn。
- **phase(相位)** —— harness 的状态字段,取值 `idle | turn | compaction | branch_summary | retry`。它不是锁:忙的时候确定性抛错,不排队。
- **compaction(上下文压缩)** —— 历史太长塞不进模型窗口时,把旧的一段换成一条摘要条目。harness 只提供 `compact()` 这个机制,什么时候压是宿主的决定。

这个文件在链路上处在**第二跳**,对应全景篇 §1 分层图的 ②,以及回程的 ⑧ 和 ⑫:

```
① 用户输入(桌面端输入框 / Zed / bench 信箱)
   → ② 本文件:相位守卫 + 冻结 turn 快照 + 装配六个回调  ←── 你在这里
      → ③ session.buildContext() 读会话树(投影)
      → ④ agent-loop.ts 的双层 while(整套代码里唯一的状态机)
         → ⑤ convertToLlm → ⑥ pi-ai 注册表 → ⑦ 厂商协议 HTTP
      → ⑧ 事件回程:本文件的 handleAgentEvent 先 appendMessage 落盘、再转发订阅者
      → ⑨⑩⑪ 工具执行与结果回灌(全在 agent-loop 与 coding-agent 里)
   → ⑫ 落盘与善后:flushPendingSessionWrites / compact / navigateTree
```

对应全景篇 §4 的编号步骤:**第 1–3 步**是 `prompt()`(:1078)的同步相位守卫与 `createTurnState()`(:569)冻结快照;**第 4–5 步**是 `executeTurn()`(:941)组装首批消息并跑 `before_agent_start` hook;**第 6–8 步**是 `runLoopToCompletion()`(:991)装 AbortController、`createLoopConfig()`(:718)接六个回调、`createStreamFn()`(:645)包三个 provider 钩子;**第 9 步**进 loop;**第 26 步**是 `handleAgentEvent`(:865)的 `message_end` 分支;**第 37–38 步**是 `turn_end` 的三步契约与 `prepareNextTurn`;**第 42–43 步**是 `agent_end` 与 `runLoopToCompletion` 的收尾;**第 47 步**落在 `compact()`(:1291)。

**谁调它:** 生产路径上有两个宿主,各 `new AgentHarness({...})` 一次 —— 桌面端内核 host(`packages/kernel/src/host/session-manager.ts:530`)与 ACP 适配器(`packages/coding-agent/src/acp/agent.ts:435`)。两边都用 `subscribe()` 挂投影器/事件转发,不用 `on()` 收状态事件(理由见 §5 第 1 条)。测试在 `packages/agent/test/harness/agent-harness.test.ts`(23 例)与 `agent-harness-stream.test.ts`(4 例)。

**它调谁:** 往下四条腿 —— `agent-loop.ts` 的两个入口(各一次调用点)、`session/session.ts` 的十来个 `append*` 与 `buildContext`、`compaction/` 的两条侧枝、以及 `models.streamSimple`(经 `createStreamFn`)。它**不认识任何一个具体工具**,只认 `AgentTool` 这个接口。

**不存在会怎样:** 裸 loop 仍然能跑一轮,但会话历史没人写、相位没人守(同时两次 `prompt()` 会让两个 loop 抢同一份上下文)、hook 没有挂载点、订阅者收不到事件。桌面端与 ACP 会退化成「跑完打印一坨消息数组」。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–L54 | 上游原有的 M7/M8 施工记录(L1–L11)+ 新增的总述块与分节索引(L12–L53) |
| §1 | L55–L94 | 依赖导入(全是类型与纯函数,零 `node:*`) |
| §2 | L95–L233 | 模块级工具函数:`createUserMessage` / `createFailureMessage` / `cloneStreamOptions` / `findDuplicateNames` / `applyStreamOptionsPatch` |
| §3 | L234–L266 | `SUBSCRIBER_EVENT_TYPE`、`AgentHarnessHandler`、`normalizeHarnessError` / `normalizeHookError` |
| §4 | L267–L389 | `AgentHarnessTurnState` 接口、类字段区(L314–L349)、构造函数(L358) |
| §5 | L390–L540 | 事件分发三路:`getHandlers` / `emitOwn` / `emitAny` / `emitHook` / 两个 provider 专用发射器 / `emitQueueUpdate` |
| §6 | L541–L632 | `startRunPromise` / `createTurnState`(turn 快照)/ `createContext` |
| §7 | L633–L684 | `createStreamFn`:StreamFn 装配与三个 provider 钩子 |
| §8 | L685–L790 | `drainQueuedMessages` / `createLoopConfig`(伸进 loop 的六个回调) |
| §9 | L791–L854 | `validateUniqueNames` / `validateToolNames` / `flushPendingSessionWrites` |
| §10 | L855–L930 | `handleAgentEvent`(事件回流与 save point)/ `emitRunFailure` |
| §11 | L931–L1068 | `executeTurn` / `runLoopToCompletion`(一轮的运行机) |
| §12 | L1069–L1219 | 四条入口:`prompt` / `skill` / `promptFromTemplate` / `retryLastTurn` |
| §13 | L1220–L1275 | 队列入口 `steer` / `followUp` / `nextTurn` 与 `appendMessage` |
| §14 | L1276–L1470 | 结构性侧枝:`compact` / `navigateTree` |
| §15 | L1471–L1653 | 配置 getters / setters(16 个) |
| §16 | L1654–L1757 | `abort` / `waitForIdle` / `subscribe` / `on` |

> 下面代码块里的行号是**加注释之后**的真实行号;块内省去了新加的中文注释,只保留代码与上游原有的注释。

---

## 4. 逐节讲解

### §1 依赖导入(L55–L94)

这一节没有逻辑,但有一条纪律值得先记住:**整个文件没有一处 `import ... from "node:*"`**。它只导入类型、纯函数,以及 `agent-loop` / `compaction` / `messages` 这几个同样浏览器安全的模块。

原因在全景篇 §2.2:`packages/agent/src/index.ts` 是**浏览器安全**的主入口,而它 `export * from "./harness/agent-harness.ts"`。harness 要碰真实机器(跑命令、读文件),走的是构造时注入的 `ExecutionEnv`(`env` 字段),而 `NodeExecutionEnv` 只从 `src/node.ts` 那个 Node 专用入口导出。

---

### §2 模块级工具函数(L95–L233)

五个自由函数,没有一个导出。它们是这个类的私有词汇表。

#### `createUserMessage`(L103–L107)

`L103–L107`

```ts
function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}
```

「一条用户消息长什么样」在本文件里只有这一处定义 —— 四条入口(`prompt` / `skill` / `promptFromTemplate`)和三个队列(`steer` / `followUp` / `nextTurn`)全都调它。

一个细节:pi-ai 的 `UserMessage.content` 允许写成**裸字符串**(简写形态),这里刻意不用简写,永远给数组。这样第 2 行的 `push(...images)` 才能无条件成立,不必先判断「当前是不是字符串、要不要升维」。

#### `createFailureMessage`(L122–L143)

`L122–L131`

```ts
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
```

这条消息是「**失败是数据不是异常**」这条全局契约(全景篇 §3)在 harness 层的兑现物。

注意它兜的**不是** provider 请求失败 —— 那种失败由 pi-ai 自己编码成 `stopReason: "error"` 的消息从流里回来,根本走不到这里。这里兜的是 **loop 机器本身炸了**:某个 hook 抛异常、订阅者抛异常、`convertToLlm` 崩了。测试 `agent-harness.test.ts` 的 "settles thrown hook failures with persisted assistant error messages" 正是这条路:一个抛异常的 `context` hook,最后 `prompt()` **resolve** 出一条 `stopReason: "error"` 的消息,而且它进了会话文件。

`usage` 全填 0(L136–L143)不是偷懒:`usage` 是 `AssistantMessage` 的必填字段(`ai/src/types.ts:383`),而这条消息没有真实 token 账;填 0 让下游的计费聚合直接加 0,而不是崩在 `undefined` 上。

#### `cloneStreamOptions`(L151–L157)与 `applyStreamOptionsPatch`(L187–L227)

`cloneStreamOptions` 是「一层深拷」:顶层浅拷,`headers` / `metadata` 两个对象各复制一份。深到这一层就够了 —— `AgentHarnessStreamOptions` 里只有这两个字段是可变对象。它在四个地方出现:构造函数、`createTurnState`、`getStreamOptions`、`emitBeforeProviderRequest`。目的一致:**调用方手里的对象与 harness 内部的对象永不共享引用**。

`applyStreamOptionsPatch` 是 `before_provider_request` hook 的补丁引擎,三层 `undefined` 语义必须分清:

`L204–L219`

```ts
	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}
```

- **补丁里没这个键** → 保持原值。这就是必须写 `Object.hasOwn` 而不是 `patch.headers !== undefined` 的原因:后者分不出「没提供」和「显式给了 undefined」。
- **`patch.headers === undefined`** → 整个 headers 清空。
- **`patch.headers.foo === undefined`** → 只删 `foo` 这一个键。

最后一行的「键被删光就塌回 `undefined`」是归一化:让「有没有自定义 header」全程只有一种判法。测试 `agent-harness-stream.test.ts` 的 "chains provider request patches and supports deletion semantics" 把这四种情形一次钉死,包括「两个 hook 串联时,第二个看到的是第一个叠加后的结果」。

---

### §3 错误归一化与 handler 表(L234–L266)

`L239–L242`

```ts
const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;
```

**这两行是 §5 那个大坑的根源。** 订阅者(`subscribe`)和 hook(`on`)共用同一张 `handlers: Map<string, Set<Handler>>`,只靠 key 区分:订阅者全挂在 `"*"` 这一个桶,hook 按事件类型分桶。谁去遍历哪个桶,完全取决于发射器怎么写 —— 而 `emitOwn` 只遍历 `"*"`。

`L252–L259`

```ts
function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}
```

第一行的早退是关键:**已经是 `AgentHarnessError` 就原样透传**。否则一个 `busy` 错误经过 `prompt()` 的 catch(`fallbackCode = "unknown"`)会被重新包成 `unknown`,调用方按 code 分支的代码就全废了。

`normalizeHookError`(L263)是它的一个特化:hook / listener 抛的一律记成 `"hook"`。这个 code 的意义是让宿主分清「内核自己坏了」和「你注册的观察者坏了」—— 后者不该被当成内核 bug 去排查。

---

### §4 turn 快照、类字段与构造函数(L267–L389)

#### `AgentHarnessTurnState`(L281–L301)

`L281–L301`(省去注释)

```ts
interface AgentHarnessTurnState<...> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}
```

**这九个字段就是「一轮」的全部输入。** 进入一轮时冻结一份,本轮所有 provider 请求只读它;setter 改的是 harness 的配置字段,不动快照。于是「说到一半换模型」这一轮不生效 —— 这条不变式的实现就只有「快照 + `prepareNextTurn` 重建」这两下,没有别的机关。

两个要记住的细节:

- `messages` 是 `session.buildContext()` **投影之后**的结果(路径上最后一条 compaction 已应用),不是磁盘上的全量历史。
- `tools` 这个字段**没有读者**:全类只有 `createContext` 读快照里的工具,而它读的是 `activeTools`(L629)。写进去的 `tools`(L611)目前是死字段。

#### 类字段区(L314–L349)

按寿命分四类,这也是文件头注释说的「四类状态」:

| 类别 | 字段 | 寿命 |
|---|---|---|
| 不可变依赖 | `env` `models`(readonly)、`session` | 整个 harness |
| harness 配置 | `model` `thinkingLevel` `systemPrompt` `streamOptions` `resources` `tools` `activeToolNames` | 随时可被 setter 改 |
| 运行时状态 | `phase` `runAbortController` `runPromise` `pendingSessionWrites` | 一次运行 |
| 队列与订阅 | `steerQueue` `followUpQueue` `nextTurnQueue` `handlers` | 整个 harness |

`models` 是 `readonly` 有实际后果:注册表建好就换不掉,所以宿主在装配时(全景篇 §4 的 0.1 步)必须**一次把全部有凭据的 provider 注册齐**,不能等用户选到某家再补。

#### 构造函数(L358–L388)

`L374–L385`

```ts
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
```

三件事值得说:

1. **`thinkingLevel` 默认落到 `"off"`**,而 `"off"` 会让 `createLoopConfig` 把 `reasoning` 整个设成 `undefined`(L729)。对 reasoning 模型这等于「最强的那一档默认关掉,而且没有任何地方提示」。仓库根 `CLAUDE.md` 里那段关于 `defaultThinkingLevel` 注入的长篇讨论,起点就是这一行。
2. **不传 `activeToolNames` = 全部工具都激活**,顺序按 `options.tools` 的声明顺序。
3. **三种装配错误都在构造期同步抛**(工具重名 / 激活名重复 / 激活名不存在),不留到第一次 `prompt()`。注意查重发生在写 Map **之前**(L367–L373):Map 自己会静默覆盖,查重晚一步就没意义了。

---

### §5 事件分发三路(L390–L540)

这一节有五个发射器,分成三种语义。**读这一节的收益最高**:它决定了「你注册的回调到底会不会被调、返回值有没有人看」。

#### `emitOwn`(L407)与 `emitAny`(L426):纯广播

`L407–L419` 与 `L426–L434`(去掉注释后**逐字节相同**)

```ts
	private async emitOwn(event: AgentHarnessOwnEvent<...>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}
```

两个方法的差别**只在入参类型**:`emitOwn` 收 harness 自有事件,`emitAny` 收 `AgentEvent ∪ 自有事件`。运行时行为完全一致 —— 都只遍历 `"*"` 订阅者桶。

这带来了本文件最大的一个坑:**走 `emitOwn` 的 11 种事件,用 `on()` 注册永远不会触发**(详见 §5 第 1 条)。

另外两条性质:

- **逐个 `await`,不是 `Promise.all`。** 订阅者按注册顺序、一个跑完再跑下一个。桌面端投影器的三条不变式(全景篇 §1 的「投影器」一节)依赖这个顺序性。
- **订阅者抛错不吞。** 它会被包成 code `"hook"` 往上抛;在 `turn_end` 那一路会先被暂存(L876–L888),其余路径直接冒到入口方法的 catch,最终变成一次失败运行。

#### `emitHook`(L445):有返回值的那条活路

`L448–L464`

```ts
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
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
```

这是唯一去查 `event.type` 那个桶的发射器,所以 **`on()` 只有经它(以及下面两个 provider 专用发射器)分发的事件才是活的**:`before_agent_start` / `context` / `tool_call` / `tool_result` / `session_before_compact` / `session_before_tree`,加上 `before_provider_request` / `before_provider_payload`,共 8 种。

合并规则是「**最后一个非 undefined 胜出**」:后注册的覆盖先注册的,但返回 `undefined` 等于弃权、不会抹掉前面的结果。

#### 两个 provider 专用发射器:链式叠加

`emitBeforeProviderRequest`(L475)与 `emitBeforeProviderPayload`(L509)之所以不能走 `emitHook`,是因为语义不同:`emitHook` 是「所有 handler 看**同一份**输入、最后一个胜出」,而这两个是「上一个 handler 的结果**叠给**下一个」。

`emitBeforeProviderRequest` 每次都把 `cloneStreamOptions(current)` 交给 handler —— **就地改它无效**,必须通过返回值里的 patch 表达修改。

`emitBeforeProviderPayload` 有个尖角:判的是 `result !== undefined`、取的是 `result.payload`。类型上 `BeforeProviderPayloadResult.payload` 是必填的,但运行时若 handler 返回一个没有 `payload` 的对象,整个请求体会被抹成 `undefined`。

#### `emitQueueUpdate`(L532)

三个队列任何一次变动之后发的通知,三份数组都是副本。它走 `emitOwn`(所以 `on("queue_update")` 收不到),而且**它会抛错** —— 这正是 `drainQueuedMessages`(§8)与 `executeTurn`(§11)需要回滚队列的原因。

---

### §6 运行承诺与 turn 快照(L541–L632)

#### `startRunPromise`(L550–L561)

```ts
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
```

一个「本次运行还没结束」的信号量。`waitForIdle()` 就是 `await this.runPromise`。返回的 `finish` 必须在入口方法的 `finally` 里调 —— 漏掉一次,`waitForIdle()`(以及 `await` 它的 `abort()`)就永久挂住。

`finish` 里**先清 `runPromise` 再 `resolve`**:两句都是同步的,`resolve` 唤醒的续体一定看到「没有在飞的运行」。

#### `createTurnState`(L569–L614):冻结

`L574–L583`

```ts
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
```

第一行有一个容易漏的事实:`buildContext()` 返回的 `SessionContext` 里除了 `messages`,还有它从会话路径上**推导出来的** `model` / `thinkingLevel` / `activeToolNames`(`session/session.ts:44` 的 `deriveSessionContextState`)。这里**只取了 `messages`,另外三个被丢弃**。

后果:**重开一条历史会话时,harness 不会自动恢复当时用的模型和思考档位** —— 那是宿主的活儿(桌面端在 `session-manager.ts` 里自己读会话再 `setModel`)。读代码时很容易以为「会话记了模型,所以恢复是自动的」。

`L587–L599`

```ts
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env, session: this.session, model: this.model,
				thinkingLevel: this.thinkingLevel, activeTools, resources,
			});
		}
```

系统提示词三种形态。**函数形态每轮(以及每个 save point)都会被重新调用** —— 这就是「换了模型之后提示词能跟着变」的实现方式,宿主不需要手动刷新。coding-agent 的 `buildSystemPrompt` 就挂在这里。

#### `createContext`(L622–L631):摊平

```ts
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
```

**两个 `slice()` 是要害。** loop 会**就地** push 流式消息与工具结果进 `context.messages`(`agent-loop.ts` 的 `runLoop`),不复制的话它写的就是快照里那个数组,下一次 `createTurnState` 的对比基准就被污染了。同理 `tools` 也要拷。

---

### §7 StreamFn 装配(L633–L684)

`createStreamFn` 是「harness 怎么发一次请求」的全部答案。

`L649–L653`

```ts
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
```

第一行的参数名有欺骗性:**`streamOptions` 不是 harness 的 streamOptions**,它是 loop 把 `AgentLoopConfig` 整个展开之后传下来的那份(`agent-loop.ts` 的 `streamAssistantResponse`:`{...config, apiKey, signal}`)。harness 只从它里面取 `reasoning` 和 `signal` 两样(L676–L677),别的一概不用。

`getTurnState()` 是**取值函数而不是快照值**:`prepareNextTurn` 换过快照之后,后续请求必须读到新的 `streamOptions` / `sessionId`,所以必须晚绑定。

`L658–L681`

```ts
			return this.models.streamSimple(model, context, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => { /* emitOwn after_provider_response */ },
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
			});
```

**逐字段显式列举,不是整体展开。** 这不是风格问题,而是一条边界:loop config 里的 `temperature` / `maxTokens` / `apiKey` / `thinkingBudgets` **不会**被转发。也就是说走 harness 这条路时,凭据只可能来自 `models` 注册表里 provider 自己的 auth ——`AgentLoopConfig.apiKey` 与 `getApiKey` 在这条路上是死路(它们是给 `Agent` 类那个参考实现留的)。

三个 provider 钩子的挂载点也在这里:`before_provider_request`(改请求选项,链式)、`onPayload → before_provider_payload`(改请求体,链式)、`onResponse → after_provider_response`(纯观察,走 `emitOwn` 所以 `on()` 收不到)。

---

### §8 队列排空与 loop 配置(L685–L790)

#### `drainQueuedMessages`(L696–L706)

```ts
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
```

两条设计:

- **队列空时不发 `queue_update`**(第 2 行早退),否则每个 `turn_end` 都要刷一条没有信息量的事件。
- **hook 抛错要回滚**:`unshift` 把消息塞回队头。消息不能因为观察者炸了而丢失。这个模式在本文件里出现**两次**(这里与 `executeTurn` 的 L954)。

#### `createLoopConfig`(L718–L789):伸进 loop 的六只手

**harness 全类没有一行 `while`/`for` 在驱动轮次。** 多轮、工具批、队列轮询全在 `agent-loop.ts` 里,harness 只通过这张配置表参与。六个回调与 hook 的对应关系:

| loop 回调 | harness 做什么 | 行号 |
|---|---|---|
| `convertToLlm` | 直接给 `messages.ts` 的同名函数(LLM 边界) | L730 |
| `transformContext` | `emitHook("context")`,返回值只喂本次请求 | L734 |
| `beforeToolCall` | `emitHook("tool_call")`,可 `{block:true}` | L741 |
| `afterToolCall` | `emitHook("tool_result")`,可改写 content/details/isError/terminate | L754 |
| `prepareNextTurn` | flush → 重建快照 → 换 loop 的运行时状态 | L774 |
| `getSteeringMessages` / `getFollowUpMessages` | 各自 `drainQueuedMessages` | L786–L787 |

`L724–L729`

```ts
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
```

`model` 和 `reasoning` 是**值不是取值函数**,取的是开跑那一刻的快照 —— 它们只代表第一轮,之后换模型全靠 `prepareNextTurn` 的返回值(loop 用 `{...config}` 叠加,`agent-loop.ts:225-235`)。

`"off" → undefined` 这一行就是「默认档位 off 等于关掉思考」的落点:发给 provider 的不是字符串 `"off"`,而是**根本没有 reasoning 这个参数**。

`L774–L783`

```ts
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
```

**三步顺序不能换。** 先 flush(让本轮 setter 真正落进树)→ 再 `createTurnState`(此时才读得到刚落的那几条)→ 最后把新 context 交还 loop。倒过来的话,新快照读到的是没写入之前的历史,「中途改配置」就永远慢一轮。

这也是桌面端**自动压缩换 context 的落点**:`host/compaction.ts` 在这之前把 compaction 条目写进 session,这里重建的快照自然带上了压缩后的投影。

---

### §9 名字校验与挂起写入(L791–L854)

`validateToolNames`(L805)有个容易忽略的参数:`tools` 默认取当前工具表,但 `setTools()` 传的是**将要生效的新表**。这样「换工具表 + 换激活集」能在真正改字段之前一起校验掉,失败时状态不会半生不熟。

#### `flushPendingSessionWrites`(L822–L853)

`L825–L828` 与 `L850–L851`

```ts
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			...
			this.pendingSessionWrites.shift();
		}
```

两条性质都藏在这个「读队头 → 写 → shift」的形状里:

1. **不用 `for...of`。** 每次 `await` 期间队列还可能被追加(订阅者在 `message_end` 回调里调 `appendMessage` 就会),按索引遍历会漏掉新来的。
2. **写成功之后才出队。** 某条写失败时它**留在队头**,下一次 flush 会重试它;既不会跳过一条继续写下一条(那会让树上出现顺序错乱的父子关系),也不会把整个队列烂在半路。

这个队列同时是全仓「**同一时刻只有一个写者**」的唯一保证 —— 因为 `session.appendEntry` 取 id 与写入之间隔着一个 `await getLeafId()`,两个并发的 `append*` 会拿到同一个 `parentId`,结果是意外分叉而不是链(全景篇 §6.1「会话树与持久化」)。直接用 `Session` 的调用方要自己串行。

**五个死分支**:L839–L848 的 `custom` / `custom_message` / `label` / `session_info` / `leaf` 在本文件里**没有生产者** —— 全类 push 进队列的只有 `message` / `model_change` / `thinking_level_change` / `active_tools_change` 四种。它们是跟着 `PendingSessionWrite`(从 `SessionTreeEntry` 派生的类型)一起来的。

---

### §10 事件回流:`handleAgentEvent`(L855–L930)

loop 的 10 种 `AgentEvent` 全从这里过,只有三种有特殊处理。

#### `message_end`:先落盘再通知

`L868–L872`

```ts
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
			await this.emitAny(event, signal);
			return;
		}
```

顺序是契约:订阅者看到一条消息时,它已经在会话文件里了。反过来的话,订阅者里发起的重载有可能读到一份还缺最后一条消息的历史。

#### `turn_end`:save point 的三步

`L874–L891`

```ts
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
```

**这十几行的顺序全是刻意的**(全景篇 §4 第 37 步):

1. 先 `emitAny`,订阅者抛的错**暂存不吞**;
2. 记下 `hadPendingMutations`(flush 完队列就空了,晚一步这个标志位就只能是 false);
3. flush;
4. **然后**才抛暂存的错;
5. 都没错才发 `save_point`。

第 3 步和第 4 步写反的后果:一个订阅者炸掉就会把本轮攒下的会话写入全部丢掉 —— 那才是真正不可逆的损失(事件可以重发,已经丢掉的写入无从恢复)。

#### `agent_end`:相位归位

`L896–L903`

```ts
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			await this.emitAny(event, signal);
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
```

**相位在 `emitAny` 之前就 idle 了。** 所以订阅者在 `agent_end` 回调里发起新的 `prompt()` 不会撞 busy;但此时 `runPromise` 还没解开(那发生在入口方法的 `finally`,L1098),`waitForIdle()` 仍在等。一句话:**`phase === "idle"` 不等于「这次运行彻底 settled」**。

#### `emitRunFailure`(L917–L929)

```ts
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
```

因为走的是 `handleAgentEvent` 而不是直接 `emitAny`,这条失败消息**同样会落盘**、`turn_end` **同样会 flush**、`agent_end` **同样会把相位拨回 idle**。一次事故的善后与一次正常收尾完全同构 —— 这是这段代码最漂亮的地方:UI 不需要为「内核炸了」写第二套状态机。

---

### §11 一轮的运行机(L931–L1068)

#### `executeTurn`(L941–L978)

`L946–L957`

```ts
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
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
```

`nextTurn` 队列**前置**在用户消息之前:它们是「上一轮结束后排给下一轮的话」,语义上早于这一次输入。而 `before_agent_start` hook 返回的 messages 是**追加在后面**的(L969)—— 两个方向正好相反,别记混。

注意 `nextTurnQueue` 是整队 `splice(0)` 一次拿光的,它没有 `QueueMode` 这个开关。

#### `runLoopToCompletion`(L991–L1067)

这是 `executeTurn` 与 `retryLastTurn` 共享的运行机,也是 `runAgentLoop` / `runAgentLoopContinue` 在本仓的**唯一两个调用点**(靠 `startLoop` 参数注入策略)。

`L1004–L1012`

```ts
		let activeTurnState = initialTurnState;
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState) => { activeTurnState = nextTurnState; };
		const abortController = new AbortController();
		this.runAbortController = abortController;
```

闭包变量 + 一读一写两个函数:`createStreamFn` 与 `createLoopConfig` 拿到的是同一份「当前快照」的视图,`prepareNextTurn` 一换,两边同时看到新值。

`this.runAbortController` 到这一行才被赋值 —— 这是 §5 那个 abort 窗口的成因。

`L1015–L1043` 的立即执行 async 函数把「跑 loop + 失败兜底」收成一个 Promise,让下面的 `try/finally` 只负责取结果与善后。兜底里还有一层:补失败尾巴本身也可能炸(订阅者在 `agent_end` 回调里再抛一次),那时两条错误一起装进 `AggregateError` —— 丢掉任何一条都会让排查变成猜谜。

`L1044–L1066`

```ts
		try {
			const newMessages = await runResultPromise;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") return message;
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.runAbortController = undefined;
			}
		}
```

- **从尾往前找最后一条 assistant**:一轮的返回值定义为「模型最后说的那句话」,而 `newMessages` 的尾部通常还跟着一批 toolResult 消息。
- **内层 `finally`**:即使兜底 flush 再炸,`runAbortController` 也一定被清掉,否则下一次 `abort()` 会去 abort 一个早就结束的 controller。

---

### §12 四条入口(L1069–L1219)

四条入口的骨架完全一样,值得逐句读的是 `prompt()`:

`L1078–L1099`

```ts
	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}
```

- **守卫在第一个 `await` 之前同步生效** —— 这就是「相位机而非锁」:同一个微任务里连发两次 `prompt()`,第二次必定同步炸,不会排队。
- **catch 里那句 `phase = "idle"` 只服务异常路径**(正常路径 `agent_end` 已经拨过了)。漏掉它,一次 `createTurnState` 失败就会让 harness 永久卡在 `turn`,之后每次 `prompt()` 都报 busy。
- **被 abort 时是 resolve 而不是 reject**:中断是数据不是异常,`runLoopToCompletion` 会返回那条 `stopReason: "aborted"` 的 assistant 消息。要区分「取消」和「完成」只能自己拿着 AbortController 对照。

`skill()`(L1109)与 `promptFromTemplate()`(L1132)只多一步:在快照的 `resources` 里按名字查,查不到抛 `invalid_argument`。因为这次失败发生在**冻结快照之后**(相位已经是 `turn`),catch 里那句 `phase = "idle"` 是必需的,不是复制粘贴的样板。

#### `retryLastTurn`(L1167–L1218)

`L1175–L1194`

```ts
			const messages = turnState.messages.slice();
			let stripped = 0;
			while (messages.length > 0) {
				const last = messages[messages.length - 1]!;
				if (last.role === "assistant" && last.stopReason === "error") {
					messages.pop();
					stripped++;
					continue;
				}
				break;
			}
			if (stripped === 0) { throw new AgentHarnessError("invalid_state", "..."); }
```

- **摘的是尾部连续多条**,不只最后一条(连续重试失败会在尾部堆好几条)。测试 "strips a pile of consecutive failures, not just the last one" 钉住了它。
- **只认 `stopReason === "error"`,不摘 `"aborted"`** —— 用户主动取消不该被自动重试当成故障重来一遍。
- **摘掉的只是本次上下文,会话树里那些失败条目一条不删** —— 同压缩,「改的是投影,不是历史」。
- 相位用的是 `"retry"` 而不是 `"turn"`,宿主据此区分「用户发的轮」和「系统补的轮」。

---

### §13 队列入口与 appendMessage(L1220–L1275)

三个队列方法的相位守卫**方向不同**,这是本文件唯一一处「反向守卫」:

| 方法 | 守卫 | 理由 |
|---|---|---|
| `steer`(L1229) | `phase === "idle"` 时抛 `invalid_state` | 没有在飞的运行,插话没有插的对象 |
| `followUp`(L1239) | 同上 | 同上 |
| `nextTurn`(L1250) | **无守卫** | 它排的就是「下一次 prompt」,任何相位都成立 |

`appendMessage`(L1264)是 idle/忙两条路的样板:

```ts
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
			} else {
				this.pendingSessionWrites.push({ type: "message", message });
			}
```

于是订阅者在 `message_end` 回调里写的东西一定排在 agent 自己那条消息**之后**,不会插队。测试 "orders pending listener session writes after agent-emitted messages" 断言最终条目顺序是 `["user", "assistant", "custom"]`。

---

### §14 结构性侧枝:compact / navigateTree(L1276–L1470)

两条侧枝的共同点:**idle-only、各占一个相位、`finally` 里归位、不走挂起写入队列而是直接写持久 session**。它们与 turn 循环没有任何交集。

#### `compact()`(L1291–L1350)

流程:`getBranch()` → `prepareCompaction`(纯函数,定切点)→ `session_before_compact` hook(可取消、可直接给现成摘要)→ `compact()` 调模型 → **成功之后才** `appendCompaction` 落盘 → 读回条目发事件。

`L1323–L1337`

```ts
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(preparation, this.models, model, customInstructions, undefined, this.thinkingLevel);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			const entryId = await this.session.appendCompaction(
				result.summary, result.firstKeptEntryId, result.tokensBefore, result.details,
				provided !== undefined,
			);
```

两个细节:

- **落盘在最后。** 摘要生成途中失败的话,树分毫未动 —— 这是「压缩失败不能连坐已经拿到的回答」的基础。
- **第 5 个参数 `undefined` 就是 signal。** 加上 hook 那里的 `new AbortController().signal`(L1317),这条侧枝**根本不可中断**(见 §5)。

#### `navigateTree()`(L1360–L1469)

求 LCA → 收集被抛下的分支 → `session_before_tree` hook → 可选地生成 branch summary → 决定新 leaf → `moveTo`。

`L1421–L1442` 的三分支是产品语义:目标是 **user 消息**或 **custom_message** 时,`newLeafId` 落到它的**父节点**,并把原文以 `editorText` 交还给应用 —— 这就是 CLI / 桌面端「编辑上一条消息重发」的实现。其余类型的条目就停在它自己身上。

`L1446` 的 `moveTo` 有个容易踩的返回语义:它先追加一条 leaf 条目,带 summary 时**再**追加一条 branch_summary,于是最终 leaf 是**摘要条目**而不是 `newLeafId`。所以下面发 `session_tree` 事件时要重新 `await this.session.getLeafId()`(L1458),不能直接用 `newLeafId`。

---

### §15 配置 getters / setters(L1471–L1653)

16 个方法,但**行为分成两类**,名字看不出来:

| 类 | 方法 | 行为 |
|---|---|---|
| 写会话 + 发事件 | `setModel`(L1484)`setThinkingLevel`(L1509)`setTools`(L1535)`setActiveTools`(L1577) | idle 直写 session / 忙时入队,然后 `emitOwn` |
| 纯改内存 | `setSteeringMode`(L1608)`setFollowUpMode`(L1616)`setStreamOptions`(L1650) | 既不写会话也不发事件 |
| 只发事件 | `setResources`(L1636) | 不写会话(资源是宿主的快照),但发 `resources_update` |

`setModel` 是第一类的样板:

`L1486–L1494`

```ts
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
			}
			this.model = model;
			await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
```

**先写会话再改字段**:写失败时字段不动,内存状态与磁盘不会分家。而且这一切**本轮都不生效** —— 在飞的那一轮读的是 turn 快照。

`getResources`(L1624)/ `getStreamOptions`(L1646)返回的都是副本;`getActiveTools`(L1569)里的非空断言是安全的,因为 `activeToolNames` 的每一次赋值都过了 `validateToolNames`。

---

### §16 abort / waitForIdle / subscribe / on(L1654–L1757)

#### `abort()`(L1669–L1700)

```ts
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		this.runAbortController?.abort();
		const errors: Error[] = [];
		try { await this.emitQueueUpdate(); } catch (error) { errors.push(toError(error)); }
		try { await this.waitForIdle(); } catch (error) { errors.push(toError(error)); }
		try { await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp }); } catch (error) { errors.push(toError(error)); }
```

四条性质:

1. **`nextTurnQueue` 不清空** —— 用户在中断之前排的话应该留到下一轮。
2. **清队列与 abort 之间没有 `await`**,两件事在同一个微任务里完成,loop 没有插进来把刚清掉的队列又拉走的机会。
3. **三段各自 try/catch 收集错误**,不让第一个错误短路:队列已经清了、controller 已经 abort 了,剩下的通知与等待必须照做完。
4. **它内部已经 `await waitForIdle()`**(L1686),所以单独 `await harness.abort()` 就够。

#### `on()`(L1743–L1756)

```ts
		let handlers = this.handlers.get(type);
		if (!handlers) { handlers = new Set(); this.handlers.set(type, handlers); }
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
```

代码本身没有任何问题,坑在**它注册进去的桶有没有人来遍历**:`AgentHarnessEventResultMap` 列了 19 种事件,而真正会被读取的只有 8 种。详见 §5 第 1 条。

---

## 5. 会咬人的地方

1. **`on()` 注册的 11 种事件永远不会触发。** `emitOwn`(L407–L419)与 `emitAny`(L426–L434)去掉注释后逐字节相同,都只遍历 `"*"` 订阅者桶。死的是:`queue_update` / `save_point` / `abort` / `settled` / `after_provider_response` / `session_compact` / `session_tree` / `model_update` / `thinking_level_update` / `resources_update` / `tools_update`。活的 8 种走 `emitHook`(L445)或两个 provider 专用发射器。
   **【与 CLAUDE.md 不符】** 仓库根 `CLAUDE.md` 的「内核事件只能用 `subscribe()`」一节说「这十个 `on()` 类型永远不会触发」,实际是 **11 个** —— 漏了 `resources_update`(L1642 发出)。

2. **`abort()` 有一个无效窗口。** `this.runAbortController` 到 `runLoopToCompletion` 的 L1012 才被赋值,而 `prompt()` 在那之前要先 `await this.createTurnState()`(L1088,会做 session I/O)。abort 恰好落在这个窗口时什么也打断不了,却会 `await waitForIdle()` 一直等到整轮跑完。
   **【与 CLAUDE.md 不同】** `CLAUDE.md` 说「`abort()` 之后 phase 不会立刻清 —— 必须 `await abort(); await waitForIdle()`」。实际上 `abort()` 内部**已经** await 了 `waitForIdle`(L1686),单独 `await harness.abort()` 就够;真正的坑是**不 await** 就去读 `phase`。

3. **compact() 与 navigateTree() 不可中断。** 三处 signal 全是刚 new 出来、永远不会 abort 的:L1317(compact 的 hook)、L1386 与 L1399(navigateTree),而 L1325 调 `compact()` 时第 5 个参数(signal)直接传 `undefined`。`harness.abort()` 只作用于 `runAbortController`。配套后果:这两条侧枝也不建 `runPromise`,所以压缩期间 `waitForIdle()`(L1707)是**立刻返回**的 —— 想等压缩结束只能自己 await `compact()` 的 Promise。
   由此 L1407 那句 `if (branchSummary.error.code === "aborted") return { cancelled: true }` 只可能由 provider 自己报 `stopReason: "aborted"` 触发,harness 这一侧永远不会主动让它成立。

4. **`phase === "idle"` 不等于「运行已 settled」。** 相位在 `agent_end` 处理时就拨回 idle(L898),而 `runPromise` 要等入口方法的 `finally`(L1098)才解开。中间隔着 `emitAny` + `emitOwn("settled")` 两轮订阅者回调。判断「跑完了没有」要用 `waitForIdle()`,不要轮询 `phase`。

5. **`buildContext()` 推导出来的会话状态被丢弃。** L574 只取了 `context.messages`;`SessionContext` 里的 `model` / `thinkingLevel` / `activeToolNames`(由 `deriveSessionContextState` 扫完整路径推出)一个都没用。重开历史会话时恢复模型与档位是**宿主的活儿**。

6. **turn 快照里的 `tools` 是死字段。** L611 写入,全类无人读取(`createContext` 用的是 `activeTools`,L629)。想拿全量工具表请用 `getTools()`。

7. **挂起写入的五个分支没有生产者。** L839–L848 的 `custom` / `custom_message` / `label` / `session_info` / `leaf` 永远不会被执行 —— 全类 push 进队列的只有四种(L1269、L1490、L1515、L1551、L1585)。

8. **`thinkingLevel` 默认 `"off"`,而 `"off"` = 把 reasoning 从请求里摘掉。** L378 落默认值,L729 做转换。对 reasoning 模型,这是「最强的那一档默认关掉且无提示」。桌面端与 bench 各自注入 `defaultThinkingLevel` 就是为了绕开它。

9. **`createStreamFn` 丢掉了 loop config 的一半字段。** L658–L681 逐字段列举,`temperature` / `maxTokens` / `apiKey` / `thinkingBudgets` 都不转发。所以在 harness 这条路上,`AgentLoopConfig.apiKey` 与 `getApiKey` 是死路,凭据只能来自 `models` 注册表。

10. **`promptFromTemplate()` 目前必然失败。** `AgentHarnessResources.promptTemplates` 全仓无人填写,`prompt-templates.ts` 的磁盘加载器也没实现,于是 L1139 的 `Unknown prompt template` 是唯一结局。它是预留机制,不是可用功能。

11. **同名 setter 行为分两类。** `setSteeringMode` / `setFollowUpMode` / `setStreamOptions` 既不写会话也不发事件(L1608 / L1616 / L1650),而 `setModel` / `setThinkingLevel` / `setTools` / `setActiveTools` 都写会话并发事件。想靠订阅事件同步 UI 的话,前三个是收不到的。

12. **`before_provider_payload` hook 能把请求体抹成 `undefined`。** L516–L518 判的是 `result !== undefined`、取的是 `result.payload`;handler 返回一个没有 `payload` 字段的对象时,`current` 就变成 `undefined` 了。

13. **【与全景篇不符】** 全景篇 §6.1 说「这类『hook 抛错要回滚』的模式在 `agent-harness.ts` 里出现**三次**」。以代码为准:`unshift` 回滚只有**两处** —— L703(`drainQueuedMessages`)与 L954(`executeTurn` 的 nextTurn 队列)。第三处如果指的是 `flushPendingSessionWrites` 的「写成功才 shift」(L851),那是另一种模式(不回滚,只是不推进)。

14. **【行号漂移】** 全景篇 §1/§4/§5 与 `CLAUDE.md` 引用本文件的行号(`prompt :660`、`createTurnState :335`、`createLoopConfig :422`、`handleAgentEvent :517`、`:214`、`:429`、`:230-248` 等)都是**加注释之前**的行号,现已整体下移(对照表见本文 §3 与 §4)。另有两处上游锚点本来就偏了几行:全景篇 §5.2 写的 `executeTurn(:596)` / `retryLastTurn(:760)`,实际调用点在旧行号的 592 / 755。**对照阅读时按符号名找,别按行号找。**

15. **`compact()` 的事件是「尽力而为」的。** L1340–L1343 读回条目才发 `session_compact`,读不到或类型不对就静默跳过 —— 但压缩本身**已经成功**,返回值照常给。别把「没收到事件」当成「没压成功」。

16. **`navigateTree()` 之后的 leaf 不是你传的那个 id。** `moveTo`(L1446)带 summary 时会再追加一条 branch_summary 条目,leaf 停在摘要上。要真实 leaf 得重新 `getLeafId()`。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `../agent-loop.ts` | `runAgentLoop`(L976)与 `runAgentLoopContinue`(L1210),各一个调用点 |
| 它 import | `../types.ts` | `AgentLoopConfig` / `StreamFn` / `AgentEvent` / `AgentMessage` / `AgentTool` / `QueueMode` / `ThinkingLevel` |
| 它 import | `./types.ts` | `AgentHarnessOptions` / 事件接口 / `AgentHarnessError` 等四个错误类 / `PendingSessionWrite` |
| 它 import | `./messages.ts` | `convertToLlm` —— 直接作为 loop 配置的一个字段传下去(L730),harness 自己不调它 |
| 它 import | `./session/session.ts` | 只 import 类型;实例由构造函数注入 |
| 它 import | `./compaction/compaction.ts` | `prepareCompaction` / `compact` / `DEFAULT_COMPACTION_SETTINGS`(§14) |
| 它 import | `./compaction/branch-summarization.ts` | `collectEntriesForBranchSummary` / `generateBranchSummary`(§14) |
| 它 import | `./skills.ts` / `./prompt-templates.ts` | 两个纯格式化函数,把技能/模板变成一段用户消息文本 |
| 它 import | `@earendil-works/pi-ai` | 全是类型:`AssistantMessage` / `ImageContent` / `Model` / `Models` / `UserMessage` |
| import 它 | `packages/agent/src/index.ts:40` | `export *`,整个类经包根导出 |
| import 它 | `packages/kernel/src/host/session-manager.ts:530` | 桌面端宿主,`new AgentHarness({...})` + `subscribe(投影器)` |
| import 它 | `packages/coding-agent/src/acp/agent.ts:435` | ACP(Zed)宿主,同样的装配 |
| import 它 | `packages/coding-agent/src/acp/session.ts:11` | 只 import 类型,把 harness 事件管道接到 ACP 通知 |
| 测试 | `packages/agent/test/harness/agent-harness.test.ts` | 23 例:构造校验、队列、hook、save point、retry |
| 测试 | `packages/agent/test/harness/agent-harness-stream.test.ts` | 4 例:streamOptions 快照与补丁链 |

> 注意 `compact()` 与 `navigateTree()` **没有针对 harness 方法本身的测试**(文件头注释自陈过这一点):`compaction.test.ts` 测的是 `compaction.ts` 里的自由函数,不经过这里的相位守卫与 hook 分支。

---

## 7. 自测题

**Q1.** 用户点了「发送」,消息还没吐完就在模型对话框里把模型从 A 换成 B。这一轮的请求会用哪个模型?第二轮呢?如果这一轮里模型只回了一句话就结束(没有调工具),第二轮还存在吗?

<details><summary>答案</summary>

这一轮用 **A**:`createLoopConfig` 的 `model` 字段(L726)取的是开跑那一刻的快照值,`createStreamFn` 也只从快照读 streamOptions。`setModel` 改的是 `this.model` 这个配置字段(L1490)。

第二轮用 **B**:`turn_end` 之后 loop 调 `prepareNextTurn`(L774),它重建快照并把 `nextTurnState.model` 交还给 loop,loop 用 `{...config, model}` 覆盖。

如果模型一句话就说完(`stopReason: "stop"`、没有 toolCall、两个队列也空),那么内层 while 直接退出、`agent_end` 发出,**根本没有第二轮** —— 这次 `setModel` 要等下一次 `prompt()` 的 `createTurnState` 才生效。会话文件里的 `model_change` 条目是已经写了的(idle 时直写,忙时入队后在 turn_end flush)。
</details>

**Q2.** 把 `handleAgentEvent` 里 `turn_end` 分支的顺序改成「先 flush、再 emitAny」(即去掉 `eventError` 暂存那套),会坏在哪里?反过来,如果保持顺序但把 `hadPendingMutations` 的赋值挪到 flush 之后呢?

<details><summary>答案</summary>

**第一个改动看起来更简单,但会丢数据的反面。** 现在的顺序是「emit → flush → 抛暂存错」。如果改成「flush → emit」,数据其实不会丢……但你会丢掉另一样东西:订阅者是在**本轮写入已落盘之后**才看到 `turn_end` 的语义没变,而**订阅者在 `turn_end` 回调里通过 `appendMessage` 产生的写入**就赶不上这一次 flush 了,要拖到 `agent_end` 才落盘。真正致命的是原注释警告的那种写法 ——「emit(不暂存,直接让错误冒出去)→ flush」:订阅者一抛错,函数就地退出,本轮攒下的挂起写入**全部丢失**,而事件可以重发、写入无从恢复。

**第二个改动是纯 bug:** `flushPendingSessionWrites` 跑完队列必空,`hadPendingMutations` 永远是 `false`,`save_point` 事件的这个标志位失去意义。
</details>

**Q3.** 一个订阅者在 `message_end` 回调里调用 `harness.appendMessage(customMsg)`。这条自定义消息会出现在会话文件的什么位置?如果改成在 `agent_end` 回调里调呢?

<details><summary>答案</summary>

**`message_end` 里调**:此时 `phase === "turn"`(非 idle),所以走 `pendingSessionWrites.push`(L1269),排队;到本轮 `turn_end` 时由 `flushPendingSessionWrites` 落盘。于是顺序是 `user → assistant → custom`,自定义消息**排在 agent 那条消息之后**。测试 "orders pending listener session writes after agent-emitted messages" 断言的就是这个。

**`agent_end` 里调**:`handleAgentEvent` 处理 `agent_end` 时是**先 flush、再置 idle、再 emitAny**(L897–L899)。所以订阅者跑到时 `phase` 已经是 `"idle"` 了 → 走**直写**分支,立刻 `session.appendMessage`。位置仍在最后,但落盘时机不同 —— 而且它错过了这一轮的 flush,如果直写抛错,没有队列帮你重试。
</details>

**Q4.** 某个 `context` hook 抛了异常。`prompt()` 会 reject 吗?会话文件里会留下什么?harness 还能继续用吗?

<details><summary>答案</summary>

**不会 reject,而是 resolve 出一条 `stopReason: "error"` 的 assistant 消息。** 路径是:hook 抛错 → `emitHook` 包成 `AgentHarnessError("hook")` → 冒到 loop → `runAgentLoop` 的 Promise reject → `runLoopToCompletion` 的 catch(L1024)→ `emitRunFailure` 合成失败消息并补发四连事件 → 返回 `[failureMessage]` → 找到最后一条 assistant 并返回。

**会话文件里留下两条**:用户消息(loop 开局的 `message_end` 已经落盘)和这条合成的失败 assistant 消息(`emitRunFailure` 走的也是 `handleAgentEvent`)。

**还能继续用**:`agent_end` 分支把 `phase` 拨回了 `idle`。测试里紧接着的 `harness.prompt("after failure")` 正常返回。这条失败消息还会成为 `retryLastTurn()` 的摘除目标。
</details>

**Q5.** 你想给 harness 加一条「每次 save point 记一行审计日志」的逻辑,于是写了 `harness.on("save_point", () => log(...))`。它不会被调用。为什么?最小的正确改法是什么?如果一定要用 `on()`,需要改哪一行代码,会带来什么新问题?

<details><summary>答案</summary>

**为什么不调用**:`save_point` 是经 `emitOwn`(L889)发出的,而 `emitOwn` 只遍历 `"*"` 这个订阅者桶(L410),从不去查 `handlers.get("save_point")`。`on()` 把 handler 放进了 `"save_point"` 桶(L1749),没人来取。

**最小正确改法**:改用 `subscribe((event) => { if (event.type === "save_point") log(...) })`。订阅者桶是唯一被 `emitOwn` / `emitAny` 遍历的桶。

**一定要用 `on()` 的话**:在 `emitOwn` 里多遍历一次 `this.getHandlers(event.type)`。新问题有两个:(1)`AgentHarnessEventResultMap` 给这 11 种事件的结果类型都是 `undefined`,一旦它们真的被调用,「返回值有没有意义」就成了一个必须回答的新问题;(2)`emitOwn` 的调用点有 12 处、覆盖 11 种事件,其中 `save_point` / `settled` / `abort` 都在关键路径上 —— 多一个会抛错的 handler,就多一条能把整轮变成失败运行的路径(`emitOwn` 不吞错,L416)。
</details>
