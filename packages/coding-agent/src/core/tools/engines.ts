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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── 路径解析 ────────────────────────────────────────────────────────────────

/** Windows 可执行文件带 .exe 后缀。 */
export function exe(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
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
	env?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function terminate(child: ChildProcess): void {
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, FORCE_KILL_GRACE_MS);
	// 不让宽限计时器拖住进程退出。
	forceKill.unref();
}

export function runEngine(bin: string, args: string[], options: EngineRunOptions = {}): Promise<EngineRunResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
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
