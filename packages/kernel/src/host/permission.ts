/**
 * 权限门。
 *
 * my-pi 内核 **没有** 权限系统,它的 ACP 适配器也从不注册 tool_call 钩子 —— 也就是说
 * 在 Zed 里 `flash download` 是无人值守直接擦片的。对一个跑 probe-rs / gdb / bash 的
 * 桌面产品这不可接受,所以这一层是我们在 host 侧 **新增** 的能力。
 *
 * 实现落点是 `harness.on("tool_call")`:它走 emitHook(agent-harness.ts:435-443),
 * 是 harness 上少数几个真的会触发的 on() 之一,返回 `{block:true, reason}` 就能拦下。
 *
 * ## 三个必须有的兜底,少一个都会挂死
 *
 * 内核对这个钩子 **没有任何超时** —— 我们不 resolve,那一轮就永远停在那里:
 *   1. 超时自动拒绝(默认 10 分钟);
 *   2. 会话 abort 时拒绝该会话所有未决请求;
 *   3. renderer 重连时把未决请求重新推一遍,否则关掉窗口再打开就是一个永久卡住的会话。
 *
 * ## 两层裁决:policy(注入)→ rules(表)→ ask(人)
 *
 * bench 无人值守跑任务时拍板的不是人而是 per-job 策略:PolicyProvider 在 tool_call 时
 * 拿到工具名 + 参数,返回 allow / deny / escalate;escalate 强制走 ask 流(即使 rules
 * 说 allow),undefined 表示"无意见"落回 rules 表。策略函数抛错按 escalate 处理 ——
 * 策略崩了宁可去问人,绝不静默放行。
 *
 * 每个最终裁决(不论谁拍的板)都经 onDecision 吐出去 —— bench 拿它写 decisions.jsonl,
 * 这是无人值守模式的审计底线。审计出口自己抛错会被吞掉,不反噬权限门。
 */

import type { AgentHarness } from "@yoma/my-pi"

import type { KernelEvent } from "../protocol.ts"
import type { PermissionAction, PermissionRequest, PermissionResponse, PermissionRules } from "../types.ts"
import { Identifier } from "../ids.ts"

/** 会改硬件状态或文件的默认要问;只读的默认放行。 */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  flash: "ask",
  gdb: "ask",
  bash: "ask",
  write: "ask",
  edit: "ask",
  stm32config: "ask",
  read: "allow",
  grep: "allow",
  netlist: "allow",
  datasheet: "allow",
  log: "allow",
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export type PolicyDecision =
  | { action: "allow"; rule?: string }
  | { action: "deny"; rule?: string; reason?: string }
  | { action: "escalate"; rule?: string }

/** 无人值守策略。返回 undefined = 无意见,落回 rules 表。**不得**依赖"抛错=拒绝":抛错按 escalate 处理。 */
export type PolicyProvider = (call: {
  sessionID: string
  tool: string
  input: Record<string, unknown>
}) => PolicyDecision | undefined | Promise<PolicyDecision | undefined>

export type PermissionDecisionOrigin = "policy" | "rule" | "human" | "timeout" | "detach"

/** 决策审计记录:verdict 是最终生效的结果,by 是谁拍的板。 */
export interface PermissionDecision {
  time: number
  sessionID: string
  callID: string
  tool: string
  /** describe() 的人话标题 —— bash 含完整命令、flash 含 action+chip,审计够用且不会巨大。 */
  title: string
  verdict: "allow" | "deny"
  by: PermissionDecisionOrigin
  /** 命中的策略规则名或 rules 表条目;"policy-error" 表示策略函数抛错被转成 escalate。 */
  rule?: string
  /** 走了 ask 流时的原始应答。 */
  response?: PermissionResponse
  elapsedMs: number
}

interface AskOutcome {
  response: PermissionResponse
  by: "human" | "timeout" | "detach"
}

interface Pending {
  request: PermissionRequest
  resolve(outcome: AskOutcome): void
  timer: ReturnType<typeof setTimeout>
}

export interface PermissionGateOptions {
  rules?: PermissionRules
  emit(event: KernelEvent): void
  timeoutMs?: number
  /** 注入式策略,在 rules 之前裁决。见文件头"两层裁决"。 */
  policy?: PolicyProvider
  /** 决策审计出口。抛错被吞。 */
  onDecision?(decision: PermissionDecision): void
}

export class PermissionGate {
  private rules: PermissionRules
  private readonly emit: (event: KernelEvent) => void
  private readonly timeoutMs: number
  private readonly policy?: PolicyProvider
  private readonly onDecision?: (decision: PermissionDecision) => void
  private readonly pending = new Map<string, Pending>()
  private readonly detachers = new Map<string, () => void>()

  constructor(options: PermissionGateOptions) {
    this.rules = { ...DEFAULT_PERMISSION_RULES, ...(options.rules ?? {}) }
    this.emit = options.emit
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.policy = options.policy
    this.onDecision = options.onDecision
  }

  getRules(): PermissionRules {
    return { ...this.rules }
  }

  setRules(rules: PermissionRules): PermissionRules {
    this.rules = { ...DEFAULT_PERMISSION_RULES, ...rules }
    return this.getRules()
  }

  /** 未决请求快照 —— renderer 重连时重推,避免会话永久卡住。 */
  outstanding(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  attach(harness: AgentHarness, sessionID: string, currentMessageID: () => string): void {
    this.detach(sessionID)
    const off = harness.on("tool_call", async (event) => {
      const toolName = (event as { toolName: string }).toolName
      const input = ((event as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>
      const callID = (event as { toolCallId: string }).toolCallId
      const started = Date.now()
      const title = describe(toolName, input)
      const record = (
        verdict: "allow" | "deny",
        by: PermissionDecisionOrigin,
        extra?: { rule?: string; response?: PermissionResponse },
      ) => {
        try {
          this.onDecision?.({
            time: Date.now(),
            sessionID,
            callID,
            tool: toolName,
            title,
            verdict,
            by,
            rule: extra?.rule,
            response: extra?.response,
            elapsedMs: Date.now() - started,
          })
        } catch {
          // 审计出口的错误不反噬权限门。
        }
      }

      // 第一层:注入式策略。escalate 会越过 rules 直奔 ask 流。
      let escalateRule: string | undefined
      if (this.policy) {
        let decision: PolicyDecision | undefined
        try {
          decision = await this.policy({ sessionID, tool: toolName, input })
        } catch {
          decision = { action: "escalate", rule: "policy-error" }
        }
        if (decision?.action === "allow") {
          record("allow", "policy", { rule: decision.rule })
          return undefined
        }
        if (decision?.action === "deny") {
          record("deny", "policy", { rule: decision.rule })
          return { block: true, reason: decision.reason ?? `权限策略禁止 ${toolName}:${title}` }
        }
        if (decision?.action === "escalate") escalateRule = decision.rule ?? "escalate"
      }

      // 第二层:rules 表(策略要求 escalate 时跳过,直接去问人)。
      if (escalateRule === undefined) {
        const action = this.actionFor(toolName)
        if (action === "allow") {
          record("allow", "rule", { rule: `${toolName}:allow` })
          return undefined
        }
        if (action === "deny") {
          record("deny", "rule", { rule: `${toolName}:deny` })
          return { block: true, reason: `权限规则禁止 ${toolName}:${title}` }
        }
      }

      // 第三层:问人。
      const { response, by } = await this.ask({
        id: Identifier.ascending("permission"),
        sessionID,
        messageID: currentMessageID(),
        callID,
        tool: toolName,
        input,
        title,
        time: { created: Date.now() },
      })

      if (response === "always") {
        // 只改 rules 表 —— 策略仍是外层权威,policy 坚持 escalate 的工具下次照样会问。
        this.rules = { ...this.rules, [toolName]: "allow" }
        record("allow", by, { rule: escalateRule, response })
        return undefined
      }
      if (response === "once") {
        record("allow", by, { rule: escalateRule, response })
        return undefined
      }
      record("deny", by, { rule: escalateRule, response })
      if (by === "timeout") return { block: true, reason: `权限请求超时,${toolName} 被拒绝` }
      if (by === "detach") return { block: true, reason: `会话已关闭,${toolName} 被拒绝` }
      return { block: true, reason: `用户拒绝了 ${toolName}` }
    })
    this.detachers.set(sessionID, off)
  }

  detach(sessionID: string): void {
    this.detachers.get(sessionID)?.()
    this.detachers.delete(sessionID)
    this.rejectAllFor(sessionID, "会话已关闭")
  }

  private actionFor(tool: string): PermissionAction {
    // 未知工具默认要问 —— 内核新增了工具而我们还没定策略时,宁可多问一次。
    return this.rules[tool] ?? "ask"
  }

  private ask(request: PermissionRequest): Promise<AskOutcome> {
    return new Promise<AskOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.emit({ type: "permission.replied", id: request.id, response: "reject" })
        resolve({ response: "reject", by: "timeout" })
      }, this.timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()

      this.pending.set(request.id, { request, resolve, timer })
      this.emit({ type: "permission.asked", request })
    })
  }

  respond(id: string, response: PermissionResponse): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    this.emit({ type: "permission.replied", id, response })
    entry.resolve({ response, by: "human" })
  }

  rejectAllFor(sessionID: string, _reason: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.sessionID !== sessionID) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      this.emit({ type: "permission.replied", id, response: "reject" })
      entry.resolve({ response: "reject", by: "detach" })
    }
  }
}

/** 人话标题,直接显示在弹窗上。别让用户对着一坨 JSON 参数做决定。 */
function describe(tool: string, input: Record<string, unknown>): string {
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "")
  switch (tool) {
    case "bash":
      return `执行命令:${str("command") || "(未知)"}`
    case "edit":
      return `修改文件:${str("path") || str("file_path") || "(未知)"}`
    case "write":
      return `写入文件:${str("path") || str("file_path") || "(未知)"}`
    case "flash": {
      const action = str("action")
      const chip = str("chip")
      if (action === "download") return `烧录固件到 ${chip || "目标芯片"} —— 会擦除并改写 flash`
      if (action === "erase") return `擦除 ${chip || "目标芯片"} 的 flash`
      return `probe-rs ${action || "操作"}${chip ? ` (${chip})` : ""}`
    }
    case "gdb":
      return `gdb ${str("action") || "操作"} —— 会控制目标板的运行状态`
    case "stm32config":
      return `stm32config ${str("command") || "操作"}`
    default:
      return `运行工具 ${tool}`
  }
}
