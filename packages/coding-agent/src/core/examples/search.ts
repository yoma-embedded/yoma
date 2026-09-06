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

/**
 * 条目 targets 里,作为查询芯片前缀的**最长**那一个的长度;0 = 没匹配或 targets 为空。
 *
 * `targetMatches` 只回答"命不命中"(布尔),而**布尔量不能排序** —— 45 语料实测:
 * 裸查 stm32f407 有 519 条候选、只有 2 个分值(3 和 0)、**175 条并列在最高分**,
 * 名次 100% 由第二排序键决定。命中的长度是数据里本来就有、却被压成一个比特的信息:
 * 同一次查询里 `stm32`(5 字符,厂商级)与 `stm32f4`(7 字符,族级)的证据强度不同。
 */
export function targetMatchLength(queryTarget: string, entryTargets: string[]): number {
	const wanted = normalizeTarget(queryTarget);
	let best = 0;
	for (const target of entryTargets) {
		const t = normalizeTarget(target);
		if (wanted.startsWith(t) && t.length > best) best = t.length;
	}
	return best;
}

/**
 * 体积只在**离谱**时参与次序,不再"越小越靠前"。
 *
 * `[1000, 10000]` 行是本库 1260 条的 p30(612)~p80(9102)之间,不是拍脑袋:
 * 下沿挡住 3 行的占位目录、66 行的"支持芯片列表.md"这类不是起点的东西,
 * 上沿挡住 27 万行的整棵 Demo 树。**只做次序键,不进 score** —— 分数仍是唯一的真相。
 *
 * 上一轮把 locBonus 从分值里删掉时,我写的理由是"它与 loc 升序 tie-break 冗余"。
 * 那句话方向反了:删掉它并没有去掉体积偏好,只是把 loc 从**分值**降级成了
 * **唯一生效的排序键** —— 5 语料时并列少看不出来,45 语料时并列组就是整个结果页。
 */
function locBandPenalty(loc: number): number {
	const magnitude = Math.log10(Math.max(loc, 1));
	if (magnitude < 3) return 3 - magnitude;
	if (magnitude > 4) return magnitude - 4;
	return 0;
}

/**
 * 哪些语料**整体**没声明过任何 targets。
 *
 * 45 语料实测:整整 20 个语料的 targets 覆盖率是 0%(cjson / littlefs / lwip / mbedtls /
 * fatfs / spiffs / coremqtt / libmodbus / unity / uthash …)。它们是**可移植库**,
 * 空 targets 是**语义**(芯片无关)不是元数据缺失。而芯片分是常数,于是任何带芯片的
 * 查询都把这 20 个语料整体压进分数空间下半区 —— `{stm32f407, filesystem}` 里
 * littlefs 输给任何一条恰好带 stm32 标签又沾 filesystem 的无关条目,就是这么来的。
 */
function corpusDeclaresTargets(entries: ExampleEntry[]): Set<string> {
	const declared = new Set<string>();
	for (const entry of entries) if (entry.targets.length > 0) declared.add(entry.corpus);
	return declared;
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

	// 一次 O(n) 预扫。纯函数不破:同一份 entries 必得同一份统计。但注意语义变了 ——
	// 分数从此依赖**整份索引**而不只是 (entry, query),加一个语料会改变其它条目的名次。
	// 评测台记语料指纹就是为了这个。
	const declaresTargets = corpusDeclaresTargets(entries);

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

		// 芯片命中要**加分**,不能只进 reasons —— 从前只加理由不加分,于是"精确声明了
		// 这颗芯片"和"只是没被排除(targets 空)"在排序里完全等价,主用途 `{target}` 的
		// 得分里一分查询相关性都没有,排序退化成"谁的目录小"。实测(现网 5 语料同时在库):
		// freertos 自己的 10 问跨语料 **0/10**,七个芯片查询返回的是同一批 3~60 行的
		// lvgl 小目录;补上这一分之后 **10/10**。
		//
		// targets 为空仍然不加分,这正是 targetMatches 那条注释想要的语义:空 = 不知道
		// 或"任何芯片都行",不排除、但也不该压过真正声明了这颗芯片的条目 —— 它排在后面
		// 是正确的,不需要靠标 lib 把它藏起来。
		if (query.target) {
			const matched = targetMatchLength(query.target, entry.targets);
			if (matched >= 6) {
				// 族级/型号级证据(stm32f4 / esp32c / rp2040)。6 是语义分界不是调参:
				// `stm32`(5)是厂商级 —— arm-2d 用一句 blanket "stm32" 声明了 51 颗芯片,
				// 那句话的真实含义是"我跑在 Cortex-M 上",不是"这颗芯片"的证据。
				score += 4;
				reasons.push(`芯片匹配 ${entry.targets.slice(0, 4).join(",")}(族级前缀 ${matched} 字符)`);
			} else if (matched >= 3) {
				score += 2;
				reasons.push(`芯片匹配 ${entry.targets.slice(0, 4).join(",")}(厂商级前缀 ${matched} 字符)`);
			} else if (entry.targets.length > 0) {
				score += 1;
				reasons.push(`芯片匹配 ${entry.targets.slice(0, 4).join(",")}`);
			} else if (!declaresTargets.has(entry.corpus) && (peripherals.length > 0 || keywords.length > 0)) {
				// 整个语料一条 targets 都没声明 = 它按设计就与芯片无关(可移植库),
				// 空 targets 是语义不是漏填,不该因此被系统性压低。
				// **必须保留"查询带了外设或关键词"这道门**:裸 `{target}` 查询里芯片声明是
				// 唯一的相关性信号,给空 targets 平权就是 5 语料时代那个老 bug 复活。
				score += 2;
				reasons.push("语料整体芯片无关(可移植库),空 targets 是语义不是缺失");
			} else {
				reasons.push("芯片元数据缺失,未据此排除 —— 用前自行核对");
			}
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
			// 标题/名命中要压过芯片分(+3):芯片是**约束**(而且已经硬过滤过一道),
			// 用户敲进来的那个词才是**请求**。实测 `{stm32f407, json}` —— 芯片分补上之后,
			// 真·stm32 的 FreeRTOS 端口(+3)会盖过 cJSON.c(标题命中),而用户要的是 json;
			// 提到 +4 之后 cJSON.c 回到第 1。
			if (haystackStrong.includes(keyword)) {
				score += 4;
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

		// 这里从前有一个 locBonus(<200 行 +3 / <500 +2 / <1000 +1),2026-08-25 删掉。
		// 当时给的理由("它与 loc 升序 tie-break 冗余")**是错的**:删掉它并没有去掉体积
		// 偏好,只是把 loc 从分值降级成了唯一生效的排序键。5 语料时并列少,看不出来;
		// 45 语料时并列组就是整个结果页 —— 见 locBandPenalty 的注释。
		scored.push(record ? { entry, score, reasons, enrichment: record } : { entry, score, reasons });
	}

	const byRank = (a: ScoredExample, b: ScoredExample): number =>
		b.score - a.score ||
		locBandPenalty(a.entry.loc) - locBandPenalty(b.entry.loc) ||
		a.entry.id.localeCompare(b.entry.id);
	scored.sort(byRank);

	// 同分组内按语料轮转。45 语料实测:一个沾边的语料能用几十条同分条目吃掉整个结果窗口
	// (`{stm32f429,gui}` 前 12 名 12/12 是 arm-2d),而用户要的往往是"哪几个**库**能解决
	// 这件事",不是"某个库的第 3、第 4 个端口"。
	//
	// 这是**纯 tie-break**:只在 score 完全相等的一段内重排,数学上不可能把低分抬到高分
	// 之上,"分数即真相 / 排序可查账"不破。实测与"同语料扣分"效果相同(都 45/48),
	// 但扣分会让低分越过高分,所以取这一版。
	const rotated: ScoredExample[] = [];
	for (let start = 0; start < scored.length; ) {
		let end = start;
		while (end < scored.length && scored[end]!.score === scored[start]!.score) end++;
		const queues = new Map<string, ScoredExample[]>();
		for (const row of scored.slice(start, end)) {
			const queue = queues.get(row.entry.corpus);
			if (queue) queue.push(row);
			else queues.set(row.entry.corpus, [row]);
		}
		const lists = [...queues.values()];
		for (let taken = 0; taken < end - start; ) {
			for (const queue of lists) {
				const row = queue.shift();
				if (row) {
					rotated.push(row);
					taken++;
				}
			}
		}
		start = end;
	}
	return rotated.slice(0, limit);
}
