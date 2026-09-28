import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { forgetMemory, inspectProject, saveMemory, saveProfile } from "../../domain/project/store.ts"
import { searchMemories } from "../../domain/project/context.ts"
import { PROJECT_CONTRACT } from "./contract.ts"
import type { ProjectContextView } from "../../domain/project/model.ts"

/** Tool responses stay bounded and never expose disabled memories back to the model. */
function summary(view: ProjectContextView) {
  const enabled = searchMemories(view.memories, "", 20)
  return {
    ...view,
    memoryCount: view.memories.filter((item) => item.enabled).length,
    memories: enabled.map((item) => ({
      ...item,
      content: item.content.slice(0, 1000),
      evidence: item.evidence.slice(0, 400),
      truncated: item.content.length > 1000 || item.evidence.length > 400,
    })),
    baseline: view.baseline ? { ...view.baseline, output: view.baseline.output.slice(-2000) } : undefined,
    retrieval: "Latest 20 enabled memories, abbreviated. Use search with title or keywords for full relevant records.",
  }
}

export function createProjectTool(
  options: { sessionID?: string } = {},
): AgentHarnessTool<ExecutionToolContext, typeof PROJECT_CONTRACT.parameters> {
  /**
   * revision 是给"别人改过"用的乐观锁(界面、别的会话):撞上就得重读、对照着合并。**自己刚写的**不该算 ——
   * 发动机把同一条助手消息里的工具调用并行跑,一批里两条 remember 拿着同一个 revision,第二条必然撞上第一条
   * 写出来的新版本,模型只好再 inspect 一次重来(2026-09-28 真跑实测)。
   * 所以这个会话的调用排成一条队,并记下每次写入"之前 → 之后"的 revision:模型拿来的 revision 之后如果
   * 只有本会话自己写过,就顺着这条链换成当前的;中间夹着别人的改动,链接不上,照旧冲突。
   */
  const successors = new Map<string, string>()
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  const rebase = async (cwd: string, revision: string): Promise<string> => {
    if (!revision) return revision
    const current = (await inspectProject(cwd)).revision
    const seen = new Set<string>()
    let at = revision
    while (at !== current && !seen.has(at)) {
      seen.add(at)
      const next = successors.get(at)
      if (!next) return revision
      at = next
    }
    return at === current ? current : revision
  }
  /** 写一次:先按本会话自己的写入把 revision 顺过去,成功后记下这一跳。 */
  const write = async (cwd: string, revision: string, change: (base: string) => Promise<ProjectContextView>) => {
    const base = await rebase(cwd, revision)
    const view = await change(base)
    if (base && view.revision && view.revision !== base) successors.set(base, view.revision)
    return view
  }

  return {
    ...PROJECT_CONTRACT,
    execute: (_id, input, _onUpdate, toolContext, _invocation, ctx) =>
      serialize(async () => {
        ctx.abortSignal?.throwIfAborted()
        const cwd = toolContext.env.cwd
        const revision = input.revision ?? ""
        let result: unknown
        switch (input.action) {
          case "inspect":
            result = summary(await inspectProject(cwd))
            break
          case "search": {
            const view = await inspectProject(cwd)
            result = {
              root: view.root,
              revision: view.revision,
              warnings: view.warnings,
              memories: searchMemories(view.memories, input.query),
            }
            break
          }
          case "configure": {
            const profile = input.profile
            if (!profile) throw new Error("configure requires profile")
            result = summary(await write(cwd, revision, (base) => saveProfile(cwd, base, profile)))
            break
          }
          case "remember": {
            const memory = input.memory
            if (!memory) throw new Error("remember requires memory")
            const source = options.sessionID ? `session:${options.sessionID}` : "agent"
            result = summary(await write(cwd, revision, (base) => saveMemory(cwd, base, memory, source)))
            break
          }
          case "forget": {
            const id = input.id
            if (!id) throw new Error("forget requires id")
            result = summary(await write(cwd, revision, (base) => forgetMemory(cwd, base, id)))
            break
          }
          default:
            throw new Error("Unknown project action")
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { action: input.action } }
      }),
  }
}
