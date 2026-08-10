import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import {
	buildSttyArgs,
	claimProbe,
	createLogToolDefinition,
	DEFAULT_BAUD,
	listSerialPorts,
	normalizeSerialPort,
	parsePortLines,
	prepareSerial,
	releaseProbe,
	serialArgv,
	unsupportedBaud,
	windowsReaderScript,
} from "../src/index.ts";

// ─── 测试脚手架 ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const openTools: Array<{ execute: (id: string, params: any) => Promise<unknown> }> = [];
const fakeDevices: ChildProcess[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-serial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		expect(script).toBe(windowsReaderScript("COM5", 921600));
		expect(script).toContain("-ArgumentList 'COM5',921600,'None',8,'One'");
		// 数据和报错都自己编成 UTF-8 字节:PowerShell 的字符串输出走控制台代码页,
		// 中文 Windows 上解出来的 U+FFFD 不可逆(根 CLAUDE.md 那条)。
		expect(script).toContain("$out.Write($buf,0,$n)");
		expect(script).toContain("[Text.Encoding]::UTF8.GetBytes($_.Exception.Message)");
		expect(script).not.toContain("Write-Host");
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
	it("只报真设备路径,不报系统自带的假串口", async () => {
		const ports = await listSerialPorts();
		for (const entry of ports) {
			expect(entry.path.startsWith("/dev/")).toBe(true);
			expect(entry.path).not.toContain("Bluetooth-Incoming-Port");
		}
	});
});

// ─── 打开设备 ────────────────────────────────────────────────────────────────

describe("prepareSerial", () => {
	it("普通文件不是串口 —— 挡住写错的路径,也挡住拿它读任意文件", () => {
		const file = join(createTempDir(), "not-a-tty.log");
		writeFileSync(file, "hello");
		expect(() => prepareSerial(file, 115200)).toThrow(/not a serial device/);
	});

	it("不存在的设备给的是下一步动作,不是 errno", () => {
		expect(() => prepareSerial("/dev/nope-no-such-device", 115200)).toThrow(/does not exist/);
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
		await expect(tool.execute("t", { action: "start", port: "/dev/ttyUSB0", chip: "STM32G431CB" })).rejects.toThrow(
			/exactly one source/,
		);
	});

	it("端口名写错时把这台机器上真实存在的口贴出来", async () => {
		const tool = makeTool();
		await expect(tool.execute("t", { action: "start", port: "COM5" })).rejects.toThrow(/Windows port name/);
	});

	it("ports 不需要先 start,也不会打开任何设备", async () => {
		const tool = makeTool();
		const text = textOf(await tool.execute("t", { action: "ports" }));
		expect(text).toMatch(/serial ports?:|no serial ports/);
	});

	it("默认波特率是 115200", () => {
		expect(DEFAULT_BAUD).toBe(115_200);
	});

	// 探针租约的 isLive 看的是工具当前那个采集器。RTT 自己死掉之后再开一个串口采集,
	// 租约就会指着**新**采集说"我还活着" —— 于是一个早就退了的 RTT 把探针锁死,
	// flash 被拒,理由指向一个不存在的会话。评审时真复现出来过。
	it.skipIf(!havePython())("RTT 自己死掉之后开串口,不会把探针租约留成一份假的活约", async () => {
		releaseProbe("log");
		releaseProbe("flash");
		const cwd = createTempDir();
		const elf = join(cwd, "fw.elf");
		writeFileSync(elf, "not really an elf");
		// 假 probe-rs:打一行错就退,模拟"RTT control block not found"。
		const enginesDir = join(createTempDir(), "engines");
		mkdirSync(join(enginesDir, "bin"), { recursive: true });
		const bin = join(enginesDir, "bin", "probe-rs");
		writeFileSync(bin, '#!/bin/sh\necho "Error: RTT control block not found"\nsleep 0.15\nexit 1\n');
		chmodSync(bin, 0o755);
		const tool = createLogToolDefinition(new NodeExecutionEnv({ cwd }), { enginesDir });
		openTools.push(tool as any);

		await tool.execute("r1", { action: "start", chip: "STM32G431CB", elfPath: elf });
		const deadline = Date.now() + 5000;
		while (!/exited/.test(textOf(await tool.execute("r2", { action: "status" })))) {
			if (Date.now() > deadline) throw new Error("fake probe-rs never exited");
			await Bun.sleep(20);
		}
		await tool.execute("r3", { action: "start", port: await startFakeDevice(), baud: 115200 });

		expect(claimProbe("flash", "probe-rs download")).toBeUndefined();
		releaseProbe("flash");
	}, 20_000);
});
