/**
 * 会话内搜索(cmd+F)的纯函数:一个 part 里哪些字能被搜到、数出现次数、在已经画出来的 DOM 里圈出高亮范围。
 *
 * 时间线是虚拟列表,屏幕外的行不在 DOM 里,浏览器自带的查找只能看见眼前这几行。所以分两层:
 *   - **数据层**说"哪个 part 里有几处" —— 计数、上一处 / 下一处、滚到哪一行,都听它的;
 *   - **DOM 层**只管把眼前画出来的字圈上颜色(CSS Custom Highlight API,不改 DOM,不和 Solid / markdown 渲染打架)。
 * 两层看的不是同一份字:数据层是 markdown 源码和工具的原始输出,DOM 层是渲染后的字(`**粗**` 没了星号,链接的 URL
 * 不显示,卡片标题是翻译过的)。所以"第几处"在两层之间只能近似对上 —— 一定落在对的那个 part 上,part 里面可能差一处。
 */

import type { Part } from "@yoma-desktop/kernel"

export const SEARCH_HIT = "timeline-search-hit"
export const SEARCH_ACTIVE = "timeline-search-hit-active"

/**
 * 调用参数里只取顶层的标量(命令、路径、pattern、write 的 content)—— 卡片标题那一行画的就是这些。嵌套的
 * (edit 的 edits[].oldText / newText)卡片上根本不画,搜到了也只能把人带到一张看不见这个词的卡片前面。
 */
const scalarValues = (input: Record<string, unknown>) =>
  Object.values(input).flatMap((value) =>
    typeof value === "string" ? [value] : typeof value === "number" ? [String(value)] : [],
  )

/** 一个 part 里能被搜到的字。顺序照着卡片从上到下:先调用参数(标题那一行),再输出。 */
export function searchableText(part: Part, showReasoning: boolean): string {
  switch (part.type) {
    case "text":
      return part.text ?? ""
    case "reasoning":
      return showReasoning ? (part.text ?? "") : ""
    case "file":
      return part.filename ?? ""
    case "task":
      // 通知行上画的是类型 + 描述,展开是结果全文;summary 那句话(给模型看的)界面上不画,不算。
      return [part.agent, part.description, part.result ?? ""].join("\n")
    case "tool": {
      const state = part.state
      const tail = state.status === "completed" || state.status === "running" ? state.output : undefined
      const error = state.status === "error" ? state.error : undefined
      // 工具名在最前:卡片标题那一行第一个词就是它("调用了 `write`")。
      return [part.tool, ...scalarValues(state.input), tail ?? "", error ?? ""].join("\n")
    }
    default:
      return ""
  }
}

/**
 * 和原文**等长**的小写:偏移要能直接映射回文本节点。`toLowerCase()` 对极少数字符会改变长度(İ → i̇),
 * 碰到这种字符就逐个折、折完变长的那个字符保持原样 —— 好过整段不圈,也好过圈错地方。
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const char of text) {
    const folded = char.toLowerCase()
    out += folded.length === char.length ? folded : char
  }
  return out
}

/** 不重叠地数。两边都得先转成小写。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1
  return count
}

export type SearchEntry = { partID: string; count: number }
export type SearchTarget = { partID: string; occurrence: number }

/** 全局第 index 处落在哪个 part 的第几处。entries 按时间线从上到下排。 */
export function locateMatch(entries: readonly SearchEntry[], index: number): SearchTarget | undefined {
  let rest = index
  for (const entry of entries) {
    if (rest < entry.count) return { partID: entry.partID, occurrence: rest }
    rest -= entry.count
  }
}

/**
 * 打开搜索 / 改了词之后从哪一处开始:视口里第一行及以后的第一处,没有就最后一处 —— 和浏览器的查找一样从眼前找起,
 * 而不是每次都跳回会话开头。`rowOf` 给不出行号的 part(还没进投影)当作不在。
 */
export function startIndex(
  entries: readonly SearchEntry[],
  rowOf: (partID: string) => number | undefined,
  firstVisibleRow: number,
): number {
  let index = 0
  let total = 0
  let found: number | undefined
  for (const entry of entries) {
    const row = rowOf(entry.partID)
    if (found === undefined && entry.count > 0 && row !== undefined && row >= firstVisibleRow) found = index
    index += entry.count
    total += entry.count
  }
  return found ?? Math.max(0, total - 1)
}

/**
 * 在一个 part 的 DOM 里圈出所有出现。跨文本节点地找:markdown 把 `foo**bar**` 拆成两个节点,代码高亮把一行拆成
 * 十几个 span,逐节点找会漏掉跨节点的词。嵌在里面的别的 part(成组的卡片)不归这个 part 管,跳过。
 */
export function rangesIn(element: Element, needle: string): Range[] {
  if (!needle) return []
  const doc = element.ownerDocument
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ""
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.nodeValue ?? ""
    if (!value) continue
    if (node.parentElement?.closest("[data-timeline-part-id]") !== element) continue
    nodes.push(node)
    starts.push(text.length)
    text += value
  }
  const lower = foldCase(text)

  const locate = (offset: number, end: boolean) => {
    let low = 0
    let high = nodes.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    // 结束点恰好落在节点交界时留在前一个节点的末尾,范围不伸进下一个节点。
    if (end && low > 0 && starts[low] === offset) low -= 1
    return { node: nodes[low]!, offset: offset - starts[low]! }
  }

  const ranges: Range[] = []
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    const from = locate(at, false)
    const to = locate(at + needle.length, true)
    const range = doc.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    ranges.push(range)
  }
  return ranges
}

export type CollectedRanges = {
  hits: Range[]
  active: Range | undefined
  activeElement: Element | undefined
  /** `active` 就是要的那一处,不是因为 DOM 里不够数而退到的最后一处。卡片刚展开、正文还没画出来时是 false。 */
  exact: boolean
}

/**
 * 眼前画出来的 part 里的范围。当前那一处 = 当前 part 的第 occurrence 个,DOM 里没那么多就取最后一个
 * (两层的字不完全一样,见文件头);当前 part 画出来了却一处都圈不到时,`activeElement` 让调用方至少能滚到那张卡。
 *
 * `counted` 说数据层在哪些 part 里数到了命中,**只圈这些**:DOM 里多出来的字(翻译过的卡片标题、界面上的标签)
 * 要是也圈,就会出现计数写着"无结果"、屏幕上却一片高亮,回车还跳不过去。顺带省掉绝大多数 part 的遍历 ——
 * 流式输出时这个函数每帧都跑。
 */
export function collectRanges(
  root: Element,
  needle: string,
  target: SearchTarget | undefined,
  counted?: (partID: string) => boolean,
): CollectedRanges {
  const hits: Range[] = []
  let active: Range | undefined
  let activeElement: Element | undefined
  let exact = false
  for (const element of root.querySelectorAll("[data-timeline-part-id]")) {
    const partID = element.getAttribute("data-timeline-part-id") ?? ""
    if (counted && !counted(partID)) continue
    const ranges = rangesIn(element, needle)
    if (target && partID === target.partID) {
      activeElement = element
      exact = ranges.length > target.occurrence
      const at = Math.min(target.occurrence, ranges.length - 1)
      if (at >= 0) active = ranges.splice(at, 1)[0]
    }
    for (const range of ranges) hits.push(range)
  }
  return { hits, active, activeElement, exact }
}

/** 把一个范围滚到眼前:从里往外,每一层能滚的祖先(卡片里限高的输出框、时间线本身)都把它摆到自己的中间。 */
export function centerRange(range: Range, root: HTMLElement) {
  for (let node = range.startContainer.parentElement; node; node = node.parentElement) {
    const scrolls = node === root || (node.scrollHeight > node.clientHeight + 1 && canScroll(node))
    if (scrolls) {
      const rect = range.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      node.scrollTop += rect.top - box.top - (box.height - rect.height) / 2
    }
    if (node === root) return
  }
}

function canScroll(node: HTMLElement) {
  const overflow = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY
  return overflow === "auto" || overflow === "scroll"
}
