/**
 * 示波器核心库(src/core/scope)的测试,分三层:
 *
 * 1. 纯函数 —— 地址解析、块头/图片分帧、WAVEDESC 与电压/时间换算、统计与文本示意图、落盘布局。
 *    断言全是确定值,夹具是**真机**(Siglent SDS824X HD,固件 4.8.12.1.1.6.5)抓下来的原始字节。
 * 2. SCPI 客户端 —— 对着 FakeSds(test/fixtures/scope/fake-sds.ts)跑真 TCP:跨 TCP 段分帧、
 *    并发查询串行化、超时之后的 dirty 排空(迟到的答案不许串位)、错误队列。
 * 3. 驱动 —— SiglentScope 对着同一台假机:设了就读回、非法值要说人话、分段读波形、量测、截图。
 *
 * 夹具的既知真值(全部核对过真机字节):
 *  - preamble.bin:块头 `#9000000346` + 346 字节 WAVEDESC + 换行。commType 1(WORD)、
 *    gain 0.005 V/div(BNC 口,不含探头)、cpd 7680、probe 10、horizInterval 5e-10 s、
 *    horizOffset 3.17e-7 s、timebaseEnum 7(50 ns/div)、couplingEnum 1(AC)。
 *  - wave_c1_word_1000.bin:1000 个小端 int16,首点 2720,min -1888 / max 2784 → max 18.125 mV。
 *  - wave_c1_byte_1000.bin:同一次采集的 BYTE 版,就是 WORD 版的高字节(算术右移 8 位)。
 *  - screen.png:一整幅 PNG。**文件 25350 字节,但图只有 25349** —— 末尾那个换行是仪器的行尾,
 *    不是图的一部分,pngComplete 认的是 25349(客户端随后 skipNewlines 把它吃掉)。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	asciiPlot,
	envelope,
	findEdges,
	parseNumber,
	si,
	waveStats,
} from "../src/core/scope/analyze.ts";
import {
	COUPLING_ENUM,
	TIMEBASE_ENUM,
	WAVEDESC_LENGTH,
	codeToVolts,
	codesToVolts,
	decodeSamples,
	effectiveCodePerDiv,
	indexOfTime,
	parseWaveDesc,
	timeOfIndex,
	type VoltScale,
	voltScaleOf,
} from "../src/core/scope/preamble.ts";
import {
	type ScpiClient,
	ScpiTimeoutError,
	bmpComplete,
	findBlockHeader,
	formatScpiAddress,
	openScpi,
	parseScpiAddress,
	pngComplete,
} from "../src/core/scope/scpi.ts";
import { SiglentScope, fmt, normalizeChannel, normalizeSource, parseIdn } from "../src/core/scope/siglent.ts";
import {
	CAPTURE_JSON,
	SCOPE_CONFIG_FILE,
	SCOPE_DIR,
	SCOPE_SCREENS_DIR,
	type ScopeCaptureMeta,
	listCaptures,
	readCaptureMeta,
	readChannelCodes,
	readScopeConfig,
	writeCapture,
	writeScopeConfig,
} from "../src/core/scope/store.ts";
import { scope as scopeNamespace } from "../src/index.ts";
import { FakeSds, PREAMBLE_RESPONSE, SCREEN_PNG, SCREEN_PNG_FILE, defaultSquare, nr3 } from "./fixtures/scope/fake-sds.ts";

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "fixtures", "scope");
const enc = (s: string) => new TextEncoder().encode(s);

const tempDirs: string[] = [];
function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 夹具字节(测试进程里读一次)。 */
const WORD_RESPONSE = new Uint8Array(await readFile(join(FIXTURES, "wave_c1_word_1000.bin")));
const BYTE_RESPONSE = new Uint8Array(await readFile(join(FIXTURES, "wave_c1_byte_1000.bin")));

function blockPayload(response: Uint8Array): Uint8Array {
	const header = findBlockHeader(response);
	if (!header) throw new Error("夹具里没有块头");
	const at = header.start + 2 + header.digits;
	return response.subarray(at, at + header.length);
}

const DESC = parseWaveDesc(blockPayload(PREAMBLE_RESPONSE));

// ─── 1. 纯函数 ───────────────────────────────────────────────────────────────

describe("地址解析", () => {
	it("认 usb / usb:序列号 / ip / ip:port / 主机名", () => {
		expect(parseScpiAddress("usb")).toEqual({ kind: "usb", serial: undefined });
		expect(parseScpiAddress("USB:SDS08A0D910802")).toEqual({ kind: "usb", serial: "SDS08A0D910802" });
		expect(parseScpiAddress("192.168.1.20")).toEqual({ kind: "tcp", host: "192.168.1.20", port: 5025 });
		expect(parseScpiAddress(" 192.168.1.20:1234 ")).toEqual({ kind: "tcp", host: "192.168.1.20", port: 1234 });
		expect(parseScpiAddress("scope.local")).toEqual({ kind: "tcp", host: "scope.local", port: 5025 });
		expect(parseScpiAddress("tcp://10.0.0.5:5025")).toEqual({ kind: "tcp", host: "10.0.0.5", port: 5025 });
		// IPv6 必须写成 [addr]:port,不然裸冒号没法和端口分家
		expect(parseScpiAddress("[fe80::1]:5025")).toEqual({ kind: "tcp", host: "fe80::1", port: 5025 });
	});

	it("坏地址抛人话", () => {
		expect(() => parseScpiAddress("")).toThrow(/empty address/);
		expect(() => parseScpiAddress("hello world")).toThrow(/cannot parse address/);
		// 注意:守卫只在最后一段不是数字时才响。"fe80::1" 会被正则拆成 host "fe80:" + port 1
		// 并**静默**返回一个连不上的地址 —— 那是 scpi.ts 的洞,已写进报告,这里钉住会响的那半。
		expect(() => parseScpiAddress("fe80::abcd")).toThrow(/IPv6 must be written/);
		expect(() => parseScpiAddress("192.168.1.20:99999")).toThrow(/bad port/);
	});

	it("formatScpiAddress 与 parseScpiAddress 互逆", () => {
		for (const text of ["usb", "usb:SDS08A0D910802", "192.168.1.20:5025", "scope.local:5025"]) {
			expect(formatScpiAddress(parseScpiAddress(text))).toBe(text.replace(/^USB/, "usb"));
		}
	});
});

describe("块头与图片分帧", () => {
	it("findBlockHeader:裸块 / 带 C1:WF 前缀 / #0 / 半截块头", () => {
		expect(findBlockHeader(enc("#42000abc"))).toEqual({ start: 0, digits: 4, length: 2000 });
		// 无波形时真机会在块前吐一段旧式前缀
		expect(findBlockHeader(enc("C1:WF #42000abc"))).toEqual({ start: 6, digits: 4, length: 2000 });
		// `#0` 是不定长块,不支持:跳过它继续往后找
		expect(findBlockHeader(enc("#0ABCDEFG"))).toBeUndefined();
		expect(findBlockHeader(enc("#0 #3123xyz"))).toEqual({ start: 3, digits: 3, length: 123 });
		// 位数还没到齐 → 还不能下结论
		expect(findBlockHeader(enc("#9000"))).toBeUndefined();
		expect(findBlockHeader(enc("#"))).toBeUndefined();
		expect(findBlockHeader(enc("no block here at all"))).toBeUndefined();
	});

	it("findBlockHeader 认得真机 preamble 的 #9000000346", () => {
		expect(findBlockHeader(PREAMBLE_RESPONSE)).toEqual({ start: 0, digits: 9, length: 346 });
		expect(PREAMBLE_RESPONSE.length).toBe(11 + 346 + 1);
		expect(findBlockHeader(WORD_RESPONSE)).toEqual({ start: 0, digits: 4, length: 2000 });
		expect(findBlockHeader(BYTE_RESPONSE)).toEqual({ start: 0, digits: 4, length: 1000 });
	});

	it("pngComplete:整幅给长度、半幅给 undefined、不是 PNG 就抛", () => {
		// 文件 25350 字节,图 25349 —— 多出来的那个字节是仪器的行尾换行
		expect(SCREEN_PNG_FILE.length).toBe(25350);
		expect(pngComplete(SCREEN_PNG_FILE)).toBe(25349);
		expect(SCREEN_PNG.length).toBe(25349);
		expect(pngComplete(SCREEN_PNG)).toBe(25349);
		for (const n of [7, 8, 100, 20000, 25348]) expect(pngComplete(SCREEN_PNG.subarray(0, n))).toBeUndefined();
		expect(() => pngComplete(enc("<html>not an image</html>"))).toThrow(/expected a PNG image/);
	});

	it("bmpComplete:头两个字节 BM + 偏移 2 的小端总长", () => {
		const bmp = new Uint8Array(30);
		bmp[0] = 0x42;
		bmp[1] = 0x4d;
		new DataView(bmp.buffer).setUint32(2, 30, true);
		expect(bmpComplete(bmp)).toBe(30);
		expect(bmpComplete(bmp.subarray(0, 29))).toBeUndefined();
		expect(bmpComplete(bmp.subarray(0, 5))).toBeUndefined();
		expect(() => bmpComplete(enc("PNGish"))).toThrow(/expected a BMP/);
	});
});

describe("WAVEDESC 与换算", () => {
	it("真机 preamble 的每个字段", () => {
		expect(WAVEDESC_LENGTH).toBe(346);
		expect(DESC.commType).toBe(1);
		// COMM_ORDER 报 0(HIFIRST)而数据其实是小端 —— 这个字段不能信,只钉住它确实是 0
		expect(DESC.commOrder).toBe(0);
		expect(DESC.descriptorLength).toBe(346);
		expect(DESC.waveArray1Bytes).toBe(2000);
		expect(DESC.instrument).toBe("Siglent SDS");
		expect(DESC.waveArrayCount).toBe(1000);
		expect(DESC.firstPoint).toBe(0);
		expect(DESC.sparsing).toBe(1);
		expect(DESC.verticalGain).toBeCloseTo(0.005, 9);
		expect(DESC.verticalOffset).toBe(0);
		expect(DESC.codePerDiv).toBe(7680);
		// NOMINAL_BITS 报 16,不是 ADC 的 12 位
		expect(DESC.nominalBits).toBe(16);
		// float32,只能按相对误差比
		expect(DESC.horizInterval / 5e-10).toBeCloseTo(1, 6);
		expect(DESC.horizOffset).toBeCloseTo(3.17e-7, 15);
		expect(DESC.vertUnit).toBe("V");
		expect(DESC.horUnit).toBe("S");
		expect(DESC.timebaseEnum).toBe(7);
		expect(TIMEBASE_ENUM[DESC.timebaseEnum]).toBe(50e-9);
		expect(DESC.couplingEnum).toBe(1);
		expect(COUPLING_ENUM[DESC.couplingEnum]).toBe("AC");
		expect(DESC.probe).toBe(10);
		expect(DESC.fixedVertGainEnum).toBe(10);
		expect(DESC.bwLimitEnum).toBe(0);
		expect(DESC.waveSourceEnum).toBe(0);
	});

	it("坏 preamble 抛人话", () => {
		expect(() => parseWaveDesc(new Uint8Array(100))).toThrow(/preamble is 100 bytes/);
		expect(() => parseWaveDesc(new Uint8Array(WAVEDESC_LENGTH))).toThrow(/does not start with WAVEDESC/);
	});

	it("effectiveCodePerDiv:WORD 用 7680,BYTE 要除 256", () => {
		expect(effectiveCodePerDiv(DESC)).toBe(7680);
		expect(effectiveCodePerDiv({ ...DESC, commType: 0 })).toBe(7680 / 256);
		// nominalBits 真是 8 位时说明 cpd 已经是字节域的,不再除
		expect(effectiveCodePerDiv({ commType: 0, codePerDiv: 30, nominalBits: 8 })).toBe(30);
	});

	it("WORD 夹具:1000 点、首点 2720、max 18.125 mV", () => {
		const codes = decodeSamples(blockPayload(WORD_RESPONSE), 1);
		expect(codes).toBeInstanceOf(Int16Array);
		expect(codes.length).toBe(1000);
		expect(Array.from(codes.subarray(0, 12))).toEqual([2720, 2656, 2592, 2576, 2512, 2448, 2384, 2384, 2384, 2272, 2112, 2032]);
		expect(Math.min(...codes)).toBe(-1888);
		expect(Math.max(...codes)).toBe(2784);
		const scale = voltScaleOf(DESC);
		expect(scale).toEqual({ gain: DESC.verticalGain, offset: 0, codePerDiv: 7680, probe: 10 });
		// volts = code x (gain/cpd) x probe = code x 6.5104e-6
		expect(codeToVolts(1, scale)).toBeCloseTo(6.5104e-6, 10);
		expect(codeToVolts(2784, scale)).toBeCloseTo(0.018125, 9);
		const volts = codesToVolts(codes, scale);
		expect(volts.length).toBe(1000);
		expect(volts[0]).toBeCloseTo(0.01770833, 8);
	});

	it("BYTE 夹具就是 WORD 的高字节,换算后差不超过一个字节量化步", () => {
		const word = decodeSamples(blockPayload(WORD_RESPONSE), 1) as Int16Array;
		const byte = decodeSamples(blockPayload(BYTE_RESPONSE), 0);
		expect(byte).toBeInstanceOf(Int8Array);
		expect(byte.length).toBe(1000);
		expect(Array.from(byte.subarray(0, 12))).toEqual([10, 10, 10, 10, 9, 9, 9, 9, 9, 8, 8, 7]);
		expect(Math.min(...byte)).toBe(-8);
		expect(Math.max(...byte)).toBe(10);
		for (let i = 0; i < word.length; i++) expect(byte[i]).toBe(word[i]! >> 8);

		const wordScale = voltScaleOf(DESC);
		const byteScale = voltScaleOf({ ...DESC, commType: 0 });
		expect(byteScale.codePerDiv).toBe(30);
		expect(codeToVolts(10, byteScale)).toBeCloseTo(0.0166667, 6);
		const quantum = (DESC.verticalGain / 30) * 10;
		const vw = codesToVolts(word, wordScale);
		const vb = codesToVolts(byte, byteScale);
		for (let i = 0; i < word.length; i++) expect(Math.abs(vw[i]! - vb[i]!)).toBeLessThan(quantum);
	});

	it("时间轴:t[0] = delay - tdiv x 5,indexOfTime 是它的逆", () => {
		const time = { delay: 3.17e-7, tdiv: 50e-9, interval: 5e-10, grid: 10 };
		expect(timeOfIndex(0, time)).toBeCloseTo(3.17e-7 - 5 * 50e-9, 15);
		expect(timeOfIndex(1, time) - timeOfIndex(0, time)).toBeCloseTo(5e-10, 18);
		expect(indexOfTime(timeOfIndex(0, time), time)).toBeCloseTo(0, 6);
		expect(indexOfTime(timeOfIndex(137, time), time)).toBeCloseTo(137, 6);
		// grid 默认 10
		expect(timeOfIndex(0, { delay: 0, tdiv: 1e-3, interval: 1e-6 })).toBeCloseTo(-5e-3, 12);
	});
});

describe("波形分析", () => {
	/** 1 kHz、50% 占空、±1 V 的方波:interval 1us、周期 1000 点、8 个周期。 */
	const SQUARE_SCALE: VoltScale = { gain: 1, offset: 0, codePerDiv: 1000, probe: 1 };
	const INTERVAL = 1e-6;
	const square = new Int16Array(8000);
	for (let i = 0; i < square.length; i++) square[i] = i % 1000 < 500 ? 1000 : -1000;

	it("方波:freq / duty / pp / rise / fall", () => {
		const s = waveStats(square, SQUARE_SCALE, INTERVAL);
		expect(s.min).toBeCloseTo(-1, 9);
		expect(s.max).toBeCloseTo(1, 9);
		expect(s.pp).toBeCloseTo(2, 9);
		expect(s.mean).toBeCloseTo(0, 9);
		expect(s.rms).toBeCloseTo(1, 9);
		expect(s.freq).toBeDefined();
		expect(Math.abs(s.freq! - 1000) / 1000).toBeLessThan(0.01);
		expect(s.period).toBeCloseTo(1e-3, 9);
		expect(s.duty).toBeCloseTo(0.5, 6);
		// 上升沿 8 条 + 下降沿 7 条(首点已经是高电平,第一条边沿是下降)
		expect(s.edges).toBe(15);
		// 理想台阶:10%-90% 只跨插值出来的 0.8 个点
		expect(s.rise).toBeDefined();
		expect(s.fall).toBeDefined();
		expect(s.rise!).toBeLessThan(INTERVAL);
		expect(s.fall!).toBeLessThan(INTERVAL);
		expect(s.rise!).toBeGreaterThan(0);
	});

	it("findEdges:中值 + 滞回,limit 生效", () => {
		const all = findEdges(square, 0, 200);
		expect(all.length).toBe(15);
		expect(all[0]!.rising).toBe(false);
		expect(all[0]!.index).toBeCloseTo(499.5, 6);
		expect(all[1]!.rising).toBe(true);
		expect(all[1]!.index).toBeCloseTo(999.5, 6);
		expect(findEdges(square, 0, 200, 3).length).toBe(3);
	});

	it("正弦:频率对得上", () => {
		const sine = new Int16Array(2000);
		for (let i = 0; i < sine.length; i++) sine[i] = Math.round(900 * Math.sin(2 * Math.PI * 10_000 * i * INTERVAL));
		const s = waveStats(sine, SQUARE_SCALE, INTERVAL);
		expect(s.freq).toBeDefined();
		expect(Math.abs(s.freq! - 10_000) / 10_000).toBeLessThan(0.01);
		expect(s.pp).toBeCloseTo(1.8, 2);
	});

	it("平直 + 微噪:不硬找边沿(pp <= 8 code 直接当噪声)", () => {
		const flat = new Int16Array(4000);
		for (let i = 0; i < flat.length; i++) flat[i] = (i % 3) - 1;
		const s = waveStats(flat, SQUARE_SCALE, INTERVAL);
		expect(s.edges).toBe(0);
		expect(s.freq).toBeUndefined();
		expect(s.period).toBeUndefined();
		expect(s.duty).toBeUndefined();
		expect(s.pp).toBeCloseTo(2e-3, 9);
	});

	it("空数组不炸", () => {
		expect(waveStats(new Int16Array(0), SQUARE_SCALE, INTERVAL)).toEqual({ min: 0, max: 0, pp: 0, mean: 0, rms: 0, edges: 0 });
	});

	it("envelope:列数按请求给,点数不够时退到点数", () => {
		const env = envelope(square, 40);
		expect(env.min.length).toBe(40);
		expect(env.max.length).toBe(40);
		expect(Math.min(...env.min)).toBe(-1000);
		expect(Math.max(...env.max)).toBe(1000);
		expect(envelope(square.subarray(0, 7), 40).min.length).toBe(7);
		expect(envelope(new Int16Array(0), 40).min.length).toBe(1);
	});

	it("asciiPlot:height 行图 + 轴 + 刻度 + 标题", () => {
		const time = { delay: 0, tdiv: 1e-3, interval: INTERVAL, grid: 10 };
		const plot = asciiPlot(square, SQUARE_SCALE, time, { width: 40, height: 6, label: "C1 SDA" });
		const lines = plot.split("\n");
		expect(lines[0]).toBe("C1 SDA");
		// 标题 + 6 行图 + 轴 + 刻度
		expect(lines.length).toBe(6 + 3);
		expect(lines.filter((l) => l.includes("│")).length).toBe(6);
		expect(plot).toContain("└");
		expect(plot).toContain("█");
		expect(plot).toContain("1 V");
		expect(asciiPlot(new Int16Array(0), SQUARE_SCALE, time, { label: "C1" })).toBe("C1 (no samples)");
	});

	it("si:SI 前缀", () => {
		expect(si(0.05, "V")).toBe("50 mV");
		expect(si(2e9, "Sa/s").startsWith("2 G")).toBe(true);
		expect(si(3.17e-7, "s")).toBe("317 ns");
		expect(si(0, "V")).toBe("0 V");
		expect(si(-1.5, "V")).toBe("-1.5 V");
		expect(si(1e-11, "s")).toBe("10 ps");
	});

	it("parseNumber:NR3 / 四星 / 带前缀", () => {
		expect(parseNumber("5.00E-02")).toBe(0.05);
		expect(parseNumber("****")).toBeNull();
		expect(parseNumber("INR 8192")).toBe(8192);
		expect(parseNumber(" -1.2500E+01 ")).toBe(-12.5);
		expect(parseNumber("")).toBeNull();
		expect(parseNumber("Stop")).toBeNull();
	});
});

describe("落盘", () => {
	function meta(id: string, createdAt: number): ScopeCaptureMeta {
		return {
			id,
			createdAt,
			address: "127.0.0.1:5025",
			model: "SDS824X HD",
			serial: "SDS08A0D910802",
			mode: "current",
			timebase: { scale: 5e-8, delay: 0 },
			sampleRate: 2e9,
			interval: 5e-10,
			stride: 1,
			recordPoints: 1000,
			mdepth: "10K",
			trigger: { mode: "AUTO", source: "C1", level: 0, slope: "RISING", status: "Stop" },
			channels: [
				{ ch: 1, file: "c1.i16", points: 1000, vdiv: 0.05, offset: 0, coupling: "AC", probe: 10, unit: "V", gain: 0.005, rawOffset: 0, codePerDiv: 7680 },
			],
		};
	}

	it("写 → 列 → 读,int16 原样回来", async () => {
		const project = createTempDir();
		const codes = decodeSamples(blockPayload(WORD_RESPONSE), 1) as Int16Array;
		const dir = join(project, SCOPE_DIR, "20260903-120000");
		await writeCapture(dir, meta("20260903-120000", 1_756_900_000_000), new Map([[1, codes]]));

		const back = await readCaptureMeta(dir);
		expect(back.id).toBe("20260903-120000");
		expect(back.channels[0]!.codePerDiv).toBe(7680);
		const read = await readChannelCodes(dir, back.channels[0]!);
		expect(read.length).toBe(1000);
		expect([...read]).toEqual([...codes]);
		// capture.json 就在目录里,目录本身就是索引
		expect(await readFile(join(dir, CAPTURE_JSON), "utf8")).toContain('"recordPoints"');
	});

	it("listCaptures:最新在前,跳过 screens/ 和不是采集的目录", async () => {
		const project = createTempDir();
		const root = join(project, SCOPE_DIR);
		const codes = new Int16Array([1, -1, 2, -2]);
		await writeCapture(join(root, "old"), meta("old", 1000), new Map([[1, codes]]));
		await writeCapture(join(root, "new"), meta("new", 2000), new Map([[1, codes]]));
		mkdirSync(join(root, SCOPE_SCREENS_DIR), { recursive: true });
		writeFileSync(join(root, SCOPE_SCREENS_DIR, "shot.png"), "not a capture");
		mkdirSync(join(root, "junk"), { recursive: true });

		const list = await listCaptures(project);
		expect(list.map((c) => c.id)).toEqual(["new", "old"]);
		expect(list[0]!.dir).toBe(join(root, "new"));
		// 没有 .yoma/scope 的工程给空表,不抛
		expect(await listCaptures(createTempDir())).toEqual([]);
	});

	it("scope.json:读写往返,坏文件当没有", async () => {
		const project = createTempDir();
		expect(await readScopeConfig(project)).toBeUndefined();
		await writeScopeConfig(project, { address: "192.168.1.20:5025" });
		expect(await readScopeConfig(project)).toEqual({ address: "192.168.1.20:5025" });
		expect(await readFile(join(project, SCOPE_CONFIG_FILE), "utf8")).toContain("192.168.1.20");
		writeFileSync(join(project, SCOPE_CONFIG_FILE), "{ not json");
		expect(await readScopeConfig(project)).toBeUndefined();
		writeFileSync(join(project, SCOPE_CONFIG_FILE), '{"address":""}');
		expect(await readScopeConfig(project)).toBeUndefined();
	});
});

describe("包根的命名空间导出", () => {
	it("scope 这一坨能从 src/index.ts 拿到", () => {
		expect(typeof scopeNamespace.parseScpiAddress).toBe("function");
		expect(typeof scopeNamespace.waveStats).toBe("function");
		expect(typeof scopeNamespace.SiglentScope).toBe("function");
		expect(scopeNamespace.WAVEDESC_LENGTH).toBe(346);
	});
});

// ─── 2. SCPI 客户端 ──────────────────────────────────────────────────────────

describe("ScpiClient(对着假 SDS 跑真 TCP)", () => {
	let plain: FakeSds;
	let chunky: FakeSds;
	const clients: ScpiClient[] = [];

	beforeAll(async () => {
		plain = await FakeSds.start();
		// 每条响应切成 40 字节一段:逼客户端跨 TCP 段拼行、拼块
		chunky = await FakeSds.start({ chunkBytes: 40, chunkDelayMs: 1 });
	});

	afterAll(async () => {
		for (const c of clients) await c.close().catch(() => undefined);
		await plain.close();
		await chunky.close();
	});

	async function connect(fake: FakeSds): Promise<ScpiClient> {
		const client = await openScpi(parseScpiAddress(fake.address));
		clients.push(client);
		return client;
	}

	it("文本查询", async () => {
		const client = await connect(plain);
		expect(await client.query("*IDN?")).toBe(plain.idn);
		expect(await client.query(":TIMebase:SCALe?")).toBe(nr3(plain.timebase.scale));
		expect(client.label).toBe(plain.address);
	});

	it("跨 TCP 段分帧:文本行与二进制块都能拼回来", async () => {
		const client = await connect(chunky);
		expect(await client.query("*IDN?")).toBe(chunky.idn);
		const block = await client.queryBlock(":WAVeform:PREamble?");
		expect(block.length).toBe(346);
		expect(parseWaveDesc(block).instrument).toBe("Siglent SDS");
		expect(parseWaveDesc(block).waveArrayCount).toBe(1000);
	});

	it("裸图查询(PRINt? 没有块头,靠 pngComplete 判完)", async () => {
		const client = await connect(plain);
		const png = await client.queryRaw(":PRINt? PNG", pngComplete);
		expect(png.length).toBe(SCREEN_PNG.length);
		expect(Buffer.from(png).equals(Buffer.from(SCREEN_PNG))).toBe(true);
	});

	it("并发查询按发出顺序串行,不串位", async () => {
		const client = await connect(plain);
		plain.clearLog();
		const commands = ["*IDN?", ":TIMebase:SCALe?", ":CHANnel1:SWITch?", ":ACQuire:SRATe?", ":TRIGger:EDGE:SOURce?"];
		const answers = await Promise.all(commands.map((c) => client.query(c)));
		expect(answers).toEqual([plain.idn, nr3(plain.timebase.scale), "ON", nr3(plain.sampleRate), "C1"]);
		expect(plain.log).toEqual(commands);
	});

	it("查询超时 → ScpiTimeoutError;迟到的答案由 dirty 排空吃掉,下一条查询不串位", async () => {
		const client = await connect(plain);
		plain.hang("*IDN?");
		await expect(client.query("*IDN?", { timeoutMs: 150 })).rejects.toBeInstanceOf(ScpiTimeoutError);
		// 仪器晚了一步才回 —— 这条答案还堵在队列里
		plain.releaseHung();
		// 下一条查询必须先排空,拿到的是自己的答案而不是上一条的
		expect(await client.query(":ACQuire:SRATe?")).toBe(nr3(plain.sampleRate));
	});

	it("超时的错误消息带上是哪条命令", async () => {
		const client = await connect(plain);
		plain.hang(":TRIGger:MODE?");
		await expect(client.query(":TRIGger:MODE?", { timeoutMs: 120 })).rejects.toThrow(/query :TRIGger:MODE\?/);
		plain.releaseHung();
		await client.drain(120);
	});

	it("drain 把残留字节数报出来", async () => {
		const client = await connect(plain);
		plain.hang("*IDN?");
		await expect(client.query("*IDN?", { timeoutMs: 120 })).rejects.toBeInstanceOf(ScpiTimeoutError);
		// 迟到的字节要落在 drain 的读窗口里才会被算进 dropped:先 sleep 的话它们会被
		// transport.clear() 悄悄丢掉、报 0(见报告里 drainLocked 的漏计)。
		plain.releaseHung();
		expect(await client.drain(200)).toBeGreaterThan(0);
	});

	it("checkError:认得 -113 / -224,没错时给 undefined", async () => {
		const client = await connect(plain);
		await client.command("*CLS");
		expect(await client.checkError()).toBeUndefined();
		await client.command(":NOSUCH:THING 1");
		expect(await client.checkError()).toEqual({ code: -113, message: "Undefined header;:NOSUCH:THING 1" });
		await client.command(":CHANnel1:COUPling BANANA");
		expect(await client.checkError()).toEqual({ code: -224, message: "Illegal parameter value" });
		expect(await client.checkError()).toBeUndefined();
	});

	it("command 只写不读", async () => {
		const client = await connect(plain);
		plain.clearLog();
		await client.command(":TIMebase:DELay 1E-6");
		// command() 写完就返回,对面收没收到要另拿一条查询冲一下
		expect(await client.query("*OPC?")).toBe("1");
		expect(plain.log).toEqual([":TIMebase:DELay 1E-6", "*OPC?"]);
		expect(plain.timebase.delay).toBe(1e-6);
		// 只写的那条没有占用响应队列,下一条查询拿到的还是自己的答案
		expect(await client.query("*IDN?")).toBe(plain.idn);
		await client.command(":TIMebase:DELay 0");
	});

	it("close 之后再用就报连接已关", async () => {
		const client = await openScpi(parseScpiAddress(plain.address));
		expect(await client.query("*IDN?")).toBe(plain.idn);
		await client.close();
		await expect(client.query("*IDN?")).rejects.toThrow(/closed/);
		await client.close(); // 幂等
	});
});

// ─── 3. 驱动 ─────────────────────────────────────────────────────────────────

describe("SiglentScope 的纯函数", () => {
	it("normalizeChannel", () => {
		expect(normalizeChannel(1)).toBe(1);
		expect(normalizeChannel("C3")).toBe(3);
		expect(normalizeChannel("ch4")).toBe(4);
		expect(() => normalizeChannel(0)).toThrow(/use 1\.\.4/);
		expect(() => normalizeChannel("C5")).toThrow(/use 1\.\.4/);
		expect(() => normalizeChannel("SDA")).toThrow(/use 1\.\.4/);
	});

	it("normalizeSource:EXT 要直说这台机器没有外触发", () => {
		expect(normalizeSource("c2")).toBe("C2");
		expect(normalizeSource("CH4")).toBe("C4");
		expect(normalizeSource("line")).toBe("LINE");
		expect(normalizeSource("ACLINE")).toBe("LINE");
		expect(() => normalizeSource("EXT")).toThrow(/no external trigger input/);
		expect(() => normalizeSource("EX5")).toThrow(/no external trigger/);
		expect(() => normalizeSource("D0")).toThrow(/use C1\.\.C4 or LINE/);
	});

	it("parseIdn", () => {
		expect(parseIdn("Siglent Technologies,SDS824X HD,SDS08A0D910802,4.8.12.1.1.6.5")).toEqual({
			vendor: "Siglent Technologies",
			model: "SDS824X HD",
			serial: "SDS08A0D910802",
			firmware: "4.8.12.1.1.6.5",
		});
		expect(parseIdn("junk")).toEqual({ vendor: "junk", model: "", serial: "", firmware: "" });
	});

	it("fmt:整数原样,其余大写 E 记法", () => {
		expect(fmt(10)).toBe("10");
		expect(fmt(0)).toBe("0");
		expect(fmt(0.1)).toBe("0.1");
		expect(fmt(0.005)).toBe("0.005");
		expect(fmt(5e-8)).toBe("5E-8");
		expect(fmt(3.17e-7)).toBe("3.17E-7");
		expect(fmt(-1.5)).toBe("-1.5");
	});
});

describe("SiglentScope(对着假 SDS)", () => {
	let fake: FakeSds;
	let scope: SiglentScope;

	beforeAll(async () => {
		// MAXPoint 调到 300:1000 点的记录必须分 4 段读,分段逻辑才被真的走到
		fake = await FakeSds.start({ recordPoints: 1000, maxPoint: 300 });
		scope = await SiglentScope.open(fake.address);
	});

	afterAll(async () => {
		await scope.close();
		await fake.close();
	});

	/** 把在飞的只写命令冲到假机那边:command() 写完就返回,日志落在另一头。 */
	const flush = () => scope.raw("*OPC?");

	it("open:*IDN? 拆成四段身份", () => {
		expect(scope.identity).toEqual({
			vendor: "Siglent Technologies",
			model: "SDS824X HD",
			serial: "SDS08A0D910802",
			firmware: "4.8.12.1.1.6.5",
		});
		expect(scope.label).toBe(fake.address);
		expect(scope.address).toEqual({ kind: "tcp", host: "127.0.0.1", port: fake.port });
	});

	it("open:不是 Siglent 就不认", async () => {
		const other = await FakeSds.start({ idn: "Rigol Technologies,DS1054Z,DS1ZA,00.04" });
		await expect(SiglentScope.open(other.address)).rejects.toThrow(/not a Siglent scope/);
		await other.close();
	});

	it("status:四个通道 + 时基 + 触发 + 采集", async () => {
		const s = await scope.status();
		expect(s.idn.model).toBe("SDS824X HD");
		expect(s.channels.map((c) => c.ch)).toEqual([1, 2, 3, 4]);
		expect(s.channels[0]!.on).toBe(true);
		expect(s.channels[1]!.on).toBe(false);
		// 没设过标签的通道:仪器回的是通道号本身,驱动把它当成"没有标签"
		expect(s.channels[0]!.label).toBeUndefined();
		expect(s.channels[0]!.unit).toBe("V");
		expect(s.channels[0]!.bwlimit).toBe("FULL");
		expect(s.timebase).toEqual({ scale: 5e-8, delay: 0 });
		expect(s.trigger.source).toBe("C1");
		expect(s.trigger.type).toBe("EDGE");
		expect(s.trigger.status).toBe("Stop");
		expect(s.acquire.sampleRate).toBe(2e9);
		expect(s.acquire.points).toBe(1000);
		expect(s.acquire.mdepth).toBe("10K");
	});

	it("setChannel:设了就读回,合法值没有差异", async () => {
		const r = await scope.setChannel({ ch: 1, vdiv: 0.1, probe: 10, coupling: "DC" });
		expect(r.mismatches).toEqual([]);
		expect(r.state.vdiv).toBe(0.1);
		expect(r.state.probe).toBe(10);
		expect(r.state.coupling).toBe("DC");
		// 探头是 `PROBe VALue,<x>` 这种写法,裸 `PROBe 10` 会被仪器判非法
		expect(fake.log).toContain(":CHANnel1:PROBe VALue,10");
	});

	it("setChannel:探头不在菜单里 → 差异里点名 probe", async () => {
		const r = await scope.setChannel({ ch: 1, probe: 7 });
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0]).toMatch(/probe/);
		expect(r.mismatches[0]).toMatch(/asked 7/);
		expect(r.state.probe).toBe(10);
	});

	it("setChannel:vdiv 不在 1-2-5 档上 → 差异里点名 vdiv", async () => {
		const r = await scope.setChannel({ ch: 1, vdiv: 0.03 });
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0]).toMatch(/vdiv/);
		expect(r.state.vdiv).toBe(0.02);
		await scope.setChannel({ ch: 1, vdiv: 0.1 });
	});

	it("setChannel:标签写进去读得回来", async () => {
		const r = await scope.setChannel({ ch: 3, on: true, label: "SDA", bwlimit: "20M" });
		expect(r.mismatches).toEqual([]);
		expect(r.state.label).toBe("SDA");
		expect(r.state.on).toBe(true);
		expect(r.state.bwlimit).toBe("20M");
		await scope.setChannel({ ch: 3, on: false });
	});

	it("setTrigger:源给了关着的通道 → 仪器静默落到 LINE,差异里要说清怎么办", async () => {
		expect(fake.channels[1]!.on).toBe(false);
		const r = await scope.setTrigger({ source: "C2" });
		expect(r.state.source).toBe("LINE");
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0]).toMatch(/LINE/);
		expect(r.mismatches[0]).toMatch(/turn the channel on/);
	});

	it("setTrigger:合法组合没有差异", async () => {
		const r = await scope.setTrigger({ source: "C1", level: 0.5, slope: "rising", mode: "auto" });
		expect(r.mismatches).toEqual([]);
		expect(r.state.source).toBe("C1");
		expect(r.state.level).toBe(0.5);
		expect(r.state.slope).toBe("RISING");
		expect(r.state.mode).toBe("AUTO");
	});

	it("setTimebase:设完等一拍再读回;不在 1-2-5 档上的要说出来", async () => {
		const r = await scope.setTimebase({ scale: 1e-7, delay: 3.17e-7 });
		expect(r.mismatches).toEqual([]);
		expect(r.state.scale).toBe(1e-7);
		expect(r.state.delay).toBe(3.17e-7);
		const bad = await scope.setTimebase({ scale: 3e-7 });
		expect(bad.mismatches.length).toBe(1);
		expect(bad.mismatches[0]).toMatch(/timebase: asked 3E-7 s\/div/);
		expect(bad.state.scale).toBe(2e-7);
	});

	it("setMemoryDepth:驱动自己下 FMDepth,所以 1M 能落上", async () => {
		fake.clearLog();
		const r = await scope.setMemoryDepth("1M");
		expect(r.mismatches).toEqual([]);
		expect(r.state.mdepth).toBe("1M");
		// AUTO 管理模式下 MDEPth 会被仪器静默吃掉,所以这条必须在前面
		expect(fake.log.indexOf(":ACQuire:MMANagement FMDepth")).toBeLessThan(fake.log.indexOf(":ACQuire:MDEPth 1M"));
		expect(fake.acquire.management).toBe("FMDEPTH");
	});

	it("setMemoryDepth:菜单外的值 → 差异里带上仪器的错误", async () => {
		const r = await scope.setMemoryDepth("50M");
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0]).toMatch(/memory depth: asked 50M/);
		expect(r.mismatches[0]).toMatch(/Illegal parameter value/);
		expect(r.state.mdepth).toBe("1M");
	});

	it("readWaveform:maxPoints 逼出 stride,交付点间隔要跟着乘", async () => {
		const wf = await scope.readWaveform(1, { maxPoints: 100 });
		expect(wf.stride).toBe(10);
		expect(wf.codes.length).toBe(100);
		expect(wf.recordPoints).toBe(1000);
		expect(wf.sampleRate).toBe(2e9);
		expect(wf.probe).toBe(10);
		expect(wf.unit).toBe("V");
		// 交付点间隔 = 采集间隔 x stride,不是 1/采样率
		expect(wf.time.interval).toBe(wf.desc.horizInterval * 10);
		expect(wf.time.tdiv).toBe(fake.timebase.scale);
		expect(wf.time.delay).toBe(fake.timebase.delay);
		expect(wf.scale.codePerDiv).toBe(7680);
		// 抽点取的是源点 0,10,20...,错一格就露馅
		for (let i = 0; i < wf.codes.length; i++) expect(wf.codes[i]).toBe(defaultSquare(i * 10));
	});

	it("readWaveform:记录超过 MAXPoint 时按 :STARt 分段读,拼回来不重不漏", async () => {
		await flush();
		fake.clearLog();
		const wf = await scope.readWaveform(1);
		expect(wf.stride).toBe(1);
		expect(wf.codes.length).toBe(1000);
		await flush();
		const starts = fake.log.filter((c) => c.startsWith(":WAVeform:STARt"));
		expect(starts).toEqual([
			":WAVeform:STARt 0",
			":WAVeform:STARt 300",
			":WAVeform:STARt 600",
			":WAVeform:STARt 900",
			":WAVeform:STARt 0",
		]);
		expect(fake.log.filter((c) => c === ":WAVeform:DATA?").length).toBe(4);
		for (let i = 0; i < wf.codes.length; i++) expect(wf.codes[i]).toBe(defaultSquare(i));
	});

	it("readWaveform:别人把 WIDTh 留在 BYTE,驱动每次都写回 WORD", async () => {
		await scope.raw(":WAVeform:WIDTh BYTE");
		await flush();
		expect(fake.wave.width).toBe("BYTE");
		fake.clearLog();
		const wf = await scope.readWaveform(1, { maxPoints: 100 });
		expect(fake.log).toContain(":WAVeform:WIDTh WORD");
		expect(fake.wave.width).toBe("WORD");
		expect(wf.desc.commType).toBe(1);
		expect(wf.codes[0]).toBe(2000);
	});

	it("measure:没测出来的槽位给 null,有值的按 NR3 解", async () => {
		fake.setMeasureValue(1, "****");
		fake.setMeasureValue(2, "2.500E-02");
		const { results, mismatches } = await scope.measure([
			{ type: "FREQ", source: "C1" },
			{ type: "PKPK", source: "C1" },
		]);
		expect(mismatches).toEqual([]);
		expect(results.length).toBe(2);
		expect(results[0]).toEqual({ type: "FREQ", source: "C1", value: null });
		expect(results[1]).toEqual({ type: "PKPK", source: "C1", value: 0.025 });
		expect(fake.measureOn).toBe(true);
		expect(fake.measureMode).toBe("ADVANCED");
		expect(fake.measure[0]!.type).toBe("FREQ");
		expect(fake.measure[1]!.source).toBe("C1");
	});

	it("measure:类型名仪器不认(读回来对不上)要报出来", async () => {
		fake.measure[0]!.type = "PKPK"; // 仪器把没听懂的类型留在原来那档
		const { mismatches } = await scope.measure([{ type: "NOPE", source: "C1" }]);
		expect(mismatches.length).toBe(1);
		expect(mismatches[0]).toMatch(/P1: asked type NOPE/);
	});

	it("measure:参数校验", async () => {
		await expect(scope.measure([])).rejects.toThrow(/give items/);
		await expect(scope.measure(Array.from({ length: 13 }, () => ({ type: "PKPK", source: "C1" })))).rejects.toThrow(/at most 12/);
	});

	it("readMeasurements:只重读已配置槽位的值", async () => {
		fake.setMeasureValue(1, "1.000E+03");
		fake.setMeasureValue(2, "****");
		expect(await scope.readMeasurements(2)).toEqual([1000, null]);
	});

	it("screenshot:裸 PNG 原样回来", async () => {
		const png = await scope.screenshot();
		expect(png.length).toBe(SCREEN_PNG.length);
		expect(pngComplete(png)).toBe(png.length);
		expect(Buffer.from(png).equals(Buffer.from(SCREEN_PNG))).toBe(true);
	});

	it("waitForStop:轮到 Stop 就收工", async () => {
		fake.setStatusScript(["Arm", "Arm", "Stop"]);
		await scope.single();
		await flush();
		expect(fake.trigger.mode).toBe("SINGLE");
		const r = await scope.waitForStop(3000);
		expect(r.ok).toBe(true);
		expect(r.status).toBe("Stop");
	});

	it("waitForStop:一直不停就超时,不假装成功", async () => {
		fake.setStatusScript(["Arm"]);
		const started = Date.now();
		const r = await scope.waitForStop(150);
		expect(r.ok).toBe(false);
		expect(r.status).toBe("Arm");
		expect(Date.now() - started).toBeGreaterThanOrEqual(140);
		fake.setStatusScript([]);
	});

	it("run / stop / forceTrigger 落到对的命令上", async () => {
		await flush();
		fake.clearLog();
		await scope.run();
		await scope.stop();
		await scope.forceTrigger();
		await flush();
		expect(fake.log.slice(0, 3)).toEqual([":TRIGger:RUN", ":TRIGger:STOP", ":TRIGger:MODE FTRIG"]);
		expect(fake.trigger.mode).toBe("FTRIG");
	});

	it("raw:带问号的读一行,不带的只写,二进制的直接拦下", async () => {
		const answer = await scope.raw(":TIMebase:SCALe?");
		expect(typeof answer).toBe("string");
		expect(parseNumber(answer!)).toBe(fake.timebase.scale);
		expect(await scope.raw("*CLS")).toBeUndefined();
		await expect(scope.raw(":WAVeform:DATA?")).rejects.toThrow(/returns binary/);
		await expect(scope.raw(":PRINt? PNG")).rejects.toThrow(/returns binary/);
		// *CLS 刚清过错误队列
		expect(await scope.checkError()).toBeUndefined();
	});
});
