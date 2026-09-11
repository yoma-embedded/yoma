/**
 * 引擎工具(stm32config / netlist / flash)的退役用例 —— 2026-09-10 工具归零时
 * 从 test/engines.test.ts 拆出来。不编译、不跑,重写这三个工具时当需求清单读。
 * 引擎辅助本身的用例仍在 test/engines.test.ts。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { claimProbe, engineBin, releaseProbe, runEngine } from "../../src/core/engines.ts";
import { createFlashToolDefinition } from "../tools/flash.ts";
import { createNetlistToolDefinition, sanitizeStem } from "../tools/netlist.ts";
import { buildStm32ConfigArgs, createStm32ConfigToolDefinition } from "../tools/stm32config.ts";
import { ECHO_ARGV_JS, fakeExeName, writeFakeExe } from "../../test/fixtures/fake-exe.ts";

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

/** 造一个独立的假烧录器 —— flash 不再走 enginesDir,命令由模型自带。 */
function fakeFlasher(js: string): string {
	return writeFakeExe(createTempDir(), "flasher", js);
}

// 四个引擎调用点的"超时/中断"话术从前是各抄两行,现在共用 assertEngineSettled ——
// 而 label 是模型看得见的诊断串,合并之前**没有任何测试钉住它**,只能靠人眼逐字对。
// 这一组就是那道缺失的闸门:抢先 abort 一个已经 aborted 的 signal,让 runEngine 走
// aborted 分支,断言每个调用点报的是自己的名字。
describe("engine settle labels", () => {
	const aborted = () => AbortSignal.abort();

	it("netlist controller_map / board_ir 各报自己的名字", async () => {
		const enginesRoot = makeEnginesDir({ controller_map: ECHO_ARGS_KERNEL, board_ir: ECHO_ARGS_KERNEL, stm32kernel: ECHO_ARGS_KERNEL });
		const cwd = createTempDir();
		const tool = createNetlistToolDefinition(new NodeExecutionEnv({ cwd }), { enginesDir: enginesRoot });
		writeFileSync(join(cwd, "board.NET"), "netlist content");

		await expect(tool.execute("c1", { netlistPath: "board.NET" }, aborted())).rejects.toThrow(
			"controller_map was aborted",
		);
		await expect(tool.execute("c2", { netlistPath: "board.NET", part: "STM32F405RGTx" }, aborted())).rejects.toThrow(
			"board_ir was aborted",
		);
	});

	it("stm32config 的 label 带上具体命令", async () => {
		const enginesRoot = makeEnginesDir({ stm32kernel: ECHO_ARGS_KERNEL });
		const tool = createStm32ConfigToolDefinition(new NodeExecutionEnv({ cwd: createTempDir() }), {
			enginesDir: enginesRoot,
		});
		await expect(tool.execute("c1", { command: "list-mcus" }, aborted())).rejects.toThrow(
			"stm32kernel list-mcus was aborted",
		);
	});

	it("flash 中断时抛 aborted,而且照样把探针租约还回去", async () => {
		const flasher = fakeFlasher(ECHO_ARGS_KERNEL);
		const tool = createFlashToolDefinition(new NodeExecutionEnv({ cwd: createTempDir() }));
		await expect(tool.execute("c1", { command: [flasher, "info"] }, aborted())).rejects.toThrow("was aborted");
		// 租约在 finally 里放,所以下一次还能拿到(拿不到会报 probe is held by)。
		await expect(tool.execute("c2", { command: [flasher, "info"] }, aborted())).rejects.toThrow("was aborted");
	});
});

describe("stm32config buildArgs", () => {
	const dataDir = "/data";
	const fwDir = "/data/fw";

	it("builds schema argv with no data dir", () => {
		expect(buildStm32ConfigArgs({ command: "schema" }, dataDir, fwDir)).toEqual(["schema"]);
	});

	it("builds list-mcus argv with filters", () => {
		expect(
			buildStm32ConfigArgs({ command: "list-mcus", family: "STM32F4", package: "LQFP64", minFlashKb: 512.9 }, dataDir, fwDir),
		).toEqual([
			"list-mcus",
			"--data-dir",
			dataDir,
			"--pretty",
			"--family",
			"STM32F4",
			"--package",
			"LQFP64",
			"--min-flash-kb",
			"512",
		]);
	});

	it("builds describe-mcu argv with part as a positional argument", () => {
		expect(buildStm32ConfigArgs({ command: "describe-mcu", part: "STM32F405RGTx" }, dataDir, fwDir)).toEqual([
			"describe-mcu",
			"STM32F405RGTx",
			"--data-dir",
			dataDir,
			"--pretty",
		]);
	});

	it("builds solve-clock argv", () => {
		expect(buildStm32ConfigArgs({ command: "solve-clock", configPath: "/w/board.json" }, dataDir, fwDir)).toEqual([
			"solve-clock",
			"--config",
			"/w/board.json",
			"--data-dir",
			dataDir,
			"--pretty",
		]);
	});

	it("builds generate argv with config, out and fw dir", () => {
		expect(
			buildStm32ConfigArgs({ command: "generate", configPath: "/w/board.json", out: "/w/fw" }, dataDir, fwDir),
		).toEqual([
			"generate",
			"--config",
			"/w/board.json",
			"--out",
			"/w/fw",
			"--fw-dir",
			fwDir,
			"--data-dir",
			dataDir,
			"--pretty",
		]);
	});

	it("builds candidates argv with the optional signal", () => {
		expect(
			buildStm32ConfigArgs(
				{ command: "candidates", configPath: "/w/board.json", peripheral: "USART1", signal: "TX" },
				dataDir,
				fwDir,
			),
		).toEqual([
			"candidates",
			"--config",
			"/w/board.json",
			"--peripheral",
			"USART1",
			"--data-dir",
			dataDir,
			"--pretty",
			"--signal",
			"TX",
		]);
	});

	it("builds candidates argv from part when no configPath is given", () => {
		expect(
			buildStm32ConfigArgs(
				{ command: "candidates", part: "STM32F103C8Tx", peripheral: "ADC1", signal: "IN2" },
				dataDir,
				fwDir,
			),
		).toEqual([
			"candidates",
			"--part",
			"STM32F103C8Tx",
			"--peripheral",
			"ADC1",
			"--data-dir",
			dataDir,
			"--pretty",
			"--signal",
			"IN2",
		]);
		// configPath wins when both are given.
		expect(
			buildStm32ConfigArgs(
				{ command: "candidates", configPath: "/w/b.json", part: "STM32F103C8Tx", peripheral: "ADC1" },
				dataDir,
				fwDir,
			).slice(0, 3),
		).toEqual(["candidates", "--config", "/w/b.json"]);
	});

	it("throws when a required field is missing", () => {
		expect(() => buildStm32ConfigArgs({ command: "describe-mcu" }, dataDir, fwDir)).toThrow(
			/describe-mcu requires part/,
		);
		expect(() => buildStm32ConfigArgs({ command: "validate" }, dataDir, fwDir)).toThrow(/validate requires configPath/);
		expect(() => buildStm32ConfigArgs({ command: "candidates", configPath: "/w/b.json" }, dataDir, fwDir)).toThrow(
			/candidates requires peripheral/,
		);
		expect(() => buildStm32ConfigArgs({ command: "candidates", peripheral: "ADC1" }, dataDir, fwDir)).toThrow(
			/candidates requires configPath or part/,
		);
		expect(() => buildStm32ConfigArgs({ command: "generate", configPath: "/w/b.json" }, dataDir, fwDir)).toThrow(
			/generate requires out/,
		);
	});
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

describe("stm32config tool", () => {
	function makeTool(kernelScript: string) {
		const enginesRoot = makeEnginesDir({ stm32kernel: kernelScript });
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		return { tool: createStm32ConfigToolDefinition(env, { enginesDir: enginesRoot }), cwd };
	}

	it("runs the kernel and returns its stdout", async () => {
		const { tool } = makeTool(ECHO_ARGS_KERNEL);
		const result = await tool.execute("c1", { command: "list-mcus" });
		expect(textOf(result)).toContain("argv: list-mcus --data-dir");
		expect(result.details).toEqual({ command: "list-mcus", exitCode: 0 });
	});

	it("resolves configPath against the session cwd", async () => {
		const { tool, cwd } = makeTool(ECHO_ARGS_KERNEL);
		const result = await tool.execute("c1", { command: "validate", configPath: "board.json" });
		expect(textOf(result)).toContain(join(cwd, "board.json"));
	});

	it("treats exit 1 on config commands as a normal result with fix-it guidance", async () => {
		const { tool } = makeTool(`console.log('{"diagnostics":[{"severity":"error"}]}'); process.exitCode = 1;`);
		const result = await tool.execute("c1", { command: "validate", configPath: "board.json" });
		expect(textOf(result)).toContain('"diagnostics"');
		expect(textOf(result)).toContain("Exit code 1: the configuration has ERROR diagnostics");
		expect(result.details.exitCode).toBe(1);
	});

	it("appends build instructions after a successful generate", async () => {
		const { tool, cwd } = makeTool(ECHO_ARGS_KERNEL);
		const result = await tool.execute("c1", { command: "generate", configPath: "board.json", out: "fw" });
		expect(textOf(result)).toContain(`Project generated at ${join(cwd, "fw")}`);
		expect(textOf(result)).toContain("cmake --build build");
	});

	it("throws on exit 2 with stderr in the message", async () => {
		const { tool } = makeTool(`console.error("boom"); process.exitCode = 2;`);
		await expect(tool.execute("c1", { command: "list-mcus" })).rejects.toThrow(/failed \(exit 2\): boom/);
	});

	it("throws on exit 2 even when the kernel printed JSON to stdout", async () => {
		// 真内核的 usage/内部错误正是这个形态:stdout 上有 {"error":...},exit 2 —— 必须抛,
		// 不能当 exit 1 那样的诊断回路返回给模型。
		const { tool } = makeTool(`console.log('{"error":"usage"}'); console.error("usage"); process.exitCode = 2;`);
		await expect(tool.execute("c1", { command: "list-mcus" })).rejects.toThrow(/failed \(exit 2\)/);
	});

	it("throws on a non-zero exit with empty stdout", async () => {
		const { tool } = makeTool(`console.error("panic"); process.exitCode = 101;`);
		await expect(tool.execute("c1", { command: "list-mcus" })).rejects.toThrow(/failed \(exit 101\): panic/);
	});
});

describe("netlist sanitizeStem", () => {
	it("strips the extension and replaces unsafe characters", () => {
		expect(sanitizeStem("/w/odrive_two_ax.NET")).toBe("odrive_two_ax");
		expect(sanitizeStem("my board (rev2).NET")).toBe("my_board_rev2_");
		expect(sanitizeStem(".NET")).toBe("board");
	});
});

describe("netlist tool", () => {
	const ECHO_CONTROLLER_MAP = `
console.error("detected U2 (confidence high)");
${ECHO_ARGV_JS}`;
	// 假 board_ir:抓出 --out-dir/--stem,写下三个产物文件。argv 打到 stderr ——
	// board_ir 分支按设计丢弃 stdout,只有 stderr 会以 [detection] 透出。
	const FAKE_BOARD_IR = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out-dir") + 1];
const stem = args[args.indexOf("--stem") + 1];
writeFileSync(join(out, stem + "_stm32_map.json"), '{"map":1}');
writeFileSync(join(out, stem + "_cfg_seed.json"), '{"seed":2}');
writeFileSync(join(out, stem + "_board_ir.json"), '{"ir":3}');
console.error("argv: " + args.join(" "));
`;

	function makeTools(bins: Record<string, string>) {
		const enginesRoot = makeEnginesDir(bins);
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		return { tool: createNetlistToolDefinition(env, { enginesDir: enginesRoot }), cwd };
	}

	it("runs controller_map without part and prefixes detection notes", async () => {
		const { tool, cwd } = makeTools({ controller_map: ECHO_CONTROLLER_MAP });
		writeFileSync(join(cwd, "board.NET"), "netlist content");
		const result = await tool.execute("c1", { netlistPath: "board.NET" });
		const text = textOf(result);
		expect(text).toContain("[detection]\ndetected U2 (confidence high)");
		expect(text).toContain(`argv: ${join(cwd, "board.NET")}`);
		expect(result.details).toEqual({ mode: "map" });
	});

	it("passes mainController through to controller_map", async () => {
		const { tool, cwd } = makeTools({ controller_map: ECHO_CONTROLLER_MAP });
		writeFileSync(join(cwd, "board.NET"), "x");
		const result = await tool.execute("c1", { netlistPath: "board.NET", mainController: "U2" });
		expect(textOf(result)).toContain("--main-controller U2");
	});

	it("throws when the netlist file is missing", async () => {
		const { tool } = makeTools({ controller_map: ECHO_CONTROLLER_MAP });
		await expect(tool.execute("c1", { netlistPath: "nope.NET" })).rejects.toThrow(/netlist file not found/);
	});

	it("throws when controller_map exits non-zero", async () => {
		const { tool, cwd } = makeTools({ controller_map: `console.error("parse error"); process.exitCode = 3;` });
		writeFileSync(join(cwd, "board.NET"), "x");
		await expect(tool.execute("c1", { netlistPath: "board.NET" })).rejects.toThrow(
			/controller_map failed \(exit 3\): parse error/,
		);
	});

	it("runs board_ir with part, inlines stm32_map and cfg_seed, and reports the files", async () => {
		const { tool, cwd } = makeTools({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGS_KERNEL });
		writeFileSync(join(cwd, "odrive.NET"), "x");
		const result = await tool.execute("c1", { netlistPath: "odrive.NET", part: "STM32F405RGTx" });
		const text = textOf(result);
		expect(text).toContain("[detection]");
		expect(text).toContain("--part STM32F405RGTx");
		// board_ir 必须拿到内核与数据目录,否则外设建议无从谈起。
		expect(text).toContain("--stm32kernel ");
		expect(text).toContain("--data-dir ");
		expect(text).toContain(`Board IR files written to ${join(cwd, ".yoma")}`);
		expect(text).toContain('[stm32_map] peripheral suggestions with evidence/confidence:\n{"map":1}');
		expect(text).toContain('[cfg_seed] starter stm32config document (extend it, then validate):\n{"seed":2}');
		expect(result.details.mode).toBe("board_ir");
		expect(result.details.files?.cfgSeed).toBe(join(cwd, ".yoma", "odrive_cfg_seed.json"));
		expect(existsSync(join(cwd, ".yoma", "odrive_board_ir.json"))).toBe(true);
	});

	it("honors a custom outDir and passes mainController through to board_ir", async () => {
		const { tool, cwd } = makeTools({ board_ir: FAKE_BOARD_IR, stm32kernel: ECHO_ARGS_KERNEL });
		writeFileSync(join(cwd, "b.NET"), "x");
		const result = await tool.execute("c1", {
			netlistPath: "b.NET",
			part: "STM32F103C8Tx",
			outDir: "ir-out",
			mainController: "U2",
		});
		expect(textOf(result)).toContain(`Board IR files written to ${join(cwd, "ir-out")}`);
		expect(textOf(result)).toContain("--main-controller U2");
		expect(existsSync(join(cwd, "ir-out", "b_stm32_map.json"))).toBe(true);
	});

	it("throws when board_ir exits non-zero", async () => {
		const { tool, cwd } = makeTools({
			board_ir: `console.error("unknown part"); process.exitCode = 7;`,
			stm32kernel: ECHO_ARGS_KERNEL,
		});
		writeFileSync(join(cwd, "b.NET"), "x");
		await expect(tool.execute("c1", { netlistPath: "b.NET", part: "NOPE" })).rejects.toThrow(
			/board_ir failed \(exit 7\): unknown part/,
		);
	});
});

describe("flash tool", () => {
	const ECHO_FLASHER = ECHO_ARGV_JS;

	function makeTool(script: string) {
		const flasher = fakeFlasher(script);
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		return { tool: createFlashToolDefinition(env), cwd, flasher };
	}

	it("runs the given argv and returns the output", async () => {
		const { tool, flasher } = makeTool(ECHO_FLASHER);
		const result = await tool.execute("c1", { command: [flasher, "program", "fw.elf"] });
		expect(textOf(result)).toBe("argv: program fw.elf");
		expect(result.details).toEqual({ command: [flasher, "program", "fw.elf"], exitCode: 0 });
	});

	it("returns a non-zero exit as a normal result with probe guidance, not an error", async () => {
		const { tool, flasher } = makeTool(`console.error("Error: no probe found"); process.exitCode = 1;`);
		const result = await tool.execute("c1", { command: [flasher, "program"] });
		const text = textOf(result);
		expect(text).toContain("failed (exit 1)");
		expect(text).toContain("Error: no probe found");
		expect(text).toContain("connect an ST-Link/J-Link/CMSIS-DAP probe");
		expect(text).toContain("another program is using the probe");
		expect(result.details.exitCode).toBe(1);
	});

	it("says the probe is occupied on exclusive access, not a missing board", async () => {
		const { tool, flasher } = makeTool(
			`console.error("Error: Attaching to probe failed: exclusive access (0xe00002c5)"); process.exitCode = 1;`,
		);
		const result = await tool.execute("c1", { command: [flasher, "program"] });
		const text = textOf(result);
		expect(text).toContain("already in use");
		expect(text).toContain("NOT a disconnected board");
		expect(text).not.toMatch(/If no debug probe was found/);
	});

	it("records elfPath into flash-state.json on success, resolved against the cwd", async () => {
		const { tool, cwd, flasher } = makeTool(ECHO_FLASHER);
		writeFileSync(join(cwd, "fw.elf"), "fw");
		const result = await tool.execute("c1", { command: [flasher, "program"], elfPath: "fw.elf" });
		expect(result.details.recordedElf).toBe(join(cwd, "fw.elf"));
		expect(textOf(result)).toContain("gdb start will verify against it");
		const state = JSON.parse(readFileSync(join(cwd, ".yoma", "flash-state.json"), "utf8"));
		expect(state.elfPath).toBe(join(cwd, "fw.elf"));
		expect(typeof state.sha256).toBe("string");
	});

	it("does not record on failure, and rejects a missing elfPath up front", async () => {
		const { tool, cwd, flasher } = makeTool(`process.exitCode = 1;`);
		writeFileSync(join(cwd, "fw.elf"), "fw");
		const failed = await tool.execute("c1", { command: [flasher, "program"], elfPath: "fw.elf" });
		expect(failed.details.recordedElf).toBeUndefined();
		expect(existsSync(join(cwd, ".yoma", "flash-state.json"))).toBe(false);
		await expect(tool.execute("c2", { command: [flasher, "program"], elfPath: "nope.elf" })).rejects.toThrow(
			/elfPath not found/,
		);
	});

	it("rejects an empty command instead of spawning nothing", async () => {
		const { tool } = makeTool(ECHO_FLASHER);
		await expect(tool.execute("c1", { command: [] })).rejects.toThrow(/requires command/);
	});
});
