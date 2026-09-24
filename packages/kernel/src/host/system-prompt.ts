/**
 * 系统提示词构建。对应 pi coding-agent/src/core/system-prompt.ts。
 *
 * 与 pi 的差异:
 * 1. 去掉了 pi 文档区块(readmePath / docsPath / examplesPath)—— yoma 不随包发布文档;
 * 2. 技能区块直接用内核的 formatSkillsForSystemPrompt,不维护 pi coding-agent 的分叉版。
 *
 * 2026-09-10 工具归零:工具的单行摘要与使用守则从前由 collectToolPromptData 从工具
 * 定义里收集,工具没了这条路也一起删 —— 现在只收 selectedTools 这一份名字清单。
 *
 * 2026-09-18 子 agent(docs/子agent-设计方案-v0.4-20260918.md §4.2):`agentPrompt` 照 CC 的
 * runAgent + enhanceSystemPromptWithEnvDetails,用 agent 自己的正文换掉 Yoma 主正文、追加四条 Notes 与 env 块;
 * 但工具清单与工具守则**照留** —— yoma 的守则写在系统提示词里(契约的 guidelines),不在工具描述里,
 * 走 customPrompt 那条路就连守则一起丢了。
 */
import { formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";

import { toolGuidelines } from "./tools/contracts.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/**
	 * 子 agent 的正文(profile.prompt)。给了它就换掉 Yoma 的主正文,工具清单与守则照留,并追加 CC 的四条 Notes;
	 * 结尾的 cwd 行换成 env 块。customPrompt 优先于它。
	 */
	agentPrompt?: string;
	/** 子 agent 的 env 块(CC computeEnvInfo):平台、日期、模型。只在 agentPrompt 时用;没给的行不出。 */
	environment?: { platform?: string; date?: string; model?: string };
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

/** CC `constants/prompts.ts` enhanceSystemPromptWithEnvDetails 的四条 Notes,原文。 */
export const SUBAGENT_NOTES = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`;

/**
 * 手上有 grep / find / ls 又有 shell 时的找文件守则(docs/调试留痕-规划-20260924.md §2.1)。
 *
 * 2026-09-24 从本机会话量出来的"卡在工具上"全是这一类:Windows 上经 Git Bash 对每个子目录跑 `du -sh`、没排除 node_modules 的
 * `grep -rn`,一跑就是几分钟到半小时、管道后面还接着 sort / head,一个字都不出。自带的 grep / find 走 rg、认 .gitignore,
 * 同样的搜索是秒级。工具名按实际装配的拼 —— 子 agent 的工具池按 profile 裁过,提到它手上没有的工具只会让它空转一次。
 */
export function fileSearchGuideline(tools: readonly string[]): string | undefined {
	const finders = ["grep", "find", "ls"].filter((name) => tools.includes(name));
	const shells = ["bash", "powershell"].filter((name) => tools.includes(name));
	if (finders.length === 0 || shells.length === 0) return undefined;
	return `Search and list files with the ${finders.join("/")} tool${finders.length > 1 ? "s" : ""}, not ${shells.join(" or ")}: they are fast and skip .gitignore'd paths. Never run recursive scans in the shell (du, grep -r, find, ls -R, Get-ChildItem -Recurse) over node_modules, build output or a whole drive — on Windows they can run for many minutes with no output. If one is unavoidable, exclude those directories and pass a timeout.`;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		agentPrompt,
		environment,
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
	const isAgent = !customPrompt && agentPrompt !== undefined;

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
		} else {
			const search = fileSearchGuideline(tools);
			if (search) guidelinesSet.add(search);
		}

		// 硬件工具各自的守则写在它们的契约里(host/tools/<name>/contract.ts 的 guidelines),
		// 新内核的 AgentTool 没有 promptGuidelines 字段,所以由这里按装配出的工具名收集。
		for (const guideline of toolGuidelines(tools)) guidelinesSet.add(guideline);

		// Always include these
		guidelinesSet.add("Be concise in your responses");
		guidelinesSet.add("Show file paths clearly when working with files");

		const guidelines = [...guidelinesSet].map((g) => `- ${g}`).join("\n");

		if (isAgent) {
			prompt = [agentPrompt!.trim(), SUBAGENT_NOTES, `Available tools:\n${toolsList}`, `Tool-specific rules:\n${guidelines}`]
				.filter(Boolean)
				.join("\n\n");
		} else {
			prompt = `You are Yoma, a coding and embedded-development agent.

Use only the tools listed below. Do not invent unavailable tools or claim that an action was performed unless its tool result proves it.

Working principles:
- Inspect relevant files and existing conventions before changing code.
- Start with a scoped search and read the matching ranges. Reuse verified commands and setup from this session unless inputs or environment changed.
- Batch independent read-only tool calls in one response. Keep dependent calls and state-changing operations in separate turns.
- Solve the requested problem at its root while keeping changes scoped.
- Preserve unrelated user changes.
- After changes, run the most relevant available verification.
- If verification cannot be performed, state exactly what remains unverified.
- Continue until the requested task is complete or a concrete blocker is found.
- After an error, identify what must change before retrying. Repeating the same failing operation or reading unchanged evidence is not progress; obtain a discriminating observation or report the blocker.

Evidence rules:
- A file edit does not prove that the project builds.
- A successful build does not prove that firmware was flashed.
- A successful flash and reset only prove programming and reset.
- Runtime claims need observations from the current firmware and test interval. State what was measured and what remains unknown.
- Accept a relevant, consistent test record already provided by the user or tools. Do not repeat a completed experiment or demand unavailable raw data when that record establishes the requested claim.
- Distinguish requested or configured state, software-reported state, inferred quantities, and direct observations. A status flag or computed estimate supports only what it actually measures, not every downstream outcome.
- If direct observations contradict indirect telemetry, acknowledge the conflict and investigate it; do not repeat the contradicted success claim.
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

	if (isAgent) {
		// CC computeEnvInfo 的形状;没给的行不出。
		const envLines = [
			`Working directory: ${promptCwd}`,
			...(environment?.platform ? [`Platform: ${environment.platform}`] : []),
			...(environment?.date ? [`Today's date: ${environment.date}`] : []),
		];
		prompt += `\n\nHere is useful information about the environment you are running in:\n<env>\n${envLines.join("\n")}\n</env>`;
		if (environment?.model) prompt += `\nYou are powered by the model ${environment.model}.`;
	} else {
		prompt += `\nCurrent working directory: ${promptCwd}`;
	}

	return prompt;
}
