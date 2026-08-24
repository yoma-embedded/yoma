/**
 * 检索:硬过滤在前(排除,不降权),确定性打分在后。为什么不是向量库:芯片/生态是
 * 物理可用性,纯语义排序会把 STM32 的例程排到 ESP32 需求的第一位 —— 语义完美,
 * 物理不可用。候选收进十来条,重排器就是读结果的 agent 本身。
 *
 * 纯函数,零 IO —— 读索引在 store.ts,这里只算。同输入必同输出(score 降序 →
 * loc 升序 → id 字典序),索引没变时两次搜索必须一字不差。
 */

import type { EnrichmentRecord } from "./enrich-schema.ts";
import type { Ecosystem, EntryKind, ExampleEntry, Tier } from "./schema.ts";

/**
 * 生态的芯片前缀:targets 为空(元数据缺失)的条目要靠它兜住跨生态泄漏 ——
 * esp-idf 的例程永远跑不上 stm32f103,"未知不排除"只在同生态内成立。
 */
const ECOSYSTEM_TARGET_PREFIXES: Record<Ecosystem, string> = {
	"esp-idf": "esp",
	stm32cube: "stm32",
	// generic 条目由 AI 索引产出:targets 不确定就留空,按 schema 语义不排除;
	// 填了的按字面前缀走(如 "stm32f4")。
	generic: "",
};

export interface SearchQuery {
	ecosystem?: Ecosystem;
	/** 芯片,硬过滤。查询按条目 targets 的前缀匹配:stm32f407 命中 stm32f4;esp32s3 不命中 esp32。 */
	target?: string;
	/** 板名,软偏好 —— 官方例程钉在官方板,你的板多半不同,排除是错的。 */
	board?: string;
	/** 给了就至少命中一个,零命中排除 —— 这是"按能力单元检索"的本意。 */
	peripherals?: string[];
	/** 命中 title/name +2、summary/path +1。 */
	keywords?: string[];
	/** 只要底盘资格(能编)的。找供体(只读代码)时别开。 */
	buildableOnly?: boolean;
	/**
	 * 分层过滤。缺省按"带不带芯片"分:带 `target` 时默认 `"seed"`,不带时 `"all"` ——
	 * 分层是给「笼统查询」兜底的(实测:只给 stm32f407 时命中从 47 条炸到 375 条,
	 * 前 8 名全被库本体占),带外设的具体查询本来就不会被淹。
	 *
	 * - `"all"`   不按分层过滤
	 * - `"seed"`  排除**显式标了 `lib`** 的条目;**未标的不排除** —— 与 targets 空数组
	 *             同一条纪律,而且旧索引一条 tier 都没有,不这样写就等于把它们全部隐掉
	 * - `"lib"`   只留显式标了 `lib` 的 —— 显式要库本体是主动收窄,未标的不在其中
	 */
	tier?: Tier | "all";
	/**
	 * 粒度过滤。给了就只留这些粒度,**未标粒度的条目会被排除** —— 与 tier 的
	 * "未标不排除"相反,因为按粒度筛本身就是显式收窄(要 project 就是不要整棵树)。
	 */
	entryKind?: EntryKind | EntryKind[];
	/** 只在这些语料 id 里找。空/不给 = 全部。 */
	corpora?: string[];
	limit?: number;
}

export interface ScoredExample {
	entry: ExampleEntry;
	score: number;
	/** 给模型看的加分理由 —— 排序要可查账,不是黑盒。 */
	reasons: string[];
	/** 有富化卡片时带上 —— 渲染层展示模型摘要,免得命中之后还要挨个 info。 */
	enrichment?: EnrichmentRecord;
}

export function normalizeTarget(value: string): string {
	return value.trim().toLowerCase().replaceAll("-", "");
}

/**
 * 条目 targets 任一是查询芯片的前缀即命中(家族级语料标 stm32f4,查 stm32f407 要中);
 * targets 为空 = 元数据缺失,**不排除** —— 缺元数据是"不知道"不是"不支持",
 * 隐掉候选比多列一条更糟,打分侧不给它芯片分并在理由里明说。
 */
export function targetMatches(queryTarget: string, entryTargets: string[]): boolean {
	if (entryTargets.length === 0) return true;
	const wanted = normalizeTarget(queryTarget);
	return entryTargets.some((target) => wanted.startsWith(normalizeTarget(target)));
}

function locBonus(loc: number): number {
	if (loc < 200) return 3;
	if (loc < 500) return 2;
	if (loc < 1000) return 1;
	return 0;
}

/**
 * enrichment(可选)是富化表(store.ts 的 enrichmentMapForAll):有卡片的条目,
 * 外设匹配并上模型标的能力词(脚本抽不到的 lowpower/ota 这类靠它),关键词弱命中
 * 多一份中文摘要可搜。没有富化时行为与从前逐字相同 —— 富化只增益,不改底线。
 */
export function searchIndex(
	entries: ExampleEntry[],
	query: SearchQuery,
	enrichment?: ReadonlyMap<string, EnrichmentRecord>,
): ScoredExample[] {
	const peripherals = (query.peripherals ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item !== "");
	const keywords = (query.keywords ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item !== "");
	// Number.isFinite 而不是 ??:limit 为 NaN 时 slice(0, NaN) 是空数组,主检索路径
	// 直接变成"没有命中"的假阴性(审查实测)。
	const limit = Number.isFinite(query.limit) ? (query.limit as number) : 12;
	// 分层默认值只看"带不带芯片" —— 见 SearchQuery.tier 的注释。
	const tierMode: Tier | "all" = query.tier ?? (query.target ? "seed" : "all");
	// 空数组 = 不过滤,与 corpora / peripherals 同一口径。不这样写的话 `[]` 是真值,
	// 下面每一条都判 `![].includes(...)` 为真 → 逐条排除 → 零命中,而调用方(工具 schema
	// 里 entryKind 是可选数组,传空数组完全合法)从报告里根本看不出发生了什么。
	const kindList = query.entryKind === undefined
		? []
		: Array.isArray(query.entryKind)
			? query.entryKind
			: [query.entryKind];
	const kinds = kindList.length > 0 ? kindList : undefined;
	const corpora = (query.corpora ?? []).map((item) => item.trim()).filter((item) => item !== "");

	const scored: ScoredExample[] = [];
	for (const entry of entries) {
		const record = enrichment?.get(entry.id);
		if (corpora.length > 0 && !corpora.includes(entry.corpus)) continue;
		if (query.ecosystem && entry.ecosystem !== query.ecosystem) continue;
		// entry.tier 已经在 parseIndex 里继承过语料级默认值,这里看到的就是最终值。
		if (tierMode === "seed" && entry.tier === "lib") continue;
		if (tierMode === "lib" && entry.tier !== "lib") continue;
		if (kinds && (entry.entryKind === undefined || !kinds.includes(entry.entryKind))) continue;
		if (query.target && !targetMatches(query.target, entry.targets)) continue;
		if (
			query.target &&
			entry.targets.length === 0 &&
			!normalizeTarget(query.target).startsWith(ECOSYSTEM_TARGET_PREFIXES[entry.ecosystem])
		) {
			continue;
		}
		if (query.buildableOnly && !entry.buildable) continue;

		const reasons: string[] = [];
		let score = 0;

		if (peripherals.length > 0) {
			const capabilities = record ? [...entry.peripherals, ...record.card.capabilities] : entry.peripherals;
			const hits = peripherals.filter((peripheral) => capabilities.includes(peripheral));
			if (hits.length === 0) continue;
			score += hits.length * 3;
			reasons.push(`外设命中 ${hits.join("/")}`);
		}

		if (query.target) {
			if (entry.targets.length === 0) reasons.push("芯片元数据缺失,未据此排除 —— 用前自行核对");
			else reasons.push(`芯片匹配 ${entry.targets.join(",")}`);
		}

		// 分层/粒度/证据来源进**理由**不进打分:它们是过滤条件与可信度提示,不是
		// "这条更好"的证据。targetSource 尤其要露出来 —— dir(目录名)和 build-system
		// (构建系统的过滤声明)是天差地别的两档,读结果的人得看得见自己在信什么。
		const facets = [
			entry.tier ? `分层 ${entry.tier}` : undefined,
			entry.entryKind ? `粒度 ${entry.entryKind}` : undefined,
			entry.targetSource ? `targets 来源 ${entry.targetSource}` : undefined,
		].filter((item): item is string => item !== undefined);
		if (facets.length > 0) reasons.push(facets.join("、"));

		const haystackStrong = `${entry.title ?? ""}\n${entry.name}`.toLowerCase();
		const haystackWeak =
			`${entry.summary ?? ""}\n${entry.path}\n${record?.card.summaryZh ?? ""}\n${record?.card.capabilities.join(" ") ?? ""}`.toLowerCase();
		for (const keyword of keywords) {
			if (haystackStrong.includes(keyword)) {
				score += 2;
				reasons.push(`关键词 ${keyword}(标题/名)`);
			} else if (haystackWeak.includes(keyword)) {
				score += 1;
				reasons.push(`关键词 ${keyword}`);
			}
		}

		if (query.board && entry.board && entry.board.toLowerCase() === query.board.trim().toLowerCase()) {
			score += 3;
			reasons.push(`板匹配 ${entry.board}`);
		}

		if (entry.buildable) score += 2;

		const bonus = locBonus(entry.loc);
		if (bonus > 0) {
			score += bonus;
			reasons.push(`小种子(${entry.loc} 行)`);
		}

		scored.push(record ? { entry, score, reasons, enrichment: record } : { entry, score, reasons });
	}

	scored.sort((a, b) => b.score - a.score || a.entry.loc - b.entry.loc || a.entry.id.localeCompare(b.entry.id));
	return scored.slice(0, limit);
}
