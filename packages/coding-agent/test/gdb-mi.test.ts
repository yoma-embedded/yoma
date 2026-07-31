import { describe, expect, it } from "bun:test";
import {
	clip,
	decodeBreakpointUnits,
	decodeCpuid,
	decodeDfsr,
	decodeDhcsr,
	decodeException,
	decodeExcReturn,
	decodeFault,
	decodeStackedFrame,
	decodeWatchpointUnits,
	escapeCString,
	frameOf,
	frameRecords,
	hex,
	type MiTuple,
	miNumber,
	miString,
	miTuple,
	parseMiValue,
	parseRecord,
	parseResults,
	renderFrame,
	renderFrames,
	unwrapList,
} from "../src/index.ts";

// ─── 分帧 ────────────────────────────────────────────────────────────────────

describe("frameRecords", () => {
	it("按 \\n 切,残余留给下一段", () => {
		const a = frameRecords("", '^done,value="a"\n*stop');
		expect(a.lines).toEqual(['^done,value="a"']);
		expect(a.pending).toBe("*stop");
		expect(a.overflow).toBe(false);

		const b = frameRecords(a.pending, "ped\n(gdb) \n");
		expect(b.lines).toEqual(["*stopped", "(gdb) "]);
		expect(b.pending).toBe("");
	});

	it("剥掉行尾的 \\r,但不动 record 内部的转义", () => {
		const r = frameRecords("", '~"a\\r\\nb"\r\n');
		expect(r.lines).toEqual(['~"a\\r\\nb"']);
	});

	it("逐字符喂也必须还原成同一条 record —— 转义中间断开是真实的分片位置", () => {
		const record = '^done,msg="he said \\"hi\\"\\n"';
		let pending = "";
		const lines: string[] = [];
		for (const ch of `${record}\n`) {
			const r = frameRecords(pending, ch);
			pending = r.pending;
			lines.push(...r.lines);
		}
		expect(lines).toEqual([record]);
		expect(pending).toBe("");
	});

	it("不给 4096 处强切 —— 这正是 log.ts 的 splitChunk 不能复用的原因", () => {
		const long = `^done,symbols="${"x".repeat(60_000)}"`;
		const r = frameRecords("", `${long}\n`);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]!.length).toBe(long.length);
	});

	it("残余超上限时报 overflow,而不是吐半条 record", () => {
		const r = frameRecords("", "x".repeat(200), 100);
		expect(r.overflow).toBe(true);
		expect(r.lines).toEqual([]);
		expect(r.pending).toBe("");
	});

	it("没有换行就不产出任何 record", () => {
		const r = frameRecords("", "^done,val");
		expect(r.lines).toEqual([]);
		expect(r.pending).toBe("^done,val");
	});
});

// ─── 记录分类 ────────────────────────────────────────────────────────────────

describe("parseRecord — 记录种类", () => {
	it("带 token 的结果记录", () => {
		const r = parseRecord("22^done");
		expect(r.kind).toBe("result");
		expect(r.token).toBe(22);
		expect(r.class).toBe("done");
		expect(r.results).toEqual({});
	});

	it("^error 带 msg 与 code", () => {
		const r = parseRecord('33^error,msg="Undefined MI command: no-such-command",code="undefined-command"');
		expect(r.kind).toBe("result");
		expect(r.token).toBe(33);
		expect(r.class).toBe("error");
		expect(miString(r.results?.msg)).toBe("Undefined MI command: no-such-command");
		expect(miString(r.results?.code)).toBe("undefined-command");
	});

	it("^connected 是独立的结果类,不能只认 done/error", () => {
		expect(parseRecord("20^connected").class).toBe("connected");
		expect(parseRecord("30^running").class).toBe("running");
		expect(parseRecord("50^exit").class).toBe("exit");
	});

	it("异步执行记录不带 token", () => {
		const r = parseRecord('*running,thread-id="all"');
		expect(r.kind).toBe("exec");
		expect(r.token).toBeUndefined();
		expect(r.class).toBe("running");
		expect(miString(r.results?.["thread-id"])).toBe("all");
	});

	it("通知记录", () => {
		const r = parseRecord('=thread-group-added,id="i1"');
		expect(r.kind).toBe("notify");
		expect(r.class).toBe("thread-group-added");
		expect(miString(r.results?.id)).toBe("i1");
	});

	it("三种流记录都要认 —— 只收 ~ 会把 monitor 的回复丢光", () => {
		expect(parseRecord('~"$1 = 2\\n"')).toMatchObject({ kind: "console", text: "$1 = 2\n" });
		expect(parseRecord('@"Resetting target\\n"')).toMatchObject({ kind: "target", text: "Resetting target\n" });
		expect(parseRecord('&"Cannot execute this command while the target is running.\\n"')).toMatchObject({
			kind: "log",
			text: "Cannot execute this command while the target is running.\n",
		});
	});

	it("提示符是噪声,不是信号", () => {
		expect(parseRecord("(gdb) ").kind).toBe("prompt");
		expect(parseRecord("(gdb)").kind).toBe("prompt");
		expect(parseRecord("").kind).toBe("prompt");
	});

	it("非 MI 的行退化成 foreign 而不是抛异常 —— pipe/shell 会往 stdout 裸写", () => {
		// 实测:`pipe print 1+1 | cat` 把这行裸写到 stdout,不在任何 record 里。
		expect(parseRecord("$1 = 2").kind).toBe("foreign");
		expect(parseRecord("r0             0x0                 0").kind).toBe("foreign");
		expect(parseRecord("^").kind).toBe("foreign");
	});
});

// ─── c-string 转义 ───────────────────────────────────────────────────────────

describe("c-string 反转义", () => {
	const text = (line: string) => parseRecord(line).text;

	it("常见转义", () => {
		expect(text('~"a\\tb\\nc\\\\d\\"e\\r"')).toBe('a\tb\nc\\d"e\r');
	});

	it("八进制:NUL 和高位字节", () => {
		expect(text('~"LED1\\000\\000"')).toBe("LED1\0\0");
		expect(text('~"\\007\\010"')).toBe("\x07\x08");
	});

	it("多字节 UTF-8 是逐字节转义的,必须按字节重组 —— 逐字符拼会得到乱码", () => {
		// gdb 把 "我" 发成三个八进制字节
		expect(text('~"\\346\\210\\221"')).toBe("我");
	});

	it("嵌套引号与反斜杠(msg 里最常见)", () => {
		const r = parseRecord('^error,msg="No symbol \\"x\\" in current context."');
		expect(miString(r.results?.msg)).toBe('No symbol "x" in current context.');
	});

	it("反汇编里的制表符", () => {
		const v = parseMiValue('"ldr\\tr3, [r7, #4]"');
		expect(v).toBe("ldr\tr3, [r7, #4]");
	});

	it("escapeCString 是它的逆", () => {
		expect(escapeCString('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
	});
});

// ─── 值语法 ──────────────────────────────────────────────────────────────────

describe("MI 值语法", () => {
	it("空 tuple / 空 list", () => {
		expect(parseMiValue("{}")).toEqual({});
		expect(parseMiValue("[]")).toEqual([]);
	});

	it("嵌套 tuple", () => {
		const v = parseResults('bkpt={number="1",type="breakpoint",addr="0x08000066",line="31"}');
		const b = miTuple(v.bkpt)!;
		expect(miString(b.number)).toBe("1");
		expect(miString(b.addr)).toBe("0x08000066");
	});

	it("list of const", () => {
		const v = parseResults('features=["frozen-varobjs","pending-breakpoints","thread-info"]');
		expect(v.features).toEqual(["frozen-varobjs", "pending-breakpoints", "thread-info"]);
	});

	it("list 里重复的 key 绝不能塌成一项 —— stack=[frame=…,frame=…] 是最常见的形状", () => {
		const v = parseResults(
			'stack=[frame={level="0",addr="0x08001a3e",func="ring_push",file="uart.c",line="37"},' +
				'frame={level="1",addr="0x08001a10",func="uart_rx_isr",file="uart.c",line="142"},' +
				'frame={level="2",addr="0x08000f2a",func="main",file="main.c",line="57"}]',
		);
		const frames = unwrapList(v.stack, "frame");
		expect(frames).toHaveLength(3);
		expect(miString(frames[0]!.func)).toBe("ring_push");
		expect(miString(frames[2]!.func)).toBe("main");
	});

	it("tuple 里出现裸值时退化成数组,而不是解析失败", () => {
		// mi3 的 script 字段就是这个形状
		const v = parseResults('script={"print x","continue"}');
		expect(v.script).toEqual(["print x", "continue"]);
	});

	it("memory / asm_insns 这类 list-of-tuple", () => {
		const mem = parseResults(
			'memory=[{begin="0x20000014",offset="0x00000000",end="0x20000024",contents="0a000000140000001e00000028000000"}]',
		);
		const cells = unwrapList(mem.memory);
		expect(cells).toHaveLength(1);
		expect(miString(cells[0]!.contents)).toBe("0a000000140000001e00000028000000");

		const asm = parseResults(
			'asm_insns=[{address="0x08000012",func-name="compute_delay",offset="10",inst="ldr\\tr3, [r7, #4]"},' +
				'{address="0x08000016",func-name="compute_delay",offset="14",inst="mul.w\\tr3, r2, r3"}]',
		);
		const insns = unwrapList(asm.asm_insns);
		expect(insns).toHaveLength(2);
		expect(miString(insns[1]!.inst)).toBe("mul.w\tr3, r2, r3");
	});

	it("三层嵌套:-symbol-info-functions 的形状", () => {
		const v = parseResults(
			'symbols={debug=[{filename="blink.c",fullname="/tmp/blink.c",' +
				'symbols=[{line="17",name="compute_delay",type="uint32_t (uint32_t, uint32_t)"}]}]}',
		);
		const files = unwrapList(miTuple(v.symbols)?.debug);
		expect(files).toHaveLength(1);
		const syms = unwrapList(files[0]!.symbols);
		expect(miString(syms[0]!.name)).toBe("compute_delay");
	});

	it("同一层重复 key 升级成数组", () => {
		const v = parseResults('a="1",a="2",b="3"');
		expect(v.a).toEqual(["1", "2"]);
		expect(v.b).toBe("3");
	});

	it("嵌套结构体的字符串值原样保留(gdb 把整个结构体塞进一个 const)", () => {
		const v = parseResults(
			'value="{mode = 1, speed = 3, pin = 13 \'\\r\', name = \\"LED1\\000\\000\\000\\"}"',
		);
		expect(miString(v.value)).toBe("{mode = 1, speed = 3, pin = 13 '\r', name = \"LED1\0\0\0\"}");
	});

	it("吃不完整行时标 partial,而不是降级成 foreign —— 后者会让 promise 永远挂着", () => {
		const truncated = parseRecord('^done,bkpt={number="1"');
		expect(truncated.kind).toBe("result");
		expect(truncated.token).toBeUndefined();
		expect(truncated.partial).toBe(true);

		const bare = parseRecord('^done,"bare"');
		expect(bare.kind).toBe("result");
		expect(bare.partial).toBe(true);

		// 能吃完的不标
		expect(parseRecord('^done,value="1"').partial).toBeUndefined();
		expect(() => parseRecord('^done,a={b=[{c="1"')).not.toThrow();
	});
});

describe("取值辅助", () => {
	it("miNumber 认十进制和十六进制", () => {
		expect(miNumber("31")).toBe(31);
		expect(miNumber("0x08000066")).toBe(0x08000066);
		expect(miNumber("nope")).toBeUndefined();
		expect(miNumber(undefined)).toBeUndefined();
	});

	it("unwrapList 对单个 tuple 也成立", () => {
		const one: MiTuple = { frame: { func: "main" } };
		expect(unwrapList(one, "frame")).toEqual([{ func: "main" }]);
	});
});

// ─── 真实记录:实测抓到的那几条 ───────────────────────────────────────────────

describe("实测记录", () => {
	it("QEMU 上 attach 时的 *stopped(带 args=[] 与 fullname)", () => {
		const r = parseRecord(
			'*stopped,frame={addr="0x0000044c",func="Reset_Handler",args=[],file="main.c",' +
				'fullname="/tmp/fixture/main.c",line="287",arch="armv3m"},thread-id="1",stopped-threads="all"',
		);
		expect(r.kind).toBe("exec");
		expect(r.class).toBe("stopped");
		const f = frameOf(miTuple(r.results?.frame))!;
		expect(f.func).toBe("Reset_Handler");
		expect(f.line).toBe("287");
		expect(f.fullname).toBe("/tmp/fixture/main.c");
		expect(f.args).toBeUndefined();
	});

	it("断点命中的 *stopped 带断点号和实参", () => {
		const r = parseRecord(
			'*stopped,reason="breakpoint-hit",disp="keep",bkptno="2",' +
				'frame={addr="0x08001a3e",func="ring_push",args=[{name="r",value="0x20000100"},{name="ch",value="65 \'A\'"}],' +
				'file="uart.c",fullname="/src/uart.c",line="37"},thread-id="1",stopped-threads="all",core="0"',
		);
		expect(miString(r.results?.reason)).toBe("breakpoint-hit");
		expect(miString(r.results?.bkptno)).toBe("2");
		const f = frameOf(miTuple(r.results?.frame))!;
		expect(f.args).toEqual([
			{ name: "r", value: "0x20000100" },
			{ name: "ch", value: "65 'A'" },
		]);
		expect(renderFrame(f, 0)).toBe("#0 ring_push(r=0x20000100, ch=65 'A') at uart.c:37");
	});

	it("-break-insert 的回复:pending 断点在裸机上永远不会解析", () => {
		const ok = parseRecord(
			'^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x08000066",func="main",' +
				'file="blink.c",fullname="/tmp/blink.c",line="31",thread-groups=["i1"],times="0",original-location="blink.c:31"}',
		);
		expect(miString(miTuple(ok.results?.bkpt)?.addr)).toBe("0x08000066");

		const pending = parseRecord(
			'^done,bkpt={number="2",type="breakpoint",disp="keep",enabled="y",addr="<PENDING>",' +
				'pending="process_pkt",times="0",original-location="process_pkt"}',
		);
		expect(miString(miTuple(pending.results?.bkpt)?.addr)).toBe("<PENDING>");
	});

	it("多地址断点(内联/ICF)带 locations 列表 —— 每一项都吃一个硬件单元", () => {
		const r = parseRecord(
			'^done,bkpt={number="3",type="breakpoint",disp="keep",enabled="y",addr="<MULTIPLE>",times="0",' +
				'locations=[{number="3.1",enabled="y",addr="0x08000100",func="helper",file="a.c",line="9"},' +
				'{number="3.2",enabled="y",addr="0x08000240",func="helper",file="b.c",line="9"}]}',
		);
		const bkpt = miTuple(r.results?.bkpt)!;
		expect(miString(bkpt.addr)).toBe("<MULTIPLE>");
		expect(unwrapList(bkpt.locations)).toHaveLength(2);
	});

	it("BreakpointTable 的 hdr + body", () => {
		const r = parseRecord(
			'^done,BreakpointTable={nr_rows="2",nr_cols="6",' +
				'hdr=[{width="3",alignment="-1",col_name="number",colhdr="Num"},{width="14",alignment="-1",col_name="type",colhdr="Type"}],' +
				'body=[bkpt={number="1",type="breakpoint",addr="0x08000066"},bkpt={number="2",type="hw watchpoint",what="g_state"}]}',
		);
		const table = miTuple(r.results?.BreakpointTable)!;
		const body = unwrapList(table.body, "bkpt");
		expect(body).toHaveLength(2);
		expect(miString(body[1]!.type)).toBe("hw watchpoint");
	});

	it("target 退出:结果记录上会挂 reason —— 别假设 ^done 只有一个字段", () => {
		const r = parseRecord('40^done,reason="exited-normally",value="off"');
		expect(miString(r.results?.reason)).toBe("exited-normally");
		expect(miString(r.results?.value)).toBe("off");
	});
});

// ─── Cortex-M 解码 ───────────────────────────────────────────────────────────

describe("decodeCpuid", () => {
	it("M4 有可配置故障寄存器", () => {
		const c = decodeCpuid(0x410fc241);
		expect(c.partno).toBe(0xc24);
		expect(c.name).toBe("Cortex-M4");
		expect(c.hasConfigurableFaults).toBe(true);
	});

	it("M0+ 没有 —— 在它上面解 CFSR 等于解一堆零", () => {
		const c = decodeCpuid(0x410cc601);
		expect(c.name).toBe("Cortex-M0+");
		expect(c.hasConfigurableFaults).toBe(false);
	});

	it("未知核不假装认识", () => {
		expect(decodeCpuid(0x410f0ff0).name).toContain("unknown core");
	});
});

describe("decodeFault — 夹具固件实测出来的那几个 CFSR", () => {
	it("badptr:精确总线错误,BFAR 有效", () => {
		const d = decodeFault(0x00008200, 0x40000000, 0, 0xf0000000);
		expect(d.bfsr.map((f) => f.name)).toEqual(["PRECISERR", "BFARVALID"]);
		expect(d.faultAddress).toBe(0xf0000000);
		expect(d.imprecise).toBe(false);
		expect(d.summary).toContain("PRECISERR");
		expect(d.summary).toContain("0xf0000000");
	});

	it("stackovf:入栈时总线错误", () => {
		const d = decodeFault(0x00009200, 0x40000000, 0, 0x1ffffff0);
		expect(d.bfsr.map((f) => f.name)).toContain("STKERR");
		expect(d.summary).toContain("栈溢出");
	});

	it("nullcall:Thumb 位没置 1", () => {
		const d = decodeFault(0x00020000, 0x40000000, 0, 0);
		expect(d.ufsr.map((f) => f.name)).toEqual(["INVSTATE"]);
		expect(d.faultAddress).toBeUndefined();
	});

	it("unaligned / divzero / undefined instruction", () => {
		expect(decodeFault(0x01000000, 0, 0, 0).ufsr.map((f) => f.name)).toEqual(["UNALIGNED"]);
		expect(decodeFault(0x02000000, 0, 0, 0).ufsr.map((f) => f.name)).toEqual(["DIVBYZERO"]);
		expect(decodeFault(0x00010000, 0, 0, 0).ufsr.map((f) => f.name)).toEqual(["UNDEFINSTR"]);
	});

	it("BFARVALID=0 时绝不返回 BFAR —— 那是陈旧值,会冤枉无辜代码", () => {
		const d = decodeFault(0x00000200, 0, 0, 0xdeadbeef);
		expect(d.faultAddress).toBeUndefined();
		expect(d.summary).not.toContain("deadbeef");
	});

	it("IMPRECISERR:必须明说地址和 PC 都不可信", () => {
		const d = decodeFault(0x00000400, 0x40000000, 0, 0);
		expect(d.imprecise).toBe(true);
		expect(d.summary).toContain("非精确");
	});

	it("MPU 越权走 MMFAR", () => {
		const d = decodeFault(0x00000082, 0, 0x20008000, 0);
		expect(d.mmfsr.map((f) => f.name)).toEqual(["DACCVIOL", "MMARVALID"]);
		expect(d.faultAddress).toBe(0x20008000);
	});

	it("HFSR.FORCED 不是答案,只是指向 CFSR 的指针", () => {
		const d = decodeFault(0, 0x40000000, 0, 0);
		expect(d.hfsr.map((f) => f.name)).toEqual(["FORCED"]);
		expect(d.summary).toContain("CFSR 为 0");
	});

	it("向量表读失败", () => {
		expect(decodeFault(0, 0x00000002, 0, 0).hfsr.map((f) => f.name)).toEqual(["VECTTBL"]);
	});

	it("全零不是故障", () => {
		expect(decodeFault(0, 0, 0, 0).summary).toContain("不是故障");
	});
});

describe("decodeDfsr / decodeDhcsr / decodeException", () => {
	it("DFSR 区分断点、观察点和调试器暂停", () => {
		expect(decodeDfsr(0x2).map((f) => f.name)).toEqual(["BKPT"]);
		expect(decodeDfsr(0x4).map((f) => f.name)).toEqual(["DWTTRAP"]);
		expect(decodeDfsr(0x1).map((f) => f.name)).toEqual(["HALTED"]);
	});

	it("DHCSR 分得清 halted / 睡眠 / 锁死", () => {
		expect(decodeDhcsr(0x00030003).map((f) => f.name)).toEqual(["S_HALT"]);
		expect(decodeDhcsr(0x00070003).map((f) => f.name)).toEqual(["S_HALT", "S_SLEEP"]);
		expect(decodeDhcsr(0x000f0003).map((f) => f.name)).toContain("S_LOCKUP");
		expect(decodeDhcsr(0x02030003).map((f) => f.name)).toContain("S_RESET_ST");
	});

	it("ICSR.VECTACTIVE 认异常号", () => {
		expect(decodeException(0)).toMatchObject({ name: "Thread mode", inHandler: false });
		expect(decodeException(3)).toMatchObject({ name: "HardFault", inHandler: true });
		expect(decodeException(15)).toMatchObject({ name: "SysTick", inHandler: true });
		expect(decodeException(16 + 37)).toMatchObject({ name: "IRQ 37", inHandler: true });
	});
});

describe("decodeExcReturn", () => {
	it("0xFFFFFFFD:线程模式 + PSP + 基本帧", () => {
		expect(decodeExcReturn(0xfffffffd)).toEqual({
			stackPointer: "PSP",
			mode: "Thread",
			extendedFrame: false,
			valid: true,
		});
	});

	it("0xFFFFFFF1:handler 模式 + MSP", () => {
		expect(decodeExcReturn(0xfffffff1)).toMatchObject({ stackPointer: "MSP", mode: "Handler" });
	});

	it("0xFFFFFFF9:线程模式 + MSP", () => {
		expect(decodeExcReturn(0xfffffff9)).toMatchObject({ stackPointer: "MSP", mode: "Thread" });
	});

	it("0xFFFFFFED:带浮点的扩展帧", () => {
		expect(decodeExcReturn(0xffffffed)).toMatchObject({ stackPointer: "PSP", extendedFrame: true });
	});

	it("非法 EXC_RETURN 要能识别出来", () => {
		expect(decodeExcReturn(0x08001a3e).valid).toBe(false);
	});
});

describe("decodeStackedFrame", () => {
	it("八个字对号入座", () => {
		const f = decodeStackedFrame([1, 2, 3, 4, 12, 0x08001a11, 0x08001a3e, 0x61000000])!;
		expect(f.pc).toBe(0x08001a3e);
		expect(f.lr).toBe(0x08001a11);
		expect(f.r12).toBe(12);
		expect(f.padded).toBe(false);
	});

	it("xPSR bit 9 说明入栈时补了 4 字节对齐", () => {
		expect(decodeStackedFrame([0, 0, 0, 0, 0, 0, 0, 0x61000200])!.padded).toBe(true);
	});

	it("字数不够就返回 undefined,不猜", () => {
		expect(decodeStackedFrame([1, 2, 3])).toBeUndefined();
	});
});

describe("断点/观察点预算", () => {
	it("FP_CTRL 的 NUM_CODE 是拆成两段的", () => {
		expect(decodeBreakpointUnits(0x00000061)).toEqual({ total: 6, enabled: true });
		expect(decodeBreakpointUnits(0x00000041)).toEqual({ total: 4, enabled: true });
		// NUM_CODE = 0x14 = 20:高 3 位在 [14:12],低 4 位在 [7:4]
		expect(decodeBreakpointUnits(0x00001041)).toEqual({ total: 20, enabled: true });
		expect(decodeBreakpointUnits(0x00000060).enabled).toBe(false);
	});

	it("DWT_CTRL 的 NUMCOMP 在最高四位", () => {
		expect(decodeWatchpointUnits(0x40000000)).toBe(4);
		expect(decodeWatchpointUnits(0x20000000)).toBe(2);
	});
});

// ─── 渲染与预算 ──────────────────────────────────────────────────────────────

describe("渲染", () => {
	it("clip 一定标注截断,不做裸截断", () => {
		expect(clip("abc", 10)).toBe("abc");
		const c = clip("x".repeat(50), 10);
		expect(c.startsWith("x".repeat(10))).toBe(true);
		expect(c).toContain("共 50 字符");
	});

	it("hex 补齐宽度", () => {
		expect(hex(0x1a3e)).toBe("0x00001a3e");
		expect(hex(undefined)).toBe("?");
		expect(hex(0xffffffff)).toBe("0xffffffff");
	});

	it("没有源码信息时退回地址", () => {
		expect(renderFrame({ func: "??", addr: "0x08000100" }, 3)).toBe("#3 ??() at 0x08000100");
	});

	it("栈太深时掐掉尾巴并说清楚还有多少", () => {
		const frames = Array.from({ length: 30 }, (_, i) => ({ level: i, func: `f${i}`, file: "a.c", line: String(i) }));
		const out = renderFrames(frames);
		expect(out).toHaveLength(9);
		expect(out[8]).toContain("还有 22 帧");
	});
});

// ─── 语料回归:156 条真实抓包里挑出来会咬人的那几种 ─────────────────────────

describe("真实语料回归", () => {
	it("-stack-list-arguments 0 在 list 里放的是**裸 result**,不是 tuple", () => {
		// args=[name="n"] —— 和 --simple-values 的 args=[{name=..,value=..}] 形状不同
		const v = parseResults('stack-args=[frame={level="0",args=[name="n",name="acc"]}]');
		const frames = unwrapList(v["stack-args"], "frame");
		const args = unwrapList(frames[0]!.args);
		expect(args.map((a) => miString(a.name))).toEqual(["n", "acc"]);
	});

	it('func="??" 是字符串而不是缺字段 —— `if (frame.func)` 会在垃圾上通过', () => {
		const r = parseRecord('*stopped,frame={level="0",addr="0x20000104",func="??",arch="armv7"},thread-id="1"');
		const f = frameOf(miTuple(r.results?.frame))!;
		expect(f.func).toBe("??");
		expect(f.file).toBeUndefined();
		expect(renderFrame(f, 0)).toBe("#0 ??() at 0x20000104");
	});

	it("--simple-values 对聚合类型只给 type,不给 value —— 不能当成 <optimized out>", () => {
		const v = parseResults('variables=[{name="i",value="3"},{name="cfg",type="gpio_cfg_t"},{name="p",value="<optimized out>"}]');
		const vars = unwrapList(v.variables);
		expect(miString(vars[1]!.value)).toBeUndefined();
		expect(miString(vars[1]!.type)).toBe("gpio_cfg_t");
		expect(miString(vars[2]!.value)).toBe("<optimized out>");
	});

	it("token 是不透明的:前导零保留,而且可能超出 u32", () => {
		expect(parseRecord("007^done").token).toBe(7);
		expect(parseRecord("99999999999^done").token).toBe(99999999999);
	});

	it("同一层里 frame 深栈的每一帧都要留下,哪怕地址完全相同(递归)", () => {
		const frames = Array.from({ length: 14 }, (_, i) => `frame={level="${i}",addr="0x0000026a",func="rec"}`).join(",");
		const v = parseResults(`stack=[${frames}]`);
		const list = unwrapList(v.stack, "frame");
		expect(list).toHaveLength(14);
		expect(list.map((f) => miString(f.level))).toEqual(Array.from({ length: 14 }, (_, i) => String(i)));
	});

	it("反汇编里带前导制表符和 <UNDEFINED> 的指令", () => {
		const v = parseResults('asm_insns=[{address="0x000001f4",inst="\\t\\t@ <UNDEFINED> instruction: 0x000001f5"}]');
		expect(miString(unwrapList(v.asm_insns)[0]!.inst)).toBe("\t\t@ <UNDEFINED> instruction: 0x000001f5");
	});

	it("值是**显示串**,里面还有一层 C 转义 —— 反转义一次得到的是 gdb 的渲染,不是字节", () => {
		const v = parseResults('value="{a = 42, msg = \\"quote\\\\\\" tab\\\\t nl\\\\n end\\\\000\\"}"');
		// 第一层反转义之后,里面仍然是 \\" \\t \\n \\000 这些字面量
		expect(miString(v.value)).toBe('{a = 42, msg = "quote\\" tab\\t nl\\n end\\000"}');
	});

	it("目标退出走的是 =thread-group-exited,而且 exit-code 可能缺席 —— 这条路上没有 *stopped", () => {
		const withCode = parseRecord('=thread-group-exited,id="i1",exit-code="0"');
		expect(withCode.kind).toBe("notify");
		expect(miString(withCode.results?.["exit-code"])).toBe("0");
		const without = parseRecord('=thread-group-exited,id="i1"');
		expect(miString(without.results?.["exit-code"])).toBeUndefined();
	});
});
