import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordToolchainPath, rememberFreshResults } from "../src/host/domain/toolchain/actions.ts";
import { findFamilyTool } from "../src/host/domain/toolchain/families.ts";
import { machinePathDirs } from "../src/host/domain/toolchain/install.ts";
import { readLedger, writeLedgerEntry } from "../src/host/domain/toolchain/ledger.ts";
import { resolveToolchain, shellEnvFor } from "../src/host/domain/toolchain/resolve.ts";
import type { ToolSpec } from "../src/host/domain/toolchain/schema.ts";
import { writeFakeExe } from "./fixtures/fake-exe.ts";

let root: string;
let configDir: string;
let selected: string;
let globalBin: string;
beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "yoma-tool-readiness-"));
	configDir = path.join(root, "config");
	selected = path.join(root, "selected");
	globalBin = path.join(root, "global");
	mkdirSync(selected);
	mkdirSync(globalBin);
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const widget: ToolSpec = { id: "widget", bin: ["widget"] };
function resolve(spec: ToolSpec = widget, skipLedger = false) {
	return resolveToolchain({
		projectDir: root,
		configDir,
		platform: "test",
		env: { PATH: globalBin, PATHEXT: ".EXE" },
		skipLedger,
		manifestText: JSON.stringify({ schema: "yoma/toolchain@1", tools: [spec] }),
	});
}
const fake = (dir: string, name: string, code = 'console.log("1.2.3")') => writeFakeExe(dir, name, code);

describe("recorded paths are not readiness evidence", () => {
	it.each(["empty-directory", "wrong-executable", "deleted-path"])(
		"keeps explicit %s visible even when PATH has a working tool",
		async (kind) => {
			fake(globalBin, "widget");
			const chosen = kind === "wrong-executable" ? fake(selected, "another-tool") : selected;
			await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
			if (kind === "deleted-path") rmSync(selected, { recursive: true });
			const result = await resolve();
			expect(result.tools[0]).toMatchObject({ status: "recorded", source: "ledger", checks: { entry: "missing" } });
			expect(result.tools[0].candidates).toContain(chosen);
			expect(result.ok).toBe(false);
			expect(shellEnvFor(result, { PATH: "base" }).PATH).toBe("base");
		},
	);

	it("an explicit version mismatch is not silently replaced; stale auto discoveries are", async () => {
		const chosen = fake(selected, "widget", 'console.log("1.0.0")');
		fake(globalBin, "widget", 'console.log("3.0.0")');
		await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
		expect((await resolve({ ...widget, version: ">=2" })).tools[0]).toMatchObject({
			status: "version-mismatch",
			source: "ledger",
			version: "1.0.0",
		});
		await writeLedgerEntry(
			{ id: "widget", bin: { widget: path.join(root, "gone") }, by: "auto", confirmedAt: 1 },
			configDir,
		);
		expect((await resolve()).tools[0]).toMatchObject({ status: "ok", source: "path", version: "3.0.0" });
	});

	it("fresh probing retains explicit choices and never demotes them to auto cache", async () => {
		const chosen = fake(selected, "widget");
		fake(globalBin, "widget", 'console.log("9.0.0")');
		await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
		const fresh = await resolve(widget, true);
		expect(fresh.tools[0]).toMatchObject({ status: "ok", source: "ledger", version: "1.2.3" });
		await rememberFreshResults(fresh, configDir);
		expect((await readLedger(configDir)).entries.widget.by).toBe("user");
	});

	it("version-looking output with a failure exit code is not execution success", async () => {
		const chosen = fake(selected, "widget", 'console.log("1.2.3"); process.exitCode = 1');
		await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
		const result = await resolve();
		expect(result.tools[0]).toMatchObject({
			status: "unverified",
			checks: { entry: "found", execution: "unverified" },
		});
		expect(result.ok).toBe(false);
		// 非标准版本命令不会阻止用户主动使用其明确选择的入口。
		expect(shellEnvFor(result, {}).PATH?.split(path.delimiter)).toContain(selected);
	});

	it("probes with the supplied session environment rather than the ambient process", async () => {
		fake(
			globalBin,
			"widget",
			`console.log("1.2.3"); if (process.env.YOMA_PROBE_DEPENDENCY !== ${JSON.stringify(root)}) process.exitCode = 7`,
		);
		expect((await resolve()).tools[0].status).toBe("unverified");
		const result = await resolveToolchain({
			projectDir: root,
			configDir,
			platform: "test",
			env: { PATH: globalBin, PATHEXT: ".EXE", YOMA_PROBE_DEPENDENCY: root },
			manifestText: JSON.stringify({ schema: "yoma/toolchain@1", tools: [widget] }),
		});
		expect(result.tools[0]).toMatchObject({ status: "ok", checks: { execution: "passed" } });
	});

	it("candidate probes use their declared exports and sibling PATH just like actual execution", async () => {
		const chosen = fake(
			selected,
			"widget",
			`import path from "node:path";
const executable = process.platform === "win32" ? process.argv[1].replace(/\\.mjs$/, ".exe") : process.argv[1].replace(/\\.mjs$/, "");
const envPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
const valid = process.env.WIDGET_SELF === executable && process.env.WIDGET_MODE === "declared" && envPath.split(path.delimiter)[0] === path.dirname(executable);
console.log("1.2.3"); if (!valid) process.exitCode = 7;`,
		);
		await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
		const spec = { ...widget, exports: { WIDGET_SELF: "{path}", WIDGET_MODE: "declared" } };
		const resolved = await resolve(spec);
		expect(resolved.tools[0].status).toBe("ok");
		const env = shellEnvFor(resolved, {});
		expect(env.WIDGET_SELF?.toLowerCase()).toBe(chosen.toLowerCase());
		expect(env.WIDGET_MODE).toBe("declared");
		const overridden = await resolveToolchain({
			projectDir: root,
			configDir,
			platform: "test",
			env: { PATH: globalBin, WIDGET_MODE: "user-choice" },
			manifestText: JSON.stringify({ schema: "yoma/toolchain@1", tools: [spec] }),
		});
		expect(overridden.tools[0].status).toBe("unverified");
		expect(shellEnvFor(overridden, { WIDGET_MODE: "user-choice" }).WIDGET_MODE).toBe("user-choice");
	});

	it("an existing empty file is not executable", async () => {
		const chosen = path.join(selected, process.platform === "win32" ? "widget.exe" : "widget");
		writeFileSync(chosen, "");
		await recordToolchainPath({ id: "widget", path: chosen, configDir, bins: widget.bin });
		expect((await resolve()).tools[0]).toMatchObject({ status: "unverified", checks: { execution: "unverified" } });
	});

	it("directory resources are configured, never probed or added to PATH", async () => {
		const marker = path.join(root, "unexpected-gui-start");
		fake(
			selected,
			"GUI",
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started")`,
		);
		await recordToolchainPath({ id: "stm32cubemx", path: selected, configDir, probe: "exists" });
		const result = await resolve({
			id: "stm32cubemx",
			pathKind: "dir",
			exports: { RESOURCE_ROOT: "{path}", LEGACY_ROOT: "{bin}" },
		});
		expect(result.tools[0]).toMatchObject({
			status: "configured",
			checks: { entry: "directory", execution: "not-applicable" },
		});
		// configured 是目录资源的终态:没有任何动作能把它变成 ok,所以它不算"需要处理"(2026-09-18 之前
		// 这里钉的是 false,结果 IDF 配好之后汇总里永远挂着 "needing attention: idf")。它仍然不进 PATH、
		// 不被执行 —— 下面三条钉的正是这个。
		expect(result.ok).toBe(true);
		expect(result.needsAttention).toEqual([]);
		expect(existsSync(marker)).toBe(false);
		expect(shellEnvFor(result, {})).toEqual({ RESOURCE_ROOT: selected, LEGACY_ROOT: selected });
		expect(machinePathDirs({ configDir, ledger: await readLedger(configDir) })).toEqual([]);
	});
});

describe("all entries versus alternatives", () => {
	it("Arm GCC requires all four executable roles; pointing at gcc also locates siblings", async () => {
		const { title: _title, from: _from, ...spec } = findFamilyTool("arm-gcc")!;
		const gcc = fake(selected, "arm-none-eabi-gcc", 'console.log("13.2.1")');
		await recordToolchainPath({ id: spec.id, path: gcc, configDir, bins: spec.bin });
		const partial = await resolve(spec);
		expect(partial.tools[0]).toMatchObject({
			status: "unverified",
			checks: { entry: "partial" },
			missingBins: spec.bin!.slice(1),
		});
		expect(machinePathDirs({ configDir, ledger: await readLedger(configDir) })).toEqual([]);
		expect(shellEnvFor(partial, {})).toEqual({});
		for (const name of spec.bin!.slice(1)) fake(selected, name, 'console.log("2.40.0")');
		const complete = await resolve({ ...spec, version: ">=13" });
		expect(complete.tools[0]).toMatchObject({
			status: "ok",
			checks: { entry: "found", execution: "passed", version: "satisfied" },
		});
		expect(Object.keys(complete.tools[0].bin)).toEqual(spec.bin);
		expect(machinePathDirs({ configDir, ledger: await readLedger(configDir) })).toEqual([selected]);
	});

	it("GDB alternatives need only one usable name", async () => {
		const { title: _title, from: _from, ...spec } = findFamilyTool("arm-gdb")!;
		const exe = fake(selected, "gdb-multiarch", 'console.log("GNU gdb 13.2.1")');
		await recordToolchainPath({ id: spec.id, path: exe, configDir, bins: spec.bin });
		expect((await resolve(spec)).tools[0]).toMatchObject({ status: "ok", checks: { entry: "found" } });
	});

	it("all probes companion commands; any selects the working alternative", async () => {
		fake(globalBin, "first", 'console.log("1.2.3"); process.exitCode = 1');
		fake(globalBin, "second");
		const spec: ToolSpec = { id: "widget", bin: ["first", "second"] };
		expect((await resolve({ ...spec, binMode: "all" })).tools[0].status).toBe("unverified");
		const alternative = await resolve({ ...spec, binMode: "any" });
		expect(alternative.tools[0].status).toBe("ok");
		expect(Object.keys(alternative.tools[0].bin)).toEqual(["second"]);
	});
});
