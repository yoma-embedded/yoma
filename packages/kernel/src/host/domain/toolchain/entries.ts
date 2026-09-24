/** 路径记录只说明用户保存了什么;入口定位必须复核文件类型和声明名。 */
import { statSync } from "node:fs";
import path from "node:path";
import { expandGlobPath, findOnPath, withPath } from "./locations.ts";
import type { ToolSpec } from "./schema.ts";

export function pathType(value: string): "file" | "dir" | undefined {
	try {
		const stat = statSync(value);
		return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : undefined;
	} catch {
		return undefined;
	}
}

export interface DirectoryRoot {
	/** 归一后的安装根;记录值不存在、或是个文件且没有标志文件可循时为空。 */
	root?: string;
	/** 标志文件在 root 下找到了 —— 只有声明了 marker 才可能为真。 */
	verified: boolean;
}

const MAX_CLIMB = 6;

function markerExists(root: string, marker: string, env: NodeJS.ProcessEnv): boolean {
	const segments = marker.split(/[\\/]/).filter(Boolean);
	const name = segments.pop();
	if (!name) return false;
	// 末段走 findOnPath:PATHEXT 展开与 bin 同一套(Zephyr 旧版 SDK 的标志是 gcc,Windows 上带 .exe)。
	const hit = findOnPath(name, withPath(env, [path.join(root, ...segments)]));
	return hit !== undefined && pathType(hit) === "file";
}

/**
 * dir 型工具:把一条记录值(目录或文件)归一成安装根。**所有来源共用这一个函数** —— 账本、
 * 环境变量、安装器登记、已知位置、用户刚 set 的路径。2026-09-16 加 dir 分支时只改了解析器
 * ("记录值是目录才算 configured"),而已知位置档与 set 仍按 bin 名产出**文件**,两边各说各话:
 * IDF 装在默认位置也永远 RECORDED,用户按位置表的写法贴 `<根>\tools` 同样。
 *
 * 有 marker:从记录值(文件取其所在目录)往上爬,第一个含标志文件的目录就是根 —— 贴 `<根>`、
 * `<根>\tools`、`<根>\tools\idf.py` 三种写法落到同一个答案。爬多高与 marker 的段数无关(Zephyr 的
 * 标志是根上的 sdk_version,而用户贴的可能是三层深的 `gnu\arm-zephyr-eabi\bin`);"最近的、含标志文件的
 * 祖先"在语义上只可能是这条路径所在的那个安装,MAX_CLIMB 只是给 IO 封个顶。爬不到就原样返回目录、
 * verified:false,由调用方决定话怎么说(显式记录 → RECORDED 并点名缺哪个文件;自动发现 → 不算命中)。
 * 没有 marker:目录原样算数(STM32CubeMX 这类,内容由消费它的资源模块验),文件不算。
 */
export function directoryRoot(spec: ToolSpec, value: string, env: NodeJS.ProcessEnv): DirectoryRoot {
	const type = pathType(value);
	if (type === undefined) return { verified: false };
	if (!spec.marker) return type === "dir" ? { root: value, verified: false } : { verified: false };
	let candidate = type === "file" ? path.dirname(value) : value;
	for (let i = 0; i <= MAX_CLIMB; i++) {
		if (markerExists(candidate, spec.marker, env)) return { root: candidate, verified: true };
		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}
	return type === "dir" ? { root: value, verified: false } : { verified: false };
}

const MAX_LAYOUT_CLIMB = 3;

/**
 * exe 型、声明了 binDirs 的工具(Keil):从 start 往上逐层,在每一层下展开 binDirs,第一层里真有声明的
 * 可执行文件的就是这个安装的根,返回那一层展开出的目录。停在最近的一层:再往上爬可能爬进同一个盘上
 * 并排的另一份安装。要求"真有声明的程序"而不只是"目录在":`ARM\BIN` 这种名字太普通,光看目录会认错根。
 * 爬 3 层够从 `<根>\ARM\ARMCLANG\bin` 回到根;这是 2026-09-24 那台机器上用户贴 `Keil_v5\UV4` 永远
 * "未找到入口"的修复 —— 从前只查 [目录, 目录\bin] 两处。
 */
export function layoutDirs(spec: ToolSpec, start: string, env: NodeJS.ProcessEnv): string[] {
	const names = spec.bin ?? [];
	if (!spec.binDirs?.length || names.length === 0) return [];
	let base = start;
	for (let i = 0; i <= MAX_LAYOUT_CLIMB; i++) {
		const dirs = spec.binDirs.flatMap((rel) => expandGlobPath(path.join(base, rel)));
		const search = withPath(env, dirs);
		if (dirs.length > 0 && names.some((name) => findOnPath(name, search) !== undefined)) return dirs;
		const parent = path.dirname(base);
		if (parent === base) break;
		base = parent;
	}
	return [];
}

/**
 * 保留显式命名的文件映射;目录记录/单个入口的同目录兄弟文件按声明重新定位;声明了安装布局
 * (binDirs)的,记录落在安装树里的任何一层都往上找回编译器所在的目录 —— 包括用"浏览…"挑了一个
 * 不是声明入口的程序(Keil 用户挑的是 UV4.exe)。
 */
export function executableEntries(
	spec: ToolSpec,
	recorded: Record<string, string>,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	if (spec.pathKind === "dir") return {};
	const names = spec.bin ?? [];
	const files: Record<string, string> = {};
	const dirs: string[] = [];
	for (const [name, value] of Object.entries(recorded)) {
		const type = pathType(value);
		if (type === "dir") dirs.push(value, path.join(value, "bin"), ...layoutDirs(spec, value, env));
		if (type !== "file") continue;
		const declared = names.find((candidate) =>
			process.platform === "win32" ? candidate.toLowerCase() === name.toLowerCase() : candidate === name,
		);
		if (names.length === 0 || declared) {
			files[declared ?? name] = value;
			dirs.push(path.dirname(value));
		}
		dirs.push(...layoutDirs(spec, path.dirname(value), env));
	}
	const searchEnv = withPath(env, [...new Set(dirs)]);
	for (const name of names) {
		const value = files[name] ?? findOnPath(name, searchEnv);
		if (value && pathType(value) === "file") files[name] = value;
	}
	return files;
}
