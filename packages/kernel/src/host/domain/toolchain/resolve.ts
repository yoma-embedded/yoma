/**
 * 工具链解析:把 schema(要什么)+ locations/version(这台机器上有什么)+ ledger
 * (上次确认过什么)按七档探测顺序攒成一份结论,再导出成子进程能用的环境变量和
 * 模型能读的提示词片段。这是 toolchain 子系统里唯一"下结论"的模块 —— 其余四个
 * (schema/locations/ledger/version)只回答各自那一小块问题,顺序编排、覆盖规则、
 * "版本不对要不要继续找"这些判断全在这一个文件里。
 *
 * 探测顺序(每一档能被更早的档覆盖,来源见 ResolveSource):
 *   local(项目级手动覆盖) > ledger(这台机器上次确认过的) > managed(Yoma 自己装的)
 *   > env(清单点名的环境变量) > installer(厂商安装器的登记文件) > path(PATH 扫描)
 *   > well-known(平台已知安装位置) > registry(Windows 注册表)
 * 项目 local 与用户账本记录是明确选择:失效或版本不符也原样报告,不静默换版本。
 * 自动发现的候选不满足时才继续后续档位。
 * local/ledger/env/path 四档天然只产出一个候选;well-known/registry 可能在同一档
 * 内产出多个目录(比如 CubeIDE 内置 arm-gcc 10.3 和独立装的 13.2 同时存在)——都
 * 满足版本要求时取第一个但把全部记进 candidates,版本满足情况不一致(有的满足
 * 有的不满足)时报 ambiguous 而不是替用户悄悄选一个:悄悄选的后果是"选错照样能
 * 编译,炸在很远的地方"(根 CLAUDE.md 反复出现的那类教训)。
 *
 * binMode 明确区分全部必需入口与可替代入口。保存路径、找到入口、执行成功和
 * 版本满足是不同事实;目录资源只记 configured,不冒充可执行工具。
 *
 * 不写回账本:resolveToolchain 是纯读函数 —— 探测到的结果要不要记回
 * `<configDir>/toolchains.json`,契约没有点这件事,交给下一层(kernel host / bench
 * 的接线代码)决定什么时候调 ledger.ts 的 writeLedgerEntry。这里硬把它焊死会有两
 * 个问题:一是每次解析都产生磁盘写入的副作用,测试和调用方都得为此操心;二是
 * "要不要写、写不写 by:'auto'"本身是一个产品判断("要不要在用户没有明确确认的
 * 情况下就当成靠谱"),不该由这一层替上层做掉。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type HostKey, hostKey, type Installable, installableFor } from "./catalog.ts";
import { applyPresetDefaults } from "./families.ts";
import { listManagedInstalls } from "./install.ts";
import { installerFacts, installerRecords } from "./installers.ts";
import { readLedger, readLocalOverrides } from "./ledger.ts";
import type { Ledger, LedgerEntry } from "./ledger.ts";
import { findEnvKey, findOnPath, type LocationTable, registryCandidates, wellKnownCandidates, withPath } from "./locations.ts";
import { installHint, manifestForSide, MANIFEST_RELATIVE, parseManifest } from "./schema.ts";
import type { ToolchainManifest, ToolSpec } from "./schema.ts";
import { directoryRoot, executableEntries } from "./entries.ts";
import { probeExecutable, satisfies } from "./version.ts";

export type ToolStatus = "ok" | "configured" | "recorded" | "unverified" | "version-mismatch" | "ambiguous" | "missing";
export interface ToolChecks {
	entry: "found" | "partial" | "missing" | "directory";
	execution: "passed" | "unverified" | "not-applicable";
	version: "satisfied" | "mismatch" | "unknown" | "not-required";
}
/**
 * "managed" = Yoma 自己装进 `<configDir>/toolchains/` 的(install.ts),排在账本之后、
 * 环境变量之前:skipLedger 的新鲜探测也必须找得到它,否则设置页"重新探测"一按,
 * 刚装好的工具就报 MISSING。
 *
 * "installer" = 厂商安装器自己的登记文件(installers.ts),排在环境变量之后、PATH 之前:它说的是
 * 这台机器上的事实,装在哪个盘都对;well-known 只是"大概率"。
 */
export type ResolveSource = "local" | "ledger" | "managed" | "env" | "installer" | "path" | "well-known" | "registry";

/**
 * 这个状态不需要任何人再做什么。`configured` 是 dir 型工具的**终态**(目录资源不跑 --version,
 * 永远到不了 ok)—— 2026-09-16 引入它时汇总仍只认 ok,于是 IDF 配好了也永远挂在
 * "needing attention" 里,而没有任何动作能把它摘下来(2026-09-18 会话里模型为此多转了一轮)。
 * 它仍然不是 ok:不进 PATH、不宣称可执行(hasExecutableEntries 不认它)。
 */
export function isSettled(status: ToolStatus): boolean {
	return status === "ok" || status === "configured";
}

export interface ResolvedTool {
	id: string;
	status: ToolStatus;
	checks?: ToolChecks;
	missingBins?: string[];
	optional: boolean;
	bin: Record<string, string>;
	version?: string;
	wanted?: string;
	/** ambiguous 时给用户挑;version-mismatch 时是全部见过但都不满足的路径(此时 bin 是空的,这是唯一能看到路径的地方)。 */
	candidates?: string[];
	source?: ResolveSource;
	/** missing / version-mismatch 时的安装指引,走 installHint(manifest, tool, platform)。 */
	hint?: string;
	why?: string;
	/** 非 ok 且 catalog.ts 对这台机器(平台-架构)有包时给出:UI 的"安装"按钮与提示词的自助安装建议都看它。 */
	installable?: Installable;
	/** 安装器登记文件顺带说的事实("python: …"、"activation script: …"),与来源档位无关,见 installers.ts。 */
	notes?: string[];
}

export interface ToolchainResolution {
	manifestPath?: string;
	manifest?: ToolchainManifest;
	side: "mother" | "runner";
	tools: ResolvedTool[];
	/** 所有非 optional 的都已落定(isSettled:ok,或 dir 型的 configured)。 */
	ok: boolean;
	/** 还没落定的(含 optional 的)。 */
	needsAttention: ResolvedTool[];
}

// ─── 清单加载 ──────────────────────────────────────────────────────────────────

interface LoadedManifest {
	text: string;
	/** 从磁盘读到的才有路径;manifestText 注入(工位端附件、测试)时没有真实文件,留空。 */
	filePath: string | undefined;
}

async function loadManifestText(projectDir: string, injected: string | undefined): Promise<LoadedManifest | undefined> {
	if (injected !== undefined) return { text: injected, filePath: undefined };
	const filePath = path.join(projectDir, MANIFEST_RELATIVE);
	try {
		return { text: await readFile(filePath, "utf8"), filePath };
	} catch {
		// 文件不存在是绝大多数项目的常态,不是错误 —— parseManifest 那层的"人话
		// 错误"是留给"文件在(或被当附件送来了)但内容坏了"的场景,这里读不到就
		// 直接当"没有清单"处理,调用方(resolveToolchain 顶层)据此整条路径静默。
		return undefined;
	}
}

// ─── 单个候选位置的解析结果 ────────────────────────────────────────────────────

/** 一处候选位置解析出来的 `名字 → 绝对路径`。 */
type Hit = Record<string, string>;

/** entry.bin 里记录的每一条路径都还存在,才采信这条 entry —— 见文件头关于"半新半旧"的说明。 */
function allPathsExist(bin: Record<string, string>): boolean {
	const paths = Object.values(bin);
	return paths.length > 0 && paths.every((p) => existsSync(p));
}

/** tool.bin 声明顺序里,第一个在这次命中的 bin 记录里真正解析到路径的名字。 */
function primaryBinPath(bin: Record<string, string>, names: string[]): string | undefined {
	for (const name of names) {
		const value = bin[name];
		if (value !== undefined) return value;
	}
	return Object.values(bin)[0];
}

/** 探测与实际执行共用模板规则;调用方明确提供的环境值始终优先。 */
function applyToolExports(tool: ToolSpec, bin: Record<string, string>, env: NodeJS.ProcessEnv): void {
	const primary = primaryBinPath(bin, tool.bin ?? []);
	if (primary === undefined) return;
	for (const [name, template] of Object.entries(tool.exports ?? {})) {
		if (env[name] !== undefined) continue;
		env[name] = template.replaceAll("{bin}", primary).replaceAll("{path}", primary);
	}
}

function probeEnv(tool: ToolSpec, bin: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const pathValue = base[findEnvKey(base, "PATH") ?? "PATH"] ?? "";
	const dirs = [...new Set(Object.values(bin).map((file) => path.dirname(file)))];
	const env = withPath(base, [...dirs, ...pathValue.split(path.delimiter).filter(Boolean)]);
	applyToolExports(tool, bin, env);
	return env;
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

function nonEmpty<T>(items: T[]): T[] | undefined {
	return items.length > 0 ? items : undefined;
}

// ─── 七档里的前四档:local / ledger / env / path,天然只产出一个候选 ─────────────

/**
 * 自动发现缓存可过期重探;用户选择即使路径失效也保留,由后续验证明确报告。
 */
function entryHits(entry: LedgerEntry | undefined, explicit = false): Hit[] {
	return entry && (explicit || entry.by === "user" || allPathsExist(entry.bin)) ? [entry.bin] : [];
}

/** tool.env 按声明顺序尝试,第一个指向存在路径的变量就赢 —— alternation,不是"全部收集"。 */
function envHits(tool: ToolSpec, env: NodeJS.ProcessEnv): Hit[] {
	for (const varName of tool.env ?? []) {
		const value = env[varName];
		if (value && existsSync(value)) {
			// 环境变量指向的是"这个工具的代表路径",不天然对应 bin[] 里的哪个名字 ——
			// 优先用声明的第一个名字当 key(和 primaryBinPath 的选择口径一致),
			// 真没有名字可用(tool.bin 为空)时退而用变量名本身,好过瞎编一个键。
			const key = tool.bin?.[0] ?? varName;
			return [{ [key]: value }];
		}
	}
	return [];
}

/**
 * 厂商安装器登记的位置(installers.ts)。dir 型(idf)登记的是安装根,原样递下去由 directoryRoot 验;
 * exe 型(esptool:IDF 的 Python 环境里那一份)登记的是可执行文件所在目录,在里面解析声明的入口名 ——
 * 别把目录当入口递下去。
 */
function installerHits(tool: ToolSpec, platform: string, env: NodeJS.ProcessEnv): Hit[] {
	const records = installerRecords(tool.id, platform, env);
	if (tool.pathKind === "dir") return records.map((record) => ({ [tool.id]: record.dir }));
	const names = tool.bin ?? [];
	if (names.length === 0) return [];
	return records.flatMap((record) => {
		const bin = resolveNamesInDirs(names, [record.dir], env);
		return bin ? [bin] : [];
	});
}

function pathHits(tool: ToolSpec, env: NodeJS.ProcessEnv): Hit[] {
	// dir 型记的是安装根,PATH 上没有这种东西(export 之后 `<根>\tools` 会在 PATH 上,但那时 IDF_PATH 也在,env 档先到)。
	if (tool.pathKind === "dir") return [];
	const bin: Record<string, string> = {};
	for (const name of tool.bin ?? []) {
		const found = findOnPath(name, env);
		if (found) bin[name] = found;
	}
	return Object.keys(bin).length > 0 ? [bin] : [];
}

// ─── 后两档:well-known / registry,同一档内可能产出多个候选目录 ────────────────

/** 在给定的一组目录里找 names,当它们是唯一的 PATH 条目 —— 复用 findOnPath 的 PATHEXT 展开,不用另写一套。 */
function resolveNamesInDirs(names: string[], dirs: string[], env: NodeJS.ProcessEnv): Record<string, string> | undefined {
	const synthetic = withPath(env, dirs);
	const bin: Record<string, string> = {};
	for (const name of names) {
		const found = findOnPath(name, synthetic);
		if (found) bin[name] = found;
	}
	return Object.keys(bin).length > 0 ? bin : undefined;
}

function wellKnownHits(tool: ToolSpec, platform: string, env: NodeJS.ProcessEnv, table?: LocationTable): Hit[] {
	// dir 型:表里的 pattern 指向安装根,是不是真的根由 marker 验(resolveTool 里过 directoryRoot,
	// 验不过的自动候选不算命中)。没有 marker 的目录(stm32cubemx)无从确认,只认显式记录。
	if (tool.pathKind === "dir") {
		if (!tool.marker) return [];
		return wellKnownCandidates(tool.id, platform, { from: tool.from, table }).map((dir) => ({ [tool.id]: dir }));
	}
	const names = tool.bin ?? [];
	// 没有声明可执行名字的工具没法靠"在这个目录里找这个名字"确认存在,只能靠
	// local/ledger 的显式记录。
	if (names.length === 0) return [];
	const hits: Hit[] = [];
	// from 是键回落(见 locations.ts 的 tableLookup):清单常给工具起项目内短名
	// (id "arm-gcc"),厂商身份在 from("arm-gnu-toolchain"),而表键是厂商名。
	for (const dir of wellKnownCandidates(tool.id, platform, { from: tool.from, table })) {
		const bin = resolveNamesInDirs(names, [dir], env);
		if (bin) hits.push(bin);
	}
	return hits;
}

function registryHits(tool: ToolSpec, platform: string, env: NodeJS.ProcessEnv): Hit[] {
	const names = tool.bin ?? [];
	// dir 型不走这一档:Uninstall 键的搜索词是厂商名,"STMicroelectronics" 同时命中 CubeMX 与
	// CubeProgrammer,拿 InstallLocation 直接当某个目录资源的根会张冠李戴。
	if (tool.pathKind === "dir" || names.length === 0) return [];
	const hits: Hit[] = [];
	for (const dir of registryCandidates(tool.id, platform as NodeJS.Platform, { from: tool.from })) {
		// InstallLocation 有的厂商就是可执行文件所在目录(SEGGER 的 J-Link),有的是
		// 装了一堆子目录的安装根、可执行文件在它的 bin\ 下 —— 两种都试,不猜是哪种。
		const bin = resolveNamesInDirs(names, [dir, path.join(dir, "bin")], env);
		if (bin) hits.push(bin);
	}
	return hits;
}

// ─── 单个工具的完整解析 ─────────────────────────────────────────────────────────

/**
 * Yoma 自己装的(install.ts 的 `<configDir>/toolchains/<包>/<版本>/`):provides 包含这个
 * 工具 id 的每个包目录算一处候选位置,在它的 binDir 里解析声明名。版本新到旧
 * (listManagedInstalls 的顺序),同一档内多个版本都满足时取最新的那个。
 */
function managedHits(tool: ToolSpec, configDir: string | undefined, env: NodeJS.ProcessEnv): Hit[] {
	const names = tool.bin ?? [];
	if (tool.pathKind === "dir" || names.length === 0) return [];
	const hits: Hit[] = [];
	for (const install of listManagedInstalls(configDir)) {
		if (!install.provides.includes(tool.id)) continue;
		const bin = resolveNamesInDirs(names, [install.binDir], env);
		if (bin) hits.push(bin);
	}
	return hits;
}

interface ResolveCtx {
	/** 已经按 side 筛过的 manifest —— installHint 要用到它的 providers。 */
	manifest: ToolchainManifest;
	localOverrides: Record<string, LedgerEntry>;
	ledger: Ledger;
	platform: string;
	env: NodeJS.ProcessEnv;
	/** managed 档扫的目录;不传就是默认 ~/.yoma(与账本同一个)。 */
	configDir?: string;
	/** 平台-架构,决定 catalog 里有没有这台机器能装的包;认不出来就没有 installable。 */
	host: HostKey | undefined;
	/** 测试注入的已知位置表;生产不传(用 locations.ts 的真表)。 */
	locations?: LocationTable;
}

async function resolveTool(tool: ToolSpec, ctx: ResolveCtx): Promise<ResolvedTool> {
	const names = tool.bin ?? [];
	const optional = tool.optional ?? false;
	const wanted = tool.version;
	const installable = installableFor(tool.id, ctx.host);
	const hint = installHint(ctx.manifest, tool, ctx.platform);
	const base = { id: tool.id, optional, wanted, why: tool.why };
	const tiers: Array<[ResolveSource, () => Hit[]]> = [
		["local", () => entryHits(ctx.localOverrides[tool.id], true)],
		["ledger", () => entryHits(ctx.ledger.entries[tool.id])],
		["managed", () => managedHits(tool, ctx.configDir, ctx.env)],
		["env", () => envHits(tool, ctx.env)],
		["installer", () => installerHits(tool, ctx.platform, ctx.env)],
		["path", () => pathHits(tool, ctx.env)],
		["well-known", () => wellKnownHits(tool, ctx.platform, ctx.env, ctx.locations)],
		["registry", () => registryHits(tool, ctx.platform, ctx.env)],
	];
	let firstFailure: ResolvedTool | undefined;
	const seen: string[] = [];
	for (const [source, getHits] of tiers) {
		const hits = getHits();
		const attempts = await Promise.all(
			hits.map(async (hit): Promise<ResolvedTool | undefined> => {
				const recorded = Object.values(hit);
				if (tool.pathKind === "dir") {
					// 所有来源过同一个归位函数(entries.ts):记录值是根、是根下的子目录、还是标志文件本身,
					// 落到同一个答案。声明了 marker 就必须验得过;没声明的(stm32cubemx)目录在就算数。
					const roots = recorded.map((value) => directoryRoot(tool, value, ctx.env));
					const chosen = roots.find((r) => r.verified) ?? roots.find((r) => r.root !== undefined);
					const settled = chosen?.root !== undefined && (chosen.verified || !tool.marker);
					// 验不过时:用户明确记过的路径如实报(RECORDED,点名缺哪个文件);自动发现的候选不算命中,
					// 接着找下一档 —— 一个过期的 IDF_PATH 不该挡住安装器登记的那一份。
					const explicit = source === "local" || source === "ledger";
					if (!settled && !explicit) return undefined;
					const root = settled ? chosen!.root! : undefined;
					return {
						...base,
						source,
						bin: root !== undefined ? { [Object.keys(hit)[0] ?? tool.id]: root } : hit,
						status: root !== undefined ? "configured" : "recorded",
						missingBins: root === undefined && tool.marker ? [tool.marker] : undefined,
						hint,
						notes: root !== undefined ? nonEmpty(installerFacts(tool.id, root, ctx.platform, ctx.env)) : undefined,
						checks: {
							entry: root !== undefined ? "directory" : "missing",
							execution: "not-applicable",
							version: "not-required",
						},
					};
				}
				const bin = executableEntries(tool, hit, ctx.env);
				const located = Object.keys(bin);
				const missingBins = names.filter((name) => !bin[name]);
				if (located.length === 0)
					return {
						...base,
						source,
						bin: {},
						candidates: recorded,
						status: "recorded",
						missingBins,
						hint,
						installable,
						checks: { entry: "missing", execution: "unverified", version: wanted ? "unknown" : "not-required" },
					};
				const ordered = names.length ? names.filter((name) => bin[name]) : located;
				const all = tool.binMode === "all";
				const results = await Promise.all(
					ordered.map(async (name) => ({
						name,
						...(await probeExecutable(bin[name]!, probeEnv(tool, all ? bin : { [name]: bin[name]! }, ctx.env), tool.versionArgs)),
					})),
				);
				// all 的版本范围指向主入口(如 gcc),而非 objcopy 等使用独立版本号的伴随工具。
				const primary = all
					? results[0]!
					: (results.find(
							(r) => r.executable && r.version !== undefined && (!wanted || satisfies(r.version, wanted)),
						) ?? results[0]!);
				const version = primary.version;
				const complete = !all || missingBins.length === 0;
				const executable = complete && (all ? results.every((r) => r.executable) : primary.executable);
				const versionCheck: ToolChecks["version"] =
					version === undefined
						? "unknown"
						: !wanted
							? "not-required"
							: satisfies(version, wanted)
								? "satisfied"
								: "mismatch";
				const status: ToolStatus =
					!complete || !executable || versionCheck === "unknown"
						? "unverified"
						: versionCheck === "mismatch"
							? "version-mismatch"
							: "ok";
				// any 只暴露被选择的入口,避免 exports/PATH 再选回刚刚探测失败的首选。
				const selected = all ? bin : { [primary.name]: bin[primary.name]! };
				return {
					...base,
					source,
					status,
					bin: status === "version-mismatch" ? {} : selected,
					version,
					candidates: status === "version-mismatch" ? Object.values(selected) : undefined,
					missingBins: all && missingBins.length ? missingBins : undefined,
					hint: status === "ok" ? undefined : hint,
					installable: status === "ok" ? undefined : installable,
					checks: {
						entry: complete ? "found" : "partial",
						execution: executable ? "passed" : "unverified",
						version: versionCheck,
					},
				};
			}),
		);
		const probed = attempts.filter((attempt): attempt is ResolvedTool => attempt !== undefined);
		const good = probed.filter((p) => isSettled(p.status));
		// 明确选过的路径属于用户意图。失效/版本错误也必须如实返回,不从全局找一套掩盖它。
		if (probed.length && (source === "local" || (source === "ledger" && ctx.ledger.entries[tool.id]?.by === "user")))
			return probed[0]!;
		if (good.length) {
			const winner = good[0]!;
			const candidates = dedupe(probed.flatMap((p) => [...Object.values(p.bin), ...(p.candidates ?? [])]));
			if (probed.some((p) => p.status !== winner.status))
				return { ...winner, status: "ambiguous", candidates, installable };
			return { ...winner, candidates: probed.length > 1 ? candidates : undefined };
		}
		for (const result of probed) {
			firstFailure ??= result;
			seen.push(...Object.values(result.bin), ...(result.candidates ?? []));
		}
	}
	if (firstFailure) return { ...firstFailure, candidates: dedupe(seen) };
	return {
		...base,
		status: "missing",
		bin: {},
		hint,
		installable,
		checks: { entry: "missing", execution: "unverified", version: wanted ? "unknown" : "not-required" },
	};
}

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

export async function resolveToolchain(opts: {
	projectDir: string;
	configDir?: string;
	/**
	 * 跳过自动发现的账本缓存;用户选择仍保留并重新验证。
	 *
	 * 跳过的只是**读**:写回账本仍由调用方做(tools/toolchain.ts 的 rememberFreshResults)
	 * —— resolve 动作的语义就是"不信旧记录,重新看一遍,再把新答案记下来"。
	 * 从前调用方是伪造一个必然不存在的 tmpdir 当 configDir 来达到同样效果,那是把开关
	 * 做在了错的深度:真正落盘用的还是原本的 configDir,两个 configDir 并存很容易读错。
	 */
	skipLedger?: boolean;
	side?: "mother" | "runner";
	platform?: string;
	/** 默认 process.arch;与 platform 一起决定 catalog 里有没有这台机器能装的包。测试注入。 */
	arch?: string;
	env?: NodeJS.ProcessEnv;
	/** 注入用,给测试和工位端(它没有项目检出,清单是当附件送过去的)。 */
	manifestText?: string;
	/** 测试注入:已知位置表。真表里全是系统路径,没法在 CI 上稳定命中(同 wellKnownCandidates 的 table)。 */
	locations?: LocationTable;
}): Promise<ToolchainResolution> {
	const side = opts.side ?? "mother";
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const host = hostKey(platform, opts.arch ?? process.arch);

	const loaded = await loadManifestText(opts.projectDir, opts.manifestText);
	if (loaded === undefined) {
		// 没有清单 —— 绝大多数项目走这条。ok:true、tools 空、manifest 不填,不是
		// 错误:这个项目根本没有声明工具链需求。promptSectionFor / shellEnvFor 看见
		// manifest === undefined 会直接短路,这条路径必须完全静默,不多做任何事。
		return { manifestPath: undefined, manifest: undefined, side, tools: [], ok: true, needsAttention: [] };
	}

	const parsed = parseManifest(loaded.text);
	if (!parsed.ok) {
		// 与"没有清单"是两回事:文件存在(或被显式当附件送来)但内容坏了,这是需要
		// 被看见的错误 —— 悄悄当成"没有清单"处理,用户会以为自己压根没配,排查方向
		// 完全错。parseManifest 已经把错误话术做成人话(指名道姓哪个字段),直接透传。
		throw new Error(parsed.error);
	}

	// 先补预设再按 side 筛:清单只写 {"id":"idf"} 也拿得到"它是什么"(families.ts 的 applyPresetDefaults)。
	const manifest = manifestForSide(applyPresetDefaults(parsed.manifest), side);
	const [localOverrides, ledger] = await Promise.all([
		readLocalOverrides(opts.projectDir),
		readLedger(opts.configDir),
	]);
	// 重新探测只丢弃自动发现缓存,用户明确选择仍是配置,必须重新验证而不是遗忘。
	if (opts.skipLedger) ledger.entries = Object.fromEntries(Object.entries(ledger.entries).filter(([, entry]) => entry.by === "user"));

	// 工具之间并发:ctx 全只读、resolveTool 不写任何东西(账本要不要写是上层的决定,
	// 见文件头),顺序由 Promise.all 保住。收益来自 probeVersion 与 well-known 的 glob;
	// registry 那一档用的是 spawnSync(locations.ts),它阻塞事件循环,所以注册表探测
	// 实际仍是串行 —— 别以为工具数一乘就线性变快。
	// 这条路挂在用户等待上:kernel 的 session-manager 在 ensureOpen 里就 await 它,而
	// 即使全部命中账本也照样每个工具起一次 --version。
	const ctx: ResolveCtx = { manifest, localOverrides, ledger, platform, env, configDir: opts.configDir, host, locations: opts.locations };
	const tools = await Promise.all(manifest.tools.map((tool) => resolveTool(tool, ctx)));

	return {
		manifestPath: loaded.filePath,
		manifest,
		side,
		tools,
		ok: tools.every((t) => t.optional || isSettled(t.status)),
		needsAttention: tools.filter((t) => !isSettled(t.status)),
	};
}

// ─── 子进程环境 ──────────────────────────────────────────────────────────────

/**
 * 解析结果 -> 子进程环境:完整可执行入口的目录前置进 PATH,再按 exports
 * 填变量。base 里已有的同名变量:exports 不覆盖(用户显式设的赢),PATH 是前置
 * 不是替换。
 */
export function hasExecutableEntries(tool: ResolvedTool): boolean {
	return tool.status === "ok" || (tool.status === "unverified" && tool.checks?.entry === "found");
}

export function shellEnvFor(r: ToolchainResolution, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base };

	// 只前置真正需要的那几个目录,不是整棵安装树 —— 塞太多会遮蔽用户自己 PATH 上
	// 同名但不同版本的工具,而这正是清单要解决的"选错版本"问题的反面。去重且保持
	// 工具在 r.tools 里的声明顺序:同一目录被两个工具的 bin 同时指到时只前置一次。
	const dirs: string[] = [];
	const seenDirs = new Set<string>();
	for (const tool of r.tools) {
		if (!hasExecutableEntries(tool)) continue;
		for (const binPath of Object.values(tool.bin)) {
			const dir = path.dirname(binPath);
			if (seenDirs.has(dir)) continue;
			seenDirs.add(dir);
			dirs.push(dir);
		}
	}

	if (dirs.length > 0) {
		// base 里 PATH 这个键在 Windows 上可能叫 "Path" 而不是 "PATH"(真实进程环境
		// 展开成普通对象后大小写不再统一,见 locations.ts 的 readEnvVar 同一个坑)。
		// 必须写回原来那个键 —— 如果凭空另开一个 "PATH",输出对象里会同时躺着
		// "Path"(旧值)和"PATH"(新值)两个键,子进程实际认哪个是未定义行为。
		const pathKey = findEnvKey(base, "PATH") ?? "PATH";
		const current = out[pathKey] ?? "";
		out[pathKey] = [...dirs, current].filter(Boolean).join(path.delimiter);
	}

	if (r.manifest) {
		for (const toolSpec of r.manifest.tools) {
			const exportsSpec = toolSpec.exports;
			if (!exportsSpec) continue;
			const resolved = r.tools.find((t) => t.id === toolSpec.id);
			// 目录配置可作为资源环境值交给消费者验证,但永远不加入可执行 PATH。
			if (!resolved || (!hasExecutableEntries(resolved) && resolved.status !== "configured")) continue;
			applyToolExports(toolSpec, resolved.bin, out);
		}
	}

	return out;
}

// ─── 系统提示词片段 ─────────────────────────────────────────────────────────────

/**
 * CONFIGURED 那一行的正文:目录、来源、安装器顺带说的事实、同一档里的其它安装。系统提示词与
 * toolchain 工具的输出共用 —— "配套的 Python 在哪""另一份 IDF 在哪"正是模型手工满盘找的东西,
 * 两处各拼一遍迟早有一处漏掉。
 */
export function directoryDetail(t: ResolvedTool): string {
	const chosen = Object.values(t.bin)[0] ?? "(unknown path)";
	const parts = [`${chosen} (via ${t.source ?? "unknown"})`];
	if (t.notes?.length) parts.push(t.notes.join("; "));
	const others = (t.candidates ?? []).filter((candidate) => candidate !== chosen);
	if (others.length) parts.push(`also installed: ${others.join(", ")} — to use one of those instead, record it with toolchain set`);
	return parts.join("; ");
}

function lineFor(t: ResolvedTool): string {
	const label = t.optional ? `${t.id} (optional)` : t.id;
	const need = t.wanted ? ` needs ${t.wanted}` : "";

	if (t.status === "ok") {
		const primary = Object.values(t.bin)[0];
		const versionPart = t.version ? `version ${t.version}` : "version unknown";
		return `- ${label}: OK —${need}, resolved to ${primary} (${versionPart}, source: ${t.source ?? "unknown"}).`;
	}

	if (t.status === "configured") return `- ${label}: CONFIGURED — ${directoryDetail(t)}. This is a directory, not a program: it is not on PATH and nothing was executed to check it — use the path as given.`;
	if (t.status === "recorded" && t.checks?.execution === "not-applicable" && t.missingBins?.length)
		return `- ${label}: RECORDED — ${(t.candidates ?? Object.values(t.bin)).join(", ")}. That directory does not contain ${t.missingBins.join(", ")}, so it is not this tool's install directory; record the directory that does (toolchain set).`;
	if (t.status === "recorded") return `- ${label}: RECORDED — ${(t.candidates ?? Object.values(t.bin)).join(", ")}. No declared executable entry was located; saving a path does not make this tool ready.`;
	if (t.status === "unverified") return `- ${label}: UNVERIFIED — ${Object.values(t.bin).join(", ")}. ${t.missingBins?.length ? `Missing required entries: ${t.missingBins.join(", ")}.` : "Entry located, but execution/version verification did not pass. The explicit selection remains available; do not claim it is ready."}`;

	// Yoma 自己能装的:让模型直接用 toolchain 工具的 install 动作,不必先去问用户。
	// 下载来源是 catalog 钉死的官方发布 + sha256 校验,这一步没有需要人拍板的东西。
	// **钉的版本满足不了清单要的范围时不许建议安装**:装完还是 version-mismatch、还是同一句
	// 建议,模型会在"装 → 核 → 再装"里空转;那种情况明说装了也不够,转告用户。
	const usable = (i: NonNullable<ResolvedTool["installable"]>) => t.wanted === undefined || satisfies(i.version, t.wanted);
	const selfService = (i: NonNullable<ResolvedTool["installable"]>) =>
		usable(i)
			? `Run the toolchain tool with action "install" and id "${t.id}" to install ${i.title} ${i.version} automatically (pinned official download, sha256-verified, ~${Math.round(i.bytes / 1e6)} MB); it is on PATH for later commands.`
			: `Yoma could install ${i.title} ${i.version} automatically, but that does NOT satisfy the required ${t.wanted} — do not install it; tell the user instead.`;

	if (t.status === "missing") {
		const advice = t.installable
			? `${selfService(t.installable)}${t.hint ? ` If the user prefers their own install: ${t.hint}` : ""} Never guess or hardcode a path.`
			: t.hint
				? `Do not guess a path or hardcode one — tell the user to install it: ${t.hint}`
				: "No install hint is available for this platform — ask the user how it is normally installed here.";
		return `- ${label}: MISSING —${need}. ${advice}`;
	}

	if (t.status === "version-mismatch") {
		const foundAt = t.candidates?.[0];
		const found = t.version ? `found version ${t.version}${foundAt ? ` at ${foundAt}` : ""}` : "found an unrecognized version";
		const advice = t.installable
			? ` Do not use it as-is. ${selfService(t.installable)}${!usable(t.installable) && t.hint ? ` Upgrade hint: ${t.hint}` : ""}`
			: t.hint
				? ` Do not use it as-is — tell the user to upgrade: ${t.hint}`
				: "";
		return `- ${label}: VERSION MISMATCH —${need}, ${found}.${advice}`;
	}

	// ambiguous
	const list = (t.candidates ?? []).map((c) => `    - ${c}`).join("\n");
	const wayOut = t.installable && usable(t.installable) ? ` Alternatively, ${selfService(t.installable)}` : "";
	return `- ${label}: AMBIGUOUS —${need}. Multiple installations found with inconsistent versions; ask the user which one to use, do not guess:\n${list}${wayOut}`;
}

/**
 * 进系统提示词的那一段。没有清单、或全部 ok 且无 optional 缺失(needsAttention 为
 * 空)时返回 undefined —— 别白占上下文:大多数会话里工具链要么没声明、要么这台
 * 机器上一切正常,这两种情况都不该往系统提示词里塞一个字。
 *
 * 例外是目录资源(configured):它已经落定、不算 needsAttention,但**不在 PATH 上** ——
 * 可执行工具 ok 了模型直接敲名字就行,IDF 根目录在哪却只有这一段会告诉它。
 */
export function promptSectionFor(r: ToolchainResolution): string | undefined {
	if (!r.manifest) return undefined;
	if (r.needsAttention.length === 0 && !r.tools.some((t) => t.status === "configured")) return undefined;
	const header = `Project toolchain requirements (declared in ${MANIFEST_RELATIVE}):`;
	return [header, ...r.tools.map(lineFor)].join("\n");
}
