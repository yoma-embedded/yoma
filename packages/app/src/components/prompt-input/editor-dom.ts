const MAX_BREAKS = 200

export function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let breaks = 0
  for (const char of content) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks > MAX_BREAKS) {
      const tail = content.endsWith("\n")
      const text = tail ? content.slice(0, -1) : content
      if (text) fragment.appendChild(document.createTextNode(text))
      if (tail) fragment.appendChild(document.createElement("br"))
      return fragment
    }
  }

  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

export function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

export function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

export function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}

/**
 * 光标前那段 `@…` 在**纯文本偏移**里的起止;没有就是 null(调用方据此决定"就地插入"还是"替换")。
 *
 * 插 pill(选中一个文件)和目录下钻(把输入补成 `@dir/`)都要先把这一段选中再替换,
 * 两处必须算得一模一样 —— 各写一份正则的后果是替换错位,表现成
 * `@packages/@packages/app/` 这种半截拼接,而且只在某些光标位置出现。
 */
export function atMentionRange(rawText: string, cursor: number): { start: number; end: number } | null {
  const match = rawText.substring(0, cursor).match(/@(\S*)$/)
  if (!match) return null
  return { start: match.index ?? cursor - match[0].length, end: cursor }
}

export function setRangeEdge(parent: HTMLElement, range: Range, edge: "start" | "end", offset: number) {
  let remaining = offset
  const nodes = Array.from(parent.childNodes)

  for (const node of nodes) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      if (edge === "start") range.setStart(node, remaining)
      if (edge === "end") range.setEnd(node, remaining)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      if (edge === "start" && remaining === 0) range.setStartBefore(node)
      if (edge === "start" && remaining > 0) range.setStartAfter(node)
      if (edge === "end" && remaining === 0) range.setEndBefore(node)
      if (edge === "end" && remaining > 0) range.setEndAfter(node)
      return
    }

    remaining -= length
  }
}
