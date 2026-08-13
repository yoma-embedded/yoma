// 富化(enrich-schema / store 富化层 / enrich 管线)验收:净化的宽收与拒收、
// 逐行容错与 commit 陈旧跳过、假模型注入下的跑批/续跑/失败不落盘,以及检索接入。
// 模型调用全程注入,零网络零 key —— 管线的正确性与哪家模型无关。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendEnrichmentRecord,
	buildEnrichPrompt,
	ENRICH_SCHEMA_TAG,
	enrichCorpus,
	enrichFileRank,
	type EnrichmentCard,
	type EnrichmentRecord,
	enrichmentMapFor,
	enrichPathFor,
	indexCorpus,
	parseEnrichmentLines,
	parseModelCardText,
	pickEnrichFiles,
	readEnrichmentRecords,
	readIndexFile,
	sanitizeEnrichmentCard,
	searchIndex,
	serializeEnrichmentRecord,
	upsertSource,
} from "../src/core/examples/index.ts";

const ESP_ROOT = join(import.meta.dir, "fixtures", "examples", "esp-idf-mini");
const CORPUS_ID = "esp-idf@fixture";
const MQTT_ID = `${CORPUS_ID}/examples/protocols/mqtt/tcp`;

function makeCard(overrides?: Partial<EnrichmentCard>): EnrichmentCard {
	return {
		summaryZh: "演示 MQTT over TCP 的最小客户端",
		capabilities: ["mqtt", "wifi"],
		footprint: { pins: [], instances: [], symbols: [], entrySymbols: ["app_main"], tasks: [] },
		...overrides,
	};
}

function makeRecord(id: string, commit: string | undefined, overrides?: Partial<EnrichmentRecord>): EnrichmentRecord {
	return {
		schema: ENRICH_SCHEMA_TAG,
		id,
		corpus: CORPUS_ID,
		commit,
		model: "faux/faux",
		enrichedAt: "2026-08-14T00:00:00.000Z",
		card: makeCard(),
		...overrides,
	};
}

describe("sanitizeEnrichmentCard", () => {
	it("整卡通过:字段原样保留,能力词小写去重排序", () => {
		const card = sanitizeEnrichmentCard({
			summaryZh: "SPI 主机 DMA 全双工",
			capabilities: ["SPI", "dma", "spi"],
			footprint: {
				pins: [{ pin: "PA5", role: "SPI1_SCK", note: "可经 menuconfig 改" }],
				instances: ["SPI1", "DMA2_Stream0"],
				symbols: ["SPI1_IRQHandler"],
				entrySymbols: ["main"],
				tasks: [{ name: "tx_task", priority: 5 }],
				partitions: "自带 partitions.csv(nvs+factory)",
			},
			notes: "依赖板载 25MHz 晶振",
		});
		expect(card).toBeDefined();
		expect(card?.capabilities).toEqual(["dma", "spi"]);
		expect(card?.footprint.pins).toEqual([{ pin: "PA5", role: "SPI1_SCK", note: "可经 menuconfig 改" }]);
		expect(card?.footprint.tasks).toEqual([{ name: "tx_task", priority: 5 }]);
		expect(card?.footprint.partitions).toContain("partitions.csv");
	});

	it('宽收字符串形状的引脚("PA5:SPI1_SCK")', () => {
		const card = sanitizeEnrichmentCard({
			summaryZh: "x",
			capabilities: [],
			footprint: { pins: ["PA5:SPI1_SCK", "PB6"] },
		});
		expect(card?.footprint.pins).toEqual([{ pin: "PA5", role: "SPI1_SCK" }, { pin: "PB6" }]);
	});

	it("缺 summaryZh 整卡拒收;缺 footprint 落成空足迹", () => {
		expect(sanitizeEnrichmentCard({ capabilities: ["spi"] })).toBeUndefined();
		const card = sanitizeEnrichmentCard({ summaryZh: "纯算法示例" });
		expect(card?.footprint).toEqual({ pins: [], instances: [], symbols: [], entrySymbols: [], tasks: [] });
	});

	it("幻觉形状不炸:数组里的垃圾条目丢弃,超长截断", () => {
		const card = sanitizeEnrichmentCard({
			summaryZh: "y".repeat(2000),
			capabilities: ["ok", 42, null],
			footprint: { pins: [{ role: "没 pin 键" }, 7], tasks: [{ priority: 3 }, { name: "t" }] },
		});
		expect(card?.summaryZh.length).toBeLessThanOrEqual(600);
		expect(card?.capabilities).toEqual(["ok"]);
		expect(card?.footprint.pins).toEqual([]);
		expect(card?.footprint.tasks).toEqual([{ name: "t" }]);
	});

	it("footprint 键存在但形状错(二次编码成字符串)→ 整卡拒收,让重跑再试", () => {
		expect(sanitizeEnrichmentCard({ summaryZh: "x", footprint: '{"pins":[]}' })).toBeUndefined();
		expect(sanitizeEnrichmentCard({ summaryZh: "x", footprint: ["pins"] })).toBeUndefined();
	});

	it("实例/符号只收标识符:散文与'(若存在)'式推测被机械过滤(真模型实测踩过)", () => {
		const card = sanitizeEnrichmentCard({
			summaryZh: "x",
			footprint: {
				instances: ["SPI2_HOST", "RMT(RMT 后端,默认)", "BLE controller"],
				symbols: ["app_main", "Error_Handler(若存在)", "SystemClock_Config(若存在)"],
				entrySymbols: ["app_main", "主入口"],
			},
		});
		expect(card?.footprint.instances).toEqual(["SPI2_HOST"]);
		expect(card?.footprint.symbols).toEqual(["app_main"]);
		expect(card?.footprint.entrySymbols).toEqual(["app_main"]);
	});
});

describe("parseModelCardText", () => {
	it("裸 JSON、围栏 JSON、前后带解释文字的 JSON 都收", () => {
		const json = '{"summaryZh":"x","capabilities":[],"footprint":{}}';
		expect(parseModelCardText(json)?.summaryZh).toBe("x");
		expect(parseModelCardText("```json\n" + json + "\n```")?.summaryZh).toBe("x");
		expect(parseModelCardText("好的,卡片如下:\n" + json + "\n以上。")?.summaryZh).toBe("x");
	});

	it("不是 JSON / 不是卡片 → undefined", () => {
		expect(parseModelCardText("模型开小差了")).toBeUndefined();
		expect(parseModelCardText('{"foo":1}')).toBeUndefined();
	});
});

describe("富化记录的序列化与容错读", () => {
	it("坏行/别的 schema 跳过,好行保留", () => {
		const good = makeRecord(MQTT_ID, "abc123");
		const text = [
			serializeEnrichmentRecord(good).trim(),
			"{ 坏 JSON",
			'{"schema":"别的东西@9","id":"x"}',
			serializeEnrichmentRecord(makeRecord(`${CORPUS_ID}/examples/get-started/hello_world`, "abc123")).trim(),
		].join("\n");
		const records = parseEnrichmentLines(text);
		expect(records).toHaveLength(2);
		expect(records[0].id).toBe(MQTT_ID);
	});
});

describe("落盘层:追加、合流、陈旧跳过", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "yoma-enrich-store-"));
		indexCorpus({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: CORPUS_ID, configDir });
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
	});

	it("追加后读得回;commit 与索引不一致的记录按陈旧跳过;同 id 后写覆盖先写", () => {
		const index = readIndexFile(CORPUS_ID, configDir);
		expect(index).toBeDefined();
		const commit = index?.header.commit;
		appendEnrichmentRecord(makeRecord(MQTT_ID, "陈旧commit"), configDir);
		appendEnrichmentRecord(makeRecord(MQTT_ID, commit), configDir);
		appendEnrichmentRecord(
			makeRecord(MQTT_ID, commit, { card: makeCard({ summaryZh: "重富化之后的摘要" }) }),
			configDir,
		);
		expect(readEnrichmentRecords(CORPUS_ID, configDir)).toHaveLength(3);
		const map = enrichmentMapFor(index as NonNullable<typeof index>, configDir);
		expect(map.size).toBe(1);
		expect(map.get(MQTT_ID)?.card.summaryZh).toBe("重富化之后的摘要");
	});

	it("富化文件整个坏掉当空,不炸", () => {
		mkdirSync(join(configDir, "examples", "enrich"), { recursive: true });
		writeFileSync(enrichPathFor(CORPUS_ID, configDir), "完全不是 JSONL", "utf8");
		expect(readEnrichmentRecords(CORPUS_ID, configDir)).toEqual([]);
	});
});

describe("buildEnrichPrompt / 文件挑选", () => {
	it("事实区 + 源码进提示词;main 源码排最前", () => {
		const configDir = mkdtempSync(join(tmpdir(), "yoma-enrich-prompt-"));
		try {
			indexCorpus({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: CORPUS_ID, configDir });
			const entry = readIndexFile(CORPUS_ID, configDir)?.entries.find((item) => item.id === MQTT_ID);
			expect(entry).toBeDefined();
			const { user } = buildEnrichPrompt(
				entry as NonNullable<typeof entry>,
				join(ESP_ROOT, "examples", "protocols", "mqtt", "tcp"),
			);
			expect(user).toContain(`例程 ${MQTT_ID}`);
			expect(user).toContain("─── 文件 main/app_main.c ───");
			expect(user.indexOf("app_main.c")).toBeLessThan(user.indexOf("README.md"));
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("排序表:main 最前,脚手架(conf/system_)不进", () => {
		expect(enrichFileRank("main/app_main.c")).toBe(0);
		expect(enrichFileRank("Src/main.c")).toBe(0);
		expect(enrichFileRank("Src/stm32f4xx_it.c")).toBe(1);
		expect(enrichFileRank("Src/stm32f4xx_hal_msp.c")).toBe(1);
		expect(enrichFileRank("Inc/stm32f4xx_hal_conf.h")).toBe(-1);
		expect(enrichFileRank("Src/system_stm32f4xx.c")).toBe(-1);
		expect(enrichFileRank("firmware.bin")).toBe(-1);
	});

	it("超预算:单文件截头并标记,总量 32k 封顶,超出的文件不进", () => {
		const dir = mkdtempSync(join(tmpdir(), "yoma-enrich-clip-"));
		try {
			for (const name of ["main.c", "b.c", "c.c", "d.c", "e.c"]) {
				writeFileSync(join(dir, name), "x".repeat(30_000), "utf8");
			}
			const files = pickEnrichFiles(dir);
			expect(files).toHaveLength(4);
			expect(files[0].relPath).toBe("main.c");
			expect(files[0].text).toContain("…(截断)");
			const total = files.reduce((sum, file) => sum + file.text.length, 0);
			expect(total).toBeLessThanOrEqual(32_100);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("enrichCorpus 跑批", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "yoma-enrich-run-"));
		indexCorpus({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: CORPUS_ID, configDir });
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
	});

	const okCompletion = async (): Promise<string> =>
		'```json\n{"summaryZh":"假模型写的摘要","capabilities":["mqtt"],"footprint":{"entrySymbols":["app_main"]}}\n```';

	it("全量跑成 → 逐条落盘带索引 commit;续跑全跳过", async () => {
		const first = await enrichCorpus({ corpusId: CORPUS_ID, configDir, complete: okCompletion, model: "faux/faux" });
		expect(first.total).toBe(3);
		expect(first.enriched).toBe(3);
		expect(first.failed).toEqual([]);
		const index = readIndexFile(CORPUS_ID, configDir);
		const map = enrichmentMapFor(index as NonNullable<typeof index>, configDir);
		expect(map.size).toBe(3);
		expect(map.get(MQTT_ID)?.commit).toBe(index?.header.commit);

		const second = await enrichCorpus({ corpusId: CORPUS_ID, configDir, complete: okCompletion, model: "faux/faux" });
		expect(second.already).toBe(3);
		expect(second.attempted).toBe(0);
	});

	it("模型输出垃圾 → 记失败不落盘;limit 只补前 N 个缺口", async () => {
		const bad = await enrichCorpus({
			corpusId: CORPUS_ID,
			configDir,
			complete: async () => "不是 JSON",
			model: "faux/faux",
			limit: 2,
		});
		expect(bad.attempted).toBe(2);
		expect(bad.enriched).toBe(0);
		expect(bad.failed).toHaveLength(2);
		expect(bad.failed[0].error).toContain("不是合法卡片");
		expect(readEnrichmentRecords(CORPUS_ID, configDir)).toEqual([]);
	});

	it("并发/limit 是垃圾值(NaN)时不静默空跑:attempted 恒等于 enriched+failed", async () => {
		// --concurrency abc 曾让 Array.from({length: NaN}) 起 0 个 worker,零报错退出码 0(审查实测)。
		const result = await enrichCorpus({
			corpusId: CORPUS_ID,
			configDir,
			complete: okCompletion,
			model: "faux/faux",
			concurrency: Number.parseInt("abc", 10),
			limit: Number.parseInt("abc", 10),
		});
		expect(result.attempted).toBe(3);
		expect(result.enriched).toBe(3);
		expect(result.attempted).toBe(result.enriched + result.failed.length);
	});

	it("语料根丢失 → 每条以守卫话术失败,一个模型请求都不发", async () => {
		upsertSource({ id: CORPUS_ID, ecosystem: "esp-idf", root: join(configDir, "nowhere") }, configDir);
		let calls = 0;
		const result = await enrichCorpus({
			corpusId: CORPUS_ID,
			configDir,
			complete: async () => {
				calls++;
				return "{}";
			},
			model: "faux/faux",
		});
		expect(result.failed).toHaveLength(3);
		expect(result.failed[0].error).toContain("读不到任何可分析文件");
		expect(calls).toBe(0);
	});

	it("单条抛异常不连累整批", async () => {
		let calls = 0;
		const flaky = async (): Promise<string> => {
			// 每条重试一次:第一条(两次调用)都炸,其余成功。
			calls++;
			if (calls <= 2) throw new Error("HTTP 500");
			return okCompletion();
		};
		const result = await enrichCorpus({
			corpusId: CORPUS_ID,
			configDir,
			complete: flaky,
			model: "faux/faux",
			concurrency: 1,
		});
		expect(result.enriched).toBe(2);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].error).toContain("HTTP 500");
	}, 15_000);
});

describe("检索接入富化", () => {
	it("能力词并进外设匹配,中文摘要可被关键词命中,结果带卡片", () => {
		const configDir = mkdtempSync(join(tmpdir(), "yoma-enrich-search-"));
		try {
			indexCorpus({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: CORPUS_ID, configDir });
			const index = readIndexFile(CORPUS_ID, configDir);
			const commit = index?.header.commit;
			const helloId = `${CORPUS_ID}/examples/get-started/hello_world`;
			appendEnrichmentRecord(
				makeRecord(helloId, commit, {
					card: makeCard({ summaryZh: "演示低功耗打印后重启", capabilities: ["lowpower"] }),
				}),
				configDir,
			);
			const map = enrichmentMapFor(index as NonNullable<typeof index>, configDir);
			const entries = (index as NonNullable<typeof index>).entries;

			// 脚本抽取给不出 lowpower,这一下只能靠富化的能力词命中。
			const byCapability = searchIndex(entries, { peripherals: ["lowpower"] }, map);
			expect(byCapability.map((hit) => hit.entry.id)).toEqual([helloId]);
			expect(byCapability[0].enrichment?.card.summaryZh).toContain("低功耗");

			// 不带富化表跑同一查询 → 行为回到从前(零命中)。
			expect(searchIndex(entries, { peripherals: ["lowpower"] })).toEqual([]);

			// 中文摘要作为弱证据可被关键词搜到。
			const byKeyword = searchIndex(entries, { keywords: ["低功耗"] }, map);
			expect(byKeyword.some((hit) => hit.entry.id === helloId)).toBe(true);

			// limit 为 NaN 不许把主检索路径截成"没有命中"的假阴性(审查实测)。
			expect(searchIndex(entries, { limit: Number.parseInt("abc", 10) }).length).toBeGreaterThan(0);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});
