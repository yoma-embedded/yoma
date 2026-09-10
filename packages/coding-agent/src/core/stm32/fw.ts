/**
 * STM32 HAL / CMSIS 固件组件的运行时下载 —— `stm32config generate` 的前置条件。
 *
 * 为什么不进安装包:26 族 HAL 加起来 1.1 GB(压缩 174 MB),只有 `stm32kernel generate`
 * 用得到,而且一个人通常只碰一两个族。engines/build.ts 文件头把这条定成了产品决定,
 * README 从前的答案是"跑仓库里的 tools/fetch-fw.ps1" —— 装机用户没有仓库、没有 git,
 * 那条路对他们等于"生成驱动不可用"(v0.1.0~v0.1.4 都是这样)。
 *
 * 这里把同一件事做成内核动作:按族从 ST 官方 GitHub 组件仓取钉死 tag 的 zip
 * (archive/refs/tags/<tag>.zip:不需要 git,不吃 API 配额),只保留 Inc/ Src/ Include/
 * Source/Templates 与许可证,落到 `<configDir>/stm32/fw/<族>/{HAL_Driver,CMSIS_Device}` +
 * 全族共享的 `CMSIS_Core/Include` —— 与 fetch-fw.ps1 相同的布局,也就是 stm32kernel 的
 * `FwPaths::locate` 认的那一个。落在 configDir 而不是安装目录:升级换文件时不会被抹掉。
 *
 * 纪律抄 toolchain/install.ts:下载走 downloadTo(.part 边写边算 sha)、zip 走 extractZip
 * (挡 zip-slip)、组装到 `<族>.extracting` 再整体 rename —— 半个树不会顶着最终名字出现。
 * GitHub 的 archive zip 没有厂商 sha256(打包字节会随 git 版本漂),所以钉的是 tag 而不是
 * 校验和;验收看落地的树:HAL_Driver/Src 必须有 `<prefix>_hal.c`,CMSIS_Device 必须有
 * Include/ 与 Source/Templates/gcc/ 的启动文件 —— 这些正是 generate 会读的东西。
 *
 * 版本钉死(2026-09-10 按各仓最新 tag 抄的,`git ls-remote --tags`),升版本是一次显式的
 * 表改动。STM32MP1 不在表里:ST 从没把它的 HAL 拆成组件仓,只有整包 STM32CubeMP1(几 GB),
 * 走不了 zip 这条路 —— 这一族只能像仓库开发者那样手动放置。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { TOOLCHAIN_MIRROR_ENV } from "../toolchain/catalog.ts";
import { downloadTo, ensureDir, extractZip } from "../toolchain/install.ts";

export interface Stm32FwComponent {
	/** github.com/STMicroelectronics 下的仓库名。 */
	repo: string;
	/** 钉死的 tag,原样(带前导 v)。 */
	tag: string;
}

export interface Stm32FwCatalogEntry {
	/** 族名,大写,与 irpack 文件名 / stm32Families() 同一套拼法(STM32F1、STM32WB0…)。 */
	family: string;
	hal: Stm32FwComponent;
	device: Stm32FwComponent;
}

export const STM32_FW_GITHUB = "https://github.com/STMicroelectronics";

/** 全族共用一份 CMSIS core:core_cm0.h..core_cm55.h 都在同一个 Include/ 里,26 份就是 26 倍的 2.7 MB。 */
export const STM32_CMSIS_CORE: Stm32FwComponent = { repo: "cmsis-core", tag: "v5.9.0_20250520" };

const entry = (family: string, hal: string, halTag: string, device: string, deviceTag: string): Stm32FwCatalogEntry => ({
	family,
	hal: { repo: hal, tag: halTag },
	device: { repo: device, tag: deviceTag },
});

/**
 * 仓库名不是机械规则:后缀按 HAL 头文件前缀拼(stm32wb0x、stm32wl3x 只有一个 x),
 * 所以逐族写死,不在运行期猜。
 */
export const STM32_FW_CATALOG: readonly Stm32FwCatalogEntry[] = [
	entry("STM32C0", "stm32c0xx-hal-driver", "v1.4.1", "cmsis-device-c0", "v1.4.1"),
	entry("STM32F0", "stm32f0xx-hal-driver", "v1.7.8", "cmsis-device-f0", "v2.3.7"),
	entry("STM32F1", "stm32f1xx-hal-driver", "v1.1.10", "cmsis-device-f1", "v4.3.5"),
	entry("STM32F2", "stm32f2xx-hal-driver", "v1.2.9", "cmsis-device-f2", "v2.2.6"),
	entry("STM32F3", "stm32f3xx-hal-driver", "v1.5.8", "cmsis-device-f3", "v2.3.8"),
	entry("STM32F4", "stm32f4xx-hal-driver", "v1.8.5", "cmsis-device-f4", "v2.6.11"),
	entry("STM32F7", "stm32f7xx-hal-driver", "v1.3.3", "cmsis-device-f7", "v1.2.10"),
	entry("STM32G0", "stm32g0xx-hal-driver", "v1.4.7", "cmsis-device-g0", "v1.4.5"),
	entry("STM32G4", "stm32g4xx-hal-driver", "v1.2.7", "cmsis-device-g4", "v1.2.6"),
	entry("STM32H5", "stm32h5xx-hal-driver", "v1.7.0", "cmsis-device-h5", "v1.7.0"),
	entry("STM32H7", "stm32h7xx-hal-driver", "v1.11.6", "cmsis-device-h7", "v1.10.7"),
	entry("STM32L0", "stm32l0xx-hal-driver", "v1.10.7", "cmsis-device-l0", "v1.9.4"),
	entry("STM32L1", "stm32l1xx-hal-driver", "v1.4.6", "cmsis-device-l1", "v2.3.4"),
	entry("STM32L4", "stm32l4xx-hal-driver", "v1.13.6", "cmsis-device-l4", "v1.7.5"),
	entry("STM32L5", "stm32l5xx-hal-driver", "v1.0.7", "cmsis-device-l5", "v1.0.7"),
	entry("STM32MP2", "stm32mp2xx-hal-driver", "v1.3.1", "cmsis-device-mp2", "v1.3.1"),
	entry("STM32N6", "stm32n6xx-hal-driver", "v1.4.0", "cmsis-device-n6", "v1.4.0"),
	entry("STM32U0", "stm32u0xx-hal-driver", "v1.3.0", "cmsis-device-u0", "v1.3.0"),
	entry("STM32U3", "stm32u3xx-hal-driver", "v1.4.0", "cmsis-device-u3", "v1.4.0"),
	entry("STM32U5", "stm32u5xx-hal-driver", "v1.6.3", "cmsis-device-u5", "v1.4.3"),
	entry("STM32WB", "stm32wbxx-hal-driver", "v1.14.7", "cmsis-device-wb", "v1.12.3"),
	entry("STM32WB0", "stm32wb0x-hal-driver", "v1.5.0", "cmsis-device-wb0", "v1.4.0"),
	entry("STM32WBA", "stm32wbaxx-hal-driver", "v1.10.0", "cmsis-device-wba", "v1.10.0"),
	entry("STM32WL", "stm32wlxx-hal-driver", "v1.6.0", "cmsis-device-wl", "v1.4.0"),
	entry("STM32WL3", "stm32wl3x-hal-driver", "v1.5.0", "cmsis-device-wl3", "v1.5.0"),
];

/** 生成的工程真正编译到的东西(与 fetch-fw.ps1 同一份名单):厂商手册、图片、示例工程都不要。 */
const KEEP_EXTENSIONS = new Set([".c", ".h", ".s", ".S", ".ld", ".txt", ".md"]);
const LICENSE_FILE = /^(LICENSE|License|COPYING)(\.(txt|md))?$/;

/** 族目录里的完成标记:记着落地的是哪几个 tag,升表之后才知道该不该重下。 */
export const STM32_FW_MARKER = ".yoma-fw.json";

export type Stm32FwPhase = "unsupported" | "download" | "extract" | "land" | "verify" | "cancelled";

export class Stm32FwError extends Error {
	constructor(
		readonly phase: Stm32FwPhase,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "Stm32FwError";
	}
}

export interface Stm32FwProgress {
	family: string;
	/** 正在处理的仓库(hal / device / core)。 */
	component: string;
	phase: "download" | "extract" | "land" | "done";
	/** download 阶段:已收字节。GitHub 的 archive 不给总长度,没有 total。 */
	bytes?: number;
}

export interface LandStm32FwOptions {
	family: string;
	/** 落点,默认 `<configDir>/stm32/fw`。 */
	fwRoot?: string;
	/** 默认 ~/.yoma。 */
	configDir?: string;
	/** 测试注入:替代 STM32_FW_CATALOG / STM32_CMSIS_CORE。 */
	catalog?: readonly Stm32FwCatalogEntry[];
	core?: Stm32FwComponent;
	/** 测试注入:替代官方 archive 地址。运行期只有 YOMA_TOOLCHAIN_MIRROR 这一个口子。 */
	archiveUrl?: (component: Stm32FwComponent) => string;
	/** 默认 process.env(读 YOMA_TOOLCHAIN_MIRROR)。 */
	env?: NodeJS.ProcessEnv;
	/** 测试注入:替代全局 fetch。 */
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (progress: Stm32FwProgress) => void;
	/** 已落地也重下(升表之外的强制刷新)。 */
	force?: boolean;
}

export interface LandedStm32Fw {
	family: string;
	/** `<fwRoot>/<族>`。 */
	dir: string;
	/** `<fwRoot>`:generate 的 --fw-dir 要传的是它,不是族目录。 */
	fwRoot: string;
	hal: Stm32FwComponent;
	device: Stm32FwComponent;
	core: Stm32FwComponent;
	/** 落地的文件数与字节数(只算这一次真正写下的;复用时为 0)。 */
	files: number;
	bytes: number;
	/** 同样的 tag 已经在了,一个字节都没下。 */
	reused: boolean;
}

interface FwMarker {
	family: string;
	hal: Stm32FwComponent & { sha256?: string };
	device: Stm32FwComponent & { sha256?: string };
	core: Stm32FwComponent;
	landedAt: number;
}

// ─── 只读查询 ────────────────────────────────────────────────────────────────

export function defaultStm32FwRoot(configDir: string = path.join(homedir(), ".yoma")): string {
	return path.join(configDir, "stm32", "fw");
}

export function stm32FwCatalogEntry(family: string, catalog: readonly Stm32FwCatalogEntry[] = STM32_FW_CATALOG): Stm32FwCatalogEntry | undefined {
	const key = family.trim().toUpperCase();
	return catalog.find((item) => item.family === key);
}

/** 这个根下这一族落地了没有 —— 判据是 generate 真正会读的 HAL_Driver/Src。 */
export function stm32FwLanded(fwRoot: string, family: string): boolean {
	return existsSync(path.join(fwRoot, family.trim().toUpperCase(), "HAL_Driver", "Src"));
}

/**
 * 零件号 → 族:最长前缀匹配。STM32WL33 要落到 STM32WL3 而不是 STM32WL,STM32WB55 落到
 * STM32WB 而不是 STM32WB0 —— 用"装了哪些 irpack"当候选表(stm32Families()),不写死。
 */
export function stm32FamilyOfPart(part: string, families: readonly string[]): string | undefined {
	const upper = part.trim().toUpperCase();
	let best: string | undefined;
	for (const family of families) {
		const candidate = family.trim().toUpperCase();
		if (upper.startsWith(candidate) && (best === undefined || candidate.length > best.length)) best = candidate;
	}
	return best;
}

/**
 * generate 的 --fw-dir:按顺序找第一个已经落了这一族的根(受管目录在前,随包 / 源码检出的
 * data/stm32/fw 在后);一个都没有就回第一个 —— 让 stm32kernel 的"找不到"指向受管目录,
 * 而不是安装目录里那个升级会被抹掉的地方。
 */
export function pickStm32FwDir(family: string | undefined, roots: readonly string[]): string {
	if (roots.length === 0) throw new Error("pickStm32FwDir: no firmware roots");
	if (family) {
		for (const root of roots) if (stm32FwLanded(root, family)) return root;
	}
	return roots[0]!;
}

export function readStm32FwMarker(familyDir: string): FwMarker | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path.join(familyDir, STM32_FW_MARKER), "utf8")) as Partial<FwMarker>;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (!parsed.hal?.tag || !parsed.device?.tag || typeof parsed.family !== "string") return undefined;
		return parsed as FwMarker;
	} catch {
		return undefined;
	}
}

// ─── 落地 ────────────────────────────────────────────────────────────────────

function rmrf(target: string): void {
	rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** 与 install.ts 的 swapIntoPlace 同一套:旧的先挪开,新的 rename 进来,任何一步失败都不会两边都没有。 */
function swapIntoPlace(source: string, dest: string): void {
	ensureDir(path.dirname(dest));
	const old = existsSync(dest) ? `${dest}.old-${process.pid}-${Date.now()}` : undefined;
	if (old) renameSync(dest, old);
	try {
		renameSync(source, dest);
	} catch (error) {
		if (old) {
			try {
				renameSync(old, dest);
			} catch {
				// 旧树还在 old 位置,没有丢;下面如实抛。
			}
		}
		throw error;
	}
	if (old) {
		try {
			rmrf(old);
		} catch {
			// 删不掉旧树(被占着)不算失败:新树已就位。
		}
	}
}

/** 递归复制,只留 KEEP_EXTENSIONS;源目录不存在时什么都不做(由调用方的验收去响)。 */
function copyFiltered(src: string, dest: string, tally: { files: number; bytes: number }): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(src, { withFileTypes: true });
	} catch {
		return;
	}
	for (const item of entries) {
		const from = path.join(src, item.name);
		const to = path.join(dest, item.name);
		if (item.isDirectory()) {
			copyFiltered(from, to, tally);
			continue;
		}
		if (!item.isFile() || !KEEP_EXTENSIONS.has(path.extname(item.name))) continue;
		ensureDir(dest);
		copyFileSync(from, to);
		tally.files += 1;
		tally.bytes += statSync(to).size;
	}
}

/** 组件根上的许可证文本:再分发要求带着它。 */
function copyLicenses(src: string, dest: string, tally: { files: number; bytes: number }): void {
	let names: string[];
	try {
		names = readdirSync(src);
	} catch {
		return;
	}
	for (const name of names) {
		if (!LICENSE_FILE.test(name)) continue;
		const from = path.join(src, name);
		if (!statSync(from).isFile()) continue;
		ensureDir(dest);
		copyFileSync(from, path.join(dest, name));
		tally.files += 1;
		tally.bytes += statSync(from).size;
	}
}

function firstDir(candidates: string[]): string | undefined {
	return candidates.find((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

/** GitHub 的 archive zip 只有一层顶级目录(<repo>-<tag 去 v>/);认"唯一顶级目录",名字不猜。 */
function archiveRoot(extracted: string): string {
	const entries = readdirSync(extracted, { withFileTypes: true }).filter((item) => item.name !== "__MACOSX");
	if (entries.length === 1 && entries[0]!.isDirectory()) return path.join(extracted, entries[0]!.name);
	return extracted;
}

function officialArchiveUrl(component: Stm32FwComponent): string {
	return `${STM32_FW_GITHUB}/${component.repo}/archive/refs/tags/${component.tag}.zip`;
}

function unsupportedMessage(family: string, fwRoot: string, catalog: readonly Stm32FwCatalogEntry[]): string {
	const supported = catalog.map((item) => item.family).join(", ");
	const mp1 =
		family === "STM32MP1"
			? " ST never split the MP1 HAL into component repositories (only the multi-GB STM32CubeMP1 package exists), so Yoma cannot fetch it automatically."
			: "";
	return (
		`Yoma has no firmware download for ${family}.${mp1} Supported families: ${supported}. ` +
		`For ${family}, place the components by hand: ${path.join(fwRoot, family, "HAL_Driver")}{Inc,Src} and ` +
		`${path.join(fwRoot, family, "CMSIS_Device")}{Include,Source/Templates} from the STM32Cube${family.slice(5)} package's Drivers/ directory ` +
		`(same layout as the repository's engines/stm32-config-kernel/tools/fetch-fw.ps1), plus ${path.join(fwRoot, "CMSIS_Core", "Include")}.`
	);
}

/**
 * 按表落一个族的固件。成功返回落地信息;失败抛 Stm32FwError(phase 说明死在哪一步),
 * 中止抛 phase "cancelled"。任何失败都不在 fwRoot 下留半成品(.work 与 .extracting 一并清掉)。
 */
export async function landStm32Firmware(opts: LandStm32FwOptions): Promise<LandedStm32Fw> {
	const catalog = opts.catalog ?? STM32_FW_CATALOG;
	const core = opts.core ?? STM32_CMSIS_CORE;
	const family = opts.family.trim().toUpperCase();
	const fwRoot = opts.fwRoot ?? defaultStm32FwRoot(opts.configDir);
	const spec = stm32FwCatalogEntry(family, catalog);
	if (!spec) throw new Stm32FwError("unsupported", unsupportedMessage(family, fwRoot, catalog));

	const env = opts.env ?? process.env;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const signal = opts.signal;
	const cancelled = () => Boolean(signal?.aborted);
	const report = (component: string, phase: Stm32FwProgress["phase"], bytes?: number) =>
		opts.onProgress?.({ family, component, phase, bytes });

	const familyDir = path.join(fwRoot, family);
	const coreDir = path.join(fwRoot, "CMSIS_Core");
	const marker = readStm32FwMarker(familyDir);
	const coreLanded = existsSync(path.join(coreDir, "Include"));
	const familyLanded =
		stm32FwLanded(fwRoot, family) && marker?.hal.tag === spec.hal.tag && marker?.device.tag === spec.device.tag;
	if (!opts.force && coreLanded && familyLanded) {
		report("hal", "done");
		return { family, dir: familyDir, fwRoot, hal: spec.hal, device: spec.device, core, files: 0, bytes: 0, reused: true };
	}

	ensureDir(fwRoot);
	// 下载与解压的中转目录,每次从零开始、结束时整个删掉 —— 不复用半个 zip。
	const work = path.join(fwRoot, `.work-${process.pid}-${Date.now()}`);
	const tally = { files: 0, bytes: 0 };
	const fail = (phase: Stm32FwPhase, message: string, cause?: unknown) =>
		cancelled() ? new Stm32FwError("cancelled", `firmware download for ${family} was cancelled`, { cause }) : new Stm32FwError(phase, message, { cause });

	/** 下载 + 解压一个组件,返回解开后的仓库根目录。 */
	const fetchComponent = async (label: string, component: Stm32FwComponent): Promise<{ dir: string; sha256: string }> => {
		if (cancelled()) throw fail("download", "cancelled");
		const archive = path.join(work, `${component.repo}-${component.tag}.zip`);
		const candidates: string[] = [];
		const mirror = env[TOOLCHAIN_MIRROR_ENV]?.trim();
		if (mirror) candidates.push(`${mirror.replace(/\/+$/, "")}/${component.repo}-${component.tag}.zip`);
		candidates.push(opts.archiveUrl ? opts.archiveUrl(component) : officialArchiveUrl(component));

		report(label, "download", 0);
		const attempts: string[] = [];
		let sha256: string | undefined;
		for (const url of candidates) {
			if (cancelled()) throw fail("download", "cancelled");
			try {
				const result = await downloadTo(url, archive, fetchImpl, signal, (bytes) => report(label, "download", bytes));
				sha256 = result.sha256;
				break;
			} catch (error) {
				if (cancelled()) throw fail("download", "cancelled", error);
				attempts.push(`${url}: ${(error as Error)?.message ?? String(error)}`);
			}
		}
		if (sha256 === undefined) {
			throw fail(
				"download",
				`could not download ${component.repo}@${component.tag} — tried:\n${attempts.map((line) => `  - ${line}`).join("\n")}`,
			);
		}

		report(label, "extract");
		const extracted = path.join(work, `${component.repo}-${component.tag}`);
		try {
			ensureDir(extracted);
			await extractZip(archive, extracted, signal);
		} catch (error) {
			throw fail("extract", `could not extract ${component.repo}@${component.tag}: ${(error as Error)?.message ?? String(error)}`, error);
		}
		rmSync(archive, { force: true, maxRetries: 3, retryDelay: 100 });
		return { dir: archiveRoot(extracted), sha256 };
	};

	const stagedCore = `${coreDir}.extracting`;
	const stagedFamily = `${familyDir}.extracting`;
	try {
		rmrf(work);
		ensureDir(work);

		// ── CMSIS core(共享,已在就不动)──
		if (opts.force || !coreLanded) {
			const fetched = await fetchComponent("core", core);
			report("core", "land");
			const includeSrc = firstDir([path.join(fetched.dir, "Include"), path.join(fetched.dir, "CMSIS", "Core", "Include")]);
			if (!includeSrc) {
				throw fail("verify", `${core.repo}@${core.tag} has no Include/ (nor CMSIS/Core/Include/) — the archive layout changed; the catalog needs updating`);
			}
			rmrf(stagedCore);
			copyFiltered(includeSrc, path.join(stagedCore, "Include"), tally);
			copyLicenses(fetched.dir, stagedCore, tally);
			writeFileSync(
				path.join(stagedCore, "SOURCE.txt"),
				`Component source: github.com/STMicroelectronics/${core.repo} @ ${core.tag} (sha256 of archive: ${fetched.sha256})\n`,
				"utf8",
			);
			swapIntoPlace(stagedCore, coreDir);
		}

		// ── 这一族的 HAL + CMSIS device ──
		const hal = await fetchComponent("hal", spec.hal);
		const device = await fetchComponent("device", spec.device);
		report("hal", "land");
		rmrf(stagedFamily);
		copyFiltered(path.join(hal.dir, "Inc"), path.join(stagedFamily, "HAL_Driver", "Inc"), tally);
		copyFiltered(path.join(hal.dir, "Src"), path.join(stagedFamily, "HAL_Driver", "Src"), tally);
		copyLicenses(hal.dir, path.join(stagedFamily, "HAL_Driver"), tally);
		copyFiltered(path.join(device.dir, "Include"), path.join(stagedFamily, "CMSIS_Device", "Include"), tally);
		copyFiltered(
			path.join(device.dir, "Source", "Templates"),
			path.join(stagedFamily, "CMSIS_Device", "Source", "Templates"),
			tally,
		);
		copyLicenses(device.dir, path.join(stagedFamily, "CMSIS_Device"), tally);

		// 验收:generate 真正会读的三样东西(FwPaths::locate + discover_device_prefix)。
		const halSrc = path.join(stagedFamily, "HAL_Driver", "Src");
		const halC = existsSync(halSrc) ? readdirSync(halSrc).filter((name) => /^stm32.*_hal\.c$/i.test(name)) : [];
		if (halC.length !== 1) {
			throw fail(
				"verify",
				`${spec.hal.repo}@${spec.hal.tag}: expected exactly one Src/stm32*_hal.c, found ${halC.length} — the archive layout changed; the catalog needs updating`,
			);
		}
		const devInc = path.join(stagedFamily, "CMSIS_Device", "Include");
		if (!existsSync(devInc) || readdirSync(devInc).length === 0) {
			throw fail("verify", `${spec.device.repo}@${spec.device.tag}: no Include/ headers in the archive — the catalog needs updating`);
		}
		const gcc = path.join(stagedFamily, "CMSIS_Device", "Source", "Templates", "gcc");
		if (!existsSync(gcc) || !readdirSync(gcc).some((name) => /^startup_.*\.s$/i.test(name))) {
			throw fail("verify", `${spec.device.repo}@${spec.device.tag}: no Source/Templates/gcc/startup_*.s in the archive — the catalog needs updating`);
		}

		writeFileSync(
			path.join(stagedFamily, "SOURCE.txt"),
			[
				"Component source: github.com/STMicroelectronics",
				`HAL_Driver:   ${spec.hal.repo} @ ${spec.hal.tag}`,
				`CMSIS_Device: ${spec.device.repo} @ ${spec.device.tag}`,
				`CMSIS_Core:   ../CMSIS_Core (${core.repo} @ ${core.tag})`,
				"",
			].join("\n"),
			"utf8",
		);
		const landed: FwMarker = {
			family,
			hal: { ...spec.hal, sha256: hal.sha256 },
			device: { ...spec.device, sha256: device.sha256 },
			core,
			landedAt: Date.now(),
		};
		writeFileSync(path.join(stagedFamily, STM32_FW_MARKER), `${JSON.stringify(landed, null, "\t")}\n`, "utf8");
		swapIntoPlace(stagedFamily, familyDir);
		report("hal", "done");
		return { family, dir: familyDir, fwRoot, hal: spec.hal, device: spec.device, core, files: tally.files, bytes: tally.bytes, reused: false };
	} catch (error) {
		for (const dir of [stagedCore, stagedFamily]) {
			try {
				rmrf(dir);
			} catch {
				// 清不掉半成品不掩盖真正的失败原因;下次落地开头会再清一次。
			}
		}
		if (error instanceof Stm32FwError) throw error;
		throw fail("land", `could not land ${family} firmware: ${(error as Error)?.message ?? String(error)}`, error);
	} finally {
		try {
			rmrf(work);
		} catch {
			// 同上。
		}
	}
}
