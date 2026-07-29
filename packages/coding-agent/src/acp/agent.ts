/**
 * my-pi 的 ACP agent 侧实现。
 *
 * ACP 要求 agent 实现四个基线方法:initialize / authenticate / session/new / session/prompt。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	JsonlSessionRepo,
	type NodeExecutionEnv,
	type Session,
	type ThinkingLevel,
	uuidv7,
} from "@yoma/my-pi/node";
import { buildSystemPrompt, collectToolPromptData } from "../core/system-prompt.ts";
import { createCodingToolDefinitions, wrapToolDefinitions } from "../core/tools/index.ts";
import { pipeHarnessToAcp, replayUpdatesOf, type UpdateSink } from "./session.ts";

export const SESSIONS_DIR = join(homedir(), ".my-pi", "sessions");
export const LOGS_DIR = join(homedir(), ".my-pi", "logs");

/**
 * Zed 的模型下拉框和 thinking 下拉框都由 session/new / session/load 返回的
 * configOptions 渲染 —— 不是 models 字段(SDK 1.3.0 里根本没有 models 和
 * session/set_model),也不是 modes。这两个 id 就是 Zed settings.json 里
 * agent_servers.<name>.default_config_options 的键,改名会让默认值配置失效。
 */
export const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

/** ACP 的 SessionConfigOption(select 分支)。字段名逐字对齐 SDK 1.3.0 的 schema。 */
export interface AcpSelectConfigOption {
	type: "select";
	id: string;
	name: string;
	description: string | null;
	category: "model" | "thought_level";
	currentValue: string;
	options: Array<{ value: string; name: string; description: string | null }>;
}

/** 模型在 ACP 侧的稳定标识。Zed 把它原样回传给 session/set_config_option。 */
export function modelValueOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** modelValueOf 的逆运算。模型 id 本身可能含 "/",所以只切第一个。 */
export function parseModelValue(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * 纯函数版的 configOptions 构造,方便测试。
 *
 * thinking 档位来自模型自身的 thinkingLevelMap —— 模型 reasoning:false 时
 * getSupportedThinkingLevels 只会返回 ["off"],这是正确行为而不是 bug。
 */
export function buildConfigOptionsFor(
	models: Models,
	model: Model<any>,
	thinkingLevel: ThinkingLevel,
): AcpSelectConfigOption[] {
	const catalog = models.getModels();
	return [
		{
			type: "select",
			id: MODEL_CONFIG_ID,
			name: "Model",
			description: "Select the model for this session",
			category: "model",
			currentValue: modelValueOf(model),
			options: catalog.map((m) => ({
				value: modelValueOf(m),
				name: `${m.provider}/${m.name}`,
				description: null,
			})),
		},
		{
			type: "select",
			id: THOUGHT_LEVEL_CONFIG_ID,
			name: "Thinking",
			description: "Set the reasoning effort for this session",
			category: "thought_level",
			currentValue: thinkingLevel,
			options: getSupportedThinkingLevels(model).map((level) => ({
				value: level,
				name: `Thinking: ${level}`,
				description: null,
			})),
		},
	];
}

/** ACP 的 AvailableCommand。字段名逐字对齐 SDK 1.3.0。 */
export interface AcpAvailableCommand {
	name: string;
	description: string;
	input?: { hint: string } | null;
}

/**
 * 会话里可用的斜杠命令。
 *
 * 客户端收到 available_commands_update 才会把输入框提示改成
 * "@ to include context, / for commands" —— 不发这条通知,Zed 里就没有 / 菜单。
 *
 * 只登记 harness 真能执行的东西:登记了却不实现,用户敲了会石沉大海。
 * navigateTree 需要一个 entry id,没有树浏览 UI 之前不适合做成命令,所以不在列。
 */
export function availableCommands(): AcpAvailableCommand[] {
	return [
		{
			name: "compact",
			description: "Summarize the conversation so far and drop the compacted history",
			input: { hint: "optional instructions for the summary" },
		},
		{
			name: "status",
			description: "Show the session id, model, thinking level and working directory",
		},
	];
}

/** 把一条 prompt 文本解析成斜杠命令。不是命令则返回 undefined。 */
export function parseSlashCommand(text: string): { name: string; argument: string } | undefined {
	const match = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(text.trim());
	if (!match) return undefined;
	const name = match[1]!;
	if (!availableCommands().some((command) => command.name === name)) return undefined;
	return { name, argument: match[2]?.trim() ?? "" };
}

/** 换模型后旧档位可能不再受支持(例如切到 reasoning:false 的模型),夹回去。 */
export function clampThinkingLevel(model: Model<any>, level: ThinkingLevel): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return supported.includes(level) ? level : (supported[0] ?? "off");
}

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

	/** 当前会话的 configOptions。响应和通知共用一处构造,防止两边漂移。 */
	private configOptionsOf(sessionId: string): AcpSelectConfigOption[] {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found`);
		return buildConfigOptionsFor(
			this.options.models,
			session.harness.getModel(),
			session.harness.getThinkingLevel(),
		);
	}

	/**
	 * thinking 档位同时也用 ACP 的 session modes 表达一份。
	 *
	 * 这是照抄 pi-acp 的双保险:它同时发 configOptions 和 modes,而 Zed 只画出一个
	 * thinking 选择器 —— 说明客户端会二选一,不会重复渲染。哪条路被采用无所谓,
	 * 两条路最终都落到 harness.setThinkingLevel()。
	 */
	private modesOf(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found`);
		const model = session.harness.getModel();
		return {
			currentModeId: session.harness.getThinkingLevel(),
			availableModes: getSupportedThinkingLevels(model).map((level) => ({
				id: level,
				name: `Thinking: ${level}`,
				description: null,
			})),
		};
	}

	async authenticate(_params: unknown) {
		// key 由 pi-ai 的 provider 从环境变量读,ACP 这层不需要额外认证。
		return {};
	}

	async newSession(params: any, cx?: any) {
		const cwd: string = params?.cwd ?? this.options.env.cwd;
		const sessionId = uuidv7();

		// 会话经 repo 落盘,重开 Zed 也不会丢(经 session/load 找回)。
		const session = await this.repo.create({ cwd, id: sessionId });
		// 把"当前用什么模型"记进会话树,对齐 pi 会话文件开头的记账条目;恢复时靠它选模型。
		await session.appendModelChange(this.options.model.provider, this.options.model.id);

		await this.setupSession(sessionId, cwd, session);
		// 命令清单只能靠通知送达 —— session/new 的响应里没有装它的字段。
		await this.announceCommands(sessionId, cx);
		return {
			sessionId,
			configOptions: this.configOptionsOf(sessionId),
			modes: this.modesOf(sessionId),
		};
	}

	/** 推送斜杠命令清单。客户端据此把输入框变成 "/ for commands"。 */
	private async announceCommands(sessionId: string, cx: any): Promise<void> {
		await cx?.notify?.("session/update", {
			sessionId,
			update: { sessionUpdate: "available_commands_update", availableCommands: availableCommands() },
		});
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

		// buildContext 一次拿全:消息投影、当时的模型、当时的 thinking 档位。
		// 必须在 setupSession 之前算,因为 thinkingLevel 要在构造 harness 时就传进去。
		const context = await session.buildContext();

		// 恢复模型:注册表里找得到就用,找不到(provider 没配 key、模型已下架)
		// 就回退到启动时解析的默认模型。
		const model = context.model
			? (this.options.models.getModel(context.model.provider, context.model.modelId) ?? this.options.model)
			: this.options.model;
		// 恢复 thinking 档位。会话记的是字符串,换过模型后可能已不受支持,夹一次。
		const thinkingLevel = clampThinkingLevel(model, context.thinkingLevel as ThinkingLevel);

		await this.setupSession(sessionId, cwd ?? metadata.cwd, session, model, thinkingLevel);
		await this.announceCommands(sessionId, cx);

		// 重放历史:把会话树的线性投影翻译成 session/update 逐条发给客户端,
		// Zed 收完这串通知才会把旧对话画出来。
		for (const update of replayUpdatesOf(context.messages)) {
			await cx.notify("session/update", { sessionId, update });
		}
		return {
			configOptions: this.configOptionsOf(sessionId),
			modes: this.modesOf(sessionId),
		};
	}

	/** newSession / loadSession 共用的装配:env、工具、harness、观测日志、会话注册。 */
	private async setupSession(
		sessionId: string,
		cwd: string,
		session: Session,
		restoredModel?: Model<any>,
		restoredThinkingLevel?: ThinkingLevel,
	): Promise<AcpSession> {
		// 注册表是全局唯一的(resolveModel 把所有配了 key 的 provider 都注册了进去),
		// 所以跨 provider 切模型不需要换注册表 —— 也换不了,harness.models 是 readonly。
		const models = this.options.models;
		const model = restoredModel ?? this.options.model;
		const thinkingLevel = restoredThinkingLevel ?? clampThinkingLevel(model, "off");

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
			thinkingLevel,
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

	/**
	 * Zed 在下拉框里选了值 → 这里落到 harness。
	 *
	 * 必须返回 { configOptions }:SetSessionConfigOptionResponse 里这个字段是必填的,
	 * 而且这个方法在 SDK 里没有 void→{} 的兜底 mapper(session/set_mode 才有),
	 * 返回 undefined 会在响应校验时直接失败。
	 */
	async setSessionConfigOption(params: any, cx: any): Promise<{ configOptions: AcpSelectConfigOption[] }> {
		const sessionId: string = params?.sessionId;
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}
		const value = String(params?.value ?? "");

		switch (params?.configId) {
			case MODEL_CONFIG_ID: {
				const parsed = parseModelValue(value);
				const model = parsed ? this.options.models.getModel(parsed.provider, parsed.modelId) : undefined;
				// 用 JSON-RPC 的 invalidParams 而不是裸 Error:后者会被 SDK 包成
				// "Internal error",客户端只能看到一句废话。
				if (!model) throw RequestError.invalidParams(undefined, `Unknown model: ${value}`);
				await session.harness.setModel(model);
				// 新模型未必支持旧档位(例如切到 reasoning:false 的模型),夹一次并落盘。
				const clamped = clampThinkingLevel(model, session.harness.getThinkingLevel());
				if (clamped !== session.harness.getThinkingLevel()) {
					await session.harness.setThinkingLevel(clamped);
				}
				break;
			}
			case THOUGHT_LEVEL_CONFIG_ID: {
				const supported = getSupportedThinkingLevels(session.harness.getModel()) as ThinkingLevel[];
				if (!supported.includes(value as ThinkingLevel)) {
					throw RequestError.invalidParams(undefined, `Unsupported thinking level: ${value}`);
				}
				await session.harness.setThinkingLevel(value as ThinkingLevel);
				break;
			}
			default:
				throw RequestError.invalidParams(undefined, `Unknown config option: ${params?.configId}`);
		}

		// 回推一份完整的新状态,否则客户端那边的选中项不会跟着变。
		const configOptions = this.configOptionsOf(sessionId);
		await cx?.notify?.("session/update", {
			sessionId,
			update: { sessionUpdate: "config_option_update", configOptions },
		});
		return { configOptions };
	}

	/** thinking 档位的 modes 表达。语义与 setSessionConfigOption 的 thought_level 分支相同。 */
	async setSessionMode(params: any, cx: any): Promise<Record<string, never>> {
		const sessionId: string = params?.sessionId;
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}
		const modeId = String(params?.modeId ?? "");
		const supported = getSupportedThinkingLevels(session.harness.getModel()) as ThinkingLevel[];
		if (!supported.includes(modeId as ThinkingLevel)) {
			throw RequestError.invalidParams(undefined, `Unknown mode: ${modeId}`);
		}
		await session.harness.setThinkingLevel(modeId as ThinkingLevel);
		await cx?.notify?.("session/update", {
			sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
		});
		return {};
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
			// 斜杠命令在本地执行,不进模型。命令是会话级操作(压缩、查状态),
			// 交给模型只会变成它对着一句 "/compact" 瞎猜。
			const command = parseSlashCommand(text);
			if (command) {
				await this.runCommand(params.sessionId, session, command, sink);
				return { stopReason: "end_turn" };
			}
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

	/**
	 * 执行一条斜杠命令,结果以 agent_message_chunk 回显。
	 *
	 * 命令失败(例如没东西可压缩)不往上抛 —— 那会让 Zed 弹一个红色的协议错误,
	 * 而用户想看到的只是一句"没什么可压缩的"。
	 */
	private async runCommand(
		sessionId: string,
		session: AcpSession,
		command: { name: string; argument: string },
		sink: UpdateSink,
	): Promise<void> {
		const say = (text: string) => sink({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

		switch (command.name) {
			case "compact": {
				try {
					const result = await session.harness.compact(command.argument || undefined);
					await say(
						`🗜️ 已压缩会话(压缩前约 ${result.tokensBefore} tokens)。\n\n**摘要**\n\n${result.summary}`,
					);
				} catch (error) {
					await say(`⚠️ 压缩失败:${(error as Error)?.message ?? String(error)}`);
				}
				return;
			}
			case "status": {
				const model = session.harness.getModel();
				await say(
					[
						`**session** ${sessionId}`,
						`**model** ${modelValueOf(model)}${model.reasoning ? "" : "(不支持 thinking)"}`,
						`**thinking** ${session.harness.getThinkingLevel()}`,
						`**cwd** ${session.cwd}`,
						`**tools** ${session.harness.getTools().length}`,
					].join("\n"),
				);
				return;
			}
			default:
				await say(`未知命令:/${command.name}`);
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
