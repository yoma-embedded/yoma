/**
 * 子 agent 的工具池(docs/子agent-设计方案-v0.4-20260918.md §5.3)。
 *
 * 照 CC `agentToolUtils.ts` 的 resolveAgentTools:子 agent 的工具从全集按自己的定义重新筛,不继承父的。
 * 层次:
 *   ① 硬黑名单(定义无权覆盖):四个子 agent 工具 —— CC 的 ALL_AGENT_DISALLOWED_TOOLS(防递归;TaskStop 需要主线程的任务状态)。
 *   ② 硬件类:flash / log / la / scope / gdb 对所有子 agent 关闭 —— 探针租约、全局单例的采集库是进程级独占设备,
 *      十几个 agent 同时碰板子必撞(CC 挡 Tungsten 单例终端是同一个理由)。
 *   ③ 定义的 disallowedTools,④ 定义的 tools 白名单(undefined / ["*"] = 全给)。
 * 被筛掉的工具**根本不注册**进子 harness,不只是不激活。主 agent 不过 ①②。
 */

import type { AgentProfile } from "./profile.ts"

/** 四个子 agent 工具,顺序与 TOOL_NAMES 末尾一致。 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ["agent", "task_output", "task_stop", "send_message"]

/** 对所有子 agent 关闭的硬件工具。 */
export const HARDWARE_TOOL_NAMES: readonly string[] = ["flash", "log", "la", "scope", "gdb"]

function isWildcard(tools: readonly string[] | undefined): boolean {
  return !tools || (tools.length === 1 && tools[0] === "*")
}

/**
 * 子 agent 实际拿到哪些工具,按全集的顺序返回;`unknown` 是白名单里点了名、全集里却没有的(拼错或这台宿主没装)。
 */
export function resolveAgentTools(
  available: readonly string[],
  profile: Pick<AgentProfile, "tools" | "disallowedTools">,
): { tools: string[]; unknown: string[] } {
  const denied = new Set([...SUBAGENT_TOOL_NAMES, ...HARDWARE_TOOL_NAMES, ...(profile.disallowedTools ?? [])])
  const allowed = isWildcard(profile.tools) ? undefined : new Set(profile.tools)
  const tools = available.filter((name) => !denied.has(name) && (!allowed || allowed.has(name)))
  const unknown = allowed ? [...allowed].filter((name) => name !== "*" && !available.includes(name)) : []
  return { tools, unknown }
}

/**
 * agent 列表那一行括号里的工具说明,照 CC `prompt.ts` 的 getToolsDescription:白名单减黑名单 /
 * "All tools except …" / "All tools"。说的是定义本身;① ② 两层对所有子 agent 一样,由工具描述里的
 * 一句总说明交代,不在每一行重复。
 */
export function describeAgentTools(profile: Pick<AgentProfile, "tools" | "disallowedTools">): string {
  const allow = isWildcard(profile.tools) ? undefined : profile.tools
  const deny = profile.disallowedTools?.length ? profile.disallowedTools : undefined
  if (allow && deny) {
    const effective = allow.filter((name) => !deny.includes(name))
    return effective.length ? effective.join(", ") : "None"
  }
  if (allow) return allow.join(", ")
  if (deny) return `All tools except ${deny.join(", ")}`
  return "All tools"
}
