# packages/agent/src/harness/session/session.ts

> **档位** A(逐行) · **行数** 638(加注释后;原 351) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §1 分层图第 ③ / ⑫ 跳、§4 阶段 1 步骤 3a–3d、§4 阶段 7 步骤 47–48 · **索引** [README](../README.md)

## 1. 一句话

把「只追加、永不删改的会话树」翻译成「这一轮能发给模型的一串消息」,同时提供往树上追加条目、移动光标的全部写入口 —— 会话的**读侧投影**与**写侧门面**都在这一个文件里。

## 2. 它在全景里的位置

先把三个名词摆平,后面全篇都要用:

- **条目(entry)**:会话不是一个消息数组,而是一棵树。每个节点是一条条目,统一带 `{type, id, parentId, timestamp}`,共 11 种类型。换模型是一条条目,压缩是一条条目,打标签是一条条目 —— 一切皆条目,只追加。
- **leaf**:树上唯一的游标,指向「当前对话」的末端。当前对话 = 从 leaf 沿 `parentId` 一路走到根的那条路径,其余分支仍在文件里、只是不在这条路径上。
- **投影(projection)**:把这条路径上的条目「算」成一份能发给模型的 `AgentMessage[]`。算的过程可以隐去、重排、合成消息,但磁盘上的条目一个字节都不动。

这个文件在链路上出现**两次**。

**读侧**是全景篇 §4 阶段 1 的步骤 3。harness 每开一轮先调 `createTurnState()`(`agent-harness.ts:569`),它的第一件事就是 `session.buildContext()`:

- **3a** `getBranch()` → `storage.getLeafId()` → `storage.getPathToRoot(leafId)`,拿到 root→leaf 的条目数组;
- **3b** `deriveSessionContextState()` 扫**完整**路径,推导出 model / thinkingLevel / activeToolNames;
- **3c** `defaultContextEntryTransform()` 应用路径上最后一条 compaction,把旧历史从投影里隐去 —— 这是「压缩只改投影,不改历史」的唯一兑现处;
- **3d** `flatMap(sessionEntryToContextMessages)` 把条目映射成消息。

拿到的 `messages` 就是这一轮发给模型的全部历史。往下走,`convertToLlm`(`harness/messages.ts`)才把它变成 pi-ai 认得的 `Message[]`。

**写侧**是全景篇 §1 分层图的第 ⑫ 跳。轮内产生的每一条消息经由 harness 的挂起写入队列(`flushPendingSessionWrites`,`agent-harness.ts:822`)最终落到本文件的九个 `append*` 上;压缩成功后调 `appendCompaction`(步骤 47),下一次 `buildContext()` 时那条新 compaction 就把摘要之前的历史从投影里隐去(步骤 48)。分支/回退则走 `moveTo()`(`navigateTree` 的落点)。

**它不存在会怎样**:harness 拿不到历史,每一轮都只能发当前这一句话;压缩会彻底失效(条目照样落盘,上下文却一点都不会变短);会话树的 `parentId` 没人负责填,树退化成一堆孤立条目。

**它自己不碰文件系统**。读写全部委托给 `SessionStorage` 接口,所以同一套树语义在内存实现(`memory-storage.ts`)和 JSONL 实现(`jsonl-storage.ts`)上完全一致 —— `test/harness/session.test.ts` 就是同一份用例参数化跑两遍存储。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L66 | 文件头(原作者的 7 行 + 新增总述块)与导入 |
| §2 | L67–L96 | 投影的三个可扩展点:`ContextEntryTransform` / `CustomEntryContextMessageProjector` / `SessionContextBuildOptions` |
| §3 | L97–L141 | 遍 1:`deriveSessionContextState` —— 扫完整路径推导配置状态 |
| §4 | L142–L193 | 遍 2 第一步:`defaultContextEntryTransform` —— 压缩投影 |
| §5 | L194–L216 | 遍 2 第二步:`buildContextEntries` —— 默认变换 + 应用层变换链 |
| §6 | L217–L276 | 遍 2 第三步:`sessionEntryToContextMessages` —— 条目 → 消息 |
| §7 | L277–L298 | `buildSessionContext` —— 两遍合流 |
| §8 | L299–L363 | `Session` 类:字段、构造、只读读取与 `getBranch` |
| §9 | L364–L395 | 实例侧上下文构建与选项合并 |
| §10 | L396–L415 | 标签与会话名 |
| §11 | L416–L593 | 追加即前进:`appendTypedEntry` 与九个 `append*` |
| §12 | L594–L638 | `moveTo` —— 移动 leaf 与分支摘要 |

## 4. 逐节讲解

### §1 文件头与导入(L1–L66)

L1–L7 是原作者留下的文件头,一句话总结了这个文件的全部智力:**两遍独立扫描**,并且「压缩改的是投影,不是历史」。L8–L41 是本次补的总述块(职责 / 链路位置 / 分节索引)。

L46–L65 的导入里,**值导入只有四个**:`messages.ts` 的三个合成消息构造器,加一个 `SessionError`。其余全是 `import type`。这说明这个文件对「消息内部长什么样」几乎无知,它只负责在正确的位置调用正确的构造器 —— 消息的形状是 `harness/messages.ts` 的事。

### §2 投影的三个可扩展点(L67–L96)

```ts
L73
export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];
```

**条目变换(entry transform)**:收一串条目、返回另一串条目。应用层用它在默认的压缩投影**之后**再插一手(比如隐藏某类条目、做裁剪),而不必 fork 这个文件。入参和返回都是 `readonly`,这是签名层面的一句话:变换必须产出新数组,不许原地改 storage 手上的那一份。

```ts
L81–L85
export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;
```

**custom 条目的投影器**。custom 条目默认**不进**模型上下文(见 §6),应用层注册一个同名 `customType` 的投影器,才把它翻译成消息。三个参数分别是条目本身、它在**投影后**列表里的下标、以及投影后的整串条目 —— 下标和数组都是变换链跑完之后的那一份,不是磁盘上的原始路径。

```ts
L88–L95
export interface SessionContextBuildOptions {
	entryTransforms?: readonly ContextEntryTransform[];
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}
```

两个字段都是「**往默认行为上加**」:没有任何开关能关掉默认的压缩变换,也没有开关能让 custom 条目批量进上下文。这一条决定了 §9 的合并语义 —— 会话级选项与调用点选项只会叠加,不会互相取消。

### §3 遍 1:deriveSessionContextState(L97–L141)

```ts
L108–L117
function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;
```

三个初值各自有含义,**不是随手写的默认**:

- `thinkingLevel = "off"` 的意思是「这条路径上从没出现过 `thinking_level_change` 条目」。要留意 `"off"` 在下游不是「低一档」,而是**把 `reasoning` 参数整个从请求里摘掉**(`agent-harness.ts` 的 `:429`)。对推理模型来说,没人设过档位 = 思考功能默认关闭 —— CLAUDE.md 的「默认思考档位」一节记了实测代价:107 条 assistant 消息、reasoning token **0**。
- `model = null` 与「某个模型」是两种不同的答案。`null` = 这条路径上从没出现过模型信息,恢复会话的宿主据此回退到自己的默认模型(`coding-agent/src/acp/agent.ts:380`)。
- `activeToolNames = null` 同理,与空数组(「一个工具都不给」)不是一回事。

```ts
L121–L136
	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}
```

顺序扫一遍、后写覆盖先写,拿到的是「路径末端时刻」的配置。没写成倒着扫 + 提前 `break`,是因为三个字段各自都要取「最后一次」,倒着扫得给每个字段单独记一个「已定」标志,不划算。

L126 / L130 那条分支值得单独说:**助手消息自带 `provider`/`model`**,所以哪怕这条路径上一条 `model_change` 都没有(老会话,或者模型是构造 harness 时定的),也能从历史里反推出上次用的是谁。它与 `model_change` 写同一个变量,谁在**路径上更靠后**谁说了算 —— 与 `else if` 的书写顺序无关,因为对同一条条目只会命中一个分支。

这一点有测试直接钉着:`compaction.test.ts:345-353` 的路径是 `[user, model_change("openai","gpt-4"), assistant, thinking_change]`,断言结果却是 `{provider: "anthropic", modelId: "claude-sonnet-4-5"}` —— 因为那条 assistant 消息排在 `model_change` **后面**,把它覆盖掉了。

L134 的 `[...entry.activeToolNames]` 是防御性拷贝:内存存储里条目对象**就是** storage 缓存里的那一个,直接把数组引用交出去,调用方随手一改就等于改写了历史。

**这个函数最重要的一点在入参**:它吃的是**未经压缩投影**的完整路径。被压缩隐去的那一段里可能有 `model_change`,那次换模型在语义上依然有效。这就是文件头说的「两遍独立扫描」的全部理由。

### §4 遍 2 第一步:defaultContextEntryTransform(L142–L193)

全景篇 §4 步骤 3c。这是整套「压缩只改投影、不改历史」的**唯一兑现处**。

```ts
L153–L167
export function defaultContextEntryTransform(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}
	if (!compaction) {
		return [...pathEntries];
	}
```

第一段循环不 `break`,一路覆盖,所以取到的是路径上**最后一个** compaction。推论:多次压缩时只有最后一次定义投影;而被它保留下来的区间里若还有更早的 compaction 条目,那些会照常投影成摘要消息 —— 于是上下文里可能同时出现好几条压缩摘要。这是设计,不是 bug。

L166 从没压缩过的分支也**拷贝**再返回,不是直接把入参递出去,为的是两条分支的返回值可变性一致:调用方拿到的永远是一个可以自由处置的数组。

```ts
L172–L191
	const entries: SessionTreeEntry[] = [compaction];
	const compactionIdx = pathEntries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = pathEntries[i]!;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept) entries.push(entry);
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
```

结果的形状是 `[压缩摘要条目, firstKeptEntryId..压缩点之间的条目, 压缩点之后的一切]`。

- **L172 摘要排在最前面。** 压缩条目在时间上是最晚追加的,投影却把它挪到队首 —— 因为发给模型的历史必须是「先读摘要,再读保留下来的近期对话」。顺序反了模型会以为摘要是最新进展。这是投影顺序与磁盘顺序第一次分家。
- **L175 用 id 再找一次下标**,而不是在上面那个循环里顺手记下来。多一次遍历,换「找最后一个」和「定位」两件事互不纠缠;`id` 在一个会话内唯一,`findIndex` 找到的必然就是那一条。
- **L179–L186 收的是半开区间 `[firstKeptEntryId, compactionIdx)`**:含 `firstKeptEntryId` 自己,不含 compaction 条目(它已经在数组头上了)。`firstKeptEntryId` 由压缩算法挑出,语义是「从这条起原文保留」。
- **L184 是本文件最危险的一行**,见 §5 第 1 条。

删掉这个函数,压缩就完全失效:条目照样在树上,上下文却一点都不会变短。

### §5 遍 2 第二步:buildContextEntries(L194–L216)

```ts
L200–L215
export function buildContextEntries(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionTreeEntry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) {
		entries = [...transform(entries)];
	}
	return entries;
}
```

条目级投影的总入口。三点:

1. **默认变换永远第一个跑**,这是契约的一部分:应用层变换看到的第一条条目通常就是那条 compaction。`test/harness/session.test.ts` 的 `"applies context entry transforms after default compaction selection"` 用例专门断言了 `observedFirstEntryType === "compaction"`。
2. 变换按注册顺序串联,前一个的输出是后一个的输入。
3. L212 每一步都摊成新的可变数组:变换的返回类型是 `readonly`,不摊开就赋不回 `entries`;顺带也挡住了「某个变换偷懒返回了传进去的那个数组、后面被别人改掉」这类耦合。

它返回的仍然是**条目**列表而不是消息列表。想看「这一轮到底带了哪些条目进上下文」就调它;要消息则走 §7。

### §6 遍 2 第三步:sessionEntryToContextMessages(L217–L276)

全景篇 §4 步骤 3d:把**一条**条目翻译成 0..N 条 `AgentMessage`。`index` / `entries` 两个参数本函数自己一个都不用,纯粹是转交给 custom 投影器。

```ts
L233–L235
	if (entry.type === "message") {
		return [entry.message as AgentMessage];
	}
```
message 条目直出,零加工。这里的 `as` 是冗余断言 —— `MessageEntry.message` 的声明类型本来就是 `AgentMessage`(`harness/types.ts` 与本文件 import 的是同一个 `src/types.ts`)。

```ts
L238–L252
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content as string | (TextContent | ImageContent)[],
				entry.display,
				entry.details,
				entry.timestamp,
			),
		];
	}
```
`custom_message` 是应用自定义的一条**真消息**:有内容、能显示、默认进上下文 —— `messages.ts` 的 `convertToLlm` 把 `role:"custom"` 原样翻成一条 user 消息,**根本不看 `display` 字段**。所以 `display` 只决定 UI 画不画它,不决定它进不进模型。

`entry.timestamp` 用的是条目自己的时间戳而不是 `new Date()`:重放同一个会话必须逐字节复现,宿主投影器铸消息 id 用的正是(消息序号, 时间戳)这一对,时间一漂 id 就不稳(CLAUDE.md「投影器」不变式 2)。

```ts
L255–L262
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
```
两条合成消息。`compactionSummary` / `branchSummary` 都是内部角色,真正发给模型时由 `convertToLlm` 包上前后缀变成 user 消息;`tokensBefore` 只随消息带给 UI 展示,**不进模型、不参与计算**。

L260 的 `&& entry.summary` 是一处静默短路:摘要为空串时这条条目一条消息都不产出(见 §5 第 3 条)。

```ts
L265–L274
	if (entry.type === "custom") {
		// custom 条目默认不进模型上下文,除非应用注册了对应 customType 的 projector。
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return []; // 配置类条目(model_change 等)不产生消息
```
三个 `?.` 连着:没配 `entryProjectors`、没注册这个 `customType`、投影器返回 `undefined`,三种情况都折叠成「不产出消息」。

末尾的兜底吃掉 `model_change` / `thinking_level_change` / `active_tools_change` / `label` / `session_info`(以及理论上不会出现在路径里的 `leaf`)—— 它们携带的信息已经被 §3 那一遍吸收进 `SessionContext` 的配置字段,再变成消息就是重复。

### §7 buildSessionContext —— 两遍合流(L277–L298)

```ts
L283–L297
export function buildSessionContext(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}
```

**看清入参**:`state` 吃的是 `pathEntries`(**完整**路径),`messages` 吃的是 `contextEntries`(**投影后**)。两者写反的话,被压缩掉那段里的 `model_change` 就会丢,症状是「恢复老会话时模型莫名其妙变了」—— 而且不报错。

`flatMap` 意味着一条条目可以产 0 条、1 条或多条消息,所以**条目列表与消息列表从来不是一一对应的**。

它做成自由函数(而不是只挂在 `Session` 上)是有调用方的:`compaction.ts:831` 直接拿一段 `pathEntries` 调它来算 `tokensBefore` —— 那一刻它手上只有条目数组,没有 `Session` 实例。

### §8 Session 类:字段、构造与只读读取(L299–L363)

```ts
L310–L323
export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private storage: SessionStorage<TMetadata>;
	private contextBuildOptions: SessionContextBuildOptions;

	constructor(storage: SessionStorage<TMetadata>, contextBuildOptions: SessionContextBuildOptions = {}) {
		this.storage = storage;
		this.contextBuildOptions = contextBuildOptions;
	}
```

会话树的**门面(facade)**:对上给 harness / 宿主一组语义清晰的方法,对下只依赖 `SessionStorage` 一个接口。

它自己**不缓存任何会话状态** —— 没有条目数组、没有内存里的 leaf 变量,每次调用都现问 storage。于是「同一个会话被开了两个 `Session` 实例」不会产生两份互相打架的内存状态;真正的并发风险在 §11 那条 id/parentId 竞态上,与实例个数无关。

泛型 `TMetadata` 只是把 storage 的元数据类型透传出去(JSONL 版比内存版多 `cwd` / `path` 等字段)。

**五个只读转发**(L327–L348):`getMetadata` / `getStorage` / `getLeafId` / `getEntry` / `getEntries`。返回 Promise 的四个**没写 `async`**,直接把 storage 的 Promise 递出去,少一层微任务包装,语义完全一致;`getStorage()` 是其中的例外 —— 它同步返回 storage 本身,不是 Promise。

其中 `getStorage()` 是**逃生舱**:`setLeafId` / `findEntries` 这类 `Session` 没有包装的能力,调用方直接问 storage 要 —— harness 的 `flushPendingSessionWrites` 靠它写 leaf(`agent-harness.ts:848`),ACP 的自动压缩靠它 `findEntries("compaction")` 找上一次压缩的时间(`acp/agent.ts:609`)。

```ts
L359–L362
	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}
```

全景篇 §4 步骤 3a。原注释写的「leaf → root」说的是**走法**(沿 `parentId` 往上爬);返回数组的**顺序是 root → leaf**,因为 `getPathToRoot` 内部用 `unshift` 逐个前插。所以拿到手可以直接当「从旧到新的一段对话」用。

`fromId` 省略时用当前 leaf;显式传的场景只有分支摘要 —— `branch-summarization.ts:112-113` 要同时拿旧 leaf 与新目标两条路径去求最深公共祖先(LCA)。注意回退用的是 `??` 而不是 `||`,它只吃 `null` / `undefined`:传空串**不会**回退到当前 leaf,而是原样送进 `getPathToRoot("")`,那里查不到条目,抛 `SessionError("not_found")`。

### §9 实例侧上下文构建与选项合并(L364–L395)

```ts
L366–L378
	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}
```

两个自由函数的实例包装:自动取当前分支、自动合并会话级选项。`buildContext()` 就是全景篇步骤 3 的入口。

值得记住的一点是**谁在消费返回值的哪一部分**:`createTurnState()`(`agent-harness.ts:574`)每轮开头调它,但**只取 `messages`**;`model` / `thinkingLevel` 用的是 harness 自己的字段。三个配置字段真正的消费者是「恢复会话」的宿主 —— `coding-agent/src/acp/agent.ts:380-384` 用 `context.model` / `context.thinkingLevel` 复原用户上次的选择,`activeToolNames` 目前只有测试在读(`agent-harness.test.ts:640`)。

```ts
L386–L394
	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}
```

两个字段的合并语义**不同**,这是本节唯一要背的东西:

| 字段 | 合并方式 | 结果 |
|---|---|---|
| `entryTransforms` | 数组拼接,会话级在前 | 两边都会跑,顺序「先会话级、后调用点」 |
| `entryProjectors` | 对象展开,调用点在后 | 同名 `customType` 时调用点**覆盖**会话级 |

没有「关掉会话级选项」的开关;要临时不跑某个变换,只能另建一个不带它的 `Session`。

(oxlint 对 L390/L391 的 `?? {}` 报 `no-useless-fallback-in-spread` 两条 warning —— 这是本文件仅有的两条,加注释前就存在。)

### §10 标签与会话名(L396–L415)

```ts
L401–L414
	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	async getSessionName(): Promise<string | undefined> {
		const entries = await this.storage.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}
```

标签由 `label` 条目累积,storage 侧维护成一张 `id → label` 的缓存表,规则是「最后一条说了算」,空标签等于删除(`memory-storage.ts` 的 `updateLabelCache`)。

会话名的条目类型叫 `session_info` 是历史遗留(`types.ts` 里原注释写着 `legacy name, kept for backwards compatibility`),取的是**最后一条**的 `name`。只有空白的名字经 `trim` 后被 `|| undefined` 吃掉,不会返回空串。

**注意 `findEntries` 扫的是整个会话文件的所有条目,不限于当前分支** —— 切到另一条分支上仍然读到同一个名字。这与 `buildContext`「只看当前路径」是两套语义。

### §11 追加即前进:appendTypedEntry 与九个 append*(L416–L593)

```ts
L426–L429
	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}
```

所有 `append*` 的收口。「追加即前进」是**两边配合**完成的:`parentId`(挂在谁下面)由上面的调用方定死,而「新条目成为新 leaf」由 `storage.appendEntry` 内部完成(`leafIdAfterEntry`)—— 所以这里看不到任何 `setLeafId`。

失败时不接:storage 抛的 `SessionError` 一路冒到调用方。harness 的 FIFO 队列靠「写成功才出队」保证失败的写留在队头、不会烂在半路。

九个 `append*` 长得一模一样,拿 `appendMessage` 当样板:

```ts
L432–L447
	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}
```

四件事值得记:

1. **`id` 由 `createEntryId()` 分配**,它只是「查了一下没撞车」,**不预留**这个 id。
2. **`parentId` = 当前 leaf**,这就是「顺序对话是一条直链」的全部机制。
3. **`timestamp` 是落盘时刻**,与消息体里那个业务时间戳是两回事,不要拿它做对话时序推断。
4. **末尾用 `satisfies` 而不是 `as`**:漏写一个字段会当场编译失败,而 `as` 会把这种错误咽下去。九个 `append*` 与 `moveTo` 全部照抄这一套写法,这是它们唯一一处类型安全保证。

其余八个各自的要点:

| 方法 | 行号 | 要点 |
|---|---|---|
| `appendThinkingLevelChange` | L453 | 档位存的是**字符串**而不是枚举,因为「哪些档位合法」取决于当时选的模型;恢复会话时由宿主再夹一次(`clampThinkingLevel`) |
| `appendModelChange` | L464 | provider 与 modelId 分两段存;恢复时找不到就回退宿主默认模型 |
| `appendActiveToolsChange` | L478 | L485 拷贝数组;传空数组合法,意思是「一个工具都不给」,与 §3 里 `null` 的「从没设过」不同 |
| `appendCompaction` | L499 | 五个参数见下;调用点 `agent-harness.ts:1331`,**摘要真的生成成功之后才会走到这里** |
| `appendCustomEntry` | L523 | 纯结构化数据,**默认不进**上下文 |
| `appendCustomMessageEntry` | L538 | 自定义角色的真消息,**默认就进**上下文 |
| `appendLabel` | L563 | 唯一一个先校验目标存在的 `append*` |
| `appendSessionName` | L581 | 先清换行再落盘 |

`appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)`:`summary` 是摘要正文(投影时变成一条 `compactionSummary` 消息),`firstKeptEntryId` 是 §4 那把切刀,`tokensBefore` 纯展示,`details` 是应用层附加数据(读过/改过的文件清单)原样存取,`fromHook` 记录摘要是不是 `session_before_compact` hook 直接给的而不是调模型生成的。它落盘在压缩流程的最后一步,中途失败时树分毫未动 —— 这就是「压缩失败不连坐」的实现方式。

```ts
L563–L575
	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.storage.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.storage.createEntryId(),
			parentId: await this.storage.getLeafId(),
			...
```
为什么只有它校验:条目只追加不删改,**指向不存在 id 的标签是永久性脏数据**,没有任何后续流程会来修它。另外注意这条 label 条目自己挂在**当前 leaf** 下而不是挂在 `targetId` 下 —— 它是一条旁注,不改变对话的形状(投影时产出 0 条消息)。

```ts
L584
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
```
换行必须先杀掉。倒不是怕劈开 JSONL 的行(`JSON.stringify` 会转义),而是这个名字要出现在标题栏和会话列表里,多行标题是纯粹的显示灾难。测试 `"normalizes session names"` 钉住了 `" hello\nworld\r\nagain "` → `"hello world again"`。

### §12 moveTo —— 移动 leaf 与分支摘要(L594–L638)

```ts
L604–L618
	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.storage.setLeafId(entryId);
		if (!summary) return undefined;
```

**这是分支产生的唯一途径**:挪完之后再 `append`,新条目挂在那个旧条目下,原来那条尾巴就成了另一条分支 —— 一条都没被删。调用点是 harness 的 `navigateTree()`(`agent-harness.ts:1446`)。

- **先校验再动 leaf**:leaf 一旦指到不存在的 id 上,之后每一次 `getPathToRoot` 都会抛,等于整个会话打不开。`null` 是合法值(根),所以要单独放行,不能写成 `if (!entryId)`。
- **`setLeafId` 不是改一个内存变量,而是追加一条 `leaf` 条目**。JSONL 是追加日志,光标只有写成数据才能在重开文件时被逐行重放出来。推论:`leaf` 条目虽然进了文件,却永远不会出现在任何一条 `getPathToRoot` 路径上 —— storage 把游标设成 `targetId` 本身,没人会以 leaf 条目为父。
- **不要摘要就到此为止**,只有这条路径上最终 leaf 才真的停在 `entryId`。

```ts
L622–L636
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.storage.createEntryId(),
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
```

`parentId` 显式写 `entryId`,而不是像别的 `append*` 那样再问一次 leaf。上一行的 `setLeafId` 已经把游标设成了 `entryId`,两者取值相同,但写死在这里把「摘要必须挂在目标条目下」这个意图钉住了,也省一次 I/O。`entryId` 为 `null` 时,这条摘要自己成为一个根节点。

`fromId` 记的是「从哪儿分出来的」,给 UI 显示用;`entryId` 为 `null` 时退化成字符串 `"root"`,因为消息构造器要的是 `string` 而不是 `string | null`。

**返回值**是摘要条目的 id,没要摘要时返回 `undefined` —— harness 拿它去 `getEntry` 取回完整条目,再发 `session_tree` 事件。

## 5. 会咬人的地方

1. **L184 `firstKeptEntryId` 找不到 = 压缩点之前整段静默丢弃。** 如果 `firstKeptEntryId` 不在压缩点之前的这段路径上(它属于另一条分支、或跨 fork 丢了),`foundFirstKept` 永远是 `false`,上下文里就只剩一条摘要。没有告警、没有兜底、没有降级。
2. **L157–L162 多条 compaction 时只有最后一条生效**,但被它保留下来的区间里若还有更早的 compaction 条目,那些会照常投影成摘要消息 —— 上下文里会出现多条压缩摘要。这是设计不是 bug,但排查「为什么模型看到两份摘要」时会先怀疑错地方。
3. **L260 `branch_summary` 的 summary 为空串时不产生消息**,但条目仍在 `buildContextEntries()` 的返回列表里。**「条目列表」和「消息列表」不是一一对应的** —— 拿 `contextEntries.length` 去断言 `messages.length` 一定翻车。
4. **L265 vs L238:`custom` 与 `custom_message` 名字只差一个词,默认行为相反。** 前者默认**不进**上下文(必须注册 `entryProjectors[customType]`),后者默认**就进**。
5. **L441–L442 的竞态:两个 `append*` 并发 = 意外分叉,不是成链。** `createEntryId()` 不预留 id,而它与 `appendEntry` 之间还隔着一次 `await getLeafId()`。并发调用不但可能拿到同一个 id,而且**一定**拿到同一个 `parentId` —— 两条新条目并列挂在同一个父下。harness 用 FIFO 串行 flush 规避;**直接用 `Session` 的调用方要自己保证串行**。
6. **L616–L628 `moveTo(x, {summary})` 之后最终 leaf 不是 `x`。** 摘要条目挂在 `x` 下面,`appendEntry` 又把游标推到摘要条目上。想知道「到底挪到哪了」必须再问一次 `getLeafId()`(`agent-harness.ts:1458` 就是这么做的),照着入参推会错。
7. **L411 `getSessionName` 用 `findEntries` 扫全文件,不限当前分支。** 与 `buildContext` 的「只看当前路径」是两套语义,读同一个会话的不同分支会得到同一个名字。
8. **L360 `getBranch(fromId)` 用的是 `??` 而不是 `||`。** 回退只在 `fromId` 为 `null` / `undefined` 时发生;传空串**不回退**,而是原样进 `getPathToRoot("")` 并抛 `SessionError("not_found")`。唯一的显式调用方 `branch-summarization.ts:112` 在传参前做了 `if (!oldLeafId) return`(:108),两种情况都没暴露;新调用方要自己当心。
9. **【与全景篇不符】** 全景篇 §5 跨包接线表写着 `createTurnState` 从 `buildContext()` 「拿 messages / model / thinkingLevel / activeToolNames」。**代码只取 `messages`**(`agent-harness.ts:574-613`):`model` / `thinkingLevel` 来自 harness 自己的字段,`activeTools` 来自 `this.activeToolNames`。派生出来的三个配置字段在生产代码里的唯一消费者是 ACP 的 `loadSession`(`coding-agent/src/acp/agent.ts:380-384`),而 `context.activeToolNames` 全仓只有测试在读。
10. **【与注释不符】L417–L418** 原注释说「storage 只负责存,树的构造责任在这里」。更准确的说法是**责任分在两边**:`id` / `parentId` 由这里定,而「新条目成为新 leaf」是 `storage.appendEntry` 内部做的(`leafIdAfterEntry`)。把 storage 换成一个不推进 leaf 的实现,这个文件的语义就塌了。
11. **【与注释不符】L350** 原注释「当前对话 = leaf → root 的路径」描述的是**走法**;`getBranch()` 返回的数组顺序是 **root → leaf**(`getPathToRoot` 用 `unshift`)。按字面理解会把消息顺序读反。
12. **L234 / L243 两处 `as` 是冗余断言**,断言的类型与声明类型完全相同。它们不改变行为,但会掩盖以后 `MessageEntry.message` / `CustomMessageEntry.content` 类型收窄时本该出现的编译错误。
13. **`SessionContextBuildOptions` 没有「关掉默认行为」的开关**(§9)。会话级选项一旦传进构造函数,每一次 `buildContext` 都会带上它,调用点只能加、不能减。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/ai/src/types.ts`(经 `@earendil-works/pi-ai`) | 仅类型:`TextContent` / `ImageContent`,用于 `custom_message` 的内容形状 |
| 它 import | `agent/src/types.ts` | 仅类型:`AgentMessage`,投影产物的元素类型 |
| 它 import | `agent/src/harness/messages.ts` | 三个合成消息构造器(`createCustomMessage` / `createCompactionSummaryMessage` / `createBranchSummaryMessage`);再往下 `convertToLlm` 才是 LLM 边界 |
| 它 import | `agent/src/harness/types.ts` | 11 种条目类型 + `SessionContext` + `SessionStorage` 契约 + `SessionError` |
| 它调用(经接口) | `session/memory-storage.ts` / `session/jsonl-storage.ts` | `SessionStorage` 的两套实现;`getPathToRoot` / `appendEntry` / `setLeafId` / `createEntryId` 的真正语义在那里 |
| import 它 | `agent/src/harness/agent-harness.ts:74` | 主消费者:每轮 `buildContext()`、`flushPendingSessionWrites` 里的九个 `append*`、`compact()` 的 `appendCompaction`、`navigateTree()` 的 `moveTo` |
| import 它 | `agent/src/harness/compaction/compaction.ts:67` | `buildSessionContext(pathEntries)` 算 `tokensBefore` |
| import 它 | `agent/src/harness/compaction/branch-summarization.ts:34` | 用 `getBranch` / `getEntry` 求最深公共祖先并收集待摘要条目 |
| import 它 | `session/repo-utils.ts:32` / `jsonl-repo.ts` / `memory-repo.ts` | `SessionRepo` 的 `create` / `open` / `fork` 最终 `new Session(storage)` |
| import 它 | `agent/src/harness/types.ts:52` | 仅类型(`SystemPromptContext` 里带 `session`),与本文件构成 type-only 循环引用 |
| import 它 | `agent/src/index.ts:107` | `export *`,于是 `Session` 与投影四函数都是包的公开 API |
| 间接消费 | `coding-agent/src/acp/agent.ts` / `packages/kernel/src/host/session-manager.ts` | 两个宿主:恢复会话(读 `context.model` / `thinkingLevel`)、重放历史(读 `context.messages`)、写会话标题(`appendSessionName`) |

## 7. 自测题

**Q1.** 把 `buildSessionContext`(L289)里的 `deriveSessionContextState(pathEntries)` 改成 `deriveSessionContextState(contextEntries)`,会发生什么?测试会红吗?

<details><summary>答案</summary>

功能上会退化:压缩之后,被隐去那段历史里的 `model_change` / `thinking_level_change` / `active_tools_change` 全部消失,派生出来的 `model` 会变成 `null` 或更早的某个值。症状是「一压缩,恢复会话时模型/思考档位就回退到默认」,而且不报错。

`test/harness/compaction.test.ts:350` 那条 `buildSessionContext([user, modelChange, assistant, thinkingChange])` 用例里没有 compaction 条目,投影后的条目 = 原路径,所以**它不会红**。要抓住这个回归,得写一条「压缩点之前有 model_change」的用例。这正是「两遍独立扫描」值得单独记住的原因。
</details>

**Q2.** 一个会话里追加了 3 条 message 和 1 条 summary 为空串的 `branch_summary`,`buildContextEntries()` 和 `buildContext().messages` 的长度分别是多少?

<details><summary>答案</summary>

条目 4 条,消息 3 条。`branch_summary` 走 L260 的 `&& entry.summary`,空串是假值,条件不成立,函数一路落到 L274 的 `return []`,不产出任何消息;但它仍然留在 `buildContextEntries()` 的返回列表里。这就是「条目列表 ≠ 消息列表」。
</details>

**Q3.** 把 L172 的 `const entries: SessionTreeEntry[] = [compaction];` 改成 `= []`,并在函数末尾 `return [...entries, compaction];`,行为会怎么变?

<details><summary>答案</summary>

投影后的消息顺序变成「保留下来的近期对话 → 压缩点之后的对话 → 摘要」,摘要跑到了最后。模型会把这条「以下是先前对话的摘要」当成最新进展来读,轻则重复已经做完的事,重则按摘要里的旧状态继续推理。

补充一点:这么改**不影响** `deriveSessionContextState`(它扫的是原始路径),也**不影响**磁盘上的任何字节 —— 又一次印证「投影是可以随便重排的,历史不行」。
</details>

**Q4.** 不经 harness、直接拿一个 `Session` 实例同时发起 `session.appendMessage(a)` 和 `session.appendMessage(b)`(不 await 第一个),树会长成什么样?

<details><summary>答案</summary>

两条消息**并列挂在同一个父下**,变成两条分支,而不是 a → b 的链。因为 `createEntryId()` 只查重不预留,而 `parentId: await this.storage.getLeafId()` 在两次调用里读到的是同一个 leaf(第一条还没 `appendEntry`,leaf 尚未推进)。极端情况下两条还会拿到同一个 id。

harness 用 FIFO 串行 flush 规避了这件事(全景篇 §3「挂起写入」),所以这个坑只有绕开 harness 直接用 `Session` 的调用方才会踩到。
</details>

**Q5.** `await session.moveTo("e42", { summary: "..." })` 返回 `"e77"`。此时 `await session.getLeafId()` 是什么?`await session.getBranch()` 的最后一条条目是什么?

<details><summary>答案</summary>

`getLeafId()` 返回 `"e77"`(那条 branch_summary 的 id),不是 `"e42"`。`moveTo` 先 `setLeafId("e42")` 把游标挪过去,随后追加的摘要条目 `parentId = "e42"`,而 `appendEntry` 又把游标推到摘要条目本身。

`getBranch()` 的最后一条就是那条 `branch_summary` 条目,它的父是 `e42`。中间那条 `leaf` 条目**不会**出现在路径里 —— 它的父是旧 leaf,而游标被设成了 `e42`,没人以它为父。

只有不传 summary 时,最终 leaf 才真的停在 `"e42"`。
</details>
