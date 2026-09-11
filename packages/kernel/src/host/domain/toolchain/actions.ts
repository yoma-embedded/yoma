/**
 * 工具链的两个"写"动作,被 agent 工具(tools/toolchain.ts)与桌面端 RPC(kernel
 * host 的 toolchain.status fresh / toolchain.set)共用。resolve.ts 刻意是纯读(见其
 * 文件头"不写回账本"那段),写回什么、什么时候写回是调用方的产品决定 —— 这里是那
 * 两个决定的唯一实现:两个入口必须同一套验证与写回,否则"UI 里填的路径"和"agent
 * 问出来记的路径"行为分叉(话术、账本形态各一套),而账本是同一份文件。
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeLedgerEntry } from "./ledger.ts";
import { findOnPath, withPath } from "./locations.ts";
import type { ToolchainResolution } from "./resolve.ts";
import { MANIFEST_RELATIVE, parseManifest } from "./schema.ts";
import { probeVersion } from "./version.ts";

/**
 * 把一次新鲜探测(skipLedger)的 ok 结果写回账本,by:"auto"。跳过 source==="local"
 * 的:那是这一个项目的覆盖(可能是仓库里 vendor 的专属工具链),写进机器级账本会让
 * 同一台机器上不相关的项目也悄悄捡到它——正是这套系统要挡的"选错还编得过"那类坑
 * (根 CLAUDE.md 反复出现的教训)。逐条 await 而不是 Promise.all:writeLedgerEntry 是
 * 读改写整份文件,并发写会互相踩丢更新(ledger.ts 头部注释),工具通常个位数,
 * 串行的代价可以忽略。
 */
export async function rememberFreshResults(resolution: ToolchainResolution, configDir: string | undefined): Promise<void> {
	for (const tool of resolution.tools) {
		if (tool.status !== "ok" || tool.source === "local") continue;
		await writeLedgerEntry(
			{ id: tool.id, bin: tool.bin, version: tool.version, confirmedAt: Date.now(), by: "auto" },
			configDir,
		);
	}
}

/**
 * 账本条目的 key 用真实可执行文件名(不带扩展名),不用清单里的抽象 id——与既有
 * 账本条目的形态一致(ledger.ts 头部注释里的例子就是拿真实文件名当 key)。set 只
 * 产出单条 bin 记录,下游不管是 shellEnvFor(取 Object.values)还是 primaryBinPath
 * 的兜底分支(找不到声明名字就退回 Object.values(bin)[0])都不依赖 key 具体叫
 * 什么,选真实文件名单纯是为了以后人肉翻 toolchains.json 时一眼看出这是哪个东西。
 */
function execNameOf(resolvedPath: string): string {
	return path.parse(resolvedPath).name;
}

export interface RecordedToolchainPath {
	id: string;
	/** 代表路径:声明顺序里第一个解析到的可执行文件;目录型条目就是那个目录本身。 */
	binPath: string;
	/** 尽力而为的元数据 —— 探不出来(或 probe:"exists" 压根不探)就没有。 */
	version?: string;
}

/**
 * 在用户给的目录(及其 bin/ 子目录)里解析声明的可执行名 —— 与 resolve.ts 的
 * well-known/registry 档同一套口径([dir, dir/bin] 两层、findOnPath 的 PATHEXT
 * 展开),用户"把安装目录整个贴进来"于是和自动探测撞见同一个目录时行为一致。
 */
function resolveBinsInDir(dir: string, bins: string[]): Record<string, string> {
	const synthetic = withPath(process.env, [dir, path.join(dir, "bin")]);
	const found: Record<string, string> = {};
	for (const name of bins) {
		const hit = findOnPath(name, synthetic);
		if (hit) found[name] = hit;
	}
	return found;
}

/**
 * 把用户指出的路径验证后记进账本,by:"user"。
 *
 * 验证的原则:**只拦不可能对的输入,其余照单全收**(2026-08-18 定稿,用户点名要的:
 * 他是自己机器的权威,拦住他等于配置流程当场卡死)。
 * - 路径必须绝对(账本被这台机器上所有项目读,相对路径每个项目解析出来都不一样)、
 *   必须存在 —— 仅剩的两条拒绝,只可能拦下手滑,而且当场就能看懂怎么改。
 * - 给了 bins(该工具声明的可执行名)且路径是**目录**时,在 [目录, 目录/bin] 里
 *   解析这些名字:用户对着资源管理器复制的天然是安装目录而不是某个 exe(实测:
 *   J-Link 的 `...\JLink_V958`、CubeProgrammer 的 `...\bin` 都是这么贴进来的)。
 *   解析到就记解析出的可执行文件;**一个都解析不到也不拒绝,原样记录目录本身**
 *   (实测:Keil 用户贴的是 `...\Keil_v5\UV4`,编译器在旁边的 ARM\ 树里 —— 目录
 *   结构的花样穷举不完,拦错的代价是用户被卡死,收错的代价只是之后用到时才发现,
 *   而行里明晃晃显示着记录的路径,看得见就改得掉)。
 * - **版本是尽力而为的元数据,不是闸门**(从前探不出版本号直接拒,实测把 J-Link
 *   这类 `--version` 不标准的工具连同"贴了目录"的用户一起误拒了)。探得到就记,
 *   探不到留空。
 *
 * probe:"exists"(目录型条目:STM32CubeMX 安装目录、ESP-IDF 根目录、Zephyr SDK)
 * 完全不 spawn —— 对 GUI 跑 `--version` 会真的把程序弹起来。谁走哪档不是调用方随口
 * 说的:设置页与 kernel host 按 families.ts 预设的 pathKind 决定。
 */
export async function recordToolchainPath(opts: {
	id: string;
	path: string;
	configDir?: string;
	probe?: "version" | "exists";
	/** 该工具声明的可执行名(清单 tool.bin / 平台预设)。给了它,目录输入才解析得动。 */
	bins?: string[];
}): Promise<RecordedToolchainPath> {
	const rawPath = opts.path.trim();
	if (!path.isAbsolute(rawPath)) {
		throw new Error(
			`toolchain set: path must be absolute (got "${rawPath}") — the toolchain ledger is read by every project on this machine, a relative path would resolve differently each time`,
		);
	}
	if (!existsSync(rawPath)) {
		throw new Error(`toolchain set: ${rawPath} does not exist`);
	}

	// 目录里解析得到就用解析结果;解析不到(或压根没有 bins 可解析)就原样记录 ——
	// 见文件头「照单全收」那段的理由。
	let bin: Record<string, string> =
		statSync(rawPath).isDirectory() && (opts.bins?.length ?? 0) > 0 ? resolveBinsInDir(rawPath, opts.bins!) : {};
	if (Object.keys(bin).length === 0) {
		bin = { [execNameOf(rawPath)]: rawPath };
	}

	// 代表路径按声明顺序取第一个解析到的名字(与 resolve.ts 的 primaryBinPath 同口径);
	// 没有 bins(目录型条目 / 直接给了文件)时就是那条路径本身。
	const primary = opts.bins?.map((name) => bin[name]).find((p) => p !== undefined) ?? Object.values(bin)[0]!;

	let version: string | undefined;
	if ((opts.probe ?? "version") === "version" && !statSync(primary).isDirectory()) {
		version = await probeVersion(primary);
	}

	await writeLedgerEntry({ id: opts.id, bin, version, confirmedAt: Date.now(), by: "user" }, opts.configDir);

	return { id: opts.id, binPath: primary, version };
}

/**
 * 从项目清单(或注入的清单文本)里查一个工具声明的可执行名 —— set 的目录解析要用。
 * 尽力而为的查询而不是闸门:清单缺席 / 解析失败 / 工具没声明都返回 undefined,
 * 此时目录输入退化为"原样记录"(和目录型条目一个待遇),不额外报错 —— set 的
 * 报错面留给路径本身的问题。
 */
export async function declaredToolBins(opts: {
	id: string;
	projectDir?: string;
	manifestText?: string;
}): Promise<string[] | undefined> {
	let text = opts.manifestText;
	if (text === undefined) {
		if (opts.projectDir === undefined) return undefined;
		try {
			text = await readFile(path.join(opts.projectDir, MANIFEST_RELATIVE), "utf8");
		} catch {
			return undefined;
		}
	}
	const parsed = parseManifest(text);
	if (!parsed.ok) return undefined;
	return parsed.manifest.tools.find((tool) => tool.id === opts.id)?.bin;
}
