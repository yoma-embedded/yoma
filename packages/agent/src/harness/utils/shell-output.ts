/**
 * shell 输出捕获:一边流式回报进度,一边把"给模型看的尾巴"控制在上限内,
 * 同时把完整输出旁落到临时文件,方便模型用 bash 回查。
 *
 * 三条纪律:
 * 1. 给模型的是**尾部**(truncateTail)—— 命令的错误和最终结果都在结尾。
 * 2. 内存里只保留 2 倍上限的尾巴,再多就丢,不会因为一条 `find /` 撑爆进程。
 * 3. 一旦超限就开一个临时文件把全量写进去,并在结果里带上路径。
 */
/**
 * ── 这个文件在做什么(给第一次读内核的人)────────────────────────────
 *
 * 一句话:把「跑一条 shell 命令」的输出收口成结构化结果 —— 边跑边把进度喂给 UI,
 * 同时保证最终交给模型(LLM)的那段文本有一个确定的上界。
 *
 * **全景链路上的位置**:全景篇 §4 的第 33 步(阶段 5「工具执行」)。链路是
 * `agent-loop.ts` → bash 工具的 `execute()` →(本文件)`executeShellWithCapture()`
 * → `ExecutionEnv.exec()` → `spawn(bash, ["-c", cmd])`。
 * 上游唯一的生产调用方是 `coding-agent/src/core/tools/bash.ts:152`;
 * 下游依赖两个:`harness/types.ts` 的 `ExecutionEnv`(跑进程 + 写文件的注入接口)
 * 与 `harness/utils/truncate.ts` 的 `truncateTail`(真正动刀的截断算法)。
 *
 * **三个术语**(第一次读内核的话先看这三条):
 * - **工具调用(tool call)**:模型在回复里要求宿主执行一个函数,bash 是其中之一。
 *   执行结果会以一条 toolResult 消息塞回上下文,再发一次请求 —— 所以工具输出
 *   **直接占用上下文窗口**,这就是本文件存在的全部理由。
 * - **chunk**:子进程 stdout/stderr 上的一段字节。Node 读到多少回调多少(管道单次
 *   上限 64KiB),chunk 边界落在哪里完全不可控,与行边界毫无关系。
 * - **旁落(spill)**:超限时把全量输出写进临时文件,只把尾巴给模型,并在文案里
 *   附上路径,让模型自己用 bash 回查。
 *
 * 对应学习文档:docs/learn/agent/harness_utils_shell-output.md
 *
 * 分节索引:
 *   §1 三个对外接口:进度、选项、最终结果
 *   §2 错误归一化:toExecutionError
 *   §3 sanitizeBinaryOutput:控制字符过滤
 *   §4 trimToLastUtf8Bytes:内存尾巴的硬上界
 *   §5 executeShellWithCapture:一次捕获的全部可变状态
 *   §6 全量旁落:两个把写盘串起来的闭包
 *   §7 createProgress:把累计量拼成一份快照
 *   §8 onChunk:每个 chunk 的记账
 *   §9 主流程:exec → 收尾落盘 → 四条返回路径
 */
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	ok,
	type Result,
	type ShellExecOptions,
	toError,
} from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

// ── §1 三个对外接口:进度、选项、最终结果 ──────────────────────────────

/**
 * 流式进度快照 = 「此刻如果就停下,交给模型的会是什么」。
 * - `output`:给模型看的文本(未超限时是全量,超限后是尾巴)。
 * - `truncation`:截断账本。bash.ts 的 `formatOutput` 靠它拼那句
 *   `[Showing lines a-b of N. Full output: …]` 脚注 —— **截断必须标注**,
 *   裸截断是「自信地错」,比可见地错糟得多。
 * - `fullOutputPath`:全量旁落文件的绝对路径,**只有超限后才有值**。
 * - `lastLineBytes`:当前那条「还没换行」的行有多少字节,给「最后一行是半行」
 *   这种截断形态报尺寸用(它有一个真实的坑,见文档 §5)。
 */
export interface ShellCaptureProgress {
	output: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	// 第二个参数是 **getter 而不是值**:算一次进度要跑一遍 truncateTail(O(尾巴长度)),
	// 而调用方常常只是节流后偶尔看一眼(bash.ts 是 100ms 一次)。传函数 = 不看就不算。
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress) => void;
	/** 把 shell 执行失败连同已捕获的输出一起返回,而不是返回失败的 Result。 */
	returnExecutionErrors?: boolean;
}

/**
 * 最终结果 = 进度快照 + 四个只有「跑完了」才知道的字段。
 * - `exitCode`:被取消时是 `undefined` 而不是 0/143 —— 被杀掉的进程的退出码没有
 *   意义,给一个数字会让模型当真去解读它。
 * - `cancelled`:用户或上层掐的,**不是错误**,所以走 ok 一侧。
 * - `truncated`:与 `truncation.truncated` 同值,提到顶层只是让调用方少一跳。
 * - `executionError`:只有 `returnExecutionErrors: true` 时才可能出现(见 §9)。
 */
export interface ShellCaptureResult extends ShellCaptureProgress {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	executionError?: ExecutionError;
}

// ── §2 错误归一化:toExecutionError ───────────────────────────────────────

/**
 * 把「任何被捕获物」收敛成 `ExecutionError`。
 * 入参写 `unknown` 是认真的:JS 的 throw 什么都能扔(字符串、数字、普通对象),
 * 而 `env.appendFile` 返回的 `FileError` 也不是 `ExecutionError`。
 * 不是自家类型的一律落到分类码 `"unknown"`,并把原始错误挂在 `cause` 上 ——
 * 信息不丢,只是降级成「说不清是哪一类」。
 */
function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

// ── §3 sanitizeBinaryOutput:控制字符过滤 ─────────────────────────────────

/**
 * 唯一的**导出**辅助函数(另外两个 helper 都是模块私有)。
 * 【现状】全仓除了本文件 L347 的自用之外没有第二个调用点 —— 它随
 * `packages/agent/src/index.ts` 的 `export *` 成了包的公开 API,但没人消费。
 *
 * 保留 tab / LF / CR 三个 C0 控制字符,是因为只有它们**有排版含义**;
 * 其余 C0(0x00–0x1f)一律丢掉:模型看到的是纯文本,`\x00` 这类字符既没有意义,
 * 又会在 JSON 序列化、终端渲染、diff 三处各制造一种麻烦。
 */
/** 剔除控制字符,只留 tab / LF / CR;二进制输出直接喂给模型会污染上下文。 */
export function sanitizeBinaryOutput(str: string): string {
	// 按 **码点(code point)** 迭代而不是按 UTF-16 码元:`Array.from` 会把一对
	// 代理项(一个 emoji、一个补充平面汉字)当成一个元素,过滤不会把它劈成两半。
	// 代价是每个 chunk 都要展开成一个逐码点的数组,64KiB 的 chunk 就是 6 万多个元素。
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			// 0x09=tab、0x0a=LF、0x0d=CR。白名单放在最前面,下一行才能写成无条件丢弃。
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			// 剩下的 C0 控制字符全丢。注意 **ESC(0x1b)也在其中**:彩色输出的 `\x1b[31m`
			// 只被吃掉 ESC,留下字面量 `[31m` 混在文本里(见文档 §5)。
			// 另外 0x7f(DEL)与 C1(0x80–0x9f)**不在**这条规则里,会原样留下。
			if (code <= 0x1f) return false;
			// U+FFF9–U+FFFB 是「行间注释」(interlinear annotation)标记,属于不该出现在
			// 正文里的格式字符;放它过去会让下游按字符数做的排版全部错位。
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

// ── §4 trimToLastUtf8Bytes:内存尾巴的硬上界 ─────────────────────────────

/**
 * 这是文件头第 2 条纪律(「内存里只保留 2 倍上限的尾巴」)的兑现处。
 * 每收一个 chunk 就把内存里的 tailOutput 削回 maxBytes 以内,于是无论命令打出
 * 10MB 还是 10GB,本函数的内存占用都是常数。
 *
 * `encoder` 走参数注入而不是在函数体里 `new`:调用方每个 chunk 都要调它一次,
 * 复用同一个 TextEncoder 省掉一次分配。
 * 失败模式:没有 —— 越界下标用 `?? 0` 兜住,本函数不抛也不返回 Result。
 */
/** 保留字符串的最后 maxBytes 字节,并对齐到 UTF-8 字符边界。 */
function trimToLastUtf8Bytes(text: string, maxBytes: number, encoder: { encode(input?: string): Uint8Array }): string {
	const bytes = encoder.encode(text);
	// 快路径,而且是**保真**的一条:没超限就原样返回,不做 encode→decode 往返。
	// 走了往返的话,字符串里的孤立代理项会被 TextEncoder 换成 U+FFFD ——
	// 那是不可逆的损伤,而绝大多数命令根本到不了这个量级。
	if (bytes.byteLength <= maxBytes) return text;
	// 只从**后面**留:命令的报错与最终结果都在结尾(文件头第 1 条纪律)。
	let start = bytes.byteLength - maxBytes;
	// 0b10xxxxxx 是续接字节,往前推到字符起始位置。
	// `?? 0` 只是给类型系统的越界兜底(start 恒在 [0, byteLength) 内)。
	// 0xc0 掩码取高两位,等于 0x80 即 0b10xxxxxx 的续接字节。
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	// 对齐之后再解码,所以这里解不出半个字符。默认的 TextDecoder 不是 fatal 的,
	// 万一真撞上非法序列也只会得到 U+FFFD,不抛。
	return new TextDecoder().decode(bytes.subarray(start));
}

// ── §5 executeShellWithCapture:一次捕获的全部可变状态 ────────────────────

/**
 * 本文件的主角,也是 bash 工具的全部实现骨架。
 *
 * 参数:
 * - `env`:注入的执行环境。只用到三个方法 —— `exec`(跑命令)、`createTempFile`
 *   (开旁落文件)、`appendFile`(追加)。注入而不是直接 `spawn`,是为了让测试
 *   能塞一个假 env,也是为了让本文件保持「不碰 node:*」。
 * - `command`:原样交给 `bash -c`。本文件不解析、不转义、不拆词。
 * - `options`:见 §1。
 *
 * 返回 `Result<ShellCaptureResult, ExecutionError>` —— 本仓的错误约定是**返回**
 * 而不是 throw(见 harness/types.ts §1)。**「命令返回非 0」不是失败**,那是 ok
 * 一侧的 `exitCode`;只有 shell 起不来、旁落写盘失败、onChunk 抛错这类「没能把
 * 这件事做完」才是 err。
 *
 * 一次调用内的所有状态都是下面这一批局部变量,没有任何模块级全局 —— 所以并发跑
 * 多条命令互不干扰(bash 工具没标 `executionMode: "sequential"`,是真会并发的)。
 */
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	// 内存里唯一保存输出的地方。它**不是全量**:每个 chunk 末尾都会被削回
	// maxOutputBytes(见 §4),所以它永远只是「最后这一段」。
	let tailOutput = "";
	// 为什么是 2 倍(100KB)而不是刚好 50KB:trim 是按**字节**切的,会把切点上那一行
	// 拦腰砍断。留一倍余量,truncateTail 取最后 50KB 时就永远够不到缓冲区开头那半行,
	// 于是模型看到的第一行必然是完整的。写成 1 倍的话,「刚好没触发 truncateTail」的
	// 那个区间里,那半行会原样出现在模型眼前。
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	// 一个实例复用到底:每个 chunk 至少 encode 两次(算字节数、削尾巴),
	// 而 TextEncoder 是无状态的,重复 new 只是白白分配。
	const encoder = new TextEncoder();

	// 下面四个是**全程累计量**,与 tailOutput 无关 —— 已经被削掉的部分也算在里面。
	// 「到底截没截断」只能靠它们判断(见 §7),这是本文件最容易想错的一处。
	let totalBytes = 0;
	let completedLines = 0;
	let hasOpenLine = false;
	let currentLineBytes = 0;
	// 这两个字段必须分开:`fullOutputRequested` 在**同步**决定「要开文件」的那一刻
	// 就置位,而 `fullOutputPath` 要等 createTempFile 这个 await 落地才有值。
	// 合成一个的话,下一个 chunk 的判断会以为还没开过,于是开出第二个文件,
	// 前一半输出就此失联。
	let fullOutputPath: string | undefined;
	let fullOutputRequested = false;
	// 闸门:env.exec 一返回就置 false。子进程退出后 stdout/stderr 仍可能吐出残余
	// chunk(孙子进程占着管道时,exec 靠空闲计时器强制收尾),放它们进来会改写
	// 已经算好的最终快照。
	let acceptingOutput = true;
	// 全量落盘串行化:每次 append 都挂在上一次之后,保证磁盘上的顺序与到达顺序一致。
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	// onChunk 是**同步回调**,里面抛错没有地方接:抛回 env.exec 会被判成
	// callback_error 并**杀掉进程树**。所以本文件自己把它接住暂存,主流程收尾时再返回。
	let captureError: ExecutionError | undefined;

	// ── §6 全量旁落:两个把写盘串起来的闭包 ─────────────────────────────

	/**
	 * 往旁落文件追加一段。**不返回 Promise**:调用方(§8 的 onChunk)是同步回调,
	 * 没法 await —— 写入的顺序与失败由 writeChain 这条链统一兜底。
	 * 两个早退条件:还没决定要开文件(短命令的常态,一次系统调用都不做),
	 * 或者捕获已经出错(再写下去只是往一个注定被丢弃的文件里倒垃圾)。
	 */
	const appendFullOutput = (text: string): void => {
		if (!fullOutputRequested || captureError) return;
		// 把新任务接在旧任务后面,而不是 `void env.appendFile(...)` 直接发出去:
		// 并发的 append 落盘先后是不保证的,而这个文件的全部价值就是「顺序」。
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			// 正常不可达 —— 能走到这里说明 ensureFullOutputFile 那一环已经先失败了,
			// 而失败会沿着链传下来被上一行截住。留着是为了不出现「静默地什么也没写」。
			if (!fullOutputPath) return err(new ExecutionError("unknown", "Full output path was not created"));
			const appendResult = await env.appendFile(fullOutputPath, text);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	/**
	 * 第一次超限时开旁落文件,并把**此刻内存里的 tailOutput 整个**写进去当开头。
	 *
	 * 为什么写 tailOutput 而不是「从命令第一个字节起」:本文件根本没有全量副本。
	 * 但这里不会丢开头 —— 触发阈值(50KB)只有内存上限(100KB)的一半,而 §8 里
	 * 削尾巴发生在触发**之后**,所以触发那一刻 tailOutput 必然还是从第 0 字节起的
	 * 完整内容。实测拿 200KB 的单个 chunk 试过,一字不丢(见文档 §5 对全景篇的更正)。
	 *
	 * `fullOutputRequested` 必须**同步**置位,理由见 §5 那两个变量上的注释。
	 * 失败时不抛:错误留在 writeChain 里,由 §9 的 `await writeChain` 统一收。
	 */
	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			// prefix/suffix 是给人找的:出问题时 `ls $TMPDIR/*/bash-*.log` 就能捞出来。
			// 注意这个文件**没有人删**(NodeExecutionEnv.cleanup 只杀进程,不清临时目录),
			// 每一次超限的 bash 调用都会在临时目录里留一份,靠操作系统回收。
			const tempFile = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	// ── §7 createProgress:把累计量拼成一份快照 ──────────────────────────

	/**
	 * 把「全程累计量 + 内存尾巴」合成一份 ShellCaptureProgress。
	 * 纯读:不改任何状态,所以流式期间调多少次都安全(bash.ts 每个 chunk 调一次)。
	 * 代价是每次都要跑一遍 truncateTail,量级 O(尾巴长度) —— 这正是 §1 把它作为
	 * getter 而不是值传出去的原因。
	 */
	const createProgress = (): ShellCaptureProgress => {
		// 用默认上限(2000 行 / 50KB,见 truncate.ts)。真正动刀的算法在那边,
		// 本文件只负责「喂给它什么」和「事后改哪几个字段」。
		const tailTruncation = truncateTail(tailOutput);
		const totalLines = completedLines + (hasOpenLine ? 1 : 0);
		// tailOutput 已经被裁过,所以"是否截断"要用全程累计量判断,不能信 tailTruncation。
		const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
		// 下面这个对象是「以 tailTruncation 为底,覆盖三个只有本文件知道的字段」。
		// 保留不动的 outputLines / outputBytes / lastLinePartial 描述的是**尾巴**;
		// 被覆盖的 totalLines / totalBytes / truncated 描述的是**全程**。
		// bash.ts 的脚注 `startLine = totalLines - outputLines + 1` 正好横跨两者,
		// 少覆盖一个就会算出「Showing lines 1-2000 of 2000」这种自相矛盾的话。
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			// `??` 右边是兜底:tailOutput 已经削过,只要全程超限它自己通常也超限,于是
			// tailTruncation.truncatedBy 非空。留着是为了绝不把 `truncated: true` 配
			// `truncatedBy: null` 这种自相矛盾的组合发出去。
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes,
		};
		return {
			// 没截断时给的是 tailOutput 而不是 truncation.content —— 此刻两者是同一个字符串
			// (truncateTail 未截断时原样返回入参),这么写只是让「没截断就是原样」自明。
			output: truncated ? truncation.content : tailOutput,
			truncation,
			fullOutputPath,
			// 注意它是「当前**未闭合**行」的字节数:chunk 以换行结尾时这里被重置为 0。
			// 于是「最后一行超长且带结尾换行」的命令,bash.ts 会印出 `(line is 0B)`。
			// 实测确认,见文档 §5。
			lastLineBytes: currentLineBytes,
		};
	};

	// ── §8 onChunk:每个 chunk 的记账 ────────────────────────────────────

	/**
	 * stdout 与 stderr 共用的**同一个**回调(见下面 §9 里的 onStdout/onStderr 两行)。
	 * 合流是有意的:命令把提示打在 stdout、把报错打在 stderr,分开给模型就丢了两者的
	 * 先后关系。代价是本文件拿不到「这一段来自 stderr」这个信息,给模型的文本里也就
	 * 没有区分 —— 想区分只能自己在命令里加 `2>&1` 之外的标记。
	 *
	 * 整个函数体裹在 try 里,理由见 §5 的 captureError:这里跑在 Node 的 'data' 事件上,
	 * 抛出去等于把异常扔进 env.exec 的回调保护网,而那边会判 callback_error 并杀进程树。
	 */
	const onChunk = (chunk: string): void => {
		// 迟到的残余输出直接丢弃,理由见 §5 的 acceptingOutput。
		if (!acceptingOutput) return;
		try {
			// 两步归一化。`\r` **全删**(不是只删 CRLF 里的那个):进度条类命令靠回车原地
			// 刷新,留着的话模型看到的是一行里叠了几十个版本。副作用是 CRLF 顺带被拉平成 LF,
			// 而 Windows 上大多数工具输出正是 CRLF。
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			// 字节数按 **UTF-8** 算而不是 `text.length`:中文一个字 3 字节,按字符数算的话
			// 上限对中文输出会宽出三倍,50KB 的承诺就成了 150KB。
			const textBytes = encoder.encode(text).byteLength;
			totalBytes += textBytes;
			// 只数换行,不把切出来的数组留下 —— 留下就等于又存了一份全量。
			const newlineCount = text.split("\n").length - 1;
			completedLines += newlineCount;
			// 下面这一段维护「最后一行还没写完」这个状态。chunk 边界与行边界毫无关系,
			// 一行可以横跨十个 chunk:`hasOpenLine` 让行数统计不把这半行漏掉,
			// `currentLineBytes` 则是 bash.ts 报「这一行有多大」的唯一来源。
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const trailingText = text.slice(lastNewline + 1);
				currentLineBytes = encoder.encode(trailingText).byteLength;
				hasOpenLine = trailingText.length > 0;
			} else if (text.length > 0) {
				// 本块没有换行,说明还在同一行上继续追加。
				currentLineBytes += textBytes;
				hasOpenLine = true;
			}

			// 顺序在这里是承重的:**先并进尾巴,再判超限,最后才削**。
			// 把削尾提到判超限之前,旁落文件的开头就会缺一块(见 §6 的说明)。
			tailOutput += text;
			const totalLines = completedLines + (hasOpenLine ? 1 : 0);
			// 严格大于:正好 50KB / 正好 2000 行**不算**超限,与 truncate.ts 的
			// `totalLines <= maxLines && totalBytes <= maxBytes` 是同一条线,两边必须同解 ——
			// 不同解会出现「标了截断但内容一字未少」或者反过来的怪状。
			if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
				ensureFullOutputFile(tailOutput);
			// else-if 而不是两条独立 if:触发的那一个 chunk 已经整个包含在
			// ensureFullOutputFile 的初始内容里,再 append 一次就是重复一段。
			} else if (fullOutputRequested) {
				appendFullOutput(text);
			}
			// 削回 100KB。这是内存占用的天花板,也是「一条 `find /` 撑不爆内核进程」的兑现。
			tailOutput = trimToLastUtf8Bytes(tailOutput, maxOutputBytes, encoder);
			// 给调用方的是**这一块**的净化后文本 + 一个进度 getter。放在削尾之后,于是调用方
			// 任何时刻看到的进度都与最终结果同构(而不是一份还没削过的中间态)。
			options?.onChunk?.(text, createProgress);
		} catch (error) {
			// 只记不抛:抛出去会被 env.exec 判成 callback_error 并**杀掉进程树**,于是
			// 「UI 回调里出了个小问题」升级成「命令被打断」。这里让命令继续跑完,结果在 §9
			// 以 err 返回。实测:onChunk 抛 `new Error("boom")` → err,code 是 "unknown"。
			captureError = toExecutionError(error);
		}
	};

	// ── §9 主流程:exec → 收尾落盘 → 四条返回路径 ────────────────────────

	// 外层 try 兜的是 env.exec 自己抛或拒的情况。接口约定它返回 Result,但实现是注入的,
	// 不能假设它守约 —— 这一层塌了的话,调用方拿到的会是一个逃出 Result 世界的异常。
	try {
		// 选项是**逐字段转发**而不是 `...options`:onChunk / returnExecutionErrors 是本文件
		// 自己的字段,原样透传下去会被 exec 当成不认识的键;更坏的是将来 ShellExecOptions
		// 加了同名字段,行为会悄悄变掉。
		const result = await env.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			abortSignal: options?.abortSignal,
			// 合流点就是这两行:同一个函数装两条流。
			onStdout: onChunk,
			onStderr: onChunk,
		});
		// 关闸要在算快照之前。`await` 之后的这一行与后面的代码在同一个微任务里,任何还没
		// 派发的 'data' 事件都排在它之后,于是最终快照不会再被后到的 chunk 改写。
		acceptingOutput = false;
		let progress = createProgress();
		// 兜底:正常路径下 §8 早就触发过了(两处用的是同一组阈值与同一批累计量),这一行
		// 只在「exec 从未回调 onChunk 却又攒出了超限的量」这种不该发生的情形下才生效。
		// 注意它传的 tailOutput **已经被削过**,真走到这里开头是会缺的。
		if (progress.truncation.truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
		// 到这里才 await 整条写入链:流式期间一次都不等,写盘的延迟完全不影响命令的执行
		// 与 UI 的刷新。
		const writeResult = await writeChain;
		// 旁落写失败 = 整次捕获失败。看起来狠,但替代方案更坏:返回一个文案里写着
		// `Full output: undefined` 的成功结果,模型会照着那个路径去 cat,然后得到一句
		// 「文件不存在」并开始怀疑自己上一步做错了什么。
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);
		// 落盘完成后重算一次,这样 fullOutputPath 才会出现在返回值里。
		// 重算的不只是 fullOutputPath:闸门已关,writeChain 期间不会再有新 chunk,
		// 所以其余字段与 L417 那次完全一致,这次重算是廉价的。
		progress = createProgress();

		// 下面是四条返回路径,顺序不能换:
		//   ① 被取消       → ok + cancelled,exitCode 置空
		//   ② 其它执行错误 → returnExecutionErrors 时 ok + executionError,否则 err
		//   ③ 正常跑完     → ok + exitCode(非 0 也是 ok,怎么解读由调用方决定)
		//   ④ 意外抛出     → err(最外层 catch)
		if (!result.ok) {
			// 取消排在最前:超时或回调错误发生时,信号往往也已经 abort 了,而对用户来说
			// 「我按了停止」比「它超时了」更接近真相。第二个条件是补网 —— exec 可能因为别的
			// 码返回,但信号确实已经掐了。
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: true,
					truncated: progress.truncation.truncated,
				});
			}
			// 这个开关的全部意义:让**失败也能带着已经捕获到的输出**回去。bash.ts 打开它,
			// 于是超时的命令仍然能把超时前打出来的内容给模型看(`Command timed out after N
			// seconds` 那句就拼在输出后面)。关着的话下一行的 err 会把 progress 整个丢掉 ——
			// 「输出被截断了、全量在哪」这条信息在失败路径上只以文字形式存在。
			if (options?.returnExecutionErrors) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: false,
					truncated: progress.truncation.truncated,
					executionError: result.error,
				});
			}
			return err(result.error);
		}
		// 成功路径也要看一眼信号:命令可能刚好在 abort 前一瞬正常退出,那一刻的 exitCode
		// 是真的,但对上层来说这一轮已经被放弃了。
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			...progress,
			// 被杀的进程退出码没有意义(bash 可能回 0、可能回 143),置 undefined 让调用方
			// 无从解读 —— bash.ts 正是靠 `!== undefined` 决定要不要报「Command exited with code」。
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: progress.truncation.truncated,
		});
	} catch (error) {
		// 关闸再返回。注意这条路径**不 await writeChain**:已经排进队的 append 会在后台
		// 继续写完,失败也无人知晓 —— 反正结果已经是 err 了。
		acceptingOutput = false;
		return err(toExecutionError(error));
	}
}
