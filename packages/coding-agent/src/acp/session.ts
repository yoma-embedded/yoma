/**
 * 一个 ACP 会话 = 一个 AgentHarness + 一条到客户端(Zed)的事件翻译管线。
 *
 * 翻译表(左边是 my-pi 的 harness 事件,右边是 ACP 的 session/update):
 *   message_update(text_delta)      → agent_message_chunk
 *   message_update(thinking_delta)  → agent_thought_chunk
 *   tool_execution_start            → tool_call        (status: in_progress)
 *   tool_execution_end              → tool_call_update (status: completed / failed)
 */
import type { AgentHarness, AgentHarnessEvent } from "@yoma/my-pi";
import type { EditToolDetails } from "../core/tools/edit.ts";
import type { ReadToolDetails } from "../core/tools/read.ts";
import type { WriteToolDetails } from "../core/tools/write.ts";

/** ACP 的工具种类,决定 Zed 用什么图标和展示方式。 */
export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

const TOOL_KINDS: Record<string, AcpToolKind> = {
	read: "read",
	write: "edit",
	edit: "edit",
	bash: "execute",
	grep: "search",
};

export function toolKindOf(toolName: string): AcpToolKind {
	return TOOL_KINDS[toolName] ?? "other";
}

/** 工具调用在 Zed 里显示的标题。 */
export function toolTitleOf(toolName: string, args: unknown): string {
	const input = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "read":
			return typeof input.path === "string" ? `Read ${input.path}` : "Read";
		case "write":
			return typeof input.path === "string" ? `Write ${input.path}` : "Write";
		case "edit":
			return typeof input.path === "string" ? `Edit ${input.path}` : "Edit";
		case "bash":
			return typeof input.command === "string" ? `$ ${input.command}` : "Run command";
		case "grep":
			return typeof input.pattern === "string" ? `Search /${input.pattern}/` : "Search";
		default:
			return toolName;
	}
}

/** 从工具参数里挖出受影响的文件,Zed 会用它做"跟随定位"。 */
export function toolLocationsOf(details: unknown, args: unknown): Array<{ path: string; line?: number }> {
	const fromDetails = details as (ReadToolDetails & EditToolDetails & WriteToolDetails) | undefined;
	if (fromDetails?.path) {
		const line = fromDetails.firstChangedLine;
		return [line === undefined ? { path: fromDetails.path } : { path: fromDetails.path, line }];
	}
	const input = (args ?? {}) as Record<string, unknown>;
	return typeof input.path === "string" ? [{ path: input.path }] : [];
}

/**
 * 工具结果转成 ACP 的 tool_call content。
 * edit 走结构化 diff —— Zed 会画成真正的 diff 视图,而不是一段纯文本。
 */
export function toolContentOf(
	toolName: string,
	details: unknown,
	text: string,
): Array<
	| { type: "content"; content: { type: "text"; text: string } }
	| { type: "diff"; path: string; oldText: string | null; newText: string }
> {
	if (toolName === "edit") {
		const editDetails = details as EditToolDetails | undefined;
		if (editDetails?.path) {
			return [
				{
					type: "diff",
					path: editDetails.path,
					oldText: editDetails.oldContent,
					newText: editDetails.newContent,
				},
			];
		}
	}
	if (toolName === "write") {
		const writeDetails = details as WriteToolDetails | undefined;
		if (writeDetails?.path) {
			// 新建文件时 oldText 为 null,Zed 会整块显示为新增;覆盖时给出旧内容,画成真 diff。
			// newContent 必须来自 details —— 这里是纯函数,读不了盘。
			return [
				{
					type: "diff",
					path: writeDetails.path,
					oldText: writeDetails.oldContent ?? null,
					newText: writeDetails.newContent ?? "",
				},
			];
		}
	}
	return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
		})
		.map((part) => part.text)
		.join("");
}

/** session/update 通知的发送口,由 acp.ts 用当前的客户端上下文填进来。 */
export type UpdateSink = (update: Record<string, unknown>) => Promise<void>;

/**
 * session/load 的历史重放:把已落盘的线性消息翻译成一串 session/update。
 * 纯函数,方便测试;真正的 notify 由 agent.ts 逐条发出。
 * 和 pipeHarnessToAcp 的区别:那边消费的是流式事件(delta),这边消费的是整条消息。
 */
export function replayUpdatesOf(messages: unknown[]): Record<string, unknown>[] {
	const updates: Record<string, unknown>[] = [];
	for (const raw of messages) {
		const message = raw as {
			role?: string;
			content?: unknown;
			toolCallId?: string;
			toolName?: string;
			details?: unknown;
			isError?: boolean;
		};
		if (message.role === "user") {
			const blocks =
				typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: ((message.content as Array<{ type: string; text?: string }>) ?? []);
			for (const block of blocks) {
				if (block.type === "text" && block.text) {
					updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } });
				}
			}
		} else if (message.role === "assistant") {
			const blocks = (message.content as Array<Record<string, any>>) ?? [];
			for (const block of blocks) {
				if (block.type === "text" && block.text) {
					updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
				} else if (block.type === "thinking" && block.thinking) {
					updates.push({
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: block.thinking },
					});
				} else if (block.type === "toolCall") {
					updates.push({
						sessionUpdate: "tool_call",
						toolCallId: block.id,
						title: toolTitleOf(block.name, block.arguments),
						kind: toolKindOf(block.name),
						status: "in_progress",
						locations: toolLocationsOf(undefined, block.arguments),
						rawInput: block.arguments,
					});
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId && message.toolName) {
			const text = textOfContent(message.content);
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId: message.toolCallId,
				status: message.isError ? "failed" : "completed",
				content: toolContentOf(message.toolName, message.details, text),
				locations: toolLocationsOf(message.details, undefined),
				rawOutput: { text },
			});
		}
	}
	return updates;
}

/**
 * 把 harness 的事件流接到 ACP 的通知流上。
 * 返回退订函数。
 */
export function pipeHarnessToAcp(harness: AgentHarness<any, any, any>, sink: UpdateSink): () => void {
	return harness.subscribe((event: AgentHarnessEvent) => {
		switch (event.type) {
			case "message_end": {
				// 内核的纪律是"错误即数据":provider 挂了不会抛,而是合成一条 stopReason:"error"
				// 的 assistant 消息。ACP 这层必须把它翻出来,否则 Zed 只会看到一轮空转。
				const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
				if (message.role === "assistant" && message.stopReason === "error") {
					void sink({
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `⚠️ ${message.errorMessage ?? "Model request failed."}` },
					});
				}
				return;
			}
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta") {
					void sink({
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: delta.delta },
					});
				} else if (delta.type === "thinking_delta") {
					void sink({
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: delta.delta },
					});
				}
				return;
			}
			case "tool_execution_start": {
				void sink({
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: toolTitleOf(event.toolName, event.args),
					kind: toolKindOf(event.toolName),
					status: "in_progress",
					locations: toolLocationsOf(undefined, event.args),
					rawInput: event.args,
				});
				return;
			}
			case "tool_execution_end": {
				const text = textOfContent(event.result?.content);
				void sink({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: event.isError ? "failed" : "completed",
					content: toolContentOf(event.toolName, event.result?.details, text),
					locations: toolLocationsOf(event.result?.details, undefined),
					rawOutput: { text },
				});
				return;
			}
			default:
				return;
		}
	});
}
