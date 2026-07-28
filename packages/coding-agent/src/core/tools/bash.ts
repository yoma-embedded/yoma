/**
 * bash 工具。移植自 pi coding-agent/src/core/tools/bash.ts。
 *
 * 与 pi 的差异:
 * - 命令执行走注入的 ExecutionEnv.exec(pi 是自己 spawn + BashOperations)。
 * - 输出累积用内核里的 executeShellWithCapture,而不是 pi 的 OutputAccumulator ——
 *   两者职责相同(有界尾巴 + 超限旁落临时文件),前者已经在 M6 里移植并测过。
 * - 去掉 TUI 渲染器、PI_* 会话环境变量注入、spawnHook(要等扩展系统)。
 *
 * 给模型看的文案(截断脚注、退出码/超时/中断的措辞)与 pi 逐字一致。
 */
import {
	DEFAULT_MAX_BYTES,
	type ExecutionEnv,
	executeShellWithCapture,
	formatSize,
	type ShellCaptureProgress,
	type TruncationResult,
} from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashToolOptions {
	/** 拼在每条命令前面的前缀(例如 shell 初始化命令)。 */
	commandPrefix?: string;
}

/** onUpdate 的节流间隔:token 级刷新会把 UI 打爆,100ms 攒一批。 */
const BASH_UPDATE_THROTTLE_MS = 100;

function formatOutput(
	progress: ShellCaptureProgress,
	emptyText = "(no output)",
): { text: string; details: BashToolDetails | undefined } {
	const truncation = progress.truncation;
	let text = progress.output || emptyText;
	let details: BashToolDetails | undefined;
	if (truncation.truncated) {
		details = { truncation, fullOutputPath: progress.fullOutputPath };
		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;
		// 三种截断形态各有各的提示语,都要告诉模型全量在哪,它才能用 bash 回查。
		if (truncation.lastLinePartial) {
			const lastLineSize = formatSize(progress.lastLineBytes);
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${progress.fullOutputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${progress.fullOutputPath}]`;
		} else {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${progress.fullOutputPath}]`;
		}
	}
	return { text, details };
}

function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

export function createBashToolDefinition(
	env: ExecutionEnv,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const commandPrefix = options?.commandPrefix;
	return {
		name: "bash",
		label: "bash",
		description: "Execute a bash command and return its output.",
		promptSnippet: "Run shell commands",
		promptGuidelines: [
			"Use bash for running commands, tests, and builds.",
			"Prefer the read tool over cat/sed, and the grep tool over grep/rg, when inspecting files.",
		],
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;

			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			let latestProgress: ShellCaptureProgress | undefined;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty || !latestProgress) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				onUpdate({
					content: [{ type: "text", text: latestProgress.output || "" }],
					details: {
						truncation: latestProgress.truncation.truncated ? latestProgress.truncation : undefined,
						fullOutputPath: latestProgress.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			// 先发一个空的,UI 才知道"开始执行了"而不是卡住。
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			try {
				const captured = await executeShellWithCapture(env, resolvedCommand, {
					timeout,
					abortSignal: signal,
					returnExecutionErrors: true,
					onChunk: (_chunk, getProgress) => {
						latestProgress = getProgress();
						scheduleOutputUpdate();
					},
				});
				if (!captured.ok) throw new Error(captured.error.message);

				const result = captured.value;
				latestProgress = result;
				updateDirty = true;
				clearUpdateTimer();
				emitOutputUpdate();

				if (result.cancelled) {
					const { text } = formatOutput(result, "");
					throw new Error(appendStatus(text, "Command aborted"));
				}
				if (result.executionError) {
					const { text } = formatOutput(result, "");
					if (result.executionError.code === "timeout") {
						// ExecutionError 的 timeout 消息形如 "timeout:<秒数>"。
						const timeoutSecs = result.executionError.message.split(":")[1] ?? String(timeout);
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw new Error(appendStatus(text, result.executionError.message));
				}

				const { text: outputText, details } = formatOutput(result);
				// 非零退出码在 pi 里是"工具失败",这样模型能立刻看到并纠正。
				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					throw new Error(appendStatus(outputText, `Command exited with code ${result.exitCode}`));
				}
				return { content: [{ type: "text" as const, text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
	};
}

export function createBashTool(env: ExecutionEnv, options?: BashToolOptions) {
	return wrapToolDefinition(createBashToolDefinition(env, options));
}
