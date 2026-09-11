/**
 * .dsl(DSView 会话文件,也是 yoma-la capture 的输出)读取器 —— TS 侧的那一份。
 *
 * 引擎(C)已经有一份读取器给解码用;这一份服务的是**模型与前端**:边沿列表(时序统计、
 * 按列聚合渲染)、每通道活动概览、预览位图。两份读的是同一个格式:zip 里 `header` 是 ini,
 * 每个逻辑通道一组位面块 `L-<通道>/<块号>`,1 bit/采样、字节内 LSB 优先、每块 16,777,216 采样。
 *
 * 两个上游的坑(与引擎侧同样处理):被禁用的通道不写块,通道表按 header 的 probe<N> 建、
 * 块目录优先 `L-<N>/`,不存在时退回"第 i 个 probe ↔ 第 i 个存在的目录";v1 格式直接拒绝。
 */
import { readFile } from "node:fs/promises";
import { ZipFile } from "./zip.ts";

export const LEAF_BLOCK_SAMPLES = 1 << 24;

export interface DslChannel {
	/** header 里的 probe<N>,物理通道号 */
	index: number;
	name: string;
	/** 实际读的 L-<dir>;-1 = 没有块(该通道没数据) */
	dir: number;
}

export interface DslHeader {
	version: number;
	deviceMode: number;
	samplerate: number;
	totalSamples: number;
	totalBlocks: number;
	triggerPos: number | undefined;
	channels: DslChannel[];
}

/** "25 MHz" / "500 kHz" / "1000000" → Hz。与 libsigrok 的 sr_parse_sizestring 同语义。 */
export function parseSizeString(text: string): number | undefined {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmMgG])?\s*(?:Hz)?\s*$/i.exec(text);
	if (!m) return undefined;
	const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "g"] ?? 1;
	return Math.round(Number(m[1]) * mult);
}

export function parseDslHeader(text: string): DslHeader {
	let section = "";
	const kv: Record<string, Record<string, string>> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const sec = /^\[(.+)\]$/.exec(line);
		if (sec) { section = sec[1]!; kv[section] ??= {}; continue; }
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		(kv[section] ??= {})[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	const h = kv.header ?? {};
	const version = Number(kv.version?.version ?? "1");
	if (version < 2) throw new Error(`这是 v${version} 格式的 .dsl,DSView 自己也已不能回放它的逻辑数据;用较新的 DSView 重新保存一次`);
	const deviceMode = Number(h["device mode"] ?? "0");
	if (deviceMode !== 0) throw new Error(`device mode=${deviceMode} 不是逻辑分析仪数据(DSO/模拟暂不支持)`);
	const samplerate = parseSizeString(h.samplerate ?? "") ?? 0;
	const totalSamples = Number(h["total samples"] ?? "0");
	const channels: DslChannel[] = [];
	for (const [k, v] of Object.entries(h)) {
		const m = /^probe(\d+)$/.exec(k);
		if (m) channels.push({ index: Number(m[1]), name: v, dir: -1 });
	}
	channels.sort((a, b) => a.index - b.index);
	const totalBlocks = Number(h["total blocks"] ?? "0") || Math.ceil(totalSamples / LEAF_BLOCK_SAMPLES);
	const triggerPos = h["trigger pos"] !== undefined ? Number(h["trigger pos"]) : undefined;
	return { version, deviceMode, samplerate, totalSamples, totalBlocks, triggerPos, channels };
}

export class DslFile {
	readonly header: DslHeader;
	private readonly bits = new Map<number, Uint8Array>();

	private constructor(readonly path: string, private readonly zip: ZipFile) {
		this.header = parseDslHeader(zip.read("header").toString("utf8"));
		// 块目录映射
		const dirs: number[] = [];
		for (let n = 0; n < 128; n++) if (zip.has(`L-${n}/0`)) dirs.push(n);
		const exact = this.header.channels.every((c) => zip.has(`L-${c.index}/0`));
		this.header.channels.forEach((c, i) => {
			c.dir = exact ? c.index : (dirs[i] ?? -1);
		});
	}

	static async open(path: string): Promise<DslFile> {
		const buf = await readFile(path);
		return new DslFile(path, new ZipFile(buf));
	}

	static fromBuffer(path: string, buf: Buffer): DslFile {
		return new DslFile(path, new ZipFile(buf));
	}

	/** 按物理通道号、名字或 D<N> 找通道。 */
	findChannel(ref: string | number): DslChannel | undefined {
		const chs = this.header.channels;
		if (typeof ref === "number") return chs.find((c) => c.index === ref);
		const s = ref.trim();
		if (/^\d+$/.test(s)) return chs.find((c) => c.index === Number(s));
		const byName = chs.find((c) => c.name.toLowerCase() === s.toLowerCase());
		if (byName) return byName;
		const d = /^[dD](\d+)$/.exec(s);
		return d ? chs.find((c) => c.index === Number(d[1])) : undefined;
	}

	/** 某通道的完整位面(懒加载、缓存)。没有块的通道返回全 0。 */
	bitplane(index: number): Uint8Array {
		const cached = this.bits.get(index);
		if (cached) return cached;
		const ch = this.header.channels.find((c) => c.index === index);
		if (!ch) throw new Error(`没有通道 ${index}`);
		const need = Math.ceil(this.header.totalSamples / 8);
		const out = new Uint8Array(need + 8);
		if (ch.dir >= 0) {
			let off = 0;
			for (let b = 0; b < this.header.totalBlocks && off < need; b++) {
				const name = `L-${ch.dir}/${b}`;
				if (!this.zip.has(name)) break;
				const block = this.zip.read(name);
				const take = Math.min(block.length, need + 8 - off);
				out.set(block.subarray(0, take), off);
				off += take;
			}
		}
		this.bits.set(index, out);
		return out;
	}

	/** 该通道在文件里有没有块(被禁用的通道没有,读出来全 0)。 */
	hasData(index: number): boolean {
		return (this.header.channels.find((c) => c.index === index)?.dir ?? -1) >= 0;
	}

	/** 边沿列表;没有块的通道不分配位面,直接给空表。 */
	edges(index: number): EdgeList {
		if (!this.hasData(index)) return { initial: 0, edges: new Uint32Array(0), totalSamples: this.header.totalSamples };
		return extractEdges(this.bitplane(index), this.header.totalSamples);
	}
}

/**
 * 边沿列表:所有电平翻转的采样号(翻转后的第一个采样),外加首采样电平。
 * 嵌入式信号的边沿密度远低于采样率,这是后面一切(时序统计、渲染)的主格式。
 * 全 0x00 / 0xFF 的字节跳过 —— 这是常见情况,决定了它的速度。
 */
export interface EdgeList {
	/** 采样 0 的电平 */
	initial: 0 | 1;
	/** 升序的翻转位置 */
	edges: Uint32Array;
	totalSamples: number;
}

export function extractEdges(bitplane: Uint8Array, totalSamples: number): EdgeList {
	let cap = 1024;
	let edges = new Uint32Array(cap);
	let n = 0;
	const push = (v: number) => {
		if (n === cap) { cap *= 2; const bigger = new Uint32Array(cap); bigger.set(edges); edges = bigger; }
		edges[n++] = v;
	};
	const nbytes = Math.ceil(totalSamples / 8);
	let level = (bitplane[0]! & 1) as 0 | 1;
	const initial = level;
	for (let i = 0; i < nbytes; i++) {
		const byte = bitplane[i]!;
		if (byte === (level ? 0xff : 0x00)) continue;
		const limit = Math.min(8, totalSamples - i * 8);
		for (let b = 0; b < limit; b++) {
			const bit = (byte >> b) & 1;
			if (bit !== level) { level = bit as 0 | 1; push(i * 8 + b); }
		}
	}
	return { initial, edges: edges.subarray(0, n), totalSamples };
}

/** 第一个 >= value 的下标(edges 升序)。 */
export function lowerBound(edges: Uint32Array, value: number): number {
	let lo = 0, hi = edges.length;
	while (lo < hi) { const mid = (lo + hi) >>> 1; if (edges[mid]! < value) lo = mid + 1; else hi = mid; }
	return lo;
}

/** 电平在采样 n 处的值:翻转次数的奇偶。 */
export function levelAt(list: EdgeList, n: number): 0 | 1 {
	return ((list.initial + lowerBound(list.edges, n + 1)) & 1) as 0 | 1;
}

/**
 * 按列聚合的预览:每列 2 bit —— bit0 该列出现过高电平,bit1 出现过低电平。
 * 01 全高 / 10 全低 / 11 有跳变。4 列一字节;1024 列 = 256 字节/通道。
 * 复杂度 O(列数 + 边沿数),与采样总数无关。
 */
export function columnBits(list: EdgeList, from: number, to: number, columns: number): Uint8Array {
	const out = new Uint8Array(Math.ceil(columns / 4));
	if (to <= from || columns <= 0) return out;
	const span = to - from;
	const { edges } = list;
	let e = lowerBound(edges, from);
	let level = ((list.initial + e) & 1) as 0 | 1;
	for (let col = 0; col < columns; col++) {
		const cEnd = from + Math.floor((span * (col + 1)) / columns);
		let mask = level ? 1 : 2;
		while (e < edges.length && edges[e]! < cEnd) {
			level = (level ^ 1) as 0 | 1;
			mask |= level ? 1 : 2;
			e++;
		}
		out[col >> 2] = out[col >> 2]! | (mask << ((col & 3) * 2));
	}
	return out;
}

export interface ChannelStats {
	index: number;
	name: string;
	edges: number;
	/** 首/末边沿的采样号;没有边沿时 undefined */
	firstEdge?: number;
	lastEdge?: number;
	/** 最短脉冲(采样数),没有边沿时 undefined */
	minPulse?: number;
	/** 全程电平(只对无边沿通道有意义) */
	idle: 0 | 1;
	/** 高电平占比 */
	dutyHigh: number;
}

export function channelStats(ch: DslChannel, list: EdgeList): ChannelStats {
	const { edges, initial, totalSamples } = list;
	let minPulse: number | undefined;
	let high = 0;
	let level = initial;
	let prev = 0;
	for (let i = 0; i < edges.length; i++) {
		const at = edges[i]!;
		const width = at - prev;
		if (i > 0 && (minPulse === undefined || width < minPulse)) minPulse = width;
		if (level) high += width;
		level = (level ^ 1) as 0 | 1;
		prev = at;
	}
	if (level) high += totalSamples - prev;
	return {
		index: ch.index,
		name: ch.name,
		edges: edges.length,
		firstEdge: edges.length ? edges[0] : undefined,
		lastEdge: edges.length ? edges[edges.length - 1] : undefined,
		minPulse,
		idle: initial,
		dutyHigh: totalSamples ? high / totalSamples : 0,
	};
}
