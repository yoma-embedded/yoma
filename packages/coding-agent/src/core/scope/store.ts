/**
 * 采集与截图的落盘布局。目录就是索引,没有别的状态文件(与 la 同一纪律)。
 *
 * <工程>/.yoma/scope/
 *   <id>/capture.json      元数据 + 每通道换算参数(读回样本只靠这个文件和 c<n>.i16)
 *   <id>/c<n>.i16          该通道的原始 code,小端 int16(WORD 模式原样)
 *   screens/<stamp>.png    截图
 * <工程>/.yoma/scope.json  本机的仪器地址(machine-local;与 toolchain.local.json 同类,不进版本库)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCOPE_DIR = path.join(".yoma", "scope");
export const SCOPE_SCREENS_DIR = "screens";
export const SCOPE_CONFIG_FILE = path.join(".yoma", "scope.json");
export const CAPTURE_JSON = "capture.json";

export interface StoredChannel {
	ch: number;
	label?: string;
	file: string;
	points: number;
	/** V/div,含探头 */
	vdiv: number;
	/** V,含探头 */
	offset: number;
	coupling?: string;
	probe: number;
	unit: string;
	bwlimit?: string;
	/** 换算:volts = code × (gain / codePerDiv) × probe − rawOffset × probe */
	gain: number;
	rawOffset: number;
	codePerDiv: number;
}

export interface ScopeCaptureMeta {
	id: string;
	createdAt: number;
	address: string;
	model?: string;
	serial?: string;
	/** 采集触发方式:current(读当前屏)/ single(武装等触发) */
	mode: string;
	timebase: { scale: number; delay: number };
	/** 采集采样率(Sa/s) */
	sampleRate: number;
	/** 交付点间隔(s)= 1/sampleRate × stride */
	interval: number;
	stride: number;
	/** 记录总长(采集点数) */
	recordPoints: number;
	mdepth?: string;
	trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string };
	channels: StoredChannel[];
}

export interface ScopeCaptureListing extends ScopeCaptureMeta {
	dir: string;
}

export async function writeCapture(dir: string, meta: ScopeCaptureMeta, samples: Map<number, Int16Array>): Promise<void> {
	await mkdir(dir, { recursive: true });
	for (const ch of meta.channels) {
		const codes = samples.get(ch.ch);
		if (!codes) continue;
		await writeFile(path.join(dir, ch.file), new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength));
	}
	await writeFile(path.join(dir, CAPTURE_JSON), `${JSON.stringify(meta, null, "\t")}\n`);
}

export async function readCaptureMeta(dir: string): Promise<ScopeCaptureMeta> {
	return JSON.parse(await readFile(path.join(dir, CAPTURE_JSON), "utf8")) as ScopeCaptureMeta;
}

export async function readChannelCodes(dir: string, ch: StoredChannel): Promise<Int16Array> {
	const bytes = await readFile(path.join(dir, ch.file));
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
}

/** 列 <工程>/.yoma/scope 下的采集,最新在前。 */
export async function listCaptures(projectDir: string): Promise<ScopeCaptureListing[]> {
	const root = path.join(projectDir, SCOPE_DIR);
	let ids: string[] = [];
	try {
		ids = await readdir(root);
	} catch {
		return [];
	}
	const out: ScopeCaptureListing[] = [];
	for (const id of ids) {
		if (id === SCOPE_SCREENS_DIR) continue;
		const dir = path.join(root, id);
		try {
			out.push({ ...(await readCaptureMeta(dir)), dir });
		} catch {
			// 不是采集目录
		}
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}

export interface ScopeConfig {
	address: string;
}

export async function readScopeConfig(projectDir: string): Promise<ScopeConfig | undefined> {
	try {
		const raw = JSON.parse(await readFile(path.join(projectDir, SCOPE_CONFIG_FILE), "utf8")) as Partial<ScopeConfig>;
		return typeof raw.address === "string" && raw.address ? { address: raw.address } : undefined;
	} catch {
		return undefined;
	}
}

export async function writeScopeConfig(projectDir: string, config: ScopeConfig): Promise<void> {
	await mkdir(path.join(projectDir, ".yoma"), { recursive: true });
	await writeFile(path.join(projectDir, SCOPE_CONFIG_FILE), `${JSON.stringify(config, null, "\t")}\n`);
}
