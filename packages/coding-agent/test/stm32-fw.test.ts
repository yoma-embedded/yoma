// STM32 固件运行时下载(core/stm32/fw.ts)验收:假服务器(Bun.serve port:0)+ 假 zip +
// mkdtemp 的 fwRoot —— 一个字节都不走真网络,一个文件都不落进真实 ~/.yoma。
//
// 断言的是 generate 真正依赖的东西,不是下载器本身:
// - **布局** = stm32kernel 的 FwPaths::locate 认的那一个(<族>/HAL_Driver/{Inc,Src}、
//   <族>/CMSIS_Device/{Include,Source/Templates}、共享 CMSIS_Core/Include);
// - **过滤**只留源码 / 链接脚本 / 许可证(fetch-fw.ps1 同一份名单):厂商手册与图片是几百 MB 的噪声;
// - **共享 core 只落一次**,同 tag **复用不重下**(H7 的 HAL 十几 MB,重下是分钟级的静默等待);
// - **失败不留半成品**:族目录要么完整要么不存在,中转目录一并清掉;
// - **表外的族给人话**(MP1 只能手动放),不是一个 404。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobWriter, configure, TextReader, terminateWorkers, ZipWriter } from "@zip.js/zip.js";

import {
	landStm32Firmware,
	pickStm32FwDir,
	readStm32FwMarker,
	STM32_CMSIS_CORE,
	STM32_FW_CATALOG,
	STM32_FW_MARKER,
	type Stm32FwCatalogEntry,
	type Stm32FwComponent,
	Stm32FwError,
	stm32FamilyOfPart,
	stm32FwCatalogEntry,
	stm32FwLanded,
} from "../src/core/stm32/fw.ts";

configure({ useWebWorkers: false });
afterAll(async () => {
	await terminateWorkers();
});

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

/** GitHub archive 的形状:唯一顶级目录 <repo>-<tag 去 v>/,里面是仓库内容。 */
function halZip(opts: { withHalC?: boolean } = {}): Promise<Buffer> {
	const root = "stm32f1xx-hal-driver-1.1.10";
	return makeZip([
		{ name: `${root}/Inc/stm32f1xx_hal.h`, body: "// h" },
		{ name: `${root}/Inc/Legacy/stm32_hal_legacy.h`, body: "// legacy" },
		...(opts.withHalC === false ? [] : [{ name: `${root}/Src/stm32f1xx_hal.c`, body: "// c" }]),
		{ name: `${root}/Src/stm32f1xx_hal_gpio.c`, body: "// c" },
		{ name: `${root}/_htmresc/logo.png`, body: "PNG" },
		{ name: `${root}/Release_Notes.html`, body: "<html>" },
		{ name: `${root}/LICENSE.md`, body: "BSD-3" },
		{ name: `${root}/README.md`, body: "readme" },
	]);
}

function devZip(): Promise<Buffer> {
	const root = "cmsis-device-f1-4.3.5";
	return makeZip([
		{ name: `${root}/Include/stm32f1xx.h`, body: "// h" },
		{ name: `${root}/Include/stm32f103xb.h`, body: "// h" },
		{ name: `${root}/Source/Templates/system_stm32f1xx.c`, body: "// c" },
		{ name: `${root}/Source/Templates/gcc/startup_stm32f103xb.s`, body: "; s" },
		{ name: `${root}/Source/Templates/gcc/linker/STM32F103XB_FLASH.ld`, body: "ld" },
		{ name: `${root}/Source/Templates/iar/startup_stm32f103xb.s`, body: "; iar" },
		{ name: `${root}/LICENSE.txt`, body: "Apache-2.0" },
	]);
}

/** ST 的 cmsis-core 两种快照布局:Include/ 在根上,或藏在 CMSIS/Core/ 下。 */
function coreZip(nested = true): Promise<Buffer> {
	const root = "cmsis-core-5.9.0";
	return makeZip([
		{ name: nested ? `${root}/CMSIS/Core/Include/core_cm3.h` : `${root}/Include/core_cm3.h`, body: "// core" },
		{ name: `${root}/LICENSE.txt`, body: "Apache-2.0" },
		{ name: `${root}/docs/index.html`, body: "<html>" },
	]);
}

// ─── 假服务器 ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl: string;
let fwRoot: string;
const bucket = new Map<string, Buffer>();
let requests: string[] = [];

const archiveUrl = (component: Stm32FwComponent) => `${baseUrl}/${component.repo}-${component.tag}.zip`;

async function serveAll(): Promise<void> {
	bucket.set(`/${HAL.repo}-${HAL.tag}.zip`, await halZip());
	bucket.set(`/${DEV.repo}-${DEV.tag}.zip`, await devZip());
	bucket.set(`/${CORE.repo}-${CORE.tag}.zip`, await coreZip());
}

function land(over: Partial<Parameters<typeof landStm32Firmware>[0]> = {}) {
	return landStm32Firmware({
		family: "STM32F1",
		fwRoot,
		catalog: CATALOG,
		core: CORE,
		archiveUrl,
		// 隔离开发机上可能设着的 YOMA_TOOLCHAIN_MIRROR。
		env: {},
		...over,
	});
}

function listAll(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replace(/\\/g, "/"))
		.sort();
}

beforeEach(() => {
	bucket.clear();
	requests = [];
	fwRoot = mkdtempSync(join(tmpdir(), "yoma-stm32-fw-"));
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			requests.push(url.pathname);
			const body = bucket.get(url.pathname);
			if (!body) return new Response("not found", { status: 404 });
			return new Response(body, { headers: { "content-type": "application/zip" } });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	server?.stop(true);
	server = undefined;
	rmSync(fwRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function failure(promise: Promise<unknown>): Promise<Stm32FwError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Stm32FwError) return error;
		throw error;
	}
	throw new Error("expected landStm32Firmware to reject, but it resolved");
}

// ─── 落地 ────────────────────────────────────────────────────────────────────

describe("landStm32Firmware", () => {
	it("按 FwPaths::locate 的布局落地,只留源码 / 链接脚本 / 许可证,共享 core 落在根上", async () => {
		await serveAll();
		const landed = await land();

		expect(landed.reused).toBe(false);
		expect(landed.family).toBe("STM32F1");
		expect(landed.dir).toBe(join(fwRoot, "STM32F1"));
		expect(landed.fwRoot).toBe(fwRoot);
		expect(stm32FwLanded(fwRoot, "STM32F1")).toBe(true);
		expect(stm32FwLanded(fwRoot, "stm32f1")).toBe(true);

		expect(listAll(join(fwRoot, "STM32F1"))).toEqual([
			".yoma-fw.json",
			"CMSIS_Device/Include/stm32f103xb.h",
			"CMSIS_Device/Include/stm32f1xx.h",
			"CMSIS_Device/LICENSE.txt",
			"CMSIS_Device/Source/Templates/gcc/linker/STM32F103XB_FLASH.ld",
			"CMSIS_Device/Source/Templates/gcc/startup_stm32f103xb.s",
			"CMSIS_Device/Source/Templates/iar/startup_stm32f103xb.s",
			"CMSIS_Device/Source/Templates/system_stm32f1xx.c",
			"HAL_Driver/Inc/Legacy/stm32_hal_legacy.h",
			"HAL_Driver/Inc/stm32f1xx_hal.h",
			"HAL_Driver/LICENSE.md",
			"HAL_Driver/Src/stm32f1xx_hal.c",
			"HAL_Driver/Src/stm32f1xx_hal_gpio.c",
			"SOURCE.txt",
		]);
		expect(listAll(join(fwRoot, "CMSIS_Core"))).toEqual(["Include/core_cm3.h", "LICENSE.txt", "SOURCE.txt"]);
		// 数的是真正写下的组件文件(不含 SOURCE.txt / 标记)。
		expect(landed.files).toBe(14);
		expect(landed.bytes).toBeGreaterThan(0);

		const marker = readStm32FwMarker(landed.dir);
		expect(marker?.family).toBe("STM32F1");
		expect(marker?.hal.tag).toBe(HAL.tag);
		expect(marker?.device.tag).toBe(DEV.tag);
		expect(marker?.core.tag).toBe(CORE.tag);
		expect(typeof marker?.hal.sha256).toBe("string");
		expect(readFileSync(join(landed.dir, "SOURCE.txt"), "utf8")).toContain(`${HAL.repo} @ ${HAL.tag}`);

		// 中转目录不许留下。
		expect(readdirSync(fwRoot).filter((name) => name.startsWith(".work") || name.endsWith(".extracting"))).toEqual([]);
		expect(requests.sort()).toEqual([`/${CORE.repo}-${CORE.tag}.zip`, `/${DEV.repo}-${DEV.tag}.zip`, `/${HAL.repo}-${HAL.tag}.zip`].sort());
	});

	it("core 的 Include/ 直接在仓库根上也认(两种快照布局)", async () => {
		await serveAll();
		bucket.set(`/${CORE.repo}-${CORE.tag}.zip`, await coreZip(false));
		await land();
		expect(existsSync(join(fwRoot, "CMSIS_Core", "Include", "core_cm3.h"))).toBe(true);
	});

	it("同样的 tag 已经在了就复用,一个字节都不下;force 才重下", async () => {
		await serveAll();
		await land();
		const before = requests.length;

		const again = await land();
		expect(again.reused).toBe(true);
		expect(again.files).toBe(0);
		expect(requests.length).toBe(before);

		const forced = await land({ force: true });
		expect(forced.reused).toBe(false);
		expect(requests.length).toBe(before + 3);
		expect(existsSync(join(fwRoot, "STM32F1", "HAL_Driver", "Src", "stm32f1xx_hal.c"))).toBe(true);
	});

	it("表里的 tag 升了就重下这一族;共享 core 还在就不碰", async () => {
		await serveAll();
		await land();
		const newer: Stm32FwCatalogEntry = { family: "STM32F1", hal: { repo: HAL.repo, tag: "v1.1.11" }, device: DEV };
		bucket.set(`/${HAL.repo}-v1.1.11.zip`, await halZip());
		requests = [];

		const landed = await land({ catalog: [newer] });
		expect(landed.reused).toBe(false);
		expect(landed.hal.tag).toBe("v1.1.11");
		expect(requests.sort()).toEqual([`/${DEV.repo}-${DEV.tag}.zip`, `/${HAL.repo}-v1.1.11.zip`]);
		expect(readStm32FwMarker(join(fwRoot, "STM32F1"))?.hal.tag).toBe("v1.1.11");
	});

	it("表外的族:unsupported,消息里有支持列表与手动放置的路径;MP1 说明 ST 没拆组件仓", async () => {
		const error = await failure(land({ family: "STM32MP1" }));
		expect(error.phase).toBe("unsupported");
		expect(error.message).toContain("STM32MP1");
		expect(error.message).toContain("STM32F1");
		expect(error.message).toContain("STM32CubeMP1");
		expect(error.message).toContain(join(fwRoot, "STM32MP1", "HAL_Driver"));
		expect(existsSync(join(fwRoot, "STM32MP1"))).toBe(false);
	});

	it("某个组件下不到:download 阶段失败,族目录不存在、中转目录清干净", async () => {
		await serveAll();
		bucket.delete(`/${DEV.repo}-${DEV.tag}.zip`);

		const error = await failure(land());
		expect(error.phase).toBe("download");
		expect(error.message).toContain(`${DEV.repo}@${DEV.tag}`);
		expect(error.message).toContain("HTTP 404");
		expect(existsSync(join(fwRoot, "STM32F1"))).toBe(false);
		expect(readdirSync(fwRoot).filter((name) => name.startsWith(".work") || name.endsWith(".extracting"))).toEqual([]);
	});

	it("压缩包布局不再是 generate 认的形状(Src 里没有 *_hal.c):verify 失败,不落地", async () => {
		await serveAll();
		bucket.set(`/${HAL.repo}-${HAL.tag}.zip`, await halZip({ withHalC: false }));

		const error = await failure(land());
		expect(error.phase).toBe("verify");
		expect(error.message).toContain("_hal.c");
		expect(existsSync(join(fwRoot, "STM32F1"))).toBe(false);
		// core 是独立的一步,已经完整落地的不回滚。
		expect(existsSync(join(fwRoot, "CMSIS_Core", "Include", "core_cm3.h"))).toBe(true);
	});

	it("中止:cancelled,不留半成品", async () => {
		await serveAll();
		const controller = new AbortController();
		controller.abort();
		const error = await failure(land({ signal: controller.signal }));
		expect(error.phase).toBe("cancelled");
		expect(existsSync(join(fwRoot, "STM32F1"))).toBe(false);
	});

	it("YOMA_TOOLCHAIN_MIRROR 先试(<镜像>/<repo>-<tag>.zip),镜像没有再回官方地址", async () => {
		await serveAll();
		const landed = await land({ env: { YOMA_TOOLCHAIN_MIRROR: `${baseUrl}/mirror/` } });
		expect(landed.reused).toBe(false);
		// 每个组件先撞一次镜像的 404,再从官方地址(这里也是假服务器)拿到。
		expect(requests.filter((p) => p.startsWith("/mirror/")).length).toBe(3);
		expect(requests.indexOf(`/mirror/${CORE.repo}-${CORE.tag}.zip`)).toBeLessThan(requests.indexOf(`/${CORE.repo}-${CORE.tag}.zip`));
	});
});

// ─── 只读小工具 ──────────────────────────────────────────────────────────────

describe("stm32FamilyOfPart", () => {
	const families = ["STM32F1", "STM32F4", "STM32WB", "STM32WB0", "STM32WL", "STM32WL3", "STM32U3", "STM32U5"];
	it("最长前缀赢:WL33 → WL3、WB55 → WB、U385 → U3;大小写与空白不敏感", () => {
		expect(stm32FamilyOfPart("STM32WL33K8Vx", families)).toBe("STM32WL3");
		expect(stm32FamilyOfPart("STM32WLE5JCIx", families)).toBe("STM32WL");
		expect(stm32FamilyOfPart("STM32WB55RGVx", families)).toBe("STM32WB");
		expect(stm32FamilyOfPart("STM32WB09KEVx", families)).toBe("STM32WB0");
		expect(stm32FamilyOfPart("STM32U385RGTx", families)).toBe("STM32U3");
		expect(stm32FamilyOfPart(" stm32f103c8tx ", families)).toBe("STM32F1");
	});
	it("没装这一族的 irpack 就是 undefined", () => {
		expect(stm32FamilyOfPart("STM32H743ZITx", families)).toBeUndefined();
		expect(stm32FamilyOfPart("ESP32", families)).toBeUndefined();
	});
});

describe("pickStm32FwDir", () => {
	it("第一个已落这一族的根赢;都没有回第一个(受管目录);族未知也回第一个", async () => {
		const managed = join(fwRoot, "managed");
		const bundled = join(fwRoot, "bundled");
		expect(pickStm32FwDir("STM32F1", [managed, bundled])).toBe(managed);
		await serveAll();
		await land({ fwRoot: bundled });
		expect(pickStm32FwDir("STM32F1", [managed, bundled])).toBe(bundled);
		expect(pickStm32FwDir("STM32F4", [managed, bundled])).toBe(managed);
		expect(pickStm32FwDir(undefined, [managed, bundled])).toBe(managed);
	});
});

describe("STM32_FW_CATALOG(数据表)", () => {
	it("族名唯一且大写,仓库名与 tag 非空,tag 以 v 开头;core 同理", () => {
		const families = STM32_FW_CATALOG.map((entry) => entry.family);
		expect(new Set(families).size).toBe(families.length);
		for (const entry of STM32_FW_CATALOG) {
			expect({ family: entry.family, upper: entry.family === entry.family.toUpperCase() }).toEqual({ family: entry.family, upper: true });
			for (const component of [entry.hal, entry.device]) {
				expect({ family: entry.family, repo: component.repo.length > 0 }).toEqual({ family: entry.family, repo: true });
				expect({ family: entry.family, tag: component.tag.startsWith("v") }).toEqual({ family: entry.family, tag: true });
			}
		}
		expect(STM32_CMSIS_CORE.tag.startsWith("v")).toBe(true);
	});

	it("覆盖 irpack 里除 MP1 之外的全部族(MP1 没有组件仓,是有意缺席)", () => {
		const families = STM32_FW_CATALOG.map((entry) => entry.family);
		for (const family of ["STM32F1", "STM32F4", "STM32G4", "STM32H7", "STM32WB0", "STM32WL3", "STM32U3", "STM32N6"]) {
			expect(families).toContain(family);
		}
		expect(stm32FwCatalogEntry("stm32f1")?.hal.repo).toBe("stm32f1xx-hal-driver");
		expect(stm32FwCatalogEntry("STM32MP1")).toBeUndefined();
		expect(STM32_FW_MARKER).toBe(".yoma-fw.json");
	});
});
