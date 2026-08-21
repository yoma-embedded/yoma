# packages/agent/src/harness/utils/truncate.ts

> **档位** A(逐行) · **行数** 578(加注释后;原 353) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3 第四组「截断:两个上限、两个方向、三种形态」、§4 阶段 5 第 33 步、§5.2 / §5.3 接线表、§6.1 会咬人的地方 · **索引** [README](../README.md)

## 1. 一句话

把「一段可能很长的文本」按 **行数(默认 2000)+ 字节数(默认 50KB)** 两个互相独立的上限砍成模型看得下的大小,并把「砍了没有、按哪个上限砍的、原本多大、还剩多少」这些事实结构化地报回去 —— 因为**裸截断是「自信地错」**,模型会把半截输出当成全部。

## 2. 它在全景里的位置

先把三个词摊开,后面全靠它们:

- **工具调用(tool call)**:模型在回答里不直接说话,而是输出一段结构化的「我要调 `read`,参数是 `{path: "src/a.ts"}`」。
- **工具结果(tool result)**:内核真的去执行,把执行结果作为一条新消息**塞回对话历史**,再发一次请求让模型接着说。
- **上下文窗口**:每次请求都要把**整段历史**重新发给模型。所以工具结果不是「打印到屏幕上就没了」,它会在之后的**每一轮**都被重新发送、重新计费。

这就是本文件存在的全部理由:一条 `find /` 的输出如果原样进历史,它会在接下来每一轮里都占着几十万 token,而且是在模型看到之前就已经花掉的钱。

对着全景篇 §4 的编号时间线看,它出现在**唯一一处**:**阶段 5 第 33 步「execute」** —— 工具真的跑完、拿到原始输出之后,把结果塞进 `ToolResultMessage` 之前的那一跳。两条支路:

- **read 工具** → `coding-agent/src/core/tools/read.ts:74` 直接调 `truncateHead(selectedContent)`。留**头**,因为读文件时你要看的是开头(import、类型、函数签名)。
- **bash 工具** → 不直接调本文件,而是经 `harness/utils/shell-output.ts` 的 `executeShellWithCapture`,由它内部的 `createProgress()` 调 `truncateTail(tailOutput)`。留**尾**,因为编译错误、测试失败、命令的最终结果都在输出末尾。

**它调谁**:谁也不调。**零 `import`**,只用 `String` / `Number` 的原生方法,连 `node:*` 都不碰(文件头原注释写着「刻意保持浏览器安全」)。它和 `session/uuid.ts` 一样是 `packages/agent` 里的叶子模块。

**谁 import 它**:`shell-output.ts`(同包)、`coding-agent` 的 `read.ts` 与 `bash.ts`(经包根 `@yoma/my-pi` 的 barrel)。另外 `packages/kernel/src/types.ts` 里有一份**结构化复制**的 `TruncationInfo`(取了 6 个字段的子集,因为那份视图模型必须浏览器安全、不能 import 内核),漂移由 `packages/kernel/src/host/details-check.ts` 的 `Assignable<PiRead, ToolDetailsMap["read"]>` 在 typecheck 时兜住 —— **本文件改名或删 `TruncationResult` 的字段,桌面端会直接编译失败**;只加字段不会误报。这就是全景篇 §5.3 那一行接线的实体。

**不存在会怎样**:read 和 bash 失去输出上限。表面上是「上下文爆了」,实际更难受的是它**先花钱后报错** —— 请求带着 40 万 token 发出去,provider 拒收,而这一轮的钱已经算在输入侧了。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–L43 | 原有 12 行头注释(双上限、永不半行、浏览器安全)+ 新增块注释:职责、全景锚点、分节索引 |
| §1 | L44–L111 | 上限常量与 `TruncationResult` / `TruncationOptions` 契约 |
| §2 | L112–L185 | 两把尺子:`utf8ByteLength`(量字节)与 `splitLinesForCounting`(量行) |
| §3 | L186–L217 | `replaceUnpairedSurrogates`:孤立代理项 → U+FFFD |
| §4 | L218–L237 | `formatSize`:给模型看的人话尺寸 |
| §5 | L238–L368 | `truncateHead`:留头,永不半行 |
| §6 | L369–L476 | `truncateTail`:留尾,唯一允许半行 |
| §7 | L477–L554 | `truncateStringToBytesFromEnd`:按字符往回退的字节裁剪 |
| §8 | L555–L578 | `truncateLine`:上游留下的死导出 |

## 4. 逐节讲解

### 读之前:一个必须先建立的直觉

JS 字符串**不是**字节序列,是 **UTF-16 码元序列**。三件事因此成立,而这个文件的一大半复杂度都来自它们:

1. `"中".length === 1`,但它在 UTF-8 里占 **3 字节**。
2. `"🙂".length === 2` —— 它由一对**代理项(surrogate pair)**表示:一个高位(`0xD800–0xDBFF`)+ 一个低位(`0xDC00–0xDFFF`),合起来在 UTF-8 里占 **4 字节**。所以 `"🙂".slice(0, 1)` 会切出**半个 emoji**。
3. JS 字符串允许**孤立代理项**(只有高位没有低位,或者反过来)。UTF-8 编不出这样的码点,`Buffer.from` / `TextEncoder` 遇到它会统一吐出 **U+FFFD**(`EF BF BD`,3 字节)。

于是「保留最后 50KB」这句话,写成 `str.slice(-51200)` 是错的(那是字符不是字节),写成「Buffer 上切 51200 字节再解码」也是错的(会在字符中间切开)。正确做法只有一条,就是 §7。

---

### §1 上限常量与 `TruncationResult` 契约(L44–L111)

`L55–L63`

```ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // grep 单条匹配行的最大字符数
```

**两个上限是并列的、独立的,谁先被撞到谁生效**,不存在「先按行再按字节」这种顺序。50KB 有多大?按内核自己的估算法(`compaction/compaction.ts` 的 `estimateTokens` 是字符数 ÷ 4)折算约 **1.28 万 token**,而压缩留给「最近对话」的预算 `keepRecentTokens` 一共才 **20000**。所以这不是随手写的数:**一次工具结果就能吃掉大半个「最近窗口」**。

`GREP_MAX_LINE_LENGTH` 是**死常量** —— grep 工具在这个 fork 里已经删掉(`packages/kernel/src/types.ts` 的 `RETIRED_TOOL_NAMES` 里明写着 `"grep"`),它和 §8 的 `truncateLine` 全仓无调用点。读到它不要推断「内核有 grep 工具」。

`L69–L101` 的 `TruncationResult` 有 11 个字段,可以按用途分成四组:

| 组 | 字段 | 谁在用 |
|---|---|---|
| 结果本身 | `content` | 直接就是给模型看的文本 |
| 发生了什么 | `truncated` / `truncatedBy` / `lastLinePartial` / `firstLineExceedsLimit` | 调用方选哪一句脚注 |
| 原本多大 / 剩多少 | `totalLines` / `totalBytes` / `outputLines` / `outputBytes` | 脚注里的数字 |
| 用的什么尺 | `maxLines` / `maxBytes` | 调用方不必自己记「这次用的是默认值还是我传的值」 |

注意 **`content` 也在这个对象里** —— 结果与元数据一起走,调用方只接一个值。`bash.ts` 的 `formatOutput` 就是这么消费的:先 `if (truncation.lastLinePartial)`(:72),再 `else if (truncation.truncatedBy === "lines")`,最后兜底 —— **`lastLinePartial` 的优先级高于 `truncatedBy`**,这个顺序在 §5 会再提一次(它正好挡住了一个标签错误)。

`L105–L110` 的 `TruncationOptions` 两个字段全可选,实现里用的是 `??` 而不是 `||`,所以**显式传 `0` 是生效的**(会得到空内容),不会被当成假值悄悄换回默认值。

---

### §2 两把尺子(L112–L185)

双上限各需要一把尺子。两把都刻意手写。

#### `utf8ByteLength`:量字节(L132–L170)

先看原注释里那段来历(L123–L131),它是本文件最重要的一条历史记录:

> 与 pi 的差异:pi 在有 Buffer 的运行时优先走 `Buffer.byteLength`。这里刻意不这么做 —— Bun 1.3 的 `Buffer.byteLength("aa\ud800", "utf8")` 返回 4,而 `Buffer.from` 实际编码出 5 字节(孤立代理项要变成 3 字节的 U+FFFD)。Node 返回 5。

**Bun 的 `Buffer.byteLength` 对孤立代理项少算 1 字节**,而 `Buffer.from` 不少。my-pi 跑在 Bun 上,用它会让 §7 的尾部截断在孤立代理项附近算错边界 —— 算出来 50KB、真写出去 50KB 多。所以整个文件统一走这条自己算的路,顺带的好处是彻底不碰 `Buffer`,保持浏览器安全。这条不是猜测:`test/harness/truncate.test.ts` 的对照组注释里专门写了「注意只用 `Buffer.from`,不用 `Buffer.byteLength`」。

`L134–L140`

```ts
	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
```

全 ASCII 是绝大多数情况(日志、源码、命令输出),这条快路把它变成一次 O(1) 的 `length` 读取,省掉几万次 `charCodeAt`。找到第一个非 ASCII 字符时,**前缀里每个字符恰好 1 字节**,所以累加器直接用下标播种,不必回头再数一遍。

`nonAsciiPattern`(L118)写成模块级常量而不是在函数里现写字面量:正则字面量每次求值都会新建一个 `RegExp` 对象,而这个函数在 bash 流式输出里是**每个 chunk 都要跑**的热路径。

`L145–L167` 是 UTF-8 的分段表:

```ts
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				// 成对代理项 = 一个补充平面字符,占 4 字节。
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
```

四档:U+0000–007F 占 1 字节,U+0080–07FF 占 2,U+0800–FFFF 占 3(中文全在这一档),补充平面占 4。

两个不显然的地方:

- **`i + 1 < content.length` 不能省。** 落在字符串**结尾**的高位代理项没有配对对象,这个条件让它漏到最后那个 `else` 按 3 字节算(= U+FFFD)。少了它会读到 `NaN`,比较全假,同样落到 `else`,结果碰巧一样 —— 但那是运气,不是设计。
- **两处 `bytes += 3` 是两种不同的东西。** 内层那个是「高位代理项后面不是低位」→ 孤立代理项 → U+FFFD;外层那个既覆盖普通 BMP 字符,也覆盖「结尾处的高位代理项」和「任意位置的低位代理项」两种孤立情况。**这一档正是与 `Buffer.byteLength` 分道扬镳的地方。**

#### `splitLinesForCounting`:量行(L174–L184)

```ts
	if (content.length === 0) return [];
	const lines = content.split("\n");
	// 末尾换行不算作额外一行。
	if (content.endsWith("\n")) lines.pop();
	return lines;
```

「一行」的**唯一定义处**。三条规则:

1. **空串是 0 行**,不是「1 行空行」。没有 L177 这条快路的话 `"".split("\n")` 会给出 `[""]`,空输出会被报成 1 行,read 的脚注就会说「显示第 1-1 行,共 1 行」而文件其实是空的。
2. **结尾换行不算一行。** 测试 `does not count a trailing newline as an extra line` 钉住了这条。
3. **只 `pop` 一次,绝不能写成 `while`。** 内容以两个换行结尾(`"a\n\n"`)时,倒数第二个换行确实分出了一个真实的空行,那一行要留着。

顺带记一个口径差,它是 §5 那条「标签说谎」的根:**`totalBytes` 量的是整串(含结尾换行),`totalLines` 不数结尾换行。** 两把尺子对同一个字节的看法不一致。

另外 `\r` 不做任何处理。bash 那条路上游已经净化过(`shell-output.ts` 的 `onChunk` 里有 `.replace(/\r/g, "")`),read 那条路没有 —— 读一个 CRLF 文件时,`\r` 会计进字节预算并留在 `content` 里。

---

### §3 `replaceUnpairedSurrogates`(L186–L217)

只有 §7 会用到它。它把孤立代理项换成 U+FFFD,目的是让**内容**与 §2 已经按 3 字节记好的**账**对齐。

`L192–L215` 的循环结构与 §2 同源:先看高位代理项,只有「后面紧跟一个低位」才是合法的一对(两个码元一起原样保留,游标多推一格);否则落单换 U+FFFD。再单独一条分支处理「低位代理项独自出现」——**合法的一对已经在上一分支被整体吃掉了**,所以走到这里的一定是落单的。

它返回一个新串。**替换之后字节数不会变**:孤立代理项本来就是按 3 字节记的,U+FFFD 也正好 3 字节。这是 §7 敢在最后一步才做替换的前提。

---

### §4 `formatSize`(L218–L237)

`L228–L236`

```ts
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}
```

与截断算法本身无关,纯粹是给脚注排版用的。`read.ts` / `bash.ts` 用它把 `DEFAULT_MAX_BYTES` 印成 `"50.0KB"`、把某一行的大小印成 `"1.3MB"` —— 让模型一眼看懂「为什么被砍了」,而不是去读一串裸数字。

两个要记住的事实:**没有 GB 档**(2 GiB 会印成 `"2048.0MB"`,实测),以及分母用 1024 而单位写作 KB/MB(严格说该是 KiB/MiB)。后者是有意与上游保持一致,别顺手「修正」成 1000 —— 那会让 `read.ts` 的提示语与 `DEFAULT_MAX_BYTES` 对不上。

---

### §5 `truncateHead`:留头,永不半行(L238–L368)

**对外承诺:任何输入都不抛错;`content` 里只可能是完整行;`lastLinePartial` 恒为 `false`。**

#### 开局:算两个总量(L254–L262)

```ts
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
```

`??` 而不是 `||`:`maxLines: 0` 是合法且有意义的取值(「一行都别给」),用 `||` 会把它当成假值悄悄换成 2000。

#### 快路:没超限,整串原样返回(L267)

```ts
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, ... };
	}
```

这里返回的是 **`content` 整串**而不是 `lines.join("\n")`。这个选择是承重的:`join` 会**吃掉结尾换行**,于是「没截断」的输出会与磁盘上的文件差一个字节。

#### 第一道特判:第一行自己就超了(L286–L306)

```ts
	const firstLineBytes = utf8ByteLength(lines[0]!);
	if (firstLineBytes > maxBytes) {
		return { content: "", truncated: true, truncatedBy: "bytes", ..., firstLineExceedsLimit: true, ... };
	}
```

只量第一行、且**不加换行符** —— 这一步问的是「哪怕只给一行,塞得下吗?」塞不下就没有任何**完整行**可返回,而头部路径承诺永不返回半行。

这是 read 工具的 minified-JS 场景:整个文件就一行、几百 KB。返回空内容 + `firstLineExceedsLimit: true`,`read.ts:78` 据此**改口**:

```
[Line 1 is 340.2KB, exceeds 50.0KB limit. Use bash: sed -n '1p' <path> | head -c 51200]
```

把「我读不了」变成「你这样读」。删掉这个分支的话,下面的循环同样会返回空内容,但标志位丢失 —— 模型看到的只是一个空结果,不知道该怎么办。

#### 主循环:收集能塞下的完整行(L309–L333)

```ts
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i]!;
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 是换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}
```

四个点:

- **`truncatedBy` 初值给 `"lines"`。** 循环正常跑满(没被字节上限打断)时,原因一定是行数;只有溢出分支才改成 `"bytes"`。
- **`i < maxLines` 就是行数闸门本身**,所以收进来的行数天然 ≤ `maxLines`,循环体里不必再判一次。
- **`+ (i > 0 ? 1 : 0)` 补的是 `join("\n")` 时会插进去的那个换行符**,第 0 行前面没有分隔符。这样 `outputBytesCount` 与最终 `join` 出来的真实字节数**逐字节相等**。
- **先试算再决定。** 判的是「这一行加进去之后会不会超」,超了就**整行不要**(而不是切一半)—— 这就是「头部永不返回半行」的实现点。

#### 收尾:重贴标签、join、重算(L341–L349)

```ts
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);
```

`join` 只在收集完之后做一次:循环里直接拼字符串在 2000 行量级上是 O(n²)。`finalOutputBytes` 重新量一遍而不是直接用 `outputBytesCount` —— 两者恒等,但这里报的是给调用方看的**事实**,由结果本身量出来更难写错。

**L341 那条重贴标签是本节最值得盯的一行**,它的边界见 §5「会咬人的地方」第 1 条。

---

### §6 `truncateTail`:留尾,唯一允许半行(L369–L476)

与 §5 逐字相同的开局和快路(两个函数刻意没有抽公共子函数,是上游写法;好处是两条路径可以各自演化,代价是改上限语义时必须两边一起改)。三处语义差别:

1. 从**末尾**往回收集,留下的是最后 N 行;
2. **最后一行自己就超上限时允许返回半行** —— 全文件唯一的例外;
3. `firstLineExceedsLimit` 恒为 `false`,那是头部路径才有的概念。

#### 倒着走的主循环(L418–L446)

```ts
	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i]!;
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 是换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边界情况:一行都还没收进来,而这一行就超了上限 —— 取它的尾巴(半行)。
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}
```

- **循环条件用的是「已收集行数 < `maxLines`」而不是下标算术** —— 因为半行分支也会往数组里塞一个元素,用它计数才不会多收一行。
- **分隔符的判据是 `outputLinesArr.length > 0`(已经收过东西)而不是 `i` 的位置** —— 与 §5 对称:分隔符算在「除最后收集的那一行之外」的每一行头上。
- **半行分支只可能在第一次迭代命中**(收过东西就不会再走进来),所以 `line` 一定是原内容的最后一行,整个 `maxBytes` 预算都给它(此刻没有分隔符要预留)。
- **没有这条例外会怎样:** 一条 300KB 的单行日志(比如某个工具把整个 JSON 打成一行)会让 bash 返回**空输出**,而模型看到的是「命令没有输出」—— 最坏的一种错,因为它看起来完全正常。测试 `truncates an oversized single line with a trailing newline` 钉住了这条。
- `unshift` 维护顺序,所以 L459 的 `join` 出来就是原始顺序,**不需要 `reverse`**。

`lastLinePartial` 只有 L439 这一处会置 `true`,是「这段输出的最后一行被切开过」的唯一信号;`bash.ts` 的 `formatOutput`(:72)**第一个**就判它。

---

### §7 `truncateStringToBytesFromEnd`(L477–L554)

§6 那条半行分支唯一的实现依赖,也是本文件里最容易写错的一段。

**契约**:返回 `str` 的一个**后缀**,UTF-8 字节数 ≤ `maxBytes`;放不下任何一个完整字符时返回空串;**永不返回半个字符**。

`L498–L502`

```ts
	let start = str.length;
	let needsReplacement = false;
	for (let i = str.length; i > 0; ) {
```

`start` 是「保留区的起点下标」,初值指向串尾 = 什么都不保留,每成功退一个字符就往左挪。

注意这个 `for` **没有第三段(步进)**:游标由循环体末尾的 `i = characterStart` 推进 —— 因为「退一步」有时是 1 个码元、有时是 2 个(代理对),**步长不是常数**。

`L512–L534` 是分支表。因为**倒着走**,所以先看到的是**低位**代理项,分支顺序与 §2 正好相反:

```ts
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				// 低位代理项前面就是高位代理项,合成一个 4 字节字符。
				characterStart--;
				characterBytes = 4;
			} else { characterBytes = 3; unpairedSurrogate = true; }
		} else if (code >= 0xd800 && code <= 0xdfff) {
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
```

- **`characterStart > 0` 不能省**:串首的低位代理项没有可回看的前驱,它其实就是孤立代理项,要漏到下一个 `else if` 去。
- **`characterStart--`(L518)是「不切开代理对」的实现点**:让这一对代理项作为**一个**字符整体进出预算。少了这一行就会只保留低位代理项,切出来的是半个 emoji。
- 走到第二个分支的代理项**一定是落单的**:合法的一对已在上一分支被整体吃掉。

`L539–L544`

```ts
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		needsReplacement ||= unpairedSurrogate;
```

预算不够就停,而且**整字符不要**。这条 `break` 解释了一个反直觉的测试:

```ts
truncateTail("abc🙂", { maxBytes: 3 })  // → content: ""
```

不是 `"abc"`。因为保留的是**尾巴**,尾巴上那个 4 字节 emoji 放不下,再往前的内容就不属于「最后 3 字节」了。

`L548–L552`

```ts
	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
```

`slice` 而不是逐字符拼:`start` 已经保证落在字符边界上。`needsReplacement` 这个短路是为热路径省的 —— bash 的每个 chunk 都会经 `createProgress` 走一次 `truncateTail`,绝大多数字符串是干净的,不值得白跑一遍 O(n) 扫描。

**这一段的正确性有真闸门**:`test/harness/truncate.test.ts` 用一份**独立的 `Buffer` 实现**做差分对照,穷举 3 层字符表(覆盖 1/2/3/4 字节与各个代理项边界码点)+ 1000 条定种子 fuzz,对每个 `maxBytes` 同时比对「内容一致」和「字节数没超」。

---

### §8 `truncateLine`:上游留下的死导出(L555–L578)

`L568–L578`

```ts
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
```

**全仓没有任何调用点**(只被 `src/index.ts` 的 `export *` 带出包外)。它是给 grep 工具用的,而这个 fork 已经删掉了 grep。留着只为少一处与上游的冲突。

**它的语义与本文件其余部分不同,复用之前必须知道**:量的是 UTF-16 码元而不是字节,`slice` 会**切开代理对**;而且 `maxChars` **不是返回值的长度上界**。两条都见 §5。

## 5. 会咬人的地方

1. **`truncatedBy` 在「只多一个结尾换行」时说谎(L341)。** `truncateHead("a\n", { maxBytes: 1 })` 实测返回 `truncatedBy: "lines"`,而真正的触发者是 bytes:`totalBytes`(2,含结尾换行)超了限,`totalLines`(1,不数结尾换行)没超;所有行都收进来了、`outputBytesCount`(1)也没超,于是 L341 的重贴标签不命中,标签停在初值 `"lines"`。副作用是结果里 `totalLines === outputLines === 1` 却报着 `truncated: true` —— 唯一被砍掉的其实只有那个换行符。根在 §2 两把尺子对结尾换行的口径不一致。

2. **`truncateTail` 在 `maxLines` 恰好等于收进行数时把 `"bytes"` 覆写成 `"lines"`(L454)。** 半行分支也会往数组里塞 1 个元素,所以 `truncateTail("X".repeat(100), { maxBytes: 10, maxLines: 1 })` 实测报 `truncatedBy: "lines"` 而 `lastLinePartial: true`(同样输入换成 `maxLines: 2` 就正确报 `"bytes"`)。生产上撞不到:默认 `maxLines` 是 2000,而且 `bash.ts` 的 `formatOutput`(:72)**先判 `lastLinePartial`**,标签错了也走不到那条分支 —— 这个顺序是不是有意的没有书面记录,但它确实挡住了这个坑。

3. **半行分支可能返回「1 行、0 字节、空内容」(L432–L440)。** `truncateTail("abc🙂", { maxBytes: 3 })` 实测 `content: ""`、`outputBytes: 0`、而 **`outputLines: 1`** —— 因为 `truncateStringToBytesFromEnd` 返回空串,它照样被 `unshift` 进了数组。消费方拿 `outputLines` 去算「显示的是第几行到第几行」时,算出来的是一个不存在的行。

4. **`formatSize` 没有 GB 档(L228–L236)。** 2 GiB 印成 `"2048.0MB"`。bash 旁落的临时全量文件在长时间构建里到这个量级不算离谱。

5. **`truncateLine` 会切开代理对(L577)。** 实测 `truncateLine("🙂".repeat(300), 501).text` 在切口处留下一个**孤立高位代理项**。§2/§7 那一整套「绝不切开字符」的纪律在这个函数里**不成立**。同一行还有第二个坑:`maxChars` 不是返回值的长度上界 —— 后缀 `"... [truncated]"` 有 15 个字符,默认档下返回的是 **515** 个字符。

6. **`truncateLine` 与 `GREP_MAX_LINE_LENGTH` 是死导出**(L63、L568)。与全景篇 §6.1 的记录一致,已复核:全仓无调用点,`packages/kernel/src/types.ts` 的 `RETIRED_TOOL_NAMES` 里写着 `"grep"`。

7. **不要把 `Buffer.byteLength` 换回来(L119–L128 的原注释)。** Bun 1.3 上它对孤立代理项**少算 1 字节**,而 `Buffer.from` 不少;换回去会让 §7 在孤立代理项附近算错边界。顺带,换回去还会打破「本文件浏览器安全」这条约束 —— `packages/agent` 的 `src/index.ts` 是浏览器安全入口,而它 `export *` 了本文件。

8. **`splitLinesForCounting` 不认 `\r\n`(L174–L184)。** bash 那条路上游净化过(`shell-output.ts` 的 `onChunk`),read 那条路没有:读一个 CRLF 文件时 `\r` 会计进字节预算并留在 `content` 里。

9. **【跨文件口径差】`TruncationResult.totalLines` 与 `read.ts` 自己数的 `totalFileLines` 规则不同,而两者出现在同一句脚注里。** `read.ts:54` 用的是裸的 `textContent.split("\n")`,**不 pop 结尾空串**;本文件的 `splitLinesForCounting` 会 pop。于是一个 100 行、以换行结尾的文件,read 的脚注写的是 `of 101`。这是 `read.ts` 侧的口径,不是本文件的行为,但看脚注排查问题时容易归错因。

10. **`createProgress()` 刻意不信 `truncateTail` 的 `truncated`(`shell-output.ts` 的 `createProgress`)。** 那边喂给 `truncateTail` 的 `tailOutput` 早就被裁到 100KB 了,所以「到底截没截断」必须用全程累计量判断,再把 `truncated` / `truncatedBy` / `totalLines` / `totalBytes` 四个字段覆写回去。**这意味着 bash 路径上 `TruncationResult` 的一半字段不是本文件产出的** —— 读 bash 的截断行为时不能只读这个文件。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | *(无)* | 零依赖叶子模块,连 `node:*` 都不碰(浏览器安全) |
| import 它 | `packages/agent/src/harness/utils/shell-output.ts` | 取 `truncateTail` + 两个上限常量 + `TruncationResult` 类型;bash 主链 |
| import 它 | `packages/agent/src/index.ts` | 包根 barrel,`export *` 把全部导出带到 `@yoma/my-pi` |
| import 它 | `packages/coding-agent/src/core/tools/read.ts:12` | `truncateHead` + `formatSize` + 两个上限常量;上限还写进了工具 description(:40) |
| import 它 | `packages/coding-agent/src/core/tools/bash.ts:13` | `formatSize` + `DEFAULT_MAX_BYTES` + `TruncationResult` 类型;`formatOutput` 把三种截断形态翻译成脚注 |
| 结构化复制 | `packages/kernel/src/types.ts:230` `TruncationInfo` | 6 字段子集,浏览器安全侧用;漂移由 `host/details-check.ts` 的 `Assignable` 断言在 typecheck 兜住 |
| 测试 | `packages/agent/test/harness/truncate.test.ts` | 9 个用例,含一份独立 `Buffer` 实现的差分对照 + 定种子 fuzz |
| 同一纪律的另一处实现 | `packages/agent/src/harness/compaction/utils.ts:203–208` | 压缩侧也要「不在代理对中间切开」,注释里明确指向本文件 |
| 同一纪律的另一处实现 | `packages/agent/src/harness/utils/shell-output.ts` `trimToLastUtf8Bytes` | 另一套「保留最后 N 字节」:走 `TextEncoder` + 续接字节回退(`0b10xxxxxx` 是续接字节,往前推到字符起始)。**两份实现同解不同路**,改一处要想想另一处 |

## 7. 自测题

**Q1.** 把 §5 主循环里的 `+ (i > 0 ? 1 : 0)`(L322)整个删掉,会发生什么?

<details><summary>答案</summary>

`outputBytesCount` 从此只累加**行内容**的字节,不算 `join("\n")` 会插进去的分隔符。于是它会**系统性低估**最终输出的大小:收进 N 行就少算 N-1 字节。

后果是 `truncateHead` 返回的 `content` 可以**超过 `maxBytes`**。50KB / 2000 行的默认档下最多超 1999 字节(约 4%),看起来无伤大雅 —— 但这个函数的存在意义就是「给上下文预算一个硬上界」,一个会超的上界等于没有上界。

顺带,L349 的 `finalOutputBytes = utf8ByteLength(outputContent)` **不会**跟着错(它是从结果本身量出来的),所以结果对象会出现 `outputBytes > maxBytes` 这种自相矛盾的状态 —— 这也说明那次「多余的」重算并不多余。

</details>

**Q2.** 有人觉得 §6 里 `if (outputLinesArr.length === 0)` 这个条件是多余的(L432),因为「反正 `break` 就在下一行」,于是把它删掉,让半行裁剪无条件执行。举一个会出错的具体输入。

<details><summary>答案</summary>

`truncateTail("aaa\nbbb\nccc", { maxBytes: 8, maxLines: 10 })`。

正确行为:倒着收,`"ccc"` 花 3 字节,`"bbb"` 花 3+1=4 字节(共 7),再收 `"aaa"` 需要 4 字节 → 7+4=11 > 8,溢出。此时 `outputLinesArr.length === 2`,不进半行分支,直接 `break`,返回 `"bbb\nccc"`。

删掉条件后:溢出时会拿 `line`(此刻是 `"aaa"`)去做 `truncateStringToBytesFromEnd("aaa", 8)`,整串放得下,于是 `unshift("aaa")`、`outputBytesCount = 3`(**覆盖掉**已累计的 7)、`lastLinePartial = true`。结果变成 `"aaa\nbbb\nccc"` —— **整串原样返回,却报着 `truncated: true` 和 `outputBytes: 3`**。字节上界失效,而且报出来的数字全是错的。

关键在于那个 `=` 是**赋值不是累加**,它假定了「此刻一行都没收」。条件和赋值是一对,拆开任何一半都会坏。

</details>

**Q3.** `truncateTail("abc🙂", { maxBytes: 3 })` 返回的 `content` 是空串。为什么不是 `"abc"`?如果我确实想要「尽量给点东西」,该改哪儿?

<details><summary>答案</summary>

因为这个函数保留的是**尾巴**。`truncateStringToBytesFromEnd` 从末尾往回退,第一个字符就是 4 字节的 🙂,`4 > 3` 直接 `break`,`start` 停在 `str.length`,`slice` 出空串。`"abc"` 在 🙂 **前面**,它不属于「最后 3 字节」——给它就是给了错误的位置。

这不是 bug 而是取舍:bash 输出的价值集中在结尾,给出开头的 3 个字符对模型毫无帮助,反而会让它以为「命令只输出了 abc」。

真要改,唯一说得通的做法是**在调用方**加脚注(`bash.ts` 已经这么做了:`[Showing last 0B of line 1 (line is 7B). Full output: …]`),而不是改这个函数去保留头部 —— 那会让 `truncateTail` 的名字变成谎话。

</details>

**Q4.** `utf8ByteLength` 里,把 `} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {` 的第三个条件 `i + 1 < content.length` 删掉,`"a\ud83d"` 的返回值会变吗?

<details><summary>答案</summary>

**不会变,仍然是 4。** 但代码从「按定义正确」退化成「靠运气正确」。

删掉之后,末尾的高位代理项会进入这个分支,`content.charCodeAt(2)` 读越界返回 **`NaN`**;`NaN >= 0xdc00` 和 `NaN <= 0xdfff` 都是 `false`,于是落到内层 `else` 的 `bytes += 3`。而保留条件时它落到外层 `else` 的 `bytes += 3`。两条路结果相同,总数都是 1 + 3 = 4。

之所以还是要写这个条件:它把「结尾处的高位代理项是孤立代理项」这个**判断**写进了代码,而不是让它作为 `NaN` 比较的副产品出现。任何一次「顺手把 `NaN` 比较改成 `?? 0`」之类的重构都会立刻让它变成 `0 >= 0xdc00`——仍然假,但已经没人知道为什么了。

</details>

**Q5.** 假设某天 grep 工具回归,有人直接复用 `truncateLine` 来裁剪匹配行,并且断言「输出行不会超过 500 个字符」。这个断言在什么输入下第一次被打破?

<details><summary>答案</summary>

**任何**触发截断的输入都会打破它 —— 不需要特殊字符。返回值是 `` `${line.slice(0, maxChars)}... [truncated]` ``,后缀本身有 15 个字符,所以只要 `line.length > 500`,返回的就是 **515** 个字符(实测)。`maxChars` 约束的是**保留内容**的长度,不是返回值的长度。

第二个更隐蔽的破绽:`slice(0, 500)` 量的是 UTF-16 码元。如果第 500、501 个码元恰好是一对代理项,`slice` 会把它劈开,返回值里留下一个**孤立高位代理项**(实测 `truncateLine("🙂".repeat(300), 501)`)。这个串再被 `JSON.stringify` 或写进管道时会变成 U+FFFD —— 字节数还会**再涨 1**(孤立代理项按 3 字节编,而它原本只是半个 4 字节字符)。

要拿它去卡字节预算,必须换成 §7 的 `truncateStringToBytesFromEnd` 那套按字符退的写法。

</details>
