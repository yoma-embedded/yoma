/**
 * examples 工具:本机例程索引(core/examples/)的会话入口 —— 检索已验证的厂商例程、
 * 看整卡、把选中的种子拷进工作区。设计与验收见 docs/施工指南-例程库.md。
 *
 * 与 toolchain 同档(createCodingToolDefinitions):它回答"这个工程从哪来",
 * 不依赖 engines。工具层是薄胶水:参数 -> core/examples 调用 -> 渲染;检索/抽取的
 * 行为都在 core 层测过,这里只对齐接线。
 *
 * 语料文件访问(info 列目录、seed 拷贝)直用 node:fs:语料根来自本机账本
 * (sources.json),是本机事实,不属于会话执行环境;远程语料形态落地时,换的是
 * "从账本 root 读"这一段(下载到缓存再读),工作区侧(dest 解析)仍走 env。
 */
import path from "node:path";
import type { ExecutionEnv } from "@yoma/my-pi";
import { type Static, Type } from "typebox";

import { listDirNames } from "../examples/extract-util.ts";
import { checkMergeConflicts, type PreflightInput } from "../examples/preflight.ts";
import { renderEntryCard, renderNoIndexHelp, renderPreflightReport, renderSearchReport } from "../examples/render.ts";
import { type Ecosystem, type ExampleEntry, type ExamplesIndex, isEcosystem } from "../examples/schema.ts";
import { searchIndex, type SearchQuery } from "../examples/search.ts";
import { seedExample } from "../examples/seed.ts";
import {
	corpusCacheDir,
	enrichmentMapForAll,
	readAllIndexes,
	readCorpusMarker,
	readSources,
	resolveCorpus,
} from "../examples/store.ts";
import {
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
					"search (default): query the local index of verified vendor examples. info: full card for one entry id. seed: copy an example into the workspace as a starting point (requires id). preflight: merge conflict check across entries (requires ids, chassis first). sync: bring a remote corpus from the datasheet server onto this machine (index only, or the full code with code:true).",
			},
		),
	),
	target: Type.Optional(
		Type.String({
			description:
				'Chip, e.g. "stm32f407" or "esp32s3". HARD filter: physically incompatible examples are excluded, never just down-ranked. Family-level corpora match by prefix (stm32f407 matches stm32f4).',
		}),
	),
	ecosystem: Type.Optional(
		Type.String({ description: 'Restrict to one ecosystem: "esp-idf" or "stm32cube".' }),
	),
	board: Type.Optional(
		Type.String({ description: "Board name as a SOFT preference (bonus, not a filter) — your board usually differs from the vendor devkit." }),
	),
	peripherals: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Capability keywords, lowercase: ["i2c"], ["mqtt"]. Entries hitting none are excluded. Search ONE capability unit at a time (split "wifi+mqtt sensor" into separate searches).',
		}),
	),
	keywords: Type.Optional(
		Type.Array(Type.String(), { description: "Free-text terms scored against title/name/summary/path." }),
	),
	buildableOnly: Type.Optional(
		Type.Boolean({ description: "Only examples that can build from the local corpus (chassis candidates). Leave off when hunting donor code to read." }),
	),
	limit: Type.Optional(Type.Number({ description: "Max results, default 12." })),
	id: Type.Optional(Type.String({ description: "Entry id from search results. Required for info and seed." })),
	dest: Type.Optional(
		Type.String({ description: "seed only: target directory relative to the working directory. Defaults to the example's name." }),
	),
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"preflight only: 2+ entry ids, the CHASSIS first, donors after. Reports overlapping pins, peripheral instances, link-time symbols, task priorities and partition tables from the enriched cards.",
		}),
	),
	corpus: Type.Optional(
		Type.String({
			description:
				'sync only: corpus id, e.g. "stm32cube-f4@89e6d446" (from a sync listing or the corpus field of search hits). Omit to list what the server has and its local state.',
		}),
	),
	code: Type.Optional(
		Type.Boolean({
			description:
				"sync only: also materialise the corpus code tree (hundreds of MB to GB, one-off; afterwards it is cached and greppable on this machine). Default: index + enrichment only (MB-scale). Tell the user the size before a code sync.",
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
	/** seed 才有:落进工作区的绝对路径。 */
	seededTo?: string;
	/** preflight 才有:参与的条目(底盘在前)与重叠条数。 */
	ids?: string[];
	conflicts?: number;
	/** sync 才有:目标语料与(代码同步后的)字节数。 */
	corpusId?: string;
	archiveBytes?: number;
}

export interface ExamplesToolOptions {
	/** 索引与语料账本所在,默认 ~/.my-pi(store.ts 的 defaultConfigDir)。测试与工位端注入。 */
	configDir?: string;
	/** sync 用:语料服务器地址。缺省走 resolveSyncServer($YOMA_DATASHEET_SERVER)。测试注入。 */
	syncServer?: string;
}

const DESCRIPTION = `Searches a local index of VERIFIED vendor example projects (esp-idf examples, STM32Cube firmware-pack Projects) and seeds one into the workspace as the starting point for new embedded work.

Why: a working vendor example is a compressed proof of hundreds of coupled decisions (clock tree, pin mux, DMA channels, linker script, build flags). Starting from one and changing a little at a time turns failures into "what did I just change" instead of "which of 400 guesses was wrong".

Actions:
- search (default): filters are structural — chip/ecosystem are HARD constraints (an STM32 example is never a candidate for an ESP32 need, however similar the description), peripherals must hit, board is a soft bonus, smaller seeds rank higher. Results show id, targets, peripherals, size, buildability and the scoring reasons. Where the corpus has been enriched offline, hits also carry a model-written summary and capability terms.
- info (id): the full card — summary, deps, Kconfig keys, acceptance material (vendor CI pytest where present), license, local corpus root, top-level files, and the enriched resource footprint (pins, peripheral instances, link-time symbols, tasks) when available.
- seed (id, dest?): copies the example into the workspace (refuses non-empty targets), excludes build artifacts and machine-generated sdkconfig, and writes .yoma-seed.json recording corpus+commit+path — the project's provenance, commit it.
- preflight (ids, chassis FIRST): before merging donor code into the chassis, reports the overlapping facts across their enriched footprints — same pin claimed twice, same peripheral instance, symbols both define (IRQ handlers, HAL_*_MspInit), colliding task priorities, competing partition tables. It lists overlaps, it does not verdict — a shared I2C bus overlap can be exactly right. Unenriched entries are named as blind spots, never silently passed.
- sync (corpus?, code?): bring a corpus from the datasheet server onto THIS machine. Without corpus: list what the server publishes and each corpus's local state. With corpus: land the index + enrichment (MB-scale; search/info/preflight work right after). With code:true also land the full code tree (GB-scale, one-off, then cached) — the corpus root becomes a local directory you can rg-grep for donor code, driver usage and configuration patterns. Tell the user the size before a code sync.

Reading the corpus directly: once a corpus is materialised (info shows its corpusRoot), treat that directory as a read-only reference library — rg across it beats info-per-example when hunting how a peripheral is actually driven (e.g. rg 'HAL_I2C_.*_DMA' <corpusRoot>). The seed copy is what you edit; the corpus is what you read.

Workflow discipline (routine-driven): decompose the need into capability units and search each unit separately; pick the seed, build-flash-run it UNCHANGED first to establish a green baseline; then add ONE capability at a time, verifying each step; on failure return to the last green commit and re-plan instead of patching on rubble.

If search reports no index exists, relay the CLI command it prints to the user — indexing runs offline on the machine that holds the corpus. If a corpus is known but not materialised, sync (or relay the CLI sync command) is how it lands.`;

function requireId(params: ExamplesToolInput): string {
	if (!params.id || params.id.trim() === "") {
		throw new Error(`action "${params.action}" 需要 id —— 先 search,取结果第一列的条目 id`);
	}
	return params.id;
}

function formatGB(bytes: number): string {
	return `${(bytes / 1e9).toFixed(2)} GB`;
}

function missingCorpusHelp(corpusId: string, archiveBytes: number | undefined): string {
	const size = archiveBytes !== undefined && archiveBytes > 0 ? `约 ${formatGB(archiveBytes)}` : "GB 级";
	return [
		`语料 ${corpusId} 的代码树不在本机。落地它:examples 工具 sync(corpus:"${corpusId}", code:true)(${size},一次性,之后走缓存),`,
		`或 CLI:bun packages/coding-agent/src/core/examples/cli.ts sync ${corpusId} --code。`,
		"只读卡片/检索不需要落地;seed 与 rg 检索需要。",
	].join("\n");
}

/** sync action:无 corpus = 远端清单 × 本地状态;有 corpus = 落地索引(+可选代码树)。 */
async function runSyncAction(
	params: ExamplesToolInput,
	options: { configDir?: string; syncServer?: string },
): Promise<{ content: [{ type: "text"; text: string }]; details: ExamplesToolDetails }> {
	const server = resolveSyncServer(options.syncServer);
	if (!server) {
		return {
			content: [
				{
					type: "text",
					text: [
						"未配置语料服务器 —— sync 需要服务器地址(与 datasheet 工具同一个):",
						"设 YOMA_DATASHEET_SERVER 环境变量(桌面端默认已注入),或本机 CLI sync --server <url>。",
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
		const lines = remote.map((meta) => {
			const source = local.get(meta.id);
			let state: string;
			if (source && source.root.trim() !== "") state = "本机检出";
			else if (source?.remote && readCorpusMarker(meta.id, configDir)?.archiveSha256 === source.remote.archiveSha256) {
				state = "代码缓存就绪(可 rg)";
			} else if (source) state = "索引就绪,代码未落地";
			else state = "未同步";
			// archive-only corpora (generic with AI indexing off) have no entries:
			// they are a pure code tree - tell the agent to sync --code and rg.
			const note =
				meta.entries === 0
					? "  [纯代码树:无索引条目,sync --code 落地后用 rg 搜索]"
					: "";
			return `- ${meta.id} | ${meta.ecosystem} | ${meta.entries ?? "?"} 条 | ${formatGB(meta.archiveBytes)} | ${state}${note}`;
		});
		return {
			content: [
				{
					type: "text",
					text: [
						`服务器 ${server} 上的语料:`,
						...lines,
						"",
						`同步:examples sync(corpus:"<id>")只落索引(MB 级);加 code:true 连代码树落地(${formatGB(Math.max(...remote.map((m) => m.archiveBytes)))} 级、一次性),之后在本机 rg。`,
					].join("\n"),
				},
			],
			details: { action: "sync" },
		};
	}

	const meta = await fetchCodelibMeta(server, corpusId);
	const index = await syncIndex(server, meta, configDir);
	const lines = [
		`${corpusId}: 索引+富化就绪${index.downloaded.length > 0 ? `(下载了 ${index.downloaded.join("、")})` : "(本地已是最新)"}—— search/info/preflight 现在可用。`,
	];
	let archiveBytes: number | undefined;
	if (params.code) {
		const result = await syncCorpus(server, meta, configDir);
		archiveBytes = meta.archiveBytes;
		const cache = corpusCacheDir(corpusId, configDir);
		lines.push(
			result.skipped
				? `代码缓存已就绪:${cache}`
				: `代码落地完成(${formatGB(result.bytes)}):${cache}`,
			`现在可以把它当只读参考库 rg(如 rg 'HAL_I2C_.*_DMA' ${cache});seed 拷进工程的那份才是要改的。`,
		);
	} else {
		lines.push(`代码树未落地:要读代码或 seed,再跑一次加 code:true(${formatGB(meta.archiveBytes)},一次性,之后走缓存)。`);
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

/** 按生态给 seed 之后的第一步 —— 先原样跑通,一行业务代码都别改。 */
function nextStepsFor(entry: ExampleEntry, corpusRoot: string | undefined, dest: string): string {
	const discipline = "先原样构建、烧录、跑通(green baseline),一行业务代码都别改;跑通之前不往下走。";
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
	return [
		discipline,
		`注意:STM32Cube 例程的工程文件按相对路径引用固件包的 Drivers/(../../..),种子目录**不自包含**。两条路:`,
		`- 在固件包内构建原版例程验证绿点:${corpusRoot ?? "(语料根见 info)"}/${entry.path}`,
		`- 或按你的工程结构重排 include 与启动文件(toolchain 工具核对 arm-gcc/cmake)`,
	].join("\n");
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
		promptSnippet:
			"Search the local corpus of verified vendor examples (esp-idf, STM32Cube) and seed one as the starting point",
		promptGuidelines: [
			"New embedded functionality starts from a verified example, not a blank file: decompose the need into capability units, run one examples search per unit (chip is a hard constraint — never use a result whose targets exclude your chip), seed the best fit, and build-flash-run it unchanged before touching anything.",
			"After the seed is green, add ONE capability per step and verify each step on the ladder (build → flash → runtime evidence); when a step fails, go back to the last green commit and re-plan — do not keep patching on top of a broken state.",
			"Before merging donor example code into the chassis, run examples preflight (chassis id first, donor ids after): it reports pin / peripheral-instance / link-symbol / task-priority overlaps from the enriched cards before you hit a build or runtime error. It reports facts, not verdicts — judge shared-bus overlaps yourself.",
			"When you need donor code or a usage pattern beyond one example, rg the corpus root shown by info instead of seeding candidates one by one: the corpus is a read-only reference library on this machine. If the corpus is not materialised yet, sync it first — index-only for search, code:true (GB-scale — say the size to the user) for reading.",
		],
		parameters: examplesSchema,
		execute: async (_toolCallId, params) => {
			const action: ExamplesAction = params.action ?? "search";

			if (action === "sync") {
				return runSyncAction(params, { configDir, syncServer: options?.syncServer });
			}

			const indexes = readAllIndexes(configDir);

			if (action === "search") {
				if (indexes.length === 0) {
					return { content: [{ type: "text", text: renderNoIndexHelp() }], details: { action, count: 0 } };
				}
				if (params.ecosystem !== undefined && !isEcosystem(params.ecosystem)) {
					throw new Error(`ecosystem 只认 esp-idf / stm32cube,收到:${params.ecosystem}`);
				}
				const query: SearchQuery = {
					ecosystem: params.ecosystem as Ecosystem | undefined,
					target: params.target,
					board: params.board,
					peripherals: params.peripherals,
					keywords: params.keywords,
					buildableOnly: params.buildableOnly,
					limit: params.limit,
				};
				const hits = searchIndex(
					indexes.flatMap((index) => index.entries),
					query,
					enrichmentMapForAll(indexes, configDir),
				);
				return {
					content: [{ type: "text", text: renderSearchReport(indexes, query, hits) }],
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
				if (indexes.length === 0) throw new Error(renderNoIndexHelp());
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
			if (indexes.length === 0) throw new Error(renderNoIndexHelp());
			const found = findEntry(indexes, id);
			if (!found) throw new Error(`找不到条目:${id} —— 先 search 拿到确切 id(索引可能重建过,旧 id 会失效)`);
			const { entry, index } = found;
			// 三态解析:本机检出 > 完整缓存 > 未落地(远程语料 sync --code 之前的状态)。
			const resolved = resolveCorpus(entry.corpus, configDir);

			if (action === "info") {
				const card = renderEntryCard(entry, {
					commit: index.header.commit,
					corpusRoot: resolved?.root,
					enrichment: enrichmentMapForAll([index], configDir).get(id),
				});
				let files: string;
				if (resolved?.root) {
					const listing = listDirNames(path.join(resolved.root, ...entry.path.split("/")));
					const top = [...listing.dirs.map((name) => `${name}/`), ...listing.files];
					files = top.length > 0 ? `\n\n顶层内容:${top.join("  ")}` : "\n\n(例程目录为空或不在)";
				} else if (resolved?.remote) {
					files = `\n\n${missingCorpusHelp(entry.corpus, resolved.remote.archiveBytes)}`;
				} else {
					files = "\n\n(本机语料根缺失 —— 在放语料的机器上重跑 CLI index,或 examples sync 落地)";
				}
				return { content: [{ type: "text", text: card + files }], details: { action, id, corpus: entry.corpus } };
			}

			// action === "seed"
			if (!resolved?.root) {
				if (resolved?.remote) throw new Error(missingCorpusHelp(entry.corpus, resolved.remote.archiveBytes));
				throw new Error(`语料 ${entry.corpus} 的本机根没有记账(sources.json)—— 在放语料的机器上重跑 CLI index`);
			}
			const dest = await resolveToCwd(env, params.dest ?? entry.name);
			const result = seedExample(entry, resolved.root, dest, index.header.commit);
			const text = [
				`已种子:${entry.id}`,
				`→ ${result.dest}`,
				`出处已写入 ${path.join(result.dest, ".yoma-seed.json")}(随工程提交)`,
				"",
				nextStepsFor(entry, resolved.root, result.dest),
			].join("\n");
			return { content: [{ type: "text", text }], details: { action, id, corpus: entry.corpus, seededTo: result.dest } };
		},
	};
}

export function createExamplesTool(env: ExecutionEnv, options?: ExamplesToolOptions) {
	return wrapToolDefinition(createExamplesToolDefinition(env, options));
}
