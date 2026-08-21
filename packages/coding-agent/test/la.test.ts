/**
 * la(逻辑分析仪)工具的测试,分两层:
 *
 * 1. 纯单元 —— zip / dsl / annotations / model。除了 .dsl 夹具(仓内的 DSView demo 会话)之外
 *    不碰引擎、不碰硬件,断言全是确定值:边沿数、列位图、事务聚合、渲染文本、expect 差分。
 * 2. 引擎端到端 —— 真跑 engines/bin/yoma-la:import → summary → decode → events/timing/expect,
 *    外加 device="demo" 的采集。引擎没编译时整段干净跳过(不是假绿:跳过会打印一行原因)。
 *
 * 夹具的既知真值(engines/logic-analyzer/vendor/demo/logic/protocol.demo,25 MHz × 131072 采样):
 * SDA=D0 154 个边沿、SCL=D1 510 个;I²C 300 条注解 / 6 个事务,首条 `W 0x62 <- 04 ; Sr R 0x62 -> 4F`;
 * UART(D5,115200)47 字节 "DSLogic series USB-based LA from DreamSourceLab",位宽 8.68us;
 * SPI(D12/D13/D14/D15)5 次传输 288 个字。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/agent/node";
import {
	type AnnDecoder,
	type Annotation,
	annShort,
	annText,
	formatValue,
	parseAnnotationLines,
} from "../src/core/la/annotations.ts";
import {
	DslFile,
	type EdgeList,
	channelStats,
	columnBits,
	extractEdges,
	levelAt,
	parseDslHeader,
	parseSizeString,
} from "../src/core/la/dsl.ts";
import { expectDiff, groupI2c, groupSpi, groupUart, protocolOf, renderEvents } from "../src/core/la/model.ts";
import { ZipFile } from "../src/core/la/zip.ts";
import { type LaToolDetails, createLaToolDefinition, exe } from "../src/index.ts";

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "..", "..", "..");
const ENGINES = join(REPO, "engines");
const LA_BIN = join(ENGINES, "bin", exe("yoma-la"));
const DEMO = join(ENGINES, "logic-analyzer", "vendor", "demo", "logic", "protocol.demo");

const HAS_DEMO = existsSync(DEMO);
const HAS_ENGINE = HAS_DEMO && existsSync(LA_BIN);

if (!HAS_DEMO) console.warn(`[la.test] 跳过夹具相关的用例:${DEMO} 不存在`);
else if (!HAS_ENGINE) console.warn(`[la.test] 跳过引擎端到端用例:${LA_BIN} 不存在(先跑 \`bun engines/build.ts\`)`);

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-la-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

type LaTool = ReturnType<typeof createLaToolDefinition>;

function makeTool(cwd = createTempDir()): { tool: LaTool; cwd: string } {
	const env = new NodeExecutionEnv({ cwd });
	return { tool: createLaToolDefinition(env, { enginesDir: ENGINES }), cwd };
}

async function run(tool: LaTool, params: Record<string, unknown>): Promise<{ text: string; details: LaToolDetails }> {
	const r = await tool.execute("t", params as never, undefined);
	const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
	return { text, details: r.details as LaToolDetails };
}

/** base64 的列位图 → 每列 2bit 的数组(1=全高,2=全低,3=有跳变)。 */
function previewColumns(b64: string): number[] {
	const buf = Buffer.from(b64, "base64");
	const out: number[] = [];
	for (let i = 0; i < buf.length * 4; i++) out.push((buf[i >> 2]! >> ((i & 3) * 2)) & 3);
	return out;
}

// ─── 注解夹具工厂(手写 NDJSON,不经引擎) ──────────────────────────────────

/** 与引擎输出逐字一致的类表(engines/logic-analyzer 的 1:i2c / 1:uart / 1:spi)。 */
const I2C_CLASSES = [
	"start", "repeat-start", "stop", "ack", "nack", "bit",
	"address-read", "address-write", "data-read", "data-write", "warnings",
];
const UART_CLASSES = ["data", "start", "parity-ok", "parity-err", "stop", "warnings", "data-bits", "break"];
const SPI_CLASSES = ["miso-data", "mosi-data", "miso-bits", "mosi-bits", "warnings", "miso-transfer", "mosi-transfer"];

const I2C_DEC: AnnDecoder = {
	key: "i2c0",
	id: "1:i2c",
	name: "1:I²C",
	channels: { sda: 0, scl: 1 },
	options: { address_format: "unshifted" },
	rows: [
		{ id: "bits", desc: "Bits", classes: [5] },
		{ id: "addr-data", desc: "Address/Data", classes: [0, 1, 2, 3, 4, 6, 7, 8, 9] },
		{ id: "warnings", desc: "Warnings", classes: [10] },
	],
	classes: I2C_CLASSES.map((id) => ({ id, desc: id })),
};

const UART_DEC: AnnDecoder = {
	key: "uart0",
	id: "1:uart",
	name: "1:UART",
	channels: { rxtx: 5 },
	options: { baudrate: 115200, num_data_bits: 8 },
	rows: [
		{ id: "data", desc: "RX/TX", classes: [0, 1, 2, 3, 4] },
		{ id: "data-bits", desc: "Bits", classes: [6] },
		{ id: "warnings", desc: "Warnings", classes: [5] },
		{ id: "break", desc: "break", classes: [7] },
	],
	classes: UART_CLASSES.map((id) => ({ id, desc: id })),
};

const SPI_DEC: AnnDecoder = {
	key: "spi0",
	id: "1:spi",
	name: "1:SPI",
	channels: { cs: 13, clk: 12, miso: 15, mosi: 14 },
	options: { wordsize: 8 },
	rows: [
		{ id: "miso-bits", desc: "MISO bits", classes: [2] },
		{ id: "miso-data", desc: "MISO data", classes: [0] },
		{ id: "miso-transfer", desc: "MISO transfer", classes: [5] },
		{ id: "mosi-bits", desc: "MOSI bits", classes: [3] },
		{ id: "mosi-data", desc: "MOSI data", classes: [1] },
		{ id: "mosi-transfer", desc: "MOSI transfer", classes: [6] },
		{ id: "other", desc: "Other", classes: [4] },
	],
	classes: SPI_CLASSES.map((id) => ({ id, desc: id })),
};

const SR = 1_000_000; // 1 MHz:采样号 × 1us,锚点一眼可算
const TOTAL = 10_000;

interface RawAnn {
	s: number;
	e?: number;
	k?: string;
	cls: string;
	r: string;
	t?: string[];
	h?: string;
	n?: number;
}

/** 手写注解 → 与引擎同形状的 NDJSON,再走真正的 parseAnnotationLines。 */
function makeSet(decoders: AnnDecoder[], anns: RawAnn[], opts: { samplerate?: number; total?: number } = {}) {
	const meta = {
		type: "meta",
		file: "fixture.dsl",
		version: 3,
		samplerate: opts.samplerate ?? SR,
		total_samples: opts.total ?? TOTAL,
		trigger_pos: 0,
		from: 0,
		to: opts.total ?? TOTAL,
		channels: [
			{ index: 0, name: "SDA", has_data: true },
			{ index: 1, name: "SCL", has_data: true },
			{ index: 5, name: "UART", has_data: true },
			{ index: 12, name: "CLK", has_data: true },
			{ index: 13, name: "CS#", has_data: true },
			{ index: 14, name: "MOSI", has_data: true },
			{ index: 15, name: "MISO", has_data: true },
		],
		decoders,
	};
	const lines = [JSON.stringify(meta)];
	for (const a of anns) {
		const key = a.k ?? decoders[0]!.key;
		const dec = decoders.find((d) => d.key === key)!;
		const c = dec.classes.findIndex((x) => x.id === a.cls);
		if (c < 0) throw new Error(`夹具写错了:${key} 没有类 ${a.cls}`);
		const obj: Record<string, unknown> = { s: a.s, e: a.e ?? a.s, k: key, c, r: a.r, t: a.t ?? [] };
		if (a.h !== undefined) obj.h = a.h;
		if (a.n !== undefined) obj.n = a.n;
		lines.push(JSON.stringify(obj));
	}
	lines.push(JSON.stringify({ type: "end", annotations: anns.length, elapsed_ms: 1, ok: true }));
	return parseAnnotationLines(lines);
}

/**
 * 一次完整的 I²C 写读:S → AW 0xC4 → A → W 0x04 → A → Sr → AR 0xC5 → A → R 0x4F → N → P。
 * 与 demo 夹具的 TXN#1 同构。`variant` 改造出异常场景。
 */
function i2cTxnAnns(variant: "ok" | "no-stop" | "nack-addr" | "nack-write" = "ok"): RawAnn[] {
	const anns: RawAnn[] = [
		{ s: 1000, cls: "start", r: "addr-data", t: ["Start", "S"] },
		// 方向注解也是 class 0(start),只能靠文本区分 —— 这一条不许开新事务
		{ s: 1180, e: 1200, cls: "start", r: "addr-data", t: ["Write", "Wr", "W"] },
		{ s: 1010, e: 1200, cls: "address-write", r: "addr-data", t: ["Address write: {$}", "AW: {$}", "{$}"], h: "C4", n: 196 },
		{ s: 1210, e: 1220, cls: variant === "nack-addr" ? "nack" : "ack", r: "addr-data", t: variant === "nack-addr" ? ["NACK", "N"] : ["ACK", "A"] },
		{ s: 1230, e: 1400, cls: "data-write", r: "addr-data", t: ["Data write: {$}", "DW: {$}", "{$}"], h: "04", n: 4 },
		{ s: 1410, e: 1420, cls: variant === "nack-write" ? "nack" : "ack", r: "addr-data", t: variant === "nack-write" ? ["NACK", "N"] : ["ACK", "A"] },
		{ s: 1430, cls: "repeat-start", r: "addr-data", t: ["Start repeat", "Sr"] },
		{ s: 1440, e: 1600, cls: "address-read", r: "addr-data", t: ["Address read: {$}", "AR: {$}", "{$}"], h: "C5", n: 197 },
		{ s: 1610, e: 1620, cls: "ack", r: "addr-data", t: ["ACK", "A"] },
		{ s: 1630, e: 1800, cls: "data-read", r: "addr-data", t: ["Data read: {$}", "DR: {$}", "{$}"], h: "4F", n: 79 },
		// 读的最后一字节 NACK 是正常收尾,不该算异常
		{ s: 1810, e: 1820, cls: "nack", r: "addr-data", t: ["NACK", "N"] },
	];
	if (variant !== "no-stop") anns.push({ s: 1830, cls: "stop", r: "addr-data", t: ["Stop", "P"] });
	return anns;
}

/** UART 字节流:每字节 100 采样宽、间隔 10 采样(同一个游程)。 */
function uartBytes(text: string, start = 1000, step = 110): RawAnn[] {
	return [...text].map((ch, i) => ({
		s: start + i * step,
		e: start + i * step + 100,
		cls: "data",
		r: "data",
		t: [],
		h: ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
		n: ch.charCodeAt(0),
	}));
}

/** SPI:mosi/miso 同一个起始采样成对。 */
function spiWords(pairs: [number | undefined, number | undefined][], start = 1000, step = 100): RawAnn[] {
	const out: RawAnn[] = [];
	pairs.forEach(([mosi, miso], i) => {
		const s = start + i * step;
		const e = s + 80;
		if (mosi !== undefined) out.push({ s, e, cls: "mosi-data", r: "mosi-data", t: [], h: mosi.toString(16).toUpperCase().padStart(2, "0"), n: mosi });
		if (miso !== undefined) out.push({ s, e, cls: "miso-data", r: "miso-data", t: [], h: miso.toString(16).toUpperCase().padStart(2, "0"), n: miso });
	});
	return out;
}

// ─── 第一层:zip ─────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DEMO)("zip 读取器", () => {
	it("读出 demo .dsl 的中央目录:header + 每通道一个位面块", () => {
		const zip = new ZipFile(readFileSync(DEMO));
		expect(zip.has("header")).toBe(true);
		expect(zip.has("L-0/0")).toBe(true);
		expect(zip.has("L-15/0")).toBe(true);
		// header/decoders/session + 16 个逻辑通道各一个块
		expect(zip.entries.size).toBe(19);
		expect([...zip.entries.keys()].filter((n) => n.startsWith("L-"))).toHaveLength(16);
		expect(zip.entries.get("L-7/0")).toMatchObject({ method: 8, uncompressedSize: 16384 });
		const header = zip.read("header").toString("utf8");
		expect(header).toContain("[header]");
		expect(header).toContain("samplerate = 25 MHz");
		expect(header).toContain("probe0 = SDA");
		// 131072 采样 = 16384 字节/通道(1 bit/采样)
		expect(zip.read("L-0/0").length).toBe(131072 / 8);
	});

	it("条目不存在时说清楚是哪一个", () => {
		const zip = new ZipFile(readFileSync(DEMO));
		expect(() => zip.read("L-99/0")).toThrow(/没有条目 L-99\/0/);
	});

	it("不是 zip 的东西不会被当成 zip", () => {
		expect(() => new ZipFile(Buffer.from("not a zip at all"))).toThrow(/不是 zip 文件/);
	});
});

// ─── 第一层:dsl ─────────────────────────────────────────────────────────────

describe("parseSizeString", () => {
	it("认 libsigrok 的写法", () => {
		expect(parseSizeString("25 MHz")).toBe(25e6);
		expect(parseSizeString("25M")).toBe(25e6);
		expect(parseSizeString("500 kHz")).toBe(500e3);
		expect(parseSizeString("1000000")).toBe(1e6);
		expect(parseSizeString("1.5M")).toBe(1.5e6);
		expect(parseSizeString(" 2g ")).toBe(2e9);
	});

	it("认不出来时给 undefined,而不是 NaN", () => {
		expect(parseSizeString("")).toBeUndefined();
		expect(parseSizeString("fast")).toBeUndefined();
		expect(parseSizeString("25 THz")).toBeUndefined();
	});
});

describe("parseDslHeader", () => {
	const ini = [
		"[version]",
		"version = 2",
		"[header]",
		"device mode = 0",
		"samplerate = 25 MHz",
		"total samples = 131072",
		"total blocks = 1",
		"trigger pos = 4096",
		"probe0 = SDA",
		"probe1 = SCL",
		"probe5 = UART",
		"# 注释",
		"; 也是注释",
	].join("\n");

	it("读出采样率、总数、通道表(按物理号升序)", () => {
		const h = parseDslHeader(ini);
		expect(h.version).toBe(2);
		expect(h.samplerate).toBe(25e6);
		expect(h.totalSamples).toBe(131072);
		expect(h.totalBlocks).toBe(1);
		expect(h.triggerPos).toBe(4096);
		expect(h.channels.map((c) => [c.index, c.name])).toEqual([[0, "SDA"], [1, "SCL"], [5, "UART"]]);
	});

	it("没写 total blocks 时按每块 16M 采样推", () => {
		const h = parseDslHeader(ini.replace("total blocks = 1\n", ""));
		expect(h.totalBlocks).toBe(1);
	});

	it("v1 格式直接拒绝(DSView 自己也放不了)", () => {
		expect(() => parseDslHeader(ini.replace("version = 2", "version = 1"))).toThrow(/v1 格式/);
	});

	it("DSO/模拟数据拒绝,并说明原因", () => {
		expect(() => parseDslHeader(ini.replace("device mode = 0", "device mode = 1"))).toThrow(/不是逻辑分析仪数据/);
	});
});

describe.skipIf(!HAS_DEMO)("DslFile(demo 夹具)", () => {
	let dsl: DslFile;
	beforeAll(async () => {
		dsl = await DslFile.open(DEMO);
	});

	it("头是 25 MHz × 131072 × 16 通道,通道名认得出来", () => {
		expect(dsl.header.samplerate).toBe(25_000_000);
		expect(dsl.header.totalSamples).toBe(131_072);
		expect(dsl.header.channels).toHaveLength(16);
		expect(dsl.header.channels.map((c) => c.name).slice(0, 2)).toEqual(["SDA", "SCL"]);
		expect(dsl.header.channels[5]!.name).toBe("UART");
		expect(dsl.header.channels.slice(12).map((c) => c.name)).toEqual(["CLK", "CS#", "MOSI", "MISO"]);
		// 每个通道都有自己的块目录
		expect(dsl.header.channels.every((c) => c.dir === c.index)).toBe(true);
	});

	it("findChannel 认物理号、名字(大小写不敏感)和 D<N>", () => {
		expect(dsl.findChannel("SDA")?.index).toBe(0);
		expect(dsl.findChannel("sda")?.index).toBe(0);
		expect(dsl.findChannel("D5")?.index).toBe(5);
		expect(dsl.findChannel("1")?.index).toBe(1);
		expect(dsl.findChannel(15)?.index).toBe(15);
		expect(dsl.findChannel("SDA2")).toBeUndefined();
	});

	it("边沿数是既知真值:SDA 154、SCL 510", () => {
		const sda = extractEdges(dsl.bitplane(0), dsl.header.totalSamples);
		const scl = extractEdges(dsl.bitplane(1), dsl.header.totalSamples);
		expect(sda.edges.length).toBe(154);
		expect(scl.edges.length).toBe(510);
		expect(sda.initial).toBe(1);
		expect(scl.initial).toBe(1);
		expect(scl.edges[0]).toBe(45479);
		expect(scl.edges[scl.edges.length - 1]).toBe(119910);
	});

	it("levelAt 与直接读位面同解", () => {
		const bp = dsl.bitplane(1);
		const scl = extractEdges(bp, dsl.header.totalSamples);
		for (const n of [0, 45478, 45479, 45480, 60000, 119910, 131071]) {
			expect(levelAt(scl, n)).toBe(((bp[n >> 3]! >> (n & 7)) & 1) as 0 | 1);
		}
	});

	it("channelStats:SCL 全程高电平起步、最短脉冲 123 采样、占空比 ~75%", () => {
		const scl = extractEdges(dsl.bitplane(1), dsl.header.totalSamples);
		const st = channelStats(dsl.header.channels[1]!, scl);
		expect(st).toMatchObject({ index: 1, name: "SCL", edges: 510, firstEdge: 45479, lastEdge: 119910, minPulse: 123, idle: 1 });
		expect(st.dutyHigh).toBeCloseTo(0.7496, 4);
	});

	it("columnBits:边沿之外的列只有纯高,活动区里有跳变", () => {
		const scl = extractEdges(dsl.bitplane(1), dsl.header.totalSamples);
		const cols = previewColumns(Buffer.from(columnBits(scl, 0, dsl.header.totalSamples, 1024)).toString("base64"));
		expect(cols).toHaveLength(1024);
		// 每列 128 采样:首边沿在第 355 列、末边沿在第 936 列
		for (let i = 0; i < 355; i++) expect(cols[i]).toBe(1);
		for (let i = 937; i < 1024; i++) expect(cols[i]).toBe(1);
		expect(cols.filter((v) => v === 3).length).toBe(500);
		// 采不到的值:0(既没高也没低)不该出现
		expect(cols.some((v) => v === 0)).toBe(false);
	});
});

describe("边沿列表与列位图(合成数据)", () => {
	it("extractEdges 记翻转后的第一个采样,首电平单独给", () => {
		// 0b1100_1100 = 采样 0,1 低,2,3 高,4,5 低,6,7 高(字节内 LSB 优先)
		const bp = new Uint8Array([0b1100_1100, 0x00]);
		const list = extractEdges(bp, 16);
		expect(list.initial).toBe(0);
		expect(Array.from(list.edges)).toEqual([2, 4, 6, 8]);
	});

	it("全 0x00 / 0xFF 的字节被跳过,结果不变", () => {
		const bp = new Uint8Array(64);
		bp.fill(0xff, 8, 16); // 采样 64..127 全高
		const list = extractEdges(bp, 512);
		expect(list.initial).toBe(0);
		expect(Array.from(list.edges)).toEqual([64, 128]);
	});

	it("不翻转的通道只出 01(全高)或 10(全低)", () => {
		const high: EdgeList = { initial: 1, edges: new Uint32Array(0), totalSamples: 1000 };
		const low: EdgeList = { initial: 0, edges: new Uint32Array(0), totalSamples: 1000 };
		expect(new Set(previewColumns(Buffer.from(columnBits(high, 0, 1000, 64)).toString("base64")))).toEqual(new Set([1]));
		expect(new Set(previewColumns(Buffer.from(columnBits(low, 0, 1000, 64)).toString("base64")))).toEqual(new Set([2]));
	});

	it("翻转落在哪一列,11 就出现在哪一列", () => {
		const list: EdgeList = { initial: 0, edges: Uint32Array.from([500]), totalSamples: 1000 };
		const cols = previewColumns(Buffer.from(columnBits(list, 0, 1000, 4)).toString("base64"));
		expect(cols).toEqual([2, 2, 3, 1]);
	});

	it("channelStats 的占空比/最短脉冲只数完整脉冲", () => {
		const list: EdgeList = { initial: 0, edges: Uint32Array.from([100, 300]), totalSamples: 400 };
		const st = channelStats({ index: 3, name: "X", dir: 3 }, list);
		expect(st).toMatchObject({ edges: 2, firstEdge: 100, lastEdge: 300, minPulse: 200, idle: 0 });
		expect(st.dutyHigh).toBeCloseTo(0.5, 6);
	});
});

// ─── 第一层:annotations ─────────────────────────────────────────────────────

describe("parseAnnotationLines", () => {
	const set = makeSet(
		[I2C_DEC, UART_DEC],
		[
			{ s: 1000, cls: "start", r: "addr-data", t: ["Start", "S"] },
			{ s: 1010, e: 1200, cls: "address-write", r: "addr-data", t: ["Address write: {$}", "AW: {$}", "{$}"], h: "C4", n: 196 },
			{ s: 500, k: "uart0", cls: "data", r: "data", t: [], h: "44", n: 68 },
			{ s: 1210, e: 1220, cls: "ack", r: "addr-data", t: ["ACK", "A"] },
		],
	);

	it("补上类名(按 meta 的 classes 表查 c)", () => {
		expect(set.list.map((a) => a.cls)).toEqual(["data", "start", "address-write", "ack"]);
	});

	it("按起始采样归并多个解码器实例,并按 key 建索引", () => {
		expect(set.list.map((a) => a.s)).toEqual([500, 1000, 1010, 1210]);
		expect(set.byKey.get("i2c0")).toHaveLength(3);
		expect(set.byKey.get("uart0")).toHaveLength(1);
	});

	it("meta 与 end 行不进注解表", () => {
		expect(set.meta.samplerate).toBe(SR);
		expect(set.meta.decoders).toHaveLength(2);
		expect(set.end).toMatchObject({ type: "end", annotations: 4, ok: true });
	});

	it("`{$}` 占位换成数值:长文本给 annText,短文本给 annShort", () => {
		const addr = set.list.find((a) => a.cls === "address-write")!;
		expect(annText(addr)).toBe("Address write: 0xC4");
		expect(annShort(addr)).toBe("0xC4");
		// 没有占位的文本原样给
		const ack = set.list.find((a) => a.cls === "ack")!;
		expect(annText(ack)).toBe("ACK");
		expect(annShort(ack)).toBe("A");
	});

	it("只有数值没有文本时(UART 字节)退回数值本身", () => {
		const byte = set.byKey.get("uart0")![0]!;
		expect(annText(byte)).toBe("0x44");
		expect(annShort(byte)).toBe("0x44");
	});

	it("formatValue 的四种进制", () => {
		const addr = set.list.find((a) => a.cls === "address-write")!;
		expect(formatValue(addr, "hex")).toBe("0xC4");
		expect(formatValue(addr, "dec")).toBe("196");
		expect(formatValue(addr, "bin")).toBe("11000100");
		const byte = set.byKey.get("uart0")![0]!;
		expect(formatValue(byte, "ascii")).toBe("'D'");
		expect(formatValue({ ...byte, h: "04", n: 4 } as Annotation, "ascii")).toBe("0x04");
		// 没有数值的注解给空串
		expect(formatValue(set.list.find((a) => a.cls === "start")!)).toBe("");
	});

	it("缺 meta 行的流是坏输出,不是空结果", () => {
		expect(() => parseAnnotationLines(['{"s":1,"e":1,"k":"i2c0","c":0,"r":"","t":[]}'])).toThrow(/缺 meta 行/);
		expect(() => parseAnnotationLines([])).toThrow(/注解流为空/);
	});
});

// ─── 第一层:model(事务聚合) ───────────────────────────────────────────────

describe("groupI2c", () => {
	it("一次写读聚成一个事务:两个地址段、地址不移位、读末尾的 NACK 不算异常", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		const txns = groupI2c(set.byKey.get("i2c0")!, I2C_DEC);
		expect(txns).toHaveLength(1);
		const t = txns[0]!;
		expect(t.stopped).toBe(true);
		expect(t.issues).toEqual([]);
		expect(t.segments.map((s) => [s.dir, s.addr])).toEqual([["W", 0x62], ["R", 0x62]]);
		expect(t.segments[0]!.addrAck).toBe(true);
		expect(t.segments[0]!.bytes.map((b) => [b.v, b.ack])).toEqual([[0x04, true]]);
		expect(t.segments[1]!.bytes.map((b) => [b.v, b.ack])).toEqual([[0x4f, false]]);
		expect(t.s).toBe(1000);
		expect(t.e).toBe(1830);
	});

	it('方向注解("Write")也是 class start —— 不许把它当成新事务', () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		expect(groupI2c(set.byKey.get("i2c0")!, I2C_DEC)).toHaveLength(1);
	});

	it("缺 STOP 记成 issue(下一个 START 或流末尾收尾)", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("no-stop"));
		const txns = groupI2c(set.byKey.get("i2c0")!, I2C_DEC);
		expect(txns).toHaveLength(1);
		expect(txns[0]!.stopped).toBe(false);
		expect(txns[0]!.issues).toEqual(["missing STOP"]);
	});

	it("地址 NACK 记成 issue,并带上地址与方向", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("nack-addr"));
		const t = groupI2c(set.byKey.get("i2c0")!, I2C_DEC)[0]!;
		expect(t.segments[0]!.addrAck).toBe(false);
		expect(t.issues).toEqual(["NACK on address 0x62 (W)"]);
	});

	it("写数据被 NACK 记成 issue(读的最后一字节则不记)", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("nack-write"));
		const t = groupI2c(set.byKey.get("i2c0")!, I2C_DEC)[0]!;
		expect(t.issues).toEqual(["NACK on write byte #1 (0x04)"]);
	});

	it("shifted 地址格式下不再右移", () => {
		const dec: AnnDecoder = { ...I2C_DEC, options: { address_format: "shifted" } };
		const set = makeSet([dec], i2cTxnAnns("ok"));
		const t = groupI2c(set.byKey.get("i2c0")!, dec)[0]!;
		expect(t.segments.map((s) => s.addr)).toEqual([0xc4, 0xc5]);
	});

	it("两个 START 之间各成一个事务", () => {
		const second = i2cTxnAnns("ok").map((a) => ({ ...a, s: a.s + 2000, e: (a.e ?? a.s) + 2000 }));
		const set = makeSet([I2C_DEC], [...i2cTxnAnns("ok"), ...second]);
		expect(groupI2c(set.byKey.get("i2c0")!, I2C_DEC)).toHaveLength(2);
	});
});

describe("groupUart", () => {
	it("连续的字节聚成游程,长间隔断开", () => {
		const set = makeSet([UART_DEC], [...uartBytes("Hello"), ...uartBytes("World", 5000)]);
		const { runs, errorCount, looseErrors, breaks } = groupUart(set.byKey.get("uart0")!);
		expect(runs).toHaveLength(2);
		expect(runs.map((r) => r.bytes.length)).toEqual([5, 5]);
		expect(String.fromCharCode(...runs[0]!.bytes.map((b) => b.v))).toBe("Hello");
		expect(errorCount).toBe(0);
		expect(looseErrors).toEqual([]);
		expect(breaks).toEqual([]);
	});

	it("一个游程最多 16 字节", () => {
		const set = makeSet([UART_DEC], uartBytes("ABCDEFGHIJKLMNOPQRST"));
		const { runs } = groupUart(set.byKey.get("uart0")!);
		expect(runs.map((r) => r.bytes.length)).toEqual([16, 4]);
	});

	it("校验错挂到重叠的那个字节上,并把游程切开", () => {
		const anns = uartBytes("Hi!");
		anns.push({ s: 1115, e: 1200, cls: "parity-err", r: "warnings", t: ["Parity error", "PE"] });
		const set = makeSet([UART_DEC], anns);
		const { runs, errorCount, looseErrors } = groupUart(set.byKey.get("uart0")!);
		expect(errorCount).toBe(1);
		expect(looseErrors).toEqual([]);
		const flat = runs.flatMap((r) => r.bytes);
		expect(flat[1]!.err).toEqual(["PE"]);
		// 带错的字节不与后面的字节合成一个游程
		expect(runs.length).toBeGreaterThan(1);
	});

	it("break 单独收,位宽从 data-bits 推", () => {
		const anns: RawAnn[] = [
			...uartBytes("Hi"),
			{ s: 1000, e: 1008, cls: "data-bits", r: "data-bits", t: ["1"] },
			{ s: 3000, e: 3500, cls: "break", r: "break", t: ["Break", "B"] },
		];
		const { breaks, bitSamples } = groupUart(makeSet([UART_DEC], anns).byKey.get("uart0")!);
		expect(breaks).toHaveLength(1);
		expect(bitSamples).toBe(8);
	});
});

describe("groupSpi", () => {
	it("mosi/miso 按同一个起始采样配对", () => {
		const set = makeSet([SPI_DEC], spiWords([[0x03, 0xff], [0x00, 0xa5]]));
		const xfers = groupSpi(set.byKey.get("spi0")!);
		expect(xfers).toHaveLength(1);
		expect(xfers[0]!.words.map((w) => [w.mosi, w.miso])).toEqual([[0x03, 0xff], [0x00, 0xa5]]);
	});

	it("只有一侧接线时另一侧留空(不编 0)", () => {
		const set = makeSet([SPI_DEC], spiWords([[0x03, undefined], [undefined, 0xa5]]));
		const words = groupSpi(set.byKey.get("spi0")!)[0]!.words;
		expect(words.map((w) => [w.mosi, w.miso])).toEqual([[0x03, undefined], [undefined, 0xa5]]);
	});

	it("没有 transfer 注解时按间隔切分传输", () => {
		const set = makeSet([SPI_DEC], [...spiWords([[1, 1], [2, 2]]), ...spiWords([[3, 3]], 8000)]);
		const xfers = groupSpi(set.byKey.get("spi0")!);
		expect(xfers.map((x) => x.words.length)).toEqual([2, 1]);
	});

	it("有 transfer 注解时按它切分,警告挂到覆盖它的那次传输上", () => {
		const anns: RawAnn[] = [
			...spiWords([[1, 1], [2, 2]]),
			{ s: 1000, e: 1180, cls: "mosi-transfer", r: "mosi-transfer", t: ["01 02"] },
			{ s: 1000, e: 1180, cls: "miso-transfer", r: "miso-transfer", t: ["01 02"] },
			{ s: 1050, e: 1060, cls: "warnings", r: "other", t: ["Clock change", "CC"] },
		];
		const xfers = groupSpi(makeSet([SPI_DEC], anns).byKey.get("spi0")!);
		expect(xfers).toHaveLength(1);
		expect(xfers[0]!).toMatchObject({ s: 1000, e: 1180 });
		expect(xfers[0]!.words).toHaveLength(2);
		expect(xfers[0]!.warn).toEqual(["CC"]);
	});
});

describe("protocolOf", () => {
	it("认得带解码器堆栈前缀的 id", () => {
		expect(protocolOf(I2C_DEC)).toBe("i2c");
		expect(protocolOf(UART_DEC)).toBe("uart");
		expect(protocolOf(SPI_DEC)).toBe("spi");
		expect(protocolOf({ ...I2C_DEC, id: "modbus" })).toBe("other");
	});
});

// ─── 第一层:model(渲染) ───────────────────────────────────────────────────

describe("renderEvents", () => {
	it("I²C:一行一个事务,行首是绝对时间锚点,末尾是 ack 计数", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		const res = renderEvents(set, "i2c0");
		expect(res.lines[0]).toBe('# dec i2c0 = 1:i2c(sda=D0"SDA", scl=D1"SCL", address_format=unshifted)');
		expect(res.lines[1]).toContain("# window 0..10.000ms (samples 0..10000)  rows: addr-data,warnings  hidden: bits");
		expect(res.lines[2]).toBe("[    1.000000ms] i2c0 TXN#1  +830.0us W 0x62 <- 04 ; Sr R 0x62 -> 4F  ack 3/4 ok");
		expect(res.summary).toBe("1 txn (2 addr phases, 2 bytes), 0 with issues");
		expect(res.total).toBe(1);
		expect(res.truncated).toBe(false);
	});

	it("I²C:异常事务带 ⚠ 与原因,并计进 summary", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("nack-addr"));
		const res = renderEvents(set, "i2c0");
		expect(res.lines[2]).toContain("⚠ NACK on address 0x62 (W)");
		expect(res.summary).toBe("1 txn (2 addr phases, 2 bytes), 1 with issues");
	});

	it("I²C:detail=frame 展开成员注解,位级行仍然折叠", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		const res = renderEvents(set, "i2c0", { detail: "frame" });
		const body = res.lines.join("\n");
		expect(body).toContain("address-write Address write: 0xC4  (190.0us)");
		expect(body).toContain("data-read     Data read: 0x4F");
		// 成员的时间是相对事务起点的偏移
		expect(body).toContain("     +430.0us  repeat-start  Start repeat");
		expect(body).not.toContain("/bits ");
	});

	it("I²C:窗口在聚合之后才过滤 —— 被切掉的 STOP 不会变成假的 missing STOP", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		// 窗口在 STOP(1830)之前结束
		const res = renderEvents(set, "i2c0", { from: 0, to: 1500 });
		expect(res.total).toBe(1);
		expect(res.lines[2]).toContain("ok");
		expect(res.lines[2]).not.toContain("missing STOP");
	});

	it("UART:游程带十六进制与 ASCII,summary 里有位宽与波特率", () => {
		const anns: RawAnn[] = [...uartBytes("Hi"), { s: 1000, e: 1009, cls: "data-bits", r: "data-bits", t: ["1"] }];
		const res = renderEvents(makeSet([UART_DEC], anns), "uart0");
		expect(res.lines[2]).toBe('[    1.000000ms]  +210.0us uart0 RUN n=2  48 69  "Hi"');
		expect(res.summary).toBe("2 bytes in 1 runs, 0 errors, 0 breaks bit=9.000us (≈111111 baud)");
	});

	it("UART:单字节写成 BYTE 而不是 RUN", () => {
		const res = renderEvents(makeSet([UART_DEC], uartBytes("A")), "uart0");
		expect(res.lines[2]).toContain("uart0 BYTE  41 ");
	});

	it("SPI:一行一次传输,MOSI/MISO 并排", () => {
		const set = makeSet([SPI_DEC], spiWords([[0x03, 0xff], [0x00, 0xa5]]));
		const res = renderEvents(set, "spi0");
		expect(res.lines[2]).toBe("[    1.000000ms]  +180.0us spi0 XFER#1 2 words  MOSI 03 00  MISO FF A5");
		expect(res.summary).toBe("1 transfers, 2 words, 0 with warnings");
	});

	it("search 只留命中的行,limit 触发 truncated", () => {
		const second = i2cTxnAnns("ok").map((a) => ({ ...a, s: a.s + 2000, e: (a.e ?? a.s) + 2000 }));
		const set = makeSet([I2C_DEC], [...i2cTxnAnns("ok"), ...second]);
		expect(renderEvents(set, "i2c0").total).toBe(2);
		expect(renderEvents(set, "i2c0", { limit: 1 }).truncated).toBe(true);
		expect(renderEvents(set, "i2c0", { search: "TXN#2" }).total).toBe(1);
		expect(renderEvents(set, "i2c0", { search: "0x77" }).total).toBe(0);
	});

	it("不认识的实例名报错时把有的名字列出来", () => {
		const set = makeSet([I2C_DEC], i2cTxnAnns("ok"));
		expect(() => renderEvents(set, "nope")).toThrow("没有叫 nope 的解码器实例(有:i2c0)");
	});

	it("非 I²C/UART/SPI 走通用渲染,逐条列出", () => {
		const other: AnnDecoder = {
			key: "can0", id: "can", name: "CAN", channels: { can_rx: 9 }, options: {},
			rows: [{ id: "fields", desc: "Fields", classes: [0] }],
			classes: [{ id: "data", desc: "data" }],
		};
		const set = makeSet([other], [
			{ s: 1000, e: 1100, k: "can0", cls: "data", r: "fields", t: ["ID 0x123"] },
			{ s: 1200, e: 1300, k: "can0", cls: "data", r: "fields", t: ["ID 0x124"] },
		]);
		const res = renderEvents(set, "can0");
		expect(res.lines[2]).toContain("can0 fields/data ID 0x123");
		expect(res.summary).toBe("2 annotations (fields:2)");
	});
});

// ─── 第一层:model(expect 差分) ────────────────────────────────────────────

describe("expectDiff", () => {
	const i2cSet = makeSet([I2C_DEC], i2cTxnAnns("ok"));
	const uartSet = makeSet([UART_DEC], uartBytes("Hello World"));
	const spiSet = makeSet([SPI_DEC], spiWords([[0x03, 0xff], [0x00, 0xa5]]));

	it("I²C:逐段比,全中给 MATCH", () => {
		const r = expectDiff(i2cSet, "i2c0", "W 0x62 04\nR 0x62 4F");
		expect(r.ok).toBe(true);
		expect(r.message).toBe("MATCH 2/2.");
	});

	it("I²C:注释行与空行忽略", () => {
		const r = expectDiff(i2cSet, "i2c0", "# 写寄存器 4\nW 0x62 04\n\n# 读回\nR 0x62 4F\n");
		expect(r.ok).toBe(true);
	});

	it("I²C:只报第一处分歧,带锚点与下一步怎么看", () => {
		const r = expectDiff(i2cSet, "i2c0", "W 0x62 05");
		expect(r.ok).toBe(false);
		expect(r.matched).toBe(0);
		expect(r.message).toContain("MISMATCH at #1 [    1.010000ms] byte #1:");
		expect(r.message).toContain("expect  W 0x62 05");
		expect(r.message).toContain("actual  W 0x62 04");
		expect(r.message).toContain("detail=frame");
	});

	it("I²C:地址/方向对不上时报的是段本身", () => {
		const r = expectDiff(i2cSet, "i2c0", "W 0x62 04\nW 0x50 4F");
		expect(r.ok).toBe(false);
		expect(r.matched).toBe(1);
		expect(r.message).toContain("actual  R 0x62 4F");
		expect(r.message).toContain("1 before it matched.");
	});

	it("I²C:期望比抓到的还长时说清楚只有几段", () => {
		const r = expectDiff(i2cSet, "i2c0", "W 0x62 04\nR 0x62 4F\nW 0x62 09");
		expect(r.message).toContain("the capture has only 2 address phases");
	});

	it("I²C:`..` 之后的字节不再比", () => {
		expect(expectDiff(i2cSet, "i2c0", "W 0x62 ..\nR 0x62 ..").ok).toBe(true);
	});

	it("I²C:期望行必须以 W/R 开头", () => {
		expect(() => expectDiff(i2cSet, "i2c0", "READ 0x62 04")).toThrow(/要以 W 或 R 开头/);
	});

	it("UART:带空格的引号字符串整体当一个 token", () => {
		const r = expectDiff(uartSet, "uart0", '"Hello World"');
		expect(r.ok).toBe(true);
		expect(r.message).toBe("MATCH 11 bytes.");
	});

	it("UART:`..` 收尾时后面的字节随意", () => {
		const r = expectDiff(uartSet, "uart0", '"Hello" ..');
		expect(r.ok).toBe(true);
		expect(r.message).toBe("MATCH 5 bytes (capture has 11 bytes total).");
		expect(expectDiff(uartSet, "uart0", "48 65 6C ..").ok).toBe(true);
	});

	it("UART:第一处不一致带锚点、期望值、实际值与 ASCII", () => {
		const r = expectDiff(uartSet, "uart0", '"Hellp" ..');
		expect(r.ok).toBe(false);
		expect(r.matched).toBe(4);
		expect(r.message).toContain("MISMATCH at byte #5 [    1.440000ms]:");
		expect(r.message).toContain("expect  70");
		expect(r.message).toContain("actual  6F 'o'");
		expect(r.message).toContain("4 bytes before it matched.");
	});

	it("UART:没有 `..` 时长度也要对上", () => {
		const r = expectDiff(uartSet, "uart0", '"Hello"');
		expect(r.ok).toBe(false);
		expect(r.message).toContain("expect  (end)");
	});

	it("UART:不是十六进制的 token 直接报错", () => {
		expect(() => expectDiff(uartSet, "uart0", "48 ZZ")).toThrow(/'ZZ' 不是十六进制字节/);
	});

	it("SPI:MOSI/MISO 成对一次传输", () => {
		const r = expectDiff(spiSet, "spi0", "MOSI 03 00\nMISO FF A5");
		expect(r.ok).toBe(true);
		expect(r.message).toBe("MATCH 1/1 transfers.");
	});

	it("SPI:任一侧可以省;`..` 同样有效", () => {
		expect(expectDiff(spiSet, "spi0", "MOSI 03 ..").ok).toBe(true);
		expect(expectDiff(spiSet, "spi0", "MISO FF ..").ok).toBe(true);
	});

	it("SPI:分歧报到 word 级,并说明是哪一侧", () => {
		const r = expectDiff(spiSet, "spi0", "MOSI 03 01");
		expect(r.ok).toBe(false);
		expect(r.message).toContain("MOSI word #2:");
		expect(r.message).toContain("expect  03 01");
		expect(r.message).toContain("actual  03 00");
	});

	it("SPI:期望行必须以 MOSI 或 MISO 开头", () => {
		expect(() => expectDiff(spiSet, "spi0", "03 00")).toThrow(/要以 MOSI 或 MISO 开头/);
	});

	it("其它协议还没有 expect,报得直白", () => {
		const other: AnnDecoder = {
			key: "can0", id: "can", name: "CAN", channels: {}, options: {},
			rows: [{ id: "fields", desc: "Fields", classes: [0] }],
			classes: [{ id: "data", desc: "data" }],
		};
		const set = makeSet([other], [{ s: 1, k: "can0", cls: "data", r: "fields", t: ["x"] }]);
		expect(() => expectDiff(set, "can0", "aa bb")).toThrow(/只支持 I²C \/ UART \/ SPI/);
	});
});

// ─── 第二层:引擎端到端 ─────────────────────────────────────────────────────

describe.skipIf(!HAS_ENGINE)("la 工具端到端(真 yoma-la + demo 夹具)", () => {
	let tool: LaTool;
	let importDetails: LaToolDetails;

	const DECODERS = [
		{ key: "i2c0", id: "1:i2c", channels: { scl: "SCL", sda: "SDA" } },
		{ key: "uart0", id: "1:uart", channels: { rxtx: "UART" }, options: { baudrate: "115200" } },
		{ key: "spi0", id: "1:spi", channels: { clk: "CLK", cs: "CS#", mosi: "MOSI", miso: "MISO" } },
	];

	beforeAll(async () => {
		tool = makeTool().tool;
		const imported = await run(tool, { action: "import", file: DEMO });
		importDetails = imported.details;
		await run(tool, { action: "decode", decoders: DECODERS });
	}, 120_000);

	it("import 注册 .dsl 并给出通道表", async () => {
		expect(importDetails.samplerate).toBe(25_000_000);
		expect(importDetails.samples).toBe(131_072);
		expect(importDetails.channels?.map((c) => c.name).slice(0, 2)).toEqual(["SDA", "SCL"]);
		expect(importDetails.file).toMatch(/capture\.dsl$/);
	});

	it("details 里的预览是 1024 列 × 每通道 256 字节的 base64", () => {
		const preview = importDetails.preview!;
		expect(preview.columns).toBe(1024);
		expect(preview.from).toBe(0);
		expect(preview.to).toBe(131_072);
		expect(Object.keys(preview.rows)).toHaveLength(16);
		for (const [index, b64] of Object.entries(preview.rows)) {
			const buf = Buffer.from(b64, "base64");
			expect(buf.length).toBe(Math.ceil(1024 / 4));
			// 每一列都记了电平,不该有 0
			expect(previewColumns(b64).some((v) => v === 0)).toBe(false);
			expect(Number(index)).toBeGreaterThanOrEqual(0);
		}
	});

	it("summary 报出每通道的边沿数,并给出总线提示", async () => {
		const { text, details } = await run(tool, { action: "summary" });
		expect(text).toContain("D0 SDA            154 edges");
		expect(text).toContain("D1 SCL            510 edges");
		expect(text).toContain("hints:");
		expect(text).toContain("clock-like:");
		const byName = Object.fromEntries((details.channels ?? []).map((c) => [c.name, c.edges]));
		expect(byName.SDA).toBe(154);
		expect(byName.SCL).toBe(510);
	}, 60_000);

	it("decode 三个解码器一次跑完,每个都给聚合摘要", async () => {
		const { tool: fresh } = makeTool();
		await run(fresh, { action: "import", file: DEMO });
		const { text, details } = await run(fresh, { action: "decode", decoders: DECODERS });
		expect(text).toContain("6 txn (12 addr phases, 15 bytes), 0 with issues");
		expect(text).toContain("47 bytes in 3 runs, 0 errors, 0 breaks");
		expect(text).toContain("5 transfers, 288 words");
		const anns = Object.fromEntries((details.decoders ?? []).map((d) => [d.key, d.annotations]));
		expect(anns.i2c0).toBe(300);
		expect(anns.uart0).toBeGreaterThan(0);
		expect(anns.spi0).toBeGreaterThan(0);
	}, 120_000);

	it("events(I²C):首个事务是 W 0x62 <- 04 ; Sr R 0x62 -> 4F", async () => {
		const { text } = await run(tool, { action: "events", decoder: "i2c0" });
		expect(text).toContain("i2c0 TXN#1");
		expect(text).toContain("W 0x62 <- 04 ; Sr R 0x62 -> 4F");
		expect(text).toContain("6 txn (12 addr phases, 15 bytes), 0 with issues");
		expect(text).not.toContain("⚠");
	}, 60_000);

	it("events(UART):47 字节,读得出 DreamSourceLab 那句话", async () => {
		const { text } = await run(tool, { action: "events", decoder: "uart0" });
		expect(text).toContain("47 bytes in 3 runs");
		expect(text).toContain('"DSLogic series U"');
		expect(text).toContain("bit=8.680us");
	}, 60_000);

	it("events(SPI):5 次传输,MOSI/MISO 并排", async () => {
		const { text } = await run(tool, { action: "events", decoder: "spi0" });
		expect(text).toContain("spi0 XFER#1");
		expect(text).toContain("5 transfers, 288 words");
		expect(text).toContain("MOSI 00 11 00 00 79 02");
	}, 60_000);

	it("events 的窗口切在事务中间时,事务仍然是 ok(不是假的 missing STOP)", async () => {
		const { text, details } = await run(tool, { action: "events", decoder: "i2c0", toMs: 2.2 });
		expect(text).toContain("i2c0 TXN#1");
		expect(text).toContain("ok");
		expect(text).not.toContain("missing STOP");
		expect(text).toContain("1 txn (2 addr phases, 2 bytes), 0 with issues");
		expect(details.window).toEqual({ from: 0, to: 55_000 });
	}, 60_000);

	it("timing:SCL 的周期 ≈ 99.60kHz", async () => {
		const { text } = await run(tool, { action: "timing", timingChannels: ["SCL"] });
		expect(text).toContain("D1 SCL        510 edges");
		expect(text).toMatch(/period 10\.0us = 99\.60kHz/);
		expect(text).toContain("duty ");
	}, 60_000);

	it("expect:对上给 MATCH,对不上给第一处分歧", async () => {
		const ok = await run(tool, { action: "expect", decoder: "i2c0", expect: "W 0x62 04\nR 0x62 4F" });
		expect(ok.text).toContain("MATCH 2/2");
		expect(ok.details.issues).toBe(0);

		const bad = await run(tool, { action: "expect", decoder: "i2c0", expect: "W 0x62 05" });
		expect(bad.text).toContain("MISMATCH at #1");
		expect(bad.text).toContain("actual  W 0x62 04");
		expect(bad.details.issues).toBe(1);

		const uart = await run(tool, { action: "expect", decoder: "uart0", expect: '"DSLogic series USB-based LA from DreamSourceLab"' });
		expect(uart.text).toContain("MATCH 47 bytes");
	}, 60_000);

	it("list 列出已注册的采集和它解过的解码器", async () => {
		const { text } = await run(tool, { action: "list" });
		expect(text).toMatch(/1 captures in .*[\\/]\.yoma[\\/]la/);
		expect(text).toContain("131,072 samples @ 25.000MHz");
		expect(text).toContain("import");
		expect(text).toContain("decoded: i2c0,uart0,spi0");
	}, 60_000);

	it("decode 用错通道名时把可选的通道全列出来", async () => {
		await expect(
			run(tool, { action: "decode", decoders: [{ key: "bad", id: "1:i2c", channels: { scl: "SCK", sda: "SDA" } }] }),
		).rejects.toThrow(/bad\.scl="SCK" — no such channel in this capture \(have: D0=SDA D1=SCL/);
	}, 60_000);

	it("没解码就问 events 时,说的是「还没解码」而不是空结果", async () => {
		const { tool: fresh } = makeTool();
		await run(fresh, { action: "import", file: DEMO });
		await expect(run(fresh, { action: "events" })).rejects.toThrow(/is not decoded yet/);
	}, 60_000);

	it("一个采集都没有时,events 让人先去采集", async () => {
		const { tool: fresh } = makeTool();
		await expect(run(fresh, { action: "events" })).rejects.toThrow(/no capture yet/);
	});

	it("stop 在没有武装时也不报错", async () => {
		const { tool: fresh } = makeTool();
		const { text } = await run(fresh, { action: "stop" });
		expect(text).toContain("nothing armed");
	});

	it("采集参数写错时在下子进程之前就拦住", async () => {
		const { tool: fresh } = makeTool();
		await expect(run(fresh, { action: "capture", samples: "lots" })).rejects.toThrow(/write it like "1M" or "200k"/);
		await expect(run(fresh, { action: "capture", samplerate: "quick" })).rejects.toThrow(/write it like "25M" or "500k"/);
		await expect(run(fresh, { action: "capture", trigger: { "1": "up" } })).rejects.toThrow(/use r \/ f \/ c \/ 0 \/ 1 \/ x/);
	});

	it("decoders 给解码器目录(通道名/选项名从这里查,不许猜);list 没采集时指过去", async () => {
		const { tool: fresh } = makeTool();
		const listed = await run(fresh, { action: "list" });
		expect(listed.text).toContain("no captures yet");
		expect(listed.text).toContain("la decoders");
		const { text } = await run(fresh, { action: "decoders" });
		expect(text).toMatch(/^\d+ decoders \(channels; \[optional\]; option=default\)/);
		expect(text).toContain("1:i2c");
		expect(text).toContain("1:uart");
		expect(text).toContain("1:spi");
		const one = await run(fresh, { action: "decoders", decoder: "1:uart" });
		expect(one.text).toContain("rxtx");
		expect(one.text).toContain("baudrate");
	}, 120_000);

	it("arm → collect:先武装再收,收到的和直接 capture 同形状", async () => {
		const { tool: fresh } = makeTool();
		const armed = await run(fresh, { action: "arm", device: "demo", samples: "200k", samplerate: "25M", channels: [{ index: 0, name: "SDA" }, { index: 1, name: "SCL" }] });
		expect(armed.text).toMatch(/^armed la-/);
		expect(armed.details.armed).toBe(true);
		// 武装期间不许再武装
		await expect(run(fresh, { action: "arm", device: "demo" })).rejects.toThrow(/already armed/);
		const got = await run(fresh, { action: "collect" });
		expect(got.details.captureId).toBe(armed.details.captureId);
		expect(got.details.samples).toBeGreaterThan(0);
		expect(got.details.channels?.map((c) => c.name)).toEqual(["SDA", "SCL"]);
		// 收完就不再有武装的了
		const after = await run(fresh, { action: "stop" });
		expect(after.text).toContain("nothing armed");
	}, 180_000);

	it("capture device=demo:采到数据,并且能接着解码", async () => {
		const { tool: fresh } = makeTool();
		const cap = await run(fresh, {
			action: "capture",
			device: "demo",
			samples: "200k",
			samplerate: "25M",
			channels: [{ index: 0, name: "SDA" }, { index: 1, name: "SCL" }],
		});
		expect(cap.text).toContain("capture ");
		expect(cap.text).toContain("channels: D0=SDA D1=SCL");
		expect(cap.details.captureId).toMatch(/^la-\d{8}-\d{9}$/);
		expect(cap.details.samples).toBeGreaterThan(0);
		expect(cap.details.timedOut).toBe(false);
		expect(cap.details.channels?.map((c) => c.name)).toEqual(["SDA", "SCL"]);
		expect(Object.keys(cap.details.preview?.rows ?? {})).toEqual(["0", "1"]);

		const dec = await run(fresh, { action: "decode", decoders: [{ key: "i2c0", id: "1:i2c", channels: { scl: "SCL", sda: "SDA" } }] });
		expect(dec.text).toContain("txn");
		const ev = await run(fresh, { action: "events", decoder: "i2c0" });
		expect(ev.text).toContain("i2c0 TXN#1");
		expect(ev.text).toContain("W 0x62 <- 04");

		const list = await run(fresh, { action: "list" });
		expect(list.text).toContain(cap.details.captureId!);
	}, 180_000);
});
