/**
 * 富化管线:索引条目 → 读例程源码 → 模型写卡片 → 净化 → 追加落盘。离线运维工具,
 * 与索引器同一条命(语料在哪台机器就在哪台机器跑;将来搬服务器,跑的还是它)。
 *
 * 模型调用是**注入**的(EnrichCompletion),本文件不 import pi-ai:测试注入假模型,
 * CLI 注入 resolveModel 装配的真模型 —— 管线的正确性与"哪家模型"无关,别把两件事
 * 焊在一起。断点续跑靠落盘层的 (id, commit) 合流:已有有效卡片的条目直接跳过,
 * 失败**不落盘**(下次重跑自动再试;把失败也记下来反而要发明"重试失败"的第二套机制)。
 */

import path from "node:path";

import { type EnrichmentCard, ENRICH_SCHEMA_TAG, sanitizeEnrichmentCard } from "./enrich-schema.ts";
import { readTextIfExists, walkFilesRelative } from "./extract-util.ts";
import type { ExampleEntry, ExamplesIndex } from "./schema.ts";
import { appendEnrichmentRecord, enrichmentMapFor, findSource, readIndexFile } from "./store.ts";

/** 单次补全:system + user 进,原始文本出。抛异常 = 这一条失败(管线记下,继续别的)。 */
export type EnrichCompletion = (systemPrompt: string, userText: string) => Promise<string>;

// ─── 提示词 ───────────────────────────────────────────────────────────────────

export const ENRICH_SYSTEM_PROMPT = `你是嵌入式例程分析器。读一个厂商例程的源码,输出一张 JSON 卡片。只输出 JSON 本体,不要 markdown 围栏,不要解释文字。形状:
{
  "summaryZh": "一两句中文:例程实际做什么、演示哪个 API/模式",
  "capabilities": ["小写英文能力词,如 spi/dma/wifi/mqtt/pwm/lowpower/interrupt"],
  "footprint": {
    "pins": [{"pin": "PA5", "role": "SPI1_SCK", "note": "可选备注"}],
    "instances": ["占用的外设实例,如 SPI1/DMA2_Stream0/I2C0/TIM3/USART2"],
    "symbols": ["例程定义的、并进别的工程会链接期重定义的全局符号:*_IRQHandler、HAL_*_MspInit、HAL_*_Callback、SystemClock_Config、Error_Handler 等;不列 static 函数"],
    "entrySymbols": ["main 或 app_main"],
    "tasks": [{"name": "RTOS 任务名", "priority": 5}],
    "partitions": "自带分区表/存储布局时一句话描述;没有就省略该键"
  },
  "notes": "移植提示:引脚是否可经 Kconfig/menuconfig 改、依赖哪些板载器件;没有就省略该键"
}
规则:
- 只写代码里有证据的事实。引脚写代码/配置的默认值;可配置的在 note 里说明"可经 menuconfig 改"。
- ESP 引脚写 GPIO<n>;STM32 引脚写 P<port><n>(如 PA5)。
- instances / symbols / entrySymbols 只写源码里的标识符本身(字母数字下划线),一项一个,不要中文、括号、空格或解释 —— 解释一律放 notes。
- symbols 只列本例程源码里**实际定义**的;拿不准就不列,禁止"若存在"式推测,禁止照抄上面的示例清单。
- 不确定的宁可留空数组,不要猜。`;

/**
 * 挑进提示词的文件与预算。足迹的证据集中在少数文件里(引脚复用在 main.c / *msp*.c,
 * 中断在 *_it.c,ESP 的默认引脚在 Kconfig/sdkconfig.defaults),按证据密度排序,
 * 预算内能塞多少塞多少 —— 超预算裁掉的是低密度尾巴,不是均匀稀释。
 */
const PER_FILE_CHARS = 8000;
const TOTAL_CHARS = 32000;
const README_CHARS = 2500;

/** 数字越小越先进提示词;-1 = 不进。 */
export function enrichFileRank(relPosix: string): number {
	const base = path.posix.basename(relPosix).toLowerCase();
	// 脚手架:整包一样的模板文件,没有足迹证据,白占预算。
	if (/_conf(_template)?\.h$/.test(base) || base.startsWith("system_stm32")) return -1;
	if (base === "main.c" || base === "app_main.c" || base.endsWith("_main.c") || base.endsWith("_example.c")) return 0;
	if (base.endsWith("_it.c") || base.includes("msp")) return 1;
	if (/\.(c|cc|cpp)$/.test(base)) return 2;
	if (base === "main.h") return 3;
	if (/\.(h|hpp)$/.test(base)) return 4;
	if (base === "sdkconfig.defaults" || base.startsWith("partitions") || base === "idf_component.yml") return 5;
	if (base.startsWith("kconfig")) return 6;
	if (base === "readme.md" || base === "readme.txt") return 7;
	return -1;
}

export interface EnrichPromptFile {
	relPath: string;
	text: string;
}

export function pickEnrichFiles(exampleDir: string): EnrichPromptFile[] {
	const all = walkFilesRelative(exampleDir, 400);
	const ranked = all
		.map((rel) => ({ rel, rank: enrichFileRank(rel) }))
		.filter((item) => item.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel));
	const out: EnrichPromptFile[] = [];
	let used = 0;
	for (const { rel, rank } of ranked) {
		if (used >= TOTAL_CHARS) break;
		const raw = readTextIfExists(path.join(exampleDir, ...rel.split("/")));
		if (raw === undefined || raw.trim() === "") continue;
		const cap = Math.min(rank === 7 ? README_CHARS : PER_FILE_CHARS, TOTAL_CHARS - used);
		const text = raw.length > cap ? `${raw.slice(0, cap)}\n…(截断)` : raw;
		out.push({ relPath: rel, text });
		used += text.length;
	}
	return out;
}

export function buildEnrichPrompt(entry: ExampleEntry, exampleDir: string): { system: string; user: string } {
	const facts = [
		`例程 ${entry.id}`,
		`生态 ${entry.ecosystem} | 芯片 ${entry.targets.join(",") || "未知"} | 路径 ${entry.path}`,
		`脚本抽取的外设线索:${entry.peripherals.join(",") || "(无)"}`,
		entry.configKeys?.length ? `Kconfig:${entry.configKeys.join(",")}` : undefined,
		entry.deps?.length ? `组件依赖:${entry.deps.join(",")}` : undefined,
	].filter((line): line is string => line !== undefined);
	const files = pickEnrichFiles(exampleDir).map(
		(file) => `─── 文件 ${file.relPath} ───\n${file.text}`,
	);
	return {
		system: ENRICH_SYSTEM_PROMPT,
		user: [...facts, "", ...files].join("\n"),
	};
}

/** 剥围栏、掐出最外层 {...} 再 parse + 净化 —— 模型偶尔不听"别加围栏",别为此毙一条。 */
export function parseModelCardText(text: string): EnrichmentCard | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		return sanitizeEnrichmentCard(JSON.parse(text.slice(start, end + 1)));
	} catch {
		return undefined;
	}
}

// ─── 跑批 ─────────────────────────────────────────────────────────────────────

export interface EnrichProgress {
	done: number;
	total: number;
	id: string;
	ok: boolean;
	error?: string;
}

export interface EnrichCorpusOptions {
	corpusId: string;
	configDir?: string;
	complete: EnrichCompletion;
	/** 记进每条 record 的模型标识(provider/model)。 */
	model: string;
	/** 并发上限,默认 4 —— 提上去先撞 provider 限流,省下的时间又还回去。 */
	concurrency?: number;
	/** 只补前 N 个缺口 —— 试跑控费用。 */
	limit?: number;
	onProgress?: (progress: EnrichProgress) => void;
}

export interface EnrichCorpusResult {
	corpus: string;
	total: number;
	/** 已有有效卡片(commit 匹配)的条目数 —— 断点续跑跳过的部分。 */
	already: number;
	attempted: number;
	enriched: number;
	failed: { id: string; error: string }[];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 单条重试一次(2s 退避)—— 限流/瞬时 5xx 就地自愈;还不行就记失败,整批重跑再补。 */
async function completeWithRetry(complete: EnrichCompletion, system: string, user: string): Promise<string> {
	try {
		return await complete(system, user);
	} catch {
		await sleep(2000);
		return await complete(system, user);
	}
}

async function enrichOne(
	index: ExamplesIndex,
	entry: ExampleEntry,
	corpusRoot: string,
	options: EnrichCorpusOptions,
): Promise<void> {
	const exampleDir = path.join(corpusRoot, ...entry.path.split("/"));
	const { system, user } = buildEnrichPrompt(entry, exampleDir);
	if (user.trim() === "" || !user.includes("─── 文件")) {
		throw new Error("例程目录读不到任何可分析文件 —— 语料被移动?重跑 CLI index");
	}
	const raw = await completeWithRetry(options.complete, system, user);
	const card = parseModelCardText(raw);
	if (!card) {
		throw new Error(`模型输出不是合法卡片 JSON(前 120 字:${raw.slice(0, 120).replaceAll("\n", " ")})`);
	}
	appendEnrichmentRecord(
		{
			schema: ENRICH_SCHEMA_TAG,
			id: entry.id,
			corpus: entry.corpus,
			commit: index.header.commit,
			model: options.model,
			enrichedAt: new Date().toISOString(),
			card,
		},
		options.configDir,
	);
}

export async function enrichCorpus(options: EnrichCorpusOptions): Promise<EnrichCorpusResult> {
	const index = readIndexFile(options.corpusId, options.configDir);
	if (!index) {
		throw new Error(`没有语料 ${options.corpusId} 的索引 —— 先跑 CLI index`);
	}
	const source = findSource(options.corpusId, options.configDir);
	if (!source) {
		throw new Error(`语料 ${options.corpusId} 的本机根没有记账(sources.json)—— 在放语料的机器上重跑 CLI index`);
	}
	const existing = enrichmentMapFor(index, options.configDir);
	const gaps = index.entries.filter((entry) => !existing.has(entry.id));
	// Number.isFinite 而不是 !== undefined:NaN 的 slice(0, NaN) 是空数组 —— 花钱的
	// 跑批"说跑了、一条没跑、退出码 0",库函数不能指望调用方守规矩(审查实测)。
	const pending = Number.isFinite(options.limit) ? gaps.slice(0, options.limit as number) : gaps;

	const result: EnrichCorpusResult = {
		corpus: options.corpusId,
		total: index.entries.length,
		already: index.entries.length - gaps.length,
		attempted: pending.length,
		enriched: 0,
		failed: [],
	};

	let cursor = 0;
	let done = 0;
	const worker = async (): Promise<void> => {
		while (cursor < pending.length) {
			const entry = pending[cursor++];
			try {
				await enrichOne(index, entry, source.root, options);
				result.enriched++;
				options.onProgress?.({ done: ++done, total: pending.length, id: entry.id, ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.failed.push({ id: entry.id, error: message });
				options.onProgress?.({ done: ++done, total: pending.length, id: entry.id, ok: false, error: message });
			}
		}
	};
	// ?? 兜不住 NaN(NaN ?? 4 === NaN),而 Array.from({length: NaN}) 是 0 个 worker。
	const requested = Number.isFinite(options.concurrency) ? (options.concurrency as number) : 4;
	const width = Math.max(1, Math.min(requested, pending.length));
	await Promise.all(Array.from({ length: width }, () => worker()));
	return result;
}
