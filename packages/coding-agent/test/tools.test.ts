import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { getOrThrow, NodeExecutionEnv } from "@yoma/agent/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "../src/index.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function makeEnv() {
	return new NodeExecutionEnv({ cwd: createTempDir() });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

describe("read tool", () => {
	it("reads a file", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.txt", "one\ntwo\nthree"));
		const read = createReadTool(env);
		const result = await read.execute("c1", { path: "a.txt" });
		expect(textOf(result)).toBe("one\ntwo\nthree");
	});

	it("honors offset and limit and tells the model how to continue", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.txt", "l1\nl2\nl3\nl4\nl5"));
		const read = createReadTool(env);
		const result = await read.execute("c1", { path: "a.txt", offset: 2, limit: 2 });
		const text = textOf(result);
		expect(text).toContain("l2\nl3");
		// 续读提示语是给模型看的契约,必须带上正确的下一个 offset。
		expect(text).toContain("[2 more lines in file. Use offset=4 to continue.]");
	});

	it("rejects an offset past the end of the file", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.txt", "only\n"));
		const read = createReadTool(env);
		await expect(read.execute("c1", { path: "a.txt", offset: 99 })).rejects.toThrow(/beyond end of file/);
	});

	it("throws for a missing file", async () => {
		const env = makeEnv();
		const read = createReadTool(env);
		await expect(read.execute("c1", { path: "nope.txt" })).rejects.toThrow();
	});

	it("truncates long files and reports the next offset", async () => {
		const env = makeEnv();
		const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
		getOrThrow(await env.writeFile("big.txt", lines));
		const read = createReadTool(env);
		const result = await read.execute("c1", { path: "big.txt" });
		const text = textOf(result);
		expect(text).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
	});
});

describe("write tool", () => {
	it("creates a file and reports bytes", async () => {
		const env = makeEnv();
		const write = createWriteTool(env);
		const result = await write.execute("c1", { path: "out.txt", content: "hello" });
		expect(textOf(result)).toBe("Successfully wrote 5 bytes to out.txt");
		expect(result.details.created).toBe(true);
		expect(getOrThrow(await env.readTextFile("out.txt"))).toBe("hello");
	});

	it("creates parent directories", async () => {
		const env = makeEnv();
		const write = createWriteTool(env);
		await write.execute("c1", { path: "deep/nested/dir/f.txt", content: "x" });
		expect(getOrThrow(await env.readTextFile("deep/nested/dir/f.txt"))).toBe("x");
	});

	it("marks an overwrite as not created", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("out.txt", "old"));
		const write = createWriteTool(env);
		const result = await write.execute("c1", { path: "out.txt", content: "new" });
		expect(result.details.created).toBe(false);
		expect(getOrThrow(await env.readTextFile("out.txt"))).toBe("new");
	});
});

describe("edit tool", () => {
	it("replaces a unique block", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "const a = 1;\nconst b = 2;\n"));
		const edit = createEditTool(env);
		const result = await edit.execute("c1", {
			path: "a.ts",
			edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
		});
		expect(textOf(result)).toBe("Successfully replaced 1 block(s) in a.ts.");
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("const a = 1;\nconst b = 3;\n");
	});

	it("applies several disjoint edits against the original content", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "alpha\nbeta\ngamma\n"));
		const edit = createEditTool(env);
		await edit.execute("c1", {
			path: "a.ts",
			edits: [
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "gamma", newText: "GAMMA" },
			],
		});
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("ALPHA\nbeta\nGAMMA\n");
	});

	it("refuses a non-unique oldText", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "dup\ndup\n"));
		const edit = createEditTool(env);
		await expect(edit.execute("c1", { path: "a.ts", edits: [{ oldText: "dup", newText: "x" }] })).rejects.toThrow(
			/Found 2 occurrences/,
		);
	});

	it("refuses text that is not present", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "hello\n"));
		const edit = createEditTool(env);
		await expect(edit.execute("c1", { path: "a.ts", edits: [{ oldText: "nope", newText: "x" }] })).rejects.toThrow(
			/Could not find the exact text/,
		);
	});

	it("refuses overlapping edits", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "abcdef\n"));
		const edit = createEditTool(env);
		await expect(
			edit.execute("c1", {
				path: "a.ts",
				edits: [
					{ oldText: "abcd", newText: "X" },
					{ oldText: "cdef", newText: "Y" },
				],
			}),
		).rejects.toThrow(/overlap/);
	});

	it("preserves CRLF line endings", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "one\r\ntwo\r\nthree\r\n"));
		const edit = createEditTool(env);
		await edit.execute("c1", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("one\r\nTWO\r\nthree\r\n");
	});

	it("preserves a leading BOM", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "﻿const a = 1;\n"));
		const edit = createEditTool(env);
		await edit.execute("c1", { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] });
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("﻿const a = 2;\n");
	});

	it("falls back to fuzzy matching for smart quotes", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "const s = ‘hi’;\n"));
		const edit = createEditTool(env);
		// 模型给的是直引号,文件里是弯引号 —— 精确匹配失败,模糊匹配救回来。
		await edit.execute("c1", { path: "a.ts", edits: [{ oldText: "const s = 'hi';", newText: "const s = 'bye';" }] });
		expect(getOrThrow(await env.readTextFile("a.ts"))).toContain("bye");
	});

	it("accepts the legacy single oldText/newText shape", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "x = 1\n"));
		const edit = createEditTool(env);
		const prepared = edit.prepareArguments!({ path: "a.ts", oldText: "x = 1", newText: "x = 2" });
		await edit.execute("c1", prepared);
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("x = 2\n");
	});

	it("accepts edits sent as a JSON string", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "x = 1\n"));
		const edit = createEditTool(env);
		const prepared = edit.prepareArguments!({
			path: "a.ts",
			edits: JSON.stringify([{ oldText: "x = 1", newText: "x = 9" }]),
		});
		await edit.execute("c1", prepared);
		expect(getOrThrow(await env.readTextFile("a.ts"))).toBe("x = 9\n");
	});

	it("reports a structured diff for the UI", async () => {
		const env = makeEnv();
		getOrThrow(await env.writeFile("a.ts", "one\ntwo\n"));
		const edit = createEditTool(env);
		const result = await edit.execute("c1", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
		expect(result.details.oldContent).toBe("one\ntwo\n");
		expect(result.details.newContent).toBe("one\nTWO\n");
		expect(result.details.firstChangedLine).toBe(2);
		expect(result.details.patch).toContain("-two");
		expect(result.details.patch).toContain("+TWO");
	});
});

describe("bash tool", () => {
	it("runs a command and returns stdout", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		const result = await bash.execute("c1", { command: "printf hello" });
		expect(textOf(result)).toBe("hello");
	});

	it("reports no output as (no output)", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		expect(textOf(await bash.execute("c1", { command: "true" }))).toBe("(no output)");
	});

	it("flags UTF-8 replacement characters so garbled CJK is not treated as firmware evidence", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		const result = await bash.execute("c1", { command: "printf '\\357\\277\\275 tick'" });
		expect(textOf(result)).toContain("\uFFFD");
		expect(textOf(result)).toContain("U+FFFD replacement characters");
		expect(textOf(result)).toContain("Do not treat garbled CJK as firmware evidence");
	});

	it("throws with the output attached on a non-zero exit code", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		await expect(bash.execute("c1", { command: "printf oops; exit 3" })).rejects.toThrow(
			/oops[\s\S]*Command exited with code 3/,
		);
	});

	it("reports timeouts", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		await expect(bash.execute("c1", { command: "sleep 5", timeout: 0.05 })).rejects.toThrow(/Command timed out/);
	});

	it("reports aborts", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		const controller = new AbortController();
		const promise = bash.execute("c1", { command: "sleep 5" }, controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow(/Command aborted/);
	});

	it("streams throttled partial results through onUpdate", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		const updates: string[] = [];
		await bash.execute("c1", { command: "printf a; sleep 0.15; printf b" }, undefined, (partial) => {
			updates.push(partial.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(""));
		});
		// 第一条是"开始执行"的空更新,之后是节流后的增量。
		expect(updates[0]).toBe("");
		expect(updates.at(-1)).toContain("a");
	});

	it("spills oversized output to a file and points the model at it", async () => {
		const env = makeEnv();
		const bash = createBashTool(env);
		const result = await bash.execute("c1", { command: "yes line | head -n 15000" });
		const text = textOf(result);
		expect(text).toContain("Full output:");
		expect(result.details?.truncation?.truncated).toBe(true);
	});
});
