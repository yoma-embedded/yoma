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

export const ECOSYSTEMS = ["esp-idf", "stm32cube", "generic"] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

export function isEcosystem(value: unknown): value is Ecosystem {
	return typeof value === "string" && (ECOSYSTEMS as readonly string[]).includes(value);
}

/**
 * 条目粒度。agent 索引在事实上已经产出三种粒度(tinyusb 实测:46 个例程工程 +
 * `src` 库本体 + `hw/bsp` 移植层),只是从前没地方记。记下来检索才能按查询形态选
 * 粒度:"给我一个起点"要 project,"这个库怎么用"要 module/corpus。
 */
export const ENTRY_KINDS = ["project", "module", "corpus"] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];

export function isEntryKind(value: unknown): value is EntryKind {
	return typeof value === "string" && (ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * 分层。`seed` 参与芯片硬过滤;`lib` 芯片无关,只在不带芯片或显式要求时命中。
 *
 * 它解决的是"笼统查询被库本体淹掉":实测加进 377 条库本体条目后,`stm32f407 +
 * usb` 命中数不变(外设过滤挡住了),但**只给 `stm32f407`** 时从 47 条炸到 375 条、
 * 前 8 名全是库。分层是给笼统查询兜底的,不是普遍性灾难。
 *
 * 两级:语料级(`ExamplesIndexHeader.tier`)是默认,条目级是覆盖 —— 一个仓里两种
 * 并存是常态(tinyusb:46 个例程工程是 seed,`src` 与 `hw/bsp` 是 lib)。继承发生在
 * `parseIndex`(读索引这个动作的语义),不在检索层 —— 检索是纯函数,看不到 header。
 */
export const TIERS = ["seed", "lib"] as const;

export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * `targets` 的证据来源,可信度递减。**记的是最强的那一个,不是审计轨迹** ——
 * 它的用途是让消费方做一次粗粒度的信/不信判断,做成数组只增加成本、不改变任何
 * 决策;完整证据链在语料级的产出说明(evidence)里。
 *
 * - `manifest`      机器可读的声明:library.properties 的 architectures、Cargo.toml、idf_component.yml…
 * - `build-system`  构建系统自己的过滤声明(tinyusb 的 only.txt/skip.txt + family_filter())—— 最强,因为它是活的
 * - `readme`        README 的芯片支持表
 * - `ci`            CI 的 build matrix
 * - `dir`           移植目录名(hw/bsp/*、ports/*)—— 最弱的一档:目录存在不等于该例程支持它
 * - `llm`           模型的自由判断,没有可指认的声明源
 */
export const TARGET_SOURCES = ["manifest", "build-system", "readme", "ci", "dir", "llm"] as const;

export type TargetSource = (typeof TARGET_SOURCES)[number];

export function isTargetSource(value: unknown): value is TargetSource {
	return typeof value === "string" && (TARGET_SOURCES as readonly string[]).includes(value);
}

/**
 * 产出这份索引的通道(语料级)。`mechanical` = esp-idf/stm32cube 的机械抽取;
 * `llm` = 一次性调用;`agent` = agent 边读边判;`provided` = 调用方自带提议、
 * 服务器只做核验;`none` = header-only(archive-only 语料)。
 */
export const INDEXERS = ["mechanical", "llm", "agent", "provided", "none"] as const;

export type Indexer = (typeof INDEXERS)[number];

export function isIndexer(value: unknown): value is Indexer {
	return typeof value === "string" && (INDEXERS as readonly string[]).includes(value);
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
	/**
	 * 粒度(可选)。缺省 = 未标,检索不按粒度过滤 —— 旧索引一条都没有,所以"未标"
	 * 必须等价于从前的行为。
	 */
	entryKind?: EntryKind;
	/**
	 * 分层(可选)。缺省 = 继承语料级(`parseIndex` 读的时候补上);两级都没有 = 未标,
	 * 带芯片的查询**不排除**它 —— 与 `targets` 空数组同一条纪律,缺元数据是"不知道"
	 * 不是"不支持"。
	 */
	tier?: Tier;
	/** `targets` 的最强证据来源(可选),取值与含义见 TARGET_SOURCES。 */
	targetSource?: TargetSource;
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
	/**
	 * 语料级元数据(以下全部可选,旧索引一个都没有)。它们**只做类型校验、不校验取值**:
	 * header 判废会让整份索引读不出来(`parseIndex` 返回 undefined),为一个说明性的
	 * 可选字段付这个代价是错的。取值不认识时读侧当没有(见 `parseIndex` 的 tier)。
	 */
	indexer?: string;
	/** agent 给这个库的定性:例程集 / 可移植库 / 移植层库 / 主机工具。 */
	libraryKind?: string;
	/** 语料级默认分层;条目未标 `tier` 时继承它。 */
	tier?: string;
	/** agent 枚举出的候选总数 —— 与 `entries` 的差额就是它主动放弃的部分。 */
	candidateCount?: number;
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
	// 三个可选枚举:取值不合法 = 这一行是别的版本/坏工具写的,当坏行丢掉(与
	// ecosystem 同一档待遇)。产出侧在构造条目**之前**就把非法值收敛成 undefined
	// 并记进 fieldWarnings,所以正常管线永远走不到这三行。
	if (value.entryKind !== undefined && !isEntryKind(value.entryKind)) return false;
	if (value.tier !== undefined && !isTier(value.tier)) return false;
	if (value.targetSource !== undefined && !isTargetSource(value.targetSource)) return false;
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
	// 只校验类型、不校验取值 —— 理由见 ExamplesIndexHeader 上那段注释。
	if (!isOptionalString(value.indexer) || !isOptionalString(value.libraryKind) || !isOptionalString(value.tier)) return false;
	if (value.candidateCount !== undefined && typeof value.candidateCount !== "number") return false;
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
	// 语料级 tier 的继承在这里做,不在检索层:`searchIndex` 是纯函数,拿不到 header。
	// 放进"读索引"这个动作里,继承就只有一处;往回 serialize 会把继承来的值写实
	// (幂等,无害)。header 的 tier 取值不认识时当没有 —— 否则它会被盖到每一条上、
	// 再被 isExampleEntry 逐条判废,整份索引静默变空。
	const inherited = isTier(header.tier) ? header.tier : undefined;
	const entries: ExampleEntry[] = [];
	for (const line of lines.slice(1)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isExampleEntry(parsed)) continue;
		entries.push(inherited !== undefined && parsed.tier === undefined ? { ...parsed, tier: inherited } : parsed);
	}
	return { header, entries };
}

// ─── 本机语料账本(sources.json)────────────────────────────────────────────────

export const SOURCES_SCHEMA_TAG = "yoma/examples-sources@1";

/**
 * 语料的远程形态(examples sync 写入):语料包与派生索引住在文件服务器
 * (rag_yoma)的 OSS 上,本机按需落地到 cache/。sha256 来自服务器的清单,是下载
 * 校验与缓存失效的唯一依据 —— 服务器对同一 id 不会改发不同字节(id 内嵌 commit),
 * 所以 sha 对不上就是传输坏了或缓存坏了,没有第三种解释。
 */
export interface CorpusRemote {
	/** 服务器基地址,如 http://127.0.0.1:8080(无尾斜杠)。 */
	server: string;
	commit?: string;
	archiveSha256: string;
	archiveBytes: number;
	indexSha256: string;
	enrichSha256?: string;
}

/**
 * 一份语料在这台机器上的落点。root(本机检出,CLI index 写)与 remote(服务器
 * 形态,examples sync 写)二选一或并存:并存时 root 优先 —— 本机有的东西不走网络。
 * 两者都是本机事实,所以这份文件永远不进 git。
 */
export interface CorpusSource {
	id: string;
	ecosystem: Ecosystem;
	/** 本机检出形态的语料根;远程形态下为空串。 */
	root: string;
	remote?: CorpusRemote;
}

export interface ExamplesSources {
	schema: typeof SOURCES_SCHEMA_TAG;
	corpora: CorpusSource[];
}

export function isCorpusRemote(value: unknown): value is CorpusRemote {
	if (!isPlainObject(value)) return false;
	if (typeof value.server !== "string" || value.server.trim() === "") return false;
	if (typeof value.archiveSha256 !== "string" || value.archiveSha256 === "") return false;
	if (typeof value.archiveBytes !== "number" || !Number.isFinite(value.archiveBytes) || value.archiveBytes <= 0) return false;
	if (typeof value.indexSha256 !== "string" || value.indexSha256 === "") return false;
	if (value.enrichSha256 !== undefined && typeof value.enrichSha256 !== "string") return false;
	return true;
}

export function isCorpusSource(value: unknown): value is CorpusSource {
	if (!isPlainObject(value)) return false;
	if (typeof value.id !== "string" || value.id.trim() === "") return false;
	if (!isEcosystem(value.ecosystem)) return false;
	if (typeof value.root !== "string") return false;
	// root 与 remote 至少有一个:账本里两样都没有的条目读出来只会误导,当坏行丢掉。
	if (value.root.trim() === "" && !isCorpusRemote(value.remote)) return false;
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
