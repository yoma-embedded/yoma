/**
 * 会话时间线与"卡在哪"的判断(docs/调试留痕-规划-20260924.md §3.6)。`npm run trace` 的逻辑,经叶子门
 * `@yoma-desktop/kernel/host/trace-report` 给 `scripts/trace.ts` 用。
 *
 * 两份材料:**会话 JSONL**(必有;上游 JsonlStorage 的 v4 格式)+ **轨迹**(trace.jsonl,有就合并)。会话里有每条消息
 * 与工具结果的时刻、token、推理字数、工具调用的完整参数;轨迹补上会话里没有的:工具真正的开跑时刻、请求发出与
 * 响应头的时刻、第一个字、keep-alive、确认条、内核被堵、忙时心跳。
 *
 * **只读**:自己按行解析,不经上游的 JsonlSessionRepo —— 它打开一个尾行撕裂的会话会改写文件。只用纯 JS,
 * 不拖发动机(这道门给命令行脚本用,不该把整个内核拉进来)。
 */

export interface ReportOptions {
  /** 超过多久算慢,缺省 20 s。 */
  slowMs?: number
}

export interface AssistantFact {
  /** 请求开始(pi-ai 在发请求前给消息打的时间戳)。 */
  at: number
  /** 这条回复落盘的时刻。 */
  end: number
  thinkingChars: number
  textChars: number
  outputTokens?: number
  reasoningTokens?: number
  stopReason?: string
  error?: string
  calls: Array<{ id: string; name: string }>
}

export interface ToolFact {
  id: string
  name: string
  /** 会话里没有开跑时刻:用发起它的那条回复的落盘时刻近似(工具在那之后才跑)。 */
  start?: number
  end: number
  isError: boolean
  outChars: number
  /** 一行摘要:命令 / 路径 / 模式……(从会话里的调用参数取,不需要轨迹)。 */
  summary?: string
}

export interface SessionFacts {
  id: string
  cwd?: string
  parentId?: string
  createdAt: number
  name?: string
  model?: string
  thinking?: string
  users: Array<{ at: number; text: string }>
  assistants: AssistantFact[]
  tools: ToolFact[]
  runs: Array<{ status: string; startedAt: number; endedAt: number; error?: string }>
  retries: Array<{ attempt: number; error: string }>
}

export type ParsedSession = { ok: true; session: SessionFacts } | { ok: false; reason: string }

export interface TraceLine {
  t: number
  ev: string
  [key: string]: unknown
}

type Rec = Record<string, unknown>

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export function parseSession(text: string): ParsedSession {
  const lines = text.split("\n")
  const header = safeJson(lines[0] ?? "") as Rec | undefined
  if (!header || header.kind !== "header" || header.v !== 4) {
    return { ok: false, reason: "不是 v4 格式的会话文件(更早的 v3 会话不支持)" }
  }
  const session: SessionFacts = {
    id: String(header.id ?? ""),
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    parentId: typeof header.parentSessionId === "string" ? header.parentSessionId : undefined,
    createdAt: Number(header.createdAt) || 0,
    users: [],
    assistants: [],
    tools: [],
    runs: [],
    retries: [],
  }
  /** 工具调用 id → 发起它的那条回复的落盘时刻与摘要。 */
  const calls = new Map<string, { end: number; summary?: string }>()

  for (let index = 1; index < lines.length; index++) {
    const parsed = safeJson(lines[index]!)
    if (parsed === undefined) continue // 空行或尾行撕裂
    for (const record of (Array.isArray(parsed) ? parsed : [parsed]) as Rec[]) {
      if (record.kind === "entry") readEntry(session, calls, record)
      else if (record.kind === "value" && record.op === "set") readValue(session, record)
    }
  }
  return { ok: true, session }
}

function readEntry(session: SessionFacts, calls: Map<string, { end: number; summary?: string }>, record: Rec): void {
  const message = record.message as Rec | undefined
  if (!message) return
  const at = Number(record.timestamp) || Number(message.timestamp) || 0
  if (message.role === "user") {
    session.users.push({ at, text: plainText(message.content) })
  } else if (message.role === "assistant") {
    const fact: AssistantFact = {
      at: Number(message.timestamp) || at,
      end: at,
      thinkingChars: 0,
      textChars: 0,
      calls: [],
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      error: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    }
    const usage = message.usage as Rec | undefined
    if (usage) {
      fact.outputTokens = Number(usage.output) || 0
      if (typeof usage.reasoning === "number") fact.reasoningTokens = usage.reasoning
    }
    for (const block of (Array.isArray(message.content) ? message.content : []) as Rec[]) {
      if (block.type === "thinking") fact.thinkingChars += String(block.thinking ?? "").length
      else if (block.type === "text") fact.textChars += String(block.text ?? "").length
      else if (block.type === "toolCall") {
        const id = String(block.id ?? "")
        fact.calls.push({ id, name: String(block.name ?? "?") })
        calls.set(id, { end: at, summary: argumentSummary(block.arguments) })
      }
    }
    session.assistants.push(fact)
  } else if (message.role === "toolResult") {
    const id = String(message.toolCallId ?? "")
    const call = calls.get(id)
    session.tools.push({
      id,
      name: String(message.toolName ?? "?"),
      start: call?.end,
      end: Number(message.timestamp) || at,
      isError: message.isError === true,
      outChars: plainText(message.content).length,
      summary: call?.summary,
    })
  }
}

function readValue(session: SessionFacts, record: Rec): void {
  const value = record.value as Rec | string | null | undefined
  switch (record.namespace) {
    case "pi.lane.config": {
      const config = value as Rec | undefined
      const model = config?.model as Rec | undefined
      if (model?.provider && model?.modelId) session.model = `${model.provider}/${model.modelId}`
      if (typeof config?.thinkingLevel === "string") session.thinking = config.thinkingLevel
      break
    }
    case "pi.session.name":
      if (typeof value === "string") session.name = value
      break
    case "pi.result": {
      const result = value as Rec | undefined
      if (result?.kind !== "run") break
      session.runs.push({
        status: String(result.status ?? "?"),
        startedAt: Number(result.startedAt) || 0,
        endedAt: Number(result.endedAt) || 0,
        error: errorText(result.error),
      })
      break
    }
    case "pi.op.state": {
      const state = value as Rec | undefined
      if (state?.at === "assistant.retry_wait") {
        session.retries.push({ attempt: Number(state.nextAttempt) || 0, error: String(state.errorMessage ?? "") })
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// 轨迹
// ---------------------------------------------------------------------------

export function parseTrace(text: string): TraceLine[] {
  const out: TraceLine[] = []
  for (const line of text.split("\n")) {
    const parsed = safeJson(line) as TraceLine | undefined
    if (parsed && typeof parsed.t === "number" && typeof parsed.ev === "string") out.push(parsed)
  }
  return out
}

/**
 * 这个会话的轨迹行(含 HTTP 那几行);`kernel.lag` 不分会话,按会话的时间段收;它的子 agent 被停(`stop.request` 的 parent
 * 是它)也收 —— 看主会话时要知道派出去的那个是谁停的。
 */
export function traceFor(lines: TraceLine[], session: SessionFacts): TraceLine[] {
  const span = sessionSpan(session)
  return lines
    .filter(
      (line) =>
        line.s === session.id ||
        (line.ev === "stop.request" && line.parent === session.id) ||
        (line.ev === "kernel.lag" && span !== undefined && line.t >= span[0] && line.t <= span[1] + 60_000),
    )
    .sort((a, b) => a.t - b.t)
}

/** `stop.request` 的 by → 人话(host/tasks.ts 的 StopRequester,加上主会话的停止键与"点了压缩")。 */
const STOP_BY: Record<string, string> = {
  ui: "用户在界面上按了停止",
  agent: "主 agent 调了 task_stop",
  parent: "主会话那次前台调用被停,子 agent 跟着停",
  delete: "会话被删除",
}

function stopRequester(line: TraceLine): string {
  if (line.by === "ui" && line.via === "compact") return "用户点了压缩,先停掉了这一轮"
  return STOP_BY[String(line.by)] ?? `来源不明(${String(line.by)})`
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

interface Row {
  at: number
  text: string
}

export function renderReport(session: SessionFacts, allTrace: TraceLine[] = [], options: ReportOptions = {}): string {
  const slowMs = options.slowMs ?? 20_000
  const trace = traceFor(allTrace, session)
  const t0 = session.createdAt || session.users[0]?.at || session.assistants[0]?.at || 0
  const rel = (at: number) => `${((at - t0) / 1000).toFixed(1).padStart(8)}s`
  const flag = (ms: number) => (ms >= slowMs ? "⚠ " : "  ")
  const rows: Row[] = []
  const findings: string[] = []

  const header = [
    `会话 ${session.id}${session.name ? ` · ${session.name}` : ""}`,
    `  目录 ${session.cwd ?? "?"} · 模型 ${session.model ?? "?"} · 思考档 ${session.thinking ?? "?"}` +
      (session.parentId ? ` · 子 agent,主会话 ${session.parentId}` : ""),
    `  开始于 ${t0 ? new Date(t0).toLocaleString() : "?"}` + (trace.length ? ` · 轨迹 ${trace.length} 行` : " · 没有轨迹(只看会话文件)"),
  ]

  for (const user of session.users) rows.push({ at: user.at, text: `用户    ${oneLine(user.text, 60)}` })

  // 模型:每条回复一行;轨迹里有的话补上"等了多久才开流、第一个字、HTTP 的状态与排队"
  const llmStarts = trace.filter((line) => line.ev === "llm.start")
  const llmFirsts = trace.filter((line) => line.ev === "llm.first")
  const httpReqs = trace.filter((line) => line.ev === "http.req")
  let modelMs = 0
  let longestFirst = 0
  for (const reply of session.assistants) {
    const ms = Math.max(0, reply.end - reply.at)
    modelMs += ms
    const tokPerSec = reply.outputTokens && ms > 0 ? Math.round((reply.outputTokens / ms) * 1000) : undefined
    const start = nearest(llmStarts, reply.at, reply.end)
    const first = start ? llmFirsts.find((line) => line.t >= start.t && line.t <= reply.end + 1_000) : undefined
    const firstMs = first ? first.t - reply.at : undefined
    if (firstMs !== undefined) longestFirst = Math.max(longestFirst, firstMs)
    const http = httpFor(trace, httpReqs, reply)
    const parts = [
      firstMs !== undefined ? `首字 ${seconds(firstMs)}(${String(first!.kind)})` : undefined,
      reply.thinkingChars ? `推理 ${reply.thinkingChars} 字` : undefined,
      reply.textChars ? `正文 ${reply.textChars} 字` : undefined,
      reply.outputTokens ? `${reply.outputTokens} tok${tokPerSec !== undefined ? `(${tokPerSec} tok/s)` : ""}` : undefined,
      http?.summary,
      reply.calls.length ? `→ ${reply.calls.map((call) => call.name).join(", ")}` : undefined,
      reply.error ? `✗ ${oneLine(reply.error, 80)}` : undefined,
    ].filter(Boolean)
    rows.push({ at: reply.at, text: `${flag(ms)}模型  ${seconds(ms).padStart(7)}  ${parts.join(" · ")}` })
    if (ms >= slowMs) findings.push(`模型 ${seconds(ms)}:${explainModel(reply, ms, firstMs, http)}`)
  }
  // 工具:轨迹里有 tool.start / tool.end 就用真时刻,否则用会话里的近似值
  const toolStarts = new Map(trace.filter((line) => line.ev === "tool.start").map((line) => [String(line.tc), line]))
  const toolEnds = new Map(trace.filter((line) => line.ev === "tool.end").map((line) => [String(line.tc), line]))
  let toolMs = 0
  let slowest: { name: string; ms: number } | undefined
  for (const tool of session.tools) {
    const traced = toolStarts.get(tool.id)
    const tracedEnd = toolEnds.get(tool.id)
    const start = traced?.t ?? tool.start ?? tool.end
    const end = tracedEnd?.t ?? tool.end
    const ms = Math.max(0, end - start)
    toolMs += ms
    if (!slowest || ms > slowest.ms) slowest = { name: tool.name, ms }
    const summary = tool.summary ?? (typeof traced?.summary === "string" ? traced.summary : undefined)
    const quiet = lastQuiet(trace, tool.id)
    const notes = [
      tool.isError ? "✗ 出错" : undefined,
      tool.outChars === 0 ? "没有输出" : `${tool.outChars} 字输出`,
      quiet !== undefined && quiet >= 10_000 ? `最后 ${seconds(quiet)} 没出字` : undefined,
      traced ? undefined : "(起点按回复落盘时刻估)",
    ].filter(Boolean)
    rows.push({
      at: start,
      text: `${flag(ms)}工具  ${seconds(ms).padStart(7)}  ${tool.name}  ${summary ? oneLine(summary, 90) : ""}  [${notes.join(" · ")}]`,
    })
    if (ms >= slowMs) findings.push(`工具 ${tool.name} ${seconds(ms)}:${explainTool(tool, summary, quiet)}`)
  }

  // 轮次、重试、确认、内核被堵
  for (const run of session.runs) {
    if (run.status === "completed") continue
    rows.push({
      at: run.endedAt,
      text: `  本轮  ${seconds(run.endedAt - run.startedAt).padStart(7)}  ${run.status === "aborted" ? "被中止" : `失败 ${oneLine(run.error ?? "", 80)}`}`,
    })
  }
  for (const line of trace) {
    if (line.ev === "retry.scheduled") {
      rows.push({ at: line.t, text: `  重试  第 ${line.attempt}/${line.max} 次,${seconds(Number(line.delay_ms) || 0)} 后:${oneLine(String(line.error ?? ""), 80)}` })
    } else if (line.ev === "confirm.done") {
      rows.push({ at: line.t, text: `${flag(Number(line.ms) || 0)}确认  ${seconds(Number(line.ms) || 0).padStart(7)}  ${String(line.outcome)}` })
    } else if (line.ev === "run.failed") {
      rows.push({ at: line.t, text: `✗ 本轮  没等到收尾就判失败:${oneLine(String(line.error ?? ""), 100)}` })
      findings.push(`这一轮没等到收尾就判失败(${rel(line.t).trim()}):${oneLine(String(line.error ?? ""), 120)}`)
    } else if (line.ev === "kernel.lag") {
      rows.push({ at: line.t, text: `⚠ 内核  事件循环被堵 ${seconds(Number(line.ms) || 0)}` })
      findings.push(`内核事件循环被堵 ${seconds(Number(line.ms) || 0)}(${rel(line.t).trim()}):那段时间所有会话的输出与界面请求一起停住`)
    } else if (line.ev === "stop.request") {
      const who = stopRequester(line)
      const child = line.s === session.id ? undefined : `子 agent ${String(line.s)}`
      rows.push({ at: line.t, text: `  停止  ${child ? `${child} · ` : ""}${who}` })
      findings.push(`${child ? `${child} ` : "这一轮"}被停止(${rel(line.t).trim()}):${who}`)
    }
  }
  if (!trace.length) {
    for (const retry of session.retries) findings.push(`重试第 ${retry.attempt} 次:${oneLine(retry.error, 100)}`)
  }

  // 最后一次心跳之后再没有 run.end:这一轮是卡着被关掉的
  const unfinished = unfinishedBusy(trace)
  if (unfinished) findings.push(unfinished)

  rows.sort((a, b) => a.at - b.at)
  const aborted = session.runs.filter((run) => run.status === "aborted").length
  const failed = session.runs.filter((run) => run.status === "failed").length
  const summary = [
    "汇总",
    `  模型 ${session.assistants.length} 次,共 ${seconds(modelMs)}` +
      (longestFirst ? `;首字最久 ${seconds(longestFirst)}` : ""),
    `  工具 ${session.tools.length} 次,共 ${seconds(toolMs)}` + (slowest ? `;最慢 ${slowest.name} ${seconds(slowest.ms)}` : ""),
    `  重试 ${session.retries.length} · 中止 ${aborted} · 失败 ${failed}` +
      (trace.length ? ` · 内核被堵 ${trace.filter((line) => line.ev === "kernel.lag").length} 次` : ""),
  ]
  const judged = findings.length ? ["判断", ...findings.map((line) => `  ⚠ ${line}`)] : ["判断", `  没有超过 ${seconds(slowMs)} 的步骤`]
  return [
    ...header,
    "",
    ...rows.map((row) => `${rel(row.at)}  ${row.text}`),
    "",
    ...summary,
    ...judged,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// 判断
// ---------------------------------------------------------------------------

interface HttpFacts {
  status?: number
  ttfbMs?: number
  keepalives?: number
  firstDataMs?: number
  waits: number
  outcome?: string
  summary: string
}

/** 这条回复对应的那次 HTTP 请求:发出时刻落在 [回复开始 − 2 s, 回复结束] 里、离回复开始最近的一个。 */
function httpFor(trace: TraceLine[], requests: TraceLine[], reply: AssistantFact): HttpFacts | undefined {
  const request = nearest(requests, reply.at - 2_000, reply.end, reply.at)
  if (!request) return undefined
  const req = request.req
  const res = trace.find((line) => line.ev === "http.res" && line.req === req)
  const end = trace.find((line) => line.ev === "http.end" && line.req === req)
  const waits = trace.filter((line) => line.ev === "http.wait" && line.req === req).length
  const facts: HttpFacts = {
    status: typeof res?.status_code === "number" ? res.status_code : undefined,
    ttfbMs: typeof res?.ms === "number" ? res.ms : undefined,
    keepalives: typeof end?.keepalives === "number" ? end.keepalives : undefined,
    firstDataMs: typeof end?.first_data_ms === "number" ? end.first_data_ms : undefined,
    waits,
    outcome: typeof end?.outcome === "string" ? end.outcome : undefined,
    summary: "",
  }
  facts.summary = [
    facts.status !== undefined ? `HTTP ${facts.status}` : undefined,
    facts.ttfbMs !== undefined ? `响应头 ${seconds(facts.ttfbMs)}` : undefined,
    facts.keepalives ? `keep-alive ${facts.keepalives} 行` : undefined,
    facts.outcome && facts.outcome !== "done" ? facts.outcome : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  return facts
}

function explainModel(reply: AssistantFact, ms: number, firstMs: number | undefined, http: HttpFacts | undefined): string {
  if (reply.error) return `请求出错(${oneLine(reply.error, 80)})`
  if (http?.keepalives && http.firstDataMs !== undefined && http.firstDataMs >= ms / 2) {
    return `响应头 ${seconds(http.ttfbMs ?? 0)} 就到了,之后 ${seconds(http.firstDataMs - (http.ttfbMs ?? 0))} 只有 keep-alive —— 供应商在排队`
  }
  if (http?.ttfbMs !== undefined && http.ttfbMs >= 10_000) return `响应头等了 ${seconds(http.ttfbMs)} —— 网络或供应商那头慢`
  if (firstMs !== undefined && firstMs >= ms / 2) return `流开了但第一个字等了 ${seconds(firstMs)}`
  const tokPerSec = reply.outputTokens ? (reply.outputTokens / ms) * 1000 : 0
  if (tokPerSec >= 20) {
    return `流一直在走(${Math.round(tokPerSec)} tok/s),推理 ${reply.thinkingChars} 字、输出 ${reply.outputTokens} tok —— 是想得多,不是卡住`
  }
  return firstMs === undefined && !http
    ? `没有轨迹,分不出是在等首字还是在流(${reply.outputTokens ?? 0} tok)`
    : `输出只有 ${reply.outputTokens ?? 0} tok,慢在哪看上面这一行的首字与响应头`
}

/** 像"扫一整棵大目录"的 shell 命令:du、grep -r、find、ls -R、Get-ChildItem -Recurse、tree。 */
const RECURSIVE_SCAN = /(^|[\s;&|(])(du\s|grep\s+(-\w*r\w*|--recursive)\b|find\s|ls\s+-\w*R|tree\b)|Get-ChildItem[^|;]*-Recurse/i

function explainTool(tool: ToolFact, summary: string | undefined, quiet: number | undefined): string {
  const notes: string[] = []
  if (summary && RECURSIVE_SCAN.test(summary)) {
    notes.push("像是递归扫大目录(node_modules、构建产物) —— 找文件该用 grep / find 工具,或排除这些目录、给个 timeout")
  }
  if (tool.isError) notes.push("以错误收场(被中止也算)")
  if (quiet !== undefined && quiet >= 10_000) notes.push(`最后 ${seconds(quiet)} 没有任何输出`)
  if (summary) notes.push(oneLine(summary, 120))
  return notes.join(";") || "慢,原因要看命令本身"
}

/** 这次调用在忙时心跳里最后一次"多久没出字"(按调用 id 认,同名工具不串)。 */
function lastQuiet(trace: TraceLine[], toolCallId: string): number | undefined {
  let quiet: number | undefined
  for (const line of trace) {
    if (line.ev !== "busy" || !Array.isArray(line.tools)) continue
    for (const tool of line.tools as Rec[]) {
      if (tool.tc === toolCallId && typeof tool.quiet_ms === "number") quiet = tool.quiet_ms
    }
  }
  return quiet
}

/** 最后一行是忙时心跳、之后没有 run.end:这一轮是卡着的时候被关掉的(或者还在跑)。 */
function unfinishedBusy(trace: TraceLine[]): string | undefined {
  const lastBusy = [...trace].reverse().find((line) => line.ev === "busy")
  if (!lastBusy) return undefined
  if (trace.some((line) => (line.ev === "run.end" || line.ev === "run.failed") && line.t > lastBusy.t)) return undefined
  const tools = Array.isArray(lastBusy.tools)
    ? (lastBusy.tools as Rec[]).map((tool) => `${tool.tool} 已跑 ${seconds(Number(tool.ms) || 0)}、${seconds(Number(tool.quiet_ms) || 0)} 没出字`)
    : []
  return `最后一次忙时心跳之后没有收尾:阶段 ${String(lastBusy.phase ?? "?")} 已 ${seconds(Number(lastBusy.phase_ms) || 0)}` +
    (tools.length ? `;${tools.join(";")}` : "")
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function nearest(lines: TraceLine[], from: number, to: number, target = from): TraceLine | undefined {
  let best: TraceLine | undefined
  for (const line of lines) {
    if (line.t < from || line.t > to) continue
    if (!best || Math.abs(line.t - target) < Math.abs(best.t - target)) best = line
  }
  return best
}

function sessionSpan(session: SessionFacts): [number, number] | undefined {
  const times = [
    session.createdAt,
    ...session.users.map((user) => user.at),
    ...session.assistants.map((reply) => reply.end),
    ...session.tools.map((tool) => tool.end),
    ...session.runs.map((run) => run.endedAt),
  ].filter((time) => time > 0)
  return times.length ? [Math.min(...times), Math.max(...times)] : undefined
}

function argumentSummary(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const input = args as Rec
  for (const key of ["command", "path", "file_path", "pattern", "query", "description", "action", "prompt"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return oneLine(value, 200)
  }
  return undefined
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return (content as Rec[]).map((block) => (block.type === "text" ? String(block.text ?? "") : "")).join("")
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  const message = (error as Rec).message
  return typeof message === "string" ? message : JSON.stringify(error)
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 一分钟以内带一位小数;以上先取整秒再拆分(不然 179.99 s 会写成 "2 min 60 s")。 */
function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const whole = Math.round(ms / 1000)
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`
}

function safeJson(line: string): unknown {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
