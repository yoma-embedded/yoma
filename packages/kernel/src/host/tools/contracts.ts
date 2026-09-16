/**
 * 契约总表:餐厅按工具名找契约的地方(`@yoma-desktop/kernel/tools/contracts` 这道门)。
 *
 * 这个文件只许 import 各工具的 contract.ts,绝不能碰 session.ts —— 碰了就把 node:* 和发动机拖进浏览器包。
 * 装配(真正 new 出工具)在 index.ts,那边是厨房;两张表必须同名同序,tool-names.test.ts 钉着。
 */

import type { ToolContract } from "./contract-types.ts"
import { DATASHEET_CONTRACT } from "./datasheet/contract.ts"
import { FIND_CONTRACT } from "./find/contract.ts"
import { FLASH_CONTRACT, probeCommandIn } from "./flash/contract.ts"
import { GDB_CONTRACT } from "./gdb/contract.ts"
import { GREP_CONTRACT } from "./grep/contract.ts"
import { LA_CONTRACT } from "./la/contract.ts"
import { LOG_CONTRACT } from "./log/contract.ts"
import { LS_CONTRACT } from "./ls/contract.ts"
import { NETLIST_CONTRACT } from "./netlist/contract.ts"
import { POWERSHELL_CONTRACT } from "./powershell/contract.ts"
import { SCOPE_CONTRACT } from "./scope/contract.ts"
import { STM32CONFIG_CONTRACT } from "./stm32config/contract.ts"
import { TOOLCHAIN_CONTRACT } from "./toolchain/contract.ts"

/** 四件套之后先放文件工具,再是这台机器本身(工具链),硬件之后是手册,最后是原理图 → 固件那条线(netlist、stm32config);顺序与 index.ts 的装配、types.ts 的 TOOL_NAMES 逐字同序。 */
export const TOOL_CONTRACTS = [
  GREP_CONTRACT,
  FIND_CONTRACT,
  LS_CONTRACT,
  POWERSHELL_CONTRACT,
  TOOLCHAIN_CONTRACT,
  FLASH_CONTRACT,
  LOG_CONTRACT,
  LA_CONTRACT,
  SCOPE_CONTRACT,
  GDB_CONTRACT,
  DATASHEET_CONTRACT,
  NETLIST_CONTRACT,
  STM32CONFIG_CONTRACT,
] as const satisfies readonly ToolContract[]

export function toolContract(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find((contract) => contract.name === name)
}

/** 这一轮装配出的工具各自的守则,按总表顺序;没装配的工具一句都不出。 */
export function toolGuidelines(toolNames: readonly string[]): string[] {
  return TOOL_CONTRACTS.filter((contract) => toolNames.includes(contract.name)).flatMap((contract) => [
    ...contract.guidelines,
  ])
}

/** 确认条要的两样:界面短名 + 那段命令。契约本身就满足它;bash 没契约,下面单独给一个。 */
export type ConfirmGate = Pick<ToolContract, "label" | "summary">

/**
 * 内核自带的 bash 来自发动机,没有契约,但它能起 openocd —— 与 flash / powershell 同一道门。
 * 只认工具名的门是假门:模型被拒之后改用 bash 跑同一条命令,一个字都不问(2026-09-13 猎漏确认)。
 */
const BASH_GATE = {
  name: "bash",
  label: "命令",
  confirm: (input: Record<string, unknown>) =>
    typeof input.command === "string" && probeCommandIn(input.command) !== undefined,
  summary: (input: Record<string, unknown>) => (typeof input.command === "string" ? input.command.trim() : ""),
} as const

/**
 * 这一次调用跑之前要不要问用户:要问就把门交出来(界面短名与那段 summary 都在它身上)。
 *
 * 判断留在总表而不是钩子里:钩子手上只有工具名和参数,"问不问"是契约的事 —— toolchain 只在
 * install 时问、gdb 只在写内存时问,所以它是函数不是布尔。没登记契约的工具只有 bash 例外(上面)。
 */
export function confirmNeeded(name: string, input: Record<string, unknown>): ConfirmGate | undefined {
  const contract = toolContract(name)
  if (contract) return contract.confirm?.(input) ? contract : undefined
  if (name === BASH_GATE.name) return BASH_GATE.confirm(input) ? BASH_GATE : undefined
  return undefined
}
