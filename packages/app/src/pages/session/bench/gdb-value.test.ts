import { describe, expect, test } from "vitest"
import { parseGdbValue } from "./gdb-value"

describe("gdb 值 → 树", () => {
  test("print pretty 的结构体(QEMU 上 `*f` 的原文)", () => {
    const tree = parseGdbValue("{\n  r0 = 3735928559,\n  r1 = 1640,\n  pc = 966,\n  psr = 553648128\n}", "*f")
    expect(tree.children?.map((child) => [child.name, child.value])).toEqual([
      ["r0", "3735928559"],
      ["r1", "1640"],
      ["pc", "966"],
      ["psr", "553648128"],
    ])
  })

  test("嵌套、数组、字符串里的逗号和花括号不切", () => {
    const tree = parseGdbValue('{name = "a, {b}", pos = {x = 1, y = -2}, v = {3, 4}, c = 44 \',\'}')
    expect(tree.children?.map((child) => child.name)).toEqual(["name", "pos", "v", "c"])
    expect(tree.children?.[0]?.value).toBe('"a, {b}"')
    expect(tree.children?.[1]?.children?.map((child) => `${child.name}=${child.value}`)).toEqual(["x=1", "y=-2"])
    expect(tree.children?.[2]?.children?.map((child) => `${child.name}=${child.value}`)).toEqual(["[0]=3", "[1]=4"])
    expect(tree.children?.[3]?.value).toBe("44 ','")
  })

  test("<repeats N times> 占 N 个位置,后面的下标接着数", () => {
    const tree = parseGdbValue("{0 <repeats 16 times>, 7, 8}")
    expect(tree.children?.map((child) => child.name)).toEqual(["[0..15]", "[16]", "[17]"])
  })

  test("char 数组是字符串,不是结构体;截断的文本当叶子,不丢字", () => {
    expect(parseGdbValue('"0x0000\\000\\000"').children).toBeUndefined()
    const cut = parseGdbValue("{a = 1, b = {c = 2…")
    expect(cut.children).toBeUndefined()
    expect(cut.value).toBe("{a = 1, b = {c = 2…")
  })

  test("带比较运算符的值不会被当成成员名", () => {
    const tree = parseGdbValue("{ok = true, fn = 0x80001a1 <foo>}")
    expect(tree.children?.[1]).toEqual({ name: "fn", value: "0x80001a1 <foo>" })
  })
})
