# packages/agent/src/harness/session/memory-storage.ts

> **档位** B(分段) · **行数** 262 · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §3 第三组「会话外壳与会话树」、§4 阶段 0.3 / 步骤 3a · **索引** [README](../README.md)

## 1. 一句话

`SessionStorage` 接口的纯内存实现——不落盘、不做 JSONL 重放,把"条目 = 树节点、leaf = 游标"这套会话树模型第一次完整地摆在你面前,是全景篇建议的入口文件。

## 2. 它在全景里的位置

会话不是一个消息数组,而是一棵**只追加**的树:每条历史动作(发消息、换模型、打标签、甚至"把光标挪到别处")都是一条带 `{type, id, parentId, timestamp}` 的条目,`SessionStorage` 接口定义了"一个会话怎么读写"这十个方法。本文件是这个接口两套实现之一——另一套是生产用的 `jsonl-storage.ts`(落盘 + 逐行重放)。两者接口完全一致,`Session` 类(`session.ts`)只依赖 `SessionStorage`,完全不知道底下是内存还是磁盘。

在全景篇 §4 的生命周期编号里,本文件对应**阶段 0.3**(建/开会话:`repo.create()` / `repo.open()`)与**阶段 1 步骤 3a**(`session.getBranch()` → `storage.getLeafId()` → `storage.getPathToRoot()`,取出 root→leaf 的完整路径喂给 `buildContext()`)。但要注意:桌面端与 ACP 走的都是 `jsonl-storage.ts`,`InMemorySessionStorage` **不在任何一次真实 prompt 的执行路径上**——生产代码里只有一处 `new`:`memory-repo.ts` 的 `InMemorySessionRepo`(`create`/`fork` 两个方法各建一次;`open` 不建,见 §6)。测试侧直接 `new` 出来用的有四处:`packages/agent/test/harness/session.test.ts`(跑会话树的公共测试套件 `runSessionSuite`)、`storage.test.ts`(本文件自己的单测)、`agent-harness.test.ts`、`agent-harness-stream.test.ts`(后两者把它当 harness 测试的存储桩用,不是在测存储本身)。

它存在的价值不是"生产要用",而是"读它最快学会树语义"。`jsonl-storage.ts` 的 `open()` 要在"逐行重放 JSONL"这件事之外,同时处理文件系统的 `FileSystem` 抽象、header 解析、行级 JSON 校验——真正的树逻辑(`appendEntry` 只做三件事、`setLeafId` 为什么要追加一条条目而不是直接赋值、`leafIdAfterEntry` 怎么推进游标)被这些细节盖住了。本文件把这三点从磁盘噪音里剥离出来,`generateEntryId` / `leafIdAfterEntry` / `updateLabelCache` 三个模块级函数在 `jsonl-storage.ts` 里有独立的一份复刻(**没有 import 关系,是两份手写的重复代码**),读完这里再读 jsonl-storage.ts,会发现它其实就是"同一套逻辑 + 文件 I/O"。

不存在的话会怎样:测试和 `InMemorySessionRepo` 得直接依赖 `jsonl-storage.ts`,意味着每个单测都要起临时目录、走真实文件系统——这正是全景篇反复强调的"两层抽象"收益(`SessionStorage` 与 `SessionRepo` 各有 JSONL/InMemory 两套实现,`Session` 类的树语义只写一遍)在测试侧的体现。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–40 | 文件头总述(原作者三点设计 + 本次补充的职责/位置/分节索引)、导入 |
| §2 | L42–70 | label 缓存维护:`updateLabelCache` / `buildLabelsById` |
| §3 | L72–86 | 生成条目 id:`generateEntryId` |
| §4 | L88–99 | leaf 推进规则:`leafIdAfterEntry` |
| §5 | L101–142 | `InMemorySessionStorage`:五个私有字段(四管树状态 + `metadata`) + 构造函数(两种用法:空会话 / 按 entries 重放) |
| §6 | L144–162 | 元数据与 leaf 读取:`getMetadata` / `getLeafId` |
| §7 | L164–208 | 写入三件套:`setLeafId` / `createEntryId` / `appendEntry` |
| §8 | L210–231 | 按 id / 类型 / 标签查询:`getEntry` / `findEntries` / `getLabel` |
| §9 | L233–262 | 树遍历:`getPathToRoot` / `getEntries` |

## 4. 逐节讲解

### §1 文件头与导入(L1–40)

文件顶部有两层注释:L1–6 是原作者留下的三点设计纪要(完整条目、leaf 是追加而非赋值、`leafIdAfterEntry` 的两种推进规则),L7–30 是本次补充的块注释,写清楚职责、全景链路位置、对应学习文档路径与九节索引。

导入的五个名字都来自 `../types.ts`(即 `harness/types.ts`,不是本目录下的文件——`packages/agent/src/harness/session/` 目录里没有 `types.ts`,类型总仓在上一级),但不是五个都是"类型":`LeafEntry` / `SessionMetadata` / `SessionStorage` / `SessionTreeEntry` 四个带 `type` 前缀,纯类型导入;`SessionError` 没有 `type` 前缀,是**值导入**——它是一个 `extends Error` 的类(`harness/types.ts:127`),本文件多处 `throw new SessionError(...)` 需要在运行时真的把它当构造函数调用,写成 `type SessionError` 会编译失败。`uuidv7` 来自同目录的 `uuid.ts`。

### §2 label 缓存维护(L42–70)

```ts
L53–61
function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId); // 空 label = 删除标签,"latest label wins"
	}
}
```

`LabelEntry`(`harness/types.ts`)是"给某个条目打标签"的历史记录,`label` 字段类型是 `string | undefined`。这个函数把"一条 label 条目"翻译成"对 `labelsById` 缓存的一次增量更新":非空标签写入,空标签(包括 trim 后为空串)删除。因为标签本身也是追加日志的一部分(不能改历史),"重命名标签"和"删除标签"都表现为再追加一条新的 label 条目,`updateLabelCache` 按条目原始顺序依次调用就天然实现了"最后一条赢"(latest label wins)。

`buildLabelsById` 是它的批量版本,只在构造函数里用一次,从传入的 `entries` 数组重建整份缓存。

### §3 生成条目 id(L72–86)

```ts
L79–86
function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		// uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部。
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}
```

条目 id 不用完整的 uuidv7(36 字符),而是截断成尾部 8 个十六进制字符——这是 `bytes[12..15]`,即 uuidv7 里**纯随机**的那一段(时间戳在 `bytes[0..5]`,sequence 在 `bytes[6..10]`,一位都没进短 id)。撞车检测靠一个只要求 `has(id)` 的最小接口,不强绑 `Map`,方便脱离 `InMemorySessionStorage` 单测这个函数本身。

参数类型 `{ has(id: string): boolean }` 而不是 `Map<string, unknown>`,是刻意收窄的接口——调用方只需要能回答"这个 id 存在吗",`InMemorySessionStorage` 传入的是 `this.byId`(一个 `Map`,天然满足这个接口)。

### §4 leaf 推进规则(L88–99)

```ts
L97–99
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}
```

这是整个文件语义最浓缩的一行。普通条目让 leaf 前进到它自己("追加即前进");`leaf` 类型的条目让 leaf 跳到它记录的 `targetId`(可能是当前位置附近,也可能是树中间的某条旧条目——对应 `Session.moveTo` 的分支切换)。`appendEntry`(§7)与构造函数的重放循环(§5)都调用这同一个函数,保证"内存版从头重建"和"内存版增量追加"对"leaf 该停在哪"给出同一个答案。

一个容易漏掉的推论:`leaf` 条目本身会被写进 `entries` 和 `byId`(能被 `getEntry` 查到、能被 `findEntries("leaf")` 找到),但因为它不满足"普通条目"的判定,**它永远不会出现在任何一条 `getPathToRoot` 的结果里**——它只是日志侧枝,记录"发生过一次跳转",不参与"当前对话内容是什么"。

### §5 `InMemorySessionStorage`:字段与构造(L101–142)

类一共五个私有字段,其中四个管树状态、各管一件事:`entries`(按写入顺序的完整日志,唯一真源)、`byId`(id → 条目的索引)、`labelsById`(当前有效标签的缓存)、`leafId`(树上唯一的游标)。后三者理论上都能从 `entries` 现算,缓存的目的是让 `getEntry` / `getLabel` / `getLeafId` 保持 O(1)。第五个字段 `metadata`(`readonly`)不算在"四个"里——它与树状态无关,构造时定死后全程不变,也不参与任何"从 entries 现算"的推导。

```ts
L124–142
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
```

两种用法:不传 `options` 建一个空会话(leaf 为 `null`,metadata 现造一份,`id` 用完整 uuidv7 而不是截断版——这是会话 id,不是条目 id,两者用途不同,全景篇 §5.2 的跨包接线表专门标注了这个区分);传 `entries` 用一段已知历史"重放"出内存状态,这是 `memory-repo.ts` 的 `fork()` 与测试套件的用法。`entries` 会被浅拷贝(`[...options.entries]`),调用方之后再改动原数组不会影响这个实例。

`for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);` 这一行看着像"只是取最后一条",但它其实是把每条历史的推进结果依次覆盖上去——效果与 `jsonl-storage.ts` 的 `open()` 逐行重放等价,只是这里数据已经在内存里,不需要真的一行行读文件。跑完之后立刻做一次校验:如果 `leafId` 不为空但在 `byId` 里查不到,说明传入的 `entries` 本身是一段断裂的历史(比如漏带了某条 leaf 条目 `targetId` 指向的条目),这时候立刻抛 `SessionError("invalid_session", ...)`,而不是留到某次 `getPathToRoot` 才炸。

### §6 元数据与 leaf 读取(L144–162)

`getMetadata()` 直接返回构造时定下的 `metadata`,内存实现里全程不变。

```ts
L157–162
async getLeafId(): Promise<string | null> {
	if (this.leafId !== null && !this.byId.has(this.leafId)) {
		throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
	}
	return this.leafId;
}
```

这段校验和构造函数里那段(L136–138)逐字重复。原因:`setLeafId`(§7)走的是校验过的路径(先查 `byId.has(leafId)` 才允许设置),但 `appendEntry` 是 `SessionStorage` 接口的公开方法,外部调用方理论上可以绕过 `setLeafId`、直接 `appendEntry` 一条 `targetId` 指向不存在条目的 `leaf` 条目——这里补一道闸门,让"读到一个悬空游标"在读的那一刻就报错,而不是让调用方拿着一个查不到的 id 继续往下传。

### §7 写入三件套(L164–208)

```ts
L176–190
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
```

`setLeafId` 不是简单赋值,而是先追加一条 `{type:"leaf", targetId:leafId}` 条目,再让内存变量跟上。落盘实现要靠这条条目在重开文件、逐行重放时恢复光标位置;内存实现本身其实不需要这一步也能"记住"leaf(变量就在那儿),但两个实现必须共用同一份语义——否则同一段 `entries` 数组在两种 storage 之间搬家(比如把内存版单测的历史喂给落盘版)会得到不同的 leaf。`parentId` 取的是**挪之前**的 leaf(而不是新目标),因为这条条目记录的是"发生了一次跳转"这件事本身。

```ts
L193–195
async createEntryId(): Promise<string> {
	return generateEntryId(this.byId);
}
```

供上层 `Session` 类在组装一条完整条目(带 `id` / `parentId` / `timestamp`)之前先要一个 id。`session.ts` 里能看到具体用法:每个 `append*` 方法都是先 `await this.storage.createEntryId()` 拿 id、`await this.storage.getLeafId()` 拿 parentId,自己拼出完整条目对象,最后才调 `appendEntry`。

```ts
L203–208
async appendEntry(entry: SessionTreeEntry): Promise<void> {
	this.entries.push(entry);
	this.byId.set(entry.id, entry);
	updateLabelCache(this.labelsById, entry);
	this.leafId = leafIdAfterEntry(entry);
}
```

这是文件头总述里第一条设计纪要的落地:`appendEntry` 收到的是"完整"条目,`id`/`parentId`/`timestamp` 都已经由调用方填好,这个方法本身**不做任何校验**——不检查 `id` 是否已存在、不检查 `parentId` 是否指向真实条目。信任调用方是有意的设计:校验属于"谁在造条目"(`Session` 类)的责任,不属于"怎么存"。四步分工清楚:压真源、建索引、推进标签缓存、推进 leaf 游标。

### §8 按 id / 类型 / 标签查询(L210–231)

`getEntry(id)` 查不到返回 `undefined`,不抛错——"条目存不存在"由调用方判断是否算错误。

```ts
L222–226
async findEntries<TType extends SessionTreeEntry["type"]>(
	type: TType,
): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
	return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
}
```

线性扫描**全部**条目,不限于当前 leaf 路径——已经离开投影的分支里的条目也会被找到。类型参数 `TType` 通过类型谓词把返回值收窄成精确的联合成员(`findEntries("session_info")` 返回的数组元素类型就是 `SessionInfoEntry`)。O(n) 扫描,内存实现没有按类型建索引,量级小(测试/浏览器)时够用。

`getLabel(id)` 直接查 `labelsById` 缓存,返回"当前生效"的标签;和 `findEntries("label")` 的区别是后者会给出**全部历史**的打标签动作(包括已经被覆盖或撤销的),前者只给"现在算数"的那一个。

### §9 树遍历(L233–262)

```ts
L243–256
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

从 `leafId` 沿 `parentId` 一路走到根(`parentId === null` 的条目),返回 `[根, ..., leafId]`——这就是全景篇说的"当前对话"/"当前分支"的完整定义。`leafId` 为 `null` 时直接返回空数组(会话还没有任何消息)。中途任意一环的 `parentId` 在 `byId` 里查不到,说明历史链本身是断的(数据损坏,或构造函数收到了不完整的 `entries`),立刻抛 `invalid_session`,不会悄悄返回一段截断的路径。用 `unshift`(而不是先 `push` 再 `reverse`)是可读性优先的选择——路径通常只有几十到几百条,`unshift` 隐含的 O(n) 数组重排在这个量级下不构成问题。

`getEntries()` 返回**完整**的追加日志(所有分支、所有 `leaf` 条目都在,不只是当前路径),浅拷贝防止调用方拿到的数组被外部修改污染内部状态。`memory-repo.ts` 的 `getEntriesToFork`(经 `repo-utils.ts`)在 `entryId` 为空时就是直接调这个方法整体复制一份会话。

## 5. 会咬人的地方

- **L79–86 `generateEntryId` 撞车 100 次后返回完整 36 字符的 uuid,而不是继续截断。** 正常路径返回 8 字符短 id,兜底路径返回完整长度——**同一个会话的 `entries` 数组里理论上可能混着两种长度的 id**。这是全景篇 §6.1「会咬人的地方」里已经点名的一条(【新】标记),读这个函数时容易以为它"总是返回 8 字符",实际上只是极大概率如此。
- **L81 的行内注释「uuidv7 前缀是时间戳」容易被读成"条目 id 也按时间可排序"——它不是。** `generateEntryId` 截取的是 `uuidv7().slice(-8)`,对应 `uuid.ts` 里 `bytes[12..15]`,是纯随机尾部,时间戳(`bytes[0..5]`)和 sequence(`bytes[6..10]`)都没进短 id。全景篇 §6.1 专门指出 `uuid.ts` 开头那句「ID 天然按时间排序」**只对完整 uuidv7(会话 id)成立,对条目 id 是错的**。前端投影器正是因为这一点才不敢直接用内核的条目 id 排序,自己另铸一套确定性 id(见全景篇 §5.2 与 CLAUDE.md「投影器」一节)。
- **L157–162 `getLeafId` 与构造函数(L136–138)有逐字重复的校验。** 不是疏忽,而是防御 `appendEntry` 绕开 `setLeafId` 直接塞入悬空 `leaf` 条目的场景(详见 §6 讲解)。改这两处逻辑时要记得同步改。
- **L203–208 `appendEntry` 不校验 `id` 唯一性、不校验 `parentId` 是否存在。** 正常调用链(`Session` 类的 `append*` 方法)总是先 `createEntryId()` 再 `appendEntry`,不会撞车;但只要有代码绕开 `Session` 直接调 `storage.appendEntry()` 传入一个已存在的 `id`,`byId.set` 会静默覆盖旧条目而不报错,树结构可能因此出现两个不同的"逻辑条目"共享同一个 id 的情况。目前仓内没有发现这样的调用方,但接口本身没有挡住它。
- 【与实现细节的轻微出入,非 bug】L240–241 的注释解释了为什么用 `unshift` 而不是 `push`+`reverse`——这是本次注释时补充的说明,不是原作者留下的取舍记录,如果后续要优化超长分支的性能,`push`+`reverse` 会更快(避免 `unshift` 的整体搬移),但当前量级下没有必要。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `../types.ts`(`harness/types.ts`) | `LeafEntry` / `SessionError` / `SessionMetadata` / `SessionStorage` / `SessionTreeEntry` 五个类型/类,契约总仓 |
| 它 import | `./uuid.ts` | `uuidv7()`,手写 UUIDv7 生成器 |
| import 它 | `./memory-repo.ts` | `InMemorySessionRepo` 的 `create`/`fork` 各 `new InMemorySessionStorage(...)` 一次;`open` **不构造**——它只是按 `metadata.id` 查 `sessions` 这张 Map,把 `create`/`fork` 时存进去的同一个 `Session` 对象引用原样返回(`memory-repo.ts:60-66`) |
| import 它(测试) | `packages/agent/test/harness/session.test.ts` | `runSessionSuite("Session with in-memory storage", () => new InMemorySessionStorage())`,与 `jsonl-storage.ts` 跑同一套公共会话树测试 |
| import 它(测试) | `storage.test.ts` / `agent-harness.test.ts` / `agent-harness-stream.test.ts` | 前者是本文件的直接单测;后两者把 `new InMemorySessionStorage()` 当 harness 测试的存储桩用(测的是 harness,不是存储本身) |
| 语义对应(无 import) | `./jsonl-storage.ts` | 同一个 `SessionStorage` 接口的落盘实现;`generateEntryId` / `leafIdAfterEntry` / `updateLabelCache` 三个函数在那边各有一份独立复刻,不是共享代码 |
| 间接协作 | `./repo-utils.ts` 的 `getEntriesToFork` | 泛型接受任意 `SessionStorage`,`fork()` 时调用本文件实例的 `getEntry` / `getPathToRoot` |
| 上层门面 | `./session.ts` 的 `Session` 类 | 只依赖 `SessionStorage` 接口本身,不知道底下是内存还是磁盘;每个 `append*` 方法都是 `createEntryId()` + `getLeafId()` 拼出完整条目后调 `appendEntry()` |

## 7. 自测题

**Q1. `setLeafId(x)` 为什么要追加一条 `leaf` 条目,而不是直接 `this.leafId = x`?在纯内存实现里,直接赋值会不会导致功能性的错误?**

<details><summary>答案</summary>

追加条目是为了和落盘实现(`jsonl-storage.ts`)共用同一份语义——磁盘上的会话文件是一份只追加的日志,重开文件时要靠逐行重放恢复 leaf 位置,如果 leaf 只活在内存变量里,重放后永远只能得到"最后一条条目"而不是用户上次真正停留的位置。

单独看内存实现,如果只是"这个进程活着、这个实例活着"的场景,直接赋值 `this.leafId = x` 在功能上确实等价(变量本身没有丢失的问题)。但一旦这个实例的 `entries` 被导出、传给另一个 `InMemorySessionStorage`(比如 `fork`),或者未来被序列化落盘,不追加条目就意味着"曾经跳转过"这件事从历史里彻底消失——`entries` 数组会和"真的发生过 setLeafId"的情况不可区分。所以这不是内存实现自己需要的功能,而是"两种实现必须对同一段 entries 给出同一个答案"这条不变式的要求。
</details>

**Q2. `findEntries("leaf")` 会返回哪些条目?这些条目会出现在 `getPathToRoot` 的结果里吗?**

<details><summary>答案</summary>

`findEntries("leaf")` 会返回 `entries` 数组里所有 `type === "leaf"` 的条目——包括每一次 `setLeafId` 调用产生的记录,不限于当前路径。但它们**不会**出现在任何 `getPathToRoot` 的结果里。原因要看"下一条真实条目的 `parentId` 从哪来":`Session` 类的 `append*` 方法用 `storage.getLeafId()` 取 parentId,而这个值是 `leafIdAfterEntry(leaf 条目)` 算出来的 `targetId`,不是 `leaf` 条目自己的 `id`。也就是说,`leaf` 条目自身的 `id` 从不被任何后续条目引用为 `parentId`,它在 `parentId` 链条上是一个"断点"——天然不会出现在任何一条从叶子往根走的路径里。
</details>

**Q3. 如果构造 `InMemorySessionStorage` 时传入的 `entries` 里,最后一条是一个 `targetId` 指向不存在条目的 `leaf` 条目,会在哪一行抛错?抛的是什么错误码?**

<details><summary>答案</summary>

会在构造函数里抛。执行顺序:先用 `entries` 建好 `byId`(不含这条 leaf 指向的那个不存在的目标,因为它本来就不存在);然后 `for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);` 跑完,`this.leafId` 被这条 leaf 条目的 `targetId` 覆盖成一个 `byId` 里查不到的值;紧接着的 `if (this.leafId !== null && !this.byId.has(this.leafId))` 命中,抛出 `new SessionError("invalid_session", ...)`。不会等到之后调用 `getLeafId()` 或 `getPathToRoot()` 才发现。
</details>

**Q4. `getLabel(id)` 和 `findEntries("label")` 都能查到"标签"信息,它们的返回结果什么时候会不一样?**

<details><summary>答案</summary>

`getLabel(id)` 查的是 `labelsById` 缓存,只反映"当前生效"的一个结果:如果同一个 `targetId` 先后被打过两次标签(比如先叫 "draft" 后改成 "final"),或者打了标签又被撤销(追加一条空 label 条目),`getLabel` 只会给出最后一次的结果(或 `undefined`)。`findEntries("label")` 返回的是**全部历史**——三条 `LabelEntry`(打 "draft"、改成 "final"、撤销)都会出现在数组里,调用方要自己按顺序推导"现在到底是什么状态"。日常场景应该用 `getLabel`;需要审计"标签改动历史"才用 `findEntries("label")`。
</details>

**Q5. 为什么 `jsonl-storage.ts` 不直接 `import { generateEntryId, leafIdAfterEntry, updateLabelCache } from "./memory-storage.ts"`,而是各自重写一份几乎一样的实现?这样做有什么代价?**

<details><summary>答案</summary>

文档里没有找到显式说明"为什么不共享"的注释,只能从代码事实推断:两个文件的这三个函数确实是相互独立、没有 import 关系的重复实现(可以用 `grep -n "generateEntryId\|leafIdAfterEntry\|updateLabelCache" packages/agent/src/harness/session/*.ts` 验证)。可能的考虑是两者各自的接口约束略有不同(比如 `jsonl-storage.ts` 的等价函数处理的是从文件里读出来的原始行,可能需要额外的错误处理),但这属于推测,不构成本文档的断言。

可以确定的代价是:这是一处需要人工保持同步的重复代码——如果 `leafIdAfterEntry` 的推进规则将来要改(比如新增一种条目类型需要特殊处理),必须**同时改两个文件**,少改一处就会出现"内存版和落盘版对同一段历史给出不同 leaf"的静默不一致,而类型系统抓不住这种不一致(两边签名都合法,只是行为不同)。
</details>
