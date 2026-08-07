// pi-minimal 示例 1:最小可嵌入内核 —— 离线运行(faux 模型,无需网络 / API key)。
//
// 展示三件事:
//   1. 用 createModels() + fauxProvider() 造一个可编排的假模型;
//   2. 用 Agent 挂一个工具(会先被模型调用一次),再流式打印文本回答;
//   3. prompt() -> waitForIdle() 后读取完整对话记录。
//
// 运行: npx tsx examples/01-minimal-agent.ts
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { Agent, type AgentTool } from "@yoma/my-pi";

// 一个简单的天气查询工具,模型会在真实调用前先"决定"调用它。
const weatherParams = Type.Object({ city: Type.String({ description: "城市名称" }) });
const weatherTool: AgentTool<typeof weatherParams> = {
	label: "查天气",
	name: "get_weather",
	description: "查询指定城市当前的天气",
	parameters: weatherParams,
	execute: async (_toolCallId, args) => ({
		content: [{ type: "text", text: `${args.city}: 22°C, 多云` }],
		details: undefined,
	}),
};

// 用 faux provider 编排一次"先调用工具,再基于结果回答"的对话。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("get_weather", { city: "北京" }, { id: "call-1" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("北京现在 22°C,天气多云,出门可以不带伞。"),
]);

const agent = new Agent({
	// pi-minimal: Agent 默认 streamFn 会抛错,必须显式绑定 models.streamSimple。
	streamFn: (model, context, options) => models.streamSimple(model, context, options),
	initialState: {
		systemPrompt: "你是一个简洁的助手,需要时使用 get_weather 工具查询天气。",
		model: faux.getModel(),
		tools: [weatherTool],
	},
});

// 订阅事件,只把助手回答的文本增量打印到标准输出,模拟流式效果。
agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await agent.prompt("北京天气怎么样?");
await agent.waitForIdle();
console.log();
console.log(`对话共 ${agent.state.messages.length} 条消息(含工具调用与结果)。`);
