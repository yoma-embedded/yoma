import { describe, expect, test } from "vitest"
import { readoutIsWide, READOUT_WIDE_CHARS } from "./hw-format"

/**
 * 读数行的整行判定。钉住的是"长值不许在两列里折行"这一条 —— 折了的表现不是报错,
 * 是一条绝对路径在半格里折五行、旁边那条短读数的点线孤零零吊在中间。
 */
describe("readoutIsWide", () => {
  test("显式的 wide 永远赢", () => {
    expect(readoutIsWide("ok", true)).toBe(true)
    expect(readoutIsWide(undefined, true)).toBe(true)
  })

  test("格式化过的短读数摆两列", () => {
    for (const short of ["halted", "1,024 B", "20 ns/点", "0x00008200", "Core/Src/foc.c:45"]) {
      expect(readoutIsWide(short), short).toBe(false)
    }
  })

  test("长度不受我们控制的那几种值占满整行", () => {
    // gdb 报告里 `session log:` 后面那条绝对路径(35-light-card-gdb-hover 实拍的那一条)。
    expect(readoutIsWide("/Users/ben/ws/f405-motor-ctrl/.yoma/gdb/session-20260918-011557687.log")).toBe(true)
    // `p` 出来的结构体。
    expect(readoutIsWide("$1 = {iq = 1500, id = 0, theta = 0.7853982, flags = 0x3}")).toBe(true)
  })

  test("阈值上下各一个字符", () => {
    expect(readoutIsWide("x".repeat(READOUT_WIDE_CHARS))).toBe(false)
    expect(readoutIsWide("x".repeat(READOUT_WIDE_CHARS + 1))).toBe(true)
  })

  test("不是字符串的值(JSX、数字、空)一律不自动整行 —— 量不出长度就别猜", () => {
    expect(readoutIsWide(undefined)).toBe(false)
    expect(readoutIsWide(null)).toBe(false)
    expect(readoutIsWide(1234567890123456)).toBe(false)
    expect(readoutIsWide({ tagName: "span" })).toBe(false)
  })
})
