/**
 * /btw 顺便问一句的纯函数部分(docs/btw顺便问-设计方案-20260924.md)。
 *
 * agent 干着活时用户顺手问一句:拿主会话此刻的上下文,末尾追加一条包好的问题,旁路单发一次模型调用 ——
 * 不占 lane、不写 JSONL、问答不进对话历史。照 CC 2.1.88 的 `utils/sideQuestion.ts` 与 `commands/btw/btw.tsx`;
 * "转成后台任务"照 CC 的 fork(2.1.88 的 `tools/AgentTool/forkSubagent.ts` + 文档里 v2.1.206 起的规则)。
 * 读会话、调模型、发事件在 session-manager。
 *
 * **请求前缀必须和主轮逐字相同**,供应商的前缀缓存才会命中(长会话十万 token,命中与否差着十倍的价钱)。所以:
 * - 上下文的拼法照抄发动机的 `buildSessionContext`(`packages/agent/src/harness/session/context.ts`,没有导出),
 *   工具与请求选项照抄 `drive/generation.ts` 与 `execution/assistant.ts` —— 上游一改,session-btw.test.ts 的逐字比对先红;
 * - 只动尾巴:最后一条 assistant 里还没出结果的工具调用补一条"还在运行",再追加问题。
 */

import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type AgentHarnessStreamOptions,
  type AgentMessage,
  type Entry as SessionEntry,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ImageContent, SimpleStreamOptions, Tool, ToolCall } from "@earendil-works/pi-ai"

import type { BtwView } from "../types.ts"

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

/** 发动机拼上下文时滤掉的三种 assistant(`harness/session/context.ts` 的 isContextMessage)。 */
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
  )
}

/**
 * 分支条目 → 模型上下文,逐字照抄发动机的 `buildContextEntries` + `sessionEntryToContextMessages`。入参是
 * `lane.findEntries({ stopAtType: "compaction", order: "newestFirst" })` 反转成的**时间正序**(与 `readBoundedEntries`
 * 同一个扫法)。custom 条目给空:宿主没配 entryProjectors。
 */
export function contextMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  let start = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      start = index
      break
    }
  }
  return entries.slice(start).flatMap((entry): AgentMessage[] => {
    switch (entry.type) {
      case "message":
        return isContextMessage(entry.message) ? [entry.message] : []
      case "compaction":
        return [
          createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
          ...entry.retainedTail.filter(isContextMessage),
        ]
      case "branch_summary":
        return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : []
      case "custom":
        return []
    }
  })
}

/**
 * 占位的工具结果。主轮下一次请求会带真结果;/btw 只需要模型知道"还没出来" —— 不补的话 pi-ai 会补一条
 * `isError: true` 的 "No result provided",模型据此就会说"那个工具失败了"。
 */
export const RUNNING_TOOL_PLACEHOLDER =
  "This tool call is still running in the main conversation; its result is not available yet."

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>

/**
 * 最后一条 assistant 里还没有结果的工具调用,紧跟在它已有的结果后面各补一条占位结果。**只动这一条**:历史中间
 * 悬空的调用(被中止的旧轮)主轮与 /btw 发出去时都会被 pi-ai 补成一样的东西,前缀照样逐字相同。
 */
export function settleRunningToolCalls(messages: readonly AgentMessage[], now = Date.now()): AgentMessage[] {
  let last = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") {
      last = index
      break
    }
  }
  const assistant = messages[last]
  if (!assistant || assistant.role !== "assistant") return [...messages]
  const calls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall")
  let end = last + 1
  const answered = new Set<string>()
  while (end < messages.length && messages[end]!.role === "toolResult") {
    answered.add((messages[end] as ToolResult).toolCallId)
    end++
  }
  const pending = calls.filter((call) => !answered.has(call.id))
  if (pending.length === 0) return [...messages]
  const placeholders = pending.map(
    (call): ToolResult => ({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: RUNNING_TOOL_PLACEHOLDER }],
      isError: false,
      timestamp: now,
    }),
  )
  return [...messages.slice(0, end), ...placeholders, ...messages.slice(end)]
}

// ---------------------------------------------------------------------------
// 问题与请求
// ---------------------------------------------------------------------------

/** CC 2.1.88 `utils/sideQuestion.ts` 的原话,一字不改。工具定义照带(缓存键),所以"没有工具"要靠这段话说清楚。 */
export function wrapSideQuestion(question: string): string {
  return `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`
}

/** 一条 user 消息:正文在前、图片在后(与 `lane.prompt(text, images)` 拼出来的同形)。 */
export function userMessage(text: string, images: readonly ImageContent[] = [], now = Date.now()): AgentMessage {
  return { role: "user", content: [{ type: "text", text }, ...images], timestamp: now }
}

/** 正文 + 图片处理的说明(与 `prompt()` 同一个拼法:说明跟着消息进模型)。 */
export function withNotes(text: string, notes: readonly string[]): string {
  return notes.length > 0 ? `${text}\n\n${notes.join("\n")}` : text
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Tool["parameters"]
  constrainedSampling?: Tool["constrainedSampling"]
}

/** 与主轮同一份工具定义、同一个顺序(`drive/generation.ts` 的 prepareGeneration)。照带不执行:少一个,前缀就对不上。 */
export function requestTools(tools: readonly ToolDefinition[], activeNames: readonly string[]): Tool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return activeNames.flatMap((name) => {
    const tool = byName.get(name)
    if (!tool) return []
    return [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
      },
    ]
  })
}

/**
 * 请求选项:照 `createRequestOptions`(`harness/execution/assistant.ts`)取同样几个字段,再补发动机真正发出去时加的
 * `sessionId`(`<会话 id>:<lane 名>`,`drive/generation.ts`)—— pi-ai 拿它做会话亲和头与 OpenAI 的 `prompt_cache_key`,
 * 也就是缓存路由。不给 `deferred`:旁路调用没有人去取异步结果。
 */
export function requestOptions(input: {
  streamOptions: AgentHarnessStreamOptions
  thinkingLevel: ThinkingLevel
  sessionId: string
  signal: AbortSignal
}): SimpleStreamOptions {
  const options = input.streamOptions
  const thinkingLevel = input.thinkingLevel
  return {
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxRetryDelayMs: options.maxRetryDelayMs,
    headers: options.headers,
    metadata: options.metadata,
    cacheRetention: options.cacheRetention,
    ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
    sessionId: input.sessionId,
    signal: input.signal,
  }
}

// ---------------------------------------------------------------------------
// 答案
// ---------------------------------------------------------------------------

/** 所有 text 块用空行拼起来(CC 的 extractSideQuestionResponse);thinking 不要。流式快照与最终答案同一个取法。 */
export function answerText(message: Pick<AssistantMessage, "content">): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim()
}

export type BtwOutcome = Pick<BtwView, "status" | "text" | "attemptedTool" | "error">

/**
 * 最终答案 → 这条顺便问怎么收场(照 CC 的 extractSideQuestionResponse):有字就是答了;没字但想调工具,说一声它
 * 想调哪个(没有执行);供应商报错带原话;被取消;什么都没有 = 失败且没有原因(界面说"没有收到回答")。
 */
export function settleAnswer(message: AssistantMessage): BtwOutcome {
  const text = answerText(message)
  if (message.stopReason === "aborted") return { status: "cancelled", text }
  if (message.stopReason === "error") return { status: "failed", text, error: message.errorMessage || "request failed" }
  if (text) return { status: "done", text }
  const call = message.content.find((block): block is ToolCall => block.type === "toolCall")
  if (call) return { status: "done", text: "", attemptedTool: call.name }
  return { status: "failed", text: "" }
}

// ---------------------------------------------------------------------------
// 转成后台子 agent(fork)
// ---------------------------------------------------------------------------

/** CC 的标签(`constants/xml.ts`):界面按它认出 fork 的指令消息,只画指令那一段。 */
export const FORK_BOILERPLATE_TAG = "fork-boilerplate"
export const FORK_DIRECTIVE_PREFIX = "Your directive: "

/**
 * 转成后台任务时交给 fork 的指令。CC 没有公开 /btw 转 fork 的原话,这句是 yoma 自拟的:说清楚前面那个答案是
 * 没用工具、只凭对话答的,接下来用工具核对、补全、纠正。
 */
export const BTW_FORK_DIRECTIVE =
  "The user asked the side question above, and it was answered from the conversation alone, without tools. " +
  "Continue from there with your tools: check the answer against the actual project files and toolchain, " +
  "fill in what it could not know, and correct it if it was wrong."

/**
 * fork 的守则,照 CC 2.1.88 的 `buildChildMessage`,改了三处:第 1 条改成"不许派子 agent"并点名会被拒的两类工具
 * (yoma 的子会话本来就不能再派,硬件工具对所有子 agent 关闭);第 5 条"改了文件先 commit"改成"列出来、不要
 * commit"(仓里的规矩:git 操作等用户说);第 4 条的工具名换成 yoma 的。报告格式原样保留。
 */
export function forkDirectiveText(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Do NOT spawn sub-agents; execute directly. In a fork the sub-agent tools (agent, task_output, task_stop, send_message) and the hardware tools (flash, log, la, scope, gdb) are rejected.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: bash, read, grep, find, and the rest.
5. If you modify files, list them under "Files changed". Do NOT commit.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * 带 `<fork-boilerplate>` 的消息只剩指令那一段(界面画 fork 的指令消息用,照 CC 单独渲染的做法);认不出就 undefined。
 */
export function forkDirectiveOf(text: string): string | undefined {
  if (!text.includes(`<${FORK_BOILERPLATE_TAG}>`)) return undefined
  const at = text.lastIndexOf(FORK_DIRECTIVE_PREFIX)
  return at < 0 ? undefined : text.slice(at + FORK_DIRECTIVE_PREFIX.length).trim()
}

/**
 * fork 首轮的整串消息:主会话此刻的上下文(已补好占位)+ 用户的问题(不带 /btw 的 `<system-reminder>` —— 那段
 * "不许用工具"会和 fork 的目的冲突)+ /btw 的答案 + 指令。答案只留正文:签名、思考、响应 id 属于另一次请求,
 * 原样搬进新会话会被当成可续接的状态;用量留着,发动机估上下文大小靠最后一条 assistant 的用量。
 */
export function forkSeed(input: {
  context: readonly AgentMessage[]
  question: string
  images: readonly ImageContent[]
  answer: AssistantMessage
  now?: number
}): AgentMessage[] {
  const now = input.now ?? Date.now()
  const answer: AssistantMessage = {
    role: "assistant",
    content: input.answer.content.flatMap((block) =>
      block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
    ),
    api: input.answer.api,
    provider: input.answer.provider,
    model: input.answer.model,
    usage: input.answer.usage,
    stopReason: "stop",
    timestamp: now,
  }
  return [
    ...input.context,
    userMessage(input.question, input.images, now),
    answer,
    userMessage(forkDirectiveText(BTW_FORK_DIRECTIVE), [], now),
  ]
}
