/**
 * datasheet 工具的契约:菜单那一半。
 *
 * 数据手册 RAG 的四个动作合一:search(检索 + 引用)/ read_section(整节原文)/ view_figure(看图)/
 * chips(服务器收录了什么)。完全在线、零本地状态:检索、解析文本、图片全部按需从数据手册服务器读
 * (地址解析在 `host/datasheet-server.ts`,内置默认是维护者的公共服务器,装完即用)。
 *
 * 门规同 flash / log / la / gdb:只许 import typebox 与工具目录内的相对路径。章节抽取、引用格式、芯片 /
 * 分卷解析在 `host/domain/datasheet`;这个文件只说"收什么、给什么"。
 *
 * 【没有确认门】四个动作都只读:发出去的只有查询语句和芯片名,不碰这台机器、不碰目标板。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

export const DATASHEET_ACTIONS = ["search", "read_section", "view_figure", "chips"] as const
export type DatasheetAction = (typeof DATASHEET_ACTIONS)[number]

/** search 的 topK:默认 6,夹到 1..20(20 是服务器自己的上限;数字与下面 description 同源,测试钉着)。 */
export const DEFAULT_TOP_K = 6
export const MAX_TOP_K = 20
/** read_section 的输出上限:默认 12000,夹到 1000..40000。 */
export const DEFAULT_MAX_CHARS = 12_000
export const MIN_MAX_CHARS = 1_000
export const MAX_MAX_CHARS = 40_000

const datasheetParameters = Type.Object({
  // 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
  action: Type.Union(
    [Type.Literal("search"), Type.Literal("read_section"), Type.Literal("view_figure"), Type.Literal("chips")],
    {
      description:
        "search = RAG retrieval with citations | read_section = full manual section | view_figure = see a figure image | chips = list the indexed chip families (and one family's manuals)",
    },
  ),
  query: Type.Optional(
    Type.String({
      description: "search: natural-language manual question to retrieve chunks for. Required for search.",
    }),
  ),
  keywords: Type.Optional(
    Type.String({
      description:
        'search: one line of ENGLISH keywords for the same question — peripheral, register, signal and parameter names, space-separated, e.g. "USART baud rate USARTDIV BRR mantissa fraction". Pass this on every search: the manuals are mostly English and the server\'s keyword (BM25) retrieval depends on it. Identifiers such as USART_BRR or TIMx_CNT are ideal. Ignored by legacy v1 servers.',
    }),
  ),
  chip: Type.Optional(
    Type.String({
      description:
        'search: the chip you mean — exact part number or family, e.g. "STM32F407VG", "STM32F4", "AT32F421C8T7". On v2 servers it is passed verbatim as scope.targets and the server resolves part → family → volumes (refusing with candidates when it cannot). On legacy v1 servers the tool resolves the family name itself. Required for search. | chips: optional — list just this chip\'s/family\'s manuals.',
    }),
  ),
  rev: Type.Optional(
    Type.String({
      description:
        'search: manual / document ID, e.g. "RM0390" or "AT32F421_DS" (see chips). On v2 servers it is passed as scope.docs and the server unfolds page-range parts (a citation\'s `rev` is already the document ID to pass back). On legacy v1 servers the tool expands a base name such as "RM0390" across its page-range parts. Omit to search the whole resolved scope.',
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      description: `search: number of chunks to return (default ${DEFAULT_TOP_K}, clamped 1..${MAX_TOP_K})`,
    }),
  ),
  parsedPath: Type.Optional(
    Type.String({
      description:
        'read_section: the hit\'s parsed_path (a.k.a. "source:"), e.g. "parsed/STM32F1/RM0008.md". Required for read_section.',
    }),
  ),
  heading: Type.Optional(
    Type.String({
      description:
        "read_section: the hit's headings breadcrumb or a section title/number. Omit for a table of contents.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: `read_section: output cap (default ${DEFAULT_MAX_CHARS}, clamped ${MIN_MAX_CHARS}..${MAX_MAX_CHARS}).`,
    }),
  ),
  imagePath: Type.Optional(
    Type.String({
      description:
        'view_figure: a [FIGURE] hit\'s image_path, e.g. "figures/STM32F1/RM0008/RM0008-F2.png". Required for view_figure.',
    }),
  ),
  caption: Type.Optional(
    Type.String({ description: "view_figure: the figure caption, echoed as text alongside the image for citation." }),
  ),
})

export type DatasheetInput = Static<typeof datasheetParameters>

export interface DatasheetHitSummary {
  manual_name: string
  chip: string
  rev: string
  page: number
  headings: string
  score: number
  parsed_path: string
  image_path: string
  source_pdf: string
  /** v2: 服务端名次、命中理由、文档身份与适用范围。v1 不填。 */
  rank?: number
  reasons?: string[]
  doc_id?: string
  doc_uid?: string
  targets?: string[]
  /** v2: 分片的 v1 卷名(`RM0390_p401-800`),仅作来源信息;search 的 rev 用 doc_id。 */
  legacyRev?: string
  /** v2: 服务端在 detail:"concise" 下截短了 chunk.text。 */
  textTruncated?: boolean
}

export interface DatasheetDetails {
  action: DatasheetAction
  /** 实际用的接口版本(auto 模式可能回落)。 */
  apiVersion?: "v1" | "v2"
  /** v2 在 auto 模式下没有 v2 接口、回落到 v1 时填 "v2-missing"。 */
  fallback?: string
  chip?: string
  /** search: 入参 chip 是型号 / 别的写法时,实际搜的那个家族索引名(相等时不填)。v1 only — v2 的范围由服务端解析,见 scope。 */
  resolvedChip?: string
  rev?: string
  /** search: v2 的关键词行(原样回显,便于核对服务端收到的是什么)。 */
  keywords?: string
  /** search: rev 是分卷基名时实际搜过的各卷;精确 rev 换了名时也填。v1 only。 */
  searchedRevs?: string[]
  topK?: number
  /** search(v2):服务端解析出来的实际范围。 */
  scope?: { targets: string[]; docs: string[]; ladder: string; fields: Record<string, string | string[]> }
  /** search(v2):rerank / dense / sparse / ident 等降级原因。 */
  degraded?: string[]
  /** search(v2):索引代际。 */
  generation?: number
  /** v2 错误:服务端错误码与 scope_unresolved 的候选。 */
  errorCode?: string
  candidates?: string[]
  /** chips: 索引里的家族数 / 手册数。 */
  families?: number
  manuals?: number
  hits?: DatasheetHitSummary[]
  parsedPath?: string
  /** read_section:整本 / 目录 / 一节 / 围绕短语的文本窗口。 */
  mode?: "full" | "toc" | "section" | "window"
  heading?: string
  level?: number
  /** read_section(section):1 起的 [起, 止) 行号。 */
  lines?: [number, number]
  chars?: number
  sections?: number
  truncated?: boolean
  imagePath?: string
  /** view_figure:真正附上去的 mime(大图可能被重编码)。 */
  mime?: string
  /** view_figure:服务器上那份的字节数。 */
  bytes?: number
}

const DATASHEET_DESCRIPTION = `Chip datasheet / reference-manual assistant backed by a datasheet server: RAG search with citations, full-section reading, and figure viewing. Everything is fetched on demand from the server — nothing is stored locally.

Actions:
- search (query, chip, [keywords, rev, topK]): retrieval-only search over indexed manual PROSE. Returns the top matching RAW chunks WITH citations (manual name, page, section breadcrumb, score — plus the server's reasons on v2). It does NOT answer the question — read the chunks and write the answer yourself, citing page/section.
- read_section (parsedPath, [heading, maxChars]): search chunks are short (~512 tokens). To read the COMPLETE section behind a hit (a full register table, a complete procedure, adjacent bitfields), pass the hit's parsed_path and headings breadcrumb; a numbered section runs to the next numbered heading of equal or shallower depth (bit-field and note lines in between belong to it). The reply names the heading it actually matched when it is not the one you asked for. Omit heading for a table of contents (numbered sections only).
- view_figure (imagePath, [caption]): for hits marked [FIGURE] the chunk text is only the caption — pass the hit's image_path to SEE the figure (clock tree, block diagram, memory map, timing diagram, pinout) whenever the answer depends on the diagram itself.
- chips ([chip]): what the server actually holds. With no argument: every indexed chip FAMILY with its manual count. With \`chip\`: that chip's manuals, each with the \`rev\` to pass to search. One call — never go probing the server's HTTP API by hand.

Search rules:
- ALWAYS pass \`keywords\`: one line of English keywords for the same question — peripheral, register, signal and parameter names, space-separated. The manuals are mostly English while the question may be Chinese, and the server's keyword (BM25) retrieval depends on these. Example: query "USART 波特率分频怎么算" → keywords "USART baud rate USARTDIV BRR mantissa fraction". Identifiers such as USART_BRR or TIMx_CNT are ideal.
- Pass \`chip\` as the part number or family you actually mean: "STM32F407VG" and "STM32F4" are both accepted, as are "AT32F421C8T7" and "AT32F". A v2 server resolves part number → family → volumes itself and reports the scope it actually used; when it cannot resolve the name it refuses with candidates instead of guessing. Do NOT hand-map a part to a family first. On legacy v1 servers the tool resolves the family name for you and says which name it used.
- Pass \`rev\` (e.g. "RM0390", "AT32F421_DS") to pin one manual. On v2 it is the server-side document scope (scope.docs) and the server unfolds page-range parts; a hit's \`rev\` is already the document ID to pass back. On legacy v1 servers the tool expands a base name such as "RM0390" across its page-range parts. Omit \`rev\` to search the whole resolved scope.
- The corpus is MULTI-VENDOR and largely Chinese-language (ST, Artery 雅特力, GigaDevice 兆易创新, WCH 沁恒, MindMotion 灵动, Nations 国民技术, HDSC 华大, HK 航顺, Geehy 极海, Nordic, Espressif …). Never conclude a part is not indexed because it is not an STM32, and never conclude it from one failed search — check with action "chips".
- On v2 servers the reply states the scope the server actually used and any degradation (rerank / dense / sparse / ident). If the ladder shows a wider scope than your requested target, the server widened the search: treat those hits as evidence about the wider scope, not as facts about your exact part. A note that every hit is GENERAL means the same thing.
- On legacy v1 servers, a reply where EVERY citation is tagged [GENERAL] means nothing from your chip matched: that is a miss, not an answer. The tool says so explicitly — re-read the note instead of quoting those chunks at the user.
- Scores are only comparable WITHIN one response. v2 fuses and reranks; never compare a score from one search with a score from another.
- If the server has no v2 API at all (HTTP 404/405), the tool falls back to legacy v1 and says so in the reply. A 422 (unresolved scope / bad request) or 503 (index unavailable) from v2 is a real v2 answer — never retry it as v1.
- Citations are prefixed with tags that classify the hit (they may combine): \`[GENERAL]\` = cross-chip corpus; \`[SCHEMATIC]\` / \`[TUTORIAL]\` / \`[REFERENCE]\` = the chunk's kind; \`[FIGURE]\` = has an image. Treat tags as context, not as a filter.
- Use search before answering any register-level or peripheral-behavior question — do not answer such questions from memory. Phrase \`query\` as a natural-language question ("How is the USART baud rate divider calculated?") and put the English terms in \`keywords\`; if results miss, rephrase with the peripheral/register name or raise topK.
- Exact register/bitfield/address/reset VALUES quoted in prose are contextual, not authoritative — read the register table itself with read_section before quoting a value; for chips the stm32config tool covers, its generated output is authoritative for configuration values.
- When stm32config is available and covers the chip, use \`stm32config describe-mcu\` for alternate functions, ADC/timer channels, and package pinout from the local device database; read its full output file if the preview is truncated. Otherwise search the manuals here.
- If the answer is not in the returned chunks, say so honestly — never fabricate manual content.
- If this tool reports lookup unavailable (no server, unreachable, HTTP error): do NOT invent registers, electrical ratings, or peripheral behavior from memory. Tell the user manuals cannot be queried and they can point YOMA_DATASHEET_SERVER at a datasheet server (self-hosted is fine) or read the PDF themselves.
- Requires network access to a datasheet server (built-in public server by default; YOMA_DATASHEET_SERVER overrides it). YOMA_DATASHEET_API=auto|v1|v2 selects the API version (default auto).`

export const DATASHEET_CONTRACT = {
  name: "datasheet",
  label: "数据手册",
  description: DATASHEET_DESCRIPTION,
  parameters: datasheetParameters,
  guidelines: [
    "Before answering any register-level or peripheral-behavior question, search the indexed manuals with the datasheet tool and cite page/section. Every search takes a natural-language query plus one line of English keywords (the manuals are mostly English). If the tool says lookup is unavailable or unreachable, do not invent those facts from memory — tell the user manuals cannot be queried.",
    'The manual corpus is multi-vendor (ST, Artery, GigaDevice, WCH, MindMotion, Nations, HDSC, Nordic, Espressif, …). v2 servers resolve part numbers, families and volumes themselves; legacy v1 indexes are filed by device FAMILY. Never tell the user a chip is missing from it on the strength of a failed search — run the datasheet tool\'s "chips" action and read the actual index first.',
  ],
  summary: datasheetSummary,
} as const satisfies ToolContract<typeof datasheetParameters>

/** 卡片副标题 / 确认条那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function datasheetSummary(input: Partial<DatasheetInput>): string {
  switch (input.action) {
    case "search": {
      const scope = input.chip ? ` ${input.chip}${input.rev ? `/${input.rev}` : ""}` : ""
      const query = input.query?.trim()
      return `search${scope}${query ? ` "${query.length > 60 ? `${query.slice(0, 57)}…` : query}"` : ""}`
    }
    case "chips":
      return input.chip ? `chips ${input.chip}` : "chips"
    case "read_section":
      return `read_section${input.parsedPath ? ` ${input.parsedPath}` : ""}${input.heading ? ` › ${input.heading}` : ""}`
    case "view_figure":
      return `view_figure${input.imagePath ? ` ${input.imagePath}` : ""}`
    default:
      return ""
  }
}
