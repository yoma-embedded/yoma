# packages/agent/src/harness/utils/shell-output.ts

> **档位** A(逐行) · **行数** 484(加注释后;原 219) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §4 阶段 5 第 33–34 步、§3「截断:两个上限、两个方向、三种形态」、§5 接线表、§6 会咬人的地方 · **索引** [README](../README.md)

## 1. 一句话

把「跑一条 shell 命令」的输出收口成一个结构化结果:边跑边把进度喂给 UI,同时保证最终交给模型的那段文本有确定的上界(2000 行 / 50KB),超限的部分旁落到临时文件并把路径回传 —— 它是 bash 工具的全部实现骨架。

## 2. 它在全景里的位置

先把三个词摊开。**工具调用(tool call)**:模型在回复里要求宿主执行一个函数,`bash` 是其中之一;执行结果会以一条 toolResult 消息塞回上下文,再发一次请求 —— 所以**工具输出直接占用上下文窗口**,这是本文件存在的全部理由。**chunk**:子进程 stdout/stderr 上的一段字节,Node 读到多少回调多少(管道单次上限 64KiB),边界落在哪里完全不可控。**旁落(spill)**:超限时把全量写进临时文件、只把尾巴给模型,并在文案里附上路径。

对着全景篇 §4 的编号时间线,它只出现在**一跳**上:

- **第 33 步「execute」**。模型发回一个 bash 调用,经第 30 步选执行模式、第 31 步参数校验、第 32 步 `beforeToolCall` hook 之后,`tool.execute()` 进到 `coding-agent/src/core/tools/bash.ts`,而那个函数做的第一件实事就是 `executeShellWithCapture(env, command, { timeout, abortSignal, returnExecutionErrors: true, onChunk })`(`bash.ts:152`)。**这是全仓唯一的生产调用点。**
- **第 34 步「流式部分结果」也从这里出**。`onChunk` 的第二个参数是一个进度 getter,bash 工具拿到之后按 100ms 节流调 `onUpdate(partial)`,再由 harness emit 成 `tool_execution_update` 喂给 UI。这些不进 transcript。

**它调谁**:三个都在注入的 `ExecutionEnv` 上 —— `exec()`(全景篇同一步里的 `spawn(bash, ["-c", cmd], {detached})` + `killProcessTree`)、`createTempFile()`、`appendFile()`;另外调 `truncate.ts` 的 `truncateTail()`,那是全景篇 §3 那段「两个上限、两个方向、三种形态」里真正动刀的算法。本文件自己**不碰 `node:*`**,所有对真实机器的接触都经 `ExecutionEnv` 这一道注入。

**往下一跳**:返回值回到 bash.ts 的 `formatOutput`,把 `truncation` 翻译成三种脚注之一(`[Showing lines a-b of N. Full output: …]`),第 35 步 `finalizeExecutedToolCall` 造 `ToolResultMessage`,第 ⑪ 步 push 进 `currentContext.messages`,下一次请求就带着它发出去。

**不存在会怎样**:bash 工具要么自己重写一份等价的东西,要么把子进程的全部输出原样塞进 toolResult。后者的代价不是「慢」而是「错」—— 一条 `find /` 能在模型看到之前就把上下文窗口顶爆;而更坏的一种是**不加标注的截断**,模型会把半截输出当成全部,得出的结论看起来毫无破绽。全景篇把这句话写成了一条纪律:**裸截断是「自信地错」**。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–L44 | 原有 9 行头注释(三条纪律)+ 新增块注释:职责、全景锚点、三个术语、分节索引 |
| import | L45–L54 | 两个来源:`../types.ts`(契约)与 `./truncate.ts`(截断算法) |
| §1 | L56–L96 | 三个对外接口:`ShellCaptureProgress` / `ShellCaptureOptions` / `ShellCaptureResult` |
| §2 | L98–L111 | `toExecutionError`:把任何被捕获物收敛成 `ExecutionError` |
| §3 | L113–L145 | `sanitizeBinaryOutput`:控制字符过滤(唯一的导出辅助函数) |
| §4 | L147–L174 | `trimToLastUtf8Bytes`:内存尾巴的硬上界 |
| §5 | L176–L233 | `executeShellWithCapture` 签名 + 一次捕获的全部可变状态 |
| §6 | L235–L282 | 全量旁落:`appendFullOutput` / `ensureFullOutputFile` 两个闭包 |
| §7 | L284–L327 | `createProgress`:把累计量拼成一份快照 |
| §8 | L329–L394 | `onChunk`:每个 chunk 的记账 |
| §9 | L396–L484 | 主流程:exec → 收尾落盘 → 四条返回路径 |

## 4. 逐节讲解

### §1 三个对外接口(L56–L96)

`L68–L73`

```ts
export interface ShellCaptureProgress {
	output: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}
```

这是「此刻如果就停下,交给模型的会是什么」的快照,流式期间与最终结果**共用同一个形状**(`ShellCaptureResult extends ShellCaptureProgress`)—— 于是 bash.ts 的 `formatOutput` 一个函数同时服务于中途刷新和最终结果,不用写两遍。

四个字段各有出处:`output` 是给模型看的文本;`truncation` 是截断账本(定义在 `truncate.ts`,15 个字段);`fullOutputPath` 只有超限后才有值;`lastLineBytes` 是「当前那条还没换行的行有多少字节」,专供「最后一行是半行」这种截断形态报尺寸用 —— 它有一个真实的坑,见 §5 第 1 条。

`L75–L81`

```ts
export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress) => void;
	/** 把 shell 执行失败连同已捕获的输出一起返回,而不是返回失败的 Result。 */
	returnExecutionErrors?: boolean;
}
```

`Omit<…, "onStdout" | "onStderr">` 是一道**编译期的门**。stdout 与 stderr 必须由本文件合并成同一条 `onChunk`(命令把提示打在 stdout、把报错打在 stderr,分成两路给模型就丢了两者的先后关系),所以不许调用方从外面再塞一份进来 —— 塞进来会被本文件在 §9 覆盖掉,那是一种静默失效。

第二个参数写成 **getter 而不是值**:算一次进度要跑一遍 `truncateTail`,量级 O(尾巴长度);而调用方常常只是节流后偶尔看一眼。传函数 = 不看就不算。

`L91–L96`

```ts
export interface ShellCaptureResult extends ShellCaptureProgress {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	executionError?: ExecutionError;
}
```

`exitCode` 写成 `number | undefined` 而不是 `number` 是有话要说的:被取消时它是 `undefined`(见 §9)。`cancelled` 走 ok 一侧 —— **中断是数据不是异常**,这与 harness 那边「`prompt()` 在 abort 后 resolve 而不是 reject」是同一条哲学。

### §2 toExecutionError(L98–L111)

`L107–L111`

```ts
function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}
```

入参写 `unknown` 是认真的:JS 的 `throw` 什么都能扔(字符串、数字、`undefined`、一个普通对象),而 `env.appendFile` 返回的 `FileError` 也**不是** `ExecutionError`。`toError`(`types.ts`)先把任意被捕获物归一化成 `Error`,再套一个 `"unknown"` 分类码,原始错误挂在 `cause` 上 —— 信息不丢,只是降级成「说不清是哪一类」。

代价写在这:**旁落文件写失败(一个 `FileError`)最终会以 `code: "unknown"` 的形式出现在调用方眼前**,分类码这一层没能保住。想区分「写盘失败」和「回调抛错」只能读 message。

### §3 sanitizeBinaryOutput(L113–L145)

`L125–L145`

```ts
export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}
```

`Array.from(str)` 按**码点(code point)**迭代而不是按 UTF-16 码元:一对代理项(一个 emoji、一个补充平面汉字)会被当成一个元素,过滤不会把它劈成两半。代价是每个 chunk 都要展开成一个逐码点的数组,64KiB 的 chunk 就是六万多个元素 —— 这是本文件最贵的一段,而它跑在每个 chunk 上。

白名单三个(tab / LF / CR)必须写在 `code <= 0x1f` **之前**,否则下一行会把它们一起吃掉。三条要点:

- **ESC(0x1b)也在 `<= 0x1f` 里**。所以彩色输出 `\x1b[31mred\x1b[0m` 只被吃掉 ESC,留下字面量 `[31mred[0m` 混在文本里。这不是过滤 ANSI 序列的地方,本文件也没有别的地方在做这件事。
- **0x7f(DEL)与 C1(0x80–0x9f)不在这条规则里**,会原样留下。
- U+FFF9–U+FFFB 是「行间注释」(interlinear annotation)格式字符,单独列出来丢掉。

这是本文件唯一的**导出**辅助函数,而它随 `packages/agent/src/index.ts` 的 `export *` 成了包的公开 API。【现状】全仓除了本文件 L347 的自用之外没有第二个调用点。

### §4 trimToLastUtf8Bytes(L147–L174)

`L159–L174`

```ts
function trimToLastUtf8Bytes(text: string, maxBytes: number, encoder: { encode(input?: string): Uint8Array }): string {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	// 0b10xxxxxx 是续接字节,往前推到字符起始位置。
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(bytes.subarray(start));
}
```

这是文件头第 2 条纪律(「内存里只保留 2 倍上限的尾巴」)的兑现处:每收一个 chunk 就把内存里的 `tailOutput` 削回 `maxBytes` 以内,于是无论命令打出 10MB 还是 10GB,本文件的内存占用都是常数。

三处值得停一下:

1. `L164` 的快路径是**保真**的一条 —— 没超限就原样返回,不做 encode→decode 往返。走了往返的话,字符串里的孤立代理项会被 `TextEncoder` 换成 U+FFFD,那是不可逆的损伤;而绝大多数命令根本到不了这个量级。
2. `L170` 的对齐循环:UTF-8 的续接字节高两位固定是 `0b10`,`& 0xc0 === 0x80` 就是在问「这个字节是不是某个字符的中间」。往前推到字符起始位置,`TextDecoder` 才不会在开头解出一个 U+FFFD。
3. `encoder` 走参数注入而不是在函数体里 `new`:调用方每个 chunk 都要调它一次,复用同一个 `TextEncoder` 省掉一次分配。**注意 `TextDecoder` 没享受同等待遇** —— 它在这一行里每次都新建,只是这条路只有超过 100KB 的输出才走得到。

### §5 executeShellWithCapture:签名与状态(L176–L233)

`L196–L200`

```ts
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
```

返回 `Result` 而不是 throw,是本仓的错误约定(见 `harness/types.ts` §1)。这里最要紧的一条是:**「命令返回非 0」不是失败**,那是 ok 一侧的 `exitCode`;只有 shell 起不来、旁落写盘失败、`onChunk` 抛错这类「没能把这件事做完」才是 err。(把非零退出码翻译成一次**工具**失败是 bash.ts 的产品决定,不是本文件的。)

`command` 原样交给 `bash -c`,本文件不解析、不转义、不拆词。

接下来是一次捕获的全部可变状态,**没有任何模块级全局** —— 所以并发跑多条命令互不干扰(bash 工具没标 `executionMode: "sequential"`,是真会并发的)。

`L203–L233`(节选)

```ts
	let tailOutput = "";
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let completedLines = 0;
	let hasOpenLine = false;
	let currentLineBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputRequested = false;
	let acceptingOutput = true;
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;
```

按「为什么存在」分四组:

- **`tailOutput` + `maxOutputBytes`**:内存里唯一保存输出的地方,**不是全量**。为什么是 2 倍(100KB)而不是刚好 50KB —— trim 是按**字节**切的,会把切点上那一行拦腰砍断;留一倍余量,`truncateTail` 取最后 50KB 时就永远够不到缓冲区开头那半行。写成 1 倍会真的咬人,细节见 §7 自测题第 1 题。
- **四个全程累计量**(`totalBytes` / `completedLines` / `hasOpenLine` / `currentLineBytes`):与 `tailOutput` 无关,已经被削掉的部分也算在里面。**「到底截没截断」只能靠它们判断**,这是本文件最容易想错的一处。
- **`fullOutputPath` + `fullOutputRequested`**:两个字段必须分开。后者在**同步**决定「要开文件」的那一刻就置位,前者要等 `createTempFile` 这个 await 落地才有值。合成一个的话,下一个 chunk 的判断会以为还没开过,于是开出第二个文件,前一半输出就此失联。
- **`acceptingOutput` / `writeChain` / `captureError`** 各自守一件事:迟到 chunk 的闸门、落盘顺序的串行链、同步回调里抛错的暂存位。三者分别在 §8、§6、§9 里兑现。

### §6 全量旁落(L235–L282)

`L243–L255`

```ts
	const appendFullOutput = (text: string): void => {
		if (!fullOutputRequested || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			if (!fullOutputPath) return err(new ExecutionError("unknown", "Full output path was not created"));
			const appendResult = await env.appendFile(fullOutputPath, text);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};
```

**不返回 Promise** 是这个闭包最重要的性质:调用方(§8 的 `onChunk`)是同步回调,没法 await。于是写入的顺序与失败全部由 `writeChain` 这条链兜底 —— 每次 append 都挂在上一次之后,保证磁盘上的顺序与到达顺序一致。写成 `void env.appendFile(...)` 直接发出去的话,并发 append 的落盘先后是不保证的,而这个文件的全部价值就是「顺序」。

链上的错误是**粘性**的:`if (!previous.ok) return previous` 让第一个失败一路传到 §9 的 `await writeChain`,后续 append 全部变成空转。

`L268–L282`

```ts
	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};
```

第一次超限时开文件,并把**此刻内存里的 `tailOutput` 整个**写进去当开头。为什么不是「从命令第一个字节起」—— 本文件根本没有全量副本。但这里**不会丢开头**:触发阈值(50KB)只有内存上限(100KB)的一半,而 §8 里削尾巴发生在触发**之后**,所以触发那一刻 `tailOutput` 必然还是从第 0 字节起的完整内容。这一点与全景篇的说法有出入,见 §5 第 2 条。

`fullOutputRequested = true` 在**第一个 await 之前**同步置位,这是「一次调用只开一个文件」的全部保证。

### §7 createProgress(L284–L327)

`L292–L315`

```ts
	const createProgress = (): ShellCaptureProgress => {
		const tailTruncation = truncateTail(tailOutput);
		const totalLines = completedLines + (hasOpenLine ? 1 : 0);
		// tailOutput 已经被裁过,所以"是否截断"要用全程累计量判断,不能信 tailTruncation。
		const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes,
		};
```

这个对象是「以 `tailTruncation` 为底,覆盖三个只有本文件知道的字段」。分清楚谁描述什么是读懂它的关键:

| 字段 | 描述的是 | 来源 |
|---|---|---|
| `outputLines` / `outputBytes` / `lastLinePartial` | **尾巴**(给模型的那一段) | `truncateTail` 原样保留 |
| `totalLines` / `totalBytes` / `truncated` | **全程**(命令一共打了多少) | 本文件的累计量覆盖 |

bash.ts 的脚注 `startLine = truncation.totalLines - truncation.outputLines + 1` 正好横跨两者 —— 少覆盖一个就会算出「Showing lines 1-2000 of 2000」这种自相矛盾的话。

`truncatedBy` 那个 `??` 兜底,读的时候容易高估它的分量:`tailOutput` 只在超过 100KB 时才被削,而 `truncated` 为真意味着全程已经超过 50KB 或 2000 行 —— 两种情况下 `tailOutput` 自己也超限,`tailTruncation.truncatedBy` 必然非空。它是一条防御,防的是「`truncated: true` 配 `truncatedBy: null`」这种自相矛盾的组合流出去。

`L316–L326`

```ts
		return {
			output: truncated ? truncation.content : tailOutput,
			truncation,
			fullOutputPath,
			lastLineBytes: currentLineBytes,
		};
```

本函数**纯读**,不改任何状态,所以流式期间调多少次都安全(bash.ts 每个 chunk 调一次)。代价是每次都要跑一遍 `truncateTail` —— 这正是 §1 把它作为 getter 传出去的原因。

### §8 onChunk:每个 chunk 的记账(L329–L394)

`L340–L354`

```ts
	const onChunk = (chunk: string): void => {
		if (!acceptingOutput) return;
		try {
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			const textBytes = encoder.encode(text).byteLength;
			totalBytes += textBytes;
			const newlineCount = text.split("\n").length - 1;
			completedLines += newlineCount;
```

三件事一次说清:

1. `\r` **全删**,不是只删 CRLF 里的那个。进度条类命令(`curl`、`pip`、`cmake`)靠回车原地刷新,留着的话模型看到的是一行里叠了几十个版本。副作用是 CRLF 顺带被拉平成 LF,而 Windows 上大多数工具输出正是 CRLF —— 换句话说这一行也承担了行尾归一化。
2. 字节数按 **UTF-8** 算而不是 `text.length`:中文一个字 3 字节,按字符数算的话 50KB 的承诺对中文输出就成了 150KB。
3. 只数换行,不把 `split` 出来的数组留下 —— 留下就等于又存了一份全量。

`L358–L367`

```ts
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
```

这一段维护「最后一行还没写完」这个状态。chunk 边界与行边界毫无关系,一行可以横跨十个 chunk:`hasOpenLine` 让行数统计不把这半行漏掉(`totalLines = completedLines + (hasOpenLine ? 1 : 0)`),`currentLineBytes` 则是 bash.ts 报「这一行有多大」的唯一来源。

注意 `else if (text.length > 0)` 这个守卫:空 chunk(整块都是 `\r`,被上面删光了)不该把 `hasOpenLine` 置真。

`L371–L387`

```ts
			tailOutput += text;
			const totalLines = completedLines + (hasOpenLine ? 1 : 0);
			if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
				ensureFullOutputFile(tailOutput);
			} else if (fullOutputRequested) {
				appendFullOutput(text);
			}
			tailOutput = trimToLastUtf8Bytes(tailOutput, maxOutputBytes, encoder);
			options?.onChunk?.(text, createProgress);
```

**顺序在这里是承重的:先并进尾巴 → 再判超限 → 最后才削。** 把削尾提到判超限之前,旁落文件的开头就会缺一块。当前顺序下,实测拿一个 200KB 的单 chunk 灌进去,旁落文件是完整的 204801 字节。

两个细节:

- 阈值是**严格大于**。正好 50KB / 正好 2000 行**不算**超限,与 `truncate.ts` 的 `totalLines <= maxLines && totalBytes <= maxBytes` 是同一条线,两边必须同解 —— 不同解会出现「标了截断但内容一字未少」或者反过来的怪状。
- `else if` 而不是两条独立 `if`:触发的那一个 chunk 已经整个包含在 `ensureFullOutputFile` 的初始内容里,再 append 一次就是重复一段。

`L388–L393`

```ts
		} catch (error) {
			captureError = toExecutionError(error);
		}
```

**只记不抛。** 这个回调跑在 Node 的 `'data'` 事件上,抛出去等于把异常扔进 `env.exec` 的回调保护网,而那边会判 `callback_error` 并**杀掉进程树**(`env/nodejs.ts` 的 `onStdout` catch)—— 于是「UI 回调里出了个小毛病」升级成「命令被打断」。代价见 §5 第 3 条。

### §9 主流程(L396–L484)

`L400–L416`

```ts
	try {
		const result = await env.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			abortSignal: options?.abortSignal,
			onStdout: onChunk,
			onStderr: onChunk,
		});
		acceptingOutput = false;
```

选项**逐字段转发**而不是 `...options`:`onChunk` / `returnExecutionErrors` 是本文件自己的字段,原样透传下去会被 exec 当成不认识的键;更坏的是将来 `ShellExecOptions` 加了同名字段,行为会悄悄变掉。`onStdout` 与 `onStderr` 指向同一个函数 —— 合流点就是这两行。

`acceptingOutput = false` 要在算快照**之前**:`await` 之后的这一行与后面的代码在同一个微任务里,任何还没派发的 `'data'` 事件都排在它之后。子进程退出后 stdout/stderr 仍可能吐出残余 chunk(孙子进程占着管道时,exec 靠一个空闲计时器强制收尾),这道闸门保证最终快照不会再被改写。

`L417–L433`

```ts
		let progress = createProgress();
		if (progress.truncation.truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);
		// 落盘完成后重算一次,这样 fullOutputPath 才会出现在返回值里。
		progress = createProgress();
```

收尾四步:兜底触发 → 等整条写入链 → 两道失败闸门 → 重算快照。

- **L421 是兜底**,正常路径下 §8 早就触发过了(两处用的是同一组阈值与同一批累计量)。它只在「exec 从未回调 `onChunk` 却又攒出了超限的量」这种不该发生的情形下才生效;而它传的 `tailOutput` **已经被削过**,真走到这里开头是会缺的。
- **到这里才 `await writeChain`**:流式期间一次都不等,写盘延迟完全不影响命令执行与 UI 刷新。
- **旁落写失败 = 整次捕获失败**。看起来狠,但替代方案更坏:返回一个文案里写着 `Full output: undefined` 的成功结果,模型会照着那个路径去 `cat`,然后得到一句「文件不存在」并开始怀疑自己上一步做错了什么。
- **必须重算一次 progress**:`fullOutputPath` 是在链里的 `createTempFile` 落地时才赋值的,第一次算(L417)拿到的仍是 `undefined`。

`L440–L477`:四条返回路径,顺序不能换。

```ts
		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({ ...progress, exitCode: undefined, cancelled: true, truncated: … });
			}
			if (options?.returnExecutionErrors) {
				return ok({ ...progress, exitCode: undefined, cancelled: false, truncated: …, executionError: result.error });
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({ ...progress, exitCode: cancelled ? undefined : result.value.exitCode, cancelled, truncated: … });
```

| # | 条件 | 返回 | 为什么这样 |
|---|---|---|---|
| ① | `code === "aborted"` 或信号已 abort | `ok` + `cancelled: true` | 取消排在最前:超时/回调错误发生时信号往往也已经掐了,而对用户来说「我按了停止」比「它超时了」更接近真相。第二个条件是补网。 |
| ② | 其它执行错误 + `returnExecutionErrors` | `ok` + `executionError` | **让失败也带着已捕获的输出回去**。bash.ts 打开它,于是超时的命令仍然能把超时前打出来的内容给模型看。 |
| ②' | 其它执行错误 + 开关关着 | `err(result.error)` | progress 整个丢掉,见 §5 第 6 条。 |
| ③ | 命令跑完 | `ok` + `exitCode` | 非 0 也是 ok —— 怎么解读由调用方决定。 |

成功路径也要看一眼信号(L469):命令可能刚好在 abort 前一瞬正常退出,那一刻的 `exitCode` 是真的,但对上层来说这一轮已经被放弃了。被杀的进程退出码没有意义(bash 可能回 0、可能回 143),置 `undefined` 让调用方无从解读 —— bash.ts 正是靠 `!== undefined` 决定要不要报「Command exited with code N」。

`L478–L483` 是第 ④ 条:`env.exec` 自己抛或拒时的最外层兜底。接口约定它返回 `Result`,但实现是注入的,不能假设它守约。

## 5. 会咬人的地方

1. **【与注释不符,实测确认】`lastLineBytes` 在「超长行 + 结尾换行」时是 0。**
   `L322–L325` 的 `lastLineBytes` 取的是 `currentLineBytes`,而 `L359–L362` 在 chunk 以换行结尾时把它重置成 0。可 `truncateTail` 的 `lastLinePartial` 判的是「内容的最后一行(不含结尾换行)本身超过字节上限」—— 两者对「最后一行」的定义不一样。
   实测:`python -c "print('a'*60000)"` → `lastLinePartial=true` 而 `lastLineBytes=0`,于是 bash.ts 的 `formatOutput` 印给模型的是 `[Showing last 50.0KB of line 1 (line is 0B). Full output: …]`。不带结尾换行时(`sys.stdout.write('b'*60000)`)是正确的 60000。
   影响面:文案里的一个数字错了,`output` 与 `fullOutputPath` 都是对的。

2. **【与全景篇不符】旁落文件不会缺开头。**
   全景篇 §6「会咬人的地方」写着:「临时全量文件不是从命令第一个字节开始的:写的是**触发那一刻内存里的 tail**……单个 chunk 就超过 100KB 时开头那段永久丢失」。**当前代码里这条不成立。** `L371–L384` 的顺序是「先并进尾巴 → 判超限 → 触发旁落 → **最后才**削尾」,而触发阈值(50KB)只有内存上限(100KB)的一半,所以触发那一刻 `tailOutput` 必然还是从第 0 字节起的完整内容,chunk 多大都一样。
   实测:用假 `ExecutionEnv` 灌一个 200KB 的单 chunk,旁落文件是完整的 204801 字节、以第一个字符开头;真跑 `yes line | head -n 15000` 也拿到完整的 15001 行。
   唯一真会缺开头的是 `L421` 那条兜底路径(它传的 `tailOutput` 已经削过),而那条路在守约的 env 下不可达。

3. **`onChunk` 抛错不会中断命令,而且错误码退化成 `unknown`。**
   `L388–L393` 只记不抛,于是命令会一路跑到自然结束(最坏是 bash 工具那 120 秒的超时),然后整次调用在 `L429` 返回 err。实测 `code = "unknown"`、message 是回调抛的那句。bash.ts 的 `if (!captured.ok) throw new Error(captured.error.message)` 把它变成一次工具失败,**已经捕获到的输出全部丢弃**。

4. **旁落临时文件没有人删。**
   `NodeExecutionEnv.createTempFile`(`env/nodejs.ts:683`)每次先建一个临时目录再在里面放文件,而 `cleanup()` 只 `killProcessTree`,不碰文件系统。于是每一次超限的 bash 调用都在系统临时目录里留下一个 `tmp-<uuid>/bash-<uuid>.log`,靠操作系统回收。这是有意的(模型随时可能回头去 `cat` 它),但长会话在磁盘上是有痕迹的。

5. **`\r` 全删与 ESC 半删,都会改变模型看到的文本。**
   `L347` 删掉全部 `\r`:进度条类命令用回车原地刷新,删掉之后所有中间态在同一行上首尾相接,变成一条很长的怪行。`L138` 的过滤吃掉 ESC(0x1b)但留下后面的 `[31m` —— 彩色输出会以裸的 `[0m` 形式混在文本里。两者都不是 bug,但读输出时要知道它们发生过。

6. **失败路径丢掉全部 details(与全景篇一致)。**
   `L428`(写盘失败)、`L429`(回调错误)、`L465`(未开 `returnExecutionErrors` 的执行错误)三条都只返回一个 `ExecutionError`,`progress` 整个丢掉。「输出被截断了、全量在哪」这条信息在失败路径上**只以文字形式存在**。bash.ts 打开了那个开关,所以生产上主要影响的是**将来新增的其它调用方**。

7. **`catch` 分支不 `await writeChain`。**
   `L478–L482`:`env.exec` 抛出时函数立刻返回 err,而排队中的 append 还在后台写。文件会被写完,但没有人知道它在哪(`fullOutputPath` 不回传),也没有人删。

8. **stdout 与 stderr 合流之后再也分不开。**
   `L411–L412` 把两条流装进同一个回调,这是刻意的(保住先后关系),代价是给模型的文本里没有任何「这一段来自 stderr」的标记。要区分只能在命令里自己加标记。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/agent/src/harness/types.ts` | `ExecutionEnv`(exec / createTempFile / appendFile 的注入接口)、`ExecutionError`、`Result` / `ok` / `err`、`ShellExecOptions`、`toError` |
| 它 import | `packages/agent/src/harness/utils/truncate.ts` | `truncateTail` 与两个上限常量;真正动刀的截断算法在那边,见 [harness_utils_truncate.md](./harness_utils_truncate.md) |
| 运行时依赖(非 import) | `packages/agent/src/harness/env/nodejs.ts` | `NodeExecutionEnv` 是 `ExecutionEnv` 的生产实现:`spawn(bash, ["-c", cmd], {detached})`、`killProcessTree`、回调抛错判 `callback_error`、`createTempFile` 建临时目录 |
| import 它 | `packages/coding-agent/src/core/tools/bash.ts` | **唯一的生产消费者**(:152)。`formatOutput` 把三种截断形态翻成脚注,`BASH_UPDATE_THROTTLE_MS = 100` 节流 `onUpdate` |
| import 它 | `packages/agent/src/index.ts`(:116) | `export *`,于是三个接口 + `sanitizeBinaryOutput` + `executeShellWithCapture` 都是包的公开 API |
| import 它 | `packages/agent/test/harness/nodejs-env.test.ts`(:13) | 5 个用例:超限旁落、短输出不建文件、控制字符过滤、取消、`returnExecutionErrors` |

## 7. 自测题

**1. 把 `maxOutputBytes` 从 `DEFAULT_MAX_BYTES * 2` 改成 `DEFAULT_MAX_BYTES`(即内存尾巴上限 = 给模型的上限),会发生什么?**

<details><summary>答案</summary>

多数情况下模型看到的内容不变,但会多出一种坏情形。`trimToLastUtf8Bytes` 是按**字节**切的,切点大概率落在某一行中间,于是缓冲区的第一行是被拦腰砍断的半行。改成 1 倍之后,`tailOutput` 会被削到恰好 50KB,而 `truncateTail(tailOutput)` 用的也是 50KB —— 它会判定「没超限」并把整个缓冲区原样返回。`createProgress` 里的 `truncated` 来自全程累计量(为真),于是 `output = truncation.content` = 带着那半行的整个缓冲区。**结果就是模型看到的第一行是残缺的,而脚注说的是「Showing lines a-b」,读起来像完整的行。** 留一倍余量之后,`truncateTail` 取的最后 50KB 永远够不到缓冲区开头,那半行必然被丢弃。
</details>

**2. 如果把 `L371–L384` 的顺序改成「先削尾巴、再判超限、再触发旁落」,旁落文件会怎样?**

<details><summary>答案</summary>

开头会缺一块,而且**缺多少取决于 chunk 大小,不可预测**。削尾把 `tailOutput` 压到 100KB 以内,于是 `ensureFullOutputFile` 拿到的不再是从第 0 字节起的完整内容。极端情况:一个 200KB 的单 chunk,削完只剩后 100KB,前 100KB 永久丢失 —— 而脚注仍然理直气壮地说「Full output: /tmp/…」。当前顺序下同样的输入一字不丢(实测 204801 字节)。这也是 §5 第 2 条要更正全景篇的原因:那条描述配得上「先削后判」的写法,配不上现在的代码。
</details>

**3. 调用方在 `onChunk` 里抛了一个异常,命令会被立刻杀掉吗?**

<details><summary>答案</summary>

不会。异常被 `L388` 的 catch 接住存进 `captureError`,命令继续跑到自然结束或超时,然后在 `L429` 以 err 返回(实测 `code: "unknown"`)。这是刻意的取舍:抛回 `env.exec` 会被那边判成 `callback_error` 并 `killProcessTree`,把「UI 回调里出了个小毛病」升级成「命令被打断」。代价是:一条 120 秒的命令会白跑完 120 秒,然后告诉你失败了。
</details>

**4. `returnExecutionErrors` 关掉之后,一条超时的命令给模型留下什么?**

<details><summary>答案</summary>

什么也没有。`L465` 的 `return err(result.error)` 只带一个 `ExecutionError`,`progress`(输出、截断账本、`fullOutputPath`)整个丢掉。开着的时候走 `L456–L464`,输出与脚注都还在,模型能看到超时前打印了什么 —— 对一次卡死的构建来说,那往往是唯一的线索。bash.ts 正是为此把它设成 `true`。
</details>

**5. `createProgress` 为什么要用全程累计量覆盖 `truncateTail` 已经算好的 `totalLines` / `totalBytes`?直接用返回值不行吗?**

<details><summary>答案</summary>

不行,因为 `truncateTail` 只看得见 `tailOutput`,而它早就被削过了。一条打了 15000 行的命令,`tailOutput` 里可能只剩 2000 多行 —— 直接用返回值的话,`totalLines` 会变成「尾巴里有多少行」,bash.ts 算出的脚注就成了「Showing lines 1-2000 of 2000」:既没说清丢了什么,还暗示模型「这就是全部」。覆盖之后 `totalLines = 15000`、`outputLines = 2000`,脚注才是「Showing lines 13001-15000 of 15000」。同一个道理,`truncated` 也必须用累计量判,不能信 `tailTruncation.truncated`(源码 `L297` 的原注释就写着这句)。
</details>
