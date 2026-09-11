/**
 * Siglent 波形描述块(WAVEDESC,346 字节,LeCroy 血统)与样本换算。
 *
 * 偏移与含义按 Siglent《SDS Series Programming Guide》"Waveform Data Format" 一节,并对着 SDS824X HD
 * 真机的 preamble 逐字段核过(fixtures 见 test/fixtures/scope/)。几条**必须**记住的坑:
 *  - VERTICAL_GAIN(156)/VERTICAL_OFFSET(160) 是 BNC 口的量,**不含探头衰减**:10× 探头时 vdiv 要乘 10。
 *  - CODE_PER_DIV(164) 在 WORD 与 BYTE 模式下都报 7680(12 位左对齐进 16 位:480×16),BYTE 模式发的
 *    是高字节,不换算就小 256 倍。守则:永远 WORD;但还是按 COMM_TYPE 兜底。
 *  - NOMINAL_BITS(172) 报 16,不是 ADC 位数(12)。别拿它当分辨率。
 *  - COMM_ORDER(34) 报 0(HIFIRST),而数据实际是小端。忽略它。
 *  - TIMEBASE(324) 是枚举,表按机型不同,手册自己的两份示例还差一格 —— 时基一律查 `:TIMebase:SCALe?`。
 *  - HORIZ_INTERVAL(176) 是**采集**的采样间隔,不随 `:WAVeform:INTerval` 变;交付点的间隔 = interval × stride。
 *  - 时间轴:t[i] = delay − tdiv × 10/2 + i × interval × stride(手册公式,grid = 10 格)。
 */

export interface WaveDesc {
	/** 0 = BYTE, 1 = WORD */
	commType: number;
	commOrder: number;
	descriptorLength: number;
	waveArray1Bytes: number;
	instrument: string;
	/** 本次交付的点数(不是记录长度) */
	waveArrayCount: number;
	firstPoint: number;
	sparsing: number;
	/** BNC 口 V/div,不含探头 */
	verticalGain: number;
	/** BNC 口偏置,不含探头 */
	verticalOffset: number;
	codePerDiv: number;
	/** 报 16(WORD)—— 不是 ADC 位数 */
	nominalBits: number;
	/** 采集采样间隔(s) */
	horizInterval: number;
	/** 触发延迟(s),手册叫 delay */
	horizOffset: number;
	vertUnit: string;
	horUnit: string;
	timebaseEnum: number;
	/** 0 DC, 1 AC, 2 GND(Siglent 表) */
	couplingEnum: number;
	probe: number;
	fixedVertGainEnum: number;
	bwLimitEnum: number;
	waveSourceEnum: number;
}

export const WAVEDESC_LENGTH = 346;

/** 描述块里的字符串都是 ASCII,逐字节转;遇 NUL 截止。 */
function cstr(bytes: Uint8Array, offset: number, length: number): string {
	let out = "";
	for (let i = offset; i < offset + length && i < bytes.length; i++) {
		const c = bytes[i]!;
		if (c === 0) break;
		out += String.fromCharCode(c);
	}
	return out.trim();
}

/** 解析 preamble 块内字节(≥ 346;序列模式后面还挂时间戳,只看前 346)。 */
export function parseWaveDesc(bytes: Uint8Array): WaveDesc {
	if (bytes.length < WAVEDESC_LENGTH) throw new Error(`scope: preamble is ${bytes.length} bytes, expected ${WAVEDESC_LENGTH}`);
	if (cstr(bytes, 0, 16) !== "WAVEDESC") throw new Error(`scope: preamble does not start with WAVEDESC (${JSON.stringify(cstr(bytes, 0, 16))})`);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		commType: dv.getInt16(32, true),
		commOrder: dv.getInt16(34, true),
		descriptorLength: dv.getInt32(36, true),
		waveArray1Bytes: dv.getInt32(60, true),
		instrument: cstr(bytes, 76, 16),
		waveArrayCount: dv.getInt32(116, true),
		firstPoint: dv.getInt32(132, true),
		sparsing: dv.getInt32(136, true),
		verticalGain: dv.getFloat32(156, true),
		verticalOffset: dv.getFloat32(160, true),
		codePerDiv: dv.getFloat32(164, true),
		nominalBits: dv.getInt16(172, true),
		horizInterval: dv.getFloat32(176, true),
		horizOffset: dv.getFloat64(180, true),
		vertUnit: cstr(bytes, 196, 48),
		horUnit: cstr(bytes, 244, 48),
		timebaseEnum: dv.getInt16(324, true),
		couplingEnum: dv.getInt16(326, true),
		probe: dv.getFloat32(328, true),
		fixedVertGainEnum: dv.getInt16(332, true),
		bwLimitEnum: dv.getInt16(334, true),
		waveSourceEnum: dv.getInt16(344, true),
	};
}

/** 手册 Table 2 的 39 项时基枚举(索引 9 的 "200E-0" 是手册笔误,取 200e-9)。只做兜底,正路是查 `:TIMebase:SCALe?`。 */
export const TIMEBASE_ENUM: readonly number[] = [
	200e-12, 500e-12, 1e-9, 2e-9, 5e-9, 10e-9, 20e-9, 50e-9, 100e-9, 200e-9, 500e-9,
	1e-6, 2e-6, 5e-6, 10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6,
	1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 100e-3, 200e-3, 500e-3,
	1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
];

export const COUPLING_ENUM: readonly string[] = ["DC", "AC", "GND"];

/** BYTE 模式下 code_per_div 仍报 16 位空间的值(7680):发的是高字节,要除 256。 */
export function effectiveCodePerDiv(desc: Pick<WaveDesc, "commType" | "codePerDiv" | "nominalBits">): number {
	// 缺省值按 16 位空间给(仪器就是这么报的),BYTE 再统一除 256 —— 否则 BYTE 分支会双重换算
	const cpd = desc.codePerDiv || 7680;
	return desc.commType === 0 && desc.nominalBits > 8 ? cpd / 256 : cpd;
}

/** 块内样本 → 有符号整型视图(WORD 小端 int16 / BYTE int8)。拷贝一份保证对齐。 */
export function decodeSamples(payload: Uint8Array, commType: number): Int16Array | Int8Array {
	if (commType === 1) {
		const n = payload.length >> 1;
		const out = new Int16Array(n);
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
		return out;
	}
	const out = new Int8Array(payload.length);
	for (let i = 0; i < payload.length; i++) out[i] = (payload[i]! << 24) >> 24;
	return out;
}

/** 电压换算参数:volts = code × (gain / cpd) × probe − offset × probe。 */
export interface VoltScale {
	/** BNC 口 V/div */
	gain: number;
	/** BNC 口偏置 */
	offset: number;
	codePerDiv: number;
	probe: number;
}

export function voltScaleOf(desc: WaveDesc, probeOverride?: number): VoltScale {
	const probe = probeOverride && probeOverride > 0 ? probeOverride : desc.probe > 0 ? desc.probe : 1;
	return { gain: desc.verticalGain, offset: desc.verticalOffset, codePerDiv: effectiveCodePerDiv(desc), probe };
}

export function codeToVolts(code: number, s: VoltScale): number {
	return (code * (s.gain / s.codePerDiv) - s.offset) * s.probe;
}

export function codesToVolts(codes: ArrayLike<number>, s: VoltScale): Float32Array {
	const k = (s.gain / s.codePerDiv) * s.probe;
	const b = s.offset * s.probe;
	const out = new Float32Array(codes.length);
	for (let i = 0; i < codes.length; i++) out[i] = codes[i]! * k - b;
	return out;
}

/** 时间轴参数(s)。 */
export interface TimeScale {
	/** `:TIMebase:DELay?` / preamble 的 horizOffset */
	delay: number;
	/** `:TIMebase:SCALe?` */
	tdiv: number;
	/** 交付点间隔 = 采集间隔 × stride */
	interval: number;
	grid?: number;
}

/** 第 i 个交付点相对触发的时间。手册公式:delay − tdiv×grid/2 + i×interval。 */
export function timeOfIndex(i: number, t: TimeScale): number {
	return t.delay - (t.tdiv * (t.grid ?? 10)) / 2 + i * t.interval;
}

/** 反过来:某个时刻落在哪个点(可能越界,调用方钳制)。 */
export function indexOfTime(time: number, t: TimeScale): number {
	return (time - t.delay + (t.tdiv * (t.grid ?? 10)) / 2) / t.interval;
}
