/**
 * flash 工具的契约:菜单那一半。
 *
 * 一个工具两个文件,分工是餐厅/厨房:contract.ts 是菜单(叫什么、收什么参数、结果长什么形状、
 * 卡片副标题怎么写),session.ts 是厨房(真去起烧录器、攥探针、杀进程树)。界面要画 flash 的专用
 * 卡片,就得知道参数与 details 的字段名 —— 但界面跑在浏览器里,不能顺带把 Node 拖进 bundle。
 *
 * 两条门规(boundary.test.ts 第 3、5 条机器执行):
 * - 谁能 import 它:界面包只许走 `@yoma-desktop/kernel/tools/flash/contract` 这道契约门,
 *   不许相对路径钻进 kernel/src。
 * - 它能 import 什么:只有 typebox 和工具间内部的相对路径(不含 session.ts)。不许 node:*、electron、
 *   `@earendil-works/*`、发动机(host/domain/engines.ts),也不许 ../../types.ts 或任何 `@yoma-desktop/*`
 *   —— 契约门一旦牵进 Node,餐厅就打不开了。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const flashParameters = Type.Object({
  command: Type.Array(Type.String(), {
    description:
      'The flasher argv (no shell), e.g. ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"].',
  }),
  elfPath: Type.Optional(
    Type.String({
      description:
        "The image this command flashes. On success its hash is recorded so gdb start can verify the chip runs exactly this build. Pass it whenever the command programs firmware.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Kill the command after this long (default 120000, clamped to 5000–600000). Flashing normally takes seconds; a hung flasher keeps the probe hostage.",
    }),
  ),
})

export type FlashInput = Static<typeof flashParameters>

export interface FlashDetails {
  command: string[]
  exitCode: number | null
  /** elfPath 给了且 exit 0 时:已写进 flash-state.json 的镜像绝对路径。 */
  recordedElf?: string
}

const FLASH_DESCRIPTION = `Runs a flashing or probe-control command (OpenOCD, J-Link Commander, STM32CubeProgrammer CLI, pyocd, west, esptool, ...) with exclusive access to the debug probe.

- Use this instead of bash for ANY command that touches the debug probe (flash, erase, reset, option bytes). The probe lease lives here: a concurrent gdb or log session is told who holds the probe instead of a fake "no probe found", and a hung flasher is killed with its whole process tree instead of keeping the probe hostage.
- command is an argv array; it runs without a shell. Typical recipes:
  - OpenOCD: ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"]
  - J-Link: write a command file first (r / loadfile build/fw.hex / r / g / qc), then ["JLink","-Device","STM32G431CB","-If","SWD","-Speed","4000","-AutoConnect","1","-CommanderScript","flash.jlink"] (the binary is JLinkExe on macOS/Linux). J-Link Commander can exit 0 even when it failed — read the output, never trust its exit code alone.
  - STM32CubeProgrammer: ["STM32_Programmer_CLI","-c","port=SWD","-w","build/fw.elf","-v","-rst"]
- Always pass elfPath (the image the command flashes) when programming firmware: on success its hash is recorded, and gdb start verifies the chip is running exactly this build — the guard against debugging stale firmware.
- A non-zero exit comes back as data, not an error. It usually means no probe connected, a vendor-driver mismatch, or the probe is held by another process — read the output and the appended hint.
- There is no built-in probe enumeration; use bash for that (J-Link's ShowEmuList, lsusb, Get-PnpDevice) or the vendor tool itself.
- Make sure the firmware actually starts afterwards: include a reset in the command (OpenOCD "reset", J-Link "r" then "g", CubeProgrammer "-rst") or reset through gdb. Never claim firmware is running on hardware unless flashing and a reset both succeeded.`

/**
 * confirm 是给"烧录前先问用户"那一刀(before_tool 钩子)的元数据:这一刀只声明,谁都还没消费它。
 * 放在契约里而不是 session 里,是因为确认 UI 长在餐厅那边 —— 它不该为了问一句话去 import 厨房。
 * 烧录每一次都问:命令是模型自带的,工具分不清 erase 和 program。
 *
 * guidelines 进系统提示词的 "Tool-specific rules"(host/system-prompt.ts 按装配出的工具名收集)。
 * 这两句是行为防线不是文档:落不进提示词,模型就会继续用 bash 起 openocd,而 bash 起的进程在
 * 探针租约体系里是隐形的,整套跨进程分诊白做。
 */
export const FLASH_CONTRACT = {
  name: "flash",
  label: "烧录",
  description: FLASH_DESCRIPTION,
  parameters: flashParameters,
  confirm: (_input: FlashInput) => true,
  guidelines: [
    "Run every command that touches the debug probe through the flash tool, not bash — the probe lease and hung-flasher cleanup live there.",
    "Never claim firmware is running on hardware unless flashing and a reset both succeeded.",
  ],
  summary: flashSummary,
} as const satisfies ToolContract<typeof flashParameters>

/**
 * 卡片副标题:把 argv 拼回一行人能读的命令。含空格的参数加双引号 —— 不加的话
 * `-c "program fw.elf verify reset exit"` 在卡片上会散成五个词,看着像五个参数。
 * 这是给人看的展示串,不是能回放的 shell 命令(不转义引号本身)。
 */
export function flashSummary(input: Partial<FlashInput>): string {
  const command = input.command
  if (!command || command.length === 0) return ""
  return command.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")
}
