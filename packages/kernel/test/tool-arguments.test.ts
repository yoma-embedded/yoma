/**
 * 模型把参数写错时看到的话(host/tools/arguments.ts)。
 * 2026-09-17 真机验证:agent 两次调用不存在的 `scope timing`,因为发动机的原话不列合法动作;写 channels:[2] 被拒。
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { friendlyArguments } from "../src/host/tools/arguments.ts"
import { createRegisteredTools } from "../src/host/tools/index.ts"

const scope = createRegisteredTools().find((t) => t.name === "scope")!

describe("工具参数:发动机校验之前的那一层", () => {
  it("装配面上的每个工具都挂了 prepareArguments", () => {
    for (const tool of createRegisteredTools()) expect(typeof tool.prepareArguments, tool.name).toBe("function")
  })

  it("不存在的动作:列出全部合法动作和实收值,而不是 N 行 must be equal to constant", () => {
    expect(() => scope.prepareArguments!({ action: "timing", capture: "x" })).toThrow(
      /^scope: invalid arguments\n {2}- action: must be one of "devices", "connect", "status", "setup", "capture", "arm", "collect", "measure", "samples", "list", "screenshot", "stop", "disconnect" \(got "timing"\)$/,
    )
  })

  it('scope 通道写法归一:数字、"2"、"C3"、对象都收,归一后过发动机同款的校验', () => {
    expect(scope.prepareArguments!({ action: "capture", channels: [2, "C3", { ch: 4, vdiv: 1 }] })).toEqual({
      action: "capture",
      channels: [{ ch: 2 }, { ch: 3 }, { ch: 4, vdiv: 1 }],
    })
    expect(scope.prepareArguments!({ action: "samples", channel: "ch2", limit: 8 })).toEqual({
      action: "samples",
      channel: 2,
      limit: 8,
    })
  })

  it("越界通道:归一后指到最具体的那一层;归一不了的元素才列两种合法写法", () => {
    expect(() => scope.prepareArguments!({ action: "capture", channels: [9] })).toThrow(
      /^scope: invalid arguments\n {2}- channels\.0\.ch: must be integer 1\.\.4 \(got 9\)$/,
    )
    // true 会被 Value.Convert 转成 1(发动机也这么转),所以拿一个转不了的字符串
    expect(() => scope.prepareArguments!({ action: "capture", channels: ["foo"] })).toThrow(
      /channels\.0: must be one of: integer 1\.\.4 \| object \{ch, on\?, vdiv\?, .*label\?\} \(got "foo"\)/,
    )
  })

  it("与发动机同款的宽容:可选字段的 null 当没给,数字字符串转成数字", () => {
    expect(scope.prepareArguments!({ action: "setup", timebase: { scale: "0.001" }, mdepth: null })).toEqual({
      action: "setup",
      timebase: { scale: 0.001 },
    })
  })

  it("通用规则:字面量联合、范围、必填字段各有各的话", () => {
    const prepare = friendlyArguments(
      "t",
      Type.Object({
        mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
        n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
        rate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      }),
    )
    expect(() => prepare({ mode: "c" })).toThrow(/mode: must be one of "a", "b" \(got "c"\)/)
    expect(() => prepare({ mode: "a", n: 9 })).toThrow(/n: must be integer 1\.\.4 \(got 9\)/)
    expect(() => prepare({ mode: "a", rate: -1 })).toThrow(/rate: must be number > 0 \(got -1\)/)
    expect(() => prepare({})).toThrow(/mode: is required/)
    expect(prepare({ mode: "b", n: "3" })).toEqual({ mode: "b", n: 3 })
  })

  it("工具自己的归一先跑,再预校验;归一抛出的错原样透出", () => {
    const prepare = friendlyArguments("t", Type.Object({ list: Type.Array(Type.Integer()) }), (args) => {
      const a = args as { list: unknown }
      return { ...a, list: typeof a.list === "string" ? a.list.split(",").map(Number) : a.list }
    })
    expect(prepare({ list: "1,2" })).toEqual({ list: [1, 2] })
    expect(() => prepare({ list: "x" })).toThrow(/list\.0: must be integer \(got null\)/)
  })
})
