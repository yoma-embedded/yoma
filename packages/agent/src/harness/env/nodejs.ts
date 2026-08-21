// M6:NodeExecutionEnv = FileSystem + Shell。
// 核心纪律:方法永不 throw —— 一切失败(包括意外的后端错误)编码为 Result<T, FileError | ExecutionError>,
// Node 的 errno 在 toFileError 里映射为后端无关的错误码。
/**
 * NodeExecutionEnv —— `ExecutionEnv`(= `FileSystem` + `Shell`)在 Node/Bun 上的唯一实现,
 * 也是整个内核**碰真实机器**(磁盘、子进程)的唯一出口。
 *
 * 它在全景链路上的位置:
 *   - 阶段 0.2「造一个绑定该会话 cwd 的执行环境」—— 宿主建会话时 new 一个,整条链路共用;
 *   - 阶段 5 第 33 步「execute」—— bash 工具经 harness/utils/shell-output.ts 的
 *     executeShellWithCapture 落到本文件的 exec();read/write/edit 与技能 / 上下文发现
 *     落到本文件的文件方法;
 *   - 第 26 步的会话落盘也在这里:JsonlSessionStorage 只用本文件的 4 个方法
 *     (readTextFile / readTextLines / writeFile / appendFile)。
 *   没有这个文件,内核就只剩「跟模型说话」,一个字节都落不了地。
 *
 * 核心纪律(契约写在 harness/types.ts 的 FileSystem / Shell JSDoc 里):**永不 throw、永不 reject**。
 * 一切失败编码成 Result<T, FileError | ExecutionError>,工具层因此可以无脑
 * `if (!r.ok) return 给模型的错误文案`,不必到处 try/catch。
 *
 * 对应学习文档:docs/learn/agent/harness_env_nodejs.md
 *
 * 分节索引:
 *   §1  文件头与依赖
 *   §2  超时:两个上限常量与秒→毫秒的校验
 *   §3  路径解析与 FileInfo 构造
 *   §4  错误归一化:errno → FileError、中断短路、存在性探测
 *   §5  找一个 bash:发现顺序、WSL 垫片、三层候选
 *   §6  子进程环境:继承开关与 UTF-8 钉子
 *   §7  杀进程树而不是杀 shell
 *   §8  等子进程真正结束:三种收尾方式
 *   §9  类骨架:字段与构造
 *   §10 exec:一次命令的完整生命周期
 *   §11 读与写:五个文件方法
 *   §12 元数据、目录、临时文件与 cleanup
 */

// ── §1 文件头与依赖 ─────────────────────────────────────────────────────────

// 这个文件是 agent 包里**唯一**大量 import `node:*` 的实现。正因如此它不在浏览器安全的
// src/index.ts 里,只从 src/node.ts 单独导出 —— 根入口必须能进浏览器打包。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// 契约在 harness/types.ts、实现在这边。Result/ok/err 是返回值形状,FileError / ExecutionError
// 是两族**后端无关**的错误码,ExecutionEnv 是本类要兑现的接口。这条分工就是「换一个远程 /
// 沙箱后端」在类型上成立的全部原因:再写一个 implements ExecutionEnv 的类即可。
import {
	err,
	type ExecutionEnv,
	ExecutionError,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	toError,
} from "../types.ts";

// ── §2 超时:两个上限常量与秒→毫秒的校验 ───────────────────────────────────

// 2_147_483_647 = 2^31-1,是 setTimeout 延时的硬上限。超过它 Node 会打 TimeoutOverflowWarning
// 并把延时**截成 1 毫秒** —— 也就是「填一个特别大的超时」会变成「立刻超时」。
// 与其把这个陷阱留到运行时,不如在 resolveTimeoutMs 里提前拒绝。
const MAX_TIMEOUT_MS = 2_147_483_647;
// 只用于拼错误文案(≈ 2147483.647 秒 ≈ 24.8 天)。写成除法而不是硬编码第二个数字,
// 是为了改上限时两个值不会漂移。
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
// 这个 100ms 不是「固定宽限」而是一个**空闲**计时器:见 §8 的 armIdleTimer,
// exit 之后每收到一个 chunk 就重新计时,只有真的 100ms 没动静才强制收尾。
/** 子进程 exit 之后再等一小会儿收尾 stdio,避免丢掉最后几个 chunk。 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * 把 ShellExecOptions.timeout(**单位:秒**)换算成 setTimeout 要的毫秒。
 * - 不传 → ok(undefined),表示「不设超时」,exec 里就不装计时器;
 * - 非有限数(NaN / ±Infinity)或 <= 0 → err(timeout),**一个进程都不起**就返回;
 * - 超过 setTimeout 上限 → err(timeout)。
 * 返回 Result 而不是抛错,是因为它的唯一调用方 exec 必须永不 throw。
 */
function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	// !Number.isFinite 一次挡掉 NaN 与 ±Infinity;<= 0 挡掉 0 和负数 ——
	// 「0 秒超时」在语义上是「立刻杀」,当作配置错误比当作「马上超时」对调用方更有用。
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	// 秒 → 毫秒。types.ts 里 ShellExecOptions.timeout 是**秒**、AgentHarnessStreamOptions.timeoutMs
	// 是**毫秒**,两套单位并存,这一行是它们唯一的换算点,也是最容易写错的一处。
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

// ── §3 路径解析与 FileInfo 构造 ────────────────────────────────────────────

/**
 * 把调用方给的路径变成绝对路径,是本文件所有文件方法的第一行。三件事:
 *   1) `~` / `~/x` /(Windows)`~\x` 展开成家目录 —— 只认**开头**的 `~`,路径中间的 `~`
 *      是合法文件名字符,不能碰;
 *   2) `file://` URL 还原成路径(模型或协议那侧可能传 URL 形式);
 *   3) 相对路径按 **env 的 cwd** 解析,而不是 process.cwd()。
 * 第 3 条是「同一个进程里多个会话各有各的工程目录、互不干扰」的兑现处。
 * 纯路径运算、不碰磁盘,所以不会失败(返回 string 而不是 Result)。
 */
function resolvePath(cwd: string, path: string): string {
	// 三个分支互斥且按前缀判定,顺序无所谓;要紧的是 `~` 那两条:单独一个 `~` 没有后缀,
	// 不能走 slice(2),所以必须单列一条分支。slice(2) 正好跳过 `~/` 或 `~\`。
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		// 这里必须 try:fileURLToPath 对畸形 URL 会**抛**,而本函数不许抛。
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// 畸形 URL 当作普通路径,保持文件系统方法"永不 throw"的契约。
		}
	}
	// 已经绝对也要过一遍 resolve:它顺带做 `.` / `..` 归一与分隔符统一,让同一个文件在不同
	// 写法下得到同一个字符串 —— coding-agent 的 file-mutation-queue 拿路径当锁键,依赖这一点。
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * 把 stat 结果收敛成 FileKind 三选一。参数写成结构类型(只要三个谓词方法)而不是 `Stats`,
 * 是为了同时吃 lstat 的 Stats 与 readdir({withFileTypes:true}) 的 Dirent。
 * 返回 undefined = 「不是这三种」(块设备 / FIFO / socket),由调用方翻成 invalid。
 */
function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	// 本文件传进来的一律是 **lstat** 的结果(不跟随符号链接),符号链接的 isFile()/isDirectory()
	// 都是 false,三个谓词天然互斥,顺序不影响结论。真正要紧的是**没有兜底分支**:
	// 认不出来的类型落到 undefined,而不是被硬塞成 "file"。
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

/**
 * stat 结果 → FileInfo。唯一的失败是「文件类型不在三种之内」。
 * mtimeMs 用毫秒数而不是 Date,因为这个结构要能过结构化克隆 / JSON 边界
 * (桌面端会把它一路送进 renderer)。
 */
function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	// 不硬塞一个种类,而是明确报 invalid —— 对调用方来说「我不知道这是什么」比猜错好。
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		// 【坑】basename 是**手算**的,而且只按 `/` 切。harness 层有一条纪律:路径分隔符属于
		// **目标环境**而不是跑代码的这台机器(见 types.ts 的 joinPath 注释、skills.ts 的纯字符串
		// 路径工具),所以不用 node:path 的 basename 是有理由的 —— 但这一行漏了反斜杠。
		// 实测后果:Windows 上 resolvePath 产出 D:\a\b\c.ts,按 `/` 切只得到一段,于是 name
		// **等于整条绝对路径**;skills.ts 的 `entry.name !== "SKILL.md"` 永不成立,目录式技能
		// 整体发现不到。详见学习文档 §5。
		name: path.replace(/\/+$/, "").split("/").pop() ?? path,
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

// ── §4 错误归一化:errno → FileError、中断短路、存在性探测 ──────────────────

/**
 * 判「这是不是一个带 errno 的 Node 错误」。只查 code 字段在不在,不查它是不是字符串 ——
 * 下面的 switch 本来就只认几个字面量,认不出来自然落到 unknown,多一道校验没有收益。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/**
 * **本文件最要紧的一个函数**:把 Node 的 errno 翻成后端无关的 FileErrorCode。
 * 这层翻译就是「换一个远程 / 沙箱文件系统后端」在类型上成立的原因 —— 上层工具只认
 * not_found / permission_denied / … 这几个码,不认 ENOENT。
 * 认不出来的一律落到 "unknown",**绝不重新抛出**。
 */
function toFileError(error: unknown, path?: string): FileError {
	// 已经是 FileError 就原样透传:二次包装会把 code 重置成 unknown,把上层的判断毁掉。
	if (error instanceof FileError) return error;
	// JS 里 throw 什么都可能(字符串、数字、普通对象),先归一化成 Error 才能当 cause 挂上去。
	const cause = toError(error);
	if (isNodeError(error)) {
		const message = error.message;
		switch (error.code) {
			// ABORT_ERR 是 AbortSignal 触发时 fs/promises 抛的码。它必须翻成 "aborted" 而不是
			// unknown:上层靠这个码把「用户按了停止」和「真的出错了」分开,前者不该报警。
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			// EACCES(权限不足)与 EPERM(操作不被允许;Windows 上只读或被占用的文件常见)合并成
			// 同一个码 —— 对模型而言这两种情况的下一步动作是同一个。
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	// 兜底用 cause.message 而不是 error.message:走到这里的 error 未必是 Error,
	// 只有归一化之后的 cause 一定有 message。
	return new FileError("unknown", cause.message, path, cause);
}

/**
 * 中断短路:signal 已经 aborted 就直接给一个 aborted 的失败 Result,否则返回 undefined
 * 表示「没事,接着走」。
 * 返回 undefined 而不是 boolean,是为了调用方能写成
 * `const a = abortResult(sig); if (a) return a;` —— 一次判断同时拿到判定和返回值。
 * 它存在的理由:Node 的 fs API 只在**真正发起 I/O 之后**才理会 signal,已经 aborted 的
 * 情况下仍会白读一次盘。这个函数把那次浪费掐在最前面。
 */
function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/**
 * 「这个路径存在吗」的**内部**版本(不是对外的 FileSystem.exists)。用 access(F_OK) 而不是
 * stat:只问存在性,不需要读元数据。任何异常一律当作「不存在」—— 它只服务于 §5 的 shell
 * 发现,那里「探不出来」和「不在」的下一步动作相同。
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ── §5 找一个 bash:发现顺序、WSL 垫片、三层候选 ────────────────────────────

/** 只用于 shell 发现(which/where),不走 exec 那条完整路径。 */
/**
 * 一个**极简版**的 spawn 包装:只收 stdout、只等 close、永不 reject。
 * 为什么不复用 exec:exec 要处理进程组、abort、流式回调、进程树击杀,对 `which bash`
 * 这种一次性探测全是负担;更要命的是 exec 自己要先调 getShellConfig,而 getShellConfig
 * 又要调这个函数 —— 复用就成了循环依赖。
 * 失败(spawn 同步抛 / 进程 error 事件)统一返回 stdout 为空、status 为 null,
 * 调用方只看 status === 0。
 */
async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	// 注意:这个 resolve 是 Promise 的 resolve,**遮住了**文件顶部从 node:path 引入的同名
	// resolve。函数体内不做路径运算所以是安全的,但在里面加路径代码前得先改名。
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		// spawn 有两条失败路:参数非法之类会**同步抛**,可执行文件不存在则是**异步**的 error
		// 事件。这里接住同步那条,异步那条由下面的 child.on("error") 接。漏掉任何一条,
		// 本函数就会 reject,而它的契约是永不 reject。
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		// 探测也要有超时:PATH 上挂着一个坏掉的 which/where 时,不设超时会把建会话直接卡死。
		// 杀的是进程树而不是单个进程,理由同 §7。
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		// setEncoding("utf8") 之后 data 事件给的是 string 而不是 Buffer —— 跨 chunk 的多字节
		// 字符由 Node 的 StringDecoder 接住,不会像逐 chunk Buffer.toString() 那样劈出 U+FFFD
		// (根 CLAUDE.md 里那条「乱码静默进终报」的坑)。
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		// error 与 close 只会走到一个,但两边都要 clearTimeout:留一个悬着的计时器会让纯 node
		// 环境下的进程多活 5 秒(事件循环里还有 ref 着的句柄)。
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

/**
 * 问系统「PATH 上有没有 bash」。Windows 用 `where bash.exe`,POSIX 用 `which bash`。
 * 5000ms 是拍出来的上限:正常返回在毫秒级,拖到 5 秒说明系统本身出了问题。
 */
async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	// where 可能一次列出多条(Git Bash、WSL 垫片、Cygwin 同时装着),取第一条。
	// `\r?\n` 两种行尾都吃 —— Windows 的 where 输出是 CRLF。
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	// 拿到路径还要再 pathExists 一次:PATH 里留着一条指向已卸载程序的记录时,which/where
	// 照样会把它打印出来,直接拿去 spawn 就是一个 ENOENT。
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

/**
 * 一次 exec 要用的 shell 三件套。commandTransport 只有两种取值:
 *   - 缺省(argv):命令作为 `-c` 的参数传进去;
 *   - "stdin":命令从子进程的标准输入喂进去(见 isLegacyWslBashPath)。
 */
interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/** Windows 自带的 WSL 垫片 bash.exe 不接受 -c,只能从 stdin 喂命令。 */
/**
 * 认出 Windows 自带的 WSL 垫片 C:\Windows\System32\bash.exe(以及 32 位进程看到的
 * Sysnative 别名)。它不是真的 bash,只是一个把命令转交给 WSL 的转发器。
 * 判定刻意收得很死(盘符 + 固定目录 + 精确文件名):宁可漏判也不误判 —— 误判成 stdin
 * 传输会让真正的 bash 收不到命令而一直挂着。
 * 【测试现状】test/harness/nodejs-env.test.ts 头部说这条分支「改为纯函数单测覆盖」,但本
 * 函数没有 export、全仓也找不到对应用例 —— 这条分支目前实际上没有测试。
 */
function isLegacyWslBashPath(path: string): boolean {
	// 先把正斜杠折成反斜杠再小写:Windows 路径大小写不敏感,而调用方可能给的是
	// C:/Windows/System32/bash.exe 这种混合写法。
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/** 按 shell 路径决定命令怎么送进去:WSL 垫片走 `-s` + stdin,其余一律 `-c` + argv。 */
function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

/**
 * 找一个能跑命令的 shell。优先级:显式配置的 shellPath >(Windows)Git Bash 的两个默认
 * 安装位置 > PATH 上的 bash >(POSIX)/bin/bash >(POSIX)sh 兜底。
 * 两点要记住:
 *   1) **每次 exec 都会调一次,没有缓存** —— Windows 上这意味着每条命令都要做 1~2 次
 *      pathExists,最坏还要 spawn 一次 where;
 *   2) Windows 分支找不到就报 shell_unavailable,而 POSIX 分支永远有 sh 兜底。这不对称是
 *      有原因的:Windows 上没有一个「一定存在的 POSIX shell」可以退。
 */
async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		// 显式配置优先,而且**配了就不再回退**:用户指名要这个 shell,悄悄换一个会让
		// 「我明明配了 MSYS2 却跑成 Git Bash」这类问题无从查起。
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	// Windows:先试 Git for Windows 的两个安装位置。ProgramFiles / ProgramFiles(x86) 从环境
	// 变量读而不是硬编码 C:\Program Files —— 非英文系统上这两个目录名会变。
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		// 装了 Cygwin / MSYS2 / Scoop 的机器上 bash 不在 Git 的目录里,退回问 PATH。
		// 这一步可能挑中 System32 的 WSL 垫片,所以 getBashShellConfig 还要再判一次传输方式。
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		// 报错文案把「搜过哪几个位置」原样列出来。全景篇的纪律:**错误信息必须指向下一步动作** ——
		// 只说「没找到 bash」的话,用户既不知道该装什么,也不知道是不是自己装的那个没被看到。
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	// POSIX:/bin/bash 是最常见的位置,直接命中就不必再 spawn 一次 which。
	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	// 最后的兜底是 sh 这个**裸名字**,而且不再检查它存不存在:POSIX 系统上 /bin/sh 是标准
	// 要求的,真没有的话让 spawn 去报 spawn_error 比在这里编一个错更诚实。
	// 注意它是 ok(...) —— 「退化到 sh」不是失败,只是没有 bash 的扩展语法(数组、[[ ]] 等)。
	return ok({ shell: "sh", args: ["-c"] });
}

// ── §6 子进程环境:继承开关与 UTF-8 钉子 ───────────────────────────────────

/**
 * 算出子进程的环境变量表。三层覆盖,后写的赢:
 *   process.env(当前进程) < baseEnv(建 env 时配的 shellEnv) < extraEnv(本次 exec 传的)。
 * 单测 "can replace rather than inherit the default shell environment" 钉住了这个语义。
 */
function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	// inheritEnv:false 时**前两层一起丢掉**,只留本次显式传入的。注意这一行在下面两个
	// UTF-8 钉子**之前** return:走这条路连 PYTHONIOENCODING/PYTHONUTF8 都不会被钉上,
	// 而且 PATH 也没了 —— 命令得写绝对路径。
	if (!inheritEnv) return { ...extraEnv };
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
	// 中文 Windows 上 Python 在非 TTY 里按 cp936 写 stdout,我们按 UTF-8 解管道,
	// 乱码进报告且不可逆。钉死这两项;调用方显式传入的值不覆盖。
	// 用 `if (!env.X)` 而不是无条件赋值:调用方显式传入的值优先。副作用是空串也算「没设」
	// (空字符串是 falsy),会被覆盖成 utf-8 / 1。
	// 这两行是全景篇 §6.0 那条「对 CLAUDE.md 的修正」的落点:根 CLAUDE.md 说删掉判据层之后
	// 已经没有强制编码的落点了,而代码里有 —— 经 my-pi bash 工具跑的 Python 是被保护的,
	// 真正没防线的是 agent 脚本里再起的孙进程、以及非 Python 的 GBK 输出。
	if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
	if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
	return env;
}

// ── §7 杀进程树而不是杀 shell ──────────────────────────────────────────────

/**
 * 杀整棵进程树,而不是只杀 shell 本身 —— 否则 `npm run dev` 这类命令的孙子进程会变成孤儿。
 * POSIX 靠 detached 建立进程组后 kill(-pid);Windows 用 taskkill /T。
 */
/**
 * 参数是 spawn 出来的那个 pid(在 exec 里就是 bash 自己)。
 * 这个产品里的具体代价写在全景篇 §3:只杀 bash 会留下攥着调试探针不放的孤儿 gdbserver,
 * 而那个报错长得和「没插板子」一模一样。
 * 无返回值、永不抛 —— 超时 / abort / 回调抛错三条路都调它,它自己失败不能连累主流程。
 * 注意 coding-agent 的 core/tools/log.ts 有一份同策的独立实现,两处必须同解。
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			// Windows 没有进程组的概念,只能靠 taskkill 的 /T(连同子孙)+ /F(强制)。
			// 它是**另起一个进程**去杀,所以自己也要 detached + windowsHide,否则会闪一个控制台窗口,
			// 而且会被当前进程的生命周期牵连。
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// 忽略错误。
		}
		return;
	}

	try {
		// POSIX:负的 pid 表示「整个进程组」。这一步能成立**完全依赖** exec 里 spawn 时传了
		// detached: true(那会 setsid,让子进程自成组长)。删掉那个 detached,这里就只杀得到
		// bash 自己,孙进程照样活着。
		process.kill(-pid, "SIGKILL");
	} catch {
		// 进程组不存在(子进程没起来、或它已经自己退了)时 kill 会抛 ESRCH,退回杀单个 pid。
		// 顺带一提:runCommand 起的探测进程**没有** detached,所以它的超时路径走的就是这条回退。
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已经没了。
		}
	}
}

// ── §8 等子进程真正结束:三种收尾方式 ──────────────────────────────────────

/**
 * 等子进程真正结束。比直接听 "close" 复杂,是因为要覆盖三种收尾方式:
 * exit + 两个流都 end(正常)、close(兜底)、以及 exit 之后 stdio 迟迟不 end
 * (孙子进程还占着管道)——最后一种靠 EXIT_STDIO_GRACE_MS 的空闲计时器强制收尾。
 */
/**
 * 返回退出码(被信号杀死时是 null)。**只有 error 事件会让它 reject** —— 那对应「进程根本
 * 没起来」,由 exec 翻成 spawn_error;正常结束、被杀、空闲收尾一律走 resolve。
 *
 * 为什么不能只听 "close":Node 的 "close" 要等所有 stdio 都关闭,而孙进程继承了管道却不
 * 退出时它永远不来(`npm run dev &` 这类);反过来只听 "exit" 又会丢掉最后几个还在管道里
 * 的 chunk。所以三条路并存,谁先到算谁。
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolvePromise, reject) => {
		// settled 是一次性闸门:三条收尾路径都可能到达,先到的赢,后到的静默返回。
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		// stdio 被配成 "ignore" 时 child.stdout/stderr 是 null,那一路的 "end" 事件永远不会来 ——
		// 所以初值直接置 true,否则 maybeFinalizeAfterExit 永远凑不齐条件,只能靠空闲计时器兜底。
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		// 摘监听器 + 清计时器。不摘的后果:child 对象被 exec 的闭包引用着,监听器会一直攥着
		// stdout 缓冲不放,长会话里就是稳定的内存增长。
		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		// finalize 里 destroy 两条流是必需的:走「空闲超时」这条路时流并没有 end,不 destroy
		// 就会留下一个还连着孙进程的读端 —— 那正是这条路要解决的问题本身。
		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise(code);
		};
		// 正常路径:exit 到了、两条流也都 end 了,才算真正干净的收尾。
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		// 空闲计时器:每次调用都先清掉上一个,所以它测的是「距离最后一次动静过了多久」,
		// 而不是「距离 exit 过了多久」。这就是 EXIT_STDIO_GRACE_MS 那条注释的兑现处。
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		// 只在 exit **之后**才重置计时器。exit 之前的数据不该延长任何东西 —— 那时候我们本来
		// 就在等 exit,没有计时器在跑。
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		// exit 只说明**子进程本身**没了,孙进程可能还攥着管道。所以这里除了尝试正常收尾,
		// 还要起空闲计时器兜底,否则 close 不来就永远挂着。
		const onExit = (code: number | null): void => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		// close = 所有 stdio 都关了,这是最干净的信号,直接终局。
		const onClose = (code: number | null): void => finalize(code);

		// 用 once 而不是 on 是有意的:cleanup 里逐个 removeListener,once 能在 cleanup 之前就
		// 自动摘掉大部分。只有 data 必须用 on —— 它要收每一个 chunk。
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

// ── §9 类骨架:字段与构造 ──────────────────────────────────────────────────

/**
 * ExecutionEnv 的唯一生产实现。一个实例 = 一个绑定了 cwd 的执行环境;桌面端 / ACP / bench
 * 在建会话时各 new 一个(全景篇阶段 0.2)。
 *
 * 它**不读 process.cwd()**:cwd 只来自构造参数,所以同一个进程里可以有多个指向不同工程
 * 目录的会话而互不干扰。
 *
 * 类里没有任何缓存(shell 发现、路径解析每次现算),唯一的状态就是 activeChildPids。
 */
export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	// 两个可选配置都是**建环境时**定死的,没有 setter:要换 shell 或换基础环境就得重建 env。
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	// 【现状】cleanup() 在生产路径上从来没人调(全仓唯一调用点是单测),实际靠「一轮一个
	// 子进程 / 内核进程退出」这个进程边界兜底。所以这个集合更像一道没被用上的保险。
	/** 记录在跑的子进程,cleanup() 时统一杀掉,避免进程泄漏。 */
	private activeChildPids = new Set<number>();

	/**
	 * @param options.cwd 相对路径的锚点,也是 exec 的默认工作目录。构造时**不校验它存在**,
	 *   也**不做 resolve** —— 校验推迟到 exec(那时才报得出「工作目录不存在」这条有用的错);
	 *   传相对路径的话,后续 resolvePath 会拿 process.cwd() 去补全它。
	 * @param options.shellPath 显式指定的 bash;不传就走 §5 的自动发现。
	 * @param options.shellEnv 本 env 所有 exec 共用的基础环境变量。
	 */
	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	// absolutePath / joinPath 是两个**纯路径运算**:不碰磁盘、不要求路径存在,所以永远 ok。
	// 声明成 async 只是为了兑现接口里的 Promise 签名。
	/** 按本 env 的 cwd 把路径解析成绝对路径。接口上的 abortSignal 在这里没有实现(纯运算,没有可中断的 I/O)。 */
	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	// ── §10 exec:一次命令的完整生命周期 ───────────────────────────────────────

	/**
	 * 跑一条 shell 命令。它是 bash 工具(经 harness/utils/shell-output.ts)与所有嵌入式工具起
	 * 子进程的唯一入口 —— 全景篇 §4 第 33 步。
	 *
	 * **非零退出码在成功一侧**:ok({stdout, stderr, exitCode: 7})。「烧录器返回 1」在这个产品
	 * 里是正常结果(多半是没插板子),要连同输出一起给模型看;只有 shell 起不来 / 超时 /
	 * 被掐 / 回调抛错才是 err。
	 *
	 * 结构上分四段:① 四道快速失败守卫;② spawn 与记账;③ 计时器、abort 与两条流的接线;
	 * ④ 等进程真的没了之后,按 **回调错误 > 超时 > 中断 > 退出码** 的顺序判定。
	 */
	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		// 快速失败四连,全在 spawn 之前:已经中断的 signal、非法的 timeout、找不到 shell、
		// 不存在的 cwd。放在前面既是为了不白起一个进程,也是为了让错误码更精确。
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		// 本次 cwd 也按 this.cwd 解析 —— options.cwd 允许是相对路径(相对会话的工程目录)。
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		// 先探一次工作目录存不存在。不探的话 spawn 会报一个 ENOENT,而那个错读起来像「命令
		// 不存在」,真正的原因却是目录没了(工程被移走 / 删掉)。这条文案是给模型看的,
		// 必须指向下一步动作。
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		// 从这里进 Promise 执行器。整段是**回调式**的,所以每一个出口都必须经过 settle()。
		return await new Promise((resolvePromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			// 中断 = 杀进程树。注意它**不直接 settle**:真正的返回要等 waitForChildProcess 确认
			// 进程真的没了,否则会在进程还活着时就返回,stdout 也收不全。
			const onAbort = () => {
				if (child?.pid) {
					killProcessTree(child.pid);
				}
			};

			// 唯一出口。注意 clearTimeout / removeEventListener / 删 pid 三件事在 `if (settled) return`
			// **之前**执行:幂等,但顺序读起来反直觉。好处是即使被重复调用,清理也一定做过;
			// 代价是读代码时容易误以为存在重复清理。
			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				if (settled) return;
				settled = true;
				resolvePromise(result);
			};

			// spawn 的**同步**失败(参数非法、目标文件不可执行)在这里接住;**异步**失败(ENOENT)
			// 由 §8 的 error 事件接住,最终也归到 spawn_error。
			try {
				// WSL 垫片那条路:args 里**不带** command,命令随后从 stdin 喂进去。
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						// detached 让子进程自成进程组,killProcessTree 才能用 kill(-pid) 一锅端。
						detached: process.platform !== "win32",
						// 环境变量在这里落定(§6)。这个参数必须显式传:bun 的 spawn 省略 env 时不认运行时
						// 改过的 process.env,会按进程启动那一刻的环境去解析(见根 CLAUDE.md)。
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						// stdin 只在需要从它喂命令时才开管道,否则一律 "ignore" —— 让子进程立刻读到 EOF,
						// 交互式命令因此会直接结束,而不是挂在那里等输入。
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				// 记账要在 spawn 成功之后、任何 await 之前。pid 可能是 undefined(spawn 失败的边界
				// 情况),所以写成 if 而不是直接 add。
				if (child.pid) this.activeChildPids.add(child.pid);
				// stdin 的 error 必须挂一个空处理器:子进程提前退出时往 stdin 写会触发 EPIPE,
				// 没有处理器的话那是一个**未捕获异常**,直接把整个内核进程带走。
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			// 超时只负责「杀」+「记一个标记」,不负责返回结果 —— 同 onAbort,真正的返回等
			// waitForChildProcess。timedOut 这个标记是后面判定顺序的依据。
			timeoutId =
				timeoutMs !== undefined
					? setTimeout(() => {
							timedOut = true;
							if (child?.pid) {
								killProcessTree(child.pid);
							}
						}, timeoutMs)
					: undefined;

			// abort 监听要挂在 spawn 之后:onAbort 用的是 child.pid。
			// 这里再判一次 aborted,是因为 getShellConfig / access 那几步有 await,用户可能正好
			// 在那个窗口里按了停止 —— 只在函数开头判一次会漏掉。
			if (options?.abortSignal) {
				if (options.abortSignal.aborted) {
					onAbort();
				} else {
					options.abortSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// setEncoding 之后 data 给的是 string:跨 chunk 的多字节字符由 Node 的 StringDecoder
			// 接住,不会像逐 chunk Buffer.toString() 那样在字符中间劈开。
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			// 全量累积在内存里 —— exec 本身**不截断**。截断、行数统计、超限旁落临时文件都是
			// harness/utils/shell-output.ts 的事,exec 只负责如实返回。
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				// 回调是外部代码,可能抛。抛了不能吞:记下 callbackError、杀掉进程树,最终以
				// callback_error 返回。吞掉的后果是「UI 那侧已经坏了,而命令还在闷头跑」。
				try {
					options?.onStdout?.(chunk);
				} catch (error) {
					// 回调抛错不能吞:记下来,杀掉进程,最终以 callback_error 返回。
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});
			// stderr 分支与 stdout 逐字对称。两条路共用同一个 callbackError 变量,所以「两个回调
			// 都抛」时后写的赢 —— 无所谓,两条都是 callback_error。
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				try {
					options?.onStderr?.(chunk);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});

			// 这里是**唯一**的收尾入口:无论正常退出、被超时杀、还是被 abort 杀,都要等进程真的
			// 没了才判定结果(见 §8)。前面那个 void 是因为我们不 await 它,只挂 then。
			void waitForChildProcess(child).then(
				(code) => {
					// 判定顺序有讲究:回调错误 > 超时 > 中断 > 正常退出码。
					// 判定顺序为什么是这个:三种失败可以**同时**成立(比如超时的同一刻 onStdout 也抛了
					// 错)。回调错误排最前,因为它是我们自己代码的故障,报出来才有人去修;超时排在中断
					// 前,因为超时是这条命令自身的属性,而中断是外部动作。types.ts 里也写了这条。
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					if (timedOut) {
						// 【格式承重】这条消息形如 timeout:120,coding-agent 的 bash.ts 会 split(":")[1] 把秒数
						// 抠出来拼成给模型看的一句话。改这个字符串要同时改那边。
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
						return;
					}
					// 判的是 signal 的**当前状态**,而不是「onAbort 有没有跑过」。推论:命令刚好在 abort
					// 之前跑完时,结果仍然报 aborted 而不是 ok —— 中断之后拿到的产出不再被当作有效结果。
					if (options?.abortSignal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
						return;
					}
					// 正常出口。`code ?? 0`:被信号杀死时 exit code 是 null,这里折成 0。
					// 【坑】于是「被外部 SIGKILL、但既没超时也没 abort」会伪装成一次成功退出(exitCode 0)。
					settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
				},
				// reject 分支:waitForChildProcess 只在 child 的 "error" 事件上 reject,那对应
				// 「进程根本没起来」(ENOENT / EACCES),归到 spawn_error。
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	// ── §11 读与写:五个文件方法 ───────────────────────────────────────────────

	/**
	 * 纯路径拼接。走接口而不是让调用方直接用 node:path,是因为**分隔符属于目标环境**:
	 * 换成远程 Linux 沙箱后端时,宿主是 Windows 也得拼出 `/` 分隔的路径。
	 * 注意它不做 cwd 解析,拼出来的可能仍是相对路径。
	 */
	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	/**
	 * 读 UTF-8 文本文件。本节五个方法都是同一套三步:resolvePath → abortResult 短路 →
	 * try/catch 转 Result。
	 * abortSignal 同时也交给 Node 的 readFile,所以读一个巨大文件时**中途**也能停
	 * (抛 ABORT_ERR,由 toFileError 翻成 aborted)。
	 */
	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 按行读,maxLines 到了就**停止读盘**。这不是优化建议而是一条性能契约:
	 * JsonlSessionRepo.list() 靠 readTextLines({maxLines:1}) 只读会话文件的第一行 header 就能
	 * 列出全部会话 —— 实现方要是老老实实读全文,会话一多列表就卡。
	 */
	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string[]>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		// maxLines <= 0 直接给空数组:createReadStream 一个不存在的文件本来会报 ENOENT,但
		// 「你要 0 行」这个问题不碰盘就能回答。副作用是这条路**不会**报文件不存在。
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		// 两个句柄声明在 try 外面,finally 才够得着 —— 中途 return(被中断)时也要关。
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			// crlfDelay: Infinity 让 CR LF 永远被当成一个行尾。不设的话,CR 和 LF 正好落在两个
			// chunk 里时会被拆成两次 line 事件,读出一行凭空多出来的空行。
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				// 循环里每行都查一次 signal:上面 createReadStream 也收了 signal,但那条路只在真正
				// 发起 I/O 时才生效;这一行保证「已经缓冲在内存里的那些行」也能被打断。
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			// 读完再查一次:for-await 正常结束与被 abort 结束在这里长得一模一样,不补这次判定,
			// 一次中断会被报成「成功读到了 N 行」。
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			// close() 只停 readline 的解析,底层文件句柄要 stream.destroy() 才释放。漏掉 destroy
			// 的后果是句柄稳定泄漏,长跑的内核进程最终 EMFILE。
			lineReader?.close();
			stream?.destroy();
		}
	}

	/**
	 * 读二进制。与 readTextFile 只差一个 encoding —— 不传 encoding 时 Node 的 readFile 返回
	 * Buffer,而 Buffer 是 Uint8Array 的子类,直接满足签名。
	 */
	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 写文件,**自己建父目录**。这条是承重契约:coding-agent 的 write 工具不自己 mkdir,
	 * 它假定这一步由实现方做(见 types.ts 的 FileSystem.writeFile JSDoc)。
	 * 换实现时漏掉这条,「写一个深层新路径」会静默失败。
	 */
	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// resolve(resolved, "..") 取父目录。recursive:true 让「目录已存在」不算错误,所以不
			// 需要先 exists 再建 —— 少一次系统调用,也少一个 TOCTOU 窗口。
			await mkdir(resolve(resolved, ".."), { recursive: true });
			// mkdir 之后再查一次中断:建目录本身可能很慢(网络盘、深路径),中途按了停止就不该
			// 再往下写。这一步漏掉的话,一次中断仍然会留下一个新建的文件。
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 追加写,同样自己建父目录。**这是 JSONL 会话文件的唯一写入方式**(header 那一次 writeFile
	 * 除外)—— 追加是 O(1)、不需要读全文、崩溃最多丢最后一行。
	 * 【与接口不符】types.ts 的 FileSystem.appendFile 声明了第三个 abortSignal 参数,这里没有
	 * 实现它(TypeScript 允许实现方少收参数),所以传进来的 signal 会被**静默忽略**。
	 */
	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await appendFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	// ── §12 元数据、目录、临时文件与 cleanup ───────────────────────────────────

	/**
	 * 取一个路径的元数据。用 **lstat** 而不是 stat:符号链接**不解引用**,它的 kind 就是
	 * "symlink"。这条区分是安全相关的 —— 悄悄跟随符号链接会让「限定在 cwd 内」这类判断失效。
	 * 要真身请显式调 canonicalPath()。
	 */
	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 只列**直接**子项,不递归,同样不跟随符号链接。
	 * 顺带记一条:整个内核**没有 glob、没有 grep** —— 文件查找靠模型自己在 bash 里跑
	 * find / ls / rg。别按上游 pi 的印象在这里补一个。
	 */
	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// withFileTypes 拿到的是 Dirent,本可以直接问它类型;这里仍然逐个 lstat,是因为还要
			// size 和 mtimeMs。代价是 N 次系统调用,大目录会明显慢。
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			// 逐项 lstat,所以每一项都查一次 signal:列一个几万项的目录是这个接口里少数几个真需要
			// 中途叫停的地方。
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				// 注意 entry.name 来自 readdir 的 Dirent,是**真正的** basename;而下面 fileInfoFromStats
				// 算出来的那个 name 才是只按 `/` 切的版本(§3 的坑)。
				const entryPath = resolve(resolved, entry.name);
				// 单项 lstat 失败(比如条目在两次系统调用之间被删了)会走下面的 catch,让**整个 listDir
				// 失败**。这是保守的选择:悄悄返回一份少了几项的列表,会让上层以为目录本来就是那样。
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					// 但 fileInfoFromStats 自己返回的失败(不支持的文件类型)是**静默跳过**的:目录里有一个
					// socket,不该让整次列目录失败。两种失败在这里待遇不同。
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 解符号链接、拿真身路径。要求路径**已存在**(realpath 对不存在的路径报 ENOENT)。
	 * 主要消费者是 coding-agent 的 file-mutation-queue:两个不同写法的路径指向同一个文件时,
	 * 必须落到同一把锁上,靠的就是这个函数做键规范化。
	 */
	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 返回 Result<boolean> 而不是 boolean:**「不存在」和「问不出来」是两回事**。前者是
	 * ok(false),后者(权限不足等)是 err。压成一个 boolean 会让权限问题伪装成「文件不在」,
	 * 后续动作全错。
	 * 实现上走 fileInfo(即 lstat),所以**断链的符号链接算存在** —— lstat 看的是链接本身。
	 */
	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	/**
	 * 建目录。默认 recursive: true(与 types.ts 的 JSDoc 一致),所以「父目录不存在」和
	 * 「目录已存在」都不算错。接口上的 abortSignal 在这里同样没有实现。
	 */
	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 删文件或目录。两个默认值都是**保守**的:recursive:false(不递归)、force:false(目标
	 * 不存在就报错)。删除不可逆,默认值站在「宁可失败」一侧。
	 */
	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 在系统临时目录下建一个唯一的目录。mkdtemp 是**原子**的(内核保证名字不撞),比「自己
	 * 拼一个随机名再 mkdir」少一个 TOCTOU 竞态。
	 * 注意 prefix 是拼在 tmpdir 后面的**名字前缀**,不是一个子目录。
	 */
	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/**
	 * 建一个临时文件。做法是**先建一个专属的临时目录、再往里放文件** —— 这样文件名完全由
	 * 我们说了算,而 mkdtemp 已经保证目录唯一,不必自己防撞名。
	 * 代价:每个临时文件都独占一个目录,而且没人删。shell-output.ts 的「超限全量旁落」走的
	 * 就是这条路,长会话会在 tmpdir 里留下一堆目录(靠系统清理 tmp 兜底)。
	 */
	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		// 这里固定用 "tmp-",**不**把 options.prefix 传给目录:prefix/suffix 是文件名的一部分
		// (见下一行),与目录名无关。
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		// randomUUID 保证同一个目录里连着建多个文件也不会撞名(虽然目录本来就是新的)。
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	/**
	 * 尽力而为地杀掉本 env 起过的所有子进程。**永不抛**(接口要求),没有返回值。
	 * 【现状】生产路径从来没人调 —— 全仓唯一调用点是 test/harness/nodejs-env.test.ts 的
	 * "cleanup terminates active shell processes"。实际靠「一轮一个子进程 / 内核进程退出」
	 * 这个进程边界兜底。
	 * 注意它**不等**进程真的死:killProcessTree 只是同步发信号,各自的 exec Promise 会在
	 * waitForChildProcess 收尾之后以 ok(exitCode) resolve(既没超时也没 abort)。
	 */
	async cleanup(): Promise<void> {
		// 遍历的是 pid 而不是 child 对象 —— 杀树只需要 pid。
		// 清空是必要的:pid 会被系统复用,对一个已经回收又被复用的 pid 再发 SIGKILL 就是误杀别人。
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
