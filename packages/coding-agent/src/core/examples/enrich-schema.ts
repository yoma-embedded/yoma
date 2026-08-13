/**
 * 富化卡片的数据形状:模型离线读完一个例程之后写下的"它到底干了什么、占了什么资源"。
 * 脚本抽取(schema.ts 的 ExampleEntry)回答"哪里有什么",富化回答"拿它合并要付什么"——
 * 引脚、外设实例、会重定义的全局符号、任务优先级。合并预检(preflight.ts)吃的就是它。
 *
 * 三条纪律:
 * - 富化是**旁挂文件**,不进索引本体 —— 索引由脚本秒级重建,富化是花过钱的模型产物,
 *   重建索引不许把它冲掉。读侧按 (id, commit) 合流,语料换版本后旧富化按陈旧跳过。
 * - 逐行自描述,**没有文件头**:每行自带 schema 标签与语料 commit,追加不需要先读,
 *   坏一行的爆炸半径就是那一行(与索引 JSONL 同一套容错纪律)。
 * - 模型输出必须**净化**再落盘:字段裁剪、长度封顶、数组去重 —— 幻觉字段与超长输出
 *   不许进缓存。净化失败整卡拒收(记失败,不落半张卡)。
 *
 * 本文件只有类型、守卫与(反)序列化,零 IO —— IO 在 store.ts,管线在 enrich.ts。
 */

import { truncateText } from "./extract-util.ts";

export const ENRICH_SCHEMA_TAG = "yoma/examples-enrich@1";

/** 引脚占用。pin 是原样记录(PA5 / GPIO4),冲突比对时才归一(preflight.ts 的 normalizePin)。 */
export interface PinUse {
	pin: string;
	/** 人话角色:SPI1_SCK、按键输入…… */
	role?: string;
	/** 备注,典型是"可经 menuconfig 改"。 */
	note?: string;
}

export interface TaskDecl {
	name: string;
	priority?: number;
}

/** 资源足迹 —— 合并预检的输入。全部"代码里有证据才写",空数组是合法答案(纯算法例程)。 */
export interface ResourceFootprint {
	pins: PinUse[];
	/** 外设实例(SPI1、DMA2_Stream0、I2C0、TIM3……),按实例查重。 */
	instances: string[];
	/**
	 * 例程**定义**的、并进别的工程会链接期重定义的全局符号:*_IRQHandler、
	 * HAL_*_MspInit / HAL_*_Callback、SystemClock_Config、Error_Handler…… 不含 static。
	 */
	symbols: string[];
	/** 入口符号(main / app_main)。供体的入口按纪律不合入,预检只提醒不算冲突。 */
	entrySymbols: string[];
	tasks: TaskDecl[];
	/** 自带分区表/存储布局时的一句话描述(esp-idf 的 partitions.csv 等)。 */
	partitions?: string;
}

export interface EnrichmentCard {
	/** 一两句中文:例程实际做什么、演示哪个 API/模式 —— 命中之后给人和模型看的第一句。 */
	summaryZh: string;
	/** 检索能力词(小写英文 token),检索时并进外设匹配。 */
	capabilities: string[];
	footprint: ResourceFootprint;
	/** 移植提示:引脚可否配置、依赖的板载器件等。 */
	notes?: string;
}

export interface EnrichmentRecord {
	schema: typeof ENRICH_SCHEMA_TAG;
	/** 索引条目 id(`<语料id>/<路径>`)。 */
	id: string;
	corpus: string;
	/** 富化时索引 header 的 commit —— 读侧要求与当前索引一致,不一致按陈旧跳过。 */
	commit?: string;
	/** 干活的模型(provider/model),卡片质量的责任人栏。 */
	model: string;
	enrichedAt: string;
	card: EnrichmentCard;
}

// ─── 净化:模型输出 → 卡片 ─────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = truncateText(value, max);
	return text === "" ? undefined : text;
}

function clampStringList(
	value: unknown,
	options: { max: number; itemMax: number; lowercase?: boolean; identifier?: boolean },
): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		let text = clampString(item, options.itemMax);
		if (text === undefined) continue;
		// identifier:实例/符号是冲突比对的键,只收标识符本身。模型偶尔往里塞散文或
		// 带"(若存在)"的推测(实测 deepseek-v4-flash 会把提示词示例抄进来)——
		// 散文进了键,预检就会拿两段中文互相"撞车"。机械过滤比措辞管用。
		if (options.identifier && !/^\w+$/.test(text)) continue;
		if (options.lowercase) text = text.toLowerCase();
		if (!out.includes(text)) out.push(text);
		if (out.length >= options.max) break;
	}
	return out.sort();
}

function sanitizePins(value: unknown): PinUse[] {
	if (!Array.isArray(value)) return [];
	const out: PinUse[] = [];
	for (const item of value) {
		// 宽收两种形状:{pin, role?, note?} 或 "PA5:SPI1_SCK" —— 模型偶尔省事,别为此毙整卡。
		if (typeof item === "string") {
			const [pin, ...roleParts] = item.split(":");
			const cleanPin = clampString(pin, 24);
			if (cleanPin === undefined) continue;
			const role = clampString(roleParts.join(":"), 80);
			out.push(role === undefined ? { pin: cleanPin } : { pin: cleanPin, role });
		} else if (isPlainObject(item)) {
			const pin = clampString(item.pin, 24);
			if (pin === undefined) continue;
			const use: PinUse = { pin };
			const role = clampString(item.role, 80);
			const note = clampString(item.note, 120);
			if (role !== undefined) use.role = role;
			if (note !== undefined) use.note = note;
			out.push(use);
		}
		if (out.length >= 48) break;
	}
	return out;
}

function sanitizeTasks(value: unknown): TaskDecl[] {
	if (!Array.isArray(value)) return [];
	const out: TaskDecl[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) continue;
		const name = clampString(item.name, 48);
		if (name === undefined) continue;
		const task: TaskDecl = { name };
		if (typeof item.priority === "number" && Number.isFinite(item.priority)) task.priority = item.priority;
		out.push(task);
		if (out.length >= 24) break;
	}
	return out;
}

/**
 * 模型输出(已 JSON.parse)→ 卡片。summaryZh 缺失整卡拒收(卡片的最低承诺);
 * 其余字段裁剪封顶,足迹缺失落成空足迹 —— "没有资源占用"是合法卡片。
 */
export function sanitizeEnrichmentCard(raw: unknown): EnrichmentCard | undefined {
	if (!isPlainObject(raw)) return undefined;
	const summaryZh = clampString(raw.summaryZh, 600);
	if (summaryZh === undefined) return undefined;
	// footprint 键**存在但形状不对**(实测形态:模型把它二次编码成 JSON 字符串)是
	// 可判别的坏输出,整卡拒收让重跑再试 —— 静默落成空足迹的卡会永久绕过续跑,
	// 还让预检把"有占用"当"零占用"。键不存在才是合法的无足迹(纯算法例程)。
	if (raw.footprint !== undefined && !isPlainObject(raw.footprint)) return undefined;
	const footprintRaw = isPlainObject(raw.footprint) ? raw.footprint : {};
	const footprint: ResourceFootprint = {
		pins: sanitizePins(footprintRaw.pins),
		instances: clampStringList(footprintRaw.instances, { max: 48, itemMax: 32, identifier: true }),
		symbols: clampStringList(footprintRaw.symbols, { max: 64, itemMax: 64, identifier: true }),
		entrySymbols: clampStringList(footprintRaw.entrySymbols, { max: 8, itemMax: 32, identifier: true }),
		tasks: sanitizeTasks(footprintRaw.tasks),
	};
	const partitions = clampString(footprintRaw.partitions, 200);
	if (partitions !== undefined) footprint.partitions = partitions;
	const card: EnrichmentCard = {
		summaryZh,
		capabilities: clampStringList(raw.capabilities, { max: 24, itemMax: 32, lowercase: true }),
		footprint,
	};
	const notes = clampString(raw.notes, 400);
	if (notes !== undefined) card.notes = notes;
	return card;
}

// ─── 守卫与(反)序列化 ─────────────────────────────────────────────────────────

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isFootprint(value: unknown): value is ResourceFootprint {
	if (!isPlainObject(value)) return false;
	if (!Array.isArray(value.pins)) return false;
	for (const pin of value.pins) {
		if (!isPlainObject(pin) || typeof pin.pin !== "string") return false;
		if (!isOptionalString(pin.role) || !isOptionalString(pin.note)) return false;
	}
	if (!isStringArray(value.instances) || !isStringArray(value.symbols) || !isStringArray(value.entrySymbols)) {
		return false;
	}
	if (!Array.isArray(value.tasks)) return false;
	for (const task of value.tasks) {
		if (!isPlainObject(task) || typeof task.name !== "string") return false;
		if (task.priority !== undefined && typeof task.priority !== "number") return false;
	}
	return isOptionalString(value.partitions);
}

export function isEnrichmentCard(value: unknown): value is EnrichmentCard {
	if (!isPlainObject(value)) return false;
	if (typeof value.summaryZh !== "string" || value.summaryZh.trim() === "") return false;
	if (!isStringArray(value.capabilities)) return false;
	if (!isFootprint(value.footprint)) return false;
	return isOptionalString(value.notes);
}

export function isEnrichmentRecord(value: unknown): value is EnrichmentRecord {
	if (!isPlainObject(value)) return false;
	if (value.schema !== ENRICH_SCHEMA_TAG) return false;
	if (typeof value.id !== "string" || value.id.trim() === "") return false;
	if (typeof value.corpus !== "string" || value.corpus.trim() === "") return false;
	if (!isOptionalString(value.commit)) return false;
	if (typeof value.model !== "string" || typeof value.enrichedAt !== "string") return false;
	return isEnrichmentCard(value.card);
}

export function serializeEnrichmentRecord(record: EnrichmentRecord): string {
	return `${JSON.stringify(record)}\n`;
}

/** 容错逐行:坏行/别的 schema 跳过。同 id 后写的行在数组里靠后 —— 读侧取最后一条即"重富化覆盖"。 */
export function parseEnrichmentLines(text: string): EnrichmentRecord[] {
	const out: EnrichmentRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isEnrichmentRecord(parsed)) out.push(parsed);
	}
	return out;
}
