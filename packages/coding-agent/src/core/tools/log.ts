/**
 * log 工具:把板子的运行日志接进会话 —— RTT(probe-rs attach)或任意往 stdout
 * 吐日志的命令。五个动作(start/read/wait/status/stop)合成一个工具。
 *
 * 【为什么不是"再来一个 bash"】
 * 日志源是长驻、有状态、主动吐数据的,和一次性 spawn 的引擎工具(runEngine)正相反。
 * 所以这里有一个会话级采集器 LogCapture:子进程、环形缓冲、落盘文件都归它,
 * 五个动作只是对它发指令。采集器活在工具实例的闭包里 —— 一个会话一个日志源,
 * 不做全局注册表,也不做多端口。
 *
 * 【上下文纪律】(本工具的设计核心 —— 日志最容易淹没上下文)
 * 1. 全量永远落盘(<cwd>/.my-pi/logs/hw-*.log),给模型的永远是节选;
 *    查历史复用 read/grep 工具,不在这里造检索。
 * 2. 节选有两道预算:行数(maxLines)和**字符数** —— 只卡行数拦不住 4KB 一行的设备。
 * 3. 连续重复行折叠成 "×N";数字不同、其余相同的行(传感器刷屏)按"首行 + ×N + 末行"折叠。
 * 4. 超预算时按"头 + 命中关键字的行 + 尾"骨架采样:启动信息在头、最新状态在尾、
 *    异常在中间,三处都不能丢。
 * 5. wait 是主力动作:一次调用把"跑起来了没 / 崩了没"变成确定性结论。
 *    没命中时**不推游标** —— 预览是预览,证据不能因为看了一眼就消失。
 *
 * 【进程纪律】(评审确认过的两个真坑)
 * - detached + kill(-pid):`sh -c "stty … && cat …"` 里真正握着设备的是孙子进程,
 *   只杀 shell 会留下孤儿一直占着串口。与 harness NodeExecutionEnv 的 killProcessTree 同策。
 * - unref:采集中的子进程和它的管道绝不能拖住事件循环,否则 ACP 退出时进程不肯死。
 *
 * 【与 flash 的关系】探针同一时间只能被一个进程握住:烧录前先 log stop。
 *
 * 落盘用 node:fs 的 WriteStream 而不是 env.writeTextFile:后者是一次性读写,
 * 这里要的是行速率的追加。理由同 engines.ts 直接 spawn —— 这条路径本来就是本机的。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import {
	claimProbe,
	describeProbeConflict,
	type EnginePathOptions,
	engineBin,
	killTree,
	releaseProbe,
	unrefStream as unref,
} from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const LOG_ACTIONS = ["start", "read", "wait", "status", "stop"] as const;

export type LogAction = (typeof LOG_ACTIONS)[number];

/** 环形缓冲上限:两条一起兜住"行多"和"行长"两种撑爆方式。 */
const DEFAULT_BUFFER_LINES = 5000;
const DEFAULT_BUFFER_BYTES = 512 * 1024;
/** 一直不吐换行的设备不该把内存吃光:到这个长度就强制断行。 */
const MAX_LINE_CHARS = 4096;

const DEFAULT_MAX_LINES = 80;
const MAX_MAX_LINES = 500;
/** 单行进上下文的上限,超出的部分只在日志文件里。 */
const MAX_ROW_CHARS = 400;
/** 每行的字符预算:maxLines 换算成字符预算的系数。 */
const CHARS_PER_ROW = 160;
/** 一次节选的字符硬上限 —— 无论 maxLines 要多少,transcript 都不会被一次调用冲垮。 */
const MAX_EXCERPT_CHARS = 24_000;
/** 流式推给 UI 的窗口(不进 transcript)。 */
const UPDATE_ROWS = 20;
const UPDATE_CHARS = 4_000;
/** wait 没命中时的预览行数。 */
const PREVIEW_ROWS = 12;

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 120_000;
/** 骨架采样保留的开头行数(启动信息)。 */
const HEAD_ROWS = 5;
/** wait 命中时前后各带几行上下文。 */
const CONTEXT_ROWS = 3;
/** onUpdate 节流:行级刷新会把 UI 打爆。 */
const UPDATE_THROTTLE_MS = 100;
const FORCE_KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
/**
 * 'exit' 可能先于最后一段 stdout 到达(管道还没排干)。收到退出后再宽限这么久,
 * 免得"最后一行正好是要等的那条"被判成"源退出了,没等到"。
 */
const EXIT_DRAIN_MS = 200;

/** 超预算时优先保留的行:嵌入式日志里真正要紧的那几类。 */
const TRIPWIRE =
	/(hard\s?fault|bus\s?fault|mem\s?manage|usage\s?fault|panic|assert|fatal|exception|watchdog|stack overflow|\berrors?\b|\bwarn(ing)?\b|\bfail(ed|ure)?\b)/i;

export interface LogLine {
	seq: number;
	/** 相对采集启动的毫秒数。绝对时间对模型没用,相对时间才好推理。 */
	t: number;
	text: string;
	/** 来自 stderr(probe-rs 的诊断走这条)。 */
	err?: boolean;
}

export interface LogToolDetails {
	action: LogAction;
	running: boolean;
	cursor: number;
	totalLines: number;
	dropped: number;
	file?: string;
	/** wait 专有:是否命中。 */
	matched?: boolean;
	exitCode?: number | null;
}

// ─── 纯函数(导出给测试) ──────────────────────────────────────────────────────

/** ANSI 转义 + 除 tab 外的控制字符:留在上下文里只会污染 diff 和 token。 */
export function sanitizeText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 设备真的会吐控制字符
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * 把一段 chunk 切成完整行,返回残余(下一段的前缀)。
 * 纯函数:状态(pending)由调用方持有,于是可以逐段喂 fixture 做单测。
 */
export function splitChunk(
	pending: string,
	chunk: string,
	maxLineChars = MAX_LINE_CHARS,
): { lines: string[]; pending: string } {
	const lines: string[] = [];
	let buffer = pending + chunk.replace(/\r\n?/g, "\n");
	while (true) {
		const nl = buffer.indexOf("\n");
		if (nl >= 0) {
			lines.push(sanitizeText(buffer.slice(0, nl)));
			buffer = buffer.slice(nl + 1);
			continue;
		}
		// 没有换行但已经超长 —— 强制断行,否则 pending 会无限增长。
		if (buffer.length > maxLineChars) {
			lines.push(sanitizeText(buffer.slice(0, maxLineChars)));
			buffer = buffer.slice(maxLineChars);
			continue;
		}
		break;
	}
	return { lines, pending: buffer };
}

/**
 * 命令行切 argv,认单双引号(转义只在双引号里认 \" 和 \\)。
 * 不经过 shell:参数里的空格/分号不会被二次解释。
 */
export function splitArgv(command: string): string[] {
	const argv: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote === '"' && c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
			current += command[++i];
			started = true;
			continue;
		}
		if (quote) {
			if (c === quote) quote = undefined;
			else current += c;
			started = true;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			started = true;
			continue;
		}
		if (/\s/.test(c)) {
			if (started) argv.push(current);
			current = "";
			started = false;
			continue;
		}
		current += c;
		started = true;
	}
	if (quote) throw new Error(`unbalanced ${quote} in command: ${command}`);
	if (started) argv.push(current);
	return argv;
}

export interface AttachArgsInput {
	chip?: string;
	elfPath?: string;
	probe?: string;
	scanMemory?: boolean;
}

/**
 * probe-rs attach 的 argv。ELF 是位置参数且必需 —— RTT 控制块的符号从它里面找。
 * --non-interactive:没有 stdin,交互式选探针会直接挂住。
 * --no-timestamps:我们自己给每行盖相对时间戳,不要 defmt 再盖一遍。
 */
export function buildAttachArgs(input: AttachArgsInput): string[] {
	if (!input.chip) throw new Error('log start over a debug probe requires chip (e.g. "STM32F405RG")');
	if (!input.elfPath) throw new Error("log start over a debug probe requires elfPath (the ELF you flashed)");
	const args = ["attach", input.elfPath, "--chip", input.chip, "--non-interactive", "--no-timestamps"];
	if (input.probe) args.push("--probe", input.probe);
	if (input.scanMemory) args.push("--rtt-scan-memory");
	return args;
}

export interface FoldedRow {
	line: LogLine;
	/** 折叠进来的原始行数(1 = 没折叠)。 */
	count: number;
	/** 该组最后一行的相对时间。 */
	lastT: number;
	/** 组内末行的文本,仅当它与首行不同(数字变化的刷屏)时才有。 */
	lastText?: string;
}

/** 折叠比较用:把数字抹平,于是 "s=0413 ax=128" 和 "s=0459 ax=132" 属于同一类。 */
export function normalizeForFold(text: string): string {
	return text.replace(/\d+/g, "#");
}

/**
 * 连续同类的行折叠成一行。嵌入式日志的噪声大半是刷屏:
 * 完全相同 → "×N";只有数字在变 → 首行 + "×N" + 末行(数值漂移/饱和才看得出来)。
 */
export function foldLines(lines: LogLine[]): FoldedRow[] {
	const rows: FoldedRow[] = [];
	for (const line of lines) {
		const last = rows[rows.length - 1];
		if (last && !!last.line.err === !!line.err && normalizeForFold(last.line.text) === normalizeForFold(line.text)) {
			last.count++;
			last.lastT = line.t;
			if (line.text !== last.line.text) last.lastText = line.text;
			continue;
		}
		rows.push({ line, count: 1, lastT: line.t });
	}
	return rows;
}

export type DisplayRow =
	| { type: "line"; row: FoldedRow; marked?: boolean }
	/** count 是省略掉的**原始行数**(不是折叠后的组数)。 */
	| { type: "gap"; count: number };

/** `+2.131` —— 秒 + 三位小数,比毫秒整数好读也好对齐。 */
export function formatElapsed(ms: number): string {
	return `+${(ms / 1000).toFixed(3)}`;
}

/** 单行的字符上限:超长行只留头部,全文在日志文件里。 */
export function clipText(text: string, max = MAX_ROW_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} chars, full line in the log file)`;
}

export function renderLine(line: LogLine): string {
	return `[${formatElapsed(line.t)}] ${line.err ? "! " : ""}${line.text}`;
}

/** 渲染一条展示行。字符预算按它的返回值算,渲染与计价必须走同一个函数。 */
export function renderRow(entry: DisplayRow): string {
	if (entry.type === "gap") return `… ${entry.count} lines omitted (grep the full log for them) …`;
	const { row, marked } = entry;
	let text = `[${formatElapsed(row.line.t)}] ${row.line.err ? "! " : ""}${clipText(row.line.text)}`;
	if (row.count > 1) {
		text += ` ×${row.count}`;
		text += row.lastText
			? ` (numbers vary; last ${formatElapsed(row.lastT)}: ${clipText(row.lastText, 120)})`
			: ` (last ${formatElapsed(row.lastT)})`;
	}
	return marked ? `${text}   ← match` : text;
}

export function renderRows(rows: DisplayRow[]): string {
	return rows.map(renderRow).join("\n");
}

export interface SelectionResult {
	rows: DisplayRow[];
	/** 被省略的原始行数。 */
	omittedLines: number;
}

/**
 * 骨架采样:超预算时保留 头 + 中间命中 TRIPWIRE 的行 + 尾。
 * 两道预算一起卡 —— 行数管"多",字符数管"长"。
 */
export function selectForDisplay(rows: FoldedRow[], maxLines: number, maxChars = MAX_EXCERPT_CHARS): SelectionResult {
	const budget = Math.max(1, Math.trunc(maxLines));
	const charBudget = Math.max(MAX_ROW_CHARS, Math.trunc(maxChars));
	const cost = (index: number) => renderRow({ type: "line", row: rows[index]! }).length + 1;

	// 先按优先级把要保留的下标放进集合(集合天然去重,预算不会被重复计数),
	// 最后按下标顺序输出并在断裂处插省略标记。
	const keep = new Set<number>();
	let chars = 0;
	const take = (index: number): boolean => {
		if (keep.has(index)) return true;
		const next = cost(index);
		if (keep.size >= budget || chars + next > charBudget) return false;
		keep.add(index);
		chars += next;
		return true;
	};

	// 预算小到只够几行时全给尾巴:最新状态永远比启动信息重要。
	const headN = budget >= 4 ? Math.min(HEAD_ROWS, budget - 1) : 0;
	for (let i = 0; i < Math.min(headN, rows.length); i++) {
		if (!take(i)) break;
	}

	// 中间要紧的行:从后往前找,只留最新的几条 —— 越靠近故障现场越有用。
	const midBudget = Math.max(0, Math.min(Math.floor((budget - headN) / 4), budget - headN - 1));
	for (let i = rows.length - 1, found = 0; i >= headN && found < midBudget; i--) {
		if (TRIPWIRE.test(rows[i]!.line.text) && take(i)) found++;
	}

	// 预算剩下的部分从尾部往前填 —— 最新状态优先。第一条塞不下就收手,
	// 免得跳过一条长行、却把更旧的短行拉进来(顺序会变得莫名其妙)。
	for (let i = rows.length - 1; i >= 0; i--) {
		if (!take(i)) break;
	}

	const indices = [...keep].sort((a, b) => a - b);
	const out: DisplayRow[] = [];
	let previous = -1;
	let omittedLines = 0;
	const gapBefore = (index: number) => {
		let lines = 0;
		for (let i = previous + 1; i < index; i++) lines += rows[i]!.count;
		if (lines > 0) {
			out.push({ type: "gap", count: lines });
			omittedLines += lines;
		}
	};
	for (const index of indices) {
		gapBefore(index);
		out.push({ type: "line", row: rows[index]! });
		previous = index;
	}
	gapBefore(rows.length);
	return { rows: out, omittedLines };
}

function compilePattern(pattern: string): RegExp {
	try {
		return new RegExp(pattern, "i");
	} catch (error) {
		throw new Error(`invalid pattern /${pattern}/: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** maxLines 换算出的字符预算,封顶 MAX_EXCERPT_CHARS。 */
function charBudgetFor(maxLines: number): number {
	return Math.min(MAX_EXCERPT_CHARS, maxLines * CHARS_PER_ROW);
}

// ─── 采集器 ──────────────────────────────────────────────────────────────────

/** 进程退出时兜底杀掉还活着的采集子进程 —— 否则 probe-rs 会一直握着探针。 */
const liveCaptures = new Set<LogCapture>();
let cleanupHooksInstalled = false;

function installCleanupHooks(): void {
	if (cleanupHooksInstalled) return;
	cleanupHooksInstalled = true;
	process.once("exit", () => {
		for (const live of liveCaptures) live.killNow();
	});
	// 'exit' 不会因为信号而触发。只有在宿主没自己处理信号时才接管,
	// 接管后照旧退出(128+n),不改变宿主的可观察行为。
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		if (process.listenerCount(signal) > 0) continue;
		process.once(signal, () => {
			for (const live of liveCaptures) live.killNow();
			process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
		});
	}
}

export interface LogCaptureOptions {
	maxBufferLines?: number;
	maxBufferBytes?: number;
}

export interface WaitOutcome {
	kind: "matched" | "timeout" | "exited" | "aborted";
	line?: LogLine;
	rows: DisplayRow[];
	/** 本次等待期间新到的行数。 */
	newLines: number;
	/** 命中时:命中行之前被跳过的未读行数。 */
	skippedBefore?: number;
	/** 命中时:重看这些行的起点。 */
	resumeFrom?: number;
}

export class LogCapture {
	readonly argv: string[];
	readonly label: string;
	readonly file: string;
	readonly cwd: string;

	private child?: ChildProcess;
	private stream?: WriteStream;
	private pendingOut = "";
	private pendingErr = "";
	private readonly maxBufferLines: number;
	private readonly maxBufferBytes: number;
	private waiters = new Set<() => void>();
	private finished = false;

	lines: LogLine[] = [];
	nextSeq = 0;
	bufferedBytes = 0;
	totalLines = 0;
	dropped = 0;
	cursor = 0;
	startedAt = 0;
	exited?: { code: number | null; signal: string | null; at: number };

	constructor(argv: string[], label: string, file: string, cwd: string, options?: LogCaptureOptions) {
		if (argv.length === 0) throw new Error("log start needs a command to run");
		this.argv = argv;
		this.label = label;
		this.file = file;
		this.cwd = cwd;
		this.maxBufferLines = options?.maxBufferLines ?? DEFAULT_BUFFER_LINES;
		this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_BUFFER_BYTES;
	}

	get running(): boolean {
		return !!this.child && !this.exited;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** spawn 并等到 'spawn' 事件 —— 二进制不存在这类错误要在 start 就报出来。 */
	async start(): Promise<void> {
		this.startedAt = Date.now();
		this.stream = createWriteStream(this.file, { flags: "a" });
		// 落盘失败(磁盘满/权限)不该把会话打死:记一行进缓冲,继续采集。
		this.stream.on("error", (error) => {
			this.push(`log file write failed: ${String(error)}`, true);
			this.stream = undefined;
		});

		const child = spawn(this.argv[0]!, this.argv.slice(1), {
			cwd: this.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// 自成进程组,stop 才能连孙子进程一起收掉(见 killTree)。
			detached: process.platform !== "win32",
		});
		this.child = child;

		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", (error) => {
				// spawn 失败(二进制不存在等)不会有 'exit' 事件 —— 手动落一个终态,
				// 否则 running 会永远返回 true。
				this.exited = { code: null, signal: null, at: Date.now() };
				this.finish();
				reject(new Error(`failed to start log source \`${this.argv.join(" ")}\`: ${String(error)}`));
			});
		});

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.consume(chunk, false));
		child.stderr?.on("data", (chunk: string) => this.consume(chunk, true));
		child.on("exit", (code, signal) => {
			this.exited = { code, signal, at: Date.now() };
			this.flushPending();
			this.notify();
		});
		child.on("close", () => this.finish());

		// 采集绝不能拖住事件循环:宿主该退出时就退出(退出钩子负责收尸)。
		// 等待期间由 waitForChange 自己的定时器把循环撑住。
		child.unref();
		unref(child.stdout);
		unref(child.stderr);
		liveCaptures.add(this);
		installCleanupHooks();
	}

	private consume(chunk: string, err: boolean): void {
		const pending = err ? this.pendingErr : this.pendingOut;
		const split = splitChunk(pending, chunk);
		if (err) this.pendingErr = split.pending;
		else this.pendingOut = split.pending;
		for (const text of split.lines) this.push(text, err);
		if (split.lines.length > 0) this.notify();
	}

	/** 进程结束时把没等到换行的残余也算作一行,不然最后一句话会消失。 */
	private flushPending(): void {
		for (const [text, err] of [
			[this.pendingOut, false],
			[this.pendingErr, true],
		] as const) {
			const clean = sanitizeText(text).trim();
			if (clean) this.push(clean, err);
		}
		this.pendingOut = "";
		this.pendingErr = "";
	}

	private push(text: string, err: boolean): void {
		const line: LogLine = { seq: this.nextSeq++, t: Date.now() - this.startedAt, text, ...(err ? { err: true } : {}) };
		this.lines.push(line);
		this.totalLines++;
		this.bufferedBytes += text.length + 1;
		this.stream?.write(`${renderLine(line)}\n`);
		this.trim();
	}

	/** 环形缓冲:超限从头丢,丢掉的只在文件里,dropped 必须显式告诉模型。 */
	private trim(): void {
		let drop = 0;
		while (
			this.lines.length - drop > this.maxBufferLines ||
			(this.bufferedBytes > this.maxBufferBytes && this.lines.length - drop > 1)
		) {
			this.bufferedBytes -= this.lines[drop]!.text.length + 1;
			drop++;
		}
		if (drop > 0) {
			this.lines.splice(0, drop);
			this.dropped += drop;
		}
	}

	private notify(): void {
		for (const wake of this.waiters) wake();
	}

	/** 有新行 / 进程退出 / 超时 / 中断,四者任一即返回。 */
	private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				this.waiters.delete(wake);
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const wake = () => done();
			const timer = setTimeout(done, Math.max(0, timeoutMs));
			this.waiters.add(wake);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	/** waitForChange 也会被"来了新行"叫醒,所以这里必须循环等到真的退出或到点。 */
	private async waitForExit(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.exited && Date.now() < deadline) {
			await this.waitForChange(deadline - Date.now());
		}
	}

	/** 自 seq 起的行(游标落在已丢弃区间时从最老的一行开始)。 */
	linesSince(seq: number): { lines: LogLine[]; lost: number } {
		const oldest = this.lines[0]?.seq ?? this.nextSeq;
		const lost = Math.max(0, Math.min(oldest, this.nextSeq) - seq);
		return { lines: this.lines.filter((line) => line.seq >= seq), lost };
	}

	/** 最近若干行的节选,用于 wait 的预览和流式更新 —— 同样走折叠 + 骨架采样。 */
	previewRows(fromSeq: number, maxRows: number, maxChars: number): DisplayRow[] {
		const { lines } = this.linesSince(fromSeq);
		return selectForDisplay(foldLines(lines), maxRows, maxChars).rows;
	}

	read(options: { since?: number; pattern?: string; maxLines: number }): {
		text: string;
		from: number;
		/** 窗口里的原始行数。 */
		rawTotal: number;
		/** 过滤后剩下的原始行数(无 pattern 时等于 rawTotal)。 */
		matchedLines: number;
		/** 折叠后的组数。 */
		groups: number;
		omittedLines: number;
		lost: number;
	} {
		const from = options.since ?? this.cursor;
		const { lines, lost } = this.linesSince(from);
		const filter = options.pattern ? compilePattern(options.pattern) : undefined;
		const selected = filter ? lines.filter((line) => filter.test(line.text)) : lines;
		const folded = foldLines(selected);
		const display = selectForDisplay(folded, options.maxLines, charBudgetFor(options.maxLines));
		// pattern 是查询而不是消费:过滤读不推游标,否则没匹配上的行就被悄悄跳过了。
		if (!filter && lines.length > 0) this.cursor = this.nextSeq;
		return {
			text: renderRows(display.rows),
			from,
			rawTotal: lines.length,
			matchedLines: selected.length,
			groups: folded.length,
			omittedLines: display.omittedLines,
			lost,
		};
	}

	/**
	 * 等到有新行命中 pattern。先查已缓冲的行 —— 板子往往在模型调用 wait 之前就已经打完了。
	 * 命中才推游标;超时/退出/中断只给预览,游标原样保留(证据不能因为看了一眼就消失)。
	 */
	async wait(options: {
		pattern: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onTick?: () => void;
	}): Promise<WaitOutcome> {
		const re = compilePattern(options.pattern);
		const startCursor = this.cursor;
		const deadline = Date.now() + options.timeoutMs;
		let drainedAfterExit = false;
		while (true) {
			const { lines } = this.linesSince(this.cursor);
			const hit = lines.find((line) => re.test(line.text));
			if (hit) {
				// 上下文从整个缓冲里取,而不是只从未读窗口 —— 读过一轮之后命中,
				// 前文照样要给,否则模型看到的是一条没有来龙去脉的孤行。
				const index = this.lines.findIndex((line) => line.seq === hit.seq);
				const context = this.lines.slice(Math.max(0, index - CONTEXT_ROWS), index + CONTEXT_ROWS + 1);
				const rows = foldLines(context).map(
					(row) => ({ type: "line", row, marked: row.line.seq === hit.seq }) as DisplayRow,
				);
				const skippedBefore = Math.max(0, context[0]!.seq - startCursor);
				this.cursor = Math.max(this.cursor, context[context.length - 1]!.seq + 1);
				return {
					kind: "matched",
					line: hit,
					rows,
					newLines: this.nextSeq - startCursor,
					skippedBefore,
					resumeFrom: startCursor,
				};
			}
			const preview = () => ({
				rows: this.previewRows(this.cursor, PREVIEW_ROWS, charBudgetFor(PREVIEW_ROWS)),
				newLines: this.nextSeq - startCursor,
			});
			if (options.signal?.aborted) return { kind: "aborted", ...preview() };
			if (this.exited) {
				// 'exit' 可能跑在最后一段 stdout 前面 —— 排干管道再判一次,
				// 否则"最后一行正好是要等的那条"会被误报成"源退出了,没等到"。
				if (!drainedAfterExit) {
					drainedAfterExit = true;
					await this.waitForChange(EXIT_DRAIN_MS);
					continue;
				}
				return { kind: "exited", ...preview() };
			}
			if (Date.now() >= deadline) return { kind: "timeout", ...preview() };
			await this.waitForChange(deadline - Date.now(), options.signal);
			options.onTick?.();
		}
	}

	/** 'close'(管道排干)才算收全;finish() 就挂在它上面。 */
	private async waitForClose(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.finished && Date.now() < deadline) {
			await this.waitForChange(deadline - Date.now());
		}
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (child && !this.exited) {
			killTree(child, "SIGTERM");
			const force = setTimeout(() => {
				if (!this.exited) killTree(child, "SIGKILL");
			}, FORCE_KILL_GRACE_MS);
			force.unref();
			await this.waitForExit(EXIT_WAIT_MS);
			clearTimeout(force);
		}
		// 退出之后给管道一点排干时间,最后几行才不会连同 finish() 一起被丢掉。
		if (this.exited) await this.waitForClose(EXIT_DRAIN_MS);
		this.finish();
	}

	/** 同步、绝不抛:只给进程退出/信号钩子用。 */
	killNow(): void {
		if (!this.child) return;
		killTree(this.child, "SIGKILL");
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		// 先断源再收尾:stop() 之后哪怕子进程还活着(比如被孤儿孙进程握着管道),
		// 也不能再往缓冲和文件里塞行 —— 否则 running=false 却还在长。
		this.child?.stdout?.removeAllListeners("data");
		this.child?.stderr?.removeAllListeners("data");
		this.flushPending();
		this.child?.stdout?.destroy();
		this.child?.stderr?.destroy();
		this.stream?.end();
		this.stream = undefined;
		liveCaptures.delete(this);
		this.notify();
	}
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

const logSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
	action: Type.Union(
		[Type.Literal("start"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("status"), Type.Literal("stop")],
		{ description: "start | read | wait | status | stop" },
	),
	chip: Type.Optional(
		Type.String({ description: 'start over a debug probe: target chip name, e.g. "STM32F405RG" (RTT via probe-rs).' }),
	),
	elfPath: Type.Optional(
		Type.String({ description: "start over a debug probe: the ELF running on the target (RTT symbols come from it)." }),
	),
	probe: Type.Optional(
		Type.String({ description: 'Probe selector "VID:PID" or "VID:PID:Serial" when several are connected.' }),
	),
	scanMemory: Type.Optional(
		Type.Boolean({ description: "Scan RAM for the RTT control block when the ELF has no symbol for it." }),
	),
	command: Type.Optional(
		Type.String({
			description:
				"start from any other source: a command line whose stdout is the log (no shell unless you spawn one yourself).",
		}),
	),
	pattern: Type.Optional(
		Type.String({ description: "wait: regex to wait for (case-insensitive). read: only show matching lines." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: `wait: give up after this long (default ${DEFAULT_WAIT_MS}).` })),
	since: Type.Optional(Type.Number({ description: "read: start from this cursor instead of the last one." })),
	maxLines: Type.Optional(Type.Number({ description: `read: max lines to show (default ${DEFAULT_MAX_LINES}).` })),
});

export type LogToolInput = Static<typeof logSchema>;

export type LogToolOptions = EnginePathOptions;

const DESCRIPTION = `Captures the running board's log output — RTT over a debug probe, or any command that prints to stdout — so you can see what the firmware actually did instead of guessing from the source.

Actions:
- start (chip + elfPath, or command): begin capturing. Debug probe/RTT: pass chip and the elfPath you flashed. Anything else: pass command, e.g. a USB serial port on macOS: sh -c "stty -f /dev/cu.usbmodem1103 115200 raw && cat /dev/cu.usbmodem1103"
- wait (pattern, [timeoutMs]): block until a new line matches the regex, the source exits, or the timeout expires. THIS IS THE MAIN ACTION — one call turns "did it boot / did it crash" into a definite answer and returns only the matched line plus a few lines of context. A wait that does not match leaves the cursor untouched, so nothing is lost: follow it with read.
- read ([since], [pattern], [maxLines]): the tail of whatever arrived since the last read, then advances the cursor. With pattern it only shows matching lines and does not move the cursor (it is a query, not a consumption).
- status: whether the source is still running, how many lines were captured, where the full log file is.
- stop: end the capture. The log file stays.

Rules:
- Every line is written to a log file; this tool only ever returns a bounded excerpt (tail, folded repeats, "N lines omitted"). To search history, grep the log file path it reports — do not ask this tool for a bigger excerpt.
- Repeated lines are folded ("×137"); lines that differ only in numbers fold too, showing the first and the last of the run. Exact values are in the log file.
- Prefer wait over read: read costs tokens and gives you a wall of text, wait costs one call and gives you a conclusion.
- A debug probe can only be held by one process: stop the capture before flash download/erase/reset, then start it again.
- RTT only produces output while the target is running and only if the firmware writes to it. Silence is not proof of a crash — check status and the flash/reset results too.
- Never claim the firmware printed, booted, or crashed unless a log line here shows it.`;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function logFileName(now = new Date()): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
	return `hw-${stamp}.log`;
}

function sourceState(capture: LogCapture): string {
	if (capture.running) return "running";
	if (!capture.exited) return "not started";
	const { code, signal } = capture.exited;
	return `exited (${signal ? `signal ${signal}` : `code ${code}`})`;
}

/**
 * 每条结果的尾行。日志文件路径很长,只在模型可能需要 grep 时才给
 * (有省略/有丢弃),否则每次调用白烧几十个 token。
 */
function footer(capture: LogCapture, needsFile: boolean): string {
	const dropped = capture.dropped > 0 ? ` | ${capture.dropped} dropped from the buffer` : "";
	const file = needsFile || capture.dropped > 0 ? ` | full log: ${capture.file}` : "";
	return `cursor: ${capture.cursor} | source: ${sourceState(capture)}${dropped}${file}`;
}

export function createLogToolDefinition(
	env: ExecutionEnv,
	options?: LogToolOptions,
): ToolDefinition<typeof logSchema, LogToolDetails> {
	// 一个工具实例 = 一个会话 = 一个日志源。闭包持有,不做全局注册表。
	let capture: LogCapture | undefined;
	/** 这次采集是不是握着探针(只有 RTT 那条路握)。 */
	let heldProbe = false;

	const dropProbe = () => {
		if (!heldProbe) return;
		heldProbe = false;
		releaseProbe("log");
	};

	const requireCapture = (action: LogAction): LogCapture => {
		if (!capture) throw new Error(`no log capture — run \`log start\` (${action} needs a running source)`);
		return capture;
	};

	const detailsOf = (action: LogAction, extra?: Partial<LogToolDetails>): LogToolDetails => ({
		action,
		running: capture?.running ?? false,
		cursor: capture?.cursor ?? 0,
		totalLines: capture?.totalLines ?? 0,
		dropped: capture?.dropped ?? 0,
		file: capture?.file,
		exitCode: capture?.exited?.code,
		...extra,
	});

	return {
		name: "log",
		label: "log",
		description: DESCRIPTION,
		promptSnippet: "Capture and query the board's runtime log (RTT / serial)",
		promptGuidelines: [
			"Never claim firmware booted, printed, or crashed without a log line proving it; use log wait rather than dumping the log.",
		],
		parameters: logSchema,
		// 探针/串口是独占资源:这个工具的调用之间不并发。
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			switch (params.action) {
				case "start": {
					if (capture?.running) {
						throw new Error(
							`already capturing ${capture.label} (${capture.totalLines} lines so far). Run \`log stop\` first.`,
						);
					}
					let argv: string[];
					let label: string;
					/** command 模式(串口)不碰探针,只有 RTT 那条路要租约。 */
					let needsProbe = false;
					if (params.command) {
						argv = splitArgv(params.command);
						if (argv.length === 0) throw new Error("log start: command is empty");
						label = argv.join(" ");
					} else {
						needsProbe = true;
						const elfPath = params.elfPath ? await resolveToCwd(env, params.elfPath) : undefined;
						if (elfPath) {
							const exists = await env.exists(elfPath);
							if (!exists.ok || !exists.value) throw new Error(`ELF file not found: ${elfPath}`);
						}
						argv = [
							engineBin("probe-rs", options),
							...buildAttachArgs({
								chip: params.chip,
								elfPath,
								probe: params.probe,
								scanMemory: params.scanMemory,
							}),
						];
						label = `probe-rs RTT (${params.chip})`;
					}

					if (needsProbe) {
						const holder = claimProbe("log", label, () => capture?.running === true);
						if (holder) throw new Error(`log start: ${describeProbeConflict(holder)}`);
					}

					const file = path.join(env.cwd, ".my-pi", "logs", logFileName());
					const dir = await env.createDir(path.dirname(file), { recursive: true });
					if (!dir.ok) throw new Error(`could not create the log directory: ${dir.error.message}`);

					const started = new LogCapture(argv, label, file, env.cwd);
					try {
						await started.start();
					} catch (error) {
						if (needsProbe) releaseProbe("log");
						throw error;
					}
					capture = started;
					heldProbe = needsProbe;
					const text = `Capturing ${label}${started.pid ? ` (pid ${started.pid})` : ""}.
Full log: ${file}
Next: \`log wait\` with a pattern (e.g. "boot|fault|error") — it blocks until something matches instead of dumping the log.`;
					return { content: [{ type: "text", text }], details: detailsOf("start") };
				}

				case "read": {
					const active = requireCapture("read");
					const maxLines = clamp(params.maxLines, DEFAULT_MAX_LINES, 1, MAX_MAX_LINES);
					const result = active.read({ since: params.since, pattern: params.pattern, maxLines });

					let header: string;
					if (params.pattern) {
						header = `${result.matchedLines} of ${result.rawTotal} lines since seq ${result.from} match /${params.pattern}/`;
						if (result.omittedLines > 0) header += ` — showing the newest, ${result.omittedLines} omitted`;
					} else if (result.rawTotal === 0) {
						header = `no new lines since seq ${result.from}`;
					} else {
						header = `+${result.rawTotal} new lines since seq ${result.from}`;
						const notes: string[] = [];
						if (result.groups !== result.rawTotal) notes.push(`folded to ${result.groups} groups`);
						if (result.omittedLines > 0) notes.push(`${result.omittedLines} lines omitted from this excerpt`);
						if (notes.length > 0) header += ` (${notes.join("; ")})`;
					}
					const lost =
						result.lost > 0
							? `\n${result.lost} older lines already fell out of the buffer — grep the log file for them.`
							: "";
					const body = result.text ? `\n\n${result.text}\n` : "\n";
					const needsFile = result.omittedLines > 0 || result.lost > 0;
					return {
						content: [{ type: "text", text: `${header}${lost}${body}\n${footer(active, needsFile)}` }],
						details: detailsOf("read"),
					};
				}

				case "wait": {
					const active = requireCapture("wait");
					if (!params.pattern) throw new Error("log wait requires pattern (a regex to wait for)");
					const timeoutMs = clamp(params.timeoutMs, DEFAULT_WAIT_MS, 100, MAX_WAIT_MS);

					// 等待期间把新行流式推给 UI(不进 transcript)—— 这就是"日志窗口"。
					let lastUpdate = 0;
					const tick = () => {
						if (!onUpdate) return;
						const now = Date.now();
						if (now - lastUpdate < UPDATE_THROTTLE_MS) return;
						lastUpdate = now;
						const rows = active.previewRows(Math.max(0, active.nextSeq - UPDATE_ROWS), UPDATE_ROWS, UPDATE_CHARS);
						onUpdate({ content: [{ type: "text", text: renderRows(rows) }], details: detailsOf("wait") });
					};
					tick();

					const outcome = await active.wait({ pattern: params.pattern, timeoutMs, signal, onTick: tick });
					const body = outcome.rows.length > 0 ? `\n\n${renderRows(outcome.rows)}\n` : "\n";
					let header: string;
					switch (outcome.kind) {
						case "matched": {
							header = `matched /${params.pattern}/ at seq ${outcome.line!.seq} (${formatElapsed(outcome.line!.t)}s)`;
							if (outcome.skippedBefore! > 0) {
								header += `\n${outcome.skippedBefore} earlier unread lines were skipped — \`log read since=${outcome.resumeFrom}\` or grep the log file for them.`;
							}
							break;
						}
						case "exited":
							header =
								`source ${sourceState(active)} before /${params.pattern}/ matched ` +
								`(${outcome.newLines} new lines; cursor unchanged, \`log read\` for all of them)`;
							break;
						case "aborted":
							header = `aborted while waiting for /${params.pattern}/ (cursor unchanged)`;
							break;
						default:
							header =
								`timed out after ${timeoutMs} ms without matching /${params.pattern}/ ` +
								`(${outcome.newLines} new lines; cursor unchanged, \`log read\` for all of them). ` +
								`The target may be halted, silent, or not writing to this source.`;
					}
					const needsFile = outcome.kind !== "matched" || (outcome.skippedBefore ?? 0) > 0;
					return {
						content: [{ type: "text", text: `${header}${body}\n${footer(active, needsFile)}` }],
						details: detailsOf("wait", { matched: outcome.kind === "matched" }),
					};
				}

				case "status": {
					const active = requireCapture("status");
					const uptime = ((active.exited?.at ?? Date.now()) - active.startedAt) / 1000;
					const last = active.lines[active.lines.length - 1];
					const unread = active.nextSeq - active.cursor;
					const text = [
						`source: ${sourceState(active)}${active.pid ? ` (pid ${active.pid})` : ""} — ${active.label}`,
						`${active.totalLines} lines in ${uptime.toFixed(1)}s | ${active.lines.length} buffered | ${active.dropped} dropped | ${unread} unread`,
						last ? `last line: ${renderRow({ type: "line", row: { line: last, count: 1, lastT: last.t } })}` : "no output yet",
						footer(active, true),
					].join("\n");
					return { content: [{ type: "text", text }], details: detailsOf("status") };
				}

				case "stop": {
					const active = requireCapture("stop");
					await active.stop();
					dropProbe();
					const uptime = ((active.exited?.at ?? Date.now()) - active.startedAt) / 1000;
					// 没能确认退出就别说"停了" —— 模型据此判断探针/串口是否已经放开。
					const survived = active.exited
						? ""
						: `\n⚠️ the source did not confirm exit within ${EXIT_WAIT_MS} ms; it was force-killed. Verify the device is free before flashing.`;
					const text =
						`stopped ${active.label} after ${uptime.toFixed(1)}s and ${active.totalLines} lines.${survived}\n` +
						`Full log: ${active.file}`;
					return { content: [{ type: "text", text }], details: detailsOf("stop") };
				}
			}
		},
	};
}

export function createLogTool(env: ExecutionEnv, options?: LogToolOptions) {
	return wrapToolDefinition(createLogToolDefinition(env, options));
}
