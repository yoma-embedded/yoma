/**
 * 系统提示词构建。对应 pi coding-agent/src/core/system-prompt.ts。
 *
 * 与 pi 的差异:
 * 1. 去掉了 pi 文档区块(readmePath / docsPath / examplesPath)—— my-pi 不随包发布文档;
 * 2. 技能区块直接用内核的 formatSkillsForSystemPrompt,不维护 coding-agent 分叉版;
 * 3. 加了 collectToolPromptData:pi 在 AgentSession 的装配代码里收集工具提示词元数据,
 *    my-pi 没有 AgentSession,就近放在这里。
 */
import { formatSkillsForSystemPrompt, type Skill } from "@yoma/my-pi";
import type { ToolDefinition } from "./tools/types.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** 从工具定义收集 buildSystemPrompt 要的三样:名字清单、单行摘要、使用守则。 */
export function collectToolPromptData(
	definitions: ToolDefinition<any, any>[],
): Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "promptGuidelines"> {
	const selectedTools: string[] = [];
	const toolSnippets: Record<string, string> = {};
	const promptGuidelines: string[] = [];
	for (const definition of definitions) {
		selectedTools.push(definition.name);
		if (definition.promptSnippet) {
			toolSnippets[definition.name] = definition.promptSnippet;
		}
		promptGuidelines.push(...(definition.promptGuidelines ?? []));
	}
	return { selectedTools, toolSnippets, promptGuidelines };
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

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
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += `\n\n${formatSkillsForSystemPrompt(skills)}`;
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Build tools list based on selected tools.
	// Every registered tool must be listed so the model never has to guess its capabilities.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolsList =
		tools.length > 0
			? tools.map((name) => (toolSnippets?.[name] ? `- ${name}: ${toolSnippets[name]}` : `- ${name}`)).join("\n")
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are Yoma, a coding and embedded-development agent.

Use only the tools listed below. Do not invent unavailable tools or claim that an action was performed unless its tool result proves it.

Working principles:
- Inspect relevant files and existing conventions before changing code.
- Solve the requested problem at its root while keeping changes scoped.
- Preserve unrelated user changes.
- After changes, run the most relevant available verification.
- If verification cannot be performed, state exactly what remains unverified.
- Continue until the requested task is complete or a concrete blocker is found.

Evidence rules:
- A file edit does not prove that the project builds.
- A successful build does not prove that firmware was flashed.
- Flash download/reset only proves programming and reset.
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
	if (hasRead && skills.length > 0) {
		prompt += `\n\n${formatSkillsForSystemPrompt(skills)}`;
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
