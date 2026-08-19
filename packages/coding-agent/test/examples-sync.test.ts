// 远程语料:三态解析(store)与两级落地(sync)。sync 的测试用 node:http 起真服务器
// + 真 tar.gz(生成走系统 tar,与 syncCorpus 解压同一条路),sha 不符拒收、幂等
// 跳过、锁互斥各钉一条。configDir 一律 mkdtemp(与 examples-store.test.ts 同一纪律)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	corpusCacheDir,
	readCorpusMarker,
	readSources,
	resolveCorpus,
	upsertSource,
	writeCorpusMarker,
} from "../src/core/examples/store.ts";
import { type CodelibMeta, listRemoteCorpora, syncCorpus, syncIndex } from "../src/core/examples/sync.ts";

let configDir: string;
let server: Server;
let baseUrl: string;
/** 服务器端"桶":path → Buffer。测试直接往里放字节。 */
const bucket = new Map<string, Buffer>();
let meta: CodelibMeta;

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function tarGzOf(files: Record<string, string>): Buffer {
	const work = mkdtempSync(join(tmpdir(), "yoma-sync-fixture-"));
	try {
		for (const [rel, content] of Object.entries(files)) {
			const file = join(work, rel);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, content, "utf8");
		}
		const out = `${work}.tar.gz`;
		const tar =
			process.platform === "win32"
				? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		const result = spawnSync(tar, ["-czf", out, "-C", work, "."], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`fixture tar failed: ${result.stderr}`);
		return readFileSync(out);
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(`${work}.tar.gz`, { force: true });
	}
}

beforeEach(async () => {
	configDir = mkdtempSync(join(tmpdir(), "yoma-examples-sync-"));
	bucket.clear();

	const indexJsonl = Buffer.from(
		[
			JSON.stringify({ schema: "yoma/examples-index@1", corpus: "esp-idf@test", ecosystem: "esp-idf", generatedAt: "2026-08-18T00:00:00.000Z", entries: 1 }),
			JSON.stringify({
				id: "esp-idf@test/examples/a", corpus: "esp-idf@test", ecosystem: "esp-idf",
				path: "examples/a", name: "a", targets: ["esp32"], peripherals: [], buildable: true,
				loc: 5, files: 1, extractorVersion: 1,
			}),
			"",
		].join("\n"),
		"utf8",
	);
	const enrichJsonl = Buffer.from(
		`${JSON.stringify({ schema: "yoma/examples-enrich@1", id: "esp-idf@test/examples/a", corpus: "esp-idf@test", model: "x", enrichedAt: "2026-08-18T00:00:00.000Z", card: { summaryZh: "演示", capabilities: [], footprint: { pins: [], instances: [], symbols: [], entrySymbols: [], tasks: [] } } })}\n`,
		"utf8",
	);
	const archive = tarGzOf({ "examples/a/main/main.c": "int main(void) { return 0; }\n" });

	meta = {
		id: "esp-idf@test",
		ecosystem: "esp-idf",
		commit: "test000",
		ref: "v-test",
		entries: 1,
		targets: ["esp32"],
		archiveSha256: sha256(archive),
		archiveBytes: archive.byteLength,
		indexSha256: sha256(indexJsonl),
		enrichSha256: sha256(enrichJsonl),
		publishedAt: "2026-08-18T00:00:00Z",
	};
	bucket.set("/api/codelibs", Buffer.from(JSON.stringify([meta])));
	bucket.set(`/api/codelibs/${meta.id}/meta`, Buffer.from(JSON.stringify(meta)));
	bucket.set(`/api/codelibs/${meta.id}/index`, indexJsonl);
	bucket.set(`/api/codelibs/${meta.id}/enrich`, enrichJsonl);
	bucket.set(`/api/codelibs/${meta.id}/archive`, archive);

	server = createServer((req, res) => {
		// decodeURIComponent 对齐真实服务器:FastAPI 的路径参数自动解百分号编码,
		// sync.ts 对语料 id 走 encodeURIComponent("@" -> "%40")。
		const url = decodeURIComponent((req.url ?? "").split("?")[0]);
		const body = bucket.get(url);
		if (body === undefined) {
			res.writeHead(404).end("no such object");
			return;
		}
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.byteLength });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
	rmSync(configDir, { recursive: true, force: true });
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("三态解析(resolveCorpus)", () => {
	test("本机 root 存在 → 指它,不走缓存", () => {
		const root = mkdtempSync(join(tmpdir(), "yoma-corpus-root-"));
		try {
			upsertSource({ id: "c@a", ecosystem: "esp-idf", root }, configDir);
			const resolved = resolveCorpus("c@a", configDir);
			expect(resolved?.root).toBe(root);
			expect(resolved?.fromCache).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("缓存标记与账本 remote 一致 → 指缓存", () => {
		upsertSource(
			{
				id: "c@a", ecosystem: "esp-idf", root: "",
				remote: { server: baseUrl, archiveSha256: "deadbeef", archiveBytes: 1, indexSha256: "beef" },
			},
			configDir,
		);
		mkdirSync(corpusCacheDir("c@a", configDir), { recursive: true });
		writeCorpusMarker({ schema: "yoma/corpus-cache@1", id: "c@a", archiveSha256: "deadbeef", extractedAt: "now" }, configDir);
		const resolved = resolveCorpus("c@a", configDir);
		expect(resolved?.root).toBe(corpusCacheDir("c@a", configDir));
		expect(resolved?.fromCache).toBe(true);
	});

	test("有 remote 无缓存 → root 为 undefined(索引可查、代码未落地)", () => {
		upsertSource(
			{
				id: "c@a", ecosystem: "esp-idf", root: "",
				remote: { server: baseUrl, archiveSha256: "deadbeef", archiveBytes: 1, indexSha256: "beef" },
			},
			configDir,
		);
		const resolved = resolveCorpus("c@a", configDir);
		expect(resolved).toBeDefined();
		expect(resolved?.root).toBeUndefined();
		expect(resolved?.remote?.server).toBe(baseUrl);
	});

	test("缓存标记 sha 与账本不一致 → 不认缓存(该重下,不该将就)", () => {
		upsertSource(
			{
				id: "c@a", ecosystem: "esp-idf", root: "",
				remote: { server: baseUrl, archiveSha256: "newsha", archiveBytes: 1, indexSha256: "beef" },
			},
			configDir,
		);
		mkdirSync(corpusCacheDir("c@a", configDir), { recursive: true });
		writeCorpusMarker({ schema: "yoma/corpus-cache@1", id: "c@a", archiveSha256: "oldsha", extractedAt: "now" }, configDir);
		expect(resolveCorpus("c@a", configDir)?.root).toBeUndefined();
	});

	test("账本里 root 指的目录没了 → 与没记账同样对待", () => {
		upsertSource({ id: "c@a", ecosystem: "esp-idf", root: join(configDir, "gone") }, configDir);
		const resolved = resolveCorpus("c@a", configDir);
		expect(resolved).toBeDefined();
		expect(resolved?.root).toBeUndefined();
	});

	test("未记账 → undefined", () => {
		expect(resolveCorpus("nope", configDir)).toBeUndefined();
	});
});

describe("第一级:syncIndex", () => {
	test("落地索引+富化并记账(root 空、remote 填服务器)", async () => {
		const { downloaded } = await syncIndex(baseUrl, meta, configDir);
		expect(downloaded.sort()).toEqual(["enrich.jsonl", "index.jsonl"]);
		const sources = readSources(configDir);
		expect(sources.corpora).toHaveLength(1);
		expect(sources.corpora[0]?.root).toBe("");
		expect(sources.corpora[0]?.remote?.archiveSha256).toBe(meta.archiveSha256);
		// 落地的索引能被现有读侧认出来。
		const { readIndexFile } = await import("../src/core/examples/store.ts");
		expect(readIndexFile(meta.id, configDir)?.entries).toHaveLength(1);
	});

	test("幂等:本地已是期望 sha 时不再下载", async () => {
		await syncIndex(baseUrl, meta, configDir);
		bucket.set(`/api/codelibs/${meta.id}/index`, Buffer.from("tampered")); // 再下就会写坏
		const { downloaded } = await syncIndex(baseUrl, meta, configDir);
		expect(downloaded).toEqual([]);
		const { readIndexFile } = await import("../src/core/examples/store.ts");
		expect(readIndexFile(meta.id, configDir)?.entries).toHaveLength(1);
	});

	test("sha 不符 → 抛错且不留 .part / 不记账", async () => {
		const bad = { ...meta, indexSha256: "0".repeat(64) };
		await expect(syncIndex(baseUrl, bad, configDir)).rejects.toThrow(/sha256 不匹配/);
		const indexPath = join(configDir, "examples", "index", "esp-idf-test.jsonl");
		expect(existsSync(indexPath)).toBe(false);
		expect(existsSync(`${indexPath}.part`)).toBe(false);
		expect(readSources(configDir).corpora).toHaveLength(0);
	});

	test("listRemoteCorpora 解析清单", async () => {
		const corpora = await listRemoteCorpora(baseUrl);
		expect(corpora.map((m) => m.id)).toEqual([meta.id]);
	});
});

describe("第二级:syncCorpus", () => {
	test("下载 → 校验 → 解压 → 标记 → 原子落位", async () => {
		const { skipped, bytes } = await syncCorpus(baseUrl, meta, configDir);
		expect(skipped).toBe(false);
		expect(bytes).toBe(meta.archiveBytes);
		const cache = corpusCacheDir(meta.id, configDir);
		expect(existsSync(join(cache, "examples", "a", "main", "main.c"))).toBe(true);
		const marker = readCorpusMarker(meta.id, configDir);
		expect(marker?.archiveSha256).toBe(meta.archiveSha256);
		// archive 与解压残留用完即清。
		expect(existsSync(join(configDir, "examples", "downloads", "esp-idf-test.tar.gz"))).toBe(false);
		expect(existsSync(`${cache}.extracting`)).toBe(false);
		// 落位后三态解析认缓存。
		await syncIndex(baseUrl, meta, configDir);
		expect(resolveCorpus(meta.id, configDir)?.root).toBe(cache);
	});

	test("幂等:标记一致 → 整体跳过", async () => {
		await syncCorpus(baseUrl, meta, configDir);
		bucket.set(`/api/codelibs/${meta.id}/archive`, Buffer.from("tampered"));
		const { skipped } = await syncCorpus(baseUrl, meta, configDir);
		expect(skipped).toBe(true);
	});

	test("sha 不符 → 抛错,不落缓存不留 archive", async () => {
		const bad = { ...meta, archiveSha256: "0".repeat(64) };
		await expect(syncCorpus(baseUrl, bad, configDir)).rejects.toThrow(/sha256 不匹配/);
		expect(existsSync(corpusCacheDir(meta.id, configDir))).toBe(false);
		expect(existsSync(join(configDir, "examples", "downloads", "esp-idf-test.tar.gz"))).toBe(false);
	});

	test("锁互斥:活 pid 持锁 → 明确报错;死 pid → 抢锁继续", async () => {
		const lockFile = join(configDir, "examples", "downloads", "esp-idf-test.lock");
		mkdirSync(join(configDir, "examples", "downloads"), { recursive: true });
		// 活锁:拿一个真实存在且永不退出的进程 —— 用 server 自己。
		writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
		await expect(syncCorpus(baseUrl, meta, configDir)).rejects.toThrow(/正在被另一个进程同步/);
		// 死锁:pid 必然不存在(1 通常是 init,杀了也不该是我们;用一个大数更稳)。
		writeFileSync(lockFile, `${JSON.stringify({ pid: 999999999 })}\n`, "utf8");
		const { skipped } = await syncCorpus(baseUrl, meta, configDir);
		expect(skipped).toBe(false);
	});
});
