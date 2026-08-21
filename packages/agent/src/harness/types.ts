// harness 类型总仓,随里程碑逐步补入:M5 会话树 + FileSystem(已全)、
// M7 harness 骨架(错误/能力/选项,施工中)。
// 参考 pi-minimal harness/types.ts(838 行)。SessionRepo 家族(M5 Step 5)已随会话恢复补入。

/**
 * 一句话职责:agent 包「会话外壳(harness)」这一层的**契约总仓** —— 几乎全是 type /
 * interface / 错误类,只有 5 个可执行函数(ok / err / getOrThrow / getOrUndefined /
 * toError),而且这 5 个都只是 Result 的搬运工。它自己不做任何业务动作。
 *
 * 三个先解释的名词(本文档假定读者没接触过 agent 内核):
 * - **harness(会话外壳)**:把「一次 prompt」包装成「一个有状态、能长期使用的会话对象」
 *   的那一层。实现是 agent-harness.ts,它自己**没有循环**,只是 runAgentLoop 的高级调用者。
 * - **compaction(上下文压缩)**:对话太长撑不下模型上下文窗口时,把靠前的一段历史换成
 *   一份摘要。本仓的做法是「只改投影不改历史」—— 摘要是往会话树上**追加**的一条条目。
 * - **hook(钩子)**:注册进 harness 的回调。与「纯观察的订阅者(listener)」的区别是
 *   **返回值会被消费**,能改变 harness 的行为(改上下文、挡工具、替换请求体……)。
 *
 * 它在全景链路上的位置:**不在任何一跳上,而是每一跳的词汇表**。
 * 全景篇 §4 的 48 步里,第 3 步(createTurnState → session.buildContext)吃 SessionContext /
 * SessionStorage / SessionTreeEntry;第 7-8 步(createLoopConfig / createStreamFn)吃
 * AgentHarnessStreamOptions 与本文件末尾那张 hook 返回值表;第 26/37 步(落盘与 save point)
 * 吃 PendingSessionWrite;第 33 步(工具执行)吃 ExecutionEnv;第 47 步(自动压缩)吃
 * CompactionPreparation / CompactResult。删掉这个文件,agent 包整层编译不过。
 *
 * 对应学习文档:docs/learn/agent/harness_types.md
 *
 * 分节索引:
 *   §1  导入与 Result 契约(失败是数据不是异常)
 *   §2  SessionError:会话子系统的错误码
 *   §3  FileSystem 能力:永不 throw 的文件系统接口
 *   §4  会话树条目:11 种 entry 与它们的联合
 *   §5  读侧投影与 SessionStorage:一个会话怎么读写
 *   §6  SessionRepo 家族:一堆会话怎么建/找/开/删/fork
 *   §7  资源类型:Skill 与 PromptTemplate
 *   §8  harness 错误家族:四个错误类与顶层分类码
 *   §9  provider 请求选项与它的补丁形状
 *   §10 Shell 与 ExecutionEnv:碰真实机器的唯一出口
 *   §11 相位机与挂起写入
 *   §12 harness 装配选项(构造参数)
 *   §13 M8 数据形状:压缩与树导航的输入输出
 *   §14 harness 自有事件词汇表
 *   §15 hook 返回值契约(on() 能改什么)
 */

// ── §1 导入与 Result 契约(失败是数据不是异常)──────────────────────────────

// 全部是 `import type`:本文件编译后**不产生任何 import 语句**,于是它可以被浏览器侧
// 打包、也不会把 pi-ai 的运行时拖进来。Session 这一条是与 session.ts 的循环引用,
// 仅因为是类型导入才不成环。
import type { ImageContent, Model, Models, SimpleStreamOptions, TextContent, Transport } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { Session } from "./session/session.ts";

// 判别联合(discriminated union),判别字段是 `ok`。写成联合而不是
// `{ ok: boolean; value?: T; error?: E }` 的理由:后者在 `if (r.ok)` 之后 value 仍是
// `T | undefined`,调用方要么加非空断言要么再判一次;联合则由 TypeScript 自动收窄。
/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

// ok/err 只是两个字面量工厂。它们存在的价值是让实现方写 `return err(new FileError(...))`
// 而不用手写 `as const` 去把 `ok: false` 钉成字面量类型。
/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

// Result 世界 ↔ throw 世界的显式关口。生产代码里几乎不用它 —— 全仓调用点集中在
// packages/agent/test 与 packages/coding-agent/test(测试里写 `getOrThrow(await env.writeFile(...))`
// 比逐个 `if (!r.ok)` 干净得多)。生产侧的同类关口是
// session/repo-utils.ts 的 getFileSystemResultOrThrow,它额外把 FileError 翻成 SessionError。
/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

// `TValue extends object` 这条约束是刻意的:如果允许 boolean/number/string,
// `getOrUndefined(await fs.exists(p))` 在「存在性为 false」和「调用失败」两种情形下
// 都返回一个假值,调用方 `if (!x)` 会把两者混为一谈。约束成对象就没有这个歧义。
// 【死导出】全仓(含测试)零调用点 —— 是从上游 pi 一起搬过来的,留着不碍事。
/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

// JS 的 `throw` 什么都能扔(字符串、数字、undefined、一个普通对象)。凡是要把捕获物
// 当作 `cause` 挂到自己的错误上、或者读它的 `.message`,都必须先过这一道归一化。
// 调用点分布见 agent-harness.ts:145(normalizeHarnessError)、env/nodejs.ts:100(toFileError)、
// jsonl-storage.ts:67/105 —— 三处都是「外部世界的异常进入本层」的边界。
/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	// 兜底顺序是刻意的:先试 JSON.stringify 保住结构化信息(`{code:"ENOENT"}` 比
	// `[object Object]` 有用得多)。
	try {
		return new Error(JSON.stringify(error));
	} catch {
		// stringify 会在循环引用、BigInt、带 toJSON 抛错的对象上抛 —— 这时才退到 String()。
		// 删掉这个 catch 的后果:一个循环引用的异常会让归一化函数**自己**抛出去,
		// 把原始错误彻底吃掉。
		return new Error(String(error));
	}
}

// ── §2 SessionError:会话子系统的错误码 ─────────────────────────────────────

// 稳定的、与后端无关的分类码。调用方(尤其是 UI)按码分支,不按 message 文本分支
// —— 文本是给人看的,随时会改。
// 【现状】只有 3 个码有生产产生者:not_found(8 处)、invalid_session(7 处)、
// invalid_fork_target(2 处);invalid_entry 由 jsonl-storage.ts:54 的 invalidEntry() 工厂产出;
// storage 由 repo-utils.ts:27 产出;**unknown 全仓零产生者**。
export type SessionErrorCode =
	| "not_found"
	| "invalid_session"
	| "invalid_entry"
	| "invalid_fork_target"
	| "storage"
	| "unknown";

/** Error thrown by session storage, repositories, and session tree operations. */
export class SessionError extends Error {
	/** Session subsystem error code. */
	public code: SessionErrorCode;

	// `cause === undefined ? undefined : { cause }` 这个三元不是啰嗦:Error 的第二参
	// 只要**存在**就会写下 `cause` 属性,直接传 `{ cause }` 会在无因错误上留一个
	// `cause: undefined` 的自有属性,序列化/断言时多出一个字段。四个错误类写法一致。
	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		// 显式写 name:类名在压缩/打包后不可靠,而 `err.name` 是跨进程判别错误种类的
		// 最后一根稻草(见根 CLAUDE.md「contextBridge 会把 Error 剥成一句话」)。
		this.name = "SessionError";
		this.code = code;
	}
}

// ── §3 FileSystem 能力:永不 throw 的文件系统接口 ───────────────────────────

// ---------------------------------------------------------------------------
// FileSystem 能力(M6 首付,Step 4 的磁盘存储需要):所有操作永不 throw,
// 失败编码为 Result<T, FileError>。Shell/ExecutionEnv 等 M6 再补。
// ---------------------------------------------------------------------------

// 只有三种。注意**没有 block device / fifo / socket** —— NodeExecutionEnv 遇到这些
// 会返回 FileError("invalid", "Unsupported file type")(env/nodejs.ts:86),而不是硬塞一个种类。
/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

// 「与后端无关」是这组码的全部意义:NodeExecutionEnv 用 toFileError() 把 Node 的 errno
// 映射进来(ENOENT→not_found、EACCES/EPERM→permission_denied、ENOTDIR→not_directory、
// EISDIR→is_directory、ABORT_ERR→aborted),换成远程/沙箱后端时上层工具一行都不用改。
// 【现状】not_supported 没有生产产生者 —— 它是给「这个后端做不到这个操作」预留的
// (例如只读的远程文件系统上的 createTempDir)。
/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
	/** Backend-independent error code. */
	public code: FileErrorCode;
	// 比 SessionError 多出来的这个字段:出错的那个路径。工具层要把它原样念给模型听
	// (「Error: /foo/bar 不存在」),不带路径的错误对模型几乎没有下一步动作价值。
	/** Absolute addressed path associated with the failure, when available. */
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
	/** Basename of {@link path}. */
	name: string;
	// 「syntactically normalized」而不是 canonical:符号链接**不**解引用。要真身得显式
	// 调 canonicalPath()。这条区分是安全相关的 —— 悄悄跟随符号链接会让「限定在 cwd 内」
	// 这类判断失效。
	/** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
	path: string;
	/** Object kind. Symlink targets are not followed; use {@link FileSystem.canonicalPath} explicitly. */
	kind: FileKind;
	/** Size in bytes for the addressed filesystem object. */
	size: number;
	// 毫秒数而不是 Date:这个结构要能过结构化克隆 / JSON 边界(桌面端会把它送去 renderer)。
	/** Modification time as milliseconds since Unix epoch. */
	mtimeMs: number;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Operation methods must never throw or reject —
 * all filesystem failures are encoded in the returned {@link Result}.
 */
// 这是全景篇 §3「能力接口注入」的落点:coding-agent 的 read/write/edit 与 core/resources.ts
// 都只依赖这个接口,**不 import node:fs**。唯一的生产实现是 harness/env/nodejs.ts 的
// NodeExecutionEnv。契约里最要紧的一条写在上面的 JSDoc 里:**永不 throw、永不 reject**
// —— 工具层因此可以无脑 `if (!r.ok) return 给模型的错误文案`,不用到处 try/catch。
export interface FileSystem {
	// 相对路径的锚点。工具工厂收的第一个参数是这个接口而不是一个 cwd 字符串,
	// 正是为了让 cwd 与文件操作绑在同一个对象上、不会各自漂移。
	/** Current working directory for relative paths. */
	cwd: string;

	// 下面这一组带 abortSignal 的方法里,signal 一律是**可选**的:大部分文件操作快到
	// 不值得中断,但 listDir 一个巨大目录、读一个巨大文件时它是唯一的逃生口。
	/** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	// joinPath 走接口而不是直接用 node:path 的理由:路径分隔符属于**目标环境**而不是
	// 跑代码的这台机器(远程 Linux 沙箱 + Windows 宿主时两者不同)。
	/** Join path segments in the filesystem namespace without requiring the result to exist. */
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Read a UTF-8 text file. */
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	// 「读到 maxLines 就停」是一条性能契约而不是建议:JsonlSessionRepo.list() 靠
	// readTextLines({maxLines:1}) 只读会话文件的第一行 header 就列出全部会话,
	// 实现方要是老老实实读全文,列表页会随会话变长而变慢。
	/** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>>;
	/** Read a binary file. */
	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
	// 「creating parent directories when supported」是承重的:write 工具**不自己 mkdir**,
	// 它假定这一步由实现方做(见全景篇 §5.3)。换实现时漏掉这条,写深层新路径会静默失败。
	/** Create or overwrite a file, creating parent directories when supported. */
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	// appendFile 是 JSONL 会话文件的唯一写入方式(header 那一次 writeFile 除外)——
	// 追加是 O(1)、不需要读全文、崩溃最多丢最后一行。
	/** Create or append to a file, creating parent directories when supported. */
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Return metadata for the addressed path without following symlinks. */
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	// 只列**直接**子项、不递归。整个内核没有 glob、没有 grep —— 文件查找靠模型自己
	// 在 bash 里跑 find/ls/rg。别按上游 pi 的印象在这里补一个 glob。
	/** List direct children of a directory without following symlinks. */
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	// 解符号链接的显式入口。file-mutation-queue.ts 用它做「同一个文件」的键规范化:
	// 两个不同路径指向同一个真身时,必须落到同一把锁上。
	/** Return the canonical path for an existing path, resolving symlinks where supported. */
	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	// 注意返回的是 `Result<boolean>` 而不是 `boolean`:**「不存在」和「问不出来」是两回事**。
	// 前者是 `ok:true, value:false`,后者(权限不足等)是 `ok:false`。压成一个 boolean
	// 会让权限问题伪装成「文件不在」,后续动作全错。
	/** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	// 默认值写在 JSDoc 里而不是签名里,因为这是**接口**:默认值由每个实现自己兑现,
	// 类型系统管不到。改实现时这行注释就是唯一的对账依据。
	/** Create a directory. Defaults: `recursive: true`, no abort signal. */
	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	// remove 的两个默认值都是**保守**的(不递归、不强制):删除是不可逆动作,
	// 默认值站在「宁可失败」一侧。
	/** Remove a file or directory. Defaults: `recursive: false`, `force: false`, no abort signal. */
	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** Create a temporary directory and return its absolute path. Defaults: `prefix: "tmp-"`, no abort signal. */
	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	// createTempFile 收的是 options 对象而不是位置参数,因为它有两个同类型的字符串参数
	// (prefix / suffix)—— 位置参数在这种情况下是经典的调用点错位来源。
	/** Create a temporary file and return its absolute path. Defaults: `prefix: ""`, `suffix: ""`, no abort signal. */
	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>>;

	// 唯一一个不返回 Result 的方法:清理**没有**可供调用方处理的失败模式,报了也没用。
	// 【现状】NodeExecutionEnv.cleanup() 的生产路径从来没人调,实际靠「一轮一个子进程 /
	// 内核进程退出」这个进程边界兜底;全仓唯一调用点在单测里。
	/** Release filesystem resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

// ── §4 会话树条目:11 种 entry 与它们的联合 ─────────────────────────────────

// ---------------------------------------------------------------------------
// 会话树条目:每个条目带 {id(UUIDv7), parentId, timestamp},树 = parentId 链接。
// 换模型、压缩、打标签、甚至移动光标(leaf)本身都是追加的条目。
// ---------------------------------------------------------------------------

// 全部 11 种条目的共同底座。三条性质要记住:
// 1) `type` 在这里故意写成宽的 `string`,由每个子接口用字面量收窄 —— 这就是判别联合的判别字段;
// 2) `parentId === null` 的是根;
// 3) timestamp 是 ISO 字符串(`new Date().toISOString()`),不是毫秒数 ——
//    与 pi-ai 的 Message.timestamp(毫秒 number)**不是同一种表示**,别混用。
export interface SessionTreeEntryBase {
	type: string;
	// id 由 storage.createEntryId() 分配。注意它不是完整 uuidv7 而是 `uuidv7().slice(-8)`
	// —— 取的是**纯随机尾部**,因此**不可按 id 排序**(见全景篇 §6.1)。
	id: string;
	parentId: string | null;
	timestamp: string;
}

// 最常见的一种:一条对话消息。AgentMessage = pi-ai 的 Message ∪ 本仓注册的四个自定义角色
// (bashExecution / custom / branchSummary / compactionSummary,见 harness/messages.ts)。
export interface MessageEntry extends SessionTreeEntryBase {
	type: "message";
	message: AgentMessage;
}

// 「换思考档位」也是一条条目 —— 这就是「一切皆条目、只追加、永不删改」。
// 注意字段类型是 `string` 而不是 ThinkingLevel:从磁盘读回来的老会话里可能有当前
// 联合已经不认识的档位名,收窄成联合会让整个会话在解析期炸掉。宽类型在这里是防御。
export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

// 存的是 provider + modelId 两个**字符串**,不是 Model 对象:Model 里有 baseUrl、
// 费率表、兼容开关这些随版本变化的东西,落进历史文件就是永久的技术债。
export interface ModelChangeEntry extends SessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

// 「这一刻哪些工具是启用的」。deriveSessionContextState 扫路径时后写覆盖先写。
export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

// 压缩条目。**它不删任何东西** —— 变短发生在读的时候:
// session.ts 的 defaultContextEntryTransform 找出路径上最后一个 compaction,把结果重排成
// [摘要, firstKeptEntryId..compaction 之间, compaction 之后一切]。磁盘上原文一字不少。
export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	// 保留侧的**第一条**条目 id。如果这个 id 不在 compaction 之前的路径上(属于另一条
	// 分支、或跨 fork 丢了),投影会把压缩点之前的条目整段静默丢弃,没有任何告警。
	firstKeptEntryId: string;
	// 「压之前这次**上下文**有多大」,不是「这个会话历史一共多大」——
	// prepareCompaction 算的是投影之后的消息(已应用上一条 compaction)。
	tokensBefore: number;
	// 泛型槽,内核不解释它。本仓实际放的是 {readFiles, modifiedFiles},下一次压缩会
	// 继承它,好让第三次压缩仍知道两小时前改过哪些文件。
	details?: T;
	// true = 摘要是 session_before_compact hook 直接给的,不是内核调模型生成的。
	// 后果:details 形状不可假定,因此不被下一次压缩继承。
	fromHook?: boolean;
}

// 分支摘要:与压缩是**正交**的两件事。压缩是纵向的(同一条路径太长),
// 分支摘要是横向的(leaf 挪到树上另一处,原来那条分支整个离开投影,先给它留份摘要)。
export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
	type: "branch_summary";
	// session.ts:345 写的是 `entryId ?? "root"`,即「leaf 被挪到的那个目标条目」;
	// 它随摘要一起进 AgentMessage(messages.ts:84),供应用侧标注来源。
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

// 应用自定义的**纯数据**条目:**默认不进模型上下文**,必须注册
// session.ts 的 entryProjectors[customType] 才会被投影成消息。
// 与下面的 custom_message 只差一个词,语义完全相反 —— 这是本区最容易记反的一对。
export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

// 应用自定义的**消息**条目:默认就进上下文。
export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	// 与 pi-ai 的 UserMessage.content 同形:可以是纯文本块,也可以夹图片。
	content: string | (TextContent | ImageContent)[];
	details?: T;
	// 「给不给用户看」。注意这只影响 UI —— convertToLlm 对 custom 角色**忽略 display**,
	// display:false 的内容照样进 LLM(见全景篇 §6.1)。
	display: boolean;
}

// 给**另一条**条目打标签。写成独立条目(而不是改那条条目)是「永不删改」的直接后果。
export interface LabelEntry extends SessionTreeEntryBase {
	type: "label";
	targetId: string;
	// 注意是 `string | undefined` 而不是 `label?: string` —— 必须**显式**写出来。
	// 这样「清除标签」是一个可表达的动作(label: undefined),而不是「忘了填」。
	label: string | undefined;
}

// 会话名。取名 session_info 是历史包袱,已经写进磁盘文件了,改名等于让老会话读不出来。
export interface SessionInfoEntry extends SessionTreeEntryBase {
	type: "session_info"; // legacy name, kept for backwards compatibility
	name?: string;
}

// 把「光标本身」也写成数据。setLeafId(x) 不是改内存变量,而是追加这么一条条目。
// 理由只有一个:JSONL 是追加日志,重开文件靠逐行重放恢复光标;光标只活在内存里的话,
// 重开会话永远回到「最后一条条目」而不是用户上次真正停留的位置。
// 反直觉推论:leaf 条目进了 entries 和 byId,却**永远不会出现在任何一条 getPathToRoot
// 路径里** —— 它是纯粹的日志侧枝。
export interface LeafEntry extends SessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}

// 11 种条目的判别联合。任何拿它做 switch 的地方都必须有 default 分支 ——
// 这个联合会随里程碑变宽,漏一个分支的表现是「某种条目在 UI 里静默消失」。
export type SessionTreeEntry =
	| MessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| LeafEntry;

// ── §5 读侧投影与 SessionStorage:一个会话怎么读写 ──────────────────────────

// 这是「会话树」这堆条目被读出来之后的样子,也是全景篇 §4 第 3 步的产物。
// 注意 messages 与其余三个字段的来路**不同**:配置状态扫的是**完整**路径
// (所以被压掉那段里的 model_change 依然生效),messages 走的是压缩投影。
/** buildContext() 的产物:配置状态扫完整路径推导,消息经 compaction 投影。 */
export interface SessionContext {
	messages: AgentMessage[];
	// 同样是宽的 `string` 而不是 ThinkingLevel,理由见 ThinkingLevelChangeEntry。
	thinkingLevel: string;
	// null = 这条路径上还没有任何 model_change 条目、也没有 assistant 消息可反推。
	model: { provider: string; modelId: string } | null;
	// null 与 [] 不同:null = 从没设置过(用装配时的默认),[] = 明确一个工具都不启用。
	activeToolNames: string[] | null;
}

// 会话的「身份证」:窄到只有两个字段,这样内存实现与磁盘实现能共用同一个 Repo 契约。
export interface SessionMetadata {
	id: string;
	createdAt: string;
}

// 磁盘实现多出来的四个字段。path 是绝对文件路径,parentSessionPath 记 fork 的源文件
// —— 这两个字段就是「会话之间的血缘」的全部记录。
export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

// 「一个会话文件怎么读写」。两套实现:JsonlSessionStorage(落盘,生产)与
// InMemorySessionStorage(测试/浏览器)。Session 类只依赖这一个接口,于是树的语义
// (谁当谁的父、什么时候推进 leaf)只写一遍就同时适用于两者。
// 关键:这一层**只负责存**,不构造树 —— parentId 由 Session.append* 填。
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	/** Persist a leaf entry that records the active session-tree leaf. */
	setLeafId(leafId: string | null): Promise<void>;
	// 注意它**不预留**这个 id,只是查了一下重。append* 里「取 id」与「真正 appendEntry」
	// 之间隔着一个 await getLeafId(),并发调两个 append* 一定会拿到同一个 parentId
	// (→ 意外分叉而不是链)。harness 用 FIFO 串行 flush 规避,直接用 Session 的调用方
	// 要自己保证串行。
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionTreeEntry): Promise<void>;
	getEntry(id: string): Promise<SessionTreeEntry | undefined>;
	// 泛型 + Extract:传 "compaction" 进去,拿回来的就是 CompactionEntry[] 而不是
	// SessionTreeEntry[],调用方省掉一次手写类型守卫。桌面端自动压缩靠它查上次压缩时间。
	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
	// 标签查的是**全部**条目而不是当前路径 —— 别的分支上打的标签也算数。
	getLabel(id: string): Promise<string | undefined>;
	// 「当前对话」= 从 leaf 沿 parentId 一路走到根,再反转成 root→leaf。
	// 传 null 返回空数组(空会话)。
	getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
	// 全部条目(含不在当前路径上的分支、含 leaf 侧枝)。fork 与调试用。
	getEntries(): Promise<SessionTreeEntry[]>;
}

// ── §6 SessionRepo 家族:一堆会话怎么建/找/开/删/fork ───────────────────────

// ---------------------------------------------------------------------------
// SessionRepo 家族(M5 Step 5,对应 pi harness/types.ts 的同名区块):
// storage 管"一个会话文件怎么读写",repo 管"一堆会话怎么建/找/开/删/fork"。
// ---------------------------------------------------------------------------

// 基线创建选项只有一个可选 id(不传就现铸一个 uuidv7)。磁盘实现往下扩。
export interface SessionCreateOptions {
	id?: string;
}

export interface SessionForkOptions {
	// 不传 = 复制整个会话。
	entryId?: string;
	// "at" 含目标条目本身;默认的 "before" 表示「回到发这句话**之前**」,
	// 因此 repo-utils.ts:48 **强制要求目标是一条 user 消息**,取的是 target.parentId。
	// 这就是 CLI/桌面端「编辑上一条消息重发」的底层动作。
	position?: "before" | "at";
	id?: string;
}

// 三个泛型参数分别是:元数据形状、创建选项、列出选项。把它们参数化(而不是写死)
// 的收益是 JsonlSessionRepo 能要求 create 必须带 cwd、list 能按 cwd 过滤,
// 而 InMemorySessionRepo 什么都不要(TListOptions = void)。
export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	// open 收的是元数据而不是 id:磁盘实现要靠 metadata.path 才知道去哪个文件找。
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	// 交叉类型 `SessionForkOptions & TCreateOptions`:fork 既要说「从哪儿切」,
	// 又要满足「建一个新会话」的全部必填项(磁盘实现里就包括 cwd)。
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

// cwd 是**必填**的:JSONL 会话按 cwd 分目录存放(encodeCwd 编码成目录名),
// 没有它就不知道文件该落在哪里。
export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

// 空接口 + extends 的用法:给这一长串泛型实参起个短名字。JsonlSessionRepo 直接
// `implements JsonlSessionRepoApi`,调用点不用重复写三个类型参数。
export interface JsonlSessionRepoApi
	extends SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {}

// ── §7 资源类型:Skill 与 PromptTemplate ────────────────────────────────────

// ---------------------------------------------------------------------------
// M7 资源类型:Skill 与 PromptTemplate
// 技能/模板不是魔法 —— 本质是"被格式化后注入对话的提示词文本"。
// 这里只放数据形状;从磁盘发现/加载(loadSkills 等)是 M9 的事。
// ---------------------------------------------------------------------------

/**
 * Skill loaded from a `SKILL.md` file or provided by an application.
 *
 * `name`, `description`, and `filePath` are inserted into the system prompt in an XML-formatted block.
 */
// 技能是**两级注入**的,这个形状正好对应两级:
// 第一级(每轮都花上下文)= name + description + filePath,由 harness/system-prompt.ts 的
// formatSkillsForSystemPrompt 拼成 <available_skills> 区块;
// 第二级(按需)= content 全文,由模型自己 read 那个路径、或应用调 harness.skill(name) 注入。
// 这个设计是「技能可以写得很长而不炸上下文窗口」的全部原因。
export interface Skill {
	/** Stable skill name used for lookup and model-visible listings. */
	name: string;
	// **唯一硬性要求的 frontmatter 字段**:skills.ts 里缺 description 或全空白的技能会被
	// 静默丢弃(表现是「我明明放了技能却看不见」)。
	/** Short model-visible description of when to use the skill. */
	description: string;
	/** Full skill instructions. */
	content: string;
	// 既是给模型看的位置(让它自己去 read),也是技能内相对路径的解析基准。
	/** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
	filePath: string;
	// 「藏起来但仍可被应用显式调用」。system-prompt.ts:8 在拼列表时 filter 掉它们。
	/** Exclude this skill from model-visible skill lists while still allowing explicit application invocation. */
	disableModelInvocation?: boolean;
}

// 与 Skill 的区别:模板**从不**出现在系统提示词里,只能被显式调用
// (harness.promptFromTemplate(name, args) → formatPromptTemplateInvocation 做 $1/$@ 替换)。
// 【现状】prompt-templates.ts 的磁盘加载器从未实现,全仓没有人往 resources.promptTemplates
// 里填东西,于是 promptFromTemplate() 当前形态下必然抛 Unknown prompt template。
/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
	/** Stable template name used for lookup or application command routing. */
	name: string;
	/** Optional description for command lists or autocomplete. */
	description?: string;
	/** Template content. Argument placeholders are formatted by `formatPromptTemplateInvocation`. */
	content: string;
}

// 泛型参数让应用能带着自己的扩展字段进来(例如给 Skill 加一个 source 标记),
// 而 harness 内部只用到基类型的字段,不会因为多了字段就类型不兼容。
// 加载/重载资源是**应用的事**:harness 只提供 setResources(),不监听文件变化。
// 快照式 —— 建会话时读一次,改了技能文件要重开会话。
/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** Prompt templates available for explicit invocation. */
	promptTemplates?: TPromptTemplate[];
	/** Skills available to the model and explicit skill invocation. */
	skills?: TSkill[];
}

// ── §8 harness 错误家族:四个错误类与顶层分类码 ─────────────────────────────

// ---------------------------------------------------------------------------
// M7 harness 层:错误、执行环境能力、配置选项(Step 2 切片)
// ---------------------------------------------------------------------------

// harness 对外**只抛 AgentHarnessError**,这组码是它的顶层分类。
// normalizeHarnessError(agent-harness.ts:142)把下层错误折进来:SessionError→"session"、
// CompactionError→"compaction"、BranchSummaryError→"branch_summary",其余按调用点给的
// fallbackCode。于是调用方只需要认识这一个错误类。
// 三个最常撞见的:busy(相位不是 idle)、invalid_state(状态不允许,如没有模型)、
// invalid_argument(工具名重复/未知等)。
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

/** Public AgentHarness failure with a stable top-level classification. */
export class AgentHarnessError extends Error {
	public code: AgentHarnessErrorCode;

	constructor(code: AgentHarnessErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentHarnessError";
		this.code = code;
	}
}

// 与 FileErrorCode 同一套思路:后端无关。NodeExecutionEnv 的 settle 判定顺序是
// **回调错误 > 超时 > 中断 > 退出码**,所以一次「超时的同时 onStdout 抛了错」会报
// callback_error 而不是 timeout。
// 注意**没有 nonzero_exit**:非零退出码不是错误,它是 `ok:true` 里的 exitCode 字段
// —— 「烧录器返回 1」在这个产品里是正常结果(多半是没插板子),要连同输出一起给模型看。
/** Stable, backend-independent execution error codes returned by {@link Shell.exec}. */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** Error returned by {@link Shell.exec}. */
export class ExecutionError extends Error {
	/** Backend-independent error code. */
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

// aborted 与 summarization_failed 的分工:前者是用户/上层掐的(不是错误,别报警),
// 后者才是摘要真的没生成出来。navigateTree 就是靠 code === "aborted" 把中断翻成
// `{cancelled: true}` 而不是抛错(agent-harness.ts:889)。
export type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";

/** Error returned by compaction helpers(实现在 M8;错误类型先就位供 harness 归一化)。 */
export class CompactionError extends Error {
	/** Backend-independent error code. */
	public code: CompactionErrorCode;

	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

// 比 CompactionErrorCode 少一个 "unknown" —— 分支摘要的失败面更窄(它不读 session 结构,
// 只对着一段收集好的条目调一次模型)。
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

/** Error returned by branch summarization helpers(实现在 M8)。 */
export class BranchSummaryError extends Error {
	/** Backend-independent error code. */
	public code: BranchSummaryErrorCode;

	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

// ── §9 provider 请求选项与它的补丁形状 ──────────────────────────────────────

// 「curated(精选)」是关键词:pi-ai 的 SimpleStreamOptions 有十几个字段,这里只挑出
// **应用有理由调**的 7 个。signal / reasoning / sessionId / apiKey 不在其中 —— 那些由
// harness 自己按 turn 快照填(agent-harness.ts:386-404),让应用改它们只会制造不一致。
// 「snapshotted per turn」:进入一轮时拷一份进 turn 快照,本轮所有请求读的都是那一份,
// 中途 setStreamOptions() 要到下一轮才生效。
/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
	/** Preferred transport forwarded to the stream function. */
	transport?: Transport;
	/** Provider request timeout in milliseconds. */
	timeoutMs?: number;
	// 这是**SDK 客户端层**的重试次数,不是本仓的「轮级自动重试」。后者住在宿主策略层
	// (kernel/host/retry.ts,3 次 / 2s 起指数退避),两者互不知情。
	/** Maximum provider retry attempts. */
	maxRetries?: number;
	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;
	// 注意这里是 `Record<string, string>`,比 pi-ai 的 ProviderHeaders(`string | null`)窄:
	// harness 不暴露「用 null 抹掉 provider 默认头」这个能力。
	/** Additional request headers merged with auth and lifecycle headers. */
	headers?: Record<string, string>;
	// 用 `SimpleStreamOptions["metadata"]` 索引而不是复述 `Record<string, unknown>`:
	// 上游改了形状这里跟着变,不会漂移。
	/** Provider metadata forwarded with requests. */
	metadata?: SimpleStreamOptions["metadata"];
	/** Provider cache retention hint. */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

// 补丁形状 = 部分选项 + 两个特殊字段被重新声明。
// Omit 掉 headers/metadata 再各自重写,是因为它们的补丁语义与其余字段**不同**:
// 其余字段是「整体替换」,这两个是「逐键合并」。
/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	// 三态语义,由 agent-harness.ts:95 的 `Object.hasOwn` 兑现:
	//   不写这个键        = 不动;
	//   headers: undefined = 清空全部头;
	//   headers: {k: undefined} = 只删 k 这一个头。
	// 用 `in`/`hasOwn` 而不是 `!== undefined` 判断是这套语义成立的**前提**,
	// 改成后者会让「显式清空」变成「什么也没做」。
	/** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
	headers?: Record<string, string | undefined>;
	// 注意 `Record<string, unknown | undefined>` 里的 `| undefined` 在类型层是**冗余**的
	// (unknown 已经含 undefined),留着是为了让读者一眼看出这里的三态语义与 headers 相同。
	/** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
	metadata?: Record<string, unknown | undefined>;
}

// ── §10 Shell 与 ExecutionEnv:碰真实机器的唯一出口 ─────────────────────────

/** Options for {@link Shell.exec}. */
export interface ShellExecOptions {
	/** Working directory for the command. Relative paths are resolved against {@link ExecutionEnv.cwd}. Defaults to {@link ExecutionEnv.cwd}. */
	cwd?: string;
	/** Environment variables for the command. Values override inherited defaults when `inheritEnv` is true. */
	env?: Record<string, string>;
	// 默认 true。NodeExecutionEnv 的 getShellEnv 还会在这一步无条件钉上
	// PYTHONIOENCODING=utf-8 + PYTHONUTF8=1(调用方显式传的值不覆盖)——
	// 中文 Windows 上 Python 默认按 cp936 编码 stdout,而我们按 UTF-8 解管道,
	// 不钉死就是「证据里一片 ????」而退出码完全正常(见根 CLAUDE.md)。
	/** Whether to inherit the execution environment's default variables. Defaults to true. */
	inheritEnv?: boolean;
	// 单位是**秒**,不是毫秒 —— 与同文件里的 timeoutMs 不是一套单位,改代码时最容易错的一处。
	// 不传 = 不超时;bash 工具自己给了 120 秒的默认。
	/** Timeout in seconds. Implementations should return a timeout error when the command exceeds this duration. Defaults to no timeout. */
	timeout?: number;
	/** Abort signal used to terminate the command. Defaults to no abort signal. */
	abortSignal?: AbortSignal;
	// 两个流式回调:工具靠它们把「命令正在打什么」实时喂给 UI。
	// **回调里抛错会被当成 callback_error 并杀掉进程树**(优先级高于超时),
	// 所以别在这里写可能失败的逻辑。
	/** Called with stdout chunks as they are produced. */
	onStdout?: (chunk: string) => void;
	/** Called with stderr chunks as they are produced. */
	onStderr?: (chunk: string) => void;
}

/** Shell execution capability used by the harness(接口先行;NodeExecutionEnv 的 exec 实现在 M6)。 */
export interface Shell {
	// 返回 `Result<{stdout, stderr, exitCode}, ExecutionError>`:退出码在**成功**一侧。
	// 「命令跑完了但返回 1」不是失败,「shell 起不来 / 超时 / 被掐」才是。
	// 实现方必须**杀进程树**而不是杀 shell:模型的命令常是 npm/cmake/openocd 这类会再 fork 的,
	// 只杀 bash 会留下攥着调试探针不放的孤儿 gdbserver,而报错长得和「没插板子」一模一样。
	/** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
	/** Release shell resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

// 两个能力的交叉。工具工厂按需要收窄:read/write/edit 只要 FileSystem,
// bash/flash/gdb 要完整的 ExecutionEnv —— **参数类型本身就是最小权限声明**。
/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}

// ── §11 相位机与挂起写入 ────────────────────────────────────────────────────

// 「相位机而非锁」:prompt / skill / promptFromTemplate / retryLastTurn / compact /
// navigateTree 六个入口开头都是**同步**的 `if (this.phase !== "idle") throw busy`,
// 在第一个 await 之前生效 —— 同一个微任务里连发两次 prompt,第二次必定同步炸。
// 反向的两个:steer() / followUp() 要求 phase **不是** idle;nextTurn() 任何相位都能排。
/** harness 相位机:结构性操作要求 idle,忙时确定性抛 busy,而非排队。 */
export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

/**
 * 挂起写入 = 还没分配 id/parentId/timestamp 三件套的树条目。
 * 条件类型对联合分布式展开,使每个变体各自 Omit(直接 Omit 联合会塌成交集)。
 */
// 展开一下上面第二句:`Omit<A|B, "k">` 会先把 A|B 的键集合求**交**再剔除,结果丢掉
// 各分支独有的字段(MessageEntry 的 message、LabelEntry 的 targetId 全没了)。
// 写成 `T extends U ? ... : never` 这种**裸类型参数**的条件类型,TypeScript 会对联合
// 逐个成员分发,于是得到 `Omit<MessageEntry,...> | Omit<LabelEntry,...> | ...`。
// 外层多套一层 `SessionTreeEntry extends infer TEntry ?` 只是为了拿到一个裸参数 TEntry
// 来触发分发,没有别的作用。
// 【现状】11 个变体里只有 4 个有生产者(message / model_change / thinking_level_change /
// active_tools_change),flushPendingSessionWrites 里另外 5 个分支是死代码或为未来预留。
export type PendingSessionWrite = SessionTreeEntry extends infer TEntry
	? TEntry extends SessionTreeEntry
		? Omit<TEntry, "id" | "parentId" | "timestamp">
		: never
	: never;

// ── §12 harness 装配选项(构造参数)────────────────────────────────────────

// 全景篇 §4 阶段 0 的第 0.8 步就是把这个对象填满交给 `new AgentHarness(...)`。
// 三个泛型参数一路穿到事件类型上,应用因此能在自己的 listener 里拿到扩展后的 Skill/Tool。
export interface AgentHarnessOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	// 必填:碰真实机器的唯一出口。harness 把它原样交给系统提示词回调,工具则在装配期
	// 各自拿到(harness 不负责给工具注入 env)。
	env: ExecutionEnv;
	// 必填,而且**注意它不是泛型的** —— 这里写的是 `Session`(即 Session<SessionMetadata>),
	// 所以 harness 看不见 JsonlSessionMetadata 的 path/cwd。一个 harness = 一个 session。
	session: Session;
	/**
	 * Provider collection used for all model requests (turn streaming,
	 * compaction, branch summarization). Auth resolves through the providers'
	 * auth.
	 */
	// 对应字段在类上是 **readonly** 的:注册表建好之后换不掉。推论是装配期(第 0.1 步)
	// 必须一次把全部有凭据的 provider 注册齐,否则运行中换模型会找不到 provider。
	models: Models;
	// 不传 = 一个工具都没有,模型只能说话。
	tools?: TTool[];
	/**
	 * Concrete resources available to explicit invocation methods and system-prompt callbacks.
	 * Applications own loading/reloading resources and should call `setResources()` with new values.
	 */
	resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
	// 联合类型:常量字符串,或每轮现算的回调。回调形态的意义是让提示词能随
	// 「当前模型 / 当前档位 / 当前启用了哪些工具 / 当前有哪些技能」变化 ——
	// 本仓的 coding-agent 就靠它把技能列表和工具守则拼进去。
	// 都不传时 harness 落到硬编码的 "You are a helpful assistant."(agent-harness.ts:343)。
	systemPrompt?:
		| string
		| ((context: {
				env: ExecutionEnv;
				session: Session;
				model: Model<any>;
				thinkingLevel: ThinkingLevel;
				activeTools: TTool[];
				resources: AgentHarnessResources<TSkill, TPromptTemplate>;
		  }) => string | Promise<string>);
	/** Curated stream/provider request options. Snapshotted at turn start. */
	streamOptions?: AgentHarnessStreamOptions;
	// 必填,且没有默认值 —— 没有模型就没有 agent。
	model: Model<any>;
	// 不传落到 `"off"`,而 `"off"` 会让 createLoopConfig 把 reasoning 整个置 undefined,
	// 即**把 reasoning 从请求里摘掉**。对 reasoning 模型这等于「最强的一档默认关掉,
	// 且没有任何地方提示」—— 桌面端/bench 的 defaultThinkingLevel 注入就是为了补这个洞。
	thinkingLevel?: ThinkingLevel;
	// 不传 = tools 里的全部。传了会被校验:重名报错、名字不在 tools 里也报错。
	activeToolNames?: string[];
	// 两个队列各自的排空模式,默认都是 "one-at-a-time"(每次只取最老的一条)。
	// steering = 飞行中插话(下一次请求前进 transcript,当前这批工具照常执行);
	// followUp = 将停时续摊(agent 本来要停下的那一刻才拉,有货就再来一整轮)。
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

// prompt() 的第二参。目前只有图片一项 —— 文本走第一个位置参数。
export interface AgentHarnessPromptOptions {
	images?: ImageContent[];
}

// abort() 返回被清空的消息,而不是把它们扔掉:应用可以把它们放回输入框。
// 注意 **nextTurn 队列在 abort 后幸存** —— 它是「排给下一轮」的,中断当前轮不该殃及它。
/** abort() 的返回值:被清空的两条队列(nextTurn 队列在 abort 后幸存)。 */
export interface AbortResult {
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

// ── §13 M8 数据形状:压缩与树导航的输入输出 ────────────────────────────────

// ---------------------------------------------------------------------------
// M8 数据形状(compaction/branch-summarization 的输入输出;实现在 M8,
// 类型先就位,让下面的事件联合从今天起就是完整形态)
// ---------------------------------------------------------------------------

// 一次压缩的产物,字段与 CompactionEntry 的前四个一一对应 —— 因为它就是**将要被追加成
// 那条条目的东西**。hook 可以直接返回一个它,替内核省掉一次模型调用。
// 【与代码有一处不一致】harness.compact() 的返回类型是把这四个字段**原地展开**写的
// (agent-harness.ts:802-804),没有引用这个名字;两者结构相同,但改一处不会带动另一处。
export interface CompactResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

export interface NavigateTreeResult {
	// true = 被 hook 取消,或摘要生成被中断。**不是错误** —— 取消是数据不是异常。
	cancelled: boolean;
	/** 目标是 user 消息时,把它的原文交还给应用做"编辑后重发"。 */
	editorText?: string;
	// 只有真生成了摘要才有;不传 summarize 时为 undefined。
	summaryEntry?: BranchSummaryEntry;
}

// 三个数值旋钮。默认值在 compaction.ts:121 的 DEFAULT_COMPACTION_SETTINGS 里,
// 当前是 reserveTokens 16384 / keepRecentTokens 20000。
// reserveTokens = 「留给下一次回答的余量」,阈值 = contextWindow - reserveTokens;
// keepRecentTokens = 「最近多少 token 的对话必须原样保住」。
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

// 用 Set 而不是数组:同一个文件在一轮里可能被读写多次,去重是这里唯一想要的语义。
// 采集规则是**约定优于配置**的 —— utils.ts 只认工具名字面量 read/write/edit,
// 且参数字段必须叫 path;datasheet / flash / gdb / netlist 动过的文件一律不进清单。
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

// prepareCompaction() 的产物:一份「怎么压」的完整计划,算好之后才去调模型。
// 分成「准备」与「执行」两步的收益:session_before_compact hook 能在**花钱之前**
// 看到全部决策并取消它。
export interface CompactionPreparation {
	firstKeptEntryId: string;
	// 要被换成摘要的那一段。
	messagesToSummarize: AgentMessage[];
	// 只在 isSplitTurn 时非空:切点落在一轮**中间**时,[轮起点, 切点) 这段要单独做一份
	// 「前缀摘要」,否则被保留的后半段不知道自己在回答什么问题。
	turnPrefixMessages: AgentMessage[];
	// 注意 isSplitTurn 为 true 而 turnPrefixMessages 为空数组是可能的(切点恰好是
	// branch_summary/custom_message 时),compact() 靠 `isSplitTurn && length > 0` 兜住。
	isSplitTurn: boolean;
	tokensBefore: number;
	// 上一条 compaction 的摘要。有它时 generateSummary 换用 UPDATE 提示词
	// (要求保留既有信息),而不是重新总结一遍 —— 这是连续压缩不逐次遗忘的关键。
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}

// navigateTree 那一侧的同类结构。它**不是** prepareXxx 函数的返回值 —— 由
// agent-harness.ts:861 现场拼出来,类型靠 SessionBeforeTreeEvent 的字段声明反向约束。
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	// 旧 leaf 路径与目标路径的**最深公共祖先**(LCA)。从旧 leaf 到 LCA 这一段就是
	// 「即将离开投影的那条分支」,也就是要摘要的范围。
	commonAncestorId: string | null;
	entriesToSummarize: SessionTreeEntry[];
	// 「用户要不要摘要」的原始意愿。hook 可以无视它直接给一份摘要。
	userWantsSummary: boolean;
	customInstructions?: string;
	// true = 用 customInstructions 整个**替换**默认提示词,而不是追加。
	replaceInstructions?: boolean;
	label?: string;
}

// 分支摘要的产物。比 CompactResult 多两个文件清单、少 firstKeptEntryId ——
// 分支摘要不需要切点(范围由 LCA 界定)。
export interface BranchSummaryResult {
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
}

// ── §14 harness 自有事件词汇表 ──────────────────────────────────────────────

// ---------------------------------------------------------------------------
// M7 harness 事件词汇表。
// 两种消费方式,同一张 handlers 表:subscribe()(通配 listener,纯观察)
// 与 on()(类型化 hook,返回值按 AgentHarnessEventResultMap 被消费、可改行为)。
// ---------------------------------------------------------------------------

// 【本仓最重要的一条运行时事实】emitOwn 与 emitAny 的函数体**逐字节相同**
// (agent-harness.ts:230-238 vs :240-248),都只遍历 "*"(订阅者)桶。
// 于是凡是走 emitOwn 发出的事件,用 `on(type, handler)` 注册的 handler **永远不会触发**。
// 下面每个事件接口上都标了它走哪条路。想听内核事件,一律用 subscribe()。

// 三条队列的快照。任何一条队列进出都会发一次(drainQueuedMessages / steer / followUp / nextTurn)。
// 【emitOwn → on() 不触发】
export interface QueueUpdateEvent {
	type: "queue_update";
	steer: AgentMessage[];
	followUp: AgentMessage[];
	nextTurn: AgentMessage[];
}

// save point = 「本轮的挂起写入已经全部落盘」这一刻,由 turn_end 触发。
// hadPendingMutations 让 UI 知道「刚才那批 setter 现在才真的写进文件」。
// 桌面端就在这里刷新会话列表的 updatedAt(session-manager.ts:656)。
// 【emitOwn → on() 不触发】
export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

// 与 AbortResult 同形,只是包成事件发一遍。【emitOwn → on() 不触发】
export interface AbortEvent {
	type: "abort";
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

// agent_end 之后、phase 归 idle 之后发。nextTurnCount > 0 意味着「还有排着的活」。
// 【emitOwn → on() 不触发】
export interface SettledEvent {
	type: "settled";
	nextTurnCount: number;
}

// 一轮真正开跑之前的最后一道改写机会。**走 emitHook,是活的**:
// 返回 messages 会被**追加**在用户消息之后,返回 systemPrompt 会覆盖本轮系统提示词。
export interface BeforeAgentStartEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

// 每次请求前的上下文改写点。**走 emitHook,是活的**(接的是 loop 的 transformContext)。
// 注意 harness 传进来的是 `[...messages]` 的副本,而且返回值**只喂给本次请求、不写回
// context.messages** —— 想让裁剪持久生效必须走 prepareNextTurn。
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

// 每次 provider 调用前。**是活的,但不走 emitHook** —— 它有专用分发器
// emitBeforeProviderRequest(agent-harness.ts:270),语义也不同:
// emitHook 是「最后一个非 undefined 的返回值胜出」,这里是**逐个 handler 累积打补丁**。
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	model: Model<any>;
	sessionId: string;
	streamOptions: AgentHarnessStreamOptions;
}

// 请求体已经拼好、还没发出去的那一刻。payload 是 `unknown`,因为它的形状取决于
// 是哪家 API(anthropic-messages / openai-completions / openai-responses)。
// 同样有专用分发器(:296),逐个 handler 串接:上一个的返回值是下一个的输入。
export interface BeforeProviderPayloadEvent {
	type: "before_provider_payload";
	model: Model<any>;
	payload: unknown;
}

// HTTP 响应头刚拿到、SSE 还没开始解的那一刻(限流额度、请求 id 都在这儿)。
// 【emitOwn → on() 不触发】—— 想拿它只能 subscribe()。
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

// 工具执行前。**走 emitHook,是活的**,返回 {block:true} 能挡下这次调用。
// 注意 input 是**校验后的对象本体**,就地改它不会重新校验(要挡就返回 block)。
export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

// 工具执行后、结果进 transcript 之前。**走 emitHook,是活的**,可改写四样东西。
export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	// 回给模型的内容,可以夹图片(datasheet 的 view_figure 就靠这条)。
	content: Array<TextContent | ImageContent>;
	// 给 UI / 日志的结构化数据。注意内核侧造的错误结果 details 恒为 `{}`。
	details: unknown;
	isError: boolean;
}

// 压缩执行**之前**。**走 emitHook,是活的**:可取消,也可以直接给一份现成摘要
// (自己调别的模型、走缓存)。
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	// 完整的当前分支条目,给 hook 自己做决策用(preparation 只给了消息)。
	branchEntries: SessionTreeEntry[];
	customInstructions?: string;
	// 【坑】agent-harness.ts:821 传进来的是 `new AbortController().signal` ——
	// 一个**永远不会被 abort 的**全新信号。它现在只是占位,别指望用它取消压缩。
	signal: AbortSignal;
}

// 压缩**已经落盘之后**。【emitOwn → on() 不触发】
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromHook: boolean;
}

// 树导航执行之前。**走 emitHook,是活的**。signal 同样是永不 abort 的占位信号(:872)。
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

// 树导航完成之后。【emitOwn → on() 不触发】
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromHook?: boolean;
}

// 【emitOwn → on() 不触发】
// 【与类型不符】source 的类型写着 "set" | "restore",但全仓**只产生 "set"**
// (agent-harness.ts:964)。"restore"(从会话恢复出的模型)从来没有产生者 ——
// createTurnState 只取 buildContext() 的 messages,压根没读它返回的 model 字段。
export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	// undefined 只可能出现在「构造之后第一次 setModel」之前 —— 而 model 是必填的,
	// 所以实践中它总是有值。类型宽是为了不假设这一点。
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}

// 【emitOwn → on() 不触发】
export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// 四个数组两两成对:工具全集 与 启用集,各给新旧两份。setTools 与 setActiveTools
// 都发这一个事件(所以 toolNames 可能没变而 activeToolNames 变了)。
// 【emitOwn → on() 不触发】;source 同样只可能是 "set"。
export interface ToolsUpdateEvent {
	type: "tools_update";
	toolNames: string[];
	previousToolNames: string[];
	activeToolNames: string[];
	previousActiveToolNames: string[];
	source: "set" | "restore";
}

// 【emitOwn → on() 不触发】
export interface ResourcesUpdateEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "resources_update";
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	previousResources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

// 19 种 harness 自有事件的联合。它与下面 §15 的 AgentHarnessEventResultMap 的键
// **必须一一对应** —— on() 的签名靠 `Extract<AgentHarnessOwnEvent, {type: TType}>`
// 从这里取事件形状,少一个就是 never,多一个就是无法注册。
/** harness 自有事件(区别于向上转发的 loop AgentEvent)。 */
export type AgentHarnessOwnEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> =
	| QueueUpdateEvent
	| SavePointEvent
	| AbortEvent
	| SettledEvent
	| BeforeAgentStartEvent<TSkill, TPromptTemplate>
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderPayloadEvent
	| AfterProviderResponseEvent
	| ToolCallEvent
	| ToolResultEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ResourcesUpdateEvent<TSkill, TPromptTemplate>
	| ToolsUpdateEvent;

// subscribe() 的 listener 参数类型。**注意 on() 用的不是它** —— on() 只接受
// AgentHarnessOwnEvent,也就是说 loop 的 10 种 AgentEvent 根本没法用 on() 注册。
/** subscribe() 听到的全部词汇 = loop 的 10 种 AgentEvent + harness 自有事件。 */
export type AgentHarnessEvent<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate> =
	| AgentEvent
	| AgentHarnessOwnEvent<TSkill, TPromptTemplate>;

// ── §15 hook 返回值契约(on() 能改什么)────────────────────────────────────

// 两个字段都可选:只想改上下文就只返回 messages。整个对象返回 undefined = 什么都不改。
export interface BeforeAgentStartResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

// 这里 messages 是**必填**的:context hook 的返回值只有一个含义 ——
// 「本次请求改用这一份消息」。想不改就整个返回 undefined。
export interface ContextResult {
	messages: AgentMessage[];
}

export interface BeforeProviderRequestResult {
	// 返回的是**补丁**而不是完整选项 —— 补丁语义见 §9 的 AgentHarnessStreamOptionsPatch。
	streamOptions?: AgentHarnessStreamOptionsPatch;
}

// payload 必填:这个 hook 存在的唯一理由就是替换请求体。
export interface BeforeProviderPayloadResult {
	payload: unknown;
}

// reason 会被念给模型听(「这次调用被挡下了,因为……」),所以要写成可执行的下一步。
export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

// 名字叫 Patch 而不是 Result:四个字段全可选,只覆盖你给出的那几样。
export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	// 【坑】loop 侧用 `??` 合并 terminate,所以这里只能把 undefined 补成 true/false,
	// **不能把工具自己声明的 true 抹回 false**。而且 terminate 的最终判定是
	// 整批工具**全票通过**才生效。
	terminate?: boolean;
}

// 两条路二选一:cancel 掉,或者直接把现成的摘要交出来(内核就不去调模型了)。
export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	// 只给 summary + details 两样,不带 readFiles/modifiedFiles ——
	// hook 提供的摘要形状不可假定,所以它的 details 也不会被下游继承。
	summary?: { summary: string; details?: unknown };
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

// 这张表是 on() 的类型骨架:键 = 可注册的事件类型,值 = 该 handler 的返回值类型。
// 值写成 `X | undefined` 而不是 `X?` 是刻意的 —— handler 的返回值不是可选属性,
// 它必须显式返回点什么(undefined 就是「我只是看看」)。
// 值为 `undefined` 的那 11 项**同时**也正是走 emitOwn 的那批:类型上允许你 on() 它们,
// 运行时却永远不会触发。类型系统在这里帮不上忙,只能靠这条注释和 §14 的标注。
/** on(type, handler) 的返回值契约:undefined = 纯观察,非 undefined = 改行为。 */
export type AgentHarnessEventResultMap = {
	before_agent_start: BeforeAgentStartResult | undefined;
	context: ContextResult | undefined;
	before_provider_request: BeforeProviderRequestResult | undefined;
	before_provider_payload: BeforeProviderPayloadResult | undefined;
	after_provider_response: undefined;
	tool_call: ToolCallResult | undefined;
	tool_result: ToolResultPatch | undefined;
	session_before_compact: SessionBeforeCompactResult | undefined;
	session_compact: undefined;
	session_before_tree: SessionBeforeTreeResult | undefined;
	session_tree: undefined;
	model_update: undefined;
	thinking_level_update: undefined;
	resources_update: undefined;
	tools_update: undefined;
	queue_update: undefined;
	save_point: undefined;
	abort: undefined;
	settled: undefined;
};
