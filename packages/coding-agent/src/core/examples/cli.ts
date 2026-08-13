/**
 * 例程库 CLI:索引与富化都是离线生成的(语料在哪台机器,这些命令就在哪台机器跑;
 * 将来搬服务器,跑的还是它们)。检索/查看只是索引的只读视图,方便不进会话先验质量。
 *
 *   bun packages/coding-agent/src/core/examples/cli.ts index  --ecosystem esp-idf --root <目录> [--corpus <id>] [--config-dir <目录>]
 *   bun packages/coding-agent/src/core/examples/cli.ts enrich [--corpus <id>]... [--model <provider/model>] [--concurrency <n>] [--limit <n>]
 *   bun packages/coding-agent/src/core/examples/cli.ts search [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p> ...] [--keyword <k> ...] [--buildable] [--limit <n>]
 *   bun packages/coding-agent/src/core/examples/cli.ts show   <条目 id>
 *   bun packages/coding-agent/src/core/examples/cli.ts preflight <底盘id> <供体id>...
 *   bun packages/coding-agent/src/core/examples/cli.ts list
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveModel } from "../../acp/models.ts";
import { type EnrichCompletion, enrichCorpus } from "./enrich.ts";
import { indexCorpus } from "./indexer.ts";
import { checkMergeConflicts, type PreflightInput } from "./preflight.ts";
import { renderEntryCard, renderNoIndexHelp, renderPreflightReport, renderSearchReport } from "./render.ts";
import { type Ecosystem, type ExampleEntry, type ExamplesIndex, isEcosystem } from "./schema.ts";
import { searchIndex, type SearchQuery } from "./search.ts";
import { enrichmentMapForAll, enrichPathFor, findSource, readAllIndexes } from "./store.ts";

const USAGE = `用法:
  cli.ts index     --ecosystem esp-idf|stm32cube --root <语料目录> [--corpus <id>] [--config-dir <目录>]
  cli.ts enrich    [--corpus <id>]... [--model <provider/model>] [--concurrency <n>] [--limit <n>] [--config-dir <目录>]
  cli.ts search    [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p>]... [--keyword <k>]... [--buildable] [--limit <n>] [--config-dir <目录>]
  cli.ts show      <条目 id> [--config-dir <目录>]
  cli.ts preflight <底盘id> <供体id>... [--config-dir <目录>]
  cli.ts list      [--config-dir <目录>]`;

/** 与 bench 的 DEFAULT_MODEL 同一取舍:Flash 便宜三倍,富化是一次性大批量,便宜赢。 */
const DEFAULT_ENRICH_MODEL = "deepseek/deepseek-v4-flash";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function commandIndex(argv: string[]): void {
	const { values } = parseArgs({
		args: argv,
		options: {
			ecosystem: { type: "string" },
			root: { type: "string" },
			corpus: { type: "string" },
			"config-dir": { type: "string" },
		},
	});
	if (!values.ecosystem || !isEcosystem(values.ecosystem)) {
		fail(`--ecosystem 必须是 esp-idf 或 stm32cube,收到:${values.ecosystem ?? "(空)"}`);
	}
	if (!values.root) fail("--root 必填:语料检出目录");
	const started = Date.now();
	const { index, file } = indexCorpus({
		root: values.root,
		ecosystem: values.ecosystem as Ecosystem,
		corpusId: values.corpus,
		configDir: values["config-dir"],
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
 * my-pi 2026-08 的决定)—— 这里不重写 provider 表,免得又长出一份要防漂移的复制。
 */
async function makeCompletion(
	modelRef: string,
	configDir: string | undefined,
	usage: { cost: number; calls: number },
): Promise<EnrichCompletion> {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) {
		fail(`--model 形如 provider/model(如 ${DEFAULT_ENRICH_MODEL}),收到:${modelRef}`);
	}
	const providerId = modelRef.slice(0, slash);
	const modelId = modelRef.slice(slash + 1);
	const { models } = await resolveModel(configDir ?? join(homedir(), ".my-pi"));
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
			{ maxTokens: 2400 },
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
			limit: { type: "string" },
			"config-dir": { type: "string" },
		},
	});
	if (values.ecosystem !== undefined && !isEcosystem(values.ecosystem)) {
		fail(`--ecosystem 必须是 esp-idf 或 stm32cube,收到:${values.ecosystem}`);
	}
	const indexes = readAllIndexes(values["config-dir"]);
	if (indexes.length === 0) fail(renderNoIndexHelp());
	const query: SearchQuery = {
		ecosystem: values.ecosystem as Ecosystem | undefined,
		target: values.target,
		board: values.board,
		peripherals: collectMulti(values.peripheral),
		keywords: collectMulti(values.keyword),
		buildableOnly: values.buildable,
		limit: parseCountFlag(values.limit, "--limit"),
	};
	const entries = indexes.flatMap((index) => index.entries);
	const enrichment = enrichmentMapForAll(indexes, values["config-dir"]);
	console.log(renderSearchReport(indexes, query, searchIndex(entries, query, enrichment)));
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

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case "index":
		commandIndex(rest);
		break;
	case "enrich":
		await commandEnrich(rest);
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
