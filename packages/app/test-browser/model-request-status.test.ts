import { describe, expect, test } from "vitest"
import { createComponent, createMemo } from "solid-js"
import { render } from "solid-js/web"
import type { AssistantMessage, SessionStatus, UserMessage } from "@yoma-desktop/kernel"
import type { Sdk } from "@/utils/kernel"
import { createServerSession } from "@/context/server-session"
import { createTimelineProjection } from "@/pages/session/timeline/projection"
import { ModelRequestStatus } from "@/pages/session/timeline/model-request-status"
import { dict } from "@/i18n/zh"

describe("model request status through the session store", () => {
  test("updates the same card from retrying to recovered and to a later terminal failure", () => {
    const store = createServerSession({} as Sdk)
    store.apply({
      type: "session.created",
      session: { id: "s", directory: "/test", title: "test", time: { created: 1, updated: 1 } },
    })
    const user: UserMessage = {
      id: "msg_0",
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      model: { providerID: "deepseek", modelID: "flash" },
    }
    const failed: AssistantMessage = {
      id: "msg_1",
      sessionID: "s",
      role: "assistant",
      parentID: user.id,
      time: { created: 2, completed: 3 },
      providerID: "deepseek",
      modelID: "flash",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { name: "UnknownError", data: { message: "Connection error." } },
    }
    const status = (value: SessionStatus) => store.apply({ type: "session.status", sessionID: "s", status: value })
    store.apply({ type: "message.updated", message: user })
    store.apply({ type: "message.updated", message: failed })
    status({
      type: "busy",
      retry: { attempt: 2, maxAttempts: 4, notBefore: 100, error: "Connection error.", providerID: "deepseek" },
    })
    const container = document.createElement("div")
    document.body.append(container)
    const dispose = render(() => {
      const timeline = createTimelineProjection({
        messages: () => store.data.message.s,
        userMessages: () => [user],
        parts: (id) => store.data.part[id] ?? [],
        status: () => store.data.session_status.s,
        showReasoningSummaries: () => true,
      })
      const row = createMemo(() => timeline.rows().find((row) => row._tag === "ModelRequest")!)
      return createComponent(ModelRequestStatus, {
        get row() {
          return row()
        },
        get title() {
          return dict[`session.modelRequest.${row().state}`]
            .replace("{{provider}}", row().providerID)
            .replace("{{attempt}}", String(row().attempt))
            .replace("{{maxAttempts}}", String(row().maxAttempts))
        },
      })
    }, container)
    try {
      const card = container.querySelector('[data-kind="model-request"]')!
      expect(card.getAttribute("data-variant")).toBe("warning")
      expect(card.textContent).toContain("正在重试（deepseek，第 2/4 次请求）")
      status({
        type: "busy",
        retry: { attempt: 3, maxAttempts: 4, notBefore: 200, error: "Connection error.", providerID: "deepseek" },
      })
      expect(card.textContent).toContain("第 3/4 次请求")

      store.apply({ type: "message.updated", message: { ...failed, id: "msg_2", error: undefined } })
      status({ type: "busy" })
      expect(container.querySelector('[data-kind="model-request"]')).toBe(card)
      expect(card.getAttribute("data-variant")).toBe("success")
      expect(card.textContent).toBe("模型请求已恢复（deepseek）")
      status({ type: "idle" })
      expect(card.textContent).toBe("模型请求已恢复（deepseek）")

      store.apply({
        type: "message.updated",
        message: {
          ...failed,
          id: "msg_3",
          error: { name: "ProviderAuthError", data: { providerID: "deepseek", message: "401 invalid api key" } },
        },
      })
      expect(card.getAttribute("data-variant")).toBe("error")
      expect(card.textContent).toContain("模型请求失败（deepseek）")
      expect(card.textContent).toContain("401 invalid api key")
    } finally {
      dispose()
      container.remove()
    }
  })
})
