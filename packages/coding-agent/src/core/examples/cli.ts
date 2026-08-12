/**
 * 例程库 CLI:索引是离线生成的(语料在哪台机器,这条命令就在哪台机器跑;
 * 将来搬服务器,跑的还是它)。检索/查看只是索引的只读视图,方便不进会话先验质量。
 *
 *   bun packages/coding-agent/src/core/examples/cli.ts index  --ecosystem esp-idf --root <目录> [--corpus <id>] [--config-dir <目录>]
 *   bun packages/coding-agent/src/core/examples/cli.ts search [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p> ...] [--keyword <k> ...] [--buildable] [--limit <n>]
 *   bun packages/coding-agent/src/core/examples/cli.ts show   <条目 id>
 *   bun packages/coding-agent/src/core/examples/cli.ts list
 */

import { parseArgs } from "node:util";

import { indexCorpus } from "./indexer.ts";
import { renderEntryCard, renderNoIndexHelp, renderSearchReport } from "./render.ts";
import { type Ecosystem, isEcosystem } from "./schema.ts";
import { searchIndex, type SearchQuery } from "./search.ts";
import { findSource, readAllIndexes } from "./store.ts";

const USAGE = `用法:
  cli.ts index  --ecosystem esp-idf|stm32cube --root <语料目录> [--corpus <id>] [--config-dir <目录>]
  cli.ts search [--ecosystem <e>] [--target <t>] [--board <b>] [--peripheral <p>]... [--keyword <k>]... [--buildable] [--limit <n>] [--config-dir <目录>]
  cli.ts show   <条目 id> [--config-dir <目录>]
  cli.ts list   [--config-dir <目录>]`;

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
		limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
	};
	const entries = indexes.flatMap((index) => index.entries);
	console.log(renderSearchReport(indexes, query, searchIndex(entries, query)));
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
			console.log(renderEntryCard(entry, { commit: index.header.commit, corpusRoot: source?.root }));
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
	case "search":
		commandSearch(rest);
		break;
	case "show":
		commandShow(rest);
		break;
	case "list":
		commandList(rest);
		break;
	default:
		fail(USAGE);
}
