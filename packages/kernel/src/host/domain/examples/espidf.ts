/**
 * esp-idf 语料抽取器。facet 来源(2026-08-12 实地抽查,见 docs/施工指南-例程库.md):
 * README 首部的 `| Supported Targets | ... |` 表、main/idf_component.yml 的依赖、
 * sdkconfig.defaults 的 Kconfig 增量、pytest_*.py 验收脚本、源码 include。
 *
 * 抽取器只认这一版约定并声明版本号 —— 元数据约定随 SDK 版本漂移是实测事实
 * (Zephyr 把 sample.yaml 改名 tests.yaml),约定变了加分支、升版本,不悄悄兼容。
 */

import path from "node:path";

import {
	countLoc,
	listDirNames,
	type RawExample,
	readTextIfExists,
	toPosix,
	truncateText,
	walkFilesRelative,
} from "./extract-util.ts";

export const ESPIDF_EXTRACTOR_VERSION = 1;

/**
 * README 表格里的芯片名 → 索引口径:小写、去连字符(ESP32-C3 → esp32c3)。
 * 只取第一个空白分隔的 token:表格单元常带脚注标(“ESP32-S3 ¹”),连起来会铸出
 * esp32s31 这种不存在的芯片(真语料实测)。
 */
export function normalizeEspTarget(cell: string): string {
	const token = cell.trim().split(/\s+/)[0] ?? "";
	return token.toLowerCase().replaceAll("-", "");
}

/** `| Supported Targets | ESP32 | ESP32-C3 |` → ["esp32","esp32c3"];找不到表 → []。 */
export function parseSupportedTargets(readme: string): string[] {
	for (const line of readme.split(/\r?\n/).slice(0, 8)) {
		const cells = line.split("|").map((cell) => cell.trim());
		const label = cells.findIndex((cell) => /^supported targets$/i.test(cell));
		if (label === -1) continue;
		return cells
			.slice(label + 1)
			.filter((cell) => cell !== "")
			.map(normalizeEspTarget)
			.filter((cell) => cell.startsWith("esp"));
	}
	return [];
}

/** 首个 `# ` 标题与其后第一段正文(跳过"(See the README..."样板句)。 */
export function parseReadmeSummary(readme: string): { title?: string; summary?: string } {
	const lines = readme.split(/\r?\n/);
	let title: string | undefined;
	let start = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = /^#\s+(.+)$/.exec(lines[i]);
		if (match) {
			title = match[1].trim();
			start = i + 1;
			break;
		}
	}
	const paragraphs: string[][] = [];
	let current: string[] = [];
	for (const line of lines.slice(start)) {
		if (line.trim() === "") {
			if (current.length > 0) paragraphs.push(current);
			current = [];
			continue;
		}
		if (line.startsWith("#")) break;
		current.push(line.trim());
	}
	if (current.length > 0) paragraphs.push(current);
	const body = paragraphs.find((paragraph) => !/^\(see the readme/i.test(paragraph[0]));
	return { title, summary: body ? truncateText(body.join(" "), 400) : undefined };
}

/**
 * include → 外设/能力词。driver/xxx.h 直接取 xxx(去 _master/_slave 等实例后缀),
 * 其余按小表映射 —— 表刻意小:漏映射的代价是少一个检索词(keyword 仍能兜住),
 * 错映射的代价是硬过滤级别的误导。
 */
const INCLUDE_CAPABILITIES: Record<string, string> = {
	esp_wifi: "wifi",
	esp_now: "espnow",
	esp_eth: "ethernet",
	esp_bt: "ble",
	esp_gap_ble_api: "ble",
	esp_gatts_api: "ble",
	esp_gattc_api: "ble",
	esp_nimble_hci: "ble",
	nimble: "ble",
	mqtt_client: "mqtt",
	esp_http_client: "http",
	esp_http_server: "http",
	esp_https_ota: "ota",
	esp_ota_ops: "ota",
	nvs_flash: "nvs",
	nvs: "nvs",
	esp_websocket_client: "websocket",
	led_strip: "led",
	esp_camera: "camera",
	esp_lcd_panel_ops: "lcd",
	esp_spiffs: "spiffs",
	esp_vfs_fat: "fatfs",
	sdmmc_cmd: "sdmmc",
};

export function capabilitiesFromSource(source: string): string[] {
	const found = new Set<string>();
	const includePattern = /#include\s+["<]([^">]+)[">]/g;
	for (const match of source.matchAll(includePattern)) {
		const header = match[1];
		const driver = /^driver\/(\w+)\.h$/.exec(header);
		if (driver) {
			found.add(driver[1].replace(/_(master|slave|oneshot|continuous|cali|etm|types?)$/, ""));
			continue;
		}
		const stem = path.posix.basename(header).replace(/\.h$/, "");
		const mapped = INCLUDE_CAPABILITIES[stem];
		if (mapped) found.add(mapped);
		if (header.startsWith("esp_adc") || stem.startsWith("adc_")) found.add("adc");
	}
	return [...found].sort();
}

/**
 * idf_component.yml 的 dependencies 键(跳过 idf 自身)。不引 YAML 库,与 toolchain
 * 的 jsonc-lite 同一取舍。键只认 dependencies 下**第一层**缩进 —— `idf:` 块里嵌套的
 * `version:` 缩得更深,按首个键的缩进宽度过滤,别把值当成依赖。
 */
export function parseComponentDeps(yamlText: string): string[] {
	const deps: string[] = [];
	let inDependencies = false;
	let keyIndent: number | undefined;
	for (const line of yamlText.split(/\r?\n/)) {
		if (/^dependencies\s*:/.test(line)) {
			inDependencies = true;
			keyIndent = undefined;
			continue;
		}
		if (inDependencies) {
			if (/^\S/.test(line) && line.trim() !== "") break;
			const match = /^(\s+)([\w./-]+)\s*:/.exec(line);
			if (!match) continue;
			keyIndent ??= match[1].length;
			if (match[1].length !== keyIndent) continue;
			if (match[2] !== "idf") deps.push(match[2]);
		}
	}
	return deps.sort();
}

export function parseConfigKeys(sdkconfigText: string): string[] {
	const keys: string[] = [];
	for (const line of sdkconfigText.split(/\r?\n/)) {
		const match = /^(CONFIG_\w+)=/.exec(line);
		if (match) keys.push(match[1]);
	}
	return keys.sort();
}

function isExampleDir(dir: string): boolean {
	const { dirs, files } = listDirNames(dir);
	return dirs.includes("main") && files.includes("CMakeLists.txt");
}

/** main/ 下首个源文件头部的 SPDX 标签 —— esp-idf 逐文件标 License,取第一份当代表。 */
function detectLicense(mainDir: string): string | undefined {
	const { files } = listDirNames(mainDir);
	const source = files.find((name) => /\.(c|cc|cpp)$/.test(name));
	if (!source) return undefined;
	const head = readTextIfExists(path.join(mainDir, source))?.slice(0, 600);
	const match = head && /SPDX-License-Identifier:\s*([^\s*/]+)/.exec(head);
	return match ? match[1] : undefined;
}

function extractOne(root: string, relPath: string): RawExample {
	const abs = path.join(root, relPath);
	const name = path.posix.basename(toPosix(relPath));
	const readme = readTextIfExists(path.join(abs, "README.md"));
	const { title, summary } = readme ? parseReadmeSummary(readme) : {};
	const targets = readme ? parseSupportedTargets(readme) : [];

	const peripherals = new Set<string>();
	const segments = toPosix(relPath).split("/");
	if (segments[0] === "peripherals" && segments.length > 1) peripherals.add(segments[1].toLowerCase());

	const mainDir = path.join(abs, "main");
	const mainFiles = walkFilesRelative(mainDir, 200);
	for (const file of mainFiles) {
		if (!/\.(c|cc|cpp|h|hpp)$/i.test(file)) continue;
		const source = readTextIfExists(path.join(mainDir, file));
		if (!source) continue;
		for (const capability of capabilitiesFromSource(source)) peripherals.add(capability);
	}

	const componentYml = readTextIfExists(path.join(mainDir, "idf_component.yml"));
	const deps = componentYml ? parseComponentDeps(componentYml) : [];
	const sdkconfig = readTextIfExists(path.join(abs, "sdkconfig.defaults"));
	const configKeys = sdkconfig ? parseConfigKeys(sdkconfig) : [];

	const { files: topFiles } = listDirNames(abs);
	const pytest = topFiles.find((file) => /^pytest_.*\.py$/.test(file));

	const allFiles = walkFilesRelative(abs, 2000);
	const loc = countLoc(
		mainFiles.filter((file) => /\.(c|cc|cpp|h|hpp)$/i.test(file)).map((file) => path.join(mainDir, file)),
	);

	return {
		path: toPosix(relPath),
		name,
		title,
		summary,
		targets,
		peripherals: [...peripherals].sort(),
		deps: deps.length > 0 ? deps : undefined,
		configKeys: configKeys.length > 0 ? configKeys : undefined,
		acceptance: pytest ? { kind: "pytest", path: pytest } : undefined,
		// esp-idf 例程独立于仓库位置可编,前提是装了 IDF;有组件依赖时首次构建要联网。
		buildable: true,
		buildNote:
			deps.length > 0
				? "需已安装 ESP-IDF;首次构建需联网拉取 managed components(见 main/idf_component.yml)"
				: "需已安装 ESP-IDF(IDF_PATH)",
		license: detectLicense(mainDir),
		loc,
		files: allFiles.length,
		extractorVersion: ESPIDF_EXTRACTOR_VERSION,
	};
}

/**
 * 从 `<root>/examples/` 递归收例程。认定标准:目录自带 main/ 与 CMakeLists.txt;
 * 认定即收,不再往它内部递归(嵌套工程按外层算)。common_components 是共享代码
 * 不是例程,整树跳过。
 */
export function extractEspIdfExamples(root: string): RawExample[] {
	const out: RawExample[] = [];
	const stack = ["examples"];
	while (stack.length > 0) {
		const rel = stack.pop() as string;
		const abs = path.join(root, rel);
		if (isExampleDir(abs)) {
			out.push(extractOne(root, rel));
			continue;
		}
		const { dirs } = listDirNames(abs);
		for (let i = dirs.length - 1; i >= 0; i--) {
			const name = dirs[i];
			if (name === "common_components" || name === ".git" || name === "build") continue;
			stack.push(`${rel}/${name}`);
		}
	}
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}
