// 合并预检(preflight.ts + renderPreflightReport)验收:每类重叠一个用例、
// 归一规则、同条目内部重复不算、盲区与纪律提醒、跨生态早退。全部纯函数,零 IO。
import { describe, expect, it } from "bun:test";

import {
	checkMergeConflicts,
	type EnrichmentCard,
	type ExampleEntry,
	normalizePin,
	type PreflightInput,
	renderPreflightReport,
	type ResourceFootprint,
} from "../src/core/examples/index.ts";

function makeEntry(id: string, ecosystem: "esp-idf" | "stm32cube" = "stm32cube"): ExampleEntry {
	return {
		id,
		corpus: "corpus@x",
		ecosystem,
		path: id,
		name: id,
		targets: [],
		peripherals: [],
		buildable: true,
		loc: 100,
		files: 3,
		extractorVersion: 1,
	};
}

function makeCard(footprint?: Partial<ResourceFootprint>): EnrichmentCard {
	return {
		summaryZh: "测试卡",
		capabilities: [],
		footprint: { pins: [], instances: [], symbols: [], entrySymbols: [], tasks: [], ...footprint },
	};
}

function chassis(id: string, footprint?: Partial<ResourceFootprint>): PreflightInput {
	return { entry: makeEntry(id), role: "chassis", card: makeCard(footprint) };
}

function donor(id: string, footprint?: Partial<ResourceFootprint>): PreflightInput {
	return { entry: makeEntry(id), role: "donor", card: makeCard(footprint) };
}

describe("normalizePin", () => {
	it("确定性等价改写:GPIO_NUM_4 / io4 / 空白 → 同一键;不做猜测性改写", () => {
		expect(normalizePin("GPIO_NUM_4")).toBe("GPIO4");
		expect(normalizePin("io4")).toBe("GPIO4");
		expect(normalizePin("gpio 4")).toBe("GPIO4");
		expect(normalizePin(" pa5 ")).toBe("PA5");
		expect(normalizePin("PB01")).toBe("PB01");
	});
});

describe("checkMergeConflicts", () => {
	it("引脚重叠:角色不同报重叠,角色相同附加共享总线提示", () => {
		const report = checkMergeConflicts([
			chassis("a", { pins: [{ pin: "PA5", role: "SPI1_SCK" }, { pin: "PB6", role: "I2C1_SCL" }] }),
			donor("b", { pins: [{ pin: "pa5", role: "TIM2_CH1" }, { pin: "PB6", role: "I2C1_SCL" }] }),
		]);
		expect(report.conflicts).toHaveLength(2);
		const pa5 = report.conflicts.find((conflict) => conflict.detail.startsWith("PA5"));
		expect(pa5?.kind).toBe("pin");
		expect(pa5?.detail).toContain("SPI1_SCK");
		expect(pa5?.detail).toContain("TIM2_CH1");
		expect(pa5?.detail).not.toContain("共享总线");
		const pb6 = report.conflicts.find((conflict) => conflict.detail.startsWith("PB6"));
		expect(pb6?.detail).toContain("角色相同,若是共享总线可接受");
	});

	it("实例/符号重叠:大小写归一,同条目内部重复不算", () => {
		const report = checkMergeConflicts([
			chassis("a", { instances: ["Spi1", "SPI1", "USART2"], symbols: ["HAL_SPI_MspInit"] }),
			donor("b", { instances: ["SPI1"], symbols: ["HAL_SPI_MspInit", "SPI1_IRQHandler"] }),
		]);
		expect(report.conflicts).toHaveLength(2);
		expect(report.conflicts.find((conflict) => conflict.kind === "instance")?.detail).toContain("SPI1");
		const symbol = report.conflicts.find((conflict) => conflict.kind === "symbol");
		expect(symbol?.detail).toContain("HAL_SPI_MspInit");
		expect(symbol?.detail).toContain("链接期重定义");
	});

	it("任务优先级:跨条目同优先级报,单条目内部不报", () => {
		const report = checkMergeConflicts([
			chassis("a", {
				tasks: [
					{ name: "rx", priority: 5 },
					{ name: "tx", priority: 5 },
				],
			}),
			donor("b", { tasks: [{ name: "sensor", priority: 5 }] }),
		]);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0].kind).toBe("task-priority");
		expect(report.conflicts[0].detail).toContain("sensor");
	});

	it("分区表:两方都自带才报", () => {
		const solo = checkMergeConflicts([chassis("a", { partitions: "自定义 csv" }), donor("b")]);
		expect(solo.conflicts).toEqual([]);
		const both = checkMergeConflicts([
			chassis("a", { partitions: "自定义 csv" }),
			donor("b", { partitions: "OTA 双分区" }),
		]);
		expect(both.conflicts.map((conflict) => conflict.kind)).toEqual(["partition"]);
	});

	it("跨生态:单独报一条并早退,别的检查不再跑", () => {
		const report = checkMergeConflicts([
			{ entry: makeEntry("a", "stm32cube"), role: "chassis", card: makeCard({ pins: [{ pin: "PA5" }] }) },
			{ entry: makeEntry("b", "esp-idf"), role: "donor", card: makeCard({ pins: [{ pin: "PA5" }] }) },
		]);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0].kind).toBe("ecosystem");
	});

	it("盲区与纪律提醒:未富化的进 blind;供体带入口给提醒,底盘不给", () => {
		const report = checkMergeConflicts([
			chassis("a", { entrySymbols: ["main"] }),
			donor("b", { entrySymbols: ["main"] }),
			{ entry: makeEntry("c"), role: "donor" },
		]);
		expect(report.blind).toEqual(["c"]);
		expect(report.notes).toHaveLength(1);
		expect(report.notes[0]).toContain("供体 b 的入口 main");
	});

	it("足迹全空的卡不算干净:单独点名,与盲区分开(真语料出现过整块蒸发的卡)", () => {
		const report = checkMergeConflicts([
			chassis("a"),
			donor("b", { pins: [{ pin: "PA5" }] }),
			{ entry: makeEntry("c"), role: "donor" },
		]);
		expect(report.emptyFootprints).toEqual(["a"]);
		expect(report.blind).toEqual(["c"]);
	});

	it("两侧都没标角色 → 重叠照报,但不给'角色相同'的宽慰话", () => {
		const report = checkMergeConflicts([
			chassis("a", { pins: [{ pin: "PA5" }] }),
			donor("b", { pins: [{ pin: "PA5" }] }),
		]);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0].detail).toContain("角色未标");
		expect(report.conflicts[0].detail).not.toContain("共享总线");
	});
});

describe("renderPreflightReport", () => {
	it("有重叠:分类标签 + 盲区 + 足迹为空 + 提醒 + 免责语", () => {
		const inputs = [
			chassis("a", { pins: [{ pin: "PA5", role: "SCK" }], entrySymbols: [] }),
			donor("b", { pins: [{ pin: "PA5", role: "CH1" }] }),
			{ entry: makeEntry("c"), role: "donor" as const },
			donor("d"),
		];
		const text = renderPreflightReport(inputs, checkMergeConflicts(inputs));
		expect(text).toContain("底盘 a");
		expect(text).toContain("富化 3/4");
		expect(text).toContain("- [引脚] PA5");
		expect(text).toContain("盲区(未富化");
		expect(text).toContain("足迹为空(已富化");
		expect(text).toContain("不是完备证明");
	});

	it("无重叠:明说没有发现,免责语仍在", () => {
		const inputs = [chassis("a"), donor("b")];
		const text = renderPreflightReport(inputs, checkMergeConflicts(inputs));
		expect(text).toContain("没有发现足迹重叠");
		expect(text).toContain("不能替代绿点纪律");
	});
});
