// 系统提示词构建的测试。移植自 pi coding-agent/test/system-prompt.test.ts,
// 去掉 pi 文档区块相关的两条(yoma 不发布文档),补上身份行与技能区块的覆盖。
// 2026-09-10 工具归零后提示词只认 selectedTools 这一份名字清单,工具摘要 /
// 使用守则那两组用例随 collectToolPromptData 一起删了。
import { describe, expect, it } from "vitest";
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
			expect(prompt).toContain("Runtime behavior requires evidence from log or gdb.");
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
