/**
 * generic 生态的 AI 索引器(PLAN-codelib-console D2/D11)。
 *
 * 任意代码树(不限 esp-idf/stm32cube)没有可机械判定的例程语义,所以条目本身
 * 也由模型决定:必填的「说明」(description)+ 树摘要 → deepseek 提议条目(整树一条
 * 或每个连贯子工程一条)→ **代码核验**(模型提议、代码裁决):
 *
 *   - path 必须真实存在于树内(幻觉即丢);
 *   - 去重、上限 200;
 *   - targets/peripherals 全小写,判断不了留空(空 = 检索不排除,schema 语义现成);
 *   - loc/files 由代码实测(模型说的不算);
 *   - buildable 恒 false + buildNote「generic 语料,未验证可编译」
 *     (沿用"可读 ≠ 可作底盘"的承诺);
 *   - 最后过 isExampleEntry 逐条终检,坏条即丢并计入日志。
 *
 * 模型调用是注入的(EnrichCompletion,与 enrich.ts 同一接口):本文件不 import
 * 模型层,测试注入假模型。产物落盘复用 store.ts 的 writeIndexFile —— 与机械
 * 抽取器的索引同格式,客户端零感知。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ExampleEntry, ExamplesIndex } from "./schema.ts";
import { INDEX_SCHEMA_TAG, isExampleEntry } from "./schema.ts";
import { writeIndexFile } from "./store.ts";
import { countLoc, walkFilesRelative } from "./extract-util.ts";
import type { EnrichCompletion } from "./enrich.ts";

/** 条目上限(PLAN D2)。 */
export const GENERIC_MAX_ENTRIES = 200;
/** 树摘要预算:超过即截断并如实 log,不静默截断。 */
export const SUMMARY_BUDGET_CHARS = 8000;
/** 关键文件名:摘要里单独列出的"这个文件很可能是入口/说明"文件。 */
const KEY_FILES = new Set([
	"readme.md", "readme", "readme.txt", "cmakelists.txt", "makefile", "sdkconfig.defaults",
	"idf_component.yml", "project.ini", "package.json", "pyproject.toml", "cargo.toml",
	"main.c", "main.cpp", "app.c", "app.cpp", "*.ioc",
]);

export interface GenericIndexOptions {
	root: string;
	corpusId: string;
	description: string;
	configDir?: string;
	complete: EnrichCompletion;
	model: string;
}

export interface GenericIndexResult {
	index: ExamplesIndex;
	file: string;
	/** 模型提议后被核验丢弃的条目数(幻觉路径/坏字段)。 */
	dropped: number;
	/** 摘要截断时记录丢了什么(无静默截断纪律)。 */
	summaryTruncated: string[];
}

function lineCount(abs: string): number {
	try {
		const text = readFileSync(abs, "utf8");
		return text.split(/\r?\n/).length;
	} catch {
		return 0;
	}
}

/** 树摘要:目录骨架 + 每目录文件数/总行数 + 关键文件名 + README 头部若干行。 */
export function buildTreeSummary(root: string, budget: number = SUMMARY_BUDGET_CHARS): { summary: string; truncated: string[] } {
	const truncated: string[] = [];
	const dirs = new Map<string, { files: number; lines: number; keyFiles: string[] }>();
	const readmes: Array<{ rel: string; head: string }> = [];

	const all = walkFilesRelative(root);
	for (const rel of all) {
		if (rel.includes("/.git/") || rel.startsWith(".git/")) continue;
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		const entry = dirs.get(dir) ?? { files: 0, lines: 0, keyFiles: [] };
		entry.files += 1;
		entry.lines += lineCount(path.join(root, rel));
		const base = rel.split("/").pop() ?? "";
		if (KEY_FILES.has(base.toLowerCase()) || base.toLowerCase().endsWith(".ioc")) {
			entry.keyFiles.push(base);
		}
		dirs.set(dir, entry);
		if (/readme/i.test(base)) {
			try {
				const text = readFileSync(path.join(root, rel), "utf8");
				readmes.push({ rel, head: text.split(/\r?\n/).slice(0, 8).join("\n") });
			} catch {
				// unreadable README (binary?) - skip
			}
		}
	}

	const lines: string[] = [];
	lines.push("目录骨架(文件数 / 总行数 / 关键文件):");
	for (const [dir, e] of [...dirs.entries()].sort()) {
		const key = e.keyFiles.length ? `  [${e.keyFiles.join(",")}]` : "";
		lines.push(`  ${dir || "."}/  ${e.files} 文件 / ${e.lines} 行${key}`);
	}
	lines.push("", "各 README 头部(供判断工程意图):");
	for (const r of readmes) {
		lines.push(`--- ${r.rel} ---\n${r.head}`);
	}

	let summary = lines.join("\n");
	while (summary.length > budget) {
		// 从后往前砍行,直到进预算;记录砍掉了什么。
		const dropped = summary.split("\n").pop() ?? "";
		summary = summary.split("\n").slice(0, -1).join("\n");
		truncated.push(dropped);
	}
	return { summary, truncated };
}

interface ModelProposal {
	entries?: Array<{
		path?: unknown;
		title?: unknown;
		summary?: unknown;
		targets?: unknown;
		peripherals?: unknown;
	}>;
}

function toLowerList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === "string" && v.trim() !== "") {
			const t = v.trim().toLowerCase();
			if (!out.includes(t)) out.push(t);
		}
	}
	return out;
}

function strOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * 模型提议 -> 代码核验 -> 索引。核验规则全部是确定性的(PLAN D2):
 * path 必须存在、去重、上限、小写化、loc/files 实测、buildable 恒 false。
 */
export async function indexGeneric(options: GenericIndexOptions): Promise<GenericIndexResult> {
	const root = path.resolve(options.root);

	const { summary, truncated } = buildTreeSummary(root);
	const prompt = [
		"你是嵌入式/软件代码库的索引员。下面是一个代码库的「说明」和「目录摘要」。",
		"请把它切成连贯的索引条目:每个可独立理解的工程/模块目录一条,或整树一条。",
		`最多 ${GENERIC_MAX_ENTRIES} 条。`,
		"",
		`【说明】${options.description}`,
		"",
		`【目录摘要】\n${summary}`,
		"",
		"输出严格 JSON(不要 markdown 围栏):{\"entries\":[{path, title, summary, targets, peripherals}]}",
		"- path: 相对语料根的目录或文件路径,必须真实存在于摘要中;",
		"- targets: 芯片/平台,全小写;不确定就留空数组;",
		"- peripherals: 外设/能力词,全小写;不确定就留空;",
		"- title/summary: 简短中文标题与一句话说明。",
	].join("\n");

	const raw = await options.complete(
		"你输出严格的 JSON,不输出任何其他文字。",
		prompt,
	);

	const index: ExamplesIndex = {
		header: {
			schema: INDEX_SCHEMA_TAG,
			corpus: options.corpusId,
			ecosystem: "generic",
			generatedAt: new Date().toISOString(),
			entries: 0,
		},
		entries: [],
	};
	const seen = new Set<string>();
	let dropped = 0;

	try {
		const parsed = JSON.parse(raw) as ModelProposal;
		const proposed = Array.isArray(parsed.entries) ? parsed.entries : [];
		for (const item of proposed) {
			if (index.entries.length >= GENERIC_MAX_ENTRIES) {
				dropped += 1;
				continue;
			}
			const rel = strOr(item.path, "");
			if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
				dropped += 1;
				continue;
			}
			const abs = path.join(root, rel);
			if (!existsSync(abs)) {
				dropped += 1;
				continue;
			}
			const key = rel.replace(/\/+$/, "");
			if (seen.has(key)) {
				dropped += 1;
				continue;
			}
			seen.add(key);
			const isDir = statSync(abs).isDirectory();
			const files = isDir ? walkFilesRelative(abs).length : 1;
			const loc = isDir
				? countLoc(walkFilesRelative(abs).map((f) => path.join(abs, f)))
				: lineCount(abs);
			const entry: ExampleEntry = {
				id: `${options.corpusId}/${key}`,
				corpus: options.corpusId,
				ecosystem: "generic",
				path: key,
				name: key.split("/").pop() || key,
				title: strOr(item.title, key.split("/").pop() || key),
				summary: strOr(item.summary, ""),
				targets: toLowerList(item.targets),
				peripherals: toLowerList(item.peripherals),
				buildable: false,
				buildNote: "generic 语料,未验证可编译",
				loc,
				files,
				extractorVersion: 1,
			};
			if (!isExampleEntry(entry)) {
				dropped += 1;
				continue;
			}
			index.entries.push(entry);
		}
	} catch {
		// JSON 整体解析失败:没有条目可核验,如实反映(dropped=0, entries=0)。
	}

	index.header.entries = index.entries.length;
	const file = writeIndexFile(index, options.configDir);
	return { index, file, dropped, summaryTruncated: truncated };
}
