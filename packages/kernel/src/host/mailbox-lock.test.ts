/**
 * 探针互斥的硬锁:`mailbox.setActive` → 覆盖策略槽。
 *
 * 背景是根 CLAUDE.md 的进程模型:探针租约是**进程内**的,调试台任务的 turn 子进程
 * 与交互内核会真撞探针(实测 0xe00002c5)。所以任务活跃时交互侧的硬件工具必须被
 * **策略层硬拒**,不是 UI 提示。五条:
 *
 * 1. 锁上之后 log(rtt) 被 policy 拒且理由可见,撤锁后回到 rules 放行;
 * 2. log 的 command 模式**升级问人**而不是静默落回 rules 的 allow —— 它能起任意进程;
 * 3. log stop 放行(否则锁前就在跑的采集永远停不下来,锁反过来保护了冲突源);
 * 4. gdb status 同理不被锁拒,落回 rules 的问人流;
 * 5. 挂锁会清算**在飞的未决弹窗**,且裁决者记 policy —— 当时没有人点。
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

/** 从 permission.asked 事件里取请求 id —— 联合类型收窄写三遍不如收一处。 */
function askedId(event: KernelEvent | undefined): string {
  if (!event || event.type !== "permission.asked") throw new Error("没有 permission.asked 事件")
  return event.request.id
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

  test("log 的 command 模式升级问人,而不是静默落回 rules 的 allow", async () => {
    // 它不占探针(串口那条路),但能起任意进程 —— 静默放行就是锁的后门:
    // flash 被拒的模型完全可以改用 log.command 起 probe-rs。
    const { host, events, decisions, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("log", { action: "start", command: "probe-rs attach --chip STM32G431CB" })]),
      fauxAssistantMessage([fauxText("被问了")]),
    ])
    await host.handle("mailbox.setActive", { active: true })

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "用命令模式采" } })
    await waitFor(() => events.some((event) => event.type === "permission.asked"))

    const asked = events.find((event) => event.type === "permission.asked")
    expect(asked?.type === "permission.asked" && asked.request.tool).toBe("log")
    // 走到问人流就说明没有被 rules 的 log:allow 静默吃掉。人拒了才落 deny/human。
    await host.handle("permission.respond", { id: askedId(asked), response: "reject" })
    await waitFor(() => decisions.length >= 1)
    expect(decisions[0]?.verdict).toBe("deny")
    expect(decisions[0]?.by).toBe("human")
    expect(decisions[0]?.rule).toBe("mailbox-active")

    await host.dispose()
  }, 30_000)

  test("log stop 放行 —— 否则锁前就在跑的采集永远停不下来", async () => {
    const { host, decisions, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("log", { action: "stop" })]),
      fauxAssistantMessage([fauxText("收拾干净了")]),
    ])
    await host.handle("mailbox.setActive", { active: true })

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "停掉采集" } })
    await waitFor(() => decisions.length >= 1)

    expect(decisions[0]?.tool).toBe("log")
    expect(decisions[0]?.verdict).toBe("allow")

    await host.dispose()
  }, 30_000)

  test("gdb status 不被锁拒,落回 rules 的问人流(锁只挡取用探针的动作)", async () => {
    const { host, events, decisions, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("gdb", { action: "status" })]),
      fauxAssistantMessage([fauxText("看完了")]),
    ])
    await host.handle("mailbox.setActive", { active: true })

    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "看看 gdb 状态" } })
    await waitFor(() => events.some((event) => event.type === "permission.asked"))

    // 关键是它**问了人**(gdb 在 rules 里是 ask),而不是被 policy 就地拒掉。
    expect(decisions).toHaveLength(0)
    const asked = events.find((event) => event.type === "permission.asked")
    expect(asked?.type === "permission.asked" && asked.request.tool).toBe("gdb")

    // 收尾:未决的 ask 会把会话挂在那,dispose 之前先把它答掉。
    await host.handle("permission.respond", { id: askedId(asked), response: "reject" })
    await waitFor(() => decisions.length >= 1)
    await host.dispose()
  }, 30_000)

  test("挂锁会清算在飞的未决弹窗,裁决者记 policy 而不是 human", async () => {
    // 锁挂上之前弹出的 flash 弹窗还挂着(超时 10 分钟),不清算的话用户随手一点
    // "允许"就在锁窗口内真的烧了片 —— 正是这把锁要防的撞车。
    const { host, events, decisions, workspace } = makeHost([
      fauxAssistantMessage([fauxToolCall("flash", { action: "download", chip: "STM32G431CB" })]),
      fauxAssistantMessage([fauxText("被策略拦了")]),
    ])
    const session = (await host.handle("session.create", { directory: workspace })) as Session
    await host.handle("session.prompt", { sessionID: session.id, input: { text: "烧一下" } })
    await waitFor(() => events.some((event) => event.type === "permission.asked"))
    const asked = events.find((event) => event.type === "permission.asked")
    const id = askedId(asked)
    expect(decisions).toHaveLength(0)

    await host.handle("mailbox.setActive", { active: true, reason: "调试台任务活跃(测试)" })
    await waitFor(() => decisions.length >= 1)

    expect(decisions[0]?.verdict).toBe("deny")
    expect(decisions[0]?.by).toBe("policy")
    // 弹窗要在 UI 上关掉,否则用户对着一个已经被拒的框继续点。
    await waitFor(() => events.some((event) => event.type === "permission.replied" && event.id === id && event.response === "reject"))
    // 迟到的人工应答是空操作 —— 已经不在 pending 里了。
    await host.handle("permission.respond", { id, response: "once" })
    expect(decisions.filter((decision) => decision.tool === "flash")).toHaveLength(1)

    await host.dispose()
  }, 30_000)
})
