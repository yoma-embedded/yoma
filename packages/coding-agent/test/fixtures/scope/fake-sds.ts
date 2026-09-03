/**
 * FakeSds —— 一台假的 Siglent SDS824X HD(固件 4.8.12.1.1.6.5),说 5025 口的 SCPI 方言。
 *
 * 它存在的理由:驱动(core/scope/siglent.ts)的每条纪律都是"实测出来的怪癖",而怪癖没法在
 * 纯函数里验 —— 只有让一台机器**照着怪癖回答**,才看得见驱动是不是真的挡住了它们。
 * 复刻的怪癖(全部来自真机):
 *  - 数值型 getter 一律回 NR3("5.00E-02"),不是 "0.05";
 *  - `:CHANnel<n>:PROBe` 的**写法是 `PROBe VALue,<x>`**,裸 `PROBe 10` 被判非法(-224)并忽略;
 *  - 探头倍率只认菜单里那几档,别的静默拒绝;vdiv / 时基按 1-2-5 档向下取整;
 *  - `:TRIGger:EDGE:SOURce C2` 而 C2 是关着的 → **静默落到 LINE**;
 *  - `:ACQuire:MDEPth` 只在 `:ACQuire:MMANagement FMDepth` 之后才生效,否则整条被吃掉;
 *  - `:TRIGger:STATus?` 按脚本推进(最后一格粘住),`:TRIGger:MODE SINGle` 把脚本拨回开头;
 *  - `:WAVeform:DATA?` 认 STARt / INTerval / MAXPoint,块尾跟两个换行;WIDTh BYTE 只发高字节;
 *  - `:PRINt? PNG` 是**裸图**,没有块头。
 *
 * 三个给测试用的钩子:`chunkBytes` 让每条响应分成多个 TCP 段送(逼客户端跨段分帧);
 * `hang(cmd)` 让某条查询永不作答(测超时 → dirty → drain);`releaseHung()` 再把迟到的答案放出去。
 *
 * 命令识别:把每级助记符归一到 SCPI 短形式(CHANnel1 → CHAN1、SCALe → SCAL),长短形式都认;
 * 认不出的头 → 错误队列里记一条 -113(与真机同)。
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const FIXTURE_DIR = import.meta.dir;

/** `:WAVeform:PREamble?` 的真机响应(块头 + 346 字节 WAVEDESC + 换行),原样回。 */
export const PREAMBLE_RESPONSE = new Uint8Array(readFileSync(join(FIXTURE_DIR, "preamble.bin")));
/** `:PRINt? PNG` 的真机响应。文件尾那个换行不是图的一部分,SCREEN_PNG 是去掉它之后的裸图。 */
export const SCREEN_PNG_FILE = new Uint8Array(readFileSync(join(FIXTURE_DIR, "screen.png")));
export const SCREEN_PNG = stripTrailingNewlines(SCREEN_PNG_FILE);

function stripTrailingNewlines(bytes: Uint8Array): Uint8Array {
	let end = bytes.length;
	while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
	return bytes.subarray(0, end);
}

/** 默认波形:周期 200 个源点、±2000 code 的方波。测试拿它对答案,于是分段读的边界对不对一目了然。 */
export function defaultSquare(i: number): number {
	return i % 200 < 100 ? 2000 : -2000;
}

/** dispatch 的"这条头我不认识"哨兵(与任何合法答复都不会相等)。 */
const UNKNOWN = "@@unknown@@";

const PROBE_MENU = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const MDEPTH_MENU = ["10K", "100K", "1M", "10M"];
/** ADVanced 量测的类型菜单(真机的子集,够测试用);菜单外的名字真机报 -224 并把原来那档留着。 */
const MEASURE_TYPE_MENU = [
	"PKPK", "MAX", "MIN", "AMPL", "TOP", "BASE", "MEAN", "RMS", "STDEV", "MEDIAN",
	"PER", "FREQ", "PWID", "NWID", "DUTY", "NDUTY", "RISE", "FALL", "DELAY", "PHA",
	"OVSP", "OVSN", "AREA", "CYCLES", "EDGES",
];
const STEPS_125 = [1, 2, 5];

/** 助记符长形式 → SCPI 短形式。表里没有的按"删掉小写字母"折算(驱动写的就是混合大小写)。 */
const LONG_TO_SHORT: Record<string, string> = {
	CHANNEL: "CHAN",
	TIMEBASE: "TIM",
	TRIGGER: "TRIG",
	ACQUIRE: "ACQ",
	WAVEFORM: "WAV",
	MEASURE: "MEAS",
	SYSTEM: "SYST",
	SWITCH: "SWIT",
	SCALE: "SCAL",
	OFFSET: "OFFS",
	COUPLING: "COUP",
	PROBE: "PROB",
	BWLIMIT: "BWL",
	LABEL: "LAB",
	DELAY: "DEL",
	SOURCE: "SOUR",
	LEVEL: "LEV",
	SLOPE: "SLOP",
	STATUS: "STAT",
	EDGE: "EDGE",
	MODE: "MODE",
	TYPE: "TYPE",
	SRATE: "SRAT",
	POINTS: "POIN",
	POINT: "POIN",
	MDEPTH: "MDEP",
	MMANAGEMENT: "MMAN",
	MAXPOINT: "MAXP",
	PREAMBLE: "PRE",
	WIDTH: "WIDT",
	START: "STAR",
	INTERVAL: "INT",
	ADVANCED: "ADV",
	VALUE: "VAL",
	ERROR: "ERR",
	PRINT: "PRIN",
	AUTOSET: "AUT",
};

function canonMnemonic(word: string): string {
	const m = /^([A-Za-z]+)(\d*)$/.exec(word);
	if (!m) return word.toUpperCase();
	const name = m[1]!.toUpperCase();
	const short = m[1]!.replace(/[a-z]/g, "").toUpperCase() || name;
	return (LONG_TO_SHORT[name] ?? short) + m[2]!;
}

/** ":CHANnel1:SCALe" → "CHAN1:SCAL"(末尾的问号由调用方摘掉)。 */
function canonHeader(header: string): string {
	return header.replace(/^:/, "").split(":").map(canonMnemonic).join(":");
}

/** 真机的数值答复格式:两位小数尾数 + 两位指数。 */
export function nr3(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	return value.toExponential(2).toUpperCase().replace(/E([-+])(\d)$/, "E$10$2");
}

/** 1-2-5 档:向下取到不超过 v 的那一档(真机的取法,超范围就钳到端点)。 */
function snap125(v: number, min: number, max: number): number {
	if (!(v > 0)) return min;
	const clamped = Math.min(Math.max(v, min), max);
	let best = min;
	for (let decade = -13; decade <= 4; decade++) {
		for (const step of STEPS_125) {
			const candidate = step * 10 ** decade;
			if (candidate < min * (1 - 1e-9) || candidate > max * (1 + 1e-9)) continue;
			if (candidate <= clamped * (1 + 1e-9)) best = candidate;
		}
	}
	return best;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		(t as unknown as { unref?: () => void }).unref?.();
	});
}

export interface FakeChannelState {
	on: boolean;
	scale: number;
	offset: number;
	coupling: string;
	probe: number;
	bwlimit: string;
	unit: string;
	/** 真机没设过标签时回的是通道号本身("1"),驱动据此判定"没有标签" */
	label: string;
	labelOn: boolean;
}

export interface FakeWaveState {
	source: number;
	width: "WORD" | "BYTE";
	start: number;
	interval: number;
	point: number;
}

export interface FakeMeasureSlot {
	on: boolean;
	type: string;
	source: string;
	/** `:VALue?` 的原样答复;真机没测出来时是四个星号 */
	value: string;
}

export interface FakeSdsOptions {
	/** >0 时每条响应拆成这么大的 TCP 段发(逼客户端跨段分帧) */
	chunkBytes?: number;
	/** 段间延时(ms),默认 1 */
	chunkDelayMs?: number;
	recordPoints?: number;
	sampleRate?: number;
	/** `:WAVeform:MAXPoint?`:一次 DATA? 最多给多少点。真机默认 5e6,测试调小来逼分段。 */
	maxPoint?: number;
	/** 按源点序号产生 code,默认 defaultSquare */
	generator?: (i: number) => number;
	/** ADVanced 量测认得的类型名,默认 MEASURE_TYPE_MENU */
	measureTypes?: string[];
	idn?: string;
}

export class FakeSds {
	readonly log: string[] = [];
	readonly errors: string[] = [];
	readonly channels: FakeChannelState[] = [];
	readonly measure: FakeMeasureSlot[] = [];
	timebase = { scale: 5e-8, delay: 0 };
	trigger = { mode: "AUTO", type: "EDGE", source: "C1", level: 0, slope: "RISING" };
	acquire = { mdepth: "10K", management: "AUTO" };
	wave: FakeWaveState = { source: 1, width: "WORD", start: 0, interval: 1, point: 0 };
	measureOn = false;
	measureMode = "SIMPLE";
	/** 空 = 用 status 字段;非空 = 按脚本推进,最后一格粘住 */
	statusScript: string[] = [];
	statusIndex = 0;
	status = "Stop";
	recordPoints: number;
	sampleRate: number;
	maxPoint: number;
	generator: (i: number) => number;
	measureTypes: string[];
	readonly idn: string;

	private readonly chunkBytes: number;
	private readonly chunkDelayMs: number;
	private readonly sockets = new Set<net.Socket>();
	private server!: net.Server;
	private hungCommand?: string;
	private hungResponse?: { socket: net.Socket; bytes: Uint8Array };

	private constructor(options: FakeSdsOptions) {
		this.chunkBytes = options.chunkBytes ?? 0;
		this.chunkDelayMs = options.chunkDelayMs ?? 1;
		this.recordPoints = options.recordPoints ?? 1000;
		this.sampleRate = options.sampleRate ?? 2e9;
		this.maxPoint = options.maxPoint ?? 5_000_000;
		this.generator = options.generator ?? defaultSquare;
		this.measureTypes = options.measureTypes ?? MEASURE_TYPE_MENU;
		this.idn = options.idn ?? "Siglent Technologies,SDS824X HD,SDS08A0D910802,4.8.12.1.1.6.5";
		for (let n = 1; n <= 4; n++) {
			this.channels.push({ on: n === 1, scale: 1, offset: 0, coupling: "DC", probe: 1, bwlimit: "FULL", unit: "V", label: String(n), labelOn: false });
		}
		for (let i = 0; i < 12; i++) this.measure.push({ on: false, type: "PKPK", source: "C1", value: "****" });
	}

	static start(options: FakeSdsOptions = {}): Promise<FakeSds> {
		const fake = new FakeSds(options);
		return new Promise((resolve, reject) => {
			const server = net.createServer((socket) => fake.onConnection(socket));
			fake.server = server;
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.unref();
				resolve(fake);
			});
		});
	}

	get port(): number {
		return (this.server.address() as net.AddressInfo).port;
	}

	get address(): string {
		return `127.0.0.1:${this.port}`;
	}

	async close(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** 下一条匹配的查询永不作答(一次性)。command 按原样、大小写不敏感比较。 */
	hang(command: string): void {
		this.hungCommand = command.trim().toUpperCase();
	}

	/** 把被扣住的那条答案现在放出去(模拟"仪器晚了一步才回")。 */
	releaseHung(): void {
		const pending = this.hungResponse;
		this.hungResponse = undefined;
		if (pending && !pending.socket.destroyed) pending.socket.write(pending.bytes);
	}

	setMeasureValue(slot: number, value: string): void {
		this.measure[slot - 1]!.value = value;
	}

	setStatusScript(script: string[]): void {
		this.statusScript = [...script];
		this.statusIndex = 0;
	}

	/** 只清命令日志(状态留着)。 */
	clearLog(): void {
		this.log.length = 0;
	}

	private onConnection(socket: net.Socket): void {
		this.sockets.add(socket);
		socket.setNoDelay(true);
		socket.on("error", () => undefined);
		socket.once("close", () => this.sockets.delete(socket));
		let pending = "";
		let chain: Promise<unknown> = Promise.resolve();
		socket.on("data", (buf: Buffer) => {
			pending += buf.toString("latin1");
			for (;;) {
				const nl = pending.indexOf("\n");
				if (nl < 0) break;
				const line = pending.slice(0, nl).replace(/\r$/, "");
				pending = pending.slice(nl + 1);
				if (!line.trim()) continue;
				chain = chain.then(() => this.handle(socket, line));
			}
		});
	}

	private async handle(socket: net.Socket, line: string): Promise<void> {
		const command = line.trim();
		this.log.push(command);
		const response = this.respond(command);
		if (response === undefined || socket.destroyed) return;
		const bytes = typeof response === "string" ? new TextEncoder().encode(`${response}\n`) : response;
		if (this.hungCommand && command.toUpperCase() === this.hungCommand) {
			this.hungCommand = undefined;
			this.hungResponse = { socket, bytes };
			return;
		}
		await this.send(socket, bytes);
	}

	private async send(socket: net.Socket, bytes: Uint8Array): Promise<void> {
		if (this.chunkBytes <= 0 || bytes.length <= this.chunkBytes) {
			socket.write(bytes);
			return;
		}
		for (let o = 0; o < bytes.length; o += this.chunkBytes) {
			if (socket.destroyed) return;
			socket.write(bytes.subarray(o, Math.min(o + this.chunkBytes, bytes.length)));
			await sleep(this.chunkDelayMs);
		}
	}

	private pushError(code: number, message: string): void {
		this.errors.push(`${code},"${message}"`);
	}

	// ── 命令分发 ─────────────────────────────────────────────────────────

	/** 返回:string(自动补换行)/ Uint8Array(原样)/ undefined(只写不答)。 */
	private respond(command: string): string | Uint8Array | undefined {
		const star = command.toUpperCase();
		if (star === "*IDN?") return this.idn;
		if (star === "*OPC?") return "1";
		if (star === "*CLS") {
			this.errors.length = 0;
			return undefined;
		}
		const m = /^(\S+?)\??(?:\s+(.*))?$/.exec(command);
		if (!m) {
			this.pushError(-113, `Undefined header;${command}`);
			return undefined;
		}
		const header = canonHeader(m[1]!);
		const query = /\?/.test(command);
		const arg = (m[2] ?? "").trim();
		const answer = this.dispatch(header, query, arg);
		if (answer === UNKNOWN) {
			this.pushError(-113, `Undefined header;${command}`);
			return undefined;
		}
		return answer;
	}

	private dispatch(header: string, query: boolean, arg: string): string | Uint8Array | undefined {
		const ch = /^CHAN([1-4])(?::(.+))?$/.exec(header);
		if (ch) return this.channelCommand(Number(ch[1]), ch[2] ?? "", query, arg);
		if (header === "TIM" || header.startsWith("TIM:")) return this.timebaseCommand(header.slice(4), query, arg);
		if (header === "TRIG" || header.startsWith("TRIG:")) return this.triggerCommand(header.slice(5), query, arg);
		if (header === "ACQ" || header.startsWith("ACQ:")) return this.acquireCommand(header.slice(4), query, arg);
		if (header === "WAV" || header.startsWith("WAV:")) return this.waveCommand(header.slice(4), query, arg);
		if (header === "MEAS" || header.startsWith("MEAS:")) return this.measureCommand(header === "MEAS" ? "" : header.slice(5), query, arg);
		if (header === "SYST:ERR") return this.errors.shift() ?? '0,"No error"';
		if (header === "PRIN") return query ? SCREEN_PNG : undefined;
		if (header === "AUT") return undefined;
		return UNKNOWN;
	}

	private channelCommand(n: number, tail: string, query: boolean, arg: string): string | undefined {
		const c = this.channels[n - 1]!;
		switch (tail) {
			case "SWIT":
				if (query) return c.on ? "ON" : "OFF";
				c.on = /^ON$/i.test(arg);
				return undefined;
			case "SCAL": {
				if (query) return nr3(c.scale);
				const v = Number(arg);
				// 真机:V/div 走 1-2-5 档,范围 500µV..10V(乘探头倍率)
				if (Number.isFinite(v)) c.scale = snap125(v, 500e-6 * c.probe, 10 * c.probe);
				return undefined;
			}
			case "OFFS":
				if (query) return nr3(c.offset);
				if (Number.isFinite(Number(arg))) c.offset = Number(arg);
				return undefined;
			case "COUP":
				if (query) return c.coupling;
				if (/^(DC|AC|GND)$/i.test(arg)) c.coupling = arg.toUpperCase();
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			case "PROB": {
				if (query) return nr3(c.probe);
				// 真机的写法是 `PROBe VALue,<x>`;裸 `PROBe 10` 报 -224
				const v = /^VAL(?:UE)?\s*,\s*(.+)$/i.exec(arg);
				if (!v) {
					this.pushError(-224, "Illegal parameter value");
					return undefined;
				}
				const probe = Number(v[1]);
				if (!PROBE_MENU.some((p) => Math.abs(p - probe) < 1e-9)) {
					this.pushError(-224, "Illegal parameter value");
					return undefined;
				}
				// 探头倍率一变,屏上的 V/div 跟着换算(真机行为)
				c.scale = (c.scale / c.probe) * probe;
				c.probe = probe;
				return undefined;
			}
			case "BWL":
				if (query) return c.bwlimit;
				if (/^(FULL|20M|200M)$/i.test(arg)) c.bwlimit = arg.toUpperCase();
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			case "UNIT":
				if (query) return c.unit;
				if (/^(V|A)$/i.test(arg)) c.unit = arg.toUpperCase();
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			case "LAB":
				if (query) return c.labelOn ? "ON" : "OFF";
				c.labelOn = /^ON$/i.test(arg);
				return undefined;
			case "LAB:TEXT":
				if (query) return `"${c.label}"`;
				c.label = arg.replace(/^"(.*)"$/, "$1").slice(0, 20);
				return undefined;
			default:
				return UNKNOWN;
		}
	}

	private timebaseCommand(tail: string, query: boolean, arg: string): string | undefined {
		switch (tail) {
			case "SCAL": {
				if (query) return nr3(this.timebase.scale);
				const v = Number(arg);
				if (Number.isFinite(v)) this.timebase.scale = snap125(v, 200e-12, 1000);
				return undefined;
			}
			case "DEL":
				if (query) return nr3(this.timebase.delay);
				if (Number.isFinite(Number(arg))) this.timebase.delay = Number(arg);
				return undefined;
			default:
				return UNKNOWN;
		}
	}

	private triggerCommand(tail: string, query: boolean, arg: string): string | undefined {
		switch (tail) {
			case "MODE": {
				if (query) return this.trigger.mode;
				const full: Record<string, string> = { AUTO: "AUTO", NORM: "NORMAL", SING: "SINGLE", FTRIG: "FTRIG" };
				const resolved = full[canonMnemonic(arg)];
				if (!resolved) {
					this.pushError(-224, "Illegal parameter value");
					return undefined;
				}
				this.trigger.mode = resolved;
				// 真机:重新武装单次会把触发状态从头走一遍
				if (resolved === "SINGLE") {
					this.statusIndex = 0;
					this.status = "Arm";
				}
				return undefined;
			}
			case "TYPE":
				if (query) return this.trigger.type;
				this.trigger.type = arg.toUpperCase();
				return undefined;
			case "EDGE:SOUR": {
				if (query) return this.trigger.source;
				const source = arg.toUpperCase();
				if (!/^(C[1-4]|LINE)$/.test(source)) {
					this.pushError(-224, "Illegal parameter value");
					return undefined;
				}
				// 真机怪癖:选了一个关着的通道,不报错,静默落到 LINE
				const n = /^C([1-4])$/.exec(source);
				this.trigger.source = n && !this.channels[Number(n[1]) - 1]!.on ? "LINE" : source;
				return undefined;
			}
			case "EDGE:LEV":
				if (query) return nr3(this.trigger.level);
				if (Number.isFinite(Number(arg))) this.trigger.level = Number(arg);
				return undefined;
			case "EDGE:SLOP": {
				if (query) return this.trigger.slope;
				const full: Record<string, string> = { RIS: "RISING", FALL: "FALLING", ALT: "ALTERNATE" };
				const resolved = full[canonMnemonic(arg)];
				if (resolved) this.trigger.slope = resolved;
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			}
			case "STAT": {
				if (!query) return UNKNOWN;
				if (this.statusScript.length === 0) return this.status;
				const value = this.statusScript[Math.min(this.statusIndex, this.statusScript.length - 1)]!;
				this.statusIndex++;
				return value;
			}
			case "RUN":
				this.status = "Trig'd";
				return undefined;
			case "STOP":
				this.status = "Stop";
				return undefined;
			default:
				return UNKNOWN;
		}
	}

	private acquireCommand(tail: string, query: boolean, arg: string): string | undefined {
		switch (tail) {
			case "SRAT":
				return query ? nr3(this.sampleRate) : undefined;
			case "POIN":
				return query ? nr3(this.recordPoints) : undefined;
			case "MMAN":
				if (query) return this.acquire.management;
				if (/^(AUTO|FMD(EPTH)?)$/i.test(arg)) this.acquire.management = /^AUTO$/i.test(arg) ? "AUTO" : "FMDEPTH";
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			case "MDEP": {
				if (query) return this.acquire.mdepth;
				// 真机:AUTO 管理模式下这条被静默吃掉
				if (this.acquire.management !== "FMDEPTH") return undefined;
				const value = arg.toUpperCase();
				if (!MDEPTH_MENU.includes(value)) {
					this.pushError(-224, "Illegal parameter value");
					return undefined;
				}
				this.acquire.mdepth = value;
				return undefined;
			}
			default:
				return UNKNOWN;
		}
	}

	private waveCommand(tail: string, query: boolean, arg: string): string | Uint8Array | undefined {
		switch (tail) {
			case "SOUR": {
				if (query) return `C${this.wave.source}`;
				const n = /^C?([1-4])$/i.exec(arg);
				if (n) this.wave.source = Number(n[1]);
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			}
			case "WIDT":
				if (query) return this.wave.width;
				if (/^(WORD|BYTE)$/i.test(arg)) this.wave.width = arg.toUpperCase() as "WORD" | "BYTE";
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			case "STAR":
				if (query) return nr3(this.wave.start);
				if (Number.isFinite(Number(arg))) this.wave.start = Math.max(0, Math.round(Number(arg)));
				return undefined;
			case "INT":
				if (query) return nr3(this.wave.interval);
				if (Number.isFinite(Number(arg))) this.wave.interval = Math.max(1, Math.round(Number(arg)));
				return undefined;
			case "POIN":
				if (query) return nr3(this.wave.point);
				if (Number.isFinite(Number(arg))) this.wave.point = Math.max(0, Math.round(Number(arg)));
				return undefined;
			case "MAXP":
				return query ? nr3(this.maxPoint) : undefined;
			case "PRE":
				return query ? PREAMBLE_RESPONSE : undefined;
			case "DATA":
				return query ? this.waveformBlock() : undefined;
			default:
				return UNKNOWN;
		}
	}

	/** 块头 + 样本 + 两个换行(真机的块尾就是两个换行)。 */
	private waveformBlock(): Uint8Array {
		const { start, interval, point, width } = this.wave;
		const stride = Math.max(1, interval);
		const available = Math.max(0, this.recordPoints - start);
		const cap = point > 0 ? Math.min(point, this.maxPoint) : this.maxPoint;
		const n = Math.min(Math.ceil(available / stride), cap);
		const body = new Uint8Array(width === "BYTE" ? n : n * 2);
		const dv = new DataView(body.buffer);
		for (let i = 0; i < n; i++) {
			const code = Math.max(-32768, Math.min(32767, Math.round(this.generator(start + i * stride))));
			if (width === "BYTE") body[i] = (code >> 8) & 0xff;
			else dv.setInt16(i * 2, code, true);
		}
		const digits = String(body.length);
		const header = new TextEncoder().encode(`#${digits.length}${digits}`);
		const out = new Uint8Array(header.length + body.length + 2);
		out.set(header, 0);
		out.set(body, header.length);
		out[out.length - 2] = 0x0a;
		out[out.length - 1] = 0x0a;
		return out;
	}

	private measureCommand(tail: string, query: boolean, arg: string): string | undefined {
		if (tail === "") {
			if (query) return this.measureOn ? "ON" : "OFF";
			this.measureOn = /^ON$/i.test(arg);
			return undefined;
		}
		if (tail === "MODE") {
			if (query) return this.measureMode;
			this.measureMode = canonMnemonic(arg) === "ADV" ? "ADVANCED" : arg.toUpperCase();
			return undefined;
		}
		const p = /^ADV:P(\d{1,2})(?::(.+))?$/.exec(tail);
		if (!p) return UNKNOWN;
		const slot = this.measure[Number(p[1]) - 1];
		if (!slot) {
			this.pushError(-224, "Illegal parameter value");
			return undefined;
		}
		switch (p[2] ?? "") {
			case "":
				if (query) return slot.on ? "ON" : "OFF";
				slot.on = /^ON$/i.test(arg);
				return undefined;
			case "TYPE": {
				if (query) return slot.type;
				// 真机:类型名不在菜单里 → -224,槽位留在原来那档(于是驱动读回来发现对不上)
				const type = arg.toUpperCase();
				if (this.measureTypes.includes(type)) slot.type = type;
				else this.pushError(-224, "Illegal parameter value");
				return undefined;
			}
			case "SOUR":
				if (query) return slot.source;
				slot.source = arg.toUpperCase();
				return undefined;
			case "VAL":
				return query ? slot.value : undefined;
			default:
				return UNKNOWN;
		}
	}
}
