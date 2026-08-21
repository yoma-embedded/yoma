/**
 * 答案提取与归一化。
 *
 * 这一组守的是判分的**入口**:抽错了围栏、归一化多放宽了一步,后面四个 grader 全都
 * 在错的证据上工作,而报告看起来完全正常。
 */

import { describe, expect, test } from "bun:test"

import {
  answerEquals,
  answerMatches,
  answerOneOf,
  describeAnswer,
  extractLastJsonFence,
  normalizeList,
  normalizeScalar,
  normalizeText,
  readAnswerField,
} from "./answer.ts"

describe("extractLastJsonFence", () => {
  test("取最后一个围栏 —— 模型会先举例再作答", () => {
    const text = [
      "格式像这样:",
      "```json",
      '{"answer": "示例"}',
      "```",
      "我查完了,结论如下。",
      "```json",
      '{"answer": "U3"}',
      "```",
    ].join("\n")
    expect(extractLastJsonFence(text).parsed).toEqual({ answer: "U3" })
  })

  test("没有围栏时给出人话,而不是空对象", () => {
    const extraction = extractLastJsonFence("主控是 U3。")
    expect(extraction.parsed).toBeUndefined()
    expect(extraction.error).toContain("没有 ```json 围栏")
  })

  test("围栏里不是合法 JSON:raw 留着,error 说清楚", () => {
    const extraction = extractLastJsonFence("```json\n{answer: U3}\n```")
    expect(extraction.parsed).toBeUndefined()
    expect(extraction.raw).toContain("answer")
    expect(extraction.error).toContain("不是合法 JSON")
  })

  test("不带语言标记的围栏也认", () => {
    expect(extractLastJsonFence('```\n{"answer": 42}\n```').parsed).toEqual({ answer: 42 })
  })
})

describe("readAnswerField", () => {
  test("缺字段时报出实得字段,便于出题人对号", () => {
    const read = readAnswerField({ result: "U3" }, "answer")
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error).toContain("result")
  })

  test("模型少包一层(直接给标量/数组)也认 —— 不拿格式惩罚内容", () => {
    expect(readAnswerField("U3", "answer")).toEqual({ ok: true, value: "U3" })
    expect(readAnswerField(["U3", "U4"], "answer")).toEqual({ ok: true, value: ["U3", "U4"] })
  })

  test("自定义字段名", () => {
    expect(readAnswerField({ controller: "U3" }, "controller")).toEqual({ ok: true, value: "U3" })
  })
})

describe("归一化", () => {
  test("trim、折叠空白、小写、剥掉包裹的引号/反引号", () => {
    expect(normalizeScalar('  "  U3  "  ')).toBe("u3")
    expect(normalizeScalar("`U3`")).toBe("u3")
    expect(normalizeScalar("U3\n\t  net")).toBe("u3 net")
  })

  test("normalizeText 保留大小写 —— 正则要靠它", () => {
    expect(normalizeText(" `U3` ")).toBe("U3")
  })

  test("数组逐元素归一化;标量当单元素", () => {
    expect(normalizeList([" U3 ", '"U4"'])).toEqual(["u3", "u4"])
    expect(normalizeList("U3")).toEqual(["u3"])
  })
})

describe("比较", () => {
  test("标量大小写不敏感", () => {
    expect(answerEquals("u3", "U3")).toBe(true)
    expect(answerEquals("u4", "U3")).toBe(false)
  })

  test("数组默认按集合比,顺序无关", () => {
    expect(answerEquals(["U4", "U3"], ["U3", "U4"])).toBe(true)
  })

  test("unordered 关掉时顺序要对", () => {
    expect(answerEquals(["U4", "U3"], ["U3", "U4"], false)).toBe(false)
    expect(answerEquals(["U3", "U4"], ["U3", "U4"], false)).toBe(true)
  })

  test("一侧是数组另一侧是标量:按单元素列表比", () => {
    expect(answerEquals("U3", ["U3"])).toBe(true)
    expect(answerEquals("U3", ["U3", "U4"])).toBe(false)
  })

  test("集合比会去重 —— 重复的位号不携带信息", () => {
    expect(answerEquals(["U3", "U3"], ["U3"])).toBe(true)
    expect(answerEquals(["U3", "U3"], ["U3"], false)).toBe(false)
  })

  test("oneOf", () => {
    expect(answerOneOf("U3", ["U1", "U3"])).toBe(true)
    expect(answerOneOf("U9", ["U1", "U3"])).toBe(false)
  })

  test("matches 是整串匹配 + 大小写不敏感", () => {
    expect(answerMatches("U3", "U\\d+")).toBe(true)
    expect(answerMatches("u3", "U\\d+")).toBe(true)
    // 整串:半截匹配不算。没有锚点的话 "U3 和一堆废话" 会通过。
    expect(answerMatches("U3 和一堆废话", "U\\d+")).toBe(false)
  })

  test("describeAnswer 给人看的一行", () => {
    expect(describeAnswer(["U3", "U4"])).toBe("[U3, U4]")
    expect(describeAnswer(undefined)).toBe("(无)")
  })
})
