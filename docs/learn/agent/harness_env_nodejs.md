# packages/agent/src/harness/env/nodejs.ts

> **档位** A(逐行)· **行数** 1154(加注释前 699)· **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §3 第三组「ExecutionEnv 的『永不 throw』契约」/ 第五组「杀进程树而不是杀 shell」· §4 阶段 0.2 与第 33 步 · §5.2 接线表 · §6.1 · **索引** [README](../README.md)

## 1. 一句话

`ExecutionEnv`(= `FileSystem` + `Shell`)在 Node/Bun 上的唯一实现:内核想碰真实机器 —— 读一个文件、写一条会话记录、起一个 bash 跑烧录命令 —— 都必须从这个类走出去,而且这里的每一个方法都**永不抛异常**,失败一律编码成 `Result`。

---

## 2. 它在全景里的位置

先说三个名词。**harness** 是「会话外壳」,把一次 prompt 变成一串 LLM 请求 + 工具执行(见 `harness/agent-harness.ts`);**tool call**(工具调用)是模型在回话里要求「帮我跑一下 `read`/`bash`」这种结构化请求;**ExecutionEnv** 就是这些工具真正落地到机器上的那个口子。

这个文件在全景篇 §4 的编号时间线上出现**三次**:

- **阶段 0.2「造一个绑定该会话 cwd 的执行环境」** —— 宿主建会话时 `new NodeExecutionEnv({cwd, shellEnv})`,之后整条链路共用这一个实例。它**不读 `process.cwd()`**,cwd 只来自构造参数,所以同一个进程里可以并存多个指向不同工程目录的会话。
- **第 26 步「落盘」** —— `session.appendMessage()` → `JsonlSessionStorage` → 本文件的 `appendFile()`。会话树的持久化只用到本文件的 4 个方法:`readTextFile` / `readTextLines` / `writeFile` / `appendFile`。
- **第 33 步「execute」** —— 模型真的要动手的那一步。`read`/`write`/`edit` 落到本文件的文件方法;`bash` 经 `harness/utils/shell-output.ts` 的 `executeShellWithCapture` 落到本文件的 `exec()`;嵌入式六件套(flash / gdb / log / netlist / …)起子进程也走 `exec()`。

**谁调它:** 上面是产品侧;工程侧是三个宿主自己 `new` 出来的 —— `coding-agent/src/acp.ts:40`(Zed / ACP)、`kernel/src/host/session-manager.ts:195` 与 `:481`(桌面端,`shellEnv` 由工具链解析算出来)、`kernel/src/host/index.ts:171`。**它调谁:** 只调 `node:*`(child_process / fs / os / path / readline / url / crypto)和 `harness/types.ts` 里的契约类型 —— 没有任何反向依赖。

**不存在会怎样:** 内核就只剩「跟模型说话」这一半。工具层拿不到 `FileSystem` 就装配不出 `read`/`write`/`edit`(工具工厂的第一个参数就是这个接口,见全景篇 §3「能力接口注入」),`bash` 与全部嵌入式工具连子进程都起不来,会话树也一个字节都写不进磁盘。反过来说,正因为工具只依赖这个**接口**而不是 `node:fs`,理论上换一个远程 / 沙箱后端时,再写一个 `implements ExecutionEnv` 的类就够了 —— 这也是本文件里 `toFileError` 把 errno 翻成后端无关错误码的全部意义。

---

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| §1 | L1–L76 | 已有的文件头注释 + 本次补的总述块 + 全部 import(只有 `node:*` 与 `../types.ts`) |
| §2 | L77–L114 | `MAX_TIMEOUT_MS` / `MAX_TIMEOUT_SECONDS` / `EXIT_STDIO_GRACE_MS` 三个常量 + `resolveTimeoutMs`(秒 → 毫秒的唯一换算点) |
| §3 | L115–L192 | `resolvePath`(`~` / `file://` / 相对路径)、`fileKindFromStats`、`fileInfoFromStats` |
| §4 | L193–L266 | `isNodeError`、`toFileError`(errno → `FileErrorCode`)、`abortResult`(中断短路)、`pathExists` |
| §5 | L267–L439 | 找一个 bash:`runCommand`、`findBashOnPath`、`ShellConfig`、`isLegacyWslBashPath`、`getBashShellConfig`、`getShellConfig` |
| §6 | L440–L472 | `getShellEnv`:三层环境覆盖 + `inheritEnv` 开关 + 两个 UTF-8 钉子 |
| §7 | L473–L518 | `killProcessTree`:POSIX 进程组 / Windows `taskkill /T` |
| §8 | L519–L619 | `waitForChildProcess`:exit + 双流 end / close / 空闲计时器三条收尾路径 |
| §9 | L620–L660 | `NodeExecutionEnv` 类头、四个字段、构造函数、`absolutePath` |
| §10 | L661–L860 | `exec`:一次命令的完整生命周期(四道守卫 → spawn → 接线 → 四级判定) |
| §11 | L861–L995 | `joinPath` + 五个读写方法:`readTextFile` / `readTextLines` / `readBinaryFile` / `writeFile` / `appendFile` |
| §12 | L996–L1154 | `fileInfo` / `listDir` / `canonicalPath` / `exists` / `createDir` / `remove` / `createTempDir` / `createTempFile` / `cleanup` |

---

## 4. 逐节讲解

### §1 文件头与依赖(L1–L76)

L1–L3 是原作者留下的三行,一句话讲完了这个文件的宪法:

```ts
// M6:NodeExecutionEnv = FileSystem + Shell。
// 核心纪律:方法永不 throw —— 一切失败(包括意外的后端错误)编码为 Result<T, FileError | ExecutionError>,
// Node 的 errno 在 toFileError 里映射为后端无关的错误码。
```

L4–L36 是本次补的总述块(职责、在全景链路上的位置、分节索引)。

`L42–L60` 全是 `node:*`,`L64–L75` 只从 `../types.ts` 拿契约。这条 import 清单本身就是一条设计声明:**这个文件是 agent 包里唯一大量碰 Node 内置模块的实现**,所以它不在浏览器安全的 `src/index.ts` 里,而是由 `src/node.ts` 单独导出(那个文件只有 4 行,唯一的作用就是多导出这一个类)。根入口必须能进浏览器打包 —— 这就是入口二分的理由。

### §2 超时:两个上限常量与秒→毫秒的校验(L77–L114)

```ts
L82–L89
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 子进程 exit 之后再等一小会儿收尾 stdio,避免丢掉最后几个 chunk。 */
const EXIT_STDIO_GRACE_MS = 100;
```

`2_147_483_647` 是 2³¹−1,也是 `setTimeout` 延时的硬上限。**超过它 Node 不是报错,而是打一条 `TimeoutOverflowWarning` 然后把延时截成 1 毫秒** —— 也就是「填一个特别大的超时」在运行时会变成「立刻超时」。这个陷阱太隐蔽,所以下面的 `resolveTimeoutMs` 直接拒绝。`MAX_TIMEOUT_SECONDS` 只用于拼错误文案,写成除法而不是硬编码第二个数字,是为了改上限时两个值不会漂移。

`EXIT_STDIO_GRACE_MS` 的名字容易骗人:它**不是**「exit 之后固定等 100ms」,而是一个**空闲**计时器 —— 见 §8 的 `armIdleTimer`,exit 之后每来一个 chunk 就重新计时。

```ts
L98–L109
function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
```

三点:①`!Number.isFinite` 一次挡掉 `NaN` 与 `±Infinity`,`<= 0` 挡掉 0 和负数(单测 `"rejects invalid timeouts without spawning"` 逐个钉住了这四个值);②返回 `Result` 而不是抛错,因为唯一调用方 `exec` 必须永不 throw;③`timeout * 1000` 是本仓两套时间单位的唯一换算点 —— `ShellExecOptions.timeout` 是**秒**(bash 工具默认 120),而 `AgentHarnessStreamOptions.timeoutMs` 是**毫秒**,改代码时最容易在这里错。

### §3 路径解析与 FileInfo 构造(L115–L192)

```ts
L129–L144
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// 畸形 URL 当作普通路径,保持文件系统方法"永不 throw"的契约。
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
```

`resolvePath` 是本文件**所有**文件方法的第一行。三个分支互斥、按前缀判定:单独一个 `~` 没有后缀,不能走 `slice(2)`,所以必须单列;`~/x` 与(仅 Windows)`~\x` 共用一条,`slice(2)` 正好跳过两个字符的前缀。注意只认**开头**的 `~` —— 路径中间的 `~` 是合法文件名字符。

`file://` 那条必须包 `try`:`fileURLToPath` 对畸形 URL 会**抛**,而本函数不许抛,所以抛了就当普通路径继续走。

最后一行是关键:**相对路径按传进来的 `cwd` 解析,而不是 `process.cwd()`**;已经绝对的也要过一遍 `resolve`,顺带做 `.` / `..` 归一与分隔符统一 —— coding-agent 的 `file-mutation-queue` 拿路径当锁键,依赖「同一个文件在不同写法下得到同一个字符串」这条性质。

```ts
L175–L190
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: path.replace(/\/+$/, "").split("/").pop() ?? path,
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
```

`fileKindFromStats` 只认 file / directory / symlink 三种,**没有兜底分支**:块设备、FIFO、socket 落到 `undefined`,由这里翻成 `FileError("invalid")` —— 不硬塞一个种类,「我不知道这是什么」比猜错好。三个谓词的顺序不影响结论,因为传进来的一律是 `lstat` 的结果(不跟随符号链接),符号链接的 `isFile()` / `isDirectory()` 都是 false。

`mtimeMs` 用毫秒数而不是 `Date`,因为 `FileInfo` 要能过结构化克隆 / JSON 边界(桌面端会把它一路送进 renderer)。

**L185 那行 basename 是本文件最大的一个坑**,见 §5 第 1 条。

### §4 错误归一化:errno → FileError、中断短路、存在性探测(L193–L266)

```ts
L209–L247
function toFileError(error: unknown, path?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	if (isNodeError(error)) {
		const message = error.message;
		switch (error.code) {
			case "ABORT_ERR":  return new FileError("aborted", message, path, cause);
			case "ENOENT":     return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":      return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":    return new FileError("not_directory", message, path, cause);
			case "EISDIR":     return new FileError("is_directory", message, path, cause);
			case "EINVAL":     return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}
```

(上面为了排版把 `case` 折成了一行,源码里是展开的。)

这是本文件最要紧的一个函数:**把 Node 的 errno 翻成后端无关的错误码**。上层工具只认 `not_found` / `permission_denied` / … 这几个字符串,不认 `ENOENT`,所以「换一个远程 / 沙箱后端」在类型上才是可能的。三个细节:

- `error instanceof FileError` 原样透传 —— 二次包装会把 `code` 重置成 `unknown`,把上层的判断毁掉;
- `ABORT_ERR` 必须翻成 `"aborted"`。上层靠这个码把「用户按了停止」和「真的出错了」分开,前者不该报警(见 `harness/types.ts` 里 `CompactionErrorCode` 那条同构的注释);
- `EACCES` 与 `EPERM` 合并成一个码 —— 对模型而言两者的下一步动作相同;
- 兜底那行用的是 `cause.message` 而不是 `error.message`:走到这里的 `error` 未必是 `Error`,只有归一化之后的 `cause` 一定有 `message`。

```ts
L249–L256
function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}
```

返回 `undefined` 而不是 `boolean`,是为了调用方能写成 `const a = abortResult(sig); if (a) return a;` —— 一次判断同时拿到判定和返回值。它存在的理由是:Node 的 fs API 只在**真正发起 I/O 之后**才理会 signal,已经 aborted 的情况下仍会白读一次盘。

### §5 找一个 bash:发现顺序、WSL 垫片、三层候选(L267–L439)

`runCommand`(L278)是一个**极简版**的 spawn 包装:只收 stdout、只等 close、永不 reject。为什么不复用 `exec`?两个理由:`exec` 要处理进程组、abort、流式回调、进程树击杀,对 `which bash` 这种一次性探测全是负担;更要命的是 `exec` 自己要先调 `getShellConfig`,而 `getShellConfig` 又要调 `runCommand` —— 复用就是循环依赖。

```ts
L363–L372
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}
```

Windows 自带的 `C:\Windows\System32\bash.exe` 不是 bash,是一个把命令转交给 WSL 的转发器,**它不接受 `-c`**,只能 `-s` 从 stdin 喂命令。判定刻意收得很死(盘符 + 固定目录 + 精确文件名):宁可漏判也不误判 —— 误判成 stdin 传输会让真正的 bash 收不到命令而一直挂着。先把 `/` 折成 `\` 再小写,是因为 Windows 路径大小写不敏感而调用方可能给混合写法。

`getShellConfig`(L384)的优先级链:

| 顺序 | 候选 | 找不到怎么办 |
|---|---|---|
| 1 | 显式 `shellPath` | **直接报 `shell_unavailable`,不回退** |
| 2 | (Win)`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\...` | 往下 |
| 3 | PATH 上的 bash(`where` / `which`) | 往下 |
| 4 | (POSIX)`/bin/bash` | 往下 |
| 5 | (POSIX)`sh` | —— 兜底,`ok()` 而不是 `err()` |

第 1 条「配了就不再回退」是有意的:用户指名要这个 shell,悄悄换一个会让「我明明配了 MSYS2 却跑成 Git Bash」这类问题无从查起。两个平台分支**不对称** —— Windows 找不到就失败,POSIX 永远有 `sh` 兜底,因为 Windows 上没有一个「一定存在的 POSIX shell」可以退。

```ts
L414–L423
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
```

这段文案值得单独看一眼。它把「搜过哪几个位置」原样列出来,兑现的是全景篇反复强调的那条纪律:**错误信息必须指向下一步动作**。只说「没找到 bash」的话,用户既不知道该装什么,也不知道是不是自己装的那个没被看到。

### §6 子进程环境:继承开关与 UTF-8 钉子(L440–L472)

```ts
L451–L470
	if (!inheritEnv) return { ...extraEnv };
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
	// 中文 Windows 上 Python 在非 TTY 里按 cp936 写 stdout,我们按 UTF-8 解管道,
	// 乱码进报告且不可逆。钉死这两项;调用方显式传入的值不覆盖。
	if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
	if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
```

三层覆盖、后写的赢:`process.env` < `baseEnv`(建 env 时配的 `shellEnv`)< `extraEnv`(本次 `exec` 传的)。桌面端的 `session-manager.ts:481` 用的就是 `baseEnv` 这一层:工具链解析算出的 PATH 前置与 exports 经构造参数灌进来 —— 也正因为它只能在构造时传,那边的注释明确写了「工具链解析必须在 `new NodeExecutionEnv` **之前**拿到结果」。

`inheritEnv: false` 时**前两层一起丢掉**,而且注意这一行在两个 UTF-8 钉子**之前** return:走这条路连 `PYTHONIOENCODING` 都不会被钉上,PATH 也没了(命令得写绝对路径)。单测 `"can replace rather than inherit the default shell environment"` 期望的正是 `"::explicit"`。

两个 UTF-8 钉子是根 `CLAUDE.md` 里那条「证据里一片 `????`」惨案的防线:中文 Windows 上 Python 在 stdout 不是终端时按 cp936 编码,而我们按 UTF-8 解管道,解出来的 U+FFFD **不可逆**,而退出码完全正常 —— 坏掉的恰恰是这套系统的产品:证据。用 `if (!env.X)` 而不是无条件赋值,是为了让调用方显式传入的值优先。

### §7 杀进程树而不是杀 shell(L473–L518)

```ts
L490–L516
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore", detached: true, windowsHide: true,
			});
		} catch { /* 忽略错误。 */ }
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* 进程已经没了。 */ }
	}
```

模型的命令常常是 `npm run dev`、`cmake --build`、`openocd` 这类会再 fork 的东西,只杀 bash 会留下一堆孙进程。这个产品里的具体代价写在全景篇 §3:**孤儿 gdbserver 攥着探针不放,而报错长得和「没插板子」一模一样**。

POSIX 用负 pid 表示「整个进程组」,而这一步能成立**完全依赖** `exec` 里 spawn 时传了 `detached: true`(那会 `setsid`,让子进程自成组长)—— 删掉那个 `detached`,这里就只杀得到 bash 自己。进程组不存在时 `kill` 抛 `ESRCH`,退回杀单个 pid。顺带一提:§5 的 `runCommand` 起的探测进程**没有** `detached`,所以它的超时路径走的就是这条回退。

Windows 没有进程组,改用 `taskkill /T`(连同子孙)`/F`(强制)。它是另起一个进程去杀,所以自己也要 `detached` + `windowsHide`。

`coding-agent/src/core/tools/log.ts:33` 有一份同策的独立实现,注释里明写「与 harness 的 `killProcessTree` 同策」—— 两处必须同解,否则串口 / 探针留孤儿。

### §8 等子进程真正结束:三种收尾方式(L519–L619)

这是本文件最烧脑的一段。核心问题:**「子进程结束了」有三种互不等价的信号。**

| 信号 | 什么时候来 | 什么时候不来 |
|---|---|---|
| `exit` | 子进程本身退出 | —— 一定来 |
| 两条流的 `end` | 管道读到 EOF | 孙进程继承了管道且不退出时永远不来 |
| `close` | 所有 stdio 都关闭 | 同上 |

只听 `close`:`npm run dev &` 这类命令会让它永远不来;只听 `exit`:会丢掉最后几个还在管道里的 chunk。所以三条路并存,谁先到算谁:

```ts
L568–L582
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
```

`armIdleTimer` 每次都先清掉上一个,所以它测的是「距离**最后一次动静**过了多久」,不是「距离 exit 过了多久」;`onData` 只在 `exited` 之后才重置它 —— exit 之前的数据不该延长任何东西,那时候本来就没有计时器在跑。这就是「exit 了但孙进程还占着管道」那条路的兜底。

```ts
L543–L544
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
```

这两行的初值是**条件式**的:stdio 被配成 `"ignore"` 时 `child.stdout` 是 `null`,那一路的 `end` 永远不会来 —— 初值不置 true 的话 `maybeFinalizeAfterExit` 永远凑不齐条件,只能靠空闲计时器慢一拍收尾。

`finalize`(L560)里 `destroy()` 两条流是必需的:走「空闲超时」这条路时流并没有 `end`,不 destroy 就会留下一个还连着孙进程的读端 —— 那正是这条路要解决的问题本身。`cleanup`(L548)摘掉全部监听器,否则 `child` 被 `exec` 的闭包引用着,监听器会一直攥着 stdout 缓冲不放。

最后:**只有 `error` 事件会让这个 Promise reject**(L591–L596),那对应「进程根本没起来」,由 `exec` 翻成 `spawn_error`。正常结束、被杀、空闲收尾一律走 resolve。

### §9 类骨架:字段与构造(L620–L660)

```ts
L631–L654
export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	/** 记录在跑的子进程,cleanup() 时统一杀掉,避免进程泄漏。 */
	private activeChildPids = new Set<number>();

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}
```

一个实例 = 一个绑定了 cwd 的执行环境。四点:

1. **两个可选配置都是建环境时定死的,没有 setter** —— 要换 shell 或换基础环境就得重建 env(桌面端 `session-manager.ts:463` 的注释就是被这条逼出来的)。ACP 那侧要为子目录造一个新 env 时,写的是 `new (this.options.env.constructor as typeof NodeExecutionEnv)({ cwd })`(`acp/agent.ts:418`)。
2. `cwd` **不做校验、也不 resolve**:校验推迟到 `exec`(那时才报得出「工作目录不存在」这条有用的错);传相对路径的话,后续 `resolvePath` 会拿 `process.cwd()` 去补全它。
3. `activeChildPids` 是这个类**唯一**的状态。没有任何缓存 —— shell 发现、路径解析每次现算。
4. `absolutePath`(L657)与 §11 的 `joinPath` 是两个**纯路径运算**:不碰磁盘、不要求路径存在,所以永远 `ok`;声明成 `async` 只是为了兑现接口里的 `Promise` 签名。

### §10 exec:一次命令的完整生命周期(L661–L860)

先记住返回值形状:`Result<{stdout, stderr, exitCode}, ExecutionError>`,**非零退出码在成功一侧**。「烧录器返回 1」在这个产品里是正常结果(多半是没插板子),要连同输出一起给模型看;只有 shell 起不来 / 超时 / 被掐 / 回调抛错才是 `err`。单测 `"returns non-zero command exit codes as successful execution results"` 钉住了这条。

**① 四道快速失败守卫(L678–L703)**

```ts
L680–L693
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
```

全在 spawn 之前:已经中断的 signal、非法的 timeout、找不到 shell、不存在的 cwd。最后那道最值得说 —— 不探的话 `spawn` 会报一个 `ENOENT`,而那个错读起来像「命令不存在」,真正的原因却是目录没了。给模型的文案因此写成 `Working directory does not exist: …\nCannot execute bash commands.`。

**② spawn 与记账(L737–L769)**

```ts
L740–L763
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (child.pid) this.activeChildPids.add(child.pid);
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
```

- `detached` 是 §7 那条 `kill(-pid)` 的前提;
- `env` **必须显式传**:bun 的 `spawn` 省略 `env` 时不认运行时改过的 `process.env`,会按进程启动那一刻的环境解析(根 `CLAUDE.md` 里那条「探到另一个程序而结论看起来完全合理」);
- stdin 只在 WSL 垫片那条路才开管道,否则 `"ignore"` —— 让子进程立刻读到 EOF,交互式命令因此直接结束而不是挂着等输入;
- `child.stdin?.on("error", () => {})` 这个**空处理器不能删**:子进程提前退出时往 stdin 写会触发 EPIPE,没有处理器就是一个未捕获异常,直接把整个内核进程带走。

外面那层 `try/catch` 接的是 spawn 的**同步**失败(参数非法、目标文件不可执行);**异步**失败(ENOENT)由 §8 的 `error` 事件接住,两条最终都归 `spawn_error` —— 单测 `"returns shell unavailable and spawn errors"` 两条都覆盖了。

**③ 计时器、abort 与两条流(L771–L824)**

超时和 abort 都**只负责杀,不负责返回**:前者置 `timedOut = true` 再 `killProcessTree`,后者直接 `killProcessTree`。真正的返回一律等 `waitForChildProcess` —— 否则会在进程还活着时就返回,stdout 也收不全。

abort 监听要挂在 spawn **之后**(`onAbort` 用的是 `child.pid`),而且这里要**再判一次** `aborted`:`getShellConfig` / `access` 那几步有 `await`,用户可能正好在那个窗口里按了停止。

```ts
L804–L811
				try {
					options?.onStdout?.(chunk);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
```

`onStdout` / `onStderr` 是外部代码,可能抛。**抛了不能吞**:记下 `callbackError`、杀掉进程树,最终以 `callback_error` 返回。吞掉的后果是「UI 那侧已经坏了,而命令还在闷头跑」。stderr 分支逐字对称,两条共用同一个 `callbackError` 变量。

**④ 四级判定(L828–L857)**

```ts
L834–L852
					if (callbackError) { settle(err(callbackError)); return; }
					if (timedOut) {
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
						return;
					}
					if (options?.abortSignal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
						return;
					}
					settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
```

顺序是 **回调错误 > 超时 > 中断 > 退出码**,`harness/types.ts` 的 `ExecutionErrorCode` 注释里也写了这条。为什么要定顺序:三种失败可以**同时**成立(比如超时的同一刻 `onStdout` 也抛了错)。回调错误排最前,因为它是我们自己代码的故障;超时排在中断前,因为超时是这条命令自身的属性,而中断是外部动作。

`settle` 本身(L726–L733)还有一处反直觉:`clearTimeout` / `removeEventListener` / 删 pid 三件事在 `if (settled) return` **之前**执行。幂等,但读起来像是有重复清理。

### §11 读与写:五个文件方法(L861–L995)

五个读写方法是同一套三步:`resolvePath` → `abortResult` 短路 → `try/catch` 转 `Result`。只有两个值得展开。

**`readTextLines`(L894)—— maxLines 是性能契约而不是建议**

```ts
L903–L924
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
```

`JsonlSessionRepo.list()` 靠 `readTextLines({maxLines: 1})` 只读会话文件的第一行 header 就列出全部会话 —— 实现方要是老老实实读全文,会话一多列表就卡。所以这里走的是**流**而不是 `readFile`,读够就 `break`。

三处中断检查各有分工:开头一次(省掉一次白读)、循环里每行一次(缓冲在内存里的行也能被打断)、读完再一次(`for-await` 正常结束与被 abort 结束长得一模一样,不补这次判定,一次中断会被报成「成功读到了 N 行」)。

`crlfDelay: Infinity` 让 CR LF 永远算一个行尾 —— 不设的话,CR 和 LF 正好落在两个 chunk 里时会被拆成两次 `line` 事件,读出一行凭空多出来的空行。`finally` 里 `close()` + `destroy()` 都要:前者只停 readline 的解析,底层文件句柄要后者才释放。

**`writeFile` / `appendFile`(L956 / L985)—— 父目录由实现方建**

```ts
L967–L972
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
```

这条是**承重契约**:coding-agent 的 `write` 工具不自己 mkdir,它假定这一步由实现方做(`harness/types.ts` 的 `FileSystem.writeFile` JSDoc 明写「creating parent directories when supported」)。换实现时漏掉这条,「写一个深层新路径」会静默失败。`recursive: true` 让「目录已存在」不算错误,所以不需要先 `exists` 再建 —— 少一次系统调用,也少一个 TOCTOU 窗口。

`appendFile` 是 JSONL 会话文件的**唯一**写入方式(header 那一次 `writeFile` 除外):追加是 O(1)、不需要读全文、崩溃最多丢最后一行。

### §12 元数据、目录、临时文件与 cleanup(L996–L1154)

**`fileInfo` / `listDir` 都用 `lstat`,不跟随符号链接。** 这是安全相关的:悄悄跟随符号链接会让「限定在 cwd 内」这类判断失效。要真身得显式调 `canonicalPath()`(`realpath`)。`jsonl-repo.ts` 的两处过滤正是建立在这条上:列会话文件写的是 `kind !== "directory"`(软链的 kind 是 `"symlink"`,写成 `=== "file"` 会漏掉),而列会话目录写的是 `kind === "directory"`(于是软链目录被滤掉)。

```ts
L1024–L1044
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
```

`withFileTypes: true` 拿到的是 `Dirent`,本可以直接问它类型;这里仍然逐个 `lstat`,是因为还要 `size` 和 `mtimeMs` —— 代价是 N 次系统调用。注意这里的 `entry.name` 来自 `readdir`,是**真正的** basename;而 `fileInfoFromStats` 算出来的那个 `name` 才是 §5 第 1 条那个坑。

两种失败在这里待遇不同:**单项 `lstat` 抛错 → 整个 `listDir` 失败**(悄悄返回一份少了几项的列表会让上层以为目录就是那样);**`fileInfoFromStats` 返回失败(不支持的文件类型)→ 静默跳过**(目录里有个 socket 不该让整次列目录失败)。

```ts
L1071–L1076
	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}
```

返回 `Result<boolean>` 而不是 `boolean`:**「不存在」和「问不出来」是两回事**。压成一个 boolean 会让权限问题伪装成「文件不在」,后续动作全错。副作用:走的是 `lstat`,所以**断链的符号链接算存在**。

`createTempFile`(L1125)的做法是**先建一个专属临时目录、再往里放文件** —— `mkdtemp` 是原子的(内核保证名字不撞),所以文件名可以完全由我们说了算,不必自己防撞名。代价是每个临时文件独占一个目录**而且没人删**(`shell-output.ts:274` 的注释也点了这一条)。

`cleanup()`(L1148)遍历 `activeChildPids` 逐个杀树然后清空。清空是必要的:pid 会被系统复用,对一个已经回收又被复用的 pid 再发 SIGKILL 就是误杀别人。它**不等**进程真的死 —— `killProcessTree` 只是同步发信号。

---

## 5. 会咬人的地方

1. **【实测 bug】`FileInfo.name` 在 Windows 上等于整条绝对路径(L185)。**
   `path.replace(/\/+$/, "").split("/").pop()` 只按 `/` 切,而 `resolvePath` 在 Windows 上产出 `D:\a\b\c.ts`,切不动 → `name` 就是整条路径。实测(本机 Bun on Windows):
   `listDir(".")` 返回 `{ name: "D:\\MyCode\\...\\nodejs.ts", path: "D:\\MyCode\\...\\nodejs.ts" }`。
   已确认的连带后果在 `harness/skills.ts`:`entry.name !== "SKILL.md"`(skills.ts:248)**永不成立** → **目录式技能在 Windows 上整体发现不到**(实测:放一个 `sk/mytool/SKILL.md`,`loadSkills` 返回 `{skills: [], diagnostics: []}`,连一条诊断都没有);同一个循环里的 `entry.name.startsWith(".")` 与 `=== "node_modules"` 过滤(skills.ts:280)也一并失效,于是会递归进 `.git` / `node_modules`。根目录散装 `.md` 那条走的是 `endsWith(".md")`,**碰巧仍然可用**(实测能发现),`jsonl-repo.ts` 的 `endsWith(".jsonl")` 同理侥幸。
   顺带:`loadSkillFromFile(fs, fullPath, dirInfo.name)` 拿到的「父目录名」也是整条路径,表现为诊断文案里的 `does not match parent directory "C:\..."`。

2. **【坑】`code ?? 0` 会把「被信号杀死」伪装成成功(L852)。** 被信号杀死时 exit code 是 `null`。若这次击杀既不是本 env 的超时、也不是它的 abort(例如外部 `kill -9`、或 `cleanup()` 杀的),四级判定全落空,最终返回 `ok({exitCode: 0})` —— 一次被硬杀的命令看起来完全成功。单测 `"cleanup terminates active shell processes"` 期望的正是 `{ok: true}`,这个行为是被钉住的。

3. **【格式承重】`timeout:${options?.timeout}`(L841)是一条被解析的协议字符串。** `coding-agent/src/core/tools/bash.ts:177` 用 `result.executionError.message.split(":")[1]` 把秒数抠出来拼成给模型看的 `Command timed out after N seconds`。改这个字符串要同时改那边,否则模型收到的是一句 `undefined`。

4. **【与接口不符】一批 `abortSignal` 参数在实现里根本不存在。** `harness/types.ts` 给 `absolutePath` / `joinPath` / `appendFile` / `fileInfo` / `canonicalPath` / `exists` 都声明了可选的 `abortSignal`,给 `createDir` / `remove` / `createTempDir` / `createTempFile` 的 options 里也有。本文件的对应实现(L657、L868、L985、L1003、L1056、L1071、L1082、L1096、L1111、L1125)**一个都没收**。TypeScript 允许实现方少收参数,所以编译期毫无提示,运行时表现是「传了 signal 但完全不起作用」。纯路径运算的两个无所谓,`appendFile` 与 `remove` 这种真做 I/O 的要留意。

5. **`getShellConfig` 每次 `exec` 都跑一遍,没有缓存(调用点 L687)。** POSIX 上是 1 次 `access("/bin/bash")`;Windows 上是 1~2 次 `access` + 最坏一次 `spawn("where")`。一轮里模型连着跑几十条 bash 命令时,这笔开销是逐条重复的。

6. **【与注释不符】WSL 垫片分支没有测试。** `test/harness/nodejs-env.test.ts` 的文件头写着「`isLegacyWslBashPath` 的分支改为纯函数单测覆盖」,但 `isLegacyWslBashPath`(L363)**没有 export**,全仓也搜不到任何用例。这条分支目前实际上是零覆盖的,而且它只在 Windows 且 bash 恰好解析到 System32 时才走 —— 改 `exec` 时最容易顺手删掉。

7. **`EXIT_STDIO_GRACE_MS = 100` 是空闲计时器,不是固定宽限(L89 / L574–L581)。** 收到 exit 之后每来一个 chunk 就重新计时。所以一个「exit 了但孙进程持续往管道里写」的命令,可以让 `exec` 一直不返回 —— 这不是 bug,是刻意让它把数据收全,但读代码时容易误算成「最多多等 100ms」。

8. **`exec` 的 abort 检查有一个窗口(L680 vs L787)。** 开头判过之后要 `await getShellConfig` 和 `await access`,这段时间里 abort 不会被立即察觉;`spawn` 照样发生,直到 L787 再判一次才把它杀掉。结果是对的(返回 `aborted`),代价是白起了一个进程。

9. **`cleanup()` 在生产路径上从来没人调(L1148)。** 全仓唯一调用点是单测。实际靠「一轮一个子进程 / 内核进程退出」这个进程边界兜底(全景篇 §6.1 也记了这条)。

10. **【与 CLAUDE.md 不符】** 根 `CLAUDE.md` 说「2026-08-10 删掉判据层之后,我们这边已经没有强制 `PYTHONIOENCODING` 的落点了」。**代码里有**:L468–L469 对**每一次** `exec` 都钉 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`(单测 `"pins PYTHONIOENCODING and PYTHONUTF8..."` 钉住)。所以经 my-pi bash 工具直接跑的 Python 是被保护的;真正没防线的是 agent 脚本里再起的孙进程、以及非 Python 的 GBK 输出。全景篇 §6.0 已经作为「对 CLAUDE.md 的修正」记录了这一条。
    补充一个边界:`inheritEnv: false` 时(L451)**连这两个钉子也没有**。

11. **`readTextLines({maxLines: 0})` 不会报文件不存在(L903)。** 早退在打开文件之前,所以对一个根本不存在的路径也返回 `ok([])`。用它做存在性判断会得到相反的结论。

12. **`runCommand` 的探测进程没有 `detached`(L292–L295)。** 于是它超时时 `killProcessTree` 的 `process.kill(-pid)` 在 POSIX 上通常直接 `ESRCH`,走的是回退分支杀单个 pid。功能上没问题,但「杀树」在这条路上是名不副实的。

---

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `node:child_process` / `crypto` / `fs` / `fs/promises` / `os` / `path` / `readline` / `url` | 唯一大量碰 Node 内置模块的实现文件,因此不进浏览器安全入口 |
| 它 import | `packages/agent/src/harness/types.ts` | 契约来源:`Result` / `ok` / `err` / `toError` / `FileError` / `ExecutionError` / `FileInfo` / `FileKind` / `ShellExecOptions` / `ExecutionEnv` |
| import 它 | `packages/agent/src/node.ts`(:19) | Node 专用入口,唯一比 `index.ts` 多出来的导出就是这个类 |
| import 它 | `packages/coding-agent/src/acp.ts`(:40) | ACP 宿主 `new NodeExecutionEnv({ cwd })`;`acp/agent.ts:418` 用 `env.constructor` 为子目录再造一个 |
| import 它 | `packages/kernel/src/host/session-manager.ts`(:195 / :481)、`host/index.ts`(:171) | 桌面端宿主;`:481` 那次把工具链解析出的 PATH 前置塞进 `shellEnv`(所以解析必须发生在 `new` 之前) |
| 它的消费者(经接口) | `packages/agent/src/harness/session/jsonl-storage.ts` / `jsonl-repo.ts` | 只用 `readTextFile` / `readTextLines` / `writeFile` / `appendFile` / `listDir` / `exists` / `absolutePath` |
| 它的消费者(经接口) | `packages/agent/src/harness/skills.ts` | `listDir` / `fileInfo` / `readTextFile` / `joinPath` / `canonicalPath` —— §5 第 1 条的受害者 |
| 它的消费者(经接口) | `packages/agent/src/harness/utils/shell-output.ts` | `exec` 唯一的包装者:流式回报 + 有界尾巴 + 超限旁落 `createTempFile` |
| 它的消费者(经接口) | `packages/coding-agent/src/core/tools/{read,write,edit,bash}.ts` 与嵌入式六件套 | 工具工厂收的是 `FileSystem` / `ExecutionEnv`,不直接 `import node:fs` |
| 同策独立实现 | `packages/coding-agent/src/core/tools/log.ts`(:33) | 另一份 `killProcessTree`,注释明写「与 harness 的同策」,两处必须同解 |
| 它的测试 | `packages/agent/test/harness/nodejs-env.test.ts` | 19 个用例,只覆盖 Shell/exec;文件系统部分由 `storage.test.ts` / `session.test.ts` / `repo.test.ts` / `skills.test.ts` 间接覆盖 |

---

## 7. 自测题

**Q1.** 把 `exec` 里 `detached: process.platform !== "win32"`(L746)改成 `detached: false`,在 macOS 上跑 `env.exec("(sleep 0.2; touch grandchild-alive) & sleep 60", {abortSignal})` 并立刻 abort,会发生什么?

<details><summary>答案</summary>

`killProcessTree` 的 `process.kill(-pid, "SIGKILL")` 会失败(pid 不是进程组组长,那个组不存在 → `ESRCH`),回退到 `process.kill(pid, "SIGKILL")` 只杀掉 bash 本身。那个 `sleep 0.2` 的孙进程活下来,0.2 秒后照样 `touch grandchild-alive`。单测 `"kills the whole process tree, not just the shell"` 就会红。

真实产品里的对应症状不是一个 marker 文件,而是**孤儿 gdbserver / 烧录器攥着调试探针不放**,下一次操作报 `0xe00002c5` 之类的错,看起来和「没插板子」一模一样。

</details>

**Q2.** 把 `waitForChildProcess` 里 `onData` 的条件(L581)从 `if (exited && !settled)` 改成 `if (!settled)`,会有什么后果?

<details><summary>答案</summary>

`armIdleTimer` 会在**进程还没退出**的时候就开始装计时器。于是一条持续输出但输出有间隙的长命令(比如每 200ms 打一行日志的构建),只要某次间隔超过 `EXIT_STDIO_GRACE_MS`(100ms),`finalize(exitCode)` 就会被触发 —— 而此时 `exitCode` 还是初值 `null`。

结果:`exec` 提前返回 `ok({exitCode: 0})`(`code ?? 0`),stdout 只有前半截,而子进程还在后台继续跑。这正是那个 `exited &&` 前置条件要挡的东西:空闲计时器只有在「已经确认进程退出、只剩管道没关」时才是安全的收尾手段。

</details>

**Q3.** 有人觉得四级判定的顺序不合理,把中断提到最前面:`if (aborted) … else if (callbackError) … else if (timedOut) …`。哪个已有用例会挂?为什么原顺序把「回调错误」排第一?

<details><summary>答案</summary>

`"returns callback errors from exec stream handlers"` 会挂。原因:`onStdout` 抛错时,代码调的是 `onAbort()` 杀进程树,而 `onAbort` 并不 abort 那个 signal —— 所以那条路上 `options.abortSignal` 是 `undefined`,单看这个用例其实两种顺序都能过。真正会挂的是**同时**传了 `abortSignal` 且回调抛错的组合,以及「超时的同一刻回调抛错」。

排第一的理由是归因:`callback_error` 是**我们自己代码**的故障(某个 UI 回调抛了),报成 `timeout` 或 `aborted` 会让人去查命令和网络,而真正要修的是那个回调。`harness/types.ts` 的 `ExecutionErrorCode` 注释也写了同一句话。

</details>

**Q4.** 把 L185 的 basename 计算换成 `node:path` 的 `basename(path)`,能修好 §5 第 1 条的 Windows 技能发现问题吗?这么做的代价是什么?

<details><summary>答案</summary>

能修好本机场景 —— 在 Windows 上 `basename("D:\\a\\b\\SKILL.md")` 返回 `"SKILL.md"`,`skills.ts` 的比较立刻成立。

代价是它**把分隔符语义绑死在了跑代码的这台机器上**。整个 harness 层的纪律是「路径分隔符属于**目标环境**而不是宿主」:`FileSystem.joinPath` 之所以是接口方法而不是让调用方直接用 `node:path`,`skills.ts` 的路径工具之所以是纯字符串实现(全景篇 §6.1 明确写了「别顺手优化成 node:path」),都是同一条理由 —— 未来一个跑在 Windows 宿主上、操作远程 Linux 沙箱的 `ExecutionEnv` 实现,用 `path.win32.basename` 去切 `/home/x/y` 会切错。

对 `NodeExecutionEnv` 这个**本机**实现而言这条顾虑并不成立(它的路径就是本机路径),所以合理的修法是在本文件里把两种分隔符都吃掉(例如 `split(/[\\/]/)`),而不是把 `node:path` 引进那些必须保持后端无关的地方。

</details>

**Q5.** 删掉 `readTextLines` 中 `for await` 之后那次 `abortResult` 检查(L923–L924),什么场景下会看出区别?

<details><summary>答案</summary>

当 abort 恰好发生在「最后一行已经读完、循环刚退出」到「函数返回」之间时。这时循环里的那次检查已经跑完了,而 `createReadStream` 的 signal 也不会再抛(I/O 已结束)。

删掉之后,这次调用会返回 `ok(lines)` —— 一次被用户中断的读取被报成「成功读到了 N 行」。上层拿不到 `aborted` 这个码,就会把它当成有效数据继续用(比如把一份读了一半的会话文件当作完整的)。这与 `exec` 在四级判定里判 `signal` 的**当前状态**(而不是「onAbort 有没有跑过」)是同一条原则:**中断之后拿到的产出不再被当作有效结果。**

</details>
