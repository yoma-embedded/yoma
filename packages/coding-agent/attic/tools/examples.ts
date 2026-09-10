/**
 * examples 工具:本机代码语料索引(core/examples/)的会话入口 —— 在服务器发布的语料里
 * 检索"这段代码 / 这个工程从哪来"的条目、看整卡、把选中条目拷进工作区、从服务器同步
 * 语料。设计与验收见 docs/施工指南-例程库.md。
 *
 * 语料真实长什么样(2026-09-06 对照现网核实):服务器发布的几乎全是 **generic** 生态 ——
 * 第三方嵌入式库(RTOS 内核与移植端口、文件系统、GUI、USB、网络栈、bootloader、调试 /
 * 主机工具、数据格式、DSP),由 agent 按 codelib-index 技能建索引;esp-idf / stm32cube
 * 两个厂商生态的机械抽取器仍在,但服务器一份都没发布。工具文案从前只讲"厂商例程",
 * 模型照着理解,会把这条通道判成"内容有限"、把 ecosystem=stm32cube 过滤下的零命中当成
 * 语料缺失 —— 所以文案必须说清:语料形态、search 只查本机已同步的索引、generic 条目的
 * buildable 恒 false、单文件条目怎么 seed。
 *
 * 与 toolchain 同档(createCodingToolDefinitions):不依赖 engines。工具层是薄胶水:
 * 参数 -> core/examples 调用 -> 渲染;检索 / 抽取的行为都在 core 层测过,这里只对齐接线。
 * core/examples 里的 render / search / seed / store / sync 等文件与 rag_yoma/codelib **有
 * 逐字节复制契约**(服务器端跑同一份),所以工具层要改口径只能在这里包一层、不动它们:
 * 零命中的补充提示、无索引的人话、单文件 seed 都是这么来的。
 *
 * 语料文件访问(info 列目录、seed 拷贝)直用 node:fs:语料根来自本机账本(sources.json)
 * 或远程语料落地后的缓存树,是本机事实,不属于会话执行环境;工作区侧(dest 解析)仍走 env。
 */
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";

import { listDirNames } from "../examples/extract-util.ts";
import { checkMergeConflicts, type PreflightInput } from "../examples/preflight.ts";
import { renderEntryCard, renderPreflightReport, renderSearchReport } from "../examples/render.ts";
import {
	type CorpusSource,
	ECOSYSTEMS,
	type Ecosystem,
	ENTRY_KINDS,
	type EntryKind,
	type ExampleEntry,
	type ExamplesIndex,
	isEcosystem,
	isEntryKind,
	isTier,
	type Tier,
	TIERS,
} from "../examples/schema.ts";
import { searchIndex, type SearchQuery } from "../examples/search.ts";
import { SEED_PROVENANCE_FILE, SEED_SCHEMA_TAG, type SeedProvenance, seedExample } from "../examples/seed.ts";
import {
	corpusCacheDir,
	enrichmentMapForAll,
	indexDir,
	readAllIndexes,
	readCorpusMarker,
	readSources,
	resolveCorpus,
} from "../examples/store.ts";
import {
	type CodelibMeta,
	fetchCodelibMeta,
	listRemoteCorpora,
	resolveSyncServer,
	syncCorpus,
	syncIndex,
} from "../examples/sync.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const EXAMPLES_ACTIONS = ["search", "info", "seed", "preflight", "sync"] as const;

export type ExamplesAction = (typeof EXAMPLES_ACTIONS)[number];

const examplesSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never(同 toolchain)。
	action: Type.Optional(
		Type.Union(
			[Type.Literal("search"), Type.Literal("info"), Type.Literal("seed"), Type.Literal("preflight"), Type.Literal("sync")],
			{
				description:
					"search (default): query the corpus indexes synced onto THIS machine. info: full card for one entry id. seed: copy an entry (directory or single file) into the workspace (requires id and the corpus code tree). preflight: enrichment-footprint overlap check across entries (requires ids, chassis first). sync: without corpus, list what the server publishes and each corpus's local state; with corpus, land its index (MB-scale) and, with code:true, its code tree.",
			},
		),
	),
	target: Type.Optional(
		Type.String({
			description:
				'Your chip, lowercase, e.g. "stm32f407" or "esp32s3". HARD filter by family prefix: an entry matches when your chip name starts with one of its targets (stm32f407 matches an entry tagged stm32f4; esp32s3 does not match one tagged esp32s2). Entries with no targets (chip-agnostic or unknown) are kept, ranked lower and flagged for you to verify. Giving a target also switches the default tier to "seed".',
		}),
	),
	ecosystem: Type.Optional(
		Type.String({
			description:
				'HARD filter on corpus ecosystem: "generic" (third-party libraries — what the server mostly publishes), "esp-idf" (IDF example set), "stm32cube" (Cube firmware-pack Projects). Leave it off unless you need one ecosystem: filtering on a vendor ecosystem that is not synced returns nothing.',
		}),
	),
	board: Type.Optional(
		Type.String({
			description:
				"Board name as a SOFT preference (bonus, not a filter) — your board usually differs from the vendor devkit.",
		}),
	),
	peripherals: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Capability tags, lowercase, matched EXACTLY against the entry\'s tags (e.g. ["uart"], ["filesystem"], ["mqtt"], ["rtos"], ["bootloader"], ["gui"]). Entries hitting none are EXCLUDED. Search ONE capability unit per call (split "wifi+mqtt sensor" into separate searches); on zero hits try a synonym tag or move the term to keywords.',
		}),
	),
	keywords: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Free-text terms, lowercase, scored (never excluded) against title/name (strong) and summary/path (weak). Titles and summaries are Chinese with library, protocol and API names in English, so use the English name: ["json"], ["modbus"], ["freertos"].',
		}),
	),
	buildableOnly: Type.Optional(
		Type.Boolean({
			description:
				"esp-idf / stm32cube corpora only: keep entries whose corpus has the build prerequisites on disk. Generic corpora record buildable=false for EVERY entry (unverified, not unbuildable), so this filter hides all of them — leave it off there.",
		}),
	),
	tier: Type.Optional(
		Type.String({
			description:
				'Layer filter: "seed" = things that can be a starting point on a chip (example projects, porting ports, portable library bodies) — the DEFAULT whenever target is given; "lib" = only entries marked lib (kernel cores that need a port, PC-only demos, tests, host-tool sources, whole-tree summaries); "all" = no layer filter. "seed" hides only entries explicitly marked lib.',
		}),
	),
	entryKind: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Granularity filter: "project" (a buildable example/demo directory to start from), "module" (one sub-module, porting port or single-file library to read or copy into your own build), "corpus" (a whole tree or porting layer, reference only). Exclusive: entries with no recorded kind are dropped when this is given, so leave it off unless you want one shape.',
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max results, default 12." })),
	id: Type.Optional(Type.String({ description: "Entry id from search results. Required for info and seed." })),
	dest: Type.Optional(
		Type.String({
			description:
				"seed only: destination relative to the working directory. A directory entry defaults to the entry name; a single-file entry lands INSIDE a directory that defaults to the library name (fatfs@master/source/ff.c → fatfs/ff.c).",
		}),
	),
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"preflight only: 2+ entry ids, the CHASSIS first, donors after. Compares enriched footprints (pins, peripheral instances, link-time symbols, task priorities, partition tables); unenriched entries are reported as blind spots.",
		}),
	),
	corpus: Type.Optional(
		Type.String({
			description:
				'sync only: corpus id from the sync listing, e.g. "freertos-kernel@main" or "tinyusb@master" (also the corpus field of search hits). Omit to list every corpus the server publishes with its local state.',
		}),
	),
	code: Type.Optional(
		Type.Boolean({
			description:
				"sync only: also download and extract the corpus code tree (tens to hundreds of MB, one-off, cached afterwards) so info shows a corpus root you can rg and seed from. Default: index + enrichment only (MB-scale). Tell the user the size before a code sync.",
		}),
	),
});

export type ExamplesToolInput = Static<typeof examplesSchema>;

export interface ExamplesToolDetails {
	action: ExamplesAction;
	/** search 才有:命中数与命中 id(渲染文本之外的机器可读结果)。 */
	count?: number;
	hitIds?: string[];
	/** info / seed 才有。 */
	id?: string;
	corpus?: string;
	/** seed 才有:落进工作区的绝对路径(目录条目是目录,单文件条目是那个文件)。 */
	seededTo?: string;
	/** preflight 才有:参与的条目(底盘在前)与重叠条数。 */
	ids?: string[];
	conflicts?: number;
	/** sync 才有:目标语料与(代码同步后的)字节数。 */
	corpusId?: string;
	archiveBytes?: number;
}

export interface ExamplesToolOptions {
	/** 索引与语料账本所在,默认 ~/.yoma(store.ts 的 defaultConfigDir)。测试与工位端注入。 */
	configDir?: string;
	/** sync 用:语料服务器地址。缺省走 resolveSyncServer($YOMA_DATASHEET_SERVER)。测试注入。 */
	syncServer?: string;
}

const DESCRIPTION = `Finds real, maintained code to start from instead of writing embedded code from scratch. It searches a LOCAL index of code corpora published by the yoma datasheet/codelib server, shows an entry's card, copies an entry into the workspace with provenance, and syncs corpora from the server.

What a corpus is: one git repository at a pinned commit, id "<name>@<ref>" (freertos-kernel@main, tinyusb@master, lvgl@master). An indexing agent reads the tree and writes one entry per useful unit with structured facets. What the server publishes today is mostly third-party embedded libraries (ecosystem "generic"): RTOS kernels and their porting layers, filesystems, GUI/display stacks, USB device/host stacks, network and protocol stacks, TLS, bootloaders/OTA, debug and host tools with per-chip configs, data formats, DSP/math. Vendor SDK example sets (ecosystem "esp-idf" = IDF examples, "stm32cube" = Cube firmware-pack Projects) go through the same tool but exist only when the server has published one — run sync without corpus to see the live catalogue, and never assume a corpus exists.

Entry model (id = "<corpus>/<path inside the repo>"):
- entryKind: "project" = a buildable example/demo directory you can start from; "module" = one sub-module, porting port or single-file library you read or copy into your own build; "corpus" = a whole tree or porting-layer summary (reference only).
- tier: "seed" entries take part in chip queries (example projects, ports, portable library bodies); "lib" entries are hidden from chip queries (kernel cores that need a port, PC-only demos, tests, host-tool sources, whole-tree summaries).
- targets: lowercase chip FAMILY prefixes (stm32f4, nrf52, esp32s3, rp2040). Your chip matches when its name starts with an entry target. Empty targets = chip-agnostic or unknown: NOT excluded, ranked below entries that name your chip, and flagged so you verify. Portable libraries (cJSON, littlefs, lwIP, mbedTLS, FatFs …) never declare targets — a chip query still finds them once you also give a capability or keyword.
- peripherals: lowercase capability tags written by the indexer (rtos, usb, uart, spi, i2c, can, flash, filesystem, fatfs, display, gui, tcp, mqtt, tls, ota, bootloader, dfu, json, cbor, dsp, logging, shell, …). Matching is exact-term, not fuzzy.
- buildable ("可编" / "只读" in results): computed only by the esp-idf and stm32cube extractors. Every generic entry reports 只读 (buildable=false) — that says nothing about whether it builds.
- loc / files: size of the entry. Titles and summaries are Chinese and searchable through keywords.

Actions:
- search (default): reads ONLY the indexes synced onto this machine — nothing is searched on the server, and a machine that has never synced returns nothing. Hard filters first (ecosystem; target by the prefix rule; peripherals must hit; tier, default "seed" when target is given and "all" otherwise; entryKind; buildableOnly), then a deterministic score whose reasons are printed per hit: capability hits, how specific the chip match is (family-level > vendor-level > unnamed), keyword in title/name (strong) or summary/path (weak), board. Ties rotate across corpora so one library cannot fill the page. Search ONE capability per call. On zero hits: try a synonym tag (filesystem/fatfs/littlefs, display/lcd/gui, serial/uart, rtos/scheduler), or drop peripherals and use keywords, or add tier "all" — but never loosen the chip. If the library you need is not in the synced list printed at the top of the report, sync it first.
- info (id): the full card — summary, targets with their evidence source, capability tags, granularity and tier, license, size, enrichment footprint when present, the local corpus root, and the entry's top-level files (or its size for a single-file entry).
- seed (id, dest?): copies the entry into the workspace, refuses to overwrite, drops build artifacts and machine-generated sdkconfig, and writes a .yoma-seed.json provenance record (corpus + commit + path) to commit with the project; a single-file entry lands inside a directory with a sidecar <file>.yoma-seed.json. Requires the corpus code tree on this machine (sync with code:true). Generic entries are rarely self-contained: a project usually references the library root by relative path, a module is a piece you must wire into your own build — the tool's next-steps text says which.
- preflight (ids, chassis first): compares enrichment footprints (pins, peripheral instances, link-time symbols, task priorities, partition tables) across entries and lists overlaps, not verdicts. Only enriched entries have footprints; unenriched ones are named as blind spots. Most server corpora carry no enrichment, so preflight usually answers "blind" — then rely on build/link errors and rg.
- sync (corpus?, code?): without corpus, lists every corpus the server publishes with its local state (未同步 / 索引就绪,代码未落地 / 代码缓存就绪 / 本机检出). With corpus: downloads the index and enrichment (MB-scale) — search/info/preflight work right after. With code:true also downloads and extracts the code tree (tens to hundreds of MB, one-off, cached), after which info shows a corpus root you can rg and seed from. Tell the user the size before a code sync.

Reading the corpus directly: once a corpus is materialised, treat its root as a read-only reference library — rg it for API usage and porting patterns (rg 'HAL_I2C_.*_DMA' <corpusRoot>); the seed copy is what you edit.

Workflow: decompose the need into capability units and search each unit separately; sync the corpus that owns the answer; read (info, rg) before copying; seed and build UNCHANGED first to get a green baseline (a module: wire it into the build and compile before changing behaviour); then add one capability at a time, verifying each step; on failure return to the last green state instead of patching on rubble. Chip and ecosystem are physical constraints — a hit whose targets exclude your chip is not a candidate however good it looks.`;

const PROMPT_SNIPPET =
	"Search synced code corpora (third-party embedded libraries, porting layers, vendor SDK examples) for a verified starting point and seed it";

const PROMPT_GUIDELINES = [
	"For embedded functionality that a maintained library or vendor example already implements (RTOS, filesystem, USB, GUI, network stack, bootloader, data formats, DSP), search the examples corpora before writing it yourself: one capability per search, chip as a hard constraint; if the search reports the corpus is not synced on this machine, examples sync it (index is MB-scale) instead of concluding the code is unavailable.",
	"Treat a synced corpus as a read-only reference library: rg its corpus root (shown by examples info) for API usage and porting patterns, and copy with examples seed — never edit the cache.",
	"A seeded example or module is a starting point, not an integration: build it unchanged (project) or wire it into the build and compile (module) before changing behaviour; add ONE capability per step, verify each step on the ladder (build → flash → runtime evidence), and go back to the last green state when a step fails. Before merging donor code into the chassis, run examples preflight if the entries are enriched — it lists pin / instance / symbol / priority overlaps, not verdicts.",
	'Read the scoring reasons on every examples hit; never use an entry whose targets exclude your chip, and treat empty targets as "verify yourself", not "supported".',
];

const CLI = "tsx packages/coding-agent/src/core/examples/cli.ts";

function requireId(params: ExamplesToolInput): string {
	if (!params.id || params.id.trim() === "") {
		throw new Error(`action "${params.action}" 需要 id —— 先 search,取结果第一列的条目 id`);
	}
	return params.id;
}

/** 体积人话:语料从 22 KB(inih)到 0.21 GB(openblt)都有,一律两位小数 GB 会把小库印成 0.00。 */
function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "大小未知";
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
	return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** 语料 id 的短名:`freertos-kernel@main` → `freertos-kernel`。单文件 seed 的默认落点目录名。 */
function corpusShortName(corpusId: string): string {
	const at = corpusId.indexOf("@");
	return (at > 0 ? corpusId.slice(0, at) : corpusId) || "seed";
}

/**
 * 本机一份索引都没有时的人话。sync 在前(服务器语料是主路),本机 CLI 在后 ——
 * 从前只给两条 esp-idf / stm32cube 的 CLI 命令,模型据此以为这条通道只装厂商例程。
 */
function noIndexHelp(server: string | undefined, configDir?: string): string {
	return [
		`本机还没有同步任何语料索引(search/info/seed/preflight 只看本机 ${indexDir(configDir)},不查服务器)。`,
		server
			? `服务器语料:先 examples sync(不带 corpus)列出 ${server} 上已发布的语料,再 sync(corpus:"<id>") 落索引(MB 级,之后即可 search);要读代码或 seed 再加 code:true。`
			: "服务器语料:未配置 YOMA_DATASHEET_SERVER(与 datasheet 工具同一个变量),配上后 examples sync 可列出并落地服务器语料。",
		`本机检出的语料:CLI 离线建索引 —— ${CLI} index --ecosystem esp-idf|stm32cube|generic --root <目录>(generic 还需 --corpus <id> --proposal <file>)。`,
	].join("\n");
}

/**
 * 零命中时补在报告后面的提示。renderSearchReport 那句"放宽外设或关键词"是对的但不够:
 * 实测模型带 ecosystem=stm32cube 在只有 generic 语料的机器上搜到零命中,结论是
 * "服务器没有厂商语料",而真正的原因是 search 根本不查服务器 —— 得把"本机没有这个生态"
 * "buildable 恒 false""外设词精确匹配""要的库不在本机就 sync"逐条点明。
 */
function zeroHitHelp(indexes: ExamplesIndex[], query: SearchQuery, server: string | undefined): string {
	const present = [...new Set(indexes.map((index) => index.header.ecosystem))];
	const lines: string[] = [];
	if (query.ecosystem && !present.includes(query.ecosystem)) {
		lines.push(
			`本机没有 ${query.ecosystem} 生态的语料 —— 已同步的 ${indexes.length} 个语料全是:${present.join("、")}。` +
				"厂商例程集(esp-idf / stm32cube)只有服务器发布了才会出现在 sync 清单里,别把这当成「语料缺失」;去掉 ecosystem 再搜第三方库。",
		);
	}
	if (query.buildableOnly && present.includes("generic")) {
		lines.push(
			"generic 语料的 buildable 恒为 false(未验证可编译,不代表不能编),buildableOnly 会把它们全部排掉 —— 去掉这个条件。",
		);
	}
	if (query.peripherals?.length) {
		lines.push(
			"外设词是精确匹配、不模糊:换同义词(filesystem/fatfs/littlefs、display/lcd/gui、serial/uart、rtos/scheduler)或改用 keywords(软匹配标题 / 摘要,不排除)。",
		);
	}
	if (query.target && !query.tier) {
		lines.push('带芯片时默认只看 seed 层(库本体、PC 演示、测试被藏起来),加 tier:"all" 可见全部;芯片条件本身别放宽。');
	}
	lines.push(
		server
			? `search 只查上面列出的本机语料。要的库不在其中 → examples sync(不带 corpus)看 ${server} 都发布了什么,再 sync(corpus:"<id>") 落索引。`
			: "search 只查上面列出的本机语料;配置 YOMA_DATASHEET_SERVER 后,examples sync 可从服务器落更多语料。",
	);
	return lines.join("\n");
}

function missingCorpusHelp(corpusId: string, archiveBytes: number | undefined): string {
	return [
		`语料 ${corpusId} 的代码树不在本机。落地它:examples sync(corpus:"${corpusId}", code:true)(${formatBytes(archiveBytes)},一次性,之后走缓存),`,
		`或 CLI:${CLI} sync ${corpusId} --code。`,
		"只读卡片 / 检索不需要落地;seed 与 rg 需要。",
	].join("\n");
}

/** 一份服务器语料在本机的状态,四态;与 CLI sync 清单同一口径。 */
function localState(meta: CodelibMeta, local: Map<string, CorpusSource>, configDir?: string): string {
	const source = local.get(meta.id);
	if (source && source.root.trim() !== "") return "本机检出";
	if (source?.remote && readCorpusMarker(meta.id, configDir)?.archiveSha256 === source.remote.archiveSha256) {
		return "代码缓存就绪(可 rg / seed)";
	}
	if (source) return "索引就绪,代码未落地";
	return "未同步";
}

/** 清单里一行语料:id | 生态 | 条数 | 体积 | 本机状态 | 芯片声明 | 服务器描述。 */
function describeRemoteCorpus(meta: CodelibMeta, state: string): string {
	const targets = meta.targets ?? [];
	const chips =
		targets.length === 0
			? "芯片:未声明(芯片无关或未知)"
			: `芯片:${targets.slice(0, 5).join(",")}${targets.length > 5 ? ` 等 ${targets.length} 个前缀` : ""}`;
	// archive-only 语料(generic 且关掉了 AI 索引)没有条目:纯代码树,只能 sync --code 落地后 rg。
	const entries = meta.entries === 0 ? "0 条[纯代码树,sync code:true 落地后用 rg]" : `${meta.entries ?? "?"} 条`;
	const description = meta.description ? ` | ${meta.description}` : "";
	return `- ${meta.id} | ${meta.ecosystem} | ${entries} | ${formatBytes(meta.archiveBytes)} | ${state} | ${chips}${description}`;
}

/** sync action:无 corpus = 远端清单 × 本地状态;有 corpus = 落地索引(+ 可选代码树)。 */
async function runSyncAction(
	params: ExamplesToolInput,
	options: { configDir?: string; syncServer?: string },
): Promise<{ content: [{ type: "text"; text: string }]; details: ExamplesToolDetails }> {
	const server = resolveSyncServer(options.syncServer, options.configDir);
	if (!server) {
		return {
			content: [
				{
					type: "text",
					text: [
						"语料服务器已关闭(YOMA_DATASHEET_SERVER=off)—— sync 需要服务器地址(与 datasheet 工具同一个):",
						"设 YOMA_DATASHEET_SERVER 环境变量或 ~/.yoma/.env 里的同名项(不设就用内置默认服务器),或本机 CLI sync --server <url>。",
					].join("\n"),
				},
			],
			details: { action: "sync" },
		};
	}
	const configDir = options.configDir;
	const corpusId = params.corpus?.trim();

	if (!corpusId) {
		const remote = await listRemoteCorpora(server);
		if (remote.length === 0) {
			return {
				content: [{ type: "text", text: `服务器 ${server} 上还没有已发布的语料。` }],
				details: { action: "sync" },
			};
		}
		const local = new Map(readSources(configDir).corpora.map((s) => [s.id, s]));
		const sorted = [...remote].sort((a, b) => a.id.localeCompare(b.id));
		const lines = sorted.map((meta) => describeRemoteCorpus(meta, localState(meta, local, configDir)));
		const synced = sorted.filter((meta) => localState(meta, local, configDir) !== "未同步").length;
		return {
			content: [
				{
					type: "text",
					text: [
						`服务器 ${server} 上已发布 ${remote.length} 个语料(本机已同步 ${synced} 个;search 只查已同步的):`,
						...lines,
						"",
						'状态:未同步 → sync(corpus:"<id>") 落索引(MB 级)后即可 search/info;索引就绪,代码未落地 → 要读代码或 seed 再 sync(corpus:"<id>", code:true)(体积见第 4 列,一次性,之后走缓存);代码缓存就绪 → 可 rg / seed;本机检出 → 本机 CLI 建的索引。',
					].join("\n"),
				},
			],
			details: { action: "sync" },
		};
	}

	let meta: CodelibMeta;
	try {
		meta = await fetchCodelibMeta(server, corpusId);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`拿不到语料 ${corpusId} 的元数据:${reason}\n语料 id 含 @ref(如 freertos-kernel@main、tinyusb@master),用 examples sync(不带 corpus)看服务器清单里的确切 id。`,
		);
	}
	const index = await syncIndex(server, meta, configDir);
	const downloaded = index.downloaded.length > 0 ? `(下载了 ${index.downloaded.join("、")})` : "(本地已是最新)";
	const lines: string[] = [];
	if (meta.entries === 0) {
		lines.push(`${corpusId}:这是纯代码树语料,没有索引条目 —— search 查不到它,sync code:true 落地后直接 rg。`);
	} else {
		lines.push(
			`${corpusId}:索引${meta.enrichSha256 ? "+富化" : ""}就绪${downloaded}—— ${meta.entries ?? "?"} 条${meta.description ? `;${meta.description}` : ""}。search/info/preflight 现在可用。`,
		);
	}
	let archiveBytes: number | undefined;
	if (params.code) {
		const result = await syncCorpus(server, meta, configDir);
		archiveBytes = meta.archiveBytes;
		const cache = corpusCacheDir(corpusId, configDir);
		lines.push(
			result.skipped ? `代码缓存已就绪:${cache}` : `代码落地完成(${formatBytes(result.bytes)}):${cache}`,
			`现在可以把它当只读参考库 rg(如 rg 'HAL_I2C_.*_DMA' ${cache});seed 拷进工程的那份才是要改的。`,
		);
	} else {
		lines.push(
			`代码树未落地:要读代码或 seed,再跑一次加 code:true(${formatBytes(meta.archiveBytes)},一次性,之后走缓存)。`,
		);
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "sync", corpusId, archiveBytes } };
}

function findEntry(
	indexes: ExamplesIndex[],
	id: string,
): { entry: ExampleEntry; index: ExamplesIndex } | undefined {
	for (const index of indexes) {
		const entry = index.entries.find((item) => item.id === id);
		if (entry) return { entry, index };
	}
	return undefined;
}

/**
 * 按生态与粒度给 seed 之后的第一步 —— 先原样跑通,一行业务代码都别改。
 * generic 语料从前落到 STM32Cube 那段("引用固件包的 Drivers/"),对第三方库是错的话。
 */
function nextStepsFor(entry: ExampleEntry, corpusRoot: string | undefined, dest: string, singleFile: boolean): string {
	const discipline = "先原样构建、烧录、跑通(green baseline),一行业务代码都别改;跑通之前不往下走。";
	const root = corpusRoot ?? "(语料根见 info)";
	if (entry.ecosystem === "esp-idf") {
		return [
			discipline,
			`cd ${dest}`,
			`idf.py set-target <你的芯片>   # 例程支持:${entry.targets.join(", ") || "见 README"}`,
			"idf.py build && idf.py -p <串口> flash monitor",
			entry.deps?.length ? `首次构建需联网拉取组件:${entry.deps.join(", ")}` : undefined,
		]
			.filter(Boolean)
			.join("\n");
	}
	if (entry.ecosystem === "stm32cube") {
		return [
			discipline,
			"注意:STM32Cube 例程的工程文件按相对路径引用固件包的 Drivers/(../../..),种子目录**不自包含**。两条路:",
			`- 在固件包内构建原版例程验证绿点:${root}/${entry.path}`,
			"- 或按你的工程结构重排 include 与启动文件(toolchain 工具核对 arm-gcc/cmake)",
		].join("\n");
	}
	// generic:第三方库语料。工程条目多半按相对路径引用库本体;模块 / 单文件条目要接进自己的构建。
	if (entry.entryKind === "project") {
		return [
			discipline,
			"这是第三方库语料里的例程工程,通常按相对路径引用库本体(../../..),种子目录**不自包含**。两条路:",
			`- 在语料缓存树内原地构建原版验证绿点:${root}/${entry.path}(用它自己的构建系统:CMake / Makefile / IDE 工程)`,
			`- 或把它依赖的库本体一并拷进你的工程(rg ${root} 找 include 与源文件),按你的构建系统重排 include 路径与启动文件`,
		].join("\n");
	}
	return [
		`这是库的一个${singleFile ? "单文件" : "模块 / 端口"}(粒度 ${entry.entryKind ?? "未标"}),不是完整工程:把它接进你自己的工程构建(源文件加进 CMake/Makefile,补 include 路径),它依赖的库本体从语料根一起拷:${root}`,
		"先编译通过、再改行为;缺的符号用 rg 在语料根里找定义。",
	].join("\n");
}

/**
 * 单文件条目的种子。core 的 seedExample 假定条目是目录(拷完往 dest 里写出处文件,
 * dest 是文件时 ENOTDIR),而 generic 语料里约五分之一的条目是单文件(ff.c / lfs.c /
 * cJSON.c / jsmn.h)—— seed.ts 是与 rag_yoma 逐字节复制的契约文件,不在那边改,工具层
 * 自己拷:落进一个目录(默认以库名命名),同名文件已存在则拒绝;出处写成旁挂的
 * `<文件名>.yoma-seed.json` —— 一个目录会先后收多个单文件(ff.c + ff.h + ffconf.h),
 * 共用一个 .yoma-seed.json 会互相覆盖。
 */
function seedSingleFile(
	entry: ExampleEntry,
	source: string,
	destDir: string,
	commit?: string,
): { dest: string; provenanceFile: string } {
	const fileName = path.basename(entry.path);
	const target = path.join(destDir, fileName);
	if (existsSync(target)) throw new Error(`目标文件已存在:${target} —— 种子不覆盖,换一个目标目录`);
	mkdirSync(destDir, { recursive: true });
	cpSync(source, target);
	const provenance: SeedProvenance = {
		schema: SEED_SCHEMA_TAG,
		id: entry.id,
		corpus: entry.corpus,
		commit,
		sourcePath: entry.path,
		seededAt: new Date().toISOString(),
	};
	const provenanceFile = path.join(destDir, `${fileName}${SEED_PROVENANCE_FILE}`);
	writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, "\t")}\n`, "utf8");
	return { dest: target, provenanceFile };
}

export function createExamplesToolDefinition(
	env: ExecutionEnv,
	options?: ExamplesToolOptions,
): ToolDefinition<typeof examplesSchema, ExamplesToolDetails> {
	const configDir = options?.configDir;
	return {
		name: "examples",
		label: "examples",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: examplesSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const action: ExamplesAction = params.action ?? "search";
			const server = resolveSyncServer(options?.syncServer);

			if (action === "sync") {
				return runSyncAction(params, { configDir, syncServer: options?.syncServer });
			}

			const indexes = readAllIndexes(configDir);

			if (action === "search") {
				if (indexes.length === 0) {
					return { content: [{ type: "text", text: noIndexHelp(server, configDir) }], details: { action, count: 0 } };
				}
				if (params.ecosystem !== undefined && !isEcosystem(params.ecosystem)) {
					throw new Error(`ecosystem 只认 ${ECOSYSTEMS.join(" / ")},收到:${params.ecosystem}`);
				}
				// 分层 / 粒度是**排除式**过滤,拼错一个字就等于悄悄少了一批候选 —— 与
				// ecosystem 同一档待遇,当场报错而不是当没填(examples 的硬过滤纪律)。
				if (params.tier !== undefined && params.tier !== "all" && !isTier(params.tier)) {
					throw new Error(`tier 只认 ${TIERS.join(" / ")} / all,收到:${params.tier}`);
				}
				for (const kind of params.entryKind ?? []) {
					if (!isEntryKind(kind)) throw new Error(`entryKind 只认 ${ENTRY_KINDS.join(" / ")},收到:${kind}`);
				}
				const query: SearchQuery = {
					ecosystem: params.ecosystem as Ecosystem | undefined,
					target: params.target,
					board: params.board,
					peripherals: params.peripherals,
					keywords: params.keywords,
					buildableOnly: params.buildableOnly,
					tier: params.tier as Tier | "all" | undefined,
					entryKind: params.entryKind as EntryKind[] | undefined,
					limit: params.limit,
				};
				const hits = searchIndex(
					indexes.flatMap((index) => index.entries),
					query,
					enrichmentMapForAll(indexes, configDir),
				);
				const report = renderSearchReport(indexes, query, hits);
				const text = hits.length === 0 ? `${report}\n\n${zeroHitHelp(indexes, query, server)}` : report;
				return {
					content: [{ type: "text", text }],
					details: { action, count: hits.length, hitIds: hits.map((hit) => hit.entry.id) },
				};
			}

			if (action === "preflight") {
				const ids = (params.ids ?? []).map((item) => item.trim()).filter((item) => item !== "");
				if (ids.length < 2) {
					throw new Error('preflight 需要 ids:至少 2 个条目 id,底盘在前 —— 例 ["<底盘id>","<供体id>"]');
				}
				if (new Set(ids).size !== ids.length) {
					throw new Error("preflight 的 ids 里有重复条目 —— 同一例程和自己比重叠没有意义");
				}
				if (indexes.length === 0) throw new Error(noIndexHelp(server, configDir));
				const enrichment = enrichmentMapForAll(indexes, configDir);
				const inputs: PreflightInput[] = ids.map((entryId, position) => {
					const found = findEntry(indexes, entryId);
					if (!found) {
						throw new Error(`找不到条目:${entryId} —— 先 search 拿到确切 id(索引可能重建过,旧 id 会失效)`);
					}
					const record = enrichment.get(entryId);
					return {
						entry: found.entry,
						role: position === 0 ? "chassis" : "donor",
						...(record ? { card: record.card } : {}),
					};
				});
				const report = checkMergeConflicts(inputs);
				return {
					content: [{ type: "text", text: renderPreflightReport(inputs, report) }],
					details: { action, ids, conflicts: report.conflicts.length },
				};
			}

			const id = requireId({ ...params, action });
			if (indexes.length === 0) throw new Error(noIndexHelp(server, configDir));
			const found = findEntry(indexes, id);
			if (!found) throw new Error(`找不到条目:${id} —— 先 search 拿到确切 id(索引可能重建过,旧 id 会失效)`);
			const { entry, index } = found;
			// 三态解析:本机检出 > 完整缓存 > 未落地(远程语料 sync --code 之前的状态)。
			const resolved = resolveCorpus(entry.corpus, configDir);
			const source = resolved?.root ? path.join(resolved.root, ...entry.path.split("/")) : undefined;
			const stat = source ? statSync(source, { throwIfNoEntry: false }) : undefined;

			if (action === "info") {
				const card = renderEntryCard(entry, {
					commit: index.header.commit,
					corpusRoot: resolved?.root,
					enrichment: enrichmentMapForAll([index], configDir).get(id),
				});
				let files: string;
				if (source && stat?.isFile()) {
					files = `\n\n单文件条目:${path.basename(source)}(${formatBytes(stat.size)})—— 直接 read ${source},或 seed 把它拷进工程目录。`;
				} else if (source) {
					const listing = listDirNames(source);
					const top = [...listing.dirs.map((name) => `${name}/`), ...listing.files];
					files = top.length > 0 ? `\n\n顶层内容:${top.join("  ")}` : "\n\n(条目目录为空或不在)";
				} else if (resolved?.remote) {
					files = `\n\n${missingCorpusHelp(entry.corpus, resolved.remote.archiveBytes)}`;
				} else {
					files = "\n\n(本机语料根缺失 —— 在放语料的机器上重跑 CLI index,或 examples sync 落地)";
				}
				return { content: [{ type: "text", text: card + files }], details: { action, id, corpus: entry.corpus } };
			}

			// action === "seed"
			if (!resolved?.root || !source) {
				if (resolved?.remote) throw new Error(missingCorpusHelp(entry.corpus, resolved.remote.archiveBytes));
				throw new Error(`语料 ${entry.corpus} 的本机根没有记账(sources.json)—— 在放语料的机器上重跑 CLI index`);
			}
			if (!stat) {
				throw new Error(
					`条目路径不存在:${source} —— 语料缓存不完整或被改过,重新 sync(corpus:"${entry.corpus}", code:true),或在放语料的机器上重跑 CLI index`,
				);
			}
			if (stat.isFile()) {
				const destDir = await resolveToCwd(env, params.dest ?? corpusShortName(entry.corpus));
				const result = seedSingleFile(entry, source, destDir, index.header.commit);
				const text = [
					`已种子(单文件):${entry.id}`,
					`→ ${result.dest}`,
					`出处已写入 ${result.provenanceFile}(随工程提交)`,
					"",
					nextStepsFor(entry, resolved.root, result.dest, true),
				].join("\n");
				return { content: [{ type: "text", text }], details: { action, id, corpus: entry.corpus, seededTo: result.dest } };
			}
			const dest = await resolveToCwd(env, params.dest ?? entry.name);
			const result = seedExample(entry, resolved.root, dest, index.header.commit);
			const text = [
				`已种子:${entry.id}`,
				`→ ${result.dest}`,
				`出处已写入 ${path.join(result.dest, SEED_PROVENANCE_FILE)}(随工程提交)`,
				"",
				nextStepsFor(entry, resolved.root, result.dest, false),
			].join("\n");
			return { content: [{ type: "text", text }], details: { action, id, corpus: entry.corpus, seededTo: result.dest } };
		},
	};
}

export function createExamplesTool(env: ExecutionEnv, options?: ExamplesToolOptions) {
	return wrapToolDefinition(createExamplesToolDefinition(env, options));
}
