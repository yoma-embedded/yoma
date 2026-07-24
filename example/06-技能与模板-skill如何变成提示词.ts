// M7 Step 1 成果演示:技能(Skill)与提示词模板(PromptTemplate)如何变成提示词。
//
// 核心祛魅:pi 世界里"调用一个技能"没有任何魔法 ——
//   formatSkillInvocation(skill)  = 把 SKILL.md 内容包上 <skill> 标签的纯字符串函数
//   formatPromptTemplateInvocation = shell 风格的 $1/$ARGUMENTS 占位符替换
// 之后这段文本作为普通 user 消息进入对话。harness 的 skill()/promptFromTemplate()
// 未来也只是"格式化 + prompt()"的两行组合。
//
// 运行(免费,faux 模型):    bun example/06-技能与模板-skill如何变成提示词.ts
// 运行(真模型,感受技能生效): DEEPSEEK_API_KEY=sk-xxx bun example/06-技能与模板-skill如何变成提示词.ts
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	Agent,
	type AgentEvent,
	formatPromptTemplateInvocation,
	formatSkillInvocation,
	parseCommandArgs,
	type PromptTemplate,
	type Skill,
} from "@yoma/my-pi";

// ============================================================================
console.log("━━━ 第 1 幕:技能 = 被格式化的提示词 ━━━\n");

const reviewSkill: Skill = {
	name: "code-review",
	description: "用固定清单审查代码",
	content: [
		"你是代码审查技能。收到代码后:",
		"1. 只用中文回答,不超过三行;",
		"2. 指出一个最严重的问题;",
		"3. 回答末尾必须加一句:—— 由 code-review 技能生成",
	].join("\n"),
	filePath: "/project/.pi/skills/code-review/SKILL.md",
};

const skillPrompt = formatSkillInvocation(reviewSkill, "请审查:function add(a, b) { return a - b; }");
console.log("formatSkillInvocation 的输出(将作为 user 消息发送):\n");
console.log(skillPrompt.split("\n").map((line) => `  │ ${line}`).join("\n"));

// ============================================================================
console.log("\n━━━ 第 2 幕:模板 = slash command 的实现原理 ━━━\n");

const fixTemplate: PromptTemplate = {
	name: "fix",
	description: "修复指定文件里的某类问题",
	content: "修复 $1 中所有的 $2 问题。完整指令回显:$ARGUMENTS",
};

// 用户输入 `/fix "src/agent loop.ts" 类型错误` 时,应用层就做这两步:
const rawArgs = '"src/agent loop.ts" 类型错误';
const args = parseCommandArgs(rawArgs); // 引号感知的参数切分
console.log(`parseCommandArgs(${JSON.stringify(rawArgs)})`);
console.log(`  → ${JSON.stringify(args)}`);
console.log(`formatPromptTemplateInvocation(fix, args)`);
console.log(`  → ${JSON.stringify(formatPromptTemplateInvocation(fixTemplate, args))}`);

// ============================================================================
console.log("\n━━━ 第 3 幕:真的跑一遍(顺便演示轨迹调试)━━━\n");

// 大厂调试 agent 的第一手段是"读轨迹"(read the transcript/trace)。
// 我们订阅全部 AgentEvent,打出一条极简 trace —— 这就是 OpenAI Traces
// dashboard / Anthropic 读 transcript 的乞丐版,但原理相同:事件序列即真相。
const useReal = !!process.env.DEEPSEEK_API_KEY;
const models = createModels();
let model: Model<string>;

if (useReal) {
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
	model = deepseekChat;
	console.log("(检测到 DEEPSEEK_API_KEY,用真模型 —— 观察技能是否真的约束了回答)\n");
} else {
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage("add 函数用了减号,应为 a + b。\n—— 由 code-review 技能生成"),
	]);
	model = faux.getModel();
	console.log("(未设 DEEPSEEK_API_KEY,用 faux 模型跑通机制;剧本模拟了技能生效的样子)\n");
}

const agent = new Agent({
	streamFn: (m, context, options) => models.streamSimple(m, context, options),
	initialState: {
		systemPrompt: "你是一个编程助手。",
		model,
		tools: [],
	},
});

// 极简轨迹打印器:每个事件一行。调试 agent 时,你要的第一个工具永远是它。
function describeEvent(event: AgentEvent): string | undefined {
	switch (event.type) {
		case "agent_start":
			return "agent_start";
		case "turn_start":
			return "turn_start";
		case "message_start":
			return `message_start   role=${event.message.role}`;
		case "message_end": {
			const stop = event.message.role === "assistant" ? `  stopReason=${event.message.stopReason}` : "";
			return `message_end     role=${event.message.role}${stop}`;
		}
		case "turn_end":
			return "turn_end";
		case "agent_end":
			return "agent_end";
		default:
			return undefined; // message_update 太密,轨迹里通常按需展开
	}
}
agent.subscribe((event) => {
	const line = describeEvent(event);
	if (line) console.log(`  [trace] ${line}`);
});

await agent.prompt(skillPrompt);

const last = agent.state.messages.at(-1);
const text =
	last?.role === "assistant"
		? last.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("")
		: "(无回答)";
console.log(`\n模型回答:\n${text.split("\n").map((line) => `  ${line}`).join("\n")}`);

console.log(`\ntranscript 里共 ${agent.state.messages.length} 条消息;技能文本就在第 1 条 user 消息里 —— 它只是提示词。`);
