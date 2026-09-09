// 可自动安装的工具链目录(catalog.ts)验收。目录是**数据**,所以这里钉的全是"数据
// 必须满足的结构性承诺",每一条都对应一个真实的静默断裂:
//
// 1. **url 必须是 https**:下载的东西会被直接解压进用户机器并放上 PATH,明文 http
//    的产物可以被中间人换掉,而 sha256 就写在同一条链路上取不到的地方(它在仓库里,
//    这才是那道闸门成立的前提)。
// 2. **sha256 必须是 64 位小写十六进制、bytes > 0**:install.ts 用它们做校验与进度总数,
//    抄错一位的表现是"下载完永远校验失败",看起来像网络坏了。
// 3. **Windows 产物必须是 zip**:tar 路径要 spawn 系统 tar,Windows 上那条路没有被
//    产品验证过(见 install.ts 文件头);目录里混进一个 win32 的 tar.gz 不会在类型上
//    响,只会在用户机器上炸。
// 4. **url 的后缀要和 archive 对得上**:两者分开写,写岔了就是"按 zip 解一个 tar.gz"。
// 5. **provides 的每个 id 都要在 families.ts 里有定义**:装完之后 install.ts 要按
//    findFamilyTool(id) 拿声明的可执行名去记账,查不到就退化成包级 bins,而设置页那
//    一行压根不会出现 —— 用户装了一个自己看不见的东西。
import { describe, expect, it } from "vitest";

import {
	type CatalogArtifact,
	type CatalogPackage,
	catalogArtifact,
	catalogPackageFor,
	type HostKey,
	hostKey,
	installableFor,
	TOOLCHAIN_CATALOG,
	TOOLCHAIN_MIRROR_ENV,
} from "../src/core/toolchain/catalog.ts";
import { findFamilyTool } from "../src/core/toolchain/families.ts";
import { canInstall } from "../src/core/toolchain/install.ts";

const HOST_KEYS: HostKey[] = ["win32-x64", "win32-arm64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const EXTENSION_OF: Record<CatalogArtifact["archive"], string> = {
	zip: ".zip",
	"tar.gz": ".tar.gz",
	"tar.xz": ".tar.xz",
};

/** 遍历目录里的每一个 (包, 宿主, 产物) 三元组 —— 断言消息里带上前两个,失败时一眼看出是哪一条。 */
function everyArtifact(): Array<{ label: string; pkg: CatalogPackage; host: string; artifact: CatalogArtifact }> {
	const out: Array<{ label: string; pkg: CatalogPackage; host: string; artifact: CatalogArtifact }> = [];
	for (const pkg of TOOLCHAIN_CATALOG) {
		for (const [host, artifact] of Object.entries(pkg.artifacts)) {
			if (!artifact) continue;
			out.push({ label: `${pkg.id}/${host}`, pkg, host, artifact });
		}
	}
	return out;
}

describe("目录结构", () => {
	it("至少一个包;包 id 唯一,title / version / provides / bins 都非空", () => {
		expect(TOOLCHAIN_CATALOG.length).toBeGreaterThan(0);
		const ids = TOOLCHAIN_CATALOG.map((pkg) => pkg.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const pkg of TOOLCHAIN_CATALOG) {
			expect(`${pkg.id}: ${pkg.title.trim()}`).not.toBe(`${pkg.id}: `);
			expect(`${pkg.id}: ${pkg.version.trim()}`).not.toBe(`${pkg.id}: `);
			expect({ id: pkg.id, provides: pkg.provides.length > 0 }).toEqual({ id: pkg.id, provides: true });
			expect({ id: pkg.id, bins: pkg.bins.length > 0 }).toEqual({ id: pkg.id, bins: true });
		}
	});

	it("每个包至少给一个宿主的产物,且宿主键必须是认识的那六个", () => {
		for (const pkg of TOOLCHAIN_CATALOG) {
			const hosts = Object.keys(pkg.artifacts);
			expect({ id: pkg.id, hosts: hosts.length > 0 }).toEqual({ id: pkg.id, hosts: true });
			for (const host of hosts) {
				expect({ id: pkg.id, host, known: HOST_KEYS.includes(host as HostKey) }).toEqual({ id: pkg.id, host, known: true });
			}
		}
	});

	it("同一个工具 id 只被一个包提供 —— catalogPackageFor 取第一个,两个包提供同一个 id 就是隐藏的二义", () => {
		const owner = new Map<string, string>();
		for (const pkg of TOOLCHAIN_CATALOG) {
			for (const id of pkg.provides) {
				const prior = owner.get(id);
				expect({ id, provider: prior ?? pkg.id }).toEqual({ id, provider: pkg.id });
				owner.set(id, pkg.id);
			}
		}
	});

	it("provides 的每个工具 id 在 TOOLCHAIN_FAMILIES 里都有定义(装完要按它的 bin 名记账)", () => {
		for (const pkg of TOOLCHAIN_CATALOG) {
			for (const id of pkg.provides) {
				expect({ pkg: pkg.id, id, inFamilies: findFamilyTool(id) !== undefined }).toEqual({
					pkg: pkg.id,
					id,
					inFamilies: true,
				});
			}
		}
	});
});

describe("产物", () => {
	it("url 一律 https(sha256 校验的前提是链路本身不被换包)", () => {
		for (const { label, artifact } of everyArtifact()) {
			expect(`${label}: ${artifact.url.slice(0, 8)}`).toBe(`${label}: https://`);
			for (const mirror of artifact.mirrors ?? []) {
				expect(`${label} mirror: ${mirror.slice(0, 8)}`).toBe(`${label} mirror: https://`);
			}
		}
	});

	it("sha256 是 64 位小写十六进制,bytes > 0", () => {
		for (const { label, artifact } of everyArtifact()) {
			expect({ label, sha: /^[0-9a-f]{64}$/.test(artifact.sha256) }).toEqual({ label, sha: true });
			expect({ label, positive: artifact.bytes > 0 }).toEqual({ label, positive: true });
			expect({ label, integer: Number.isInteger(artifact.bytes) }).toEqual({ label, integer: true });
		}
	});

	it("archive 是三种之一,且 url 的后缀与它一致", () => {
		for (const { label, artifact } of everyArtifact()) {
			expect(Object.keys(EXTENSION_OF)).toContain(artifact.archive);
			const expected = EXTENSION_OF[artifact.archive];
			expect({ label, endsWith: artifact.url.endsWith(expected) }).toEqual({ label, endsWith: true });
		}
	});

	it("win32 的产物一律是 zip —— Windows 上不走 spawn tar 那条路", () => {
		for (const { label, host, artifact } of everyArtifact()) {
			if (!host.startsWith("win32-")) continue;
			expect(`${label}: ${artifact.archive}`).toBe(`${label}: zip`);
		}
	});

	it("root / binDir 是压缩包内的相对路径:不许绝对,不许含 ..", () => {
		for (const { label, artifact } of everyArtifact()) {
			for (const [field, value] of [
				["root", artifact.root],
				["binDir", artifact.binDir],
			] as const) {
				if (value === undefined || value === "") continue;
				expect({ label, field, escapes: value.split(/[\\/]/).includes("..") }).toEqual({ label, field, escapes: false });
				expect({ label, field, absolute: value.startsWith("/") || /^[A-Za-z]:/.test(value) }).toEqual({
					label,
					field,
					absolute: false,
				});
			}
		}
	});
});

describe("hostKey", () => {
	it("认识的六个组合原样返回", () => {
		expect(hostKey("win32", "x64")).toBe("win32-x64");
		expect(hostKey("win32", "arm64")).toBe("win32-arm64");
		expect(hostKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(hostKey("darwin", "x64")).toBe("darwin-x64");
		expect(hostKey("linux", "x64")).toBe("linux-x64");
		expect(hostKey("linux", "arm64")).toBe("linux-arm64");
	});

	it("不认识的组合返回 undefined,不硬凑一个字符串出来", () => {
		expect(hostKey("win32", "ia32")).toBeUndefined();
		expect(hostKey("linux", "arm")).toBeUndefined();
		expect(hostKey("linux", "riscv64")).toBeUndefined();
		expect(hostKey("freebsd", "x64")).toBeUndefined();
		expect(hostKey("sunos", "x64")).toBeUndefined();
		expect(hostKey("", "")).toBeUndefined();
	});

	it("不传参数时用本进程的 platform/arch", () => {
		expect(hostKey()).toBe(hostKey(process.platform, process.arch));
	});
});

// 自定义目录:断言查表逻辑本身,而不是"目录里恰好有 cmake"这类会随维护而变的事实。
const FAKE_CATALOG: readonly CatalogPackage[] = [
	{
		id: "widget-tools",
		title: "Widget Tools",
		version: "1.2.3",
		provides: ["widget", "widget-dbg"],
		bins: ["widget"],
		artifacts: {
			"linux-x64": {
				url: "https://example.invalid/widget-1.2.3-linux-x64.zip",
				sha256: "a".repeat(64),
				bytes: 1234,
				archive: "zip",
				root: "widget-1.2.3",
				binDir: "bin",
			},
		},
	},
];

describe("catalogPackageFor / catalogArtifact", () => {
	it("按 provides 查包(不是按包 id),未知 id 返回 undefined", () => {
		expect(catalogPackageFor("widget", FAKE_CATALOG)?.id).toBe("widget-tools");
		expect(catalogPackageFor("widget-dbg", FAKE_CATALOG)?.id).toBe("widget-tools");
		expect(catalogPackageFor("widget-tools", FAKE_CATALOG)).toBeUndefined();
		expect(catalogPackageFor("nope", FAKE_CATALOG)).toBeUndefined();
	});

	it("不传 catalog 时查内建目录", () => {
		const pkg = catalogPackageFor("arm-gdb");
		expect(pkg?.id).toBe("arm-gnu-toolchain");
		expect(pkg?.provides).toContain("arm-gcc");
		expect(catalogPackageFor("definitely-not-a-tool")).toBeUndefined();
	});

	it("catalogArtifact 按宿主取产物;宿主没有产物 / 宿主是 undefined 都返回 undefined", () => {
		const pkg = catalogPackageFor("widget", FAKE_CATALOG)!;
		expect(catalogArtifact(pkg, "linux-x64")?.bytes).toBe(1234);
		expect(catalogArtifact(pkg, "win32-x64")).toBeUndefined();
		expect(catalogArtifact(pkg, undefined)).toBeUndefined();
	});
});

describe("installableFor", () => {
	it("有包有产物时给出 packageId / title / version / bytes —— 不带 URL 与 sha", () => {
		expect(installableFor("widget", "linux-x64", FAKE_CATALOG)).toEqual({
			packageId: "widget-tools",
			title: "Widget Tools",
			version: "1.2.3",
			bytes: 1234,
		});
	});

	it("宿主没有产物、宿主认不出来、工具不在目录里,三种都返回 undefined", () => {
		expect(installableFor("widget", "darwin-x64", FAKE_CATALOG)).toBeUndefined();
		expect(installableFor("widget", undefined, FAKE_CATALOG)).toBeUndefined();
		expect(installableFor("nope", "linux-x64", FAKE_CATALOG)).toBeUndefined();
	});

	it("内建目录:arm-gcc 在 linux-x64 能装,在 darwin-x64 不能(Arm 没发这个构建)", () => {
		expect(installableFor("arm-gcc", "linux-x64")?.packageId).toBe("arm-gnu-toolchain");
		expect(installableFor("arm-gcc", "darwin-x64")).toBeUndefined();
	});
});

describe("canInstall", () => {
	it("与 installableFor 同解:有包且这个宿主有产物才为真", () => {
		expect(canInstall("widget", "linux-x64", FAKE_CATALOG)).toBe(true);
		expect(canInstall("widget", "win32-x64", FAKE_CATALOG)).toBe(false);
		expect(canInstall("widget", undefined, FAKE_CATALOG)).toBe(false);
		expect(canInstall("nope", "linux-x64", FAKE_CATALOG)).toBe(false);
	});
});

describe("TOOLCHAIN_MIRROR_ENV", () => {
	it('是 "YOMA_TOOLCHAIN_MIRROR" —— 文档、桌面端与 install.ts 认的是同一个名字', () => {
		expect(TOOLCHAIN_MIRROR_ENV).toBe("YOMA_TOOLCHAIN_MIRROR");
	});
});
