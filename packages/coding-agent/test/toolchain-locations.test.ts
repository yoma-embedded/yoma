// 本机工具链探测(locations.ts)验收:findOnPath 的 PATHEXT 展开、expandGlobPath
// 的通配展开、WELL_KNOWN_LOCATIONS 的数据完整性、以及 registryCandidates 的
// 平台门禁 + 注册表输出解析。
//
// 这台跑测试的机器本身就是 win32(见根 CLAUDE.md 的环境信息),这带来一个好处
// 也需要一条纪律:好处是 registryCandidates 的真实注册表查询路径能被真正跑到
// 一次,不只是理论上;纪律是"PATHEXT 展开"这类本该验证 Windows 语义的测试,
// 不能靠"这台机器恰好是 Windows"这个事实自然通过 —— 必须靠注入 env 让它在
// POSIX CI 上同样能把 Windows 分支的逻辑真正跑起来(根 CLAUDE.md 点名的"永远
// 不会响的闸门"反模式,findOnPath 本身也没有 platform 参数,只能靠 env 里有没有
// PATHEXT 这个键来切换,见 locations.ts 的注释)。全程用 mkdtemp 建的临时目录,
// 不碰真实 PATH 上的任何东西。
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
	expandGlobPath,
	findEnvKey,
	findOnPath,
	parseInstallLocations,
	registryCandidates,
	tableLookup,
	WELL_KNOWN_LOCATIONS,
	wellKnownCandidates,
	type LocationTable,
} from "../src/core/toolchain/locations.ts";
import type { PlatformKey } from "../src/core/toolchain/schema.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "yoma-toolchain-locations-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ─── findOnPath ────────────────────────────────────────────────────────────

describe("findEnvKey", () => {
	it("返回的是 env 里那个**真实的键**,而不是要找的那个拼写", () => {
		expect(findEnvKey({ Path: "x" }, "PATH")).toBe("Path");
		expect(findEnvKey({ PATH: "x" }, "PATH")).toBe("PATH");
		expect(findEnvKey({}, "PATH")).toBeUndefined();
	});

	// 这一条盯的是 Windows 上真 process.env 那个大小写不敏感代理:普通对象盖不到它,
	// 而 shellEnvFor 拿到的恰恰是它。实现里"先扫 Object.keys、精确名只兜底"的顺序
	// 就是为这条写的 —— 反过来写会返回 "PATH",而 {...base} 展开出来的键是 "Path",
	// 于是输出里同时躺着两个 PATH,子进程认哪个是未定义行为。
	it("大小写不敏感的代理上,仍然返回 Object.keys 给出的真实键", () => {
		const proxy = new Proxy(
			{ Path: "x" } as Record<string, string>,
			{
				get: (target, prop) =>
					typeof prop === "string"
						? target[Object.keys(target).find((k) => k.toLowerCase() === prop.toLowerCase()) ?? prop]
						: undefined,
				has: (target, prop) =>
					typeof prop === "string" && Object.keys(target).some((k) => k.toLowerCase() === prop.toLowerCase()),
			},
		);
		expect(proxy.PATH).toBe("x"); // 代理确实是大小写不敏感的
		expect(findEnvKey(proxy, "PATH")).toBe("Path");
	});
});

describe("findOnPath", () => {
	it("env 里没有 PATHEXT 时是 POSIX 语义:直接拼裸文件名", () => {
		writeFileSync(join(dir, "mytool"), "");
		const env: NodeJS.ProcessEnv = { PATH: dir };
		expect(findOnPath("mytool", env)).toBe(join(dir, "mytool"));
	});

	it("按 PATHEXT 展开候选后缀(注入 env,POSIX CI 上也能跑这条)", () => {
		writeFileSync(join(dir, "foo.cmd"), "");
		const env: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: ".cmd" };
		expect(findOnPath("foo", env)).toBe(join(dir, "foo.cmd"));
	});

	it("PATHEXT 存在但是空字符串时落回默认列表 .EXE;.CMD;.BAT;.COM", () => {
		writeFileSync(join(dir, "bar.CMD"), "");
		const env: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: "" };
		expect(findOnPath("bar", env)).toBe(join(dir, "bar.CMD"));
	});

	it("PATHEXT 列出多个后缀时按声明顺序试,命中第一个存在的", () => {
		writeFileSync(join(dir, "baz.BAT"), "");
		const env: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT" };
		expect(findOnPath("baz", env)).toBe(join(dir, "baz.BAT"));
	});

	it("在多个 PATH 目录里按顺序找,命中第一个匹配的目录就返回", () => {
		const empty = mkdtempSync(join(tmpdir(), "yoma-toolchain-locations-empty-"));
		try {
			writeFileSync(join(dir, "tool"), "");
			const env: NodeJS.ProcessEnv = { PATH: [empty, dir].join(delimiter) };
			expect(findOnPath("tool", env)).toBe(join(dir, "tool"));
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("哪个候选都不存在时返回 undefined", () => {
		const env: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: ".EXE" };
		expect(findOnPath("does-not-exist-xyz", env)).toBeUndefined();
	});

	it("env 的键大小写不敏感 —— 真实 Windows 环境里 PATH 有时被展开成普通对象后只剩 \"Path\"", () => {
		writeFileSync(join(dir, "mytool"), "");
		const env = { Path: dir } as NodeJS.ProcessEnv;
		expect(findOnPath("mytool", env)).toBe(join(dir, "mytool"));
	});

	it("省略 env 时默认用 process.env(冒烟:不炸,编造的名字自然找不到)", () => {
		expect(findOnPath("definitely-not-a-real-toolchain-binary-xyz-999")).toBeUndefined();
	});
});

// ─── expandGlobPath ──────────────────────────────────────────────────────────

describe("expandGlobPath", () => {
	it("没有通配符的字面路径,存在就原样返回", () => {
		const target = join(dir, "literal");
		mkdirSync(target);
		expect(expandGlobPath(target)).toEqual([target]);
	});

	it("没有通配符的字面路径,不存在就返回 []", () => {
		expect(expandGlobPath(join(dir, "nope"))).toEqual([]);
	});

	it("单层通配展开版本号目录(SEGGER\\JLink_V958 那种形状)", () => {
		mkdirSync(join(dir, "JLink_V958"));
		expect(expandGlobPath(join(dir, "JLink*"))).toEqual([join(dir, "JLink_V958")]);
	});

	it("多个匹配的版本目录都要返回,结果按字符串排序以保证可复现", () => {
		mkdirSync(join(dir, "Foo_10"));
		mkdirSync(join(dir, "Foo_2"));
		const expected = [join(dir, "Foo_10"), join(dir, "Foo_2")].sort();
		expect(expandGlobPath(join(dir, "Foo_*"))).toEqual(expected);
	});

	it("不匹配的兄弟目录被过滤掉", () => {
		mkdirSync(join(dir, "Foo_1"));
		mkdirSync(join(dir, "Bar_1"));
		expect(expandGlobPath(join(dir, "Foo_*"))).toEqual([join(dir, "Foo_1")]);
	});

	it("两层通配 + 字面后缀(比如 arm-none-eabi\\*\\bin 那种形状),只有真的带 bin 子目录的才算数", () => {
		mkdirSync(join(dir, "13.2.1", "bin"), { recursive: true });
		mkdirSync(join(dir, "no-bin-here"));
		expect(expandGlobPath(join(dir, "*", "bin"))).toEqual([join(dir, "13.2.1", "bin")]);
	});

	it("pattern 中间某一级目录压根不存在时返回 [],不抛", () => {
		expect(() => expandGlobPath(join(dir, "does-not-exist", "*", "bin"))).not.toThrow();
		expect(expandGlobPath(join(dir, "does-not-exist", "*", "bin"))).toEqual([]);
	});

	it("regex 特殊字符(圆括号)按字面匹配,不解释成正则语法、也不因未转义而抛 SyntaxError", () => {
		mkdirSync(join(dir, "Program Files (x86)"));
		expect(() => expandGlobPath(join(dir, "Program Files (x86)*"))).not.toThrow();
		expect(expandGlobPath(join(dir, "Program Files (x86)*"))).toEqual([join(dir, "Program Files (x86)")]);
	});

	it("句点按字面匹配,不当成正则的任意字符通配 —— 否则会连带匹配到无关目录", () => {
		mkdirSync(join(dir, "arm-13.2.rel1"));
		mkdirSync(join(dir, "arm-13X2Xrel1")); // 只有句点被误当通配符时,这个才会被连带命中
		expect(expandGlobPath(join(dir, "arm-13.2.rel1*"))).toEqual([join(dir, "arm-13.2.rel1")]);
	});

	it("正斜杠拼的 pattern(darwin/linux 风格 install 表用的分隔符)在 Windows 上同样能正确展开", () => {
		mkdirSync(join(dir, "JLink_V1"));
		const forwardSlashPattern = `${dir.replace(/\\/g, "/")}/JLink*`;
		expect(expandGlobPath(forwardSlashPattern)).toEqual([join(dir, "JLink_V1")]);
	});
});

// ─── WELL_KNOWN_LOCATIONS / wellKnownCandidates ─────────────────────────────

const REQUIRED_TOOL_IDS = [
	"arm-gnu-toolchain",
	"jlink",
	"cmake",
	"ninja",
	"clangd",
	"stm32cubemx",
	"python",
	// 芯片平台预设(families.ts)带进来的四个 —— keil 不在这份"三平台全覆盖"名单里,
	// 它是 Windows 独占产品,darwin/linux 没有条目是事实而不是遗漏(单独断言在下面)。
	"openocd",
	"stm32cubeprog",
	"idf",
	"zephyr-sdk",
];
const PLATFORMS: PlatformKey[] = ["win32", "darwin", "linux"];

describe("WELL_KNOWN_LOCATIONS 数据表", () => {
	it("任务要求覆盖的每个 toolId,在每个平台下都至少有一条 pattern", () => {
		for (const id of REQUIRED_TOOL_IDS) {
			for (const platform of PLATFORMS) {
				const patterns = WELL_KNOWN_LOCATIONS[id]?.[platform];
				expect(patterns?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	it("jlink 的 win32 表里有非 C 盘条目 —— 真实机器上就见过装在 D 盘(SEGGER\\JLink_V958)", () => {
		const win32Patterns = WELL_KNOWN_LOCATIONS.jlink?.win32 ?? [];
		const nonC = win32Patterns.filter((p) => !p.toUpperCase().startsWith("C:"));
		expect(nonC.length).toBeGreaterThan(0);
		// 顺带确认真的是"盘符变了"而不是拼写错误 —— 拼出来的路径形状要合理。
		expect(nonC.some((p) => /^[D-G]:\\/i.test(p))).toBe(true);
	});

	it("keil 只有 win32 条目 —— Windows 独占产品,darwin/linux 缺席是事实不是遗漏;安装盘符同样可选", () => {
		const win32Patterns = WELL_KNOWN_LOCATIONS.keil?.win32 ?? [];
		expect(win32Patterns.length).toBeGreaterThan(0);
		expect(win32Patterns.some((p) => /^[D-G]:\\/i.test(p))).toBe(true);
		expect(WELL_KNOWN_LOCATIONS.keil?.darwin).toBeUndefined();
		expect(WELL_KNOWN_LOCATIONS.keil?.linux).toBeUndefined();
	});
});

describe("wellKnownCandidates", () => {
	it("未知 toolId 返回 []", () => {
		expect(wellKnownCandidates("not-a-real-tool", "win32")).toEqual([]);
	});

	it("已知 toolId 但表里没有这个平台(比如 aix)返回 []", () => {
		expect(wellKnownCandidates("jlink", "aix")).toEqual([]);
	});

	// 表键失配的真实形状:清单给编译器起项目内短名(id "arm-gcc"),厂商身份放在
	// from("arm-gnu-toolchain"),而表键是厂商名 —— 只按 id 查,这一档永远不命中,
	// 静默退化成只剩 PATH(bk64.jsonc 实测踩过)。表可注入,回落才能在临时目录上
	// 真展开一次 —— 用真表的话键值全是系统路径,断言只能是空对空,永远不会响。
	it("toolId 不在表里时回落 tool.from 查,pattern 真的展开", () => {
		mkdirSync(join(dir, "gnu-13.2", "bin"), { recursive: true });
		const table: LocationTable = { "arm-gnu-toolchain": { win32: [join(dir, "gnu-*", "bin")] } };
		expect(wellKnownCandidates("arm-gcc", "win32", { from: "arm-gnu-toolchain", table })).toEqual([
			join(dir, "gnu-13.2", "bin"),
		]);
	});

	it("toolId 自己在表里时不看 from —— 更具体的键赢,不做并集", () => {
		mkdirSync(join(dir, "by-id"));
		mkdirSync(join(dir, "by-from"));
		const table: LocationTable = {
			widget: { win32: [join(dir, "by-id")] },
			"widget-vendor": { win32: [join(dir, "by-from")] },
		};
		expect(wellKnownCandidates("widget", "win32", { from: "widget-vendor", table })).toEqual([join(dir, "by-id")]);
	});
});

describe("tableLookup", () => {
	it("id 命中时直接返回,忽略 from", () => {
		expect(tableLookup({ a: 1, b: 2 }, "a", "b")).toBe(1);
	});

	it("id 不在表里时回落 from", () => {
		expect(tableLookup({ b: 2 }, "a", "b")).toBe(2);
	});

	it("两个键都不在、或 from 未提供时返回 undefined", () => {
		expect(tableLookup({ c: 3 }, "a", "b")).toBeUndefined();
		expect(tableLookup({ c: 3 }, "a")).toBeUndefined();
	});
});

// ─── registryCandidates / parseInstallLocations ─────────────────────────────

describe("parseInstallLocations", () => {
	it("从单个命中键的输出里挑出 InstallLocation", () => {
		const stdout = [
			"HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ABC}",
			"    DisplayName    REG_SZ    J-Link Software and Documentation Pack V7.94i",
			"    DisplayVersion    REG_SZ    7.94i",
			"    InstallLocation    REG_SZ    D:\\Program Files\\SEGGER\\JLink_V794i",
			"",
			"End of search: 1 match(es) found.",
		].join("\r\n");
		expect(parseInstallLocations(stdout)).toEqual(["D:\\Program Files\\SEGGER\\JLink_V794i"]);
	});

	it("多个命中键的 InstallLocation 都要收集", () => {
		const stdout = [
			"HKEY_LOCAL_MACHINE\\...\\{A}",
			"    InstallLocation    REG_SZ    C:\\Tools\\A",
			"HKEY_CURRENT_USER\\...\\{B}",
			"    InstallLocation    REG_SZ    C:\\Tools\\B",
		].join("\n");
		expect(parseInstallLocations(stdout)).toEqual(["C:\\Tools\\A", "C:\\Tools\\B"]);
	});

	it("认 REG_EXPAND_SZ,不只是 REG_SZ", () => {
		const stdout = "    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\SEGGER\\JLink";
		expect(parseInstallLocations(stdout)).toEqual(["%ProgramFiles%\\SEGGER\\JLink"]);
	});

	it("没有命中时返回 []", () => {
		expect(parseInstallLocations("End of search: 0 match(es) found.")).toEqual([]);
	});

	it("不会把 DisplayName 之类别的字段误当 InstallLocation,哪怕它的值里出现这几个字", () => {
		const stdout = "    DisplayName    REG_SZ    Something InstallLocation-ish but not the field";
		expect(parseInstallLocations(stdout)).toEqual([]);
	});
});

describe("registryCandidates", () => {
	it("非 win32(注入 platform)一律返回 [],不尝试 spawnSync", () => {
		expect(registryCandidates("jlink", "linux")).toEqual([]);
		expect(registryCandidates("jlink", "darwin")).toEqual([]);
	});

	it("toolId 不在 SEGGER/STMicroelectronics/Arm GNU Toolchain 之外的搜索词表里,直接返回 []", () => {
		// 这台开发机本身就是 win32(见根 CLAUDE.md 环境信息),不需要注入 platform
		// 也能跑到"平台判断通过、查表未命中"这一段 —— 用不在表里的 id 断言提前退出。
		expect(registryCandidates("not-a-real-tool")).toEqual([]);
	});

	it("id 与 from 都不在搜索词表里时返回 [],注入的 terms 表生效(不碰真注册表,快速返回)", () => {
		expect(registryCandidates("arm-gcc", "win32", { from: "unknown-vendor", terms: {} })).toEqual([]);
	});

	it(
		"真实 win32 查询不抛、返回字符串数组(冒烟:不断言具体命中了什么,这台机器是否装了 J-Link 未知)",
		() => {
			const result = registryCandidates("jlink");
			expect(Array.isArray(result)).toBe(true);
			for (const location of result) expect(typeof location).toBe("string");
		},
		15_000,
	);
});
