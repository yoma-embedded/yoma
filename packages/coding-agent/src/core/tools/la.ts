/**
 * la 工具:DSLogic 逻辑分析仪 —— 采集、解码、让模型读懂总线上到底发生了什么。
 *
 * 背后是 engines/bin/yoma-la(vendored DSView 的采集库 + 150 个解码器,用户不装 DSView)。引擎只做
 * "碰硬件"和"跑解码器";语义全在 core/la:事务聚合、期望差分、时序统计、token 预算。
 *
 * 叫 `la` 不叫 `logic`:与 `log` 只差两个字母,模型选错工具是一个不会报错的失败模式。
 *
 * 纪律:
 *  - 一次采集一个子进程(引擎的库是全局单例 + 单活动设备,进程边界 = 免费清理)。arm / collect 分开,
 *    核心用例是"先武装,再 flash 复位板子,然后看抓到了什么";arm 的子进程挂 killOnHostExit。
 *  - **不占 probe.lock**:DSLogic 是独立 USB 设备,"gdb 握着 ST-Link 同时抓总线"正是要支持的组合;
 *    设备自身的互斥(DSView 开着、另一个 la 进程)由引擎打不开设备的人话兜住。
 *  - details 只放摘要 + 1024 列预览(≤32KB):它进会话 JSONL、开会话整批重传、不可回收。原始样本在
 *    <cwd>/.yoma/la/<id>/,缓存与布局在 core/la/store.ts,与 kernel 的 la.view 同一份。
 *  - 位级行默认折叠、events 默认 200 行、超 32M 采样的 decode 要窗口 —— 防线在生成端不在截断端。
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import { type AnnotationSet, fmtFreq, fmtTime, toSeconds } from "../la/annotations.ts";
import { type ChannelStats, type DslChannel, channelStats, columnBits, lowerBound, parseSizeString } from "../la/dsl.ts";
import { type CaptureSpec, type LaCaptureReport, laCapture, laDecode, laDecoders, laDevices } from "../la/engine.ts";
import { type Detail, EXPECT_SYNTAX, expectDiff, renderEvents, summarize } from "../la/model.ts";
import { CAPTURE_DSL, CAPTURE_JSON, type CaptureStore, DECODE_JSON, DECODE_NDJSON, LA_DIR, type LaCaptureMeta, type OpenedCapture, captureStore } from "../la/store.ts";
import { type EnginePathOptions, capEngineOutput, clamp, killOnHostExit, stamp } from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const LA_ACTIONS = ["devices", "capture", "arm", "collect", "stop", "import", "list", "decoders", "summary", "decode", "events", "timing", "expect"] as const;
export type LaAction = (typeof LA_ACTIONS)[number];

// Union 必须写显式元组:ARRAY.map(Type.Literal) 会丢元组结构,Static 塌成 never(toolchain.ts:26 同注)。
const laSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("devices"),
			Type.Literal("capture"),
			Type.Literal("arm"),
			Type.Literal("collect"),
			Type.Literal("stop"),
			Type.Literal("import"),
			Type.Literal("list"),
			Type.Literal("decoders"),
			Type.Literal("summary"),
			Type.Literal("decode"),
			Type.Literal("events"),
			Type.Literal("timing"),
			Type.Literal("expect"),
		],
		{ description: "devices | capture | arm | collect | stop | import | list | decoders | summary | decode | events | timing | expect" },
	),
	// ── 采集 ──
	channels: Type.Optional(
		Type.Array(Type.Object({ index: Type.Number(), name: Type.Optional(Type.String()) }), {
			description: 'capture/arm: probe channels to record and their names, e.g. [{index:0,name:"SCL"},{index:1,name:"SDA"}]. Default: all.',
		}),
	),
	samplerate: Type.Optional(Type.String({ description: 'capture/arm: "25M", "100M", "500k"… ≥ 5× the fastest signal. Default 20M.' })),
	samples: Type.Optional(Type.String({ description: 'capture/arm: samples per channel, decimal ("1M" = 1,000,000). Or durationMs. Buffer mode is bounded by device memory (16M on DSLogic Plus at 16 channels).' })),
	durationMs: Type.Optional(Type.Number({ description: "capture/arm: record for this long instead of giving samples." })),
	trigger: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: 'capture/arm: per channel index: "r" rising, "f" falling, "c" any edge, "0"/"1" level, "x" ignore — e.g. {"1":"f"}. Without a trigger recording starts immediately.',
		}),
	),
	triggerPositionPct: Type.Optional(Type.Number({ description: "capture/arm: pre-trigger share of the buffer, 0–100 (default 10)." })),
	mode: Type.Optional(Type.Union([Type.Literal("buffer"), Type.Literal("stream")], { description: "capture/arm: buffer (default, up to 100 MHz × 16ch, bounded by device memory) or stream (continuous over USB, ≤ 20 MHz × 16ch)." })),
	vth: Type.Optional(Type.Number({ description: "capture/arm: input threshold in volts (1.65 for 3.3 V logic, 0.9 for 1.8 V). Device default when omitted." })),
	timeoutMs: Type.Optional(Type.Number({ description: "capture/arm: stop waiting for the trigger after this long (default 30000); what was captured is returned, flagged timed_out." })),
	device: Type.Optional(Type.String({ description: 'capture/arm: "auto" (first DSLogic, default), an index, or "demo" (built-in simulated signals, no hardware).' })),
	// ── 文件 / 选择 ──
	file: Type.Optional(Type.String({ description: "import: path of an existing .dsl (saved by DSView or copied from another machine)." })),
	capture: Type.Optional(Type.String({ description: "summary/decode/events/timing/expect: capture id from list. Default: the most recent." })),
	// ── 解码 ──
	decoders: Type.Optional(
		Type.Array(
			Type.Object({
				key: Type.String({ description: 'instance name you choose, e.g. "i2c0"' }),
				id: Type.String({ description: 'decoder id from action=decoders, e.g. "1:i2c", "1:spi", "1:uart", "can", "modbus"' }),
				channels: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'decoder channel → capture channel (index or name), e.g. {"scl":"SCL","sda":"SDA"}' })),
				options: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'decoder options, e.g. {"baudrate":"115200"}' })),
				on: Type.Optional(Type.String({ description: "stack on another instance key (modbus on a uart instance) instead of raw channels" })),
			}),
			{ description: "decode: decoder instances to run; they stay attached to the capture for events/expect." },
		),
	),
	decoder: Type.Optional(Type.String({ description: "decoders: one decoder id for its full entry. events/expect: which instance key (default: the first)." })),
	// ── 查询 ──
	fromMs: Type.Optional(Type.Number({ description: "decode/events/timing/expect: window start, ms from capture start." })),
	toMs: Type.Optional(Type.Number({ description: "decode/events/timing: window end, ms." })),
	detail: Type.Optional(Type.Union([Type.Literal("txn"), Type.Literal("frame"), Type.Literal("bit")], { description: "events: txn (one line per transaction, default), frame (expand members), bit (include bit-level rows)." })),
	rows: Type.Optional(Type.Array(Type.String(), { description: "events: only these annotation rows (row ids from decode output)." })),
	search: Type.Optional(Type.String({ description: "events: keep only lines containing this text (case-insensitive), e.g. an address." })),
	limit: Type.Optional(Type.Number({ description: "events: max lines (default 200)." })),
	timingChannels: Type.Optional(Type.Array(Type.String(), { description: "timing: channels (index or name); default all." })),
	expect: Type.Optional(Type.String({ description: `expect: the traffic the firmware should have produced — ${EXPECT_SYNTAX}` })),
});

export type LaToolInput = Static<typeof laSchema>;

export type LaCaptureSummary = LaCaptureMeta;

export interface LaToolDetails {
	action: LaAction;
	captureId?: string;
	/** 采集目录绝对路径(la.view 用) */
	dir?: string;
	file?: string;
	samplerate?: number;
	samples?: number;
	durationMs?: number;
	triggerPos?: number;
	channels?: { index: number; name: string; edges?: number }[];
	/** 1024 列 × 每通道 2bit(bit0 有高、bit1 有低),每通道一个 base64 */
	preview?: { columns: number; from: number; to: number; rows: Record<string, string> };
	decoders?: { key: string; id: string; annotations: number }[];
	/** events 的查询窗口(采样) */
	window?: { from: number; to: number };
	armed?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
	issues?: number;
	device?: { model?: string; pid?: string; hdl?: number };
}

const PREVIEW_COLUMNS = 1024;
const DEFAULT_LIMIT = 200;
/** 超过这个采样数 decode 必须给窗口:防线在生成端 */
const FULL_DECODE_MAX_SAMPLES = 32_000_000;

interface ArmedCapture {
	id: string;
	dir: string;
	controller: AbortController;
	promise: Promise<LaCaptureReport>;
	spec: CaptureSpec;
	killNow(): void;
}

/** 在飞的 arm(跨所有工具实例):宿主退出要带走它们。killOnHostExit 只认 Set,所以它就是唯一的登记处。 */
const armedSet = new Set<ArmedCapture>();

const DESCRIPTION = `Logic analyzer (DreamSourceLab DSLogic): capture digital signals, decode bus protocols (I²C, SPI, UART, CAN, Modbus, 1-Wire, JTAG, SWD, USB — 150 DSView decoders bundled, no DSView install), and read the traffic as transactions.

Actions:
- devices: is a DSLogic attached, what can it do (samplerates, depth, threshold).
- capture / arm+collect: record. arm returns immediately so you can flash or reset the board, then collect — that is how you catch what happens right after reset. stop discards an armed capture.
- import (file): register a .dsl saved by DSView or copied from another machine; everything downstream is identical.
- list: captures in this project. summary: per-channel edge counts, idle level, shortest pulse — which wire is the clock, before you decode.
- decoders / decoders (decoder=id): the catalog, or one decoder's real channel and option names. Read it — DSView ids differ from upstream sigrok ("1:uart" is ONE wire; TX and RX are two instances).
- decode (decoders): attach decoder instances to a capture; they stay attached for events/expect.
- events: transactions with a time anchor per line. Narrow with fromMs/toMs, search, decoder; detail=frame expands one, detail=bit shows bit timing.
- expect: diff the capture against the traffic the firmware should have produced — MATCH or the first mismatch with its timestamp. Cheaper and more reliable than reading hundreds of frames.
- timing: pulse widths, period/frequency, duty, glitches per channel — no decoder needed.

Rules:
- Samples are a budget, not a goal: 1–4M samples at 5–10× the bus clock covers most bugs.
- Numbers in events are hex; I²C addresses are 7-bit.
- The full annotation list is always on disk in <project>/.yoma/la/<id>/ — when output is truncated, narrow the window, do not re-capture.
- A capture whose trigger did not fire, or that timed out, proves nothing about the bus. Check wiring, vth and the trigger condition before concluding anything.`;

export interface LaToolOptions extends EnginePathOptions {
	/** 测试隔离用;生产走进程内唯一的 captureStore(与 kernel 的 la.view 同一份)。 */
	store?: CaptureStore;
}

export function createLaToolDefinition(env: ExecutionEnv, options: LaToolOptions = {}): ToolDefinition<typeof laSchema, LaToolDetails> {
	const root = path.join(env.cwd, LA_DIR);
	const store = options.store ?? captureStore;
	let lastCaptureId: string | undefined;
	/** 本工具实例武装的那一个(armedSet 里可能还有别的会话的) */
	let armed: ArmedCapture | undefined;

	const engineCtx = (signal?: AbortSignal) => ({ enginesDir: options.enginesDir, cwd: env.cwd, signal });

	async function registerCapture(id: string, dir: string, source: LaCaptureMeta["source"], report?: LaCaptureReport): Promise<{ meta: LaCaptureMeta; cap: OpenedCapture }> {
		const cap = await store.open(dir);
		const h = cap.dsl.header;
		const meta: LaCaptureMeta = {
			id,
			dir,
			samplerate: h.samplerate,
			samples: h.totalSamples,
			durationMs: toSeconds(h.totalSamples, h.samplerate) * 1e3,
			channels: h.channels.map((c) => ({ index: c.index, name: c.name })),
			triggerPos: report?.trigger.fired ? report.trigger.pos : h.triggerPos,
			source,
			createdAt: Date.now(),
			decoded: [],
		};
		const { dir: _dir, decoded: _decoded, ...persisted } = meta;
		await writeFile(path.join(dir, CAPTURE_JSON), `${JSON.stringify(persisted, null, "\t")}\n`);
		lastCaptureId = id;
		return { meta, cap };
	}

	async function requireCapture(id: string | undefined, action: LaAction): Promise<{ meta: LaCaptureMeta; cap: OpenedCapture }> {
		const all = await store.list(env.cwd);
		const pick = id ?? lastCaptureId ?? all[0]?.id;
		if (!pick) throw new Error(`la ${action}: no capture yet — run la capture (or la import a .dsl) first`);
		const meta = all.find((m) => m.id === pick);
		if (!meta) throw new Error(`la ${action}: no capture named ${pick} (la list shows them)`);
		return { meta, cap: await store.open(meta.dir) };
	}

	async function requireAnnotations(cap: OpenedCapture, id: string, action: LaAction): Promise<AnnotationSet> {
		const set = await cap.annotations();
		if (!set) throw new Error(`la ${action}: capture ${id} is not decoded yet — run la decode with decoders=[…] first`);
		return set;
	}

	function previewOf(cap: OpenedCapture): LaToolDetails["preview"] {
		const total = cap.dsl.header.totalSamples;
		const rows: Record<string, string> = {};
		for (const c of cap.dsl.header.channels) rows[String(c.index)] = Buffer.from(columnBits(cap.edges(c.index), 0, total, PREVIEW_COLUMNS)).toString("base64");
		return { columns: PREVIEW_COLUMNS, from: 0, to: total, rows };
	}

	function baseDetails(action: LaAction, meta?: LaCaptureMeta): LaToolDetails {
		if (!meta) return { action };
		return {
			action,
			captureId: meta.id,
			dir: meta.dir,
			file: path.join(meta.dir, CAPTURE_DSL),
			samplerate: meta.samplerate,
			samples: meta.samples,
			durationMs: meta.durationMs,
			triggerPos: meta.triggerPos,
			channels: meta.channels,
		};
	}

	function windowOf(meta: LaCaptureMeta, fromMs?: number, toMs?: number): { from: number; to: number } {
		const sr = meta.samplerate;
		const from = fromMs !== undefined ? Math.max(0, Math.floor((fromMs / 1e3) * sr)) : 0;
		const to = toMs !== undefined ? Math.min(meta.samples, Math.ceil((toMs / 1e3) * sr)) : meta.samples;
		if (to <= from) throw new Error(`la: empty window (fromMs=${fromMs}, toMs=${toMs}); the capture spans 0..${fmtTime(meta.durationMs / 1e3)}`);
		return { from, to };
	}

	function captureSpecOf(p: LaToolInput): CaptureSpec {
		const spec: CaptureSpec = {
			device: p.device,
			samplerate: p.samplerate ?? "20M",
			samples: p.samples ?? (p.durationMs ? undefined : "1M"),
			durationMs: p.samples ? undefined : p.durationMs,
			channels: p.channels,
			trigger: p.trigger,
			triggerPositionPct: p.triggerPositionPct,
			mode: p.mode,
			vth: p.vth,
			timeoutMs: clamp(p.timeoutMs, 30_000, 1_000, 60 * 60_000),
		};
		if (spec.samples && parseSizeString(spec.samples) === undefined) throw new Error(`la: samples "${spec.samples}" — write it like "1M" or "200k" (decimal)`);
		if (spec.samplerate && parseSizeString(spec.samplerate) === undefined) throw new Error(`la: samplerate "${spec.samplerate}" — write it like "25M" or "500k"`);
		for (const [k, v] of Object.entries(spec.trigger ?? {})) if (!/^[01rfcx]$/i.test(v)) throw new Error(`la: trigger["${k}"]="${v}" — use r / f / c / 0 / 1 / x`);
		return spec;
	}

	function describeReport(id: string, r: LaCaptureReport & { stderr?: string }): string {
		const dev = r.device?.model ? `${r.device.model} (PID ${r.device.pid})` : r.mode;
		const lines = [
			`capture ${id}: ${r.ok ? "done" : "INCOMPLETE"} — ${r.samples.toLocaleString()} samples @ ${fmtFreq(r.samplerate)} = ${fmtTime(r.duration_ms / 1e3)} on ${dev}, ${r.mode} mode`,
			`channels: ${r.channels.map((c) => `D${c.index}=${c.name}`).join(" ")}`,
		];
		if (r.trigger.enabled) lines.push(`trigger: ${r.trigger.fired ? `fired at sample ${r.trigger.pos} (${fmtTime(toSeconds(r.trigger.pos, r.samplerate))})` : "DID NOT FIRE"}`);
		if (r.timed_out) lines.push(`⚠ timed out waiting (${(r.elapsed_ms / 1e3).toFixed(1)} s)${r.samples ? " — kept what was captured" : " — nothing captured"}. If a trigger was set, the edge never came: check wiring, vth, and that the event happens inside the wait.`);
		if (r.overflow) lines.push("⚠ USB overflow: stream mode could not keep up — lower the samplerate or use buffer mode.");
		if (r.data_error) lines.push(`⚠ data error ${r.data_error} reported by the device`);
		if (r.stderr) lines.push(r.stderr);
		if (r.file) lines.push(`file: ${r.file}`);
		return lines.join("\n");
	}

	async function finishCapture(action: LaAction, id: string, dir: string, report: LaCaptureReport, source: LaCaptureMeta["source"]): Promise<{ text: string; details: LaToolDetails }> {
		if (!report.file || report.samples === 0) {
			return { text: describeReport(id, report), details: { action, captureId: id, dir, timedOut: report.timed_out, samples: 0 } };
		}
		const { meta, cap } = await registerCapture(id, dir, source, report);
		const details = baseDetails(action, meta);
		details.timedOut = report.timed_out;
		details.preview = previewOf(cap);
		details.device = { model: report.device?.model, pid: report.device?.pid, hdl: report.device?.hdl_version };
		return { text: `${describeReport(id, report)}\nnext: la summary (what is on each wire), then la decode.`, details };
	}

	/** 一趟算完脉宽统计;中位数要排序,用 TypedArray 原地排,不拷一份 number[]。 */
	function pulseStats(edges: Uint32Array, levelAfterFirst: 0 | 1) {
		const n = edges.length - 1;
		const widths = new Uint32Array(Math.max(0, n));
		let nh = 0, nl = 0;
		for (let i = 0; i < n; i++) widths[i] = edges[i + 1]! - edges[i]!;
		let level = levelAfterFirst;
		for (let i = 0; i < n; i++) { if (level) nh++; else nl++; level = (level ^ 1) as 0 | 1; }
		const highs = new Uint32Array(nh), lows = new Uint32Array(nl);
		level = levelAfterFirst;
		for (let i = 0, h = 0, l = 0; i < n; i++) { if (level) highs[h++] = widths[i]!; else lows[l++] = widths[i]!; level = (level ^ 1) as 0 | 1; }
		const periods = new Uint32Array(Math.max(0, Math.floor((edges.length - 1) / 2)));
		for (let i = 2, k = 0; i < edges.length; i += 2) periods[k++] = edges[i]! - edges[i - 2]!;
		let glitches = 0;
		for (let i = 0; i < n; i++) if (widths[i]! <= 2) glitches++;
		const stat = (arr: Uint32Array) => {
			if (!arr.length) return undefined;
			let sum = 0;
			for (let i = 0; i < arr.length; i++) sum += arr[i]!;
			arr.sort();
			return { min: arr[0]!, max: arr[arr.length - 1]!, mean: sum / arr.length, median: arr[arr.length >> 1]! };
		};
		return { high: stat(highs), low: stat(lows), period: stat(periods), glitches };
	}

	return {
		name: "la",
		label: "logic analyzer",
		description: DESCRIPTION,
		promptSnippet: "DSLogic logic analyzer: capture signals, decode I²C/SPI/UART/CAN/…, read bus traffic as transactions, diff against expected",
		promptGuidelines: [
			"For bus/timing questions (is the MCU sending the right I²C/SPI/UART bytes? is the clock right?), capture with la and read la events / la expect instead of inferring from code.",
		],
		parameters: laSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const action = params.action;
			switch (action) {
				case "devices": {
					const r = await laDevices(engineCtx(signal));
					if (r.count === 0) {
						return {
							content: [{ type: "text", text: 'No DSLogic found. Is it plugged in? On Windows it shows up as "USB-based DSL Instrument v2" (WinUSB, no driver install needed). If DSView is open, close it — it holds the device. Try the tool without hardware with device="demo".' }],
							details: { action },
						};
					}
					const lines = r.devices.map((d, i) => {
						if (d.error) return `#${i} ${d.name}: ${d.error}`;
						const modes = (d.channel_modes ?? []).map((m) => `${m.stream ? "stream" : "buffer"} ${m.channels}ch ≤${fmtFreq(m.max_samplerate)}`).join(", ");
						const hdl = d.hdl_version !== undefined ? ` · FPGA HDL v${d.hdl_version}${d.hdl_expected !== undefined && d.hdl_version !== d.hdl_expected ? ` (engine expects v${d.hdl_expected} — mismatch!)` : ""}` : "";
						return [
							`#${i} ${d.model ?? d.name} — PID ${d.pid}${hdl}`,
							`   ${d.channels} channels, depth ${((d.depth_per_channel ?? 0) / 1e6).toFixed(1)}M samples/channel (buffer), features: ${(d.features ?? []).join(", ")}`,
							`   samplerates: ${(d.samplerates ?? []).map(fmtFreq).join(" ")}`,
							`   modes: ${modes}`,
							`   vth: ${d.vth ?? "?"} V (set vth=1.65 for 3.3 V logic if signals look dead)`,
						].join("\n");
					});
					return { content: [{ type: "text", text: lines.join("\n") }], details: { action, device: { model: r.devices[0]?.model, pid: r.devices[0]?.pid, hdl: r.devices[0]?.hdl_version } } };
				}

				case "capture": {
					if (armed) throw new Error(`la capture: a capture is already armed (${armed.id}) — la collect or la stop it first`);
					const spec = captureSpecOf(params);
					const id = `la-${stamp()}`;
					const dir = path.join(root, id);
					await mkdir(dir, { recursive: true });
					const report = await laCapture(engineCtx(signal), spec, dir, "capture");
					const { text, details } = await finishCapture(action, id, dir, report, spec.device === "demo" ? "demo" : "capture");
					return { content: [{ type: "text", text }], details };
				}

				case "arm": {
					if (armed) throw new Error(`la arm: already armed (${armed.id}) — la collect or la stop first`);
					const spec = captureSpecOf(params);
					const id = `la-${stamp()}`;
					const dir = path.join(root, id);
					await mkdir(dir, { recursive: true });
					const controller = new AbortController();
					const promise = laCapture(engineCtx(controller.signal), spec, dir, "capture");
					promise.catch(() => undefined); // collect 时再处理
					armed = { id, dir, controller, promise, spec, killNow: () => controller.abort() };
					armedSet.add(armed);
					killOnHostExit(armedSet, { yieldToHost: true });
					const trig = spec.trigger && Object.keys(spec.trigger).length ? `waiting for trigger ${JSON.stringify(spec.trigger)} (up to ${((spec.timeoutMs ?? 30000) / 1e3).toFixed(0)} s)` : "recording immediately (no trigger)";
					return {
						content: [{ type: "text", text: `armed ${id}: ${trig}. Now do the thing (flash/reset/poke the board), then la collect.` }],
						details: { action, captureId: id, dir, armed: true },
					};
				}

				case "collect":
				case "stop": {
					if (!armed) {
						if (action === "stop") return { content: [{ type: "text", text: "la stop: nothing armed" }], details: { action } };
						throw new Error("la collect: nothing armed — la arm first");
					}
					const a = armed;
					armed = undefined;
					armedSet.delete(a);
					if (action === "stop") {
						a.controller.abort();
						await a.promise.catch(() => undefined);
						return { content: [{ type: "text", text: `stopped ${a.id} (discarded)` }], details: { action, captureId: a.id } };
					}
					let report: LaCaptureReport;
					try {
						report = await a.promise;
					} catch (error) {
						throw new Error(`la collect: the armed capture failed — ${error instanceof Error ? error.message : String(error)}`);
					}
					const { text, details } = await finishCapture(action, a.id, a.dir, report, a.spec.device === "demo" ? "demo" : "capture");
					return { content: [{ type: "text", text }], details };
				}

				case "import": {
					if (!params.file) throw new Error("la import requires file — the .dsl to register");
					const src = await resolveToCwd(env, params.file);
					const exists = await env.exists(src);
					if (!exists.ok || !exists.value) throw new Error(`la import: ${src} not found`);
					const id = `la-${stamp()}-import`;
					const dir = path.join(root, id);
					await mkdir(dir, { recursive: true });
					await copyFile(src, path.join(dir, CAPTURE_DSL));
					const { meta, cap } = await registerCapture(id, dir, "import");
					const details = baseDetails(action, meta);
					details.preview = previewOf(cap);
					return {
						content: [{ type: "text", text: `imported ${id}: ${meta.samples.toLocaleString()} samples @ ${fmtFreq(meta.samplerate)} = ${fmtTime(meta.durationMs / 1e3)}, channels ${meta.channels.map((c) => `D${c.index}=${c.name}`).join(" ")}\nnext: la summary, then la decode.` }],
						details,
					};
				}

				case "list": {
					const all = await store.list(env.cwd);
					if (all.length === 0) return { content: [{ type: "text", text: `no captures yet in ${root} — la capture, or la import a .dsl. (la decoders lists the decoder catalog.)` }], details: { action } };
					const rows = all.map((m) => `${m.id}${m.id === lastCaptureId ? " *" : ""}  ${m.samples.toLocaleString()} samples @ ${fmtFreq(m.samplerate)} (${fmtTime(m.durationMs / 1e3)})  ${m.channels.length} ch  ${m.source}${m.decoded.length ? `  decoded: ${m.decoded.join(",")}` : ""}`);
					return { content: [{ type: "text", text: `${rows.length} captures in ${root}:\n${rows.join("\n")}${armed ? `\narmed: ${armed.id}` : ""}` }], details: { action } };
				}

				case "decoders": {
					if (params.decoder) {
						const cat = await laDecoders(engineCtx(signal), [params.decoder]);
						const d = cat.decoders[0];
						if (!d) throw new Error(`la decoders: no decoder named ${params.decoder} (la decoders lists them)`);
						const text = [
							`${d.id} — ${d.longname}: ${d.desc}`,
							`channels: ${d.channels.map((c) => `${c.id} (${c.desc})`).join(", ") || "none"}`,
							`optional: ${d.opt_channels.map((c) => `${c.id} (${c.desc})`).join(", ") || "none"}`,
							`options: ${d.options.map((o) => `${o.id}=${JSON.stringify(o.default)}${o.values.length ? ` ∈ {${o.values.map((v) => JSON.stringify(v)).join(",")}}` : ""} — ${o.desc}`).join("\n         ") || "none"}`,
							`rows: ${d.rows.map((r) => `${r.id}[${r.classes.map((c) => d.classes[c]?.id ?? c).join(",")}]`).join(" ")}`,
							`inputs: ${d.inputs.join(",") || "logic"}  outputs: ${d.outputs.join(",") || "-"}`,
						].join("\n");
						return { content: [{ type: "text", text }], details: { action } };
					}
					const cat = await laDecoders(engineCtx(signal));
					const lines = cat.decoders
						.sort((a, b) => a.id.localeCompare(b.id))
						.map((d) => {
							const ch = [...d.channels.map((c) => c.id), ...d.opt_channels.map((c) => `[${c.id}]`)].join(",");
							const opts = d.options.map((o) => `${o.id}=${JSON.stringify(o.default)}`).join(" ");
							const stack = d.inputs.length && !d.inputs.includes("logic") ? ` (stacks on ${d.inputs.join("/")})` : "";
							return `${d.id.padEnd(18)} ${d.name.padEnd(16)} ch:${ch || "-"}${opts ? `  opts: ${opts}` : ""}${stack}`;
						});
					const text = capEngineOutput(`${cat.decoders.length} decoders (channels; [optional]; option=default). la decoders decoder=<id> for one in full.\n${lines.join("\n")}`, "Ask for one decoder with decoder=<id>.");
					return { content: [{ type: "text", text }], details: { action } };
				}

				case "summary": {
					const { meta, cap } = await requireCapture(params.capture, action);
					const sr = meta.samplerate;
					const stats: ChannelStats[] = cap.dsl.header.channels.map((c) => channelStats(c, cap.edges(c.index)));
					const active = stats.filter((s) => s.edges > 0);
					const lines = [`${meta.id}: ${meta.samples.toLocaleString()} samples @ ${fmtFreq(sr)} = ${fmtTime(meta.durationMs / 1e3)}${meta.triggerPos !== undefined ? `, trigger at ${fmtTime(toSeconds(meta.triggerPos, sr))}` : ""}`];
					for (const s of stats) {
						if (s.edges === 0) { lines.push(`  D${s.index} ${s.name.padEnd(10)} idle ${s.idle ? "HIGH" : "LOW"} (no edges)`); continue; }
						const span = (s.lastEdge ?? 0) - (s.firstEdge ?? 0);
						const est = span > 0 ? fmtFreq(s.edges / 2 / toSeconds(span, sr)) : "-";
						lines.push(`  D${s.index} ${s.name.padEnd(10)} ${String(s.edges).padStart(7)} edges  active ${fmtTime(toSeconds(s.firstEdge ?? 0, sr))}..${fmtTime(toSeconds(s.lastEdge ?? 0, sr))}  min pulse ${fmtTime(toSeconds(s.minPulse ?? 0, sr))}  duty ${(s.dutyHigh * 100).toFixed(0)}%  ~${est} toggles`);
					}
					// 提示而非判断:时钟候选 = 边沿多且周期规整;UART 候选 = 空闲高电平
					const hints: string[] = [];
					const clocks: string[] = [];
					for (const s of [...active].sort((a, b) => b.edges - a.edges).slice(0, 6)) {
						const el = cap.edges(s.index);
						const periods: number[] = [];
						for (let i = 2; i < el.edges.length && periods.length < 2000; i += 2) periods.push(el.edges[i]! - el.edges[i - 2]!);
						if (periods.length < 8) continue;
						const med = [...periods].sort((a, b) => a - b)[periods.length >> 1]!;
						const regular = periods.filter((p) => Math.abs(p - med) <= med * 0.1).length / periods.length;
						if (regular > 0.6 && s.edges >= 32) clocks.push(`D${s.index} (${fmtFreq(sr / med)})`);
					}
					if (clocks.length) hints.push(`clock-like: ${clocks.join(", ")} — the data line of that bus is the one that toggles with it (I²C scl/sda, SPI clk/mosi/miso)`);
					const uartish = active.filter((s) => s.idle === 1 && s.edges >= 20 && s.dutyHigh > 0.5 && !clocks.some((c) => c.startsWith(`D${s.index} `)));
					if (uartish.length) hints.push(`idle-high with bursts (UART-like candidates): ${uartish.map((s) => `D${s.index}`).join(", ")}`);
					if (active.length === 0) hints.push("no channel toggles at all — check probe ground, vth (threshold), and that the bus is actually running during the capture window");
					if (hints.length) lines.push(`hints: ${hints.join("; ")}`);
					lines.push('next: la decode with decoders=[{key,id,channels}] — e.g. id "1:i2c" (scl,sda), "1:spi" (clk,[miso],[mosi],[cs]), "1:uart" (rxtx). la decoders for the catalog.');
					const details = baseDetails(action, meta);
					details.channels = stats.map((s) => ({ index: s.index, name: s.name, edges: s.edges }));
					details.preview = previewOf(cap);
					return { content: [{ type: "text", text: lines.join("\n") }], details };
				}

				case "decode": {
					const { meta, cap } = await requireCapture(params.capture, action);
					if (!params.decoders?.length) throw new Error('la decode requires decoders, e.g. [{key:"i2c0", id:"1:i2c", channels:{scl:"SCL", sda:"SDA"}}]');
					const win = params.fromMs !== undefined || params.toMs !== undefined ? windowOf(meta, params.fromMs, params.toMs) : undefined;
					if (!win && meta.samples > FULL_DECODE_MAX_SAMPLES) {
						throw new Error(`la decode: ${meta.samples.toLocaleString()} samples is a lot to decode at once — give fromMs/toMs (the capture spans 0..${fmtTime(meta.durationMs / 1e3)}); la summary shows where the activity is`);
					}
					const pds = params.decoders.map((d) => {
						if (!/^[A-Za-z_][\w-]*$/.test(d.key)) throw new Error(`la decode: key "${d.key}" — use a short identifier like i2c0`);
						const parts = [`${d.key}=${d.id}`];
						for (const [pdch, ref] of Object.entries(d.channels ?? {})) {
							const ch = cap.dsl.findChannel(ref);
							if (!ch) throw new Error(`la decode: ${d.key}.${pdch}="${ref}" — no such channel in this capture (have: ${meta.channels.map((c) => `D${c.index}=${c.name}`).join(" ")})`);
							parts.push(`${pdch}=${ch.index}`);
						}
						for (const [k, v] of Object.entries(d.options ?? {})) parts.push(`${k}=${v}`);
						if (d.on) parts.push(`on=${d.on}`);
						return parts.join(":");
					});
					const outFile = path.join(meta.dir, DECODE_NDJSON);
					const r = await laDecode(engineCtx(signal), { input: path.join(meta.dir, CAPTURE_DSL), pds, from: win?.from, to: win?.to }, outFile);
					await writeFile(path.join(meta.dir, DECODE_JSON), `${JSON.stringify({ pds, file: DECODE_NDJSON, window: win ?? null, at: Date.now() }, null, "\t")}\n`);
					store.invalidate(meta.dir);
					const set = await requireAnnotations(cap, meta.id, action);
					const per = set.meta.decoders.map((d) => ({ key: d.key, id: d.id, annotations: (set.byKey.get(d.key) ?? []).length, summary: summarize(set, d.key, { from: win?.from, to: win?.to }) }));
					const lines = [
						`decoded ${meta.id}${win ? ` window ${fmtTime(toSeconds(win.from, set.meta.samplerate))}..${fmtTime(toSeconds(win.to, set.meta.samplerate))}` : ""}: ${r.annotations} annotations in ${r.elapsed_ms} ms`,
						...per.map((p) => `  ${p.key} (${p.id}): ${p.summary}`),
					];
					if (r.warnings) lines.push(r.warnings);
					lines.push("next: la events (decoder=<key>) or la expect.");
					const details = baseDetails(action, meta);
					details.decoders = per.map((p) => ({ key: p.key, id: p.id, annotations: p.annotations }));
					if (win) details.window = win;
					return { content: [{ type: "text", text: lines.join("\n") }], details };
				}

				case "events": {
					const { meta, cap } = await requireCapture(params.capture, action);
					const set = await requireAnnotations(cap, meta.id, action);
					const key = params.decoder ?? set.meta.decoders[0]?.key;
					if (!key) throw new Error("la events: no decoder instances in this capture's decode");
					const win = windowOf(meta, params.fromMs, params.toMs);
					const limit = clamp(params.limit, DEFAULT_LIMIT, 1, 5000);
					const res = renderEvents(set, key, { from: win.from, to: win.to, detail: (params.detail as Detail | undefined) ?? "txn", rows: params.rows, search: params.search, limit });
					const dec = set.meta.decoders.find((d) => d.key === key)!;
					const head = `# la events ${meta.id}  sr=${fmtFreq(set.meta.samplerate)}  n=${set.meta.total_samples}${set.meta.trigger_pos !== null && set.meta.trigger_pos !== undefined ? `  trig@${set.meta.trigger_pos}` : ""}`;
					const foot = `${res.summary}.${res.truncated ? ` Showing ${limit} of ${res.total} — narrow with fromMs/toMs, search, or rows; the full list is in ${path.join(meta.dir, DECODE_NDJSON)}.` : ""}${(params.detail ?? "txn") === "txn" ? " detail=frame expands members." : ""}`;
					const full = [head, ...res.lines, foot].join("\n");
					const text = capEngineOutput(full, "Narrow the window (fromMs/toMs), use search, or lower limit.");
					const details = baseDetails(action, meta);
					details.window = win;
					details.truncated = res.truncated || text.length < full.length;
					details.decoders = [{ key, id: dec.id, annotations: (set.byKey.get(key) ?? []).length }];
					return { content: [{ type: "text", text }], details };
				}

				case "timing": {
					const { meta, cap } = await requireCapture(params.capture, action);
					const sr = meta.samplerate;
					const win = windowOf(meta, params.fromMs, params.toMs);
					const chans: DslChannel[] = params.timingChannels?.length
						? params.timingChannels.map((ref) => {
							const c = cap.dsl.findChannel(ref);
							if (!c) throw new Error(`la timing: no channel "${ref}"`);
							return c;
						})
						: cap.dsl.header.channels;
					const t = (n: number) => fmtTime(toSeconds(n, sr));
					const lines = [`# la timing ${meta.id}  window ${t(win.from)}..${t(win.to)}  sr=${fmtFreq(sr)} (resolution ${fmtTime(1 / sr)})`];
					for (const c of chans) {
						const el = cap.edges(c.index);
						const i0 = lowerBound(el.edges, win.from);
						const edges = el.edges.subarray(i0, lowerBound(el.edges, win.to));
						if (edges.length < 2) { lines.push(`D${c.index} ${c.name.padEnd(10)} ${edges.length} edge(s) in window`); continue; }
						const { high: h, low: l, period: p, glitches } = pulseStats(edges, ((el.initial + i0 + 1) & 1) as 0 | 1);
						lines.push(`D${c.index} ${c.name.padEnd(10)} ${edges.length} edges` +
							(h ? `  high ${t(h.median)} (min ${t(h.min)} max ${t(h.max)})` : "") +
							(l ? `  low ${t(l.median)} (min ${t(l.min)} max ${t(l.max)})` : "") +
							(p ? `  period ${t(p.median)} = ${fmtFreq(sr / p.median)} (min ${t(p.min)} max ${t(p.max)})` : "") +
							(h && l ? `  duty ${((h.mean / (h.mean + l.mean)) * 100).toFixed(1)}%` : "") +
							(glitches ? `  ⚠ ${glitches} pulses ≤ 2 samples (glitch or under-sampled)` : ""));
					}
					const details = baseDetails(action, meta);
					details.window = win;
					return { content: [{ type: "text", text: capEngineOutput(lines.join("\n"), "Pick fewer channels with timingChannels.") }], details };
				}

				case "expect": {
					const { meta, cap } = await requireCapture(params.capture, action);
					if (!params.expect?.trim()) throw new Error(`la expect requires expect — ${EXPECT_SYNTAX}`);
					const set = await requireAnnotations(cap, meta.id, action);
					const key = params.decoder ?? set.meta.decoders[0]?.key;
					if (!key) throw new Error("la expect: no decoder instances");
					const from = params.fromMs !== undefined ? windowOf(meta, params.fromMs, undefined).from : undefined;
					const res = expectDiff(set, key, params.expect, { from });
					const details = baseDetails(action, meta);
					details.issues = res.ok ? 0 : 1;
					return { content: [{ type: "text", text: `la expect ${meta.id} ${key}: ${res.message}` }], details };
				}

				default: {
					const never: never = action;
					throw new Error(`la: unknown action ${String(never)}`);
				}
			}
		},
	};
}

export function createLaTool(env: ExecutionEnv, options?: LaToolOptions) {
	return wrapToolDefinition(createLaToolDefinition(env, options));
}
