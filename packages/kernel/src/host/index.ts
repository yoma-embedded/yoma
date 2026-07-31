/**
 * 内核宿主(Node 侧)。跑在 Electron 的 utilityProcess 里,不在 main、也不在 renderer。
 *
 * 进程模型是刻意的单例:my-pi 的 probe 租约(claimProbe/releaseProbe)、gdb session 表、
 * log capture 都是 **模块级全局**(coding-agent/src/core/tools/engines.ts:63-113),
 * 所以整个 app 只能有一个内核进程 —— 绝不按窗口或按目录分片 fork。
 */
import { AgentHarness } from "@yoma/my-pi"
import { NodeExecutionEnv } from "@yoma/my-pi/node"
import { createCodingToolDefinitions, createEmbeddedToolDefinitions } from "@yoma/my-pi-coding-agent"

export interface KernelHostOptions {
  /** engines/bin + engines/data 的所在目录。生产环境是 process.resourcesPath/engines。 */
  enginesDir?: string
  /** session JSONL 的根目录,通常是 Electron 的 userData/sessions。 */
  sessionsRoot: string
}

/** 冒烟自检:确认整个 my-pi 依赖图在当前 runtime 下真的加载得起来。 */
export function kernelSelfCheck(options: Partial<KernelHostOptions> = {}) {
  const env = new NodeExecutionEnv({ cwd: process.cwd() })
  const engineOptions = options.enginesDir
    ? ({
        netlist: { enginesDir: options.enginesDir },
        stm32config: { enginesDir: options.enginesDir },
        flash: { enginesDir: options.enginesDir },
        log: { enginesDir: options.enginesDir },
        gdb: { enginesDir: options.enginesDir },
      } as never)
    : undefined
  const coding = createCodingToolDefinitions(env)
  const embedded = createEmbeddedToolDefinitions(env, engineOptions)
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    harness: typeof AgentHarness,
    tools: [...coding, ...embedded].map((t) => t.name),
  }
}
