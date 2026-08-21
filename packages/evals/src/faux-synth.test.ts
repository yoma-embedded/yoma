/**
 * 合成剧本。
 *
 * 一条不变式撑着整个 selftest:**坏解的答案必须真的 ≠ 参考答案**。它要是撞上了,
 * 反向那一刀就变成一条永远绿的断言(期望 fail 实得 fail,理由却是错的),
 * 而这正是 selftest 存在的目的所要防的那类错误。
 */

import { describe, expect, test } from "bun:test"
import path from "node:path"

import { answerEquals, extractLastJsonFence } from "./answer.ts"
import { synthesizeFaux, wrongAnswer } from "./faux-synth.ts"
import { parseTask, type Task } from "./task.ts"

function task(overrides: Record<string, unknown> = {}): Task {
  const file = path.join(path.sep === "\\" ? "C:\\t" : "/t", "netlist-x", "task.json")
  return parseTask(
    {
      id: "netlist-x",
      title: "题",
      tags: ["netlist"],
      env: { kind: "none" },
      setup: { files: [{ from: "engines/f/board.xml", to: "board.xml" }] },
      prompt: '…用 ```json 围栏给出 {"answer": …}',
      reference: { answer: "U3" },
      graders: [{ type: "answer", equals: "U3" }],
      ...overrides,
    },
    file,
  )
}

describe("wrongAnswer", () => {
  test("各种类型都给出一个一定判错的答案", () => {
    for (const reference of ["U3", 42, true, ["U3", "U4"], [], { a: 1 }, null]) {
      expect(answerEquals(wrongAnswer(reference), reference)).toBe(false)
    }
  })
})

describe("synthesizeFaux", () => {
  test("good 先调一次 netlist(夹具的 to),再用参考答案作答", () => {
    const { good } = synthesizeFaux(task())
    expect(good[0]).toEqual([{ tool: "netlist", input: { netlistPath: "board.xml" } }])
    const text = (good[1]![0] as { text: string }).text
    expect(extractLastJsonFence(text).parsed).toEqual({ answer: "U3" })
  })

  test("bad 一个工具都不调,而且答案是错的 —— 两个方向同时打", () => {
    const { bad } = synthesizeFaux(task())
    expect(bad).toHaveLength(1)
    expect(bad[0]!.every((part) => "text" in part)).toBe(true)
    expect(extractLastJsonFence((bad[0]![0] as { text: string }).text).parsed).toEqual({ answer: "U3-wrong" })
  })

  test("围栏里的 key 跟着 answer grader 的 field 走", () => {
    const { good } = synthesizeFaux(task({ graders: [{ type: "answer", field: "controller", equals: "U3" }] }))
    expect(extractLastJsonFence((good[1]![0] as { text: string }).text).parsed).toEqual({ controller: "U3" })
  })

  test("没有夹具就不硬塞工具调用 —— 那会拿到一次工具报错,把好题误判成坏题", () => {
    const { good } = synthesizeFaux(task({ setup: { files: [] } }))
    expect(good).toHaveLength(1)
    expect(good[0]!.every((part) => "text" in part)).toBe(true)
  })

  test("题目自带剧本时优先用它", () => {
    const custom = { good: [[{ text: "自带的" }]], bad: [[{ text: "也是自带的" }]] }
    const synthesized = synthesizeFaux(task({ faux: custom }))
    expect(synthesized.good).toEqual([[{ text: "自带的" }]])
    expect(synthesized.bad).toEqual([[{ text: "也是自带的" }]])
  })
})
