/**
 * SCPI 传输层与客户端 —— 示波器(以及将来任何 SCPI 仪器)的通道。
 *
 * 两种传输,一个客户端:
 *  - TCP 原始套接字(Siglent 的 5025 口):`\n` 结尾的文本行、IEEE 488.2 定长块(`#<n><len>…`)、
 *    以及 `:PRINt?` 这种**没有块头**的裸图片,全部在客户端的字节缓冲区上解析,传输只负责"写"和"读下一段"。
 *  - USBTMC(node-usb 3:Rust/napi,自带各平台预编译,不装 libusb、不编译):报文按 EOM 分帧,`read()`
 *    返回一整条报文;客户端照样把它当字节流解析,于是两种传输走同一份帧解析代码。
 *
 * 纪律(全部实测于 SDS824X HD,固件 4.8.12.1.1.6.5):
 *  - 一次只有一条命令在飞(仪器只接一个客户端,响应按 FIFO 排队)。所有公开方法走同一把锁。
 *  - 查询超时之后,那条响应**仍会**在仪器的输出队列里等着,下一条查询会拿到上一条的答案(实测:
 *    截图超时后 `*IDN?` 读回来的是 PNG)。USBTMC 的 INITIATE_CLEAR 在这台机器上并不清掉它,
 *    所以超时后标记 `dirty`,下一次操作先 `drain()`:短超时连读到没有为止。TCP 的残留随连接一起消失。
 *  - 命令之间留 5ms(ngscopeclient 对 E11 协议机型的经验值);`:TIMebase:SCALe` 之类的"大命令"
 *    要等 ~500ms,那是驱动层(siglent.ts)的事。
 */
import net from "node:net";

export class ScpiTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScpiTimeoutError";
	}
}

export interface ScpiTransport {
	/** 人话:usb:<serial> / host:port */
	readonly label: string;
	write(bytes: Uint8Array): Promise<void>;
	/** 读下一段字节。TCP 是一个 chunk;USBTMC 是一整条报文。超时抛 ScpiTimeoutError。 */
	read(timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array>;
	/** 传输层能做的清障(USBTMC 的 INITIATE_CLEAR + 清 halt;TCP 丢掉已收未读的 chunk),返回丢掉的字节数。 */
	clear(): Promise<number>;
	close(): Promise<void>;
}

export type ScpiAddress = { kind: "usb"; serial?: string } | { kind: "tcp"; host: string; port: number };

export const SCPI_DEFAULT_PORT = 5025;

/** "usb" / "usb:<serial>" / "192.168.1.20" / "192.168.1.20:5025" / "scope.local" */
export function parseScpiAddress(value: string): ScpiAddress {
	const v = value.trim();
	if (!v) throw new Error("scope: empty address");
	if (/^usb(:|$)/i.test(v)) {
		const serial = v.slice(4).replace(/^:/, "").trim();
		return { kind: "usb", serial: serial || undefined };
	}
	// 主机名/IPv4 不含冒号;IPv6 必须加方括号,否则 "fe80::1" 会被拆成 host "fe80:" + port 1
	const m = /^(?:tcp:\/\/)?(?:\[([0-9A-Fa-f:.%]+)\]|([A-Za-z0-9_.-]+))(?::(\d{1,5}))?$/.exec(v);
	if (!m) {
		if (v.includes(":") && !v.replace(/^tcp:\/\//, "").startsWith("[")) throw new Error(`scope: cannot parse address "${value}" — IPv6 must be written [addr]:port`);
		throw new Error(`scope: cannot parse address "${value}" — use "usb", "usb:<serial>", or "<ip>[:5025]"`);
	}
	const host = m[1] ?? m[2]!;
	const port = m[3] ? Number(m[3]) : SCPI_DEFAULT_PORT;
	if (!(port > 0 && port < 65536)) throw new Error(`scope: bad port in "${value}"`);
	return { kind: "tcp", host, port };
}

export function formatScpiAddress(a: ScpiAddress): string {
	return a.kind === "usb" ? (a.serial ? `usb:${a.serial}` : "usb") : `${a.host}:${a.port}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		// 等待不该拖住进程退出
		(t as unknown as { unref?: () => void }).unref?.();
	});
}

function abortError(signal?: AbortSignal): Error {
	const reason = (signal as { reason?: unknown } | undefined)?.reason;
	return reason instanceof Error ? reason : new Error("scope: aborted");
}

// ─── TCP ────────────────────────────────────────────────────────────────────

export class TcpScpiTransport implements ScpiTransport {
	readonly label: string;
	private readonly chunks: Uint8Array[] = [];
	private waiter?: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void };
	private closed?: Error;

	private constructor(private readonly socket: net.Socket, host: string, port: number) {
		this.label = `${host}:${port}`;
		socket.on("data", (chunk: Buffer) => {
			const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			const w = this.waiter;
			if (w) {
				this.waiter = undefined;
				w.resolve(bytes);
			} else this.chunks.push(bytes);
		});
		socket.on("error", () => undefined); // close 必随其后
		socket.once("close", () => {
			this.closed = new Error(`scope: connection to ${this.label} closed`);
			const w = this.waiter;
			if (w) {
				this.waiter = undefined;
				w.reject(this.closed);
			}
		});
	}

	static connect(host: string, port: number, timeoutMs = 3000): Promise<TcpScpiTransport> {
		return new Promise((resolve, reject) => {
			const socket = net.connect({ host, port });
			socket.setNoDelay(true);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new ScpiTimeoutError(`scope: ${host}:${port} did not answer within ${timeoutMs} ms — is the scope on this network and powered? (Utility > I/O > LAN Config shows its IP)`));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.unref(); // 空闲连接不拖住进程
				resolve(new TcpScpiTransport(socket, host, port));
			});
			socket.once("error", (error: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				const why = error.code === "ECONNREFUSED"
					? `port ${port} refused — the SCPI socket port is 5025; if another client (web control page, EasyScopeX, a stuck session) is connected, close it — the scope accepts one client at a time`
					: error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH"
						? "host unreachable — is the scope on the same network? Check Utility > I/O > LAN Config on the scope"
						: error.message;
				reject(new Error(`scope: cannot connect to ${host}:${port}: ${why}`));
			});
		});
	}

	async write(bytes: Uint8Array): Promise<void> {
		if (this.closed) throw this.closed;
		await new Promise<void>((resolve, reject) => this.socket.write(bytes, (e) => (e ? reject(e) : resolve())));
	}

	read(timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
		const queued = this.chunks.shift();
		if (queued) return Promise.resolve(queued);
		if (this.closed) return Promise.reject(this.closed);
		if (signal?.aborted) return Promise.reject(abortError(signal));
		return new Promise((resolve, reject) => {
			const done = (fn: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiter = undefined;
				fn();
			};
			const timer = setTimeout(() => done(() => reject(new ScpiTimeoutError(`scope: no response from ${this.label} within ${timeoutMs} ms`))), timeoutMs);
			const onAbort = () => done(() => reject(abortError(signal)));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiter = { resolve: (b) => done(() => resolve(b)), reject: (e) => done(() => reject(e)) };
		});
	}

	async clear(): Promise<number> {
		let dropped = 0;
		for (const c of this.chunks) dropped += c.length;
		this.chunks.length = 0;
		return dropped;
	}

	async close(): Promise<void> {
		this.socket.destroy();
	}
}

// ─── USBTMC ─────────────────────────────────────────────────────────────────

export const SIGLENT_USB_VID = 0xf4ec;

/** node-usb 3 的 WebUSB 形状里我们用到的那一小截(动态 import,类型自己写,免得把整个 usb 拖进类型图)。 */
interface UsbEndpointLike {
	endpointNumber: number;
	direction: "in" | "out";
	type: "bulk" | "interrupt" | "isochronous";
	packetSize: number;
}
interface UsbDeviceLike {
	vendorId: number;
	productId: number;
	productName?: string;
	serialNumber?: string;
	opened: boolean;
	configuration?: { interfaces: { interfaceNumber: number; alternate: { interfaceClass: number; interfaceSubclass: number; endpoints: UsbEndpointLike[] } }[] };
	open(): Promise<void>;
	close(): Promise<void>;
	claimInterface(n: number): Promise<void>;
	releaseInterface(n: number): Promise<void>;
	clearHalt(direction: "in" | "out", endpoint: number): Promise<void>;
	controlTransferIn(setup: { requestType: "standard" | "class" | "vendor"; recipient: "device" | "interface" | "endpoint" | "other"; request: number; value: number; index: number }, length: number): Promise<{ status: string; data?: DataView }>;
	nativeTransferIn(endpoint: number, timeout: number, length: number): Promise<Uint8Array | null>;
	nativeTransferOut(endpoint: number, timeout: number, data: Uint8Array): Promise<number>;
}
interface UsbModuleLike {
	usb: { getDevices(): Promise<UsbDeviceLike[]> };
}

let usbModule: Promise<UsbModuleLike | undefined> | undefined;

/** node-usb 是可选能力:装不上(没有该平台的预编译包)时 USB 传输不可用,LAN 照常。 */
export function loadUsb(): Promise<UsbModuleLike | undefined> {
	if (!usbModule) {
		usbModule = import("usb").then(
			(m) => m as unknown as UsbModuleLike,
			() => undefined,
		);
	}
	return usbModule;
}

export interface UsbScopeInfo {
	vendorId: number;
	productId: number;
	product?: string;
	serial?: string;
}

/** 列出总线上的 Siglent 仪器(不打开,不占用)。 */
export async function listUsbScopes(): Promise<UsbScopeInfo[]> {
	const mod = await loadUsb();
	if (!mod) return [];
	const devices = await mod.usb.getDevices();
	return devices
		.filter((d) => d.vendorId === SIGLENT_USB_VID)
		.map((d) => ({ vendorId: d.vendorId, productId: d.productId, product: d.productName, serial: d.serialNumber }));
}

const USBTMC_DEV_DEP_MSG_OUT = 1;
const USBTMC_REQUEST_DEV_DEP_MSG_IN = 2;
const USBTMC_INITIATE_CLEAR = 5;
const USBTMC_CHECK_CLEAR_STATUS = 6;
/** 一次 REQUEST_DEV_DEP_MSG_IN 最多要多少字节:10 MB 的波形块分十几趟,USB2 实测 ~11 MB/s */
const USBTMC_CHUNK = 1 << 20;

export class UsbTmcTransport implements ScpiTransport {
	readonly label: string;
	private tag = 1;
	private constructor(
		private readonly device: UsbDeviceLike,
		private readonly iface: number,
		private readonly epOut: number,
		private readonly epIn: number,
		readonly serial: string | undefined,
		readonly product: string | undefined,
	) {
		this.label = serial ? `usb:${serial}` : "usb";
	}

	static async open(serial?: string): Promise<UsbTmcTransport> {
		const mod = await loadUsb();
		if (!mod) throw new Error('scope: USB transport unavailable — the "usb" module (node-usb) did not load on this machine. Connect the scope over LAN instead (address "<ip>:5025").');
		const all = (await mod.usb.getDevices()).filter((d) => d.vendorId === SIGLENT_USB_VID);
		if (all.length === 0) throw new Error("scope: no Siglent instrument on USB. Is the scope's rear USB Device port cabled to this computer and the scope powered? (LAN works too: give address \"<ip>:5025\".)");
		const device = serial ? all.find((d) => d.serialNumber === serial) : all[0]!;
		if (!device) throw new Error(`scope: no Siglent instrument with serial ${serial} on USB; present: ${all.map((d) => `${d.productName ?? "?"} ${d.serialNumber ?? "?"}`).join(", ")}`);
		try {
			await device.open();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`scope: cannot open ${device.productName ?? "Siglent"} ${device.serialNumber ?? ""} on USB: ${msg}. ${usbOpenHint()}`);
		}
		const cfg = device.configuration;
		const itf = cfg?.interfaces.find((i) => i.alternate.interfaceClass === 0xfe && i.alternate.interfaceSubclass === 3);
		if (!itf) {
			await device.close().catch(() => undefined);
			throw new Error(`scope: ${device.productName ?? "device"} has no USBTMC interface`);
		}
		const bulkOut = itf.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
		const bulkIn = itf.alternate.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
		if (!bulkOut || !bulkIn) {
			await device.close().catch(() => undefined);
			throw new Error("scope: USBTMC interface without bulk endpoints");
		}
		try {
			await device.claimInterface(itf.interfaceNumber);
		} catch (error) {
			await device.close().catch(() => undefined);
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`scope: cannot claim the USBTMC interface of ${device.productName ?? "the scope"}: ${msg}. ${usbOpenHint()}`);
		}
		return new UsbTmcTransport(device, itf.interfaceNumber, bulkOut.endpointNumber, bulkIn.endpointNumber, device.serialNumber, device.productName);
	}

	private nextTag(): number {
		const t = this.tag;
		this.tag = (this.tag % 255) + 1;
		return t;
	}

	async write(bytes: Uint8Array): Promise<void> {
		const tag = this.nextTag();
		const pad = (4 - (bytes.length % 4)) % 4;
		const buf = new Uint8Array(12 + bytes.length + pad);
		buf[0] = USBTMC_DEV_DEP_MSG_OUT;
		buf[1] = tag;
		buf[2] = ~tag & 0xff;
		new DataView(buf.buffer).setUint32(4, bytes.length, true);
		buf[8] = 1; // EOM
		buf.set(bytes, 12);
		await this.device.nativeTransferOut(this.epOut, 5000, buf);
	}

	async read(timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		let total = 0;
		// 一条报文最多拼 256 段(256 MB):EOM 永不置位的坏固件不能让这里转成死循环
		for (let i = 0; ; i++) {
			if (i >= 256) throw new Error("scope: USBTMC message never ended (EOM missing after 256 transfers)");
			if (signal?.aborted) throw abortError(signal);
			const tag = this.nextTag();
			const req = new Uint8Array(12);
			req[0] = USBTMC_REQUEST_DEV_DEP_MSG_IN;
			req[1] = tag;
			req[2] = ~tag & 0xff;
			new DataView(req.buffer).setUint32(4, USBTMC_CHUNK, true);
			await this.device.nativeTransferOut(this.epOut, 5000, req);
			let data: Uint8Array | null;
			try {
				data = await this.device.nativeTransferIn(this.epIn, timeoutMs, USBTMC_CHUNK + 12);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (/cancel|timed? ?out/i.test(msg)) throw new ScpiTimeoutError(`scope: no response over ${this.label} within ${timeoutMs} ms`);
				throw new Error(`scope: USB read failed: ${msg}`);
			}
			if (!data || data.length < 12) throw new Error("scope: short USBTMC header from the instrument");
			const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
			if (data.length < 12 + size) throw new Error(`scope: short USBTMC transfer (${data.length} of ${12 + size} bytes)`);
			const eom = (data[8]! & 1) !== 0;
			const payload = data.subarray(12, 12 + size);
			parts.push(payload);
			total += payload.length;
			if (eom) break;
		}
		if (parts.length === 1) return parts[0]!;
		const out = new Uint8Array(total);
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return out;
	}

	/** USBTMC 的标准清障(INITIATE_CLEAR / CHECK_CLEAR_STATUS / 清 OUT halt)。这台机器不清输出队列,drain 由客户端做。 */
	async clear(): Promise<number> {
		try {
			await this.device.controlTransferIn({ requestType: "class", recipient: "interface", request: USBTMC_INITIATE_CLEAR, value: 0, index: this.iface }, 1);
			for (let i = 0; i < 50; i++) {
				const r = await this.device.controlTransferIn({ requestType: "class", recipient: "interface", request: USBTMC_CHECK_CLEAR_STATUS, value: 0, index: this.iface }, 2);
				if (!r.data || r.data.getUint8(0) !== 2) break; // 2 = STATUS_PENDING
				await sleep(20);
			}
			await this.device.clearHalt("out", this.epOut);
		} catch {
			// 清障本身失败不致命:随后 drain 兜底
		}
		return 0;
	}

	async close(): Promise<void> {
		try {
			await this.device.releaseInterface(this.iface);
		} catch {
			// 已经释放
		}
		try {
			await this.device.close();
		} catch {
			// 已经关闭
		}
	}
}

function usbOpenHint(): string {
	switch (process.platform) {
		case "win32":
			return "On Windows the scope must be bound to the WinUSB driver (Zadig) for direct USB access, which replaces the Siglent/NI USBTMC driver — the LAN port (address \"<ip>:5025\") needs no driver at all and is the recommended route.";
		case "linux":
			return "On Linux add a udev rule for VID f4ec (e.g. SUBSYSTEM==\"usb\", ATTR{idVendor}==\"f4ec\", MODE=\"0666\") or run with permission to the device; if /dev/usbtmc0 exists the kernel usbtmc driver may hold it.";
		default:
			return "Is another program (EasyScopeX, a stuck session) holding the instrument? Unplug/replug the USB cable if so.";
	}
}

// ─── 客户端 ─────────────────────────────────────────────────────────────────

export interface ScpiClientOptions {
	/** 相邻命令之间的最小间隔(ms),默认 5 */
	interCommandMs?: number;
}

export interface ScpiQueryOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

const NL = 0x0a;
const HASH = 0x23;
const TEXT_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export class ScpiClient {
	private buf: Uint8Array = new Uint8Array(0);
	private chain: Promise<unknown> = Promise.resolve();
	private lastWrite = 0;
	private dirty = false;
	private closed = false;
	private readonly interCommandMs: number;

	constructor(readonly transport: ScpiTransport, options: ScpiClientOptions = {}) {
		this.interCommandMs = options.interCommandMs ?? 5;
	}

	get label(): string {
		return this.transport.label;
	}

	/** 串行化:仪器只有一条响应队列,并发查询会把答案串位。 */
	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async rawWrite(command: string): Promise<void> {
		if (this.closed) throw new Error(`scope: connection ${this.label} is closed`);
		const gap = this.interCommandMs - (Date.now() - this.lastWrite);
		if (gap > 0) await sleep(gap);
		await this.transport.write(encoder.encode(command.endsWith("\n") ? command : `${command}\n`));
		this.lastWrite = Date.now();
	}

	private async fill(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const chunk = await this.transport.read(timeoutMs, signal);
		if (this.buf.length === 0) {
			this.buf = chunk;
			return;
		}
		const next = new Uint8Array(this.buf.length + chunk.length);
		next.set(this.buf);
		next.set(chunk, this.buf.length);
		this.buf = next;
	}

	private take(n: number): Uint8Array {
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return out;
	}

	private skipNewlines(): void {
		let i = 0;
		while (i < this.buf.length && (this.buf[i] === NL || this.buf[i] === 0x0d)) i++;
		if (i) this.buf = this.buf.subarray(i);
	}

	/** 超时留下的残余响应:连读到没有为止。 */
	private async drainLocked(idleMs = 300): Promise<number> {
		let dropped = this.buf.length;
		this.buf = new Uint8Array(0);
		dropped += await this.transport.clear();
		for (let i = 0; i < 64; i++) {
			try {
				const chunk = await this.transport.read(idleMs);
				dropped += chunk.length;
			} catch (error) {
				if (error instanceof ScpiTimeoutError) break;
				throw error;
			}
		}
		this.dirty = false;
		return dropped;
	}

	private async prepare(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError(signal);
		if (this.dirty) await this.drainLocked();
	}

	/** 写一条不期待响应的命令。 */
	command(command: string, options: ScpiQueryOptions = {}): Promise<void> {
		return this.locked(async () => {
			await this.prepare(options.signal);
			await this.rawWrite(command);
		});
	}

	/** 文本查询:到第一个 `\n` 为止,返回去掉首尾空白的字符串。 */
	query(command: string, options: ScpiQueryOptions = {}): Promise<string> {
		const timeoutMs = options.timeoutMs ?? TEXT_TIMEOUT_MS;
		return this.locked(async () => {
			await this.prepare(options.signal);
			this.skipNewlines();
			await this.rawWrite(command);
			try {
				for (;;) {
					// 上一个块的 \n\n 可能晚到一段,不能把它当成这条查询的答案:空行一律跳过
					this.skipNewlines();
					const nl = this.buf.indexOf(NL);
					if (nl >= 0) {
						const line = this.take(nl + 1);
						return decoder.decode(line).trim();
					}
					await this.fill(timeoutMs, options.signal);
				}
			} catch (error) {
				// 任何失败(超时、中止、帧不对)之后,仪器那边的答案都可能还在路上:丢掉本地半截缓冲,下次先 drain
				this.dirty = true;
				this.buf = new Uint8Array(0);
				throw error instanceof ScpiTimeoutError ? new ScpiTimeoutError(`${error.message} (query ${command.trim()})`) : error;
			}
		});
	}

	/** IEEE 488.2 定长块查询(`#<n><len><bytes>`),返回块内字节。容忍块前的 `C1:WF ` 之类前缀与块后的 `\n\n`。 */
	queryBlock(command: string, options: ScpiQueryOptions & { headerTimeoutMs?: number } = {}): Promise<Uint8Array> {
		return this.locked(async () => {
			await this.prepare(options.signal);
			this.skipNewlines();
			await this.rawWrite(command);
			// 块头要等仪器准备数据(深存储要几百毫秒);块体按长度折算(≥ 4 MB/s),两段超时分开给
			const headerTimeout = options.headerTimeoutMs ?? options.timeoutMs ?? TEXT_TIMEOUT_MS;
			try {
				let header: { start: number; digits: number; length: number } | undefined;
				for (;;) {
					header = findBlockHeader(this.buf);
					if (header) break;
					if (this.buf.length > 256) throw new Error(`scope: expected a binary block for ${command.trim()} but got ${JSON.stringify(decoder.decode(this.buf.subarray(0, 64)))}`);
					await this.fill(headerTimeout, options.signal);
				}
				const { start, digits, length } = header;
				const payloadAt = start + 2 + digits;
				const need = payloadAt + length;
				const dataTimeout = options.timeoutMs ?? Math.max(TEXT_TIMEOUT_MS, 2000 + Math.ceil((length / 4e6) * 1000));
				while (this.buf.length < need) await this.fill(dataTimeout, options.signal);
				this.take(payloadAt);
				const payload = this.take(length).slice(); // 拷贝:缓冲区随后会被复用
				this.skipNewlines();
				return payload;
			} catch (error) {
				this.dirty = true;
				this.buf = new Uint8Array(0);
				throw error instanceof ScpiTimeoutError ? new ScpiTimeoutError(`${error.message} (block query ${command.trim()})`) : error;
			}
		});
	}

	/**
	 * 无块头的裸响应(`:PRINt? PNG`):由 `complete(buf)` 判断已收齐的长度。
	 * USBTMC 一条报文就是全部;TCP 靠 PNG 的 IEND 或 BMP 头里的总长。
	 */
	queryRaw(command: string, complete: (buf: Uint8Array) => number | undefined, options: ScpiQueryOptions = {}): Promise<Uint8Array> {
		const timeoutMs = options.timeoutMs ?? 10_000;
		return this.locked(async () => {
			await this.prepare(options.signal);
			this.skipNewlines();
			await this.rawWrite(command);
			try {
				for (;;) {
					this.skipNewlines();
					const n = complete(this.buf);
					if (n !== undefined) {
						const out = this.take(n).slice();
						this.skipNewlines();
						return out;
					}
					await this.fill(timeoutMs, options.signal);
				}
			} catch (error) {
				this.dirty = true;
				this.buf = new Uint8Array(0);
				throw error instanceof ScpiTimeoutError ? new ScpiTimeoutError(`${error.message} (raw query ${command.trim()})`) : error;
			}
		});
	}

	/** 主动清障:丢掉仪器端的残余输出。 */
	drain(idleMs = 300): Promise<number> {
		return this.locked(() => this.drainLocked(idleMs));
	}

	/** `:SYSTem:ERRor?` —— 这台固件支持(-224 非法参数、-113 未定义命令头);老固件会超时,那就当没有。 */
	async checkError(timeoutMs = 800): Promise<{ code: number; message: string } | undefined> {
		try {
			const line = await this.query(":SYSTem:ERRor?", { timeoutMs });
			const m = /^(-?\d+)\s*,\s*"?(.*?)"?$/.exec(line);
			if (!m) return undefined;
			const code = Number(m[1]);
			return code === 0 ? undefined : { code, message: m[2] ?? line };
		} catch (error) {
			if (error instanceof ScpiTimeoutError) {
				await this.drain(150).catch(() => undefined);
				return undefined;
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.locked(() => this.transport.close()).catch(() => undefined);
	}
}

/** 在缓冲区里找 `#<n><len>` 块头;块前允许 `C1:WF ` 这类旧式前缀(实测在无波形时出现)。 */
export function findBlockHeader(buf: Uint8Array): { start: number; digits: number; length: number } | undefined {
	const limit = Math.min(buf.length, 64);
	for (let i = 0; i < limit; i++) {
		if (buf[i] !== HASH) continue;
		const d = buf[i + 1];
		if (d === undefined) return undefined; // 位数还没到
		if (d < 0x31 || d > 0x39) continue; // '#0' 不定长块不支持,继续找
		const digits = d - 0x30;
		if (buf.length < i + 2 + digits) return undefined;
		let length = 0;
		for (let k = 0; k < digits; k++) {
			const c = buf[i + 2 + k]!;
			if (c < 0x30 || c > 0x39) return undefined;
			length = length * 10 + (c - 0x30);
		}
		return { start: i, digits, length };
	}
	return undefined;
}

/** PNG:签名 + 逐块走到 IEND;返回整幅长度,没收齐返回 undefined,不是 PNG 抛错。 */
export function pngComplete(buf: Uint8Array): number | undefined {
	if (buf.length < 8) return undefined;
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error(`scope: expected a PNG image but got ${JSON.stringify(decoder.decode(buf.subarray(0, 48)))}`);
	let o = 8;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	for (;;) {
		if (o + 8 > buf.length) return undefined;
		const len = dv.getUint32(o, false);
		const type = String.fromCharCode(buf[o + 4]!, buf[o + 5]!, buf[o + 6]!, buf[o + 7]!);
		const end = o + 12 + len;
		if (end > buf.length) return undefined;
		if (type === "IEND") return end;
		o = end;
	}
}

/** BMP:`BM` + 偏移 2 处的小端总长。 */
export function bmpComplete(buf: Uint8Array): number | undefined {
	if (buf.length < 6) return undefined;
	if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error("scope: expected a BMP image");
	const total = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(2, true);
	return buf.length >= total ? total : undefined;
}

/** 打开一个地址对应的传输并包成客户端。 */
export async function openScpi(address: ScpiAddress, options: { connectTimeoutMs?: number } & ScpiClientOptions = {}): Promise<ScpiClient> {
	const transport = address.kind === "usb"
		? await UsbTmcTransport.open(address.serial)
		: await TcpScpiTransport.connect(address.host, address.port, options.connectTimeoutMs);
	return new ScpiClient(transport, options);
}
