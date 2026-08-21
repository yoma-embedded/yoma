/**
 * 会话仓库(SessionRepo)的公共零件:JSONL 版与内存版两套 repo 共用的五个导出。
 *
 * 全景链路上的位置:阶段 0「装配」的第 0.3 步 —— repo.create() / repo.fork() 在这里铸会话 id、
 * 盖时间戳、包 Session 门面;repo.open() 只有 JSONL 版借最后一步(内存版 open 还回旧 Session)。
 * 但 §4 那个换轨函数并不只在装配期跑:每一条消息落盘(handleAgentEvent → appendEntry
 * → FileSystem.appendFile)的失败也由它翻译成 SessionError,所以它在写入热路径上。
 *
 * 对应学习文档:docs/learn/agent/harness_session_repo-utils.md
 *
 * 分节索引:
 *   §1 导入:Result 世界与 throw 世界的类型在这里碰面
 *   §2 会话身份:createSessionId / createTimestamp
 *   §3 storage → Session 的唯一构造点:toSession
 *   §4 Result → throw 的适配边界:getFileSystemResultOrThrow
 *   §5 fork 取材规则:getEntriesToFork 的 before / at 两条路
 */
// ── §1 导入:Result 世界与 throw 世界的类型在这里碰面 ──────────────────────
// FileError / Result 来自 FileSystem 那一侧(实现方永不 throw,失败编码进 Result),
// SessionError 来自 session 这一侧(失败就抛)。两种约定在 §4 那个函数里换轨。
import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
// 这里 import 的是「值」而不只是类型:§3 要真的 new 它。两个 repo 写的都是 import type
// { Session } —— 它们只把 Session 当返回类型,构造一律委托 toSession,于是运行时值只此一份。
// (jsonl-repo 头注释里那条「二手转口会产生歧义导出」讲的是从哪个模块导入,是另一件事。)
import { Session } from "./session.ts";
// repo 层要的是「完整」uuidv7;storage 层的 generateEntryId() 用的是同一个函数的
// slice(-8)。同源不同用法,别把两者的排序性质搞混(见 §2 与全景篇 §6.1)。
import { uuidv7 } from "./uuid.ts";

// ── §2 会话身份:id 与时间戳 ────────────────────────────────────────────────
/**
 * 铸一个新的会话 id。
 * 参数:无。返回:36 字符的完整 UUIDv7 字符串。不会失败。
 * 与条目 id 的关键区别:条目 id 是 uuidv7().slice(-8),切走的恰好是纯随机尾部,
 * 完全不可排序;而完整值的前 6 字节是毫秒时间戳,所以会话 id 天然按创建时间递增。
 * 两个 repo 都写成 options.id ?? createSessionId():调用方显式给 id 时(测试、
 * 或宿主要复用一个已知 id)不铸新的。
 */
export function createSessionId(): string {
	return uuidv7();
}

/**
 * 盖一个 ISO-8601 UTC 时间戳(形如 2026-08-20T03:04:05.678Z)。
 * 返回:字符串。不会失败。
 * 两个调用方的用法并不相同:memory-repo 拿它当 metadata.createdAt;jsonl-repo 只拿它
 * 拼文件名(冒号和点替换成连字符后当文件名前缀),真正写进 header 的 timestamp 是
 * JsonlSessionStorage.create() 里另一次 new Date()。于是磁盘会话的「文件名时间」与
 * 「createdAt」是两次独立取样,可能差几毫秒;list() 排序用的是 header 那份。
 */
export function createTimestamp(): string {
	return new Date().toISOString();
}

// ── §3 storage → Session 的唯一构造点 ──────────────────────────────────────
/**
 * 把一个 SessionStorage 包成 Session 门面。
 * 参数 storage:内存版或 JSONL 版都行 —— Session 只依赖 SessionStorage 这一个接口,
 * 树的语义(谁挂谁、什么时候推进 leaf)因此只写一遍就同时适用于内存与磁盘。
 * 返回:Session<TMetadata>。不会失败(构造函数只存字段,不做 I/O)。
 * 单开这个函数有两个收益:一是把「唯一需要 Session 运行时值」的地方收在本文件(见 §1);
 * 二是保证经 repo 建出来的会话一律拿默认的 contextBuildOptions(空对象)。
 * 推论:想给某个会话挂自定义 entryTransforms / entryProjectors,走 repo 这条路给不了,
 * 只能自己 new Session(storage, options)。
 */
export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

// ── §4 Result → throw 的适配边界 ───────────────────────────────────────────
// 取出 FileSystem 调用的成功值,失败则翻译成 SessionError 抛出。
// 参数 result:任意 FileSystem 方法的返回值;message:出错时拼在前面的上下文说明。
// 返回:result.value。失败时抛 SessionError,code 只可能是 not_found 或 storage。
// 它是 session 子系统里唯一的换轨点:FileSystem 的契约是「实现方不许抛、失败编码进
// Result」,而 Session / SessionRepo 的契约是「失败就抛 SessionError」。没有它,
// jsonl-repo 与 jsonl-storage 里每一次文件调用都要手写一遍 if (!result.ok)。
/** FileSystem 的 Result 世界与 session 的 throw 世界之间的适配边界。 */
export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		// FileErrorCode 有 8 种,SessionErrorCode 只与其中的 not_found 同名,其余
		// (permission_denied / is_directory / not_directory / aborted / invalid / …)一律压成 storage。
		// 代价写在这:被中断的文件读(aborted)在上层看起来和「磁盘出问题了」一模一样;
		// not_found 单独留出来是为了让「会话不存在」还能与「存储坏了」分开表达 —— 但别当成已经
		// 有人在用:全仓没有生产代码按 SessionError.code 分支(桌面端的 SessionNotFoundError 是它
		// 自己查表查不到时另造的),唯一断言这个码的是 storage.test.ts。
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		// 拼接后的 message 是给人看的那一句;原始 FileError 作为 cause 挂上去 ——
		// 结构化的 error.path 只活在 cause 里,SessionError 自己没有 path 字段。
		// 桌面端要留意:cause 过不了 contextBridge(见仓库 CLAUDE.md「会咬人的地方」),
		// renderer 最后只拿得到这一句拼好的话。
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	// 走到这里 result 已被 TypeScript 收窄成 { ok: true },value 一定存在。
	return result.value;
}

// ── §5 fork 取材规则:before / at 两条路 ────────────────────────────────────
// 算出「fork 一个会话时,要把哪些条目搬进新会话」。只读,不建任何东西。
// 参数 storage:源会话的存储;options.entryId:从哪一条切,不给则整份 fork;
// options.position:at 含目标条目本身,before(默认)表示「回到发这句话之前」。
// 返回:切片 fork 是一条 root → leaf 的链;整份 fork 返回的是完整追加日志(所有分支 +
// leaf 条目)。两者都保持「父先于子」的顺序,但集合完全不同 —— 这条不对称在签名上看不出来。
// 调用方(两个 repo 的 fork())负责重放:
// JSONL 版逐条 appendEntry 落盘,内存版直接塞进 InMemorySessionStorage 的构造函数。
// 失败:目标条目不存在、或 before 模式下目标不是 user 消息,抛
// SessionError(invalid_fork_target);源会话本身坏了则由 storage 抛别的码。
// 下面那句原有注释里的「Step 5」指的是里程碑 M5 的 Step 5(SessionRepo 家族,见
// harness/types.ts 同名区块),不是全景篇 §4 生命周期的第 5 步。
/** fork 的取材逻辑(Step 5 的 repo 会用到):position "at" 含目标条目,"before" 要求目标是 user 消息。 */
export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	// 不给 entryId = 整份 fork。getEntries() 返回的是「全部」条目:所有分支都在,
	// 连 leaf 条目(光标本身也是一条条目)也在,于是重放之后新会话的光标位置与源会话一致。
	// 下面 getPathToRoot 那条路正相反,只留一条链。
	// 注意这里是真值判断:entryId 传空字符串等同于没传,会静默变成整份 fork,
	// 而不是报「条目不存在」。
	if (!options.entryId) return storage.getEntries();
	// getEntry 查的是全表 byId,不限于当前路径 —— 所以允许从别的分支上的条目切 fork。
	const target = await storage.getEntry(options.entryId);
	// 目标不存在必须当场炸:再往下就要读 target.type,而「悄悄 fork 出一个空会话」
	// 比报错难查得多。invalid_fork_target 是 SessionErrorCode 里专给这两处的码。
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	// effectiveLeafId = 新会话的最后一条条目。之所以叫 leaf 而不是 target,是因为
	// 下面要拿它当 getPathToRoot 的起点:一条路径就是从它沿 parentId 一路走到根。
	let effectiveLeafId: string | null;
	// 默认档是 before。写成 ?? 而不是直接比较 position === "at",是为了让「显式传
	// undefined」(把可选字段原样透传是很常见的写法)也落到默认档而不是掉进别的分支。
	if ((options.position ?? "before") === "at") {
		// at:目标条目本身留在新会话里,所以它就是新的 leaf。
		// 用途是「从这条(可以是 assistant 回复、压缩条目、任何类型)之后接着聊」,
		// 因此这条路径不校验条目类型。
		effectiveLeafId = target.id;
	} else {
		// before 的语义是「回到发这句话之前」,只有 user 消息才有这个语义。
		// 切在 assistant 或工具结果之前,得到的历史会以 assistant 结尾,下一次请求就成了
		// 「模型自己接着自己说」—— 所以这里硬性要求目标是 user 消息,不满足直接抛。
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		// 取父条目:目标 user 消息本身被排除在新会话之外。
		// parentId 可能是 null(目标就是会话的第一条条目),此时 getPathToRoot(null) 返回 [],
		// fork 出来的是一个空会话 —— 这不报错,是有意的「从头开始,但 header 里记着 parentSession」。
		effectiveLeafId = target.parentId;
	}
	// 只取这一条 root → leaf 的路径:源会话上的其他分支不会被带过去,leaf 条目也不会
	// (它们永远不在任何 parentId 链上)。跨 fork 丢分支的一个已知后果是:若被保留的
	// compaction 条目的 firstKeptEntryId 落在没搬过来的那段上,新会话的投影会把压缩点
	// 之前的条目整段静默丢掉(见全景篇 §6.1)。
	// 另外返回的是条目对象本身、不是深拷贝:内存版 fork 之后两个会话共享同一批条目对象
	// (JSONL 版落盘的那份是独立的,但内存里的数组元素同样共享)。
	return storage.getPathToRoot(effectiveLeafId);
}
