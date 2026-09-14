/**
 * 芯片索引:/api/manifest 的家族视图,以及"模型手上的名字 → 服务器认的名字"的两次解析(家族、分卷)。
 *
 * 服务器按**家族**归档(`AT32F`、`STM32F4`、`MM32SPIN`),而模型手上永远是具体型号(`AT32F421C8T7`)。
 * 猜错家族名时服务器**不报错**:chip 过滤匹配不到任何手册,它照样 200 返回 GENERAL 语料的命中,分数还挺高。
 * 实测代价(2026-09-01 一次真会话):模型试了 AT32F421 / AT32 / AT32F4 / AT32F421xx 共 11 次 search 全部落空,
 * 据此告诉用户"服务器没收录这颗芯片" —— 而它收录了 16 本雅特力手册,索引名就是 `AT32F`。
 *
 * 第二层解析是分卷(2026-09-14 对着真 manifest 加的):大手册按页切成 `RM0390_p1-400` / `RM0390_p401-800` …
 * 这样的卷,757 条里 305 条是卷。模型自然会写 `rev: "RM0390"`,而服务器对不存在的 rev 一条都不回 ——
 * 不是 GENERAL 噪声,是空。`resolveRev` 把基名解析成它的全部卷;"几本手册"按文档数而不是卷数(`manualCount`),
 * 否则 chips 说 "14 manual(s)" 却只列 4 行。
 *
 * 封面型号(`covered_devices`)在真 manifest 里是**一个字符串**、带 `x` 通配与 `/` 备选:`STM32G081xB`、
 * `STM32G071x8/xB`、`STM32G0B0KE/CE/RE/VE`、`STM32G0x1`(审稿对着真数据抓出来的:第一版按 `string[]` 字面前缀写,
 * 测试用编的夹具全绿,线上一次都没触发)。`expandCoverStems` 把它展开成若干模式,`x` 匹配任意一个字符。
 *
 * 纯函数、零依赖:网络、缓存、超时全在工具壳那边。
 */

export type ManifestEntry = {
  chip: string
  rev: string
  manual_name?: string
  kind?: string
  num_chunks?: number
  /** 封面列的型号系列;线上是字符串(`STM32G071x8/xB`),数组也收。 */
  covered_devices?: string | string[] | null
  /** 分卷的原文页范围。 */
  source_page_range?: [number, number] | null
}

export type ChipManual = {
  rev: string
  manual_name: string
  kind: string
  /** 展开后的封面型号模式(保留小写 x 通配):`STM32G071x8/xB` → ["STM32G071x8", "STM32G071xB"]。 */
  covered: string[]
  pages?: [number, number]
}

export type ChipFamily = { chip: string; manuals: ChipManual[] }

/** 归一化:大写 + 去掉分隔符 —— `ESP32-S3`、`esp32 s3`、`ESP32_S3` 是同一个家族。 */
export function normChip(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * `STM32G071x8/xB` → `STM32G071x8`, `STM32G071xB`;`STM32G0B0KE/CE/RE/VE` → 四个;斜杠后的备选替换前一项的**尾部**同长度。
 * 数组形式每项各自展开。
 */
export function expandCoverStems(raw: string | string[] | null | undefined): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== "string") continue
    const alternatives = item
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
    const full = alternatives[0]
    if (!full) continue
    out.push(full)
    for (const alt of alternatives.slice(1)) {
      out.push(alt.length < full.length ? full.slice(0, full.length - alt.length) + alt : alt)
    }
  }
  return out
}

export function buildChipIndex(entries: ManifestEntry[]): Map<string, ChipFamily> {
  const index = new Map<string, ChipFamily>()
  for (const entry of entries) {
    if (!entry || typeof entry.chip !== "string" || !entry.chip.trim()) continue
    if (typeof entry.rev !== "string" || !entry.rev.trim()) continue
    const key = normChip(entry.chip)
    let family = index.get(key)
    if (!family) index.set(key, (family = { chip: entry.chip, manuals: [] }))
    const range = entry.source_page_range
    const pages: [number, number] | undefined =
      Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])
        ? [Number(range[0]), Number(range[1])]
        : undefined
    family.manuals.push({
      rev: entry.rev,
      manual_name: entry.manual_name ?? "",
      kind: entry.kind ?? "",
      covered: expandCoverStems(entry.covered_devices),
      ...(pages ? { pages } : {}),
    })
  }
  return index
}

// 每个成员一个字面量 kind:写成 `"exact" | "family"` 的复合判别字段,TS 在
// `if (kind === "exact" || kind === "family") return` 之后 narrow 不掉剩下那两支。
export type ChipResolution =
  | { kind: "exact"; chip: string }
  | { kind: "family"; chip: string }
  | { kind: "ambiguous"; candidates: string[] }
  /** near = 候选是共享前 3 个字符的家族;false = 一个都不像,候选是全表。 */
  | { kind: "unknown"; candidates: string[]; near: boolean }

export function familyNames(index: Map<string, ChipFamily>): string[] {
  return [...index.values()].map((f) => f.chip).sort()
}

/**
 * 型号 → 家族索引名。三条规则按确定性排序:
 * 1. 归一化后完全相等;
 * 2. **最长**的、是型号前缀的家族名(AT32F421C8T7 → AT32F,STM32F407 → STM32F4,MM32SPIN25 → MM32SPIN)——
 *    这条治的就是"模型拿型号当索引名"这个必然错误;
 * 3. 反过来以它开头的家族(AT32 → AT32A/AT32F/AT32L/…):唯一才用,多个报歧义并列出来
 *    (瞎挑一个等于把"查错了芯片"藏进一份看着正常的输出里)。
 */
export function resolveChip(index: Map<string, ChipFamily>, wanted: string): ChipResolution {
  const want = normChip(wanted)
  if (!want) return { kind: "unknown", candidates: familyNames(index), near: false }
  const exact = index.get(want)
  if (exact) return { kind: "exact", chip: exact.chip }

  let longest = ""
  for (const key of index.keys()) {
    if (want.startsWith(key) && key.length > longest.length) longest = key
  }
  if (longest) return { kind: "family", chip: index.get(longest)!.chip }

  const starts = [...index.entries()].filter(([key]) => key.startsWith(want)).map(([, f]) => f.chip)
  if (starts.length === 1) return { kind: "family", chip: starts[0]! }
  if (starts.length > 1) return { kind: "ambiguous", candidates: starts.sort() }

  // 完全不认识:共享前 3 个字符的家族当候选;一个都没有就给全表(七十来个家族也就几百字)。
  const near = [...index.entries()].filter(([key]) => key.slice(0, 3) === want.slice(0, 3)).map(([, f]) => f.chip)
  return near.length
    ? { kind: "unknown", candidates: near.sort(), near: true }
    : { kind: "unknown", candidates: familyNames(index), near: false }
}

// ─── 分卷 ────────────────────────────────────────────────────────────────────

/** 卷名后缀:`_p<起>-<止>`(原文页)。 */
export const PART_SUFFIX_RE = /_p(\d+)-(\d+)$/

/** `RM0390_p401-800` → `RM0390`;不是卷名返回 undefined。 */
export function splitBase(rev: string): string | undefined {
  return PART_SUFFIX_RE.test(rev) ? rev.replace(PART_SUFFIX_RE, "") : undefined
}

function partStart(rev: string): number {
  const m = PART_SUFFIX_RE.exec(rev)
  return m ? Number(m[1]) : 0
}

export type RevResolution =
  | { kind: "exact"; rev: string }
  | { kind: "parts"; base: string; revs: string[] }
  | { kind: "unknown" }

/**
 * 模型给的 rev → 服务器认的 rev:精确(不分大小写)命中一本就是它;否则当它是分卷的基名,
 * 收齐所有卷按起始页排序;都不是就 unknown(工具壳会把这家族的手册摆出来)。
 */
export function resolveRev(family: ChipFamily, wanted: string): RevResolution {
  const want = wanted.trim().toLowerCase()
  if (!want) return { kind: "unknown" }
  const exact = family.manuals.find((m) => m.rev.toLowerCase() === want)
  if (exact) return { kind: "exact", rev: exact.rev }
  const parts = family.manuals
    .filter((m) => splitBase(m.rev)?.toLowerCase() === want)
    .sort((a, b) => partStart(a.rev) - partStart(b.rev))
  if (parts.length) return { kind: "parts", base: splitBase(parts[0]!.rev)!, revs: parts.map((m) => m.rev) }
  return { kind: "unknown" }
}

export type ManualGroup = {
  /** 单本是它的 rev;分卷是基名。 */
  rev: string
  kind: string
  manual_name: string
  /** 单本时就是它自己一本;分卷时按起始页排好的各卷。 */
  parts: ChipManual[]
}

/** 分卷手册的卷名里带着"(原文第 401–800 页)"这样的尾巴,基名那一行不该带。 */
function stripPageSuffix(name: string): string {
  return name.replace(/\s*[（(]\s*(?:原文第|pages?\s)[^()（）]*[)）]\s*$/i, "").trim()
}

/** 同一基名的卷并成一组,别的手册各成一组;顺序按第一次出现。 */
export function groupManuals(family: ChipFamily): ManualGroup[] {
  const groups: ManualGroup[] = []
  const byBase = new Map<string, ManualGroup>()
  for (const m of family.manuals) {
    const base = splitBase(m.rev)
    if (!base) {
      groups.push({ rev: m.rev, kind: m.kind, manual_name: m.manual_name, parts: [m] })
      continue
    }
    let group = byBase.get(base.toLowerCase())
    if (!group) {
      group = { rev: base, kind: m.kind, manual_name: stripPageSuffix(m.manual_name), parts: [] }
      byBase.set(base.toLowerCase(), group)
      groups.push(group)
    }
    group.parts.push(m)
  }
  for (const group of byBase.values()) group.parts.sort((a, b) => partStart(a.rev) - partStart(b.rev))
  return groups
}

/** 这家族有几本手册(文档数,分卷算一本)。 */
export function manualCount(family: ChipFamily): number {
  return groupManuals(family).length
}

/** `4 manual(s)` 或 `4 manual(s) (14 page-range parts)`。 */
export function manualCountLine(family: ChipFamily): string {
  const docs = manualCount(family)
  const parts = family.manuals.length
  return parts > docs ? `${docs} manual(s) (${parts} page-range parts)` : `${docs} manual(s)`
}

export const GENERAL_CHIP = "GENERAL"

export function formatChipList(index: Map<string, ChipFamily>): string {
  return [...index.values()]
    .sort((a, b) => a.chip.localeCompare(b.chip))
    .map((f) =>
      normChip(f.chip) === GENERAL_CHIP
        ? `${f.chip} (${manualCount(f)}, shared cross-chip bucket — folded into every search without rev)`
        : `${f.chip} (${manualCount(f)})`,
    )
    .join(", ")
}

export function formatFamilyManuals(family: ChipFamily, limit = 60): string {
  const groups = groupManuals(family)
  const rows = groups.slice(0, limit).map((g) => {
    const kind = g.kind ? ` [${g.kind}]` : ""
    if (g.parts.length === 1 && g.parts[0]!.rev === g.rev) return `  rev "${g.rev}"${kind} — ${g.manual_name}`
    const spans = g.parts.map((p) => p.rev.slice(g.rev.length + 1)).join(", ")
    return (
      `  rev "${g.rev}"${kind} — ${g.manual_name}  (split into ${g.parts.length} parts: ${spans}; ` +
      `"${g.rev}" searches all of them, "${g.parts[0]!.rev}" one)`
    )
  })
  const more = groups.length > limit ? `\n  … (+${groups.length - limit} more)` : ""
  return rows.join("\n") + more
}

// ─── 封面型号 ─────────────────────────────────────────────────────────────────

/** 封面模式 → 对归一化型号的正则:分隔符去掉,小写 x 是任意一个字符,其余字符按大写字面匹配。至少 4 个有效字符。 */
export function coverPattern(stem: string): RegExp | undefined {
  let pattern = ""
  let count = 0
  for (const ch of stem) {
    if (!/[A-Za-z0-9]/.test(ch)) continue
    count++
    pattern += ch === "x" ? "." : ch.toUpperCase()
  }
  return count >= 4 ? new RegExp(`^${pattern}`) : undefined
}

/** 封面盖住这个型号的手册:`STM32G081RB` 被 `STM32G081xB` 与 `STM32G0x1` 盖住。 */
export function manualsCovering(family: ChipFamily, part: string): ChipManual[] {
  const want = normChip(part)
  if (want.length < 4) return []
  return family.manuals.filter((m) => m.covered.some((stem) => coverPattern(stem)?.test(want)))
}

export function coveringNote(family: ChipFamily, part: string): string {
  const covering = new Set(manualsCovering(family, part).map((m) => m.rev))
  if (!covering.size) return ""
  const groups = groupManuals(family).filter((g) => g.parts.some((p) => covering.has(p.rev)))
  const rows = groups.slice(0, 8).map((g) => {
    const name = g.manual_name ? ` (${g.manual_name}${g.parts.length > 1 ? `, ${g.parts.length} parts` : ""})` : ""
    return `rev "${g.rev}"${name}`
  })
  const more = groups.length > 8 ? `, … (+${groups.length - 8} more)` : ""
  return `Manuals whose cover lists ${part}: ${rows.join(", ")}${more} — pass one as \`rev\` to pin it.`
}

// ─── 给模型的话 ───────────────────────────────────────────────────────────────

/** chip 认得,但这次查询没从它里面命中任何东西 —— 说清楚,并把这家族的手册摆出来。 */
export function chipMissNote(family: ChipFamily, rev: string | undefined): string {
  const badRev = rev ? resolveRev(family, rev).kind === "unknown" : false
  const head = badRev
    ? `NOTE: no manual with rev "${rev}" exists for chip "${family.chip}" — the rev filter matched nothing, so nothing from your chip was searched.`
    : `NOTE: chip "${family.chip}" IS indexed (${manualCountLine(family)}) but nothing in it outscored the cross-chip GENERAL corpus for this query — the hits below (if any) are NOT from your chip.`
  return [
    head,
    `Manuals indexed for ${family.chip}:`,
    formatFamilyManuals(family),
    `Rephrase the query with the peripheral/register name, or pass one of the revs above.`,
  ].join("\n")
}

/** chip 不是索引名(或指向多个家族)时的候选清单。截断时说明截了多少,别让"Closest"冒充全表。 */
export function chipCandidatesNote(wanted: string, resolution: ChipResolution): string {
  if (resolution.kind === "exact" || resolution.kind === "family") return ""
  const LIMIT = 30
  const shown = resolution.candidates.slice(0, LIMIT).join(", ")
  const rest = resolution.candidates.length - LIMIT
  const more = rest > 0 ? ` (+${rest} more — action "chips" lists all)` : ""
  const head =
    resolution.kind === "ambiguous"
      ? `"${wanted}" matches several indexed families — pick one: ${shown}${more}.`
      : resolution.near
        ? `"${wanted}" is not an indexed chip family. Closest index names: ${shown}${more}.`
        : `"${wanted}" is not an indexed chip family and nothing indexed looks like it. Indexed families${rest > 0 ? ` (first ${LIMIT} of ${resolution.candidates.length})` : ` (${resolution.candidates.length})`}: ${shown}${more}.`
  return [
    head,
    `The corpus is filed by device FAMILY, not by part number (AT32F421C8T7 → "AT32F", STM32F407 → "STM32F4", CH32V307 → "CH32V").`,
    `Use action "chips" for the whole family list, or action "chips" with \`chip\` for one family's manuals.`,
  ].join("\n")
}

/** chip 根本不是索引名 —— 不搜,把候选摆出来,让下一次调用就对。 */
export function unknownChipHelp(wanted: string, resolution: ChipResolution): string {
  const candidates = chipCandidatesNote(wanted, resolution)
  if (!candidates) return ""
  return `NO SEARCH PERFORMED — searching an unknown chip returns cross-chip GENERAL prose that reads like an answer but is not about your part.\n${candidates}`
}
