/**
 * my-pi 的 ACP agent 侧实现。
 *
 * ACP 要求 agent 实现四个基线方法:initialize / authenticate / session/new / session/prompt。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { AgentHarness, JsonlSessionStorage, type NodeExecutionEnv, Session, uuidv7 } from "@yoma/my-pi/node";
import { buildSystemPrompt, collectToolPromptData } from "../core/system-prompt.ts";
import { createCodingToolDefinitions, wrapToolDefinitions } from "../core/tools/index.ts";
import { pipeHarnessToAcp, type UpdateSink } from "./session.ts";

export const SESSIONS_DIR = join(homedir(), ".my-pi", "sessions");
export const LOGS_DIR = join(homedir(), ".my-pi", "logs");

interface AcpSession {
	harness: AgentHarness<any, any, any>;
	cwd: string;
	pendingPrompt: AbortController | null;
	/** 当前 prompt 的通知发送口;不在 prompt 中时为 undefined。 */
	sink?: UpdateSink;
	unsubscribe?: () => void;
}

export interface MyPiAcpAgentOptions {
	env: NodeExecutionEnv;
	models: Models;
	model: Model<any>;
	protocolVersion: number;
	sessionsDir?: string;
	logsDir?: string;
}

export class MyPiAcpAgent {
	private sessions = new Map<string, AcpSession>();

	constructor(private options: MyPiAcpAgentOptions) {}

	async initialize(_params: any) {
		return {
			protocolVersion: this.options.protocolVersion,
			agentCapabilities: { loadSession: false },
			authMethods: [],
		};
	}

	async authenticate(_params: unknown) {
		// key 由 pi-ai 的 provider 从环境变量读,ACP 这层不需要额外认证。
		return {};
	}

	async newSession(params: any) {
		const cwd: string = params?.cwd ?? this.options.env.cwd;
		const sessionId = uuidv7();

		// 会话落 ~/.my-pi/sessions/<id>.jsonl,重开 Zed 也不会丢。
		await this.options.env.createDir(this.options.sessionsDir ?? SESSIONS_DIR, { recursive: true });
		const sessionPath = join(this.options.sessionsDir ?? SESSIONS_DIR, `${sessionId}.jsonl`);
		const storage = await JsonlSessionStorage.create(this.options.env, sessionPath, { cwd, sessionId });

		// 每个会话有自己的 cwd,所以工具也要绑到那个 cwd 上的 env。
		const env =
			cwd === this.options.env.cwd
				? this.options.env
				: new (this.options.env.constructor as typeof NodeExecutionEnv)({ cwd });

		// 系统提示词按会话构建:身份 + 实际注册的工具清单与守则 + cwd,
		// 全部来自工具定义自带的 promptSnippet / promptGuidelines,不再手写。
		const toolDefinitions = createCodingToolDefinitions(env);
		const harness = new AgentHarness({
			env,
			session: new Session(storage),
			models: this.options.models,
			model: this.options.model,
			systemPrompt: buildSystemPrompt({
				cwd,
				...collectToolPromptData(toolDefinitions),
			}),
			tools: wrapToolDefinitions(toolDefinitions),
		});

		// 观测日志:harness 全事件逐行落 ~/.my-pi/logs/<sessionId>.jsonl,tail -f 即可旁观。
		// message_update / tool_execution_update 是增量流(每 token / 每输出块一条),
		// 最终态都会出现在 message_end 和工具结果里,记它们只会刷爆日志,跳过。
		await this.options.env.createDir(this.options.logsDir ?? LOGS_DIR, { recursive: true });
		const eventsLogPath = join(this.options.logsDir ?? LOGS_DIR, `${sessionId}.jsonl`);
		harness.subscribe(async (event) => {
			if (event.type === "message_update" || event.type === "tool_execution_update") return;
			try {
				const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
				await this.options.env.appendFile(eventsLogPath, `${line}\n`);
			} catch {
				// 日志失败绝不能影响会话本身(appendFile 本不抛,这里防的是序列化)。
			}
		});

		const acpSession: AcpSession = { harness, cwd, pendingPrompt: null };

		this.sessions.set(sessionId, acpSession);
		return { sessionId, modes: null };
	}

	async prompt(params: any, cx: any): Promise<{ stopReason: "end_turn" | "cancelled" }> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new Error(`Session ${params.sessionId} not found`);
		}

		// 同一会话的新 prompt 先掐掉上一个,和 ACP 参考实现一致。
		session.pendingPrompt?.abort();
		session.pendingPrompt = new AbortController();

		const sink: UpdateSink = async (update) => {
			await cx.notify("session/update", { sessionId: params.sessionId, update });
		};
		session.sink = sink;
		session.unsubscribe = pipeHarnessToAcp(session.harness, sink);

		const text = promptToText(params.prompt);
		try {
			await session.harness.prompt(text);
			return { stopReason: "end_turn" };
		} catch (error) {
			if (session.pendingPrompt.signal.aborted) {
				return { stopReason: "cancelled" };
			}
			throw error;
		} finally {
			session.unsubscribe?.();
			session.unsubscribe = undefined;
			session.sink = undefined;
			session.pendingPrompt = null;
		}
	}

	async cancel(params: any) {
		const session = this.sessions.get(params.sessionId);
		session?.pendingPrompt?.abort();
		await session?.harness.abort();
	}
}

/** ACP 的 prompt 是 ContentBlock 数组,my-pi 目前只吃文本。 */
function promptToText(prompt: unknown): string {
	if (!Array.isArray(prompt)) return String(prompt ?? "");
	return prompt
		.map((block: any) => {
			if (block?.type === "text") return block.text ?? "";
			// resource_link / resource 用路径占位,让模型知道用户引用了什么。
			if (block?.type === "resource_link") return block.uri ?? "";
			if (block?.type === "resource") return block.resource?.uri ?? "";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
