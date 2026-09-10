/**
 * la 工具的端到端退役用例 —— 2026-09-10 工具归零时从 test/la.test.ts 拆出来。
 * 不编译、不跑;重写 la 工具时当需求清单读。真跑 engines/bin/yoma-la:
 * import → summary → decode → events/timing/expect,外加 device="demo" 的采集。
 *
 * 夹具的既知真值(engines/logic-analyzer/vendor/demo/logic/protocol.demo,25 MHz × 131072 采样):
 * SDA=D0 154 个边沿、SCL=D1 510 个;I²C 300 条注解 / 6 个事务,首条 `W 0x62 <- 04 ; Sr R 0x62 -> 4F`;
 * UART(D5,115200)47 字节 "DSLogic series USB-based LA from DreamSourceLab",位宽 8.68us;
 * SPI(D12/D13/D14/D15)5 次传输 288 个字。
 *
 * la 的纯模块用例仍在 test/la.test.ts。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { exe } from "../../src/core/engines.ts";
import { type LaToolDetails, createLaToolDefinition } from "../tools/la.ts";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const ENGINES = join(REPO, "engines");
const LA_BIN = join(ENGINES, "bin", exe("yoma-la"));
const DEMO = join(ENGINES, "logic-analyzer", "vendor", "demo", "logic", "protocol.demo");

const HAS_ENGINE = existsSync(DEMO) && existsSync(LA_BIN);

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-la-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

type LaTool = ReturnType<typeof createLaToolDefinition>;

function makeTool(cwd = createTempDir()): { tool: LaTool; cwd: string } {
	const env = new NodeExecutionEnv({ cwd });
	return { tool: createLaToolDefinition(env, { enginesDir: ENGINES }), cwd };
}

async function run(tool: LaTool, params: Record<string, unknown>): Promise<{ text: string; details: LaToolDetails }> {
	const r = await tool.execute("t", params as never, undefined);
	const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
	return { text, details: r.details as LaToolDetails };
}

/** base64 的列位图 → 每列 2bit 的数组(1=全高,2=全低,3=有跳变)。 */
function previewColumns(b64: string): number[] {
	const buf = Buffer.from(b64, "base64");
	const out: number[] = [];
	for (let i = 0; i < buf.length * 4; i++) out.push((buf[i >> 2]! >> ((i & 3) * 2)) & 3);
	return out;
}

describe.skipIf(!HAS_ENGINE)("la 工具端到端(真 yoma-la + demo 夹具)", () => {
	let tool: LaTool;
	let importDetails: LaToolDetails;

	const DECODERS = [
		{ key: "i2c0", id: "1:i2c", channels: { scl: "SCL", sda: "SDA" } },
		{ key: "uart0", id: "1:uart", channels: { rxtx: "UART" }, options: { baudrate: "115200" } },
		{ key: "spi0", id: "1:spi", channels: { clk: "CLK", cs: "CS#", mosi: "MOSI", miso: "MISO" } },
	];

	beforeAll(async () => {
		tool = makeTool().tool;
		const imported = await run(tool, { action: "import", file: DEMO });
		importDetails = imported.details;
		await run(tool, { action: "decode", decoders: DECODERS });
	}, 120_000);

	it("import 注册 .dsl 并给出通道表", async () => {
		expect(importDetails.samplerate).toBe(25_000_000);
		expect(importDetails.samples).toBe(131_072);
		expect(importDetails.channels?.map((c) => c.name).slice(0, 2)).toEqual(["SDA", "SCL"]);
		expect(importDetails.file).toMatch(/capture\.dsl$/);
	});

	it("details 里的预览是 1024 列 × 每通道 256 字节的 base64", () => {
		const preview = importDetails.preview!;
		expect(preview.columns).toBe(1024);
		expect(preview.from).toBe(0);
		expect(preview.to).toBe(131_072);
		expect(Object.keys(preview.rows)).toHaveLength(16);
		for (const [index, b64] of Object.entries(preview.rows)) {
			const buf = Buffer.from(b64, "base64");
			expect(buf.length).toBe(Math.ceil(1024 / 4));
			// 每一列都记了电平,不该有 0
			expect(previewColumns(b64).some((v) => v === 0)).toBe(false);
			expect(Number(index)).toBeGreaterThanOrEqual(0);
		}
	});

	it("summary 报出每通道的边沿数,并给出总线提示", async () => {
		const { text, details } = await run(tool, { action: "summary" });
		expect(text).toContain("D0 SDA            154 edges");
		expect(text).toContain("D1 SCL            510 edges");
		expect(text).toContain("hints:");
		expect(text).toContain("clock-like:");
		const byName = Object.fromEntries((details.channels ?? []).map((c) => [c.name, c.edges]));
		expect(byName.SDA).toBe(154);
		expect(byName.SCL).toBe(510);
	}, 60_000);

	it("decode 三个解码器一次跑完,每个都给聚合摘要", async () => {
		const { tool: fresh } = makeTool();
		await run(fresh, { action: "import", file: DEMO });
		const { text, details } = await run(fresh, { action: "decode", decoders: DECODERS });
		expect(text).toContain("6 txn (12 addr phases, 15 bytes), 0 with issues");
		expect(text).toContain("47 bytes in 3 runs, 0 errors, 0 breaks");
		expect(text).toContain("5 transfers, 288 words");
		const anns = Object.fromEntries((details.decoders ?? []).map((d) => [d.key, d.annotations]));
		expect(anns.i2c0).toBe(300);
		expect(anns.uart0).toBeGreaterThan(0);
		expect(anns.spi0).toBeGreaterThan(0);
	}, 120_000);

	it("events(I²C):首个事务是 W 0x62 <- 04 ; Sr R 0x62 -> 4F", async () => {
		const { text } = await run(tool, { action: "events", decoder: "i2c0" });
		expect(text).toContain("i2c0 TXN#1");
		expect(text).toContain("W 0x62 <- 04 ; Sr R 0x62 -> 4F");
		expect(text).toContain("6 txn (12 addr phases, 15 bytes), 0 with issues");
		expect(text).not.toContain("⚠");
	}, 60_000);

	it("events(UART):47 字节,读得出 DreamSourceLab 那句话", async () => {
		const { text } = await run(tool, { action: "events", decoder: "uart0" });
		expect(text).toContain("47 bytes in 3 runs");
		expect(text).toContain('"DSLogic series U"');
		expect(text).toContain("bit=8.680us");
	}, 60_000);

	it("events(SPI):5 次传输,MOSI/MISO 并排", async () => {
		const { text } = await run(tool, { action: "events", decoder: "spi0" });
		expect(text).toContain("spi0 XFER#1");
		expect(text).toContain("5 transfers, 288 words");
		expect(text).toContain("MOSI 00 11 00 00 79 02");
	}, 60_000);

	it("events 的窗口切在事务中间时,事务仍然是 ok(不是假的 missing STOP)", async () => {
		const { text, details } = await run(tool, { action: "events", decoder: "i2c0", toMs: 2.2 });
		expect(text).toContain("i2c0 TXN#1");
		expect(text).toContain("ok");
		expect(text).not.toContain("missing STOP");
		expect(text).toContain("1 txn (2 addr phases, 2 bytes), 0 with issues");
		expect(details.window).toEqual({ from: 0, to: 55_000 });
	}, 60_000);

	it("timing:SCL 的周期 ≈ 99.60kHz", async () => {
		const { text } = await run(tool, { action: "timing", timingChannels: ["SCL"] });
		expect(text).toContain("D1 SCL        510 edges");
		expect(text).toMatch(/period 10\.0us = 99\.60kHz/);
		expect(text).toContain("duty ");
	}, 60_000);

	it("expect:对上给 MATCH,对不上给第一处分歧", async () => {
		const ok = await run(tool, { action: "expect", decoder: "i2c0", expect: "W 0x62 04\nR 0x62 4F" });
		expect(ok.text).toContain("MATCH 2/2");
		expect(ok.details.issues).toBe(0);

		const bad = await run(tool, { action: "expect", decoder: "i2c0", expect: "W 0x62 05" });
		expect(bad.text).toContain("MISMATCH at #1");
		expect(bad.text).toContain("actual  W 0x62 04");
		expect(bad.details.issues).toBe(1);

		const uart = await run(tool, { action: "expect", decoder: "uart0", expect: '"DSLogic series USB-based LA from DreamSourceLab"' });
		expect(uart.text).toContain("MATCH 47 bytes");
	}, 60_000);

	it("list 列出已注册的采集和它解过的解码器", async () => {
		const { text } = await run(tool, { action: "list" });
		expect(text).toMatch(/1 captures in .*[\\/]\.yoma[\\/]la/);
		expect(text).toContain("131,072 samples @ 25.000MHz");
		expect(text).toContain("import");
		expect(text).toContain("decoded: i2c0,uart0,spi0");
	}, 60_000);

	it("decode 用错通道名时把可选的通道全列出来", async () => {
		await expect(
			run(tool, { action: "decode", decoders: [{ key: "bad", id: "1:i2c", channels: { scl: "SCK", sda: "SDA" } }] }),
		).rejects.toThrow(/bad\.scl="SCK" — no such channel in this capture \(have: D0=SDA D1=SCL/);
	}, 60_000);

	it("没解码就问 events 时,说的是「还没解码」而不是空结果", async () => {
		const { tool: fresh } = makeTool();
		await run(fresh, { action: "import", file: DEMO });
		await expect(run(fresh, { action: "events" })).rejects.toThrow(/is not decoded yet/);
	}, 60_000);

	it("一个采集都没有时,events 让人先去采集", async () => {
		const { tool: fresh } = makeTool();
		await expect(run(fresh, { action: "events" })).rejects.toThrow(/no capture yet/);
	});

	it("stop 在没有武装时也不报错", async () => {
		const { tool: fresh } = makeTool();
		const { text } = await run(fresh, { action: "stop" });
		expect(text).toContain("nothing armed");
	});

	it("采集参数写错时在下子进程之前就拦住", async () => {
		const { tool: fresh } = makeTool();
		await expect(run(fresh, { action: "capture", samples: "lots" })).rejects.toThrow(/write it like "1M" or "200k"/);
		await expect(run(fresh, { action: "capture", samplerate: "quick" })).rejects.toThrow(/write it like "25M" or "500k"/);
		await expect(run(fresh, { action: "capture", trigger: { "1": "up" } })).rejects.toThrow(/use r \/ f \/ c \/ 0 \/ 1 \/ x/);
	});

	it("decoders 给解码器目录(通道名/选项名从这里查,不许猜);list 没采集时指过去", async () => {
		const { tool: fresh } = makeTool();
		const listed = await run(fresh, { action: "list" });
		expect(listed.text).toContain("no captures yet");
		expect(listed.text).toContain("la decoders");
		const { text } = await run(fresh, { action: "decoders" });
		expect(text).toMatch(/^\d+ decoders \(channels; \[optional\]; option=default\)/);
		expect(text).toContain("1:i2c");
		expect(text).toContain("1:uart");
		expect(text).toContain("1:spi");
		const one = await run(fresh, { action: "decoders", decoder: "1:uart" });
		expect(one.text).toContain("rxtx");
		expect(one.text).toContain("baudrate");
	}, 120_000);

	it("arm → collect:先武装再收,收到的和直接 capture 同形状", async () => {
		const { tool: fresh } = makeTool();
		const armed = await run(fresh, { action: "arm", device: "demo", samples: "200k", samplerate: "25M", channels: [{ index: 0, name: "SDA" }, { index: 1, name: "SCL" }] });
		expect(armed.text).toMatch(/^armed la-/);
		expect(armed.details.armed).toBe(true);
		// 武装期间不许再武装
		await expect(run(fresh, { action: "arm", device: "demo" })).rejects.toThrow(/already armed/);
		const got = await run(fresh, { action: "collect" });
		expect(got.details.captureId).toBe(armed.details.captureId);
		expect(got.details.samples).toBeGreaterThan(0);
		expect(got.details.channels?.map((c) => c.name)).toEqual(["SDA", "SCL"]);
		// 收完就不再有武装的了
		const after = await run(fresh, { action: "stop" });
		expect(after.text).toContain("nothing armed");
	}, 180_000);

	it("capture device=demo:采到数据,并且能接着解码", async () => {
		const { tool: fresh } = makeTool();
		const cap = await run(fresh, {
			action: "capture",
			device: "demo",
			samples: "200k",
			samplerate: "25M",
			channels: [{ index: 0, name: "SDA" }, { index: 1, name: "SCL" }],
		});
		expect(cap.text).toContain("capture ");
		expect(cap.text).toContain("channels: D0=SDA D1=SCL");
		expect(cap.details.captureId).toMatch(/^la-\d{8}-\d{9}$/);
		expect(cap.details.samples).toBeGreaterThan(0);
		expect(cap.details.timedOut).toBe(false);
		expect(cap.details.channels?.map((c) => c.name)).toEqual(["SDA", "SCL"]);
		expect(Object.keys(cap.details.preview?.rows ?? {})).toEqual(["0", "1"]);

		const dec = await run(fresh, { action: "decode", decoders: [{ key: "i2c0", id: "1:i2c", channels: { scl: "SCL", sda: "SDA" } }] });
		expect(dec.text).toContain("txn");
		const ev = await run(fresh, { action: "events", decoder: "i2c0" });
		expect(ev.text).toContain("i2c0 TXN#1");
		expect(ev.text).toContain("W 0x62 <- 04");

		const list = await run(fresh, { action: "list" });
		expect(list.text).toContain(cap.details.captureId!);
	}, 180_000);
});
