// 工具链自动安装(install.ts)验收:下载 → 校验 → 解压 → 记账的完整闭环,以及它的
// 每一个失败面。全程假服务器(Bun.serve port:0)+ 假目录(注入 catalog)+ mkdtemp 的
// configDir —— 一个字节都不走真网络,一个文件都不落进真实 ~/.yoma。
//
// 为什么这些断言是这些:
//
// - **阶段顺序**是 UI 的唯一进度来源(桌面端把 onProgress 转成 kernel 事件),漏一个
//   阶段的表现是进度条卡在某一格然后突然完成;total 必须来自 catalog 而不是响应头,
//   否则镜像/代理不给 content-length 时百分比直接没有。
// - **包目录 = managedPackageDir(...)**:resolve.ts 的 managed 档、machinePathDirs 的
//   PATH 注入、设置页的"已安装"全按这个位置扫,装到别处等于装了个没人看得见的东西。
// - **半成品绝不能顶着最终名字出现**:校验失败 / zip-slip / 中止之后,包目录不存在、
//   .part 不残留 —— 否则下一次安装会把一棵解了一半的树当成"已装好"。
// - **第二次安装不再下载**:Arm 那个包 296 MB,重复下载在真机上是几分钟的静默等待。
// - **同一个包同时只能装一个**:两个进程同时往一个目录解压,产出的树是两次解压交错
//   的结果,而且不报错。
// - **zip-slip**:压缩包是从网上下的,一个 `../` 条目就能写到包目录外面去。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";

import { BlobWriter, configure, TextReader, terminateWorkers, ZipWriter } from "@zip.js/zip.js";

import type { CatalogArtifact, CatalogPackage, HostKey } from "../src/core/toolchain/catalog.ts";
import { hostKey } from "../src/core/toolchain/catalog.ts";
import {
	type InstallProgress,
	installToolchain,
	listManagedInstalls,
	machinePathDirs,
	MANAGED_MARKER,
	managedPackageDir,
	managedRoot,
	ToolchainInstallError,
	withMachineOnPath,
} from "../src/core/toolchain/install.ts";
import type { Ledger } from "../src/core/toolchain/ledger.ts";
import { readLedger } from "../src/core/toolchain/ledger.ts";
import { writeFakeExe } from "./fixtures/fake-exe.ts";
import { type FetchServer, serveFetch } from "./fixtures/fetch-server.ts";

// zip.js 默认起 web worker 做压缩;测试进程里没必要,而且退出时容易留下悬挂的 worker。
configure({ useWebWorkers: false });
afterAll(async () => {
	await terminateWorkers();
});

const PKG_ID = "widget-tools";
const PKG_VERSION = "1.2.3";
const ROOT = "widget-1.2.3";
/** 产物只是一张按宿主键查的表,用本机的键让"平台相关的解压细节"也走真实分支。 */
const HOST: HostKey = hostKey() ?? "linux-x64";

/** 假可执行文件:Windows 是 .bat,其它平台是 #!/bin/sh —— 与 toolchain-resolve.test.ts 同一套。 */
const EXE_NAME = process.platform === "win32" ? "widget.bat" : "widget";
const EXE_BODY = process.platform === "win32" ? "@echo off\r\necho 1.2.3\r\n" : '#!/bin/sh\necho "1.2.3"\n';

const TAR_BINARY =
	process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

// ─── 假产物 ──────────────────────────────────────────────────────────────────

interface ZipEntry {
	name: string;
	body: string;
	/** 写进 external file attribute 的 unix 权限位(POSIX 解压时的可执行位来源)。 */
	mode?: number;
}

async function makeZip(entries: ZipEntry[]): Promise<Buffer> {
	const writer = new ZipWriter(new BlobWriter("application/zip"));
	for (const entry of entries) {
		await writer.add(entry.name, new TextReader(entry.body), {
			externalFileAttributes: (((entry.mode ?? 0o644) | 0o100000) << 16) >>> 0,
		});
	}
	const blob = await writer.close();
	return Buffer.from(await blob.arrayBuffer());
}

/** 正常形态:<root>/bin/<假 exe>,带可执行位。 */
function happyZip(): Promise<Buffer> {
	return makeZip([{ name: `${ROOT}/bin/${EXE_NAME}`, body: EXE_BODY, mode: 0o755 }]);
}

function hasSystemTar(): boolean {
	try {
		return spawnSync(TAR_BINARY, ["--version"], { encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
}

/** 用系统 tar 打一个 <root>/bin/<假 exe> 的 tar.gz —— 与 install.ts 解压走的是同一个二进制。 */
function makeTarGz(): Buffer {
	const work = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-tar-"));
	const out = `${work}.tar.gz`;
	try {
		const binDir = join(work, ROOT, "bin");
		mkdirSync(binDir, { recursive: true });
		const file = join(binDir, EXE_NAME);
		writeFileSync(file, EXE_BODY);
		if (process.platform !== "win32") chmodSync(file, 0o755);
		const result = spawnSync(TAR_BINARY, ["-czf", out, "-C", work, ROOT], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`fixture tar failed: ${result.stderr}`);
		return readFileSync(out);
	} finally {
		rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		rmSync(out, { force: true });
	}
}

// ─── 假目录 ──────────────────────────────────────────────────────────────────

function fakeCatalog(artifact: Partial<CatalogArtifact> & Pick<CatalogArtifact, "url" | "sha256" | "bytes">): CatalogPackage[] {
	const artifacts: CatalogPackage["artifacts"] = {};
	artifacts[HOST] = { archive: "zip", root: ROOT, binDir: "bin", ...artifact };
	return [
		{
			id: PKG_ID,
			title: "Widget Tools",
			version: PKG_VERSION,
			provides: ["widget"],
			bins: ["widget"],
			artifacts,
		},
	];
}

// ─── 假服务器 ────────────────────────────────────────────────────────────────

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

let server: FetchServer | undefined;
let baseUrl: string;
let configDir: string;
/** 路径 → 字节。测试直接往里放产物;没放的路径返回 404。 */
const bucket = new Map<string, Buffer>();
/** 按到达顺序记下每一次请求的 pathname —— "镜像先试"这条断言只能靠顺序验证。 */
let requests: string[] = [];
let handler: Handler;

function serveBucket(url: URL): Response {
	const body = bucket.get(url.pathname);
	if (!body) return new Response("not found", { status: 404 });
	return new Response(body, { headers: { "content-type": "application/octet-stream", "content-length": String(body.byteLength) } });
}

beforeEach(async () => {
	bucket.clear();
	requests = [];
	handler = (_request, url) => serveBucket(url);
	configDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-config-"));
	server = await serveFetch((request) => {
		const url = new URL(request.url);
		requests.push(url.pathname);
		return handler(request, url);
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	server?.stop();
	server = undefined;
	// maxRetries/retryDelay:configDir 里躺着刚被 probeVersion spawn 过的假 exe,
	// Windows 上句柄释放偶尔慢一拍(根 CLAUDE.md 与 toolchain-resolve.test.ts 同一条)。
	rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/** 相邻去重的阶段序列 —— download 会连报很多次,断言看的是"阶段的先后",不是次数。 */
function phaseOrder(progress: InstallProgress[]): string[] {
	const out: string[] = [];
	for (const p of progress) if (out[out.length - 1] !== p.phase) out.push(p.phase);
	return out;
}

function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** 整个 managedRoot 下所有以 .part 结尾的文件 —— "半成品不许残留"这条的唯一检查口。 */
function partFiles(): string[] {
	return listFiles(managedRoot(configDir)).filter((name) => name.endsWith(".part"));
}

async function failure(promise: Promise<unknown>): Promise<ToolchainInstallError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ToolchainInstallError) return error;
		throw error;
	}
	throw new Error("expected installToolchain to reject, but it resolved");
}

interface MarkerShape {
	packageId?: unknown;
	version?: unknown;
	provides?: unknown;
	archiveSha256?: unknown;
	binDir?: unknown;
	installedAt?: unknown;
	dir?: unknown;
}

function readMarkerJson(dir: string): MarkerShape {
	return JSON.parse(readFileSync(join(dir, MANAGED_MARKER), "utf8")) as MarkerShape;
}

// ─── 顺利装完 ────────────────────────────────────────────────────────────────

describe("installToolchain 顺利装完(zip)", () => {
	it("阶段按 resolve→download→verify→extract→record→done 报,download 的 total 来自 catalog", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const progress: InstallProgress[] = [];
		await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env: { PATH: "" },
			onProgress: (p) => progress.push(p),
		});

		expect(phaseOrder(progress)).toEqual(["resolve", "download", "verify", "extract", "record", "done"]);

		const downloads = progress.filter((p) => p.phase === "download");
		expect(downloads.length).toBeGreaterThan(0);
		for (const p of downloads) {
			expect(p.total).toBe(zip.byteLength);
			expect(typeof p.bytes).toBe("number");
		}
		// 字节数只增不减,最后一条等于总数。
		const bytes = downloads.map((p) => p.bytes ?? -1);
		expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
		expect(bytes[bytes.length - 1]).toBe(zip.byteLength);

		// 每一条进度都自报是哪个工具/包/版本 —— UI 靠它把事件分派到对应的行。
		for (const p of progress) {
			expect({ toolId: p.toolId, packageId: p.packageId, version: p.version }).toEqual({
				toolId: "widget",
				packageId: PKG_ID,
				version: PKG_VERSION,
			});
		}
	});

	it("落点是 managedPackageDir(...),binDir 下是解出来的可执行文件,压缩包用完即删", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const installed = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });

		const dir = managedPackageDir(PKG_ID, PKG_VERSION, configDir);
		expect(installed.packageId).toBe(PKG_ID);
		expect(installed.version).toBe(PKG_VERSION);
		expect(installed.dir).toBe(dir);
		expect(installed.binDir).toBe(join(dir, "bin"));
		expect(installed.reused).toBe(false);
		expect(existsSync(join(installed.binDir, EXE_NAME))).toBe(true);
		// 解压中转目录不许留下
		expect(existsSync(`${dir}.extracting`)).toBe(false);
		// 压缩包(以及它的 .part)用完就删,296 MB 的东西不能在用户盘上躺两份
		expect(listFiles(join(managedRoot(configDir), "downloads"))).toEqual([]);
		expect(partFiles()).toEqual([]);
	});

	it("包目录里写下 .yoma-toolchain.json 标记:packageId / version / provides / archiveSha256 / binDir", async () => {
		const zip = await happyZip();
		const sha = sha256(zip);
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha, bytes: zip.byteLength });

		const installed = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });

		const marker = readMarkerJson(installed.dir);
		expect(marker.packageId).toBe(PKG_ID);
		expect(marker.version).toBe(PKG_VERSION);
		expect(marker.provides).toEqual(["widget"]);
		expect(marker.archiveSha256).toBe(sha);
		expect(typeof marker.installedAt).toBe("number");
		// binDir 记相对还是绝对都行(readMarker 两种都认),但必须指向真正的 binDir。
		expect(resolvePath(installed.dir, String(marker.binDir))).toBe(installed.binDir);

		// 标记写对了,listManagedInstalls 就该看得见这次安装。
		const managed = listManagedInstalls(configDir);
		expect(managed.map((m) => ({ packageId: m.packageId, version: m.version, binDir: m.binDir }))).toEqual([
			{ packageId: PKG_ID, version: PKG_VERSION, binDir: installed.binDir },
		]);
	});

	it("provides 的每个 id 记进账本,by:'user',路径落在 binDir 下", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const installed = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });

		expect(installed.recorded.map((r) => r.id)).toEqual(["widget"]);
		for (const record of installed.recorded) {
			expect(dirname(record.binPath).toLowerCase()).toBe(installed.binDir.toLowerCase());
		}

		const ledger = await readLedger(configDir);
		const entry = ledger.entries.widget;
		expect(entry).toBeDefined();
		expect(entry.by).toBe("user");
		for (const binPath of Object.values(entry.bin)) {
			expect(dirname(binPath).toLowerCase()).toBe(installed.binDir.toLowerCase());
		}
	});

	it("第二次安装同一个包:reused:true,而且假服务器上一次下载请求都没有", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const first = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });
		expect(first.reused).toBe(false);

		requests = [];
		const progress: InstallProgress[] = [];
		const second = await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env: { PATH: "" },
			onProgress: (p) => progress.push(p),
		});

		expect(second.reused).toBe(true);
		expect(second.dir).toBe(first.dir);
		expect(second.binDir).toBe(first.binDir);
		expect(requests).toEqual([]);
		expect(phaseOrder(progress)).not.toContain("download");
		// 复用也要重新记账(账本可能被别的动作覆盖过)。
		expect(second.recorded.map((r) => r.id)).toEqual(["widget"]);
	});
});

// ─── 镜像 ────────────────────────────────────────────────────────────────────

describe("镜像", () => {
	it("opts.mirror 排在 url 前面:主地址 404 也照样装成,而且镜像是第一个被请求的", async () => {
		const zip = await happyZip();
		bucket.set("/mirror/widget.zip", zip); // 主地址故意不放进桶里 → 404
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const installed = await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env: { PATH: "" },
			mirror: `${baseUrl}/mirror`,
		});

		expect(installed.reused).toBe(false);
		expect(requests[0]).toBe("/mirror/widget.zip");
	});

	it("env 的 YOMA_TOOLCHAIN_MIRROR 同样生效", async () => {
		const zip = await happyZip();
		bucket.set("/mirror/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const installed = await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env: { PATH: "", YOMA_TOOLCHAIN_MIRROR: `${baseUrl}/mirror` },
		});

		expect(installed.reused).toBe(false);
		expect(requests[0]).toBe("/mirror/widget.zip");
	});

	it("catalog 自带的 mirrors 排在 url 之前,主地址仍然是最后的兜底", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip); // 主地址可用
		const catalog = fakeCatalog({
			url: `${baseUrl}/widget.zip`,
			mirrors: [`${baseUrl}/nowhere/widget.zip`],
			sha256: sha256(zip),
			bytes: zip.byteLength,
		});

		const installed = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });

		expect(installed.reused).toBe(false);
		expect(requests).toEqual(["/nowhere/widget.zip", "/widget.zip"]);
	});

	it("全部候选都失败:phase 'download',报错里把试过的地址列出来", async () => {
		const zip = await happyZip();
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength }); // 桶是空的

		const error = await failure(
			installToolchain({
				toolId: "widget",
				configDir,
				host: HOST,
				catalog,
				env: { PATH: "" },
				mirror: `${baseUrl}/mirror`,
			}),
		);

		expect(error.phase).toBe("download");
		expect(error.toolId).toBe("widget");
		expect(error.message).toContain(`${baseUrl}/mirror/widget.zip`);
		expect(error.message).toContain(`${baseUrl}/widget.zip`);
		expect(existsSync(managedPackageDir(PKG_ID, PKG_VERSION, configDir))).toBe(false);
		expect(partFiles()).toEqual([]);
	});
});

// ─── 失败面 ──────────────────────────────────────────────────────────────────

describe("校验失败", () => {
	it("sha256 对不上:phase 'verify',包目录不存在,.part 不残留,下载的文件被删掉", async () => {
		const zip = await happyZip();
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: "b".repeat(64), bytes: zip.byteLength });

		const error = await failure(installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } }));

		expect(error.phase).toBe("verify");
		expect(error.message.toLowerCase()).toContain("sha256");
		expect(existsSync(managedPackageDir(PKG_ID, PKG_VERSION, configDir))).toBe(false);
		expect(partFiles()).toEqual([]);
		expect(listFiles(join(managedRoot(configDir), "downloads"))).toEqual([]);
		expect(listManagedInstalls(configDir)).toEqual([]);
	});
});

describe("zip-slip", () => {
	it("压缩包里有指向包目录之外的条目:phase 'extract',外面一个字节都没写", async () => {
		const zip = await makeZip([
			{ name: `${ROOT}/bin/${EXE_NAME}`, body: EXE_BODY, mode: 0o755 },
			{ name: "../evil.txt", body: "pwned\n" },
		]);
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const error = await failure(installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } }));

		expect(error.phase).toBe("extract");
		expect(error.message).toMatch(/zip[- ]?slip/i);

		const dir = managedPackageDir(PKG_ID, PKG_VERSION, configDir);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(`${dir}.extracting`)).toBe(false);
		// `../evil.txt` 相对解压目录,落点是包目录的父目录(<root>/<pkg>/)。
		expect(existsSync(join(dirname(dir), "evil.txt"))).toBe(false);
		expect(existsSync(join(managedRoot(configDir), "evil.txt"))).toBe(false);
		expect(existsSync(join(configDir, "evil.txt"))).toBe(false);
		expect(listManagedInstalls(configDir)).toEqual([]);
	});
});

describe("中止", () => {
	it(
		"下载中 abort:phase 'cancelled',.part 清掉,包目录不存在",
		async () => {
			const zip = await happyZip();
			const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

			// 先给几个字节让下载真的开始,再干等 —— 中止必须在传输途中发生。
			handler = (_request, url) => {
				if (url.pathname !== "/widget.zip") return serveBucket(url);
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new Uint8Array(zip.subarray(0, 16)));
						await new Promise((resolve) => setTimeout(resolve, 3000));
						controller.enqueue(new Uint8Array(zip.subarray(16)));
						controller.close();
					},
				});
				return new Response(body, { headers: { "content-length": String(zip.byteLength) } });
			};

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 300);
			try {
				const error = await failure(
					installToolchain({
						toolId: "widget",
						configDir,
						host: HOST,
						catalog,
						env: { PATH: "" },
						signal: controller.signal,
						onProgress: (p) => {
							if (p.phase === "download" && (p.bytes ?? 0) > 0) controller.abort();
						},
					}),
				);
				expect(error.phase).toBe("cancelled");
				expect(partFiles()).toEqual([]);
				expect(existsSync(managedPackageDir(PKG_ID, PKG_VERSION, configDir))).toBe(false);
			} finally {
				clearTimeout(timer);
			}
		},
		15_000,
	);
});

describe("装不了的东西", () => {
	it("目录里没有这个工具 id:phase 'resolve',报错点名这个工具", async () => {
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: "a".repeat(64), bytes: 10 });
		const error = await failure(installToolchain({ toolId: "nope", configDir, host: HOST, catalog, env: { PATH: "" } }));
		expect(error.phase).toBe("resolve");
		expect(error.toolId).toBe("nope");
		expect(error.message).toContain("nope");
	});

	it("这个宿主没有产物:phase 'resolve',报错点名工具与宿主", async () => {
		const zip = await happyZip();
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });
		const otherHost: HostKey = HOST === "linux-arm64" ? "darwin-x64" : "linux-arm64";

		const error = await failure(
			installToolchain({ toolId: "widget", configDir, host: otherHost, catalog, env: { PATH: "" } }),
		);
		expect(error.phase).toBe("resolve");
		expect(error.message).toContain("widget");
		expect(error.message).toContain(otherHost);
	});
});

describe("并发", () => {
	it(
		"同一个包的第二次安装在第一次还在飞的时候被拒,报错里说得清是'已经在装了'",
		async () => {
			const zip = await happyZip();
			bucket.set("/widget.zip", zip);
			const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

			let release: () => void = () => {};
			const gate = new Promise<void>((resolveGate) => {
				release = resolveGate;
			});
			let markStarted: () => void = () => {};
			const started = new Promise<void>((resolveStarted) => {
				markStarted = resolveStarted;
			});

			handler = async (_request, url) => {
				if (url.pathname === "/widget.zip") {
					markStarted();
					await gate;
				}
				return serveBucket(url);
			};

			// 两个 promise 都先包成"永不 reject",否则先失败的那个会在断言之前把
			// 测试打断,报出来的是它的错误而不是这条用例真正想说的事。
			const settle = (p: Promise<unknown>) => p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
			const first = settle(installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } }));
			await started;
			const second = settle(installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } }));

			// 第二次必须**立刻**被拒(锁在下载之前就该拿);拖着不返回本身就是失败 ——
			// 那意味着它正跟着第一次一起往同一个目录里解压。
			const outcome = await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 2000)).then(() => "still-running" as const)]);
			release();
			const firstOutcome = await first;
			await second;

			expect(outcome).not.toBe("still-running");
			const error = typeof outcome === "string" ? undefined : outcome.ok ? undefined : outcome.error;
			expect(error).toBeInstanceOf(ToolchainInstallError);
			expect((error as ToolchainInstallError).phase).toBe("resolve");
			expect((error as ToolchainInstallError).message.toLowerCase()).toContain("already");
			expect(firstOutcome.ok).toBe(true);
		},
		20_000,
	);
});

describe.skipIf(!hasSystemTar())("tar.gz", () => {
	it("走系统 tar 解压,落点 / 标记 / 账本与 zip 路径完全一致", async () => {
		const archive = makeTarGz();
		bucket.set("/widget.tar.gz", archive);
		const catalog = fakeCatalog({
			url: `${baseUrl}/widget.tar.gz`,
			sha256: sha256(archive),
			bytes: archive.byteLength,
			archive: "tar.gz",
		});

		const progress: InstallProgress[] = [];
		const installed = await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env: { PATH: "" },
			tarBinary: TAR_BINARY,
			onProgress: (p) => progress.push(p),
		});

		expect(phaseOrder(progress)).toEqual(["resolve", "download", "verify", "extract", "record", "done"]);
		expect(installed.dir).toBe(managedPackageDir(PKG_ID, PKG_VERSION, configDir));
		expect(installed.binDir).toBe(join(installed.dir, "bin"));
		expect(existsSync(join(installed.binDir, EXE_NAME))).toBe(true);
		expect(readMarkerJson(installed.dir).archiveSha256).toBe(sha256(archive));
		expect(listFiles(join(managedRoot(configDir), "downloads"))).toEqual([]);

		const ledger = await readLedger(configDir);
		expect(ledger.entries.widget?.by).toBe("user");
	});
});

// ─── tar 子进程的 PATH ────────────────────────────────────────────────────────
//
// GNU tar(Linux)自己不解压,gzip / xz 是它按 PATH 去找的**外部程序**;bsdtar(macOS、
// Windows 的 System32\tar.exe)在库里解完,所以上面那条"走系统 tar"的用例把注入的
// `PATH: ""` 原样传下去时,只有 Ubuntu 岗会炸(`gzip: Cannot exec: No such file or directory`
// → `tar: Child returned status 2`,2026-09-06 CI 实测),Windows / macOS 全绿 —— 一个只在
// 一个平台上会响的闸门。这两条改用**假 tar**:它把自己收到的 PATH 写进探针文件,于是每个
// 平台都验得到 tarEnv 的两半 —— 注入的 PATH 为空就回落到本进程的 PATH,非空则原样照用
//(调用方显式给的 PATH 绝不能被顶掉)。

/** 本进程的 PATH(Windows 上这个键可能叫 `Path`)。 */
function ownPath(): string {
	const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
	return key === undefined ? "" : (process.env[key] ?? "");
}

/**
 * 假 tar:把收到的 PATH 写进探针文件(路径直接烤进脚本 —— 注入的 env 只有 PATH,没有别的口子
 * 传得进来),再造出 `<dest>/<ROOT>/bin/<EXE_NAME>`,让解压后的 anyBinResolves 与记账阶段照常过。
 */
function fakeTarJs(probe: string): string {
	return `
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const dest = argv[argv.indexOf("-C") + 1];
const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
writeFileSync(${JSON.stringify(probe)}, key === undefined ? "" : (process.env[key] ?? ""));
const binDir = join(dest, ${JSON.stringify(ROOT)}, "bin");
mkdirSync(binDir, { recursive: true });
const exe = join(binDir, ${JSON.stringify(EXE_NAME)});
writeFileSync(exe, ${JSON.stringify(EXE_BODY)});
if (process.platform !== "win32") chmodSync(exe, 0o755);
`;
}

describe("tar 子进程的 PATH", () => {
	let tarDir: string;
	let probe: string;

	beforeEach(() => {
		tarDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-faketar-"));
		probe = join(tarDir, "seen-path.txt");
	});

	afterEach(() => {
		rmSync(tarDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});

	interface FakeTarRun {
		installed: Awaited<ReturnType<typeof installToolchain>>;
		progress: InstallProgress[];
	}

	/** 压缩包的内容无所谓:假 tar 根本不读它,只有 sha256 与字节数要对得上。 */
	async function installWithFakeTar(env: NodeJS.ProcessEnv): Promise<FakeTarRun> {
		const archive = Buffer.from("fake archive; the fake tar never reads it\n");
		bucket.set("/widget.tar.gz", archive);
		const catalog = fakeCatalog({
			url: `${baseUrl}/widget.tar.gz`,
			sha256: sha256(archive),
			bytes: archive.byteLength,
			archive: "tar.gz",
		});

		const progress: InstallProgress[] = [];
		const installed = await installToolchain({
			toolId: "widget",
			configDir,
			host: HOST,
			catalog,
			env,
			tarBinary: writeFakeExe(tarDir, "faketar", fakeTarJs(probe)),
			onProgress: (p) => progress.push(p),
		});
		return { installed, progress };
	}

	it("注入的 env 里 PATH 是空的:tar 子进程拿到的是本进程的 PATH,而不是空串", async () => {
		const { installed, progress } = await installWithFakeTar({ PATH: "" });

		expect(existsSync(probe)).toBe(true);
		const seen = readFileSync(probe, "utf8");
		expect(seen).not.toBe("");
		expect(seen).toBe(ownPath());

		// 回落之后这一趟安装本身也得走完 —— 否则"PATH 对了但装不上"照样是坏的。
		expect(phaseOrder(progress)).toEqual(["resolve", "download", "verify", "extract", "record", "done"]);
		expect(existsSync(join(installed.binDir, EXE_NAME))).toBe(true);
		expect(readMarkerJson(installed.dir).packageId).toBe(PKG_ID);
		expect(listFiles(join(managedRoot(configDir), "downloads"))).toEqual([]);
		const ledger = await readLedger(configDir);
		expect(ledger.entries.widget?.by).toBe("user");
	});

	it("注入的 env 里 PATH 非空:原样传给 tar,不被本进程的 PATH 顶掉", async () => {
		const { installed } = await installWithFakeTar({ PATH: tarDir });

		expect(existsSync(probe)).toBe(true);
		expect(readFileSync(probe, "utf8")).toBe(tarDir);
		expect(existsSync(join(installed.binDir, EXE_NAME))).toBe(true);
	});
});

describe("POSIX 可执行位", () => {
	it.skipIf(process.platform === "win32")("zip 里没有可执行位时,binDir 下的文件解压后仍然可执行", async () => {
		const zip = await makeZip([{ name: `${ROOT}/bin/${EXE_NAME}`, body: EXE_BODY, mode: 0o644 }]);
		bucket.set("/widget.zip", zip);
		const catalog = fakeCatalog({ url: `${baseUrl}/widget.zip`, sha256: sha256(zip), bytes: zip.byteLength });

		const installed = await installToolchain({ toolId: "widget", configDir, host: HOST, catalog, env: { PATH: "" } });

		const mode = statSync(join(installed.binDir, EXE_NAME)).mode;
		expect(mode & 0o111).not.toBe(0);
	});
});

// ─── 目录扫描与 PATH 组装(纯本地,不碰服务器) ─────────────────────────────────

interface SeedOptions {
	provides?: string[];
	/** 标记里写的 binDir(相对包目录);默认 "bin"。 */
	binDir?: string;
	/** 是否真的建出 binDir 目录;默认建。 */
	makeBinDir?: boolean;
	/** 直接指定标记文件的原文(测坏标记)。 */
	markerText?: string;
}

function seedManaged(cfg: string, packageId: string, version: string, opts: SeedOptions = {}): { dir: string; binDir: string } {
	const dir = managedPackageDir(packageId, version, cfg);
	mkdirSync(dir, { recursive: true });
	const binDirRel = opts.binDir ?? "bin";
	const binDir = join(dir, binDirRel);
	if (opts.makeBinDir !== false) mkdirSync(binDir, { recursive: true });
	const text =
		opts.markerText ??
		JSON.stringify({
			packageId,
			version,
			dir,
			binDir: binDirRel,
			provides: opts.provides ?? [packageId],
			archiveSha256: "c".repeat(64),
			installedAt: 1,
		});
	writeFileSync(join(dir, MANAGED_MARKER), text);
	return { dir, binDir };
}

describe("listManagedInstalls", () => {
	it("同一个包按版本新到旧排(数字段比较,不是字符串序)", () => {
		seedManaged(configDir, PKG_ID, "1.2.3");
		seedManaged(configDir, PKG_ID, "1.10.0");
		seedManaged(configDir, PKG_ID, "0.9.0");

		expect(listManagedInstalls(configDir).map((m) => m.version)).toEqual(["1.10.0", "1.2.3", "0.9.0"]);
	});

	it("标记里的 binDir 目录不存在时整条忽略 —— 半个安装不能被当成装好了", () => {
		seedManaged(configDir, PKG_ID, "1.2.3", { makeBinDir: false });
		expect(listManagedInstalls(configDir)).toEqual([]);
	});

	it("标记坏了(不是 JSON / 缺关键字段)整条忽略,不连累同一个包的其它版本", () => {
		seedManaged(configDir, PKG_ID, "1.0.0", { markerText: "{ not json" });
		seedManaged(configDir, PKG_ID, "2.0.0", { markerText: JSON.stringify({ version: "2.0.0" }) });
		const good = seedManaged(configDir, PKG_ID, "3.0.0");

		expect(listManagedInstalls(configDir).map((m) => m.version)).toEqual(["3.0.0"]);
		expect(listManagedInstalls(configDir)[0].binDir).toBe(good.binDir);
	});

	it("没有 toolchains 目录时返回空数组,不抛", () => {
		const empty = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-empty-"));
		try {
			expect(listManagedInstalls(empty)).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("machinePathDirs", () => {
	function ledgerOf(entries: Ledger["entries"]): Ledger {
		return { schema: "yoma/toolchains@1", entries };
	}

	it("managed 在前,账本 by:'user' 的在后;auto 条目不进,路径没了的不进,重复的去重", () => {
		const managed = seedManaged(configDir, PKG_ID, "1.2.3", { provides: ["widget"] });
		const userDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-user-"));
		const autoDir = mkdtempSync(join(tmpdir(), "yoma-toolchain-install-auto-"));
		try {
			const userExe = join(userDir, EXE_NAME);
			writeFileSync(userExe, EXE_BODY);
			const autoExe = join(autoDir, EXE_NAME);
			writeFileSync(autoExe, EXE_BODY);
			// managed binDir 里也放一个,并让账本 by:"user" 指向它 —— 去重必须响。
			const managedExe = join(managed.binDir, EXE_NAME);
			writeFileSync(managedExe, EXE_BODY);

			const dirs = machinePathDirs({
				configDir,
				ledger: ledgerOf({
					widget: { id: "widget", bin: { widget: managedExe }, confirmedAt: 1, by: "user" },
					gadget: { id: "gadget", bin: { gadget: userExe }, confirmedAt: 1, by: "user" },
					gone: { id: "gone", bin: { gone: join(userDir, "not-here") }, confirmedAt: 1, by: "user" },
					sniffed: { id: "sniffed", bin: { sniffed: autoExe }, confirmedAt: 1, by: "auto" },
				}),
			});

			expect(dirs).toEqual([managed.binDir, userDir]);
		} finally {
			rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			rmSync(autoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
	});

	it("不传账本时只有 managed 的目录", () => {
		const managed = seedManaged(configDir, PKG_ID, "1.2.3");
		expect(machinePathDirs({ configDir })).toEqual([managed.binDir]);
	});

	it("什么都没有时是空数组", () => {
		expect(machinePathDirs({ configDir })).toEqual([]);
	});
});

describe("withMachineOnPath", () => {
	it("前置进 PATH,保持给定顺序,原有的 PATH 跟在后面", () => {
		const out = withMachineOnPath({ PATH: ["/usr/bin", "/bin"].join(delimiter) }, ["/a", "/b"]);
		expect(out.PATH).toBe(["/a", "/b", "/usr/bin", "/bin"].join(delimiter));
	});

	it("已经在 PATH 里的目录不再重复前置", () => {
		const env = { PATH: ["/usr/bin", "/a"].join(delimiter) };
		const out = withMachineOnPath(env, ["/a", "/b"]);
		expect(out.PATH).toBe(["/b", "/usr/bin", "/a"].join(delimiter));
	});

	it('原来的键叫 "Path"(Windows 常见形态)时写回同一个键,不凭空多出一个 "PATH"', () => {
		const env = { Path: "C:\\base" } as NodeJS.ProcessEnv;
		const out = withMachineOnPath(env, ["C:\\managed\\bin"]);
		expect(out.Path).toBe(["C:\\managed\\bin", "C:\\base"].join(delimiter));
		expect(out.PATH).toBeUndefined();
	});

	it("没有东西要加时原样返回同一个对象(不复制、不改动)", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		expect(withMachineOnPath(env, [])).toBe(env);
		expect(withMachineOnPath(env, ["/usr/bin"])).toBe(env);
	});

	it("base 里压根没有 PATH 时新建一个 PATH 键", () => {
		const out = withMachineOnPath({ HOME: "/home/x" }, ["/a"]);
		expect(out.PATH).toBe("/a");
		expect(out.HOME).toBe("/home/x");
	});

	it("不改动传进来的那个对象", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		withMachineOnPath(env, ["/a"]);
		expect(env.PATH).toBe("/usr/bin");
	});
});
