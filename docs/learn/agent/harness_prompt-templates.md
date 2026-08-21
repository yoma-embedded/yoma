# packages/agent/src/harness/prompt-templates.ts

> **档位** B(分段) · **行数** 105(原始 52,补注释后 105) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §5.2(`agent-harness.ts` `skill()` / `promptFromTemplate()` 一行)、§6.1、§7 · **索引** [README](../README.md)

## 1. 一句话

两个纯函数:`parseCommandArgs` 把一段原始参数字符串按 shell 风格切成 `string[]`,`substituteArgs`(经 `formatPromptTemplateInvocation` 包装)把这个 `string[]` 代入模板正文里的 `$1` / `$ARGUMENTS` / `${@:N}` 等占位符——本质就是 slash command(`/fix a.ts 类型错误`)变成一段普通 user 消息文本的全部机制。

## 2. 它在全景里的位置

先说清楚它**不在**哪里:全景篇 §1 那张「分层图:一句话从用户嘴里到板子上的完整链路」图(①用户输入 → … → ⑫落盘)里没有这个文件的位置,因为它根本不在自动触发的主链路上。它属于 harness 的**显式调用**入口——`AgentHarness` 除了最常用的 `prompt(text)`,还提供 `skill(name)` 和 `promptFromTemplate(name, args)` 两个方法,分别对应"显式调用一个技能"和"显式调用一个提示词模板"(全景篇 §5.2 把这两个方法与 `harness/skills.ts` 的 `formatSkillInvocation` 并列列在同一行接线表里)。`promptFromTemplate()`(`agent-harness.ts:1126-1147`)做的事很直白:按 `name` 在 `turnState.resources.promptTemplates` 里查一个 `PromptTemplate`,查不到就抛 `AgentHarnessError("invalid_argument", "Unknown prompt template: ...")`,查到了就调本文件的 `formatPromptTemplateInvocation(template, args)` 把它格式化成一段文本,再把这段文本当成一次普通 `executeTurn(turnState, text)` 送进循环——**格式化完之后,它和用户直接打字发送的一句话没有任何区别**,不会被模型识别为"这是一次模板调用"。

这里有一个必须先破除的误解:本文件*看起来*应该负责"从磁盘发现/加载模板"(文件名叫 `prompt-templates.ts`),但实际上完全不是——全景篇 §6.1 和 §7 都专门提到:**磁盘加载器(`loadPromptTemplates`)从未实现**,`AgentHarnessResources.promptTemplates` 这个字段全仓没有任何代码给它赋值。直接后果是:`turnState.resources.promptTemplates ?? []` 在生产环境下永远是空数组,`promptFromTemplate()` 的 `find()` 永远找不到任何模板,这个方法在当前形态下**必然抛错**。这不是本文件的 bug——本文件本身(参数解析 + 占位符替换)是完整可用的,缺的是"模板从哪来"这一层应用侧还没接上。类比技能系统:`harness/skills.ts` 有一个完整的 `loadSkills`(递归扫目录、解析 `SKILL.md` frontmatter),而 `prompt-templates.ts` 没有对应的 `loadPromptTemplates`——两个功能在接口设计上是对称的(`AgentHarnessResources` 同时挂了 `skills?` 和 `promptTemplates?`),但只有一半被实现了。

如果这个文件不存在会怎样:`promptFromTemplate()` 这整个方法就没法实现(它直接 import 了 `formatPromptTemplateInvocation`),而"提示词模板"这个概念在 harness 里将完全没有落地——不影响 `prompt()` / `skill()` 等其它入口,因为它们互不依赖。

实际使用方目前只有两处:1) `packages/agent/src/harness/agent-harness.ts:1132` 的 `promptFromTemplate()`;2) `example/06-技能与模板-skill如何变成提示词.ts` 里手工演示了应用层该怎么用——先用 `parseCommandArgs(rawArgs)` 把用户输入的原始参数字符串切开,再把切开的 `args[]` 传给 `formatPromptTemplateInvocation(template, args)`。**注意 `parseCommandArgs` 不被 harness 内部调用**——`promptFromTemplate(name, args)` 的第二个参数直接要求调用方传入已经切好的 `string[]`,`parseCommandArgs` 是留给应用层(比如一个把用户输入的 `/fix "a b.ts" 类型错误` 切成 `name="fix", rawArgs='"a b.ts" 类型错误'` 的 UI 层)自己决定要不要用的工具函数。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L27 | 原始头部注释(4 行)+ 新增的文件职责/位置/分节索引块注释 + `PromptTemplate` 类型引入 |
| §2 | L29–L66 | `parseCommandArgs`:逐字符状态机,把原始字符串切成引号感知的 `string[]` |
| §3 | L68–L96 | `substituteArgs`:四次链式 `.replace()`,五种占位符语法($1 / ${@:N} / ${@:N:L} / $ARGUMENTS / $@) |
| §4 | L98–L105 | `formatPromptTemplateInvocation`:对外唯一入口,`harness` 只依赖它 |

## 4. 逐节讲解

### §2 parseCommandArgs(L29–L66)

```ts
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}
```

这是一个三态状态机:`current`(正在攒的当前 token)、`inQuote`(`null` 表示不在引号里,否则记着是哪个引号字符打开的)。逐字符扫描,四条分支:

1. **在引号内**(`inQuote` 非 null):只有遇到**与打开时相同**的引号字符才闭合(`char === inQuote`),否则字符原样并入 `current`。这意味着单引号字符串里出现双引号(或反过来)不会被特殊对待,当普通字符收进去——`'it"s'` 会得到 token `it"s`。
2. **遇到引号字符**(不在引号内时):打开引号,`inQuote = char`。引号字符本身**不**进 `current`——所以 `a"b c"d` 拼出的是一个 token `ab cd`,引号只是"这一段允许出现空格"的标记,不是要保留的字面量,这与大多数 shell 的行为一致。
3. **遇到空格或 Tab**(不在引号内时):如果 `current` 非空就把它推进 `args` 并清空,`if (current)` 用的是真值判断——所以连续多个分隔符之间不会产生空字符串 token,字符串开头的分隔符也不会产生多余的空 token。
4. **其它字符**:并入 `current`。

循环结束后,如果 `current` 还有内容(最后一个 token 没被空格/Tab 收尾),补推一次。**这里有一个刻意的宽松处理**:如果字符串在引号仍未闭合时就结束了(比如 `'foo` 缺右引号),循环正常跑完,`inQuote` 仍非 `null`,但函数不做任何报错或警告,直接把已经攒下的 `current` 当最后一个 token 吐出去——调用方(用户输入的 slash command 参数)得到的是"尽量猜出来的结果",而不是异常。

**这个实现不支持转义**:没有反斜杠转义机制,`\"` 会被当成反斜杠加双引号两个独立字符处理(反斜杠进 `current`,双引号打开引号)。它比真实 shell 简化得多,够用但不要拿它当 shell 的完整实现来理解。

### §3 substituteArgs(L68–L96)

```ts
export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}
```

四次 `.replace()` **顺序执行**,关键是每一次都在**上一次替换之后的 `result`** 上继续跑,不是对原始 `content` 做一次单趟扫描后合并结果。四条占位符规则:

1. **`$1` / `$2` / … 位置参数**:正则 `\$(\d+)` 里的 `\d+` 是贪婪匹配,所以 `$10` 取的是整数 `10`(对应 `args[9]`),不会像传统 bash 那样被理解成 `$1` 后面跟着字面量字符 `0`——实测 `substituteArgs("$10", [...十个参数])` 返回第十个参数的值。缺失的位置参数(下标越界,比如模板写了 `$3` 但只传了两个参数)代入**空字符串**而不是保留原样的 `"$3"` 文本。
2. **`${@:N}` / `${@:N:L}` 切片**:`N` 是 1-based 起点,`L`(可选)是长度。`start = N - 1` 换算成 0-based;`N <= 0` 时钳到 `0`(等价于 `${@:1}`),这是有意的防御——不这样写的话负下标会穿透进 `Array.slice`,产生"从数组末尾往前数"的意外行为(JS 里 `[1,2,3].slice(-1)` 是 `[3]`)。有 `L` 时截取 `[start, start+L)` 再用空格 `join`,没有 `L` 就一路 slice 到底。
3. **`$ARGUMENTS`**:所有参数用空格连接后整体代入。
4. **`$@`**:与 `$ARGUMENTS` 完全同义,只是另一种拼写,单独用一条正则替换。

**这四步顺序执行会带来一个真实的坑**,不是理论推演——实测验证过:

```
substituteArgs("first=$1 all=$ARGUMENTS", ["$ARGUMENTS-x"])
// => "first=$ARGUMENTS-x-x all=$ARGUMENTS-x"
```

第一步把 `$1` 换成了参数值 `"$ARGUMENTS-x"`,这段文本被拼进 `result` 之后,第三步的 `/\$ARGUMENTS/g` 是在**新的、已经包含这段替换结果的** `result` 上重新扫描的,于是又把刚刚替换进去的那份 `"$ARGUMENTS-x"` 里的 `"$ARGUMENTS"` 子串**当成占位符再替换了一次**,得到 `"$ARGUMENTS-x" + "-x"`。换句话说:**如果某个参数的字面值恰好包含另一个占位符的拼写(`$ARGUMENTS`、`$@`,或形如 `${@:1}` 的子串),它会被"回炉"再替换一次**。这不是一次性模板渲染(单趟扫描原文、一次性把所有占位符都换成最终值),而是四次连续的字符串变换,后一次看不出前一次替换进来的文本是"数据"还是"待处理的语法"。详见 §5。

### §4 formatPromptTemplateInvocation(L98–L105)

```ts
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
```

对外的**唯一**入口——本文件的头部总述明确写了"harness 只依赖 `formatPromptTemplateInvocation`";`agent-harness.ts` 的头部注释没有重复这句话,但代码印证了它:该文件对本模块只有一处 `import`(L73)、只调这一个函数(L1140),`substituteArgs` 与 `parseCommandArgs` 均未被引用。函数体只有一行:取 `template.content`(`PromptTemplate` 接口定义见 `harness/types.ts:598-605`,只有 `name` / `description?` / `content` 三个字段)代入 `substituteArgs`。`args` 缺省为空数组,对应"模板不需要参数,或调用方没传"的情况——此时 `substituteArgs` 里所有 `$N` 都会代入空字符串,`$ARGUMENTS` / `$@` 代入空串,模板里写的占位符全部消失,不会保留原样。

## 5. 会咬人的地方

- **占位符替换是四次链式字符串变换,不是单趟渲染**(L68–L96,详见 §3)。若某个参数值本身包含 `$ARGUMENTS`、`$@` 这类占位符拼写,替换进结果文本后会被后续的 `.replace()` 调用**再次命中**,产生实测能复现的"回炉"替换。这类值通常来自用户输入(比如用户在参数里粘贴了一段包含 `$ARGUMENTS` 字样的代码),攻击面不大,但排查"为什么替换结果比预期多一段"时容易想不到是这个顺序执行导致的。
- **`promptFromTemplate()` 在当前仓库形态下必然抛错**(不在本文件内,但是本文件存在的唯一理由)。全景篇 §6.1/§7 已明确:磁盘加载器 `loadPromptTemplates` 从未实现,`AgentHarnessResources.promptTemplates` 全仓无人填写。这不是本文件的问题(它自己的两个函数逻辑完整、有单测覆盖),而是"模板从哪来"这层应用逻辑还没人接上。读这个文件时不要误以为它本身是半成品——半成品的是它的*调用前提*。
- **`parseCommandArgs` 对未闭合引号静默容错**(L62–L64,详见 §2)。字符串以未闭合引号结束时不报错、不警告,直接把已读内容当最后一个 token。写测试或调试"用户输入的引号好像没生效"时,记得这里不会有任何异常信息可查。
- **不支持转义字符**(§2 结尾)。这是一个简化实现,不要拿它当成熟 shell 词法分析器的替代品。
- **没有发现与已有注释、全景篇或 CLAUDE.md 不符之处**——原有的四行文件头注释("harness 只依赖 formatPromptTemplateInvocation"、"磁盘加载是 M9 的事")与实际代码及全景篇描述完全一致,故本节没有【与注释不符】/【与 CLAUDE.md 不符】条目。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `./types.ts` | 只引入 `PromptTemplate` 这一个类型(定义在 L598–L605) |
| import 它 | `harness/agent-harness.ts` | `promptFromTemplate()`(L1126–L1147)是唯一的生产调用方,只用 `formatPromptTemplateInvocation` |
| import 它 | `packages/agent/src/index.ts` | `export * from "./harness/prompt-templates.ts"`,使两个函数对包外可见 |
| import 它 | `example/06-技能与模板-skill如何变成提示词.ts` | 唯一手工演示了 `parseCommandArgs` 用法的地方 |
| import 它 | `packages/agent/test/harness/resource-formatting.test.ts` | 唯一测试 `formatPromptTemplateInvocation` 的地方(不测 `parseCommandArgs`) |
| 语义对照 | `harness/skills.ts` `formatSkillInvocation` | 同一类"格式化成文本再走 executeTurn"的显式调用入口,`loadSkills` 有完整实现而本文件的 `loadPromptTemplates` 没有 |
| 概念对照 | `harness/types.ts` `PromptTemplate` / `AgentHarnessResources` | 数据形状定义处 |

## 7. 自测题

1. `formatPromptTemplateInvocation({ name: "t", content: "hello $5 world" }, ["a", "b"])` 的返回值是什么?为什么?

<details><summary>答案</summary>

`"hello  world"`(`$5` 与 `world` 之间是两个空格,因为 `$5` 被替换成了空字符串)。`args` 只有两个元素(下标 0、1),`$5` 对应 `args[4]`,越界访问得到 `undefined`,`?? ""` 把它兜成空字符串,而不是保留原样的 `"$5"` 文本。

</details>

2. 如果一个模板内容是 `"参数是:$@"`,而某次调用传入的 `args` 数组本身就是 `["$@"]`(用户输入的参数字面值恰好是两个字符 `$@`),最终替换结果是什么?

<details><summary>答案</summary>

结果是 `"参数是:$@"`(看起来"什么都没变",但过程不是"跳过了替换")。`allArgs = args.join(" ")` 算出来就是字符串 `"$@"`;第三步替换模板里字面的 `$ARGUMENTS`(没有匹配,跳过),第四步替换字面的 `$@` —— 模板里那个真正的占位符 `$@` 被替换成了 `allArgs`(碰巧也是 `"$@"`),替换前后字面相同所以肉眼看不出变化。`String.replace(regex_with_g, fn)` 在**一次调用内部**只扫描原始输入一遍,不会把刚插入的替换文本再拿去和同一个正则比对,所以这一步本身不会无限展开;但因为 `$@` 替换已经是四步里的**最后一步**,没有更晚的 `.replace()` 会再碰它——真正会"回炉"的场景是像 §3 正文举的例子那样,**更早的**替换(如 `$1`)把含有 `$ARGUMENTS`/`$@` 字面量的参数值插入了 `result`,而**更晚**的替换(第三、四步)再扫到它。

</details>

3. `parseCommandArgs('a  b')`(`a` 和 `b` 之间是两个空格)返回的数组长度是多少?

<details><summary>答案</summary>

2,`["a", "b"]`。因为 `if (current)` 用真值判断:第一个空格触发时 `current === "a"`,非空,推入 `args` 并清空;第二个空格触发时 `current === ""`,是假值,`if` 不执行,不会往 `args` 里推一个空字符串。所以连续分隔符不会在结果里产生空 token。

</details>

4. 假设有人打算给 `promptFromTemplate()` 接上真实的磁盘加载(即实现文档 §5 提到的缺失的 `loadPromptTemplates`),这个新函数需要产出什么形状的数据、挂在哪个字段上,`promptFromTemplate()` 内部的查找逻辑要不要跟着改?

<details><summary>答案</summary>

需要产出 `PromptTemplate[]`(`{name, description?, content}` 的数组),赋给 `AgentHarnessResources.promptTemplates` 字段——应用层调用 `harness.setResources({ ...current, promptTemplates: loaded })` 即可。`promptFromTemplate()` 内部的查找逻辑(`(turnState.resources.promptTemplates ?? []).find((c) => c.name === name)`)完全不需要改动,它一直是按这个契约写的,只是过去这个字段永远是 `undefined`/空数组。这也印证了文档 §2 的判断:缺的是"资源怎么来"这一层应用逻辑,不是 harness 或本文件的接口设计。

</details>

5. `substituteArgs` 里 `${@:N}` 分支的正则是 `\$\{@:(\d+)(?::(\d+))?\}`,而位置参数分支的正则是 `\$(\d+)`。为什么 `${@:5:2}` 这样的字符串不会先被 `\$(\d+)` 那条正则错误地部分匹配掉?

<details><summary>答案</summary>

因为 `\$(\d+)` 要求 `$` 后面**紧跟**数字,而 `${@:5:2}` 里 `$` 后面紧跟的字符是 `{`,不是数字,所以第一条正则在 `$` 这个位置根本不会匹配;字符串中间的 `5` 和 `2` 前面没有紧邻的 `$` 字符,同样不会被 `\$(\d+)` 命中。两条正则的匹配起点(`$` 后面的下一个字符)互斥,所以处理顺序(先 `$N` 后 `${@:N}`)不会造成冲突。

</details>
