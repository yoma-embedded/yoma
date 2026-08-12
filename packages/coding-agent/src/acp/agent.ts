/**
 * my-pi 的 ACP agent 侧实现。
 *
 * ACP 要求 agent 实现四个基线方法:initialize / authenticate / session/new / session/prompt。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import {
	AgentHarness,
	type AgentMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	JsonlSessionRepo,
	type NodeExecutionEnv,
	type Session,
	shouldCompact,
	type Skill,
	type ThinkingLevel,
	uuidv7,
} from "@yoma/my-pi/node";
import { discoverSkills, loadContextFiles } from "../core/resources.ts";
import { buildSystemPrompt, collectToolPromptData } from "../core/system-prompt.ts";
import { createCodingToolDefinitions, createEmbeddedToolDefinitions, wrapToolDefinitions } from "../core/tools/index.ts";
import { pipeHarnessToAcp, replayUpdatesOf, type UpdateSink } from "./session.ts";

export const CONFIG_DIR = join(homedir(), ".my-pi");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
export const LOGS_DIR = join(CONFIG_DIR, "logs");

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
 * 会话里可用的斜杠命令:内置命令 + 每个技能一条 `/skill:name`(语义同 pi)。
 *
 * 客户端收到 available_commands_update 才会把输入框提示改成
 * "@ to include context, / for commands" —— 不发这条通知,Zed 里就没有 / 菜单。
 *
 * 只登记 harness 真能执行的东西:登记了却不实现,用户敲了会石沉大海。
 * navigateTree 需要一个 entry id,没有树浏览 UI 之前不适合做成命令,所以不在列。
 * disable-model-invocation 的技能也在列 —— 那个开关只隐藏系统提示词里的条目,
 * 显式的 /skill: 调用恰恰是它存在的意义。
 */
export function availableCommandsFor(skills: Skill[] = []): AcpAvailableCommand[] {
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
		...skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			input: { hint: "optional extra instructions" },
		})),
	];
}

/** 把一条 prompt 文本解析成斜杠命令。不在 commands 清单里的不算命令(会正常发给模型)。 */
export function parseSlashCommand(
	text: string,
	commands: AcpAvailableCommand[] = availableCommandsFor(),
): { name: string; argument: string } | undefined {
	const match = /^\/([a-zA-Z][\w:-]*)\s*([\s\S]*)$/.exec(text.trim());
	if (!match) return undefined;
	const name = match[1]!;
	if (!commands.some((command) => command.name === name)) return undefined;
	return { name, argument: match[2]?.trim() ?? "" };
}

/**
 * 一轮结束后该不该自动压缩。抽成纯函数,因为这里有两个容易写错、又只在长会话里
 * 才暴露的判断,埋在效果代码里测不动。
 *
 * @param messages           buildContext() 投影出的消息(已应用最后一次压缩)
 * @param contextWindow      当前模型的上下文窗口
 * @param lastCompactionAtMs 最后一条 compaction 条目的时间戳;没压过则 undefined
 */
export function shouldAutoCompact(
	messages: AgentMessage[],
	contextWindow: number,
	lastCompactionAtMs?: number,
): { compact: boolean; tokens: number; reason: "no_usage" | "just_compacted" | "under_threshold" | "over_threshold" } {
	const estimate = estimateContextTokens(messages);

	// 没有任何 usage 数据时不猜:纯估算会把还没跑过一轮的会话误判成该压。
	if (estimate.lastUsageIndex === null) return { compact: false, tokens: estimate.tokens, reason: "no_usage" };

	// 压缩刚做完时,保留下来的消息带的仍是压缩前(更大)那个上下文的 usage。
	// 信了它就会压完立刻又触发,一路压到没东西可压。
	if (lastCompactionAtMs !== undefined) {
		const usageMessage = messages[estimate.lastUsageIndex] as { role?: string; timestamp?: number } | undefined;
		if (
			usageMessage?.role === "assistant" &&
			typeof usageMessage.timestamp === "number" &&
			usageMessage.timestamp <= lastCompactionAtMs
		) {
			return { compact: false, tokens: estimate.tokens, reason: "just_compacted" };
		}
	}

	return shouldCompact(estimate.tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)
		? { compact: true, tokens: estimate.tokens, reason: "over_threshold" }
		: { compact: false, tokens: estimate.tokens, reason: "under_threshold" };
}

/** 换模型后旧档位可能不再受支持(例如切到 reasoning:false 的模型),夹回去。 */
export function clampThinkingLevel(model: Model<any>, level: ThinkingLevel): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return supported.includes(level) ? level : (supported[0] ?? "off");
}

/** 轮级自动重试的预算与退避,取 pi 的默认值(retry.enabled=true / 3 次 / 2s 起步指数退避)。 */
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 2000;

export function retryDelayMs(attempt: number, baseDelayMs: number = RETRY_BASE_DELAY_MS): number {
	return baseDelayMs * 2 ** (attempt - 1);
}

/**
 * 一轮以失败收场后,该不该自动重试。抽成纯函数,原因同 shouldAutoCompact。
 *
 * 不重试的三种情况:预算耗尽;上下文溢出(该压缩,重试同一请求只会再溢出一次 ——
 * pi 也是这么分工的);以及 isRetryableAssistantError 判定的不可重试错误
 * (认证失败、参数错误、用户主动中止等,重试只是浪费钱)。
 */
export function shouldAutoRetry(message: AssistantMessage, contextWindow: number, attempt: number): boolean {
	if (attempt >= RETRY_MAX_ATTEMPTS) return false;
	if (isContextOverflow(message, contextWindow)) return false;
	return isRetryableAssistantError(message);
}

/** 可中断的退避等待:abort 时提前 resolve(不是 reject),调用方查 signal 决定去留。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

interface AcpSession {
	harness: AgentHarness<any, any, any>;
	/** harness 不暴露 session,但自动压缩要读 buildContext(),所以这里留一份引用。 */
	session: Session;
	cwd: string;
	/** 本会话发现的技能,/skill: 命令清单据此生成。 */
	skills: Skill[];
	pendingPrompt: AbortController | null;
}

export interface MyPiAcpAgentOptions {
	env: NodeExecutionEnv;
	models: Models;
	model: Model<any>;
	protocolVersion: number;
	sessionsDir?: string;
	logsDir?: string;
	/** 上下文文件与技能的全局目录,默认 ~/.my-pi。测试用它隔离真实的用户目录。 */
	configDir?: string;
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

	/**
	 * 内存里的会话表取一条,取不到就抛。
	 *
	 * 注意与 loadSession 里那条**同文案**的错误不是一回事:那条说的是"磁盘上没有这个
	 * 会话文件",这条说的是"这个进程当前没开着它"。哪天要给其中一处挂 _tag,别当成一处改。
	 */
	private requireSession(sessionId: string): AcpSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found`);
		return session;
	}

	/** 当前会话的 configOptions。响应和通知共用一处构造,防止两边漂移。 */
	private configOptionsOf(sessionId: string): AcpSelectConfigOption[] {
		const session = this.requireSession(sessionId);
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
		const session = this.requireSession(sessionId);
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
		// 凭据由 pi-ai 的 provider 在每次请求时解析(auth.json 优先、环境变量兜底,
		// 见 acp/models.ts 的 resolveModel / registerProvider);ACP 这层不签发凭证,
		// 所以 initialize 的 authMethods 是空的。
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

	/** 推送斜杠命令清单(含本会话技能的 /skill: 命令)。客户端据此把输入框变成 "/ for commands"。 */
	private async announceCommands(sessionId: string, cx: any): Promise<void> {
		const session = this.sessions.get(sessionId);
		await cx?.notify?.("session/update", {
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: availableCommandsFor(session?.skills ?? []),
			},
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

		// 资源发现:AGENTS.md/CLAUDE.md(全局 + 祖先链)与技能(全局 + 项目 .agents/skills)。
		// 会话创建时读一次快照 —— 改了技能文件,重开会话即可生效,不做热重载。
		const configDir = this.options.configDir ?? CONFIG_DIR;
		const [contextFiles, { skills, diagnostics }] = await Promise.all([
			loadContextFiles(env, { cwd, globalDir: configDir }),
			discoverSkills(env, { cwd, globalDir: configDir }),
		]);
		// acp.ts 把 console 重定向到了 stderr(落 ~/.my-pi/acp.log),诊断记在那里。
		for (const diagnostic of diagnostics) {
			console.error(`[skills] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
		}

		// 系统提示词按会话构建:身份 + 实际注册的工具清单与守则 + 项目上下文 + 技能清单 + cwd,
		// 工具部分全部来自工具定义自带的 promptSnippet / promptGuidelines,不再手写。
		const toolDefinitions = [...createCodingToolDefinitions(env), ...createEmbeddedToolDefinitions(env)];
		const harness = new AgentHarness({
			env,
			session,
			models,
			model,
			thinkingLevel,
			systemPrompt: buildSystemPrompt({
				cwd,
				...collectToolPromptData(toolDefinitions),
				contextFiles,
				skills,
			}),
			tools: wrapToolDefinitions(toolDefinitions),
			// harness.skill() 从 turn 快照的 resources 里查技能,/skill: 命令走它。
			resources: { skills },
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

		const acpSession: AcpSession = { harness, session, cwd, skills, pendingPrompt: null };
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
		const session = this.requireSession(sessionId);
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
		const session = this.requireSession(sessionId);
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
		const session = this.requireSession(params.sessionId);

		// 同一会话的新 prompt 顶替上一个,和 ACP 参考实现一致。只翻旗标不够:
		// harness 还在 turn 相位,新 prompt 会撞相位守卫得到 busy —— 必须等它真停下来。
		if (session.pendingPrompt) {
			session.pendingPrompt.abort();
			await session.harness.abort();
		}

		// 本轮的状态一律用局部值。只有 pendingPrompt 需要挂到 session 上(cancel() 和
		// 下一轮的顶替要够得着它),而它必须**先比对仍是自己那份再清**:重叠 prompt 时
		// 旧轮的 finally 晚于新轮开始执行,直接置 null 会把新轮的 controller 清掉,
		// 于是 cancel() 变成哑操作。
		const controller = new AbortController();
		const sink: UpdateSink = async (update) => {
			await cx.notify("session/update", { sessionId: params.sessionId, update });
		};
		const unsubscribe = pipeHarnessToAcp(session.harness, sink);
		session.pendingPrompt = controller;

		const text = promptToText(params.prompt);
		try {
			// 斜杠命令在本地解析。/compact /status 是会话级操作,不进模型 ——
			// 交给模型只会变成它对着一句 "/compact" 瞎猜;/skill:name 则是真实回合
			// (技能全文格式化成提示词),与普通 prompt 同等对待,善后逻辑共用。
			const command = parseSlashCommand(text, availableCommandsFor(session.skills));
			if (command && !command.name.startsWith("skill:")) {
				await this.runCommand(params.sessionId, session, command, sink);
				return { stopReason: "end_turn" };
			}
			const result = command
				? await session.harness.skill(command.name.slice("skill:".length), command.argument || undefined)
				: await session.harness.prompt(text);
			// 取消不会让 harness.prompt 抛错:abort 以 stopReason:"aborted" 的合成消息
			// 正常 resolve(agent-loop 把中断当数据),所以 cancelled 必须在 resolve 路径上判,
			// 并且跳过善后动作 —— 用户刚按了停止,不该紧接着又发起新的模型调用。
			if (controller.signal.aborted) {
				return { stopReason: "cancelled" };
			}
			// 轮级自动重试:失败也是数据(stopReason:"error"),所以同样在 resolve 路径上判。
			await this.maybeAutoRetry(session, result, controller.signal, sink);
			if (controller.signal.aborted) {
				return { stopReason: "cancelled" };
			}
			// 压缩放在这一轮之后:下一轮开始时才有腾出来的空间,和上游的 threshold 路径一致。
			await this.maybeAutoCompact(session, sink);
			return { stopReason: "end_turn" };
		} catch (error) {
			if (controller.signal.aborted) {
				return { stopReason: "cancelled" };
			}
			throw error;
		} finally {
			unsubscribe();
			if (session.pendingPrompt === controller) session.pendingPrompt = null;
		}
	}

	/**
	 * 一轮结束后按阈值自动压缩。对齐上游 pi 的 threshold 路径(它放在 agent-session.ts,
	 * 也就是应用层而非 harness —— harness 只提供 compact(),什么时候压是应用的事)。
	 *
	 * 不做会怎样:Zed 里聊长了直接撞上下文窗口,除非用户自己想起来敲 /compact。
	 *
	 * 返回是否真的压缩了。任何失败都只记一条消息,绝不让这一轮 prompt 失败 ——
	 * 压缩是善后动作,它挂了不该把用户已经拿到的回答一起废掉。
	 */
	private async maybeAutoCompact(session: AcpSession, sink: UpdateSink): Promise<boolean> {
		try {
			const model = session.harness.getModel();
			const context = await session.session.buildContext();
			const compactions = await session.session.getStorage().findEntries("compaction");
			const lastCompaction = compactions[compactions.length - 1];

			const decision = shouldAutoCompact(
				context.messages,
				model.contextWindow,
				lastCompaction ? new Date(lastCompaction.timestamp).getTime() : undefined,
			);
			if (!decision.compact) return false;

			await session.harness.compact();
			await sink({
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: `\n\n🗜️ 上下文接近上限(约 ${decision.tokens}/${model.contextWindow} tokens),已自动压缩。\n`,
				},
			});
			return true;
		} catch (error) {
			await sink({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `\n\n⚠️ 自动压缩失败:${(error as Error)?.message ?? String(error)}\n` },
			});
			return false;
		}
	}

	/**
	 * 一轮以可重试错误收场后,按指数退避自动重跑(对齐 pi 的 agent 级重试:
	 * 3 次、2s/4s/8s)。与 maybeAutoCompact 同属"善后动作":自身失败绝不让
	 * prompt 失败。重试轮的流式事件照常经 pipeHarnessToAcp 发给客户端。
	 */
	private async maybeAutoRetry(
		session: AcpSession,
		lastMessage: AssistantMessage,
		signal: AbortSignal,
		sink: UpdateSink,
	): Promise<void> {
		const say = (text: string) => sink({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
		let attempt = 0;
		let message = lastMessage;
		while (!signal.aborted && shouldAutoRetry(message, session.harness.getModel().contextWindow, attempt)) {
			attempt++;
			const delayMs = retryDelayMs(attempt);
			await say(
				`\n\n⚠️ 模型请求失败:${message.errorMessage ?? "unknown error"}\n${Math.round(delayMs / 1000)}s 后自动重试(${attempt}/${RETRY_MAX_ATTEMPTS})…\n`,
			);
			await sleep(delayMs, signal);
			if (signal.aborted) return;
			try {
				message = await session.harness.retryLastTurn();
			} catch (error) {
				await say(`\n\n⚠️ 自动重试失败:${(error as Error)?.message ?? String(error)}\n`);
				return;
			}
		}
		if (attempt > 0 && message.stopReason === "error") {
			await say(`\n\n⚠️ 自动重试 ${attempt} 次后仍失败。\n`);
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
