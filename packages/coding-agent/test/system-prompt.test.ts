// 系统提示词构建的测试。移植自 pi coding-agent/test/system-prompt.test.ts,
// 去掉 pi 文档区块相关的两条(my-pi 不发布文档),补上身份行、
// collectToolPromptData 和技能区块的覆盖。
import { describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import { buildSystemPrompt, collectToolPromptData } from "../src/core/system-prompt.ts";
import { createCodingToolDefinitions } from "../src/core/tools/index.ts";

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
		it("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		it("suggests bash for exploration when grep/find/ls are absent", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use bash for file operations like ls, rg, find");
		});
	});

	describe("custom tool snippets", () => {
		it("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		it("lists custom tools even when promptSnippet is not provided", () => {
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
			expect(prompt).toContain("Evidence rules:");
			expect(prompt).toContain("Safety:");
			expect(prompt).toContain("Runtime behavior requires evidence from log or gdb.");
			expect(prompt).toContain("Do not perform destructive hardware actions such as chip erase unless explicitly requested.");
		});
	});

	describe("prompt guidelines", () => {
		it("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		it("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
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

describe("collectToolPromptData", () => {
	it("collects names, snippets, and guidelines from real tool definitions", () => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const data = collectToolPromptData(createCodingToolDefinitions(env));

		expect(data.selectedTools).toEqual(["read", "bash", "edit", "write", "toolchain", "examples"]);
		expect(data.toolSnippets?.read).toBe("Read file contents");
		expect(data.toolSnippets?.examples).toContain("verified vendor examples");
		expect(data.promptGuidelines?.length).toBeGreaterThan(0);
	});

	it("produces a prompt that only mentions registered tools", () => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const definitions = createCodingToolDefinitions(env);
		const prompt = buildSystemPrompt({ cwd: env.cwd, ...collectToolPromptData(definitions) });

		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash:");
		// grep 曾经出现在硬编码提示词里却没有注册,模型被指使去用一个不存在的工具。
		// 提示词现在完全由真实工具定义生成,所以"提到的"和"注册的"是同一份清单 ——
		// 这条断言守的是这个不变式,而不是某个具体工具在不在。
		for (const definition of definitions) {
			expect(prompt).toContain(`- ${definition.name}:`);
		}
		expect(prompt).not.toContain("- find:");
		expect(prompt).not.toContain("- ls:");
	});
});
