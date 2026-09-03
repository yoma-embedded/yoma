/**
 * scope 工具:Siglent SDS824X HD 示波器 —— 让模型看得到模拟世界:电源纹波、边沿、时序、真实电平。
 *
 * 纯 TypeScript,不经引擎:USB(node-usb 3,USBTMC,免驱免编译)或 LAN(SCPI 5025 口)。
 * 语义全在 core/scope:传输与分帧(scpi.ts)、WAVEDESC 与换算(preamble.ts)、统计与文本示意图(analyze.ts)、
 * 落盘(store.ts)、Siglent 驱动(siglent.ts)。
 *
 * 纪律:
 *  - **不占 probe.lock**:示波器是独立仪器,"gdb 握着 ST-Link 同时看波形"正是要支持的组合。
 *  - **连接按需、闲置即放**:仪器只接一个客户端(USB 也是)。每个动作结束后 90s 没人用就断开,
 *    下一次动作重连;于是 EasyScopeX / 浏览器控制页在 agent 不用的时候能拿到仪器。
 *  - **设了就读回**:仪器对非法值静默拒绝或静默改成别的(见 siglent.ts),每条差异都要说给模型听。
 *  - **details 只放摘要**:样本永远在 <工程>/.yoma/scope/<id>/(c<n>.i16 + capture.json),截图在
 *    <工程>/.yoma/scope/screens/。模型要细节就 scope samples,不重采。
 *  - **读波形先停**:capture 默认 STOP → 读 → 恢复 RUN;要抓"复位那一瞬间"用 arm/collect(与 la 同样的套路)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import { asciiPlot, findEdges, si, type WaveStats, waveStats } from "../scope/analyze.ts";
import { codeToVolts, indexOfTime, type TimeScale, timeOfIndex, type VoltScale } from "../scope/preamble.ts";
import { formatScpiAddress, listUsbScopes, parseScpiAddress, type ScpiAddress } from "../scope/scpi.ts";
import { type ChannelState, MEASURE_SLOTS, MEASURE_TYPES, type ScopeStatus, SiglentScope, type Waveform, normalizeChannel } from "../scope/siglent.ts";
import {
	CAPTURE_JSON,
	SCOPE_DIR,
	SCOPE_SCREENS_DIR,
	type ScopeCaptureListing,
	type ScopeCaptureMeta,
	type StoredChannel,
	listCaptures,
	readChannelCodes,
	readScopeConfig,
	writeCapture,
	writeScopeConfig,
} from "../scope/store.ts";
import { capEngineOutput, clamp, stamp } from "./engines.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const SCOPE_ACTIONS = ["connect", "status", "setup", "capture", "arm", "collect", "measure", "samples", "screenshot", "list", "raw"] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];

// Union 必须写显式元组:ARRAY.map(Type.Literal) 会丢元组结构,Static 塌成 never(la.ts 同注)。
const scopeSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("connect"),
			Type.Literal("status"),
			Type.Literal("setup"),
			Type.Literal("capture"),
			Type.Literal("arm"),
			Type.Literal("collect"),
			Type.Literal("measure"),
			Type.Literal("samples"),
			Type.Literal("screenshot"),
			Type.Literal("list"),
			Type.Literal("raw"),
		],
		{ description: "connect | status | setup | capture | arm | collect | measure | samples | screenshot | list | raw" },
	),
	address: Type.Optional(
		Type.String({
			description: 'connect (or any action while not connected): "usb" (first Siglent on USB), "usb:<serial>", or "<ip>[:5025]" over LAN. Remembered in <project>/.yoma/scope.json; omit afterwards.',
		}),
	),
	// ── setup / capture ──
	channels: Type.Optional(
		Type.Array(
			Type.Object({
				ch: Type.Number({ description: "1..4" }),
				on: Type.Optional(Type.Boolean()),
				vdiv: Type.Optional(Type.Number({ description: "volts per division (probe factor included), 1-2-5 steps" })),
				offset: Type.Optional(Type.Number({ description: "vertical offset in volts" })),
				coupling: Type.Optional(Type.String({ description: "DC | AC | GND" })),
				probe: Type.Optional(Type.Number({ description: "probe attenuation as set on the probe switch: 1, 10, 100…" })),
				bwlimit: Type.Optional(Type.String({ description: "FULL | 20M" })),
				label: Type.Optional(Type.String({ description: "on-screen channel label, e.g. VBUS" })),
			}),
			{ description: "setup: channel settings to apply. capture/arm: which channels to read (just ch); default = all channels that are on." },
		),
	),
	timebase: Type.Optional(
		Type.Object(
			{
				scale: Type.Optional(Type.Number({ description: "seconds per division (10 divisions on screen), 1-2-5 steps, 200e-12..1000" })),
				delay: Type.Optional(Type.Number({ description: "trigger delay in seconds (0 = trigger at screen centre)" })),
			},
			{ description: "setup/arm: horizontal settings." },
		),
	),
	trigger: Type.Optional(
		Type.Object(
			{
				mode: Type.Optional(Type.String({ description: "auto | normal | single | force" })),
				source: Type.Optional(Type.String({ description: "C1..C4 or LINE (this model has no external trigger input). Turn the channel on first." })),
				level: Type.Optional(Type.Number({ description: "trigger level in volts" })),
				slope: Type.Optional(Type.String({ description: "rising | falling | alternate" })),
			},
			{ description: "setup/arm: edge trigger settings." },
		),
	),
	mdepth: Type.Optional(Type.String({ description: "setup: memory depth 10k | 100k | 1M | 10M (sample rate follows: depth / (10 × timebase))." })),
	run: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("stop"), Type.Literal("single"), Type.Literal("force")], { description: "setup: acquisition control after applying settings." })),
	autoset: Type.Optional(Type.Boolean({ description: "setup: press Autoset first (the scope picks vertical/horizontal/trigger for whatever is on the probes)." })),
	// ── capture / collect ──
	points: Type.Optional(Type.Number({ description: "capture/collect: max samples per channel to fetch and store (default 4000, up to 2000000). The record is decimated evenly, so a stored capture cannot be re-read at full rate — capture with more points (or stride=1 over a short timebase) when you need edge timing." })),
	stride: Type.Optional(Type.Number({ description: "capture/collect: keep every Nth sample instead of letting points decide (1 = full rate)." })),
	mode: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("single")], { description: "capture: current (default: freeze what is on screen, read, resume) or single (arm a single trigger, wait for it, read)." })),
	timeoutMs: Type.Optional(Type.Number({ description: "capture mode=single / collect: how long to wait for the trigger (default 10000 / 30000)." })),
	resume: Type.Optional(Type.Boolean({ description: "capture/collect: restore the previous trigger mode and RUN afterwards (default true)." })),
	plot: Type.Optional(Type.Boolean({ description: "capture/collect/samples: include a text plot per channel (default true)." })),
	// ── measure ──
	items: Type.Optional(
		Type.Array(Type.Object({ type: Type.String({ description: "PKPK MAX MIN AMPL TOP BASE MEAN RMS PER FREQ PWID NWID DUTY RISE FALL … (scope's own measurement engine)" }), source: Type.String({ description: "C1..C4" }) }), {
			description: `measure: up to ${MEASURE_SLOTS} scope-side measurements.`,
		}),
	),
	repeat: Type.Optional(Type.Number({ description: "measure: read the values this many times (default 1, max 500) — a cheap live trend without transferring waveforms." })),
	intervalMs: Type.Optional(Type.Number({ description: "measure: spacing between repeats (default 250)." })),
	// ── samples ──
	capture: Type.Optional(Type.String({ description: "samples: capture id from list (default: the most recent)." })),
	channel: Type.Optional(Type.Number({ description: "samples: channel number (default: the first stored)." })),
	fromUs: Type.Optional(Type.Number({ description: "samples: window start, µs relative to the trigger point (negative = before trigger)." })),
	toUs: Type.Optional(Type.Number({ description: "samples: window end, µs." })),
	every: Type.Optional(Type.Number({ description: "samples: print every Nth stored sample (default: chosen to fit limit rows)." })),
	limit: Type.Optional(Type.Number({ description: "samples: max rows (default 200, max 5000)." })),
	edges: Type.Optional(Type.Boolean({ description: "samples: list level crossings (time, direction, pulse width) instead of a value table — for timing questions." })),
	threshold: Type.Optional(Type.Number({ description: "samples edges: crossing level in volts (default: midway between min and max)." })),
	// ── raw ──
	commands: Type.Optional(Type.Array(Type.String(), { description: 'raw: SCPI commands to send in order; ones containing "?" are queries and their replies are returned. Binary queries (:WAVeform:DATA?, :PRINt?) are refused — use capture / screenshot.' })),
});

export type ScopeToolInput = Static<typeof scopeSchema>;

export interface ScopeChannelStats {
	min: number;
	max: number;
	pp: number;
	mean: number;
	rms: number;
	freq?: number;
	period?: number;
	duty?: number;
	rise?: number;
	fall?: number;
	edges?: number;
}

export interface ScopeChannelDetails {
	/** 1..4 */
	ch: number;
	on?: boolean;
	label?: string;
	/** V/div,已含探头衰减 */
	vdiv?: number;
	offset?: number;
	coupling?: string;
	probe?: number;
	unit?: string;
	bwlimit?: string;
	/** 本次采集落盘的样本数 */
	points?: number;
	stats?: ScopeChannelStats;
}

export interface ScopeMeasurement {
	type: string;
	source: string;
	/** null = 示波器报 "****"(无法测量) */
	value: number | null;
	unit?: string;
	n?: number;
	min?: number;
	max?: number;
	mean?: number;
}

export interface ScopeToolDetails {
	action: ScopeAction;
	/** "usb:<serial>" 或 "host:port" */
	address?: string;
	model?: string;
	serial?: string;
	firmware?: string;
	captureId?: string;
	dir?: string;
	/** 截图/采集文件的绝对路径 */
	file?: string;
	sampleRate?: number;
	interval?: number;
	points?: number;
	mdepth?: string;
	timebase?: { scale: number; delay: number };
	trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string };
	channels?: ScopeChannelDetails[];
	measurements?: ScopeMeasurement[];
	armed?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
	/** 截图字节数 */
	bytes?: number;
}

export interface ScopeToolOptions {
	/** 测试注入:替换真实的打开逻辑(默认 SiglentScope.open)。 */
	open?: (address: ScpiAddress, signal?: AbortSignal) => Promise<SiglentScope>;
	/** 闲置多久断开(ms),默认 90000;0 = 不自动断开 */
	idleCloseMs?: number;
	/** 测试注入:替换 USB 枚举 */
	listUsb?: () => Promise<{ serial?: string; product?: string }[]>;
}

const DEFAULT_POINTS = 4000;
const MAX_POINTS = 2_000_000;
const DEFAULT_IDLE_CLOSE_MS = 90_000;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SAMPLE_ROWS = 200;

const DESCRIPTION = `Oscilloscope (Siglent SDS824X HD, 4 ch / 200 MHz / 12-bit) over USB or LAN: read real analog waveforms, measure, and see the screen. Where log/gdb tell you what the firmware thinks happened, this shows what the wires actually did — supply rails and ripple, reset and enable edges, PWM shape, clock quality, glitches, ringing, timing between two signals.

Actions:
- connect (address?): open the instrument and remember the address. "usb" finds the scope on the USB cable; "<ip>:5025" over LAN. status: current settings + trigger state without changing anything.
- setup: apply channel / timebase / trigger / memory depth settings and read them back — every value the scope changed or refused is reported. run: run|stop|single|force. autoset: let the scope pick settings for whatever is on the probes (good first move on an unknown signal).
- capture: fetch waveforms (default: all channels that are on, decimated to ~4000 points each), store them under <project>/.yoma/scope/<id>/, and return per-channel stats (Vpp, min, max, mean, RMS, frequency, duty, rise/fall) plus a text plot. mode=single arms a single trigger and waits for it first.
- arm + collect: arm a single trigger now (optionally with trigger/timebase/channel settings), then do the thing — flash, reset, poke the board — and collect: that is how you catch a power-up, a reset pulse, or the first bus transaction.
- measure (items): the scope's own measurement engine, e.g. [{type:"FREQ",source:"C1"},{type:"PKPK",source:"C2"}]. repeat=N gives min/max/mean over N reads — a live trend with no waveform transfer. Types: PKPK MAX MIN AMPL TOP BASE MEAN RMS STDEV PER FREQ PWID NWID DUTY NDUTY WID RISE FALL DELAY … (${MEASURE_TYPES.length} in all, the scope's names).
- samples: the numbers behind a stored capture — a value table for a time window (fromUs/toUs, relative to the trigger), or edges=true for level crossings with pulse widths.
- screenshot: the scope screen as a PNG, attached as an image and saved under .yoma/scope/screens/.
- list: stored captures. raw (commands): any SCPI command from the Siglent programming guide; queries return their reply.

Rules:
- Probe attenuation must match the physical probe switch (setup channels[].probe) or every voltage is off by 10×.
- The scope is one instrument for everyone: it is opened per action and released after 90 s idle, so the front panel / EasyScopeX are usable in between. The USB cable and the LAN port both work; over LAN close the browser control page first (one client at a time).
- Points are a budget: 4000 decimated points show the shape; for edge timing capture with stride=1 over a short timebase, or use measure — the scope measures at full rate for free.
- A capture whose trigger never fired proves nothing: check the trigger source is a channel that is ON, the level sits inside the signal, and the event really happens inside the wait.
- Time in samples/edges is relative to the trigger point (negative = before). The full waveform stays on disk; narrow the window instead of re-capturing.`;

interface ArmedState {
	at: number;
	channels?: number[];
	points?: number;
	stride?: number;
	prevMode?: string;
}

export function createScopeToolDefinition(env: ExecutionEnv, options: ScopeToolOptions = {}): ToolDefinition<typeof scopeSchema, ScopeToolDetails> {
	const root = path.join(env.cwd, SCOPE_DIR);
	const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
	const openScope = options.open ?? ((address: ScpiAddress) => SiglentScope.open(address));
	const listUsb = options.listUsb ?? listUsbScopes;

	let scope: SiglentScope | undefined;
	let address: ScpiAddress | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let armed: ArmedState | undefined;
	let lastCaptureId: string | undefined;

	async function dropScope(): Promise<void> {
		const s = scope;
		scope = undefined;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		if (s) await s.close().catch(() => undefined);
	}

	/** 动作进行中不自动断开(measure repeat 一次能跑两分钟);动作结束再起表。 */
	function disarmIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	}

	function armIdle(): void {
		disarmIdle();
		if (idleCloseMs > 0 && scope) {
			idleTimer = setTimeout(() => {
				void dropScope();
			}, idleCloseMs);
			(idleTimer as unknown as { unref?: () => void }).unref?.();
		}
	}

	async function resolveAddress(requested: string | undefined): Promise<ScpiAddress> {
		if (requested) return parseScpiAddress(requested);
		if (address) return address;
		const saved = await readScopeConfig(env.cwd);
		if (saved) return parseScpiAddress(saved.address);
		const usb = await listUsb().catch(() => []);
		if (usb.length > 0) return { kind: "usb", serial: usb[0]!.serial };
		throw new Error(
			"scope: no instrument address. Plug the scope's rear USB Device port into this computer (it is found automatically), or connect it over LAN and pass address \"<ip>:5025\" — the IP is on the scope under Utility > Menu > I/O > LAN Config (tick DHCP there if it shows a stale address). Then run scope connect.",
		);
	}

	async function ensureScope(requested: string | undefined, signal?: AbortSignal): Promise<SiglentScope> {
		const want = await resolveAddress(requested);
		disarmIdle();
		if (scope && address && (!requested || sameTarget(want, address))) return scope;
		await dropScope();
		const s = await openScope(want, signal);
		scope = s;
		address = s.address;
		return s;
	}

	/** "usb"(不带序列号)指的就是当前打开的那台;TCP 比 host:port。 */
	function sameTarget(want: ScpiAddress, have: ScpiAddress): boolean {
		if (want.kind === "usb" && have.kind === "usb") return !want.serial || want.serial === have.serial;
		return formatScpiAddress(want) === formatScpiAddress(have);
	}

	function isConnectionError(error: unknown): boolean {
		const msg = error instanceof Error ? error.message : String(error);
		return /connection .* closed|USB read failed|is closed|EPIPE|ECONNRESET|not opened|No such device/i.test(msg);
	}

	// ── 文本 ─────────────────────────────────────────────────────────────

	function describeChannel(c: ChannelState): string {
		if (!c.on) return `C${c.ch} off`;
		return `C${c.ch}${c.label ? ` (${c.label})` : ""} ON  ${si(c.vdiv, `${c.unit}/div`)}  offset ${si(c.offset, c.unit)}  ${c.coupling}  ${c.probe}×  BW ${c.bwlimit}`;
	}

	function describeStatus(st: ScopeStatus): string[] {
		const tb = st.timebase;
		const tr = st.trigger;
		const aq = st.acquire;
		return [
			...st.channels.map(describeChannel),
			`timebase ${si(tb.scale, "s/div")} (${si(tb.scale * 10, "s")} across)  delay ${si(tb.delay, "s")}  ·  ${si(aq.sampleRate, "Sa/s")}  ${aq.points.toLocaleString()} pts/record  memory ${aq.mdepth}${aq.management ? ` (${aq.management})` : ""}`,
			`trigger ${tr.type} ${tr.source} ${tr.slope.toLowerCase()} @ ${si(tr.level, "V")}  mode ${tr.mode}  status ${tr.status}`,
		];
	}

	function statusDetails(action: ScopeAction, s: SiglentScope, st: ScopeStatus): ScopeToolDetails {
		return {
			action,
			address: s.label,
			model: st.idn.model,
			serial: st.idn.serial,
			firmware: st.idn.firmware,
			sampleRate: st.acquire.sampleRate,
			points: st.acquire.points,
			mdepth: st.acquire.mdepth,
			timebase: { scale: st.timebase.scale, delay: st.timebase.delay },
			trigger: { mode: st.trigger.mode, source: st.trigger.source, level: st.trigger.level, slope: st.trigger.slope, status: st.trigger.status },
			channels: st.channels.map((c) => ({ ch: c.ch, on: c.on, label: c.label, vdiv: c.vdiv, offset: c.offset, coupling: c.coupling, probe: c.probe, unit: c.unit, bwlimit: c.bwlimit })),
		};
	}

	function statsLine(u: string, st: WaveStats): string {
		const parts = [`Vpp ${si(st.pp, u)}`, `min ${si(st.min, u)}`, `max ${si(st.max, u)}`, `mean ${si(st.mean, u)}`, `rms ${si(st.rms, u)}`];
		if (st.freq) parts.push(`freq ${si(st.freq, "Hz")} (period ${si(st.period ?? 0, "s")})`);
		if (st.duty !== undefined) parts.push(`duty ${(st.duty * 100).toFixed(1)}%`);
		if (st.rise !== undefined) parts.push(`rise ${si(st.rise, "s")}`);
		if (st.fall !== undefined) parts.push(`fall ${si(st.fall, "s")}`);
		parts.push(`${st.edges} edges`);
		return parts.join("  ");
	}

	// ── 采集 ─────────────────────────────────────────────────────────────

	async function enabledChannels(s: SiglentScope, signal?: AbortSignal): Promise<number[]> {
		const on: number[] = [];
		for (let n = 1; n <= 4; n++) if ((await s.client.query(`:CHANnel${n}:SWITch?`, { signal })).toUpperCase() === "ON") on.push(n);
		return on;
	}

	async function readAndStore(
		action: ScopeAction,
		s: SiglentScope,
		mode: string,
		channels: number[],
		points: number,
		stride: number | undefined,
		plot: boolean,
		signal?: AbortSignal,
	): Promise<{ text: string; details: ScopeToolDetails }> {
		const waves: Waveform[] = [];
		// 显式 stride 时 points 不再决定抽样,只当硬上限(超了 readWaveform 会拒绝并说明)
		for (const ch of channels) waves.push(await s.readWaveform(ch, { maxPoints: stride !== undefined ? MAX_POINTS : points, stride, signal }));
		const id = `scope-${stamp()}`;
		const dir = path.join(root, id);
		const first = waves[0]!;
		const trigger = await s.trigger(signal);
		const mdepth = await s.client.query(":ACQuire:MDEPth?", { signal }).catch(() => undefined);
		const stored: StoredChannel[] = [];
		const samples = new Map<number, Int16Array>();
		const details: ScopeToolDetails = {
			action,
			address: s.label,
			model: s.identity.model,
			serial: s.identity.serial,
			captureId: id,
			dir,
			sampleRate: first.sampleRate,
			interval: first.time.interval,
			points: first.codes.length,
			mdepth,
			timebase: { scale: first.time.tdiv, delay: first.time.delay },
			trigger: { mode: trigger.mode, source: trigger.source, level: trigger.level, slope: trigger.slope, status: trigger.status },
			channels: [],
		};
		const lines: string[] = [
			`capture ${id}: ${channels.length} channel${channels.length > 1 ? "s" : ""} × ${first.codes.length.toLocaleString()} points, ${si(first.time.interval, "s")}/pt (record ${first.recordPoints.toLocaleString()} pts @ ${si(first.sampleRate, "Sa/s")}, stride ${first.stride}), timebase ${si(first.time.tdiv, "s/div")}, delay ${si(first.time.delay, "s")}, t = ${si(timeOfIndex(0, first.time), "s")} … ${si(timeOfIndex(first.codes.length - 1, first.time), "s")} relative to trigger`,
			`trigger ${trigger.type} ${trigger.source} ${trigger.slope.toLowerCase()} @ ${si(trigger.level, "V")} (${trigger.mode}, status ${trigger.status})`,
		];
		for (const w of waves) {
			const chState = await s.channel(w.ch, signal);
			const st = waveStats(w.codes, w.scale, w.time.interval);
			samples.set(w.ch, w.codes);
			stored.push({
				ch: w.ch,
				label: chState.label,
				file: `c${w.ch}.i16`,
				points: w.codes.length,
				vdiv: chState.vdiv,
				offset: chState.offset,
				coupling: chState.coupling,
				probe: w.probe,
				unit: w.unit,
				bwlimit: chState.bwlimit,
				gain: w.scale.gain,
				rawOffset: w.scale.offset,
				codePerDiv: w.scale.codePerDiv,
			});
			details.channels!.push({
				ch: w.ch,
				on: true,
				label: chState.label,
				vdiv: chState.vdiv,
				offset: chState.offset,
				coupling: chState.coupling,
				probe: w.probe,
				unit: w.unit,
				bwlimit: chState.bwlimit,
				points: w.codes.length,
				stats: { min: st.min, max: st.max, pp: st.pp, mean: st.mean, rms: st.rms, freq: st.freq, period: st.period, duty: st.duty, rise: st.rise, fall: st.fall, edges: st.edges },
			});
			lines.push(`C${w.ch}${chState.label ? ` (${chState.label})` : ""}: ${si(chState.vdiv, `${w.unit}/div`)} ${chState.coupling} ${w.probe}×  ${statsLine(w.unit, st)}`);
			if (plot) lines.push(asciiPlot(w.codes, w.scale, w.time, { label: `C${w.ch}` }));
		}
		const meta: ScopeCaptureMeta = {
			id,
			createdAt: Date.now(),
			address: s.label,
			model: s.identity.model,
			serial: s.identity.serial,
			mode,
			timebase: { scale: first.time.tdiv, delay: first.time.delay },
			sampleRate: first.sampleRate,
			interval: first.time.interval,
			stride: first.stride,
			recordPoints: first.recordPoints,
			mdepth,
			trigger: details.trigger,
			channels: stored,
		};
		await writeCapture(dir, meta, samples);
		lastCaptureId = id;
		lines.push(`samples on disk: ${dir} (scope samples for a value table or edges; scope screenshot to see the screen).`);
		return { text: lines.join("\n"), details };
	}

	function captureChannels(params: ScopeToolInput): number[] | undefined {
		if (!params.channels?.length) return undefined;
		return [...new Set(params.channels.map((c) => normalizeChannel(c.ch)))];
	}

	async function applySettings(s: SiglentScope, params: ScopeToolInput, signal?: AbortSignal): Promise<{ applied: string[]; mismatches: string[] }> {
		const applied: string[] = [];
		const mismatches: string[] = [];
		if (params.autoset) {
			await s.autoset(signal);
			applied.push("autoset");
		}
		for (const c of params.channels ?? []) {
			const { ch, ...rest } = c;
			if (Object.keys(rest).length === 0) continue;
			const r = await s.setChannel({ ch: normalizeChannel(ch), ...rest }, signal);
			applied.push(`C${r.state.ch}: ${describeChannel(r.state)}`);
			mismatches.push(...r.mismatches);
		}
		if (params.timebase && (params.timebase.scale !== undefined || params.timebase.delay !== undefined)) {
			const r = await s.setTimebase(params.timebase, signal);
			applied.push(`timebase ${si(r.state.scale, "s/div")} delay ${si(r.state.delay, "s")}`);
			mismatches.push(...r.mismatches);
		}
		if (params.mdepth) {
			const r = await s.setMemoryDepth(params.mdepth, signal);
			applied.push(`memory ${r.state.mdepth} → ${si(r.state.sampleRate, "Sa/s")}, ${r.state.points.toLocaleString()} pts/record`);
			mismatches.push(...r.mismatches);
		}
		if (params.trigger && Object.values(params.trigger).some((v) => v !== undefined)) {
			const r = await s.setTrigger(params.trigger, signal);
			applied.push(`trigger ${r.state.source} ${r.state.slope.toLowerCase()} @ ${si(r.state.level, "V")} mode ${r.state.mode}`);
			mismatches.push(...r.mismatches);
		}
		return { applied, mismatches };
	}

	/** 读回的模式("NORMal")要换回可设置的 token;之前就是单次的话留在 Stop 是它想要的。 */
	async function restoreRun(s: SiglentScope, prevMode: string | undefined, signal?: AbortSignal): Promise<void> {
		const mode = (prevMode ?? "AUTO").toUpperCase();
		if (mode.startsWith("SING") || mode.startsWith("FTRIG")) return;
		await s.client.command(`:TRIGger:MODE ${mode.startsWith("NORM") ? "NORMal" : "AUTO"}`, { signal });
		await s.run(signal);
		// 读一次状态:让 RUN 真正落到仪器上再返回(写只是交给了内核缓冲),闲置断开时不会把它截在半路
		await s.triggerStatus(signal).catch(() => undefined);
	}

	return {
		name: "scope",
		label: "oscilloscope",
		description: DESCRIPTION,
		promptSnippet: "Siglent oscilloscope (USB/LAN): capture analog waveforms with stats and a text plot, scope-side measurements, screenshots, arm/collect around a reset",
		promptGuidelines: [
			"For analog questions (is the rail clean? does the reset/enable edge look right? what does the PWM/clock actually look like? how long between two signals?) use scope capture / measure instead of inferring from code or logs; set the probe factor first.",
		],
		parameters: scopeSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const action = params.action;
			try {
				switch (action) {
					case "connect": {
						const s = await ensureScope(params.address, signal);
						const st = await s.status(signal);
						await writeScopeConfig(env.cwd, { address: s.label });
						const usb = s.address.kind === "usb" ? await listUsb().catch(() => []) : [];
						const others = usb.filter((d) => d.serial && d.serial !== s.identity.serial);
						const lines = [
							`connected: ${st.idn.vendor} ${st.idn.model}  SN ${st.idn.serial}  firmware ${st.idn.firmware}  via ${s.label} (remembered in .yoma/scope.json)`,
							...describeStatus(st),
						];
						if (others.length) lines.push(`also on USB: ${others.map((d) => `${d.product ?? "Siglent"} ${d.serial}`).join(", ")} — pick one with address "usb:<serial>"`);
						lines.push("next: scope setup (probe factor, channels, timebase, trigger) or scope autoset; scope capture to read waveforms; scope measure for numbers; scope screenshot to look at the screen.");
						return { content: [{ type: "text", text: lines.join("\n") }], details: statusDetails(action, s, st) };
					}

					case "status": {
						const s = await ensureScope(params.address, signal);
						const st = await s.status(signal);
						return { content: [{ type: "text", text: [`${st.idn.model} SN ${st.idn.serial} via ${s.label}`, ...describeStatus(st), armed ? `armed since ${new Date(armed.at).toISOString()} (scope collect to read)` : ""].filter(Boolean).join("\n") }], details: { ...statusDetails(action, s, st), armed: armed ? true : undefined } };
					}

					case "setup": {
						const s = await ensureScope(params.address, signal);
						const { applied, mismatches } = await applySettings(s, params, signal);
						if (params.run) {
							if (params.run === "run") await s.run(signal);
							else if (params.run === "stop") await s.stop(signal);
							else if (params.run === "single") await s.single(signal);
							else await s.forceTrigger(signal);
							applied.push(`acquisition: ${params.run}`);
						}
						if (applied.length === 0) throw new Error("scope setup: nothing to apply — give channels / timebase / trigger / mdepth / run / autoset");
						const err = await s.checkError();
						const st = await s.status(signal);
						const lines = [`applied: ${applied.join("; ")}`];
						for (const m of mismatches) lines.push(`⚠ ${m}`);
						if (err) lines.push(`⚠ scope reported error ${err.code}: ${err.message}`);
						lines.push(...describeStatus(st));
						return { content: [{ type: "text", text: lines.join("\n") }], details: statusDetails(action, s, st) };
					}

					case "capture": {
						const s = await ensureScope(params.address, signal);
						const mode = params.mode ?? "current";
						const points = clamp(params.points, DEFAULT_POINTS, 16, MAX_POINTS);
						const channels = captureChannels(params) ?? (await enabledChannels(s, signal));
						if (channels.length === 0) throw new Error("scope capture: no channel is on — scope setup channels=[{ch:1,on:true,probe:10,vdiv:…}] first");
						const prevMode = await s.client.query(":TRIGger:MODE?", { signal });
						const before = await s.triggerStatus(signal);
						let timedOut = false;
						let status = before;
						const waitMs = clamp(params.timeoutMs, 10_000, 100, 60 * 60_000);
						if (mode === "single") {
							await s.single(signal);
							const w = await s.waitForStop(waitMs, signal);
							status = w.status;
							if (!w.ok) timedOut = true;
						} else if (!/stop/i.test(before)) {
							await s.stop(signal);
							const w = await s.waitForStop(3000, signal);
							status = w.status;
						}
						if (timedOut) {
							const tr = await s.trigger(signal);
							if (params.resume !== false) await restoreRun(s, prevMode, signal);
							return {
								content: [{ type: "text", text: `capture: no trigger within ${(waitMs / 1e3).toFixed(1)} s (status ${status}); nothing read. Trigger is ${tr.type} ${tr.source} ${tr.slope.toLowerCase()} @ ${si(tr.level, "V")} — is that channel on, is the level inside the signal, does the event happen during the wait? mode=current reads whatever is on screen without waiting.` }],
								details: { action, address: s.label, timedOut: true, trigger: { mode: tr.mode, source: tr.source, level: tr.level, slope: tr.slope, status } },
							};
						}
						const out = await readAndStore(action, s, mode, channels, points, params.stride, params.plot !== false, signal);
						if (params.resume !== false) await restoreRun(s, prevMode, signal);
						return { content: [{ type: "text", text: out.text }], details: out.details };
					}

					case "arm": {
						const s = await ensureScope(params.address, signal);
						const { applied, mismatches } = await applySettings(s, { ...params, run: undefined, autoset: undefined }, signal);
						const prevMode = await s.client.query(":TRIGger:MODE?", { signal });
						await s.single(signal);
						const tr = await s.trigger(signal);
						armed = { at: Date.now(), channels: captureChannels(params), points: params.points, stride: params.stride, prevMode: prevMode.toUpperCase().startsWith("SING") ? "AUTO" : prevMode };
						const lines = [
							`armed: single trigger ${tr.type} ${tr.source} ${tr.slope.toLowerCase()} @ ${si(tr.level, "V")} (status ${tr.status}). Now do the thing (flash / reset / poke the board), then scope collect.`,
						];
						if (applied.length) lines.unshift(`applied: ${applied.join("; ")}`);
						for (const m of mismatches) lines.push(`⚠ ${m}`);
						if (tr.source.toUpperCase() === "LINE") lines.push("⚠ trigger source is LINE (mains) — that will fire on its own, not on your signal. Set trigger.source to a channel that is on.");
						return { content: [{ type: "text", text: lines.join("\n") }], details: { action, address: s.label, armed: true, trigger: { mode: tr.mode, source: tr.source, level: tr.level, slope: tr.slope, status: tr.status } } };
					}

					case "collect": {
						if (!armed) throw new Error("scope collect: nothing armed — scope arm first (or scope capture mode=single to arm and wait in one go)");
						const s = await ensureScope(params.address, signal);
						const w = await s.waitForStop(clamp(params.timeoutMs, 30_000, 100, 60 * 60_000), signal);
						if (!w.ok) {
							const tr = await s.trigger(signal);
							return {
								content: [{ type: "text", text: `collect: still waiting — no trigger since arming (${((Date.now() - armed.at) / 1e3).toFixed(0)} s ago; status ${w.status}). Trigger is ${tr.type} ${tr.source} ${tr.slope.toLowerCase()} @ ${si(tr.level, "V")}. Do the thing that should fire it and collect again, or scope setup run=stop to give up.` }],
								details: { action, address: s.label, armed: true, timedOut: true, trigger: { mode: tr.mode, source: tr.source, level: tr.level, slope: tr.slope, status: w.status } },
							};
						}
						const a = armed;
						const channels = captureChannels(params) ?? a.channels ?? (await enabledChannels(s, signal));
						if (channels.length === 0) throw new Error("scope collect: no channel is on — scope setup channels=[{ch:1,on:true,…}] and arm again");
						const points = clamp(params.points ?? a.points, DEFAULT_POINTS, 16, MAX_POINTS);
						// 读成功才算收完:读到一半断线时触发过的那一屏还停在仪器上,再 collect 一次就能拿到
						const out = await readAndStore(action, s, "single", channels, points, params.stride ?? a.stride, params.plot !== false, signal);
						armed = undefined;
						if (params.resume !== false) await restoreRun(s, a.prevMode, signal);
						return { content: [{ type: "text", text: out.text }], details: out.details };
					}

					case "measure": {
						if (!params.items?.length) throw new Error('scope measure requires items, e.g. [{type:"FREQ",source:"C1"},{type:"PKPK",source:"C1"}]');
						const s = await ensureScope(params.address, signal);
						const repeat = clamp(params.repeat, 1, 1, 500);
						const intervalMs = clamp(params.intervalMs, 250, 20, 10_000);
						const first = await s.measure(params.items, signal);
						const series: (number | null)[][] = first.results.map((r) => [r.value]);
						for (let i = 1; i < repeat; i++) {
							if (signal?.aborted) break;
							await new Promise((r) => setTimeout(r, intervalMs));
							const vals = await s.readMeasurements(first.results.length, signal);
							vals.forEach((v, k) => series[k]!.push(v));
						}
						const measurements: ScopeMeasurement[] = first.results.map((r, k) => {
							const valid = series[k]!.filter((v): v is number => v !== null);
							const unit = /FREQ/.test(r.type) ? "Hz" : /PER|WID|RISE|FALL|DELAY|TMAX|TMIN|TIMEL|SKEW|^F[RF][RF]$|^L[RF][RF]$|TS[RF]|TH[RF]/.test(r.type) ? "s" : /DUTY|OVS|PRE|PHA/.test(r.type) ? "%" : /CYCLES|EDGES|PULSES/.test(r.type) ? "" : "V";
							const m: ScopeMeasurement = { type: r.type, source: r.source, value: valid.length ? valid[valid.length - 1]! : null, unit, n: valid.length };
							if (valid.length > 1) {
								m.min = Math.min(...valid);
								m.max = Math.max(...valid);
								m.mean = valid.reduce((a, b) => a + b, 0) / valid.length;
							}
							return m;
						});
						const fmtVal = (v: number | null, unit: string) => (v === null ? "****" : unit === "%" || unit === "" ? `${v}${unit}` : si(v, unit));
						const lines = measurements.map((m) => {
							const head = `${m.type.padEnd(8)} ${m.source}: ${fmtVal(m.value, m.unit ?? "")}`;
							return repeat > 1 ? `${head}   over ${m.n}/${repeat} reads: min ${fmtVal(m.min ?? null, m.unit ?? "")}  max ${fmtVal(m.max ?? null, m.unit ?? "")}  mean ${fmtVal(m.mean ?? null, m.unit ?? "")}` : head;
						});
						for (const mm of first.mismatches) lines.push(`⚠ ${mm}`);
						if (measurements.some((m) => m.value === null)) lines.push("**** = the scope has no value for that item right now (no signal, no edges, or the channel is off).");
						return { content: [{ type: "text", text: lines.join("\n") }], details: { action, address: s.label, measurements } };
					}

					case "samples": {
						const all = await listCaptures(env.cwd);
						const pick = params.capture ?? lastCaptureId ?? all[0]?.id;
						if (!pick) throw new Error("scope samples: no capture yet — scope capture first");
						const meta = all.find((m) => m.id === pick);
						if (!meta) throw new Error(`scope samples: no capture named ${pick} (scope list shows them)`);
						const chNum = params.channel !== undefined ? normalizeChannel(params.channel) : meta.channels[0]?.ch;
						const stored = meta.channels.find((c) => c.ch === chNum);
						if (!stored) throw new Error(`scope samples: capture ${meta.id} has no C${chNum} (stored: ${meta.channels.map((c) => `C${c.ch}`).join(", ")})`);
						const codes = await readChannelCodes(meta.dir, stored);
						const scale: VoltScale = { gain: stored.gain, offset: stored.rawOffset, codePerDiv: stored.codePerDiv, probe: stored.probe };
						const time: TimeScale = { delay: meta.timebase.delay, tdiv: meta.timebase.scale, interval: meta.interval, grid: 10 };
						const n = codes.length;
						const from = params.fromUs !== undefined ? Math.max(0, Math.floor(indexOfTime(params.fromUs * 1e-6, time))) : 0;
						const to = params.toUs !== undefined ? Math.min(n, Math.ceil(indexOfTime(params.toUs * 1e-6, time)) + 1) : n;
						if (to <= from) throw new Error(`scope samples: empty window — the capture spans ${si(timeOfIndex(0, time), "s")} … ${si(timeOfIndex(n - 1, time), "s")} relative to the trigger`);
						const win = codes.subarray(from, to);
						const st = waveStats(win, scale, meta.interval);
						const limit = clamp(params.limit, DEFAULT_SAMPLE_ROWS, 1, 5000);
						const head = `# ${meta.id} C${stored.ch}${stored.label ? ` (${stored.label})` : ""}  window ${si(timeOfIndex(from, time), "s")} … ${si(timeOfIndex(to - 1, time), "s")}  ${win.length.toLocaleString()} samples @ ${si(meta.interval, "s")}/pt  ${statsLine(stored.unit, st)}`;
						const lines: string[] = [head];
						let truncated = false;
						if (params.edges) {
							const pp = st.max - st.min;
							const levelV = params.threshold ?? (st.min + st.max) / 2;
							const levelCode = (levelV / scale.probe + scale.offset) * (scale.codePerDiv / scale.gain);
							const hysCode = Math.max(2, ((pp * 0.1) / scale.probe) * (scale.codePerDiv / scale.gain));
							const edges = findEdges(win, levelCode, hysCode, limit + 1);
							truncated = edges.length > limit;
							lines.push(`edges at ${si(levelV, stored.unit)} (hysteresis ±${si((hysCode * scale.gain * scale.probe) / scale.codePerDiv, stored.unit)}): ${Math.min(edges.length, limit)}${truncated ? "+" : ""}`);
							lines.push("t               dir   width to next edge");
							for (let i = 0; i < Math.min(edges.length, limit); i++) {
								const e = edges[i]!;
								const next = edges[i + 1];
								const t = timeOfIndex(from + e.index, time);
								lines.push(`${si(t, "s").padEnd(15)} ${e.rising ? "↑" : "↓"}     ${next ? si((next.index - e.index) * meta.interval, "s") : "-"}`);
							}
							if (edges.length === 0) lines.push("(no crossings — flat signal or threshold outside the signal; check min/max above)");
						} else {
							const every = Math.max(1, Math.floor(params.every ?? Math.ceil(win.length / limit)));
							const rows = Math.ceil(win.length / every);
							truncated = rows > limit;
							lines.push(`every ${every} sample${every > 1 ? "s" : ""}${truncated ? ` (showing ${limit} of ${rows} rows — narrow fromUs/toUs or raise every)` : ""}`);
							lines.push(`t               C${stored.ch} (${stored.unit})`);
							for (let i = 0, r = 0; i < win.length && r < limit; i += every, r++) lines.push(`${si(timeOfIndex(from + i, time), "s").padEnd(15)} ${si(codeToVolts(win[i]!, scale), stored.unit)}`);
						}
						if (params.plot !== false && !params.edges) lines.push(asciiPlot(win, scale, { ...time, delay: time.delay + from * time.interval }, { label: `C${stored.ch}` }));
						const text = capEngineOutput(lines.join("\n"), "Narrow fromUs/toUs, raise every, or lower limit.");
						return {
							content: [{ type: "text", text }],
							details: { action, captureId: meta.id, dir: meta.dir, points: win.length, interval: meta.interval, timebase: meta.timebase, truncated: truncated || text.length < lines.join("\n").length, channels: [{ ch: stored.ch, label: stored.label, vdiv: stored.vdiv, unit: stored.unit, probe: stored.probe, points: win.length, stats: { min: st.min, max: st.max, pp: st.pp, mean: st.mean, rms: st.rms, freq: st.freq, period: st.period, duty: st.duty, rise: st.rise, fall: st.fall, edges: st.edges } }] },
						};
					}

					case "screenshot": {
						const s = await ensureScope(params.address, signal);
						const png = await s.screenshot(signal);
						const dir = path.join(root, SCOPE_SCREENS_DIR);
						await mkdir(dir, { recursive: true });
						const file = path.join(dir, `${stamp()}.png`);
						await writeFile(file, png);
						const tr = await s.trigger(signal).catch(() => undefined);
						const note = `screenshot ${(png.byteLength / 1024).toFixed(0)} KB saved to ${file}${tr ? ` (trigger status ${tr.status})` : ""}`;
						if (png.byteLength > MAX_SCREENSHOT_BYTES) return { content: [{ type: "text", text: `${note} — too large to attach` }], details: { action, address: s.label, file, bytes: png.byteLength } };
						return {
							content: [
								{ type: "text", text: `${note}. The screen image is attached below.` },
								{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
							],
							details: { action, address: s.label, file, bytes: png.byteLength, trigger: tr ? { mode: tr.mode, source: tr.source, level: tr.level, slope: tr.slope, status: tr.status } : undefined },
						};
					}

					case "list": {
						const all: ScopeCaptureListing[] = await listCaptures(env.cwd);
						if (all.length === 0) return { content: [{ type: "text", text: `no captures yet in ${root} — scope capture (or scope arm … collect) first` }], details: { action } };
						const rows = all.map((m) => `${m.id}${m.id === lastCaptureId ? " *" : ""}  ${m.channels.map((c) => `C${c.ch}${c.label ? `(${c.label})` : ""}`).join(",")}  ${m.channels[0]?.points.toLocaleString() ?? 0} pts @ ${si(m.interval, "s")}/pt  ${si(m.timebase.scale, "s/div")}  ${m.mode}  ${new Date(m.createdAt).toISOString()}`);
						return { content: [{ type: "text", text: `${rows.length} captures in ${root}:\n${rows.join("\n")}\n${CAPTURE_JSON} in each directory has the settings; scope samples reads the numbers.` }], details: { action } };
					}

					case "raw": {
						if (!params.commands?.length) throw new Error('scope raw requires commands, e.g. [":CHANnel1:SCALe?", ":TIMebase:SCALe 1E-3"]');
						const s = await ensureScope(params.address, signal);
						const lines: string[] = [];
						for (const cmd of params.commands.slice(0, 50)) {
							const reply = await s.raw(cmd, signal);
							lines.push(cmd.includes("?") ? `> ${cmd}\n< ${reply === undefined ? "(no reply within 5 s)" : reply}` : `> ${cmd}`);
						}
						const err = await s.checkError();
						if (err) lines.push(`⚠ scope error ${err.code}: ${err.message}`);
						return { content: [{ type: "text", text: capEngineOutput(lines.join("\n"), "Send fewer commands per call.") }], details: { action, address: s.label } };
					}

					default: {
						const never: never = action;
						throw new Error(`scope: unknown action ${String(never)}`);
					}
				}
			} catch (error) {
				if (isConnectionError(error)) await dropScope();
				throw error;
			} finally {
				armIdle();
			}
		},
	};
}

export function createScopeTool(env: ExecutionEnv, options?: ScopeToolOptions) {
	return wrapToolDefinition(createScopeToolDefinition(env, options));
}
