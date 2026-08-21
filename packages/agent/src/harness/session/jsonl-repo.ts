// JSONL 会话仓库。对应 pi harness/session/jsonl-repo.ts,逐字移植;
// 唯一差异:Session 类型直接从 ./session.ts 导入(pi 经 ../types.ts 二手转口,
// my-pi 的 index.ts 同时星号导出两处,转口会产生歧义导出)。
// 目录布局与 pi 一致:<root>/--<cwd 编码>--/<时间戳>_<sessionId>.jsonl。
/**
 * 会话「仓库层」(repository)。storage 管「一个会话文件怎么读写」,repo 管「一堆会话
 * 怎么建 / 找 / 开 / 删 / fork」—— 磁盘上的目录布局只在这个文件里定义,别处没有第二份。
 *
 * 在全景链路上的位置:阶段 0「装配」的第 0.3 步。宿主(ACP 的 coding-agent/src/acp/agent.ts
 * 里的 MyPiAcpAgent、桌面端的 kernel/src/host/session-manager.ts:196 的 SessionManager)
 * 先 new 一个 JsonlSessionRepo,再用 list() 画会话列表、
 * 用 create() 建新会话、用 open() 恢复旧会话;拿到的 Session 才被交给
 * new AgentHarness({ session })(第 0.8 步)。此后一次 prompt 的整个循环里 repo 不再出场 ——
 * 轮内落盘(第 ⑫ 步)走的是 Session/JsonlSessionStorage 的 appendEntry,不经过 repo。
 * 所以它不存在的后果不是「跑不动」,而是「关掉 app 会话就没了、也没有会话列表」。
 *
 * 对应学习文档:docs/learn/agent/harness_session_jsonl-repo.md
 *
 * 分节索引:
 *   §1  文件头与导入
 *   §2  窄化的 FileSystem 依赖(JsonlSessionRepoFileSystem)
 *   §3  encodeCwd:cwd → 目录名的单向编码
 *   §4  类骨架与路径三件套(sessionsRoot / sessionDir / 会话文件路径)
 *   §5  create:建目录 + 写 header
 *   §6  open:先存在性检查,再整文件重放
 *   §7  list:只读 header 的快路 + 跳过坏文件 + 按 createdAt 倒序
 *   §8  delete:只删文件,不删空目录
 *   §9  fork:取材 → 新文件 → 逐条重放
 *   §10 listSessionDirs:sessionsRoot 下扫一层目录
 */
// ── §1 文件头与导入 ──────────────────────────────────────────────
// 这五个类型全部来自 harness/types.ts:JsonlSessionRepoApi 是 SessionRepo 家族用
// JsonlSessionMetadata / JsonlSessionCreateOptions / JsonlSessionListOptions 实例化出来的契约,
// 下面的 class 声明 implements 它 —— 换句话说,这个文件是那份契约的磁盘实现。
import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoApi,
} from "../types.ts";
// SessionError 是会话子系统唯一的异常类型,code 取自六个字面量
// (not_found / invalid_session / invalid_entry / invalid_fork_target / storage / unknown),
// 调用方靠 code 分流;toError 把 catch 到的任意值裹成 Error —— list() 的容错分支要用。
import { SessionError, toError } from "../types.ts";
// 真正读写单个会话文件的是 storage;repo 只决定「哪个文件」并保证目录先存在。
// loadJsonlSessionMetadata 是 list() 专用的快路:只读文件第一行 header,不整文件读。
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.ts";
// repo-utils 是 jsonl 与 memory 两套 repo 的公共部分:id/时间戳生成、Session 包装、
// Result→throw 的适配边界,以及 fork 的取材规则(getEntriesToFork)。
import {
	createSessionId,
	createTimestamp,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	toSession,
} from "./repo-utils.ts";
import type { Session } from "./session.ts";

// ── §2 窄化的 FileSystem 依赖 ────────────────────────────────────
/**
 * 一份「能力清单」:本文件只需要 FileSystem 这 11 个成员,不要求整个 ExecutionEnv。
 * 写窄有两个实际好处 —— 读代码时一眼看见它会碰哪些文件操作;任何结构上凑齐这些方法的
 * 对象都能传进来(测试传的是 NodeExecutionEnv,浏览器宿主可以传别的实现)。
 *
 * 其中 readTextFile / readTextLines / writeFile / appendFile 这四个 repo 自己一次都不调,
 * 它们是**转手**给 JsonlSessionStorage(它的 Pick 恰好就是这四个)与 loadJsonlSessionMetadata 的;
 * 由 repo 直接调用的只有 absolutePath / joinPath / listDir / exists / createDir / remove。
 * cwd 这一项在本文件里没有任何读取处,留着只是让这个类型继续「长得像 FileSystem」。
 */
type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

// ── §3 encodeCwd:cwd → 目录名的单向编码 ─────────────────────────
/**
 * 把工作目录压成一个能当目录名用的字符串:去掉开头的一个 / 或 \,再把余下所有 / \ :
 * 换成 -,前后各包一对 --。/tmp/my-project → --tmp-my-project--;
 * Windows 的 D:\MyCode\yoma → --D-MyCode-yoma--。
 *
 * 为什么要编码:会话文件按「属于哪个项目」分目录存,而项目路径里带分隔符,不编码就没法
 * 当一层目录名。前后那对 -- 是从 pi 继承的哨兵,让人一眼认出这是编码过的目录。
 *
 * 三个必须知道的性质:
 *  - **不可逆**:目录名反推不回原 cwd(一根 - 原来是 / 还是 - 已经分不出来)。所以真正的
 *    cwd 记在每个会话文件的 header 里(JsonlSessionMetadata.cwd),从不靠目录名反解析。
 *  - **会撞名**:/a/b 与 /a-b 编码后同为 --a-b--,两个项目的会话混进同一个目录。后果不致命
 *    (list 返回的每条 metadata 带各自的 cwd),但 list({cwd}) 是按目录过滤的,会多给。
 *  - **不做规范化**:cwd 原样进来,/tmp/proj 与 /tmp/proj/ 与相对路径 . 各自落到不同目录。
 *    宿主传绝对路径(桌面端传用户选的工程目录)是约定,不是这个函数的保证。
 */
function encodeCwd(cwd: string): string {
	// 第一个 replace 没有 g 且锚在 ^:只吃掉开头的**一个**分隔符,目的是让 /tmp/x 编成
	// --tmp-x-- 而不是 ---tmp-x--。UNC 路径 //server/share 开头有两个 /,只吃掉一个,
	// 于是会多出一根横杠 —— 不影响正确性,只是难看。第二个 replace 带 g,把余下所有
	// / \ : 全换成 -(: 是为了 Windows 盘符,不换的话在 Windows 上是非法文件名)。
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ── §4 类骨架与路径三件套 ───────────────────────────────────────
/**
 * JSONL 会话仓库:五个公开方法 create / open / list / delete / fork,与 InMemorySessionRepo
 * 是同一套语义的两种落地(那一份把会话放进 Map,这一份放进磁盘目录)。
 *
 * 失败路径统一成 SessionError:FileSystem 那一侧永不 throw、只返回 Result,
 * 转换点是 repo-utils 的 getFileSystemResultOrThrow(not_found 保码,其余归 storage)。
 * 构造函数不做任何 I/O,也不校验 sessionsRoot 是否存在 —— 目录是 create()/fork() 按需 mkdir 的,
 * 一个从没建过会话的机器上 list() 返回空数组而不是报错。
 */
export class JsonlSessionRepo implements JsonlSessionRepoApi {
	private readonly fs: JsonlSessionRepoFileSystem;
	// 原样保存调用方给的 sessionsRoot(可能是相对路径、~ 开头、甚至 file:// URL),
	// 因为把它变成绝对路径要 await(absolutePath 是异步的 Result API),构造函数里做不了。
	private readonly sessionsRootInput: string;
	// 解析后的绝对路径缓存,第一次用到时才算(见 getSessionsRoot),算一次用到底。
	// 相对路径是相对 fs.cwd 解析的(NodeExecutionEnv 的 cwd 来自构造参数,不读 process.cwd()),
	// 所以进程中途 chdir 不会让这个缓存变得前后不一致。
	private sessionsRoot: string | undefined;

	constructor(options: { fs: JsonlSessionRepoFileSystem; sessionsRoot: string }) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	/**
	 * 惰性解析并缓存 sessionsRoot,返回绝对路径。
	 * 失败(absolutePath 返回 err)时抛 SessionError,消息带上原始输入值。
	 */
	private async getSessionsRoot(): Promise<string> {
		// 用 !this.sessionsRoot 而不是 === undefined:空串会重算,而 absolutePath 不会产出空串,
		// 所以两者等价。这里**没有**做「同一个 Promise 只解析一次」的并发去重 —— 无所谓,
		// absolutePath 是纯路径运算(NodeExecutionEnv 里就是 resolve + ~ 展开),幂等且不碰磁盘。
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	/**
	 * 某个 cwd 对应的会话目录:<sessionsRoot>/--<cwd 编码>--。
	 * 只算路径,不保证目录存在 —— 建目录是 create()/fork() 的事,list() 则先 exists 再进。
	 */
	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	/**
	 * 会话文件的完整路径:<会话目录>/<时间戳>_<sessionId>.jsonl。
	 * 文件名里的时间戳只是给人看、给目录排序兜底用的,程序读的一律是 header 里那份。
	 */
	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				// 冒号在 Windows 文件名里非法,ISO 时间戳 2026-08-20T12:34:56.789Z 里有两个;点是合法字符,一起换掉
				// 只为让文件名里只剩 .jsonl 那一个点。下划线是时间戳与 id 的分隔符,id 里若含下划线,从文件名反切会切错
				// —— 别写这种反解析,id 在 header 里有现成的。
				// 另外 sessionId 原样拼进文件名、不做任何清洗:调用方给一个含 ../ 的 id 就能写到目录外面。
				// 现有调用方给的要么是 uuidv7(ACP),要么不给(自动生成),这是约定而不是防线。
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	// ── §5 create:建目录 + 写 header ────────────────────────────────
	/**
	 * 新建会话:落一个只有 header 一行的 .jsonl 文件,包成 Session 返回。
	 * options.cwd(必填)决定落在哪个编码目录下;id 不给就铸一个完整 uuidv7;
	 * parentSessionPath 与 metadata 原样写进 header。
	 * 失败:目录建不出来 / 文件写不下去 → SessionError("storage")。
	 * 注意它只建文件,不往会话树里写任何条目 —— 模型、思考档位这些记账条目是调用方
	 * 随后自己 append 的(见 acp/agent.ts 的 newSession():建完会话紧接着 appendModelChange)。
	 */
	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		// id 由调用方给(ACP 的 newSession() 自己铸一个 uuidv7,同一个值也当 ACP 协议的
		// sessionId 用)或在这里铸。repo **不检查重名**:同一个 id 建两次会得到两个文件,
		// list() 里就出现两条 id 相同的记录;桌面端的会话表按 id 做 Map(session-manager.ts:373 的
		// existing 分支),第二条被合并到第一条上 —— 两行长得一样,其中一个会话文件在 UI 上打不开。
		const id = options.id ?? createSessionId();
		// 这个时间戳只进文件名。header 里的 timestamp 是 JsonlSessionStorage.create 内部
		// **另调一次** new Date().toISOString() 得到的,两者可能差几毫秒;list() 排序用的是
		// header 那份,所以「按文件名排」与「按 createdAt 排」在极端情况下会不一致。
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		// recursive:true 一次把 <sessionsRoot> 与编码目录都建出来,且目录已存在不算错(mkdir -p 语义),
		// 所以不需要先 exists 再建。对 NodeExecutionEnv 而言这一步其实是冗余的 —— 它的 writeFile
		// 自己会 mkdir 父目录;但 FileSystem 接口只承诺「在支持时创建父目录」,repo 不能依赖它。
		// 换一个严格照契约实现的 FileSystem,删掉这一步就是 create() 直接 ENOENT。
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
		// 真正写文件的是 storage:序列化 header(version 固定为 3)当第一行 writeFile 下去。
		// writeFile 是**覆盖**语义,所以万一路径撞上(同一个 id 且同一毫秒),旧文件会被清空 ——
		// 这也是上面「不检查重名」的真正代价。
		const storage = await JsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
			metadata: options.metadata,
		});
		// toSession 只是 new Session(storage) —— 会话树的读写门面。repo 到此退场,
		// 之后 harness 全程只跟这个 Session 打交道。
		return toSession(storage);
	}

	// ── §6 open:先存在性检查,再整文件重放 ─────────────────────────
	/**
	 * 打开一个已存在的会话。入参是 list() 给出的 metadata,但**只有 path 被用到** ——
	 * id / cwd / metadata 都会在读文件时从 header 重新解析,一切以文件为准。
	 * 文件不在:SessionError("not_found");文件在但内容坏:storage 抛 invalid_session / invalid_entry。
	 */
	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		// 先 exists 一次,只为把「文件没了」变成一句人话:Session not found: <path>。
		// 删掉这一步功能上也能跑 —— readTextFile 的 not_found 同样会被 getFileSystemResultOrThrow
		// 翻成 SessionError("not_found"),但消息会变成 "Failed to read session ...",
		// 而桌面端是按 code 把它当「会话被删了」处理的,消息则直接进 UI。
		// 顺带:exists 与真正读之间有 TOCTOU 窗口,期间被删就落回后一种错误,没有重试。
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		// storage.open 把整个文件读进内存再逐行 JSON.parse 重放,边读边推 leaf 位置。
		// 两个后果:长会话没有流式路径;正文里任何一行残缺 JSON(断电写了半行)都会让
		// 整次 open 失败,而且全仓没有任何截断/跳过坏行的修复逻辑。
		const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
		return toSession(storage);
	}

	// ── §7 list:只读 header 的快路 ──────────────────────────────────
	/**
	 * 列出会话元数据,按 createdAt 从新到旧。options.cwd 给了就只看那一个编码目录,
	 * 不给就扫 sessionsRoot 下的每个一级目录(listSessionDirs,§10)。
	 *
	 * 每个文件只读第一行 header,所以画一屏会话列表不必把会话正文读进来。代价是 header
	 * 之外的东西列表里一概看不到 —— 典型的是后来 appendSessionName 写进树里的会话标题,
	 * 桌面端因此把标题做成懒加载(kernel/host/session-manager.ts:383),先给空串占位。
	 */
	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		// cwd 过滤是「按编码后的目录名精确匹配」,不是按 header 里的 cwd 过滤:encodeCwd 撞名时
		// (/a/b 与 /a-b)会把另一个项目的会话一并列出来。要严格,得再按 metadata.cwd 过一遍。
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		// 逐目录、逐文件串行 await:没有并发,会话多时这里是一长串顺序的小文件读。
		// 换成 Promise.all 会一次性打开成百上千个文件句柄,这是有意的取舍。
		for (const dir of dirs) {
			// 目录可能不存在(这个项目还没建过会话,或目录被手工删了),跳过而不是报错 ——
			// 「还没有会话」是正常状态而不是故障。带 cwd 调用时这几乎是必经分支。
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
				continue;
			}
			// 只认这一层里的 .jsonl,不递归子目录。判据写的是 kind !== "directory" 而不是
			// kind === "file":listDir 用 lstat 不跟随符号链接,软链的 kind 是 "symlink",
			// 写成 === "file" 会把「指向别处会话文件的软链」漏掉。
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) {
				// 每个文件单独 try:一个坏文件不该让整张会话列表打不开。
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
				} catch (error) {
					// catch 到的未必是 Error(理论上什么值都能被 throw),先用 toError 归一化。
					const cause = toError(error);
					// 只吞「这个文件不是一个合法会话」(header 缺失 / version 不是 3 / 字段类型不对),
					// 其余一律原样抛出:读不动(权限、I/O)是环境问题,悄悄跳过会让用户以为会话丢了。
					// 注意抛出的是归一化后的 cause 而不是原始 error —— 非 Error 值会被换成 Error。
					// 还要注意:这里只读 header,所以「正文里有一行残缺 JSON」的会话在列表里完全看不出
					// 问题,它好端端地列着,一点开才炸(见学习文档 §5)。
					if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
				}
			}
		}
		// 倒序(新的在前)。排序键是 header 里的 createdAt 字符串,既不是文件名里的时间戳,
		// 也不是 mtime —— 所以「最近用过的会话」不会因此上浮,桌面端另按自己的 updatedAt 排。
		// header 校验只要求 timestamp 是非空字符串,不保证 Date 解析得了;解析不出来时比较结果是 NaN,
		// 而规范规定比较器返回 NaN 按 +0(即「相等」)处理 —— 比较器就此失去传递性,那条记录落在哪儿全看排序算法。
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	// ── §8 delete:只删文件,不删空目录 ─────────────────────────────
	/**
	 * 删除一个会话文件。
	 * force:true = 「文件本来就不在」也算成功(幂等):用户在别处删过、或两个窗口同时删同一条,
	 * 都不该报错。recursive 没传(默认 false),所以传进来一个目录路径会失败 —— 这个方法只删一个文件。
	 * 两件它**不做**的事:不清理空掉的编码目录(list 会跳过没有 .jsonl 的目录,只是留痕);
	 * 不动 fork 出去的子会话,它们 header 里的 parentSession 会变成一条悬空路径。
	 */
	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}

	// ── §9 fork:取材 → 新文件 → 逐条重放 ───────────────────────────
	/**
	 * 从一个已有会话分叉出一个新会话文件(「从这句话之前重来一遍」)。
	 *
	 * 取材规则在 repo-utils 的 getEntriesToFork:不给 entryId 就整份复制(getEntries ——
	 * 全部条目,含别的分支与 leaf 光标条目);给了 entryId 则只复制 root→目标 的那一条链,
	 * position "at" 含目标本身,默认的 "before" 要求目标是一条 user 消息、复制到它的父为止。
	 * 目标不存在或 "before" 时目标不是 user 消息 → SessionError("invalid_fork_target")。
	 *
	 * options.cwd 可以与源会话不同,于是 fork 顺带能把会话搬到另一个项目目录下(测试钉住了)。
	 * 本仓目前**没有生产调用方**:桌面端 UI 上的「回到这条消息」走的是 harness.navigateTree
	 * (在同一个会话里挪 leaf),不是 fork。它是 SessionRepo 契约的一部分,由
	 * test/harness/repo.test.ts 的两个用例覆盖。
	 */
	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<JsonlSessionMetadata>> {
		// 先 open 源会话:既校验它还在(不在就是 not_found),也把全部条目读进内存 ——
		// 取材要沿 parentId 链回溯,那必须有一份完整的 byId 表。
		const source = await this.open(sourceMetadata);
		// options 是整个 create 选项对象直接透传,getEntriesToFork 只看其中的 entryId / position。
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		// 新文件的 header 独立铸(新 id、新时间戳),但要把血缘记下来:
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this.createSessionFilePath(options.cwd, id, createdAt),
			{
				cwd: options.cwd,
				sessionId: id,
				// 没显式指定父会话时记源会话的**文件路径** —— 这是唯一能回溯「从哪儿分叉来」的地方。
				// 用 ?? 而不是 ||,所以调用方传空串会被当成有效值(实际不会有人这么传)。
				parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
				// header 里的自定义 metadata 默认继承源会话(repo.test.ts 第三个用例钉住),
				// 传了就**整份覆盖**,不做逐字段合并。
				metadata: options.metadata ?? sourceMetadata.metadata,
			},
		);
		// 逐条 appendEntry 复制:每条都是一次 appendFile(打开-追加-关闭),条目多时就是 N 次文件写。
		// 中途失败没有回滚 —— 新文件带着写了一半的条目留在磁盘上,而且它的 header 是好的,
		// 于是 list() 照样把这个半成品列出来。
		// 另外这是**引用复制**:写进新文件的字节是独立的,但内存里两个 storage 的 entries 数组
		// 装着同一批条目对象;条目的 id 与 parentId 原样保留,所以 fork 出来的会话与源会话
		// 共用同一套条目 id(跨会话比 id 是不安全的)。
		for (const entry of forkedEntries) {
			await storage.appendEntry(entry);
		}
		return toSession(storage);
	}

	// ── §10 listSessionDirs:sessionsRoot 下扫一层目录 ───────────────
	/**
	 * 不带 cwd 的 list() 用它:返回 sessionsRoot 下所有一级子目录的绝对路径。
	 * 根目录不存在时返回空数组(还没建过任何会话是正常状态),不抛。
	 */
	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		// 与 list() 里那次 exists 同一个理由:第一次运行时 sessionsRoot 还没被 create() 建出来,
		// 直接 listDir 会 ENOENT,而「一个会话都没有」不该在 UI 上表现成错误。
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(sessionsRoot),
				`Failed to check sessions root ${sessionsRoot}`,
			)
		) {
			return [];
		}
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		// 只按 kind === "directory" 过滤,不校验目录名是不是 --…-- 这个编码形状:sessionsRoot 下
		// 手工放的任何目录都会被扫进来(里面没有 .jsonl 自然就是空结果)。反过来,指向别处
		// 会话目录的**符号链接**会被这里滤掉(它的 kind 是 "symlink"),这与 §7 里那条
		// kind !== "directory" 的判据方向相反,是本文件里唯一一处不对称。
		return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
	}
}
