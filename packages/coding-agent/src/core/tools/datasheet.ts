/**
 * datasheet 工具:数据手册 RAG 的三个动作合一(search / read_section / view_figure)。
 *
 * 【架构】完全在线,零本地状态:检索、解析文本、图片全部按需从同事的数据手册
 * 文件服务器读取(YOMA_DATASHEET_SERVER,配置在环境变量里)。
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
 *
 * 前身是从 yoma 移植的四个本地工具(datasheet_search/read_manual_section/
 * view_figure/download_manual + datasheet/ lib);按"不走本地"的决定合并重写,
 * download_manual(物化本地缓存)随之删除。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
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
	let out = `[#${i + 1}]${tag} ${h.manual_name} (${h.chip}) p.${h.page} | ${h.headings}  (score ${h.score.toFixed(2)})\n${h.text}`;
	if (h.image_path) out += `\n   figure: ${h.image_path}`;
	if (h.parsed_path) out += `\n   source: ${h.parsed_path}  (action "read_section" for the full section)`;
	return out;
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
	action: Type.Union([Type.Literal("search"), Type.Literal("read_section"), Type.Literal("view_figure")], {
		description: "search = RAG retrieval with citations | read_section = full manual section | view_figure = see a figure image",
	}),
	query: Type.Optional(
		Type.String({ description: "search: natural-language manual question to retrieve chunks for. Required for search." }),
	),
	chip: Type.Optional(
		Type.String({
			description:
				'search: target chip FAMILY as indexed, e.g. "STM32F4" (not "STM32F405"). Required for search — the corpus is multi-chip.',
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
	action: "search" | "read_section" | "view_figure";
	chip?: string;
	rev?: string;
	topK?: number;
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

const DESCRIPTION = `Chip datasheet / reference-manual assistant backed by the team datasheet server: RAG search with citations, full-section reading, and figure viewing. Everything is fetched on demand from the server — nothing is stored locally.

Actions:
- search (query, chip, [rev, topK]): retrieval-only search over indexed manual PROSE. Returns the top matching RAW chunks WITH citations (manual name, page, section breadcrumb, score). It does NOT answer the question — read the chunks and write the answer yourself, citing page/section.
- read_section (parsedPath, [heading, maxChars]): search chunks are short (~512 tokens). To read the COMPLETE section behind a hit (a full register table, a complete procedure, adjacent bitfields), pass the hit's parsed_path and headings breadcrumb. Omit heading for a table of contents.
- view_figure (imagePath, [caption]): for hits marked [FIGURE] the chunk text is only the caption — pass the hit's image_path to SEE the figure (clock tree, block diagram, memory map, timing diagram, pinout) whenever the answer depends on the diagram itself.

Search rules:
- Always pass \`chip\` as the manual's device FAMILY as indexed (the corpus is multi-chip): STM32F405/407/427/429 → "STM32F4", STM32F103 → "STM32F1" — NOT the exact part number. Pass \`rev\` (e.g. "RM0090") when you know it; if omitted, all revisions for that chip are searched and each citation shows its source rev.
- When you omit \`rev\`, a shared GENERAL corpus (cross-chip material: schematic conventions, tutorials, reference notes) is automatically folded in. Do NOT pass \`chip: "GENERAL"\` yourself.
- Citations are prefixed with tags that classify the hit (they may combine): \`[GENERAL]\` = cross-chip corpus; \`[SCHEMATIC]\` / \`[TUTORIAL]\` / \`[REFERENCE]\` = the chunk's kind; \`[FIGURE]\` = has an image. Treat tags as context, not as a filter.
- Use search before answering any register-level or peripheral-behavior question — do not answer such questions from memory. Phrase queries the way the manual would: "TIM1 PWM output mode configuration" beats "how to blink motor"; if results miss, rephrase with the peripheral/register name or raise topK.
- Exact register/bitfield/address/reset VALUES quoted in prose are contextual, not authoritative — for supported chips the stm32config tool's generated output is authoritative for configuration values.
- Which pad carries which signal — alternate functions, ADC channel numbers, timer channels, the package pinout — is NOT a manual question for a supported chip: \`stm32config describe-mcu\` answers it authoritatively, completely and in one call. Search here only for parts that tool does not cover.
- If the answer is not in the returned chunks, say so honestly — never fabricate manual content.
- Requires network access to the team datasheet server (YOMA_DATASHEET_SERVER).`;

function textResult(text: string, details: DatasheetToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function noServerHelp(): string {
	return (
		`No datasheet server configured. Ask the user to set YOMA_DATASHEET_SERVER=<http://server[:port]> ` +
		`in the environment.`
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
		promptSnippet: "Search chip manuals with citations, read full sections, view figures (team datasheet server)",
		promptGuidelines: [
			"Before answering any register-level or peripheral-behavior question, search the indexed manuals with the datasheet tool — never answer such questions from memory, and cite page/section.",
		],
		parameters: datasheetSchema,
		execute: async (_toolCallId, params, signal) => {
			const server = serverUrl();
			if (!server) return textResult(noServerHelp(), { action: params.action });

			switch (params.action) {
				case "search": {
					const query = need(params.query, "search", "query");
					const chip = need(params.chip, "search", "chip");
					const k = clampTopK(params.topK);
					const res = await fetch(`${server}/api/search`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ query, chip, rev: params.rev, top_k: k }),
						signal,
					});
					if (res.status === 404) {
						return textResult(searchUnavailableHelp(server), { action: "search", chip, rev: params.rev });
					}
					if (!res.ok) {
						const body = await res.text().catch(() => "");
						throw new Error(`datasheet search failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`);
					}
					const json = (await res.json()) as { hits?: SearchHit[] };
					const hits = (json.hits ?? []).slice(0, k).map((h) => ({ ...h, kind: h.kind ?? "" }));
					return {
						content: [
							{
								type: "text" as const,
								text: hits.map(formatCitation).join("\n---\n") || "(no matching datasheet chunks found)",
							},
						],
						details: {
							action: "search" as const,
							chip,
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
					};
				}

				case "read_section": {
					const rel = need(params.parsedPath, "read_section", "parsedPath");
					const cap = clampChars(params.maxChars);
					const res = await fetch(`${server}/artifacts/${encodeRel(rel)}`, { signal });
					if (res.status === 404) {
						return textResult(
							`Parsed manual not on the server: ${rel} (HTTP 404). The manual may not be ingested with parsed ` +
								`artifacts — rely on search chunks and cite those.`,
							{ action: "read_section", parsedPath: rel },
						);
					}
					if (!res.ok) throw new Error(`datasheet read_section failed (${res.status} ${res.statusText}) for ${rel}`);
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
					const res = await fetch(`${server}/artifacts/${encodeRel(rel)}`, { signal });
					if (res.status === 404) {
						return textResult(
							`Figure not on the server: ${rel} (HTTP 404). Rely on the search prose chunks and cite those.`,
							{ action: "view_figure", imagePath: rel },
						);
					}
					if (!res.ok) throw new Error(`datasheet view_figure failed (${res.status} ${res.statusText}) for ${rel}`);
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
		},
	};
}

export function createDatasheetTool(env: ExecutionEnv) {
	return wrapToolDefinition(createDatasheetToolDefinition(env));
}
