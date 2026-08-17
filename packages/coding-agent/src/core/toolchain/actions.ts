/**
 * 工具链的两个"写"动作,被 agent 工具(tools/toolchain.ts)与桌面端 RPC(kernel
 * host 的 toolchain.status fresh / toolchain.set)共用。resolve.ts 刻意是纯读(见其
 * 文件头"不写回账本"那段),写回什么、什么时候写回是调用方的产品决定 —— 这里是那
 * 两个决定的唯一实现:两个入口必须同一套验证与写回,否则"UI 里填的路径"和"agent
 * 问出来记的路径"行为分叉(话术、账本形态各一套),而账本是同一份文件。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { writeLedgerEntry } from "./ledger.ts";
import type { ToolchainResolution } from "./resolve.ts";
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
	binPath: string;
	version: string;
}

/**
 * 把用户指出的路径验证后记进账本,by:"user"。验证是这个动作的全部价值:路径必须
 * 绝对(账本被这台机器上所有项目读,相对路径每个项目解析出来都不一样)、必须存在、
 * 必须真能跑出一个版本号 —— 坏路径带着清楚的理由被拒绝,而不是静默收下然后在很远
 * 的地方炸(表现是"工具坏了"而不是"路径填错了")。
 */
export async function recordToolchainPath(opts: { id: string; path: string; configDir?: string }): Promise<RecordedToolchainPath> {
	const rawPath = opts.path.trim();
	if (!path.isAbsolute(rawPath)) {
		throw new Error(
			`toolchain set: path must be absolute (got "${rawPath}") — the toolchain ledger is read by every project on this machine, a relative path would resolve differently each time`,
		);
	}
	if (!existsSync(rawPath)) {
		throw new Error(`toolchain set: ${rawPath} does not exist`);
	}

	const version = await probeVersion(rawPath);
	if (version === undefined) {
		throw new Error(
			`toolchain set: ran "${rawPath} --version" and found no recognizable version number in the output — double-check this is the right executable before recording it`,
		);
	}

	await writeLedgerEntry(
		{ id: opts.id, bin: { [execNameOf(rawPath)]: rawPath }, version, confirmedAt: Date.now(), by: "user" },
		opts.configDir,
	);

	return { id: opts.id, binPath: rawPath, version };
}
