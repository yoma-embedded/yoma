import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import {
	buildServerArgv,
	classifyEval,
	createGdbToolDefinition,
	elfMachine,
	type GdbToolDetails,
	GdbSession,
	hexToWords,
	parseConnect,
	pickFreePort,
	preferredGdbNames,
	renderBanner,
	resolveGdbPath,
	SERVER_CAPS,
} from "../src/index.ts";

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const openSessions: GdbSession[] = [];
const openTools: Array<{ execute: (id: string, params: any) => Promise<unknown> }> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-gdb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const tool of openTools.splice(0)) await tool.execute("cleanup", { action: "stop" }).catch(() => {});
	for (const session of openSessions.splice(0)) await session.stop().catch(() => {});
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPO = join(import.meta.dir, "..", "..", "..");
const FIXTURE_ELF = join(import.meta.dir, "fixtures", "gdb", "fixture.elf");

function findBin(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

const GDB_BIN = findBin("arm-none-eabi-gdb");
const QEMU_BIN = findBin("qemu-system-arm");
const HAS_E2E = !!GDB_BIN && !!QEMU_BIN && existsSync(FIXTURE_ELF);

/**
 * 假 gdb:说 MI3,并且能按需制造真 gdb 造不出来的病态
 * (乱序、无 token 异步、命令中途 EOF、挂起、裸写 stdout、孤儿孙进程)。
 */
function writeFakeGdb(dir: string): string {
	const file = join(dir, "fake-gdb.mjs");
	writeFileSync(
		file,
		`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
let buf = "";
const out = (s) => process.stdout.write(s);
out('=thread-group-added,id="i1"\\n(gdb) \\n');
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const m = /^(\\d+)(.*)$/.exec(line);
    if (!m) continue;
    const [, token, cmd] = m;
    if (cmd === "-gdb-exit") { out(token + "^exit\\n"); process.exit(0); }
    else if (cmd === "-gdb-show mi-async") out(token + '^done,value="on"\\n(gdb) \\n');
    else if (cmd === "-gdb-show mi-async-broken") out(token + '^done,value="off"\\n(gdb) \\n');
    else if (cmd.startsWith("-gdb-set")) out(token + "^done\\n(gdb) \\n");
    else if (cmd === "-fake-console") out('~"hello "\\n~"world\\\\n"\\n' + token + "^done\\n(gdb) \\n");
    else if (cmd === "-fake-error") out(token + '^error,msg="No symbol \\\\"x\\\\" in current context."\\n(gdb) \\n');
    else if (cmd === "-fake-slow") { /* 永不回复 */ }
    else if (cmd === "-fake-stop") {
      // 真实顺序:异步记录先到,结果记录后到
      out('*stopped,reason="breakpoint-hit",bkptno="2",frame={addr="0x08001a3e",func="ring_push",args=[],file="uart.c",line="37"},thread-id="1"\\n');
      out(token + "^done\\n(gdb) \\n");
    }
    else if (cmd === "-fake-double") out(token + "^running\\n(gdb) \\n" + token + '^error,msg="Command aborted."\\n(gdb) \\n');
    else if (cmd === "-fake-wrong-token") out("99999^done\\n(gdb) \\n" + token + "^done\\n(gdb) \\n");
    else if (cmd === "-fake-foreign") out("r0             0x0                 0\\n" + token + "^done\\n(gdb) \\n");
    else if (cmd === "-fake-chunked") {
      const big = "x".repeat(40000);
      out(token + '^done,value="' + big.slice(0, 10000));
      setTimeout(() => out(big.slice(10000, 25000)), 5);
      setTimeout(() => out(big.slice(25000) + '"\\n(gdb) \\n'), 10);
    }
    else if (cmd.startsWith("-fake-grandchild ")) {
      const pidfile = cmd.slice("-fake-grandchild ".length);
      const kid = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
      writeFileSync(pidfile, String(kid.pid));
      out(token + "^done\\n(gdb) \\n");
    }
    else if (cmd === "-fake-die") process.exit(3);
    else out(token + "^done\\n(gdb) \\n");
  }
});
`,
	);
	return file;
}

function makeSession(dir: string, gdbPath: string): GdbSession {
	const session = new GdbSession({
		gdbPath,
		cwd: dir,
		logFile: join(dir, "s.log"),
		miFile: join(dir, "s.mi"),
		stopsFile: join(dir, "s.jsonl"),
	});
	openSessions.push(session);
	return session;
}

const bunBin = process.execPath;

async function fakeSession(): Promise<{ session: GdbSession; dir: string }> {
	const dir = createTempDir();
	const fake = writeFakeGdb(dir);
	// 用 bun 跑假 gdb:直接给 GdbSession 一个 shell 包装脚本,进程组语义才和真实情况一致。
	const wrapper = join(dir, "fake-gdb.sh");
	writeFileSync(wrapper, `#!/bin/sh\nexec "${bunBin}" "${fake}"\n`);
	execSync(`chmod 0755 ${JSON.stringify(wrapper)}`);
	const session = makeSession(dir, wrapper);
	await session.spawnGdb();
	return { session, dir };
}

// ─── 第一层:纯函数 ──────────────────────────────────────────────────────────

describe("buildServerArgv", () => {
	it("qemu", () => {
		const argv = buildServerArgv({ server: "qemu", port: 4242, machine: "netduinoplus2", elfPath: "/tmp/a.elf" });
		expect(argv).toEqual([
			"qemu-system-arm",
			"-machine",
			"netduinoplus2",
			"-kernel",
			"/tmp/a.elf",
			"-semihosting-config",
			"enable=on,target=native",
			"-nographic",
			"-serial",
			"none",
			"-monitor",
			"none",
			"-S",
			"-gdb",
			"tcp::4242",
		]);
	});

	it("openocd 把每个 config 展开成一个 -f,并把 gdb 端口写死", () => {
		const argv = buildServerArgv({
			server: "openocd",
			port: 3333,
			config: ["interface/stlink.cfg", "target/stm32g4x.cfg"],
		});
		expect(argv).toEqual([
			"openocd",
			"-f",
			"interface/stlink.cfg",
			"-f",
			"target/stm32g4x.cfg",
			"-c",
			"gdb_port 3333",
		]);
	});

	it("jlink / probe-rs", () => {
		expect(buildServerArgv({ server: "jlink", port: 2331, chip: "STM32G431CB" })).toContain("-nogui");
		const probeRs = buildServerArgv({ server: "probe-rs", port: 1337, chip: "STM32G431CB", elfPath: "/tmp/a.elf" });
		expect(probeRs).toEqual(["probe-rs", "gdb", "--chip", "STM32G431CB", "--gdb-connection-string", "127.0.0.1:1337", "/tmp/a.elf"]);
	});

	it("external 不起进程", () => {
		expect(buildServerArgv({ server: "external", port: 3333 })).toEqual([]);
	});

	it("缺参数时的报错要说清楚缺什么", () => {
		expect(() => buildServerArgv({ server: "openocd", port: 1 })).toThrow(/needs config/);
		expect(() => buildServerArgv({ server: "jlink", port: 1 })).toThrow(/needs chip/);
		expect(() => buildServerArgv({ server: "qemu", port: 1 })).toThrow(/needs machine/);
		expect(() => buildServerArgv({ server: "qemu", port: 1, machine: "m" })).toThrow(/needs elfPath/);
	});
});

describe("服务器能力表", () => {
	it("probe-rs 没有软断点也没有观察点(读它的 gdb stub 源码确认过)", () => {
		expect(SERVER_CAPS["probe-rs"].softwareBreakpoints).toBe(false);
		expect(SERVER_CAPS["probe-rs"].watchpoints).toBe("none");
		expect(SERVER_CAPS["probe-rs"].rttWithGdb).toBe(false);
	});

	it("QEMU 的观察点会挂死模拟器,所以标成不支持", () => {
		expect(SERVER_CAPS.qemu.watchpoints).toBe("none");
	});

	it("OpenOCD 的就绪串只认 gdb 那一行 —— 4444/6666 会在目标没连上时先绑好", () => {
		const re = SERVER_CAPS.openocd.readyRe!;
		expect(re.test("Info : Listening on port 3333 for gdb connections")).toBe(true);
		expect(re.test("Info : Listening on port 4444 for telnet connections")).toBe(false);
	});

	it("probe-rs 与 qemu 没有就绪串,只能轮询端口", () => {
		expect(SERVER_CAPS["probe-rs"].readyRe).toBeUndefined();
		expect(SERVER_CAPS.qemu.readyRe).toBeUndefined();
	});
});

describe("classifyEval", () => {
	it("会污染 MI 流的一律拒绝", () => {
		for (const cmd of ["shell ls", "!ls", "pipe info registers | cat", "python print(1)", "set logging on"]) {
			expect(classifyEval(cmd).kind).toBe("blocked");
		}
	});

	it("会接管会话的也拒绝", () => {
		for (const cmd of ["target remote :1234", "file /tmp/a.elf", "detach", "run", "quit"]) {
			expect(classifyEval(cmd).kind).toBe("blocked");
		}
	});

	it("运行控制转发到 exec,而不是拒绝", () => {
		expect(classifyEval("continue")).toEqual({ kind: "reroute", op: "continue" });
		expect(classifyEval("c")).toEqual({ kind: "reroute", op: "continue" });
		expect(classifyEval("si")).toEqual({ kind: "reroute", op: "stepi" });
	});

	it("写目标的要显式 write:true", () => {
		expect(classifyEval("set variable x = 1").kind).toBe("mutating");
		expect(classifyEval("monitor reset halt").kind).toBe("mutating");
		expect(classifyEval("call foo()").kind).toBe("mutating");
		expect(classifyEval("jump *0x100").kind).toBe("mutating");
	});

	it("裸 set 一律拦下 —— gdb 认不出的设置名会被当表达式,静默写目标内存", () => {
		const v = classifyEval("set startup-with-shell off");
		expect(v.kind).toBe("blocked");
		expect(v.kind === "blocked" && v.reason).toContain("EXPRESSION");
	});

	it("只读命令放行", () => {
		for (const cmd of ["p/x *cfg", "info registers", "x/16xw 0x20000000", "bt", "ptype struct foo", "info symbol 0x100"]) {
			expect(classifyEval(cmd).kind).toBe("read");
		}
	});

	it("空命令不放行", () => {
		expect(classifyEval("   ").kind).toBe("blocked");
	});
});

describe("gdb 二进制选择", () => {
	it("从 ELF 头读 e_machine", () => {
		const arm = new Uint8Array(0x14);
		arm.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
		arm[0x12] = 0x28;
		expect(elfMachine(arm)).toBe(0x28);
	});

	it("不是 ELF 就返回 undefined,不猜", () => {
		expect(elfMachine(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
		const notElf = new Uint8Array(0x14);
		expect(elfMachine(notElf)).toBeUndefined();
	});

	it("按架构排候选", () => {
		expect(preferredGdbNames(0x28)[0]).toBe("arm-none-eabi-gdb");
		expect(preferredGdbNames(0xf3)[0]).toContain("riscv");
		expect(preferredGdbNames(undefined)).toEqual(["gdb-multiarch", "gdb"]);
	});

	it("显式路径优先,而且报错绝不指向 engines/build.ts", () => {
		expect(resolveGdbPath(0x28, "/opt/gdb").gdbPath).toBe("/opt/gdb");
		try {
			resolveGdbPath(0x1234);
			// 本机上一定能找到 gdb,所以正常路径也可接受
		} catch (error) {
			expect((error as Error).message).not.toContain("engines/build.ts");
			expect((error as Error).message).toContain("Arm GNU Toolchain");
		}
	});

	it("真 ELF 上认出 ARM", () => {
		if (!existsSync(FIXTURE_ELF)) return;
		const head = readFileSync(FIXTURE_ELF).subarray(0, 0x14);
		expect(elfMachine(new Uint8Array(head))).toBe(0x28);
	});
});

describe("parseConnect / hexToWords", () => {
	it("三种写法都收", () => {
		expect(parseConnect("localhost:3333")).toEqual({ host: "localhost", port: 3333 });
		expect(parseConnect(":1234")).toEqual({ host: "localhost", port: 1234 });
		expect(parseConnect("192.168.1.5:2331")).toEqual({ host: "192.168.1.5", port: 2331 });
	});

	it("坏的写法要报错而不是默默连错地方", () => {
		expect(() => parseConnect("not a port")).toThrow(/could not parse/);
	});

	it("十六进制按小端拼字", () => {
		// 0a000000 140000000 → 10, 20 —— 实测从 .data 段读出来的样子
		expect(hexToWords("0a000000140000001e00000028000000")).toEqual([10, 20, 30, 40]);
		expect(hexToWords("00000041")).toEqual([0x41000000]);
	});
});

describe("renderBanner", () => {
	it("没有会话时也能渲染", () => {
		expect(renderBanner(undefined)).toBe("[gdb no session]");
	});
});

// ─── 第二层:假 gdb ──────────────────────────────────────────────────────────

describe("GdbSession(假 gdb)", () => {
	it("启动握手全部通过,并且回读校验 mi-async", async () => {
		const { session } = await fakeSession();
		await session.hygiene();
		expect(session.running).toBe(true);
	});

	it("收集 console 流并拼成一条输出", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-console");
		expect(r.class).toBe("done");
		expect(r.output).toBe("hello world\n");
	});

	it("^error 不是异常,是数据", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-error");
		expect(r.class).toBe("error");
		expect(r.raw).toContain("No symbol");
	});

	it("异步 *stopped 先于结果记录到达时,waiter 照样命中", async () => {
		const { session } = await fakeSession();
		const waiter = session.expectStop();
		await session.send("-fake-stop");
		const stopped = await waiter;
		expect(stopped?.class).toBe("stopped");
		expect(session.state).toBe("halted");
		expect(session.lastStop?.reason).toBe("breakpoint-hit");
		expect(session.lastStop?.bkptno).toBe("2");
		expect(session.lastStop?.frame?.func).toBe("ring_push");
	});

	it("一个 token 收到两条 ^ 记录时只 resolve 一次,不产生未处理的 rejection", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-double");
		expect(r.class).toBe("running");
		// 第二条被丢弃之后,会话还能继续работать
		const next = await session.send("-fake-console");
		expect(next.output).toBe("hello world\n");
	});

	it("token 对不上的结果记录被丢弃,不会污染下一条命令", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-wrong-token");
		expect(r.class).toBe("done");
	});

	it("非 MI 的裸行不会让解析崩掉", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-foreign");
		expect(r.class).toBe("done");
		const log = readFileSync(join((session as any).options.cwd, "s.log"), "utf8");
		expect(log).toContain("[foreign]");
	});

	it("40000 字符的 record 分三段到达也要还原成一条 —— log.ts 的 4096 强切会把它切碎", async () => {
		const { session } = await fakeSession();
		const r = await session.send("-fake-chunked");
		expect(r.class).toBe("done");
		expect(String((r.results as any)?.value)).toHaveLength(40000);
	});

	it("不回复的命令按超时收场,而不是永远挂着", async () => {
		const { session } = await fakeSession();
		await expect(session.send("-fake-slow", 200)).rejects.toThrow(/did not answer/);
		// 超时之后队列没坏,还能继续发
		expect((await session.send("-fake-console")).output).toBe("hello world\n");
	});

	it("gdb 中途死掉时,在飞的命令被拒绝而不是永远挂着", async () => {
		const { session } = await fakeSession();
		const dead = session.send("-fake-die", 5_000).catch((e: Error) => e.message);
		expect(await dead).toMatch(/gdb (exited|is not running)|did not answer/);
	});

	it("命令严格串行:交叉发出的两条命令各自拿到自己的回复", async () => {
		const { session } = await fakeSession();
		const [a, b] = await Promise.all([session.send("-fake-console"), session.send("-fake-error")]);
		expect(a.output).toBe("hello world\n");
		expect(b.class).toBe("error");
	});

	it("stop 之后杀掉整个进程组 —— 孙进程不能变孤儿", async () => {
		const { session, dir } = await fakeSession();
		const pidfile = join(dir, "kid.pid");
		await session.send(`-fake-grandchild ${pidfile}`);
		const kid = Number(readFileSync(pidfile, "utf8"));
		expect(kid).toBeGreaterThan(0);
		expect(() => process.kill(kid, 0)).not.toThrow();

		await session.stop();
		await new Promise((r) => setTimeout(r, 300));
		expect(() => process.kill(kid, 0)).toThrow();
	});

	it("停止事件逐行落进 stops jsonl —— 自动压缩之后还查得到", async () => {
		const { session, dir } = await fakeSession();
		const waiter = session.expectStop();
		await session.send("-fake-stop");
		await waiter;
		await session.stop();
		const rows = readFileSync(join(dir, "s.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ n: 1, reason: "breakpoint-hit", func: "ring_push", file: "uart.c", line: "37" });
	});
});

// ─── 工具层(冷启动路径不需要任何二进制) ────────────────────────────────────

describe("gdb 工具 — 冷启动", () => {
	function makeTool() {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const tool = createGdbToolDefinition(env, {});
		openTools.push(tool as any);
		return { tool, dir };
	}

	it("没有会话时 status 是数据,不是异常", async () => {
		const { tool } = makeTool();
		const r = await tool.execute("1", { action: "status" });
		expect((r.content[0] as any).text).toContain("no session");
		expect((r.details as GdbToolDetails).state).toBe("no-session");
	});

	it("没有会话时其他动作报错要带上填好的下一步调用", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("1", { action: "eval", command: "p 1" })).rejects.toThrow(/server:"qemu"/);
	});

	it("start 缺 elfPath 时说明为什么非要不可", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("1", { action: "start", server: "qemu", machine: "m" })).rejects.toThrow(
			/needs elfPath/,
		);
	});

	it("同时给 server 和 connect 时不猜,而是说清楚两者选一", async () => {
		const { tool } = makeTool();
		await expect(
			tool.execute("1", { action: "start", server: "openocd", connect: "localhost:3333", elfPath: FIXTURE_ELF }),
		).rejects.toThrow(/Pass server to launch one, or connect alone/);
	});

	it("既没有 server 也没有 connect", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("1", { action: "start", elfPath: FIXTURE_ELF })).rejects.toThrow(/either connect/);
	});

	it("ELF 不存在", async () => {
		const { tool, dir } = makeTool();
		await expect(
			tool.execute("1", { action: "start", server: "qemu", machine: "m", elfPath: join(dir, "nope.elf") }),
		).rejects.toThrow(/ELF file not found/);
	});

	it("stop 在没有会话时也不报错", async () => {
		const { tool } = makeTool();
		const r = await tool.execute("1", { action: "stop" });
		expect((r.content[0] as any).text).toContain("no gdb session");
	});
});

// ─── 第三层:真 gdb + QEMU ───────────────────────────────────────────────────

describe.skipIf(!HAS_E2E)("端到端(QEMU + 真 gdb)", () => {
	// cwd 用夹具目录:真实用法就是在固件工程根目录里跑 agent,DWARF 的编译期路径
	// 正好落在 cwd 底下,源码路径才会被相对化。会话产物写在这里,afterEach 清掉。
	const FIXTURE_DIR = join(import.meta.dir, "fixtures", "gdb");

	afterEach(() => rmSync(join(FIXTURE_DIR, ".my-pi"), { recursive: true, force: true }));

	function makeTool() {
		const env = new NodeExecutionEnv({ cwd: FIXTURE_DIR });
		const tool = createGdbToolDefinition(env, {});
		openTools.push(tool as any);
		return tool;
	}

	const startParams = {
		action: "start" as const,
		server: "qemu" as const,
		machine: "netduinoplus2",
		elfPath: FIXTURE_ELF,
		allowUnverified: true,
	};

	it("attach 之后认出 Cortex-M4,并把探针/RTT 的限制说清楚", async () => {
		const tool = makeTool();
		const r = await tool.execute("1", startParams);
		const text = (r.content[0] as any).text as string;
		expect(text).toContain("Cortex-M4");
		expect(text).toContain("qemu does not support watchpoints");
		expect((r.details as GdbToolDetails).state).toBe("halted");
	}, 30_000);

	it("断点 → continue → 停止报告", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		const br = await tool.execute("2", { action: "break", at: "main" });
		expect((br.content[0] as any).text).toMatch(/breakpoint 1 at 0x[0-9a-f]+/);

		const go = await tool.execute("3", { action: "exec", op: "continue", waitMs: 15_000 });
		const text = (go.content[0] as any).text as string;
		expect(text).toContain("breakpoint-hit");
		// 路径必须相对化:DWARF 里的编译期绝对路径在栈里重复七遍就是几百个白烧的 token
		expect(text).toContain("main.c:");
		expect(text).not.toContain(REPO);
	}, 40_000);

	it("HardFault 自动解码:CFSR、BFAR、MSP/PSP 选择、栈上的 PC", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		await tool.execute("2", { action: "break", at: "main" });
		await tool.execute("3", { action: "exec", op: "continue", waitMs: 15_000 });
		// SC_BADPTR = 6:往未映射的 0xF0000000 写
		await tool.execute("4", { action: "eval", command: "set variable g_scenario = 6", write: true });
		await tool.execute("5", { action: "break", remove: "1" });
		await tool.execute("6", { action: "break", at: "hardfault_report" });
		const fault = await tool.execute("7", { action: "exec", op: "continue", waitMs: 15_000 });
		const text = (fault.content[0] as any).text as string;
		expect(text).toContain("PRECISERR");
		expect(text).toContain("0xf0000000");
		expect(text).toContain("PSP");
		expect(text).toContain("EXC_RETURN=0xfffffffd");
	}, 60_000);

	it("没有断点的 continue 被拦下,理由说清楚不是挂死", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		await expect(tool.execute("2", { action: "exec", op: "continue" })).rejects.toThrow(/no breakpoints/);
	}, 30_000);

	it("start 幂等:再调一次是复用而不是报错(自动压缩之后模型会这么干)", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		const again = await tool.execute("2", startParams);
		expect((again.content[0] as any).text).toContain("already attached");
	}, 30_000);

	it("qemu 上拒绝观察点,并指出替代方案", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		await expect(tool.execute("2", { action: "break", watch: "g_tick_count" })).rejects.toThrow(
			/no watchpoint support/,
		);
	}, 30_000);

	it("单步 count + show 一次调用给出一张表", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		await tool.execute("2", { action: "break", at: "main" });
		await tool.execute("3", { action: "exec", op: "continue", waitMs: 15_000 });
		const stepped = await tool.execute("4", {
			action: "exec",
			op: "next",
			count: 3,
			show: ["g_scenario"],
			waitMs: 10_000,
		});
		const text = (stepped.content[0] as any).text as string;
		expect(text).toContain("steps:");
		expect(text).toContain("g_scenario=");
	}, 40_000);

	it("stop 之后 qemu 和 gdb 都不留下", async () => {
		const tool = makeTool();
		await tool.execute("1", startParams);
		await tool.execute("2", { action: "stop" });
		await new Promise((r) => setTimeout(r, 500));
		const ps = execSync("ps -o command= -A || true", { encoding: "utf8" });
		const strays = ps.split("\n").filter((l) => l.includes("netduinoplus2") && l.includes(FIXTURE_ELF));
		expect(strays).toEqual([]);
	}, 30_000);

	it("端口是内核分配的,两个会话可以并存", async () => {
		const a = await pickFreePort();
		const b = await pickFreePort();
		expect(a).toBeGreaterThan(1024);
		expect(b).toBeGreaterThan(1024);
	});
});
