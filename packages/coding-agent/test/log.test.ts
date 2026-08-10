import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import {
	buildAttachArgs,
	createLogToolDefinition,
	foldLines,
	LogCapture,
	type LogLine,
	type LogToolDetails,
	renderRows,
	selectForDisplay,
	splitArgv,
	splitChunk,
} from "../src/index.ts";

// ─── 测试脚手架 ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const openCaptures: LogCapture[] = [];
const openTools: Array<{ execute: (id: string, params: any) => Promise<unknown> }> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

/** 假日志源:写成脚本再 spawn,和 engines.test.ts 的假引擎同一套路。 */
function writeSource(dir: string, name: string, script: string): string {
	const file = join(dir, name);
	writeFileSync(file, script);
	chmodSync(file, 0o755);
	return file;
}

afterEach(async () => {
	for (const tool of openTools.splice(0)) {
		try {
			await tool.execute("cleanup", { action: "stop" });
		} catch {
			// 没启动过的工具会抛,忽略。
		}
	}
	for (const capture of openCaptures.splice(0)) await capture.stop();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTool() {
	const cwd = createTempDir();
	const env = new NodeExecutionEnv({ cwd });
	const tool = createLogToolDefinition(env);
	openTools.push(tool as any);
	return { tool, cwd };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function detailsOf(result: { details: unknown }): LogToolDetails {
	return result.details as LogToolDetails;
}

/** status 不动游标,所以可以拿它做"行到齐了没"的轮询同步。 */
async function waitForLines(tool: ReturnType<typeof makeTool>["tool"], count: number, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await tool.execute("poll", { action: "status" });
		if (detailsOf(status).totalLines >= count) return;
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${count} lines`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out waiting for condition");
}

function line(seq: number, text: string, t = seq * 10): LogLine {
	return { seq, t, text };
}

/** 互不相同、又不含数字的行 —— 数字会被折叠规则合并,那不是这些用例要测的。 */
function distinct(i: number): string {
	return `evt ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + (i % 7))}`;
}

// 假源:立刻两行启动信息,0.2s 后一条 HardFault,然后退出。
const BOOT_THEN_FAULT = `#!/bin/sh
echo "[boot] STM32F407VG @ 168 MHz"
echo "[boot] HAL init ok"
sleep 0.2
echo "[halt] HardFault - SIGTRAP (imu.c:192)"
`;

const THREE_LINES_THEN_WAIT = `#!/bin/sh
echo "line one"
echo "line two"
echo "line three"
sleep 5
`;

const ALIVE_FOREVER = `#!/bin/sh
echo "alive"
sleep 30
`;

/** 40 行互不相同、不含数字的输出。 */
const FORTY_DISTINCT = `#!/bin/sh
for w in alpha bravo charlie delta echo foxtrot golf hotel india juliet; do
  for x in one two three four; do echo "$w $x"; done
done
sleep 5
`;

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("splitChunk", () => {
	it("emits complete lines and keeps the partial tail as pending", () => {
		const first = splitChunk("", "abc\ndef");
		expect(first.lines).toEqual(["abc"]);
		expect(first.pending).toBe("def");
		const second = splitChunk(first.pending, "ghi\n");
		expect(second.lines).toEqual(["defghi"]);
		expect(second.pending).toBe("");
	});

	it("normalizes CRLF and lone CR", () => {
		expect(splitChunk("", "a\r\nb\rc\n").lines).toEqual(["a", "b", "c"]);
	});

	it("strips ANSI escapes and control characters", () => {
		expect(splitChunk("", "\x1b[31mred\x1b[0m text\n").lines).toEqual(["red text"]);
	});

	it("force-splits a line that never ends so pending cannot grow without bound", () => {
		const result = splitChunk("", "x".repeat(25), 10);
		expect(result.lines).toEqual(["x".repeat(10), "x".repeat(10)]);
		expect(result.pending).toBe("xxxxx");
	});
});

describe("splitArgv", () => {
	it("splits on whitespace", () => {
		expect(splitArgv("probe-rs attach --chip STM32F405RG")).toEqual(["probe-rs", "attach", "--chip", "STM32F405RG"]);
	});

	it("keeps quoted arguments together", () => {
		expect(splitArgv(`sh -c "stty -f /dev/cu.usb 115200 raw && cat /dev/cu.usb"`)).toEqual([
			"sh",
			"-c",
			"stty -f /dev/cu.usb 115200 raw && cat /dev/cu.usb",
		]);
		expect(splitArgv(`a 'b c' d`)).toEqual(["a", "b c", "d"]);
	});

	it("keeps an empty quoted argument", () => {
		expect(splitArgv(`a "" b`)).toEqual(["a", "", "b"]);
	});

	it("throws on an unbalanced quote", () => {
		expect(() => splitArgv(`sh -c "oops`)).toThrow(/unbalanced/);
	});
});

describe("buildAttachArgs", () => {
	it("builds the RTT attach argv with the ELF as a positional", () => {
		expect(buildAttachArgs({ chip: "STM32F405RG", elfPath: "/w/fw.elf" })).toEqual([
			"attach",
			"/w/fw.elf",
			"--chip",
			"STM32F405RG",
			"--non-interactive",
			"--no-timestamps",
		]);
	});

	it("appends probe selection and memory scanning", () => {
		expect(buildAttachArgs({ chip: "C", elfPath: "/w/fw.elf", probe: "0483:374B", scanMemory: true })).toEqual([
			"attach",
			"/w/fw.elf",
			"--chip",
			"C",
			"--non-interactive",
			"--no-timestamps",
			"--probe",
			"0483:374B",
			"--rtt-scan-memory",
		]);
	});

	it("throws when chip or elfPath is missing", () => {
		expect(() => buildAttachArgs({ elfPath: "/w/fw.elf" })).toThrow(/requires chip/);
		expect(() => buildAttachArgs({ chip: "C" })).toThrow(/requires elfPath/);
	});
});

describe("foldLines", () => {
	it("folds consecutive identical lines and records the last timestamp", () => {
		const rows = foldLines([line(0, "NACK"), line(1, "NACK"), line(2, "NACK"), line(3, "ok")]);
		expect(rows.map((row) => [row.line.text, row.count])).toEqual([
			["NACK", 3],
			["ok", 1],
		]);
		expect(rows[0]!.lastT).toBe(20);
		expect(rows[0]!.lastText).toBeUndefined();
	});

	it("folds lines that differ only in numbers and keeps the last variant", () => {
		const rows = foldLines([
			line(0, "[imu] s=0423 ax=128 az=8192"),
			line(1, "[imu] s=0424 ax=131 az=8190"),
			line(2, "[imu] s=0425 ax=32767 az=32767"),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.count).toBe(3);
		// 首行给形状,末行给漂移/饱和 —— 中间的原值在日志文件里。
		expect(rows[0]!.line.text).toBe("[imu] s=0423 ax=128 az=8192");
		expect(rows[0]!.lastText).toBe("[imu] s=0425 ax=32767 az=32767");
	});

	it("does not fold across a different line", () => {
		expect(foldLines([line(0, "a"), line(1, "b"), line(2, "a")]).length).toBe(3);
	});

	it("does not fold stdout into stderr", () => {
		const rows = foldLines([line(0, "same"), { seq: 1, t: 10, text: "same", err: true }]);
		expect(rows).toHaveLength(2);
	});
});

describe("selectForDisplay", () => {
	it("returns everything when it fits the budget", () => {
		const rows = foldLines([line(0, "a"), line(1, "b")]);
		const selected = selectForDisplay(rows, 10);
		expect(selected.omittedLines).toBe(0);
		expect(selected.rows).toHaveLength(2);
	});

	it("keeps the head, the flagged middle and the tail when over budget", () => {
		const lines: LogLine[] = [];
		for (let i = 0; i < 100; i++) lines.push(line(i, i === 50 ? "HardFault at pc 0x800" : distinct(i)));
		const selected = selectForDisplay(foldLines(lines), 20);

		// 头 → (断裂) → 命中行 → (断裂) → 尾:恰好用满 20 行预算,外加两条省略标记。
		expect(selected.rows.filter((row) => row.type === "line")).toHaveLength(20);
		expect(selected.rows.filter((row) => row.type === "gap")).toHaveLength(2);
		expect(selected.omittedLines).toBe(80);

		const texts = selected.rows.flatMap((row) => (row.type === "line" ? [row.row.line.text] : []));
		expect(texts[0]).toBe(distinct(0)); // 头:启动信息
		expect(texts).toContain("HardFault at pc 0x800"); // 中:要紧的行被捞出来
		expect(texts[texts.length - 1]).toBe(distinct(99)); // 尾:最新状态
	});

	it("counts omitted raw lines, not folded groups", () => {
		const lines: LogLine[] = [];
		// 中间夹一段 50 行的刷屏(折叠成 1 组),两头是各不相同的行。
		for (let i = 0; i < 10; i++) lines.push(line(i, distinct(i)));
		for (let i = 10; i < 60; i++) lines.push(line(i, "NACK @ 0x68"));
		for (let i = 60; i < 70; i++) lines.push(line(i, distinct(i)));
		const selected = selectForDisplay(foldLines(lines), 5);
		const gaps = selected.rows.filter((row) => row.type === "gap") as Array<{ type: "gap"; count: number }>;
		expect(gaps).toHaveLength(1);
		// 省略的是 50 条 NACK + 若干独立行 —— 报的必须是原始行数,不是组数。
		expect(gaps[0]!.count).toBeGreaterThanOrEqual(50);
		expect(selected.omittedLines).toBe(gaps[0]!.count);
	});

	it("bounds characters as well as rows so one 4 KB line cannot flood the excerpt", () => {
		const lines: LogLine[] = [];
		for (let i = 0; i < 50; i++) lines.push(line(i, `${distinct(i)} ${"x".repeat(4000)}`));
		const selected = selectForDisplay(foldLines(lines), 50, 2000);
		const text = renderRows(selected.rows);
		expect(text.length).toBeLessThan(2000 + 200); // 只超出一条省略标记的量
		expect(text).toContain("full line in the log file"); // 单行也被裁剪了
		expect(selected.omittedLines).toBeGreaterThan(0);
	});

	it("gives a tiny budget entirely to the newest rows", () => {
		const lines: LogLine[] = [];
		for (let i = 0; i < 30; i++) lines.push(line(i, distinct(i)));
		const selected = selectForDisplay(foldLines(lines), 2);
		const texts = selected.rows.flatMap((row) => (row.type === "line" ? [row.row.line.text] : []));
		expect(texts).toEqual([distinct(28), distinct(29)]);
	});
});

describe("renderRows", () => {
	it("renders timestamps, fold counts, gaps and the match marker", () => {
		const rows = foldLines([line(0, "boot", 4), line(1, "boot", 8), line(2, "fault", 12)]);
		const text = renderRows([
			{ type: "line", row: rows[0]! },
			{ type: "gap", count: 7 },
			{ type: "line", row: rows[1]!, marked: true },
		]);
		expect(text).toBe(
			[
				"[+0.004] boot ×2 (last +0.008)",
				"… 7 lines omitted (grep the full log for them) …",
				"[+0.012] fault   ← match",
			].join("\n"),
		);
	});

	it("marks stderr lines", () => {
		const rows = foldLines([{ seq: 0, t: 5, text: "Error: no probe found", err: true }]);
		expect(renderRows([{ type: "line", row: rows[0]! }])).toBe("[+0.005] ! Error: no probe found");
	});

	// 嵌入式串口上文本日志天然跟在二进制帧后面,于是命中点常常在行尾。从行首裁就会把命中
	// 的那一段裁掉 —— wait 一边断言"匹配了"、一边一个字的证据都不给,而这个工具自己的规矩
	// 是"没有日志行证明就别说固件打印过"。实测在真板子上撞到过:B-G431B-ESC1 波形帧刷屏
	// 时复位,命中行 491 字符、"initialized" 落在第 467 位,而上限是 400。
	it("超长行按命中点开窗裁,不是从行首裁", () => {
		const noise = "U�".repeat(233);
		const rows = foldLines([{ seq: 0, t: 4, text: `${noise}Debug system initialized` }]);
		const windowed = renderRows([{ type: "line", row: rows[0]!, marked: true, matchAt: noise.length }]);
		expect(windowed).toContain("Debug system initialized");
		expect(windowed).toContain("chars before");
		expect(windowed).toContain("← match");

		// 没有命中点时行为一个字都没变:从行首裁,尾巴指向日志文件。
		const fromHead = renderRows([{ type: "line", row: rows[0]! }]);
		expect(fromHead).not.toContain("Debug system initialized");
		expect(fromHead).toContain("chars, full line in the log file");
	});
});

// ─── 采集器 ──────────────────────────────────────────────────────────────────

describe("LogCapture", () => {
	it("drops the oldest lines from the ring buffer but keeps them all in the file", async () => {
		const dir = createTempDir();
		const source = writeSource(dir, "five.sh", `#!/bin/sh\nfor w in one two three four five; do echo "line $w"; done\n`);
		const file = join(dir, "hw.log");
		const capture = new LogCapture([source], "five", file, dir, { maxBufferLines: 3 });
		openCaptures.push(capture);
		await capture.start();
		await waitFor(() => capture.totalLines >= 5 && !!capture.exited);

		expect(capture.totalLines).toBe(5);
		expect(capture.lines).toHaveLength(3);
		expect(capture.dropped).toBe(2);
		expect(capture.lines[0]!.text).toBe("line three");

		await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().split("\n").length >= 5);
		const written = readFileSync(file, "utf8").trim().split("\n");
		expect(written).toHaveLength(5);
		expect(written[0]).toMatch(/^\[\+\d+\.\d{3}\] line one$/);
		expect(written[4]).toContain("line five");
	});

	it("reports a line that never got a newline before the source exited", async () => {
		const dir = createTempDir();
		const source = writeSource(dir, "partial.sh", `#!/bin/sh\nprintf "no trailing newline"\n`);
		const capture = new LogCapture([source], "partial", join(dir, "hw.log"), dir);
		openCaptures.push(capture);
		await capture.start();
		await waitFor(() => !!capture.exited && capture.totalLines >= 1);
		expect(capture.lines[0]!.text).toBe("no trailing newline");
	});

	it("kills the whole process group, not just the shell that forked the reader", async () => {
		const dir = createTempDir();
		const pidFile = join(dir, "grandchild.pid");
		const grandchild = writeSource(
			dir,
			"grandchild.sh",
			`#!/bin/sh\necho $$ > ${pidFile}\nwhile true; do echo tick; sleep 1; done\n`,
		);
		// `A && B` 会让 sh fork 出一个孙子进程 —— 真正握着设备的就是它。
		const capture = new LogCapture(["/bin/sh", "-c", `echo up && ${grandchild}`], "shell", join(dir, "hw.log"), dir);
		openCaptures.push(capture);
		await capture.start();
		await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0);
		const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(grandchildPid).toBeGreaterThan(0);
		expect(grandchildPid).not.toBe(capture.pid);

		await capture.stop();
		await waitFor(() => {
			try {
				process.kill(grandchildPid, 0);
				return false;
			} catch {
				return true; // 已经没了
			}
		}, 3000);
	});

	it("stops appending to the buffer once the capture is finished", async () => {
		const dir = createTempDir();
		const source = writeSource(dir, "chatty.sh", `#!/bin/sh\nwhile true; do echo noise; sleep 0.02; done\n`);
		const capture = new LogCapture([source], "chatty", join(dir, "hw.log"), dir);
		openCaptures.push(capture);
		await capture.start();
		await waitFor(() => capture.totalLines >= 2);

		await capture.stop();
		const settled = capture.totalLines;
		await Bun.sleep(200);
		expect(capture.totalLines).toBe(settled);
	});

	it("never keeps the process alive on its own", async () => {
		// 高危回归:采集中的子进程和它的管道如果不 unref,ACP 退出时 my-pi 不肯死。
		const dir = createTempDir();
		const source = writeSource(dir, "forever.sh", `#!/bin/sh\nwhile true; do echo tick; sleep 1; done\n`);
		const script = writeSource(
			dir,
			"pin-check.ts",
			`import { LogCapture } from ${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))};
const capture = new LogCapture([${JSON.stringify(source)}], "forever", ${JSON.stringify(join(dir, "pin.log"))}, ${JSON.stringify(dir)});
await capture.start();
// 故意不 stop:进程必须靠自己退出(退出钩子会把子进程收掉)。
`,
		);
		const child = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "ignore" });
		const exited = await Promise.race([child.exited, Bun.sleep(6000).then(() => "timeout" as const)]);
		if (exited === "timeout") child.kill("SIGKILL");
		expect(exited).not.toBe("timeout");
	}, 15000);
});

// ─── 工具的五个动作 ──────────────────────────────────────────────────────────

describe("log tool", () => {
	it("start reports the log file and status/stop round-trip", async () => {
		const { tool, cwd } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "alive.sh", ALIVE_FOREVER);

		const started = await tool.execute("c1", { action: "start", command: source });
		expect(textOf(started)).toContain("Capturing");
		expect(textOf(started)).toContain(join(cwd, ".my-pi", "logs"));
		expect(detailsOf(started).running).toBe(true);

		await waitForLines(tool, 1);
		const status = await tool.execute("c2", { action: "status" });
		expect(textOf(status)).toContain("source: running");
		expect(textOf(status)).toContain("last line: [+");
		expect(textOf(status)).toContain("alive");

		const start = Date.now();
		const stopped = await tool.execute("c3", { action: "stop" });
		expect(Date.now() - start).toBeLessThan(4000); // SIGTERM 就该收工,不用等 sleep 30
		expect(textOf(stopped)).toContain("stopped");
		expect(textOf(stopped)).not.toContain("did not confirm exit");
		expect(detailsOf(stopped).running).toBe(false);
	});

	it("wait returns the matched line with context and advances the cursor", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "boot.sh", BOOT_THEN_FAULT);

		await tool.execute("c1", { action: "start", command: source });
		const waited = await tool.execute("c2", { action: "wait", pattern: "hardfault", timeoutMs: 3000 });
		const text = textOf(waited);
		expect(text).toContain("matched /hardfault/");
		expect(text).toContain("← match");
		expect(text).toContain("HAL init ok"); // 命中行前面的上下文
		expect(detailsOf(waited).matched).toBe(true);
		expect(detailsOf(waited).cursor).toBeGreaterThan(0);
	});

	it("keeps context around a match even after the earlier lines were already read", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "boot.sh", BOOT_THEN_FAULT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 2);
		await tool.execute("c2", { action: "read" }); // 把启动那两行消费掉
		const waited = await tool.execute("c3", { action: "wait", pattern: "hardfault", timeoutMs: 3000 });
		// 上下文取自整个缓冲,不是只取未读窗口 —— 否则命中行会是一条没有来龙去脉的孤行。
		expect(textOf(waited)).toContain("HAL init ok");
	});

	it("wait matches a line that arrived before it was called", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "early.sh", THREE_LINES_THEN_WAIT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 3);
		const waited = await tool.execute("c2", { action: "wait", pattern: "line two", timeoutMs: 500 });
		expect(detailsOf(waited).matched).toBe(true);
	});

	it("wait times out with a preview and without consuming the evidence", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "forty.sh", FORTY_DISTINCT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 40);
		const started = Date.now();
		const waited = await tool.execute("c2", { action: "wait", pattern: "never-appears", timeoutMs: 300 });
		expect(Date.now() - started).toBeLessThan(3000);
		const text = textOf(waited);
		expect(text).toContain("timed out after 300 ms");
		expect(text).toContain("cursor unchanged");
		expect(detailsOf(waited).matched).toBe(false);
		expect(detailsOf(waited).cursor).toBe(0);

		// 没命中就不消费:40 行原封不动还在,read 照样能拿到。
		const read = await tool.execute("c3", { action: "read" });
		expect(textOf(read)).toContain("+40 new lines since seq 0");
	});

	it("wait comes back as soon as the source exits without matching", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "die.sh", `#!/bin/sh\necho "starting"\nexit 3\n`);

		await tool.execute("c1", { action: "start", command: source });
		const waited = await tool.execute("c2", { action: "wait", pattern: "boot ok", timeoutMs: 5000 });
		const text = textOf(waited);
		expect(text).toContain("source exited (code 3)");
		expect(text).toContain("starting");
		expect(detailsOf(waited).matched).toBe(false);
		expect(detailsOf(waited).exitCode).toBe(3);
	});

	it("still matches a line printed just before the source exits", async () => {
		// 'exit' 可能先于最后一段 stdout 到达 —— 那样会把"命中"误报成"源退出了"。
		// 跑几轮,任何一轮报 exited 都算回归。
		for (let attempt = 0; attempt < 5; attempt++) {
			const { tool } = makeTool();
			const dir = createTempDir();
			const source = writeSource(dir, "late.sh", `#!/bin/sh\nsleep 0.1\necho "BOOT OK"\n`);
			await tool.execute("c1", { action: "start", command: source });
			const waited = await tool.execute("c2", { action: "wait", pattern: "BOOT OK", timeoutMs: 4000 });
			expect(textOf(waited)).toContain("matched /BOOT OK/");
			expect(detailsOf(waited).matched).toBe(true);
		}
	}, 30000);

	it("read gives the increment since the cursor and then reports nothing new", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "three.sh", THREE_LINES_THEN_WAIT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 3);

		const first = await tool.execute("c2", { action: "read" });
		expect(textOf(first)).toContain("+3 new lines since seq 0");
		expect(textOf(first)).toContain("line three");
		expect(detailsOf(first).cursor).toBe(3);

		const second = await tool.execute("c3", { action: "read" });
		expect(textOf(second)).toContain("no new lines since seq 3");
	});

	it("read with a pattern filters without consuming the cursor", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "three.sh", THREE_LINES_THEN_WAIT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 3);

		const filtered = await tool.execute("c2", { action: "read", pattern: "two" });
		expect(textOf(filtered)).toContain("1 of 3 lines since seq 0 match /two/");
		expect(textOf(filtered)).toContain("line two");
		expect(textOf(filtered)).not.toContain("line three");
		expect(detailsOf(filtered).cursor).toBe(0); // 查询不推游标

		const plain = await tool.execute("c3", { action: "read" });
		expect(textOf(plain)).toContain("+3 new lines since seq 0");
	});

	it("caps the excerpt and points at the full log instead", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "forty.sh", FORTY_DISTINCT);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 40);
		const read = await tool.execute("c2", { action: "read", maxLines: 10 });
		const text = textOf(read);
		expect(text).toContain("+40 new lines since seq 0");
		expect(text).toContain("lines omitted from this excerpt");
		expect(text).toContain("full log: ");
		// 骨架采样:预算 10 行 + 省略标记,绝不是 40 行倒进上下文。
		expect(text.split("\n").filter((row) => row.startsWith("[+"))).toHaveLength(10);
	});

	it("folds a chatty sensor loop instead of dumping every line", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(
			dir,
			"imu.sh",
			`#!/bin/sh\ni=0\nwhile [ $i -lt 60 ]; do echo "[imu] s=$i ax=128 az=8192"; i=$((i+1)); done\nsleep 5\n`,
		);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 60);
		const read = await tool.execute("c2", { action: "read" });
		const text = textOf(read);
		expect(text).toContain("+60 new lines since seq 0 (folded to 1 groups)");
		expect(text).toContain("×60 (numbers vary; last");
		expect(text.split("\n").filter((row) => row.startsWith("[+"))).toHaveLength(1);
		expect(text.length).toBeLessThan(500);
	});

	it("bounds a single read even when every line is 4 KB", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(
			dir,
			"fat.sh",
			`#!/bin/sh\npad=$(printf 'x%.0s' $(seq 1 4000))\nfor w in alpha bravo charlie delta echo foxtrot golf hotel; do echo "$w $pad"; done\nsleep 5\n`,
		);

		await tool.execute("c1", { action: "start", command: source });
		await waitForLines(tool, 8);
		const read = await tool.execute("c2", { action: "read", maxLines: 500 });
		const text = textOf(read);
		expect(text.length).toBeLessThan(24_000 + 1000);
		expect(text).toContain("full line in the log file");
	});

	it("refuses a second start while one is running", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "alive.sh", ALIVE_FOREVER);

		await tool.execute("c1", { action: "start", command: source });
		await expect(tool.execute("c2", { action: "start", command: source })).rejects.toThrow(/already capturing/);
	});

	it("tells the model to start a capture before reading", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("c1", { action: "read" })).rejects.toThrow(/no log capture/);
		await expect(tool.execute("c2", { action: "wait", pattern: "x" })).rejects.toThrow(/no log capture/);
		await expect(tool.execute("c3", { action: "status" })).rejects.toThrow(/no log capture/);
	});

	it("reports a source that cannot be spawned", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("c1", { action: "start", command: "/no/such/log-source" })).rejects.toThrow(
			/failed to start log source/,
		);
	});

	it("requires a pattern for wait and rejects an invalid regex", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "alive.sh", ALIVE_FOREVER);
		await tool.execute("c1", { action: "start", command: source });

		await expect(tool.execute("c2", { action: "wait" })).rejects.toThrow(/requires pattern/);
		await expect(tool.execute("c3", { action: "wait", pattern: "([unclosed" })).rejects.toThrow(/invalid pattern/);
	});

	it("streams the tail to onUpdate while waiting", async () => {
		const { tool } = makeTool();
		const dir = createTempDir();
		const source = writeSource(dir, "boot.sh", BOOT_THEN_FAULT);
		const updates: string[] = [];

		await tool.execute("c1", { action: "start", command: source });
		await tool.execute(
			"c2",
			{ action: "wait", pattern: "hardfault", timeoutMs: 3000 },
			undefined,
			(partial: { content: Array<{ type: string; text?: string }> }) => {
				updates.push(textOf(partial));
			},
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) expect(update.length).toBeLessThan(4_500);
	});
});
