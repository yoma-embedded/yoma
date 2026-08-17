// 无头驱动:把一句 prompt 交给 yoma 的 AgentHarness 跑到底,不经 Zed/ACP。
//
// ACP 适配器是给编辑器用的(stdio 上的 JSON-RPC),脚本化跑评测不方便。
// 这里按 acp/agent.ts:348 的同一套装配复刻一个最小驱动:同样的工具集、
// 同样由工具自述拼出的系统提示词,只把事件出口换成 stdout + JSONL。
//
// 用法:
//   YOMA_PROVIDER=deepseek YOMA_MODEL=deepseek-v4-flash \
//   bun example/99-headless-run.ts <工作目录> <prompt文件> <事件日志.jsonl>

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { AgentHarness, InMemorySessionStorage, NodeExecutionEnv, Session } from "@yoma/agent/node";
import { CONFIG_DIR } from "../packages/coding-agent/src/acp/agent.ts";
import { resolveModel } from "../packages/coding-agent/src/acp/models.ts";
import { buildSystemPrompt, collectToolPromptData } from "../packages/coding-agent/src/core/system-prompt.ts";
import {
	createCodingToolDefinitions,
	createEmbeddedToolDefinitions,
} from "../packages/coding-agent/src/core/tools/index.ts";
import { wrapToolDefinitions } from "../packages/coding-agent/src/core/tools/types.ts";

const [cwd, promptFile, logPath] = process.argv.slice(2);
if (!cwd || !promptFile || !logPath) {
	console.error("用法: bun example/99-headless-run.ts <工作目录> <prompt文件> <事件日志.jsonl>");
	process.exit(2);
}
const prompt = readFileSync(promptFile, "utf8").trim();

const { models, model } = await resolveModel(CONFIG_DIR);
console.log(`模型: ${model.provider}/${model.id}`);
console.log(`工作目录: ${cwd}`);
console.log(`prompt: ${prompt}\n${"━".repeat(70)}`);

const env = new NodeExecutionEnv({ cwd });
const toolDefinitions = [...createCodingToolDefinitions(env), ...createEmbeddedToolDefinitions(env)];
const harness = new AgentHarness({
	env,
	session: new Session(new InMemorySessionStorage()),
	models,
	model,
	systemPrompt: buildSystemPrompt({ cwd, ...collectToolPromptData(toolDefinitions) }),
	tools: wrapToolDefinitions(toolDefinitions),
});

writeFileSync(logPath, "");
const started = Date.now();
let toolCalls = 0;
const t = () => `[${((Date.now() - started) / 1000).toFixed(0)}s]`;

harness.subscribe((event: any) => {
	// message_update / tool_execution_update 是逐 token 的增量流,只记终态。
	if (event.type === "message_update" || event.type === "tool_execution_update") return;
	appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);

	if (event.type === "tool_execution_start") {
		toolCalls++;
		const args = JSON.stringify(event.args ?? {});
		console.log(`${t()} → ${event.toolName} ${args.length > 220 ? `${args.slice(0, 220)}…` : args}`);
	}
	if (event.type === "tool_execution_end" && event.isError) {
		console.log(`${t()}   ✗ ${event.toolName} 失败`);
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const text = (event.message.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		if (text) console.log(`${t()} 助手: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
	}
});

try {
	await harness.prompt(prompt);
	console.log(`${"━".repeat(70)}\n完成 · ${toolCalls} 次工具调用 · ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (error) {
	console.error(`${"━".repeat(70)}\n中断: ${(error as Error).message}`);
	process.exit(1);
}
