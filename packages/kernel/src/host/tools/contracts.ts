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
