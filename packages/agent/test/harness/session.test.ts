// Step 3 验收:Session 门面 + buildContext 投影(参考 pi-minimal session.test.ts)。
// 测试套件参数化于存储后端:目前只跑 InMemory;Step 4 实现 JsonlSessionStorage 后,
// 在文件末尾追加第二个 runSessionSuite 调用即可让同一套测试双后端复跑。
import { describe, expect, it } from "bun:test";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { type ContextEntryTransform, Session } from "../../src/harness/session/session.ts";
import type { SessionStorage } from "../../src/harness/types.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

function getTextData(data: unknown): string {
	if (typeof data !== "object" || data === null || !("text" in data)) {
		return "";
	}
	const value = (data as { text?: unknown }).text;
	return typeof value === "string" ? value : "";
}

async function runSessionSuite(
	name: string,
	createStorage: () => SessionStorage | Promise<SessionStorage>,
	inspect?: () => void,
) {
	describe(name, () => {
		it("appends messages and builds context in order", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("tracks model and thinking level changes", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendModelChange("openai", "gpt-4.1");
			await session.appendThinkingLevelChange("high");
			const context = await session.buildContext();
			expect(context.thinkingLevel).toBe("high");
			expect(context.model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
		});

		it("supports branching by moving the leaf and appending a new branch", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const assistant1 = await session.appendMessage(createAssistantMessage("two"));
			await session.appendMessage(createUserMessage("three"));
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const branch = await session.getBranch();
			expect(branch.map((entry) => entry.id)).toContain(user1);
			expect(branch.map((entry) => entry.id)).not.toContain(assistant1);
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("supports moving the leaf to root", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.moveTo(null);
			expect(await session.getLeafId()).toBeNull();
			expect((await session.buildContext()).messages).toEqual([]);
		});

		it("reconstructs compaction summaries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const user2 = await session.appendMessage(createUserMessage("three"));
			await session.appendMessage(createAssistantMessage("four"));
			await session.appendCompaction("summary", user2, 1234);
			await session.appendMessage(createUserMessage("five"));
			const context = await session.buildContext();
			expect(context.messages[0]?.role).toBe("compactionSummary");
			expect(context.messages).toHaveLength(4);
		});

		it("supports moving with branch summary entries in context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const summaryId = await session.moveTo(user1, { summary: "summary text" });
			expect(summaryId).toBeTruthy();
			const summaryEntry = await session.getEntry(summaryId!);
			expect(summaryEntry).toMatchObject({ type: "branch_summary", parentId: user1, fromId: user1 });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("branchSummary");
		});

		it("supports custom message entries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomMessageEntry("custom", "hello", true, { ok: true });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("custom");
		});

		it("keeps custom entries in context entries but omits them from messages by default", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomEntry("chat_message", { text: "hello" });
			const contextEntries = await session.buildContextEntries();
			const context = await session.buildContext();
			expect(contextEntries.map((entry) => entry.type)).toEqual(["message", "custom"]);
			expect(context.messages).toHaveLength(1);
		});

		it("projects custom entries with configured custom-entry projectors", async () => {
			const session = new Session(await createStorage(), {
				entryProjectors: {
					chat_message: (entry) => [createUserMessage(`chat: ${getTextData(entry.data)}`)],
				},
			});
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomEntry("chat_message", { text: "hello" });
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
			expect(context.messages[1]).toMatchObject({ content: [{ type: "text", text: "chat: hello" }] });
		});

		it("applies context entry transforms after default compaction selection", async () => {
			let observedFirstEntryType: string | undefined;
			const dropCompaction: ContextEntryTransform = (entries) => {
				observedFirstEntryType = entries[0]?.type;
				return entries.filter((entry) => entry.type !== "compaction");
			};
			const session = new Session(await createStorage(), { entryTransforms: [dropCompaction] });
			await session.appendMessage(createUserMessage("one"));
			const kept = await session.appendMessage(createUserMessage("two"));
			await session.appendCompaction("summary", kept, 1234);
			await session.appendMessage(createUserMessage("three"));
			const context = await session.buildContext();
			expect(observedFirstEntryType).toBe("compaction");
			expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
		});

		it("normalizes session names", async () => {
			const session = new Session(await createStorage());
			await session.appendSessionName(" hello\nworld\r\nagain ");
			expect(await session.getSessionName()).toBe("hello world again");
		});

		it("supports labels and session info entries without affecting context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			const entries = await session.getEntries();
			expect(entries.some((entry) => entry.type === "label")).toBe(true);
			expect(entries.some((entry) => entry.type === "session_info")).toBe(true);
			expect(await session.getLabel(user1)).toBe("checkpoint");
			expect(await session.getSessionName()).toBe("name");
			expect((await session.buildContext()).messages).toHaveLength(1);
		});

		it("rejects labels for missing entries", async () => {
			const session = new Session(await createStorage());
			await expect(session.appendLabel("missing", "checkpoint")).rejects.toThrow("Entry missing not found");
		});

		it("persists leaf changes and appended entries via storage", async () => {
			const storage = await createStorage();
			const session = new Session(storage);
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const session2 = new Session(storage);
			const context = await session2.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(await session2.getLabel(user1)).toBe("checkpoint");
			expect(await session2.getSessionName()).toBe("name");
			inspect?.();
		});
	});
}

runSessionSuite("Session with in-memory storage", () => new InMemorySessionStorage());

// Step 4(JsonlSessionStorage)完成后追加:
// runSessionSuite("Session with JSONL storage", async () => { ... JsonlSessionStorage.create(...) ... }, inspect);
