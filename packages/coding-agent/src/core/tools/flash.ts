/**
 * flash 工具。移植自 yoma packages/opencode/src/tool/flash.ts。
 *
 * 与 yoma 的差异(同 stm32config):Effect → ToolDefinition,子进程走 runEngine,
 * 去掉 ctx.ask / assertExternalDirectoryEffect。
 *
 * 错误分类学与其他引擎工具不同:probe-rs 非零退出**不抛错**,而是把输出连同
 * "检查探针连接"的指引当正常结果返回 —— 没插探针是常态而非异常,模型要读到
 * 提示才知道让用户接硬件。只有超时/中断才抛。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import { type EnginePathOptions, engineBin, runEngine } from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const FLASH_ACTIONS = ["list", "info", "download", "erase", "reset"] as const;

export type FlashAction = (typeof FLASH_ACTIONS)[number];

const flashSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
	action: Type.Union(
		[Type.Literal("list"), Type.Literal("info"), Type.Literal("download"), Type.Literal("erase"), Type.Literal("reset")],
		{ description: "probe-rs action: list | info | download | erase | reset" },
	),
	chip: Type.Optional(
		Type.String({
			description: 'Target chip name from the probe-rs registry, e.g. "STM32F405RG". Required for download/erase/reset.',
		}),
	),
	firmwarePath: Type.Optional(
		Type.String({ description: "Firmware file to flash (.elf, .hex or .bin). Required for download." }),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("elf"), Type.Literal("hex"), Type.Literal("bin")], {
			description: "Firmware format. Omit to infer from the file extension (default elf).",
		}),
	),
	baseAddress: Type.Optional(
		Type.String({
			description: 'Flash base address for raw .bin images, e.g. "0x08000000" (the default for STM32 internal flash).',
		}),
	),
	probe: Type.Optional(
		Type.String({ description: 'Probe selector "VID:PID" or "VID:PID:Serial" when several debug probes are connected.' }),
	),
	verify: Type.Optional(Type.Boolean({ description: "Verify flash contents after downloading" })),
});

export type FlashToolInput = Static<typeof flashSchema>;

export interface FlashToolDetails {
	action: FlashAction;
	chip?: string;
	exitCode: number | null;
}

export type FlashToolOptions = EnginePathOptions;

/** download/erase 直接动真实硬件,给 probe-rs 的超时比引擎默认值紧。 */
const FLASH_TIMEOUT_MS = 2 * 60 * 1000;

const DESCRIPTION = `Flashes and controls embedded targets over a debug probe (ST-Link, J-Link, CMSIS-DAP, ...) using probe-rs.

- Actions: list (enumerate connected probes), info (probe/target details), download (flash a firmware image), erase (full chip erase), reset (reset the target so freshly flashed firmware starts running).
- Typical flow after a successful build: download the .elf, then reset to start it. download leaves the core halted.
- chip is the probe-rs registry name, e.g. "STM32F405RG" — it usually drops the temperature/packaging suffix of the ordering code (STM32F405RGT6 → STM32F405RG).
- Formats: .elf (default, addresses embedded), .hex (addresses embedded), .bin (raw — needs baseAddress; defaults to 0x08000000, the STM32 internal-flash origin).
- A physical debug probe must be connected; run list first when unsure. If several probes are attached, select one with probe ("VID:PID" or "VID:PID:Serial").
- erase wipes the entire flash — only use it when the user asks or a download demands a clean chip.
- Never claim firmware is running on hardware unless download and reset both succeeded.`;

/** 纯 argv 构造,导出给测试。firmwarePath 必须已经是绝对路径。 */
export function buildFlashArgs(params: FlashToolInput): string[] {
	const chip = () => {
		if (!params.chip) throw new Error(`flash ${params.action} requires chip (e.g. "STM32F405RG")`);
		return params.chip;
	};
	const probe = params.probe ? ["--probe", params.probe] : [];
	switch (params.action) {
		case "list":
			return ["list"];
		case "info":
			return ["info", ...probe];
		case "erase":
			return ["erase", "--chip", chip(), ...probe];
		case "reset":
			return ["reset", "--chip", chip(), ...probe];
		case "download": {
			if (!params.firmwarePath) throw new Error("flash download requires firmwarePath");
			const ext = path.extname(params.firmwarePath).toLowerCase();
			const format = params.format ?? (ext === ".hex" ? "hex" : ext === ".bin" ? "bin" : "elf");
			const args = ["download", "--chip", chip(), ...probe];
			if (format !== "elf") args.push("--binary-format", format);
			if (format === "bin") args.push("--base-address", params.baseAddress ?? "0x08000000");
			if (params.verify) args.push("--verify");
			args.push(params.firmwarePath);
			return args;
		}
	}
}

export function createFlashToolDefinition(
	env: ExecutionEnv,
	options?: FlashToolOptions,
): ToolDefinition<typeof flashSchema, FlashToolDetails> {
	return {
		name: "flash",
		label: "flash",
		description: DESCRIPTION,
		promptSnippet: "Flash and control embedded targets over a debug probe (probe-rs)",
		promptGuidelines: [
			"Never claim firmware is running on hardware unless flash download and reset both succeeded.",
		],
		parameters: flashSchema,
		execute: async (_toolCallId, params, signal) => {
			const firmware = params.firmwarePath ? await resolveToCwd(env, params.firmwarePath) : undefined;
			if (firmware) {
				const exists = await env.exists(firmware);
				if (!exists.ok || !exists.value) throw new Error(`firmware file not found: ${firmware}`);
			}

			const args = buildFlashArgs({ ...params, firmwarePath: firmware });
			const bin = engineBin("probe-rs", options);
			const result = await runEngine(bin, args, { cwd: env.cwd, signal, timeoutMs: FLASH_TIMEOUT_MS });
			if (result.timedOut) throw new Error(`probe-rs ${params.action} timed out`);
			if (result.aborted) throw new Error(`probe-rs ${params.action} was aborted`);

			const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
			const details: FlashToolDetails = { action: params.action, chip: params.chip, exitCode: result.exitCode };
			if (result.exitCode !== 0) {
				const text = `probe-rs ${params.action} failed (exit ${result.exitCode}):\n${output || "(no output)"}\nIf no debug probe was found, connect an ST-Link/J-Link/CMSIS-DAP probe and re-run \`list\`.`;
				return { content: [{ type: "text", text }], details };
			}
			return {
				content: [{ type: "text", text: output || `probe-rs ${params.action} completed` }],
				details,
			};
		},
	};
}

export function createFlashTool(env: ExecutionEnv, options?: FlashToolOptions) {
	return wrapToolDefinition(createFlashToolDefinition(env, options));
}
