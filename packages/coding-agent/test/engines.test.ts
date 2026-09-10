/**
 * 引擎辅助(core/engines.ts)的验收:bin/data 布局的路径解析、runEngine 的
 * 进程契约(argv 不过 shell、超时/中断杀树、孙进程拖住管道时仍有界结算)、
 * 以及探针租约的冲突话术。
 *
 * 2026-09-10 工具归零:原先同文件里那批"引擎工具"的用例(stm32config / netlist /
 * flash)随工具一起搬到了 attic/test/engine-tools.test.ts,不再编译也不再跑。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	claimProbe,
	describeProbeConflict,
	describeProbeHardwareError,
	engineBin,
	engineDataDir,
	enginesDir,
	findEnginesDir,
	probeFailedHint,
	releaseProbe,
	runEngine,
} from "../src/index.ts";
import { ECHO_ARGV_JS, fakeExeName, writeFakeExe } from "./fixtures/fake-exe.ts";

const tempDirs: string[] = [];

beforeAll(() => {
	process.env.YOMA_PROBE_LOCK = join(tmpdir(), `yoma-probe-test-${process.pid}.lock`);
});

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-engines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	releaseProbe("flash");
	releaseProbe("gdb");
	releaseProbe("log");
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

/** 造一个 bin/data 布局的 engines 根;bins 里给出的假引擎(一段 JS,见 fixtures/fake-exe.ts)会写进 bin/。 */
function makeEnginesDir(bins: Record<string, string> = {}): string {
	const root = createTempDir();
	mkdirSync(join(root, "bin"), { recursive: true });
	for (const [name, js] of Object.entries(bins)) writeFakeExe(join(root, "bin"), name, js);
	mkdirSync(join(root, "data", "stm32", "fw"), { recursive: true });
	return root;
}

const ECHO_ARGS_KERNEL = ECHO_ARGV_JS;

/** 打一行就退出,但先起一个活 30 s、继承了 stdio 管道的孙进程(从前是 `sh -c "echo started; sleep 30 & exit 0"`)。 */
const GRANDCHILD_KEEPS_PIPES_JS = `
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
grandchild.unref();
console.log("started");
`;

/** 起一个活 30 s 的孙进程,自己也活 30 s(从前是 `sh -c "sleep 30 & sleep 30"`)。 */
const GRANDCHILD_THEN_SLEEP_JS = `
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
setTimeout(() => {}, 30000);
`;

describe("engine path resolution", () => {
	it("resolves binaries and data from the bin/data layout", () => {
		const root = makeEnginesDir({ stm32kernel: ECHO_ARGS_KERNEL });
		// Windows 上假引擎是 .cmd 启动器,engineBin 在 .exe 缺席时认它。
		expect(engineBin("stm32kernel", { enginesDir: root })).toBe(join(root, "bin", fakeExeName("stm32kernel")));
		expect(engineDataDir("stm32", { enginesDir: root })).toBe(join(root, "data", "stm32"));
	});

	it("reports a packaged-app reinstall hint when build.ts is absent", () => {
		const root = makeEnginesDir();
		expect(() => engineBin("stm32kernel", { enginesDir: root })).toThrow(/not found at/);
		expect(() => engineBin("stm32kernel", { enginesDir: root })).toThrow(/reinstall Yoma/);
	});

	it("reports npm run engines:build when this is a source checkout", () => {
		const root = makeEnginesDir();
		writeFileSync(join(root, "build.ts"), "");
		expect(() => engineBin("stm32kernel", { enginesDir: root })).toThrow(/npm run engines:build/);
	});

	it("skips empty engines/ shells that have no bin/", () => {
		const outer = createTempDir();
		const real = join(outer, "engines");
		mkdirSync(join(real, "bin"), { recursive: true });
		const nested = join(outer, "nested");
		mkdirSync(join(nested, "engines"), { recursive: true });
		expect(findEnginesDir(nested)).toBe(real);
	});

	it("default walk skips empty engines/ shells instead of returning them", () => {
		try {
			const dir = enginesDir();
			expect(dir.endsWith(`${sep}engines`)).toBe(true);
			expect(existsSync(join(dir, "bin"))).toBe(true);
		} catch (error) {
			expect((error as Error).message).toMatch(/Ignored empty engines/);
		}
	});
});

describe("runEngine", () => {
	it("captures stdout and stderr separately and reports the exit code", async () => {
		const result = await runEngine(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("passes argv without shell interpretation", async () => {
		const echo = writeFakeExe(createTempDir(), "echo", ECHO_ARGV_JS);
		const result = await runEngine(echo, ["a b", "$HOME", "; rm -rf /"]);
		expect(result.stdout.trim()).toBe("argv: a b $HOME ; rm -rf /");
	});

	it("pins PYTHONIOENCODING / PYTHONUTF8 for the engine process", async () => {
		// 用 process.execPath 起子进程,Windows 上也能跑。
		const prevIo = process.env.PYTHONIOENCODING;
		const prevUtf = process.env.PYTHONUTF8;
		delete process.env.PYTHONIOENCODING;
		delete process.env.PYTHONUTF8;
		try {
			const script = "console.log(process.env.PYTHONIOENCODING + ':' + process.env.PYTHONUTF8)";
			const result = await runEngine(process.execPath, ["-e", script]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("utf-8:1");

			// 调用方显式设过的不覆盖。
			process.env.PYTHONIOENCODING = "gbk";
			const overridden = await runEngine(process.execPath, ["-e", script]);
			expect(overridden.stdout.trim()).toBe("gbk:1");
		} finally {
			if (prevIo === undefined) delete process.env.PYTHONIOENCODING;
			else process.env.PYTHONIOENCODING = prevIo;
			if (prevUtf === undefined) delete process.env.PYTHONUTF8;
			else process.env.PYTHONUTF8 = prevUtf;
		}
	});

	it("kills the process on timeout", async () => {
		const start = Date.now();
		const result = await runEngine(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("kills the process on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await runEngine(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal });
		expect(result.aborted).toBe(true);
	});

	it("rejects when the binary does not exist", async () => {
		await expect(runEngine("/no/such/binary", [])).rejects.toThrow(/failed to run/);
	});

	it("settles after exit even when a grandchild keeps the stdio pipes open", async () => {
		// 父进程立刻退出,但它起的孙进程继承了管道 —— 'close' 被拖住,必须靠 exit+宽限兜底。
		const parent = writeFakeExe(createTempDir(), "parent", GRANDCHILD_KEEPS_PIPES_JS);
		const start = Date.now();
		const result = await runEngine(parent, []);
		expect(result.stdout).toContain("started");
		expect(result.exitCode).toBe(0);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("bounds the timeout even when a grandchild survives the kill", async () => {
		const parent = writeFakeExe(createTempDir(), "parent", GRANDCHILD_THEN_SLEEP_JS);
		const start = Date.now();
		const result = await runEngine(parent, [], { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(8000);
	});
});

describe("probe lease", () => {
	it("in-process conflict names the holder and how to release it", () => {
		expect(claimProbe("flash", "openocd")).toBeUndefined();
		const holder = claimProbe("gdb", "openocd on STM32G431CB");
		expect(holder?.owner).toBe("flash");
		// flash 是一次性调用,冲突话术不能指一条不存在的 stop 路。
		expect(describeProbeConflict(holder!)).toContain("wait for that command to finish");
		releaseProbe("flash");
		expect(claimProbe("gdb", "openocd on STM32G431CB")).toBeUndefined();
		const fromFlash = claimProbe("flash", "openocd");
		expect(fromFlash?.owner).toBe("gdb");
		expect(describeProbeConflict(fromFlash!)).toContain('run `gdb` action:"stop" first');
		releaseProbe("gdb");
	});

	it("classifies exclusive access as occupied, not missing hardware", () => {
		const hint = describeProbeHardwareError("Error: exclusive access (0xe00002c5)");
		expect(hint).toContain("already in use");
		expect(hint).toContain("NOT a disconnected board");
		expect(probeFailedHint("Error: exclusive access (0xe00002c5)")).toContain("already in use");
		expect(probeFailedHint("Error: exclusive access (0xe00002c5)")).not.toContain("connect an ST-Link");
		expect(probeFailedHint("Error: no probe found")).toContain("another program is using the probe");
		expect(probeFailedHint("Error: no probe found")).toContain("connect an ST-Link");
	});
});
