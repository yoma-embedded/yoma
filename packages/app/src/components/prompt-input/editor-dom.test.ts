import { describe, expect, test } from "bun:test"
import {
  atMentionRange,
  createTextFragment,
  getCursorPosition,
  getNodeLength,
  getTextLength,
  setCursorPosition,
} from "./editor-dom"

describe("atMentionRange", () => {
  test("盖住的是 @ 本身到光标,不多不少 —— 选中候选之后替换的就是这一段", () => {
    expect(atMentionRange("@", 1)).toEqual({ start: 0, end: 1 })
    expect(atMentionRange("看 @packages/app", 15)).toEqual({ start: 2, end: 15 })
  })

  test("只认光标前那一个 @,光标后的文字不动", () => {
    // "@a @b" 里光标停在 @a 之后:替换的是 @a,后面那个提及原样留着。
    expect(atMentionRange("@a @b", 2)).toEqual({ start: 0, end: 2 })
  })

  test("没有可替换的 @ 时回 null —— 拖拽进来的附件走就地插入,不许动 range", () => {
    expect(atMentionRange("hello", 5)).toBeNull()
    // @ 与光标之间隔了空格:那一段提及已经结束了。
    expect(atMentionRange("@a ", 3)).toBeNull()
    expect(atMentionRange("", 0)).toBeNull()
  })

  test("目录下钻是拿它反复替换的,连着两层要收敛", () => {
    const first = atMentionRange("@packages", 9)
    expect(first).toEqual({ start: 0, end: 9 })
    // 第一层换成 @packages/ 之后,第二层盖住的仍是从 @ 到光标的整段。
    expect(atMentionRange("@packages/", 10)).toEqual({ start: 0, end: 10 })
    expect(atMentionRange("@packages/app/", 14)).toEqual({ start: 0, end: 14 })
  })
})

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })
})
