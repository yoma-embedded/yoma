/**
 * 探针互斥的硬锁:`mailbox.setActive` → 覆盖策略槽。
 *
 * 背景是根 CLAUDE.md 的进程模型:探针租约是**进程内**的,调试台任务的 turn 子进程
 * 与交互内核会真撞探针(实测 0xe00002c5)。所以任务活跃时交互侧的硬件工具必须被
 * **策略层硬拒**,不是 UI 提示。这里钉三件事:锁上之后 log(rtt) 被 policy 拒且
 * 理由可见;log(command 模式) 不受锁(它不占探针);撤锁后同样的调用回到 rules 放行。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai"

import { createKernelHost } from "./index.ts"
import type { PermissionDecision } from "./permission.ts"
import type { KernelEvent } from "../protocol.ts"
import type { Session, ToolPart } from "../types.ts"

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

let fauxCount = 0
function harnessWith(steps: unknown[]) {
  const models = createModels()
  const faux = fauxProvider({ provider: `faux-lock-${++fauxCount}` })
  models.setProvider(faux.provider)
  faux.setResponses(steps as never)
  return { models, model: faux.getModel() as Model<string> }
}

function makeHost(steps: unknown[]) {
  const events: KernelEvent[] = []
  const decisions: PermissionDecision[] = []
  const workspace = tempDir("yoma-lock-ws-")
  const host = createKernelHost({
    sessionsRoot: tempDir("yoma-lock-sessions-"),
    stateDir: tempDir("yoma-lock-state-"),
    configDir: tempDir("yoma-lock-config-"),
    version: "test",
    onEvents: (batch) => events.push(...batch),
    onPermissionDecision: (decision) => decisions.push(decision),
    resolveModels: async () => harnessWith(steps),
  })
  return { host, events, decisions, workspace }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function toolParts(events: KernelEvent[]): ToolPart[] {
  return events.flatMap((e) => (e.type === "message.part.updated" && e.part.type === "tool" ? [e.part as ToolPart] : []))
}

describe("mailbox.setActive 硬件锁", () => {
  test("锁上:log(rtt) 被 policy 拒且理由可见;撤锁:同样的调用回到 rule 放行", async () => {
    const { host, events, decisions, workspace } = makeHost([
      // 第一轮(锁着):log 走 rtt 路 → 应被覆盖策略拒。
      fauxAssistantMessage([fauxToolCall("log", { action: "read", chip: "STM32G431CB" })]),
      fauxAssistantMessage([fauxText("被拦了")]),
      // 第二轮(已撤锁):同样的调用应通过权限门(工具本身执行会因无探针而失败,
      // 但那是工具错误,不是权限拒绝 —— 裁决记录能分清)。
      fauxAssistantMessage([fauxToolCall("log", { action: "read", chip: "STM32G431CB" })]),
      fauxAssistantMessage([fauxText("这次过了门")]),
    ])

    const locked = (await host.handle("mailbox.setActive", { active: true, reason: "调试台任务活跃(测试)" })) as {
      active: boolean
    }
    expect(locked.active).toBe(true)

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "采一段日志" } })
    await waitFor(() => decisions.length >= 1 && toolParts(events).some((part) => part.state.status === "error"))

    expect(decisions[0]?.verdict).toBe("deny")
    expect(decisions[0]?.by).toBe("policy")
    expect(decisions[0]?.rule).toBe("mailbox-active")
    const denied = toolParts(events).find((part) => part.state.status === "error")
    expect(denied && denied.state.status === "error" ? denied.state.error : "").toContain("调试台任务活跃")

    // 撤锁后,同一个会话再来一次同样的调用 —— 权限门这次必须放行。
    await host.handle("mailbox.setActive", { active: false })
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "再采一次" } })
    await waitFor(() => decisions.length >= 2)

    expect(decisions[1]?.verdict).toBe("allow")
    expect(decisions[1]?.by).toBe("rule")

    await host.dispose()
  }, 30_000)

  test("log 的 command 模式不受锁 —— 它不占探针", async () => {
    const { host, decisions, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("log", { action: "read", command: "echo hi" })]),
      fauxAssistantMessage([fauxText("完")]),
    ])
    await host.handle("mailbox.setActive", { active: true })

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "用命令模式采" } })
    await waitFor(() => decisions.length >= 1)

    expect(decisions[0]?.verdict).toBe("allow")
    expect(decisions[0]?.by).toBe("rule")

    await host.dispose()
  }, 30_000)
})
