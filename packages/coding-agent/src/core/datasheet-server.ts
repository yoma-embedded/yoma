/**
 * 数据手册服务器地址的**唯一**解析实现 —— 桌面内核、桌面主进程的手册库页、bench/信箱
 * 的 turn 子进程、ACP 适配器全部走这一份。从前这段逻辑有两份手抄(desktop 的
 * datasheet-server.ts 与 manuals.ts 各一个 `.env` 解析器),而内核工具只读 process.env,
 * 于是"桌面端配了、bench 看不见"是常态。
 *
 * ## 优先级
 *
 *   显式参数 > 环境变量 YOMA_DATASHEET_SERVER > `<configDir>/.env`(或 $YOMA_ENV_FILE)> 内置默认
 *
 * 值为 off / none / false / 0(不分大小写)表示**显式关闭**:不查手册,也不回落到默认。
 * 尾部斜杠一律剥掉。
 *
 * ## 为什么有内置默认
 *
 * 2026-08-17(ad6df94)为开源准备摘掉了内置地址;2026-09-05 维护者决定用户装完即可查
 * 手册,不手填地址,于是默认地址回来了。这是一个产品决定:公开仓里放地址意味着任何
 * 人都能打它,防线在服务器侧(限流 / 反代),不在客户端。自建服务器的用户用上面任何
 * 一层覆盖它;不想联网的用户设 off。
 *
 * **叶子模块**:只依赖 node 内建。desktop 的 main 进程要 import 它(手册库页要知道地址),
 * 而 main 不能把整个内核 inline 进 index.js —— 与 bench 的 mailbox/paths.ts 同一条纪律。
 * 经 `@yoma/coding-agent/datasheet-server` 深引用导出(四份别名表 + package.json exports)。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DATASHEET_SERVER_ENV = "YOMA_DATASHEET_SERVER";
export const DATASHEET_ENV_FILE_ENV = "YOMA_ENV_FILE";

/**
 * 内置默认地址。维护者的服务器 —— 2026-09-05 从开发机探测不可达(连接超时),
 * 维护者需要确认或替换;改这里一处即可,所有宿主一起变。
 */
export const DEFAULT_DATASHEET_SERVER = "http://47.122.120.208";

export type DatasheetServerSource = "explicit" | "env" | "file" | "builtin" | "off" | "none";

export interface DatasheetServerResolution {
	/** 归一化后的基址(无尾斜杠);关闭或没有任何来源时 undefined。 */
	url: string | undefined;
	source: DatasheetServerSource;
	/** source === "file" / "off"(来自文件)时是那个文件的路径。 */
	file?: string;
}

export interface ResolveDatasheetServerOptions {
	/** 显式地址(工具 options / CLI --server)。 */
	explicit?: string;
	/** 默认 process.env。测试注入。 */
	env?: NodeJS.ProcessEnv;
	/** `.env` 所在目录,默认 ~/.yoma。测试必须注入。 */
	configDir?: string;
	/** 内置默认;`null` 表示"没有内置默认"(测试复现"未配置"路径),undefined 用 DEFAULT_DATASHEET_SERVER。 */
	builtIn?: string | null;
}

const DISABLED_VALUES = new Set(["off", "none", "false", "0"]);

/** off / none / false / 0(不分大小写、两端空白无关)= 显式关闭。 */
export function isDisabledValue(raw: string): boolean {
	return DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** 与 kernel `host/auth.ts` 的 `yomaConfigDir()` / toolchain ledger 的 defaultConfigDir 同一个目录(叶子模块,就地重算)。 */
export function defaultConfigDir(): string {
	return path.join(homedir(), ".yoma");
}

function normalizeUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

/**
 * 解析 KEY=value 文件:`#` 行注释、成对引号剥掉、空值当没有。文件不存在 / 读不了返回空
 * 对象 —— 这是纯配置读取,失败的最坏后果是"当没配",不该抛。
 */
export function readEnvFile(file: string): Record<string, string> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	const out: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (key && val && !(key in out)) out[key] = val;
	}
	return out;
}

/** `$YOMA_ENV_FILE` 指定的文件,否则 `<configDir>/.env`。 */
export function datasheetEnvFile(opts: { env?: NodeJS.ProcessEnv; configDir?: string } = {}): string {
	const env = opts.env ?? process.env;
	const explicit = env[DATASHEET_ENV_FILE_ENV]?.trim();
	if (explicit) return explicit;
	return path.join(opts.configDir ?? defaultConfigDir(), ".env");
}

export function resolveDatasheetServer(opts: ResolveDatasheetServerOptions = {}): DatasheetServerResolution {
	const env = opts.env ?? process.env;

	const explicit = opts.explicit?.trim();
	if (explicit) {
		if (isDisabledValue(explicit)) return { url: undefined, source: "off" };
		return { url: normalizeUrl(explicit), source: "explicit" };
	}

	const fromEnv = env[DATASHEET_SERVER_ENV]?.trim();
	if (fromEnv) {
		if (isDisabledValue(fromEnv)) return { url: undefined, source: "off" };
		return { url: normalizeUrl(fromEnv), source: "env" };
	}

	const file = datasheetEnvFile({ env, configDir: opts.configDir });
	const fromFile = readEnvFile(file)[DATASHEET_SERVER_ENV]?.trim();
	if (fromFile) {
		if (isDisabledValue(fromFile)) return { url: undefined, source: "off", file };
		return { url: normalizeUrl(fromFile), source: "file", file };
	}

	const builtIn = opts.builtIn === undefined ? DEFAULT_DATASHEET_SERVER : opts.builtIn;
	if (builtIn && builtIn.trim()) return { url: normalizeUrl(builtIn), source: "builtin" };
	return { url: undefined, source: "none" };
}
