// NodeExecutionEnv 的 Shell/exec 部分。文件系统部分由 storage/session 两套测试间接覆盖。
//
// 移植自 pi 的 nodejs-env.test.ts,略去两个用例并注明原因:
// - "settles after the shell exits when a detached descendant retains inherited stdio":Windows-only。
// - "uses stdin command transport for legacy WSL bash paths":要 process.chdir + 改写 process.platform。
//   vitest 每个文件独立进程,这么做没问题;bun 全仓共享一个模块图与进程,改全局会污染其他测试文件
//   (session-uuid 那次就是栽在这上面)。isLegacyWslBashPath 的分支改为纯函数单测覆盖。
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { createTempDir } from "./session-test-utils.ts";

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

describe("NodeExecutionEnv exec", () => {
	it("executes commands in cwd with env overrides", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(
			await env.exec('printf \'%s:%s\' "$PWD" "$NODE_ENV_TEST"', {
				env: { NODE_ENV_TEST: "ok" },
			}),
		);
		// macOS 的 tmpdir 是 /var -> /private/var 的符号链接,所以拿 realpath 比。
		expect(result).toEqual({ stdout: `${await realpath(root)}:ok`, stderr: "", exitCode: 0 });
	});

	it("pins PYTHONIOENCODING and PYTHONUTF8 so Chinese Windows scripts do not emit GBK", async () => {
		const root = createTempDir();
		const prevIo = process.env.PYTHONIOENCODING;
		const prevUtf = process.env.PYTHONUTF8;
		delete process.env.PYTHONIOENCODING;
		delete process.env.PYTHONUTF8;
		try {
			const env = new NodeExecutionEnv({ cwd: root });
			const result = getOrThrow(await env.exec('printf \'%s:%s\' "$PYTHONIOENCODING" "$PYTHONUTF8"'));
			expect(result.stdout).toBe("utf-8:1");
		} finally {
			if (prevIo === undefined) delete process.env.PYTHONIOENCODING;
			else process.env.PYTHONIOENCODING = prevIo;
			if (prevUtf === undefined) delete process.env.PYTHONUTF8;
			else process.env.PYTHONUTF8 = prevUtf;
		}
	});

	it("can replace rather than inherit the default shell environment", async () => {
		const root = createTempDir();
		const inheritedKey = "MY_PI_NODE_ENV_INHERITED_TEST";
		const configuredKey = "MY_PI_NODE_ENV_CONFIGURED_TEST";
		const explicitKey = "MY_PI_NODE_ENV_EXPLICIT_TEST";
		const previousInherited = process.env[inheritedKey];
		process.env[inheritedKey] = "host";
		try {
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: { [configuredKey]: "configured" } });
			const result = getOrThrow(
				await env.exec(`printf '%s:%s:%s' "\${${inheritedKey}-}" "\${${configuredKey}-}" "\${${explicitKey}-}"`, {
					inheritEnv: false,
					env: { [explicitKey]: "explicit" },
				}),
			);

			// inheritEnv:false 时,进程环境和构造时的 shellEnv 都不生效,只剩本次显式传入的。
			expect(result.stdout).toBe("::explicit");
		} finally {
			if (previousInherited === undefined) delete process.env[inheritedKey];
			else process.env[inheritedKey] = previousInherited;
		}
	});

	it("streams stdout and stderr chunks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		let stdout = "";
		let stderr = "";
		const result = getOrThrow(
			await env.exec("printf out; printf err >&2", {
				onStdout: (chunk) => {
					stdout += chunk;
				},
				onStderr: (chunk) => {
					stderr += chunk;
				},
			}),
		);
		expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 0 });
		expect(stdout).toBe("out");
		expect(stderr).toBe("err");
	});

	it("reports a missing working directory before spawning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: join(root, "missing") });
		const result = await env.exec("printf ok");

		expect(result).toMatchObject({
			ok: false,
			error: { code: "spawn_error" },
		});
		if (!result.ok) expect(result.error.message).toContain("Working directory does not exist");
	});

	it("returns non-zero command exit codes as successful execution results", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		// 退出码非 0 不是"执行失败" —— 命令跑完了,码由调用方解读。
		const result = getOrThrow(await env.exec("exit 7"));
		expect(result).toEqual({ stdout: "", stderr: "", exitCode: 7 });
	});

	it("returns timeout errors for commands exceeding the timeout", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("sleep 5", { timeout: 0.01 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
	});

	it("rejects invalid timeouts without spawning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = await env.exec("printf ok", { timeout });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("timeout");
		}
	});

	it("returns callback errors from exec stream handlers", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("printf out", {
			onStdout: () => {
				throw new Error("callback failed");
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "callback_error", message: "callback failed" });
	});

	it("returns shell unavailable and spawn errors", async () => {
		const root = createTempDir();
		const missingShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
		const missingShell = await missingShellEnv.exec("printf ok");
		expect(missingShell.ok).toBe(false);
		if (!missingShell.ok) expect(missingShell.error).toMatchObject({ code: "shell_unavailable" });

		const shellPath = join(root, "not-executable-shell");
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile(shellPath, "not executable"));
		const spawnErrorEnv = new NodeExecutionEnv({ cwd: root, shellPath });
		const spawnError = await spawnErrorEnv.exec("printf ok");
		expect(spawnError.ok).toBe(false);
		if (!spawnError.ok) expect(spawnError.error).toMatchObject({ code: "spawn_error" });
	});

	it("returns an aborted result for aborted commands", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		const promise = env.exec("sleep 5", { abortSignal: controller.signal });
		controller.abort();
		const result = await promise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
	});

	it("returns an aborted result when the signal is already aborted", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("printf ok", { abortSignal: AbortSignal.abort() });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("aborted");
	});

	it("cleanup terminates active shell processes", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const execution = env.exec("touch started; sleep 60");
		for (let attempt = 0; attempt < 100 && !getOrThrow(await env.exists("started")); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(getOrThrow(await env.exists("started"))).toBe(true);
		await env.cleanup();
		// cleanup 杀的是整棵进程树;没被杀干净的话这里会卡到超时。
		await expect(withTimeout(execution, 3000)).resolves.toMatchObject({ ok: true });
	});

	it("kills the whole process tree, not just the shell", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		// 孙子进程持有一个 60 秒的 sleep;只杀 shell 的话它会活下来继续写 marker。
		const execution = env.exec("(sleep 0.2; touch grandchild-alive) & sleep 60", {
			abortSignal: controller.signal,
		});
		controller.abort();
		await execution;
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(getOrThrow(await env.exists("grandchild-alive"))).toBe(false);
	});
});

describe("executeShellWithCapture", () => {
	it("captures large shell output to a full output file through the execution env", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await executeShellWithCapture(env, "yes line | head -n 15000"));
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const fullOutput = getOrThrow(await env.readTextFile(result.fullOutputPath!));
		expect(fullOutput.split("\n").length).toBeGreaterThan(10000);
		// 给模型的是尾巴,必然短于全量。
		expect(result.output.length).toBeLessThan(fullOutput.length);
	});

	it("keeps short output untruncated and writes no full-output file", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await executeShellWithCapture(env, "printf 'a\\nb\\nc\\n'"));
		expect(result.truncated).toBe(false);
		expect(result.fullOutputPath).toBeUndefined();
		expect(result.output).toBe("a\nb\nc\n");
		expect(result.exitCode).toBe(0);
	});

	it("strips control characters from binary output", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await executeShellWithCapture(env, "printf 'a\\001b\\002c'"));
		expect(result.output).toBe("abc");
	});

	it("reports a cancelled capture without failing the Result", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		const promise = executeShellWithCapture(env, "sleep 60", { abortSignal: controller.signal });
		controller.abort();
		const result = getOrThrow(await promise);
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});

	it("returns execution errors inline when asked to", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: join(root, "missing") });
		const result = getOrThrow(await executeShellWithCapture(env, "printf ok", { returnExecutionErrors: true }));
		expect(result.executionError?.code).toBe("spawn_error");
		expect(result.cancelled).toBe(false);
	});
});
