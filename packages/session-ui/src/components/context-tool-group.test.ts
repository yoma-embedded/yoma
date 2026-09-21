import { describe, expect, test } from "vitest"
import type { Part, ToolPart } from "@yoma-desktop/kernel"
import { contextToolSummary, isContextGroupTool } from "./context-tool-group"

const tool = (tool: string, status: ToolPart["state"]["status"] = "completed"): ToolPart =>
  ({
    id: `prt_${tool}_${status}`,
    sessionID: "s",
    messageID: "m",
    callID: `call_${tool}`,
    type: "tool",
    tool,
    state: { status, input: {} },
  }) as ToolPart

describe("isContextGroupTool", () => {
  test("只有只读的「找东西」四件", () => {
    expect(["read", "grep", "find", "ls"].every((name) => isContextGroupTool(tool(name)))).toBe(true)
  })

  // 会动硬件、会改文件、会起进程的每一次都该让人看见,不许被折进去。
  test.each(["bash", "powershell", "edit", "write", "flash", "gdb", "log", "la", "scope", "datasheet", "agent"])(
    "%s 不并组",
    (name) => {
      expect(isContextGroupTool(tool(name))).toBe(false)
    },
  )

  test("不是工具的 part 不并组", () => {
    expect(isContextGroupTool({ id: "p", sessionID: "s", messageID: "m", type: "text", text: "read" } as Part)).toBe(
      false,
    )
  })
})

describe("contextToolSummary", () => {
  test("read 算读取,grep 与 find 算搜索,ls 算列表", () => {
    expect(contextToolSummary([tool("read"), tool("read"), tool("grep"), tool("find"), tool("ls")])).toEqual({
      read: 2,
      search: 2,
      list: 1,
      failed: 0,
      active: false,
    })
  })

  test("失败的照样计数,另外单独数出来", () => {
    expect(contextToolSummary([tool("read"), tool("read", "error")])).toMatchObject({ read: 2, failed: 1 })
  })

  test.each(["pending", "running"] as const)("有 %s 的就还没完", (status) => {
    expect(contextToolSummary([tool("read"), tool("grep", status)]).active).toBe(true)
  })

  test("空组", () => {
    expect(contextToolSummary([])).toEqual({ read: 0, search: 0, list: 0, failed: 0, active: false })
  })
})
