/**
 * 一轮 agent 执行 —— bench 的执行核心。
 *
 * ## 为什么嵌 createKernelHost() 而不是自己装配 harness
 *
 * 裸装配省下的只是几十行代码,要重建的却是投影器、工具装配、资源发现、事件协议这一整层。
 * 而 `KernelHostOptions` 的 sessionsRoot / stateDir / enginesDir / onEvents 全是注入位 ——
 * 它本来就是为"第二个宿主"准备的形状。附带白得一件事:sessionsRoot 指向 desktop 的会话
 * 目录时,desktop 打开就能回放整个调试过程。
 *
 * ## 为什么一轮一个子进程(调用方 spawn turn-entry)
 *
 * 进程边界 = 免费且可靠的清理:agent 起的子进程(串口、调试器、脚本)在轮结束时一定
 * 被收干净,崩溃也不会留下孤儿,而会话文件的独占也随进程一起归还。会话是落盘的 JSONL,
 * 下一轮换个进程接着跑,历史一条不丢。
 *
 * ## 一轮"跑完了"怎么判定
 *
 * `session.prompt` 立刻返回,轮次结束只能看事件。状态机是 busy →(中间可能夹几段
 * compacting)→ idle:重试与阈值/溢出压缩都留在同一段 busy 里。判据是 **idle 静默
 * 一小段时间**,而不是"第一个 idle" —— 状态只要回跳一次,就说明这一轮还没完。
 */

import { createKernelHost, type KernelHost } from "@yoma-desktop/kernel/host"
import { DEFAULT_THINKING_LEVEL, isLicenseRequiredData, type KernelEvent, type ProviderInfo } from "@yoma-desktop/kernel"
import type { AssistantMessage, LicenseRequiredData, Session, Tokens } from "@yoma-desktop/kernel"

import { pickAvailableModel, type Job } from "./job.ts"

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
   * 技能与上下文文件的全局目录。生产不传 —— 默认 `~/.yoma`,于是任务 agent 拿到的
   * 项目上下文(AGENTS.md/CLAUDE.md)与技能和 Zed、桌面端完全一致。测试传临时目录隔离。
   */
  configDir?: string
  /**
   * 工具链清单按哪一侧筛。信箱工位端传 `"runner"`,别的都不传(默认 `"mother"`)。
   */
  toolchainSide?: Parameters<typeof createKernelHost>[0]["toolchainSide"]
  /**
   * 工具链清单原文。**只有工位端用得上** —— 它的 workspace 是一次性目录,
   * 没有 `.yoma/toolchain.json`,清单只能经信箱送过来。
   */
  toolchainManifestText?: string
  settleMs?: number
  hardTimeoutMs?: number
}

/**
 * 代码级接缝(第二个参数),**故意不在 `TurnOptions` 里**。
 *
 * `turn-entry.ts` 是 `runTurn({ ...JSON 文件 })` —— 把一个从磁盘读来的 `TurnInput` 整个展开进
 * options。授权策略一旦是 options 上的字段,信箱里的一份 job/turn 输入就能把正式包的检查关掉。
 * 所以它只能作为**函数参数**从代码里传进来:生产路径(turn-entry)一个字都不传,传它的只有测试。
 */
export interface TurnSeams {
  /** 不传 = 这个构建编译期注入的那一份策略(没注入的开发态即不强制)。 */
  licensePolicy?: Parameters<typeof createKernelHost>[0]["licensePolicy"]
  /** 授权检查用的时钟。 */
  licenseNow?: Parameters<typeof createKernelHost>[0]["licenseNow"]
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
  /**
   * 非空 = 这一轮因为软件授权不满足**压根没有开始**(内核在 `session.prompt` 第一行就拒了,
   * 用户消息都没落盘)。它**不是业务失败**:`errors` 是空的、`text` 是空的、没有工具调用。
   *
   * 调用方要按"暂停"处理 —— 别往信箱里回填一个失败结果,也别让模型去解释它
   * (授权不是模型能裁决的事)。守护侧的处理在 `mailbox/license.ts`。
   */
  licenseBlocked?: LicenseRequiredData
}

/**
 * 从一个异常里认出"授权不满足"。认的是 `error.data._tag` 而不是类名或消息文本:
 * `data` 是唯一能跨 MessagePort / contextBridge 活下来的结构化信息(根 CLAUDE.md
 * "contextBridge 会把 Error 剥成一句话")。
 */
export function licenseRequiredDataOf(error: unknown): LicenseRequiredData | undefined {
  const data = (error as { data?: unknown } | null | undefined)?.data
  return isLicenseRequiredData(data) ? data : undefined
}

/**
 * 用量的零元与加法。**工厂而不是共享常量**:usageByMessage 为空时 reduce 把初值原样
 * 返回,那个对象随即成为 TurnResult.usage 交给调用方继续累加并落盘 —— 共享常量会被
 * 写一次就全局污染(Object.freeze 是浅的,盖不住 tokens.cache)。
 */
export const zeroUsage = (): TurnUsage => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
})

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cache: { read: a.tokens.cache.read + b.tokens.cache.read, write: a.tokens.cache.write + b.tokens.cache.write },
    },
    cost: a.cost + b.cost,
  }
}

export async function runTurn(options: TurnOptions, seams: TurnSeams = {}): Promise<TurnResult> {
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

  const totals = (): TurnUsage => [...usageByMessage.values()].reduce(addUsage, zeroUsage())

  const host: KernelHost = createKernelHost({
    sessionsRoot: options.sessionsRoot,
    stateDir: options.stateDir,
    enginesDir: options.enginesDir,
    configDir: options.configDir,
    version: "bench",
    resolveModels: options.resolveModels,
    // 不传则 harness 落到 "off"。任务书显式写了(含 "off")就听任务书的。
    defaultThinkingLevel: options.job.model?.thinking ?? DEFAULT_THINKING_LEVEL,
    toolchainSide: options.toolchainSide,
    toolchainManifestText: options.toolchainManifestText,
    // 授权策略与时钟只从 seams 来。这里**逐字段**构造 KernelHostOptions(而不是 `...options`)
    // 正是这条纪律的落点:options 里混进一个 licensePolicy 也到不了内核。
    licensePolicy: seams.licensePolicy,
    licenseNow: seams.licenseNow,
    // confirmTools **不开**:调试台无人值守,没人点"允许"。开了的话一条烧录调用会挂在确认台上
    // 一直到它十分钟的超时,而这一轮结束的判据是"idle 静默 700ms" —— 挂起期间 lane 一直 busy,
    // 于是整轮只能等到一小时硬超时才收场,报告里看到的是"agent 卡住了"。
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
        // synthetic 是"不是模型直接说的"(压缩 / 分支摘要),同样不该进根因分析。
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
  let licenseBlocked: LicenseRequiredData | undefined
  try {
    if (!sessionID) {
      const session = (await host.handle("session.create", {
        directory: options.workspace,
        title: options.job.title,
      })) as Session
      sessionID = session.id
    }

    // 任务书钉了完整模型就下发。没钉则从本机已认证目录挑:有 DeepSeek Flash 用它,
    // 否则第一个有凭据的模型 —— 不要把外人没有的 deepseek/… 写进 setModel。
    // faux 演练注入的注册表里只有假模型,照着任务书 setModel 会当场未知模型。
    if (!options.resolveModels) {
      const requested = options.job.model
      const catalog = (await host.handle("model.list", undefined as never)) as ProviderInfo[]
      const picked =
        requested?.providerID && requested.modelID
          ? { providerID: requested.providerID, modelID: requested.modelID }
          : pickAvailableModel(catalog)
      if (picked) {
        await host.handle("session.setModel", {
          sessionID,
          providerID: picked.providerID,
          modelID: picked.modelID,
          thinking: requested?.thinking,
        })
      }
    }

    try {
      await host.handle("session.prompt", { sessionID, input: { text: options.prompt } })
    } catch (error) {
      // 授权不满足不是异常路径的一部分:内核在第一行就拒了,什么都没发生。把它变成结果里的
      // 一个字段交给调用方按"暂停"处理,而不是抛给守护当成"这一轮失败了"回填进信箱。
      licenseBlocked = licenseRequiredDataOf(error)
      if (!licenseBlocked) throw error
    }

    // 被拒时没有任何事件会来:等 idle 静默只会白等到一小时硬超时。
    if (!licenseBlocked) {
      const hardTimeout = setTimeout(() => {
        stopReason ??= `一轮超过 ${Math.round((options.hardTimeoutMs ?? TURN_HARD_TIMEOUT_MS) / 60000)} 分钟仍未结束`
        void abortNow().then(() => finish?.())
      }, options.hardTimeoutMs ?? TURN_HARD_TIMEOUT_MS)
      ;(hardTimeout as { unref?: () => void }).unref?.()

      await done
      clearTimeout(hardTimeout)
    }
  } finally {
    clearInterval(keepalive)
    cancelSettle()
    await host.dispose().catch(() => {})
  }

  if (licenseBlocked) {
    // 空文本、零工具调用、零错误 —— 这一轮没有发生过。usage 也一定是零元。
    return { sessionID, text: "", toolCalls: [], usage: zeroUsage(), errors: [], elapsedMs: Date.now() - started, licenseBlocked }
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
