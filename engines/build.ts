// Build capability executables and public runtime assets. STM32 user resources
// are discovered and prepared on the user's machine, never during app builds.
//   tsx engines/build.ts           # build + install + doctor
//   tsx engines/build.ts --check   # doctor only
//   tsx engines/build.ts --dist    # 产出可分发的自包含产物到 engines/dist/
// Needs cargo (stm32-config-kernel) and uv (controller_map). logic-analyzer (yoma-la, C/CMake,
// Windows 上要 MSYS2 ucrt64)没有工具链时跳过,但 manifest 里会写明。
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
// STM32 CubeMX 数据库、irpacks、HAL/CMSIS 都属于用户本机资源,不上传、不随包交付。
// 安装包只交付 stm32kernel + stm32ck-import;内核在使用时定位本机 CubeMX 并生成缓存。
// 开发者若要单独导入,显式运行 bin/stm32ck-import --all --out <本地目录>。

import { $, which } from "../scripts/shell.ts";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 经由工具同一套解析代码取路径,报告不会和运行时行为漂移。
import { engineBin, exe } from "../packages/kernel/src/host/domain/engines.ts";
import { buildLa, findLaToolchain, installLa, selfCheckLa } from "./logic-analyzer/build.ts";
import { assertNoStm32Data, STM32_RESOURCE_POLICY } from "./distribution.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const dist = process.argv.includes("--dist");
const rgOnly = process.argv.includes("--rg-only");
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
	if (!which(cmd)) throw new Error(`\`${cmd}\` not found on PATH — ${hint}`);
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
	await $`uv run --with pyinstaller pyinstaller --onefile --clean --noconfirm --runtime-hook ${path.join(project, "utf8_stdio.py")} --distpath ${path.join(work, "out")} --workpath ${path.join(work, "build")} --specpath ${work} --name ${name} --paths . ${shim}`.cwd(
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
	const onPath = which("rg");
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

if (dist) {
	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/5] stm32-config-kernel — cargo build --release (kernel + local importer)");
	await $`cargo build --release`.cwd(kernelDir);

	console.log("\n[2/5] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(path.join(distDir, "bin"), { recursive: true });
	mkdirSync(path.join(distDir, "data"), { recursive: true });

	console.log("\n[3/5] freeze — PyInstaller(把解释器打进可执行文件,摆脱 venv 绝对路径)");
	const work = path.join(distDir, ".freeze");
	for (const [name, module] of PY_ENTRIES) {
		console.log(`  · ${name}`);
		await freeze(name, module, path.join(distDir, "bin", exe(name)), path.join(work, name));
	}
	rmSync(work, { recursive: true, force: true });

	console.log("\n[4/5] collect — 真文件,不是软链");
	for (const name of ["stm32kernel", "stm32ck-import"]) {
		copyFileSync(path.join(kernelDir, "target", "release", exe(name)), path.join(distDir, "bin", exe(name)));
	}
	await ensureRipgrep(path.join(distDir, "bin"));

	console.log("\n[5/5] logic-analyzer — yoma-la(cmake)+ DLL + res/decoders/python");
	let la: { bundled: boolean; dlls?: number; python?: boolean; why?: string } = { bundled: false };
	if (process.platform !== "win32") {
		// 可分发的 yoma-la 目前只有 Windows 一条路:installLa 只会收 MinGW 的 DLL 与裁过的 Python 标准库。
		// macOS / Linux 上构建机**有**工具链时照样编得出来、自检也过,但产物链着构建机的
		// /opt/homebrew/…/libglib-2.0.dylib 与系统 Python —— 拷到用户机器上是 dyld 报错,而 la 工具
		// 会把它说成"引擎崩了",不是那句干净的"这份安装里没有逻辑分析仪引擎"。所以分发时明确跳过,
		// 等 dylib 收集 + install_name_tool + 标准库随包做完再放开。开发期(非 --dist)不受影响。
		const why = `${process.platform} 上 yoma-la 的可分发打包还没做(动态库与 Python 标准库不随包)`;
		console.warn(`  ↷ 跳过 yoma-la:${why}。逻辑分析仪工具在这份产物里不可用。`);
		la = { bundled: false, why };
	} else {
		const { tc, why } = findLaToolchain();
		if (!tc) {
			// Windows 是逻辑分析仪的主战场,CI 的 Windows 岗装了 MSYS2;这里缺工具链多半是 pacman 包名或
			// setup-msys2 变了 —— 安装包不能默默少一个引擎。
			if (!process.env.YOMA_LA_SKIP) {
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
	assertNoStm32Data(distDir);
	const manifest = {
		platform: process.platform,
		arch: process.arch,
		builtAt: new Date().toISOString(),
		stm32: STM32_RESOURCE_POLICY,
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
	console.log("  STM32 数据:用户本机 CubeMX → 本地缓存,不随引擎分发");
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

if (rgOnly) {
	// CI 的测试岗只要 rg(grep / find 工具的集成用例要真跑它),不装 Rust / uv / CMake。
	await ensureRipgrep(path.join(here, "bin"));
	process.exit(0);
}

if (!checkOnly) {
	await need("cargo", "install Rust via https://rustup.rs");
	await need("uv", "install uv via https://docs.astral.sh/uv/getting-started/installation/");

	console.log("\n[1/4] stm32-config-kernel — cargo build --release (kernel + local importer)");
	await $`cargo build --release`.cwd(kernelDir);

	console.log("\n[2/4] controller_map — uv sync");
	await $`uv sync`.cwd(path.join(here, "controller_map"));

	console.log("\n[3/4] install — engines/bin + engines/data");
	const venvBin = path.join(here, "controller_map", ".venv", process.platform === "win32" ? "Scripts" : "bin");
	for (const name of ["stm32kernel", "stm32ck-import"]) {
		install(path.join(kernelDir, "target", "release", exe(name)), path.join(here, "bin", exe(name)), "file");
	}
	for (const entry of ["controller_map", "board_ir", "connections"]) {
		install(path.join(venvBin, exe(entry)), path.join(here, "bin", exe(entry)), "file");
	}
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
	probe("stm32ck-import", () => engineBin("stm32ck-import", at)),
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

console.log("  STM32 数据在使用时从用户本机 CubeMX 准备;引擎构建不读取数据库或固件。");

if (bad === 0) {
	console.log("\nAll good — engine executables ready; STM32 user resources are checked when requested.");
} else {
	console.log(`\n${bad} item(s) missing — run \`tsx engines/build.ts\` to build and install.`);
	process.exit(1);
}
