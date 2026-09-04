/**
 * Siglent SDS(新式 `:` 命令树,SDS800X HD / 2000X HD 一族)驱动。目前只在 SDS824X HD 上验证过。
 *
 * 三条纪律:
 *  - **设了就读回**。这一族没有可靠的错误队列(本机固件的 `:SYSTem:ERRor?` 能用,老固件超时),
 *    非法值要么被静默拒绝、要么被静默改成别的(触发源给了关着的通道 → 落到 LINE)。每个 setter
 *    返回的是仪器读回的真实状态,调用方对比后把差异说给模型听。
 *  - **时基类命令要等**:`:TIMebase:SCALe` 之后 ~500ms 内的下一条命令有几率失效(实测有人踩过
 *    "跳到最小时基")。
 *  - **读波形先停**:RUN 状态下读到的是双缓冲里的哪一帧没有文档保证;要一致快照就 STOP 或
 *    SINGle→Stop 再读。记录长度信 preamble 的 WAVE_ARRAY_COUNT(实际采集),不信 `:ACQuire:POINts?`(配置值);
 *    MAXPoint 截的是源点窗口,stride 多大都按 "已交付点数 × stride" 推进 :STARt 分段读(2026-09-04 真机核实)。
 */
import { parseNumber } from "./analyze.ts";
import { COUPLING_ENUM, decodeSamples, parseWaveDesc, type TimeScale, type VoltScale, type WaveDesc, voltScaleOf } from "./preamble.ts";
import { type ScpiAddress, type ScpiClient, ScpiTimeoutError, formatScpiAddress, openScpi, parseScpiAddress, pngComplete } from "./scpi.ts";

export interface ScopeIdentity {
	vendor: string;
	model: string;
	serial: string;
	firmware: string;
}

export interface ChannelState {
	ch: number;
	on: boolean;
	label?: string;
	/** V/div,含探头 */
	vdiv: number;
	offset: number;
	coupling: string;
	probe: number;
	bwlimit: string;
	unit: string;
}

export interface TimebaseState {
	scale: number;
	delay: number;
}

export interface TriggerState {
	mode: string;
	type: string;
	source: string;
	level: number;
	slope: string;
	status: string;
}

export interface AcquireState {
	sampleRate: number;
	points: number;
	mdepth: string;
	management?: string;
}

export interface ScopeStatus {
	idn: ScopeIdentity;
	channels: ChannelState[];
	timebase: TimebaseState;
	trigger: TriggerState;
	acquire: AcquireState;
}

export interface ChannelSpec {
	ch: number;
	on?: boolean;
	vdiv?: number;
	offset?: number;
	coupling?: string;
	probe?: number;
	bwlimit?: string;
	label?: string;
}

export interface TimebaseSpec {
	scale?: number;
	delay?: number;
}

export interface TriggerSpec {
	mode?: string;
	source?: string;
	level?: number;
	slope?: string;
}

/** 一次 setter 的结果:仪器读回的状态 + 与请求不符的地方(人话)。 */
export interface Applied<T> {
	state: T;
	mismatches: string[];
}

export interface Waveform {
	ch: number;
	codes: Int16Array;
	desc: WaveDesc;
	scale: VoltScale;
	time: TimeScale;
	stride: number;
	/** 采集采样率 */
	sampleRate: number;
	/** 记录总长(采集点) */
	recordPoints: number;
	unit: string;
	probe: number;
}

export interface MeasureItem {
	type: string;
	source: string;
}

export interface MeasureResult extends MeasureItem {
	value: number | null;
}

export const CHANNEL_COUNT = 4;
export const MEASURE_SLOTS = 12;
export const TRIGGER_SOURCES = ["C1", "C2", "C3", "C4", "LINE"] as const;
export const COUPLINGS = ["DC", "AC", "GND"] as const;
export const BWLIMITS = ["FULL", "20M"] as const;
export const TRIGGER_MODES: Record<string, string> = { auto: "AUTO", normal: "NORMal", single: "SINGle", force: "FTRIG", ftrig: "FTRIG" };
export const TRIGGER_SLOPES: Record<string, string> = { rising: "RISing", rise: "RISing", falling: "FALLing", fall: "FALLing", alternate: "ALTernate", either: "ALTernate", both: "ALTernate" };
/** 手册 ADVanced 量测类型(SDS800X HD);模型给别的名字时照发,读回 TYPE? 对不上就报 */
export const MEASURE_TYPES = [
	"PKPK", "MAX", "MIN", "AMPL", "TOP", "BASE", "LEVELX", "CMEAN", "MEAN", "STDEV", "VSTD", "RMS", "CRMS", "MEDIAN", "CMEDIAN", "OVSN", "FPRE", "OVSP", "RPRE", "ULOWer",
	"PER", "FREQ", "TMAX", "TMIN", "PWID", "NWID", "DUTY", "NDUTY", "WID", "NBWID", "DELAY", "TIMEL", "RISE", "FALL", "RISE10T90", "FALL90T10", "CCJ",
	"PAREA", "NAREA", "AREA", "ABSAREA", "PACArea", "NACArea", "ACArea", "ABSACArea",
	"CYCLES", "REDGES", "FEDGES", "EDGES", "PPULSES", "NPULSES",
	"PHA", "SKEW", "FRR", "FRF", "FFR", "FFF", "LRR", "LRF", "LFR", "LFF", "PSLOPE", "NSLOPE", "TSR", "TSF", "THR", "THF",
] as const;

const SETTLE_TIMEBASE_MS = 500;
const SETTLE_SHORT_MS = 60;
const STATUS_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		(t as unknown as { unref?: () => void }).unref?.();
	});
}

function unquote(s: string): string {
	return s.replace(/^"(.*)"$/, "$1");
}

function nearly(a: number, b: number, rel = 2e-3, abs = 1e-12): boolean {
	return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

export function normalizeChannel(value: string | number): number {
	const n = typeof value === "number" ? value : Number(String(value).replace(/^(ch|c)/i, ""));
	if (!Number.isInteger(n) || n < 1 || n > CHANNEL_COUNT) throw new Error(`scope: channel "${value}" — use 1..${CHANNEL_COUNT}`);
	return n;
}

export function normalizeSource(value: string | number): string {
	const s = String(value).trim().toUpperCase();
	if (s === "LINE" || s === "AC" || s === "ACLINE") return "LINE";
	if (/^(CH|C)?[1-4]$/.test(s)) return `C${s.replace(/^\D+/, "")}`;
	if (s === "EX" || s === "EXT" || s === "EX5") throw new Error("scope: this model has no external trigger input (the AUX BNC is trigger OUT) — trigger on C1..C4 or LINE");
	throw new Error(`scope: trigger source "${value}" — use C1..C4 or LINE`);
}

export function parseIdn(line: string): ScopeIdentity {
	const [vendor = "", model = "", serial = "", firmware = ""] = line.split(",").map((s) => s.trim());
	return { vendor, model, serial, firmware };
}

export class SiglentScope {
	readonly address: ScpiAddress;
	readonly identity: ScopeIdentity;
	private constructor(readonly client: ScpiClient, address: ScpiAddress, identity: ScopeIdentity) {
		this.address = address;
		this.identity = identity;
	}

	get label(): string {
		return formatScpiAddress(this.address);
	}

	static async open(address: ScpiAddress | string, options: { connectTimeoutMs?: number } = {}): Promise<SiglentScope> {
		const addr = typeof address === "string" ? parseScpiAddress(address) : address;
		const client = await openScpi(addr, options);
		try {
			// USB 的输出队列跨连接残留(上一个进程超时留下的截图会被当成 *IDN? 的答案),先清。
			await client.drain(200);
			const line = await client.query("*IDN?", { timeoutMs: 3000 });
			const idn = parseIdn(line);
			if (!/siglent/i.test(idn.vendor)) throw new Error(`scope: ${formatScpiAddress(addr)} answered *IDN? with "${line}" — not a Siglent scope`);
			const scope = new SiglentScope(client, addr, idn);
			// 若 USB 侧用无序列号的 "usb" 打开,把实际序列号补进地址,便于持久化
			if (addr.kind === "usb" && !addr.serial && idn.serial) (scope as { address: ScpiAddress }).address = { kind: "usb", serial: idn.serial };
			return scope;
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	// ── 查询 ─────────────────────────────────────────────────────────────

	private q(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
		return this.client.query(command, { timeoutMs, signal });
	}

	private async qNum(command: string, signal?: AbortSignal): Promise<number> {
		const v = parseNumber(await this.q(command, undefined, signal));
		if (v === null) throw new Error(`scope: ${command} returned no number`);
		return v;
	}

	async channel(n: number, signal?: AbortSignal): Promise<ChannelState> {
		const p = `:CHANnel${n}`;
		const on = (await this.q(`${p}:SWITch?`, undefined, signal)).toUpperCase() === "ON";
		const [vdiv, offset, coupling, probe, bwlimit, unit, label] = await Promise.all([
			this.qNum(`${p}:SCALe?`, signal),
			this.qNum(`${p}:OFFSet?`, signal),
			this.q(`${p}:COUPling?`, undefined, signal),
			this.qNum(`${p}:PROBe?`, signal),
			this.q(`${p}:BWLimit?`, undefined, signal),
			this.q(`${p}:UNIT?`, undefined, signal),
			this.q(`${p}:LABel:TEXT?`, undefined, signal),
		]);
		const text = unquote(label);
		return { ch: n, on, label: text && text !== String(n) ? text : undefined, vdiv, offset, coupling: coupling.toUpperCase(), probe, bwlimit: bwlimit.toUpperCase(), unit: unit.toUpperCase() };
	}

	async timebase(signal?: AbortSignal): Promise<TimebaseState> {
		return { scale: await this.qNum(":TIMebase:SCALe?", signal), delay: await this.qNum(":TIMebase:DELay?", signal) };
	}

	async trigger(signal?: AbortSignal): Promise<TriggerState> {
		return {
			mode: await this.q(":TRIGger:MODE?", undefined, signal),
			type: await this.q(":TRIGger:TYPE?", undefined, signal),
			source: await this.q(":TRIGger:EDGE:SOURce?", undefined, signal),
			level: await this.qNum(":TRIGger:EDGE:LEVel?", signal),
			slope: await this.q(":TRIGger:EDGE:SLOPe?", undefined, signal),
			status: await this.triggerStatus(signal),
		};
	}

	async acquire(signal?: AbortSignal): Promise<AcquireState> {
		const management = await this.q(":ACQuire:MMANagement?", undefined, signal).catch(() => undefined);
		return {
			sampleRate: await this.qNum(":ACQuire:SRATe?", signal),
			points: await this.qNum(":ACQuire:POINts?", signal),
			mdepth: await this.q(":ACQuire:MDEPth?", undefined, signal),
			management,
		};
	}

	async status(signal?: AbortSignal): Promise<ScopeStatus> {
		const channels: ChannelState[] = [];
		for (let n = 1; n <= CHANNEL_COUNT; n++) channels.push(await this.channel(n, signal));
		return { idn: this.identity, channels, timebase: await this.timebase(signal), trigger: await this.trigger(signal), acquire: await this.acquire(signal) };
	}

	triggerStatus(signal?: AbortSignal): Promise<string> {
		return this.q(":TRIGger:STATus?", undefined, signal);
	}

	// ── 设置(设了就读回)────────────────────────────────────────────────

	async setChannel(spec: ChannelSpec, signal?: AbortSignal): Promise<Applied<ChannelState>> {
		const n = normalizeChannel(spec.ch);
		const p = `:CHANnel${n}`;
		const c = this.client;
		if (spec.on !== undefined) await c.command(`${p}:SWITch ${spec.on ? "ON" : "OFF"}`, { signal });
		if (spec.probe !== undefined) await c.command(`${p}:PROBe VALue,${fmt(spec.probe)}`, { signal });
		if (spec.coupling !== undefined) await c.command(`${p}:COUPling ${spec.coupling.toUpperCase()}`, { signal });
		if (spec.bwlimit !== undefined) await c.command(`${p}:BWLimit ${spec.bwlimit.toUpperCase()}`, { signal });
		if (spec.vdiv !== undefined) await c.command(`${p}:SCALe ${fmt(spec.vdiv)}`, { signal });
		if (spec.offset !== undefined) await c.command(`${p}:OFFSet ${fmt(spec.offset)}`, { signal });
		if (spec.label !== undefined) {
			await c.command(`${p}:LABel:TEXT "${spec.label.replace(/"/g, "'").slice(0, 20)}"`, { signal });
			await c.command(`${p}:LABel ${spec.label ? "ON" : "OFF"}`, { signal });
		}
		await sleep(SETTLE_SHORT_MS);
		const state = await this.channel(n, signal);
		const mismatches: string[] = [];
		if (spec.on !== undefined && state.on !== spec.on) mismatches.push(`C${n} switch: asked ${spec.on ? "ON" : "OFF"}, scope reports ${state.on ? "ON" : "OFF"}`);
		if (spec.probe !== undefined && !nearly(state.probe, spec.probe)) mismatches.push(`C${n} probe: asked ${spec.probe}×, scope reports ${state.probe}× (valid values are the probe menu's, e.g. 0.1 1 10 100 1000)`);
		if (spec.coupling !== undefined && state.coupling !== spec.coupling.toUpperCase()) mismatches.push(`C${n} coupling: asked ${spec.coupling}, scope reports ${state.coupling}`);
		if (spec.bwlimit !== undefined && state.bwlimit !== spec.bwlimit.toUpperCase()) mismatches.push(`C${n} bwlimit: asked ${spec.bwlimit}, scope reports ${state.bwlimit}`);
		if (spec.vdiv !== undefined && !nearly(state.vdiv, spec.vdiv)) mismatches.push(`C${n} vdiv: asked ${fmt(spec.vdiv)}, scope reports ${fmt(state.vdiv)} (1-2-5 steps, 500 µV..10 V/div ×probe)`);
		if (spec.offset !== undefined && !nearly(state.offset, spec.offset, 2e-3, 1e-4)) mismatches.push(`C${n} offset: asked ${fmt(spec.offset)}, scope reports ${fmt(state.offset)}`);
		return { state, mismatches };
	}

	async setTimebase(spec: TimebaseSpec, signal?: AbortSignal): Promise<Applied<TimebaseState>> {
		if (spec.scale !== undefined) {
			await this.client.command(`:TIMebase:SCALe ${fmt(spec.scale)}`, { signal });
			await sleep(SETTLE_TIMEBASE_MS);
		}
		if (spec.delay !== undefined) {
			await this.client.command(`:TIMebase:DELay ${fmt(spec.delay)}`, { signal });
			await sleep(SETTLE_SHORT_MS);
		}
		const state = await this.timebase(signal);
		const mismatches: string[] = [];
		if (spec.scale !== undefined && !nearly(state.scale, spec.scale)) mismatches.push(`timebase: asked ${fmt(spec.scale)} s/div, scope reports ${fmt(state.scale)} s/div (1-2-5 steps, 200 ps..1000 s)`);
		if (spec.delay !== undefined && !nearly(state.delay, spec.delay, 2e-3, 1e-12)) mismatches.push(`delay: asked ${fmt(spec.delay)} s, scope reports ${fmt(state.delay)} s`);
		return { state, mismatches };
	}

	async setTrigger(spec: TriggerSpec, signal?: AbortSignal): Promise<Applied<TriggerState>> {
		const c = this.client;
		const mismatches: string[] = [];
		let source: string | undefined;
		if (spec.source !== undefined) {
			source = normalizeSource(spec.source);
			await c.command(":TRIGger:TYPE EDGE", { signal });
			await c.command(`:TRIGger:EDGE:SOURce ${source}`, { signal });
		}
		if (spec.level !== undefined) await c.command(`:TRIGger:EDGE:LEVel ${fmt(spec.level)}`, { signal });
		let slope: string | undefined;
		if (spec.slope !== undefined) {
			slope = TRIGGER_SLOPES[spec.slope.toLowerCase()] ?? spec.slope.toUpperCase();
			await c.command(`:TRIGger:EDGE:SLOPe ${slope}`, { signal });
		}
		let mode: string | undefined;
		if (spec.mode !== undefined) {
			mode = TRIGGER_MODES[spec.mode.toLowerCase()] ?? spec.mode.toUpperCase();
			await c.command(`:TRIGger:MODE ${mode}`, { signal });
		}
		await sleep(SETTLE_SHORT_MS);
		const state = await this.trigger(signal);
		if (source && state.source.toUpperCase() !== source) mismatches.push(`trigger source: asked ${source}, scope reports ${state.source}${state.source.toUpperCase() === "LINE" && source !== "LINE" ? " — the scope falls back to LINE when the channel is switched OFF; turn the channel on first" : ""}`);
		if (spec.level !== undefined && !nearly(state.level, spec.level, 5e-3, 1e-4)) mismatches.push(`trigger level: asked ${fmt(spec.level)} V, scope reports ${fmt(state.level)} V (range is about ±4.1 divisions of the source channel)`);
		if (slope && !state.slope.toUpperCase().startsWith(slope.slice(0, 3).toUpperCase())) mismatches.push(`trigger slope: asked ${slope}, scope reports ${state.slope}`);
		if (mode && !state.mode.toUpperCase().startsWith(mode.slice(0, 3).toUpperCase())) mismatches.push(`trigger mode: asked ${mode}, scope reports ${state.mode}`);
		return { state, mismatches };
	}

	/** 存储深度只在 FMDepth 管理模式且非 RUN 之外的… 实测:AUTO 管理模式下设置被静默忽略;手册说要先 AUTO 触发模式。 */
	async setMemoryDepth(mdepth: string, signal?: AbortSignal): Promise<Applied<AcquireState>> {
		const c = this.client;
		const before = await this.q(":TRIGger:MODE?", undefined, signal);
		await c.command(":TRIGger:MODE AUTO", { signal });
		await c.command(":ACQuire:MMANagement FMDepth", { signal });
		await c.command(`:ACQuire:MDEPth ${mdepth}`, { signal });
		await sleep(SETTLE_SHORT_MS);
		const err = await c.checkError();
		if (before.toUpperCase() !== "AUTO") await c.command(`:TRIGger:MODE ${before}`, { signal });
		const state = await this.acquire(signal);
		const mismatches: string[] = [];
		if (state.mdepth.toUpperCase() !== mdepth.toUpperCase()) mismatches.push(`memory depth: asked ${mdepth}, scope reports ${state.mdepth}${err ? ` (${err.message})` : ""} — this model accepts 10k 100k 1M 10M (50M only when fewer channels are on)`);
		return { state, mismatches };
	}

	async run(signal?: AbortSignal): Promise<void> {
		await this.client.command(":TRIGger:RUN", { signal });
	}

	async stop(signal?: AbortSignal): Promise<void> {
		await this.client.command(":TRIGger:STOP", { signal });
	}

	/** 武装单次:手册的套路是先 STOP 再 MODE SINGle。 */
	async single(signal?: AbortSignal): Promise<void> {
		await this.client.command(":TRIGger:STOP", { signal });
		await this.client.command(":TRIGger:MODE SINGle", { signal });
		// 状态寄存器可能慢半拍:不等一下,紧接着的 :TRIGger:STATus? 会读到 STOP 留下的 "Stop",把没触发的旧屏当成新采集
		await sleep(SETTLE_SHORT_MS);
	}

	async forceTrigger(signal?: AbortSignal): Promise<void> {
		await this.client.command(":TRIGger:MODE FTRIG", { signal });
	}

	async autoset(signal?: AbortSignal): Promise<void> {
		await this.client.command(":AUToset", { signal });
		await sleep(2500);
		await this.q("*OPC?", 10_000, signal).catch(() => undefined);
	}

	/** 轮询触发状态直到 pred 为真;超时返回 false。 */
	async waitForStatus(pred: (status: string) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = await this.triggerStatus(signal);
			if (pred(status)) return { ok: true, status };
			if (Date.now() >= deadline) return { ok: false, status };
			await sleep(STATUS_POLL_MS);
		}
	}

	waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
		return this.waitForStatus((s) => /stop/i.test(s), timeoutMs, signal);
	}

	// ── 波形 ─────────────────────────────────────────────────────────────

	/**
	 * 读一个通道。stride>1 只读一个窗口;stride=1 且记录超过 MAXPoint 时按交付点数推进 :STARt 分段读。
	 * maxPoints:交付点数上限,超过就自动加大 stride。
	 */
	async readWaveform(ch: number, options: { maxPoints?: number; stride?: number; signal?: AbortSignal } = {}): Promise<Waveform> {
		const n = normalizeChannel(ch);
		const { signal } = options;
		const c = this.client;
		const configuredPoints = Math.round(await this.qNum(":ACQuire:POINts?", signal));
		const sampleRate = await this.qNum(":ACQuire:SRATe?", signal);
		const tdiv = await this.qNum(":TIMebase:SCALe?", signal);
		const delay = await this.qNum(":TIMebase:DELay?", signal);
		const probe = await this.qNum(`:CHANnel${n}:PROBe?`, signal);
		const unit = (await this.q(`:CHANnel${n}:UNIT?`, undefined, signal)).toUpperCase() || "V";
		const maxPoint = Math.max(1, Math.round((await this.qNum(":WAVeform:MAXPoint?", signal).catch(() => 5_000_000))));
		// 五个状态全是粘的,每次都写全;先按整段读 preamble —— 它的 WAVE_ARRAY_COUNT 才是**这次采集**的实际点数,
		// `:ACQuire:POINts?` 是当前时基的配置值(改了时基但还没重新采集时两者不同,实测差 5 倍);取较小者,
		// 因为 :STARt 一旦越过实际数据末尾,仪器根本不回(实测挂到超时)。
		await c.command(`:WAVeform:SOURce C${n}`, { signal });
		await c.command(":WAVeform:WIDTh WORD", { signal });
		await c.command(":WAVeform:STARt 0", { signal });
		await c.command(":WAVeform:INTerval 1", { signal });
		await c.command(":WAVeform:POINt 0", { signal });
		const desc = parseWaveDesc(await c.queryBlock(":WAVeform:PREamble?", { signal, headerTimeoutMs: 5000 }));
		const recordPoints = Math.max(1, Math.min(desc.waveArrayCount > 0 ? desc.waveArrayCount : configuredPoints, configuredPoints > 0 ? configuredPoints : desc.waveArrayCount));
		let stride = Math.max(1, Math.floor(options.stride ?? 1));
		if (options.stride === undefined) {
			// 没指定 stride 时由 maxPoints 预算决定
			if (options.maxPoints && Math.floor(recordPoints / stride) > options.maxPoints) stride = Math.ceil(recordPoints / options.maxPoints);
		} else if (options.maxPoints && Math.floor(recordPoints / stride) > options.maxPoints) {
			// 显式 stride 必须照办(模型要的就是全速边沿);超预算就拒绝,不悄悄改
			throw new Error(`scope: stride ${stride} over a ${recordPoints.toLocaleString()}-point record is ${Math.floor(recordPoints / stride).toLocaleString()} points, more than the ${options.maxPoints.toLocaleString()} limit — raise stride, shorten the timebase, or lower the memory depth (scope setup mdepth)`);
		}
		if (stride > 1) await c.command(`:WAVeform:INTerval ${stride}`, { signal });
		// MAXPoint 是按**源点**截窗口的(stride 5000 时一窗照样只覆盖 5 M 源点,回 1000 点),所以无论 stride 多少
		// 都按源点推进 :STARt 分段读:下一窗的起点 = 已交付点数 × stride。
		const expected = Math.max(1, Math.floor(recordPoints / stride));
		const chunks: Int16Array[] = [];
		let got = 0;
		let srcPos = 0;
		const maxWindows = Math.ceil(recordPoints / maxPoint) + 2;
		for (let i = 0; i < maxWindows && got < expected && srcPos < recordPoints; i++) {
			if (srcPos > 0) await c.command(`:WAVeform:STARt ${srcPos}`, { signal });
			const block = await c.queryBlock(":WAVeform:DATA?", { signal, headerTimeoutMs: 8000 });
			const codes = decodeSamples(block, desc.commType);
			if (codes.length === 0) break;
			const int16 = codes instanceof Int16Array ? codes : Int16Array.from(codes, (v) => v * 256);
			chunks.push(int16);
			got += int16.length;
			srcPos += int16.length * stride;
		}
		if (srcPos > 0) await c.command(":WAVeform:STARt 0", { signal }).catch(() => undefined);
		const codes = chunks.length === 1 ? chunks[0]! : concat(chunks, got);
		if (codes.length === 0) throw new Error(`scope: C${n} returned no samples — is the channel on and has the scope acquired anything (status ${await this.triggerStatus().catch(() => "?")})?`);
		const scale = voltScaleOf(desc, probe);
		const interval = (desc.horizInterval > 0 ? desc.horizInterval : 1 / sampleRate) * stride;
		return {
			ch: n,
			codes,
			desc,
			scale: desc.commType === 0 ? { ...scale, codePerDiv: scale.codePerDiv * 256 } : scale, // BYTE 样本已 ×256 提到 WORD 域
			time: { delay, tdiv, interval, grid: 10 },
			stride,
			sampleRate,
			recordPoints,
			unit,
			probe: scale.probe,
		};
	}

	// ── 量测 ─────────────────────────────────────────────────────────────

	/** 用 ADVanced 的 P1..P12 槽位做量测;会改变屏幕上的量测行(那正好让人看见 agent 在测什么)。 */
	async measure(items: MeasureItem[], signal?: AbortSignal): Promise<{ results: MeasureResult[]; mismatches: string[] }> {
		if (items.length === 0) throw new Error("scope measure: give items, e.g. [{type:\"FREQ\",source:\"C1\"}]");
		if (items.length > MEASURE_SLOTS) throw new Error(`scope measure: at most ${MEASURE_SLOTS} items at once`);
		const c = this.client;
		await c.command(":MEASure ON", { signal });
		await c.command(":MEASure:MODE ADVanced", { signal });
		const mismatches: string[] = [];
		const normalized = items.map((it) => ({ type: it.type.trim().toUpperCase(), source: normalizeSource(it.source) }));
		for (let i = 0; i < normalized.length; i++) {
			const p = `:MEASure:ADVanced:P${i + 1}`;
			const it = normalized[i]!;
			await c.command(`${p} ON`, { signal });
			await c.command(`${p}:TYPE ${it.type}`, { signal });
			await c.command(`${p}:SOURce ${it.source}`, { signal });
		}
		await this.q("*OPC?", 5000, signal).catch(() => undefined);
		await sleep(150);
		const results: MeasureResult[] = [];
		for (let i = 0; i < normalized.length; i++) {
			const p = `:MEASure:ADVanced:P${i + 1}`;
			const it = normalized[i]!;
			const type = (await this.q(`${p}:TYPE?`, undefined, signal)).toUpperCase();
			if (type !== it.type && !type.startsWith(it.type.slice(0, 4))) mismatches.push(`P${i + 1}: asked type ${it.type}, scope reports ${type} — unknown measurement name? (see scope tool description for the list)`);
			const value = parseNumber(await this.q(`${p}:VALue?`, undefined, signal));
			results.push({ type: type || it.type, source: it.source, value });
		}
		return { results, mismatches };
	}

	/** 只重读已配置槽位的值(measure 之后的轮询)。 */
	async readMeasurements(count: number, signal?: AbortSignal): Promise<(number | null)[]> {
		const out: (number | null)[] = [];
		for (let i = 0; i < count; i++) out.push(parseNumber(await this.q(`:MEASure:ADVanced:P${i + 1}:VALue?`, undefined, signal)));
		return out;
	}

	// ── 截图 / 透传 ──────────────────────────────────────────────────────

	screenshot(signal?: AbortSignal): Promise<Uint8Array> {
		return this.client.queryRaw(":PRINt? PNG", pngComplete, { timeoutMs: 15_000, signal });
	}

	/** 透传一条命令:带 `?` 的按文本查询读一行;其余只写。二进制查询(DATA?/PRINt?)不走这里。 */
	async raw(command: string, signal?: AbortSignal): Promise<string | undefined> {
		const cmd = command.trim();
		if (/^:?(WAV\w*:DATA|WAV\w*:PRE\w*|PRIN\w*)\?/i.test(cmd)) throw new Error(`scope raw: ${cmd} returns binary — use scope capture / screenshot instead`);
		if (cmd.includes("?")) {
			try {
				return await this.q(cmd, 5000, signal);
			} catch (error) {
				if (error instanceof ScpiTimeoutError) return undefined;
				throw error;
			}
		}
		await this.client.command(cmd, { signal });
		return undefined;
	}

	checkError(): Promise<{ code: number; message: string } | undefined> {
		return this.client.checkError();
	}
}

function concat(chunks: Int16Array[], total: number): Int16Array {
	const out = new Int16Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

/** SCPI 数值:够短的十进制或科学计数;避免 JS 的 "1e-7" 之类被某些固件拒绝 → 用大写 E。 */
export function fmt(v: number): string {
	if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
	const s = v.toPrecision(6).replace(/\.?0+(?=e|$)/i, "");
	return s.replace("e", "E");
}

export { COUPLING_ENUM };
