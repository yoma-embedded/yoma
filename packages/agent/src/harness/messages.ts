// 自定义消息角色:进 transcript,不进 LLM。
// 通过 declare module 声明合并把 4 个角色注册进 CustomAgentMessages(src/types.ts:305),
// AgentMessage 全局变宽;convertToLlm 在 LLM 边界把它们投影成 user 消息或过滤掉。
/**
 * 这个文件划出了整套内核**唯一的 LLM 边界**:哪些东西真的会被发给模型、
 * 哪些只留在 transcript(会话记录,即界面上那条消息流)里给人看。
 *
 * 全景链路上的两处落点(编号对应全景篇 §4 的生命周期步骤):
 *   步骤 3d —— `session.buildContext()` 把会话树的**条目**摊成 `AgentMessage[]` 时,
 *              `custom_message` / `compaction` / `branch_summary` 三种条目分别经
 *              §6 的三个构造器现场"合成"为消息(树里存的是条目,不是消息)。
 *   步骤 15 —— `agent-loop.ts` 的 `streamAssistantResponse` 每次发请求前调 §7 的
 *              `convertToLlm`,把带自定义角色的 `AgentMessage[]` 降维成 pi-ai 的
 *              `Message[]`(只剩 user / assistant / toolResult 三种角色)。
 * 除主链外,压缩与分支摘要在拼"给摘要模型看的对话文本"时也调 `convertToLlm`
 * (compaction/compaction.ts:726、:1026,compaction/branch-summarization.ts:295)。
 *
 * 三个新读者容易卡住的词:
 *   harness —— 会话外壳,把无状态的 agent 循环包成"一个可长期使用的会话对象"。
 *   compaction —— 上下文压缩:历史太长时把旧的一段换成一段摘要。
 *   声明合并(declaration merging)—— TypeScript 允许不同文件往同名 interface 里
 *              各自塞字段,编译期合并成一个。§4 用它给 `AgentMessage` 这个联合类型加成员。
 *
 * 对应学习文档:docs/learn/agent/harness_messages.md
 *
 * 分节索引:
 *   §1 依赖与模块性质
 *   §2 两对摘要包裹常量
 *   §3 四个自定义角色的形状
 *   §4 声明合并:把 4 个角色注册进 AgentMessage
 *   §5 bashExecution → markdown 文本
 *   §6 三个「会话树条目 → 合成消息」构造器
 *   §7 LLM 边界:convertToLlm
 */

// ── §1 依赖与模块性质 ──────────────────────────────────────────────────
// 两行都是 `import type`,运行时被完全擦除 —— 本文件对 pi-ai 没有任何运行时依赖,
// 这是 index.ts 那个"浏览器安全主入口"能成立的前提之一(全景篇 §2.2)。
// 但它**不是**纯类型模块:§4 的 declare module 有编译期副作用,§2/§5/§6/§7 是真实运行时导出。
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
// AgentMessage 是"内部消息"的联合类型,定义在 src/types.ts:574。
// 这里 import 它只为给 §7 标参数类型;而 §4 反过来往它的扩展点 CustomAgentMessages
// 里塞字段 —— 一读一写两个方向合起来,才让这个联合真的变宽。
import type { AgentMessage } from "../types.ts";

// ── §2 两对摘要包裹常量 ────────────────────────────────────────────────
// 压缩摘要送进模型时的开头包裹。用 <summary> 标签而不是裸文本,是为了让模型能把
// "这是被压掉的历史的转述"与"这是用户真说过的话"区分开 —— 否则摘要里的第一人称
// 叙述会被当成新的用户指令读。
// 模板串跨了 3 行,末尾那个换行是有意的:正文从新行开始,开标签独占一行。
// 四个常量都导出,是留给应用侧做前缀匹配(例如 UI 想把包裹剥掉再显示)的对外契约,
// 本仓当前没有消费者 —— 唯一的读取处就是下面 §7。
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

// 与上面配对的收尾。注意它**以换行开头**,而 BRANCH_SUMMARY_SUFFIX 没有 ——
// 两条摘要的包裹格式不对称,是上游遗留而不是设计(全景篇 §6.1 已记这一条)。
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// 分支摘要的开头包裹。措辞是 "came back from":会话树上把 leaf 挪走之后,被抛下的
// 那条分支不会从树里删掉(树只追加、不删除),但它会离开投影 —— 于是先给它做一份
// 摘要挂在新 leaf 下,模型才知道"你刚才在另一条路上试过什么"。
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

// 这一条没有前导换行,于是拼出来是 `<summary>\n{正文}</summary>`,比压缩摘要的
// `<summary>\n{正文}\n</summary>` 少一个换行。想统一就得两边一起改,而改动会改掉
// 真正发出去的字节;收益不大,所以留着并在文档 §5 里记一笔。
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

// ── §3 四个自定义角色的形状 ────────────────────────────────────────────
// 一次 bash 命令的执行记录。
// **本仓内核里没有任何地方构造它** —— `grep -rn 'role: "bashExecution"'` 只命中这里的
// 类型定义和两处测试。它是上游 pi CLI"用户直接敲 !command 执行"那种模式留下的角色。
// 留着的两个理由:桌面端投影器(kernel/src/host/projector.ts:297)仍为它备好渲染路径;
// 而且它是四个角色里**唯一**带真正"不进 LLM"开关的(见下面的 excludeFromContext)。
export interface BashExecutionMessage {
	// role 是判别联合(discriminated union)的判别字段,§7 的 switch 全靠它分派。
	role: "bashExecution";
	command: string;
	output: string;
	// 为什么是 `number | undefined` 而不是 -1:进程被信号杀掉、或根本没起来时,
	// 压根没有退出码可言,拿一个魔数假装有会让 §5 分不清"0 是成功"还是"0 是缺省"。
	exitCode: number | undefined;
	// 用户主动中断。它与 exitCode 在 §5 里互斥地渲染,原因见那里。
	cancelled: boolean;
	// 输出被截断过。这里只是**标记**,真正做截断的是构造这条消息的一方。
	truncated: boolean;
	// 截断时全文落盘的路径。§5 把它渲染成一行提示,让模型需要时自己去 read ——
	// 比把几万行日志塞进上下文便宜得多。
	fullOutputPath?: string;
	// 毫秒 Unix 时间戳,与 pi-ai 三种 Message 的 timestamp 同一口径(ai/src/types.ts:371)。
	timestamp: number;
	// 全文件唯一真正的"进 transcript 不进 LLM"开关,§7 靠它 return undefined。
	// 注意:custom 消息的 display 字段**不是**这个开关,别搞混。
	excludeFromContext?: boolean;
}

// 应用自定义消息的通用信封。`customType` 相当于"二级 role",让应用不必为每一种
// 新消息都走一遍声明合并。它在会话树里对应 `custom_message` 条目
//(harness/types.ts:389),由 §6 的 createCustomMessage 现场合成。
// 泛型 T 只影响 details;但 §4 注册进 CustomAgentMessages 的是**不带参数**的
// `CustomMessage`,所以从 `AgentMessage` 拿到的 details 永远是 unknown。
export interface CustomMessage<T = unknown> {
	role: "custom";
	// 应用自定的类型名。内核不认识它的取值,只透传;认得它的是 UI 与应用自己。
	customType: string;
	// 与 pi-ai UserMessage.content 同形状,所以可以带图片块(ImageContent)。
	// §7 会把 string 形态归一化成单元素数组。
	content: string | (TextContent | ImageContent)[];
	// **只管 UI 显不显示,不管进不进 LLM。** display:false 的消息照样被 §7 投影成
	// user 消息发给模型(全景篇 §6.1 记的坑)。桌面端投影器读它决定渲不渲染
	//(projector.ts:266),内核这一侧则完全无视。
	display: boolean;
	// 结构化附带数据,给 UI / 工具用。§7 从不读它,所以它永远不进模型。
	details?: T;
	timestamp: number;
}

// 分支摘要:leaf 被挪走后,给"被抛下的那条分支"做的一份转述。
// 由 §6 的 createBranchSummaryMessage 从 branch_summary 条目合成。
export interface BranchSummaryMessage {
	role: "branchSummary";
	// 摘要正文。它是这个角色里**唯一**会进模型的字段(§7 只取它,拼上 §2 的包裹)。
	summary: string;
	// 容易读反的一个字段:它存的不是"被摘要的那条分支的 leaf",而是这条摘要挂在
	// 哪个条目下 —— session/session.ts:632 写的是 `fromId: entryId ?? "root"`,
	// 而 entryId 正是 moveTo 要跳去的那个新 leaf(跳到根时用字符串 "root" 当哨兵)。
	fromId: string;
	timestamp: number;
}

// 压缩摘要:上下文超预算时,把旧历史整段换成一段转述。
// 由 §6 的 createCompactionSummaryMessage 从 compaction 条目合成。
// 记住咒语:**压缩改的是投影,不是历史** —— 原始条目一条不删,是 buildContext
// 在投影时把 compaction 之前的条目隐去(见 compaction/compaction.ts 头注释)。
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	// 压缩前的 token 数,给 UI 显示"省了多少"用。§7 不读它,不进模型。
	tokensBefore: number;
	timestamp: number;
}

// ── §4 声明合并:把 4 个角色注册进 AgentMessage ─────────────────────────
// 全文件唯一有"编译期副作用"的地方,也是最容易咬人的地方:
//   1. `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`
//      (types.ts:574),而 `CustomAgentMessages` 默认是空 interface。这里往它塞 4 个
//      字段,于是**全工程**的 AgentMessage 联合都变宽 —— 不需要谁 import 本文件的值。
//   2. 只要有一个模块 `import type` 了本文件,合并就已经发生。于是"AgentMessage 到底
//      有哪几个 role"取决于哪些模块被编译进来,而不是取决于运行时。
//   3. 代价:任何对 AgentMessage 做 switch 的地方都必须留 default 分支 —— 编译器无法
//      保证这个联合是封闭的。§7 末尾那个 default 正是为此而存在。
// 模块说明符必须与 types.ts 的真实相对路径逐字对上("../types.ts"):augmentation 认的
// 是解析后的模块身份,写成别的路径要么直接报错,要么合并到另一个模块上白干一场。
declare module "../types.ts" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

// ── §5 bashExecution → markdown 文本 ───────────────────────────────────
// 把一条 BashExecutionMessage 渲染成一段 markdown 文本。
// 参数:msg —— 待渲染的执行记录。
// 返回:纯文本(markdown)。没有失败路径 —— 不读文件、不抛异常、不依赖外部状态。
// 两个消费者共用它:§7 投影进 LLM 时,和桌面端投影器渲进 UI 时
//(kernel/src/host/projector.ts:299 明确注释了"别重写,它处理了三种尾注")。
// 共用的意义在于:模型看到的文本与用户看到的文本逐字一致 —— 排查"模型怎么会这么想"
// 的时候,不必先怀疑两边渲染得不一样。
export function bashExecutionToText(msg: BashExecutionMessage): string {
	// 反引号包住命令,让"哪句是命令、哪些是输出"一眼可分。
	// msg.command 未做转义:命令自带反引号时 markdown 会花掉,但那只影响观感,
	// 模型读到的仍是同样的字符,不影响语义。
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		// 三反引号围栏的作用是把"输出"与"叙述"隔开,免得输出里的一句话被当成新指令。
		// 同样没有转义:输出自带 ``` 时块会提前闭合,是已知的渲染瑕疵。
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		// 空输出必须显式说出来。删掉这一支的话消息尾部就是空的,
		// 模型分不清"命令没有输出"和"输出被吞了"。
		text += "(no output)";
	}
	// 尾注的优先级是刻意的:取消 > 非零退出码。被取消的进程多半也留下一个非零码,但那个码是
	// 中断的副产物,报出来会让模型以为命令自身失败了,进而去"修"一个并不存在的 bug。
	// 下面 else-if 里的 `!== null` 在类型上是冗余的(exitCode 声明成 `number | undefined`),
	// 它防的是没有类型保护的构造方 —— 这条消息由应用侧生产(本仓没有生产者,见 §3),
	// 从 JS 侧或别的序列化格式喂进来时 null 很常见;排掉 0 则因为"成功"不值得占上下文。
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	// 两个条件必须同时成立才发这行提示:只有 truncated 标记而拿不出路径时,告诉模型
	// "被截断了"却给不出去处,只会诱导它编造后半段或反复重跑命令。
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

// ── §6 三个「会话树条目 → 合成消息」构造器 ─────────────────────────────
// 会话树里存的是**条目**(entry)而不是消息 —— 换模型、压缩、打标签、移动光标都是条目。
// 只有 `message` 条目里直接躺着一条 AgentMessage;下面三种条目要在投影成上下文时
// 才被现场合成为消息(全景篇 §4 步骤 3d)。
// 为什么合成而不是落盘存消息:改包裹格式(§2)对**已有会话**立刻生效,不用迁移历史。
// 三个构造器有同一个签名习惯:最后一个参数是 ISO 字符串时间戳,因为条目的 timestamp
// 是字符串(harness/types.ts:315),而消息的 timestamp 是毫秒数字(ai/src/types.ts:371)。
// 调用点共有三处,每处都把这三个构造器一起用:session/session.ts:240-261(主链投影)、
// compaction/compaction.ts:164-179、compaction/branch-summarization.ts:154-160。

// 从一条 branch_summary 条目造出分支摘要消息。
// 参数:summary 摘要正文;fromId 这条摘要挂靠的条目 id;timestamp 条目的 ISO 时间戳。
// 返回:BranchSummaryMessage。没有失败路径(时间戳非法时见下面那条注释)。
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		// 字符串 → 毫秒数的换算点。传进来的若不是合法 ISO 串,结果是 NaN 而且**不报错**,
		// 会一路带进消息里(下游只是排序和展示,不会炸)。三个构造器都是同一个写法、
		// 同一个风险,所以时间戳的合法性归调用方保证。
		timestamp: new Date(timestamp).getTime(),
	};
}

// 从一条 compaction 条目造出压缩摘要消息。
// 参数:summary 摘要正文;tokensBefore 压缩前的 token 数(只给 UI 看);
//      timestamp 条目的 ISO 时间戳。
// 返回:CompactionSummaryMessage。没有失败路径。
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

// 从一条 custom_message 条目造出自定义消息。
// 参数:customType 应用自定的二级类型名;content 文本或内容块数组(可含图片);
//      display 只影响 UI 渲染、不影响是否进 LLM;details 结构化附带数据;
//      timestamp 条目的 ISO 时间戳。
// 返回:CustomMessage —— 注意是 `CustomMessage<unknown>`,泛型参数在这里没法透传出去。
// 一个容易误读的签名细节:details 的类型写成 `unknown | undefined`,而它在 TypeScript
// 里**等价于 `unknown`**,并不是可选参数。所以三个调用点都必须显式把 details 传进来
//(即使值就是 undefined),漏传是编译错误而不是默默取默认值。
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

// ── §7 LLM 边界:convertToLlm ──────────────────────────────────────────
// AgentMessage[] → pi-ai Message[],整套内核**唯一**的 LLM 边界(全景篇 §0 分层图⑤、
// §4 步骤 15)。想知道"什么进 LLM、什么只进 transcript",只需要读这一个函数。
// 参数:messages —— 本次请求要发的全部内部消息(已经过 transformContext hook)。
// 返回:只含 user / assistant / toolResult 三种角色的数组,可直接放进 pi-ai 的 Context。
// 失败:没有失败路径,不做 I/O、不抛异常。这是 `AgentLoopConfig.convertToLlm` 的硬性
// 契约(types.ts:333 写着 must not throw or reject):裸 loop 的入口是
// `void runAgentLoop(...).then(...)` 且**没有 .catch**,这里一抛就是"一个未处理的
// Promise rejection + 一个永远不 end() 的事件流",调用方 await 结果时直接挂死。
// 它是同步返回的,而契约允许返回 Promise —— 调用点 agent-loop.ts:529 写的是 await,
// 所以两种都吃得下。
/** harness 版的 LLM 边界投影:自定义角色 → user 消息(或过滤),标准三角色原样通过。 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		// map 而不是 flatMap:这里只有"一进一出"和"一进零出"两种情形,没有一条消息
		// 要拆成多条的需求;丢弃靠 undefined + 末尾的 filter 表达。
		// 返回类型显式写成 `Message | undefined`,是为了让各 case 里的对象字面量拿到
		// 上下文类型 —— 少了它,`{ type: "text" }` 的 type 会被推成 string 而不是字面量。
		.map((m): Message | undefined => {
			// 判别联合的分派点:本文件注册的 4 个角色 + pi-ai 的 3 个标准角色,共 7 个 case。
			switch (m.role) {
				case "bashExecution":
					// 全文件唯一真正的"不进 LLM"开关:命中就整条消失,连占位都不留。
					// 删掉这三行,被标记为不入上下文的命令输出会照样发给模型。
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						// 借 user 角色装:pi-ai 只认 user / assistant / toolResult 三种角色,
						// "这是一段命令输出"这个信息只能靠 §5 渲染进文本本身来表达。
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						// 时间戳原样带过去 —— 投影不改时间,重放这段历史时顺序才稳定。
						timestamp: m.timestamp,
					};
				case "custom": {
					// 这个 case 带花括号是必须的:下面声明了 const,不开块作用域就会与
					// 其他 case 共用同一个词法作用域(即 no-case-declarations 那类问题)。
					// string 形态归一化成单元素数组。这**不是**下游的硬性要求 —— pi-ai
					// 三家协议实现都能吃 string content(如 openai-completions.ts:898);
					// 归一化只是让边界之后的代码少面对一种形状。
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					// 这里**没有**读 m.display:display:false 的自定义消息照样进模型。
					// 想要"既不给人看也不给模型看",目前只能一开始就别产生这条消息
					//(全景篇 §6.1 记的坑;只有 bashExecution 有 excludeFromContext)。
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						// 摘要拼上 §2 的包裹再送进去;fromId 一类的树元数据一律不带 ——
						// 模型不需要知道会话树的形状,带上只会浪费 token 并诱导它讨论树结构。
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						// 同上,只是换一对包裹常量;tokensBefore 同样不进模型。
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				// pi-ai 的三个标准角色原样透传 —— **同一个对象引用,没有复制**。于是调用方
				// 拿到的数组里,这三种消息与 AgentContext 里的是同一批对象,谁就地改它就是
				// 改了会话历史。下游 transformMessages 从不就地改(要改就 spread 出新对象;user
				// 消息干脆原样透传),所以实践中安全,但别在这条边界上依赖"我拿到的是副本"。
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				// default 不是防御性冗余,而是 §4 声明合并的必然后果:别的模块也能往
				// CustomAgentMessages 里注册角色,这个联合类型对本文件是**开放**的。
				// 代价要记住:应用注册的第五个角色若没人回来改这个 switch,就会在 LLM 边界
				// 被静默丢弃 —— 不报错、不告警,表现是"模型好像没看到我塞进去的东西"。
				default:
					return undefined;
			}
		})
		// 类型谓词 `m is Message` 是必须的:普通 filter 不会把 `(Message | undefined)[]`
		// 收窄成 `Message[]`,少了它这个函数的返回类型就对不上。
		.filter((m): m is Message => m !== undefined);
}
