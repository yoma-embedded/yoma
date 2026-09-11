/**
 * 合并预检:底盘 + 供体的富化足迹放一起,把**重叠的事实**在编译前报出来 ——
 * 引脚、外设实例、链接期会重定义的符号、任务优先级、分区表。六环节方法论的
 * "账本预检"(技能文档把它并进环节 3:定底盘供体、合并前先预检)。
 *
 * 报的是重叠,不是裁决:两个例程都挂 I2C1 同一对引脚可能正是共享总线的正确姿势,
 * 也可能是灾难 —— 判断归读报告的模型/人。代码只保证:凡是能从卡片确定性算出的重叠,
 * 一条不漏地列出来;凡是没富化的条目,大声说"预检对它是盲的",绝不拿沉默冒充干净。
 *
 * 纯函数,零 IO —— 读索引与富化在 store.ts,工具层/CLI 负责取数与渲染。
 */

import type { EnrichmentCard } from "./enrich-schema.ts";
import type { ExampleEntry } from "./schema.ts";

export type PreflightRole = "chassis" | "donor";

export interface PreflightInput {
	entry: ExampleEntry;
	/** 没富化就没有卡 —— 该条目进盲区,预检只能对它沉默(并明说)。 */
	card?: EnrichmentCard;
	role: PreflightRole;
}

export type PreflightConflictKind = "ecosystem" | "pin" | "instance" | "symbol" | "task-priority" | "partition";

export interface PreflightConflict {
	kind: PreflightConflictKind;
	/** 人话一句:重叠是什么、谁和谁。 */
	detail: string;
	ids: string[];
}

export interface PreflightReport {
	conflicts: PreflightConflict[];
	/** 没富化的条目 id —— 预检对它们看不见,报告必须带上这份"不知道清单"。 */
	blind: string[];
	/**
	 * 已富化但足迹全空的条目 id —— 与盲区同级的"不知道":纯算法例程属正常,外设例程
	 * 多半是模型没给出足迹(真语料实测出现过),不点名列出就是拿沉默冒充干净。
	 */
	emptyFootprints: string[];
	/** 纪律提醒(不算冲突):供体的入口不合入等。 */
	notes: string[];
}

/**
 * 引脚归一:比对用。GPIO_NUM_4 / IO4 / gpio 4 → GPIO4;pa5 → PA5。
 * 归一只做确定性等价改写,不做猜测(PB1 和 PB01 是否同脚随家族而异,不动)。
 */
export function normalizePin(pin: string): string {
	const flat = pin.toUpperCase().replace(/\s+/g, "");
	const gpioNum = /^GPIO_NUM_(\d+)$/.exec(flat);
	if (gpioNum) return `GPIO${gpioNum[1]}`;
	const io = /^IO(\d+)$/.exec(flat);
	if (io) return `GPIO${io[1]}`;
	return flat;
}

function normalizeInstance(instance: string): string {
	return instance.toUpperCase().replace(/\s+/g, "");
}

function roleLabel(input: PreflightInput): string {
	return input.role === "chassis" ? "底盘" : "供体";
}

function shortId(input: PreflightInput): string {
	return `${roleLabel(input)} ${input.entry.id}`;
}

interface Claim {
	input: PreflightInput;
	/** 展示用的原样值(pin 的 role、符号名……)。 */
	display: string;
}

/** 归一键 → 各来源的占用;同一条目内部重复占用不算(它自己本来就这么跑)。 */
function collectOverlaps(claims: Map<string, Claim[]>): [string, Claim[]][] {
	const out: [string, Claim[]][] = [];
	for (const [key, list] of claims) {
		const byEntry = new Map<string, Claim>();
		for (const claim of list) {
			if (!byEntry.has(claim.input.entry.id)) byEntry.set(claim.input.entry.id, claim);
		}
		if (byEntry.size >= 2) out.push([key, [...byEntry.values()]]);
	}
	out.sort((a, b) => a[0].localeCompare(b[0]));
	return out;
}

function push(claims: Map<string, Claim[]>, key: string, claim: Claim): void {
	const list = claims.get(key);
	if (list) list.push(claim);
	else claims.set(key, [claim]);
}

function isFootprintEmpty(card: EnrichmentCard): boolean {
	const footprint = card.footprint;
	return (
		footprint.pins.length === 0 &&
		footprint.instances.length === 0 &&
		footprint.symbols.length === 0 &&
		footprint.entrySymbols.length === 0 &&
		footprint.tasks.length === 0 &&
		footprint.partitions === undefined
	);
}

export function checkMergeConflicts(inputs: PreflightInput[]): PreflightReport {
	const report: PreflightReport = {
		conflicts: [],
		blind: inputs.filter((input) => !input.card).map((input) => input.entry.id),
		emptyFootprints: inputs.filter((input) => input.card && isFootprintEmpty(input.card)).map((input) => input.entry.id),
		notes: [],
	};

	// 生态混着合并是物理不可能,别的检查都失去意义 —— 报这一条就够了。
	const ecosystems = [...new Set(inputs.map((input) => input.entry.ecosystem))].sort();
	if (ecosystems.length > 1) {
		report.conflicts.push({
			kind: "ecosystem",
			detail: `跨生态合并不成立:${ecosystems.join(" vs ")} —— 换同生态的供体`,
			ids: inputs.map((input) => input.entry.id),
		});
		return report;
	}

	const pins = new Map<string, Claim[]>();
	const instances = new Map<string, Claim[]>();
	const symbols = new Map<string, Claim[]>();
	const priorities = new Map<string, Claim[]>();
	const partitioned: Claim[] = [];

	for (const input of inputs) {
		const card = input.card;
		if (!card) continue;
		for (const pin of card.footprint.pins) {
			push(pins, normalizePin(pin.pin), { input, display: pin.role ?? "角色未标" });
		}
		for (const instance of card.footprint.instances) {
			push(instances, normalizeInstance(instance), { input, display: instance });
		}
		for (const symbol of card.footprint.symbols) {
			push(symbols, symbol.trim(), { input, display: symbol.trim() });
		}
		for (const task of card.footprint.tasks) {
			if (task.priority !== undefined) {
				push(priorities, String(task.priority), { input, display: task.name });
			}
		}
		if (card.footprint.partitions) partitioned.push({ input, display: card.footprint.partitions });
		if (input.role === "donor" && card.footprint.entrySymbols.length > 0) {
			report.notes.push(
				`供体 ${input.entry.id} 的入口 ${card.footprint.entrySymbols.join("/")} 按纪律不合入 —— 只摘初始化与任务体`,
			);
		}
	}

	for (const [pin, claims] of collectOverlaps(pins)) {
		// "角色相同"的宽慰话只在角色**已知**时给:两侧都没标角色时它们的重合是未知量,
		// 不是"相同",按未知从严(审查逮住过)。
		const roles = new Set(claims.map((claim) => claim.display));
		const sameRole = roles.size === 1 && !roles.has("角色未标");
		report.conflicts.push({
			kind: "pin",
			detail:
				`${pin}:${claims.map((claim) => `${shortId(claim.input)}(${claim.display})`).join(" vs ")}` +
				(sameRole ? " —— 角色相同,若是共享总线可接受" : ""),
			ids: claims.map((claim) => claim.input.entry.id),
		});
	}
	for (const [instance, claims] of collectOverlaps(instances)) {
		report.conflicts.push({
			kind: "instance",
			detail: `外设实例 ${instance} 被多方占用:${claims.map((claim) => shortId(claim.input)).join(" vs ")}`,
			ids: claims.map((claim) => claim.input.entry.id),
		});
	}
	for (const [symbol, claims] of collectOverlaps(symbols)) {
		report.conflicts.push({
			kind: "symbol",
			detail: `符号 ${symbol} 多处定义(链接期重定义):${claims.map((claim) => shortId(claim.input)).join(" vs ")} —— 合并时只保留一份或改名`,
			ids: claims.map((claim) => claim.input.entry.id),
		});
	}
	for (const [priority, claims] of collectOverlaps(priorities)) {
		report.conflicts.push({
			kind: "task-priority",
			detail: `任务优先级 ${priority} 撞车:${claims.map((claim) => `${shortId(claim.input)} 的 ${claim.display}`).join(" vs ")} —— 同优先级轮转可能打破各自例程的调度假设`,
			ids: claims.map((claim) => claim.input.entry.id),
		});
	}
	if (partitioned.length >= 2) {
		report.conflicts.push({
			kind: "partition",
			detail: `多方自带分区表/存储布局:${partitioned.map((claim) => `${shortId(claim.input)}(${claim.display})`).join(" vs ")} —— 只能留一份,手工合`,
			ids: partitioned.map((claim) => claim.input.entry.id),
		});
	}

	return report;
}
