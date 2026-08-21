// yoma-la 的构建与安装,被 engines/build.ts 调用(也可单跑:bun engines/logic-analyzer/build.ts [--dist --out DIR]).
//
// 它和别的引擎不一样的地方,决定了这个文件为什么单独存在:
//   1. C 工程(CMake + glib/libusb/python3),Windows 上只能 MSYS2/ucrt64。没装工具链的机器
//      **跳过而不是失败**(像没有 CubeMX 时跳过 irpack 一样),但 manifest 里会写明 la 不在。
//   2. 产物不是一个文件:exe + 一串 DLL(glib / libusb / python3xx / winpthread …)+ 数据目录
//      (res/ 固件、decoders/ 150 个解码器、demo/ 样例)+ 分发时还要带 Python 标准库。
//      DLL 清单不写死:用 objdump 递归解析 exe 与打包的 .pyd 的导入表,只收 ucrt64/bin 里的。
//   3. 内嵌 CPython 找标准库靠 PYTHONHOME:引擎在 <decoders>/../python 存在时自动设它,
//      所以分发布局是 data/la/python/lib/python3.X/…;开发期不带,用 MSYS2 自己的。
//
// 布局(与 engines/ 其余部分同一套):
//   engines/bin/yoma-la.exe (+ *.dll)        engines/data/la/{res,decoders,demo[,python]}

import { $ } from "bun";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exe } from "@yoma/coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 自检钉死的数:demo 采集的 I²C 注解条数。vendored 的解码器升级后若变了,这里、smoke、测试一起改。 */
export const DEMO_I2C_ANNOTATIONS = 300;

export interface LaToolchain {
	cmake: string;
	ninja: string | undefined;
	cc: string;
	pkgConfig: string;
	objdump: string | undefined;
	/** Windows:MSYS2 ucrt64 的 bin,DLL 与 Python 都从这里拿 */
	msysBin: string | undefined;
	pythonLib: string | undefined;
}

/** 找工具链;找不到返回 null 并说明缺什么。 */
export function findLaToolchain(): { tc: LaToolchain | null; why: string } {
	if (process.platform === "win32") {
		const root = process.env.YOMA_LA_MSYS2 || process.env.MSYS2_ROOT || "C:\\msys64";
		const bin = path.join(root, "ucrt64", "bin");
		const cc = path.join(bin, "gcc.exe");
		if (!existsSync(cc)) return { tc: null, why: `没有 MSYS2 ucrt64(${cc} 不存在;设 YOMA_LA_MSYS2 指向 msys64 根目录)` };
		const pkgConfig = path.join(bin, "pkg-config.exe");
		if (!existsSync(pkgConfig)) return { tc: null, why: "MSYS2 里缺 pkgconf:pacman -S mingw-w64-ucrt-x86_64-pkgconf" };
		const cmake = existsSync(path.join(bin, "cmake.exe")) ? path.join(bin, "cmake.exe") : Bun.which("cmake");
		if (!cmake) return { tc: null, why: "没有 cmake(winget install Kitware.CMake 或 pacman -S mingw-w64-ucrt-x86_64-cmake)" };
		const ninja = existsSync(path.join(bin, "ninja.exe")) ? path.join(bin, "ninja.exe") : Bun.which("ninja");
		const pyLibs = existsSync(path.join(root, "ucrt64", "lib")) ? readdirSync(path.join(root, "ucrt64", "lib")).filter((d) => /^python3\.\d+$/.test(d)) : [];
		return {
			tc: {
				cmake, ninja: ninja ?? undefined, cc, pkgConfig,
				objdump: existsSync(path.join(bin, "objdump.exe")) ? path.join(bin, "objdump.exe") : undefined,
				msysBin: bin,
				pythonLib: pyLibs.length ? path.join(root, "ucrt64", "lib", pyLibs.sort().at(-1)!) : undefined,
			},
			why: "",
		};
	}
	const cmake = Bun.which("cmake"), pkgConfig = Bun.which("pkg-config"), cc = Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang");
	if (!cmake || !pkgConfig || !cc) return { tc: null, why: "需要 cmake + pkg-config + C 编译器(以及 glib-2.0 / libusb-1.0 / zlib / python3-embed 的开发包)" };
	return { tc: { cmake, ninja: Bun.which("ninja") ?? undefined, cc, pkgConfig, objdump: Bun.which("objdump") ?? undefined, msysBin: undefined, pythonLib: undefined }, why: "" };
}

/** cmake configure + build,返回 exe 路径。 */
export async function buildLa(tc: LaToolchain): Promise<string> {
	const buildDir = path.join(here, "build");
	const gen = tc.ninja ? ["-G", "Ninja"] : [];
	const args = ["-S", here, "-B", buildDir, ...gen, `-DCMAKE_C_COMPILER=${tc.cc}`, `-DPKG_CONFIG_EXECUTABLE=${tc.pkgConfig}`, "-DCMAKE_BUILD_TYPE=Release"];
	if (tc.ninja) args.push(`-DCMAKE_MAKE_PROGRAM=${tc.ninja}`);
	await $`${tc.cmake} ${args}`.quiet();
	await $`${tc.cmake} --build ${buildDir}`.quiet();
	const out = path.join(buildDir, exe("yoma-la"));
	if (!existsSync(out)) throw new Error(`构建完没有 ${out}`);
	return out;
}

/** 递归解析 PE 导入表,只收 msysBin 里的 DLL(系统 DLL 不收)。 */
export async function collectDlls(tc: LaToolchain, roots: string[]): Promise<string[]> {
	if (process.platform !== "win32" || !tc.objdump || !tc.msysBin) return [];
	const seen = new Set<string>();
	const queue = [...roots];
	while (queue.length) {
		const file = queue.pop()!;
		const out = await $`${tc.objdump} -p ${file}`.quiet().text();
		for (const m of out.matchAll(/DLL Name:\s*(\S+)/g)) {
			const name = m[1]!;
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			const cand = path.join(tc.msysBin, name);
			if (!existsSync(cand)) continue; // 系统 DLL(kernel32 等)
			seen.add(key);
			queue.push(cand);
		}
	}
	return [...seen].map((k) => path.join(tc.msysBin!, readdirSync(tc.msysBin!).find((f) => f.toLowerCase() === k)!));
}

/** 标准库里不带的东西:测试、GUI、打包器、IDE、自测扩展、构建配置。解码器只用纯 Python 标准库。 */
const PY_SKIP_DIRS = new Set(["test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "site-packages", "__pycache__", "lib2to3", "pydoc_data", "venv", "unittest", "lib-dynload"]);
const skipPython = (p: string) => {
	const base = path.basename(p);
	return !(PY_SKIP_DIRS.has(base) || /^config-3\./.test(base) || base.endsWith(".pyc"));
};
const PYD_SKIP = /^(_test|_tkinter|_curses|_sqlite3|_ssl|_ctypes_test|_interp|_remote_debugging|_lsprof|_multiprocessing|_overlapped|_asyncio|_xxtestfuzz|xxlimited|xxsubtype|_wmi|winsound|_zstd|_lzma|_bz2)/;

/**
 * 安装到 engines 运行时布局。dev:只装 exe + DLL + 数据(Python 用 MSYS2 的);
 * dist:再带上裁过的标准库与 .pyd,让引擎在没有 MSYS2 的机器上也能起 Python。
 */
export async function installLa(tc: LaToolchain, builtExe: string, root: string, opts: { dist: boolean }): Promise<{ dlls: number; pythonBundled: boolean }> {
	const binDir = path.join(root, "bin");
	const dataDir = path.join(root, "data", "la");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	copyFileSync(builtExe, path.join(binDir, exe("yoma-la")));

	const vendor = path.join(here, "vendor");
	for (const [src, dst] of [["res", "res"], ["libsigrokdecode4DSL/decoders", "decoders"], ["demo", "demo"]] as const) {
		rmSync(path.join(dataDir, dst), { recursive: true, force: true });
		cpSync(path.join(vendor, src), path.join(dataDir, dst), { recursive: true, filter: (p) => !/__pycache__|\.pyc$/.test(p) });
	}
	copyFileSync(path.join(vendor, "UPSTREAM.json"), path.join(dataDir, "UPSTREAM.json"));
	copyFileSync(path.join(here, "LICENSE"), path.join(dataDir, "LICENSE-GPLv3.txt"));

	let pyds: string[] = [];
	let pythonBundled = false;
	const pyHome = path.join(dataDir, "python");
	const pyPointer = path.join(dataDir, "python.home");
	rmSync(pyHome, { recursive: true, force: true });
	rmSync(pyPointer, { force: true });
	if (!opts.dist && process.platform === "win32" && tc.pythonLib) {
		// 开发期:libpython 从 engines/bin 加载后按 DLL 位置推 prefix、找不到标准库(实测
		// "Could not find platform independent libraries")。写一个 python.home 指到 MSYS2 的 ucrt64
		// 前缀,引擎启动时读它当 PYTHONHOME。**不用 junction**:packages/desktop/scripts/stage-engines.ts
		// 用 cpSync({dereference:true}) 实体化 engines/,junction 会把整个 ucrt64(1 GB+)卷进暂存目录。
		writeFileSync(pyPointer, `${path.dirname(path.dirname(tc.pythonLib))}\n`);
	}
	if (opts.dist && process.platform === "win32" && tc.pythonLib) {
		const ver = path.basename(tc.pythonLib); // python3.14
		const dst = path.join(dataDir, "python", "lib", ver);
		rmSync(path.join(dataDir, "python"), { recursive: true, force: true });
		cpSync(tc.pythonLib, dst, { recursive: true, filter: skipPython });
		const dyn = path.join(tc.pythonLib, "lib-dynload");
		if (existsSync(dyn)) {
			mkdirSync(path.join(dst, "lib-dynload"), { recursive: true });
			for (const f of readdirSync(dyn)) {
				if (!f.endsWith(".pyd") || PYD_SKIP.test(f)) continue;
				copyFileSync(path.join(dyn, f), path.join(dst, "lib-dynload", f));
				pyds.push(path.join(dst, "lib-dynload", f));
			}
		}
		pythonBundled = true;
	}

	const dlls = await collectDlls(tc, [builtExe, ...pyds]);
	for (const dll of dlls) copyFileSync(dll, path.join(binDir, path.basename(dll)));
	return { dlls: dlls.length, pythonBundled };
}

/** 装完自检:对着装好的产物跑一次 decode 解 demo,断言 I²C 注解条数。零硬件、确定性。 */
export async function selfCheckLa(root: string): Promise<string> {
	const bin = path.join(root, "bin", exe("yoma-la"));
	const demo = path.join(root, "data", "la", "demo", "logic", "protocol.demo");
	const r = await $`${bin} decode --in ${demo} --pd "i2c=1:i2c:scl=SCL:sda=SDA"`.quiet().nothrow();
	if (r.exitCode !== 0) throw new Error(`yoma-la decode 自检失败(exit ${r.exitCode}):${r.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
	const last = r.stdout.toString().trim().split("\n").at(-1) ?? "";
	const end = JSON.parse(last) as { annotations: number; ok: boolean };
	if (!end.ok || end.annotations !== DEMO_I2C_ANNOTATIONS) throw new Error(`yoma-la decode 自检:demo 的 I²C 注解应为 ${DEMO_I2C_ANNOTATIONS} 条,实得 ${end.annotations}`);
	return `decode demo → ${end.annotations} 条 I²C 注解`;
}

if (import.meta.main) {
	const dist = process.argv.includes("--dist");
	const at = process.argv.indexOf("--out");
	const root = at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]!) : path.resolve(here, "..");
	const { tc, why } = findLaToolchain();
	if (!tc) { console.error(`✗ ${why}`); process.exit(1); }
	console.log("[la] cmake build");
	const built = await buildLa(tc);
	console.log(`[la] install → ${root}`);
	const info = await installLa(tc, built, root, { dist });
	console.log(`[la] ${info.dlls} 个 DLL,python ${info.pythonBundled ? "已打包" : "用系统的"}`);
	console.log(`[la] ✓ ${await selfCheckLa(root)}`);
}
