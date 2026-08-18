/**
 * examples sync —— 远程语料的本机落地(设计:rag_yoma docs/PLAN-codelibs.zh-CN.md)。
 *
 * 两级落地,对应两类使用:
 *   syncIndex  索引+富化 jsonl(MB 级)→ search/info/preflight 立即可用;
 *   syncCorpus 语料包 tar.gz(GB 级)→ cache/ 解压成树,seed 与 rg grep 用它。
 *
 * 下载纪律逐条抄桌面手册库(manuals.ts):流式写 .part、边下边算 sha256、校验
 * 不过删 .part 抛错、过了才原子改名 —— 半截文件永远不会顶替完整文件。不做字节级
 * 续传:失败重下整份,本地同 sha 跳过的幂等性已覆盖绝大多数"重跑"场景。
 *
 * 解压走系统 tar(Windows 显式用 System32 的 bsdtar:PATH 里排前面的常是 Git Bash
 * 的 GNU tar,它不认 zip 类归档 —— 手册库与 engines build.ts 各踩过一次)。spawn
 * 显式传 env:根 CLAUDE.md 的教训,bun 的 spawn 省略 env 时按进程启动那一刻的
 * 环境解析,不认运行时改过的 PATH。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { type Ecosystem, corpusSlug, isEcosystem } from "./schema.ts";
import {
	corpusCacheDir,
	downloadsDir,
	enrichPathFor,
	indexPathFor,
	readCorpusMarker,
	upsertSource,
	writeTextAtomic,
} from "./store.ts";

/** 服务器清单里一条语料的元数据(GET /api/codelibs 的元素)。 */
export interface CodelibMeta {
	id: string;
	ecosystem: string;
	commit?: string;
	ref?: string;
	description?: string;
	entries?: number;
	targets?: string[];
	archiveSha256: string;
	archiveBytes: number;
	indexSha256: string;
	enrichSha256?: string | null;
	publishedAt?: string;
}

export interface SyncEvents {
	/** 单个文件已传输的字节数(每文件从 0 重新计数)。 */
	onBytes?: (file: string, bytes: number) => void;
	/** 阶段切换(下载/解压这类无字节计数的步骤)。 */
	onPhase?: (phase: string) => void;
}

/**
 * 服务器地址解析:显式参数 > `YOMA_DATASHEET_SERVER`(与 datasheet 工具同一个
 * 服务器、同一套注入管道 —— 桌面主进程已把它兜进内核 env)。无尾斜杠。
 */
export function resolveSyncServer(explicit?: string): string | undefined {
	const raw = (explicit ?? process.env.YOMA_DATASHEET_SERVER ?? "").trim();
	return raw === "" ? undefined : raw.replace(/\/+$/, "");
}

function parseCodelibMeta(item: unknown): CodelibMeta | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const meta = item as Record<string, unknown>;
	if (typeof meta.id !== "string" || typeof meta.archiveSha256 !== "string") return undefined;
	return {
		id: meta.id,
		ecosystem: typeof meta.ecosystem === "string" ? meta.ecosystem : "",
		commit: typeof meta.commit === "string" ? meta.commit : undefined,
		ref: typeof meta.ref === "string" ? meta.ref : undefined,
		description: typeof meta.description === "string" ? meta.description : undefined,
		entries: typeof meta.entries === "number" ? meta.entries : undefined,
		targets: Array.isArray(meta.targets) ? meta.targets.filter((t): t is string => typeof t === "string") : undefined,
		archiveSha256: meta.archiveSha256,
		archiveBytes: typeof meta.archiveBytes === "number" ? meta.archiveBytes : 0,
		indexSha256: typeof meta.indexSha256 === "string" ? meta.indexSha256 : "",
		enrichSha256: typeof meta.enrichSha256 === "string" ? meta.enrichSha256 : null,
		publishedAt: typeof meta.publishedAt === "string" ? meta.publishedAt : undefined,
	};
}

/** fetch 的人话包装:连不上/非 2xx 都变成一句话,不把调用栈甩给用户。 */
async function fetchOk(url: string): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`连不上 ${url}:${reason}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res;
}

export async function listRemoteCorpora(server: string): Promise<CodelibMeta[]> {
	const res = await fetchOk(`${server}/api/codelibs`);
	const body: unknown = await res.json();
	if (!Array.isArray(body)) throw new Error("GET /api/codelibs 返回的不是数组");
	return body.map(parseCodelibMeta).filter((m): m is CodelibMeta => m !== undefined);
}

export async function fetchCodelibMeta(server: string, corpusId: string): Promise<CodelibMeta> {
	const res = await fetchOk(`${server}/api/codelibs/${encodeURIComponent(corpusId)}/meta`);
	const meta = parseCodelibMeta(await res.json());
	if (meta === undefined || meta.id !== corpusId) throw new Error(`服务器返回的 ${corpusId} meta 不完整`);
	return meta;
}

// ─── 下载原语(纪律抄 desktop/src/main/manuals.ts)───────────────────────────

function sha256Local(file: string): string | undefined {
	try {
		const hash = createHash("sha256");
		hash.update(readFileSync(file));
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

async function fetchToFile(
	url: string,
	dest: string,
	opts: { sha256?: string; events?: SyncEvents; file?: string } = {},
): Promise<{ bytes: number; sha256: string }> {
	const res = await fetchOk(url);
	mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.part`;
	const hash = createHash("sha256");
	let bytes = 0;
	const sink = createWriteStream(tmp);
	try {
		if (res.body) {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				const buf = Buffer.from(chunk);
				hash.update(buf);
				bytes += buf.byteLength;
				opts.events?.onBytes?.(opts.file ?? path.basename(dest), bytes);
				if (!sink.write(buf)) await once(sink, "drain");
			}
		} else {
			const buf = Buffer.from(await res.arrayBuffer());
			hash.update(buf);
			bytes = buf.byteLength;
			sink.write(buf);
		}
		await new Promise<void>((resolve, reject) => {
			sink.once("error", reject);
			sink.end(resolve);
		});
	} catch (error) {
		sink.destroy();
		rmSync(tmp, { force: true });
		throw error;
	}
	const digest = hash.digest("hex");
	if (opts.sha256 && digest !== opts.sha256) {
		rmSync(tmp, { force: true });
		throw new Error(`sha256 不匹配:${path.basename(dest)}(期望 ${opts.sha256.slice(0, 12)}…,实得 ${digest.slice(0, 12)}…)`);
	}
	renameSync(tmp, dest);
	return { bytes, sha256: digest };
}

// ─── 并发锁(downloads/<slug>.lock)────────────────────────────────────────────

function lockPath(corpusId: string, configDir?: string): string {
	return path.join(downloadsDir(configDir), `${corpusSlug(corpusId)}.lock`);
}

/**
 * 进程级互斥:语料下载是分钟级操作,两个会话同时下同一语料会撕 .part。锁文件记
 * pid;持锁进程已死则视作残留直接抢(probe.lock 的存活探活写法)。
 */
function acquireLock(corpusId: string, configDir?: string): void {
	const file = lockPath(corpusId, configDir);
	mkdirSync(path.dirname(file), { recursive: true });
	let holder: number | undefined;
	try {
		const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof raw === "object" && raw !== null && "pid" in raw) {
			const pid = Number.parseInt(String((raw as { pid: unknown }).pid), 10);
			if (Number.isInteger(pid)) holder = pid;
		}
	} catch {
		// ENOENT / 坏 JSON:没有活锁,直接抢。
	}
	if (holder !== undefined) {
		let alive = false;
		try {
			process.kill(holder, 0);
			alive = true;
		} catch {
			// 进程不在了 —— 残锁,抢。
		}
		if (alive) {
			throw new Error(`语料 ${corpusId} 正在被另一个进程同步(pid ${holder});等它完成,或确认没有后再删 ${file}`);
		}
	}
	writeTextAtomic(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
}

function releaseLock(corpusId: string, configDir?: string): void {
	rmSync(lockPath(corpusId, configDir), { force: true });
}

// ─── 解压 ─────────────────────────────────────────────────────────────────────

function tarBinary(): string {
	if (process.platform !== "win32") return "tar";
	return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

/** 解压 tar.gz 到 dest。archive 是 `-C <语料根> .` 打的,解出来就是树本身。 */
function extractTar(archive: string, dest: string): void {
	const result = spawnSync(tarBinary(), ["-xf", archive, "-C", dest], {
		env: { ...process.env },
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const tail = `${result.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n");
		throw new Error(`tar 解压失败(exit ${result.status}):${tail}`);
	}
}

// ─── 两级同步 ──────────────────────────────────────────────────────────────────

function toEcosystem(meta: CodelibMeta): Ecosystem {
	if (!isEcosystem(meta.ecosystem)) {
		throw new Error(`服务器清单里 ${meta.id} 的 ecosystem 是 "${meta.ecosystem}",本机不认识 —— 升级 yoma 后再试`);
	}
	return meta.ecosystem;
}

/**
 * 第一级:索引+富化落地(MB 级)。本地已是期望 sha 的文件跳过(幂等);完成后把
 * 语料记进账本(root 空、remote 填服务器与 sha)—— 这一步之后 search 即可查到。
 */
export async function syncIndex(
	server: string,
	meta: CodelibMeta,
	configDir?: string,
	events?: SyncEvents,
): Promise<{ downloaded: string[] }> {
	const downloaded: string[] = [];
	if (sha256Local(indexPathFor(meta.id, configDir)) !== meta.indexSha256) {
		events?.onPhase?.(`index ${meta.id}`);
		await fetchToFile(`${server}/api/codelibs/${encodeURIComponent(meta.id)}/index`, indexPathFor(meta.id, configDir), {
			sha256: meta.indexSha256 === "" ? undefined : meta.indexSha256,
			events,
			file: "index.jsonl",
		});
		downloaded.push("index.jsonl");
	}
	if (meta.enrichSha256 && sha256Local(enrichPathFor(meta.id, configDir)) !== meta.enrichSha256) {
		events?.onPhase?.(`enrich ${meta.id}`);
		await fetchToFile(`${server}/api/codelibs/${encodeURIComponent(meta.id)}/enrich`, enrichPathFor(meta.id, configDir), {
			sha256: meta.enrichSha256,
			events,
			file: "enrich.jsonl",
		});
		downloaded.push("enrich.jsonl");
	}
	upsertSource(
		{
			id: meta.id,
			ecosystem: toEcosystem(meta),
			root: "",
			remote: {
				server,
				commit: meta.commit,
				archiveSha256: meta.archiveSha256,
				archiveBytes: meta.archiveBytes,
				indexSha256: meta.indexSha256,
				enrichSha256: meta.enrichSha256 ?? undefined,
			},
		},
		configDir,
	);
	return { downloaded };
}

/**
 * 第二级:语料包落地(GB 级)。缓存标记的 sha 与清单一致则整体跳过;下载 → 校验 →
 * 解压到 cache/<slug>.extracting → 写标记 → 原子换名 —— 半个语料树永远不会顶着
 * 完整的名字出现。注意:localSha 走 readFileSync 全量进内存,对 GB 级 archive 不
 * 合适,所以 archive 的幂等靠缓存标记(解压后即删 archive),不靠重算哈希。
 */
export async function syncCorpus(
	server: string,
	meta: CodelibMeta,
	configDir?: string,
	events?: SyncEvents,
): Promise<{ skipped: boolean; bytes: number }> {
	const marker = readCorpusMarker(meta.id, configDir);
	if (marker && marker.archiveSha256 === meta.archiveSha256) {
		return { skipped: true, bytes: 0 };
	}
	acquireLock(meta.id, configDir);
	try {
		const archive = path.join(downloadsDir(configDir), `${corpusSlug(meta.id)}.tar.gz`);
		events?.onPhase?.(`download ${meta.id} (${(meta.archiveBytes / 1e9).toFixed(2)} GB)`);
		const { bytes } = await fetchToFile(`${server}/api/codelibs/${encodeURIComponent(meta.id)}/archive`, archive, {
			sha256: meta.archiveSha256,
			events,
			file: "archive.tar.gz",
		});
		const cache = corpusCacheDir(meta.id, configDir);
		const extracting = `${cache}.extracting`;
		events?.onPhase?.(`extract ${meta.id}`);
		rmSync(extracting, { recursive: true, force: true });
		try {
			mkdirSync(extracting, { recursive: true });
			extractTar(archive, extracting);
			// 标记写进解压目录里,随整个树一起原子换名 —— 换名后的 cache 要么带标记
			// 要么压根不存在,不存在"无标记的完整树"这个中间态(readCorpusMarker 只认
			// cache/<slug>/.corpus.json 这个最终位置)。
			writeTextAtomic(
				path.join(extracting, ".corpus.json"),
				`${JSON.stringify(
					{
						schema: "yoma/corpus-cache@1",
						id: meta.id,
						commit: meta.commit,
						archiveSha256: meta.archiveSha256,
						extractedAt: new Date().toISOString(),
					},
					null,
					"\t",
				)}\n`,
			);
			rmSync(cache, { recursive: true, force: true });
			renameSync(extracting, cache);
		} finally {
			rmSync(extracting, { recursive: true, force: true });
		}
		rmSync(archive, { force: true });
		return { skipped: false, bytes };
	} finally {
		releaseLock(meta.id, configDir);
	}
}

