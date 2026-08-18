/**
 * `toolchain.status` / `toolchain.set` 两个 RPC 的实现:设置页"工具链"标签的后端。
 *
 * 全部逻辑(七档探测、验证、写账本)都在 coding-agent 的 toolchain 子系统里,这里
 * 只是"参数 → 调用 → 折叠成浏览器安全的视图"这一层胶水 —— 与 agent 工具
 * (coding-agent 的 tools/toolchain.ts)共用同一组动作实现(resolveToolchain /
 * rememberFreshResults / recordToolchainPath),UI 和 agent 两个入口的行为因此不可能
 * 分叉:同一套探测顺序、同一套拒绝理由、同一份账本形态。
 *
 * 错误处理与会话开启(session-manager 的 resolveToolchainSafe)刻意不同:那边"清单
 * 坏了"必须吞掉继续开会话(会话开不起来比工具链没配好严重得多),这里把解析错误放进
 * 结果的 error 字段 —— 设置页正是排查清单的地方,错误就是用户要看的答案本身。
 * set 的路径验证失败则直接 reject:那是用户刚敲进输入框的东西,拒绝理由要原地报。
 */
import { recordToolchainPath, rememberFreshResults, resolveToolchain } from "@yoma/my-pi-coding-agent"

import type { ToolchainStatusView } from "../types.ts"

export interface ToolchainRpcOptions {
  directory: string
  configDir: string
  side: "mother" | "runner"
  /** 测试注入:隔离这台机器真实的 PATH / 平台(不注入的话断言看开发机脸色)。生产不传。 */
  probe?: { platform?: string; env?: NodeJS.ProcessEnv }
}

export async function toolchainStatus(opts: ToolchainRpcOptions & { fresh?: boolean }): Promise<ToolchainStatusView> {
  try {
    const resolution = await resolveToolchain({
      projectDir: opts.directory,
      configDir: opts.configDir,
      side: opts.side,
      // fresh 的语义与 agent 工具的 resolve 动作一致:不信账本重新探一遍,再把新答案记住。
      skipLedger: opts.fresh,
      platform: opts.probe?.platform,
      env: opts.probe?.env,
    })
    if (opts.fresh) await rememberFreshResults(resolution, opts.configDir)
    return {
      declared: resolution.manifest !== undefined,
      manifestPath: resolution.manifestPath,
      side: resolution.side,
      ok: resolution.ok,
      tools: resolution.tools,
    }
  } catch (error) {
    return { declared: false, side: opts.side, ok: false, tools: [], error: (error as Error)?.message ?? String(error) }
  }
}

export async function toolchainSet(opts: ToolchainRpcOptions & { id: string; path: string }): Promise<ToolchainStatusView> {
  await recordToolchainPath({ id: opts.id, path: opts.path, configDir: opts.configDir })
  // 记完再核一遍账:UI 拿到的是落账后的真实状态,而不是"大概成功了"。注意 local
  // 覆盖(toolchain.local.json)仍然压过刚写的账本条目 —— 那是解析顺序的既有语义,
  // 结果里的 source 字段会如实说明是谁赢了。
  return toolchainStatus(opts)
}
