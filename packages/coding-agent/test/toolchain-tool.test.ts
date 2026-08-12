// toolchain 工具(core/tools/toolchain.ts)验收:三个 action 各至少一条、set 的
// 拒绝路径(不存在 / 探不出版本 / 相对路径 / 缺参数)、没有清单时的话术。工具层很
// 薄,七档探测的组合已经在 toolchain-resolve.test.ts 里测过——这里只验证"参数
// -> 调用 resolveToolchain/writeLedgerEntry -> 渲染成人话"这条胶水本身接对了,
// 尤其是 resolve 真的绕过了账本、真的把新结果写回真正的账本(而 check 完全不写)。
//
// env 用真实 NodeExecutionEnv(cwd 就是 projectDir),配置目录全程 mkdtemp 注入,
// 不碰真实 ~/.my-pi(根 CLAUDE.md 与 ledger.ts 头部注释反复强调的纪律)。假工具
// 沿用 toolchain-resolve.test.ts 的写法:Windows 是 .bat、其它平台是 #!/bin/sh,
// 忽略 argv 直接 echo 固定文本。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import { createToolchainToolDefinition, type ToolchainToolOptions } from "../src/core/tools/toolchain.ts";
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
	mkdirSync(join(projectDir, ".my-pi"), { recursive: true });
	writeFileSync(join(projectDir, ".my-pi", "toolchain.json"), JSON.stringify({ schema: "yoma/toolchain@1", tools }));
}

/** PATH 默认空字符串,不让这台开发机真实装了什么悄悄影响判定——同 toolchain-resolve.test.ts 的纪律。 */
function makeTool(envOverrides: NodeJS.ProcessEnv = {}) {
	const env = new NodeExecutionEnv({ cwd: projectDir });
	const options: ToolchainToolOptions = {
		configDir,
		platform: process.platform,
		env: { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM", ...envOverrides },
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

		expect(text).toContain(".my-pi/toolchain.json");
		expect(text).toContain("draft one");
		expect(result.details.ok).toBe(true);
		expect(existsSync(join(projectDir, ".my-pi", "toolchain.json"))).toBe(false);
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

	it("拒绝探不出版本号的路径", async () => {
		// 存在、能跑,但输出里没有任何看起来像版本号的 token。
		const bin = writeFakeExe(binDir, "noversion", "hello there, nothing to see here");
		const tool = makeTool();

		await expect(tool.execute("c1", { action: "set", id: "arm-gcc", path: bin })).rejects.toThrow(/version/);
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
