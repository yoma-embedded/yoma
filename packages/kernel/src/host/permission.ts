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

interface Pending {
  request: PermissionRequest
  resolve(response: PermissionResponse): void
  timer: ReturnType<typeof setTimeout>
}

export interface PermissionGateOptions {
  rules?: PermissionRules
  emit(event: KernelEvent): void
  timeoutMs?: number
}

export class PermissionGate {
  private rules: PermissionRules
  private readonly emit: (event: KernelEvent) => void
  private readonly timeoutMs: number
  private readonly pending = new Map<string, Pending>()
  private readonly detachers = new Map<string, () => void>()

  constructor(options: PermissionGateOptions) {
    this.rules = { ...DEFAULT_PERMISSION_RULES, ...(options.rules ?? {}) }
    this.emit = options.emit
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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

      if (this.actionFor(toolName) === "allow") return undefined

      const response = await this.ask({
        id: Identifier.ascending("permission"),
        sessionID,
        messageID: currentMessageID(),
        callID,
        tool: toolName,
        input,
        title: describe(toolName, input),
        time: { created: Date.now() },
      })

      if (response === "always") {
        this.rules = { ...this.rules, [toolName]: "allow" }
        return undefined
      }
      if (response === "once") return undefined
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

  private ask(request: PermissionRequest): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.emit({ type: "permission.replied", id: request.id, response: "reject" })
        resolve("reject")
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
    entry.resolve(response)
  }

  rejectAllFor(sessionID: string, _reason: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.sessionID !== sessionID) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      this.emit({ type: "permission.replied", id, response: "reject" })
      entry.resolve("reject")
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
