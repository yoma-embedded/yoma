/**
 * 例程库 CLI:索引与富化都是离线生成的(在服务器上跑的就是它们,见 rag_yoma 的
 * codelib job)。检索/查看只是索引的只读视图,方便不进会话先验质量;sync 把服务器
 * 上已发布的语料落到本机(索引 MB 级,--code 连语料树 GB 级)。
 *
 *   bun packages/coding-agent/src/core/examples/cli.ts index  --ecosystem esp-idf|stm32cube --root <目录> [--corpus <id>] [--config-dir <目录>]
 *   bun packages/coding-agent/src/core/examples/cli.ts index  --ecosystem generic --root <目录> --corpus <id> --proposal <file> [--tier seed|lib] [--indexer provided|agent]
 *   bun packages/coding-agent/src/core/examples/cli.ts enrich [--corpus <id>]... [--model <provider/model>] [--concurrency <n>] [--limit <n>]
 *   bun packages/coding-agent/src/core/examples/cli.ts sync   [--server <url>] [--config-dir <目录>]        # 远端清单 × 本地状态
 *   bun packages/coding-agent/src/core/examples/cli.ts sync   <语料id>... [--server <url>] [--code] [--config-dir <目录>]
 *   bun packages/coding-agent/src/core/examples/cli.ts search [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p> ...] [--keyword <k> ...] [--buildable] [--tier <t>] [--kind <k> ...] [--corpus <id> ...] [--json] [--limit <n>]
 *   bun packages/coding-agent/src/core/examples/cli.ts show   <条目 id>
 *   bun packages/coding-agent/src/core/examples/cli.ts preflight <底盘id> <供体id>...
 *   bun packages/coding-agent/src/core/examples/cli.ts list
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveModel } from "../../acp/models.ts";
import { type EnrichCompletion, enrichCorpus } from "./enrich.ts";
import { GENERIC_MAX_ENTRIES, type GenericIndexResult, indexGeneric, verifyProposal } from "./generic.ts";
import { indexCorpus } from "./indexer.ts";
import { checkMergeConflicts, type PreflightInput } from "./preflight.ts";
import { renderEntryCard, renderNoIndexHelp, renderPreflightReport, renderSearchReport } from "./render.ts";
import {
	type Ecosystem,
	ENTRY_KINDS,
	type EntryKind,
	type ExampleEntry,
	type ExamplesIndex,
	INDEXERS,
	type Indexer,
	isEcosystem,
	isEntryKind,
	isIndexer,
	isTier,
	type Tier,
	TIERS,
} from "./schema.ts";
import { searchIndex, type SearchQuery } from "./search.ts";
import {
	corpusCacheDir,
	enrichmentMapForAll,
	enrichPathFor,
	findSource,
	readAllIndexes,
	readCorpusMarker,
	readSources,
} from "./store.ts";
import {
	type CodelibMeta,
	fetchCodelibMeta,
	listRemoteCorpora,
	resolveSyncServer,
	syncCorpus,
	syncIndex,
} from "./sync.ts";

const USAGE = `用法:
  cli.ts index     --ecosystem esp-idf|stm32cube --root <语料目录> [--corpus <id>] [--config-dir <目录>]
  cli.ts index     --ecosystem generic --root <语料目录> --corpus <id> --description-file <文件> [--tier seed|lib] [--model <provider/model>]
  cli.ts index     --ecosystem generic --root <语料目录> --corpus <id> --proposal <文件> [--tier seed|lib] [--indexer provided|agent]
  cli.ts enrich    [--corpus <id>]... [--model <provider/model>] [--concurrency <n>] [--limit <n>] [--config-dir <目录>]
  cli.ts sync      [--server <url>] [--config-dir <目录>]
  cli.ts sync      <语料id>... [--server <url>] [--code] [--config-dir <目录>]
  cli.ts search    [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p>]... [--keyword <k>]... [--buildable]
                   [--tier seed|lib|all] [--kind project|module|corpus]... [--corpus <语料id>]... [--json] [--limit <n>] [--config-dir <目录>]
  cli.ts show      <条目 id> [--config-dir <目录>]
  cli.ts preflight <底盘id> <供体id>... [--config-dir <目录>]
  cli.ts list      [--config-dir <目录>]`;

/** 与 bench 的 DEFAULT_MODEL 同一取舍:Flash 便宜三倍,富化是一次性大批量,便宜赢。 */
const DEFAULT_ENRICH_MODEL = "deepseek/deepseek-v4-flash";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function parseTierFlag(value: string | undefined, flag: string): Tier | undefined {
	if (value === undefined) return undefined;
	if (!isTier(value)) fail(`${flag} 只认 ${TIERS.join(" / ")},收到:${value}`);
	return value;
}

/**
 * generic 索引的产出报告。两条通道(一次性调用 / 自带提议)共用一份 —— 口径不一致时,
 * 同一份产物在两条路上读起来会像两回事,查问题时互相指认(render.ts 文件头同理)。
 */
function renderIndexNotes(result: GenericIndexResult, meta: { how: string; started: number; cost?: number }): string {
	const header = result.index.header;
	const notes = [
		`语料 ${header.corpus}`,
		`${meta.how} ${result.index.entries.length} 条(提议被核验丢弃 ${result.dropped} 条),`
			+ `用时 ${((Date.now() - meta.started) / 1000).toFixed(1)}s`
			+ (meta.cost !== undefined ? `,费用 ~$${meta.cost.toFixed(3)}` : ""),
		`落盘 ${result.file}`,
	];
	if (header.indexer || header.tier) {
		notes.push(`语料级 indexer=${header.indexer ?? "(未标)"} tier=${header.tier ?? "(未标)"}`);
	}
	if (header.libraryKind || header.candidateCount !== undefined) {
		// 三个数并排给,不替读者做减法。从前这里算的是 candidateCount - 存活数,并把它
		// 说成"产出方主动放弃的" —— 那既混进了核验层的丢弃,又会打负数:标准 fixture
		// (tinyusb)枚举候选 46、提议 48(多出的是 src 与 hw/bsp 两条汇总条目),
		// 差额 -2,而"主动放弃 -2 条"没有任何意思。
		const proposed = result.index.entries.length + result.dropped;
		notes.push(
			`库定性 ${header.libraryKind ?? "(未给)"} | 枚举候选 ${header.candidateCount ?? "(未给)"}`
				+ ` | 提议 ${proposed} 条 | 核验后存活 ${result.index.entries.length} 条`,
		);
	}
	const reasons = Object.entries(result.dropReasons);
	if (reasons.length > 0) {
		notes.push(`丢弃明细:${reasons.map(([reason, n]) => `${reason}=${n}`).join("  ")}`);
		const overLimit = result.dropReasons["over-limit"];
		if (overLimit) {
			// 撞上限和幻觉路径在总数里长得一模一样,但一个该调参数、一个该查模型。
			notes.push(`  其中 ${overLimit} 条是**撞上限被砍的**(当前上限 ${GENERIC_MAX_ENTRIES})——`
				+ " 这不是模型的判断,调大 YOMA_CODELIB_MAX_ENTRIES 后重跑才拿得到。");
		}
	}
	if (result.fieldWarnings.length > 0) {
		notes.push('字段取值非法(已当"未标"处理,其余字段不受影响):');
		notes.push(...result.fieldWarnings.map((line) => `  ${line}`));
	}
	if (result.parseError) {
		notes.push(`提议整体解析失败(不是"没提议"):${result.parseError}`);
		notes.push("  多半是输出被 maxTokens 截断,JSON 断在半路 —— 调大上限或调小条目上限后重跑。");
	}
	if (result.summaryTruncated.length > 0) {
		notes.push(`树摘要被截断,丢掉了 ${result.summaryTruncated.length} 行(可加大 YOMA_CODELIB_SUMMARY_BUDGET 后重跑):`);
		notes.push(result.summaryTruncated.slice(-5).join("\n"));
	}
	return notes.join("\n");
}

/**
 * 机器可读的产出摘要 —— `--json` 用。rag_yoma 的 dry-run(POST /api/codelibs/validate)
 * 读它:让服务器去解析上面那份给人看的中文散文,等于把措辞变成接口契约,改一个字就断。
 */
function indexResultJson(result: GenericIndexResult): unknown {
	const header = result.index.header;
	const tally = (pick: (entry: ExampleEntry) => string | undefined): Record<string, number> => {
		const counts: Record<string, number> = {};
		for (const entry of result.index.entries) {
			const key = pick(entry) ?? "(未标)";
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return counts;
	};
	return {
		corpus: header.corpus,
		file: result.file,
		proposed: result.index.entries.length + result.dropped,
		survived: result.index.entries.length,
		dropped: result.dropped,
		dropReasons: result.dropReasons,
		parseError: result.parseError,
		fieldWarnings: result.fieldWarnings,
		summaryTruncated: result.summaryTruncated.length,
		header: {
			indexer: header.indexer ?? null,
			tier: header.tier ?? null,
			libraryKind: header.libraryKind ?? null,
			candidateCount: header.candidateCount ?? null,
		},
		stats: {
			withTargets: result.index.entries.filter((entry) => entry.targets.length > 0).length,
			withPeripherals: result.index.entries.filter((entry) => entry.peripherals.length > 0).length,
			entryKinds: tally((entry) => entry.entryKind),
			tiers: tally((entry) => entry.tier),
			targetSources: tally((entry) => entry.targetSource),
		},
	};
}

async function commandIndex(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			ecosystem: { type: "string" },
			root: { type: "string" },
			corpus: { type: "string" },
			"config-dir": { type: "string" },
			"description-file": { type: "string" },
			model: { type: "string" },
			proposal: { type: "string" },
			tier: { type: "string" },
			indexer: { type: "string" },
			json: { type: "boolean" },
		},
	});
	if (!values.ecosystem || !isEcosystem(values.ecosystem)) {
		fail(`--ecosystem 必须是 esp-idf / stm32cube / generic,收到:${values.ecosystem ?? "(空)"}`);
	}
	if (!values.root) fail("--root 必填:语料检出目录");
	// --indexer 只在 --proposal 分支被读。不拦的话它会被静默忽略:调用方以为登记的是
	// provided,实际照样调了模型花了钱,而 header 里写的是 indexer="llm"。
	if (values.indexer !== undefined && !values.proposal) {
		fail("--indexer 只在带 --proposal 时有意义(它说的是这份提议是谁给的);"
			+ "不带 --proposal 走的是一次性调用,通道恒为 llm");
	}
	const started = Date.now();
	// tier 对两条通道都有效 —— 机械抽取器自己判不出分层,但登记方给得出。
	const tier = parseTierFlag(values.tier, "--tier");

	// generic = AI 索引(PLAN-codelib-console D2/D11):说明经文件传入,模型提议条目、
	// 代码核验。与 rag_yoma/codelib 复制品同一份(generic.ts 同步维护)。
	if (values.ecosystem === "generic") {
		const corpusId = values.corpus;
		if (!corpusId) fail("generic 生态必须带 --corpus <id>(如 my-project@abc12345)");

		// --proposal:自带提议,不调模型。服务器侧跑 agent(indexer=agent)与调用方
		// 自带索引(indexer=provided)走的是同一条路 —— **产出照样原样过核验层**,
		// 外部产出一律不可信,这是「模型提议、代码裁决」不能绕的那道闸门。
		if (values.proposal) {
			let raw: string;
			try {
				raw = readFileSync(values.proposal, "utf8");
			} catch (e) {
				fail(`读不到 --proposal:${values.proposal}(${e instanceof Error ? e.message : String(e)})`);
			}
			let indexer: Indexer = "provided";
			if (values.indexer !== undefined) {
				if (!isIndexer(values.indexer)) fail(`--indexer 只认 ${INDEXERS.join(" / ")},收到:${values.indexer}`);
				if (values.indexer !== "provided" && values.indexer !== "agent") {
					fail(`--proposal 只配 --indexer provided / agent(产出是谁给的),收到:${values.indexer}`);
				}
				indexer = values.indexer;
			}
			const result = verifyProposal({
				root: values.root,
				corpusId,
				proposal: raw,
				configDir: values["config-dir"],
				tier,
				indexer,
			});
			if (values.json) console.log(JSON.stringify(indexResultJson(result)));
			else console.log(renderIndexNotes(result, { how: `自带提议(${indexer})核验后`, started }));
			// 解析失败必须非零退出:否则管线会把一份空索引当成"这个库没东西可索引"
			// 照常发布出去 —— 那是被 max_tokens 截断那个 bug 的形态,只是换了条通道。
			if (result.parseError) process.exit(1);
			return;
		}

		if (!values["description-file"]) {
			fail("generic 生态必须带 --description-file(说明文本文件),或 --proposal(自带提议,不调模型)");
		}
		let description: string;
		try {
			description = readFileSync(values["description-file"], "utf8").trim();
		} catch (e) {
			fail(`读不到 --description-file:${values["description-file"]}(${e instanceof Error ? e.message : String(e)})`);
		}
		if (!description) fail("--description-file 是空的 —— 说明必填(AI 索引以它为参考)");
		const usage = { cost: 0, calls: 0 };
		// 提示词允许 200 条 x 实测 ~45 token/条 ≈ 9000,给到模型单次输出上限。
		const complete = await makeCompletion(values.model ?? DEFAULT_ENRICH_MODEL, values["config-dir"], usage, 8192);
		const result = await indexGeneric({
			root: values.root,
			corpusId,
			description,
			configDir: values["config-dir"],
			complete,
			model: values.model ?? DEFAULT_ENRICH_MODEL,
			tier,
			indexer: "llm",
		});
		if (values.json) console.log(JSON.stringify(indexResultJson(result)));
		else console.log(renderIndexNotes(result, { how: "AI 索引", started, cost: usage.cost }));
		// 与 --proposal 分支同一道闸门。从前只有那边有,于是模型输出被 max_tokens 截断时
		// 这条路退出码 0、落一份 entries=0 的索引,管线照常打包发布 —— 与「这个库确实
		// 没东西可索引」在产物上完全不可区分。要归档不建索引请用 indexer:"none"。
		if (result.parseError) process.exit(1);
		return;
	}

	const { index, file } = indexCorpus({
		root: values.root,
		ecosystem: values.ecosystem as Ecosystem,
		corpusId: values.corpus,
		configDir: values["config-dir"],
		tier,
	});
	const buildableCount = index.entries.filter((entry) => entry.buildable).length;
	console.log(
		[
			`语料 ${index.header.corpus}(commit ${index.header.commit ?? "未知"})`,
			`索引 ${index.entries.length} 条(可编 ${buildableCount}),用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
			`落盘 ${file}`,
		].join("\n"),
	);
}

function collectMulti(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(","));
	const cleaned = list.map((item) => item.trim()).filter((item) => item !== "");
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 数值 flag 一律在边界校验:parseInt 的 NaN 漂进下游就是"零工作、零报错、退出码 0"
 * (对抗审查实测:--concurrency abc 起 0 个 worker;search 的 limit NaN 把结果
 * slice 成空,读起来就是"没有命中")。
 */
function parseCountFlag(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) fail(`${flag} 必须是 ≥1 的整数,收到:${value}`);
	return parsed;
}

function findEntryAcross(indexes: ExamplesIndex[], id: string): ExampleEntry | undefined {
	for (const index of indexes) {
		const entry = index.entries.find((item) => item.id === id);
		if (entry) return entry;
	}
	return undefined;
}

/**
 * 装配真模型的补全函数。凭据/注册表全部走 acp 的 resolveModel(configDir 必须显式,
 * yoma 2026-08 的决定)—— 这里不重写 provider 表,免得又长出一份要防漂移的复制。
 */
async function makeCompletion(
	modelRef: string,
	configDir: string | undefined,
	usage: { cost: number; calls: number },
	maxTokens = 2400,
): Promise<EnrichCompletion> {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) {
		fail(`--model 形如 provider/model(如 ${DEFAULT_ENRICH_MODEL}),收到:${modelRef}`);
	}
	const providerId = modelRef.slice(0, slash);
	const modelId = modelRef.slice(slash + 1);
	const { models } = await resolveModel(configDir ?? join(homedir(), ".yoma"));
	const model = models.getModel(providerId, modelId);
	if (!model) {
		fail(`模型 ${modelRef} 不可用 —— provider 没配 key,或模型 id 不在目录里`);
	}
	return async (system, user) => {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
			},
			// 2400:1600 实测会把长卡片(蓝牙吞吐这类)截在 JSON 中间,重试也同样截断。
			// 但 2400 只够 enrich 的"一次一张卡片"。generic 索引是"一次吐 N 条"的批量
			// 任务:实测 ~45 token/条,2400 只装得下 ~53 条,大仓必然截断 -> JSON 解析
			// 失败 -> 0 条。所以上限按用途传进来,不写死。
			{ maxTokens },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `补全失败(${response.stopReason})`);
		}
		usage.calls++;
		usage.cost += response.usage.cost.total;
		return response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
	};
}

async function commandEnrich(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			corpus: { type: "string", multiple: true },
			model: { type: "string" },
			concurrency: { type: "string" },
			limit: { type: "string" },
			"config-dir": { type: "string" },
		},
	});
	const configDir = values["config-dir"];
	const indexes = readAllIndexes(configDir);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	const wanted = collectMulti(values.corpus);
	if (wanted) {
		const known = new Set(indexes.map((index) => index.header.corpus));
		const missing = wanted.filter((id) => !known.has(id));
		if (missing.length > 0) fail(`没有这些语料的索引:${missing.join(",")} —— 用 list 看已有语料`);
	}
	const corpora = wanted ? indexes.filter((index) => wanted.includes(index.header.corpus)) : indexes;

	const modelRef = values.model ?? DEFAULT_ENRICH_MODEL;
	const usage = { cost: 0, calls: 0 };
	const complete = await makeCompletion(modelRef, configDir, usage);

	for (const index of corpora) {
		const corpusId = index.header.corpus;
		const started = Date.now();
		console.log(`语料 ${corpusId}(${index.entries.length} 条),模型 ${modelRef}:`);
		const result = await enrichCorpus({
			corpusId,
			configDir,
			complete,
			model: modelRef,
			concurrency: parseCountFlag(values.concurrency, "--concurrency"),
			limit: parseCountFlag(values.limit, "--limit"),
			onProgress: (progress) => {
				if (!progress.ok) console.error(`  ✗ ${progress.id}:${progress.error}`);
				else if (progress.done % 25 === 0 || progress.done === progress.total) {
					console.log(`  ${progress.done}/${progress.total}`);
				}
			},
		});
		const minutes = ((Date.now() - started) / 60_000).toFixed(1);
		console.log(
			[
				`  已有 ${result.already},本次成 ${result.enriched},败 ${result.failed.length},用时 ${minutes} 分钟`,
				`  落盘 ${enrichPathFor(corpusId, configDir)}`,
				result.failed.length > 0 ? "  失败的条目未落盘,重跑本命令自动补齐" : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	console.log(`共 ${usage.calls} 次调用,费用 ~$${usage.cost.toFixed(2)}`);
}

function commandPreflight(argv: string[]): void {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { "config-dir": { type: "string" } },
		allowPositionals: true,
	});
	if (positionals.length < 2) fail("preflight 需要至少 2 个条目 id:底盘在前,供体在后");
	if (new Set(positionals).size !== positionals.length) fail("preflight 的 id 里有重复条目");
	const indexes = readAllIndexes(values["config-dir"]);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	const enrichment = enrichmentMapForAll(indexes, values["config-dir"]);
	const inputs: PreflightInput[] = positionals.map((id, position) => {
		const entry = findEntryAcross(indexes, id);
		if (!entry) fail(`找不到条目:${id} —— 用 search 拿确切 id`);
		const record = enrichment.get(id);
		return {
			entry,
			role: position === 0 ? "chassis" : "donor",
			...(record ? { card: record.card } : {}),
		};
	});
	console.log(renderPreflightReport(inputs, checkMergeConflicts(inputs)));
}

function commandSearch(argv: string[]): void {
	const { values } = parseArgs({
		args: argv,
		options: {
			ecosystem: { type: "string" },
			target: { type: "string" },
			board: { type: "string" },
			peripheral: { type: "string", multiple: true },
			keyword: { type: "string", multiple: true },
			buildable: { type: "boolean" },
			tier: { type: "string" },
			kind: { type: "string", multiple: true },
			corpus: { type: "string", multiple: true },
			json: { type: "boolean" },
			limit: { type: "string" },
			"config-dir": { type: "string" },
		},
	});
	if (values.ecosystem !== undefined && !isEcosystem(values.ecosystem)) {
		fail(`--ecosystem 必须是 esp-idf / stm32cube / generic,收到:${values.ecosystem}`);
	}
	const kinds = collectMulti(values.kind);
	for (const kind of kinds ?? []) {
		if (!isEntryKind(kind)) fail(`--kind 只认 ${ENTRY_KINDS.join(" / ")},收到:${kind}`);
	}
	// "all" 是查询侧独有的档位(条目上不存在),所以不能直接走 isTier。
	const tier = values.tier === "all" ? "all" : parseTierFlag(values.tier, "--tier(或 all)");
	const indexes = readAllIndexes(values["config-dir"]);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	const query: SearchQuery = {
		ecosystem: values.ecosystem as Ecosystem | undefined,
		target: values.target,
		board: values.board,
		peripherals: collectMulti(values.peripheral),
		keywords: collectMulti(values.keyword),
		buildableOnly: values.buildable,
		tier,
		entryKind: kinds as EntryKind[] | undefined,
		corpora: collectMulti(values.corpus),
		limit: parseCountFlag(values.limit, "--limit"),
	};
	const entries = indexes.flatMap((index) => index.entries);
	const enrichment = enrichmentMapForAll(indexes, values["config-dir"]);
	const hits = searchIndex(entries, query, enrichment);
	// --json 是给**服务器端检索**用的(rag_yoma 的 POST /api/codelibs/search):服务器
	// 不重写一份检索实现,而是拿 bun 跑这里,拿到的就必然与客户端 searchIndex 严格
	// 同语义 ——「两份实现必然漂移」在 search.ts 那份副本上已经吃过一次亏了。
	if (values.json) {
		console.log(JSON.stringify({
			corpora: indexes.map((index) => ({
				id: index.header.corpus,
				ecosystem: index.header.ecosystem,
				entries: index.header.entries,
				indexer: index.header.indexer ?? null,
				tier: index.header.tier ?? null,
			})),
			query,
			hits,
		}));
		return;
	}
	console.log(renderSearchReport(indexes, query, hits));
}

function commandShow(argv: string[]): void {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { "config-dir": { type: "string" } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) fail("show 需要一个条目 id(search 结果里的第一列)");
	const indexes = readAllIndexes(values["config-dir"]);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	for (const index of indexes) {
		const entry = index.entries.find((item) => item.id === id);
		if (entry) {
			const source = findSource(entry.corpus, values["config-dir"]);
			const enrichment = enrichmentMapForAll([index], values["config-dir"]).get(id);
			console.log(renderEntryCard(entry, { commit: index.header.commit, corpusRoot: source?.root, enrichment }));
			return;
		}
	}
	fail(`找不到条目:${id} —— 用 list 看已有语料,search 找候选`);
}

function commandList(argv: string[]): void {
	const { values } = parseArgs({ args: argv, options: { "config-dir": { type: "string" } } });
	const indexes = readAllIndexes(values["config-dir"]);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	for (const index of indexes) {
		const source = findSource(index.header.corpus, values["config-dir"]);
		const buildableCount = index.entries.filter((entry) => entry.buildable).length;
		console.log(
			`${index.header.corpus} | ${index.header.ecosystem} | ${index.entries.length} 条(可编 ${buildableCount})| 生成于 ${index.header.generatedAt}${source ? ` | 语料根 ${source.root}` : " | 语料根未记账(seed 不可用)"}`,
		);
	}
}

function formatGB(bytes: number): string {
	return `${(bytes / 1e9).toFixed(2)} GB`;
}

async function commandSync(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			server: { type: "string" },
			code: { type: "boolean" },
			"config-dir": { type: "string" },
		},
		allowPositionals: true,
	});
	const server = resolveSyncServer(values.server);
	if (!server) fail("--server 必填,或设 YOMA_DATASHEET_SERVER 环境变量(当前两者皆空)");
	const configDir = values["config-dir"];

	let remote: CodelibMeta[];
	try {
		remote = await listRemoteCorpora(server);
	} catch (error) {
		fail(`sync:${error instanceof Error ? error.message : String(error)}`);
	}
	if (positionals.length === 0) {
		console.log(`服务器 ${server}:${remote.length === 0 ? "没有已发布的语料" : ""}`);
		const local = new Map(readSources(configDir).corpora.map((s) => [s.id, s]));
		for (const meta of remote) {
			const source = local.get(meta.id);
			let state: string;
			if (source && source.root.trim() !== "") state = `本机检出(${source.root})`;
			else if (source?.remote && readCorpusMarker(meta.id, configDir)?.archiveSha256 === source.remote.archiveSha256) {
				state = `代码缓存就绪(${corpusCacheDir(meta.id, configDir)})`;
			} else if (source) state = "索引就绪,代码未落地(--code 可落地)";
			else state = "未同步";
			console.log(
				`${meta.id} | ${meta.ecosystem} | ${meta.entries ?? "?"} 条 | ${formatGB(meta.archiveBytes)} | ${state}${meta.description ? ` | ${meta.description}` : ""}`,
			);
		}
		return;
	}

	for (const id of positionals) {
		let meta = remote.find((m) => m.id === id);
		if (!meta) meta = await fetchCodelibMeta(server, id); // 服务器上存在但不在缓存过的清单里(刚发布)
		const index = await syncIndex(server, meta, configDir, {
			onPhase: (phase) => console.log(phase),
		});
		console.log(`${id}: 索引就绪${index.downloaded.length > 0 ? `(下载了 ${index.downloaded.join("、")})` : "(本地已是最新)"}`);
		if (values.code) {
			let lastReport = 0;
			const result = await syncCorpus(server, meta, configDir, {
				onPhase: (phase) => console.log(phase),
				onBytes: (file, bytes) => {
					// 每 ~200MB 报一次进度,别刷屏。
					if (file === "archive.tar.gz" && meta !== undefined && bytes - lastReport >= 200_000_000) {
						lastReport = bytes;
						const pct = meta.archiveBytes > 0 ? Math.min(100, Math.round((bytes / meta.archiveBytes) * 100)) : "?";
						console.log(`  archive ${formatGB(bytes)}(${pct}%)`);
					}
				},
			});
			console.log(
				`${id}: ${result.skipped ? "代码缓存已就绪,跳过" : `代码落地完成(${formatGB(result.bytes)})`} → ${corpusCacheDir(id, configDir)}`,
			);
		}
	}
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case "index":
		await commandIndex(rest);
		break;
	case "enrich":
		await commandEnrich(rest);
		break;
	case "sync":
		await commandSync(rest);
		break;
	case "search":
		commandSearch(rest);
		break;
	case "show":
		commandShow(rest);
		break;
	case "preflight":
		commandPreflight(rest);
		break;
	case "list":
		commandList(rest);
		break;
	default:
		fail(USAGE);
}
