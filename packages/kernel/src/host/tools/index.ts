/**
 * 硬件工具的装配:厨房那一半的点名册。
 *
 * 一个工具一个目录(`<名字>/{contract.ts,session.ts}`),这里不放任何逻辑 —— 它只回答"这一版装配出
 * 哪几个工具、按什么顺序"。顺序不是审美:TOOL_NAMES 逐字同序地钉住它,内核自带的四件套在前,硬件工具
 * 接在后面。契约总表在 contracts.ts(餐厅能走的门),两边必须同名同序,tool-names.test.ts 钉着 ——
 * 漏登记契约的代价是那个工具的守则静默不进系统提示词,而所有别的闸门都绿。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { createFlashTool } from "./flash/session.ts"

export function createHardwareTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return [createFlashTool()]
}
