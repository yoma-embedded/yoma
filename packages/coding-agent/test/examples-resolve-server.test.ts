/**
 * 例程库同步的服务器地址(examples/sync.ts 的 resolveSyncServer)。
 *
 * 它与 datasheet 工具指的是**同一台**服务器、走**同一份**解析实现
 * (core/datasheet-server.ts),这里钉的就是这件事:显式 > `YOMA_DATASHEET_SERVER` >
 * `<configDir>/.env` > 内置默认,off 关闭。从前 examples 侧有自己的一套读法,
 * 结果是"桌面端能同步、bench 说没配地址"。
 *
 * resolveSyncServer 不收 env 注入(签名只有 explicit + configDir),所以进程环境
 * 必须存/还原 —— 开发机上真配了 YOMA_DATASHEET_SERVER 的话断言会看它的脸色。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DATASHEET_SERVER } from "../src/core/datasheet-server.ts";
import { resolveSyncServer } from "../src/core/examples/sync.ts";

const roots: string[] = [];
const VARS = ["YOMA_DATASHEET_SERVER", "YOMA_ENV_FILE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const name of VARS) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	for (const name of VARS) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "yoma-examples-server-"));
	roots.push(dir);
	return dir;
}

function configWithEnvFile(contents: string): string {
	const dir = tempDir();
	writeFileSync(join(dir, ".env"), contents);
	return dir;
}

describe("resolveSyncServer", () => {
	it("显式地址压过环境变量与 .env,并剥掉尾斜杠", () => {
		process.env.YOMA_DATASHEET_SERVER = "http://from-env";
		const configDir = configWithEnvFile("YOMA_DATASHEET_SERVER=http://from-file\n");
		expect(resolveSyncServer("http://explicit/", configDir)).toBe("http://explicit");
	});

	it("没有显式地址时读环境变量", () => {
		process.env.YOMA_DATASHEET_SERVER = "http://from-env/";
		expect(resolveSyncServer(undefined, configWithEnvFile("YOMA_DATASHEET_SERVER=http://from-file\n"))).toBe(
			"http://from-env",
		);
	});

	it("环境变量没有时读 <configDir>/.env(与 datasheet 工具同一份配置)", () => {
		expect(resolveSyncServer(undefined, configWithEnvFile("YOMA_DATASHEET_SERVER=http://from-file/\n"))).toBe(
			"http://from-file",
		);
	});

	it("一层都没配:回落到内置默认", () => {
		expect(resolveSyncServer(undefined, tempDir())).toBe(DEFAULT_DATASHEET_SERVER);
	});

	it("off 表示显式关闭,返回 undefined 而不是回落到默认", () => {
		expect(resolveSyncServer("off", tempDir())).toBeUndefined();
		expect(resolveSyncServer(undefined, configWithEnvFile("YOMA_DATASHEET_SERVER=None\n"))).toBeUndefined();
		process.env.YOMA_DATASHEET_SERVER = "0";
		expect(resolveSyncServer(undefined, tempDir())).toBeUndefined();
	});
});
