/**
 * gdb 工具的纯函数层:MI3 协议 + Cortex-M 寄存器语义 + 停止报告渲染。
 * 零 I/O、零依赖 —— 这既是它单独成文件的理由,也是它的价值:
 * gdb 工具里唯一 100% 不需要硬件、不需要子进程就能测的部分全在这儿。
 * (同 edit.ts / edit-diff.ts 的切法。)
 *
 * 【为什么不复用 log.ts 的 splitChunk】
 * 那个函数在超过 MAX_LINE_CHARS(4096)时会强制断行 —— 对"永远不打换行的串口
 * 设备"是对的,对 MI 是灾难:MI 一条 record 就是一行,实测你的 final_foc.elf 上
 * 一条 `-symbol-info-functions` 回复 54,231 字符,仓库里 nRF52833 那个 ELF 上
 * 659,751 字节。切断的后果是静默的:每一段都解析失败,token 永不 resolve,
 * 模型看到的现象是"目标卡死了"。所以这里只按 \n 切,超上限当硬错误。
 *
 * 【MI 的三个反直觉之处 —— 都是实测的,别照直觉写】
 * 1. 结果记录在它引起的异步记录**之后**到:
 *      =thread-group-started / *stopped / 20^connected  ← ^connected 最后
 *    所以"收到 ^done 才算这条命令结束"是对的,"^done 之后才有异步"是错的。
 * 2. `(gdb) ` 提示符在异步停止之后**不发**。拿它当分帧/派发信号会死锁。
 * 3. 一个 token 可能收到两条 `^` 记录(`^running` 之后再来 `^error,"Command aborted."`)。
 *    派发表必须 resolve-once,多出来的记进文件后丢弃。
 *
 * 于是骨架是两条互不相干的通路:token → promise(只吃 `^`),
 * 无 token 的 `*running`/`*stopped` → 目标状态机。耦合它们就是自找死锁。
 */

// ─── 分帧 ────────────────────────────────────────────────────────────────────

/**
 * 单条 record 的字符上限。实测最长见过 659,751 字节,这里留一个数量级余量;
 * 到顶意味着流已经不同步了(比如 `pipe`/`shell` 往 stdout 裸写),
 * 不是"这条特别长",所以调用方应当重启 gdb 而不是截断后继续。
 */
export const MAX_RECORD_CHARS = 4 * 1024 * 1024;

export interface FrameResult {
	/** 完整的 record 行(不含结尾换行)。 */
	lines: string[];
	/** 残余,作为下一段的前缀传回来。 */
	pending: string;
	/** 残余超过上限:流已失同步,调用方必须重启会话,不能吐半条 record。 */
	overflow: boolean;
}

/**
 * 把一段 chunk 切成完整的 MI record 行。只按 \n 切 —— 见文件头。
 * 纯函数:pending 由调用方持有,于是可以逐字节喂 fixture 做边界测试。
 */
export function frameRecords(pending: string, chunk: string, maxRecordChars = MAX_RECORD_CHARS): FrameResult {
	const lines: string[] = [];
	let buffer = pending + chunk;
	while (true) {
		const nl = buffer.indexOf("\n");
		if (nl < 0) break;
		let line = buffer.slice(0, nl);
		// gdb 在 Windows 上会带 \r;record 内容里的 \r 是转义过的,所以只需剥结尾。
		if (line.endsWith("\r")) line = line.slice(0, -1);
		lines.push(line);
		buffer = buffer.slice(nl + 1);
	}
	if (buffer.length > maxRecordChars) return { lines, pending: "", overflow: true };
	return { lines, pending: buffer, overflow: false };
}

// ─── 记录解析 ────────────────────────────────────────────────────────────────

export type RecordKind =
	/** `^done` / `^error` / `^running` / `^connected` / `^exit` —— 唯一带 token 派发的。 */
	| "result"
	/** `*stopped` / `*running` —— 喂状态机。 */
	| "exec"
	/** `+` 进度。 */
	| "status"
	/** `=` 通知(=breakpoint-modified / =thread-group-exited / …)。 */
	| "notify"
	/** `~` 控制台输出 —— `-interpreter-exec console` 的回复走这条。 */
	| "console"
	/** `@` 目标输出 —— monitor 的回复走这条,只收 `~` 会把它丢光。 */
	| "target"
	/** `&` gdb 自己的日志(错误说明、remote 断连提示都在这)。 */
	| "log"
	/** `(gdb) ` —— 丢弃,永远不当信号。 */
	| "prompt"
	/** 不是 MI 的行。`pipe`/`shell` 会裸写 stdout 造出这种。记录后丢弃,绝不抛。 */
	| "foreign";

export interface MiRecord {
	kind: RecordKind;
	/** `22^done` 里的 22。异步记录一般没有。 */
	token?: number;
	/** result-class(done/error/running/connected/exit)或 async-class(stopped/running/…)。 */
	class?: string;
	/** 逗号后的 key=value 列表。 */
	results?: MiTuple;
	/** 流记录(~ @ &)反转义后的正文。 */
	text?: string;
	/**
	 * 值语法没能吃完整行。**不降级成 foreign**:那会让这条命令的 promise 永远挂着,
	 * 比拿到不全的数据更糟。调用方照常 resolve,但要把 raw 记进文件并在结果里标注。
	 */
	partial?: true;
	raw: string;
}

const RESULT_PREFIX: Record<string, RecordKind> = {
	"^": "result",
	"*": "exec",
	"+": "status",
	"=": "notify",
};

const STREAM_PREFIX: Record<string, RecordKind> = {
	"~": "console",
	"@": "target",
	"&": "log",
};

/** class 名允许的字符:`done`、`stopped`、`breakpoint-modified`、`thread-group-added`。 */
const CLASS_RE = /^[A-Za-z][A-Za-z0-9_-]*/;

/**
 * 解析一行 MI。任何解析不了的行都退化成 `foreign`,绝不抛异常 ——
 * 这是在 stdout 的 data 回调里跑的,抛出去就是一个没人接的 rejection。
 */
export function parseRecord(line: string): MiRecord {
	if (line === "" || line === "(gdb)" || line === "(gdb) ") return { kind: "prompt", raw: line };

	// 可选的前导 token
	let i = 0;
	while (i < line.length && line[i]! >= "0" && line[i]! <= "9") i++;
	const token = i > 0 ? Number(line.slice(0, i)) : undefined;
	const prefix = line[i];
	if (!prefix) return { kind: "foreign", raw: line };

	const streamKind = STREAM_PREFIX[prefix];
	if (streamKind) {
		// token 对流记录没有意义,但语法上允许,解析了就不要丢。
		const body = line.slice(i + 1);
		if (!body.startsWith('"')) return { kind: "foreign", raw: line };
		const parsed = readCString(body, 0);
		if (!parsed) return { kind: "foreign", raw: line };
		return { kind: streamKind, token, text: parsed.value, raw: line };
	}

	const recordKind = RESULT_PREFIX[prefix];
	if (!recordKind) return { kind: "foreign", raw: line };

	const rest = line.slice(i + 1);
	const m = CLASS_RE.exec(rest);
	if (!m) return { kind: "foreign", raw: line };
	const cls = m[0];
	const tail = rest.slice(cls.length);
	if (tail !== "" && !tail.startsWith(",")) return { kind: "foreign", raw: line };

	if (tail === "") return { kind: recordKind, token, class: cls, results: {}, raw: line };
	const parsed = parseResultsStrict(tail.slice(1));
	const record: MiRecord = { kind: recordKind, token, class: cls, results: parsed.results, raw: line };
	if (!parsed.complete) record.partial = true;
	return record;
}

// ─── MI 值语法 ───────────────────────────────────────────────────────────────
//
// value → const | tuple | list
// const → c-string;tuple → "{" result,… "}";list → "[" (value|result),… "]"
//
// 两处真实世界的偏离,规范里没写清楚但 gdb 真会发:
// - list 里的 key 会重复:`stack=[frame={…},frame={…}]`。塌成一个对象就丢数据,
//   所以 list 元素里的 `k=v` 一律包成单键 tuple,取用时走 unwrapList()。
// - tuple 里会出现裸值:mi3 的 `script={"print x","continue"}`。碰到就当 list 解析。

export interface MiTuple {
	[key: string]: MiValue;
}
export type MiValue = string | MiTuple | MiValue[];

/** 解析 `k=v,k=v,…`(record 逗号之后的部分)。 */
export function parseResults(src: string): MiTuple {
	return parseResultsStrict(src).results;
}

/** 同上,外加报告有没有把整段吃完 —— 没吃完说明语法有缺口,必须标注出来。 */
export function parseResultsStrict(src: string): { results: MiTuple; complete: boolean } {
	const out: MiTuple = {};
	let pos = 0;
	while (pos < src.length) {
		const r = readResult(src, pos);
		if (!r) break;
		mergeResult(out, r.key, r.value);
		pos = r.next;
		if (src[pos] === ",") pos++;
		else break;
	}
	return { results: out, complete: pos === src.length };
}

/** 解析单个 value(测试直接喂 `{a="1"}` 这种片段用)。 */
export function parseMiValue(src: string): MiValue | undefined {
	const r = readValue(src, 0);
	return r?.value;
}

/**
 * 同名 key 在同一层重复时保留全部:第二次出现就升级成数组。
 * `-break-info` 的 body 就是这个形状。
 */
function mergeResult(target: MiTuple, key: string, value: MiValue): void {
	if (!(key in target)) {
		target[key] = value;
		return;
	}
	const existing = target[key]!;
	if (Array.isArray(existing)) existing.push(value);
	else target[key] = [existing, value];
}

interface Read<T> {
	value: T;
	next: number;
}

function readResult(src: string, pos: number): (Read<MiValue> & { key: string }) | undefined {
	let i = pos;
	while (i < src.length && /[A-Za-z0-9_.-]/.test(src[i]!)) i++;
	if (i === pos || src[i] !== "=") return undefined;
	const key = src.slice(pos, i);
	const v = readValue(src, i + 1);
	if (!v) return undefined;
	return { key, value: v.value, next: v.next };
}

function readValue(src: string, pos: number): Read<MiValue> | undefined {
	const c = src[pos];
	if (c === '"') return readCString(src, pos);
	if (c === "{") return readBraced(src, pos, "}");
	if (c === "[") return readBraced(src, pos, "]");
	return undefined;
}

/**
 * `{…}` 与 `[…]` 走同一段代码:两者都可能装 result、也都可能装裸 value。
 * 返回值形状按内容定 —— 全是 result 且是 `{}` 就给 tuple,其余一律给数组,
 * 数组元素里的 result 包成单键 tuple(见上文"key 会重复")。
 */
function readBraced(src: string, pos: number, close: "}" | "]"): Read<MiValue> | undefined {
	let i = pos + 1;
	if (src[i] === close) return { value: close === "}" ? {} : [], next: i + 1 };

	const items: MiValue[] = [];
	const tuple: MiTuple = {};
	let sawBare = false;
	let sawResult = false;

	while (i < src.length) {
		const r = readResult(src, i);
		if (r) {
			sawResult = true;
			mergeResult(tuple, r.key, r.value);
			items.push({ [r.key]: r.value });
			i = r.next;
		} else {
			const v = readValue(src, i);
			if (!v) return undefined;
			sawBare = true;
			items.push(v.value);
			i = v.next;
		}
		if (src[i] === ",") {
			i++;
			continue;
		}
		break;
	}
	if (src[i] !== close) return undefined;
	const next = i + 1;
	if (close === "}" && sawResult && !sawBare) return { value: tuple, next };
	return { value: items, next };
}

/**
 * 单字符转义 → 字节。null 原型:e 是从输入串里切出来的,不能让它撞上 `constructor`
 * 这类原型键(它恒为单个 UTF-16 码元,撞不上,但表本身不该有那个面)。
 */
const SIMPLE_ESCAPES: Record<string, number> = Object.assign(Object.create(null), {
	n: 0x0a,
	t: 0x09,
	r: 0x0d,
	a: 0x07,
	b: 0x08,
	f: 0x0c,
	v: 0x0b,
	e: 0x1b,
	"\\": 0x5c,
	'"': 0x22,
	"'": 0x27,
});

/**
 * 读 c-string。gdb 发的是**字节串**:非 ASCII 按 UTF-8 逐字节转义成 \\346 这种,
 * 所以必须先还原成字节再按 UTF-8 解一次,直接按字符拼会得到乱码。
 */
function readCString(src: string, pos: number): Read<string> | undefined {
	if (src[pos] !== '"') return undefined;
	const bytes: number[] = [];
	let i = pos + 1;
	while (i < src.length) {
		const c = src[i]!;
		if (c === '"') return { value: decodeUtf8(bytes), next: i + 1 };
		if (c !== "\\") {
			// BMP 之外的字符在 JS 里是代理对,charCodeAt 会拆开 —— 用码点重新编码。
			const cp = src.codePointAt(i)!;
			if (cp < 0x80) bytes.push(cp);
			else pushUtf8(bytes, cp);
			i += cp > 0xffff ? 2 : 1;
			continue;
		}
		i++;
		const e = src[i];
		if (e === undefined) return undefined;
		const simple = SIMPLE_ESCAPES[e];
		if (simple !== undefined) {
			bytes.push(simple);
			i++;
		} else if (e >= "0" && e <= "7") {
			// 八进制:i 此时正指向 e,最多吃 3 位。
			let oct = "";
			while (oct.length < 3 && src[i]! >= "0" && src[i]! <= "7") oct += src[i++];
			bytes.push(Number.parseInt(oct, 8) & 0xff);
		} else {
			// 不认识的转义:原样保留反斜杠后的那个字符,别吞。
			pushUtf8(bytes, src.codePointAt(i)!);
			i += src.codePointAt(i)! > 0xffff ? 2 : 1;
		}
	}
	return undefined;
}

function pushUtf8(bytes: number[], cp: number): void {
	if (cp < 0x80) bytes.push(cp);
	else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
	else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
	else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

function decodeUtf8(bytes: number[]): string {
	return UTF8_DECODER.decode(Uint8Array.from(bytes));
}

/** 把 MI 的 c-string 转义回去(拼 `-interpreter-exec console "…"` 用)。 */
export function escapeCString(text: string): string {
	return text.replace(/[\\"\n\r\t]/g, (c) => {
		if (c === "\n") return "\\n";
		if (c === "\r") return "\\r";
		if (c === "\t") return "\\t";
		return `\\${c}`;
	});
}

// ─── 取值辅助 ────────────────────────────────────────────────────────────────

export function miString(v: MiValue | undefined): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export function miTuple(v: MiValue | undefined): MiTuple | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as MiTuple) : undefined;
}

/**
 * 把 list 摊平成元素数组:`[frame={…},frame={…}]` → 两个 frame tuple。
 * 单键包装(见 readBraced)在这里脱掉;单个元素没被包成 list 时也当一个元素处理,
 * 因为 gdb 在只有一项时偶尔直接给 tuple。
 */
export function unwrapList(v: MiValue | undefined, key?: string): MiTuple[] {
	if (v === undefined) return [];
	const items = Array.isArray(v) ? v : [v];
	const out: MiTuple[] = [];
	for (const item of items) {
		const t = miTuple(item);
		if (!t) continue;
		const keys = Object.keys(t);
		if (key && keys.length === 1 && keys[0] === key) {
			const inner = miTuple(t[key]);
			if (inner) {
				out.push(inner);
				continue;
			}
		}
		out.push(t);
	}
	return out;
}

/** MI 的数字一律是字符串,而且十进制/十六进制混着来。 */
export function miNumber(v: MiValue | undefined): number | undefined {
	const s = miString(v);
	if (s === undefined) return undefined;
	const n = s.startsWith("0x") || s.startsWith("0X") ? Number.parseInt(s, 16) : Number(s);
	return Number.isFinite(n) ? n : undefined;
}

// ─── Cortex-M 寄存器语义 ─────────────────────────────────────────────────────
//
// 这一段是"板子为什么死了"的答案。做成纯函数有两个理由:一是它零硬件可单测,
// 二是模型自己解码这些位是**已知会错**的 —— 拿 handler 自己的 $pc 当崩溃点、
// 把 HFSR=0x40000000 当答案、BFARVALID=0 了还信 BFAR。这些错误一旦进了上下文
// 就会被当成事实继续推理,所以宁可工具替它算。

export const SCB = {
	CPUID: 0xe000ed00,
	ICSR: 0xe000ed04,
	VTOR: 0xe000ed08,
	AIRCR: 0xe000ed0c,
	SCR: 0xe000ed10,
	CCR: 0xe000ed14,
	SHCSR: 0xe000ed24,
	CFSR: 0xe000ed28,
	HFSR: 0xe000ed2c,
	DFSR: 0xe000ed30,
	MMFAR: 0xe000ed34,
	BFAR: 0xe000ed38,
	AFSR: 0xe000ed3c,
	DHCSR: 0xe000edf0,
	DEMCR: 0xe000edfc,
	FP_CTRL: 0xe0002000,
	DWT_CTRL: 0xe0001000,
} as const;

export interface CoreId {
	partno: number;
	name: string;
	/** ARMv6-M(M0/M0+/M1/M23 baseline)没有 CFSR/HFSR/MMFAR/BFAR,不能去解码零。 */
	hasConfigurableFaults: boolean;
	revision: string;
}

const PARTNO_NAMES: Record<number, string> = {
	0xc20: "Cortex-M0",
	0xc21: "Cortex-M1",
	0xc23: "Cortex-M3",
	0xc24: "Cortex-M4",
	0xc27: "Cortex-M7",
	0xc60: "Cortex-M0+",
	0xd20: "Cortex-M23",
	0xd21: "Cortex-M33",
	0xd22: "Cortex-M55",
	0xd23: "Cortex-M85",
};

/** ARMv6-M / baseline:没有可配置故障寄存器。 */
const BASELINE_PARTNOS = new Set([0xc20, 0xc21, 0xc60, 0xd20]);

export function decodeCpuid(cpuid: number): CoreId {
	const partno = (cpuid >>> 4) & 0xfff;
	return {
		partno,
		name: PARTNO_NAMES[partno] ?? `unknown core (PARTNO 0x${partno.toString(16)})`,
		hasConfigurableFaults: !BASELINE_PARTNOS.has(partno),
		revision: `r${(cpuid >>> 20) & 0xf}p${cpuid & 0xf}`,
	};
}

export interface Flag {
	bit: number;
	name: string;
	meaning: string;
}

function flags(value: number, table: Flag[]): Flag[] {
	return table.filter((f) => (value >>> f.bit) & 1);
}

const MMFSR_FLAGS: Flag[] = [
	{ bit: 0, name: "IACCVIOL", meaning: "取指越权(MPU 禁止执行这块地址)" },
	{ bit: 1, name: "DACCVIOL", meaning: "数据访问越权(MPU 拒绝)" },
	{ bit: 3, name: "MUNSTKERR", meaning: "异常返回出栈时越权" },
	{ bit: 4, name: "MSTKERR", meaning: "异常入栈时越权 —— 多半是栈指针跑飞了" },
	{ bit: 5, name: "MLSPERR", meaning: "浮点惰性入栈时越权" },
	{ bit: 7, name: "MMARVALID", meaning: "MMFAR 里的地址有效" },
];

const BFSR_FLAGS: Flag[] = [
	{ bit: 8, name: "IBUSERR", meaning: "取指总线错误(跳到了不存在的地址)" },
	{ bit: 9, name: "PRECISERR", meaning: "精确数据总线错误 —— BFAR 就是出事地址" },
	{ bit: 10, name: "IMPRECISERR", meaning: "非精确总线错误 —— 写缓冲延迟命中,BFAR 和 PC 都不可信" },
	{ bit: 11, name: "UNSTKERR", meaning: "异常返回出栈时总线错误" },
	{ bit: 12, name: "STKERR", meaning: "异常入栈时总线错误 —— 典型的栈溢出" },
	{ bit: 13, name: "LSPERR", meaning: "浮点惰性入栈时总线错误" },
	{ bit: 15, name: "BFARVALID", meaning: "BFAR 里的地址有效" },
];

const UFSR_FLAGS: Flag[] = [
	{ bit: 16, name: "UNDEFINSTR", meaning: "未定义指令 —— 多半是跳进了数据区" },
	{ bit: 17, name: "INVSTATE", meaning: "非法状态 —— 函数指针的 Thumb 位没置 1(常见:空指针调用)" },
	{ bit: 18, name: "INVPC", meaning: "非法 EXC_RETURN,异常返回被破坏" },
	{ bit: 19, name: "NOCP", meaning: "协处理器不可用 —— 用了浮点但没使能 FPU(CPACR)" },
	{ bit: 24, name: "UNALIGNED", meaning: "非对齐访问(CCR.UNALIGN_TRP 打开时才报)" },
	{ bit: 25, name: "DIVBYZERO", meaning: "除零(CCR.DIV_0_TRP 打开时才报)" },
];

const HFSR_FLAGS: Flag[] = [
	{ bit: 1, name: "VECTTBL", meaning: "读向量表时总线错误 —— VTOR 指错了地方" },
	{ bit: 30, name: "FORCED", meaning: "由可配置故障升级而来 —— 真正的原因在 CFSR" },
	{ bit: 31, name: "DEBUGEVT", meaning: "调试事件" },
];

const DFSR_FLAGS: Flag[] = [
	{ bit: 0, name: "HALTED", meaning: "调试器主动暂停" },
	{ bit: 1, name: "BKPT", meaning: "断点(FPB 命中,或固件里的 BKPT 指令 / 半主机调用)" },
	{ bit: 2, name: "DWTTRAP", meaning: "DWT 观察点命中" },
	{ bit: 3, name: "VCATCH", meaning: "向量捕获" },
	{ bit: 4, name: "EXTERNAL", meaning: "外部调试请求" },
];

const DHCSR_FLAGS: Flag[] = [
	{ bit: 17, name: "S_HALT", meaning: "内核已暂停" },
	{ bit: 18, name: "S_SLEEP", meaning: "内核在睡眠(WFI/WFE)" },
	{ bit: 19, name: "S_LOCKUP", meaning: "内核锁死 —— 故障处理里又故障了,$pc 读出来是 0xEFFFFFFE" },
	{ bit: 25, name: "S_RESET_ST", meaning: "上次读之后发生过复位(粘滞位)" },
];

export interface FaultDecode {
	/** 一句话结论,给模型读的。 */
	summary: string;
	mmfsr: Flag[];
	bfsr: Flag[];
	ufsr: Flag[];
	hfsr: Flag[];
	/** 出事地址;没有有效地址时是 undefined —— BFARVALID=0 时**绝不**返回 BFAR。 */
	faultAddress?: number;
	/** 非精确总线错误:PC 和地址都不可信,不能报源码行。 */
	imprecise: boolean;
}

/**
 * CFSR + HFSR 解码。ARMv6-M 上这两个寄存器不存在,调用方要先看 CoreId。
 * 三条不能省的纪律:
 * - HFSR.FORCED 不是答案,只是"去看 CFSR"的指针;
 * - BFARVALID / MMARVALID 为 0 时 BFAR/MMFAR 是陈旧值,报出去会冤枉无辜代码;
 * - IMPRECISERR 置位时连 PC 都不可信(写缓冲延迟命中),必须明说而不是给个位置。
 */
export function decodeFault(cfsr: number, hfsr: number, mmfar: number, bfar: number): FaultDecode {
	const mmfsr = flags(cfsr, MMFSR_FLAGS);
	const bfsr = flags(cfsr, BFSR_FLAGS);
	const ufsr = flags(cfsr, UFSR_FLAGS);
	const hf = flags(hfsr, HFSR_FLAGS);

	const imprecise = ((cfsr >>> 10) & 1) === 1;
	const bfarValid = ((cfsr >>> 15) & 1) === 1;
	const mmarValid = ((cfsr >>> 7) & 1) === 1;
	const faultAddress = bfarValid ? bfar >>> 0 : mmarValid ? mmfar >>> 0 : undefined;

	const named = [...mmfsr, ...bfsr, ...ufsr].filter((f) => f.name !== "BFARVALID" && f.name !== "MMARVALID");
	let summary: string;
	if (named.length === 0) {
		summary =
			cfsr === 0 && hfsr === 0
				? "没有故障位置位 —— 这次停止不是故障(检查 DFSR:断点/单步/调试器暂停)"
				: `HFSR=0x${(hfsr >>> 0).toString(16)},CFSR 为 0:硬故障但没有可配置故障位,多半是向量表读失败或调试事件`;
	} else {
		summary = named.map((f) => `${f.name}(${f.meaning})`).join("; ");
		if (faultAddress !== undefined) summary += `;出事地址 0x${faultAddress.toString(16).padStart(8, "0")}`;
		if (imprecise) summary += ";⚠ 非精确 —— 出事地址与 PC 都不可信,别据此定位源码行";
	}
	return { summary, mmfsr, bfsr, ufsr, hfsr: hf, faultAddress, imprecise };
}

export function decodeDfsr(dfsr: number): Flag[] {
	return flags(dfsr, DFSR_FLAGS);
}

export function decodeDhcsr(dhcsr: number): Flag[] {
	return flags(dhcsr, DHCSR_FLAGS);
}

/** ICSR.VECTACTIVE:0=线程模式,2=NMI,3=HardFault,…,≥16 是外设中断。 */
export function decodeException(icsr: number): { vectactive: number; name: string; inHandler: boolean } {
	const v = icsr & 0x1ff;
	const builtin: Record<number, string> = {
		0: "Thread mode",
		1: "Reset",
		2: "NMI",
		3: "HardFault",
		4: "MemManage",
		5: "BusFault",
		6: "UsageFault",
		7: "SecureFault",
		11: "SVCall",
		12: "DebugMonitor",
		14: "PendSV",
		15: "SysTick",
	};
	const name = builtin[v] ?? (v >= 16 ? `IRQ ${v - 16}` : `reserved (${v})`);
	return { vectactive: v, name, inHandler: v !== 0 };
}

export interface ExcReturnInfo {
	/** 入栈用的是 PSP 还是 MSP —— 读错栈就等于读了一堆无关的字。 */
	stackPointer: "MSP" | "PSP";
	mode: "Handler" | "Thread";
	/** 扩展帧多压 18 个字(S0-S15 + FPSCR + 保留)。 */
	extendedFrame: boolean;
	valid: boolean;
}

/**
 * EXC_RETURN(异常里的 LR)解码。ARMv7-M:
 *   bit 2 = SPSEL(1→PSP)  bit 3 = Mode(1→Thread)  bit 4 = 0 表示带浮点的扩展帧
 */
export function decodeExcReturn(lr: number): ExcReturnInfo {
	const v = lr >>> 0;
	return {
		stackPointer: (v & 0x4) !== 0 ? "PSP" : "MSP",
		mode: (v & 0x8) !== 0 ? "Thread" : "Handler",
		extendedFrame: (v & 0x10) === 0,
		// >>> 0 不能省:JS 的 & 结果是有符号 32 位,0xfffffffd & 0xffffff00 会得到 -256。
		valid: ((v & 0xffffff00) >>> 0) === 0xffffff00,
	};
}

export interface StackedFrame {
	r0: number;
	r1: number;
	r2: number;
	r3: number;
	r12: number;
	lr: number;
	pc: number;
	xpsr: number;
	/** xPSR bit 9:入栈时为了 8 字节对齐多塞了 4 字节。 */
	padded: boolean;
}

/**
 * 从 8 个字还原异常入栈帧。**这是整个故障分析的关键一步**:
 * handler 自己的 $pc/$sp 指的是 handler,出事的现场在这个帧里。
 */
export function decodeStackedFrame(words: number[]): StackedFrame | undefined {
	if (words.length < 8) return undefined;
	const [r0, r1, r2, r3, r12, lr, pc, xpsr] = words as [number, number, number, number, number, number, number, number];
	return {
		r0: r0 >>> 0,
		r1: r1 >>> 0,
		r2: r2 >>> 0,
		r3: r3 >>> 0,
		r12: r12 >>> 0,
		lr: lr >>> 0,
		pc: pc >>> 0,
		xpsr: xpsr >>> 0,
		padded: ((xpsr >>> 9) & 1) === 1,
	};
}

/** FP_CTRL.NUM_CODE 是拆成两段的:[14:12] 是高 3 位,[7:4] 是低 4 位。 */
export function decodeBreakpointUnits(fpCtrl: number): { total: number; enabled: boolean } {
	const total = (((fpCtrl >>> 12) & 0x7) << 4) | ((fpCtrl >>> 4) & 0xf);
	return { total, enabled: (fpCtrl & 1) === 1 };
}

/** DWT_CTRL.NUMCOMP:[31:28]。M3/M4/M7 一般 4 个,M0+/M23 是 2 个。 */
export function decodeWatchpointUnits(dwtCtrl: number): number {
	return (dwtCtrl >>> 28) & 0xf;
}

// ─── 渲染与预算 ──────────────────────────────────────────────────────────────
//
// 纪律和 log.ts 一致:全量在文件里,进上下文的一律有界、且**截断必须标注**。
// 裸截断是最坏的失败形式 —— 它是自信地错,而不是可见地错。

export const MAX_FRAMES = 8;

export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [截断:共 ${text.length} 字符,已显示 ${max}]`;
}

export function hex(n: number | undefined, width = 8): string {
	if (n === undefined) return "?";
	return `0x${(n >>> 0).toString(16).padStart(width, "0")}`;
}

export interface Frame {
	level?: number;
	addr?: string;
	func?: string;
	file?: string;
	line?: string;
	/** MI 给的编译期绝对路径。可能在本机不存在 —— 调用方要先 exists() 再当位置用。 */
	fullname?: string;
	args?: { name: string; value?: string }[];
}

/** 从 MI 的 frame tuple 取字段。gdb 在不同命令里给的键是一致的,但可能缺项。 */
export function frameOf(t: MiTuple | undefined): Frame | undefined {
	if (!t) return undefined;
	const args = unwrapList(t.args).map((a) => ({
		name: miString(a.name) ?? "?",
		value: miString(a.value),
	}));
	return {
		level: miNumber(t.level),
		addr: miString(t.addr),
		func: miString(t.func),
		file: miString(t.file),
		line: miString(t.line),
		fullname: miString(t.fullname),
		args: args.length ? args : undefined,
	};
}

export function renderFrame(f: Frame, index?: number): string {
	const head = index === undefined ? "" : `#${index} `;
	const args = f.args?.length ? `(${f.args.map((a) => `${a.name}=${a.value ?? "?"}`).join(", ")})` : "()";
	const where = f.file && f.line ? ` at ${f.file}:${f.line}` : f.addr ? ` at ${f.addr}` : "";
	return `${head}${f.func ?? "??"}${args}${where}`;
}

export function renderFrames(frames: Frame[], max = MAX_FRAMES): string[] {
	const shown = frames.slice(0, max);
	const out = shown.map((f, i) => `  ${renderFrame(f, f.level ?? i)}`);
	if (frames.length > max) out.push(`  … 还有 ${frames.length - max} 帧(eval "bt ${frames.length}" 看全部)`);
	return out;
}
