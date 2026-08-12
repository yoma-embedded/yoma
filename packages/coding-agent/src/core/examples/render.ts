/**
 * 检索结果与卡片的文本渲染。CLI(给人看)与 examples 工具(给模型看)共用同一份 ——
 * 两边口径不一致时,模型在会话里看到的和你在终端调出来的对不上,查问题会互相指认。
 * 全部纯函数。
 */

import type { ExampleEntry, ExamplesIndex } from "./schema.ts";
import type { ScoredExample, SearchQuery } from "./search.ts";

export function renderHit(hit: ScoredExample): string {
	const entry = hit.entry;
	const targets = entry.targets.length > 0 ? entry.targets.join(",") : "targets:未知";
	const parts = [
		`- ${entry.id}`,
		`  ${entry.title ?? entry.name} | ${targets} | ${entry.peripherals.join("/") || "无外设标注"} | ${entry.loc} 行 | ${entry.buildable ? "可编" : "只读"}`,
	];
	if (hit.reasons.length > 0) parts.push(`  得分 ${hit.score}:${hit.reasons.join(";")}`);
	return parts.join("\n");
}

export function describeQuery(query: SearchQuery): string {
	const parts: string[] = [];
	if (query.ecosystem) parts.push(`生态=${query.ecosystem}`);
	if (query.target) parts.push(`芯片=${query.target}`);
	if (query.board) parts.push(`板=${query.board}`);
	if (query.peripherals?.length) parts.push(`外设=${query.peripherals.join(",")}`);
	if (query.keywords?.length) parts.push(`关键词=${query.keywords.join(",")}`);
	if (query.buildableOnly) parts.push("仅可编");
	return parts.length > 0 ? parts.join(" ") : "(无过滤条件)";
}

export function renderSearchReport(indexes: ExamplesIndex[], query: SearchQuery, hits: ScoredExample[]): string {
	const corpora = indexes.map((index) => `${index.header.corpus}(${index.header.entries} 条)`).join("、");
	const head = `检索 ${describeQuery(query)} —— 语料:${corpora}`;
	if (hits.length === 0) {
		return `${head}\n\n没有命中。硬过滤条件(芯片/生态/外设)是排除式的 —— 放宽外设或关键词再试;芯片条件别放宽,物理不可用的种子没有意义。`;
	}
	return `${head}\n\n${hits.map(renderHit).join("\n")}\n\n用 info 看整卡,seed 拷进工作区起步。`;
}

export function renderNoIndexHelp(): string {
	return [
		"本机还没有任何例程索引。",
		"索引由 CLI 离线生成(语料在哪台机器,索引就在哪台机器跑):",
		"  bun packages/coding-agent/src/core/examples/cli.ts index --ecosystem esp-idf --root <esp-idf 检出目录>",
		"  bun packages/coding-agent/src/core/examples/cli.ts index --ecosystem stm32cube --root <STM32Cube 固件包目录>",
		"生成后重试本次检索。",
	].join("\n");
}

export function renderEntryCard(entry: ExampleEntry, options?: { commit?: string; corpusRoot?: string }): string {
	const lines = [
		`${entry.id}`,
		`  ${entry.title ?? entry.name}`,
		entry.summary ? `  ${entry.summary}` : undefined,
		`  生态 ${entry.ecosystem} | 语料 ${entry.corpus}${options?.commit ? `(commit ${options.commit})` : ""}`,
		`  路径 ${entry.path}`,
		`  芯片 ${entry.targets.join(",") || "未知(元数据缺失,用前自行核对)"}${entry.board ? ` | 板 ${entry.board}` : ""}`,
		`  外设 ${entry.peripherals.join(",") || "无标注"}`,
		entry.deps?.length ? `  组件依赖 ${entry.deps.join(",")}` : undefined,
		entry.configKeys?.length ? `  Kconfig ${entry.configKeys.join(",")}` : undefined,
		entry.acceptance ? `  验收素材 ${entry.acceptance.path}(厂商 CI 判据,绿点验证的现成参考)` : undefined,
		`  ${entry.buildable ? "可编" : "只读(不可作底盘)"}${entry.buildNote ? ` —— ${entry.buildNote}` : ""}`,
		entry.license ? `  License ${entry.license}` : undefined,
		`  ${entry.loc} 行源码 / ${entry.files} 个文件`,
		options?.corpusRoot ? `  本机语料根 ${options.corpusRoot}` : undefined,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}
