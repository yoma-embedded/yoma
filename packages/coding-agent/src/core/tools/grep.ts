/**
 * grep 工具。移植自 pi coding-agent/src/core/tools/grep.ts。
 *
 * 和 pi 一样**用 ripgrep**,不自己写遍历 —— 忽略规则(.gitignore)、二进制探测、
 * 编码处理这些 rg 已经做对了,重写一遍只会做错。
 *
 * 与 pi 的差异:
 * - pi 用 ensureTool("rg", true) 按需下载 rg;my-pi 只在 PATH 上找,找不到就明确报错
 *   (下载器是 369 行的独立设施,等真需要再补)。
 * - 进程执行走注入的 ExecutionEnv.exec,而不是直接 spawn。
 * - 达到匹配上限时用内部 AbortController 掐掉 rg,对应 pi 的 child.kill()。
 */
import {
	DEFAULT_MAX_BYTES,
	type ExecutionEnv,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "@yoma/my-pi";
import { existsSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

export interface GrepToolOptions {
	/** ripgrep 可执行文件路径。默认在 PATH 上找。 */
	rgPath?: string;
}

/** POSIX 单引号包裹,内部的单引号用 '"'"' 转义。 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function findRipgrep(env: ExecutionEnv, configured?: string): Promise<string | null> {
	if (configured) return configured;
	const result = await env.exec("command -v rg");
	if (!result.ok || result.value.exitCode !== 0) return null;
	const found = result.value.stdout.trim().split("\n")[0];
	return found || null;
}

/**
 * Whether this tool can work at all here — checked at REGISTRATION, not at
 * call time, so a machine without ripgrep simply doesn't advertise `grep`.
 *
 * Offering a tool that always throws is worse than offering nothing. The model
 * spends calls on it, and `buildSystemPrompt` only emits its "use bash for ls,
 * rg, find" fallback when grep is ABSENT — so registering a broken grep also
 * deletes the advice that would have routed around it. Twice, then, the model
 * pays for a capability that was never there.
 *
 * Synchronous on purpose: the tool factories are sync, and a PATH scan is a
 * handful of stat calls.
 */
export function ripgrepAvailable(configured?: string): boolean {
	if (configured) return existsSync(configured);
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	return (process.env.PATH ?? "")
		.split(path.delimiter)
		.some((dir) => dir && existsSync(path.join(dir, exe)));
}

function relativeFrom(searchPath: string, filePath: string): string {
	// rg 的输出路径是我们传进去的 searchPath 的延伸,直接做前缀剥离即可,不需要 node:path。
	const prefix = searchPath.endsWith("/") ? searchPath : `${searchPath}/`;
	if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
	const lastSlash = filePath.lastIndexOf("/");
	return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

interface RgMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

export function createGrepToolDefinition(
	env: ExecutionEnv,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with ripgrep. Returns matching lines with file paths and line numbers. Respects .gitignore.",
		promptSnippet: "Search file contents",
		promptGuidelines: ["Use grep to search file contents instead of bash grep or rg."],
		parameters: grepSchema,
		async execute(_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const rgPath = await findRipgrep(env, options?.rgPath);
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available on PATH. Install it, or configure grep with an explicit rgPath.");
			}

			const searchPath = await resolveToCwd(env, searchDir || ".");
			const info = await env.fileInfo(searchPath);
			if (!info.ok) throw new Error(`Path not found: ${searchPath}`);
			const isDirectory = info.value.kind === "directory";

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

			const args = ["--json", "--line-number", "--color=never", "--hidden"];
			if (ignoreCase) args.push("--ignore-case");
			if (literal) args.push("--fixed-strings");
			if (glob) args.push("--glob", glob);
			args.push("--", pattern, searchPath);
			const command = [rgPath, ...args].map(shellQuote).join(" ");

			// rg 的输出可能很大,凑够 limit 就掐掉进程 —— 对应 pi 的 child.kill()。
			const controller = new AbortController();
			let killedDueToLimit = false;
			const onOuterAbort = () => controller.abort();
			signal?.addEventListener("abort", onOuterAbort, { once: true });

			const matches: RgMatch[] = [];
			let matchLimitReached = false;
			let linesTruncated = false;
			let pending = "";

			const consumeLine = (line: string): void => {
				if (!line.trim() || matches.length >= effectiveLimit) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type !== "match") return;
				const filePath = event.data?.path?.text;
				const lineNumber = event.data?.line_number;
				const lineText = event.data?.lines?.text;
				if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
				if (matches.length >= effectiveLimit) {
					matchLimitReached = true;
					killedDueToLimit = true;
					controller.abort();
				}
			};

			let result: Awaited<ReturnType<ExecutionEnv["exec"]>>;
			try {
				result = await env.exec(command, {
					abortSignal: controller.signal,
					onStdout: (chunk) => {
						// rg --json 是 JSONL,按 \n 切;最后半行留到下一块。
						pending += chunk;
						let newlineIndex = pending.indexOf("\n");
						while (newlineIndex !== -1) {
							consumeLine(pending.slice(0, newlineIndex));
							pending = pending.slice(newlineIndex + 1);
							newlineIndex = pending.indexOf("\n");
						}
					},
				});
			} finally {
				signal?.removeEventListener("abort", onOuterAbort);
			}
			if (pending) consumeLine(pending);

			if (signal?.aborted) throw new Error("Operation aborted");
			if (!result.ok && !killedDueToLimit) {
				throw new Error(result.error.message);
			}
			// rg 的退出码 1 表示"没有匹配",不是错误。
			if (result.ok && result.value.exitCode !== 0 && result.value.exitCode !== 1) {
				const stderr = result.value.stderr.trim();
				throw new Error(stderr || `ripgrep exited with code ${result.value.exitCode}`);
			}

			if (matches.length === 0) {
				return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
			}

			const formatPath = (filePath: string): string =>
				isDirectory ? relativeFrom(searchPath, filePath) : (filePath.split("/").pop() ?? filePath);

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					const content = await env.readTextFile(filePath);
					lines = content.ok ? content.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const outputLines: string[] = [];
			for (const match of matches) {
				if (contextValue === 0 && match.lineText !== undefined) {
					// 无上下文时 rg 已经把匹配行给了我们,不用回读文件。
					const relativePath = formatPath(match.filePath);
					const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
					continue;
				}
				const relativePath = formatPath(match.filePath);
				const lines = await getFileLines(match.filePath);
				if (!lines.length) {
					outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
					continue;
				}
				const start = Math.max(1, match.lineNumber - contextValue);
				const end = Math.min(lines.length, match.lineNumber + contextValue);
				for (let current = start; current <= end; current++) {
					const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					// 匹配行用 `:`,上下文行用 `-`,与 GNU grep 的惯例一致。
					if (current === match.lineNumber) outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
					else outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
				}
			}

			const rawOutput = outputLines.join("\n");
			// 只按字节截断:行数已经被 match limit 管住了。
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = {};
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text" as const, text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

export function createGrepTool(env: ExecutionEnv, options?: GrepToolOptions) {
	return wrapToolDefinition(createGrepToolDefinition(env, options));
}
