/**
 * 引擎工具的共享辅助:路径解析 + 子进程运行。
 * stm32config / netlist / flash 三个工具共用这一份 —— 与 path-utils.ts、
 * edit-diff.ts 同类,是工具旁边的辅助模块,不是工具。
 *
 * 为什么不用 bash 工具那条 env.exec 路径:它吃 shell 字符串(参数会被二次解释)、
 * 带 shell 初始化和面向交互的输出截断;引擎调用需要 argv 精确传参、JSON 原样收集。
 *
 * 布局只有一种:engines/bin/ 放全部可执行文件,engines/data/<name>/ 放数据。
 * `bun engines/build.ts` 构建后用符号链接填充;将来打包分发时 CI 往同样的位置
 * 放真文件,这里的代码不变。测试用假引擎时通过 options 显式传 enginesDir。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

export function enginesDir(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidate = path.join(dir, "engines");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(
				"engines/ directory not found. Run `git submodule update --init --recursive` then `bun engines/build.ts`.",
			);
		}
		dir = parent;
	}
}

/** engines/bin/ 下的可执行文件,如 engineBin("stm32kernel")。缺席时给修复指引。 */
export function engineBin(name: string, options?: EnginePathOptions): string {
	const file = path.join(options?.enginesDir ?? enginesDir(), "bin", exe(name));
	if (!existsSync(file)) {
		throw new Error(`\`${name}\` not found at ${file}. Run \`bun engines/build.ts\` to build and install the engines.`);
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
// 所以只需要一个模块级变量,和一句说清楚"谁占着、怎么放"的错误。不做注册表。

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
}

let probeLease: ProbeLease | undefined;

/** 拿探针。成功返回 undefined;冲突返回当前持有者。持有者已经死了就直接接管。 */
export function claimProbe(owner: string, label: string, isLive?: () => boolean): ProbeLease | undefined {
	if (probeLease && (probeLease.isLive?.() ?? true)) return probeLease;
	probeLease = { owner, label, since: Date.now(), isLive };
	return undefined;
}

/** 放探针。owner 不匹配就什么也不做 —— 避免 A 的清理路径误放了 B 的租约。 */
export function releaseProbe(owner: string): void {
	if (probeLease?.owner === owner) probeLease = undefined;
}

/** 冲突时给模型看的话:必须点名持有者和确切的释放动作,否则它会去猜硬件。 */
export function describeProbeConflict(holder: ProbeLease): string {
	const held = Math.round((Date.now() - holder.since) / 1000);
	return `the debug probe is held by the \`${holder.owner}\` tool (${holder.label}) since ${held}s ago — run \`${holder.owner}\` action:"stop" first`;
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
// 3. 超时/中断先 SIGTERM,宽限 3 秒后 SIGKILL,且 settle 一定有界:
//    'close' 要等管道排干,而管道可能被引擎 fork 出的孙进程握着(它继承了 stdio);
//    只靠 'close' 会在这种情况下无限挂起 —— 所以 'exit' 之后再给流一小段冲刷宽限,
//    到点就带着已收集的输出 settle,不陪孙进程耗。

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

function terminate(child: ChildProcess): void {
	killTree(child, "SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
	}, FORCE_KILL_GRACE_MS);
	// 不让宽限计时器拖住进程退出。
	forceKill.unref();
}

export function runEngine(bin: string, args: string[], options: EngineRunOptions = {}): Promise<EngineRunResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// 自成进程组,这样 killTree 才够得着孙进程。
			detached: process.platform !== "win32",
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
