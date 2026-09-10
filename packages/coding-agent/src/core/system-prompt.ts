/**
 * 系统提示词构建。对应 pi coding-agent/src/core/system-prompt.ts。
 *
 * 与 pi 的差异:
 * 1. 去掉了 pi 文档区块(readmePath / docsPath / examplesPath)—— yoma 不随包发布文档;
 * 2. 技能区块直接用内核的 formatSkillsForSystemPrompt,不维护 coding-agent 分叉版。
 *
 * 2026-09-10 工具归零:工具的单行摘要与使用守则从前由 collectToolPromptData 从工具
 * 定义里收集,工具没了这条路也一起删 —— 现在只收 selectedTools 这一份名字清单。
 */
import { formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// Build tools list based on selected tools.
	// Every registered tool must be listed so the model never has to guess its capabilities.
	const tools = selectedTools || ["read", "bash", "edit", "write"];

	// customPrompt 只替换正文;收尾四段(append / 项目上下文 / 技能 / cwd)两条路共用
	// 下面**唯一**一份 —— 从前是各写一遍,而它们必须逐字节一致(这段文本决定模型看到的
	// 项目指令和技能清单)。read 门控两边同解:selectedTools 缺省时落到含 read 的四件套,
	// 给了空数组时两边都判 false,所以统一写成 tools.includes("read")。
	let prompt: string;
	if (customPrompt) {
		prompt = customPrompt;
	} else {
		const toolsList = tools.length > 0 ? tools.map((name) => `- ${name}`).join("\n") : "(none)";

		// Build guidelines based on which tools are actually available.
		// Set 保插入顺序,于是"去重且保序"不用自己再维护一个数组。
		const guidelinesSet = new Set<string>();

		// File exploration guidelines
		const hasBash = tools.includes("bash");
		const hasGrep = tools.includes("grep");
		const hasFind = tools.includes("find");
		const hasLs = tools.includes("ls");
		if (hasBash && !hasGrep && !hasFind && !hasLs) {
			guidelinesSet.add("Use bash for file operations like ls, rg, find");
		}

		// Always include these
		guidelinesSet.add("Be concise in your responses");
		guidelinesSet.add("Show file paths clearly when working with files");

		const guidelines = [...guidelinesSet].map((g) => `- ${g}`).join("\n");

		prompt = `You are Yoma, a coding and embedded-development agent.

Use only the tools listed below. Do not invent unavailable tools or claim that an action was performed unless its tool result proves it.

Working principles:
- Inspect relevant files and existing conventions before changing code.
- Batch independent read-only tool calls in one response. Keep dependent calls and state-changing operations in separate turns.
- Solve the requested problem at its root while keeping changes scoped.
- Preserve unrelated user changes.
- After changes, run the most relevant available verification.
- If verification cannot be performed, state exactly what remains unverified.
- Continue until the requested task is complete or a concrete blocker is found.

Evidence rules:
- A file edit does not prove that the project builds.
- A successful build does not prove that firmware was flashed.
- A successful flash and reset only prove programming and reset.
- Runtime behavior requires evidence from log or gdb.
- Register-level claims require datasheet evidence with page or section citations.
- Never present assumptions, low-confidence netlist suggestions, or optimized-out debugger values as facts.

Safety:
- Do not perform destructive hardware actions such as chip erase unless explicitly requested.
- Verify target chip, probe, and firmware path before programming.
- Do not overwrite unrelated work or broaden the task without a clear reason.

Available tools:
${toolsList}

Tool-specific rules:
${guidelines}`;
	}

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (tools.includes("read") && skills.length > 0) {
		prompt += `\n\n${formatSkillsForSystemPrompt(skills)}`;
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
