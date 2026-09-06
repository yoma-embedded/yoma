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

// 粒度/分层/证据来源:条目级严格(坏取值当坏行丢),语料级宽松(只校验类型)——
// 这个不对称是有意的,理由见 ExamplesIndexHeader 的注释,这里逐条钉住。
describe("entryKind / tier / targetSource", () => {
	test("合法取值认", () => {
		expect(isExampleEntry(entryOf({ entryKind: "project", tier: "seed", targetSource: "build-system" }))).toBe(true);
	});

	test("三个都可缺省 —— 旧索引一条都没有,缺省必须等价于从前的行为", () => {
		const entry = entryOf();
		expect(isExampleEntry(entry)).toBe(true);
		expect(entry.entryKind).toBeUndefined();
		expect(entry.tier).toBeUndefined();
	});

	test("取值不在册当坏行丢(与 ecosystem 同一档待遇)", () => {
		expect(isExampleEntry(entryOf({ entryKind: "projekt" as never }))).toBe(false);
		expect(isExampleEntry(entryOf({ tier: "seeed" as never }))).toBe(false);
		expect(isExampleEntry(entryOf({ targetSource: "vibes" as never }))).toBe(false);
	});

	test("语料级 tier 被条目继承,条目显式标的赢", () => {
		const index = indexOf([entryOf({ id: "a" }), entryOf({ id: "b", tier: "seed" })]);
		index.header.tier = "lib";
		const parsed = parseIndex(serializeIndex(index));
		expect(parsed?.entries.map((entry) => entry.tier)).toEqual(["lib", "seed"]);
	});

	test("header 的 tier 取值不认识时当没有 —— 否则它会盖到每一条上再被逐条判废,整份索引静默变空", () => {
		const index = indexOf([entryOf({ id: "a" })]);
		(index.header as { tier?: string }).tier = "seeed";
		const parsed = parseIndex(serializeIndex(index));
		expect(parsed?.entries).toHaveLength(1);
		expect(parsed?.entries[0]?.tier).toBeUndefined();
	});

	test("语料级元数据只校验类型:不认识的 indexer 不判废整份索引", () => {
		const index = indexOf([entryOf({ id: "a" })]);
		index.header.indexer = "some-future-indexer";
		index.header.libraryKind = "例程集";
		index.header.candidateCount = 46;
		const parsed = parseIndex(serializeIndex(index));
		expect(parsed?.header.indexer).toBe("some-future-indexer");
		expect(parsed?.header.libraryKind).toBe("例程集");
		expect(parsed?.header.candidateCount).toBe(46);
	});

	test("语料级元数据类型不对才判废(candidateCount 不是数)", () => {
		const index = indexOf([entryOf({ id: "a" })]);
		(index.header as { candidateCount?: unknown }).candidateCount = "四十六";
		expect(parseIndex(serializeIndex(index))).toBeUndefined();
	});
});
