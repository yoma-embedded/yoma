/**
 * gdb 打印出来的值(`{a = 1, b = {c = 2}, buf = "hi\000", arr = {0 <repeats 16 times>}}`)→ 可展开的树。
 * 纯函数。内核只把 `-data-evaluate-expression` 的原文递过来(开着 print pretty,所以有换行和缩进),
 * 拆树在这边做:不认得的写法原样当叶子,绝不丢字。
 */

export interface GdbValueNode {
  /** 成员名;数组元素是 `[i]`,无名的匿名成员为空。 */
  name: string
  /** 叶子的值;有 children 时是折叠态的摘要。 */
  value: string
  children?: GdbValueNode[]
}

const SUMMARY_LIMIT = 60

/** 在顶层(不在括号、字符串、字符字面量里)按逗号切。 */
function splitTop(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: '"' | "'" | undefined
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "{" || ch === "(" || ch === "<") depth++
    else if (ch === "}" || ch === ")" || (ch === ">" && depth > 0)) depth--
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** `name = value` 的等号:只认顶层、前面是一个标识符的那个(`==` 与字符串里的不算)。 */
function splitMember(item: string): { name?: string; rest: string } {
  const match = /^([A-Za-z_$][\w$]*|\[[^\]]+\])\s=\s/.exec(item)
  if (!match) return { rest: item }
  return { name: match[1], rest: item.slice(match[0].length) }
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT)}…`
}

/** 最外层是不是一对完整的 `{…}`(截断的 `{a = 1, b…` 不算,按叶子给)。 */
function braced(text: string): boolean {
  if (!text.startsWith("{") || !text.endsWith("}")) return false
  let depth = 0
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0 && i !== text.length - 1) return false
    }
  }
  return depth === 0
}

export function parseGdbValue(text: string, name = ""): GdbValueNode {
  const value = text.trim()
  if (!braced(value)) return { name, value }
  const items = splitTop(value.slice(1, -1))
  if (items.length === 0) return { name, value: "{}" }
  let index = 0
  const children = items.map((item) => {
    const member = splitMember(item)
    if (member.name) return parseGdbValue(member.rest, member.name)
    // 数组元素没名字:按位置编号。`0 <repeats 16 times>` 占 16 个位置。
    const repeat = /<repeats (\d+) times>\s*$/.exec(item)
    const label = repeat ? `[${index}..${index + Number(repeat[1]) - 1}]` : `[${index}]`
    index += repeat ? Number(repeat[1]) : 1
    return parseGdbValue(item, label)
  })
  return { name, value: summarize(value), children }
}
