# packages/agent/src/harness/session/repo-utils.ts

> **档位** A(逐行) · **行数** 163(加注释前 53) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3「第三组:会话外壳与会话树」(Repo / Storage 两层抽象、fork 与 LCA)、§4 阶段 0.3、§5.2 接线表最后两行、§6.1「会话树与持久化」 · **索引** [README](../README.md)

> 本文里带 `L` 前缀的行号一律指**本文件加注释之后**的真实行号;引用别的文件时只写符号名,不写行号 —— 那些文件也在陆续加注释,行号会漂。

## 1. 一句话

JSONL 版与内存版两套会话仓库(`SessionRepo`)共用的五个小工具:铸会话 id、盖时间戳、把 `SessionStorage` 包成 `Session` 门面、把 `FileSystem` 的 `Result` 失败翻译成 `SessionError`,以及 fork 时「该搬哪些条目」的全部规则。

## 2. 它在全景里的位置

先把三个名词摆平(第一次见的话):**会话(session)** 在这套内核里不是一个消息数组,而是一棵**条目树**,每条消息、每次换模型、每次压缩都是树上一个只追加、永不删改的**条目(entry)**;**Storage** 负责「一个会话怎么读写」;**Repo** 负责「一堆会话怎么建 / 列 / 开 / 删 / fork」。本文件就住在 Repo 这一层的正下方,是两套 Repo 实现(`jsonl-repo.ts` 落盘、`memory-repo.ts` 内存)之间唯一共享的代码。

对着全景篇 §4 的编号时间线看,它主要落在**阶段 0「装配」的第 0.3 步**:宿主要么 `repo.create({cwd})` 建一个新会话文件,要么 `repo.open(meta)` 打开旧的。`create()` 这条路全程经过本文件,`open()` 只借最后一步(而且只有 JSONL 版:`InMemorySessionRepo.open()` 是查 Map 拿回**同一个** `Session` 对象,压根不碰本文件)—— `createSessionId()` 铸出会话 id(桌面端的 `SessionManager` 调 `repo.create({cwd: directory})` 时不带 id,所以真正决定会话身份的就是这一行),`createTimestamp()` 盖时间戳,`toSession()` 把存储包成 `Session` 交给上层。**阶段 1 第 3 步**的 `createTurnState()` 之后就与本文件无关了:那一步读的是 `Session.buildContext()`,走的是存储的内存索引,不碰磁盘。

但有一个例外必须记住:`getFileSystemResultOrThrow()` **不只在装配期跑**。全景篇 §4 第 11 步「`handleAgentEvent` 收到 `message_end` 就 `session.appendMessage()` 先落盘」,以及轮末 `flushPendingSessionWrites()` 的每一次串行写,最终都走到 `JsonlSessionStorage.appendEntry()` → `fs.appendFile()`,而那一步的失败正是由本文件这个函数翻译成 `SessionError` 抛出来的。所以它在**写入热路径**上,是全景篇 §5.2 接线表里「`FileSystem` 方法一律返回 Result 永不 throw,由 `repo-utils.ts` `getFileSystemResultOrThrow` 转成 SessionError」这条接线的兑现处。

不存在会怎样?功能上不会缺东西 —— 五个函数都能内联回两个 repo 里,代价是:`getFileSystemResultOrThrow` 的翻译规则要在 `jsonl-repo.ts` 与 `jsonl-storage.ts` 里各抄一遍(错误码一旦抄歪,「会话不存在」与「存储坏了」就再也分不开,而且没有任何地方会报出来);fork 的 before/at 规则要在两套 repo 里各写一遍,而它们**必须同解**,否则「桌面端 fork 出来的会话和测试里的不一样」这种问题,类型系统一点都抓不到。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–L17 | 块注释:职责、全景位置、分节索引 |
| §1 | L18–L35 | 导入:`Result`/`FileError`(不抛的世界)与 `SessionError`(抛的世界)在这里碰面;`Session` 是唯一的**值**导入 |
| §2 | L37–L60 | 会话身份:`createSessionId()`(完整 uuidv7)与 `createTimestamp()`(ISO 时间戳) |
| §3 | L62–L75 | `toSession()`:`SessionStorage` → `Session` 的唯一构造点 |
| §4 | L77–L102 | `getFileSystemResultOrThrow()`:Result → throw 的适配边界 |
| §5 | L104–L163 | `getEntriesToFork()`:fork 取材规则,`before` / `at` 两条路 |

## 4. 逐节讲解

### §1 导入(L18–L35)

`L21–L28`

```ts
import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
```

一次 import 里同时出现了两套错误约定,这不是巧合,而是本文件存在的理由。`Result<TValue, TError>`(`harness/types.ts`)是 `{ok:true, value}` 与 `{ok:false, error}` 的联合;`FileSystem` 的**每一个**方法都返回它,契约是「实现方不许抛异常、不许 reject,连意外的后端错误也要接住转成 Result」。而 `Session` / `SessionRepo` 这一层的契约正相反:失败就抛 `SessionError`。两个世界的换轨点就是 §4。

`L32`

```ts
import { Session } from "./session.ts";
```

注意这一行**没有** `type`,这是本文件唯一的值导入 —— `toSession()` 要真的 `new` 它。两个 repo(`jsonl-repo.ts`、`memory-repo.ts`)写的都是 `import type { Session }`:它们只把 `Session` 当返回类型,构造一律委托给 `toSession()`,所以只 import 类型就够了。于是「唯一持有 `Session` 运行时值」的位置就收在本文件。

别把这一条和另一件事搞混:`jsonl-repo.ts` 文件头那句「`Session` 若经 `../types.ts` 二手转口,包主入口 `index.ts` 的星号导出会产生歧义导出」讲的是**从哪个模块导入**(直接从 `./session.ts` 而不是从 `../types.ts` 转口),与 `import type` / 值导入之分无关 —— 本文件同样是从 `./session.ts` 直接导入的。

`L35`

```ts
import { uuidv7 } from "./uuid.ts";
```

同一个 `uuidv7()`,本文件与两个 storage 的用法**截然不同**:这里取完整值当会话 id,storage 的 `generateEntryId()` 取 `uuidv7().slice(-8)` 当条目 id。差别不只是长短,见 §2。

### §2 会话身份:createSessionId / createTimestamp(L37–L60)

`L46–L48`

```ts
export function createSessionId(): string {
	return uuidv7();
}
```

返回 36 字符的完整 UUIDv7。UUIDv7 的前 6 字节是毫秒时间戳(见 `uuid.ts` 里 `bytes[0..5]` 的填法),所以**会话 id 天然按创建时间字典序递增**。

这里有一个全景篇 §6.1 专门修正过的陷阱:`uuid.ts` 开头那句「ID 天然按时间排序」**只对本函数成立**。存储层的 `generateEntryId()` 是 `uuidv7().slice(-8)`,切下来的恰好是 `bytes[12..15]` 这段**纯随机尾部**,时间戳和 sequence 一位都没进去 —— 条目 id 只有 32 位纯熵、完全不可排序。读代码时把两者混为一谈,就会写出「按 id 排序时间线」这种一定会出错的代码。

两个 repo 都写成 `options.id ?? createSessionId()`(各自的 `create()` 与 `fork()` 里):调用方显式给 id 时(测试要一个可预期的 id、宿主要复用一个已知 id)不铸新的。

`L58–L60`

```ts
export function createTimestamp(): string {
	return new Date().toISOString();
}
```

一行样板,但两个调用方对它的用法**不一样**,这是读代码时最容易想当然的地方:

- `memory-repo.ts` 把它当 `metadata.createdAt` —— 这就是内存会话的创建时间本身。
- `jsonl-repo.ts` 只拿它**拼文件名**:`createSessionFilePath()` 把冒号和点替换成连字符,做成 `<时间戳>_<sessionId>.jsonl`。而真正写进文件 header 的 `timestamp` 是 `JsonlSessionStorage.create()` 里**另一次** `new Date().toISOString()`。

于是磁盘会话的「文件名时间」与「createdAt」是两次独立取样,可能差几毫秒;`JsonlSessionRepo.list()` 排序用的是 header 那份。全景篇 §6.1 把这条记为「按文件名排序与按 createdAt 排序在极端情况下可能不一致」,根源就在这两个调用点。

### §3 toSession:storage → Session 的唯一构造点(L62–L75)

`L73–L75`

```ts
export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}
```

`Session` 只依赖 `SessionStorage` 这一个接口,所以树的语义(谁挂在谁下面、什么时候推进 leaf 光标)只写一遍就同时适用于内存和磁盘 —— 这是全景篇 §3 讲的「Repo / Storage 两层抽象」最实在的收益。

单开这个一行函数有两个理由,第二个更重要:

1. 把「唯一需要 `Session` 运行时值」的位置收在本文件(见 §1 对 L32 的说明)。
2. 保证经 repo 建出来的会话一律拿**默认**的 `contextBuildOptions` —— `Session` 构造函数的第二个参数默认是 `{}`,而 repo 这条路永远不传它。

推论值得记一笔:想给某个会话挂自定义的 `entryTransforms` / `entryProjectors`(比如让某种 `custom` 条目也进模型上下文),走 repo 这条路是给不了的,只能自己 `new Session(storage, options)`。

### §4 getFileSystemResultOrThrow:Result → throw 的适配边界(L77–L102)

`L85–L86`、`L93`

```ts
export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
```

`FileErrorCode` 有 8 种(`aborted` / `not_found` / `permission_denied` / `not_directory` / `is_directory` / `invalid` / `not_supported` / `unknown`),`SessionErrorCode` 有 6 种(`not_found` / `invalid_session` / `invalid_entry` / `invalid_fork_target` / `storage` / `unknown`),两个枚举都定义在 `harness/types.ts`。它们**只有 `not_found` 同名**,所以这里没法透传,只能做一次多对一的收敛:`not_found` 单独留出来,为的是让「会话不存在」还能与「存储坏了」分开表达 —— `JsonlSessionRepo.open()` 正是用这个码表达前者。但**别把它当成已经有人在用**:全仓没有任何生产代码按 `SessionError.code` 分支(桌面端那个 `SessionNotFoundError` 是 `session-manager.ts` 自己查表查不到时另造的,与本文件无关),唯一断言这个码的地方是 `test/harness/storage.test.ts`。其余七种一律压成 `storage`。

代价一并记在这:被中断的文件读(`aborted`,`NodeExecutionEnv` 的 `toFileError` 把 `ABORT_ERR` 映射成它)在上层看起来和「磁盘出问题了」一模一样。

`L98`

```ts
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
```

三件事发生在这一行:

- `message` 是调用方给的上下文(比如 `` `Failed to create session directory ${sessionDir}` ``),冒号后面接 `FileError` 自己的 message(Node 原始报错,通常已含路径)。这是**给人看的那一句**。
- 第三个参数把原始 `FileError` 当 `cause` 挂上去(`SessionError` 构造函数转成 `super(message, {cause})`)。
- 因此**结构化的 `error.path` 只活在 `cause` 里** —— `SessionError` 自己没有 `path` 字段。

桌面端要留意一条连锁反应:仓库 CLAUDE.md「会咬人的地方」第一条说 contextBridge 会把 Error 剥成一句话,`cause` 与自定义属性全丢。所以 renderer 最终只拿得到上面这句拼好的字符串,想按路径做 UI 分支是拿不到的。

`L100–L101`

```ts
	// 走到这里 result 已被 TypeScript 收窄成 { ok: true },value 一定存在。
	return result.value;
```

`Result` 是判别联合,`if (!result.ok)` 里 `throw` 之后,TypeScript 自动把剩下的分支收窄成 `{ok:true, value:TValue}`,所以这里不需要断言。

`harness/types.ts` 里还有一个更泛的 `getOrThrow()`,它直接抛原始 error、不做翻译,调用点集中在测试里。本文件这一个之所以另立门户,就是为了做上面那次**错误码翻译**加**上下文拼接**:`jsonl-repo.ts` 的 11 处、`jsonl-storage.ts` 的 5 处文件调用,全都包在它里面。

### §5 getEntriesToFork:fork 取材规则(L104–L163)

先说清楚 **fork** 在这里指什么:不是进程 fork,而是「从某个会话的某一点岔出一个新会话」。新会话是一个**独立的**会话(独立文件、独立 id),只是把源会话的一段条目重放了进去,并在 header 的 `parentSession` 里记下源文件路径。本函数只回答一个问题:**搬哪些条目**。建文件、写 header、重放,全在两个 repo 的 `fork()` 里。

`L117–L120`

```ts
export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
```

参数是 `SessionStorage` 而不是 `Session` —— 调用方传的是 `source.getStorage()`。返回值的形状要看走哪条路:**切片 fork** 返回一条 root → leaf 的链,**整份 fork** 返回的是完整追加日志(所有分支 + `leaf` 条目)。两者都是「父先于子」的顺序,但集合完全不同,而签名上看不出来(§5 第 4 条)。

`L126`

```ts
	if (!options.entryId) return storage.getEntries();
```

不给 `entryId` = **整份 fork**。`getEntries()` 返回的是「全部」条目:所有分支都在,连 `leaf` 条目(全景篇 §3:光标本身也被写成一条条目)也在。这一点有实际后果:两个 storage 在重放时都用 `leafIdAfterEntry` 推演光标(内存版在构造函数里逐条扫,JSONL 版在 `appendEntry()` 里逐条更新),`leaf` 条目被搬过去了,**新会话的光标位置就与源会话完全一致**。下面 `getPathToRoot` 那条路正相反。

另外这里是**真值判断**而不是 `=== undefined`:`entryId` 传空字符串等同于没传,会静默变成整份 fork,而不是报「条目不存在」。

`L128`

```ts
	const target = await storage.getEntry(options.entryId);
```

`getEntry` 查的是全表 `byId`,不限于当前路径 —— 所以**允许从别的分支上的条目切 fork**,这是有意的。

`L131–L133`

```ts
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
```

`invalid_fork_target` 是 `SessionErrorCode` 里专为 fork 留的码,全仓只有本函数抛过它(这里和 L149 两处)。必须当场炸:再往下就要读 `target.type`,而「悄悄 fork 出一个空会话」比报错难查得多。

`L136–L143`

```ts
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
```

`effectiveLeafId` 就是「新会话的最后一条条目」。之所以叫 leaf 而不是 target,是因为下面要拿它当 `getPathToRoot` 的起点:一条路径就是从它沿 `parentId` 一路走到根。

默认档是 `"before"`。写成 `?? "before"` 再比较,而不是直接写 `position === "at"`,效果上等价,但读代码时能一眼看出默认是哪一档 —— 而且「显式传 `undefined`」(把可选字段原样透传是很常见的写法)与「不传」在这里必须同解。

`"at"` 分支不校验条目类型:目标条目本身留在新会话里,它就是新的 leaf。用途是「从这条(可以是 assistant 回复、压缩条目、任何类型)之后接着聊」。

`L145–L154`

```ts
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
```

`"before"` 的语义是「回到发这句话之前」—— 只有 user 消息才有这个语义,所以这里硬性要求。为什么非要卡死?切在 assistant 或工具结果之前,得到的历史会以 assistant 结尾,下一次请求就成了「模型自己接着自己说」,而不是「用户重新说一遍」。

`target.parentId` 可能是 `null`(目标就是会话的第一条条目)。此时 `getPathToRoot(null)` 返回 `[]`(两个 storage 的该方法第一行都写着 `if (leafId === null) return []`),**fork 出来的是一个空会话,不报错** —— 这是有意的「从头开始,但 header 里记着 `parentSession`」。

`L162`

```ts
	return storage.getPathToRoot(effectiveLeafId);
```

只取这一条 root → leaf 的路径。两个后果:

1. 源会话上的其他分支不会被带过去,`leaf` 条目也不会(它们永远不在任何 `parentId` 链上,除非有人拿 leaf 条目的 id 当 `entryId`,见 §5 第 5 条)。
2. 返回的是**条目对象本身**、不是深拷贝 —— 这就是全景篇 §6.1「fork 是引用复制」那条的根源。

测试 `packages/agent/test/harness/repo.test.ts:14–22` 把这两条路都钉住了:会话是 `user1 → assistant1 → user2`,`fork({entryId: user2})` 得到 `[user1, assistant1]`(默认 before,取 `user2.parentId`),`fork({})` 得到三条全部。JSONL 版在同文件 `:54–64` 有一份一模一样的断言 —— 两套实现共用本函数,所以它们不可能走偏。

## 5. 会咬人的地方

- **L93:8 种文件错误码压成 2 种。** `permission_denied` / `is_directory` / `aborted` / `invalid` / `not_supported` / `not_directory` / `unknown` 全部变成 `"storage"`。想在上层区分「没权限」和「磁盘坏了」,只能去读 `error.cause.code`。
- **L98:结构化信息只在 `cause` 里。** `SessionError` 没有 `path` 字段,`FileError.path` 只能经 `cause` 取。而按仓库 CLAUDE.md,`cause` 过不了 contextBridge —— renderer 侧只剩拼好的那一句话。
- **L126:`!options.entryId` 是真值判断。** 传空字符串 `""` 会静默变成整份 fork,而不是报 `invalid_fork_target`。调用方若把 UI 上「没选中条目」表示成空串,行为看起来是对的;若表示成 `"0"` 之类的假 id 就会报错 —— 两种写法结果不一致。
- **L126 与 L162 的取材范围不对称,而且函数签名上看不出来。** 不给 `entryId` 搬的是**全部条目(所有分支 + `leaf` 条目)**,给了 `entryId` 搬的是**一条链**。因此「整份 fork」会连光标位置一起复制,「切片 fork」的光标必然落在路径最后一条。
- **L139 的 `"at"` 分支不校验条目类型,拿 `leaf` 条目的 id 去 fork 会造出一个坏会话。** `leaf` 条目的 `targetId` 可能指向另一条分支上的条目,而那条分支不在本次 `getPathToRoot` 的结果里。重放时:内存版在 `InMemorySessionStorage` 构造函数末尾的 `byId.has(leafId)` 校验里当场抛 `SessionError("invalid_session")`;JSONL 版的 `appendEntry()` **不做这个校验**,文件照写不误,直到后来某次 `getLeafId()` 才抛 `invalid_session`。实践中够不着(`leaf` 条目从不出现在任何投影里,UI 选不到),但如果你要给 fork 加入口,别把 `entryId` 直接从条目全表里取。
- **L154:`parentId === null` 时 fork 出空会话,不报错。** 对「回到第一句话之前」这个操作,用户看到的是一个空白新会话。这是设计,不是 bug,但 UI 需要自己解释。
- **L162:引用复制。** 内存版 fork 之后,源会话与新会话共享**同一批条目对象**(`getEntries()` / `getPathToRoot()` 都只是浅拷贝数组)。JSONL 版落盘的那份是独立数据,但内存里的数组元素同样共享。就地改条目对象会互相看见。
- **条目 id 原样搬过去,不重铸。** 同一个 id 在源会话与 fork 里各有一份;而条目 id 只有 32 位熵(`slice(-8)`),跨会话去重时不能把它当全局唯一。
- **【原注释易误读】L116 那句原有注释里的「Step 5」不是全景篇 §4 生命周期的第 5 步**,而是移植里程碑 M5 的 Step 5 —— `harness/types.ts` 里「SessionRepo 家族(M5 Step 5,对应 pi harness/types.ts 的同名区块)」那段注释说的是同一件事。这份仓库的注释里 `Step N` 一律是里程碑编号。
- **`repo.fork()` 在本仓库没有生产调用方。** 全仓唯一调用点是 `packages/agent/test/harness/repo.test.ts`(桌面端 `packages/kernel/src/host/session-manager.ts` 只用 `create` / `open` / `list` / `delete`)。也就是说本文件 §5 这套规则目前只被单测覆盖,没有被真实产品路径验证过 —— 要接 fork 功能时,先把上面这几条边界当作待验清单。
- **跨 fork 丢分支会让压缩投影静默出错。** 全景篇 §6.1 记着:`defaultContextEntryTransform` 里若 `firstKeptEntryId` 不在 compaction 之前的路径上,压缩点之前的条目会被**整段静默丢弃**。切片 fork(L162)正好是产生这种情况的一条路:被保留的 compaction 条目引用的 `firstKeptEntryId` 若落在没搬过来的那段上,新会话的上下文就只剩一条摘要,没有任何告警。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `harness/types.ts` | `Result` / `FileError`(不抛的世界)、`SessionError`(抛的世界;`SessionErrorCode` 只作为它的构造参数类型出现,本文件并不导入这个名字)、`SessionStorage` / `SessionTreeEntry` / `SessionMetadata` 的形状 |
| 它 import | `harness/session/session.ts` | **唯一的值导入**:`toSession()` 里真正 `new` 的那个类 |
| 它 import | `harness/session/uuid.ts` | `uuidv7()`;这里取完整值,storage 那边取 `slice(-8)` |
| import 它 | `harness/session/jsonl-repo.ts` | **五个导出全用**:`create`/`fork` 用 id 与时间戳,`create`/`open`/`fork` 用 `toSession`,11 处文件调用全包在 `getFileSystemResultOrThrow` 里,`fork` 用 `getEntriesToFork` |
| import 它 | `harness/session/memory-repo.ts` | 用四个(`createSessionId` / `createTimestamp` / `toSession` / `getEntriesToFork`;没有文件系统,不需要 `getFileSystemResultOrThrow`) |
| import 它 | `harness/session/jsonl-storage.ts` | 只用 `getFileSystemResultOrThrow`,5 处文件调用点(`loadJsonlSessionMetadata` 的 `readTextLines`、`loadJsonlStorage` 的 `readTextFile`、`create` 的 `writeFile`、`setLeafId` 与 `appendEntry` 的两次 `appendFile`) |
| import 它 | `src/index.ts` | `export *` —— 五个函数都是 `@yoma/my-pi` 的公开 API(目前包外没有消费者) |
| 语义对偶 | `harness/session/memory-storage.ts` / `jsonl-storage.ts` | fork 结果由它们重放:`leafIdAfterEntry` 决定新会话的光标落在哪 |
| 上游调用 | `packages/kernel/src/host/session-manager.ts` | 桌面端唯一的 repo 使用方(`create` / `open` / `list` / `delete`,不用 fork) |

## 7. 自测题

**Q1.** 会话树是 `user A → assistant B → user C → assistant D`,leaf 在 D。`fork({entryId: C})` 与 `fork({entryId: C, position: "at"})` 各搬走哪些条目?再问:`fork({entryId: B})` 会发生什么?

<details><summary>答案</summary>

- `fork({entryId: C})`:`position` 默认 `"before"`,C 是 user 消息,校验通过,`effectiveLeafId = C.parentId = B`,于是 `getPathToRoot(B)` = `[A, B]`。D 不在里面(它不在 B 到根的路径上)。
- `fork({entryId: C, position: "at"})`:`effectiveLeafId = C`,结果是 `[A, B, C]`。
- `fork({entryId: B})`:B 是 assistant 消息,走 `"before"` 分支的类型校验(L148),抛 `SessionError("invalid_fork_target", "Entry ... is not a user message")`。想从 B 切必须显式写 `position: "at"`。

`repo.test.ts` 里 `InMemorySessionRepo` 那一例钉的就是第一种。
</details>

**Q2.** 把 L126 的 `if (!options.entryId)` 改成 `if (options.entryId === undefined)`,行为有什么变化?

<details><summary>答案</summary>

只有 `entryId` 为**空字符串**(以及理论上的 `null`,类型上不允许但 JS 调用方给得出)时才有差别:原来空串被当成「没给」,静默走整份 fork;改完之后会往下走到 `storage.getEntry("")`,必然返回 `undefined`,于是抛 `invalid_fork_target`。

哪个对取决于调用方约定 —— 但这是**行为变更**,而且现有测试一条都测不到(测试要么给真 id,要么整个 options 不带 `entryId`)。
</details>

**Q3.** 为什么 L93 不直接把 `result.error.code` 透传给 `SessionError`,非要做一次三目收敛?

<details><summary>答案</summary>

因为两个枚举根本不是同一套:`FileErrorCode` 有 8 个值,`SessionErrorCode` 有 6 个,交集只有 `not_found`。直接透传编译期就红(`FileErrorCode` 不能赋给 `SessionErrorCode`)。

更深一层的理由是分层:`SessionError.code` 是给**会话层**调用方分支用的词汇(会话不存在 / 文件格式非法 / 条目非法 / fork 目标非法 / 存储故障),文件系统的 `is_directory`、`not_supported` 这类码对会话层没有意义。代价是分辨力的损失,原始码保留在 `cause` 里。
</details>

**Q4.** 为什么「整份 fork」出来的新会话光标位置和源会话一致,而「切片 fork」不一定?

<details><summary>答案</summary>

因为两条路取的条目集合不同。整份 fork 走 `getEntries()`,把 `leaf` 条目(`setLeafId` 追加的那种 `{type:"leaf", targetId}`)也搬了过去;重放时 `leafIdAfterEntry` 见到 `leaf` 条目就把光标指向它的 `targetId`,于是源会话最后一次光标移动被原样复现。

切片 fork 走 `getPathToRoot()`,而 `leaf` 条目永远不在任何 `parentId` 链上,一条都不会出现在结果里;重放完光标就停在路径的最后一条 —— 也就是 `effectiveLeafId` 那条。
</details>

**Q5.** 如果把 L162 改成返回深拷贝(`structuredClone`),会修好什么、代价是什么?

<details><summary>答案</summary>

会修掉全景篇 §6.1 记的「fork 是引用复制」:内存版 fork 之后两个会话不再共享条目对象,谁就地改都不会互相看见。JSONL 版本来落盘就是独立数据,受影响的只是内存里那份数组。

代价有三个:fork 大会话时多一次全量克隆(会话可能有几千条条目,每条带完整消息内容);`structuredClone` 遇到函数会直接抛 `DataCloneError`(类实例不抛,但会被降级成没有原型的普通对象),条目里若将来塞进非纯数据就要重新掂量;以及**现有测试察觉不到这次改动**(`repo.test.ts` 只比对 id 数组),所以它是个「改了也没人验证」的位置 —— 真要改就得先补一条断言对象身份的测试。
</details>
