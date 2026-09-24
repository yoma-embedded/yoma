import { describe, expect, test } from "vitest"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertAttachmentBudget,
  createPickedFileAuthorizations,
  inlineAttachment,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
} from "./attachment-picker"

describe("assertAttachmentBudget", () => {
  test("accepts selections within the media ingest limit", () => {
    expect(() =>
      assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES / 2 }, { size: MAX_ATTACHMENT_BYTES / 2 }]),
    ).not.toThrow()
  })

  test("rejects the selection before files are read when its total exceeds the limit", () => {
    expect(() => assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES }, { size: 1 }])).toThrow("20 MB limit")
  })

  test("reads an approved file through a bounded buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yoma-attachment-"))
    const file = join(directory, "example.txt")
    try {
      await writeFile(file, "lorem ipsum")
      expect(new TextDecoder().decode(await readAttachment(file))).toBe("lorem ipsum")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects an oversized file before allocating its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yoma-attachment-"))
    const file = join(directory, "oversized.txt")
    try {
      await writeFile(file, "")
      await truncate(file, MAX_ATTACHMENT_BYTES + 1)
      await expect(readAttachment(file)).rejects.toThrow("20 MB limit")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("inlineAttachment", () => {
  const images = ["gif", "jpeg", "jpg", "png", "webp"]

  test("只有清单里的扩展名要读内容,大小写不敏感", () => {
    expect(inlineAttachment("board.png", images)).toBe(true)
    expect(inlineAttachment("BOARD.JPG", images)).toBe(true)
  })

  test("固件产物、PDF、没有扩展名的文件只交路径", () => {
    expect(inlineAttachment("firmware.elf", images)).toBe(false)
    expect(inlineAttachment("app.bin", images)).toBe(false)
    expect(inlineAttachment("schematic.pdf", images)).toBe(false)
    expect(inlineAttachment("Makefile", images)).toBe(false)
    // 扩展名只看最后一段:名字里带 png 不算
    expect(inlineAttachment("png.elf", images)).toBe(false)
  })

  test("渲染器没报清单时全都要读(保守缺省,预算照旧管所有文件)", () => {
    expect(inlineAttachment("firmware.elf", undefined)).toBe(true)
  })
})

describe("picked file authorizations", () => {
  const read = async (path: string) => new TextEncoder().encode(path).buffer

  test("keeps concurrent picker selections isolated", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, ["a.txt", "b.txt"])
    const second = authorizations.add(1, ["c.txt"])

    expect(new TextDecoder().decode(await authorizations.read(1, first, "a.txt"))).toBe("a.txt")
    expect(new TextDecoder().decode(await authorizations.read(1, second, "c.txt"))).toBe("c.txt")
    expect(new TextDecoder().decode(await authorizations.read(1, first, "b.txt"))).toBe("b.txt")
  })

  test("releases unread files for one picker without affecting another", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, ["a.txt"])
    const second = authorizations.add(1, ["b.txt"])
    authorizations.release(1, first)

    await expect(authorizations.read(1, first, "a.txt")).rejects.toThrow("not selected")
    expect(new TextDecoder().decode(await authorizations.read(1, second, "b.txt"))).toBe("b.txt")
  })

  test("keeps picker tokens scoped to their renderer", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, ["a.txt"])

    await expect(authorizations.read(2, token, "a.txt")).rejects.toThrow("not selected")
  })

  test("charges actual reads against the selection budget", async () => {
    const authorizations = createPickedFileAuthorizations(async (_path, maxBytes) => {
      if (6 > maxBytes) throw new Error("budget exceeded")
      return new ArrayBuffer(6)
    }, 10)
    const token = authorizations.add(1, ["a.txt", "b.txt"])

    await authorizations.read(1, token, "a.txt")
    await expect(authorizations.read(1, token, "b.txt")).rejects.toThrow("budget exceeded")
  })
})
