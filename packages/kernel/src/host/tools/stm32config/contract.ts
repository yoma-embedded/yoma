/**
 * stm32config 工具的契约:菜单那一半。
 *
 * 确定性的 STM32 配置内核(`engines/bin/stm32kernel`,Rust):校验一份 JSON 配置文档(时钟树、外设、引脚、DMA、
 * NVIC、中间件),生成完整可编译的 CMake + HAL 工程。七个子命令原样透出。器件数据(irpack)是 CubeMX 器件库的
 * 解析产物、不进 git、分发构建可随包交付 —— "这台机器覆盖哪些族"是运行期事实,由厨房在描述末尾追加一行,
 * 这里只写不随机器变的部分。
 *
 * 门规同 flash / log / la / gdb / datasheet:只许 import typebox 与工具目录内的相对路径。
 *
 * 【没有确认门】generate 往 `out` 目录写工程,与 write 工具往工作目录写文件是同一类事;不碰硬件、不碰目录以外。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

export const STM32CONFIG_COMMANDS = [
  "list-mcus",
  "describe-mcu",
  "candidates",
  "solve-clock",
  "validate",
  "generate",
  "schema",
] as const
export type Stm32ConfigCommand = (typeof STM32CONFIG_COMMANDS)[number]

const stm32ConfigParameters = Type.Object({
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
  part: Type.Optional(
    Type.String({
      description:
        'Sales part number, e.g. "STM32F405RGTx". For describe-mcu, and for candidates without a config document.',
    }),
  ),
  configPath: Type.Optional(
    Type.String({
      description:
        "Path to the JSON configuration document. Required for solve-clock, validate and generate. For candidates give configPath (mode-aware) or part (config-free pad query).",
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
    Type.Integer({
      minimum: 0,
      maximum: 4294967295,
      description: "list-mcus filter: only parts with at least this much flash (KB)",
    }),
  ),
})

export type Stm32ConfigInput = Static<typeof stm32ConfigParameters>

export interface Stm32ConfigDetails {
  command: Stm32ConfigCommand
  /** 内核的退出码:0 = 干净,1 = 有 ERROR 诊断(正常结果),其余不会出现(抛错);跑的过程中(进度快照)是 null。 */
  exitCode: number | null
  /** 解析到工作目录之后的配置文档 / 输出目录。 */
  configPath?: string
  /** 输出被截断时,可用 read 读取的完整结果。 */
  outputFile?: string
  out?: string
}

const STM32CONFIG_DESCRIPTION = `Deterministic STM32 configuration kernel: validates a JSON configuration document describing the hardware setup (clock tree, peripherals, pins, DMA, NVIC, middleware) and generates a complete, compilable CMake + HAL driver project from it. This is how you produce driver code for supported chips — never hand-write peripheral init/register code when this tool covers the chip. Coverage depends on the device data packs installed on this machine (see the last line of this description and list-mcus); without packs only \`schema\` works.

Part numbers: the db spells them with a wildcard package suffix (STM32G473RCTx), while schematics and BOMs carry the orderable code (STM32G473RCT6). They denote the same die — pass the db spelling, and if a part is not found, read the diagnostic's suggestion list rather than concluding the chip is unsupported.

Commands and their required parameters:
- list-mcus [family, package, minFlashKb]: enumerate supported parts
- describe-mcu (part): memory, pins/signals, IP instances, clock tree of one part; if truncated, read the full output file or query candidates for a peripheral
- schema: print the configuration-document field reference (all fields, types, defaults) — consult it before authoring a config
- candidates (configPath | part, peripheral, [signal]): list candidate pads for a peripheral's signals — works before any config exists (pass part) and for peripherals not yet in the config
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
- Set the peripheral mode explicitly (e.g. USART1 mode: "Asynchronous"); omitting it can produce an empty init function. Peripheral params use the device database parameter names and values, which can differ from generated HAL constants: for STM32F4 USART use StopBits: "STOPBITS_2" and WordLength: "WORDLENGTH_9B". Names are case-sensitive; unknown parameter names can be ignored silently. Follow diagnostics verbatim and verify the generated init matches the requested settings.
- Exit code 1 (error diagnostics) is a normal result: read the diagnostics, fix the config, iterate until 0 errors.`

export const STM32CONFIG_CONTRACT = {
  name: "stm32config",
  label: "STM32 配置",
  description: STM32CONFIG_DESCRIPTION,
  parameters: stm32ConfigParameters,
  // 这两行进系统提示词、每一轮都读、压过工具描述,所以不写族名:曾经一句过时的 "STM32F1/F4" 把模型赶去给
  // 明明支持的 G473 手写寄存器。覆盖范围由厨房从数据目录生成、写在工具描述末尾。
  guidelines: [
    "For STM32 driver code, never hand-write peripheral init when stm32config has device data for the part: author a config document, then stm32config validate → fix diagnostics → generate. When stm32config reports that no device data packs are installed, say so and fall back to the datasheet + HAL by hand.",
    "stm32config describe-mcu is authoritative for a part's pads, signals and ADC channels — do not go to the datasheet for pin/signal mapping when it covers the part.",
  ],
  summary: stm32ConfigSummary,
} as const satisfies ToolContract<typeof stm32ConfigParameters>

/** 卡片副标题那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function stm32ConfigSummary(input: Partial<Stm32ConfigInput>): string {
  switch (input.command) {
    case "list-mcus": {
      const filters = [input.family, input.package, input.minFlashKb !== undefined ? `≥${input.minFlashKb}KB` : ""]
        .filter(Boolean)
        .join(" ")
      return filters ? `list-mcus ${filters}` : "list-mcus"
    }
    case "describe-mcu":
      return input.part ? `describe-mcu ${input.part}` : "describe-mcu"
    case "candidates": {
      const scope = input.configPath ?? input.part ?? ""
      return ["candidates", input.peripheral, input.signal, scope ? `(${scope})` : ""].filter(Boolean).join(" ")
    }
    case "solve-clock":
    case "validate":
      return input.configPath ? `${input.command} ${input.configPath}` : input.command
    case "generate":
      return `generate${input.configPath ? ` ${input.configPath}` : ""}${input.out ? ` → ${input.out}` : ""}`
    case "schema":
      return "schema"
    default:
      return ""
  }
}
