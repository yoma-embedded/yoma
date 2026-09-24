/**
 * 一个会话的 harness 事件 → 轨迹行(docs/调试留痕-规划-20260924.md §3.2)。
 *
 * 独立订阅,不塞进 session-manager 的 subscribe:那边管界面上的状态与投影,这边只管落盘,互不牵连;
 * 每段的起点自己记(从何时开始等模型、这次请求何时开的流、每个工具何时开跑),不依赖两个订阅谁先谁后。
 * 只记元数据:耗时、字数、token、停止原因、工具名与一行摘要 —— 不记对话正文与工具输出。
 *
 * 忙时每 30 s 写一行 `busy`(此刻的阶段、在跑的工具已跑多久、多久没出字):卡住的那一刻就留下证据,
 * 哪怕随后用户把 app 关了、这一轮永远等不到 run.end。
 */

import type { AgentHarness, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { contentKindOf, type ActivityTracker } from "../activity.ts"
import type { Trace } from "./sink.ts"
import { toolSummary } from "./summary.ts"

export interface HarnessTraceOptions {
  trace: Trace
  sessionID: string
  /** 子 agent 的会话:派它的主会话。 */
  parentID?: string
  /** 子 agent 的类型(general-purpose / Explore / fork …)。 */
  agent?: string
  model?: { providerID: string; modelID: string; thinking?: string }
  /** 界面那台状态机的现状(host/activity.ts),忙时心跳里写阶段用。 */
  activity?: () => ActivityTracker | undefined
  now?: () => number
  /** 忙时心跳的间隔,缺省 30 s。 */
  heartbeatMs?: number
}

/** 订阅一个会话的 harness,返回退订函数(并进 entry.unsubscribes)。轨迹关着时什么都不订。 */
export function traceHarness(
  harness: AgentHarness<ExecutionToolContext>,
  options: HarnessTraceOptions,
): Array<() => void> {
  const { trace } = options
  if (!trace.enabled) return []
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const base = { s: options.sessionID, ...(options.parentID ? { parent: options.parentID } : {}) }

  /** 从什么时候开始等模型(一轮开始、这一批工具跑完、重试的下一次尝试、轮中压缩做完)。 */
  let waitingSince: number | undefined
  let run: { id: string; startedAt: number } | undefined
  /** 这一次请求:流何时打开(响应头已到)、第一个内容增量到了没有。 */
  let llm: { startedAt: number; first: boolean } | undefined
  const tools = new Map<string, { tool: string; startedAt: number; lastOutput?: number }>()
  let compactionStartedAt: number | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }
  const beat = () => {
    if (!run) return
    const at = now()
    const activity = options.activity?.()?.activity
    // 这一轮没等到 run_end 就被宣告失败了(drive 自己抛了,SessionManager.fail 清掉了阶段):别再每 30 s 报"忙"
    if (options.activity && !activity) {
      stopHeartbeat()
      run = undefined
      return
    }
    trace.write("busy", {
      ...base,
      run: run.id,
      run_ms: at - run.startedAt,
      phase: activity?.phase,
      phase_ms: activity ? at - activity.since : undefined,
      tools: tools.size
        ? [...tools.entries()].map(([tc, tool]) => ({
            tc,
            tool: tool.tool,
            ms: at - tool.startedAt,
            quiet_ms: at - (tool.lastOutput ?? tool.startedAt),
          }))
        : undefined,
    })
  }

  trace.write("session.open", {
    ...base,
    agent: options.agent,
    model: options.model ? `${options.model.providerID}/${options.model.modelID}` : undefined,
    thinking: options.model?.thinking,
  })

  return [
    stopHeartbeat,
    harness.events.on("run_start", (event) => {
      const at = now()
      run = { id: event.runId, startedAt: at }
      waitingSince = at
      llm = undefined
      tools.clear()
      trace.write("run.start", { ...base, run: event.runId })
      stopHeartbeat()
      heartbeat = setInterval(beat, heartbeatMs)
      heartbeat.unref?.()
    }),
    harness.events.on("run_end", (event) => {
      trace.write("run.end", {
        ...base,
        run: event.runId,
        status: event.status,
        ms: run ? now() - run.startedAt : undefined,
        error: event.status === "failed" ? event.error.message : undefined,
      })
      stopHeartbeat()
      run = undefined
      llm = undefined
      waitingSince = undefined
      tools.clear()
    }),
    harness.events.on("message_start", (event) => {
      const message = event.message
      if (message.role !== "assistant") return
      const at = now()
      llm = { startedAt: at, first: false }
      trace.write("llm.start", {
        ...base,
        run: event.runId,
        model: `${message.provider}/${message.model}`,
        wait_ms: waitingSince === undefined ? undefined : at - waitingSince,
      })
    }),
    harness.events.on("message_update", (event) => {
      if (!llm || llm.first || event.message.role !== "assistant") return
      const kind = contentKindOf(event.event.type)
      if (!kind) return
      llm.first = true
      trace.write("llm.first", { ...base, run: event.runId, kind, time_to_first_chunk_ms: now() - llm.startedAt })
    }),
    harness.events.on("message_end", (event) => {
      const message = event.message
      if (message.role !== "assistant") return
      let thinkingChars = 0
      let textChars = 0
      const called: string[] = []
      for (const block of message.content) {
        if (block.type === "thinking") thinkingChars += block.thinking.length
        else if (block.type === "text") textChars += block.text.length
        else if (block.type === "toolCall") called.push(block.name)
      }
      const usage = message.usage
      trace.write("llm.end", {
        ...base,
        run: event.runId,
        ms: llm ? now() - llm.startedAt : undefined,
        stop_reason: message.stopReason,
        error: message.errorMessage,
        input_tokens: usage?.input,
        output_tokens: usage?.output,
        cache_read_tokens: usage?.cacheRead,
        reasoning_tokens: (usage as { reasoning?: number } | undefined)?.reasoning,
        thinking_chars: thinkingChars,
        text_chars: textChars,
        tools: called.length ? called : undefined,
      })
      llm = undefined
    }),
    harness.events.on("tool_start", (event) => {
      tools.set(event.toolCallId, { tool: event.toolName, startedAt: now() })
      trace.write("tool.start", {
        ...base,
        run: event.runId,
        tc: event.toolCallId,
        tool: event.toolName,
        summary: toolSummary(event.toolName, event.args),
      })
    }),
    harness.events.on("tool_update", (event) => {
      const tool = tools.get(event.toolCallId)
      if (tool) tool.lastOutput = now()
    }),
    harness.events.on("tool_end", (event) => {
      const tool = tools.get(event.toolCallId)
      const at = now()
      tools.delete(event.toolCallId)
      trace.write("tool.end", {
        ...base,
        run: event.runId,
        tc: event.toolCallId,
        tool: event.toolName,
        ms: tool ? at - tool.startedAt : undefined,
        error: event.isError,
        out_chars: outputChars(event.result),
      })
      if (tools.size === 0) waitingSince = at
    }),
    harness.events.on("retry_scheduled", (event) => {
      trace.write("retry.scheduled", {
        ...base,
        run: event.runId,
        attempt: event.attempt,
        max: event.maxAttempts,
        delay_ms: event.delayMs,
        error: event.errorMessage,
      })
    }),
    harness.events.on("retry_start", (event) => {
      waitingSince = now()
      trace.write("retry.start", { ...base, run: event.runId, attempt: event.attempt })
    }),
    harness.events.on("retry_end", (event) => {
      trace.write("retry.end", {
        ...base,
        run: event.runId,
        attempt: event.attempt,
        success: event.success,
        error: event.finalError,
      })
    }),
    harness.events.on("compaction_start", (event) => {
      compactionStartedAt = now()
      trace.write("compaction.start", { ...base, run: event.runId, reason: event.reason })
    }),
    harness.events.on("compaction_end", (event) => {
      const at = now()
      trace.write("compaction.end", {
        ...base,
        run: event.runId,
        reason: event.reason,
        status: event.status,
        ms: compactionStartedAt === undefined ? undefined : at - compactionStartedAt,
        error: event.status === "failed" ? event.error.message : undefined,
      })
      compactionStartedAt = undefined
      if (run) waitingSince = at
    }),
    harness.events.on("config_update", (event) => {
      if (event.property === "model") {
        trace.write("session.config", { ...base, model: `${event.value.provider}/${event.value.modelId}` })
      } else if (event.property === "thinkingLevel") {
        trace.write("session.config", { ...base, thinking: event.value })
      }
    }),
    harness.events.on("fault", (event) => {
      trace.write("fault", { ...base, code: event.code, message: event.message })
    }),
    harness.events.on("handler_error", (event) => {
      trace.write("handler_error", { ...base, kind: event.kind, message: event.error })
    }),
  ]
}

/** 工具结果里文本的总字数(不记内容)。 */
function outputChars(result: { content?: Array<{ type: string; text?: string }> } | undefined): number | undefined {
  if (!result?.content) return undefined
  let total = 0
  for (const block of result.content) if (block.type === "text" && typeof block.text === "string") total += block.text.length
  return total
}
