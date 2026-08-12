/**
 * 例程库子系统的桶文件。kernel 与 bench 只认包名(@yoma/my-pi-coding-agent),
 * 不做深引用 —— 本目录的公开面全部经这里再经包主入口 src/index.ts 出去,
 * 与 core/toolchain/index.ts 同一纪律。
 */
export {
	capabilitiesFromSource,
	ESPIDF_EXTRACTOR_VERSION,
	extractEspIdfExamples,
	normalizeEspTarget,
	parseComponentDeps,
	parseConfigKeys,
	parseReadmeSummary,
	parseSupportedTargets,
} from "./espidf.ts";
export { type RawExample } from "./extract-util.ts";
export { type BuildIndexOptions, buildIndex, detectGitCommit, indexCorpus, type IndexCorpusResult } from "./indexer.ts";
export {
	type CorpusSource,
	corpusSlug,
	ECOSYSTEMS,
	type Ecosystem,
	emptySources,
	type ExampleAcceptance,
	type ExampleEntry,
	type ExamplesIndex,
	type ExamplesIndexHeader,
	type ExamplesSources,
	INDEX_SCHEMA_TAG,
	isEcosystem,
	isExampleEntry,
	isIndexHeader,
	parseIndex,
	parseSources,
	serializeIndex,
	SOURCES_SCHEMA_TAG,
} from "./schema.ts";
export { describeQuery, renderEntryCard, renderHit, renderNoIndexHelp, renderSearchReport } from "./render.ts";
export { normalizeTarget, type ScoredExample, searchIndex, type SearchQuery, targetMatches } from "./search.ts";
export {
	SEED_PROVENANCE_FILE,
	SEED_SCHEMA_TAG,
	type SeedProvenance,
	type SeedResult,
	seedExample,
	shouldCopy,
} from "./seed.ts";
export {
	examplesDir,
	findSource,
	indexDir,
	indexPathFor,
	readAllIndexes,
	readIndexFile,
	readSources,
	sourcesPath,
	upsertSource,
	writeIndexFile,
} from "./store.ts";
export {
	cubeBuildState,
	detectCubeFamily,
	extractStm32CubeExamples,
	parseCubeDescription,
	parseCubeTitle,
	peripheralsFromCubeSource,
	STM32CUBE_EXTRACTOR_VERSION,
} from "./stm32cube.ts";
