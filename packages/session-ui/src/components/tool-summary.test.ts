import { describe, expect, test } from "vitest"
import { toolArguments, toolCommand, toolSummary } from "./tool-summary"

describe("toolSummary:工具行上那一段摘要", () => {
  // 「只显示一个 ls」:ls 不带 path 是最常见的调法(列当前目录),从前摘要是空的。
  test("ls 不带 path 也有摘要(契约给 \".\")", () => {
    expect(toolSummary("ls", {})).toBe(".")
    expect(toolSummary("ls", { path: "src" })).toBe("src")
  })

  // 从前按键名表挑,path 排在 pattern 前面,于是带了 path 的 grep 只显示 path、pattern 整个丢掉。
  test("grep / find 带了 path 仍然显示 pattern(问契约)", () => {
    expect(toolSummary("grep", { pattern: "HAL_Init", path: "Core" })).toBe("HAL_Init")
    expect(toolSummary("grep", { pattern: "TIM", glob: "*.c", path: "Core" })).toBe("TIM in *.c")
    expect(toolSummary("find", { pattern: "*.ld", path: "." })).toBe("*.ld")
  })

  test("发动机自带的四件没有契约:bash 取命令,read / write / edit 取路径", () => {
    expect(toolSummary("bash", { command: "git status", timeout: 30 })).toBe("git status")
    expect(toolSummary("read", { path: "src/main.c", offset: 10 })).toBe("src/main.c")
    expect(toolSummary("write", { path: "docs/a.md", content: "# a" })).toBe("docs/a.md")
    expect(toolSummary("edit", { path: "startup.s", edits: [] })).toBe("startup.s")
  })

  test("powershell 走契约:整段命令", () => {
    expect(toolSummary("powershell", { command: "Get-ChildItem" })).toBe("Get-ChildItem")
  })

  test("外来的工具按键名兜底;什么都没有给空串", () => {
    expect(toolSummary("mcp_search", { query: "uart dma" })).toBe("uart dma")
    expect(toolSummary("mcp_x", { n: 3 })).toBe("")
    expect(toolSummary("bash", undefined)).toBe("")
  })

  // pending 时参数可能还没拼完:摘要只是一行标签,不许为它把卡片弄崩。
  test("参数形状不对不抛", () => {
    expect(() => toolSummary("datasheet", { action: 42 } as never)).not.toThrow()
    expect(() => toolSummary("grep", { pattern: 1 } as never)).not.toThrow()
  })
})

describe("展开后的参数", () => {
  test("命令类整段给出,别的工具逐条列顶层标量(嵌套的不列)", () => {
    expect(toolCommand("bash", { command: "make -j8\nmake flash" })).toBe("make -j8\nmake flash")
    expect(toolCommand("powershell", { command: "dir" })).toBe("dir")
    expect(toolCommand("read", { path: "a" })).toBeUndefined()
    expect(toolArguments({ path: "a.c", offset: 5, force: true, edits: [{ oldText: "x" }], nothing: null })).toEqual([
      { key: "path", value: "a.c" },
      { key: "offset", value: "5" },
      { key: "force", value: "true" },
    ])
  })
})
