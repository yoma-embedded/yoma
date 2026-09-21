import { describe, expect, test } from "vitest"
import { stringItems } from "./store-batch"

describe("stringItems", () => {
  test("字符串原样,别的序列化,null / undefined 当作没有 —— 和 store-get 同一个口径", () => {
    expect(stringItems({ a: '{"x":1}', b: { y: 2 }, c: 3, d: null, e: undefined, f: "" })).toEqual({
      a: '{"x":1}',
      b: '{"y":2}',
      c: "3",
      f: "",
    })
  })
})
