# packages/agent/src/harness/compaction/utils.ts

> **档位** A(逐行) · **行数** 302(加注释后;原始 140) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §3「第四组:上下文管理」/ §4 第 47 步 / §6.1 · **索引** [README](../README.md)

## 1. 一句话

压缩(compaction)与分支摘要(branch summarization)共用的五个**纯函数**:一半负责「这段历史里读过 / 改过哪些文件」的清单,另一半负责把一串消息拍平成喂给摘要模型的纯文本。

---

## 2. 它在全景里的位置

先把两个词说清楚。**compaction(压缩)**:一次对话越滚越长,迟早撑爆模型的上下文窗口;压缩就是「把靠前的一大段历史交给模型总结成一段摘要,然后在投影里用这段摘要顶替原文」。**branch summarization(分支摘要)**:会话是一棵树,`navigateTree` 把当前叶子挪到树上另一处时,原来那条分支整个离开视野,先给它做一份摘要挂在新叶子下面。两件事目的不同(一个省窗口、一个保记忆),但「把一堆消息变成一段摘要」这一步的做法完全一样 —— 本文件就是那一步里被两边共用的零件。

对应全景篇 §4「阶段 7 · 第 47 步」自动压缩。那一步的链路是:宿主(`kernel/src/host/compaction.ts`)算出该压了 → `harness.compact()` → `prepareCompaction()` → `compact()`。本文件在这条链路上出现在三个阶段(调用点不止三个:光 `compaction.ts` 里就有 7 处):

1. **取材**:`prepareCompaction` 内部的 `extractFileOperations` 先 `createFileOps()` 造一个空累加器(§2),把上一条 compaction 条目 `details` 里的清单继承进来,再对每条要压掉的消息调 `extractFileOpsFromMessage`(§3)。
2. **序列化**:`compact()` → `generateSummary()` 调 `serializeConversation`(§7),把 `convertToLlm()` 转换出来的 `Message[]` 拍成一整块纯文本,包进 `<conversation>` 标签当作摘要请求的提示词。split turn 那条支路的 `generateTurnPrefixSummary` 也调它。
3. **收尾**:摘要文本拿到手后,`compact()` 调 `computeFileLists`(§4)把累加器折算成两份排好序的清单,再调 `formatFileOperations`(§5)把清单拼成 `<read-files>` / `<modified-files>` 两个块**追加在摘要正文末尾**;同一份清单还原样写进新 compaction 条目的 `details` —— 下一次压缩靠它继承(全景篇 §3 说的「连续压缩不逐次遗忘」的第二条对策)。

`branch-summarization.ts` 的 `prepareBranchEntries` / `generateBranchSummary` 走的是同一组函数,继承来源换成分支上更早的 `branch_summary` 条目,并且**额外带一个 token 预算**(见 §5「会咬人的地方」第 3 条)。

**上游是谁**:序列化函数的输入必须先过 `harness/messages.ts` 的 `convertToLlm()`。那是全内核唯一的 LLM 边界,四个自定义角色(`bashExecution` / `custom` / `branchSummary` / `compactionSummary`)在那里被投影成 `user` 消息;所以 `serializeConversation` 只需要认 `user` / `assistant` / `toolResult` 三种。而 `extractFileOpsFromMessage` 收的是**更宽**的 `AgentMessage`,因为它跑在 `convertToLlm` 之前。

**不存在会怎样**:`serializeConversation` 没了,摘要模型就没有输入,压缩这条路整个断掉;文件清单那四个函数没了,压缩仍然能跑,但摘要末尾不再有文件列表 —— 连着压两三次之后,模型对「我两小时前动过哪些文件」会完全失忆,在嵌入式调试这种一个 bug 跨几十轮的场景里代价很直接。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 原始头注释 | L1–L4 | 原作者的四行文件头(**未改动**) |
| 文件头块注释 | L5–L32 | 本次补充:职责、全景位置、文档路径、分节索引 |
| §1 | L34–L45 | imports:三个纯类型,运行时零依赖 |
| §2 | L47–L61 | `createFileOps` —— 空累加器 |
| §3 | L63–L121 | `extractFileOpsFromMessage` —— 从 assistant 的 toolCall 里认 read/write/edit |
| §4 | L123–L142 | `computeFileLists` —— read 减去 modified,两侧各自排序 |
| §5 | L144–L170 | `formatFileOperations` —— 拼成 `<read-files>` / `<modified-files>` 尾巴 |
| §6 | L172–L212 | 三个私有件:`TOOL_RESULT_MAX_CHARS` / `safeJsonStringify` / `truncateForSummary` |
| §7 | L214–L302 | `serializeConversation` —— `Message[]` → 摘要提示词里的纯文本 |

---

## 4. 逐节讲解

### §1 imports:三个纯类型(L34–L45)

`L38–L45`

```ts
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import type { FileOperations } from "../types.ts";
```

三条全是 `import type` —— 编译后一个字节都不剩,这个文件的运行时依赖是**零**。三个类型各管一件事:

- **`Message`**(pi-ai):LLM 边界上的消息,`UserMessage | AssistantMessage | ToolResultMessage` 的**闭合联合**,只有这三种角色。§7 收的就是它,所以 §7 的 `if / else if / else if` 三分支是穷尽的,不存在「漏掉某种角色」。
- **`AgentMessage`**(agent 包 `types.ts`):`Message` 加上四个自定义角色。§3 收的是这个更宽的类型 —— 它跑在 `convertToLlm` **之前**,`prepareCompaction` 攒的本来就是 `AgentMessage[]`。
- **`FileOperations`**(`harness/types.ts`):三个 `Set<string>`,字段是 `read` / `written` / `edited`。

第三条对应原始头注释 L4 那句「参考实现在两处各定义了一份,这里只留一份」—— 上游 pi 在 `types.ts` 和这个 utils 里各声明了一遍同名接口,本仓只保留 `harness/types.ts` 那份,这里纯 import。

### §2 createFileOps:空累加器(L47–L61)

`L55–L61`

```ts
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}
```

一个工厂,没有别的。值得说的只有一点:**为什么是 `Set` 而不是数组**。一次长调试里同一个 `.c` 文件会被读几十次、改几次;用数组的话 §4 还得先去重,而且 §3 每次 `add` 都要先线性查一遍。`Set` 把去重变成 O(1),§4 直接展开排序即可。

另一点:返回的对象是给调用方**一路 mutate 的**。§3 的签名是 `(message, fileOps) => void` —— 原地改,不返回新对象。调用方(`extractFileOperations`)因此可以先把继承来的旧清单塞进这三个 Set,再在同一个对象上累加本次的新消息。

### §3 extractFileOpsFromMessage:约定优于配置的取材(L63–L121)

**第一块:两道入口守卫**

`L73–L80`

```ts
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;
```

第一行:只有 assistant 消息里才可能有 `toolCall` 块。`user` / `toolResult` 与四个自定义角色统统直接返回 —— 这顺带把 `bashExecution` 挡在了门外,也就是说**模型用 bash 里的 `sed` / `cat >` 改的文件不会进清单**。

第二行看起来是多余的:类型上 `AssistantMessage.content` 必然是 `(TextContent | ThinkingContent | ToolCall)[]`,`Array.isArray` 永远为真。它是**运行时**防线 —— 这些消息可以是从磁盘 `.jsonl` 重放回来的,而 `jsonl-storage` 是直接 `JSON.parse` 每一行、不做 schema 校验的。老版本文件或被手工编辑过的会话里,`content` 可以是任何东西。删掉这一行,一个坏文件就会让整次压缩在这里抛异常。

**第二块:逐层剥 block**

`L82–L94`

```ts
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;
```

三条守卫是同一件事的三层:是对象吗 → 是 `toolCall` 吗 → 有 `arguments` 和 `name` 吗。少任何一层,都可能在一个不是对象的值上读属性而抛。注意第一条里 `block === null` 必须单独排 —— JS 里 `typeof null === "object"`。

`as Record<string, unknown> | undefined` 是**断言而不是校验**:`arguments` 的具体形状由每个工具自己的 JSON schema 决定,而内核这一层刻意不认识任何具体工具(全景篇 §2.2 反复强调的分层),只能当成一袋键值去摸一个字段。紧接着的 `if (!args)` 兜的是零参数工具调用 —— 类型上不该出现,但这个值是从 provider 的流里解析出来的,与上面三条守卫同一个理由。

**第三块:两条硬编码约定**

`L96–L119`

```ts
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// 约定优于配置:工具名叫 read/write/edit 才被识别 —— 内核不认识具体工具。
		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
```

这里有**两条**硬编码的字面量约定,缺一不可:

1. **参数字段名必须叫 `path`**;
2. **工具名必须是 `read` / `write` / `edit` 三个字面量之一**。

两条都不是类型约束,是与 `packages/coding-agent` 那三个工具的口头约定。这正是全景篇 §6.1 那条「【新】`extractFileOpsFromMessage` 是**约定优于配置**的」。后果:datasheet / flash / gdb / netlist 这些嵌入式工具动过的文件,一律不进摘要的文件清单。

`write` 与 `edit` 分成两个集合,但下一节立刻把它们并成同一个 `modified` —— 当前语义上完全等价,分开存只是给未来「新建 vs 修改」留位置。别以为摘要里能看出这两者的区别。

注意 `switch` 没有 `default`,不认识的工具名静默落地。这是有意的:取材失败只该少一行清单,不该报错。

### §4 computeFileLists:read 减去 modified(L123–L142)

`L132–L142`

```ts
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}
```

三行做了三件事:

**并集**。`edited ∪ written` = 「动过」。§3 分开累加的两个集合在这里合流 —— 这正是全景篇 §6.1 记的那条「继承上次清单时 `modifiedFiles` 被塞进 `fileOps.edited` 而不是 `written`,结果仍然正确,但读代码时会觉得对不上」:因为两个桶在这里被无差别地倒进同一个 `modified`,塞哪个都一样。

**差集**。`read` 里凡是也被动过的一律剔掉。语义决定:告诉模型「这个文件你改过」比「你读过」信息量大,同一个路径同时出现在两份清单里纯属噪音,还白占摘要长度。**一个先 read 后 edit 的文件只会出现在 `modifiedFiles`。**

**排序**。`.sort()` 用的是默认的 UTF-16 码元序,不是 `localeCompare`。要的不是「好看」而是「稳定且可复现」—— 这两份清单要原样写进 `.jsonl` 的 `details`,顺序抖动会让每次压缩落盘的内容无谓地不同,连续压缩时还会让模型觉得文件清单变了。

### §5 formatFileOperations:摘要尾巴上的两个标签(L144–L170)

`L155–L170`

```ts
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}
```

一份清单一个块,块内一行一个路径,块之间空行隔开,整段前面再加一个空行。用 XML 风格标签而不是 markdown 列表:摘要正文本身是 markdown(提示词模板里全是 `## Goal` 这种),标签能让下一轮的模型一眼把「元数据」和「叙述」分开。

两个空列表的处理值得注意。**两份都空时返回空字符串,而不是 `"\n\n"`。** 调用方一律写成 `summary += formatFileOperations(...)`,返回值的首尾空白就是最终摘要的排版;返回 `"\n\n"` 会在摘要末尾平白留下两个空行,而这份摘要正文是要原样进下一轮上下文、被模型读的。

同理,单份为空时那一份的标签整个不出现 —— 不会有空的 `<read-files></read-files>`。

**路径不做 XML 转义**,见 §5「会咬人的地方」第 6 条。

### §6 序列化的三个私有件(L172–L212)

三个都不导出,只服务于 §7。

**上限**

`L178`

```ts
const TOOL_RESULT_MAX_CHARS = 2000;
```

每条工具结果在序列化时最多留 2000 个字符。这是**整条压缩链路上唯一的输入预算控制**:`prepareCompaction` 把 `boundaryStart`(上一条 compaction 记的 `firstKeptEntryId` 所在下标,首次压缩时是 0)到切点之间的历史**全部**拿走 —— 比这更早的原文已由上一条摘要代表、不会再进来,但这一段之内 `messagesToSummarize` 的条数没有上限,而工具结果恰恰是长会话里最占地方的东西(一次 `read` 就可能是几万字符)。调大它,摘要请求本身就有撞窗口的风险;调小,摘要会丢掉「工具到底看见了什么」。

注意它是**每条**的上限,不是总量 —— 50 条工具结果仍然可以贡献 10 万字符。

**安全序列化**

`L190–L196`

```ts
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}
```

两条兜底各管一类:`?? "undefined"` 管 `JSON.stringify` **正常返回 `undefined`** 的情况(值本身是 `undefined` / 函数 / symbol);`catch` 管它**抛**的情况(循环引用、`BigInt`)。

为什么值得这层兜底:它跑在 `harness.compact()` 的 `try` 里,抛出去会被 `normalizeHarnessError` 包成 `AgentHarnessError("compaction")` —— 表现是「这次压缩失败了」,宿主往 transcript 写一条 ⚠️ 就过去了(全景篇 §4 末尾那条铁律),而上下文继续涨,下一轮直接撞窗口。为一个参数打印不出来赔掉整次压缩,不划算。

**带痕截断**

`L205–L212`

```ts
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}
```

未超限时**原样返回同一个字符串**(不复制)。超限时留头砍尾,并在末尾写明砍掉了多少 —— **截断必须留痕**,裸截断会让摘要模型把半截输出当成完整输出,那是「自信地错」,比可见地错糟得多(全景篇 §3「截断」一节对 `truncate.ts` 的同一条纪律)。

单测把这个算式钉住了:`packages/agent/test/harness/compaction.test.ts` 里给 5000 个 `x`,断言输出含 `[... 3000 more characters truncated]`。

### §7 serializeConversation:拍平成纯文本(L214–L302)

**骨架**

`L225–L230` 与 `L301–L302`

```ts
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
	// …
	return parts.join("\n\n");
}
```

先攒段落再 `join`,而不是一路 `+=` 拼串 —— 因为内容为空的消息要能**整段跳过**(下面多处 `if (content)`),用数组表达「这条不产出任何段落」比事后清理多余的分隔符干净。

段落之间是**空行**。这段文本会被包进 `<conversation>` 标签发出去,空行是模型区分「上一条消息结束了」的唯一线索;换成单个换行就会和消息正文内部的换行混淆。

**user 分支**

`L236–L246`

```ts
		const content =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("");
		if (content) parts.push(`[User]: ${content}`);
```

`UserMessage.content` 在 pi-ai 里是 `string | (TextContent | ImageContent)[]`,两种形状都合法,所以先归一。`filter` 只留 `text` —— **图片被整个丢掉**,摘要模型未必是多模态的,而且一张 base64 图能顶掉整个提示词。`join("")` 没有分隔符,相邻两个 text block 会被直接粘在一起。

`if (content)` 让空内容的消息不产生段落 —— 一条纯图片的 user 消息在序列化结果里彻底消失。

**assistant 分支**

`L251–L282`

```ts
		const textParts: string[] = [];
		const thinkingParts: string[] = [];
		const toolCalls: string[] = [];

		for (const block of msg.content) {
			if (block.type === "text") {
				textParts.push(block.text);
			} else if (block.type === "thinking") {
				thinkingParts.push(block.thinking);
			} else if (block.type === "toolCall") {
				const args = block.arguments as Record<string, unknown>;
				const argsStr = Object.entries(args)
					.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
					.join(", ");
				toolCalls.push(`${block.name}(${argsStr})`);
			}
		}
```

三个桶,而不是按原顺序输出。一条 assistant 消息里 text / thinking / toolCall 可以交错出现,这里按**种类**重排,于是原始交错顺序丢失。对摘要来说「它想了什么、说了什么、调了什么」分三行读更清楚,代价是时序信息没了。

工具参数拍成 `k=json, k=json` 而不是整块 `JSON.stringify(args)` —— 这样长参数(比如 `write` 的 `content`)在文本里仍然一眼认得出键名。注意**参数值不截断**:§6 的 2000 字上限只作用于工具结果。

`L274–L282`

```ts
		if (thinkingParts.length > 0) {
			parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
		}
		if (textParts.length > 0) {
			parts.push(`[Assistant]: ${textParts.join("\n")}`);
		}
		if (toolCalls.length > 0) {
			parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		}
```

输出顺序固定 thinking → text → toolCall,与上面攒桶的先后无关。三个桶的分隔符也不同:thinking / text 用换行(同一段话的多个片段),toolCall 用 `; `(并列的几次调用)。三个桶都空时(比如一条纯 error 的 assistant 消息)这条消息不产生任何段落。

**toolResult 分支**

`L287–L295`

```ts
		const content = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		if (content) {
			parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
		}
```

`ToolResultMessage` 上有 `toolName`、`toolCallId`、`isError` 三个字段,**这里一个都不用**。摘要模型只看到一段 `[Tool result]:`,不知道它来自哪个工具、是不是一次失败;配对全靠它紧跟在上一行 `[Assistant tool calls]:` 后面这个位置关系。同样只留 text,图片丢弃。

这里是全函数唯一施加长度上限的地方。

---

## 5. 会咬人的地方

1. **两条硬编码约定,缺一就静默失效(L96–L107)。** 工具名必须是字面量 `read`/`write`/`edit`,参数名必须叫 `path`。新工具叫 `write_file`、或者参数叫 `filePath`,这里都取不到 —— 不报错、不告警,只是摘要少一行。想加工具就得改这个 `switch`,而且要同步看 `compaction.ts` 的 `extractFileOperations` 与 `branch-summarization.ts` 的 `prepareBranchEntries` 两处继承逻辑。(全景篇 §6.1 已记。)

2. **模型在 bash 里改的文件不进清单(L74–L76)。** `bashExecution` 角色在第一道守卫就被挡掉。在嵌入式调试里模型经常用 `sed -i` 或重定向改文件,这些改动对摘要是不可见的。

3. **compaction 路径上摘要提示词的大小没有硬上限(L178)。** `TOOL_RESULT_MAX_CHARS` 是**每条**工具结果的上限,而 `prepareCompaction` 交出的 `messagesToSummarize` 条数不设限,assistant 文本、thinking 和**工具参数**都不截断。对照:`branch-summarization.ts` 的 `prepareBranchEntries` 是带 `tokenBudget` 的,从最新往回填、预算耗尽即停。两条路的预算纪律不一致。

4. **`truncateForSummary` 会把代理对劈成两半(L206–L211)。** `length` 与 `slice` 都按 UTF-16 码元算,第 2000 个码元正好落在一个 emoji 或增补平面汉字中间时,尾部会留下一个孤立代理项。同一个包里的 `harness/utils/truncate.ts` 的 `truncateTail` 专门为这件事写了 `0xd800..0xdbff` 判定 + U+FFFD 替换(全景篇 §3 点名了这条纪律),这里没有。中文常用字在 BMP 内、一字一码元,不受影响;这是个低频但真实的不一致。

5. **四个自定义角色在序列化后都长得像用户说的话(L246)。** `convertToLlm` 把 `bashExecution` / `custom` / `branchSummary` / `compactionSummary` 统统投影成 `user` 消息,于是它们在这里都输出成 `[User]: …`。摘要模型看到的 `[User]:` 里混着「用户的真实指令」「一次 bash 执行的记录」「上一次的压缩摘要」,它分不出来。连续压缩时这一条格外值得记住 —— 上一次的摘要正文会以「用户说的话」的身份重新进入下一次的摘要输入。

6. **`formatFileOperations` 不做 XML 转义(L157–L165),而同一个包的 `formatSkillsForSystemPrompt` 做(`harness/system-prompt.ts` 的 `escapeXml`)。** 后者甚至连 `skill.filePath` 这样的路径都转义了,前者对 `<read-files>` 里的路径原样输出。POSIX 路径里合法地可以含 `<` / `&`,真出现时标签会被撑坏。两处纪律不一致,别以为这里也转义了。

7. **同一个文件里防御强度不对称。** §3 对 `content` 做了 `Array.isArray` 运行时校验(L80),而 §7 的 assistant 分支直接 `for (const block of msg.content)`(L255)、toolResult 分支直接 `msg.content.filter(...)`(L287)。两者的数据都来自同一批从 `.jsonl` 反序列化回来的消息,坏数据会在 §7 抛而在 §3 被接住。

8. **`safeJsonStringify` 在 `compaction.ts` 里有一份字节相同的同名副本**(那边给 `estimateTokens` 算字符数用),两处都不导出。改这里记得看那边 —— 编译器不会提醒。

9. **`[Tool result]:` 不带工具名、不带成败(L287–L294)。** `toolName` 和 `isError` 都被丢掉,一次失败的工具调用在摘要输入里和成功的长得一模一样。摘要模型只能靠结果文本自己的措辞猜。

10. **`[User]:` 段落里相邻 text block 无分隔符粘连(L242)。** `join("")` 是刻意的(同一条消息被 provider 切成多个 text block 时不该插东西),但如果哪天上游改成「一个 block 一句话」,这里会把两句话粘成一句。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/ai/src/types.ts`(经 `@earendil-works/pi-ai`) | 只取 `Message` 类型 —— LLM 边界上的三角色闭合联合 |
| 它 import | `packages/agent/src/types.ts` | 只取 `AgentMessage` —— `Message` ∪ 四个自定义角色 |
| 它 import | `packages/agent/src/harness/types.ts` | 只取 `FileOperations`(三个 `Set<string>`) |
| import 它 | `harness/compaction/compaction.ts` | 五个导出**全部**用到:`extractFileOperations` 用前两个、`generateSummary` / `generateTurnPrefixSummary` 用 `serializeConversation`、`compact()` 收尾用后两个;并把 `serializeConversation` 再导出 |
| import 它 | `harness/compaction/branch-summarization.ts` | 同样五个全用:`prepareBranchEntries` 攒清单、`generateBranchSummary` 序列化 + 拼尾巴 |
| 间接对外 | `packages/agent/src/index.ts` | `serializeConversation` 在具名白名单里,是 `@yoma/my-pi` 的公开导出;另外四个函数**不对外** |
| 上游供给方(不 import) | `harness/messages.ts` `convertToLlm` | §7 的输入必须先过它;四个自定义角色在那里变成 `user` 消息 |
| 同纪律的对照物(不 import) | `harness/utils/truncate.ts` | 另一套截断实现:两个上限、两个方向、认真处理代理对。对照 §6 的 `truncateForSummary` |
| 发起方(不 import) | `harness/agent-harness.ts` `compact()` / `navigateTree()` | 两条侧枝的入口,本文件在这两条路上被间接调到 |
| 测试 | `packages/agent/test/harness/compaction.test.ts` | 直接测 `serializeConversation` 的截断算式;其余四个函数经 `prepareCompaction` / `compact` 间接覆盖 |

---

## 7. 自测题

**Q1.** 有人加了一个新工具叫 `write_file`,参数就叫 `path`,模型用它写了 `main.c`。压缩之后,摘要末尾的 `<modified-files>` 里会有 `main.c` 吗?

<details><summary>答案</summary>

**不会。** §3 的 `switch (block.name)` 只认三个字面量 `read` / `write` / `edit`,`write_file` 落到没有 `default` 的 switch 里,静默跳过。参数名对了也没用 —— 两条约定是「与」的关系。而且不会有任何报错或日志,表现是「模型压缩之后忘了自己写过 main.c」。

要让它生效,得把工具名改成 `write`,或者往 §3 的 switch 里加一个 case(并同步检查 `compaction.ts` / `branch-summarization.ts` 两处继承逻辑)。
</details>

**Q2.** 把 §4 的 `const modified = new Set([...fileOps.edited, ...fileOps.written])` 改成只用 `fileOps.written`,连续压缩第三次时会出什么问题?

<details><summary>答案</summary>

**继承来的整份历史清单会消失。** `compaction.ts` 的 `extractFileOperations` 在继承上一条 compaction 条目时,把 `details.modifiedFiles` 全部塞进 `fileOps.edited`(而不是 `written`)—— 因为它知道 §4 会把两个桶并起来。只用 `written` 的话,这些继承来的路径既不在 `written` 也不在 `read`,于是从两份清单里同时消失。本轮用 `edit` 工具改的文件也一起没了。

症状:压第一次清单是对的,压第二次开始逐次丢失更早的文件 —— 正是全景篇 §3 说的「连续压缩最大的风险是逐次遗忘」。
</details>

**Q3.** 把 §5 的 `if (sections.length === 0) return "";` 删掉(让它总是走最后一行 `return \`\n\n${...}\`` ),会发生什么?严重吗?

<details><summary>答案</summary>

`sections` 为空时 `sections.join("\n\n")` 返回空串,于是函数返回 `"\n\n"`。调用方写的是 `summary += formatFileOperations(...)`,所以每一份「没有任何文件操作」的摘要末尾都会多两个换行。

不会崩,但也不是纯审美问题:这段摘要正文会原样进下一轮上下文(经 `compactionSummary` 角色 → `convertToLlm` → `<summary>` 块),尾部空白会被一路带下去;而且下一次压缩时它又会作为 `previousSummary` 进入 UPDATE 提示词。属于「小而持续累积」的那类脏。
</details>

**Q4.** §3 里有 `if (!("content" in message) || !Array.isArray(message.content)) return;`,而 §7 的 assistant 分支直接写 `for (const block of msg.content)`。两者处理的是同一批消息,为什么防御强度不一样?这个不一致在什么情况下会咬人?

<details><summary>答案</summary>

**没有正当理由,这就是一处不一致。** 两个函数的数据来源是同一批从 `.jsonl` 反序列化回来的会话消息(`jsonl-storage` 直接 `JSON.parse` 每一行,不做 schema 校验),§7 的输入只是多经过了一层 `convertToLlm` —— 而 `convertToLlm` 对 `user` / `assistant` / `toolResult` 是**原样透传**的,不会修复 `content`。

咬人场景:一个老版本或被手工编辑过的会话文件里某条 assistant 消息的 `content` 不是数组。走 §3 时被第二道守卫接住、静默跳过;走 §7 时 `for...of` 会抛 `TypeError`。异常从 `generateSummary` 冒出来,被 `harness.compact()` 的 `catch` 包成 `AgentHarnessError("compaction")`,最终表现是「这次压缩失败了」的一条 ⚠️,而上下文继续涨。
</details>

**Q5.** 把 `TOOL_RESULT_MAX_CHARS` 从 2000 调到 200000,想让摘要「更完整」。会发生什么?

<details><summary>答案</summary>

大概率**摘要请求本身撞上下文窗口**,压缩失败。

理由:自动压缩的触发线是 `contextWindow - reserveTokens(16384)`,也就是说被压掉的那段历史本身就接近一整个窗口那么大。当前之所以还塞得下,靠的正是序列化时的两处**缩水** —— 图片被整个丢掉、每条工具结果砍到 2000 字符;而工具结果恰恰是长调试会话里占比最大的部分。上限提到 20 万等于取消了这个缩水,序列化文本会逼近甚至超过原上下文的规模。

而且这一条路上没有别的闸门:`messagesToSummarize` 的条数不设限,assistant 文本、thinking、工具参数都不截断。失败的后果不是崩溃(宿主只写一条 ⚠️),而是**压缩永远做不成、上下文一路涨到撞窗口**。

反方向也有代价:调到很小,摘要会丢掉「工具到底看见了什么」,模型只知道自己调过 `read(path=…)` 却不知道读到了什么。2000 是这两头之间的一个经验取值。
</details>
