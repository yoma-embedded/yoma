// 反例:只有裸 Agent(你已经写完的 M1-M4)时,产品级需求会在哪里卡住。
//
// 三个痛点,每个都能跑给你看:
//   痛点 1: 掉电失忆 —— 对话只活在内存数组里
//   痛点 2: 上下文只增不减 —— 朴素截断会切出"孤儿工具结果",provider 直接拒收
//   痛点 3: 回到过去 = 毁掉现在 —— 数组没有分支,重试等于删除历史
//
// 运行: bun example/03-反例-裸Agent的三个痛点.ts
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { Agent, type AgentMessage, type AgentTool } from "@yoma/my-pi";

const weatherParams = Type.Object({ city: Type.String() });
const weatherTool: AgentTool<typeof weatherParams> = {
	label: "查天气",
	name: "get_weather",
	description: "查询城市天气",
	parameters: weatherParams,
	execute: async (_id, args) => ({
		content: [{ type: "text", text: `${args.city}: 22°C, 多云` }],
		details: undefined,
	}),
};

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

function makeAgent() {
	return new Agent({
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
		initialState: {
			systemPrompt: "你是一个简洁的助手。",
			model: faux.getModel(),
			tools: [weatherTool],
		},
	});
}

// ============================================================================
console.log("━━━ 痛点 1: 掉电失忆 ━━━\n");

const agent = makeAgent();
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("get_weather", { city: "北京" }, { id: "call-1" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("北京 22°C 多云。"),
]);
await agent.prompt("北京天气怎么样?");
console.log(`对话进行了一轮,内存里有 ${agent.state.messages.length} 条消息。`);

// "进程重启" —— 对裸 Agent 来说就是 new 一个新的:
const agentAfterRestart = makeAgent();
console.log(`重启后,新 Agent 里有 ${agentAfterRestart.state.messages.length} 条消息。全忘了。\n`);

// 当然你可以手动救:消息是纯 JSON 数据(设计决策 D4),序列化确实只要一行 ——
const saved = JSON.stringify(agent.state.messages);
agentAfterRestart.state.messages = JSON.parse(saved);
faux.setResponses([fauxAssistantMessage("上海 26°C 晴。")]);
await agentAfterRestart.prompt("那上海呢?");
console.log(`手动 JSON.stringify 救回来了,追问也正常: ${agentAfterRestart.state.messages.length} 条消息。`);

console.log(`
但"一行序列化"只是幻觉,马上要回答一堆问题:
  · 什么时候存?每条消息落地时?那要挂在哪个事件上?
  · 存了一半进程崩了呢?UI 已经显示了、盘上却没有的消息算存在过吗?
  · 中途换过模型/开关过工具,记在哪?下次恢复用哪个模型?
  · 这些答案拼起来,就是 harness 的"message_end 先落盘再通知 + 会话树条目"。
`);

// ============================================================================
console.log("━━━ 痛点 2: 上下文只增不减,朴素截断会切坏 ━━━\n");

// 一段含工具调用的 transcript(手工构造,结构和真实运行完全一致):
const transcript: AgentMessage[] = [
	{ role: "user", content: [{ type: "text", text: "问题A" }], timestamp: 1 },
	fauxAssistantMessage("回答A。"),
	{ role: "user", content: [{ type: "text", text: "北京天气?" }], timestamp: 2 },
	fauxAssistantMessage(fauxToolCall("get_weather", { city: "北京" }, { id: "call-9" }), { stopReason: "toolUse" }),
	{
		role: "toolResult",
		toolCallId: "call-9",
		toolName: "get_weather",
		content: [{ type: "text", text: "北京: 22°C" }],
		isError: false,
		timestamp: 3,
	},
	fauxAssistantMessage("北京 22°C。"),
];
console.log(`transcript 共 ${transcript.length} 条,只会越来越长——裸 Agent 没有任何瘦身机制。`);
console.log(`最朴素的瘦身:掉头部,比如 transcript.slice(4):\n`);

const truncated = transcript.slice(4);
console.log(`截断后的第一条消息: role=${truncated[0].role}`, `toolCallId=${(truncated[0] as any).toolCallId}`);
console.log(`
→ 开头是一条 toolResult,但它对应的 assistant toolCall(call-9)被切掉了。
  真实 provider 会直接 400 拒绝这个请求:"tool result without matching tool call"。
  这就是 pi 的 compaction 为什么必须"只在轮边界切"(findCutPoint),
  以及为什么被切掉的部分要变成摘要而不是直接消失。
`);

// ============================================================================
console.log("━━━ 痛点 3: 回到过去 = 毁掉现在 ━━━\n");

const agent3 = makeAgent();
faux.setResponses([fauxAssistantMessage("方案一:用递归实现。")]);
await agent3.prompt("怎么实现目录遍历?");
faux.setResponses([fauxAssistantMessage("好的,已按方案一写完。")]);
await agent3.prompt("就按这个写吧");
console.log(`聊了两轮,${agent3.state.messages.length} 条消息。`);
console.log(`现在想回到第一个问题,换个问法重试("用迭代而不是递归呢?")——`);
console.log(`数组只有一条时间线,唯一的办法是 slice 掉后面所有内容再重问:\n`);

const abandoned = agent3.state.messages.slice(1); // 即将被销毁的 3 条
agent3.state.messages = agent3.state.messages.slice(0, 0);
faux.setResponses([fauxAssistantMessage("方案二:用显式栈迭代实现。")]);
await agent3.prompt("怎么实现目录遍历?用迭代而不是递归。");
console.log(`重试成功,当前 ${agent3.state.messages.length} 条消息。`);
console.log(`但原来那 ${abandoned.length} 条(方案一的整个探索过程)已经永远消失:`);
console.log(`  无法对比两个方案、无法反悔回去、也没有任何记录证明它存在过。`);
console.log(`  这就是 harness 把会话做成"追加式树"而不是数组的原因:`);
console.log(`  回到过去 = 移动 leaf 指针再分叉,两条时间线都还在。\n`);

console.log("→ 三个痛点的解法,见 example/04-正例-harness如何解决.ts");
