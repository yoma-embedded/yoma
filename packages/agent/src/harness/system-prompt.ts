// 对应 pi packages/agent/src/harness/system-prompt.ts,逐字复制。
// 内核只管一件事:把技能列表格式化成系统提示词里的 <available_skills> 区块。
// 完整的系统提示词(身份、工具清单、守则)是应用层的事,
// 见 coding-agent/src/core/system-prompt.ts。
/**
 * 技能(skill)= 磁盘上一份 SKILL.md,正文是"做某一类任务的详细步骤"。
 * 本文件负责技能**两级注入**里的第一级:把技能列表压成一份索引
 * (只有 name / description / location 三样),拼成 `<available_skills>` XML 区块。
 * 第二级是模型自己判断该用哪个,再用 read 工具去读那个 location 拿全文。
 * 这个两级设计是技能能写得很长而不炸上下文窗口的原因。
 *
 * 全景链路上的位置:全景篇 §4「阶段 0:装配」的 **0.6**(建会话时跑一次,不是每轮)。
 * 唯一调用方是 coding-agent 的 `buildSystemPrompt`(core/system-prompt.ts:159),
 * 产物是一段纯字符串,拼进系统提示词后随每一轮请求原样发给模型。
 * 之所以说"一次":两个宿主(ACP 适配器 acp/agent.ts:441、桌面端 kernel host
 * session-manager.ts:540)都把 systemPrompt 当**字符串**传给 AgentHarness,
 * 而 harness 的 createTurnState 对字符串是直接取用、不重算 —— 所以改了技能文件
 * 必须重开会话才生效(全景篇里"资源发现是快照式的"说的就是这件事)。
 *
 * 对应学习文档:docs/learn/agent/harness_system-prompt.md
 *
 * 分节索引:
 *   §1 依赖与契约:只 import 一个类型,零运行时依赖
 *   §2 可见性过滤与空短路:disableModelInvocation 的唯一兑现处
 *   §3 抬头三句:告诉模型"这是索引不是全文",以及相对路径怎么解
 *   §4 逐技能条目:只放三样,刻意不放 content
 *   §5 escapeXml:替换次序与它的适用边界
 */
// ── §1 依赖与契约 ────────────────────────────────────────────────────────
// 只 import 类型不 import 值:编译产物里这一行整个消失,本文件因此零运行时依赖,
// 打进浏览器 bundle 也是安全的(index.ts 的浏览器安全约束由此天然满足)。
// Skill 定义在 harness/types.ts:576,五个字段本文件只读四个 —— content 刻意不读,见 §4。
import type { Skill } from "./types.ts";

/**
 * 把技能列表格式化成系统提示词里的 `<available_skills>` 区块。
 *
 * @param skills 建会话时由 coding-agent 的 `discoverSkills` 发现出来的全部技能
 *   (全局 `~/.my-pi/skills` + 项目 `<cwd>/.agents/skills`,同名时后者覆盖前者)。
 *   顺序按调用方给的原样输出,本函数不排序、不去重。
 * @returns 多行字符串,**结尾不带换行**;没有任何模型可见技能时返回空串 `""`。
 *
 * 不会失败:纯字符串拼接,不碰文件系统、不抛异常,传空数组也是合法输入。
 */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	// ── §2 可见性过滤与空短路 ────────────────────────────────────────────
	// `disableModelInvocation` 的**唯一**兑现处(全仓再无第二处读它做过滤)。
	// 语义是"藏起来但没删掉":技能仍留在 harness 的 resources 里,应用层显式调
	// `harness.skill(name)` 照样能用,只是模型在提示词里看不见它、不会自己去读。
	// 删掉这一行 = 所有标了 disable-model-invocation 的技能直接暴露给模型。
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	// 空短路要在这里做:没有它会拼出一个空的 <available_skills></available_skills>,
	// 等于告诉模型"这套机制在,但一个技能都没有"—— 纯噪声,还占 token。
	// 注意这个 "" 与调用方的门控不是同一件事:buildSystemPrompt 是按**过滤前**的
	// `skills.length > 0` 决定要不要拼(core/system-prompt.ts:158),所以"技能全被隐藏"
	// 时它仍会把这个空串接上去,提示词里因此多两个空行(无害,但确实会出现)。
	if (visibleSkills.length === 0) return "";

	// ── §3 抬头三句 ──────────────────────────────────────────────────────
	// 先收进数组、最后 join,而不是一路 `+=`:换行符只在 join 那一处产生,
	// 不会出现"某个分支多写/少写一个 \n"这种肉眼极难发现的差异。
	const lines = [
		// 第一句交代用途:这些是"专项任务的详细说明",不是背景资料。
		"The following skills provide specialized instructions for specific tasks.",
		// 第二句是两级注入的枢纽:这里只给索引,匹配上了自己去读全文。
		// 少了这句,模型会把一行 description 当成技能的全部内容照做。
		"Read the full skill file when the task matches its description.",
		// 第三句解决一个真实的失败模式:SKILL.md 里写的相对路径(脚本、参考数据)
		// 是相对**技能目录**的,而模型跑工具命令时的 cwd 是项目工程目录,
		// 不明说就会拿工程根去拼,然后报"文件不存在"。
		// 显式调用那条路也专门讲了同一件事(skills.ts 的 formatSkillInvocation 会写
		// "References are relative to <技能目录>"),两条路都交代 = 这坑是真的。
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		// 空串在 join 之后就是一个空行,把抬头文字和下面的 XML 区块隔开。
		"",
		"<available_skills>",
	];

	// ── §4 逐技能条目 ────────────────────────────────────────────────────
	// 遍历的是过滤后的 visibleSkills 而不是入参 skills —— 写错成 skills 就等于
	// §2 那道过滤白做,而且提示词看上去完全正常,不会有任何报错。
	for (const skill of visibleSkills) {
		// 这两级缩进是给模型看的排版(XML 本身不在乎空白),用空格不用 Tab:
		// 它进的是提示词文本,不是源码,仓库的 Tab 规矩管不到这里。
		lines.push("  <skill>");
		// name:模型和应用层查技能用的稳定标识,也是 ACP 那边 `/skill:<name>` 命令的名字。
		// 它照样要转义 —— skills.ts 里对名字的字符校验只出 diagnostics 不拦加载,
		// 所以一个含 `<` 的名字是能一路走到这里的。
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		// description:frontmatter 里**唯一**的硬性字段(skills.ts:479 缺了就整条不收),
		// 因为它就是模型"要不要点开这个技能"的全部判断依据。
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		// location:绝对路径,模型拿它直接喂 read 工具;
		// 它也是抬头第三句里"技能目录"的取材处(取它的 dirname)。
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		// 这里刻意**不**push skill.content:一份 SKILL.md 全文可以是几千 token,
		// 十个技能就能吃掉一大截上下文窗口。两级注入省下的窗口全在这行"没写"上。
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	// join 而不是再补一个 "\n":返回值结尾无换行,接口留给调用方决定怎么拼
	// (buildSystemPrompt 用 `\n\n${...}` 在前面补两个换行)。
	return lines.join("\n");
}

// ── §5 escapeXml ────────────────────────────────────────────────────────
/**
 * 把 XML 元字符转成实体,防止技能的名字 / 描述 / 路径把区块的标签结构撑破
 * —— 描述里出现一个 `</available_skills>` 就足以让模型看到的清单提前结束。
 *
 * @param value 任意用户可控的字符串(技能来自用户自己的文件,内容不受内核约束)。
 * @returns 转义后的字符串;不会失败,纯 replace。
 *
 * 不导出:只服务本文件。全内核**只有这一处**做 XML 转义 —— skills.ts 的
 * `formatSkillInvocation`(`<skill name="…" location="…">`)与 buildSystemPrompt 的
 * `<project_instructions path="…">` 都是裸插值,并不转义。
 */
function escapeXml(value: string): string {
	return value
		// `&` 必须**第一个**换。放到后面的话,前几步产出的 `&lt;` 会被再转一次成
		// `&amp;lt;`,模型看到的就是字面量 "&lt;" 而不是 "<"。转义函数最经典的次序坑,
		// 想加新规则就往下面追加,别插到这一行前面。
		.replace(/&/g, "&amp;")
		// 尖括号是标签边界,这两行是"防撑破"的主力。
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		// 引号对本文件其实用不上(三个字段都是元素内容,没有属性值),
		// 转了也无害;留着是为了这个函数搬去拼属性时依然正确。
		.replace(/"/g, "&quot;")
		// `&apos;` 是 XML 实体,不在 HTML4 的实体表里。这里的产物是给 LLM 读的提示词
		// 而不是网页,所以无所谓 —— 但别把这个函数原样搬去生成 HTML。
		.replace(/'/g, "&apos;");
}
