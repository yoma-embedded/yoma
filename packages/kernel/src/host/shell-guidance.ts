/**
 * bash 工具的两处宿主加码(docs/调试留痕-规划-20260924.md §8;bash 是上游锁定的发动机代码,只能在装配面上包一层):
 *
 * 1. **描述里写"别在 shell 里递归扫目录"**。照 CC:它把"Avoid using this tool to run find / grep … use Glob / Grep"写在
 *    Bash 工具自己的描述里,而不只在系统提示词里 —— 模型决定用哪个工具时看的是工具描述。只在这个会话手上真有
 *    grep / find / ls 时才写(子 agent 的工具池按 profile 裁过,提到它没有的工具只会让它空转一次)。
 * 2. **子 agent 的 bash 缺省 120 秒超时**:模型没传 timeout 就补上,描述与参数说明跟着改(上游写的是"没有缺省超时")。
 *    主会话的 bash 不动(用户定)。CC 的 Bash 对所有 agent 缺省 2 分钟,超时转后台;这里超时就是杀掉、把
 *    "Command timed out" 交回模型,让它换个窄一点的搜法。
 *
 * 2026-09-24 真跑撞出来的:一个 Explore 子 agent 在 grep 工具用不了(worktree 里没有 rg)之后,从工作区根上跑
 * `grep -rn … . | grep -v node_modules`(过滤的是输出,不是遍历),276 秒一个字没出,直到界面上被停掉。
 */
import type { RegisteredTool } from "./tools/index.ts"

/** 子 agent 的 bash 没给 timeout 时的缺省值(秒),与 powershell 工具的缺省一样。 */
export const SUBAGENT_BASH_TIMEOUT_SECONDS = 120

const FINDERS = ["grep", "find", "ls"] as const

/** bash 描述末尾那段:别递归扫,用哪几个工具;它们也不行时怎么扫才不会卡死。 */
export function bashSearchNote(finders: readonly string[]): string {
  const tools = `${finders.join(", ")} tool${finders.length > 1 ? "s" : ""}`
  return (
    `IMPORTANT: Do not run recursive file searches or listings with this tool (find, grep -r/-R, du, ls -R, tree over a ` +
    `directory tree) — use the ${tools} instead: they are fast and skip .gitignore'd paths. Only if they fail, exclude ` +
    `node_modules, .git and build output (e.g. grep -r --exclude-dir=node_modules --exclude-dir=.git) and set the timeout ` +
    `parameter: on Windows such a scan can run for many minutes without printing anything.`
  )
}

/**
 * 给这个会话最终的工具表套上两处加码。`activeToolNames` 是这一轮真正交给模型的名字(决定引导里点哪几个工具),
 * `subagent` 是"按 profile 装配的子会话"(fork 不算:它的工具定义要与主会话逐字相同,供应商的缓存才命中)。
 */
export function withShellGuidance(
  tools: RegisteredTool[],
  options: { activeToolNames: readonly string[]; subagent: boolean },
): RegisteredTool[] {
  const finders = FINDERS.filter((name) => options.activeToolNames.includes(name))
  return tools.map((tool) => {
    if (tool.name !== "bash") return tool
    let next = tool
    if (finders.length > 0) next = { ...next, description: `${next.description}\n\n${bashSearchNote(finders)}` }
    if (options.subagent) next = withDefaultTimeout(next, SUBAGENT_BASH_TIMEOUT_SECONDS)
    return next
  })
}

/** 没给 timeout(或给了 null)就补上缺省值;描述与参数说明跟着说实话。别的参数原样交给工具自己的归一。 */
export function withDefaultTimeout(tool: RegisteredTool, seconds: number): RegisteredTool {
  const schema = tool.parameters as { properties?: Record<string, Record<string, unknown>> }
  const timeout = schema.properties?.timeout
  const parameters = timeout
    ? {
        ...schema,
        properties: {
          ...schema.properties,
          timeout: { ...timeout, description: `Timeout in seconds (default ${seconds} in this agent)` },
        },
      }
    : schema
  const prepare = tool.prepareArguments
  return {
    ...tool,
    description:
      `${tool.description}\n\nIn this agent, commands without a timeout are stopped after ${seconds} seconds — ` +
      `pass timeout (in seconds) for anything that needs longer.`,
    parameters: parameters as RegisteredTool["parameters"],
    prepareArguments: (raw: unknown) => {
      const args = prepare ? prepare(raw) : raw
      if (!args || typeof args !== "object" || Array.isArray(args)) return args
      const current = (args as { timeout?: unknown }).timeout
      return current === undefined || current === null ? { ...(args as Record<string, unknown>), timeout: seconds } : args
    },
  }
}
