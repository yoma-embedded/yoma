/**
 * 工具链版本探测:从 `--version` 类输出里抠版本号、按范围语法判定是否满足、
 * 真的跑一次子进程探测拿版本。
 *
 * parseVersion / satisfies 是纯函数;probeVersion 是这个文件里唯一碰子进程的
 * 地方 —— resolve.ts 的探测顺序是"命中一个候选路径就跑一次 probeVersion,
 * 拿到的版本用 satisfies 对 tool.version 判 ok / version-mismatch",这三个
 * 函数只管"一个二进制、一段文本"这一层,候选怎么来(PATH / 已知安装位置 /
 * 注册表)不是这个文件的事。
 *
 * 不引 semver 依赖:清单里的版本范围只有 6 种写法(见 satisfies 的文档注释),
 * 手写比拉一个通用 semver 包来处理我们用不上的 pre-release/build 元数据语法
 * 更小、更好审,这个仓一贯的取舍(根 CLAUDE.md 到处能看到同样的"不为用不上的
 * 通用性引依赖")。
 */

import { type ChildProcess, spawn } from "node:child_process";

// ─── 版本号抽取 ──────────────────────────────────────────────────────────────

// 只认 major.minor(.patch)? —— 最多三段,且第三段是可选的单个分组(不是
// 可重复的 `{0,}` / `+`),这两条都不是随手写的,见 parseVersion 的文档注释。
const VERSION_TOKEN = /\d+\.\d+(?:\.\d+)?/;

/**
 * 从 `--version` 类输出里抠出第一个"看起来像版本号"的 token。
 *
 * 两条规则,都是被真实工具的输出逼出来的(样本见本模块的测试):
 *
 * 1. **先挖掉括号里的内容,再找。**
 *    `arm-none-eabi-gcc (Arm GNU Toolchain 13.2.Rel1) 13.2.1 20231009` 里,
 *    括号里的 "13.2.Rel1" 是发行代号不是编译器版本 —— 天真地找第一个数字串会
 *    先撞上它(第三段 "Rel1" 不是数字,配不上第三段,于是匹配成 "13.2",
 *    比后面真正的 "13.2.1" 更早出现)。挖掉括号,后面这条规则才有意义。
 * 2. **正则只留一个不可重复的可选第三段。**
 *    `GNU gdb (Arm GNU Toolchain 13.2.Rel1) 13.2.90.20231008-git` 的真实版本是
 *    "13.2.90",紧跟着的 "20231008" 是构建日期戳,不是第四位版本号。用
 *    `(?:\.\d+)?`(恰好一个可选分组,不是 `(?:\.\d+)*`)使匹配在啃到 "13.2.90"
 *    之后天然停手,不会连着日期戳一起吞。
 *
 * 括号内容被整块挖掉,所以"版本号只出现在括号里、括号外一片空白"的极端情况会
 * 返回 undefined 而不是把发行代号错认成版本 —— 这是故意的,不是没考虑到。
 *
 * 找不到就返回 undefined,调用方(resolve.ts)把它当"这次没探测到版本"处理,
 * 不是错误:命令可能根本不认 --version,输出的是一段用法说明。
 */
export function parseVersion(text: string): string | undefined {
	const withoutParens = text.replace(/\([^)]*\)/g, " ");
	return VERSION_TOKEN.exec(withoutParens)?.[0];
}

// ─── 版本范围比较 ────────────────────────────────────────────────────────────

/** "13" 这种短版本号要按数值段比较,不是按字符串("9" 用字符串比会排在 "13" 后面)。 */
function segments(version: string): number[] {
	return version.split(".").map((part) => {
		const n = Number.parseInt(part, 10);
		return Number.isFinite(n) ? n : 0;
	});
}

/** -1 / 0 / 1;段数不等时短的一边按 0 补齐到对齐长度再逐段比。 */
function compare(a: string, b: string): number {
	const as = segments(a);
	const bs = segments(b);
	const len = Math.max(as.length, bs.length);
	for (let i = 0; i < len; i++) {
		const x = as[i] ?? 0;
		const y = bs[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * 版本是否落在 range 描述的范围里。语法只有六种,是清单实际会写的全部形状:
 *
 * - `">=X"` `">X"` `"<=X"` `"<X"` —— 常规比较,X 允许任意段数。
 * - `"^X.Y"` —— 大版本号钉死、其余随意:major 必须与 X 相同,且整体 >= X.Y。
 *   这不是完整 semver 的 caret 语义 —— npm 对 0.x/0.0.x 有"往右挪一位再钉死"
 *   的特例(`^0.2.3` 只放行 0.2.x)。工具链版本不会是 0.x(arm-gcc/cmake/ninja/
 *   python/gdb 全是 1 起步的大版本号),照抄那条特例是为一个不会出现的输入
 *   加复杂度,所以没抄:这里统一钉在第一段。
 * - 裸版本(没有前缀)—— 当 `>=` 处理,清单里"至少这个版本"的最常见写法。
 *
 * 段数不等时短的一边按 0 补齐(`"13"` vs `"13.2.1"`,见 compare 的注释)。
 */
export function satisfies(version: string, range: string): boolean {
	const trimmed = range.trim();
	if (trimmed.startsWith(">=")) return compare(version, trimmed.slice(2).trim()) >= 0;
	if (trimmed.startsWith("<=")) return compare(version, trimmed.slice(2).trim()) <= 0;
	if (trimmed.startsWith(">")) return compare(version, trimmed.slice(1).trim()) > 0;
	if (trimmed.startsWith("<")) return compare(version, trimmed.slice(1).trim()) < 0;
	if (trimmed.startsWith("^")) {
		const wanted = trimmed.slice(1).trim();
		if (compare(version, wanted) < 0) return false;
		return (segments(version)[0] ?? 0) === (segments(wanted)[0] ?? 0);
	}
	return compare(version, trimmed) >= 0;
}

// ─── 真实探测 ────────────────────────────────────────────────────────────────

/** 卡住的探针驱动、弹出确认框的安装器,都不该拖住整条工具链解析。 */
export const PROBE_TIMEOUT_MS = 5_000;

/** SIGTERM 之后再等多久才 SIGKILL——只对 POSIX 有意义(见 probeVersion 里的用法)。 */
const FORCE_KILL_GRACE_MS = 2_000;

/**
 * 跑一次 `<bin> --version`,从合并输出里抠版本号。
 *
 * 找不到、起不来、超时一律 resolve(undefined),**不 reject**——这是探测顺序的
 * 最后一步,调用方(resolve.ts)拿 undefined 当"版本未知"处理,不是要捕获的
 * 异常。命中路径本身可能是错的(比如同名但不相干的程序),让整条 resolve 链
 * 因为一次 --version 探测失败就抛出去,代价比"这个工具的版本标未知"大得多。
 */
export function probeVersion(bin: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		let child: ChildProcess;
		try {
			child = spawn(bin, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				// env 必须显式传:bun 的 spawn 省略 env 时按进程启动那一刻的环境解析
				// argv[0],运行时改过的 PATH 对它无效(根 CLAUDE.md「会咬人的地方」
				// 第一条;core/tools/serial.ts:180 的 spawnSync 同一处疤)。这里显式
				// 传一份不会有坏处,即使某个 bun 版本恰好对异步 spawn 不触发这条 ——
				// 省略了就是把正确性押在"这个版本恰好没这个问题"上。
				env: process.env,
				// 桌面端是 GUI 进程,探测版本时不该在用户眼前闪一个控制台窗口。
				windowsHide: true,
			});
		} catch {
			// 极少数平台会在这里同步抛而不是走 'error' 事件(比如参数本身不合法)。
			settle(undefined);
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		// gcc/cmake 把版本打到 stdout,但不是所有工具都这样——旧版本 Python 的
		// --version 就是打 stderr 的,一些 Windows 上的厂商工具同理。两边都收,
		// stdout 优先(parseVersion(stdout) 拿不到才看 stderr),而不是拼在一起
		// 搜:拼接后谁先到只取决于两个流各自的缓冲时机,不该让这种时序噪音决定
		// 搜索起点。
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		// 待清理的定时器,timeout 分支会动态再挂两个(SIGKILL 兜底 + 有界 give-up),
		// 全部 unref 且收进这里,好在任一终态分支里一次性清空,不留悬空定时器。
		const timers: ReturnType<typeof setTimeout>[] = [];
		const after = (ms: number, fn: () => void): void => {
			const t = setTimeout(fn, ms);
			t.unref();
			timers.push(t);
		};
		const clearAll = (): void => {
			for (const t of timers) clearTimeout(t);
		};

		after(PROBE_TIMEOUT_MS, () => {
			// 先只标记、不在这里 settle——resolve 必须等到子进程真的死透(见下面
			// 'close' 分支),不然调用方拿到 undefined 的那一刻,进程可能还没被
			// 操作系统真正回收:实测踩过,探测用的假二进制文件在 Windows 上因此
			// 还被短暂锁着,紧跟着的清理代码删不掉那个目录,报 EBUSY。
			timedOut = true;
			child.kill("SIGTERM");
			// POSIX 上 SIGTERM 可能被忽略,宽限后 SIGKILL 兜底——Windows 的
			// kill() 本来就是无条件 TerminateProcess,这一步在那边是空转。
			after(FORCE_KILL_GRACE_MS, () => child.kill("SIGKILL"));
			// settle 必须有界:两次信号都没能换来 'close'(比如卡在不可中断的
			// 内核态 I/O)也不能让调用方永远等下去——这是"超时…不抛"承诺里
			// 容易漏掉的那一半,光把信号发出去不够,得真的兜住 resolve。
			after(FORCE_KILL_GRACE_MS + 1_000, () => settle(undefined));
		});

		child.on("error", () => {
			// 二进制不存在(ENOENT)、没有执行权限等——不是这一层要报的错。
			clearAll();
			settle(undefined);
		});
		child.on("close", () => {
			clearAll();
			settle(timedOut ? undefined : (parseVersion(stdout) ?? parseVersion(stderr)));
		});
	});
}
