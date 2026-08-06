/**
 * stm32config 工具。移植自 yoma packages/opencode/src/tool/stm32config.ts。
 *
 * 与 yoma 的差异:
 * - Effect Schema → TypeBox,Tool.define → my-pi 的 ToolDefinition。
 * - 子进程走 engines/ 层的 runEngine(argv 直接 spawn),路径解析走双布局 resolver。
 * - 去掉 ctx.ask 权限询问与 assertExternalDirectoryEffect(my-pi 暂无对应设施,
 *   权限由 ACP 客户端侧把关);configPath/out 仍解析到会话 cwd。
 * - 结果形态从 {title, metadata, output} 改为 AgentToolResult 的 content/details。
 *
 * 描述文本与 yoma stm32config.txt 逐字一致。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import {
	capEngineOutput,
	type EnginePathOptions,
	engineBin,
	engineDataDir,
	runEngine,
	stm32Families,
} from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const STM32CONFIG_COMMANDS = [
	"list-mcus",
	"describe-mcu",
	"candidates",
	"solve-clock",
	"validate",
	"generate",
	"schema",
] as const;

export type Stm32ConfigCommand = (typeof STM32CONFIG_COMMANDS)[number];

const stm32ConfigSchema = Type.Object({
	// 显式元组而非 STM32CONFIG_COMMANDS.map():数组会丢掉元组结构,Static 推导塌成 never。
	command: Type.Union(
		[
			Type.Literal("list-mcus"),
			Type.Literal("describe-mcu"),
			Type.Literal("candidates"),
			Type.Literal("solve-clock"),
			Type.Literal("validate"),
			Type.Literal("generate"),
			Type.Literal("schema"),
		],
		{
			description: "Kernel command: list-mcus | describe-mcu | candidates | solve-clock | validate | generate | schema",
		},
	),
	part: Type.Optional(Type.String({ description: 'Sales part number for describe-mcu, e.g. "STM32F405RGTx"' })),
	configPath: Type.Optional(
		Type.String({
			description: "Path to the JSON configuration document. Required for candidates, solve-clock, validate and generate.",
		}),
	),
	out: Type.Optional(Type.String({ description: "Output project directory for generate. Required for generate." })),
	peripheral: Type.Optional(
		Type.String({ description: 'Peripheral instance for candidates, e.g. "USART1". Required for candidates.' }),
	),
	signal: Type.Optional(Type.String({ description: 'Restrict candidates to one short signal name, e.g. "TX"' })),
	family: Type.Optional(Type.String({ description: 'list-mcus filter: only parts of this family, e.g. "STM32F4"' })),
	package: Type.Optional(
		Type.String({ description: 'list-mcus filter: only packages containing this text, e.g. "LQFP64"' }),
	),
	minFlashKb: Type.Optional(
		Type.Number({ description: "list-mcus filter: only parts with at least this much flash (KB)" }),
	),
});

export type Stm32ConfigToolInput = Static<typeof stm32ConfigSchema>;

export interface Stm32ConfigToolDetails {
	command: Stm32ConfigCommand;
	exitCode: number | null;
}

/**
 * 支持的族由数据目录生成,不写死 —— 见 engines.ts stm32Families() 的注释。
 * 引擎没装好时退回一句中性的话:构造工具不该因为这个抛异常,把整个 agent 拖垮。
 */
function describeCoverage(options?: Stm32ConfigToolOptions): string {
	try {
		const families = stm32Families(options);
		if (families.length === 0) return "no device data packs are installed — run `bun engines/build.ts`";
		return `covers ${families.length} families: ${families.join(", ")}`;
	} catch {
		return "device coverage unknown until the engines are built";
	}
}

const DESCRIPTION = (coverage: string) =>
	`Deterministic STM32 configuration kernel: validates a JSON configuration document describing the hardware setup (clock tree, peripherals, pins, DMA, NVIC, middleware) and generates a complete, compilable CMake + HAL driver project from it. This is how you produce driver code for supported chips — never hand-write peripheral init/register code when this tool covers the chip (${coverage}).

Part numbers: the db spells them with a wildcard package suffix (STM32G473RCTx), while schematics and BOMs carry the orderable code (STM32G473RCT6). They denote the same die — pass the db spelling, and if a part is not found, read the diagnostic's suggestion list rather than concluding the chip is unsupported.

Commands and their required parameters:
- list-mcus [family, package, minFlashKb]: enumerate supported parts
- describe-mcu (part): memory, pins/signals, IP instances, clock tree of one part
- schema: print the configuration-document field reference (all fields, types, defaults) — consult it before authoring a config
- candidates (configPath, peripheral, [signal]): list candidate pads for a peripheral's signals
- solve-clock (configPath): solve the clock tree for the config's frequency targets
- validate (configPath): full validation pipeline; returns diagnostics + summary
- generate (configPath, out): validate, then write the complete project; writes NOTHING when error diagnostics are present

Workflow: describe-mcu → author the config JSON with the write tool (start from the netlist tool's cfg_seed when you have one) → validate → fix every ERROR diagnostic → generate → compile with cmake. Diagnostics are {severity, code, path, message, suggestion} where path is a JSON Pointer into your config document — apply the suggestion at that path and re-run validate.

Rules:
- This is a native tool; the stm32kernel CLI is NOT on PATH — never invoke it (or "stm32config") through the bash tool.
- Keep configuration documents inside the working directory (e.g. board.json in the project root), never in /tmp; configPath and out resolve relative to the working directory.
- The kernel's output is authoritative. Do NOT edit generated files to change hardware behavior; edit the configuration document and re-run generate. Application code belongs only inside /* USER CODE BEGIN/END */ sections, which regeneration preserves.
- The same config + same kernel version always produces byte-identical output; treat the config document as the single source of truth and keep it in the project.
- Clock setup: either give frequency targets (clock.targets, then solve-clock) or pin the tree explicitly (clock.assignments, preferred when reproducing a known board design). Assignment keys follow CubeMX naming and unknown keys are silently ignored — copy them exactly. Example for STM32F4, HSE 8 MHz crystal → 168 MHz SYSCLK:
  "clock": { "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
             "assignments": { "SYSCLKSource": "RCC_SYSCLKSOURCE_PLLCLK", "PLLSourceVirtual": "RCC_PLLSOURCE_HSE",
                              "PLLM": 4, "PLLN": 168, "PLLP": "RCC_PLLP_DIV2", "PLLQ": 7,
                              "APB1CLKDivider": "RCC_HCLK_DIV4", "APB2CLKDivider": "RCC_HCLK_DIV2" } }
- Peripheral params use full HAL enum spellings (e.g. UART_STOPBITS_1, not STOPBITS_1). When a diagnostic offers a suggestion, apply it verbatim at the diagnostic's JSON Pointer path.
- Exit code 1 (error diagnostics) is a normal result: read the diagnostics, fix the config, iterate until 0 errors.`;

/** 纯 argv 构造,导出给测试。传入的路径必须已经是绝对路径。 */
export function buildStm32ConfigArgs(params: Stm32ConfigToolInput, dataDir: string, fwDir: string): string[] {
	const need = (field: "part" | "configPath" | "out" | "peripheral", flag: string) => {
		const value = params[field];
		if (!value) throw new Error(`stm32config ${params.command} requires ${field} (${flag})`);
		return value;
	};
	switch (params.command) {
		case "schema":
			return ["schema"];
		case "list-mcus": {
			const args = ["list-mcus", "--data-dir", dataDir, "--pretty"];
			if (params.family) args.push("--family", params.family);
			if (params.package) args.push("--package", params.package);
			if (params.minFlashKb !== undefined) args.push("--min-flash-kb", String(Math.trunc(params.minFlashKb)));
			return args;
		}
		case "describe-mcu":
			return ["describe-mcu", need("part", "<PART>"), "--data-dir", dataDir, "--pretty"];
		case "candidates": {
			const args = [
				"candidates",
				"--config",
				need("configPath", "--config"),
				"--peripheral",
				need("peripheral", "--peripheral"),
				"--data-dir",
				dataDir,
				"--pretty",
			];
			if (params.signal) args.push("--signal", params.signal);
			return args;
		}
		case "solve-clock":
			return ["solve-clock", "--config", need("configPath", "--config"), "--data-dir", dataDir, "--pretty"];
		case "validate":
			return ["validate", "--config", need("configPath", "--config"), "--data-dir", dataDir, "--pretty"];
		case "generate":
			return [
				"generate",
				"--config",
				need("configPath", "--config"),
				"--out",
				need("out", "--out"),
				"--fw-dir",
				fwDir,
				"--data-dir",
				dataDir,
				"--pretty",
			];
	}
}

/** 需要 config 文档的命令:exit 1 时给模型附上"修复后重跑"的指引。 */
const CONFIG_COMMANDS: readonly Stm32ConfigCommand[] = ["candidates", "solve-clock", "validate", "generate"];

export type Stm32ConfigToolOptions = EnginePathOptions;

export function createStm32ConfigToolDefinition(
	env: ExecutionEnv,
	options?: Stm32ConfigToolOptions,
): ToolDefinition<typeof stm32ConfigSchema, Stm32ConfigToolDetails> {
	return {
		name: "stm32config",
		label: "stm32config",
		description: DESCRIPTION(describeCoverage(options)),
		promptSnippet: "Validate STM32 config documents and generate driver projects",
		// No family names here. This line lands in the system prompt, which is
		// re-read every turn and outranks a tool description — the stale
		// "STM32F1/F4" that once sent a model off to hand-write registers for a
		// supported G473 lived in exactly this string. The tool's own
		// description carries the coverage list, generated from the data dir.
		promptGuidelines: [
			"For STM32 driver code, never hand-write peripheral init: author a config document, then stm32config validate → fix diagnostics → generate.",
			"stm32config describe-mcu is authoritative for a part's pads, signals and ADC channels — do not go to the datasheet for pin/signal mapping.",
		],
		parameters: stm32ConfigSchema,
		execute: async (_toolCallId, params, signal) => {
			const resolved: Stm32ConfigToolInput = {
				...params,
				configPath: params.configPath ? await resolveToCwd(env, params.configPath) : undefined,
				out: params.out ? await resolveToCwd(env, params.out) : undefined,
			};

			const kernel = engineBin("stm32kernel", options);
			const dataDir = engineDataDir("stm32", options);
			const args = buildStm32ConfigArgs(resolved, dataDir, path.join(dataDir, "fw"));

			const result = await runEngine(kernel, args, { cwd: env.cwd, signal });
			if (result.timedOut) throw new Error(`stm32kernel ${params.command} timed out`);
			if (result.aborted) throw new Error(`stm32kernel ${params.command} was aborted`);
			if (result.exitCode === 2 || (result.exitCode !== 0 && !result.stdout.trim())) {
				throw new Error(`stm32kernel ${params.command} failed (exit ${result.exitCode}): ${result.stderr}`);
			}

			// exit 1 = "有 ERROR 诊断":stdout 上的 JSON 就是修复回路,按正常结果返回。
			const notes: string[] = [];
			if (result.exitCode === 1 && CONFIG_COMMANDS.includes(params.command)) {
				notes.push(
					"Exit code 1: the configuration has ERROR diagnostics (nothing was generated). Fix the config document at each diagnostic's path, then re-run.",
				);
			}
			if (params.command === "generate" && result.exitCode === 0) {
				// The toolchain file path is relative to the generated tree, and
				// bash runs in the session cwd — without the `cd` the command
				// only works when `out` happens to be the working directory.
				notes.push(`Project generated at ${resolved.out}. Build it with:
  cd ${resolved.out} && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/gcc-arm-none-eabi.cmake -B build && cmake --build build`);
			}

			const stdout = capEngineOutput(
				result.stdout.trim(),
				params.command === "list-mcus"
					? "narrow it with family / package / minFlashKb"
					: "re-run with a narrower query, or read the written files directly",
			);
			const text = [stdout, ...notes].filter(Boolean).join("\n\n") || "(no output)";
			return {
				content: [{ type: "text", text }],
				details: { command: params.command, exitCode: result.exitCode },
			};
		},
	};
}

export function createStm32ConfigTool(env: ExecutionEnv, options?: Stm32ConfigToolOptions) {
	return wrapToolDefinition(createStm32ConfigToolDefinition(env, options));
}
