/**
 * 忙时"此刻在干什么"的状态机(docs/调试留痕-规划-20260924.md §2.2)。
 *
 * 从前界面上只有一行不带计时的「思考中」,只要会话在忙就挂着 —— bash 跑三分钟时也是它。用户分不清是模型在想、
 * 请求还没回来,还是某条命令卡住了。这里把 harness 的事件折成六个阶段(`SessionActivity`),**只在阶段变化时**
 * 告诉调用方(方法返回 true),一个 step 大约五到十次,不是逐 delta;已过时长由界面按 `since` 自己走表。
 *
 * 纯的:不碰 harness、不发事件,时间由注入的 `now` 给。SessionManager 每个会话一份,变了就推一条 `session.status`。
 */

import type { SessionActivity } from "../types.ts"

/** 一个流式内容增量属于哪一类(pi-ai 的 thinking_* / text_* / toolcall_*)。 */
export type ContentKind = "thinking" | "text" | "toolcall"

/** 在跑的一个工具。 */
export interface RunningTool {
  toolCallId: string
  tool: string
  since: number
  /** 最后一次有输出(tool_update)的时刻;没出过字就没有。 */
  lastOutput?: number
}

export class ActivityTracker {
  private current: SessionActivity | undefined
  /** 在跑的工具,插入顺序 = 开跑顺序。 */
  private readonly running = new Map<string, RunningTool>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 现状;空闲时是 undefined。每次变化都换一个新对象,调用方可以按引用判等。 */
  get activity(): SessionActivity | undefined {
    return this.current
  }

  /** 在跑的工具(按开跑顺序),给轨迹的忙时心跳用。 */
  runningTools(): RunningTool[] {
    return [...this.running.values()]
  }

  /** 一轮开始:请求马上要发出去了,等模型。 */
  runStart(): boolean {
    this.running.clear()
    return this.set({ phase: "waiting", since: this.now() })
  }

  /** 一轮结束(完成、中止、失败都是)。 */
  runEnd(): boolean {
    this.running.clear()
    if (!this.current) return false
    this.current = undefined
    return true
  }

  /**
   * 回到"等模型":重试的下一次尝试开始、一轮中间的压缩做完。已经在等的不动 since —— 用户等的是"请求发出之后"。
   */
  awaitModel(): boolean {
    if (this.current?.phase === "waiting") return false
    return this.set({ phase: "waiting", since: this.now() })
  }

  /**
   * assistant 流打开了(pi-ai 的 start 事件在响应头到了之后才发)。还在等第一个字,阶段不变;
   * 上一段残留的阶段(压缩前的 tools / writing)归位成 waiting。
   */
  llmStart(): boolean {
    return this.awaitModel()
  }

  /** 流式内容到了。`tool` 是 toolcall 那一类的工具名(模型正在写它的参数)。 */
  content(kind: ContentKind, tool?: string): boolean {
    const current = this.current
    if (kind === "toolcall") {
      const name = tool || "?"
      if (current?.phase === "calling" && current.tool === name) return false
      return this.set({ phase: "calling", since: this.now(), tool: name })
    }
    const phase = kind === "thinking" ? "thinking" : "writing"
    if (current?.phase === phase) return false
    return this.set({ phase, since: this.now() })
  }

  toolStart(toolCallId: string, tool: string): boolean {
    this.running.set(toolCallId, { toolCallId, tool, since: this.now() })
    return this.set(this.toolsActivity())
  }

  /** 工具吐了一块输出。不改阶段,只记"最近一次有动静"(心跳里算 quiet_ms)。 */
  toolOutput(toolCallId: string): void {
    const running = this.running.get(toolCallId)
    if (running) running.lastOutput = this.now()
  }

  /** 工具结束。这一批都跑完了就回到等模型(下一次请求马上发出)。 */
  toolEnd(toolCallId: string): boolean {
    if (!this.running.delete(toolCallId)) return false
    if (this.running.size > 0) return this.set(this.toolsActivity())
    return this.set({ phase: "waiting", since: this.now() })
  }

  /** 确认条挂起:这一刻在等用户点。 */
  confirmWait(tool: string): boolean {
    return this.set({ phase: "confirm", since: this.now(), tool })
  }

  /**
   * 确认条结算了。允许的话 tool_start 紧跟着来;拒绝 / 超时的话这次调用以错误收场、接着请求模型 ——
   * 两种都不该再挂着"等你确认"。还有别的工具在跑就回到 tools,否则回到等模型。
   */
  confirmDone(): boolean {
    if (this.current?.phase !== "confirm") return false
    if (this.running.size > 0) return this.set(this.toolsActivity())
    return this.set({ phase: "waiting", since: this.now() })
  }

  private toolsActivity(): SessionActivity {
    const tools = [...this.running.values()]
    return { phase: "tools", since: Math.min(...tools.map((tool) => tool.since)), tools: tools.map((tool) => tool.tool) }
  }

  private set(next: SessionActivity): boolean {
    if (this.current && sameActivity(this.current, next)) return false
    this.current = next
    return true
  }
}

/** 两个阶段看起来一样(界面上画出来的字相同)就不算变化 —— 省一条 session.status。 */
function sameActivity(a: SessionActivity, b: SessionActivity): boolean {
  if (a.phase !== b.phase || a.since !== b.since) return false
  if (a.phase === "tools" && b.phase === "tools") return a.tools.join("\0") === b.tools.join("\0")
  if ((a.phase === "calling" || a.phase === "confirm") && (b.phase === "calling" || b.phase === "confirm")) {
    return a.tool === b.tool
  }
  return true
}

/** pi-ai 流式事件的类型 → 内容类别。收尾事件(done / error)与未知类型给 undefined。 */
export function contentKindOf(eventType: string): ContentKind | undefined {
  if (eventType.startsWith("thinking_")) return "thinking"
  if (eventType.startsWith("text_")) return "text"
  if (eventType.startsWith("toolcall_")) return "toolcall"
  return undefined
}
