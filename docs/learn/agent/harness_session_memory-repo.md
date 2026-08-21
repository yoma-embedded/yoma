# packages/agent/src/harness/session/memory-repo.ts

> **档位** B(分段) · **行数** 110 · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3(第三组:会话外壳与会话树,"Repo / Storage 两层抽象" / "fork 与 LCA")、§6.1、§7 · **索引** [README](../README.md)

## 1. 一句话

`InMemorySessionRepo` 是 `SessionRepo` 接口的内存实现——把"一堆会话怎么建 / 开 / 列 / 删 / fork"这件事纯粹存进一个 `Map<string, Session>`,不落盘,只给测试和"没有文件系统"的场景(比如浏览器)用。

## 2. 它在全景里的位置

先解释两个前置名词。**Session**(`session.ts`)是会话树的门面对象,内部持有一个 **SessionStorage**——"一个会话怎么读写"的接口(`getEntry` / `appendEntry` / `getPathToRoot` 等)。**SessionRepo** 则是更外一层的接口,管的是"一*堆*会话怎么建 / 打开 / 列出 / 删除 / fork",它内部会去 new 一个具体的 `SessionStorage` 实现,再用 `toSession()` 包成 `Session` 返回。这两层各有两套实现:落盘的 `JsonlSessionStorage` + `JsonlSessionRepo`(生产用),和内存的 `InMemorySessionStorage` + `InMemorySessionRepo`(本文件,测试/浏览器用)。

关键的一点是:**`AgentHarness` 本身完全不知道 `SessionRepo` 的存在**。全景篇 §4 的生命周期里,harness 拿到的构造参数直接就是一个 `Session` 对象(`AgentHarnessOptions.session`),至于这个 `Session` 是谁、怎么建出来的——用 `JsonlSessionRepo.create()` 从磁盘建的,还是用本文件的 `InMemorySessionRepo.create()` 在内存里建的——harness 一概不关心。也就是说本文件**不在"一次 prompt 从进内核到落盘"这条主链路上**,它是主链路*之外*、"会话从哪来"这一层的两个可插拔实现之一。全景篇 §7 推荐阅读顺序里明确把它标为可跳过项:"与 `jsonl-repo.ts` 一一对照扫一遍即可"。

它的实际使用方有两处:1) `test/harness/repo.test.ts` 直接测试 `SessionRepo` 契约本身(增删查改与 fork 语义);2) 经 `packages/agent/src/index.ts` 的 barrel 导出(`export * from "./harness/session/memory-repo.ts"`),使得任何消费 `@yoma/my-pi` 包根导出、但没有 Node `fs` 能力的环境(典型是浏览器打包)也能拿到一个可用的 `SessionRepo` 实现——这也是 `index.ts` 能保持"浏览器安全"的原因之一,`JsonlSessionRepo` 依赖 `FileSystem`,做不到这一点。

如果这个文件不存在会怎样:测试里想验证 `SessionRepo` 的通用语义(fork 取材规则、not_found 语义等)就必须每次都起一个真实文件系统 fixture,而浏览器场景则完全没有可用的仓库实现——`InMemorySessionStorage` 虽然还在,但没有一层把它包装成"建 / 开 / 列 / 删 / fork 一堆会话"的对象。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L34 | 文件头三行原始注释 + 新增的职责/分节块注释 + import + 类声明与唯一字段 `sessions` |
| §2 | L35–L79 | `create` / `open` / `list` / `delete` 四个方法,直接对应 Map 的增 / 查 / 遍历 / 删 |
| §3 | L80–L110 | `fork`:委托 `repo-utils.ts` 的 `getEntriesToFork` 取材,再建一个独立的新会话 |

## 4. 逐节讲解

### §1 类与状态(L1–L34)

```ts
export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	private sessions = new Map<string, Session<SessionMetadata>>();
```

`SessionRepo<TMetadata, TCreateOptions, TListOptions>` 是一个三参数泛型接口(定义见 `harness/types.ts:526-539`)。这里三个类型参数分别钉死成:`SessionMetadata`(裸的 `{id, createdAt}`,不像 `JsonlSessionMetadata` 那样带 `cwd`/`path`)、`{ id?: string }`(建会话时只能指定 id,没有 `cwd` 这种落盘专属参数)、`void`(`list()` 不接受任何过滤条件)。这三个选择共同说明了一件事:**内存实现没有"目录"这个维度**,所有会话平铺在同一张全局表里。

字段只有一个:`sessions: Map<string, Session<SessionMetadata>>`。要特别注意它存的**不是**一个可以重建 Session 的元数据描述符,而是**已经构造好的 `Session` 对象本身**。这个选择直接决定了 §2 里 `open()` 的语义——继续往下看。

### §2 create / open / list / delete(L35–L79)

```ts
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
```

`create()` 三步走:铸 metadata(`id` 缺省用 `createSessionId()`,内部就是 `uuidv7()`——注意这是完整 36 字符的 session id,和条目 id 取尾 8 字符是两回事)→ 用一个空 `InMemorySessionStorage` 包一个新 `Session` → 存进 Map。没有目录创建、没有任何 I/O,是纯内存对象图搭建。**没有唯一性校验**:如果调用方传入一个已存在的 `id`,`Map.set` 会直接覆盖旧会话——这与 `JsonlSessionRepo` 那边"同名文件直接覆盖写"是同一类"不做防重复保护"的行为,两边一致,不是本文件独有的疏漏。

```ts
async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
	const session = this.sessions.get(metadata.id);
	if (!session) {
		throw new SessionError("not_found", `Session not found: ${metadata.id}`);
	}
	return session;
}
```

这是全文件**最容易被想当然理解错**的一个方法。它按 `metadata.id` 查表,查不到抛 `SessionError("not_found", ...)`。表面上看和 `JsonlSessionRepo.open()` 语义相同,但底层差异很大:**`InMemorySessionRepo.open()` 返回的是 Map 里存的同一个 `Session` 对象引用**,不是重新构造出来的。而 `JsonlSessionRepo.open()` 每次都会重新 `readTextFile` 整个文件、重放条目、构造一份全新的 `JsonlSessionStorage` 和 `Session`。

后果是:如果你对同一个内存会话调用两次 `open()`,拿到的是**同一个对象**,对其中一个引用 `appendMessage()` 会立刻反映到另一个引用上(它们本来就是同一个东西);而两次 `JsonlSessionRepo.open()` 拿到的是两个**独立**的对象,一边写了另一边看不到,除非重新 `open()`。测试 `test/harness/repo.test.ts:17` 专门用 `expect(await repo.open(metadata)).toBe(session)` 钉住了这个"同一引用"的行为,不要在读代码时把它当成巧合。

```ts
async list(): Promise<SessionMetadata[]> {
	return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
}
```

`Map` 的迭代顺序就是插入顺序,所以 `list()` 天然按创建先后返回,不需要额外排序。对比 `JsonlSessionRepo.list()` 要扫目录、读每个文件的 header 行——这里就是遍历一次内存表。

```ts
async delete(metadata: SessionMetadata): Promise<void> {
	this.sessions.delete(metadata.id);
}
```

`Map.delete()` 对不存在的 key 直接返回 `false`、不抛错,这里的返回值也没人看。它与 `JsonlSessionRepo.delete()` 内部用 `remove(path, { force: true })` 达成的"删一个不存在的文件也不报错"是同一种语义,两边对齐,不是本文件独有的宽松。换句话说:**`delete()` 不能被用来判断"这个会话是否存在过"**。

### §3 fork(L80–L110)

```ts
async fork(
	sourceMetadata: SessionMetadata,
	options: { entryId?: string; position?: "before" | "at"; id?: string },
): Promise<Session<SessionMetadata>> {
	const source = await this.open(sourceMetadata);
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
```

`fork()` 做的事分两步,而且这两步是**解耦**的:第一步"决定新会话该有哪些条目"完全委托给 `repo-utils.ts` 的 `getEntriesToFork(storage, options)`(取材规则见 [`harness_session_repo-utils.md`](./harness_session_repo-utils.md),简述:`position: "at"` 含目标条目本身,默认的 `"before"` 要求目标必须是一条 user 消息、取它的 `parentId` 往上收集);第二步才是"把取到的条目材料包成一个新会话",这一步和 `create()` 几乎一模一样,只是 `InMemorySessionStorage` 的构造参数多了一个 `entries`。

它先调用 `this.open(sourceMetadata)` 而不是直接查 `Map`,好处是"源会话不存在"这个错误会先在 `open()` 里以统一的 `not_found` 形式抛出,不用在 `fork()` 里再写一遍判空逻辑。

与 `JsonlSessionRepo.fork()` 相比,`options` 的**必填**字段少了 `cwd`(`JsonlSessionCreateOptions` 还带 `parentSessionPath?`/`metadata?` 两个可选字段,内存版同样没有,但那两个本来就不强制传)——落盘版的新会话要知道存进哪个目录,内存版没有目录这个维度,新会话和源会话共处同一张全局 `Map`。

**取材出来的条目是引用共享的,不是深拷贝**:`getEntriesToFork` 内部按 `entryId` 是否给出走两条不同的路——不给 `entryId` 时直接 `storage.getEntries()`(返回 `[...this.entries]`),给了则 `storage.getPathToRoot(leafId)`(用 `unshift` 组一个**新数组**);但不管走哪条路,数组里的每个 `SessionTreeEntry` 对象与源会话 `InMemorySessionStorage` 内部 `entries`/`byId` 持有的都是**同一个对象引用**——两个方法都只新建了外层数组,没有逐条目拷贝。而新会话这边,`InMemorySessionStorage` 的构造函数同样只对数组做了一层 `[...entries]` 浅拷贝(`memory-storage.ts:125`),没有深拷贝条目本身,于是这份共享引用被原样带进了新会话。目前这样做是安全的,因为全仓没有任何代码会"原地修改一条已经 append 过的 entry"(只增不改,见全景篇"投影不是历史"一节的同一条纪律),但这是一份**约定**而不是类型系统能保证的东西。详见下一节。

## 5. 会咬人的地方

- **`open()` 返回同一个对象引用,`JsonlSessionRepo.open()` 每次重新构造**(L60–L66,详见 §2)。两套实现名义上满足同一个接口,但"两次 open 拿到的是不是同一个对象"这条隐含语义完全相反。如果写测试或写应用代码时假设了其中一种行为,换到另一套实现下会静默出错(不会抛异常,只是"写了却读不到"或者反过来"以为独立其实共享")。
- **`fork()` 的取材条目是引用共享**(L100,详见 §3 最后一段)。安全性建立在"条目只增不改"这条全仓纪律上,不是类型层面的保证——这与全景篇 §6.1「fork 是引用复制」条目描述的是同一类风险,只是内存实现里连"新文件独立"这一层保护都没有(JSONL fork 至少写进了物理上独立的新文件)。
- **`delete()` / `create()` 都不做存在性 / 唯一性校验**(L76–L78、L41–L50)。这与 `JsonlSessionRepo` 同名方法的宽松程度一致,不是本文件独有,但两处都容易被想当然地认为"删不存在的会话该报错"或"重复 id 该报错"。
- **没有发现与已有注释、全景篇或 CLAUDE.md 不符之处**——本文件逻辑简单、原有头部注释("对应 pi harness/session/memory-repo.ts,逐字移植")与实际代码一致,故本节没有【与注释不符】/【与 CLAUDE.md 不符】条目。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `../types.ts` | `SessionError`、`SessionMetadata`、`SessionRepo` 三个契约类型 |
| 它 import | `./memory-storage.ts` | `InMemorySessionStorage`——真正持有条目树的内存实现 |
| 它 import | `./repo-utils.ts` | `createSessionId` / `createTimestamp` / `getEntriesToFork` / `toSession` 四个共享小工具 |
| 它 import | `./session.ts` | `Session` 类型(门面对象) |
| import 它 | `packages/agent/src/index.ts` | barrel 导出,使其对包外可见、且保持浏览器安全 |
| import 它 | `packages/agent/test/harness/repo.test.ts` | 唯一的测试消费方,同一文件里还并排测试 `JsonlSessionRepo` 便于对照 |
| 语义对照 | `./jsonl-repo.ts` | 同一个 `SessionRepo` 契约的落盘实现,本文档多处与它逐点对比 |

## 7. 自测题

1. 对同一个 `InMemorySessionRepo` 实例,先 `const a = await repo.open(metadata)`,再 `const b = await repo.open(metadata)`,`a === b` 吗?换成 `JsonlSessionRepo` 呢?为什么会不一样?

<details><summary>答案</summary>

内存版 `a === b` 为 `true`——`sessions` 这张 Map 里存的就是已经造好的 `Session` 对象,`open()` 只是查表返回同一个引用。`JsonlSessionRepo.open()` 则每次都重新 `readTextFile` 整个 `.jsonl` 文件并重放,构造一份全新的 `JsonlSessionStorage`/`Session`,所以 `a === b` 为 `false`,即便两者内容(此刻)完全一致。

</details>

2. 如果给 `fork()` 传一个 `sourceMetadata` 对应的会话根本不存在于 `sessions` 这张 Map 里,会发生什么?错误从哪一行、哪个方法抛出来?

<details><summary>答案</summary>

`fork()` 第一行就是 `const source = await this.open(sourceMetadata)`,`open()` 内部查不到会 `throw new SessionError("not_found", ...)`。所以错误在 `open()` 里抛出,`fork()` 自己完全不需要写判空逻辑——这是它复用 `open()` 而不是直接查 `Map` 的设计意图。

</details>

3. `fork()` 建出来的新会话,如果之后有代码"就地"修改了新会话某条 entry 的字段(比如给一条 `label` entry 直接赋值改 `label` 属性,而不是走 `appendEntry` 追加新条目),源会话会不会受影响?为什么?

<details><summary>答案</summary>

会受影响。`getEntriesToFork` 返回的数组虽然是新 `unshift` 出来的,但数组里的条目对象与源会话内部 `entries`/`byId` 持有的是同一个引用(`InMemorySessionStorage` 构造时只对数组做浅拷贝,没有深拷贝条目本身)。目前全仓代码遵守"条目只增不改"的纪律所以没暴露问题,但类型系统并不阻止这种就地修改——一旦有代码破了这条纪律,源会话和它所有的 fork 会一起被污染。

</details>

4. `InMemorySessionRepo` 实现的 `SessionRepo<SessionMetadata, { id?: string }, void>` 里,第三个类型参数为什么是 `void` 而不是像 `JsonlSessionRepoApi` 那样传一个带 `cwd` 的选项类型?这对 `list()` 的行为有什么直接影响?

<details><summary>答案</summary>

`JsonlSessionListOptions` 里的 `cwd` 对应磁盘上"按目录分区存放会话"这件事;内存实现根本没有目录概念,所有会话平铺在同一张 `Map` 里,没有可过滤的维度,所以 `TListOptions` 直接钉成 `void`。直接后果是 `InMemorySessionRepo.list()` 不接受任何参数,永远返回全部会话——想要"只列某一批"就得自己在拿到结果后过滤,仓库这一层不提供。

</details>

5. 为什么 `create()` 和 `fork()` 里铸新 id 都写成 `options.id ?? createSessionId()`,而不是要求调用方必须显式传 `id`?这样设计对"两次调用不传 id 的 `create()`"会不会产生冲突?

<details><summary>答案</summary>

`??` 让 `id` 变成可选参数,方便测试和临时会话不必关心 id 具体是什么;两次不传 `id` 的 `create()` 不会冲突,因为 `createSessionId()` 内部调用 `uuidv7()`,产出的是完整 36 字符、以时间戳为前缀外加随机分量的 UUID,现实中两次调用撞车的概率可以忽略——这与条目 id(`generateEntryId()`,只取 8 字符纯随机尾部、专门在 `memory-storage.ts` 里做了显式查重循环)刻意留了查重逻辑形成对比:会话 id 空间大到不需要查重,条目短 id 空间小到必须查重。

</details>
