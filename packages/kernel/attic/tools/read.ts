/**
 * read 工具。移植自 pi coding-agent/src/core/tools/read.ts。
 *
 * 与 pi 的差异:
 * - 文件访问走注入的 FileSystem,而不是 node:fs + ReadOperations(同一个可插拔目的)。
 * - 暂不支持图片:yoma 还没有 MIME 探测与图片压缩,先只读文本。接口预留在 ReadToolOptions。
 * - 去掉 TUI 渲染器。
 *
 * 给模型看的文案(description、截断提示、续读提示)与 pi 逐字一致 ——
 * 它们直接决定模型会不会用 offset 正确地把长文件读完。
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type FileSystem, formatSize, truncateHead } from "@yoma/agent";
import type { TruncationResult } from "@yoma/agent";
import { type Static, Type } from "typebox";
import { resolveReadPath } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	/** 绝对路径,给 UI 做"跟随定位"用。 */
	path?: string;
}

const encoder = new TextEncoder();

export function createReadToolDefinition(
	env: FileSystem,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const absolutePath = await resolveReadPath(env, path);
			if (signal?.aborted) throw new Error("Operation aborted");

			const readResult = await env.readTextFile(absolutePath, signal);
			if (!readResult.ok) throw new Error(readResult.error.message);
			const textContent = readResult.value;

			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			// 入参是 1-indexed,数组是 0-indexed。
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			// 用户显式给了 limit 就先按它切,否则交给 truncateHead 决定。
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined = { path: absolutePath };

			if (truncation.firstLineExceedsLimit) {
				// 单行就超了字节上限,给模型指一条 bash 兜底路。
				const firstLineSize = formatSize(encoder.encode(allLines[startLine] ?? "").byteLength);
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation, path: absolutePath };
			} else if (truncation.truncated) {
				// 发生截断,给出可执行的续读指令。
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation, path: absolutePath };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				// 用户的 limit 提前停了,但文件还有内容。
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}

export function createReadTool(env: FileSystem) {
	return wrapToolDefinition(createReadToolDefinition(env));
}
