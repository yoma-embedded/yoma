/**
 * 最小 zip 读取器:只读中央目录 + inflateRaw,够读 .dsl(DSView 会话文件)。
 *
 * 不引第三方 zip 库的理由:.dsl 的条目只有 stored/deflate 两种压缩,条目名是 ASCII,
 * 没有加密、没有分卷;Node 自带 inflateRawSync。依赖一个通用 zip 库换来的是我们用不到的
 * 八成功能和一份要钉版本的 package.json 改动。zip64(我们自己的引擎用 zipOpenNewFileInZip64
 * 写,minizip 会在需要时补 0x0001 扩展字段)这里认。
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	name: string;
	compressedSize: number;
	uncompressedSize: number;
	method: number;
	localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipFile {
	readonly entries = new Map<string, ZipEntry>();

	constructor(private readonly buf: Buffer) {
		this.parse();
	}

	private parse(): void {
		const b = this.buf;
		// EOCD 在文件尾部,注释最长 65535 字节
		const minPos = Math.max(0, b.length - 22 - 65535);
		let eocd = -1;
		for (let i = b.length - 22; i >= minPos; i--) {
			if (b.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
		}
		if (eocd < 0) throw new Error("不是 zip 文件(找不到中央目录结尾)");
		let count = b.readUInt16LE(eocd + 10);
		let cdOffset: number = b.readUInt32LE(eocd + 16);
		let cdSize: number = b.readUInt32LE(eocd + 12);
		// zip64
		if ((count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && b.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
			const eocd64 = Number(b.readBigUInt64LE(eocd - 20 + 8));
			if (b.readUInt32LE(eocd64) !== SIG_EOCD64) throw new Error("zip64 结尾记录损坏");
			count = Number(b.readBigUInt64LE(eocd64 + 32));
			cdSize = Number(b.readBigUInt64LE(eocd64 + 40));
			cdOffset = Number(b.readBigUInt64LE(eocd64 + 48));
		}
		let p = cdOffset;
		for (let i = 0; i < count; i++) {
			if (b.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`中央目录第 ${i} 项损坏`);
			const method = b.readUInt16LE(p + 10);
			let compressedSize: number = b.readUInt32LE(p + 20);
			let uncompressedSize: number = b.readUInt32LE(p + 24);
			const nameLen = b.readUInt16LE(p + 28);
			const extraLen = b.readUInt16LE(p + 30);
			const commentLen = b.readUInt16LE(p + 32);
			let localHeaderOffset: number = b.readUInt32LE(p + 42);
			const name = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
			// zip64 扩展字段(0x0001):按需出现的字段顺序是 uncompressed, compressed, offset
			let e = p + 46 + nameLen;
			const extraEnd = e + extraLen;
			while (e + 4 <= extraEnd) {
				const id = b.readUInt16LE(e);
				const len = b.readUInt16LE(e + 2);
				if (id === 0x0001) {
					let q = e + 4;
					if (uncompressedSize === 0xffffffff && q + 8 <= e + 4 + len) { uncompressedSize = Number(b.readBigUInt64LE(q)); q += 8; }
					if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) { compressedSize = Number(b.readBigUInt64LE(q)); q += 8; }
					if (localHeaderOffset === 0xffffffff && q + 8 <= e + 4 + len) { localHeaderOffset = Number(b.readBigUInt64LE(q)); q += 8; }
				}
				e += 4 + len;
			}
			this.entries.set(name, { name, compressedSize, uncompressedSize, method, localHeaderOffset });
			p += 46 + nameLen + extraLen + commentLen;
		}
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	read(name: string): Buffer {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`zip 里没有条目 ${name}`);
		const b = this.buf;
		const p = entry.localHeaderOffset;
		if (b.readUInt32LE(p) !== SIG_LOCAL) throw new Error(`条目 ${name} 的本地头损坏`);
		const nameLen = b.readUInt16LE(p + 26);
		const extraLen = b.readUInt16LE(p + 28);
		const start = p + 30 + nameLen + extraLen;
		const data = b.subarray(start, start + entry.compressedSize);
		if (entry.method === 0) return Buffer.from(data);
		if (entry.method === 8) return inflateRawSync(data);
		throw new Error(`条目 ${name} 用了不支持的压缩方式 ${entry.method}`);
	}
}
