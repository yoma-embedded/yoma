/**
 * agent 卡片的纯函数层 —— 一次 `agent` 工具调用(派一个子 agent)→ 卡片上要说的话。
 *
 * 三个来源,按新鲜程度排:
 * 1. **实时任务**(`task.updated` 事件折出来的 TaskView,宿主给的):后台子 agent 在工具调用交回之后还在跑,
 *    卡片的灯要跟着它走,只有这一份知道"现在";
 * 2. **details**(`AgentDetails`,工具结果或进度那一拍带的快照):前台跑的时候每一轮、每个工具都更新;
 * 3. **入参**(description / prompt / subagent_type):参数还在流式拼接时只有它。
 *
 * 防御式解析:认不出就返回 undefined,组件回落到通用卡 —— 旧会话的 details 可能是上一个版本的形状。
 */
import type { TaskView } from "@yoma-desktop/kernel"

/**
 * - `launching`:参数还在拼(工具 pending);
 * - `background`:已经派到后台、而手上没有它的实时状态(内核重启过、或任务不属于这个窗口)——
 *   不假装知道它在跑,结果看通知;
 * - 其余与任务状态同词。
 */
export type AgentCardState = "launching" | "pending" | "running" | "background" | "completed" | "failed" | "killed"

export interface AgentCard {
  agent: string
  description: string
  prompt: string
  state: AgentCardState
  background: boolean
  /** = 子会话 id。参数还在拼时没有。 */
  taskID?: string
  turns?: number
  toolUses?: number
  lastTool?: string
  durationMs?: number
  totalTokens?: number
  outputFile?: string
  maxTurnsReached?: boolean
  /** 前台跑完交回的正文(剥掉 agentId / usage 尾巴);后台派出时没有。 */
  result?: string
  /** 子 agent 跑完了却一个字没说(CC 的占位句)。 */
  emptyResult?: boolean
}

/** 前台结果末尾的尾巴(工具原话,host/tools/agent/session.ts 的 continueTrailer):给模型的,卡片不画。 */
const TRAILER =
  /\n?agentId: \S+ \(use send_message with to: '[^']*' to continue this agent\)\n<usage>[\s\S]*?<\/usage>\s*$/
/** 前台跑完却没有文字时工具交回的占位句(host/domain/agents/finalize.ts 的 EMPTY_RESULT_MARKER)。 */
const EMPTY_RESULT = "(Subagent completed but returned no output.)"
/** 后台派出 / 前台转后台时的回复开头(asyncLaunchedText)。 */
const LAUNCHED = "Async agent launched successfully."

const STATES: ReadonlySet<string> = new Set(["pending", "running", "completed", "failed", "killed"])

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 前台结果正文:剥掉尾巴;占位句单独标出来。 */
export function agentResultText(output: string | undefined): { text?: string; empty?: boolean } {
  if (!output || output.startsWith(LAUNCHED)) return {}
  const text = output.replace(TRAILER, "").trim()
  if (!text) return {}
  if (text === EMPTY_RESULT) return { empty: true }
  return { text }
}

export function describeAgent(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined,
  status: string | undefined,
  live?: TaskView,
): AgentCard | undefined {
  const args = record(input)
  const details = record(metadata)
  const description = str(details.description) ?? str(args.description) ?? live?.description
  const prompt = str(args.prompt) ?? ""
  // 连一句描述都没有、也不是还在拼参数:这不是一次认得出来的 agent 调用。
  if (!description && status !== "pending") return undefined

  const usage = record(details.usage)
  const card: AgentCard = {
    agent: live?.agent ?? str(details.agent) ?? str(args.subagent_type) ?? "general-purpose",
    description: description ?? "",
    prompt,
    state: "launching",
    background: live?.background ?? details.background === true,
  }
  const taskID = live?.id ?? str(details.taskID)
  if (taskID) card.taskID = taskID
  const outputFile = live?.outputFile ?? str(details.outputFile)
  if (outputFile) card.outputFile = outputFile

  const turns = live?.turns ?? num(details.turns)
  if (turns !== undefined) card.turns = turns
  const toolUses = live?.usage.toolUses ?? num(usage.toolUses)
  if (toolUses !== undefined) card.toolUses = toolUses
  const lastTool = live?.lastTool ?? str(details.lastTool)
  if (lastTool) card.lastTool = lastTool
  const durationMs = live?.usage.durationMs ?? num(usage.durationMs)
  if (durationMs !== undefined) card.durationMs = durationMs
  const totalTokens = live?.usage.totalTokens ?? num(usage.totalTokens)
  if (totalTokens !== undefined && totalTokens > 0) card.totalTokens = totalTokens
  if (live?.maxTurnsReached || details.maxTurnsReached === true) card.maxTurnsReached = true

  const snapshot = str(details.status)
  if (status === "pending") card.state = "launching"
  else if (live) card.state = live.status
  else if (status === "running") card.state = snapshot === "pending" ? "pending" : "running"
  else if (card.background && snapshot !== undefined && (snapshot === "pending" || snapshot === "running")) {
    // 派到后台之后这张卡片手上只有派出那一刻的快照:不假装它还在跑。
    card.state = "background"
  } else card.state = snapshot && STATES.has(snapshot) ? (snapshot as AgentCardState) : "completed"

  if (status === "completed" && !card.background) {
    const result = agentResultText(output)
    if (result.text) card.result = result.text
    if (result.empty) card.emptyResult = true
  }
  return card
}
