// 种子:从 fixture 语料拷进临时目录,验证排除规则、出处文件、拒绝覆盖。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type ExampleEntry,
	SEED_PROVENANCE_FILE,
	seedExample,
	shouldCopy,
} from "../src/core/examples/index.ts";

const ESP_ROOT = join(import.meta.dir, "fixtures", "examples", "esp-idf-mini");

let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "yoma-examples-seed-"));
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

const MQTT: ExampleEntry = {
	id: "esp-idf@abc/examples/protocols/mqtt/tcp",
	corpus: "esp-idf@abc",
	ecosystem: "esp-idf",
	path: "examples/protocols/mqtt/tcp",
	name: "tcp",
	targets: ["esp32"],
	peripherals: ["mqtt"],
	buildable: true,
	loc: 10,
	files: 7,
	extractorVersion: 1,
};

describe("seedExample", () => {
	test("拷贝例程 + 写出处;sdkconfig.defaults 保留", () => {
		const dest = join(work, "my-mqtt");
		const result = seedExample(MQTT, ESP_ROOT, dest, "abc1234");
		expect(existsSync(join(dest, "main", "app_main.c"))).toBe(true);
		expect(existsSync(join(dest, "sdkconfig.defaults"))).toBe(true);
		const provenance = JSON.parse(readFileSync(join(dest, SEED_PROVENANCE_FILE), "utf8"));
		expect(provenance.schema).toBe("yoma/seed@1");
		expect(provenance.id).toBe(MQTT.id);
		expect(provenance.commit).toBe("abc1234");
		expect(result.dest).toBe(dest);
	});

	test("目标目录非空 → 拒绝,不覆盖", () => {
		const dest = join(work, "occupied");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "keep.txt"), "mine", "utf8");
		expect(() => seedExample(MQTT, ESP_ROOT, dest)).toThrow("非空");
		expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("mine");
	});

	test("例程目录不存在 → 人话报错指向重建账本", () => {
		const gone: ExampleEntry = { ...MQTT, path: "examples/definitely/missing" };
		expect(() => seedExample(gone, ESP_ROOT, join(work, "x"))).toThrow("重跑 CLI index");
	});
});

describe("shouldCopy", () => {
	test("build/、managed_components/、.git、机器生成的 sdkconfig 排除;defaults 保留", () => {
		expect(shouldCopy("build/log.txt")).toBe(false);
		expect(shouldCopy("managed_components/espressif__mqtt/x.c")).toBe(false);
		expect(shouldCopy(".git/HEAD")).toBe(false);
		expect(shouldCopy("sdkconfig")).toBe(false);
		expect(shouldCopy("sdkconfig.old")).toBe(false);
		expect(shouldCopy("sdkconfig.defaults")).toBe(true);
		expect(shouldCopy("main/app_main.c")).toBe(true);
	});
});
