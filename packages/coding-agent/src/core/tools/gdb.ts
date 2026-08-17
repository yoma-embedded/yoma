/**
 * gdb 工具:把一个活的调试会话接进 agent 循环。六个动作
 * (start/break/exec/eval/status/stop)合成一个工具,纯函数层在 gdb-mi.ts。
 *
 * 【为什么是 gdb 而不是 DAP】
 * C 嵌入式这一侧的既成事实是 OpenOCD / J-Link / pyOCD + arm-none-eabi-gcc。
 * 没有 OpenOCD 的 DAP server,也没有 J-Link 的;而 gdb 是通用语,今天 STM32,
 * 明天 qemu / RISC-V / 别人的 gdbserver 都是同一套。所以传输是 MI3。
 *
 * 【三条实测事实,决定了下面的骨架】
 * 1. `mi-async` 默认 **off**,而 off 的时候第一条 `-exec-continue` 之后 gdb
 *    就不再读 stdin —— 后续所有命令(包括 interrupt、包括 stop)石沉大海,
 *    只能 SIGKILL。所以启动握手里它是硬性开关,而且必须回读校验。
 * 2. 结果记录在它引起的异步记录**之后**到(实测 `*stopped` 先于 `20^connected`)。
 *    所以等停止的 waiter 必须在**发命令之前**装好,否则会漏掉已经到达的停止。
 * 3. 单条 MI record 能有 5 万甚至 65 万字符,而且 `(gdb) ` 在异步停止后不发。
 *    分帧只按 \n,派发只认 `^`。细节见 gdb-mi.ts。
 *
 * 【上下文纪律】同 log.ts:全量落盘,进上下文的一律有界且**截断必须标注**。
 * 落两份:session-*.log 是解码后的可读转录(模型 grep / 人 tail -f),
 * session-*.mi 是原始对话(只给调工具用,不告诉模型)。stops-*.jsonl 每次停止一行,
 * 让"我们之前停在哪"在自动压缩之后还能查得到。
 *
 * 【进程纪律】两个子进程(server + gdb),都 detached 自成进程组、都 unref。
 * 关闭顺序是先 `-gdb-exit` 再关 server —— 反过来 gdb 会卡在 remote 等待里。
 * 孤儿 gdbserver 攥着探针,下次的失败长得和硬件坏了一模一样,而拔插 USB 能
 * "修好",于是错误假设被确认、泄漏永远找不到。
 *
 * 【明确不做的一件事】没有"连上→跑一条→断开"的一次性动作。--batch 式的
 * attach/detach 会在连接时暂停目标、退出时恢复目标,于是模型分不清"固件跑了"
 * 和"我自己的查询让它跑了"(实测连续三次一次性查询同一个计数器,读到
 * 0 → 2,825,990 → 5,672,733)。这条别再提。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { open as openFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import {
	claimProbe,
	clamp,
	describeProbeConflict,
	exe,
	killOnHostExit,
	killTree,
	appendProbeOccupationHint,
	releaseProbe,
	stamp,
	unrefStream as unref,
} from "./engines.ts";
import { readFlashState, sha256File } from "./flash.ts";
import {
	clip,
	type CoreId,
	decodeBreakpointUnits,
	decodeCpuid,
	decodeDfsr,
	decodeDhcsr,
	decodeException,
	decodeExcReturn,
	decodeFault,
	decodeStackedFrame,
	decodeWatchpointUnits,
	escapeCString,
	type Frame,
	frameOf,
	frameRecords,
	hex,
	type MiRecord,
	type MiTuple,
	miNumber,
	miString,
	miTuple,
	parseRecord,
	renderFrame,
	renderFrames,
	SCB,
	unwrapList,
} from "./gdb-mi.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const GDB_ACTIONS = ["start", "break", "exec", "eval", "status", "stop"] as const;
export type GdbAction = (typeof GDB_ACTIONS)[number];

export const EXEC_OPS = [
	"continue",
	"step",
	"next",
	"finish",
	"stepi",
	"interrupt",
	"wait",
	"reset-halt",
	"reset-run",
] as const;
export type ExecOp = (typeof EXEC_OPS)[number];

export const GDB_SERVERS = ["qemu", "openocd", "jlink", "external"] as const;
export type GdbServerKind = (typeof GDB_SERVERS)[number];

/** 单条 MI 命令的默认上限。gdb 卡住是常态(探针掉了、目标进 WFI),每条都要有界。 */
const COMMAND_TIMEOUT_MS = 20_000;
/** attach / compare-sections 这类要走 SWD 读大段内存的,给宽一点。 */
const ATTACH_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 120_000;
/** server 从 spawn 到 gdb 端口可连的上限。 */
const SERVER_READY_MS = 20_000;
const TCP_POLL_MS = 100;
/** -exec-interrupt 只表示"中断已发出",不表示停了。每一级都要有界。 */
const INTERRUPT_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
/** exec 的 count 上限:再多就该写脚本了,而且返回值会撑爆预算。 */
const MAX_STEP_COUNT = 20;
/** server 输出留几行用于报错 —— 连接失败时 gdb 只会说 "Connection refused",信息全在 server 那边。 */
const SERVER_TAIL_LINES = 20;

// ─── 服务器适配表 ────────────────────────────────────────────────────────────
//
// 只放三样东西:argv 怎么拼、就绪怎么判、能力有哪些。能力不是装饰:
// qemu 的观察点实测 Z2/Z3/Z4 返回 OK、命中后 100% CPU 永久空转 —— 不把这类事实
// 写进表里,模型就会对着一个永远不会命中的观察点推理半小时。rttHint 同理:
// RTT 从 server 自己的 TCP 口读(J-Link 的 19021 / OpenOCD 的 rtt server),
// 不写进 attach 报告模型就不知道日志从哪来。

export interface ServerCaps {
	/** 观察点:hw 表示可用,none 表示这个 server 根本不支持,要当场拒绝。 */
	watchpoints: "hw" | "none";
	resetHalt?: string;
	resetRun?: string;
	/** attach 报告里的一句话:这个 server 的 RTT 从哪拿。没有(qemu/external)就不提。 */
	rttHint?: string;
	/** 就绪判据。没有的(qemu)只能靠 TCP 轮询。 */
	readyRe?: RegExp;
}

export const SERVER_CAPS: Record<GdbServerKind, ServerCaps> = {
	// OpenOCD 的这条是唯一可信的就绪线:它在 target examine 成功之后才打印。
	// 4444/6666 在适配器初始化之前就绑上了,拿它们判断会在目标没连上时误判成功。
	openocd: {
		watchpoints: "hw",
		resetHalt: "monitor reset halt",
		resetRun: "monitor reset run",
		rttHint:
			'RTT: gdb eval (write: true) `monitor rtt setup <ctrl-block-addr> <size> "SEGGER RTT"`, `monitor rtt start`, `monitor rtt server start <port> 0`, then `log start tcp:"localhost:<port>"`',
		readyRe: /Listening on port \d+ for gdb connections/,
	},
	jlink: {
		watchpoints: "hw",
		resetHalt: "monitor reset",
		resetRun: "monitor go",
		rttHint: 'RTT: JLinkGDBServer already serves it — `log start tcp:"localhost:19021"`',
		readyRe: /Listening on TCP\/IP port \d+/,
	},
	// QEMU 成功时 stdout/stderr 都是空的(实测),只能轮询端口。
	qemu: {
		watchpoints: "none", // 实测:Z2/Z3/Z4 返回 OK,一旦命中 QEMU 100% CPU 永久空转
	},
	external: {
		watchpoints: "hw",
	},
};

export interface ServerArgvInput {
	server: GdbServerKind;
	port: number;
	chip?: string;
	elfPath?: string;
	config?: string[];
	machine?: string;
}

/** 纯 argv 构造,导出给测试。external 不起进程。 */
export function buildServerArgv(input: ServerArgvInput): string[] {
	const { server, port } = input;
	switch (server) {
		case "external":
			return [];
		case "openocd": {
			const cfgs = input.config ?? [];
			if (cfgs.length === 0) {
				throw new Error(
					'gdb start with server:"openocd" needs config, e.g. config:["interface/stlink.cfg","target/stm32g4x.cfg"]',
				);
			}
			const argv = ["openocd"];
			for (const c of cfgs) argv.push("-f", c);
			argv.push("-c", `gdb_port ${port}`);
			return argv;
		}
		case "jlink": {
			if (!input.chip) throw new Error('gdb start with server:"jlink" needs chip, e.g. chip:"STM32G431CB"');
			return [
				"JLinkGDBServer",
				"-device",
				input.chip,
				"-if",
				"SWD",
				"-speed",
				"4000",
				"-port",
				String(port),
				"-nogui",
				"-silent",
			];
		}
		case "qemu": {
			if (!input.machine) {
				throw new Error(
					'gdb start with server:"qemu" needs machine, e.g. machine:"netduinoplus2" (STM32F405, Cortex-M4F)',
				);
			}
			if (!input.elfPath) throw new Error('gdb start with server:"qemu" needs elfPath');
			return [
				"qemu-system-arm",
				"-machine",
				input.machine,
				"-kernel",
				input.elfPath,
				"-semihosting-config",
				"enable=on,target=native",
				"-nographic",
				"-serial",
				"none",
				"-monitor",
				"none",
				"-S",
				"-gdb",
				`tcp::${port}`,
			];
		}
	}
}

// ─── eval 闸门 ───────────────────────────────────────────────────────────────
//
// 三个实测的坑,任何一个都能让会话再也回不来:
// - `pipe` / `shell` / `!` 把裸字节写到 gdb 的 stdout,绕开 MI 分帧(实测
//   `pipe print 1+1 | cat` 产出了不在任何 record 里的 `$1 = 2`)。永久损坏。
// - `-gdb-set <不认识的名字> = 值` 不报错,它当表达式**写目标内存**。
// - `set logging redirect on` 把整条 MI 流偷进文件,驱动变聋而 gdb 一切正常。
//
// 运行控制类动词**转发**到 exec 而不是拒绝:模型会的是 gdb 不是这个工具,
// 拒绝什么也没教会它,转发零成本。

const BLOCKED_RE = /^\s*(shell|!|pipe|python|py|run|start|attach|detach|target|file|quit|q|kill)\b/i;
const BLOCKED_SET_RE = /^\s*set\s+(logging|confirm|pagination|height|width|editing)\b/i;
/** 写目标的动词。这些要显式 write:true,并在文件里留下可 grep 的痕迹。 */
const MUTATING_RE = /^\s*(set\s+var(iable)?|set\s+\$|call|jump|return|restore|dprintf|compare-sections\s+-w)\b/i;
const MONITOR_RE = /^\s*monitor\b/i;

const REROUTE: Record<string, ExecOp> = {
	c: "continue",
	cont: "continue",
	continue: "continue",
	s: "step",
	step: "step",
	n: "next",
	next: "next",
	fin: "finish",
	finish: "finish",
	si: "stepi",
	stepi: "stepi",
	interrupt: "interrupt",
};

export type EvalClass =
	| { kind: "blocked"; reason: string }
	| { kind: "reroute"; op: ExecOp }
	| { kind: "mutating"; reason: string }
	| { kind: "read" };

export function classifyEval(command: string): EvalClass {
	const trimmed = command.trim();
	if (trimmed === "") return { kind: "blocked", reason: "empty command" };

	const first = trimmed.split(/\s+/)[0]!.toLowerCase();
	const rerouted = REROUTE[first];
	if (rerouted && trimmed.split(/\s+/).length === 1) return { kind: "reroute", op: rerouted };

	if (BLOCKED_RE.test(trimmed)) {
		return {
			kind: "blocked",
			reason:
				"this command either writes raw bytes to gdb's stdout (shell/!/pipe/python) and permanently corrupts the MI stream, or takes over the session (run/start/attach/detach/target/file/quit). Use gdb exec for run control and gdb stop to end the session.",
		};
	}
	if (BLOCKED_SET_RE.test(trimmed)) {
		return {
			kind: "blocked",
			reason: "this setting is owned by the tool (logging/confirm/pagination/height/width); changing it breaks the driver.",
		};
	}
	if (MUTATING_RE.test(trimmed) || MONITOR_RE.test(trimmed)) {
		return {
			kind: "mutating",
			reason: `\`${first}\` changes the target (memory, registers or the running state). Re-send with write: true if that is what you mean.`,
		};
	}
	// 裸 `set foo = 1`:gdb 认不出的设置名会被当表达式,静默写目标内存。
	if (/^\s*set\s+/i.test(trimmed)) {
		return {
			kind: "blocked",
			reason:
				'a bare `set <name>` that gdb does not recognise as a setting is parsed as an EXPRESSION and silently writes target memory. Write `set variable X = Y` (with write: true) for a memory write, or use `-gdb-show <name>` to check a setting name first.',
		};
	}
	return { kind: "read" };
}

// ─── gdb 二进制解析 ──────────────────────────────────────────────────────────

/** ELF 头偏移 0x12 的 e_machine(小端)。0x28=ARM、0xF3=RISC-V、0xB7=AArch64。 */
export function elfMachine(head: Uint8Array): number | undefined {
	if (head.length < 0x14) return undefined;
	if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return undefined;
	// e_ident[EI_DATA]:1 小端,2 大端。嵌入式基本都是小端,但别假设。
	const little = head[5] !== 2;
	return little ? head[0x12]! | (head[0x13]! << 8) : (head[0x12]! << 8) | head[0x13]!;
}

/**
 * 按 ELF 的架构挑 gdb。**绝不走 engineBin**:那会抛"跑 `bun engines/build.ts`",
 * 而 build.ts 不该编译交叉工具链 —— 模型会照做、成功、再撞同一个错。
 */
export function preferredGdbNames(machine: number | undefined): string[] {
	if (machine === 0x28) return ["arm-none-eabi-gdb", "gdb-multiarch", "gdb"];
	if (machine === 0xf3) return ["riscv64-unknown-elf-gdb", "riscv32-unknown-elf-gdb", "gdb-multiarch", "gdb"];
	return ["gdb-multiarch", "gdb"];
}

// ─── 会话状态 ────────────────────────────────────────────────────────────────

export type TargetState = "halted" | "running" | "exited" | "connection-lost";

export interface StopInfo {
	n: number;
	epoch: number;
	/** 相对会话启动的毫秒。 */
	t: number;
	reason: string;
	bkptno?: string;
	frame?: Frame;
	/** 从 resume 到停止的耗时 —— "秒停"和"跑了 4 秒才停"是两个完全不同的诊断。 */
	sinceResumeMs?: number;
}

export interface GdbToolDetails {
	action: GdbAction;
	state: TargetState | "no-session";
	epoch: number;
	stopId: number;
	connection?: string;
	file?: string;
	/** 停在有源码的位置时给 Zed 用;文件在本机不存在时**不填**,否则每次停止都让编辑器去开一个不存在的文件。 */
	path?: string;
	firstChangedLine?: number;
}

interface Pending {
	token: number;
	resolve: (r: MiRecord) => void;
	reject: (e: Error) => void;
	stream: string[];
	timer: ReturnType<typeof setTimeout>;
}

const liveSessions = new Set<GdbSession>();

export interface GdbSessionOptions {
	gdbPath: string;
	cwd: string;
	/** 解码后的可读转录,给模型 grep、给人 tail -f。 */
	logFile: string;
	/** 原始 MI,只给调工具用。 */
	miFile: string;
	stopsFile: string;
}

/**
 * 一个 gdb 子进程 + 它的状态机。
 *
 * 命令严格串行:gdb 是个 REPL,而工具本身就是 executionMode:"sequential"。
 * 串行让"流记录归属哪条命令"这件事不需要猜。token 仍然发,用来发现失同步。
 */
export class GdbSession {
	private child?: ChildProcess;
	private pendingOut = "";
	private pending?: Pending;
	/** 串行闸:上一条命令没落地就不发下一条。 */
	private queue: Promise<unknown> = Promise.resolve();
	private stopWaiters: ((r: MiRecord) => void)[] = [];
	private logStream?: WriteStream;
	private miStream?: WriteStream;
	private stopsStream?: WriteStream;
	private nextToken = 1;
	private lastResumeAt?: number;

	readonly startedAt = Date.now();
	/** 复位/意外停止/重连都 +1。缓存的断点号和地址在跨 epoch 之后一律作废。 */
	epoch = 1;
	stopCount = 0;
	state: TargetState = "halted";
	lastStop?: StopInfo;
	exited?: { code: number | null; signal: NodeJS.Signals | null };
	/** 目标是不是 Cortex-M —— 决定要不要读 SCB。RISC-V / ESP32-C3 没有 PPB。 */
	core?: CoreId;
	/** FP_CTRL 真读出来的硬件断点数(M4 一般 6),读不到就是 undefined —— 不猜。 */
	breakpointUnits?: number;
	/** DWT_CTRL 的 NUMCOMP。 */
	watchpointUnits?: number;
	/**
	 * 工具自己记的断点表。gdb 也记,但两件事只有这边能做:
	 * 一是把 `<MULTIPLE>` 的每个 location 都算成一个硬件单元(一条 `break helper`
	 * 在 -O2 内联之后可能一口气吃掉三个),二是在**下断点的时候**就拒绝超预算,
	 * 而不是等 continue 时 gdb 报 "Cannot insert breakpoint" 并且不 resume ——
	 * 那时候错误挂在错误的命令上,模型会以为目标跑起来了。
	 */
	readonly breakpoints = new Map<number, { kind: "break" | "watch"; location: string; addr?: string; units: number }>();

	usedUnits(kind: "break" | "watch"): number {
		let n = 0;
		for (const b of this.breakpoints.values()) if (b.kind === kind) n += b.units;
		return n;
	}

	constructor(private readonly options: GdbSessionOptions) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get running(): boolean {
		return this.child !== undefined && this.exited === undefined;
	}

	get file(): string {
		return this.options.logFile;
	}

	// ── 生命周期 ──────────────────────────────────────────────────────────────

	async spawnGdb(): Promise<void> {
		this.logStream = createWriteStream(this.options.logFile, { flags: "a" });
		this.miStream = createWriteStream(this.options.miFile, { flags: "a" });
		this.stopsStream = createWriteStream(this.options.stopsFile, { flags: "a" });

		const child = spawn(this.options.gdbPath, ["--interpreter=mi3", "-nx", "-q"], {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.child = child;
		liveSessions.add(this);
		// 不让位:攥着探针的 gdbserver 太贵,宿主自己装了信号处理也照样要收掉它。
		killOnHostExit(liveSessions);

		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				this.exited = { code: null, signal: null };
				reject(new Error(`could not start ${this.options.gdbPath}: ${error.message}`));
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.consume(chunk));
		// gdb 自己的诊断走 stderr,不是 MI —— 只落盘,不解析。
		child.stderr?.on("data", (chunk: string) => this.writeLog(`[gdb stderr] ${chunk.trimEnd()}`));
		child.once("exit", (code, signal) => {
			this.exited = { code, signal };
			this.state = "exited";
			this.failPending(new Error(`gdb exited (${signal ? `signal ${signal}` : `code ${code}`})`));
		});

		// 采集中的子进程绝不能拖住事件循环,否则 ACP 退出时进程不肯死。
		child.unref();
		unref(child.stdout);
		unref(child.stderr);
		unref(child.stdin);
	}

	/**
	 * 启动握手。每一条都是有理由的,不是抄来的模板:
	 * mi-async 决定会话活不活;print elements/repeats 的默认值会在**你的预算生效之前**
	 * 就把值截断,而且截断标记在值内部;backtrace limit 挡的是栈损坏时打上千帧。
	 */
	async hygiene(): Promise<void> {
		const settings = [
			["confirm", "off"],
			["pagination", "off"],
			["height", "0"],
			["width", "0"],
			["print pretty", "on"],
			["print elements", "0"],
			["print repeats", "0"],
			["print null-stop", "off"],
			["print frame-arguments", "all"],
			["max-value-size", "65536"],
			["backtrace limit", "200"],
			// 裸机没有共享库:pending 断点永远不会解析,静默不命中比报错糟得多。
			["breakpoint pending", "off"],
			// 默认就是 off(停止时摘、resume 时装),显式写死,免得复位后断点被认为还在硬件里。
			["breakpoint always-inserted", "off"],
			["non-stop", "off"],
			["mi-async", "on"],
			["remotetimeout", "10"],
			["tcp auto-retry", "off"],
		];
		for (const [name, value] of settings) {
			await this.send(`-gdb-set ${name} ${value}`);
		}
		const check = await this.send("-gdb-show mi-async");
		if (miString(check.results?.value) !== "on") {
			throw new Error(
				"gdb refused `set mi-async on`. Without it the first continue makes gdb stop reading stdin and the session cannot be recovered — refusing to start.",
			);
		}
	}

	// ── MI 收发 ───────────────────────────────────────────────────────────────

	private consume(chunk: string): void {
		const framed = frameRecords(this.pendingOut, chunk);
		this.pendingOut = framed.pending;
		if (framed.overflow) {
			this.failPending(new Error("MI stream lost sync (record over 4 MB) — the session must be restarted"));
			return;
		}
		for (const line of framed.lines) this.dispatch(line);
	}

	private dispatch(line: string): void {
		this.miStream?.write(`${line}\n`);
		const record = parseRecord(line);
		switch (record.kind) {
			case "prompt":
				return;
			case "foreign":
				// `pipe`/`shell` 会造出这种。记下来,绝不抛 —— 这里是 stdout 的 data 回调。
				this.writeLog(`[foreign] ${clip(line, 400)}`);
				return;
			case "console":
			case "target":
				if (record.text) {
					this.pending?.stream.push(record.text);
					this.writeLog(record.text.replace(/\n$/, ""));
				}
				return;
			case "log":
				if (record.text) this.writeLog(`[gdb] ${record.text.replace(/\n$/, "")}`);
				return;
			case "notify":
				this.onNotify(record);
				return;
			case "status":
				return;
			case "exec":
				this.onExec(record);
				return;
			case "result":
				this.onResult(record);
				return;
		}
	}

	private onResult(record: MiRecord): void {
		const pending = this.pending;
		if (!pending) {
			this.writeLog(`[unmatched result] ${clip(record.raw, 400)}`);
			return;
		}
		// 一个 token 可能收到两条 `^`(^running 之后再来 ^error,"Command aborted.")。
		// resolve-once,多出来的记进文件后丢弃。
		if (record.token !== undefined && record.token !== pending.token) {
			this.writeLog(`[token mismatch] expected ${pending.token}, got ${record.token}: ${clip(record.raw, 200)}`);
			return;
		}
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(record);
	}

	private onExec(record: MiRecord): void {
		if (record.class === "running") {
			this.state = "running";
			this.lastResumeAt = Date.now();
			return;
		}
		if (record.class !== "stopped") return;

		const reason = miString(record.results?.reason) ?? "unknown";
		if (reason.startsWith("exited")) {
			this.state = "exited";
		} else {
			this.state = "halted";
		}
		const info = this.recordStop(reason, {
			bkptno: miString(record.results?.bkptno),
			frame: frameOf(miTuple(record.results?.frame)),
		});
		this.writeLog(`■ stopped#${info.n} ${reason}${info.frame ? ` @ ${renderFrame(info.frame)}` : ""}`);

		this.wakeStopWaiters(record);
	}

	/**
	 * 一次停止的记账:计数、StopInfo、清 lastResumeAt、落盘。onExec(有 `*stopped`)
	 * 与 onNotify(目标跑完退出,压根没有 `*stopped`)两条路共用。
	 *
	 * 落盘的理由:自动压缩会把"我们之前停在哪"从上下文里删掉,而原始 MI 是没法 grep 的。
	 * 每次停止 120 字节左右,一次长会话也就几 KB。JSON.stringify 会丢掉值为 undefined
	 * 的键,所以退出那条路落下来的仍然只有 {n,epoch,t,reason},字节数不变。
	 *
	 * ■ 行不在这里写:只有 onExec 那条路要写它。
	 */
	private recordStop(reason: string, extra?: { bkptno?: string; frame?: Frame }): StopInfo {
		this.stopCount += 1;
		const info: StopInfo = {
			n: this.stopCount,
			epoch: this.epoch,
			t: Date.now() - this.startedAt,
			reason,
			bkptno: extra?.bkptno,
			frame: extra?.frame,
			sinceResumeMs: this.lastResumeAt ? Date.now() - this.lastResumeAt : undefined,
		};
		this.lastStop = info;
		this.lastResumeAt = undefined;
		this.stopsStream?.write(
			`${JSON.stringify({
				n: info.n,
				epoch: info.epoch,
				t: info.t,
				reason: info.reason,
				bkptno: info.bkptno,
				func: info.frame?.func,
				file: info.frame?.file,
				line: info.frame?.line,
				addr: info.frame?.addr,
			})}\n`,
		);
		return info;
	}

	/**
	 * 通知记录。这里有一个实测抓到、直觉一定会漏的形状:**目标跑完退出时根本没有
	 * `*stopped`**,只有 `=thread-exited` + `=thread-group-exited`(而且 exit-code
	 * 有时候还缺席)。不在这里唤醒等停的一方,一次跑到结束的 continue 就会一直等到
	 * 超时,然后被报成"目标卡死了" —— 而它其实是正常退出了。
	 */
	private onNotify(record: MiRecord): void {
		this.writeLog(`[${record.class}]`);
		if (record.class === "thread-group-exited") {
			const code = miString(record.results?.["exit-code"]);
			this.state = "exited";
			this.recordStop(code === undefined ? "exited (no exit code reported)" : `exited with code ${code}`);
			this.wakeStopWaiters(record);
			return;
		}
		if (record.class === "target-disconnected") {
			this.state = "connection-lost";
			this.wakeStopWaiters(record);
		}
	}

	private wakeStopWaiters(record: MiRecord): void {
		const waiters = this.stopWaiters;
		this.stopWaiters = [];
		for (const w of waiters) w(record);
	}

	private failPending(error: Error): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		const waiters = this.stopWaiters;
		this.stopWaiters = [];
		// 等停止的一方不该收到异常:交给上层当"没等到"处理,它比异常更可控。
		for (const w of waiters) w({ kind: "exec", class: "stopped", results: { reason: "connection-lost" }, raw: "" });
	}

	private writeLog(text: string): void {
		this.logStream?.write(`${text}\n`);
	}

	/**
	 * 发一条 MI 命令。上一条没落地就**排队**,不报错(串行的理由见类 doc)。
	 * resolve 的是该 token 的 `^` 记录,output 是这条命令在飞期间收到的 ~/@ 流文本。
	 */
	send(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<MiRecord & { output: string }> {
		const next = this.queue.then(
			() => this.sendNow(command, timeoutMs),
			() => this.sendNow(command, timeoutMs),
		);
		// 队列本身不能因为某条命令失败就断掉。
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private sendNow(command: string, timeoutMs: number): Promise<MiRecord & { output: string }> {
		if (!this.child || this.exited) return Promise.reject(new Error("gdb is not running"));
		const token = this.nextToken++;
		this.writeLog(`> ${command}`);
		const stream: string[] = [];
		return new Promise<MiRecord & { output: string }>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending?.token !== token) return;
				this.pending = undefined;
				reject(new Error(`gdb did not answer \`${command}\` within ${timeoutMs} ms`));
			}, timeoutMs);
			timer.unref?.();
			this.pending = {
				token,
				stream,
				timer,
				resolve: (r) => resolve({ ...r, output: stream.join("") }),
				reject,
			};
			this.miStream?.write(`< ${token}${command}\n`);
			this.child?.stdin?.write(`${token}${command}\n`);
		});
	}

	/** 走 console 通道跑一条普通 gdb 命令,输出从 ~/@ 流里收。 */
	console(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<MiRecord & { output: string }> {
		return this.send(`-interpreter-exec console "${escapeCString(command)}"`, timeoutMs);
	}

	/**
	 * 装一个"下一次停止"的 waiter。**必须在发 resume 命令之前调用** ——
	 * 实测 `*stopped` 会先于该命令的结果记录到达。
	 */
	expectStop(): Promise<MiRecord | undefined> {
		return new Promise<MiRecord | undefined>((resolve) => {
			this.stopWaiters.push(resolve);
		});
	}

	// ── 关闭 ──────────────────────────────────────────────────────────────────

	killNow(): void {
		if (this.child) killTree(this.child, "SIGKILL");
	}

	async stop(): Promise<void> {
		if (!this.child) return;
		// 先让 gdb 自己走 —— 它会干净地 detach 目标。失败了再动刀。
		try {
			await this.send("-gdb-exit", 3_000);
		} catch {
			// gdb 可能已经死了或者不理会;下面照杀。
		}
		if (!this.exited) {
			killTree(this.child, "SIGTERM");
			const forced = setTimeout(() => this.killNow(), FORCE_KILL_GRACE_MS);
			forced.unref?.();
			await this.waitForExit(EXIT_WAIT_MS);
			clearTimeout(forced);
		}
		this.finish();
	}

	private waitForExit(ms: number): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			timer.unref?.();
			this.child?.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private finish(): void {
		liveSessions.delete(this);
		this.child?.stdout?.removeAllListeners("data");
		this.child?.stderr?.removeAllListeners("data");
		this.child?.stdout?.destroy();
		this.child?.stderr?.destroy();
		this.logStream?.end();
		this.miStream?.end();
		this.stopsStream?.end();
		this.logStream = undefined;
		this.miStream = undefined;
		this.stopsStream = undefined;
	}
}

// ─── 服务器进程 ──────────────────────────────────────────────────────────────

export interface ServerProcess {
	child: ChildProcess;
	port: number;
	argv: string[];
	/** 最近若干行合并输出 —— 连接失败时全部有用信息都在这里。 */
	tail: string[];
	exited?: { code: number | null; signal: NodeJS.Signals | null };
}

/** 让内核挑一个空闲端口。默认端口撞车是必然的(OpenOCD 3333 / J-Link 2331 / QEMU 1234)。 */
export function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
		});
	});
}

function tcpProbe(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: "127.0.0.1" });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(1_000, () => done(false));
	});
}

/**
 * 就绪 = race(就绪正则, TCP 可连, server 退出),server 退出立刻获胜。
 *
 * 两条判据都要 —— 每个 server 各自的假阳/假阴写在 SERVER_CAPS 表里(readyRe 字段的
 * 注释、以及 openocd 与 qemu 两条)。这里只补一句表里放不下的:轮询的只有 **gdb 端口**,
 * 因为 OpenOCD 的 4444/6666 在适配器初始化之前就绑上了,拿它们判断会在目标根本没连上
 * 时误判成功。
 */
export async function waitForServerReady(server: ServerProcess, readyRe: RegExp | undefined, deadlineMs: number) {
	const started = Date.now();
	let sawPattern = false;
	while (Date.now() - started < deadlineMs) {
		if (server.exited) {
			const { code, signal } = server.exited;
			throw new Error(
				appendProbeOccupationHint(
					`the gdb server exited before it was ready (${signal ? `signal ${signal}` : `code ${code}`}).\n` +
						`Command: ${server.argv.join(" ")}\n` +
						`Its last output:\n${server.tail.join("\n") || "(nothing)"}`,
					server.tail.join("\n"),
				),
			);
		}
		if (readyRe && !sawPattern && server.tail.some((l) => readyRe.test(l))) sawPattern = true;
		if (await tcpProbe(server.port)) return { sawPattern };
		await new Promise((r) => {
			const t = setTimeout(r, TCP_POLL_MS);
			t.unref?.();
		});
	}
	throw new Error(
		appendProbeOccupationHint(
			`the gdb server did not open port ${server.port} within ${deadlineMs} ms.\n` +
				`Command: ${server.argv.join(" ")}\n` +
				`Its output so far:\n${server.tail.join("\n") || "(nothing)"}`,
			server.tail.join("\n"),
		),
	);
}

export function spawnServer(argv: string[], port: number, cwd: string): ServerProcess {
	const child = spawn(argv[0]!, argv.slice(1), {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const server: ServerProcess = { child, port, argv, tail: [] };
	const push = (chunk: string) => {
		for (const line of chunk.split("\n")) {
			const t = line.trimEnd();
			if (!t) continue;
			server.tail.push(t);
			if (server.tail.length > SERVER_TAIL_LINES) server.tail.shift();
		}
	};
	// OpenOCD / pyOCD 打 stderr,J-Link 打 stdout —— 两个都得收,
	// 只读 stdout 会在 OpenOCD 上永远等不到就绪串。
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", push);
	child.stderr?.on("data", push);
	child.once("exit", (code, signal) => {
		server.exited = { code, signal };
	});
	child.once("error", () => {
		server.exited = { code: null, signal: null };
	});
	child.unref();
	unref(child.stdout);
	unref(child.stderr);
	return server;
}

// ─── 目标内省 ────────────────────────────────────────────────────────────────

/** contents 是按内存顺序的十六进制字节串;Cortex-M 是小端。 */
export function hexToWords(contents: string): number[] {
	const words: number[] = [];
	for (let i = 0; i + 8 <= contents.length; i += 8) {
		const b = [0, 1, 2, 3].map((k) => Number.parseInt(contents.slice(i + k * 2, i + k * 2 + 2), 16));
		words.push(((b[3]! << 24) | (b[2]! << 16) | (b[1]! << 8) | b[0]!) >>> 0);
	}
	return words;
}

async function readWords(session: GdbSession, addr: number, count: number): Promise<number[] | undefined> {
	const r = await session.send(`-data-read-memory-bytes ${hex(addr)} ${count * 4}`).catch(() => undefined);
	if (!r || r.class !== "done") return undefined;
	const cell = unwrapList(r.results?.memory)[0];
	const contents = miString(cell?.contents);
	return contents ? hexToWords(contents) : undefined;
}

async function evalNumber(session: GdbSession, expr: string): Promise<number | undefined> {
	const r = await session.send(`-data-evaluate-expression "${escapeCString(expr)}"`).catch(() => undefined);
	if (!r || r.class !== "done") return undefined;
	return miNumber(r.results?.value);
}

/**
 * 一次性认核。读不到 CPUID(RISC-V、ESP32-C3 这类没有 PPB 的目标)就把整套
 * Cortex-M 逻辑关掉,而不是对着零解码出一堆假故障。
 */
async function probeCore(session: GdbSession): Promise<void> {
	const words = await readWords(session, SCB.CPUID, 1);
	const cpuid = words?.[0];
	if (cpuid === undefined || (cpuid >>> 24) !== 0x41) return; // 0x41 = ARM implementer
	session.core = decodeCpuid(cpuid);

	const fp = await readWords(session, SCB.FP_CTRL, 1);
	if (fp?.[0] !== undefined) {
		const units = decodeBreakpointUnits(fp[0]);
		if (units.total > 0) session.breakpointUnits = units.total;
	}
	const dwt = await readWords(session, SCB.DWT_CTRL, 1);
	if (dwt?.[0] !== undefined) {
		const total = decodeWatchpointUnits(dwt[0]);
		if (total > 0) session.watchpointUnits = total;
	}
}

export interface FaultReport {
	lines: string[];
	/** 非精确故障时不给源码位置 —— 给了就是冤枉无辜代码。 */
	trustworthyLocation: boolean;
}

/**
 * 故障现场。停在 handler 里的时候,backtrace 是垃圾:真正的现场在异常入栈帧里。
 * 这一段替模型做四件它**已知会做错**的事:选 MSP 还是 PSP、读栈上的 PC 而不是
 * handler 自己的 $pc、BFARVALID=0 时不信 BFAR、IMPRECISERR 时不报位置。
 */
async function analyseFault(session: GdbSession): Promise<FaultReport | undefined> {
	if (!session.core?.hasConfigurableFaults) return undefined;
	const scb = await readWords(session, SCB.CPUID, 16);
	if (!scb || scb.length < 16) return undefined;

	const icsr = scb[1]!;
	const cfsr = scb[10]!;
	const hfsr = scb[11]!;
	const dfsr = scb[12]!;
	const mmfar = scb[13]!;
	const bfar = scb[14]!;
	const exception = decodeException(icsr);
	const faulting = exception.vectactive >= 3 && exception.vectactive <= 6;
	if (!faulting && cfsr === 0 && (hfsr & 0x40000002) === 0) return undefined;

	const lines: string[] = [];
	const fault = decodeFault(cfsr, hfsr, mmfar, bfar);
	lines.push(`  故障:${fault.summary}`);
	const dfsrFlags = decodeDfsr(dfsr);
	if (dfsrFlags.length) lines.push(`  DFSR:${dfsrFlags.map((f) => f.name).join(" ")}`);

	// EXC_RETURN 在异常里的 LR 上 —— 但 handler 一旦调用过别的函数,LR 就被覆盖了。
	// 这时候栈帧位置无法从这里确定,老实说出来,别猜。
	const lr = await evalNumber(session, "(unsigned long)$lr");
	const exc = lr === undefined ? undefined : decodeExcReturn(lr);
	if (!exc?.valid) {
		lines.push(
			`  ⚠ $lr = ${hex(lr)} 不是合法的 EXC_RETURN,说明 handler 已经调用过别的函数;` +
				`异常入栈帧的位置无法从这里确定 —— 在 handler 入口下断点重来一次。`,
		);
		return { lines, trustworthyLocation: false };
	}

	const spExpr = exc.stackPointer === "PSP" ? "(unsigned long)$psp" : "(unsigned long)$msp";
	const sp = (await evalNumber(session, spExpr)) ?? (await evalNumber(session, "(unsigned long)$sp"));
	const words = sp === undefined ? undefined : await readWords(session, sp, 8);
	const stacked = words && decodeStackedFrame(words);
	if (!stacked) {
		lines.push(`  ⚠ 读不到 ${exc.stackPointer}(${hex(sp)})上的异常帧 —— 栈指针本身可能已经跑飞(典型的栈溢出)`);
		return { lines, trustworthyLocation: false };
	}

	lines.push(
		`  异常帧在 ${exc.stackPointer}(EXC_RETURN=${hex(lr)},${exc.extendedFrame ? "带浮点的扩展帧" : "基本帧"})`,
	);
	if (fault.imprecise) {
		lines.push(`  ⚠ 非精确总线错误:入栈的 PC ${hex(stacked.pc)} 只是"出事附近",不是出事那条指令`);
	} else {
		const symbol = await session.console(`info symbol ${hex(stacked.pc)}`).catch(() => undefined);
		const where = symbol?.output.trim().split("\n")[0];
		lines.push(`  出事 PC ${hex(stacked.pc)}${where && !where.startsWith("No symbol") ? ` = ${where}` : ""}`);
	}
	lines.push(
		`  入栈寄存器:r0=${hex(stacked.r0)} r1=${hex(stacked.r1)} r2=${hex(stacked.r2)} r3=${hex(stacked.r3)} ` +
			`r12=${hex(stacked.r12)} lr=${hex(stacked.lr)}`,
	);
	return { lines, trustworthyLocation: !fault.imprecise };
}

// ─── 停止报告 ────────────────────────────────────────────────────────────────

/**
 * DWARF 存的是编译那台机器上的绝对路径。原样打进上下文既长又没信息量,
 * 而且长路径在栈里重复七遍就是几百个白烧的 token。
 */
export function relFrame(frame: Frame, root?: string): Frame {
	if (!root || !frame.file) return frame;
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return frame.file.startsWith(prefix) ? { ...frame, file: frame.file.slice(prefix.length) } : frame;
}

export function shortenPath(file: string | undefined, root?: string): string | undefined {
	if (!file || !root) return file;
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function renderBanner(session: GdbSession | undefined, connection?: string, root?: string): string {
	if (!session) return "[gdb no session]";
	const bp = session.breakpointUnits ? ` bp=${session.usedUnits("break")}/${session.breakpointUnits}` : "";
	const wp = session.watchpointUnits ? ` wp=${session.usedUnits("watch")}/${session.watchpointUnits}` : "";
	const frame = session.lastStop?.frame;
	const at = frame
		? ` @ ${frame.file && frame.line ? `${shortenPath(frame.file, root)}:${frame.line}` : (frame.func ?? "?")}`
		: "";
	const conn = connection ? ` ${connection}` : "";
	return `[gdb #${session.epoch} ${session.state}${at}${bp}${wp}${conn}]`;
}

/**
 * 停止之后的规范快照。一次调用回答 90% 的问题,而不是让模型再发五条命令去拼。
 * 停在异常里的时候自动接上故障解码 —— "板子为什么死了"是打开调试器的首要原因,
 * 不该让模型自己去记 CFSR 的地址。
 */
export async function renderStopReport(
	session: GdbSession,
	options: { show?: string[]; buildNote?: string; relativeTo?: string } = {},
): Promise<string> {
	const stop = session.lastStop;
	const lines: string[] = [];
	if (!stop) return "target is halted (no stop event recorded yet)";

	const elapsed = stop.sinceResumeMs !== undefined ? ` (+${(stop.sinceResumeMs / 1000).toFixed(3)}s)` : "";
	const which = stop.bkptno ? ` breakpoint ${stop.bkptno}` : "";
	// 连接时的第一次停止没有 reason 字段;"unknown" 会让模型以为出了什么事。
	const reason = stop.reason === "unknown" ? "halted (initial attach)" : stop.reason;
	lines.push(`■ stopped#${stop.n}: ${reason}${which}${elapsed}`);

	const fault = await analyseFault(session).catch(() => undefined);
	if (fault) lines.push(...fault.lines);

	const frames = await session.send("-stack-list-frames 0 7").catch(() => undefined);
	const list = frames && frames.class === "done" ? unwrapList(frames.results?.stack, "frame").map(frameOf) : [];
	const usable = list.filter((f): f is Frame => f !== undefined).map((f) => relFrame(f, options.relativeTo));
	if (usable.length) lines.push(...renderFrames(usable));
	else if (stop.frame) lines.push(`  ${renderFrame(relFrame(stop.frame, options.relativeTo), 0)}`);

	const locals = await session.send("-stack-list-variables --simple-values").catch(() => undefined);
	if (locals?.class === "done") {
		const vars = unwrapList(locals.results?.variables);
		let optimisedOut = 0;
		const rendered = vars.map((v) => {
			const name = miString(v.name) ?? "?";
			const value = miString(v.value);
			if (value !== undefined) {
				if (value === "<optimized out>") optimisedOut++;
				return `${name}=${value}`;
			}
			// --simple-values 对聚合类型**只给 type,不给 value**。把它当 <optimized out>
			// 会让模型断定"这个变量被优化掉了",而它其实只是个结构体 —— 两个结论
			// 引出的下一步完全不同(一个是改编译选项,一个是 p 它一下就能看)。
			const type = miString(v.type);
			return type ? `${name}: ${type}(用 eval "p ${name}" 展开)` : name;
		});
		if (rendered.length) {
			lines.push(`  locals: ${clip(rendered.join(", "), 400)}`);
			if (optimisedOut > 0) {
				lines.push(`  (${optimisedOut} 个局部变量是 <optimized out> —— 不要把它当作"没赋值"或"没执行到")`);
			}
		}
	}

	for (const expr of options.show ?? []) {
		const r = await session.send(`-data-evaluate-expression "${escapeCString(expr)}"`).catch(() => undefined);
		const value = r?.class === "done" ? miString(r.results?.value) : `<${miString(r?.results?.msg) ?? "error"}>`;
		lines.push(`  ${expr} = ${clip(value ?? "?", 200)}`);
	}

	if (options.buildNote) lines.push(`  ${options.buildNote}`);
	// 停下来之后固件当然不再打日志。不说这一句,模型会去问 log 然后断定固件死了。
	if (session.state === "halted") lines.push("  (目标已暂停 —— 在 exec continue 之前它不会再产生任何日志输出)");
	return lines.join("\n");
}

// ─── gdb 二进制定位 ──────────────────────────────────────────────────────────

function findOnPath(name: string): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const binary = exe(name);
	for (const dir of dirs) {
		const candidate = path.join(dir, binary);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export interface ResolveGdbResult {
	gdbPath: string;
	tried: string[];
}

/**
 * 按 ELF 的架构挑 gdb。**不走 engineBin** —— 见 preferredGdbNames 的注释。
 * 找不到时的报错要点名试过哪几个,并给出安装指引,而不是一个裸的 spawn 错误。
 */
export function resolveGdbPath(machine: number | undefined, override?: string): ResolveGdbResult {
	if (override) return { gdbPath: override, tried: [override] };
	const fromEnv = process.env.YOMA_GDB;
	if (fromEnv) return { gdbPath: fromEnv, tried: [fromEnv] };
	const tried = preferredGdbNames(machine);
	for (const name of tried) {
		const found = findOnPath(name);
		if (found) return { gdbPath: found, tried };
	}
	throw new Error(
		`no usable gdb found (tried ${tried.join(", ")} on PATH). Install the Arm GNU Toolchain ` +
			"(brew install --cask gcc-arm-embedded) or pass gdbPath. Do NOT run `bun engines/build.ts` — gdb is a toolchain binary, not an engine.",
	);
}

/** "host:port" / ":port" / "port" 都收。 */
export function parseConnect(value: string): { host: string; port: number } {
	const m = /^(?:([A-Za-z0-9_.-]+))?:?(\d+)$/.exec(value.trim());
	if (!m) throw new Error(`gdb start: could not parse connect "${value}" — use "host:port", e.g. "localhost:3333"`);
	return { host: m[1] || "localhost", port: Number(m[2]) };
}

// ─── 工具定义 ────────────────────────────────────────────────────────────────

const gdbSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
	action: Type.Union(
		[
			Type.Literal("start"),
			Type.Literal("break"),
			Type.Literal("exec"),
			Type.Literal("eval"),
			Type.Literal("status"),
			Type.Literal("stop"),
		],
		{ description: "start | break | exec | eval | status | stop" },
	),
	server: Type.Optional(
		Type.Union(
			[Type.Literal("qemu"), Type.Literal("openocd"), Type.Literal("jlink"), Type.Literal("external")],
			{ description: "start: which gdb server to launch. Use external together with connect to attach to one already running." },
		),
	),
	connect: Type.Optional(
		Type.String({ description: 'start: "host:port" of an already-running gdb server (implies server: "external").' }),
	),
	elfPath: Type.Optional(Type.String({ description: "start: the ELF with debug info that matches what is on the target." })),
	chip: Type.Optional(Type.String({ description: 'start (jlink): -device name, e.g. "STM32G431CB".' })),
	config: Type.Optional(
		Type.Array(Type.String(), {
			description: 'start (openocd): -f config files, e.g. ["interface/stlink.cfg","target/stm32g4x.cfg"].',
		}),
	),
	machine: Type.Optional(Type.String({ description: 'start (qemu): -machine, e.g. "netduinoplus2" (STM32F405, Cortex-M4F).' })),
	// 多探针选择刻意不做:openocd 用 config 里的 `adapter serial`,jlink 要接 `-select USB=<sn>`,
	// 语义按 server 各表 —— 需要时在各自的配置里表达,不给一个跨 server 的假统一参数。
	gdbPath: Type.Optional(Type.String({ description: "start: gdb binary to use; defaults to arm-none-eabi-gdb on PATH." })),
	allowUnverified: Type.Optional(
		Type.Boolean({ description: "start: proceed even when the ELF does not match the last flashed image." }),
	),
	at: Type.Optional(Type.String({ description: 'break: code location — "file.c:42", "func", or "*0x08001a3e".' })),
	watch: Type.Optional(Type.String({ description: "break: watch this expression instead (data watchpoint)." })),
	mode: Type.Optional(
		Type.Union([Type.Literal("r"), Type.Literal("w"), Type.Literal("rw")], {
			description: "break + watch: read / write / both. Default w.",
		}),
	),
	condition: Type.Optional(Type.String({ description: "break: only stop when this expression is true." })),
	temporary: Type.Optional(Type.Boolean({ description: "break: delete the breakpoint after it is hit once." })),
	remove: Type.Optional(Type.String({ description: 'break: delete breakpoint N, or "all".' })),
	// 同上:显式元组,别改成 .map()。
	op: Type.Optional(
		Type.Union(
			[
				Type.Literal("continue"),
				Type.Literal("step"),
				Type.Literal("next"),
				Type.Literal("finish"),
				Type.Literal("stepi"),
				Type.Literal("interrupt"),
				Type.Literal("wait"),
				Type.Literal("reset-halt"),
				Type.Literal("reset-run"),
			],
			{
				description:
					"exec: continue | step | next | finish | stepi | interrupt | wait | reset-halt | reset-run. wait resumes nothing and keeps waiting for the next stop.",
			},
		),
	),
	waitMs: Type.Optional(Type.Number({ description: `exec: how long to wait for a stop (default ${DEFAULT_WAIT_MS}).` })),
	onTimeout: Type.Optional(
		Type.Union([Type.Literal("interrupt"), Type.Literal("leave-running")], {
			description: "exec: what to do if nothing stops in time. Default interrupt — a halted target is recoverable, a silently running one is not.",
		}),
	),
	expectRunning: Type.Optional(
		Type.Boolean({ description: "exec continue: acknowledge that no breakpoint is armed and you just want the target running." }),
	),
	show: Type.Optional(
		Type.Array(Type.String(), { description: "exec: expressions to evaluate at the stop and append to the report." }),
	),
	count: Type.Optional(Type.Number({ description: `exec step/next/stepi: repeat this many times (max ${MAX_STEP_COUNT}).` })),
	command: Type.Optional(Type.String({ description: "eval: a gdb command or expression, e.g. \"p/x *cfg\", \"info registers\", \"x/16xw 0x20000000\"." })),
	write: Type.Optional(Type.Boolean({ description: "eval: required for commands that change the target (set variable, monitor, call, jump)." })),
	keepServer: Type.Optional(
		Type.Boolean({ description: "stop: leave the gdb server running so a human can attach; the tool prints the command line." }),
	),
});

export type GdbToolInput = Static<typeof gdbSchema>;

export type GdbToolOptions = { gdbPath?: string };

const DESCRIPTION = `Drives a live GDB session against embedded firmware — breakpoints, run control, expression evaluation, and automatic fault analysis. Works with OpenOCD, J-Link, QEMU, or any gdb server already listening on a port.

Actions:
- start (elfPath + either server+its options, or connect): attach. Launches the server when asked, waits until its gdb port is really listening, loads symbols, and reports the core, the hardware breakpoint budget, and whether the ELF matches the last image flashed by the flash tool. Calling start on a live session is safe — it just reports the session's state.
- exec (op, [waitMs], [onTimeout], [show], [count]): run control. THIS IS THE MAIN ACTION. It resumes AND waits for the stop, then returns one compact report: stop reason, top frames, source line, frame-0 locals, plus any show expressions. When the target stops inside a fault handler it also decodes CFSR/HFSR, picks MSP vs PSP from EXC_RETURN, and reports the PC that actually faulted rather than the handler's own.
- break ([at] | [watch], [condition], [temporary], [remove]): breakpoints and watchpoints. Returns the resolved address so an unresolved breakpoint is visible immediately, and refuses to exceed the target's hardware budget at insert time.
- eval (command, [write]): any other gdb command or expression. Read-only by default; commands that change the target need write: true.
- status: where the target is, the last few stops, the breakpoint table and budgets, and the session log path.
- stop ([keepServer]): end the session.

Rules:
- Prefer one exec over several eval calls: exec already returns the stop reason, frames, source line and locals.
- A halted target produces no log output. Silence in the log tool after a stop is expected, not evidence of a crash.
- Hardware breakpoints are a small fixed budget (6 on a typical Cortex-M4, 4 on M0+); break reports how many remain. Delete before adding.
- A debug probe can only be held by one process: the gdb server owns it while attached. RTT is read from the server's own TCP port (the start report says where), so logs and gdb coexist — but stop the session before running a flash command, or the probe lease will refuse it and point back here.
- Never state that a line executed, a variable held a value, or a fault occurred at a given place unless a stop report here shows it. When the report says the build is optimized, do not present locals as fact.`;

/** 需要独占探针的 server。qemu 是纯软件,external 由对方负责。 */
const PROBE_SERVERS = new Set<GdbServerKind>(["openocd", "jlink"]);

/**
 * 中断也没落地时,读 DHCSR 说清楚到底是哪一种 —— 目标在正常跑、进了 WFI 睡着、
 * 还是锁死了,对应三条完全不同的下一步。糊成"没停下来"等于把诊断丢给模型去猜。
 */
async function describeStuck(session: GdbSession, waitMs: number): Promise<string> {
	const head =
		`nothing stopped within ${waitMs} ms and -exec-interrupt did not land within ${INTERRUPT_GRACE_MS} ms either. `;
	const words = session.core ? await readWords(session, SCB.DHCSR, 1).catch(() => undefined) : undefined;
	const dhcsr = words?.[0];
	if (dhcsr === undefined) {
		return `${head}DHCSR is unreadable, so the debug connection itself is probably gone (probe unplugged, target unpowered, or SWD lost sync). Run gdb stop and reattach.`;
	}
	const flags = decodeDhcsr(dhcsr).map((f) => f.name);
	if (flags.includes("S_LOCKUP")) {
		return `${head}DHCSR.S_LOCKUP is set: the core is locked up (a fault inside the fault handler). $pc reads 0xEFFFFFFE and is meaningless. Only a reset recovers — gdb exec op:"reset-halt".`;
	}
	if (flags.includes("S_SLEEP")) {
		return `${head}DHCSR.S_SLEEP is set: the core is in WFI/WFE and the debug clock is gated, so it cannot be halted. Set DBGMCU_CR.DBG_SLEEP before entering low power, or reset with gdb exec op:"reset-halt".`;
	}
	if (flags.includes("S_HALT")) {
		return `${head}but DHCSR.S_HALT is actually set — the core IS halted and gdb missed the notification. Run gdb status to resynchronise.`;
	}
	return `${head}DHCSR says the core is still executing normally (S_HALT=0, S_SLEEP=0). The firmware is running, not wedged — either it never reaches your breakpoint, or the breakpoint did not get inserted.`;
}

/**
 * promise 是否在 ms 之内落定。五处"等停止,但最多等这么久"共用这一份 —— 从前每处都是
 * delay() + Promise.race + cancel 三行。
 *
 * 拒绝要**原样传出去**,不能吞成 false:这里的 promise 目前都来自 expectStop()(只
 * resolve,失败路径喂的是合成 stopped 记录),但把 reject 吞掉会让将来某个会抛的调用
 * 方变成"静默 false + unhandled rejection",而那种 bug 在硬件路径上极难归因。
 * 定时器 unref:等待绝不能拖住事件循环(gdb / server 子进程都是 detached + unref 的)。
 */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(false), ms);
		timer.unref?.();
		promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * 源码路径映射。DWARF 里存的是**编译那台机器上的绝对路径**;项目挪过窝、在 CI 里
 * 编的、或者容器里编的,这个路径在本机根本不存在,于是每次停止的"源码行"都是空的,
 * 而模型会由此断定 ELF 没有调试信息,然后跑去查构建系统。
 */
async function fixSourcePaths(session: GdbSession, env: ExecutionEnv): Promise<string | undefined> {
	const r = await session.send("-file-list-exec-source-files").catch(() => undefined);
	if (!r || r.class !== "done") return undefined;
	const files = unwrapList(r.results?.files)
		.map((f) => miString(f.fullname))
		.filter((f): f is string => !!f && path.isAbsolute(f))
		.slice(0, 40);
	if (files.length === 0) return undefined;

	// 存在性检查一批并发:每个文件本来都要 await 一次,而它们互不相关。
	const checked = await Promise.all(files.map(async (full) => ({ full, hit: await env.exists(full) })));
	const missingFiles = checked.filter(({ hit }) => !(hit.ok && hit.value)).map(({ full }) => full);
	const missing = missingFiles.length;
	if (!missing) return undefined;

	// 后缀回退保持串行短路:第一个能映射上的就定案,不必把剩下的都问一遍。
	let mapped: { from: string; to: string } | undefined;
	for (const full of missingFiles) {
		if (mapped) break;
		// 从最短的后缀开始往回试:找到工作区里同名同层级的那个文件,前缀差就是映射。
		const parts = full.split(path.sep).filter(Boolean);
		for (let i = parts.length - 1; i >= 1; i--) {
			const candidate = path.join(env.cwd, ...parts.slice(i));
			const hit = await env.exists(candidate);
			if (hit.ok && hit.value) {
				mapped = { from: `${path.sep}${parts.slice(0, i).join(path.sep)}`, to: env.cwd };
				break;
			}
		}
	}
	if (mapped) {
		await session.console(`set substitute-path ${mapped.from} ${mapped.to}`).catch(() => undefined);
		return `source paths: ${missing} of ${files.length} compile-time paths do not exist here; mapped ${mapped.from} → ${mapped.to}`;
	}
	return `⚠ source paths: ${missing} of ${files.length} compile-time paths do not exist on this machine and could not be mapped — line numbers cannot be verified against local sources`;
}

/** ELF 与片子里的镜像对不上,是整套工具里最贵、而且**没有任何错误文本**的失败。 */
async function verifyImage(env: ExecutionEnv, elf: string): Promise<{ ok: boolean; note: string }> {
	const state = await readFlashState(env);
	if (!state) {
		return { ok: true, note: "image: UNVERIFIED — no flash record from this workspace; if you did not just flash this ELF, line numbers and values may describe code that is not running" };
	}
	const sha = await sha256File(elf).catch(() => undefined);
	if (sha && sha === state.sha256) {
		const age = Math.round((Date.now() - state.at) / 60_000);
		return { ok: true, note: `image: verified against the last flash (${age} min ago)` };
	}
	return {
		ok: false,
		note:
			`image: MISMATCH — .yoma/flash-state.json records ${state.elfPath} flashed ${Math.round((Date.now() - state.at) / 60_000)} min ago, ` +
			"which is not this ELF. Every line number, local and backtrace below would describe code that is not running. " +
			"Re-flash this ELF (flash tool, with elfPath), or pass allowUnverified: true if you know the difference does not matter.",
	};
}

export function createGdbToolDefinition(
	env: ExecutionEnv,
	options?: GdbToolOptions,
): ToolDefinition<typeof gdbSchema, GdbToolDetails> {
	// 一个工具实例 = 一个调试会话。闭包持有,和 log.ts 同构。
	let session: GdbSession | undefined;
	let server: ServerProcess | undefined;
	let serverKind: GdbServerKind = "external";
	let connection: string | undefined;
	let heldProbe = false;
	let elfPath: string | undefined;

	const caps = (): ServerCaps => SERVER_CAPS[serverKind];

	const detailsOf = (action: GdbAction, extra?: Partial<GdbToolDetails>): GdbToolDetails => ({
		action,
		state: session?.running ? session.state : "no-session",
		epoch: session?.epoch ?? 0,
		stopId: session?.stopCount ?? 0,
		connection,
		file: session?.file,
		...extra,
	});

	/** 停在有源码的位置时给 Zed 用。文件在本机不存在就**不填** —— 见 fixSourcePaths。 */
	const locationOf = async (): Promise<Partial<GdbToolDetails>> => {
		const frame = session?.lastStop?.frame;
		if (!frame?.fullname || !frame.line) return {};
		const exists = await env.exists(frame.fullname);
		if (!exists.ok || !exists.value) return {};
		return { path: frame.fullname, firstChangedLine: Number(frame.line) };
	};

	const banner = () => renderBanner(session, connection, env.cwd);

	const requireSession = (action: GdbAction): GdbSession => {
		if (session?.running) return session;
		throw new Error(
			`no gdb session — run \`gdb\` action:"start" first (${action} needs one). ` +
				'Example with a board: server:"openocd", config:["interface/stlink.cfg","target/stm32g4x.cfg"], elfPath:"build/firmware.elf". ' +
				'Example with no hardware: server:"qemu", machine:"netduinoplus2", elfPath:"build/firmware.elf". ' +
				'Example against a server you already started: connect:"localhost:3333", elfPath:"build/firmware.elf".',
		);
	};

	const teardown = async (keepServer: boolean) => {
		await session?.stop();
		session = undefined;
		if (server && !keepServer) {
			// 顺序不能反:gdb 先走,否则它会卡在 remote 等待里。
			killTree(server.child, "SIGTERM");
			const forced = setTimeout(() => server && killTree(server.child, "SIGKILL"), FORCE_KILL_GRACE_MS);
			forced.unref?.();
		}
		if (!keepServer) {
			server = undefined;
			connection = undefined;
		}
		if (heldProbe) {
			heldProbe = false;
			releaseProbe("gdb");
		}
	};

	/**
	 * resume 一步并等停止。waiter **必须先装** —— 实测 `*stopped` 会先于该命令的
	 * 结果记录到达,后装就会漏掉已经发生的停止,然后一路等到超时。
	 */
	const resumeAndWait = async (
		s: GdbSession,
		command: string | undefined,
		waitMs: number,
		onTimeout: "interrupt" | "leave-running",
	): Promise<{ stopped: boolean; note?: string; error?: string }> => {
		const waiter = s.expectStop();
		if (command) {
			const r = await s.send(command);
			if (r.class === "error") {
				const msg = miString(r.results?.msg) ?? "unknown error";
				// 断点插不进去时 continue 会 abort 且**不 resume**。不说清楚,
				// 上层会等到超时,而模型会把它读成"固件卡死了"。
				if (/Cannot insert|Could not insert|Command aborted/i.test(msg)) {
					return {
						stopped: false,
						error: `${msg}\nThe target did NOT resume. This is the hardware breakpoint budget, not a hang — delete a breakpoint (gdb break remove) and try again.`,
					};
				}
				return { stopped: false, error: msg };
			}
		}
		if (await settledWithin(waiter, waitMs)) return { stopped: true };

		if (onTimeout === "leave-running") {
			return {
				stopped: false,
				note: `no stop within ${waitMs} ms and the target was left RUNNING. Use exec op:"wait" to keep waiting, or exec op:"interrupt" to halt it now.`,
			};
		}
		// 中断阶梯:-exec-interrupt 的 ^done 只表示"中断已发出",不表示停了。
		const second = s.expectStop();
		await s.send("-exec-interrupt").catch(() => undefined);
		if (await settledWithin(second, INTERRUPT_GRACE_MS)) {
			return {
				stopped: true,
				note: `nothing stopped within ${waitMs} ms, so I interrupted the target. Your firmware was running normally — this halt was mine, not a crash.`,
			};
		}
		// "还在跑""睡着了""彻底卡死"是三个完全不同的诊断,不能糊成一句"没停下来"。
		return { stopped: false, note: await describeStuck(s, waitMs) };
	};

	return {
		name: "gdb",
		label: "gdb",
		description: DESCRIPTION,
		promptSnippet: "Drive a live gdb session against the board (breakpoints, run control, expressions, fault analysis)",
		promptGuidelines: [
			"Prefer one `gdb exec` over several `gdb eval`: exec returns the stop reason, frames, source line and locals in a single call.",
			"Never claim a line executed, a variable held a value, or a fault happened at a place unless a gdb stop report shows it; when the report says the build is optimized, do not report locals as fact.",
			"Hardware breakpoints are a small fixed budget and a halted target produces no log output — check `gdb status` before concluding the firmware hung or went silent.",
		],
		parameters: gdbSchema,
		// gdb 是单个 REPL,探针是独占设备:这个工具的调用之间不并发。
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			switch (params.action) {
				case "start": {
					if (session?.running) {
						// 自动压缩会把会话从上下文里抹掉,但会话还活着。这里**不能抛**:
						// 抛出去模型会 stop 再 start,拆掉一个本该留着的会话。
						const text = `${banner()}\na gdb session is already attached — reusing it.\n${await renderStopReport(session, { relativeTo: env.cwd })}`;
						return { content: [{ type: "text", text }], details: detailsOf("start", await locationOf()) };
					}

					if (!params.elfPath) {
						throw new Error(
							"gdb start needs elfPath — the ELF with debug info that matches what is on the target. " +
								"Without symbols every frame is `??` and no breakpoint can be set by name.",
						);
					}
					const elf = await resolveToCwd(env, params.elfPath);
					const exists = await env.exists(elf);
					if (!exists.ok || !exists.value) throw new Error(`ELF file not found: ${elf}`);

					if (params.connect && params.server && params.server !== "external") {
						throw new Error(
							`gdb start got both server:"${params.server}" and connect:"${params.connect}". ` +
								"Pass server to launch one, or connect alone to attach to a server that is already listening.",
						);
					}
					const kind: GdbServerKind = params.server ?? "external";
					if (kind === "external" && !params.connect) {
						throw new Error(
							'gdb start needs either connect:"host:port" (attach to a running server) or server:"openocd|jlink|qemu" plus its options.',
						);
					}

					// 只要 e_ident + e_machine 这 20 字节。整读会为一个带调试信息的 ELF 拉起
					// 几十 MB 的临时 buffer(同一次 start 里 verifyImage 还要再整读一遍算 sha256)。
					// 这里刻意不走 ExecutionEnv:gdb 是本机 spawn 的,ELF 必然在本机,而 elf
					// 在上面已经过 resolveToCwd 变成绝对路径了(这一步不能挪到它前面)。
					const head = new Uint8Array(0x14);
					try {
						const fh = await openFile(elf, "r");
						try {
							await fh.read(head, 0, 0x14, 0);
						} finally {
							await fh.close();
						}
					} catch {
						// 读不到就按未知架构回落到 gdb-multiarch / gdb,与整读失败时同解。
					}
					const machine = elfMachine(head);
					const { gdbPath } = resolveGdbPath(machine, params.gdbPath ?? options?.gdbPath);

					let host = "localhost";
					let port: number;
					if (params.connect) ({ host, port } = parseConnect(params.connect));
					else port = await pickFreePort();

					if (PROBE_SERVERS.has(kind)) {
						const holder = claimProbe("gdb", `${kind} on ${params.chip ?? "target"}`, () => session?.running === true);
						if (holder) throw new Error(`gdb start: ${describeProbeConflict(holder)}`);
						heldProbe = true;
					}

					serverKind = kind;
					const notes: string[] = [];
					try {
						if (kind !== "external") {
							const argv = buildServerArgv({
								server: kind,
								port,
								chip: params.chip,
								elfPath: elf,
								config: params.config,
								machine: params.machine,
							});
							server = spawnServer(argv, port, env.cwd);
							await waitForServerReady(server, caps().readyRe, SERVER_READY_MS);
						}

						const dir = path.join(env.cwd, ".yoma", "gdb");
						const created = await env.createDir(dir, { recursive: true });
						if (!created.ok) throw new Error(`could not create ${dir}: ${created.error.message}`);
						const tag = stamp();
						session = new GdbSession({
							gdbPath,
							cwd: env.cwd,
							logFile: path.join(dir, `session-${tag}.log`),
							miFile: path.join(dir, `session-${tag}.mi`),
							stopsFile: path.join(dir, `stops-${tag}.jsonl`),
						});
						await session.spawnGdb();
						await session.hygiene();

						const load = await session.send(`-file-exec-and-symbols "${escapeCString(elf)}"`, ATTACH_TIMEOUT_MS);
						if (load.class === "error") throw new Error(`gdb could not load ${elf}: ${miString(load.results?.msg)}`);

						// waiter 先装:连接时通常紧跟一个 *stopped,而它会先于 ^connected 到达。
						const firstStop = session.expectStop();
						connection = `${host}:${port}`;
						const sel = await session.send(`-target-select extended-remote ${connection}`, ATTACH_TIMEOUT_MS);
						if (sel.class === "error") {
							const tail = server?.tail.length ? `\nThe server's last output:\n${server.tail.join("\n")}` : "";
							throw new Error(
								appendProbeOccupationHint(
									`could not connect to ${connection}: ${miString(sel.results?.msg)}${tail}`,
									server?.tail.join("\n") ?? "",
								),
							);
						}
						await settledWithin(firstStop, 2_000);

						await probeCore(session);
						const sourceNote = await fixSourcePaths(session, env);
						if (sourceNote) notes.push(sourceNote);
						const image = await verifyImage(env, elf);
						notes.push(image.note);
						if (!image.ok && !params.allowUnverified) {
							const text = `${banner()}\n${image.note}`;
							await teardown(false);
							return { content: [{ type: "text", text }], details: detailsOf("start") };
						}
					} catch (error) {
						await teardown(false);
						throw error;
					}

					elfPath = elf;
					const core = session.core;
					const lines = [
						banner(),
						`attached to ${connection} via ${kind}, gdb ${gdbPath}`,
						core
							? `core: ${core.name} ${core.revision}${session.breakpointUnits ? `, ${session.breakpointUnits} hardware breakpoints` : ""}${session.watchpointUnits ? `, ${session.watchpointUnits} watchpoints` : ""}`
							: "core: not a Cortex-M (no PPB) — fault decoding and hardware budgets are unavailable",
						caps().watchpoints === "none" ? `note: ${kind} does not support watchpoints at all` : "",
						caps().rttHint ? `note: ${caps().rttHint}` : "",
						...notes,
						`session log: ${session.file}`,
						session.lastStop ? await renderStopReport(session, { relativeTo: env.cwd }) : "target state unknown — run gdb exec op:\"interrupt\" or op:\"continue\"",
					].filter(Boolean);
					return { content: [{ type: "text", text: lines.join("\n") }], details: detailsOf("start", await locationOf()) };
				}

				case "break": {
					const s = requireSession("break");
					if (params.at && params.watch) {
						throw new Error('gdb break got both at and watch — pass `at` for a code location or `watch` for a data watchpoint, not both.');
					}

					if (params.remove) {
						if (params.remove === "all") {
							await s.send("-break-delete");
							s.breakpoints.clear();
						} else {
							const n = Number(params.remove);
							if (!Number.isFinite(n)) throw new Error(`gdb break remove: "${params.remove}" is not a breakpoint number or "all"`);
							const r = await s.send(`-break-delete ${n}`);
							if (r.class === "error") throw new Error(miString(r.results?.msg) ?? `could not delete breakpoint ${n}`);
							s.breakpoints.delete(n);
						}
						return { content: [{ type: "text", text: `${banner()}\n${renderBreakpoints(s)}` }], details: detailsOf("break") };
					}

					if (!params.at && !params.watch) {
						return { content: [{ type: "text", text: `${banner()}\n${renderBreakpoints(s)}` }], details: detailsOf("break") };
					}

					if (params.watch) {
						if (caps().watchpoints === "none") {
							throw new Error(
								`${serverKind} has no watchpoint support at all, so this watchpoint would silently never fire. ` +
									"Use OpenOCD or J-Link for watchpoints" +
									(serverKind === "qemu" ? " (QEMU also hangs permanently when a watchpoint is hit — verified)." : "."),
							);
						}
						const used = s.usedUnits("watch");
						if (s.watchpointUnits && used >= s.watchpointUnits) {
							throw new Error(
								`all ${s.watchpointUnits} hardware watchpoints are in use:\n${renderBreakpoints(s)}\nDelete one first (gdb break remove).`,
							);
						}
						const flag = params.mode === "r" ? "-r " : params.mode === "rw" ? "-a " : "";
						const r = await s.send(`-break-watch ${flag}${params.watch}`);
						if (r.class === "error") throw new Error(miString(r.results?.msg) ?? "could not set the watchpoint");
						const wpt = miTuple(r.results?.wpt) ?? miTuple(r.results?.["hw-awpt"]) ?? miTuple(r.results?.["hw-rwpt"]);
						const number = miNumber(wpt?.number);
						// 软件观察点会**单步整个程序**,在 SWD 上慢一万倍,和挂死无法区分。
						const isHardware = r.results?.wpt === undefined || "hw-awpt" in (r.results ?? {}) || "hw-rwpt" in (r.results ?? {});
						if (number !== undefined) {
							s.breakpoints.set(number, { kind: "watch", location: params.watch, units: 1 });
						}
						const warn = isHardware
							? ""
							: "\n⚠ gdb fell back to a SOFTWARE watchpoint — it single-steps the whole program and is indistinguishable from a hang over a probe. Delete it and watch a fixed address instead, e.g. watch:\"*(uint32_t*)&var\".";
						return {
							content: [{ type: "text", text: `${banner()}\nwatchpoint ${number ?? "?"} on ${params.watch}${warn}\n${renderBreakpoints(s)}` }],
							details: detailsOf("break"),
						};
					}

					// 代码断点。留一个单元给 step/next/finish 的临时断点,否则单步会突然失败。
					const usedBreak = s.usedUnits("break");
					if (s.breakpointUnits && usedBreak >= s.breakpointUnits - 1) {
						throw new Error(
							`${usedBreak} of ${s.breakpointUnits} hardware breakpoints are in use and one must stay free for step/next/finish:\n` +
								`${renderBreakpoints(s)}\nDelete one first (gdb break remove).`,
						);
					}
					const flags = [params.temporary ? "-t" : "", params.condition ? `-c "${escapeCString(params.condition)}"` : ""]
						.filter(Boolean)
						.join(" ");
					const r = await s.send(`-break-insert ${flags} ${params.at}`.replace(/\s+/g, " ").trim());
					if (r.class === "error") {
						const msg = miString(r.results?.msg) ?? "unknown";
						throw new Error(
							`${msg}\n(pending breakpoints are disabled on purpose: there are no shared libraries on bare metal, so a pending breakpoint would never resolve and would look like "this code never runs". Check the symbol name, or use file.c:line.)`,
						);
					}
					const bkpt = miTuple(r.results?.bkpt);
					const number = miNumber(bkpt?.number);
					const addr = miString(bkpt?.addr);
					const locations = unwrapList(bkpt?.locations).length;
					const units = Math.max(1, locations);
					if (number !== undefined) s.breakpoints.set(number, { kind: "break", location: params.at!, addr, units });
					const multi =
						locations > 1
							? `\n⚠ this location resolved to ${locations} addresses (inlined or identical-code-folded) and therefore uses ${locations} hardware units.`
							: "";
					const where = bkpt?.file && bkpt?.line ? ` — ${shortenPath(miString(bkpt.file), env.cwd)}:${miString(bkpt.line)}` : "";
					return {
						content: [{ type: "text", text: `${banner()}\nbreakpoint ${number ?? "?"} at ${addr ?? "?"}${where}${multi}\n${renderBreakpoints(s)}` }],
						details: detailsOf("break"),
					};
				}

				case "exec": {
					const s = requireSession("exec");
					const op: ExecOp = params.op ?? "continue";
					const waitMs = clamp(params.waitMs, DEFAULT_WAIT_MS, 100, MAX_WAIT_MS);
					const onTimeout = params.onTimeout ?? "interrupt";

					// UI 心跳:continue 期间 MI 一个字节都不产生,Zed 的卡片会空白几十秒,
					// 和挂死无法区分 —— 而那正是用户最可能按 Esc 掐掉一个本该等下去的会话的时刻。
					let beats = 0;
					const heartbeat = setInterval(() => {
						beats++;
						const armed = [...s.breakpoints.values()].map((b) => b.location).join(", ") || "none";
						onUpdate?.({
							content: [{ type: "text", text: `running ${beats}s — waiting for a stop (breakpoints: ${armed})` }],
							details: detailsOf("exec"),
						});
					}, 1_000);
					heartbeat.unref?.();
					const onAbort = () => clearInterval(heartbeat);
					signal?.addEventListener("abort", onAbort, { once: true });

					try {
						if (op === "interrupt") {
							const waiter = s.expectStop();
							await s.send("-exec-interrupt");
							const halted = await settledWithin(waiter, INTERRUPT_GRACE_MS);
							const text = halted
								? `${banner()}\n${await renderStopReport(s, { show: params.show, relativeTo: env.cwd })}`
								: `${banner()}\ninterrupt was sent but the target did not stop within ${INTERRUPT_GRACE_MS} ms — it may be asleep (WFI with the debug clock gated) or SWD lost sync.`;
							return { content: [{ type: "text", text }], details: detailsOf("exec", await locationOf()) };
						}

						if (op === "reset-halt" || op === "reset-run") {
							const template = op === "reset-halt" ? caps().resetHalt : caps().resetRun;
							if (!template) {
								throw new Error(
									`${serverKind} does not expose ${op} through gdb. ` +
										(serverKind === "qemu"
											? "Restart the session instead — QEMU's monitor system_reset does not reliably reset a Cortex-M core."
											: "Use gdb eval with the server's own monitor command."),
								);
							}
							const waiter = s.expectStop();
							const r = await s.console(template);
							s.epoch += 1;
							if (op === "reset-halt") {
								await settledWithin(waiter, INTERRUPT_GRACE_MS);
							}
							const text =
								`${banner()}\nsession epoch is now ${s.epoch} — the target was reset, so any address, register value or ` +
								`breakpoint hit count you cached before this line is stale.\n${clip(r.output.trim(), 800)}` +
								(op === "reset-halt" ? `\n${await renderStopReport(s, { show: params.show, relativeTo: env.cwd })}` : "");
							return { content: [{ type: "text", text }], details: detailsOf("exec", await locationOf()) };
						}

						if (op === "wait") {
							const outcome = await resumeAndWait(s, undefined, waitMs, onTimeout);
							const text = outcome.stopped
								? `${banner()}\n${outcome.note ? `${outcome.note}\n` : ""}${await renderStopReport(s, { show: params.show, relativeTo: env.cwd })}`
								: `${banner()}\n${outcome.note ?? `nothing stopped within ${waitMs} ms.`}`;
							return { content: [{ type: "text", text }], details: detailsOf("exec", await locationOf()) };
						}

						if (op === "continue" && s.breakpoints.size === 0 && !params.expectRunning) {
							throw new Error(
								"no breakpoints or watchpoints are armed — continue would run until the timeout with nothing to stop it, " +
									"and the timeout would look like a hang even though the firmware is fine. " +
									'Set a breakpoint first (gdb break at:"..."), or pass expectRunning: true if you just want it running.',
							);
						}

						const MI: Record<string, string> = {
							continue: "-exec-continue",
							step: "-exec-step",
							next: "-exec-next",
							finish: "-exec-finish",
							stepi: "-exec-step-instruction",
						};
						const command = MI[op]!;
						const count = op === "continue" || op === "finish" ? 1 : clamp(params.count, 1, 1, MAX_STEP_COUNT);

						// 单步循环:每步一行,最后给一份完整报告。十行两个观察表达式
						// 从"20 次往返 40k token"变成一次调用。
						const trail: string[] = [];
						let outcome = await resumeAndWait(s, command, waitMs, onTimeout);
						for (let i = 1; i < count && outcome.stopped; i++) {
							const f = s.lastStop?.frame;
							const shown = await Promise.all(
								(params.show ?? []).map(async (e) => {
									const r = await s.send(`-data-evaluate-expression "${escapeCString(e)}"`).catch(() => undefined);
									return `${e}=${r?.class === "done" ? miString(r.results?.value) : "?"}`;
								}),
							);
							trail.push(
								`${f?.file && f?.line ? `${shortenPath(f.file, env.cwd)}:${f.line}` : (f?.func ?? "?")}${shown.length ? ` ${shown.join(" ")}` : ""}`,
							);
							if (s.lastStop && s.lastStop.reason !== "end-stepping-range") break;
							outcome = await resumeAndWait(s, command, waitMs, onTimeout);
						}

						if (outcome.error) {
							return {
								content: [{ type: "text", text: `${banner()}\n${outcome.error}` }],
								details: detailsOf("exec"),
							};
						}
						const parts = [banner()];
						if (trail.length) parts.push(`steps: ${trail.join(" | ")}`);
						if (outcome.note) parts.push(outcome.note);
						parts.push(
							outcome.stopped
								? await renderStopReport(s, { show: params.show, relativeTo: env.cwd })
								: `the target is still RUNNING after ${waitMs} ms.`,
						);
						return { content: [{ type: "text", text: parts.join("\n") }], details: detailsOf("exec", await locationOf()) };
					} finally {
						clearInterval(heartbeat);
						signal?.removeEventListener("abort", onAbort);
					}
				}

				case "eval": {
					const s = requireSession("eval");
					if (!params.command) throw new Error('gdb eval needs command, e.g. command:"p/x *cfg" or command:"info registers"');
					const verdict = classifyEval(params.command);
					if (verdict.kind === "blocked") throw new Error(`gdb eval refused \`${params.command}\`: ${verdict.reason}`);
					if (verdict.kind === "reroute") {
						throw new Error(
							`\`${params.command}\` is run control — use gdb exec op:"${verdict.op}" instead. ` +
								"exec waits for the stop and returns the frames, source line and locals in the same call; " +
								"running it through eval would leave the tool's idea of the target state wrong.",
						);
					}
					if (verdict.kind === "mutating" && !params.write) {
						throw new Error(`gdb eval refused \`${params.command}\`: ${verdict.reason}`);
					}

					const r = await s.console(params.command);
					const failed = r.class === "error";
					const body = failed ? (miString(r.results?.msg) ?? "error") : r.output.trim() || "(no output)";
					const text = `${banner()}\n${failed ? "gdb reported an error: " : ""}${clip(body, MAX_EVAL_CHARS)}`;
					return { content: [{ type: "text", text }], details: detailsOf("eval", await locationOf()) };
				}

				case "status": {
					if (!session?.running) {
						return {
							content: [{ type: "text", text: "[gdb no session] nothing is attached. Run `gdb` action:\"start\"." }],
							details: detailsOf("status"),
						};
					}
					const s = session;
					const lines = [
						banner(),
						`elf: ${elfPath ?? "?"}`,
						s.core ? `core: ${s.core.name} ${s.core.revision}` : "core: unknown / not Cortex-M",
						renderBreakpoints(s),
						s.lastStop ? await renderStopReport(s, { relativeTo: env.cwd }) : "no stop recorded yet",
						`session log: ${s.file}`,
						server ? `server: ${serverKind} pid ${server.child.pid} on ${connection}` : `server: external (${connection})`,
					];
					return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: detailsOf("status", await locationOf()) };
				}

				case "stop": {
					if (!session?.running) {
						return { content: [{ type: "text", text: "no gdb session was running." }], details: detailsOf("stop") };
					}
					const keep = params.keepServer === true && server !== undefined;
					const handover =
						keep && connection && elfPath
							? `\nThe server is still listening. To take over by hand:\n  gdb ${elfPath} -ex "target extended-remote ${connection}"`
							: "";
					const file = session.file;
					await teardown(keep);
					return {
						content: [{ type: "text", text: `gdb session closed.${handover}\nSession log: ${file}` }],
						details: detailsOf("stop"),
					};
				}
			}
		},
	};
}

const MAX_EVAL_CHARS = 6_000;

function renderBreakpoints(s: GdbSession): string {
	if (s.breakpoints.size === 0) return "breakpoints: none armed";
	const rows = [...s.breakpoints.entries()].map(
		([n, b]) => `  ${n} ${b.kind === "watch" ? "watch" : "break"} ${b.location}${b.addr ? ` @ ${b.addr}` : ""}`,
	);
	const budget = [
		s.breakpointUnits ? `hw breakpoints ${s.usedUnits("break")}/${s.breakpointUnits}` : "",
		s.watchpointUnits ? `watchpoints ${s.usedUnits("watch")}/${s.watchpointUnits}` : "",
	]
		.filter(Boolean)
		.join(", ");
	return `breakpoints:\n${rows.join("\n")}${budget ? `\n  (${budget})` : ""}`;
}

export function createGdbTool(env: ExecutionEnv, options?: GdbToolOptions) {
	return wrapToolDefinition(createGdbToolDefinition(env, options));
}
