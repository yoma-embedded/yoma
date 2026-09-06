/**
 * 索引器:语料根 → 抽取器(按生态分派)→ 盖语料戳 → 落盘 + 记账。离线运维工具,
 * 开发机与将来的服务器跑的是同一条路 —— 读侧(search/工具)永远只碰索引与账本,
 * 不碰语料文件。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { extractEspIdfExamples } from "./espidf.ts";
import { toPosix } from "./extract-util.ts";
import type { Ecosystem, ExampleEntry, ExamplesIndex, Tier } from "./schema.ts";
import { INDEX_SCHEMA_TAG } from "./schema.ts";
import { detectCubeFamily, extractStm32CubeExamples } from "./stm32cube.ts";
import { upsertSource, writeIndexFile } from "./store.ts";

/**
 * 语料检出的短 commit。显式传 process.env:bun 的 spawnSync 省略 env 时按进程
 * 启动那一刻解析(根 CLAUDE.md 的坑),显式传当前值是防御性的正确姿势。
 */
export function detectGitCommit(root: string): string | undefined {
	try {
		const result = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			env: process.env,
			timeout: 10_000,
		});
		if (result.status !== 0) return undefined;
		const commit = result.stdout.trim();
		return commit === "" ? undefined : commit;
	} catch {
		return undefined;
	}
}

export interface BuildIndexOptions {
	root: string;
	ecosystem: Ecosystem;
	/** 缺省 `<ecosystem>@<git 短 commit>`;没有 git 就落到日期 —— 语料必须可指认。 */
	corpusId?: string;
	/**
	 * 语料级默认分层,写进 header 供读侧继承。机械抽取器自己不判分层(路径结构说明不了
	 * 一份语料该不该参与芯片硬过滤),所以它只能由登记方给 —— 但**必须落进 header**:
	 * 只记在注册表里的话,检索侧一个字都读不到,注册表说它是 lib、检索却当它没标,
	 * 三处互相矛盾。
	 */
	tier?: Tier;
}

/**
 * 缺省语料名。Cube 固件包一包一个家族,名字必须带家族(stm32cube-f4),否则
 * F1/F4/H7 三份索引只剩 commit 能区分 —— 人读不出来,种子出处也指认不清。
 */
function defaultCorpusName(options: BuildIndexOptions): string {
	if (options.ecosystem === "stm32cube") {
		const family = detectCubeFamily(path.resolve(options.root));
		if (family) return `stm32cube-${family.replace(/^stm32/, "")}`;
	}
	return options.ecosystem;
}

export function buildIndex(options: BuildIndexOptions): ExamplesIndex {
	const root = path.resolve(options.root);
	const commit = detectGitCommit(root);
	const corpus =
		options.corpusId ?? `${defaultCorpusName(options)}@${commit ?? new Date().toISOString().slice(0, 10)}`;
	const raw = options.ecosystem === "esp-idf" ? extractEspIdfExamples(root) : extractStm32CubeExamples(root);
	const entries: ExampleEntry[] = raw.map((item) => ({
		id: `${corpus}/${item.path}`,
		corpus,
		ecosystem: options.ecosystem,
		...item,
	}));
	return {
		header: {
			schema: INDEX_SCHEMA_TAG,
			corpus,
			ecosystem: options.ecosystem,
			root: toPosix(root),
			commit,
			generatedAt: new Date().toISOString(),
			entries: entries.length,
			indexer: "mechanical",
			...(options.tier ? { tier: options.tier } : {}),
		},
		entries,
	};
}

export interface IndexCorpusResult {
	index: ExamplesIndex;
	file: string;
}

/** 建索引 + 落盘 + 语料根记进本机账本(seed 靠账本找语料)。 */
export function indexCorpus(options: BuildIndexOptions & { configDir?: string }): IndexCorpusResult {
	const index = buildIndex(options);
	const file = writeIndexFile(index, options.configDir);
	upsertSource(
		{ id: index.header.corpus, ecosystem: options.ecosystem, root: path.resolve(options.root) },
		options.configDir,
	);
	return { index, file };
}
