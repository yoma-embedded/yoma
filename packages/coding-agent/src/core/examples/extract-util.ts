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
export interface WalkResult {
	files: string[];
	/**
	 * 撞上限提前停了 —— 树里还有没走到的东西。
	 *
	 * 这个字段是本函数存在两个版本的**唯一理由**。从前它只是停下来,不说自己停了,
	 * 于是"这棵树就这么大"和"我只看了前 2000 个"在返回值上完全一样。遍历是字典序
	 * DFS,所以被吃掉的永远是名字靠后的那半:Cube 固件包会在 `Drivers/` 里就把名额
	 * 用光,`Projects/` 一个文件都进不来 —— 而调用方一无所知。
	 *
	 * 「静默停下」比「停得早」危险得多:停得早只是少了点东西,静默停下会让人拿着
	 * 一份残缺的输入去推翻别的结论。这和摘要预算 8000 吃掉整个 examples 段是同一条
	 * 教训,只是藏在更下面一层。
	 */
	truncated: boolean;
}

/** 带截断信号的遍历。新代码用它;`walkFilesRelative` 是它的薄壳,保住老调用点。 */
export function walkFilesCapped(root: string, maxFiles = 2000): WalkResult {
	const out: string[] = [];
	const stack: string[] = [""];
	let truncated = false;
	while (stack.length > 0 && out.length < maxFiles) {
		const rel = stack.pop() as string;
		const abs = rel === "" ? root : `${root}/${rel}`;
		const { dirs, files } = listDirNames(abs);
		for (const name of files) {
			// 先判后推:恰好等于上限且树里真的就这么多时,不该谎报截断。
			if (out.length >= maxFiles) {
				truncated = true;
				break;
			}
			out.push(rel === "" ? name : `${rel}/${name}`);
		}
		// 逆序压栈让弹出顺序保持字典序 —— 与上面的 sort 一起保证确定性。
		for (let i = dirs.length - 1; i >= 0; i--) {
			const name = dirs[i];
			if (name === ".git" || name === "build" || name === "managed_components") continue;
			stack.push(rel === "" ? name : `${rel}/${name}`);
		}
	}
	// 还有目录没弹完 = 被上限拦下的,不是走完的。
	if (stack.length > 0) truncated = true;
	return { files: out, truncated };
}

export function walkFilesRelative(root: string, maxFiles = 2000): string[] {
	return walkFilesCapped(root, maxFiles).files;
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
