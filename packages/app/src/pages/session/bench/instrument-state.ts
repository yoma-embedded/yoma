import { createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { KernelParams, ToolPart } from "@yoma-desktop/kernel"
import { kernel } from "@/utils/kernel"
import type { BenchStatus } from "./bench-status"

// Live observations are view state, never synthetic messages in the conversation.
// Keep only the latest reply for each instrument in a bounded set of sessions.
const cache = createRoot(() => {
  const [state, setState] = createStore<Record<string, { log?: ToolPart; gdb?: ToolPart } | undefined>>({})
  const recent = new Set<string>()
  return {
    state,
    put(sessionID: string, tool: "log" | "gdb", part: ToolPart) {
      recent.delete(sessionID)
      recent.add(sessionID)
      if (!state[sessionID]) setState(sessionID, {})
      setState(sessionID, tool, reconcile(part))
      if (recent.size > 32) {
        const oldest = recent.values().next().value!
        recent.delete(oldest)
        setState(oldest, undefined)
      }
    },
  }
})

export async function executeInstrument(params: KernelParams<"instrument.execute">) {
  const result = await kernel.instrument.execute(params)
  const at = Date.now()
  cache.put(params.sessionID, params.tool, {
    type: "tool",
    id: `instrument-${params.tool}`,
    messageID: "",
    sessionID: params.sessionID,
    callID: `instrument-${params.tool}`,
    tool: params.tool,
    state: {
      status: "completed",
      input: structuredClone(params.input),
      output: result.text,
      title: params.tool,
      metadata: structuredClone(result.details ?? {}),
      time: { start: at, end: at },
    },
  })
  return result
}

export function instrumentObservations(sessionID: string | undefined, recorded: BenchStatus): ToolPart[] {
  if (!sessionID) return []
  const current = cache.state[sessionID]
  if (!current) return []
  return (["log", "gdb"] as const).flatMap((tool) => {
    const part = current[tool]
    if (!part || part.state.status !== "completed") return []
    // A newer agent operation supersedes an earlier UI observation.
    return part.state.time.end >= (recorded[tool]?.at ?? 0) ? [part] : []
  })
}
