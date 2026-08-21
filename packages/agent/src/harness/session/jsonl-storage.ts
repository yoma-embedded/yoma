// Step 4:JSONL 磁盘存储 —— 与 InMemorySessionStorage 同一接口的落盘实现。
// 文件格式:第一行 header(version 3),之后一行一个 JSON 条目;只有两种写操作:
// create 时写 header,之后永远 appendFile(追加式)。
// open() 逐行重放,用 leafIdAfterEntry 边读边推演 leaf 位置 —— "光标是条目"在这里兑现。
// 注意窄依赖:只需要 FileSystem 的 4 个方法。
/**
 * 会话落盘层(JSONL storage):把一棵会话树写成「第一行 header + 一行一条目」的追加日志,
 * 并在重开时逐行重放回内存。它是 SessionStorage 接口的磁盘实现,与 memory-storage.ts 的
 * InMemorySessionStorage 逐方法对应 —— 上层 Session 只认接口,不知道自己在写内存还是写盘。
 *
 * 全景位置:全景篇 §4 阶段 0 的 0.3(建/开会话文件)与 §1 图里的 ⑫ 落盘。
 * 一次 prompt 里它被读两次、被写很多次:
 *   读 —— createTurnState() → Session.buildContext() → getLeafId() + getPathToRoot()(§4 第 3/3a 步);
 *   写 —— handleAgentEvent 收到 message_end 直接调 Session.appendMessage()(先落盘再转发);
 *        turn_end / agent_end 那两次 flushPendingSessionWrites() 排的是订阅者攒下的挂起写入,
 *        不是 message_end 这条路。两条路最后都落到 appendEntry()。
 * 它不认识消息、模型、压缩,只认识「条目」这一层抽象。
 *
 * 对应学习文档:docs/learn/agent/harness_session_jsonl-storage.md
 *
 * 分节索引:
 *   §1  依赖与两张契约:窄 FileSystem 切片 + SessionHeader
 *   §2  内存索引的三个维护器:标签缓存、条目 id 生成
 *   §3  两个错误构造器:invalid_session 与 invalid_entry
 *   §4  header 行的解析与校验
 *   §5  条目行的解析与校验
 *   §6  重放规则 leafIdAfterEntry 与 header→metadata
 *   §7  两条读路径:只读一行的快路 / 整文件重放的全路
 *   §8  类字段与私有构造:内存里的三份索引
 *   §9  open() / create():这个文件生命中唯一一次覆盖写
 *   §10 光标:getMetadata / getLeafId / setLeafId
 *   §11 追加:createEntryId / appendEntry(先落盘,后改内存)
 *   §12 查询:getEntry / findEntries / getLabel
 *   §13 走树:getPathToRoot / getEntries
 */
// ── §1 依赖与两张契约:窄 FileSystem 切片 + SessionHeader ──────────────────
import type { FileSystem, JsonlSessionMetadata, LeafEntry, SessionStorage, SessionTreeEntry } from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";
import { uuidv7 } from "./uuid.ts";

// 只 Pick 四个方法而不是收整个 FileSystem,这是刻意的「窄依赖」。
// 一是测试可以拿四个字面量函数当替身(storage.test.ts 最后一例的 readTextFile 故意抛错,
// 用来证明列表路径确实没读全文);二是任何环境(浏览器 OPFS、远端沙箱)只要实现这四个
// 就能托管会话文件 —— 全景篇把这条列为 Repo/Storage 两层抽象的实际收益。
type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

// JSONL 文件的第一行。它不是条目(没有 id/parentId/timestamp 这套树语义),
// 而是整个会话的元数据。version 被钉成字面量 3,校验时严格相等,见 §4。
interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	// fork 出来的会话在这里记「源文件路径」而不是源 sessionId —— 它是位置,不是身份。
	parentSession?: string;
	// 宿主自定义的一坨 JSON(桌面端塞过 profile 之类),内核自己一个字段都不读、原样往返。
	metadata?: Record<string, unknown>;
}

// ── §2 内存索引的三个维护器:标签缓存、条目 id 生成 ────────────────────────
/**
 * 把一条 label 条目折算进标签缓存。非 label 条目直接返回,所以调用方可以对每条条目无脑调一次。
 * 语义是「后写覆盖先写」:空 label(或全空白)表示删标签,因此这里是 delete 而不是写空串 ——
 * 否则 getLabel 会返回 "" 而不是 undefined,调用方的 `?? 默认值` 全部失效。
 * 与 memory-storage.ts 的同名函数逐字相同:两份实现刻意没抽公共文件,树语义必须同解。
 */
function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	// 先 trim 再判断:只含空格的 label 视同「没写」,与空串同义。
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		// 删除而不是存空值:labelsById 里不留空项,getLabel 的「没有标签」只有 undefined 一种表示。
		labelsById.delete(entry.targetId);
	}
}

/**
 * open() 重放时一次性建标签缓存:顺序扫全部条目,后来的 label 覆盖先前的。
 * 返回值直接当缓存用,之后由 appendEntry 增量维护(§11)—— 全量重建只发生在打开文件那一次。
 */
function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

/**
 * 铸一个新条目 id,并在 byId 里查重。参数只要求 has(id),所以内存实现与这里共用同一个签名,
 * 测试也能塞一个假 Set 进来。
 * 【坑一】它只「查了一下重」,不预留:从这里拿到 id 到 appendEntry 之间隔着 await,
 *   并发的两个 append 能拿到同一个 id,而且一定拿到同一个 parentId(意外分叉而不是链)。
 * 【坑二】slice(-8) 取的是 uuidv7 的随机尾部(bytes[12..15]),时间戳一位都没进去 ——
 *   短 id 只有 32 位纯熵、完全不可排序。uuid.ts 头两行那句「ID 天然按时间排序」
 *   只对完整 uuidv7(sessionId)成立,对条目 id 是错的。桌面端投影器因此不敢用内核的 id。
 */
function generateEntryId(byId: { has(id: string): boolean }): string {
	// 100 次是「撞车概率低到不值得再试」的经验值:32 位熵配上单会话几千条条目,
	// 循环几乎总在第一次就返回;写成循环只是为了让极小概率的碰撞不产生重复 id。
	for (let i = 0; i < 100; i++) {
		// uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部。
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	// 兜底:100 次全撞车就返回完整 36 字符的 uuidv7。
	// 于是同一个会话里可能混着 8 字符和 36 字符两种 id —— 长度不能当作 id 的判据。
	return uuidv7();
}

// ── §3 两个错误构造器:invalid_session 与 invalid_entry ────────────────────
/**
 * 文件级损坏(header 读不出来 / 版本不对)。code 用 invalid_session 是有讲究的:
 * JsonlSessionRepo.list() 只吞这一种 code(jsonl-repo.ts 的 list() 里那句 code 判断),别的原样往上抛。
 * 也就是说 header 坏掉的会话在列表里被静默跳过,而条目坏掉的会话照常列出来。
 */
function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

/**
 * 行级损坏。lineNumber 由调用方传入,只用于人肉定位。
 * 【坑】这个行号是「过滤掉空行之后」的序号(见 §7 loadJsonlStorage 里的 filter),
 * 文件中间若有空行,报出来的行号会比真实行号小。
 */
function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

// ── §4 header 行的解析与校验 ──────────────────────────────────────────────
/**
 * 解析并逐字段校验第一行 header,返回一个重新构造的干净对象(不是原样透传)。
 * 任何一项不合格都 throw SessionError("invalid_session"),没有「尽力而为」的分支 ——
 * 会话文件是唯一的历史,读一半比读不出来更危险。
 */
function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	// JSON.parse 抛的是 SyntaxError;toError 把它归一化成 Error 再挂进 cause,
	// 这样上层拿到 SessionError 的同时还留着原始报错的位置信息。
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	// typeof null === "object",所以 null 必须单独排掉。
	// 数组能过这一关,但下一行的 type !== "session" 会把它挡住。
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
	// 严格 === 3:没有任何迁移分支。version 1/2 的老文件一律打成 invalid_session,
	// 而 list() 恰好吞这个 code —— 表现是「我的老会话不见了」而不是报错。
	if (header.version !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof header.id !== "string" || !header.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof header.timestamp !== "string" || !header.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof header.cwd !== "string" || !header.cwd) throw invalidSession(filePath, "session header is missing cwd");
	// parentSession / metadata 都是可选字段:undefined 放行,有值才校验类型。
	// 与条目行的 parentId 相反(那边 undefined 是不合法的,见 §5)。
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	// Array.isArray 这一项不能省:数组也是 object,而 metadata 的契约是 Record<string, unknown>,
	// 放一个数组进来下游取 key 会全是数字下标。
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(filePath, "session header metadata must be an object");
	}
	// 白名单式重建:返回的七个字段里 type/version 是写死的字面量,真正抄自文件的只有另外五个。
	// 文件里带的额外字段到此为止,不进内存,
	// 也不会在 fork 复制元数据时被无意传播。
	return {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
}

// ── §5 条目行的解析与校验 ────────────────────────────────────────────────
/**
 * 解析一行条目。只校验所有条目共有的四件套(type/id/parentId/timestamp)外加 leaf 的 targetId,
 * 然后直接 as SessionTreeEntry 强转 —— 载荷(message 的内容块、compaction 的 summary……)一个字都不校验。
 * 这是取舍:深校验要给 AgentMessage 写一份运行时 schema,而那会让「老文件遇上新内容类型」直接开不开;
 * 代价是一条缺 message 字段的 message 条目能顺利读进来,到 sessionEntryToContextMessages 才炸,
 * 那时已经看不出是哪一行坏了。
 */
function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	}
	// 只声明要校验的五个字段、其余保持 unknown:这个局部类型不是条目的真实形状,
	// 只是校验用的窥视孔,真实形状由下面那次强转承担。
	const entry = parsed as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(filePath, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	// 注意条件的写法:parentId 必须显式存在,且为 string 或 null。
	// 少写这个字段(undefined)会掉进这个分支被判非法 —— 根条目要写 "parentId": null。
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof entry.timestamp !== "string" || !entry.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	// 只校验 leaf 的 targetId,因为 §6 的重放规则要拿它当下一个光标,坏了会让整棵树的入口跑偏;
	// label 条目也有 targetId,但那个坏了顶多丢个标签。
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	// 强转:上面五项过了就当它是合法条目。这是整个文件里信任度最低的一行。
	return entry as SessionTreeEntry;
}

// ── §6 重放规则 leafIdAfterEntry 与 header→metadata ──────────────────────
/**
 * 追加日志的重放规则,整个存储层最核心的一行:
 * 普通条目写完后光标指向它自己(于是顺序对话天然是一条直链);
 * leaf 条目写完后光标指向它的 targetId(这就是「把光标本身写成数据」)。
 * open() 逐行套用它,就能恢复用户上次真正停留的位置,而不是回到最后一条条目。
 * 推论:leaf 条目永远不会成为别人的 parentId,它是日志上的侧枝,不出现在任何一条
 * getPathToRoot 路径里 —— 除非有人拿 leaf 条目的 id 去调 setLeafId,那是能通过校验的(§10)。
 * 与 memory-storage.ts 的同名函数逐字相同。
 */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

/**
 * header(文件里的形状)→ JsonlSessionMetadata(上层认的形状)。两处差异值得记:
 * 字段名 timestamp → createdAt;path 不在文件里,由调用方把「我是从哪个路径读到的」补进来,
 * 所以同一个会话文件换个路径打开,metadata.path 就跟着变 —— 它是位置而不是身份。
 */
function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
		metadata: header.metadata,
	};
}

// ── §7 两条读路径:只读一行的快路 / 整文件重放的全路 ──────────────────────
/**
 * 【快路】JsonlSessionRepo.list() 对每个 .jsonl 文件调它一次。
 * 走 readTextLines({maxLines:1}) 而不是 readTextFile,是为了让「列出 200 个会话」不必把
 * 200 份完整对话读进内存 —— NodeExecutionEnv 的实现读够一行就 break 并 destroy 掉流。
 * 失败语义:抛 invalid_session,而 list() 恰好只吞这一种(§3),于是坏文件被静默跳过。
 * 【坑】这条快路读的是物理第一行,而下面的全路会先滤掉空行:文件开头多一个空行,
 * list() 里这个会话就「消失」了,open() 却能正常打开。两条路径对同一个文件不同解。
 */
/** 只读 header 一行即可取会话元数据(列表场景避免整文件读取)。 */
export async function loadJsonlSessionMetadata(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	// 文件为空时 readTextLines 返回空数组,lines[0] 是 undefined;
	// 下一行的可选链把「空文件」和「第一行是空白」合并成同一个错误。
	const line = lines[0];
	if (line?.trim()) return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	throw invalidSession(filePath, "missing session header");
}

/**
 * 【全路】open() 的实现:整文件读进内存 → 第一行当 header → 其余逐行解析并重放光标,
 * 返回 header、条目数组、重放出来的 leafId 三样东西。
 * 【坑一】没有流式路径。会话越长这一下越贵,而且全文字符串与解析后的对象会同时在内存里。
 * 【坑二】崩溃写了一半的行没有任何修复逻辑:残缺 JSON 直接 invalid_entry,整个 open 失败。
 *   全仓找不到「跳过坏行」的代码 —— 宁可开不开,也不悄悄丢历史。
 */
async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<{
	header: SessionHeader;
	entries: SessionTreeEntry[];
	leafId: string | null;
}> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	// 滤空行有两个作用:吃掉文件末尾那个换行造成的空串,以及容忍中间的空行。
	// 代价是行号错位 —— 传给 parseEntryLine 的 i+1 是过滤后的序号(§3 的坑)。
	// 这里不 trim 每一行也没关系:CRLF 文件行尾留下的 \r 是合法的 JSON 空白。
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) {
		throw invalidSession(filePath, "missing session header");
	}

	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	// 从 1 开始:0 号已经当 header 消费掉了。
	// 每一步都无条件覆盖 leafId,循环结束时它就是「最后一条条目决定的光标」——
	// 这正是 §6 的重放规则在文件维度上的兑现,也是「光标是条目」这个设计的全部收益。
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	return { header, entries, leafId };
}

// ── §8 类字段与私有构造:内存里的三份索引 ────────────────────────────────
/**
 * SessionStorage 的磁盘实现。它本质上是一个带内存缓存的写前端:
 * 所有读操作(getEntry / findEntries / getLabel / getPathToRoot / getEntries)都只查内存,
 * 一次磁盘都不碰;只有 setLeafId 与 appendEntry 两个方法会 appendFile。
 * 于是「写盘成功才改内存」这个顺序是承重的(§10/§11)。
 * 另一面:别的进程同时写同一个文件时,这里的内存就是脏的,而且没有任何检测机制 ——
 * 一个会话文件同一时刻只该有一个 storage 实例在写。
 */
export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	// 同一份数据的三个视角:entries 保序(getEntries / findEntries 用),
	// byId 供 O(1) 命中(getEntry / getPathToRoot / 查重用),
	// labelsById 是 label 条目的折算结果(getLabel 用)。两个写方法负责让它们同时前进。
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	// 光标只在内存里缓存;真相在文件里(最后一条条目 + 重放规则)。
	private currentLeafId: string | null;

	/**
	 * 私有构造:外部只能走 open() / create()。理由是这两条路都得先落地文件
	 * (读到 header,或写下 header),而构造函数不能 await。
	 * 【与内存实现的一处差异】InMemorySessionStorage 的构造函数会校验 leafId 是否存在
	 * (memory-storage.ts 构造函数末尾),这里不校验 —— 于是指向不存在条目的悬空光标能顺利 open(),
	 * 直到第一次 getLeafId() 才抛 invalid_session(§10 补上了这一刀)。
	 */
	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		// 用 Map 构造器一次建索引;id 重复时后写的赢,而 entries 数组里两条都留着。
		// 文件里出现重复 id 不会报错 —— 追加日志没有唯一性约束,查重只发生在铸新 id 的那一刻。
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
	}

	// ── §9 open() / create():这个文件生命中唯一一次覆盖写 ─────────────────────
	/**
	 * 打开已存在的会话文件,对应全景篇 §4 阶段 0 的 0.3。
	 * 文件不存在时 readTextFile 返回 not_found 的 Result,经 getFileSystemResultOrThrow
	 * 变成 SessionError("not_found")—— storage.test.ts 直接钉住了这个 code。
	 */
	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}

	/**
	 * 新建会话文件:拼一个 header 写下去,内存里从零条条目、光标为 null 开始。
	 * filePath 由 JsonlSessionRepo 拼(<root>/--cwd 编码--/<时间戳>_<sessionId>.jsonl),
	 * 这里只管写,不管目录存不存在 —— 建目录是 repo 的活(jsonl-repo.ts 的 create())。
	 * 【坑】用的是 writeFile,也就是覆盖。对一个已存在的会话文件调 create,
	 * 整份历史会被一行 header 顶掉,而且不报错;repo 靠「时间戳 + sessionId」的文件名绕开它。
	 */
	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionPath?: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			// 这一次取时与 repo 拼文件名时那一次(repo-utils.ts 的 createTimestamp)是两次独立调用,
			// 可能差几毫秒;list() 排序用的是 header 里这一份,所以按文件名排和按 createdAt 排可能不一致。
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
			metadata: options.metadata,
		};
		// 这是整个文件生命中唯一一次 writeFile,此后只有 appendFile。
		// 结尾那个 \n 不能少:下一次 appendFile 直接从新行开始写,没人会回头补换行。
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		// 写成功之后才建对象:不会出现一个「以为自己已落盘」而文件根本不存在的存储实例。
		return new JsonlSessionStorage(fs, filePath, header, [], null);
	}

	// ── §10 光标:getMetadata / getLeafId / setLeafId ─────────────────────────
	/** 元数据在构造期就从 header 折算好了,这里不读盘;返回的是同一个对象引用,调用方别改它。 */
	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	/**
	 * 返回当前光标。它多做的那件事是每次都验一遍光标还在不在 —— 这是构造期不校验的补偿(§8),
	 * 悬空光标的 invalid_session 从这里抛出来。
	 * 上层 Session.getBranch() 每轮开头都会调它(全景篇 §4 第 3a 步),所以坏会话最晚在
	 * 第一次 prompt 时暴露,而不是在打开会话时。
	 */
	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	/**
	 * 移动光标。它不是「改一个内存变量」,而是往日志里追加一条 leaf 条目 ——
	 * 光标必须是数据,否则重开文件只能回到最后一条条目(§6)。
	 * 目标不存在时抛 not_found,注意与 getLeafId 的 invalid_session 是不同的 code:
	 * 前者是调用方给错了,后者是文件自己坏了。
	 * 传 null 合法,表示回到空会话,下一条追加的条目就成了新的根。
	 */
	async setLeafId(leafId: string | null): Promise<void> {
		// 查的是 byId,而 byId 里包含 leaf 条目 —— 所以把光标指到一条 leaf 条目上是能通过校验的。
		// 正常调用方(Session.moveTo)不会这么干,但它并没有被拦住。
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			// leaf 条目的 parentId 记的是「从哪儿跳走的」,targetId 才是「跳到哪儿」。
			// 于是日志保留了跳转轨迹,而树的形状(谁挂在谁下面)完全不受影响。
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		// 顺序承重:先落盘,成功了才动内存三件套。反过来写的话,一次写盘失败就会留下
		// 「内存以为光标动了、文件里没这回事」的分裂状态,而下次 open 会把它推翻。
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		// 光标落在 targetId 上,而不是这条 leaf 条目自己的 id —— 与 §6 的重放规则同解。
		this.currentLeafId = leafId;
	}

	// ── §11 追加:createEntryId / appendEntry(先落盘,后改内存)───────────────
	/**
	 * 给上层要一个新条目 id。只查重,不预留 —— 并发风险见 generateEntryId 的说明(§2)。
	 * harness 用挂起写入的 FIFO 串行 flush 规避,直接用 Session 的调用方要自己保证串行。
	 */
	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	/**
	 * 追加一条完整条目 —— id / parentId / timestamp 都由上层 Session 填好:session.ts 里九个公开的
	 * append* 一律写 id = await createEntryId()、parentId = await getLeafId();第十处 createEntryId()
	 * 在 moveTo() 的分支摘要里,那儿的 parentId 显式写目标 entryId、不再问一次 leaf。
	 * 存储层不生成也不校验它们:parentId 指向不存在的条目照样写进去,到 getPathToRoot 才会抛。
	 * 五件事按固定顺序做:落盘 → 进数组 → 进 byId → 折算标签 → 推进光标。
	 */
	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		// 同样是「先落盘后改内存」。appendFile 不是原子写:断电可能留下半行,
		// 而那半行会让下次 open() 整个失败(§7)。这里没有任何补救,是已知代价。
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		// label 条目在这里被折算进缓存;非 label 条目进函数就返回,所以可以无脑调用。
		updateLabelCache(this.labelsById, entry);
		// 追加即前进:普通条目让光标指向自己,leaf 条目指向 targetId(§6)。
		// 这就是「顺序对话是一条直链」的全部机制 —— 除了 setLeafId,没有别的地方推进光标。
		this.currentLeafId = leafIdAfterEntry(entry);
	}

	// ── §12 查询:getEntry / findEntries / getLabel ───────────────────────────
	/** 纯内存 O(1) 查找。返回的是活对象而不是拷贝:调用方改了它,内存和文件就分家了。 */
	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	/**
	 * 按 type 全量筛。谓词写成类型守卫,把 SessionTreeEntry 收窄到具体那一支,
	 * 于是 findEntries("compaction") 拿到的元素直接能读 summary,不用再断言一次。
	 * 【范围】扫的是全部条目而不是当前路径 —— 别的分支上的条目也算数。
	 */
	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	/**
	 * 查标签。同样是全量语义:缓存由所有 label 条目按顺序折算而来,
	 * 别的分支上打的标签在这里也看得见(全景篇 §7 记了这一条)。
	 */
	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	// ── §13 走树:getPathToRoot / getEntries ──────────────────────────────────
	/**
	 * 从 leafId 沿 parentId 一路走到根,返回 root→leaf 顺序的条目数组 —— 这就是「当前对话」,
	 * 全景篇 §4 第 3a 步拿到的正是它;不在这条路径上的分支仍在文件里,只是不在投影里。
	 * leafId 为 null 时返回空数组(新会话)。目标不存在抛 not_found,中途断链抛 invalid_session:
	 * 两种 code 区分的是「调用方给错了」和「文件坏了」。
	 */
	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			// unshift 把结果直接攒成 root→leaf 顺序,省掉最后一次 reverse。
			// 它是 O(n) 的,整条路径于是 O(n²) —— 路径长度是「当前对话的条目数」而不是全部条目数,
			// 而且每轮只走一次,和 open() 读全文比起来微不足道。
			path.unshift(current);
			// falsy 判断而不是 === null:空串 parentId 也被当成「到根了」。
			// 手写文件时 "parentId": "" 会安静地被当成根,而不是报断链。
			if (!current.parentId) break;
			// 没有环检测:一份被手工编辑出 a→b→a 的文件会让这个循环永不结束(path 还在无限增长)。
			// 正常写入路径不可能产生环,因为 parentId 只会指向更早写入的条目。
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	/**
	 * 返回全部条目。数组是浅拷贝:数组本身安全,元素还是同一批对象。
	 * JsonlSessionRepo.fork() 拿它去重放,于是新会话的文件是独立的,
	 * 内存里的条目对象却仍与源会话共享(全景篇 §7 记了这条)。
	 */
	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}
