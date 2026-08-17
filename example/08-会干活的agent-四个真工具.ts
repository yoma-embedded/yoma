// 第一次:yoma 不只是会聊天,而是真的能**干活** —— 读文件、改文件、跑命令。
//
// 三幕:
//   1. 离线(faux 模型):脚本化地驱动工具,证明工具与 harness 接得上
//   2. 工具本身:直接调用,看它们给模型返回什么文案
//   3. 真模型(需要 DEEPSEEK_API_KEY 或 MOONSHOT_API_KEY):让它自己决定用哪个工具
//
// 运行: bun example/08-会干活的agent-四个真工具.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AgentHarness, InMemorySessionStorage, NodeExecutionEnv, Session } from "@yoma/agent/node";
import {
	createBashTool,
	createCodingToolDefinitions,
	createEditTool,
	createReadTool,
	createWriteTool,
	wrapToolDefinitions,
} from "@yoma/coding-agent";

const dir = mkdtempSync(join(tmpdir(), "yoma-tools-demo-"));
const env = new NodeExecutionEnv({ cwd: dir });
const tools = {
	read: createReadTool(env),
	bash: createBashTool(env),
	edit: createEditTool(env),
	write: createWriteTool(env),
};

// ============================================================================
console.log("━━━ 第 1 幕: 工具单独跑,看它们对模型说什么 ━━━\n");

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

console.log("write →", text(await tools.write.execute("1", { path: "calc.ts", content: "export const add = (a, b) => a - b;\n" })));
console.log("read  →", JSON.stringify(text(await tools.read.execute("2", { path: "calc.ts" }))));

console.log("edit  →", text(await tools.edit.execute("3", {
	path: "calc.ts",
	edits: [{ oldText: "a - b", newText: "a + b" }],
})));
console.log("       修好了:", JSON.stringify(text(await tools.read.execute("4", { path: "calc.ts" }))));

await tools.write.execute("5", { path: "notes.md", content: "# 笔记\n\nTODO: 补测试\nTODO: 写文档\n" });
console.log("bash  →", JSON.stringify(text(await tools.bash.execute("7", { command: "ls" }))));

// 错误路径同样是"给模型的话",它决定模型能不能自己纠正 ——
try {
	await tools.edit.execute("8", { path: "notes.md", edits: [{ oldText: "TODO", newText: "DONE" }] });
} catch (error) {
	console.log("\nedit 撞到不唯一 →", (error as Error).message);
}

// ============================================================================
console.log("\n━━━ 第 2 幕: 接进 harness,离线跑一轮工具调用 ━━━\n");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const session = new Session(new InMemorySessionStorage());
const harness = new AgentHarness({
	env,
	session,
	models,
	model: faux.getModel(),
	systemPrompt: "你是一个简洁的编码助手。",
	tools: wrapToolDefinitions(createCodingToolDefinitions(env)),
});

const trace: string[] = [];
harness.subscribe((event) => {
	if (event.type === "tool_execution_start") trace.push(`  → 调用 ${event.toolName}(${JSON.stringify(event.args)})`);
	if (event.type === "tool_execution_end") trace.push(`  ← ${event.toolName} ${event.isError ? "失败" : "完成"}`);
});

faux.setResponses([
	fauxAssistantMessage([fauxToolCall("read", { path: "calc.ts" })]),
	fauxAssistantMessage("calc.ts 里是一个加法函数 add。"),
]);
await harness.prompt("看看 calc.ts 写了什么");
console.log(trace.join("\n"));
console.log(`\n会话树条目: ${(await session.getEntries()).length}(user / assistant+toolCall / toolResult / assistant)`);

// ============================================================================
if (!process.env.DEEPSEEK_API_KEY) {
	console.log("\n━━━ 第 3 幕: 跳过(设 DEEPSEEK_API_KEY 后可跑真模型)━━━");
} else {
	console.log("\n━━━ 第 3 幕: 真模型自己选工具 ━━━\n");
	// provider 注册方式与 example/05 一致。
	const deepseekChat: Model<"openai-completions"> = {
		id: "deepseek-chat",
		name: "DeepSeek Chat (V3)",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 8192,
	};
	const realModels = createModels();
	realModels.setProvider(
		createProvider({
			id: "deepseek",
			name: "DeepSeek",
			baseUrl: "https://api.deepseek.com",
			auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
			models: [deepseekChat],
			api: openAICompletionsApi(),
		}),
	);
	const model = deepseekChat;

	const realSession = new Session(new InMemorySessionStorage());
	const realHarness = new AgentHarness({
		env,
		session: realSession,
		models: realModels,
		model,
		systemPrompt: "你是一个编码助手。可以使用 read/bash/edit/write 工具。回答简短。",
		tools: wrapToolDefinitions(createCodingToolDefinitions(env)),
	});
	realHarness.subscribe((event) => {
		if (event.type === "tool_execution_start") console.log(`  → ${event.toolName}(${JSON.stringify(event.args)})`);
	});

	await realHarness.prompt("notes.md 里有几个 TODO?用工具查,直接给数字。");
	const messages = (await realSession.buildContext()).messages;
	const last = messages.at(-1);
	const answer = last && "content" in last ? last.content : undefined;
	console.log("\n模型回答:", JSON.stringify(answer));
}

console.log("\n━━━ 总结 ━━━");
console.log("工具 = schema(给模型)+ execute(干活)+ 返回文案(给模型看的反馈)。");
console.log("最容易被低估的是第三项:");
console.log('  read 截断时说 "Use offset=2001 to continue." → 模型知道怎么接着读');
console.log('  edit 撞到多处时说 "must be unique, provide more context" → 模型知道怎么修正');
console.log('  bash 超限时说 "Full output: /tmp/..." → 模型知道去哪捞全量');
console.log("这些文案是从 pi 逐字抄来的 —— 它们是模型与工具之间的真正接口。");
