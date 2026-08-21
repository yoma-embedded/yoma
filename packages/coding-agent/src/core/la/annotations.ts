/**
 * yoma-la decode 的 NDJSON 注解流:解析、索引、格式化。
 *
 * 一行一条 {s,e,k,c,r?,t[],h?,n?}(格式见 engines/logic-analyzer/src/decode.c),首行 meta、末行 end。
 * 这里补上引擎没给的两样:类名(按 c 查 meta.decoders[].classes)与可读文本(`{$}` 换成数值)。
 */
import { createReadStream } from "node:fs";

export interface AnnMeta {
	type: "meta";
	file: string;
	version: number;
	samplerate: number;
	total_samples: number;
	trigger_pos: number | null;
	from: number;
	to: number;
	channels: { index: number; name: string; has_data: boolean }[];
	decoders: AnnDecoder[];
}

export interface AnnDecoder {
	key: string;
	id: string;
	name: string;
	on?: string;
	channels: Record<string, number>;
	options: Record<string, string | number | boolean>;
	rows: { id: string; desc: string; classes: number[] }[];
	classes: { id: string; desc: string }[];
}

export interface Annotation {
	/** 起止采样号(闭区间,瞬时注解 s===e) */
	s: number;
	e: number;
	/** 实例名 */
	k: string;
	/** 类号与类 id */
	c: number;
	cls: string;
	/** 行 id;没有行的解码器为 "" */
	r: string;
	/** 原始文本(长→短),已去掉忽略标记 */
	t: string[];
	/** 十六进制字符串与数值(UART/SPI/I²C 字节) */
	h?: string;
	n?: number;
}

export interface AnnEnd {
	type: "end";
	annotations: number;
	elapsed_ms: number;
	ok: boolean;
}

export interface AnnotationSet {
	meta: AnnMeta;
	end: AnnEnd | undefined;
	/** 按 s 升序(同 s 保持引擎输出顺序) */
	list: Annotation[];
	byKey: Map<string, Annotation[]>;
	/** 每个实例最长的一条注解(e - s),给"按 s 二分再按 e 过滤"的窗口查询用 */
	spanMax: Map<string, number>;
}

/** 逐行喂,最后 finish():读文件时边到边解,不把整份 NDJSON 先攒成字符串数组。 */
export class AnnotationParser {
	private meta?: AnnMeta;
	private end?: AnnEnd;
	private readonly list: Annotation[] = [];
	private readonly classCache = new Map<string, string[]>();

	push(line: string): void {
		if (!line.trim()) return;
		const obj = JSON.parse(line) as Record<string, unknown>;
		if (obj.type === "meta") { this.meta = obj as unknown as AnnMeta; return; }
		if (obj.type === "end") { this.end = obj as unknown as AnnEnd; return; }
		if (!this.meta) throw new Error("注解流缺 meta 行(引擎输出不完整?)");
		const k = String(obj.k);
		let classes = this.classCache.get(k);
		if (!classes) {
			classes = this.meta.decoders.find((d) => d.key === k)?.classes.map((c) => c.id) ?? [];
			this.classCache.set(k, classes);
		}
		const c = Number(obj.c);
		const a: Annotation = {
			s: Number(obj.s),
			e: Number(obj.e),
			k,
			c,
			cls: classes[c] ?? String(c),
			r: typeof obj.r === "string" ? obj.r : "",
			t: Array.isArray(obj.t) ? (obj.t as string[]) : [],
		};
		if (typeof obj.h === "string") a.h = obj.h;
		if (typeof obj.n === "number") a.n = obj.n;
		this.list.push(a);
	}

	finish(): AnnotationSet {
		if (!this.meta) throw new Error("注解流为空");
		// 多栈时引擎按栈输出,合回时间序;Array.prototype.sort 自 ES2019 起稳定,同 s 保持原顺序
		const sorted = this.list.sort((x, y) => x.s - y.s);
		const byKey = new Map<string, Annotation[]>();
		const spanMax = new Map<string, number>();
		for (const a of sorted) {
			const arr = byKey.get(a.k);
			if (arr) arr.push(a); else byKey.set(a.k, [a]);
			const span = a.e - a.s;
			if (span > (spanMax.get(a.k) ?? 0)) spanMax.set(a.k, span);
		}
		return { meta: this.meta, end: this.end, list: sorted, byKey, spanMax };
	}
}

export function parseAnnotationLines(lines: Iterable<string>): AnnotationSet {
	const p = new AnnotationParser();
	for (const line of lines) p.push(line);
	return p.finish();
}

/** 读引擎写出的 NDJSON 文件。TextDecoder + {stream:true} 跨块拼行:一条注解行可能劈在多字节字符中间。 */
export async function readAnnotationFile(path: string): Promise<AnnotationSet> {
	const parser = new AnnotationParser();
	const decoder = new TextDecoder("utf-8");
	let carry = "";
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk: Buffer | string) => {
			const text = carry + decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
			const parts = text.split("\n");
			carry = parts.pop() ?? "";
			try {
				for (const p of parts) parser.push(p);
			} catch (error) {
				stream.destroy();
				reject(error);
			}
		});
		stream.on("end", () => {
			try {
				const tail = carry + decoder.decode();
				if (tail.trim()) parser.push(tail);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
		stream.on("error", reject);
	});
	return parser.finish();
}

export type NumberBase = "hex" | "dec" | "bin" | "ascii";

export function formatValue(a: Annotation, base: NumberBase = "hex"): string {
	if (a.n === undefined && !a.h) return "";
	const n = a.n ?? Number.parseInt(a.h ?? "0", 16);
	const width = Math.max(2, (a.h ?? "").length);
	switch (base) {
		case "dec": return String(n);
		case "bin": return n.toString(2).padStart(width * 4, "0");
		case "ascii": return n >= 0x20 && n < 0x7f ? `'${String.fromCharCode(n)}'` : `0x${(a.h ?? n.toString(16)).toUpperCase().padStart(width, "0")}`;
		default: return `0x${(a.h ?? n.toString(16)).toUpperCase().padStart(width, "0")}`;
	}
}

/** 最长的一条可读文本,`{$}` 已替换;没有文本只有数值时给数值。 */
export function annText(a: Annotation, base: NumberBase = "hex"): string {
	const v = formatValue(a, base);
	const raw = a.t[0];
	if (raw === undefined) return v || a.cls;
	return raw.includes("{$}") ? raw.replaceAll("{$}", v || "?") : raw;
}

/** 最短的一条(给密集列表用)。 */
export function annShort(a: Annotation, base: NumberBase = "hex"): string {
	const v = formatValue(a, base);
	const raw = a.t[a.t.length - 1];
	if (raw === undefined) return v || a.cls;
	return raw.includes("{$}") ? raw.replaceAll("{$}", v || "?") : raw;
}

/** 采样号 → 秒。 */
export function toSeconds(sample: number, samplerate: number): number {
	return samplerate > 0 ? sample / samplerate : 0;
}

/** 时间格式:按量级选 ns/us/ms/s,保留够区分相邻采样的位数。 */
export function fmtTime(seconds: number, opts: { sign?: boolean } = {}): string {
	const sign = seconds < 0 ? "-" : opts.sign ? "+" : "";
	const v = Math.abs(seconds);
	if (v === 0) return `${sign}0`;
	if (v < 1e-6) return `${sign}${(v * 1e9).toFixed(1)}ns`;
	if (v < 1e-3) return `${sign}${(v * 1e6).toFixed(v < 1e-5 ? 3 : 1)}us`;
	if (v < 1) return `${sign}${(v * 1e3).toFixed(v < 1e-2 ? 4 : 3)}ms`;
	return `${sign}${v.toFixed(6)}s`;
}

/** 绝对时间锚点,固定宽度,便于模型引用:`[  1.204083ms]` */
export function fmtAnchor(sample: number, samplerate: number): string {
	const s = toSeconds(sample, samplerate);
	const ms = s * 1e3;
	return `[${ms.toFixed(6).padStart(12)}ms]`;
}

export function fmtFreq(hz: number): string {
	if (hz >= 1e9) return `${(hz / 1e9).toFixed(3)}GHz`;
	if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)}MHz`;
	if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)}kHz`;
	return `${hz.toFixed(1)}Hz`;
}
