/**
 * 工具的装配:厨房那一半的点名册(文件工具 + 硬件工具)。
 *
 * 一个工具一个目录(`<名字>/{contract.ts,session.ts}`),这里不放任何逻辑 —— 它只回答"这一版装配出
 * 哪几个工具、按什么顺序"。顺序不是审美:TOOL_NAMES 逐字同序地钉住它,内核自带的四件套在前,硬件工具
 * 接在后面。契约总表在 contracts.ts(餐厅能走的门),两边必须同名同序,tool-names.test.ts 钉着 ——
 * 漏登记契约的代价是那个工具的守则静默不进系统提示词,而所有别的闸门都绿。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import type { TaskHost } from "../domain/agents/task-host.ts"
import { createAgentTool } from "./agent/session.ts"
import { withFriendlyArguments } from "./arguments.ts"
import { createDatasheetTool, type DatasheetToolOptions } from "./datasheet/session.ts"
import { createFindTool } from "./find/session.ts"
import { createFlashTool } from "./flash/session.ts"
import { createGdbTool } from "./gdb/session.ts"
import { createGrepTool } from "./grep/session.ts"
import { createLaTool } from "./la/session.ts"
import { createLogTool } from "./log/session.ts"
import { createLsTool } from "./ls/session.ts"
import { createNetlistTool } from "./netlist/session.ts"
import { createPowerShellTool } from "./powershell/session.ts"
import { createProjectTool } from "./project/session.ts"
import { createScopeTool } from "./scope/session.ts"
import { createSendMessageTool } from "./send_message/session.ts"
import { createStm32ConfigTool } from "./stm32config/session.ts"
import { createTaskOutputTool } from "./task_output/session.ts"
import { createTaskStopTool } from "./task_stop/session.ts"
import { createToolchainTool, type ToolchainToolOptions } from "./toolchain/session.ts"

export interface RegisteredToolOptions {
  /** Session-owned instruments, also used by the manual controls. */
  instruments?: Partial<Record<"log" | "gdb", RegisteredTool>>
  project?: { sessionID?: string }
  /** engines/ 根目录(bin/rg 在里面)。空串也算没给:kernel-entry 把未设的路径透传成 ""。 */
  enginesDir?: string
  /** STM32 本机资源使用同一份工具链账本与用户缓存目录。 */
  configDir?: string
  /**
   * toolchain 工具的接线:账本目录、清单来源、安装注册表、装完刷 PATH 的钩子。
   * **不传也能装配出工具**(自检那条路就不传),只是它会去读真实的 ~/.yoma、装完不刷在飞会话的 PATH。
   */
  toolchain?: ToolchainToolOptions
  /**
   * datasheet 工具的接线:`.env` 所在目录(地址解析要读它)。不传就读真实的 ~/.yoma —— 与 toolchain 同一条
   * 规矩:自检那条路不传也能装配。
   */
  datasheet?: DatasheetToolOptions
  /**
   * 子 agent 四件(agent / task_output / task_stop / send_message)的宿主接口。**不传也照常登记**(工具清单平台无关,
   * 同 powershell),execute 时报"这个宿主不支持子 agent";没有它的会话,宿主也不会激活这四件
   * (docs/子agent-设计方案-v0.4-20260918.md §5)。
   */
  agents?: { host?: TaskHost; canReadOutputFile?: boolean }
}

/**
 * 装配面上的工具:比发动机的 AgentHarnessTool 多一个可选的会话关闭收尾口。长驻型工具(log 的采集器)
 * 靠它在会话关掉时还回串口;一次性工具不实现。session-manager 的 closeEntry 在 stop 之后逐个调。
 */
export type RegisteredTool = AgentHarnessTool<ExecutionToolContext> & { dispose?(): Promise<void> }

export function createRegisteredTools(options: RegisteredToolOptions = {}): RegisteredTool[] {
  const shared = { enginesDir: options.enginesDir || undefined }
  const stm32 = { ...shared, configDir: options.configDir }
  // 每个工具都挂 prepareArguments(arguments.ts):模型写错参数时拿到的是列了合法值的话,不是发动机的 "must be equal to constant"
  const tools: RegisteredTool[] = [
    createGrepTool(shared),
    createFindTool(shared),
    createLsTool(shared),
    createPowerShellTool(shared),
    createToolchainTool(options.toolchain),
    createProjectTool(options.project),
    createFlashTool(),
    options.instruments?.log ?? createLogTool(),
    createLaTool(shared),
    createScopeTool(),
    options.instruments?.gdb ?? createGdbTool(),
    createDatasheetTool(options.datasheet),
    createNetlistTool(stm32),
    createStm32ConfigTool(stm32),
    createAgentTool(options.agents),
    createTaskOutputTool(options.agents),
    createTaskStopTool(options.agents),
    createSendMessageTool(options.agents),
  ]
  return tools.map(withFriendlyArguments)
}
