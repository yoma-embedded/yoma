# packages/agent/src/harness/system-prompt.ts

> **档位** A(逐行) · **行数** 134(加注释后;原始代码 38 行) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §3「第四组:技能(skill)的两级注入」/ §4 阶段 0 第 0.6 步 / §5.3 · **索引** [README](../README.md)

## 1. 一句话

把一组已经发现好的**技能**(skill,磁盘上的一份 `SKILL.md`)压成一份只有「名字 / 描述 / 路径」的索引,拼成系统提示词里的 `<available_skills>` XML 区块 —— 让模型知道有哪些技能可用,但**不把技能全文塞进上下文**。

## 2. 它在全景里的位置

先解释三个词。**系统提示词**(system prompt)是每次向大模型发请求时放在最前面的一段固定文本,交代身份、可用工具、行为守则;**技能**(skill)是用户自己写在磁盘上的一份 `SKILL.md`,正文是「做某一类任务的详细步骤」(例如「OpenOCD 烧录失败怎么排查」);**harness** 是内核里把 agent 循环、会话树、上下文管理包在一起的那层外壳(`AgentHarness`)。

这个文件坐在全景篇 §4「**阶段 0:装配**」的第 **0.6** 步 —— 也就是建会话时跑一次、不是每轮跑一次的那一段。调用链是:`coding-agent/src/core/system-prompt.ts:buildSystemPrompt` 拼系统提示词,拼到「技能区块」那一段时(`:158–:159`)调本文件的 `formatSkillsForSystemPrompt(skills)`,把返回的字符串接在 `<project_context>` 之后、`Current working directory:` 之前。它的入参来自第 0.4 步:`coding-agent/src/core/resources.ts:discoverSkills` → `agent/src/harness/skills.ts:loadSkills` 扫两个目录(全局 `~/.my-pi/skills` 与项目 `<cwd>/.agents/skills`)读出来的 `Skill[]`。

它自己不调任何东西 —— 除了同文件里的私有 `escapeXml`,全文零依赖、零 I/O。

**为什么说「一次而不是每轮」**:两个宿主(ACP 适配器 `coding-agent/src/acp/agent.ts:441`、桌面端 `packages/kernel/src/host/session-manager.ts:540`)都是把 `buildSystemPrompt(...)` 的**结果字符串**传进 `new AgentHarness({ systemPrompt })`;harness 每轮冻结 turn 快照时(全景篇 §4 步骤 3)对字符串是直接取用,只有传函数时才会重算。所以本函数在一个会话的生命周期里**只跑一次**,每轮出现在请求里的是它当时的产物。这就是「改了技能文件必须重开会话」的机制原因。

**不存在会怎样**:模型完全不知道有技能这回事 —— 技能文件躺在磁盘上没人读,`harness.skill(name)` 这条显式调用路径(第二级注入)还能用,但「模型自己判断该用哪个技能」这一半彻底消失。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 原始头注释 | L1–L4 | 原作者写的四行(**未改动**):对齐上游 pi、职责边界在哪 |
| 文件头总述 | L5–L28 | 本次补的块注释:两级注入是什么、全景 0.6、文档路径、分节索引 |
| §1 依赖与契约 | L29–L33 | 唯一一条 `import type`,零运行时依赖 |
| 导出符号 JSDoc + 签名 | L35–L45 | `formatSkillsForSystemPrompt` 的入参 / 返回 / 失败语义 |
| §2 可见性过滤与空短路 | L46–L57 | `disableModelInvocation` 过滤;无可见技能时返回 `""` |
| §3 抬头三句 | L59–L77 | `lines` 数组:三句英文说明 + 空行 + `<available_skills>` 开标签 |
| §4 逐技能条目 | L79–L105 | for 循环拼 name / description / location,闭标签,`join("\n")` 返回 |
| §5 escapeXml | L107–L134 | 五次 `replace` 的次序、为什么 `&` 必须打头、适用边界 |

## 4. 逐节讲解

### §1 依赖与契约(L29–L33)

`L33`

```ts
import type { Skill } from "./types.ts";
```

整个文件只有这一条 import,而且是 `import type` —— TypeScript 编译时整行擦除,产物里一条 import 都不剩。这是本文件能被安全打进浏览器 bundle 的原因(`packages/agent/src/index.ts` 的浏览器安全约束由此天然满足,见 [agent/index.md](./index.md))。

`Skill` 定义在 `harness/types.ts:576–591`,五个字段:

```ts
name: string                      // 稳定标识,查找与模型可见清单都用它
description: string               // 短描述,告诉模型「什么时候用」
content: string                   // SKILL.md 正文全文
filePath: string                  // 绝对路径
disableModelInvocation?: boolean  // 从模型可见清单里排除,但仍允许应用显式调用
```

本文件读四个,**唯独不读 `content`** —— 这一条「没读」就是两级注入的全部价值所在,见 §4。

### §2 可见性过滤与空短路(L46–L57)

`L51`

```ts
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
```

`disableModelInvocation` 来自 `SKILL.md` frontmatter 里的 `disable-model-invocation: true`(解析处 `harness/skills.ts:497`)。全仓**只有这一行**读它做过滤 —— 它的语义是「藏起来但没删掉」:技能仍然留在 `AgentHarnessResources.skills` 里,应用层显式调 `harness.skill(name)`(ACP 那边的 `/skill:<name>` 命令)照样能把全文发出去,只是模型在提示词里看不见它、不会自己主动去读。删掉这一行,所有标了这个字段的技能立刻对模型可见。

`L57`

```ts
	if (visibleSkills.length === 0) return "";
```

没有它就会拼出一个空壳:

```
The following skills provide specialized instructions for specific tasks.
...
<available_skills>
</available_skills>
```

这等于告诉模型「这套机制在,但一个技能都没有」—— 纯噪声,还白占 token。

**注意这个 `""` 和调用方的门控不是同一层。** `buildSystemPrompt` 是按**过滤前**的数量判断要不要拼(`coding-agent/src/core/system-prompt.ts:158`):

```ts
	if (tools.includes("read") && skills.length > 0) {
		prompt += `\n\n${formatSkillsForSystemPrompt(skills)}`;
	}
```

所以「传进来的技能全部标了 `disableModelInvocation`」这一种情况下,调用方看到 `skills.length > 0` 判 true 照样拼,本函数返回 `""`,结果是提示词里凭空多出两个空行。无害,但确实会出现 —— 详见 §5。

### §3 抬头三句(L59–L77)

`L62–L77`

```ts
	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
```

先说**为什么用数组**:一路 `+=` 拼字符串时,换行符散落在每一处拼接点,很容易出现「某个分支多写了 / 少写了一个 `\n`」这种肉眼极难发现的差异;收进数组、最后 `join("\n")` 一次,换行符只在一处产生。

三句话各自解决一件事:

1. **第一句**交代这些东西是什么 —— 「专项任务的详细说明」,不是背景资料。
2. **第二句是两级注入的枢纽**。少了它,模型会把那一行 `description` 当成技能的全部内容直接照做,而不是意识到「这只是索引,匹配上了要去读 `location` 拿全文」。技能能写到几千 token 而不炸窗口,全靠模型愿意在需要时才去读。
3. **第三句**解决路径解析:`SKILL.md` 正文里写的相对路径(附带的脚本、参考数据)是相对**技能目录**的,而模型跑工具命令时的工作目录是项目工程目录 —— 不明说就会拿工程根去拼,然后报「文件不存在」。这不是臆测:第二级注入那条路(`harness/skills.ts:116` 的 `formatSkillInvocation`)也专门写了一句同义的 `References are relative to <技能目录>.`,两条路都特意交代同一件事。

数组第四个元素是空串,`join` 之后就是一个空行,把抬头文字与下面的 XML 区块隔开。

### §4 逐技能条目(L79–L105)

`L82–L99`

```ts
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
```

遍历的是 `visibleSkills` 而不是入参 `skills` —— 写错成后者,§2 那道过滤就白做了,而且**提示词看上去完全正常、不会有任何报错**,只是私密技能悄悄暴露。

三个子元素:

- **`name`**:模型和应用层查技能用的稳定标识,也是 ACP 那边 `/skill:<name>` 命令的名字。它照样过 `escapeXml`,这不是多余的 —— `skills.ts` 的 `validateName` 对名字的字符校验**只出 diagnostics、不拦加载**(技能是用户自己的文件,报错要帮人修不是拦人用),所以一个含 `<` 的名字完全能一路走到这里。
- **`description`**:frontmatter 里**唯一**的硬性字段(`skills.ts:479` 缺了就整条技能不收),因为它就是模型「要不要点开这个技能」的全部判断依据。
- **`location`**:绝对路径,模型拿它直接喂 read 工具;它也是抬头第三句里「技能目录」的取材处(取它的 dirname)。

`  <skill>` 那两级缩进是给模型看的排版(XML 本身不在乎空白),而且用的是**空格不是 Tab** —— 它进的是提示词文本,不是源码,仓库「用 Tab 不用空格」的规矩管不到这里。

**这个循环里最重要的是没写的那一行:`skill.content` 从不进清单。** 一份 `SKILL.md` 全文可以是几千 token,十个技能就能吃掉一大截上下文窗口;两级注入省下的窗口,全部来自这里「只放三样」。

`L101–L105`

```ts
	lines.push("</available_skills>");
	return lines.join("\n");
}
```

`join` 而不是再补一个尾随 `"\n"`:返回值**结尾不带换行**,怎么接由调用方决定(`buildSystemPrompt` 用 `` `\n\n${...}` `` 在前面补两个换行)。

一份产物长这样(名字与描述取自 `coding-agent/test/acp-agent.test.ts:445` 那个技能夹具;`<location>` 只是示意 —— 那条测试里的技能实际落在临时工程的 `.agents/skills/flash-triage/SKILL.md`):

```
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>flash-triage</name>
    <description>Diagnose OpenOCD flash failures</description>
    <location>/home/u/.my-pi/skills/flash-triage/SKILL.md</location>
  </skill>
</available_skills>
```

### §5 escapeXml(L107–L134)

`L119–L134`

```ts
function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
```

存在的理由:技能的名字 / 描述 / 路径全部是**用户可控**的(用户自己写的 `SKILL.md`),而它们被直接插进 XML 标签之间。描述里出现一个 `</available_skills>`,模型看到的清单就在那里提前结束了 —— 后面的技能全部失踪,而且没有任何报错。

**`&` 必须第一个换**,这是转义函数最经典的次序坑:如果放到后面,前几步刚产出的 `&lt;` 会被再转一次成 `&amp;lt;`,模型看到的就是字面量 `&lt;` 而不是 `<`。想加新的替换规则就往下面追加,别插到这一行前面。

后面三条:`<` `>` 是标签边界,是「防撑破」的主力;`"` 和 `'` 对本文件其实用不上(三个字段都是元素内容,没有属性值),转了也无害,留着是为了这个函数搬去拼属性时依然正确。顺带一句:`&apos;` 是 XML 实体,**不在 HTML4 的实体表里** —— 这里的产物是给 LLM 读的提示词而不是网页,所以无所谓,但别把这个函数原样搬去生成 HTML。

## 5. 会咬人的地方

- **【调用方门控 1:read 工具】** 技能区块在 `coding-agent/src/core/system-prompt.ts:158` 被 `tools.includes("read")` 门控 —— 装配时没给 read 工具,整段技能清单**静默消失**,而本文件完全无辜。门控本身是合理的(`<location>` 给的路径只有 read 工具能读),但排查「我的技能怎么不见了」时要记得往调用方看。全景篇 §6.3 已记这一条。
- **【调用方门控 2:数量按过滤前算】** 同一行的 `skills.length > 0` 用的是**过滤前**的数组。当传进来的技能**全部**标了 `disableModelInvocation` 时,调用方判 true 照样拼,而本文件 L57 返回 `""` —— 结果是技能区块该在的位置(有上下文文件时即 `</project_context>` 与 `Current working directory:` 之间)多出两个换行。无害,但这是两处门控不同层带来的真实行为,而且**没有测试覆盖**(`coding-agent/test/system-prompt.test.ts:173` 那条只测了「部分隐藏」)。
- **【转义的不对称】** L119 的 `escapeXml` 是**整个内核唯一**的 XML 转义点(`grep -rn "escapeXml" packages/` 只有本文件有实现,其余命中都是别处注释里的引用;`packages/ai/src/utils/oauth/oauth-page.ts` 另有一个 `escapeHtml`,那是 OAuth 回调网页用的,不在提示词这条路上,而且它的单引号转成 `&#39;` 而不是 `&apos;`)。第二级注入那条路 —— `harness/skills.ts:123` 的 `` `<skill name="${skill.name}" location="${skill.filePath}">` `` —— 是**裸插值**,而且插的是**属性值**;`buildSystemPrompt` 的 `<project_instructions path="${filePath}">` 同样裸插。也就是说:一个技能名里的 `"` 在本文件这条路上是安全的,在显式调用那条路上会把属性撑破。这个不对称目前没有任何测试或断言钉住。
- **【与全景篇措辞的细微出入】** 全景篇 §3 第四组写的是「**每轮**系统提示词里 `formatSkillsForSystemPrompt` 只放 name / description / location 三样」,字面读起来像每轮调用一次。以代码为准:两个宿主传给 `AgentHarness` 的 `systemPrompt` 都是**字符串**(`acp/agent.ts:441`、`kernel/src/host/session-manager.ts:540`),harness 的 `createTurnState` 对字符串直接取用不重算,所以本函数在一个会话里**只跑一次**(装配期 0.6),每轮出现在请求里的是它的产物。结论不冲突(全景篇同段末尾也写了「快照式,改了技能文件要重开会话」),但把「每轮」当成「每轮调用」会推错「热重载为什么不生效」的原因。
- **【零直接测试】** `packages/agent/test/` 下**没有**任何针对本文件的测试(`grep -rln "system-prompt" packages/agent/test` 为空)。唯一覆盖来自下游:`coding-agent/test/system-prompt.test.ts:143–183`(三条:列出 / read 门控 / 隐藏)与 `acp-agent.test.ts:464`(端到端确认 `<available_skills>` 真的上了电线)。**`escapeXml` 的五条替换一条都没有测试** —— 改它的次序不会有任何东西变红。
- **【顺序与去重不归它管】** L82 的循环原样输出调用方给的顺序,本文件不排序、不去重。「同名技能后加载覆盖先加载(项目压过全局)」是 `coding-agent/src/core/resources.ts` 的策略,别在这里补第二份。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/agent/src/harness/types.ts` | `Skill` 接口(:576–591);仅类型导入,编译后消失 |
| import 它(唯一生产调用方) | `packages/coding-agent/src/core/system-prompt.ts` | `:158–:159` 把返回值拼进完整系统提示词;coding-agent 刻意不维护分叉版(全景篇 §5.3) |
| 它的数据来源 | `packages/agent/src/harness/skills.ts` | `loadSkills` 发现并解析 `SKILL.md`;`formatSkillInvocation`(:116)是第二级注入 |
| 它的数据来源(策略层) | `packages/coding-agent/src/core/resources.ts` | `skillDirsOf` / `discoverSkills` 决定扫哪两个目录、怎么去重 |
| 转发它的导出 | `packages/agent/src/index.ts` | `export * from "./harness/system-prompt.ts"`,`@yoma/my-pi` 主入口 |
| 间接消费者(宿主 1) | `packages/coding-agent/src/acp/agent.ts` | `:441` `buildSystemPrompt({ ..., skills })` 装配 harness |
| 间接消费者(宿主 2) | `packages/kernel/src/host/session-manager.ts` | `:540` 同上,走 `@yoma/my-pi-coding-agent/system-prompt` 深引用(该路径只靠打包别名可达) |
| 覆盖它的测试 | `packages/coding-agent/test/system-prompt.test.ts` | `:143–183` 三条;`acp-agent.test.ts:464` 端到端 |

## 7. 自测题

<details>
<summary>1. 把 L82 的 <code>for (const skill of visibleSkills)</code> 改成 <code>for (const skill of skills)</code>,会发生什么?什么时候能发现?</summary>

所有标了 `disable-model-invocation: true` 的技能会重新出现在模型可见清单里。**不会有任何报错**:提示词结构完全合法、格式完全正常,`buildSystemPrompt` 的其他行为一点不变。发现它的唯一途径是 `coding-agent/test/system-prompt.test.ts:173` 那条「hides disableModelInvocation skills from the listing」测试 —— 它断言 `prompt` 里不含 `<name>secret</name>`。换句话说,这行的正确性完全靠下游包的一条测试兜着,`packages/agent` 自己没有守卫。
</details>

<details>
<summary>2. 如果把 L124 的 <code>.replace(/&/g, "&amp;")</code> 挪到链条最后一条,一个名叫 <code>a&lt;b</code> 的技能在提示词里会长什么样?</summary>

会变成 `a&amp;lt;b`,模型读到的是字面量 `&lt;` 而不是 `<`。原因:先跑 `<` → `&lt;` 那条,链条末尾的 `&` 替换会把刚生成的实体里的 `&` 再转一次成 `&amp;`,于是 `&lt;` 变成 `&amp;lt;`。这是所有转义函数的通用次序规则 —— **`&` 必须最先换**,因为它是所有实体的引导字符。附带一提:仓库里没有任何测试会因为这个改动变红。
</details>

<details>
<summary>3. 用户在 <code>~/.my-pi/skills/</code> 下新建了一个技能,同时桌面端有一个会话正开着。他能在这个会话里用上新技能吗?为什么?</summary>

不能,必须重开会话。技能是**建会话时读一次的快照**:`discoverSkills` 在装配阶段(全景篇 §4 第 0.4 步)扫目录,`buildSystemPrompt` 在 0.6 步调本函数把结果**固化成一个字符串**,再传给 `new AgentHarness({ systemPrompt })`。harness 每轮冻结 turn 快照时对字符串是直接取用、不重算(只有 `systemPrompt` 传成函数时才会每轮回调),所以本函数在一个会话里只跑一次。注意区分两条路:模型主动用技能这条路(第一级索引)确实要重开会话;而应用层显式 `harness.skill(name)` 走的是 `resources.skills`,那份数组同样是建会话时的快照,一样看不到新文件。
</details>

<details>
<summary>4. 假设某次装配时 <code>selectedTools</code> 只有 <code>["bash"]</code>,技能一个都不缺。模型会看到 <code>&lt;available_skills&gt;</code> 吗?这个行为该算 bug 吗?</summary>

看不到。`coding-agent/src/core/system-prompt.ts:158` 的门控是 `tools.includes("read") && skills.length > 0`,没有 read 工具时整段技能区块不拼。这**不是 bug**:清单里给模型的是 `<location>` 绝对路径,期待它「自己去读全文」,而读文件的能力就是 read 工具 —— 没有 read 的情况下把清单列出来,等于给一堆它打不开的路径。全景篇 §6.3 把这条记成了「传空 `selectedTools` 时整段技能清单消失」的注意事项,而不是缺陷。
</details>

<details>
<summary>5. 有人想「优化」这个函数,把 <code>skill.content</code> 也一起放进 <code>&lt;skill&gt;</code> 块,理由是「省得模型再调一次 read」。这个改动的代价是什么?</summary>

代价是上下文窗口和每一轮的成本。技能全文可以是几千 token,而系统提示词是**每一轮请求都要重发**的(harness 每轮把同一份 systemPrompt 放进请求头部)。十个技能 = 每轮固定多烧几万 token,而其中绝大多数与当前任务无关。两级注入的全部收益就在「第一级只给索引」这一点上:列表的成本 ≈ 每个技能两三行,全文的成本只在模型真的判断需要时才付一次。附带的第二笔代价:系统提示词是 prompt cache 的公共前缀,把易变的技能正文塞进去会让缓存更容易失效。
</details>
