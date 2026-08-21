// 资源发现(应用层策略)验收:AGENTS.md 祖先链 + 去重,技能目录顺序与重名覆盖。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { discoverSkills, loadContextFiles, skillDirsOf } from "../src/core/resources.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("loadContextFiles", () => {
	it("collects global file plus ancestors, outermost first, cwd last", async () => {
		const root = createTempDir();
		const globalDir = join(root, "global");
		const project = join(root, "repo");
		const cwd = join(project, "firmware", "app");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		write(join(globalDir, "AGENTS.md"), "global rules");
		write(join(project, "AGENTS.md"), "repo rules");
		write(join(cwd, "AGENTS.md"), "app rules");

		const env = new NodeExecutionEnv({ cwd });
		const files = await loadContextFiles(env, { cwd, globalDir });

		// 越具体越靠后:全局 → 仓库根 → cwd。
		expect(files.map((f) => f.content)).toEqual(["global rules", "repo rules", "app rules"]);
	});

	it("prefers AGENTS.override.md over AGENTS.md and falls back to CLAUDE.md", async () => {
		const root = createTempDir();
		const overrideDir = join(root, "o");
		const claudeDir = join(overrideDir, "c");
		mkdirSync(claudeDir, { recursive: true });

		write(join(overrideDir, "AGENTS.md"), "shadowed");
		write(join(overrideDir, "AGENTS.override.md"), "override wins");
		write(join(claudeDir, "CLAUDE.md"), "claude fallback");

		const env = new NodeExecutionEnv({ cwd: claudeDir });
		const files = await loadContextFiles(env, { cwd: claudeDir, globalDir: join(root, "none") });

		expect(files.map((f) => f.content)).toEqual(["override wins", "claude fallback"]);
	});

	it("deduplicates identical content, e.g. a worktree checkout shadowing the main repo copy", async () => {
		const root = createTempDir();
		const repo = join(root, "repo");
		const worktree = join(repo, ".claude", "worktrees", "feat");
		mkdirSync(worktree, { recursive: true });

		write(join(repo, "AGENTS.md"), "same instructions");
		write(join(worktree, "AGENTS.md"), "same instructions");

		const env = new NodeExecutionEnv({ cwd: worktree });
		const files = await loadContextFiles(env, { cwd: worktree, globalDir: join(root, "none") });

		expect(files.map((f) => f.content)).toEqual(["same instructions"]);
	});

	it("returns empty when nothing exists anywhere", async () => {
		const root = createTempDir();
		const cwd = join(root, "empty");
		mkdirSync(cwd, { recursive: true });

		const env = new NodeExecutionEnv({ cwd });
		const files = await loadContextFiles(env, { cwd, globalDir: join(root, "none") });

		expect(files).toEqual([]);
	});
});

describe("discoverSkills", () => {
	it("looks in ~/.agents/skills, the global skills dir and the project .agents/skills", () => {
		const dirs = skillDirsOf({ cwd: "/proj", globalDir: "/home/u/.yoma", homeDir: "/home/u" });
		expect(dirs).toEqual([
			join("/home/u", ".agents", "skills"),
			join("/home/u/.yoma", "skills"),
			join("/proj", ".agents", "skills"),
		]);
	});

	it("merges both locations and lets project skills override global ones by name", async () => {
		const root = createTempDir();
		const globalDir = join(root, "config");
		const cwd = join(root, "proj");
		mkdirSync(join(globalDir, "skills", "flash-triage"), { recursive: true });
		mkdirSync(join(globalDir, "skills", "global-only"), { recursive: true });
		mkdirSync(join(cwd, ".agents", "skills", "flash-triage"), { recursive: true });

		write(
			join(globalDir, "skills", "flash-triage", "SKILL.md"),
			"---\ndescription: global version\n---\nglobal body",
		);
		write(join(globalDir, "skills", "global-only", "SKILL.md"), "---\ndescription: only global\n---\nbody");
		write(
			join(cwd, ".agents", "skills", "flash-triage", "SKILL.md"),
			"---\ndescription: project version\n---\nproject body",
		);

		const env = new NodeExecutionEnv({ cwd });
		// homeDir 指向临时目录,不读开发机真实的 ~/.agents/skills。
		const { skills, diagnostics } = await discoverSkills(env, { cwd, globalDir, homeDir: root });

		expect(diagnostics).toEqual([]);
		const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
		expect(Object.keys(byName).sort()).toEqual(["flash-triage", "global-only"]);
		// 项目技能压过全局同名技能。
		expect(byName["flash-triage"]!.description).toBe("project version");
	});
});
