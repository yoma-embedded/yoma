// toolchain 工具(core/tools/toolchain.ts)验收:三个 action 各至少一条、set 的
// 拒绝路径(不存在 / 相对路径 / 缺参数)与宽容路径(目录解析、版本探不出照记)、
// 没有清单时的话术。工具层很
// 薄,七档探测的组合已经在 toolchain-resolve.test.ts 里测过——这里只验证"参数
// -> 调用 resolveToolchain/writeLedgerEntry -> 渲染成人话"这条胶水本身接对了,
// 尤其是 resolve 真的绕过了账本、真的把新结果写回真正的账本(而 check 完全不写)。
//
// env 用真实 NodeExecutionEnv(cwd 就是 projectDir),配置目录全程 mkdtemp 注入,
// 不碰真实 ~/.yoma(根 CLAUDE.md 与 ledger.ts 头部注释反复强调的纪律)。假工具
// 沿用 toolchain-resolve.test.ts 的写法:Windows 是 .bat、其它平台是 #!/bin/sh,
// 忽略 argv 直接 echo 固定文本。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { createToolchainToolDefinition, type ToolchainToolOptions } from "../src/core/tools/toolchain.ts";
import { hostKey, installableFor, TOOLCHAIN_CATALOG } from "../src/core/toolchain/catalog.ts";
import { MANAGED_MARKER, managedPackageDir, ToolchainInstallError } from "../src/core/toolchain/install.ts";
import { readLedger, writeLedgerEntry } from "../src/core/toolchain/ledger.ts";
import type { ToolSpec } from "../src/core/toolchain/schema.ts";

let projectDir: string;
let configDir: string;
let binDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-tool-project-"));
	configDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-tool-config-"));
	binDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-tool-bin-"));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(configDir, { recursive: true, force: true });
	// maxRetries/retryDelay:被 probeVersion 起过的假工具在 Windows 上偶尔句柄释放
	// 慢一拍,直接删会撞 EBUSY(toolchain-resolve.test.ts 的 afterEach 同一条注释)。
	rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 造一个能被 probeVersion 直接 spawn 的假工具,打印一行固定文本就退出。返回绝对路径。 */
function writeFakeExe(dir: string, name: string, output: string): string {
	if (process.platform === "win32") {
		const file = join(dir, `${name}.bat`);
		writeFileSync(file, `@echo off\r\necho ${output}\r\n`);
		return file;
	}
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\necho "${output}"\n`);
	chmodSync(file, 0o755);
	return file;
}

function writeManifest(tools: ToolSpec[]): void {
	mkdirSync(join(projectDir, ".yoma"), { recursive: true });
	writeFileSync(join(projectDir, ".yoma", "toolchain.json"), JSON.stringify({ schema: "yoma/toolchain@1", tools }));
}

/** PATH 默认空字符串,不让这台开发机真实装了什么悄悄影响判定——同 toolchain-resolve.test.ts 的纪律。 */
function makeTool(envOverrides: NodeJS.ProcessEnv = {}, extra: Partial<ToolchainToolOptions> = {}) {
	const env = new NodeExecutionEnv({ cwd: projectDir });
	const options: ToolchainToolOptions = {
		configDir,
		platform: process.platform,
		env: { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM", ...envOverrides },
		...extra,
	};
	return createToolchainToolDefinition(env, options);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join("\n");
}

describe("check", () => {
	it("没有清单时明说没有清单,给出'要不要生成一份'的问句,不自己生成文件", async () => {
		const tool = makeTool();
		const result = await tool.execute("c1", {});
		const text = textOf(result);

		expect(text).toContain(".yoma/toolchain.json");
		expect(text).toContain("draft one");
		expect(result.details.ok).toBe(true);
		expect(existsSync(join(projectDir, ".yoma", "toolchain.json"))).toBe(false);
	});

	it("每个工具一行:ok 带路径/版本/来源,missing 带安装指引;check 是纯读,不写账本", async () => {
		writeFakeExe(binDir, "widget", "1.2.3");
		// 三个平台各写一句,断言时按本机平台取对应那句 —— makeTool 传的是真实
		// process.platform,写死其中一句的话这条断言只在那一个平台上成立(写死 win32
		// 的那一版在 mac 上必红)。PlatformKey 就是这三个,所以直接索引即可。
		const install = { win32: "get gizmo from example.com", darwin: "brew install gizmo", linux: "apt install gizmo" };
		const expectedHint = install[process.platform as keyof typeof install];
		writeManifest([{ id: "widget", bin: ["widget"] }, { id: "gizmo", bin: ["gizmo"], install }]);
		const tool = makeTool({ PATH: binDir });

		const result = await tool.execute("c1", { action: "check" });
		const text = textOf(result);

		expect(text).toContain("widget: OK");
		expect(text).toContain("1.2.3");
		expect(text).toContain("via path");
		expect(text).toContain("gizmo: MISSING");
		expect(text).toContain(expectedHint);
		expect(result.details.ok).toBe(false); // gizmo 是非 optional 且缺失
		expect(result.details.tools?.map((t) => t.id)).toEqual(["widget", "gizmo"]);

		const ledger = await readLedger(configDir);
		expect(ledger.entries).toEqual({});
	});

	// 工位端形态:没有项目检出(projectDir 下没有清单文件),清单原文经信箱注入,
	// side 钉成 runner。不注入 manifestText 的那一版在这里会报"没有清单"——与系统
	// 提示词里 runner 筛过的清单自相矛盾(session-manager 的装配处就是为此传 options)。
	it("注入 manifestText + side:runner 时,磁盘上没有清单也能按 runner 侧作答", async () => {
		const tool = makeTool(
			{},
			{
				side: "runner",
				manifestText: JSON.stringify({
					schema: "yoma/toolchain@1",
					tools: [
						{ id: "cmake", bin: ["cmake"] }, // side 缺省 -> mother,runner 侧不该看到它
						{ id: "jlink", bin: ["JLinkExe"], side: "runner" },
					],
				}),
			},
		);

		const result = await tool.execute("c1", { action: "check" });
		const text = textOf(result);

		expect(text).toContain("side: runner");
		expect(text).toContain("jlink: MISSING");
		expect(text).not.toContain("cmake");
		expect(text).not.toContain("No toolchain manifest found");
		expect(result.details.side).toBe("runner");
		expect(result.details.tools?.map((t) => t.id)).toEqual(["jlink"]);
	});
});

describe("resolve", () => {
	it("跳过账本、强制重新探测,并把新结果写回真正的账本", async () => {
		// 账本里放一条"看起来仍然有效"的旧记录:路径真实存在,只是版本较旧。
		const staleBin = writeFakeExe(binDir, "widget-old", "1.0.0");
		await writeLedgerEntry({ id: "widget", bin: { widget: staleBin }, confirmedAt: 1, by: "auto" }, configDir);
		// PATH 上是另一个、更新的安装 —— 只有真正跳过了账本才会找到它。
		const freshDir = join(binDir, "fresh");
		mkdirSync(freshDir);
		writeFakeExe(freshDir, "widget", "2.0.0");

		writeManifest([{ id: "widget", bin: ["widget"] }]);
		const tool = makeTool({ PATH: freshDir });

		const result = await tool.execute("c1", { action: "resolve" });
		const text = textOf(result);

		expect(text).toContain("2.0.0");
		expect(text).toContain("freshly probed");
		expect(result.details.tools?.[0].source).toBe("path"); // 不是 "ledger" —— 证明真的绕开了旧记录
		expect(result.details.tools?.[0].version).toBe("2.0.0");

		const ledger = await readLedger(configDir);
		expect(ledger.entries.widget.version).toBe("2.0.0");
		expect(ledger.entries.widget.by).toBe("auto");
		// 不硬编码具体扩展名的大小写(findOnPath 按 PATHEXT 声明的原样拼接,Windows
		// 文件系统大小写不敏感但字符串比较敏感)——直接比对工具自己汇报的路径,
		// 这才是这条断言真正要守的事:账本里存的就是这次解析出来的那条路径。
		expect(Object.values(ledger.entries.widget.bin)).toEqual(Object.values(result.details.tools?.[0].bin ?? {}));
		expect(Object.values(ledger.entries.widget.bin)[0]).toContain(freshDir);
	});

	it("没有清单时和 check 一样静默(不报错、不写账本)", async () => {
		const tool = makeTool();
		const result = await tool.execute("c1", { action: "resolve" });
		expect(result.details.ok).toBe(true);
		const ledger = await readLedger(configDir);
		expect(ledger.entries).toEqual({});
	});
});

describe("set", () => {
	it("成功:验证路径存在且能探出版本,写进账本且 by 是 user", async () => {
		const bin = writeFakeExe(binDir, "mytool", "9.9.9");
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "set", id: "arm-gcc", path: bin });
		const text = textOf(result);

		expect(text).toContain("9.9.9");
		expect(result.details).toEqual({ action: "set", ok: true, id: "arm-gcc" });

		const ledger = await readLedger(configDir);
		expect(ledger.entries["arm-gcc"].by).toBe("user");
		expect(ledger.entries["arm-gcc"].version).toBe("9.9.9");
		expect(Object.values(ledger.entries["arm-gcc"].bin)).toEqual([bin]);
	});

	it("拒绝不存在的路径,并且不写账本", async () => {
		const tool = makeTool();
		const missing = join(binDir, "does-not-exist.exe");

		await expect(tool.execute("c1", { action: "set", id: "arm-gcc", path: missing })).rejects.toThrow(/does not exist/);

		const ledger = await readLedger(configDir);
		expect(ledger.entries).toEqual({});
	});

	it("探不出版本号不拒绝:照记,版本留空(J-Link 这类 --version 不标准的工具从前被误拒过)", async () => {
		// 存在、能跑,但输出里没有任何看起来像版本号的 token。
		const bin = writeFakeExe(binDir, "noversion", "hello there, nothing to see here");
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "set", id: "arm-gcc", path: bin });
		expect(result.details).toEqual({ action: "set", ok: true, id: "arm-gcc" });
		// 话术不出现 "(version …)" 的编造 —— 没探到就不提(路径里可能天然含 version 字样,只查标注格式)。
		expect(textOf(result)).not.toContain("(version");

		const ledger = await readLedger(configDir);
		expect(ledger.entries["arm-gcc"].by).toBe("user");
		expect(ledger.entries["arm-gcc"].version).toBeUndefined();
		expect(Object.values(ledger.entries["arm-gcc"].bin)).toEqual([bin]);
	});

	it("贴目录:按清单声明的可执行名在目录里解析(用户对着资源管理器复制的天然是目录)", async () => {
		const bin = writeFakeExe(binDir, "mytool", "4.5.6");
		writeManifest([{ id: "arm-gcc", bin: ["mytool"] }]);
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "set", id: "arm-gcc", path: binDir });
		expect(textOf(result)).toContain("4.5.6");

		const ledger = await readLedger(configDir);
		// PATHEXT 展开出的扩展名大小写取自 PATHEXT 本身(通常大写),Windows 文件系统
		// 不分大小写 —— 按小写比较,别让 .BAT/.bat 的字面差异假红。
		expect(Object.values(ledger.entries["arm-gcc"].bin).map((p) => p.toLowerCase())).toEqual([bin.toLowerCase()]);
	});

	it("贴目录但声明的名字都不在里面:不拒绝,原样记录目录本身 —— 只有不存在/相对路径才拦", async () => {
		writeManifest([{ id: "arm-gcc", bin: ["arm-none-eabi-gcc"] }]);
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "set", id: "arm-gcc", path: binDir });
		expect(result.details).toEqual({ action: "set", ok: true, id: "arm-gcc" });

		const ledger = await readLedger(configDir);
		expect(Object.values(ledger.entries["arm-gcc"].bin)).toEqual([binDir]);
		expect(ledger.entries["arm-gcc"].version).toBeUndefined();
	});

	it("拒绝相对路径", async () => {
		const tool = makeTool();
		await expect(
			tool.execute("c1", { action: "set", id: "arm-gcc", path: "relative/arm-gcc.exe" }),
		).rejects.toThrow(/absolute/);
	});

	it("缺 id 或 path 时明确报错", async () => {
		const tool = makeTool();
		await expect(tool.execute("c1", { action: "set", path: join(binDir, "x.exe") })).rejects.toThrow(/"id"/);
		await expect(tool.execute("c1", { action: "set", id: "arm-gcc" })).rejects.toThrow(/"path"/);
	});
});

// ─── install 动作 ────────────────────────────────────────────────────────────
//
// 工具层对 install 同样是薄薄一层("参数 -> installToolchain -> 渲染成人话"),下载 /
// 校验 / 解压 / 记账的全部行为在 toolchain-install.test.ts 里测。这里钉三件事:
//
// 1. **缺 id 要教模型怎么补**(schema 里 id 是可选的,install 需要它);
// 2. **失败必须原样抛出并带着 phase**——吞成"看起来成功了"会让模型接着去调一个根本
//    不存在的编译器,报错发生在很远的地方;
// 3. **成功时的话术要说出 binDir**,因为模型接下来要用它;details.installed 是桌面端
//    与回放用的结构化事实。
//
// 成功路径走的是**复用**分支(包目录里已经有一份 sha 对得上的安装):这一支不碰网络,
// 于是整条胶水(参数 → installToolchain → 渲染 → 记账)可以在没有网络、没有 300 MB
// 下载的前提下端到端跑通。目录里的 ninja 是唯一每个宿主都有产物、且解开后可执行文件
// 就在包目录根(binDir 为空串)的包,拿它做样本最省事。

const NINJA = TOOLCHAIN_CATALOG.find((pkg) => pkg.id === "ninja");
const NINJA_HOST = hostKey();
const NINJA_ARTIFACT = NINJA && NINJA_HOST ? NINJA.artifacts[NINJA_HOST] : undefined;

/** 造一份"已经装好"的托管安装:包目录 + 标记(sha 与目录里钉的一致)+ binDir 里的假 exe。 */
function seedManagedNinja(): { dir: string; binDir: string; version: string } {
	const pkg = NINJA!;
	const artifact = NINJA_ARTIFACT!;
	const dir = managedPackageDir(pkg.id, pkg.version, configDir);
	const binDirRel = artifact.binDir ?? "bin";
	const managedBinDir = binDirRel === "" ? dir : join(dir, binDirRel);
	mkdirSync(managedBinDir, { recursive: true });
	writeFakeExe(managedBinDir, "ninja", "1.13.2");
	writeFileSync(
		join(dir, MANAGED_MARKER),
		JSON.stringify({
			packageId: pkg.id,
			version: pkg.version,
			dir,
			binDir: binDirRel,
			provides: pkg.provides,
			archiveSha256: artifact.sha256,
			installedAt: Date.now(),
		}),
	);
	return { dir, binDir: managedBinDir, version: pkg.version };
}

describe("install", () => {
	it("缺 id 时明确报错(schema 里 id 是可选的,install 需要它)", async () => {
		const tool = makeTool();
		await expect(tool.execute("c1", { action: "install" })).rejects.toThrow(/"id"/);
	});

	it("装不了的东西:错误原样抛出,带着 phase,不被吞成'看起来成功了'", async () => {
		const tool = makeTool();
		let caught: unknown;
		try {
			await tool.execute("c1", { action: "install", id: "definitely-not-a-tool" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ToolchainInstallError);
		const error = caught as ToolchainInstallError;
		expect(error.phase).toBe("resolve");
		expect(error.toolId).toBe("definitely-not-a-tool");
		// 账本一个字都不该动。
		expect((await readLedger(configDir)).entries).toEqual({});
	});

	it.skipIf(!NINJA_ARTIFACT)("装好之后:话术里有 binDir,details.installed 是结构化事实,账本记 by:'user'", async () => {
		const seeded = seedManagedNinja();
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "install", id: "ninja" });
		const text = textOf(result);

		expect(text).toContain(seeded.binDir);
		expect(result.details.action).toBe("install");
		expect(result.details.ok).toBe(true);
		expect(result.details.id).toBe("ninja");
		expect(result.details.installed).toEqual({
			packageId: "ninja",
			version: seeded.version,
			dir: seeded.dir,
			binDir: seeded.binDir,
			// 已经有一份 sha 对得上的安装 —— 不重新下载。
			reused: true,
		});

		const ledger = await readLedger(configDir);
		expect(ledger.entries.ninja?.by).toBe("user");
		for (const binPath of Object.values(ledger.entries.ninja?.bin ?? {})) {
			expect(binPath.toLowerCase().startsWith(seeded.binDir.toLowerCase())).toBe(true);
		}
	});
});

describe("check 的 installable 提示", () => {
	// 工具 id 用 "arm-gcc" 且不写 from —— 两张探测表的键是 "arm-gnu-toolchain",
	// 于是这条在任何开发机上都稳定 missing(同 toolchain-resolve.test.ts 的纪律)。
	it.skipIf(!installableFor("arm-gcc", hostKey()))(
		'缺失且能自动装时,行尾给出 "installable: <标题> <版本> (~N MB) via toolchain install"',
		async () => {
			const installable = installableFor("arm-gcc", hostKey())!;
			writeManifest([{ id: "arm-gcc", bin: ["arm-none-eabi-gcc"] }]);
			const tool = makeTool();

			const result = await tool.execute("c1", { action: "check" });
			const text = textOf(result);

			expect(text).toContain("arm-gcc: MISSING");
			expect(text).toContain("installable:");
			expect(text).toContain(`${installable.title} ${installable.version}`);
			expect(text).toContain(`~${Math.round(installable.bytes / 1e6)} MB`);
			expect(text).toContain('toolchain install id="arm-gcc"');
			expect(result.details.tools?.[0].installable).toEqual(installable);
		},
	);

	it("装不了的工具行里没有 installable 字样,只有人工安装指引", async () => {
		const install = { win32: "get gizmo from example.com", darwin: "brew install gizmo", linux: "apt install gizmo" };
		writeManifest([{ id: "gizmo", bin: ["gizmo"], install }]);
		const tool = makeTool();

		const result = await tool.execute("c1", { action: "check" });
		const text = textOf(result);

		expect(text).toContain("gizmo: MISSING");
		expect(text).not.toContain("installable:");
		expect(result.details.tools?.[0].installable).toBeUndefined();
	});
});
