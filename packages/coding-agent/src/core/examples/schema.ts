/**
 * 例程索引的数据形状:一份语料(esp-idf、STM32Cube 固件包……)扫出来的每个例程
 * 一张卡片,agent 靠它检索"物理可用"的起步种子。设计与验收见
 * docs/施工指南-例程库.md。
 *
 * 两条纪律与 core/toolchain 一脉相承:
 * - 索引与账本都是**缓存**,读不出来当空,不抛 —— 坏一行跳一行,不连累整份文件
 *   (ledger.ts 的"逐条过滤"理由,原样适用)。
 * - 芯片/生态是**硬约束**:它们进结构化字段,不进自由文本 —— 检索层按字段排除,
 *   纯语义排序会把 STM32 的例程排到 ESP32 需求的第一位(语义完美,物理不可用)。
 *
 * 本文件只有类型、守卫与(反)序列化,零 IO —— IO 全在 store.ts,抽取在各生态插件。
 */

export const ECOSYSTEMS = ["esp-idf", "stm32cube"] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

export function isEcosystem(value: unknown): value is Ecosystem {
	return typeof value === "string" && (ECOSYSTEMS as readonly string[]).includes(value);
}

/** 例程自带的验收素材(厂商 CI 的判据),路径相对例程目录。 */
export interface ExampleAcceptance {
	kind: "pytest";
	path: string;
}

export interface ExampleEntry {
	/** `<语料id>/<相对路径>`,全局唯一。 */
	id: string;
	/** 语料 id,如 "esp-idf@08e0d30a"。 */
	corpus: string;
	ecosystem: Ecosystem;
	/** 相对语料根,一律正斜杠 —— 索引要跨机器可读,反斜杠是 Windows 本机事实。 */
	path: string;
	/** 目录名,seed 的默认目标名。 */
	name: string;
	title?: string;
	summary?: string;
	/**
	 * 支持的芯片,全小写(esp32c3 / stm32f4)。空数组 = 元数据缺失,检索**不排除**
	 * 但要明说 —— 缺元数据是"不知道",不是"不支持",替模型隐掉候选比多列一条更糟。
	 */
	targets: string[];
	/** 板名(Cube 的路径里有;esp-idf 通常没有)。软偏好,不是硬过滤。 */
	board?: string;
	/** 外设/能力关键词,全小写(i2c/spi/wifi/mqtt/nvs…)。 */
	peripherals: string[];
	/** 组件依赖(esp-idf 的 idf_component.yml)。非空意味着构建要联网取组件。 */
	deps?: string[];
	/** sdkconfig.defaults 声明的 CONFIG_ 键 —— 下一期资源账本的输入之一。 */
	configKeys?: string[];
	acceptance?: ExampleAcceptance;
	/**
	 * 底盘资格:语料根上必要件齐不齐(Cube 的 Drivers/ 是否实体)。供体只需可读,
	 * 底盘必须能编 —— 两个承诺分开记,"能读"冒充"能编"会把种子选进死路。
	 */
	buildable: boolean;
	/** buildable=false 的原因或构建前提,人话。 */
	buildNote?: string;
	license?: string;
	/** 源码行数(粗):小种子偏好的依据 —— 要在它上面做加法,越小越好审。 */
	loc: number;
	files: number;
	/** 抽取规则版本 —— 规则演进后据此识别旧索引该重建。 */
	extractorVersion: number;
}

export const INDEX_SCHEMA_TAG = "yoma/examples-index@1";

export interface ExamplesIndexHeader {
	schema: typeof INDEX_SCHEMA_TAG;
	corpus: string;
	ecosystem: Ecosystem;
	/** 生成时的语料根 —— 本机事实,只作诊断展示,读侧不得依赖它定位文件(用 sources.json)。 */
	root?: string;
	/** 语料检出的 git 短 commit,种子出处(provenance)要引用它。 */
	commit?: string;
	generatedAt: string;
	entries: number;
}

export interface ExamplesIndex {
	header: ExamplesIndexHeader;
	entries: ExampleEntry[];
}

// ─── 守卫:逐条过滤,坏一条丢一条 ────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

export function isExampleEntry(value: unknown): value is ExampleEntry {
	if (!isPlainObject(value)) return false;
	if (typeof value.id !== "string" || value.id.trim() === "") return false;
	if (typeof value.corpus !== "string" || value.corpus.trim() === "") return false;
	if (!isEcosystem(value.ecosystem)) return false;
	if (typeof value.path !== "string" || value.path.trim() === "") return false;
	if (typeof value.name !== "string" || value.name.trim() === "") return false;
	if (!isOptionalString(value.title) || !isOptionalString(value.summary)) return false;
	if (!isStringArray(value.targets)) return false;
	if (!isOptionalString(value.board)) return false;
	if (!isStringArray(value.peripherals)) return false;
	if (value.deps !== undefined && !isStringArray(value.deps)) return false;
	if (value.configKeys !== undefined && !isStringArray(value.configKeys)) return false;
	if (value.acceptance !== undefined) {
		const acceptance = value.acceptance;
		if (!isPlainObject(acceptance)) return false;
		if (acceptance.kind !== "pytest" || typeof acceptance.path !== "string") return false;
	}
	if (typeof value.buildable !== "boolean") return false;
	if (!isOptionalString(value.buildNote) || !isOptionalString(value.license)) return false;
	if (typeof value.loc !== "number" || typeof value.files !== "number") return false;
	if (typeof value.extractorVersion !== "number") return false;
	return true;
}

export function isIndexHeader(value: unknown): value is ExamplesIndexHeader {
	if (!isPlainObject(value)) return false;
	if (value.schema !== INDEX_SCHEMA_TAG) return false;
	if (typeof value.corpus !== "string" || value.corpus.trim() === "") return false;
	if (!isEcosystem(value.ecosystem)) return false;
	if (!isOptionalString(value.root) || !isOptionalString(value.commit)) return false;
	if (typeof value.generatedAt !== "string") return false;
	if (typeof value.entries !== "number") return false;
	return true;
}

// ─── JSONL(反)序列化 ─────────────────────────────────────────────────────────

/** 首行 header,之后每行一个条目。行式追加友好,坏行的爆炸半径就是那一行。 */
export function serializeIndex(index: ExamplesIndex): string {
	const lines = [JSON.stringify(index.header), ...index.entries.map((entry) => JSON.stringify(entry))];
	return `${lines.join("\n")}\n`;
}

/**
 * 容错解析:首行不是合法 header(或 schema 标签对不上)→ 整份当没有(undefined);
 * 条目行坏 → 跳过该行。对不上当没有,比对错更安全 —— 读侧下一步是提示重建索引。
 */
export function parseIndex(text: string): ExamplesIndex | undefined {
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length === 0) return undefined;
	let header: unknown;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		return undefined;
	}
	if (!isIndexHeader(header)) return undefined;
	const entries: ExampleEntry[] = [];
	for (const line of lines.slice(1)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isExampleEntry(parsed)) entries.push(parsed);
	}
	return { header, entries };
}

// ─── 本机语料账本(sources.json)────────────────────────────────────────────────

export const SOURCES_SCHEMA_TAG = "yoma/examples-sources@1";

/** 一份语料在这台机器上的落点。root 是本机绝对路径 —— 所以这份文件永远不进 git。 */
export interface CorpusSource {
	id: string;
	ecosystem: Ecosystem;
	root: string;
}

export interface ExamplesSources {
	schema: typeof SOURCES_SCHEMA_TAG;
	corpora: CorpusSource[];
}

export function isCorpusSource(value: unknown): value is CorpusSource {
	if (!isPlainObject(value)) return false;
	if (typeof value.id !== "string" || value.id.trim() === "") return false;
	if (!isEcosystem(value.ecosystem)) return false;
	if (typeof value.root !== "string" || value.root.trim() === "") return false;
	return true;
}

export function emptySources(): ExamplesSources {
	return { schema: SOURCES_SCHEMA_TAG, corpora: [] };
}

/** 容错:顶层形状/标签不对当空;corpora 逐条过滤。 */
export function parseSources(raw: unknown): ExamplesSources {
	if (!isPlainObject(raw) || raw.schema !== SOURCES_SCHEMA_TAG || !Array.isArray(raw.corpora)) {
		return emptySources();
	}
	return { schema: SOURCES_SCHEMA_TAG, corpora: raw.corpora.filter(isCorpusSource) };
}

/** 语料 id → 索引文件名词干:非 ASCII 安全字符换 "-",避免在文件系统里玩火。 */
export function corpusSlug(corpusId: string): string {
	return corpusId.replace(/[^a-zA-Z0-9._-]+/g, "-") || "corpus";
}
