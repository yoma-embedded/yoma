import { describe, expect, test } from "vitest"
import type { Part } from "@yoma-desktop/kernel"
import { processSummary } from "./process-group"

const tool = (id: string, status: "completed" | "error" | "running" = "completed"): Part =>
  ({
    id,
    sessionID: "s",
    messageID: "m",
    callID: `call_${id}`,
    type: "tool",
    tool: "bash",
    state:
      status === "error"
        ? { status, input: {}, error: "boom", metadata: {}, time: { start: 1, end: 2 } }
        : status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : { status, input: {}, output: "", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
  }) as Part
const text = (id: string): Part => ({ id, sessionID: "s", messageID: "m", type: "text", text: "说明" })

describe("「处理详情」的计数", () => {
  test("只数工具调用,说明文字不算;失败、没结果的各自单独数", () => {
    expect(processSummary([text("t1"), tool("a"), tool("b", "error"), tool("c", "running"), text("t2")])).toEqual({
      tools: 3,
      failed: 1,
      unfinished: 1,
    })
    expect(processSummary([])).toEqual({ tools: 0, failed: 0, unfinished: 0 })
  })
})
