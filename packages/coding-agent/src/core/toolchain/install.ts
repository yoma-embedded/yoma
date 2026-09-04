/**
 * 工具链自动安装:按 catalog.ts 钉住的官方发布包,下载 → sha256 校验 → 解压到
 * `<configDir>/toolchains/<包>/<版本>/` → 记进机器账本。所有宿主(桌面设置页、agent 的
 * toolchain install 动作、bench/信箱工位端)共用这一份实现。
 *
 * ## 落点为什么在 configDir
 *
 * 工具链是电脑的属性(families.ts 文件头),账本已经住在 `<configDir>/toolchains.json`;
 * 装出来的东西住在旁边的 `toolchains/` 目录,一并跟着 configDir 走 —— 桌面端、bench CLI、
 * 信箱工位端(没有 Electron userData)读的是同一处,app 升级 / 重装也不丢。绝不落进
 * `process.resourcesPath`(Windows 按机安装时不可写,macOS 会破坏签名)。
 *
 * ## 完整性
 *
 * - 下载到 `downloads/<文件名>.part`,边写边算 sha256,对不上 catalog 就删;
 * - 解压到 `<包目录>.extracting`,成功后整体 rename 成包目录,并在里面写 `.yoma-toolchain.json`
 *   标记 —— "半解压的树"绝不可能顶着最终名字出现(纪律抄自 examples/sync.ts);旧包目录先
 *   挪到一边再换新的,任何一步失败机器上都不会"两个都没有";
 * - "已装好"的判定看**可执行文件真的在不在**,不看目录在不在:被杀毒软件隔离、被人删了一半的
 *   包目录若被当成装好,记账时会把目录本身当成可执行文件记进去,之后核账永远报 ok、构建永远
 *   command not found,而且 install 永远走复用分支修不好(实测);
 * - 同一个包同时只允许一个安装(pid 锁文件 + 进程内表;锁超过 2 小时视为遗留,pid 会被回收)。
 *
 * ## 解压器
 *
 * zip 走 @zip.js/zip.js(进程内、流式、可挡 zip-slip、可从 external attribute 恢复可执行位);
 * tar.gz / tar.xz 走系统 tar(POSIX 都有,xz 支持看 tar 的构建;Windows 用 System32\tar.exe,
 * 但目录里 Windows 的产物全是 zip)。
 *
 * ## 账本
 *
 * 装完对包 provides 的每个工具 id 调 actions.ts 的 recordToolchainPath(by:"user"):设置页、
 * agent 的 check、系统提示词、PATH 注入全部免费得到。resolve.ts 另有 "managed" 一档扫这个
 * 目录,所以哪怕 skipLedger 的新鲜探测也找得到 Yoma 装的东西。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { recordToolchainPath } from "./actions.ts";
import {
	type CatalogArtifact,
	type CatalogPackage,
	catalogArtifact,
	catalogPackageFor,
	type HostKey,
	hostKey,
	TOOLCHAIN_CATALOG,
	TOOLCHAIN_MIRROR_ENV,
} from "./catalog.ts";
import { findFamilyTool } from "./families.ts";
import type { Ledger } from "./ledger.ts";
import { findEnvKey, findOnPath, withPath } from "./locations.ts";

/** `<configDir>/toolchains` */
export const MANAGED_DIRNAME = "toolchains";
/** 包目录里的完成标记(内容是 ManagedInstall 减去绝对路径)。 */
export const MANAGED_MARKER = ".yoma-toolchain.json";
/** 锁文件超过这个岁数当作遗留(进程被硬杀、pid 已被回收):没有哪次合法下载会跑这么久。 */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export interface ManagedInstall {
	packageId: string;
	version: string;
	/** 包目录(绝对路径)。 */
	dir: string;
	/** 可执行文件所在目录(绝对路径)。 */
	binDir: string;
	provides: string[];
	archiveSha256: string;
	installedAt: number;
}

export type InstallPhase = "resolve" | "download" | "verify" | "extract" | "record" | "done" | "error" | "cancelled";

export interface InstallProgress {
	toolId: string;
	packageId: string;
	version: string;
	phase: InstallPhase;
	/** download 阶段:已收字节数 / 总字节数(总数来自 catalog)。 */
	bytes?: number;
	total?: number;
	message?: string;
}

export interface InstallToolchainOptions {
	toolId: string;
	/** 默认 ~/.yoma。测试必须注入。 */
	configDir?: string;
	/** 默认 hostKey()(process.platform-arch)。测试注入。 */
	host?: HostKey;
	signal?: AbortSignal;
	onProgress?: (progress: InstallProgress) => void;
	/** 测试注入:替代全局 fetch。 */
	fetchImpl?: typeof fetch;
	/** 测试注入:替代 TOOLCHAIN_CATALOG。 */
	catalog?: readonly CatalogPackage[];
	/** 默认 process.env(读 YOMA_TOOLCHAIN_MIRROR;版本探测用)。 */
	env?: NodeJS.ProcessEnv;
	/** 镜像基址,排在 env 与 catalog 的镜像之前。 */
	mirror?: string;
	/** 测试注入:解 tar 用的二进制,默认按平台选。 */
	tarBinary?: string;
}

export interface InstalledToolchain {
	packageId: string;
	version: string;
	dir: string;
	binDir: string;
	/** 已经装好且 sha 相同,跳过了下载与解压,只重新记账。 */
	reused: boolean;
	recorded: Array<{ id: string; binPath: string; version?: string }>;
}

/**
 * 安装失败。`data` 是跨 MessagePort 时唯一能带过去的结构化信息(kernel-entry 只序列化
 * message / stack / data),UI 靠它分辨"用户点了取消"和"真失败"。
 */
export class ToolchainInstallError extends Error {
	readonly phase: InstallPhase;
	readonly toolId: string;
	readonly packageId?: string;
	readonly version?: string;
	readonly data: { _tag: "ToolchainInstallError"; phase: InstallPhase; toolId: string; packageId?: string; version?: string };
	constructor(
		phase: InstallPhase,
		toolId: string,
		message: string,
		options?: { cause?: unknown; packageId?: string; version?: string },
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "ToolchainInstallError";
		this.phase = phase;
		this.toolId = toolId;
		this.packageId = options?.packageId;
		this.version = options?.version;
		this.data = { _tag: "ToolchainInstallError", phase, toolId, packageId: options?.packageId, version: options?.version };
	}
}

/** 与 ledger.ts / kernel `yomaConfigDir()` 同一个目录 —— 就地重算,不 import(依赖方向)。 */
function defaultConfigDir(): string {
	return path.join(homedir(), ".yoma");
}

export function managedRoot(configDir: string = defaultConfigDir()): string {
	return path.join(configDir, MANAGED_DIRNAME);
}

export function managedPackageDir(packageId: string, version: string, configDir?: string): string {
	return path.join(managedRoot(configDir), packageId, version);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Windows 上刚被 spawn 过 / 被杀毒软件扫着的文件会 EBUSY,一律带重试。 */
function rmrf(target: string): void {
	rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function readMarker(dir: string): ManagedInstall | undefined {
	let raw: string;
	try {
		raw = readFileSync(path.join(dir, MANAGED_MARKER), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) return undefined;
	if (typeof parsed.packageId !== "string" || typeof parsed.version !== "string") return undefined;
	if (typeof parsed.archiveSha256 !== "string") return undefined;
	const provides = Array.isArray(parsed.provides) ? parsed.provides.filter((p): p is string => typeof p === "string") : [];
	const binDirRel = typeof parsed.binDir === "string" ? parsed.binDir : "bin";
	// 标记里记的是相对 binDir(包目录可能被整体搬过);绝对路径从当前位置重算。
	const binDir = path.isAbsolute(binDirRel) ? binDirRel : path.join(dir, binDirRel);
	return {
		packageId: parsed.packageId,
		version: parsed.version,
		dir,
		binDir,
		provides,
		archiveSha256: parsed.archiveSha256,
		installedAt: typeof parsed.installedAt === "number" ? parsed.installedAt : 0,
	};
}

function compareVersionDesc(a: string, b: string): number {
	const na = a.split(/[^0-9]+/).filter(Boolean).map(Number);
	const nb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
	for (let i = 0; i < Math.max(na.length, nb.length); i++) {
		const x = na[i] ?? 0;
		const y = nb[i] ?? 0;
		if (x !== y) return y - x;
	}
	return b.localeCompare(a);
}

/**
 * 扫 `<configDir>/toolchains/<包>/<版本>/` 里带完成标记、且 binDir 还在的安装。同步、容错:
 * 目录不存在 / 标记坏了 / binDir 没了都当没有。每个包按版本新到旧排。
 */
export function listManagedInstalls(configDir?: string): ManagedInstall[] {
	const root = managedRoot(configDir);
	let packages: string[];
	try {
		packages = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const out: ManagedInstall[] = [];
	for (const packageId of packages) {
		let versions: string[];
		try {
			versions = readdirSync(path.join(root, packageId), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		const installs: ManagedInstall[] = [];
		for (const version of versions) {
			const marker = readMarker(path.join(root, packageId, version));
			if (!marker) continue;
			try {
				if (!statSync(marker.binDir).isDirectory()) continue;
			} catch {
				continue;
			}
			installs.push(marker);
		}
		installs.sort((a, b) => compareVersionDesc(a.version, b.version));
		out.push(...installs);
	}
	return out;
}

/**
 * 应该前置进 agent 环境的"机器级"目录:Yoma 装的(managed)在前,用户在设置页手指的
 * (账本 by:"user")在后,路径还存在的才算,去重保序。账本 by:"auto" 的**不**前置 ——
 * 它们本来就是在 PATH / 已知位置探到的,再前置只会遮蔽用户自己 PATH 上的同名工具
 * (比如 venv 里的 python)。
 */
export function machinePathDirs(opts: { configDir?: string; ledger?: Ledger }): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	const push = (dir: string) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		dirs.push(dir);
	};
	for (const install of listManagedInstalls(opts.configDir)) push(install.binDir);
	for (const entry of Object.values(opts.ledger?.entries ?? {})) {
		if (entry.by !== "user") continue;
		for (const binPath of Object.values(entry.bin)) {
			if (!existsSync(binPath)) continue;
			let dir: string;
			try {
				dir = statSync(binPath).isDirectory() ? binPath : path.dirname(binPath);
			} catch {
				continue;
			}
			push(dir);
		}
	}
	return dirs;
}

/**
 * 前置目录进 PATH:不替换、去重、写回原来的键(Windows 上可能叫 "Path",另开一个 "PATH"
 * 会得到两个键,子进程认哪个是未定义行为)。dirs 为空或全都已在时原样返回同一个对象。
 */
export function withMachineOnPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
	if (dirs.length === 0) return env;
	const pathKey = findEnvKey(env, "PATH") ?? "PATH";
	const current = env[pathKey] ?? "";
	const existing = new Set(current.split(path.delimiter).filter(Boolean));
	const fresh: string[] = [];
	for (const dir of dirs) {
		if (existing.has(dir) || fresh.includes(dir)) continue;
		fresh.push(dir);
	}
	if (fresh.length === 0) return env;
	const out: NodeJS.ProcessEnv = { ...env };
	out[pathKey] = [...fresh, current].filter(Boolean).join(path.delimiter);
	return out;
}

/** 让 `mkdirSync -p` 的调用点读起来是一句话。 */
export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/** 测试与 UI 用:这个 id 在这台机器上能不能装(有包、有本宿主的产物)。 */
export function canInstall(toolId: string, host: HostKey | undefined, catalog: readonly CatalogPackage[] = TOOLCHAIN_CATALOG): boolean {
	const pkg = catalog.find((entry) => entry.provides.includes(toolId));
	return pkg !== undefined && host !== undefined && pkg.artifacts[host] !== undefined;
}

/**
 * 声明的可执行名里,至少一个在 dir 里解析得到(PATHEXT 展开与 resolve.ts 同口径)。
 * 注入的 env 常常只有 `PATH: ""`(测试隔离),Windows 上没有 PATHEXT 就找不到 `.exe/.bat` ——
 * 后缀表从真实进程环境兜底,这不是"读开发机的 PATH",只是 Windows 的可执行后缀约定。
 */
function anyBinResolves(dir: string, names: string[], env: NodeJS.ProcessEnv): boolean {
	if (names.length === 0) return false;
	const synthetic = withPath(env, [dir]);
	if (process.platform === "win32" && findEnvKey(synthetic, "PATHEXT") === undefined) {
		synthetic.PATHEXT = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
	}
	return names.some((name) => findOnPath(name, synthetic) !== undefined);
}

/** 包 provides 的每个工具按预设声明的 bin,兜底用包自己的 bins。 */
function declaredBins(pkg: CatalogPackage, toolId: string): string[] {
	return findFamilyTool(toolId)?.bin ?? pkg.bins;
}

// ─── 锁:同一个包同时只装一次 ────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockPath(packageId: string, configDir?: string): string {
	return path.join(managedRoot(configDir), `.lock-${packageId}`);
}

/** 本进程内正在装的包(pid 锁挡的是别的进程;同进程里两次并发调用 pid 相同,得另记一笔)。 */
const inflightPackages = new Set<string>();

/** 拿不到就抛(message 含 "already");拿到返回释放函数。死进程 / 超龄的锁直接接管。 */
function acquireLock(toolId: string, packageId: string, configDir?: string): () => void {
	const file = lockPath(packageId, configDir);
	const inflightKey = `${path.resolve(managedRoot(configDir))}::${packageId}`;
	if (inflightPackages.has(inflightKey)) {
		throw new ToolchainInstallError("resolve", toolId, `${packageId} is already being installed — wait for it to finish or cancel it first`, {
			packageId,
		});
	}
	ensureDir(path.dirname(file));
	const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, payload, { flag: "wx" });
			inflightPackages.add(inflightKey);
			return () => {
				inflightPackages.delete(inflightKey);
				try {
					if (readFileSync(file, "utf8") === payload) rmSync(file, { force: true });
				} catch {
					// 锁文件已经不在了(或读不了)—— 释放的目的已经达到。
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder: { pid?: number; at?: number } = {};
		try {
			holder = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; at?: number };
		} catch {
			// 读不出来当作陈旧锁。
		}
		const age = typeof holder.at === "number" ? Date.now() - holder.at : Number.POSITIVE_INFINITY;
		const held =
			typeof holder.pid === "number" && holder.pid !== process.pid && pidAlive(holder.pid) && age < LOCK_STALE_MS;
		if (held) {
			throw new ToolchainInstallError(
				"resolve",
				toolId,
				`${packageId} is already being installed by another Yoma process (pid ${holder.pid}) — wait for it to finish; if nothing is running, delete ${file}`,
				{ packageId },
			);
		}
		rmSync(file, { force: true });
	}
	throw new ToolchainInstallError("resolve", toolId, `${packageId} is already being installed — could not take the install lock ${file}`, {
		packageId,
	});
}

// ─── 下载 ────────────────────────────────────────────────────────────────────

function joinUrl(base: string, name: string): string {
	return `${base.replace(/\/+$/, "")}/${name}`;
}

function artifactBasename(artifact: CatalogArtifact): string {
	try {
		return path.posix.basename(new URL(artifact.url).pathname);
	} catch {
		return path.posix.basename(artifact.url);
	}
}

function downloadCandidates(artifact: CatalogArtifact, opts: InstallToolchainOptions, env: NodeJS.ProcessEnv): string[] {
	const name = artifactBasename(artifact);
	const bases = [opts.mirror, env[TOOLCHAIN_MIRROR_ENV]].map((v) => v?.trim()).filter((v): v is string => Boolean(v));
	const out: string[] = [];
	for (const url of [...bases.map((base) => joinUrl(base, name)), ...(artifact.mirrors ?? []), artifact.url]) {
		if (!out.includes(url)) out.push(url);
	}
	return out;
}

function sha256File(file: string): string {
	const hash = createHash("sha256");
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(1024 * 1024);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			hash.update(buf.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

interface DownloadResult {
	sha256: string;
	bytes: number;
}

/** 流式写 `.part`、边写边算 sha256;任何失败都删掉 `.part` 再抛。 */
async function downloadTo(
	url: string,
	dest: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
	onBytes: (bytes: number) => void,
): Promise<DownloadResult> {
	const res = await fetchImpl(url, { signal, redirect: "follow" });
	if (!res.ok) {
		// 不读的 body 会攥着 undici 的连接直到 GC —— 镜像逐个 404 时会攒出好几条。
		await res.body?.cancel().catch(() => {});
		throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
	}
	ensureDir(path.dirname(dest));
	const tmp = `${dest}.part`;
	const hash = createHash("sha256");
	let bytes = 0;
	const sink = createWriteStream(tmp);
	try {
		if (res.body) {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				if (signal?.aborted) throw new Error("aborted");
				const buf = Buffer.from(chunk);
				hash.update(buf);
				bytes += buf.byteLength;
				onBytes(bytes);
				if (!sink.write(buf)) await once(sink, "drain");
			}
		} else {
			const buf = Buffer.from(await res.arrayBuffer());
			hash.update(buf);
			bytes = buf.byteLength;
			onBytes(bytes);
			sink.write(buf);
		}
		await new Promise<void>((resolve, reject) => {
			sink.once("error", reject);
			sink.end(resolve);
		});
	} catch (error) {
		sink.destroy();
		await res.body?.cancel().catch(() => {});
		rmSync(tmp, { force: true, maxRetries: 3, retryDelay: 100 });
		throw error;
	}
	renameSync(tmp, dest);
	return { sha256: hash.digest("hex"), bytes };
}

// ─── 解压 ────────────────────────────────────────────────────────────────────

/** 目标必须落在 root 里面(zip-slip / tar 里的 `..`)。 */
function insideDir(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

async function extractZip(archive: string, dest: string, signal: AbortSignal | undefined): Promise<void> {
	const zip = await import("@zip.js/zip.js");
	zip.configure({ useWebWorkers: false });

	/**
	 * zip.js 的 Reader:按需 pread,不把几百 MB 的包整个读进内存。必须继承 zip.Reader ——
	 * 它的 `readable` getter(把 readUint8Array 包成 ReadableStream)是 getData 的依赖,
	 * 一个只实现 readUint8Array 的鸭子对象会在 getData 里炸(实测:Object.assign(undefined))。
	 */
	class FileChunkReader extends zip.Reader<string> {
		private fd = -1;
		override async init(): Promise<void> {
			await super.init?.();
			this.fd = openSync(archive, "r");
			this.size = statSync(archive).size;
		}
		override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
			const buf = Buffer.alloc(length);
			let done = 0;
			while (done < length) {
				const n = readSync(this.fd, buf, done, length - done, index + done);
				if (n <= 0) break;
				done += n;
			}
			return new Uint8Array(buf.buffer, buf.byteOffset, done);
		}
		close(): void {
			if (this.fd >= 0) closeSync(this.fd);
			this.fd = -1;
		}
	}

	const reader = new FileChunkReader(archive);
	const zipReader = new zip.ZipReader(reader, { useWebWorkers: false });
	try {
		const entries = await zipReader.getEntries();
		// 先整体验一遍路径再动手:一个坏条目也不该在磁盘上留下半个树。
		for (const entry of entries) {
			const target = path.resolve(dest, entry.filename.replace(/\\/g, "/"));
			if (!insideDir(dest, target)) {
				throw new Error(`archive entry escapes the target directory (zip-slip): ${entry.filename}`);
			}
		}
		for (const entry of entries) {
			if (signal?.aborted) throw new Error("aborted");
			const target = path.resolve(dest, entry.filename.replace(/\\/g, "/"));
			if (entry.directory || entry.filename.endsWith("/")) {
				ensureDir(target);
				continue;
			}
			ensureDir(path.dirname(target));
			// "version made by" 高字节 3 = Unix,external attribute 高 16 位是 st_mode。
			const madeByUnix = (entry.versionMadeBy >> 8) === 3;
			const mode = madeByUnix ? (entry.externalFileAttributes >>> 16) & 0o177777 : 0;
			if (madeByUnix && (mode & S_IFMT) === S_IFLNK && process.platform !== "win32") {
				// 符号链接:内容就是链接目标。目录内相对链接才认,其余当普通文件写出来。
				const linkTarget = new TextDecoder().decode(await entry.getData!(new zip.Uint8ArrayWriter()));
				const resolved = path.resolve(path.dirname(target), linkTarget);
				if (!path.isAbsolute(linkTarget) && insideDir(dest, resolved)) {
					rmSync(target, { force: true });
					const { symlinkSync } = await import("node:fs");
					symlinkSync(linkTarget, target);
					continue;
				}
			}
			const sink = createWriteStream(target);
			try {
				await entry.getData!(Writable.toWeb(sink) as unknown as WritableStream, { useWebWorkers: false });
			} catch (error) {
				sink.destroy();
				throw error;
			}
			if (process.platform !== "win32" && mode & 0o111) chmodSync(target, mode & 0o7777);
		}
	} finally {
		await zipReader.close().catch(() => {});
		reader.close();
	}
}

function defaultTarBinary(): string {
	if (process.platform !== "win32") return "tar";
	return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

async function extractTar(
	archive: string,
	dest: string,
	tarBinary: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(tarBinary, ["-xf", archive, "-C", dest], {
			env: { ...env },
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`could not run ${tarBinary}: ${error.message}`));
		});
		child.once("exit", (code, sig) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) return reject(new Error("aborted"));
			if (code === 0) return resolve();
			const tail = stderr.trim().split("\n").slice(-5).join("\n");
			reject(new Error(`${tarBinary} exited with ${code ?? sig}${tail ? `: ${tail}` : ""}`));
		});
	});
}

/** 压缩包里"成为包目录"的那一层:catalog 的 root,找不到时认唯一的顶层目录。 */
function locateRoot(extracting: string, root: string | undefined): string {
	if (root) {
		const candidate = path.join(extracting, root);
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
	}
	const entries = readdirSync(extracting, { withFileTypes: true }).filter((e) => e.name !== "__MACOSX");
	if (entries.length === 1 && entries[0].isDirectory()) return path.join(extracting, entries[0].name);
	if (root) throw new Error(`archive does not contain the expected directory "${root}"`);
	return extracting;
}

function markExecutables(binDir: string): void {
	if (process.platform === "win32") return;
	let names: string[];
	try {
		names = readdirSync(binDir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(binDir, name);
		try {
			const st = statSync(file);
			if (!st.isFile()) continue;
			if ((st.mode & 0o111) === 0) chmodSync(file, (st.mode & 0o7777) | 0o755);
		} catch {
			// 单个文件改不了权限不拦整次安装 —— 记账时 probeVersion 会说明它能不能跑。
		}
	}
}

/**
 * 把解好的树换到包目录:旧的先挪到一边,新的 rename 进来,最后删旧的。任何一步失败,
 * 机器上要么还是旧的、要么已经是新的,不会两个都没有。
 */
function swapIntoPlace(source: string, pkgDir: string): void {
	ensureDir(path.dirname(pkgDir));
	const old = existsSync(pkgDir) ? `${pkgDir}.old-${process.pid}-${Date.now()}` : undefined;
	if (old) renameSync(pkgDir, old);
	try {
		renameSync(source, pkgDir);
	} catch (error) {
		if (old) {
			try {
				renameSync(old, pkgDir);
			} catch {
				// 旧的挪不回去也只能如实报下面那个错;此时旧树还在 old 位置,没有丢。
			}
		}
		throw error;
	}
	if (old) {
		try {
			rmrf(old);
		} catch {
			// 删不掉旧树(被占着)不算安装失败:新包已经就位,残留目录下次安装再清。
		}
	}
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 按 catalog 装一个工具:见文件头。每个阶段经 onProgress 报一次(download 阶段按字节
 * 反复报);失败抛 ToolchainInstallError(phase 说明死在哪一步);signal 中止抛 phase
 * "cancelled" 并清掉半成品。
 */
export async function installToolchain(opts: InstallToolchainOptions): Promise<InstalledToolchain> {
	const toolId = opts.toolId;
	const env = opts.env ?? process.env;
	const catalog = opts.catalog ?? TOOLCHAIN_CATALOG;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const signal = opts.signal;

	// ── resolve ──
	const host = opts.host ?? hostKey();
	const pkg = catalogPackageFor(toolId, catalog);
	if (!pkg) {
		throw new ToolchainInstallError("resolve", toolId, `Yoma has no automatic installer for "${toolId}" — install it by hand and record its path with toolchain set`);
	}
	const artifact = catalogArtifact(pkg, host);
	if (!artifact) {
		throw new ToolchainInstallError(
			"resolve",
			toolId,
			`"${toolId}" (${pkg.title} ${pkg.version}) has no automatic installer for this machine (${host ?? `${process.platform}-${process.arch}`}) — install it by hand and record its path with toolchain set`,
			{ packageId: pkg.id, version: pkg.version },
		);
	}

	const report = (phase: InstallPhase, extra: Partial<InstallProgress> = {}) =>
		opts.onProgress?.({ toolId, packageId: pkg.id, version: pkg.version, phase, ...extra });

	const pkgDir = managedPackageDir(pkg.id, pkg.version, opts.configDir);
	const binDirRel = artifact.binDir ?? "bin";
	const binDir = binDirRel === "" ? pkgDir : path.join(pkgDir, binDirRel);
	const extracting = `${pkgDir}.extracting`;
	const archiveName = artifactBasename(artifact);
	const archiveFile = path.join(managedRoot(opts.configDir), "downloads", archiveName);
	// 复用 / 解压成功的判据都是"包里声明的可执行文件真的解析得到",不是"目录在"。
	const expectedBins = [...new Set(pkg.provides.flatMap((id) => declaredBins(pkg, id)))];

	const cancelled = () => Boolean(signal?.aborted);
	const fail = (phase: InstallPhase, message: string, cause?: unknown): ToolchainInstallError =>
		cancelled()
			? new ToolchainInstallError("cancelled", toolId, `installation of ${pkg.title} was cancelled`, {
					cause,
					packageId: pkg.id,
					version: pkg.version,
				})
			: new ToolchainInstallError(phase, toolId, message, { cause, packageId: pkg.id, version: pkg.version });

	report("resolve");
	if (cancelled()) throw fail("resolve", "cancelled");

	const release = acquireLock(toolId, pkg.id, opts.configDir);
	try {
		// ── reuse ──
		const existing = readMarker(pkgDir);
		let reused = false;
		if (existing && existing.archiveSha256 === artifact.sha256 && anyBinResolves(binDir, expectedBins, env)) {
			reused = true;
		} else {
			// ── download ──
			let haveArchive = false;
			if (existsSync(archiveFile)) {
				// 上次下完但没装完(解压失败 / 进程被杀):校验和对得上就直接复用,不重下几百 MB。
				try {
					haveArchive = sha256File(archiveFile) === artifact.sha256;
				} catch {
					haveArchive = false;
				}
				if (!haveArchive) rmSync(archiveFile, { force: true });
			}
			let digest = artifact.sha256;
			if (!haveArchive) {
				report("download", { bytes: 0, total: artifact.bytes });
				const attempts: string[] = [];
				let result: DownloadResult | undefined;
				for (const url of downloadCandidates(artifact, opts, env)) {
					if (cancelled()) throw fail("download", "cancelled");
					try {
						result = await downloadTo(url, archiveFile, fetchImpl, signal, (bytes) =>
							report("download", { bytes, total: artifact.bytes }),
						);
						break;
					} catch (error) {
						if (cancelled()) throw fail("download", "cancelled", error);
						attempts.push(`${url}: ${(error as Error)?.message ?? String(error)}`);
					}
				}
				if (!result) {
					throw fail("download", `could not download ${pkg.title} ${pkg.version} — tried:\n${attempts.map((a) => `  - ${a}`).join("\n")}`);
				}
				digest = result.sha256;
			}

			// ── verify ──
			report("verify");
			if (digest !== artifact.sha256) {
				rmSync(archiveFile, { force: true });
				throw fail(
					"verify",
					`sha256 mismatch for ${archiveName}: expected ${artifact.sha256.slice(0, 16)}…, got ${digest.slice(0, 16)}… — the download is corrupt or the source was tampered with; nothing was installed`,
				);
			}

			// ── extract ──
			report("extract");
			try {
				rmrf(extracting);
				ensureDir(extracting);
				if (artifact.archive === "zip") {
					await extractZip(archiveFile, extracting, signal);
				} else {
					await extractTar(archiveFile, extracting, opts.tarBinary ?? defaultTarBinary(), env, signal);
				}
				const rootDir = locateRoot(extracting, artifact.root);
				const stagedBin = binDirRel === "" ? rootDir : path.join(rootDir, binDirRel);
				if (!existsSync(stagedBin)) {
					throw new Error(`expected "${binDirRel || "."}" inside the extracted ${pkg.title} archive, found none`);
				}
				markExecutables(stagedBin);
				if (!anyBinResolves(stagedBin, expectedBins, env)) {
					throw new Error(
						`none of the expected executables (${expectedBins.join(", ")}) are in "${binDirRel || "."}" of the extracted ${pkg.title} archive — the catalog's layout for this package is wrong`,
					);
				}
				if (rootDir === extracting) {
					swapIntoPlace(extracting, pkgDir);
				} else {
					swapIntoPlace(rootDir, pkgDir);
					rmrf(extracting);
				}
			} catch (error) {
				try {
					rmrf(extracting);
				} catch {
					// 清不掉半成品不掩盖真正的失败原因;下次安装开头会再清一次。
				}
				throw fail("extract", `could not extract ${archiveName}: ${(error as Error)?.message ?? String(error)}`, error);
			}
			const marker = {
				packageId: pkg.id,
				version: pkg.version,
				provides: pkg.provides,
				binDir: binDirRel,
				archiveSha256: artifact.sha256,
				installedAt: Date.now(),
			};
			writeFileSync(path.join(pkgDir, MANAGED_MARKER), `${JSON.stringify(marker, null, "\t")}\n`, "utf8");
			rmSync(archiveFile, { force: true, maxRetries: 3, retryDelay: 100 });
		}

		// ── record ──
		report("record");
		const recorded: InstalledToolchain["recorded"] = [];
		for (const id of pkg.provides) {
			if (cancelled()) throw fail("record", "cancelled");
			const bins = declaredBins(pkg, id);
			// 机器装出来的包,声明的可执行名一个都解析不到就是包坏了 —— 不能像用户手填那样
			// "原样记录目录":记进去的目录会让核账永远报 ok(见文件头)。
			if (!anyBinResolves(binDir, bins, env)) {
				throw fail("record", `installed ${pkg.title} but none of ${bins.join(", ")} can be found in ${binDir} — the install is broken; delete ${pkgDir} and try again`);
			}
			try {
				const entry = await recordToolchainPath({ id, path: binDir, configDir: opts.configDir, bins, probe: "version" });
				recorded.push({ id: entry.id, binPath: entry.binPath, version: entry.version });
			} catch (error) {
				throw fail("record", `installed ${pkg.title} but could not record ${id}: ${(error as Error)?.message ?? String(error)}`, error);
			}
		}

		report("done");
		return { packageId: pkg.id, version: pkg.version, dir: pkgDir, binDir, reused, recorded };
	} catch (error) {
		if (error instanceof ToolchainInstallError) {
			report(error.phase === "cancelled" ? "cancelled" : "error", { message: error.message });
			throw error;
		}
		const wrapped = fail("error", (error as Error)?.message ?? String(error), error);
		report(wrapped.phase === "cancelled" ? "cancelled" : "error", { message: wrapped.message });
		throw wrapped;
	} finally {
		release();
	}
}
