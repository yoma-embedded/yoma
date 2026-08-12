// examples 工具(core/tools/examples.ts)验收:三个 action 的胶水接线 + 无索引话术 +
// seed 的拒绝路径。检索/抽取的行为在 core/examples 各测试里已经覆盖,这里只验
// "参数 -> core 调用 -> 渲染/details"这条工具层。configDir 全程 mkdtemp 注入。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@yoma/my-pi/node";

import { indexCorpus } from "../src/core/examples/index.ts";
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
