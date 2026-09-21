import { describe, expect, test } from "vitest"
import type { Part } from "@yoma-desktop/kernel"
import { collectRanges, countOccurrences, locateMatch, rangesIn, searchableText, startIndex } from "./search"

const base = { sessionID: "s", messageID: "m" }
const toolPart = (id: string, state: Record<string, unknown>): Part =>
  ({ ...base, id, type: "tool", callID: `c_${id}`, tool: "bash", state }) as unknown as Part

describe("searchableText", () => {
  test("工具:调用参数在前、输出在后;失败的搜得到报错", () => {
    const done = toolPart("t1", {
      status: "completed",
      input: { command: "st-flash write fw.bin 0x08000000", timeout: 30 },
      output: "Flash written and verified",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    })
    expect(searchableText(done, true)).toBe("st-flash write fw.bin 0x08000000\n30\nFlash written and verified\n")
    const failed = toolPart("t2", {
      status: "error",
      input: { path: "missing.ld" },
      error: "ENOENT: no such file",
      time: { start: 1, end: 2 },
    })
    expect(searchableText(failed, true)).toContain("ENOENT")
  })

  test("正在跑的工具搜得到已经吐出来的输出;嵌套的参数不算 —— 卡片上不画它们", () => {
    const running = toolPart("t1", {
      status: "running",
      input: { path: "config.h", edits: [{ oldText: "BAUD 9600", newText: "BAUD 115200" }] },
      output: "erasing sector 3",
      time: { start: 1 },
    })
    expect(searchableText(running, true)).toBe("config.h\nerasing sector 3\n")
  })

  test("思考段只在设置里打开显示时才搜得到 —— 画不出来的东西不该算进计数", () => {
    const part = { ...base, id: "r1", type: "reasoning", text: "检查 HardFault", time: { start: 1 } } as Part
    expect(searchableText(part, true)).toBe("检查 HardFault")
    expect(searchableText(part, false)).toBe("")
  })

  test("附件搜文件名,不搜 data-URL", () => {
    const part = {
      ...base,
      id: "f1",
      type: "file",
      mime: "image/png",
      filename: "scope.png",
      url: "data:image/png;base64,AAAA",
    } as Part
    expect(searchableText(part, true)).toBe("scope.png")
  })
})

describe("countOccurrences", () => {
  test("不重叠地数;空词是 0", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2)
    expect(countOccurrences("hardfault at 0x0800, hardfault again", "hardfault")).toBe(2)
    expect(countOccurrences("anything", "")).toBe(0)
  })
})

describe("全局第几处 ↔ 哪个 part 的第几处", () => {
  const entries = [
    { partID: "a", count: 2 },
    { partID: "b", count: 0 },
    { partID: "c", count: 3 },
  ]

  test("locateMatch 跨过没有命中的 part", () => {
    expect(locateMatch(entries, 0)).toEqual({ partID: "a", occurrence: 0 })
    expect(locateMatch(entries, 1)).toEqual({ partID: "a", occurrence: 1 })
    expect(locateMatch(entries, 2)).toEqual({ partID: "c", occurrence: 0 })
    expect(locateMatch(entries, 4)).toEqual({ partID: "c", occurrence: 2 })
    expect(locateMatch(entries, 5)).toBeUndefined()
  })

  test("startIndex 从视口里第一行起找;视口以下没有就落在最后一处", () => {
    const rows = new Map([
      ["a", 1],
      ["b", 4],
      ["c", 9],
    ])
    const rowOf = (id: string) => rows.get(id)
    expect(startIndex(entries, rowOf, 0)).toBe(0)
    expect(startIndex(entries, rowOf, 2)).toBe(2)
    expect(startIndex(entries, rowOf, 10)).toBe(4)
    expect(startIndex([], rowOf, 0)).toBe(0)
  })
})

describe("DOM 里的高亮范围", () => {
  const mount = (html: string) => {
    const root = document.createElement("div")
    root.innerHTML = html
    document.body.append(root)
    return root
  }
  const texts = (ranges: Range[]) => ranges.map((range) => range.toString())

  test("跨节点的词也圈得到(markdown 的加粗、代码高亮的 span)", () => {
    const root = mount(
      `<div data-timeline-part-id="p1">Hard<strong>Fault</strong> at <code><span>0x0800</span><span>1234</span></code>, hardfault again</div>`,
    )
    const part = root.firstElementChild!
    expect(texts(rangesIn(part, "hardfault"))).toEqual(["HardFault", "hardfault"])
    expect(texts(rangesIn(part, "0x08001234"))).toEqual(["0x08001234"])
    const [first] = rangesIn(part, "hardfault")
    expect(first!.startContainer.nodeValue).toBe("Hard")
    expect(first!.endContainer.nodeValue).toBe("Fault")
    root.remove()
  })

  test("结束点落在节点交界时不伸进下一个节点", () => {
    const root = mount(`<div data-timeline-part-id="p1"><span>abc</span><span>def</span></div>`)
    const [range] = rangesIn(root.firstElementChild!, "abc")
    expect(range!.endContainer.nodeValue).toBe("abc")
    expect(range!.endOffset).toBe(3)
    root.remove()
  })

  test("嵌在里面的别的 part 不算在外层头上", () => {
    const root = mount(
      `<div data-timeline-part-id="outer">uart <div data-timeline-part-id="inner">uart uart</div></div>`,
    )
    expect(rangesIn(root.firstElementChild!, "uart")).toHaveLength(1)
    expect(rangesIn(root.querySelector('[data-timeline-part-id="inner"]')!, "uart")).toHaveLength(2)
    root.remove()
  })

  test("collectRanges:当前那一处单拎出来,其余都是普通命中", () => {
    const root = mount(
      `<div data-timeline-part-id="p1">spi spi</div><div data-timeline-part-id="p2">spi one, spi two, spi three</div>`,
    )
    const found = collectRanges(root, "spi", { partID: "p2", occurrence: 1 })
    expect(found.hits).toHaveLength(4)
    expect(found.active?.startOffset).toBe("spi one, ".length)
    expect(found.exact).toBe(true)
    expect(found.activeElement?.getAttribute("data-timeline-part-id")).toBe("p2")
    root.remove()
  })

  test("数据层说第 5 处、DOM 里只有 2 处:落在最后一处上,不是找不到", () => {
    const root = mount(`<div data-timeline-part-id="p1">i2c and i2c</div>`)
    const found = collectRanges(root, "i2c", { partID: "p1", occurrence: 4 })
    expect(found.active?.startOffset).toBe("i2c and ".length)
    expect(found.exact).toBe(false)
    expect(found.hits).toHaveLength(1)
    root.remove()
  })

  test("当前 part 画出来了但一处都圈不到(命中在链接的 URL 里):给出那张卡,让调用方滚过去", () => {
    const root = mount(`<div data-timeline-part-id="p1"><a href="https://st.com/rm0090">手册</a></div>`)
    const found = collectRanges(root, "rm0090", { partID: "p1", occurrence: 0 })
    expect(found.active).toBeUndefined()
    expect(found.activeElement).toBe(root.firstElementChild)
    root.remove()
  })

  test("当前 part 还没画出来(在屏幕外):两样都没有", () => {
    const root = mount(`<div data-timeline-part-id="p1">can bus</div>`)
    const found = collectRanges(root, "can", { partID: "far-away", occurrence: 0 })
    expect(found.active).toBeUndefined()
    expect(found.activeElement).toBeUndefined()
    expect(found.hits).toHaveLength(1)
    root.remove()
  })
})
