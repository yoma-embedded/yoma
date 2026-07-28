/**
 * 模型解析。
 *
 * 刻意复用 pi 已有的凭证文件 ~/.pi/agent/auth.json —— 你在命令行里 `pi` 配好的 key
 * 直接就能给 my-pi 用,不需要再配一遍环境变量。环境变量优先级更高。
 *
 * 选择顺序:MY_PI_PROVIDER/MY_PI_MODEL 环境变量 → ~/.pi/agent/settings.json 的默认值
 * → auth.json 里第一个有 key 的 provider。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

interface ProviderSpec {
	id: string;
	name: string;
	baseUrl: string;
	defaultModel: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 已知的 OpenAI-completions 兼容 provider。加新家只需要在这里加一行。 */
const PROVIDERS: Record<string, ProviderSpec> = {
	deepseek: {
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-chat",
		contextWindow: 65536,
		maxTokens: 8192,
		cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
	},
	"moonshotai-cn": {
		id: "moonshotai-cn",
		name: "Moonshot (Kimi)",
		baseUrl: "https://api.moonshot.cn/v1",
		defaultModel: "kimi-k2-turbo-preview",
		contextWindow: 131072,
		maxTokens: 16384,
		cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
	},
};

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

interface ResolvedModel {
	models: Models;
	model: Model<any>;
}

export async function resolveModel(): Promise<ResolvedModel> {
	const piDir = join(homedir(), ".pi", "agent");
	const auth = readJson(join(piDir, "auth.json")) ?? {};
	const settings = readJson(join(piDir, "settings.json")) ?? {};

	const providerId =
		process.env.MY_PI_PROVIDER ??
		(settings.defaultProvider && PROVIDERS[settings.defaultProvider] ? settings.defaultProvider : undefined) ??
		Object.keys(PROVIDERS).find((id) => auth[id]?.key);

	if (!providerId) {
		throw new Error(
			`No usable provider. Configure one with pi (~/.pi/agent/auth.json), or set MY_PI_PROVIDER plus its API key. Known providers: ${Object.keys(PROVIDERS).join(", ")}`,
		);
	}
	const spec = PROVIDERS[providerId];
	if (!spec) {
		throw new Error(`Unknown provider: ${providerId}. Known providers: ${Object.keys(PROVIDERS).join(", ")}`);
	}

	const apiKey = process.env.MY_PI_API_KEY ?? auth[providerId]?.key;
	if (!apiKey) {
		throw new Error(`No API key for provider ${providerId}. Run \`pi\` to configure it, or set MY_PI_API_KEY.`);
	}

	const modelId = process.env.MY_PI_MODEL ?? (settings.defaultProvider === providerId ? settings.defaultModel : undefined) ?? spec.defaultModel;

	const model: Model<"openai-completions"> = {
		id: modelId,
		name: `${spec.name} ${modelId}`,
		api: "openai-completions",
		provider: spec.id,
		baseUrl: spec.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: spec.cost,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	};

	const models = createModels();
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
			models: [model],
			api: openAICompletionsApi(),
		}),
	);

	return { models, model };
}
