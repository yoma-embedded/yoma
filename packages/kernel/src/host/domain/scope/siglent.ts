/**
 * Siglent SDS(新式 `:` 命令树,SDS800X HD / 1000X HD / 2000X HD 一族)驱动,实现 driver.ts 的 ScopeDriver。
 * 目前只在 SDS824X HD 上验证过;其它型号按 limits.ts 的表连接并在 warnings 里说明"未验证"。
 *
 * 三条纪律:
 *  - **设了就读回**。这一族没有可靠的错误队列(本机固件的 `:SYSTem:ERRor?` 能用,老固件超时),
 *    非法值要么被静默拒绝、要么被静默改成别的(触发源给了关着的通道 → 落到 LINE)。每个 setter
 *    返回的是仪器读回的真实状态,调用方对比后把差异说给模型听。
 *  - **时基类命令要等**:`:TIMebase:SCALe` 之后 ~500ms 内的下一条命令有几率失效(实测有人踩过
 *    "跳到最小时基")。存储深度与时基都放在 AUTO 触发模式的窗口里改(ngscopeclient 的 SetSampleDepth /
 *    SetSampleRate 同样做法:Stop 态下改这两样会被吃掉),读回不是读一次,是读到连续两次一致为止。
 *  - **读波形先停**:RUN 状态下读到的是双缓冲里的哪一帧没有文档保证;要一致快照就 STOP 或
 *    SINGle→Stop 再读。记录长度信 preamble 的 WAVE_ARRAY_COUNT(实际采集),不信 `:ACQuire:POINts?`(配置值);
 *    MAXPoint 截的是源点窗口,stride 多大都按 "已交付点数 × stride" 推进 :STARt 分段读(2026-09-04 真机核实)。
 *    一窗少给几点不算错(SDS2000X HD 固件 1.2.3.1 不总遵守 MAXPoint,ngscopeclient 实测),按实际交付数推进;
 *    总数对不上才是错。
 */
import { parseNumber } from "./analyze.ts";
import {
	type AcquireState,
	type Applied,
	type ChannelSpec,
	type ChannelState,
	type MeasureItem,
	type MeasureResult,
	type ReadWaveformOptions,
	type ScopeAddress,
	type ScopeCapabilities,
	type ScopeDriver,
	type ScopeDriverSpec,
	type ScopeIdentity,
	type ScopeModelInfo,
	type ScopeOpenOptions,
	type ScopeStatus,
	type TimebaseSpec,
	type TimebaseState,
	type TriggerSpec,
	type TriggerState,
	type Waveform,
	isKnownTriggerStatus,
	parseScopeAddress,
	scopeAddressKey,
} from "./driver.ts";
import { type SiglentFamily, VERIFIED_MODELS, canonicalDepth, siglentFamily } from "./limits.ts";
import { COUPLING_ENUM, decodeSamples, isEmptyWaveDesc, parseWaveDesc, type WaveDesc, voltScaleOf, waveDescTimestamp } from "./preamble.ts";
import { SIGLENT_USB_VID, type ScpiClient, ScpiTimeoutError, openScpi, parseIdn, pngComplete } from "./scpi.ts";

/** Siglent 的波形:中性字段之外还带原始描述块(测试与诊断用;工具层不看它)。 */
export interface SiglentWaveform extends Waveform {
	desc: WaveDesc;
}

export const CHANNEL_COUNT = 4;
export const MEASURE_SLOTS = 12;
export const TRIGGER_SOURCES = ["C1", "C2", "C3", "C4", "LINE"] as const;
export const COUPLINGS = ["DC", "AC", "GND"] as const;
export const BWLIMITS = ["FULL", "20M"] as const;
export const PROBE_MENU = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
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
/** 时基/深度改完之后的读回:两次一致就算稳,最多读这么多次 */
const READBACK_TRIES = 5;
const READBACK_GAP_MS = 100;
/**
 * 触发电平的读回容差,按源通道 vdiv 的比例算。SDS824X HD 实测电平步长是 vdiv/60(2026-09-17:7 V/div 时 0.5 → 0.467,
 * 0.4 → 0.35),最多偏 vdiv/120;给到 vdiv/20,超过才是仪器真没照办(超出 ±4.1 格被夹住之类)。读回值总是照实放在 state.level。
 */
const LEVEL_TOLERANCE_DIV = 0.05;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("scope: aborted"));
	return new Promise((resolve, reject) => {
		const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(done, ms);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("scope: aborted")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function finite(value: number, name: string, positive = false): number {
	if (!Number.isFinite(value) || (positive && value <= 0)) throw new Error(`scope: ${name} must be ${positive ? "positive and " : ""}finite`);
	return value;
}

function integer(value: number, name: string): number {
	finite(value, name, true);
	if (!Number.isSafeInteger(value)) throw new Error(`scope: ${name} must be a positive integer`);
	return value;
}

function token(value: string, name: string): void {
	if (!/^[a-z0-9.]+$/i.test(value)) throw new Error(`scope: invalid ${name}`);
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

/** 这台是不是 Siglent 的示波器(SDS);SDG / SPD / SDM 是别的仪器,不接。 */
export function siglentSupports(idn: ScopeIdentity): boolean {
	return /siglent/i.test(idn.vendor) && /^SDS/i.test(idn.model.trim());
}

export class SiglentScope implements ScopeDriver {
	readonly driver = "siglent";
	readonly address: ScopeAddress;
	readonly identity: ScopeIdentity;
	readonly family: SiglentFamily;
	readonly warnings: readonly string[];
	private lastStatus?: ScopeStatus;
	private constructor(readonly client: ScpiClient, address: ScopeAddress, identity: ScopeIdentity) {
		this.address = { ...address, driver: "siglent" };
		this.identity = identity;
		this.family = siglentFamily(identity.model);
		this.warnings = this.family.verified
			? []
			: [`${identity.model} has not been verified by yoma on hardware (verified: ${VERIFIED_MODELS.join(", ")}); settings tables are advisory and readbacks are the only source of truth.`];
	}

	get label(): string {
		return scopeAddressKey(this.address);
	}

	static async open(address: ScopeAddress | string, options: ScopeOpenOptions = {}): Promise<SiglentScope> {
		const addr = typeof address === "string" ? parseScopeAddress(address) : address;
		if (addr.kind === "none") throw new Error("scope: the siglent driver needs a usb or LAN address");
		const client = await openScpi(addr, { ...options, usbVendorIds: [SIGLENT_USB_VID] });
		try {
			// USB 的输出队列跨连接残留(上一个进程超时留下的截图会被当成 *IDN? 的答案),先清。
			await client.drain(200);
			const line = await client.query("*IDN?", { timeoutMs: 3000, signal: options.signal });
			const idn = parseIdn(line);
			if (!/siglent/i.test(idn.vendor)) throw new Error(`scope: ${scopeAddressKey(addr)} answered *IDN? with "${line}" — not a Siglent scope`);
			return await SiglentScope.attach(client, addr, idn, options.signal);
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
	}

	/** 接管一条已经问过 *IDN? 的连接(注册表自动识别那条路也走这里)。失败时由调用方关连接。 */
	static async attach(client: ScpiClient, address: ScopeAddress, idn: ScopeIdentity, signal?: AbortSignal): Promise<SiglentScope> {
		if (!siglentSupports(idn)) throw new Error(`scope: ${idn.vendor} ${idn.model} is not a Siglent SDS oscilloscope (the siglent driver does not drive generators, supplies or meters)`);
		const scope = new SiglentScope(client, address, idn);
		client.setInterCommandMs(scope.family.interCommandMs);
		// 若 USB 侧用无序列号的 "usb" 打开,把实际序列号补进地址,便于持久化
		if (address.kind === "usb" && !address.serial && idn.serial) (scope as { address: ScopeAddress }).address = { kind: "usb", serial: idn.serial, driver: "siglent" };
		// 别的客户端可能把应答头留在 LONG 模式(`C1:VDIV 1.00E+00`),那样 qNum 一个数都解不出;
		// 连接时钉成 OFF(ngscopeclient 也这么做)。固件若不认这条,只会在错误队列里留一条 -113,顺手吃掉。
		await client.command("CHDR OFF", { signal });
		await client.checkError().catch(() => undefined);
		return scope;
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
		n = normalizeChannel(n);
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
		for (let n = 1; n <= Math.min(CHANNEL_COUNT, this.family.channels); n++) channels.push(await this.channel(n, signal));
		const status = { idn: this.identity, channels, timebase: await this.timebase(signal), trigger: await this.trigger(signal), acquire: await this.acquire(signal) };
		this.lastStatus = status;
		return status;
	}

	triggerStatus(signal?: AbortSignal): Promise<string> {
		return this.q(":TRIGger:STATus?", undefined, signal);
	}

	/** 合法取值:词表是这一族的常量,存储深度与采样率按已开通道数查 limits.ts 的表。 */
	capabilities(status: ScopeStatus | undefined = this.lastStatus): ScopeCapabilities {
		const enabled = status ? status.channels.filter((c) => c.on).length : 1;
		return {
			driver: this.driver,
			model: this.identity.model,
			verified: this.family.verified,
			channels: this.family.channels,
			enabledChannels: enabled,
			units: ["V", "A"],
			couplings: [...COUPLINGS],
			bwlimits: [...BWLIMITS],
			probes: [...PROBE_MENU],
			customProbe: this.family.customProbe,
			timebase: { min: 200e-12, max: 1000, steps: "1-2-5" },
			triggerTypes: ["edge"],
			triggerSources: TRIGGER_SOURCES.slice(0, this.family.channels).concat("LINE"),
			triggerSlopes: ["rising", "falling", "alternate"],
			triggerModes: ["auto", "normal", "single"],
			memoryDepths: this.family.memoryDepths(Math.max(1, enabled)),
			sampleRates: this.family.sampleRates(Math.max(1, enabled)),
			measureTypes: [...MEASURE_TYPES],
			externalTrigger: false,
			screenshot: true,
			measurements: true,
		};
	}

	// ── 设置(设了就读回)────────────────────────────────────────────────

	/** 深度、时基这类在 Stop 态下会被仪器吃掉的设置,先切 AUTO 再改,改完把触发模式放回去。 */
	private async withAutoTriggerMode<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const before = await this.q(":TRIGger:MODE?", undefined, signal);
		await this.client.command(":TRIGger:MODE AUTO", { signal });
		try {
			return await fn();
		} finally {
			if (before.toUpperCase() !== "AUTO") await this.client.command(`:TRIGger:MODE ${before}`, { signal });
		}
	}

	/** 读到连续两次一致为止(仪器改时基/深度是异步的,读一次可能读到中间态)。 */
	private async settledNumber(command: string, signal?: AbortSignal): Promise<number> {
		let last = await this.qNum(command, signal);
		for (let i = 1; i < READBACK_TRIES; i++) {
			await sleep(READBACK_GAP_MS, signal);
			const next = await this.qNum(command, signal);
			if (nearly(next, last)) return next;
			last = next;
		}
		return last;
	}

	async setChannel(spec: ChannelSpec, signal?: AbortSignal): Promise<Applied<ChannelState>> {
		const n = normalizeChannel(spec.ch);
		if (spec.unit !== undefined && spec.unit !== "V" && spec.unit !== "A") throw new Error("scope: unit must be V or A");
		if (spec.probe !== undefined) finite(spec.probe, "probe", true);
		if (spec.vdiv !== undefined) finite(spec.vdiv, "vdiv", true);
		if (spec.offset !== undefined) finite(spec.offset, "offset");
		if (spec.coupling !== undefined) token(spec.coupling, "coupling");
		if (spec.bwlimit !== undefined) token(spec.bwlimit, "bandwidth limit");
		if (spec.label !== undefined && /[\r\n;]/.test(spec.label)) throw new Error("scope: label cannot contain a command separator");
		const p = `:CHANnel${n}`;
		const c = this.client;
		// 关着的通道上 SCALe / OFFSet 会被仪器**静默丢掉**(SDS824X HD 实测 2026-09-17;探头、耦合、带宽、单位、标签照收)。
		// 所以要改 vdiv/offset 就先把通道打开,设完再按要求的开关状态放回去:"配好再停掉"和"停着改量程"一次调用都能做到。
		// 代价是关着的通道会短暂打开一下(已开通道数瞬时变化,深度/采样率可能跟着换档再换回来)。
		const wasOn = (await this.q(`${p}:SWITch?`, undefined, signal)).toUpperCase() === "ON";
		const finalOn = spec.on ?? wasOn;
		const needOn = spec.vdiv !== undefined || spec.offset !== undefined;
		const switchOn = !wasOn && (spec.on === true || needOn);
		if (switchOn) await c.command(`${p}:SWITch ON`, { signal });
		// SDS800X HD Programming Guide p.61: UNIT changes scale/offset/trigger units too.
		if (spec.unit !== undefined) await c.command(`${p}:UNIT ${spec.unit}`, { signal });
		if (spec.probe !== undefined) await c.command(`${p}:PROBe VALue,${fmt(spec.probe)}`, { signal });
		if (spec.coupling !== undefined) await c.command(`${p}:COUPling ${spec.coupling.toUpperCase()}`, { signal });
		if (spec.bwlimit !== undefined) await c.command(`${p}:BWLimit ${spec.bwlimit.toUpperCase()}`, { signal });
		if (spec.vdiv !== undefined) await c.command(`${p}:SCALe ${fmt(spec.vdiv)}`, { signal });
		if (spec.offset !== undefined) await c.command(`${p}:OFFSet ${fmt(spec.offset)}`, { signal });
		if (spec.label !== undefined) {
			await c.command(`${p}:LABel:TEXT "${spec.label.replace(/"/g, "'").slice(0, 20)}"`, { signal });
			await c.command(`${p}:LABel ${spec.label ? "ON" : "OFF"}`, { signal });
		}
		if (!finalOn && (wasOn || switchOn)) await c.command(`${p}:SWITch OFF`, { signal });
		await sleep(SETTLE_SHORT_MS, signal);
		const state = await this.channel(n, signal);
		const offHint = !state.on && spec.on !== false ? " — the scope ignores vdiv/offset while the channel is off; switch it on first" : "";
		const mismatches: string[] = [];
		if (spec.on !== undefined && state.on !== spec.on) mismatches.push(`C${n} switch: asked ${spec.on ? "ON" : "OFF"}, scope reports ${state.on ? "ON" : "OFF"}`);
		if (spec.unit !== undefined && state.unit !== spec.unit) mismatches.push(`C${n} unit: asked ${spec.unit}, scope reports ${state.unit}`);
		if (spec.probe !== undefined && !nearly(state.probe, spec.probe)) mismatches.push(`C${n} probe: asked ${spec.probe}×, scope reports ${state.probe}× (menu values: ${PROBE_MENU.join(" ")}${this.family.customProbe ? "; this family also takes custom factors, so a refusal means the value is out of range" : ""})`);
		if (spec.coupling !== undefined && state.coupling !== spec.coupling.toUpperCase()) mismatches.push(`C${n} coupling: asked ${spec.coupling}, scope reports ${state.coupling}`);
		if (spec.bwlimit !== undefined && state.bwlimit !== spec.bwlimit.toUpperCase()) mismatches.push(`C${n} bwlimit: asked ${spec.bwlimit}, scope reports ${state.bwlimit}`);
		if (spec.vdiv !== undefined && !nearly(state.vdiv, spec.vdiv)) mismatches.push(`C${n} vdiv: asked ${fmt(spec.vdiv)}, scope reports ${fmt(state.vdiv)} ${state.unit}/div (1-2-5 steps; range depends on probe setting)${offHint}`);
		if (spec.offset !== undefined && !nearly(state.offset, spec.offset, 2e-3, 1e-4)) mismatches.push(`C${n} offset: asked ${fmt(spec.offset)}, scope reports ${fmt(state.offset)}${offHint}`);
		return { state, mismatches };
	}

	async setTimebase(spec: TimebaseSpec, signal?: AbortSignal): Promise<Applied<TimebaseState>> {
		if (spec.scale !== undefined) finite(spec.scale, "timebase scale", true);
		if (spec.delay !== undefined) finite(spec.delay, "timebase delay");
		if (spec.scale !== undefined) {
			const scale = spec.scale;
			await this.withAutoTriggerMode(async () => {
				await this.client.command(`:TIMebase:SCALe ${fmt(scale)}`, { signal });
				await sleep(SETTLE_TIMEBASE_MS, signal);
				await this.settledNumber(":TIMebase:SCALe?", signal);
			}, signal);
		}
		if (spec.delay !== undefined) {
			await this.client.command(`:TIMebase:DELay ${fmt(spec.delay)}`, { signal });
			await sleep(SETTLE_SHORT_MS, signal);
		}
		const state = await this.timebase(signal);
		const mismatches: string[] = [];
		if (spec.scale !== undefined && !nearly(state.scale, spec.scale)) mismatches.push(`timebase: asked ${fmt(spec.scale)} s/div, scope reports ${fmt(state.scale)} s/div (1-2-5 steps, 200 ps..1000 s)`);
		if (spec.delay !== undefined && !nearly(state.delay, spec.delay, 2e-3, 1e-12)) mismatches.push(`delay: asked ${fmt(spec.delay)} s, scope reports ${fmt(state.delay)} s`);
		return { state, mismatches };
	}

	async setTrigger(spec: TriggerSpec, signal?: AbortSignal): Promise<Applied<TriggerState>> {
		if (spec.type !== undefined && !/^edge$/i.test(spec.type)) throw new Error(`scope: trigger type "${spec.type}" is not supported by this driver yet (edge only)`);
		if (spec.level !== undefined) finite(spec.level, "trigger level");
		if (spec.mode !== undefined) token(spec.mode, "trigger mode");
		if (spec.slope !== undefined) token(spec.slope, "trigger slope");
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
		await sleep(SETTLE_SHORT_MS, signal);
		const state = await this.trigger(signal);
		if (source && state.source.toUpperCase() !== source) mismatches.push(`trigger source: asked ${source}, scope reports ${state.source}${state.source.toUpperCase() === "LINE" && source !== "LINE" ? " — the scope falls back to LINE when the channel is switched OFF; turn the channel on first" : ""}`);
		if (spec.level !== undefined) {
			const src = /^C([1-4])$/.exec(state.source.toUpperCase());
			const vdiv = src ? await this.qNum(`:CHANnel${src[1]}:SCALe?`, signal).catch(() => Number.NaN) : Number.NaN;
			const tolerance = Number.isFinite(vdiv) && vdiv > 0 ? vdiv * LEVEL_TOLERANCE_DIV : 1e-4;
			if (!nearly(state.level, spec.level, 5e-3, Math.max(1e-4, tolerance))) mismatches.push(`trigger level: asked ${fmt(spec.level)}, scope reports ${fmt(state.level)} (source channel units; the level is quantized to a fraction of a division and clamped to about ±4.1 divisions of the source channel)`);
		}
		if (slope && !state.slope.toUpperCase().startsWith(slope.slice(0, 3).toUpperCase())) mismatches.push(`trigger slope: asked ${slope}, scope reports ${state.slope}`);
		if (mode && !state.mode.toUpperCase().startsWith(mode.slice(0, 3).toUpperCase())) mismatches.push(`trigger mode: asked ${mode}, scope reports ${state.mode}`);
		return { state, mismatches };
	}

	/** 存储深度只在 FMDepth 管理模式且 AUTO 触发模式下生效(实测:AUTO 管理模式下设置被静默忽略;Stop 态下也被吃掉)。 */
	async setMemoryDepth(mdepth: string, signal?: AbortSignal): Promise<Applied<AcquireState>> {
		if (!/^\d+(?:\.\d+)?[KM]?$/i.test(mdepth)) throw new Error("scope: invalid memory depth");
		const c = this.client;
		const err = await this.withAutoTriggerMode(async () => {
			await c.command(":ACQuire:MMANagement FMDepth", { signal });
			await c.command(`:ACQuire:MDEPth ${mdepth}`, { signal });
			await sleep(SETTLE_SHORT_MS, signal);
			return c.checkError();
		}, signal);
		const state = await this.acquire(signal);
		const mismatches: string[] = [];
		if (canonicalDepth(state.mdepth) !== canonicalDepth(mdepth)) {
			const enabled = this.lastStatus ? this.lastStatus.channels.filter((ch) => ch.on).length : undefined;
			const legal = this.family.memoryDepths(Math.max(1, enabled ?? 1));
			const hint = legal.length
				? `this model accepts ${legal.join(" ")} with ${enabled ?? "one"} channel(s) on (larger depths need fewer channels)`
				: "legal depths for this model are unknown; check the instrument's Acquire menu";
			mismatches.push(`memory depth: asked ${mdepth}, scope reports ${state.mdepth}${err ? ` (${err.message})` : ""} — ${hint}`);
		}
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
		await sleep(SETTLE_SHORT_MS, signal);
	}

	async forceTrigger(signal?: AbortSignal): Promise<void> {
		await this.client.command(":TRIGger:MODE FTRIG", { signal });
	}

	async autoset(signal?: AbortSignal): Promise<void> {
		await this.client.command(":AUToset", { signal });
		await sleep(2500, signal);
		await this.q("*OPC?", 10_000, signal).catch(() => undefined);
	}

	/** 轮询触发状态直到 pred 为真;超时返回 false。词表之外的状态是协议失步,立刻报而不是空转到超时。 */
	async waitForStatus(pred: (status: string) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
		const deadline = Date.now() + finite(timeoutMs, "trigger wait timeout", true);
		for (;;) {
			const status = await this.triggerStatus(signal);
			if (!isKnownTriggerStatus(status)) throw new Error(`scope: unexpected trigger status ${JSON.stringify(status)} — the response stream may be out of sync; disconnect and reconnect`);
			if (pred(status)) return { ok: true, status };
			if (Date.now() >= deadline) return { ok: false, status };
			await sleep(Math.min(STATUS_POLL_MS, Math.max(0, deadline - Date.now())), signal);
		}
	}

	waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
		return this.waitForStatus((s) => /stop/i.test(s), timeoutMs, signal);
	}

	// ── 波形 ─────────────────────────────────────────────────────────────

	/**
	 * 读一个通道。记录超过 MAXPoint 时按交付点数 × stride 推进 :STARt 分段读。
	 * maxPoints:交付点数上限,超过就自动加大 stride。
	 */
	async readWaveform(ch: number, options: ReadWaveformOptions = {}): Promise<SiglentWaveform> {
		const n = normalizeChannel(ch);
		if (options.maxPoints !== undefined) integer(options.maxPoints, "maxPoints");
		if (options.stride !== undefined) integer(options.stride, "stride");
		const timeout = finite(options.timeoutMs ?? 60_000, "waveform timeout", true);
		const timed = AbortSignal.timeout(Math.ceil(timeout));
		const signal = options.signal ? AbortSignal.any([options.signal, timed]) : timed;
		const c = this.client;
		// 关着的通道没有记录可读:仪器对它的 DATA? 行为没有文档保证,先拒绝
		if ((await this.q(`:CHANnel${n}:SWITch?`, undefined, signal)).toUpperCase() !== "ON") throw new Error(`scope: C${n} is off; enable it before reading its waveform`);
		// Preamble is the frozen acquisition length; current ACQuire:POINts may describe a later setting.
		const sampleRate = finite(await this.qNum(":ACQuire:SRATe?", signal), "sample rate", true);
		const tdiv = finite(await this.qNum(":TIMebase:SCALe?", signal), "timebase scale", true);
		const delay = await this.qNum(":TIMebase:DELay?", signal);
		const probe = finite(await this.qNum(`:CHANnel${n}:PROBe?`, signal), "probe", true);
		const unit = (await this.q(`:CHANnel${n}:UNIT?`, undefined, signal)).toUpperCase() || "V";
		const maxPoint = integer(await this.qNum(":WAVeform:MAXPoint?", signal), "maximum waveform window");
		// 五个状态全是粘的,每次都写全;先按整段读 preamble —— 它的 WAVE_ARRAY_COUNT 才是**这次采集**的实际点数,
		// `:ACQuire:POINts?` 是当前时基的配置值(改了时基但还没重新采集时两者不同,实测差 5 倍),不用于截断。
		// :STARt 一旦越过实际数据末尾,仪器根本不回(实测挂到超时)。
		await c.command(`:WAVeform:SOURce C${n}`, { signal });
		await c.command(":WAVeform:WIDTh WORD", { signal });
		await c.command(":WAVeform:STARt 0", { signal });
		await c.command(":WAVeform:INTerval 1", { signal });
		await c.command(":WAVeform:POINt 0", { signal });
		const block = await c.queryBlock(":WAVeform:PREamble?", { signal, headerTimeoutMs: 5000 });
		if (isEmptyWaveDesc(block)) {
			// 武装了单次却在触发前 STOP(或 SINGle 模式下 RUN 再 STOP),记录是空的;不是描述块坏了
			const mode = await this.q(":TRIGger:MODE?", undefined, signal).catch(() => "?");
			const status = await this.triggerStatus(signal).catch(() => "?");
			throw new Error(`scope: C${n} has no completed acquisition (trigger mode ${mode}, status ${status}) — stopping an armed single before it triggers leaves an empty record; run in auto mode then stop, or single and wait for Stop, then read again`);
		}
		const desc = parseWaveDesc(block);
		const recordPoints = integer(desc.waveArrayCount, "acquired record length");
		if (recordPoints > 50_000_000) throw new Error("scope: waveform record exceeds 50 million points");
		let stride = Math.max(1, Math.floor(options.stride ?? 1));
		if (options.stride === undefined) {
			// 没指定 stride 时由 maxPoints 预算决定
			if (options.maxPoints && Math.floor(recordPoints / stride) > options.maxPoints) stride = Math.ceil(recordPoints / options.maxPoints);
		} else if (options.maxPoints && Math.floor(recordPoints / stride) > options.maxPoints) {
			// 显式 stride 必须照办(模型要的就是全速边沿);超预算就拒绝,不悄悄改
			const legal = this.family.memoryDepths(Math.max(1, this.lastStatus?.channels.filter((x) => x.on).length ?? 1));
			const fits = legal.filter((d) => depthPoints(d) !== undefined && depthPoints(d)! / stride <= options.maxPoints!);
			throw new Error(`scope: stride ${stride} over a ${recordPoints.toLocaleString()}-point record is ${Math.floor(recordPoints / stride).toLocaleString()} points, more than the ${options.maxPoints.toLocaleString()} limit — raise stride, shorten the timebase, or lower the memory depth (scope setup mdepth${fits.length ? `; ${fits.join("/")} would fit` : ""})`);
		}
		if (stride > 1) await c.command(`:WAVeform:INTerval ${stride}`, { signal });
		// MAXPoint 是按**源点**截窗口的(stride 5000 时一窗照样只覆盖 5 M 源点,回 1000 点),所以无论 stride 多少
		// 都按源点推进 :STARt 分段读:下一窗的起点 = 已交付点数 × stride。
		const expected = Math.floor(recordPoints / stride);
		if (expected < 1 || stride > maxPoint) throw new Error("scope: stride is larger than the waveform window; lower stride");
		const chunks: Int16Array[] = [];
		let got = 0;
		let srcPos = 0;
		// 仪器可以一窗少给(不遵守 MAXPoint 的固件),按实际交付数推进;窗口数预算按最坏一半页给
		const maxWindows = Math.ceil(recordPoints / maxPoint) * 2 + 2;
		for (let i = 0; i < maxWindows && got < expected && srcPos < recordPoints; i++) {
			if (srcPos > 0) await c.command(`:WAVeform:STARt ${srcPos}`, { signal });
			const block = await c.queryBlock(":WAVeform:DATA?", { signal, headerTimeoutMs: 8000 });
			const codes = decodeSamples(block, desc.commType);
			const windowPoints = Math.min(expected - got, Math.floor(Math.min(recordPoints - srcPos, maxPoint) / stride));
			if (codes.length > windowPoints) throw new Error(`scope: C${n} waveform window at ${srcPos} returned ${codes.length} samples, more than the ${windowPoints} requested`);
			if (codes.length === 0) throw new Error(`scope: C${n} waveform window at ${srcPos} returned no samples (expected ${windowPoints})`);
			const int16 = codes instanceof Int16Array ? codes : Int16Array.from(codes, (v) => v * 256);
			chunks.push(int16);
			got += int16.length;
			srcPos += int16.length * stride;
		}
		if (srcPos > 0) await c.command(":WAVeform:STARt 0", { signal }).catch(() => undefined);
		if (got !== expected) throw new Error(`scope: incomplete C${n} waveform: expected ${expected} samples, received ${got}`);
		const codes = chunks.length === 1 ? chunks[0]! : concat(chunks, got);
		if (codes.length === 0) throw new Error(`scope: C${n} returned no samples — is the channel on and has the scope acquired anything (status ${await this.triggerStatus().catch(() => "?")})?`);
		const scale = voltScaleOf(desc, probe);
		const interval = finite(desc.horizInterval * stride, "sample interval", true);
		const acquiredAt = waveDescTimestamp(desc);
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
			...(acquiredAt ? { acquiredAt } : {}),
		};
	}

	// ── 量测 ─────────────────────────────────────────────────────────────

	/** 用 ADVanced 的 P1..P12 槽位做量测;会改变屏幕上的量测行(那正好让人看见 agent 在测什么)。 */
	async measure(items: MeasureItem[], signal?: AbortSignal): Promise<{ results: MeasureResult[]; mismatches: string[] }> {
		if (items.length === 0) throw new Error("scope measure: give items, e.g. [{type:\"FREQ\",source:\"C1\"}]");
		if (items.length > MEASURE_SLOTS) throw new Error(`scope measure: at most ${MEASURE_SLOTS} items at once`);
		for (const item of items) {
			token(item.type, "measurement type");
			if (normalizeSource(item.source) === "LINE") throw new Error("scope: measurement source must be C1..C4; LINE is a trigger source");
		}
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
		await sleep(150, signal);
		const results: MeasureResult[] = [];
		for (let i = 0; i < normalized.length; i++) {
			const p = `:MEASure:ADVanced:P${i + 1}`;
			const it = normalized[i]!;
			const type = (await this.q(`${p}:TYPE?`, undefined, signal)).toUpperCase();
			const source = (await this.q(`${p}:SOURce?`, undefined, signal)).toUpperCase();
			if (type !== it.type && !type.startsWith(it.type.slice(0, 4))) mismatches.push(`P${i + 1}: asked type ${it.type}, scope reports ${type} — unknown measurement name? (see capabilities.measureTypes)`);
			if (source !== it.source) mismatches.push(`P${i + 1}: asked source ${it.source}, scope reports ${source}`);
			const value = parseNumber(await this.q(`${p}:VALue?`, undefined, signal));
			results.push({ type: type || it.type, source, value });
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

/** "10k" / "1M" / "10000" → 点数;认不出就 undefined。 */
export function depthPoints(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(text.trim());
	if (!m) return undefined;
	return Number(m[1]) * (m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : 1);
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
	finite(v, "SCPI number");
	if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
	const s = v.toPrecision(6).replace(/\.?0+(?=e|$)/i, "");
	return s.replace("e", "E");
}

/** 注册项:registry.ts 把它放进驱动表。 */
export const SIGLENT_DRIVER: ScopeDriverSpec = {
	name: "siglent",
	description: "Siglent SDS oscilloscopes with the ':' command tree (SDS800X HD / 1000X HD / 2000X HD / 2000X+ / 3000X HD) over USBTMC or LAN 5025",
	usbVendorIds: [SIGLENT_USB_VID],
	supports: siglentSupports,
	open: (address, options) => SiglentScope.open(address, options),
	attach: (client, address, idn) => SiglentScope.attach(client, address, idn),
	models(): ScopeModelInfo[] {
		return [
			{ model: "SDS824X HD", transports: ["usb", "tcp"], example: "siglent@usb:<serial> or <ip>:5025", verified: "hardware", note: "200 MHz, 4 channels; yoma acceptance 2026-09-16 over USB on macOS" },
			{ model: "SDS8xxX HD (other 800X HD)", transports: ["usb", "tcp"], example: "usb:<serial>", verified: "untested", note: "same command tree; depth table from datasheet" },
			{ model: "SDS1000X HD", transports: ["usb", "tcp"], example: "usb:<serial>", verified: "untested" },
			{ model: "SDS2000X HD / SDS2000X+ / SDS3000X HD", transports: ["usb", "tcp"], example: "<ip>:5025", verified: "untested", note: "connects with warnings; depth/rate tables unknown, readbacks only" },
		];
	},
};

export { COUPLING_ENUM };
