/**
 * 工具链解析:把 schema(要什么)+ locations/version(这台机器上有什么)+ ledger
 * (上次确认过什么)按七档探测顺序攒成一份结论,再导出成子进程能用的环境变量和
 * 模型能读的提示词片段。这是 toolchain 子系统里唯一"下结论"的模块 —— 其余四个
 * (schema/locations/ledger/version)只回答各自那一小块问题,顺序编排、覆盖规则、
 * "版本不对要不要继续找"这些判断全在这一个文件里。
 *
 * 探测顺序(每一档能被更早的档覆盖,来源见 ResolveSource):
 *   local(项目级手动覆盖) > ledger(这台机器上次确认过的) > env(清单点名的环境变量)
 *   > path(PATH 扫描) > well-known(平台已知安装位置) > registry(Windows 注册表)
 * 命中一档不代表定案:哪一档的版本不满足 tool.version 都不算数,继续往后找 ——
 * 只有全部七档都试过仍不满足才最终报 version-mismatch(见 resolveTool 的循环)。
 * local/ledger/env/path 四档天然只产出一个候选;well-known/registry 可能在同一档
 * 内产出多个目录(比如 CubeIDE 内置 arm-gcc 10.3 和独立装的 13.2 同时存在)——都
 * 满足版本要求时取第一个但把全部记进 candidates,版本满足情况不一致(有的满足
 * 有的不满足)时报 ambiguous 而不是替用户悄悄选一个:悄悄选的后果是"选错照样能
 * 编译,炸在很远的地方"(根 CLAUDE.md 反复出现的那类教训)。
 *
 * 关于 tool.bin 数组的语义:同一个字段在真实清单里被用出了两种意图 —— arm-gcc 的
 * ["arm-none-eabi-gcc","arm-none-eabi-g++","arm-none-eabi-objcopy","arm-none-eabi-size"]
 * 是"这几个可执行文件都要有"(cmake 工具链文件把四个角色都钉死成这几个名字),
 * arm-gdb 的 ["arm-none-eabi-gdb","gdb-multiarch","gdb"] 是"这几个名字随便哪个能
 * 跑就行"(gdb.ts 的 preferredGdbNames 就是纯 alternation)。schema 没有字段区分
 * 这两种意图,这里选了一条对两种意图都不错的统一规则:同一处候选位置(同一次
 * PATH 扫描 / 同一个已知目录)里,只要**至少一个**声明的名字解析到就算这一档
 * 命中;解析到的每个名字各自记进 bin,没解析到的就不出现在结果里 —— arm-gdb 这
 * 类"只需要一个"天然只会产出一个条目,arm-gcc 这类"全部共存于同一目录"的真实
 * 分发形态,实践中会一起解析到,不需要再加一层"必须凑齐几个"的校验。exports 的
 * {bin} 替换、probeVersion 探测用的"这个工具的代表路径",取的都是 tool.bin 声明
 * 顺序里第一个**真的解析到了**的名字(不是数组第一个,是数组里第一个有着落的 ——
 * gdb 场景下声明顺序里第一名常常没装,第二名才是真身)。
 *
 * ledger/local 命中都要先用 existsSync 复核 entry 里每一条记录的路径还在不在 ——
 * 账本记的是"上次问过一次",不是"现在还对";用户卸载重装、或者换了个盘,账本
 * 指向的路径消失,静默拿它去 probeVersion/spawn 只会报一个和真实原因风马牛不相及
 * 的错误("工具坏了"而不是"工具挪了地方")。只要 entry.bin 里有一条路径不在了,
 * 整条 entry 当作过期,不做"部分采信"—— 半新半旧的账本条目比整条重新探测更难
 * 排查,也更难在 promptSectionFor 里说清楚"到底信了哪一半"。
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

import { readLedger, readLocalOverrides } from "./ledger.ts";
import type { Ledger, LedgerEntry } from "./ledger.ts";
import { findOnPath, registryCandidates, wellKnownCandidates } from "./locations.ts";
import { installHint, manifestForSide, MANIFEST_RELATIVE, parseManifest } from "./schema.ts";
import type { ToolchainManifest, ToolSpec } from "./schema.ts";
import { probeVersion, satisfies } from "./version.ts";

export type ToolStatus = "ok" | "version-mismatch" | "ambiguous" | "missing";
export type ResolveSource = "local" | "ledger" | "env" | "path" | "well-known" | "registry";

export interface ResolvedTool {
	id: string;
	status: ToolStatus;
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
}

export interface ToolchainResolution {
	manifestPath?: string;
	manifest?: ToolchainManifest;
	side: "mother" | "runner";
	tools: ResolvedTool[];
	/** 所有非 optional 的都 status==="ok"。 */
	ok: boolean;
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

interface Hit {
	bin: Record<string, string>;
}

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

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

// ─── 七档里的前四档:local / ledger / env / path,天然只产出一个候选 ─────────────

function localHits(tool: ToolSpec, overrides: Record<string, LedgerEntry>): Hit[] {
	const entry = overrides[tool.id];
	if (!entry || !allPathsExist(entry.bin)) return [];
	return [{ bin: entry.bin }];
}

function ledgerHits(tool: ToolSpec, ledger: Ledger): Hit[] {
	const entry = ledger.entries[tool.id];
	if (!entry || !allPathsExist(entry.bin)) return [];
	return [{ bin: entry.bin }];
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
			return [{ bin: { [key]: value } }];
		}
	}
	return [];
}

function pathHits(tool: ToolSpec, env: NodeJS.ProcessEnv): Hit[] {
	const bin: Record<string, string> = {};
	for (const name of tool.bin ?? []) {
		const found = findOnPath(name, env);
		if (found) bin[name] = found;
	}
	return Object.keys(bin).length > 0 ? [{ bin }] : [];
}

// ─── 后两档:well-known / registry,同一档内可能产出多个候选目录 ────────────────

/** 在给定的一组目录里找 names,当它们是唯一的 PATH 条目 —— 复用 findOnPath 的 PATHEXT 展开,不用另写一套。 */
function resolveNamesInDirs(names: string[], dirs: string[], env: NodeJS.ProcessEnv): Record<string, string> | undefined {
	const synthetic: NodeJS.ProcessEnv = { ...env, PATH: dirs.join(path.delimiter) };
	const bin: Record<string, string> = {};
	for (const name of names) {
		const found = findOnPath(name, synthetic);
		if (found) bin[name] = found;
	}
	return Object.keys(bin).length > 0 ? bin : undefined;
}

function wellKnownHits(tool: ToolSpec, platform: string, env: NodeJS.ProcessEnv): Hit[] {
	const names = tool.bin ?? [];
	// 没有声明可执行名字的工具(比如清单里的 stm32cubemx,一个装完自己用的 GUI)
	// 没法靠"在这个目录里找这个名字"确认存在,只能靠 local/ledger 的显式记录 ——
	// 见 stm32cubemx 那条 why 字段自己写的"不走 PATH 探测"。
	if (names.length === 0) return [];
	const hits: Hit[] = [];
	for (const dir of wellKnownCandidates(tool.id, platform)) {
		const bin = resolveNamesInDirs(names, [dir], env);
		if (bin) hits.push({ bin });
	}
	return hits;
}

function registryHits(tool: ToolSpec, platform: string, env: NodeJS.ProcessEnv): Hit[] {
	const names = tool.bin ?? [];
	if (names.length === 0) return [];
	const hits: Hit[] = [];
	for (const dir of registryCandidates(tool.id, platform as NodeJS.Platform)) {
		// InstallLocation 有的厂商就是可执行文件所在目录(SEGGER 的 J-Link),有的是
		// 装了一堆子目录的安装根、可执行文件在它的 bin\ 下 —— 两种都试,不猜是哪种。
		const bin = resolveNamesInDirs(names, [dir, path.join(dir, "bin")], env);
		if (bin) hits.push({ bin });
	}
	return hits;
}

// ─── 单个工具的完整解析 ─────────────────────────────────────────────────────────

interface ResolveCtx {
	/** 已经按 side 筛过的 manifest —— installHint 要用到它的 providers。 */
	manifest: ToolchainManifest;
	localOverrides: Record<string, LedgerEntry>;
	ledger: Ledger;
	platform: string;
	env: NodeJS.ProcessEnv;
}

async function resolveTool(tool: ToolSpec, ctx: ResolveCtx): Promise<ResolvedTool> {
	const names = tool.bin ?? [];
	const optional = tool.optional ?? false;
	const wanted = tool.version;

	// 每一档写成一个 thunk 而不是提前算好的数组:well-known/registry 两档的代价不
	// 便宜(glob 展开、reg.exe 子进程),真正需要的是"只在前面几档都没答案时才去
	// 碰它们",提前算好等于白白替每个工具多跑两次昂贵探测。
	const tiers: Array<[ResolveSource, () => Hit[]]> = [
		["local", () => localHits(tool, ctx.localOverrides)],
		["ledger", () => ledgerHits(tool, ctx.ledger)],
		["env", () => envHits(tool, ctx.env)],
		["path", () => pathHits(tool, ctx.env)],
		["well-known", () => wellKnownHits(tool, ctx.platform, ctx.env)],
		["registry", () => registryHits(tool, ctx.platform, ctx.env)],
	];

	const seen: string[] = [];
	let missSource: ResolveSource | undefined;
	let missVersion: string | undefined;

	const satisfiesWanted = (v: string | undefined): boolean => wanted === undefined || (v !== undefined && satisfies(v, wanted));

	for (const [source, getHits] of tiers) {
		const hits = getHits();
		if (hits.length === 0) continue;

		const probed = await Promise.all(
			hits.map(async (hit) => {
				const primary = primaryBinPath(hit.bin, names);
				const version = primary !== undefined ? await probeVersion(primary) : undefined;
				return { bin: hit.bin, primary, version };
			}),
		);

		const good = probed.filter((p) => satisfiesWanted(p.version));
		const bad = probed.filter((p) => !satisfiesWanted(p.version));

		if (good.length > 0 && bad.length === 0) {
			const winner = good[0];
			return {
				id: tool.id,
				status: "ok",
				optional,
				bin: winner.bin,
				version: winner.version,
				wanted,
				source,
				// 只有一个候选时不必列 candidates —— bin/version 已经说完了全部事实。
				candidates: probed.length > 1 ? dedupe(probed.map((p) => p.primary).filter((p): p is string => p !== undefined)) : undefined,
				why: tool.why,
			};
		}

		if (good.length > 0 && bad.length > 0) {
			// 同一档内多个候选,版本满足情况却不一致 —— 不能替用户悄悄挑一个能用的:
			// 见文件头 CubeIDE 10.3 / 独立装 13.2 那个真实场景,悄悄选错的代价是"编
			// 得过,炸在很远的地方"。把两种都亮出来,交给用户或人工确认。
			const winner = good[0];
			return {
				id: tool.id,
				status: "ambiguous",
				optional,
				bin: winner.bin,
				version: winner.version,
				wanted,
				source,
				candidates: dedupe(probed.map((p) => p.primary).filter((p): p is string => p !== undefined)),
				why: tool.why,
			};
		}

		// 这一档命中了,但没有一个满足版本 —— 记下来,交给下一档碰碰运气(下一档
		// 可能是版本更合适的安装)。只记第一次撞见的 source/version 做为参考:
		// 后面几档即使同样不满足,报告里"最先在哪撞见的"已经够用,不需要罗列每一档。
		if (missSource === undefined) {
			missSource = source;
			missVersion = probed.find((p) => p.version !== undefined)?.version;
		}
		for (const p of probed) if (p.primary !== undefined) seen.push(p.primary);
	}

	const hint = installHint(ctx.manifest, tool, ctx.platform);

	if (seen.length > 0) {
		// 全部七档都探过一遍,没有一个满足版本 —— 定案。bin 留空:没有任何一个候选
		// "赢",candidates 是唯一能看到"到底找到了什么、只是版本不对"的地方。
		return {
			id: tool.id,
			status: "version-mismatch",
			optional,
			bin: {},
			version: missVersion,
			wanted,
			source: missSource,
			candidates: dedupe(seen),
			hint,
			why: tool.why,
		};
	}

	return { id: tool.id, status: "missing", optional, bin: {}, wanted, hint, why: tool.why };
}

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

export async function resolveToolchain(opts: {
	projectDir: string;
	configDir?: string;
	side?: "mother" | "runner";
	platform?: string;
	env?: NodeJS.ProcessEnv;
	/** 注入用,给测试和工位端(它没有项目检出,清单是当附件送过去的)。 */
	manifestText?: string;
}): Promise<ToolchainResolution> {
	const side = opts.side ?? "mother";
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;

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

	const manifest = manifestForSide(parsed.manifest, side);
	const [localOverrides, ledger] = await Promise.all([readLocalOverrides(opts.projectDir), readLedger(opts.configDir)]);

	const tools: ResolvedTool[] = [];
	for (const tool of manifest.tools) {
		tools.push(await resolveTool(tool, { manifest, localOverrides, ledger, platform, env }));
	}

	return {
		manifestPath: loaded.filePath,
		manifest,
		side,
		tools,
		ok: tools.every((t) => t.optional || t.status === "ok"),
		needsAttention: tools.filter((t) => t.status !== "ok"),
	};
}

// ─── 子进程环境 ──────────────────────────────────────────────────────────────

/** base 里已经存在的 PATH 键,不管大小写 —— 找不到就返回 undefined,让调用方决定默认键名。 */
function findExistingPathKey(env: NodeJS.ProcessEnv): string | undefined {
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "PATH") return key;
	}
	return undefined;
}

/**
 * 解析结果 -> 子进程环境:把每个 ok 工具的 bin 所在目录前置进 PATH,再按 exports
 * 填变量。base 里已有的同名变量:exports 不覆盖(用户显式设的赢),PATH 是前置
 * 不是替换。
 */
export function shellEnvFor(r: ToolchainResolution, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base };

	// 只前置真正需要的那几个目录,不是整棵安装树 —— 塞太多会遮蔽用户自己 PATH 上
	// 同名但不同版本的工具,而这正是清单要解决的"选错版本"问题的反面。去重且保持
	// 工具在 r.tools 里的声明顺序:同一目录被两个工具的 bin 同时指到时只前置一次。
	const dirs: string[] = [];
	const seenDirs = new Set<string>();
	for (const tool of r.tools) {
		if (tool.status !== "ok") continue;
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
		const pathKey = findExistingPathKey(base) ?? "PATH";
		const current = out[pathKey] ?? "";
		out[pathKey] = [...dirs, current].filter(Boolean).join(path.delimiter);
	}

	if (r.manifest) {
		for (const toolSpec of r.manifest.tools) {
			const exportsSpec = toolSpec.exports;
			if (!exportsSpec) continue;
			const resolved = r.tools.find((t) => t.id === toolSpec.id);
			// 只对 ok 的工具应用 exports:工具没解析成功时塞一个指向不存在路径的
			// 环境变量,比压根不设更容易把 agent 引去撞一个看起来毫不相关的错误。
			if (!resolved || resolved.status !== "ok") continue;
			const primary = primaryBinPath(resolved.bin, toolSpec.bin ?? []);
			if (primary === undefined) continue;
			for (const [varName, template] of Object.entries(exportsSpec)) {
				if (out[varName] !== undefined) continue; // 用户 / base 显式设的赢,exports 不覆盖
				out[varName] = template.replaceAll("{bin}", primary);
			}
		}
	}

	return out;
}

// ─── 系统提示词片段 ─────────────────────────────────────────────────────────────

function lineFor(t: ResolvedTool): string {
	const label = t.optional ? `${t.id} (optional)` : t.id;
	const need = t.wanted ? ` needs ${t.wanted}` : "";

	if (t.status === "ok") {
		const primary = Object.values(t.bin)[0];
		const versionPart = t.version ? `version ${t.version}` : "version unknown";
		return `- ${label}: OK —${need}, resolved to ${primary} (${versionPart}, source: ${t.source ?? "unknown"}).`;
	}

	if (t.status === "missing") {
		const advice = t.hint
			? `Do not guess a path or hardcode one — tell the user to install it: ${t.hint}`
			: "No install hint is available for this platform — ask the user how it is normally installed here.";
		return `- ${label}: MISSING —${need}. ${advice}`;
	}

	if (t.status === "version-mismatch") {
		const foundAt = t.candidates?.[0];
		const found = t.version ? `found version ${t.version}${foundAt ? ` at ${foundAt}` : ""}` : "found an unrecognized version";
		const advice = t.hint ? ` Do not use it as-is — tell the user to upgrade: ${t.hint}` : "";
		return `- ${label}: VERSION MISMATCH —${need}, ${found}.${advice}`;
	}

	// ambiguous
	const list = (t.candidates ?? []).map((c) => `    - ${c}`).join("\n");
	return `- ${label}: AMBIGUOUS —${need}. Multiple installations found with inconsistent versions; ask the user which one to use, do not guess:\n${list}`;
}

/**
 * 进系统提示词的那一段。没有清单、或全部 ok 且无 optional 缺失(needsAttention 为
 * 空)时返回 undefined —— 别白占上下文:大多数会话里工具链要么没声明、要么这台
 * 机器上一切正常,这两种情况都不该往系统提示词里塞一个字。
 */
export function promptSectionFor(r: ToolchainResolution): string | undefined {
	if (!r.manifest || r.needsAttention.length === 0) return undefined;
	const header = `Project toolchain requirements (declared in ${MANIFEST_RELATIVE}):`;
	return [header, ...r.tools.map(lineFor)].join("\n");
}
