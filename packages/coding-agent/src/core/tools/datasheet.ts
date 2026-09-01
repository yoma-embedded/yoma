/**
 * datasheet 工具:数据手册 RAG 的三个动作合一(search / read_section / view_figure)。
 *
 * 【架构】完全在线,零本地状态:检索、解析文本、图片全部按需从数据手册
 * 文件服务器读取(YOMA_DATASHEET_SERVER,配置在环境变量里)。没有内置服务器。
 * 客户端不落索引、不落产物、不需要 SiliconFlow key —— embedding 与向量检索
 * 都是服务器的事。本机唯一的配置就是服务器地址。
 *
 * - search:       POST {server}/api/search
 *                 请求 { query, chip, rev?, top_k }
 *                 响应 { hits: [{ text, manual_name, chip, rev, page, headings,
 *                                 score, kind, source_pdf, parsed_path, image_path }] }
 *                 服务器端 bge-m3 + Lance;端点尚未上线时返回引导信息
 * - read_section: GET {server}/artifacts/<parsed_path> + 本文件内的 markdown 章节抽取
 * - view_figure:  GET {server}/artifacts/<image_path> → ImageContent(模型直接读图)
 * - chips:        GET {server}/api/manifest → 索引里有哪些芯片家族、每个家族有哪些手册
 *
 * 前身是从 yoma 移植的四个本地工具(datasheet_search/read_manual_section/
 * view_figure/download_manual + datasheet/ lib);按"不走本地"的决定合并重写,
 * download_manual(物化本地缓存)随之删除。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import { clamp } from "./engines.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

/** 数据手册文件服务器基址。 */
export function serverUrl(): string | undefined {
	return process.env["YOMA_DATASHEET_SERVER"]?.trim().replace(/\/+$/, "") || undefined;
}

export function encodeRel(rel: string): string {
	return rel.split("/").map(encodeURIComponent).join("/");
}

// ─── markdown 章节抽取(纯逻辑,原 yoma datasheet/section.ts 逐字保留) ────────

export type Heading = { level: number; title: string; line: number };

export function norm(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseHeadings(lines: string[]): Heading[] {
	const out: Heading[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
		if (m) out.push({ level: m[1].length, title: m[2], line: i });
	}
	return out;
}

// " > " 面包屑里最具体的一段
export function lastSegment(heading: string): string {
	const parts = heading
		.split(">")
		.map((p) => p.trim())
		.filter(Boolean);
	return parts.length ? parts[parts.length - 1] : heading.trim();
}

// 逐级放宽容错找最匹配的标题:精确 -> 前缀 -> 包含。
export function matchHeading(headings: Heading[], wanted: string): number {
	const w = norm(wanted);
	if (!w) return -1;
	let idx = headings.findIndex((h) => norm(h.title) === w);
	if (idx < 0) idx = headings.findIndex((h) => norm(h.title).startsWith(w) || w.startsWith(norm(h.title)));
	if (idx < 0) idx = headings.findIndex((h) => norm(h.title).includes(w) || w.includes(norm(h.title)));
	return idx;
}

export function tableOfContents(headings: Heading[], limit = 300): string {
	const rows = headings.slice(0, limit).map((h) => `${"#".repeat(h.level)} ${h.title}`);
	const more = headings.length > limit ? `\n… (+${headings.length - limit} more headings)` : "";
	return rows.join("\n") + more;
}

export function capped(text: string, maxChars: number): { out: string; truncated: boolean } {
	if (text.length <= maxChars) return { out: text, truncated: false };
	return {
		out: text.slice(0, maxChars) + `\n\n… [truncated at ${maxChars} chars — raise maxChars or narrow by heading]`,
		truncated: true,
	};
}

// 空白容错的短语搜索,返回【最后】一次出现 —— 章节标题第一次出现的多半是目录项。
export function findPhrase(raw: string, wanted: string): number {
	const tokens = norm(wanted).split(" ").filter(Boolean);
	if (!tokens.length) return -1;
	const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
	const re = new RegExp(pattern, "gi");
	let at = -1;
	for (let m = re.exec(raw); m; m = re.exec(raw)) at = m.index;
	return at;
}

// 章节 = 匹配标题起,到下一个同级或更高级标题止。
export function sectionRange(headings: Heading[], idx: number, totalLines: number): [number, number] {
	const start = headings[idx].line;
	const level = headings[idx].level;
	for (let j = idx + 1; j < headings.length; j++) {
		if (headings[j].level <= level) return [start, headings[j].line];
	}
	return [start, totalLines];
}

// ─── 命中与引用格式化(原 yoma datasheet/rerank.ts 的格式化部分) ─────────────

/** /api/search 返回的单条命中(字段与 rag_yoma 的 11 列 chunks 表一致)。 */
export type SearchHit = {
	text: string;
	manual_name: string;
	chip: string;
	rev: string;
	page: number;
	headings: string;
	score: number;
	kind: string;
	source_pdf: string;
	parsed_path: string;
	image_path: string;
};

// 引用标签,三类正交、可叠加:[GENERAL](通用语料桶)、[SCHEMATIC]/[TUTORIAL]/
// [REFERENCE](kind 标注)、[FIGURE](带配图,正文只是图注)。
function citationTags(h: SearchHit): string {
	const tags: string[] = [];
	if (h.chip === "GENERAL") tags.push("[GENERAL]");
	if (h.kind === "schematic" || h.kind === "tutorial" || h.kind === "reference") tags.push(`[${h.kind.toUpperCase()}]`);
	if (h.image_path) tags.push("[FIGURE]");
	return tags.length ? "  " + tags.join(" ") : "";
}

export function formatCitation(h: SearchHit, i: number): string {
	const tag = citationTags(h);
	// `page` is 0 for page-less formats (md/docx/txt) - show p.X only when real.
	// Same logic as rag_yoma/query.py format_citation (同解纪律).
	const page = h.page > 0 ? ` p.${h.page}` : "";
	let out = `[#${i + 1}]${tag} ${h.manual_name} (${h.chip})${page} | ${h.headings}  (score ${h.score.toFixed(2)})\n${h.text}`;
	if (h.image_path) out += `\n   figure: ${h.image_path}`;
	if (h.parsed_path) out += `\n   source: ${h.parsed_path}  (action "read_section" for the full section)`;
	return out;
}

// ─── 芯片索引(/api/manifest 的家族视图) ─────────────────────────────────────
//
// 服务器按**家族**归档(`AT32F`、`STM32F4`、`MM32SPIN`),而模型手上永远是具体型号
// (`AT32F421C8T7`)。猜错家族名时服务器**不报错**:chip 过滤匹配不到任何手册,它照样
// 200 返回 GENERAL 语料的命中,分数还挺高(0.5~0.68)。实测代价(2026-09-01 一次真会话):
// 模型试了 AT32F421 / AT32 / AT32F4 / AT32F421xx 共 11 次 search 全部落空,据此告诉用户
// "服务器没收录这颗芯片" —— 而它收录了 16 本雅特力手册,索引名就是 `AT32F`;用户随后
// 得自己 curl 六轮 API 才把 /api/manifest 挖出来。三分钟,零结果。
//
// 所以自己兜住三件事:①一条目标家族的命中都没有时,拉一次 manifest 把型号解析成家族名
// 重查;②解析不出来就**明说不认识**并给候选,绝不让 GENERAL 噪声冒充答案;③给一个
// `chips` 动作,让"服务器都收录了什么"变成一次调用而不是一场考古。

export type ManifestEntry = {
	chip: string;
	rev: string;
	manual_name?: string;
	kind?: string;
	num_chunks?: number;
};

export type ChipFamily = { chip: string; manuals: { rev: string; manual_name: string; kind: string }[] };

/** 归一化:大写 + 去掉分隔符 —— `ESP32-S3`、`esp32 s3`、`ESP32_S3` 是同一个家族。 */
export function normChip(s: string): string {
	return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function buildChipIndex(entries: ManifestEntry[]): Map<string, ChipFamily> {
	const index = new Map<string, ChipFamily>();
	for (const entry of entries) {
		if (!entry || typeof entry.chip !== "string" || !entry.chip.trim()) continue;
		const key = normChip(entry.chip);
		let family = index.get(key);
		if (!family) index.set(key, (family = { chip: entry.chip, manuals: [] }));
		family.manuals.push({ rev: entry.rev ?? "", manual_name: entry.manual_name ?? "", kind: entry.kind ?? "" });
	}
	return index;
}

// 每个成员一个字面量 kind:写成 `"exact" | "family"` 的复合判别字段,TS 在
// `if (kind === "exact" || kind === "family") return` 之后 narrow 不掉剩下那两支。
export type ChipResolution =
	| { kind: "exact"; chip: string }
	| { kind: "family"; chip: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "unknown"; candidates: string[] };

function familyNames(index: Map<string, ChipFamily>): string[] {
	return [...index.values()].map((f) => f.chip).sort();
}

/**
 * 型号 → 家族索引名。三条规则按确定性排序:
 * 1. 归一化后完全相等;
 * 2. **最长**的、是型号前缀的家族名(AT32F421C8T7 → AT32F,STM32F407 → STM32F4,
 *    MM32SPIN25 → MM32SPIN)—— 这条治的就是"模型拿型号当索引名"这个必然错误;
 * 3. 反过来以它开头的家族(AT32 → AT32A/AT32F/AT32L/…):唯一才用,多个报歧义并列出来
 *    (瞎挑一个等于把"查错了芯片"藏进一份看着正常的输出里)。
 */
export function resolveChip(index: Map<string, ChipFamily>, wanted: string): ChipResolution {
	const want = normChip(wanted);
	if (!want) return { kind: "unknown", candidates: familyNames(index) };
	const exact = index.get(want);
	if (exact) return { kind: "exact", chip: exact.chip };

	let longest = "";
	for (const key of index.keys()) {
		if (want.startsWith(key) && key.length > longest.length) longest = key;
	}
	if (longest) return { kind: "family", chip: index.get(longest)!.chip };

	const starts = [...index.entries()].filter(([key]) => key.startsWith(want)).map(([, f]) => f.chip);
	if (starts.length === 1) return { kind: "family", chip: starts[0] };
	if (starts.length > 1) return { kind: "ambiguous", candidates: starts.sort() };

	// 完全不认识:共享前 3 个字符的家族当候选;一个都没有就给全表(七十来个家族也就几百字)。
	const near = [...index.entries()].filter(([key]) => key.slice(0, 3) === want.slice(0, 3)).map(([, f]) => f.chip);
	return { kind: "unknown", candidates: near.length ? near.sort() : familyNames(index) };
}

export function formatChipList(index: Map<string, ChipFamily>): string {
	return [...index.values()]
		.sort((a, b) => a.chip.localeCompare(b.chip))
		.map((f) => `${f.chip} (${f.manuals.length})`)
		.join(", ");
}

export function formatFamilyManuals(family: ChipFamily, limit = 60): string {
	const rows = family.manuals
		.slice(0, limit)
		.map((m) => `  rev "${m.rev}"${m.kind ? ` [${m.kind}]` : ""} — ${m.manual_name}`);
	const more = family.manuals.length > limit ? `\n  … (+${family.manuals.length - limit} more)` : "";
	return rows.join("\n") + more;
}

/** chip 认得,但这次查询没从它里面命中任何东西 —— 说清楚,并把这家族的手册摆出来。 */
export function chipMissNote(family: ChipFamily, rev: string | undefined): string {
	const badRev = rev ? !family.manuals.some((m) => m.rev.toLowerCase() === rev.trim().toLowerCase()) : false;
	const head = badRev
		? `NOTE: no manual with rev "${rev}" exists for chip "${family.chip}" — the rev filter matched nothing, so the hits below are NOT from your chip.`
		: `NOTE: chip "${family.chip}" IS indexed (${family.manuals.length} manual(s)) but nothing in it matched this query — every hit below comes from the cross-chip GENERAL corpus, not from your chip.`;
	return [
		head,
		`Manuals indexed for ${family.chip}:`,
		formatFamilyManuals(family),
		`Rephrase the query with the peripheral/register name, or pass one of the revs above.`,
	].join("\n");
}

/** chip 不是索引名(或指向多个家族)时的候选清单。 */
export function chipCandidatesNote(wanted: string, resolution: ChipResolution): string {
	if (resolution.kind === "exact" || resolution.kind === "family") return "";
	const head =
		resolution.kind === "ambiguous"
			? `"${wanted}" matches several indexed families — pick one: ${resolution.candidates.join(", ")}.`
			: `"${wanted}" is not an indexed chip family. Closest index names: ${resolution.candidates.slice(0, 30).join(", ")}.`;
	return [
		head,
		`The corpus is filed by device FAMILY, not by part number (AT32F421C8T7 → "AT32F", STM32F407 → "STM32F4", CH32V307 → "CH32V").`,
		`Use action "chips" for the whole family list, or action "chips" with \`chip\` for one family's manuals.`,
	].join("\n");
}

/** chip 根本不是索引名 —— 不搜,把候选摆出来,让下一次调用就对。 */
export function unknownChipHelp(wanted: string, resolution: ChipResolution): string {
	const candidates = chipCandidatesNote(wanted, resolution);
	if (!candidates) return "";
	return `NO SEARCH PERFORMED — searching an unknown chip returns cross-chip GENERAL prose that reads like an answer but is not about your part.\n${candidates}`;
}

// 进程内缓存:manifest 是 ~2 MB / 350+ 本,一个内核进程拉一次够了。给 TTL 是因为语料会长
// (服务器 2026-09-01 一次就从 96 本涨到 352 本),长跑的会话不该一直看着开机那一刻的表。
const CHIP_INDEX_TTL_MS = 10 * 60 * 1000;
let chipIndexCache: { server: string; at: number; index: Map<string, ChipFamily> } | undefined;

/** 测试用:清掉进程内的芯片索引缓存。 */
export function resetChipIndexCache(): void {
	chipIndexCache = undefined;
}

// 这两个曾经是 engines.ts clamp() 的逐字重写(gdb/log 早就在用那一份)。改成委托,
// 但**函数留着**:它们是导出的,而 test/datasheet.test.ts 那六条断言是全仓唯一钉住
// 这四个数字的地方 —— 同样的数字还写在下面 schema 的 description 里给模型看,删了闸门
// 两边就能静默对不上。

/** search 的 topK:默认 6,夹到 1..20(数字与 schema description 同源)。 */
export function clampTopK(n: number | undefined): number {
	return clamp(n, 6, 1, 20);
}

/** read_section 的输出上限:默认 12000,夹到 1000..40000。 */
export function clampChars(n: number | undefined): number {
	return clamp(n, 12000, 1000, 40000);
}

// ─── 工具定义 ────────────────────────────────────────────────────────────────

const datasheetSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
	action: Type.Union(
		[Type.Literal("search"), Type.Literal("read_section"), Type.Literal("view_figure"), Type.Literal("chips")],
		{
			description:
				"search = RAG retrieval with citations | read_section = full manual section | view_figure = see a figure image | chips = list the indexed chip families (and one family's manuals)",
		},
	),
	query: Type.Optional(
		Type.String({ description: "search: natural-language manual question to retrieve chunks for. Required for search." }),
	),
	chip: Type.Optional(
		Type.String({
			description:
				'search: target chip FAMILY as indexed, e.g. "STM32F4" (not "STM32F405") or "AT32F" (not "AT32F421C8T7"). Required for search — the corpus is multi-chip; a part number is resolved to its family when possible, and refused with candidates when not. | chips: optional — list just this family\'s manuals.',
		}),
	),
	rev: Type.Optional(
		Type.String({ description: 'search: manual revision, e.g. "RM0090". Omit to search all revisions for the chip.' }),
	),
	topK: Type.Optional(Type.Number({ description: "search: number of chunks to return (default 6, clamped 1..20)" })),
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
	maxChars: Type.Optional(Type.Number({ description: "read_section: output cap (default 12000, clamped 1000..40000)." })),
	imagePath: Type.Optional(
		Type.String({
			description:
				'view_figure: a [FIGURE] hit\'s image_path, e.g. "figures/STM32F1/RM0008/RM0008-F2.png". Required for view_figure.',
		}),
	),
	caption: Type.Optional(
		Type.String({ description: "view_figure: the figure caption, echoed as text alongside the image for citation." }),
	),
});

export type DatasheetToolInput = Static<typeof datasheetSchema>;

export interface DatasheetToolDetails {
	action: "search" | "read_section" | "view_figure" | "chips";
	chip?: string;
	/** search: 入参 chip 是型号时,实际搜的那个家族索引名(相等时不填)。 */
	resolvedChip?: string;
	rev?: string;
	topK?: number;
	/** chips: 索引里的家族数 / 手册数。 */
	families?: number;
	manuals?: number;
	hits?: Pick<SearchHit, "manual_name" | "page" | "headings" | "score" | "parsed_path" | "image_path" | "source_pdf">[];
	parsedPath?: string;
	mode?: string;
	heading?: string;
	level?: number;
	lines?: number[];
	chars?: number;
	sections?: number;
	truncated?: boolean;
	imagePath?: string;
	mime?: string;
	bytes?: number;
}

// Docling 裁图是 PNG;其余 web 图片 mime 防御性接受。
export const FIGURE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const MAX_FIGURE_BYTES = 8 * 1024 * 1024;

const DESCRIPTION = `Chip datasheet / reference-manual assistant backed by a datasheet server: RAG search with citations, full-section reading, and figure viewing. Everything is fetched on demand from the server — nothing is stored locally.

Actions:
- search (query, chip, [rev, topK]): retrieval-only search over indexed manual PROSE. Returns the top matching RAW chunks WITH citations (manual name, page, section breadcrumb, score). It does NOT answer the question — read the chunks and write the answer yourself, citing page/section.
- read_section (parsedPath, [heading, maxChars]): search chunks are short (~512 tokens). To read the COMPLETE section behind a hit (a full register table, a complete procedure, adjacent bitfields), pass the hit's parsed_path and headings breadcrumb. Omit heading for a table of contents.
- view_figure (imagePath, [caption]): for hits marked [FIGURE] the chunk text is only the caption — pass the hit's image_path to SEE the figure (clock tree, block diagram, memory map, timing diagram, pinout) whenever the answer depends on the diagram itself.
- chips ([chip]): what the server actually holds. With no argument: every indexed chip FAMILY with its manual count. With \`chip\`: that family's manuals, each with the \`rev\` to pass to search. One call — never go probing the server's HTTP API by hand.

Search rules:
- Always pass \`chip\` as the manual's device FAMILY as indexed (the corpus is multi-chip): STM32F405/407/427/429 → "STM32F4", AT32F421C8T7 → "AT32F", CH32V307 → "CH32V" — NOT the exact part number. A part number is resolved to its family automatically and the reply tells you the name to use; when it cannot be resolved the tool refuses to search and lists the candidates. Pass \`rev\` (e.g. "RM0090", "AT32F421_DS") when you know it; if omitted, all revisions for that chip are searched and each citation shows its source rev.
- The corpus is MULTI-VENDOR and largely Chinese-language (ST, Artery 雅特力, GigaDevice 兆易创新, WCH 沁恒, MindMotion 灵动, Nations 国民技术, HDSC 华大, HK 航顺, Geehy 极海, Nordic, Espressif …). Never conclude a part is not indexed because it is not an STM32, and never conclude it from one failed search — check with action "chips".
- A reply where EVERY citation is tagged [GENERAL] means nothing from your chip matched: that is a miss, not an answer. The tool says so explicitly when it happens — re-read the note instead of quoting those chunks at the user.
- When you omit \`rev\`, a shared GENERAL corpus (cross-chip material: schematic conventions, tutorials, reference notes) is automatically folded in. Do NOT pass \`chip: "GENERAL"\` yourself.
- Citations are prefixed with tags that classify the hit (they may combine): \`[GENERAL]\` = cross-chip corpus; \`[SCHEMATIC]\` / \`[TUTORIAL]\` / \`[REFERENCE]\` = the chunk's kind; \`[FIGURE]\` = has an image. Treat tags as context, not as a filter.
- Use search before answering any register-level or peripheral-behavior question — do not answer such questions from memory. Phrase queries the way the manual would: "TIM1 PWM output mode configuration" beats "how to blink motor"; if results miss, rephrase with the peripheral/register name or raise topK.
- Exact register/bitfield/address/reset VALUES quoted in prose are contextual, not authoritative — for supported chips the stm32config tool's generated output is authoritative for configuration values.
- Which pad carries which signal — alternate functions, ADC channel numbers, timer channels, the package pinout — is NOT a manual question for a supported chip: \`stm32config describe-mcu\` answers it authoritatively, completely and in one call. Search here only for parts that tool does not cover.
- If the answer is not in the returned chunks, say so honestly — never fabricate manual content.
- If this tool reports lookup unavailable (no server, unreachable, HTTP error): do NOT invent registers, electrical ratings, or peripheral behavior from memory. Tell the user manuals cannot be queried and they can point YOMA_DATASHEET_SERVER at a datasheet server (self-hosted is fine) or read the PDF themselves.
- Requires network access to a datasheet server (YOMA_DATASHEET_SERVER).`;

function textResult(text: string, details: DatasheetToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

const LOOKUP_UNAVAILABLE =
	"DATASHEET LOOKUP UNAVAILABLE. Do not invent register maps, electrical ratings, reset values, or peripheral behavior from memory. " +
	"Tell the user the manuals cannot be queried from this machine, and that they can set YOMA_DATASHEET_SERVER to a working datasheet server (self-hosted is fine) or look the PDF up themselves.";

function noServerHelp(): string {
	return (
		`${LOOKUP_UNAVAILABLE}\n` +
		`No datasheet server configured. Set YOMA_DATASHEET_SERVER=<http://server[:port]> in the environment to enable search/read_section/view_figure.`
	);
}

function unreachableHelp(server: string, detail: string): string {
	return (
		`${LOOKUP_UNAVAILABLE}\n` +
		`Could not reach the datasheet server at ${server}: ${detail}. ` +
		`This is a configuration/network problem, not a missing chip fact.`
	);
}

/** 服务器还没有 /api/search 时的引导。契约见本文件头注释。 */
function searchUnavailableHelp(server: string): string {
	return (
		`The datasheet server at ${server} does not expose POST /api/search yet (HTTP 404). ` +
		`Server-side search (bge-m3 embedding + Lance query on the server) needs that endpoint — ` +
		`ask the datasheet-server maintainer to add POST /api/search ` +
		`({ query, chip, rev?, top_k } → { hits: [{ text, parsed_path, image_path, ... }] }). ` +
		`Meanwhile read_section and view_figure still work when you know a manual's parsed_path / image_path.`
	);
}

const need = (value: string | undefined, action: string, field: string): string => {
	if (!value || !value.trim()) throw new Error(`datasheet ${action} requires ${field}`);
	return value.trim();
};

export function createDatasheetToolDefinition(
	_env: ExecutionEnv,
): ToolDefinition<typeof datasheetSchema, DatasheetToolDetails> {
	return {
		name: "datasheet",
		label: "datasheet",
		description: DESCRIPTION,
		promptSnippet: "Search chip manuals with citations, read full sections, view figures (datasheet server)",
		promptGuidelines: serverUrl()
			? [
					"Before answering any register-level or peripheral-behavior question, search the indexed manuals with the datasheet tool and cite page/section. If the tool says lookup is unavailable or unreachable, do not invent those facts from memory — tell the user manuals cannot be queried.",
					'The manual corpus is multi-vendor (ST, Artery, GigaDevice, WCH, MindMotion, Nations, HDSC, Nordic, Espressif, …) and filed by device FAMILY, not by part number. Never tell the user a chip is missing from it on the strength of a failed search — run the datasheet tool\'s "chips" action and read the actual index first.',
				]
			: [
					"Datasheet lookup is not configured (YOMA_DATASHEET_SERVER). Do not answer register-level, electrical, or peripheral-behavior questions from memory — say you cannot look up the manual.",
				],
		parameters: datasheetSchema,
		execute: async (_toolCallId, params, signal) => {
			const server = serverUrl();
			if (!server) return textResult(noServerHelp(), { action: params.action });

			const fetchServer = async (url: string, init?: RequestInit): Promise<Response> => {
				try {
					return await fetch(url, { ...init, signal });
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					throw Object.assign(new Error(unreachableHelp(server, detail)), { datasheetUnreachable: true });
				}
			};

			/** manifest → 家族索引。端点不在(旧服务器)时 undefined;网络失败照旧抛 tagged Error。 */
			const fetchChipIndex = async (): Promise<Map<string, ChipFamily> | undefined> => {
				const cached = chipIndexCache;
				if (cached && cached.server === server && Date.now() - cached.at < CHIP_INDEX_TTL_MS) return cached.index;
				const res = await fetchServer(`${server}/api/manifest`);
				if (!res.ok) return undefined;
				const json = (await res.json().catch(() => undefined)) as ManifestEntry[] | undefined;
				if (!Array.isArray(json) || json.length === 0) return undefined;
				const index = buildChipIndex(json);
				chipIndexCache = { server, at: Date.now(), index };
				return index;
			};
			// search 的兜底路径用这一份:索引拿不到是我们自己的额外功课,绝不能反过来把搜索挡掉。
			const chipIndexQuietly = async (): Promise<Map<string, ChipFamily> | undefined> => {
				try {
					return await fetchChipIndex();
				} catch {
					return undefined;
				}
			};

			try {
			switch (params.action) {
				case "search": {
					const query = need(params.query, "search", "query");
					const wanted = need(params.chip, "search", "chip");
					const k = clampTopK(params.topK);

					const post = async (
						chip: string,
					): Promise<{ hits: SearchHit[] } | { failed: ReturnType<typeof textResult> }> => {
						const res = await fetchServer(`${server}/api/search`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ query, chip, rev: params.rev, top_k: k }),
						});
						if (res.status === 404) {
							return { failed: textResult(searchUnavailableHelp(server), { action: "search", chip, rev: params.rev }) };
						}
						if (!res.ok) {
							const body = await res.text().catch(() => "");
							return {
								failed: textResult(
									unreachableHelp(server, `HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`),
									{ action: "search", chip, rev: params.rev },
								),
							};
						}
						const json = (await res.json()) as { hits?: SearchHit[] };
						return { hits: (json.hits ?? []).slice(0, k).map((h) => ({ ...h, kind: h.kind ?? "" })) };
					};

					const answer = (hits: SearchHit[], searched: string, note: string) => ({
						content: [
							{
								type: "text" as const,
								text:
									(note ? `${note}\n\n` : "") +
									(hits.map(formatCitation).join("\n---\n") || "(no matching datasheet chunks found)"),
							},
						],
						details: {
							action: "search" as const,
							chip: wanted,
							resolvedChip: searched === wanted ? undefined : searched,
							rev: params.rev,
							topK: k,
							hits: hits.map((h) => ({
								manual_name: h.manual_name,
								page: h.page,
								headings: h.headings,
								score: h.score,
								parsed_path: h.parsed_path,
								image_path: h.image_path,
								source_pdf: h.source_pdf,
							})),
						},
					});

					// 有一条命中来自目标家族就算搜到了。**全是 GENERAL 说明 chip 过滤根本没匹配上** ——
					// 服务器对不认识的 chip 不报错,照样 200 返回跨芯片语料,分数还挺高。
					const onTarget = (hits: SearchHit[]) => hits.some((h) => normChip(h.chip ?? "") !== "GENERAL");

					const first = await post(wanted);
					if ("failed" in first) return first.failed;
					if (normChip(wanted) === "GENERAL" || onTarget(first.hits)) return answer(first.hits, wanted, "");

					const index = await chipIndexQuietly();
					if (!index) return answer(first.hits, wanted, ""); // 索引不可用:维持老行为

					const resolution = resolveChip(index, wanted);
					if (resolution.kind === "exact") {
						return answer(first.hits, wanted, chipMissNote(index.get(normChip(wanted))!, params.rev));
					}
					if (resolution.kind === "family") {
						const retry = await post(resolution.chip);
						if ("failed" in retry) return retry.failed;
						return answer(
							retry.hits,
							resolution.chip,
							onTarget(retry.hits)
								? `NOTE: "${wanted}" is not an index name — this corpus is filed by device FAMILY. Searched "${resolution.chip}" instead; pass that as \`chip\` from here on.`
								: chipMissNote(index.get(normChip(resolution.chip))!, params.rev),
						);
					}
					return textResult(unknownChipHelp(wanted, resolution), {
						action: "search",
						chip: wanted,
						rev: params.rev,
						topK: k,
					});
				}

				case "chips": {
					const index = await fetchChipIndex();
					if (!index) {
						return textResult(
							`The datasheet server at ${server} does not expose GET /api/manifest, so the indexed chip list cannot be read. ` +
								`Pass \`chip\` as the device family (not the part number) and search directly.`,
							{ action: "chips" },
						);
					}
					const asked = params.chip?.trim();
					if (asked) {
						const resolution = resolveChip(index, asked);
						if (resolution.kind === "exact" || resolution.kind === "family") {
							const family = index.get(normChip(resolution.chip))!;
							const from = normChip(resolution.chip) === normChip(asked) ? "" : ` (resolved from "${asked}")`;
							return textResult(
								`chip "${family.chip}"${from} — ${family.manuals.length} manual(s) indexed:\n${formatFamilyManuals(family, 200)}\n\n` +
									`Search it with { action: "search", chip: "${family.chip}", query: … }, optionally \`rev\` set to one of the above.`,
								{ action: "chips", chip: family.chip, manuals: family.manuals.length },
							);
						}
						return textResult(chipCandidatesNote(asked, resolution), {
							action: "chips",
							chip: asked,
							families: index.size,
						});
					}
					const manuals = [...index.values()].reduce((n, f) => n + f.manuals.length, 0);
					return textResult(
						`${index.size} indexed chip families, ${manuals} manuals. The number in parentheses is that family's manual count; ` +
							`pass \`chip\` to list one family's manuals (each with the \`rev\` to search it by).\n\n${formatChipList(index)}`,
						{ action: "chips", families: index.size, manuals },
					);
				}

				case "read_section": {
					const rel = need(params.parsedPath, "read_section", "parsedPath");
					const cap = clampChars(params.maxChars);
					const res = await fetchServer(`${server}/artifacts/${encodeRel(rel)}`);
					if (res.status === 404) {
						return textResult(
							`Parsed manual not on the server: ${rel} (HTTP 404). The manual may not be ingested with parsed ` +
								`artifacts — rely on search chunks and cite those.`,
							{ action: "read_section", parsedPath: rel },
						);
					}
					if (!res.ok) {
						return textResult(unreachableHelp(server, `HTTP ${res.status} ${res.statusText} for ${rel}`), {
							action: "read_section",
							parsedPath: rel,
						});
					}
					const raw = await res.text();
					const lines = raw.split("\n");
					const headings = parseHeadings(lines);

					if (!params.heading || !params.heading.trim()) {
						if (raw.length <= cap) {
							return textResult(raw, { action: "read_section", parsedPath: rel, mode: "full", chars: raw.length, sections: headings.length });
						}
						return textResult(
							`(${(raw.length / 1024).toFixed(0)} KB parsed manual; pass \`heading\` to read one section.)\n\n# Sections\n${tableOfContents(headings)}`,
							{ action: "read_section", parsedPath: rel, mode: "toc", sections: headings.length },
						);
					}

					const wanted = lastSegment(params.heading);
					const idx = matchHeading(headings, wanted);
					if (idx < 0) {
						// 没有匹配的标题 —— 退回围绕短语本身的文本窗口
						const at = findPhrase(raw, wanted);
						if (at >= 0) {
							const start = Math.max(0, at - Math.floor(cap / 4));
							const { out, truncated } = capped(raw.slice(start, start + cap), cap);
							return textResult(`(No exact section heading for "${wanted}"; showing a text window.)\n\n${out}`, {
								action: "read_section",
								parsedPath: rel,
								mode: "window",
								heading: wanted,
								truncated,
							});
						}
						return textResult(
							`No section heading or text matched "${wanted}" in ${rel}. Available sections:\n\n${tableOfContents(headings, 200)}`,
							{ action: "read_section", parsedPath: rel, mode: "toc", heading: wanted, sections: headings.length },
						);
					}

					const [startLine, endLine] = sectionRange(headings, idx, lines.length);
					const section = lines.slice(startLine, endLine).join("\n").trim();
					const { out, truncated } = capped(section, cap);
					return textResult(out, {
						action: "read_section",
						parsedPath: rel,
						mode: "section",
						heading: headings[idx].title,
						level: headings[idx].level,
						lines: [startLine + 1, endLine],
						chars: section.length,
						truncated,
					});
				}

				case "view_figure": {
					const rel = need(params.imagePath, "view_figure", "imagePath");
					const mime = FIGURE_MIME[path.extname(rel).toLowerCase()];
					if (!mime) {
						return textResult(
							`Not a supported figure image path: ${rel} — expected a .png/.jpg/.gif/.webp image_path from a [FIGURE] hit.`,
							{ action: "view_figure", imagePath: rel },
						);
					}
					const res = await fetchServer(`${server}/artifacts/${encodeRel(rel)}`);
					if (res.status === 404) {
						return textResult(
							`Figure not on the server: ${rel} (HTTP 404). Rely on the search prose chunks and cite those.`,
							{ action: "view_figure", imagePath: rel },
						);
					}
					if (!res.ok) {
						return textResult(unreachableHelp(server, `HTTP ${res.status} ${res.statusText} for ${rel}`), {
							action: "view_figure",
							imagePath: rel,
						});
					}
					const bytes = Buffer.from(await res.arrayBuffer());
					if (bytes.byteLength > MAX_FIGURE_BYTES) {
						return textResult(
							`Figure ${rel} is ${(bytes.byteLength / 1e6).toFixed(1)} MB (cap ${(MAX_FIGURE_BYTES / 1e6).toFixed(0)} MB); not attaching.`,
							{ action: "view_figure", imagePath: rel, bytes: bytes.byteLength },
						);
					}
					return {
						content: [
							{
								type: "text" as const,
								text: params.caption ? `Figure (attached below): ${params.caption}` : `Figure ${rel} (attached below).`,
							},
							{ type: "image" as const, data: bytes.toString("base64"), mimeType: mime },
						],
						details: { action: "view_figure" as const, imagePath: rel, mime, bytes: bytes.byteLength },
					};
				}
			}
			} catch (error) {
				if (error instanceof Error && "datasheetUnreachable" in error) {
					return textResult(error.message, { action: params.action });
				}
				throw error;
			}
		},
	};
}

export function createDatasheetTool(env: ExecutionEnv) {
	return wrapToolDefinition(createDatasheetToolDefinition(env));
}
