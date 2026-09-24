import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { LineCommentEditor } from "@yoma-desktop/session-ui/line-comment"

// 行内评论框的 @ 提及与输入框是同一条规则(逐条的纯函数用例在 prompt-input/editor-dom.test.ts
// 的 atMentionRange 一组);session-ui 引用不到 app,评论框自己抄了一份,这里钉的是那一份:
// 弹不弹候选,以及选中之后换掉的是哪一段。
let dispose: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
afterEach(() => {
  dispose?.()
  root.replaceChildren()
})

function mount() {
  const items = vi.fn((query: string) => [`src/${query}.ts`])
  const onInput = vi.fn()
  dispose = render(
    () =>
      createComponent(LineCommentEditor, {
        value: "",
        selection: "L1",
        onInput,
        onCancel: () => {},
        onSubmit: () => {},
        autofocus: false,
        mention: { items },
      }),
    root,
  )
  const textarea = root.querySelector("textarea")!
  // 文字写进去、光标停在 cursor(缺省在末尾),再等候选列表的异步取数落定。
  const type = async (value: string, cursor = value.length) => {
    textarea.value = value
    textarea.setSelectionRange(cursor, cursor)
    textarea.dispatchEvent(new Event("input"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const list = () => root.querySelector('[data-slot="line-comment-mention-list"]')
  return { items, onInput, type, list }
}

describe("行内评论框的 @ 提及", () => {
  test("贴在字后面、补在词前面的 @ 是普通字符,不弹候选", async () => {
    const { items, type, list } = mount()
    await type("mail a@src")
    // 光标停在 @src 之后,紧跟着 README。
    await type("see @srcREADME", 8)
    expect(items).not.toHaveBeenCalled()
    expect(list()).toBeNull()
  })

  test("独立的 @ 弹候选,选中后只换掉 @ 那一段,前面的空格留着", async () => {
    const { items, onInput, type, list } = mount()
    await type("see @src")
    expect(items).toHaveBeenLastCalledWith("src")
    expect(list()).not.toBeNull()

    root.querySelector<HTMLButtonElement>('[data-slot="line-comment-mention-item"]')!.click()
    expect(onInput).toHaveBeenLastCalledWith("see @src/src.ts ")
  })
})
