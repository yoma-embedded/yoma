/**
 * 一轮 agent 执行 —— bench 的执行核心。
 *
 * ## 为什么嵌 createKernelHost() 而不是自己装配 harness
 *
 * 裸装配(example/99-headless-run.ts 那条路)省下的只是几十行代码,要重建的却是
 * 投影器、自动压缩、工具装配、事件协议这一整层。而 `KernelHostOptions` 的
 * sessionsRoot / stateDir / enginesDir / onEvents 全是注入位 —— 它本来就是为
 * "第二个宿主"准备的形状。附带白得两件事:
 *   1. sessionsRoot 指向 desktop 的会话目录时,desktop 打开就能回放整个调试过程;
 *   2. P2 给 host 加 WebSocket 入口后,desktop 能实时 attach 观战,协议帧一个字不用改。
 *
 * ## 为什么一轮一个子进程(调用方 spawn turn-entry)
 *
 * my-pi 的探针租约、gdb 会话表、log 采集器都是**模块级全局**,还挂着 process 退出钩子。
 * 进程边界 = 免费且可靠的清理:agent 轮结束时探针、串口、gdb server 一定被收干净,
 * 下一轮不会撞上"探针被上一轮占着"。崩溃也不会留下孤儿。会话是落盘的 JSONL,
 * 下一轮换个进程接着跑,历史一条不丢。
 *
 * ## 一轮"跑完了"怎么判定
 *
 * `session.prompt` 立刻返回,轮次结束只能看事件。状态机是 busy → idle,但自动压缩
 * 会在 idle 之后再来一次 compacting → idle。所以判据是 **idle 静默一小段时间**,
 * 而不是"第一个 idle"。
 */

import { createKernelHost, type KernelHost } from "@yoma-desktop/kernel/host"
import type { KernelEvent } from "@yoma-desktop/kernel"
import type { AssistantMessage, Session, Tokens } from "@yoma-desktop/kernel"

import type { Job } from "./job.ts"

/** idle 之后再等这么久没有新状态,才认为一轮真的结束(躲开自动压缩的第二段)。 */
const SETTLE_MS = 700

/**
 * 轮次内部的硬上限。**这不是预算** —— 它防的是"事件流因为某种原因永不静默",
 * 那会让进程带着一个永远不 resolve 的 await 挂在那儿。花多少钱不归它管。
 */
const TURN_HARD_TIMEOUT_MS = 60 * 60 * 1000

export interface TurnOptions {
  job: Job
  /** agent 的 cwd。 */
  workspace: string
  /** 会话 JSONL 根目录。指向 desktop 的 userData/sessions 就能在桌面端回放。 */
  sessionsRoot: string
  /** projects.json 等状态目录。 */
  stateDir: string
  enginesDir?: string
  /** 续跑已有会话;不给就新建。 */
  sessionID?: string
  /** 本轮要说的话。 */
  prompt: string
  /** 事件旁路,用来打印进度。 */
  onEvent?: (event: KernelEvent) => void
  /** 测试注入 faux provider。 */
  resolveModels?: Parameters<typeof createKernelHost>[0]["resolveModels"]
  /**
   * 技能与上下文文件的全局目录。生产不传 —— 默认 `~/.my-pi`,于是任务 agent 拿到的
   * 项目上下文(AGENTS.md/CLAUDE.md)与技能和 Zed、桌面端完全一致。测试传临时目录隔离。
   */
  configDir?: string
  settleMs?: number
  hardTimeoutMs?: number
}

export interface TurnUsage {
  tokens: Tokens
  cost: number
}

export interface TurnToolCall {
  tool: string
  status: string
  /** 工具卡片标题用的输入摘要,进报告。 */
  input: Record<string, unknown>
  error?: string
}

export interface TurnResult {
  sessionID: string
  /** 本轮 assistant 说的正文(拼接所有 text part)。 */
  text: string
  toolCalls: TurnToolCall[]
  usage: TurnUsage
  /** 非空表示本轮是被中断/出错结束的。 */
  stopReason?: string
  errors: string[]
  elapsedMs: number
}

const ZERO_TOKENS: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const started = Date.now()
  const settleMs = options.settleMs ?? SETTLE_MS
  const errors: string[] = []
  /** 每条 assistant 消息的最新用量。同一轮里会有多条(工具循环),按 id 取最后一次。 */
  const usageByMessage = new Map<string, TurnUsage>()
  const toolCalls = new Map<string, TurnToolCall>()
  const textByPart = new Map<string, string>()
  /**
   * 只收 assistant 消息的 text part。
   *
   * 用户消息的 part 也是 text part —— 不按 role 过滤的话,交给 agent 的提示词会原样
   * 回到 result.text,再原样出现在报告的"根因分析"里(实测踩过:报告里贴的是任务书)。
   * 协议保证父 message.updated 早于它的任何 part 事件,所以这个集合一定先就位。
   */
  const assistantMessages = new Set<string>()

  let stopReason: string | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let finish: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  const totals = (): TurnUsage => {
    const tokens: Tokens = { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } }
    let cost = 0
    for (const usage of usageByMessage.values()) {
      tokens.input += usage.tokens.input
      tokens.output += usage.tokens.output
      tokens.reasoning += usage.tokens.reasoning
      tokens.cache.read += usage.tokens.cache.read
      tokens.cache.write += usage.tokens.cache.write
      cost += usage.cost
    }
    return { tokens, cost }
  }

  const host: KernelHost = createKernelHost({
    sessionsRoot: options.sessionsRoot,
    stateDir: options.stateDir,
    enginesDir: options.enginesDir,
    configDir: options.configDir,
    version: "bench",
    resolveModels: options.resolveModels,
    onEvents: (batch) => {
      for (const event of batch) handleEvent(event)
    },
  })

  function scheduleSettle() {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => finish?.(), settleMs)
  }

  function cancelSettle() {
    clearTimeout(settleTimer)
    settleTimer = undefined
  }

  function handleEvent(event: KernelEvent) {
    options.onEvent?.(event)
    switch (event.type) {
      case "session.status":
        if (event.status.type === "idle") scheduleSettle()
        else cancelSettle()
        break
      case "message.updated": {
        const message = event.message
        if (message.role !== "assistant") break
        assistantMessages.add(message.id)
        const assistant = message as AssistantMessage
        usageByMessage.set(assistant.id, { tokens: assistant.tokens, cost: assistant.cost })
        if (assistant.error) errors.push(`${assistant.error.name}: ${assistant.error.data.message}`)
        break
      }
      case "message.part.updated": {
        const part = event.part
        // synthetic 是"不是模型说的"(bash 回显、压缩摘要),同样不该进根因分析。
        if (part.type === "text" && assistantMessages.has(part.messageID) && !part.synthetic) {
          textByPart.set(part.id, part.text)
        }
        if (part.type === "tool") {
          toolCalls.set(part.id, {
            tool: part.tool,
            status: part.state.status,
            input: "input" in part.state ? part.state.input : {},
            error: part.state.status === "error" ? part.state.error : undefined,
          })
        }
        break
      }
      case "message.part.delta":
        // 流式增量:快照事件已经带全文,这里只需要保证"有动静"不算静默。
        cancelSettle()
        break
      case "kernel.error":
        errors.push(event.message)
        break
      default:
        break
    }
  }

  async function abortNow() {
    await host.handle("session.abort", { sessionID }).catch(() => {})
  }

  // 内核的事件批处理定时器是 unref 的(kernel host/stream.ts,为了不吊住
  // utilityProcess 退出),而本函数的完成恰恰**依赖**那批事件送达。纯 node 下若
  // 进程没有别的 ref 句柄,事件还没冲出来事件循环就空了,进程带着未决的 await
  // 直接退出(实测:打包冒烟里 mother 走到"分析中"就消失)。bun 的存活语义不同,
  // 开发态从不暴露 —— 所以这里必须显式抓一个 ref 句柄,离开时归还。
  const keepalive = setInterval(() => {}, 60_000)
  let sessionID = options.sessionID ?? ""
  try {
    if (!sessionID) {
      const session = (await host.handle("session.create", {
        directory: options.workspace,
        title: options.job.title,
      })) as Session
      sessionID = session.id
    }

    if (options.job.model?.providerID && options.job.model.modelID) {
      await host.handle("session.setModel", {
        sessionID,
        providerID: options.job.model.providerID,
        modelID: options.job.model.modelID,
      })
    }

    await host.handle("session.prompt", { sessionID, input: { text: options.prompt } })

    const hardTimeout = setTimeout(() => {
      stopReason ??= `一轮超过 ${Math.round((options.hardTimeoutMs ?? TURN_HARD_TIMEOUT_MS) / 60000)} 分钟仍未结束`
      void abortNow().then(() => finish?.())
    }, options.hardTimeoutMs ?? TURN_HARD_TIMEOUT_MS)
    ;(hardTimeout as { unref?: () => void }).unref?.()

    await done
    clearTimeout(hardTimeout)
  } finally {
    clearInterval(keepalive)
    cancelSettle()
    await host.dispose().catch(() => {})
  }

  return {
    sessionID,
    text: [...textByPart.values()].join("\n").trim(),
    toolCalls: [...toolCalls.values()],
    usage: totals(),
    stopReason,
    errors,
    elapsedMs: Date.now() - started,
  }
}
