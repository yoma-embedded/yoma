import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import { clampChars, clampTopK, createDatasheetToolDefinition, encodeRel, formatCitation, type SearchHit } from "../src/index.ts";
import {
	capped,
	findPhrase,
	lastSegment,
	matchHeading,
	parseHeadings,
	sectionRange,
} from "../src/core/tools/datasheet.ts";

// ─── 隔离:工具只读 YOMA_DATASHEET_SERVER,测试必须与真机配置切干净 ───────────

const savedServer = process.env.YOMA_DATASHEET_SERVER;

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-datasheet-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function isolate() {
	delete process.env.YOMA_DATASHEET_SERVER;
}

afterEach(() => {
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

/** 假数据手册服务器:/api/search + /artifacts/。searchStatus 可换成 404/500。 */
function fakeServer(options?: { searchStatus?: number }) {
	const requests: { method: string; path: string; body?: any }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const { pathname } = new URL(req.url);
			const entry: (typeof requests)[number] = { method: req.method, path: pathname };
			if (req.method === "POST") entry.body = await req.json().catch(() => undefined);
			requests.push(entry);
			if (pathname === "/api/search" && req.method === "POST") {
				if (options?.searchStatus === 404) return new Response("not found", { status: 404 });
				if (options?.searchStatus) return new Response("boom", { status: options.searchStatus });
				return Response.json({ hits: [SAMPLE_HIT] });
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
	it("explains what to configure when no server is set", async () => {
		isolate();
		const result = await makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" });
		expect(textOf(result)).toContain("YOMA_DATASHEET_SERVER");
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

	it("search throws on a real server error", async () => {
		isolate();
		const { server } = fakeServer({ searchStatus: 500 });
		try {
			await expect(makeTool().execute("c1", { action: "search", query: "q", chip: "STM32F1" })).rejects.toThrow(
				/search failed \(500/,
			);
		} finally {
			server.stop(true);
		}
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
