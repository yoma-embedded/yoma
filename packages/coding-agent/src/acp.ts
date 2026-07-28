#!/usr/bin/env bun
/**
 * my-pi 的 ACP 入口。Zed(或任何 ACP 客户端)把它当子进程起,用 JSON-RPC over stdio 对话。
 *
 * 用法(Zed 的 settings.json):
 *   "agent_servers": {
 *     "my-pi": { "type": "custom", "command": "bun",
 *                "args": ["/绝对路径/packages/coding-agent/src/acp.ts"] }
 *   }
 *
 * 调试:stderr 不参与协议,全部落到 ~/.my-pi/acp.log。Zed 里出问题时 tail -f 它。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import { MyPiAcpAgent } from "./acp/agent.ts";
import { resolveModel } from "./acp/models.ts";

const LOG_DIR = join(homedir(), ".my-pi");
const LOG_PATH = join(LOG_DIR, "acp.log");

function log(message: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
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
	const cwd = process.env.MY_PI_CWD ?? process.cwd();
	const env = new NodeExecutionEnv({ cwd });

	const resolved = await resolveModel();
	log(`starting my-pi acp: provider=${resolved.model.provider} model=${resolved.model.id} cwd=${cwd}`);

	const agent = new MyPiAcpAgent({
		env,
		models: resolved.models,
		model: resolved.model,
		protocolVersion: acp.PROTOCOL_VERSION,
	});

	const output = Writable.toWeb(process.stdout);
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const stream = acp.ndJsonStream(output, input);

	acp
		.agent({ name: "my-pi" })
		.onRequest("initialize", (ctx: any) => agent.initialize(ctx.params))
		.onRequest("authenticate", (ctx: any) => agent.authenticate(ctx.params))
		.onRequest("session/new", (ctx: any) => agent.newSession(ctx.params))
		.onRequest("session/load", (ctx: any) => agent.loadSession(ctx.params, ctx.client))
		.onRequest("session/prompt", (ctx: any) => agent.prompt(ctx.params, ctx.client))
		.onNotification("session/cancel", (ctx: any) => agent.cancel(ctx.params))
		.connect(stream);

	log("connected");
}

main().catch((error) => {
	log(`fatal: ${String((error as Error)?.stack ?? error)}`);
	process.exit(1);
});
