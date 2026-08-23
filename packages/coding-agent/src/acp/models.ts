/**
 * 模型解析与模型目录。
 *
 * 目录的真源是 pi-ai 的内建目录(`builtinProviders()`,40 家、元数据由 pi-ai 生成),
 * 这里不再手写 provider 表 —— 从前的手写表只有两家,compat/thinkingLevelMap 靠人工从
 * pi-ai 的 JSON 抄,抄错的直接后果是 thinking 档位在 Zed 里能选但发不出去。本文件只管三件事:
 * 凭证、选择、以及"只要一个 key 就能用"的过滤。
 *
 * 凭证完全独立于 pi:key 存 <configDir>/auth.json(FileCredentialStore,0600),
 * 或走各家的标准环境变量 / 凭证文件(由 pi-ai 各 provider 的 auth 自己定义)。解析发生在每次
 * 请求时(models.streamSimple → resolveProviderAuth):存储的凭证优先,环境兜底 ——
 * 改 auth.json 不用重启。
 *
 * 选择顺序:YOMA_PROVIDER/YOMA_MODEL 环境变量 → <configDir>/settings.json 的
 * defaultProvider/defaultModel → 第一个有凭证的 provider 的第一个目录模型。
 *
 * 注册策略:注册 == 已配置。凡是 checkAuth 通过的 provider 全部注册进同一个 Models,
 * 没配置的从注册表里删掉 —— Zed 的模型下拉和桌面端都靠这条(未配置的家桌面端另经
 * configurableProviders() 单列)。不能只注册"当前选中的那一个":AgentHarness.models 是
 * readonly,harness 建好之后换不掉注册表,跨 provider 的 setModel() 只有在 provider 提前
 * 注册好的前提下才不会在发请求时才炸。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AuthContext,
	createModels,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Model,
	type Models,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

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

/** 测试隔离:不读环境变量、不看文件,只认 auth.json。 */
export const NO_AMBIENT_AUTH: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

export interface ResolveModelOptions {
	authContext?: AuthContext;
}

export interface ResolvedModel {
	models: Models;
	model: Model<any>;
}

/**
 * 装配注册表:注册全部内建 provider,再把没凭证的删掉,并选出默认模型。
 */
export async function resolveModel(configDir: string, options?: ResolveModelOptions): Promise<ResolvedModel> {
	const authPath = join(configDir, "auth.json");
	const settings = readJson(join(configDir, "settings.json")) ?? {};
	const models = createModels({ credentials: new FileCredentialStore(authPath), authContext: options?.authContext });

	const builtin = builtinProviders();
	for (const provider of builtin) models.setProvider(provider);
	const configured: string[] = [];
	for (const provider of builtin) {
		if (await models.checkAuth(provider.id)) configured.push(provider.id);
		else models.deleteProvider(provider.id);
	}

	const knownIds = builtin.map((p) => p.id);
	const providerId: string | undefined =
		process.env.YOMA_PROVIDER ??
		(knownIds.includes(settings.defaultProvider) ? settings.defaultProvider : undefined) ??
		configured[0];

	if (!providerId) {
		throw new Error(
			`No usable provider. Add a key to ${authPath} like {"deepseek":{"type":"api_key","key":"sk-..."}}, or export the provider's standard env var (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, ...).`,
		);
	}
	const provider = builtin.find((p) => p.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}. Known providers: ${knownIds.join(", ")}`);
	}
	if (!configured.includes(providerId)) {
		throw new Error(
			`No API key for provider ${providerId} (${provider.auth.apiKey?.name ?? provider.name}). Add it to ${authPath}.`,
		);
	}

	const catalog = models.getModels(providerId);
	const modelId: string | undefined =
		process.env.YOMA_MODEL ??
		(settings.defaultProvider === providerId ? settings.defaultModel : undefined) ??
		catalog[0]?.id;
	const model = modelId === undefined ? undefined : models.getModel(providerId, modelId);
	if (!model) {
		throw new Error(`Model ${providerId}/${modelId} not found. Known models: ${catalog.map((m) => m.id).join(", ")}`);
	}

	return { models, model };
}

/** login 只问一个 secret 就返回 ⇒ 一个 API key 就够。多问一句、问别的、或抛出都算不够。 */
async function isKeyOnly(provider: Provider): Promise<boolean> {
	const apiKey = provider.auth.apiKey;
	if (!apiKey?.login || provider.getModels().length === 0) return false;
	let secrets = 0;
	try {
		await apiKey.login({
			signal: new AbortController().signal,
			notify() {},
			async prompt(q) {
				if (q.type !== "secret" || secrets++ > 0) throw new Error("needs more than one API key");
				return "probe";
			},
		});
	} catch {
		return false;
	}
	return secrets === 1;
}

let configurable: Promise<ReadonlyArray<{ id: string; name: string }>> | undefined;

/**
 * 只要一个 API key 就能用的 provider(桌面端连接对话框列的就是这些),按 pi-ai 的 name。
 *
 * 从 login 流程探出来而不是手写表:手写的那份(从前住在 kernel/auth.ts)跟着目录漂移过;
 * 而 bedrock / vertex / cloudflare 的 login 要的不止一个 key(先选方法、再要 account id),
 * 只存一个 key 进 auth.json 的话 checkAuth 永远不过,对话框上"已连接"永远不亮。
 * 探测无副作用:apiKey 的 login 只会 prompt,拿到假 key 就返回,不碰网络。一个进程探一次。
 */
export async function configurableProviders(): Promise<ReadonlyArray<{ id: string; name: string }>> {
	return (configurable ??= (async () => {
		const out: { id: string; name: string }[] = [];
		for (const provider of builtinProviders()) {
			if (await isKeyOnly(provider)) out.push({ id: provider.id, name: provider.name });
		}
		return out;
	})());
}
