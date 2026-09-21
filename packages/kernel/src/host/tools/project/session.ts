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
  return {
    ...PROJECT_CONTRACT,
    execute: async (_id, input, _onUpdate, toolContext, _invocation, ctx) => {
      ctx.abortSignal?.throwIfAborted()
      const cwd = toolContext.env.cwd
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
        case "configure":
          if (!input.profile) throw new Error("configure requires profile")
          result = summary(await saveProfile(cwd, input.revision ?? "", input.profile))
          break
        case "remember":
          if (!input.memory) throw new Error("remember requires memory")
          result = summary(
            await saveMemory(
              cwd,
              input.revision ?? "",
              input.memory,
              options.sessionID ? `session:${options.sessionID}` : "agent",
            ),
          )
          break
        case "forget":
          if (!input.id) throw new Error("forget requires id")
          result = summary(await forgetMemory(cwd, input.revision ?? "", input.id))
          break
        default:
          throw new Error("Unknown project action")
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { action: input.action } }
    },
  }
}
