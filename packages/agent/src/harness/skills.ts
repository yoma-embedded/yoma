// M9:技能 = "被格式化后注入对话的提示词文本",本文件管它的一生:
//   发现(loadSkills:目录递归 + frontmatter 解析 + ignore 规则)
//   → 注入(system-prompt.ts 的 formatSkillsForSystemPrompt,只放 name/description)
//   → 调用(formatSkillInvocation:把 SKILL.md 全文包上 <skill> 标签)。
// 对齐上游 pi packages/agent/src/harness/skills.ts;差异:未移植 loadSourcedSkills
// (来源标注的泛型封装,my-pi 没有消费方,等真需要溯源再加)。
//
// 校验是"宽松警告"式:除了缺 description 会拒载,其余违规(名字大写、超长……)
// 只出 diagnostics 不拦加载 —— 技能是用户自己的文件,报错要帮人修,不是拦人用。
/**
 * 职责:技能(skill)的一生 —— 从磁盘目录里发现 SKILL.md,把它解析成 Skill 数据,
 * 以及把某个技能的全文格式化成一段可以直接当用户消息发出去的 <skill> 文本。
 * 「技能」在这套内核里没有任何魔法:它就是一段被格式化后注入对话的提示词文本。
 *
 * 全景位置:装配阶段(全景篇 §4「阶段 0:装配」的 0.4 步)。coding-agent 的
 * core/resources.ts:discoverSkills 决定「找哪两个目录」,再调本文件的 loadSkills
 * 拿到 Skill[] 塞进 AgentHarnessResources。之后技能分两级进入模型视野:
 *   一级(列表):每轮系统提示词里由 harness/system-prompt.ts 的
 *                formatSkillsForSystemPrompt 只放 name/description/location 三样;
 *   二级(全文):模型自己用 read 工具去读那条 location,或者宿主调
 *                harness.skill(name)(agent-harness.ts:676),由本文件的
 *                formatSkillInvocation 把正文包成 <skill> 块走同一条 executeTurn。
 * 这个两级设计是技能可以写得很长而不炸上下文窗口的原因。
 *
 * 失败语义:发现过程永不抛错。除了「缺 description」会让技能被丢弃,其余违规
 * (名字大写、与父目录不一致、超长……)只产出 SkillDiagnostic 警告,不拦加载。
 *
 * 对应学习文档:docs/learn/agent/harness_skills.md
 * 分节索引:
 *   §1  依赖、上限常量与三张类型  —— 诊断码 / 诊断 / frontmatter 的形状
 *   §2  formatSkillInvocation     —— 第二级注入:全文包成 <skill> 块
 *   §3  loadSkills                —— 公开入口:多个根目录,缺席即静默跳过
 *   §4  loadSkillsFromDirInternal —— 递归遍历:SKILL.md 优先且终止本层
 *   §5  ignore 规则               —— 读三种 ignore 文件并给模式补目录前缀
 *   §6  loadSkillFromFile         —— 读文件 → frontmatter → 校验 → Skill
 *   §7  校验                      —— 宽松警告式,只有 description 是硬门槛
 *   §8  parseFrontmatter          —— 手写的 --- 切分,不是 YAML 库的 frontmatter
 *   §9  resolveKind               —— 符号链接显式解一次(fileInfo 不追链)
 *   §10 路径工具                  —— 纯字符串实现,刻意不用 node:path
 */
// ── §1 依赖、上限常量与三张类型 ──────────────────────────────────────────
// ignore 是 npm 上的 gitignore 规则引擎(本仓钉在 7.0.5)。用它而不是自己写 glob,
// 是因为技能目录常常就住在用户的 git 仓库里,「git 忽略什么、技能发现就忽略什么」
// 必须完全同解;自己实现 gitignore 的优先级/否定/目录语义是一个必错的活。
import ignore from "ignore";
// yaml 只负责解 frontmatter 那一小段(§8 手工切出来的那几行),从不解析整个文件。
import { parse } from "yaml";
// 从 harness/types.ts 拿四样东西:FileInfo / FileSystem 是注入的能力接口 ——
// 本文件绝不 import node:fs,因为技能目录可能挂在非本机的 ExecutionEnv 上;
// Result 是「预期失败当返回值、不当异常」的全内核约定;Skill 是产出的数据形状;
// toError 把 catch 到的任意值归一成 Error。
import { type FileInfo, type FileSystem, type Result, type Skill, toError } from "./types.ts";

// 两个上限都只用来产出警告,不拦加载(见 §7)。与上游 pi 对齐的数值:
// description 是每轮系统提示词里逐条铺开的,1024 字符这个上限的意思是
// 「这里写用途摘要,别把技能全文塞进来」——超了照样加载,只是提醒你窗口在流血。
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
// 三个 ignore 文件名全部生效而且**累加**(不是「找到第一个就停」),顺序只影响
// 规则先后。.ignore / .fdignore 是 ripgrep / fd 的约定,一并收进来是为了让
// 「用 rg 看不见的文件,技能发现也看不见」。
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

// ignore 库没有导出实例类型,只能从工厂函数的返回值反推出来。
type IgnoreMatcher = ReturnType<typeof ignore>;

/**
 * 诊断码。稳定字符串,宿主(桌面端 / ACP)拿它决定怎么展示,不解析 message 文本。
 * 五个码对应五种失败:stat 失败 / 列目录失败 / 读文件失败 / frontmatter 解析失败 /
 * 元数据不合规。注意 file_info_failed 在 §5 里被复用给了 joinPath 失败,名字略不准。
 */
export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/**
 * 一条加载期警告。全文件只产 warning、不产 error —— 技能是用户自己写的文件,
 * 报出来是为了帮人修,不是拦人用;真正会让技能消失的只有「缺 description」一条。
 */
/** Warning produced while loading skills. */
export interface SkillDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: SkillDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

// SKILL.md 的 YAML frontmatter 只认三个字段,其余键靠索引签名兜住(不报错,也不用)。
// 三个字段全可选,是因为解析这一步永远不失败:缺字段各自走回退与校验分支(§6/§7)。
interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

// ── §2 formatSkillInvocation:第二级注入,把技能全文包成 <skill> 块 ───────
/**
 * 把一个技能变成一段「就像用户自己打出来的」提示词文本。
 *
 * 参数:skill 是已经加载好的技能(content 是 SKILL.md 去掉 frontmatter 的正文);
 * additionalInstructions 是调用方要追加的一句话,可以不传。
 * 返回:一段纯文本。调用方 agent-harness.ts 的 skill()(:684)把它直接交给
 * executeTurn —— 也就是说技能调用与普通 prompt 走的是**同一条**路径,
 * 内核里根本不存在第二套「技能执行器」。
 * 失败:不会失败,纯字符串拼接。
 */
/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	// location 给的是 SKILL.md 自己的路径,而紧接着那句「References are relative to」
	// 给的是它所在的**目录** —— 技能正文里写的相对路径(随附脚本、参考数据)必须按
	// 目录解析;只给文件路径的话,模型会把相对路径接在 SKILL.md 这个文件名后面。
	// 注意:name / filePath 在这里**没有** XML 转义,而第一级注入那侧
	// (system-prompt.ts 的 formatSkillsForSystemPrompt)是逐字段 escapeXml 的 ——
	// 两侧不对称,技能名里带引号时这里拼出来的属性会破。
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	// 追加指令放在 </skill> **之后**,不进标签内部:标签里是技能作者写死的守则,
	// 标签外是本次调用方的临时要求。分开摆,模型才分得清「规矩」和「这次要干什么」。
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

// ── §3 loadSkills:公开入口,多个根目录,缺席即静默跳过 ──────────────────
/**
 * 唯一的公开加载入口。生产调用方只有一个:coding-agent 的
 * core/resources.ts:discoverSkills(全景篇 §4 阶段 0 的 0.4 步),它传进来的是
 * skillDirsOf() 算出的两个目录:<globalDir>/skills 与 <cwd>/.agents/skills。
 *
 * 参数:fs 是注入的文件系统能力;dirs 可以是一个目录,也可以是一组。
 * 返回:{ skills, diagnostics }。**不去重、不排序** —— 同名技能谁压过谁是应用层
 * 策略(discoverSkills 用一个 Map 后写覆盖先写,于是「项目技能压过全局技能」)。
 * 失败:永不抛。目录不存在是最常见的情况,连诊断都不产一条。
 */
/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files as skills, honors ignore
 * files, and returns diagnostics for invalid skill files. Missing input directories are skipped.
 */
export async function loadSkills(
	fs: FileSystem,
	dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	// 单目录与目录数组在这里统一成数组处理。数组顺序就是加载顺序,调用方靠它定义
	// 同名技能的覆盖优先级(后加载的赢),所以这个 for 绝不能改成并发。
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		// 先 stat 一次而不是直接 listDir。两个理由:一是要拿到 FileInfo.path
		// (绝对且已归一化的**地址**路径),后面所有相对路径计算都以它为基准;
		// 二是要把「目录不存在」和「存在但读不了」这两种截然不同的情况分开。
		const rootInfoResult = await fs.fileInfo(dir);
		if (!rootInfoResult.ok) {
			// not_found 静默:两个技能目录里通常至少有一个是不存在的,报出来全是噪音。
			// 其余错误(权限、I/O)必须报 —— 那才是「我明明放了技能却看不见」的真原因。
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		// 这里必须走 resolveKind 而不是直接看 rootInfo.kind:fileInfo 契约上不追符号
		// 链接,而把技能目录 symlink 进来(dotfiles 仓库的常见做法)完全合法(见 §9)。
		// 解出来不是目录就静默跳过 —— 于是传一个文件进来不会有任何提示。
		if ((await resolveKind(fs, rootInfo, diagnostics)) !== "directory") continue;
		// 三个实参各有讲究:
		//   includeRootFiles = true —— 只有最外这一层的散装 .md 才算技能(见 §4);
		//   ignore() 每个根目录**新建一个** —— 目录 A 的 .gitignore 不会污染目录 B;
		//   rootDir = rootInfo.path —— 传的是**地址**路径而不是 canonical 路径,于是
		//   symlink 进来的技能其 filePath 保留用户认得的那条链接路径(skills.test.ts
		//   的 "loads skills through symlinked directories" 用例专门钉住了这一条)。
		const result = await loadSkillsFromDirInternal(fs, rootInfo.path, true, ignore(), rootInfo.path);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

// ── §4 loadSkillsFromDirInternal:递归遍历,SKILL.md 优先且终止本层 ───────
/**
 * 递归主体。一层目录的处理顺序是固定的四步:吃 ignore 规则 → 列目录 →
 * 找 SKILL.md(找到就收下并**结束这一层**)→ 否则逐个条目:目录递归、
 * 根层的散装 .md 当单文件技能。
 *
 * 参数:dir 当前目录;includeRootFiles 只在最外层为 true;ignoreMatcher 是
 * **跨整棵树共享并原地累积**的同一个对象;rootDir 是所有相对路径的基准。
 * 返回:本子树收集到的技能与诊断,由调用方 push 合并上去。
 * 失败:永不抛,一切失败落成 diagnostics 并返回已经收到的那部分。
 */
async function loadSkillsFromDirInternal(
	fs: FileSystem,
	dir: string,
	includeRootFiles: boolean,
	ignoreMatcher: IgnoreMatcher,
	rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	// 又 stat 一次:根目录这一层与 loadSkills 里那次是重复的,递归进来的子目录则与
	// 上一层 listDir 已经拿到的 entry 重复。多一次 stat 换「本函数自成闭环、不依赖
	// 调用方递进来的 FileInfo 是对的」,是有意的取舍,不是漏优化。
	const dirInfoResult = await fs.fileInfo(dir);
	if (!dirInfoResult.ok) {
		if (dirInfoResult.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: dirInfoResult.error.message,
				path: dir,
			});
		}
		return { skills, diagnostics };
	}
	const dirInfo = dirInfoResult.value;
	// 同 §3:先解符号链接再判目录。递归进来的 entry 同样可能是指向目录的链接。
	if ((await resolveKind(fs, dirInfo, diagnostics)) !== "directory") return { skills, diagnostics };

	// ignore 规则必须在列目录**之前**吃进去,否则本目录的 .gitignore 管不住本目录
	// 的条目 —— 包括下面要找的那个 SKILL.md(是的,SKILL.md 也能被 ignore 掉)。
	await addIgnoreRules(fs, ignoreMatcher, dir, rootDir, diagnostics);

	// listDir 失败(权限、竞态删除)一定要报:它意味着这一整棵子树都没有被看过,
	// 而失败的表现和「这里本来就没有技能」一模一样。
	const entriesResult = await fs.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
		return { skills, diagnostics };
	}
	const entries = entriesResult.value;

	// 下面这个 for 是**查找**而不是遍历:只有名字恰好是 SKILL.md 的条目会被处理,
	// 命中并成功加载后直接 return,于是这一层的其余条目(包括所有子目录)不再看。
	// 全景篇 §6.1 专门点名过:这个 return 写在 for 内部,读起来很像 break 放错了地方。
	// 目录里有 SKILL.md 时,这个目录整体就是一个技能,不再往下递归。
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const fullPath = entry.path;
		// SKILL.md 本身也可能是符号链接(「技能库里 link 一份公共模板」的写法),
		// 所以判断类型仍要过 resolveKind,不能直接信 entry.kind。
		const kind = await resolveKind(fs, entry, diagnostics);
		if (kind !== "file") continue;
		// ignore 匹配用的是**相对 rootDir**的路径,这是 ignore 库的硬性要求:传绝对
		// 路径进去它会抛 RangeError(见 §10 的兜底分支)。
		// 被 ignore 掉时**不 return** 而是 continue —— 循环走完会落到下面的普通遍历,
		// 于是「SKILL.md 被忽略」的目录退化成一个普通容器目录,继续往下递归。
		const relPath = relativeEnvPath(rootDir, fullPath);
		if (ignoreMatcher.ignores(relPath)) continue;

		// 第三个实参是父目录名:技能没写 frontmatter name 时拿它当名字,写了则拿它
		// 校验「名字要和目录同名」(不一致只警告,见 §7)。
		const result = await loadSkillFromFile(fs, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		// 收下就走:目录级技能不再往下递归 —— 一个技能包内部的 references/、scripts/
		// 里往往也有 .md,那些是这个技能的资料,不是新的技能。
		// 再强调一次:这个 return 在 for 内部,它结束的是**整层遍历**而不只是本次循环。
		return { skills, diagnostics };
	}

	// 走到这里说明本层没有(可用的)SKILL.md,当容器目录处理。
	// sort 是**原地**排序 entries,目的是让加载顺序与文件系统返回顺序无关 ——
	// 同名技能的覆盖优先级由调用方按目录顺序定义,那么目录内顺序必须是确定的。
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		// 跳过隐藏条目与 node_modules。隐藏条目里就包含 .gitignore 自己 —— 它已经在
		// addIgnoreRules 里被读过了,不必再当技能候选。
		// 注意:被显式传进 loadSkills 的**根目录本身**可以是隐藏的(.agents/skills),
		// 这条规则只作用于遍历到的子条目。
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(fs, entry, diagnostics);
		if (!kind) continue;

		const relPath = relativeEnvPath(rootDir, fullPath);
		// gitignore 语义里的「目录模式」(写作 dropped/)只匹配带尾斜杠的路径,所以判定
		// 是目录时要补一个 "/" 再拿去匹配,否则 .gitignore 里写 dropped/ 会拦不住
		// dropped 这个目录(skills.test.ts 的 ignore 用例正是这么写的)。
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;

		// 递归:includeRootFiles 传 false —— 子目录里只认 SKILL.md,散装 .md 不算技能。
		// ignoreMatcher 与 rootDir 原样传下去,保证整棵树共用一套规则和同一个基准。
		// 这里既没有 visited 集合也没有深度上限:目录符号链接成环时会一路递归下去,
		// 最终靠操作系统的 ELOOP / 路径超长让 listDir 失败才停(表现是一堆 list_failed)。
		if (kind === "directory") {
			const result = await loadSkillsFromDirInternal(fs, fullPath, false, ignoreMatcher, rootDir);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		// 三个条件缺一不可。少任何一个,技能包内部的资料 .md 都会被误收成独立技能。
		// 根目录的散装 .md 也算技能(方便单文件技能);子目录里的只认 SKILL.md。
		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		// 单文件技能的 parentDirName 是**技能根目录**的名字,不是文件名 —— 于是
		// skills/root.md 不写 name 时技能名是 "skills"(skills.test.ts 钉住了这一条)。
		const result = await loadSkillFromFile(fs, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

// ── §5 ignore 规则:读三种 ignore 文件并给模式补目录前缀 ─────────────────
/**
 * 把 dir 下的 .gitignore / .ignore / .fdignore 读进共享的 ignore 匹配器。
 *
 * 参数:ig 是跨整棵树共享的匹配器,本函数**原地** add;rootDir 用来算前缀。
 * 返回:void —— 规则加没加进去、加了几条,调用方一概不关心。
 * 失败:读不到就跳过并记一条诊断,永不抛。
 */
async function addIgnoreRules(
	fs: FileSystem,
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	// 前缀是本目录相对于根的路径。根目录自己的 relativeDir 是 ""(见 §10),于是
	// prefix 也是 "",规则原样生效 —— 这正好就是 gitignore 在仓库根的语义。
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		// 拼路径走 fs.joinPath 而不是字符串加斜杠:分隔符是**目标环境**的事,而这个 fs
		// 未必是本机(远程 / 沙箱 ExecutionEnv 完全可能用另一套路径语法)。
		const ignorePathResult = await fs.joinPath([dir, filename]);
		if (!ignorePathResult.ok) {
			// 这里复用了 file_info_failed 这个码(实际是 joinPath 失败),而且 path 记的是
			// 目录而不是拼不出来的那个文件名 —— 排查时别被这条诊断的字面意思带偏。
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: ignorePathResult.error.message,
				path: dir,
			});
			continue;
		}
		const ignorePath = ignorePathResult.value;
		// 绝大多数目录根本没有 ignore 文件,所以 not_found 同样静默,只报别的错。
		const info = await fs.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		// 这里**不**走 resolveKind:指向 .gitignore 的符号链接会被当成非 file 跳过。
		// 与 §4 对目录 / SKILL.md 的处理不一致,是一处已知的不对称(实际几乎撞不上)。
		if (info.value.kind !== "file") continue;
		const content = await fs.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		// 按 /\r?\n/ 切行,顺手吃掉 Windows 的 CRLF —— 留着 \r 会让每条模式尾部多一个
		// 不可见字符,匹配永远不中,而且看日志完全看不出问题在哪。
		// prefixIgnorePattern 返回 null 表示这行是空行或注释,由 filter 丢掉。
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		// 空数组 add 也是安全的,这个判断只是省一次调用。三个 ignore 文件的规则
		// **累加**进同一个匹配器,不是「先找到的那个说了算」。
		if (patterns.length > 0) ig.add(patterns);
	}
}

// ignore 库按"相对 root 的路径"匹配,子目录 .gitignore 的模式要补上目录前缀才等价。
/**
 * 把一行 gitignore 模式改写成「相对 rootDir」的等价模式。
 *
 * 参数:line 是原始行(**未** trim);prefix 形如 "sub/dir/",根目录时是 ""。
 * 返回:改写后的模式;空行与注释行返回 null,由调用方 filter 掉。
 * 失败:不会失败。
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	// 判空行 / 注释用的是 trim 之后的文本,但下面真正拿去改写的是**未 trim** 的 line
	// —— 于是行首带空格的模式会带着空格进匹配器,基本匹配不中。已知的小坑。
	// `\#` 是 gitignore 里「文件名真的以 # 开头」的转义写法,不能当注释丢掉。
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	// 否定模式(!foo)要先把 ! 摘下来,给里面的路径补完前缀再装回去:直接拼成
	// prefix + "!foo" 的话 ! 跑到了中间,ignore 库就不再当它是否定,而是字面量。
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		// `\!foo` 在 gitignore 里表示「文件名真的叫 !foo」。这里把反斜杠脱掉了,于是
		// prefix 非空时得到 "sub/!foo"(! 在中间仍是字面量,结果正确);
		// 但 prefix 为空(根目录那份 ignore 文件)时得到 "!foo",会被 ignore 库当成
		// **否定规则** —— 这是本文件里唯一一处会把语义改反的边界,极少撞上。
		pattern = pattern.slice(1);
	}
	// 锚定到本目录的模式(/foo)要先去掉开头的斜杠再补前缀,得到 "sub/foo";
	// 不去掉的话拼出来是 "sub//foo",双斜杠匹配不中任何东西。
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

// ── §6 loadSkillFromFile:读文件 → frontmatter → 校验 → Skill ─────────────
/**
 * 把一个 .md 文件变成一个 Skill,或者变成若干条诊断。
 *
 * 参数:filePath 要读的文件;parentDirName 是它所在目录的 basename,一物两用 ——
 * 既当「没写 name 时的默认名字」,又当「写了 name 时的校验基准」。
 * 返回:{ skill, diagnostics }。skill 为 null 表示这个文件不成为技能。
 * 失败:读失败 / frontmatter 语法错都只记诊断并返回 null,永不抛。
 */
async function loadSkillFromFile(
	fs: FileSystem,
	filePath: string,
	parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	// 整文件读进内存。技能正文本来就是要整段塞进提示词的,没有流式读的意义;
	// 上限也不设 —— 真写了一个几 MB 的 SKILL.md,炸的是 provider 那一侧。
	const rawContent = await fs.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	// parseFrontmatter 只在 YAML 本身语法错时才失败;「没有 --- 围栏」和「围栏没有
	// 闭合」这两种情况都算**成功但 frontmatter 为空**(见 §8),接着必然因为缺
	// description 被静默丢弃 —— 这正是「我明明放了技能却看不见」的第一大来源。
	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	// 逐字段做 typeof 收窄:frontmatter 来自用户手写的 YAML,写成 description: 123
	// 会解析成数字。不收窄的话会带着一个非字符串进 Skill,一路到拼提示词才出问题。
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	// 校验先跑、诊断先记,再决定要不要丢弃 —— 顺序反过来的话,「description is
	// required」这条最有用的警告会跟着技能一起消失,用户就彻底没有线索了。
	for (const error of validateDescription(description)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	// name 缺席时回退到父目录名。于是目录级技能天然满足「名字 == 目录名」,
	// 只有显式写了 name 又写错的人才会看到下面那条不一致警告。
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	// 补充一句为什么硬门槛是 description 而不是 name:name 缺了可以回退到目录名,
	// 而 description 是**第一级注入**里模型唯一能看到的判断依据(system-prompt.ts
	// 的 <available_skills> 只放 name/description/location)。缺了它,这个技能在
	// 列表里就是一行没有用途说明的名字,等于永远不会被选中,占位还费 token。
	// 唯一的硬性要求:没有 description 的技能不加载 —— 模型全靠它决定何时读全文。
	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	// 走到这里技能一定成立,但 diagnostics 里可能仍有若干条警告 —— 宽松校验的全部
	// 含义就在这一句:警告和技能**同时**返回,不是二选一。
	return {
		skill: {
			name,
			description,
			// content 是去掉 frontmatter 并 trim 过的正文,不含 --- 围栏本身。
			content: body,
			filePath,
			// 严格 === true:YAML 里写成 disable-model-invocation: "true"(带引号)是字符串,
			// 不会命中 —— 宁可当没设置,也不猜用户的意图。
			// 这个开关只把技能从**系统提示词的列表**里摘掉(过滤动作在 system-prompt.ts),
			// 宿主仍然可以 harness.skill(name) 显式调用它 —— 这就是它存在的意义:
			// 「不让模型自己挑,但应用可以点名用」。
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

// ── §7 校验:宽松警告式,只有 description 是硬门槛 ───────────────────────
/**
 * 校验技能名。返回的是**错误文案数组**而不是布尔或异常 —— 调用方把每条包成一个
 * diagnostic 就完事,而且一次能把全部问题报齐,不是「修一个再报下一个」。
 * 规则来自 Agent Skills 的通行约定:小写字母、数字、连字符,且名字与目录同名。
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	// 名字与目录不一致只是警告,既不改名也不拒载 —— 但它几乎总是一个真错误:
	// 系统提示词里露出的是 name,而模型被要求去读的是 location 那条路径,两者
	// 对不上时,模型报的「我用了 X 技能」和它实际读到的文件不是一回事。
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	// 只允许小写 a-z / 0-9 / 连字符。这条正则顺带拦下空字符串(+ 要求至少一个字符),
	// 也拦下点号 —— 所以「拿文件名当技能名」(foo.md)必然会撞这一条。
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	// 首尾连字符与连续连字符单独报,是为了给出可操作的提示而不是笼统的「名字不合法」;
	// 它们本身已经被上面那条正则放行了(- 是允许字符),所以必须另外查。
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

/**
 * 校验描述。它与 validateName 的真正差别不在这个函数里,而在调用方:
 * 「description is required」这条虽然同样只是一条 warning,但调用方紧接着会
 * return null 把技能整个丢掉(见 §6);长度超限则是纯警告,照常加载。
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		// 空白也算缺失:只有空格的 description 对模型毫无信息量,留着反而占系统提示词。
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		// else if:缺失与超长互斥,缺失时不必再报一遍长度(length 是 0,报出来更迷惑)。
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

// ── §8 parseFrontmatter:手写的 --- 切分,不是 YAML 库的 frontmatter ───────
/**
 * 手写的 frontmatter 切分器:找 --- 围栏,中间那段交给 yaml 库,其余全算正文。
 *
 * 参数:content 是文件全文。泛型 T 只是给调用方省一次 as,运行时**不做任何校验**。
 * 返回:Result。只有 YAML 本身语法错才返回 ok:false;「没有围栏」「围栏没闭合」
 * 都返回 ok:true 且 frontmatter 为空对象、body 为整个文件。
 * 失败:异常被 toError 归一化后装进 Result,不外抛。
 */
function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		// 先把 CRLF 与单独的 CR 全部归一成 LF:下面所有位置计算都假设行尾只有一个字节,
		// 少了这一步,Windows 上写的 SKILL.md 会把围栏位置算错、frontmatter 尾部带 \r。
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		// 没有开头围栏 = 没有 frontmatter,整个文件当正文。注意这**不是错误** ——
		// 于是一个纯 markdown 的 .md 会一路走到 §6,因为缺 description 被静默丢弃。
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		// 从下标 3 开始找闭合围栏,跳过开头那三个横杠自身。找的是 "\n---" 而不是
		// "\n---\n",所以文件末尾没有换行的闭合围栏也认得。
		// 反面代价:frontmatter 内部若有一行以 --- 开头(YAML 的文档分隔符),会被
		// 当成闭合围栏提前切断,后面的字段就都进正文了。
		const endIndex = normalized.indexOf("\n---", 3);
		// 围栏没闭合时**不报错**,同样把整个文件当正文 —— 于是又落到「缺 description
		// 静默丢弃」。全景篇 §6.1 把这条列为技能「消失」的主要原因之一。
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		// 两个魔数都是围栏本身的长度:slice(4, endIndex) 里的 4 是 "---\n",跳过开头
		// 那一行;slice(endIndex + 4) 里的 4 是 "\n---",跳到闭合围栏之后。
		// 正文再 trim 一次,于是 Skill.content 不带前后空行。
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		// parse("") 返回 null(空 YAML 文档),?? {} 兜住 —— 否则 frontmatter 是 null,
		// 下一步读 .description 直接 TypeError,而这个技能文件本身其实完全正常。
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		// 唯一的失败路径:YAML 语法错。toError 把 yaml 库抛出的任意值归一成 Error,
		// 调用方只需要 .message 拿去填诊断。
		return { ok: false, error: toError(error) };
	}
}

// ── §9 resolveKind:符号链接显式解一次 ───────────────────────────────────
// fileInfo/listDir 不追符号链接;技能目录常被 symlink 进来,这里显式解一次。
/**
 * 把一个 FileInfo 归到 "file" / "directory" 两类之一,symlink 显式解一次。
 *
 * 参数:info 是**未追链**的 FileInfo(FileSystem 契约就是不追链)。
 * 返回:目标的 kind;解不出来(断链、权限、指向 socket 之类)返回 undefined。
 * 失败:不抛,失败记诊断;not_found 静默 —— 断链的 symlink 在技能目录里太常见。
 *
 * 关键:它只回答「这是什么」,**不改路径**。调用方继续用原来的地址路径往下走,
 * 于是 symlink 进来的技能其 filePath 是用户认得的那条链接路径,而不是真身路径。
 */
async function resolveKind(
	fs: FileSystem,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	// 快路:已经确定的两类直接返回,不做任何额外 I/O。绝大多数条目走这一条。
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	// 剩下的只可能是 "symlink"(FileKind 一共就三个值)。canonicalPath 是 FileSystem
	// 契约里**唯一**会解链的方法,所以这里必须显式调它,不能指望 fileInfo。
	const canonicalPath = await fs.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	// 拿到真身路径后再 stat 一次。这两次调用之间文件可能被删(TOCTOU),所以这一步
	// 的 not_found 同样静默 —— 报出来也只是噪音,结果都是「这个条目不算数」。
	const target = await fs.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	// 链指向另一条链时这里会返回 "symlink",于是落到 undefined —— 不做二级解链。
	// 实践中 canonicalPath 已经把链条走到底了,这只是一句防御性写法。
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

// ── §10 路径工具:纯字符串实现,刻意不用 node:path ────────────────────────
// 纯字符串版 dirname:资源路径可能来自非本机的 ExecutionEnv,不能用 node:path。
// 处理正反斜杠与 Windows 盘根("C:/" 的父目录是它自己)。
/**
 * 取一个路径的父目录,纯字符串实现。
 * 全文件只有一个消费者:§2 里那句「References are relative to X」。
 * 参数 path 是技能文件的地址路径;返回它所在的目录。没有失败路径,总有返回值。
 */
function dirnameEnvPath(path: string): string {
	// 先削掉结尾的斜杠 / 反斜杠,否则 "a/b/" 的父目录会被算成 "a/b"(它自己)。
	const normalized = path.replace(/[\\/]+$/, "");
	// 两种分隔符都找,取靠后的那个 —— 路径可能来自 Windows 侧的 ExecutionEnv,
	// 也可能是一条混用了两种分隔符的字符串,不能只认其中一种。
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	// Windows 盘根特判:"C:/foo" 的分隔符下标恰好是 2 且第 1 位是冒号,父目录应该是
	// "C:/" 而不是 "C:" —— 后者在 Windows 上表示「C 盘的当前目录」,含义完全不同。
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	// <= 0 覆盖两种情况:压根没有分隔符(-1)与分隔符就在开头("/SKILL.md")。
	// 前者返回 "/" 严格说不对(应该是 "."),但技能的 filePath 在生产路径上永远
	// 来自 FileInfo.path、必是绝对路径,所以撞不到。
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

/**
 * 算出 path 相对 root 的路径,给 ignore 库当匹配键用。
 * 参数:root 与 path 都是地址路径。返回:相对路径;path 就是 root 时返回 ""。
 * 与 dirnameEnvPath 的做法不同 —— 这里先把反斜杠统一成正斜杠,因为 ignore 库
 * 只认正斜杠(它在 win32 上自带的转换只作用于它自己的入参检查)。
 */
function relativeEnvPath(root: string, path: string): string {
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
	// 根目录自己 → 空串。addIgnoreRules 正是靠这个空串把根的 prefix 算成 ""。
	if (normalizedPath === normalizedRoot) return "";
	// 兜底分支(path 不在 root 之下)在正常遍历里到不了,它的作用是**不让函数返回
	// 一个以 / 开头的绝对路径** —— ignore 库对绝对路径会直接抛 RangeError,
	// 而本文件的契约是永不抛。注意这个 startsWith 比较是**大小写敏感**的:
	// 大小写不敏感的文件系统上 root 与 path 大小写不一致时就会走进这条兜底。
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
