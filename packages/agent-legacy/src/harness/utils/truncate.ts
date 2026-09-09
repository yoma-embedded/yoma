/**
 * 工具输出的共享截断工具。
 *
 * 截断由两个互相独立的上限决定 —— 谁先被撞到谁生效:
 * - 行数上限(默认 2000 行)
 * - 字节上限(默认 50KB)
 *
 * 永远不返回半行(bash 的尾部截断是唯一的例外)。
 *
 * 本文件刻意保持浏览器安全:字节数优先用运行时的 Buffer,
 * 没有 Buffer 时退化成手算 UTF-8 长度,不 import node:*。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // grep 单条匹配行的最大字符数

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 撞到的是哪个上限:"lines"、"bytes",未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 输出中完整行的数量 */
	outputLines: number;
	/** 输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被截成了半行(仅尾部截断的边界情况) */
	lastLinePartial: boolean;
	/** 第一行本身是否就超过了字节上限(仅头部截断) */
	firstLineExceedsLimit: boolean;
	/** 实际生效的行数上限 */
	maxLines: number;
	/** 实际生效的字节上限 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 最大行数(默认 2000) */
	maxLines?: number;
	/** 最大字节数(默认 50KB) */
	maxBytes?: number;
}

const nonAsciiPattern = /[^\x00-\x7f]/;

/**
 * 手算 UTF-8 字节数。
 *
 * 与 pi 的差异:pi 在有 Buffer 的运行时优先走 `Buffer.byteLength`。这里刻意不这么做 ——
 * Bun 1.3 的 `Buffer.byteLength("aa\ud800", "utf8")` 返回 4,而 `Buffer.from` 实际编码出
 * 5 字节(孤立代理项要变成 3 字节的 U+FFFD)。Node 返回 5。yoma 跑在 Bun 上,
 * 用它会让尾部截断在孤立代理项附近算错边界,所以统一走这条自己算的路。
 * 顺带的好处:本文件彻底不碰 Buffer,保持浏览器安全。
 */
function utf8ByteLength(content: string): number {
	// 纯 ASCII 前缀可以直接按长度算,只对第一个非 ASCII 字符之后逐字符累加。
	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				// 成对代理项 = 一个补充平面字符,占 4 字节。
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	// 末尾换行不算作额外一行。
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function replaceUnpairedSurrogates(content: string): string {
	let output = "";
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 < content.length) {
				const next = content.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					output += content[i]! + content[i + 1]!;
					i++;
					continue;
				}
			}
			output += "�";
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			output += "�";
		} else {
			output += content[i]!;
		}
	}
	return output;
}

/**
 * 把字节数格式化成人类可读的大小。
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断(保留前 N 行 / 前 N 字节)。适合读文件——你想看开头。
 *
 * 永远不返回半行。如果第一行本身就超过字节上限,
 * 返回空内容并置 firstLineExceedsLimit=true(调用方据此给模型一个 bash 兜底建议)。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 两个上限都没撞到,原样返回。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 走到这里说明至少撞了一个上限,内容非空,所以 lines[0] 必然存在。
	const firstLineBytes = utf8ByteLength(lines[0]!);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集能塞下的完整行。
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i]!;
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 是换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 因行数上限退出的情况。
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从尾部截断(保留后 N 行 / 后 N 字节)。适合 bash 输出——你想看结尾的错误和最终结果。
 *
 * 当原内容的最后一行本身超过字节上限时,可能返回半行(这是唯一允许半行的地方)。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾往回走。
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i]!;
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 是换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边界情况:一行都还没收进来,而这一行就超了上限 —— 取它的尾巴(半行)。
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 把字符串截到字节上限以内(从尾部保留)。正确处理多字节 UTF-8:
 * 从后往前按"字符"退,绝不在一个字符中间切开;切出来的孤立代理项换成 U+FFFD。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";

	let outputBytes = 0;
	let start = str.length;
	let needsReplacement = false;
	for (let i = str.length; i > 0; ) {
		let characterStart = i - 1;
		const code = str.charCodeAt(characterStart);
		let characterBytes: number;
		let unpairedSurrogate = false;
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				// 低位代理项前面就是高位代理项,合成一个 4 字节字符。
				characterStart--;
				characterBytes = 4;
			} else {
				characterBytes = 3;
				unpairedSurrogate = true;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		needsReplacement ||= unpairedSurrogate;
		i = characterStart;
	}

	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/**
 * 把单行截到最大字符数,并追加 [truncated] 后缀。用于 grep 的匹配行。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
