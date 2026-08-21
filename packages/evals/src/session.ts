/**
 * 从落盘的会话 JSONL 里读出这一轮到底发生了什么。
 *
 * ## 为什么必须读 transcript 而不是只看 TurnResult
 *
 * `TurnResult.toolCalls` 只有工具的**输入**(它来自投影器,给前端画工具卡片用)。
 * 而 `grounded` 要问的是"这个词出现在某次工具的**输出**里吗" —— 输出只在会话文件里。
 * 顺带白得的还有 assistant 消息数(turns):同一轮里工具循环会产生多条,那正是
 * 2026-08-11 "107 条消息 reasoning 为 0" 的那个计数。
 *
 * ## 格式
 *
 * `<sessionsRoot>/--<cwd 编码>--/<时间戳>_<sessionId>.jsonl`(jsonl-repo.ts)。
 * 第一行是 header,之后一行一个 `SessionTreeEntry`。我们只要 `type === "message"`,
 * 其余(压缩、换模型、光标)一律跳过。
 *
 * ## 为什么自己走目录而不是用 glob 引擎
 *
 * 要找的模式就是 `**\/*_<sessionID>.jsonl`,而 sessionsRoot 下只有一层 cwd 目录 ——
 * 一次递归 readdir 就是它,不值得为此拖一个依赖(evals 不加新的第三方依赖)。
 *
 * ## 解析是**防御式**的
 *
 * 会话文件是内核写的,但 evals 读的可能是别人机器上跑出来的、或者是老版本的产物。
 * 一条读不懂的行只被跳过,不让整个 trial 变成 error —— 判分要的是证据,不是格式洁癖。
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export type ToolCallStatus = "completed" | "error" | "pending"

export interface TranscriptToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  /** toolResult 里 text 块拼接。没有结果(轮次被打断)时是空串,status 为 pending。 */
  output: string
  isError: boolean
  status: ToolCallStatus
}

export interface Transcript {
  file: string
  /** assistant 消息条数 = 这一轮的 turns。 */
  assistantCount: number
  toolCalls: TranscriptToolCall[]
}

/** 会话文件里我们认得的那几个形状。多余字段一概不碰。 */
interface RawTextBlock {
  type?: unknown
  text?: unknown
}
interface RawToolCallBlock {
  type?: unknown
  id?: unknown
  name?: unknown
  arguments?: unknown
}
interface RawMessage {
  role?: unknown
  content?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
}
interface RawEntry {
  type?: unknown
  message?: RawMessage
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const candidate = block as RawTextBlock
      return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

/** 找会话文件。找不到就 undefined —— 调用方决定这算不算 error(它算)。 */
export async function findSessionFile(sessionsRoot: string, sessionID: string): Promise<string | undefined> {
  const suffix = `_${sessionID}.jsonl`
  const walk = async (dir: string): Promise<string | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(full)
        if (found) return found
      } else if (entry.name.endsWith(suffix)) return full
    }
    return undefined
  }
  return walk(path.resolve(sessionsRoot))
}

export function parseTranscript(file: string, jsonl: string): Transcript {
  let assistantCount = 0
  const calls = new Map<string, TranscriptToolCall>()
  /** 结果可能先于我们建索引到达吗?不会 —— 但按 id 存表天然对乱序免疫,不多此一举地假设顺序。 */
  const results = new Map<string, { toolName: string; output: string; isError: boolean }>()

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(trimmed) as RawEntry
    } catch {
      continue
    }
    if (entry.type !== "message" || !entry.message) continue
    const message = entry.message

    if (message.role === "assistant") {
      assistantCount += 1
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        const candidate = block as RawToolCallBlock
        if (candidate?.type !== "toolCall") continue
        const id = typeof candidate.id === "string" ? candidate.id : undefined
        const name = typeof candidate.name === "string" ? candidate.name : undefined
        if (!id || !name) continue
        const args = candidate.arguments
        calls.set(id, {
          id,
          name,
          input:
            typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
          output: "",
          isError: false,
          status: "pending",
        })
      }
      continue
    }

    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined
      if (!id) continue
      results.set(id, {
        toolName: typeof message.toolName === "string" ? message.toolName : "?",
        output: textOf(message.content),
        isError: message.isError === true,
      })
    }
  }

  for (const [id, result] of results) {
    const call = calls.get(id)
    if (call) {
      call.output = result.output
      call.isError = result.isError
      call.status = result.isError ? "error" : "completed"
      continue
    }
    // 有结果没有调用:上一轮的调用 + 这一轮的结果(续跑会话),或者内核换过 id 铸法。
    // 仍然收进来 —— grounded 要的是"证据在不在场",丢掉它只会冤枉一次真的量过的调用。
    calls.set(id, {
      id,
      name: result.toolName,
      input: {},
      output: result.output,
      isError: result.isError,
      status: result.isError ? "error" : "completed",
    })
  }

  return { file, assistantCount, toolCalls: [...calls.values()] }
}

export async function readTranscript(sessionsRoot: string, sessionID: string): Promise<Transcript> {
  const file = await findSessionFile(sessionsRoot, sessionID)
  if (!file) throw new Error(`在 ${sessionsRoot} 下找不到会话 ${sessionID} 的 JSONL`)
  return parseTranscript(file, await readFile(file, "utf8"))
}
