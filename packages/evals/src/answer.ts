/**
 * 最终答案的提取与归一化。
 *
 * ## 为什么只认最后一个 ```json 围栏
 *
 * 与 bench 的 `parseMotherDecision` 同一纪律,连正则都一样。理由也一样:模型会在
 * 正文里反复举例("比如 `{\"answer\": \"U1\"}` 这种格式"),取第一个围栏就会把**例子**
 * 当成答案。最后一个是它自己下的结论 —— 这是唯一一个不需要读全文就能定位的锚点,
 * 所以 task 的 prompt 必须把这个格式写死(见 README 的"出题纪律")。
 *
 * ## 归一化到哪一步为止
 *
 * trim → 剥掉包裹的引号/反引号 → 折叠空白 → 小写。**不**做同义词、不做单位换算、
 * 不去标点:那些属于判分策略而不是归一化,悄悄放宽的等价类会让一个本该红的 grader
 * 永远亮绿(`details-check.ts` 上踩过一次那种"不会响的闸门",不想再踩)。
 *
 * 正则(`matches`)走的是**不小写**的那一版,大小写不敏感交给 `i` 标志 —— 否则
 * 出题人写 `[A-Z]\d+` 会永远匹配不上,而且看起来像 agent 答错了。
 */

/** 答案的提取结果。`parsed` 缺席时 `error` 一定在,给 grader 报人话用。 */
export interface AnswerExtraction {
  /** 围栏里的原文(没有围栏时是空串)。进 results.jsonl,失败时人要看它。 */
  raw: string
  parsed?: unknown
  error?: string
}

/** 与 bench `parseMotherDecision` 逐字一致的围栏正则。 */
const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g

export function extractLastJsonFence(text: string): AnswerExtraction {
  const fences = [...text.matchAll(FENCE_RE)]
  if (!fences.length) return { raw: "", error: "最后一条消息里没有 ```json 围栏" }
  const raw = fences[fences.length - 1]![1]!
  try {
    return { raw, parsed: JSON.parse(raw) }
  } catch (error) {
    return { raw, error: `围栏内容不是合法 JSON:${(error as Error).message}` }
  }
}

/** 取答案字段。围栏里直接是标量/数组时(没包 `{answer: …}`)也认 —— 那是同一个意思。 */
export function readAnswerField(
  parsed: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (parsed === undefined) return { ok: false, error: "没有可解析的答案" }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (!(field in record)) {
      const keys = Object.keys(record)
      return { ok: false, error: `围栏 JSON 里没有 ${field} 字段(实得字段:${keys.length ? keys.join(", ") : "无"})` }
    }
    return { ok: true, value: record[field] }
  }
  // 标量或数组:模型少包了一层。题面要求的是 {"answer": …},但为此判错等于用格式惩罚内容。
  return { ok: true, value: parsed }
}

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
]

function stripWrappers(text: string): string {
  let value = text.trim()
  for (let guard = 0; guard < 4; guard += 1) {
    const pair = WRAPPERS.find(([open, close]) => value.length >= 2 && value.startsWith(open) && value.endsWith(close))
    if (!pair) break
    value = value.slice(1, -1).trim()
  }
  return value
}

/** 归一化到"人眼看着一样"为止,但**保留大小写**。正则匹配用这一版。 */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value)
  return stripWrappers(text).replace(/\s+/g, " ").trim()
}

/** 等值比较用的归一化:在 {@link normalizeText} 之上再小写。 */
export function normalizeScalar(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

/** 数组逐元素归一化;标量当成单元素数组 —— 参考解写成 `["U3"]` 而模型答 `"U3"` 不该判错。 */
export function normalizeList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(normalizeScalar)
}

/** 只要有一侧是数组,就按列表比;两侧都是标量则按标量比。 */
function isListy(value: unknown): boolean {
  return Array.isArray(value)
}

/**
 * 集合比较:去重后排序。
 *
 * "去重"是刻意的 —— README 写的是"按集合比",而重复元素在这类题里
 * (元件位号、引脚名)从来不携带信息。要计重数就把 `unordered` 关掉。
 */
function sameSet(a: string[], b: string[]): boolean {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameOrdered(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function answerEquals(actual: unknown, expected: unknown, unordered = true): boolean {
  if (isListy(actual) || isListy(expected)) {
    const a = normalizeList(actual)
    const b = normalizeList(expected)
    return unordered ? sameSet(a, b) : sameOrdered(a, b)
  }
  return normalizeScalar(actual) === normalizeScalar(expected)
}

export function answerOneOf(actual: unknown, options: unknown[], unordered = true): boolean {
  return options.some((option) => answerEquals(actual, option, unordered))
}

/** 整串匹配 + 大小写不敏感。锚点是我们加的,出题人不必记得写 `^…$`。 */
export function answerMatches(actual: unknown, pattern: string): boolean {
  const text = Array.isArray(actual) ? normalizeList(actual).join(", ") : normalizeText(actual)
  return new RegExp(`^(?:${pattern})$`, "i").test(text)
}

/** 给人看的一行。数组用 `,` 连,避免报告里出现一串 JSON 转义。 */
export function describeAnswer(value: unknown): string {
  if (value === undefined) return "(无)"
  if (Array.isArray(value)) return `[${value.map((item) => normalizeText(item)).join(", ")}]`
  return normalizeText(value) || "(空)"
}
