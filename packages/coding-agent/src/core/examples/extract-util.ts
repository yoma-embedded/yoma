/**
 * 抽取器共用的小件:容错读、目录枚举、行数统计、路径正斜杠化。全部同步 IO ——
 * 索引器是离线运维工具,一次跑到底,简单与可预期赢过吞吐。
 */

import { readdirSync, readFileSync } from "node:fs";

export function readTextIfExists(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export interface DirEntryNames {
	dirs: string[];
	files: string[];
}

/** 枚举一层,失败当空目录;名字排好序 —— 索引产出必须确定,与遍历顺序无关。 */
export function listDirNames(dir: string): DirEntryNames {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		const dirs = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const files = entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
		return { dirs, files };
	} catch {
		return { dirs: [], files: [] };
	}
}

/** 递归收文件的相对路径(正斜杠),带上限 —— 语料里个别目录大得离谱,索引不陪它玩。 */
export function walkFilesRelative(root: string, maxFiles = 2000): string[] {
	const out: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0 && out.length < maxFiles) {
		const rel = stack.pop() as string;
		const abs = rel === "" ? root : `${root}/${rel}`;
		const { dirs, files } = listDirNames(abs);
		for (const name of files) {
			out.push(rel === "" ? name : `${rel}/${name}`);
			if (out.length >= maxFiles) break;
		}
		// 逆序压栈让弹出顺序保持字典序 —— 与上面的 sort 一起保证确定性。
		for (let i = dirs.length - 1; i >= 0; i--) {
			const name = dirs[i];
			if (name === ".git" || name === "build" || name === "managed_components") continue;
			stack.push(rel === "" ? name : `${rel}/${name}`);
		}
	}
	return out;
}

const SOURCE_EXTENSIONS = [".c", ".cc", ".cpp", ".h", ".hpp"];

export function isSourceFile(name: string): boolean {
	return SOURCE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

/** 粗行数:读得出来的源码文件行数之和 —— 小种子偏好的依据,不追求精确。 */
export function countLoc(files: string[]): number {
	let total = 0;
	for (const file of files) {
		const text = readTextIfExists(file);
		if (text === undefined) continue;
		total += text.split("\n").length;
	}
	return total;
}

export function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}

export function truncateText(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** 语料里抽出来的、还没盖语料戳的条目 —— indexer 负责补 id/corpus/ecosystem。 */
export interface RawExample {
	path: string;
	name: string;
	title?: string;
	summary?: string;
	targets: string[];
	board?: string;
	peripherals: string[];
	deps?: string[];
	configKeys?: string[];
	acceptance?: { kind: "pytest"; path: string };
	buildable: boolean;
	buildNote?: string;
	license?: string;
	loc: number;
	files: number;
	extractorVersion: number;
}
