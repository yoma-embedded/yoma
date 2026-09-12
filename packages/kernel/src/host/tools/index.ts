/**
 * 工具的装配:厨房那一半的点名册(文件工具 + 硬件工具)。
 *
 * 一个工具一个目录(`<名字>/{contract.ts,session.ts}`),这里不放任何逻辑 —— 它只回答"这一版装配出
 * 哪几个工具、按什么顺序"。顺序不是审美:TOOL_NAMES 逐字同序地钉住它,内核自带的四件套在前,硬件工具
 * 接在后面。契约总表在 contracts.ts(餐厅能走的门),两边必须同名同序,tool-names.test.ts 钉着 ——
 * 漏登记契约的代价是那个工具的守则静默不进系统提示词,而所有别的闸门都绿。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { createFindTool } from "./find/session.ts"
import { createFlashTool } from "./flash/session.ts"
import { createGrepTool } from "./grep/session.ts"
import { createLsTool } from "./ls/session.ts"
import { createPowerShellTool } from "./powershell/session.ts"

export interface RegisteredToolOptions {
  /** engines/ 根目录(bin/rg 在里面)。空串也算没给:kernel-entry 把未设的路径透传成 ""。 */
  enginesDir?: string
}

export function createRegisteredTools(options: RegisteredToolOptions = {}): AgentHarnessTool<ExecutionToolContext>[] {
  const shared = { enginesDir: options.enginesDir || undefined }
  return [
    createGrepTool(shared),
    createFindTool(shared),
    createLsTool(shared),
    createPowerShellTool(shared),
    createFlashTool(),
  ]
}
