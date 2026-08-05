/**
 * netlist 工具。移植自 yoma packages/opencode/src/tool/netlist.ts。
 *
 * 与 yoma 的差异(同 stm32config):Effect → ToolDefinition,子进程走 runEngine,
 * 去掉 ctx.ask / assertExternalDirectoryEffect,文件访问经注入的 env。
 * 输出目录默认 .my-pi/(yoma 是 .yoma/),描述文本相应调整。
 *
 * 两种模式:不带 part 时跑 controller_map(原始逐 pin 连接图);带 part 时跑
 * board_ir(联动 stm32kernel 数据),产出外设建议 stm32_map + 起步配置 cfg_seed。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import { capEngineOutput, type EnginePathOptions, engineBin, engineDataDir, runEngine } from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const netlistSchema = Type.Object({
	netlistPath: Type.String({
		description:
			"Path to the schematic netlist file (Altium/OrCAD PCB II .NET, KiCad kicadxml XML, or KiCad legacy EESchema .net)",
	}),
	part: Type.Optional(
		Type.String({
			description:
				'MCU sales part or ordering code, e.g. "STM32F405RGTx" or "STM32F405RGT6". When provided, the full board IR is produced: peripheral suggestions with evidence/confidence plus a starter stm32config document (cfg_seed). Omit it to get the raw per-pin connection map only.',
		}),
	),
	mainController: Type.Optional(
		Type.String({
			description:
				'Component reference of the main controller, e.g. "U2". Omit to auto-detect; set it when auto-detection reports low confidence or picks the wrong chip.',
		}),
	),
	outDir: Type.Optional(
		Type.String({
			description:
				"Directory to write the board IR JSON files into. Defaults to .my-pi/ under the working directory. Only used when part is provided.",
		}),
	),
});

export type NetlistToolInput = Static<typeof netlistSchema>;

export interface NetlistToolDetails {
	mode: "map" | "board_ir";
	part?: string;
	files?: { boardIr: string; stm32Map: string; cfgSeed: string };
}

export type NetlistToolOptions = EnginePathOptions;

const DESCRIPTION = `Parses a schematic netlist and maps out the hardware design: the main controller, every peripheral/component wired to it, and which MCU pin each signal lands on.

- Input formats: Altium/OrCAD PCB II .NET netlists, KiCad kicadxml XML, and KiCad legacy "EESchema Netlist Version 1.1" .net. Connections are traced through series resistors/inductors/ferrite beads and closed solder bridges to the real endpoint; DNF parts are flagged.
- Netlists usually do NOT carry the MCU part number. If you know the part (from the user, silkscreen, or BOM), always pass \`part\` — you then get the full board IR: an stm32_map of peripheral suggestions (CAN/SPI/TIM/ADC/USB/... with per-signal evidence and confidence) plus a cfg_seed, a starter configuration document for the stm32config tool.
- Without \`part\` you get the raw per-pin connection map (pin → net → traced endpoints). Use it to identify the board and controller first, then re-run with \`part\`.
- If detection reports low confidence or picks the wrong component, re-run with \`mainController\` set to the correct reference (e.g. "U2").
- Treat low-confidence suggestions as hypotheses: verify them against the connection evidence and the datasheet before configuring peripherals.
- This is the first step of the schematic → firmware pipeline: netlist → stm32config describe-mcu (pads, signals, ADC channels — authoritative, one call) → stm32config validate/generate (drivers) → build → flash. Reach for the datasheet only for behaviour the db does not carry: register semantics, electrical limits, application notes.`;

/**
 * 输出文件名的词干:去扩展名,不安全字符换下划线。导出给测试。
 * 按 Unicode 字母/数字保留:纯 ASCII 白名单会把「咖啡机.NET」整个吞成 "_",
 * 两张中文名网表就会共用同一组缓存文件互相覆盖。
 */
export function sanitizeStem(name: string): string {
	const stem = path.basename(name).replace(/\.[^.]*$/, "");
	return stem.replace(/[^\p{L}\p{N}_.-]+/gu, "_") || "board";
}

export function createNetlistToolDefinition(
	env: ExecutionEnv,
	options?: NetlistToolOptions,
): ToolDefinition<typeof netlistSchema, NetlistToolDetails> {
	return {
		name: "netlist",
		label: "netlist",
		description: DESCRIPTION,
		promptSnippet: "Parse schematic netlists into pin maps and board IR (peripheral suggestions + config seed)",
		promptGuidelines: [
			"Hardware bring-up starts from the schematic: run netlist first (pass part when known), and treat low-confidence peripheral suggestions as hypotheses to verify.",
		],
		parameters: netlistSchema,
		execute: async (_toolCallId, params, signal) => {
			const netlist = await resolveToCwd(env, params.netlistPath);
			const exists = await env.exists(netlist);
			if (!exists.ok || !exists.value) throw new Error(`netlist file not found: ${netlist}`);

			// 不带 part:controller_map 输出原始连接图,stderr 上是探测说明。
			if (!params.part) {
				const bin = engineBin("controller_map", options);
				const args = [netlist];
				if (params.mainController) args.push("--main-controller", params.mainController);
				const result = await runEngine(bin, args, { cwd: env.cwd, signal });
				if (result.timedOut) throw new Error("controller_map timed out");
				if (result.aborted) throw new Error("controller_map was aborted");
				if (result.exitCode !== 0) {
					throw new Error(`controller_map failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
				}
				const notes = result.stderr.trim();
				const map = capEngineOutput(
					result.stdout.trim(),
					"re-run with `part` set to get the condensed board IR instead of the raw pin map",
				);
				const text = [notes && `[detection]\n${notes}`, map].filter(Boolean).join("\n\n");
				return { content: [{ type: "text", text: text || "(no output)" }], details: { mode: "map" } };
			}

			// 带 part:board_ir 联动 stm32kernel 的数据,产出三个 JSON 文件。
			const bin = engineBin("board_ir", options);
			const kernel = engineBin("stm32kernel", options);
			const dataDir = engineDataDir("stm32", options);

			const outDir = await resolveToCwd(env, params.outDir ?? ".my-pi");
			const created = await env.createDir(outDir, { recursive: true });
			if (!created.ok) throw new Error(`cannot create output directory ${outDir}: ${created.error.message}`);
			const stem = sanitizeStem(netlist);

			const args = [
				netlist,
				"--stm32kernel",
				kernel,
				"--data-dir",
				dataDir,
				"--part",
				params.part,
				"--out-dir",
				outDir,
				"--stem",
				stem,
			];
			if (params.mainController) args.push("--main-controller", params.mainController);

			const result = await runEngine(bin, args, { cwd: env.cwd, signal });
			if (result.timedOut) throw new Error("board_ir timed out");
			if (result.aborted) throw new Error("board_ir was aborted");
			if (result.exitCode !== 0) {
				throw new Error(`board_ir failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			}

			const files = {
				boardIr: path.join(outDir, `${stem}_board_ir.json`),
				stm32Map: path.join(outDir, `${stem}_stm32_map.json`),
				cfgSeed: path.join(outDir, `${stem}_cfg_seed.json`),
			};
			const readOptional = async (file: string) => {
				const content = await env.readTextFile(file);
				return content.ok ? content.value.trim() : undefined;
			};
			const stm32Map = await readOptional(files.stm32Map);
			const cfgSeed = await readOptional(files.cfgSeed);

			const notes = result.stderr.trim();
			// Both files are on disk and named right above, so truncating what we
			// inline costs the model one `read` — whereas inlining them whole has
			// no upper bound at all.
			const text = [
				notes && `[detection]\n${notes}`,
				`Board IR files written to ${outDir}:`,
				`- ${files.boardIr} (full component/net graph; read it on demand)`,
				`- ${files.stm32Map}`,
				`- ${files.cfgSeed}`,
				stm32Map &&
					`[stm32_map] peripheral suggestions with evidence/confidence:\n${capEngineOutput(stm32Map, `read ${files.stm32Map} for the rest`)}`,
				cfgSeed &&
					`[cfg_seed] starter stm32config document (extend it, then validate):\n${capEngineOutput(cfgSeed, `read ${files.cfgSeed} for the rest`)}`,
			]
				.filter(Boolean)
				.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { mode: "board_ir", part: params.part, files },
			};
		},
	};
}

export function createNetlistTool(env: ExecutionEnv, options?: NetlistToolOptions) {
	return wrapToolDefinition(createNetlistToolDefinition(env, options));
}
