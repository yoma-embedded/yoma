/**
 * 事务模型:把扁平的注解流聚成模型能一眼读懂的东西。
 *
 * 解码器给的是"位级/字节级注解",而模型要判断的是"这次 I²C 写读对不对"。这一层按协议把
 * 注解聚成事务(I²C 的 S…P、UART 的字节游程、SPI 的一次 CS 内传输),再渲染成**行首带时间锚点**
 * 的确定性文本,并提供 expect 差分(与期望事务表逐条比、只报第一处分歧)。
 *
 * I²C 的 ACK/NACK/START/STOP 是 addr-data 行里的 class(没有 "ack" 行),warnings 类从不被 put,
 * 方向注解 "Write"/"Read" 也标成 class 0 —— 异常(NACK@地址、缺 STOP)在 groupI2c 自己推。
 * 不认识的协议走通用渲染:非位级行的注解逐条列出。
 */
import { type AnnDecoder, type Annotation, type AnnotationSet, type NumberBase, annShort, annText, fmtAnchor, fmtTime, toSeconds } from "./annotations.ts";

export type Detail = "txn" | "frame" | "bit";

export interface RenderOptions {
	/** 采样窗口(闭开区间),缺省全程 */
	from?: number;
	to?: number;
	detail?: Detail;
	/** 只看这些行(row id);缺省 = 除位级行外全部 */
	rows?: string[];
	/** 文本/十六进制里找子串(大小写不敏感) */
	search?: string;
	base?: NumberBase;
	/** 最多多少行 */
	limit?: number;
}

export interface RenderResult {
	lines: string[];
	/** 总共有多少条(截断前) */
	total: number;
	truncated: boolean;
	summary: string;
}

/** 位级注解行:事件视图与面板泳道都默认不看(放大到位级再单独要)。 */
export const BIT_ROWS = new Set(["bits", "data-bits", "miso-bits", "mosi-bits", "bit"]);

export function protocolOf(dec: AnnDecoder): "i2c" | "uart" | "spi" | "other" {
	const id = dec.id.replace(/^\d:/, "");
	if (id === "i2c") return "i2c";
	if (id === "uart") return "uart";
	if (id === "spi") return "spi";
	return "other";
}

/* ─────────────────────────── I²C ─────────────────────────── */

export interface I2cSegment {
	dir: "W" | "R";
	addr: number;        // 7 位
	addrAck: boolean | undefined;
	bytes: { v: number; ack: boolean | undefined; s: number; e: number }[];
	s: number;
	e: number;
}

export interface I2cTxn {
	s: number;
	e: number;
	segments: I2cSegment[];
	stopped: boolean;
	issues: string[];
	/** 原始注解(frame/bit 级展开用) */
	members: Annotation[];
}

export function groupI2c(anns: Annotation[], dec: AnnDecoder): I2cTxn[] {
	const unshifted = String(dec.options.address_format ?? "unshifted") === "unshifted";
	const txns: I2cTxn[] = [];
	let cur: I2cTxn | undefined;
	let seg: I2cSegment | undefined;
	let lastAckTarget: { set(v: boolean): void } | undefined;
	const close = () => {
		if (!cur) return;
		if (!cur.stopped) cur.issues.push("missing STOP");
		for (const sg of cur.segments) {
			if (sg.addrAck === false) cur.issues.push(`NACK on address 0x${sg.addr.toString(16).toUpperCase().padStart(2, "0")} (${sg.dir})`);
			sg.bytes.forEach((b, i) => {
				const last = i === sg.bytes.length - 1;
				if (b.ack === false && !(sg.dir === "R" && last)) cur!.issues.push(`NACK on ${sg.dir === "W" ? "write" : "read"} byte #${i + 1} (0x${b.v.toString(16).toUpperCase().padStart(2, "0")})`);
			});
		}
		txns.push(cur);
		cur = undefined; seg = undefined; lastAckTarget = undefined;
	};
	for (const a of anns) {
		const cls = a.cls;
		const text = (a.t[0] ?? "").toLowerCase();
		if (cls === "start" && (text === "start" || text === "s" || text === "")) {
			close();
			cur = { s: a.s, e: a.e, segments: [], stopped: false, issues: [], members: [a] };
			continue;
		}
		if (!cur) continue;
		cur.members.push(a);
		cur.e = Math.max(cur.e, a.e);
		if (cls === "repeat-start") { seg = undefined; continue; }
		if (cls === "address-read" || cls === "address-write") {
			const raw = a.n ?? Number.parseInt(a.h ?? "0", 16);
			seg = { dir: cls === "address-read" ? "R" : "W", addr: unshifted ? raw >> 1 : raw, addrAck: undefined, bytes: [], s: a.s, e: a.e };
			cur.segments.push(seg);
			const sref = seg;
			lastAckTarget = { set: (v) => { sref.addrAck = v; } };
			continue;
		}
		if (cls === "data-read" || cls === "data-write") {
			if (!seg) { seg = { dir: cls === "data-read" ? "R" : "W", addr: -1, addrAck: undefined, bytes: [], s: a.s, e: a.e }; cur.segments.push(seg); }
			const b = { v: a.n ?? Number.parseInt(a.h ?? "0", 16), ack: undefined as boolean | undefined, s: a.s, e: a.e };
			seg.bytes.push(b); seg.e = a.e;
			lastAckTarget = { set: (v) => { b.ack = v; } };
			continue;
		}
		if (cls === "ack") { lastAckTarget?.set(true); lastAckTarget = undefined; continue; }
		if (cls === "nack") { lastAckTarget?.set(false); lastAckTarget = undefined; continue; }
		if (cls === "stop") { cur.stopped = true; close(); continue; }
	}
	close();
	return txns;
}

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

function i2cSegText(sg: I2cSegment): string {
	const addr = sg.addr >= 0 ? `0x${hex2(sg.addr)}` : "?";
	const bytes = sg.bytes.map((b) => hex2(b.v)).join(" ");
	const arrow = sg.dir === "W" ? "<-" : "->";
	return `${sg.dir} ${addr}${sg.addrAck === false ? "!" : ""} ${arrow} ${bytes || "--"}`.trimEnd();
}

function renderI2cTxn(t: I2cTxn, sr: number): string {
	const acks = t.segments.reduce((n, sg) => n + (sg.addrAck === true ? 1 : 0) + sg.bytes.filter((b) => b.ack === true).length, 0);
	const tot = t.segments.reduce((n, sg) => n + (sg.addrAck !== undefined ? 1 : 0) + sg.bytes.filter((b) => b.ack !== undefined).length, 0);
	const body = t.segments.map(i2cSegText).join(" ; Sr ");
	const flag = t.issues.length ? ` ⚠ ${t.issues.join("; ")}` : " ok";
	return `${fmtAnchor(t.s, sr)} ${fmtTime(toSeconds(t.e - t.s, sr), { sign: true }).padStart(9)} ${body}  ack ${acks}/${tot}${flag}`;
}

/* ─────────────────────────── UART ─────────────────────────── */

export interface UartByte { v: number; s: number; e: number; err: string[] }
export interface UartRun { s: number; e: number; bytes: UartByte[] }

export interface UartGroups {
	runs: UartRun[];
	/** 没挂到任何字节上的错误(字节之间的噪声) */
	looseErrors: Annotation[];
	breaks: Annotation[];
	errorCount: number;
	bitSamples: number | undefined;
}

export function groupUart(anns: Annotation[]): UartGroups {
	const bytes: UartByte[] = [];
	const errors: Annotation[] = [];
	const breaks: Annotation[] = [];
	let bitSamples: number | undefined;
	for (const a of anns) {
		if (a.cls === "data" || (a.r === "data" && a.n !== undefined && a.cls !== "start" && a.cls !== "stop")) {
			if (a.n !== undefined || a.h) bytes.push({ v: a.n ?? Number.parseInt(a.h ?? "0", 16), s: a.s, e: a.e, err: [] });
		} else if (a.cls === "parity-err" || a.cls === "warnings" || a.cls === "warning" || a.r === "warnings") {
			errors.push(a);
		} else if (a.cls === "break") {
			breaks.push(a);
		} else if ((a.cls === "data-bits" || a.cls === "start" || a.cls === "stop") && bitSamples === undefined && a.e > a.s) {
			bitSamples = a.e - a.s;
		}
	}
	// 错误挂到重叠的字节上:两边都按 s 升序,归并一遍(从前每个错误扫一遍全部字节)
	const looseErrors: Annotation[] = [];
	let bi = 0;
	for (const e of errors) {
		while (bi < bytes.length && bytes[bi]!.e < e.s) bi++;
		let j = bi;
		let hit: UartByte | undefined;
		while (j < bytes.length && bytes[j]!.s <= e.e) { if (bytes[j]!.e >= e.s) { hit = bytes[j]; break; } j++; }
		if (hit) hit.err.push(annShort(e)); else looseErrors.push(e);
	}
	// 游程:间隔 <= 4 个字节时长、每行 <= 16 字节、带错的字节单独成行
	const runs: UartRun[] = [];
	let run: UartRun | undefined;
	for (const b of bytes) {
		const dur = b.e - b.s;
		if (run && run.bytes.length < 16 && b.s - run.e <= dur * 4 && b.err.length === 0 && run.bytes[run.bytes.length - 1]!.err.length === 0) {
			run.bytes.push(b); run.e = b.e;
		} else {
			run = { s: b.s, e: b.e, bytes: [b] };
			runs.push(run);
		}
	}
	return { runs, looseErrors, breaks, errorCount: errors.length, bitSamples };
}

function ascii(bytes: number[]): string {
	return bytes.map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : v === 0x0a ? "\\n" : v === 0x0d ? "\\r" : v === 0x09 ? "\\t" : ".")).join("");
}

/* ─────────────────────────── SPI ─────────────────────────── */

export interface SpiWord { s: number; e: number; mosi?: number; miso?: number }
export interface SpiXfer { s: number; e: number; words: SpiWord[]; warn: string[] }

export function groupSpi(anns: Annotation[]): SpiXfer[] {
	const words = new Map<number, SpiWord>();
	const spanKeys = new Set<string>();
	const spans: { s: number; e: number }[] = [];
	const warns: Annotation[] = [];
	for (const a of anns) {
		if (a.cls === "mosi-data" || a.cls === "miso-data") {
			let w = words.get(a.s);
			if (!w) { w = { s: a.s, e: a.e }; words.set(a.s, w); }
			const v = a.n ?? Number.parseInt(a.h ?? "0", 16);
			if (a.cls === "mosi-data") w.mosi = v; else w.miso = v;
			w.e = Math.max(w.e, a.e);
		} else if (a.cls === "mosi-transfer" || a.cls === "miso-transfer") {
			// mosi/miso 各报一条同区间的 transfer,合成一个
			const key = `${a.s}:${a.e}`;
			if (!spanKeys.has(key)) { spanKeys.add(key); spans.push({ s: a.s, e: a.e }); }
		} else if (a.cls === "warnings" || a.r === "warnings" || a.r === "other") {
			warns.push(a);
		}
	}
	const sorted = [...words.values()].sort((x, y) => x.s - y.s);
	const xfers: SpiXfer[] = [];
	if (spans.length) {
		// 两边都按 s 升序:双指针把字分进 CS 区间,落在区间外的字各自成一次传输
		spans.sort((x, y) => x.s - y.s);
		let wi = 0;
		for (const sp of spans) {
			while (wi < sorted.length && sorted[wi]!.s < sp.s) { const w = sorted[wi++]!; xfers.push({ s: w.s, e: w.e, words: [w], warn: [] }); }
			const x: SpiXfer = { s: sp.s, e: sp.e, words: [], warn: [] };
			while (wi < sorted.length && sorted[wi]!.s >= sp.s && sorted[wi]!.e <= sp.e) x.words.push(sorted[wi++]!);
			xfers.push(x);
		}
		while (wi < sorted.length) { const w = sorted[wi++]!; xfers.push({ s: w.s, e: w.e, words: [w], warn: [] }); }
	} else {
		let cur: SpiXfer | undefined;
		for (const w of sorted) {
			const dur = w.e - w.s;
			if (cur && w.s - cur.e <= dur * 4) { cur.words.push(w); cur.e = w.e; }
			else { cur = { s: w.s, e: w.e, words: [w], warn: [] }; xfers.push(cur); }
		}
	}
	let xi = 0;
	for (const wa of warns) {
		while (xi < xfers.length && xfers[xi]!.e < wa.s) xi++;
		const x = xfers[xi];
		if (x && wa.s <= x.e && wa.e >= x.s) x.warn.push(annShort(wa));
	}
	return xfers;
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

const overlaps = (s: number, e: number, from: number, to: number) => e >= from && s < to;

function header(set: AnnotationSet, dec: AnnDecoder, from: number, to: number, rows: string[] | undefined, hidden: string[]): string[] {
	const sr = set.meta.samplerate;
	const chans = Object.entries(dec.channels).map(([id, idx]) => {
		const ch = set.meta.channels.find((c) => c.index === idx);
		return `${id}=D${idx}${ch && ch.name && ch.name !== String(idx) ? `"${ch.name}"` : ""}`;
	});
	const opts = Object.entries(dec.options).map(([k, v]) => `${k}=${v}`);
	const shown = rows ? rows.join(",") : dec.rows.filter((r) => !BIT_ROWS.has(r.id)).map((r) => r.id).join(",") || "*";
	return [
		`# dec ${dec.key} = ${dec.id}(${[...chans, ...opts].join(", ")})${dec.on ? ` on ${dec.on}` : ""}`,
		`# window ${fmtTime(toSeconds(from, sr))}..${fmtTime(toSeconds(to, sr))} (samples ${from}..${to})  rows: ${shown}${hidden.length ? `  hidden: ${hidden.join(",")}` : ""}`,
	];
}

interface Ctx {
	sr: number;
	key: string;
	from: number;
	to: number;
	detail: Detail;
	base: NumberBase;
	limit: number;
	matches(line: string): boolean;
}

/** 每个协议:先聚合(全量),再按窗口过滤、渲染到 limit 为止。summary 不依赖 limit。 */
interface ProtocolView {
	summary: string;
	/** 渲染到 ctx.limit 就停;total 是过滤后的事务/块数,与截断无关 */
	render(): { lines: string[]; total: number };
}

function i2cView(full: Annotation[], dec: AnnDecoder, c: Ctx): ProtocolView {
	const txns = groupI2c(full, dec).filter((t) => overlaps(t.s, t.e, c.from, c.to));
	const issues = txns.filter((t) => t.issues.length).length;
	const segs = txns.reduce((n, t) => n + t.segments.length, 0);
	const bytes = txns.reduce((n, t) => n + t.segments.reduce((m, sg) => m + sg.bytes.length, 0), 0);
	return {
		summary: `${txns.length} txn (${segs} addr phases, ${bytes} bytes), ${issues} with issues`,
		render() {
			const lines: string[] = [];
			let total = 0;
			for (let i = 0; i < txns.length; i++) {
				const t = txns[i]!;
				const line = renderI2cTxn(t, c.sr).replace("] ", `] ${c.key} TXN#${i + 1} `);
				if (!c.matches(line)) continue;
				total++;
				if (lines.length >= c.limit) continue;
				lines.push(line);
				if (c.detail === "frame") {
					for (const a of t.members) {
						if (BIT_ROWS.has(a.r)) continue;
						lines.push(`    ${fmtTime(toSeconds(a.s - t.s, c.sr), { sign: true }).padStart(9)}  ${a.cls.padEnd(13)} ${annText(a, c.base)}${a.e > a.s ? `  (${fmtTime(toSeconds(a.e - a.s, c.sr))})` : ""}`);
					}
				}
			}
			return { lines, total };
		},
	};
}

function uartView(full: Annotation[], c: Ctx): ProtocolView {
	const g = groupUart(full);
	const runs = g.runs.filter((r) => overlaps(r.s, r.e, c.from, c.to));
	const loose = g.looseErrors.filter((a) => overlaps(a.s, a.e, c.from, c.to));
	const breaks = g.breaks.filter((a) => overlaps(a.s, a.e, c.from, c.to));
	const nbytes = runs.reduce((n, r) => n + r.bytes.length, 0);
	const baud = g.bitSamples ? ` bit=${fmtTime(toSeconds(g.bitSamples, c.sr))} (≈${Math.round(c.sr / g.bitSamples)} baud)` : "";
	return {
		summary: `${nbytes} bytes in ${runs.length} runs, ${g.errorCount} errors, ${breaks.length} breaks${baud}`,
		render() {
			const events: { s: number; line: string }[] = [];
			for (const r of runs) {
				const vals = r.bytes.map((b) => b.v);
				const errs = r.bytes.flatMap((b) => b.err);
				events.push({ s: r.s, line: `${fmtAnchor(r.s, c.sr)} ${fmtTime(toSeconds(r.e - r.s, c.sr), { sign: true }).padStart(9)} ${c.key} ${vals.length === 1 ? "BYTE" : `RUN n=${vals.length}`}  ${vals.map(hex2).join(" ")}  "${ascii(vals)}"${errs.length ? `  ⚠ ${errs.join(", ")}` : ""}` });
			}
			for (const b of breaks) events.push({ s: b.s, line: `${fmtAnchor(b.s, c.sr)} ${fmtTime(toSeconds(b.e - b.s, c.sr), { sign: true }).padStart(9)} ${c.key} BREAK` });
			for (const e of loose) events.push({ s: e.s, line: `${fmtAnchor(e.s, c.sr)} ${"".padStart(9)} ${c.key} ERR ${annText(e, c.base)}` });
			events.sort((x, y) => x.s - y.s);
			const lines: string[] = [];
			let total = 0;
			for (const ev of events) {
				if (!c.matches(ev.line)) continue;
				total++;
				if (lines.length < c.limit) lines.push(ev.line);
			}
			return { lines, total };
		},
	};
}

function spiView(full: Annotation[], c: Ctx): ProtocolView {
	const xfers = groupSpi(full).filter((x) => overlaps(x.s, x.e, c.from, c.to));
	const words = xfers.reduce((n, x) => n + x.words.length, 0);
	const MAX_WORDS = c.detail === "frame" ? Number.POSITIVE_INFINITY : 32;
	const side = (x: SpiXfer, which: "mosi" | "miso") => {
		const vals = x.words.map((w) => w[which]);
		const shown = vals.slice(0, MAX_WORDS).map((v) => (v === undefined ? "--" : hex2(v))).join(" ");
		const more = vals.length > MAX_WORDS ? ` …(+${vals.length - MAX_WORDS})` : "";
		const printable = vals.filter((v) => v !== undefined && v >= 0x20 && v < 0x7f).length;
		const asc = vals.length >= 4 && printable / vals.length > 0.8 ? `  "${ascii(vals.slice(0, MAX_WORDS).map((v) => v ?? 0))}${vals.length > MAX_WORDS ? "…" : ""}"` : "";
		return `${shown}${more}${asc}`;
	};
	return {
		summary: `${xfers.length} transfers, ${words} words, ${xfers.filter((x) => x.warn.length).length} with warnings`,
		render() {
			const lines: string[] = [];
			let total = 0;
			for (let i = 0; i < xfers.length; i++) {
				const x = xfers[i]!;
				const head = `${fmtAnchor(x.s, c.sr)} ${fmtTime(toSeconds(x.e - x.s, c.sr), { sign: true }).padStart(9)} ${c.key} XFER#${i + 1} ${x.words.length} words${x.warn.length ? `  ⚠ ${x.warn.join(", ")}` : ""}`;
				const block = c.detail === "frame" ? [head, `    MOSI ${side(x, "mosi")}`, `    MISO ${side(x, "miso")}`] : [`${head}  MOSI ${side(x, "mosi")}  MISO ${side(x, "miso")}`];
				if (!block.some(c.matches)) continue;
				total++;
				if (lines.length < c.limit) lines.push(...block);
			}
			return { lines, total };
		},
	};
}

/** 通用:逐条(默认隐藏位级行;detail=bit 或显式 rows 时照给),连续相同文本折成 ×N。 */
function genericView(full: Annotation[], dec: AnnDecoder, c: Ctx, rows: string[] | undefined): ProtocolView {
	const rowFilter = rows ? new Set(rows) : undefined;
	const all = full.filter((a) => overlaps(a.s, a.e, c.from, c.to));
	const perRow = new Map<string, number>();
	for (const a of all) perRow.set(a.r, (perRow.get(a.r) ?? 0) + 1);
	return {
		summary: `${all.length} annotations (${dec.rows.map((r) => `${r.id}:${perRow.get(r.id) ?? 0}`).join(", ")})`,
		render() {
			const lines: string[] = [];
			let total = 0;
			let lastText = "";
			let repeat = 0;
			const flush = () => { if (repeat > 1 && lines.length) lines[lines.length - 1] += `  (×${repeat} same)`; repeat = 0; };
			for (const a of all) {
				if (rowFilter ? !rowFilter.has(a.r) : c.detail !== "bit" && BIT_ROWS.has(a.r)) continue;
				const text = annText(a, c.base);
				const line = `${fmtAnchor(a.s, c.sr)} ${fmtTime(toSeconds(a.e - a.s, c.sr), { sign: true }).padStart(9)} ${c.key} ${a.r ? `${a.r}/` : ""}${a.cls} ${text}`;
				if (!c.matches(line)) continue;
				if (text === lastText && a.r !== "") { repeat++; continue; }
				flush();
				lastText = text; repeat = 1;
				total++;
				if (lines.length < c.limit) lines.push(line);
			}
			flush();
			return { lines, total };
		},
	};
}

function viewOf(set: AnnotationSet, key: string, opts: RenderOptions): { dec: AnnDecoder; ctx: Ctx; view: ProtocolView } {
	const dec = set.meta.decoders.find((d) => d.key === key);
	if (!dec) throw new Error(`没有叫 ${key} 的解码器实例(有:${set.meta.decoders.map((d) => d.key).join(", ")})`);
	const search = opts.search?.toLowerCase();
	const ctx: Ctx = {
		sr: set.meta.samplerate,
		key,
		from: opts.from ?? 0,
		to: opts.to ?? set.meta.total_samples,
		detail: opts.detail ?? "txn",
		base: opts.base ?? "hex",
		limit: opts.limit ?? 200,
		matches: (line) => !search || line.toLowerCase().includes(search),
	};
	// 聚合在全量上做、再按窗口过滤:在窗口切过的注解上聚合会把被切掉的 STOP 误报成 missing STOP
	const full = set.byKey.get(key) ?? [];
	const proto = protocolOf(dec);
	const grouped = ctx.detail !== "bit" && !opts.rows;
	const view =
		grouped && proto === "i2c" ? i2cView(full, dec, ctx)
		: grouped && proto === "uart" ? uartView(full, ctx)
		: grouped && proto === "spi" ? spiView(full, ctx)
		: genericView(full, dec, ctx, opts.rows);
	return { dec, ctx, view };
}

/** 只要计数(decode 动作的回执),不格式化任何一行。 */
export function summarize(set: AnnotationSet, key: string, opts: Pick<RenderOptions, "from" | "to"> = {}): string {
	return viewOf(set, key, opts).view.summary;
}

/** 某个解码器实例在窗口内的事件文本。 */
export function renderEvents(set: AnnotationSet, key: string, opts: RenderOptions = {}): RenderResult {
	const { dec, ctx, view } = viewOf(set, key, opts);
	const hidden = ctx.detail === "bit" ? [] : dec.rows.filter((r) => BIT_ROWS.has(r.id)).map((r) => r.id);
	const { lines, total } = view.render();
	return { lines: [...header(set, dec, ctx.from, ctx.to, opts.rows, hidden), ...lines], total, truncated: total > lines.length && lines.length >= ctx.limit, summary: view.summary };
}

/* ─────────────────────────── expect 差分 ─────────────────────────── */

export interface ExpectResult {
	ok: boolean;
	matched: number;
	expected: number;
	message: string;
}

/** 期望语法,给工具的参数说明与报错共用一份 —— 两处各写一遍已经漂移过一次。 */
export const EXPECT_SYNTAX =
	'one item per line, "#" comments, ".." = anything after. ' +
	'I²C: "W 0x51 00 A5" / "R 0x51 37 .." (7-bit address; each address phase is one line, Sr-separated phases on separate lines). ' +
	'UART: hex bytes "48 65 .." or a quoted string "Hello World". ' +
	'SPI: "MOSI 03 00 10" then "MISO FF FF .." (a MOSI+MISO pair is one transfer; either side may be omitted).';

export function expectDiff(set: AnnotationSet, key: string, expectText: string, opts: { from?: number } = {}): ExpectResult {
	const dec = set.meta.decoders.find((d) => d.key === key);
	if (!dec) throw new Error(`没有叫 ${key} 的解码器实例`);
	const sr = set.meta.samplerate;
	const from = opts.from ?? 0;
	const anns = (set.byKey.get(key) ?? []).filter((a) => a.s >= from);
	const lines = expectText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
	const proto = protocolOf(dec);
	/* 按空白切,但带引号的字符串整体保留("Hello World") */
	const tokens = (line: string): string[] => line.match(/"[^"]*"|\S+/g) ?? [];
	const parseBytes = (toks: string[]): (number | "..")[] => {
		const out: (number | "..")[] = [];
		for (const t of toks) {
			if (!t) continue;
			if (t === "..") { out.push(".."); continue; }
			const q = /^"(.*)"$/.exec(t);
			if (q) { for (const c of q[1]!) out.push(c.charCodeAt(0)); continue; }
			const v = Number.parseInt(t.replace(/^0x/i, ""), 16);
			if (Number.isNaN(v)) throw new Error(`期望里 '${t}' 不是十六进制字节`);
			out.push(v);
		}
		return out;
	};
	const cmpBytes = (exp: (number | "..")[], act: number[]): number => {
		// 返回第一处不一致的下标,-1 = 一致
		for (let i = 0; i < exp.length; i++) {
			if (exp[i] === "..") return -1;
			if (i >= act.length || act[i] !== exp[i]) return i;
		}
		return act.length === exp.length ? -1 : exp.length;
	};
	const fmtBytes = (b: number[]) => b.map(hex2).join(" ") || "--";

	if (proto === "i2c") {
		const segs = groupI2c(anns, dec).flatMap((t) => t.segments.map((sg) => ({ sg, t })));
		let i = 0;
		for (const line of lines) {
			const toks = tokens(line);
			const dir = toks[0]?.toUpperCase();
			if (dir !== "W" && dir !== "R") throw new Error(`期望行 '${line}' 要以 W 或 R 开头`);
			const addr = Number.parseInt((toks[1] ?? "").replace(/^0x/i, ""), 16);
			const exp = parseBytes(toks.slice(2));
			const a = segs[i];
			const where = a ? fmtAnchor(a.sg.s, sr) : "(end of capture)";
			if (!a) return { ok: false, matched: i, expected: lines.length, message: `MISMATCH at #${i + 1}: expected \`${line}\`, but the capture has only ${segs.length} address phases${from ? " after the given start" : ""}.` };
			const actual = `${a.sg.dir} 0x${hex2(a.sg.addr)} ${fmtBytes(a.sg.bytes.map((b) => b.v))}`;
			if (a.sg.dir !== dir || a.sg.addr !== addr) return { ok: false, matched: i, expected: lines.length, message: `MISMATCH at #${i + 1} ${where}:\n   expect  ${line}\n   actual  ${actual}${a.t.issues.length ? `  ⚠ ${a.t.issues.join("; ")}` : ""}\n   ${i} before it matched.` };
			const bad = cmpBytes(exp, a.sg.bytes.map((b) => b.v));
			if (bad >= 0) return { ok: false, matched: i, expected: lines.length, message: `MISMATCH at #${i + 1} ${where} byte #${bad + 1}:\n   expect  ${line}\n   actual  ${actual}${a.t.issues.length ? `  ⚠ ${a.t.issues.join("; ")}` : ""}\n   ${i} before it matched. Use events window around ${fmtTime(toSeconds(a.sg.s, sr))} detail=frame to see ACK/NACK per byte.` };
			i++;
		}
		return { ok: true, matched: i, expected: lines.length, message: `MATCH ${i}/${lines.length}${segs.length > i ? ` (capture continues with ${segs.length - i} more address phases)` : ""}.` };
	}
	if (proto === "uart") {
		const { runs } = groupUart(anns);
		const bytes = runs.flatMap((r) => r.bytes);
		const exp = parseBytes(lines.flatMap((l) => tokens(l)));
		const act = bytes.map((b) => b.v);
		const bad = cmpBytes(exp, act);
		if (bad < 0) return { ok: true, matched: exp.length, expected: exp.length, message: `MATCH ${exp.filter((x) => x !== "..").length} bytes${act.length > exp.length ? ` (capture has ${act.length} bytes total)` : ""}.` };
		const at = bytes[bad];
		return { ok: false, matched: bad, expected: exp.length, message: `MISMATCH at byte #${bad + 1} ${at ? fmtAnchor(at.s, sr) : "(end of capture)"}:\n   expect  ${exp[bad] === undefined ? "(end)" : hex2(exp[bad] as number)}\n   actual  ${at ? `${hex2(at.v)} '${ascii([at.v])}'${at.err.length ? ` ⚠ ${at.err.join(", ")}` : ""}` : "(no more bytes)"}\n   ${bad} bytes before it matched.` };
	}
	if (proto === "spi") {
		const xfers = groupSpi(anns);
		// 成对的 MOSI/MISO 行组成一次传输
		const wants: { mosi?: (number | "..")[]; miso?: (number | "..")[] }[] = [];
		for (const line of lines) {
			const toks = tokens(line);
			const side = toks[0]?.toUpperCase().replace(":", "");
			if (side !== "MOSI" && side !== "MISO") throw new Error(`期望行 '${line}' 要以 MOSI 或 MISO 开头`);
			const last = wants[wants.length - 1];
			const target = last && !last[side === "MOSI" ? "mosi" : "miso"] ? last : (wants.push({}), wants[wants.length - 1]!);
			target[side === "MOSI" ? "mosi" : "miso"] = parseBytes(toks.slice(1));
		}
		for (let i = 0; i < wants.length; i++) {
			const w = wants[i]!;
			const x = xfers[i];
			if (!x) return { ok: false, matched: i, expected: wants.length, message: `MISMATCH at transfer #${i + 1}: capture has only ${xfers.length} transfers.` };
			for (const side of ["mosi", "miso"] as const) {
				const exp = w[side];
				if (!exp) continue;
				const act = x.words.map((wd) => wd[side] ?? -1);
				const bad = cmpBytes(exp, act);
				if (bad >= 0) return { ok: false, matched: i, expected: wants.length, message: `MISMATCH at transfer #${i + 1} ${fmtAnchor(x.s, sr)} ${side.toUpperCase()} word #${bad + 1}:\n   expect  ${exp.map((v) => (v === ".." ? ".." : hex2(v))).join(" ")}\n   actual  ${fmtBytes(act.map((v) => (v < 0 ? 0 : v)))}\n   ${i} transfers before it matched.` };
			}
		}
		return { ok: true, matched: wants.length, expected: wants.length, message: `MATCH ${wants.length}/${wants.length} transfers${xfers.length > wants.length ? ` (capture continues with ${xfers.length - wants.length} more)` : ""}.` };
	}
	throw new Error(`expect 目前只支持 I²C / UART / SPI(这个实例是 ${dec.id})`);
}
