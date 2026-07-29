/**
 * 模型解析与模型目录。
 *
 * 刻意复用 pi 已有的凭证文件 ~/.pi/agent/auth.json —— 你在命令行里 `pi` 配好的 key
 * 直接就能给 my-pi 用,不需要再配一遍环境变量。环境变量优先级更高。
 *
 * 选择顺序:MY_PI_PROVIDER/MY_PI_MODEL 环境变量 → ~/.pi/agent/settings.json 的默认值
 * → auth.json 里第一个有 key 的 provider。
 *
 * 注册策略:凡是 auth.json 里有 key 的 provider,统统注册进同一个 Models 注册表 ——
 * 不能只注册"当前选中的那一个"。AgentHarness.models 是 readonly,harness 建好之后
 * 换不掉注册表;而 ModelsImpl.requireProvider 对未注册的 provider 会抛 Unknown provider。
 * 所以跨 provider 的 setModel() 只有在 provider 提前注册好的前提下才不会在发请求时才炸。
 *
 * 模型元数据(reasoning / thinkingLevelMap / compat)抄自上游 pi 的生成目录
 * (@earendil-works/pi-ai/dist/providers/data/*.json),不要凭空编 —— thinkingLevelMap
 * 写错的直接后果是 thinking 档位在 Zed 里能选但发不出去。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	createProvider,
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
	/** 没指定模型时用哪个,必须是 models 里的 id。 */
	defaultModel: string;
	models: ModelSpec[];
}

/** DeepSeek 与 Moonshot 共用的 OpenAI-completions 兼容位。 */
const DEEPSEEK_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: true,
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

function registerProvider(models: MutableModels, spec: ProviderSpec, apiKey: string): void {
	models.setProvider(
		createProvider({
			id: spec.id,
			name: spec.name,
			baseUrl: spec.baseUrl,
			// key 已经从 auth.json / 环境变量里读到了,resolve 直接交出来即可,
			// 不走 envApiKeyAuth 那条"再去查环境变量"的路。
			auth: {
				apiKey: {
					name: `${spec.name} API key`,
					login: async () => ({ type: "api_key", key: apiKey }),
					resolve: async () => ({ auth: { apiKey }, source: "my-pi config" }),
				},
			},
			models: spec.models.map((m) => toModel(spec, m)),
			api: openAICompletionsApi(),
		}),
	);
}

/**
 * 装配注册表:auth.json 里凡是有 key 的 provider 全部注册进去,并选出默认模型。
 *
 * 一次性把所有可用 provider 都注册好,是跨 provider 切模型能工作的前提。
 */
export async function resolveModel(): Promise<ResolvedModel> {
	const piDir = join(homedir(), ".pi", "agent");
	const auth = readJson(join(piDir, "auth.json")) ?? {};
	const settings = readJson(join(piDir, "settings.json")) ?? {};

	const envProvider = process.env.MY_PI_PROVIDER;
	const keyOf = (id: string): string | undefined =>
		(id === envProvider ? process.env.MY_PI_API_KEY : undefined) ?? auth[id]?.key;

	const providerId =
		envProvider ??
		(settings.defaultProvider && PROVIDERS[settings.defaultProvider] ? settings.defaultProvider : undefined) ??
		Object.keys(PROVIDERS).find((id) => keyOf(id));

	if (!providerId) {
		throw new Error(
			`No usable provider. Configure one with pi (~/.pi/agent/auth.json), or set MY_PI_PROVIDER plus its API key. Known providers: ${Object.keys(PROVIDERS).join(", ")}`,
		);
	}
	const spec = PROVIDERS[providerId];
	if (!spec) {
		throw new Error(`Unknown provider: ${providerId}. Known providers: ${Object.keys(PROVIDERS).join(", ")}`);
	}

	const apiKey = keyOf(providerId);
	if (!apiKey) {
		throw new Error(`No API key for provider ${providerId}. Run \`pi\` to configure it, or set MY_PI_API_KEY.`);
	}

	const models = createModels();
	for (const [id, candidate] of Object.entries(PROVIDERS)) {
		const key = keyOf(id);
		if (key) registerProvider(models, candidate, key);
	}

	const modelId =
		process.env.MY_PI_MODEL ??
		(settings.defaultProvider === providerId ? settings.defaultModel : undefined) ??
		spec.defaultModel;

	const model = models.getModel(providerId, modelId) ?? models.getModel(providerId, spec.defaultModel);
	if (!model) {
		throw new Error(`Model ${providerId}/${modelId} not found. Known models: ${spec.models.map((m) => m.id).join(", ")}`);
	}

	return { models, model };
}
