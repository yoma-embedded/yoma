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
  chip: Type.Optional(
    Type.String({
      description:
        'search: target chip FAMILY as indexed, e.g. "STM32F4" (not "STM32F405") or "AT32F" (not "AT32F421C8T7"). Required for search — the corpus is multi-chip; a part number is resolved to its family when possible, and refused with candidates when not. | chips: optional — list just this family\'s manuals.',
    }),
  ),
  rev: Type.Optional(
    Type.String({
      description:
        'search: manual revision, e.g. "RM0390" or "AT32F421_DS" (see chips). Large manuals are split into page-range parts ("RM0390_p401-800"); the base name searches every part. Omit to search all revisions for the chip.',
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
}

export interface DatasheetDetails {
  action: DatasheetAction
  chip?: string
  /** search: 入参 chip 是型号 / 别的写法时,实际搜的那个家族索引名(相等时不填)。 */
  resolvedChip?: string
  rev?: string
  /** search: rev 是分卷基名时实际搜过的各卷;精确 rev 换了名时也填。 */
  searchedRevs?: string[]
  topK?: number
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
- search (query, chip, [rev, topK]): retrieval-only search over indexed manual PROSE. Returns the top matching RAW chunks WITH citations (manual name, page, section breadcrumb, score). It does NOT answer the question — read the chunks and write the answer yourself, citing page/section.
- read_section (parsedPath, [heading, maxChars]): search chunks are short (~512 tokens). To read the COMPLETE section behind a hit (a full register table, a complete procedure, adjacent bitfields), pass the hit's parsed_path and headings breadcrumb; a numbered section runs to the next numbered heading of equal or shallower depth (bit-field and note lines in between belong to it). The reply names the heading it actually matched when it is not the one you asked for. Omit heading for a table of contents (numbered sections only).
- view_figure (imagePath, [caption]): for hits marked [FIGURE] the chunk text is only the caption — pass the hit's image_path to SEE the figure (clock tree, block diagram, memory map, timing diagram, pinout) whenever the answer depends on the diagram itself.
- chips ([chip]): what the server actually holds. With no argument: every indexed chip FAMILY with its manual count. With \`chip\`: that family's manuals, each with the \`rev\` to pass to search. One call — never go probing the server's HTTP API by hand.

Search rules:
- Always pass \`chip\` as the manual's device FAMILY as indexed (the corpus is multi-chip): STM32F405/407/427/429 → "STM32F4", AT32F421C8T7 → "AT32F", CH32V307 → "CH32V" — NOT the exact part number. A part number is resolved to its family automatically and the reply tells you the name to use; when it cannot be resolved the tool refuses to search and lists the candidates.
- Pass \`rev\` (e.g. "RM0390", "AT32F421_DS") when you know it; if omitted, all revisions for that chip are searched and each citation shows its source rev. Big manuals are stored as page-range parts ("RM0390_p401-800"): passing the base name ("RM0390") searches every part and merges the results.
- The corpus is MULTI-VENDOR and largely Chinese-language (ST, Artery 雅特力, GigaDevice 兆易创新, WCH 沁恒, MindMotion 灵动, Nations 国民技术, HDSC 华大, HK 航顺, Geehy 极海, Nordic, Espressif …). Never conclude a part is not indexed because it is not an STM32, and never conclude it from one failed search — check with action "chips".
- A reply where EVERY citation is tagged [GENERAL] means nothing from your chip matched: that is a miss, not an answer. The tool says so explicitly when it happens — re-read the note instead of quoting those chunks at the user.
- When you omit \`rev\`, a shared GENERAL corpus (cross-chip material: Cortex-M core manuals, schematic conventions, tutorials) is automatically folded in. Do NOT pass \`chip: "GENERAL"\` yourself.
- Citations are prefixed with tags that classify the hit (they may combine): \`[GENERAL]\` = cross-chip corpus; \`[SCHEMATIC]\` / \`[TUTORIAL]\` / \`[REFERENCE]\` = the chunk's kind; \`[FIGURE]\` = has an image. Treat tags as context, not as a filter.
- Use search before answering any register-level or peripheral-behavior question — do not answer such questions from memory. Phrase queries the way the manual would: "TIM1 PWM output mode configuration" beats "how to blink motor"; if results miss, rephrase with the peripheral/register name or raise topK.
- Exact register/bitfield/address/reset VALUES quoted in prose are contextual, not authoritative — read the register table itself with read_section before quoting a value.
- If the answer is not in the returned chunks, say so honestly — never fabricate manual content.
- If this tool reports lookup unavailable (no server, unreachable, HTTP error): do NOT invent registers, electrical ratings, or peripheral behavior from memory. Tell the user manuals cannot be queried and they can point YOMA_DATASHEET_SERVER at a datasheet server (self-hosted is fine) or read the PDF themselves.
- Requires network access to a datasheet server (built-in public server by default; YOMA_DATASHEET_SERVER overrides it).`

export const DATASHEET_CONTRACT = {
  name: "datasheet",
  label: "数据手册",
  description: DATASHEET_DESCRIPTION,
  parameters: datasheetParameters,
  guidelines: [
    "Before answering any register-level or peripheral-behavior question, search the indexed manuals with the datasheet tool and cite page/section. If the tool says lookup is unavailable or unreachable, do not invent those facts from memory — tell the user manuals cannot be queried.",
    'The manual corpus is multi-vendor (ST, Artery, GigaDevice, WCH, MindMotion, Nations, HDSC, Nordic, Espressif, …) and filed by device FAMILY, not by part number. Never tell the user a chip is missing from it on the strength of a failed search — run the datasheet tool\'s "chips" action and read the actual index first.',
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
