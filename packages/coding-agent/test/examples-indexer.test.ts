// 索引器:fixture 语料 → 盖戳 → 落盘 + 记账,一条龙。configDir 一律 mkdtemp 隔离。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildIndex,
	findSource,
	indexCorpus,
	readIndexFile,
} from "../src/core/examples/index.ts";

const ESP_ROOT = join(import.meta.dir, "fixtures", "examples", "esp-idf-mini");
const CUBE_ROOT = join(import.meta.dir, "fixtures", "examples", "cube-mini");

let configDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "yoma-examples-indexer-"));
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
});

describe("buildIndex", () => {
	test("条目盖上语料戳,id = 语料/路径,header 计数对得上", () => {
		const index = buildIndex({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: "esp-idf@test" });
		expect(index.header.corpus).toBe("esp-idf@test");
		expect(index.header.entries).toBe(index.entries.length);
		expect(index.entries.length).toBe(3);
		for (const entry of index.entries) {
			expect(entry.corpus).toBe("esp-idf@test");
			expect(entry.id).toBe(`esp-idf@test/${entry.path}`);
			expect(entry.ecosystem).toBe("esp-idf");
		}
	});

	test("Cube 缺省语料名带家族(fixture 无 .git,commit 落到日期)", () => {
		const index = buildIndex({ root: CUBE_ROOT, ecosystem: "stm32cube" });
		expect(index.header.corpus.startsWith("stm32cube-f4@")).toBe(true);
	});
});

describe("indexCorpus", () => {
	test("落盘可读回,语料根记进账本", () => {
		const { index, file } = indexCorpus({
			root: ESP_ROOT,
			ecosystem: "esp-idf",
			corpusId: "esp-idf@test",
			configDir,
		});
		expect(file.endsWith(".jsonl")).toBe(true);
		expect(readIndexFile("esp-idf@test", configDir)).toEqual(index);
		const source = findSource("esp-idf@test", configDir);
		expect(source?.ecosystem).toBe("esp-idf");
		expect(source?.root.replaceAll("\\", "/")).toContain("esp-idf-mini");
	});
});
