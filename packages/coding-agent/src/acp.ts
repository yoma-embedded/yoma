#!/usr/bin/env bun
/**
 * yoma 的 ACP 入口。Zed(或任何 ACP 客户端)把它当子进程起,用 JSON-RPC over stdio 对话。
 *
 * 用法(Zed 的 settings.json):
 *   "agent_servers": {
 *     "yoma": { "type": "custom", "command": "bun",
 *                "args": ["/绝对路径/packages/coding-agent/src/acp.ts"] }
 *   }
 *
 * 调试:stderr 不参与协议,全部落到 ~/.yoma/acp.log。Zed 里出问题时 tail -f 它。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { NodeExecutionEnv } from "@yoma/agent/node";
import { CONFIG_DIR, YomaAcpAgent } from "./acp/agent.ts";
import { resolveModel } from "./acp/models.ts";

const LOG_PATH = join(CONFIG_DIR, "acp.log");

function log(message: string): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// 日志失败绝不能影响协议。
	}
}

// stdout 是协议通道,任何误打印都会毁掉 JSON-RPC 分帧。把 console 全部改道到 stderr。
console.log = (...args: unknown[]) => console.error(...args);

process.on("uncaughtException", (error) => log(`uncaughtException: ${String((error as Error)?.stack ?? error)}`));
process.on("unhandledRejection", (reason) => log(`unhandledRejection: ${String(reason)}`));

async function main(): Promise<void> {
	const cwd = process.env.YOMA_CWD ?? process.cwd();
	const env = new NodeExecutionEnv({ cwd });

	const resolved = await resolveModel(CONFIG_DIR);
	log(`starting yoma acp: provider=${resolved.model.provider} model=${resolved.model.id} cwd=${cwd}`);

	const agent = new YomaAcpAgent({
		env,
		models: resolved.models,
		model: resolved.model,
		protocolVersion: acp.PROTOCOL_VERSION,
	});

	const output = Writable.toWeb(process.stdout);
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const stream = acp.ndJsonStream(output, input);

	acp
		.agent({ name: "yoma" })
		.onRequest("initialize", (ctx: any) => agent.initialize(ctx.params))
		.onRequest("authenticate", (ctx: any) => agent.authenticate(ctx.params))
		// newSession 要拿 client 句柄才能推 available_commands_update。
		.onRequest("session/new", (ctx: any) => agent.newSession(ctx.params, ctx.client))
		.onRequest("session/load", (ctx: any) => agent.loadSession(ctx.params, ctx.client))
		// 模型 / thinking 下拉框的落点。不注册的话 Zed 点一下只会拿到 -32601。
		.onRequest("session/set_config_option", (ctx: any) => agent.setSessionConfigOption(ctx.params, ctx.client))
		.onRequest("session/set_mode", (ctx: any) => agent.setSessionMode(ctx.params, ctx.client))
		.onRequest("session/prompt", (ctx: any) => agent.prompt(ctx.params, ctx.client))
		.onNotification("session/cancel", (ctx: any) => agent.cancel(ctx.params))
		.connect(stream);

	log("connected");
}

main().catch((error) => {
	log(`fatal: ${String((error as Error)?.stack ?? error)}`);
	process.exit(1);
});
