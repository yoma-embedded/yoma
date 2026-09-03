/**
 * scope 工具层测试:对着假 SCPI 服务器(fixtures/scope/fake-sds.ts,按 SDS824X HD 的实测方言写的)把 11 个
 * 动作全走一遍。核心库(传输 / preamble / 统计 / 驱动)在 scope-core.test.ts 里单测;这里只管工具:
 * 地址记忆、动作编排、落盘布局、给模型的文本、details 的形状。
 *
 * 假机的默认波形是周期 200 源点、±2000 code 的方波;记录 1000 点 @ 2 GSa/s → 周期 100 ns = 10 MHz、占空比 50%。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { type ScopeToolDetails, createScopeToolDefinition } from "../src/index.ts";
import { FakeSds, SCREEN_PNG } from "./fixtures/scope/fake-sds.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-scope-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

type ScopeTool = ReturnType<typeof createScopeToolDefinition>;

function makeTool(cwd = createTempDir()): { tool: ScopeTool; cwd: string } {
	const env = new NodeExecutionEnv({ cwd });
	// idleCloseMs: 0 —— 测试里不要有定时器把连接拔掉;listUsb 空 —— 开发机上插着真机也不能被自动发现
	return { tool: createScopeToolDefinition(env, { idleCloseMs: 0, listUsb: async () => [] }), cwd };
}

interface Ran {
	text: string;
	images: { mimeType: string; data: string }[];
	details: ScopeToolDetails;
}

async function run(tool: ScopeTool, params: Record<string, unknown>): Promise<Ran> {
	const r = await tool.execute("t", params as never, undefined);
	const content = r.content as { type: string; text?: string; data?: string; mimeType?: string }[];
	return {
		text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
		images: content.filter((c) => c.type === "image").map((c) => ({ mimeType: c.mimeType ?? "", data: c.data ?? "" })),
		details: r.details as ScopeToolDetails,
	};
}

describe("scope tool", () => {
	let fake: FakeSds;
	let tool: ScopeTool;
	let cwd: string;

	beforeAll(async () => {
		fake = await FakeSds.start({ recordPoints: 1000, maxPoint: 5_000_000 });
		({ tool, cwd } = makeTool());
	});

	afterAll(async () => {
		await fake.close();
	});

	afterEach(() => {
		fake.clearLog();
		fake.setStatusScript([]);
		fake.status = "Stop";
	});

	it("没有地址、没有记忆、USB 上也没有仪器:报人话,不假装连上", async () => {
		const fresh = makeTool();
		await expect(run(fresh.tool, { action: "status" })).rejects.toThrow(/no instrument address/);
	});

	it("connect:握手、读状态、把地址记进 .yoma/scope.json", async () => {
		const r = await run(tool, { action: "connect", address: fake.address });
		expect(r.text).toContain("connected: Siglent Technologies SDS824X HD");
		expect(r.text).toContain("SN SDS08A0D910802");
		expect(r.text).toContain("C1 ON");
		expect(r.text).toContain("C2 off");
		expect(r.text).toContain("timebase 50 ns/div");
		expect(r.details.model).toBe("SDS824X HD");
		expect(r.details.address).toBe(fake.address);
		expect(r.details.channels).toHaveLength(4);
		const saved = JSON.parse(readFileSync(join(cwd, ".yoma", "scope.json"), "utf8")) as { address: string };
		expect(saved.address).toBe(fake.address);
		expect(fake.log).toContain("*IDN?");
	});

	it("status:不带地址也能用(记忆里有),并且不改仪器", async () => {
		const before = fake.log.length;
		const r = await run(tool, { action: "status" });
		expect(r.text).toContain("trigger EDGE C1");
		expect(r.details.action).toBe("status");
		// 只有查询,没有设置
		expect(fake.log.slice(before).every((c) => c.includes("?"))).toBe(true);
	});

	it("另一个工具实例在同一工程目录里,靠 scope.json 直接连上", async () => {
		const second = makeTool(cwd);
		const r = await run(second.tool, { action: "status" });
		expect(r.details.serial).toBe("SDS08A0D910802");
	});

	it("setup:设了就读回,没有差异时不出 ⚠", async () => {
		const r = await run(tool, {
			action: "setup",
			channels: [{ ch: 1, vdiv: 0.1, probe: 10, coupling: "DC", label: "VBUS" }],
			timebase: { scale: 1e-3 },
			trigger: { source: "C1", level: 0.5, slope: "falling", mode: "normal" },
		});
		expect(r.text).toContain("applied:");
		expect(r.text).not.toContain("⚠");
		expect(r.text).toContain("C1 (VBUS) ON");
		expect(fake.channels[0]!.probe).toBe(10);
		expect(fake.channels[0]!.scale).toBeCloseTo(0.1, 6);
		expect(fake.timebase.scale).toBeCloseTo(1e-3, 9);
		expect(fake.trigger.slope.toUpperCase()).toMatch(/^FALL/);
		expect(r.details.timebase?.scale).toBeCloseTo(1e-3, 9);
		expect(r.details.trigger?.source).toBe("C1");
	}, 10_000);

	it("setup:触发源给了关着的通道 → 仪器落到 LINE,工具把它说出来", async () => {
		const r = await run(tool, { action: "setup", trigger: { source: "C2" } });
		expect(r.text).toContain("⚠");
		expect(r.text).toContain("LINE");
		expect(r.text).toMatch(/turn the channel on/i);
		// 恢复
		await run(tool, { action: "setup", trigger: { source: "C1" } });
	});

	it("setup:什么都没给就报错", async () => {
		await expect(run(tool, { action: "setup" })).rejects.toThrow(/nothing to apply/);
	});

	it("capture(current):读全部开着的通道,落盘,统计对得上方波", async () => {
		const r = await run(tool, { action: "capture" });
		expect(r.text).toMatch(/^capture scope-\d{8}-\d+: 1 channel × 1,000 points/);
		expect(r.text).toContain("C1 (VBUS)");
		expect(r.text).toContain("Vpp");
		expect(r.text).toContain("│"); // 文本示意图
		expect(r.text).toContain("samples on disk");
		const d = r.details;
		expect(d.captureId).toMatch(/^scope-/);
		expect(d.points).toBe(1000);
		expect(d.sampleRate).toBe(2e9);
		expect(d.channels).toHaveLength(1);
		const c1 = d.channels![0]!;
		expect(c1.ch).toBe(1);
		expect(c1.label).toBe("VBUS");
		expect(c1.probe).toBe(10);
		expect(c1.stats?.freq).toBeCloseTo(10e6, -5);
		expect(c1.stats?.duty).toBeCloseTo(0.5, 1);
		expect(c1.stats!.pp).toBeGreaterThan(0);
		// 落盘布局
		const dir = join(cwd, ".yoma", "scope", d.captureId!);
		expect(existsSync(join(dir, "capture.json"))).toBe(true);
		expect(statSync(join(dir, "c1.i16")).size).toBe(2000);
		const meta = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as { channels: { ch: number; codePerDiv: number; probe: number }[]; stride: number };
		expect(meta.stride).toBe(1);
		expect(meta.channels[0]!.codePerDiv).toBe(7680);
		expect(meta.channels[0]!.probe).toBe(10);
		// 五个粘状态全写了,WORD 强制,采完恢复 RUN
		expect(fake.log).toContain(":WAVeform:WIDTh WORD");
		expect(fake.log).toContain(":WAVeform:INTerval 1");
		expect(fake.log.some((c) => /^:TRIGger:RUN$/i.test(c))).toBe(true);
	});

	it("capture:points 是预算 —— 1000 点的记录要 100 点就 stride 10", async () => {
		const r = await run(tool, { action: "capture", points: 100, plot: false });
		expect(r.details.points).toBe(100);
		expect(r.text).toContain("stride 10");
		expect(r.text).not.toContain("│");
		expect(fake.log).toContain(":WAVeform:INTerval 10");
	});

	it("capture:显式 stride 照办,points 只当硬上限", async () => {
		const r = await run(tool, { action: "capture", stride: 4, plot: false });
		expect(r.details.points).toBe(250);
		expect(fake.log).toContain(":WAVeform:INTerval 4");
		// 假机记录只有 1000 点,超不了 2M 的上限;上限的拒绝路径由 core 测试的 readWaveform 覆盖
	});

	it("再次给 address:\"usb\" 这类等价地址不重连;换地址才重连", async () => {
		const before = fake.log.length;
		await run(tool, { action: "status", address: fake.address });
		expect(fake.log.slice(before)).not.toContain("*IDN?");
	});

	it("capture(single):武装、等 Stop、读;等不到就如实说", async () => {
		fake.setStatusScript(["Ready", "Ready", "Stop"]);
		const ok = await run(tool, { action: "capture", mode: "single", points: 200 });
		expect(ok.details.captureId).toBeDefined();
		expect(fake.log.some((c) => /^:TRIGger:MODE SING/i.test(c))).toBe(true);

		fake.setStatusScript(["Ready"]);
		const late = await run(tool, { action: "capture", mode: "single", timeoutMs: 300 });
		expect(late.details.timedOut).toBe(true);
		expect(late.details.captureId).toBeUndefined();
		expect(late.text).toContain("no trigger within");
	});

	it("arm + collect:与 la 同样的套路,先武装再做事再收", async () => {
		await expect(run(tool, { action: "collect" })).rejects.toThrow(/nothing armed/);
		fake.setStatusScript(["Ready"]);
		const armed = await run(tool, { action: "arm", trigger: { source: "C1", level: 0.2, slope: "rising" }, points: 250 });
		expect(armed.text).toContain("armed: single trigger EDGE C1 rising");
		expect(armed.details.armed).toBe(true);
		expect(fake.trigger.mode.toUpperCase()).toMatch(/^SING/);

		// 还没触发:collect 说"还在等",武装状态保留
		const waiting = await run(tool, { action: "collect", timeoutMs: 200 });
		expect(waiting.details.timedOut).toBe(true);
		expect(waiting.details.armed).toBe(true);
		expect(waiting.text).toContain("still waiting");

		fake.setStatusScript(["Stop"]);
		const got = await run(tool, { action: "collect" });
		expect(got.details.captureId).toBeDefined();
		expect(got.details.points).toBe(250);
		expect(got.text).toContain("capture scope-");
		// 收完就不再武装
		await expect(run(tool, { action: "collect" })).rejects.toThrow(/nothing armed/);
	});

	it("measure:走仪器自己的量测槽位;**** 是无值不是错误;repeat 给趋势", async () => {
		await expect(run(tool, { action: "measure" })).rejects.toThrow(/requires items/);
		fake.setMeasureValue(1, "1.000E+03");
		fake.setMeasureValue(2, "2.500E-02");
		fake.setMeasureValue(3, "****");
		const r = await run(tool, {
			action: "measure",
			items: [
				{ type: "FREQ", source: "C1" },
				{ type: "PKPK", source: "C1" },
				{ type: "DUTY", source: "C1" },
			],
		});
		expect(r.text).toContain("FREQ");
		expect(r.text).toContain("1 kHz");
		expect(r.text).toContain("25 mV");
		expect(r.text).toContain("****");
		expect(r.details.measurements).toHaveLength(3);
		expect(r.details.measurements![0]!.value).toBe(1000);
		expect(r.details.measurements![0]!.unit).toBe("Hz");
		expect(r.details.measurements![2]!.value).toBeNull();

		// 假机的值按槽位记,不按类型:PKPK 现在落在 P1
		fake.setMeasureValue(1, "2.500E-02");
		const trend = await run(tool, { action: "measure", items: [{ type: "PKPK", source: "C1" }], repeat: 3, intervalMs: 20 });
		expect(trend.text).toContain("over 3/3 reads");
		expect(trend.details.measurements![0]!.n).toBe(3);
		expect(trend.details.measurements![0]!.min).toBeCloseTo(0.025, 6);
	});

	it("samples:默认最近一次采集,窗口、抽样、边沿、截断", async () => {
		// 假机的记录长度不跟时基走;把时基拨回 50 ns/div,让 1000 点 @ 2 GSa/s 正好铺满 10 格,触发在中央
		await run(tool, { action: "setup", timebase: { scale: 5e-8, delay: 0 } });
		const cap = await run(tool, { action: "capture", points: 1000, plot: false });
		const id = cap.details.captureId!;
		const all = await run(tool, { action: "samples", plot: false });
		expect(all.details.captureId).toBe(id);
		expect(all.text).toContain(`# ${id} C1 (VBUS)`);
		expect(all.text).toContain("every 5 samples"); // 1000 点 / 200 行
		expect(all.details.truncated).toBe(false);

		const few = await run(tool, { action: "samples", limit: 10, every: 1, plot: false });
		expect(few.details.truncated).toBe(true);
		expect(few.text).toContain("showing 10 of 1000 rows");

		// 记录 500 ns,触发在中央:窗口 -0.1..0.1 µs 是 400 点
		const win = await run(tool, { action: "samples", fromUs: -0.1, toUs: 0.1, plot: false });
		expect(win.details.points).toBeGreaterThanOrEqual(399);
		expect(win.details.points).toBeLessThanOrEqual(402);

		const edges = await run(tool, { action: "samples", edges: true, limit: 6 });
		expect(edges.text).toContain("edges at");
		expect(edges.text).toMatch(/↑|↓/);
		expect(edges.text).toContain("50 ns"); // 方波半周期
		expect(edges.details.truncated).toBe(true);

		await expect(run(tool, { action: "samples", channel: 3 })).rejects.toThrow(/has no C3/);
		await expect(run(tool, { action: "samples", capture: "scope-nope" })).rejects.toThrow(/no capture named/);
	});

	it("screenshot:PNG 原样附给模型,并落到 .yoma/scope/screens", async () => {
		const r = await run(tool, { action: "screenshot" });
		expect(r.images).toHaveLength(1);
		expect(r.images[0]!.mimeType).toBe("image/png");
		expect(Buffer.from(r.images[0]!.data, "base64").byteLength).toBe(SCREEN_PNG.byteLength);
		expect(r.details.bytes).toBe(SCREEN_PNG.byteLength);
		expect(r.details.file).toMatch(/\.yoma\/scope\/screens\/\d{8}-\d+\.png$/);
		expect(statSync(r.details.file!).size).toBe(SCREEN_PNG.byteLength);
		expect(r.text).toContain("attached below");
	});

	it("list:采集按新到旧列出,截图目录不算采集", async () => {
		const r = await run(tool, { action: "list" });
		expect(r.text).toMatch(/^\d+ captures in/);
		expect(r.text).toContain("C1(VBUS)");
		expect(r.text).not.toContain("screens");
		const ids = readdirSync(join(cwd, ".yoma", "scope")).filter((n) => n.startsWith("scope-"));
		expect(r.text.match(/scope-\d{8}-\d+/g)?.length).toBe(ids.length);
	});

	it("raw:查询回答案,设置只写,二进制查询拒绝", async () => {
		await expect(run(tool, { action: "raw" })).rejects.toThrow(/requires commands/);
		await expect(run(tool, { action: "raw", commands: [":WAVeform:DATA?"] })).rejects.toThrow(/returns binary/);
		const r = await run(tool, { action: "raw", commands: [":TIMebase:SCALe?", "*CLS", "*IDN?"] });
		expect(r.text).toContain("> :TIMebase:SCALe?\n< ");
		expect(r.text).toContain("> *CLS");
		expect(r.text).toContain("< Siglent Technologies,SDS824X HD");
		expect(r.text).not.toContain("⚠");
	});

	it("list 在没有采集的工程里说没有", async () => {
		const empty = makeTool();
		const r = await run(empty.tool, { action: "list" });
		expect(r.text).toContain("no captures yet");
	});
});
