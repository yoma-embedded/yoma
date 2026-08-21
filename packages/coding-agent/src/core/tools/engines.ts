/**
 * 引擎工具的共享辅助:路径解析 + 子进程运行 + 探针租约 + 输出预算。
 * 引擎工具(stm32config / netlist / flash)与 gdb / log / serial 共用这一份 ——
 * 与 path-utils.ts、edit-diff.ts 同类,是工具旁边的辅助模块,不是工具。
 * 改这里(尤其 killTree / runEngine)的回归面是这**六个**文件,不是三个:写着"三个"
 * 的时候,动 killTree 的人只会去回归引擎工具,而真正被打坏的是 gdb 的杀树链和 log
 * 的采集子进程 —— 也就是"孤儿 gdbserver 攥着探针不放,报错长得和没插板子一模一样"
 * 那条疤。另外它整个经 src/index.ts 的 `export *` 抬成了包的公共 API。
 *
 * 为什么不用 bash 工具那条 env.exec 路径:它吃 shell 字符串(参数会被二次解释)、
 * 带 shell 初始化和面向交互的输出截断;引擎调用需要 argv 精确传参、JSON 原样收集。
 *
 * 布局只有一种:engines/bin/ 放全部可执行文件,engines/data/<name>/ 放数据。
 * `bun engines/build.ts` 构建后用符号链接填充;打包时由 desktop 的
 * `scripts/stage-engines.ts` 把同样的 bin/ + data/ 布局实体化(dereference)到
 * `.engines-stage/` 再进 extraResources,这里的代码不变(electron-builder 对
 * extraResources 里的软链原样保留,所以必须实体化)。测试用假引擎时通过 options
 * 显式传 enginesDir。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── 路径解析 ────────────────────────────────────────────────────────────────

/** Windows 可执行文件带 .exe 后缀。 */
export function exe(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

/** 数值参数夹取:非数给回退值,越界钳到边界。gdb/log 共用。 */
export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 会话产物文件名用的本地时间戳 `YYYYMMDD-HHMMSSmmm`。gdb/log 共用。 */
export function stamp(now = new Date()): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
	);
}

export interface EnginePathOptions {
	/** engines 根目录;默认从本模块向上找到仓库的 engines/。 */
	enginesDir?: string;
}

/** engines/bin 下必须有的可执行文件。 */
export const ENGINE_BINARIES = ["stm32kernel", "controller_map", "board_ir", "connections"] as const;

/** 向上找带 bin/ 的 engines 目录,跳过空壳。 */
export function findEnginesDir(start: string): string {
	let dir = start;
	const skipped: string[] = [];
	while (true) {
		const candidate = path.join(dir, "engines");
		if (existsSync(candidate)) {
			if (existsSync(path.join(candidate, "bin"))) return candidate;
			skipped.push(candidate);
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			const skipNote = skipped.length ? ` Ignored empty engines/ without bin/: ${skipped.join(", ")}.` : "";
			throw new Error(
				"engines/ directory not found." +
					skipNote +
					" Run `bun engines/build.ts` to build and install.",
			);
		}
		dir = parent;
	}
}

export function enginesDir(): string {
	return findEnginesDir(path.dirname(fileURLToPath(import.meta.url)));
}

function engineMissingMessage(name: string, file: string, root: string): string {
	const isSourceCheckout = existsSync(path.join(root, "build.ts"));
	if (isSourceCheckout) {
		return `\`${name}\` not found at ${file}. This is the repo engines directory — run \`bun engines/build.ts\` from the repository root.`;
	}
	return `\`${name}\` not found at ${file}. The packaged debug engines are missing — reinstall Yoma. This is not a source checkout, so \`bun engines/build.ts\` will not help.`;
}

/** engines/bin/ 下的可执行文件,如 engineBin("stm32kernel")。缺席时给修复指引。 */
export function engineBin(name: string, options?: EnginePathOptions): string {
	const root = options?.enginesDir ?? enginesDir();
	const file = path.join(root, "bin", exe(name));
	if (!existsSync(file)) {
		throw new Error(engineMissingMessage(name, file, root));
	}
	return file;
}

/** engines/data/ 下的数据目录,如 engineDataDir("stm32")。 */
export function engineDataDir(name: string, options?: EnginePathOptions): string {
	const dir = path.join(options?.enginesDir ?? enginesDir(), "data", name);
	if (!existsSync(dir)) {
		throw new Error(`engine data \`${name}\` not found at ${dir}. Run \`bun engines/build.ts\` to install it.`);
	}
	return dir;
}

/**
 * 内核实际装了哪些族 —— 从 data/stm32/*.irpack 的文件名读,不写死。
 *
 * 写死过一次,代价很具体:描述里留着"currently STM32F1 and STM32F4",而数据目录
 * 里躺着 27 个 pack。模型照着这句话把一颗完全支持的 G473 判成不支持,掉头去手写
 * 寄存器代码 —— 工具没坏,是工具的自述把它关在门外了。能力清单必须由能力本身生成。
 */
export function stm32Families(options?: EnginePathOptions): string[] {
	const dir = engineDataDir("stm32", options);
	return readdirSync(dir)
		.filter((f) => f.endsWith(".irpack"))
		.map((f) => f.slice(0, -".irpack".length).toUpperCase())
		.sort();
}

// ─── 探针租约 ────────────────────────────────────────────────────────────────
//
// 一个调试探针同一时间只能被一个进程握住。这个约束以前只写在 log.ts 的注释里,
// 没有任何机制 —— 而 `executionMode: "sequential"` 管不了它:那只让**同一批**
// 工具调用串行,三轮之前 `log start` 起的那个子进程照样活着攥着 USB 句柄。
//
// 不装机制的代价是具体的:模型 log start(RTT)→ 再 gdb start,OpenOCD 打印
// `Error: open failed` —— 和"根本没插探针"一模一样的字符串 —— 于是模型让用户去
// 检查 USB 线。线是好的,是 agent 自己的另一个工具占着。这个错误模型无法自己走出来,
// 因为没有任何信息指向持有者。
//
// 进程内用一个模块级变量。交互会话(内核 utilityProcess)和调试台轮次子进程
// 各有一份,互看不见 —— 所以再落一份 `~/.yoma/probe.lock`,跨进程才能说出
// "谁占着、怎么放",而不是让模型去查焊接。

export interface ProbeLease {
	/** 工具名,用来组"先跑 `<owner> stop`"这句话。 */
	owner: string;
	/** 人看的说明,如 "RTT on STM32G431CB"。 */
	label: string;
	since: number;
	/**
	 * 持有者是否还活着。租约会漏 —— 采集的子进程可能自己死了(探针被拔、固件进了
	 * 低功耗),而 stop 永远不会被调用。没有这个回调,后面所有人都会撞上一个
	 * 早就没人要的租约,而且错误信息还理直气壮地点错名。
	 */
	isLive?: () => boolean;
	/** 跨进程占用时对方的 pid。有这个就不要叫模型去跑本进程的 owner stop。 */
	pid?: number;
}

let probeLease: ProbeLease | undefined;

export function probeLockFile(): string {
	const explicit = process.env.YOMA_PROBE_LOCK?.trim();
	if (explicit) return explicit;
	return path.join(os.homedir(), ".yoma", "probe.lock");
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface ProbeLockRecord {
	pid: number;
	owner: string;
	label: string;
	since: number;
}

function readCrossProcessLock(): ProbeLockRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(probeLockFile(), "utf8")) as ProbeLockRecord;
		if (!raw || typeof raw.pid !== "number" || typeof raw.owner !== "string") return undefined;
		if (raw.pid === process.pid) return undefined;
		if (!pidAlive(raw.pid)) {
			try {
				unlinkSync(probeLockFile());
			} catch {
				// 过期锁清不掉就让下一次 claim 再试。
			}
			return undefined;
		}
		return raw;
	} catch {
		return undefined;
	}
}

function writeCrossProcessLock(owner: string, label: string, since: number): void {
	const file = probeLockFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const body = `${JSON.stringify({ pid: process.pid, owner, label, since })}\n`;
	try {
		writeFileSync(file, body, { flag: "wx" });
		return;
	} catch {
		const existing = readCrossProcessLock();
		if (existing) return;
		try {
			unlinkSync(file);
		} catch {
			return;
		}
		try {
			writeFileSync(file, body, { flag: "wx" });
		} catch {
			// 抢不到就继续:进程内租约仍在,跨进程冲突由烧录器/服务器自己的 exclusive access 报错兜着。
		}
	}
}

function clearCrossProcessLock(): void {
	try {
		const raw = JSON.parse(readFileSync(probeLockFile(), "utf8")) as ProbeLockRecord;
		if (raw.pid === process.pid) unlinkSync(probeLockFile());
	} catch {
		// 没有锁、或不是我们写的,不动。
	}
}

/** 拿探针。成功返回 undefined;冲突返回当前持有者。持有者已经死了就直接接管。 */
export function claimProbe(owner: string, label: string, isLive?: () => boolean): ProbeLease | undefined {
	if (probeLease && (probeLease.isLive?.() ?? true)) return probeLease;
	const other = readCrossProcessLock();
	if (other) {
		return {
			owner: other.owner,
			label: other.label,
			since: other.since,
			pid: other.pid,
			isLive: () => pidAlive(other.pid),
		};
	}
	const since = Date.now();
	probeLease = { owner, label, since, isLive, pid: process.pid };
	writeCrossProcessLock(owner, label, since);
	return undefined;
}

/** 放探针。owner 不匹配就什么也不做 —— 避免 A 的清理路径误放了 B 的租约。 */
export function releaseProbe(owner: string): void {
	if (probeLease?.owner !== owner) return;
	probeLease = undefined;
	clearCrossProcessLock();
}

const NOT_HARDWARE =
	"This is NOT a disconnected board, a missing ST-Link, or a soldering problem.";

/** 冲突时给模型看的话:必须点名持有者和确切的释放动作,否则它会去猜硬件。 */
export function describeProbeConflict(holder: ProbeLease): string {
	const held = Math.round((Date.now() - holder.since) / 1000);
	if (holder.pid && holder.pid !== process.pid) {
		return (
			`the debug probe is already in use by another process (pid ${holder.pid}: \`${holder.owner}\` — ${holder.label}, held ${held}s). ` +
			`${NOT_HARDWARE} Stop that Yoma session (desktop Stop, or the mailbox runner) or close the other debugger, then retry.`
		);
	}
	// flash 是一次性调用(finally 放锁),对它说 action:"stop" 是指一条不存在的路。
	const release = holder.owner === "flash" ? "wait for that command to finish" : `run \`${holder.owner}\` action:"stop" first`;
	return `the debug probe is held by the \`${holder.owner}\` tool (${holder.label}) since ${held}s ago — ${release}`;
}

const EXCLUSIVE_RE =
	/0xe00002c5|exclusive access|already in use|probe.*busy|busy.*probe|resource busy|in use by another/i;

/**
 * 烧录器/调试服务器把"被别的进程占着"和"没插板子"打成很像的非零退出。
 * 认出来就说占着;认不出来也先提占用,再提没插,不要只说去接 ST-Link。
 */
export function describeProbeHardwareError(output: string): string | undefined {
	if (!EXCLUSIVE_RE.test(output)) return undefined;
	const other = readCrossProcessLock();
	if (other) return describeProbeConflict({ ...other, pid: other.pid, isLive: () => pidAlive(other.pid) });
	return (
		`the debug probe is already in use by another process (exclusive access / 0xe00002c5). ` +
		`${NOT_HARDWARE} A Yoma interactive session, a mailbox runner, STM32CubeIDE, OpenOCD, or a J-Link tool may be holding it. ` +
		`Stop that, then retry. If nothing else is running, unplug/replug the probe.`
	);
}

export function appendProbeOccupationHint(message: string, output = ""): string {
	const hint = describeProbeHardwareError(`${message}\n${output}`);
	if (!hint) return message;
	if (message.includes("already in use") || message.includes("0xe00002c5")) return message;
	return `${message}\n${hint}`;
}

export function probeFailedHint(output: string): string {
	const occupied = describeProbeHardwareError(output);
	if (occupied) return occupied;
	return (
		`If another program is using the probe (Yoma session, mailbox runner, CubeIDE, OpenOCD, a J-Link tool), stop it — that error often looks like a disconnected board but is not. ` +
		`If nothing else is running, connect an ST-Link/J-Link/CMSIS-DAP probe and check the OS actually sees it (lsusb / Get-PnpDevice / the vendor tool's own probe listing).`
	);
}

// ─── 输出预算 ────────────────────────────────────────────────────────────────

/**
 * 引擎输出进模型上下文前的上限。
 *
 * 引擎是给机器读的,输出没有自然长度:`list-mcus` 不加过滤会吐 659,499 个字符
 * (约 165k token)—— 一次调用就能把会话打爆,而模型是在读到之前才知道。工具层
 * 必须自己记这笔账;截断时要说清被截了多少、以及怎么把范围收窄,否则模型只会
 * 原样重试一遍。与 log 工具的 MAX_EXCERPT_CHARS 同一个数量级。
 */
export const MAX_ENGINE_OUTPUT_CHARS = 24_000;

export function capEngineOutput(text: string, narrowHint: string, limit = MAX_ENGINE_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	const kept = text.slice(0, limit);
	// 截在最后一个换行,别把一行 JSON 劈成两半。
	const cut = kept.lastIndexOf("\n");
	const head = cut > limit / 2 ? kept.slice(0, cut) : kept;
	const dropped = text.length - head.length;
	return `${head}\n\n[truncated: ${dropped} of ${text.length} characters withheld. ${narrowHint}]`;
}

// ─── 子进程运行 ──────────────────────────────────────────────────────────────
// 语义移植自 yoma embedded.ts 的 run()(Effect 版),三条契约:
//
// 1. argv 数组直接 spawn,不经过 shell —— 引擎参数里出现空格/引号不会被二次解释。
// 2. 非零退出码在这一层不是错误:多个引擎用 exit 1 表示"有诊断信息",
//    stdout 上仍是有用的 JSON,由调用方决定怎么呈现给模型。
// 3. 超时/中断先 SIGTERM,宽限 3 秒后 SIGKILL,且 settle 一定有界 ——
//    为什么 'close' 不够、'exit' 之后为什么还要冲刷宽限,见两个处理器上的注释。

/** 子进程和它的管道都不能拖住事件循环,否则宿主退出时进程不肯死。 */
export function unrefStream(stream: unknown): void {
	(stream as { unref?: () => void } | null | undefined)?.unref?.();
}

export interface EngineRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export const DEFAULT_ENGINE_TIMEOUT_MS = 5 * 60 * 1000;

const FORCE_KILL_GRACE_MS = 3 * 1000;

/** 进程已退出后等待 stdout/stderr 排干的宽限;超过就放弃残余输出直接 settle。 */
const STREAM_FLUSH_GRACE_MS = 1000;

export interface EngineRunOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * 杀整棵进程树而不只是直接子进程。子进程经常是 `sh -c "a && b"`,或者自己 fork 出
 * 工作进程 —— 真正攥着串口/探针的往往是孙子,只杀直接子进程会留下孤儿,
 * 下一次烧录就会失败成"没插探针"的样子(而拔插 USB 能"修好",于是这个错误假设
 * 被确认,泄漏永远找不到)。POSIX 靠 detached 建的进程组 kill(-pid)。
 *
 * log / gdb / 引擎三条路径共用这一份 —— 付过学费的疤痕组织,不该有三份拷贝。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		} catch {
			// 进程可能已经没了。
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// 进程已经没了。
		}
	}
}

/**
 * 宿主退出/被信号打断时,兜底杀掉还活着的那批子进程 —— 否则烧录器 / gdbserver 会
 * 一直握着探针。log 与 gdb 两条路各写过一份逐行同构的拷贝,与 killTree 同属"付过学费
 * 的疤痕组织",收在这里。
 *
 * `victims` 必须**惰性遍历**:钩子是第一个子进程 start 时装的,后来的进程全靠这一点
 * 被收掉,所以不能在注册那一刻把成员拷成数组。
 *
 * `yieldToHost` 是两条路唯一的差别,两个取值各有各的因果:
 * - true(log):'exit' 不会因为信号而触发。只有在宿主没自己处理信号时才接管,接管后
 *   照旧退出(128+n),不改变宿主的可观察行为。
 * - false(gdb):攥着探针的 gdbserver 太贵,不能"宿主已有监听就跳过"。
 */
export function killOnHostExit<T extends { killNow(): void }>(
	victims: Set<T>,
	options?: { yieldToHost?: boolean },
): void {
	if (hooked.has(victims)) return;
	hooked.add(victims);
	const killAll = () => {
		for (const victim of victims) victim.killNow();
	};
	process.once("exit", killAll);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		if (options?.yieldToHost && process.listenerCount(signal) > 0) continue;
		process.once(signal, () => {
			killAll();
			process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
		});
	}
}

/** 每个集合只装一次钩子(每个调用点一个集合,等价于从前各自的模块级 boolean)。 */
const hooked = new WeakSet<Set<{ killNow(): void }>>();

function terminate(child: ChildProcess): void {
	killTree(child, "SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
	}, FORCE_KILL_GRACE_MS);
	// 不让宽限计时器拖住进程退出。
	forceKill.unref();
}

/**
 * 超时/中断在所有引擎工具里都是异常,这两句话本来在四个调用点各抄了一遍。
 *
 * **退出码故意不在这里** —— 每个调用方的非零退出含义不同:stm32kernel exit 1 = 有 ERROR
 * 诊断(正常结果,是修复回路的一部分),flash 的烧录器非零 = 多半没插板子(也是正常
 * 结果,见 flash.ts 头注释),controller_map / board_ir 非零才是真失败。谁的退出码策略
 * 留在谁自己那儿 —— 把它折进来正是 flash.ts 那条头注释在防的事。
 */
export function assertEngineSettled(result: EngineRunResult, label: string): EngineRunResult {
	if (result.timedOut) throw new Error(`${label} timed out`);
	if (result.aborted) throw new Error(`${label} was aborted`);
	return result;
}

export function runEngine(bin: string, args: string[], options: EngineRunOptions = {}): Promise<EngineRunResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Python 引擎在中文 Windows 上按 cp936 写 stdout,而下面按 UTF-8 解;与 getShellEnv 同一条规矩。
			env: {
				...process.env,
				PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
				PYTHONUTF8: process.env.PYTHONUTF8 || "1",
			},
			// 自成进程组,这样 killTree 才够得着孙进程。
			detached: process.platform !== "win32",
			// 桌面端是 GUI 进程:引擎起来时不要在用户面前闪一个控制台窗口。
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			terminate(child);
		}, timeoutMs);

		const onAbort = () => {
			aborted = true;
			terminate(child);
		};
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const cleanup = () => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			// 结算时收掉整组,不只是超时/中断路径:引擎自己 `&` 出去的后台进程
			// 会在 shell 退出后变孤儿,而它可能还攥着探针。引擎是一次性的 JSON
			// 生产者,没有"故意留守护进程"这种用法,所以这里可以无条件收。
			killTree(child, "SIGKILL");
		};

		// spawn 本身失败(如二进制不存在)才算这一层的错误。
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`failed to run ${bin}: ${String(error)}`));
		});

		// 正常路径走 close:等 stdout/stderr 流也结束,输出才完整。
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ exitCode: code, stdout, stderr, timedOut, aborted });
		});

		// 有界兜底走 exit:进程本体已死,close 却可能被继承了管道的孙进程无限拖住。
		// 宽限一段冲刷时间后强制收流并 settle(exitCode 用 exit 事件给的值)。
		child.on("exit", (code) => {
			if (settled) return;
			const flushGrace = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				child.stdout.destroy();
				child.stderr.destroy();
				resolve({ exitCode: code, stdout, stderr, timedOut, aborted });
			}, STREAM_FLUSH_GRACE_MS);
			flushGrace.unref();
		});
	});
}
