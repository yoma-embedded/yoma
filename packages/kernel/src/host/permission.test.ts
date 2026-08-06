/**
 * 权限门单测:三层裁决(policy → rules → ask)+ 审计出口。
 *
 * 不起真 harness —— 门只消费 harness.on("tool_call", handler) 这一个面,
 * 用假 harness 把 handler 抓出来直接喂事件,断言返回值与副作用(事件、审计记录)。
 */

import { describe, expect, test } from "bun:test"

import type { AgentHarness } from "@yoma/my-pi"

import type { KernelEvent } from "../protocol.ts"
import type { PermissionRequest } from "../types.ts"
import { PermissionGate, type PermissionDecision, type PermissionGateOptions } from "./permission.ts"

type BlockResult = { block: true; reason: string } | undefined
type ToolCallHandler = (event: {
  toolName: string
  input?: Record<string, unknown>
  toolCallId: string
}) => Promise<BlockResult>

function makeGate(overrides: Partial<PermissionGateOptions> = {}) {
  const events: KernelEvent[] = []
  const decisions: PermissionDecision[] = []
  const gate = new PermissionGate({
    emit: (event) => events.push(event),
    onDecision: (decision) => decisions.push(decision),
    ...overrides,
  })

  let handler: ToolCallHandler | undefined
  const harness = {
    on: (_type: string, h: ToolCallHandler) => {
      handler = h
      return () => {
        handler = undefined
      }
    },
  } as unknown as AgentHarness
  gate.attach(harness, "ses_1", () => "msg_1")

  const call = (toolName: string, input: Record<string, unknown> = {}) =>
    handler!({ toolName, input, toolCallId: "call_1" })
  const askedRequest = (): PermissionRequest => {
    const asked = events.find((e) => e.type === "permission.asked") as { request: PermissionRequest } | undefined
    expect(asked).toBeDefined()
    return asked!.request
  }
  return { gate, events, decisions, call, askedRequest }
}

describe("PermissionGate · rules 表", () => {
  test("allow 直接放行并留审计", async () => {
    const { call, events, decisions } = makeGate()
    expect(await call("read", { path: "/a" })).toBeUndefined()
    expect(events.length).toBe(0)
    expect(decisions).toEqual([
      expect.objectContaining({ tool: "read", verdict: "allow", by: "rule", rule: "read:allow" }),
    ])
  })

  test("deny 不问直接拦", async () => {
    const { call, events, decisions } = makeGate({ rules: { bash: "deny" } })
    const result = await call("bash", { command: "rm -rf /" })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("权限规则禁止 bash")
    expect(events.length).toBe(0)
    expect(decisions[0]).toEqual(expect.objectContaining({ verdict: "deny", by: "rule", rule: "bash:deny" }))
  })

  test("未知工具默认要问", async () => {
    const { call, gate, askedRequest } = makeGate()
    const pending = call("scope", {})
    expect(gate.outstanding().length).toBe(1)
    gate.respond(askedRequest().id, "once")
    expect(await pending).toBeUndefined()
  })
})

describe("PermissionGate · ask 流", () => {
  test("once 放行一次,审计记 human", async () => {
    const { call, gate, decisions, askedRequest } = makeGate()
    const pending = call("bash", { command: "make" })
    gate.respond(askedRequest().id, "once")
    expect(await pending).toBeUndefined()
    expect(decisions[0]).toEqual(
      expect.objectContaining({ verdict: "allow", by: "human", response: "once", title: "执行命令:make" }),
    )
  })

  test("reject 拦下", async () => {
    const { call, gate, askedRequest } = makeGate()
    const pending = call("bash", { command: "make" })
    gate.respond(askedRequest().id, "reject")
    const result = await pending
    expect(result?.reason).toBe("用户拒绝了 bash")
  })

  test("always 改写规则,下一次直接放行", async () => {
    const { call, gate, decisions, askedRequest } = makeGate()
    const pending = call("bash", { command: "make" })
    gate.respond(askedRequest().id, "always")
    expect(await pending).toBeUndefined()
    expect(gate.getRules().bash).toBe("allow")
    expect(await call("bash", { command: "make -j" })).toBeUndefined()
    expect(decisions[1]).toEqual(expect.objectContaining({ by: "rule", rule: "bash:allow" }))
  })

  test("超时自动拒绝,审计记 timeout", async () => {
    const { call, events, decisions } = makeGate({ timeoutMs: 5 })
    const result = await call("bash", { command: "make" })
    expect(result?.reason).toContain("权限请求超时")
    expect(events.some((e) => e.type === "permission.replied" && e.response === "reject")).toBe(true)
    expect(decisions[0]).toEqual(expect.objectContaining({ verdict: "deny", by: "timeout" }))
  })

  test("detach 拒绝该会话全部未决请求", async () => {
    const { call, gate, decisions } = makeGate()
    const pending = call("bash", { command: "make" })
    await Bun.sleep(0) // 让 handler 跑到 ask,pending 登记完成
    gate.detach("ses_1")
    const result = await pending
    expect(result?.reason).toContain("会话已关闭")
    expect(gate.outstanding().length).toBe(0)
    expect(decisions[0]).toEqual(expect.objectContaining({ verdict: "deny", by: "detach" }))
  })
})

describe("PermissionGate · 注入式策略", () => {
  test("policy allow 越过 ask 规则,不产生弹窗", async () => {
    const { call, events, decisions } = makeGate({
      policy: async () => ({ action: "allow", rule: "job:flash-download" }),
    })
    expect(await call("flash", { action: "download", chip: "STM32G474RE" })).toBeUndefined()
    expect(events.length).toBe(0)
    expect(decisions[0]).toEqual(expect.objectContaining({ by: "policy", rule: "job:flash-download" }))
  })

  test("policy deny 越过 allow 规则,reason 用策略给的", async () => {
    const { call, decisions } = makeGate({
      policy: () => ({ action: "deny", rule: "job:no-erase", reason: "本任务禁止擦片" }),
    })
    const result = await call("read", { path: "/a" })
    expect(result?.reason).toBe("本任务禁止擦片")
    expect(decisions[0]).toEqual(expect.objectContaining({ verdict: "deny", by: "policy", rule: "job:no-erase" }))
  })

  test("policy escalate 强制问人,即使规则是 allow", async () => {
    const { call, gate, decisions, askedRequest } = makeGate({
      policy: () => ({ action: "escalate", rule: "job:big-diff" }),
    })
    const pending = call("read", { path: "/a" })
    await Bun.sleep(0)
    gate.respond(askedRequest().id, "once")
    expect(await pending).toBeUndefined()
    expect(decisions[0]).toEqual(expect.objectContaining({ by: "human", rule: "job:big-diff" }))
  })

  test("policy 无意见(undefined)落回 rules", async () => {
    const { call, decisions } = makeGate({ policy: () => undefined })
    expect(await call("read", { path: "/a" })).toBeUndefined()
    expect(decisions[0]).toEqual(expect.objectContaining({ by: "rule" }))
  })

  test("policy 抛错按 escalate 处理 —— 绝不静默放行", async () => {
    const { call, gate, decisions, askedRequest } = makeGate({
      policy: () => {
        throw new Error("策略炸了")
      },
    })
    const pending = call("read", { path: "/a" })
    await Bun.sleep(0)
    gate.respond(askedRequest().id, "reject")
    const result = await pending
    expect(result?.block).toBe(true)
    expect(decisions[0]).toEqual(expect.objectContaining({ verdict: "deny", by: "human", rule: "policy-error" }))
  })

  test("escalate 后 always 只改 rules —— 策略仍是外层权威,下次照样问", async () => {
    const { call, gate, askedRequest, events } = makeGate({
      policy: () => ({ action: "escalate" }),
    })
    const first = call("bash", { command: "make" })
    await Bun.sleep(0)
    gate.respond(askedRequest().id, "always")
    expect(await first).toBeUndefined()
    expect(gate.getRules().bash).toBe("allow")

    const second = call("bash", { command: "make" })
    await Bun.sleep(0)
    const askedTwice = events.filter((e) => e.type === "permission.asked")
    expect(askedTwice.length).toBe(2)
    gate.respond((askedTwice[1] as { request: PermissionRequest }).request.id, "once")
    expect(await second).toBeUndefined()
  })
})

describe("PermissionGate · 审计出口", () => {
  test("onDecision 抛错不反噬权限门", async () => {
    const { call } = makeGate({
      onDecision: () => {
        throw new Error("审计盘满了")
      },
    })
    expect(await call("read", { path: "/a" })).toBeUndefined()
  })

  test("elapsedMs 与 callID 落在记录里", async () => {
    const { call, decisions } = makeGate()
    await call("read", { path: "/a" })
    expect(decisions[0]!.callID).toBe("call_1")
    expect(decisions[0]!.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
