// 例程索引的形状层:序列化往返、容错解析(坏行跳过、标签不对当没有)、账本解析。
// 全部纯函数,零 IO。
import { describe, expect, test } from "bun:test";

import {
	corpusSlug,
	type ExampleEntry,
	type ExamplesIndex,
	INDEX_SCHEMA_TAG,
	isExampleEntry,
	parseIndex,
	parseSources,
	serializeIndex,
	SOURCES_SCHEMA_TAG,
} from "../src/core/examples/index.ts";

function entryOf(overrides: Partial<ExampleEntry> = {}): ExampleEntry {
	return {
		id: "esp-idf@abc/examples/protocols/mqtt/tcp",
		corpus: "esp-idf@abc",
		ecosystem: "esp-idf",
		path: "examples/protocols/mqtt/tcp",
		name: "tcp",
		targets: ["esp32"],
		peripherals: ["mqtt"],
		buildable: true,
		loc: 120,
		files: 7,
		extractorVersion: 1,
		...overrides,
	};
}

function indexOf(entries: ExampleEntry[]): ExamplesIndex {
	return {
		header: {
			schema: INDEX_SCHEMA_TAG,
			corpus: "esp-idf@abc",
			ecosystem: "esp-idf",
			generatedAt: "2026-08-13T00:00:00.000Z",
			entries: entries.length,
		},
		entries,
	};
}

describe("索引(反)序列化", () => {
	test("往返无损", () => {
		const index = indexOf([entryOf(), entryOf({ id: "esp-idf@abc/examples/x", path: "examples/x", name: "x" })]);
		const parsed = parseIndex(serializeIndex(index));
		expect(parsed).toEqual(index);
	});

	test("条目行坏 → 跳过该行,不连累整份", () => {
		const good = entryOf();
		const text = `${JSON.stringify(indexOf([good]).header)}\n{broken json\n${JSON.stringify(good)}\n`;
		const parsed = parseIndex(text);
		expect(parsed?.entries).toEqual([good]);
	});

	test("形状不对的条目行同样跳过", () => {
		const good = entryOf();
		const bad = { ...good, targets: "esp32" }; // 该是数组
		const text = `${JSON.stringify(indexOf([good]).header)}\n${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`;
		expect(parseIndex(text)?.entries).toEqual([good]);
	});

	test("header 的 schema 标签对不上 → 整份当没有", () => {
		const index = indexOf([entryOf()]);
		const text = serializeIndex(index).replace(INDEX_SCHEMA_TAG, "yoma/examples-index@99");
		expect(parseIndex(text)).toBeUndefined();
	});

	test("空文本 / 首行不是 JSON → 当没有", () => {
		expect(parseIndex("")).toBeUndefined();
		expect(parseIndex("not json\n")).toBeUndefined();
	});
});

describe("条目守卫", () => {
	test("缺 buildable 不认", () => {
		const { buildable: _dropped, ...rest } = entryOf();
		expect(isExampleEntry(rest)).toBe(false);
	});

	test("ecosystem 不在册不认", () => {
		expect(isExampleEntry(entryOf({ ecosystem: "zephyr" as never }))).toBe(false);
	});
});

describe("语料账本解析", () => {
	test("坏条目逐条过滤,好的留下", () => {
		const sources = parseSources({
			schema: SOURCES_SCHEMA_TAG,
			corpora: [
				{ id: "a", ecosystem: "esp-idf", root: "/x" },
				{ id: "", ecosystem: "esp-idf", root: "/y" },
				{ id: "b", ecosystem: "nope", root: "/z" },
			],
		});
		expect(sources.corpora.map((corpus) => corpus.id)).toEqual(["a"]);
	});

	test("标签不对当空", () => {
		expect(parseSources({ schema: "other", corpora: [] }).corpora).toEqual([]);
	});
});

describe("corpusSlug", () => {
	test("@ 与斜杠换成 -,可当文件名", () => {
		expect(corpusSlug("esp-idf@08e0d30a")).toBe("esp-idf-08e0d30a");
		expect(corpusSlug("a/b@c")).toBe("a-b-c");
	});
});
