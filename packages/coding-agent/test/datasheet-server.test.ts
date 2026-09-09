/**
 * 数据手册服务器地址解析(core/datasheet-server.ts)—— 所有宿主(桌面内核、桌面主进程的
 * 手册库页、bench/信箱的 turn 子进程、ACP)共用的**唯一**一份实现,所以优先级、关闭值、
 * 归一化这三件事必须逐条钉死:从前这段逻辑有两份手抄,"桌面端配了、bench 看不见"是常态。
 *
 * env 一律显式注入、configDir 一律 mkdtemp:不注入的话开发机上真配的
 * YOMA_DATASHEET_SERVER 或真实的 ~/.yoma/.env 会决定断言(根 CLAUDE.md 的隔离纪律)。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	DATASHEET_ENV_FILE_ENV,
	DATASHEET_SERVER_ENV,
	DEFAULT_DATASHEET_SERVER,
	defaultConfigDir,
	isDisabledValue,
	readEnvFile,
	resolveDatasheetServer,
} from "../src/core/datasheet-server.ts";

const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "yoma-datasheet-server-"));
	roots.push(dir);
	return dir;
}

/** 在一个新的 configDir 里写 `.env`,返回目录。 */
function configWithEnvFile(contents: string): string {
	const dir = tempDir();
	writeFileSync(join(dir, ".env"), contents);
	return dir;
}

describe("优先级:显式 > 环境变量 > <configDir>/.env > 内置默认", () => {
	it("显式参数压过其它所有层", () => {
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=http://from-file\n`);
		const resolution = resolveDatasheetServer({
			explicit: "http://from-explicit",
			env: { [DATASHEET_SERVER_ENV]: "http://from-env" },
			configDir,
		});
		expect(resolution).toEqual({ url: "http://from-explicit", source: "explicit" });
	});

	it("没有显式参数时环境变量压过 .env", () => {
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=http://from-file\n`);
		const resolution = resolveDatasheetServer({ env: { [DATASHEET_SERVER_ENV]: "http://from-env" }, configDir });
		expect(resolution).toEqual({ url: "http://from-env", source: "env" });
	});

	it("环境变量没有时读 <configDir>/.env,并带上文件路径(排查用)", () => {
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=http://from-file\n`);
		const resolution = resolveDatasheetServer({ env: {}, configDir });
		expect(resolution.url).toBe("http://from-file");
		expect(resolution.source).toBe("file");
		expect(resolution.file).toBe(join(configDir, ".env"));
	});

	it("一层都没配:落到内置默认(装完即可查手册,不用手填地址)", () => {
		const resolution = resolveDatasheetServer({ env: {}, configDir: tempDir() });
		expect(resolution).toEqual({ url: DEFAULT_DATASHEET_SERVER, source: "builtin" });
	});

	it(`$${DATASHEET_ENV_FILE_ENV} 指定的文件压过 <configDir>/.env`, () => {
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=http://from-config-dir\n`);
		const other = tempDir();
		const file = join(other, "custom.env");
		writeFileSync(file, `${DATASHEET_SERVER_ENV}=http://from-custom-file\n`);

		const resolution = resolveDatasheetServer({ env: { [DATASHEET_ENV_FILE_ENV]: file }, configDir });
		expect(resolution.url).toBe("http://from-custom-file");
		expect(resolution.source).toBe("file");
		expect(resolution.file).toBe(file);
	});

	it(".env 不存在不是错误,静静回落(纯配置读取,失败的最坏后果是当没配)", () => {
		const resolution = resolveDatasheetServer({ env: {}, configDir: join(tempDir(), "does-not-exist") });
		expect(resolution.source).toBe("builtin");
	});

	it("builtIn:null = 没有内置默认(测试复现「未配置」那条路)", () => {
		const resolution = resolveDatasheetServer({ env: {}, configDir: tempDir(), builtIn: null });
		expect(resolution).toEqual({ url: undefined, source: "none" });
	});

	it("builtIn 可以被换成自建地址", () => {
		const resolution = resolveDatasheetServer({ env: {}, configDir: tempDir(), builtIn: "http://mine:8080/" });
		expect(resolution).toEqual({ url: "http://mine:8080", source: "builtin" });
	});
});

describe("归一化", () => {
	it("尾部斜杠一律剥掉(每一层都剥,拼 `${server}/api/search` 才不会变成双斜杠)", () => {
		expect(resolveDatasheetServer({ explicit: "http://a.b///", env: {}, configDir: tempDir() }).url).toBe("http://a.b");
		expect(
			resolveDatasheetServer({ env: { [DATASHEET_SERVER_ENV]: "http://a.b/" }, configDir: tempDir() }).url,
		).toBe("http://a.b");
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=http://a.b/\n`);
		expect(resolveDatasheetServer({ env: {}, configDir }).url).toBe("http://a.b");
	});

	it("两端空白无关", () => {
		expect(resolveDatasheetServer({ explicit: "  http://a.b  ", env: {}, configDir: tempDir() }).url).toBe("http://a.b");
	});

	it("空字符串当没配,不是「关闭」", () => {
		const resolution = resolveDatasheetServer({ explicit: "   ", env: {}, configDir: tempDir() });
		expect(resolution.source).toBe("builtin");
	});
});

describe("显式关闭(off / none / false / 0)", () => {
	const disabled = ["off", "none", "false", "0", "OFF", "None", "FALSE", " Off "];

	it("isDisabledValue 不分大小写、两端空白无关", () => {
		for (const value of disabled) expect(isDisabledValue(value)).toBe(true);
		for (const value of ["http://a.b", "offline", "0.0.0.0", ""]) expect(isDisabledValue(value)).toBe(false);
	});

	it("显式参数写关闭值:url undefined、source off,不回落到默认", () => {
		for (const value of disabled) {
			const resolution = resolveDatasheetServer({ explicit: value, env: {}, configDir: tempDir() });
			expect(resolution.url).toBeUndefined();
			expect(resolution.source).toBe("off");
		}
	});

	it("环境变量写关闭值:同样不回落", () => {
		for (const value of disabled) {
			const resolution = resolveDatasheetServer({ env: { [DATASHEET_SERVER_ENV]: value }, configDir: tempDir() });
			expect(resolution.url).toBeUndefined();
			expect(resolution.source).toBe("off");
		}
	});

	it(".env 写关闭值:同样不回落,并带上是哪个文件说的", () => {
		const configDir = configWithEnvFile(`${DATASHEET_SERVER_ENV}=OFF\n`);
		const resolution = resolveDatasheetServer({ env: {}, configDir });
		expect(resolution.url).toBeUndefined();
		expect(resolution.source).toBe("off");
		expect(resolution.file).toBe(join(configDir, ".env"));
	});
});

describe("readEnvFile", () => {
	it("KEY=value、# 整行注释、空行、成对引号", () => {
		const dir = tempDir();
		const file = join(dir, ".env");
		writeFileSync(
			file,
			[
				"# 这一行是注释",
				"",
				'QUOTED="http://quoted"',
				"SINGLE='http://single'",
				"  SPACED  =  http://spaced  ",
				"NO_EQUALS_SIGN",
				"EMPTY=",
			].join("\n"),
		);

		expect(readEnvFile(file)).toEqual({
			QUOTED: "http://quoted",
			SINGLE: "http://single",
			SPACED: "http://spaced",
		});
	});

	it("同一个键写了两次:第一次赢(与 dotenv 同解)", () => {
		const dir = tempDir();
		const file = join(dir, ".env");
		writeFileSync(file, `${DATASHEET_SERVER_ENV}=http://first\n${DATASHEET_SERVER_ENV}=http://second\n`);
		expect(readEnvFile(file)[DATASHEET_SERVER_ENV]).toBe("http://first");
	});

	it("文件不存在返回空对象,不抛", () => {
		expect(readEnvFile(join(tempDir(), "nope.env"))).toEqual({});
	});
});

describe("defaultConfigDir", () => {
	it("就是 ~/.yoma(与内核 yomaConfigDir / 账本 defaultConfigDir 同一个目录)", () => {
		expect(defaultConfigDir().endsWith(".yoma")).toBe(true);
	});
});
