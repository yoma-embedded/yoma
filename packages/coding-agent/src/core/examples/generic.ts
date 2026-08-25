/**
 * generic 生态的 AI 索引器(PLAN-codelib-console D2/D11)。
 *
 * 任意代码树(不限 esp-idf/stm32cube)没有可机械判定的例程语义,所以条目本身
 * 也由模型决定:必填的「说明」(description)+ 树摘要 → deepseek 提议条目(整树一条
 * 或每个连贯子工程一条)→ **代码核验**(模型提议、代码裁决):
 *
 *   - path 必须真实存在于树内(幻觉即丢);
 *   - 去重、上限 200;
 *   - targets/peripherals 全小写,判断不了留空(空 = 检索不排除,schema 语义现成);
 *   - loc/files 由代码实测(模型说的不算);
 *   - buildable 恒 false + buildNote「generic 语料,未验证可编译」
 *     (沿用"可读 ≠ 可作底盘"的承诺);
 *   - 最后过 isExampleEntry 逐条终检,坏条即丢并计入日志。
 *
 * 模型调用是注入的(EnrichCompletion,与 enrich.ts 同一接口):本文件不 import
 * 模型层,测试注入假模型。产物落盘复用 store.ts 的 writeIndexFile —— 与机械
 * 抽取器的索引同格式,客户端零感知。
 *
 * 两个入口,**共用同一段核验代码**(verifyEntries):
 *
 *   indexGeneric    树摘要 → 提示词 → 模型 → 核验 → 落盘   (一次性调用,便宜的兜底)
 *   verifyProposal  自带提议 ─────────────→ 核验 → 落盘   (agent / provided 两条通道)
 *
 * 分成两个入口而不是"verifyProposal 塞个假 complete 进 indexGeneric",是因为
 * indexGeneric 开头无条件跑 buildTreeSummary,而那玩意儿**逐个文件 readFileSync
 * 数行数** —— proposal 模式压根不需要摘要,在 zephyr/Cube 这种树上是几分钟的纯浪费。
 * 但核验必须是同一份代码:两条路的闸门强度不一样,等于其中一条没有闸门。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { EntryKind, ExampleEntry, ExamplesIndex, Indexer, TargetSource, Tier } from "./schema.ts";
import { ENTRY_KINDS, INDEX_SCHEMA_TAG, isExampleEntry, TARGET_SOURCES, TIERS } from "./schema.ts";
import { writeIndexFile } from "./store.ts";
import { countLoc, walkFilesCapped } from "./extract-util.ts";
import type { EnrichCompletion } from "./enrich.ts";

/**
 * 条目上限(PLAN D2)。可用 `YOMA_CODELIB_MAX_ENTRIES` 覆盖。
 *
 * 200 对 167 条清单里的大仓不够:zephyr 有 703 个 samples,默认上限会砍掉 500 条。
 * 被砍掉的计进 `dropReasons["over-limit"]` 而不是混在总丢弃数里 ——「上限截断」和
 *「模型编了不存在的路径」要能在日志里一眼分开。
 */
export const GENERIC_MAX_ENTRIES = Number(process.env.YOMA_CODELIB_MAX_ENTRIES) || 200;
/**
 * 树摘要预算:超过即截断并如实 log,不静默截断。
 *
 * 8000 对真实代码库远远不够 —— tinyusb 实测丢掉 805 行,丢的正是整个
 * examples/ 段,模型于是一条都提不出来(日志"可加大后重跑"以前无处可加)。
 * 现在默认 60000,并允许用 YOMA_CODELIB_SUMMARY_BUDGET 覆盖。
 */
export const SUMMARY_BUDGET_CHARS = Number(process.env.YOMA_CODELIB_SUMMARY_BUDGET) || 60_000;
/**
 * 遍历文件数上限。共享默认值是 **2000**,对整棵代码树远远不够:遍历是字典序 DFS,
 * 所以 Cube 固件包会在 `Drivers/` 里就把名额吃光,`Projects/` 一个文件都进不了摘要。
 *
 * 光调大不够 —— 真正的问题是从前**撞上限时一声不吭**,"这棵树就这么大"和"我只看了
 * 前 2000 个"在返回值上完全一样。所以配套改的是 `walkFilesCapped`:它返回
 * `truncated`,这里据此如实记一笔(见 buildTreeSummary 与 verifyEntries)。
 * 可用 `YOMA_CODELIB_MAX_FILES` 覆盖。
 */
export const WALK_MAX_FILES = Number(process.env.YOMA_CODELIB_MAX_FILES) || 200_000;
/** 关键文件名:摘要里单独列出的"这个文件很可能是入口/说明"文件。 */
const KEY_FILES = new Set([
	"readme.md", "readme", "readme.txt", "cmakelists.txt", "makefile", "sdkconfig.defaults",
	"idf_component.yml", "project.ini", "package.json", "pyproject.toml", "cargo.toml",
	"main.c", "main.cpp", "app.c", "app.cpp", "*.ioc",
]);

function lineCount(abs: string): number {
	try {
		const text = readFileSync(abs, "utf8");
		return text.split(/\r?\n/).length;
	} catch {
		return 0;
	}
}

/** 树摘要:目录骨架 + 每目录文件数/总行数 + 关键文件名 + README 头部若干行。 */
export function buildTreeSummary(root: string, budget: number = SUMMARY_BUDGET_CHARS): { summary: string; truncated: string[] } {
	const truncated: string[] = [];
	const dirs = new Map<string, { files: number; lines: number; keyFiles: string[] }>();
	const readmes: Array<{ rel: string; head: string }> = [];

	const walk = walkFilesCapped(root, WALK_MAX_FILES);
	if (walk.truncated) {
		// 遍历撞上限时摘要必然缺了一整块树,而缺哪一块取决于字典序 —— 必须说出来,
		// 否则模型"没提议"和"根本没看到"在日志里没法区分。
		truncated.push(`(文件遍历撞上限 ${WALK_MAX_FILES},树里后面的部分没进摘要 —— 调大 YOMA_CODELIB_MAX_FILES)`);
	}
	for (const rel of walk.files) {
		if (rel.includes("/.git/") || rel.startsWith(".git/")) continue;
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		const entry = dirs.get(dir) ?? { files: 0, lines: 0, keyFiles: [] };
		entry.files += 1;
		entry.lines += lineCount(path.join(root, rel));
		const base = rel.split("/").pop() ?? "";
		if (KEY_FILES.has(base.toLowerCase()) || base.toLowerCase().endsWith(".ioc")) {
			entry.keyFiles.push(base);
		}
		dirs.set(dir, entry);
		if (/readme/i.test(base)) {
			try {
				const text = readFileSync(path.join(root, rel), "utf8");
				readmes.push({ rel, head: text.split(/\r?\n/).slice(0, 8).join("\n") });
			} catch {
				// unreadable README (binary?) - skip
			}
		}
	}

	const lines: string[] = [];
	lines.push("目录骨架(文件数 / 总行数 / 关键文件):");
	for (const [dir, e] of [...dirs.entries()].sort()) {
		const key = e.keyFiles.length ? `  [${e.keyFiles.join(",")}]` : "";
		lines.push(`  ${dir || "."}/  ${e.files} 文件 / ${e.lines} 行${key}`);
	}
	lines.push("", "各 README 头部(供判断工程意图):");
	for (const r of readmes) {
		lines.push(`--- ${r.rel} ---\n${r.head}`);
	}

	let summary = lines.join("\n");
	while (summary.length > budget) {
		// 从后往前砍行,直到进预算;记录砍掉了什么。
		const dropped = summary.split("\n").pop() ?? "";
		summary = summary.split("\n").slice(0, -1).join("\n");
		truncated.push(dropped);
	}
	return { summary, truncated };
}

export interface GenericIndexOptions {
	root: string;
	corpusId: string;
	description: string;
	configDir?: string;
	complete: EnrichCompletion;
	model: string;
	/** 语料级默认分层,写进 header;条目未标 tier 时由 parseIndex 继承。 */
	tier?: Tier;
	/** 产出通道,写进 header。缺省 "llm" —— 这条路就是一次性调用。 */
	indexer?: Indexer;
}

/**
 * 核验层丢弃条目的原因。分类记账而不是只给总数:「上限砍掉 500 条」和「模型编了
 * 500 个不存在的路径」在总数上长得一模一样,处置却完全相反(前者调上限,后者查模型)。
 */
export const DROP_REASONS = ["bad-path", "path-not-exist", "duplicate", "over-limit", "bad-entry"] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export type DropReasons = Partial<Record<DropReason, number>>;

export interface GenericIndexResult {
	index: ExamplesIndex;
	file: string;
	/** 被核验丢弃的条目总数 —— 等于 dropReasons 各项之和,保留给老调用点。 */
	dropped: number;
	/** 按原因分类的丢弃数,取值见 DROP_REASONS。 */
	dropReasons: DropReasons;
	/** 摘要截断时记录丢了什么(无静默截断纪律)。proposal 模式恒为空:它不建摘要。 */
	summaryTruncated: string[];
	/**
	 * 模型整体输出解析失败的原因;null = 解析成功。
	 *
	 * 解析失败和"模型确实没提议"都得 0 条,但成因完全不同(前者是输出被
	 * max_tokens 截断这类传输问题,后者是模型判断)。不分开记的话,传输故障
	 * 会伪装成"这个库没东西可索引" —— 实测吃过一次亏。
	 */
	parseError: string | null;
	/**
	 * 可选枚举字段(entryKind/tier/targetSource)取值非法时的记录。取值收敛成"未标"
	 * 而不是丢掉整条 —— 为一个拼错的 tier 丢掉一条真实存在的例程,损失更大。但必须
	 * 记一笔:静默收敛之后分层过滤会悄悄失效,而日志上什么都看不出来。
	 */
	fieldWarnings: string[];
}

/** 提议里的一条。字段全 unknown:提议来自模型,校验在 verifyEntries 里。 */
interface ProposalEntry {
	path?: unknown;
	title?: unknown;
	summary?: unknown;
	targets?: unknown;
	peripherals?: unknown;
	entryKind?: unknown;
	tier?: unknown;
	targetSource?: unknown;
}

/**
 * 一份提议。`libraryKind` / `candidateCount` 来自 codelib-index 技能的输出格式,
 * 一次性调用不产出它们 —— 缺了就是缺了,不编。`evidence`(证据链)不进索引 header:
 * 它可以很长,归服务器的 meta.json / indexerDetail 保管。
 */
interface ModelProposal {
	libraryKind?: unknown;
	candidateCount?: unknown;
	entries?: ProposalEntry[];
}

function toLowerList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === "string" && v.trim() !== "") {
			const t = v.trim().toLowerCase();
			if (!out.includes(t)) out.push(t);
		}
	}
	return out;
}

function strOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

interface VerifyContext {
	root: string;
	corpusId: string;
	tier?: Tier;
	indexer?: Indexer;
}

type VerifiedProposal = Omit<GenericIndexResult, "file" | "summaryTruncated">;

/** 核名不是芯片名 —— 用户不会拿它当芯片查,填了反而会被 targetMatches 主动排除。 */
const CORE_NAMES = ["cortex", "armv", "riscv", "risc-v", "xtensa", "aarch"];
/** 这些本身就是用户会输入的芯片名,不算核名。 */
const CHIP_LIKE = ["rp2040", "esp32", "msp430", "avr", "pic32", "rx600", "rx6"];
/** 它们是证据来源,不是"能当起点"的候选。 */
const JUNK_SEGMENTS = ["test", "tests", "benches", "bench", "fuzzing", "fuzz", "docs", ".github", ".gitlab", "third_party", "vendor", "deps"];
/** 低于这个行数基本是占位目录 / 没拉下来的子模块,不是起点。 */
const MIN_LOC = 10;
/** 同一父目录下的兄弟条目超过这个数,就该说得出"用户按哪个词挑"。 */
const FANOUT_WARN = 10;

/**
 * 质量体检:把 SKILL.md 自查清单里**机械可判**的那几条变成代码。
 *
 * 只报警告,不改判成败 —— 硬核验(路径存在 / 去重 / 上限 / isExampleEntry)才决定丢不丢。
 * 软规则有正当例外:FreeRTOS 的 `portable/GCC` 下 54 条兄弟是对的(用户就是按端口挑),
 * 一票否决会教人忽略整个警告通道。
 *
 * 每类聚合成一条 —— `fieldWarnings` 截断在 10 条,一条目一条会把别的警告挤掉。
 */
function qualityLint(entries: ExampleEntry[], candidateCount: number | undefined): string[] {
	const notes: string[] = [];
	const some = (bad: string[], head: string): void => {
		if (bad.length === 0) return;
		notes.push(`质量:${bad.length} 条${head} —— ${bad.slice(0, 5).join("、")}${bad.length > 5 ? " 等" : ""}`);
	};

	if (candidateCount !== undefined && candidateCount < entries.length) {
		notes.push(`质量:candidateCount(${candidateCount})小于条目数(${entries.length})—— 口径是"枚举出的全部候选,含主动放弃的"`);
	}
	some(entries.filter((x) => x.loc < MIN_LOC).map((x) => `${x.path}(${x.loc} 行)`),
		`目录里几乎没有源码(<${MIN_LOC} 行),不该建条目`);
	some(entries.filter((x) => x.path.split("/").some((seg) => JUNK_SEGMENTS.includes(seg))).map((x) => x.path),
		"建在测试 / 文档 / 第三方目录上");
	some(entries.filter((x) => x.peripherals.length < 2).map((x) => x.path),
		"peripherals 不足 2 个(它是硬过滤,漏标即在带该词的查询里隐身)");
	some(entries.filter((x) => x.targets.some((t) => {
		const low = t.toLowerCase();
		return CORE_NAMES.some((core) => low.startsWith(core)) && !CHIP_LIKE.includes(low);
	})).map((x) => `${x.path}[${x.targets.join(",")}]`),
		"targets 里是核名不是芯片名(比留空更糟:会被主动排除)");
	some(entries.filter((x) => x.targets.some((t) => t.length < 3)).map((x) => `${x.path}[${x.targets.join(",")}]`),
		"targets 前缀短于 3 字符,会吸走别家芯片的查询");
	some(entries.filter((x) => x.tier === undefined).map((x) => x.path),
		"没有显式标 tier(会继承语料级默认,可移植库因此整库在主用途里隐身)");

	const byParent = new Map<string, number>();
	for (const entry of entries) {
		const parent = entry.path.split("/").slice(0, -1).join("/") || "(仓库根)";
		byParent.set(parent, (byParent.get(parent) ?? 0) + 1);
	}
	const fanout = [...byParent.entries()].filter(([, n]) => n > FANOUT_WARN).sort((a, b) => b[1] - a[1]);
	if (fanout.length > 0) {
		notes.push(
			`质量:兄弟条目过多 —— ${fanout.slice(0, 4).map(([dir, n]) => `${dir}/ ${n} 条`).join("、")}` +
				`;说得出"用户会输入哪个词来挑"(芯片 / 板 / 端口 / 协议名)就留着,说不出该合并成一条并把能力词聚合上去`,
		);
	}
	return notes;
}

/**
 * 提议 -> 索引的**核验层**:规则全部是确定性的(PLAN D2),模型说了不算 ——
 * path 必须存在、去重、上限、小写化、loc/files 实测、buildable 恒 false、
 * isExampleEntry 终检。indexGeneric 与 verifyProposal 共用这一段。
 */
function verifyEntries(raw: string, options: VerifyContext): VerifiedProposal {
	const root = path.resolve(options.root);
	const index: ExamplesIndex = {
		header: {
			schema: INDEX_SCHEMA_TAG,
			corpus: options.corpusId,
			ecosystem: "generic",
			generatedAt: new Date().toISOString(),
			entries: 0,
			...(options.indexer ? { indexer: options.indexer } : {}),
			...(options.tier ? { tier: options.tier } : {}),
		},
		entries: [],
	};
	const seen = new Set<string>();
	const dropReasons: DropReasons = {};
	const warned = new Map<string, number>();
	let parseError: string | null = null;

	const drop = (reason: DropReason): void => {
		dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
	};
	/** 非法枚举值 -> undefined(当"未标")+ 记一笔。收敛必须留痕,静默收敛是这个项目的老伤。 */
	const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => {
		if (value === undefined || value === null || value === "") return undefined;
		if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
		const note = `${field}=${JSON.stringify(value)} 不是合法取值(只认 ${allowed.join(" / ")}),已当"未标"处理`;
		warned.set(note, (warned.get(note) ?? 0) + 1);
		return undefined;
	};

	try {
		const parsed = JSON.parse(raw) as ModelProposal;
		const libraryKind = strOr(parsed.libraryKind, "");
		if (libraryKind) index.header.libraryKind = libraryKind;
		if (typeof parsed.candidateCount === "number" && Number.isFinite(parsed.candidateCount)) {
			index.header.candidateCount = parsed.candidateCount;
		}
		const proposed = Array.isArray(parsed.entries) ? parsed.entries : [];
		for (const item of proposed) {
			// 顺序是有讲究的:**先做便宜的校验,再判上限**。反过来的话,撞上限之后的
			// 幻觉路径与重复项会一律记成 over-limit,分类记账就白做了 —— 而 CLI 会据此
			// 建议「调大上限重跑」,那批条目调大了也拿不到。
			// 上限判定放在实测 loc/files 之前,是因为那一步要走整棵子树,对被砍掉的
			// 条目走一遍纯属浪费(zephyr 703 个 samples,上限 200)。
			const rel = strOr(item.path, "");
			if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
				drop("bad-path");
				continue;
			}
			const abs = path.join(root, rel);
			if (!existsSync(abs)) {
				drop("path-not-exist");
				continue;
			}
			const key = rel.replace(/\/+$/, "");
			if (seen.has(key)) {
				drop("duplicate");
				continue;
			}
			seen.add(key);
			if (index.entries.length >= GENERIC_MAX_ENTRIES) {
				drop("over-limit");
				continue;
			}
			const isDir = statSync(abs).isDirectory();
			// 一次遍历用两次:从前这里走了两趟同一棵子树。上限同样显式给,并在撞上时
			// 记一笔 —— loc/files 是发布出去的规模数字,悄悄封顶在 2000 就是发布了假数据。
			// 一次遍历用两次:从前这里走了两趟同一棵子树。撞上限时记一笔 —— loc/files
			// 是发布出去的规模数字,悄悄封顶就是发布了假数据。
			const walked = isDir ? walkFilesCapped(abs, WALK_MAX_FILES) : { files: [], truncated: false };
			if (walked.truncated) {
				warned.set(`${key}: 文件遍历撞上限 ${WALK_MAX_FILES},loc/files 是下界不是实数`, 1);
			}
			const files = isDir ? walked.files.length : 1;
			const loc = isDir ? countLoc(walked.files.map((f) => path.join(abs, f))) : lineCount(abs);
			const entryKind: EntryKind | undefined = pickEnum(item.entryKind, ENTRY_KINDS, "entryKind");
			const tier: Tier | undefined = pickEnum(item.tier, TIERS, "tier");
			const targetSource: TargetSource | undefined = pickEnum(item.targetSource, TARGET_SOURCES, "targetSource");
			const entry: ExampleEntry = {
				id: `${options.corpusId}/${key}`,
				corpus: options.corpusId,
				ecosystem: "generic",
				path: key,
				name: key.split("/").pop() || key,
				title: strOr(item.title, key.split("/").pop() || key),
				summary: strOr(item.summary, ""),
				targets: toLowerList(item.targets),
				peripherals: toLowerList(item.peripherals),
				buildable: false,
				buildNote: "generic 语料,未验证可编译",
				loc,
				files,
				...(entryKind ? { entryKind } : {}),
				...(tier ? { tier } : {}),
				...(targetSource ? { targetSource } : {}),
				extractorVersion: 1,
			};
			if (!isExampleEntry(entry)) {
				drop("bad-entry");
				continue;
			}
			index.entries.push(entry);
		}
	} catch (e) {
		// 解析失败 ≠ 模型没提议。最常见的成因是输出被 max_tokens 截断,JSON 断在
		// 半路;不记下来的话调用方只看到 0 条 0 丢弃,和"模型判断这里没东西"无法区分。
		parseError = e instanceof Error ? e.message : String(e);
	}

	index.header.entries = index.entries.length;
	// 质量体检放在这里,而不是放进某个本机 CLI —— 建库(codelibs.py 的 `cli.ts index --proposal`)
	// 与干跑(`POST /api/codelibs/validate`)都在这条路上,而建索引的 agent 跑的是
	// `--tools read,grep,find,ls,write`(**没有 bash**),它跑不了任何校验脚本。清单只有变成
	// 这里的代码才数得清:每次建库的 job 日志、干跑的返回、本机 verify-proposal,三处一起白得。
	for (const note of qualityLint(index.entries, index.header.candidateCount)) warned.set(note, 1);
	const fieldWarnings = [...warned.entries()]
		.slice(0, 10)
		.map(([note, count]) => (count > 1 ? `${note}(${count} 处)` : note));
	if (warned.size > 10) fieldWarnings.push(`……另有 ${warned.size - 10} 类同样的字段问题未列出`);
	const dropped = Object.values(dropReasons).reduce((sum, n) => sum + n, 0);
	return { index, dropped, dropReasons, parseError, fieldWarnings };
}

/**
 * 一次性调用:树摘要 → 提示词 → 模型 → 核验 → 落盘。便宜的兜底通道 —— 实测覆盖率
 * 远不如 agent(tinyusb 38/46 vs 46/46,且例程条目 targets 全空),保留是因为它
 * 不需要 agent 运行时。提示词刻意没有跟着加 entryKind/tier/targetSource:这条路是
 * 冻结的兜底,新字段留空即"未标",行为与从前逐字相同。
 */
export async function indexGeneric(options: GenericIndexOptions): Promise<GenericIndexResult> {
	const root = path.resolve(options.root);

	const { summary, truncated } = buildTreeSummary(root);
	const prompt = [
		"你是嵌入式/软件代码库的索引员。下面是一个代码库的「说明」和「目录摘要」。",
		"请把它切成连贯的索引条目:每个可独立理解的工程/模块目录一条,或整树一条。",
		`最多 ${GENERIC_MAX_ENTRIES} 条。`,
		"",
		`【说明】${options.description}`,
		"",
		`【目录摘要】\n${summary}`,
		"",
		"输出严格 JSON(不要 markdown 围栏):{\"entries\":[{path, title, summary, targets, peripherals}]}",
		"- path: 相对语料根的目录或文件路径,必须真实存在于摘要中;",
		"- targets: 芯片/平台,全小写;不确定就留空数组;",
		"- peripherals: 外设/能力词,全小写;不确定就留空;",
		"- title/summary: 简短中文标题与一句话说明。",
	].join("\n");

	const raw = await options.complete(
		"你输出严格的 JSON,不输出任何其他文字。",
		prompt,
	);

	const verified = verifyEntries(raw, {
		root,
		corpusId: options.corpusId,
		tier: options.tier,
		indexer: options.indexer ?? "llm",
	});
	const file = writeIndexFile(verified.index, options.configDir);
	return { ...verified, file, summaryTruncated: truncated };
}

export interface VerifyProposalOptions {
	root: string;
	corpusId: string;
	/** 提议:JSON 文本(直接是 agent 产出的文件内容)或已解析的对象。 */
	proposal: string | object;
	configDir?: string;
	/** 语料级默认分层 —— 69 个 lib 层的仓只要在这里标一次,读侧继承会铺到每一条。 */
	tier?: Tier;
	/** 缺省 "provided";服务器侧自己跑 agent 时传 "agent" —— 产出来源要能指认。 */
	indexer?: Indexer;
}

/**
 * 自带提议进核验层 —— `agent` 与 `provided` 两条通道共用的接缝,也是
 * `POST /api/codelibs/validate` 的 dry-run 语义。
 *
 * 与 indexGeneric 的唯一区别是不建摘要、不调模型(理由见文件头);核验那一段是
 * 同一个函数,两条路的闸门强度必须一样。
 *
 * 同步:除落盘外零 IO,没有理由让调用方 await 一个假的 Promise。
 */
export function verifyProposal(options: VerifyProposalOptions): GenericIndexResult {
	const raw = typeof options.proposal === "string" ? options.proposal : JSON.stringify(options.proposal);
	const verified = verifyEntries(raw, {
		root: options.root,
		corpusId: options.corpusId,
		tier: options.tier,
		indexer: options.indexer ?? "provided",
	});
	const file = writeIndexFile(verified.index, options.configDir);
	return { ...verified, file, summaryTruncated: [] };
}
