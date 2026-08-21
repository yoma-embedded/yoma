# packages/agent/src/harness/skills.ts

> **档位** A(逐行) · **行数** 680(加注释后;原始代码 365 行) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 / §3 第四组 / §4 阶段 0 的 0.4 步 / §5.3 / §6.1 · **索引** [README](../README.md)

## 1. 一句话

技能(skill)的一生:从磁盘目录里**发现** `SKILL.md`、解析成 `Skill` 数据,以及把某个技能的全文**格式化**成一段能直接当用户消息发出去的 `<skill>` 文本 —— 「技能」在这套内核里没有任何魔法,它就是一段被格式化后注入对话的提示词文本。

## 2. 它在全景里的位置

先把名词说清楚。**harness**(会话外壳)是 `AgentHarness` 那一层,负责「一次 prompt 从进入内核到产出结果」的全部编排;**技能**是给模型的一份可选说明书,写成一个带 YAML frontmatter 的 markdown 文件(`SKILL.md`);**tool call**(工具调用)是模型要求内核执行某个函数,与技能无关 —— 技能只是文本,不是可执行的东西。

这个文件在链路上出现**两次**,分别对应技能的两级注入。

**第一次是装配期**,对应全景篇 §4「阶段 0:装配」的 **0.4 步**:建会话时,`coding-agent/src/core/resources.ts` 的 `discoverSkills` 先用 `skillDirsOf()` 算出两个目录(`<globalDir>/skills`,默认 `~/.my-pi/skills`;以及 `<cwd>/.agents/skills`,与 pi / Claude Code 共享),再调本文件的 `loadSkills(fs, dirs)` 拿到 `Skill[]`,按名字用一个 Map 去重(**后加载的覆盖先加载的**,于是项目技能压过全局技能),塞进 `AgentHarnessResources.skills`。这一步是**快照式**的:改了技能文件必须重开会话。两个宿主都走这条路 —— `coding-agent/src/acp/agent.ts:425`(Zed / ACP)与 `packages/kernel/src/host/session-manager.ts:490`(桌面端)。

**第二次是每轮拼系统提示词时**,对应全景篇 §4 阶段 0 的 **0.6 步**:`harness/system-prompt.ts` 的 `formatSkillsForSystemPrompt` 把这批 `Skill` 铺成 `<available_skills>` 区块,**只放 name / description / location 三样**,并过滤掉 `disableModelInvocation` 的。技能正文一个字都不进上下文。模型自己判断该用哪个,然后用 `read` 工具去读那条 location —— **这个两级设计是技能可以写得很长而不炸上下文窗口的原因**。

本文件的另一半 `formatSkillInvocation` 服务的是**第二级的另一条路**:宿主(或用户从命令面板)显式点名一个技能,`agent-harness.ts` 的 `skill(name)`(:676)从 `turnState.resources.skills` 里按名字找到它,调 `formatSkillInvocation` 把正文包成 `<skill>` 块,然后交给 `executeTurn` —— 与普通 `prompt()` **完全同一条**路径(全景篇 §4 的第 4 步往后一模一样)。内核里不存在第二套「技能执行器」。

不存在会怎样:`AgentHarnessResources.skills` 恒为空,系统提示词里的 `<available_skills>` 整段消失(`formatSkillsForSystemPrompt` 对空数组返回 `""`),`harness.skill()` 必抛 `Unknown skill`。模型仍然能干活,只是失去「用户为这个项目沉淀下来的做法」这一整层 —— 表现不是报错,而是它每次都从零开始瞎试。

边界纪律(全景篇 §5.3 有专门一行):**内核只给机制**(递归遍历、frontmatter 解析、`.gitignore` 系列 ignore 规则、符号链接解引用),**「从哪些目录找」是应用层策略**,落在 coding-agent 的 `skillDirsOf`。本文件因此不 import `node:path`、不 import `node:fs`,一切文件访问都走注入的 `FileSystem` 接口。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 原始头注释 | L1–L9 | 原作者写的 M9 总述与「未移植 loadSourcedSkills」的记录(未改动) |
| 文件头块注释 | L10–L40 | 本次补的职责 / 全景位置 / 文档路径 / 分节索引 |
| §1 | L41–L103 | 依赖、两个上限常量、三张类型(诊断码 / 诊断 / frontmatter 形状) |
| §2 | L104–L128 | `formatSkillInvocation` —— 第二级注入,把全文包成 `<skill>` 块 |
| §3 | L129–L189 | `loadSkills` —— 唯一的公开入口,多个根目录,缺席即静默跳过 |
| §4 | L190–L315 | `loadSkillsFromDirInternal` —— 递归遍历,SKILL.md 优先且终止本层 |
| §5 | L316–L422 | `addIgnoreRules` + `prefixIgnorePattern` —— ignore 规则的读取与前缀改写 |
| §6 | L423–L502 | `loadSkillFromFile` —— 读文件 → frontmatter → 校验 → Skill |
| §7 | L503–L544 | `validateName` / `validateDescription` —— 宽松警告式校验 |
| §8 | L545–L586 | `parseFrontmatter` —— 手写的 `---` 切分 |
| §9 | L587–L638 | `resolveKind` —— 符号链接显式解一次 |
| §10 | L639–L680 | `dirnameEnvPath` / `relativeEnvPath` —— 纯字符串路径工具 |

## 4. 逐节讲解

### §1 依赖、上限常量与三张类型(L41–L103)

`L45–L52`

```ts
import ignore from "ignore";
import { parse } from "yaml";
import { type FileInfo, type FileSystem, type Result, type Skill, toError } from "./types.ts";
```

只有三个 import,而且**没有一个是 `node:*`**。这是本文件最重要的一条纪律:`FileSystem` 是注入的能力接口(定义在 `harness/types.ts`),它的每个方法都返回 `Result` 且**契约上永不 throw**;技能目录可能挂在一个非本机的 `ExecutionEnv` 上(远程、沙箱),所以路径拼接、目录列举、读文件全部得问它,不能自己 `import node:fs`。全景篇 §6.1 专门留了一条:「`skills.ts` 里的路径工具是**纯字符串**实现,刻意不用 `node:path`……别『顺手优化』成 node:path。」

`ignore` 是 npm 上的 gitignore 规则引擎(本仓钉在 7.0.5)。用它而不是自己写 glob,是因为技能目录常常就住在用户的 git 仓库里:「git 忽略什么、技能发现就忽略什么」必须完全同解,而 gitignore 的优先级 / 否定 / 目录语义自己实现是一个必错的活。

`L57–L62`

```ts
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
```

两个上限**只用来产出警告,不拦加载**(见 §7)。1024 这个数字的含义是「description 是每轮系统提示词里逐条铺开的,这里写用途摘要,别把技能全文塞进来」—— 超了照样加载,只是提醒你上下文窗口在流血。

三个 ignore 文件名**全部生效而且累加**,不是「找到第一个就停」(见 §5 的 `for` 循环:三个都读,规则都 `add` 进同一个匹配器)。`.ignore` / `.fdignore` 是 ripgrep / fd 的约定,收进来是为了让「用 `rg` 看不见的文件,技能发现也看不见」。

`L72–L102`

```ts
export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";
```

诊断码是**稳定字符串**,宿主拿它决定怎么展示,不解析 `message` 文本。`SkillDiagnostic` 的 `type` 字段只有 `"warning"` 一个取值 —— 全文件不产 error,这就是「宽松警告式」的编码体现:技能是用户自己写的文件,报出来是帮人修,不是拦人用。

`SkillFrontmatter` 三个字段全可选、外加一个 `[key: string]: unknown` 索引签名:未知键既不报错也不使用。全可选是因为解析这一步永远不失败,缺字段各自走回退与校验分支。

### §2 formatSkillInvocation:第二级注入(L104–L128)

`L123`

```ts
const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
```

三样东西被塞进这段文本:`name`(模型认得的名字)、`location`(SKILL.md **自己**的路径)、以及紧跟着的一句「References are relative to *X*」—— 这里的 X 是**目录**(`dirnameEnvPath` 的唯一消费者)。为什么要多给一个目录?因为技能正文里写的相对路径(随附脚本、参考数据表)必须按目录解析;只给文件路径的话,模型会把相对路径接在 `SKILL.md` 这个文件名后面,拼出一条不存在的路径。`system-prompt.ts` 里也有一句同义的话在教模型这条规则。

**注意这里没有 XML 转义**,而第一级注入那侧(`system-prompt.ts` 的 `formatSkillsForSystemPrompt`)是逐字段 `escapeXml` 的。两侧不对称:技能名里带一个 `"` 就能把这里拼出来的属性拆掉。实践中撞不上是因为 `validateName`(§7)会警告非法字符 —— 但它只是警告,不拦。

`L126`

```ts
return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
```

追加指令放在 `</skill>` **之后**,不进标签内部。标签里是技能作者写死的守则,标签外是本次调用方的临时要求 —— 分开摆,模型才分得清「规矩」和「这次要干什么」。`test/harness/resource-formatting.test.ts` 把这段拼接的每一个字符都钉死了。

### §3 loadSkills:公开入口(L129–L189)

`L150–L158`

```ts
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await fs.fileInfo(dir);
```

单目录与目录数组统一成数组处理。**数组顺序就是加载顺序**,调用方靠它定义同名技能的覆盖优先级(`discoverSkills` 用 Map 后写覆盖先写),所以这个 `for` 是串行的,不能改成 `Promise.all`。

先 `fileInfo` 一次而不是直接 `listDir`,有两个理由:一是要拿到 `FileInfo.path` —— **绝对且已归一化的地址路径**,后面所有相对路径计算都以它为基准;二是要把「目录不存在」和「存在但读不了」这两种截然不同的情况分开。

`L162–L171`

```ts
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({ ... });
			}
			continue;
```

`not_found` **静默**:`skillDirsOf()` 永远返回两个目录,而其中至少一个通常不存在,报出来全是噪音(`skills.test.ts` 的 "silently skips missing input directories" 用例钉住了「诊断为空数组」)。其余错误(权限、I/O)必须报 —— 那才是「我明明放了技能却看不见」的真原因。

`L176`

```ts
		if ((await resolveKind(fs, rootInfo, diagnostics)) !== "directory") continue;
```

这里必须走 `resolveKind`(§9)而不是直接看 `rootInfo.kind`:`FileSystem.fileInfo` 契约上**不追符号链接**,而把技能目录 symlink 进来(dotfiles 仓库的常见做法)完全合法。解出来不是目录就静默跳过 —— 传一个文件进来不会有任何提示。

`L183`

```ts
		const result = await loadSkillsFromDirInternal(fs, rootInfo.path, true, ignore(), rootInfo.path);
```

三个实参各有讲究:

- `includeRootFiles = true` —— 只有**最外这一层**的散装 `.md` 才算技能(见 §4);
- `ignore()` **每个根目录新建一个** —— 目录 A 的 `.gitignore` 不会污染目录 B;
- `rootDir = rootInfo.path` —— 传的是**地址**路径而不是 canonical 路径。于是 symlink 进来的技能其 `filePath` 保留用户认得的那条链接路径,而不是真身。`skills.test.ts` 的 "loads skills through symlinked directories" 断言 `filePath` 是 `<root>/skills-link/example/SKILL.md`,专门钉住了这一条。

### §4 loadSkillsFromDirInternal:递归遍历(L190–L315)

一层目录固定四步:吃 ignore 规则 → 列目录 → 找 SKILL.md → 否则逐个条目处理。

`L232–L239`

```ts
	await addIgnoreRules(fs, ignoreMatcher, dir, rootDir, diagnostics);

	const entriesResult = await fs.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", ... });
		return { skills, diagnostics };
	}
```

ignore 规则必须在列目录**之前**吃进去,否则本目录的 `.gitignore` 管不住本目录的条目 —— 包括下面要找的那个 `SKILL.md`(是的,SKILL.md 也能被 ignore 掉)。`list_failed` 一定要报:它意味着这一整棵子树都没有被看过,而失败的表现和「这里本来就没有技能」一模一样。

`L247–L269`

```ts
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		...
		const relPath = relativeEnvPath(rootDir, fullPath);
		if (ignoreMatcher.ignores(relPath)) continue;

		const result = await loadSkillFromFile(fs, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}
```

这个 `for` 是**查找**而不是遍历:只有名字恰好是 `SKILL.md` 的条目会被处理,命中并加载后**直接 `return`**,于是这一层的其余条目(包括所有子目录)不再看。语义是「一个目录里有 SKILL.md,这个目录整体就是**一个**技能」—— 技能包内部的 `references/`、`scripts/` 里往往也有 `.md`,那些是这个技能的资料,不是新的技能。

全景篇 §6.1 专门点名过:「那个『找到 SKILL.md 就 `return`』的语句在 for 循环内部,直接结束了**这一层目录的全部遍历** —— 这是有意的,但写法很像提前 break 写错了位置。」

两个 `continue` 分支值得注意:`resolveKind` 判出来不是 file(L252–L253),或者被 ignore 掉(L259),都不 `return` 而是继续循环 —— 循环走完自然落到下面的普通遍历,于是「SKILL.md 被忽略」的目录**退化成一个普通容器目录**,继续往下递归。

`L275–L280`

```ts
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
```

`sort` 是**原地**排序 `entries`,目的是让加载顺序与文件系统返回顺序无关 —— 同名技能的覆盖优先级由调用方按目录顺序定义,那么目录内顺序必须是确定的。跳过隐藏条目与 `node_modules`;隐藏条目里就包含 `.gitignore` 自己,它已经在 `addIgnoreRules` 里被读过了。注意:被**显式传进** `loadSkills` 的根目录本身可以是隐藏的(`.agents/skills`),这条规则只作用于遍历到的子条目。

`L289–L290`

```ts
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;
```

gitignore 的「目录模式」(写作 `dropped/`)只匹配带尾斜杠的路径,所以判定是目录时要补一个 `/` 再去匹配,否则 `.gitignore` 里写 `dropped/` 会拦不住 `dropped` 这个目录。`skills.test.ts` 的 ignore 用例正是这么写的。

`L296–L305`

```ts
		if (kind === "directory") {
			const result = await loadSkillsFromDirInternal(fs, fullPath, false, ignoreMatcher, rootDir);
			...
			continue;
		}

		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
```

递归时 `includeRootFiles` 传 **false** —— 子目录里只认 `SKILL.md`,散装 `.md` 不算技能(`skills.test.ts` 的 "loads direct markdown children only from the root directory" 钉住了这一条)。`ignoreMatcher` 与 `rootDir` 原样传下去,保证整棵树共用一套规则和同一个基准。

最后那行的三个条件缺一不可,少任何一个,技能包内部的资料 `.md` 都会被误收成独立技能。

紧接着的 `loadSkillFromFile(fs, fullPath, dirInfo.name)` 里,第三个实参是**技能根目录**的名字而不是文件名 —— 于是 `skills/root.md` 不写 `name` 时技能名是 `"skills"`。

### §5 ignore 规则(L316–L422)

`L333–L334`

```ts
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";
```

`ignore` 库按「相对 root 的路径」匹配,所以一个子目录里的 `.gitignore` 写 `dropped/`,直接 `add` 进共享匹配器会变成「根下所有 dropped 都忽略」—— 必须补上目录前缀才等价。根目录自己的 `relativeDir` 是 `""`(见 §10),于是 `prefix` 也是 `""`,规则原样生效,正好就是 gitignore 在仓库根的语义。

`L339`

```ts
		const ignorePathResult = await fs.joinPath([dir, filename]);
```

拼路径走 `fs.joinPath` 而不是字符串加斜杠:分隔符是**目标环境**的事,而这个 `fs` 未必是本机。它失败时记的是 `file_info_failed`(实际是 joinPath 失败),而且 `path` 记的是**目录**而不是拼不出来的那个文件名 —— 排查时别被这条诊断的字面意思带偏。

`L367`

```ts
		if (info.value.kind !== "file") continue;
```

这里**不**走 `resolveKind`:指向 `.gitignore` 的符号链接会被当成非 file 直接跳过。与 §4 对目录 / SKILL.md 的处理不一致,是一处已知的不对称。

`L376–L382`(中间隔着两行注释)

```ts
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) ig.add(patterns);
```

按 `/\r?\n/` 切行,顺手吃掉 Windows 的 CRLF —— 留着 `\r` 会让每条模式尾部多一个不可见字符,匹配永远不中,而且看日志完全看不出问题在哪。三个 ignore 文件的规则**累加**进同一个匹配器。

`L402–L420`(`prefixIgnorePattern`)

```ts
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
```

三次改写,每一次都有理由:

1. **否定模式**(`!foo`)要先把 `!` 摘下来,给里面的路径补完前缀,最后再装回去。直接拼成 `prefix + "!foo"` 的话 `!` 跑到了中间,`ignore` 库就不再当它是否定,而是字面量 —— 一条「重新纳入」的规则会静默变成「排除一个叫 `!foo` 的文件」。
2. **锚定模式**(`/foo`,只匹配本目录下的 foo)要先去掉开头的斜杠再补前缀,得到 `sub/foo`;不去掉的话拼出来是 `sub//foo`,双斜杠匹配不中任何东西。
3. `\!foo` 是 gitignore 里「文件名真的叫 `!foo`」的转义写法 —— 这里把反斜杠脱掉了,详见下面「会咬人的地方」第 4 条。

注意判空行 / 注释用的是 `line.trim()`,但真正拿去改写的是**未 trim** 的 `line`。

### §6 loadSkillFromFile(L423–L502)

`L455–L469`

```ts
	const { frontmatter, body } = parsed.value;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	for (const error of validateDescription(description)) { ...push... }

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) { ...push... }
```

逐字段做 `typeof` 收窄:frontmatter 来自用户手写的 YAML,写成 `description: 123` 会解析成数字,不收窄的话会带着一个非字符串进 `Skill`,一路到拼提示词才出问题。

**校验先跑、诊断先记,再决定要不要丢弃** —— 顺序反过来的话,「description is required」这条最有用的警告会跟着技能一起消失,用户就彻底没有线索了。`skills.test.ts` 的 "rejects skills without a description and reports a diagnostic" 断言的正是「skills 为空 **且** 诊断里有那一条」。

`name` 缺席时回退到父目录名。于是目录级技能天然满足「名字 == 目录名」,只有显式写了 `name` 又写错的人才会看到不一致警告。

`L479–L481`

```ts
	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}
```

**全文件唯一的 `return null` 分支。** 为什么硬门槛是 description 而不是 name?name 缺了可以回退到目录名;而 description 是第一级注入里模型唯一能看到的判断依据(`<available_skills>` 只放 name / description / location)。缺了它,这个技能在列表里就是一行没有用途说明的名字,等于永远不会被选中,占位还费 token。全空白同样算缺。

`L497`

```ts
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
```

严格 `=== true`:YAML 里写成 `disable-model-invocation: "true"`(带引号)是字符串,不会命中 —— 宁可当没设置,也不猜用户的意图。这个开关只把技能从**系统提示词的列表**里摘掉(过滤动作在 `system-prompt.ts` 的 `visibleSkills`),宿主仍然可以 `harness.skill(name)` 显式调用它。这就是它存在的意义:**不让模型自己挑,但应用可以点名用**。

### §7 校验:宽松警告式(L503–L544)

两个函数都返回**错误文案数组**而不是布尔或异常。好处有二:调用方把每条包成一个 diagnostic 就完事;一次能把全部问题报齐,不是「修一个再报下一个」。

`validateName` 的五条规则依次是:与父目录同名、长度 ≤ 64、只含 `a-z0-9-`、不以连字符开头或结尾、不含连续连字符。**全部只警告**(`skills.test.ts` 的 "keeps loading invalid-named skills but reports lenient diagnostics" 用 `My-Skill` 验证了「大写名字照样加载」)。

正则 `/^[a-z0-9-]+$/` 顺带拦下空字符串(`+` 要求至少一个字符),也拦下点号 —— 所以「拿文件名当技能名」(`foo.md`)必然会撞这一条。首尾 / 连续连字符要单独查,是因为它们已经被这条正则放行了(`-` 是允许字符)。

`validateDescription`(L533)与 `validateName` 的真正差别不在函数里,而在调用方:`"description is required"` 虽然同样只是一条 warning,但调用方紧接着会 `return null` 把技能整个丢掉;长度超限则是纯警告,照常加载。函数里的 `else if` 是为了让「缺失」与「超长」互斥 —— 缺失时 length 是 0,再报一遍长度更迷惑。

### §8 parseFrontmatter(L545–L586)

`L560–L576`

```ts
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
```

这是**手写**的 frontmatter 切分器,不是 yaml 库自带的功能。四件事:

1. 先把 CRLF 与单独的 CR 全部归一成 LF。下面所有位置计算都假设行尾只有一个字节,少了这一步,Windows 上写的 SKILL.md 会算错围栏位置。
2. **没有开头围栏 = 没有 frontmatter,整个文件当正文,而且不报错。** 于是一个纯 markdown 的 `.md` 会一路走到 §6,因为缺 description 被静默丢弃。
3. 从下标 3 开始找闭合围栏(跳过开头那三个横杠自身),找的是 `"\n---"` 而不是 `"\n---\n"`,所以文件末尾没有换行的闭合围栏也认得。**围栏没闭合时同样不报错**,同样把整个文件当正文,同样落到静默丢弃。
4. 两个魔数 4 都是围栏本身的长度:`slice(4, endIndex)` 的 4 是 `"---\n"`,`slice(endIndex + 4)` 的 4 是 `"\n---"`。正文再 `trim()` 一次,于是 `Skill.content` 不带前后空行(`skills.test.ts` 断言 `content` 恰好是 `"Use this skill."`)。

`L579`

```ts
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
```

`parse("")` 返回 `null`(空 YAML 文档),`?? {}` 兜住 —— 否则 `frontmatter` 是 null,下一步读 `.description` 直接 TypeError,而这个技能文件本身其实完全正常(`---\n---\n正文` 是合法的空 frontmatter)。

`catch` 是唯一的失败路径:YAML 语法错。`toError` 把 yaml 库抛出的任意值归一成 Error,调用方只需要 `.message`。

### §9 resolveKind(L587–L638)

`L605–L608`

```ts
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await fs.canonicalPath(info.path);
```

`FileKind` 一共三个值(`"file" | "directory" | "symlink"`),所以走到第二行时 `info.kind` 一定是 `"symlink"`。`canonicalPath` 是 `FileSystem` 契约里**唯一**会解链的方法,必须显式调它。

**关键在于它只回答「这是什么」,不改路径。** 调用方拿到 kind 之后继续用原来的地址路径往下走 —— 于是 symlink 进来的技能其 `filePath` 是用户认得的那条链接路径,而不是真身路径。这是有意的:模型看到的 location 应该是用户在自己机器上能找到的那条路。

两处失败都对 `not_found` 静默:断链的 symlink 在技能目录里太常见;而 `canonicalPath` 与随后的 `fileInfo` 之间文件可能被删(TOCTOU),报出来也只是噪音,结果都是「这个条目不算数」。

`L636` 的三元把「目标还是 symlink」也落到 `undefined` —— 不做二级解链。实践中 `canonicalPath` 已经把链条走到底了,这只是一句防御性写法。

### §10 路径工具(L639–L680)

两个函数都是**纯字符串**实现,不用 `node:path`。理由在 §1 说过:路径可能来自非本机的 ExecutionEnv。

`L649–L659`(`dirnameEnvPath`)

```ts
	const normalized = path.replace(/[\\/]+$/, "");
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
```

- 先削掉结尾的分隔符,否则 `"a/b/"` 的父目录会被算成 `"a/b"`(它自己)。
- 两种分隔符都找、取靠后的那个:路径可能来自 Windows 侧的环境,也可能混用了两种分隔符。
- **Windows 盘根特判**:`"C:/foo"` 的分隔符下标恰好是 2 且第 1 位是冒号,父目录应该是 `"C:/"` 而不是 `"C:"` —— 后者在 Windows 上表示「C 盘的当前目录」,含义完全不同。
- `<= 0` 覆盖两种情况:压根没有分隔符(-1)与分隔符就在开头(`"/SKILL.md"`)。

`L669–L678`(`relativeEnvPath`)

```ts
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
```

与 `dirnameEnvPath` 的做法不同 —— 这里先把反斜杠**统一成正斜杠**,因为 `ignore` 库只认正斜杠。

`root` 自己返回 `""`,`addIgnoreRules` 正是靠这个空串把根的 `prefix` 算成 `""`。

最后那条兜底分支(path 不在 root 之下)在正常遍历里到不了,它的作用是**不让函数返回一个以 `/` 开头的绝对路径** —— `ignore` 7.x 默认 `allowRelativePaths: false`,`ignores()` 对绝对路径 / `./` / `..` 开头的路径会直接抛 `RangeError`(见 `node_modules/ignore/index.js` 的 `checkPath`),而本文件的契约是永不抛。

## 5. 会咬人的地方

1. **【实测·严重】Windows 上目录级技能一个都发现不了。** 根因不在本文件而在 `packages/agent/src/harness/env/nodejs.ts:88`:`name: path.replace(/\/+$/, "").split("/").pop() ?? path` —— **只按 `/` 切**,而 Windows 上 `FileInfo.path` 是 `C:\...\example\SKILL.md`,于是 `FileInfo.name` 变成**整条路径**。后果传导到本文件的三处:
   - `L248` 的 `if (entry.name !== "SKILL.md") continue;` 永远成立 → **§4 那条 SKILL.md 快路一次都不会命中**,所有目录级技能消失;
   - `L280` 的 `entry.name.startsWith(".") || entry.name === "node_modules"` 永远为 false → 隐藏目录与 `node_modules` **不再被跳过**,照样递归进去;
   - `L305` 的 `entry.name.endsWith(".md")` 靠「整条路径也以 .md 结尾」侥幸还成立,于是根目录散装 `.md` **仍能加载**,但技能名(来自 `dirInfo.name`)变成整条绝对路径,并附送一条 `name contains invalid characters` 警告。

   实测复现(bun on Windows 11):`loadSkills(env, ".agents/skills")` 对一个标准 `example/SKILL.md` 返回 `{ skills: [], diagnostics: [] }` —— **连一条诊断都没有**,完全静默。`packages/agent/test/harness/skills.test.ts` 的 7 个用例在本机挂了 6 个,**在加注释之前就是这样**(已用 `git show HEAD:` 的原始文件复核过,与注释无关)。两个宿主都受影响:`acp/agent.ts:425` 与 `kernel/src/host/session-manager.ts:490`。`jsonl-repo.ts` 里的 `file.name.endsWith(".jsonl")` 因为同样的侥幸没有暴露,所以这个 bug 至今没被别处撞响。

2. **`return` 写在 `for` 内部(L269)。** 它结束的是**整层遍历**而不只是本次循环。这是有意的(SKILL.md 存在 = 这个目录整体是一个技能),但读起来非常像 `break` 放错了地方 —— 全景篇 §6.1 专门为此留了一条。改这一段之前先想清楚:改成 `break` 会让后面那个普通遍历循环接着跑,把技能包内部的子目录当成新技能。

3. **技能「消失」有三条静默路径,合起来是本文件最常见的用户投诉。** ① `L479` 缺 description → 丢弃(**唯一的硬门槛**);② `L563` 文件不以 `---` 开头 → 整个文件当正文 → 落到 ①;③ `L571` 围栏没闭合 → 同样落到 ①。后两条**连诊断都不产**(`parse_failed` 只在 YAML 语法错时才出),所以用户看到的是「我明明放了技能却看不见,而且没有任何报错」。

4. **`\!` 转义在根目录会被翻转成否定规则(L409–L414)。** `\!foo` 在 gitignore 里表示「文件名真的叫 `!foo`」。代码把反斜杠 `slice(1)` 脱掉了:`prefix` 非空时得到 `"sub/!foo"`(`!` 在中间仍是字面量,结果正确);但 `prefix` 为空 —— 也就是**技能根目录自己那份 `.gitignore`** —— 得到 `"!foo"`,`ignore` 库会把它当成**否定规则**(把此前被忽略的 `foo` 重新纳入)。这是本文件里唯一一处会把语义改反的边界,极少撞上。

5. **`prefixIgnorePattern` 判空用 trim 后的文本,改写用未 trim 的原文(L395 vs L402)。** 行首带空格的模式会带着空格进匹配器,基本匹配不中;而且 `pattern.startsWith("!")` 也会因为前导空格失效,否定规则跟着失灵。

6. **`formatSkillInvocation` 不做 XML 转义(L123),`formatSkillsForSystemPrompt` 做(`system-prompt.ts`)。** 同一个 `skill.name` 走两条注入路径,转义规则不一致。技能名里的 `"` 能在这里把属性拆掉;`validateName` 会警告但不拦。

7. **ignore 匹配器跨整棵树共享、只增不减(L183 建、L297 一路传下去)。** 规则靠前缀限定作用域,不靠作用域隔离。副作用是:遍历到一半时匹配器里已经攒了先前所有子目录的规则 —— 语义上正确(它们都带前缀),但如果哪天有人想加「某子树不受父目录 ignore 约束」的功能,这个结构里没有地方挂。

8. **递归没有环检测也没有深度上限(L297)。** 目录符号链接成环时会一路递归下去,最终靠操作系统的 ELOOP / 路径超长让 `listDir` 失败才停,表现是刷出一堆 `list_failed` 诊断。

9. **【与注释不符】`dirnameEnvPath` 的原注释(原始 L350,现 L641)说「Windows 盘根(`"C:/"` 的父目录是它自己)」,但代码不是这样。** `dirnameEnvPath("C:/")`:`normalized` 被削成 `"C:"`,`separatorIndex` = -1,走 `<= 0` 分支返回 `"/"`。特判真正实现的是「**盘根下的文件**的父目录是盘根」(`"C:/foo"` → `"C:/"`)。不可达 —— 传进来的永远是 SKILL.md 的路径 —— 但注释的字面意思是错的。

10. **诊断码 `file_info_failed` 被复用给 `joinPath` 失败(L343–L347),而且 `path` 记的是目录不是文件。** 拿诊断做自动化处理的宿主会被误导。

11. **`.gitignore` 若是符号链接会被跳过(L367 的 `info.value.kind !== "file"`)。** 与 §4 对目录 / SKILL.md 一律过 `resolveKind` 的处理不一致,是一处已知的不对称。

12. **`parseFrontmatter` 找闭合围栏用 `indexOf("\n---", 3)`(L568)。** frontmatter 内部若有一行以 `---` 开头(YAML 的文档分隔符),会被当成闭合围栏提前切断,后面的字段全部进正文 —— 而且不报错。

13. **`ignore` 库默认 `ignoreCase: true`,而 `relativeEnvPath` 的 `startsWith` 是大小写敏感的(L677)。** 两处对大小写的态度相反:模式匹配大小写不敏感,而「path 是否在 root 之下」的判断大小写敏感。root 与 `entry.path` 大小写不一致时(同一个 `FileSystem` 实现正常不会产生这种情况)会掉进兜底分支,拿一条几乎肯定匹配不中的键去问 ignore。

14. **未移植 `loadSourcedSkills`**(原头注释 L5–L6 有记录):上游 pi 有一层「来源标注」的泛型封装,my-pi 没有消费方所以没抄。想加「这个技能来自全局还是项目」这类溯源信息时,先去看上游那份,别自己另起炉灶。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/agent/src/harness/types.ts` | `FileSystem`(注入的能力接口,方法永不 throw)/ `FileInfo` / `Result` / `Skill` / `toError` |
| 它 import | `ignore`(npm 7.0.5) | gitignore 规则引擎;`ignores()` 对绝对路径抛 `RangeError`,默认大小写不敏感 |
| 它 import | `yaml`(npm 2.9.0) | 只解 frontmatter 那一小段,`parse("")` 返回 null |
| import 它 | `packages/agent/src/harness/agent-harness.ts`(:29 / :684) | `formatSkillInvocation`;`harness.skill(name)` 的实现 |
| import 它 | `packages/agent/src/index.ts`(:106) | `export * from "./harness/skills.ts"` —— 包主入口,coding-agent 由此拿到 `loadSkills` / `Skill` / `SkillDiagnostic` |
| import 它 | `packages/coding-agent/src/core/resources.ts`(:12 / :91) | `discoverSkills` = `skillDirsOf()` + `loadSkills()` + 按名字去重;**唯一的生产调用方** |
| import 它 | `packages/agent/test/harness/skills.test.ts` | 7 个用例:发现 / symlink / 缺 description / 根层 .md / 宽松校验 / ignore / 缺席目录 |
| import 它 | `packages/agent/test/harness/resource-formatting.test.ts` | 把 `formatSkillInvocation` 的输出逐字符钉死 |
| 与它配套 | `packages/agent/src/harness/system-prompt.ts` | 第一级注入:`formatSkillsForSystemPrompt` 把 `Skill[]` 铺成 `<available_skills>`,并过滤 `disableModelInvocation` |
| 与它配套 | `packages/agent/src/harness/prompt-templates.ts` | 同一批「资源」里的另一半(prompt template);磁盘加载器**从未实现** |
| 真正的执行者 | `packages/agent/src/harness/env/nodejs.ts` | `NodeExecutionEnv` 是 `FileSystem` 的唯一实现;**上面第 1 条的根因就在它的 :88** |

## 7. 自测题

<details><summary>1. 把 §4 里 L269 那个 <code>return</code> 改成 <code>break</code>,会发生什么?</summary>

这一层的 SKILL.md 照样被收下,但 `break` 只跳出第一个 `for`,代码会继续执行下面那个普通遍历循环。于是这个技能包内部的每一个子目录都会被当成新的容器目录递归进去 —— `references/`、`scripts/` 里若各有一个 `SKILL.md`,都会变成**额外的技能**。语义从「一个目录 = 一个技能」变成「一个目录树里有几个 SKILL.md 就有几个技能」,并且同一个技能包会被拆成好几条塞进系统提示词。
</details>

<details><summary>2. 一个技能目录里的 SKILL.md 写全了 name 和正文,但忘了 description。用户会看到什么?如果他改成把 description 写进文件、却漏掉了闭合的 <code>---</code>,又会看到什么?</summary>

第一种:技能被丢弃(`L479`),但**会**产出一条 `invalid_metadata / "description is required"` 诊断,宿主展示得出来。

第二种:更糟 —— `parseFrontmatter` 在 `L571` 发现没有闭合围栏,于是**成功返回**、frontmatter 为空对象、整个文件(连同那几行 YAML)当正文。接着仍然因为缺 description 被丢弃,诊断里同样只有 `"description is required"`,而真正的原因(围栏没闭合)一个字都没提。两种完全不同的错误给出同一条提示。
</details>

<details><summary>3. 把 §3 里 <code>loadSkillsFromDirInternal(fs, rootInfo.path, true, ignore(), rootInfo.path)</code> 的 <code>ignore()</code> 提到 <code>for</code> 循环外面(整个 loadSkills 共用一个),会有什么后果?</summary>

`<globalDir>/skills` 里那份 `.gitignore` 的规则会带着「相对全局技能目录」的前缀留在匹配器里,然后拿去匹配 `<cwd>/.agents/skills` 下的相对路径。因为两边的前缀体系不同,大多数时候表现为**规则莫名其妙地失效或误伤**:比如全局目录根上写了 `drafts/`(prefix 为空,于是模式就是 `drafts/`),它会连项目技能目录下的 `drafts/` 一起忽略掉。而且匹配器只增不减,后加载的目录永远背着前面所有目录的规则,顺序一变行为就变。
</details>

<details><summary>4. 为什么 <code>formatSkillInvocation</code> 里要用 <code>dirnameEnvPath(skill.filePath)</code> 再输出一句「References are relative to X」,直接把 <code>location</code> 给模型不够吗?</summary>

不够。`location` 是 `SKILL.md` **文件**的路径。技能正文里写「跑 `scripts/probe.py`」时,模型如果拿 location 当基准,会拼出 `.../example/SKILL.md/scripts/probe.py` 这种不存在的路径。相对引用的基准必须是**目录**,所以要单独算一次 dirname 并明说。这也是 `dirnameEnvPath` 在全文件里唯一的消费点 —— 删掉这句话,受影响的不是加载,而是模型在技能里用相对路径时的成功率。
</details>

<details><summary>5. 把 <code>validateName</code> 里「名字与父目录不一致」这条从 warning 提升成「拒载」,会打断哪些既有用法?</summary>

至少两类。① **根目录的散装 `.md` 单文件技能**:它们的默认 name 就是技能根目录名,一旦作者显式写了 `name: my-thing`,立刻与目录名 `skills` 不一致 —— 而这正是单文件技能最自然的写法。② **风格不同但合法的技能包**:`skills.test.ts` 的 `My-Skill` 用例明确断言「大写名字只警告不拦载」,提升成拒载会直接让这个用例挂掉。更一般地说,这违反了本文件的整体设计:技能是用户自己的文件,校验的目的是帮人修而不是拦人用;唯一值得拦的是「拦了对模型更好」的那一条 —— 缺 description。
</details>
