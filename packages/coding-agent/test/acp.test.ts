// ACP 翻译层的测试。这一层没有 IO,全是"harness 事件 → ACP 消息"的映射,
// 但它决定了 Zed 里显示成什么样,映射错了在编辑器里很难查,所以钉死在测试里。
import { describe, expect, it } from "bun:test";
import { replayUpdatesOf, toolContentOf, toolKindOf, toolLocationsOf, toolTitleOf } from "../src/acp/session.ts";

describe("toolKindOf", () => {
	it("maps my-pi tools onto ACP kinds", () => {
		expect(toolKindOf("read")).toBe("read");
		expect(toolKindOf("write")).toBe("edit");
		expect(toolKindOf("edit")).toBe("edit");
		expect(toolKindOf("bash")).toBe("execute");
		expect(toolKindOf("grep")).toBe("search");
	});

	it("falls back to other for unknown tools", () => {
		expect(toolKindOf("something-new")).toBe("other");
	});
});

describe("toolTitleOf", () => {
	it("titles file tools with their path", () => {
		expect(toolTitleOf("read", { path: "src/a.ts" })).toBe("Read src/a.ts");
		expect(toolTitleOf("write", { path: "src/a.ts" })).toBe("Write src/a.ts");
		expect(toolTitleOf("edit", { path: "src/a.ts" })).toBe("Edit src/a.ts");
	});

	it("titles bash with the command and grep with the pattern", () => {
		expect(toolTitleOf("bash", { command: "ls -la" })).toBe("$ ls -la");
		expect(toolTitleOf("grep", { pattern: "TODO" })).toBe("Search /TODO/");
	});

	it("degrades gracefully when arguments are still streaming in", () => {
		// 工具参数是流式到达的,渲染时可能还没解析完整。
		expect(toolTitleOf("read", {})).toBe("Read");
		expect(toolTitleOf("bash", undefined)).toBe("Run command");
	});
});

describe("toolLocationsOf", () => {
	it("prefers the absolute path from details", () => {
		expect(toolLocationsOf({ path: "/abs/a.ts" }, { path: "a.ts" })).toEqual([{ path: "/abs/a.ts" }]);
	});

	it("carries the first changed line so the editor can jump to it", () => {
		expect(toolLocationsOf({ path: "/abs/a.ts", firstChangedLine: 12 }, undefined)).toEqual([
			{ path: "/abs/a.ts", line: 12 },
		]);
	});

	it("falls back to the argument path before the tool has run", () => {
		expect(toolLocationsOf(undefined, { path: "a.ts" })).toEqual([{ path: "a.ts" }]);
	});

	it("returns nothing for tools without a file", () => {
		expect(toolLocationsOf(undefined, { command: "ls" })).toEqual([]);
	});
});

describe("toolContentOf", () => {
	it("emits a structured diff for edit so Zed renders a real diff view", () => {
		const content = toolContentOf(
			"edit",
			{ path: "/abs/a.ts", oldContent: "one\ntwo\n", newContent: "one\nTWO\n" },
			"Successfully replaced 1 block(s) in a.ts.",
		);
		expect(content).toEqual([{ type: "diff", path: "/abs/a.ts", oldText: "one\ntwo\n", newText: "one\nTWO\n" }]);
	});

	it("emits plain text for other tools", () => {
		expect(toolContentOf("bash", undefined, "hello")).toEqual([
			{ type: "content", content: { type: "text", text: "hello" } },
		]);
	});

	it("emits nothing when a tool produced no text", () => {
		expect(toolContentOf("bash", undefined, "")).toEqual([]);
	});
});

describe("replayUpdatesOf", () => {
	it("replays a full conversation: user, thinking, text, tool call, tool result", () => {
		const updates = replayUpdatesOf([
			{ role: "user", content: [{ type: "text", text: "改一下 a.ts" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "先看文件" },
					{ type: "text", text: "好的。" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
		]);

		expect(updates.map((update) => update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
		]);
		expect(updates[3]).toMatchObject({ toolCallId: "call-1", kind: "read", title: "Read a.ts" });
		expect(updates[4]).toMatchObject({ toolCallId: "call-1", status: "completed" });
	});

	it("accepts string user content and marks failed tool results", () => {
		const updates = replayUpdatesOf([
			{ role: "user", content: "hi", timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "bash",
				content: [{ type: "text", text: "boom" }],
				isError: true,
				timestamp: 2,
			},
		]);
		expect(updates[0]).toMatchObject({ sessionUpdate: "user_message_chunk", content: { text: "hi" } });
		expect(updates[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
	});
});
