/**
 * my-pi 的 ACP agent 侧实现。
 *
 * ACP 要求 agent 实现四个基线方法:initialize / authenticate / session/new / session/prompt。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { AgentHarness, JsonlSessionRepo, type NodeExecutionEnv, type Session, uuidv7 } from "@yoma/my-pi/node";
import { buildSystemPrompt, collectToolPromptData } from "../core/system-prompt.ts";
import { createCodingToolDefinitions, wrapToolDefinitions } from "../core/tools/index.ts";
import { type ResolvedModel, resolveModelFor } from "./models.ts";
import { pipeHarnessToAcp, replayUpdatesOf, type UpdateSink } from "./session.ts";

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
	// 会话仓库,目录布局与 pi 相同:<root>/--<cwd 编码>--/<时间戳>_<sessionId>.jsonl。
	private repo: JsonlSessionRepo;

	constructor(private options: MyPiAcpAgentOptions) {
		this.repo = new JsonlSessionRepo({ fs: options.env, sessionsRoot: options.sessionsDir ?? SESSIONS_DIR });
	}

	async initialize(_params: any) {
		return {
			protocolVersion: this.options.protocolVersion,
			agentCapabilities: { loadSession: true },
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

		// 会话经 repo 落盘,重开 Zed 也不会丢(经 session/load 找回)。
		const session = await this.repo.create({ cwd, id: sessionId });
		// 把"当前用什么模型"记进会话树,对齐 pi 会话文件开头的记账条目;恢复时靠它选模型。
		await session.appendModelChange(this.options.model.provider, this.options.model.id);

		await this.setupSession(sessionId, cwd, session);
		return { sessionId, modes: null };
	}

	async loadSession(params: any, cx: any) {
		const sessionId: string = params?.sessionId;
		const cwd: string | undefined = params?.cwd;

		// 先在 Zed 给的 cwd 目录下找,找不到再全局找(会话可能建在别的项目里)。
		const candidates = cwd ? await this.repo.list({ cwd }) : [];
		const metadata =
			candidates.find((entry) => entry.id === sessionId) ??
			(await this.repo.list()).find((entry) => entry.id === sessionId);
		if (!metadata) {
			throw new Error(`Session ${sessionId} not found`);
		}
		const session = await this.repo.open(metadata);

		// 恢复模型:会话树里最后一条 model_change 记着当时用的什么。能装配就装配,
		// 装配不出来(provider 没配 key 等)就回退到启动时解析的默认模型。
		const modelChanges = await session.getStorage().findEntries("model_change");
		const lastModelChange = modelChanges[modelChanges.length - 1];
		const resolved =
			lastModelChange &&
			(lastModelChange.provider !== this.options.model.provider ||
				lastModelChange.modelId !== this.options.model.id)
				? await resolveModelFor(lastModelChange.provider, lastModelChange.modelId)
				: undefined;

		await this.setupSession(sessionId, cwd ?? metadata.cwd, session, resolved);

		// 重放历史:把会话树的线性投影翻译成 session/update 逐条发给客户端,
		// Zed 收完这串通知才会把旧对话画出来。
		const context = await session.buildContext();
		for (const update of replayUpdatesOf(context.messages)) {
			await cx.notify("session/update", { sessionId, update });
		}
		return { modes: null };
	}

	/** newSession / loadSession 共用的装配:env、工具、harness、观测日志、会话注册。 */
	private async setupSession(
		sessionId: string,
		cwd: string,
		session: Session,
		resolved?: ResolvedModel,
	): Promise<AcpSession> {
		const models = resolved?.models ?? this.options.models;
		const model = resolved?.model ?? this.options.model;

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
			session,
			models,
			model,
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
		return acpSession;
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
