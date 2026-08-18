// 芯片平台预设(families.ts)验收。预设是纯数据,这里钉的是数据必须满足的结构性
// 承诺 —— 每一条都对应一个真实的静默断裂模式:
//
// 1. **每个平台的清单必须过 parseManifest**:预设经 familyManifestText 序列化后与
//    项目清单走同一条解析路(resolveToolchain 的 manifestText 注入),写进 install
//    文案里的绝对路径、重复 id、from 指错 provider,在生产里表现为设置页整页报
//    error —— 在这儿就得响。
// 2. **同一个 id 在两个平台里必须是同一个工具**:机器账本按 id 全机共享,两份漂移
//    的定义会让"STM32 页配的 arm-gcc"和"Nordic 页看到的 arm-gcc"对着同一条账
//    说两种话。optional 是唯一放行的差异(必备与否是平台语境,不是工具身份)。
// 3. **没有 bin 的工具必须是 dir 型**:resolve.ts 对 bin 为空的工具不走 well-known/
//    registry,唯一入账通道是手填 —— 而手填一个没有可执行文件的条目只能走
//    probe:"exists"(dir 型)。写成 exe 型等于造一个永远验证不过的输入框。
// 4. **probe:"exists" 真的能把目录记进账本、默认严格档真的拒绝目录**:这是 dir 型
//    条目在 actions.ts 里的落地,两头都要响。
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { recordToolchainPath } from "../src/core/toolchain/actions.ts";
import {
	familyManifest,
	familyManifestText,
	findToolchainFamily,
	TOOLCHAIN_FAMILIES,
	type ToolchainFamilyTool,
} from "../src/core/toolchain/families.ts";
import { readLedger } from "../src/core/toolchain/ledger.ts";
import { manifestForSide, parseManifest } from "../src/core/toolchain/schema.ts";

describe("平台目录结构", () => {
	it("平台 id 唯一、name 非空、至少一个平台", () => {
		expect(TOOLCHAIN_FAMILIES.length).toBeGreaterThan(0);
		const ids = TOOLCHAIN_FAMILIES.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const family of TOOLCHAIN_FAMILIES) {
			expect(family.name.trim()).not.toBe("");
		}
	});

	it("findToolchainFamily 按 id 命中,未知 id 返回 undefined", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			expect(findToolchainFamily(family.id)).toBe(family);
		}
		expect(findToolchainFamily("not-a-family")).toBeUndefined();
	});

	it("每个工具都有非空 title 与合法 pathKind", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			for (const tool of family.tools) {
				expect(tool.title.trim()).not.toBe("");
				expect(["exe", "dir"]).toContain(tool.pathKind);
			}
		}
	});

	it("没有 bin 的工具必须是 dir 型 —— exe 型没有 bin 就是一个永远验证不过的输入框", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			for (const tool of family.tools) {
				if ((tool.bin?.length ?? 0) === 0) {
					expect(`${family.id}/${tool.id}:${tool.pathKind}`).toBe(`${family.id}/${tool.id}:dir`);
				}
			}
		}
	});

	it("同一个 id 出现在多个平台时,除 optional 外的定义必须完全一致(账本按 id 全机共享)", () => {
		const seen = new Map<string, { family: string; spec: Omit<ToolchainFamilyTool, "optional"> }>();
		for (const family of TOOLCHAIN_FAMILIES) {
			for (const tool of family.tools) {
				const { optional: _optional, ...identity } = tool;
				const prior = seen.get(tool.id);
				if (prior) {
					// toEqual 的失败输出只有对象 diff,把"哪两个平台"带进断言消息里。
					expect({ id: tool.id, family: family.id, spec: identity }).toEqual({
						id: tool.id,
						family: family.id,
						spec: prior.spec,
					});
				} else {
					seen.set(tool.id, { family: family.id, spec: identity });
				}
			}
		}
	});
});

describe("familyManifest / familyManifestText", () => {
	it("每个平台的清单文本都过 parseManifest —— 绝对路径、重复 id、from 指错在这儿响", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			const parsed = parseManifest(familyManifestText(family));
			if (!parsed.ok) {
				throw new Error(`平台 ${family.id} 的预设清单没过解析闸门:${parsed.error}`);
			}
			expect(parsed.manifest.tools.length).toBe(family.tools.length);
		}
	});

	it("生成的清单不携带 UI 专用字段(title/pathKind 不是 ToolSpec 的一部分)", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			for (const tool of familyManifest(family).tools) {
				expect("title" in tool).toBe(false);
				expect("pathKind" in tool).toBe(false);
			}
		}
	});

	it("side 一律 both:mother / runner 两侧筛完都是全量 —— 机器有什么工具与角色无关", () => {
		for (const family of TOOLCHAIN_FAMILIES) {
			const manifest = familyManifest(family);
			expect(manifestForSide(manifest, "mother").tools.length).toBe(family.tools.length);
			expect(manifestForSide(manifest, "runner").tools.length).toBe(family.tools.length);
		}
	});
});

describe("recordToolchainPath 的目录输入与 probe 档位", () => {
	let configDir: string;
	let installDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "yoma-tc-families-config-"));
		installDir = mkdtempSync(join(tmpdir(), "yoma-tc-families-install-"));
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
		// 假工具被 probeVersion 起过,Windows 上句柄释放慢一拍直删撞 EBUSY(同仓其它 toolchain 测试)。
		rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});

	/** 能被 probeVersion spawn 的假工具(win .bat / posix sh),echo 固定文本。 */
	function writeFakeExe(dir: string, name: string, output: string): string {
		if (process.platform === "win32") {
			const file = join(dir, `${name}.bat`);
			writeFileSync(file, `@echo off\r\necho ${output}\r\n`);
			return file;
		}
		const file = join(dir, name);
		writeFileSync(file, `#!/bin/sh\necho "${output}"\n`);
		chmodSync(file, 0o755);
		return file;
	}

	it('probe:"exists" 把目录原样记进账本(by:user、无版本)—— dir 型条目的正门', async () => {
		const sdkDir = join(installDir, "esp-idf-v5.2");
		mkdirSync(sdkDir);

		const recorded = await recordToolchainPath({ id: "idf", path: sdkDir, configDir, probe: "exists" });
		expect(recorded.binPath).toBe(sdkDir);
		expect(recorded.version).toBeUndefined();

		const ledger = await readLedger(configDir);
		expect(ledger.entries.idf?.by).toBe("user");
		expect(ledger.entries.idf?.version).toBeUndefined();
		expect(Object.values(ledger.entries.idf?.bin ?? {})).toEqual([sdkDir]);
	});

	it("默认档 + 目录 + 无 bins:同样原样记录 —— 版本探针只对文件跑,不再是闸门", async () => {
		const sdkDir = join(installDir, "plain-dir");
		mkdirSync(sdkDir);
		const recorded = await recordToolchainPath({ id: "idf", path: sdkDir, configDir });
		expect(recorded.binPath).toBe(sdkDir);
		expect(recorded.version).toBeUndefined();
	});

	it("目录 + bins:在目录及其 bin/ 子目录里解析声明的名字(用户贴的天然是安装目录)", async () => {
		// JLink 形态:可执行文件在目录根。
		const jlinkDir = join(installDir, "JLink_V958");
		mkdirSync(jlinkDir);
		const jlinkExe = writeFakeExe(jlinkDir, "JLink", "SEGGER J-Link Commander V7.96");
		const jlink = await recordToolchainPath({ id: "jlink", path: jlinkDir, configDir, bins: ["JLink", "JLinkExe"] });
		// PATHEXT 展开的扩展名大小写取自 PATHEXT(通常大写),Windows 文件系统不分大小写 —— 按小写比较。
		expect(jlink.binPath.toLowerCase()).toBe(jlinkExe.toLowerCase());
		expect(jlink.version).toBe("7.96");

		// CubeProgrammer 形态:用户贴安装根,可执行文件在 bin/ 子目录。
		const progDir = join(installDir, "STM32CubeProgrammer");
		mkdirSync(join(progDir, "bin"), { recursive: true });
		const progExe = writeFakeExe(join(progDir, "bin"), "STM32_Programmer_CLI", "version: 2.16.0");
		const prog = await recordToolchainPath({
			id: "stm32cubeprog",
			path: progDir,
			configDir,
			bins: ["STM32_Programmer_CLI"],
		});
		expect(prog.binPath.toLowerCase()).toBe(progExe.toLowerCase());

		const ledger = await readLedger(configDir);
		expect(Object.values(ledger.entries.jlink?.bin ?? {}).map((p) => p.toLowerCase())).toEqual([
			jlinkExe.toLowerCase(),
		]);
		expect(Object.values(ledger.entries.stm32cubeprog?.bin ?? {}).map((p) => p.toLowerCase())).toEqual([
			progExe.toLowerCase(),
		]);
	});

	it("目录 + bins 全都解析不到:不拒绝,原样记录目录本身(Keil 用户贴 UV4 目录、编译器在旁边的 ARM 树里)", async () => {
		const uv4Dir = join(installDir, "UV4");
		mkdirSync(uv4Dir);
		const recorded = await recordToolchainPath({ id: "keil", path: uv4Dir, configDir, bins: ["armclang", "armcc"] });
		expect(recorded.binPath).toBe(uv4Dir);
		expect(recorded.version).toBeUndefined();

		const ledger = await readLedger(configDir);
		expect(ledger.entries.keil?.by).toBe("user");
		expect(Object.values(ledger.entries.keil?.bin ?? {})).toEqual([uv4Dir]);
	});

	it('probe:"exists" 不放松另外两条验证:相对路径、不存在的路径照样拒绝', async () => {
		await expect(recordToolchainPath({ id: "idf", path: "esp/idf", configDir, probe: "exists" })).rejects.toThrow(
			/must be absolute/,
		);
		await expect(
			recordToolchainPath({ id: "idf", path: join(installDir, "nope"), configDir, probe: "exists" }),
		).rejects.toThrow(/does not exist/);
		expect((await readLedger(configDir)).entries).toEqual({});
	});
});
