/**
 * 「问安装器」这一档:厂商安装器自己留下的登记文件。排在环境变量之后、PATH 与已知位置之前 ——
 * 登记文件说的是**这台机器上的事实**(路径是安装器写下的,装在哪个盘都对),而已知位置表只是
 * "大概率",每多见一台装在 D 盘的机器就得补一条盘符(J-Link 补过、Keil 补过,IDF 是第三次)。
 *
 * 2026-09-18 的会话是这一档存在的理由:ESP-IDF 装在 `D:\Espressif`,位置表只写了 `C:\Espressif`,
 * 模型于是断言"这台机器上没有 ESP32 工具链"。而 `IDF_TOOLS_PATH=D:\Espressif` 就摆在用户环境变量里,
 * 它指向的 `esp_idf.json` 写着 IDF 的路径**和配套的 Python 环境** —— 后者正是同一次会话里另一个坑
 * (export.ps1 按 PATH 上的 Python 3.12 去找 `idf5.4_py3.12_env`,而实际装的是 3.11 那个)的答案。
 *
 * 与 locations.ts 同一条纪律:**任何一步 IO 失败都吞掉,绝不抛** —— 登记文件缺席、JSON 坏了、
 * 形状不认识,后果都只是"这一档没找到"。
 *
 * **只从注入的 env 取根目录,不读 `os.homedir()`、不写死盘符**:测试传的 env 里没有 HOME /
 * SystemDrive / IDF_TOOLS_PATH 时这一档是空的,结果不看开发机的脸色(这台开发机上
 * `C:\Espressif\tools\eim_idf.json` 真的存在)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface InstallerRecord {
	/** 安装器登记的安装根。存在与否、是不是真的根,由调用方(resolve.ts 的 directoryRoot)验。 */
	dir: string;
	/** 安装器顺带说的事实(配套 Python、激活脚本、版本),原样递给模型 —— 这些正是手工满盘找的东西。 */
	facts: Record<string, string>;
	/** 安装器标记的"当前选中"那一份,排在前面。 */
	selected: boolean;
}

type Reader = (platform: string, env: NodeJS.ProcessEnv) => InstallerRecord[];

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const lower = name.toLowerCase();
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
	const value = key === undefined ? undefined : env[key];
	return value?.trim() ? value.trim() : undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ─── Espressif ───────────────────────────────────────────────────────────────
//
// 两代安装器,两种登记文件,同一台机器上可以并存(实测:旧安装器的 v5.4.3 + EIM 的 v6.0.2):
// - 旧的 Windows 离线/在线安装器:`<IDF_TOOLS_PATH>\esp_idf.json`,`idfInstalled` 是 **对象**
//   (id → {version, python, path}),安装器同时把 IDF_TOOLS_PATH 写进用户环境变量。
// - EIM(ESP-IDF Installation Manager):`<工具根>\tools\eim_idf.json`,`idfInstalled` 是 **数组**
//   ({id, name, path, python, activationScript, idfToolsPath})。工具根缺省 Windows 是
//   `<系统盘>\Espressif`,其余平台是 `~/.espressif`。

function espressifRoots(platform: string, env: NodeJS.ProcessEnv): string[] {
	const roots: string[] = [];
	const toolsPath = envValue(env, "IDF_TOOLS_PATH");
	if (toolsPath) roots.push(toolsPath);
	if (platform === "win32") {
		const drive = envValue(env, "SystemDrive");
		if (drive) roots.push(`${drive}\\Espressif`);
	} else {
		const home = envValue(env, "HOME");
		if (home) roots.push(path.posix.join(home, ".espressif"));
	}
	return roots;
}

function espressifRecord(entry: unknown, selectedId: string | undefined, id: string | undefined, toolsRoot: string): InstallerRecord | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const item = entry as Record<string, unknown>;
	const dir = text(item.path);
	if (!dir) return undefined;
	const facts: Record<string, string> = {};
	const version = text(item.name) ?? text(item.version);
	if (version) facts.version = version;
	const python = text(item.python);
	if (python) facts.python = path.normalize(python);
	const activation = text(item.activationScript);
	if (activation) facts["activation script"] = path.normalize(activation);
	facts.IDF_TOOLS_PATH = path.normalize(text(item.idfToolsPath) ?? toolsRoot);
	const entryId = text(item.id) ?? id;
	// 旧安装器写的路径带尾斜杠("D:/Espressif/frameworks/esp-idf-v5.4.3/"),剥掉,否则同一个根有两种写法。
	const normalized = path.normalize(dir).replace(/(?<=[^\\/:])[\\/]+$/, "");
	return { dir: normalized, facts, selected: selectedId !== undefined && entryId === selectedId };
}

const espressif: Reader = (platform, env) => {
	const out: InstallerRecord[] = [];
	for (const root of espressifRoots(platform, env)) {
		for (const file of [path.join(root, "esp_idf.json"), path.join(root, "tools", "eim_idf.json"), path.join(root, "eim_idf.json")]) {
			const json = readJson(file);
			const installed = json?.idfInstalled;
			if (!json || typeof installed !== "object" || installed === null) continue;
			const selectedId = text(json.idfSelectedId);
			const entries: Array<[string | undefined, unknown]> = Array.isArray(installed)
				? installed.map((entry) => [undefined, entry])
				: Object.entries(installed);
			for (const [id, entry] of entries) {
				const record = espressifRecord(entry, selectedId, id, root);
				if (record) out.push(record);
			}
		}
	}
	return out;
};

/**
 * esptool 随 IDF 的 Python 环境装在 venv 的 Scripts(bin)里,不在 PATH 上 —— 登记文件里那个 python 的旁边就是它。
 * 不接这一条的话,装了 IDF 的机器上 esptool 照样报 MISSING 并建议 `pip install esptool`,模型就真去装一份
 * (2026-09-18 会话的开头正是这样)。这里的 dir 是**可执行文件所在目录**,由 resolve.ts 在里面解析声明的入口名。
 */
const espressifPythonScripts: Reader = (platform, env) =>
	espressif(platform, env).flatMap((record) =>
		record.facts.python ? [{ dir: path.dirname(record.facts.python), facts: {}, selected: record.selected }] : [],
	);

const READERS: Record<string, Reader> = { idf: espressif, esptool: espressifPythonScripts };

function sameDir(a: string, b: string, platform: string): boolean {
	const norm = (value: string) => {
		const trimmed = path.normalize(value).replace(/[\\/]+$/, "");
		return platform === "win32" ? trimmed.toLowerCase() : trimmed;
	};
	return norm(a) === norm(b);
}

/** 这个工具的安装器登记,选中的在前、同一目录只留第一条。没有对应安装器的工具返回 []。 */
export function installerRecords(toolId: string, platform: string, env: NodeJS.ProcessEnv): InstallerRecord[] {
	const reader = READERS[toolId];
	if (!reader) return [];
	let records: InstallerRecord[];
	try {
		records = reader(platform, env);
	} catch {
		return [];
	}
	const unique: InstallerRecord[] = [];
	for (const record of [...records.filter((r) => r.selected), ...records.filter((r) => !r.selected)]) {
		if (!unique.some((seen) => sameDir(seen.dir, record.dir, platform))) unique.push(record);
	}
	return unique;
}

/**
 * 某个已解析的安装根在登记文件里的那条事实 —— **与它是从哪一档找到的无关**:账本记住根目录之后
 * 来源就是 ledger 了,配套 Python 这句话照样要说。
 */
export function installerFacts(toolId: string, root: string, platform: string, env: NodeJS.ProcessEnv): string[] {
	const record = installerRecords(toolId, platform, env).find((entry) => sameDir(entry.dir, root, platform));
	return record ? Object.entries(record.facts).map(([name, value]) => `${name}: ${value}`) : [];
}
