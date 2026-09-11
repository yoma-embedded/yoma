/**
 * 例程索引的落盘层:`<configDir>/examples/` 下一份本机语料账本(sources.json)加
 * 每语料一个 JSONL 索引。全部是缓存语义 —— 读不出来当空/当没有,重建的代价只是
 * 重跑一遍 CLI index,抛异常反而把纯缓存变成新的失败点(toolchain/ledger.ts 的
 * 同一套纪律,原子写/容错读/同步 IO 的理由那边写透了,这里不复述)。
 *
 * configDir 必须可注入,默认值只在没传时求值:Bun 的 homedir() 进程启动即定死,
 * 测试一律显式传 mkdtemp 目录(根 CLAUDE.md 踩过的坑)。
 *
 * 远程语料的接缝就在这一层:sources.json 的 root 今天是本机目录,服务器形态是
 * url + 本机缓存 —— search 只读索引不碰语料文件,要改的只有 root 的解析。
 */

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
	type EnrichmentRecord,
	parseEnrichmentLines,
	serializeEnrichmentRecord,
} from "./enrich-schema.ts";
import {
	type CorpusSource,
	corpusSlug,
	emptySources,
	type ExamplesIndex,
	type ExamplesSources,
	parseIndex,
	parseSources,
	serializeIndex,
	SOURCES_SCHEMA_TAG,
} from "./schema.ts";

/** 与 kernel `host/auth.ts` 的 `yomaConfigDir()` 同一个目录 —— 漂移只能靠对照,见 ledger.ts 文件头。 */
function defaultConfigDir(): string {
	return path.join(homedir(), ".yoma");
}

export function examplesDir(configDir: string = defaultConfigDir()): string {
	return path.join(configDir, "examples");
}

export function sourcesPath(configDir?: string): string {
	return path.join(examplesDir(configDir), "sources.json");
}

export function indexDir(configDir?: string): string {
	return path.join(examplesDir(configDir), "index");
}

export function indexPathFor(corpusId: string, configDir?: string): string {
	return path.join(indexDir(configDir), `${corpusSlug(corpusId)}.jsonl`);
}

function readTextOrUndefined(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** 临时名带 pid+随机数再 rename —— 并发写各自完整落地,谁后到听谁的,不出半个文件。 */
export function writeTextAtomic(file: string, text: string): void {
	const dir = path.dirname(file);
	mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${randomUUID()}.tmp`);
	let renamed = false;
	try {
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, file);
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// 清理失败不掩盖原始错误。
			}
		}
	}
}

// ─── 语料账本 ──────────────────────────────────────────────────────────────────

export function readSources(configDir?: string): ExamplesSources {
	const text = readTextOrUndefined(sourcesPath(configDir));
	if (text === undefined) return emptySources();
	try {
		return parseSources(JSON.parse(text));
	} catch {
		return emptySources();
	}
}

/** 按 id 覆盖或追加一条语料。读改写整份文件 —— 文件小,简单赢。 */
export function upsertSource(source: CorpusSource, configDir?: string): void {
	const current = readSources(configDir);
	const corpora = [...current.corpora.filter((item) => item.id !== source.id), source];
	corpora.sort((a, b) => a.id.localeCompare(b.id));
	const next: ExamplesSources = { schema: SOURCES_SCHEMA_TAG, corpora };
	writeTextAtomic(sourcesPath(configDir), `${JSON.stringify(next, null, "\t")}\n`);
}

export function findSource(corpusId: string, configDir?: string): CorpusSource | undefined {
	return readSources(configDir).corpora.find((item) => item.id === corpusId);
}

// ─── 远程语料的本机缓存(cache/ + downloads/)──────────────────────────────────
//
// 布局:<configDir>/examples/cache/<slug>/ 是解压后的语料树 —— 对远程语料它就是
// root;downloads/ 放在途与已下 archive。标记文件 .corpus.json 落在缓存树根部,
// 记下载完成那一刻的 archiveSha256:没有它(或对不上)的缓存树视为不完整,
// 宁可重下也不把半个语料当整份。

export function cacheDir(configDir?: string): string {
	return path.join(examplesDir(configDir), "cache");
}

export function corpusCacheDir(corpusId: string, configDir?: string): string {
	return path.join(cacheDir(configDir), corpusSlug(corpusId));
}

export function downloadsDir(configDir?: string): string {
	return path.join(examplesDir(configDir), "downloads");
}

const CORPUS_MARKER_TAG = "yoma/corpus-cache@1";

export interface CorpusMarker {
	schema: typeof CORPUS_MARKER_TAG;
	id: string;
	commit?: string;
	archiveSha256: string;
	extractedAt: string;
}

function corpusMarkerPath(corpusId: string, configDir?: string): string {
	return path.join(corpusCacheDir(corpusId, configDir), ".corpus.json");
}

export function readCorpusMarker(corpusId: string, configDir?: string): CorpusMarker | undefined {
	const text = readTextOrUndefined(corpusMarkerPath(corpusId, configDir));
	if (text === undefined) return undefined;
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return undefined;
		const marker = raw as Record<string, unknown>;
		if (marker.schema !== CORPUS_MARKER_TAG) return undefined;
		if (typeof marker.id !== "string" || typeof marker.archiveSha256 !== "string") return undefined;
		return {
			schema: CORPUS_MARKER_TAG,
			id: marker.id,
			commit: typeof marker.commit === "string" ? marker.commit : undefined,
			archiveSha256: marker.archiveSha256,
			extractedAt: typeof marker.extractedAt === "string" ? marker.extractedAt : "",
		};
	} catch {
		return undefined;
	}
}

export function writeCorpusMarker(marker: CorpusMarker, configDir?: string): void {
	writeTextAtomic(corpusMarkerPath(marker.id, configDir), `${JSON.stringify(marker, null, "\t")}\n`);
}

/**
 * 一份语料在这台机器上的实际可用形态 —— findSource 的"三态"版:
 *
 *   1. 本机 root 存在 → root 指它(本机有的东西不走网络,与账本注释同一纪律);
 *   2. 缓存树完整(标记的 sha 与账本 remote 的一致)→ root 指 cache/<slug>;
 *   3. 都没有 → root 为 undefined:索引可查,但 seed/读代码前要先 sync --code。
 *
 * 标记 sha 对不上不算第 2 态:id 内嵌 commit,同一 id 的字节不该变,对不上说明
 * 缓存坏了或账本和缓存来自不同的服务器状态 —— 都该重下,而不是将就着用。
 */
export interface ResolvedCorpus {
	source: CorpusSource;
	/** 实际可用的语料根;materialized=false 时 undefined。 */
	root?: string;
	/** root 指向的是远程缓存而不是本机检出。 */
	fromCache: boolean;
	remote?: CorpusSource["remote"];
}

export function resolveCorpus(corpusId: string, configDir?: string): ResolvedCorpus | undefined {
	const source = findSource(corpusId, configDir);
	if (!source) return undefined;
	if (source.root.trim() !== "" && existsSync(source.root)) {
		return { source, root: source.root, fromCache: false, remote: source.remote };
	}
	if (source.remote) {
		const marker = readCorpusMarker(corpusId, configDir);
		if (marker && marker.archiveSha256 === source.remote.archiveSha256) {
			return { source, root: corpusCacheDir(corpusId, configDir), fromCache: true, remote: source.remote };
		}
		return { source, fromCache: false, remote: source.remote };
	}
	// 账本里有 root 但目录没了(移动/删除过):与"没记账"同样对待,让上层给出人话。
	return { source, fromCache: false };
}

// ─── 索引文件 ──────────────────────────────────────────────────────────────────

/** 写索引,返回落盘路径。 */
export function writeIndexFile(index: ExamplesIndex, configDir?: string): string {
	const file = indexPathFor(index.header.corpus, configDir);
	writeTextAtomic(file, serializeIndex(index));
	return file;
}

export function readIndexFile(corpusId: string, configDir?: string): ExamplesIndex | undefined {
	const text = readTextOrUndefined(indexPathFor(corpusId, configDir));
	if (text === undefined) return undefined;
	return parseIndex(text);
}

// ─── 富化文件(enrich/<slug>.jsonl)────────────────────────────────────────────
//
// 与索引分开落盘:索引是脚本秒级重建的缓存,富化是花过钱的模型产物,重建索引不许
// 冲掉它。逐行自描述、只追加 —— 断点续跑天然成立(缺哪条补哪条),坏行只废那一行。

export function enrichDir(configDir?: string): string {
	return path.join(examplesDir(configDir), "enrich");
}

export function enrichPathFor(corpusId: string, configDir?: string): string {
	return path.join(enrichDir(configDir), `${corpusSlug(corpusId)}.jsonl`);
}

export function readEnrichmentRecords(corpusId: string, configDir?: string): EnrichmentRecord[] {
	const text = readTextOrUndefined(enrichPathFor(corpusId, configDir));
	if (text === undefined) return [];
	return parseEnrichmentLines(text);
}

/**
 * 追加一条富化记录。单进程内管线是逐条 await 后追加,行不交错;跨进程并发重富化
 * 极端下可能撕一行 —— 容错读会丢那一行,重跑 enrich 补上,代价与纪律同索引。
 */
export function appendEnrichmentRecord(record: EnrichmentRecord, configDir?: string): void {
	const file = enrichPathFor(record.corpus, configDir);
	mkdirSync(path.dirname(file), { recursive: true });
	appendFileSync(file, serializeEnrichmentRecord(record), "utf8");
}

/**
 * 一份索引的有效富化:commit 与索引 header 一致才算数(语料换版本后旧卡片按陈旧
 * 跳过,宁缺毋错)。同 id 多条取最后一条 —— 重富化就是"再追加一行"。
 */
export function enrichmentMapFor(index: ExamplesIndex, configDir?: string): Map<string, EnrichmentRecord> {
	const map = new Map<string, EnrichmentRecord>();
	for (const record of readEnrichmentRecords(index.header.corpus, configDir)) {
		if (record.commit !== index.header.commit) continue;
		map.set(record.id, record);
	}
	return map;
}

/** 多份索引合一张富化表 —— 工具层(search/info/preflight)按条目 id 直查。 */
export function enrichmentMapForAll(indexes: ExamplesIndex[], configDir?: string): Map<string, EnrichmentRecord> {
	const map = new Map<string, EnrichmentRecord>();
	for (const index of indexes) {
		for (const [id, record] of enrichmentMapFor(index, configDir)) map.set(id, record);
	}
	return map;
}

/**
 * 枚举索引目录下所有能读出来的索引。以目录为准而不是以账本为准:账本一条坏了不该
 * 让对应索引凭空消失,反之索引文件被手工删了账本也拦不住 —— 两份各自容错,谁在听谁的。
 * 同一语料出现两份(改过 slug 规则的旧文件)按 header.corpus 去重,后读的不覆盖先读的。
 */
export function readAllIndexes(configDir?: string): ExamplesIndex[] {
	let files: string[];
	try {
		files = readdirSync(indexDir(configDir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	files.sort();
	const byCorpus = new Map<string, ExamplesIndex>();
	for (const name of files) {
		const text = readTextOrUndefined(path.join(indexDir(configDir), name));
		if (text === undefined) continue;
		const index = parseIndex(text);
		if (!index) continue;
		if (!byCorpus.has(index.header.corpus)) byCorpus.set(index.header.corpus, index);
	}
	return [...byCorpus.values()];
}
