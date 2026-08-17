#!/usr/bin/env bun
// Build every capability engine, install the products into the single runtime
// layout (engines/bin + engines/data), then report what the tools resolve.
//   bun engines/build.ts           # build + install + doctor
//   bun engines/build.ts --check   # doctor only
//   bun engines/build.ts --dist    # 产出可分发的自包含产物到 engines/dist/
// Needs cargo (stm32-config-kernel) and uv (controller_map).
//
// 运行时只认一种布局:bin/ 放可执行文件,data/<name>/ 放数据 —— 开发期由这里
// 用符号链接填充(重新 cargo build 后无需重装),分发时 --dist 往同样的布局里放真文件。
//
// ## --dist:为什么不能直接打包开发期产物
//
// 三个 Python 程序在开发期是 uv venv 的 console script —— **文本文件,第一行写死了
// 构建机的绝对路径**(`#!/Users/xxx/…/.venv/bin/python`)。拷到别人电脑上必坏,
// 而且报的错是"找不到解释器",看起来像没编译。--dist 用 PyInstaller 把解释器和依赖
// 冻结进可执行文件本身,产出真正与路径无关的二进制(dist 阶段会验这一点)。
//
// data 分两半,处理方式不同:
//   - irpacks(27 个族一共 ~6MB)—— 随产物一起发,小到可以忽略;
//   - fw/(ST 官方 HAL 组件,**1.1GB**,压缩后仍有 ~174MB)—— **不进分发产物**。
//     它只有 `stm32kernel generate` 用得到,而那条命令本来就收 --fw-dir,
//     所以按族按需取(STM32G4 压缩后才 4MB)远比让每个人下 1.1GB 合理。

import { $ } from "bun";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 经由工具同一套解析代码取路径,报告不会和运行时行为漂移。
import { engineBin, engineDataDir, exe } from "@yoma/coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const dist = process.argv.includes("--dist");
const distDir = (() => {
	const at = process.argv.indexOf("--out");
	return at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]!) : path.join(here, "dist");
})();

/** setuptools 的 console script 入口,冻结时要为每个造一个 __main__ 壳。 */
const PY_ENTRIES: Array<[string, string]> = [
	["controller_map", "controller_map.controller_map"],
	["connections", "controller_map.connections"],
	["board_ir", "controller_map.board_ir"],
];

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

/**
 * 冻结一个 console script 成自包含可执行文件。
 *
 * PyInstaller 只吃脚本文件,不吃 `pkg.mod:main` 这种入口点写法,所以先造一个壳。
 * `--onefile` 让产物是单个文件(运行时自解压到临时目录),布局上和 Rust 产物一致。
 */
async function freeze(name: string, module: string, outBin: string, work: string): Promise<void> {
	const project = path.join(here, "controller_map");
	const shim = path.join(work, `${name}_entry.py`);
	mkdirSync(work, { recursive: true });
	writeFileSync(shim, `from ${module} import main\nif __name__ == "__main__":\n    raise SystemExit(main())\n`);
	await $`uv run --with pyinstaller pyinstaller --onefile --clean --noconfirm --distpath ${path.join(work, "out")} --workpath ${path.join(work, "build")} --specpath ${work} --name ${name} --paths . ${shim}`.cwd(
		project,
	);
	copyFileSync(path.join(work, "out", exe(name)), outBin);
}

/**
 * 分发前的自检:这个文件拷到别人电脑上还能跑吗?
 *
 * 分**硬失败**和**提醒**两档,阈值是"会不会真的坏":
 *
 * - 硬失败:软链(别人那儿是断链,electron-builder 还原样保留它)、shebang 文本脚本
 *   (第一行写死构建机的解释器路径,正是这套东西历史上真出过的那个 bug)、
 *   缺可执行位、以及产物里出现 `.venv` 解释器引用(冻结没生效的标志)。
 * - 只提醒:二进制里出现构建机的家目录。Rust 会把源码路径编进调试信息,那些字符串
 *   只在 panic 回溯里露面,**不构成运行依赖** —— 判成失败是误报(第一版就这么干的,
 *   stm32kernel 这类 Rust 产物全红,而它其实好好的)。
 */
function auditDist(root: string): { problems: string[]; notes: string[] } {
	const problems: string[] = [];
	const notes: string[] = [];
	const binDir = path.join(root, "bin");
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	for (const entry of readdirSync(binDir)) {
		const file = path.join(binDir, entry);
		const stat = statSync(file, { throwIfNoEntry: false });
		if (!stat) {
			problems.push(`${entry}: 不存在`);
			continue;
		}
		if (stat.isSymbolicLink()) problems.push(`${entry}: 是符号链接,分发产物必须是真文件`);
		if (process.platform !== "win32" && !(stat.mode & 0o111)) problems.push(`${entry}: 没有可执行位`);

		const bytes = readFileSync(file);
		const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("latin1");
		if (head.startsWith("#!")) problems.push(`${entry}: 还是 shebang 脚本(第一行 ${head.split("\n")[0]})`);
		const text = bytes.toString("latin1");
		if (/[/\\]\.venv[/\\]/.test(text)) problems.push(`${entry}: 引用了 .venv 解释器,冻结没生效`);
		if (home.length > 8 && text.includes(home)) notes.push(`${entry}: 内含构建机家目录(调试信息,不影响运行)`);
	}
	return { problems, notes };
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (dist) {
	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/4] stm32-config-kernel — cargo build --release");
	await $`cargo build --release`.cwd(path.join(here, "stm32-config-kernel"));

	console.log("\n[2/4] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(path.join(distDir, "bin"), { recursive: true });
	mkdirSync(path.join(distDir, "data", "stm32"), { recursive: true });

	console.log("\n[3/4] freeze — PyInstaller(把解释器打进可执行文件,摆脱 venv 绝对路径)");
	const work = path.join(distDir, ".freeze");
	for (const [name, module] of PY_ENTRIES) {
		console.log(`  · ${name}`);
		await freeze(name, module, path.join(distDir, "bin", exe(name)), path.join(work, name));
	}
	rmSync(work, { recursive: true, force: true });

	console.log("\n[4/4] collect — 真文件,不是软链");
	copyFileSync(
		path.join(here, "stm32-config-kernel", "target", "release", exe("stm32kernel")),
		path.join(distDir, "bin", exe("stm32kernel")),
	);
	// irpacks 随产物走(27 个族一共 ~6MB);fw/ 故意不带 —— 见文件头。
	const dataSrc = path.join(here, "stm32-config-kernel", "data");
	let irpacks = 0;
	for (const entry of readdirSync(dataSrc)) {
		if (!entry.endsWith(".irpack")) continue;
		copyFileSync(path.join(dataSrc, entry), path.join(distDir, "data", "stm32", entry));
		irpacks++;
	}

	// irpack 数量是"这份产物到底支持几个芯片族"的唯一体现 —— 少了就静默少一大半,
	// 用户侧表现成"这个族不支持",看起来像产品限制而不是构建产物缺料
	// (实测:一次 CI 只产出 2 个,本机是 27 个)。少于阈值就红。
	const MIN_IRPACKS = 20;
	const { problems, notes } = auditDist(distDir);
	if (irpacks < MIN_IRPACKS) {
		problems.push(
			`只收到 ${irpacks} 个 irpack(期望 ≥${MIN_IRPACKS})—— ` +
				`engines/stm32-config-kernel/data/ 里的 *.irpack 缺料,` +
				`用 stm32ck-importer 对着本机 CubeMX db 重新导入(见该目录 README 的「开发期数据管道」)`,
		);
	}
	const manifest = {
		platform: process.platform,
		arch: process.arch,
		builtAt: new Date().toISOString(),
		irpacks,
		// fw 不在产物里:1.1GB(压缩后仍 ~174MB),而且只有 generate 用得到。
		firmware: "not-bundled",
		bin: Object.fromEntries(
			readdirSync(path.join(distDir, "bin")).map((entry) => [
				entry,
				{ bytes: statSync(path.join(distDir, "bin", entry)).size, sha256: sha256(path.join(distDir, "bin", entry)) },
			]),
		),
	};
	writeFileSync(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

	console.log("\n─ dist ───────────────────────────────────────────────");
	for (const [name, info] of Object.entries(manifest.bin)) {
		console.log(`  ${name.padEnd(18)} ${(info.bytes / 1048576).toFixed(1)} MB`);
	}
	console.log(`  ${"irpacks".padEnd(18)} ${irpacks} 个族`);
	console.log(`\n产物:${distDir}`);

	for (const note of notes) console.log(`  ℹ ${note}`);
	if (problems.length) {
		console.log("\n✗ 分发自检未过:");
		for (const problem of problems) console.log(`  · ${problem}`);
		process.exit(1);
	}
	console.log("\n✓ 分发自检通过:全是真文件,没有 shebang 脚本,没有 venv 引用");
	process.exit(0);
}

if (!checkOnly) {
	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/3] stm32-config-kernel — cargo build --release");
	await $`cargo build --release`.cwd(path.join(here, "stm32-config-kernel"));

	console.log("\n[2/3] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	console.log("\n[3/3] install — engines/bin + engines/data");
	const venvBin = path.join(here, "controller_map", ".venv", process.platform === "win32" ? "Scripts" : "bin");
	install(path.join(here, "stm32-config-kernel", "target", "release", exe("stm32kernel")), path.join(here, "bin", exe("stm32kernel")), "file");
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
