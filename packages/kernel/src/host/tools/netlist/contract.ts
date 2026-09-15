/**
 * netlist 工具的契约:菜单那一半。
 *
 * 原理图连接关系(Altium Smart PDF / Altium·OrCAD .NET / KiCad XML / 旧版 EESchema .net)→ 主控、每个外设、每根信号
 * 落在哪个引脚。两种模式:不带 part 跑 `controller_map`(原始逐 pin 连接图,只为认出板子和主控);带 part 跑
 * `board_ir`(联动 stm32kernel 的器件数据),产出外设建议 stm32_map 与起步配置 cfg_seed 三个 JSON 文件。
 *
 * 门规同 flash / log / la / gdb / datasheet / stm32config:只许 import typebox 与工具目录内的相对路径。
 *
 * 【没有确认门】只读原理图、只往工作目录下写 JSON;不碰硬件。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

/** board_ir 模式的默认输出根目录(工作目录下)。 */
export const DEFAULT_OUT_DIR = ".yoma/tool-output"

const netlistParameters = Type.Object({
  netlistPath: Type.String({
    description:
      "Path to the schematic source (Altium Smart PDF, Altium/OrCAD PCB II .NET, KiCad kicadxml XML, or KiCad legacy EESchema .net)",
  }),
  part: Type.Optional(
    Type.String({
      description:
        'STM32 sales part or ordering code, e.g. "STM32F405RGTx" or "STM32F405RGT6". When provided, the full board IR is produced: peripheral suggestions with evidence/confidence plus a starter stm32config document (cfg_seed). Omit it to get the raw per-pin connection map only.',
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
      description: `Directory to write the board IR JSON files into. Each call creates a separate subdirectory, defaulting to ${DEFAULT_OUT_DIR}/ under the working directory. Only used when part is provided.`,
    }),
  ),
})

export type NetlistInput = Static<typeof netlistParameters>

export interface NetlistDetails {
  mode: "map" | "board_ir"
  /** 解析到工作目录之后的原理图路径。 */
  netlist?: string
  part?: string
  /** 原始连接图被截断时,完整输出的绝对路径。 */
  outputFile?: string
  /** controller_map 认出的主控 ref(能从输出里读到时)与它自己的信心。 */
  controller?: string
  lowConfidence?: boolean
  /** board_ir:三个产物的绝对路径。 */
  files?: { boardIr: string; stm32Map: string; cfgSeed: string }
}

const NETLIST_DESCRIPTION = `Parses a schematic connectivity source and maps out the hardware design: the main controller, every peripheral/component wired to it, and which MCU pin each signal lands on.

- Input formats: Altium Smart PDF, Altium/OrCAD PCB II .NET netlists, KiCad kicadxml XML, and KiCad legacy "EESchema Netlist Version 1.1" .net. Smart PDF support is deterministic: it reads Altium's embedded Components/Nets/Pins metadata, not pixels; ordinary or scanned PDFs are rejected explicitly. Connections are traced through series resistors/inductors/ferrite beads and closed solder bridges to the real endpoint; DNF parts are flagged.
- Netlists usually do NOT carry the MCU part number, but the USER'S REQUEST often does (prompt text, silkscreen, BOM). Whenever the STM32 part is already known, pass \`part\` ON THE FIRST CALL — you get the full board IR directly: an stm32_map of peripheral suggestions (CAN/SPI/TIM/ADC/USB/... with per-signal evidence and confidence) plus a cfg_seed, a starter configuration document for the stm32config tool. Do not run the bare mode first "to check". For non-STM32 controllers omit \`part\` and use the raw map.
- Without \`part\` you get the raw per-pin connection map (pin → net → traced endpoints), tightly truncated: use the full output file when truncated. For STM32, re-run with \`part\` for peripheral suggestions; for other MCUs, read the raw map.
- The board IR needs the STM32 device data packs that stm32config uses; on a machine without them the tool says so — the raw map still works for any MCU (STM32 or not).
- If detection reports low confidence or picks the wrong component, re-run with \`mainController\` set to the correct reference (e.g. "U2").
- Treat low-confidence suggestions as hypotheses: verify them against the connection evidence and the datasheet before configuring peripherals.
- This is the first step of the schematic → firmware pipeline: netlist → stm32config describe-mcu (pads, signals, ADC channels — authoritative, one call) → stm32config validate/generate (drivers) → build → flash. Reach for the datasheet only for behaviour the db does not carry: register semantics, electrical limits, application notes.`

export const NETLIST_CONTRACT = {
  name: "netlist",
  label: "网表",
  description: NETLIST_DESCRIPTION,
  parameters: netlistParameters,
  guidelines: [
    "Hardware bring-up starts from the schematic: run netlist first (pass part when an STM32 part is known), including when the user gives a local Altium Smart PDF path; do not read or send the whole PDF to the model. Treat low-confidence peripheral suggestions as hypotheses to verify.",
  ],
  summary: netlistSummary,
} as const satisfies ToolContract<typeof netlistParameters>

/** 卡片副标题那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function netlistSummary(input: Partial<NetlistInput>): string {
  const file = input.netlistPath?.trim()
  const mode = input.part ? `board_ir ${input.part}` : "map"
  const controller = input.mainController ? ` @${input.mainController}` : ""
  return file ? `${mode} ${file}${controller}` : `${mode}${controller}`
}
