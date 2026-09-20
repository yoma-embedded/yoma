import { describe, expect, test } from "vitest"
import type { Prompt } from "@/context/prompt"
import { prependRetracted } from "./queue-retract"

const empty: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
const png = { mime: "image/png", url: "data:image/png;base64,AAAA" }

describe("撤回的排队消息拼回输入框", () => {
  test("输入框是空的:就是那段原文,光标在末尾", () => {
    expect(prependRetracted(empty, [{ entryId: "e1", text: "也看一下 map 文件" }])).toEqual({
      prompt: [{ type: "text", content: "也看一下 map 文件", start: 0, end: 11 }],
      cursor: 11,
    })
  })

  test("好几条按排队顺序换行拼起来,图片跟在后面", () => {
    const result = prependRetracted(empty, [
      { entryId: "e1", text: "第一句", files: [png] },
      { entryId: "e2", text: "第二句" },
    ])
    expect(result.prompt).toEqual([
      { type: "text", content: "第一句\n第二句", start: 0, end: 7 },
      { type: "image", id: "retracted:e1:0", filename: "image-1.png", mime: "image/png", dataUrl: png.url },
    ])
    expect(result.cursor).toBe(7)
  })

  test("输入框里已经在打字:排队的在前、正在打的在后,后面的偏移整体后挪,光标停在撤回那段末尾", () => {
    const current: Prompt = [
      { type: "text", content: "再看 ", start: 0, end: 3 },
      { type: "file", content: "@src/main.c", path: "src/main.c", start: 3, end: 14 },
      { type: "text", content: " 的时钟", start: 14, end: 18 },
      { type: "image", id: "mine", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,BBBB" },
    ]
    const result = prependRetracted(current, [{ entryId: "e1", text: "先别烧录", files: [png] }])
    expect(result.prompt).toEqual([
      { type: "text", content: "先别烧录\n再看 ", start: 0, end: 8 },
      { type: "file", content: "@src/main.c", path: "src/main.c", start: 8, end: 19 },
      { type: "text", content: " 的时钟", start: 19, end: 23 },
      { type: "image", id: "retracted:e1:0", filename: "image-1.png", mime: "image/png", dataUrl: png.url },
      { type: "image", id: "mine", filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,BBBB" },
    ])
    expect(result.cursor).toBe(4)
  })

  test("正在打的第一段是提及药丸:前面垫一段文字,不把药丸吞进文字", () => {
    const current: Prompt = [{ type: "file", content: "@a.ts", path: "a.ts", start: 0, end: 5 }]
    expect(prependRetracted(current, [{ entryId: "e1", text: "改成" }]).prompt).toEqual([
      { type: "text", content: "改成\n", start: 0, end: 3 },
      { type: "file", content: "@a.ts", path: "a.ts", start: 3, end: 8 },
    ])
  })

  test("撤回的只有图片:文字原样不动", () => {
    const current: Prompt = [{ type: "text", content: "看图", start: 0, end: 2 }]
    const result = prependRetracted(current, [{ entryId: "e1", text: "", files: [png] }])
    expect(result.prompt).toEqual([
      { type: "text", content: "看图", start: 0, end: 2 },
      { type: "image", id: "retracted:e1:0", filename: "image-1.png", mime: "image/png", dataUrl: png.url },
    ])
  })
})
