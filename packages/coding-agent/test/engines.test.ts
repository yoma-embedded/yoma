import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import {
	buildFlashArgs,
	buildStm32ConfigArgs,
	createFlashToolDefinition,
	createNetlistToolDefinition,
	createStm32ConfigToolDefinition,
	engineBin,
	engineDataDir,
	enginesDir,
	runEngine,
	sanitizeStem,
} from "../src/index.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-engines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

/** 造一个 bin/data 布局的 engines 根;bins 里给出的假二进制会写进 bin/。 */
function makeEnginesDir(bins: Record<string, string> = {}): string {
	const root = createTempDir();
	mkdirSync(join(root, "bin"), { recursive: true });
	for (const [name, script] of Object.entries(bins)) {
		const binPath = join(root, "bin", name);
		writeFileSync(binPath, script);
		chmodSync(binPath, 0o755);
	}
	mkdirSync(join(root, "data", "stm32", "fw"), { recursive: true });
	return root;
}

const ECHO_ARGS_KERNEL = `#!/bin/sh
echo "argv: $@"
`;

describe("engine path resolution", () => {
	it("resolves binaries and data from the bin/data layout", () => {
		const root = makeEnginesDir({ stm32kernel: ECHO_ARGS_KERNEL });
		expect(engineBin("stm32kernel", { enginesDir: root })).toBe(join(root, "bin", "stm32kernel"));
		expect(engineDataDir("stm32", { enginesDir: root })).toBe(join(root, "data", "stm32"));
	});

	it("reports the missing path and the fix when a binary is absent", () => {
		const root = makeEnginesDir();
		expect(() => engineBin("stm32kernel", { enginesDir: root })).toThrow(/not found at/);
		expect(() => engineBin("stm32kernel", { enginesDir: root })).toThrow(/bun engines\/build\.ts/);
	});

	it("defaults to the repo's engines/ directory", () => {
		expect(enginesDir().endsWith(`${sep}engines`)).toBe(true);
	});
});

describe("runEngine", () => {
	it("captures stdout and stderr separately and reports the exit code", async () => {
		const result = await runEngine("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"]);
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("passes argv without shell interpretation", async () => {
		const result = await runEngine("/bin/echo", ["a b", "$HOME", "; rm -rf /"]);
		expect(result.stdout.trim()).toBe("a b $HOME ; rm -rf /");
	});

	it("kills the process on timeout", async () => {
		const start = Date.now();
		const result = await runEngine("/bin/sh", ["-c", "sleep 30"], { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("kills the process on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await runEngine("/bin/sh", ["-c", "sleep 30"], { signal: controller.signal });
		expect(result.aborted).toBe(true);
	});

	it("rejects when the binary does not exist", async () => {
		await expect(runEngine("/no/such/binary", [])).rejects.toThrow(/failed to run/);
	});

	it("settles after exit even when a grandchild keeps the stdio pipes open", async () => {
		// sh 立刻退出,但后台 sleep 继承了管道 —— 'close' 被拖住,必须靠 exit+宽限兜底。
		const start = Date.now();
		const result = await runEngine("/bin/sh", ["-c", "echo started; sleep 30 & exit 0"]);
		expect(result.stdout).toContain("started");
		expect(result.exitCode).toBe(0);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("bounds the timeout even when a grandchild survives the kill", async () => {
		const start = Date.now();
		const result = await runEngine("/bin/sh", ["-c", "sleep 30 & sleep 30"], { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(8000);
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

	it("throws when a required field is missing", () => {
		expect(() => buildStm32ConfigArgs({ command: "describe-mcu" }, dataDir, fwDir)).toThrow(
			/describe-mcu requires part/,
		);
		expect(() => buildStm32ConfigArgs({ command: "validate" }, dataDir, fwDir)).toThrow(/validate requires configPath/);
		expect(() => buildStm32ConfigArgs({ command: "candidates", configPath: "/w/b.json" }, dataDir, fwDir)).toThrow(
			/candidates requires peripheral/,
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
		const { tool } = makeTool(`#!/bin/sh\necho '{"diagnostics":[{"severity":"error"}]}'\nexit 1\n`);
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
		const { tool } = makeTool(`#!/bin/sh\necho "boom" 1>&2\nexit 2\n`);
		await expect(tool.execute("c1", { command: "list-mcus" })).rejects.toThrow(/failed \(exit 2\): boom/);
	});

	it("throws on exit 2 even when the kernel printed JSON to stdout", async () => {
		// 真内核的 usage/内部错误正是这个形态:stdout 上有 {"error":...},exit 2 —— 必须抛,
		// 不能当 exit 1 那样的诊断回路返回给模型。
		const { tool } = makeTool(`#!/bin/sh\necho '{"error":"usage"}'\necho "usage" 1>&2\nexit 2\n`);
		await expect(tool.execute("c1", { command: "list-mcus" })).rejects.toThrow(/failed \(exit 2\)/);
	});

	it("throws on a non-zero exit with empty stdout", async () => {
		const { tool } = makeTool(`#!/bin/sh\necho "panic" 1>&2\nexit 101\n`);
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
	const ECHO_CONTROLLER_MAP = `#!/bin/sh
echo "detected U2 (confidence high)" 1>&2
echo "argv: $@"
`;
	// 假 board_ir:抓出 --out-dir/--stem,写下三个产物文件。argv 打到 stderr ——
	// board_ir 分支按设计丢弃 stdout,只有 stderr 会以 [detection] 透出。
	const FAKE_BOARD_IR = `#!/bin/sh
ALL="$@"
OUT=""; STEM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT="$2"; shift 2 ;;
    --stem) STEM="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo '{"map":1}' > "$OUT/\${STEM}_stm32_map.json"
echo '{"seed":2}' > "$OUT/\${STEM}_cfg_seed.json"
echo '{"ir":3}' > "$OUT/\${STEM}_board_ir.json"
echo "argv: $ALL" 1>&2
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
		const { tool, cwd } = makeTools({ controller_map: `#!/bin/sh\necho "parse error" 1>&2\nexit 3\n` });
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
		expect(text).toContain(`Board IR files written to ${join(cwd, ".my-pi")}`);
		expect(text).toContain('[stm32_map] peripheral suggestions with evidence/confidence:\n{"map":1}');
		expect(text).toContain('[cfg_seed] starter stm32config document (extend it, then validate):\n{"seed":2}');
		expect(result.details.mode).toBe("board_ir");
		expect(result.details.files?.cfgSeed).toBe(join(cwd, ".my-pi", "odrive_cfg_seed.json"));
		expect(existsSync(join(cwd, ".my-pi", "odrive_board_ir.json"))).toBe(true);
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
			board_ir: `#!/bin/sh\necho "unknown part" 1>&2\nexit 7\n`,
			stm32kernel: ECHO_ARGS_KERNEL,
		});
		writeFileSync(join(cwd, "b.NET"), "x");
		await expect(tool.execute("c1", { netlistPath: "b.NET", part: "NOPE" })).rejects.toThrow(
			/board_ir failed \(exit 7\): unknown part/,
		);
	});
});

describe("flash buildArgs", () => {
	it("builds list and info argv", () => {
		expect(buildFlashArgs({ action: "list" })).toEqual(["list"]);
		expect(buildFlashArgs({ action: "info", probe: "0483:374B" })).toEqual(["info", "--probe", "0483:374B"]);
	});

	it("builds erase and reset argv with the chip", () => {
		expect(buildFlashArgs({ action: "erase", chip: "STM32F405RG" })).toEqual(["erase", "--chip", "STM32F405RG"]);
		expect(buildFlashArgs({ action: "reset", chip: "STM32F405RG" })).toEqual(["reset", "--chip", "STM32F405RG"]);
	});

	it("defaults download format from the extension", () => {
		expect(buildFlashArgs({ action: "download", chip: "C", firmwarePath: "/w/fw.elf" })).toEqual([
			"download",
			"--chip",
			"C",
			"/w/fw.elf",
		]);
		expect(buildFlashArgs({ action: "download", chip: "C", firmwarePath: "/w/fw.hex" })).toEqual([
			"download",
			"--chip",
			"C",
			"--binary-format",
			"hex",
			"/w/fw.hex",
		]);
		expect(buildFlashArgs({ action: "download", chip: "C", firmwarePath: "/w/fw.bin" })).toEqual([
			"download",
			"--chip",
			"C",
			"--binary-format",
			"bin",
			"--base-address",
			"0x08000000",
			"/w/fw.bin",
		]);
	});

	it("lets an explicit format override the extension inference", () => {
		// format:"elf" 压过 .bin 扩展名 → 不加 --binary-format/--base-address。
		expect(buildFlashArgs({ action: "download", chip: "C", firmwarePath: "/w/fw.bin", format: "elf" })).toEqual([
			"download",
			"--chip",
			"C",
			"/w/fw.bin",
		]);
		expect(buildFlashArgs({ action: "download", chip: "C", firmwarePath: "/w/fw.dat", format: "hex" })).toEqual([
			"download",
			"--chip",
			"C",
			"--binary-format",
			"hex",
			"/w/fw.dat",
		]);
	});

	it("honors baseAddress and verify", () => {
		expect(
			buildFlashArgs({
				action: "download",
				chip: "C",
				firmwarePath: "/w/fw.bin",
				baseAddress: "0x08004000",
				verify: true,
			}),
		).toEqual([
			"download",
			"--chip",
			"C",
			"--binary-format",
			"bin",
			"--base-address",
			"0x08004000",
			"--verify",
			"/w/fw.bin",
		]);
	});

	it("throws when required fields are missing", () => {
		expect(() => buildFlashArgs({ action: "erase" })).toThrow(/erase requires chip/);
		expect(() => buildFlashArgs({ action: "download", chip: "C" })).toThrow(/download requires firmwarePath/);
	});
});

describe("flash tool", () => {
	const ECHO_PROBE_RS = `#!/bin/sh
echo "argv: $@"
`;

	function makeTool(script: string) {
		const enginesRoot = makeEnginesDir({ "probe-rs": script });
		const cwd = createTempDir();
		const env = new NodeExecutionEnv({ cwd });
		return { tool: createFlashToolDefinition(env, { enginesDir: enginesRoot }), cwd };
	}

	it("runs list and returns the output", async () => {
		const { tool } = makeTool(ECHO_PROBE_RS);
		const result = await tool.execute("c1", { action: "list" });
		expect(textOf(result)).toBe("argv: list");
		expect(result.details).toEqual({ action: "list", chip: undefined, exitCode: 0 });
	});

	it("returns a non-zero exit as a normal result with probe guidance, not an error", async () => {
		const { tool } = makeTool(`#!/bin/sh\necho "Error: no probe found" 1>&2\nexit 1\n`);
		const result = await tool.execute("c1", { action: "info" });
		const text = textOf(result);
		expect(text).toContain("probe-rs info failed (exit 1)");
		expect(text).toContain("Error: no probe found");
		expect(text).toContain("connect an ST-Link/J-Link/CMSIS-DAP probe");
		expect(result.details.exitCode).toBe(1);
	});

	it("resolves the firmware path against the cwd and passes bin flags", async () => {
		const { tool, cwd } = makeTool(ECHO_PROBE_RS);
		writeFileSync(join(cwd, "fw.bin"), "fw");
		const result = await tool.execute("c1", { action: "download", chip: "STM32F405RG", firmwarePath: "fw.bin" });
		expect(textOf(result)).toBe(
			`argv: download --chip STM32F405RG --binary-format bin --base-address 0x08000000 ${join(cwd, "fw.bin")}`,
		);
	});

	it("throws when the firmware file is missing", async () => {
		const { tool } = makeTool(ECHO_PROBE_RS);
		await expect(tool.execute("c1", { action: "download", chip: "C", firmwarePath: "nope.elf" })).rejects.toThrow(
			/firmware file not found/,
		);
	});
});
