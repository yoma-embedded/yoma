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

	it("emits the written content for write — an empty newText renders as a blank file in Zed", () => {
		expect(
			toolContentOf("write", { path: "/abs/new.ts", created: true, oldContent: null, newContent: "hello\n" }, ""),
		).toEqual([{ type: "diff", path: "/abs/new.ts", oldText: null, newText: "hello\n" }]);
	});

	it("emits a real before/after diff when write overwrites an existing file", () => {
		expect(
			toolContentOf(
				"write",
				{ path: "/abs/a.ts", created: false, oldContent: "old\n", newContent: "new\n" },
				"",
			),
		).toEqual([{ type: "diff", path: "/abs/a.ts", oldText: "old\n", newText: "new\n" }]);
	});

	it("emits plain text for other tools", () => {
		expect(toolContentOf("bash", undefined, "hello")).toEqual([
			{ type: "content", content: { type: "text", text: "hello" } },
		]);
	});

	it("emits nothing when a tool produced no text", () => {
		expect(toolContentOf("bash", undefined, "")).toEqual([]);
	});

	it("forwards image blocks (datasheet view_figure) after the text", () => {
		const content = toolContentOf("datasheet", { action: "view_figure" }, "Figure (attached below): clock tree", [
			{ type: "text", text: "Figure (attached below): clock tree" },
			{ type: "image", data: "QUJD", mimeType: "image/png" },
		]);
		expect(content).toEqual([
			{ type: "content", content: { type: "text", text: "Figure (attached below): clock tree" } },
			{ type: "content", content: { type: "image", data: "QUJD", mimeType: "image/png" } },
		]);
	});
});

describe("pipeHarnessToAcp tool_execution_end", () => {
	it("delivers image blocks on the LIVE path, not only on replay", async () => {
		// 假 harness:只要 subscribe 能把 listener 交出来就够了。
		let listener: ((event: any) => void) | undefined;
		const harness = {
			subscribe(fn: (event: any) => void) {
				listener = fn;
				return () => {};
			},
		};
		const updates: any[] = [];
		const { pipeHarnessToAcp } = await import("../src/acp/session.ts");
		pipeHarnessToAcp(harness as any, async (update) => {
			updates.push(update);
		});
		listener!({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "datasheet",
			result: {
				content: [
					{ type: "text", text: "Figure (attached below): clock tree" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				details: { action: "view_figure" },
			},
		});
		const end = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
		expect(end.content).toContainEqual({
			type: "content",
			content: { type: "image", data: "QUJD", mimeType: "image/png" },
		});
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

// ---- configOptions:Zed 的模型/thinking 下拉框 ----------------------------
//
// 这两个下拉框完全由 session/new / session/load 返回的 configOptions 渲染。
// 字段名或 id 一漂,Zed 那边就是"框消失了"这种极难查的现象,所以钉死。
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import {
	buildConfigOptionsFor,
	clampThinkingLevel,
	MODEL_CONFIG_ID,
	modelValueOf,
	parseModelValue,
	THOUGHT_LEVEL_CONFIG_ID,
} from "../src/acp/agent.ts";

function fakeModel(over: Record<string, unknown> = {}): any {
	return {
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...over,
	};
}

function fakeModels(list: any[]): any {
	return { getModels: () => list, getModel: (p: string, id: string) => list.find((m) => m.provider === p && m.id === id) };
}

describe("buildConfigOptionsFor", () => {
	const reasoningModel = fakeModel();
	const plainModel = fakeModel({ id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", provider: "moonshotai-cn", reasoning: false, thinkingLevelMap: undefined });

	it("emits exactly the two options Zed renders as dropdowns", () => {
		const options = buildConfigOptionsFor(fakeModels([reasoningModel, plainModel]), reasoningModel, "high");
		expect(options.map((o) => o.id)).toEqual([MODEL_CONFIG_ID, THOUGHT_LEVEL_CONFIG_ID]);
		expect(options.map((o) => o.category)).toEqual(["model", "thought_level"]);
		expect(options.every((o) => o.type === "select")).toBe(true);
	});

	it("keeps ids stable — they are the keys of Zed's default_config_options", () => {
		// 改这两个字面量会让用户 settings.json 里的默认模型配置静默失效。
		expect(MODEL_CONFIG_ID).toBe("model");
		expect(THOUGHT_LEVEL_CONFIG_ID).toBe("thought_level");
	});

	it("lists every registered model across providers, currentValue included", () => {
		const options = buildConfigOptionsFor(fakeModels([reasoningModel, plainModel]), reasoningModel, "high");
		const model = options[0]!;
		expect(model.options.map((o) => o.value)).toEqual(["deepseek/deepseek-v4-pro", "moonshotai-cn/kimi-k2-turbo-preview"]);
		expect(model.options.map((o) => o.value)).toContain(model.currentValue);
	});

	it("derives thinking levels from the model, not from a fixed list", () => {
		// thinkingLevelMap 把 minimal/low/medium 标成 null,只剩 off/high/max。
		const options = buildConfigOptionsFor(fakeModels([reasoningModel]), reasoningModel, "high");
		expect(options[1]!.options.map((o) => o.value)).toEqual(["off", "high", "max"]);
		expect(options[1]!.currentValue).toBe("high");
	});

	it("collapses to off for models that cannot reason", () => {
		const options = buildConfigOptionsFor(fakeModels([plainModel]), plainModel, "off");
		expect(options[1]!.options.map((o) => o.value)).toEqual(["off"]);
	});

	it("always keeps currentValue selectable in its own option list", () => {
		for (const model of [reasoningModel, plainModel]) {
			for (const option of buildConfigOptionsFor(fakeModels([reasoningModel, plainModel]), model, "off")) {
				expect(option.options.map((o) => o.value)).toContain(option.currentValue);
			}
		}
	});
});

describe("model value round-trip", () => {
	it("round-trips provider/id", () => {
		expect(parseModelValue(modelValueOf({ provider: "deepseek", id: "deepseek-v4-pro" }))).toEqual({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
		});
	});

	it("splits on the first slash only — model ids may contain slashes", () => {
		expect(parseModelValue("openrouter/meta/llama-3")).toEqual({ provider: "openrouter", modelId: "meta/llama-3" });
	});

	it("rejects malformed values instead of inventing a provider", () => {
		expect(parseModelValue("no-slash")).toBeUndefined();
		expect(parseModelValue("/leading")).toBeUndefined();
		expect(parseModelValue("trailing/")).toBeUndefined();
	});
});

describe("clampThinkingLevel", () => {
	it("keeps a level the model supports", () => {
		expect(clampThinkingLevel(fakeModel(), "high")).toBe("high");
	});

	it("falls back when switching to a model that dropped the level", () => {
		// deepseek 的 map 把 medium 标成 null。
		expect(clampThinkingLevel(fakeModel(), "medium")).toBe("off");
		expect(clampThinkingLevel(fakeModel({ reasoning: false, thinkingLevelMap: undefined }), "high")).toBe("off");
	});
});

describe("registered ACP methods", () => {
	it("matches the SDK's own method constants", () => {
		// 方法名写错的表现是 Zed 点下拉框收到 -32601,而不是编译错误。
		expect(AGENT_METHODS.session_set_config_option).toBe("session/set_config_option");
		expect(AGENT_METHODS.session_set_mode).toBe("session/set_mode");
	});
});

// ---- 斜杠命令 -------------------------------------------------------------
import { availableCommands, parseSlashCommand } from "../src/acp/agent.ts";

describe("availableCommands", () => {
	it("only advertises commands the harness can actually run", () => {
		// 登记了却不实现的命令,用户敲下去会石沉大海。
		expect(availableCommands().map((c) => c.name).sort()).toEqual(["compact", "status"]);
		for (const command of availableCommands()) {
			expect(command.description.length).toBeGreaterThan(0);
		}
	});

	it("declares an input hint only for the command that takes an argument", () => {
		const byName = Object.fromEntries(availableCommands().map((c) => [c.name, c]));
		expect(byName.compact!.input).toEqual({ hint: "optional instructions for the summary" });
		expect(byName.status!.input).toBeUndefined();
	});
});

describe("parseSlashCommand", () => {
	it("parses a bare command", () => {
		expect(parseSlashCommand("/status")).toEqual({ name: "status", argument: "" });
	});

	it("keeps everything after the name as the argument", () => {
		expect(parseSlashCommand("/compact focus on the auth refactor")).toEqual({
			name: "compact",
			argument: "focus on the auth refactor",
		});
	});

	it("tolerates surrounding whitespace and multi-line arguments", () => {
		expect(parseSlashCommand("  /compact  keep\nthe API notes  ")).toEqual({
			name: "compact",
			argument: "keep\nthe API notes",
		});
	});

	it("does not hijack ordinary prompts that merely contain a slash", () => {
		// 误判的后果是用户的正常问题被本地吞掉,永远到不了模型。
		expect(parseSlashCommand("what does src/acp.ts do?")).toBeUndefined();
		expect(parseSlashCommand("run ./scripts/build.sh")).toBeUndefined();
		expect(parseSlashCommand("/ leading space is not a command")).toBeUndefined();
		expect(parseSlashCommand("//comment")).toBeUndefined();
	});

	it("ignores unknown commands so they reach the model as plain text", () => {
		expect(parseSlashCommand("/deploy production")).toBeUndefined();
	});
});

// ---- 自动压缩的判断 -------------------------------------------------------
//
// 这两个分支只在长会话里暴露:漏了 no_usage 会让空会话一上来就压;
// 漏了 just_compacted 会压完立刻再压,一路压到没东西可压。
import { shouldAutoCompact } from "../src/acp/agent.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantWithUsage(totalTokens: number, timestamp: number): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp,
		usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: zeroCost },
	};
}

// DEFAULT_COMPACTION_SETTINGS.reserveTokens 是 16384,所以窗口必须比它大才有真阈值。
const WINDOW = 20000;
const THRESHOLD = WINDOW - 16384; // 3616

describe("shouldAutoCompact", () => {
	it("does nothing without usage data — a fresh session must not compact itself", () => {
		const result = shouldAutoCompact([{ role: "user", content: "hi", timestamp: 1 } as any], WINDOW);
		expect(result).toMatchObject({ compact: false, reason: "no_usage" });
	});

	it("stays put below the threshold", () => {
		const result = shouldAutoCompact([assistantWithUsage(THRESHOLD - 100, 10)], WINDOW);
		expect(result).toMatchObject({ compact: false, reason: "under_threshold" });
	});

	it("compacts above the threshold", () => {
		const result = shouldAutoCompact([assistantWithUsage(THRESHOLD + 100, 10)], WINDOW);
		expect(result).toMatchObject({ compact: true, reason: "over_threshold" });
		expect(result.tokens).toBeGreaterThan(THRESHOLD);
	});

	it("refuses to re-compact on usage that predates the last compaction", () => {
		// 保留下来的消息带的是压缩前那个更大上下文的 usage。信它就会无限压。
		const result = shouldAutoCompact([assistantWithUsage(THRESHOLD + 5000, 100)], WINDOW, 200);
		expect(result).toMatchObject({ compact: false, reason: "just_compacted" });
	});

	it("compacts again once a turn after the compaction produced fresh usage", () => {
		const result = shouldAutoCompact([assistantWithUsage(THRESHOLD + 5000, 300)], WINDOW, 200);
		expect(result).toMatchObject({ compact: true, reason: "over_threshold" });
	});

	it("scales with the model's window — the same context is fine in a bigger one", () => {
		const messages = [assistantWithUsage(THRESHOLD + 100, 10)];
		expect(shouldAutoCompact(messages, WINDOW).compact).toBe(true);
		expect(shouldAutoCompact(messages, 200000).compact).toBe(false);
	});
});
