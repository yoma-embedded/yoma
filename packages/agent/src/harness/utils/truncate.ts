/**
 * 工具输出的共享截断工具。
 *
 * 截断由两个互相独立的上限决定 —— 谁先被撞到谁生效:
 * - 行数上限(默认 2000 行)
 * - 字节上限(默认 50KB)
 *
 * 永远不返回半行(bash 的尾部截断是唯一的例外)。
 *
 * 本文件刻意保持浏览器安全:字节数优先用运行时的 Buffer,
 * 没有 Buffer 时退化成手算 UTF-8 长度,不 import node:*。
 */

/**
 * ── 学习注释(本块及以下所有中文注释都是学习文档的配套物,不改动任何可执行代码)──
 *
 * 一句话:把「一段可能很长的文本」按 **行数 + 字节数** 双上限砍成模型看得下的大小,
 * 并把「砍了没有、按哪个上限砍的、原本多大」这些事实结构化地报回去。
 *
 * 全景链路上的位置(见 docs/learn/00-内核全景.md §4 阶段 5 第 33 步「execute」):
 * 工具真的跑完、拿到原始输出之后,把结果塞进 ToolResultMessage 之前的那一跳。
 *   - read 工具 → truncateHead(留开头 —— 读文件时你想看的是前面)
 *   - bash 工具 → shell-output.ts 的 executeShellWithCapture → truncateTail
 *                 (留结尾 —— 命令的报错和最终结果都在最后)
 * 本文件是叶子模块:零 import,不调用任何人。删掉它,read/bash 就没有输出上限,
 * 一条 `find /` 能在模型看到之前就把整个上下文窗口顶爆。
 *
 * 一条产品纪律:**截断必须标注**。裸截断是「自信地错」—— 模型会把半截输出当成全部,
 * 得出的结论看起来毫无破绽。TruncationResult 的每个字段都是给调用方写脚注用的。
 *
 * 对应学习文档:docs/learn/agent/harness_utils_truncate.md
 *
 * 分节索引:
 *   §1 上限常量与 TruncationResult 契约
 *   §2 两把尺子:utf8ByteLength / splitLinesForCounting
 *   §3 孤立代理项替换:replaceUnpairedSurrogates
 *   §4 formatSize:给模型看的人话尺寸
 *   §5 truncateHead:留头,永不半行
 *   §6 truncateTail:留尾,唯一允许半行
 *   §7 truncateStringToBytesFromEnd:按字符往回退的字节裁剪
 *   §8 truncateLine:上游留下的死导出
 */

// ── §1 上限常量与 TruncationResult 契约 ──────────────────────────────
// 这一节的三个常量与两个 interface 是**跨包契约**:
//   - coding-agent 的 read/bash 直接 import 它们拼给模型看的脚注,
//     read.ts:40 的工具 description 里就印着这两个数字;
//   - packages/kernel/src/types.ts 另有一份 6 字段的结构化副本 TruncationInfo
//     (浏览器安全,不能 import 内核),漂移由 host/details-check.ts 的
//     `Assignable<PiRead, ToolDetailsMap["read"]>` 在 typecheck 时兜住 ——
//     这里改名或删字段会让桌面端**编译失败**,只加字段不会误报。
//
// 行数与字节数是**两个互相独立**的闸门,谁先被撞到谁生效,不存在「先按行再按字节」
// 这种先后顺序。
export const DEFAULT_MAX_LINES = 2000;
// 50KB 有多大?按内核自己的估算法(compaction 里 estimateTokens 是字符数 ÷ 4)折算
// 约 1.28 万 token,而压缩留给「最近对话」的预算 keepRecentTokens 一共才 20000。
// 所以这不是随手写的数:一次工具结果就能吃掉大半个「最近窗口」。
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
// 【死常量】grep 工具在这个 fork 里已经删掉(kernel 的 RETIRED_TOOL_NAMES 里就写着
// "grep"),所以它和 §8 的 truncateLine 一样**全仓无调用点**,留着只为少一处与上游的
// 冲突。读到它别推断「内核有 grep 工具」。
export const GREP_MAX_LINE_LENGTH = 500; // grep 单条匹配行的最大字符数

// TruncationResult 是「这一次截断到底发生了什么」的完整事实。调用方据此拼脚注:
// read.ts:78 用 firstLineExceedsLimit 改口给模型一句 `sed -n 'Np' file | head -c 51200`
// 的兜底命令;bash.ts 的 formatOutput 按 lastLinePartial → truncatedBy 的顺序分出三种
// 提示语。注意 content 本身也在这个对象里 —— 结果与元数据一起走,调用方只接一个值。
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	// 【坑】这个标签在两个边界上会说谎(实测确认,详见文档 §5):
	//   (1) 内容只是多一个**结尾换行**导致字节超限时,head 报的是 "lines";
	//   (2) maxLines 恰好等于实际收进的行数时,tail 会把 "bytes" 覆写成 "lines"。
	// 生产上都撞不到:默认上限很大,且 bash.ts 先判 lastLinePartial 再判它。
	/** 撞到的是哪个上限:"lines"、"bytes",未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 输出中完整行的数量 */
	outputLines: number;
	/** 输出的字节数 */
	outputBytes: number;
	// 只有 §6 的尾部路径会把它置 true,是「最后一行被切开过」的唯一信号。
	// bash.ts 的 formatOutput(:72)**第一个**就判它,优先级高于 truncatedBy。
	/** 最后一行是否被截成了半行(仅尾部截断的边界情况) */
	lastLinePartial: boolean;
	// 只有 §5 的头部路径会把它置 true,且此时 content 是空串。
	// 它表达的不是「截断了」而是「一行都给不了」—— 调用方必须换一条路(bash 兜底)。
	/** 第一行本身是否就超过了字节上限(仅头部截断) */
	firstLineExceedsLimit: boolean;
	// 把生效的上限原样回传,调用方不必自己记「这次到底用的是默认值还是我传的值」。
	/** 实际生效的行数上限 */
	maxLines: number;
	/** 实际生效的字节上限 */
	maxBytes: number;
}

// 两个上限都可选,不传就吃 DEFAULT_*。实现里用的是 `??` 而不是 `||`,
// 所以显式传 0 是**生效**的(会得到空内容),不会被当成假值悄悄换回默认值。
export interface TruncationOptions {
	/** 最大行数(默认 2000) */
	maxLines?: number;
	/** 最大字节数(默认 50KB) */
	maxBytes?: number;
}

// ── §2 两把尺子:utf8ByteLength / splitLinesForCounting ──────────────
// 双上限各需要一把尺子:一把量字节、一把量行。两把都刻意手写,不借运行时 API。
//
// 写成模块级常量而不是在函数里现写字面量:正则字面量每次求值都会新建一个 RegExp
// 对象,而 utf8ByteLength 在 bash 流式输出里是**每个 chunk 都要跑**的热路径。
// `\x00-\x7f` 之外即非 ASCII —— 一个字符在 UTF-8 里就不再只占 1 字节。
const nonAsciiPattern = /[^\x00-\x7f]/;

// 参数:任意 JS 字符串(UTF-16 码元序列,允许含孤立代理项)。
// 返回:它按 UTF-8 编码后的字节数,与 `Buffer.from(s, "utf8").length` **逐字节同解**。
// 不抛错、不返回负数,空串返回 0。测试里的差分对照组正是用 Buffer.from 实现的。
/**
 * 手算 UTF-8 字节数。
 *
 * 与 pi 的差异:pi 在有 Buffer 的运行时优先走 `Buffer.byteLength`。这里刻意不这么做 ——
 * Bun 1.3 的 `Buffer.byteLength("aa\ud800", "utf8")` 返回 4,而 `Buffer.from` 实际编码出
 * 5 字节(孤立代理项要变成 3 字节的 U+FFFD)。Node 返回 5。my-pi 跑在 Bun 上,
 * 用它会让尾部截断在孤立代理项附近算错边界,所以统一走这条自己算的路。
 * 顺带的好处:本文件彻底不碰 Buffer,保持浏览器安全。
 */
function utf8ByteLength(content: string): number {
	// 纯 ASCII 前缀可以直接按长度算,只对第一个非 ASCII 字符之后逐字符累加。
	const firstNonAscii = content.search(nonAsciiPattern);
	// 全 ASCII 是绝大多数情况(日志、源码、命令输出),这条快路把它变成一次 O(1) 的
	// length 读取,省掉几万次 charCodeAt。search 找不到时返回 -1。
	if (firstNonAscii === -1) return content.length;

	// 播种值就是 ASCII 前缀的长度 —— 前缀里每个字符恰好 1 字节,不用再逐个数。
	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		// 下面这串阈值就是 UTF-8 的分段表:U+0000–007F 占 1 字节,U+0080–07FF 占 2,
		// U+0800–FFFF 占 3,补充平面(必须用一对代理项表示)占 4。
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		// 高位代理项(0xD800–0xDBFF)。`i + 1 < content.length` 这个条件不能省:
		// 落在字符串**结尾**的高位代理项没有配对对象,要漏到最后那个 else 按 3 字节算。
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				// 成对代理项 = 一个补充平面字符,占 4 字节。
				bytes += 4;
				i++;
			} else {
				// 高位代理项后面跟的不是低位代理项 —— 这是一个**孤立代理项**。
				// UTF-8 编不出它,编码器统一吐 U+FFFD(EF BF BD),恰好 3 字节。
				// 少了这个分支,真实编码出的字节会比这里算的多,尾部截断就会超限。
				bytes += 3;
			}
		} else {
			// 兜底 3 字节:U+0800–U+FFFF 的普通字符(中文全在这一档),外加两种孤立
			// 代理项 —— 结尾处的高位、以及任意位置的低位 —— 同样按 U+FFFD 的 3 字节计。
			bytes += 3;
		}
	}
	return bytes;
}

// 「一行」的唯一定义处。参数是原始内容,返回**不含换行符**的行数组;空串返回空数组
// (0 行,不是「1 行空行」)。head / tail 的 totalLines 与两个循环全部建立在它之上。
function splitLinesForCounting(content: string): string[] {
	// 没有这条快路的话,"".split("\n") 会给出 [""],空输出会被报成「1 行」,
	// read 的脚注就会说「显示第 1-1 行,共 1 行」而文件其实是空的。
	if (content.length === 0) return [];
	const lines = content.split("\n");
	// 末尾换行不算作额外一行。
	// 只 pop 一次:内容以两个换行结尾("a\n\n")时,倒数第二个换行确实分出了一个
	// 真实的空行,那一行要留着。所以这里绝不能写成 while。
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

// ── §3 孤立代理项替换:replaceUnpairedSurrogates ─────────────────────
// 只有 §7 的尾部裁剪会用到它。JS 字符串允许出现落单的代理项(0xD800–0xDFFF),
// 而 UTF-8 编不出这样的码点。把它们提前换成 U+FFFD,是为了让**内容**与 §2 已经
// 按 3 字节记好的**账**对齐 —— 否则「算出来 50KB、真写出去 50KB 多」的事就会发生。
// 返回一个新串;调用方会先用 needsReplacement 判一次,免得对干净字符串白跑这遍 O(n)。
function replaceUnpairedSurrogates(content: string): string {
	let output = "";
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		// 先看高位代理项:只有「后面紧跟一个低位代理项」才是合法的一对,
		// 这时两个码元一起原样保留,并把游标多推一格(下面的 i++)。
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 < content.length) {
				const next = content.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					output += content[i]! + content[i + 1]!;
					i++;
					continue;
				}
			}
			// 走到这里说明高位代理项后面没有配对的低位 —— 落单,换成 U+FFFD。
			output += "�";
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// 低位代理项**独自**出现(合法的一对已在上一分支被整体吃掉),同样落单。
			output += "�";
		} else {
			output += content[i]!;
		}
	}
	return output;
}

// ── §4 formatSize:给模型看的人话尺寸 ────────────────────────────────
// 与截断算法本身无关,纯粹是给脚注排版用的;放在这里是因为它与上限常量同源。
// read.ts / bash.ts 用它把 DEFAULT_MAX_BYTES 印成 "50.0KB"、把某一行的大小印成
// "1.3MB",目的是让模型一眼看懂「为什么被砍了」,而不是去读一串裸数字。
/**
 * 把字节数格式化成人类可读的大小。
 */
// 参数是字节数,返回带单位的字符串。三档:B / KB(1 位小数)/ MB(1 位小数),
// **没有 GB 档** —— 2 GiB 会印成 "2048.0MB"(实测)。分母用 1024 而单位写作 KB/MB
// (严格说该是 KiB/MiB),这是有意与上游保持一致,别顺手「修正」成 1000。
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

// ── §5 truncateHead:留头,永不半行 ──────────────────────────────────
// read 工具唯一的截断入口(core/tools/read.ts:74)。「留头」是产品决策:读文件时
// 你要看的是开头(import、类型、函数签名),而不是结尾。
/**
 * 从头部截断(保留前 N 行 / 前 N 字节)。适合读文件——你想看开头。
 *
 * 永远不返回半行。如果第一行本身就超过字节上限,
 * 返回空内容并置 firstLineExceedsLimit=true(调用方据此给模型一个 bash 兜底建议)。
 */
// 参数:content 原始文本;options 可覆盖两个上限。
// 返回:TruncationResult。**任何输入都不抛错**,永远返回一个对象。
// content 三选一:原样输入(没超限)/ 若干**完整行**用 "\n" 拼回去 / 空串(第一行
// 自己就超了字节上限)。头部路径的 lastLinePartial 恒为 false —— 这是它的对外承诺。
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	// `??` 而不是 `||`:maxLines: 0 是合法且有意义的取值(「一行都别给」),
	// 用 `||` 会把它当成假值悄悄换成 2000。
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	// 先把两个总量算出来 —— 它们既是「要不要截断」的判据,也是结果里报给调用方的事实。
	// 注意两者口径不同:totalBytes 量的是**整串**(含结尾换行),而 totalLines 不数
	// 结尾换行。这个差正是本节末尾那条「标签说谎」的来源。
	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 两个上限都没撞到,原样返回。
	// 快路必须把**整串原样**返回,而不是 lines.join("\n") —— join 会吃掉结尾换行,
	// 于是「没截断」的输出与磁盘上的文件差一个字节。truncated:false 是这条路的标志。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 走到这里说明至少撞了一个上限,内容非空,所以 lines[0] 必然存在。
	// 只量第一行、且不加换行符:这一步问的是「哪怕只给一行,塞得下吗?」
	// 塞不下就没有任何**完整行**可返回 —— 而头部路径承诺永不返回半行。
	const firstLineBytes = utf8ByteLength(lines[0]!);
	// 这是 read 工具的 minified-JS 场景:整个文件就一行、几百 KB。
	// 返回空内容 + firstLineExceedsLimit=true,read.ts:78 据此改口给模型一句
	// `sed -n 'Np' file | head -c 51200` 的兜底命令 —— 把「我读不了」变成「你这样读」。
	// 删掉这个分支的话,下面的循环同样会返回空内容,但标志位丢失,
	// 模型看到的只是一个空结果,不知道该怎么办。
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集能塞下的完整行。
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	// 初值给 "lines":循环正常跑满(没被字节上限打断)时,原因一定是行数。
	// 只有下面那条溢出分支才会把它改成 "bytes"。
	let truncatedBy: "lines" | "bytes" = "lines";

	// 双重上界:`i < lines.length` 防越界,`i < maxLines` 就是行数闸门本身。
	// 于是收进来的行数天然 ≤ maxLines,循环体里不必再判一次。
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i]!;
		// +1 补的是 join("\n") 时会插进去的那个换行符,而第 0 行前面没有分隔符,
		// 所以判据是 `i > 0`。这样 outputBytesCount 与最终 join 出来的真实字节数
		// 逐字节相等 —— 收尾处再用 utf8ByteLength(outputContent) 重算一遍,就是在验这件事。
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 是换行符

		// 先试算再决定:这一行**加进去之后**会不会超。超了就整行不要(而不是切一半),
		// 这就是「头部永不返回半行」的实现点。
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 因行数上限退出的情况。
	// 这条重贴标签只在「循环跑满 maxLines 行且字节没超」时命中;因字节 break 时
	// outputLinesArr.length 一定 < maxLines,不会被误改。
	// 【坑】它盖不住另一个边界:内容只是多一个**结尾换行**导致 totalBytes 超限时
	// (例如 truncateHead("a\n", { maxBytes: 1 })),所有行都收进来了、字节也没超,
	// 标签于是停在初值 "lines" —— 而真正的触发者是 bytes。实测确认,见文档 §5。
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	// join 只在收集完之后做一次:循环里直接拼字符串在 2000 行量级上是 O(n²)。
	const outputContent = outputLinesArr.join("\n");
	// 重新量一遍而不是直接用 outputBytesCount:两者恒等,但这里报的是给调用方看的
	// **事实**,由结果本身量出来更难写错(read.ts 会拿它去印脚注)。
	const finalOutputBytes = utf8ByteLength(outputContent);

	// 到这一步 truncated 必然为 true —— 快路已经拦掉了「没超限」的全部情况。
	// lastLinePartial 恒 false(对外承诺),firstLineExceedsLimit 恒 false
	// (那条路在上面已经提前 return 了)。
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

// ── §6 truncateTail:留尾,唯一允许半行 ─────────────────────────────
// bash 的截断入口,但**不是被 bash 工具直接调的**:调用方是 shell-output.ts 的
// createProgress()。「留尾」同样是产品决策 —— 编译错误、测试失败、命令的
// 最终结果都在输出末尾;砍掉尾巴等于把唯一有用的那段丢掉。
/**
 * 从尾部截断(保留后 N 行 / 后 N 字节)。适合 bash 输出——你想看结尾的错误和最终结果。
 *
 * 当原内容的最后一行本身超过字节上限时,可能返回半行(这是唯一允许半行的地方)。
 */
// 参数与返回形状和 §5 完全一致,只有三处语义差别:
//   1. 从**末尾**往回收集,留下的是最后 N 行;
//   2. 最后一行自己就超上限时**允许返回半行**(全文件唯一的例外),lastLinePartial=true;
//   3. firstLineExceedsLimit 恒为 false —— 那是头部路径才有的概念。
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 与 §5 逐字相同的快路。两个函数刻意没有抽公共子函数(上游写法),
	// 好处是两条路径可以各自演化,代价是改上限语义时必须两边一起改。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾往回走。
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	// lastLinePartial 只有下面那一处会置 true,它是「这段输出的最后一行被切开过」的
	// 唯一信号;bash.ts 的 formatOutput(:72)**第一个**就判它,优先于 truncatedBy。
	let lastLinePartial = false;

	// 倒着走。循环条件用的是「已收集行数 < maxLines」而不是下标算术 ——
	// 因为下面的半行分支也会往数组里塞一个元素,用它计数才不会多收一行。
	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i]!;
		// 与 §5 对称:分隔符算在**除最后收集的那一行之外**的每一行头上。
		// 这里的判据是 outputLinesArr.length > 0(已经收过东西),不是 i 的位置。
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 是换行符

		// 同样是「加进去会不会超」的试算。区别在下面这个 if:头部路径直接 break,
		// 尾部路径多一条例外。
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边界情况:一行都还没收进来,而这一行就超了上限 —— 取它的尾巴(半行)。
			// 只可能在**第一次**迭代命中(收过东西就不会再走进来),所以 line 一定是
			// 原内容的最后一行。没有它的话:一条 300KB 的单行日志会让 bash 返回空输出,
			// 而模型看到的是「命令没有输出」—— 最坏的一种错。
			if (outputLinesArr.length === 0) {
				// 整个 maxBytes 预算都给这一行:此刻它是唯一的内容,没有分隔符要预留。
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				// 用赋值而不是 `+=`:此刻 outputBytesCount 必为 0,写成累加也对,
				// 但赋值把「这一行就是全部输出」这个事实写死了。
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 与 §5 同款的重贴标签,但这里多一个可观测的副作用:
	// 【坑】半行分支也会往数组里塞 1 个元素,所以 maxLines 传 1 时
	// (outputLinesArr.length === 1 >= 1、outputBytesCount ≤ maxBytes)这条判断会把
	// 刚设好的 "bytes" 覆写成 "lines"。实测:truncateTail("X".repeat(100),
	// { maxBytes: 10, maxLines: 1 }) 报 truncatedBy:"lines" 而 lastLinePartial:true。
	// 生产上撞不到:默认 maxLines 是 2000,且 bash.ts 先判 lastLinePartial。
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	// 数组是用 unshift 维护的,所以这里 join 出来就是原始顺序,不需要 reverse。
	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

// ── §7 truncateStringToBytesFromEnd:按字符往回退的字节裁剪 ──────────
// §6 那条半行分支唯一的实现依赖,也是本文件里最容易写错的一段。
// 「保留最后 N 字节」不能写成 `str.slice(-n)`(那是**字符**不是字节),也不能写成
// 在 Buffer 上做字节切片再解码(会在多字节字符中间切开,解出一串 U+FFFD)。
// 唯一正确的做法:从末尾开始**按字符**往回退,一次退一个完整字符,退到预算用完为止。
/**
 * 把字符串截到字节上限以内(从尾部保留)。正确处理多字节 UTF-8:
 * 从后往前按"字符"退,绝不在一个字符中间切开;切出来的孤立代理项换成 U+FFFD。
 */
// 参数:str 待裁剪的单行文本;maxBytes 预算。
// 返回:str 的一个**后缀**,UTF-8 字节数 ≤ maxBytes;放不下任何一个完整字符时返回空串。
// 永不返回半个字符。test/harness/truncate.test.ts 用一份独立的 Buffer 实现做差分对照
// (穷举 3 层字符表 + 1000 条定种子 fuzz),逐个 maxBytes 比对内容与字节上界。
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	// maxBytes 可以是 0 甚至负数(调用方显式传了 maxBytes: 0)。不拦的话下面第一轮
	// 就会 break,结果一样;这条只是把意图写明,顺便省掉一次 charCodeAt。
	if (maxBytes <= 0) return "";

	let outputBytes = 0;
	// start 是「保留区的起点下标」,初值指向串尾 = 什么都不保留。
	// 每成功退一个字符就把它往左挪,最后 str.slice(start) 就是答案。
	let start = str.length;
	let needsReplacement = false;
	// 注意这个 for **没有第三段(步进)**:游标由循环体末尾的 `i = characterStart`
	// 推进,因为「退一步」有时是 1 个码元、有时是 2 个(代理对),步长不是常数。
	for (let i = str.length; i > 0; ) {
		let characterStart = i - 1;
		// 倒着走,所以先看到的是**低位**代理项 —— 与 §2 正着走时先看到高位正好相反,
		// 下面的分支顺序也因此反过来。
		const code = str.charCodeAt(characterStart);
		let characterBytes: number;
		let unpairedSurrogate = false;
		// 低位代理项,且前面还有字符可回看。`characterStart > 0` 这个条件不能省:
		// 串首的低位代理项没有可回看的前驱,它其实就是一个孤立代理项,
		// 要漏到下一个 else if 去按 3 字节处理。
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				// 低位代理项前面就是高位代理项,合成一个 4 字节字符。
				// 把起点再往左挪一格,让这一对代理项作为**一个**字符整体进出预算;
				// 少了这一行就会只保留低位代理项,切出来的是半个 emoji。
				characterStart--;
				characterBytes = 4;
			} else {
				// 低位代理项前面不是高位 —— 落单,按 U+FFFD 的 3 字节记账,
				// 并打上标记留待最后统一替换(与 §2 的算法保持同解)。
				characterBytes = 3;
				unpairedSurrogate = true;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			// 走到这里的代理项一定是落单的:合法的一对已在上一分支被整体吃掉,
			// 而串首(characterStart === 0)的低位代理项也会落到这里。
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			// 普通 BMP 字符,分段表与 §2 完全一致。
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
		// 预算不够就停,而且**整字符不要**。这条 break 是「绝不在字符中间切开」的
		// 实现点;它也解释了 truncateTail("abc🙂", { maxBytes: 3 }) 为什么返回空串
		// 而不是 "abc" —— 保留的是**尾巴**,尾巴上那个 4 字节 emoji 放不下,
		// 再往前的内容就不再属于「最后 3 字节」了。
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		// 只要**保留区里**出现过孤立代理项就打标。`||=` 是逻辑或赋值:一次为真永久为真。
		needsReplacement ||= unpairedSurrogate;
		i = characterStart;
	}

	// slice 而不是逐字符拼:start 已经保证落在字符边界上,直接切是安全的。
	const output = str.slice(start);
	// 干净的字符串直接返回,省掉 §3 那一遍 O(n) 扫描 —— 这是热路径(bash 的每个
	// chunk 都会经 createProgress 走一次 truncateTail)。
	// 替换之后字节数不会变:孤立代理项本来就是按 3 字节记的,U+FFFD 也正好 3 字节。
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

// ── §8 truncateLine:上游留下的死导出 ────────────────────────────────
// 【死代码】全仓没有任何调用点(只被 index.ts 的 `export *` 带出包外)。它是给 grep
// 工具用的,而这个 fork 已经删掉了 grep —— packages/kernel/src/types.ts 的
// RETIRED_TOOL_NAMES 里明写着 "grep"。留着只为少一处与上游的冲突。
/**
 * 把单行截到最大字符数,并追加 [truncated] 后缀。用于 grep 的匹配行。
 */
// 【与本文件其余部分语义不同】复用它之前必须知道两点:
//   1. 它量的是 **UTF-16 码元**(line.length)而不是字节,`slice` 会**切开代理对** ——
//      实测 truncateLine("🙂".repeat(300), 501).text 在切口处留下一个孤立高位代理项。
//      §2/§7 那一整套「绝不切开字符」的纪律在这里**不成立**。
//   2. maxChars **不是返回值的长度上界**:后缀 "... [truncated]" 有 15 个字符,
//      默认档下返回的是 515 个字符。
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	// 不超就原样返回并把 wasTruncated 置 false —— 调用方靠这个布尔决定要不要补一个
	// 「本行已截断」的角标,而不必去比对字符串。
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
