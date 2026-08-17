// 本机工具链账本(ledger.ts)验收:往返读写、损坏文件的容错、原子写、以及
// configDir/projectDir 注入确实生效。全程用 mkdtemp 建的临时目录,一次都不碰
// 真实 ~/.yoma —— 见 ledger.ts 文件头那条硬纪律(Bun 的 os.homedir() 在进程
// 启动时定死,运行时改 HOME 不管用,注入参数是唯一能隔离测试的办法)。
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ledgerPath,
	readLedger,
	readLocalOverrides,
	writeLedgerEntry,
	type LedgerEntry,
} from "../src/core/toolchain/ledger.ts";
import { LOCAL_RELATIVE } from "../src/core/toolchain/schema.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "yoma-toolchain-ledger-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function armGcc(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		id: "arm-gcc",
		bin: { "arm-none-eabi-gcc": "C:\\tools\\arm-gcc\\bin\\arm-none-eabi-gcc.exe" },
		version: "12.2.1",
		confirmedAt: 1_700_000_000_000,
		by: "auto",
		...overrides,
	};
}

describe("ledgerPath", () => {
	it("默认落在 ~/.yoma/toolchains.json —— 只比较路径字符串,不碰磁盘", () => {
		expect(ledgerPath()).toBe(join(homedir(), ".yoma", "toolchains.json"));
	});

	it("传 configDir 时用它,不落回默认值", () => {
		expect(ledgerPath(dir)).toBe(join(dir, "toolchains.json"));
	});
});

describe("configDir 注入生效", () => {
	it("写入真的落在传入的临时目录里", async () => {
		await writeLedgerEntry(armGcc(), dir);
		const file = ledgerPath(dir);
		expect(file.startsWith(dir)).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("arm-none-eabi-gcc");
	});

	it("两个不同 configDir 互不干扰", async () => {
		const other = mkdtempSync(join(tmpdir(), "yoma-toolchain-ledger-b-"));
		try {
			await writeLedgerEntry(armGcc(), dir);
			await writeLedgerEntry(armGcc({ id: "cmake", bin: { cmake: "C:\\tools\\cmake\\cmake.exe" } }), other);
			expect(Object.keys((await readLedger(dir)).entries)).toEqual(["arm-gcc"]);
			expect(Object.keys((await readLedger(other)).entries)).toEqual(["cmake"]);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("configDir 本身还不存在时(比如首次运行的 ~/.yoma)会被自动建出来", async () => {
		const fresh = join(dir, "not-yet-created");
		await writeLedgerEntry(armGcc(), fresh);
		expect(await readLedger(fresh)).toEqual({ schema: "yoma/toolchains@1", entries: { "arm-gcc": armGcc() } });
	});
});

describe("往返读写", () => {
	it("写一条、读回来,形状与内容都对得上", async () => {
		const entry = armGcc();
		await writeLedgerEntry(entry, dir);
		const ledger = await readLedger(dir);
		expect(ledger.schema).toBe("yoma/toolchains@1");
		expect(ledger.entries["arm-gcc"]).toEqual(entry);
	});

	it("写第二条会保留第一条 —— 是合并,不是整份覆盖", async () => {
		await writeLedgerEntry(armGcc(), dir);
		await writeLedgerEntry(armGcc({ id: "cmake", bin: { cmake: "C:\\tools\\cmake\\cmake.exe" }, by: "user" }), dir);
		const ledger = await readLedger(dir);
		expect(Object.keys(ledger.entries).sort()).toEqual(["arm-gcc", "cmake"]);
		expect(ledger.entries.cmake?.by).toBe("user");
	});

	it("对同一个 id 再写一次是覆盖,不是追加两条", async () => {
		await writeLedgerEntry(armGcc({ version: "12.2.1" }), dir);
		await writeLedgerEntry(armGcc({ version: "13.2.0", by: "user" }), dir);
		const ledger = await readLedger(dir);
		expect(Object.keys(ledger.entries)).toEqual(["arm-gcc"]);
		expect(ledger.entries["arm-gcc"]).toEqual(armGcc({ version: "13.2.0", by: "user" }));
	});

	it("version 字段是可选的 —— 没有它也算合法条目", async () => {
		const noVersion: LedgerEntry = {
			id: "jlink",
			bin: { JLinkExe: "C:\\SEGGER\\JLink.exe" },
			confirmedAt: 1,
			by: "auto",
		};
		await writeLedgerEntry(noVersion, dir);
		expect((await readLedger(dir)).entries.jlink).toEqual(noVersion);
	});

	it("从没写过账本的目录读,得到空账本而不是抛错", async () => {
		expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: {} });
	});
});

describe("损坏的账本不抛,当空账本处理", () => {
	it("语法错误的 JSON", async () => {
		writeFileSync(ledgerPath(dir), "{ not json");
		expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: {} });
	});

	it("合法 JSON 但顶层不是对象", async () => {
		for (const text of ["[]", "42", "null", `"just a string"`]) {
			writeFileSync(ledgerPath(dir), text);
			expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: {} });
		}
	});

	it("schema 标签对不上(比如未来版本)当没有,不硬套 v1 形状去读", async () => {
		writeFileSync(ledgerPath(dir), JSON.stringify({ schema: "yoma/toolchains@2", entries: { x: armGcc() } }));
		expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: {} });
	});

	it("entries 不是对象", async () => {
		writeFileSync(ledgerPath(dir), JSON.stringify({ schema: "yoma/toolchains@1", entries: "nope" }));
		expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: {} });
	});

	it("拒绝各种字段形状不对的条目,但保留写对的那条 —— 逐条过滤,不一坏俱坏", async () => {
		writeFileSync(
			ledgerPath(dir),
			JSON.stringify({
				schema: "yoma/toolchains@1",
				entries: {
					good: armGcc({ id: "good" }),
					"no-id": { ...armGcc(), id: 123 },
					"bin-not-object": { ...armGcc(), bin: "not-an-object" },
					"bin-value-not-string": { ...armGcc(), bin: { gcc: 123 } },
					"version-not-string": { ...armGcc(), version: 12 },
					"confirmedAt-not-number": { ...armGcc(), confirmedAt: "yesterday" },
					"by-not-enum": { ...armGcc(), by: "maybe" },
				},
			}),
		);
		expect(Object.keys((await readLedger(dir)).entries)).toEqual(["good"]);
	});

	it("写入之后能自愈:覆盖写会把损坏文件替换成合法内容", async () => {
		writeFileSync(ledgerPath(dir), "{ not json");
		await writeLedgerEntry(armGcc(), dir);
		expect(await readLedger(dir)).toEqual({ schema: "yoma/toolchains@1", entries: { "arm-gcc": armGcc() } });
	});
});

describe("原子写", () => {
	it("成功写入后目录里不留临时文件", async () => {
		await writeLedgerEntry(armGcc(), dir);
		expect(readdirSync(dir)).toEqual(["toolchains.json"]);
	});

	it("目录里残留的半成品临时文件不影响读 —— readLedger 只认确切文件名,不扫目录", async () => {
		// 模拟"上一个进程在 writeFileSync 和 renameSync 之间被杀"留下的孤儿文件:
		// 名字符合 writeJsonAtomic 的命名模式,但从未被 rename 成 toolchains.json,
		// 内容还故意写成截断的 JSON —— 如果 readLedger 曾经扫过目录而不是按确切
		// 文件名读,这条会直接把它读挂。
		await writeLedgerEntry(armGcc(), dir);
		writeFileSync(join(dir, ".toolchains.json.999999-deadbeef.tmp"), '{"schema":"yoma/toolchains@1","entr');

		expect((await readLedger(dir)).entries["arm-gcc"]).toEqual(armGcc());
	});

	it("对同一个文件连续写两次,rename 会整体替换旧内容(Windows 上一并实测)", async () => {
		await writeLedgerEntry(armGcc(), dir);
		await writeLedgerEntry(armGcc({ version: "13.2.0" }), dir);
		expect((await readLedger(dir)).entries["arm-gcc"]?.version).toBe("13.2.0");
		// 两次写各自的临时文件都必须在 rename 后消失,不是只有目标文件长这样、
		// 临时文件在旁边越攒越多。
		expect(readdirSync(dir)).toEqual(["toolchains.json"]);
	});
});

describe("readLocalOverrides", () => {
	function localFile(): string {
		return join(dir, LOCAL_RELATIVE);
	}
	function writeLocal(content: string): void {
		mkdirSync(dirname(localFile()), { recursive: true });
		writeFileSync(localFile(), content);
	}

	it("没有 toolchain.local.json 时返回空对象,不抛", async () => {
		expect(await readLocalOverrides(dir)).toEqual({});
	});

	it("正常路径:读出按工具 id 组织的覆盖表", async () => {
		writeLocal(JSON.stringify({ "arm-gcc": armGcc({ by: "user" }) }));
		expect(await readLocalOverrides(dir)).toEqual({ "arm-gcc": armGcc({ by: "user" }) });
	});

	it("JSON 损坏时返回空对象", async () => {
		writeLocal("{ not json");
		expect(await readLocalOverrides(dir)).toEqual({});
	});

	it("顶层不是对象时返回空对象", async () => {
		writeLocal("[1,2,3]");
		expect(await readLocalOverrides(dir)).toEqual({});
	});

	it("单条形状不对时只跳过那一条,不清空整个覆盖表", async () => {
		writeLocal(
			JSON.stringify({
				"arm-gcc": armGcc(),
				cmake: { id: "cmake" }, // 缺 bin / confirmedAt / by
			}),
		);
		expect(await readLocalOverrides(dir)).toEqual({ "arm-gcc": armGcc() });
	});
});
