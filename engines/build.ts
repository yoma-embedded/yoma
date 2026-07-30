#!/usr/bin/env bun
// Build every capability engine, install the products into the single runtime
// layout (engines/bin + engines/data), then report what the tools resolve.
//   bun engines/build.ts           # build + install + doctor
//   bun engines/build.ts --check   # doctor only
// Needs cargo (stm32-config-kernel, probe-rs) and uv (controller_map).
//
// 运行时只认一种布局:bin/ 放可执行文件,data/<name>/ 放数据 —— 开发期由这里
// 用符号链接填充(重新 cargo build 后无需重装),将来打包时 CI 放真文件,同布局。

import { $ } from "bun";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 经由工具同一套解析代码取路径,报告不会和运行时行为漂移。
import { engineBin, engineDataDir, exe } from "@yoma/my-pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const checkOnly = process.argv.includes("--check");

const SUBMODULES = ["stm32-config-kernel", "controller_map", "probe-rs"];

async function need(cmd: string, hint: string) {
	if (!Bun.which(cmd)) throw new Error(`\`${cmd}\` not found on PATH — ${hint}`);
}

/** 链接优先(重构建即时生效),失败(如 Windows 无权限)退回复制。 */
function install(src: string, dest: string, kind: "file" | "dir") {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(path.dirname(dest), { recursive: true });
	try {
		symlinkSync(path.relative(path.dirname(dest), src), dest, kind === "dir" ? "junction" : "file");
	} catch {
		if (kind === "dir") cpSync(src, dest, { recursive: true });
		else copyFileSync(src, dest);
	}
}

if (!checkOnly) {
	// --check 是只读体检,不该在这里触发网络克隆;submodule 只在真要构建时才补。
	if (SUBMODULES.some((s) => !existsSync(path.join(here, s, ".git")))) {
		console.log("initializing git submodules …");
		await $`git -C ${repo} submodule update --init --recursive`;
	}

	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/4] stm32-config-kernel — cargo build --release");
	await $`cargo build --release`.cwd(path.join(here, "stm32-config-kernel"));

	console.log("\n[2/4] probe-rs — cargo build --release -p probe-rs-tools --bin probe-rs");
	await $`cargo build --release -p probe-rs-tools --bin probe-rs`.cwd(path.join(here, "probe-rs"));

	console.log("\n[3/4] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	console.log("\n[4/4] install — engines/bin + engines/data");
	const venvBin = path.join(here, "controller_map", ".venv", process.platform === "win32" ? "Scripts" : "bin");
	install(path.join(here, "stm32-config-kernel", "target", "release", exe("stm32kernel")), path.join(here, "bin", exe("stm32kernel")), "file");
	install(path.join(here, "probe-rs", "target", "release", exe("probe-rs")), path.join(here, "bin", exe("probe-rs")), "file");
	for (const entry of ["controller_map", "board_ir", "connections"]) {
		install(path.join(venvBin, exe(entry)), path.join(here, "bin", exe(entry)), "file");
	}
	install(path.join(here, "stm32-config-kernel", "data"), path.join(here, "data", "stm32"), "dir");
}

// doctor:每一行是工具运行时会解析到的真实路径。
function probe(label: string, fn: () => string): [string, string, boolean] {
	try {
		return [label, fn(), true];
	} catch (error) {
		return [label, (error instanceof Error ? error.message : String(error)).split("\n")[0]!, false];
	}
}

const at = { enginesDir: here };
const rows: [string, string, boolean][] = [
	probe("stm32kernel", () => engineBin("stm32kernel", at)),
	probe("probe-rs", () => engineBin("probe-rs", at)),
	probe("controller_map", () => engineBin("controller_map", at)),
	probe("board_ir", () => engineBin("board_ir", at)),
	probe("stm32 data", () => engineDataDir("stm32", at)),
];

console.log("\n─ doctor ─────────────────────────────────────────────");
let bad = 0;
for (const [name, loc, ok] of rows) {
	if (!ok) bad++;
	console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(16)} ${loc}`);
}

if (bad === 0) {
	console.log("\nAll good — the stm32config / (upcoming) netlist / flash tools will resolve these binaries.");
} else {
	console.log(`\n${bad} item(s) missing — run \`bun engines/build.ts\` to build and install.`);
	process.exit(1);
}
