import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { buildRequestParts } from "./build-request-parts"

describe("buildRequestParts", () => {
  test("builds a kernel PromptInput plus matching optimistic parts", () => {
    const prompt: Prompt = [
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "file",
        path: "src/foo.ts",
        content: "@src/foo.ts",
        start: 5,
        end: 16,
        selection: { startLine: 4, startChar: 1, endLine: 6, endChar: 1 },
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [{ key: "ctx:1", type: "file", path: "src/bar.ts", comment: "check this" }],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      ],
      text: "hello @src/foo.ts",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    expect(result.input.messageID).toBe("msg_1")
    expect(result.input.text.startsWith("hello @src/foo.ts")).toBe(true)
    // 行内评论没有 metadata 通道了,只能拼进正文。
    expect(result.input.text).toContain("check this")
    expect(result.input.files?.some((file) => file.url.startsWith("file:///repo/src/foo.ts"))).toBe(true)
    expect(result.input.files?.some((file) => file.url.startsWith("data:image/png"))).toBe(true)

    // 乐观 part 与请求同构:一条 text + 每个附件一条 file。
    expect(result.optimisticParts).toHaveLength(1 + (result.input.files?.length ?? 0))
    expect(result.optimisticParts[0]?.type).toBe("text")
    expect(result.optimisticParts.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_1")).toBe(true)
  })

  test("keeps multiple uploaded attachments in order", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "check these", start: 0, end: 11 }],
      context: [],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        {
          type: "image",
          id: "img_2",
          filename: "b.pdf",
          mime: "application/pdf",
          dataUrl: "data:application/pdf;base64,BBB",
        },
      ],
      text: "check these",
      messageID: "msg_multi",
      sessionID: "ses_multi",
      sessionDirectory: "/repo",
    })

    const files = (result.input.files ?? []).filter((file) => file.url.startsWith("data:"))

    expect(files).toHaveLength(2)
    expect(files.map((file) => file.filename)).toEqual(["a.png", "b.pdf"])
  })

  test("preserves an external attachment source path for the model", () => {
    const result = buildRequestParts({
      prompt: [],
      context: [],
      images: [
        {
          type: "image",
          id: "img_external",
          filename: "opencode.global.dat",
          sourcePath: "C:\\Users\\Luke\\AppData\\Roaming\\ai.opencode.desktop.beta\\opencode.global.dat",
          mime: "text/plain",
          dataUrl: "data:text/plain;base64,AAA",
        },
      ],
      text: "inspect this",
      messageID: "msg_external",
      sessionID: "ses_external",
      sessionDirectory: "C:\\Repos\\sst\\opencode",
    })

    expect(result.input.files?.[0]?.filename).toBe(
      "C:\\Users\\Luke\\AppData\\Roaming\\ai.opencode.desktop.beta\\opencode.global.dat",
    )
  })

  test("keeps directory aliases as directory file attachments", () => {
    const result = buildRequestParts({
      prompt: [
        {
          type: "file",
          path: "/repo/../docs",
          content: "@docs",
          start: 0,
          end: 5,
          mime: "application/x-directory",
          filename: "docs",
        },
      ],
      context: [],
      images: [],
      text: "@docs",
      messageID: "msg_reference",
      sessionID: "ses_reference",
      sessionDirectory: "/repo/app",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(file?.mime).toBe("application/x-directory")
    expect(file?.filename).toBe("docs")
    expect(file?.url).toBe("file:///repo/../docs")
  })

  test("deduplicates context files when prompt already includes same path", () => {
    const prompt: Prompt = [{ type: "file", path: "src/foo.ts", content: "@src/foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:dup", type: "file", path: "src/foo.ts" },
        { key: "ctx:comment", type: "file", path: "src/foo.ts", comment: "focus here" },
      ],
      images: [],
      text: "@src/foo.ts",
      messageID: "msg_2",
      sessionID: "ses_2",
      sessionDirectory: "/repo",
    })

    const fooFiles = (result.input.files ?? []).filter((file) => file.url.startsWith("file:///repo/src/foo.ts"))

    expect(fooFiles).toHaveLength(2)
    expect(result.input.text).toContain("focus here")
  })

  test("adds file attachments for @mentions inside comment text", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "look", start: 0, end: 4 }],
      context: [
        {
          key: "ctx:comment-mention",
          type: "file",
          path: "src/review.ts",
          comment: "Compare with @src/shared.ts and @src/review.ts.",
        },
      ],
      images: [],
      text: "look",
      messageID: "msg_comment_mentions",
      sessionID: "ses_comment_mentions",
      sessionDirectory: "/repo",
    })

    const files = result.input.files ?? []
    expect(files).toHaveLength(2)
    expect(files.some((file) => file.url === "file:///repo/src/review.ts")).toBe(true)
    expect(files.some((file) => file.url === "file:///repo/src/shared.ts")).toBe(true)
  })

  test("handles Windows paths correctly (simulated on macOS)", () => {
    const prompt: Prompt = [{ type: "file", path: "src\\foo.ts", content: "@src\\foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\foo.ts",
      messageID: "msg_win_1",
      sessionID: "ses_win_1",
      sessionDirectory: "D:\\projects\\myapp", // Windows path
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).not.toContain("%5C")
    expect(file!.url).toContain("/src/foo.ts")
  })

  test("handles Windows absolute path with special characters", () => {
    const prompt: Prompt = [{ type: "file", path: "file#name.txt", content: "@file#name.txt", start: 0, end: 14 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@file#name.txt",
      messageID: "msg_win_2",
      sessionID: "ses_win_2",
      sessionDirectory: "C:\\Users\\test\\Documents", // Windows path
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).toContain("file%23name.txt")
    expect(file!.url).toMatch(/file:\/\/\/[A-Z]:/)
  })

  test("handles Linux absolute paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 10 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src/app.ts",
      messageID: "msg_linux_1",
      sessionID: "ses_linux_1",
      sessionDirectory: "/home/user/project",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).toBe("file:///home/user/project/src/app.ts")
  })

  test("handles macOS paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "README.md", content: "@README.md", start: 0, end: 9 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@README.md",
      messageID: "msg_mac_1",
      sessionID: "ses_mac_1",
      sessionDirectory: "/Users/kelvin/Projects/opencode",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).toBe("file:///Users/kelvin/Projects/opencode/README.md")
  })

  test("handles context files with Windows paths", () => {
    const prompt: Prompt = []

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:1", type: "file", path: "src\\utils\\helper.ts" },
        { key: "ctx:2", type: "file", path: "test\\unit.test.ts", comment: "check tests" },
      ],
      images: [],
      text: "test",
      messageID: "msg_win_ctx",
      sessionID: "ses_win_ctx",
      sessionDirectory: "D:\\workspace\\app",
    })

    const files = result.input.files ?? []
    expect(files).toHaveLength(2)

    files.forEach((file) => {
      expect(() => new URL(file.url)).not.toThrow()
      expect(file.url).not.toContain("%5C") // No encoded backslashes
    })
  })

  test("handles absolute Windows paths (user manually specifies full path)", () => {
    const prompt: Prompt = [
      { type: "file", path: "D:\\other\\project\\file.ts", content: "@D:\\other\\project\\file.ts", start: 0, end: 25 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@D:\\other\\project\\file.ts",
      messageID: "msg_abs",
      sessionID: "ses_abs",
      sessionDirectory: "C:\\current\\project",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).toContain("/D:/other/project/file.ts")
  })

  test("handles selection with query parameters on Windows", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "src\\App.tsx",
        content: "@src\\App.tsx",
        start: 0,
        end: 11,
        selection: { startLine: 10, startChar: 0, endLine: 20, endChar: 5 },
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\App.tsx",
      messageID: "msg_sel",
      sessionID: "ses_sel",
      sessionDirectory: "C:\\project",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(file!.url).toContain("?start=10&end=20")
    expect(() => new URL(file!.url)).not.toThrow()
    const url = new URL(file!.url)
    expect(url.searchParams.get("start")).toBe("10")
    expect(url.searchParams.get("end")).toBe("20")
  })

  test("handles file paths with dots and special segments on Windows", () => {
    const prompt: Prompt = [
      { type: "file", path: "..\\..\\shared\\util.ts", content: "@..\\..\\shared\\util.ts", start: 0, end: 21 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@..\\..\\shared\\util.ts",
      messageID: "msg_dots",
      sessionID: "ses_dots",
      sessionDirectory: "C:\\projects\\myapp\\src",
    })

    const file = result.input.files?.[0]
    expect(file).toBeDefined()
    expect(() => new URL(file!.url)).not.toThrow()
    expect(file!.url).toContain("/..")
  })
})
