import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/agent/node";
import {
	buildSttyArgs,
	createLogToolDefinition,
	DEFAULT_BAUD,
	listSerialPorts,
	normalizeSerialPort,
	parsePortLines,
	powershellArgv,
	prepareSerial,
	serialArgv,
	serialOpenConfirmMs,
	unsupportedBaud,
	windowsReaderScript,
} from "../src/index.ts";

beforeAll(() => {
	process.env.YOMA_PROBE_LOCK = join(tmpdir(), `yoma-probe-serial-${process.pid}.lock`);
});

// ─── 测试脚手架 ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const openTools: Array<{ execute: (id: string, params: any) => Promise<unknown> }> = [];
const fakeDevices: ChildProcess[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-serial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function makeTool() {
	const cwd = createTempDir();
	const tool = createLogToolDefinition(new NodeExecutionEnv({ cwd }));
	openTools.push(tool as any);
	return tool;
}

function textOf(result: unknown): string {
	return ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

/**
 * 假串口:一个真的 pty(字符设备 + 真 termios),由 python3 的 stdlib 造。
 * 打印从设备路径,然后按节奏往主设备写行 —— 于是 open/stty/cat 这条真实链路
 * 可以在没有硬件的机器上跑完整,而不是拿一个 shell 脚本冒充串口。
 */
const PTY_SOURCE = `
import os, pty, sys, time
master, slave = pty.openpty()
sys.stdout.write(os.ttyname(slave) + "\\n")
sys.stdout.flush()
for i in range(200):
    os.write(master, b"HardFault at 0x08001234\\n" if i == 4 else b"boot: tick %d\\n" % i)
    time.sleep(0.05)
`;

/** python3 不在就跳过 —— 这个用例要的是真 tty,没有替代品。 */
function havePython(): boolean {
	return Bun.spawnSync(["python3", "-c", "import pty"]).exitCode === 0;
}

async function startFakeDevice(): Promise<string> {
	const child = spawn("python3", ["-c", PTY_SOURCE], { stdio: ["ignore", "pipe", "pipe"] });
	fakeDevices.push(child);
	return await new Promise<string>((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error("fake serial device did not report its path")), 5000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			const nl = out.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			resolve(out.slice(0, nl).trim());
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

afterEach(async () => {
	for (const tool of openTools.splice(0)) {
		try {
			await tool.execute("cleanup", { action: "stop" });
		} catch {
			// 没启动过的工具会抛,忽略。
		}
	}
	for (const child of fakeDevices.splice(0)) {
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		// 收尸只是为了让测试输出干净,不值得为它挂住 —— 已经退了的进程不会再发 'exit'。
		await Promise.race([exited, Bun.sleep(500)]);
	}
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("normalizeSerialPort", () => {
	it("posix 上补全 /dev,已经是路径的原样放过", () => {
		expect(normalizeSerialPort("cu.usbmodem1103", "darwin")).toBe("/dev/cu.usbmodem1103");
		expect(normalizeSerialPort("ttyUSB0", "linux")).toBe("/dev/ttyUSB0");
		expect(normalizeSerialPort("  /dev/ttyACM0  ", "linux")).toBe("/dev/ttyACM0");
	});

	it("windows 上归一成 COMn,认 \\\\.\\COM12 这种大号口的写法", () => {
		expect(normalizeSerialPort("com5", "win32")).toBe("COM5");
		expect(normalizeSerialPort("\\\\.\\COM12", "win32")).toBe("COM12");
	});

	// 跨平台的第一道坑是名字写成了另一个系统的样子,而"打不开"会让人去查线。
	it("认出写错平台的名字并说清楚", () => {
		expect(() => normalizeSerialPort("COM5", "darwin")).toThrow(/Windows port name/);
		expect(() => normalizeSerialPort("/dev/ttyUSB0", "win32")).toThrow(/expected COM3/);
		expect(() => normalizeSerialPort("   ", "linux")).toThrow(/empty/);
	});
});

describe("buildSttyArgs", () => {
	it("带上波特率、8N1、无流控,以及 clocal", () => {
		const args = buildSttyArgs(921600);
		expect(args[0]).toBe("921600");
		// clocal 少不得:没有它,不上报 DCD 的 USB CDC 设备会让 open() 挂死。
		expect(args).toContain("clocal");
		expect(args).toContain("cs8");
		expect(args).toContain("-parenb");
		expect(args).toContain("-cstopb");
		expect(args).toContain("-crtscts");
		// raw/-echo 必须在末尾,否则会被前面的组合选项覆盖回去。
		expect(args.slice(-2)).toEqual(["raw", "-echo"]);
	});
});

// docker 里实测过(coreutils 9.7 / 8.32):Linux 的 stty 只认 B 常量表,而 macOS
// 给什么收什么。250000 是 Marlin 的默认速率 —— 同一份任务书换台机器就配不上了。
describe("unsupportedBaud", () => {
	it("Linux 上只认标准速率,并给出最近的两档", () => {
		expect(unsupportedBaud(921600, "linux")).toBeUndefined();
		expect(unsupportedBaud(115200, "linux")).toBeUndefined();
		const message = unsupportedBaud(250000, "linux");
		expect(message).toContain("230400 or 460800");
		// 别让模型自己降速 —— 那会成功,然后吐一屏被它当成固件问题的乱码。
		expect(message).toContain("Do not just pick a different rate");
	});

	it("macOS / Windows 不查表", () => {
		expect(unsupportedBaud(250000, "darwin")).toBeUndefined();
		expect(unsupportedBaud(250000, "win32")).toBeUndefined();
	});
});

describe("serialArgv", () => {
	// 设备路径**不能**出现在 argv 里:读进程自己 open 那个 tty 就会把它变成控制终端,
	// 然后 SIGTERM 杀不掉它(serial.ts 文件头第 4 条,实测 4/4 复现)。
	it("posix 上是不带参数的 cat —— 设备靠继承来的 fd 进去", () => {
		expect(serialArgv("/dev/cu.usbmodem1103", 115200, "darwin")).toEqual(["cat"]);
	});

	it("windows 上是 powershell -EncodedCommand,解回来就是那段读串口的脚本", () => {
		const argv = serialArgv("COM5", 921600, "win32");
		expect(argv[0]!.endsWith("powershell.exe")).toBe(true);
		expect(argv).toContain("-NoProfile");
		const index = argv.indexOf("-EncodedCommand");
		expect(index).toBeGreaterThan(0);
		const script = Buffer.from(argv[index + 1]!, "base64").toString("utf16le");
		// 脚本本体原样在后面;前面那一行由 powershellArgv 统一加(见下一条)。
		expect(script.endsWith(windowsReaderScript("COM5", 921600))).toBe(true);
		expect(script).toContain("-ArgumentList 'COM5',921600,'None',8,'One'");
		// try 之外不许有会抛的语句:那样报错就走 PowerShell 自己的错误流,既按代码页
		// 编码又被裹成 CLIXML,而我们要的是 catch 里那句自己编好的 UTF-8。
		expect(script.indexOf("New-Object")).toBeGreaterThan(script.indexOf("try{"));
		// 数据和报错都自己编成 UTF-8 字节:PowerShell 的字符串输出走控制台代码页,
		// 中文 Windows 上解出来的 U+FFFD 不可逆(根 CLAUDE.md 那条)。
		expect(script).toContain("$out.Write($buf,0,$n)");
		expect(script).toContain("[Text.Encoding]::UTF8.GetBytes($_.Exception.Message)");
		expect(script).not.toContain("Write-Host");
	});

	// PowerShell 5.1 一旦发现 stderr 被重定向,就把自己的**非 stdout 流**序列化成 CLIXML
	// 写进去 —— 我们从不写它那些流,但 `New-Object` 触发的模块自动加载自带一条进度记录。
	// 实测(Windows 11 中文 + 真 ST-Link VCP):少了这一行,每次采集的第一行都是带 err
	// 标记的 `#< CLIXML`,于是 `log wait pattern:"."` 命中的是 PowerShell 自己而不是板子;
	// 开口失败时真实报错还会被埋进 ~380 字节 XML(482 字节 → 100 字节)。
	// 钉在 powershellArgv 上而不是某个脚本上:那是唯一入口,枚举脚本一起白得。
	it("powershellArgv 给每一段脚本都关掉进度记录 —— 否则 stderr 会混进 CLIXML", () => {
		const argv = powershellArgv("Write-Output 1");
		const script = Buffer.from(argv[argv.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
		expect(script.startsWith("$ProgressPreference='SilentlyContinue'\n")).toBe(true);
	});
});

describe("serialOpenConfirmMs", () => {
	// 这个数字住在 serial.ts 而不是 log.ts:后者的文件头写着"不认识 termios,也不认识 COM 口"。
	// POSIX 上设备是 prepareSerial 自己 open 的,开不成当场抛,再等就是白等 1.5 秒。
	it("只有 Windows 需要再确认一次口真开成了", () => {
		expect(serialOpenConfirmMs("win32")).toBeGreaterThan(0);
		expect(serialOpenConfirmMs("darwin")).toBe(0);
		expect(serialOpenConfirmMs("linux")).toBe(0);
	});
});

describe("parsePortLines", () => {
	it("`名字<TAB>说明`,说明可以没有", () => {
		expect(parsePortLines("COM3\tSTLink Virtual COM Port (COM3)\r\nCOM7\t\n\n")).toEqual([
			{ path: "COM3", description: "STLink Virtual COM Port (COM3)" },
			{ path: "COM7" },
		]);
	});
});

// ─── 枚举 ────────────────────────────────────────────────────────────────────

describe("listSerialPorts", () => {
	// 端口名的形状跟着**本机**平台走:Windows 是 COMn,POSIX 是 /dev/ 下的设备路径。
	// 只写死一种就是"换台机器必红" —— 写死 /dev/ 的那一版在 Windows 上实测是红的。
	it("只报这个平台真实的端口名,不报系统自带的假串口", async () => {
		const ports = await listSerialPorts();
		for (const entry of ports) {
			if (process.platform === "win32") expect(entry.path).toMatch(/^COM\d+$/);
			else expect(entry.path.startsWith("/dev/")).toBe(true);
			expect(entry.path).not.toContain("Bluetooth-Incoming-Port");
		}
	});
});

// ─── 打开设备 ────────────────────────────────────────────────────────────────

describe("prepareSerial", () => {
	// 这两条**显式传平台**(与下面 "win32" 那条同一种写法):Windows 上 prepareSerial 第一句
	// 就返回 undefined,不传的话这两条在那儿跑的是空气 —— 实测是红的,不是绿的。
	it("普通文件不是串口 —— 挡住写错的路径,也挡住拿它读任意文件", () => {
		const file = join(createTempDir(), "not-a-tty.log");
		writeFileSync(file, "hello");
		expect(() => prepareSerial(file, 115200, "darwin")).toThrow(/not a serial device/);
	});

	it("不存在的设备给的是下一步动作,不是 errno", () => {
		expect(() => prepareSerial("/dev/nope-no-such-device", 115200, "darwin")).toThrow(/does not exist/);
	});

	it.skipIf(!havePython())("真 pty 上开得起来,并且配置得下去", async () => {
		const device = await startFakeDevice();
		const fd = prepareSerial(device, 115200);
		expect(typeof fd).toBe("number");
		closeSync(fd!);
	});

	it("windows 上没有可押的 fd", () => {
		expect(prepareSerial("COM5", 115200, "win32")).toBeUndefined();
	});
});

// ─── 端到端:log 工具 + 真 tty ───────────────────────────────────────────────

describe("log start port", () => {
	it.skipIf(!havePython())("从一个真串口设备采到行,wait 能命中", async () => {
		const device = await startFakeDevice();
		const tool = makeTool();

		const started = await tool.execute("t1", { action: "start", port: device, baud: 115200 });
		expect(textOf(started)).toContain(`serial ${device} @ 115200 8N1`);

		const waited = await tool.execute("t2", { action: "wait", pattern: "hardfault", timeoutMs: 8000 });
		const text = textOf(waited);
		expect(text).toContain("matched /hardfault/");
		expect(text).toContain("HardFault at 0x08001234");
		// 命中行前后要有上下文,不然模型看到的是一条没有来龙去脉的孤行。
		expect(text).toContain("boot: tick");

		const stopped = await tool.execute("t3", { action: "stop" });
		expect(textOf(stopped)).toContain("stopped serial");
		// 这一条钉的是 serial.ts 文件头第 4 条:读进程一旦把设备变成自己的控制终端,
		// SIGTERM 就杀不动它,stop 要等满 5 秒再强杀,并告诉模型"设备可能还占着"。
		expect(textOf(stopped)).not.toContain("did not confirm exit");
	}, 20_000);

	it("三个源互斥 —— 给两个不默默挑一个", async () => {
		const tool = makeTool();
		await expect(
			tool.execute("t", { action: "start", port: "/dev/ttyUSB0", command: "cat /dev/ttyUSB0" }),
		).rejects.toThrow(/exactly one source, got port \+ command/);
		await expect(tool.execute("t", { action: "start", port: "/dev/ttyUSB0", tcp: "localhost:19021" })).rejects.toThrow(
			/exactly one source/,
		);
	});

	// 两个方向都要当场认出来 —— 报"打不开"会让人去查线。输入按本机平台挑:写死 COM5 的
	// 那一版在 Windows 上是红的(COM5 在那儿是合法名字,只是这台机器上没有)。
	it("端口名写成了另一个系统的样子时当场说清,而不是报打不开", async () => {
		const tool = makeTool();
		const [wrong, expected] =
			process.platform === "win32"
				? (["/dev/ttyUSB0", /is not a Windows serial port/] as const)
				: (["COM5", /Windows port name/] as const);
		await expect(tool.execute("t", { action: "start", port: wrong })).rejects.toThrow(expected);
	});

	it("ports 不需要先 start,也不会打开任何设备", async () => {
		const tool = makeTool();
		const text = textOf(await tool.execute("t", { action: "ports" }));
		expect(text).toMatch(/serial ports?:|no serial ports/);
	});

	it("默认波特率是 115200", () => {
		expect(DEFAULT_BAUD).toBe(115_200);
	});

	// 从前这里还有一条"RTT 死掉后租约不留假活约"的 e2e —— 2026-08 移除 probe-rs 后
	// log 工具不再持有探针(RTT 改从 gdb server 的 TCP 口读),那个场景不复存在。
});
