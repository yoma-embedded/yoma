# packages/agent/src/harness/compaction/compaction.ts

> **档位** A(逐行) · **行数** 1066(加注释前 759) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3 第四组 · §4 步骤 47–48 · §5.2 · §6.1 · **索引** [README](../README.md)

## 1. 一句话

上下文压缩(compaction)的全部算法都在这里:token 怎么估、什么时候该压、从哪一条条目下刀、拿什么提示词让模型写摘要 —— 三段纯函数管线 + 一到两次模型调用,**不落盘、不自动触发**。

---

## 2. 它在全景里的位置

先把三个词说清楚,后面全靠它们:

- **compaction(压缩)**:上下文快撑满模型窗口时,把靠前的一段对话交给模型写成一份结构化摘要,后续请求只带「摘要 + 最近这一段原文」。
- **投影(projection)**:会话不是消息数组,而是一棵**只追加、永不删改**的条目树。压缩只往树上追加一条 `compaction` 条目;真正「变短」发生在**读的时候** —— `buildSessionContext` 把摘要之前的条目隐去。磁盘上的 `.jsonl` 一个字节都没少。这就是全景篇反复念的那句咒语:**压缩改的是投影,不是历史**。
- **切点(cut point)**:被保留的原文从哪一条条目开始。`firstKeptEntryId` 记的就是它。

这个文件在链路上的位置,对应全景篇 §4 的**步骤 47「自动压缩」**:

1. 宿主(`packages/kernel/src/host/compaction.ts`,或 ACP 那边的 `coding-agent/src/acp/agent.ts`)在一轮结束后调本文件的 `estimateContextTokens(messages)` 拿到当前上下文大小,再调 `shouldCompact(tokens, contextWindow, settings)` 判阈值。**「什么时候压」是应用层的事,内核只给机制** —— 这个文件里没有任何一处会自己触发压缩。
2. 过阈值 → 宿主调 `harness.compact()`(`agent-harness.ts:1291` 的 `AgentHarness.compact`)。harness 把相位切到 `compaction`,拿到当前分支的全部条目,调本文件的 **`prepareCompaction`**(纯函数:定区间、定切点、攒要摘要的消息)。
3. harness 把 `CompactionPreparation` 交给 `session_before_compact` hook —— hook 可以取消,也可以直接给一份现成摘要。没被拦下就调本文件的 **`compact`**,这是唯一发网络请求的一段。
4. **成功之后才** `session.appendCompaction(...)` 落盘。摘要生成途中失败的话,会话树分毫未动 —— 三段式拆分(`shouldCompact` / `prepareCompaction` / `compact`)的全部意义就在这里。

再往后是**步骤 48**:下一次 `buildContext()` 时,`session/session.ts` 的 `defaultContextEntryTransform` 看到这条新的 compaction 条目,把结果重排成 `[摘要, firstKeptEntryId..compaction 之间, compaction 之后的一切]` —— 压缩的效果完全由这个投影函数兑现,而本文件只负责产出 `firstKeptEntryId` 和 `summary` 这两个字段。

**不存在会怎样**:会话聊长了直接撞上下文窗口,provider 返回上下文溢出错误,而且这个错误不可重试(宿主的 `shouldAutoRetry` 会专门把它排除掉,因为「那该压缩」)。对这个产品尤其致命 —— datasheet 章节动辄上万字符、flash 与 gdb 的输出成片,一次硬件调试会话烧 token 的速度比普通编码对话快得多。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L87 | 原文件头注释 + 新增总述块 + 依赖导入 |
| §2 | L88–L196 | 文件清单继承(`CompactionDetails` / `extractFileOperations`)与条目 → 消息 |
| §3 | L197–L228 | `CompactionResult` 与 `DEFAULT_COMPACTION_SETTINGS` |
| §4 | L229–L343 | token 估算三件套:`calculateContextTokens` / `getLastAssistantUsage` / `estimateContextTokens` |
| §5 | L344–L356 | 阈值判断 `shouldCompact` |
| §6 | L357–L436 | 单条消息的字符启发式 `estimateTokens` |
| §7 | L437–L603 | 切点搜索:`findValidCutPoints` / `findTurnStartIndex` / `findCutPoint` |
| §8 | L604–L693 | 三份摘要提示词(系统 / 首次 / 更新式) |
| §9 | L694–L783 | `generateSummary`:一次模型调用 |
| §10 | L784–L881 | `prepareCompaction`:切在哪、要摘要什么 |
| §11 | L882–L904 | 轮前缀提示词与 `serializeConversation` 再导出 |
| §12 | L905–L1001 | `compact`:一次或两次模型调用,拼出最终摘要 |
| §13 | L1002–L1066 | `generateTurnPrefixSummary`:split turn 的第二次调用 |

源码里每一节开头都有一行 `// ── §N ... ──` 标记,与这张表一一对应。

---

## 4. 逐节讲解

### §1 文件头与依赖(L1–L87)

L1–L9 是原作者留的文件头,已经把管线三段和「压缩改的是投影」讲清楚了;L10–L49 是这次补的总述块(名词表 + 全景锚点 + 分节索引)。真正要看的是导入区:

`L53–L86` 六个模块、七条 import 语句,每一组都对应一件事:

- `@earendil-works/pi-ai` — 只拿类型(`AssistantMessage` / `Model` / `Models` / `Usage` …)。本文件唯一的副作用是 `models.completeSimple` 那一次网络调用。
- `../../types.ts` 的 `AgentMessage` — **这是全文最需要留意的一个类型**。它等于 pi-ai 的三种原生角色(`user` / `assistant` / `toolResult`)∪ 本仓在 `harness/messages.ts` 里用 `declare module` 注册的四种自定义角色(`bashExecution` / `custom` / `branchSummary` / `compactionSummary`)。§6 的 `estimateTokens` 必须把这七种全覆盖,漏一种就静默返回 0。
- `../messages.ts` 的 `convertToLlm` 与三个构造器 — `convertToLlm` 是 LLM 边界投影,自定义角色在这里被折成 `user` 消息。
- `../session/session.ts` 的 `buildSessionContext` — **只**用来算 `tokensBefore`(§10),因为那个数要的是「投影之后」的消息。
- `../types.ts` — `CompactionPreparation` / `CompactionSettings` / `FileOperations` / `Result` / `CompactionError` 都定义在那里,本文件不重复定义。
- `./utils.ts` — 与 `branch-summarization.ts` 共用的四个纯函数。

### §2 文件清单继承与条目 → 消息(L88–L196)

这一节全是给 §10 打下手的。要解决两个问题:压缩之后模型还记不记得自己动过哪些文件;以及怎么把会话**条目**还原成能喂给摘要模型的**消息**。

#### `CompactionDetails`(L95–L100,导出)

```ts
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}
```

只有两个字段,但它是一条跨越两次压缩的契约:本次压缩把它写进 compaction 条目的 `details`,**下一次**压缩再读回来继承。改字段名 = 老会话的清单继承静默失效(读到 `undefined`,`Array.isArray` 判假,直接跳过,没有任何告警)。

#### `safeJsonStringify`(L106–L112)

`JSON.stringify` 遇到循环引用会抛、遇到 `undefined` 或函数会返回 `undefined`。这里只是为了**量字符数**,所以宁可给个 `"[unserializable]"` 占位串,也不能让一次估算把整轮压缩带崩。

#### `extractFileOperations`(L122–L151)

`L127–L144`:

```ts
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
```

四个细节:

1. `prevCompactionIndex >= 0` —— `-1` 表示本会话第一次压缩,没有可继承的清单。
2. `!prevCompaction.fromHook` —— hook 提供的摘要是应用层塞进来的,`details` 是**任意形状**,不能假定它有 `readFiles` / `modifiedFiles`。这与全景篇 §6.1 的记录一致。
3. 两个 `Array.isArray` —— `details` 来自磁盘上的老会话文件,类型是断言来的,运行时必须自己验形状。
4. 上一次的 `modifiedFiles` 统一并进 **`edited`** 桶。看起来像丢了信息(原来是 edit 还是 write 分不清了),但 `utils.ts` 的 `computeFileLists` 最后会把 `edited ∪ written` 合成 `modifiedFiles`,所以并到哪个桶不影响最终清单。

`L145–L148` 再叠加本次消息里的工具调用。识别规则在 `utils.ts`:**工具名叫 `read` / `write` / `edit` 才被识别**,内核不认识具体工具。

这一步和 §9 的 UPDATE 提示词是**同一个问题的两处对策**:连续压缩最大的风险是逐次遗忘。少了任何一样,压第三次时模型就不知道自己两小时前改过哪些文件。

#### `getMessageFromEntry`(L159–L182)与 `getMessageFromEntryForCompaction`(L190–L195)

前者把条目还原成 `AgentMessage`:`message` 直出,`custom_message` / `branch_summary` / `compaction` 各自走 `messages.ts` 的构造器,**其他一律返回 `undefined`**(配置类条目 `model_change` / `thinking_level_change` / `label` / `leaf` 本来就不是对话内容)。这份映射与 `session.ts` 的 `sessionEntryToContextMessages` 同源。

后者是压缩专用的包装,只多一条规则:

```ts
	if (entry.type === "compaction") {
		return undefined;
	}
```

**旧的 compaction 摘要消息不进本次摘要输入** —— 它走 `previousSummary` 通道(§9 会因此换成 UPDATE 提示词)。两条路都带一遍等于让模型看见同一份摘要两次,更容易把它当成对话内容复述出来。

### §3 结果类型与默认设置(L197–L228)

#### `CompactionResult<T>`(L202–L211,导出)

`summary` / `firstKeptEntryId` / `tokensBefore` / 可选 `details` —— 这就是 harness 落盘时写进 compaction 条目的全部内容:`session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)`。

#### `DEFAULT_COMPACTION_SETTINGS`(L223–L227,导出)

```ts
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};
```

三个数的来历:

- **`reserveTokens: 16384`** —— 留给「摘要本身 + 下一轮回答」的余量。阈值就是 `contextWindow - 16384`(§5);它同时是摘要输出预算的基数(§9 取 0.8 → 13107,§13 取 0.5 → 8192)。
- **`keepRecentTokens: 20000`** —— 切点从最新往回累到这个数才停(§7)。保证压完之后模型手里还有足够近的**原文**,而不是只剩一份摘要。
- **`enabled`** —— 只影响 `shouldCompact` 的返回值。`prepareCompaction` / `compact` 都不看它(手动 `/compact` 应该无视自动压缩的开关)。

宿主 `kernel/src/host/compaction.ts` 与 `coding-agent/src/acp/agent.ts` 都直接 import 这一份常量,所以改这里等于同时改桌面端和 Zed。

### §4 token 估算三件套(L229–L343)

三件套:`calculateContextTokens`(权威)/ `estimateTokens`(启发式,§6)/ `estimateContextTokens`(混合)。

#### `calculateContextTokens(usage)`(L237–L239,导出)

`L238`:

```ts
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
```

`totalTokens` 为 0 / 缺失时才回落到四项相加 —— 有的 provider 不填 `totalTokens`。`cacheRead + cacheWrite` 必须算进去:它们同样占窗口,漏掉会系统性低估。

#### `getAssistantUsage(msg)`(L248–L261)

三重过滤,缺一不可:

```ts
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
```

1. `aborted` / `error` 的那次请求根本没走完,报的数字不可信;
2. `usage` 可能压根不存在(自定义角色的消息、老会话);
3. 算出来必须 `> 0` —— 流式中断留下的半截消息 usage 常常全是 0。

**缺了这层过滤,一次网络失败就会让整段估算塌回 0,于是本该压缩的会话一路撑到撞窗口。** 测试 `compaction.test.ts` 专门钉了这一条:两条 `stopReason` 分别是 `aborted` / `error` 的 assistant 消息,`getLastAssistantUsage` 必须返回 `undefined`;后面跟一条 usage 全 0 的消息时,取到的仍然是更早那条有效的。

#### `getLastAssistantUsage(entries)`(L265–L274,导出)

倒着扫条目数组:要的是「最近一次可信的窗口占用」,不是历史上最大的那次。

#### `ContextUsageEstimate`(L279–L288,导出)与 `getLastAssistantUsageInfo`(L294–L300)

`ContextUsageEstimate.lastUsageIndex` 是给**宿主**用的信号位:它 `=== null` 说明这个会话还没有任何真实 usage。宿主的 Guard 1 据此「不猜、不压」—— 否则纯字符估算会把一个还没跑过一轮的会话误判成「该压了」,新会话一开口就先被压一次。

`getLastAssistantUsageInfo` 与 `getLastAssistantUsage` 的唯一区别是**连下标一起返回**,因为「usage 之后又新增了哪些消息」需要下标才切得出来。

#### `estimateContextTokens(messages)`(L310–L342,导出)

`L328–L341`:

```ts
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]!);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
```

**为什么要混**:provider 报的 usage 是唯一算得准的数(它看得见系统提示词、工具 schema、缓存写入,而字符除以 4 全看不见),但它只覆盖到「最后一条 assistant 消息」为止。之后新增的工具结果、下一条 user、还没报 usage 的半截 assistant,只能逐条估。`i` 从 `usageInfo.index + 1` 起 —— `index` 那条本身已经被 usage 算进去了,再估一次就是重复计费。

没有任何可信 usage 时(`L314–L325`)整段回落到字符估算,并把 `lastUsageIndex` 置 `null`。这个函数**不失败也不抛**:上下文估算在任何路径上都必须给得出一个数,不然宿主没法决策。

### §5 阈值判断 `shouldCompact`(L344–L356)

`L352–L355`:

```ts
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}
```

整个压缩系统里唯一的阈值判断,一行公式。两个要点:

- **严格大于** —— 恰好等于阈值时不压。
- 它**不认识** `contextWindow` 为 0 / `undefined` 的情况:那会让阈值变成负数(`0 - 16384`),于是任何会话都「超阈值」。挡这一发的 guard 在宿主(`host/compaction.ts` 单独给了一个 `no_context_window` 原因码,而不是混进 `under_threshold` —— 后者会让人以为「算过了,没到线」,其实压根没算)。

### §6 单条消息的字符启发式 `estimateTokens`(L357–L436)

全套估算的底座。粗糙是**有意的**:它只在「没有权威 usage」时兜底,以及给 §7 的切点搜索当尺子 —— 那里要的是相对大小,不是绝对精度。

`L363`:

```ts
const ESTIMATED_IMAGE_CHARS = 4800;
```

图片按固定 4800 字符 ≈ 1200 token 记账。真实值随分辨率变(几十到几千),这里取一个偏大的常数:估多了最多早压一次,估少了会撞窗口。

`estimateTextAndImageContentChars`(L366–L380)数 content 数组的字符:`text` 按长度,`image` 按常数,其余块型不计。

`estimateTokens`(L385–L435,导出)按 role 分派,七种一个不落:

| role | 算什么 |
|---|---|
| `user` | content(字符串或块数组)的字符数 |
| `assistant` | `text` + `thinking` + `toolCall`(名字 + 参数 JSON)三种块 |
| `custom` / `toolResult` | content 块数组,图片走 `ESTIMATED_IMAGE_CHARS` |
| `bashExecution` | `command.length + output.length` |
| `branchSummary` / `compactionSummary` | `summary.length` |

统一 `Math.ceil(chars / 4)`。几处不显然的:

- assistant 只有那三种块型算数 —— 工具的**返回**是另一条 `toolResult` 消息,不在这里。
- `toolCall` 的参数走 `safeJsonStringify`,不是裸 `JSON.stringify`。
- `toolResult` 那一支必须留:少了它,一次带图的工具返回(截图、datasheet 配图)会被估成几乎零成本。
- `bashExecution` 把命令本身也算进去:长 pipeline 加上输出,一条就能顶几千 token。
- 最后的 `return 0`(L434)兜住未知 role —— 宁可低估也不要抛。

### §7 切点搜索(L437–L603)

全文最值得琢磨的一节。要回答的问题只有一个:**从哪一条条目开始保留原文**。

#### `findValidCutPoints`(L448–L492)

列出 `[startIndex, endIndex)` 里所有**合法切点**的下标。合法 = 用户可见的消息条目:`user` / `assistant` / `bashExecution` / `custom` / `branchSummary` / `compactionSummary` 六种 role,外加 `branch_summary`、`custom_message` 两种条目类型。

`L462–L467`(中间省掉两行注释):

```ts
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
```

**这一支的空 `break` 就是整个函数存在的理由。** 切在 `toolResult` 前面 = 上一条 assistant 的 `toolCall` 失去应答,provider 收到孤儿工具结果会直接拒收整个请求。这也是压缩里最容易写错、错了以后表现为「压完就再也发不出去」的一处。

写成穷举 `switch` 而不是「排除 toolResult」是故意的:新增条目类型时 TypeScript 会在这里报缺分支,逼你想清楚它算不算切点。

`L487–L489` 还有一刀:`branch_summary` / `custom_message` 在上面的 switch 里走的是空 `break`,真正的 `push` 在 switch **之后**的一个独立 `if` 里。分成两处写没有语义理由,是历史;要合并的话小心别把 message 分支的 role 判断丢了。

#### `findTurnStartIndex`(L499–L514,导出)

「轮(turn)」的起点 = 一条 `user` 消息,或 `bashExecution` / `branch_summary` / `custom_message` 这类同样由用户侧发起的条目。`assistant` / `toolResult` 都不算 —— 它们是这一轮的**回应**,不是发起。找不到返回 `-1`。

#### `CutPointResult`(L518–L525,导出)

`firstKeptEntryIndex` / `turnStartIndex` / `isSplitTurn`。后两个是一对:`turnStartIndex === -1` 时 `isSplitTurn` 必为 `false`。

#### `findCutPoint`(L532–L602,导出)

四步走。

**第一步:列合法切点,一个都没有就放弃。**`L542–L544`:

```ts
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
```

退回 `startIndex` 等于「几乎什么都不压」。宁可不压,也不能切出孤儿工具结果。

**第二步:从最新往回累加,直到攒够 `keepRecentTokens`。**`L547–L570`:

```ts
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]!;

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c]! >= i) {
					cutIndex = cutPoints[c]!;
					break;
				}
			}
			break;
		}
	}
```

- `cutIndex = cutPoints[0]` 是兜底:累加循环一次都没攒够时(整段总量还不到预算)就用最早的合法切点,含义是「这一段整个都该保留」。
- `if (entry.type !== "message") continue` —— 只有 `message` 条目参与累加,于是 `branch_summary` / `custom_message` 的体量对这个预算是**不可见**的:它们能当切点,却不占额度。
- **第三步**藏在里面:攒够之后往后找第一个 `>= i` 的合法切点。只能往后不能往前,否则就会切在 `toolResult` 上。代价是实际保留量通常**略少于**预算 —— 所以 JSDoc 写的是 *approximately*。所有合法切点都比 `i` 早时不改 `cutIndex`,保持兜底值。

**第四步:把切点往前拽过配置类条目。**`L581–L590`:

```ts
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1]!;
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
```

收益是让 `model_change` / `thinking_level_change` / `label` 这些**声明**落在被保留的一侧,`firstKeptEntryId` 之后的条目序列不至于从半截开始。注意收益其实很小:这些条目**不产生消息**(`sessionEntryToContextMessages` 对它们返回 `[]`),而换模型的状态本来也由 `deriveSessionContextState` 扫**完整**路径推导,压掉了也照样生效。

而且循环判的不是「是不是配置类条目」,而是「既不是 `message` 也不是 `compaction`」—— 于是 `branch_summary` / `custom_message` / `custom` 这三种**会**投影成消息的条目同样会被拽过去。那时被移动的是真内容,只不过从「被摘要掉」变成「按原文保留」,不会丢。

两个 `break` 各有各的理由:遇到 `message` 就停 —— 再往前一步就可能停在 `toolResult` 上;遇到 `compaction` 也停 —— 上一条摘要条目是本次区间的左边界,越过去没有意义。

**这个循环有一个不显然的副作用,见 §5 第 1 条。**

**收尾。**`L592–L595`:

```ts
	const cutEntry = entries[cutIndex]!;
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
```

只有「切点恰好是一条 user 消息」才算干净的轮边界。不是的话就说明切在了一轮的中间(**split turn**),该轮的前缀要单独摘要一次 —— 目的是让被保留的后半段不至于「不知道自己在回答什么问题」。

什么时候会 split?最常见的情形是最近一轮本身就超过 `keepRecentTokens`:一条 user 指令后面跟着几十个工具往返,在长调试里非常常见。

### §8 三份摘要提示词(L604–L693)

**模板字符串内部一律不能插注释** —— 那会改变发给模型的字节。三份提示词的注释都写在常量声明的上方。

- **`SUMMARIZATION_SYSTEM_PROMPT`**(L610–L612,导出):两句 `Do NOT` 是防「摘要模型把对话接着往下演」。输入里全是对话,不明确禁止的话模型很容易直接去回答里面最后那个问题,于是你拿到的不是摘要而是一段续写。这份系统提示词被 §9、§13 和 `branch-summarization.ts` 三处共用。
- **`SUMMARIZATION_PROMPT`**(L619–L650):首次摘要,固定六段式 —— `## Goal` / `## Constraints & Preferences` / `## Progress`(Done / In Progress / Blocked)/ `## Key Decisions` / `## Next Steps` / `## Critical Context`。**格式固定不是为了好看**:下一次压缩要在同一套小节上做增量更新,格式漂了就没法「更新」只能重写。结尾那句 `Preserve exact file paths, function names, and error messages` 是硬要求 —— 压缩最常见的损失就是把路径和符号名摘成了「那个文件」。
- **`UPDATE_SUMMARIZATION_PROMPT`**(L655–L692):输入是「新消息 + `<previous-summary>`」,规则里明确写了 PRESERVE 既有信息、把 In Progress 挪进 Done。连续压缩靠它对抗逐次遗忘 —— 每次都重新总结的话,第三次压缩时模型看到的「历史」只剩一份摘要的摘要。

### §9 `generateSummary`:一次模型调用(L694–L783)

`L701–L710` 的签名有八个参数,都必要:`models` + `model` 是往哪发,`reserveTokens` 定输出预算,`signal` 给中断,`customInstructions` 是用户 `/compact` 后面跟的那句话,`previousSummary` 决定用哪份提示词,`thinkingLevel` 只对 reasoning 模型有意义。**失败不抛**,返回 `Result`。

`L714–L717`:

```ts
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
```

输出预算 = `reserveTokens` 的 80%,再被模型自己的 `maxTokens` 钳住。留 20% 是给「摘要之后还要接着说话」的余量;`model.maxTokens` 为 0(未知)时用 `Infinity` 让 `Math.min` 退化成只看前者 —— 写成 0 的话预算就是 0,一个字都出不来。测试 `clamps compaction summary maxTokens to the model output cap` 钉住了这条:`reserveTokens: 500000` 而模型 `maxTokens: 128000` 时,两次调用拿到的都是 128000。

`L719–L723`:

```ts
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
```

用户的额外要求**追加**在提示词末尾而不是替换:那套格式约定必须保住。

`L726–L733` 组提示词:先 `convertToLlm`(自定义角色 → user 消息)再 `serializeConversation` 压成纯文本。**摘要模型看到的是一段文本**,里面的工具调用只是 `name(args)` 的字面描述,不会触发它去接着调工具。标签顺序固定:`<conversation>` → `<previous-summary>` → 指令。指令放最后离生成位置最近,最不容易被长对话淹掉。整段塞进**一条 user 消息**(L737–L743):摘要是一次性的无状态调用,不需要多轮结构。

`L747–L750`:

```ts
	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };
```

`reasoning` 只在「模型支持 && 档位不是 off」时才带。带给不支持的模型会被 provider 拒;`off` 档必须把字段整个摘掉,不能传 `"off"` 这个字符串。测试 `passes reasoning through generateSummary only for reasoning models with thinking enabled` 把三种组合都覆盖了。

`L755–L759` 调 `models.completeSimple`。**它不会 reject** —— 连 provider 解析失败都会被编码成一条 `stopReason` 为 `"error"` 的 assistant 消息(`ai/src/api/lazy.ts` 的 `lazyStream` 把 setup 阶段的异常也接住转成错误消息),所以下面靠 `stopReason` 分流,而不是 `try/catch`。

`L762–L772` 把 `aborted` 与 `error` 分成两个错误码:调用方要能区分「用户按了停止」和「摘要真的失败了」—— 前者不该在 transcript 里报错。

`L776–L779` 只取 `text` 块:reasoning 模型会先吐 `thinking` 块,那是它的草稿,不进摘要正文。

### §10 `prepareCompaction`:切在哪、要摘要什么(L784–L881)

纯函数、不调模型、不落盘。产物 `CompactionPreparation` 会先交给 `session_before_compact` hook。

`L797–L799`:

```ts
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1]!.type === "compaction") {
		return ok(undefined);
	}
```

两种「没得压」:空会话;以及**最后一条就是 compaction**(刚压完,还没说过话)。后者是防连续压缩空转的第一道闸,宿主那边还有一道基于时间戳的 Guard 2。返回 `ok(undefined)` 而不是 `err` —— 这不是错误,调用方(harness)据此抛「Nothing to compact」而不是报故障。

`L816–L825` 定区间:

```ts
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
```

- 倒着找**最后一条** compaction。只认最后一条 —— 与 `session.ts` 的 `defaultContextEntryTransform` 保持同一条规则,两边不一致会让区间对不上。
- 左边界不是「上一条 compaction 的位置」而是它记的 `firstKeptEntryId`。`findIndex` 扫的是整条路径,而这个 id 通常在 `prevCompactionIndex` **之前** —— 这不矛盾:投影 = `[摘要, firstKept..compaction 之间, compaction 之后的一切]`,要重新摘要的正是这段带着原文的区间。
- 找不到时静默降级到 `prevCompactionIndex + 1`(见 §5)。

`L831`:

```ts
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;
```

用的是**投影之后**的消息,含义是「压之前这次上下文有多大」,不是「这个会话历史一共多大」。它只作展示 / 记账,不参与任何判断。

`L835–L842` 调 `findCutPoint`,传的是 `keepRecentTokens` 而不是 `reserveTokens`:两个数管的是不同的事 —— 一个是保留多少原文,一个是留多少输出余量。取到的条目没有 `id` 就硬失败(`invalid_session`),不猜一个:压缩的效果完全由 `firstKeptEntryId` 兑现,猜错等于把一段历史静默丢掉。

`L845–L859` 切两段消息:

```ts
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
```

- **历史** = `[boundaryStart, historyEnd)`;
- **轮前缀** = `[turnStartIndex, firstKeptEntryIndex)`,只有 split turn 才有,否则数组为空,`compact()` 据此走单次调用分支。

两段都走 `getMessageFromEntryForCompaction`,配置类条目和旧 compaction 自然被跳过。

`L860–L867` 攒文件清单:先按历史消息攒(顺带继承上一条压缩的 details),**再**把轮前缀里的工具调用补进去。少了后一步,被切走的那半轮里改过的文件会从清单里消失。

`L870–L879` 返回的全是**数据**,没有任何副作用。

### §11 轮前缀提示词与再导出(L882–L904)

`TURN_PREFIX_SUMMARIZATION_PROMPT`(L886–L899)是三段式:`## Original Request` / `## Early Progress` / `## Context for Suffix`,比历史摘要短得多。它的读者是「被保留下来的后半轮」,只需要交代「这一轮原本要干什么、前半段干了什么」,不需要完整的 Progress / Next Steps。

`L903`:

```ts
export { serializeConversation } from "./utils.ts";
```

实现在 `./utils.ts`,但 `packages/agent/src/index.ts` 的具名白名单是从**本文件**导出它的。删掉这一行,包根的 `serializeConversation` 就没了。

### §12 `compact`:一次或两次模型调用(L905–L1001)

管线的第三段,也是唯一会发网络请求的一段。它**不落盘、不改会话树** —— 返回的 `CompactionResult` 由 harness 决定要不要写进树。于是「摘要生成炸了」不会留下半截历史。

`L921–L930` 原样解构 `preparation`。注意 `settings` 也在里面 —— 输出预算要用它,而 `compact()` 的签名里并没有 `settings` 参数。

`L933–L935` 再验一次 `firstKeptEntryId`:`preparation` 可能来自 hook 或调用方手搓,不能只信 §10 验过。

`L942–L971` 是 split turn 的两次调用:

```ts
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const historyResult =
			messagesToSummarize.length > 0
				? await generateSummary(/* … previousSummary … */)
				: ok<string, CompactionError>("No prior history.");
		if (!historyResult.ok) return err(historyResult.error);
		const turnPrefixResult = await generateTurnPrefixSummary(/* … */);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
	}
```

- 条件里的 `turnPrefixMessages.length > 0` 是必要的:少了它,`isSplitTurn` 为真而前缀为空的情形(轮起点恰好等于切点)会走进两次调用,第二次等于拿一段空对话去问模型。
- 历史为空时**不发请求**,直接给一句 `"No prior history."`。注意 else 分支的单次调用**没有**这个短路(见 §5)。
- 任一段失败就整体失败:宁可这次不压,也不要留下一份只讲了一半的摘要。
- 两段用 `---` 和一个显式小标题拼起来,让后续读到这份摘要的模型知道:下面这段讲的是「我正在进行的这一轮」的前半截,而不是更早的历史。

`L989–L990`:

```ts
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
```

文件清单以 `<read-files>` / `<modified-files>` 标签形态附加在摘要**正文之后**。既给模型看,也给下一次压缩继承 —— `details` 里的字段名必须与 `CompactionDetails` 一致。

### §13 `generateTurnPrefixSummary`(L1002–L1066)

不导出,调用方只有 `compact()` 一个。与 §9 的 `generateSummary` 有意保持三处不同:

1. 预算是 `reserveTokens` 的 **0.5**(`L1021–L1024`),不是 0.8 —— 同一次压缩里这已经是第二次调用,两份摘要加起来才该占满 reserve;
2. 没有 `previousSummary` / `customInstructions` 通道 —— 前缀摘要不参与「更新式」链条;
3. 用 `TURN_PREFIX_SUMMARIZATION_PROMPT`。

系统提示词、`reasoning` 判断、错误码全部复用同一套,只有错误文案加了 `Turn prefix` 前缀 —— 两次调用的错误码相同,不加前缀就没法从日志里分辨是历史摘要炸了还是前缀摘要炸了。

---

## 5. 会咬人的地方

1. **`findCutPoint` 的「往前拽」循环会造出假的 split turn(L581–L590)。** 拽完之后 `cutEntry` 很可能不再是 `message` 条目,于是 `L593` 的 `isUserMessage` 判假、`L595` 走 `findTurnStartIndex` —— 而它只往**回**找,于是找到的是**上一轮**的起点。
   举个能跑的例子:`[user0, assistant0, user1, assistant1, model_change, user2, assistant2]`(`boundaryStart = 0`),预算刚好让切点落在 `user2`(下标 5)。拽过 `model_change` 之后 `cutIndex = 4`,`isUserMessage = false`,`findTurnStartIndex` 从 4 往回找到 `user1`(下标 2),`isSplitTurn = true`。于是 `historyEnd = 2`,**一整轮完整对话(user1 + assistant1)被当成「某一轮的前缀」**送去 `TURN_PREFIX_SUMMARIZATION_PROMPT`,而那份提示词开头写着 *This is the PREFIX of a turn that was too large to keep*。内容不会丢,所以一直没人发现;代价是本该一次的 `generateSummary` 变成两次调用 + 一份用错框架的摘要。
   注意「多一次调用」有个例外:被拽出来的轮起点恰好等于 `boundaryStart` 时(比如上例砍成 `[user1, assistant1, model_change, user2, assistant2]`),`messagesToSummarize` 为空,`compact()` 把历史那次短路成 `"No prior history."`,总调用数仍是一次 —— 只剩「用错提示词框架」这一项代价。测试没有覆盖「配置类条目紧挨在 user 消息前面」这个组合。
2. **切点预算看不见 `branch_summary` / `custom_message` 的体量(L553–L555)。** 累加循环开头 `if (entry.type !== "message") continue`,而这两种条目**是**合法切点、也**会**投影成消息。一段插了大量 `custom_message`(比如应用注入的长文档)的会话,`keepRecentTokens` 会被显著低估,压完之后保留的原文比预期多得多。
3. **`generateSummary` 不校验空摘要(L776–L781)。** 模型返回零个 `text` 块时 `textContent` 是空串,函数照样 `ok("")`,`compact()` 拼上文件清单就返回,harness 直接落盘。结果是一条 summary 只有 `<read-files>` 标签的 compaction 条目 —— 之前的历史从投影里消失了,而摘要什么都没说。§13 的收尾同样不校验。
4. **`compact()` 的单次调用分支没有「历史为空」短路(L972–L985)。** split turn 分支专门用 `messagesToSummarize.length > 0` 挡了一道,else 分支却没有:`messagesToSummarize` 为空时照样发一次请求,让模型去总结一段空 `<conversation>`。触发条件是 `findCutPoint` 返回的切点等于 `boundaryStart`(例如区间里一个合法切点都没有)。
5. **`shouldCompact` 不防 `contextWindow <= 0`(L352–L355)。** 阈值会变成负数,于是任何会话都判「该压」。这道 guard 只在宿主(`kernel/src/host/compaction.ts` 的 `no_context_window`)里有;直接拿这个函数当 API 用的新调用方必须自己补。
6. **`getMessageFromEntry` 的 `compaction` 分支在本文件里不可达(L178–L180)。** 唯一的调用方是 `getMessageFromEntryForCompaction`,它先把 `compaction` 拦掉了。改这一支不会有任何效果 —— 真正生效的同名逻辑在 `session.ts` 的 `sessionEntryToContextMessages` 和 `branch-summarization.ts` 的同名姊妹函数里。
7. **`prepareCompaction` 里 `firstKeptEntryId` 找不到时是静默降级(L821–L824)。** 退回 `prevCompactionIndex + 1`,代价是 `[firstKept, compaction)` 那段原文这次不会被重新摘要 —— 它已经不在本次区间里,但它仍然在投影里,于是下次上下文照样带着它。没有任何告警。
8. **`tokensBefore` 是「投影之后」的数(L831)。** 它是「压之前这次上下文有多大」,不是「这个会话历史一共多大」。UI 上把它当成「本次压缩省了多少」来展示是**错的** —— 省下的是 `tokensBefore` 减去压缩后的上下文,而后者这里根本没算。
9. **`estimateTokens` 对中文系统性低估(L385 起)。** `chars / 4` 是英文的经验值,中文一个字往往就要 0.6~1 token。中文会话因此压得偏晚,这也是 `reserveTokens` 留到 16384 的原因之一。
10. **【与注释不符】本文件的四个导出类型 + `SUMMARIZATION_SYSTEM_PROMPT` 从包根拿不到。** `packages/agent/src/index.ts` 的 L42–L55 对两个 compaction 模块用具名白名单,最早给的理由是「compaction 模块内部还定义了与 `harness/types.ts` 同名的类型」—— 实测两边**零个**同名导出,这条理由核不上(该文件 L51–L55 已经自己用 tsgo 把它证伪并留了记录),是历史残留。后果是 `CompactionDetails` / `CompactionResult` / `ContextUsageEstimate` / `CutPointResult` 这四个类型加上 `SUMMARIZATION_SYSTEM_PROMPT` 都不在白名单里,从 `@yoma/my-pi` 包根 import 不到(当前没有包外消费者,所以还没暴雷)。这条与全景篇 §6.1 的记录一致(全景篇 L221 那句「见 §7」指错了节)。
11. **`DEFAULT_COMPACTION_SETTINGS.enabled` 只被 `shouldCompact` 读。** 把它设成 `false` 不会阻止任何人直接调 `prepareCompaction` / `compact` —— 手动 `/compact` 走的正是这条路。这是设计,不是 bug,但从「关掉压缩」的字面意思看容易误判。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/ai/src/types.ts` + `models.ts`(都经包根 `@earendil-works/pi-ai`) | 只拿类型:`Usage`(types.ts:343)/ `Model`(types.ts:690)/ `AssistantMessage` / `TextContent` / `ImageContent`,以及 `Models`(models.ts:80) |
| 它 import | `packages/agent/src/types.ts` | `AgentMessage`(七种 role 的联合)、`ThinkingLevel` |
| 它 import | `packages/agent/src/harness/messages.ts` | `convertToLlm` + 三个自定义消息构造器 |
| 它 import | `packages/agent/src/harness/session/session.ts` | `buildSessionContext`,只为算 `tokensBefore` |
| 它 import | `packages/agent/src/harness/types.ts` | `CompactionSettings` / `CompactionPreparation` / `FileOperations` / `Result` / `CompactionError` |
| 它 import | `packages/agent/src/harness/compaction/utils.ts` | `createFileOps` / `extractFileOpsFromMessage` / `computeFileLists` / `formatFileOperations` / `serializeConversation` |
| import 它 | `packages/agent/src/harness/agent-harness.ts:71`(调用点在 `:1291`) | `compact` / `prepareCompaction` / `DEFAULT_COMPACTION_SETTINGS` —— 唯一的落盘方 |
| import 它 | `packages/agent/src/harness/compaction/branch-summarization.ts:37` | 借用 `estimateTokens` 和 `SUMMARIZATION_SYSTEM_PROMPT` |
| import 它 | `packages/agent/src/index.ts:72–85` | 具名白名单再导出(12 个符号,见 §5 第 10 条) |
| 消费它(包外) | `packages/kernel/src/host/compaction.ts` | 自动压缩策略:`estimateContextTokens` + `shouldCompact` + 两个 guard |
| 消费它(包外) | `packages/coding-agent/src/acp/agent.ts:175/193` | 同构的第二实现,**数值必须与宿主同步** |
| 兑现它 | `packages/agent/src/harness/session/session.ts` `defaultContextEntryTransform` | 压缩的效果完全由这个投影函数兑现 |
| 测它 | `packages/agent/test/harness/compaction.test.ts`(656 行,20 个测试) | 全程离线,用 `fauxProvider` 假模型 |

---

## 7. 自测题

**Q1.** 把 `findValidCutPoints` 里 `case "toolResult": break;` 改成 `case "toolResult": cutPoints.push(i); break;`,会发生什么?什么时候才看得见?

<details><summary>答案</summary>

`toolResult` 会变成合法切点。一旦切点真的落在它上面,被保留的历史就从一条孤儿工具结果开始 —— 它对应的 `toolCall` 在上一条 assistant 消息里,而那条消息已经被摘要顶替掉了。provider 收到「有 tool result 却没有对应 tool call」的请求会**直接拒收整个请求**。

看得见的时机很晚:单测大概率不炸(测试里的假 provider 不校验配对),压缩本身也成功落盘,要等到**压缩之后的下一次真实请求**才报错。表现是「压完就再也发不出去」,而错误信息指向 provider 而不是压缩代码。

</details>

**Q2.** 一个会话的最近一轮是「一条 user 指令 + 40 次工具往返」,总计 60000 token,而 `keepRecentTokens` 是 20000。切点会落在哪?会发生几次模型调用?

<details><summary>答案</summary>

从最新往回累加,累到 20000 时还在这一轮内部,于是取该位置之后的第一个合法切点 —— 那会是一条 `assistant` 消息(工具往返里 user 消息只有一条,在轮首)。`isUserMessage` 为假,`findTurnStartIndex` 往回找到轮首那条 user 消息,`isSplitTurn = true`。

**两次**模型调用:一次 `generateSummary` 摘要 `[boundaryStart, turnStartIndex)` 的历史(预算 `0.8 × reserveTokens`),一次 `generateTurnPrefixSummary` 摘要 `[turnStartIndex, cutIndex)` 这半轮(预算 `0.5 × reserveTokens`),最后用 `---` 拼起来。

如果历史区间恰好为空(比如这就是会话的第一轮),第一次调用被短路成字符串 `"No prior history."`,只发一次请求。

</details>

**Q3.** 把 `getAssistantUsage` 里的 `calculateContextTokens(assistantMsg.usage) > 0` 这个条件删掉,自动压缩会怎么坏?

<details><summary>答案</summary>

流式请求被中途打断时会留下一条 usage 全为 0 的 assistant 消息。删掉这个条件后,`getLastAssistantUsageInfo` 会认它当基准,于是 `estimateContextTokens` 返回的 `usageTokens = 0`,`trailingTokens` 只覆盖它**之后**的那几条消息 —— 整段真实上下文(可能十几万 token)瞬间"消失"。

`shouldCompact` 因此判「远没到阈值」,该压的会话不压,一路撑到撞窗口。而且 `lastUsageIndex` 不是 `null`,宿主的 Guard 1 也拦不住 —— 它只判「有没有 usage」,不判「usage 是不是 0」。

坏得很安静:没有报错,只是压缩再也不触发。

</details>

**Q4.** `prepareCompaction` 算 `tokensBefore` 用的是 `buildSessionContext(pathEntries).messages`。如果改成直接对 `pathEntries` 里的每条 message 条目求 `estimateTokens` 相加,会有什么区别?

<details><summary>答案</summary>

区别在于**有没有应用上一条 compaction 的投影**。

`buildSessionContext` 会先跑 `defaultContextEntryTransform`,把上一条 compaction 之前的历史隐去、换成一条摘要消息。所以现在的 `tokensBefore` 是「**这次**发给模型的上下文有多大」。

直接对全部条目求和的话,拿到的是「这个会话从头到尾一共多少 token」—— 一个只增不减、和当前上下文压力毫无关系的数。第二次压缩时两者会差出很远(第一次被压掉的那段会重新被计进去)。

`tokensBefore` 只作展示 / 记账,不参与任何判断,所以改了不会让压缩行为出错 —— 但 UI 上那个「压缩前 N tokens」会变成一个误导性的数字。

</details>

**Q5.** hook 提供的 compaction(`fromHook: true`)的 `details` 为什么不被继承?如果去掉 `!prevCompaction.fromHook` 这个判断会怎样?

<details><summary>答案</summary>

因为 hook 是应用层的注入点:`session_before_compact` 允许应用自己去调别的模型、走缓存、甚至返回一份手写摘要。它返回的 `details` 是**任意形状**的 `unknown`,内核不能假定里面有 `readFiles` / `modifiedFiles`。

去掉判断之后,代码会走进 `Array.isArray(details.readFiles)` 分支 —— 大多数情况下这个属性是 `undefined`,`Array.isArray` 判假,于是**什么也不会发生**,不会抛。所以这不是一个会炸的 bug,而是一个「碰巧安全」的假设。

真正的风险在于形状**巧合匹配**:应用如果在自己的 details 里用了同名的 `readFiles` 字段表达别的意思(比如相对路径、或者带行号的引用),那些值会被静默灌进内核的文件清单,最后原样出现在下一份摘要的 `<read-files>` 标签里。

</details>
