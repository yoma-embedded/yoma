import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { clampChars, clampTopK, createDatasheetToolDefinition, encodeRel, formatCitation, type SearchHit } from "../src/index.ts";
import {
	buildChipIndex,
	capped,
	findPhrase,
	lastSegment,
	type ManifestEntry,
	matchHeading,
	parseHeadings,
	resetChipIndexCache,
	resolveChip,
	sectionRange,
} from "../src/core/tools/datasheet.ts";

// ─── 隔离:工具只读 YOMA_DATASHEET_SERVER,测试必须与真机配置切干净 ───────────

const savedServer = process.env.YOMA_DATASHEET_SERVER;

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-datasheet-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function isolate() {
	delete process.env.YOMA_DATASHEET_SERVER;
}

afterEach(() => {
	resetChipIndexCache(); // 芯片索引缓存是模块级的,不清就会跨用例串味
	if (savedServer === undefined) delete process.env.YOMA_DATASHEET_SERVER;
	else process.env.YOMA_DATASHEET_SERVER = savedServer;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

const makeTool = () => createDatasheetToolDefinition(new NodeExecutionEnv({ cwd: createTempDir() }));

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("datasheet section helpers", () => {
	const md = [
		"# 1 Overview",
		"intro",
		"## 1.1 Features",
		"feature text",
		"## 1.2 Clocks and startup",
		"clock text line",
		"more clock text",
		"# 2 Registers",
		"reg text",
	];

	it("parses headings with levels and lines", () => {
		const headings = parseHeadings(md);
		expect(headings.map((h) => h.title)).toEqual(["1 Overview", "1.1 Features", "1.2 Clocks and startup", "2 Registers"]);
		expect(headings[2]).toEqual({ level: 2, title: "1.2 Clocks and startup", line: 4 });
	});

	it("matches headings with escalating tolerance", () => {
		const headings = parseHeadings(md);
		expect(matchHeading(headings, "1.2 Clocks and startup")).toBe(2); // exact
		expect(matchHeading(headings, "1.2 Clocks")).toBe(2); // prefix
		expect(matchHeading(headings, "clocks and")).toBe(2); // includes
		expect(matchHeading(headings, "nonexistent")).toBe(-1);
	});

	it("takes the most specific breadcrumb segment", () => {
		expect(lastSegment("2 Description > 2.3.7 Clocks and startup")).toBe("2.3.7 Clocks and startup");
		expect(lastSegment("single")).toBe("single");
	});

	it("returns the section from its heading to the next same-or-higher heading", () => {
		const headings = parseHeadings(md);
		expect(sectionRange(headings, 2, md.length)).toEqual([4, 7]); // 1.2 直到 # 2
		expect(sectionRange(headings, 3, md.length)).toEqual([7, md.length]); // 最后一节到文件尾
	});

	it("findPhrase returns the LAST occurrence (skipping the ToC entry)", () => {
		const raw = "Contents: Clocks and startup ... body ... ## Clocks and startup\nreal text";
		const at = findPhrase(raw, "clocks and startup");
		expect(raw.slice(at)).toStartWith("Clocks and startup\nreal text");
	});

	it("caps long text with a note", () => {
		const { out, truncated } = capped("x".repeat(50), 10);
		expect(truncated).toBe(true);
		expect(out).toContain("truncated at 10 chars");
		expect(capped("short", 10)).toEqual({ out: "short", truncated: false });
	});
});

describe("datasheet citations + clamps", () => {
	const hit = (over: Partial<SearchHit>): SearchHit => ({
		text: "chunk text",
		manual_name: "RM0008",
		chip: "STM32F1",
		rev: "RM0008",
		page: 100,
		headings: "a > b",
		score: 0.5,
		kind: "",
		source_pdf: "",
		parsed_path: "",
		image_path: "",
		...over,
	});

	it("tags GENERAL / kind / FIGURE citations and appends pointers", () => {
		const text = formatCitation(
			hit({ chip: "GENERAL", kind: "tutorial", image_path: "figures/F1/RM0008/f1.png", parsed_path: "parsed/F1/RM0008.md" }),
			0,
		);
		expect(text).toContain("[#1]  [GENERAL] [TUTORIAL] [FIGURE]");
		expect(text).toContain("figure: figures/F1/RM0008/f1.png");
		expect(text).toContain('source: parsed/F1/RM0008.md  (action "read_section" for the full section)');
	});

	it("plain datasheet hits carry no tags", () => {
		expect(formatCitation(hit({}), 1)).toStartWith("[#2] RM0008");
	});

	it("page 0 (page-less formats: md/docx/txt) is not shown as p.0", () => {
		// 与 rag_yoma/query.py format_citation 同解(page>0 才显示)。
		expect(formatCitation(hit({ page: 100 }), 0)).toContain("p.100");
		const withoutPage = formatCitation(hit({ page: 0 }), 0);
		expect(withoutPage).not.toContain("p.0");
	});

	it("clamps topK and maxChars", () => {
		expect(clampTopK(undefined)).toBe(6);
		expect(clampTopK(0)).toBe(1);
		expect(clampTopK(99.9)).toBe(20);
		expect(clampChars(undefined)).toBe(12000);
		expect(clampChars(1)).toBe(1000);
		expect(clampChars(1e9)).toBe(40000);
	});

	it("encodes artifact rel paths per segment", () => {
		expect(encodeRel("figures/STM32 F1/RM0008/f 1.png")).toBe("figures/STM32%20F1/RM0008/f%201.png");
	});
});

// ─── 型号 → 家族索引名 ───────────────────────────────────────────────────────

describe("resolveChip", () => {
	const index = buildChipIndex([
		{ chip: "AT32F", rev: "AT32F421_DS" },
		{ chip: "AT32A", rev: "AT32A403A_DS" },
		{ chip: "AT32WB", rev: "AT32WB415_DS" },
		{ chip: "STM32F1", rev: "RM0008" },
		{ chip: "STM32F4", rev: "RM0090" },
		{ chip: "MM32S", rev: "MM32S_DS" },
		{ chip: "MM32SPIN", rev: "MM32SPIN25_DS" },
		{ chip: "ESP32-S3", rev: "TRM" },
		{ chip: "GENERAL", rev: "PM0214" },
	]);

	it("takes the index name as-is, case- and separator-insensitively", () => {
		expect(resolveChip(index, "AT32F")).toEqual({ kind: "exact", chip: "AT32F" });
		expect(resolveChip(index, "at32f")).toEqual({ kind: "exact", chip: "AT32F" });
		expect(resolveChip(index, "esp32s3")).toEqual({ kind: "exact", chip: "ESP32-S3" });
	});

	it("resolves a part number to the LONGEST family that prefixes it", () => {
		// 这条就是真会话里砸掉三分钟的那次:AT32F421C8T7 的索引名是 AT32F。
		expect(resolveChip(index, "AT32F421C8T7")).toEqual({ kind: "family", chip: "AT32F" });
		expect(resolveChip(index, "STM32F407VGT6")).toEqual({ kind: "family", chip: "STM32F4" });
		// MM32S 和 MM32SPIN 都是 MM32SPIN25 的前缀 —— 取最长的那个,不是先撞上的那个。
		expect(resolveChip(index, "MM32SPIN25")).toEqual({ kind: "family", chip: "MM32SPIN" });
	});

	it("reports ambiguity instead of picking one when a stem spans several families", () => {
		const r = resolveChip(index, "AT32");
		expect(r).toEqual({ kind: "ambiguous", candidates: ["AT32A", "AT32F", "AT32WB"] });
	});

	it("reports unknown chips with near candidates, never a silent guess", () => {
		const r = resolveChip(index, "TTP233");
		expect(r.kind).toBe("unknown");
		expect((r as { candidates: string[] }).candidates.length).toBeGreaterThan(0);
	});
});

// ─── 工具面(假服务器,全离线) ────────────────────────────────────────────────

const MANUAL = ["# 1 Overview", "intro text", "## 1.2 Clocks and startup", "clock body", "# 2 Registers", "reg body"].join(
	"\n",
);
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PARSED_REL = "parsed/STM32F1/RM0008.md";
const FIGURE_REL = "figures/STM32F1/RM0008/f1.png";

const SAMPLE_HIT: SearchHit = {
	text: "USART baud rate chunk",
	manual_name: "RM0008",
	chip: "STM32F1",
	rev: "RM0008",
	page: 793,
	headings: "27 USART > 27.3.4 Fractional baud rate generation",
	score: 0.71,
	kind: "",
	source_pdf: "source/STM32F1/RM0008.pdf",
	parsed_path: PARSED_REL,
	image_path: "",
};

// 目标家族一条都没中的时候真服务器返回的东西:跨芯片 GENERAL 语料,200,分数还不低。
// 这就是"猜错 chip 完全没有报错信号"的来源,新加的用例全靠它复现。
const GENERAL_HIT: SearchHit = {
	text: "The Cortex-M4 processor is a high performance 32-bit processor.",
	manual_name: "PM0214_CortexM4",
	chip: "GENERAL",
	rev: "PM0214",
	page: 13,
	headings: "1.3 About the Cortex-M4 processor",
	score: 0.52,
	kind: "reference",
	source_pdf: "source/GENERAL/PM0214.pdf",
	parsed_path: "parsed/GENERAL/PM0214.md",
	image_path: "",
};

const AT32_HIT: SearchHit = {
	text: "AT32F421xxT7.C8 = 64. 闪存(K 字节)",
	manual_name: "雅特力 AT32F421 数据手册(中文)",
	chip: "AT32F",
	rev: "AT32F421_DS",
	page: 9,
	headings: "1 规格说明",
	score: 0.72,
	kind: "datasheet",
	source_pdf: "source/AT32F/AT32F421_DS.pdf",
	parsed_path: "parsed/AT32F/AT32F421_DS.md",
	image_path: "",
};

const MANIFEST: ManifestEntry[] = [
	{ chip: "STM32F1", rev: "RM0008", manual_name: "STM32F1 参考手册", kind: "reference" },
	{ chip: "AT32F", rev: "AT32F421_DS", manual_name: "雅特力 AT32F421 数据手册(中文)", kind: "datasheet" },
	{ chip: "AT32F", rev: "AT32F403_DS", manual_name: "雅特力 AT32F403 数据手册(中文)", kind: "datasheet" },
	{ chip: "AT32WB", rev: "AT32WB415_DS", manual_name: "雅特力 AT32WB415 数据手册(中文)", kind: "datasheet" },
	{ chip: "GENERAL", rev: "PM0214", manual_name: "PM0214_CortexM4", kind: "reference" },
];

/**
 * 假数据手册服务器:/api/search + /api/manifest + /artifacts/。
 * search **按 chip 过滤**,匹配不到就只回 GENERAL —— 与真服务器同解。
 * searchStatus 可换成 404/500;manifestStatus 模拟没有 /api/manifest 的旧服务器。
 */
function fakeServer(options?: { searchStatus?: number; manifestStatus?: number }) {
	const requests: { method: string; path: string; body?: any }[] = [];
	const hitsFor = (chip: string, rev?: string): SearchHit[] => {
		const pool = chip === "STM32F1" ? [SAMPLE_HIT] : chip === "AT32F" ? [AT32_HIT] : [];
		// 与真服务器同解:给了 rev 就只按 rev 过滤(不折 GENERAL,匹配不上就是空);
		// 没给 rev 而目标家族没命中时,GENERAL 语料被折进来 —— 那正是无声失败的来源。
		if (rev) return pool.filter((h) => h.rev === rev);
		return pool.length ? pool : [GENERAL_HIT];
	};
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const { pathname } = new URL(req.url);
			const entry: (typeof requests)[number] = { method: req.method, path: pathname };
			if (req.method === "POST") entry.body = await req.json().catch(() => undefined);
			requests.push(entry);
			if (pathname === "/api/manifest") {
				if (options?.manifestStatus) return new Response("nope", { status: options.manifestStatus });
				return Response.json(MANIFEST);
			}
			if (pathname === "/api/search" && req.method === "POST") {
				if (options?.searchStatus === 404) return new Response("not found", { status: 404 });
				if (options?.searchStatus) return new Response("boom", { status: options.searchStatus });
				return Response.json({ hits: hitsFor(String(entry.body?.chip ?? ""), entry.body?.rev) });
			}
			if (pathname === `/artifacts/${encodeRel(PARSED_REL)}`) return new Response(MANUAL);
			if (pathname === `/artifacts/${encodeRel(FIGURE_REL)}`)
				return new Response(Buffer.from(PNG_BASE64, "base64"), { headers: { "Content-Type": "image/png" } });
			return new Response("nope", { status: 404 });
		},
	});
	process.env.YOMA_DATASHEET_SERVER = `http://localhost:${server.port}`;
	return { server, requests };
}

describe("datasheet tool", () => {
	it("explains what to configure when no server is set, and forbids inventing chip facts", async () => {
		isolate();
		const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" });
		expect(textOf(result)).toContain("YOMA_DATASHEET_SERVER");
		expect(textOf(result)).toContain("DATASHEET LOOKUP UNAVAILABLE");
		expect(textOf(result)).toContain("Do not invent");
	});

	it("search posts to /api/search and formats citations", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "usart baud", chip: "STM32F1", topK: 3 });
			const text = textOf(result);
			expect(text).toContain("[#1] RM0008 (STM32F1) p.793");
			expect(text).toContain("USART baud rate chunk");
			expect(text).toContain('action "read_section"');
			expect(result.details.hits).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				method: "POST",
				path: "/api/search",
				body: { query: "usart baud", chip: "STM32F1", top_k: 3 },
			});
		} finally {
			server.stop(true);
		}
	});

	// ── chip 猜错:真会话里 11 次 search 全落空、模型据此说"没收录"的那条路 ──────

	it("search resolves a part number to its indexed family and re-runs the query", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			const result = await makeTool().execute("c1", {
				action: "search",
				query: "flash SRAM",
				chip: "AT32F421C8T7",
				topK: 5,
			});
			const text = textOf(result);
			expect(text).toContain('Searched "AT32F"');
			expect(text).toContain("雅特力 AT32F421 数据手册");
			expect(result.details.resolvedChip).toBe("AT32F");
			// 一次落空的搜索 + 一次 manifest + 一次改对了的搜索。
			expect(requests.map((r) => r.path)).toEqual(["/api/search", "/api/manifest", "/api/search"]);
			expect(requests[2].body.chip).toBe("AT32F");
		} finally {
			server.stop(true);
		}
	});

	it("search does not pay for the manifest when the chip was right", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			await makeTool().execute("c1", { action: "search", query: "usart baud", chip: "STM32F1" });
			expect(requests.map((r) => r.path)).toEqual(["/api/search"]);
		} finally {
			server.stop(true);
		}
	});

	it("search caches the chip index across calls", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			await makeTool().execute("c1", { action: "search", query: "q", chip: "AT32F421" });
			await makeTool().execute("c2", { action: "search", query: "q", chip: "AT32F403" });
			expect(requests.filter((r) => r.path === "/api/manifest")).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	});

	it("search refuses to answer from GENERAL prose when the chip is not indexed at all", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "touch threshold", chip: "TTP233" });
			const text = textOf(result);
			expect(text).toContain("NO SEARCH PERFORMED");
			expect(text).toContain("not an indexed chip family");
			expect(text).not.toContain("Cortex-M4 processor is a high performance"); // GENERAL 噪声不许冒充答案
			// 解析不出来就不再多打一枪。
			expect(requests.filter((r) => r.path === "/api/search")).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	});

	it("search says so when the chip IS indexed but nothing in it matched", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "AT32WB" });
			const text = textOf(result);
			expect(text).toContain('chip "AT32WB" IS indexed');
			expect(text).toContain("cross-chip GENERAL corpus");
			expect(text).toContain('rev "AT32WB415_DS"');
		} finally {
			server.stop(true);
		}
	});

	it("search flags a rev that does not exist for the family", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", {
				action: "search",
				query: "q",
				chip: "AT32F421",
				rev: "RM_AT32F421",
			});
			expect(textOf(result)).toContain('no manual with rev "RM_AT32F421" exists for chip "AT32F"');
		} finally {
			server.stop(true);
		}
	});

	it("search keeps working against a server with no /api/manifest", async () => {
		isolate();
		const { server } = fakeServer({ manifestStatus: 404 });
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "AT32F421" });
			expect(textOf(result)).toContain("PM0214_CortexM4"); // 老行为:命中原样返回
			expect(result.details.resolvedChip).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});

	it("chips lists the indexed families, and one family's manuals with their revs", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const all = await makeTool().execute("c1", { action: "chips" });
			expect(textOf(all)).toContain("AT32F (2)");
			expect(textOf(all)).toContain("STM32F1 (1)");
			expect(all.details.families).toBe(4);
			expect(all.details.manuals).toBe(5);

			const one = await makeTool().execute("c2", { action: "chips", chip: "AT32F421C8T7" });
			const text = textOf(one);
			expect(text).toContain('chip "AT32F" (resolved from "AT32F421C8T7") — 2 manual(s)');
			expect(text).toContain('rev "AT32F421_DS" [datasheet]');
			expect(one.details.manuals).toBe(2);
		} finally {
			server.stop(true);
		}
	});

	it("search explains the missing endpoint when the server has no /api/search yet", async () => {
		isolate();
		const { server } = fakeServer({ searchStatus: 404 });
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" });
			const text = textOf(result);
			expect(text).toContain("does not expose POST /api/search yet");
			expect(text).toContain("read_section and view_figure still work");
		} finally {
			server.stop(true);
		}
	});

	it("search degrades instead of throwing on a real server error", async () => {
		isolate();
		const { server } = fakeServer({ searchStatus: 500 });
		try {
			const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" });
			expect(textOf(result)).toContain("DATASHEET LOOKUP UNAVAILABLE");
			expect(textOf(result)).toContain("HTTP 500");
		} finally {
			server.stop(true);
		}
	});

	it("search degrades when the server is unreachable, and forbids inventing chip facts", async () => {
		isolate();
		process.env.YOMA_DATASHEET_SERVER = "http://127.0.0.1:1";
		const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" });
		expect(textOf(result)).toContain("DATASHEET LOOKUP UNAVAILABLE");
		expect(textOf(result)).toContain("Do not invent");
	});

	it("search requires query and chip", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			await expect(makeTool().execute("c1", { action: "search", chip: "STM32F1" })).rejects.toThrow(
				/search requires query/,
			);
			await expect(makeTool().execute("c1", { action: "search", query: "q" })).rejects.toThrow(/search requires chip/);
		} finally {
			server.stop(true);
		}
	});

	it("read_section fetches the parsed manual and returns the whole file when it fits", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "read_section", parsedPath: PARSED_REL });
			expect(textOf(result)).toBe(MANUAL);
			expect(result.details.mode).toBe("full");
		} finally {
			server.stop(true);
		}
	});

	it("read_section extracts one section by breadcrumb", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", {
				action: "read_section",
				parsedPath: PARSED_REL,
				heading: "1 Overview > 1.2 Clocks and startup",
			});
			expect(textOf(result)).toBe("## 1.2 Clocks and startup\nclock body");
			expect(result.details.mode).toBe("section");
		} finally {
			server.stop(true);
		}
	});

	it("read_section falls back to a text window, then to the ToC", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const window = await makeTool().execute("c1", { action: "read_section", parsedPath: PARSED_REL, heading: "clock body" });
			expect(window.details.mode).toBe("window");
			const toc = await makeTool().execute("c2", { action: "read_section", parsedPath: PARSED_REL, heading: "zzz nothing" });
			expect(toc.details.mode).toBe("toc");
			expect(textOf(toc)).toContain("## 1.2 Clocks and startup");
		} finally {
			server.stop(true);
		}
	});

	it("read_section reports a manual missing from the server as guidance, not an error", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "read_section", parsedPath: "parsed/NOPE/X.md" });
			expect(textOf(result)).toContain("Parsed manual not on the server");
		} finally {
			server.stop(true);
		}
	});

	it("view_figure returns the caption text plus the image content block", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "view_figure", imagePath: FIGURE_REL, caption: "Figure 2." });
			expect(textOf(result)).toContain("Figure (attached below): Figure 2.");
			const image = result.content.find((b) => b.type === "image") as { data: string; mimeType: string };
			expect(image.mimeType).toBe("image/png");
			expect(image.data).toBe(PNG_BASE64);
			expect(result.details.bytes).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	});

	it("view_figure rejects unsupported extensions without touching the server", async () => {
		isolate();
		const { server, requests } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "view_figure", imagePath: "figures/F1/RM0008/f1.svg" });
			expect(textOf(result)).toContain("Not a supported figure image path");
			expect(requests).toHaveLength(0);
		} finally {
			server.stop(true);
		}
	});

	it("view_figure reports a figure missing from the server as guidance", async () => {
		isolate();
		const { server } = fakeServer();
		try {
			const result = await makeTool().execute("c1", { action: "view_figure", imagePath: "figures/NOPE/X/f.png" });
			expect(textOf(result)).toContain("Figure not on the server");
		} finally {
			server.stop(true);
		}
	});
});
