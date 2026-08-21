// M7 Step 1:提示词模板的参数解析与格式化。
// harness 只依赖 formatPromptTemplateInvocation;它 = substituteArgs(模板内容, 参数)。
// 占位符语法学自 shell:$1 位置参数、$ARGUMENTS/$@ 全部参数、${@:N}/${@:N:L} 切片。
// 从磁盘加载模板(loadPromptTemplates,含 frontmatter 解析)是 M9 的事。
/**
 * 职责:把 slash command 的原始参数字符串切成 args[](parseCommandArgs),
 * 再把 args[] 代入模板正文里的 shell 风格占位符(substituteArgs / formatPromptTemplateInvocation)。
 *
 * 在全景链路上的位置:属于 harness 的「显式调用」入口之一(全景篇 §5.2:
 * `agent-harness.ts` 的 `skill()` / `promptFromTemplate()` 与 `harness/skills.ts` 的
 * `formatSkillInvocation` 并列),不在「一次 prompt 的 48 步生命周期」主链路上——
 * 它产出的只是一段 user 消息文本,格式化完之后照样要走同一条 `executeTurn`。
 * 全景篇 §6.1 与 §7 都明确指出:本文件里"从磁盘加载模板"的那一半(loadPromptTemplates)
 * 从未实现,`AgentHarnessResources.promptTemplates` 全仓无人填写,所以
 * `harness.promptFromTemplate()` 在当前形态下必然抛 `Unknown prompt template`——
 * 这两个函数目前只在 `example/06-技能与模板-skill如何变成提示词.ts` 里被手工调用过。
 *
 * 对应学习文档:docs/learn/agent/harness_prompt-templates.md
 *
 * 分节索引:
 *   §1 类型引入(本段落下方的 import)
 *   §2 parseCommandArgs —— shell 风格的引号感知参数分词
 *   §3 substituteArgs —— 五种占位符的顺序替换
 *   §4 formatPromptTemplateInvocation —— 对外的唯一入口,harness 只依赖它
 */
// ── §1 类型引入 ──────────────────────────────────────────────────────────
import type { PromptTemplate } from "./types.ts";

// ── §2 parseCommandArgs:shell 风格的引号感知参数分词 ────────────────────────
// 逐字符状态机,不是正则:只认单引号/双引号两种引号、只认空格与 Tab 为分隔符,
// 不支持反斜杠转义,引号不匹配时(字符串结束仍 inQuote)不报错、直接把已读到的
// 内容当成最后一个 token 吐出去——这是刻意宽松,不是遗漏(调用方是用户输入的
// slash command 参数,报错体验远不如"尽量猜")。
/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			// 只跟"打开这段引号时用的那个字符"比较,所以单引号里出现双引号(反之亦然)
			// 会被当成普通字符收进 current,不会提前闭合——这是有意的宽松引号语义。
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			// 引号字符本身不进 current:`a"b c"d` 拼出的是一个 token "ab cd",
			// 引号只是"这一段允许出现空格"的标记,不是要保留的字面量。
			inQuote = char;
		} else if (char === " " || char === "\t") {
			// `if (current)` 用真值判断而非长度判断:意味着连续多个分隔符
			// 之间不会产生空字符串 token,也不会在开头产生一个多余的空 token。
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	// 循环结束时 inQuote 可能仍非 null(未闭合引号)——这里不做任何报错或提示,
	// 直接把已经攒下的 current 当最后一个 token 收尾,与"闭合正常"的路径完全一样。
	if (current) args.push(current);
	return args;
}

// ── §3 substituteArgs:五种占位符的顺序替换 ──────────────────────────────────
// 四次 `result.replace()` **顺序执行、每次都在上一次的输出上再跑一遍**,不是
// 对原始模板做一次性的单趟扫描。这带来一个真实的坑:如果某个 args[i] 的值里
// 恰好含有字面量 "$ARGUMENTS" 或 "$@",它会被本函数自己产出的文本"回炉"再替换
// 一次(见文档 §5 的实测:substituteArgs("first=$1 all=$ARGUMENTS", ["$ARGUMENTS-x"])
// 会把替换进去的那份 "$ARGUMENTS-x" 里的 "$ARGUMENTS" 再吃一遍)。
/** Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments. */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	// $1/$2/…:`\d+` 是贪婪匹配,所以 "$10" 取的是整数 10(对应 args[9]),
	// 不会像传统 shell 那样被理解成 "$1" 后面跟着字面量 "0"。
	// 缺失的位置参数(下标越界)代入空字符串而不是保留原样的 "$N" 文本。
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	// ${@:N} / ${@:N:L} 是 1-based 起点、可选长度的切片语法。
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		// N-1 换算成 0-based 下标;N<=0 时钳到 0(等价于 ${@:1}),
		// 而不是让负下标穿透进 Array.slice 产生"从末尾数"的意外行为。
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	// $ARGUMENTS 与 $@ 是同一个值的两种写法,分两条正则各自替换而不是合并成一条,
	// 图的是可读性——两者互不重叠,合并成一条 alternation 收益也不大。
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

// ── §4 formatPromptTemplateInvocation:对外的唯一入口 ────────────────────────
// harness 的 `promptFromTemplate()` 只调这一个函数(见文件头总述);
// `args` 缺省为空数组,对应"模板不需要参数,或调用方没传"的情况——
// 此时 substituteArgs 里所有 args[i] 都会代入空字符串,$ARGUMENTS/$@ 代入空串。
/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
