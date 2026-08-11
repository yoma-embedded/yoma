// 工具链解析(resolve.ts)验收:七档探测顺序、账本失效路径的复核、版本不满足时
// 的"继续找下一档"、shellEnvFor 的 PATH 前置与 exports 填充、promptSectionFor 的
// 人话文案、side 筛选。
//
// 假工具沿用 toolchain-version.test.ts 的写法(Windows 是 .bat、其它平台是
// #!/bin/sh),因为 resolveTool 内部就是直接调 probeVersion,同一套假工具能被
// 两边同样 spawn 起来。env 全程显式传(PATH 从空字符串起步、按需追加),不依赖
// process.env —— 否则这台机器上真实装了什么会悄悄影响 missing/ambiguous 之类的
// 判定,变成一个测哪儿都测不出差异的闸门(根 CLAUDE.md 点名的反模式)。工具 id
// 一律用 "widget" 这类不在 WELL_KNOWN_LOCATIONS / REGISTRY_SEARCH_TERM 表里的假
// 名字,好让 well-known/registry 两档在探不到时是纯查表 miss、立刻返回 —— 不会
// 真的去 glob 系统目录或起 reg.exe 子进程,"missing" 场景因此又快又确定。
//
// 没有覆盖 ambiguous 状态的端到端场景:它只在 well-known/registry 两档同时给出
// 多个版本不一致的候选时触发,而这两档的候选来源(WELL_KNOWN_LOCATIONS 表 /
// Windows 注册表)全是这台机器的真实状态,没有注入点——要么真的在
// "C:\Program Files\..." 这类系统路径里放文件(污染开发机,不可接受),要么改
// locations.ts 加注入点(超出这一阶段"只准碰 resolve.ts/index.ts/src/index.ts/
// 本测试文件"的范围)。ambiguous 的渲染逻辑本身在 promptSectionFor 的测试里用手
// 造的 ResolvedTool 覆盖了,决策逻辑(resolveTool 内部 good/bad 分桶)按文件头注释
// 的规则实现,但这一分支没有端到端测试——如实记录,不假装测到了。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeLedgerEntry } from "../src/core/toolchain/ledger.ts";
import { promptSectionFor, resolveToolchain, shellEnvFor } from "../src/core/toolchain/resolve.ts";
import type { ToolchainResolution } from "../src/core/toolchain/resolve.ts";
import type { ToolchainManifest, ToolSpec } from "../src/core/toolchain/schema.ts";

let projectDir: string;
let configDir: string;
let binDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-resolve-project-"));
	configDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-resolve-config-"));
	binDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-resolve-bin-"));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(configDir, { recursive: true, force: true });
	// maxRetries/retryDelay:被 probeVersion 起过的假工具在 Windows 上偶尔会比子
	// 进程真正退出晚一拍才释放文件句柄,直接删会撞 EBUSY(同一个坑,toolchain-
	// version.test.ts 的 afterEach 已经踩过并注释过)。
	rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 造一个能被 probeVersion 直接 spawn 的假工具,打印一行版本号就退出。返回绝对路径。 */
function writeFakeExe(dir: string, name: string, version: string): string {
	if (process.platform === "win32") {
		const file = join(dir, `${name}.bat`);
		writeFileSync(file, `@echo off\r\necho ${version}\r\n`);
		return file;
	}
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
	chmodSync(file, 0o755);
	return file;
}

/**
 * 全程显式控制的 env:PATH 默认空字符串(不让真实机器上的 PATH 漏进来影响判定),
 * PATHEXT 固定给一份候选后缀表。这份 PATHEXT 在 POSIX 上也安全 —— findOnPath 的
 * candidateExtensions 无论 PATHEXT 是否存在,末尾都会再补一条裸文件名兜底,所以
 * writeFakeExe 在非 Windows 上产出的裸名字 + chmod 可执行文件照样能被找到,只是
 * 多试了几个必然落空的后缀,不影响正确性。
 */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM", ...overrides };
}

/** install 提示对三个平台给同一段文本 —— 测试用 platform: process.platform,不用关心具体是哪一个键被查到。 */
function installFor(text: string): NonNullable<ToolSpec["install"]> {
	return { win32: text, darwin: text, linux: text };
}

function manifestJson(tools: ToolSpec[], providers?: ToolchainManifest["providers"]): string {
	const manifest: ToolchainManifest = providers ? { schema: "yoma/toolchain@1", providers, tools } : { schema: "yoma/toolchain@1", tools };
	return JSON.stringify(manifest);
}

function writeManifestFile(dir: string, tools: ToolSpec[]): void {
	mkdirSync(join(dir, ".my-pi"), { recursive: true });
	writeFileSync(join(dir, ".my-pi", "toolchain.json"), manifestJson(tools));
}

/** promptSectionFor 应该给内容的场景里,把 undefined 的可能性提前收掉——断言消息比裸的类型错误好读。 */
function expectSection(r: ToolchainResolution): string {
	const text = promptSectionFor(r);
	if (text === undefined) throw new Error("expected promptSectionFor to return a section, got undefined");
	return text;
}

// ─── 没有清单 ────────────────────────────────────────────────────────────────

describe("没有清单", () => {
	it("projectDir 下没有 .my-pi/toolchain.json 时返回 ok:true、tools 空、manifest 不填,不抛", async () => {
		const result = await resolveToolchain({ projectDir, configDir, platform: process.platform, env: baseEnv() });
		expect(result.ok).toBe(true);
		expect(result.tools).toEqual([]);
		expect(result.manifest).toBeUndefined();
		expect(result.manifestPath).toBeUndefined();
		expect(result.needsAttention).toEqual([]);
	});
});

describe("从磁盘读清单(不注入 manifestText)", () => {
	it("读取 projectDir/.my-pi/toolchain.json 并把 manifestPath 指向那个文件", async () => {
		writeManifestFile(projectDir, [{ id: "widget", bin: ["widget"] }]);
		const result = await resolveToolchain({ projectDir, configDir, platform: process.platform, env: baseEnv() });
		expect(result.manifest?.tools.map((t) => t.id)).toEqual(["widget"]);
		expect(result.manifestPath).toBe(join(projectDir, ".my-pi", "toolchain.json"));
	});
});

describe("清单内容损坏", () => {
	it("解析失败时 reject,而不是把它当成没有清单静默吞掉", async () => {
		await expect(
			resolveToolchain({ projectDir, configDir, platform: process.platform, env: baseEnv(), manifestText: "{ not json" }),
		).rejects.toThrow(/not valid JSON/);
	});
});

// ─── 账本 ────────────────────────────────────────────────────────────────────

describe("账本命中但路径已不存在", () => {
	it("不采信失效条目,继续往后找,最终从 PATH 解析到", async () => {
		await writeLedgerEntry(
			{ id: "widget", bin: { widget: join(binDir, "this-file-does-not-exist.bat") }, confirmedAt: 1, by: "auto" },
			configDir,
		);
		writeFakeExe(binDir, "widget", "1.0.0");

		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv({ PATH: binDir }),
			manifestText: manifestJson([{ id: "widget", bin: ["widget"] }]),
		});

		expect(result.tools).toHaveLength(1);
		const widget = result.tools[0];
		expect(widget.status).toBe("ok");
		expect(widget.source).toBe("path"); // 不是 "ledger" —— 证明那条失效记录被跳过了
		expect(widget.version).toBe("1.0.0");
	});
});

describe("local override 优先级最高", () => {
	it("toolchain.local.json 里的显式路径胜过账本和 PATH", async () => {
		const pathBin = writeFakeExe(binDir, "widget-path", "1.1.1");
		const ledgerBin = writeFakeExe(binDir, "widget-ledger", "5.5.5");
		const localBin = writeFakeExe(binDir, "widget-local", "9.9.9");

		await writeLedgerEntry({ id: "widget", bin: { widget: ledgerBin }, confirmedAt: 1, by: "auto" }, configDir);
		mkdirSync(join(projectDir, ".my-pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".my-pi", "toolchain.local.json"),
			JSON.stringify({ widget: { id: "widget", bin: { widget: localBin }, confirmedAt: 2, by: "user" } }),
		);

		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv({ PATH: binDir }), // pathBin 也在这个目录里,证明 local 赢的不是"唯一候选"
			manifestText: manifestJson([{ id: "widget", bin: ["widget"] }]),
		});

		const widget = result.tools[0];
		expect(widget.source).toBe("local");
		expect(widget.version).toBe("9.9.9");
		void pathBin; // 只是用来证明 PATH 上确有其它候选,断言不需要用到它的值
	});
});

// ─── 版本不满足:继续找下一档 ───────────────────────────────────────────────────

describe("版本不满足", () => {
	it("env 档版本不满足时继续找 PATH 档,PATH 档满足则最终 ok 且 source 是 path", async () => {
		const oldBin = writeFakeExe(binDir, "widget-old", "1.0.0");
		const newDir = join(binDir, "new");
		mkdirSync(newDir);
		writeFakeExe(newDir, "widget", "2.5.0");

		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv({ WIDGET_OVERRIDE: oldBin, PATH: newDir }),
			manifestText: manifestJson([{ id: "widget", bin: ["widget"], version: ">=2.0", env: ["WIDGET_OVERRIDE"] }]),
		});

		const widget = result.tools[0];
		expect(widget.status).toBe("ok");
		expect(widget.source).toBe("path");
		expect(widget.version).toBe("2.5.0");
	});

	it("所有档都不满足版本时,最终定案 version-mismatch,candidates 记录见过的路径,hint 来自 installHint", async () => {
		const oldBin = writeFakeExe(binDir, "widget-old", "1.0.0");

		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv({ WIDGET_OVERRIDE: oldBin }), // PATH 留空,后面没有别的档能找到东西
			manifestText: manifestJson([
				{
					id: "widget",
					bin: ["widget"],
					version: ">=2.0",
					env: ["WIDGET_OVERRIDE"],
					install: installFor("download widget from example.com"),
				},
			]),
		});

		const widget = result.tools[0];
		expect(widget.status).toBe("version-mismatch");
		expect(widget.version).toBe("1.0.0");
		expect(widget.wanted).toBe(">=2.0");
		expect(widget.bin).toEqual({}); // 没有一个"赢",bin 留空 —— candidates 才是唯一能看到路径的地方
		expect(widget.candidates).toEqual([oldBin]);
		expect(widget.hint).toBe("download widget from example.com");
		expect(result.ok).toBe(false);
		expect(result.needsAttention.map((t) => t.id)).toEqual(["widget"]);
	});
});

describe("没有 bin 字段的工具", () => {
	it("纯 GUI 应用(没有可执行名字可查)不报错,直接 missing,不去碰 well-known/registry", async () => {
		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv(),
			manifestText: manifestJson([{ id: "stm32cubemx", optional: true }]),
		});
		expect(result.tools[0].status).toBe("missing");
		expect(result.ok).toBe(true); // optional,不拖累整体 ok
	});
});

// ─── ok / needsAttention 汇总 ──────────────────────────────────────────────────

describe("ok / needsAttention 汇总", () => {
	it("非 optional 的工具都 ok 时整体 ok:true;optional 缺失不影响 ok,但仍然进 needsAttention", async () => {
		writeFakeExe(binDir, "widget", "1.0.0");
		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv({ PATH: binDir }),
			// "gizmo" 是假名字,不是 WELL_KNOWN_LOCATIONS 里的已知 id —— 用 "clangd"
			// 这类真实 id 在开发机上跑这条会不稳定:这台机器如果真装了 LLVM/VS 自带
			// 的 clangd,well-known 档会真的探到它,把这条测试变成看开发机脸色的
			// 闸门(踩过一次,见本文件头部注释)。
			manifestText: manifestJson([
				{ id: "widget", bin: ["widget"] },
				{ id: "gizmo", bin: ["gizmo"], optional: true },
			]),
		});
		expect(result.ok).toBe(true);
		expect(result.needsAttention.map((t) => t.id)).toEqual(["gizmo"]);
	});

	it("非 optional 的工具缺失时整体 ok:false", async () => {
		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv(),
			manifestText: manifestJson([{ id: "widget", bin: ["widget"] }]),
		});
		expect(result.ok).toBe(false);
	});
});

// ─── side 筛选 ───────────────────────────────────────────────────────────────

describe("side 筛选", () => {
	it('side:"runner" 时只解析 runner/both 的工具,mother-only 的不出现', async () => {
		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv(),
			side: "runner",
			manifestText: manifestJson([
				{ id: "cmake", bin: ["cmake"] }, // side 缺省 -> mother,runner 侧不该看到它
				{ id: "jlink", bin: ["jlink"], side: "runner" },
				{ id: "python", bin: ["python"], side: "both" },
			]),
		});
		expect(result.side).toBe("runner");
		expect(result.tools.map((t) => t.id).sort()).toEqual(["jlink", "python"]);
	});

	it("不传 side 时默认按 mother 解析", async () => {
		const result = await resolveToolchain({
			projectDir,
			configDir,
			platform: process.platform,
			env: baseEnv(),
			manifestText: manifestJson([
				{ id: "cmake", bin: ["cmake"] },
				{ id: "jlink", bin: ["jlink"], side: "runner" },
			]),
		});
		expect(result.side).toBe("mother");
		expect(result.tools.map((t) => t.id)).toEqual(["cmake"]);
	});
});

// ─── shellEnvFor ─────────────────────────────────────────────────────────────

describe("shellEnvFor", () => {
	it("按声明顺序前置 bin 目录、跨工具去重同一目录、按 exports 填变量、不覆盖 base 里已有的同名变量", () => {
		const cmakeDir = join(binDir, "cmake-install");
		const cmakeExe = join(cmakeDir, "cmake.exe");
		const ninjaExe = join(cmakeDir, "ninja.exe"); // 与 cmake 同一目录(VS 自带工具链常见形态)—— 验证去重
		const jlinkDir = join(binDir, "jlink-install");
		const jlinkExe = join(jlinkDir, "JLink.exe");

		const manifest: ToolchainManifest = {
			schema: "yoma/toolchain@1",
			tools: [
				{ id: "cmake", bin: ["cmake"] },
				{ id: "ninja", bin: ["ninja"] },
				{ id: "jlink", bin: ["JLink"], exports: { JLINK_EXE: "{bin}", EXISTING_VAR: "{bin}" } },
				{ id: "missing-tool", bin: ["nope"] },
			],
		};
		const resolution: ToolchainResolution = {
			manifest,
			side: "mother",
			ok: false,
			needsAttention: [],
			tools: [
				{ id: "cmake", status: "ok", optional: false, bin: { cmake: cmakeExe } },
				{ id: "ninja", status: "ok", optional: false, bin: { ninja: ninjaExe } },
				{ id: "jlink", status: "ok", optional: false, bin: { JLink: jlinkExe }, version: "7.94" },
				{ id: "missing-tool", status: "missing", optional: false, bin: {} },
			],
		};

		const base: NodeJS.ProcessEnv = { PATH: "C:\\base\\path", EXISTING_VAR: "user-set-value" };
		const out = shellEnvFor(resolution, base);

		expect(out.PATH).toBe([cmakeDir, jlinkDir, "C:\\base\\path"].join(delimiter));
		expect(out.JLINK_EXE).toBe(jlinkExe);
		expect(out.EXISTING_VAR).toBe("user-set-value"); // exports 声明了同名变量,但 base 已经有它,不覆盖
	});

	it('base 的 PATH 键叫 "Path"(Windows 常见形态)时写回同一个键,不额外产生一个 "PATH" 键', () => {
		const toolDir = join(binDir, "tool-install");
		const toolExe = join(toolDir, "widget.exe");
		const resolution: ToolchainResolution = {
			side: "mother",
			ok: true,
			needsAttention: [],
			tools: [{ id: "widget", status: "ok", optional: false, bin: { widget: toolExe } }],
		};
		const base = { Path: "C:\\base\\path" } as NodeJS.ProcessEnv;
		const out = shellEnvFor(resolution, base);

		expect(out.Path).toBe([toolDir, "C:\\base\\path"].join(delimiter));
		expect(out.PATH).toBeUndefined();
	});

	it("没有 ok 工具时不改动 PATH", () => {
		const resolution: ToolchainResolution = {
			side: "mother",
			ok: false,
			needsAttention: [],
			tools: [{ id: "widget", status: "missing", optional: false, bin: {} }],
		};
		const base: NodeJS.ProcessEnv = { PATH: "C:\\base\\path" };
		const out = shellEnvFor(resolution, base);
		expect(out.PATH).toBe("C:\\base\\path");
	});
});

// ─── promptSectionFor ──────────────────────────────────────────────────────────

describe("promptSectionFor", () => {
	it("没有清单时返回 undefined", () => {
		const resolution: ToolchainResolution = { manifest: undefined, side: "mother", ok: true, needsAttention: [], tools: [] };
		expect(promptSectionFor(resolution)).toBeUndefined();
	});

	it("有清单但全部 ok、没有 optional 缺失时返回 undefined —— 别白占上下文", () => {
		const manifest: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "cmake", bin: ["cmake"] }] };
		const resolution: ToolchainResolution = {
			manifest,
			side: "mother",
			ok: true,
			needsAttention: [],
			tools: [{ id: "cmake", status: "ok", optional: false, bin: { cmake: "C:\\tools\\cmake.exe" }, version: "3.28.1", source: "path" }],
		};
		expect(promptSectionFor(resolution)).toBeUndefined();
	});

	it("工具缺失时点名缺什么、告诫别猜路径、带上安装指引", () => {
		const manifest: ToolchainManifest = {
			schema: "yoma/toolchain@1",
			tools: [{ id: "arm-gcc", bin: ["arm-none-eabi-gcc"], version: ">=12" }],
		};
		const missing = {
			id: "arm-gcc",
			status: "missing" as const,
			optional: false,
			bin: {},
			wanted: ">=12",
			hint: "winget install Arm.GnuArmEmbeddedToolchain",
		};
		const resolution: ToolchainResolution = { manifest, side: "mother", ok: false, needsAttention: [missing], tools: [missing] };

		const text = expectSection(resolution);
		expect(text).toContain("arm-gcc");
		expect(text).toContain("MISSING");
		expect(text).toContain("Do not guess a path or hardcode one");
		expect(text).toContain("winget install Arm.GnuArmEmbeddedToolchain");
	});

	it("version-mismatch 的行同时报出要求的版本和已装的版本", () => {
		const manifest: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "cmake", bin: ["cmake"], version: ">=3.22" }] };
		const mismatch = {
			id: "cmake",
			status: "version-mismatch" as const,
			optional: false,
			bin: {},
			wanted: ">=3.22",
			version: "3.10.0",
			candidates: ["C:\\old\\cmake.exe"],
		};
		const resolution: ToolchainResolution = { manifest, side: "mother", ok: false, needsAttention: [mismatch], tools: [mismatch] };

		const text = expectSection(resolution);
		expect(text).toContain("VERSION MISMATCH");
		expect(text).toContain(">=3.22");
		expect(text).toContain("3.10.0");
	});

	it("ambiguous 的行列出全部候选,提醒模型去问用户而不是自己猜", () => {
		const manifest: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "arm-gcc", bin: ["arm-none-eabi-gcc"] }] };
		const ambiguous = {
			id: "arm-gcc",
			status: "ambiguous" as const,
			optional: false,
			bin: { "arm-none-eabi-gcc": "C:\\cubeide\\gcc.exe" },
			candidates: ["C:\\cubeide\\gcc.exe", "C:\\standalone\\gcc.exe"],
		};
		const resolution: ToolchainResolution = { manifest, side: "mother", ok: false, needsAttention: [ambiguous], tools: [ambiguous] };

		const text = expectSection(resolution);
		expect(text).toContain("AMBIGUOUS");
		expect(text).toContain("C:\\cubeide\\gcc.exe");
		expect(text).toContain("C:\\standalone\\gcc.exe");
		expect(text).toContain("ask the user");
	});

	it("optional 工具缺失也会被列出(不影响 ok),并标注为 optional", () => {
		const manifest: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "clangd", bin: ["clangd"], optional: true }] };
		const missing = { id: "clangd", status: "missing" as const, optional: true, bin: {} };
		const resolution: ToolchainResolution = { manifest, side: "mother", ok: true, needsAttention: [missing], tools: [missing] };

		const text = expectSection(resolution);
		expect(text).toContain("clangd (optional)");
	});
});
