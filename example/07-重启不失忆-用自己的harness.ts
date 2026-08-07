// M7 大节点 A 成果演示:example/03 的痛点 1(掉电失忆),第一次被你自己的代码解决。
//
// 03 里的裸 Agent:对话活在内存数组,进程一死全忘,救场要手写 JSON.stringify。
// 现在:AgentHarness 每条 message_end 先落盘(JSONL 会话树)再通知订阅者;
// "重启"只是 JsonlSessionStorage.open() 重放文件 —— 光标(leaf)、配置、历史全部回来。
//
// 运行: bun example/07-重启不失忆-用自己的harness.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
// NodeExecutionEnv 只在 node 子路径入口(根入口保持浏览器安全)
import {
	AgentHarness,
	type AgentHarnessEvent,
	type ExecutionEnv,
	JsonlSessionStorage,
	NodeExecutionEnv,
	Session,
	type ThinkingLevel,
} from "@yoma/my-pi/node";

const dir = mkdtempSync(join(tmpdir(), "my-pi-example-07-"));
const sessionPath = join(dir, "session.jsonl");
const env = new NodeExecutionEnv({ cwd: dir });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

// 极简轨迹打印器 —— 注意新词汇:save_point / settled 是 harness 自有事件。
function tracer(tag: string) {
	return (event: AgentHarnessEvent) => {
		switch (event.type) {
			case "message_end": {
				const stop = event.message.role === "assistant" ? `  stopReason=${event.message.stopReason}` : "";
				console.log(`  [${tag}] message_end  role=${event.message.role}${stop}`);
				return;
			}
			case "save_point":
				console.log(`  [${tag}] save_point   hadPendingMutations=${event.hadPendingMutations}`);
				return;
			case "settled":
				console.log(`  [${tag}] settled`);
				return;
			case "agent_start":
			case "turn_end":
			case "agent_end":
				console.log(`  [${tag}] ${event.type}`);
				return;
		}
	};
}

// ============================================================================
console.log("━━━ 第一段人生:对话 + 改配置,一切落盘 ━━━\n");
console.log(`会话文件: ${sessionPath}\n`);

{
	const storage = await JsonlSessionStorage.create(env, sessionPath, { cwd: dir, sessionId: "demo-restart" });
	const harness = new AgentHarness({
		models,
		env,
		session: new Session(storage),
		model: faux.getModel(),
		systemPrompt: "你是一个记性很好的助手。",
	});
	harness.subscribe(tracer("生前"));

	faux.setResponses([fauxAssistantMessage("好的,小明!我记住你了。")]);
	const reply = await harness.prompt("你好,我叫小明,请记住我。");
	console.log(`\n助手回答: ${reply.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`);

	// idle 时改配置 = 直接落树(model_change/thinking_level_change 都是树条目)
	await harness.setThinkingLevel("high");
	console.log("已 setThinkingLevel('high') —— 这也是一条会话树条目,不是内存变量。");
}

// 看看磁盘上到底写了什么(调试第一招:读轨迹 —— 会话文件本身就是 transcript)
const lines = readFileSync(sessionPath, "utf8").trim().split("\n");
console.log(`\n磁盘上的 JSONL:共 ${lines.length} 行(1 行 header + ${lines.length - 1} 个树条目):`);
for (const line of lines) {
	const parsed = JSON.parse(line);
	const label = parsed.type === "message" ? `message(${parsed.message.role})` : parsed.type;
	console.log(`  ${label}`);
}

// ============================================================================
console.log('\n━━━ "进程重启"(第一段人生的对象全部丢弃)━━━\n');

{
	const storage = await JsonlSessionStorage.open(env, sessionPath); // 逐行重放,恢复树 + leaf 光标
	const session = new Session(storage);
	const restored = await session.buildContext();
	console.log(`重放后 buildContext: ${restored.messages.length} 条消息, thinkingLevel=${restored.thinkingLevel}`);
	console.log("(对比 example/03:裸 Agent 重启后是 0 条,全忘)\n");

	const harness = new AgentHarness({
		models,
		env,
		session,
		model: faux.getModel(),
		// 树记得配置,应用负责把它喂回 harness —— 配置状态是扫完整路径推导出来的。
		// 树层存宽松的 string(它不认识模型词汇),喂回时由应用收窄成 ThinkingLevel。
		thinkingLevel: (restored.thinkingLevel as ThinkingLevel | undefined) ?? "off",
		systemPrompt: "你是一个记性很好的助手。",
	});
	harness.subscribe(tracer("重生"));

	// faux 工厂函数会收到真实的请求上下文 —— 用它验证历史真的被带上了
	faux.setResponses([
		(context) => {
			const sawName = context.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((block) => block.type === "text" && block.text.includes("小明")),
			);
			return fauxAssistantMessage(
				sawName
					? "你叫小明 —— 我是从会话树重放的历史里读到的,不是猜的。"
					: "(坏了,上下文里没有历史,重放失败)",
			);
		},
	]);
	const reply = await harness.prompt("我刚才说我叫什么?");
	console.log(`\n助手回答: ${reply.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`);
}

console.log(`\n会话文件还在: ${sessionPath}`);
console.log("可以 cat 它逐行看树条目 —— 每条 message/leaf/thinking_level_change 都是一行 JSON。");
console.log("这就是 harness 的第一笔回报:持久化不再是你手动 JSON.stringify 的事,而是循环的副作用。");
