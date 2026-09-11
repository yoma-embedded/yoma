/**
 * 种子:把选中的例程拷进工作区,并留下可提交的出处(provenance)。
 *
 * 语料侧访问直用 node:fs:语料根来自本机账本(sources.json),是本机事实,不属于
 * 会话的执行环境 —— 远程语料形态落地时,换掉的是"从账本 root 拷"这一段(变成
 * 下载到缓存再拷),工作区侧与出处格式不动。
 */

import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExampleEntry } from "./schema.ts";

export const SEED_SCHEMA_TAG = "yoma/seed@1";

export interface SeedProvenance {
	schema: typeof SEED_SCHEMA_TAG;
	id: string;
	corpus: string;
	/** 语料检出的短 commit(索引 header 里的那个)—— 种子要能指认到确切版本。 */
	commit?: string;
	sourcePath: string;
	seededAt: string;
}

export const SEED_PROVENANCE_FILE = ".yoma-seed.json";

/** 拷贝时排除:构建产物、按机器生成的 sdkconfig(保留 sdkconfig.defaults)、git 元数据。 */
export function shouldCopy(relPosix: string): boolean {
	const segments = relPosix.split("/");
	if (segments.includes("build") || segments.includes("managed_components") || segments.includes(".git")) {
		return false;
	}
	const base = segments[segments.length - 1];
	if (base === "sdkconfig" || base === "sdkconfig.old") return false;
	return true;
}

export interface SeedResult {
	dest: string;
	provenance: SeedProvenance;
}

/**
 * 目标目录必须不存在或为空 —— 种子不覆盖任何东西,宁可让模型换个目标名。
 * 出处文件写在种子根,**应当随工程提交**:它回答"这个工程从哪个语料哪个版本长出来的"。
 */
export function seedExample(entry: ExampleEntry, corpusRoot: string, dest: string, commit?: string): SeedResult {
	const source = path.join(corpusRoot, ...entry.path.split("/"));
	if (!existsSync(source)) {
		throw new Error(`例程目录不存在:${source} —— 语料被移动或删除,重跑 CLI index 重建账本`);
	}
	if (existsSync(dest) && readdirSync(dest).length > 0) {
		throw new Error(`目标目录非空:${dest} —— 种子不覆盖,换一个目标目录`);
	}
	cpSync(source, dest, {
		recursive: true,
		filter: (src) => {
			const rel = path.relative(source, src).replaceAll("\\", "/");
			return rel === "" || shouldCopy(rel);
		},
	});
	const provenance: SeedProvenance = {
		schema: SEED_SCHEMA_TAG,
		id: entry.id,
		corpus: entry.corpus,
		commit,
		sourcePath: entry.path,
		seededAt: new Date().toISOString(),
	};
	// 出处文件不走原子写:目标目录刚由本次调用创建,没有并发者。
	writeFileSync(path.join(dest, SEED_PROVENANCE_FILE), `${JSON.stringify(provenance, null, "\t")}\n`, "utf8");
	return { dest, provenance };
}
