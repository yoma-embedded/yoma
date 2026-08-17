// 真实模型冒烟测试:接入 DeepSeek(OpenAI-completions 兼容协议),验证你的 Agent
// 在真实网络、真实流式、真实工具调用下端到端工作。
//
// 定位(测试金字塔):日常调试用 faux/mock(免费、确定性、毫秒级,见 test/ 目录);
// 真实 API 只做"冒烟"——每次大改后跑一次,确认 wire 层/流式/工具回路没被改坏。
//
// 运行: DEEPSEEK_API_KEY=sk-xxx bun example/05-deepseek真实冒烟.ts
// (key 只从环境变量读,永远不要写进代码或提交进 git)
import { createModels, createProvider, envApiKeyAuth, type Model, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent, type AgentTool } from "@yoma/agent";

if (!process.env.DEEPSEEK_API_KEY) {
	console.error("请先设置环境变量: DEEPSEEK_API_KEY=sk-xxx bun example/05-deepseek真实冒烟.ts");
	process.exit(1);
}

// ---- 1. 注册 DeepSeek provider(15 行,HANDBOOK 说的"新 provider 只是一个工厂函数")----
const deepseekChat: Model<"openai-completions"> = {
	id: "deepseek-chat",
	name: "DeepSeek Chat (V3)",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 }, // $/百万 token
	contextWindow: 65536,
	maxTokens: 8192,
};

const models = createModels();
models.setProvider(
	createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
		models: [deepseekChat],
		api: openAICompletionsApi(),
	}),
);

// ---- 2. 一个真实执行的本地工具(验证完整的 工具调用→执行→结果→再回答 回路)----
const timeParams = Type.Object({ timezone: Type.Optional(Type.String({ description: "IANA 时区名,如 Asia/Shanghai" })) });
const timeTool: AgentTool<typeof timeParams> = {
	label: "查时间",
	name: "get_current_time",
	description: "获取当前的日期和时间",
	parameters: timeParams,
	execute: async (_id, args) => ({
		content: [
			{
				type: "text",
				text: new Date().toLocaleString("zh-CN", { timeZone: args.timezone ?? "Asia/Shanghai" }),
			},
		],
		details: undefined,
	}),
};

// ---- 3. 跑一次两轮对话,顺便收集冒烟检查所需的事件 ----
const agent = new Agent({
	streamFn: (model, context, options) => models.streamSimple(model, context, options),
	initialState: {
		systemPrompt: "你是一个简洁的中文助手。需要知道时间时必须调用 get_current_time 工具。",
		model: deepseekChat,
		tools: [timeTool],
	},
});

const eventTypes: string[] = [];
agent.subscribe((event) => {
	eventTypes.push(event.type);
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") {
		console.log(`\n[工具调用] ${event.toolName}(${JSON.stringify(event.args)})`);
	}
});

console.log("向 DeepSeek 提问: 现在几点了?\n");
await agent.prompt("现在几点了?");
console.log("\n");

// ---- 4. 冒烟检查清单(自动断言,任何一条失败都非零退出)----
const messages = agent.state.messages;
const last = messages[messages.length - 1];
const checks: [string, boolean][] = [
	["对话至少 4 条消息(user→assistant(toolCall)→toolResult→assistant)", messages.length >= 4],
	["发生过真实的工具执行", eventTypes.includes("tool_execution_start")],
	["最后一条是 assistant 且正常停止", last?.role === "assistant" && last.stopReason === "stop"],
	["事件序列以 agent_end 收尾", eventTypes[eventTypes.length - 1] === "agent_end"],
	["没有错误消息", !agent.state.errorMessage],
];
let failed = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "✅" : "❌"} ${name}`);
	if (!ok) failed++;
}
if (agent.state.errorMessage) console.log(`\n错误详情: ${agent.state.errorMessage}`);
if (last?.role === "assistant" && last.stopReason !== "stop")
	console.log(`最后一条 assistant: stopReason=${last.stopReason} errorMessage=${last.errorMessage ?? ""}`);

// usage/成本(客户端计算,pi 的设计:成本永远客户端算)
const assistants = messages.filter((m) => m.role === "assistant");
const usage = assistants.map((m) => m.usage);
const totalIn = usage.reduce((s, u) => s + u.input, 0);
const totalOut = usage.reduce((s, u) => s + u.output, 0);
const totalCost = usage.reduce((s, u) => s + (u.cost?.total ?? 0), 0);
console.log(`\ntoken 用量: 输入 ${totalIn} / 输出 ${totalOut},本次冒烟成本约 $${totalCost.toFixed(6)}`);

process.exit(failed > 0 ? 1 : 0);
