/**
 * 本机工具链探测的三个"档位":PATH 扫描、平台已知安装位置、Windows 注册表 ——
 * 对应 resolve.ts 探测顺序(local → ledger → env → **path** → **well-known** →
 * **registry** → missing)里第 4~6 档,由 resolve.ts 按顺序调用、逐档尝试。
 * 三个函数共同的纪律:**任何一步 IO 失败都吞掉继续,绝不抛** —— 这里探测失败
 * 的后果最多是"这一档没找到,交给下一档",不该让某个平台目录不存在、没权限、
 * 或 reg.exe 缺席炸掉整条探测链。
 *
 * 不做的事:版本号解析/比较(version.ts 的事)、账本读写(ledger.ts 的事)、把
 * 几档结果攒成最终结论(resolve.ts 的事)。这里只回答"这台机器上,这个名字 /
 * 这个 toolId,可能在哪"。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { PlatformKey } from "./schema.ts";

// ─── PATH 扫描 + PATHEXT 展开 ─────────────────────────────────────────────────

const DEFAULT_PATHEXT = ".EXE;.CMD;.BAT;.COM";

/**
 * env 的键在 Windows 上大小写不敏感,但那份不敏感是 `process.env` 这个特殊对象
 * 自带的行为;一旦被展开成普通对象(测试注入、或调用方 `{...process.env}` 拼出
 * 一份传给子进程),原始大小写就留下来了 —— 系统给的可能是 "Path" 也可能是
 * "PATH",两种真实见过。这里手动做一次大小写不敏感查找兜底,不依赖 env 到底
 * 是不是那个特殊对象。
 */
export function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
	// **先扫 Object.keys,精确名只作兜底**,顺序不能反:Windows 上真 `process.env` 是
	// 一个大小写不敏感的代理,`env["PATH"] !== undefined` 即使真实键叫 "Path" 也为真。
	// 先试精确名就会返回 "PATH",而调用方(resolve.ts 的 shellEnvFor)`{...base}` 展开
	// 出来的普通对象里躺着的是 "Path" —— 于是写回时同时出现 "Path"(旧值)和
	// "PATH"(新值)两个键,子进程认哪个是未定义行为。
	const lower = name.toLowerCase();
	return Object.keys(env).find((key) => key.toLowerCase() === lower) ?? (env[name] !== undefined ? name : undefined);
}

function readEnvVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = findEnvKey(env, name);
	return key === undefined ? undefined : env[key];
}

/**
 * env 里有没有 PATHEXT 这个键,就是"按 Windows 语义展开后缀"还是"POSIX 直接
 * 拼裸名字"的判断依据 —— 不用 process.platform:真实 Windows 进程环境里这个
 * 变量总是在的,POSIX 上通常没有;而测试要能在 POSIX CI 上把 Windows 分支的
 * 逻辑真正跑起来,只能靠"给不给这个变量"切换,不能靠"这台跑测试的机器是
 * 什么系统"这种测哪儿都测不出差异的闸门(根 CLAUDE.md 点过名的反模式)。
 */
function candidateExtensions(env: NodeJS.ProcessEnv): string[] {
	const raw = readEnvVar(env, "PATHEXT");
	if (raw === undefined) return [""];
	const list = raw
		.split(";")
		.map((ext) => ext.trim())
		.filter(Boolean);
	// 末尾再补一条裸名字兜底:多试一条候选的代价远低于漏掉"这台机器上这个
	// 工具就是不带扩展名装的"这种少数情况(比如某些 WSL 互操作场景)。
	return [...(list.length ? list : DEFAULT_PATHEXT.split(";")), ""];
}

/**
 * 把 env 的 PATH 换成给定目录,其余不动。**必须先删掉原来那个键**:Windows 上真
 * `process.env` 的键叫 "Path",`{...env, PATH: …}` 展开后两个键并存,findEnvKey 扫
 * Object.keys 先撞见旧的 "Path" —— 于是 findOnPath 扫的是机器真实 PATH,不是你指的
 * 目录。实测(2026-08-23):CI 的 Windows 岗上"贴目录解析可执行文件"两条测试因此红了三次,
 * 而 Mac 上键本来就叫 PATH,覆盖掉了,本地永远绿。
 */
export function withPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env };
	const key = findEnvKey(out, "PATH");
	if (key !== undefined) delete out[key];
	out.PATH = dirs.join(path.delimiter);
	return out;
}

/**
 * PATH 扫描,按 PATHEXT 展开候选后缀 —— cmake 用 winget/choco 装出来常是
 * `.cmd` 垫片,ninja 靠 scoop 装时也是 `.cmd`/`.bat`,只拼 `.exe` 会在这些
 * 情况下假阴性(gdb.ts:1153 的 findOnPath 就是这个坑,这次不抄它)。
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dirs = (readEnvVar(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
	const extensions = candidateExtensions(env);
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, `${name}${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

// ─── 已知安装位置:pattern 展开 ────────────────────────────────────────────────

/**
 * 单个路径 segment 里的 `*` 通配转正则。只处理 `*`(零个或多个字符),不支持
 * `?` / 字符集这类更复杂的语法 —— 已知安装位置表里从来没见过需要它们的真实
 * 案例,语法越窄,"匹配到不该匹配的东西"的面积就越小。大小写不敏感:Windows
 * 文件系统本来就不分大小写,POSIX 上现存的 pattern 也都是全小写的厂商目录名,
 * 不会因为这条多出假阳性。
 */
function globSegmentToRegExp(segment: string): RegExp {
	const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/** 把 pattern 切成"根"(盘符或 POSIX 的前导 `/`)和之后的一串 segment。 */
function splitPatternRoot(pattern: string): { root: string; segments: string[] } {
	const normalized = pattern.replace(/\\/g, "/");
	const drive = /^([A-Za-z]:)\/(.*)$/.exec(normalized);
	if (drive) return { root: `${drive[1]}/`, segments: drive[2].split("/").filter(Boolean) };
	if (normalized.startsWith("/")) return { root: "/", segments: normalized.slice(1).split("/").filter(Boolean) };
	// 已知安装位置表里不会出现相对路径,但别为了这个抛错 —— 当前目录为根尽量跑。
	return { root: "", segments: normalized.split("/").filter(Boolean) };
}

function joinSegment(base: string, segment: string): string {
	return base === "" || base.endsWith("/") ? `${base}${segment}` : `${base}/${segment}`;
}

/**
 * 单条 pattern 展开成这台机器上**真实存在**的绝对路径列表。全程用正斜杠拼接
 * 再直接交给 node:fs —— Windows 的文件系统调用两种分隔符都认,不必为"已知
 * 安装位置表可能描述的是别的平台"这件事再分 path.win32 / path.posix 两条路;
 * 返回前统一过一遍 path.normalize(),在本机原生分隔符下好看,不影响正确性。
 *
 * 通配 segment 靠 readdirSync 展开,不加 glob 依赖(表里每条 pattern 最多一两
 * 层通配,不值得为这个引一个库)。任何一步 IO 失败(目录不存在、没权限、甚至
 * 这条 pattern 本来就是别的平台的、这台机器压根没有对应的盘符或根目录)都当
 * "这条 pattern 在这台机器上没有命中",不抛 —— 见文件头的共同纪律。
 *
 * 结果按字符串排序:readdirSync 的顺序取决于文件系统,不排序的话"多个候选取
 * 第一个"(resolve.ts 的探测顺序注释)在同一台机器上都可能一次一个样,排序换
 * 来的是可复现,不是语义上的"更新的版本排前面"。
 */
export function expandGlobPath(pattern: string): string[] {
	const { root, segments } = splitPatternRoot(pattern);
	let bases = [root];
	for (const segment of segments) {
		if (!segment.includes("*")) {
			bases = bases.map((base) => joinSegment(base, segment));
			continue;
		}
		const matcher = globSegmentToRegExp(segment);
		const next: string[] = [];
		for (const base of bases) {
			let entries: string[];
			try {
				entries = readdirSync(base);
			} catch {
				continue; // 这一级目录本来就没有 —— 这条 base 没有后续候选
			}
			for (const entry of entries) {
				if (matcher.test(entry)) next.push(joinSegment(base, entry));
			}
		}
		bases = next;
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const candidate of bases) {
		const normalized = path.normalize(candidate);
		if (seen.has(normalized) || !existsSync(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	out.sort();
	return out;
}

// ─── 已知安装位置:数据表 ──────────────────────────────────────────────────────

const HOME = homedir();

/**
 * J-Link 的官方安装包让用户自己选盘符,不是每台机器都装在 C 盘 —— 真实机器上
 * 就见过 `D:\Program Files\SEGGER\JLink_V958`,只查 C 盘会在这类机器上假阴性。
 * 枚举 C~G 几个常见盘符,而不是真去查这台机器挂了哪些盘(Windows 没有现成的
 * node:fs API 直接列出逻辑盘符,要查得走 wmic/PowerShell,对"已知位置表"里的
 * 一条来说不值得);没装的盘符 expandGlobPath 会因为根目录不存在自己跳过,
 * 不产生噪音。
 */
function winDriveVariants(suffix: string): string[] {
	return ["C", "D", "E", "F", "G"].map((drive) => `${drive}:\\${suffix}`);
}

export type LocationTable = Record<string, Partial<Record<PlatformKey, string[]>>>;

/**
 * 探测表的键回落:先按清单里的 tool.id 查,查不到再按 tool.from(provider 键)查。
 * 真实清单常给工具起项目内短名(id "arm-gcc")而把厂商身份放在 from
 * ("arm-gnu-toolchain"),而 WELL_KNOWN_LOCATIONS / REGISTRY_SEARCH_TERM 两张表的
 * 键都是厂商风格的名字 —— 只按 id 查,well-known/registry 两档对这类清单**永远
 * 不命中**,静默退化成只剩 PATH 一档(test/fixtures/toolchain/bk64.jsonc 的
 * arm-gcc 就是这个形状,实测踩过)。id 命中时不再看 from:两个键同时在表里的
 * 情况按"更具体的赢",不做并集 —— 并集会让同一个工具白探两组目录。
 */
export function tableLookup<T>(table: Record<string, T>, toolId: string, from?: string): T | undefined {
	return table[toolId] ?? (from === undefined ? undefined : table[from]);
}

/**
 * 按 toolId 的已知安装位置表,数据不是分支 —— toolId 之间没有共享逻辑,写成
 * if/else 只会把"这个工具装在哪"这种纯事实性的知识和控制流搅在一起。
 *
 * 每条 pattern 只是"大概率":这是探测顺序里第 5 档,PATH 和账本都没命中之后
 * 才轮到它,猜不中的后果是掉到第 6 档(注册表)或第 7 档(问用户),不是错误。
 * 涉及用户目录的条目用 HOME 拼(scoop shims、pyenv、JetBrains 经典安装路径);
 * `os.homedir()` 在进程启动时就定死,但这里不需要跨用户隔离 —— 不像账本 /
 * 凭据那样要防"测试把真实文件洗掉",这张表只读、只用来判断"存在与否",用它
 * 本身没有根 CLAUDE.md 点过的那个坑。
 */
export const WELL_KNOWN_LOCATIONS: LocationTable = {
	"arm-gnu-toolchain": {
		win32: [
			"C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\*\\bin",
			"C:\\Program Files\\Arm GNU Toolchain arm-none-eabi\\*\\bin",
			"C:\\ST\\STM32CubeCLT_*\\GNU-tools-for-STM32\\*\\bin",
			"C:\\ST\\STM32CubeIDE_*\\STM32CubeIDE\\plugins\\com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.*\\tools\\bin",
		],
		darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/Applications/ARM/bin"],
		linux: ["/usr/bin", "/opt/gcc-arm-*/bin", "/opt/arm-gnu-toolchain-*/bin"],
	},
	jlink: {
		win32: [
			...winDriveVariants("Program Files\\SEGGER\\JLink*"),
			...winDriveVariants("Program Files (x86)\\SEGGER\\JLink*"),
		],
		darwin: ["/Applications/SEGGER/JLink*"],
		linux: ["/opt/SEGGER/JLink*"],
	},
	cmake: {
		win32: [
			"C:\\Program Files\\CMake\\bin",
			"C:\\Program Files\\Microsoft Visual Studio\\*\\*\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin",
			"C:\\ST\\STM32CubeCLT_*\\CMake\\bin",
			"C:\\Program Files\\JetBrains\\CLion *\\bin\\cmake\\win\\*\\bin",
			`${HOME}\\scoop\\shims`,
			"C:\\ProgramData\\chocolatey\\bin",
		],
		darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/Applications/CLion.app/Contents/bin/cmake/mac/*/bin"],
		linux: ["/usr/bin", `${HOME}/clion-*/bin/cmake/linux/*/bin`, "/opt/clion-*/bin/cmake/linux/*/bin"],
	},
	ninja: {
		win32: [
			"C:\\Program Files\\Microsoft Visual Studio\\*\\*\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\Ninja",
			"C:\\ST\\STM32CubeCLT_*\\Ninja\\bin",
			"C:\\Program Files\\JetBrains\\CLion *\\bin\\ninja\\win",
			`${HOME}\\scoop\\shims`,
			"C:\\ProgramData\\chocolatey\\bin",
		],
		darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/Applications/CLion.app/Contents/bin/ninja/mac"],
		linux: ["/usr/bin", `${HOME}/clion-*/bin/ninja/linux`, "/opt/clion-*/bin/ninja/linux"],
	},
	clangd: {
		win32: [
			"C:\\Program Files\\LLVM\\bin",
			"C:\\Program Files\\Microsoft Visual Studio\\*\\*\\VC\\Tools\\Llvm\\x64\\bin",
			`${HOME}\\scoop\\shims`,
		],
		// brew 的 llvm 是 keg-only(不链进 /opt/homebrew/bin,避免和 Xcode 自带的
		// clang 打架),clangd 只能从 opt/llvm 这个 keg 专属符号链接里找。
		darwin: [
			"/opt/homebrew/opt/llvm/bin",
			"/usr/local/opt/llvm/bin",
			"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin",
		],
		linux: ["/usr/lib/llvm-*/bin", "/usr/bin"],
	},
	stm32cubemx: {
		win32: ["C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX"],
		darwin: [
			"/Applications/STMicroelectronics/STM32CubeMX.app/Contents/MacOs",
			"/Applications/STM32CubeMX.app/Contents/MacOs",
		],
		linux: ["/opt/STMicroelectronics/STM32CubeMX", `${HOME}/STM32CubeMX`],
	},
	python: {
		win32: [`${HOME}\\AppData\\Local\\Programs\\Python\\Python3*`, "C:\\Program Files\\Python3*", `${HOME}\\scoop\\shims`],
		darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/Library/Frameworks/Python.framework/Versions/3.*/bin", "/usr/bin"],
		linux: ["/usr/bin", "/usr/local/bin", `${HOME}/.pyenv/shims`],
	},
	openocd: {
		win32: [
			// xpm 的默认落点;CubeIDE 自带一份 ST 定制 openocd;scoop/choco 的垫片目录。
			`${HOME}\\AppData\\Roaming\\xPacks\\@xpack-dev-tools\\openocd\\*\\.content\\bin`,
			"C:\\ST\\STM32CubeIDE_*\\STM32CubeIDE\\plugins\\com.st.stm32cube.ide.mcu.externaltools.openocd.*\\tools\\bin",
			`${HOME}\\scoop\\shims`,
			"C:\\ProgramData\\chocolatey\\bin",
		],
		darwin: ["/opt/homebrew/bin", "/usr/local/bin"],
		linux: ["/usr/bin", "/usr/local/bin"],
	},
	stm32cubeprog: {
		win32: [
			"C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin",
			"C:\\ST\\STM32CubeIDE_*\\STM32CubeIDE\\plugins\\com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.*\\tools\\bin",
		],
		darwin: ["/Applications/STMicroelectronics/STM32Cube/STM32CubeProgrammer/STM32CubeProgrammer.app/Contents/MacOs/bin"],
		linux: [`${HOME}/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin`, "/usr/local/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin"],
	},
	// idf.py 住在 esp-idf 检出的 tools/ 子目录(仓根没有可执行文件),pattern 直接指进去。
	idf: {
		win32: ["C:\\Espressif\\frameworks\\esp-idf-v*\\tools", `${HOME}\\esp\\esp-idf\\tools`],
		darwin: [`${HOME}/esp/esp-idf/tools`],
		linux: [`${HOME}/esp/esp-idf/tools`],
	},
	"zephyr-sdk": {
		win32: [`${HOME}\\zephyr-sdk-*\\arm-zephyr-eabi\\bin`, "C:\\zephyr-sdk-*\\arm-zephyr-eabi\\bin"],
		darwin: [`${HOME}/zephyr-sdk-*/arm-zephyr-eabi/bin`, "/opt/zephyr-sdk-*/arm-zephyr-eabi/bin"],
		linux: [`${HOME}/zephyr-sdk-*/arm-zephyr-eabi/bin`, "/opt/zephyr-sdk-*/arm-zephyr-eabi/bin"],
	},
	// Keil 只有 Windows;探测的是编译器(armclang/armcc)而不是 UV4 —— 见 families.ts
	// KEIL 条目的注释(对 GUI spawn --version 会真的弹起 IDE)。装盘符可选,同 jlink;
	// AC6(armclang)在 ARM\ARMCLANG\bin,AC5(armcc)在 ARM\BIN(实机核对过,不是
	// 想当然的 ARM\ARMCC\bin)。Users\*\AppData\Local 是安装器"仅为我安装"的落点,
	// 用户目录可以不在 C 盘(实机:D:\Users\admin\AppData\Local\Keil_v5)。
	keil: {
		win32: [
			...winDriveVariants("Keil_v5\\ARM\\ARMCLANG\\bin"),
			...winDriveVariants("Keil_v5\\ARM\\BIN"),
			...winDriveVariants("Users\\*\\AppData\\Local\\Keil_v5\\ARM\\ARMCLANG\\bin"),
			...winDriveVariants("Users\\*\\AppData\\Local\\Keil_v5\\ARM\\BIN"),
		],
	},
};

/**
 * 平台已知安装位置,按 toolId(回落 from,见 tableLookup)查表后逐条 pattern 展开、
 * 去重、只留存在的。table 可注入是给测试的:回落逻辑要在临时目录上真展开一次才算
 * 测到,而真表里全是系统路径,没法在 CI 上稳定命中。
 */
export function wellKnownCandidates(
	toolId: string,
	platform: string,
	opts?: { from?: string; table?: LocationTable },
): string[] {
	const patterns = tableLookup(opts?.table ?? WELL_KNOWN_LOCATIONS, toolId, opts?.from)?.[platform as PlatformKey];
	if (!patterns) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const pattern of patterns) {
		for (const candidate of expandGlobPath(pattern)) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			out.push(candidate);
		}
	}
	return out;
}

// ─── Windows 注册表 ────────────────────────────────────────────────────────────

/** toolId(或 tool.from,见 tableLookup)→ 在 Uninstall 键里搜的厂商/产品词。没有对应词的直接判定查不到。 */
const REGISTRY_SEARCH_TERM: Record<string, string> = {
	jlink: "SEGGER",
	"arm-gnu-toolchain": "Arm GNU Toolchain",
	stm32cubemx: "STMicroelectronics",
	// 不复用 "STMicroelectronics":那个词会同时命中 CubeMX 与 CubeProgrammer 的卸载键,
	// 用产品名把搜索面钉到最窄(见本表头注释 —— 面越宽,凑巧命中的概率越高)。
	stm32cubeprog: "STM32CubeProgrammer",
};

// 三个 Uninstall 根都要查:只查 64 位视图会漏掉 32 位安装包(J-Link 官方安装包
// 就是 32 位的,只注册在 WOW6432Node 下);只查 HKLM 会漏掉只给当前用户装的
// (不少 JetBrains 系产品走这条,虽然本表暂时用不到,但探测逻辑本身留着更稳)。
const UNINSTALL_ROOTS = [
	"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/**
 * 从 `reg query <key> /s /f <term> /d` 的 stdout 里挑出 InstallLocation 的值。
 * `/d` 把匹配范围限制在**值的内容**上,不含键名/值名 —— 否则搜 "SEGGER" 有
 * 概率被某个凑巧带这几个字母的键名截胡。命中的键会把它全部的值(DisplayName、
 * InstallLocation、UninstallString……)整块缩进打印在下面,这里只挑
 * InstallLocation 这一行,认 REG_SZ 和 REG_EXPAND_SZ 两种类型。
 */
export function parseInstallLocations(stdout: string): string[] {
	const out: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const m = /^\s*InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
		if (m?.[1]) out.push(m[1]);
	}
	return out;
}

/**
 * Windows 的 Uninstall 注册表键探测 —— PATH 和已知安装目录都没找到时的最后
 * 一档。只查 REGISTRY_SEARCH_TERM 里列出的厂商词,不做开放式关键字搜索:
 * Uninstall 键下躺着这台机器装过的几乎所有软件,搜索面越宽,"凑巧命中一个不
 * 相关的 InstallLocation"的概率越高。
 *
 * platform 参数默认 process.platform、可注入 —— 不是契约要求的形状,是照抄
 * 这个包里 serial.ts 的既有写法(normalizeSerialPort 等一整批函数都是这个
 * 签名):默认值让生产调用方(只传 toolId)拿到的行为和契约文档完全一致,注入
 * 空间则是测试验证"非 win32 返回 []"这条分支的唯一办法 —— 这台开发机本身
 * 就是 win32,不给注入点的话这条分支永远不会被真正跑到一次(根 CLAUDE.md 点
 * 过名的"永远不会响的闸门")。
 */
export function registryCandidates(
	toolId: string,
	platform: NodeJS.Platform = process.platform,
	opts?: { from?: string; terms?: Record<string, string> },
): string[] {
	if (platform !== "win32") return [];
	const term = tableLookup(opts?.terms ?? REGISTRY_SEARCH_TERM, toolId, opts?.from);
	if (!term) return [];

	const found = new Set<string>();
	for (const root of UNINSTALL_ROOTS) {
		try {
			// env 必须显式传:bun 的 spawnSync 省略 env 时按进程启动那一刻的环境
			// 解析 argv[0],运行时改过的 PATH 对它不生效(根 CLAUDE.md 的"会咬人的地方",
			// serial.ts:176 同一道疤)。
			// 超时是上界不是预算:这一档跑在 SessionManager.ensureOpen() 的关键路径上
			// (会话打开时同步等它),而 `/s` 是把整个 Uninstall 子树递归扫一遍,装了
			// 很多软件的机器上真的要几百毫秒。三个根 × 每个缺席的工具会累加,所以宁可
			// 早放弃——查不到只是退回下一档(报"没装"并给安装指引),而会话卡住十几秒
			// 看起来就是 app 挂了。往上调这个数之前先想清楚这一条。
			const result = spawnSync("reg", ["query", root, "/s", "/f", term, "/d"], {
				encoding: "utf8",
				env: process.env,
				timeout: 3000,
			});
			if (result.error || result.status !== 0 || !result.stdout) continue;
			for (const location of parseInstallLocations(result.stdout)) found.add(location);
		} catch {
			continue; // 绝不抛 —— 这一档探测失败就当没有,交给下一档兜底
		}
	}
	return [...found];
}
