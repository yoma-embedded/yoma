// 检索:硬过滤的对抗用例是这个子系统的存在理由 —— esp32 查询返回 STM32 条目
// 就是"语义完美、物理不可用"那个失败模式,任何改动打破它都必须在这里响。
import { describe, expect, test } from "bun:test";

import { type ExampleEntry, searchIndex, targetMatches } from "../src/core/examples/index.ts";

function entryOf(overrides: Partial<ExampleEntry>): ExampleEntry {
	return {
		id: "c/x",
		corpus: "c",
		ecosystem: "esp-idf",
		path: "examples/x",
		name: "x",
		targets: [],
		peripherals: [],
		buildable: true,
		loc: 100,
		files: 3,
		extractorVersion: 1,
		...overrides,
	};
}

const CORPUS: ExampleEntry[] = [
	entryOf({
		id: "esp/mqtt",
		ecosystem: "esp-idf",
		path: "examples/protocols/mqtt/tcp",
		name: "tcp",
		title: "ESP-MQTT sample",
		targets: ["esp32", "esp32c3"],
		peripherals: ["mqtt", "nvs"],
		loc: 150,
	}),
	entryOf({
		id: "cube/i2c",
		ecosystem: "stm32cube",
		path: "Projects/NUCLEO-F401RE/Examples/I2C/I2C_TwoBoards",
		name: "I2C_TwoBoards",
		title: "I2C two boards communication",
		targets: ["stm32f4"],
		board: "NUCLEO-F401RE",
		peripherals: ["i2c", "dma"],
		loc: 300,
	}),
	entryOf({
		id: "esp/unknown-targets",
		ecosystem: "esp-idf",
		path: "examples/get-started/hello_world",
		name: "hello_world",
		targets: [],
		peripherals: [],
		loc: 20,
	}),
	entryOf({
		id: "cube/unbuildable",
		ecosystem: "stm32cube",
		path: "Projects/B/Examples/SPI/SPI_Full",
		name: "SPI_Full",
		targets: ["stm32f1"],
		peripherals: ["spi"],
		buildable: false,
		loc: 250,
	}),
];

describe("硬过滤", () => {
	test("对抗用例:esp32 查询绝不返回 STM32 条目", () => {
		const hits = searchIndex(CORPUS, { target: "esp32" });
		expect(hits.some((hit) => hit.entry.ecosystem === "stm32cube")).toBe(false);
	});

	test("家族前缀:stm32f407 命中 stm32f4,不命中 stm32f1 之外的家族错配", () => {
		const hits = searchIndex(CORPUS, { target: "stm32f407" });
		expect(hits.map((hit) => hit.entry.id)).toContain("cube/i2c");
		expect(hits.map((hit) => hit.entry.id)).not.toContain("cube/unbuildable");
	});

	test("具体芯片不反向匹配:esp32 查询不命中仅标 esp32c3 的条目", () => {
		const only = [entryOf({ id: "esp/c3only", targets: ["esp32c3"] })];
		expect(searchIndex(only, { target: "esp32" })).toEqual([]);
	});

	test("targets 为空 = 未知:同生态不排除,理由里明说", () => {
		const hits = searchIndex(CORPUS, { target: "esp32" });
		const unknown = hits.find((hit) => hit.entry.id === "esp/unknown-targets");
		expect(unknown).toBeDefined();
		expect(unknown?.reasons.join()).toContain("元数据缺失");
	});

	test("targets 未知不许跨生态泄漏:stm32 查询绝不返回 esp-idf 的未知条目", () => {
		const hits = searchIndex(CORPUS, { target: "stm32f103" });
		expect(hits.some((hit) => hit.entry.ecosystem === "esp-idf")).toBe(false);
	});

	test("给了外设却零命中 → 排除;buildableOnly 排掉不能编的", () => {
		expect(searchIndex(CORPUS, { peripherals: ["can"] })).toEqual([]);
		const hits = searchIndex(CORPUS, { peripherals: ["spi"], buildableOnly: true });
		expect(hits).toEqual([]);
	});
});

describe("打分与顺序", () => {
	test("外设命中优先,同分小种子在前,同输入必同输出", () => {
		const first = searchIndex(CORPUS, { ecosystem: "esp-idf", peripherals: ["mqtt"], keywords: ["sample"] });
		const second = searchIndex(CORPUS, { ecosystem: "esp-idf", peripherals: ["mqtt"], keywords: ["sample"] });
		expect(first.map((hit) => hit.entry.id)).toEqual(["esp/mqtt"]);
		expect(first).toEqual(second);
		expect(first[0].reasons.join()).toContain("外设命中 mqtt");
	});

	test("板名是软偏好:命中加分,不命中不排除", () => {
		const withBoard = searchIndex(CORPUS, { target: "stm32f4", board: "NUCLEO-F401RE" });
		const without = searchIndex(CORPUS, { target: "stm32f4", board: "MY-CUSTOM-BOARD" });
		expect(withBoard[0].entry.id).toBe("cube/i2c");
		expect(without.map((hit) => hit.entry.id)).toContain("cube/i2c");
		expect(withBoard[0].score).toBeGreaterThan((without.find((hit) => hit.entry.id === "cube/i2c") as { score: number }).score);
	});

	test("limit 生效", () => {
		expect(searchIndex(CORPUS, { limit: 1 }).length).toBe(1);
	});
});

describe("targetMatches", () => {
	test("大小写与连字符归一", () => {
		expect(targetMatches("ESP32-S3", ["esp32s3"])).toBe(true);
		expect(targetMatches("STM32F407VG", ["stm32f4"])).toBe(true);
		expect(targetMatches("esp32", ["esp32s3"])).toBe(false);
	});
});

// 分层是给「笼统查询」兜底的:只给芯片时,库本体条目会把真种子挤掉(实测 47 -> 375)。
// 但它绝不能连累旧索引 —— 那 10 份语料一条 tier 都没有,"未标"必须仍然等于从前。
describe("分层(tier)与粒度(entryKind)", () => {
	const LAYERED: ExampleEntry[] = [
		entryOf({ id: "t/proj", corpus: "tinyusb", ecosystem: "generic", targets: ["stm32f4"], tier: "seed", entryKind: "project", loc: 300 }),
		entryOf({ id: "t/src", corpus: "tinyusb", ecosystem: "generic", targets: ["stm32f4"], tier: "lib", entryKind: "corpus", loc: 92_000 }),
		entryOf({ id: "t/old", corpus: "tinyusb", ecosystem: "generic", targets: ["stm32f4"], loc: 400 }),
	];

	test("带芯片时默认只搜 seed:显式标 lib 的被挡,未标的照旧不排除", () => {
		const ids = searchIndex(LAYERED, { target: "stm32f407" }).map((hit) => hit.entry.id);
		expect(ids.sort()).toEqual(["t/old", "t/proj"]);
	});

	test("不带芯片时默认不分层", () => {
		const ids = searchIndex(LAYERED, {}).map((hit) => hit.entry.id);
		expect(ids.sort()).toEqual(["t/old", "t/proj", "t/src"]);
	});

	test('tier:"all" 把库本体放回来', () => {
		const ids = searchIndex(LAYERED, { target: "stm32f407", tier: "all" }).map((hit) => hit.entry.id);
		expect(ids.sort()).toEqual(["t/old", "t/proj", "t/src"]);
	});

	test('tier:"lib" 只留显式标 lib 的 —— 显式要库本体是主动收窄,未标的不在其中', () => {
		const ids = searchIndex(LAYERED, { target: "stm32f407", tier: "lib" }).map((hit) => hit.entry.id);
		expect(ids).toEqual(["t/src"]);
	});

	test("entryKind 是显式收窄:未标粒度的条目被排除", () => {
		const ids = searchIndex(LAYERED, { entryKind: "project" }).map((hit) => hit.entry.id);
		expect(ids).toEqual(["t/proj"]);
	});

	test("entryKind 接数组", () => {
		const ids = searchIndex(LAYERED, { entryKind: ["project", "corpus"] }).map((hit) => hit.entry.id);
		expect(ids.sort()).toEqual(["t/proj", "t/src"]);
	});

	test("entryKind 空数组 = 不过滤(与 corpora / peripherals 同口径)", () => {
		// `[]` 是真值。当成"过滤到零"的话,工具层传个空数组就静默零命中,而报告里
		// 只会打出一个空的「粒度=」,没人看得出发生了什么。
		expect(searchIndex(LAYERED, { entryKind: [] }).length).toBe(3);
		expect(searchIndex(LAYERED, { entryKind: [] })).toEqual(searchIndex(LAYERED, {}));
	});

	test("corpora 空数组同样不过滤", () => {
		expect(searchIndex(LAYERED, { corpora: [] })).toEqual(searchIndex(LAYERED, {}));
	});

	test("corpora 限定语料", () => {
		const mixed = [...LAYERED, entryOf({ id: "lv/x", corpus: "lvgl", ecosystem: "generic" })];
		const ids = searchIndex(mixed, { corpora: ["lvgl"] }).map((hit) => hit.entry.id);
		expect(ids).toEqual(["lv/x"]);
	});

	test("分层/粒度/证据来源进理由,不进打分", () => {
		const [hit] = searchIndex(LAYERED, { target: "stm32f407", entryKind: "project" });
		expect(hit?.reasons.join()).toContain("分层 seed");
		expect(hit?.reasons.join()).toContain("粒度 project");
		// 同 loc 同 buildable,只差三个新字段 —— 分数必须一模一样。
		const bare = searchIndex([entryOf({ id: "b/x", targets: ["stm32f4"], loc: 300 })], { target: "stm32f407" });
		expect(hit?.score).toBe(bare[0]?.score);
	});

	test("旧索引(全部未标)的结果与显式 tier:all 逐字相同", () => {
		const legacy = [entryOf({ id: "l/a", targets: ["esp32"] }), entryOf({ id: "l/b", targets: [] })];
		expect(searchIndex(legacy, { target: "esp32" })).toEqual(searchIndex(legacy, { target: "esp32", tier: "all" }));
	});
});
