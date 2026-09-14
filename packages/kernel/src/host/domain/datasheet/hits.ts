/**
 * 检索命中的形状与引用格式,加上产物路径的几道纯检查。
 *
 * `SearchHit` 的 11 个字段与服务器 `rag_yoma/query.py` 的返回逐字一致(它又是 chunks 表的列);
 * `formatCitation` 与那边的 `format_citation` 同解 —— 标签(`[GENERAL]` / `[KIND]` / `[FIGURE]`)、
 * `p.N` 只在 page > 0 时出现,都是两边一起定的。
 */

import { normChip } from "./chips.ts"

/** /api/search 返回的单条命中。 */
export type SearchHit = {
  text: string
  manual_name: string
  chip: string
  rev: string
  page: number
  headings: string
  score: number
  kind: string
  source_pdf: string
  parsed_path: string
  image_path: string
}

/** 引用标签,三类正交、可叠加:[GENERAL](跨芯片语料桶)、[SCHEMATIC]/[TUTORIAL]/[REFERENCE](kind)、[FIGURE](带图,正文只是图注)。 */
export function citationTags(h: SearchHit): string {
  const tags: string[] = []
  if (h.chip === "GENERAL") tags.push("[GENERAL]")
  if (h.kind === "schematic" || h.kind === "tutorial" || h.kind === "reference") tags.push(`[${h.kind.toUpperCase()}]`)
  if (h.image_path) tags.push("[FIGURE]")
  return tags.length ? "  " + tags.join(" ") : ""
}

export function formatCitation(h: SearchHit, i: number): string {
  const tag = citationTags(h)
  // md / docx / txt 这些没有页的格式 page 是 0:只在真有页码时写 p.N(与服务器 format_citation 同解)。
  const page = h.page > 0 ? ` p.${h.page}` : ""
  let out = `[#${i + 1}]${tag} ${h.manual_name} (${h.chip})${page} | ${h.headings}  (score ${h.score.toFixed(2)})\n${h.text}`
  if (h.image_path) out += `\n   figure: ${h.image_path}`
  if (h.parsed_path) out += `\n   source: ${h.parsed_path}  (action "read_section" for the full section)`
  return out
}

/** GENERAL 桶的命中;chip 为空的也按它算 —— 一条没有 chip 的命中不能冒充"本家搜到了"。 */
export function isGeneralHit(h: SearchHit): boolean {
  const chip = normChip(h.chip ?? "")
  return chip === "" || chip === "GENERAL"
}

/**
 * 有一条命中来自目标家族就算搜到了。**全是 GENERAL 说明 chip 过滤根本没匹配上**:服务器对不认识的
 * chip 不报错,`chip IN (X, 'GENERAL')` 里 X 空集,照样 200 返回跨芯片语料,分数还挺高(实测 0.5~0.68)。
 */
export function onTarget(hits: SearchHit[]): boolean {
  return hits.some((h) => !isGeneralHit(h))
}

export function splitByScope(hits: SearchHit[]): { target: SearchHit[]; general: SearchHit[] } {
  const target: SearchHit[] = []
  const general: SearchHit[] = []
  for (const h of hits) (isGeneralHit(h) ? general : target).push(h)
  return { target, general }
}

/**
 * 几路检索(分卷手册的各卷)并成一份:按分数降序、去重、取前 k。分数是同一个嵌入空间里的余弦相似度,
 * 跨卷可比;去重键取 rev + 页 + 正文前 80 字,同一块文字不会因为两卷重叠的页各来一份。
 */
export function mergeHits(lists: SearchHit[][], k: number): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  const all = lists.flat().sort((a, b) => b.score - a.score)
  for (const h of all) {
    const key = `${h.rev}|${h.page}|${h.text.slice(0, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
    if (out.length >= k) break
  }
  return out
}

/** 服务器 `_valid_name` 的同一条正则:chip / rev 不合法它回 422,而 422 在模型眼里应该是"名字写错了"不是"服务器挂了"。 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function validName(name: string): boolean {
  return NAME_RE.test(name)
}

/** 产物相对路径按段编码:目录名里有空格 / 中文时 URL 仍然对得上。 */
export function encodeRel(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/")
}

/**
 * 产物路径的形状检查。服务器自己有 `_safe_join` 挡越界,这里挡的是模型手滑:绝对路径、反斜杠、`..`、
 * 空段、控制字符 —— 每一种都该得到一句"这不是 parsed_path / image_path"而不是一个 404。
 */
export function artifactPathProblem(rel: string): string | undefined {
  if (!rel.trim()) return "empty artifact path"
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return `not a server-relative artifact path: ${rel}`
  if (rel.includes("\\")) return `artifact paths use "/", not "\\": ${rel}`
  for (const ch of rel) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return "artifact path contains control characters"
  }
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return `artifact path has an empty, "." or ".." segment: ${rel}`
    }
  }
  return undefined
}

/** Docling 裁图是 PNG;其余 web 图片 mime 防御性接受。 */
export const FIGURE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function figureMime(rel: string): string | undefined {
  const dot = rel.lastIndexOf(".")
  if (dot < 0) return undefined
  return FIGURE_MIME[rel.slice(dot).toLowerCase()]
}
