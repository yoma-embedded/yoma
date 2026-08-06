// M9 验收:loadSkills 磁盘发现。移植自参考 test/harness/skills.test.ts,
// 去掉 loadSourcedSkills 用例(未移植该封装),补 ignore 规则与"目录缺席静默跳过"。
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadSkills", () => {
	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true });
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true });
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);
		await symlink(join(root, "actual"), join(root, "skills-link"));

		const { skills } = await loadSkills(env, "skills-link");

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("rejects skills without a description and reports a diagnostic", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true });
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.");

		const { skills, diagnostics } = await loadSkills(env, "user");

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "invalid_metadata",
				message: "description is required",
				path: join(root, "user/broken/SKILL.md"),
			},
		]);
	});

	it("loads direct markdown children only from the root directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested", { recursive: true });
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content");
		await env.writeFile("skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content");

		const { skills } = await loadSkills(env, "skills");

		// 无 frontmatter name 时回退到父目录名 —— 根目录散装 .md 的名字就是技能根目录。
		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});

	it("keeps loading invalid-named skills but reports lenient diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/My-Skill", { recursive: true });
		await env.writeFile("skills/My-Skill/SKILL.md", "---\nname: My-Skill\ndescription: Valid enough\n---\nBody");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		// 宽松校验:大写名字只警告不拦载。
		expect(skills.map((skill) => skill.name)).toEqual(["My-Skill"]);
		expect(diagnostics.map((d) => d.code)).toEqual(["invalid_metadata"]);
		expect(diagnostics[0]?.message).toContain("invalid characters");
	});

	it("honors ignore files inside skill directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/kept", { recursive: true });
		await env.createDir("skills/dropped", { recursive: true });
		await env.writeFile("skills/.gitignore", "dropped/\n");
		await env.writeFile("skills/kept/SKILL.md", "---\ndescription: Kept\n---\nKept body");
		await env.writeFile("skills/dropped/SKILL.md", "---\ndescription: Dropped\n---\nDropped body");

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
	});

	it("silently skips missing input directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });

		const { skills, diagnostics } = await loadSkills(env, [join(root, "does-not-exist"), join(root, "also-missing")]);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});
