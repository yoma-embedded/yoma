#!/usr/bin/env bun
// Build every capability engine, install the products into the single runtime
// layout (engines/bin + engines/data), then report what the tools resolve.
//   bun engines/build.ts           # build + install + doctor
//   bun engines/build.ts --check   # doctor only
//   bun engines/build.ts --dist    # 产出可分发的自包含产物到 engines/dist/
//   bun engines/build.ts --dist --allow-missing-irpacks
//     # 没 CubeMX 时仍冻结网表引擎;STM32 配置不进产物(CI 出 Windows 包用)
// Needs cargo (stm32-config-kernel) and uv (controller_map). logic-analyzer (yoma-la, C/CMake,
// Windows 上要 MSYS2 ucrt64)没有工具链时跳过 —— 像没有 CubeMX 时跳过 irpack 一样,但 manifest 里会写明。
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
//   - irpacks —— CubeMX 器件库经 stm32ck-import 解析出的构建产物,**不进 git**。
//     本机有 CubeMX(或 STM32CK_CUBEMX_DB)时,build.ts 会自己导入;装进运行时
//     布局 / --dist 产物。没有 CubeMX 时开发构建跳过 STM32 配置(网表引擎照装),
//     --dist 仍然硬失败 —— 安装包不能默默少一族。
//   - fw/(ST 官方 HAL 组件,**1.1GB**,压缩后仍有 ~174MB)—— **不进分发产物**。
//     它只有 `stm32kernel generate` 用得到,而那条命令本来就收 --fw-dir,
//     所以按族按需取(STM32G4 压缩后才 4MB)远比让每个人下 1.1GB 合理。

import { $ } from "bun";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 经由工具同一套解析代码取路径,报告不会和运行时行为漂移。
import { engineBin, exe } from "@yoma/coding-agent";
import { buildLa, findLaToolchain, installLa, selfCheckLa } from "./logic-analyzer/build.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const dist = process.argv.includes("--dist");
const allowMissingIrpacks = process.argv.includes("--allow-missing-irpacks");
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

const kernelDir = path.join(here, "stm32-config-kernel");
const kernelData = path.join(kernelDir, "data");
// irpack 数量是"这份产物到底支持几个芯片族"的唯一体现 —— 少了就静默少一大半,
// 用户侧表现成"这个族不支持",看起来像产品限制而不是构建产物缺料
// (实测:一次 CI 只产出 2 个,本机是 27 个)。少于阈值就红。
const MIN_IRPACKS = 20;

function countIrpacks(dir: string): number {
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter((entry) => entry.endsWith(".irpack")).length;
}

function errorText(error: unknown): string {
	const asText = (part: unknown): string => {
		if (part == null) return "";
		if (typeof part === "string") return part;
		if (part instanceof Uint8Array) return new TextDecoder().decode(part);
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(part)) return part.toString("utf8");
		return String(part);
	};
	if (error && typeof error === "object") {
		const e = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
		return [e.stderr, e.stdout, e.message].map(asText).join("\n");
	}
	return String(error);
}

// ripgrep 不是本仓构建的,是 BurntSushi 的预编译产物 —— agent 在例程语料里 grep
// 全靠它(Windows 没有内置 grep;rg 的速度与 .gitignore 语义都是选它的理由)。
// 版本钉死;要升级就改这里再删掉 engines/bin 里的 rg 重跑。
const RG_VERSION = "14.1.1";

function rgArchive(): { name: string; binary: string } {
	const map: Record<string, { name: string; binary: string }> = {
		"win32-x64": { name: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`, binary: "rg.exe" },
		"darwin-arm64": { name: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, binary: "rg" },
		"darwin-x64": { name: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, binary: "rg" },
		"linux-x64": { name: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`, binary: "rg" },
		"linux-arm64": { name: `ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`, binary: "rg" },
	};
	const hit = map[`${process.platform}-${process.arch}`];
	if (!hit) throw new Error(`no ripgrep release for ${process.platform}-${process.arch}`);
	return hit;
}

/**
 * 确保 bin/ 里有一个 rg。三档来源,按优先级:
 *   1. 已存在 → 跳过(要刷新就删掉它);
 *   2. $YOMA_RIPGREP_ARCHIVE 指向的本地压缩包(离线机器/镜像下载);
 *   3. 系统 PATH 上已有的 rg(开发机便利档,版本不受钉);
 *   4. 从 GitHub Releases 下载钉死版本的预编译产物。
 * 解压统一走系统 tar:Windows 10+ 的 System32 bsdtar 认 zip,unix 认 tar.gz。
 */
async function ensureRipgrep(binDir: string): Promise<void> {
	const dest = path.join(binDir, exe("rg"));
	if (existsSync(dest)) {
		console.log(`  · rg 已存在,跳过(${path.relative(here, dest)})`);
		return;
	}
	mkdirSync(binDir, { recursive: true });

	const fromEnv = process.env.YOMA_RIPGREP_ARCHIVE;
	if (fromEnv && existsSync(fromEnv)) {
		await extractRipgrep(fromEnv, dest);
		console.log(`  · rg 从 $YOMA_RIPGREP_ARCHIVE 解出(${fromEnv})`);
		return;
	}
	const onPath = Bun.which("rg");
	if (onPath) {
		copyFileSync(onPath, dest);
		console.log(`  · rg 从系统 PATH 复制(${onPath},版本不受钉)`);
		return;
	}
	const { name } = rgArchive();
	const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${name}`;
	console.log(`  · 下载 ${url}`);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
	const tmpArchive = path.join(binDir, `.rg-download-${Date.now()}`);
	writeFileSync(tmpArchive, Buffer.from(await response.arrayBuffer()));
	try {
		await extractRipgrep(tmpArchive, dest);
		const version = await $`${dest} --version`.quiet();
		if (!version.stdout.toString().includes(RG_VERSION)) {
			throw new Error(`downloaded rg reports unexpected version: ${version.stdout.toString().split("\n")[0]}`);
		}
	} finally {
		rmSync(tmpArchive, { force: true });
	}
}

async function extractRipgrep(archive: string, dest: string): Promise<void> {
	const work = `${archive}.x`;
	mkdirSync(work, { recursive: true });
	try {
		// Windows 上必须显式用 System32 的 bsdtar:PATH 里排前面的往往是 Git Bash 的
		// GNU tar,它不认 zip("This does not look like a tar archive",实测)。手册库
		// 解压是同一条坑、同一个解法。
		const tar =
			process.platform === "win32"
				? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		await $`${tar} -xf ${archive} -C ${work}`.quiet();
		// 压缩包里是 ripgrep-<ver>-<target>/rg(.exe) 一层目录,递归找二进制。
		let found: string | undefined;
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const file = path.join(dir, entry);
				if (statSync(file).isDirectory()) walk(file);
				else if (entry === exe("rg")) found = file;
			}
		};
		walk(work);
		if (!found) throw new Error(`no ${exe("rg")} inside ${archive}`);
		copyFileSync(found, dest);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** 缺 pack 就对着本机 CubeMX db 解析。已经够数则跳过(解析全库要几分钟)。 */
async function ensureIrpacks(required: boolean): Promise<number> {
	mkdirSync(kernelData, { recursive: true });
	const have = countIrpacks(kernelData);
	if (have >= MIN_IRPACKS) {
		console.log(`  irpacks ${have} 个族(已解析,跳过导入)`);
		return have;
	}
	console.log(`\n[import] CubeMX db → ${kernelData} (现有 ${have},需要 ≥${MIN_IRPACKS})`);
	console.log("  装过 STM32CubeMX 会自动探测;否则设 STM32CK_CUBEMX_DB 或传 --cubemx-db");
	try {
		await $`cargo run --release -p stm32ck-importer -- --all --out data`.cwd(kernelDir);
	} catch (error) {
		if (!required && /no CubeMX db found/i.test(errorText(error))) {
			console.warn("  ↷ 跳过 irpack 导入:本机没有 CubeMX。STM32 配置不可用,网表/其它引擎不受影响。");
			return countIrpacks(kernelData);
		}
		throw error;
	}
	const after = countIrpacks(kernelData);
	if (after < MIN_IRPACKS) {
		throw new Error(
			`stm32ck-import 只写出 ${after} 个 irpack(期望 ≥${MIN_IRPACKS})。` +
				`装 STM32CubeMX,或设 STM32CK_CUBEMX_DB 指向其 db/ 目录(含 mcu/)。`,
		);
	}
	return after;
}

if (dist) {
	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/5] stm32-config-kernel — cargo build --release + import irpacks");
	await $`cargo build --release`.cwd(kernelDir);
	await ensureIrpacks(!allowMissingIrpacks);

	console.log("\n[2/5] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(path.join(distDir, "bin"), { recursive: true });
	mkdirSync(path.join(distDir, "data", "stm32"), { recursive: true });

	console.log("\n[3/5] freeze — PyInstaller(把解释器打进可执行文件,摆脱 venv 绝对路径)");
	const work = path.join(distDir, ".freeze");
	for (const [name, module] of PY_ENTRIES) {
		console.log(`  · ${name}`);
		await freeze(name, module, path.join(distDir, "bin", exe(name)), path.join(work, name));
	}
	rmSync(work, { recursive: true, force: true });

	console.log("\n[4/5] collect — 真文件,不是软链");
	copyFileSync(
		path.join(here, "stm32-config-kernel", "target", "release", exe("stm32kernel")),
		path.join(distDir, "bin", exe("stm32kernel")),
	);
	await ensureRipgrep(path.join(distDir, "bin"));
	// irpacks 是本机解析产物,打进包;fw/ 故意不带 —— 见文件头。
	let irpacks = 0;
	for (const entry of readdirSync(kernelData)) {
		if (!entry.endsWith(".irpack")) continue;
		copyFileSync(path.join(kernelData, entry), path.join(distDir, "data", "stm32", entry));
		irpacks++;
	}

	console.log("\n[5/5] logic-analyzer — yoma-la(cmake)+ DLL + res/decoders/python");
	let la: { bundled: boolean; dlls?: number; python?: boolean; why?: string } = { bundled: false };
	{
		const { tc, why } = findLaToolchain();
		if (!tc) {
			// Windows 是逻辑分析仪的主战场,CI 的 Windows 岗装了 MSYS2;这里缺工具链多半是 pacman 包名或
			// setup-msys2 变了 —— 和 irpack 同一条规矩:安装包不能默默少一个引擎。别的平台暂时只警告。
			if (process.platform === "win32" && !process.env.YOMA_LA_SKIP) {
				throw new Error(`yoma-la 构建不了:${why}。装 MSYS2 ucrt64(见 engines/logic-analyzer/CMakeLists.txt),或 YOMA_LA_SKIP=1 明确放弃逻辑分析仪。`);
			}
			console.warn(`  ↷ 跳过 yoma-la:${why}。逻辑分析仪工具在这份产物里不可用。`);
			la = { bundled: false, why };
		} else {
			const built = await buildLa(tc);
			const info = await installLa(tc, built, distDir, { dist: true });
			console.log(`  · ${info.dlls} 个 DLL,python ${info.pythonBundled ? "已打包" : "未打包"};${await selfCheckLa(distDir)}`);
			la = { bundled: true, dlls: info.dlls, python: info.pythonBundled };
		}
	}

	const { problems, notes } = auditDist(distDir);
	if (irpacks < MIN_IRPACKS) {
		const detail =
			`只收到 ${irpacks} 个 irpack(期望 ≥${MIN_IRPACKS})—— CubeMX 解析没跑完。` +
			`装 STM32CubeMX 或设 STM32CK_CUBEMX_DB,再跑 \`bun engines/build.ts --dist\`。`;
		if (allowMissingIrpacks) {
			notes.push(detail + "已显式允许缺 irpack:安装包里没有 STM32 配置数据。");
		} else {
			problems.push(detail);
		}
	}
	const manifest = {
		platform: process.platform,
		arch: process.arch,
		builtAt: new Date().toISOString(),
		irpacks,
		// fw 不在产物里:1.1GB(压缩后仍 ~174MB),而且只有 generate 用得到。
		firmware: "not-bundled",
		// 逻辑分析仪引擎:没工具链的构建机会缺它,这里必须写明,别让"少一个引擎"静默。
		la,
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

	console.log("\n[1/4] stm32-config-kernel — cargo build --release + import irpacks");
	await $`cargo build --release`.cwd(kernelDir);
	await ensureIrpacks(false);

	console.log("\n[2/4] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	console.log("\n[3/4] install — engines/bin + engines/data");
	const venvBin = path.join(here, "controller_map", ".venv", process.platform === "win32" ? "Scripts" : "bin");
	install(path.join(kernelDir, "target", "release", exe("stm32kernel")), path.join(here, "bin", exe("stm32kernel")), "file");
	for (const entry of ["controller_map", "board_ir", "connections"]) {
		install(path.join(venvBin, exe(entry)), path.join(here, "bin", exe(entry)), "file");
	}
	install(kernelData, path.join(here, "data", "stm32"), "dir");
	await ensureRipgrep(path.join(here, "bin"));

	console.log("\n[4/4] logic-analyzer — yoma-la");
	const { tc, why } = findLaToolchain();
	if (!tc) {
		console.warn(`  ↷ 跳过 yoma-la:${why}。la 工具不可用,其它引擎不受影响。`);
	} else {
		const built = await buildLa(tc);
		const info = await installLa(tc, built, here, { dist: false });
		console.log(`  · ${info.dlls} 个 DLL 拷到 bin/;${await selfCheckLa(here)}`);
	}
}

// doctor:每一行是工具运行时会解析到的真实路径(经由 engineBin,报告才不会和运行时漂移)。
// optional 的引擎缺席不算坏(本机没工具链是常态),但在的话也必须是 engineBin 能解析到的那份。
function probe(label: string, fn: () => string, opts: { optional?: boolean } = {}): [string, string, boolean | "skip"] {
	try {
		return [label, fn(), true];
	} catch (error) {
		const why = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
		return [label, opts.optional ? `未构建 — 跳过(${why})` : why, opts.optional ? "skip" : false];
	}
}

const at = { enginesDir: here };
const rows = [
	probe("stm32kernel", () => engineBin("stm32kernel", at)),
	probe("controller_map", () => engineBin("controller_map", at)),
	probe("board_ir", () => engineBin("board_ir", at)),
	probe("rg", () => engineBin("rg", at)),
	probe("yoma-la", () => engineBin("yoma-la", at), { optional: true }),
];

console.log("\n─ doctor ─────────────────────────────────────────────");
let bad = 0;
for (const [name, loc, ok] of rows) {
	if (ok === false) bad++;
	console.log(`  ${ok === true ? "✓" : ok === "skip" ? "↷" : "✗"} ${name.padEnd(16)} ${loc}`);
}

const irpackCount = countIrpacks(path.join(here, "data", "stm32"));
if (irpackCount >= MIN_IRPACKS) {
	console.log(`  ✓ ${"irpacks".padEnd(16)} ${irpackCount} families`);
} else {
	console.log(`  ↷ ${"irpacks".padEnd(16)} ${irpackCount} packs — STM32 配置跳过(需要本机 CubeMX)`);
}

if (bad === 0) {
	if (irpackCount >= MIN_IRPACKS) {
		console.log("\nAll good — the stm32config / netlist / flash tools will resolve these binaries.");
	} else {
		console.log("\nAll good — netlist engines ready. STM32 config skipped (no CubeMX / irpack).");
	}
} else {
	console.log(`\n${bad} item(s) missing — run \`bun engines/build.ts\` to build and install.`);
	process.exit(1);
}
