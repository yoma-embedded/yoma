/**
 * netlist 工具。移植自 yoma packages/opencode/src/tool/netlist.ts。
 *
 * 与 yoma 的差异(同 stm32config):Effect → ToolDefinition,子进程走 runEngine,
 * 去掉 ctx.ask / assertExternalDirectoryEffect,文件访问经注入的 env。
 * 输出目录默认 `.yoma/`。
 *
 * 两种模式:不带 part 时跑 controller_map(原始逐 pin 连接图);带 part 时跑
 * board_ir(联动 stm32kernel 数据),产出外设建议 stm32_map + 起步配置 cfg_seed。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import {
	assertEngineSettled,
	capEngineOutput,
	type EnginePathOptions,
	engineBin,
	engineDataDir,
	runEngine,
} from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const netlistSchema = Type.Object({
	netlistPath: Type.String({
		description:
			"Path to the schematic source (Altium Smart PDF, Altium/OrCAD PCB II .NET, KiCad kicadxml XML, or KiCad legacy EESchema .net)",
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
				"Directory to write the board IR JSON files into. Defaults to .yoma/ under the working directory. Only used when part is provided.",
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

const DESCRIPTION = `Parses a schematic connectivity source and maps out the hardware design: the main controller, every peripheral/component wired to it, and which MCU pin each signal lands on.

- Input formats: Altium Smart PDF, Altium/OrCAD PCB II .NET netlists, KiCad kicadxml XML, and KiCad legacy "EESchema Netlist Version 1.1" .net. Smart PDF support is deterministic: it reads Altium's embedded Components/Nets/Pins metadata, not pixels; ordinary or scanned PDFs are rejected explicitly. Connections are traced through series resistors/inductors/ferrite beads and closed solder bridges to the real endpoint; DNF parts are flagged.
- Netlists usually do NOT carry the MCU part number, but the USER'S REQUEST often does (prompt text, silkscreen, BOM). Whenever the part is already known, pass \`part\` ON THE FIRST CALL — you get the full board IR directly: an stm32_map of peripheral suggestions (CAN/SPI/TIM/ADC/USB/... with per-signal evidence and confidence) plus a cfg_seed, a starter configuration document for the stm32config tool. Do not run the bare mode first "to check".
- Without \`part\` you get the raw per-pin connection map (pin → net → traced endpoints), tightly truncated: its only job is to identify the board and controller so you can re-run with \`part\`.
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
		promptSnippet: "Parse schematic netlists or Altium Smart PDFs into pin maps and board IR",
		promptGuidelines: [
			"Hardware bring-up starts from the schematic: run netlist first (pass part when known), including when the user gives a local Altium Smart PDF path; do not read or send the whole PDF to the model. Treat low-confidence peripheral suggestions as hypotheses to verify.",
		],
		parameters: netlistSchema,
		execute: async (_toolCallId, params, signal) => {
			// 两个分支跑的是两个不同的引擎,善后那五行却逐字一样;非零退出对这两个引擎
			// 都是真失败(不像 stm32kernel 的 exit 1 和 flash 的烧录器),所以退出码检查可以留在这。
			const runOrThrow = async (bin: string, args: string[], label: string) => {
				const result = assertEngineSettled(await runEngine(bin, args, { cwd: env.cwd, signal }), label);
				if (result.exitCode !== 0) {
					throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
				}
				return result;
			};

			const netlist = await resolveToCwd(env, params.netlistPath);
			const exists = await env.exists(netlist);
			if (!exists.ok || !exists.value) throw new Error(`netlist file not found: ${netlist}`);

			// 不带 part:controller_map 输出原始连接图,stderr 上是探测说明。
			if (!params.part) {
				const args = [netlist];
				if (params.mainController) args.push("--main-controller", params.mainController);
				const result = await runOrThrow(engineBin("controller_map", options), args, "controller_map");
				const notes = result.stderr.trim();
				// The raw pin map exists to identify the board and controller —
				// a tighter cap than the general engine limit, because its full
				// text is the fattest tool payload of an agent session and the
				// distilled board-IR mode is one `part` argument away.
				const map = capEngineOutput(
					result.stdout.trim(),
					"re-run with `part` set to get the condensed board IR instead of the raw pin map",
					10_000,
				);
				const text = [notes && `[detection]\n${notes}`, map].filter(Boolean).join("\n\n");
				return { content: [{ type: "text", text: text || "(no output)" }], details: { mode: "map" } };
			}

			// 带 part:board_ir 联动 stm32kernel 的数据,产出三个 JSON 文件。
			const kernel = engineBin("stm32kernel", options);
			const dataDir = engineDataDir("stm32", options);

			const outDir = await resolveToCwd(env, params.outDir ?? ".yoma");
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

			const result = await runOrThrow(engineBin("board_ir", options), args, "board_ir");

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
