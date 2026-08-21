# packages/agent/src/harness/types.ts

> **档位** A(逐行) · **行数** 1319(原 870,加中文注释后 1319) · **包** `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 / §3 第三组 / §5.2 / §5.3 · **索引** [README](../README.md)

## 1. 一句话

这是 agent 包「会话外壳(harness)」这一层的**契约总仓** —— 几乎全是 `type` / `interface` / 错误类,只有 5 个可执行函数(`ok` / `err` / `getOrThrow` / `getOrUndefined` / `toError`),而它们都只是 `Result` 的搬运工。

---

## 2. 它在全景里的位置

**它不在任何一跳上,而是每一跳的词汇表。**

全景篇 §1 那张分层图里,这个文件一个方框都占不到 —— 因为它不做动作。但把 §4 的 48 步生命周期拆开看,几乎每一步的入参、出参、事件载荷都是在这里定义的:

| 全景篇的步骤 | 这个文件提供的形状 |
|---|---|
| 第 3 步 `createTurnState()` → `session.buildContext()` | `SessionContext`(§5)、`SessionStorage`(§5)、`SessionTreeEntry` 11 种(§4) |
| 第 3c 步 「压缩只改投影」 | `CompactionEntry.firstKeptEntryId`(§4) |
| 第 5 步 `before_agent_start` hook | `BeforeAgentStartEvent` / `BeforeAgentStartResult`(§14 / §15) |
| 第 7 步 `createLoopConfig()` 六个回调 | `ContextEvent` / `ToolCallEvent` / `ToolResultEvent` 及其 Result(§14 / §15) |
| 第 8 步 `createStreamFn()` 三个 provider 钩子 | `AgentHarnessStreamOptions` + `...Patch`(§9)、三个 provider 事件(§14) |
| 第 26 / 37 步 落盘与 save point | `PendingSessionWrite`(§11)、`SavePointEvent`(§14) |
| 第 33 步 工具真的动板子 | `ExecutionEnv` = `FileSystem` + `Shell`(§3 / §10) |
| 第 42 步 `agent_end` → `settled` | `AgentHarnessPhase`(§11)、`SettledEvent`(§14) |
| 第 47 步 自动压缩 | `CompactionPreparation` / `CompactResult` / `CompactionSettings`(§13) |

**谁调它:** 整个 `packages/agent` 的 harness 层(`agent-harness.ts` 一个文件就从这里 import 了 16 个类型 + 5 个值),会话树全家(`session/*.ts`),压缩全家(`compaction/*.ts`);包外则是 `packages/coding-agent` 的每一个工具(它们收的第一个参数就是这里的 `FileSystem` 或 `ExecutionEnv`)与 `packages/kernel/src/host`(桌面端投影器吃 `AgentHarnessEvent`)。

**它调谁:** 只有三条 `import type`,零运行时依赖。编译产物里**没有任何 import 语句**,所以它天然是浏览器安全的。

**不存在会怎样:** `packages/agent` 整层编译不过 —— 它不是「可选的类型标注」,而是 `ExecutionEnv`(碰真实机器的唯一出口)、`SessionStorage`(会话怎么读写)、`AgentHarnessEventResultMap`(hook 能改什么)这三份接口的唯一定义处。全景篇 §5.2 与 §5.3 的接线表里,`ExecutionEnv → NodeExecutionEnv`、`FileSystem → read/write/edit 工具`、`AgentHarnessEvent = AgentEvent ∪ AgentHarnessOwnEvent` 三行,来源都是这个文件。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 头 | L1–L44 | 已有文件头注释(3 行)+ 新增总述块注释(职责 / 链路位置 / 分节索引) |
| §1 | L45–L110 | 导入与 `Result` 契约:`Result` / `ok` / `err` / `getOrThrow` / `getOrUndefined` / `toError` |
| §2 | L111–L142 | `SessionErrorCode` + `SessionError` |
| §3 | L143–L296 | FileSystem 能力:`FileKind` / `FileErrorCode` / `FileError` / `FileInfo` / `FileSystem`(17 个方法) |
| §4 | L297–L439 | 会话树条目:`SessionTreeEntryBase` + 10 个子接口 + `SessionTreeEntry` 联合 |
| §5 | L440–L500 | 读侧投影与存储契约:`SessionContext` / `SessionMetadata` / `JsonlSessionMetadata` / `SessionStorage` |
| §6 | L501–L557 | Repo 家族:`SessionCreateOptions` / `SessionForkOptions` / `SessionRepo` / 三个 Jsonl 变体 |
| §7 | L558–L621 | 资源类型:`Skill` / `PromptTemplate` / `AgentHarnessResources` |
| §8 | L622–L714 | 错误家族:`AgentHarnessError` / `ExecutionError` / `CompactionError` / `BranchSummaryError` |
| §9 | L715–L765 | provider 请求选项:`AgentHarnessStreamOptions` + `AgentHarnessStreamOptionsPatch` |
| §10 | L766–L814 | `ShellExecOptions` / `Shell` / `ExecutionEnv` |
| §11 | L815–L841 | `AgentHarnessPhase` / `PendingSessionWrite` |
| §12 | L842–L915 | `AgentHarnessOptions` / `AgentHarnessPromptOptions` / `AbortResult` |
| §13 | L916–L1007 | M8 数据形状:`CompactResult` / `NavigateTreeResult` / `CompactionSettings` / `FileOperations` / `CompactionPreparation` / `TreePreparation` / `BranchSummaryResult` |
| §14 | L1008–L1235 | 19 种 harness 自有事件 + `AgentHarnessOwnEvent` + `AgentHarnessEvent` |
| §15 | L1236–L1319 | 8 个 hook 返回值接口 + `AgentHarnessEventResultMap` |

---

## 4. 逐节讲解

### §1 导入与 Result 契约(L45–L110)

`L50–L52`

```ts
import type { ImageContent, Model, Models, SimpleStreamOptions, TextContent, Transport } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { Session } from "./session/session.ts";
```

三条**全部**是 `import type`。两个后果:

1. 编译后这个文件不产生任何 `import` 语句,于是它可以被打进浏览器侧 bundle 而不把 pi-ai 的运行时拖进去(`packages/agent/src/index.ts` 的「浏览器安全」承诺有一半靠这个)。
2. 第三行是与 `session/session.ts` 的**循环引用**(session.ts 也 import 本文件),只因为是类型导入才不成环。

`L58`

```ts
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
```

**判别联合(discriminated union)**,判别字段是 `ok`。它是本仓最重要的一条设计「**失败是数据不是异常(errors as data)**」在这一层的落地形式。

为什么不写成 `{ ok: boolean; value?: T; error?: E }`?因为那样在 `if (r.ok)` 之后 `value` 仍然是 `T | undefined`,调用方要么加非空断言要么再判一次。写成联合,TypeScript 在 `if (result.ok)` 分支里自动把类型收窄成 `{ ok: true; value: TValue }`,`result.value` 直接是 `TValue`。

`L63–L65` / `L68–L70`

```ts
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}
```

两个字面量工厂。看起来毫无价值,实际的价值在于:直接写 `return { ok: false, error: e }` 时 TypeScript 会把 `ok` 推断成 `boolean` 而不是字面量 `false`,于是赋不进 `Result`;要么手写 `as const`,要么用这两个函数。`env/nodejs.ts` 里有几十处 `return err(toFileError(error, resolved))`,省下的就是几十个 `as const`。

`L77–L80`

```ts
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}
```

Result 世界 ↔ throw 世界的**显式关口**。JSDoc 上写着 "Intended for tests and explicit adapter boundaries",实测也确实如此:全仓调用点集中在 `packages/agent/test/harness/nodejs-env.test.ts` 与 `packages/coding-agent/test/tools.test.ts`(测试里写 `getOrThrow(await env.writeFile(...))` 比逐个 `if (!r.ok)` 干净得多)。

生产侧的同类关口是 `session/repo-utils.ts:24` 的 `getFileSystemResultOrThrow`,它比这个多做一件事 —— 把 `FileError` 翻成 `SessionError`,并且**只有 `not_found` 保持原码,其余一律折成 `"storage"`**:

```ts
const code = result.error.code === "not_found" ? "not_found" : "storage";
```

`L87–L89`

```ts
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}
```

`TValue extends object` 这条约束是这个函数唯一有意思的地方。如果允许原始值,`getOrUndefined(await fs.exists(p))` 在「文件确实不存在(`value: false`)」和「调用失败(权限不足)」两种情形下都会返回一个假值,调用方一个 `if (!x)` 就把两者混为一谈了。约束成对象就没有这个歧义。

**它是死导出** —— 全仓(含测试)零调用点。

`L96–L108`

```ts
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}
```

JS 的 `throw` 什么都能扔(字符串、数字、`undefined`、一个普通对象)。凡是要把捕获物当作 `cause` 挂到自己的错误上、或者读它的 `.message`,都必须先过这一道。

三层兜底的**顺序**是刻意的:先试 `JSON.stringify` 保住结构化信息(`{"code":"ENOENT"}` 比 `[object Object]` 有用得多),失败了才退到 `String()`。`JSON.stringify` 会在循环引用、`BigInt`、`toJSON` 自身抛错时抛异常 —— 删掉那个 `catch`,一个循环引用的异常就会让归一化函数**自己**抛出去,把原始错误彻底吃掉。

调用点分布正好标出了「外部世界进入本层」的三处边界:`agent-harness.ts:145`(`normalizeHarnessError`)、`env/nodejs.ts:100`(`toFileError`)、`jsonl-storage.ts:67/105`(解析磁盘上的 JSON)。

### §2 SessionError:会话子系统的错误码(L111–L142)

`L118–L124`

```ts
export type SessionErrorCode =
	| "not_found"
	| "invalid_session"
	| "invalid_entry"
	| "invalid_fork_target"
	| "storage"
	| "unknown";
```

稳定的、与后端无关的分类码。调用方(尤其是 UI)按**码**分支,不按 message 文本分支 —— 文本是给人看的,随时会改。

实测的产生者分布:

| 码 | 产生点 | 含义 |
|---|---|---|
| `not_found` | 8 处(`jsonl-repo`/`jsonl-storage`/`memory-*`/`session.ts`) | 会话文件或条目找不到 |
| `invalid_session` | 7 处(`jsonl-storage`) | header 坏了、`version !== 3` |
| `invalid_entry` | `jsonl-storage.ts:54` 的 `invalidEntry()` 工厂 | 某一行 JSONL 解析不出来或缺字段 |
| `invalid_fork_target` | `repo-utils.ts:41/48` | fork 的目标条目不存在,或 `position:"before"` 时目标不是 user 消息 |
| `storage` | `repo-utils.ts:27` | 底层 `FileError` 折过来的 |
| `unknown` | **零产生者** | |

`L134–L139`

```ts
	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
```

两个细节值得记:

- `cause === undefined ? undefined : { cause }` 不是啰嗦。`Error` 的第二参**只要存在**就会写下 `cause` 自有属性,直接传 `{ cause }` 会在无因错误上留一个 `cause: undefined`,序列化和断言时多出一个字段。本文件四个错误类写法完全一致。
- 显式写 `this.name`:类名在压缩/打包后不可靠,而 `err.name` 常常是跨进程判别错误种类的最后一根稻草。根 `CLAUDE.md` 里那条「contextBridge 会把 Error 剥成一句话,只保留 `message` 和 `stack`」正是这类问题的极端版本。

### §3 FileSystem 能力:永不 throw 的文件系统接口(L143–L296)

这一节是全景篇 §3 第五组「能力接口注入(capability injection)」的定义处。

`L153`

```ts
export type FileKind = "file" | "directory" | "symlink";
```

只有三种,**没有** block device / fifo / socket。`NodeExecutionEnv` 遇到这些会返回 `FileError("invalid", "Unsupported file type")`(`env/nodejs.ts:86`),而不是硬塞一个种类 —— 「说不出来」比「说错」好。

`L161–L169`

```ts
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";
```

「与后端无关」是这组码的全部意义。`NodeExecutionEnv.toFileError()` 把 Node 的 errno 映射进来(`ENOENT`→`not_found`、`EACCES`/`EPERM`→`permission_denied`、`ENOTDIR`→`not_directory`、`EISDIR`→`is_directory`、`ABORT_ERR`→`aborted`),换成远程/沙箱后端时上层工具一行都不用改。

`not_supported` **当前没有生产产生者** —— 它是给「这个后端做不到这个操作」预留的(例如一个只读远程文件系统上的 `createTempDir`)。

`L189–L204` 的 `FileInfo` 里有一条容易滑过去的语义:

```ts
	/** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
	path: string;
```

「syntactically normalized」而不是 canonical:符号链接**不**解引用。要真身得显式调 `canonicalPath()`。这条区分是安全相关的 —— 悄悄跟随符号链接会让「限定在 cwd 内」这类判断失效。`mtimeMs` 用毫秒数而不是 `Date` 则是为了能过结构化克隆 / JSON 边界(桌面端会把它送去 renderer)。

`L206–L216`

```ts
/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Operation methods must never throw or reject —
 * all filesystem failures are encoded in the returned {@link Result}.
 */
export interface FileSystem {
```

**「永不 throw、永不 reject」是这个接口最重要的一条契约**,而且它只写在注释里 —— 类型系统表达不了。它的收益是工具层可以无脑写:

```ts
const r = await env.readTextFile(path);
if (!r.ok) return { content: [{ type: "text", text: `Error: ${r.error.message}` }], isError: true };
```

而不必到处 `try/catch`。

17 个方法里值得单独说的几个:

**`exists` 返回 `Result<boolean>` 而不是 `boolean`**(`L264`)。「不存在」和「问不出来」是两回事:前者是 `ok:true, value:false`,后者(权限不足等)是 `ok:false`。压成一个 boolean 会让权限问题伪装成「文件不在」,后续动作全错。

**`readTextLines` 的 `maxLines` 是性能契约不是建议**(`L236–L239`)。`JsonlSessionRepo.list()` 靠 `readTextLines({maxLines:1})` 只读会话文件的第一行 header 就列出全部会话;实现方要是老老实实读全文,会话列表页会随会话变长而变慢。

**`writeFile` / `appendFile` 负责建父目录**(`L245`、`L249`)。write 工具**不自己 mkdir**,它假定这一步由实现方做。换实现时漏掉这条,写深层新路径会静默失败。

**`listDir` 只列直接子项、不递归**(`L255`)。整个内核**没有 glob、没有 grep** —— 文件查找靠模型自己在 bash 里跑 `find` / `ls` / `rg`。别按上游 pi 的印象在这里补一个 glob。

**默认值全写在 JSDoc 里而不是签名里**(`L268`、`L275`)。因为这是**接口**:默认值由每个实现自己兑现,类型系统管不到,那行注释就是唯一的对账依据。注意 `remove` 的两个默认值(`recursive: false`、`force: false`)都是保守的 —— 删除不可逆,默认站在「宁可失败」一侧。

`L293–L294`

```ts
	/** Release filesystem resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
```

唯一一个不返回 `Result` 的方法:清理**没有**可供调用方处理的失败模式,报了也没用。顺带一条实测:`NodeExecutionEnv.cleanup()` 的生产路径从来没人调,实际靠「一轮一个子进程 / 内核进程退出」这个进程边界兜底,全仓唯一调用点在单测里。

### §4 会话树条目:11 种 entry 与它们的联合(L297–L439)

这一节是「**一切皆条目、只追加、永不删改**」这条设计的类型表达。

`L309–L316`

```ts
export interface SessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}
```

三条性质要记住:

1. `type` 在基类里故意写成宽的 `string`,由每个子接口用字面量收窄 —— 这就是判别联合的判别字段。
2. `parentId === null` 的是根;树完全由 `parentId` 指针拉出来。
3. `timestamp` 是 **ISO 字符串**(`new Date().toISOString()`),而 pi-ai 的 `Message.timestamp` 是**毫秒 number**。两者不是同一种表示,拿会话条目的时间戳去减消息的时间戳会得到 `NaN`。

`id` 由 `storage.createEntryId()` 分配,注意它不是完整 uuidv7 而是 `uuidv7().slice(-8)` —— 取的是**纯随机尾部**,因此**不可按 id 排序**(见全景篇 §6.1;桌面端投影器就是因为这条才自己另铸一套 id)。

`L350–L365`

```ts
export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}
```

这是「**投影不是历史**」的核心数据结构。压缩**不删任何东西**:`appendCompaction` 只是往树上追加这么一条。真正「变短」发生在读的时候 —— `session.ts:64` 的 `defaultContextEntryTransform` 找出路径上**最后一个** compaction,把结果重排成 `[摘要, firstKeptEntryId..compaction 之间, compaction 之后一切]`。磁盘上原文一字不少。

四个字段各自的坑:

- `firstKeptEntryId`:如果它不在 compaction 之前的路径上(属于另一条分支、或跨 fork 丢了),投影会把压缩点之前的条目**整段静默丢弃**,只剩一条摘要,没有任何告警。
- `tokensBefore`:是「压之前这次**上下文**有多大」,不是「这个会话历史一共多大」—— `prepareCompaction` 算的是投影之后的消息(已应用上一条 compaction)。
- `details`:泛型槽,内核不解释它。本仓实际放 `{readFiles, modifiedFiles}`,下一次压缩会继承它,好让第三次压缩仍知道两小时前改过哪些文件。
- `fromHook`:true = 摘要是 `session_before_compact` hook 直接给的。后果是 `details` 形状不可假定,因此**不被下一次压缩继承**。

`L382–L398`

```ts
export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}
```

**名字只差一个词,语义完全相反**,这是本区最容易记反的一对:

- `custom` 是**纯数据**条目,**默认不进模型上下文**,必须注册 `session.ts` 的 `entryProjectors[customType]` 才会被投影成消息。
- `custom_message` 是**消息**条目,默认就进。

`display` 只影响 UI:`convertToLlm` 对 custom 角色**忽略 display**,`display: false` 的内容照样进 LLM(全景篇 §6.1 记着这条)。真正「不进 LLM」的开关只有 `bashExecution` 的 `excludeFromContext`。

`L401–L407`

```ts
export interface LabelEntry extends SessionTreeEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}
```

注意 `label` 写的是 `string | undefined` 而不是 `label?: string` —— **必须显式写出来**。这让「清除标签」是一个可表达的动作(`label: undefined`),而不是「忘了填」。`Session.appendLabel(targetId, label)` 的第二参也是必填的同类型。

`L410–L413`

```ts
export interface SessionInfoEntry extends SessionTreeEntryBase {
	type: "session_info"; // legacy name, kept for backwards compatibility
	name?: string;
}
```

行尾那句是**原作者留下的**:名字叫 `session_info` 是历史包袱,但它已经写进磁盘上的 JSONL 文件了,改名等于让老会话读不出来。

`L420–L423`

```ts
export interface LeafEntry extends SessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}
```

**把「光标本身」也写成数据。** `setLeafId(x)` 不是改内存变量,而是追加这么一条条目。理由只有一个:JSONL 是追加日志,重开文件靠逐行重放恢复光标;光标只活在内存里的话,重开会话永远回到「最后一条条目」而不是用户上次真正停留的位置。

反直觉推论:`leaf` 条目进了 `entries` 和 `byId`,却**永远不会出现在任何一条 `getPathToRoot` 路径里** —— 它是纯粹的日志侧枝。

`L427–L438` 是 11 种的判别联合。任何拿它做 `switch` 的地方都必须有 `default` 分支:这个联合会随里程碑变宽,漏一个分支的表现是「某种条目在 UI 里静默消失」。

### §5 读侧投影与 SessionStorage(L440–L500)

`L446–L454`

```ts
export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}
```

这是 `buildContext()` 的产物,也就是全景篇 §4 第 3 步的结果。**四个字段的来路不同**,这一点是理解「压缩只改投影」的关键:

- `messages` 走 compaction 投影(隐去旧历史);
- 其余三个由 `deriveSessionContextState` 扫**完整**路径推导(`session.ts:44`),后写覆盖先写。所以**被压掉那段里的 `model_change` 依然生效**。

`thinkingLevel` 是宽的 `string` 而不是 `ThinkingLevel`(与 `ThinkingLevelChangeEntry` 一致):从磁盘读回来的老会话里可能有当前联合已经不认识的档位名,收窄成联合会让整个会话在解析期炸掉。宽类型在这里是防御。

`model: null` 与 `activeToolNames: null` 的含义也不同:前者是「这条路径上还没有任何 `model_change` 条目、也没有 assistant 消息可反推」;后者的 `null` 与 `[]` 必须分清 —— `null` = 从没设置过(用装配时的默认),`[]` = 明确一个工具都不启用。

`L475–L499` 的 `SessionStorage` 是「一个会话文件怎么读写」。两套实现(`JsonlSessionStorage` 落盘 / `InMemorySessionStorage` 测试与浏览器)接口完全一致,于是树的语义只写一遍。

两个方法值得展开:

`L484`

```ts
	createEntryId(): Promise<string>;
```

**它不预留这个 id,只是查了一下重。** `Session.append*` 里「取 id」与「真正 `appendEntry`」之间隔着一个 `await getLeafId()`,并发调两个 `append*` **一定**会拿到同一个 `parentId` —— 结果是两条新条目并列挂在同一个父下,**意外分叉而不是链**。harness 用 FIFO 串行 flush 规避(见 §11),直接用 `Session` 的调用方要自己保证串行。

`L489–L491`

```ts
	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
```

泛型 + `Extract` 的经典用法:传 `"compaction"` 进去,拿回来的静态类型就是 `CompactionEntry[]` 而不是 `SessionTreeEntry[]`,调用方省掉一次手写类型守卫。桌面端自动压缩(`kernel/src/host/session-manager.ts`)靠它查上一次压缩的时间戳。

`getLabel` / `getSessionName` 查的是**全部条目**而不是当前路径 —— 别的分支上打的标签、改的名字也算数。

### §6 SessionRepo 家族(L501–L557)

`SessionStorage` 管一个会话,`SessionRepo` 管一堆会话。

`L513–L521`

```ts
export interface SessionForkOptions {
	entryId?: string;
	position?: "before" | "at";
	id?: string;
}
```

`position` 的默认值是 `"before"`,含义是「回到发这句话**之前**」。因此 `repo-utils.ts:48` **强制要求目标是一条 user 消息**,取的是 `target.parentId`:

```ts
if (target.type !== "message" || target.message.role !== "user") {
	throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
}
```

这就是 CLI / 桌面端「编辑上一条消息重发」的底层动作。`"at"` 则含目标条目本身。

`L526–L539`

```ts
export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}
```

三个泛型参数分别是「元数据形状 / 创建选项 / 列出选项」。把它们参数化的收益,对照两个实现就看得很清楚:

| | `JsonlSessionRepo` | `InMemorySessionRepo` |
|---|---|---|
| TMetadata | `JsonlSessionMetadata`(多 cwd / path / parentSessionPath) | `SessionMetadata` |
| TCreateOptions | `JsonlSessionCreateOptions`(**cwd 必填**) | `{ id?: string }` |
| TListOptions | `JsonlSessionListOptions`(按 cwd 过滤) | `void` |

`open` 收的是**元数据**而不是 id,因为磁盘实现要靠 `metadata.path` 才知道去哪个文件找。`fork` 的参数写成交叉类型 `SessionForkOptions & TCreateOptions`,意思是「既要说从哪儿切,又要满足建一个新会话的全部必填项」—— 在磁盘实现里就包括 `cwd`。

`L555–L556`

```ts
export interface JsonlSessionRepoApi
	extends SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {}
```

空接口 + `extends`:给一长串泛型实参起个短名字。`JsonlSessionRepo` 直接 `implements JsonlSessionRepoApi`,调用点不用重复写三个类型参数。

### §7 资源类型:Skill 与 PromptTemplate(L558–L621)

`L576–L591` 的 `Skill` 形状正好对应全景篇 §3 第四组说的**两级注入**:

- **第一级(每轮都花上下文)** = `name` + `description` + `filePath`,由 `harness/system-prompt.ts:7` 的 `formatSkillsForSystemPrompt` 拼成 `<available_skills>` 区块(逐字段 XML 转义)。
- **第二级(按需)** = `content` 全文,由模型自己用 read 工具去读那个路径、或应用调 `harness.skill(name)` 注入。

**这个两级设计是「技能可以写得很长而不炸上下文窗口」的全部原因。**

`description` 是唯一**硬性要求**的 frontmatter 字段:`skills.ts` 里缺 description 或全空白的技能会被静默丢弃,表现是「我明明放了技能却看不见」。

`disableModelInvocation` 的语义是「藏起来但仍可被应用显式调用」,`system-prompt.ts:8` 在拼列表时 filter 掉它们。

`L598–L605` 的 `PromptTemplate` 与 Skill 的关键区别:模板**从不**出现在系统提示词里,只能被显式调用(`harness.promptFromTemplate(name, args)` → `formatPromptTemplateInvocation` 做 `$1` / `$@` / `${@:N:L}` 替换)。

**现状:** `prompt-templates.ts` 的磁盘加载器从未实现,全仓没有人往 `resources.promptTemplates` 里填东西,于是 `promptFromTemplate()` 在当前形态下必然抛 `Unknown prompt template`。

`L612–L620` 的 `AgentHarnessResources` 只有两个可选数组。JSDoc 里那句 "Applications own loading/reloading resources" 是纪律:harness 只提供 `setResources()`,**不监听文件变化**。资源是**快照式**的 —— 建会话时读一次,改了技能文件要重开会话。

### §8 harness 错误家族(L622–L714)

`L634–L643`

```ts
export type AgentHarnessErrorCode =
	| "busy"
	| "invalid_state"
	| "invalid_argument"
	| "session"
	| "hook"
	| "auth"
	| "compaction"
	| "branch_summary"
	| "unknown";
```

**harness 对外只抛 `AgentHarnessError`**,这组码是它的顶层分类。`agent-harness.ts:142` 的 `normalizeHarnessError` 把下层错误折进来:

```ts
if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
return new AgentHarnessError(fallbackCode, cause.message, cause);
```

于是调用方只需要认识这一个错误类。最常撞见的三个:`busy`(相位不是 idle,见 §11)、`invalid_state`(状态不允许,如没有模型)、`invalid_argument`(工具名重复 / 未知工具名)。

`L662–L668`

```ts
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";
```

**注意这里没有 `nonzero_exit`。** 非零退出码不是错误,它是 `ok: true` 那一侧的 `exitCode` 字段。这在这个产品里是承重设计:「烧录器返回 1」多半是没插板子,那是一个**正常结果**,要连同输出一起给模型看,而不是变成一个异常。

`NodeExecutionEnv` 的 settle 判定顺序是**回调错误 > 超时 > 中断 > 退出码**,所以一次「超时的同时 `onStdout` 抛了错」会报 `callback_error` 而不是 `timeout`。

`L685` / `L701`

```ts
export type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";
```

`aborted` 与 `summarization_failed` 的分工:前者是用户/上层掐的(**不是错误,别报警**),后者才是摘要真的没生成出来。`navigateTree` 就靠这个区分把中断翻成 `{cancelled: true}` 而不是抛错:

```ts
if (branchSummary.error.code === "aborted") return { cancelled: true };
```

`BranchSummaryErrorCode` 比 `CompactionErrorCode` 少一个 `"unknown"` —— 分支摘要的失败面更窄:它不读 session 结构,只对着一段收集好的条目调一次模型。

### §9 provider 请求选项与它的补丁形状(L715–L765)

`L723–L743`

```ts
export interface AgentHarnessStreamOptions {
	transport?: Transport;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: SimpleStreamOptions["metadata"];
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}
```

JSDoc 里的 "**Curated**"(精选)是关键词。pi-ai 的 `SimpleStreamOptions` 有十几个字段,这里只挑出**应用有理由调**的 7 个。`signal` / `reasoning` / `sessionId` / `apiKey` 不在其中 —— 那些由 harness 自己按 turn 快照填(`agent-harness.ts:386-404`),让应用改它们只会制造不一致。实测这 7 个字段确实**全部**被 `createStreamFn` 转发进 `models.streamSimple`,一个都没漏。

"snapshotted per turn":进入一轮时拷一份进 turn 快照,本轮所有请求读的都是那一份;中途 `setStreamOptions()` 要到下一轮重建快照才生效。

两个类型细节:

- `headers` 是 `Record<string, string>`,比 pi-ai 的 `ProviderHeaders`(`Record<string, string | null>`)**窄** —— harness 不暴露「用 `null` 抹掉 provider 默认头」这个能力。
- `metadata` / `cacheRetention` 用 `SimpleStreamOptions["..."]` 索引而不是复述具体类型:上游改了形状这里跟着变,不会漂移。

`L750–L764`

```ts
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	headers?: Record<string, string | undefined>;
	metadata?: Record<string, unknown | undefined>;
}
```

补丁形状 = 部分选项 + 两个字段被**摘掉重写**。为什么要摘?因为它们的补丁语义与其余字段不同:其余字段是「整体替换」,这两个是「逐键合并」。

三态语义由 `agent-harness.ts:95` 的 `Object.hasOwn` 兑现:

| 写法 | 效果 |
|---|---|
| 不写 `headers` 这个键 | 不动 |
| `headers: undefined` | 清空全部头 |
| `headers: { "x-foo": undefined }` | 只删 `x-foo` 这一个 |

**用 `Object.hasOwn` 而不是 `!== undefined` 判断是这套语义成立的前提** —— 改成后者,「显式清空」就退化成「什么也没做」。

顺带一个类型层的冗余:`Record<string, unknown | undefined>` 里的 `| undefined` 在类型上没有作用(`unknown` 已经含 `undefined`),留着纯粹是为了让读者一眼看出它与 `headers` 是同一套三态语义。

### §10 Shell 与 ExecutionEnv(L766–L814)

`L769–L793` 的 `ShellExecOptions` 有两处特别容易踩:

**`timeout` 的单位是秒**(`L783`),而同一个文件里 `AgentHarnessStreamOptions.timeoutMs` 是毫秒。不传 = 不超时;bash 工具自己给了 120 秒的默认。

**`inheritEnv` 背后有一条隐藏行为**(`L779`):`NodeExecutionEnv.getShellEnv` 会在这一步无条件钉上 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`(调用方显式传的值不覆盖)。理由写在根 `CLAUDE.md` 里:中文 Windows 上 Python 在 stdout 不是终端时按 cp936 编码,而我们按 UTF-8 解管道,解出来的 U+FFFD **不可逆**;退出码完全正常,坏掉的恰恰是这套系统的产品 —— 证据,而且一声不吭。

**`onStdout` / `onStderr` 里抛错会被当成 `callback_error` 并杀掉进程树**,而且优先级高于超时。别在这两个回调里写可能失败的逻辑。

`L802–L805`

```ts
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
```

**退出码在成功一侧**(见 §8)。另外实现方必须**杀进程树**而不是杀 shell:模型的命令常是 `npm run dev`、`cmake --build`、`openocd` 这类会再 fork 的东西,只杀 bash 会留下攥着调试探针不放的孤儿 gdbserver,而报错长得和「没插板子」一模一样。

`L813`

```ts
export interface ExecutionEnv extends FileSystem, Shell {}
```

两个能力的交叉。工具工厂按需要收窄参数类型 —— `createEditTool(env: FileSystem)`、`createBashTool(env: ExecutionEnv)` —— **参数类型本身就是最小权限声明**。

### §11 相位机与挂起写入(L815–L841)

`L822`

```ts
export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

「相位机(phase machine)而非锁」的意思是:`prompt` / `skill` / `promptFromTemplate` / `retryLastTurn` / `compact` / `navigateTree` 六个入口开头都是**同步**的

```ts
if (this.phase !== "idle") throw new AgentHarnessError("busy", "...");
```

在第一个 `await` 之前生效 —— 同一个微任务里连发两次 `prompt`,第二次必定同步炸,**绝不排队**。反向的两个:`steer()` / `followUp()` 要求 phase **不是** idle(idle 时抛 `invalid_state`);`nextTurn()` 任何相位都能排。

`L836–L840`

```ts
export type PendingSessionWrite = SessionTreeEntry extends infer TEntry
	? TEntry extends SessionTreeEntry
		? Omit<TEntry, "id" | "parentId" | "timestamp">
		: never
	: never;
```

这是全文件唯一一处需要动脑子的类型体操,文件里原有的注释已经点明了理由,这里把它展开:

`Omit<A | B, "k">` 会**先把 `A | B` 的键集合求交再剔除** —— 结果丢掉各分支独有的字段(`MessageEntry.message`、`LabelEntry.targetId` 全没了),整个联合塌成一个只剩 `type` 的交集。

写成 `T extends U ? ... : never` 这种**裸类型参数**的条件类型,TypeScript 会对联合逐个成员分发(distributive conditional type),于是得到 `Omit<MessageEntry,...> | Omit<LabelEntry,...> | ...`,每个变体各自 Omit。外层多套的一层 `SessionTreeEntry extends infer TEntry ?` 只是为了拿到一个**裸参数** `TEntry` 来触发分发,没有别的作用。

它的语义是「还没分配 `id`/`parentId`/`timestamp` 三件套的树条目」。为什么要延迟这三样?因为 `parentId` 必须是**落盘那一刻**的 leaf,而不是排队那一刻的。harness 的做法是:

```ts
if (this.phase === "idle") {
	await this.session.appendModelChange(model.provider, model.id);   // 直写
} else {
	this.pendingSessionWrites.push({ type: "model_change", provider, modelId }); // 排队
}
```

`flushPendingSessionWrites()`(`agent-harness.ts:489`)是「peek 队头 → 写成功 → 才 shift」,失败的写留在队头,队列不会烂在半路。**这个队列同时也是「同一时刻只有一个写者」的唯一保证。**

### §12 harness 装配选项(L842–L915)

`L846–L901` 的 `AgentHarnessOptions` 就是全景篇 §4 第 0.8 步交给 `new AgentHarness(...)` 的那个对象。逐个字段的关键点:

- **`env` / `session` / `models` / `model` 是必填**,其余可选。
- **`session: Session` 不是泛型的** —— 写的是 `Session`(即 `Session<SessionMetadata>`),所以 harness **看不见** `JsonlSessionMetadata` 的 `path` / `cwd`。一个 harness = 一个 session。
- **`models` 在类上是 `readonly`**:注册表建好之后换不掉。推论是装配期(第 0.1 步)必须一次把全部有凭据的 provider 注册齐,否则运行中换模型会找不到 provider。
- **`systemPrompt` 是联合类型**(`L876–L885`):常量字符串,或每轮现算的回调。回调形态的意义是让提示词能随「当前模型 / 当前档位 / 当前启用了哪些工具 / 当前有哪些技能」变化 —— coding-agent 就靠它把技能列表和工具守则拼进去。两者都不传时 harness 落到硬编码的 `"You are a helpful assistant."`(`agent-harness.ts:343`)。
- **`thinkingLevel`(L893)不传落到 `"off"`**,而 `"off"` 会让 `createLoopConfig` 把 `reasoning` 整个置 `undefined`,即**把 reasoning 从请求里摘掉**。对 reasoning 模型这等于「最强的一档默认关掉,且没有任何地方提示」—— 桌面端 / bench 的 `defaultThinkingLevel` 注入就是为了补这个洞(根 `CLAUDE.md` 记了实测代价:107 条 assistant 消息、reasoning token **0**)。
- **`activeToolNames` 不传 = tools 里的全部**;传了会被校验(重名报错、名字不在 tools 里也报错)。
- **`steeringMode` / `followUpMode` 默认都是 `"one-at-a-time"`**。两条队列的差别只在**被拉取的时机**:steering 是「插队」(飞行中,下一次请求前进 transcript,当前这批工具照常执行),followUp 是「续摊」(agent 本来要停下的那一刻才拉,有货就再来一整轮)。

`L911–L914`

```ts
export interface AbortResult {
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}
```

`abort()` 把被清空的消息**还给调用方**而不是扔掉:应用可以把它们放回输入框。注意 **`nextTurn` 队列在 abort 后幸存** —— 它是「排给下一轮」的,中断当前轮不该殃及它。

### §13 M8 数据形状(L916–L1007)

`L927–L932` 的 `CompactResult` 四个字段与 `CompactionEntry` 的前四个一一对应,因为它就是**将要被追加成那条条目的东西**。`session_before_compact` hook 可以直接返回一个它,替内核省掉一次模型调用。

`L947–L951`

```ts
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}
```

三个数值旋钮,默认值在 `compaction.ts:121` 的 `DEFAULT_COMPACTION_SETTINGS`。语义:`reserveTokens` = 「留给下一次回答的余量」,压缩阈值 = `contextWindow - reserveTokens`;`keepRecentTokens` = 「最近多少 token 的对话必须原样保住」。

`L956–L960`

```ts
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}
```

用 `Set` 而不是数组:同一个文件在一轮里可能被读写多次,去重是这里唯一想要的语义。采集规则是**约定优于配置**的 —— `compaction/utils.ts` 只认工具名字面量 `read` / `write` / `edit`,且参数字段必须叫 `path`;datasheet / flash / gdb / netlist 动过的文件一律不进清单。

`L965–L981` 的 `CompactionPreparation` 是 `prepareCompaction()` 的产物:一份「怎么压」的完整计划,算好之后才去调模型。**分成「准备」与「执行」两步的收益**:`session_before_compact` hook 能在**花钱之前**看到全部决策并取消它。

两个字段的坑:

- `turnPrefixMessages` 只在 `isSplitTurn` 时非空 —— 切点落在一轮**中间**时,`[轮起点, 切点)` 这段要单独做一份「前缀摘要」,否则被保留的后半段不知道自己在回答什么问题。
- **`isSplitTurn === true` 而 `turnPrefixMessages` 为空数组是可能的**(切点恰好是 `branch_summary` / `custom_message` 时),`compact()` 靠 `isSplitTurn && length > 0` 兜住,退回普通摘要。读代码时容易误以为会白白多调一次模型。

`L985–L998` 的 `TreePreparation` 是 navigateTree 那一侧的同类结构,但它**不是**某个 `prepareXxx` 函数的返回值 —— 由 `agent-harness.ts:861` 现场拼出来,类型靠 `SessionBeforeTreeEvent.preparation` 的字段声明反向约束。`commonAncestorId` 是旧 leaf 路径与目标路径的**最深公共祖先(LCA)**,从旧 leaf 到 LCA 这一段就是「即将离开投影的那条分支」,也就是要摘要的范围。

`L1002–L1006` 的 `BranchSummaryResult` 比 `CompactResult` 多两个文件清单、少一个 `firstKeptEntryId` —— 分支摘要不需要切点(范围由 LCA 界定)。

### §14 harness 自有事件词汇表(L1008–L1235)

**读这一节之前必须先知道一条运行时事实**(根 `CLAUDE.md` 与全景篇 §6.1 都记了):

> `emitOwn`(`agent-harness.ts:230-238`)与 `emitAny`(`:240-248`)的函数体**逐字节相同**,都只遍历 `"*"`(订阅者)桶。
> 于是凡是走 `emitOwn` 发出的事件,用 `on(type, handler)` 注册的 handler **永远不会触发**。

我在源码里给 19 个事件接口逐个标了它走哪条路。汇总:

| 分发路径 | 事件 | `on()` 能不能收到 |
|---|---|---|
| `emitHook`(**活的**) | `context` / `tool_call` / `tool_result` / `before_agent_start` / `session_before_compact` / `session_before_tree` | 能,且**返回值被消费** |
| 专用分发器(**活的**) | `before_provider_request`(`:270`)/ `before_provider_payload`(`:296`) | 能 |
| `emitOwn`(**死的**) | 其余 11 种 | **不能** —— 只能 `subscribe()` |

那 11 种是:`queue_update` / `save_point` / `abort` / `settled` / `after_provider_response` / `session_compact` / `session_tree` / `model_update` / `thinking_level_update` / `tools_update` / `resources_update`。(根 `CLAUDE.md` 写的是「十个」,漏了 `resources_update`;全景篇 §6.0 已经做过这条修正。)

两个专用分发器的语义与 `emitHook` **不同**,值得单独记:

- `emitHook`:多个 handler 依次执行,**最后一个非 undefined 的返回值胜出**。
- `emitBeforeProviderRequest`:**逐个 handler 累积打补丁**(每个的 patch 叠在上一个结果上)。
- `emitBeforeProviderPayload`:**串接**(上一个的返回值是下一个的输入)。

`L1125–L1134`

```ts
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionTreeEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}
```

`branchEntries` 给的是完整的当前分支条目(`preparation` 只给了消息),让 hook 能自己做决策。

**`signal` 是个坑**:`agent-harness.ts:821` 传进来的是 `new AbortController().signal` —— 一个**永远不会被 abort 的**全新信号。`session_before_tree`(`:872`)和 `generateBranchSummary`(`:884`)也一样。它现在只是占位,别指望用它取消压缩。

`L1163–L1170`

```ts
export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}
```

`source` 的类型写着两个值,但全仓**只产生 `"set"`**(`:964`;`ToolsUpdateEvent.source` 同理,`:1011` 与 `:1039`)。`"restore"`(从会话恢复出的模型)**从来没有产生者** —— `createTurnState` 只取 `buildContext()` 返回的 `messages`,压根没读它算出来的 `model` / `thinkingLevel` / `activeToolNames` 三个字段。「从会话恢复配置」这件事在当前 harness 里没有实现。

`L1205–L1227` 的 `AgentHarnessOwnEvent` 是这 19 种的联合;`L1232–L1234` 的 `AgentHarnessEvent` 把它与 loop 的 **10 种** `AgentEvent` 并起来,就是 `subscribe()` 能听到的全部词汇。

**注意 `on()` 用的不是 `AgentHarnessEvent`** —— 它的签名是 `Extract<AgentHarnessOwnEvent, { type: TType }>`,也就是说 loop 的 10 种事件(`message_end` / `turn_end` / `tool_execution_start` …)**根本没法用 `on()` 注册**,想听只能 `subscribe()`。桌面端投影器(`kernel/src/host/session-manager.ts:610`)因此是一个大 `switch`。

### §15 hook 返回值契约(L1236–L1319)

8 个 Result 接口 + 一张映射表。设计上有一条统一约定:**整个返回 `undefined` = 「我只是看看」,返回对象 = 「我要改」。**

`L1239–L1248`

```ts
export interface BeforeAgentStartResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

export interface ContextResult {
	messages: AgentMessage[];
}
```

两者的 `messages` 一个可选一个必填,不是笔误:`before_agent_start` 可以只改系统提示词,而 `context` hook 的返回值只有一个含义 ——「本次请求改用这一份消息」,给了对象却不给 messages 是无意义的。

`L1267–L1275`

```ts
export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}
```

名字叫 `Patch` 而不是 `Result`:四个字段全可选,只覆盖你给出的那几样。

**`terminate` 有两层限制**:loop 侧用 `??` 合并,所以这里只能把 `undefined` 补成 `true`/`false`,**不能把工具自己声明的 `true` 抹回 `false`**;而且 `terminate` 的最终判定是整批工具**全票通过**才生效。

`L1299–L1319`

```ts
export type AgentHarnessEventResultMap = {
	before_agent_start: BeforeAgentStartResult | undefined;
	context: ContextResult | undefined;
	...
	settled: undefined;
};
```

这张表是 `on()` 的类型骨架:键 = 可注册的事件类型,值 = 该 handler 的返回值类型。两条设计:

1. 值写成 `X | undefined` 而不是 `X?` —— handler 的返回值不是可选属性,它必须显式返回点什么。
2. **19 个键必须与 `AgentHarnessOwnEvent` 的 19 个成员一一对应**:`on()` 靠 `Extract<AgentHarnessOwnEvent, { type: TType }>` 从联合里取事件形状,表里多一个键就取到 `never`(handler 参数无法使用),联合里多一个成员就没法注册。实测两边当前**正好各 19**。
3. 值为 `undefined` 的那 11 项,**恰好就是走 `emitOwn` 的那批** —— 类型上允许你 `on()` 它们,运行时却永远不会触发。类型系统在这里帮不上忙。

---

## 5. 会咬人的地方

- **L87 `getOrUndefined` 是死导出。** 全仓(含所有测试)零调用点。删它是安全的,但它出现在 `index.ts` 的 `export *` 里,属于包的公开 API,删了算 breaking change。
- **L118–L124 `SessionErrorCode` 的 `"unknown"` 没有任何产生者。** 写 `catch (e) { if (e.code === "unknown") ... }` 是永远不会进的分支。
- **L161–L169 `FileErrorCode` 的 `"not_supported"` 同样没有产生者。** 它是给「远程/沙箱后端做不到这个操作」预留的,当前唯一实现 `NodeExecutionEnv` 不产生它。
- **L264 `exists` 返回 `Result<boolean>` 是刻意的。** 顺手把它简化成 `Promise<boolean>` 会让权限错误伪装成「文件不存在」,而后续动作(建目录、写文件)会在另一个地方以完全不相干的错误爆出来。
- **L309–L316 `timestamp` 是 ISO 字符串,不是毫秒数。** 与 pi-ai `Message.timestamp`(毫秒 number)混用会得到 `NaN`。同一个 `MessageEntry` 里两种表示并存(`entry.timestamp` 是字符串,`entry.message.timestamp` 是数字)。
- **L355 `CompactionEntry.firstKeptEntryId` 指不到时会静默丢历史。** 若它不在 compaction 之前的路径上(跨 fork、或落在另一条分支),`defaultContextEntryTransform` 会把压缩点之前的条目整段丢弃,只剩一条摘要,**没有任何告警**。
- **L382 / L389 `custom` 与 `custom_message` 语义相反。** 前者默认**不**进模型上下文(要注册 `entryProjectors`),后者默认进。名字只差一个词。
- **L397 `CustomMessageEntry.display` 只影响 UI。** `convertToLlm` 忽略它,`display: false` 的内容照样进 LLM(全景篇 §6.1)。
- **L484 `createEntryId()` 不预留 id。** 并发调两个 `Session.append*` 一定拿到同一个 `parentId` → **意外分叉而不是链**。harness 用 FIFO 串行 flush 规避,直接用 `Session` 的调用方必须自己串行。
- **L836 `PendingSessionWrite` 有 11 个变体,`flushPendingSessionWrites` 只处理 9 个。** `compaction` 与 `branch_summary` 两个变体在 flush 的 if-else 链里**没有分支**,而 `shift()` 在链外无条件执行 —— 真往队列里 push 一条这样的写入,它会被**静默丢弃**(不会死循环,但也永远不落盘)。另外那 9 个里只有 4 个有生产者(`message` / `model_change` / `thinking_level_change` / `active_tools_change`),其余 5 个是死代码或未来预留。
- **L893 `thinkingLevel` 默认 `"off"` = 把 reasoning 从请求里摘掉。** 见 §12。这不是「用模型的默认档位」,是「显式关闭」。
- **L927 `CompactResult` 与 `harness.compact()` 的返回类型是两份手写的相同结构。** `agent-harness.ts:802-804` 把四个字段原地展开写,没有引用这个类型名。改一处不会带动另一处,typecheck 也不会提醒。
- **L1133 / L1147 `SessionBeforeCompactEvent.signal` 与 `SessionBeforeTreeEvent.signal` 是永不 abort 的占位信号。**(`agent-harness.ts:821` / `:872` 都是现造的 `new AbortController().signal`。)拿它做超时或取消一定不生效。
- **L1169 / L1188 `source: "set" | "restore"` 中的 `"restore"` 永远不会出现。**【与类型不符】`createTurnState` 根本没读 `buildContext()` 返回的 `model` / `thinkingLevel` / `activeToolNames`,「从会话恢复配置」在当前 harness 里没有实现。
- **L1299 那 11 个值为 `undefined` 的键是「类型上能注册、运行时不触发」。**【与 CLAUDE.md 不符】根 `CLAUDE.md` 说是「十个」,实际 **11 个** —— 漏掉了 `resources_update`。以代码为准。
- **L1274 `ToolResultPatch.terminate` 只能补 undefined、不能抹 true。** loop 侧用 `??` 合并;而且最终是整批**全票通过**才终止循环。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `@earendil-works/pi-ai`(`types.ts`) | `ImageContent` / `Model` / `Models` / `SimpleStreamOptions` / `TextContent` / `Transport` —— 全部 `import type` |
| 它 import | `packages/agent/src/types.ts` | `AgentEvent` / `AgentMessage` / `AgentTool` / `QueueMode` / `ThinkingLevel` |
| 它 import | `harness/session/session.ts` | `Session`(与该文件互为循环引用,靠 `import type` 解开) |
| import 它 | `harness/agent-harness.ts` | 最大消费者:16 个类型 + 5 个值(`AgentHarnessError` / `BranchSummaryError` / `CompactionError` / `SessionError` / `toError`) |
| import 它 | `harness/session/{session,jsonl-storage,jsonl-repo,memory-storage,memory-repo,repo-utils}.ts` | 条目形状、`SessionStorage` / `SessionRepo` 契约、`SessionError` |
| import 它 | `harness/env/nodejs.ts` | `ExecutionEnv` 的唯一实现;`FileError` / `ExecutionError` / `ok` / `err` / `toError` |
| import 它 | `harness/compaction/{compaction,branch-summarization,utils}.ts` | `CompactionPreparation` / `CompactionSettings` / `FileOperations` / `BranchSummaryResult` / `Result` |
| import 它 | `harness/{skills,system-prompt,prompt-templates}.ts` | `Skill` / `PromptTemplate` |
| import 它 | `packages/coding-agent/src/core/tools/*.ts` | 每个工具工厂的第一个参数:`FileSystem`(read/write/edit/file-mutation-queue)或 `ExecutionEnv`(bash/flash/gdb/log/datasheet/examples…) |
| import 它 | `packages/coding-agent/src/core/resources.ts` | `FileSystem` / `Skill` |
| import 它 | `packages/coding-agent/src/acp/session.ts` | `AgentHarnessEvent`(`harness.subscribe` 的载荷) |
| import 它 | `packages/kernel/src/host/session-manager.ts` | `AgentHarnessEvent` / `JsonlSessionMetadata` |
| 兄弟(同层) | `harness/agent-harness.ts` | 契约的**实现方**;这个文件说「长什么样」,那个文件说「怎么动」 |
| 兄弟(同层) | `harness/messages.ts` | 另一半契约:四个自定义消息角色的声明合并 + `convertToLlm`(唯一 LLM 边界) |

---

## 7. 自测题

**Q1.** 把 `PendingSessionWrite` 改写成下面这样,会发生什么?

```ts
export type PendingSessionWrite = Omit<SessionTreeEntry, "id" | "parentId" | "timestamp">;
```

<details><summary>答案</summary>

联合会**塌成交集**。`Omit<A | B, "k">` 先对 `A | B` 求键集合的交集(所有成员共有的键)再剔除,于是只剩下 `type` 一个字段 —— `MessageEntry.message`、`ModelChangeEntry.provider/modelId`、`LabelEntry.targetId` 全部消失。

直接后果:`this.pendingSessionWrites.push({ type: "model_change", provider, modelId })` 会因为多了未知属性而报错;而 `flushPendingSessionWrites` 里的 `write.message` / `write.provider` 会全部变成「属性不存在」。原写法用**裸类型参数的条件类型**触发联合分发,让每个变体各自 `Omit`,这是唯一能保住各分支独有字段的写法。

</details>

**Q2.** 你想在压缩真正发生时记一条日志,于是写了:

```ts
harness.on("session_compact", (e) => { logger.info("compacted", e.compactionEntry.id); });
```

typecheck 全绿,跑起来却一条日志都没有。为什么?怎么改?

<details><summary>答案</summary>

`session_compact` 走 `emitOwn` 发出(`agent-harness.ts:840`),而 `emitOwn` 与 `emitAny` 的函数体逐字节相同 —— **都只遍历 `"*"`(订阅者)桶**,不看按事件类型分的桶。`on()` 注册的 handler 进的是 `handlers.get("session_compact")` 这个桶,永远不会被遍历到。

`AgentHarnessEventResultMap` 里有这个键,所以 typecheck 拦不住你。判断方法:**看它在这张表里的值是不是 `undefined`** —— 值为 `undefined` 的 11 个键全是走 `emitOwn` 的死路径。

改法:用 `subscribe()` 加一个类型分支。

```ts
harness.subscribe((e) => { if (e.type === "session_compact") logger.info("compacted", e.compactionEntry.id); });
```

</details>

**Q3.** `FileSystem.exists()` 的签名如果从 `Promise<Result<boolean, FileError>>` 简化成 `Promise<boolean>`,能省掉一大堆 `if (!r.ok)`。这么改会在什么场景下出事?

<details><summary>答案</summary>

「文件不存在」与「问不出来」被压成同一个 `false`。最典型的出事场景是**权限**:一个目录 `EACCES` 时 `exists()` 返回 `false`,调用方于是判定「还没建过」并去 `createDir` / `writeFile`,那一步又会以另一种错误爆出来 —— 错误信息指向的是写入失败,而真正的原因是读权限,排查方向整个偏掉。

同类的还有 abort:被 `AbortSignal` 掐掉时也会退化成 `false`,于是一次用户取消看起来像一次「文件确实不在」。

这条设计与 §8 里 `ExecutionErrorCode` 没有 `nonzero_exit` 是**同一种思路的两面**:该进成功侧的进成功侧(退出码),该分开的必须分开(不存在 vs 问不出来)。

</details>

**Q4.** `SessionContext` 有 `thinkingLevel` / `model` / `activeToolNames` 三个字段,`Session.buildContext()` 也确实把它们算出来了。那么下面这个说法对不对:「重开一个老会话时,harness 会自动恢复上次用的模型和思考档位」?

<details><summary>答案</summary>

**不对。** `createTurnState()`(`agent-harness.ts:335`)只取了 `context.messages`:

```ts
const context = await this.session.buildContext();
...
return { messages: context.messages, ... model: this.model, thinkingLevel: this.thinkingLevel, ... };
```

`model` 和 `thinkingLevel` 用的是 harness 自己的字段 —— 也就是构造时由宿主传进来的那个。会话里推导出来的三个配置字段在 harness 这一层**根本没被读**。

这也解释了 `ModelUpdateEvent.source` 里那个 `"restore"` 为什么从来没有产生者:恢复这条路径没有实现。真正做「重开会话时恢复模型」的是宿主(桌面端的 `SessionManager`),它自己去读会话再调 `setModel`。

</details>

**Q5.** `AgentHarnessStreamOptionsPatch` 为什么要把 `headers` 和 `metadata` 从 `Partial<AgentHarnessStreamOptions>` 里 `Omit` 掉再重新声明一遍?直接用 `Partial` 不行吗?

<details><summary>答案</summary>

因为这两个字段的**补丁语义与其余字段不同**。

其余五个字段(`transport` / `timeoutMs` / `maxRetries` / `maxRetryDelayMs` / `cacheRetention`)是「整体替换」,`Partial` 就够了。而 `headers` / `metadata` 是**逐键合并**的,并且需要表达「删掉某一个键」这个动作 —— 于是值类型必须放宽成 `string | undefined`(原类型是 `Record<string, string>`,写不进 `undefined`)。

配套的实现前提是 `agent-harness.ts:95` 用 `Object.hasOwn(patch, "headers")` 而不是 `patch.headers !== undefined` 来判断,这样三种意图才区分得开:不写这个键 = 不动;`headers: undefined` = 清空全部;`headers: {k: undefined}` = 只删 k。改成 `!== undefined` 判断,「显式清空」就退化成「什么也没做」。

</details>
