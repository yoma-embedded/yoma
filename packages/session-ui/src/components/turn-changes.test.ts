import { describe, expect, test } from "vitest"
import type { Part, ToolPart } from "@yoma-desktop/kernel"
import { fileChangeView, isFileChange, resolveChangePath, turnFileChanges } from "./turn-changes"

// 上游 edit 工具真实产出的 patch(generateUnifiedPatch,FILE_HEADERS_ONLY,4 行上下文):
// 30 行的文件,第 5 行换成两行,第 25 行删掉 —— +2 −2,两个 hunk。
const EDIT_PATCH =
  "--- src/main.c\n+++ src/main.c\n@@ -1,9 +1,10 @@\n line 1\n line 2\n line 3\n line 4\n-line 5\n+line five\n+line 5b\n line 6\n line 7\n line 8\n line 9\n@@ -21,9 +22,8 @@\n line 21\n line 22\n line 23\n line 24\n-line 25\n line 26\n line 27\n line 28\n line 29\n"

let seq = 0
function tool(
  name: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  status: "completed" | "error" | "running" = "completed",
): ToolPart {
  seq += 1
  const time = { start: 1, end: 2 }
  const state =
    status === "completed"
      ? { status, input, output: "ok", title: "", metadata: metadata ?? {}, time }
      : status === "error"
        ? { status, input, error: "boom", metadata: metadata ?? {}, time }
        : { status, input, time: { start: 1 } }
  return {
    id: `p${seq}`,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: `c${seq}`,
    tool: name,
    state,
  } as ToolPart
}

const DIR = "/work/fw"

describe("isFileChange", () => {
  test("只认跑完的 edit / write", () => {
    expect(isFileChange(tool("edit", { path: "a.c" }, { patch: EDIT_PATCH }))).toBe(true)
    expect(isFileChange(tool("write", { path: "a.c", content: "x" }))).toBe(true)
    expect(isFileChange(tool("edit", { path: "a.c" }, undefined, "error"))).toBe(false)
    expect(isFileChange(tool("write", { path: "a.c", content: "x" }, undefined, "running"))).toBe(false)
    expect(isFileChange(tool("bash", { command: "sed -i s/a/b/ a.c" }))).toBe(false)
    expect(isFileChange({ id: "t", sessionID: "s", messageID: "m", type: "text", text: "hi" } as Part)).toBe(false)
  })
})

describe("resolveChangePath", () => {
  test("相对路径补会话目录;绝对路径、盘符、UNC 原样", () => {
    expect(resolveChangePath(DIR, "src/main.c")).toBe("/work/fw/src/main.c")
    expect(resolveChangePath(DIR + "/", "./src/main.c")).toBe("/work/fw/src/main.c")
    expect(resolveChangePath(DIR, "@src/main.c")).toBe("/work/fw/src/main.c")
    expect(resolveChangePath(DIR, "/etc/hosts")).toBe("/etc/hosts")
    expect(resolveChangePath("C:\\fw", "C:\\fw\\main.c")).toBe("C:\\fw\\main.c")
    expect(resolveChangePath(DIR, "\\\\nas\\share\\a.c")).toBe("\\\\nas\\share\\a.c")
  })
})

describe("turnFileChanges", () => {
  test("同一个文件的相对写法和绝对写法并成一项,按第一次出现排序", () => {
    const changes = turnFileChanges(
      [
        tool("edit", { path: "src/main.c" }, { patch: EDIT_PATCH }),
        tool("write", { path: "README.md", content: "# fw\n" }, { before: null }),
        tool("edit", { path: "/work/fw/src/main.c" }, { patch: EDIT_PATCH }),
      ],
      DIR,
    )
    expect(changes.map((item) => [item.display, item.sources.length, item.created])).toEqual([
      ["src/main.c", 2, false],
      ["README.md", 1, true],
    ])
  })

  test("会话目录之外的文件显示绝对路径;目录名只是前缀相同的不算在里面", () => {
    const changes = turnFileChanges(
      [
        tool("write", { path: "/work/fw-old/a.c", content: "x\n" }, { before: null }),
        tool("write", { path: "/tmp/b.c", content: "x\n" }, { before: null }),
      ],
      DIR,
    )
    expect(changes.map((item) => item.display)).toEqual(["/work/fw-old/a.c", "/tmp/b.c"])
  })

  test("write:新建 / 覆盖 / 没记下旧内容 三种", () => {
    const [created, overwritten, opaque] = turnFileChanges(
      [
        tool("write", { path: "new.c", content: "a\nb\n" }, { before: null }),
        tool("write", { path: "old.c", content: "a\nB\n" }, { before: "a\nb\n" }),
        tool("write", { path: "legacy.c", content: "whatever\n" }),
      ],
      DIR,
    )
    expect(created).toMatchObject({ created: true, opaque: 0 })
    expect(created!.sources).toEqual([{ file: "/work/fw/new.c", before: "", after: "a\nb\n" }])
    expect(overwritten).toMatchObject({ created: false, opaque: 0 })
    expect(overwritten!.sources).toEqual([{ file: "/work/fw/old.c", before: "a\nb\n", after: "a\nB\n" }])
    // 旧会话里的 write 没有 details:文件照样列出来,只是没有 diff 可画
    expect(opaque).toMatchObject({ created: false, opaque: 1, sources: [] })
  })

  test("先新建再修改:仍算新建,两次改动都在", () => {
    const [change] = turnFileChanges(
      [
        tool("write", { path: "gpio.c", content: "void init(void) {}\n" }, { before: null }),
        tool("edit", { path: "gpio.c" }, { patch: EDIT_PATCH }),
      ],
      DIR,
    )
    expect(change).toMatchObject({ created: true, opaque: 0 })
    expect(change!.sources).toHaveLength(2)
  })

  test("没跑完和失败的不算;别的工具不算", () => {
    expect(
      turnFileChanges(
        [
          tool("edit", { path: "a.c" }, undefined, "error"),
          tool("write", { path: "b.c", content: "x" }, undefined, "running"),
          tool("read", { path: "c.c" }),
        ],
        DIR,
      ),
    ).toEqual([])
  })
})

describe("fileChangeView", () => {
  test("edit 的真实 patch 能解析,行数从 hunk 里数", () => {
    const [change] = turnFileChanges([tool("edit", { path: "src/main.c" }, { patch: EDIT_PATCH })], DIR)
    const view = fileChangeView(change!)
    expect(view.diffs).toHaveLength(1)
    expect(view.diffs[0]!.hunks).toHaveLength(2)
    expect([view.additions, view.deletions]).toEqual([2, 2])
  })

  test("write 的前后内容算出 diff;同一个文件多次改动的行数相加", () => {
    const [change] = turnFileChanges(
      [
        tool("write", { path: "cfg.h", content: "#define A 1\n#define B 2\n" }, { before: null }),
        tool(
          "write",
          { path: "cfg.h", content: "#define A 1\n#define B 3\n" },
          { before: "#define A 1\n#define B 2\n" },
        ),
      ],
      DIR,
    )
    const view = fileChangeView(change!)
    expect(view.diffs).toHaveLength(2)
    expect([view.additions, view.deletions]).toEqual([3, 1])
  })

  test("没有可画的改动时是零,不抛", () => {
    const [change] = turnFileChanges([tool("write", { path: "legacy.c", content: "x\n" })], DIR)
    expect(fileChangeView(change!)).toEqual({ diffs: [], additions: 0, deletions: 0 })
  })
})
