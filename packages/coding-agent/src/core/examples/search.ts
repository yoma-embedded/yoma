/**
 * 检索:硬过滤在前(排除,不降权),确定性打分在后。为什么不是向量库:芯片/生态是
 * 物理可用性,纯语义排序会把 STM32 的例程排到 ESP32 需求的第一位 —— 语义完美,
 * 物理不可用。候选收进十来条,重排器就是读结果的 agent 本身。
 *
 * 纯函数,零 IO —— 读索引在 store.ts,这里只算。同输入必同输出(score 降序 →
 * loc 升序 → id 字典序),索引没变时两次搜索必须一字不差。
 */

import type { EnrichmentRecord } from "./enrich-schema.ts";
import type { Ecosystem, ExampleEntry } from "./schema.ts";

/**
 * 生态的芯片前缀:targets 为空(元数据缺失)的条目要靠它兜住跨生态泄漏 ——
 * esp-idf 的例程永远跑不上 stm32f103,"未知不排除"只在同生态内成立。
 */
const ECOSYSTEM_TARGET_PREFIXES: Record<Ecosystem, string> = {
	"esp-idf": "esp",
	stm32cube: "stm32",
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

	const scored: ScoredExample[] = [];
	for (const entry of entries) {
		const record = enrichment?.get(entry.id);
		if (query.ecosystem && entry.ecosystem !== query.ecosystem) continue;
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
