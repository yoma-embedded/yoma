// 落盘层:mkdtemp 隔离 configDir(默认值是真实 ~/.my-pi,测试碰它 = 洗开发机数据,
// Bun 的 homedir 启动即定死 —— 与 ledger.ts 测试同一纪律)。缓存语义:坏文件当空。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type ExampleEntry,
	type ExamplesIndex,
	INDEX_SCHEMA_TAG,
	indexPathFor,
	readAllIndexes,
	readIndexFile,
	readSources,
	sourcesPath,
	upsertSource,
	writeIndexFile,
} from "../src/core/examples/index.ts";

let configDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "yoma-examples-store-"));
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
});

function indexOf(corpus: string, paths: string[]): ExamplesIndex {
	const entries: ExampleEntry[] = paths.map((path) => ({
		id: `${corpus}/${path}`,
		corpus,
		ecosystem: "esp-idf",
		path,
		name: path.split("/").pop() as string,
		targets: ["esp32"],
		peripherals: [],
		buildable: true,
		loc: 10,
		files: 2,
		extractorVersion: 1,
	}));
	return {
		header: {
			schema: INDEX_SCHEMA_TAG,
			corpus,
			ecosystem: "esp-idf",
			generatedAt: "2026-08-13T00:00:00.000Z",
			entries: entries.length,
		},
		entries,
	};
}

describe("索引文件", () => {
	test("写读往返", () => {
		const index = indexOf("esp-idf@abc", ["examples/a", "examples/b"]);
		writeIndexFile(index, configDir);
		expect(readIndexFile("esp-idf@abc", configDir)).toEqual(index);
	});

	test("不存在 / 坏内容 → undefined,不抛", () => {
		expect(readIndexFile("nope", configDir)).toBeUndefined();
		mkdirSync(join(configDir, "examples", "index"), { recursive: true });
		writeFileSync(indexPathFor("bad", configDir), "garbage\n", "utf8");
		expect(readIndexFile("bad", configDir)).toBeUndefined();
	});

	test("readAllIndexes:枚举全部,坏文件跳过,同语料去重", () => {
		writeIndexFile(indexOf("esp-idf@a", ["examples/x"]), configDir);
		writeIndexFile(indexOf("stm32cube-f4@b", ["Projects/y"]), configDir);
		writeFileSync(join(configDir, "examples", "index", "junk.jsonl"), "{not json\n", "utf8");
		const all = readAllIndexes(configDir);
		expect(all.map((index) => index.header.corpus).sort()).toEqual(["esp-idf@a", "stm32cube-f4@b"]);
	});

	test("索引目录不存在 → 空数组", () => {
		expect(readAllIndexes(join(configDir, "void"))).toEqual([]);
	});
});

describe("语料账本", () => {
	test("upsert 追加与按 id 覆盖", () => {
		upsertSource({ id: "esp-idf@a", ecosystem: "esp-idf", root: "/one" }, configDir);
		upsertSource({ id: "cube@b", ecosystem: "stm32cube", root: "/two" }, configDir);
		upsertSource({ id: "esp-idf@a", ecosystem: "esp-idf", root: "/three" }, configDir);
		const sources = readSources(configDir);
		expect(sources.corpora).toEqual([
			{ id: "cube@b", ecosystem: "stm32cube", root: "/two" },
			{ id: "esp-idf@a", ecosystem: "esp-idf", root: "/three" },
		]);
	});

	test("坏 JSON 当空账本,不抛", () => {
		upsertSource({ id: "a", ecosystem: "esp-idf", root: "/x" }, configDir);
		writeFileSync(sourcesPath(configDir), "{oops", "utf8");
		expect(readSources(configDir).corpora).toEqual([]);
	});
});
