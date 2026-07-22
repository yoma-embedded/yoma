import { describe, expect, test } from "bun:test"
import {
  ancestorDirs,
  detectEol,
  dropFromHistory,
  HISTORY_MAX,
  historyStep,
  isEditableContent,
  isMarkdownPath,
  lineColFromIndex,
  normalizeEol,
  pushHistory,
  selectionFromOffsets,
  serializeEol,
  type ExplorerHistory,
} from "./explorer-state"

describe("pushHistory", () => {
  test("appends and moves index", () => {
    let history: ExplorerHistory = { stack: [], index: -1 }
    history = pushHistory(history, "a.ts")
    history = pushHistory(history, "b.ts")
    expect(history.stack).toEqual(["a.ts", "b.ts"])
    expect(history.index).toBe(1)
  })

  test("ignores re-push of current entry", () => {
    const history: ExplorerHistory = { stack: ["a.ts"], index: 0 }
    expect(pushHistory(history, "a.ts")).toBe(history)
  })

  test("drops forward entries when branching", () => {
    const history: ExplorerHistory = { stack: ["a.ts", "b.ts", "c.ts"], index: 0 }
    const next = pushHistory(history, "d.ts")
    expect(next.stack).toEqual(["a.ts", "d.ts"])
    expect(next.index).toBe(1)
  })

  test("caps stack length", () => {
    let history: ExplorerHistory = { stack: [], index: -1 }
    for (let i = 0; i < HISTORY_MAX + 10; i++) history = pushHistory(history, `f${i}.ts`)
    expect(history.stack.length).toBe(HISTORY_MAX)
    expect(history.stack[history.stack.length - 1]).toBe(`f${HISTORY_MAX + 9}.ts`)
    expect(history.index).toBe(HISTORY_MAX - 1)
  })
})

describe("historyStep", () => {
  const history: ExplorerHistory = { stack: ["a", "b", "c"], index: 1 }

  test("moves back and forward", () => {
    expect(historyStep(history, -1).index).toBe(0)
    expect(historyStep(history, 1).index).toBe(2)
  })

  test("clamps at both ends", () => {
    expect(historyStep({ stack: ["a"], index: 0 }, -1)).toEqual({ stack: ["a"], index: 0 })
    expect(historyStep({ stack: ["a"], index: 0 }, 1)).toEqual({ stack: ["a"], index: 0 })
  })
})

describe("dropFromHistory", () => {
  test("removes all occurrences and keeps index near position", () => {
    const history: ExplorerHistory = { stack: ["a", "b", "a", "c"], index: 2 }
    const next = dropFromHistory(history, "a")
    expect(next.stack).toEqual(["b", "c"])
    expect(next.index).toBe(0)
  })

  test("returns same object when path absent", () => {
    const history: ExplorerHistory = { stack: ["a"], index: 0 }
    expect(dropFromHistory(history, "x")).toBe(history)
  })
})

describe("isMarkdownPath", () => {
  test("matches md/markdown/mdx case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true)
    expect(isMarkdownPath("doc/后端开发交接.MD")).toBe(true)
    expect(isMarkdownPath("a.markdown")).toBe(true)
    expect(isMarkdownPath("a.mdx")).toBe(true)
    expect(isMarkdownPath("a.mdown")).toBe(false)
    expect(isMarkdownPath("md")).toBe(false)
    expect(isMarkdownPath("a.ts")).toBe(false)
  })
})

describe("isEditableContent", () => {
  test("only plain text content is editable", () => {
    expect(isEditableContent(undefined)).toBe(false)
    expect(isEditableContent({ type: "text", content: "x" })).toBe(true)
    expect(isEditableContent({ type: "binary", content: "" })).toBe(false)
    expect(isEditableContent({ type: "text", content: "eA==", encoding: "base64" })).toBe(false)
  })
})

describe("lineColFromIndex", () => {
  const text = "one\ntwo\n\nfour"

  test("first line", () => {
    expect(lineColFromIndex(text, 0)).toEqual({ line: 1, col: 0 })
    expect(lineColFromIndex(text, 3)).toEqual({ line: 1, col: 3 })
  })

  test("after newlines", () => {
    expect(lineColFromIndex(text, 4)).toEqual({ line: 2, col: 0 })
    expect(lineColFromIndex(text, 8)).toEqual({ line: 3, col: 0 })
    expect(lineColFromIndex(text, 9)).toEqual({ line: 4, col: 0 })
    expect(lineColFromIndex(text, 13)).toEqual({ line: 4, col: 4 })
  })

  test("clamps out-of-range index", () => {
    expect(lineColFromIndex(text, 999)).toEqual({ line: 4, col: 4 })
    expect(lineColFromIndex(text, -5)).toEqual({ line: 1, col: 0 })
  })
})

describe("selectionFromOffsets", () => {
  test("orders reversed selections", () => {
    const text = "alpha\nbeta\ngamma"
    const selection = selectionFromOffsets(text, 12, 2)
    expect(selection).toEqual({ startLine: 1, startChar: 2, endLine: 3, endChar: 1 })
  })
})

describe("eol helpers", () => {
  test("detectEol majority rule", () => {
    expect(detectEol("a\nb\n")).toBe("\n")
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n")
    expect(detectEol("a\r\nb\nc\nd\n")).toBe("\n")
    expect(detectEol("a\r\nb\r\nc\r\nd\n")).toBe("\r\n")
    expect(detectEol("no newline")).toBe("\n")
  })

  test("normalize and serialize round-trip", () => {
    const raw = "a\r\nb\rc\nd"
    expect(normalizeEol(raw)).toBe("a\nb\nc\nd")
    expect(serializeEol("a\nb", "\r\n")).toBe("a\r\nb")
    expect(serializeEol("a\nb", "\n")).toBe("a\nb")
  })
})

describe("ancestorDirs", () => {
  test("lists ancestors excluding the leaf", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"])
    expect(ancestorDirs("c.ts")).toEqual([])
    expect(ancestorDirs("a//b.ts")).toEqual(["a"])
  })
})
