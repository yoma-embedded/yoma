# packages/agent/src/harness/compaction/branch-summarization.ts

> **档位** B(分段) · **行数** 363 · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3(第三组:"fork 与 LCA"、"分支摘要 vs 普通压缩")、§5.2 接线表 · **索引** [README](../README.md)

## 1. 一句话

`navigateTree()` 把会话的 leaf 挪到树上另一处时,原来那条分支会离开投影(不删除,但下次读上下文再也看不到)——本文件负责求出两条路径的最深公共祖先(LCA)、把"被抛下的那段"收集出来、在 token 预算内从最新往回裁剪、丢给模型生成一份结构化摘要,挂在新 leaf 下面。

## 2. 它在全景里的位置

先厘清触发场景:会话是一棵树(全景篇 §3 第三组),`leafId` 是唯一游标。正常对话是"追加即前进"的直链,只有一种情况会产生分支——应用调 `AgentHarness.navigateTree(targetId)` 把 leaf 挪到树中间某个旧条目上(典型场景:编辑之前的一条消息重发、在 UI 里切回某个更早的分支)。navigateTree 是与 `compact()` 并列的 **idle-only 侧枝**:两者都要求相位机处于 idle,执行期间把相位切到 `branch_summary`/`compaction`,结束后才回到 idle——它们不在全景篇 §4 描述的"一次 prompt 的 48 步生命周期"这条主链上,而是主链之外、可以随时被应用触发的独立操作。

`navigateTree()`(`agent-harness.ts:1359`)自己不算 LCA、不裁剪、不调模型——这三件事全部委托给本文件:先调 `collectEntriesForBranchSummary` 求出旧 leaf 与目标之间的 LCA、拿到被抛下的那段条目;如果调用方要求生成摘要(`options.summarize`)且没有 `session_before_tree` 钩子直接提供现成摘要,就调 `generateBranchSummary` 发一次摘要请求;最后 navigateTree 拿着结果调 `session.moveTo(newLeafId, {summary, ...})` 落盘一条 `branch_summary` 条目,这才是全书唯一的落盘点之一(全景篇 §1 三要点第 3 条明确把 `compact()`/`navigateTree()` 列为"唯一落盘点"规则的两条例外侧枝)。

如果这个文件不存在:`navigateTree()` 依然能移动 leaf(`session.moveTo` 本身不依赖它),但被抛下的分支不会留下任何痕迹——下一次模型读到的上下文里,"刚才在另一条路上探索过什么"整个消失,表现为一种"看不见的失忆"。分支摘要与压缩(compaction)常被混为一谈,但触发时机和目的正交:压缩是**纵向**的(同一条路径太长,把靠前一段换成摘要,省窗口);分支摘要是**横向**的(离开了一条路径,把整段换成一份"旁支报告",防止遗忘)。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–98 | 文件头两段注释(原始 + 新增职责/分节)、依赖 import、四个导出类型(`BranchSummaryDetails` / `BranchPreparation` / `CollectEntriesResult` / `GenerateBranchSummaryOptions`) |
| §2 | L99–140 | `collectEntriesForBranchSummary`:求 LCA,收集被抛下的分支 |
| §3 | L141–171 | `getMessageFromEntry`:条目 → 消息投影,显式排除 `toolResult` |
| §4 | L172–228 | `prepareBranchEntries`:继承文件清单 + 预算内从最新往回填 |
| §5 | L229–270 | 摘要提示词模板:`BRANCH_SUMMARY_PREAMBLE` / `BRANCH_SUMMARY_PROMPT` |
| §6 | L271–363 | `generateBranchSummary`:编排——估算预算、调模型、组装结果 |

## 4. 逐节讲解

### §1 依赖与类型定义(L1–98)

四个导出类型描述了这条流水线的三段中间结果:

- `CollectEntriesResult`(L73)——§2 的输出:`entries`(时间正序的被抛下条目)+ `commonAncestorId`。
- `BranchPreparation`(L60)——§4 的输出:挑出来的消息、累积的文件操作、估算 token 数。
- `BranchSummaryDetails`(L50)——挂在生成的 `branch_summary` 条目 `details` 字段上的形状,下次这条分支再被摘要(嵌套 navigateTree)时会被 §4 读回去当"继承来的文件清单"。
- `GenerateBranchSummaryOptions`(L84)——§6 主函数的入参,`reserveTokens` 默认 16384,是硬编码默认值而非像 `compact()` 那样可配置——分支摘要不是常跑的路径。

```ts
// L35–37
import type { BranchSummaryResult, FileOperations, Result, SessionTreeEntry } from "../types.ts";
import { BranchSummaryError, err, ok, SessionError } from "../types.ts";
import { estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.ts";
```

值得注意的是它从 `compaction.ts` 只借了两样东西:字符启发式的 `estimateTokens` 与摘要系统提示词 `SUMMARIZATION_SYSTEM_PROMPT`。真正的用户提示词(§5)是本文件独立的一份,不与压缩共用——两者的读者预期不同(见 §2)。

### §2 `collectEntriesForBranchSummary`(L99–140)

```ts
// L106–122
if (!oldLeafId) {
	return { entries: [], commonAncestorId: null };
}
const oldPath = new Set((await session.getBranch(oldLeafId)).map((e) => e.id));
const targetPath = await session.getBranch(targetId);
let commonAncestorId: string | null = null;
for (let i = targetPath.length - 1; i >= 0; i--) {
	if (oldPath.has(targetPath[i]!.id)) {
		commonAncestorId = targetPath[i]!.id;
		break;
	}
}
```

`oldLeafId` 为 `null` 只发生在 navigateTree 第一次被调用时(没有"上一条分支"可言),此时直接返回空结果——`generateBranchSummary` 后面会因为 `entries.length === 0` 而短路,连模型都不会调。

LCA 的求法:`session.getBranch(id)` 返回从根到该 id 的完整路径(`getPathToRoot`,root→leaf 顺序),`oldPath` 是这条路径 id 的集合。`targetPath` 同样按 root→leaf 排列,于是从数组末尾(leaf 端)往根方向扫,第一个出现在 `oldPath` 里的节点就是离 target 最近的公共节点——即最深公共祖先。因为两条路径同属一棵树,只要 `oldLeafId` 非空就必然至少在根节点相遇,`commonAncestorId` 不会因为"两条路径无交点"而为 null。

```ts
// L124–136
let current: string | null = oldLeafId;
while (current && current !== commonAncestorId) {
	const entry = await session.getEntry(current);
	if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
	entries.push(entry as SessionTreeEntry);
	current = entry.parentId;
}
entries.reverse();
```

从旧 leaf 沿 `parentId` 往上走,收集到 LCA 为止(不含 LCA 本身);`commonAncestorId` 为 null 时会一路走到根。push 的顺序是"新→旧",最后 `reverse()` 成"旧→新"的时间正序,供 §4 使用。这里抛出的是 `SessionError`(`invalid_session`),**不是** `BranchSummaryError`——见 §5 的第一条。

### §3 `getMessageFromEntry`(L141–171)

一个模块内私有函数,把 `SessionTreeEntry`(树上的条目)投影成 `AgentMessage`(能进摘要对话的消息)。11 种条目类型里只有 4 种产生消息:

```ts
// L148–168
case "message":
	if (entry.message.role === "toolResult") return undefined;
	return entry.message;
case "custom_message":
	return createCustomMessage(...);
case "branch_summary":
	return createBranchSummaryMessage(...);
case "compaction":
	return createCompactionSummaryMessage(...);
case "thinking_level_change": case "model_change": /* … */ case "leaf":
	return undefined;
```

`toolResult` 被显式排除的原因和压缩(compaction)里的"合法切点"规则同源:一条 `toolResult` 只有紧跟在配对的 `toolCall` 后面才有意义,摘要要是单独把它捞出来,读者(下一次的模型)看到的是一段没头没脑的"结果"。其余配置类条目(换模型、改标签、leaf 指针本身……)对"这条分支在做什么"没有信息量,直接返回 `undefined`,§4 遇到 `undefined` 会静默 `continue` 跳过。

### §4 `prepareBranchEntries`(L172–228)

分两个循环,职责不同。

**继承文件清单**(L181–198):

```ts
// L187
if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
```

`!entry.fromHook` 是关键守卫。`fromHook` 为 `true` 说明这条 `branch_summary` 条目是 `session_before_tree` 钩子直接提供的现成摘要(`navigateTree()` 里 `fromHook: hookResult?.summary !== undefined`),它的 `details` 形状完全由钩子作者自定,不能假定长得像 `BranchSummaryDetails`。只有本函数自己生成的摘要(走 §6 那条路)才敢把 `details` 强转成 `BranchSummaryDetails` 读。

**预算内从最新往回填**(L200–224):

```ts
// L200–224
for (let i = entries.length - 1; i >= 0; i--) {
	const entry = entries[i]!;
	const message = getMessageFromEntry(entry);
	if (!message) continue;
	extractFileOpsFromMessage(message, fileOps);

	const tokens = estimateTokens(message);
	if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (totalTokens < tokenBudget * 0.9) {
				messages.unshift(message);
				totalTokens += tokens;
			}
		}
		break;
	}

	messages.unshift(message);
	totalTokens += tokens;
}
```

倒序遍历(从最新的条目开始),`tokenBudget` 为 0 表示不设预算(全部塞进去,单测/无预算场景)。一旦某条超出预算,只有一种例外能继续塞:它是 `compaction` 或 `branch_summary` 类型(信息密度高)且预算还剩一成以上。**不满足例外时直接 `break` 整体收尾**——不会跳过这条超大条目继续尝试更早、可能更小的条目。这是刻意的:保证保留下来的窗口是连续的一段最近时间,不出现"中间挖空"的摘要;代价是一条异常大的工具结果会提前砍掉它之前原本装得下的内容(见 §5)。

### §5 摘要提示词模板(L229–270)

```ts
// L233–236
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;
```

`PREAMBLE` **不会**发给模型——它是模型出结果之后才拼在摘要正文前面的一句话(见 §6 的 L349),说明"这段文字是给谁看的":下一次读到这条摘要的不是这次生成它的模型,而是挂在新 leaf 下、将来某一轮读上下文的模型。

`BRANCH_SUMMARY_PROMPT`(L242–269)是固定的六段式结构(Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps)。它与 `compaction.ts` 的摘要提示词是两份完全独立的文案,不共用——压缩摘要要接得上"正在进行的这轮对话",分支摘要只是一段"旁支报告",更看重"这条分支做到哪了、下次回来接着干什么"。

### §6 `generateBranchSummary`(L271–363)

主函数,五步走:

1. **算预算**(L277–283):`contextWindow` 没有时兜底 128000,`tokenBudget = contextWindow - reserveTokens`,交给 `prepareBranchEntries`(§4)。
2. **短路径**(L285–290):`messages.length === 0`(比如 LCA 就是 `oldLeafId` 本身,或全被 §3 过滤掉)直接返回 `"No content to summarize"`,不调模型。
3. **拼提示词**(L291–308):`convertToLlm` 是全仓唯一的 `AgentMessage → pi-ai Message` 转换点(全景篇 §1"只有一个 LLM 边界"),这里对挑出来的分支消息复用同一条路径;`serializeConversation`(`utils.ts`)转成纯文本塞进 `<conversation>` 标签;`replaceInstructions`/`customInstructions` 可能来自调用方,也可能来自 `session_before_tree` 钩子的返回值。
4. **发请求**(L310–325):`maxTokens` **硬编码 2048**,不像压缩那样跟着 `reserveTokens` 走——分支摘要要的是"下次回来能看懂"的一段提要,不是详尽记录。
5. **组装结果**(L326–362):按 `stopReason` 分两种失败(`aborted` / `summarization_failed`,见 §5 第一条);成功时只取 `text` 块拼正文,前面加 `PREAMBLE`,后面用 `computeFileLists` + `formatFileOperations`(均来自 `utils.ts`)拼上 `<read-files>`/`<modified-files>` 标签——与压缩摘要的格式完全一致,方便下次读它的模型用同一套解析预期。

## 5. 会咬人的地方

- **【L215–219】预算耗尽即整体 `break`,不会回头找更早、可能更小的条目。** 一条异常大的工具结果会提前砍掉它之前原本装得下的所有内容;好处是保留窗口始终连续,不会"中间挖空"。改代码前想清楚这条取舍,不要想当然地把 `break` 改成 `continue`。
- **【L182–187】`fromHook` 守卫。** 钩子(`session_before_tree`)提供的 `branch_summary.details` 形状不受本文件保证,`prepareBranchEntries` 靠 `!entry.fromHook` 挡住,不会把它当 `BranchSummaryDetails` 强转着读。反过来说,如果哪天这个守卫被误删,读到形状不对的 `details` 会静默产出垃圾文件清单(`Array.isArray` 检查能兜住"完全不是数组"的情况,但兜不住"数组里装的不是文件路径"这种)。
- **【与代码轻微不符】`BranchSummaryErrorCode` 声明了三种(`"aborted" | "summarization_failed" | "invalid_session"`,`types.ts:701`),但全文件(乃至全仓)只在 §6 的 L331/335 构造了前两种 `BranchSummaryError`。第三种 `"invalid_session"` 目前没有任何地方把它构造成 `BranchSummaryError`——§2(L130)抛的是另一个异常类 `SessionError`,传到 `agent-harness.ts:navigateTree()` 的 catch 块后,会被 `normalizeHarnessError` 归一化成 `AgentHarnessError`,`code` 是 `"session"` 而不是 `"branch_summary"`。也就是说"分支摘要过程中断链"这类错误,在应用层看到的错误分类其实和"压缩过程中断链"是一样的(`"session"`),不会被识别成分支摘要特有的问题。这不是 bug,只是类型声明比实际实现宽——读代码时别以为捕获 `BranchSummaryError` 就能兜住所有分支摘要失败路径。
- **本文件没有专门的测试文件。** `packages/agent/test/` 下没有任何文件引用 `collectEntriesForBranchSummary` / `generateBranchSummary` / `prepareBranchEntries`(已用 grep 核实),覆盖率完全依赖 `navigateTree()` 这条侧枝本身有没有被测到——而全景篇 §7 已经指出 `compact()` 与 `navigateTree()` 都还没有针对 harness 方法本身的测试。改这个文件时格外要靠手动验证。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `../../types.ts` | `AgentMessage` |
| 它 import | `../messages.ts` | `convertToLlm` / `createBranchSummaryMessage` / `createCompactionSummaryMessage` / `createCustomMessage` |
| 它 import | `../session/session.ts` | `Session`(只用其 `getBranch` / `getEntry`) |
| 它 import | `../types.ts` | `BranchSummaryResult` / `FileOperations` / `Result` / `SessionTreeEntry` / `BranchSummaryError` / `err` / `ok` / `SessionError` |
| 它 import | `./compaction.ts` | `estimateTokens`(token 估算)、`SUMMARIZATION_SYSTEM_PROMPT`(系统提示词) |
| 它 import | `./utils.ts` | `computeFileLists` / `createFileOps` / `extractFileOpsFromMessage` / `formatFileOperations` / `serializeConversation`(与 compaction 共用的纯函数) |
| import 它 | `../agent-harness.ts` | 唯一生产调用方:`navigateTree()`(:1359)调 `collectEntriesForBranchSummary` 求 LCA,视情况调 `generateBranchSummary`,最后用结果调 `session.moveTo`(:1445)落盘 |
| import 它 | `../../index.ts` | 包根 barrel 白名单导出 `BranchPreparation` / `BranchSummaryDetails` / `CollectEntriesResult` / `collectEntriesForBranchSummary` / `generateBranchSummary` / `prepareBranchEntries` 六个符号,`GenerateBranchSummaryOptions` 等其余类型只能深引用拿到 |

## 7. 自测题

**Q1. 如果 `navigateTree()` 是会话建好之后第一次被调用(还没跑过任何一轮,`oldLeafId` 为 `null`),`collectEntriesForBranchSummary` 会返回什么?`generateBranchSummary` 会不会真的去请求模型?**

<details><summary>答案</summary>

`collectEntriesForBranchSummary` 在 L108 直接早退,返回 `{ entries: [], commonAncestorId: null }`。`generateBranchSummary` 拿到空 `entries`,`prepareBranchEntries` 自然产出空 `messages`,L288 的 `messages.length === 0` 短路径直接返回 `"No content to summarize"`,**不会**发起任何模型请求。

</details>

**Q2. 把 §4(L219)的 `break` 改成 `continue` 会有什么后果?**

<details><summary>答案</summary>

循环会跳过那条"太大装不下"的条目,继续尝试更早、可能更小的条目——摘要窗口就不再是"最近一段连续时间",而可能出现"中间挖空"(比如最近第 3 条工具结果特别大被跳过,但更早的第 4、5 条又被塞进去了)。当前实现刻意用 `break` 保证连续性,这是一处需要谨慎改动的取舍点。

</details>

**Q3. `session_before_tree` 钩子自己提供了 `summary.details`(形状与 `BranchSummaryDetails` 不同)。这条分支之后再被摘要一次时,`prepareBranchEntries` 会不会把这份 `details` 当文件清单继承进去?**

<details><summary>答案</summary>

不会。`navigateTree()`(`agent-harness.ts:1445` 附近调 `session.moveTo` 那一行)落盘时会把这条 `branch_summary` 条目的 `fromHook` 置为 `true`(因为 `hookResult?.summary !== undefined`)。`prepareBranchEntries` 的守卫 `entry.type === "branch_summary" && !entry.fromHook && entry.details` 会因为 `fromHook` 为真而跳过它,不会强转读取。

</details>

**Q4. `generateBranchSummary` 里为什么要先调 `convertToLlm` 再调 `serializeConversation`,而不是直接把 `prepareBranchEntries` 选出来的 `AgentMessage[]` 序列化?**

<details><summary>答案</summary>

`AgentMessage` 是内部形状,可以携带自定义 role(`branchSummary` / `compactionSummary` / `custom` / `bashExecution` 等,声明合并进 `CustomAgentMessages`);`serializeConversation`(`utils.ts`)只认 `user` / `assistant` / `toolResult` 三种 pi-ai 原生 role。`convertToLlm` 是全仓唯一的 `AgentMessage → pi-ai Message` 转换点,负责把自定义 role 投影成 LLM/摘要函数认得的形状。跳过它直接序列化,自定义消息(比如"这条分支上又嵌套了一条更早的分支摘要")会被 `serializeConversation` 悄悄漏掉,摘要就会丢信息而不报错。

</details>

**Q5. 为什么 §5 的 `BRANCH_SUMMARY_PROMPT` 不直接复用 `compaction.ts` 里的摘要提示词,而要单独写一份?**

<details><summary>答案</summary>

两者的读者预期不同。压缩摘要要接得上"正在进行的这轮对话",格式(见 `compaction.ts`)偏向保留上下文连续性;分支摘要面对的是一条已经离开投影的"旁支",读者更关心"这条分支的目标是什么、做到哪一步了、下次回来该接着干什么"——`BRANCH_SUMMARY_PROMPT` 的六段式结构(尤其是 Progress 里 Done/In Progress/Blocked 三个子项和 Next Steps)正是为这种"稍后回顾"场景设计的。两份提示词共用同一个系统提示词(`SUMMARIZATION_SYSTEM_PROMPT`),但用户提示词各自独立。

</details>
