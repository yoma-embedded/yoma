/**
 * 确认台的四种结局。
 *
 * 这些在真会话里都不好看见:超时要等十分钟,取消要先把一轮跑起来,而"点慢了"根本无法手动复现。
 * 所以确认台是纯逻辑 —— 这里逐条钉住它,钩子那边只剩"把 summary 拼出来、把 block 返回去"。
 */

import { describe, expect, test } from "vitest"

import { ConfirmDesk, type ToolConfirmRequest } from "./confirm.ts"
import type { ToolConfirmView } from "../types.ts"

function deskWith(timeoutMs?: number) {
  const views: ToolConfirmView[] = []
  const desk = new ConfirmDesk({ emit: (view) => views.push(view), ...(timeoutMs ? { timeoutMs } : {}) })
  return { desk, views, statuses: () => views.map((view) => view.status) }
}

function request(overrides: Partial<ToolConfirmRequest> = {}): ToolConfirmRequest {
  return {
    id: "cfm_1",
    sessionID: "ses_1",
    toolCallId: "call_1",
    tool: "flash",
    label: "烧录",
    summary: 'openocd -c "program fw.elf"',
    input: { command: ["openocd"] },
    askedAt: 1,
    ...overrides,
  }
}

describe("确认台", () => {
  test("允许:ask 解出 allowed,先 pending 再 allowed", async () => {
    const { desk, views, statuses } = deskWith()
    const asked = desk.ask(request(), undefined)

    expect(statuses()).toEqual(["pending"])
    expect(views[0]).toMatchObject({ id: "cfm_1", tool: "flash", label: "烧录", sessionID: "ses_1" })
    expect(desk.reply("cfm_1", true)).toBe(true)
    await expect(asked).resolves.toBe("allowed")
    expect(statuses()).toEqual(["pending", "allowed"])
  })

  test("拒绝:ask 解出 denied,结算视图也是 denied", async () => {
    const { desk, statuses } = deskWith()
    const asked = desk.ask(request(), undefined)
    expect(desk.reply("cfm_1", false)).toBe(true)
    await expect(asked).resolves.toBe("denied")
    expect(statuses()).toEqual(["pending", "denied"])
  })

  test("signal 中止(用户点了停止):cancelled,且不再占着未决表", async () => {
    const { desk, statuses } = deskWith()
    const controller = new AbortController()
    const asked = desk.ask(request(), controller.signal)
    expect(desk.pending()).toHaveLength(1)

    controller.abort()
    await expect(asked).resolves.toBe("cancelled")
    expect(statuses()).toEqual(["pending", "cancelled"])
    expect(desk.pending()).toEqual([])
  })

  test("signal 来时已经中止:不挂起、不发事件 —— 这条询问没有任何人见过", async () => {
    const { desk, views } = deskWith()
    await expect(desk.ask(request(), AbortSignal.abort())).resolves.toBe("cancelled")
    expect(views).toEqual([])
    expect(desk.pending()).toEqual([])
  })

  test("没人答:超时结算成 expired", async () => {
    const { desk, statuses } = deskWith(5)
    await expect(desk.ask(request(), undefined)).resolves.toBe("expired")
    expect(statuses()).toEqual(["pending", "expired"])
  })

  test("点慢了:未知 id 回 false 而不抛(已结算的那条也一样)", async () => {
    const { desk } = deskWith()
    expect(desk.reply("cfm_nobody", true)).toBe(false)

    const asked = desk.ask(request(), undefined)
    expect(desk.reply("cfm_1", false)).toBe(true)
    await asked
    expect(desk.reply("cfm_1", true)).toBe(false)
  })

  test("pending:按 sessionID 过滤,不传就是全部,顺序是提问顺序", async () => {
    const { desk } = deskWith()
    const first = desk.ask(request({ id: "cfm_1", sessionID: "ses_1" }), undefined)
    const second = desk.ask(request({ id: "cfm_2", sessionID: "ses_2" }), undefined)
    const third = desk.ask(request({ id: "cfm_3", sessionID: "ses_1" }), undefined)

    expect(desk.pending().map((view) => view.id)).toEqual(["cfm_1", "cfm_2", "cfm_3"])
    expect(desk.pending("ses_1").map((view) => view.id)).toEqual(["cfm_1", "cfm_3"])
    expect(desk.pending("ses_none")).toEqual([])
    expect(desk.pending("ses_1").every((view) => view.status === "pending")).toBe(true)

    desk.cancel("ses_1")
    desk.cancel("ses_2")
    await Promise.all([first, second, third])
  })

  test("会话关掉:这个会话的全部按 cancelled 结算,别的会话不动", async () => {
    const { desk, views } = deskWith()
    const first = desk.ask(request({ id: "cfm_1", sessionID: "ses_1" }), undefined)
    const second = desk.ask(request({ id: "cfm_2", sessionID: "ses_1" }), undefined)
    const other = desk.ask(request({ id: "cfm_3", sessionID: "ses_2" }), undefined)

    desk.cancel("ses_1")
    await expect(first).resolves.toBe("cancelled")
    await expect(second).resolves.toBe("cancelled")
    expect(views.filter((view) => view.status === "cancelled").map((view) => view.id)).toEqual(["cfm_1", "cfm_2"])
    expect(desk.pending().map((view) => view.id)).toEqual(["cfm_3"])

    desk.cancel("ses_2")
    await other
  })
})
