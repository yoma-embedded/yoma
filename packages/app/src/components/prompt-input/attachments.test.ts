import { describe, expect, test } from "bun:test"
import type { ContentPart } from "@/context/prompt"
import { createPromptAttachmentsCore } from "./attachments"
import { attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

// 内核只把 image/* 附件送进模型(session-manager 的 prompt 过滤)。add 的分流保证
// composer 里不出现"UI 显示成功、模型什么都收不到"的谎话:PDF 拒收并给专门提示,
// 文本文件有真实路径时转成 @path 提及(那才是真能到 agent 眼前的通道),没有路径
// 只能明说。曾经的事故形态:PDF 原理图拖进去,agent 一无所知,两边都不吭声。
describe("createPromptAttachmentsCore.add 的能力分流", () => {
  function makeHarness(options: { getPathForFile?: (file: File) => string } = {}) {
    let parts: ContentPart[] = []
    const insertedParts: ContentPart[] = []
    let warned = 0
    let warnedPdf = 0
    const core = createPromptAttachmentsCore({
      capture: () => ({
        current: () => parts,
        cursor: () => 0,
        set: (next: ContentPart[]) => {
          parts = next
        },
      }),
      editor: () => document.createElement("div"),
      addPart: (part) => {
        insertedParts.push(part)
        return true
      },
      warn: () => {
        warned += 1
      },
      warnPdf: () => {
        warnedPdf += 1
      },
      getPathForFile: options.getPathForFile,
    })
    return {
      core,
      parts: () => parts,
      insertedParts,
      warned: () => warned,
      warnedPdf: () => warnedPdf,
    }
  }

  test("图片照旧编成 data-URL 附件件", async () => {
    const h = makeHarness()
    const file = new File([Uint8Array.of(1, 2, 3)], "board.png", { type: "image/png" })
    await h.core.addAttachment(file)
    expect(h.parts()).toHaveLength(1)
    expect(h.parts()[0]).toMatchObject({ type: "image", filename: "board.png", mime: "image/png" })
    expect(h.warned()).toBe(0)
  })

  test("PDF 拒收并给专门提示,不产生附件件", async () => {
    const h = makeHarness()
    const file = new File(["%PDF-1.7"], "schematic.pdf", { type: "application/pdf" })
    await h.core.addAttachment(file)
    expect(h.parts()).toHaveLength(0)
    expect(h.insertedParts).toHaveLength(0)
    expect(h.warnedPdf()).toBe(1)
    expect(h.warned()).toBe(0)
  })

  test("文本文件有真实路径(desktop)时转成 @path 提及,不编 data-URL", async () => {
    const h = makeHarness({ getPathForFile: () => "C:\\proj\\main.c" })
    const file = new File(["int main() {}\n"], "main.c", { type: "text/plain" })
    await h.core.addAttachment(file)
    expect(h.parts()).toHaveLength(0)
    expect(h.insertedParts).toEqual([{ type: "file", path: "C:\\proj\\main.c", content: "@C:\\proj\\main.c", start: 0, end: 0 }])
    expect(h.warned()).toBe(0)
  })

  test("文本文件没有真实路径(web 宿主的内存 File)时明说做不了", async () => {
    const h = makeHarness()
    const file = new File(["hello\n"], "notes.txt", { type: "text/plain" })
    await h.core.addAttachment(file)
    expect(h.parts()).toHaveLength(0)
    expect(h.insertedParts).toHaveLength(0)
    expect(h.warned()).toBe(1)
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
