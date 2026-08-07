// M6:NodeExecutionEnv = FileSystem + Shell。
// 核心纪律:方法永不 throw —— 一切失败(包括意外的后端错误)编码为 Result<T, FileError | ExecutionError>,
// Node 的 errno 在 toFileError 里映射为后端无关的错误码。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	err,
	type ExecutionEnv,
	ExecutionError,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	toError,
} from "../types.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 子进程 exit 之后再等一小会儿收尾 stdio,避免丢掉最后几个 chunk。 */
const EXIT_STDIO_GRACE_MS = 100;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// 畸形 URL 当作普通路径,保持文件系统方法"永不 throw"的契约。
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: path.replace(/\/+$/, "").split("/").pop() ?? path,
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, path?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	if (isNodeError(error)) {
		const message = error.message;
		switch (error.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** 只用于 shell 发现(which/where),不走 exec 那条完整路径。 */
async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/** Windows 自带的 WSL 垫片 bash.exe 不接受 -c,只能从 stdin 喂命令。 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

/**
 * 杀整棵进程树,而不是只杀 shell 本身 —— 否则 `npm run dev` 这类命令的孙子进程会变成孤儿。
 * POSIX 靠 detached 建立进程组后 kill(-pid);Windows 用 taskkill /T。
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// 忽略错误。
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已经没了。
		}
	}
}

/**
 * 等子进程真正结束。比直接听 "close" 复杂,是因为要覆盖三种收尾方式:
 * exit + 两个流都 end(正常)、close(兜底)、以及 exit 之后 stdio 迟迟不 end
 * (孙子进程还占着管道)——最后一种靠 EXIT_STDIO_GRACE_MS 的空闲计时器强制收尾。
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise(code);
		};
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null): void => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null): void => finalize(code);

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	/** 记录在跑的子进程,cleanup() 时统一杀掉,避免进程泄漏。 */
	private activeChildPids = new Set<number>();

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const onAbort = () => {
				if (child?.pid) {
					killProcessTree(child.pid);
				}
			};

			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				if (settled) return;
				settled = true;
				resolvePromise(result);
			};

			try {
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						// detached 让子进程自成进程组,killProcessTree 才能用 kill(-pid) 一锅端。
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (child.pid) this.activeChildPids.add(child.pid);
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			timeoutId =
				timeoutMs !== undefined
					? setTimeout(() => {
							timedOut = true;
							if (child?.pid) {
								killProcessTree(child.pid);
							}
						}, timeoutMs)
					: undefined;

			if (options?.abortSignal) {
				if (options.abortSignal.aborted) {
					onAbort();
				} else {
					options.abortSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				try {
					options?.onStdout?.(chunk);
				} catch (error) {
					// 回调抛错不能吞:记下来,杀掉进程,最终以 callback_error 返回。
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				try {
					options?.onStderr?.(chunk);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});

			void waitForChildProcess(child).then(
				(code) => {
					// 判定顺序有讲究:回调错误 > 超时 > 中断 > 正常退出码。
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					if (timedOut) {
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
						return;
					}
					if (options?.abortSignal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
						return;
					}
					settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
				},
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string[]>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			lineReader?.close();
			stream?.destroy();
		}
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await appendFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
