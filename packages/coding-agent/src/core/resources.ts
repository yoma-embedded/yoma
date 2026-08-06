/**
 * 资源发现(应用层策略):上下文文件 + 技能目录。
 *
 * 内核提供机制(loadSkills 递归发现、formatSkillsForSystemPrompt 注入),
 * "从哪些目录找"是产品决定,收在这一个文件里。对应 pi 的 resource-loader.ts,
 * 但只保留 my-pi 用得上的两样:AGENTS.md 与 skills。
 *
 * 失败语义:发现过程绝不抛错 —— 读不到的文件直接跳过,技能问题以 diagnostics
 * 返回。资源是锦上添花,不能因为一个坏文件让 session/new 失败。
 */
import { dirname, join } from "node:path";
import { type FileSystem, loadSkills, type Skill, type SkillDiagnostic } from "@yoma/my-pi";

/** 每个目录里按此顺序找第一个存在的上下文文件,override 优先(语义同 pi)。 */
const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
	path: string;
	content: string;
}

async function contextFileOf(fs: FileSystem, dir: string): Promise<ContextFile | undefined> {
	for (const name of CONTEXT_FILE_CANDIDATES) {
		const path = join(dir, name);
		// 只试着读:目录/不存在/无权限都表现为读失败,统一跳过。
		const content = await fs.readTextFile(path);
		if (content.ok) return { path, content: content.value };
	}
	return undefined;
}

/**
 * 收集上下文文件:全局目录一份 + 从 cwd 向上走到文件系统根,每个目录一份。
 * 返回顺序:全局 → 最外层祖先 → … → cwd(和 pi 一致:越具体越靠后,离指令越近权重越高)。
 *
 * 去重两道:canonical 路径(大小写不敏感文件系统上 AGENTS.md/AGENTS.MD 是同一个文件)
 * 和文件内容(worktree 里主仓与检出副本各有一份同内容 AGENTS.md,读两遍毫无意义 ——
 * pi 用 git 管道精确识别这种遮蔽,my-pi 用内容一致这个更便宜的近似)。
 */
export async function loadContextFiles(
	fs: FileSystem,
	options: { cwd: string; globalDir: string },
): Promise<ContextFile[]> {
	const files: ContextFile[] = [];
	const seenPaths = new Set<string>();
	const seenContent = new Set<string>();

	const add = async (file: ContextFile): Promise<void> => {
		const canonical = await fs.canonicalPath(file.path);
		const pathKey = canonical.ok ? canonical.value : file.path;
		if (seenPaths.has(pathKey) || seenContent.has(file.content)) return;
		seenPaths.add(pathKey);
		seenContent.add(file.content);
		files.push(file);
	};

	const globalFile = await contextFileOf(fs, options.globalDir);
	if (globalFile) await add(globalFile);

	const ancestors: ContextFile[] = [];
	let dir = options.cwd;
	while (true) {
		const file = await contextFileOf(fs, dir);
		if (file) ancestors.unshift(file);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const file of ancestors) await add(file);

	return files;
}

/**
 * 技能目录(按此顺序加载,重名时后者覆盖前者,即项目技能压过全局技能):
 *   1. <globalDir>/skills            —— 全局技能(~/.my-pi/skills)
 *   2. <cwd>/.agents/skills          —— Agent Skills 标准位置,与 pi / Claude Code 共享
 *
 * 简化:不像 pi 那样沿祖先目录一路找 .agents/skills —— Zed 会话的 cwd 就是项目根,
 * 真遇到 monorepo 子目录再加。
 */
export function skillDirsOf(options: { cwd: string; globalDir: string }): string[] {
	return [join(options.globalDir, "skills"), join(options.cwd, ".agents", "skills")];
}

/** 发现技能并按名字去重(后加载的覆盖先加载的)。诊断原样透出,由调用方决定怎么展示。 */
export async function discoverSkills(
	fs: FileSystem,
	options: { cwd: string; globalDir: string },
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const { skills, diagnostics } = await loadSkills(fs, skillDirsOf(options));
	const byName = new Map<string, Skill>();
	for (const skill of skills) byName.set(skill.name, skill);
	return { skills: [...byName.values()], diagnostics };
}
