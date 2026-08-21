# packages/agent/src/types.ts

> **档位** A(逐行) · **行数** 836(加中文注释之前是 430) · **包** `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 · §3 第二组 · §4 · §5.2 · §6.1 · **索引** [README](../README.md)

## 1. 一句话

这是 `packages/agent` 的**契约文件**:裸循环、会话外壳(harness)、工具层三者之间所有共享形状的唯一定义处 —— 零运行时代码,但每个字段的语义就是行为规范。

---

## 2. 它在全景里的位置

先说一句可能反直觉的话:**这个文件不在「一次 prompt」的执行路径上**。它一行代码都不跑(全是 `type` 和 `interface`,编译后产物为空)。它是那条路径的**词汇表**。

但全景篇 §4 的 48 步生命周期里,几乎每一步都在读写这里定义的某个形状:

| 全景篇步骤 | 用到本文件的哪个形状 |
|---|---|
| 阶段 1 第 7 步 `createLoopConfig()` | §6 `AgentLoopConfig`(harness 把手伸进循环的全部十一个字段) |
| 阶段 1 第 8 步 `createStreamFn()` | §2 `StreamFn`(**不在 config 里**,是 `runAgentLoop` 的第 6 参) |
| 阶段 2 第 10 步 建 `currentContext` | §11 `AgentContext` |
| 阶段 3 第 15 步 过 LLM 边界 | §8 `AgentMessage` → pi-ai `Message`,转换器签名在 §6 的 `convertToLlm` |
| 阶段 5 第 31–35 步 工具执行 | §4 全部六个形状 + §10 的 `AgentTool` / `AgentToolResult` |
| 阶段 6 第 38–39 步 轮末 | §5 `AgentLoopTurnUpdate` / `ShouldStopAfterTurnContext` |
| 全程 | §12 `AgentEvent` —— 订阅者(桌面端投影器、ACP 的 `session/update`)看到的十种事件 |

**谁调它 / 它调谁?** 它谁也不调 —— 它只被 import。上游只有两处:pi-ai(借十二个形状)与 typebox(借 `Static` / `TSchema`)。下游有九个文件(见本文 §6),其中最重的三个是 `agent-loop.ts`(唯一的实现者)、`harness/agent-harness.ts`(最主要的填写者)、`coding-agent/core/tools/types.ts`(工具层的对接点)。

**不存在会怎样?** 三个包会同时失去共同语言。全景篇 §0 讲的三条边界 —— 「`ai` 不知道有 agent」「`agent` 不知道有 read/write/gdb」「`coding-agent` 不知道 provider 长什么样」—— 就是靠这个文件维持的:`agent` 眼里的工具只有 `AgentTool` 这个接口和 `execute()` 这个回调,再没别的。

还有一条**贯穿全文的设计**必须先记住,否则读到一半会觉得这些注释很啰嗦:**失败是数据不是异常**(全景篇 §3 第一组)。`StreamFn` 与 `AgentLoopConfig` 里几乎每个回调都写着 must-not-throw,原因很物理 —— `agentLoop()` 里是 `void runAgentLoop(...).then(...)`,**没有 `.catch`**;任何回调一抛,得到的是一个未处理的 Promise rejection 加一个永远不 `end()` 的 EventStream,`await stream.result()` 直接挂死(全景篇 §6.1 第一条)。这些契约**没有任何类型系统的保障**,只是写在注释里的约定。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| (文件头) | L1–L41 | 块注释:职责、全景位置、must-not-throw 的物理原因、分节索引 |
| §1 | L42–L72 | 导入 —— 从 pi-ai 借来的十二个形状,加 typebox 的 `Static` / `TSchema` |
| §2 | L73–L100 | `StreamFn` —— 循环与 provider 之间唯一的插槽 |
| §3 | L101–L135 | 两个模式开关 —— `ToolExecutionMode` / `QueueMode` |
| §4 | L136–L244 | 工具钩子的入参与出参 —— `AgentToolCall`、`Before-/AfterToolCallResult`、`Before-/AfterToolCallContext` |
| §5 | L245–L298 | 轮末钩子的入参与出参 —— `ShouldStopAfterTurnContext` / `AgentLoopTurnUpdate` / `PrepareNextTurnContext` |
| §6 | L299–L518 | `AgentLoopConfig` —— 裸循环的全部可注入面(全文件最长的一节) |
| §7 | L519–L536 | `ThinkingLevel` —— 含 `off` 的七档 |
| §8 | L537–L575 | `CustomAgentMessages` / `AgentMessage` —— 声明合并撑开的消息联合 |
| §9 | L576–L631 | `AgentState` —— 长命状态(Agent 类持有,harness 不实现) |
| §10 | L632–L744 | 工具契约 —— `AgentToolResult` / `AgentToolUpdateCallback` / `AgentTool` |
| §11 | L745–L772 | `AgentContext` —— 一次运行的输入快照 |
| §12 | L773–L836 | `AgentEvent` —— 十种事件,run / turn / message / tool 四级节奏 |

---

## 4. 逐节讲解

### §1 导入:从 pi-ai 借来的形状(L42–L72)

`L53–L66`

```ts
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
```

十二个形状,分三类:

1. **消息与内容块**:`Message`(= `UserMessage | AssistantMessage | ToolResultMessage`)、`AssistantMessage`、`ToolResultMessage`、`TextContent`、`ImageContent`。注意联合里的 `UserMessage` 没有被单独借来 —— 本文件从来不单独提用户消息。
2. **请求的输入与流式输出协议**:`Context`(pi-ai 那个只有三个字段的请求输入)、`Model`、`Api`、`SimpleStreamOptions`、`AssistantMessageEvent`、`AssistantMessageEventStream`。
3. **工具的最小形状**:`Tool`,只有 `name` / `description` / `parameters` 三个字段 —— §10 的 `AgentTool` 就是在它上面加四个字段。

两个值得停一下的细节:

- **全部是 `import type`,一个值都不导入。** 这保证本文件编译后是空的,不给包根入口(浏览器安全的 `index.ts`)引入任何副作用或体积。
- **反方向一个也没有。** pi-ai 不 import 本包的任何东西。这条单向依赖就是「`ai` 不知道有 agent」这条边界的物理形式。

`L71`

```ts
import type { Static, TSchema } from "typebox";
```

`TSchema` 是「一份 JSON Schema」的类型,`Static<T>` 把它反解成对应的 TS 类型。§10 的 `AgentTool` 靠这一对做到「schema 写一次,`execute` 的 `params` 类型自动跟着走」。typebox 是本包 `package.json` 里的**直接依赖**,不是从 pi-ai 转手拿的 —— 两个包各自 import 同一个版本,版本对不上时 `TSchema` 会名义不兼容,typecheck 直接变红。

### §2 StreamFn:循环与 provider 之间唯一的插槽(L73–L100)

`L95–L99`

```ts
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

它是 `runAgentLoop(prompts, context, config, emit, signal, streamFn)` 的**第 6 个参数**,刻意不放进 `AgentLoopConfig`。分界线是:`streamFn` 管「怎么跟模型说话」,`config` 管「循环怎么跑」。

两个填写者:

- **harness 的 `createStreamFn`** —— 在这里插入三个 provider 钩子(`before_provider_request` 可以补 streamOptions、`before_provider_payload` 能换整个请求体、`after_provider_response` 拿到 status 与 headers)。因为要 `await` 钩子,它是 `async` 的。
- **`Agent` 类** —— 直接把 `models.streamSimple` 塞进来。

签名与 pi-ai 的 `StreamFunction<Api, SimpleStreamOptions>` 只差一处:**允许返回 `Promise<流>`**。pi-ai 的 `streamSimple` 是同步返回流的(异步 setup 被 `lazyStream` 藏在流后面),所以天然满足;harness 那个必须先 await 钩子的实现只能返回 Promise。循环侧统一用 `await streamFunction(...)` 吃下两种。

JSDoc 里那段契约是整个文件的定调:

```
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
```

不传 `streamFn` 时会落到 `agent-loop.ts` 的 `noStreamFnConfigured`,那是全文件唯一一处刻意**同步 throw** 的实现 —— 因为「忘了接模型」是装配错误,不是运行时失败,不该被编码成一条 `stopReason: "error"` 的消息混进 transcript 与会话文件。

### §3 两个模式开关(L101–L135)

`L121`

```ts
export type ToolExecutionMode = "sequential" | "parallel";
```

它有两个落点,语义不同:

1. `AgentLoopConfig.toolExecution`(§6)—— 整个 run 的默认模式;
2. `AgentTool.executionMode`(§10)—— 单个工具自己的声明。

合流规则在 `agent-loop.ts:executeToolCalls`:这一批 toolCall 里**只要有一个**工具声明了 `"sequential"`,整批(包括同批的 read / bash)就退成串行。三个推论:

- 它是**批级传染**的;
- 它**只能单向升级** —— 把某个工具标成 `"parallel"` 并不能把 config 的 sequential 拉回并行;
- 「不表态」(`undefined`)不等于 `"parallel"`,不表态的工具会被别人拖去串行。

这是嵌入式工具防止两条 gdb / flash 同时抢探针、文件工具防止并发覆盖的**唯一手段**。本仓有四个工具声明了 sequential:`write` / `edit` / `gdb` / `log`。

`L134`

```ts
export type QueueMode = "all" | "one-at-a-time";
```

它只被 `Agent` 类与 harness 用来决定「一次 drain 取几条」,**裸循环看不见它** —— 循环只调 `getSteeringMessages()` / `getFollowUpMessages()`,取多少条完全是实现方的事。两个队列各有各的模式,两边默认都是 `"one-at-a-time"`。

`"one-at-a-time"` 的产品意义:用户连打三句话时,agent 一个 turn 消化一句,中间还能被工具执行与 `prepareNextTurn` 打断;`"all"` 则会把三句一次性拼进同一次请求。

### §4 工具钩子的入参与出参(L136–L244)

这一节六个形状全部服务于两个钩子:`beforeToolCall`(执行前,可拦)与 `afterToolCall`(执行后,可改写),对应全景篇 §4 的第 32 步与第 35 步。harness 把它们翻译成 `emitHook("tool_call")` / `emitHook("tool_result")` 两个可被宿主订阅的钩子。

`L147`

```ts
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
```

它不是新类型,而是从 `AssistantMessage.content` 这个三元联合(`TextContent | ThinkingContent | ToolCall`)里 `Extract` 出 `type === "toolCall"` 的那一支,等价于 pi-ai 的 `ToolCall{id, name, arguments, thoughtSignature?}`。

用 `Extract` 而不是直接 `import` `ToolCall` 的好处:pi-ai 哪天往 assistant 内容块里加了新形状,这里自动跟着走,不会出现「本包认得的 toolCall 和 provider 发的不是同一个东西」。循环就是拿它当类型守卫从 `message.content` 里筛工具调用的。

`L161–L163`

```ts
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
```

钩子唯一能表达的意图就是「拦不拦」。两个字段都可选,于是 `undefined`、`{}`、`{block: false}` 三者**等价于放行**。

拦下时循环**不抛错也不跳过**这次调用,而是造一条 isError 的正常工具结果顶上,`reason` 成为结果文本(省略时用默认的 `"Tool execution was blocked"`)。这是「失败是数据」在工具层的兑现:transcript 里 toolCall 与 toolResult 永远配对,模型下一轮能读到理由并改口,而不是看到一个凭空消失的调用。

`L185–L198`

```ts
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}
```

这是执行完之后的**部分覆盖补丁**,四个字段各自独立。合并写在 `agent-loop.ts:finalizeExecutedToolCall`,用的是 `补丁字段 ?? 原值`:

- 省略字段 = 保留工具原本的值;
- 给了字段 = **整个替换**,`content` 与 `details` 都没有深合并;
- 给 `details: null` 会因为 `??` 落回原值 —— 想清空得给一个空对象。

还有一个刻意**不在**这个类型里的字段:`addedToolNames`(§10)。合并用的是 `{ ...result, ... }`,所以工具自己声明的 `addedToolNames` 一定被保留,钩子改不掉。

`terminate` 那一条见本文 §5 第 2 条 —— 它与全景篇的记载有出入,以代码为准。

`L203–L220` `BeforeToolCallContext` 的四个字段全是**活引用**而不是快照。两个最容易伤到自己的地方:

- `args` 是 `validateToolArguments` 校验并 `Value.Convert` 强转**之后**的对象本体。就地改它会真的改掉传给 `execute` 的参数,而且**不会重新校验**(`agent-loop.test.ts` 的 `"should execute mutated beforeToolCall args without revalidation"` 专门钉住了这个行为)。要挡就返回 `{block: true}`。
- `context` 是 loop 正在就地修改的那个 `AgentContext`,不是拷贝:此刻 `messages` 里已经有本轮的 assistant 消息,但还没有任何 toolResult。

`L227–L243` `AfterToolCallContext` 比 Before 多两个字段:`result`(已执行出的结果)与 `isError`。

`isError` 只有两个来源:工具 `throw` 被 catch 成错误结果时为 `true`,正常返回时为 `false`。所以工具**不该**把错误编进 `content` 再正常返回 —— 那样 `isError` 是 `false`,前端会画成成功卡片,这个钩子也拿不到「失败」这个信号。

`result` 是覆盖生效**之前**的那份:钩子看到的是「工具说了什么」,订阅者看到的是「合并之后说了什么」,两者可以不同。

### §5 轮末钩子的入参与出参(L245–L298)

一个 turn(= 一条 assistant 消息 + 它那批工具调用与结果)跑完、`turn_end` 发出之后,循环连着问两个问题:

```
turn_end  →  prepareNextTurn(要不要换现场?) →  shouldStopAfterTurn(要不要收工?)
```

**次序不能反。** `shouldStopAfterTurn` 拿到的 `context` 是 `prepareNextTurn` 换过之后的那一份 —— 「该不该停」要看新上下文的大小,而不是旧的。见全景篇 §4 第 38–39 步。

`L256–L269`

```ts
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. ... */
	newMessages: AgentMessage[];
}
```

`newMessages` 是「本次 loop 调用最终会返回给调用方」的那个数组**本体**(不是拷贝),循环还在往里 push。两个入口的含义不同:

- `runAgentLoop` 从 `[...prompts]` 起步,所以**包含**本次的用户消息;
- `runAgentLoopContinue` 从 `[]` 起步,续跑之前就存在的上下文消息**一条都不在里面**。

宿主拿它做「这一轮新产生了什么」的依据时必须分清这两种。

`L280–L292`

```ts
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}
```

`prepareNextTurn` 的**返回**形状:三个字段全可选,给谁换谁,整个返回 `undefined` 表示什么都不动。循环把它应用到 `currentContext` 与 `config` 上,而且 `config` 是**浅拷贝一份**再改,不会污染调用方手里的那个对象。

这是「说话中途换模型 / 换档位 / 换上下文」**唯一真正生效的入口**。harness 的 `setModel` / `setThinkingLevel` 改的是配置字段而不是本轮的冻结快照,要到下一个 save point 由 `prepareNextTurn` 重建快照才被看见(全景篇 §3「turn 快照」)。桌面端的自动压缩也落在这里 —— 在 `prepareNextTurn` 里换上压缩后的 context,而不是在下一次请求里临时裁剪(临时裁剪是 `transformContext` 的活,它不持久)。

`thinkingLevel` 会被翻译成 `config.reasoning`,三分支:

| 值 | 效果 |
|---|---|
| `undefined` | 保持原样 |
| `"off"` | 把 `reasoning` 整个设成 `undefined` —— 等于把 reasoning 从请求选项里摘掉 |
| 其余六档 | 原样传下去 |

**`undefined ≠ "off"`** 是本文件最容易读错的一处三元。对 reasoning 模型来说,`"off"` 意味着最强的那一档被关掉,而且请求体里看不出任何痕迹 —— 这正是桌面端要额外做 `defaultThinkingLevel` 注入的原因(见仓库 CLAUDE.md「默认思考档位」)。

`L297`

```ts
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}
```

空 `extends` 的别名。单独起个名字只是为了让实现方的签名读起来对得上钩子名;改其中一个钩子的入参时另一个自动跟着变 —— 这是有意的,两个钩子必须看到同一个现场,否则「先换再判」的次序就失去意义。

### §6 AgentLoopConfig:裸循环的全部可注入面(L299–L518)

本文件最重要的一个形状:`runAgentLoop` 的第 3 个参数,循环所有「不由自己决定」的行为都从这里进来。

`L313–L317`

```ts
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;
```

`extends SimpleStreamOptions` 意味着它同时带着 pi-ai 的**流选项**:`temperature` / `maxTokens` / `signal` / `apiKey` / `reasoning` / `thinkingBudgets` / `onPayload` / `onResponse` / `cacheRetention` / `sessionId`。

一个容易忽略的后果:`agent-loop.ts:streamAssistantResponse` 是

```ts
const response = await streamFunction(config.model, llmContext, {
	...config,
	apiKey: resolvedApiKey,
	signal,
});
```

**整个 config 原样摊进流选项**,`convertToLlm` / `prepareNextTurn` 这些回调也一并被交给了 provider。provider 只读自己认识的字段所以无害,但在 `onPayload` 钩子里看到它们不要惊讶。

十一个自有字段里**只有 `model` 与 `convertToLlm` 必填**。harness 的 `createLoopConfig` 填了其中九个:`model` / `reasoning` / `convertToLlm` / `transformContext` / `beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages`;**没填** `toolExecution` / `shouldStopAfterTurn` / `getApiKey`。

`L352`

```ts
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
```

**整个内核唯一的 LLM 边界**(全景篇读图要点 2):`AgentMessage[]`(可以含自定义角色)→ pi-ai `Message[]`(只有 user / assistant / toolResult 三种角色)。本仓唯一的实现是 `harness/messages.ts:convertToLlm`,四个自定义角色在那里被投影成 user 消息或直接丢弃。

它必填,因为循环无法猜测「一个自定义角色该怎么变成模型看得懂的东西」;只有原生三种消息的调用方也得写一个恒等函数(测试里就是这么干的)。返回值只喂给本次请求,**不写回 `context.messages`** —— 转换是纯投影。

`L380`

```ts
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
```

与 `convertToLlm` 的分工:前者在 `AgentMessage` 层面动(裁剪、注入),后者只做降维。顺序是 `transformContext` → `convertToLlm`。

**它的返回值同样不写回 `context.messages`**,所以拿它做上下文压缩等于「每一轮重算一遍」;想让裁剪持久生效必须走 `prepareNextTurn`(§5)。harness 把它接到 `emitHook("context")` 上,hook 没返回时原样返回入参。

它是本节唯一收 `signal` 的非工具类回调 —— 因为它可能要跑一次真实的模型调用。

`L396`

```ts
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
```

与继承来的 `apiKey` 是「动态优先于静态」的关系。循环里是 `(await getApiKey(provider)) || config.apiKey` —— 用的是 `||` 而不是 `??`,所以返回空字符串也会落回静态 `apiKey`。

本仓两个宿主都没填它:桌面端与 ACP 的凭据由 pi-ai 注册表在 `resolveProviderAuth` 里解析,根本不走这条路。它是给 OAuth 短时令牌留的口子 —— 长工具阶段可能把一小时前拿到的 token 熬过期,而 `Context` 是每轮现拼的,正好每轮问一次。

`L414`

```ts
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
```

**本仓没有任何生产者**:harness 不填,`Agent` 类也不填,全仓唯一的引用就是循环里那一次调用。它是留给宿主做「优雅收工」的口子(例如上下文快满了就停在这一轮),而桌面端选择了另一条路 —— 在 `prepareNextTurn` 里压缩而不是停下来,于是用户看不到「被系统叫停」这种体验。

语义要点:返回 `true` 时循环 emit `agent_end` 就 return,**两个队列都不拉** —— 已经排队的 steering / follow-up 消息会留在队列里等下一次 prompt。

`L427–L429`

```ts
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
```

harness 所谓 save point 的一半:flush 挂起写入 → `createTurnState()` 重建冻结快照 → `setTurnState()` 更新闭包 → 把新的 context / model / thinkingLevel 交还给循环。它比 `shouldStopAfterTurn` 先跑,次序的理由见 §5。

返回类型允许同步值也允许 Promise,`shouldStopAfterTurn` 也是如此 —— 循环两处都写了 `await`,同步实现不会多花一个微任务以外的代价。

`L449` 与 `L466`

```ts
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
```

两个队列签名完全一样,差别只有一处:**被拉取的时机**。

| | 拉取点 | 效果 |
|---|---|---|
| steering(插话) | run 开局一次;每个 `turn_end` 之后(过了 `prepareNextTurn` 与 `shouldStopAfterTurn`)再一次 | 消息在下一次请求前进入 transcript,**当前这轮的工具照常执行、不被跳过** |
| follow-up(续摊) | 内层 while 已经退出、agent 本来就要停的那一刻,一次 | 有货就 `continue` 回外层,`hasMoreToolCalls` 重置为 true,于是又是一轮完整的 turn |

一句话:**steering 是插队,follow-up 是续摊。** 因为 follow-up 在「本来要停」的那一刻才被问,一条 follow-up 消息永远不会打断正在执行的工具批次 —— 这正是它与 steering 分成两个队列的全部理由。

返回 `[]` 是「没有」的正确表达方式;抛错没有兜底。

`L484`

```ts
	toolExecution?: ToolExecutionMode;
```

注意 JSDoc 里那句 `Default: "parallel"` 是**由缺省实现的**,不是由默认值实现的:循环里只检查 `config.toolExecution === "sequential"`,任何别的值(含 `undefined`)都落到并行分支。`Agent` 类另外写了 `options.toolExecution ?? "parallel"` 把它显式化,harness 干脆不填 —— 三处写法不同,行为一致。

并行模式下有两条同时存在的顺序,别混:`tool_execution_end` 按**完成序**发,工具结果消息按**源序**发。详见 §12 末尾。

`L498` 与 `L516`

```ts
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
```

两个钩子都收第二个参数 `signal`,而且注释明确写着「钩子自己负责响应它」—— 循环不会替钩子做超时。不过循环在 `beforeToolCall` 返回之后**会**再查一次 `signal.aborted`,命中就把这次调用变成一条 `"Operation aborted"` 的错误结果。

准备阶段的完整顺序是:`prepareArguments` → `validateToolArguments` → `beforeToolCall`。所以钩子拿到的是**校验后**的 args,它挡不住「schema 都过不了」的调用 —— 那种在更早的一步就已经被翻成错误结果了。

`afterToolCall` 有一条独特性质:**它是本文件唯一一个抛错会被吞掉的回调**。循环把它包在 try/catch 里,抛出的异常被翻译成一条 isError 的工具结果 —— 也就是说钩子炸了会把工具的真实结果整个换成错误文本(工具白跑了,而且没人知道是钩子的锅)。其余回调抛错则没有任何兜底。

### §7 ThinkingLevel:含 off 的七档(L519–L536)

`L535`

```ts
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

**这里有两个同名类型,必须分清:**

| 类型 | 定义处 | 档位 |
|---|---|---|
| `ThinkingLevel` | `packages/ai/src/types.ts` | 六档,**不含 off** |
| `ModelThinkingLevel` | `packages/ai/src/types.ts` | 七档 = `"off" \| ThinkingLevel` |
| `ThinkingLevel`(本文件) | `packages/agent/src/types.ts` | 七档,**含 off**,逐字等于上面那个 `ModelThinkingLevel` |

但本文件是**手抄一份**而不是 re-export(§1 的 import 列表里没有它),所以上游哪天加一档,这里不会自动跟上,只会在赋值处才炸。

落地路径:`AgentState.thinkingLevel`(§9)与 `AgentLoopTurnUpdate.thinkingLevel`(§5)用这个七档类型;进 `AgentLoopConfig.reasoning`(继承自 `SimpleStreamOptions`,六档)时由循环负责把 `"off"` 翻译成 `undefined`。

桌面端还有**第三份**同解实现(`packages/kernel/src/thinking.ts`),因为 renderer 只拿得到 `ModelInfo.thinkingLevels` 这个字符串数组而不是 `Model` 对象。三份必须同解 —— 漂移的后果是「档位在 UI 里能选但发不出去」。

### §8 CustomAgentMessages / AgentMessage(L537–L575)

`L562–L564` 与 `L574`

```ts
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

这是全文件唯一一个「空着就是为了被别人填」的形状。TypeScript 的 `declare module` 会把外部声明的字段合并进这个 interface,于是 `AgentMessage` 这个联合类型**全局变宽** —— 应用不需要给自定义消息包一层 wrapper 就能与 pi-ai 的原生消息同列在一个数组里。

`CustomAgentMessages[keyof CustomAgentMessages]` 是「取这个 interface 全部值类型的联合」。一个都没注册时 `keyof` 是 `never`、索引结果也是 `never`,联合退化成纯 pi-ai 的 `Message` —— 所以空 interface 是无害的,不会把 `AgentMessage` 变成 `unknown`。

本仓唯一的注册点是 `harness/messages.ts` 的 `declare module "../types.ts"`,塞进四个角色:

| role | 干什么 | 到 LLM 边界怎么处理 |
|---|---|---|
| `bashExecution` | 用户自己在终端跑的命令与输出 | 渲染成 markdown 代码块包成 user 消息;`excludeFromContext` 为真则直接丢弃 |
| `custom` | 应用自定义的任意消息 | 包成 user 消息(**`display` 字段被忽略**) |
| `branchSummary` | 从某条分支回来时的摘要 | 拼上 PREFIX/SUFFIX 变 user 消息 |
| `compactionSummary` | 压缩摘要 | 同上 |

两个代价必须记住:

1. 任何拿 `AgentMessage` 做 `switch` 的地方都必须有 `default` 分支 —— 联合的成员取决于编译单元,穷举检查在这里不可靠;
2. **只 import 类型也会触发合并**,于是「`AgentMessage` 到底有哪几个 role」取决于哪些模块被编译进来。`messages.ts` 因此是一个有编译期副作用的类型模块。

### §9 AgentState:长命状态(L576–L631)

`L594–L611`(节选)

```ts
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
```

它与 §11 的 `AgentContext` 是一对**极容易混**的兄弟,寿命完全不同:

| | `AgentContext`(§11) | `AgentState`(本节) |
|---|---|---|
| 寿命 | 一次运行的输入快照,跑完就扔 | 长命,跨多次 prompt |
| 字段 | 只有 systemPrompt / messages / tools | 多了 isStreaming / streamingMessage / pendingToolCalls / errorMessage |
| 谁改它 | 被循环**就地修改** | 靠事件把变化折算回来 |

开跑时从 State 复制出 Context,跑的过程中靠事件把变化折算回 State ——**两边不是同一个数组,这是刻意的**:循环把流式半成品 push 进 Context 时,State 那份不该跟着抖。

`tools` 与 `messages` 用 set/get 访问器而不是普通属性,是为了在**类型上声明**「赋值时会拷贝」。实现里 setter 是 `tools = nextTools.slice()`。拷的只是顶层数组,元素还是同一批对象引用 —— 改 `tools[0].description` 依然穿透。少了这层拷贝的后果:调用方手上那个数组之后再 push,会静默改掉 agent 的工具集,而且改的时机完全不受控。

`L621` 的 `isStreaming` 有一条不直观的时序:它要等 `agent_end` 的**订阅者**都 settle 之后才变 false。理由是订阅者可能还在写盘(harness 的 `flushPendingSessionWrites` 就挂在 `agent_end` 上),这时候对外说「空闲了」会让宿主立刻发下一个 prompt,撞上还没写完的会话文件。

**最后一个必须知道的事实:harness 不实现这个接口。** 本仓唯一的实现是 `agent.ts` 的 `createMutableAgentState`,而 `Agent` 类在本仓**没有生产调用方**。也就是说桌面端与 ACP 跑的路径上,`AgentState` 一次都不会被构造出来 —— 它是给「裸 loop 该怎么被有状态地包起来」当参考实现的。

### §10 工具契约(L632–L744)

这三个形状是 `agent` 与 `coding-agent` 之间那条边界的**全部内容**。

`L638–L674`(节选)

```ts
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/** Names of tools introduced by this result and available from this transcript point onward. */
	addedToolNames?: string[];
	terminate?: boolean;
}
```

**`content` 与 `details` 的分工是这个类型的全部要点:**

- `content` —— **回给模型**看的(text 与 image 两种块;`ToolResultMessage` 允许图片,datasheet 的看图工具靠这条把图直接塞进上下文);
- `details` —— **给日志与 UI**的结构化数据,不进模型上下文,桌面端与 Zed 的工具卡片全靠它。

两者不要互相塞:`content` 里堆 JSON 等于花 token 讲给人听,`details` 里放长文本等于模型永远看不到。注意 `details` 是**必填**的(泛型 `T` 没有默认值),没有结构化数据的工具也要给一个 `{}`。

`addedToolNames` 是 pi-ai 的「延迟工具」(deferred tools)机制:一条工具结果可以宣布「从这个 transcript 位置之后,这几个工具才算可用」,pi-ai 的 `splitDeferredTools` 据此把 `Context.tools` 切成立即可见与延迟加载两半。循环只做搬运:非空时才写进 `ToolResultMessage`(空数组与 `undefined` 一样被忽略),而且 `afterToolCall` 的补丁改不到它。**本仓的工具目前一个都没有用这个字段。**

`terminate` 的判定是**全票通过**:

```ts
finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true)
```

必须整批每一个都为 `true`,只要有一个工具没表态(`undefined`)循环就照常继续。这是刻意的:模型常在一条消息里既调 `exit_plan_mode` 又调别的工具,少数派不该替多数派叫停。顺带一个推论 —— 内核造的错误结果(工具不存在、校验失败、被 block、abort、length 截断)都不带 `terminate`,所以一批里只要有一个失败,这批就一定不会终止,循环必然再跑一轮让模型自己收拾。

**注意 `exit_plan_mode` 是上游 pi 的例子,不是本仓的工具。** 实测本仓 `coding-agent` 的工具**一个都没有**填过 `terminate`,所以现在这个字段的唯一可能来源是宿主在 `afterToolCall` 里补 —— 而本仓的 harness 只是把 `tool_result` hook 的返回值透传,宿主也没人补。也就是说**在本仓 `terminate` 恒为 undefined,一批工具永远不会提前终止**。它是留着的机制,不是现役行为。

`L689`

```ts
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;
```

`onUpdate` 的作用域被钉死在**本次 `execute` 调用**上:循环用一个 `acceptingUpdates` 布尔守着,工具的 promise 一 settle 就置 false,之后再调这个回调静默无效 —— 挡的是「工具留了个定时器、跑完还在推进度」这种把 UI 卡片写坏的情况。

推出去的 `partialResult` 只用来 emit `tool_execution_update` 事件喂 UI,**不进 transcript、不进会话文件**,模型永远看不到它。循环还会把这些 emit 的 Promise 收集起来一并 `await`,保证「进度事件全部送达」早于「这个工具的最终结果」—— 否则 UI 会先收到完成、再收到迟到的进度。

`L699–L743`(节选)

```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	executionMode?: ToolExecutionMode;
}
```

它在 pi-ai `Tool` 的 `{name, description, parameters}` 上加四个字段。两个泛型槽:`TParameters` 是 typebox schema,`TDetails` 是 `details` 的形状(默认 `any`;coding-agent 每个工具都钉死自己的 `*ToolDetails`,桌面端再结构化复制一份用来画工具卡片,漂移由 `kernel/src/host/details-check.ts` 的编译期断言兜住)。

逐字段:

- **`label`** —— 必填,但**全仓没有任何一处读它**(见本文 §5 第 3 条)。
- **`prepareArguments`** —— schema 校验**之前**唯一的入参整形钩子,专治「模型把参数写成另一种合法形状」。本仓唯一使用者是 `edit` 工具:把 JSON 字符串形式的 `edits` 解析回数组、把旧的单条 `oldText`/`newText` 折进数组。循环用**引用相等**判断它有没有真的改动 —— 原样返回入参时连 toolCall 对象都不重建,省掉一次拷贝。它是同步的、而且**跑在 try 里**:抛错会被翻成一条 isError 的工具结果。
- **`execute`** —— 契约里最容易违反的一条:**失败要 `throw`,不要把错误编进 `content`**。循环会 catch 住并造一条 isError 的结果;自己返回一个「看起来像错误」的正常结果会让 `isError` 为 false,前端画成成功卡片,宿主的自动重试逻辑也不认。工具不响应 `signal` 的后果是:abort 之后这一批工具还会跑完 —— 循环只在两次工具之间检查 signal,不会打断正在跑的那个。`toolCallId` 传进来是给工具做「一次调用一个资源」的键用的(log / gdb 的会话表)。
- **`executionMode`** —— 省略等于**不表态**,而不是等于 `"parallel"`,见 §3。

顺带一个容易忽略的事实:循环把 `AgentTool[]` **原样**放进 pi-ai 的 `Context.tools` —— `label` / `execute` / `prepareArguments` / `executionMode` 这些多出来的字段会跟着进 `Context`,只是 provider 只读 `name` / `description` / `parameters`,不会被发到网络上。

### §11 AgentContext:一次运行的输入快照(L745–L772)

`L756–L771`

```ts
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}
```

三个字段,小到可以背下来 —— 但它有一条**不写在类型里**的性质:**循环会就地修改它**。流式 assistant 消息、每条工具结果、每条插话消息都被 push 进 `context.messages`。所以调用方传进来的对象跑完之后不是原样,而是长出了这一轮的全部消息。

而且两个入口的所有权语义**不对称**:

| 入口 | 怎么建 currentContext | 后果 |
|---|---|---|
| `runAgentLoop` | `{ ...context, messages: [...context.messages, ...prompts] }` | 新数组,调用方的数组不受影响 |
| `runAgentLoopContinue` | `{ ...context }` | **messages 数组没有复制**,循环直接往调用方的数组里 push |

实践中安全只是因为 harness 与 `Agent` 都提前 slice 了一份。

与 pi-ai 的 `Context` 的区别只有两处:`messages` 装的是 `AgentMessage`(可以有自定义角色),`systemPrompt` 是**必填**而不是可选。

`tools` 可选,而且循环是按**名字**在这个数组里线性查找的。名字重复时先出现的那个胜出,循环本身不查重 —— 查重发生在 harness 的 `validateToolNames` 里,直接用裸 loop 的调用方要自己保证。数组为空或 `undefined` 时,模型发来的任何 toolCall 都会得到 `"Tool xxx not found"` 的错误结果,而不是抛异常 —— 又一次「失败是数据」。

### §12 AgentEvent:十种事件(L773–L836)

`L792–L836`

```ts
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

严格对应 run / turn / message / tool **四级节奏**(全景篇 §3 第二组):

```
agent_start ─┬─ turn_start ─┬─ message_start / message_update* / message_end   (assistant 流式)
             │              ├─ tool_execution_start / _update* / _end          (每个工具一组)
             │              ├─ message_start / message_end                     (每条工具结果)
             │              └─ turn_end{message, toolResults}
             │  (可能有多个 turn)
             └─ agent_end{messages}
```

**十种,不是十一种**(全景篇 §6.0 专门修正过这个口径)。harness 自有的那批事件(`save_point` / `settled` / `model_update` / …)定义在 `harness/types.ts` 的 `AgentHarnessOwnEvent` 里,`subscribe()` 听到的 `AgentHarnessEvent` 是两者的并集。

循环发事件用的是 `await emit(event)`:**每一个事件都被 await**。两个后果:订阅者慢会把整个循环拖慢;订阅者抛错会把循环打断。这正是 harness 在 `turn_end` 那里要把订阅者的异常**暂存**、先 flush 挂起写入再抛的原因(全景篇 §4 第 37 步)。

逐条要点:

- **`agent_end` 是这个流的终结事件。** `createAgentStream` 把 `isComplete` 钉在 `"agent_end"` 上、把 `extractResult` 钉在它的 `messages` 上。于是:(1) `agent_end` 一被推入,EventStream 就 done,之后再 push 的事件全部静默消失;(2) 循环必须保证任何路径上都发得出 `agent_end`(错误早退、`shouldStopAfterTurn` 提前收工、正常结束三条路各发一次),否则 `await stream.result()` 会**永久 pending** —— 不是 reject,是挂死。
- **`turn_end.message` 的类型比现实宽。** 声明是 `AgentMessage`,但循环实际发出去的**永远是一条 `AssistantMessage`**。消费方想取 `stopReason` 或 `usage` 时必须自己收窄。`message_start` / `message_end` 则是真的三种消息都会发。
- **`message_update` 是唯一带 `assistantMessageEvent` 的事件。** 除了「现在的消息长什么样」,还把 pi-ai 那条原始 delta 事件原样透出来。桌面端投影器靠这两者的分工做到「快照始终从 `partial.content` 重算、delta 只是叠在上面的增量」。注意 `message` 是 `{ ...partialMessage }` 的**浅拷贝**:顶层字段是新的,`content` 数组仍是同一个引用,而 pi-ai 的 `partial` 是一路被就地改写的同一个对象 —— 想留快照必须自己深拷。还有一个坑:循环所有 delta 分支都在 `if (partialMessage)` 里,某个 provider 的流若没发 `start` 就开始发 delta,**一条 `message_update` 都不会产生**,UI 表现为一直转圈直到最后一次性出全文。
- **`tool_execution_start` 一定会发**,即使这次调用最终没有真的执行 —— 工具不存在、参数校验失败、被 `beforeToolCall` 拦下、`stopReason === "length"` 截断,四种情况都是先发 start 再发一条 isError 的 end,UI 卡片的形状因此永远一致。
- **并行模式下两条顺序是分开的。** 每个工具跑完就地 emit `tool_execution_end`(**完成序**),而工具结果的 `message_start` / `message_end` 那一对要等 `Promise.all` 全部落定之后,才按 assistant 消息里 toolCall 块的原始顺序逐条发出(**源序**)。UI 因此能第一时间画出已完成的卡片,而 transcript 的顺序仍然是 provider 要求的那个。串行模式下两者一致。

---

## 5. 会咬人的地方

1. **`terminate` 的合并方向,全景篇记反了(L197)。** 【与全景篇不符】全景篇 §4 第 35 步写「`terminate` 用 `??` 合并所以只能补 undefined 不能抹 true」。实际代码是 `terminate: afterResult.terminate ?? result.terminate` —— **判空的是补丁侧**,所以 `afterToolCall` 返回 `{terminate: false}` 会把工具原本的 `true` 抹掉。以代码为准。本文件 L185–L198 的原 JSDoc 写的是 "if provided, replaces the early-termination hint",与代码一致。

2. **`shouldStopAfterTurn`(L414)在本仓没有任何生产者。** harness 的 `createLoopConfig` 不填、`Agent` 类也不填,全仓唯一引用是循环里那次调用。同理 `getApiKey`(L396)、`toolExecution`(L484)也没有生产者。读代码时不要照着它们去找「桌面端是怎么用的」——答案是不用。

3. **`AgentTool.label`(L705)是必填的写-only 字段。** 全仓没有任何一处读它:桌面端与 ACP 的工具卡片用的是 `ToolResultMessage.toolName`;`.label` 的其他命中全是无关的东西(会话标签、探针持有者标签、log 采集标签)。它是上游 pi 的 TUI 渲染留下来的,my-pi 没有 TUI。

4. **`AfterToolCallResult.details`(L187)清不掉。** 类型是 `unknown`,而合并用的是 `??`,所以 `details: null` 会落回原值。要清空只能给一个空对象。`content`(L186)同理。

5. **三个 `tool_execution_*` 事件的载荷是 `any`(L829 / L830 / L836)。** `args` / `partialResult` / `result` 全部无类型。这是本文件类型最松的一处,订阅者拿不到任何编译期保证 —— 桌面端因此另在 `kernel/src/host/details-check.ts` 用约束式断言兜了一道工具 `details` 的漂移。

6. **`turn_end.message`(L807)的类型比现实宽。** 声明 `AgentMessage`,实际永远是 `AssistantMessage`。想读 `stopReason` 得自己收窄,而 `AgentMessage` 的成员数还取决于哪些模块被编译进来(§8)。

7. **`ShouldStopAfterTurnContext`(L256)与 `PrepareNextTurnContext`(L297)在全仓没有一处按名字引用。** 循环是就地用字面量构造它们的。它们的价值只是给实现方一个可 import 的名字 —— 改字段时 typecheck 抓不到「循环那边的字面量忘了同步」,因为字面量是**赋给可选回调的参数位**、由回调签名反向约束的。

8. **`AgentLoopConfig.toolExecution` 的 "Default: parallel"(L484)是缺省而不是默认值。** 循环只判 `=== "sequential"`,写错成 `"Sequential"` 会静默走并行 —— 而并行抢探针的表现是 `0xe00002c5` 之类的硬件报错,归因极难。

9. **`ThinkingLevel`(L535)是三份手抄之一。** 本文件一份、pi-ai 的 `ModelThinkingLevel` 一份、`kernel/src/thinking.ts` 一份。它们必须同解,而类型系统只能保证前两份**长得一样**、保证不了**解释一样**。

10. **`AgentContext.messages`(L763)被循环就地修改,而两个入口的所有权语义不对称。** `runAgentLoopContinue` 用的是 `{ ...context }`,messages 数组**没有复制** —— 直接用裸 loop 的调用方要自己 slice。

11. **`AgentContext.tools`(L770)是线性按名查找,不查重。** 重名时先出现的胜出。查重在 harness 的 `validateToolNames` 里,裸 loop 没有。

12. **`BeforeToolCallContext.args`(L214)是校验后的对象本体,就地改不会重新校验。** `agent-loop.test.ts` 的 `"should execute mutated beforeToolCall args without revalidation"` 钉住了这个行为。要挡就返回 `{block: true}`。

13. **`addedToolNames`(L658)本仓零使用者。** 它是 pi-ai 的延迟工具机制,只有 anthropic-messages 与 openai-responses 两套协议实现会读它。本仓的工具一个都没填。

14. **整节的 must-not-throw 契约没有任何类型保障。** `StreamFn`(§2)与 `AgentLoopConfig` 里几乎每个回调都写着这条,但违反它的唯一后果是运行时挂死(`agentLoop()` 没有 `.catch`)。唯一例外是 `afterToolCall`(L516),它抛错会被吞成一条 isError 结果。

15. **`AgentToolResult.terminate`(L673)在本仓恒为 `undefined`。** `coding-agent` 全部工具零填写(全仓 `terminate` 的命中只有 `engines.ts` 里一个同名的私有函数),harness 也没有宿主在 `tool_result` hook 里补它。所以「一批工具全票通过就提前终止」这条逻辑目前**从来不会触发**。读 `agent-loop.ts` 时不要以为它是热路径。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/ai/src/types.ts`(经 `@earendil-works/pi-ai`) | 十二个形状,全部 `import type`;反方向零依赖 |
| 它 import | `typebox` | `TSchema` / `Static`,`AgentTool` 的泛型基础 |
| import 它 | `packages/agent/src/agent-loop.ts` | **唯一的实现者**:消费 `AgentContext` / `AgentEvent` / `AgentLoopConfig` / `AgentMessage` / `AgentTool` / `AgentToolCall` / `AgentToolResult` / `StreamFn` |
| import 它 | `packages/agent/src/agent.ts` | `AgentState` / `QueueMode` / 全部钩子类型;它还 re-export 了 `QueueMode` |
| import 它 | `packages/agent/src/harness/agent-harness.ts` | **最主要的填写者**:`createLoopConfig` 填九个字段,`createStreamFn` 造 `StreamFn` |
| import 它 | `packages/agent/src/harness/types.ts` | `AgentEvent` / `AgentMessage` / `AgentTool` / `QueueMode` / `ThinkingLevel`;`AgentHarnessEvent = AgentEvent ∪ AgentHarnessOwnEvent` |
| import 它 | `packages/agent/src/harness/messages.ts` | `declare module "../types.ts"` 往 `CustomAgentMessages` 注册四个角色 —— 唯一的**写**方向依赖 |
| import 它 | `packages/agent/src/harness/compaction/{compaction,branch-summarization,utils}.ts` | 只要 `AgentMessage` 与 `ThinkingLevel` |
| import 它 | `packages/agent/src/index.ts` | `export * from "./types.ts"`,整块转出包根 |
| import 它 | `packages/coding-agent/src/core/tools/types.ts` | `AgentTool` / `AgentToolResult` / `AgentToolUpdateCallback` / `ToolExecutionMode`;`wrapToolDefinition` 把 `ToolDefinition` 收窄成 `AgentTool` |

**同一目录的兄弟:** `agent-loop.ts`(744 行,契约的实现)、`agent.ts`(520 行,`AgentState` 的唯一实现,本仓无生产调用方)、`index.ts`(包根 barrel)、`node.ts`(Node 专用入口)。

**同名但不同的文件:** `packages/agent/src/harness/types.ts`(会话树与 harness 的契约)、`packages/ai/src/types.ts`(pi-ai 的契约层)、`packages/coding-agent/src/core/tools/types.ts`(工具定义层)。四个 `types.ts` 是四层不同的词汇表,别混。

---

## 7. 自测题

**Q1.** 把 `AgentToolResult.terminate` 的判定从「整批每一个都为 true」改成「有一个为 true 就算」,会发生什么?

<details><summary>答案</summary>

模型很常在一条 assistant 消息里既调 `exit_plan_mode`(它会返回 `terminate: true`)又调别的工具(read / bash / …)。改成「一票通过」之后,只要计划模式那个工具表态,整批就终止,循环不再发下一次请求 —— 结果是模型说了「我要退出计划模式,同时先读一下这个文件」,而读文件的结果**永远不会回到模型面前**,对话就停在那里。少数派替多数派叫停,正是现在这个 `every(...)` 要避免的。

另外还有一个副作用:内核造的错误结果(`createErrorToolResult`)不带 `terminate`,原本它天然让一批「不终止」;改成一票通过后,这层保护也没了 —— 一批里既有失败工具又有一个 terminate 工具时,失败结果没机会被模型重试。
</details>

**Q2.** 如果把 `AgentLoopConfig.convertToLlm` 改成可选、缺省时用恒等函数(直接把 `AgentMessage[]` 当 `Message[]` 交出去),会发生什么?

<details><summary>答案</summary>

typecheck 会先炸一次(`AgentMessage` 不是 `Message` 的子类型),但假设用 `as` 强行绕过 —— 运行时的后果是:四个自定义角色(`bashExecution` / `custom` / `branchSummary` / `compactionSummary`)会原样进入 `Context.messages`。pi-ai 的 `transformMessages` 按 `role` 分派,遇到不认识的 role 走不到任何分支,轻则被丢弃、重则在某个协议实现里抛出来 —— 而抛出来的位置在 provider 内部,`lazyStream` 的 `.catch` 会把它变成一条 `stopReason: "error"` 的消息,用户看到的是「模型报错了」,而真正的原因是消息投影没做。

这正是它必填的理由:**循环无法猜测一个自定义角色该怎么变成模型看得懂的东西**,与其给一个会在很远处炸的默认值,不如强制调用方写出来(哪怕写的是恒等函数)。
</details>

**Q3.** harness 从不填 `AgentLoopConfig.toolExecution`。如果给 `write` 工具把 `executionMode: "sequential"` 删掉,而其他三个(`edit` / `gdb` / `log`)保留,一条同时调 `write` × 2 的 assistant 消息会怎么跑?

<details><summary>答案</summary>

会**并行**跑。因为这一批里没有任何工具声明 sequential(只有这批里出现的工具才参与判定),`config.toolExecution` 又是 `undefined`,于是走 `executeToolCallsParallel`。

两个 write 并发写同一个文件时,`coding-agent` 还有第二道防线 —— `withFileMutationQueue` 按 canonical 路径上锁,所以同文件不会互相覆盖。但**不同文件**的两个 write 会真的并发,而且 `tool_execution_end` 按完成序发、工具结果消息按源序发,transcript 的顺序仍然正确。

真正危险的是探针类工具:`gdb` / `flash` 如果丢了 sequential 标记,两条命令会同时去抢同一块板子(仓库 CLAUDE.md 记着实测撞过 `0xe00002c5`)。所以「批级传染」这条规则的存在意义,就是让**一个**工具的声明能保护**整批**。
</details>

**Q4.** `AgentEvent` 里为什么 `message_update` 要额外带一个 `assistantMessageEvent`,只给 `message` 不够吗?

<details><summary>答案</summary>

不够,而且有两个层次的原因。

第一层:`message` 是 `{ ...partialMessage }` 的**浅拷贝**,而 pi-ai 的 `partial` 始终是同一个 `output` 对象的引用(全景篇 §3「partial 的引用语义」)。也就是说浅拷贝之后 `content` 数组仍然是同一个引用 —— 消费者拿到的连续两个 `message` 的 `content` 是同一个数组,无法从中反推「这一次到底新增了什么」。

第二层:哪怕做了深拷贝,「新消息减旧消息」这种做差也远不如直接拿 delta 可靠(text / thinking / toolcall 三类块的增量语义不同,toolcall 的 arguments 还是每次整体重解一遍覆盖的)。带上原始事件之后,消费者可以选择自己的策略 —— 桌面端投影器选的是「快照始终从 `partial.content` 重算、delta 只是叠在上面的增量」,于是「累积 delta 是快照的严格前缀」这条不变式天然成立。
</details>

**Q5.** 假设你在 `beforeToolCall` 里想把模型写错的路径 `/d/foo/bar.c` 改成 `D:/foo/bar.c`,于是直接 `context.args.path = "D:/foo/bar.c"`。这样做能生效吗?有什么风险?

<details><summary>答案</summary>

**能生效** —— `args` 是校验后的对象本体,循环随后就把它传给 `execute`,不会再拷贝一次。`agent-loop.test.ts` 的 `"should execute mutated beforeToolCall args without revalidation"` 正是钉住这个行为的。

风险有三个:

1. **不会重新校验。** 改成一个 schema 根本不允许的值(比如把 string 改成数字)也照跑,炸在工具内部,错误信息与真正的原因隔了好几层。
2. **模型看到的与实际执行的不一致。** transcript 里那条 assistant 消息的 `toolCall.arguments` 仍然是原始的 `/d/foo/bar.c`(改的是校验后的副本,不是 toolCall 块),`tool_execution_start` 事件带的 `args` 也是原始的 —— 于是 UI 显示的路径和真正读的文件不是同一个。
3. **本仓已经有更好的落点。** 路径归一化(含 MSYS `/d/foo` → `D:/foo`)在 `coding-agent/core/tools/path-utils.ts:resolveToCwd` 里做,那是工具自己的事;而「校验前整形参数」有专门的钩子 `AgentTool.prepareArguments`(§10),它在 `validateToolArguments` **之前**跑,改完还会被校验一遍。

结论:`beforeToolCall` 的设计意图是**拦不拦**,不是**改不改**。
</details>
