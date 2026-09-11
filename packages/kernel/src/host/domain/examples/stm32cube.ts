/**
 * STM32Cube 固件包抽取器。facet 来源(F1/F4/H7 三包实地抽查):**官方例程 0 个 .ioc**,
 * 配置在代码里,元数据在 doxygen 风格的 readme.txt(@page 标题、@par Example
 * Description 段落)与路径(Projects/<板>/<类目>/<外设组>/<例程>)。.ioc 解析属于
 * 用户工程侧的账本(下一期),不属于语料侧。
 *
 * Demonstrations 不收:板专属大杂烩,检索噪音远大于种子价值(设计文档记了这条)。
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

// v2(2026-08-14):例程判定改为"工程证据"(readme / Src / CM4|CM7 三取一)并支持
// 类目级直挂 —— v1 按固定层级数目录,F1 的 BSP 直挂在类目下,它的 EWARM/MDK-ARM/
// Src/Inc 全被当成了例程(真语料实测:富化对着 EWARM 报"读不到任何可分析文件")。
export const STM32CUBE_EXTRACTOR_VERSION = 2;

const CATEGORIES = ["Examples", "Examples_LL", "Examples_MIX", "Applications"] as const;

/** `@page GPIO_IOToggle GPIO IO Toggle example` → 标题部分。 */
export function parseCubeTitle(readme: string): string | undefined {
	const match = /@page\s+\S+\s+(.+)/.exec(readme);
	return match ? match[1].trim() : undefined;
}

/** `@par Example Description` 之后、下一个 @ 段之前的正文。 */
export function parseCubeDescription(readme: string): string | undefined {
	const lines = readme.split(/\r?\n/);
	const start = lines.findIndex((line) => /@par\s+(Example\s+)?Description/i.test(line));
	if (start === -1) return undefined;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*@(par|note|verbatim|endverbatim|page)\b/.test(line)) break;
		body.push(line.trim());
	}
	const text = body.join(" ").trim();
	return text === "" ? undefined : truncateText(text, 400);
}

/**
 * 外设证据,两路:直接 include(stm32f4xx_hal_i2c.h → i2c)+ **函数调用前缀**
 * (HAL_I2C_Master_Transmit → i2c,LL_USART_Init → usart)。调用是更强的证据 ——
 * Cube 例程的 main.c 常常只 include main.h,真正用了什么全在调用里。
 * conf/def/msp 这类脚手架名不算外设。
 */
// 每个例程的标配、零区分度的词:conf/def 是开关与定义头,msp/cortex 是启动脚手架,
// bus/system/utils/systick 与 AHBx/APBx 是 LL 的时钟组 —— 都不是"这个例程用了什么
// 外设"的证据,include 一侧与调用一侧同一份名单(真语料实测:不滤的话 LL 例程
// 个个挂十几个假外设)。
const CUBE_SCAFFOLDING = new Set([
	"conf",
	"def",
	"msp",
	"mspinit",
	"mspdeinit",
	"cortex",
	"bus",
	"system",
	"utils",
	"systick",
]);

function isScaffoldingName(name: string): boolean {
	return CUBE_SCAFFOLDING.has(name) || /^a[hp]b\d+$/.test(name);
}

export function peripheralsFromCubeSource(source: string): string[] {
	const found = new Set<string>();
	const includePattern = /#include\s+["<]stm32\w+?xx_(?:hal|ll)_(\w+)\.h[">]/g;
	for (const match of source.matchAll(includePattern)) {
		const name = match[1].toLowerCase();
		if (!isScaffoldingName(name)) found.add(name);
	}
	const callPattern = /\b(?:HAL|LL)_([A-Za-z][A-Za-z0-9]*)_/g;
	for (const match of source.matchAll(callPattern)) {
		const name = match[1].toLowerCase();
		if (!isScaffoldingName(name)) found.add(name);
	}
	return [...found].sort();
}

/**
 * `stm32f4xx_hal_conf.h`(与其 template)按定义枚举**整个 HAL** 的模块头 —— 它是
 * 开关清单不是使用证据,扫它等于给每个例程挂上全家桶外设(真语料实测 37 个/例程,
 * 精度全毁)。同理跳过 conf 的 include 目标本身由上面的 conf 例外兜住。
 */
export function isCubeConfFile(name: string): boolean {
	return /_(?:hal|ll)_conf(?:_template)?\.h$/i.test(name);
}

/** 从 `Drivers/STM32F4xx_HAL_Driver` 这类目录名推芯片家族(stm32f4)。 */
export function detectCubeFamily(root: string): string | undefined {
	const { dirs } = listDirNames(path.join(root, "Drivers"));
	for (const name of dirs) {
		const match = /^STM32(\w+?)xx_HAL_Driver$/i.exec(name);
		if (match) return `stm32${match[1].toLowerCase()}`;
	}
	return undefined;
}

/**
 * 底盘资格:HAL 驱动与 CMSIS 是否实体非空。F1 是子模块结构,没拉子模块时目录在
 * 但是空的 —— "能读"冒充"能编"会把种子选进死路,这里如实降级并讲清怎么补。
 */
export function cubeBuildState(root: string): { buildable: boolean; buildNote?: string } {
	const familyDir = listDirNames(path.join(root, "Drivers")).dirs.find((name) => /_HAL_Driver$/i.test(name));
	const halPopulated = familyDir
		? listDirNames(path.join(root, "Drivers", familyDir)).dirs.length > 0 ||
			listDirNames(path.join(root, "Drivers", familyDir)).files.length > 0
		: false;
	const cmsis = listDirNames(path.join(root, "Drivers", "CMSIS"));
	const cmsisPopulated = cmsis.dirs.length > 0 || cmsis.files.length > 0;
	if (halPopulated && cmsisPopulated) {
		return { buildable: true, buildNote: "在固件包内构建(例程工程按相对路径引用 Drivers/)" };
	}
	return {
		buildable: false,
		buildNote: "语料根 Drivers/ 缺 HAL 或 CMSIS(子模块未拉):git submodule update --init 后重建索引",
	};
}

function extractOne(
	root: string,
	relPath: string,
	board: string,
	group: string,
	family: string | undefined,
	build: { buildable: boolean; buildNote?: string },
): RawExample {
	const abs = path.join(root, relPath);
	const readme =
		readTextIfExists(path.join(abs, "readme.txt")) ?? readTextIfExists(path.join(abs, "README.md")) ?? "";
	const title = parseCubeTitle(readme);
	const summary = parseCubeDescription(readme);

	const peripherals = new Set<string>([group.toLowerCase()]);
	// H7 双核例程的源码在 CM7/CM4 下一层(Examples/GPIO/GPIO_EXTI/CM7/Src),不带
	// 前缀匹配的话这类条目 loc=0、外设只剩组名 —— 与工程判据同一批修(v2)。
	const sourceFiles = walkFilesRelative(abs, 400).filter(
		(file) => /^(CM[47]\/)?(Src|Inc)\//.test(file) && /\.(c|h)$/i.test(file),
	);
	for (const file of sourceFiles) {
		if (isCubeConfFile(file)) continue;
		const source = readTextIfExists(path.join(abs, file));
		if (!source) continue;
		for (const peripheral of peripheralsFromCubeSource(source)) peripherals.add(peripheral);
	}

	const allFiles = walkFilesRelative(abs, 2000);
	return {
		path: toPosix(relPath),
		name: path.posix.basename(toPosix(relPath)),
		title,
		summary,
		targets: family ? [family] : [],
		board,
		peripherals: [...peripherals].sort(),
		buildable: build.buildable,
		buildNote: build.buildNote,
		license: "BSD-3-Clause",
		loc: countLoc(sourceFiles.map((file) => path.join(abs, file))),
		files: allFiles.length,
		extractorVersion: STM32CUBE_EXTRACTOR_VERSION,
	};
}

/**
 * 一个目录"是 Cube 例程工程"的判据:有 Src/(单核标准布局)或 CM4/CM7(H7 双核布局)。
 * **readme 单独不算数**:组目录常带一个清单式 readme(`Examples/SPI/readme.txt` 是
 * 子例程索引页),按 readme 认工程会把整组真例程吞成一条 0 行的假条目,还骗到小种子
 * 加分(真语料实测)。EWARM/MDK-ARM 这类 IDE 目录、直挂工程裸露的 Src/Inc 碎块,
 * 两个结构证据都没有。
 */
function isCubeProjectDir(dir: string): boolean {
	const { dirs } = listDirNames(dir);
	return dirs.includes("Src") || dirs.includes("CM7") || dirs.includes("CM4");
}

/**
 * 遍历 `Projects/<板>/{Examples,Examples_LL,Examples_MIX,Applications}/<外设组>/<例程>/`。
 * 组目录自己就是工程时(F1/H7 的 BSP 直挂在类目下)收组本身、不往里枚举;
 * 例程层只收过得了工程判据的目录 —— v1 按层级数数,把 IDE 目录也当例程收了。
 */
export function extractStm32CubeExamples(root: string): RawExample[] {
	const family = detectCubeFamily(root);
	const build = cubeBuildState(root);
	const out: RawExample[] = [];
	const projectsDir = path.join(root, "Projects");
	for (const board of listDirNames(projectsDir).dirs) {
		for (const category of CATEGORIES) {
			const categoryDir = path.join(projectsDir, board, category);
			for (const group of listDirNames(categoryDir).dirs) {
				const groupRel = `Projects/${board}/${category}/${group}`;
				if (isCubeProjectDir(path.join(root, groupRel))) {
					out.push(extractOne(root, groupRel, board, group, family, build));
					continue;
				}
				for (const example of listDirNames(path.join(categoryDir, group)).dirs) {
					const rel = `${groupRel}/${example}`;
					if (!isCubeProjectDir(path.join(root, rel))) continue;
					out.push(extractOne(root, rel, board, group, family, build));
				}
			}
		}
	}
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}
