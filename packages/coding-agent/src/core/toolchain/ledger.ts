/**
 * 本机工具链账本:`<configDir>/toolchains.json`,不进 git —— 记的是"这台机器上已经
 * 确认过的工具在哪、什么版本"。resolve.ts 的探测顺序里排第二档("ledger"),仅次于
 * 项目的 toolchain.local.json 显式指定:同一台机器问过一次(不管是自动探测唯一命中,
 * 还是用户从 ambiguous 候选里手动选的)不该每次启动都重新扫一遍 PATH / 已知安装
 * 位置 / 注册表 —— 那三档本身就不便宜(尤其是 probeVersion 要真的起子进程)。
 *
 * ## configDir 语义对齐
 *
 * 默认目录与 kernel 的 `packages/kernel/src/host/auth.ts` 的 `myPiConfigDir()` 同一个
 * `~/.my-pi`(该文件本身的注释也说了,那是抄的 my-pi ACP 适配器的 CONFIG_DIR)。
 * 这里**不 import** 它:coding-agent 在依赖图里比 kernel 更底层(kernel 消费
 * coding-agent 的工具集,resolve.ts 将来会被 kernel 的 host 用来给 agent 子进程铺
 * PATH),反向 import 会成环。默认值就地重新算一遍 —— 两边各自维护同一个常量、
 * 含义必须保持一致,这正是根 CLAUDE.md 点过名的那类"没有类型系统能抓住的漂移点",
 * 只能靠读代码时对照,不是本模块能单方面根治的。
 *
 * **configDir 必须是可注入参数,默认值只在调用方没传时才求值**:Bun 的 `os.homedir()`
 * 在进程启动那一刻就定死,运行时改 `process.env.HOME` 对它无效(根 CLAUDE.md 与
 * `host/auth.ts` 都踩过同一个坑——以为换了 HOME,实际把开发机真实的文件洗掉了)。
 * 所以测试一律显式传 `mkdtemp` 建的临时目录,不允许依赖任何默认值分支。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { LOCAL_RELATIVE } from "./schema.ts";

export interface LedgerEntry {
	id: string;
	/** 可执行名 -> 绝对路径,如 {"arm-none-eabi-gcc": "C:\\...\\bin\\arm-none-eabi-gcc.exe"}。 */
	bin: Record<string, string>;
	version?: string;
	confirmedAt: number;
	/** "auto" = 探测自动命中且唯一;"user" = 多候选时由人从 ambiguous 列表里选定。 */
	by: "auto" | "user";
}

export interface Ledger {
	schema: "yoma/toolchains@1";
	entries: Record<string, LedgerEntry>;
}

const SCHEMA_TAG = "yoma/toolchains@1";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 结构校验,不只是"能 JSON.parse"。逐条过滤而不是整份文件一坏俱坏 —— 手改账本
 * (或者未来版本改了字段)弄坏其中一条,不该连累其它已经确认过的条目一起被当成
 * 没探测过,平白让 resolve.ts 对着一台明明装好的机器重新问用户一遍。
 */
function isLedgerEntry(value: unknown): value is LedgerEntry {
	if (!isPlainObject(value)) return false;
	if (typeof value.id !== "string" || value.id.trim() === "") return false;
	const bin = value.bin;
	if (!isPlainObject(bin)) return false;
	if (!Object.values(bin).every((v) => typeof v === "string")) return false;
	if (value.version !== undefined && typeof value.version !== "string") return false;
	if (typeof value.confirmedAt !== "number") return false;
	if (value.by !== "auto" && value.by !== "user") return false;
	return true;
}

function emptyLedger(): Ledger {
	return { schema: SCHEMA_TAG, entries: {} };
}

/** 和 kernel `host/auth.ts` 的 `myPiConfigDir()` 同一个目录 —— 见文件头注释。 */
function defaultConfigDir(): string {
	return path.join(homedir(), ".my-pi");
}

/** 默认 `<configDir>/toolchains.json`,configDir 默认 `~/.my-pi`。 */
export function ledgerPath(configDir: string = defaultConfigDir()): string {
	return path.join(configDir, "toolchains.json");
}

/**
 * 容错读:文件不存在、JSON 损坏、顶层形状不对、schema 标签对不上,一律当空账本
 * 返回,不抛。这份文件只是"省得对同一台机器重新探测一遍"的缓存 —— 读不出来最坏
 * 后果是 resolve.ts 老老实实重新走一遍探测顺序,而不是任何东西崩掉;抛异常只会把
 * 一个纯缓存变成一个新的失败点。
 */
export async function readLedger(configDir?: string): Promise<Ledger> {
	let text: string;
	try {
		text = readFileSync(ledgerPath(configDir), "utf8");
	} catch {
		return emptyLedger();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return emptyLedger();
	}
	if (!isPlainObject(parsed)) return emptyLedger();
	// schema 标签必须匹配,不是"有就行":未来版本万一改了 entry 形状,旧代码把新
	// 格式的文件当 v1 读会产出看似合法实则错位的字段。对不上就当没有,比对错更安全 ——
	// 下一次 writeLedgerEntry 会用当前版本的形状把它覆盖回去。
	if (parsed.schema !== SCHEMA_TAG) return emptyLedger();

	const rawEntries = parsed.entries;
	if (!isPlainObject(rawEntries)) return emptyLedger();

	const entries: Record<string, LedgerEntry> = {};
	for (const [id, value] of Object.entries(rawEntries)) {
		if (isLedgerEntry(value)) entries[id] = value;
	}
	return { schema: SCHEMA_TAG, entries };
}

/**
 * 落盘前先写一个各自专属的临时文件,再 rename 到目标名。rename 到同目录下的既有
 * 文件名是文件系统提供的原子替换(POSIX 如此;Windows 的 libuv 实现同样整体替换
 * 目标,而不是"先删再建"那种会露出中间态的两步操作——这条在 Windows 开发机上
 * 随本模块的测试一起实测),半个 JSON 不会以 `toolchains.json` 这个名字出现在磁盘上。
 * 这份文件是"用户手动指过哪条路径"的唯一记录:写一半时进程被杀,下次 readLedger
 * 直接全废,等于要把 ambiguous 候选重新问用户一遍——原子写把这个窗口从"写文件
 * 那几毫秒"关掉,残留的只可能是一个从未被 rename 过、因此从未被 readLedger 看见
 * 的孤儿临时文件。
 *
 * 临时文件名带 pid + 随机数,不用固定的 `<file>.tmp`:两次并发的 writeLedgerEntry
 * (比如两个都在探测工具链的子进程)如果共用同一个临时名,后写的会截断先写的还没
 * 来得及 rename 的内容。各自专属的临时名下,两次写各自完整落地,只是最后一次
 * rename 谁后到听谁的——会丢一条并发写入的更新,但不会产生半个 JSON。这个仓一贯
 * 的取舍:不为一个"读错最坏后果是重新问一遍用户"的文件建锁机制。
 */
function writeJsonAtomic(file: string, value: unknown): void {
	const dir = path.dirname(file);
	mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${randomUUID()}.tmp`);
	let renamed = false;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
		renameSync(tmp, file);
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// 清理失败不掩盖原始错误——残留一个临时文件比吞掉真正的失败原因好排查。
			}
		}
	}
}

/** 写入 / 覆盖账本里的一条(读改写整份文件,按 entry.id 覆盖)。原子写见 writeJsonAtomic。 */
export async function writeLedgerEntry(entry: LedgerEntry, configDir?: string): Promise<void> {
	const file = ledgerPath(configDir);
	const current = await readLedger(configDir);
	const next: Ledger = { schema: SCHEMA_TAG, entries: { ...current.entries, [entry.id]: entry } };
	writeJsonAtomic(file, next);
}

/**
 * 读 `<projectDir>/.my-pi/toolchain.local.json` —— 项目级覆盖,形状是
 * `Record<工具 id, LedgerEntry>`,不带 Ledger 那层 `{schema, entries}` 包装:这份
 * 文件不提交、只活在写它的这一台机器上,不需要"整份文件是不是这个版本"的判别,
 * 单纯就是"给这个项目手动钉死的几条路径"。同样容错:文件不存在 / JSON 损坏 /
 * 顶层不是对象都当没有覆盖;单条形状不对就单条跳过,不连累同文件里其它写对的覆盖
 * ——与 readLedger 同一套"逐条过滤"的理由。
 */
export async function readLocalOverrides(projectDir: string): Promise<Record<string, LedgerEntry>> {
	let text: string;
	try {
		text = readFileSync(path.join(projectDir, LOCAL_RELATIVE), "utf8");
	} catch {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (!isPlainObject(parsed)) return {};

	const out: Record<string, LedgerEntry> = {};
	for (const [id, value] of Object.entries(parsed)) {
		if (isLedgerEntry(value)) out[id] = value;
	}
	return out;
}
