/**
 * 波形上的纯计算:统计、边沿、文本示意图。全部在 code 域上做(整型,快),最后一步才换算成伏。
 * 没有 DOM、没有 IO;工具与测试共用。
 *
 * 阈值与电平的取法(2026-09-16 按 ngscopeclient 的测量滤波器修正,BSD-3,见 NOTICE):
 *  - 高/低稳态电平 base/top 用直方图众数(最低四分之一与最高四分之一各取一个峰),不用 min/max:
 *    有过冲的方波用 min/max 当 10%/90% 参考会把 90% 线抬到稳态顶之上,上升时间系统性偏长甚至丢边沿。
 *    三角波、噪声这类分布平坦的信号直方图不尖,退回 min/max;正弦两端也是尖的(反正弦分布),给出的是
 *    "停留最久的电平",略小于幅值,作参考电平够用。
 *  - 边沿在**阈值**处插值,不在滞回带被穿越的那个样本处:滞回只用来防抖,位置要回退到真正夹住阈值的样本对,
 *    否则过渡跨多个样本时整条边沿偏晚一个滞回宽度,频率抵消、占空比不抵消。
 *  - 频率过一致性门之后按"首末上升沿跨度 / 间隔数"算,整段平均;中位数只做门,不做估计器。
 */
import { codeToVolts, type TimeScale, type VoltScale, timeOfIndex } from "./preamble.ts";

export interface WaveStats {
	min: number;
	max: number;
	pp: number;
	mean: number;
	rms: number;
	/** 去掉直流后的 RMS(纹波/噪声大小) */
	acRms: number;
	/** 直方图众数给出的停留最久的高/低电平;分布平坦的信号(三角、噪声)没有 */
	top?: number;
	base?: number;
	/** max − top、base − min;只在有 top/base 时给 */
	overshoot?: number;
	undershoot?: number;
	/** 中值穿越的频率估计;至少 3 个完整周期且间隔足够一致,不证明信号周期性 */
	freq?: number;
	period?: number;
	/** 高电平占比估计 0..1;只在周期一致性检查通过时给出 */
	duty?: number;
	/** 10%–90% 上升/下降时间(s),参考电平是 base/top(没有就 min/max),对前若干个边沿取中位数 */
	rise?: number;
	fall?: number;
	/** 中值穿越次数(上升 + 下降) */
	edges: number;
	/** 贴着 ADC 满量程 1% 以内的样本数;有就说明峰值只是下界,加大 vdiv */
	clipped?: { low: number; high: number };
}

export interface Edge {
	/** 点索引(插值后可为小数) */
	index: number;
	rising: boolean;
}

/** int16 码域的"轨":距 ±32768 不到 1% 就算贴轨(12 位 ADC 左对齐后一个 LSB 是 16)。 */
export const RAIL_MARGIN = 328;

/** 中值 ± 滞回(pp 的 10%)的穿越检测:噪声不会在阈值附近来回抖出假边沿;边沿位置在 level 处插值。 */
export function findEdges(codes: ArrayLike<number>, level: number, hysteresis: number, limit = Infinity): Edge[] {
	const hi = level + hysteresis;
	const lo = level - hysteresis;
	const edges: Edge[] = [];
	let state: 0 | 1 | -1 = -1; // -1 未知
	let floor = 0;
	for (let i = 0; i < codes.length && edges.length < limit; i++) {
		const v = codes[i]!;
		if (state === -1) {
			if (v >= hi) state = 1;
			else if (v <= lo) state = 0;
			continue;
		}
		if (state === 0 && v >= hi) {
			state = 1;
			edges.push({ index: crossingAt(codes, i, level, true, floor), rising: true });
			floor = i;
		} else if (state === 1 && v <= lo) {
			state = 0;
			edges.push({ index: crossingAt(codes, i, level, false, floor), rising: false });
			floor = i;
		}
	}
	return edges;
}

/** 从滞回带被穿越的样本 i 往回找真正夹住 level 的样本对,在那里插值;找不到就退回 i-1..i。 */
function crossingAt(codes: ArrayLike<number>, i: number, level: number, rising: boolean, floor: number): number {
	for (let j = i; j > floor && j > 0; j--) {
		const a = codes[j - 1]!;
		const b = codes[j]!;
		if (rising ? a < level && b >= level : a > level && b <= level) return interpolate(codes, j, level);
	}
	return interpolate(codes, i, level);
}

/** 在 i-1..i 之间线性插值出穿越 level 的位置。 */
function interpolate(codes: ArrayLike<number>, i: number, level: number): number {
	if (i === 0) return 0;
	const a = codes[i - 1]!;
	const b = codes[i]!;
	if (a === b) return i;
	const f = (level - a) / (b - a);
	return i - 1 + Math.max(0, Math.min(1, f));
}

function median(values: number[]): number | undefined {
	if (!values.length) return undefined;
	const s = [...values].sort((x, y) => x - y);
	return s[s.length >> 1];
}

/**
 * 直方图众数的稳态电平(ngscopeclient Filter::GetBaseAndTopVoltage 的做法,峰内取样本均值而不是格中心):
 * 最低四分之一里最高的格是 base,最高四分之一里最高的格是 top。两个峰都不比平均格高 2 倍以上就说明
 * 信号没有稳态电平(正弦、三角、噪声),返回 undefined,调用方退回 min/max。
 */
export function baseTop(codes: ArrayLike<number>, min: number, max: number, bins = 100): { base: number; top: number } | undefined {
	const n = codes.length;
	const span = max - min;
	if (n < 8 || !(span > 0)) return undefined;
	const nb = Math.max(4, Math.min(bins, Math.floor(span) + 1));
	const count = new Uint32Array(nb);
	const sum = new Float64Array(nb);
	for (let i = 0; i < n; i++) {
		const v = codes[i]!;
		const k = Math.min(nb - 1, Math.max(0, Math.floor(((v - min) / span) * nb)));
		count[k]!++;
		sum[k]! += v;
	}
	const peak = (from: number, to: number) => {
		let best = from;
		for (let k = from; k < to; k++) if (count[k]! > count[best]!) best = k;
		return best;
	};
	const lo = peak(0, Math.max(1, Math.floor(nb / 4)));
	const hi = peak(Math.floor((nb * 3) / 4), nb);
	const meanCount = n / nb;
	if (count[lo]! < 2 * meanCount || count[hi]! < 2 * meanCount) return undefined;
	return { base: sum[lo]! / count[lo]!, top: sum[hi]! / count[hi]! };
}

/** 10%–90% 过渡时间:在每个边沿附近向两边找 10%/90% 电平的穿越点。 */
function transitionTimes(codes: ArrayLike<number>, edges: Edge[], low: number, high: number, interval: number): { rise?: number; fall?: number } {
	const l10 = low + (high - low) * 0.1;
	const l90 = low + (high - low) * 0.9;
	const rises: number[] = [];
	const falls: number[] = [];
	const n = codes.length;
	for (const e of edges.slice(0, 64)) {
		const c = Math.round(e.index);
		const a = e.rising ? l10 : l90;
		const b = e.rising ? l90 : l10;
		// 向左找 a,向右找 b
		let i = c;
		let left: number | undefined;
		for (let k = 0; k < 10_000 && i > 0; k++, i--) {
			const v = codes[i]!;
			if (e.rising ? v <= a : v >= a) {
				left = interpolate(codes, i + 1, a);
				break;
			}
		}
		let j = c;
		let right: number | undefined;
		for (let k = 0; k < 10_000 && j < n; k++, j++) {
			const v = codes[j]!;
			if (e.rising ? v >= b : v <= b) {
				right = interpolate(codes, j, b);
				break;
			}
		}
		if (left !== undefined && right !== undefined && right > left) (e.rising ? rises : falls).push((right - left) * interval);
	}
	return { rise: median(rises), fall: median(falls) };
}

/** 统计一段 code。interval 是交付点间隔(s)。 */
export function waveStats(codes: ArrayLike<number>, scale: VoltScale, interval: number): WaveStats {
	const n = codes.length;
	if (n === 0) return { min: 0, max: 0, pp: 0, mean: 0, rms: 0, acRms: 0, edges: 0 };
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	let sumSq = 0;
	let railLow = 0;
	let railHigh = 0;
	for (let i = 0; i < n; i++) {
		const v = codes[i]!;
		if (v < min) min = v;
		if (v > max) max = v;
		if (v <= -32768 + RAIL_MARGIN) railLow++;
		else if (v >= 32767 - RAIL_MARGIN) railHigh++;
		sum += v;
		sumSq += v * v;
	}
	const meanCode = sum / n;
	const k = (scale.gain / scale.codePerDiv) * scale.probe;
	const b = scale.offset * scale.probe;
	// rms 是对真实电压(含偏置)算的:E[(k c − b)²] = k²E[c²] − 2kbE[c] + b²
	const rms = Math.sqrt(Math.max(0, k * k * (sumSq / n) - 2 * k * b * meanCode + b * b));
	const mean = codeToVolts(meanCode, scale);
	const stats: WaveStats = {
		min: codeToVolts(min, scale),
		max: codeToVolts(max, scale),
		pp: (max - min) * k,
		mean,
		rms,
		acRms: Math.sqrt(Math.max(0, rms * rms - mean * mean)),
		edges: 0,
	};
	if (railLow || railHigh) stats.clipped = { low: railLow, high: railHigh };
	const pp = max - min;
	// 幅度太小(≤ 8 个 code,WORD 域约 0.1% 满幅)就是噪声,不找边沿
	if (pp <= 8) return stats;
	const levels = baseTop(codes, min, max);
	if (levels) {
		stats.base = codeToVolts(levels.base, scale);
		stats.top = codeToVolts(levels.top, scale);
		stats.overshoot = Math.max(0, stats.max - stats.top);
		stats.undershoot = Math.max(0, stats.base - stats.min);
	}
	const low = levels?.base ?? min;
	const high = levels?.top ?? max;
	const level = (high + low) / 2;
	const edges = findEdges(codes, level, (high - low) * 0.1, 100_000);
	stats.edges = edges.length;
	const rising = edges.filter((e) => e.rising);
	if (rising.length >= 4) {
		const periods: number[] = [];
		for (let i = 1; i < rising.length; i++) periods.push((rising[i]!.index - rising[i - 1]!.index) * interval);
		const typical = median(periods)!;
		// 至少比较 3 个周期。允许采样/抖动带来 ±20% 偏差和最多 10% 异常间隔,
		// 避免把随机穿越的中位间隔直接叫作频率;阈值是保守启发式,不证明周期性或测频准确度。
		const consistent = typical > 0 && periods.filter((p) => Math.abs(p - typical) <= typical * 0.2).length >= periods.length * 0.9;
		if (consistent) {
			// 过了门再按整段跨度平均:首末上升沿之间的时间 / 间隔数,时间误差摊到整条记录上
			const period = ((rising[rising.length - 1]!.index - rising[0]!.index) * interval) / (rising.length - 1);
			stats.period = period;
			stats.freq = 1 / period;
			// 占空比:每对上升→下降的高电平时长 / 周期
			const highs: number[] = [];
			for (let i = 0; i < edges.length - 1; i++) {
				const a = edges[i]!;
				const b2 = edges[i + 1]!;
				if (a.rising && !b2.rising) highs.push((b2.index - a.index) * interval);
			}
			const h = median(highs);
			if (h !== undefined) stats.duty = Math.max(0, Math.min(1, h / period));
		}
	}
	const t = transitionTimes(codes, edges, low, high, interval);
	stats.rise = t.rise;
	stats.fall = t.fall;
	return stats;
}

/** columns 列 × (min,max) 包络,code 域。 */
export function envelope(codes: ArrayLike<number>, columns: number): { min: Int32Array; max: Int32Array } {
	const n = codes.length;
	const cols = Math.max(1, Math.min(columns, n));
	const min = new Int32Array(cols);
	const max = new Int32Array(cols);
	for (let c = 0; c < cols; c++) {
		const from = Math.floor((c * n) / cols);
		const to = Math.max(from + 1, Math.floor(((c + 1) * n) / cols));
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = from; i < to; i++) {
			const v = codes[i]!;
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		min[c] = lo;
		max[c] = hi;
	}
	return { min, max };
}

export interface AsciiPlotOptions {
	width?: number;
	height?: number;
	/** 纵轴显示范围(通道单位);默认按数据 min/max 留 5% 余量 */
	vmin?: number;
	vmax?: number;
	label?: string;
	/** Display unit of the calibrated channel; defaults to V for existing callers. */
	unit?: string;
}

/** 给模型看的文本示意图:min/max 包络画成方块;左侧是通道单位刻度,底部是时间。 */
export function asciiPlot(codes: ArrayLike<number>, scale: VoltScale, time: TimeScale, options: AsciiPlotOptions = {}): string {
	const width = Math.max(16, Math.min(160, options.width ?? 72));
	const height = Math.max(4, Math.min(24, options.height ?? 8));
	const n = codes.length;
	if (n === 0) return `${options.label ?? ""} (no samples)`;
	const env = envelope(codes, width);
	let lo = Infinity;
	let hi = -Infinity;
	for (let c = 0; c < env.min.length; c++) {
		if (env.min[c]! < lo) lo = env.min[c]!;
		if (env.max[c]! > hi) hi = env.max[c]!;
	}
	let vlo = options.vmin ?? codeToVolts(lo, scale);
	let vhi = options.vmax ?? codeToVolts(hi, scale);
	if (options.vmin === undefined && options.vmax === undefined) {
		const pad = Math.max((vhi - vlo) * 0.05, 1e-9);
		vlo -= pad;
		vhi += pad;
	}
	if (vhi <= vlo) vhi = vlo + 1e-9;
	const rowOf = (v: number) => Math.round(((vhi - v) / (vhi - vlo)) * (height - 1));
	const rows: string[][] = Array.from({ length: height }, () => Array.from({ length: env.min.length }, () => " "));
	for (let c = 0; c < env.min.length; c++) {
		const top = Math.max(0, Math.min(height - 1, rowOf(codeToVolts(env.max[c]!, scale))));
		const bottom = Math.max(0, Math.min(height - 1, rowOf(codeToVolts(env.min[c]!, scale))));
		for (let r = Math.min(top, bottom); r <= Math.max(top, bottom); r++) rows[r]![c] = "█";
	}
	const labelWidth = 9;
	const lines: string[] = [];
	for (let r = 0; r < height; r++) {
		const v = vhi - ((vhi - vlo) * r) / (height - 1);
		const lab = r === 0 || r === height - 1 || r === height >> 1 ? si(v, options.unit ?? "V") : "";
		lines.push(`${lab.padStart(labelWidth)} │${rows[r]!.join("")}`);
	}
	const t0 = timeOfIndex(0, time);
	const t1 = timeOfIndex(n - 1, time);
	const tm = timeOfIndex((n - 1) / 2, time);
	const axis = `${"".padStart(labelWidth)} └${"─".repeat(env.min.length)}`;
	const ticks = `${"".padStart(labelWidth + 1)}${si(t0, "s")}${si(tm, "s").padStart(Math.floor(env.min.length / 2) - si(t0, "s").length + Math.floor(si(tm, "s").length / 2))}${si(t1, "s").padStart(env.min.length - Math.floor(env.min.length / 2) - Math.ceil(si(tm, "s").length / 2))}`;
	const head = options.label ? `${options.label}` : "";
	return [head, ...lines, axis, ticks].filter((l) => l.length).join("\n");
}

/** SI 前缀格式化:1.234e-3 V → "1.234 mV";0 → "0 V"。 */
export function si(value: number, unit: string, digits = 3): string {
	if (!Number.isFinite(value)) return `${value} ${unit}`;
	if (value === 0) return `0 ${unit}`;
	const abs = Math.abs(value);
	const prefixes: [number, string][] = [
		[1e9, "G"],
		[1e6, "M"],
		[1e3, "k"],
		[1, ""],
		[1e-3, "m"],
		[1e-6, "µ"],
		[1e-9, "n"],
		[1e-12, "p"],
	];
	for (const [scale, prefix] of prefixes) {
		if (abs >= scale * 0.9995) {
			const v = value / scale;
			return `${trimNumber(v, digits)} ${prefix}${unit}`;
		}
	}
	return `${trimNumber(value / 1e-12, digits)} p${unit}`;
}

function trimNumber(v: number, digits: number): string {
	const abs = Math.abs(v);
	const decimals = abs >= 100 ? Math.max(0, digits - 3) : abs >= 10 ? Math.max(0, digits - 2) : Math.max(0, digits - 1);
	const s = v.toFixed(decimals);
	return decimals > 0 ? s.replace(/\.?0+$/, "") : s;
}

/** 统计字段的单位表:给 details 用,模型不用猜 rise 是秒还是采样点、duty 是 0..1 还是百分比。 */
export function statsUnits(channelUnit: string): Record<keyof Omit<WaveStats, "clipped">, string> {
	return {
		min: channelUnit,
		max: channelUnit,
		pp: channelUnit,
		mean: channelUnit,
		rms: channelUnit,
		acRms: channelUnit,
		top: channelUnit,
		base: channelUnit,
		overshoot: channelUnit,
		undershoot: channelUnit,
		freq: "Hz",
		period: "s",
		duty: "ratio 0..1",
		rise: "s (10%-90% of base..top)",
		fall: "s (90%-10% of top..base)",
		edges: "count",
	};
}

/** SCPI 的 NR3("5.00E-02")或 "****"(无值)。 */
export function parseNumber(text: string): number | null {
	const t = text.trim();
	if (!t || /^\*+$/.test(t)) return null;
	const m = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/.exec(t.replace(/^[A-Za-z:]+\s+/, ""));
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : null;
}
