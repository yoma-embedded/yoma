// 内存会话仓库。对应 pi harness/session/memory-repo.ts,逐字移植
//(Session 类型改从 ./session.ts 直接导入,理由见 jsonl-repo.ts)。
// 与 JsonlSessionRepo 实现同一个 SessionRepo 语义,测试与浏览器场景用。
/**
 * 职责:SessionRepo 接口的内存实现 —— "一堆会话怎么建 / 开 / 列 / 删 / fork"这件事
 * 只存进一个 Map<string, Session>,不落盘。
 *
 * 全景位置:与 jsonl-repo.ts 一一对应(同一套 SessionRepo 契约),但不在"一次 prompt"
 * 的生产链路上 —— AgentHarness 只依赖 Session/SessionStorage,从不直接持有 SessionRepo,
 * 建/开/列/删/fork 会话是应用层(测试、宿主)的事。消费方是 test/harness/repo.test.ts,
 * 以及需要在没有 FileSystem 的环境(浏览器)里跑会话的场景;经 index.ts 的 barrel 导出,
 * 是 index.ts 保持"浏览器安全"的原因之一 —— 它不像 JsonlSessionRepo 那样依赖 Node fs。
 *
 * 对应学习文档:docs/learn/agent/harness_session_memory-repo.md
 *
 * 分节索引:
 *   §1 类与状态 —— 唯一字段 sessions 这张 Map 就是全部存储
 *   §2 create / open / list / delete —— 四件事直接对应 Map 的增 / 查 / 遍历 / 删
 *   §3 fork —— 取材(委托 repo-utils 的公共规则)+ 建一个独立的新会话
 */
import { SessionError, type SessionMetadata, type SessionRepo } from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork, toSession } from "./repo-utils.ts";
import type { Session } from "./session.ts";

// ── §1 类与状态 ──────────────────────────────────────────────
// TListOptions 定死成 void:内存实现没有 cwd 概念,list() 不接受任何过滤条件,
// 所有会话共享同一个全局命名空间(对比 JsonlSessionRepo 的 list({ cwd })按目录过滤)。
export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	// 这一张 Map 就是"仓库"的全部存储:key 是 SessionMetadata.id,value 是已经
	// 包好 InMemorySessionStorage 的 Session 门面对象本身(不是可重建的描述符)。
	// 这意味着 open() 拿到的与 create()/fork() 建出来的是同一个对象引用 —— 见 §2。
	private sessions = new Map<string, Session<SessionMetadata>>();

	// ── §2 create / open / list / delete ────────────────────────
	/**
	 * 建一个新会话:metadata.id 不给就用 createSessionId() 现铸一个,createdAt 现打时间戳,
	 * 然后用一个空的 InMemorySessionStorage 包成 Session 存进 Map。
	 * 与 JsonlSessionRepo.create() 不同,这里没有目录创建、没有落盘,纯内存对象图。
	 */
	async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}

	/**
	 * 按 metadata.id 查表。
	 * 关键差异(别当成和 JsonlSessionRepo.open() 等价):这里返回的是 Map 里存的**同一个**
	 * Session 对象引用,不是重新构造的 —— JSONL 版本每次 open() 都会重新读文件、
	 * 造一份新的 JsonlSessionStorage/Session。所以内存版"开两次同一个会话"拿到的是
	 * 同一个对象,一处 append 会立刻对所有持有者可见;JSONL 版则各自独立,
	 * 不重新 open 看不到别处的写入。test/harness/repo.test.ts:17 用 `toBe` 钉住了这一点。
	 */
	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		const session = this.sessions.get(metadata.id);
		if (!session) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		return session;
	}

	/** 列出全部会话的 metadata。Map 的迭代顺序是插入顺序,所以天然按创建先后排列。 */
	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
	}

	// Map.delete 对不存在的 key 直接返回 false、不抛错 —— 与 JsonlSessionRepo.delete()
	// 用 `remove(path, { force: true })` 达成的"删不存在的文件也不报错"语义对齐,
	// 不是这里偷懒漏了校验。调用方不能指望 delete() 告诉你"根本没这个会话"。
	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	// ── §3 fork ──────────────────────────────────────────────────
	/**
	 * 建一个新会话,内容是源会话的一段历史(取材规则见 repo-utils.ts 的 getEntriesToFork:
	 * position "at" 含目标条目本身,默认 "before" 要求目标是 user 消息、取它的 parentId)。
	 * 与 JsonlSessionRepo.fork() 的唯一形状差异是 options 没有 cwd —— 内存实现压根
	 * 没有目录概念,新会话与源会话共处同一个全局 Map。
	 */
	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<SessionMetadata>> {
		// 复用 open() 而不是直接查 Map:这样"源会话不存在"会先在这里抛 not_found,
		// 而不是让 getEntriesToFork 稀里糊涂地对 undefined storage 操作。
		const source = await this.open(sourceMetadata);
		// 注意:这里拿到的 SessionTreeEntry[] 是 getPathToRoot 新 unshift 出来的数组,
		// 但数组里的条目对象与源会话 storage 内部 byId/entries 持有的是**同一引用**
		// (InMemorySessionStorage 构造函数只对数组做 `[...entries]` 浅拷贝)。
		// 目前全仓没有代码会原地修改一条已 append 的 entry(只增不改),所以共享引用
		// 是安全的;但这是约定而非类型保证 —— 谁要是哪天"就地改一条 entry",
		// 源会话和它所有的 fork 会一起被污染。
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}
}
