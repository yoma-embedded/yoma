// examples 工具(core/tools/examples.ts)验收:五个 action 的胶水接线 + 无索引话术 +
// seed 的拒绝路径 + generic 语料(零命中提示、单文件 seed、下一步文案)+ sync 清单。
// 检索/抽取的行为在 core/examples 各测试里已经覆盖,这里只验"参数 -> core 调用 ->
// 渲染/details"这条工具层。configDir 全程 mkdtemp 注入;sync 用本地假服务器,零网络。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@yoma/agent/node";

import {
	appendEnrichmentRecord,
	ENRICH_SCHEMA_TAG,
	type ExampleEntry,
	INDEX_SCHEMA_TAG,
	indexCorpus,
	readIndexFile,
	type ResourceFootprint,
	upsertSource,
	writeIndexFile,
} from "../../src/core/examples/index.ts";
import { createExamplesToolDefinition } from "../tools/examples.ts";

const ESP_ROOT = join(import.meta.dirname, "..", "..", "test", "fixtures", "examples", "esp-idf-mini");
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

function makeTool(dir: string = configDir, syncServer?: string) {
	const env = new NodeExecutionEnv({ cwd: workDir });
	return createExamplesToolDefinition(env, { configDir: dir, syncServer });
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

	it("没有任何索引 → 人话:先 sync 服务器语料,再给本机 CLI 命令,不抛", async () => {
		const empty = mkdtempSync(join(tmpdir(), "yoma-examples-tool-empty-"));
		try {
			const result = await makeTool(empty).execute("t1", {});
			const text = textOf(result);
			expect(text).toContain("还没有同步任何语料索引");
			expect(text).toContain("examples sync");
			expect(text).toContain("cli.ts index");
			expect(result.details?.count).toBe(0);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("非法 ecosystem → 报错文案列出全部三种生态(含 generic)", async () => {
		await expect(makeTool().execute("t1", { action: "search", ecosystem: "arduino" })).rejects.toThrow(
			"esp-idf / stm32cube / generic",
		);
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

// ─── generic 语料(第三方库,agent 索引的产物形状)────────────────────────────
//
// 现网 45 个语料全是 generic:targets 多为空、buildable 恒 false、约五分之一的条目是
// 单文件(ff.c / lfs.c / cJSON.c)。工具层对它们的话术与单文件 seed 从前都没有覆盖。

const GENERIC_ID = "fatfs@fixture";
const FF_C_ID = `${GENERIC_ID}/source/ff.c`;
const BLINKY_ID = `${GENERIC_ID}/examples/blinky`;

function genericEntry(
	path: string,
	entryKind: "project" | "module",
	title: string,
	peripherals: string[],
	loc: number,
): ExampleEntry {
	return {
		id: `${GENERIC_ID}/${path}`,
		corpus: GENERIC_ID,
		ecosystem: "generic",
		path,
		name: path.split("/").pop() ?? path,
		title,
		targets: [],
		peripherals,
		buildable: false,
		buildNote: "generic 语料,未验证可编译",
		loc,
		files: 1,
		entryKind,
		tier: "seed",
		extractorVersion: 1,
	};
}

/** 最小 generic 语料:一个单文件模块 + 一个例程工程,索引手写成 agent 索引的产物形状。 */
function makeGenericCorpus(dir: string): string {
	const root = mkdtempSync(join(tmpdir(), "yoma-examples-tool-generic-"));
	mkdirSync(join(root, "source"), { recursive: true });
	writeFileSync(join(root, "source", "ff.c"), "int f_open(void) { return 0; }\n");
	mkdirSync(join(root, "examples", "blinky"), { recursive: true });
	writeFileSync(join(root, "examples", "blinky", "main.c"), "int main(void) { return 0; }\n");
	writeFileSync(join(root, "examples", "blinky", "Makefile"), "all:\n");
	writeIndexFile(
		{
			header: {
				schema: INDEX_SCHEMA_TAG,
				corpus: GENERIC_ID,
				ecosystem: "generic",
				commit: "abc1234",
				generatedAt: "2026-09-06T00:00:00.000Z",
				entries: 2,
				indexer: "agent",
				libraryKind: "可移植库",
			},
			entries: [
				genericEntry("source/ff.c", "module", "FatFs 文件系统核心实现 ff.c", ["fatfs", "filesystem"], 7256),
				genericEntry("examples/blinky", "project", "闪灯例程工程", ["gpio", "timer"], 40),
			],
		},
		dir,
	);
	upsertSource({ id: GENERIC_ID, ecosystem: "generic", root }, dir);
	return root;
}

describe("generic 语料(第三方库)", () => {
	let genericRoot: string;

	beforeEach(() => {
		genericRoot = makeGenericCorpus(configDir);
	});

	afterEach(() => {
		rmSync(genericRoot, { recursive: true, force: true });
	});

	it("ecosystem=generic 是合法过滤,按外设词命中单文件模块", async () => {
		const result = await makeTool().execute("t1", {
			action: "search",
			ecosystem: "generic",
			peripherals: ["filesystem"],
		});
		expect(result.details?.hitIds).toEqual([FF_C_ID]);
	});

	it("过滤一个本机没有的厂商生态 → 零命中,点名本机只有哪些生态、别当成语料缺失、去 sync", async () => {
		const result = await makeTool().execute("t1", {
			action: "search",
			ecosystem: "stm32cube",
			target: "stm32f4",
			peripherals: ["uart"],
		});
		const text = textOf(result);
		expect(result.details?.count).toBe(0);
		expect(text).toContain("本机没有 stm32cube 生态的语料");
		expect(text).toContain("generic");
		expect(text).toContain("语料缺失");
		expect(text).toContain("examples sync");
	});

	it("buildableOnly 在 generic 语料上零命中 → 提示 buildable 恒 false、去掉这个条件", async () => {
		const result = await makeTool().execute("t1", { action: "search", ecosystem: "generic", buildableOnly: true });
		expect(result.details?.count).toBe(0);
		expect(textOf(result)).toContain("buildable 恒为 false");
	});

	it("外设词零命中 → 提示精确匹配与同义词;带芯片没给 tier → 提示 tier all", async () => {
		const result = await makeTool().execute("t1", { action: "search", target: "stm32f407", peripherals: ["littlefs"] });
		const text = textOf(result);
		expect(result.details?.count).toBe(0);
		expect(text).toContain("精确匹配");
		expect(text).toContain('tier:"all"');
	});

	it("单文件条目 seed → 落进以库名命名的目录 + 旁挂出处 + 下一步讲接进构建;同名文件拒绝覆盖", async () => {
		const result = await makeTool().execute("t1", { action: "seed", id: FF_C_ID });
		const dest = join(workDir, "fatfs", "ff.c");
		expect(result.details?.seededTo).toBe(dest);
		expect(readFileSync(dest, "utf8")).toContain("f_open");
		const provenance = JSON.parse(readFileSync(join(workDir, "fatfs", "ff.c.yoma-seed.json"), "utf8"));
		expect(provenance.id).toBe(FF_C_ID);
		expect(provenance.commit).toBe("abc1234");
		expect(provenance.sourcePath).toBe("source/ff.c");
		expect(textOf(result)).toContain("接进你自己的工程构建");
		await expect(makeTool().execute("t2", { action: "seed", id: FF_C_ID })).rejects.toThrow("已存在");
	});

	it("generic 例程工程 seed → 下一步讲种子不自包含、在语料树内构建,不再讲 STM32Cube 固件包", async () => {
		const result = await makeTool().execute("t1", { action: "seed", id: BLINKY_ID, dest: "blink" });
		expect(existsSync(join(workDir, "blink", "main.c"))).toBe(true);
		expect(existsSync(join(workDir, "blink", ".yoma-seed.json"))).toBe(true);
		const text = textOf(result);
		expect(text).toContain("不自包含");
		expect(text).toContain("语料缓存树");
		expect(text).not.toContain("STM32Cube");
	});

	it("单文件条目 info → 报文件大小与读法,不说目录为空", async () => {
		const result = await makeTool().execute("t1", { action: "info", id: FF_C_ID });
		const text = textOf(result);
		expect(text).toContain("单文件条目:ff.c");
		expect(text).not.toContain("目录为空");
	});
});

// ─── sync(本地假服务器)──────────────────────────────────────────────────────

describe("sync 清单与落地", () => {
	const REMOTE_ID = "littlefs@test";
	const INDEX_TEXT = `${[
		JSON.stringify({
			schema: INDEX_SCHEMA_TAG,
			corpus: REMOTE_ID,
			ecosystem: "generic",
			commit: "def5678",
			generatedAt: "2026-09-06T00:00:00.000Z",
			entries: 1,
		}),
		JSON.stringify({
			id: `${REMOTE_ID}/lfs.c`,
			corpus: REMOTE_ID,
			ecosystem: "generic",
			path: "lfs.c",
			name: "lfs.c",
			title: "littlefs 核心 lfs.c",
			targets: [],
			peripherals: ["littlefs", "filesystem"],
			buildable: false,
			loc: 6000,
			files: 1,
			entryKind: "module",
			tier: "seed",
			extractorVersion: 1,
		}),
	].join("\n")}\n`;
	const META = {
		id: REMOTE_ID,
		ecosystem: "generic",
		commit: "def5678",
		ref: "test",
		description: "文件系统与存储|littlefs|BSD-3|掉电安全的小型文件系统",
		entries: 1,
		targets: [],
		archiveSha256: "0".repeat(64),
		archiveBytes: 123_456,
		indexSha256: createHash("sha256").update(INDEX_TEXT).digest("hex"),
		enrichSha256: null,
		publishedAt: "2026-09-06T00:00:00Z",
	};

	let server: Server;
	let baseUrl: string;

	beforeEach(async () => {
		server = createServer((req, res) => {
			const url = decodeURIComponent((req.url ?? "").split("?")[0]);
			const body =
				url === "/api/codelibs"
					? JSON.stringify([META])
					: url === `/api/codelibs/${REMOTE_ID}/meta`
						? JSON.stringify(META)
						: url === `/api/codelibs/${REMOTE_ID}/index`
							? INDEX_TEXT
							: undefined;
			if (body === undefined) {
				res.writeHead(404);
				res.end("no such object");
				return;
			}
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("不带 corpus → 清单带本机状态 / 体积 / 芯片声明 / 服务器描述,并说明 search 只查已同步的", async () => {
		const result = await makeTool(configDir, baseUrl).execute("t1", { action: "sync" });
		const text = textOf(result);
		expect(text).toContain("已发布 1 个语料");
		expect(text).toContain("littlefs@test | generic | 1 条 | 123 KB | 未同步 | 芯片:未声明");
		expect(text).toContain("掉电安全的小型文件系统");
		expect(text).toContain("search 只查已同步的");
	});

	it("带 corpus → 索引落地,清单状态变成「索引就绪」,search 立即可查;不存在的 id 报人话", async () => {
		const synced = await makeTool(configDir, baseUrl).execute("t1", { action: "sync", corpus: REMOTE_ID });
		const syncedText = textOf(synced);
		expect(syncedText).toContain("1 条");
		expect(syncedText).toContain("code:true");
		expect(synced.details?.corpusId).toBe(REMOTE_ID);

		const listing = textOf(await makeTool(configDir, baseUrl).execute("t2", { action: "sync" }));
		expect(listing).toContain("已同步 1 个");
		expect(listing).toContain("索引就绪,代码未落地");

		const found = await makeTool(configDir, baseUrl).execute("t3", { action: "search", peripherals: ["littlefs"] });
		expect(found.details?.hitIds).toEqual([`${REMOTE_ID}/lfs.c`]);

		await expect(makeTool(configDir, baseUrl).execute("t4", { action: "sync", corpus: "nope@x" })).rejects.toThrow(
			"确切 id",
		);
	});
});
