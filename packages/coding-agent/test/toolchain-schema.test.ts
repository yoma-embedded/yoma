// 工具链清单的类型 + 纯函数验收:解析/校验、按 side 筛选、installHint 回退链。
// 全部是纯函数,不碰文件系统(读账本/扫 PATH 是 ledger.ts / locations.ts 的活),
// 唯一的例外是读 fixtures/toolchain/bk64.jsonc —— 那是数据,不是被测代码本身。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	installHint,
	LOCAL_RELATIVE,
	MANIFEST_RELATIVE,
	manifestForSide,
	parseManifest,
	type ToolchainManifest,
} from "../src/core/toolchain/schema.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "toolchain", "bk64.jsonc");

function readFixture(): string {
	return readFileSync(FIXTURE_PATH, "utf8");
}

/** 校验通过时把 manifest 挖出来,失败时让断言消息直接带上 parseManifest 的错误—— 排错不用去猜是哪一步炸的。 */
function parseOk(text: string): ToolchainManifest {
	const result = parseManifest(text);
	if (!result.ok) throw new Error(`expected parseManifest to succeed, got: ${result.error}`);
	return result.manifest;
}

describe("path constants", () => {
	it("point at .yoma/ under the project, not the config dir", () => {
		expect(MANIFEST_RELATIVE).toBe(".yoma/toolchain.json");
		expect(LOCAL_RELATIVE).toBe(".yoma/toolchain.local.json");
	});
});

describe("parseManifest: happy path", () => {
	it("parses the bk64 fixture end to end", () => {
		const manifest = parseOk(readFixture());
		expect(manifest.schema).toBe("yoma/toolchain@1");
		expect(manifest.tools.map((t) => t.id)).toEqual([
			"arm-gcc",
			"arm-gdb",
			"cmake",
			"ninja",
			"jlink",
			"python",
			"clangd",
			"stm32cubemx",
		]);
		expect(Object.keys(manifest.providers ?? {})).toEqual(["arm-gnu-toolchain"]);
		expect(manifest.setup?.map((s) => s.run)).toEqual(["git submodule update --init --recursive", "uv sync"]);
	});

	it("strips // line comments but leaves // inside string values alone", () => {
		// 这是实现里专门防的坑:naive 的"见 // 就截断"会把 install 提示里的
		// URL(https://...)从冒号那一段直接吃掉。同一份文本里既要有真注释,
		// 又要有字符串里的 //,才能证明两者被分开对待。
		const text = `{
			// 这一整行是注释,不该进 JSON
			"schema": "yoma/toolchain@1", // 行尾注释也要能剥
			"tools": [
				{ "id": "cmake", "install": { "win32": "see https://cmake.org//docs for details" } }
			]
		}`;
		const manifest = parseOk(text);
		expect(manifest.tools[0].install?.win32).toBe("see https://cmake.org//docs for details");
	});

	it("strips a leading BOM before parsing", () => {
		// 用 fromCharCode 构造而不是在测试源码里直接敲那个字符——原因见 schema.ts
		// 里同一处的注释:U+FEFF 是零宽字符,写进源文件本身就是一个事故现场。
		const bom = String.fromCharCode(0xfeff);
		const manifest = parseOk(`${bom}{"schema":"yoma/toolchain@1","tools":[]}`);
		expect(manifest.tools).toEqual([]);
	});

	it("allows a manifest with zero tools and no optional sections", () => {
		const manifest = parseOk(`{"schema":"yoma/toolchain@1","tools":[]}`);
		expect(manifest.tools).toEqual([]);
		expect(manifest.providers).toBeUndefined();
		expect(manifest.setup).toBeUndefined();
	});
});

describe("parseManifest: malformed JSON never throws a raw SyntaxError", () => {
	it("reports invalid JSON as a result, not an exception", () => {
		expect(() => parseManifest("{not json")).not.toThrow();
		const result = parseManifest("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("not valid JSON");
			// 不能是裸的 V8 消息糊在用户脸上,得先说清是哪个文件。
			expect(result.error).toContain(MANIFEST_RELATIVE);
		}
	});

	it("rejects a JSON document that isn't an object", () => {
		for (const text of ["[]", "null", `"just a string"`, "42"]) {
			const result = parseManifest(text);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("must be a JSON object");
		}
	});
});

describe("parseManifest: schema tag", () => {
	it("names the field and the expected value when schema is wrong", () => {
		const result = parseManifest(`{"schema":"yoma/toolchain@2","tools":[]}`);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('"schema"');
			expect(result.error).toContain("yoma/toolchain@1");
		}
	});

	it("names the field when schema is missing entirely", () => {
		const result = parseManifest(`{"tools":[]}`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"schema"');
	});
});

describe("parseManifest: tools structure", () => {
	it("requires tools to be an array", () => {
		const result = parseManifest(`{"schema":"yoma/toolchain@1","tools":"cmake"}`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"tools" must be an array');
	});

	it("requires each tool to be an object", () => {
		const result = parseManifest(`{"schema":"yoma/toolchain@1","tools":["cmake"]}`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("tools[0] must be an object");
	});

	it("requires a non-empty id, and points at the index", () => {
		for (const tools of [`[{}]`, `[{"id":""}]`, `[{"id":"   "}]`]) {
			const result = parseManifest(`{"schema":"yoma/toolchain@1","tools":${tools}}`);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("tools[0].id must be a non-empty string");
		}
	});

	it("rejects duplicate tool ids and names both indices", () => {
		const result = parseManifest(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"cmake"},{"id":"ninja"},{"id":"cmake"}]}`,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('duplicate tool id "cmake"');
			expect(result.error).toContain("tools[0]");
			expect(result.error).toContain("tools[2]");
		}
	});

	it("rejects a from that references a provider that doesn't exist", () => {
		const result = parseManifest(`{"schema":"yoma/toolchain@1","tools":[{"id":"arm-gdb","from":"nope"}]}`);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("arm-gdb");
			expect(result.error).toContain('unknown provider "nope"');
		}
	});

	it("accepts a from that references a declared provider", () => {
		const manifest = parseOk(
			`{"schema":"yoma/toolchain@1","providers":{"vendor":{}},"tools":[{"id":"arm-gdb","from":"vendor"}]}`,
		);
		expect(manifest.tools[0].from).toBe("vendor");
	});

	it("requires providers to be an object when present", () => {
		const result = parseManifest(`{"schema":"yoma/toolchain@1","providers":["vendor"],"tools":[]}`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"providers" must be an object');
	});
});

describe("parseManifest: absolute paths are rejected anywhere in the document", () => {
	// 错误话术必须点名"两台机器",不是随便一句"bad path" —— 这是清单这份契约存在
	// 的核心原因,含糊的错误会让人以为只是格式问题,改改引号就重试。
	function expectRejectedAsAbsolute(text: string, snippetContains: string) {
		const result = parseManifest(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("two machines");
			expect(result.error).toContain(snippetContains);
		}
	}

	it("rejects a unix-style absolute path used as a whole field value", () => {
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"arm-gcc","bin":["/usr/bin/arm-none-eabi-gcc"]}]}`,
			"/usr/bin/arm-none-eabi-gcc",
		);
	});

	it("rejects a windows drive path with a backslash", () => {
		// 捕获的 snippet 在第一个空格处截断(正则是 \S+):"Program Files" 这种
		// 常见 Windows 路径,报出来的是 "D:\Program" 而不是完整路径 —— 够指认
		// 是哪一段坏了就行,不追求把带空格的路径完整抠出来(那需要真正的路径
		// 语法,不是几行 regex 该干的事)。
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","install":{"win32":"D:\\\\Program Files\\\\SEGGER\\\\JLink.exe"}}]}`,
			"D:\\Program",
		);
	});

	it("rejects a windows drive path with a forward slash", () => {
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","install":{"win32":"see C:/Program Files/SEGGER"}}]}`,
			"C:/Program",
		);
	});

	it("rejects a windows UNC path", () => {
		// UNC 和盘符路径在 Windows 上是并列的两种绝对路径,漏过一次。清单里最可能
		// 写它的地方就是这种"从构建服务器拷过来"的顺手话 —— 而那台服务器在别人的
		// 机器上根本不可达,恰恰是这道闸门要防的头号情形。
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","why":"copy it from \\\\\\\\buildserver\\\\tools\\\\JLink first"}]}`,
			"\\\\buildserver\\tools\\JLink",
		);
	});

	it("catches an absolute path buried inside a prose sentence, not just a bare field", () => {
		// 正是"任何字符串里出现"这句话要防的坑:字段本身不是路径,但句子里顺手
		// 抄了一句本机路径,一样要报。
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","why":"on this machine it happens to live at /opt/SEGGER/JLink, but that won't be true elsewhere"}]}`,
			"/opt/SEGGER/JLink",
		);
	});

	it("catches an absolute path in setup steps, not just tool fields", () => {
		expectRejectedAsAbsolute(
			`{"schema":"yoma/toolchain@1","tools":[],"setup":[{"run":"echo hi","cwd":"/home/dev/BK64_motor"}]}`,
			"/home/dev/BK64_motor",
		);
	});

	it("does NOT reject ordinary relative paths that merely contain a slash", () => {
		// 反向断言,防住"regex 太贪婪,把 tools/motor_gui 这种正常相对路径也当成
		// 绝对路径"的回归 —— 这类路径在 setup.cwd / why 里到处都是,是核心用例
		// 而不是边角料。
		const manifest = parseOk(
			`{"schema":"yoma/toolchain@1","tools":[],"setup":[{"run":"uv sync","cwd":"tools/motor_gui","why":"see cmake/gcc-arm-none-eabi.cmake for the compiler prefix"}]}`,
		);
		expect(manifest.setup?.[0].cwd).toBe("tools/motor_gui");
	});

	it("does NOT reject a URL even though it contains //", () => {
		// 另一半反向断言:install 提示写 URL 是常态,"/" 前面是 ":" 而不是空白,
		// 不该被 unix 绝对路径那条规则误伤。
		const manifest = parseOk(
			`{"schema":"yoma/toolchain@1","tools":[{"id":"cmake","install":{"win32":"see https://cmake.org/download/ for installers"}}]}`,
		);
		expect(manifest.tools[0].install?.win32).toBe("see https://cmake.org/download/ for installers");
	});
});

describe("manifestForSide", () => {
	const base: ToolchainManifest = {
		schema: "yoma/toolchain@1",
		providers: {
			"arm-gnu-toolchain": { install: { win32: "vendor hint" } },
			unused: { install: { win32: "never referenced by a surviving tool" } },
		},
		tools: [
			{ id: "cmake" }, // side 缺省 —— 必须按 "mother" 处理
			{ id: "arm-gdb", side: "runner", from: "arm-gnu-toolchain" },
			{ id: "python", side: "both" },
		],
	};

	it("defaults a missing side to mother", () => {
		const mother = manifestForSide(base, "mother");
		expect(mother.tools.map((t) => t.id)).toEqual(["cmake", "python"]);
	});

	it("puts a runner-only tool only on the runner side", () => {
		const runner = manifestForSide(base, "runner");
		expect(runner.tools.map((t) => t.id)).toEqual(["arm-gdb", "python"]);
	});

	it("puts a both tool on both sides", () => {
		expect(manifestForSide(base, "mother").tools.some((t) => t.id === "python")).toBe(true);
		expect(manifestForSide(base, "runner").tools.some((t) => t.id === "python")).toBe(true);
	});

	it("trims providers to only the ones the filtered tools still reference", () => {
		// mother 侧的 cmake/python 都不用 from,arm-gnu-toolchain 和 unused 两个
		// provider 应该一起被裁掉;runner 侧的 arm-gdb 用 from,arm-gnu-toolchain
		// 要留下,unused 依然要被裁掉(它对谁都没用)。
		expect(Object.keys(manifestForSide(base, "mother").providers ?? {})).toEqual([]);
		expect(Object.keys(manifestForSide(base, "runner").providers ?? {})).toEqual(["arm-gnu-toolchain"]);
	});

	it("leaves providers undefined when the manifest never had any", () => {
		const noProviders: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "cmake" }] };
		expect(manifestForSide(noProviders, "mother").providers).toBeUndefined();
	});

	it("on the real fixture: runner keeps exactly arm-gdb, jlink, python", () => {
		const manifest = parseOk(readFixture());
		const runner = manifestForSide(manifest, "runner");
		expect(runner.tools.map((t) => t.id).sort()).toEqual(["arm-gdb", "jlink", "python"]);
	});

	it("on the real fixture: mother keeps the other six, and drops the provider none of them use", () => {
		const manifest = parseOk(readFixture());
		const mother = manifestForSide(manifest, "mother");
		expect(mother.tools.map((t) => t.id).sort()).toEqual(
			["arm-gcc", "clangd", "cmake", "ninja", "python", "stm32cubemx"].sort(),
		);
		// arm-gnu-toolchain 只被 runner 侧的 arm-gdb 引用;mother 侧一个都不剩。
		expect(Object.keys(mother.providers ?? {})).toEqual([]);
	});
});

describe("installHint", () => {
	it("prefers the tool's own install over the provider's", () => {
		const manifest = parseOk(readFixture());
		const armGcc = manifest.tools.find((t) => t.id === "arm-gcc")!;
		expect(installHint(manifest, armGcc, "darwin")).toBe("brew install --cask gcc-arm-embedded");
	});

	it("falls back to providers[tool.from] when the tool has no install of its own", () => {
		// 这是 arm-gdb 在 fixture 里存在的意义:它完全没写 install,三条平台的
		// 提示必须原样来自 arm-gnu-toolchain 这个 provider。
		const manifest = parseOk(readFixture());
		const armGdb = manifest.tools.find((t) => t.id === "arm-gdb")!;
		expect(armGdb.install).toBeUndefined();
		expect(installHint(manifest, armGdb, "win32")).toBe(manifest.providers?.["arm-gnu-toolchain"].install?.win32);
		expect(installHint(manifest, armGdb, "linux")).toContain("gdb-multiarch");
	});

	it("returns undefined when there is no install and no from", () => {
		const manifest: ToolchainManifest = { schema: "yoma/toolchain@1", tools: [{ id: "mystery" }] };
		expect(installHint(manifest, manifest.tools[0], "win32")).toBeUndefined();
	});

	it("returns undefined when from points at a provider with no hint for that platform", () => {
		const manifest: ToolchainManifest = {
			schema: "yoma/toolchain@1",
			providers: { vendor: { install: { win32: "only windows here" } } },
			tools: [{ id: "tool", from: "vendor" }],
		};
		expect(installHint(manifest, manifest.tools[0], "linux")).toBeUndefined();
		expect(installHint(manifest, manifest.tools[0], "win32")).toBe("only windows here");
	});

	it("returns undefined when from points at a provider that isn't in this (already side-filtered) manifest", () => {
		// manifestForSide 会把用不上的 provider 裁掉;installHint 面对裁剪后的
		// manifest 必须优雅地给 undefined,而不是抛异常。
		const manifest: ToolchainManifest = {
			schema: "yoma/toolchain@1",
			tools: [{ id: "tool", from: "gone" }],
		};
		expect(installHint(manifest, manifest.tools[0], "win32")).toBeUndefined();
	});
});
