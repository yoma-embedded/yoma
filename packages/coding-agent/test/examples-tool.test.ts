// examples 工具(core/tools/examples.ts)验收:三个 action 的胶水接线 + 无索引话术 +
// seed 的拒绝路径。检索/抽取的行为在 core/examples 各测试里已经覆盖,这里只验
// "参数 -> core 调用 -> 渲染/details"这条工具层。configDir 全程 mkdtemp 注入。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@yoma/my-pi/node";

import {
	appendEnrichmentRecord,
	ENRICH_SCHEMA_TAG,
	indexCorpus,
	readIndexFile,
	type ResourceFootprint,
} from "../src/core/examples/index.ts";
import { createExamplesToolDefinition } from "../src/core/tools/examples.ts";

const ESP_ROOT = join(import.meta.dir, "fixtures", "examples", "esp-idf-mini");
const CORPUS_ID = "esp-idf@fixture";
const MQTT_ID = `${CORPUS_ID}/examples/protocols/mqtt/tcp`;

let configDir: string;
let workDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "yoma-examples-tool-config-"));
	workDir = mkdtempSync(join(tmpdir(), "yoma-examples-tool-work-"));
	indexCorpus({ root: ESP_ROOT, ecosystem: "esp-idf", corpusId: CORPUS_ID, configDir });
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

function makeTool(dir: string = configDir) {
	const env = new NodeExecutionEnv({ cwd: workDir });
	return createExamplesToolDefinition(env, { configDir: dir });
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

describe("search", () => {
	it("命中 fixture 语料并回填 hitIds", async () => {
		const result = await makeTool().execute("t1", { action: "search", peripherals: ["mqtt"] });
		expect(textOf(result)).toContain(MQTT_ID);
		expect(result.details?.count).toBe(1);
		expect(result.details?.hitIds).toEqual([MQTT_ID]);
	});

	it("没有任何索引 → 人话给出 CLI 命令,不抛", async () => {
		const empty = mkdtempSync(join(tmpdir(), "yoma-examples-tool-empty-"));
		try {
			const result = await makeTool(empty).execute("t1", {});
			expect(textOf(result)).toContain("还没有任何例程索引");
			expect(textOf(result)).toContain("cli.ts index");
			expect(result.details?.count).toBe(0);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("info", () => {
	it("整卡 + 顶层内容 + 验收素材", async () => {
		const result = await makeTool().execute("t1", { action: "info", id: MQTT_ID });
		const text = textOf(result);
		expect(text).toContain("ESP-MQTT sample application");
		expect(text).toContain("顶层内容");
		expect(text).toContain("pytest_mqtt.py");
		expect(result.details?.id).toBe(MQTT_ID);
	});

	it("id 不存在 → 指回 search", async () => {
		await expect(makeTool().execute("t1", { action: "info", id: "esp-idf@fixture/nope" })).rejects.toThrow(
			"找不到条目",
		);
	});

	it("缺 id → 报错点名参数", async () => {
		await expect(makeTool().execute("t1", { action: "info" })).rejects.toThrow("需要 id");
	});
});

describe("seed", () => {
	it("拷进工作区 + 出处含语料 commit + 下一步是先原样跑通", async () => {
		const result = await makeTool().execute("t1", { action: "seed", id: MQTT_ID, dest: "my-mqtt" });
		const dest = join(workDir, "my-mqtt");
		expect(result.details?.seededTo).toBe(dest);
		expect(existsSync(join(dest, "main", "app_main.c"))).toBe(true);
		const provenance = JSON.parse(readFileSync(join(dest, ".yoma-seed.json"), "utf8"));
		expect(provenance.id).toBe(MQTT_ID);
		// fixture 语料就在本仓里,detectGitCommit 一定探得到 —— 出处必须能指认版本。
		expect(typeof provenance.commit).toBe("string");
		expect(textOf(result)).toContain("原样");
	});

	it("目标非空 → 拒绝", async () => {
		await makeTool().execute("t1", { action: "seed", id: MQTT_ID, dest: "twice" });
		await expect(makeTool().execute("t2", { action: "seed", id: MQTT_ID, dest: "twice" })).rejects.toThrow("非空");
	});
});

const HELLO_ID = `${CORPUS_ID}/examples/get-started/hello_world`;

function appendCard(id: string, footprint: Partial<ResourceFootprint>): void {
	const index = readIndexFile(CORPUS_ID, configDir);
	appendEnrichmentRecord(
		{
			schema: ENRICH_SCHEMA_TAG,
			id,
			corpus: CORPUS_ID,
			commit: index?.header.commit,
			model: "faux/faux",
			enrichedAt: "2026-08-14T00:00:00.000Z",
			card: {
				summaryZh: `${id} 的富化摘要`,
				capabilities: [],
				footprint: { pins: [], instances: [], symbols: [], entrySymbols: [], tasks: [], ...footprint },
			},
		},
		configDir,
	);
}

describe("preflight", () => {
	it("少于 2 个 id / 重复 id / 不存在的 id → 分别点名报错", async () => {
		await expect(makeTool().execute("t1", { action: "preflight", ids: [MQTT_ID] })).rejects.toThrow("至少 2 个");
		await expect(makeTool().execute("t1", { action: "preflight", ids: [MQTT_ID, MQTT_ID] })).rejects.toThrow(
			"重复",
		);
		await expect(
			makeTool().execute("t1", { action: "preflight", ids: [MQTT_ID, `${CORPUS_ID}/nope`] }),
		).rejects.toThrow("找不到条目");
	});

	it("都没富化 → 全员盲区,零重叠,如实说", async () => {
		const result = await makeTool().execute("t1", { action: "preflight", ids: [MQTT_ID, HELLO_ID] });
		const text = textOf(result);
		expect(text).toContain("盲区(未富化");
		expect(result.details?.conflicts).toBe(0);
		expect(result.details?.ids).toEqual([MQTT_ID, HELLO_ID]);
	});

	it("有富化卡片 → 引脚/符号重叠报出来,details 记条数", async () => {
		appendCard(MQTT_ID, { pins: [{ pin: "GPIO4", role: "I2C SDA" }], symbols: ["app_wifi_init"] });
		appendCard(HELLO_ID, { pins: [{ pin: "gpio_num_4", role: "LED" }], symbols: ["app_wifi_init"] });
		const result = await makeTool().execute("t1", { action: "preflight", ids: [MQTT_ID, HELLO_ID] });
		const text = textOf(result);
		expect(text).toContain("[引脚] GPIO4");
		expect(text).toContain("[符号] 符号 app_wifi_init");
		expect(result.details?.conflicts).toBe(2);
	});
});

describe("info 带富化", () => {
	it("有卡片时整卡展示足迹", async () => {
		appendCard(MQTT_ID, { instances: ["I2C0"], entrySymbols: ["app_main"] });
		const result = await makeTool().execute("t1", { action: "info", id: MQTT_ID });
		const text = textOf(result);
		expect(text).toContain("富化(faux/faux");
		expect(text).toContain("实例 I2C0");
	});
});

describe("search 带富化", () => {
	it("命中行带模型摘要 —— 钉住 searchIndex 第三个实参的接线(变异实验漏过这条)", async () => {
		appendCard(MQTT_ID, { entrySymbols: ["app_main"] });
		const result = await makeTool().execute("t1", { action: "search", peripherals: ["mqtt"] });
		expect(textOf(result)).toContain(`${MQTT_ID} 的富化摘要`);
	});
});
