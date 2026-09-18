/**
 * 2026-09-18 那次会话(`D:\toy\funny_pen\f_pen`,ESP-IDF 装在 D 盘)踩出来的全部回归,一条一个用例。
 * 模型为了让 `idf` 这一个工具落定试了四轮,每一轮撞的都是这里的一条:
 *
 * 1. 清单只写 `{"id":"idf"}` → MISSING、连安装提示都没有(条目不继承预设)。
 * 2. IDF 装在默认位置、纯自动发现 → RECORDED(已知位置档产出的是 `tools\idf.py` 这个**文件**,dir 型只认目录)。
 * 3. `set idf <根>\tools`(位置表自己教的写法)→ 记下的是文件,永远 RECORDED。
 * 4. 终于 CONFIGURED 了 → 汇总里仍然 "needing attention: idf",而没有任何动作能摘掉它。
 * 5. IDF 不在 C 盘就找不到 —— 而安装器自己的登记文件里写着路径和配套的 Python。
 * 6. `esptool --version` 失败,usage 文本里的 "1.8" 被当成版本号记进账本。
 *
 * 全部隔离:configDir / 工程 / IDF 树都在临时目录里,env 从空 PATH 起步且不带 HOME / SystemDrive /
 * IDF_TOOLS_PATH(installers.ts 只认注入的 env),已知位置表是注入的 —— 断言不看开发机的脸色
 * (这台开发机上真的装着两份 IDF)。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordToolchainPath } from "../src/host/domain/toolchain/actions.ts";
import { applyPresetDefaults, familyManifest, presetToolSpec, surveyManifestText, TOOLCHAIN_FAMILIES } from "../src/host/domain/toolchain/families.ts";
import { installerRecords } from "../src/host/domain/toolchain/installers.ts";
import { readLedger, writeLedgerEntry } from "../src/host/domain/toolchain/ledger.ts";
import type { LocationTable } from "../src/host/domain/toolchain/locations.ts";
import { promptSectionFor, resolveToolchain, shellEnvFor } from "../src/host/domain/toolchain/resolve.ts";
import { parseManifest } from "../src/host/domain/toolchain/schema.ts";
import type { PlatformKey, ToolSpec } from "../src/host/domain/toolchain/schema.ts";
import { removeTempDir } from "./cleanup.ts";
import { writeFakeExe } from "./fixtures/fake-exe.ts";

const PLATFORM = process.platform as PlatformKey;

let root: string;
let configDir: string;
let projectDir: string;
let idfRoot: string;

function makeIdf(dir: string): string {
	mkdirSync(path.join(dir, "tools"), { recursive: true });
	writeFileSync(path.join(dir, "tools", "idf.py"), "# fake idf.py\n");
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "yoma-tc-dir-"));
	configDir = path.join(root, "config");
	projectDir = path.join(root, "project");
	mkdirSync(configDir);
	mkdirSync(projectDir);
	idfRoot = makeIdf(path.join(root, "Espressif", "frameworks", "esp-idf-v5.4.3"));
});

afterEach(async () => {
	await removeTempDir(root);
});

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM", ...overrides };
}

/** 位置表:pattern 指向安装根,带通配 —— 与真表同形(locations.ts 的 idf 条目)。 */
function idfLocations(): LocationTable {
	return { idf: { [PLATFORM]: [path.join(root, "Espressif", "frameworks", "esp-idf*")] } };
}

function resolve(tools: ToolSpec[], opts: { env?: NodeJS.ProcessEnv; locations?: LocationTable } = {}) {
	return resolveToolchain({
		projectDir,
		configDir,
		platform: PLATFORM,
		env: opts.env ?? baseEnv(),
		locations: opts.locations ?? {},
		manifestText: JSON.stringify({ schema: "yoma/toolchain@1", tools }),
	});
}

// ─── 1. 清单条目继承预设 ───────────────────────────────────────────────────────

describe("清单只写 id 就继承预设的定义", () => {
	it('{"id":"idf"}:装在已知位置时自动发现为 CONFIGURED,记的是根目录而不是 tools\\idf.py', async () => {
		const result = await resolve([{ id: "idf" }], { locations: idfLocations() });
		expect(result.tools[0]).toMatchObject({
			status: "configured",
			source: "well-known",
			checks: { entry: "directory", execution: "not-applicable" },
		});
		expect(Object.values(result.tools[0]!.bin)).toEqual([idfRoot]);
	});

	it('{"id":"idf"}:没装时是 MISSING **且带安装提示**(从前连提示都没有)', async () => {
		const result = await resolve([{ id: "idf" }]);
		expect(result.tools[0]?.status).toBe("missing");
		expect(result.tools[0]?.hint).toBeTruthy();
	});

	it("bin 也继承:{\"id\":\"cmake\"} 在 PATH 上找得到(从前没有 bin 的条目连 PATH 都不扫)", async () => {
		const binDir = path.join(root, "bin");
		writeFakeExe(binDir, "cmake", 'console.log("cmake version 3.29.2")');
		const result = await resolve([{ id: "cmake" }], { env: baseEnv({ PATH: binDir }) });
		expect(result.tools[0]).toMatchObject({ status: "ok", version: "3.29.2", source: "path" });
	});

	it("条目自己写了的字段一律听条目的;optional 不继承(预设里 cmake 是 optional,项目点了名就是要)", async () => {
		const result = await resolve([{ id: "cmake", install: { [PLATFORM]: "use the company mirror" } }]);
		expect(result.tools[0]).toMatchObject({ status: "missing", optional: false, hint: "use the company mirror" });
		expect(result.ok).toBe(false);
	});

	it("继承 from 时把它指向的 provider 一并带进来 —— 否则安装提示仍是空的", () => {
		const merged = applyPresetDefaults({ schema: "yoma/toolchain@1", tools: [{ id: "arm-gcc" }] });
		expect(merged.tools[0]?.from).toBe("arm-gnu-toolchain");
		expect(merged.providers?.["arm-gnu-toolchain"]?.install?.win32).toBeTruthy();
	});

	it("预设以外的 id 原样不动;对预设自己生成的清单幂等", () => {
		const custom: ToolSpec = { id: "widget", bin: ["widget"] };
		expect(applyPresetDefaults({ schema: "yoma/toolchain@1", tools: [custom] }).tools[0]).toEqual(custom);
		for (const family of TOOLCHAIN_FAMILIES) {
			const manifest = familyManifest(family);
			expect(applyPresetDefaults(manifest).tools).toEqual(manifest.tools);
		}
	});

	it("普查用的虚拟清单过得了 parseManifest,id 不重复,一律 optional", () => {
		const parsed = parseManifest(surveyManifestText());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const ids = parsed.manifest.tools.map((tool) => tool.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(expect.arrayContaining(["idf", "esptool", "arm-gcc", "zephyr-sdk", "git"]));
		expect(parsed.manifest.tools.every((tool) => tool.optional === true && tool.side === "both")).toBe(true);
	});
});

// ─── 2/3. 所有来源归位到同一个根 ───────────────────────────────────────────────

describe("dir 型:贴根、贴子目录、贴标志文件,记下的都是安装根", () => {
	const idf = presetToolSpec("idf")!;

	for (const [label, given] of [
		["根目录", () => idfRoot],
		["<根>\\tools(位置表从前教的写法,会话里模型第一次填的就是它)", () => path.join(idfRoot, "tools")],
		["<根>\\tools\\idf.py", () => path.join(idfRoot, "tools", "idf.py")],
	] as const) {
		it(`set ${label} → 账本记根,核账 CONFIGURED`, async () => {
			const recorded = await recordToolchainPath({ id: "idf", path: given(), configDir, env: baseEnv(), spec: idf });
			expect(recorded.binPath).toBe(idfRoot);
			expect(Object.values((await readLedger(configDir)).entries.idf!.bin)).toEqual([idfRoot]);

			const result = await resolve([{ id: "idf" }]);
			expect(result.tools[0]).toMatchObject({ status: "configured", source: "ledger" });
			expect(Object.values(result.tools[0]!.bin)).toEqual([idfRoot]);
		});
	}

	it("旧账本里已经记成 tools\\idf.py 文件的(v0.2.5–v0.2.9 的 set 留下的)读出来照样归位,不用用户重配", async () => {
		await writeLedgerEntry(
			{ id: "idf", bin: { "idf.py": path.join(idfRoot, "tools", "idf.py") }, confirmedAt: Date.now(), by: "user" },
			configDir,
		);
		const result = await resolve([{ id: "idf" }]);
		expect(result.tools[0]?.status).toBe("configured");
		expect(Object.values(result.tools[0]!.bin)).toEqual([idfRoot]);
	});

	it("贴了个不相干的目录:照单全收,但核账是 RECORDED 并点名缺哪个文件 —— 不再照样 CONFIGURED", async () => {
		const unrelated = path.join(root, "somewhere");
		mkdirSync(unrelated);
		await recordToolchainPath({ id: "idf", path: unrelated, configDir, env: baseEnv(), spec: idf });
		const result = await resolve([{ id: "idf" }]);
		expect(result.tools[0]).toMatchObject({ status: "recorded", source: "ledger", missingBins: ["tools/idf.py"] });
		expect(result.ok).toBe(false);
	});

	it("Zephyr SDK:标志是根上的 sdk_version,贴三层深的 gnu\\arm-zephyr-eabi\\bin 也归位到根", async () => {
		const sdk = path.join(root, "zephyr-sdk-1.0.1");
		const deep = path.join(sdk, "gnu", "arm-zephyr-eabi", "bin");
		mkdirSync(deep, { recursive: true });
		writeFileSync(path.join(sdk, "sdk_version"), "1.0.1\n");
		const recorded = await recordToolchainPath({ id: "zephyr-sdk", path: deep, configDir, env: baseEnv(), spec: presetToolSpec("zephyr-sdk")! });
		expect(recorded.binPath).toBe(sdk);
	});

	it("没有 marker 的目录资源(stm32cubemx)不变:目录在就 CONFIGURED,不参与自动发现", async () => {
		const cubemx = path.join(root, "STM32CubeMX");
		mkdirSync(cubemx);
		const before = await resolve([{ id: "stm32cubemx" }], { locations: { stm32cubemx: { [PLATFORM]: [cubemx] } } });
		expect(before.tools[0]?.status).toBe("missing");
		await recordToolchainPath({ id: "stm32cubemx", path: cubemx, configDir, env: baseEnv(), spec: presetToolSpec("stm32cubemx")! });
		expect((await resolve([{ id: "stm32cubemx" }])).tools[0]?.status).toBe("configured");
	});
});

// ─── 4. configured 是终态 ─────────────────────────────────────────────────────

describe("CONFIGURED 是目录资源的终态", () => {
	it("不算 needsAttention、整体 ok;变量导出进环境但目录不进 PATH", async () => {
		const result = await resolve([{ id: "idf" }], { locations: idfLocations() });
		expect(result.ok).toBe(true);
		expect(result.needsAttention).toEqual([]);
		// 预设的 exports:工程的 CMakeLists 认的就是 $ENV{IDF_PATH}。
		expect(shellEnvFor(result, { PATH: "x" })).toEqual({ PATH: "x", IDF_PATH: idfRoot });
	});

	it("系统提示词仍然要说它在哪 —— 它不在 PATH 上,只有这一段会告诉模型", async () => {
		const section = promptSectionFor(await resolve([{ id: "idf" }], { locations: idfLocations() }));
		expect(section).toContain("CONFIGURED");
		expect(section).toContain(idfRoot);
	});
});

// ─── 5. 问安装器 ──────────────────────────────────────────────────────────────

describe("installer 档:读 Espressif 安装器自己的登记文件", () => {
	let toolsRoot: string;
	let idf6: string;

	beforeEach(() => {
		// 与真机同形:旧安装器的 esp_idf.json(对象、路径带尾斜杠)+ EIM 的 tools\eim_idf.json(数组)。
		toolsRoot = path.join(root, "EspressifTools");
		idf6 = makeIdf(path.join(root, "esp-idf-6", "v6.0.2", "esp-idf"));
		mkdirSync(path.join(toolsRoot, "tools"), { recursive: true });
		writeFileSync(
			path.join(toolsRoot, "esp_idf.json"),
			JSON.stringify({
				idfSelectedId: "esp-idf-aaa",
				idfInstalled: {
					"esp-idf-aaa": {
						version: "5.4",
						python: `${toolsRoot.replaceAll("\\", "/")}/python_env/idf5.4_py3.11_env/Scripts/python.exe`,
						path: `${idfRoot.replaceAll("\\", "/")}/`,
					},
				},
			}),
		);
		writeFileSync(
			path.join(toolsRoot, "tools", "eim_idf.json"),
			JSON.stringify({
				idfInstalled: [{ id: "esp-idf-bbb", name: "v6.0.2", path: idf6, python: path.join(toolsRoot, "venv", "python.exe"), activationScript: path.join(toolsRoot, "activate.ps1") }],
			}),
		);
	});

	it("装在哪个盘都找得到:不靠位置表,来源是 installer,选中的那份在前、另一份列进 candidates", async () => {
		const result = await resolve([{ id: "idf" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) });
		const tool = result.tools[0]!;
		expect(tool).toMatchObject({ status: "configured", source: "installer" });
		expect(Object.values(tool.bin)).toEqual([idfRoot]);
		expect(tool.candidates).toEqual([idfRoot, idf6]);
	});

	it("配套的 Python 环境跟着出来 —— 会话里 export.ps1 找错 Python 环境那个坑的答案", async () => {
		const tool = (await resolve([{ id: "idf" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) })).tools[0]!;
		expect(tool.notes?.join("\n")).toContain("idf5.4_py3.11_env");
		const section = promptSectionFor(await resolve([{ id: "idf" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) }));
		expect(section).toContain("idf5.4_py3.11_env");
		expect(section).toContain(idf6);
	});

	it("账本记住根之后来源变成 ledger,那句 Python 的话照样要说", async () => {
		await recordToolchainPath({ id: "idf", path: idf6, configDir, env: baseEnv(), spec: presetToolSpec("idf")! });
		const tool = (await resolve([{ id: "idf" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) })).tools[0]!;
		expect(tool.source).toBe("ledger");
		expect(Object.values(tool.bin)).toEqual([idf6]);
		expect(tool.notes?.join("\n")).toContain("activation script");
	});

	it("esptool 从登记的 Python 环境里找:它随 IDF 装在 venv 的 Scripts 里、不在 PATH 上 —— 不该报 MISSING 再建议 pip install", async () => {
		const scripts = path.join(toolsRoot, "python_env", "idf5.4_py3.11_env", "Scripts");
		writeFakeExe(scripts, "esptool", 'if (process.argv[2] === "version") console.log("esptool.py v4.10.0"); else process.exitCode = 2;');
		const result = await resolve([{ id: "esptool" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) });
		expect(result.tools[0]).toMatchObject({ status: "ok", source: "installer", version: "4.10.0" });
		expect(Object.values(result.tools[0]!.bin)[0]?.toLowerCase()).toContain(scripts.toLowerCase());
		// 没有登记文件的机器上这一档是空的,照旧 MISSING。
		expect((await resolve([{ id: "esptool" }])).tools[0]?.status).toBe("missing");
	});

	it("过期的 IDF_PATH(目录在、但不是 IDF 根)不挡路:接着找到安装器登记的那一份", async () => {
		const stale = path.join(root, "old-idf");
		mkdirSync(stale);
		const result = await resolve([{ id: "idf" }], { env: baseEnv({ IDF_PATH: stale, IDF_TOOLS_PATH: toolsRoot }) });
		expect(result.tools[0]).toMatchObject({ status: "configured", source: "installer" });
	});

	it("登记的路径已经被删掉的那一条不算;登记文件坏了 / 形状不认识不抛", async () => {
		writeFileSync(path.join(toolsRoot, "tools", "eim_idf.json"), "{ not json");
		writeFileSync(
			path.join(toolsRoot, "esp_idf.json"),
			JSON.stringify({ idfInstalled: { gone: { path: path.join(root, "deleted-idf") }, junk: 42 } }),
		);
		expect(installerRecords("idf", PLATFORM, baseEnv({ IDF_TOOLS_PATH: toolsRoot })).map((r) => r.dir)).toEqual([
			path.join(root, "deleted-idf"),
		]);
		expect((await resolve([{ id: "idf" }], { env: baseEnv({ IDF_TOOLS_PATH: toolsRoot }) })).tools[0]?.status).toBe("missing");
	});

	it("env 里没有 IDF_TOOLS_PATH / HOME / SystemDrive 时这一档是空的 —— 不读开发机真实的 C:\\Espressif", () => {
		expect(installerRecords("idf", PLATFORM, baseEnv())).toEqual([]);
		expect(installerRecords("cmake", PLATFORM, baseEnv({ IDF_TOOLS_PATH: toolsRoot }))).toEqual([]);
	});
});

// ─── 6. 版本探针 ──────────────────────────────────────────────────────────────

describe("版本探针:按工具的问法问,失败的输出不当版本", () => {
	/** 与真 esptool v4 同一个脾气:`version` 是子命令;`--version` 打印 usage(里面恰好有 "1.8")后失败。 */
	const ESPTOOL_JS = `
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("esptool.py v4.10.0"); console.log("4.10.0"); }
else { console.log("usage: esptool [-h] [--flash_voltage {1.8V,3.3V}]"); process.exitCode = 2; }
`;

	it('{"id":"esptool"} 继承 versionArgs:["version"] → OK 4.10.0(从前永远 UNVERIFIED)', async () => {
		const binDir = path.join(root, "bin");
		writeFakeExe(binDir, "esptool", ESPTOOL_JS);
		const result = await resolve([{ id: "esptool" }], { env: baseEnv({ PATH: binDir }) });
		expect(result.tools[0]).toMatchObject({ status: "ok", version: "4.10.0" });
	});

	it("退出码非 0 时不从输出里抠版本号:UNVERIFIED 且没有版本,而不是 version \"1.8\"", async () => {
		const binDir = path.join(root, "bin");
		const exe = writeFakeExe(binDir, "esptool", ESPTOOL_JS);
		const result = await resolve([{ id: "esptool", versionArgs: ["--version"] }], { env: baseEnv({ PATH: binDir }) });
		expect(result.tools[0]?.status).toBe("unverified");
		expect(result.tools[0]?.version).toBeUndefined();

		// set 走的是同一个探针:账本里不许再出现那个假版本号。
		const recorded = await recordToolchainPath({ id: "esptool", path: exe, configDir, env: baseEnv(), spec: { id: "esptool", bin: ["esptool"] } });
		expect(recorded.version).toBeUndefined();
		expect((await readLedger(configDir)).entries.esptool?.version).toBeUndefined();
	});
});

// ─── 清单校验 ─────────────────────────────────────────────────────────────────

describe("parseManifest:新字段", () => {
	const wrap = (tool: Record<string, unknown>) => JSON.stringify({ schema: "yoma/toolchain@1", tools: [tool] });

	it("marker 必须留在安装根之内;versionArgs 必须是非空字符串数组", () => {
		expect(parseManifest(wrap({ id: "sdk", pathKind: "dir", marker: "tools/idf.py" })).ok).toBe(true);
		expect(parseManifest(wrap({ id: "sdk", pathKind: "dir", marker: "../outside" })).ok).toBe(false);
		expect(parseManifest(wrap({ id: "sdk", pathKind: "dir", marker: "" })).ok).toBe(false);
		expect(parseManifest(wrap({ id: "t", bin: ["t"], versionArgs: ["version"] })).ok).toBe(true);
		expect(parseManifest(wrap({ id: "t", bin: ["t"], versionArgs: "version" })).ok).toBe(false);
	});
});
