import { describe, expect, test } from "vitest"
import { applyUpdate, stringItems } from "./store-batch"

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

describe("applyUpdate", () => {
  test("插入、覆盖、删除一次做完,没提到的键原样留着", () => {
    const data = { keep: "k", replace: "old", drop: "d" }
    expect(applyUpdate(data, { replace: "new", add: "a" }, ["drop", "never-existed"])).toEqual({
      keep: "k",
      replace: "new",
      add: "a",
    })
  })

  test("不改传进来的那份", () => {
    const data = { a: "1" }
    applyUpdate(data, { b: "2" }, ["a"])
    expect(data).toEqual({ a: "1" })
  })

  test("同一批里又插又删同一个键:删赢(渲染器不会发这种批,发了也不留半截)", () => {
    expect(applyUpdate({}, { a: "1" }, ["a"])).toEqual({})
  })
})
