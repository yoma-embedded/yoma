# packages/agent/src/harness/session/jsonl-repo.ts

> **档位** A(逐行) · **行数** 402(加注释后;原 183) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §4 阶段 0 第 0.3 步、§5.2/§5.3 接线表、§6.1 的「会话树与持久化」一组 · **索引** [README](../README.md)

> 本文引用的**本文件行号**是加注释之后的真实行号(共 402 行)。引用别的文件时只给符号名不给行号 —— 那些文件正在同一批注释工作里变长,行号会漂。

## 1. 一句话

把「一堆会话」管起来的仓库层(repository):按工作目录分文件夹,在磁盘上建 / 找 / 开 / 删 / 分叉 `.jsonl` 会话文件 —— 目录布局 `<sessionsRoot>/--<cwd 编码>--/<时间戳>_<sessionId>.jsonl` 只在这个文件里定义。

## 2. 它在全景里的位置

先厘清两个名词。**session(会话)** 是一棵条目树:用户消息、模型回复、工具调用结果、换模型、压缩摘要,每样都是往树上追加的一条条目。**storage** 负责「一个会话文件怎么读写」(`jsonl-storage.ts`),**repo** 就是本文件,负责「一堆会话怎么建、怎么找、怎么开、怎么删、怎么分叉」。两者是一对:repo 决定「哪个文件」,storage 决定「文件里怎么放」。

它在全景篇 §4 的时间线上只出现在**阶段 0「装配」的第 0.3 步**,而且只出现这一次:

- 宿主(ACP 适配器 `coding-agent/src/acp/agent.ts` 的 `MyPiAcpAgent`、桌面端 `kernel/src/host/session-manager.ts:196` 的 `SessionManager`)在构造时 `new JsonlSessionRepo({ fs, sessionsRoot })`;
- 画会话列表调 `list()`,新建会话调 `create({ cwd })`,点开一条历史会话调 `open(metadata)`;
- 拿到的 `Session` 被交给第 0.8 步的 `new AgentHarness({ session, ... })`。

从第 0.8 步之后,repo 就退场了。阶段 1 的 `createTurnState()`(全景篇第 3 步)读会话走的是 `Session.buildContext()`;第 ⑫ 步落盘走的是 `Session.append*` → `JsonlSessionStorage.appendEntry`,一次都不回头找 repo。

所以**它不存在的后果不是「agent 跑不动」,而是「关掉 app 会话就没了、也没有会话列表」**:harness 完全可以配一个 `InMemorySessionStorage` 跑完整轮次(测试就是这么干的),repo 提供的是「跨进程、跨重启还认得出这次对话」的那一层。它的兄弟实现是 `memory-repo.ts`,同一套 `SessionRepo` 语义,把文件换成 `Map`。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L59 | 原有文件头 + 新增总述块注释 + 四组 import(分节标记在 L31,总述块在它之前) |
| §2 | L60–L85 | `JsonlSessionRepoFileSystem`:从 `FileSystem` 里 `Pick` 出的 11 个成员 |
| §3 | L86–L110 | `encodeCwd()`:cwd → 目录名的单向编码 |
| §4 | L111–L182 | 类骨架(字段 / 构造函数)与三个私有路径方法:`getSessionsRoot` / `getSessionDir` / `createSessionFilePath` |
| §5 | L183–L225 | `create()`:建目录 + 写 header |
| §6 | L226–L249 | `open()`:先存在性检查,再整文件重放 |
| §7 | L250–L302 | `list()`:只读 header 的快路 + 跳过坏文件 + 按 `createdAt` 倒序 |
| §8 | L303–L317 | `delete()`:只删文件,不删空目录 |
| §9 | L318–L374 | `fork()`:取材 → 新文件 → 逐条重放 |
| §10 | L375–L402 | `listSessionDirs()`:`sessionsRoot` 下扫一层目录 |

## 4. 逐节讲解

### §1 文件头与导入(L1–L59)

L1–L4 是原作者留下的文件头,一句话说清了两件事:这个文件是从上游 pi **逐字移植**的,唯一改动是 `Session` 类型的导入路径;目录布局与 pi 一致。移植关系很重要 —— 它意味着**这里的怪异之处基本都不是我们的决定**,改动前要想清楚上游同步的代价。

L5–L30 是这次新增的总述块(职责 / 链路位置 / 文档链接 / 分节索引),L31 起是分节标记与四组 import。四组 import 各自的角色:

- `../types.ts`:五个类型(`FileSystem` 与四个 `Jsonl*`)+ 两个值(`SessionError`、`toError`)。其中 `JsonlSessionRepoApi` 就是本文件 `implements` 的那份契约。
- `./jsonl-storage.ts`:`JsonlSessionStorage`(真正读写单个文件的那一层)与 `loadJsonlSessionMetadata`(只读 header 的快路)。
- `./repo-utils.ts`:五个小工具。其中四个(`createSessionId` / `createTimestamp` / `toSession` / `getEntriesToFork`)与 `memory-repo.ts` 共用,`getFileSystemResultOrThrow` 只有本文件与 `jsonl-storage.ts` 用得上(内存版没有 `FileSystem`)。
- `./session.ts`:只导入类型 `Session`。

### §2 窄化的 FileSystem 依赖(L60–L85)

```ts
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
```
`L71–L84`

`FileSystem` 是 harness 层的文件系统能力接口(`harness/types.ts` 的 `FileSystem`),它有一条铁律:**所有操作永不 throw,失败一律编码进 `Result<T, FileError>` 返回**。整个内核只有一个实现 `NodeExecutionEnv`(`harness/env/nodejs.ts`)。

这里用 `Pick` 窄化有两个实际好处:读代码时一眼看见这个文件会碰哪些文件操作;任何结构上凑齐这些方法的对象都能传进来,不必是完整的 `ExecutionEnv`。

一个读代码时容易困惑的点:这 11 个成员里,`readTextFile` / `readTextLines` / `writeFile` / `appendFile` 这四个 **repo 自己一次都没调**。它们在清单里是因为 `this.fs` 要**整个转手**给 `JsonlSessionStorage.create/open` 与 `loadJsonlSessionMetadata` —— storage 那边的 `Pick`(`JsonlSessionStorageFileSystem`)恰好就是这四个。repo 直接调用的只有 `absolutePath` / `joinPath` / `listDir` / `exists` / `createDir` / `remove` 六个。至于 `cwd`,本文件里**没有任何读取处**(`grep "this\.fs\.cwd"` 在整个 `session/` 目录零命中),留着只是让这个类型继续「长得像 FileSystem」。

### §3 encodeCwd:cwd → 目录名的单向编码(L86–L110)

```ts
function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
```
`L103–L109`(中间四行注释省略)

会话文件要按「属于哪个项目」分目录存,而项目路径里带分隔符,不编码就没法当一层目录名。这个函数做三步:

1. `replace(/^[/\\]/, "")` —— **没有 `g` 且锚在 `^`**,只吃掉开头的一个 `/` 或 `\`。目的是让 `/tmp/x` 编成 `--tmp-x--` 而不是 `---tmp-x--`。
2. `replace(/[/\\:]/g, "-")` —— 带 `g`,把余下所有 `/`、`\`、`:` 换成 `-`。`:` 是为 Windows 盘符准备的(`D:` 里的冒号在 Windows 文件名里非法)。
3. 前后各包一对 `--`,这是从 pi 继承的哨兵,让人一眼认出这是编码过的目录。

实测样例(与 `repo.test.ts` 第一个用例的断言一致):`/tmp/my-project` → `--tmp-my-project--`;`D:\MyCode\yoma` → `--D-MyCode-yoma--`。

三个性质必须记住,它们直接对应 §5 的前两条坑:**不可逆**(一根 `-` 原来是 `/` 还是 `-` 已经分不出来,所以真正的 cwd 记在文件 header 里)、**会撞名**(`/a/b` 与 `/a-b` 编码结果相同)、**不做规范化**(`/tmp/proj` 与 `/tmp/proj/` 落到两个不同目录)。

### §4 类骨架与路径三件套(L111–L182)

```ts
export class JsonlSessionRepo implements JsonlSessionRepoApi {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;

	constructor(options: { fs: JsonlSessionRepoFileSystem; sessionsRoot: string }) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}
```
`L121–L134`(中间注释省略)

两个字段装同一个东西的两种形态:`sessionsRootInput` 是调用方原样给的(可能是相对路径、`~/...`、甚至 `file://` URL),`sessionsRoot` 是解析后的绝对路径缓存。为什么要分两个?因为 `absolutePath` 是**异步的 Result API**,构造函数里 `await` 不了。于是构造函数不做任何 I/O、也不校验根目录是否存在 —— 一台从没建过会话的机器上 `list()` 返回空数组而不是报错,这个性质由 §10 的 `exists` 分支兜住。

```ts
	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}
```
`L140–L151`

`getFileSystemResultOrThrow`(`repo-utils.ts`)是**整个会话子系统里 Result 世界与 throw 世界的唯一转换点**:`result.ok` 为假时按 `not_found` 保码、其余归 `storage`,抛 `SessionError`。本文件里它被调用 11 次(L145 / L158 / L169 / L207 / L239 / L269 / L275 / L312 / L344 / L385 / L392),每次都带一句自己的错误消息 —— 这些消息会一路飘到桌面端 UI 上,所以写的都是「做什么失败了 + 路径」。

判空用 `!this.sessionsRoot` 而不是 `=== undefined`:空串会重算,而 `absolutePath` 不会产出空串,两者等价。这里**没有**做「同一个 Promise 只解析一次」的并发去重,并发调用可能各算一遍 —— 无所谓,`NodeExecutionEnv.absolutePath` 就是 `resolve()` 加 `~` 展开,幂等且不碰磁盘。

```ts
	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}
```
`L157–L162`

只算路径,**不保证目录存在**。谁负责建:`create()` 与 `fork()` 会 `createDir`;`list()` 走的是「先 `exists` 再进,不在就跳过」。

```ts
	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}
```
`L168–L181`(中间注释省略)

文件名 = `<时间戳>_<sessionId>.jsonl`。时间戳里的 `:` 在 Windows 文件名里非法(ISO 串 `2026-08-20T12:34:56.789Z` 里有两个),必须换掉;`.` 本身是**合法**字符,一起换成 `-` 只是为了让文件名里只剩 `.jsonl` 那一个点。

两个要留神的地方:一是**别从文件名反解析 id** —— 分隔符是下划线,而 id 里若含下划线就会切错,`id` 在 header 里有现成的;二是 **`sessionId` 原样拼进文件名、不做任何清洗**,调用方给一个含 `../` 的 id 就能写到目录外面。现有调用方给的要么是 uuidv7(ACP),要么不给(自动生成),这是约定而不是防线。

### §5 create:建目录 + 写 header(L183–L225)

```ts
	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
		const storage = await JsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
			metadata: options.metadata,
		});
		return toSession(storage);
	}
```
`L192–L224`(中间注释省略)

逐块看:

- **L197 `const id`** —— `createSessionId()` 是 `uuidv7()` 的**完整值**(`repo-utils.ts`)。注意与条目 id 的区别:条目 id 是 `uuidv7().slice(-8)`,只取随机尾部(全景篇 §6.1「会话树与持久化」第一条)。这里 repo **不检查重名**:同一个 id 建两次会得到两个文件。
- **L201 `const createdAt`** —— 这个时间戳**只进文件名**。header 里的 `timestamp` 是 `JsonlSessionStorage.create` 内部**另调一次** `new Date().toISOString()` 得到的,两者可能差几毫秒。`list()` 排序用的是 header 那份。
- **L208 `createDir({recursive:true})`** —— 一次把 `<sessionsRoot>` 与编码目录都建出来,而且目录已存在不算错(`mkdir -p` 语义),所以不需要先 `exists`。**对 `NodeExecutionEnv` 而言这一步其实是冗余的**:它的 `writeFile` 自己会 `mkdir` 父目录。但 `FileSystem` 接口只承诺「在支持时创建父目录」,repo 不能依赖它 —— 换一个严格照契约实现的 FileSystem,删掉这一行就是 `create()` 直接 ENOENT。
- **L215 `JsonlSessionStorage.create`** —— 真正写文件:把 header 序列化成第一行(`version` 固定为 3)`writeFile` 下去。**`writeFile` 是覆盖语义**,这是上面「不检查重名」的真正代价。
- **L223 `toSession(storage)`** —— 只是 `new Session(storage)`(`repo-utils.ts`)。

还要注意 `create()` **不往会话树里写任何条目**:模型、思考档位这些记账条目是调用方随后自己 append 的(见 `acp/agent.ts` 的 `newSession()`,建完会话紧接着 `appendModelChange`)。

### §6 open:先存在性检查,再整文件重放(L226–L249)

```ts
	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
		return toSession(storage);
	}
```
`L232–L248`(中间注释省略)

**入参虽然是整个 metadata,但只有 `path` 被用到**。`id` / `cwd` / `metadata` 都会在读文件时从 header 重新解析,一切以文件为准(`repo.test.ts` 第二个用例断言 `open` 之后的 metadata 与原 metadata 全等,靠的就是同一份 header)。

那次 `exists` 是可以删掉的 —— `readTextFile` 的 `not_found` 同样会被 `getFileSystemResultOrThrow` 翻成 `SessionError("not_found")`。留着是为了**消息**:`Session not found: <path>` 比 `Failed to read session ...: ENOENT ...` 好读得多,而这条消息会直接进 UI。代价是 `exists` 与真正读之间有一个 TOCTOU 窗口,期间文件被删就落回后一种错误,没有重试。

`JsonlSessionStorage.open` 是**整文件读进内存再逐行 `JSON.parse` 重放**,边读边推 leaf 位置(`jsonl-storage.ts` 的 `loadJsonlStorage`)。两个后果:长会话没有流式路径;正文里任何一行残缺 JSON 都会让整次 open 失败。

### §7 list:只读 header 的快路(L250–L302)

```ts
	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
				continue;
			}
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) {
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
				} catch (error) {
					const cause = toError(error);
					if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
				}
			}
		}
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}
```
`L259–L301`(中间注释省略)

**这是本文件最值得读的一段**,七个决定挤在 20 行里:

1. **L262 目录来源二选一。** 给了 `cwd` 就只看那一个编码目录,没给就扫 `sessionsRoot` 下每个一级目录(§10)。注意 `cwd` 过滤是**按编码后的目录名精确匹配**,不是按 header 里的 `cwd` 过滤 —— 撞名时会多给。
2. **L266/L279 串行 await。** 逐目录、逐文件顺序读,没有并发。会话多时这是一长串小文件读;换成 `Promise.all` 会一次性打开成百上千个文件句柄。
3. **L269 目录不存在就 `continue`。** 「这个项目还没有会话」是正常状态而不是故障。带 `cwd` 调用时这几乎是必经分支。
4. **L278 文件过滤。** 只认这一层里的 `.jsonl`,不递归。判据是 `kind !== "directory"` 而**不是** `kind === "file"` —— `NodeExecutionEnv.listDir` 用 `lstat` 不跟随符号链接,软链的 `kind` 是 `"symlink"`,写成 `=== "file"` 会把「指向别处会话文件的软链」漏掉。
5. **L282 只读 header。** `loadJsonlSessionMetadata` 走的是 `readTextLines({maxLines: 1})`,而 `NodeExecutionEnv` 的实现是 `createReadStream` + `readline`,读满一行就 `break` —— 真的只读一行,不是「读完整个文件取第一行」。代价:header 之外的东西列表里一概看不到,典型的是后来 `appendSessionName` 写进树里的会话标题,桌面端因此把标题做成懒加载(`kernel/src/host/session-manager.ts:383`),列表先给空串占位。
6. **L285–L291 容错。** 只吞「这个文件不是一个合法会话」(header 缺失 / `version` 不是 3 / 字段类型不对 → `invalid_session`),其余一律原样抛出:读不动(权限、I/O)是环境问题,悄悄跳过会让用户以为会话丢了。注意抛的是 `toError()` 归一化后的 `cause`,不是原始 `error`。
7. **L299 排序。** 倒序(新的在前),键是 header 里的 `createdAt` 字符串 —— 既不是文件名里的时间戳,也不是 mtime。所以「最近用过的会话」不会因此上浮,桌面端另按自己维护的 `updatedAt` 排。

### §8 delete:只删文件,不删空目录(L303–L317)

```ts
	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}
```
`L311–L316`

`force: true` = 「文件本来就不在」也算成功(`rm` 的 `force` 只吞 ENOENT)。这让删除幂等:用户在别处删过、或两个窗口同时删同一条,都不该报错。

`recursive` 没传(默认 `false`),所以传进来一个**目录**路径会失败 —— 这个方法只删一个文件。它也不做两件事:不清理空掉的编码目录;不动 fork 出去的子会话,它们 header 里的 `parentSession` 会变成一条悬空路径。

### §9 fork:取材 → 新文件 → 逐条重放(L318–L374)

```ts
	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<JsonlSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this.createSessionFilePath(options.cwd, id, createdAt),
			{
				cwd: options.cwd,
				sessionId: id,
				parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
				metadata: options.metadata ?? sourceMetadata.metadata,
			},
		);
		for (const entry of forkedEntries) {
			await storage.appendEntry(entry);
		}
		return toSession(storage);
	}
```
`L332–L373`(中间注释省略)

**取材规则不在这里,在 `repo-utils.ts` 的 `getEntriesToFork`**:

| 入参 | 复制什么 |
|---|---|
| 不给 `entryId` | `storage.getEntries()` —— **全部条目**,含别的分支与 leaf 光标条目 |
| `entryId` + `position: "at"` | `getPathToRoot(target.id)` —— root→目标 的链,**含目标本身** |
| `entryId` + `position` 省略或 `"before"` | 先要求目标是一条 **user 消息**,否则 `SessionError("invalid_fork_target")`;再取 `getPathToRoot(target.parentId)` —— 复制到目标的父为止 |

`"before"` 是默认值,对应的产品动作是「把我上一句话改一改重来」。

其余四点:

- **L338 先 open 源会话**:既校验它还在,也把全部条目读进内存 —— 取材要沿 `parentId` 链回溯,那必须有一份完整的 `byId` 表。
- **L343 目标 cwd 可以与源不同**,于是 fork 顺带能把会话搬到另一个项目目录下(`repo.test.ts` 第二个用例断言了 `forkMetadata.cwd === "/tmp/target"`)。
- **L357/L360 血缘与 metadata**:没显式给父会话时记源会话的**文件路径**,这是唯一能回溯「从哪儿分叉来」的地方;header 里的自定义 metadata 默认继承源会话,给了就**整份覆盖**,不做逐字段合并(`repo.test.ts` 第三个用例钉住:继承与覆盖各有一条断言)。
- **L369 逐条 `appendEntry` 复制**:每条都是一次 `appendFile`(打开-追加-关闭),条目多时就是 N 次文件写。leaf 条目进不进新文件取决于走哪条取材路:给了 `entryId` 走 `getPathToRoot`,leaf 条目永远不在 `parentId` 链上,于是一条都不会被复制,下次 `open()` 靠重放推出 leaf,自然停在最后一条被复制的条目上;不给 `entryId` 走 `getEntries()`,leaf 条目**照抄**,新会话的光标因此与源会话一致。

顺带一个事实:**本仓目前没有生产调用方调用 `fork()`**。桌面端 UI 上的「回到这条消息」走的是 `harness.navigateTree()`(在同一个会话里挪 leaf,`kernel/src/host/session-manager.ts:857` 的 `navigate`),不是 fork。`fork` 是 `SessionRepo` 契约的一部分,由 `test/harness/repo.test.ts` 的两个用例覆盖。

### §10 listSessionDirs:sessionsRoot 下扫一层目录(L375–L402)

```ts
	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
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
		return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
	}
```
`L380–L401`(中间注释省略)

不带 `cwd` 的 `list()` 用它。`exists` 分支的理由与 §7 里那次相同:第一次运行时 `sessionsRoot` 还没被 `create()` 建出来,直接 `listDir` 会 ENOENT,而「一个会话都没有」不该在 UI 上表现成错误。

过滤只看 `kind === "directory"`,**不校验目录名是不是 `--…--` 这个编码形状** —— `sessionsRoot` 下手工放的任何目录都会被扫进来(里面没有 `.jsonl` 自然就是空结果)。反过来,指向别处会话目录的**符号链接**会被滤掉(`kind` 是 `"symlink"`),这与 §7 里 `kind !== "directory"` 的方向恰好相反,是本文件里唯一一处不对称。

## 5. 会咬人的地方

- **`encodeCwd` 不可逆且会撞名(L103–L109)。** `/a/b` 与 `/a-b` 编码后同为 `--a-b--`,两个项目的会话混进同一个目录;`list({cwd})` 是按目录过滤的,于是会多给。要严格只能拿到结果后再按 `metadata.cwd` 过一遍。反解析目录名拿 cwd 是错的 —— 真正的 cwd 在文件 header 里。
- **cwd 不做规范化(L108)。** `/tmp/proj`、`/tmp/proj/`、相对路径 `.` 各自落到不同目录,同一个项目会被拆成好几堆会话。「宿主传绝对路径」是约定,不是这个函数的保证。
- **`sessionId` 不做任何清洗就进文件名(L177)。** 含 `../` 的 id 能把文件写到目录外面。现有调用方给的都是 uuidv7 或不给,这是约定而不是防线。
- **repo 不检查 id 重复(L197、L215)。** 同一个 id 建两次会得到两个文件,`list()` 里出现两条同 id 记录,而桌面端的会话表按 id 做 Map(`session-manager.ts:373` 的 `existing` 分支):第二条被**合并到第一条**上,而不是覆盖它 —— 列表里两行长得一模一样,其中一个会话文件在 UI 上再也打不开。若连时间戳(毫秒)也撞上,文件路径完全相同,`writeFile` 的覆盖语义会直接清空旧文件。
- **文件名时间戳与 header 时间戳是两次独立取值(L201 与 `JsonlSessionStorage.create` 内部)。** 可能差几毫秒,`list()` 排序用 header 那份 —— 按文件名排与按 `createdAt` 排在极端情况下不一致。
- **`list()` 只读 header,所以坏会话看不出来(L282)。** 正文里有一行残缺 JSON(断电写了半行)的会话会好端端地列在那儿,一点开 `open()` 就抛 `invalid_entry`,而全仓没有任何截断 / 跳过坏行的修复逻辑。这是全景篇 §6.1「崩溃半行是致命的」那一条在本文件这一侧的表现。
- **排序键可能不是合法日期(L299)。** header 校验只要求 `timestamp` 是非空字符串(`jsonl-storage.ts` 的 `parseHeaderLine`),不保证 `Date` 解析得了;解析不出来时比较结果是 `NaN`,而规范规定比较器返回 `NaN` 按 `+0`(即「相等」)处理 —— 这条记录与谁比都「相等」,比较器就此失去传递性,它最终落在哪儿全看排序算法。不报错,只是位置不可预期。
- **`list()` 的容错口径很窄(L291)。** 只吞 `invalid_session`;权限 / I/O 类错误会整张列表一起失败。这是有意的(悄悄跳过会让用户以为会话丢了),但意味着一个坏掉的挂载点能让整个会话列表打不开。
- **`delete()` 只删文件(L311–L316)。** 不清理空掉的编码目录;fork 出去的子会话 header 里的 `parentSession` 会变成悬空路径,而没有任何地方会去修它。
- **`fork()` 中途失败没有回滚(L369–L371)。** 新文件带着写了一半的条目留在磁盘上,而且它的 header 是好的,于是 `list()` 照样把这个半成品列出来。
- **`fork()` 是引用复制(L369)。** 写进新文件的字节是独立的,但内存里两个 storage 的 `entries` 数组装着**同一批条目对象**;条目的 `id` 与 `parentId` 原样保留,所以 fork 出来的会话与源会话共用同一套条目 id —— 跨会话比 id 是不安全的。
- **`open()` 的 TOCTOU 窗口(L233–L246)。** `exists` 与真正读之间文件被删,错误会从 `Session not found: <path>` 退化成 `Failed to read session ...`,`code` 仍是 `not_found` 但消息变了 —— 按消息文本判断的代码会漏。
- **符号链接的两处判据方向相反(L278 vs L400)。** `list()` 收下软链**文件**(`kind !== "directory"`),`listSessionDirs()` 丢掉软链**目录**(`kind === "directory"`)。想用软链把会话目录挂到别处,只有文件级的能用。
- **`Pick` 清单里的 `cwd` 是死项(L73)。** 本文件从不读 `this.fs.cwd`。它不会造成 bug,但会误导人以为 repo 的相对路径解析跟 `fs.cwd` 有直接关系 —— 相对路径的解析发生在 `NodeExecutionEnv.absolutePath` 内部。

> 与全景篇、CLAUDE.md 的说法**没有发现出入**:全景篇 §6.1 里关于 `encodeCwd`、两个时间戳、`list()` 只读 header 的三条断言都与代码一致。原文件头(L1–L4)自陈的「逐字移植、唯一差异是 `Session` 的导入路径」在本仓内无法证伪(上游 pi 不在本仓),按代码看至少与 `memory-repo.ts` 的同款说明自洽。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `agent/src/harness/types.ts` | `FileSystem` 与四个 `Jsonl*` 类型 + `SessionError` / `toError`;`JsonlSessionRepoApi` 就是本文件实现的契约 |
| 它 import | `agent/src/harness/session/jsonl-storage.ts` | `JsonlSessionStorage.create/open` 真正读写单个会话文件;`loadJsonlSessionMetadata` 是 `list()` 的只读 header 快路 |
| 它 import | `agent/src/harness/session/repo-utils.ts` | `createSessionId` / `createTimestamp` / `toSession` / `getFileSystemResultOrThrow` / `getEntriesToFork`(fork 的取材规则在那里) |
| 它 import | `agent/src/harness/session/session.ts` | 仅类型 `Session`;不经 `../types.ts` 转口是为了避开 `index.ts` 星号导出造成的歧义导出(见 L1–L3 原文件头) |
| 间接依赖 | `agent/src/harness/env/nodejs.ts` | 唯一的 `FileSystem` 实现;`exists`/`listDir` 的 `lstat` 语义、`writeFile` 自动 mkdir 都是本文件行为的前提 |
| import 它 | `agent/src/index.ts` | 包主入口整个星号转出(`export * from "./harness/session/jsonl-repo.ts"`) |
| import 它 | `coding-agent/src/acp/agent.ts` | ACP(Zed)宿主:`create` / `list` / `open` |
| import 它 | `kernel/src/host/session-manager.ts:196` | 桌面端宿主:`list`(:371)/ `create`(:399)/ `delete`(:423)/ `open`(:474) |
| 对照实现 | `agent/src/harness/session/memory-repo.ts` | 同一套 `SessionRepo` 语义的内存版,一一对照读最省事 |
| 测试 | `agent/test/harness/repo.test.ts` | `describe("JsonlSessionRepo")` 三个用例:编码目录与按 cwd 列出、open/delete/fork、header metadata 的继承与覆盖 |

## 7. 自测题

**Q1.** 把 L278 的 `file.kind !== "directory"` 改成 `file.kind === "file"`,会发生什么?

<details><summary>答案</summary>

会漏掉**指向会话文件的符号链接**。`NodeExecutionEnv.listDir` 用 `lstat` 且不跟随软链,所以软链条目的 `kind` 是 `"symlink"` 而不是 `"file"`。普通用法(全是真实文件)两种写法等价,但「把老机器的会话软链进来」这种用法会静默少列几条 —— 不报错,只是看不见。顺带一提,`listSessionDirs()`(L400)用的正是 `kind === "directory"`,所以软链**目录**本来就列不出来。
</details>

**Q2.** `NodeExecutionEnv.writeFile` 自己会 `mkdir` 父目录。那 L208 的 `createDir(sessionDir, { recursive: true })` 是不是可以删?

<details><summary>答案</summary>

对当前唯一的实现来说确实是冗余的,删了测试也会绿。但**不能删**:`FileSystem` 接口写的是「创建或覆盖文件,**在支持时**创建父目录」—— 自动建父目录是实现的善意而不是契约。换一个严格照契约实现的 FileSystem(浏览器 OPFS、远端 FS),删掉这行就是 `create()` 直接 ENOENT,而且失败点会诡异地落在 storage 里而不是这里。这类「看起来冗余的防御」的判断标准是看**契约**而不是看当前实现。
</details>

**Q3.** 两个项目 `/srv/a/b` 与 `/srv/a-b` 各建了一个会话,`await repo.list({ cwd: "/srv/a-b" })` 返回几条?怎么才能只拿到本项目的?

<details><summary>答案</summary>

两条。`encodeCwd("/srv/a/b")` 与 `encodeCwd("/srv/a-b")` 都是 `--srv-a-b--`,两个会话落在同一个目录里,而 `list({cwd})` 是**按编码后的目录名**取的(L262),不看 header。要严格只能自己再过一道:`(await repo.list({cwd})).filter(m => m.cwd === cwd)` —— 每条 metadata 的 `cwd` 是从各自文件的 header 读出来的真值。
</details>

**Q4.** `fork()` 复制到一半断电了。重启后这个会话在列表里看得见吗?点开会怎样?

<details><summary>答案</summary>

看得见,而且多半能正常打开。`fork()` 先由 `JsonlSessionStorage.create` 写好完整的 header(L349),再逐条 `appendEntry`(L369),中途失败没有回滚 —— 磁盘上留下一个 header 完好、条目只有一半的文件,而 `list()` 只读 header(L282),所以它长得和正常会话一模一样。点开时:如果断电恰好把最后一条 JSON 写了半行,`open()` 会抛 `SessionError("invalid_entry")`;如果每一行都是完整的,`open()` 成功,只是这个 fork 的历史比预期短一截,而**没有任何地方会告诉你少了东西**。
</details>

**Q5.** 传给 `open(metadata)` 的 metadata 里 `id` 被改成了别的值,但 `path` 是对的。拿到的 `Session` 的 id 是什么?

<details><summary>答案</summary>

是**文件 header 里的那个 id**,传进来的 `id` 被完全忽略。`open()` 只用 `metadata.path`(L239、L246),`JsonlSessionStorage` 的 metadata 是 `headerToSessionMetadata(header, filePath)` 现算的。同理 `cwd` 与自定义 `metadata` 也以文件为准。这个性质是好事:列表里的 metadata 可能是几分钟前读的快照,而打开时以磁盘为准 —— 但它也意味着**不要指望用 metadata 去「重命名」或「改归属」一个会话**,那得往会话树里追加条目。
</details>
