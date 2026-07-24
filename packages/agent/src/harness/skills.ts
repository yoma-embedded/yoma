// M7 Step 1:技能调用的格式化(仅此而已)。
// harness 对本文件的全部依赖就是 formatSkillInvocation 这一个函数 ——
// "调用一个技能" = 把 SKILL.md 的内容包上 <skill> 标签、作为提示词文本注入对话。
// 从目录递归发现/加载技能(loadSkills,~340 行,含 ignore 规则和 frontmatter 解析)是 M9 的事。
import type { Skill } from "./types.ts";

// 纯字符串版 dirname:资源路径可能来自非本机的 ExecutionEnv,不能用 node:path。
function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex <= 0 ? "/" : normalized.slice(0, slashIndex);
}

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}
