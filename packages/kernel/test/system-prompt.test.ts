// 系统提示词构建的测试。移植自 pi coding-agent/test/system-prompt.test.ts,
// 去掉 pi 文档区块相关的两条(yoma 不发布文档),补上身份行与技能区块的覆盖。
// 2026-09-10 工具归零后提示词只认 selectedTools 这一份名字清单,工具摘要 /
// 使用守则那两组用例随 collectToolPromptData 一起删了。
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/types.ts";
import { toolGuidelines } from "../src/host/tools/contracts.ts";
import { buildSystemPrompt } from "../src/host/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		it("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		it("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("identity", () => {
		it("identifies itself as Yoma, not the underlying model vendor", () => {
			const prompt = buildSystemPrompt({ cwd: process.cwd() });

			expect(prompt).toContain("You are Yoma, a coding and embedded-development agent");
		});

		it("ends with the current working directory", () => {
			const prompt = buildSystemPrompt({ cwd: "/tmp/some-project" });

			expect(prompt.endsWith("Current working directory: /tmp/some-project")).toBe(true);
		});
	});

	describe("default tools", () => {
		it("lists the four coding tools when selectedTools is omitted", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read");
			expect(prompt).toContain("- bash");
			expect(prompt).toContain("- edit");
			expect(prompt).toContain("- write");
		});

		it("suggests bash for exploration when grep/find/ls are absent", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use bash for file operations like ls, rg, find");
		});
	});

	// 工具定义已经没有 promptGuidelines 字段了(新内核的 AgentTool 不收),flash 的两条守则
	// 只能挂在这里。落不进去的代价不是文档不全:模型会继续用 bash 起 openocd,而那条路在
	// 探针租约体系里是隐形的。
	describe("flash guidelines", () => {
		const PROBE_RULE =
			"- Run every command that touches the debug probe through the flash tool, not bash — the probe lease and hung-flasher cleanup live there.";
		const RESET_RULE = "- Never claim firmware is running on hardware unless flashing and a reset both succeeded.";

		it("adds both probe rules when flash is available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write", "flash"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(PROBE_RULE);
			expect(prompt).toContain(RESET_RULE);
		});

		it("says nothing about the probe when only the coding tools are present", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain(PROBE_RULE);
			expect(prompt).not.toContain(RESET_RULE);
		});
	});

	describe("custom tools", () => {
		it("lists whatever selectedTools names, not just the default four", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool");
		});
	});

	describe("agent behavior", () => {
		it("includes working, evidence, and safety rules", () => {
			const prompt = buildSystemPrompt({ cwd: process.cwd() });

			expect(prompt).toContain("Working principles:");
			expect(prompt).toContain("Batch independent read-only tool calls in one response.");
			expect(prompt).toContain("Evidence rules:");
			expect(prompt).toContain("Safety:");
			expect(prompt).toContain("Runtime claims need observations from the current firmware and test interval.");
			expect(prompt).toContain("Do not perform destructive hardware actions such as chip erase unless explicitly requested.");
		});
	});

	describe("skills section", () => {
		const skill = {
			name: "release",
			description: "How to cut a release",
			content: "steps...",
			filePath: "/skills/release/SKILL.md",
		};

		it("lists skills when the read tool is available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				skills: [skill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>release</name>");
			expect(prompt).toContain("<location>/skills/release/SKILL.md</location>");
		});

		it("omits skills when the read tool is not available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash"],
				skills: [skill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});

		it("hides disableModelInvocation skills from the listing", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				skills: [skill, { ...skill, name: "secret", disableModelInvocation: true }],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<name>release</name>");
			expect(prompt).not.toContain("<name>secret</name>");
		});
	});

	describe("custom prompt", () => {
		it("replaces the default prompt but keeps cwd", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are a test harness.",
				cwd: "/tmp/x",
			});

			expect(prompt).toContain("You are a test harness.");
			expect(prompt).not.toContain("Available tools:");
			expect(prompt).toContain("Current working directory: /tmp/x");
		});
	});
});

describe("全装配面的提示词", () => {
	it("有 grep / find / ls 时不再建议用 bash 做文件操作,且每个契约的守则都进了", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/p", selectedTools: [...TOOL_NAMES] });
		expect(prompt).not.toContain("Use bash for file operations");
		for (const name of TOOL_NAMES) expect(prompt).toContain(`- ${name}`);
		for (const guideline of toolGuidelines(TOOL_NAMES)) expect(prompt).toContain(guideline);
		expect(toolGuidelines(TOOL_NAMES).length).toBeGreaterThan(2);
	});
});

// 子 agent(docs/子agent-设计方案-v0.4-20260918.md §4.2):照 CC 用 agent 自己的正文换掉主正文、追加四条 Notes 与
// env 块;但工具清单与守则照留 —— yoma 的守则写在系统提示词里,走 customPrompt 就连守则一起丢了。
describe("agentPrompt(子 agent)", () => {
	it("换掉 Yoma 主正文,工具清单与该工具的守则照留,接上 CC 的四条 Notes", () => {
		const prompt = buildSystemPrompt({ agentPrompt: "You are a datasheet researcher.", selectedTools: ["read", "datasheet"], cwd: "/p" });
		expect(prompt.startsWith("You are a datasheet researcher.\n\nNotes:\n- Agent threads always have their cwd reset between bash calls")).toBe(true);
		expect(prompt).not.toContain("You are Yoma, a coding and embedded-development agent");
		expect(prompt).not.toContain("Working principles:");
		expect(prompt).toContain("Available tools:\n- read\n- datasheet");
		expect(toolGuidelines(["datasheet"]).length).toBeGreaterThan(0);
		for (const guideline of toolGuidelines(["datasheet"])) expect(prompt).toContain(guideline);
		expect(prompt).toContain("For clear communication with the user the assistant MUST avoid using emojis.");
	});

	it("结尾是 env 块而不是 cwd 行;没给的行不出", () => {
		const full = buildSystemPrompt({
			agentPrompt: "A",
			cwd: "D:\\proj",
			environment: { platform: "win32", date: "2026-09-18", model: "deepseek/deepseek-v4-flash" },
		});
		expect(full.endsWith(
			"Here is useful information about the environment you are running in:\n<env>\nWorking directory: D:/proj\nPlatform: win32\nToday's date: 2026-09-18\n</env>\nYou are powered by the model deepseek/deepseek-v4-flash.",
		)).toBe(true);
		expect(full).not.toContain("Current working directory:");
		const bare = buildSystemPrompt({ agentPrompt: "A", cwd: "/p" });
		expect(bare.endsWith("<env>\nWorking directory: /p\n</env>")).toBe(true);
	});

	it("项目上下文与技能照旧拼在正文后面;不给 contextFiles 就没有(Explore 的 omitContextFiles 靠宿主不传)", () => {
		const withContext = buildSystemPrompt({ agentPrompt: "A", cwd: "/p", contextFiles: [{ path: "/p/AGENTS.md", content: "use HAL" }] });
		expect(withContext).toContain('<project_instructions path="/p/AGENTS.md">\nuse HAL\n</project_instructions>');
		expect(buildSystemPrompt({ agentPrompt: "A", cwd: "/p" })).not.toContain("<project_context>");
	});

	it("customPrompt 优先于 agentPrompt;空的 agentPrompt 仍是子 agent 形状", () => {
		const custom = buildSystemPrompt({ customPrompt: "C", agentPrompt: "A", cwd: "/p" });
		expect(custom.startsWith("C")).toBe(true);
		expect(custom).toContain("Current working directory: /p");
		expect(buildSystemPrompt({ agentPrompt: "", cwd: "/p" }).startsWith("Notes:\n")).toBe(true);
	});
});
