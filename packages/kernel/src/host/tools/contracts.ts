/**
 * 契约总表:餐厅按工具名找契约的地方(`@yoma-desktop/kernel/tools/contracts` 这道门)。
 *
 * 这个文件只许 import 各工具的 contract.ts,绝不能碰 session.ts —— 碰了就把 node:* 和发动机拖进浏览器包。
 * 装配(真正 new 出工具)在 index.ts,那边是厨房;两张表必须同名同序,tool-names.test.ts 钉着。
 */

import type { ToolContract } from "./contract-types.ts"
import { FLASH_CONTRACT } from "./flash/contract.ts"

export const TOOL_CONTRACTS = [FLASH_CONTRACT] as const satisfies readonly ToolContract[]

export function toolContract(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find((contract) => contract.name === name)
}

/** 这一轮装配出的工具各自的守则,按总表顺序;没装配的工具一句都不出。 */
export function toolGuidelines(toolNames: readonly string[]): string[] {
  return TOOL_CONTRACTS.filter((contract) => toolNames.includes(contract.name)).flatMap((contract) => [
    ...contract.guidelines,
  ])
}

/**
 * 这一次调用跑之前要不要问用户:要问就把契约交出来(界面短名与那行 summary 都在它身上)。
 *
 * 判断留在总表而不是钩子里:钩子手上只有工具名和参数,"问不问"是契约的事 —— toolchain 只在
 * install 时问、gdb 只在写内存时问,所以它是函数不是布尔。没登记契约的工具一律不问。
 */
export function confirmNeeded(name: string, input: Record<string, unknown>): ToolContract | undefined {
  const contract = toolContract(name)
  if (!contract) return undefined
  return contract.confirm?.(input) ? contract : undefined
}
