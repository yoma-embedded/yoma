// 工具链版本探测(version.ts)验收:parseVersion / satisfies 是纯函数,直接拿真实
// 工具的 --version 输出当样本断言;probeVersion 要真起子进程,用平台原生的假
// 工具脚本(Windows 是 .bat,其它平台是 #!/bin/sh)——不能像 log.test.ts /
// engines.test.ts 那样无条件写 #!/bin/sh,那批是已知在 Windows 开发机上不亮的
// 存量坑(见前一阶段报告:「Windows 缺 /bin/sh」),这里新增的测试要在这台机器
// 上真的跑绿,所以按 process.platform 分支生成脚本。
import { basename, delimiter, join } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseVersion, probeVersion, PROBE_TIMEOUT_MS, satisfies } from "../src/core/toolchain/version.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "yoma-toolchain-version-"));
});

afterEach(() => {
	// maxRetries/retryDelay:杀掉的那个挂起进程(超时测试那条)在 Windows 上偶尔
	// 会比 probeVersion 的 Promise 结算晚一拍才真正释放它自己那个 .bat 文件的
	// 句柄,直接删会撞 EBUSY——这两个选项是 Node 专门为这类"进程刚被杀、文件系统
	// 还没追上"场景留的,不是加了兜底就代表实现本身有竞态。
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * 造一个能被 `spawn(path, ["--version"])` 直接跑起来的假工具,不经 shell —— 与
 * probeVersion 自己的调用方式对齐,不是拿 shell 里能用的写法抄一份。返回绝对路径。
 */
function writeFakeTool(name: string, body: { stdout?: string; stderr?: string; hang?: boolean }): string {
	// stdout/stderr 先写、hang 放最后:这样"先打印版本号,再卡住"(超时测试里
	// 验证"超时会丢弃已经到手的部分输出"那条要用到)才会真的先把输出冲出去,
	// 不会被挂在前面的死循环堵住,一个字节都出不来。
	if (process.platform === "win32") {
		const file = join(dir, `${name}.bat`);
		const lines = ["@echo off"];
		if (body.stdout !== undefined) lines.push(`echo ${body.stdout}`);
		if (body.stderr !== undefined) lines.push(`echo ${body.stderr} 1>&2`);
		// windows 没有 sleep,一个不退出的死循环就是"挂住"最省事的写法。
		if (body.hang) lines.push(":loop", "goto loop");
		writeFileSync(file, `${lines.join("\r\n")}\r\n`);
		return file;
	}
	const file = join(dir, name);
	const lines = ["#!/bin/sh"];
	if (body.stdout !== undefined) lines.push(`echo "${body.stdout}"`);
	if (body.stderr !== undefined) lines.push(`echo "${body.stderr}" 1>&2`);
	if (body.hang) lines.push("sleep 9999");
	writeFileSync(file, `${lines.join("\n")}\n`);
	chmodSync(file, 0o755);
	return file;
}

describe("parseVersion: 真实工具的 --version 输出", () => {
	it("arm-none-eabi-gcc:跳过括号里的发行代号,取后面真正的编译器版本", () => {
		expect(parseVersion("arm-none-eabi-gcc (Arm GNU Toolchain 13.2.Rel1) 13.2.1 20231009")).toBe("13.2.1");
	});

	it("cmake", () => {
		expect(parseVersion("cmake version 3.28.1")).toBe("3.28.1");
	});

	it("ninja:只打一行裸版本号", () => {
		expect(parseVersion("1.11.1")).toBe("1.11.1");
	});

	it("python", () => {
		expect(parseVersion("Python 3.11.9")).toBe("3.11.9");
	});

	it("J-Link Commander:版本号前的 V 不属于版本号本身", () => {
		expect(parseVersion("SEGGER J-Link Commander V7.94")).toBe("7.94");
	});

	it("gdb:第四段是构建日期戳,不是版本号的一部分,只取前三段", () => {
		expect(parseVersion("GNU gdb (Arm GNU Toolchain 13.2.Rel1) 13.2.90.20231008-git")).toBe("13.2.90");
	});
});

describe("parseVersion: 括号里的内容要跳过", () => {
	it("括号内也是个格式完全合法的版本号时,取的仍是括号外那个", () => {
		// 与上面的真实样本不同:这里括号里那段本身就是完整的 x.y.z,不依赖"第三段
		// 配不上数字"这个巧合来证明跳过规则生效——就算括号里长得和版本号一模一样,
		// 也必须跳过它,不能只是"凑巧因为格式不对才没选中它"。
		expect(parseVersion("tool (build 1.0.0) 2.3.4")).toBe("2.3.4");
	});

	it("版本号只出现在括号里、括号外没有别的数字时,返回 undefined 而不是把发行代号当版本", () => {
		expect(parseVersion("tool (release 1.2.3)")).toBeUndefined();
	});
});

describe("parseVersion: 边界", () => {
	it("空字符串、或压根没有数字,返回 undefined", () => {
		expect(parseVersion("")).toBeUndefined();
		expect(parseVersion("usage: tool [options]")).toBeUndefined();
	});

	it("裸的单段数字(没有点)不算版本号——年份这类噪音不该被当成版本号", () => {
		// --version 的输出常常带一行 Copyright,年份是这类噪音最典型的来源;
		// 要求至少 major.minor 两段,一个孤零零的数字不够格。
		expect(parseVersion("Copyright (C) 2023 Free Software Foundation")).toBeUndefined();
	});

	it("多行输出:版本号不在第一行也找得到", () => {
		expect(parseVersion("some banner\nmore text\nVersion: 2.1.0\nOK")).toBe("2.1.0");
	});
});

describe("satisfies: >= > <= <", () => {
	it(">=,cmake 清单里最常见的写法", () => {
		expect(satisfies("3.28.1", ">=3.22")).toBe(true);
		expect(satisfies("3.22.0", ">=3.22")).toBe(true); // 边界:相等算满足
		expect(satisfies("3.21.9", ">=3.22")).toBe(false);
	});

	it(">,边界相等不算满足", () => {
		expect(satisfies("3.22.1", ">3.22")).toBe(true);
		expect(satisfies("3.22.0", ">3.22")).toBe(false);
	});

	it("<=,边界相等算满足", () => {
		expect(satisfies("3.22.0", "<=3.22")).toBe(true);
		expect(satisfies("3.23.0", "<=3.22")).toBe(false);
	});

	it("<,边界相等不算满足", () => {
		expect(satisfies("3.21.9", "<3.22")).toBe(true);
		expect(satisfies("3.22.0", "<3.22")).toBe(false);
	});
});

describe("satisfies: ^ 钉住大版本号", () => {
	it("^3.11:python 的典型写法,同 major 且 >= minor 才算", () => {
		expect(satisfies("3.11.9", "^3.11")).toBe(true);
		expect(satisfies("3.11.0", "^3.11")).toBe(true); // 边界:下界本身算满足
		expect(satisfies("3.9.0", "^3.11")).toBe(false); // 同 major,但 minor 不够
	});

	it("大版本号一变就不满足,即使数值本身更大", () => {
		expect(satisfies("4.0.0", "^3.11")).toBe(false);
	});
});

describe("satisfies: 裸版本号按 >= 处理", () => {
	it("没有前缀时当 >= 用", () => {
		expect(satisfies("13.2.1", "12")).toBe(true);
		expect(satisfies("11.9.0", "12")).toBe(false);
	});
});

describe("satisfies: 段数不等时短的一边补 0", () => {
	it('"13" vs "13.2.1"——契约文档里点名的例子,两个方向都要对', () => {
		expect(satisfies("13.2.1", "13")).toBe(true); // 13.2.1 >= 13.0.0
		expect(satisfies("13.2.1", "13.5")).toBe(false); // 13.2.1 < 13.5.0
		expect(satisfies("13", "13.2.1")).toBe(false); // 反过来:13.0.0 < 13.2.1
		expect(satisfies("13", ">=13")).toBe(true);
	});
});

describe("probeVersion: 找不到二进制", () => {
	it("绝对路径指向一个不存在的文件,返回 undefined 而不是抛", async () => {
		const result = await probeVersion(join(dir, "definitely-does-not-exist-xyz"));
		expect(result).toBeUndefined();
	});

	it("裸名字在 PATH 上也找不到,同样返回 undefined", async () => {
		const result = await probeVersion("yoma-toolchain-version-test-nonexistent-zzz");
		expect(result).toBeUndefined();
	});
});

describe("probeVersion: 正常路径", () => {
	it("从真实子进程的 stdout 里探到版本号", async () => {
		const bin = writeFakeTool("stdout-tool", { stdout: "9.9.9" });
		expect(await probeVersion(bin)).toBe("9.9.9");
	});

	it("banner + 版本号那种真实输出形状也认得出来", async () => {
		const bin = writeFakeTool("gcc-like", { stdout: "fake-gcc (Fake Toolchain 1.0) 8.7.6 20200101" });
		expect(await probeVersion(bin)).toBe("8.7.6");
	});
});

describe("probeVersion: stdout 和 stderr 都要收", () => {
	it("版本号只打在 stderr 时依然能探到——旧版本 Python 的 --version 就是打 stderr 的", async () => {
		const bin = writeFakeTool("stderr-only", { stderr: "5.4.3" });
		expect(await probeVersion(bin)).toBe("5.4.3");
	});

	it("两边都有输出时优先信 stdout", async () => {
		const bin = writeFakeTool("both-streams", { stdout: "1.0.0", stderr: "9.9.9" });
		expect(await probeVersion(bin)).toBe("1.0.0");
	});
});

describe("probeVersion: 运行时才出现在 PATH 上的二进制也能探到", () => {
	// 这不是在证明"省略 env 会出 bug"——实测过(见实现里的注释):这台机器上的
	// bun 版本里,异步 spawn 就算省略 env 也会重新读一遍当前 PATH,真正会踩坑的
	// 是 spawnSync(见 core/tools/serial.ts 那处场景)。这里验证的是 probeVersion
	// 实际承诺的能力本身:PATH 是在模块已经加载之后、这次调用之前才被前置的目录,
	// 一样要能探测到,而不是只认进程启动那一刻的 PATH——不管 bun 版本之间这条
	// 行为线怎么移动,这个外部可观察的承诺都不该破。
	it("PATH 在运行时被前置一个新目录,该目录里的工具也能被探到", async () => {
		const fullPath = writeFakeTool("path-tool", { stdout: "6.6.6" });
		const name = basename(fullPath);
		const originalPath = process.env.PATH;
		process.env.PATH = `${dir}${delimiter}${originalPath}`;
		try {
			expect(await probeVersion(name)).toBe("6.6.6");
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe("probeVersion: 超时不挂起、不抛", () => {
	it(
		"卡住的进程在 5s 后被杀掉,resolve(undefined) 而不是永远挂起",
		async () => {
			const bin = writeFakeTool("hangs-forever", { hang: true });
			const start = Date.now();
			const result = await probeVersion(bin);
			const elapsed = Date.now() - start;
			expect(result).toBeUndefined();
			// 下界(减去一点计时器粒度容差)证明真的等到了我们自己的超时,不是恰好
			// 被别的什么提前打断;上界证明杀确实生效了,不是超时之后还在傻等这个
			// 死循环自然退出(它根本不会自然退出)。
			expect(elapsed).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
			expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS + 3000);
		},
		PROBE_TIMEOUT_MS + 5000, // bun:test 默认单测超时 5000ms,比 PROBE_TIMEOUT_MS 本身还短,必须显式放宽
	);

	it(
		"卡住之前已经打出的部分输出不会被误当成探测成功——超时就是超时,不是「半成功」",
		async () => {
			// 工具先打完整版本号、再卡住(比如等一个从没出现过的 EULA 确认)是真实
			// 场景:如果超时分支不丢弃已收集的 stdout,这条会错误地拿到 "1.2.3"
			// 而不是 undefined,把一次超时报成一次成功探测。
			const bin = writeFakeTool("prints-then-hangs", { stdout: "1.2.3", hang: true });
			expect(await probeVersion(bin)).toBeUndefined();
		},
		PROBE_TIMEOUT_MS + 5000,
	);
});
