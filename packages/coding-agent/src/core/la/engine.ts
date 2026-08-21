/**
 * yoma-la 子进程的 TS 封装:devices / capture / decode / decoders 四个子命令。
 *
 * 引擎在 engines/bin/yoma-la(与 stm32kernel 同一套定位:engineBin),数据在 engines/data/la/。
 * 约定(见 engines/logic-analyzer/src/main.c):stdout 只有 JSON / NDJSON,诊断走 stderr 且带
 * "yoma-la: " 前缀 —— 失败时把这些行原样交给模型,它们已经是人话。
 *
 * decode 的注解流不经 stdout 回传(一次真实采集几万到几百万条注解),引擎用 --out 写文件,
 * 这里只读 end 行;注解由 annotations.ts 按需读。
 */
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { type EnginePathOptions, type EngineRunResult, assertEngineSettled, engineBin, engineDataDir, runEngine } from "../tools/engines.ts";

export interface LaEngineContext extends EnginePathOptions {
	cwd?: string;
	signal?: AbortSignal;
}

export interface LaDevice {
	name: string;
	driver: string;
	type: "usb" | "file" | "demo";
	vendor?: string;
	model?: string;
	vid?: string;
	pid?: string;
	usb_speed?: string;
	fpga_bitstream?: string;
	hw_depth_bits?: number;
	channels?: number;
	features?: string[];
	hdl_version?: number;
	hdl_expected?: number;
	channel_modes?: { id: number; stream: boolean; channels: number; max_samplerate: number; desc: string }[];
	samplerates?: number[];
	depth_per_channel?: number;
	samplerate?: number;
	vth?: number;
	channel_names?: { index: number; name: string; enabled: boolean }[];
	error?: string;
}

export interface LaCaptureReport {
	ok: boolean;
	file: string | null;
	samplerate: number;
	samples: number;
	requested_samples: number;
	device_actual_samples: number;
	duration_ms: number;
	trigger: { enabled: boolean; fired: boolean; pos: number };
	channels: { index: number; name: string }[];
	mode: string;
	packets: number;
	bytes_in: number;
	timed_out: boolean;
	overflow: boolean;
	data_error: number;
	end_event: number;
	elapsed_ms: number;
	device: LaDevice;
}

export interface LaDecoderInfo {
	id: string;
	name: string;
	longname: string;
	desc: string;
	inputs: string[];
	outputs: string[];
	tags: string[];
	channels: { id: string; name: string; desc: string; order: number }[];
	opt_channels: { id: string; name: string; desc: string; order: number }[];
	options: { id: string; desc: string; type: string | null; default: unknown; values: unknown[] }[];
	classes: { index: number; id: string; desc: string }[];
	rows: { id: string; desc: string; classes: number[] }[];
	binary: { id: string; desc: string }[];
}

export interface CaptureSpec {
	device?: string;
	samplerate?: string;
	samples?: string;
	durationMs?: number;
	/** 物理通道 → 名字;缺省全开 */
	channels?: { index: number; name?: string }[];
	/** 物理通道 → 0|1|r|f|c|x */
	trigger?: Record<string, string>;
	triggerPositionPct?: number;
	mode?: "buffer" | "stream";
	vth?: number;
	timeoutMs?: number;
}

function stderrLines(r: EngineRunResult): string {
	return r.stderr
		.split(/\r?\n/)
		.map((l) => l.replace(/^yoma-la:\s*/, "").trim())
		.filter((l) => l && !/^sr: dsl: Security check/.test(l))
		.join("\n");
}

function binOf(ctx: LaEngineContext): string {
	return engineBin("yoma-la", ctx);
}

/**
 * 把引擎的数据目录显式传下去(CLAUDE.md:engines 目录必须显式传,别依赖向上查找)。
 * 引擎自己也会找,但那是给人手工跑的;这里 enginesDir 已经解析过,就别让它再猜到一份 stale 的 vendor/。
 * 装了引擎却没装数据(开发期半途)时不传,让引擎的搜索兜底。
 */
function dataArgs(ctx: LaEngineContext, leaf: "decoders" | "res"): string[] {
	try {
		const p = path.join(engineDataDir("la", ctx), leaf);
		return existsSync(p) ? [`--${leaf}`, p] : [];
	} catch {
		return [];
	}
}

function parseJsonStdout<T>(r: EngineRunResult, what: string): T {
	const text = r.stdout.trim();
	const last = text.split("\n").filter(Boolean).at(-1) ?? "";
	try {
		return JSON.parse(last) as T;
	} catch {
		throw new Error(`yoma-la ${what}: 输出不是 JSON(exit ${r.exitCode})\n${stderrLines(r) || text.slice(0, 500)}`);
	}
}

export async function laVersion(ctx: LaEngineContext = {}): Promise<{ "yoma-la": string; dsview: string; dsview_commit: string; libsigrokdecode: string }> {
	const r = assertEngineSettled(await runEngine(binOf(ctx), ["--version"], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 10_000 }), "yoma-la --version");
	return parseJsonStdout(r, "--version");
}

export async function laDevices(ctx: LaEngineContext = {}): Promise<{ devices: LaDevice[]; count: number }> {
	const r = assertEngineSettled(await runEngine(binOf(ctx), ["devices", "--json", ...dataArgs(ctx, "res")], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 30_000 }), "yoma-la devices");
	if (r.exitCode !== 0) throw new Error(`yoma-la devices failed (exit ${r.exitCode}): ${stderrLines(r)}`);
	return parseJsonStdout(r, "devices");
}

export async function laDecoders(ctx: LaEngineContext = {}, ids: string[] = []): Promise<{ decoders_dir: string; decoders: LaDecoderInfo[] }> {
	const r = assertEngineSettled(await runEngine(binOf(ctx), ["decoders", "--json", ...dataArgs(ctx, "decoders"), ...ids], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 60_000 }), "yoma-la decoders");
	const parsed = parseJsonStdout<{ decoders_dir: string; decoders: LaDecoderInfo[] }>(r, "decoders");
	if (r.exitCode !== 0 && parsed.decoders.length === 0) throw new Error(`yoma-la decoders failed: ${stderrLines(r)}`);
	return parsed;
}

export function captureArgs(spec: CaptureSpec, outDir: string, name: string): string[] {
	const args = ["capture", "--out", outDir, "--name", name];
	if (spec.device) args.push("--device", spec.device);
	if (spec.samplerate) args.push("--rate", spec.samplerate);
	if (spec.samples) args.push("--samples", spec.samples);
	else if (spec.durationMs) args.push("--duration-ms", String(Math.round(spec.durationMs)));
	if (spec.channels?.length) args.push("--ch", spec.channels.map((c) => (c.name ? `${c.index}=${c.name}` : String(c.index))).join(","));
	if (spec.trigger && Object.keys(spec.trigger).length) args.push("--trigger", Object.entries(spec.trigger).map(([k, v]) => `${k}=${v}`).join(","));
	if (spec.triggerPositionPct !== undefined) args.push("--pos", String(Math.round(spec.triggerPositionPct)));
	if (spec.mode) args.push("--mode", spec.mode);
	if (spec.vth !== undefined) args.push("--vth", String(spec.vth));
	if (spec.timeoutMs) args.push("--timeout-ms", String(Math.round(spec.timeoutMs)));
	return args;
}

/**
 * 采集。引擎自己有等触发的超时(--timeout-ms),这里的 runEngine 超时再宽 30 秒当兜底,
 * 否则"触发没来"会表现成一次 SIGKILL 而不是一份 timed_out=true 的报告。
 */
export async function laCapture(ctx: LaEngineContext, spec: CaptureSpec, outDir: string, name: string): Promise<LaCaptureReport> {
	const engineTimeout = (spec.timeoutMs ?? 30_000) + 5_000;
	const r = assertEngineSettled(
		await runEngine(binOf(ctx), [...captureArgs(spec, outDir, name), ...dataArgs(ctx, "res")], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: engineTimeout + 30_000 }),
		"yoma-la capture",
	);
	const text = r.stdout.trim();
	if (!text) throw new Error(`yoma-la capture failed (exit ${r.exitCode}): ${stderrLines(r) || "(no output)"}`);
	const report = parseJsonStdout<LaCaptureReport>(r, "capture");
	(report as LaCaptureReport & { stderr?: string }).stderr = stderrLines(r);
	return report;
}

export interface DecodeSpec {
	input: string;
	/** --pd 串,例如 "i2c0=1:i2c:scl=1:sda=0" */
	pds: string[];
	from?: number;
	to?: number;
}

export async function laDecode(ctx: LaEngineContext, spec: DecodeSpec, outFile: string): Promise<{ annotations: number; elapsed_ms: number; ok: boolean; warnings: string }> {
	const args = ["decode", "--in", spec.input, "--out", outFile, ...dataArgs(ctx, "decoders")];
	for (const pd of spec.pds) args.push("--pd", pd);
	if (spec.from !== undefined) args.push("--from", String(spec.from));
	if (spec.to !== undefined) args.push("--to", String(spec.to));
	const r = assertEngineSettled(await runEngine(binOf(ctx), args, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 10 * 60_000 }), "yoma-la decode");
	if (r.exitCode !== 0) throw new Error(`yoma-la decode failed (exit ${r.exitCode}):\n${stderrLines(r) || "(no diagnostics)"}`);
	const tail = await lastLine(outFile);
	let end: { annotations: number; elapsed_ms: number; ok: boolean };
	try {
		end = JSON.parse(tail) as typeof end;
	} catch {
		throw new Error(`yoma-la decode: ${path.basename(outFile)} 没有 end 行,输出不完整`);
	}
	return { ...end, warnings: stderrLines(r) };
}

/** 文件的最后一行。end 行只有几十字节,而 NDJSON 可能上百 MB —— 只读尾部。 */
async function lastLine(file: string): Promise<string> {
	const fh = await open(file, "r");
	try {
		const size = (await fh.stat()).size;
		const want = Math.min(size, 64 * 1024);
		const buf = Buffer.alloc(want);
		await fh.read(buf, 0, want, size - want);
		const text = buf.toString("utf8").trimEnd();
		return text.slice(text.lastIndexOf("\n") + 1);
	} finally {
		await fh.close();
	}
}
