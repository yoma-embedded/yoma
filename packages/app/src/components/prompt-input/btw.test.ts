import { describe, expect, test } from "vitest"
import { parseBtw } from "./btw"

describe("parseBtw:输入框里的 /btw", () => {
  test.each([
    ["/btw 这个寄存器是干嘛的", "这个寄存器是干嘛的"],
    ["/BTW why 0x40021000", "why 0x40021000"],
    ["/btw   前后的空白去掉   ", "前后的空白去掉"],
    ["/btw\n第二行也算", "第二行也算"],
    ["/btw @src/main.c 这个函数干嘛的", "@src/main.c 这个函数干嘛的"],
  ])("%j → %j", (text, question) => {
    expect(parseBtw(text)).toBe(question)
  })

  test("只打了 /btw:是 /btw,但问题是空的(界面提示用法)", () => {
    expect(parseBtw("/btw")).toBe("")
    expect(parseBtw("/btw   ")).toBe("")
  })

  test("/btw 后面必须是空白或结尾;不在开头也不算", () => {
    expect(parseBtw("/btwx")).toBeUndefined()
    expect(parseBtw("/btw?")).toBeUndefined()
    expect(parseBtw("/btw-x 问题")).toBeUndefined()
    expect(parseBtw(" /btw 问题")).toBeUndefined()
    expect(parseBtw("顺便 /btw 问题")).toBeUndefined()
    expect(parseBtw("/compact")).toBeUndefined()
  })
})
