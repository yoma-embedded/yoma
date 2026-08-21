/**
 * task spec 的校验。
 *
 * 每一条断言都对应一种"跑完 k 遍才发现题配错了"的贵错误。所以这里不只看它报不报错,
 * 还看**错误消息里有没有字段名** —— 一条"task 有 3 处问题"而不说是哪三处的报错,
 * 与不报错的区别只是让人更烦。
 */

import { describe, expect, test } from "bun:test"
import path from "node:path"

import { matchesFilter, parseTask, TaskSpecError } from "./task.ts"

/** 题目目录名必须等于 id,所以路径按 id 拼。 */
function fileFor(id: string): string {
  return path.join(path.sep === "\\" ? "C:\\evals" : "/evals", "tasks", "netlist", id, "task.json")
}

function goodRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "netlist-main-controller",
    title: "识别主控",
    tags: ["netlist", "L1"],
    env: { kind: "none" },
    setup: { files: [{ from: "engines/x/fixtures/board.xml", to: "board.xml" }] },
    prompt: '读网表,最后一条消息用 ```json 围栏给出 {"answer": "<位号>"}',
    reference: { answer: "U3", note: "controller_map.exe 直跑核实" },
    graders: [{ type: "answer", equals: "U3" }, { type: "grounded" }],
    ...overrides,
  }
}

function issuesOf(raw: Record<string, unknown>, id = "netlist-main-controller"): string[] {
  try {
    parseTask(raw, fileFor(id))
    return []
  } catch (error) {
    if (error instanceof TaskSpecError) return error.issues
    throw error
  }
}

describe("parseTask · 合法", () => {
  const task = parseTask(goodRaw(), fileFor("netlist-main-controller"))

  test("字段照单落定,dir/file 是绝对路径", () => {
    expect(task.id).toBe("netlist-main-controller")
    expect(task.tags).toEqual(["netlist", "L1"])
    expect(task.requires).toEqual([])
    expect(task.env.kind).toBe("none")
    expect(task.setup.files).toEqual([{ from: "engines/x/fixtures/board.xml", to: "board.xml" }])
    expect(task.graders).toHaveLength(2)
    expect(path.isAbsolute(task.dir)).toBe(true)
    expect(path.basename(task.dir)).toBe(task.id)
  })

  test("timeoutMs 不写就是 undefined,由 trial 落到默认 10 分钟", () => {
    expect(task.timeoutMs).toBeUndefined()
    expect(parseTask(goodRaw({ timeoutMs: 1000 }), fileFor("netlist-main-controller")).timeoutMs).toBe(1000)
  })

  test("faux 自带剧本时原样收下", () => {
    const withFaux = parseTask(
      goodRaw({ faux: { good: [[{ tool: "netlist", input: { netlistPath: "board.xml" } }], [{ text: "好" }]] } }),
      fileFor("netlist-main-controller"),
    )
    expect(withFaux.faux?.good?.[0]).toEqual([{ tool: "netlist", input: { netlistPath: "board.xml" } }])
  })
})

describe("parseTask · 非法", () => {
  test("id 与目录名不一致 —— 报告与产物按 id 索引,不一致会让人以为题没跑", () => {
    const issues = issuesOf(goodRaw({ id: "别的名字" }), "netlist-main-controller")
    expect(issues.join()).toContain("id")
  })

  test("id 格式", () => {
    expect(issuesOf(goodRaw({ id: "Netlist_Main" }), "Netlist_Main").join()).toContain("id")
  })

  test("必填字段各报各的,一次说完", () => {
    const issues = issuesOf({ id: "netlist-main-controller" })
    const joined = issues.join("\n")
    expect(joined).toContain("title")
    expect(joined).toContain("tags")
    expect(joined).toContain("env")
    expect(joined).toContain("prompt")
    expect(joined).toContain("reference")
    expect(joined).toContain("graders")
  })

  test("env.kind 非 none 直接报'v1 未实现',不静默降级", () => {
    const issues = issuesOf(goodRaw({ env: { kind: "board" } }))
    expect(issues.join()).toContain("v1 未实现")
  })

  test("requires 打错字要当场看见 —— 否则它是一道永远跳过的题", () => {
    expect(issuesOf(goodRaw({ requires: ["engine"] })).join()).toContain("requires[0]")
    expect(issuesOf(goodRaw({ requires: ["engines", "board"] }))).toEqual([])
  })

  test("prompt 里没写 json 围栏 —— answer grader 一定判 fail,而看起来像模型不听话", () => {
    expect(issuesOf(goodRaw({ prompt: "请找出主控芯片的位号。" })).join()).toContain("json 围栏")
  })

  test("reference.answer 必填", () => {
    expect(issuesOf(goodRaw({ reference: { note: "有出处但没答案" } })).join()).toContain("reference.answer")
  })

  test("夹具路径不能是绝对路径,也不能逃出基准目录", () => {
    const absolute = path.sep === "\\" ? "D:\\a\\b.xml" : "/a/b.xml"
    expect(issuesOf(goodRaw({ setup: { files: [{ from: absolute, to: "b.xml" }] } })).join()).toContain("绝对路径")
    expect(issuesOf(goodRaw({ setup: { files: [{ from: "a.xml", to: "../b.xml" }] } })).join()).toContain("逃出")
  })

  test("未知 grader 类型 —— 写错 tool-forbiden 的后果否则是一条静默消失的红线", () => {
    const issues = issuesOf(goodRaw({ graders: [{ type: "tool-forbiden", tools: ["flash"] }] }))
    expect(issues.join()).toContain("graders[0].type")
  })

  test("什么都不填的 answer grader 会永远亮绿 —— 在这里挡住", () => {
    expect(issuesOf(goodRaw({ graders: [{ type: "answer" }] })).join()).toContain("equals / oneOf / matches")
  })

  test("grader 的字段名进错误消息", () => {
    const issues = issuesOf(
      goodRaw({
        graders: [
          { type: "answer", equals: "U3", matches: "([" },
          { type: "tool-called" },
          { type: "tool-forbidden", tools: [] },
          { type: "grounded", mode: "most" },
        ],
      }),
    )
    const joined = issues.join("\n")
    expect(joined).toContain("graders[0].matches")
    expect(joined).toContain("graders[1].tool")
    expect(joined).toContain("graders[2].tools")
    expect(joined).toContain("graders[3].mode")
  })
})

describe("matchesFilter", () => {
  const task = parseTask(goodRaw(), fileFor("netlist-main-controller"))

  test("id 子串", () => {
    expect(matchesFilter(task, "main")).toBe(true)
    expect(matchesFilter(task, "gdb")).toBe(false)
  })

  test("tag 是整词 —— L1 不该被 L10 的 filter 捞到,反之亦然", () => {
    expect(matchesFilter(task, "L1")).toBe(true)
    expect(matchesFilter(task, "l1")).toBe(true)
    expect(matchesFilter(task, "L10")).toBe(false)
  })
})
