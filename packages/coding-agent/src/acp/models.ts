/**
 * 模型解析与模型目录。
 *
 * 凭证完全独立于 pi:key 存 <configDir>/auth.json(FileCredentialStore,0600),
 * 或走各家的标准环境变量(DEEPSEEK_API_KEY / MOONSHOT_API_KEY)。解析发生在每次
 * 请求时(models.streamSimple → resolveProviderAuth):存储的凭证优先,环境变量
 * 兜底 —— 改 auth.json 不用重启。
 *
 * 选择顺序:YOMA_PROVIDER/YOMA_MODEL 环境变量 → <configDir>/settings.json 的
 * defaultProvider/defaultModel → 第一个有凭证的 provider。
 *
 * 注册策略:凡是有凭证的 provider,统统注册进同一个 Models 注册表 ——
 * 不能只注册"当前选中的那一个"。AgentHarness.models 是 readonly,harness 建好之后
 * 换不掉注册表;而 ModelsImpl.requireProvider 对未注册的 provider 会抛 Unknown provider。
 * 所以跨 provider 的 setModel() 只有在 provider 提前注册好的前提下才不会在发请求时才炸。
 *
 * 模型元数据(reasoning / thinkingLevelMap / compat)抄自 pi-ai 的生成目录
 * (node_modules/@earendil-works/pi-ai/dist/providers/data/*.json),不要凭空编 —— thinkingLevelMap
 * 写错的直接后果是 thinking 档位在 Zed 里能选但发不出去。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createModels,
	createProvider,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	envApiKeyAuth,
	type Model,
	type ModelCost,
	type Models,
	type MutableModels,
	type OpenAICompletionsCompat,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

interface ModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	/** 缺省键走 provider 默认值,null 表示该档位不支持。见 getSupportedThinkingLevels。 */
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: OpenAICompletionsCompat;
}

interface ProviderSpec {
	id: string;
	name: string;
	baseUrl: string;
	/** 标准 API key 环境变量,与上游 pi-ai 的约定一致;按序取第一个有值的。 */
	envVars: readonly string[];
	/** 没指定模型时用哪个,必须是 models 里的 id。 */
	defaultModel: string;
	models: ModelSpec[];
}

/** DeepSeek 与 Moonshot 共用的 OpenAI-completions 兼容位。 */
const DEEPSEEK_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: true,
	// DeepSeek 静默忽略 max_completion_tokens(实测),不钉的话压缩/摘要请求没有输出上限。
	maxTokensField: "max_tokens",
	thinkingFormat: "deepseek",
};

const MOONSHOT_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};

/** 已知的 OpenAI-completions 兼容 provider。加新家只需要在这里加一条。 */
const PROVIDERS: Record<string, ProviderSpec> = {
	deepseek: {
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		envVars: ["DEEPSEEK_API_KEY"],
		defaultModel: "deepseek-v4-pro",
		models: [
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
				compat: DEEPSEEK_COMPAT,
			},
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
				compat: DEEPSEEK_COMPAT,
			},
			{
				id: "deepseek-chat",
				name: "DeepSeek Chat",
				reasoning: false,
				input: ["text"],
				cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
				contextWindow: 65536,
				maxTokens: 8192,
				compat: DEEPSEEK_COMPAT,
			},
		],
	},
	"moonshotai-cn": {
		id: "moonshotai-cn",
		name: "Moonshot (Kimi)",
		baseUrl: "https://api.moonshot.cn/v1",
		envVars: ["MOONSHOT_API_KEY"],
		defaultModel: "kimi-k2-turbo-preview",
		models: [
			{
				id: "kimi-k2-turbo-preview",
				name: "Kimi K2 Turbo",
				reasoning: false,
				input: ["text"],
				cost: { input: 2.4, output: 10, cacheRead: 0.6, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 262144,
				compat: MOONSHOT_COMPAT,
			},
			{
				id: "kimi-k2-thinking",
				name: "Kimi K2 Thinking",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 262144,
				compat: MOONSHOT_COMPAT,
			},
			{
				id: "kimi-k2.5",
				name: "Kimi K2.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 262144,
				compat: MOONSHOT_COMPAT,
			},
			{
				id: "kimi-k2.6",
				name: "Kimi K2.6",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 262144,
				compat: MOONSHOT_COMPAT,
			},
			{
				id: "kimi-k3",
				name: "Kimi K3",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
					supportsStrictMode: false,
					thinkingFormat: "openai",
					requiresReasoningContentOnAssistantMessages: true,
				},
			},
		],
	},
};

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** 缺 `type` 或旧的 `api-key` 当成 `api_key`;oauth 不动。 */
function coerceCredential(raw: unknown): { credential: Credential; healed: boolean } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entry = raw as Record<string, unknown>;
	if (entry.type === "oauth") return { credential: raw as Credential, healed: false };
	if (typeof entry.key !== "string" || entry.key.trim() === "") {
		return entry.type === "api_key" ? { credential: raw as Credential, healed: false } : undefined;
	}
	if (entry.type === "api_key") return { credential: raw as Credential, healed: false };
	return { credential: { ...entry, type: "api_key" } as Credential, healed: true };
}

/** 文件版凭证仓库:<configDir>/auth.json,0600。每次 read 重读文件。 */
export class FileCredentialStore implements CredentialStore {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly path: string) {}

	private load(): { data: Record<string, Credential>; healed: boolean } {
		const raw = readJson(this.path) ?? {};
		if (!raw || typeof raw !== "object") return { data: {}, healed: false };
		const data: Record<string, Credential> = {};
		let healed = false;
		for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
			const coerced = coerceCredential(entry);
			if (!coerced) continue;
			data[id] = coerced.credential;
			if (coerced.healed) healed = true;
		}
		return { data, healed };
	}

	private save(data: Record<string, Credential>): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, `${JSON.stringify(data, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(this.path, 0o600);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const { data, healed } = this.load();
		if (healed) this.save(data);
		return data[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load().data).map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const task = this.chain.then(async () => {
			const { data, healed } = this.load();
			const next = await fn(data[providerId]);
			if (next !== undefined) {
				data[providerId] = next;
				this.save(data);
			} else if (healed) {
				this.save(data);
			}
			return data[providerId];
		});
		this.chain = task.catch(() => {});
		return task;
	}

	delete(providerId: string): Promise<void> {
		const task = this.chain.then(async () => {
			const { data } = this.load();
			if (providerId in data) {
				delete data[providerId];
				this.save(data);
			}
		});
		this.chain = task.catch(() => {});
		return task;
	}
}

export interface ResolvedModel {
	models: Models;
	model: Model<any>;
}

function toModel(spec: ProviderSpec, m: ModelSpec): Model<"openai-completions"> {
	return {
		id: m.id,
		name: m.name,
		api: "openai-completions",
		provider: spec.id,
		baseUrl: spec.baseUrl,
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: m.compat,
	};
}

function registerProvider(models: MutableModels, spec: ProviderSpec): void {
	models.setProvider(
		createProvider({
			id: spec.id,
			name: spec.name,
			baseUrl: spec.baseUrl,
			// 每次请求时才解析:注入的 FileCredentialStore 里存储的 key 优先,
			// spec.envVars 兜底(envApiKeyAuth 的既定语义)。
			auth: { apiKey: envApiKeyAuth(`${spec.name} API key`, spec.envVars) },
			models: spec.models.map((m) => toModel(spec, m)),
			api: openAICompletionsApi(),
		}),
	);
}

/**
 * 装配注册表:凡是有凭证(auth.json 或环境变量)的 provider 全部注册进去,并选出默认模型。
 *
 * 一次性把所有可用 provider 都注册好,是跨 provider 切模型能工作的前提。
 */
export async function resolveModel(configDir: string): Promise<ResolvedModel> {
	const authPath = join(configDir, "auth.json");
	const credentials = new FileCredentialStore(authPath);
	const settings = readJson(join(configDir, "settings.json")) ?? {};

	const hasCredential = async (spec: ProviderSpec): Promise<boolean> => {
		const stored = await credentials.read(spec.id);
		if (stored?.type === "api_key" && stored.key) return true;
		return spec.envVars.some((name) => process.env[name]);
	};

	const available: string[] = [];
	for (const spec of Object.values(PROVIDERS)) {
		if (await hasCredential(spec)) available.push(spec.id);
	}

	const providerId =
		process.env.YOMA_PROVIDER ??
		(settings.defaultProvider && PROVIDERS[settings.defaultProvider] ? settings.defaultProvider : undefined) ??
		available[0];

	if (!providerId) {
		const envVars = Object.values(PROVIDERS).flatMap((spec) => spec.envVars);
		throw new Error(
			`No usable provider. Add a key to ${authPath} like {"deepseek":{"type":"api_key","key":"sk-..."}}, or export one of: ${envVars.join(", ")}.`,
		);
	}
	const spec = PROVIDERS[providerId];
	if (!spec) {
		throw new Error(`Unknown provider: ${providerId}. Known providers: ${Object.keys(PROVIDERS).join(", ")}`);
	}
	if (!available.includes(providerId)) {
		throw new Error(`No API key for provider ${providerId}. Add it to ${authPath}, or export ${spec.envVars.join(" / ")}.`);
	}

	const models = createModels({ credentials });
	for (const id of available) {
		registerProvider(models, PROVIDERS[id]!);
	}

	const modelId =
		process.env.YOMA_MODEL ??
		(settings.defaultProvider === providerId ? settings.defaultModel : undefined) ??
		spec.defaultModel;

	const model = models.getModel(providerId, modelId) ?? models.getModel(providerId, spec.defaultModel);
	if (!model) {
		throw new Error(`Model ${providerId}/${modelId} not found. Known models: ${spec.models.map((m) => m.id).join(", ")}`);
	}

	return { models, model };
}
