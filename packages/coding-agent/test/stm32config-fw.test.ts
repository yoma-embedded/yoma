// stm32config 工具与固件下载的接线(tools/stm32config.ts):
// - generate 之前按配置文档里的零件号推族,这一族哪儿都没有固件时**不起内核**,直接给
//   模型"去 fetch-fw"的指引(内核那句 "run tools/fetch-fw.ps1" 是给仓库开发者看的);
// - --fw-dir 挑第一个已落这一族的根:受管目录(<configDir>/stm32/fw)优先于随包的 data/stm32/fw;
// - fetch-fw 命令落地后 generate 立刻能用;
// - 零件号推不出族时内核自己报的"firmware components for X not found"也翻成 fetch-fw 指引。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobWriter, configure, TextReader, terminateWorkers, ZipWriter } from "@zip.js/zip.js";
import { NodeExecutionEnv } from "@yoma/agent/node";

import type { Stm32FwCatalogEntry, Stm32FwComponent } from "../src/core/stm32/fw.ts";
import { createStm32ConfigToolDefinition, type Stm32ConfigToolOptions } from "../src/core/tools/stm32config.ts";
import { ECHO_ARGV_JS, writeFakeExe } from "./fixtures/fake-exe.ts";

configure({ useWebWorkers: false });
afterAll(async () => {
	await terminateWorkers();
});

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** bin/ 里一个假 stm32kernel + data/stm32 里一个空的 STM32F1 irpack(stm32Families 只看文件名)。 */
function makeEngines(kernelJs = ECHO_ARGV_JS): string {
	const root = tempDir("yoma-stm32cfg-engines-");
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFakeExe(join(root, "bin"), "stm32kernel", kernelJs);
	mkdirSync(join(root, "data", "stm32"), { recursive: true });
	writeFileSync(join(root, "data", "stm32", "stm32f1.irpack"), "");
	return root;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function landedTree(root: string, family: string): void {
	mkdirSync(join(root, family, "HAL_Driver", "Src"), { recursive: true });
	writeFileSync(join(root, family, "HAL_Driver", "Src", `${family.toLowerCase()}xx_hal.c`), "// c");
}

function makeTool(over: { kernelJs?: string; fw?: Stm32ConfigToolOptions["fw"] } = {}) {
	const enginesDir = makeEngines(over.kernelJs);
	const cwd = tempDir("yoma-stm32cfg-cwd-");
	const fwRoot = over.fw?.fwRoot ?? tempDir("yoma-stm32cfg-fw-");
	writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32F103C8Tx" } }));
	const tool = createStm32ConfigToolDefinition(new NodeExecutionEnv({ cwd }), {
		enginesDir,
		fw: { fwRoot, env: {}, ...over.fw },
	});
	return { tool, cwd, enginesDir, fwRoot };
}

describe("stm32config generate 与固件根", () => {
	it("这一族哪儿都没有固件:不起内核,返回 fetch-fw 指引(命令与族名都点名)", async () => {
		const { tool, fwRoot } = makeTool();
		const result = await tool.execute("c1", { command: "generate", configPath: "board.json", out: "fw" });
		const text = textOf(result);
		expect(text).not.toContain("argv:");
		expect(text).toContain("STM32F1");
		expect(text).toContain('command "fetch-fw"');
		expect(text).toContain('family "STM32F1"');
		expect(text).toContain("stm32f1xx-hal-driver@");
		expect(text).toContain(fwRoot);
		expect(result.details).toEqual({ command: "generate", exitCode: null });
	});

	it("受管目录里有这一族:--fw-dir 指向它", async () => {
		const { tool, fwRoot } = makeTool();
		landedTree(fwRoot, "STM32F1");
		const result = await tool.execute("c1", { command: "generate", configPath: "board.json", out: "fw" });
		expect(textOf(result)).toContain(`--fw-dir ${fwRoot}`);
		expect(textOf(result)).toContain("Project generated at");
	});

	it("只有随包 / 源码检出的 data/stm32/fw 里有这一族(fetch-fw.ps1 的落点):照样认", async () => {
		const { tool, enginesDir } = makeTool();
		const bundled = join(enginesDir, "data", "stm32", "fw");
		landedTree(bundled, "STM32F1");
		const result = await tool.execute("c1", { command: "generate", configPath: "board.json", out: "fw" });
		expect(textOf(result)).toContain(`--fw-dir ${bundled}`);
	});

	it("零件号推不出族(配置里的零件不在任何 irpack 里)时放行内核;内核报缺固件就翻成 fetch-fw 指引", async () => {
		const { tool, cwd, fwRoot } = makeTool({
			kernelJs: `console.error("firmware components for STM32G4 not found under /x (expected STM32G4/HAL_Driver); run tools/fetch-fw.ps1 -Families STM32G4"); process.exitCode = 2;`,
		});
		writeFileSync(join(cwd, "board.json"), JSON.stringify({ mcu: { part: "STM32G474RETx" } }));
		await expect(tool.execute("c1", { command: "generate", configPath: "board.json", out: "fw" })).rejects.toThrow(
			/family "STM32G4"[\s\S]*fetch-fw|fetch-fw[\s\S]*family "STM32G4"/,
		);
		expect(existsSync(join(fwRoot, "STM32G4"))).toBe(false);
	});

	it("validate / list-mcus 不看固件:没有固件也照常起内核", async () => {
		const { tool } = makeTool();
		const result = await tool.execute("c1", { command: "validate", configPath: "board.json" });
		expect(textOf(result)).toContain("argv: validate");
	});
});

// ─── fetch-fw 命令:假服务器 + 假 zip(与 stm32-fw.test.ts 同一形状,这里只验接线)──

async function makeZip(entries: Array<{ name: string; body: string }>): Promise<Buffer> {
	const writer = new ZipWriter(new BlobWriter("application/zip"));
	for (const entry of entries) await writer.add(entry.name, new TextReader(entry.body));
	const blob = await writer.close();
	return Buffer.from(await blob.arrayBuffer());
}

const HAL: Stm32FwComponent = { repo: "stm32f1xx-hal-driver", tag: "v1.1.10" };
const DEV: Stm32FwComponent = { repo: "cmsis-device-f1", tag: "v4.3.5" };
const CORE: Stm32FwComponent = { repo: "cmsis-core", tag: "v5.9.0" };
const CATALOG: Stm32FwCatalogEntry[] = [{ family: "STM32F1", hal: HAL, device: DEV }];

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl: string;
const bucket = new Map<string, Buffer>();

beforeEach(async () => {
	bucket.clear();
	bucket.set(
		`/${HAL.repo}-${HAL.tag}.zip`,
		await makeZip([
			{ name: "hal-1.1.10/Inc/stm32f1xx_hal.h", body: "// h" },
			{ name: "hal-1.1.10/Src/stm32f1xx_hal.c", body: "// c" },
			{ name: "hal-1.1.10/LICENSE.md", body: "BSD-3" },
		]),
	);
	bucket.set(
		`/${DEV.repo}-${DEV.tag}.zip`,
		await makeZip([
			{ name: "dev-4.3.5/Include/stm32f1xx.h", body: "// h" },
			{ name: "dev-4.3.5/Source/Templates/gcc/startup_stm32f103xb.s", body: "; s" },
			{ name: "dev-4.3.5/LICENSE.txt", body: "Apache-2.0" },
		]),
	);
	bucket.set(`/${CORE.repo}-${CORE.tag}.zip`, await makeZip([{ name: "core-5.9.0/Include/core_cm3.h", body: "// core" }]));
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch: (request) => {
			const body = bucket.get(new URL(request.url).pathname);
			return body ? new Response(body, { headers: { "content-type": "application/zip" } }) : new Response("nope", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

describe("stm32config fetch-fw", () => {
	it("落地这一族之后 generate 立刻走受管目录;再 fetch 一次是复用", async () => {
		const { tool, fwRoot } = makeTool({
			fw: { catalog: CATALOG, core: CORE, archiveUrl: (component) => `${baseUrl}/${component.repo}-${component.tag}.zip` },
		});

		const fetched = await tool.execute("c1", { command: "fetch-fw", family: "stm32f1" });
		expect(textOf(fetched)).toContain(`Landed STM32F1 firmware at ${join(fwRoot, "STM32F1")}`);
		expect(textOf(fetched)).toContain(`${HAL.repo}@${HAL.tag}`);
		expect(fetched.details).toEqual({ command: "fetch-fw", exitCode: 0 });
		expect(existsSync(join(fwRoot, "STM32F1", "HAL_Driver", "Src", "stm32f1xx_hal.c"))).toBe(true);
		expect(existsSync(join(fwRoot, "CMSIS_Core", "Include", "core_cm3.h"))).toBe(true);

		const generated = await tool.execute("c2", { command: "generate", configPath: "board.json", out: "fw" });
		expect(textOf(generated)).toContain(`--fw-dir ${fwRoot}`);

		const again = await tool.execute("c3", { command: "fetch-fw", family: "STM32F1" });
		expect(textOf(again)).toContain("already present");
	});

	it("没给 family 就拒绝;表外的族把 fw.ts 的人话原样带出来", async () => {
		const { tool } = makeTool({ fw: { catalog: CATALOG, core: CORE, archiveUrl: () => `${baseUrl}/none.zip` } });
		await expect(tool.execute("c1", { command: "fetch-fw" })).rejects.toThrow(/requires family/);
		await expect(tool.execute("c2", { command: "fetch-fw", family: "STM32MP1" })).rejects.toThrow(/unsupported[\s\S]*STM32CubeMP1/);
	});
});
