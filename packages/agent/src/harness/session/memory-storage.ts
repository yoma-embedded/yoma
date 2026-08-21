// Step 2:内存版 SessionStorage —— 树的全部逻辑第一次在这里成形,没有磁盘干扰。
// 三个关键设计:
//   1. appendEntry 收到的是"完整"条目(id/parentId 由上层 Session 分配),存储只负责
//      追加 + 维护缓存 + 推进 leaf;
//   2. setLeafId 不是改内存变量,而是追加一条 leaf 条目 —— JSONL 重放时才能恢复光标;
//   3. leafIdAfterEntry:普通条目让 leaf 指向自己,leaf 条目让 leaf 指向它的 targetId。
/**
 * 职责:SessionStorage 接口的纯内存实现 —— 会话树"条目=节点、leaf=游标"这套模型
 * 第一次在这里成形,不掺 JSONL 落盘/逐行重放的细节,是理解树语义的最短路径。
 *
 * 全景链路位置:对应全景篇《00-内核全景.md》§4 阶段 0.3(建/开会话)与阶段 1 步骤 3a
 * (session.getBranch() → storage.getLeafId() → storage.getPathToRoot())。
 * 生产路径(桌面端 / ACP)走的是 jsonl-storage.ts,这个类只喂测试与 InMemorySessionRepo
 *(memory-repo.ts);但 jsonl-storage.ts 的 open() 逐行重放用的正是本文件
 * generateEntryId / leafIdAfterEntry / updateLabelCache 三个函数的独立复刻(没有 import
 * 关系,两边各自维护一份,改一边不会联动另一边),建议先读这里再读 jsonl。
 *
 * 对应学习文档:docs/learn/agent/harness_session_memory-storage.md
 *
 * 分节索引:
 *   §1 导入
 *   §2 label 缓存维护(updateLabelCache / buildLabelsById)
 *   §3 生成条目 id(generateEntryId)
 *   §4 leaf 推进规则(leafIdAfterEntry)
 *   §5 InMemorySessionStorage:字段与构造
 *   §6 元数据与 leaf 读取(getMetadata / getLeafId)
 *   §7 写入三件套(setLeafId / createEntryId / appendEntry)
 *   §8 按 id / 类型 / 标签查询(getEntry / findEntries / getLabel)
 *   §9 树遍历(getPathToRoot / getEntries)
 */

// ── §1 导入 ──────────────────────────────────────────────────────────
import {
	type LeafEntry,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
import { uuidv7 } from "./uuid.ts";

// ── §2 label 缓存维护 ────────────────────────────────────────────────
// label 条目(LabelEntry)本身是追加日志的一部分,不能被删改;"重命名"和"删除标签"
// 都是再追加一条新的 label 条目。labelsById 是这份日志上"当前有效标签"的物化缓存,
// 存在的唯一理由是让 getLabel(id) 不必每次现扫全部条目。
/**
 * 用一条 label 条目更新 labelsById 缓存。非 label 类型直接跳过。
 * 空 label(trim 后为空串)按"删除标签"处理,而不是写入空字符串 —— 与 LabelEntry
 * 的语义一致:label 字段是 `string | undefined`,空值表示"这个 targetId 曾经打过标签,
 * 现在被撤销了"。
 * 调用方按条目原始顺序依次调用即可保证"最后一条 label 赢"(latest label wins)。
 */
function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId); // 空 label = 删除标签,"latest label wins"
	}
}

/** 从一段完整的条目序列重建 labelsById 缓存,用于构造函数按传入的 entries 初始化。 */
function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

// ── §3 生成条目 id ───────────────────────────────────────────────────
/**
 * 生成一个不与现有条目冲突的短 id(uuidv7 的随机尾 8 字符)。
 * 参数只要求 `has(id)`,不要求完整的 Map,方便脱离 InMemorySessionStorage 单测。
 * 撞车时最多重试 100 次;100 次仍撞车(概率极低,8 个十六进制字符 = 32 位随机空间)
 * 就放弃截断,直接返回完整 uuidv7 —— 保证这个函数本身永不失败。
 */
function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		// uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部。
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

// ── §4 leaf 推进规则 ─────────────────────────────────────────────────
/**
 * 给定一条刚写入的条目,算出写完它之后 leaf 应该指向哪里。
 * 普通条目(message/model_change/label/…):leaf 前进到它自己 —— "追加即前进"。
 * leaf 条目:leaf 跳到它记录的 targetId,可能等于当前位置(原地打个记号)也可能是
 * 树中间的旧条目(moveTo 分支切换)。这也是为什么 leaf 条目永远不会出现在任何
 * getPathToRoot 路径里 —— 它只描述"光标去哪",不参与"对话内容是什么"。
 * appendEntry 与构造函数重放都调用这一个函数,保证两条路径对"leaf 该停在哪"同解。
 */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

// ── §5 InMemorySessionStorage:字段与构造 ────────────────────────────
/**
 * SessionStorage<TMetadata> 的内存实现。五个私有字段,其中四个管树状态、各管一件事:
 * entries 是唯一的真源(按写入顺序追加的完整日志);byId 是按 id 查条目的索引;
 * labelsById 是"当前有效标签"的物化缓存;leafId 是树上唯一的游标。
 * 后三者都能从 entries 重新推导 —— 之所以仍然缓存,是为了让 getEntry / getLabel /
 * getLeafId 保持 O(1),不必每次现扫整段历史。
 * 第五个字段 metadata(readonly)与树状态无关:构造时定死,全程不变,不参与推导。
 */
export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionStorage<TMetadata>
{
	private readonly metadata: TMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private leafId: string | null;

	/**
	 * 两种用法:不传 options 建一个空会话(leaf = null,metadata 自动生成);
	 * 传 entries 用已有的一段条目"重放"出内存状态,供 fork(memory-repo.ts)与测试用
	 * 已知历史初始化存储。entries 会被浅拷贝(`[...]`),调用方传入的数组之后再改动
	 * 不会影响这个实例。
	 */
	constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
		this.entries = options?.entries ? [...options.entries] : [];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(this.entries);
		this.leafId = null;
		// 依次把每条条目的"leaf 推进结果"覆盖上去,循环跑完时 this.leafId 就是
		// "整段历史重放到最后"应停留的位置 —— 效果等价于 jsonl-storage.ts open() 的
		// 逐行重放,只是这里 entries 已经在内存里,不需要真的一行行读。
		for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);
		// 防御性校验:如果传入的 entries 本身就是一段断裂的历史(比如 fork 时漏带了
		// leaf 条目 targetId 指向的那条),此时立刻报错比"静默地把 leaf 指向不存在的
		// 条目、等到某次 getPathToRoot 才炸"要好定位得多。
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		// metadata 不传时现造一份:id 用完整 uuidv7(不像条目 id 那样截断,理由见
		// uuid.ts 与全景篇 §7 关于 uuidv7 两种用法的说明)。
		this.metadata = options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata);
	}

	// ── §6 元数据与 leaf 读取 ────────────────────────────────────────
	/** 返回构造时确定的会话元数据(id / createdAt),内存实现里全程不变。 */
	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}

	/**
	 * 返回当前 leaf id(树上的游标),null 表示会话还没有任何一条对话消息。
	 * 与构造函数里同样的校验在这里又做了一遍:setLeafId 走的是校验过的路径,但
	 * appendEntry 是接口方法,外部调用方可以绕过 setLeafId 直接塞一条 targetId
	 * 指向不存在条目的 leaf 条目——这里补一道闸门,让"读到一个悬空游标"在读的
	 * 那一刻就报错,而不是让调用方拿着一个查不到的 id 继续往下用。
	 */
	async getLeafId(): Promise<string | null> {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return this.leafId;
	}

	// ── §7 写入三件套 ────────────────────────────────────────────────
	/**
	 * 把游标挪到 leafId(通常来自 Session.moveTo,即分支切换/回退)。
	 * 关键点(全景篇反复强调的一条):这不是简单赋值 `this.leafId = leafId`,
	 * 而是先追加一条 `{type:"leaf", targetId:leafId}` 条目,再让内存变量跟上。
	 * 落盘实现(jsonl-storage.ts)靠这条条目在重放时恢复光标位置——内存实现虽然
	 * 不需要重放也能"记住"leaf(变量本身就在),但两个实现必须共用同一份语义,
	 * 否则同一段 entries 数组在两种 storage 之间搬家(比如内存版单测切到落盘版)
	 * 就会得到不同的 leaf。
	 * parentId 取"当前 leaf"(挪之前的位置),所以这条 leaf 条目挂在旧游标下面,
	 * 而不是新目标下面——它记录的是"发生了一次跳转"这件事本身。
	 */
	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = leafId;
	}

	/** 分配一个新条目 id,供上层 Session 在构造完整条目(带 id/parentId/timestamp)之前调用。 */
	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	/**
	 * 追加一条"完整"条目——id、parentId、timestamp 均已由调用方(Session 类)填好,
	 * 这个方法本身**不做任何校验**,只负责三件事:压入 entries 真源、更新 byId 索引、
	 * 按条目类型推进 label 缓存与 leaf 游标。信任调用方是有意的设计:校验(id 是否
	 * 已存在、parentId 是否指向真实条目)属于"谁在造条目"的责任,不属于"怎么存"。
	 */
	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.leafId = leafIdAfterEntry(entry);
	}

	// ── §8 按 id / 类型 / 标签查询 ───────────────────────────────────
	/** 按 id 查一条条目,查不到返回 undefined(不抛错——"条目存不存在"由调用方判断)。 */
	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	/**
	 * 按类型线性扫描全部条目(不限于当前 leaf 路径,包括已离开投影的分支)。
	 * 类型参数 TType 用于按 `entry.type` 收窄返回的联合成员,调用方拿到的数组元素
	 * 类型是精确的(比如 findEntries("session_info") 返回 SessionInfoEntry[])。
	 * O(n) 全表扫描;内存实现里没有按类型建索引,量级小(测试/浏览器场景)时够用。
	 */
	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	/** 查某个条目当前生效的标签,没有(或已被撤销)返回 undefined。 */
	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	// ── §9 树遍历 ────────────────────────────────────────────────────
	/**
	 * 从 leafId 沿 parentId 一路走到根,返回 [根, ..., leafId] —— 这就是"当前对话"
	 * 的完整定义(全景篇称之为"当前分支")。leafId 为 null 时会话还没有任何消息,
	 * 直接返回空数组。中途任何一环的 parentId 指向一个 byId 里查不到的条目,
	 * 说明这段历史链本身是断的(数据损坏或构造时传入了不完整的 entries),
	 * 立刻抛 invalid_session,而不是悄悄截断返回一段不完整的路径。
	 * 用 unshift 而不是先 push 再 reverse:路径通常很短(几十到几百条),
	 * unshift 的 O(n) 重排在这个量级下不构成问题,换来的是代码更直白。
	 */
	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	/** 返回完整的追加日志(所有分支、所有 leaf 条目都在,不只是当前路径),浅拷贝防止调用方改到内部状态。 */
	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}
