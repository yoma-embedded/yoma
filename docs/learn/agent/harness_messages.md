# packages/agent/src/harness/messages.ts

> **档位** A(逐行) · **行数** 364(加注释后;原始代码 168 行) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 / §4 步骤 3d 与步骤 15 / §6.1 · **索引** [README](../README.md)

## 1. 一句话

这个文件注册了内核自己的 4 个**自定义消息角色**(`bashExecution` / `custom` / `branchSummary` / `compactionSummary`),并提供把内部消息降维成模型认得的消息的唯一函数 `convertToLlm` —— 也就是整套内核**唯一的 LLM 边界**:哪些东西真的会被发给模型、哪些只留在 transcript 里给人看,答案全在这 168 行里。

## 2. 它在全景里的位置

先把两个词分清楚。**transcript** 是"会话记录",即用户在界面上看到的那条消息流;**上下文(context)** 是"这一次真的发给模型的那堆消息"。两者不是一回事:界面上可以有系统通知、命令回显、压缩提示,而模型不该看到全部。这个文件就是这两者之间的那道墙。

墙的两侧各有一个类型。墙内是 `AgentMessage`(定义在 `src/types.ts:574`),它是"pi-ai 的三种标准消息 ∪ 应用注册的自定义消息";墙外是 pi-ai 的 `Message`,只有 `user` / `assistant` / `toolResult` 三种角色 —— 那是能真的塞进 HTTP 请求体的形状。

在全景篇 §4 的编号生命周期里,本文件出现在**两跳**:

- **步骤 3d(阶段 1,冻结 turn 快照)。** `harness.prompt()` 会先 `session.buildContext()`,而会话树里存的是**条目(entry)**不是消息 —— 换模型、压缩、打标签、移动光标全都是条目。`sessionEntryToContextMessages()`(`session/session.ts:225`)把条目摊成 `AgentMessage[]` 时,`custom_message` / `compaction` / `branch_summary` 三种条目并没有现成的消息可取,而是**现场调本文件 §6 的三个构造器合成**出来。合成而不是落盘存消息,好处是改包裹格式对已有会话立刻生效,不必迁移历史。
- **步骤 15(阶段 3,发一次请求)。** `agent-loop.ts:529` 的 `const llmMessages = await config.convertToLlm(messages)` —— 这是**每一次** provider 调用的必经之路。harness 在 `createLoopConfig()`(`agent-harness.ts:718`)里把本文件的 `convertToLlm` 直接接进 `AgentLoopConfig`,中间没有任何包装。

除主链外还有三个旁路调用点,都在"拼一段给摘要模型看的对话文本"时用到它:`compaction/compaction.ts:726`(`generateSummary`,生成压缩摘要)、`:1026`(`generateTurnPrefixSummary`,生成 turn 前缀摘要)、`compaction/branch-summarization.ts:295`(生成分支摘要)。它们的共同点是"要把历史序列化成文字",而序列化的第一步必须先过这道边界。

**不存在会怎样?** 循环拿不到任何可发的消息,`AgentLoopConfig.convertToLlm` 是**必填字段**(不是可选回调),所以第一次请求就会在类型层面塌掉。退一步说,即使换成裸循环的默认实现 `defaultConvertToLlm`(`agent.ts:63`,做法是 `filter` 掉三种标准角色之外的一切),后果是:压缩摘要与分支摘要**被静默丢弃** —— 压缩之后的会话在模型眼里等于失忆,而界面上看起来一切正常。这正是 harness 要自带一份而不是用默认实现的理由。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 原始头注释 | L1–L3 | 原作者写的三行总述(未改动) |
| 文件头块注释 | L4–L34 | 本次补充:职责、全景链路上的两处落点、术语、文档路径、分节索引 |
| §1 | L36–L44 | 依赖与模块性质:两行 `import type`,以及"它并不是纯类型模块" |
| §2 | L46–L74 | 两对摘要包裹常量(压缩 / 分支各一对) |
| §3 | L76–L148 | 四个自定义角色的形状(4 个 `interface`) |
| §4 | L150–L168 | 声明合并:把 4 个角色注册进 `AgentMessage` |
| §5 | L170–L208 | `bashExecutionToText` —— 执行记录 → markdown 文本 |
| §6 | L210–L275 | 三个「会话树条目 → 合成消息」构造器 |
| §7 | L277–L364 | `convertToLlm` —— LLM 边界本体 |

## 4. 逐节讲解

### §1 依赖与模块性质(L36–L44)

`L40–L44`

```ts
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";
```

两行都是 `import type`,编译后会被完全擦除,所以**本文件对 pi-ai 没有任何运行时依赖** —— 这是 `index.ts` 那个"浏览器安全主入口"能成立的前提之一(全景篇 §2.2)。

但要小心一个直觉陷阱:**它不是纯类型模块**。§4 的 `declare module` 有编译期副作用,§2/§5/§6/§7 则是货真价实的运行时导出(四个字符串常量 + 五个函数:`bashExecutionToText`、三个构造器、`convertToLlm`)。所以 `import type { ... } from "./messages.ts"` 与 `import { ... }` 在这里是两件不同的事。

注意 `AgentMessage` 的方向:这里 `import` 它,只是为了给 §7 标参数类型;而 §4 反过来往它的扩展点里塞字段。**一读一写两个方向合起来**,这个联合类型才真的变宽 —— 只有其中一个方向的话,`convertToLlm` 的 `switch` 里根本不会出现 `case "bashExecution"` 这种分支。

### §2 两对摘要包裹常量(L46–L74)

`L53–L61`

```ts
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
```

`L66–L74`

```ts
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;
```

**为什么要包裹。** 摘要是"历史的转述",里面必然有第一人称叙述("用户要求我修改 gdb 配置……")。裸着送进去,模型很可能把这段转述当成**新的用户指令**去执行一遍。`<summary>` 标签的作用就是给这段文字一个明确的身份。

**为什么是 `<summary>` 而不是 markdown。** 这是 prompt 工程的通行做法:XML 风格的标签在训练语料里大量出现于"结构化输入"的位置,模型对"标签里的东西是数据不是命令"这件事更容易分辨,而且闭合标签给了一个无歧义的结束信号。

**两对常量不对称。** `COMPACTION_SUMMARY_SUFFIX` 以换行开头(L60 的模板串是从行尾开始的),`BRANCH_SUMMARY_SUFFIX` 没有。于是拼出来是:

```
压缩:  <summary>\n{正文}\n</summary>
分支:  <summary>\n{正文}</summary>
```

这是上游遗留而不是设计意图(全景篇 §6.1 已记这一条)。它不影响正确性,但"顺手修齐"会改掉真正发给模型的字节,收益接近于零 —— 见 §5。

**四个常量为什么要导出。** 唯一的读取点就是 §7,包内自己用完全不必导出。导出是给应用侧做**前缀匹配**用的(比如 UI 想把包裹剥掉再显示摘要正文),属于对外契约。本仓当前**没有消费者** —— `grep -rn "COMPACTION_SUMMARY"` 只命中本文件和全景篇。

### §3 四个自定义角色的形状(L76–L148)

四个 `interface` 都靠 `role` 字段做**判别联合(discriminated union)**:TypeScript 看到 `switch (m.role)` 就能在每个 `case` 里把 `m` 收窄成对应的具体类型,§7 的分派完全依赖这一点。

#### `BashExecutionMessage`(L82–L102)

`L82–L102`

```ts
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}
```

一次 bash 命令的执行记录。**本仓内核里没有任何地方构造它** —— `grep -rn 'role: "bashExecution"'` 只命中本文件的类型定义和两处测试(`agent/test/harness/compaction.test.ts:270`、`kernel/src/host/projector.test.ts:288`)。它是上游 pi CLI"用户直接敲 `!command` 执行"那种模式留下的角色。留着它的两个理由:桌面端投影器(`kernel/src/host/projector.ts:297`)仍为它备好渲染路径;而且它是四个角色里**唯一**带真正"不进 LLM"开关的那个。

逐字段:

- `exitCode: number | undefined` —— 为什么不用 `-1` 之类的魔数:进程被信号杀掉、或者根本没起来时,压根没有退出码可言。用魔数会让 §5 的渲染分不清"0 是成功"还是"0 是缺省值"。
- `cancelled` —— 用户主动中断。它与 `exitCode` 在 §5 里**互斥地**渲染,原因见那一节。
- `truncated` / `fullOutputPath` —— 只是**标记 + 去处**,真正做截断的是构造这条消息的一方。把全文落盘、只给模型一行路径,比把几万行日志塞进上下文便宜得多。
- `excludeFromContext?: boolean` —— **全文件唯一真正的"进 transcript 不进 LLM"开关**。§7 靠它 `return undefined`。注意 `custom` 消息的 `display` 字段**不是**这个开关。

#### `CustomMessage<T>`(L109–L123)

`L109–L123`

```ts
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}
```

应用自定义消息的**通用信封**。`customType` 相当于"二级 role",让应用不必为每一种新消息都走一遍声明合并 —— 这是它与另外三个角色的本质区别:那三个是内核自己的概念,这一个是给应用留的口子。它在会话树里对应 `custom_message` 条目(`harness/types.ts:389`)。

两个容易踩的点:

- `content` 与 pi-ai `UserMessage.content` **同形状**,所以可以带图片块(`ImageContent`)。
- `display` **只管 UI 显不显示,不管进不进 LLM。** 桌面端投影器读它决定渲不渲染(`projector.ts:266`),内核这一侧则完全无视 —— 见 §5 第 1 条。

还有一个类型层面的细节:泛型 `T` 只影响 `details`,但 §4 注册进 `CustomAgentMessages` 的是**不带参数**的 `CustomMessage`,所以从 `AgentMessage` 拿到的 `details` 永远是 `unknown`。想要类型安全的 `details`,只能在应用侧自己断言。

#### `BranchSummaryMessage`(L127–L136)

`L127–L136`

```ts
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}
```

会话树上把 leaf 挪走(分支 / 回退)之后,被抛下的那条分支不会从树里删掉 —— 树只追加、不删除 —— 但它会**离开投影**。于是先给它做一份摘要挂在新 leaf 下,模型才知道"你刚才在另一条路上试过什么"。

`fromId` 是个容易读反的字段。名字看起来像"来自哪条分支",实际存的是**这条摘要挂在哪个条目下**:`session/session.ts:632` 写的是 `fromId: entryId ?? "root"`,而 `entryId` 正是 `moveTo()` 要跳去的那个**新 leaf**(跳到根时用字符串 `"root"` 当哨兵)。它不会进模型 —— §7 只取 `summary`。

#### `CompactionSummaryMessage`(L142–L148)

`L142–L148`

```ts
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}
```

上下文超预算时,把旧历史整段换成一段转述。记住那句咒语:**压缩改的是投影,不是历史** —— 原始条目一条不删,是 `buildContext()` 在投影时把 compaction 之前的条目隐去(见 `compaction/compaction.ts` 头注释)。`tokensBefore` 是压缩前的 token 数,给 UI 显示"省了多少"用,§7 不读它。

### §4 声明合并:把 4 个角色注册进 AgentMessage(L150–L168)

`L161–L168`

```ts
declare module "../types.ts" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
```

这 8 行是全文件唯一有**编译期副作用**的地方,也是最反直觉的一段。机制是这样的:

`src/types.ts:562` 声明了一个**空的** `interface CustomAgentMessages {}`,紧接着 `:574` 用它组出联合类型:

```ts
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

空 interface 的 `keyof` 是 `never`,所以默认状态下 `AgentMessage` 就等于 pi-ai 的 `Message`。上面那段 `declare module` 往这个空 interface 里塞了 4 个字段,TypeScript 的**声明合并**把它们合成同一个 interface,于是 `AgentMessage` 这个联合**在全工程范围内**多出了 4 个成员。

三个后果,按咬人程度排序:

1. **不需要谁 `import` 本文件的值。** 只要有一个模块 `import type` 了它,合并就已经发生。于是"`AgentMessage` 到底有哪几个 role"取决于**哪些模块被编译进来**,而不是取决于运行时执行了什么。
2. **联合类型对本文件是开放的。** 别的模块(比如桌面端应用)完全可以再写一段 `declare module` 注册第五个角色。所以任何对 `AgentMessage` 做 `switch` 的地方都必须留 `default` 分支 —— 编译器无法保证联合是封闭的。§7 末尾那个 `default` 正是为此而存在,不是防御性冗余。
3. **模块说明符必须与真实相对路径逐字对上**(`"../types.ts"`)。模块增强(augmentation)认的是**解析后的模块身份**,写成别的路径要么直接报错,要么合并到另一个模块上白干一场。

### §5 bashExecution → markdown 文本(L170–L208)

`L178–L182`

```ts
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
```

签名极简:进一条执行记录,出一段 markdown 文本。**没有失败路径** —— 不读文件、不抛异常、不依赖外部状态,是个纯函数。

它有**两个消费者**:§7 投影进 LLM 时,和桌面端投影器渲进 UI 时(`kernel/src/host/projector.ts:299`,那边明确注释了"用内核自己的渲染函数,别重写")。共用一份的意义在于:**模型看到的文本和用户看到的文本逐字一致** —— 排查"模型怎么会这么想"的时候,不必先怀疑两边渲染得不一样。

`command` 未做转义:命令里自带反引号时 markdown 会花掉,但那只影响观感,模型读到的仍是同样的字符。

````ts
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
````

`L183–L191`。三反引号围栏的作用是把"输出"与"叙述"隔开,免得输出里的一句话被当成新指令。同样没有转义:输出自带 ` ``` ` 时块会提前闭合,是已知的渲染瑕疵。

`else` 那一支不能省:删掉的话消息尾部就是空的,模型分不清"**命令没有输出**"和"**输出被吞了**"。

`L197–L201`

```ts
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
```

尾注的优先级是刻意的:**取消 > 非零退出码**。被取消的进程多半也留下一个非零码,但那个码是中断的副产物;报出来会让模型以为命令自身失败了,进而去"修"一个并不存在的 bug。

`!== null` 那一项在**类型上是冗余的**(`exitCode` 声明成 `number | undefined`,TS 不会让它是 `null`)。它防的是没有类型保护的构造方 —— 这条消息由应用侧生产,从 JS 侧或别的序列化格式喂进来时 `null` 很常见。排掉 `0` 则是因为"成功"不值得占用上下文。

`L204–L207`

```ts
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
```

两个条件必须**同时**成立才发这行提示。只有 `truncated` 标记而拿不出路径时,告诉模型"被截断了"却给不出去处,只会诱导它编造后半段或者反复重跑命令。

### §6 三个「会话树条目 → 合成消息」构造器(L210–L275)

先记住那个反直觉的事实:**会话树里存的是条目(entry),不是消息**。换模型、压缩、打标签、移动光标(leaf)都是条目。只有 `message` 条目里直接躺着一条 `AgentMessage`;下面三种条目要在投影成上下文时才被**现场合成**为消息(全景篇 §4 步骤 3d)。合成而不是落盘存消息的好处是:改 §2 的包裹格式对**已有会话**立刻生效,不用迁移历史。

三个构造器有同一个签名习惯:最后一个参数是 **ISO 字符串**时间戳。原因是两侧口径不同 —— 条目的 `timestamp` 是字符串(`harness/types.ts:315`),而消息的 `timestamp` 是毫秒数字(`ai/src/types.ts:371`)。

调用点共有三处,每处都把这三个一起用:`session/session.ts:240-261`(主链投影)、`compaction/compaction.ts:164-179`、`compaction/branch-summarization.ts:154-160`。

`L223–L233`

```ts
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}
```

`new Date(timestamp).getTime()` 是那个换算点。传进来的若不是合法 ISO 串,结果是 `NaN` 而且**不报错**,会一路带进消息里(下游只是排序和展示,不会炸)。三个构造器都是同一个写法、同一个风险,所以时间戳的合法性归调用方保证。

`L239–L250` 的 `createCompactionSummaryMessage` 结构完全一样,只是多带一个 `tokensBefore`。

`L260–L275`

```ts
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
```

一个容易误读的签名细节:`details` 的类型写成 `unknown | undefined`,而它在 TypeScript 里**等价于 `unknown`** —— `undefined` 已经是 `unknown` 的子类型,联合起来不产生任何新东西。关键是它**没有 `?`,所以不是可选参数**:三个调用点都必须显式把 `details` 传进来(哪怕值就是 `undefined`),漏传是编译错误而不是默默取默认值。返回类型写的是不带参数的 `CustomMessage`,即 `CustomMessage<unknown>` —— 泛型参数在这里没法透传出去。

### §7 LLM 边界:convertToLlm(L277–L364)

`L288–L295`

```ts
/** harness 版的 LLM 边界投影:自定义角色 → user 消息(或过滤),标准三角色原样通过。 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
```

**契约先说清楚。** `AgentLoopConfig.convertToLlm` 在 `types.ts:333` 写着 `Contract: must not throw or reject`。这不是客气话:裸循环的入口是 `void runAgentLoop(...).then(...)` 且**没有 `.catch`**(全景篇 §6.1 第一条),这里一抛就是"一个未处理的 Promise rejection + 一个永远不 `end()` 的事件流",调用方 `await` 结果时**直接挂死**。本实现做到这一点的方式很朴素:整个函数不做 I/O、不调任何可能抛的东西。

两个签名细节:

- 用 `.map` 而不是 `.flatMap`,因为这里只有"一进一出"和"一进零出"两种情形,没有一条消息要拆成多条的需求;丢弃靠返回 `undefined` + 末尾的 `filter` 表达。
- 回调的返回类型**显式写成** `Message | undefined`。这不是装饰:少了它,各 `case` 里 `{ type: "text" }` 的 `type` 会被推成 `string` 而不是字面量类型 `"text"`,对不上 `TextContent`。留意 `case "bashExecution"` 里(L308)没写 `as const` 而其他几处写了 —— 前者靠的正是这个上下文类型。
- 它是**同步返回**的,而契约允许返回 `Promise`。调用点 `agent-loop.ts:529` 写的是 `await`,两种都吃得下。

`L298–L311`

```ts
			case "bashExecution":
				if (m.excludeFromContext) {
					return undefined;
				}
				return {
					role: "user",
					content: [{ type: "text", text: bashExecutionToText(m) }],
					timestamp: m.timestamp,
				};
```

`excludeFromContext` 是**全文件唯一真正的"不进 LLM"开关**:命中就整条消失,连占位都不留。删掉这三行,被标记为不入上下文的命令输出会照样发给模型。

注意 `role: "user"` —— 借 user 角色装。pi-ai 只认三种角色,"这是一段命令输出"这个信息只能靠 §5 渲染进**文本本身**来表达。`timestamp` 原样带过去:投影不改时间,重放这段历史时顺序才稳定。

`L312–L327`

```ts
			case "custom": {
				const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
				return {
					role: "user",
					content,
					timestamp: m.timestamp,
				};
			}
```

这个 `case` 带花括号是**必须的**:里面声明了 `const`,不开块作用域就会与其他 `case` 共用同一个词法作用域(`no-case-declarations` 那类问题)。

`string` 形态被归一化成单元素数组。这**不是**下游的硬性要求 —— pi-ai 三家协议实现都能吃 `string` 类型的 content(例如 `openai-completions.ts:898` 就有 `typeof msg.content === "string"` 的分支);归一化只是让边界之后的代码少面对一种形状。

**这里没有读 `m.display`。** `display: false` 的自定义消息照样进模型 —— 见 §5 第 1 条。

`L328–L344`

```ts
			case "branchSummary":
				return {
					role: "user",
					content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
					timestamp: m.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content: [
						{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
					],
					timestamp: m.timestamp,
				};
```

两条摘要都只取 `summary`,拼上 §2 的包裹。`fromId` / `tokensBefore` 这类树元数据一律不带 —— 模型不需要知道会话树的形状,带上只会浪费 token 并诱导它讨论树结构。

`L349–L352`

```ts
			case "user":
			case "assistant":
			case "toolResult":
				return m;
```

pi-ai 的三个标准角色原样透传 —— **同一个对象引用,没有复制**。于是调用方拿到的数组里,这三种消息与 `AgentContext` 里的是同一批对象,谁就地改它就是改了会话历史。下游 `transformMessages`(`packages/ai/src/api/transform-messages.ts:64`)从不就地改 —— 要改就 spread 出新对象,user 消息干脆 `return msg` 原样透传 —— 所以实践中安全,但别在这条边界上依赖"我拿到的是副本"。

另外要记住这里**什么都不补**:中途 abort 会留下有 `toolCall` 却没有对应 `toolResult` 的 assistant 消息(全景篇 §6.1),`convertToLlm` 原样放行,补合成结果是 pi-ai `transformMessages` 那道防线的事。

`L357–L363`

```ts
			default:
				return undefined;
		}
	})
	.filter((m): m is Message => m !== undefined);
```

`default` 是 §4 声明合并的必然后果,不是防御性冗余(理由见 §4)。代价要记住:应用注册的第五个角色若没人回来改这个 `switch`,就会在 LLM 边界被**静默丢弃**。

`.filter` 的类型谓词 `m is Message` 是必须的:普通 `filter` 不会把 `(Message | undefined)[]` 收窄成 `Message[]`,少了它这个函数的返回类型就对不上。

## 5. 会咬人的地方

1. **`display: false` 挡不住模型(L116–L119 定义,L319–L326 投影)。** `CustomMessage.display` 的语义是"不给用户看",很容易被读成"不给模型看",但 `convertToLlm` 的 `custom` 分支根本不读这个字段。目前唯一真正的"进 transcript 不进 LLM"开关是 `BashExecutionMessage.excludeFromContext`(L101),而那个角色在本仓没有生产者。想要"两边都不给看",只能一开始就别产生这条消息。与全景篇 §6.1 记的一致。

2. **`declare module` 是一个隐形的全局副作用(L161–L168)。** 只要有任何一个模块 `import type` 了本文件,`AgentMessage` 就在全工程变宽 —— 即使运行时一行代码都没执行。反过来的方向要小心别想歪:本文件在本仓有五处**值引用**(agent-harness / session / compaction / branch-summarization / 桌面端 projector),所以它不会被整个 tree-shake 掉;真正的不对称在于**类型侧的合并不需要值引用** —— 一个只 `import type` 的模块也会让 `AgentMessage` 变宽,于是类型上看得见的角色未必有人真的去投影它。

3. **第五个自定义角色会被静默丢弃(L357–L358)。** `default: return undefined` 让未知角色一声不吭地消失,没有 warn、没有 throw。应用侧注册新角色时如果忘了同步改这个 `switch`,症状是"模型好像没看到我塞进去的东西",而 transcript 里明明有。

4. **两条摘要的包裹格式不对称(L60–L61 vs L74)。** `COMPACTION_SUMMARY_SUFFIX` 以换行开头,`BRANCH_SUMMARY_SUFFIX` 不以换行开头。这是上游遗留;不影响正确性,但也别顺手"修齐" —— 改动会改掉真正发给模型的字节。全景篇 §6.1 已记。

5. **`details: unknown | undefined` 不是可选参数(L264)。** 写法看着像"可以不传",实际 `unknown | undefined` 折叠成 `unknown`,而参数上没有 `?`,所以必传。这条不会咬到既有代码(三个调用点都传了),但会咬到新写调用方的人 —— 报错信息是"期望 5 个参数,得到 4 个",跟 `details` 这个词一点关系都没有。

6. **时间戳非法时静默变 `NaN`(L231 / L248 / L273)。** 三个构造器都是 `new Date(timestamp).getTime()`,传进一个不合法的字符串既不抛也不告警,`NaN` 会一路进消息。下游只做排序和展示,所以不会炸,只会让这条消息在时间线上的位置变得诡异。

7. **`exitCode !== null` 与类型声明不符(L199)。** 字段声明是 `number | undefined`(L89),TS 眼里 `null` 不可能出现,这个判空在类型层面是死代码。它防的是无类型保护的构造方。**不要因为"TS 说它冗余"就删掉** —— 这条消息在本仓没有生产者,真正的生产者在应用侧,而那边不一定有类型约束。

8. **`bashExecution` 在本仓没有生产者(L82–L102)。** `grep -rn 'role: "bashExecution"'` 只命中类型定义与两处测试。读这段代码时别去找"谁在跑 bash 然后造这条消息" —— 内核的 bash 工具走的是 `toolResult` 那条路,不是这个角色。它是上游 pi CLI 的遗产。

9. **`fromId` 语义与字面意思相反(L134)。** 存的是"这条摘要挂在哪个条目下(即回到的那个新 leaf)",不是"被摘要的那条分支的 leaf"。跳到根时是字符串哨兵 `"root"`,不是 `null`。

10. **标准三角色是引用透传,不是拷贝(L349–L352)。** 边界之后拿到的对象与 `AgentContext.messages` 里的是同一批。就地修改等于改会话历史。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/ai/src/types.ts`(经 `@earendil-works/pi-ai`) | 取 `Message` / `TextContent` / `ImageContent` 三个类型;纯类型引用,零运行时依赖 |
| 它 import | `packages/agent/src/types.ts` | 取 `AgentMessage`;同时用 `declare module` 反向往 `CustomAgentMessages`(`:562`)里注册 4 个角色 |
| import 它 | `packages/agent/src/harness/agent-harness.ts:72` | `createLoopConfig()`(`:718`)把 `convertToLlm` 直接接进 `AgentLoopConfig`,无包装 |
| import 它 | `packages/agent/src/harness/session/session.ts:48` | `sessionEntryToContextMessages()` 用三个构造器把非 `message` 条目合成消息(全景篇 §4 步骤 3d) |
| import 它 | `packages/agent/src/harness/compaction/compaction.ts:65` | `getMessageFromEntry()` 用三个构造器;`:726` / `:1026` 用 `convertToLlm` 序列化对话给摘要模型 |
| import 它 | `packages/agent/src/harness/compaction/branch-summarization.ts:33` | 同上,`:295` 用 `convertToLlm` |
| import 它 | `packages/agent/src/index.ts:86` | `export * from "./harness/messages.ts"`,四个常量、五个函数、四个 interface 全部出包 |
| import 它 | `packages/kernel/src/host/projector.ts:32` | 桌面端投影器复用 `bashExecutionToText`(`:299`),保证模型与用户看到同一段文本 |
| 对照阅读 | `packages/agent/src/agent-loop.ts:529` | 唯一的主链调用点:`transformContext` → `convertToLlm` → `streamFn` |
| 对照阅读 | `packages/agent/src/agent.ts:63` | 裸循环的默认实现 `defaultConvertToLlm`:直接 `filter` 掉三种标准角色之外的一切 |

## 7. 自测题

**Q1.** 有人给 `CustomMessage` 加了一条 `display: false` 的消息,想让它"只给工具用,不给模型看",结果发现模型能引用到里面的内容。问题出在哪?正确的做法是什么?

<details><summary>答案</summary>

`convertToLlm` 的 `case "custom"` 分支(L312–L327)根本不读 `display`,它只影响 UI(桌面端投影器 `projector.ts:266` 读它)。所有 `custom` 消息都会被投影成 `user` 消息进 LLM。

真正的"不进 LLM"开关只有 `BashExecutionMessage.excludeFromContext`(L101),`custom` 角色上没有对应字段。正确做法有二:要么根本别把这条内容做成消息(改成 `custom` **条目** —— `session.appendCustomEntry()` 产生的 `type: "custom"` 条目默认不进上下文,见 `session/session.ts:266`);要么给 `CustomMessage` 加一个 `excludeFromContext` 并在 L322 之前判它。

</details>

**Q2.** 如果把 `convertToLlm` 末尾的 `default: return undefined`(L357–L358)删掉,会发生什么?TypeScript 会报错吗?

<details><summary>答案</summary>

**在本文件里 TypeScript 不会报错** —— 7 个 `case` 已经覆盖了当前 `AgentMessage` 的全部成员,`switch` 之后 `m` 的类型是 `never`,函数的返回类型标注是 `Message | undefined`,允许隐式返回 `undefined`。

真正的风险来自 §4:`AgentMessage` 是靠声明合并组出来的**开放**联合,别的模块随时能注册第五个角色。那时 `switch` 不再穷尽,而回调声明了返回 `Message | undefined`,所以**仍然不会报错**,只是走到函数末尾隐式返回 `undefined`。区别在于:留着 `default` 是"我知道会有未知角色,明确丢弃";删掉它是"我以为覆盖全了",下次有人加角色时就没有任何提示。行为一样,可读性与意图表达差很多。

</details>

**Q3.** 把 `case "user" / "assistant" / "toolResult"` 的 `return m` 改成 `return { ...m }`(浅拷贝),会有什么影响?

<details><summary>答案</summary>

功能上多半没有变化,但有两点值得想清楚:

其一,**每次请求都多一轮对象分配**。`convertToLlm` 在每一次 provider 调用前都跑(步骤 15),长会话里一次要拷几百个对象,而下游 `transformMessages` 本来就会再造一批新对象。

其二,浅拷贝**只拷了一层**:`content` 数组、`usage` 对象仍是同一个引用,所以它并不能真的把调用方与会话历史隔开,只是让人误以为隔开了。要么不拷(现状,并在文档里说清),要么深拷(代价大),半拷是最坏的选项。

</details>

**Q4.** 假设某次压缩之后,模型在回答里开始"执行"摘要里描述过的旧任务(比如又去改一遍已经改好的文件)。从本文件的角度看,哪几行值得先怀疑?

<details><summary>答案</summary>

先看 L53–L61 的 `COMPACTION_SUMMARY_PREFIX` / `SUFFIX`:它们的全部职责就是告诉模型"下面这段是历史的转述,不是新指令"。如果包裹被改坏(比如 `<summary>` 标签没闭合、PREFIX 被截断),摘要就退化成一段裸的第一人称叙述,而第一人称叙述看起来和用户指令一模一样。

再看 L336–L344 的 `compactionSummary` 分支:它把摘要包成 `role: "user"`。这是"借 user 角色装"的必然代价 —— pi-ai 只有三种角色,没有"系统旁白"这一档,所以包裹文本是**唯一**的身份标记。

反过来说,如果包裹是好的,那就不是本文件的问题了,该去看 `compaction.ts` 的摘要提示词。

</details>

**Q5.** 为什么 `session/session.ts` 不干脆把合成好的 `CompactionSummaryMessage` 直接存进会话树,非要每次投影时现场调 `createCompactionSummaryMessage` 合成一遍?

<details><summary>答案</summary>

因为会话树是**只追加**的持久化日志,而合成结果里包含了会变的东西:§2 的包裹常量、`new Date(...).getTime()` 的换算口径,乃至将来可能加的字段。存进去就等于把这些冻在磁盘上,改一次格式就要写一次迁移。

现在的做法是:树里只存**事实**(`compaction` 条目里的 `summary` / `tokensBefore` / `firstKeptEntryId`),消息是从事实**投影**出来的。改 §2 的包裹格式,所有历史会话下一次读取时立刻用新格式 —— 零迁移。这与全仓那句"压缩改的是投影,不是历史"是同一个设计取向。

</details>
