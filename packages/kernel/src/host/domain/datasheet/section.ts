/**
 * 解析后的手册(Docling 产出的 markdown)里抽一节:标题解析、容错匹配、章节边界、短语定位、截断。
 *
 * 真实语料的形状(2026-09-14 对着 STM32F4 参考手册的分卷核过,~950 KB、15k 行、1000+ 个标题):
 * - **所有标题都是 `##`**:Docling 把位域行("Bits 3:0 DIV_Fraction…")、"Reset value:"、"Note:"、图注都提成了同级标题,
 *   所以"到下一个同级标题为止"只会给出四行。编号章节("30.6.3 …")的边界得按**编号深度**算:直到下一个编号深度
 *   相同或更浅的标题,中间不带编号的行都归它。
 * - **标点是转义的**(`USART\_BRR`、`TIM6&amp;TIM7`),而检索命中的 `headings` 字段是裸的 —— 匹配前两边都剥掉。
 * - 有一个标题就叫 `2`:任何"wanted 以标题开头"的宽松匹配都会被它吞掉,所以反向匹配要求标题撑起 wanted 的大半、
 *   并且在词边界上断开,取最长的那个。
 * - 图在文里只剩 `<!-- image -->` 占位,"整本给模型"不可能,目录 + 按标题取节是唯一可行的读法;目录只列编号章节。
 */

export type Heading = { level: number; title: string; line: number }

/** Docling 的 markdown 转义与 HTML 实体都剥掉:`USART\_BRR` → `USART_BRR`,`TIM6&amp;TIM7` → `TIM6&TIM7`。 */
export function unescapeMarkdown(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!&<>|~])/g, "$1")
}

export function norm(s: string): string {
  return unescapeMarkdown(s).toLowerCase().replace(/\s+/g, " ").trim()
}

export function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]!)
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line: i })
  }
  return out
}

/** " > " 面包屑里最具体的一段。 */
export function lastSegment(heading: string): string {
  const parts = heading
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1]! : heading.trim()
}

/** 编号章节:`14.3.9 Triangle-wave generation`、`2 Registers`、`3. Overview` → 编号深度;不带编号的返回 undefined。 */
export function headingDepth(title: string): number | undefined {
  const m = /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(title)
  return m ? m[1]!.split(".").length : undefined
}

const isAlnum = (ch: string | undefined) => ch !== undefined && /[a-z0-9]/.test(ch)

/**
 * 第 i-1 与第 i 个字符之间是不是词边界:两边都是字母数字不是;夹在两个字母数字中间的 `.` 把两边连成一个词
 * (`30.6` 不是 `30.6.2` 的词前缀,`2` 不是 `25.4.1` 的)。
 */
function boundaryAt(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true
  const before = text[i - 1]!
  const here = text[i]!
  if (isAlnum(before) && isAlnum(here)) return false
  if (before === "." && isAlnum(text[i - 2]) && isAlnum(here)) return false
  if (here === "." && isAlnum(before) && isAlnum(text[i + 1])) return false
  return true
}

/** `text` 以 `prefix` 开头,且断在词边界上(`2` 不算 `25.4.1 …` 的前缀)。 */
function startsAtWord(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && boundaryAt(text, prefix.length)
}

function includesAtWord(text: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return false
    if (boundaryAt(text, at) && boundaryAt(text, at + needle.length)) return true
    from = at + 1
  }
}

/** 反向匹配(wanted 以标题开头 / 包含标题)时标题至少要有多长:8 个字符或 wanted 的六成。 */
const MIN_REVERSE_STEM = 8

function longestWhere(titles: string[], ok: (t: string) => boolean): number {
  let best = -1
  for (let i = 0; i < titles.length; i++) {
    if (ok(titles[i]!) && (best < 0 || titles[i]!.length > titles[best]!.length)) best = i
  }
  return best
}

/**
 * 逐级放宽容错找最匹配的标题:精确 → 标题以 wanted 开头 → wanted 以标题开头(标题要撑起 wanted 的大半,取最长)
 * → 标题包含 wanted → wanted 包含标题(同样的长度门槛,取最长)。都在词边界上断。
 */
export function matchHeading(headings: Heading[], wanted: string): number {
  const w = norm(wanted)
  if (!w) return -1
  const titles = headings.map((h) => norm(h.title))
  const stem = Math.max(MIN_REVERSE_STEM, Math.ceil(w.length * 0.6))
  let idx = titles.indexOf(w)
  if (idx >= 0) return idx
  idx = titles.findIndex((t) => startsAtWord(t, w))
  if (idx >= 0) return idx
  idx = longestWhere(titles, (t) => t.length >= stem && startsAtWord(w, t))
  if (idx >= 0) return idx
  if (w.length >= 4) {
    idx = titles.findIndex((t) => includesAtWord(t, w))
    if (idx >= 0) return idx
  }
  return longestWhere(titles, (t) => t.length >= stem && includesAtWord(w, t))
}

/** 目录只值得列编号章节;真手册里不带编号的"标题"是位域行、Note、图注,列出来只会把目录淹掉。 */
const TOC_NUMBERED_MIN = 10

export function tableOfContents(headings: Heading[], limit = 300): string {
  const numbered = headings.filter((h) => headingDepth(h.title) !== undefined)
  const structured = numbered.length >= TOC_NUMBERED_MIN
  const rows = structured ? numbered : headings
  const lines = rows
    .slice(0, limit)
    .map((h) =>
      structured ? `${"  ".repeat((headingDepth(h.title) ?? 1) - 1)}${h.title}` : `${"#".repeat(h.level)} ${h.title}`,
    )
  const more = rows.length > limit ? `\n… (+${rows.length - limit} more headings)` : ""
  const skipped =
    structured && headings.length > numbered.length
      ? `\n(${headings.length - numbered.length} unnumbered headings — bit fields, notes, figure captions — not listed; they belong to the numbered section above them)`
      : ""
  return lines.join("\n") + more + skipped
}

export function capped(text: string, maxChars: number): { out: string; truncated: boolean } {
  if (text.length <= maxChars) return { out: text, truncated: false }
  return {
    out: text.slice(0, maxChars) + `\n\n… [truncated at ${maxChars} chars — raise maxChars or narrow by heading]`,
    truncated: true,
  }
}

/** 一个字符在原文里可能的写法:字母数字照抄;标点前可能有反斜杠;`&` `<` `>` 可能是实体。 */
function charPattern(ch: string): string {
  if (/[a-z0-9]/i.test(ch)) return ch
  const escaped = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (ch === "&") return "\\\\?(?:&amp;|&)"
  if (ch === "<") return "\\\\?(?:&lt;|<)"
  if (ch === ">") return "\\\\?(?:&gt;|>)"
  return `\\\\?${escaped}`
}

/** 空白容错的短语搜索,返回**最后**一次出现 —— 章节标题第一次出现的多半是目录项。原文里的转义与实体都能对上。 */
export function findPhrase(raw: string, wanted: string): number {
  const tokens = norm(wanted).split(" ").filter(Boolean)
  if (!tokens.length) return -1
  const pattern = tokens.map((t) => [...t].map(charPattern).join("")).join("\\s+")
  const re = new RegExp(pattern, "gi")
  let at = -1
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    at = m.index
    if (m[0].length === 0) re.lastIndex++
  }
  return at
}

/**
 * 章节边界。编号章节:到下一个编号深度相同或更浅的标题为止(中间不带编号的位域行 / Note / 图注都归它);
 * 不带编号的标题:到下一个同级或更高级标题为止。
 */
export function sectionRange(headings: Heading[], idx: number, totalLines: number): [number, number] {
  const start = headings[idx]!.line
  const depth = headingDepth(headings[idx]!.title)
  if (depth !== undefined) {
    for (let j = idx + 1; j < headings.length; j++) {
      const d = headingDepth(headings[j]!.title)
      if (d !== undefined && d <= depth) return [start, headings[j]!.line]
    }
    return [start, totalLines]
  }
  const level = headings[idx]!.level
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j]!.level <= level) return [start, headings[j]!.line]
  }
  return [start, totalLines]
}
