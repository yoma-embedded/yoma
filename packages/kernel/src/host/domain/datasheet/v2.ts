/**
 * v2 检索接口的纯函数层:请求体构造、响应解码、错误体解码、给模型看的话。
 *
 * 服务端契约(DESIGN-v3 §6/§7.2,M2,rag-codelib 的 Java 实现):
 *
 *   POST /api/v2/search
 *     { query, keywords?, scope: { targets: [], docs: [], doc_types: [] }, top_k: 1..20, detail: "concise" | "full" }
 *   → { hits: [{ rank,
 *                doc:   { doc_uid, doc_id, doc_rev, title, doc_type, vendor, targets, legacy_chip, legacy_name },
 *                chunk: { id, kind, page, section_id, heading_path, text, shard, legacy_rev },
 *                score, reasons, links: { parsed_path, image_path } }],
 *       scope_resolved, degraded, generation }
 *   422 → { error: { code: "scope_unresolved", message, hint, candidates? } }(错误体形状见 §7.4)
 *
 * 【为什么解码写得这么松】M2 的服务端由另一个会话实现,首版一定会和设计稿有出入(字段名、包一层
 * `docs: []`、候选写成对象……)。这里的原则与 v1 的 `normalizeHit` 一致:**缺字段给默认值,不认识的形状
 * 跳过而不是抛**,否则一个反代的错误页就能把整个工具调用炸成裸 TypeError。真正要严谨的是语义:
 * - `scope.targets` 只放模型给的那个名字,**不做归一、不做家族推断**(DESIGN-v3 §6.2:范围解析归服务端);
 * - `scope.docs` 放模型给的 `rev`,同样原样;
 * - 高亮的 `score` 只在单次响应内可比(§7.2),这里不排序、不跨请求合并(那是 v1 的 `mergeHits` 才做的事)。
 *
 * 【给模型的话】422 的候选、降级原因、实际用的范围都要原样呈现 —— 旧服务最坑的一条就是"猜错 chip
 * 也 200 返回 GENERAL",客户端为此写了三层补丁;v2 把这件事交回服务端之后,这些说明就是模型判断
 * "这个结果到底是不是我这颗芯片"的唯一线索。
 */

import { GENERAL_CHIP, normChip } from "./chips.ts"
import type { SearchHit } from "./hits.ts"
import { formatCitation } from "./hits.ts"

/** 接口版本选择:auto = 先 v2,只有明确 404/405 才回落 v1;v1 / v2 = 只用那一个。 */
export type DatasheetApiVersion = "auto" | "v1" | "v2"

/** search 的 v2 请求(工具参数 → 网络请求之前)。 */
export interface V2SearchRequest {
  query: string
  keywords?: string
  /** 模型给的 chip,原样进 scope.targets。 */
  chip: string
  /** 模型给的 rev,原样进 scope.docs。 */
  rev?: string
  topK: number
  detail?: "concise" | "full"
}

export interface V2DocMeta {
  doc_uid: string
  doc_id: string
  doc_rev: string
  title: string
  doc_type: string
  vendor: string
  targets: string[]
  legacy_chip: string
  legacy_name: string
}

export interface V2ChunkMeta {
  id: string
  kind: string
  page: number
  section_id: string
  heading_path: string
  text: string
  shard: string
  legacy_rev: string
  /** 服务端在 `detail: "concise"` 下截短了正文(`chunk.text_truncated: true`)。 */
  text_truncated: boolean
  /** 文档内的顺序号;相邻 chunk 接口用它,这里只保留给 details。 */
  ordinal: number
}

/** v2 的一条命中,同时保留了 `SearchHit` 的 11 个字段(引用格式、read_section 的入口都不变)。 */
export interface V2SearchHit extends SearchHit {
  rank: number
  reasons: string[]
  doc: V2DocMeta
  chunk: V2ChunkMeta
}

/** `scope_resolved` 里的已知字段 + 其余原样保留的标量 / 字符串数组,未知字段也展示给模型。 */
export interface V2ScopeResolved {
  targets: string[]
  docs: string[]
  ladder: string
  fields: Record<string, string | string[]>
}

export interface V2SearchResult {
  hits: V2SearchHit[]
  scopeResolved?: V2ScopeResolved
  degraded: string[]
  generation?: number
}

/** 422 / 4xx / 5xx 的错误体(§7.4)。`detail` 是原始体,只在没有结构化 message 时用。 */
export interface V2ApiError {
  code: string
  message: string
  hint: string
  candidates: string[]
  detail: string
}

type Dict = Record<string, unknown>

function asObject(value: unknown): Dict | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 字符串数组的松散解码:字符串原样,对象取常见的名字字段。
 *
 * `code` 是**服务端真实形状**的候选 / 词表项字段:`V2Error.scopeUnresolved` 的顶层
 * `candidates` 是 `[{code, level, vendor, title, pattern, matched_by, ancestors}]`,
 * `/api/v2/targets/resolve` 的 `matches` 同样是 `code`。少了这一项,422 会显示成
 * "Candidates:" 后面一个字都没有 —— 而候选正是 v2 用来替代旧服务"猜错 chip 静默返回
 * GENERAL"的那条信息。
 */
export function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  const out: string[] = []
  for (const item of asArray(value)) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim())
      continue
    }
    if (typeof item === "number") {
      out.push(String(item))
      continue
    }
    const obj = asObject(item)
    if (!obj) continue
    const name =
      asString(obj.target) ||
      asString(obj.code) ||
      asString(obj.name) ||
      asString(obj.id) ||
      asString(obj.q) ||
      asString(obj.value) ||
      asString(obj.label) ||
      asString(obj.reason) ||
      asString(obj.chip) ||
      asString(obj.doc_id) ||
      asString(obj.doc_uid)
    if (name) out.push(name)
  }
  return dedupe(out)
}

// ─── 请求 ────────────────────────────────────────────────────────────────────

/**
 * 工具参数 → v2 请求体。`chip` / `rev` 原样放进 scope(DESIGN-v3 §7.5:"把模型给的 chip 原样放进
 * scope.targets");`keywords` 只在非空时带,空串发给 BM25 没有意义。`detail` 缺省 concise ——
 * 需要整节时走 read_section,检索结果不需要为完整正文付 token。
 */
export function buildV2SearchBody(request: V2SearchRequest): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    targets: request.chip.trim() ? [request.chip.trim()] : [],
    docs: request.rev?.trim() ? [request.rev.trim()] : [],
    doc_types: [],
  }
  return {
    query: request.query,
    ...(request.keywords?.trim() ? { keywords: request.keywords.trim() } : {}),
    scope,
    top_k: request.topK,
    detail: request.detail ?? "concise",
  }
}

// ─── 响应 ────────────────────────────────────────────────────────────────────

const emptyDoc = (): V2DocMeta => ({
  doc_uid: "",
  doc_id: "",
  doc_rev: "",
  title: "",
  doc_type: "",
  vendor: "",
  targets: [],
  legacy_chip: "",
  legacy_name: "",
})

/** 文档对象:搜索命中的 `doc` 与 `/api/v2/docs` 的列表项共用。全空的对象返回 undefined。 */
export function normalizeV2Doc(raw: unknown): V2DocMeta | undefined {
  const doc = asObject(raw)
  if (!doc) return undefined
  const meta: V2DocMeta = {
    doc_uid: asString(doc.doc_uid),
    doc_id: asString(doc.doc_id),
    doc_rev: asString(doc.doc_rev),
    title: asString(doc.title),
    doc_type: asString(doc.doc_type),
    vendor: asString(doc.vendor),
    targets: asStringArray(doc.targets),
    legacy_chip: asString(doc.legacy_chip),
    legacy_name: asString(doc.legacy_name),
  }
  if (!meta.doc_uid && !meta.doc_id && !meta.title && !meta.legacy_name && !meta.targets.length) return undefined
  return meta
}

/**
 * v2 命中 → 工具沿用的 `SearchHit` + v2 的附加字段。
 *
 * 字段映射(设计稿 §7.2 → 现有工具输出):
 * - `manual_name` ← legacy_name(旧清单里的手册名,最贴近原来的引用) → title → doc_id
 * - `chip`        ← legacy_chip(旧家族桶) → targets[0];[GENERAL] 标签靠它
 * - `rev`         ← **doc_id**(search 的 `rev` 参数在 v2 里就是 scope.docs),空时退回 chunk.legacy_rev
 * - `headings`    ← heading_path → section_id
 * - `parsed_path` / `image_path` ← links.*(与 v1 同义,read_section / view_figure 不用改)
 * - `page` / `kind` / `text` / `score` ← chunk / 命中本身
 * - `source_pdf`  v2 的 doc 不带这个字段,留空(不要拿别的字段冒充)
 */
export function normalizeV2Hit(raw: unknown, index: number): V2SearchHit | undefined {
  const hit = asObject(raw)
  if (!hit) return undefined
  const doc = normalizeV2Doc(hit.doc) ?? emptyDoc()
  const chunkRaw = asObject(hit.chunk) ?? {}
  const links = asObject(hit.links) ?? {}
  const chunk: V2ChunkMeta = {
    id: asString(chunkRaw.id),
    kind: asString(chunkRaw.kind),
    page: asNumber(chunkRaw.page),
    section_id: asString(chunkRaw.section_id),
    heading_path: asString(chunkRaw.heading_path),
    // 正文保留原样(不 trim):代码片段 / 表格的缩进是内容的一部分。
    text: typeof chunkRaw.text === "string" ? chunkRaw.text : asString(chunkRaw.text),
    shard: asString(chunkRaw.shard),
    legacy_rev: asString(chunkRaw.legacy_rev),
    text_truncated: chunkRaw.text_truncated === true,
    ordinal: asNumber(chunkRaw.ordinal),
  }
  const base: SearchHit = {
    text: chunk.text,
    manual_name: doc.legacy_name || doc.title || doc.doc_id || doc.doc_uid,
    chip: doc.legacy_chip || doc.targets[0] || "",
    rev: doc.doc_id || chunk.legacy_rev,
    page: chunk.page,
    headings: chunk.heading_path || chunk.section_id,
    score: asNumber(hit.score),
    kind: chunk.kind,
    source_pdf: "",
    parsed_path: asString(links.parsed_path),
    image_path: asString(links.image_path),
  }
  return {
    ...base,
    rank: asFiniteNumber(hit.rank) ?? index + 1,
    reasons: asStringArray(hit.reasons),
    doc,
    chunk,
  }
}

/** `scope_resolved` → 已知字段 + 其余标量。数组 / 对象都容错,认不出的类型丢掉。 */
export function normalizeScopeResolved(raw: unknown): V2ScopeResolved | undefined {
  const scope = asObject(raw)
  if (!scope) return undefined
  const fields: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(scope)) {
    if (key === "targets" || key === "docs" || key === "ladder") continue
    if (typeof value === "string") {
      if (value.trim()) fields[key] = value.trim()
      continue
    }
    if (Array.isArray(value)) {
      const list = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
      if (list.length) fields[key] = list
    }
  }
  const resolved: V2ScopeResolved = {
    targets: asStringArray(scope.targets),
    docs: asStringArray(scope.docs),
    ladder: asString(scope.ladder),
    fields,
  }
  return resolved.targets.length || resolved.docs.length || resolved.ladder || Object.keys(fields).length
    ? resolved
    : undefined
}

/** 搜索响应。`hits` 缺 / 不是数组时按空处理;顺序原样保留(服务端已经排好,客户端不再排序)。 */
export function normalizeV2SearchResponse(raw: unknown): V2SearchResult {
  const json = asObject(raw)
  const nested = asObject(json?.data)
  const hits = (Array.isArray(raw) ? raw : asArray(json?.hits).length ? asArray(json?.hits) : asArray(nested?.hits))
    .map((hit, index) => normalizeV2Hit(hit, index))
    .filter((hit): hit is V2SearchHit => hit !== undefined)
  return {
    hits,
    scopeResolved: normalizeScopeResolved(
      json?.scope_resolved ?? json?.scopeResolved ?? nested?.scope_resolved ?? nested?.scopeResolved,
    ),
    degraded: asStringArray(json?.degraded ?? nested?.degraded),
    generation: asFiniteNumber(json?.generation ?? nested?.generation),
  }
}

/** `/api/v2/docs?target=` 的 `target_resolved`(服务端真实形状;无 target 时为 null)。 */
export interface V2TargetResolved {
  input: string
  matched: string
  level: string
  matchedBy: string
  ancestors: string[]
}

export interface V2DocsResult {
  docs: V2DocMeta[]
  total?: number
  generation?: number
  targetResolved?: V2TargetResolved
}

/** `target_resolved` 是服务端对 `target=` 的解析结果;全空时 undefined。 */
export function normalizeTargetResolved(raw: unknown): V2TargetResolved | undefined {
  const target = asObject(raw)
  if (!target) return undefined
  const resolved: V2TargetResolved = {
    input: asString(target.input),
    matched: asString(target.matched),
    level: asString(target.level),
    matchedBy: asString(target.matched_by),
    ancestors: asStringArray(target.ancestors),
  }
  return resolved.input || resolved.matched || resolved.ancestors.length ? resolved : undefined
}

/**
 * `/api/v2/docs` 的响应:`{docs, total, generation, target_resolved}`(服务端真实形状)。
 * 列表项本身是 `docWithCounts`(doc + status / source_pages / chunks / shards),解码时忽略多余字段。
 * 同时容错数组本身、`{items}` / `{results}` / `{data:{docs}}` 等包裹层。
 */
export function normalizeDocsResponse(raw: unknown): V2DocsResult {
  const json = asObject(raw)
  const nested = asObject(json?.data)
  const list = Array.isArray(raw)
    ? raw
    : asArray(json?.docs).length
      ? asArray(json?.docs)
      : asArray(json?.items).length
        ? asArray(json?.items)
        : asArray(json?.results).length
          ? asArray(json?.results)
          : asArray(nested?.docs)
  const docs = list.map((item) => normalizeV2Doc(item)).filter((doc): doc is V2DocMeta => doc !== undefined)
  const total = asFiniteNumber(json?.total) ?? asFiniteNumber(json?.count) ?? asFiniteNumber(nested?.total)
  const generation = asFiniteNumber(json?.generation ?? nested?.generation)
  const targetResolved = normalizeTargetResolved(json?.target_resolved ?? nested?.target_resolved)
  return {
    docs,
    ...(total === undefined ? {} : { total }),
    ...(generation === undefined ? {} : { generation }),
    ...(targetResolved === undefined ? {} : { targetResolved }),
  }
}

/** 错误体里的候选:顶层、error 里、details / data 里都看一遍;字符串或对象都行。 */
function errorCandidates(root: Dict | undefined, error: Dict | undefined): string[] {
  const roots = [root, error]
  const out: string[] = []
  for (const source of roots) {
    if (!source) continue
    out.push(...asStringArray(source.candidates))
    out.push(...asStringArray(source.suggestions))
    out.push(...asStringArray(asObject(source.details)?.candidates))
    out.push(...asStringArray(asObject(source.data)?.candidates))
  }
  return dedupe(out)
}

/** `/api/v2/targets/resolve?q=` 的解码结果。 */
export interface V2ResolveResult {
  /** 解析出来的词表项 / 祖先(服务端怎么说就怎么收)。 */
  resolved: string[]
  candidates: string[]
  docs?: number
  /** 其余标量字段原样保留,给模型展示。 */
  fields: Record<string, string | string[]>
}

/**
 * targets/resolve 的响应形状在服务端定稿前可能变:数组、`{resolved}`,对象里的 `target` / `ancestors`、
 * 以及 `docs` 是数字还是文档列表。这里只取"解析结果 / 候选 / 文档数",其余标量放 fields。
 */
export function normalizeResolveResponse(raw: unknown): V2ResolveResult {
  const json = asObject(raw)
  const data = asObject(json?.data)
  const source = json ?? data ?? {}
  const resolvedNode = asObject(source.resolved)
  const dataResolvedNode = asObject(data?.resolved)
  const resolved = dedupe([
    ...asStringArray(source.resolved),
    ...asStringArray(resolvedNode?.target),
    ...asStringArray(resolvedNode?.name),
    ...asStringArray(resolvedNode?.ancestors),
    ...asStringArray(source.matches),
    ...asStringArray(source.targets),
    ...asStringArray(source.target),
    ...asStringArray(source.ancestors),
    ...asStringArray(data?.resolved),
    ...asStringArray(dataResolvedNode?.target),
    ...asStringArray(dataResolvedNode?.name),
    ...asStringArray(dataResolvedNode?.ancestors),
    ...asStringArray(data?.matches),
    ...asStringArray(data?.targets),
    ...asStringArray(data?.target),
    ...asStringArray(data?.ancestors),
  ])
  const candidates = dedupe([...errorCandidates(source, undefined), ...errorCandidates(data, undefined)])
  const docs =
    asFiniteNumber(source.doc_count) ??
    asFiniteNumber(source.docs_count) ??
    (typeof source.docs === "number" ? source.docs : undefined) ??
    asFiniteNumber(data?.doc_count)
  const fields: Record<string, string | string[]> = {}
  const known = new Set([
    "resolved",
    "targets",
    "target",
    "ancestors",
    "matches",
    "candidates",
    "suggestions",
    "docs",
    "doc_count",
    "docs_count",
    "data",
  ])
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key)) continue
    if (typeof value === "string") {
      if (value.trim()) fields[key] = value.trim()
      continue
    }
    if (Array.isArray(value)) {
      const list = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
      if (list.length) fields[key] = list
    }
  }
  return docs === undefined ? { resolved, candidates, fields } : { resolved, candidates, docs, fields }
}

/** 422 / 429 / 503 等的错误体。v1 的 `{detail: "..."}`、v2 的 `{error: {code, message, hint}}` 都能读。 */
export function parseV2Error(status: number, body: string): V2ApiError {
  const raw = body.trim()
  let json: unknown
  try {
    // 先对**完整** body 做 JSON.parse,再截断给 detail 展示:422 的候选列表可能超过 2 KB,
    // 先截断再解析会把结构化错误变成一句"没有 code 的原文",候选全丢。
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = undefined
  }
  const detail = raw.length > 2000 ? raw.slice(0, 2000) : raw
  const root = asObject(json)
  const error = asObject(root?.error) ?? asObject(root?.detail)
  const source = error ?? root ?? {}
  let message = asString(source.message) || asString(source.msg) || asString(source.detail)
  if (!message && Array.isArray(source.detail)) {
    message = source.detail
      .map((item) => asString(asObject(item)?.msg))
      .filter(Boolean)
      .join("; ")
  }
  if (!message && typeof root?.detail === "string") message = root.detail.trim()
  if (!message && typeof root?.message === "string") message = root.message.trim()
  return {
    code: asString(source.code) || asString(source.error_code) || asString(source.type),
    message,
    hint: asString(source.hint) || asString(source.suggestion),
    candidates: errorCandidates(root, error),
    detail,
  }
}

/** 422 是否就是"范围解析不出来"(服务端不检索,返回候选)。 */
export function isScopeUnresolved(error: V2ApiError): boolean {
  return error.code === "scope_unresolved" || /scope[_ ]unresolved/i.test(`${error.code} ${error.message}`)
}

// ─── 给模型看的话 ─────────────────────────────────────────────────────────────

/** 候选清单的统一写法:超过上限说明还有多少,别让截断冒充全表。 */
export function formatCandidateList(candidates: string[], limit = 30): string {
  if (!candidates.length) return ""
  const shown = candidates.slice(0, limit).join(", ")
  const rest = candidates.length - limit
  return rest > 0 ? `${shown} (+${rest} more — action "chips" lists all)` : shown
}

/** 实际范围。未知字段也列出来;ladder 原样给,不替服务端解释它没写明的语义。 */
export function formatScopeResolved(scope: V2ScopeResolved | undefined): string {
  if (!scope) return ""
  const parts: string[] = []
  if (scope.targets.length) parts.push(`targets: ${scope.targets.join(", ")}`)
  if (scope.docs.length) parts.push(`docs: ${scope.docs.join(", ")}`)
  if (scope.ladder) parts.push(`ladder: ${scope.ladder}`)
  for (const [key, value] of Object.entries(scope.fields)) {
    const text = Array.isArray(value) ? value.join(", ") : value
    if (text) parts.push(`${key}: ${text}`)
  }
  if (!parts.length) return ""
  return (
    `Scope actually used by the server: ${parts.join("; ")}. ` +
    `The v2 server resolved the requested chip / rev itself — this line, not your argument, is the authoritative scope.`
  )
}

const DEGRADED_HELP: Record<string, string> = {
  rerank: "reranking was unavailable, so results are in fusion order rather than reranked order",
  dense: "vector (dense) retrieval was unavailable, so results come only from keyword / identifier retrieval",
  sparse: "keyword (BM25 / sparse) retrieval was unavailable, so results come only from vector / identifier retrieval",
  ident: "identifier (exact register / model name) retrieval was unavailable, so identifier matches may be missing",
}

/** 降级说明:已知原因解释,未知原因原样列出。 */
export function formatDegraded(degraded: string[]): string {
  const unique = dedupe(degraded.map((item) => item.trim()).filter(Boolean))
  if (!unique.length) return ""
  const labels = unique.map((item) => (DEGRADED_HELP[item] ? `${item} (${DEGRADED_HELP[item]})` : item))
  return (
    `NOTE: the server degraded this search: ${labels.join("; ")}. ` +
    `Results may be incomplete; do not compare their scores with a non-degraded search.`
  )
}

/** v2 引用 = v1 引用 + 服务端给的理由(`reasons`)。正文被 concise 截短时明确提示走 read_section。 */
export function formatV2Citation(hit: V2SearchHit, index: number): string {
  const out = formatCitation(hit, index)
  const truncated = hit.chunk.text_truncated
    ? `\n   (server truncated this chunk's text — action "read_section" for the full section)`
    : ""
  return hit.reasons.length ? `${out}${truncated}\n   why: ${hit.reasons.join("; ")}` : `${out}${truncated}`
}

/** 全是 GENERAL(跨芯片)的命中:服务端可能降级了范围,提醒模型别当成目标芯片的答案。 */
export function hitsAreAllGeneral(hits: V2SearchHit[]): boolean {
  return (
    hits.length > 0 &&
    hits.every(
      (hit) =>
        normChip(hit.doc.legacy_chip) === GENERAL_CHIP ||
        hit.doc.targets.some((target) => normChip(target) === GENERAL_CHIP),
    )
  )
}

// ─── chips(v2 /api/v2/docs) ───────────────────────────────────────────────────

/** chips 分组的键:legacy_chip(旧家族桶)优先,其次第一个 target,都没有就 UNFILED。 */
export function docFamily(doc: V2DocMeta): string {
  return doc.legacy_chip || doc.targets[0] || "UNFILED"
}

/** search 用的 rev / scope.docs 值:文档号优先,其次 doc_uid。 */
export function docRev(doc: V2DocMeta): string {
  return doc.doc_id || doc.doc_uid
}

/** 同一文档可能因为分片 / 重复而出现多次:按 doc_uid(退到 doc_id + 标题 + 版本)去重,保留顺序。 */
export function uniqueDocs(docs: V2DocMeta[]): V2DocMeta[] {
  const seen = new Set<string>()
  const out: V2DocMeta[] = []
  for (const doc of docs) {
    const key = doc.doc_uid || `${doc.doc_id}|${doc.title}|${doc.doc_rev}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(doc)
  }
  return out
}

export function groupDocsByFamily(docs: V2DocMeta[]): Map<string, V2DocMeta[]> {
  const groups = new Map<string, V2DocMeta[]>()
  for (const doc of uniqueDocs(docs)) {
    const family = docFamily(doc)
    const list = groups.get(family)
    if (list) list.push(doc)
    else groups.set(family, [doc])
  }
  return groups
}

/** 家族一行,格式与 v1 的 `formatChipList` 保持一致(括号里是这个家族的手册数)。 */
export function formatV2ChipList(groups: Map<string, V2DocMeta[]>): string {
  return [...groups.entries()]
    .sort(([a], [b]) => {
      // 家族名可能是小写的 target 词表项,localeCompare 在不同机器上的大小写顺序不一致;
      // 这里按大写后的码位排,测试与输出才跨平台稳定。
      const left = a.toUpperCase()
      const right = b.toUpperCase()
      return left < right ? -1 : left > right ? 1 : 0
    })
    .map(([family, docs]) =>
      normChip(family) === GENERAL_CHIP
        ? `${family} (${docs.length}, shared cross-chip bucket — folded into every search automatically)`
        : `${family} (${docs.length})`,
    )
    .join(", ")
}

/** 一个家族的手册行。`rev "..."` 里的值就是下次 search 该传给 `rev`(v2 的 scope.docs)的文档号。 */
export function formatV2FamilyManuals(docs: V2DocMeta[], limit = 200): string {
  const unique = uniqueDocs(docs)
  const rows = unique.slice(0, limit).map((doc) => {
    const kind = doc.doc_type ? ` [${doc.doc_type}]` : ""
    const rev = docRev(doc) || "(unknown id)"
    const title = doc.legacy_name || doc.title || "(untitled)"
    const revision = doc.doc_rev && doc.doc_rev !== rev ? ` (revision ${doc.doc_rev})` : ""
    return `  rev "${rev}"${kind} — ${title}${revision}`
  })
  const more = unique.length > limit ? `\n  … (+${unique.length - limit} more)` : ""
  return rows.join("\n") + more
}
