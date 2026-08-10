/**
 * UART / USB 串口:把 macOS、Linux、Windows 三套"怎么打开一个串口"收在一处。
 * log 工具的一个日志源,不是工具 —— 与 engines.ts、path-utils.ts 同类。
 *
 * 【为什么不引 serialport 这类原生模块】
 * 它是 native binding:要按 Electron ABI 重编,要为三平台备 prebuild,而内核是被整个
 * inline 进 `out/main/kernel.js` 的 —— 多一个 .node 就多一条打包期的断裂线。而串口本来
 * 就是操作系统给的东西:POSIX 有 termios(stty)+ 一个字符设备,Windows 有
 * System.IO.Ports。两条路都只要一个子进程,与 log 工具"一个采集器 = 一个子进程"同构,
 * 于是环形缓冲、折叠、wait、killTree 全部白得。
 *
 * 【POSIX:为什么是"开两次 fd + 让 cat 读 stdin",而不是流传甚广的 `stty … && cat …`】
 * 1. **termios 属于 tty 而不是 fd,最后一个 fd 关闭时驱动会把它复位。** `stty` 退出到
 *    `cat` 打开之间没有任何人握着设备,波特率已经退回默认值。实测(macOS 26 +
 *    B-G431B-ESC1 的 ST-Link VCP):`stty -f /dev/cu.usbmodem11303 921600` 之后立刻回读
 *    就是 `speed 9600 baud`。那句流传甚广的 `stty … && cat …` 因此是**错的**,而症状
 *    是整屏乱码 —— 看起来像固件坏了,而不是像命令写错了。所以设备必须**全程有人握着**:
 *    配置用的 fd 先开,读用的 fd 在它关闭之前开好。
 * 2. **第一次 open 必须带 O_NONBLOCK。** Linux 上没有 CLOCAL 时 `open()` 会阻塞等载波
 *    (DCD),而 USB CDC 设备(STM32 那一类)多数根本不上报 DCD —— `cat /dev/ttyACM0`
 *    挂死就是这么来的。非阻塞开一次、把 clocal 设上,第二次阻塞 open 才安全。
 * 3. **stty 走 stdin 而不是 `-f`/`-F`。** 那两个选项 macOS 与 Linux 拼写不同,而"设置
 *    stdin 的 tty"是 POSIX 规定的行为,一套参数两边通用,少一个平台分支。
 * 4. **读进程绝不能自己 open 设备,只能读我们给的 O_NOCTTY fd。** 采集子进程是
 *    `detached` 起的(为了 killTree 够得着孙进程),于是它是 **session leader**;
 *    session leader 打开一个 tty 且没带 O_NOCTTY,那个 tty 就成了它的**控制终端**,
 *    而这样的进程**收到 SIGTERM 不会死**。实测(macOS,同一段代码换一个写法各跑 4 次):
 *    `cat <设备>` 每次都是 `Ss+ ttys003`、SIGTERM 后 >1500ms 仍活着、'exit' 事件永不到;
 *    `cat`(读继承来的 O_NOCTTY fd)每次都是 `Ss ??`、21ms 内退出。
 *    症状是 `log stop` 每次等满 5 秒然后说"没能确认退出,已强杀" —— 而那句话正是告诉
 *    模型"设备可能还被占着"的话,于是每次停采都像出了硬件故障。
 *
 * 【Windows:为什么是 PowerShell】
 * 没有 stty,`type \\.\COM3` 也不是流式的。System.IO.Ports.SerialPort 在每台 Win10/11
 * 自带的 Windows PowerShell 5.1 里就有,零安装。脚本用 `-EncodedCommand` 传
 * (UTF-16LE base64),于是引号、分号、反斜杠一律不参与命令行解析;读的是**原始字节**
 * 直接写 stdout —— 不让 PowerShell 先按代码页解一遍,中文 Windows 上 cp936 解出来的
 * U+FFFD 是不可逆的(见根 CLAUDE.md"子进程默认不按 UTF-8 输出")。
 *
 * 【端口名不进 shell,也不进脚本文本】
 * POSIX 是 argv 直接 spawn;Windows 端口名先被 `^COM\d+$` 卡死再拼进脚本 —— 拼字符串
 * 的地方必须先有一道正则,否则 `port` 就是一条 PowerShell 注入通道。
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { runEngine } from "./engines.ts";

/** 绝大多数板子的出厂速率;真值由调用方给,这只是 baud 缺省。 */
export const DEFAULT_BAUD = 115_200;

/** 波特率的合理区间 —— 卡掉 0 和手滑多打的零,不做白名单(非标速率是常态)。 */
export const MIN_BAUD = 50;
export const MAX_BAUD = 12_000_000;

/** macOS 自带的几个 cu.*:列出来只会让人往错的地方插。 */
const DARWIN_NOISE = new Set(["cu.Bluetooth-Incoming-Port", "cu.debug-console", "cu.wlan-debug"]);

/** Windows 端口名。`\\.\COM12` 是 COM10 以上的写法,收下但归一成 COM12。 */
const WINDOWS_PORT = /^(?:\\\\\.\\)?(COM\d+)$/i;

export interface SerialPortInfo {
	/** 能直接填给 `log start port:` 的东西:POSIX 是设备路径,Windows 是 COMn。 */
	path: string;
	/** 只有操作系统给得出名字时才有(Linux 的 by-id、Windows 的设备友好名)。 */
	description?: string;
}

// ─── 端口名 ──────────────────────────────────────────────────────────────────

/**
 * 归一化并校验端口名。跨平台的第一道坑是"名字写成了另一个系统的样子",
 * 所以两边都要认出对方的写法并明说 —— 报"打不开"会让人去查线。
 */
export function normalizeSerialPort(port: string, platform: NodeJS.Platform = process.platform): string {
	const raw = port.trim();
	if (!raw) throw new Error("port is empty");
	const windows = WINDOWS_PORT.exec(raw);
	if (platform === "win32") {
		if (!windows) throw new Error(`"${raw}" is not a Windows serial port — expected COM3 (run \`log ports\` to see them)`);
		return windows[1]!.toUpperCase();
	}
	if (windows) {
		throw new Error(
			`"${raw}" is a Windows port name; on ${platform} serial ports are device paths like /dev/cu.usbmodem1103 (run \`log ports\`)`,
		);
	}
	// 只给名字("cu.usbmodem1103" / "ttyUSB0")时补上 /dev —— 模型常这么写,而这个错
	// 的表现是 ENOENT,和"板子没插"长得一模一样。
	return raw.includes("/") ? raw : `/dev/${raw}`;
}

// ─── POSIX ───────────────────────────────────────────────────────────────────

/**
 * stty 参数。`clocal` 是关键(见文件头第 2 条);`raw -echo` 放最后,免得被前面的
 * 组合选项覆盖回去。全是 POSIX 标准选项,macOS 与 Linux 同一套。
 */
export function buildSttyArgs(baud: number): string[] {
	return [String(baud), "cs8", "-parenb", "-cstopb", "-crtscts", "clocal", "raw", "-echo"];
}

/** 打不开串口是最常见的失败,而 errno 的默认文案没有一个能指向下一步动作。 */
function describeOpenError(device: string, error: unknown, platform: NodeJS.Platform): string {
	const code = (error as { code?: string } | null)?.code;
	if (code === "ENOENT") return `${device} does not exist — run \`log ports\`; some systems rename the device on replug`;
	if (code === "EACCES") {
		return platform === "linux"
			? `no permission for ${device} — add yourself to the dialout group (\`sudo usermod -aG dialout $USER\`) and log back in`
			: `no permission for ${device}`;
	}
	if (code === "EBUSY" || code === "EAGAIN") {
		return `${device} is busy — another program holds it (screen / minicom / a vendor GUI). Close that first; this tool cannot take the port away.`;
	}
	return `cannot open ${device}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * 打开并配置串口,返回**给读进程当 stdin 用**的那个 fd(阻塞、O_NOCTTY,见文件头 1 与 4)。
 * Windows 没有可传的 fd,返回 undefined —— 那边由 PowerShell 自己开口。
 *
 * 调用方要在"其余准备工作都做完"之后才调它:这一步之后任何抛错都会漏一个开着的设备。
 */
export function prepareSerial(device: string, baud: number, platform: NodeJS.Platform = process.platform): number | undefined {
	if (platform === "win32") return undefined;

	let configuring: number;
	try {
		configuring = openSync(device, fsConstants.O_RDONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
	} catch (error) {
		throw new Error(describeOpenError(device, error, platform));
	}
	try {
		// 字符设备之外的东西一律回绝:既挡住"把普通文件当串口读",也挡住写错的路径。
		if (!fstatSync(configuring).isCharacterDevice()) {
			throw new Error(`${device} is not a serial device (run \`log ports\` to see what is)`);
		}
		// env 显式传:bun 的 spawnSync 省略 env 时按进程启动那一刻的 PATH 解析 argv[0]。
		const stty = spawnSync("stty", buildSttyArgs(baud), {
			stdio: [configuring, "ignore", "pipe"],
			encoding: "utf8",
			env: process.env,
		});
		if (stty.error) throw new Error(`could not configure ${device}: stty did not run (${String(stty.error)})`);
		if (stty.status !== 0) {
			const detail = (stty.stderr || "").trim() || `stty exited ${stty.status}`;
			throw new Error(`could not configure ${device} for ${baud} baud: ${detail}`);
		}
		// 阻塞式(BSD 的 cat 撞上 EAGAIN 会直接报错退出),而且趁上面那个还开着开它 ——
		// 设备一刻没关过,termios 就不会被复位。
		return openSync(device, fsConstants.O_RDONLY | fsConstants.O_NOCTTY);
	} finally {
		closeSync(configuring);
	}
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/**
 * Windows PowerShell 5.1 是系统自带的(pwsh 不一定装,而且 PowerShell 7 默认不带
 * System.IO.Ports)。用绝对路径而不是靠 PATH —— 见根 CLAUDE.md 里 bun spawn 那条。
 */
function powershellExe(): string {
	const inbox = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(inbox) ? inbox : "powershell.exe";
}

/** -EncodedCommand 收 UTF-16LE 的 base64,于是脚本里的引号和反斜杠不参与命令行解析。 */
export function powershellArgv(script: string): string[] {
	return [
		powershellExe(),
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}

/**
 * 读串口的 PowerShell(导出只为可测)。读原始字节直写 stdout,不让 PowerShell 按
 * 代码页解码一遍;DTR/RTS 拉高是为了对齐 POSIX —— 那边 open 就会拉高,不对齐的话
 * 同一块板子换台机器就"不吐数据"。
 */
export function windowsReaderScript(port: string, baud: number): string {
	return [
		"$ErrorActionPreference='Stop'",
		"$out=[Console]::OpenStandardOutput()",
		"$buf=New-Object byte[] 4096",
		// 构造也放进 try:端口名不合法时 New-Object 就抛,而 PowerShell 自己打的那句
		// 错误会按代码页编码 —— 我们要的是下面 catch 里那条 UTF-8 的。
		"try{",
		`$p=New-Object -TypeName System.IO.Ports.SerialPort -ArgumentList '${port}',${baud},'None',8,'One'`,
		// POSIX 打开串口默认就拉高 DTR/RTS,这里对齐,免得同一块板子换台机器就不吐数据。
		"$p.DtrEnable=$true",
		"$p.RtsEnable=$true",
		"$p.ReadTimeout=-1",
		"$p.Open()",
		"while($true){$n=$p.Read($buf,0,$buf.Length);if($n -le 0){break};$out.Write($buf,0,$n);$out.Flush()}",
		// 打不开时这一句是 Windows 上唯一的诊断,而 .NET 的消息是本地化的 ——
		// 让 PowerShell 自己往 stderr 写就会按代码页编码,于是自己编成 UTF-8 字节。
		"}catch{",
		"$m=[Text.Encoding]::UTF8.GetBytes($_.Exception.Message)",
		"$err=[Console]::OpenStandardError();$err.Write($m,0,$m.Length);$err.Flush();exit 1",
		"}",
	].join("\n");
}

/**
 * 枚举 COM 口。GetPortNames 是准的,友好名只是锦上添花,所以包在 try 里。
 * 同样自己编 UTF-8 字节:友好名在中文 Windows 上是"USB 串行设备 (COM4)",而它恰恰是
 * "哪个口是我的板"的唯一线索,烂成 U+FFFD 就等于没有。
 */
const WINDOWS_LIST_SCRIPT = [
	"$d=@{}",
	"try{Get-CimInstance Win32_PnPEntity -Filter \"Name LIKE '%(COM%'\"|%{if($_.Name -match '\\((COM\\d+)\\)'){$d[$Matches[1]]=$_.Name}}}catch{}",
	'$s=(([System.IO.Ports.SerialPort]::GetPortNames()|Sort-Object|%{"$_`t"+$d[$_]}) -join "`n")',
	"$b=[Text.Encoding]::UTF8.GetBytes($s)",
	"$o=[Console]::OpenStandardOutput();$o.Write($b,0,$b.Length);$o.Flush()",
].join("\n");

// ─── 日志源 ──────────────────────────────────────────────────────────────────

/**
 * 交给 LogCapture 的 argv。POSIX 上是**不带参数**的 cat:设备由 prepareSerial 开好当
 * stdin 传进去,读进程自己绝不 open 那个 tty(理由见文件头第 4 条,这不是风格问题)。
 */
export function serialArgv(device: string, baud: number, platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? powershellArgv(windowsReaderScript(device, baud)) : ["cat"];
}

export function serialLabel(device: string, baud: number): string {
	return `serial ${device} @ ${baud} 8N1`;
}

// ─── 枚举 ────────────────────────────────────────────────────────────────────

/** `名字\t说明` 一行一个 —— Windows 脚本和 Linux by-id 共用这一种形状。 */
export function parsePortLines(stdout: string): SerialPortInfo[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab < 0) return { path: line };
			const description = line.slice(tab + 1).trim();
			return description ? { path: line.slice(0, tab), description } : { path: line.slice(0, tab) };
		});
}

function listDev(keep: (name: string) => boolean): SerialPortInfo[] {
	let names: string[];
	try {
		names = readdirSync("/dev");
	} catch {
		return [];
	}
	return names
		.filter(keep)
		.sort()
		.map((name) => ({ path: `/dev/${name}` }));
}

/**
 * Linux 优先走 /dev/serial/by-id:名字里带厂商/型号/序列号,这是"哪个口是我的板"
 * 唯一能自证的答案,而 ttyUSB0 的编号会随插拔顺序变。
 */
function listLinux(): SerialPortInfo[] {
	const byId = "/dev/serial/by-id";
	let links: string[] = [];
	try {
		links = readdirSync(byId);
	} catch {
		links = [];
	}
	const ports: SerialPortInfo[] = links.sort().map((name) => {
		const link = path.join(byId, name);
		let target = link;
		try {
			target = realpathSync(link);
		} catch {
			// 悬空链接:报 by-id 路径本身,它照样能打开(打不开时的报错也更有信息)。
		}
		return { path: target, description: name };
	});
	// by-id 里只有 USB 设备,而板子也可能接在主机自己的 UART 上(树莓派的 ttyAMA0),
	// 那种口一辈子进不了 by-id —— 只报 by-id 会让人以为它没被识别出来。
	const known = new Set(ports.map((entry) => entry.path));
	return ports.concat(listDev((name) => /^tty(USB|ACM|AMA)\d+$/.test(name)).filter((e) => !known.has(e.path)));
}

/**
 * 这台机器上的串口。**只读枚举,不打开任何设备** —— 与 `flash list` 同一个立场
 * (那边也刻意不抢探针租约)。
 */
export async function listSerialPorts(platform: NodeJS.Platform = process.platform): Promise<SerialPortInfo[]> {
	if (platform === "darwin") return listDev((name) => name.startsWith("cu.") && !DARWIN_NOISE.has(name));
	if (platform !== "win32") return listLinux();

	const argv = powershellArgv(WINDOWS_LIST_SCRIPT);
	const result = await runEngine(argv[0]!, argv.slice(1), { timeoutMs: 30_000 }).catch((error: unknown) => {
		throw new Error(`could not list serial ports: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || `powershell exited ${result.exitCode}`;
		throw new Error(`could not list serial ports: ${detail}`);
	}
	return parsePortLines(result.stdout);
}
