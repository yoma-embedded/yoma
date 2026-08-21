# packages/agent/src/harness/session/jsonl-storage.ts

> **档位** A(逐行) · **行数** 577(加注释前 319) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §3「JSONL 追加日志格式」/「leaf 光标与追加即前进」、§4 阶段 0.3 与步骤 3a / 26 / 37、§7「会话树与持久化」 · **索引** [README](../README.md)

## 1. 一句话

把一棵会话树写成「第一行 header + 一行一条目」的 JSONL 追加日志,重开文件时逐行重放恢复光标 —— 它是 `SessionStorage` 接口的磁盘实现,也是一次真实 prompt 里**唯一被写到的持久化组件**。

## 2. 它在全景里的位置

先把术语摆平:**条目(entry)** 是会话树的节点,统一带 `{type, id, parentId, timestamp}`;**leaf** 是这棵树上唯一的光标,指着「当前对话的末端」;**storage** 这一层只回答「一个会话怎么读写」,而「一堆会话怎么建/列/删/fork」是上一层 `SessionRepo` 的事(`jsonl-repo.ts`)。本文件是 `SessionStorage` 两套实现里落盘的那一套,另一套是 `memory-storage.ts`。

在全景篇 §4 的编号时间线上,它出现三次:

- **阶段 0.3(装配)** —— `repo.create({cwd, id})` 落到本文件的 `create()`(写下 header),`repo.open(meta)` 落到 `open()`(整文件读入、逐行重放恢复 leaf)。这是一次会话生命里唯一一次「整文件读」。
- **步骤 3 / 3a(每轮开头,读)** —— `harness.createTurnState()` → `Session.buildContext()` → `storage.getLeafId()` + `storage.getPathToRoot(leafId)`。注意这两步**一次磁盘都不碰**:打开时已经把全部条目装进内存,这里只是走内存里的 `parentId` 链。
- **步骤 26 / 37(轮内与轮末,写)** —— `handleAgentEvent` 收到 `message_end` 就 `session.appendMessage()`(先落盘再转发),轮末 `flushPendingSessionWrites()` 把挂起写入 FIFO 排空。它们最终都落到本文件的 `appendEntry()`,一条条目一次 `appendFile`。

**谁调它**:只有 `jsonl-repo.ts`(`create` / `open` / `list` / `fork` 四处)以及测试;上层 `Session` 只认 `SessionStorage` 接口,`AgentHarness` 更是连接口都不直接碰。**它调谁**:`FileSystem` 的四个方法(`readTextFile` / `readTextLines` / `writeFile` / `appendFile`),生产里由 `harness/env/nodejs.ts` 的 `NodeExecutionEnv` 实现;另加 `repo-utils.ts` 的 `getFileSystemResultOrThrow`(把 Result 世界翻译成 throw 世界)和 `uuid.ts` 的 `uuidv7`。

**不存在会怎样**:内核仍然跑得动 —— 换成 `InMemorySessionStorage` 一切照常,只是关掉 app 历史全丢、桌面端的会话列表永远是空的、`fork` 无从谈起。反过来说,这个文件出问题的表现方式很特别:**它坏起来是静默的**。全景篇 §7 记的那条「坏会话在列表里显示得好好的,一点开就炸」正是本文件两条读路径不对称造成的(见 §5)。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| — | L1–L35 | 文件头:原作者的 5 行纪要 + 本次补的块注释(职责、全景位置、分节索引) |
| §1 | L36–L61 | 依赖与两张契约:窄 `FileSystem` 切片 + `SessionHeader` |
| §2 | L62–L114 | 内存索引的三个维护器:`updateLabelCache` / `buildLabelsById` / `generateEntryId` |
| §3 | L115–L137 | 两个错误构造器:`invalidSession` / `invalidEntry` |
| §4 | L138–L194 | `parseHeaderLine`:header 行的解析与校验 |
| §5 | L195–L240 | `parseEntryLine`:条目行的解析与校验 |
| §6 | L241–L270 | 重放规则 `leafIdAfterEntry` + `headerToSessionMetadata` |
| §7 | L271–L333 | 两条读路径:`loadJsonlSessionMetadata`(只读一行)/ `loadJsonlStorage`(整文件重放) |
| §8 | L334–L380 | 类字段与私有构造:内存里的三份索引 |
| §9 | L381–L429 | `open()` / `create()`:文件生命中唯一一次覆盖写 |
| §10 | L430–L482 | 光标:`getMetadata` / `getLeafId` / `setLeafId` |
| §11 | L483–L514 | 追加:`createEntryId` / `appendEntry` |
| §12 | L515–L539 | 查询:`getEntry` / `findEntries` / `getLabel` |
| §13 | L540–L577 | 走树:`getPathToRoot` / `getEntries` |

## 4. 逐节讲解

### §1 依赖与两张契约(L36–L61)

```ts
L37–L40
import type { FileSystem, JsonlSessionMetadata, LeafEntry, SessionStorage, SessionTreeEntry } from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";
import { uuidv7 } from "./uuid.ts";
```

`../types.ts` 是 `harness/types.ts`(本目录下没有 `types.ts`,类型总仓在上一级)。整个文件只 import 三个模块(四行 import:`../types.ts` 的类型与值各一行,加 `repo-utils.ts`、`uuid.ts`),一个 `node:*` 都没有 —— 磁盘能力全靠注入。

```ts
L46
type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;
```

`FileSystem` 一共 17 个成员(16 个方法 + `cwd` 这个属性),这里只 `Pick` 四个。这不是洁癖,是两个具体收益:

1. **测试可以拿字面量对象当替身。** `test/harness/storage.test.ts` 最后一个用例直接传了一个四函数对象,其中 `readTextFile` 故意 `throw new Error("readTextFile should not be called for metadata")` —— 用类型允许的最小面积证明「列表路径确实没读全文」。整个 `FileSystem` 的话,这个替身要凑齐 16 个方法加一个 `cwd`。
2. **换后端在类型上是可能的。** 全景篇把「`JsonlSessionStorage` 只依赖 4 个方法,窄到可以被任何环境实现」列为 Repo/Storage 两层抽象的实际收益。

注意这四个方法的契约是**永不 throw**:它们返回 `Result<T, FileError>`(全景篇 §3「ExecutionEnv 的永不 throw 契约」)。本文件里每一次文件调用都被 `getFileSystemResultOrThrow` 包着,那个函数是 Result 世界与 session 的 throw 世界之间的唯一适配边界(`repo-utils.ts` 的 `getFileSystemResultOrThrow`),`not_found` 原样保留、其余一律折成 `storage`。

```ts
L50–L60
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
```

header 是文件第一行,它**不是条目** —— 没有 `id/parentId/timestamp` 那套树语义,`id` 在这里是 sessionId,`timestamp` 是会话创建时间。`version: 3` 是字面量类型,校验时严格相等(§4)。

### §2 内存索引的三个维护器(L62–L114)

这三个函数在 `memory-storage.ts` 里有**逐字相同的一份**,两处手写重复、没有 import 关系。重复是有意的:树语义必须两处同解,而抽公共文件会让「内存实现是最干净的入口文件」这个定位打折。

`updateLabelCache`(L69–L79)把一条 `label` 条目折算成对缓存的一次增量更新。它开头就 `if (entry.type !== "label") return;`,所以调用方可以对每条条目无脑调一次。两个细节:

- **L72 先 `trim()` 再判断** —— 只含空格的 label 视同没写。
- **L77 是 `delete` 而不是写空串** —— 「空 label」的语义是删标签。写成 `set(targetId, "")` 的话 `getLabel` 会返回 `""`,调用方的 `?? 默认值` 全部失效(空串是 falsy 但不是 nullish)。因为标签本身也是追加日志的一部分,「改名」和「删标签」都表现为再追加一条 label 条目,按顺序折算天然实现「最后一条赢」。

`buildLabelsById`(L85–L91)是它的批量版,只在 `open()` 重放时用一次;之后由 `appendEntry` 增量维护(§11)。

```ts
L102–L113(只贴代码,略去其间的中文注释行)
function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		// uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部。
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}
```

参数类型写成 `{ has(id: string): boolean }` 而不是 `Map` —— 结构化类型让 `Map` 和 `Set` 都能传,测试也能塞假对象。三件事必须记住:

1. **`slice(-8)` 取的是随机尾部。** uuidv7 的布局是「前 6 字节毫秒时间戳 + sequence + 随机尾」,`-8` 个十六进制字符 = 最后 4 字节 = `bytes[12..15]`,**一位时间戳都没进去**。所以条目 id 只有 32 位纯熵、完全不可排序。这条的下游代价写在 `packages/kernel/src/ids.ts` 的文件头:桌面端每个集合都用 `Binary.search` 按 id 字符串序维护,直接透传内核 id 会让消息顺序乱掉且不报错,于是 host 自己铸了一套可排序 id。
2. **它只查重,不预留。** `createEntryId()` 返回之后没有任何登记动作,而 `Session.append*` 拿到 id 到真正 `appendEntry` 之间还隔着一次 `await getLeafId()`。并发调两个 `append*`,理论上能拿到同一个 id,并且**一定会拿到同一个 `parentId`** —— 结果是两条新条目并列挂在同一个父下,意外分叉而不是链。harness 用挂起写入的 FIFO 串行 flush 规避;直接用 `Session` 的调用方要自己保证串行。
3. **兜底返回的是完整 36 字符 uuid。** 100 次全撞车才会走到 L112,但一旦走到,同一个会话里就混着 8 字符和 36 字符两种 id —— 别把长度当判据。

### §3 两个错误构造器(L115–L137)

两个函数只是拼消息 + 选 `code`,但 `code` 的选择是有后果的:

```ts
L121–L123 / L130–L136
function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}
```

`JsonlSessionRepo.list()` 只吞 `invalid_session` 这一种 code(`jsonl-repo.ts` 的 `list()`),别的原样往上抛。于是「header 坏掉的会话在列表里被静默跳过」,而「条目坏掉的会话照常列出来」—— 后者就是全景篇那条「一点开就炸」的来源。`invalidEntry` 的 `lineNumber` 只用于人肉定位,而且它不是文件真实行号(见 §5、§7)。

### §4 header 行的解析与校验(L138–L194)

`parseHeaderLine` 是一串没有 else 的守卫,任何一项不合格立刻抛。挑四处讲:

```ts
L153–L159
	// typeof null === "object",所以 null 必须单独排掉。
	// 数组能过这一关,但下一行的 type !== "session" 会把它挡住。
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
```

`as Partial<SessionHeader>` 只是为了让下面的字段访问有类型,不代表任何运行时保证 —— 保证由紧跟着的每一行 `typeof` 提供。

```ts
L162
	if (header.version !== 3) throw invalidSession(filePath, "unsupported session version");
```

**严格 `!== 3`,没有任何迁移分支。** version 1/2 的老文件一律 `invalid_session`,而 `list()` 恰好吞这个 code —— 表现是「我的老会话不见了」而不是报错。改格式时这一行就是唯一的闸门。

```ts
L175–L180
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(filePath, "session header metadata must be an object");
	}
```

`Array.isArray` 那一项不能省:数组也是 object,而 `metadata` 的契约是 `Record<string, unknown>`,放数组进来下游取 key 会全是数字下标。`parentSession` 与 `metadata` 都是「undefined 放行,有值才校验」—— 与条目行的 `parentId` 相反(§5)。

```ts
L184–L192
	return {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
```

**白名单式重建**,不是原样透传:文件里带的额外字段到此为止,不进内存,也不会在 `fork` 复制元数据时被无意传播。代价是 header 的扩展只能改这个文件。

### §5 条目行的解析与校验(L195–L240)

```ts
L215–L238(只贴代码,略去其间的中文注释行)
	const entry = parsed as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(filePath, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof entry.timestamp !== "string" || !entry.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
```

这里的取舍是整个文件最值得学的一处:**只校验所有条目共有的四件套(`type`/`id`/`parentId`/`timestamp`)外加 leaf 的 `targetId`,载荷一个字都不校验。**

- 为什么不深校验:`message` 条目的载荷是 `AgentMessage`,深校验要给它写一份运行时 schema,而那会让「老文件遇上新内容类型」直接开不开 —— 追加日志的兼容性要求是「旧读者遇到不认识的东西不要死」。
- 代价:一条缺 `message` 字段的 `message` 条目能顺利读进来,到 `sessionEntryToContextMessages` 才炸,那时已经看不出是哪一行坏了。压缩链路上有一处专门为此写的运行时防线可以佐证 —— `harness/compaction/utils.ts` 的 `extractFileOpsFromMessage` 里那条注释原话:「消息可以是从磁盘 .jsonl 重放回来的(jsonl-storage 直接 JSON.parse,不做 schema 校验),老版本或被手工改过的会话文件里 content 可以是任何东西」。
- **`parentId` 的条件写法要看清楚**(L226):`entry.parentId !== null && typeof entry.parentId !== "string"`。`undefined` 既不等于 `null`、`typeof` 也不是 `"string"`,所以**少写这个字段是不合法的** —— 根条目必须显式写 `"parentId": null`。这与 header 里可选字段的处理正好相反。
- 只校验 leaf 的 `targetId`(L234):因为 §6 的重放规则要拿它当下一个光标,坏了会让整棵树的入口跑偏;`label` 条目也有 `targetId`,但那个坏了顶多丢个标签。

### §6 重放规则与 header→metadata(L241–L270)

```ts
L251–L253
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}
```

**整个存储层最核心的一行。** 语义:写完一条条目之后,光标应该在哪儿。

- 普通条目 → 指向它自己。于是「顺序对话是一条直链」不需要任何额外机制:每次 `append*` 都 `parentId = 当前 leaf`,写完新条目自己成为 leaf。
- `leaf` 条目 → 指向它的 `targetId`。这就是「把光标本身写成数据」:`setLeafId(x)` 不是改内存变量,而是追加一条 `{type:"leaf", targetId:x}`,于是重开文件时逐行套用这条规则就能恢复用户上次真正停留的位置,而不是回到最后一条条目。

推论(全景篇 §3 也记了):`leaf` 条目虽然进了 `entries` 和 `byId`,却不会出现在任何一条 `getPathToRoot` 路径里 —— 它是纯粹的日志侧枝,永远不会成为别人的 `parentId`。**但这是「正常调用下」的推论,不是被强制的**,见 §5 的第 6 条。

`headerToSessionMetadata`(L260–L269)把文件里的形状翻译成上层认的 `JsonlSessionMetadata`。两处差异:字段名 `timestamp` → `createdAt`;`path` 不在文件里,由调用方把「我是从哪个路径读到的」补进来 —— 所以同一个会话文件换个路径打开,`metadata.path` 就跟着变,它是**位置**而不是身份。

### §7 两条读路径(L271–L333)

**快路**(`loadJsonlSessionMetadata`,L281–L294,本文件两个导出符号之一):

```ts
L285–L293(只贴代码,略去其间的中文注释行)
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	throw invalidSession(filePath, "missing session header");
```

`JsonlSessionRepo.list()` 对每个 `.jsonl` 文件调它一次(`jsonl-repo.ts` 的 `list()`)。走 `readTextLines({maxLines:1})` 而不是 `readTextFile`,是为了让「列出 200 个会话」不必把 200 份完整对话读进内存 —— `NodeExecutionEnv.readTextLines`(`env/nodejs.ts` 的 `readTextLines`)用 `createInterface` 逐行读,`lines.length >= maxLines` 就 `break`,并在 `finally` 里 `close()` + `destroy()`。文件为空时返回空数组,`lines[0]` 是 `undefined`,可选链把「空文件」和「第一行是空白」合并成同一个错误。

**全路**(`loadJsonlStorage`,L303–L332):

```ts
L311–L315(只贴代码,略去其间的中文注释行)
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
```

```ts
L326–L330
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
```

从 1 开始(0 号已经当 header 消费掉了),每一步都**无条件覆盖** `leafId`。循环结束时 `leafId` 就是「最后一条条目决定的光标」—— 这是 §6 的规则在文件维度上的兑现,也是「光标是条目」这个设计的全部收益兑现处。

两条路径的三处不对称值得单独记:

| | 快路 `loadJsonlSessionMetadata` | 全路 `loadJsonlStorage` |
|---|---|---|
| 读多少 | 第一行 | 整个文件(无流式路径) |
| 空行 | 不滤,物理第一行为空就报「missing session header」 | 先 `filter` 掉所有空行 |
| 谁用 | `repo.list()` | `storage.open()` |

`split("\n")` 之后不 `trim` 每一行也没关系:CRLF 文件行尾留下的 `\r` 是合法的 JSON 空白,`JSON.parse` 不介意(本仓工作树就是 CRLF)。

### §8 类字段与私有构造(L334–L380)

```ts
L344–L354(只贴代码,略去其间的中文注释行)
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;
```

理解这个类只需要一句话:**它是一个带内存缓存的写前端。** 十个接口方法里有八个纯查内存,一次磁盘都不碰;只有 `setLeafId` 和 `appendEntry` 会 `appendFile`。同一份数据三个视角:`entries` 保序、`byId` 供 O(1) 命中、`labelsById` 是 label 条目的折算结果。两个写方法负责让三者同时前进。

```ts
L363–L379(只贴代码,略去其间的中文注释行)
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
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
	}
```

构造函数私有,外部只能走 `open()` / `create()` —— 因为这两条路都要先落地文件(读到 header,或写下 header),而构造函数不能 `await`。这是「静态异步工厂」的标准写法。

**与内存实现的关键差异在这里**:`InMemorySessionStorage` 的构造函数会校验 leafId 是否存在(`memory-storage.ts` 构造函数末尾那段校验,拿不到就抛 `invalid_session`),而这里**不校验**。后果见 §5 第 5 条。

`new Map(entries.map(...))` 遇到重复 id 时后写的赢,而 `entries` 数组里两条都留着 —— 追加日志没有唯一性约束,查重只发生在铸新 id 的那一刻。

### §9 open() / create()(L381–L429)

```ts
L387–L390
	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}
```

文件不存在时 `readTextFile` 返回 `not_found` 的 Result,经 `getFileSystemResultOrThrow` 变成 `SessionError("not_found")` —— `storage.test.ts` 的 "throws for missing files when opening" 用例直接钉住了这个 code。

```ts
L409–L427(只贴代码,略去其间的中文注释行)
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
			metadata: options.metadata,
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStorage(fs, filePath, header, [], null);
```

三点:

- **L423 是这个文件生命中唯一一次 `writeFile`**,此后只有 `appendFile`。结尾那个 `\n` 不能少 —— 下一次 `appendFile` 直接从新行开始写,没人会回头补换行。
- **L415 的取时与文件名里的时间戳是两次独立调用**(文件名那次在 `jsonl-repo.ts` 的 `create()` 里调 `repo-utils.ts` 的 `createTimestamp()`),可能差几毫秒;`list()` 排序用的是 header 里这一份,所以按文件名排和按 `createdAt` 排在极端情况下可能不一致。
- **L427 写成功之后才建对象**:不会出现一个「以为自己已落盘」而文件根本不存在的存储实例。这个顺序在两个写方法里同样成立(§10/§11)。

`create()` 不建目录 —— 那是 repo 的活(`jsonl-repo.ts` 的 `create()` 里那次 `createDir({recursive:true})`)。

### §10 光标:getMetadata / getLeafId / setLeafId(L430–L482)

`getMetadata`(L432)是这一节里最短的一个,也是唯一一个**什么都不做**的接口方法:`return this.metadata` —— 那份 `JsonlSessionMetadata` 在私有构造里就由 `headerToSessionMetadata(header, filePath)` 折算好了(§8),此后既不读盘也不重算。两个后果:一是它虽然签了 `Promise`,却永远不会因为磁盘出事而失败;二是返回的是**同一个对象引用**而不是拷贝(字段是 `private readonly`,但 readonly 只挡住重新赋值、挡不住改字段),调用方就地改 `metadata.path` 会污染这个实例后续每一次 `getMetadata()`。

```ts
L442–L447
	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}
```

多做的那件事是**每次都验一遍光标还在不在**。它是构造期不校验的补偿:悬空光标(文件末尾的 `leaf` 条目指向一个不存在的 id)的 `invalid_session` 从这里抛出来,而不是从 `open()`。上层 `Session.getBranch()` 每轮开头都会调它(全景篇 §4 第 3a 步),所以坏会话最晚在第一次 prompt 时暴露。

```ts
L456–L481(只贴代码,略去其间的中文注释行)
	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.currentLeafId = leafId;
	}
```

四个点:

1. **两种 code 的分工**:目标不存在抛 `not_found`(调用方给错了),而 `getLeafId` 的悬空抛 `invalid_session`(文件自己坏了)。同一个「id 找不到」,来源不同、code 不同。
2. **L467 的 `parentId` 记的是「从哪儿跳走的」,`targetId` 才是「跳到哪儿」。** 于是日志保留了跳转轨迹,而树的形状(谁挂在谁下面)完全不受影响。
3. **L473 先落盘、L477–L480 才改内存。** 反过来写的话,一次写盘失败就会留下「内存以为光标动了、文件里没这回事」的分裂状态,而下次 `open()` 会把它推翻 —— 这类不一致只有重启才暴露,是最难查的一种。
4. **L480 落在 `targetId` 上而不是这条 leaf 条目自己的 id**,与 §6 的重放规则同解。传 `null` 是合法的,表示回到空会话,下一条追加的条目就成了新的根。

### §11 追加:createEntryId / appendEntry(L483–L514)

```ts
L499–L513(只贴代码,略去其间的中文注释行)
	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.currentLeafId = leafIdAfterEntry(entry);
	}
```

收到的是一条**完整**条目 —— `id` / `parentId` / `timestamp` 都是上层 `Session` 填好的:`session.ts` 里**九个**公开 `append*` 一律写 `id = await createEntryId()`、`parentId = await getLeafId()`;`createEntryId()` 的第十个调用点是 `moveTo()` 尾巴上那条 `branch_summary`,它的 `parentId` 显式写目标 `entryId`、不再问一次 leaf(`uuid.ts` 的文件头把这 10 处点过名)。私有的 `appendTypedEntry` 虽然也叫 `append*`,但它只做转发,一个字段都不填。存储层不生成也不校验它们:`parentId` 指向不存在的条目照样写进去,到 `getPathToRoot` 才会抛。

五件事的顺序是固定的:落盘 → 进数组 → 进 byId → 折算标签 → 推进光标。最后一行是「追加即前进」的**唯一**实现处(另一个推进光标的地方只有 `setLeafId`)。

`createEntryId`(L488–L490)只是 `generateEntryId(this.byId)` 的转发,并发风险见 §2。

### §12 查询:getEntry / findEntries / getLabel(L515–L539)

三个方法都是纯内存,值得记的是**语义范围**:

- `getEntry`(L517)返回的是**活对象**而不是拷贝。调用方改了它,内存和文件就分家了 —— 文件里那一行不会变。
- `findEntries`(L526–L530)的谓词写成类型守卫 `entry is Extract<SessionTreeEntry, { type: TType }>`,于是 `findEntries("compaction")` 拿到的元素直接能读 `summary`,不用再断言一次。**它扫的是全部条目而不是当前路径** —— 别的分支上的条目也算数。
- `getLabel`(L536)同理是全量语义:标签缓存由所有 `label` 条目按顺序折算而来,别的分支上打的标签在这里也看得见(全景篇 §7 记了这一条,和 `getSessionName()` 一起)。

### §13 走树:getPathToRoot / getEntries(L540–L577)

```ts
L547–L567(只贴代码,略去其间的中文注释行)
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
```

这是**「当前对话」的定义式**:从 leaf 沿 `parentId` 一路走到根,返回 root→leaf 顺序的数组。全景篇 §4 第 3a 步拿到的正是它;不在这条路径上的分支仍在文件里,只是不在投影里 —— 「投影不是历史」这条咒语在存储层的落点就是这个函数。

四个细节:

- **`unshift` 而不是 `push` + `reverse`**:直接攒成 root→leaf 顺序,少一个「忘了反转」的出错点。代价是 `unshift` 为 O(n),整条路径 O(n²);但路径长度是「当前对话的条目数」而不是全部条目数,而且每轮只走一次,和 `open()` 读全文比起来微不足道。
- **`if (!current.parentId) break;` 是 falsy 判断而不是 `=== null`**:空串 `parentId` 也被当成「到根了」。
- **两种 code 再次分工**:入口 id 找不到 → `not_found`(调用方给错了);中途断链 → `invalid_session`(文件坏了)。
- **没有环检测**:见 §5。

`getEntries`(L574–L576)返回 `[...this.entries]` —— 数组是浅拷贝,数组本身安全,元素还是同一批对象。`JsonlSessionRepo.fork()` 经 `repo-utils.ts` 的 `getEntriesToFork()` 拿它去重放 —— 准确说只有「不给 `entryId` 的整份 fork」走 `getEntries()`,给了 `entryId` 那条路走的是 `getPathToRoot()`。两条路都是逐条 `appendEntry` 写进新文件,于是新会话的**文件**是独立的,而内存里的条目对象仍与源会话共享(全景篇 §7 记了这条)。

## 5. 会咬人的地方

1. **两条读路径对空行不同解(L285–L291 vs L315)。** 快路读物理第一行,全路先 `filter` 掉所有空行。所以一个开头多了个空行的会话文件:`open()` 打得开(能正常对话),`repo.list()` 却把它当 `invalid_session` 静默跳过 —— 表现是「这个会话打不开也删不掉,因为列表里根本没有它」。反过来,`list()` 只读 header 一行,所以**条目损坏的会话在列表里显示得好好的,一点开就炸**(全景篇 §7 已记)。

2. **`invalidEntry` 报的行号不是文件真实行号(L130–L136、L315、L327)。** `i + 1` 是**过滤掉空行之后**的序号。文件中间有空行时,报出来的行号比真实行号小,拿它去 `sed -n 'Np'` 会定位到另一行。

3. **【与注释不符】`uuid.ts` 开头那句「ID 天然按时间排序」对条目 id 不成立(L102–L113)。** `generateEntryId` 取的是 `uuidv7().slice(-8)` = 随机尾 4 字节,时间戳一位都没进去。那句注释只对完整 uuidv7(sessionId、`repo-utils.ts:createSessionId`)成立。全景篇 §7 已把这条标为【CM】;下游代价见 `packages/kernel/src/ids.ts` 的文件头注释。

4. **id 长度不统一(L112)。** 100 次撞车后兜底返回完整 36 字符 uuid,同一个会话里可能混着两种长度。任何「按长度判断这是不是条目 id」的代码都是错的。

5. **悬空光标能顺利 `open()`(L356–L362 vs L443)。** `InMemorySessionStorage` 的构造函数校验 leafId 存在性(`memory-storage.ts` 构造函数末尾),`JsonlSessionStorage` 的私有构造**不校验**。于是最后一条 `leaf` 条目指向不存在 id 的文件能打开成功,`getEntries()` / `findEntries()` 都正常,只有 `getLeafId()` 抛 `invalid_session`。同一个坏文件,两套实现的失败时机不同 —— 写跨实现的测试时要注意。

6. **`setLeafId` 的存在性校验查的是 `byId`,而 `byId` 里包含 `leaf` 条目(L459)。** 所以 `setLeafId(某条 leaf 条目的 id)` 能通过校验,此后 `getPathToRoot` 就会把一条 `leaf` 条目算进路径。全景篇 §3 那句「`leaf` 条目永远不会出现在任何一条 `getPathToRoot` 路径里」严格说是**「正常调用路径下」**的推论,不是被代码强制的不变式。正常调用方(`Session.moveTo`)不会这么干,但它没有被拦住。

7. **`create()` 用的是 `writeFile` = 覆盖(L422–L425)。** 对一个已存在的会话文件调 `create`,整份历史被一行 header 顶掉,而且不报错。`JsonlSessionRepo` 靠「时间戳 + sessionId」的文件名绕开它,但这个类是从 `packages/agent/src/index.ts` 的 `export *` 导出的公共 API,直接调 `JsonlSessionStorage.create(fs, 某个已有路径, …)` 没有任何保护。

8. **`appendFile` 不是原子写,半行没有任何修复逻辑(L502–L505、L315)。** 断电可能留下一条没写完的 JSON,而 `loadJsonlStorage` 只滤空行,残缺行直接 `invalid_entry`、整个 `open()` 失败。全仓找不到截断/跳过坏行的代码(全景篇 §7 已记)。

9. **`getPathToRoot` 没有环检测(L552–L565)。** 手工编辑出 a→b→a 的文件会让 `while` 永不结束,`path` 还在无限增长 —— 不是抛错,是挂死 + 吃内存。正常写入路径不可能产生环(`parentId` 只指向更早写入的条目),所以这是「坏文件」而不是「坏代码」,但它没有防线。

10. **`appendEntry` 对 id 唯一性和 `parentId` 存在性一律不校验(L499–L513)。** 重复 id 时 `entries` 里两条都在、`byId` 留后写的那条(L376),`getEntries()` 与 `getEntry()` 从此对不上;`parentId` 指向不存在的条目要到 `getPathToRoot` 才抛。`repo.fork()` 正是靠这份宽松才能把源会话的条目**原样**(保留原 id / parentId)重放进新文件。

11. **`open()` 没有流式路径(L311)。** 整个文件一次性读进内存再 `split`,全文字符串与解析后的对象峰值同时在内存里。长会话的开销落在阶段 0.3,一次会话只付一次,但它是线性于历史长度的。

12. **`version !== 3` 一律 `invalid_session`,没有迁移分支(L162)。** 配合 `list()` 吞 `invalid_session`,老格式文件的表现是「消失」而不是「报错」。

13. **`getEntry` 返回活对象、`getEntries` 只浅拷贝数组(L518、L575)。** 改了返回值 = 改了内存里的树而文件不变,重启即回滚,且中间没有任何告警。`fork` 之后两份会话在内存里共享条目对象(全景篇 §7 已记)。

14. **同一个文件被两个 storage 实例同时写没有任何检测(§8 的类说明)。** 这个类的读全部走内存缓存,别的进程往同一个文件追加时,这里的内存就是脏的,而且两边都会继续 append,最终文件里两条链交错。桌面端靠「只 fork 一个内核进程」保证唯一写者(见仓库 `CLAUDE.md`),但那是宿主纪律,不是本文件的保护。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/agent/src/harness/types.ts` | `FileSystem` / `SessionStorage` / `SessionTreeEntry` / `LeafEntry` / `JsonlSessionMetadata` 五个类型,加 `SessionError` / `toError` 两个值 |
| 它 import | `packages/agent/src/harness/session/repo-utils.ts` | `getFileSystemResultOrThrow` —— Result 世界 → throw 世界的唯一适配边界 |
| 它 import | `packages/agent/src/harness/session/uuid.ts` | `uuidv7()`;这里只用它的随机尾 8 字符 |
| import 它 | `packages/agent/src/harness/session/jsonl-repo.ts` | 唯一的生产调用方:`create` / `open` / `fork` 里 new 这个类,`list` 里调 `loadJsonlSessionMetadata` |
| import 它 | `packages/agent/src/index.ts` | `export *` —— 这个类是 `@yoma/my-pi` 的公共 API,宿主可以直接 new |
| import 它 | `packages/agent/test/harness/storage.test.ts`、`test/harness/session.test.ts` | `JsonlSessionStorage` 那个 describe 有 12 个用例(整文件 18 个,另 6 个测内存实现),钉住 header/条目校验、leaf 重放、标签、快路不读全文 |
| 对照实现 | `packages/agent/src/harness/session/memory-storage.ts` | 同接口的内存实现;`updateLabelCache` / `buildLabelsById` / `generateEntryId` / `leafIdAfterEntry` 四个函数是**两份手写重复**,改一处必须改两处 |
| 唯一上层 | `packages/agent/src/harness/session/session.ts` | 只经 `SessionStorage` 接口用它;条目的 `id` / `parentId` / `timestamp` 全在那边填 |
| 能力提供方 | `packages/agent/src/harness/env/nodejs.ts` | `FileSystem` 的唯一实现;`readTextLines` 的 `maxLines` 早停就是快路省下的那笔钱 |
| 下游代价 | `packages/kernel/src/ids.ts` | 桌面端因为本文件的短 id 不可排序,另铸了一套可排序 id |

## 7. 自测题

**1.** 把 §11 `appendEntry` 里的落盘(L502–L505)挪到三行内存更新(L506–L512)**之后**,功能测试还会全绿吗?线上会怎么坏?

<details><summary>答案</summary>

会全绿 —— `test/harness/storage.test.ts` 里没有一个用例让 `appendFile` 失败。坏的是失败路径:写盘失败时异常照样抛出去,但内存里这条条目已经进了 `entries` / `byId`、光标也推进了。于是当前进程继续把它当成历史的一部分(后续条目的 `parentId` 会指向一条**文件里不存在**的条目),而下次 `open()` 会把这段全部推翻 —— 症状是「重启之后少了几轮对话,而且当时没有任何报错」。同样的道理适用于 `setLeafId`(L473 vs L477–L480)。
</details>

**2.** 如果把 `setLeafId` 改成只做 `this.currentLeafId = leafId`(不追加 `leaf` 条目),什么时候才看得出问题?

<details><summary>答案</summary>

当前进程内**完全看不出来** —— `getLeafId` / `getPathToRoot` 全是查内存,行为一致,所有内存类断言都会通过。问题只在**重开文件**时出现:`loadJsonlStorage` 靠逐行套用 `leafIdAfterEntry` 恢复光标,没有 `leaf` 条目就只能落到「最后一条条目」。于是用户把光标挪回中间某条消息、关掉 app 再打开,光标又跳回了最新那条 —— 而且他前一次 `moveTo` 之后追加的分支还在文件里,顺序看起来是乱的。这就是「光标必须是数据」这个设计的全部理由。
</details>

**3.** 有人手工在会话文件**中间**插了一个空行,又在**开头**插了一个空行。分别会发生什么?

<details><summary>答案</summary>

中间插空行:`open()` 正常(L315 的 `filter` 吃掉了它),`list()` 也正常;唯一的影响是此后若有条目行损坏,`invalidEntry` 报的行号比真实行号小 1(L327 的 `i + 1` 数的是过滤后的序号)。

开头插空行:`open()` 依然正常(过滤后 header 仍是 `lines[0]`),但 `loadJsonlSessionMetadata` 读的是**物理第一行**(L286 的 `maxLines: 1`),拿到空串 → `line?.trim()` 为假 → 抛 `invalid_session`;而 `repo.list()` 恰好吞这一种 code,于是这个会话从列表里消失了,尽管它完全可用。
</details>

**4.** `getEntries()` 返回 `[...this.entries]`。既然只是浅拷贝、元素照样能被外部改,为什么还要拷这一层?

<details><summary>答案</summary>

拷的是**数组身份**,防的是结构性破坏:调用方拿到内部数组后 `push` / `splice` / `sort`,会让内存里的条目顺序与文件里的物理顺序不一致 —— 而 `open()` 重放依赖的正是物理顺序,于是「本进程看到的树」和「重启后看到的树」不同。元素级的共享是有意保留的:`repo.fork()`(`jsonl-repo.ts` 的 `fork()`)要拿这些对象原样重放进新文件,深拷贝一遍纯属浪费。代价写在 §5 第 13 条。
</details>

**5.** 把 `generateEntryId` 的 `uuidv7().slice(-8)` 改成 `uuidv7().slice(0, 8)`(取前 8 位),会发生什么?

<details><summary>答案</summary>

id 会变成「按时间可排序」的 —— 但同时**几乎必然撞车**。uuidv7 的前 8 个十六进制字符是 48 位毫秒时间戳的**高 32 位**(`uuid.ts` 的 `bytes[0..3]`),每 65536 毫秒才变一次 —— 也就是说约一分钟内铸出来的 id 前 8 位全都一样,连续 append 的条目会一路撞到 100 次上限,然后每条都退化成完整 36 字符 uuid(L112)。也就是说改完之后,短 id 这条路基本作废,同一会话里绝大多数条目 id 变成 36 字符。这正是 L106 那句原作者注释「uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部」的来历。想要「可排序又不撞」,得像 `packages/kernel/src/ids.ts` 那样自己拼「时间戳 + 计数器 + 随机尾」。
</details>
