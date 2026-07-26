// 🎓 毕业典礼:本文件曾导入 pi-minimal 的 harness 做演示,现在跑的是 **你自己写的** 实现。
// 正例:AgentHarness 如何解决 example/03 里的三个痛点。全程离线(faux 模型):
//   解法 1: 自动持久化 —— message_end 先落盘再通知;重启 = 重新打开同一个 JSONL 文件
//   解法 2: compaction —— 树里一条不删,只是"投影"变小;切点永远在轮边界
//   解法 3: 会话树分支 —— navigateTree 移动 leaf 指针,重试不销毁历史
//
// 运行: bun example/04-正例-harness如何解决.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	type ExecutionEnv,
	InMemorySessionStorage,
	JsonlSessionStorage,
	NodeExecutionEnv,
	Session,
} from "@yoma/my-pi/node";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const dir = mkdtempSync(join(tmpdir(), "harness-demo-"));
// M6 给 NodeExecutionEnv 补上 exec 后,这个 cast 即可删除。
const env = new NodeExecutionEnv({ cwd: dir }) as unknown as ExecutionEnv;

// ============================================================================
console.log("━━━ 解法 1: 自动持久化 + 重启恢复 ━━━\n");

const sessionPath = join(dir, "session.jsonl");
const storage = await JsonlSessionStorage.create(env, sessionPath, { cwd: dir, sessionId: "demo-1" });
const session = new Session(storage);
const harness = new AgentHarness({
	env,
	session,
	models,
	model: faux.getModel(),
	systemPrompt: "你是一个简洁的助手。",
});

faux.setResponses([fauxAssistantMessage("北京 22°C 多云。")]);
await harness.prompt("北京天气怎么样?");
faux.setResponses([fauxAssistantMessage("上海 26°C 晴。")]);
await harness.prompt("那上海呢?");

console.log(`聊了两轮。你没写一行持久化代码,但磁盘上已经有了: ${sessionPath}`);
console.log(`会话文件条目数: ${(await session.getEntries()).length}(每条 message_end 都是先落盘、再通知订阅者)\n`);

// "进程重启":丢掉内存里的一切,从同一个文件重新打开 ——
const storage2 = await JsonlSessionStorage.open(env, sessionPath);
const session2 = new Session(storage2);
const harness2 = new AgentHarness({
	env,
	session: session2,
	models,
	model: faux.getModel(),
	systemPrompt: "你是一个简洁的助手。",
});
const restored = await session2.buildContext();
console.log(`重启后恢复出 ${restored.messages.length} 条消息,记忆完好。接着追问也没问题:`);
faux.setResponses([fauxAssistantMessage("广州 30°C,有阵雨。")]);
await harness2.prompt("广州呢?");
console.log(`追问成功,现在共 ${(await session2.buildContext()).messages.length} 条消息。\n`);

// ============================================================================
console.log("━━━ 解法 2: compaction —— 投影变小,历史一条不删 ━━━\n");

// 造一段"很长"的对话:5 轮,每轮回答 4 万字符,把上下文撑到必须压缩。
const longPath = join(dir, "long-session.jsonl");
const longStorage = await JsonlSessionStorage.create(env, longPath, { cwd: dir, sessionId: "demo-2" });
const longSession = new Session(longStorage);
const longHarness = new AgentHarness({
	env,
	session: longSession,
	models,
	model: faux.getModel(),
	systemPrompt: "你是一个简洁的助手。",
});
for (let i = 1; i <= 5; i++) {
	faux.setResponses([fauxAssistantMessage(`第${i}个话题的超长回答:` + "内容".repeat(20_000))]);
	await longHarness.prompt(`讲讲第${i}个话题`);
}

const contextChars = (msgs: unknown[]) => JSON.stringify(msgs).length;
const before = await longSession.buildContext();
console.log(`压缩前: 上下文 ${before.messages.length} 条消息,约 ${contextChars(before.messages)} 字符`);
console.log(`         会话树 ${(await longSession.getEntries()).length} 个条目\n`);

// compact 会调用 LLM 生成摘要 —— faux 模型同样能扮演这个角色。
// (切点落在轮中间时会额外生成一个"轮前缀摘要",所以排两条响应)
faux.setResponses([
	fauxAssistantMessage("摘要:用户依次询问了话题一到话题四,均已给出超长回答。"),
	fauxAssistantMessage("轮前缀摘要:该轮开头部分的内容概述。"),
]);
const result = await longHarness.compact();

const after = await longSession.buildContext();
console.log(`压缩后: 上下文 ${after.messages.length} 条消息,约 ${contextChars(after.messages)} 字符`);
console.log(`         上下文第一条消息的角色: "${after.messages[0]?.role}"(摘要顶替了被压掉的历史)`);
console.log(`         会话树 ${(await longSession.getEntries()).length} 个条目 —— 不减反增(+1 条 compaction 条目)!`);
console.log(`
→ 关键:压缩改变的是"投影"(buildContext 的输出),不是历史本身。
  原始对话全部还在树里,崩溃在摘要生成途中也无损(落盘前一切如旧)。
  切点由 findCutPoint 保证落在轮边界 —— 痛点 2 的"孤儿 toolResult"在这里不可能发生。
  (本次保留了 firstKeptEntryId=${result.firstKeptEntryId.slice(0, 8)}… 之后的近期消息,更早的被摘要吸收)
`);

// ============================================================================
console.log("━━━ 解法 3: 会话树分支 —— 重试不毁历史 ━━━\n");

// 换用内存存储,顺便展示存储后端是可插拔的(同一个 SessionStorage 接口)。
const memSession = new Session(new InMemorySessionStorage());
const memHarness = new AgentHarness({
	env,
	session: memSession,
	models,
	model: faux.getModel(),
	systemPrompt: "你是一个简洁的助手。",
});

faux.setResponses([fauxAssistantMessage("方案一:用递归实现。")]);
await memHarness.prompt("怎么实现目录遍历?");
faux.setResponses([fauxAssistantMessage("好的,已按方案一写完。")]);
await memHarness.prompt("就按这个写吧");
console.log(`聊了两轮,当前分支 ${(await memSession.buildContext()).messages.length} 条消息。`);

// 想回到第一个问题重试:在树里找到那条 user 消息,把 leaf 指回它 ——
const entries = await memSession.getEntries();
const firstUserEntry = entries.find((e) => e.type === "message" && e.message.role === "user")!;
const nav = await memHarness.navigateTree(firstUserEntry.id);
console.log(`navigateTree 回到了第一个问题之前,还把原文还给你编辑: "${nav.editorText}"`);

faux.setResponses([fauxAssistantMessage("方案二:用显式栈迭代实现。")]);
await memHarness.prompt("怎么实现目录遍历?用迭代而不是递归。");

const branch = await memSession.buildContext();
console.log(`\n重试后的当前分支: ${branch.messages.length} 条消息(问题 + 方案二)`);
console.log(`但整棵树有 ${(await memSession.getEntries()).length} 个条目 —— 方案一的整条时间线原封不动地留在另一根树枝上,`);
console.log(`随时可以再 navigateTree 回去对比。"回到过去"只是移动 leaf 指针 + 追加新条目,什么都没删。\n`);

console.log("━━━ 总结 ━━━");
console.log(`harness 没有自己的循环 —— 它只是给 runAgentLoop 喂了一套精心构造的回调。`);
console.log(`它做的所有事都是同一招:把"隐式的可变状态"换成"显式的、只追加的记录"。`);
console.log(`  掉电失忆   → 每条消息先落盘再通知(追加式 JSONL)`);
console.log(`  上下文膨胀 → compaction 条目 + 投影(历史不删,轮边界安全切)`);
console.log(`  重试毁历史 → 树 + leaf 指针(分叉而非截断)`);
